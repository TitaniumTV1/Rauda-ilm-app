import { verifyTelegramInitData } from "./telegram.js";

const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 100000;
const ADMIN_ROLES = new Set(["owner", "superadmin", "admin"]);
const tableColumnsCache = new Map();

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        try {
            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders(env)
                });
            }

            if (url.pathname === "/api/health" && request.method === "GET") {
                return json({
                    ok: true,
                    app: env.APP_NAME || "RAUDA ILM",
                    database: Boolean(env.DB),
                    assets: Boolean(env.ASSETS),
                    files: Boolean(env.FILES)
                }, 200, env);
            }

            if (url.pathname === "/api/debug-config" && request.method === "GET") {
                return json({
                    ok: true,
                    app: env.APP_NAME || "RAUDA ILM",
                    telegram_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
                    database: Boolean(env.DB),
                    assets: Boolean(env.ASSETS),
                    files: Boolean(env.FILES),
                    tribute_api_key: Boolean(env.TRIBUTE_API_KEY)
                }, 200, env);
            }

            if (url.pathname === "/api/auth/register" && request.method === "POST") {
                return handleRegister(request, env);
            }
            if (url.pathname === "/api/auth/login" && request.method === "POST") {
                return handleLogin(request, env);
            }
            if (url.pathname === "/api/auth/telegram" && request.method === "POST") {
                return handleTelegramAuth(request, env);
            }
            if (url.pathname === "/api/auth/me" && request.method === "GET") {
                return handleMe(request, env);
            }
            if (  url.pathname === "/api/auth/profile" && request.method === "PATCH") {
                return handleProfileUpdate(request, env);
            }

            if (url.pathname === "/api/auth/logout" && request.method === "POST") {
                return handleLogout(request, env);
            }

            if (url.pathname === "/api/programs" && request.method === "GET") {
                return handlePrograms(request, env);
            }
            if (url.pathname === "/api/courses" && request.method === "GET") {
                return handleCourses(request, env);
            }
            if (url.pathname === "/api/lessons" && request.method === "GET") {
                return handleLessons(request, env);
            }

            // Create the lesson first; the returned id is then used for file uploads.
            if (url.pathname === "/api/admin/lessons" && request.method === "POST") {
                return handleAdminCreateLesson(request, env);
            }

            const singleLesson = url.pathname.match(/^\/api\/lessons\/(\d+)$/);
            if (singleLesson && request.method === "GET") {
                return handleSingleLesson(request, env, Number(singleLesson[1]));
            }

            const lessonUpload = url.pathname.match(/^\/api\/admin\/lessons\/(\d+)\/files$/);
            if (lessonUpload && request.method === "POST") {
                return handleLessonFileUpload(request, env, Number(lessonUpload[1]));
            }

            const lessonFile = url.pathname.match(/^\/api\/lesson-files\/(\d+)$/);
            if (lessonFile && request.method === "GET") {
                return handleLessonFileGet(request, env, Number(lessonFile[1]));
            }

            const deleteLessonFile = url.pathname.match(/^\/api\/admin\/lesson-files\/(\d+)$/);
            if (deleteLessonFile && request.method === "DELETE") {
                return handleLessonFileDelete(request, env, Number(deleteLessonFile[1]));
            }

            if (url.pathname === "/api/progress" && request.method === "POST") {
                return handleProgress(request, env);
            }
            if (url.pathname === "/api/webhooks/tribute" && request.method === "POST") {
                return handleTributeWebhook(request, env);
            }

            if (env.ASSETS) {
                const response = await env.ASSETS.fetch(request);
                return withCors(response, env);
            }

            return new Response("RAUDA ILM", {
                status: 200,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        } catch (error) {
            console.error("Unhandled worker error:", error);
            return json({ ok: false, error: "Внутренняя ошибка сервера" }, 500, env);
        }
    }
};

async function handleRegister(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        await ensureAuthSessionsTable(env.DB);
        const body = await readJson(request);
        const login = normalizeLogin(body?.login);
        const password = String(body?.password || "");
        const firstName = cleanText(body?.first_name);
        const lastName = cleanText(body?.last_name);
        const phone = cleanText(body?.phone);

        if (!login) return json({ ok: false, error: "Введите логин" }, 400, env);
        if (!isValidLogin(login)) {
            return json({ ok: false, error: "Логин должен содержать 3–30 символов: буквы, цифры, _ или -" }, 400, env);
        }
        if (password.length < 8) {
            return json({ ok: false, error: "Пароль должен содержать минимум 8 символов" }, 400, env);
        }

        const existing = await first(env.DB, "SELECT id FROM users WHERE login = ? LIMIT 1", [login]);
        if (existing) return json({ ok: false, error: "Этот логин уже занят" }, 409, env);

        const passwordHash = await hashPassword(password);
        const technicalTelegramId = await generateTechnicalTelegramId(env.DB);
        const result = await run(env.DB, `
            INSERT INTO users (
                telegram_id, username, first_name, last_name, phone,
                role, status, login, password_hash
            ) VALUES (?, NULL, ?, ?, ?, 'student', 'active', ?, ?)
        `, [technicalTelegramId, firstName || null, lastName || null, phone || null, login, passwordHash]);

        const user = await getUserById(env.DB, Number(result.meta.last_row_id));
        if (user.status !== "active") {
    return json(
        {
            ok: false,
            error:
                user.blocked_reason ||
                "Ваш аккаунт заблокирован"
        },
        403,
        env
    );
}
        const session = await createSession(env.DB, user.id);
        return json({ ok: true, user, token: session.token, expires_at: session.expiresAt }, 201, env);
    } catch (error) {
        console.error("Register error:", error);
        return json({ ok: false, error: "Не удалось зарегистрировать пользователя" }, 500, env);
    }
}

async function handleLogin(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        await ensureAuthSessionsTable(env.DB);
        const body = await readJson(request);
        const login = normalizeLogin(body?.login);
        const password = String(body?.password || "");
        if (!login || !password) {
            return json({ ok: false, error: "Введите логин и пароль" }, 400, env);
        }

        const user = await first(env.DB, `
            SELECT id, telegram_id, username, first_name, last_name, phone,
                   role, status, blocked_reason, blocked_at, created_at, updated_at,
                   login, password_hash
            FROM users WHERE login = ? LIMIT 1
        `, [login]);

        if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
            return json({ ok: false, error: "Неверный логин или пароль" }, 401, env);
        }
        if (user.status !== "active") {
            return json({ ok: false, error: user.blocked_reason || "Ваш аккаунт заблокирован" }, 403, env);
        }

        const session = await createSession(env.DB, user.id);
        return json({
            ok: true,
            user: publicUser(user),
            token: session.token,
            expires_at: session.expiresAt
        }, 200, env);
    } catch (error) {
        console.error("Login error:", error);
        return json({ ok: false, error: "Не удалось выполнить вход" }, 500, env);
    }
}

async function handleTelegramAuth(request, env) {
    if (!env.DB) return databaseMissing(env);
    if (!env.TELEGRAM_BOT_TOKEN) {
        return json({ ok: false, error: "Telegram bot token is not configured" }, 500, env);
    }

    try {
        await ensureAuthSessionsTable(env.DB);
        const body = await readJson(request);
        if (!body?.initData) {
            return json({ ok: false, error: "Telegram initData is missing" }, 400, env);
        }

        const verification = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
        if (!verification?.ok) {
            return json({ ok: false, error: verification?.error || "Telegram authentication failed" }, 401, env);
        }

        const telegramUser = verification.user || {};
        const telegramId = Number(telegramUser.id);
        if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
            return json({ ok: false, error: "Invalid Telegram user ID" }, 401, env);
        }

        let user = await first(env.DB, "SELECT * FROM users WHERE telegram_id = ? LIMIT 1", [telegramId]);
        if (!user) {
            const result = await run(env.DB, `
                INSERT INTO users (telegram_id, username, first_name, last_name, role, status)
                VALUES (?, ?, ?, ?, 'student', 'active')
            `, [telegramId, telegramUser.username || null, telegramUser.first_name || null, telegramUser.last_name || null]);
            user = await getUserById(env.DB, Number(result.meta.last_row_id));
} else {

    /*
     * Пользователь уже существует.
     * Не перезаписываем username,
     * имя и фамилию из Telegram,
     * потому что пользователь может
     * менять их вручную в профиле.
     */

    await run(
        env.DB,
        `
        UPDATE users
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [
            user.id
        ]
    );

    user =
        await getUserById(
            env.DB,
            user.id
        );
}

        const session = await createSession(env.DB, user.id);
        return json({ ok: true, user, token: session.token, expires_at: session.expiresAt }, 200, env);
    } catch (error) {
        console.error("Telegram auth error:", error);
        return json({ ok: false, error: "Telegram authentication failed" }, 500, env);
    }
}

async function handleMe(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);
    return json({ ok: true, user: auth.user }, 200, env);
}
async function handleProfileUpdate(
    request,
    env
) {

    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return authError(
            auth,
            env
        );
    }

    try {

        const body =
            await readJson(
                request
            );

        let username =
            cleanText(
                body?.username
            ) || "";

        const firstName =
            cleanText(
                body?.first_name
            ) || "";

        const lastName =
            cleanText(
                body?.last_name
            ) || "";

        /*
         * Ник храним без @
         */
        if (
            username.startsWith("@")
        ) {
            username =
                username.substring(1);
        }

        /*
         * Ограничиваем длину
         */
        if (
            username.length > 64 ||
            firstName.length > 64 ||
            lastName.length > 64
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Имя, фамилия и ник должны быть не длиннее 64 символов"
                },
                400,
                env
            );
        }

        /*
         * Ник разрешаем:
         * буквы, цифры,
         * подчёркивание
         */
        if (
            username &&
            !/^[a-zA-Z0-9_]+$/.test(
                username
            )
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Ник может содержать только латинские буквы, цифры и _"
                },
                400,
                env
            );
        }

        await run(
            env.DB,
            `
            UPDATE users
            SET
                username = ?,
                first_name = ?,
                last_name = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [
                username || null,
                firstName || null,
                lastName || null,
                auth.user.id
            ]
        );

        const user =
            await getUserById(
                env.DB,
                auth.user.id
            );

        return json(
            {
                ok: true,
                user
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Profile update error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось сохранить профиль"
            },
            500,
            env
        );
    }
}

async function handleLogout(request, env) {
    if (!env.DB) return databaseMissing(env);
    await ensureAuthSessionsTable(env.DB);
    const token = getBearerToken(request);
    if (token) await run(env.DB, "DELETE FROM auth_sessions WHERE token = ?", [token]);
    return json({ ok: true }, 200, env);
}

async function handlePrograms(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const rows = await listContentRows(env.DB, "programs", new URL(request.url).searchParams, auth.user);
        const access = await accessByProgram(env.DB, auth.user.id);
        const programs = rows.map((program) => ({
            ...program,
            has_access: isAdmin(auth.user) || access.has(Number(program.id))
        }));
        return json({ ok: true, programs }, 200, env);
    } catch (error) {
        console.error("Programs error:", error);
        return json({ ok: false, error: "Не удалось получить программы" }, 500, env);
    }
}

async function handleCourses(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const courses = await listContentRows(env.DB, "courses", new URL(request.url).searchParams, auth.user);
        return json({ ok: true, courses }, 200, env);
    } catch (error) {
        console.error("Courses error:", error);
        return json({ ok: false, error: "Не удалось получить курсы" }, 500, env);
    }
}

async function handleLessons(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const lessons = await listContentRows(env.DB, "lessons", new URL(request.url).searchParams, auth.user);
        return json({ ok: true, lessons }, 200, env);
    } catch (error) {
        console.error("Lessons error:", error);
        return json({ ok: false, error: "Не удалось получить уроки" }, 500, env);
    }
}

async function handleSingleLesson(request, env, lessonId) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const columns = await tableColumns(env.DB, "lessons");
        if (!columns.length) return json({ ok: false, error: "Таблица уроков не найдена" }, 500, env);
        const lesson = await first(env.DB, `SELECT * FROM lessons WHERE id = ? LIMIT 1`, [lessonId]);
        if (!lesson || (!isAdmin(auth.user) && isHidden(lesson, columns))) {
            return json({ ok: false, error: "Урок не найден" }, 404, env);
        }

        const files = await getLessonFiles(env.DB, lessonId);
        const progress = await getLessonProgress(env.DB, auth.user.id, lessonId);
        return json({ ok: true, lesson: { ...lesson, files, progress } }, 200, env);
    } catch (error) {
        console.error("Single lesson error:", error);
        return json({ ok: false, error: "Не удалось получить урок" }, 500, env);
    }
}

async function handleAdminCreateLesson(request, env) {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const body = await readJson(request);
        const title = cleanText(body?.title);
        if (!title) return json({ ok: false, error: "Введите название урока" }, 400, env);

        const courseId = positiveIntegerOrNull(body?.course_id);
        let programId = positiveIntegerOrNull(body?.program_id);
        const semesterId = positiveIntegerOrNull(body?.semester_id);
        const subjectId = positiveIntegerOrNull(body?.subject_id);
        if (courseId && !programId) {
            const course = await first(env.DB, "SELECT program_id FROM courses WHERE id = ? LIMIT 1", [courseId]);
            programId = positiveIntegerOrNull(course?.program_id);
        }

        const lesson = await insertLesson(env.DB, {
            courseId,
            programId,
            semesterId,
            subjectId,
            title,
            description: cleanText(body?.description),
            content: cleanText(body?.content),
            lessonNumber: nonNegativeNumber(body?.lesson_number),
            sortOrder: nonNegativeNumber(body?.sort_order),
            isVisible: body?.is_visible === false || body?.is_visible === 0 || body?.is_visible === "0" ? 0 : 1
        });
        return json({ ok: true, lesson }, 201, env);
    } catch (error) {
        console.error("Create lesson error:", error);
        return json({ ok: false, error: "Не удалось создать урок" }, 500, env);
    }
}

async function handleLessonFileUpload(request, env, lessonId) {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return authError(auth, env);
    if (!env.FILES) return json({ ok: false, error: "Файловое хранилище FILES не настроено" }, 500, env);

    try {
        await ensureLessonFilesTable(env.DB);
        const lesson = await first(env.DB, "SELECT id FROM lessons WHERE id = ? LIMIT 1", [lessonId]);
        if (!lesson) return json({ ok: false, error: "Урок не найден" }, 404, env);

        const form = await request.formData();
        const uploaded = form.get("file") || form.getAll("files")[0];
        if (!uploaded || typeof uploaded === "string") {
            return json({ ok: false, error: "Выберите файл" }, 400, env);
        }

        const maxBytes = positiveIntegerOrNull(env.MAX_UPLOAD_BYTES) || 250 * 1024 * 1024;
        if (uploaded.size > maxBytes) {
            return json({ ok: false, error: `Файл больше допустимого размера (${maxBytes} байт)` }, 413, env);
        }

        const fileName = safeFileName(uploaded.name || "file");
        const contentType = uploaded.type || "application/octet-stream";
        const key = `lessons/${lessonId}/${crypto.randomUUID()}-${fileName}`;
        const sortOrder = nonNegativeNumber(form.get("sort_order"));
        const caption = cleanText(form.get("caption"));

        await env.FILES.put(key, uploaded.stream(), {
            httpMetadata: { contentType },
            customMetadata: { original_name: fileName }
        });

        try {
            const file = await insertLessonFile(env.DB, {
                lessonId,
                key,
                fileName,
                contentType,
                size: uploaded.size,
                sortOrder,
                caption,
                uploadedBy: auth.user.id
            });
            return json({ ok: true, file }, 201, env);
        } catch (error) {
            await env.FILES.delete(key);
            throw error;
        }
    } catch (error) {
        console.error("Lesson file upload error:", error);
        return json({ ok: false, error: "Не удалось загрузить файл" }, 500, env);
    }
}

async function handleLessonFileGet(request, env, fileId) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);
    if (!env.FILES) return json({ ok: false, error: "Файловое хранилище FILES не настроено" }, 500, env);

    try {
        await ensureLessonFilesTable(env.DB);
        const row = await getLessonFileRow(env.DB, fileId);
        if (!row) return json({ ok: false, error: "Файл не найден" }, 404, env);

        const key = fileStorageKey(row);
        if (!key) return json({ ok: false, error: "В записи файла отсутствует ключ R2" }, 500, env);
        const head = await env.FILES.head(key);
        if (!head) return json({ ok: false, error: "Файл не найден в R2" }, 404, env);

        const requestedRange = parseRange(request.headers.get("Range"), head.size);
        if (requestedRange?.invalid) {
            return new Response(null, {
                status: 416,
                headers: {
                    ...corsHeaders(env),
                    "Accept-Ranges": "bytes",
                    "Content-Range": `bytes */${head.size}`
                }
            });
        }

        const object = requestedRange
            ? await env.FILES.get(key, { range: { offset: requestedRange.start, length: requestedRange.length } })
            : await env.FILES.get(key);
        if (!object) return json({ ok: false, error: "Файл не найден в R2" }, 404, env);

        const contentType = fileContentType(row) || object.httpMetadata?.contentType || "application/octet-stream";
        const name = fileDisplayName(row);
        const headers = {
            ...corsHeaders(env),
            "Content-Type": contentType,
            "Accept-Ranges": "bytes",
            "Content-Length": String(requestedRange ? requestedRange.length : head.size),
            "Content-Disposition": contentDisposition(contentType, name)
        };
        if (object.httpEtag) headers.ETag = object.httpEtag;
        if (requestedRange) {
            headers["Content-Range"] = `bytes ${requestedRange.start}-${requestedRange.end}/${head.size}`;
        }
        return new Response(object.body, { status: requestedRange ? 206 : 200, headers });
    } catch (error) {
        console.error("Lesson file read error:", error);
        return json({ ok: false, error: "Не удалось открыть файл" }, 500, env);
    }
}

async function handleLessonFileDelete(request, env, fileId) {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return authError(auth, env);
    if (!env.FILES) return json({ ok: false, error: "Файловое хранилище FILES не настроено" }, 500, env);

    try {
        await ensureLessonFilesTable(env.DB);
        const row = await getLessonFileRow(env.DB, fileId);
        if (!row) return json({ ok: false, error: "Файл не найден" }, 404, env);
        const key = fileStorageKey(row);
        if (key) await env.FILES.delete(key);
        await run(env.DB, "DELETE FROM lesson_files WHERE id = ?", [fileId]);
        return json({ ok: true }, 200, env);
    } catch (error) {
        console.error("Lesson file delete error:", error);
        return json({ ok: false, error: "Не удалось удалить файл" }, 500, env);
    }
}

async function handleProgress(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);

    try {
        const body = await readJson(request);
        const lessonId = positiveIntegerOrNull(body?.lesson_id);
        if (!lessonId) return json({ ok: false, error: "Укажите lesson_id" }, 400, env);

        const lesson = await first(env.DB, "SELECT id FROM lessons WHERE id = ? LIMIT 1", [lessonId]);
        if (!lesson) return json({ ok: false, error: "Урок не найден" }, 404, env);

        await ensureLessonProgressTable(env.DB);
        const percentage = clampProgress(body?.progress_percent ?? body?.progress ?? (body?.completed || body?.is_completed ? 100 : 0));
        const completed = body?.completed === true || body?.is_completed === true || percentage >= 100 ? 1 : 0;
        const progress = await saveLessonProgress(env.DB, auth.user.id, lessonId, percentage, completed);
        return json({ ok: true, progress }, 200, env);
    } catch (error) {
        console.error("Progress error:", error);
        return json({ ok: false, error: "Не удалось сохранить прогресс" }, 500, env);
    }
}

async function handleTributeWebhook(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        const raw = await request.text();
        if (!isValidTributeWebhook(request, raw, env)) {
            return json({ ok: false, error: "Webhook signature is invalid" }, 401, env);
        }
        const payload = raw ? JSON.parse(raw) : {};
        await ensureTributeTables(env.DB);

        const data = payload.data || payload.payload || payload;
        const metadata = { ...(payload.metadata || {}), ...(data.metadata || {}) };
        const eventId = String(payload.id || payload.event_id || data.event_id || data.id || crypto.randomUUID());
        const eventType = String(payload.type || payload.event || data.type || "unknown");
        const status = String(data.status || payload.status || "unknown").toLowerCase();
        const programId = positiveIntegerOrNull(metadata.program_id || data.program_id || payload.program_id);
        const userId = await tributeUserId(env.DB, metadata, data, payload);
        const rawJson = JSON.stringify(payload);

        await run(env.DB, `
            INSERT OR IGNORE INTO tribute_events
                (event_id, event_type, payment_status, user_id, program_id, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [eventId, eventType, status, userId, programId, rawJson]);

        let accessGranted = false;
        if (userId && programId && isSuccessfulTributeEvent(eventType, status)) {
            await run(env.DB, `
                INSERT INTO user_program_access (user_id, program_id, status, source, granted_at)
                VALUES (?, ?, 'active', 'tribute', CURRENT_TIMESTAMP)
                ON CONFLICT(user_id, program_id) DO UPDATE SET
                    status = 'active', source = 'tribute', granted_at = CURRENT_TIMESTAMP
            `, [userId, programId]);
            accessGranted = true;
        }

        return json({ ok: true, event_id: eventId, access_granted: accessGranted }, 200, env);
    } catch (error) {
        console.error("Tribute webhook error:", error);
        return json({ ok: false, error: "Не удалось обработать webhook Tribute" }, 500, env);
    }
}

async function requireUser(request, env) {
    if (!env.DB) return { ok: false, status: 500, error: "Database is not configured" };
    await ensureAuthSessionsTable(env.DB);
    const token = getBearerToken(request);
    if (!token) return { ok: false, status: 401, error: "Authorization required" };

    const row = await first(env.DB, `
        SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.phone,
               u.role, u.status, u.blocked_reason, u.blocked_at, u.created_at,
               u.updated_at, u.login, s.expires_at
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? LIMIT 1
    `, [token]);
    if (!row) return { ok: false, status: 401, error: "Invalid or expired session" };

    const expires = new Date(row.expires_at);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
        await run(env.DB, "DELETE FROM auth_sessions WHERE token = ?", [token]);
        return { ok: false, status: 401, error: "Invalid or expired session" };
    }
    if (row.status !== "active") {
        return { ok: false, status: 403, error: row.blocked_reason || "Ваш аккаунт заблокирован" };
    }
    return { ok: true, user: publicUser(row), token };
}

async function requireAdmin(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return auth;
    if (!isAdmin(auth.user)) return { ok: false, status: 403, error: "Требуются права администратора" };
    return auth;
}

async function createSession(db, userId) {
    await ensureAuthSessionsTable(db);
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await run(db, "DELETE FROM auth_sessions WHERE expires_at <= ?", [new Date().toISOString()]);
    await run(db, "INSERT INTO auth_sessions (user_id, token, expires_at) VALUES (?, ?, ?)", [userId, token, expiresAt]);
    return { token, expiresAt };
}

async function getUserById(db, userId) {
    const user = await first(db, `
        SELECT id, telegram_id, username, first_name, last_name, phone, role, status,
               blocked_reason, blocked_at, created_at, updated_at, login
        FROM users WHERE id = ? LIMIT 1
    `, [userId]);
    return publicUser(user);
}

async function generateTechnicalTelegramId(db) {
    const row = await first(db, "SELECT MIN(telegram_id) AS min_id FROM users WHERE telegram_id < 0");
    return Number(row?.min_id || 0) - 1;
}

async function listContentRows(db, table, params, user) {
    const columns = await tableColumns(db, table);
    if (!columns.length) throw new Error(`Table ${table} is missing`);
    const where = [];
    const values = [];
    if (!isAdmin(user)) {
        const visibleColumn = firstColumn(columns, ["is_visible", "visible", "is_published", "published"]);
        if (visibleColumn) where.push(`${quoteIdentifier(visibleColumn)} = 1`);
    }
    for (const [param, choices] of Object.entries({
        program_id: ["program_id"],
        course_id: ["course_id"],
        semester_id: ["semester_id"],
        subject_id: ["subject_id"]
    })) {
        const value = positiveIntegerOrNull(params.get(param));
        const column = firstColumn(columns, choices);
        if (value && column) {
            where.push(`${quoteIdentifier(column)} = ?`);
            values.push(value);
        }
    }
    const order = contentOrder(columns);
    const sql = `SELECT * FROM ${quoteIdentifier(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order ? ` ORDER BY ${order}` : ""}`;
    return all(db, sql, values);
}

async function insertLesson(db, data) {
    const columns = await tableColumns(db, "lessons");
    if (!columns.length) throw new Error("Table lessons is missing");
    const fields = [];
    const values = [];
    const add = (choices, value) => {
        const column = firstColumn(columns, choices);
        if (column) {
            fields.push(column);
            values.push(value);
        }
    };
    add(["course_id"], data.courseId);
    add(["program_id"], data.programId);
    add(["semester_id"], data.semesterId);
    add(["subject_id"], data.subjectId);
    add(["title", "name"], data.title);
    add(["description", "summary"], data.description);
    add(["content", "body", "text"], data.content);
    add(["lesson_number", "number"], data.lessonNumber);
    add(["sort_order", "position", "order_index"], data.sortOrder);
    add(["is_visible", "visible", "is_published", "published"], data.isVisible);
    if (!fields.length) throw new Error("No writable lesson columns were found");

    const result = await run(db, `
        INSERT INTO lessons (${fields.map(quoteIdentifier).join(", ")})
        VALUES (${fields.map(() => "?").join(", ")})
    `, values);
    return first(db, "SELECT * FROM lessons WHERE id = ? LIMIT 1", [Number(result.meta.last_row_id)]);
}

async function ensureLessonFilesTable(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS lesson_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER NOT NULL,
            file_key TEXT NOT NULL,
            original_name TEXT NOT NULL,
            content_type TEXT,
            size INTEGER,
            caption TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            uploaded_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(db, "CREATE INDEX IF NOT EXISTS idx_lesson_files_lesson_id ON lesson_files(lesson_id)");
}

async function getLessonFiles(db, lessonId) {
    await ensureLessonFilesTable(db);
    const columns = await tableColumns(db, "lesson_files");
    const orderColumn = firstColumn(columns, ["sort_order", "position", "order_index", "id"]);
    const rows = await all(db, `SELECT * FROM lesson_files WHERE lesson_id = ?${orderColumn ? ` ORDER BY ${quoteIdentifier(orderColumn)}, id` : ""}`, [lessonId]);
    return rows.map(normalizeLessonFile);
}

async function getLessonFileRow(db, fileId) {
    return first(db, "SELECT * FROM lesson_files WHERE id = ? LIMIT 1", [fileId]);
}

async function insertLessonFile(db, data) {
    const columns = await tableColumns(db, "lesson_files");
    const fields = [];
    const values = [];
    const add = (choices, value) => {
        const column = firstColumn(columns, choices);
        if (column) {
            fields.push(column);
            values.push(value);
        }
    };
    add(["lesson_id"], data.lessonId);
    add(["file_key", "r2_key", "storage_key", "object_key", "key"], data.key);
    add(["original_name", "file_name", "name"], data.fileName);
    add(["content_type", "mime_type", "file_type"], data.contentType);
    add(["size", "file_size", "size_bytes"], data.size);
    add(["caption", "description"], data.caption);
    add(["sort_order", "position", "order_index"], data.sortOrder);
    add(["uploaded_by", "user_id", "created_by"], data.uploadedBy);
    if (!firstColumn(columns, ["lesson_id"]) || !firstColumn(columns, ["file_key", "r2_key", "storage_key", "object_key", "key"])) {
        throw new Error("lesson_files must have lesson_id and an R2 key column");
    }
    const result = await run(db, `
        INSERT INTO lesson_files (${fields.map(quoteIdentifier).join(", ")})
        VALUES (${fields.map(() => "?").join(", ")})
    `, values);
    const row = await getLessonFileRow(db, Number(result.meta.last_row_id));
    return normalizeLessonFile(row);
}

function normalizeLessonFile(row) {
    if (!row) return null;
    return {
        ...row,
        file_key: fileStorageKey(row),
        file_name: fileDisplayName(row),
        content_type: fileContentType(row),
        size: Number(row.size ?? row.file_size ?? row.size_bytes ?? 0),
        url: `/api/lesson-files/${row.id}`
    };
}

function fileStorageKey(row) {
    return row.file_key || row.r2_key || row.storage_key || row.object_key || row.key || null;
}

function fileDisplayName(row) {
    return row.original_name || row.file_name || row.name || "file";
}

function fileContentType(row) {
    return row.content_type || row.mime_type || row.file_type || null;
}

async function ensureLessonProgressTable(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS lesson_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            lesson_id INTEGER NOT NULL,
            progress_percent INTEGER NOT NULL DEFAULT 0,
            is_completed INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, lesson_id)
        )
    `);
    await run(db, "CREATE INDEX IF NOT EXISTS idx_lesson_progress_user_id ON lesson_progress(user_id)");
}

async function getLessonProgress(db, userId, lessonId) {
    await ensureLessonProgressTable(db);
    return first(db, "SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ? LIMIT 1", [userId, lessonId]);
}

async function saveLessonProgress(db, userId, lessonId, percentage, completed) {
    const existing = await getLessonProgress(db, userId, lessonId);
    if (existing) {
        await run(db, `
            UPDATE lesson_progress
            SET progress_percent = ?, is_completed = ?,
                completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND lesson_id = ?
        `, [percentage, completed, completed, userId, lessonId]);
    } else {
        await run(db, `
            INSERT INTO lesson_progress (user_id, lesson_id, progress_percent, is_completed, completed_at)
            VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
        `, [userId, lessonId, percentage, completed, completed]);
    }
    return getLessonProgress(db, userId, lessonId);
}

async function ensureTributeTables(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS tribute_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT,
            payment_status TEXT,
            user_id INTEGER,
            program_id INTEGER,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(db, `
        CREATE TABLE IF NOT EXISTS user_program_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            program_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT,
            granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            UNIQUE(user_id, program_id)
        )
    `);
}

async function accessByProgram(db, userId) {
    await ensureTributeTables(db);
    const rows = await all(db, `
        SELECT program_id FROM user_program_access
        WHERE user_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `, [userId]);
    return new Set(rows.map((row) => Number(row.program_id)));
}

async function tributeUserId(db, metadata, data, payload) {
    const direct = positiveIntegerOrNull(metadata.user_id || data.user_id || payload.user_id);
    if (direct) return direct;
    const telegramId = positiveIntegerOrNull(metadata.telegram_id || data.telegram_id || payload.telegram_id || data.user?.telegram_id);
    if (!telegramId) return null;
    const user = await first(db, "SELECT id FROM users WHERE telegram_id = ? LIMIT 1", [telegramId]);
    return user ? Number(user.id) : null;
}

function isValidTributeWebhook(request, rawBody, env) {
    const secret = env.TRIBUTE_WEBHOOK_SECRET || env.TRIBUTE_WEBHOOK_TOKEN;
    if (!secret) return true;
    const supplied = request.headers.get("X-Tribute-Webhook-Secret") || request.headers.get("X-Webhook-Secret") || bearerFromHeader(request.headers.get("Authorization"));
    return Boolean(supplied) && constantTimeEqual(String(supplied), String(secret));
}

function isSuccessfulTributeEvent(type, status) {
    const successStatuses = new Set(["paid", "succeeded", "success", "active", "completed", "complete"]);
    if (successStatuses.has(status)) return true;
    return /(payment|invoice|subscription).*(success|succeed|paid|complete|active)/i.test(type);
}

async function ensureAuthSessionsTable(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS auth_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(db, "CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token)");
}

async function tableColumns(db, table) {
    if (tableColumnsCache.has(table)) return tableColumnsCache.get(table);
    const rows = await all(db, `PRAGMA table_info(${quoteIdentifier(table)})`);
    const columns = rows.map((row) => row.name);
    tableColumnsCache.set(table, columns);
    return columns;
}

async function all(db, sql, values = []) {
    const statement = db.prepare(sql);
    const result = values.length ? await statement.bind(...values).all() : await statement.all();
    return result.results || [];
}

async function first(db, sql, values = []) {
    const statement = db.prepare(sql);
    return values.length ? statement.bind(...values).first() : statement.first();
}

async function run(db, sql, values = []) {
    const statement = db.prepare(sql);
    return values.length ? statement.bind(...values).run() : statement.run();
}

function firstColumn(columns, choices) {
    return choices.find((column) => columns.includes(column)) || null;
}

function contentOrder(columns) {
    const fields = [];
    const sort = firstColumn(columns, ["sort_order", "position", "order_index", "lesson_number", "number"]);
    const title = firstColumn(columns, ["title", "name"]);
    if (sort) fields.push(`${quoteIdentifier(sort)} ASC`);
    if (title) fields.push(`${quoteIdentifier(title)} ASC`);
    if (columns.includes("id")) fields.push("id ASC");
    return fields.join(", ");
}

function isHidden(row, columns) {
    const column = firstColumn(columns, ["is_visible", "visible", "is_published", "published"]);
    return column ? Number(row[column]) !== 1 : false;
}

function quoteIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("Unsafe SQL identifier");
    return `"${identifier}"`;
}

function getBearerToken(request) {
    const headerToken = bearerFromHeader(request.headers.get("Authorization")) || request.headers.get("X-Session-Token");
    if (headerToken) return String(headerToken).trim();
    // Query token is intentionally supported for the HTML video/audio Range requests,
    // which cannot send an Authorization header. Prefer the header for normal API calls.
    return new URL(request.url).searchParams.get("token") || null;
}

function bearerFromHeader(value) {
    const match = String(value || "").match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function corsHeaders(env) {
    return {
        "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Session-Token, X-Tribute-Webhook-Secret, X-Webhook-Secret",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag",
        "Vary": "Origin"
    };
}

function withCors(response, env) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(payload, status = 200, env = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { ...corsHeaders(env), "Content-Type": "application/json; charset=utf-8" }
    });
}

function databaseMissing(env) {
    return json({ ok: false, error: "Database is not configured" }, 500, env);
}

function authError(auth, env) {
    return json({ ok: false, error: auth.error }, auth.status, env);
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        throw new Error("Invalid JSON body");
    }
}

function normalizeLogin(value) {
    return String(value || "").trim().toLowerCase();
}

function isValidLogin(login) {
    return /^[a-z0-9_-]{3,30}$/i.test(login);
}

function cleanText(value) {
    return typeof value === "string" ? value.trim().slice(0, 20000) : "";
}

function positiveIntegerOrNull(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function clampProgress(value) {
    return Math.max(0, Math.min(100, nonNegativeNumber(value)));
}

function safeFileName(name) {
    const normalized = String(name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
    return (normalized || "file").slice(0, 180);
}

function contentDisposition(contentType, fileName) {
    const disposition = /^(image\/|audio\/|video\/|application\/pdf$)/i.test(contentType) ? "inline" : "attachment";
    return `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseRange(header, size) {
    if (!header) return null;
    const match = String(header).trim().match(/^bytes=(\d*)-(\d*)$/i);
    if (!match || size < 1) return { invalid: true };
    const [, startText, endText] = match;
    let start;
    let end;
    if (!startText) {
        const suffixLength = Number(endText);
        if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return { invalid: true };
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(startText);
        end = endText ? Number(endText) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
            return { invalid: true };
        }
        end = Math.min(end, size - 1);
    }
    return { start, end, length: end - start + 1 };
}

function publicUser(user) {
    if (!user) return null;
    const { password_hash, ...publicData } = user;
    return publicData;
}

function isAdmin(user) {
    return ADMIN_ROLES.has(String(user?.role || "").toLowerCase());
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
    return `pbkdf2$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

async function verifyPassword(password, stored) {
    try {
        const parts = String(stored).split(/[$:.]/);
        let iterations = PASSWORD_ITERATIONS;
        let saltText;
        let hashText;
        if (parts[0] === "pbkdf2") {
            iterations = Number(parts[1]);
            saltText = parts[2];
            hashText = parts[3];
        } else if (parts.length === 3 && /^\d+$/.test(parts[0])) {
            iterations = Number(parts[0]);
            saltText = parts[1];
            hashText = parts[2];
        } else if (parts.length === 2) {
            saltText = parts[0];
            hashText = parts[1];
        } else {
            return false;
        }
        if (!Number.isSafeInteger(iterations) || iterations < 10000 || iterations > 1000000) return false;
        const expected = base64ToBytes(hashText);
        const actual = await derivePasswordHash(password, base64ToBytes(saltText), iterations);
        return constantTimeBytesEqual(actual, expected);
    } catch {
        return false;
    }
}

async function derivePasswordHash(password, salt, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
    return new Uint8Array(bits);
}

function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value) {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeBytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
    return diff === 0;
}

function constantTimeEqual(a, b) {
    return constantTimeBytesEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

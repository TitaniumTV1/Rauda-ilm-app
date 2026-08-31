import { verifyTelegramInitData } from "./telegram.js";

const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 100000;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        /*
         * ============================
         * HEALTH
         * ============================
         */

        if (
            url.pathname === "/api/health" &&
            request.method === "GET"
        ) {
            return json({
                ok: true,
                app: env.APP_NAME || "RAUDA ILM",
                database: !!env.DB,
                assets: !!env.ASSETS
            });
        }

        /*
         * ============================
         * DEBUG CONFIG
         * ============================
         */

        if (
            url.pathname === "/api/debug-config" &&
            request.method === "GET"
        ) {
            return json({
                ok: true,
                app: env.APP_NAME || "RAUDA ILM",
                telegram_bot_token: !!env.TELEGRAM_BOT_TOKEN,
                database: !!env.DB,
                assets: !!env.ASSETS,
                tribute_api_key: !!env.TRIBUTE_API_KEY
            });
        }

        /*
         * ============================
         * AUTH
         * ============================
         */

        if (
            url.pathname === "/api/auth/register" &&
            request.method === "POST"
        ) {
            return handleRegister(request, env);
        }

        if (
            url.pathname === "/api/auth/login" &&
            request.method === "POST"
        ) {
            return handleLogin(request, env);
        }

        if (
            url.pathname === "/api/auth/telegram" &&
            request.method === "POST"
        ) {
            return handleTelegramAuth(request, env);
        }

        if (
            url.pathname === "/api/auth/me" &&
            request.method === "GET"
        ) {
            return handleMe(request, env);
        }

        if (
            url.pathname === "/api/auth/logout" &&
            request.method === "POST"
        ) {
            return handleLogout(request, env);
        }

        /*
         * ============================
         * PROGRAMS
         * ============================
         */

        if (
            url.pathname === "/api/programs" &&
            request.method === "GET"
        ) {
            return handlePrograms(request, env);
        }

        /*
         * ============================
         * COURSES
         * ============================
         */

        if (
            url.pathname === "/api/courses" &&
            request.method === "GET"
        ) {
            return handleCourses(request, env);
        }

        /*
         * ============================
         * LESSONS
         * ============================
         */

        if (
            url.pathname === "/api/lessons" &&
            request.method === "GET"
        ) {
            return handleLessons(request, env);
        }

        /*
         * ============================
         * PROGRESS
         * ============================
         */

        if (
            url.pathname === "/api/progress" &&
            request.method === "POST"
        ) {
            return handleProgress(request, env);
        }

        /*
         * ============================
         * TRIBUTE
         * ============================
         */

        if (
            url.pathname === "/api/webhooks/tribute" &&
            request.method === "POST"
        ) {
            return handleTributeWebhook(request, env);
        }

        /*
         * ============================
         * FRONTEND
         * ============================
         */

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("RAUDA ILM", {
            status: 200,
            headers: {
                "Content-Type": "text/plain; charset=utf-8"
            }
        });
    }
};


/*
 * =========================================================
 * REGISTER
 * =========================================================
 */

async function handleRegister(request, env) {
    if (!env.DB) {
        return json(
            {
                ok: false,
                error: "Database is not configured"
            },
            500
        );
    }

    try {
        const body = await request.json();

        const login = normalizeLogin(body?.login);
        const password = String(body?.password || "");
        const firstName = cleanText(body?.first_name);
        const lastName = cleanText(body?.last_name);
        const phone = cleanText(body?.phone);

        if (!login) {
            return json(
                {
                    ok: false,
                    error: "Введите логин"
                },
                400
            );
        }

        if (!isValidLogin(login)) {
            return json(
                {
                    ok: false,
                    error:
                        "Логин должен содержать 3–30 символов: буквы, цифры, _ или -"
                },
                400
            );
        }

        if (password.length < 8) {
            return json(
                {
                    ok: false,
                    error: "Пароль должен содержать минимум 8 символов"
                },
                400
            );
        }

        /*
         * Проверяем существующий login.
         */

        const existing =
            await env.DB.prepare(`
                SELECT id
                FROM users
                WHERE login = ?
                LIMIT 1
            `)
                .bind(login)
                .first();

        if (existing) {
            return json(
                {
                    ok: false,
                    error: "Этот логин уже занят"
                },
                409
            );
        }

        const passwordHash =
            await hashPassword(password);

        /*
         * telegram_id оставляем NULL,
         * поскольку регистрация обычная.
         */

        const result =
            await env.DB.prepare(`
                INSERT INTO users (
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    phone,
                    role,
                    status,
                    login,
                    password_hash
                )
                VALUES (
                    NULL,
                    NULL,
                    ?,
                    ?,
                    ?,
                    'student',
                    'active',
                    ?,
                    ?
                )
            `)
                .bind(
                    firstName || null,
                    lastName || null,
                    phone || null,
                    login,
                    passwordHash
                )
                .run();

        const userId =
            Number(result.meta.last_row_id);

        const user =
            await getUserById(
                env.DB,
                userId
            );

        const session =
            await createSession(
                env.DB,
                userId
            );

        return json({
            ok: true,
            user,
            token: session.token,
            expires_at: session.expiresAt
        });

    } catch (error) {
        console.error(
            "Register error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Не удалось зарегистрировать пользователя"
            },
            500
        );
    }
}


/*
 * =========================================================
 * LOGIN
 * =========================================================
 */

async function handleLogin(request, env) {
    if (!env.DB) {
        return json(
            {
                ok: false,
                error: "Database is not configured"
            },
            500
        );
    }

    try {
        const body = await request.json();

        const login = normalizeLogin(body?.login);
        const password = String(body?.password || "");

        if (!login || !password) {
            return json(
                {
                    ok: false,
                    error: "Введите логин и пароль"
                },
                400
            );
        }

        const user =
            await env.DB.prepare(`
                SELECT
                    id,
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    phone,
                    role,
                    status,
                    blocked_reason,
                    blocked_at,
                    created_at,
                    updated_at,
                    login,
                    password_hash
                FROM users
                WHERE login = ?
                LIMIT 1
            `)
                .bind(login)
                .first();

        if (!user) {
            return json(
                {
                    ok: false,
                    error: "Неверный логин или пароль"
                },
                401
            );
        }

        if (user.status !== "active") {
            return json(
                {
                    ok: false,
                    error:
                        user.blocked_reason ||
                        "Ваш аккаунт заблокирован"
                },
                403
            );
        }

        if (!user.password_hash) {
            return json(
                {
                    ok: false,
                    error:
                        "Для этого аккаунта пароль ещё не установлен"
                },
                401
            );
        }

        const valid =
            await verifyPassword(
                password,
                user.password_hash
            );

        if (!valid) {
            return json(
                {
                    ok: false,
                    error: "Неверный логин или пароль"
                },
                401
            );
        }

        const session =
            await createSession(
                env.DB,
                user.id
            );

        delete user.password_hash;

        return json({
            ok: true,
            user,
            token: session.token,
            expires_at: session.expiresAt
        });

    } catch (error) {
        console.error(
            "Login error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Не удалось выполнить вход"
            },
            500
        );
    }
}


/*
 * =========================================================
 * TELEGRAM AUTH
 * =========================================================
 */

async function handleTelegramAuth(request, env) {
    if (!env.DB) {
        return json(
            {
                ok: false,
                error: "Database is not configured"
            },
            500
        );
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
        return json(
            {
                ok: false,
                error: "Telegram bot token is not configured"
            },
            500
        );
    }

    try {
        const body = await request.json();

        const initData =
            body?.initData;

        if (!initData) {
            return json(
                {
                    ok: false,
                    error: "Telegram initData is missing"
                },
                400
            );
        }

        const verification =
            await verifyTelegramInitData(
                initData,
                env.TELEGRAM_BOT_TOKEN
            );

        if (!verification.ok) {
            return json(
                {
                    ok: false,
                    error: verification.error
                },
                401
            );
        }

        const telegramUser =
            verification.user;

        const telegramId =
            Number(telegramUser.id);

        if (!telegramId) {
            return json(
                {
                    ok: false,
                    error: "Invalid Telegram user ID"
                },
                401
            );
        }

        /*
         * Ищем пользователя.
         */

        let user =
            await env.DB.prepare(`
                SELECT *
                FROM users
                WHERE telegram_id = ?
                LIMIT 1
            `)
                .bind(telegramId)
                .first();

        /*
         * Если пользователя ещё нет —
         * создаём.
         */

        if (!user) {
            const result =
                await env.DB.prepare(`
                    INSERT INTO users (
                        telegram_id,
                        username,
                        first_name,
                        last_name,
                        role,
                        status
                    )
                    VALUES (
                        ?,
                        ?,
                        ?,
                        ?,
                        'student',
                        'active'
                    )
                `)
                    .bind(
                        telegramId,
                        telegramUser.username || null,
                        telegramUser.first_name || null,
                        telegramUser.last_name || null
                    )
                    .run();

            user =
                await getUserById(
                    env.DB,
                    Number(result.meta.last_row_id)
                );
        } else {
            /*
             * Обновляем данные Telegram.
             */

            await env.DB.prepare(`
                UPDATE users
                SET
                    username = ?,
                    first_name = ?,
                    last_name = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `)
                .bind(
                    telegramUser.username || null,
                    telegramUser.first_name || null,
                    telegramUser.last_name || null,
                    user.id
                )
                .run();

            user =
                await getUserById(
                    env.DB,
                    user.id
                );
        }

        if (user.status !== "active") {
            return json(
                {
                    ok: false,
                    error:
                        user.blocked_reason ||
                        "Ваш аккаунт заблокирован"
                },
                403
            );
        }

        /*
         * Создаём обычную серверную сессию.
         */

        const session =
            await createSession(
                env.DB,
                user.id
            );

        return json({
            ok: true,
            user,
            token: session.token,
            expires_at: session.expiresAt
        });

    } catch (error) {
        console.error(
            "Telegram auth error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Telegram authentication failed"
            },
            500
        );
    }
}


/*
 * =========================================================
 * ME
 * =========================================================
 */

async function handleMe(request, env) {
    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            auth.status
        );
    }

    return json({
        ok: true,
        user: auth.user
    });
}


/*
 * =========================================================
 * LOGOUT
 * =========================================================
 */

async function handleLogout(request, env) {
    if (!env.DB) {
        return json(
            {
                ok: false,
                error: "Database is not configured"
            },
            500
        );
    }

    const token =
        getBearerToken(request);

    if (token) {
        await env.DB.prepare(`
            DELETE FROM auth_sessions
            WHERE token = ?
        `)
            .bind(token)
            .run();
    }

    return json({
        ok: true
    });
}


/*
 * =========================================================
 * AUTHENTICATION
 * =========================================================
 */

async function requireUser(request, env) {
    if (!env.DB) {
        return {
            ok: false,
            status: 500,
            error: "Database is not configured"
        };
    }

    const token =
        getBearerToken(request);

    if (!token) {
        return {
            ok: false,
            status: 401,
            error: "Authorization required"
        };
    }

    const row =
        await env.DB.prepare(`
            SELECT
                u.id,
                u.telegram_id,
                u.username,
                u.first_name,
                u.last_name,
                u.phone,
                u.role,
                u.status,
                u.blocked_reason,
                u.blocked_at,
                u.created_at,
                u.updated_at,
                u.login,
                s.token,
                s.expires_at
            FROM auth_sessions s
            JOIN users u
                ON u.id = s.user_id
            WHERE s.token = ?
            LIMIT 1
        `)
            .bind(token)
            .first();

    if (!row) {
        return {
            ok: false,
            status: 401,
            error: "Invalid or expired session"
        };
    }

    const expires =
        new Date(row.expires_at);

    if (
        Number.isNaN(expires.getTime()) ||
        expires.getTime() <= Date.now()
    ) {
        await env.DB.prepare(`
            DELETE FROM auth_sessions
            WHERE token = ?
        `)
            .bind(token)
            .run();

        return {
            ok: false,
            status: 401,
            error: "Session expired"
        };
    }

    if (row.status !== "active") {
        return {
            ok: false,
            status: 403,
            error:
                row.blocked_reason ||
                "User is blocked"
        };
    }

    delete row.token;
    delete row.expires_at;

    return {
        ok: true,
        user: row
    };
}


/*
 * =========================================================
 * SESSION
 * =========================================================
 */

async function createSession(db, userId) {
    const token =
        randomToken();

    const expiresAt =
        new Date(
            Date.now() +
            SESSION_DAYS *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    await db.prepare(`
        INSERT INTO auth_sessions (
            user_id,
            token,
            expires_at
        )
        VALUES (?, ?, ?)
    `)
        .bind(
            userId,
            token,
            expiresAt
        )
        .run();

    return {
        token,
        expiresAt
    };
}


/*
 * =========================================================
 * PROGRAMS
 * =========================================================
 */

async function handlePrograms(request, env) {
    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            auth.status
        );
    }

    try {
        const result =
            await env.DB.prepare(`
                SELECT *
                FROM programs
                ORDER BY id ASC
            `)
                .all();

        return json({
            ok: true,
            programs:
                result.results || []
        });

    } catch (error) {
        console.error(
            "Programs error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Failed to load programs"
            },
            500
        );
    }
}


/*
 * =========================================================
 * COURSES
 * =========================================================
 */

async function handleCourses(request, env) {
    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            auth.status
        );
    }

    try {
        const url =
            new URL(request.url);

        const programId =
            url.searchParams.get(
                "program_id"
            );

        let result;

        if (programId) {
            result =
                await env.DB.prepare(`
                    SELECT *
                    FROM courses
                    WHERE is_active = 1
                      AND id IN (
                          SELECT DISTINCT course_id
                          FROM lessons
                          WHERE program_id = ?
                      )
                    ORDER BY id ASC
                `)
                    .bind(
                        Number(programId)
                    )
                    .all();
        } else {
            result =
                await env.DB.prepare(`
                    SELECT *
                    FROM courses
                    WHERE is_active = 1
                    ORDER BY id ASC
                `)
                    .all();
        }

        return json({
            ok: true,
            courses:
                result.results || []
        });

    } catch (error) {
        console.error(
            "Courses error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Failed to load courses"
            },
            500
        );
    }
}


/*
 * =========================================================
 * LESSONS
 * =========================================================
 */

async function handleLessons(request, env) {
    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            auth.status
        );
    }

    try {
        const url =
            new URL(request.url);

        const courseId =
            url.searchParams.get(
                "course_id"
            );

        const programId =
            url.searchParams.get(
                "program_id"
            );

        let result;

        if (courseId) {
            result =
                await env.DB.prepare(`
                    SELECT
                        id,
                        course_id,
                        program_id,
                        semester_id,
                        subject_id,
                        title,
                        description,
                        lesson_number,
                        content,
                        sort_order,
                        is_visible
                    FROM lessons
                    WHERE is_visible = 1
                      AND course_id = ?
                    ORDER BY sort_order ASC, id ASC
                `)
                    .bind(
                        Number(courseId)
                    )
                    .all();

        } else if (programId) {
            result =
                await env.DB.prepare(`
                    SELECT
                        id,
                        course_id,
                        program_id,
                        semester_id,
                        subject_id,
                        title,
                        description,
                        lesson_number,
                        content,
                        sort_order,
                        is_visible
                    FROM lessons
                    WHERE is_visible = 1
                      AND program_id = ?
                    ORDER BY sort_order ASC, id ASC
                `)
                    .bind(
                        Number(programId)
                    )
                    .all();

        } else {
            result =
                await env.DB.prepare(`
                    SELECT
                        id,
                        course_id,
                        program_id,
                        semester_id,
                        subject_id,
                        title,
                        description,
                        lesson_number,
                        content,
                        sort_order,
                        is_visible
                    FROM lessons
                    WHERE is_visible = 1
                    ORDER BY sort_order ASC, id ASC
                `)
                    .all();
        }

        const lessons =
            result.results || [];

        const progress =
            await env.DB.prepare(`
                SELECT
                    lesson_id,
                    course_id,
                    completed,
                    completed_at
                FROM lesson_progress
                WHERE user_id = ?
            `)
                .bind(
                    auth.user.id
                )
                .all();

        const progressMap =
            new Map();

        for (
            const row
            of progress.results || []
        ) {
            progressMap.set(
                Number(row.lesson_id),
                row
            );
        }

        const completedLessonIds = [];

        for (
            const lesson
            of lessons
        ) {
            const item =
                progressMap.get(
                    Number(lesson.id)
                );

            lesson.completed =
                item
                    ? Number(item.completed) === 1
                    : false;

            lesson.completed_at =
                item?.completed_at ||
                null;

            if (lesson.completed) {
                completedLessonIds.push(
                    Number(lesson.id)
                );
            }
        }

        return json({
            ok: true,
            lessons,
            completedLessonIds
        });

    } catch (error) {
        console.error(
            "Lessons error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Failed to load lessons"
            },
            500
        );
    }
}


/*
 * =========================================================
 * PROGRESS
 * =========================================================
 */

async function handleProgress(request, env) {
    const auth =
        await requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            auth.status
        );
    }

    try {
        const body =
            await request.json();

        const lessonId =
            Number(body?.lessonId);

        if (!Number.isInteger(lessonId) || lessonId <= 0) {
            return json(
                {
                    ok: false,
                    error: "Invalid lessonId"
                },
                400
            );
        }

        const lesson =
            await env.DB.prepare(`
                SELECT
                    id,
                    course_id
                FROM lessons
                WHERE id = ?
                LIMIT 1
            `)
                .bind(lessonId)
                .first();

        if (!lesson) {
            return json(
                {
                    ok: false,
                    error: "Lesson not found"
                },
                404
            );
        }

        await env.DB.prepare(`
            INSERT INTO lesson_progress (
                user_id,
                course_id,
                lesson_id,
                completed,
                completed_at
            )
            VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING
        `)
            .bind(
                auth.user.id,
                lesson.course_id,
                lesson.id
            )
            .run();

        /*
         * Если запись уже существовала,
         * обновляем её.
         */

        await env.DB.prepare(`
            UPDATE lesson_progress
            SET
                completed = 1,
                completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
              AND lesson_id = ?
        `)
            .bind(
                auth.user.id,
                lesson.id
            )
            .run();

        return json({
            ok: true,
            completed: true,
            lesson_id: lesson.id
        });

    } catch (error) {
        console.error(
            "Progress error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Failed to save progress"
            },
            500
        );
    }
}


/*
 * =========================================================
 * TRIBUTE WEBHOOK
 * =========================================================
 */

async function handleTributeWebhook(request, env) {
    try {
        if (!env.TRIBUTE_API_KEY) {
            return json(
                {
                    ok: false,
                    error: "Tribute API key is not configured"
                },
                500
            );
        }

        if (!env.DB) {
            return json(
                {
                    ok: false,
                    error: "Database is not configured"
                },
                500
            );
        }

        const rawBody =
            await request.text();

        const signature =
            request.headers.get(
                "trbt-signature"
            );

        if (!signature) {
            return json(
                {
                    ok: false,
                    error: "Tribute signature is missing"
                },
                401
            );
        }

        const validSignature =
            await verifyTributeSignature(
                rawBody,
                signature,
                env.TRIBUTE_API_KEY
            );

        if (!validSignature) {
            return json(
                {
                    ok: false,
                    error: "Invalid webhook signature"
                },
                401
            );
        }

        let event;

        try {
            event =
                JSON.parse(rawBody);
        } catch {
            return json(
                {
                    ok: false,
                    error: "Invalid webhook JSON"
                },
                400
            );
        }

        if (
            event?.name !==
            "new_digital_product"
        ) {
            return json({
                ok: true,
                status: "ignored",
                event: event?.name || null
            });
        }

        const payload =
            event?.payload;

        if (!payload) {
            return json(
                {
                    ok: false,
                    error: "Tribute payload is missing"
                },
                400
            );
        }

        const productId =
            payload?.product_id;

        const telegramUserId =
            payload?.telegram_user_id;

        const purchaseId =
            payload?.purchase_id;

        const transactionId =
            payload?.transaction_id;

        if (!productId || !telegramUserId) {
            return json(
                {
                    ok: false,
                    error:
                        "Tribute product_id or telegram_user_id is missing"
                },
                400
            );
        }

        await ensureTributeTables(
            env.DB
        );

        const eventId =
            purchaseId
                ? `purchase:${purchaseId}`
                : transactionId
                    ? `transaction:${transactionId}`
                    : `event:${event.created_at || ""}:${productId}:${telegramUserId}`;

        const existing =
            await env.DB.prepare(`
                SELECT id
                FROM tribute_webhook_events
                WHERE event_id = ?
                LIMIT 1
            `)
                .bind(eventId)
                .first();

        if (existing) {
            return json({
                ok: true,
                status: "already_processed",
                event_id: eventId
            });
        }

        await env.DB.prepare(`
            INSERT INTO tribute_webhook_events (
                event_id,
                event_name,
                product_id,
                telegram_user_id,
                purchase_id,
                transaction_id,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `)
            .bind(
                eventId,
                event.name,
                String(productId),
                String(telegramUserId),
                purchaseId
                    ? String(purchaseId)
                    : null,
                transactionId
                    ? String(transactionId)
                    : null
            )
            .run();

        const mapping =
            await env.DB.prepare(`
                SELECT
                    tribute_product_id,
                    program_id
                FROM tribute_product_programs
                WHERE tribute_product_id = ?
                LIMIT 1
            `)
                .bind(
                    String(productId)
                )
                .first();

        if (!mapping) {
            return json({
                ok: true,
                status: "received",
                access: "not_mapped",
                product_id: productId,
                telegram_user_id: telegramUserId,
                event_id: eventId
            });
        }

        await env.DB.prepare(`
            INSERT OR IGNORE INTO user_programs (
                telegram_user_id,
                program_id,
                tribute_product_id,
                purchase_id,
                granted_at
            )
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `)
            .bind(
                String(telegramUserId),
                String(mapping.program_id),
                String(productId),
                purchaseId
                    ? String(purchaseId)
                    : null
            )
            .run();

        return json({
            ok: true,
            status: "processed",
            access: "granted",
            product_id: productId,
            telegram_user_id: telegramUserId,
            program_id: mapping.program_id,
            purchase_id: purchaseId || null,
            event_id: eventId
        });

    } catch (error) {
        console.error(
            "Tribute webhook error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Failed to process Tribute webhook"
            },
            500
        );
    }
}


/*
 * =========================================================
 * TRIBUTE TABLES
 * =========================================================
 */

async function ensureTributeTables(db) {
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS tribute_product_programs (
            tribute_product_id TEXT PRIMARY KEY,
            program_id TEXT NOT NULL
        )
    `).run();

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS user_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_user_id TEXT NOT NULL,
            program_id TEXT NOT NULL,
            tribute_product_id TEXT NOT NULL,
            purchase_id TEXT,
            granted_at TEXT NOT NULL
        )
    `).run();

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS tribute_webhook_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            event_name TEXT NOT NULL,
            product_id TEXT,
            telegram_user_id TEXT,
            purchase_id TEXT,
            transaction_id TEXT,
            created_at TEXT NOT NULL
        )
    `).run();

    await db.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_user_programs_telegram_user
        ON user_programs(telegram_user_id)
    `).run();
}


/*
 * =========================================================
 * PASSWORD HASH
 * =========================================================
 */

async function hashPassword(password) {
    const salt =
        crypto.getRandomValues(
            new Uint8Array(16)
        );

    const key =
        await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(password),
            {
                name: "PBKDF2"
            },
            false,
            [
                "deriveBits"
            ]
        );

    const hash =
        await crypto.subtle.deriveBits(
            {
                name: "PBKDF2",
                salt,
                iterations: PASSWORD_ITERATIONS,
                hash: "SHA-256"
            },
            key,
            256
        );

    return [
        "pbkdf2",
        PASSWORD_ITERATIONS,
        bytesToBase64(salt),
        bytesToBase64(
            new Uint8Array(hash)
        )
    ].join("$");
}


async function verifyPassword(
    password,
    storedHash
) {
    try {
        const parts =
            String(storedHash).split("$");

        if (
            parts.length !== 4 ||
            parts[0] !== "pbkdf2"
        ) {
            return false;
        }

        const iterations =
            Number(parts[1]);

        const salt =
            base64ToBytes(parts[2]);

        const expectedHash =
            base64ToBytes(parts[3]);

        const key =
            await crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(password),
                {
                    name: "PBKDF2"
                },
                false,
                [
                    "deriveBits"
                ]
            );

        const hash =
            await crypto.subtle.deriveBits(
                {
                    name: "PBKDF2",
                    salt,
                    iterations,
                    hash: "SHA-256"
                },
                key,
                256
            );

        return timingSafeEqualBytes(
            new Uint8Array(hash),
            expectedHash
        );

    } catch {
        return false;
    }
}


/*
 * =========================================================
 * TELEGRAM / USER HELPERS
 * =========================================================
 */

async function getUserById(
    db,
    userId
) {
    return db.prepare(`
        SELECT
            id,
            telegram_id,
            username,
            first_name,
            last_name,
            phone,
            role,
            status,
            blocked_reason,
            blocked_at,
            created_at,
            updated_at,
            login
        FROM users
        WHERE id = ?
        LIMIT 1
    `)
        .bind(userId)
        .first();
}


function getBearerToken(request) {
    const header =
        request.headers.get(
            "Authorization"
        );

    if (!header) {
        return null;
    }

    if (
        !header.startsWith(
            "Bearer "
        )
    ) {
        return null;
    }

    const token =
        header.slice(7).trim();

    return token || null;
}


function randomToken() {
    const bytes =
        crypto.getRandomValues(
            new Uint8Array(32)
        );

    return bytesToBase64Url(bytes);
}


function normalizeLogin(value) {
    return String(
        value || ""
    )
        .trim()
        .toLowerCase();
}


function isValidLogin(login) {
    return /^[a-zA-Z0-9_-]{3,30}$/.test(
        login
    );
}


function cleanText(value) {
    const text =
        String(value || "")
            .trim();

    return text || null;
}


/*
 * =========================================================
 * BASE64
 * =========================================================
 */

function bytesToBase64(bytes) {
    let binary = "";

    for (
        const byte
        of bytes
    ) {
        binary += String.fromCharCode(
            byte
        );
    }

    return btoa(binary);
}


function base64ToBytes(value) {
    const binary =
        atob(value);

    const bytes =
        new Uint8Array(
            binary.length
        );

    for (
        let i = 0;
        i < binary.length;
        i++
    ) {
        bytes[i] =
            binary.charCodeAt(i);
    }

    return bytes;
}


function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}


/*
 * =========================================================
 * TRIBUTE SIGNATURE
 * =========================================================
 */

async function verifyTributeSignature(
    rawBody,
    receivedSignature,
    apiKey
) {
    try {
        const encoder =
            new TextEncoder();

        const key =
            await crypto.subtle.importKey(
                "raw",
                encoder.encode(apiKey),
                {
                    name: "HMAC",
                    hash: "SHA-256"
                },
                false,
                [
                    "sign"
                ]
            );

        const signatureBuffer =
            await crypto.subtle.sign(
                "HMAC",
                key,
                encoder.encode(rawBody)
            );

        const expected =
            bytesToHex(
                new Uint8Array(
                    signatureBuffer
                )
            );

        return timingSafeEqual(
            expected.toLowerCase(),
            String(
                receivedSignature
            )
                .trim()
                .toLowerCase()
        );

    } catch (error) {
        console.error(
            "Tribute signature verification error:",
            error
        );

        return false;
    }
}


/*
 * =========================================================
 * SAFE COMPARE
 * =========================================================
 */

function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        result |=
            a.charCodeAt(i) ^
            b.charCodeAt(i);
    }

    return result === 0;
}


function timingSafeEqualBytes(
    a,
    b
) {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        result |=
            a[i] ^ b[i];
    }

    return result === 0;
}


function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");
}


/*
 * =========================================================
 * JSON
 * =========================================================
 */

function json(
    data,
    status = 200
) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: {
                ...corsHeaders(),
                "Content-Type":
                    "application/json; charset=utf-8"
            }
        }
    );
}


/*
 * =========================================================
 * CORS
 * =========================================================
 */

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
    };
}
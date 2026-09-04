import { verifyTelegramInitData } from "./telegram.js";
import { handleAssessmentRequest } from "./assessment.js";

const SESSION_DAYS = 30;
const SESSION_COOKIE_NAME =
    "__Host-rauda_session";
const PASSWORD_ITERATIONS = 100000;

let accountIdSchemaPromise = null;
const VERIFICATION_CODE_TTL_MINUTES = 5;
const VERIFICATION_RESEND_SECONDS = 60;
const VERIFICATION_MAX_ATTEMPTS = 5;
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
            
if (env.DB) {
    await ensureAccountIdSchema(env.DB);
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
            if (
    url.pathname === "/api/auth/email/send-code" &&
    request.method === "POST"
) {
    return handleEmailSendCode(request, env);
}
if (
    url.pathname === "/api/auth/email/login" &&
    request.method === "POST"
) {
    return handleEmailLogin(request, env);
}

if (
    url.pathname === "/api/auth/email/register" &&
    request.method === "POST"
) {
    return handleEmailRegister(request, env);
}
            
if (
    url.pathname === "/api/auth/password/reset" &&
    request.method === "POST"
) {
    return handlePasswordReset(request, env);
}
        
            
async function handleEmailSendCode(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        const body = await readJson(request);

        const email = String(body?.email || "")
            .trim()
            .toLowerCase();

        const requestedPurpose =
    String(body?.purpose || "")
        .trim()
        .toLowerCase();

const purpose =
    [
        "register",
        "login",
        "link"
    ].includes(requestedPurpose)
        ? requestedPurpose
        : "login";

if (purpose === "link") {

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
}

        if (!isValidEmail(email)) {
            return json(
                {
                    ok: false,
                    error: "Введите правильный адрес электронной почты"
                },
                400,
                env
            );
        }

        await ensureEmailAuthSchema(env.DB);

        const existingUser = await first(
            env.DB,
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = ?
            LIMIT 1
            `,
            [email]
        );

        if (purpose === "register" && existingUser) {
            return json(
                {
                    ok: false,
                    error: "Аккаунт с этой почтой уже существует"
                },
                409,
                env
            );
        }

        if (purpose === "login" && !existingUser) {
            return json(
                {
                    ok: false,
                    error: "Аккаунт с такой почтой не найден"
                },
                404,
                env
            );
        }

        const recentCode = await first(
            env.DB,
            `
            SELECT created_at
            FROM email_auth_codes
            WHERE email = ?
              AND purpose = ?
            ORDER BY id DESC
            LIMIT 1
            `,
            [email, purpose]
        );

        const now = Math.floor(Date.now() / 1000);

        if (
            recentCode &&
            now - Number(recentCode.created_at) < 60
        ) {
            return json(
                {
                    ok: false,
                    error: "Подождите 60 секунд перед повторной отправкой"
                },
                429,
                env
            );
        }

       const code =
    generateVerificationCode();

        const codeHash = await hashEmailCode(
            email,
            purpose,
            code,
            env
        );

        const expiresAt = now + 5 * 60;

        await run(
            env.DB,
            `
            INSERT INTO email_auth_codes (
                email,
                code_hash,
                purpose,
                expires_at,
                used_at,
                attempts,
                created_at
            )
            VALUES (?, ?, ?, ?, NULL, 0, ?)
            `,
            [
                email,
                codeHash,
                purpose,
                expiresAt,
                now
            ]
        );

        if (!env.BREVO_API_KEY) {
            return json(
                {
                    ok: false,
                    error: "BREVO_API_KEY не настроен"
                },
                500,
                env
            );
        }

        if (!env.EMAIL_FROM) {
            return json(
                {
                    ok: false,
                    error: "EMAIL_FROM не настроен"
                },
                500,
                env
            );
        }

        const brevoResponse = await fetch(
            "https://api.brevo.com/v3/smtp/email",
            {
                method: "POST",
                headers: {
                    "api-key": env.BREVO_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    sender: {
                        name: "RAUDA ILM",
                        email: env.EMAIL_FROM
                    },
                    to: [
                        {
                            email: email
                        }
                    ],
                    subject: "Код подтверждения RAUDA ILM",
                    htmlContent: `
                        <div style="
                            max-width:480px;
                            margin:auto;
                            padding:32px;
                            font-family:Arial,sans-serif;
                        ">
                            <h2>RAUDA ILM</h2>

                            <p>Ваш код подтверждения:</p>

                            <div style="
                                margin:24px 0;
                                font-size:32px;
                                font-weight:800;
                                letter-spacing:7px;
                            ">
                                ${code}
                            </div>

                            <p>
                                Код действует 5 минут.
                            </p>

                            <p style="
                                margin-top:28px;
                                color:#777;
                                font-size:13px;
                            ">
                                Если вы не запрашивали этот код,
                                проигнорируйте письмо.
                            </p>
                        </div>
                    `
                })
            }
        );

        if (!brevoResponse.ok) {

            const brevoError =
                await brevoResponse.text();

            console.error(
                "Brevo email error:",
                brevoResponse.status,
                brevoError
            );

            return json(
                {
                    ok: false,
                    error:
                        "Не удалось отправить код. Проверьте настройки Brevo."
                },
                502,
                env
            );
        }

        return json(
            {
                ok: true,
                message: "Код отправлен на почту"
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Email code error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Не удалось отправить код"
            },
            500,
            env
        );
    }
}




async function handlePasswordReset(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        await ensureAuthSessionsTable(env.DB);
        await ensureEmailAuthSchema(env.DB);

        const body = await readJson(request);

        const email = String(body?.email || "")
            .trim()
            .toLowerCase();

        const code = String(body?.code || "")
            .trim();

        const password = String(body?.password || "");

        if (!isValidEmail(email)) {
            return json(
                {
                    ok: false,
                    error: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0443\u044e \u043f\u043e\u0447\u0442\u0443"
                },
                400,
                env
            );
        }

        if (!/^\d{6}$/.test(code)) {
            return json(
                {
                    ok: false,
                    error: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 6-\u0437\u043d\u0430\u0447\u043d\u044b\u0439 \u043a\u043e\u0434"
                },
                400,
                env
            );
        }

        if (
            password.length < 8 ||
            password.length > 128
        ) {
            return json(
                {
                    ok: false,
                    error: "\u041f\u0430\u0440\u043e\u043b\u044c \u0434\u043e\u043b\u0436\u0435\u043d \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442\u044c \u043c\u0438\u043d\u0438\u043c\u0443\u043c 8 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432"
                },
                400,
                env
            );
        }

        /*
         * Используем существующий код EMAIL LOGIN.
         * Поэтому отдельная таблица reset-кодов не нужна.
         */

        const verification =
            await verifyEmailCode(
                env.DB,
                email,
                "login",
                code,
                env
            );

        if (!verification.ok) {
            return json(
                {
                    ok: false,
                    error: verification.error
                },
                verification.status || 400,
                env
            );
        }

        const user = await first(
            env.DB,
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = ?
            LIMIT 1
            `,
            [email]
        );

        if (!user) {
            return json(
                {
                    ok: false,
                    error: "\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u0441 \u0442\u0430\u043a\u043e\u0439 \u043f\u043e\u0447\u0442\u043e\u0439 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
                },
                404,
                env
            );
        }

        const passwordHash =
            await hashPassword(password);

        await run(
            env.DB,
            `
            UPDATE users
            SET
                password_hash = ?,
                email_verified_at = COALESCE(
                    email_verified_at,
                    CURRENT_TIMESTAMP
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [
                passwordHash,
                user.id
            ]
        );

        /*
         * После смены пароля закрываем старые сессии.
         */

        await run(
            env.DB,
            `
            DELETE FROM auth_sessions
            WHERE user_id = ?
            `,
            [user.id]
        );

        return json(
            {
                ok: true
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Password reset error:",
            error
        );

        return json(
            {
                ok: false,
                error: "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043f\u0430\u0440\u043e\u043b\u044c"
            },
            500,
            env
        );
    }
}

async function handleEmailLink(request, env) {
    if (!env.DB) return databaseMissing(env);

    const auth =
        await requireUser(request, env);

    if (!auth.ok) {
        return authError(auth, env);
    }

    try {
        await ensureEmailAuthSchema(env.DB);

        const body =
            await readJson(request);

        const email =
            String(body?.email || "")
                .trim()
                .toLowerCase();

        const code =
            String(body?.code || "")
                .trim();

        if (!isValidEmail(email)) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите корректную электронную почту"
                },
                400,
                env
            );
        }

        if (!/^\d{6}$/.test(code)) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите 6-значный код"
                },
                400,
                env
            );
        }

        const previewVerification =
    await verifyEmailCode(
        env.DB,
        email,
        "link",
        code,
        env,
        false
    );

if (!previewVerification.ok) {
    return json(
        {
            ok: false,
            error:
                previewVerification.error
        },
        previewVerification.status || 400,
        env
    );
}


const existing =
    await first(
        env.DB,
        `
        SELECT id
        FROM users
        WHERE LOWER(email) = ?
          AND id != ?
        LIMIT 1
        `,
        [
            email,
            auth.user.id
        ]
    );


if (existing) {

    const conflicts =
        await recoveryUserData(
            env.DB,
            existing.id
        );
    
    const mergePreview =
    await emailMergePreview(
        env.DB,
        existing.id
    );

    return json(
        {
            ok: false,
            needs_merge: true,
            email,
            merge_from_user_id:
                existing.id,
            conflicts,
merge_preview:
    mergePreview
        },
        409,
        env
    );
}


const verification =
    await verifyEmailCode(
        env.DB,
        email,
        "link",
        code,
        env,
        true
    );

if (!verification.ok) {
    return json(
        {
            ok: false,
            error:
                verification.error
        },
        verification.status || 400,
        env
    );
}
        await run(
            env.DB,
            `
            UPDATE users
            SET
                email = ?,
                email_verified_at =
                    CURRENT_TIMESTAMP,
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [
                email,
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
            "Email link error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось привязать почту"
            },
            500,
            env
        );
    }
}


async function handleEmailLogin(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        await ensureAuthSessionsTable(env.DB);
        await ensureEmailAuthSchema(env.DB);

        const body = await readJson(request);

        const email = String(body?.email || "")
            .trim()
            .toLowerCase();

        const code = String(body?.code || "")
            .trim();

        if (!isValidEmail(email)) {
            return json(
                {
                    ok: false,
                    error: "Некорректная почта"
                },
                400,
                env
            );
        }

        if (!/^\d{6}$/.test(code)) {
            return json(
                {
                    ok: false,
                    error: "Введите 6-значный код"
                },
                400,
                env
            );
        }

        const verification =
            await verifyEmailCode(
                env.DB,
                email,
                "login",
                code,
                env
            );

        if (!verification.ok) {
            return json(
                {
                    ok: false,
                    error: verification.error
                },
                verification.status || 400,
                env
            );
        }

        const user = await first(
            env.DB,
            `
            SELECT *
            FROM users
            WHERE LOWER(email) = ?
            LIMIT 1
            `,
            [email]
        );

        if (!user) {
            return json(
                {
                    ok: false,
                    error: "Аккаунт не найден"
                },
                404,
                env
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
                403,
                env
            );
        }

        await run(
            env.DB,
            `
            UPDATE users
            SET email_verified_at = COALESCE(
                email_verified_at,
                CURRENT_TIMESTAMP
            ),
            updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [user.id]
        );

        const session = await createSession(
            env.DB,
            user.id
        );

        const freshUser = await getUserById(
            env.DB,
            user.id
        );

        return json(
            {
                ok: true,
                user: freshUser,
                token: session.token,
                expires_at: session.expiresAt
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Email login error:",
            error
        );

        return json(
            {
                ok: false,
                error: "Не удалось выполнить вход"
            },
            500,
            env
        );
    }
}


async function handleEmailRegister(request, env) {
    if (!env.DB) return databaseMissing(env);

    try {
        await ensureAuthSessionsTable(env.DB);
        await ensureEmailAuthSchema(env.DB);

        const body = await readJson(request);

        const email = String(body?.email || "")
            .trim()
            .toLowerCase();

        const code = String(body?.code || "")
            .trim();

        const login = normalizeLogin(
            body?.login
        );

        const firstName = cleanText(
            body?.first_name
        );

        const lastName = cleanText(
            body?.last_name
        );

        if (!isValidEmail(email)) {
            return json(
                {
                    ok: false,
                    error: "Некорректная почта"
                },
                400,
                env
            );
        }

        if (!/^\d{6}$/.test(code)) {
            return json(
                {
                    ok: false,
                    error: "Введите 6-значный код"
                },
                400,
                env
            );
        }

        if (!login || !isValidLogin(login)) {
            return json(
                {
                    ok: false,
                    error:
                        "Логин должен содержать 3–30 символов"
                },
                400,
                env
            );
        }

        const existingEmail = await first(
            env.DB,
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = ?
            LIMIT 1
            `,
            [email]
        );

        if (existingEmail) {
            return json(
                {
                    ok: false,
                    error: "Аккаунт с этой почтой уже существует"
                },
                409,
                env
            );
        }

        const existingLogin = await first(
            env.DB,
            `
            SELECT id
            FROM users
            WHERE login = ?
            LIMIT 1
            `,
            [login]
        );

        if (existingLogin) {
            return json(
                {
                    ok: false,
                    error: "Этот логин уже занят"
                },
                409,
                env
            );
        }

        const verification =
            await verifyEmailCode(
                env.DB,
                email,
                "register",
                code,
                env
            );

        if (!verification.ok) {
            return json(
                {
                    ok: false,
                    error: verification.error
                },
                verification.status || 400,
                env
            );
        }

        const technicalTelegramId =
            await generateTechnicalTelegramId(
                env.DB
            );

        const result = await run(
            env.DB,
            `
            INSERT INTO users (
                telegram_id,
                username,
                first_name,
                last_name,
                role,
                status,
                login,
                email,
                email_verified_at
            )
            VALUES (
                ?,
                NULL,
                ?,
                ?,
                'student',
                'active',
                ?,
                ?,
                CURRENT_TIMESTAMP
            )
            `,
            [
                technicalTelegramId,
                firstName || null,
                lastName || null,
                login,
                email
            ]
        );

        const user = await getUserById(
            env.DB,
            Number(result.meta.last_row_id)
        );

        const session = await createSession(
            env.DB,
            user.id
        );

        return json(
            {
                ok: true,
                user,
                token: session.token,
                expires_at: session.expiresAt
            },
            201,
            env
        );

    } catch (error) {
        console.error(
            "Email register error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось зарегистрировать пользователя"
            },
            500,
            env
        );
    }
}


async function verifyEmailCode(
    db,
    email,
    purpose,
    code,
    env,
    consume = true
) {
    const row = await first(
        db,
        `
        SELECT *
        FROM email_auth_codes
        WHERE email = ?
          AND purpose = ?
          AND used_at IS NULL
        ORDER BY id DESC
        LIMIT 1
        `,
        [
            email,
            purpose
        ]
    );

    if (!row) {
        return {
            ok: false,
            status: 400,
            error: "Сначала запросите код"
        };
    }

    const now =
        Math.floor(Date.now() / 1000);

    if (Number(row.expires_at) < now) {
        return {
            ok: false,
            status: 400,
            error: "Срок действия кода истёк"
        };
    }

    if (Number(row.attempts || 0) >= 5) {
        return {
            ok: false,
            status: 429,
            error:
                "Слишком много попыток. Запросите новый код"
        };
    }

    const expectedHash =
        await hashEmailCode(
            email,
            purpose,
            code,
            env
        );

    if (expectedHash !== row.code_hash) {
        await run(
            db,
            `
            UPDATE email_auth_codes
            SET attempts = attempts + 1
            WHERE id = ?
            `,
            [row.id]
        );

        return {
            ok: false,
            status: 401,
            error: "Неверный код"
        };
    }

   if (consume) {
    await run(
        db,
        `
        UPDATE email_auth_codes
        SET used_at = ?
        WHERE id = ?
        `,
        [
            now,
            row.id
        ]
    );
}

    return {
        ok: true
    };
}


async function hashEmailCode(
    email,
    purpose,
    code,
    env
) {
    const secret =
        String(
            env.EMAIL_AUTH_SECRET ||
            ""
        );

    if (!secret) {
        throw new Error(
            "EMAIL_AUTH_SECRET is not configured"
        );
    }

    const encoder =
        new TextEncoder();

    const key =
        await crypto.subtle.importKey(
            "raw",
            encoder.encode(secret),
            {
                name: "HMAC",
                hash: "SHA-256"
            },
            false,
            ["sign"]
        );

    const message =
        [
            String(email),
            String(purpose),
            String(code)
        ].join(":");

    const signature =
        await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(message)
        );

    return Array.from(
        new Uint8Array(signature)
    )
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");
}
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        String(email || "")
    );
}


async function ensureEmailAuthSchema(db) {
    const columns =
        await all(
            db,
            `PRAGMA table_info(users)`
        );

    const names = new Set(
        (columns || []).map(
            column => column.name
        )
    );

    if (!names.has("email")) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN email TEXT
            `
        );
    }

    if (!names.has("email_verified_at")) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN email_verified_at TEXT
            `
        );
    }

    await run(
        db,
        `
        CREATE TABLE IF NOT EXISTS email_auth_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            purpose TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
        `
    );

    await run(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_email_auth_codes_email
        ON email_auth_codes(email)
        `
    );

    await run(
        db,
        `
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_users_email_unique
        ON users(LOWER(email))
        WHERE email IS NOT NULL
          AND email != ''
        `
    );
}
            if (
                url.pathname === "/api/auth/email/link" &&
                request.method === "POST"
            ) {
                return handleEmailLink(request, env);
            }

            if (url.pathname === "/api/auth/telegram" && request.method === "POST") {
                return handleTelegramAuth(request, env);
            }
            if (
                url.pathname === "/api/auth/telegram-widget" &&
                request.method === "POST"
            ) {
                return handleTelegramWidgetAuth(request, env);
            }
            if (url.pathname === "/api/auth/me" && request.method === "GET") {
                return handleMe(request, env);
            }
            if (  url.pathname === "/api/auth/profile" && request.method === "PATCH") {
                return handleProfileUpdate(request, env);
            }
            if (
                url.pathname === "/api/auth/avatar" &&
                request.method === "GET"
            ) {
                return handleAvatarGet(request, env);
            }

            if (
                url.pathname === "/api/auth/avatar" &&
                request.method === "POST"
            ) {
                return handleAvatarUpload(request, env);
            }


            if (  url.pathname === "/api/auth/link-login" && request.method === "PATCH") {
                return handleLinkLogin(request, env);
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
            if (url.pathname === "/api/admin/students/search" && request.method === "GET") {
                return handleAdminStudentSearch(request,env);
} 
            if (
    url.pathname === "/api/admin/students/grades" &&
    request.method === "GET"
) {
    return handleAdminStudentGrades(
        request,
        env
    );
}
            if (
    url.pathname === "/api/admin/students/grade" &&
    request.method === "PATCH"
) {
    return handleAdminUpdateStudentGrade(
        request,
        env
    );
}

      if (
    url.pathname === "/api/admin/students/retake" &&
    request.method === "POST"
) {
    return handleAdminGrantRetake(
        request,
        env
    );
}
            
            if (url.pathname === "/api/admin/users/change-password" &&
    request.method === "POST"
) {
    return handleOwnerChangeAdminPassword(request, env);
}

            if (
    url.pathname === "/api/admin/users/role" &&
    request.method === "POST"
) {
    return handleOwnerChangeUserRole(
        request,
        env
    );
}

            if (
    url.pathname === "/api/admin/users/permissions" &&
    (
        request.method === "GET" ||
        request.method === "POST"
    )
) {
    return handleOwnerAdminPermissions(
        request,
        env
    );
} 
            
                     if (
    url.pathname === "/api/admin/users/search" &&
    request.method === "GET"
) {
    return handleAdminUserSearch(
        request,
        env
    );
}
            if (
    url.pathname === "/api/admin/programs" &&
    request.method === "POST"
) {
    return handleAdminCreateProgram(
        request,
        env
    );
}

if (
    url.pathname === "/api/admin/courses" &&
    request.method === "POST"
) {
    return handleAdminCreateCourse(
        request,
        env
    );
}

const adminProgramRoute =
    url.pathname.match(
        /^\/api\/admin\/programs\/(\d+)$/
    );

if (
    adminProgramRoute &&
    request.method === "PATCH"
) {
    return handleAdminUpdateProgram(
        request,
        env,
        Number(adminProgramRoute[1])
    );
}

if (
    adminProgramRoute &&
    request.method === "DELETE"
) {
    return handleAdminDeleteProgram(
        request,
        env,
        Number(adminProgramRoute[1])
    );
}

            if (
    url.pathname === "/api/admin/semesters" &&
    request.method === "GET"
) {
    return handleAdminGetSemesters(
        request,
        env
    );
}
            const adminSemesterRoute =
    url.pathname.match(
        /^\/api\/admin\/semesters\/(\d+)$/
    );

if (
    adminSemesterRoute &&
    request.method === "PATCH"
) {
    return handleAdminUpdateSemester(
        request,
        env,
        Number(adminSemesterRoute[1])
    );
}
            
const adminCourseRoute =
    url.pathname.match(
        /^\/api\/admin\/courses\/(\d+)$/
    );

if (
    adminCourseRoute &&
    request.method === "PATCH"
) {
    return handleAdminUpdateCourse(
        request,
        env,
        Number(adminCourseRoute[1])
    );
}

if (
    adminCourseRoute &&
    request.method === "DELETE"
) {
    return handleAdminDeleteCourse(
        request,
        env,
        Number(adminCourseRoute[1])
    );
}
            
            // Create the lesson first; the returned id is then used for file uploads.
            if (url.pathname === "/api/admin/lessons" && request.method === "POST") {
                return handleAdminCreateLesson(request, env);
            }

            const adminLessonRoute =
    url.pathname.match(
        /^\/api\/admin\/lessons\/(\d+)$/
    );

if (
    adminLessonRoute &&
    request.method === "PATCH"
) {
    return handleAdminUpdateLesson(
        request,
        env,
        Number(adminLessonRoute[1])
    );
}

if (
    adminLessonRoute &&
    request.method === "DELETE"
) {
    return handleAdminDeleteLesson(
        request,
        env,
        Number(adminLessonRoute[1])
    );
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

            /*
             * RAUDA ASSESSMENT SYSTEM ROUTER
             */

            const assessmentResponse =
                await handleAssessmentRequest(
                    request,
                    env,
                    {
                        requireUser,
                        requireAdmin,
                        authError,
                        json
                    }
                );

            if (assessmentResponse) {
                return assessmentResponse;
            }

            if (url.pathname === "/api/progress" && request.method === "POST") {
                return handleProgress(request, env);
            }
            if (
                url.pathname === "/api/grades" &&
                request.method === "GET"
            ) {
                return handleGrades(request, env);
            }
           
            if (
    url.pathname === "/api/grades/details" &&
    request.method === "GET"
) {
    return handleGradesDetails(
        request,
        env
    );
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
                role, status, login, email, email_verified_at, password_hash
            ) VALUES (?, NULL, ?, ?, ?, 'student', 'active', ?, ?)
        `, [technicalTelegramId, firstName || null, lastName || null, phone || null, login, passwordHash]);

        const user = await getUserById(env.DB, Number(result.meta.last_row_id));
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
        await ensureAvatarInfrastructure(env.DB);
        const body = await readJson(request);
        const login = normalizeLogin(body?.login);
        const password = String(body?.password || "");
        if (!login || !password) {
            return json({ ok: false, error: "Введите логин и пароль" }, 400, env);
        }

        const user = await first(env.DB, `
            SELECT id, account_id, telegram_id, username, first_name, last_name, phone,
                   role, status, blocked_reason, blocked_at, created_at, updated_at,
                   login, email, email_verified_at, avatar_key, avatar_source, password_hash
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
    if (!env.DB) {
        return databaseMissing(env);
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
        return json(
            {
                ok: false,
                error: "Telegram bot token is not configured"
            },
            500,
            env
        );
    }

    try {
        await ensureAuthSessionsTable(env.DB);

        const body = await readJson(request);

        if (!body?.initData) {
            return json(
                {
                    ok: false,
                    error: "Telegram initData is missing"
                },
                400,
                env
            );
        }

        const verification =
            await verifyTelegramInitData(
                body.initData,
                env.TELEGRAM_BOT_TOKEN
            );

        if (!verification?.ok) {
            return json(
                {
                    ok: false,
                    error:
                        verification?.error ||
                        "Telegram authentication failed"
                },
                401,
                env
            );
        }
        const telegramUser =
    verification.user || {};

const telegramId =
    Number(telegramUser.id);

if (
    !Number.isSafeInteger(telegramId) ||
    telegramId <= 0
) {
    return json(
        {
            ok: false,
            error: "Invalid Telegram user ID"
        },
        401,
        env
    );
} 
        let user = await first(
            env.DB,
            `
            SELECT *
            FROM users
            WHERE telegram_id = ?
            LIMIT 1
            `,
            [telegramId]
        );
        /*
         * Первый вход через Telegram
         */
        if (!user) {

            const result = await run(
                env.DB,
                `
                INSERT INTO users (
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    role,
                    status
                )
                VALUES (?, ?, ?, ?, 'student', 'active')
                `,
                [
                    telegramId,
                    telegramUser.username || null,
                    telegramUser.first_name || null,
                    telegramUser.last_name || null
                ]
            );

            user = await getUserById(
                env.DB,
                Number(result.meta.last_row_id)
            );

        } else {

            /*
             * Пользователь уже существует.
             *
             * Не заменяем username,
             * имя и фамилию данными Telegram,
             * потому что пользователь может
             * изменить их вручную в профиле.
             */

           await run(
    env.DB,
    `
    UPDATE users
    SET
        username = COALESCE(?, username),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [
        telegramUser.username || null,
        user.id
    ]
);

            user = await getUserById(
                env.DB,
                user.id
            );
        }

        /*
         * Заблокированным пользователям
         * запрещаем получать новую сессию.
         */
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

        /*
         * Только после проверки блокировки
         * создаём сессию.
         */
        /* RAUDA MINIAPP AVATAR */

        await syncTelegramAvatar(
            env,
            user.id,
            telegramId,
            telegramUser.photo_url || null
        );

        user =
            await getUserById(
                env.DB,
                user.id
            );


        const session =
            await createSession(
                env.DB,
                user.id
            );

        return json(
            {
                ok: true,
                user,
                token: session.token,
                expires_at: session.expiresAt
            },
            200,
            env
        );

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
            500,
            env
        );
    }
}


async function handleTelegramWidgetAuth(request, env) {
    if (!env.DB) {
        return databaseMissing(env);
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
        return json(
            {
                ok: false,
                error: "Telegram bot token is not configured"
            },
            500,
            env
        );
    }

    try {
        await ensureAuthSessionsTable(
            env.DB
        );

        const body =
            await readJson(request);

        const verification =
            await verifyTelegramWidgetAuth(
                body,
                env.TELEGRAM_BOT_TOKEN
            );

        if (!verification.ok) {
            return json(
                {
                    ok: false,
                    error:
                        verification.error ||
                        "Telegram authentication failed"
                },
                401,
                env
            );
        }


        const telegramUser =
            verification.user;


        const telegramId =
            Number(telegramUser.id);


        if (
            !Number.isSafeInteger(telegramId) ||
            telegramId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error: "Invalid Telegram user ID"
                },
                401,
                env
            );
        }


        let user =
            await first(
                env.DB,
                `
                SELECT *
                FROM users
                WHERE telegram_id = ?
                LIMIT 1
                `,
                [telegramId]
            );


        /*
         * Первый вход через Telegram
         */

        if (!user) {

            const result =
                await run(
                    env.DB,
                    `
                    INSERT INTO users (
                        telegram_id,
                        username,
                        first_name,
                        last_name,
                        role,
                        status
                    )
                    VALUES (
                        ?, ?, ?, ?,
                        'student',
                        'active'
                    )
                    `,
                    [
                        telegramId,
                        telegramUser.username || null,
                        telegramUser.first_name || null,
                        telegramUser.last_name || null
                    ]
                );


            user =
                await getUserById(
                    env.DB,
                    Number(
                        result.meta.last_row_id
                    )
                );

        } else {

            /*
             * Не перезаписываем имя,
             * которое пользователь мог
             * изменить в RAUDA ILM.
             */

            await run(
    env.DB,
    `
    UPDATE users
    SET
        username = COALESCE(?, username),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [
        telegramUser.username || null,
        user.id
    ]
);


            user =
                await getUserById(
                    env.DB,
                    user.id
                );
        }


        if (
            user.status !==
            "active"
        ) {
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
        /* RAUDA WIDGET AVATAR */

        await syncTelegramAvatar(
            env,
            user.id,
            telegramId,
            telegramUser.photo_url || null
        );

        user =
            await getUserById(
                env.DB,
                user.id
            );




        const session =
            await createSession(
                env.DB,
                user.id
            );


        return json(
            {
                ok: true,
                user:
                    publicUser(user),
                token:
                    session.token,
                expires_at:
                    session.expiresAt
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Telegram widget auth error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось выполнить вход через Telegram"
            },
            500,
            env
        );
    }
}


async function verifyTelegramWidgetAuth(
    data,
    botToken
) {

    try {

        if (
            !data ||
            typeof data !== "object"
        ) {
            return {
                ok: false,
                error:
                    "Telegram данные отсутствуют"
            };
        }


        const receivedHash =
            String(
                data.hash || ""
            )
            .trim()
            .toLowerCase();


        if (
            !/^[a-f0-9]{64}$/.test(
                receivedHash
            )
        ) {
            return {
                ok: false,
                error:
                    "Некорректная подпись Telegram"
            };
        }


        const authDate =
            Number(
                data.auth_date
            );


        if (
            !Number.isSafeInteger(
                authDate
            )
        ) {
            return {
                ok: false,
                error:
                    "Некорректное время Telegram авторизации"
            };
        }


        const now =
            Math.floor(
                Date.now() / 1000
            );


        /*
         * Авторизация должна быть свежей.
         */

        if (
            authDate > now + 60 ||
            now - authDate > 300
        ) {
            return {
                ok: false,
                error:
                    "Telegram авторизация устарела. Попробуйте войти ещё раз."
            };
        }


        const values =
            Object.entries(data)
                .filter(
                    ([key, value]) =>
                        key !== "hash" &&
                        value !== undefined &&
                        value !== null
                )
                .map(
                    ([key, value]) => [
                        key,
                        String(value)
                    ]
                )
                .sort(
                    (a, b) =>
                        a[0].localeCompare(
                            b[0]
                        )
                );


        const dataCheckString =
            values
                .map(
                    ([key, value]) =>
                        `${key}=${value}`
                )
                .join("\n");


        const encoder =
            new TextEncoder();


        /*
         * secret_key =
         * SHA256(bot_token)
         */

        const secretKey =
            await crypto.subtle.digest(
                "SHA-256",
                encoder.encode(
                    String(botToken)
                )
            );


        const hmacKey =
            await crypto.subtle.importKey(
                "raw",
                secretKey,
                {
                    name: "HMAC",
                    hash: "SHA-256"
                },
                false,
                ["sign"]
            );


        const signature =
            await crypto.subtle.sign(
                "HMAC",
                hmacKey,
                encoder.encode(
                    dataCheckString
                )
            );


        const expectedHash =
            Array.from(
                new Uint8Array(
                    signature
                )
            )
            .map(
                byte =>
                    byte
                        .toString(16)
                        .padStart(2, "0")
            )
            .join("");


        if (
            expectedHash.length !==
            receivedHash.length
        ) {
            return {
                ok: false,
                error:
                    "Telegram подпись не совпадает"
            };
        }


        /*
         * Сравниваем без раннего выхода.
         */

        let difference = 0;

        for (
            let i = 0;
            i < expectedHash.length;
            i++
        ) {
            difference |=
                expectedHash.charCodeAt(i) ^
                receivedHash.charCodeAt(i);
        }


        if (difference !== 0) {
            return {
                ok: false,
                error:
                    "Telegram подпись не совпадает"
            };
        }


        const telegramId =
            Number(
                data.id
            );


        if (
            !Number.isSafeInteger(
                telegramId
            ) ||
            telegramId <= 0
        ) {
            return {
                ok: false,
                error:
                    "Некорректный Telegram ID"
            };
        }


        return {
            ok: true,

            user: {
                id:
                    telegramId,

                first_name:
                    cleanText(
                        data.first_name
                    ) || null,

                last_name:
                    cleanText(
                        data.last_name
                    ) || null,

                username:
                    cleanText(
                        data.username
                    ) || null,

                photo_url:
                    cleanText(
                        data.photo_url
                    ) || null
            }
        };

    } catch (error) {

        console.error(
            "Telegram widget verification error:",
            error
        );

        return {
            ok: false,
            error:
                "Не удалось проверить Telegram авторизацию"
        };
    }
}

async function handleMe(request, env) {
    const auth = await requireUser(request, env);
    if (!auth.ok) return authError(auth, env);
    return json({ ok: true, user: auth.user }, 200, env);
}

async function ensureAvatarInfrastructure(db) {

    const columns =
        await all(
            db,
            `PRAGMA table_info(users)`
        );

    const names =
        new Set(
            columns.map(
                column => column.name
            )
        );


    if (!names.has("avatar_key")) {

        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN avatar_key TEXT
            `
        );
    }


    if (!names.has("avatar_source")) {

        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN avatar_source TEXT
            `
        );
    }
}


async function handleAvatarGet(
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


    if (!env.FILES) {

        return json(
            {
                ok: false,
                error:
                    "Хранилище изображений не подключено"
            },
            503,
            env
        );
    }


    await ensureAvatarInfrastructure(
        env.DB
    );


    const row =
        await first(
            env.DB,
            `
            SELECT avatar_key
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [auth.user.id]
        );


    if (!row?.avatar_key) {

        return json(
            {
                ok: false,
                error:
                    "Аватар не установлен"
            },
            404,
            env
        );
    }


    const object =
        await env.FILES.get(
            row.avatar_key
        );


    if (!object) {

        return json(
            {
                ok: false,
                error:
                    "Файл аватара не найден"
            },
            404,
            env
        );
    }


    return new Response(
        object.body,
        {
            status: 200,

            headers: {
                "Content-Type":
                    object.httpMetadata
                        ?.contentType ||
                    "image/jpeg",

                "Cache-Control":
                    "private, no-cache"
            }
        }
    );
}


async function handleAvatarUpload(
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


    /*
     * Telegram-пользователь получает
     * фотографию непосредственно
     * из своего Telegram-профиля.
     */

    const telegramId =
        Number(
            auth.user.telegram_id
        );


    if (
        Number.isSafeInteger(
            telegramId
        ) &&
        telegramId > 0
    ) {

        return json(
            {
                ok: false,
                error:
                    "Для Telegram-аккаунта используется фото профиля Telegram"
            },
            403,
            env
        );
    }


    if (!env.FILES) {

        return json(
            {
                ok: false,
                error:
                    "Хранилище изображений не подключено"
            },
            503,
            env
        );
    }


    await ensureAvatarInfrastructure(
        env.DB
    );


    const form =
        await request.formData();


    const uploaded =
        form.get("avatar");


    if (
        !uploaded ||
        typeof uploaded.arrayBuffer !==
            "function"
    ) {

        return json(
            {
                ok: false,
                error:
                    "Выберите изображение"
            },
            400,
            env
        );
    }


    const allowed =
        new Set([
            "image/jpeg",
            "image/png",
            "image/webp"
        ]);


    const contentType =
        String(
            uploaded.type || ""
        ).toLowerCase();


    if (!allowed.has(contentType)) {

        return json(
            {
                ok: false,
                error:
                    "Разрешены JPG, PNG и WEBP"
            },
            400,
            env
        );
    }


    if (
        Number(uploaded.size) >
        5 * 1024 * 1024
    ) {

        return json(
            {
                ok: false,
                error:
                    "Размер изображения не должен превышать 5 МБ"
            },
            400,
            env
        );
    }


    const bytes =
        await uploaded.arrayBuffer();


    const key =
        `avatars/${auth.user.id}/custom`;


    await env.FILES.put(
        key,
        bytes,
        {
            httpMetadata: {
                contentType
            }
        }
    );


    await run(
        env.DB,
        `
        UPDATE users
        SET
            avatar_key = ?,
            avatar_source = 'custom',
            updated_at =
                CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [
            key,
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
}


async function fetchTelegramAvatar(
    env,
    telegramId,
    photoUrl
) {

    /*
     * Сначала используем photo_url,
     * если Telegram уже передал его.
     */

    if (photoUrl) {

        try {

            const url =
                new URL(
                    String(photoUrl)
                );


            if (
                url.protocol ===
                "https:"
            ) {

                const response =
                    await fetch(
                        url.toString()
                    );


                if (response.ok) {
                    return response;
                }
            }

        } catch {}
    }


    /*
     * Для Mini App photo_url может
     * отсутствовать. Тогда получаем
     * фотографию через Bot API.
     */

    if (
        !env.TELEGRAM_BOT_TOKEN
    ) {
        return null;
    }


    try {

        const photosResponse =
            await fetch(
                "https://api.telegram.org/bot" +
                env.TELEGRAM_BOT_TOKEN +
                "/getUserProfilePhotos?" +
                "user_id=" +
                encodeURIComponent(
                    telegramId
                ) +
                "&limit=1"
            );


        if (!photosResponse.ok) {
            return null;
        }


        const photosData =
            await photosResponse.json();


        const photos =
            photosData?.result?.photos;


        if (
            !Array.isArray(photos) ||
            !photos.length ||
            !Array.isArray(photos[0]) ||
            !photos[0].length
        ) {
            return null;
        }


        const variants =
            photos[0];


        const largest =
            variants[
                variants.length - 1
            ];


        if (!largest?.file_id) {
            return null;
        }


        const fileResponse =
            await fetch(
                "https://api.telegram.org/bot" +
                env.TELEGRAM_BOT_TOKEN +
                "/getFile?file_id=" +
                encodeURIComponent(
                    largest.file_id
                )
            );


        if (!fileResponse.ok) {
            return null;
        }


        const fileData =
            await fileResponse.json();


        const filePath =
            fileData?.result?.file_path;


        if (!filePath) {
            return null;
        }


        return fetch(
            "https://api.telegram.org/file/bot" +
            env.TELEGRAM_BOT_TOKEN +
            "/" +
            filePath
        );

    } catch (error) {

        console.error(
            "Telegram avatar fetch error:",
            error
        );

        return null;
    }
}


async function syncTelegramAvatar(
    env,
    userId,
    telegramId,
    photoUrl
) {

    try {

        if (
            !env.DB ||
            !env.FILES
        ) {
            return;
        }


        await ensureAvatarInfrastructure(
            env.DB
        );


        const response =
            await fetchTelegramAvatar(
                env,
                telegramId,
                photoUrl
            );


        if (
            !response ||
            !response.ok
        ) {
            return;
        }


        const contentType =
            String(
                response.headers.get(
                    "content-type"
                ) ||
                "image/jpeg"
            )
            .split(";")[0]
            .trim()
            .toLowerCase();


        if (
            !contentType.startsWith(
                "image/"
            )
        ) {
            return;
        }


        const bytes =
            await response.arrayBuffer();


        if (
            bytes.byteLength >
            5 * 1024 * 1024
        ) {
            return;
        }


        const key =
            `avatars/${userId}/telegram`;


        await env.FILES.put(
            key,
            bytes,
            {
                httpMetadata: {
                    contentType
                }
            }
        );


        await run(
            env.DB,
            `
            UPDATE users
            SET
                avatar_key = ?,
                avatar_source =
                    'telegram',
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [
                key,
                userId
            ]
        );

    } catch (error) {

        /*
         * Ошибка фотографии не должна
         * мешать самому входу.
         */

        console.error(
            "Telegram avatar sync error:",
            error
        );
    }
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
async function handleLinkLogin(request, env) {
    const auth =
        await requireUser(request, env);

    if (!auth.ok) {
        return authError(auth, env);
    }

    try {
        await ensureRecoveryInfrastructure(
            env.DB
        );

        const telegramId =
            Number(auth.user.telegram_id);

        if (
            !Number.isSafeInteger(telegramId) ||
            telegramId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Этот аккаунт не является Telegram-аккаунтом"
                },
                400,
                env
            );
        }

        if (auth.user.login) {
            return json(
                {
                    ok: false,
                    error:
                        "Логин уже привязан к этому аккаунту"
                },
                409,
                env
            );
        }

        const body =
            await readJson(request);

        const login =
            normalizeLogin(body?.login);

        const password =
            String(body?.password || "");

        const passwordConfirm =
            String(
                body?.password_confirm || ""
            );

        if (!login) {
            return json(
                {
                    ok: false,
                    error: "Введите логин"
                },
                400,
                env
            );
        }

        if (!isValidLogin(login)) {
            return json(
                {
                    ok: false,
                    error:
                        "Логин должен содержать 3–30 символов: буквы, цифры, _ или -"
                },
                400,
                env
            );
        }

        if (password.length < 8) {
            return json(
                {
                    ok: false,
                    error:
                        "Пароль должен содержать минимум 8 символов"
                },
                400,
                env
            );
        }

        if (password !== passwordConfirm) {
            return json(
                {
                    ok: false,
                    error:
                        "Пароли не совпадают"
                },
                400,
                env
            );
        }

        const existing =
            await first(
                env.DB,
                `
                SELECT id
                FROM users
                WHERE login = ?
                  AND id != ?
                LIMIT 1
                `,
                [
                    login,
                    auth.user.id
                ]
            );

        if (existing) {
            return json(
                {
                    ok: false,
                    error:
                        "Этот логин уже занят"
                },
                409,
                env
            );
        }

        const passwordHash =
            await hashPassword(password);

        await run(
            env.DB,
            `
            UPDATE users
            SET
                login = ?,
                password_hash = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [
                login,
                passwordHash,
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
            "Link login error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось привязать логин"
            },
            500,
            env
        );
    }
}

async function handleAdminUserSearch(
    request,
    env
) {
    const auth =
        await requireAccountRecoveryAdmin(
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
        await ensureRecoveryInfrastructure(
            env.DB
        );

        const url =
            new URL(request.url);

        const query =
            cleanText(
                url.searchParams.get("q")
            )
                .slice(0, 100);

        if (!query) {
            return json(
                {
                    ok: true,
                    users: []
                },
                200,
                env
            );
        }

        const numeric =
            Number(query);

        const isNumber =
            Number.isSafeInteger(
                numeric
            );

        const like =
            `%${query}%`;

        const users =
            await all(
                env.DB,
                `
                SELECT
                    id,
                    account_id,
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    role,
                    status,
                    blocked_reason,
                    created_at,
                    updated_at,
                    login
                FROM users
                WHERE
                    ${
                        isNumber
                            ? "account_id = ? OR id = ? OR telegram_id = ? OR"
                            : ""
                    }
                    COALESCE(login, '') LIKE ?
                    OR COALESCE(username, '') LIKE ?
                    OR COALESCE(first_name, '') LIKE ?
                    OR COALESCE(last_name, '') LIKE ?
                    OR CAST(telegram_id AS TEXT) LIKE ?
                ORDER BY id DESC
                LIMIT 50
                `,
                isNumber
                    ? [
                        numeric,
                        numeric,
                        numeric,
                        like,
                        like,
                        like,
                        like,
                        like
                    ]
                    : [
                        like,
                        like,
                        like,
                        like,
                        like
                    ]
            );

        return json(
            {
                ok: true,
                users
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "User search error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось найти пользователей"
            },
            500,
            env
        );
    }
}


async function handleAdminRecoverTelegram(
    request,
    env,
    targetUserId
) {
    const auth =
        await requireAccountRecoveryAdmin(
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
        await ensureRecoveryInfrastructure(
            env.DB
        );

        if (
            !Number.isSafeInteger(
                targetUserId
            ) ||
            targetUserId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Неверный ID пользователя"
                },
                400,
                env
            );
        }

        const body =
            await readJson(request);

        const newTelegramId =
            Number(
                body?.new_telegram_id
            );

        const reason =
            cleanText(
                body?.reason
            );

        const confirmed =
            body?.confirmed === true;

        if (!confirmed) {
            return json(
                {
                    ok: false,
                    error:
                        "Сначала подтвердите личность пользователя"
                },
                400,
                env
            );
        }

        if (
            reason.length < 5
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Укажите причину восстановления"
                },
                400,
                env
            );
        }

        if (
            !Number.isSafeInteger(
                newTelegramId
            ) ||
            newTelegramId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите корректный новый Telegram ID"
                },
                400,
                env
            );
        }

        const target =
            await first(
                env.DB,
                `
                SELECT *
                FROM users
                WHERE id = ?
                LIMIT 1
                `,
                [targetUserId]
            );

        if (!target) {
            return json(
                {
                    ok: false,
                    error:
                        "Пользователь не найден"
                },
                404,
                env
            );
        }

        if (
            Number(
                target.telegram_id
            ) ===
            newTelegramId
        ) {
            return json(
                {
                    ok: true,
                    user:
                        publicUser(
                            target
                        ),
                    already_linked:
                        true
                },
                200,
                env
            );
        }

        /*
         * Проверяем, не успел ли
         * новый Telegram создать
         * отдельный аккаунт RAUDA ILM.
         */
        const occupied =
            await first(
                env.DB,
                `
                SELECT *
                FROM users
                WHERE telegram_id = ?
                LIMIT 1
                `,
                [newTelegramId]
            );

        let detachedUserId =
            null;

        let technicalTelegramId =
            null;

        if (
            occupied &&
            Number(occupied.id) !==
                Number(target.id)
        ) {
            /*
             * Автоматически отсоединяем
             * только пустой Telegram-аккаунт.
             *
             * Если там уже есть прогресс,
             * покупки, логин и т.д. —
             * ничего не уничтожаем.
             */
            if (
                occupied.login ||
                String(
                    occupied.role ||
                    "student"
                ) !== "student"
            ) {
                return json(
                    {
                        ok: false,
                        error:
                            "Новый Telegram уже привязан к другому непустому аккаунту",
                        occupied_user_id:
                            occupied.id
                    },
                    409,
                    env
                );
            }

            const conflicts =
                await recoveryUserData(
                    env.DB,
                    occupied.id
                );

            if (conflicts.length) {
                return json(
                    {
                        ok: false,
                        error:
                            "На новом аккаунте уже есть данные. Автоматическое объединение остановлено, чтобы ничего не потерять.",
                        occupied_user_id:
                            occupied.id,
                        conflicts
                    },
                    409,
                    env
                );
            }

            detachedUserId =
                Number(
                    occupied.id
                );

            technicalTelegramId =
                await generateTechnicalTelegramId(
                    env.DB
                );
        }

        const oldTelegramId =
            Number(
                target.telegram_id
            );

        const statements = [];

        /*
         * Если новый TG уже создал
         * пустую учётную запись,
         * оставляем запись в базе,
         * но отсоединяем Telegram.
         */
        if (detachedUserId) {
            statements.push(
                env.DB
                    .prepare(
                        `
                        UPDATE users
                        SET
                            telegram_id = ?,
                            status = 'restricted',
                            blocked_reason = ?,
                            blocked_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        `
                    )
                    .bind(
                        technicalTelegramId,
                        `Аккаунт объединён с #${targetUserId}`,
                        detachedUserId
                    )
            );

            statements.push(
                env.DB
                    .prepare(
                        `
                        DELETE FROM auth_sessions
                        WHERE user_id = ?
                        `
                    )
                    .bind(
                        detachedUserId
                    )
            );
        }

        /*
         * Главное:
         * меняем Telegram именно
         * у СТАРОГО users.id.
         *
         * Поэтому весь прогресс
         * остаётся на месте.
         */
        statements.push(
            env.DB
                .prepare(
                    `
                    UPDATE users
                    SET
                        telegram_id = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    `
                )
                .bind(
                    newTelegramId,
                    targetUserId
                )
        );

        /*
         * Завершаем все старые сессии.
         */
        statements.push(
            env.DB
                .prepare(
                    `
                    DELETE FROM auth_sessions
                    WHERE user_id = ?
                    `
                )
                .bind(
                    targetUserId
                )
        );

        const auditDetails =
            JSON.stringify({
                reason,
                identity_confirmed:
                    true,
                old_telegram_id:
                    oldTelegramId,
                new_telegram_id:
                    newTelegramId,
                detached_user_id:
                    detachedUserId
            });

        statements.push(
            env.DB
                .prepare(
                    `
                    INSERT INTO audit_logs (
                        admin_id,
                        action,
                        entity_type,
                        entity_id,
                        details
                    )
                    VALUES (?, ?, ?, ?, ?)
                    `
                )
                .bind(
                    auth.user.id,
                    "account_recovery_telegram",
                    "user",
                    targetUserId,
                    auditDetails
                )
        );

        /*
         * D1 batch выполняет связанные
         * изменения одной группой.
         */
        await env.DB.batch(
            statements
        );

        const user =
            await getUserById(
                env.DB,
                targetUserId
            );

        return json(
            {
                ok: true,
                user,
                sessions_revoked:
                    true,
                detached_user_id:
                    detachedUserId
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Telegram recovery error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось восстановить Telegram-доступ"
            },
            500,
            env
        );
    }
}

async function handleLogout(
    request,
    env
) {
    if (!env.DB) {
        return databaseMissing(env);
    }

    await ensureAuthSessionsTable(
        env.DB
    );

    const token =
        getSessionToken(request);

    if (token) {
        await run(
            env.DB,
            `
            DELETE FROM auth_sessions
            WHERE token = ?
            `,
            [token]
        );
    }

    const headers =
        new Headers(
            corsHeaders(env)
        );

    headers.set(
        "Content-Type",
        "application/json; charset=utf-8"
    );

    headers.append(
        "Set-Cookie",
        expiredSessionCookie()
    );

    headers.set(
        "Cache-Control",
        "no-store"
    );

    return new Response(
        JSON.stringify({
            ok: true
        }),
        {
            status: 200,
            headers
        }
    );
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
    const auth =
        await requireUser(request, env);

    if (!auth.ok) {
        return authError(auth, env);
    }

    try {
        await ensureLessonProgressTable(
            env.DB
        );

        const courses =
            await listContentRows(
                env.DB,
                "courses",
                new URL(request.url)
                    .searchParams,
                auth.user
            );

        const coursesWithProgress =
            await Promise.all(
                courses.map(
                    async course => {

                        const params =
                            new URLSearchParams();

                        params.set(
                            "course_id",
                            String(course.id)
                        );

                        const lessons =
                            await listContentRows(
                                env.DB,
                                "lessons",
                                params,
                                auth.user
                            );

                        if (!lessons.length) {
                            return {
                                ...course,
                                total_lessons: 0,
                                completed_lessons: 0,
                                progress_percent: 0
                            };
                        }

                        const progresses =
                            await Promise.all(
                                lessons.map(
                                    async lesson => {

                                        const row =
                                            await first(
                                                env.DB,
                                                `
                                                SELECT
                                                    progress_percent,
                                                    is_completed
                                                FROM lesson_progress
                                                WHERE
                                                    user_id = ?
                                                    AND lesson_id = ?
                                                LIMIT 1
                                                `,
                                                [
                                                    auth.user.id,
                                                    lesson.id
                                                ]
                                            );

                                        const percent =
                                            clampProgress(
                                                row
                                                    ?.progress_percent ??
                                                (
                                                    row
                                                        ?.is_completed
                                                        ? 100
                                                        : 0
                                                )
                                            );

                                        return {
                                            percent,
                                            completed:
                                                Number(
                                                    row
                                                        ?.is_completed
                                                ) === 1 ||
                                                percent >= 100
                                        };
                                    }
                                )
                            );

                        const sum =
                            progresses.reduce(
                                (
                                    total,
                                    item
                                ) =>
                                    total +
                                    item.percent,
                                0
                            );

                        const completed =
                            progresses.filter(
                                item =>
                                    item.completed
                            ).length;

                        return {
                            ...course,

                            total_lessons:
                                lessons.length,

                            completed_lessons:
                                completed,

                            progress_percent:
                                Math.round(
                                    sum /
                                    lessons.length
                                )
                        };
                    }
                )
            );

        return json(
            {
                ok: true,
                courses:
                    coursesWithProgress
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Courses error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось получить курсы"
            },
            500,
            env
        );
    }
}

async function handleLessons(request, env) {

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

        await ensureLessonProgressTable(
            env.DB
        );


        const lessons =
            await listContentRows(
                env.DB,
                "lessons",
                new URL(request.url)
                    .searchParams,
                auth.user
            );


        const lessonsWithProgress =
            await Promise.all(

                lessons.map(

                    async lesson => {

                        /* =========================
                           ПРОГРЕСС
                           ========================= */

                        const progress =
                            await first(
                                env.DB,
                                `
                                SELECT
                                    progress_percent,
                                    is_completed
                                FROM lesson_progress
                                WHERE
                                    user_id = ?
                                    AND lesson_id = ?
                                LIMIT 1
                                `,
                                [
                                    auth.user.id,
                                    lesson.id
                                ]
                            );


                        const percent =
                            clampProgress(
                                progress
                                    ?.progress_percent ??
                                (
                                    progress
                                        ?.is_completed
                                        ? 100
                                        : 0
                                )
                            );


                        const completed =
                            Number(
                                progress
                                    ?.is_completed
                            ) === 1 ||
                            percent >= 100;


                        /* =========================
                           ФАЙЛЫ УРОКА
                           ========================= */

                        let files = [];

                        try {

                            const filesResult =
                                await env.DB
                                    .prepare(
                                        `
                                        SELECT *
                                        FROM lesson_files
                                        WHERE lesson_id = ?
                                        ORDER BY id ASC
                                        `
                                    )
                                    .bind(
                                        lesson.id
                                    )
                                    .all();


                            files =
                                filesResult
                                    ?.results ||
                                [];

                        } catch (fileError) {

                            console.error(
                                "Lesson files error:",
                                lesson.id,
                                fileError
                            );
                        }


                        /* =========================
                           ОТВЕТ
                           ========================= */

                        return {

                            ...lesson,

                            progress_percent:
                                percent,

                            is_completed:
                                completed,

                            files
                        };
                    }
                )
            );


        const completedLessonIds =
            lessonsWithProgress
                .filter(
                    lesson =>
                        lesson.is_completed
                )
                .map(
                    lesson =>
                        Number(
                            lesson.id
                        )
                );


        return json(
            {
                ok: true,

                lessons:
                    lessonsWithProgress,

                completedLessonIds
            },
            200,
            env
        );


    } catch (error) {

        console.error(
            "Lessons error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Не удалось получить уроки"
            },
            500,
            env
        );
    }
}

async function handleOwnerAdminPermissions(
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

    const currentRole =
        String(
            auth.user?.role || ""
        ).toLowerCase();

    if (currentRole !== "owner") {
        return json(
            {
                ok: false,
                error:
                    "Только владелец может изменять права администраторов"
            },
            403,
            env
        );
    }

    try {
        let userId;

        if (request.method === "GET") {
            const url =
                new URL(
                    request.url
                );

            userId =
                positiveIntegerOrNull(
                    url.searchParams.get(
                        "user_id"
                    )
                );
        } else {
            const body =
                await readJson(
                    request
                );

            userId =
                positiveIntegerOrNull(
                    body?.user_id
                );

            const permissions =
                Array.isArray(
                    body?.permissions
                )
                    ? body.permissions
                    : [];

            if (!userId) {
                return json(
                    {
                        ok: false,
                        error:
                            "Укажите user_id"
                    },
                    400,
                    env
                );
            }

            const target =
                await first(
                    env.DB,
                    `
                    SELECT
                        id,
                        role
                    FROM users
                    WHERE id = ?
                    LIMIT 1
                    `,
                    [userId]
                );

            if (!target) {
                return json(
                    {
                        ok: false,
                        error:
                            "Пользователь не найден"
                    },
                    404,
                    env
                );
            }

            const targetRole =
                String(
                    target.role || ""
                ).toLowerCase();

            if (targetRole !== "admin") {
                return json(
                    {
                        ok: false,
                        error:
                            "Отдельные права можно назначать только обычному администратору"
                    },
                    400,
                    env
                );
            }

            const cleanPermissions =
                [
                    ...new Set(
                        permissions
                            .map(
                                permission =>
                                    String(
                                        permission || ""
                                    ).trim()
                            )
                            .filter(
                                permission =>
                                    ADMIN_PERMISSION_KEYS.has(
                                        permission
                                    )
                            )
                    )
                ];

            await run(
                env.DB,
                `
                DELETE FROM admin_permissions
                WHERE admin_id = ?
                `,
                [userId]
            );

            for (
                const permission
                of cleanPermissions
            ) {
                await run(
                    env.DB,
                    `
                    INSERT OR IGNORE INTO admin_permissions
                        (
                            admin_id,
                            permission
                        )
                    VALUES (?, ?)
                    `,
                    [
                        userId,
                        permission
                    ]
                );
            }
        }

        if (!userId) {
            return json(
                {
                    ok: false,
                    error:
                        "Укажите user_id"
                },
                400,
                env
            );
        }

        const rows =
            await all(
                env.DB,
                `
                SELECT permission
                FROM admin_permissions
                WHERE admin_id = ?
                ORDER BY permission
                `,
                [userId]
            );

        return json(
            {
                ok: true,
                user_id: userId,
                permissions:
                    rows.map(
                        row =>
                            row.permission
                    )
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Admin permissions:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось сохранить права администратора"
            },
            500,
            env
        );
    }
}

async function handleOwnerChangeUserRole(
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

    const currentRole =
        String(
            auth.user?.role || ""
        ).toLowerCase();

    if (currentRole !== "owner") {
        return json(
            {
                ok: false,
                error:
                    "Только владелец может изменять роли пользователей"
            },
            403,
            env
        );
    }

    try {
        const body =
            await readJson(request);

        const userId =
            positiveIntegerOrNull(
                body?.user_id
            );

        const newRole =
            String(
                body?.role || ""
            )
                .trim()
                .toLowerCase();

        if (!userId) {
            return json(
                {
                    ok: false,
                    error:
                        "Укажите user_id"
                },
                400,
                env
            );
        }

        const allowedRoles =
            new Set([
                "student",
                "admin",
                "superadmin"
            ]);

        if (
            !allowedRoles.has(
                newRole
            )
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Недопустимая роль"
                },
                400,
                env
            );
        }

        /*
         * Не даём владельцу случайно
         * лишить самого себя доступа.
         */
        if (
            Number(auth.user.id) ===
            Number(userId)
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Нельзя изменить роль своей учётной записи владельца"
                },
                400,
                env
            );
        }

        const targetUser =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    role
                FROM users
                WHERE id = ?
                LIMIT 1
                `,
                [
                    userId
                ]
            );

        if (!targetUser) {
            return json(
                {
                    ok: false,
                    error:
                        "Пользователь не найден"
                },
                404,
                env
            );
        }

        if (
            String(
                targetUser.role || ""
            ).toLowerCase() ===
            "owner"
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Нельзя изменить роль владельца"
                },
                403,
                env
            );
        }

        await run(
            env.DB,
            `
            UPDATE users
            SET role = ?
            WHERE id = ?
            `,
            [
                newRole,
                userId
            ]
        );

        const user =
            await getUserById(
                env.DB,
                userId
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
            "Change user role:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить роль пользователя"
            },
            500,
            env
        );
    }
}

async function handleOwnerChangeAdminPassword(request, env) {

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

    if (auth.user.role !== "owner") {
        return json(
            {
                ok: false,
                error: "Только владелец может менять пароли администраторов"
            },
            403,
            env
        );
    }

    let body;

    try {
        body = await request.json();
    } catch {
        return json(
            {
                ok: false,
                error: "Некорректные данные"
            },
            400,
            env
        );
    }

    const userId =
        Number(body.user_id);

    const newPassword =
        String(
            body.new_password || ""
        );

    if (
        !Number.isInteger(userId) ||
        userId <= 0
    ) {
        return json(
            {
                ok: false,
                error: "Некорректный ID администратора"
            },
            400,
            env
        );
    }

    if (newPassword.length < 8) {
        return json(
            {
                ok: false,
                error: "Пароль должен содержать минимум 8 символов"
            },
            400,
            env
        );
    }

    const targetUser =
        await first(
            env.DB,
            `
            SELECT
                id,
                login,
                role
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [userId]
        );

    if (!targetUser) {
        return json(
            {
                ok: false,
                error: "Администратор не найден"
            },
            404,
            env
        );
    }

    if (
        ![
            "admin",
            "superadmin"
        ].includes(targetUser.role)
    ) {
        return json(
            {
                ok: false,
                error: "Можно менять пароль только администраторам"
            },
            403,
            env
        );
    }

    const passwordHash =
        await hashPassword(
            newPassword
        );

    await env.DB
        .prepare(
            `
            UPDATE users
            SET
                password_hash = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
        )
        .bind(
            passwordHash,
            userId
        )
        .run();

    return json(
        {
            ok: true,
            message: "Пароль администратора изменён"
        },
        200,
        env
    );
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

async function handleAdminCreateProgram(
    request,
    env
) {

    const auth =
        await requireAdmin(
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

        const name =
            cleanText(
                body?.name
            );

        const description =
            cleanText(
                body?.description
            );

        if (!name) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите название программы"
                },
                400,
                env
            );
        }

        const columns =
            await tableColumns(
                env.DB,
                "programs"
            );

        const fields = [];
        const values = [];

        const add = (
            choices,
            value
        ) => {

            const column =
                firstColumn(
                    columns,
                    choices
                );

            if (column) {
                fields.push(
                    column
                );

                values.push(
                    value
                );
            }
        };

        add(
            ["name", "title"],
            name
        );

        add(
            [
                "description",
                "summary"
            ],
            description || null
        );

        add(
            [
                "is_visible",
                "visible",
                "is_active"
            ],
            1
        );

        const result =
            await run(
                env.DB,
                `
                INSERT INTO programs (
                    ${fields
                        .map(
                            quoteIdentifier
                        )
                        .join(", ")}
                )
                VALUES (
                    ${fields
                        .map(() => "?")
                        .join(", ")}
                )
                `,
                values
            );

        const program =
            await first(
                env.DB,
                `
                SELECT *
                FROM programs
                WHERE id = ?
                LIMIT 1
                `,
                [
                    Number(
                        result.meta
                            .last_row_id
                    )
                ]
            );

        return json(
            {
                ok: true,
                program
            },
            201,
            env
        );

    } catch (error) {

        console.error(
            "Create program:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось создать программу"
            },
            500,
            env
        );
    }
}


async function handleAdminCreateCourse(
    request,
    env
) {

    const auth =
        await requireAdmin(
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

        const name =
            cleanText(
                body?.name
            );

        const description =
            cleanText(
                body?.description
            );

        const programId =
            positiveIntegerOrNull(
                body?.program_id
            );

        if (!name) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите название курса"
                },
                400,
                env
            );
        }

        if (!programId) {
            return json(
                {
                    ok: false,
                    error:
                        "Выберите программу"
                },
                400,
                env
            );
        }

        const program =
            await first(
                env.DB,
                `
                SELECT id
                FROM programs
                WHERE id = ?
                LIMIT 1
                `,
                [
                    programId
                ]
            );

        if (!program) {
            return json(
                {
                    ok: false,
                    error:
                        "Программа не найдена"
                },
                404,
                env
            );
        }

        const columns =
            await tableColumns(
                env.DB,
                "courses"
            );

        const fields = [];
        const values = [];

        const add = (
            choices,
            value
        ) => {

            const column =
                firstColumn(
                    columns,
                    choices
                );

            if (column) {
                fields.push(
                    column
                );

                values.push(
                    value
                );
            }
        };

        add(
            ["program_id"],
            programId
        );

        add(
            ["name", "title"],
            name
        );

        add(
            [
                "description",
                "summary"
            ],
            description || null
        );

        add(
            [
                "is_visible",
                "visible",
                "is_active"
            ],
            1
        );

        const result =
            await run(
                env.DB,
                `
                INSERT INTO courses (
                    ${fields
                        .map(
                            quoteIdentifier
                        )
                        .join(", ")}
                )
                VALUES (
                    ${fields
                        .map(() => "?")
                        .join(", ")}
                )
                `,
                values
            );

        const course =
            await first(
                env.DB,
                `
                SELECT *
                FROM courses
                WHERE id = ?
                LIMIT 1
                `,
                [
                    Number(
                        result.meta
                            .last_row_id
                    )
                ]
            );

        return json(
            {
                ok: true,
                course
            },
            201,
            env
        );

    } catch (error) {

        console.error(
            "Create course:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось создать курс"
            },
            500,
            env
        );
    }
}


async function handleAdminUpdateProgram(
    request,
    env,
    programId
) {

    const auth =
        await requireAdmin(
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

        if (
            !Number.isInteger(
                programId
            ) ||
            programId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Некорректный ID программы"
                },
                400,
                env
            );
        }

        const body =
            await readJson(
                request
            );

        const name =
            cleanText(
                body?.name
            );

        const description =
            cleanText(
                body?.description
            );

        if (!name) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите название программы"
                },
                400,
                env
            );
        }

        const columns =
            await tableColumns(
                env.DB,
                "programs"
            );

        const nameColumn =
            firstColumn(
                columns,
                ["name", "title"]
            );

        const descriptionColumn =
            firstColumn(
                columns,
                [
                    "description",
                    "summary"
                ]
            );

        const updates = [];
        const values = [];

        if (nameColumn) {
            updates.push(
                `${quoteIdentifier(
                    nameColumn
                )} = ?`
            );

            values.push(
                name
            );
        }

        if (descriptionColumn) {
            updates.push(
                `${quoteIdentifier(
                    descriptionColumn
                )} = ?`
            );

            values.push(
                description || null
            );
        }

        if (!updates.length) {
            return json(
                {
                    ok: false,
                    error:
                        "Нет доступных полей для изменения"
                },
                500,
                env
            );
        }

        values.push(
            programId
        );

        await run(
            env.DB,
            `
            UPDATE programs
            SET
                ${updates.join(", ")}
            WHERE id = ?
            `,
            values
        );

        const program =
            await first(
                env.DB,
                `
                SELECT *
                FROM programs
                WHERE id = ?
                LIMIT 1
                `,
                [
                    programId
                ]
            );

        return json(
            {
                ok: true,
                program
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Update program:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить программу"
            },
            500,
            env
        );
    }
}

async function handleAdminUpdateSemester(
    request,
    env,
    semesterId
) {
    if (!env.DB) {
        return databaseMissing(env);
    }

    const auth =
        await requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return authError(
            auth,
            env
        );
    }

    if (
    String(auth.user?.role || "")
        .toLowerCase() !== "owner"
) {
    return json(
        {
            ok: false,
            error: "Доступно только владельцу"
        },
        403,
        env
    );
}
    
    try {
        const body =
            await readJson(request);

        const semester =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    price_rub,
                    access_months,
                    payment_enabled
                FROM semesters
                WHERE id = ?
                LIMIT 1
                `,
                [semesterId]
            );

        if (!semester) {
            return json(
                {
                    ok: false,
                    error: "Семестр не найден"
                },
                404,
                env
            );
        }

        const priceRub =
            Number(body?.price_rub);

        const accessMonths =
            Number(body?.access_months);

        const paymentEnabled =
            body?.payment_enabled === false ||
            body?.payment_enabled === 0 ||
            body?.payment_enabled === "0"
                ? 0
                : 1;

        if (
            !Number.isInteger(priceRub) ||
            priceRub < 0 ||
            priceRub > 1000000
        ) {
            return json(
                {
                    ok: false,
                    error: "Укажите правильную цену"
                },
                400,
                env
            );
        }

        if (
            !Number.isInteger(accessMonths) ||
            accessMonths < 1 ||
            accessMonths > 36
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Срок доступа должен быть от 1 до 36 месяцев"
                },
                400,
                env
            );
        }

        await run(
            env.DB,
            `
            UPDATE semesters
            SET
                price_rub = ?,
                access_months = ?,
                payment_enabled = ?
            WHERE id = ?
            `,
            [
                priceRub,
                accessMonths,
                paymentEnabled,
                semesterId
            ]
        );

        const updated =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    course_id,
                    program_id,
                    number,
                    name,
                    price_rub,
                    access_months,
                    payment_enabled
                FROM semesters
                WHERE id = ?
                LIMIT 1
                `,
                [semesterId]
            );

        return json(
            {
                ok: true,
                semester: updated
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Update semester error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить настройки семестра"
            },
            500,
            env
        );
    }
}

async function handleAdminGetSemesters(
    request,
    env
) {
    if (!env.DB) {
        return databaseMissing(env);
    }

    const auth =
        await requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return authError(
            auth,
            env
        );
    }

    if (
    String(auth.user?.role || "")
        .toLowerCase() !== "owner"
) {
    return json(
        {
            ok: false,
            error: "Доступно только владельцу"
        },
        403,
        env
    );
}
    
    try {
        const result =
            await env.DB
                .prepare(`
                    SELECT
                        s.id,
                        s.course_id,
                        s.program_id,
                        s.number,
                        s.name,
                        s.description,
                        s.price_rub,
                        s.access_months,
                        s.payment_enabled,
                        s.is_active,
                        p.name AS program_name,
                        c.name AS course_name
                    FROM semesters s

                    LEFT JOIN programs p
                        ON p.id = s.program_id

                    LEFT JOIN courses c
                        ON c.id = s.course_id

                    ORDER BY
                        s.program_id ASC,
                        s.number ASC
                `)
                .all();

        return json(
            {
                ok: true,
                semesters:
                    Array.isArray(result?.results)
                        ? result.results
                        : []
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Get semesters error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось загрузить семестры"
            },
            500,
            env
        );
    }
}

async function handleAdminUpdateCourse(
    request,
    env,
    courseId
) {

    const auth =
        await requireAdmin(
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

        const name =
            cleanText(
                body?.name
            );

        const description =
            cleanText(
                body?.description
            );

        const programId =
            positiveIntegerOrNull(
                body?.program_id
            );

        if (!name) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите название курса"
                },
                400,
                env
            );
        }

        if (!programId) {
            return json(
                {
                    ok: false,
                    error:
                        "Выберите программу"
                },
                400,
                env
            );
        }

        const columns =
            await tableColumns(
                env.DB,
                "courses"
            );

        const nameColumn =
            firstColumn(
                columns,
                ["name", "title"]
            );

        const descriptionColumn =
            firstColumn(
                columns,
                [
                    "description",
                    "summary"
                ]
            );

        const updates = [
            "program_id = ?"
        ];

        const values = [
            programId
        ];

        if (nameColumn) {
            updates.push(
                `${quoteIdentifier(
                    nameColumn
                )} = ?`
            );

            values.push(
                name
            );
        }

        if (descriptionColumn) {
            updates.push(
                `${quoteIdentifier(
                    descriptionColumn
                )} = ?`
            );

            values.push(
                description || null
            );
        }

        values.push(
            courseId
        );

        await run(
            env.DB,
            `
            UPDATE courses
            SET
                ${updates.join(", ")}
            WHERE id = ?
            `,
            values
        );

        const course =
            await first(
                env.DB,
                `
                SELECT *
                FROM courses
                WHERE id = ?
                LIMIT 1
                `,
                [
                    courseId
                ]
            );

        return json(
            {
                ok: true,
                course
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Update course:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить курс"
            },
            500,
            env
        );
    }
}


async function handleAdminDeleteProgram(
    request,
    env,
    programId
) {

    const auth =
        await requireAdmin(
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

        const courses =
            await first(
                env.DB,
                `
                SELECT COUNT(*) AS count
                FROM courses
                WHERE program_id = ?
                `,
                [
                    programId
                ]
            );

        if (
            Number(
                courses?.count || 0
            ) > 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Сначала удалите или перенесите курсы этой программы"
                },
                409,
                env
            );
        }

        await run(
            env.DB,
            `
            DELETE FROM programs
            WHERE id = ?
            `,
            [
                programId
            ]
        );

        return json(
            {
                ok: true
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Delete program:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось удалить программу"
            },
            500,
            env
        );
    }
}


async function handleAdminDeleteCourse(
    request,
    env,
    courseId
) {

    const auth =
        await requireAdmin(
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

        const lessons =
            await first(
                env.DB,
                `
                SELECT COUNT(*) AS count
                FROM lessons
                WHERE course_id = ?
                `,
                [
                    courseId
                ]
            );

        if (
            Number(
                lessons?.count || 0
            ) > 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Сначала удалите или перенесите уроки этого курса"
                },
                409,
                env
            );
        }

        await run(
            env.DB,
            `
            DELETE FROM courses
            WHERE id = ?
            `,
            [
                courseId
            ]
        );

        return json(
            {
                ok: true
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Delete course:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось удалить курс"
            },
            500,
            env
        );
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

async function handleAdminUpdateLesson(
    request,
    env,
    lessonId
) {

    const auth =
        await requireAdmin(
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

        if (
            !Number.isInteger(lessonId) ||
            lessonId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Некорректный ID урока"
                },
                400,
                env
            );
        }

        const existing =
            await first(
                env.DB,
                `
                SELECT id
                FROM lessons
                WHERE id = ?
                LIMIT 1
                `,
                [lessonId]
            );

        if (!existing) {
            return json(
                {
                    ok: false,
                    error:
                        "Урок не найден"
                },
                404,
                env
            );
        }

        const body =
            await readJson(
                request
            );

        const title =
            cleanText(
                body?.title
            );

        if (!title) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите название урока"
                },
                400,
                env
            );
        }

        const courseId =
            positiveIntegerOrNull(
                body?.course_id
            );

        let programId =
            positiveIntegerOrNull(
                body?.program_id
            );

        const semesterId =
            positiveIntegerOrNull(
                body?.semester_id
            );

        const subjectId =
            positiveIntegerOrNull(
                body?.subject_id
            );

        if (
            courseId &&
            !programId
        ) {

            const course =
                await first(
                    env.DB,
                    `
                    SELECT program_id
                    FROM courses
                    WHERE id = ?
                    LIMIT 1
                    `,
                    [courseId]
                );

            programId =
                positiveIntegerOrNull(
                    course?.program_id
                );
        }

        const columns =
            await tableColumns(
                env.DB,
                "lessons"
            );

        const updates = [];
        const values = [];

        const add = (
            choices,
            value
        ) => {

            const column =
                firstColumn(
                    columns,
                    choices
                );

            if (column) {

                updates.push(
                    `${quoteIdentifier(
                        column
                    )} = ?`
                );

                values.push(
                    value
                );
            }
        };

        add(
            ["course_id"],
            courseId
        );

        add(
            ["program_id"],
            programId
        );

        add(
            ["semester_id"],
            semesterId
        );

        add(
            ["subject_id"],
            subjectId
        );

        add(
            ["title", "name"],
            title
        );

        add(
            [
                "description",
                "summary"
            ],
            cleanText(
                body?.description
            ) || null
        );

        add(
            [
                "content",
                "body",
                "text"
            ],
            cleanText(
                body?.content
            ) || null
        );

        add(
            [
                "lesson_number",
                "number"
            ],
            nonNegativeNumber(
                body?.lesson_number
            )
        );

        add(
            [
                "sort_order",
                "position",
                "order_index"
            ],
            nonNegativeNumber(
                body?.sort_order
            )
        );

        add(
            [
                "is_visible",
                "visible",
                "is_published",
                "published"
            ],
            body?.is_visible === false ||
            body?.is_visible === 0 ||
            body?.is_visible === "0"
                ? 0
                : 1
        );

        if (!updates.length) {
            return json(
                {
                    ok: false,
                    error:
                        "Нет полей для изменения"
                },
                500,
                env
            );
        }

        values.push(
            lessonId
        );

        await run(
            env.DB,
            `
            UPDATE lessons
            SET
                ${updates.join(", ")},
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            values
        );

        const lesson =
            await first(
                env.DB,
                `
                SELECT *
                FROM lessons
                WHERE id = ?
                LIMIT 1
                `,
                [lessonId]
            );

        const files =
            await getLessonFiles(
                env.DB,
                lessonId
            );

        return json(
            {
                ok: true,
                lesson: {
                    ...lesson,
                    files
                }
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Update lesson:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить урок"
            },
            500,
            env
        );
    }
}


async function handleAdminDeleteLesson(
    request,
    env,
    lessonId
) {

    const auth =
        await requireAdmin(
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

        const lesson =
            await first(
                env.DB,
                `
                SELECT id
                FROM lessons
                WHERE id = ?
                LIMIT 1
                `,
                [lessonId]
            );

        if (!lesson) {
            return json(
                {
                    ok: false,
                    error:
                        "Урок не найден"
                },
                404,
                env
            );
        }

        const files =
            await getLessonFiles(
                env.DB,
                lessonId
            );

        if (env.FILES) {

            for (const file of files) {

                const key =
                    fileStorageKey(
                        file
                    );

                if (key) {
                    await env.FILES.delete(
                        key
                    );
                }
            }
        }

        await run(
            env.DB,
            `
            DELETE FROM lesson_files
            WHERE lesson_id = ?
            `,
            [lessonId]
        );

        await run(
            env.DB,
            `
            DELETE FROM lesson_progress
            WHERE lesson_id = ?
            `,
            [lessonId]
        );

        await run(
            env.DB,
            `
            DELETE FROM lessons
            WHERE id = ?
            `,
            [lessonId]
        );

        return json(
            {
                ok: true
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Delete lesson:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось удалить урок"
            },
            500,
            env
        );
    }
}

async function handleAdminStudentSearch(
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

    const allowedRoles =
        new Set([
            "owner",
            "superadmin",
            "admin"
        ]);

    if (
        !allowedRoles.has(
            String(
                auth.user.role ||
                ""
            ).toLowerCase()
        )
    ) {
        return json(
            {
                ok: false,
                error:
                    "Недостаточно прав"
            },
            403,
            env
        );
    }

    try {

        const url =
            new URL(
                request.url
            );

        const query =
            String(
                url.searchParams.get(
                    "q"
                ) || ""
            )
            .trim();


        if (
            query.length < 2
        ) {
            return json(
                {
                    ok: true,
                    students: []
                },
                200,
                env
            );
        }


        const like =
            "%" +
            query +
            "%";


        const numericQuery =
            Number(
                query
            );


        let rows;


        if (
            Number.isFinite(
                numericQuery
            )
        ) {

            rows =
                await all(
                    env.DB,
                    `
                    SELECT
                        id,
                        account_id,
                        login,
                        username,
                        first_name,
                        last_name,
                        email,
                        telegram_id,
                        role,
                        status
                    FROM users
                    WHERE
                        role = 'student'
                        AND
                        (
                            CAST(id AS TEXT)
                                LIKE ?
                            OR
                            CAST(account_id AS TEXT)
                                LIKE ?
                            OR
                            CAST(telegram_id AS TEXT)
                                LIKE ?
                            OR
                            login LIKE ?
                            OR
                            username LIKE ?
                            OR
                            first_name LIKE ?
                            OR
                            last_name LIKE ?
                            OR
                            email LIKE ?
                        )
                    ORDER BY
                        first_name,
                        last_name,
                        id
                    LIMIT 30
                    `,
                    [
                        like,
                        like,
                        like,
                        like,
                        like,
                        like,
                        like,
                        like
                    ]
                );

        } else {

            rows =
                await all(
                    env.DB,
                    `
                    SELECT
                        id,
                        account_id,
                        login,
                        username,
                        first_name,
                        last_name,
                        email,
                        telegram_id,
                        role,
                        status
                    FROM users
                    WHERE
                        role = 'student'
                        AND
                        (
                            login LIKE ?
                            OR
                            username LIKE ?
                            OR
                            first_name LIKE ?
                            OR
                            last_name LIKE ?
                            OR
                            email LIKE ?
                            OR
                            (
                                COALESCE(
                                    first_name,
                                    ''
                                )
                                ||
                                ' '
                                ||
                                COALESCE(
                                    last_name,
                                    ''
                                )
                            )
                            LIKE ?
                        )
                    ORDER BY
                        first_name,
                        last_name,
                        id
                    LIMIT 30
                    `,
                    [
                        like,
                        like,
                        like,
                        like,
                        like,
                        like
                    ]
                );
        }


        return json(
            {
                ok: true,
                students:
                    rows || []
            },
            200,
            env
        );


    } catch (error) {

        console.error(
            "Student search error:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось найти учеников"
            },
            500,
            env
        );
    }
}

async function handleAdminStudentGrades(
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

    const role =
        String(
            auth.user.role || ""
        ).toLowerCase();

    if (
        ![
            "owner",
            "superadmin",
            "admin"
        ].includes(role)
    ) {
        return json(
            {
                ok: false,
                error: "Недостаточно прав"
            },
            403,
            env
        );
    }

    try {

        const url =
            new URL(
                request.url
            );

        const userId =
            Number(
                url.searchParams.get(
                    "user_id"
                )
            );

        if (
            !Number.isInteger(userId) ||
            userId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error: "Некорректный ID ученика"
                },
                400,
                env
            );
        }

        const student =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    account_id,
                    login,
                    username,
                    first_name,
                    last_name,
                    email,
                    status
                FROM users
                WHERE
                    id = ?
                    AND role = 'student'
                LIMIT 1
                `,
                [
                    userId
                ]
            );

        if (!student) {
            return json(
                {
                    ok: false,
                    error: "Ученик не найден"
                },
                404,
                env
            );
        }

        const testAttempts =
            await all(
                env.DB,
                `
                SELECT
                    ta.id,
                    ta.test_id AS assessment_id,
                    ta.course_id,
                    ta.attempt_number,
                    ta.score,
                    ta.max_score,
                    ta.percentage,
                    ta.passed,
                    ta.submitted_at,

                    t.title,
                    t.passing_score,
                    t.attempts_allowed,

                    c.name AS course_name

                FROM test_attempts ta

                LEFT JOIN tests t
                    ON t.id = ta.test_id

                LEFT JOIN courses c
                    ON c.id = ta.course_id

                WHERE
                    ta.user_id = ?
                    AND ta.submitted_at IS NOT NULL

                ORDER BY
                    ta.submitted_at DESC,
                    ta.id DESC
                `,
                [
                    userId
                ]
            );

        const examAttempts =
            await all(
                env.DB,
                `
                SELECT
                    ea.id,
                    ea.exam_id AS assessment_id,
                    ea.course_id,
                    ea.attempt_number,
                    ea.score,
                    ea.max_score,
                    ea.percentage,
                    ea.passed,
                    ea.grade,
                    ea.submitted_at,

                    e.title,
                    e.passing_score,
                    e.attempts_allowed,

                    c.name AS course_name

                FROM exam_attempts ea

                LEFT JOIN exams e
                    ON e.id = ea.exam_id

                LEFT JOIN courses c
                    ON c.id = ea.course_id

                WHERE
                    ea.user_id = ?
                    AND ea.submitted_at IS NOT NULL

                ORDER BY
                    ea.submitted_at DESC,
                    ea.id DESC
                `,
                [
                    userId
                ]
            );

        const grades = [];

        for (
            const item of testAttempts || []
        ) {

            grades.push({
                type: "test",

                attempt_id:
                    Number(item.id),

                assessment_id:
                    Number(item.assessment_id),

                course_id:
                    Number(item.course_id),

                course_name:
                    item.course_name || "Курс",

                title:
                    item.title || "Тест",

                attempt_number:
                    Number(
                        item.attempt_number
                    ) || 1,

                score:
                    Number(item.score) || 0,

                max_score:
                    Number(item.max_score) || 100,

                percentage:
                    Number(item.percentage) || 0,

                passing_score:
                    Number(item.passing_score) || 60,

                attempts_allowed:
                    Number(item.attempts_allowed) || 1,

                passed:
                    Number(item.passed) === 1 ||
                    Number(item.percentage) >=
                    (
                        Number(item.passing_score) || 60
                    ),

                submitted_at:
                    item.submitted_at || null
            });
        }

        for (
            const item of examAttempts || []
        ) {

            grades.push({
                type: "exam",

                attempt_id:
                    Number(item.id),

                assessment_id:
                    Number(item.assessment_id),

                course_id:
                    Number(item.course_id),

                course_name:
                    item.course_name || "Курс",

                title:
                    item.title || "Экзамен",

                attempt_number:
                    Number(
                        item.attempt_number
                    ) || 1,

                score:
                    Number(item.score) || 0,

                max_score:
                    Number(item.max_score) || 100,

                percentage:
                    Number(item.percentage) || 0,

                passing_score:
                    Number(item.passing_score) || 60,

                attempts_allowed:
                    Number(item.attempts_allowed) || 1,

                passed:
                    Number(item.passed) === 1 ||
                    Number(item.percentage) >=
                    (
                        Number(item.passing_score) || 60
                    ),

                grade:
                    item.grade || null,

                submitted_at:
                    item.submitted_at || null
            });
        }

        grades.sort(
            (a, b) =>
                (
                    Date.parse(
                        b.submitted_at || ""
                    ) || 0
                ) -
                (
                    Date.parse(
                        a.submitted_at || ""
                    ) || 0
                )
        );

        return json(
            {
                ok: true,
                student,
                grades
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Admin student grades:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось загрузить оценки ученика"
            },
            500,
            env
        );
    }
}

async function handleAdminUpdateStudentGrade(
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

    const role =
        String(
            auth.user.role || ""
        ).toLowerCase();

    if (
        ![
            "owner",
            "superadmin",
            "admin"
        ].includes(role)
    ) {
        return json(
            {
                ok: false,
                error: "Недостаточно прав"
            },
            403,
            env
        );
    }

    try {

        const body =
            await readJson(
                request
            );

        const type =
            String(
                body?.type || ""
            ).toLowerCase();

        const attemptId =
            Number(
                body?.attempt_id
            );

        const newScore =
            Number(
                body?.score
            );

        if (
            ![
                "test",
                "exam"
            ].includes(type)
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Некорректный тип оценки"
                },
                400,
                env
            );
        }

        if (
            !Number.isInteger(
                attemptId
            ) ||
            attemptId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Некорректный ID попытки"
                },
                400,
                env
            );
        }

        if (
            !Number.isFinite(
                newScore
            ) ||
            newScore < 0
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Некорректный балл"
                },
                400,
                env
            );
        }

        const table =
            type === "exam"
                ? "exam_attempts"
                : "test_attempts";

        const assessmentTable =
            type === "exam"
                ? "exams"
                : "tests";

        const assessmentColumn =
            type === "exam"
                ? "exam_id"
                : "test_id";

        const attempt =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    user_id,
                    ${assessmentColumn}
                        AS assessment_id,
                    course_id,
                    max_score
                FROM ${table}
                WHERE id = ?
                LIMIT 1
                `,
                [
                    attemptId
                ]
            );

        if (!attempt) {
            return json(
                {
                    ok: false,
                    error:
                        "Попытка не найдена"
                },
                404,
                env
            );
        }

        const assessment =
            await first(
                env.DB,
                `
                SELECT
                    passing_score,
                    max_score
                FROM ${assessmentTable}
                WHERE id = ?
                LIMIT 1
                `,
                [
                    attempt.assessment_id
                ]
            );

        const maxScore =
            Math.max(
                1,
                Number(
                    attempt.max_score ||
                    assessment?.max_score ||
                    100
                )
            );

        if (
            newScore > maxScore
        ) {
            return json(
                {
                    ok: false,
                    error:
                        `Максимальный балл: ${maxScore}`
                },
                400,
                env
            );
        }

        const percentage =
            Math.max(
                0,
                Math.min(
                    100,
                    Math.round(
                        (
                            newScore /
                            maxScore
                        ) *
                        100
                    )
                )
            );

        const passingScore =
            Number(
                assessment
                    ?.passing_score
            ) || 60;

        const passed =
            percentage >=
            passingScore
                ? 1
                : 0;

        if (
            type === "exam"
        ) {

            const grade =
                defaultGradeFromPercentage(
                    percentage
                );

            await run(
                env.DB,
                `
                UPDATE exam_attempts
                SET
                    score = ?,
                    max_score = ?,
                    percentage = ?,
                    passed = ?,
                    grade = ?
                WHERE id = ?
                `,
                [
                    newScore,
                    maxScore,
                    percentage,
                    passed,
                    grade,
                    attemptId
                ]
            );

        } else {

            await run(
                env.DB,
                `
                UPDATE test_attempts
                SET
                    score = ?,
                    max_score = ?,
                    percentage = ?,
                    passed = ?
                WHERE id = ?
                `,
                [
                    newScore,
                    maxScore,
                    percentage,
                    passed,
                    attemptId
                ]
            );
        }

        return json(
            {
                ok: true,
                attempt_id:
                    attemptId,
                score:
                    newScore,
                max_score:
                    maxScore,
                percentage,
                passed:
                    passed === 1
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Admin grade update:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось изменить оценку"
            },
            500,
            env
        );
    }
}

async function handleAdminGrantRetake(
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

    const role =
        String(
            auth.user.role || ""
        ).toLowerCase();

    if (
        ![
            "owner",
            "superadmin",
            "admin"
        ].includes(role)
    ) {
        return json(
            {
                ok: false,
                error: "Недостаточно прав"
            },
            403,
            env
        );
    }

    try {

        await ensureAssessmentRetakePermissionsTable(
            env.DB
        );

        const body =
            await readJson(
                request
            );

        const type =
            String(
                body?.type || ""
            ).toLowerCase();

        const assessmentId =
            Number(
                body?.assessment_id
            );

        const userId =
            Number(
                body?.user_id
            );

        if (
            ![
                "test",
                "exam"
            ].includes(type)
        ) {
            return json(
                {
                    ok: false,
                    error: "Некорректный тип"
                },
                400,
                env
            );
        }

        if (
            !Number.isInteger(assessmentId) ||
            assessmentId <= 0 ||
            !Number.isInteger(userId) ||
            userId <= 0
        ) {
            return json(
                {
                    ok: false,
                    error: "Некорректные данные"
                },
                400,
                env
            );
        }

        const student =
            await first(
                env.DB,
                `
                SELECT
                    id,
                    role
                FROM users
                WHERE id = ?
                LIMIT 1
                `,
                [userId]
            );

        if (
            !student ||
            String(student.role).toLowerCase() !==
                "student"
        ) {
            return json(
                {
                    ok: false,
                    error: "Ученик не найден"
                },
                404,
                env
            );
        }

        const assessmentTable =
            type === "exam"
                ? "exams"
                : "tests";

        const assessment =
            await first(
                env.DB,
                `
                SELECT id
                FROM ${assessmentTable}
                WHERE id = ?
                LIMIT 1
                `,
                [assessmentId]
            );

        if (!assessment) {
            return json(
                {
                    ok: false,
                    error:
                        "Тест или экзамен не найден"
                },
                404,
                env
            );
        }

        await run(
            env.DB,
            `
            INSERT INTO assessment_retake_permissions (
                user_id,
                assessment_type,
                assessment_id,
                extra_attempts,
                granted_by,
                granted_at
            )
            VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)

            ON CONFLICT(
                user_id,
                assessment_type,
                assessment_id
            )
            DO UPDATE SET
                extra_attempts =
                    extra_attempts + 1,
                granted_by =
                    excluded.granted_by,
                granted_at =
                    CURRENT_TIMESTAMP
            `,
            [
                userId,
                type,
                assessmentId,
                auth.user.id
            ]
        );

        const permission =
            await first(
                env.DB,
                `
                SELECT
                    extra_attempts,
                    granted_at
                FROM assessment_retake_permissions
                WHERE
                    user_id = ?
                    AND assessment_type = ?
                    AND assessment_id = ?
                LIMIT 1
                `,
                [
                    userId,
                    type,
                    assessmentId
                ]
            );

        return json(
            {
                ok: true,
                extra_attempts:
                    Number(
                        permission?.extra_attempts
                    ) || 0,
                granted_at:
                    permission?.granted_at ||
                    null
            },
            200,
            env
        );

    } catch (error) {

        console.error(
            "Admin retake grant:",
            error
        );

        return json(
            {
                ok: false,
                error:
                    "Не удалось разрешить пересдачу"
            },
            500,
            env
        );
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


function defaultGradeFromPercentage(
    percentage
) {

    const value =
        Math.max(
            0,
            Math.min(
                100,
                Number(percentage) || 0
            )
        );


    if (value >= 90) {
        return "\u041e\u0442\u043b\u0438\u0447\u043d\u043e";
    }

    if (value >= 75) {
        return "\u0425\u043e\u0440\u043e\u0448\u043e";
    }

    if (value >= 60) {
        return "\u0423\u0434\u043e\u0432\u043b\u0435\u0442\u0432\u043e\u0440\u0438\u0442\u0435\u043b\u044c\u043d\u043e";
    }

    return "\u041d\u0435 \u0441\u0434\u0430\u043d\u043e";
}


function resolveCourseGrade(
    percentage,
    courseId,
    scales
) {

    const value =
        Math.max(
            0,
            Math.min(
                100,
                Number(percentage) || 0
            )
        );


    const scale =
        Array.isArray(scales)
            ? scales.find(
                item =>
                    Number(item.course_id) ===
                        Number(courseId) &&
                    value >=
                        Number(item.min_score) &&
                    value <=
                        Number(item.max_score)
            )
            : null;


    if (scale?.grade) {
        return String(scale.grade);
    }


    return defaultGradeFromPercentage(
        value
    );
}


async function handleGrades(
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

        const scales =
            await all(
                env.DB,
                `
                SELECT
                    course_id,
                    min_score,
                    max_score,
                    grade,
                    description
                FROM grading_scales
                ORDER BY
                    course_id,
                    min_score DESC
                `
            );


        const tests =
            await all(
                env.DB,
                `
                SELECT
                    ta.id AS attempt_id,
                    ta.test_id AS assessment_id,
                    ta.course_id,
                    ta.attempt_number,
                    ta.score,
                    ta.max_score,
                    ta.percentage,
                    ta.passed,
                    ta.submitted_at,

                    t.title,
                    t.passing_score,

                    c.name AS course_name

                FROM test_attempts ta

                LEFT JOIN tests t
                    ON t.id = ta.test_id

                LEFT JOIN courses c
                    ON c.id = ta.course_id

                WHERE ta.user_id = ?
                  AND ta.submitted_at IS NOT NULL

                ORDER BY
                    ta.submitted_at DESC,
                    ta.id DESC
                `,
                [auth.user.id]
            );


        const exams =
            await all(
                env.DB,
                `
                SELECT
                    ea.id AS attempt_id,
                    ea.exam_id AS assessment_id,
                    ea.course_id,
                    ea.attempt_number,
                    ea.score,
                    ea.max_score,
                    ea.percentage,
                    ea.passed,
                    ea.grade AS stored_grade,
                    ea.submitted_at,

                    e.title,
                    e.passing_score,

                    c.name AS course_name

                FROM exam_attempts ea

                LEFT JOIN exams e
                    ON e.id = ea.exam_id

                LEFT JOIN courses c
                    ON c.id = ea.course_id

                WHERE ea.user_id = ?
                  AND ea.submitted_at IS NOT NULL

                ORDER BY
                    ea.submitted_at DESC,
                    ea.id DESC
                `,
                [auth.user.id]
            );


        const attempts = [];


        for (const row of tests || []) {

            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(row.percentage) || 0
                    )
                );


            attempts.push({
                type: "test",

                assessment_id:
                    Number(row.assessment_id),

                attempt_id:
                    Number(row.attempt_id),

                course_id:
                    Number(row.course_id),

                course_name:
                    row.course_name ||
                    "\u041a\u0443\u0440\u0441",

                title:
                    row.title ||
                    "\u0422\u0435\u0441\u0442",

                attempt_number:
                    Number(
                        row.attempt_number
                    ) || 1,

                score:
                    Number(row.score) || 0,

                max_score:
                    Number(row.max_score) ||
                    100,

                percentage,

                passing_score:
                    Number(
                        row.passing_score
                    ) || 60,

                passed:
                    percentage >=
                    (
                        Number(
                            row.passing_score
                        ) || 60
                    ),

                grade:
                    resolveCourseGrade(
                        percentage,
                        row.course_id,
                        scales
                    ),

                submitted_at:
                    row.submitted_at || null
            });
        }


        for (const row of exams || []) {

            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(row.percentage) || 0
                    )
                );


            attempts.push({
                type: "exam",

                assessment_id:
                    Number(row.assessment_id),

                attempt_id:
                    Number(row.attempt_id),

                course_id:
                    Number(row.course_id),

                course_name:
                    row.course_name ||
                    "\u041a\u0443\u0440\u0441",

                title:
                    row.title ||
                    "\u042d\u043a\u0437\u0430\u043c\u0435\u043d",

                attempt_number:
                    Number(
                        row.attempt_number
                    ) || 1,

                score:
                    Number(row.score) || 0,

                max_score:
                    Number(row.max_score) ||
                    100,

                percentage,

                passing_score:
                    Number(
                        row.passing_score
                    ) || 60,

                passed:
                    percentage >=
                    (
                        Number(
                            row.passing_score
                        ) || 60
                    ),

                grade:
                    resolveCourseGrade(
                        percentage,
                        row.course_id,
                        scales
                    ),

                submitted_at:
                    row.submitted_at || null
            });
        }


        /*
         * Если было несколько попыток,
         * в журнал идёт лучший результат.
         */

        const best =
            new Map();


        for (const item of attempts) {

            const key =
                item.type +
                ":" +
                item.assessment_id;


            const previous =
                best.get(key);


            if (
                !previous ||
                item.percentage >
                    previous.percentage ||
                (
                    item.percentage ===
                        previous.percentage &&
                    Number(item.attempt_id) >
                        Number(
                            previous.attempt_id
                        )
                )
            ) {

                best.set(
                    key,
                    item
                );
            }
        }


        const grades =
            Array.from(
                best.values()
            )
            .sort(
                (a, b) => {

                    const aDate =
                        Date.parse(
                            a.submitted_at || ""
                        ) || 0;

                    const bDate =
                        Date.parse(
                            b.submitted_at || ""
                        ) || 0;


                    return bDate - aDate;
                }
            );


        const total =
            grades.length;


        const passed =
            grades.filter(
                item => item.passed
            ).length;


        const failed =
            total - passed;


        const average =
            total
                ? Math.round(
                    grades.reduce(
                        (
                            sum,
                            item
                        ) =>
                            sum +
                            Number(
                                item.percentage
                            ),
                        0
                    ) /
                    total
                )
                : 0;


        return json(
            {
                ok: true,

                scale: [
                    {
                        min: 90,
                        max: 100,
                        grade:
                            "\u041e\u0442\u043b\u0438\u0447\u043d\u043e"
                    },
                    {
                        min: 75,
                        max: 89,
                        grade:
                            "\u0425\u043e\u0440\u043e\u0448\u043e"
                    },
                    {
                        min: 60,
                        max: 74,
                        grade:
                            "\u0423\u0434\u043e\u0432\u043b\u0435\u0442\u0432\u043e\u0440\u0438\u0442\u0435\u043b\u044c\u043d\u043e"
                    },
                    {
                        min: 0,
                        max: 59,
                        grade:
                            "\u041d\u0435 \u0441\u0434\u0430\u043d\u043e"
                    }
                ],

                summary: {
                    total,
                    passed,
                    failed,
                    average_percentage:
                        average,

                    average_grade:
                        defaultGradeFromPercentage(
                            average
                        )
                },

                grades
            },
            200,
            env
        );


    } catch (error) {

        console.error(
            "Grades error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043e\u0446\u0435\u043d\u043a\u0438"
            },
            500,
            env
        );
    }
}
async function handleGradesDetails(
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

        const scales =
            await all(
                env.DB,
                `
                SELECT
                    course_id,
                    min_score,
                    max_score,
                    grade,
                    description
                FROM grading_scales
                ORDER BY
                    course_id,
                    min_score DESC
                `
            );


        /* =========================
           ТЕСТЫ
           ========================= */

        const tests =
            await all(
                env.DB,
                `
                SELECT
                    ta.id AS attempt_id,
                    ta.test_id AS assessment_id,
                    ta.course_id,
                    ta.attempt_number,
                    ta.score,
                    ta.max_score,
                    ta.percentage,
                    ta.passed,
                    ta.submitted_at,

                    t.title,
                    t.passing_score,
                    t.attempts_allowed,
                    t.is_active,
                    t.starts_at,
                    t.ends_at,
                    t.subject_id,
                    t.book_id,

                    c.name AS course_name

                FROM test_attempts ta

                LEFT JOIN tests t
                    ON t.id = ta.test_id

                LEFT JOIN courses c
                    ON c.id = ta.course_id

                WHERE
                    ta.user_id = ?
                    AND ta.submitted_at
                        IS NOT NULL

                ORDER BY
                    ta.submitted_at DESC,
                    ta.id DESC
                `,
                [
                    auth.user.id
                ]
            );


        /* =========================
           ЭКЗАМЕНЫ
           ========================= */

        const exams =
            await all(
                env.DB,
                `
                SELECT
                    ea.id AS attempt_id,
                    ea.exam_id AS assessment_id,
                    ea.course_id,
                    ea.attempt_number,
                    ea.score,
                    ea.max_score,
                    ea.percentage,
                    ea.passed,
                    ea.grade AS stored_grade,
                    ea.submitted_at,

                    e.title,
                    e.passing_score,
                    e.attempts_allowed,
                    e.is_active,
                    e.starts_at,
                    e.ends_at,
                    e.subject_id,
                    e.book_id,

                    c.name AS course_name

                FROM exam_attempts ea

                LEFT JOIN exams e
                    ON e.id = ea.exam_id

                LEFT JOIN courses c
                    ON c.id = ea.course_id

                WHERE
                    ea.user_id = ?
                    AND ea.submitted_at
                        IS NOT NULL

                ORDER BY
                    ea.submitted_at DESC,
                    ea.id DESC
                `,
                [
                    auth.user.id
                ]
            );


        const grouped =
            new Map();


        function addAttempt(
            row,
            type
        ) {

            const assessmentId =
                Number(
                    row.assessment_id
                );


            const key =
                type +
                ":" +
                assessmentId;


            if (!grouped.has(key)) {

                grouped.set(
                    key,
                    {
                        type,

                        assessment_id:
                            assessmentId,

                        title:
                            row.title ||
                            (
                                type === "exam"
                                    ? "Экзамен"
                                    : "Тест"
                            ),

                        course: {
                            id:
                                Number(
                                    row.course_id
                                ) || null,

                            name:
                                row.course_name ||
                                "Курс"
                        },

                        subject:
                            null,

                        book:
                            null,

                        passing_score:
                            Number(
                                row.passing_score
                            ) || 60,

                        attempts_allowed:
                            Math.max(
                                1,
                                Number(
                                    row.attempts_allowed
                                ) || 1
                            ),

                        is_active:
                            Number(
                                row.is_active
                            ) === 1,

                        starts_at:
                            row.starts_at ||
                            null,

                        ends_at:
                            row.ends_at ||
                            null,

                        attempts:
                            []
                    }
                );
            }


            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(
                            row.percentage
                        ) || 0
                    )
                );


            grouped
                .get(key)
                .attempts
                .push({
                    attempt_id:
                        Number(
                            row.attempt_id
                        ),

                    attempt_number:
                        Number(
                            row.attempt_number
                        ) || 1,

                    score:
                        Number(
                            row.score
                        ) || 0,

                    max_score:
                        Number(
                            row.max_score
                        ) || 100,

                    percentage,

                    passed:
                        percentage >=
                        (
                            Number(
                                row.passing_score
                            ) || 60
                        ),

                    grade:
                        resolveCourseGrade(
                            percentage,
                            row.course_id,
                            scales
                        ),

                    submitted_at:
                        row.submitted_at ||
                        null
                });
        }


        for (
            const row of tests || []
        ) {
            addAttempt(
                row,
                "test"
            );
        }


        for (
            const row of exams || []
        ) {
            addAttempt(
                row,
                "exam"
            );
        }


        const now =
            Date.now();


        const assessments =
            Array.from(
                grouped.values()
            )
            .map(
                item => {

                    const attempts =
                        item.attempts
                            .slice()
                            .sort(
                                (a, b) =>
                                    Number(
                                        b.attempt_id
                                    ) -
                                    Number(
                                        a.attempt_id
                                    )
                            );


                    let bestAttempt =
                        null;


                    for (
                        const attempt of attempts
                    ) {

                        if (
                            !bestAttempt ||
                            attempt.percentage >
                                bestAttempt.percentage
                        ) {
                            bestAttempt =
                                attempt;
                        }
                    }


                    const used =
                        attempts.length;


                    const permission =
    retakePermissions.find(
        row =>
            String(
                row.assessment_type
            ) === item.type &&
            Number(
                row.assessment_id
            ) ===
            Number(
                item.assessment_id
            )
    );

const extraAttempts =
    Math.max(
        0,
        Number(
            permission?.extra_attempts
        ) || 0
    );

const totalAllowed =
    item.attempts_allowed +
    extraAttempts;

const remaining =
    Math.max(
        0,
        totalAllowed -
        used
    );


                    let inDateWindow =
                        true;


                    if (
                        item.starts_at
                    ) {

                        const start =
                            Date.parse(
                                item.starts_at
                            );

                        if (
                            !Number.isNaN(
                                start
                            ) &&
                            now < start
                        ) {
                            inDateWindow =
                                false;
                        }
                    }


                    if (
                        item.ends_at
                    ) {

                        const end =
                            Date.parse(
                                item.ends_at
                            );

                        if (
                            !Number.isNaN(
                                end
                            ) &&
                            now > end
                        ) {
                            inDateWindow =
                                false;
                        }
                    }


                    const canAttempt =
                        item.is_active &&
                        inDateWindow &&
                        remaining > 0;


                    return {
                        type:
                            item.type,

                        assessment_id:
                            item.assessment_id,

                        title:
                            item.title,

                        course:
                            item.course,

                        subject:
                            item.subject,

                        book:
                            item.book,

                        passing_score:
                            item.passing_score,

                        best_attempt:
                            bestAttempt ||
                            {
                                score: 0,
                                max_score: 100,
                                percentage: 0,
                                passed: false,
                                grade: "—"
                            },

                        attempts,

                        access: {
                            can_attempt:
                                canAttempt,

                            is_retake:
                                used > 0,

                            attempts_used:
                                used,

                            attempts_allowed:
    totalAllowed,

base_attempts_allowed:
    item.attempts_allowed,

extra_attempts:
    extraAttempts,

                            attempts_remaining:
                                remaining
                        }
                    };
                }
            );


        const total =
            assessments.length;


        const passed =
            assessments.filter(
                item =>
                    item.best_attempt
                        ?.passed
            ).length;


        const failed =
            total -
            passed;


        const average =
            total
                ? Math.round(
                    assessments.reduce(
                        (
                            sum,
                            item
                        ) =>
                            sum +
                            Number(
                                item
                                    .best_attempt
                                    ?.percentage ||
                                0
                            ),
                        0
                    ) /
                    total
                )
                : 0;


        return json(
            {
                ok: true,

                summary: {
                    total,
                    passed,
                    failed,

                    average_percentage:
                        average,

                    average_grade:
                        defaultGradeFromPercentage(
                            average
                        )
                },

                assessments
            },
            200,
            env
        );


    } catch (error) {

        console.error(
            "Grades details error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Не удалось загрузить данные оценок"
            },
            500,
            env
        );
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
    const token =
    getSessionToken(request);
    if (!token) return { ok: false, status: 401, error: "Authorization required" };

    const row = await first(env.DB, `
        SELECT u.id, u.account_id, u.telegram_id, u.username, u.first_name, u.last_name, u.phone,
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
const ADMIN_PERMISSION_KEYS = new Set([
    "content",
    "students",
    "grades",
    "assessments",
    "schedule",
    "payments",
    "certificates"
]);

async function requireAdminPermission(
    request,
    env,
    permission
) {
    const auth =
        await requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return auth;
    }

    const role =
        String(
            auth.user?.role || ""
        ).toLowerCase();

    // Владелец и суперадмин имеют все права
    if (
        role === "owner" ||
        role === "superadmin"
    ) {
        return auth;
    }

    if (
        !ADMIN_PERMISSION_KEYS.has(
            permission
        )
    ) {
        return {
            ok: false,
            status: 403,
            error: "Неизвестное разрешение"
        };
    }

    const row =
        await first(
            env.DB,
            `
            SELECT id
            FROM admin_permissions
            WHERE admin_id = ?
              AND permission = ?
            LIMIT 1
            `,
            [
                auth.user.id,
                permission
            ]
        );

    if (!row) {
        return {
            ok: false,
            status: 403,
            error:
                "У администратора нет этого разрешения"
        };
    }

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

/* =========================================================
   ACCOUNT ID
   ========================================================= */

function generateRandomAccountId() {
    const MIN = 10000000;
    const RANGE = 90000000;
    const UINT32_RANGE = 0x100000000;

    const limit =
        Math.floor(UINT32_RANGE / RANGE) * RANGE;

    const buffer =
        new Uint32Array(1);

    let value;

    do {
        crypto.getRandomValues(buffer);
        value = buffer[0];
    } while (value >= limit);

    return MIN + (value % RANGE);
}


async function generateUniqueAccountId(db) {

    for (
        let attempt = 0;
        attempt < 50;
        attempt++
    ) {

        const accountId =
            generateRandomAccountId();

        const existing =
            await first(
                db,
                `
                SELECT id
                FROM users
                WHERE account_id = ?
                LIMIT 1
                `,
                [accountId]
            );

        if (!existing) {
            return accountId;
        }
    }

    throw new Error(
        "Не удалось создать уникальный ID аккаунта"
    );
}

async function ensureUserAccountId(
    db,
    userId
) {
    const id = Number(userId);

    if (
        !Number.isInteger(id) ||
        id <= 0
    ) {
        return null;
    }

    const user = await first(
        db,
        `
        SELECT id, account_id
        FROM users
        WHERE id = ?
        LIMIT 1
        `,
        [id]
    );

    if (!user) {
        return null;
    }

    const currentId =
        Number(user.account_id);

    if (
        Number.isInteger(currentId) &&
        currentId >= 10000000 &&
        currentId <= 99999999
    ) {
        return currentId;
    }

    for (
        let attempt = 0;
        attempt < 50;
        attempt++
    ) {
        const accountId =
            await generateUniqueAccountId(
                db
            );

        try {
            await run(
                db,
                `
                UPDATE users
                SET
                    account_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND account_id IS NULL
                `,
                [
                    accountId,
                    id
                ]
            );
        } catch (error) {
            continue;
        }

        const saved = await first(
            db,
            `
            SELECT account_id
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [id]
        );

        const savedId =
            Number(saved?.account_id);

        if (
            Number.isInteger(savedId) &&
            savedId >= 10000000 &&
            savedId <= 99999999
        ) {
            return savedId;
        }
    }

    throw new Error(
        "Не удалось присвоить ID аккаунта"
    );
}


async function ensureAccountIdSchema(db) {

    if (!db) {
        return;
    }

    if (accountIdSchemaPromise) {
        return accountIdSchemaPromise;
    }

    accountIdSchemaPromise =
        (async () => {

            const columns = await all(
                db,
                `
                PRAGMA table_info(users)
                `
            );

            const hasAccountId =
                columns.some(
                    column =>
                        column.name ===
                        "account_id"
                );

            if (!hasAccountId) {
                await run(
                    db,
                    `
                    ALTER TABLE users
                    ADD COLUMN account_id INTEGER
                    `
                );
            }

            await run(
                db,
                `
                CREATE UNIQUE INDEX
                IF NOT EXISTS
                idx_users_account_id
                ON users(account_id)
                `
            );

            const users =
                await all(
                    db,
                    `
                    SELECT id
                    FROM users
                    WHERE account_id IS NULL
                    ORDER BY id ASC
                    `
                );

            for (const user of users) {
                await ensureUserAccountId(
                    db,
                    user.id
                );
            }
        })();

    try {
        await accountIdSchemaPromise;
    } catch (error) {
        accountIdSchemaPromise = null;
        throw error;
    }
}

async function getUserById(db, userId) {

    await ensureAccountIdSchema(db);

    await ensureUserAccountId(
        db,
        userId
    );

    await ensureAvatarInfrastructure(db);
    const user = await first(db, `
        SELECT id, account_id, telegram_id, username, first_name, last_name, phone, role, status,
               blocked_reason, blocked_at, created_at, updated_at, login, email, email_verified_at, avatar_key, avatar_source
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

    const columns =
        await all(
            db,
            `PRAGMA table_info(lesson_progress)`
        );

    const names =
        new Set(
            columns.map(
                column => column.name
            )
        );

    if (!names.has("progress_percent")) {
        await run(
            db,
            `
            ALTER TABLE lesson_progress
            ADD COLUMN progress_percent
            INTEGER NOT NULL DEFAULT 0
            `
        );
    }

    if (!names.has("is_completed")) {
        await run(
            db,
            `
            ALTER TABLE lesson_progress
            ADD COLUMN is_completed
            INTEGER NOT NULL DEFAULT 0
            `
        );
    }

    /*
     * Переносим старый completed
     * в новую структуру.
     */
    if (names.has("completed")) {
        await run(
            db,
            `
            UPDATE lesson_progress
            SET
                is_completed =
                    CASE
                        WHEN completed = 1
                        THEN 1
                        ELSE is_completed
                    END,

                progress_percent =
                    CASE
                        WHEN completed = 1
                        THEN 100
                        ELSE progress_percent
                    END
            `
        );
    }

    await run(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_lesson_progress_user_id
        ON lesson_progress(user_id)
        `
    );
}

async function getLessonProgress(db, userId, lessonId) {
    await ensureLessonProgressTable(db);
    return first(db, "SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ? LIMIT 1", [userId, lessonId]);
}

async function saveLessonProgress(
    db,
    userId,
    lessonId,
    percentage,
    completed
) {
    const existing =
        await getLessonProgress(
            db,
            userId,
            lessonId
        );

    if (existing) {

        await run(
            db,
            `
            UPDATE lesson_progress
            SET
                progress_percent = ?,
                is_completed = ?,
                completed_at =
                    CASE
                        WHEN ? = 1
                        THEN COALESCE(
                            completed_at,
                            CURRENT_TIMESTAMP
                        )
                        ELSE NULL
                    END,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
              AND lesson_id = ?
            `,
            [
                percentage,
                completed,
                completed,
                userId,
                lessonId
            ]
        );

    } else {

        /*
         * Поддерживаем старую D1-схему,
         * где course_id обязательный.
         */
        const columns =
            await all(
                db,
                `PRAGMA table_info(lesson_progress)`
            );

        const names =
            new Set(
                columns.map(
                    column => column.name
                )
            );

        if (names.has("course_id")) {

            const lesson =
                await first(
                    db,
                    `
                    SELECT course_id
                    FROM lessons
                    WHERE id = ?
                    LIMIT 1
                    `,
                    [lessonId]
                );

            const courseId =
                Number(
                    lesson?.course_id
                );

            if (
                !Number.isInteger(courseId) ||
                courseId <= 0
            ) {
                throw new Error(
                    "У урока отсутствует course_id"
                );
            }

            await run(
                db,
                `
                INSERT INTO lesson_progress (
                    user_id,
                    course_id,
                    lesson_id,
                    progress_percent,
                    is_completed,
                    completed_at
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    CASE
                        WHEN ? = 1
                        THEN CURRENT_TIMESTAMP
                        ELSE NULL
                    END
                )
                `,
                [
                    userId,
                    courseId,
                    lessonId,
                    percentage,
                    completed,
                    completed
                ]
            );

        } else {

            await run(
                db,
                `
                INSERT INTO lesson_progress (
                    user_id,
                    lesson_id,
                    progress_percent,
                    is_completed,
                    completed_at
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    ?,
                    CASE
                        WHEN ? = 1
                        THEN CURRENT_TIMESTAMP
                        ELSE NULL
                    END
                )
                `,
                [
                    userId,
                    lessonId,
                    percentage,
                    completed,
                    completed
                ]
            );
        }
    }

    return getLessonProgress(
        db,
        userId,
        lessonId
    );
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

async function ensureAssessmentRetakePermissionsTable(
    db
) {

    await run(
        db,
        `
        CREATE TABLE IF NOT EXISTS
        assessment_retake_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            assessment_type TEXT NOT NULL
                CHECK (
                    assessment_type IN (
                        'test',
                        'exam'
                    )
                ),

            assessment_id INTEGER NOT NULL,

            extra_attempts INTEGER
                NOT NULL DEFAULT 0,

            granted_by INTEGER,

            granted_at TEXT
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            UNIQUE (
                user_id,
                assessment_type,
                assessment_id
            )
        )
        `
    );

    await run(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_retake_permissions_user
        ON assessment_retake_permissions(
            user_id
        )
        `
    );
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
function generateVerificationCode() {
    const limit =
        Math.floor(
            0x100000000 / 1000000
        ) * 1000000;

    const values =
        new Uint32Array(1);

    let number;

    do {
        crypto.getRandomValues(values);
        number = values[0];
    } while (number >= limit);

    return String(
        number % 1000000
    ).padStart(6, "0");
}

async function hashVerificationCode(
    code,
    userId,
    type,
    target,
    env
) {
    const secret =
        String(
            env.VERIFICATION_CODE_SECRET ||
            ""
        );

    if (!secret) {
        throw new Error(
            "VERIFICATION_CODE_SECRET is not configured"
        );
    }

    const key =
        await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(
                secret
            ),
            {
                name: "HMAC",
                hash: "SHA-256"
            },
            false,
            ["sign"]
        );

    const message =
        [
            String(userId),
            String(type),
            String(target || ""),
            String(code)
        ].join(":");

    const signature =
        await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(
                message
            )
        );

    return Array
        .from(
            new Uint8Array(
                signature
            )
        )
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");
}

function getCookie(
    request,
    name
) {
    const cookieHeader =
        request.headers.get(
            "Cookie"
        ) || "";

    const cookies =
        cookieHeader.split(";");

    for (const cookie of cookies) {
        const separator =
            cookie.indexOf("=");

        if (separator < 0) {
            continue;
        }

        const key =
            cookie
                .slice(
                    0,
                    separator
                )
                .trim();

        if (key !== name) {
            continue;
        }

        const value =
            cookie.slice(
                separator + 1
            );

        try {
            return decodeURIComponent(
                value
            );
        } catch {
            return value;
        }
    }

    return null;
}


function sessionCookie(token) {
    const maxAge =
        SESSION_DAYS *
        24 *
        60 *
        60;

    return [
        SESSION_COOKIE_NAME +
            "=" +
            encodeURIComponent(token),

        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=" + maxAge
    ].join("; ");
}


function expiredSessionCookie() {
    return [
        SESSION_COOKIE_NAME + "=",
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=0"
    ].join("; ");
}


function getSessionToken(
    request
) {
    const cookieToken =
        getCookie(
            request,
            SESSION_COOKIE_NAME
        );

    if (cookieToken) {
        return cookieToken;
    }

    /*
     * Временно оставляем старый Bearer
     * для совместимости со старыми
     * открытыми версиями frontend.
     */
    const headerToken =
        bearerFromHeader(
            request.headers.get(
                "Authorization"
            )
        ) ||
        request.headers.get(
            "X-Session-Token"
        );

    return headerToken
        ? String(headerToken).trim()
        : null;
}

function bearerFromHeader(value) {
    const match = String(value || "").match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

async function ensureVerificationInfrastructure(
    db
) {
    await run(
        db,
        `
        CREATE TABLE IF NOT EXISTS auth_challenges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            type TEXT NOT NULL
                CHECK (
                    type IN (
                        'email_link',
                        'telegram_link'
                    )
                ),

            target TEXT,

            code_hash TEXT NOT NULL,

            attempts_left INTEGER NOT NULL DEFAULT 5,

            expires_at TEXT NOT NULL,

            consumed_at TEXT,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        )
        `
    );

    await run(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_auth_challenges_user_type
        ON auth_challenges(
            user_id,
            type,
            created_at
        )
        `
    );

    const columns =
        await all(
            db,
            `PRAGMA table_info(users)`
        );

    const names =
        new Set(
            columns.map(
                column => column.name
            )
        );

    if (!names.has("email")) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN email TEXT
            `
        );
    }

    if (
        !names.has(
            "email_verified_at"
        )
    ) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN email_verified_at TEXT
            `
        );
    }

    await run(
        db,
        `
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_users_email_unique
        ON users(email)
        WHERE email IS NOT NULL
          AND email != ''
        `
    );
}
async function ensureRecoveryInfrastructure(
    db
) {
    /*
     * Старые базы могли быть созданы
     * до появления логина/пароля.
     */
    const columns =
        await tableColumns(
            db,
            "users"
        );

    let changed = false;

    if (
        !columns.includes(
            "login"
        )
    ) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN login TEXT
            `
        );

        changed = true;
    }

    if (
        !columns.includes(
            "password_hash"
        )
    ) {
        await run(
            db,
            `
            ALTER TABLE users
            ADD COLUMN password_hash TEXT
            `
        );

        changed = true;
    }

    if (changed) {
        tableColumnsCache.delete(
            "users"
        );
    }

    /*
     * Даже если два запроса одновременно
     * пытаются занять одинаковый логин,
     * база не разрешит дубликат.
     */
    await run(
        db,
        `
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_users_login_unique
        ON users(login)
        WHERE login IS NOT NULL
          AND login != ''
        `
    );

    await run(
        db,
        `
        CREATE TABLE IF NOT EXISTS admin_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL,
            permission TEXT NOT NULL,
            UNIQUE(admin_id, permission)
        )
        `
    );

    await run(
        db,
        `
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            course_id INTEGER,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id INTEGER,
            details TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        `
    );
}


async function requireAccountRecoveryAdmin(
    request,
    env
) {
    const auth =
        await requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return auth;
    }

    const role =
        String(
            auth.user.role || ""
        ).toLowerCase();

    /*
     * Владелец и суперадмин
     * имеют право автоматически.
     */
    if (
        role === "owner" ||
        role === "superadmin"
    ) {
        return auth;
    }

    await ensureRecoveryInfrastructure(
        env.DB
    );

    const permission =
        await first(
            env.DB,
            `
            SELECT id
            FROM admin_permissions
            WHERE admin_id = ?
              AND permission = 'account_recovery'
            LIMIT 1
            `,
            [auth.user.id]
        );

    if (!permission) {
        return {
            ok: false,
            status: 403,
            error:
                "Нет права на восстановление аккаунтов"
        };
    }

    return auth;
}

async function emailMergePreview(
    db,
    userId
) {

    const courses =
        await all(
            db,
            `
            SELECT
                c.id,
                c.name,
                uc.status
            FROM user_courses uc
            JOIN courses c
                ON c.id = uc.course_id
            WHERE uc.user_id = ?
            ORDER BY c.name
            `,
            [userId]
        );


    const lessons =
        await all(
            db,
            `
            SELECT
                l.id AS lesson_id,
                l.title,
                c.id AS course_id,
                c.name AS course_name,
                lp.progress_percent,
                lp.is_completed
            FROM lesson_progress lp
            JOIN lessons l
                ON l.id = lp.lesson_id
            JOIN courses c
                ON c.id = l.course_id
            WHERE lp.user_id = ?
            ORDER BY
                c.name,
                l.sort_order,
                l.id
            `,
            [userId]
        );


    const tests =
        await all(
            db,
            `
            SELECT
                t.title,
                c.name AS course_name,
                ta.percentage,
                ta.passed,
                ta.submitted_at
            FROM test_attempts ta
            JOIN tests t
                ON t.id = ta.test_id
            JOIN courses c
                ON c.id = ta.course_id
            WHERE ta.user_id = ?
            ORDER BY ta.id DESC
            `,
            [userId]
        );


    const exams =
        await all(
            db,
            `
            SELECT
                e.title,
                c.name AS course_name,
                ea.percentage,
                ea.passed,
                ea.grade,
                ea.submitted_at
            FROM exam_attempts ea
            JOIN exams e
                ON e.id = ea.exam_id
            JOIN courses c
                ON c.id = ea.course_id
            WHERE ea.user_id = ?
            ORDER BY ea.id DESC
            `,
            [userId]
        );


    const certificates =
        await all(
            db,
            `
            SELECT
                c.name AS course_name,
                certificates.certificate_number,
                certificates.certificate_name,
                certificates.issued_at,
                certificates.is_valid
            FROM certificates
            JOIN courses c
                ON c.id =
                    certificates.course_id
            WHERE certificates.user_id = ?
            ORDER BY certificates.issued_at DESC
            `,
            [userId]
        );


    return {
        courses,
        lessons,
        tests,
        exams,
        certificates
    };
}

async function recoveryUserData(
    db,
    userId
) {
    const checks = [
        ["lesson_progress", "user_id"],
        ["user_program_access", "user_id"],
        ["user_courses", "user_id"],
        ["test_attempts", "user_id"],
        ["exam_attempts", "user_id"],
        ["certificates", "user_id"],
        ["payments", "user_id"],
        ["user_groups", "user_id"],
        ["admin_permissions", "admin_id"],
        ["admin_courses", "admin_id"]
    ];

    const conflicts = [];

    for (
        const [
            table,
            column
        ] of checks
    ) {
        const columns =
            await tableColumns(
                db,
                table
            );

        if (
            !columns.includes(
                column
            )
        ) {
            continue;
        }

        const row =
            await first(
                db,
                `
                SELECT COUNT(*) AS count
                FROM ${quoteIdentifier(table)}
                WHERE ${quoteIdentifier(column)} = ?
                `,
                [userId]
            );

        const count =
            Number(
                row?.count || 0
            );

        if (count > 0) {
            conflicts.push({
                table,
                count
            });
        }
    }

    return conflicts;
}

function corsHeaders(env) {
    return {
        "Access-Control-Allow-Origin":
            env.CORS_ORIGIN || "*",

        "Access-Control-Allow-Methods":
            "GET, POST, PATCH, DELETE, OPTIONS",

        "Access-Control-Allow-Headers":
            "Authorization, Content-Type, Range, X-Session-Token, X-Tribute-Webhook-Secret, X-Webhook-Secret",

        "Access-Control-Expose-Headers":
            "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag",

        "Vary": "Origin"
    };
}
function withCors(response, env) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(
    payload,
    status = 200,
    env = {}
) {
    const headers =
        new Headers(
            corsHeaders(env)
        );

    headers.set(
        "Content-Type",
        "application/json; charset=utf-8"
    );

    let responsePayload =
        payload;

    /*
     * Все успешные ответы авторизации
     * сейчас содержат:
     *
     * user + token + expires_at
     *
     * Перехватываем session token,
     * помещаем его в HttpOnly cookie
     * и НЕ отдаём JavaScript.
     */
    if (
        payload &&
        typeof payload === "object" &&
        payload.user &&
        payload.token &&
        payload.expires_at
    ) {
        headers.append(
            "Set-Cookie",
            sessionCookie(
                String(
                    payload.token
                )
            )
        );

        headers.set(
            "Cache-Control",
            "no-store"
        );

        const {
            token,
            ...safePayload
        } = payload;

        responsePayload =
            safePayload;
    }

    return new Response(
        JSON.stringify(
            responsePayload
        ),
        {
            status,
            headers
        }
    );
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

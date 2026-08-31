import { verifyTelegramInitData } from "./telegram.js";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        /*
         * ============================
         * CORS
         * ============================
         */

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        /*
         * ============================
         * DATABASE INITIALIZATION
         * ============================
         */

        if (env.DB) {
            try {
                await ensureAuthTables(env.DB);
                await ensureTributeTables(env.DB);
            } catch (error) {
                console.error(
                    "Database initialization error:",
                    error
                );
            }
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
                telegram_bot_token:
                    !!env.TELEGRAM_BOT_TOKEN,
                database:
                    !!env.DB,
                assets:
                    !!env.ASSETS,
                tribute_api_key:
                    !!env.TRIBUTE_API_KEY
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
                database:
                    !!env.DB
            });
        }

        /*
         * ============================
         * REGISTER
         * ============================
         */

        if (
            url.pathname === "/api/auth/register" &&
            request.method === "POST"
        ) {
            return handleRegister(
                request,
                env
            );
        }

        /*
         * ============================
         * LOGIN
         * ============================
         */

        if (
            url.pathname === "/api/auth/login" &&
            request.method === "POST"
        ) {
            return handleLogin(
                request,
                env
            );
        }

        /*
         * ============================
         * LOGOUT
         * ============================
         */

        if (
            url.pathname === "/api/auth/logout" &&
            request.method === "POST"
        ) {
            return handleLogout(
                request,
                env
            );
        }

        /*
         * ============================
         * CURRENT USER
         * ============================
         */

        if (
            url.pathname === "/api/auth/me" &&
            request.method === "GET"
        ) {
            return handleMe(
                request,
                env
            );
        }

        /*
         * ============================
         * TELEGRAM AUTH
         * ============================
         */

        if (
            url.pathname === "/api/auth/telegram" &&
            request.method === "POST"
        ) {
            return handleTelegramAuth(
                request,
                env
            );
        }

        /*
         * ============================
         * LINK TELEGRAM
         * ============================
         */

        if (
            url.pathname === "/api/auth/link-telegram" &&
            request.method === "POST"
        ) {
            return handleLinkTelegram(
                request,
                env
            );
        }

        /*
         * ============================
         * TRIBUTE WEBHOOK
         * ============================
         */

        if (
            url.pathname === "/api/webhooks/tribute" &&
            request.method === "POST"
        ) {
            return handleTributeWebhook(
                request,
                env
            );
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
            return handleLessons(
                request,
                env
            );
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
            return handleProgress(
                request,
                env
            );
        }

        /*
         * ============================
         * FRONTEND
         * ============================
         */

        if (env.ASSETS) {
            return env.ASSETS.fetch(
                request
            );
        }

        return new Response(
            "RAUDA ILM",
            {
                status: 200,
                headers: {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            }
        );
    }
};


/*
 * ============================================================
 * AUTH DATABASE
 * ============================================================
 */

async function ensureAuthTables(db) {

    /*
     * Пользователи.
     */

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            telegram_user_id TEXT UNIQUE,

            username TEXT UNIQUE,

            password_hash TEXT,

            password_salt TEXT,

            first_name TEXT,

            last_name TEXT,

            role TEXT NOT NULL DEFAULT 'user',

            is_active INTEGER NOT NULL DEFAULT 1,

            created_at TEXT NOT NULL,

            updated_at TEXT NOT NULL
        )
    `).run();


    /*
     * Сессии.
     */

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            token_hash TEXT NOT NULL UNIQUE,

            expires_at TEXT NOT NULL,

            created_at TEXT NOT NULL,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        )
    `).run();


    await db.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_auth_sessions_token
        ON auth_sessions(token_hash)
    `).run();


    await db.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_auth_sessions_user
        ON auth_sessions(user_id)
    `).run();


    await db.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_users_telegram
        ON users(telegram_user_id)
    `).run();
}


/*
 * ============================================================
 * REGISTER
 * ============================================================
 */

async function handleRegister(
    request,
    env
) {
    try {

        if (!env.DB) {
            return json(
                {
                    ok: false,
                    error:
                        "Database is not configured"
                },
                500
            );
        }


        const body =
            await request.json();


        const username =
            normalizeUsername(
                body?.username
            );


        const password =
            String(
                body?.password || ""
            );


        const firstName =
            String(
                body?.first_name || ""
            ).trim();


        const lastName =
            String(
                body?.last_name || ""
            ).trim();


        if (!username) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите логин"
                },
                400
            );
        }


        if (!isValidUsername(username)) {
            return json(
                {
                    ok: false,
                    error:
                        "Логин должен содержать 3–32 символа: латинские буквы, цифры, точка, дефис или подчёркивание"
                },
                400
            );
        }


        if (password.length < 8) {
            return json(
                {
                    ok: false,
                    error:
                        "Пароль должен содержать минимум 8 символов"
                },
                400
            );
        }


        const existing =
            await env.DB.prepare(`
                SELECT id
                FROM users
                WHERE username = ?
                LIMIT 1
            `)
                .bind(username)
                .first();


        if (existing) {
            return json(
                {
                    ok: false,
                    error:
                        "Такой логин уже существует"
                },
                409
            );
        }


        const passwordData =
            await hashPassword(
                password
            );


        const now =
            new Date().toISOString();


        const result =
            await env.DB.prepare(`
                INSERT INTO users
                (
                    username,
                    password_hash,
                    password_salt,
                    first_name,
                    last_name,
                    role,
                    is_active,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'user', 1, ?, ?)
            `)
                .bind(
                    username,
                    passwordData.hash,
                    passwordData.salt,
                    firstName || null,
                    lastName || null,
                    now,
                    now
                )
                .run();


        const userId =
            result.meta?.last_row_id;


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
            token: session.token
        });


    } catch (error) {

        console.error(
            "Register error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Не удалось создать аккаунт"
            },
            500
        );
    }
}


/*
 * ============================================================
 * LOGIN
 * ============================================================
 */

async function handleLogin(
    request,
    env
) {
    try {

        if (!env.DB) {
            return json(
                {
                    ok: false,
                    error:
                        "Database is not configured"
                },
                500
            );
        }


        const body =
            await request.json();


        const username =
            normalizeUsername(
                body?.username
            );


        const password =
            String(
                body?.password || ""
            );


        if (!username || !password) {
            return json(
                {
                    ok: false,
                    error:
                        "Введите логин и пароль"
                },
                400
            );
        }


        const user =
            await env.DB.prepare(`
                SELECT *
                FROM users
                WHERE username = ?
                LIMIT 1
            `)
                .bind(username)
                .first();


        if (!user) {
            return json(
                {
                    ok: false,
                    error:
                        "Неверный логин или пароль"
                },
                401
            );
        }


        if (
            Number(user.is_active) !== 1
        ) {
            return json(
                {
                    ok: false,
                    error:
                        "Этот аккаунт отключён"
                },
                403
            );
        }


        const valid =
            await verifyPassword(
                password,
                user.password_hash,
                user.password_salt
            );


        if (!valid) {
            return json(
                {
                    ok: false,
                    error:
                        "Неверный логин или пароль"
                },
                401
            );
        }


        const session =
            await createSession(
                env.DB,
                user.id
            );


        return json({
            ok: true,
            user:
                sanitizeUser(user),
            token:
                session.token
        });


    } catch (error) {

        console.error(
            "Login error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Не удалось выполнить вход"
            },
            500
        );
    }
}


/*
 * ============================================================
 * LOGOUT
 * ============================================================
 */

async function handleLogout(
    request,
    env
) {
    try {

        if (!env.DB) {
            return json({
                ok: true
            });
        }


        const token =
            getBearerToken(
                request
            );


        if (!token) {
            return json({
                ok: true
            });
        }


        const tokenHash =
            await sha256Hex(
                token
            );


        await env.DB.prepare(`
            DELETE FROM auth_sessions
            WHERE token_hash = ?
        `)
            .bind(tokenHash)
            .run();


        return json({
            ok: true
        });


    } catch (error) {

        console.error(
            "Logout error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Logout failed"
            },
            500
        );
    }
}


/*
 * ============================================================
 * CURRENT USER
 * ============================================================
 */

async function handleMe(
    request,
    env
) {

    const auth =
        await getCurrentAuth(
            request,
            env
        );


    if (!auth.ok) {
        return json(
            {
                ok: false,
                error:
                    auth.error
            },
            401
        );
    }


    return json({
        ok: true,
        user:
            sanitizeUser(
                auth.user
            )
    });
}


/*
 * ============================================================
 * TELEGRAM AUTH
 * ============================================================
 */

async function handleTelegramAuth(
    request,
    env
) {
    try {

        if (!env.TELEGRAM_BOT_TOKEN) {
            return json(
                {
                    ok: false,
                    error:
                        "Telegram bot token is not configured"
                },
                500
            );
        }


        const body =
            await request.json();


        const initData =
            body?.initData;


        if (!initData) {
            return json(
                {
                    ok: false,
                    error:
                        "Telegram initData is missing"
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
                    error:
                        verification.error
                },
                401
            );
        }


        const telegramUser =
            verification.user;


        if (!telegramUser?.id) {
            return json(
                {
                    ok: false,
                    error:
                        "Telegram user data is missing"
                },
                401
            );
        }


        if (!env.DB) {
            /*
             * Сохраняем старое поведение,
             * если D1 ещё не подключена.
             */

            return json({
                ok: true,
                user:
                    telegramUser
            });
        }


        const user =
            await upsertTelegramUser(
                env.DB,
                telegramUser
            );


        const session =
            await createSession(
                env.DB,
                user.id
            );


        return json({
            ok: true,
            user:
                sanitizeUser(user),
            token:
                session.token
        });


    } catch (error) {

        console.error(
            "Telegram auth error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Invalid JSON request"
            },
            400
        );
    }
}


/*
 * ============================================================
 * TELEGRAM USER UPSERT
 * ============================================================
 */

async function upsertTelegramUser(
    db,
    telegramUser
) {

    const telegramId =
        String(
            telegramUser.id
        );


    const existing =
        await db.prepare(`
            SELECT *
            FROM users
            WHERE telegram_user_id = ?
            LIMIT 1
        `)
            .bind(telegramId)
            .first();


    const now =
        new Date().toISOString();


    if (existing) {

        await db.prepare(`
            UPDATE users
            SET
                first_name = ?,
                last_name = ?,
                updated_at = ?
            WHERE id = ?
        `)
            .bind(
                telegramUser.first_name ||
                    null,

                telegramUser.last_name ||
                    null,

                now,

                existing.id
            )
            .run();


        return await getUserById(
            db,
            existing.id
        );
    }


    const result =
        await db.prepare(`
            INSERT INTO users
            (
                telegram_user_id,
                first_name,
                last_name,
                role,
                is_active,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, 'user', 1, ?, ?)
        `)
            .bind(
                telegramId,
                telegramUser.first_name ||
                    null,
                telegramUser.last_name ||
                    null,
                now,
                now
            )
            .run();


    return await getUserById(
        db,
        result.meta?.last_row_id
    );
}


/*
 * ============================================================
 * LINK TELEGRAM TO LOGIN ACCOUNT
 * ============================================================
 */

async function handleLinkTelegram(
    request,
    env
) {

    const auth =
        await getSessionAuth(
            request,
            env
        );


    if (!auth.ok) {
        return json(
            {
                ok: false,
                error:
                    auth.error
            },
            401
        );
    }


    if (!env.TELEGRAM_BOT_TOKEN) {
        return json(
            {
                ok: false,
                error:
                    "Telegram bot token is not configured"
            },
            500
        );
    }


    try {

        const body =
            await request.json();


        const initData =
            body?.initData;


        if (!initData) {
            return json(
                {
                    ok: false,
                    error:
                        "Telegram initData is missing"
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
                    error:
                        verification.error
                },
                401
            );
        }


        const telegramId =
            String(
                verification.user.id
            );


        const existing =
            await env.DB.prepare(`
                SELECT id
                FROM users
                WHERE telegram_user_id = ?
                AND id != ?
                LIMIT 1
            `)
                .bind(
                    telegramId,
                    auth.user.id
                )
                .first();


        if (existing) {
            return json(
                {
                    ok: false,
                    error:
                        "Этот Telegram уже привязан к другому аккаунту"
                },
                409
            );
        }


        await env.DB.prepare(`
            UPDATE users
            SET
                telegram_user_id = ?,
                updated_at = ?
            WHERE id = ?
        `)
            .bind(
                telegramId,
                new Date().toISOString(),
                auth.user.id
            )
            .run();


        const user =
            await getUserById(
                env.DB,
                auth.user.id
            );


        return json({
            ok: true,
            user:
                sanitizeUser(user)
        });


    } catch (error) {

        console.error(
            "Link Telegram error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Failed to link Telegram"
            },
            500
        );
    }
}


/*
 * ============================================================
 * CURRENT AUTH
 * ============================================================
 */

async function getCurrentAuth(
    request,
    env
) {

    const sessionAuth =
        await getSessionAuth(
            request,
            env
        );


    if (sessionAuth.ok) {
        return sessionAuth;
    }


    /*
     * Если это старый Telegram Bearer initData,
     * сохраняем совместимость.
     */

    const telegramAuth =
        await getTelegramUser(
            request,
            env
        );


    if (telegramAuth.ok) {

        if (
            env.DB &&
            telegramAuth.user?.id
        ) {

            const user =
                await upsertTelegramUser(
                    env.DB,
                    telegramAuth.user
                );


            return {
                ok: true,
                type: "telegram",
                user
            };
        }


        return {
            ok: true,
            type: "telegram",
            user:
                telegramAuth.user
        };
    }


    return {
        ok: false,
        error:
            "Authorization required"
    };
}


/*
 * ============================================================
 * SESSION AUTH
 * ============================================================
 */

async function getSessionAuth(
    request,
    env
) {

    if (!env.DB) {
        return {
            ok: false,
            error:
                "Database is not configured"
        };
    }


    const token =
        getBearerToken(
            request
        );


    if (!token) {
        return {
            ok: false,
            error:
                "Authorization required"
        };
    }


    const tokenHash =
        await sha256Hex(
            token
        );


    const session =
        await env.DB.prepare(`
            SELECT
                s.id AS session_id,
                s.expires_at,
                u.*
            FROM auth_sessions s
            JOIN users u
                ON u.id = s.user_id
            WHERE s.token_hash = ?
            LIMIT 1
        `)
            .bind(tokenHash)
            .first();


    if (!session) {
        return {
            ok: false,
            error:
                "Invalid session"
        };
    }


    if (
        Number(session.is_active) !== 1
    ) {

        return {
            ok: false,
            error:
                "Account is disabled"
        };
    }


    const expires =
        new Date(
            session.expires_at
        ).getTime();


    if (
        !Number.isFinite(expires) ||
        expires <= Date.now()
    ) {

        await env.DB.prepare(`
            DELETE FROM auth_sessions
            WHERE id = ?
        `)
            .bind(
                session.session_id
            )
            .run();


        return {
            ok: false,
            error:
                "Session expired"
        };
    }


    return {
        ok: true,
        type: "session",
        user: session
    };
}


/*
 * ============================================================
 * SESSION CREATION
 * ============================================================
 */

async function createSession(
    db,
    userId
) {

    const token =
        randomToken(
            32
        );


    const tokenHash =
        await sha256Hex(
            token
        );


    /*
     * 30 дней.
     */

    const expiresAt =
        new Date(
            Date.now() +
            30 * 24 * 60 * 60 * 1000
        ).toISOString();


    const createdAt =
        new Date().toISOString();


    /*
     * Удаляем старые сессии
     * пользователя.
     *
     * Оставляем максимум 5.
     */

    const oldSessions =
        await db.prepare(`
            SELECT id
            FROM auth_sessions
            WHERE user_id = ?
            ORDER BY created_at DESC
        `)
            .bind(userId)
            .all();


    const old =
        oldSessions.results || [];


    if (old.length >= 5) {

        const toDelete =
            old
                .slice(4)
                .map(
                    row =>
                        row.id
                );


        for (const id of toDelete) {

            await db.prepare(`
                DELETE FROM auth_sessions
                WHERE id = ?
            `)
                .bind(id)
                .run();
        }
    }


    await db.prepare(`
        INSERT INTO auth_sessions
        (
            user_id,
            token_hash,
            expires_at,
            created_at
        )
        VALUES (?, ?, ?, ?)
    `)
        .bind(
            userId,
            tokenHash,
            expiresAt,
            createdAt
        )
        .run();


    return {
        token,
        expiresAt
    };
}


/*
 * ============================================================
 * USER HELPERS
 * ============================================================
 */

async function getUserById(
    db,
    id
) {

    if (!id) {
        return null;
    }


    return await db.prepare(`
        SELECT *
        FROM users
        WHERE id = ?
        LIMIT 1
    `)
        .bind(id)
        .first();
}


function sanitizeUser(
    user
) {

    if (!user) {
        return null;
    }


    return {
        id:
            user.id,

        telegram_user_id:
            user.telegram_user_id ||
            null,

        username:
            user.username ||
            null,

        first_name:
            user.first_name ||
            null,

        last_name:
            user.last_name ||
            null,

        role:
            user.role ||
            "user",

        is_active:
            Number(
                user.is_active
            ) === 1,

        created_at:
            user.created_at ||
            null
    };
}


function normalizeUsername(
    value
) {

    return String(
        value || ""
    )
        .trim()
        .toLowerCase();
}


function isValidUsername(
    username
) {

    return /^[a-z0-9_.-]{3,32}$/.test(
        username
    );
}


/*
 * ============================================================
 * PASSWORD HASHING
 * ============================================================
 *
 * PBKDF2
 * SHA-256
 * 120000 iterations
 *
 * Пароль никогда не хранится
 * в открытом виде.
 */

async function hashPassword(
    password
) {

    const encoder =
        new TextEncoder();


    const salt =
        new Uint8Array(
            16
        );


    crypto.getRandomValues(
        salt
    );


    const key =
        await crypto.subtle.importKey(
            "raw",
            encoder.encode(password),
            {
                name:
                    "PBKDF2"
            },
            false,
            [
                "deriveBits"
            ]
        );


    const bits =
        await crypto.subtle.deriveBits(
            {
                name:
                    "PBKDF2",

                salt,

                iterations:
                    120000,

                hash:
                    "SHA-256"
            },
            key,
            256
        );


    return {
        salt:
            bytesToBase64(salt),

        hash:
            bytesToBase64(
                new Uint8Array(bits)
            )
    };
}


async function verifyPassword(
    password,
    storedHash,
    storedSalt
) {

    if (
        !storedHash ||
        !storedSalt
    ) {
        return false;
    }


    try {

        const encoder =
            new TextEncoder();


        const salt =
            base64ToBytes(
                storedSalt
            );


        const key =
            await crypto.subtle.importKey(
                "raw",
                encoder.encode(password),
                {
                    name:
                        "PBKDF2"
                },
                false,
                [
                    "deriveBits"
                ]
            );


        const bits =
            await crypto.subtle.deriveBits(
                {
                    name:
                        "PBKDF2",

                    salt,

                    iterations:
                        120000,

                    hash:
                        "SHA-256"
                },
                key,
                256
            );


        const calculated =
            new Uint8Array(bits);


        const expected =
            base64ToBytes(
                storedHash
            );


        return timingSafeBytesEqual(
            calculated,
            expected
        );

    } catch (error) {

        console.error(
            "Password verification error:",
            error
        );

        return false;
    }
}


/*
 * ============================================================
 * CRYPTO HELPERS
 * ============================================================
 */

async function sha256Hex(
    value
) {

    const encoder =
        new TextEncoder();


    const buffer =
        await crypto.subtle.digest(
            "SHA-256",
            encoder.encode(
                value
            )
        );


    return bytesToHex(
        new Uint8Array(
            buffer
        )
    );
}


function randomToken(
    byteLength = 32
) {

    const bytes =
        new Uint8Array(
            byteLength
        );


    crypto.getRandomValues(
        bytes
    );


    return bytesToBase64Url(
        bytes
    );
}


function bytesToBase64(
    bytes
) {

    let binary = "";

    for (
        const byte of bytes
    ) {
        binary +=
            String.fromCharCode(
                byte
            );
    }


    return btoa(binary);
}


function base64ToBytes(
    value
) {

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


function bytesToBase64Url(
    bytes
) {

    return bytesToBase64(
        bytes
    )
        .replaceAll(
            "+",
            "-"
        )
        .replaceAll(
            "/",
            "_"
        )
        .replaceAll(
            "=",
            ""
        );
}


function timingSafeBytesEqual(
    a,
    b
) {

    if (
        a.length !== b.length
    ) {
        return false;
    }


    let result = 0;


    for (
        let i = 0;
        i < a.length;
        i++
    ) {

        result |=
            a[i] ^
            b[i];
    }


    return result === 0;
}


/*
 * ============================================================
 * BEARER
 * ============================================================
 */

function getBearerToken(
    request
) {

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


    return header
        .slice(7)
        .trim() ||
        null;
}


/*
 * ============================================================
 * TELEGRAM USER FROM REQUEST
 * ============================================================
 */

async function getTelegramUser(
    request,
    env
) {

    if (!env.TELEGRAM_BOT_TOKEN) {
        return {
            ok: false,
            error:
                "Telegram bot token is not configured"
        };
    }


    const authHeader =
        request.headers.get(
            "Authorization"
        );


    if (!authHeader) {
        return {
            ok: false,
            error:
                "Authorization header is missing"
        };
    }


    if (
        !authHeader.startsWith(
            "Bearer "
        )
    ) {
        return {
            ok: false,
            error:
                "Invalid authorization header"
        };
    }


    const initData =
        authHeader.slice(7);


    if (!initData) {
        return {
            ok: false,
            error:
                "Telegram initData is missing"
        };
    }


    return verifyTelegramInitData(
        initData,
        env.TELEGRAM_BOT_TOKEN
    );
}


/*
 * ============================================================
 * TRIBUTE WEBHOOK
 * ============================================================
 */

async function handleTributeWebhook(
    request,
    env
) {

    try {

        if (!env.TRIBUTE_API_KEY) {

            console.error(
                "Tribute webhook received but TRIBUTE_API_KEY is missing"
            );


            return json(
                {
                    ok: false,
                    error:
                        "Tribute API key is not configured"
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
                    error:
                        "Tribute signature is missing"
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

            console.error(
                "Invalid Tribute webhook signature"
            );


            return json(
                {
                    ok: false,
                    error:
                        "Invalid webhook signature"
                },
                401
            );
        }


        let event;


        try {

            event =
                JSON.parse(
                    rawBody
                );

        } catch (error) {

            return json(
                {
                    ok: false,
                    error:
                        "Invalid webhook JSON"
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
                status:
                    "ignored",
                event:
                    event?.name ||
                    null
            });
        }


        const payload =
            event?.payload;


        if (!payload) {

            return json(
                {
                    ok: false,
                    error:
                        "Tribute payload is missing"
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


        if (!productId) {

            return json(
                {
                    ok: false,
                    error:
                        "Tribute product_id is missing"
                },
                400
            );
        }


        if (!telegramUserId) {

            return json(
                {
                    ok: false,
                    error:
                        "Tribute telegram_user_id is missing"
                },
                400
            );
        }


        if (!env.DB) {

            return json(
                {
                    ok: false,
                    error:
                        "Database is not configured"
                },
                500
            );
        }


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
                status:
                    "already_processed",
                event_id:
                    eventId
            });
        }


        await env.DB.prepare(`
            INSERT INTO tribute_webhook_events
            (
                event_id,
                event_name,
                product_id,
                telegram_user_id,
                purchase_id,
                transaction_id,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `)
            .bind(
                eventId,
                event.name,
                String(productId),
                String(telegramUserId),
                purchaseId
                    ? String(
                        purchaseId
                    )
                    : null,
                transactionId
                    ? String(
                        transactionId
                    )
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

            console.warn(
                "Tribute product is not mapped:",
                productId
            );


            return json({
                ok: true,
                status:
                    "received",
                access:
                    "not_mapped",
                product_id:
                    productId,
                telegram_user_id:
                    telegramUserId,
                event_id:
                    eventId
            });
        }


        await env.DB.prepare(`
            INSERT OR IGNORE INTO user_programs
            (
                telegram_user_id,
                program_id,
                tribute_product_id,
                purchase_id,
                granted_at
            )
            VALUES (?, ?, ?, ?, datetime('now'))
        `)
            .bind(
                String(
                    telegramUserId
                ),
                String(
                    mapping.program_id
                ),
                String(
                    productId
                ),
                purchaseId
                    ? String(
                        purchaseId
                    )
                    : null
            )
            .run();


        /*
         * Если Telegram-пользователь уже существует
         * в users — ничего дополнительно делать не нужно.
         *
         * Если нет — создаём техническую запись,
         * чтобы покупка была связана с аккаунтом.
         */

        const existingUser =
            await env.DB.prepare(`
                SELECT id
                FROM users
                WHERE telegram_user_id = ?
                LIMIT 1
            `)
                .bind(
                    String(
                        telegramUserId
                    )
                )
                .first();


        if (!existingUser) {

            const now =
                new Date()
                    .toISOString();


            await env.DB.prepare(`
                INSERT OR IGNORE INTO users
                (
                    telegram_user_id,
                    role,
                    is_active,
                    created_at,
                    updated_at
                )
                VALUES (?, 'user', 1, ?, ?)
            `)
                .bind(
                    String(
                        telegramUserId
                    ),
                    now,
                    now
                )
                .run();
        }


        return json({
            ok: true,
            status:
                "processed",
            access:
                "granted",
            product_id:
                productId,
            telegram_user_id:
                telegramUserId,
            program_id:
                mapping.program_id,
            purchase_id:
                purchaseId ||
                null,
            event_id:
                eventId
        });


    } catch (error) {

        console.error(
            "Tribute webhook error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Failed to process Tribute webhook"
            },
            500
        );
    }
}


/*
 * ============================================================
 * TRIBUTE SIGNATURE
 * ============================================================
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
                encoder.encode(
                    apiKey
                ),
                {
                    name:
                        "HMAC",
                    hash:
                        "SHA-256"
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
                encoder.encode(
                    rawBody
                )
            );


        const expectedSignature =
            bytesToHex(
                new Uint8Array(
                    signatureBuffer
                )
            );


        return timingSafeEqual(
            expectedSignature
                .toLowerCase(),

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
 * ============================================================
 * TRIBUTE TABLES
 * ============================================================
 */

async function ensureTributeTables(
    db
) {

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
 * ============================================================
 * LESSONS
 * ============================================================
 */

async function handleLessons(
    request,
    env
) {

    const auth =
        await getCurrentAuth(
            request,
            env
        );


    if (!auth.ok) {

        return json(
            {
                ok: false,
                error:
                    auth.error
            },
            401
        );
    }


    if (!env.DB) {

        return json({
            ok: true,
            lessons: [],
            completedLessonIds: []
        });
    }


    try {

        /*
         * Для совместимости с существующей системой
         * используем Telegram ID, если он есть.
         *
         * Для обычного аккаунта используем:
         *
         * user:<id>
         */

        const userKey =
            getUserProgressKey(
                auth.user
            );


        const lessonsResult =
            await env.DB.prepare(`
                SELECT
                    id,
                    title,
                    description,
                    content_text,
                    video_url,
                    audio_url
                FROM lessons
                WHERE is_active = 1
                ORDER BY sort_order ASC, id ASC
            `)
                .all();


        const progressResult =
            await env.DB.prepare(`
                SELECT lesson_id
                FROM lesson_progress
                WHERE telegram_user_id = ?
            `)
                .bind(userKey)
                .all();


        const completedLessonIds =
            (
                progressResult.results ||
                []
            )
                .map(
                    row =>
                        Number(
                            row.lesson_id
                        )
                );


        return json({
            ok: true,

            lessons:
                lessonsResult.results ||
                [],

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
                error:
                    "Failed to load lessons"
            },
            500
        );
    }
}


/*
 * ============================================================
 * PROGRESS
 * ============================================================
 */

async function handleProgress(
    request,
    env
) {

    const auth =
        await getCurrentAuth(
            request,
            env
        );


    if (!auth.ok) {

        return json(
            {
                ok: false,
                error:
                    auth.error
            },
            401
        );
    }


    if (!env.DB) {

        return json(
            {
                ok: false,
                error:
                    "Database is not configured"
            },
            500
        );
    }


    try {

        const body =
            await request.json();


        const lessonId =
            Number(
                body?.lessonId
            );


        if (!lessonId) {

            return json(
                {
                    ok: false,
                    error:
                        "lessonId is required"
                },
                400
            );
        }


        const userKey =
            getUserProgressKey(
                auth.user
            );


        await env.DB.prepare(`
            INSERT OR IGNORE INTO lesson_progress
            (
                telegram_user_id,
                lesson_id,
                completed_at
            )
            VALUES (?, ?, datetime('now'))
        `)
            .bind(
                userKey,
                lessonId
            )
            .run();


        return json({
            ok: true,
            completed:
                true
        });


    } catch (error) {

        console.error(
            "Progress error:",
            error
        );


        return json(
            {
                ok: false,
                error:
                    "Failed to save progress"
            },
            500
        );
    }
}


/*
 * ============================================================
 * PROGRESS KEY
 * ============================================================
 */

function getUserProgressKey(
    user
) {

    if (
        user?.telegram_user_id
    ) {

        return String(
            user.telegram_user_id
        );
    }


    return `user:${user.id}`;
}


/*
 * ============================================================
 * JSON
 * ============================================================
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
 * ============================================================
 * CORS
 * ============================================================
 */

function corsHeaders() {

    return {

        "Access-Control-Allow-Origin":
            "*",

        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
    };
}


/*
 * ============================================================
 * SIMPLE HEX
 * ============================================================
 */

function bytesToHex(
    bytes
) {

    return Array.from(
        bytes
    )
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(
                        2,
                        "0"
                    )
        )
        .join("");
}


/*
 * ============================================================
 * TIMING SAFE STRING
 * ============================================================
 */

function timingSafeEqual(
    a,
    b
) {

    if (
        a.length !== b.length
    ) {
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
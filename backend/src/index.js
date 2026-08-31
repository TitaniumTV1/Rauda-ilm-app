import { verifyTelegramInitData } from "./telegram.js";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        /*
         * CORS
         */
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        /*
         * DEBUG CONFIG
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
         * HEALTH
         */
        if (
            url.pathname === "/api/health" &&
            request.method === "GET"
        ) {
            return json({
                ok: true,
                app: env.APP_NAME || "RAUDA ILM",
                database: !!env.DB
            });
        }

        /*
         * TELEGRAM AUTHENTICATION
         */
        if (
            url.pathname === "/api/auth/telegram" &&
            request.method === "POST"
        ) {
            return handleTelegramAuth(request, env);
        }

        /*
         * TRIBUTE WEBHOOK
         *
         * Tribute sends:
         *
         * POST /api/webhooks/tribute
         *
         * Header:
         * trbt-signature
         *
         * Signature:
         * HMAC-SHA256(body, TRIBUTE_API_KEY)
         */
        if (
            url.pathname === "/api/webhooks/tribute" &&
            request.method === "POST"
        ) {
            return handleTributeWebhook(request, env);
        }

        /*
         * LESSONS
         */
        if (
            url.pathname === "/api/lessons" &&
            request.method === "GET"
        ) {
            return handleLessons(request, env);
        }

        /*
         * PROGRESS
         */
        if (
            url.pathname === "/api/progress" &&
            request.method === "POST"
        ) {
            return handleProgress(request, env);
        }

        /*
         * FRONTEND
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
 * ============================
 * TELEGRAM AUTH
 * ============================
 */

async function handleTelegramAuth(request, env) {
    try {
        if (!env.TELEGRAM_BOT_TOKEN) {
            return json(
                {
                    ok: false,
                    error: "Telegram bot token is not configured"
                },
                500
            );
        }

        const body = await request.json();

        const initData = body?.initData;

        if (!initData) {
            return json(
                {
                    ok: false,
                    error: "Telegram initData is missing"
                },
                400
            );
        }

        const verification = await verifyTelegramInitData(
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

        return json({
            ok: true,
            user: verification.user
        });

    } catch (error) {
        console.error("Telegram auth error:", error);

        return json(
            {
                ok: false,
                error: "Invalid JSON request"
            },
            400
        );
    }
}


/*
 * ============================
 * TELEGRAM USER FROM REQUEST
 * ============================
 */

async function getTelegramUser(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return {
            ok: false,
            error: "Telegram bot token is not configured"
        };
    }

    const authHeader = request.headers.get("Authorization");

    if (!authHeader) {
        return {
            ok: false,
            error: "Authorization header is missing"
        };
    }

    if (!authHeader.startsWith("Bearer ")) {
        return {
            ok: false,
            error: "Invalid authorization header"
        };
    }

    const initData = authHeader.slice(7);

    if (!initData) {
        return {
            ok: false,
            error: "Telegram initData is missing"
        };
    }

    return verifyTelegramInitData(
        initData,
        env.TELEGRAM_BOT_TOKEN
    );
}


/*
 * ============================
 * TRIBUTE WEBHOOK
 * ============================
 */

async function handleTributeWebhook(request, env) {
    try {
        if (!env.TRIBUTE_API_KEY) {
            console.error(
                "Tribute webhook received but TRIBUTE_API_KEY is missing"
            );

            return json(
                {
                    ok: false,
                    error: "Tribute API key is not configured"
                },
                500
            );
        }

        /*
         * Очень важно:
         * сначала читаем RAW body,
         * потом проверяем подпись.
         *
         * Нельзя сначала делать request.json(),
         * потому что подпись рассчитывается от исходного тела.
         */
        const rawBody = await request.text();

        const signature =
            request.headers.get("trbt-signature");

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
            console.error(
                "Invalid Tribute webhook signature"
            );

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
            event = JSON.parse(rawBody);
        } catch (error) {
            return json(
                {
                    ok: false,
                    error: "Invalid webhook JSON"
                },
                400
            );
        }

        /*
         * Проверяем тип события.
         */
        if (event?.name !== "new_digital_product") {
            /*
             * Мы пока принимаем неизвестные события,
             * чтобы Tribute не делал лишние повторы.
             */
            return json({
                ok: true,
                status: "ignored",
                event: event?.name || null
            });
        }

        const payload = event?.payload;

        if (!payload) {
            return json(
                {
                    ok: false,
                    error: "Tribute payload is missing"
                },
                400
            );
        }

        const productId = payload?.product_id;
        const telegramUserId =
            payload?.telegram_user_id;

        const purchaseId = payload?.purchase_id;
        const transactionId =
            payload?.transaction_id;

        if (!productId) {
            return json(
                {
                    ok: false,
                    error: "Tribute product_id is missing"
                },
                400
            );
        }

        if (!telegramUserId) {
            return json(
                {
                    ok: false,
                    error: "Tribute telegram_user_id is missing"
                },
                400
            );
        }

        /*
         * Для работы выдачи доступа нужна D1.
         */
        if (!env.DB) {
            console.error(
                "Tribute webhook: database is not configured"
            );

            return json(
                {
                    ok: false,
                    error: "Database is not configured"
                },
                500
            );
        }

        /*
         * Создаём необходимые таблицы автоматически,
         * если их ещё нет.
         */
        await ensureTributeTables(env.DB);

        /*
         * ИДЕМПОТЕНТНОСТЬ
         *
         * Tribute может повторно отправить webhook.
         *
         * Сначала проверяем purchase_id.
         */
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

        /*
         * Сохраняем событие ДО выдачи доступа.
         *
         * Это защищает от повторного выполнения.
         */
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
                    ? String(purchaseId)
                    : null,
                transactionId
                    ? String(transactionId)
                    : null
            )
            .run();

        /*
         * Ищем, к какой образовательной программе
         * привязан Tribute Product.
         */
        const mapping =
            await env.DB.prepare(`
                SELECT
                    tribute_product_id,
                    program_id
                FROM tribute_product_programs
                WHERE tribute_product_id = ?
                LIMIT 1
            `)
                .bind(String(productId))
                .first();

        /*
         * Если администратор ещё не связал товар
         * с программой, webhook всё равно считается
         * полученным.
         */
        if (!mapping) {
            console.warn(
                "Tribute product is not mapped:",
                productId
            );

            return json({
                ok: true,
                status: "received",
                access: "not_mapped",
                product_id: productId,
                telegram_user_id: telegramUserId,
                event_id: eventId
            });
        }

        /*
         * Выдаём пользователю программу.
         */
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
                String(telegramUserId),
                String(mapping.program_id),
                String(productId),
                purchaseId
                    ? String(purchaseId)
                    : null
            )
            .run();

        console.log(
            "Tribute access granted:",
            {
                telegramUserId,
                productId,
                programId: mapping.program_id,
                purchaseId
            }
        );

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
 * ============================
 * TRIBUTE SIGNATURE
 * ============================
 *
 * Tribute:
 *
 * HMAC-SHA256(request body, API key)
 *
 * Result is compared with:
 *
 * trbt-signature
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
                ["sign"]
            );

        const signatureBuffer =
            await crypto.subtle.sign(
                "HMAC",
                key,
                encoder.encode(rawBody)
            );

        const expectedSignature =
            bytesToHex(
                new Uint8Array(signatureBuffer)
            );

        /*
         * Иногда системы передают подпись
         * в разных регистрах.
         *
         * Сравниваем без учёта регистра.
         */
        return timingSafeEqual(
            expectedSignature.toLowerCase(),
            String(receivedSignature).trim().toLowerCase()
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
 * ============================
 * HEX
 * ============================
 */

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
 * ============================
 * TIMING SAFE COMPARE
 * ============================
 */

function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;

    for (let i = 0; i < a.length; i++) {
        result |=
            a.charCodeAt(i) ^
            b.charCodeAt(i);
    }

    return result === 0;
}


/*
 * ============================
 * TRIBUTE DATABASE TABLES
 * ============================
 */

async function ensureTributeTables(db) {
    /*
     * Связь:
     *
     * Tribute Product ID
     *        ↓
     * Educational Program ID
     */
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS tribute_product_programs (
            tribute_product_id TEXT PRIMARY KEY,
            program_id TEXT NOT NULL
        )
    `).run();

    /*
     * Выданные пользователям программы.
     */
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

    /*
     * Обработанные webhook.
     */
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

    /*
     * Индекс для быстрого поиска программ пользователя.
     */
    await db.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_user_programs_telegram_user
        ON user_programs(telegram_user_id)
    `).run();
}


/*
 * ============================
 * LESSONS
 * ============================
 */

async function handleLessons(request, env) {
    const auth =
        await getTelegramUser(request, env);

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            401
        );
    }

    /*
     * Если D1 ещё не подключена,
     * возвращаем пустой список.
     */
    if (!env.DB) {
        return json({
            ok: true,
            lessons: [],
            completedLessonIds: []
        });
    }

    try {
        const userId =
            String(auth.user.id);

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
            `).all();

        const progressResult =
            await env.DB.prepare(`
                SELECT lesson_id
                FROM lesson_progress
                WHERE telegram_user_id = ?
            `)
                .bind(userId)
                .all();

        const completedLessonIds =
            (progressResult.results || [])
                .map(
                    row =>
                        Number(row.lesson_id)
                );

        return json({
            ok: true,
            lessons:
                lessonsResult.results || [],
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
 * ============================
 * PROGRESS
 * ============================
 */

async function handleProgress(request, env) {
    const auth =
        await getTelegramUser(request, env);

    if (!auth.ok) {
        return json(
            {
                ok: false,
                error: auth.error
            },
            401
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

    try {
        const body =
            await request.json();

        const lessonId =
            Number(body?.lessonId);

        if (!lessonId) {
            return json(
                {
                    ok: false,
                    error: "lessonId is required"
                },
                400
            );
        }

        const userId =
            String(auth.user.id);

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
                userId,
                lessonId
            )
            .run();

        return json({
            ok: true,
            completed: true
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
 * ============================
 * JSON RESPONSE
 * ============================
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
 * ============================
 * CORS
 * ============================
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
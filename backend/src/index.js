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
                assets: !!env.ASSETS
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
         *
         * Frontend sends:
         *
         * POST /api/auth/telegram
         *
         * {
         *   "initData": "..."
         * }
         */
        if (
            url.pathname === "/api/auth/telegram" &&
            request.method === "POST"
        ) {
            return handleTelegramAuth(request, env);
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
 * LESSONS
 * ============================
 */

async function handleLessons(request, env) {
    const auth = await getTelegramUser(request, env);

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
        const userId = String(auth.user.id);

        const lessonsResult = await env.DB.prepare(`
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

        const progressResult = await env.DB.prepare(`
            SELECT lesson_id
            FROM lesson_progress
            WHERE telegram_user_id = ?
        `)
            .bind(userId)
            .all();

        const completedLessonIds =
            (progressResult.results || []).map(
                row => Number(row.lesson_id)
            );

        return json({
            ok: true,
            lessons: lessonsResult.results || [],
            completedLessonIds
        });

    } catch (error) {
        console.error("Lessons error:", error);

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
    const auth = await getTelegramUser(request, env);

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
        const body = await request.json();

        const lessonId = Number(body?.lessonId);

        if (!lessonId) {
            return json(
                {
                    ok: false,
                    error: "lessonId is required"
                },
                400
            );
        }

        const userId = String(auth.user.id);

        await env.DB.prepare(`
            INSERT OR IGNORE INTO lesson_progress
            (
                telegram_user_id,
                lesson_id,
                completed_at
            )
            VALUES (?, ?, datetime('now'))
        `)
            .bind(userId, lessonId)
            .run();

        return json({
            ok: true,
            completed: true
        });

    } catch (error) {
        console.error("Progress error:", error);

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

function json(data, status = 200) {
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
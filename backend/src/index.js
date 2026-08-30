import { verifyTelegramInitData } from "./telegram.js";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS / Telegram Web App
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        // Проверка конфигурации
        if (url.pathname === "/api/debug-config") {
            return json({
                ok: true,
                app: env.APP_NAME || "RAUDA ILM",
                telegram_bot_token: !!env.TELEGRAM_BOT_TOKEN,
                database: !!env.DB,
                assets: !!env.ASSETS
            });
        }
// Telegram auth diagnostic
if (
    url.pathname === "/api/auth-debug" &&
    request.method === "POST"
) {
    try {
        const body = await request.json();
        const initData = body?.initData || "";

        const params = new URLSearchParams(initData);

        return json({
            ok: true,
            initData_received: !!initData,
            initData_length: initData.length,
            has_hash: params.has("hash"),
            hash_length: params.get("hash")?.length || 0,
            has_user: params.has("user"),
            user_length: params.get("user")?.length || 0,
            has_auth_date: params.has("auth_date"),
            has_query_id: params.has("query_id"),
            bot_token_configured: !!env.TELEGRAM_BOT_TOKEN,
            bot_token_length:
                env.TELEGRAM_BOT_TOKEN?.length || 0
        });

    } catch (error) {
        return json({
            ok: false,
            error: "Invalid diagnostic request"
        }, 400);
    }
}
        // Telegram authentication
        if (
            url.pathname === "/api/auth/telegram" &&
            request.method === "POST"
        ) {
            try {
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

                if (!env.TELEGRAM_BOT_TOKEN) {
                    return json(
                        {
                            ok: false,
                            error: "Telegram bot token is not configured"
                        },
                        500
                    );
                }

console.log("TELEGRAM AUTH CHECK", {
    initDataLength: initData.length,
    hasHash: new URLSearchParams(initData).has("hash"),
    hasUser: new URLSearchParams(initData).has("user"),
    hasAuthDate: new URLSearchParams(initData).has("auth_date"),
    tokenLength: env.TELEGRAM_BOT_TOKEN?.length || 0
});
                const verification =
                    await verifyTelegramInitData(
                        initData,
                        env.TELEGRAM_BOT_TOKEN
                    );

                if (!verification.ok) {
                    return json(
                        {
                            ok: false,
                            error: verification.error ||
                                "Invalid Telegram authentication"
                        },
                        401
                    );
                }

                const user = verification.user;

                return json({
                    ok: true,
                    user
                });
            } catch (error) {
                console.error(
                    "Telegram auth error:",
                    error
                );

                return json(
                    {
                        ok: false,
                        error: "Invalid JSON request"
                    },
                    400
                );
            }
        }

        // Health check
        if (url.pathname === "/api/health") {
            return json({
                ok: true,
                app: env.APP_NAME || "RAUDA ILM",
                database: !!env.DB
            });
        }

        // Frontend
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
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


function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type"
    };
}
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/debug-config") {
            return new Response(
                JSON.stringify({
                    ok: true,
                    version: "RAUDA-DEBUG-001",
                    telegram_bot_token: !!env.TELEGRAM_BOT_TOKEN,
                    telegram_bot_token_length:
                        env.TELEGRAM_BOT_TOKEN?.length || 0,
                    database: !!env.DB,
                    assets: !!env.ASSETS,
                    app: env.APP_NAME || null
                }),
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );
        }

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
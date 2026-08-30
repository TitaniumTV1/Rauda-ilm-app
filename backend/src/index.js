if (url.pathname === "/api/debug-config") {
    return json({
        ok: true,
        version: "DEBUG-2026-08-30-01",
        telegram_bot_token: !!env.TELEGRAM_BOT_TOKEN,
        telegram_bot_token_length: env.TELEGRAM_BOT_TOKEN?.length || 0,
        database: !!env.DB,
        assets: !!env.ASSETS,
        app: env.APP_NAME || null
    });
}
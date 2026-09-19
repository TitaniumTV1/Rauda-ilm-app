const FLAG = "telegram_webhook_secured";
const SETUP_PATH = "/api/ops/telegram-webhook";
const WEBHOOK_PATH = "/api/webhooks/telegram";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const encoder = new TextEncoder();

function validSecret(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

async function equalSecrets(actual, expected) {
    const [left, right] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(actual)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected))
    ]);
    if (typeof crypto.subtle.timingSafeEqual === "function") {
        // Workers' native extension compares equal-length hashes in constant time.
        return crypto.subtle.timingSafeEqual(left, right);
    }
    // Standard WebCrypto runtimes (including local Node tests) do not expose
    // timingSafeEqual. Delegate comparison to native HMAC verification instead
    // of comparing secret strings or relying on a JavaScript byte loop.
    const key = await crypto.subtle.importKey("raw", encoder.encode("rauda-ilm-hash-comparison"),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const signature = await crypto.subtle.sign("HMAC", key, left);
    return crypto.subtle.verify("HMAC", key, signature, right);
}

function response(body, status = 200, headers = {}) {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function webhookUrl(env) {
    const base = new URL(env.PUBLIC_APP_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
        base.pathname !== "/" || (base.port && !["443", "80", "88", "8443"].includes(base.port))) {
        throw new Error("Webhook URL configuration is invalid");
    }
    return `${base.origin}${WEBHOOK_PATH}`;
}

async function telegram(env, method, payload = {}) {
    // Neither provider error bodies nor token-bearing URLs escape this helper.
    try {
        if (!env.TELEGRAM_BOT_TOKEN) throw new Error();
        const result = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await result.json();
        if (!result.ok || data?.ok !== true) throw new Error();
        return data.result;
    } catch {
        throw new Error("Telegram webhook operation failed");
    }
}

export async function verifyTelegramWebhook(request, env) {
    if (request.method !== "POST" || !env.DB) return false;
    try {
        const table = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'"
        ).first();
        if (!table) return true;
        const flag = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(FLAG).first();
        // The one-time rollout retains existing traffic only before activation.
        if (!flag) return true;
        if (String(flag.value) !== "1" || !validSecret(env.TELEGRAM_WEBHOOK_SECRET)) return false;
        const supplied = request.headers.get(SECRET_HEADER);
        if (!validSecret(supplied)) return false;
        return await equalSecrets(supplied, env.TELEGRAM_WEBHOOK_SECRET);
    } catch {
        // Never treat an unavailable or malformed configuration as legacy mode.
        return false;
    }
}

export async function getTelegramWebhookInfo(env) {
    const expected = webhookUrl(env);
    const result = await telegram(env, "getWebhookInfo");
    if (!result || typeof result.url !== "string" || !Number.isSafeInteger(result.pending_update_count) || result.pending_update_count < 0) {
        throw new Error("Telegram webhook status is invalid");
    }
    // An unexpected old webhook URL might itself contain credentials. Only
    // return the known canonical URL; do not expose last_error_message or IPs.
    return { url: result.url === expected ? expected : null, pending_update_count: result.pending_update_count };
}

export async function handleTelegramWebhookSetup(request, env) {
    if (new URL(request.url).pathname !== SETUP_PATH) return response({ ok: false, error: "Not found" }, 404);
    if (request.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });
    if (!validSecret(env.TELEGRAM_WEBHOOK_SETUP_KEY)) return response({ ok: false, error: "Not found" }, 404);
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/i.exec(request.headers.get("Authorization") || "");
    if (!match || !await equalSecrets(match[1], env.TELEGRAM_WEBHOOK_SETUP_KEY)) {
        return response({ ok: false, error: "Unauthorized" }, 401);
    }
    let url;
    try {
        if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !validSecret(env.TELEGRAM_WEBHOOK_SECRET)) throw new Error();
        url = webhookUrl(env);
        // Check D1 availability before altering the remote webhook. No activation
        // row is written until Telegram confirms that setWebhook succeeded.
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`).run();
    } catch {
        return response({ ok: false, error: "Webhook configuration is unavailable" }, 503);
    }
    try {
        const accepted = await telegram(env, "setWebhook", {
            url,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: false
        });
        if (accepted !== true) throw new Error();
    } catch {
        return response({ ok: false, error: "Telegram did not confirm webhook setup" }, 502);
    }
    try {
        await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP`).bind(FLAG).run();
    } catch {
        return response({ ok: false, error: "Webhook was configured but protection could not be persisted. Retry setup." }, 503);
    }
    let info = null;
    try { info = await getTelegramWebhookInfo(env); } catch { /* Protection remains active; setup can safely be repeated. */ }
    return response({ ok: true, secured: true, url, pending_update_count: info?.pending_update_count ?? null, verified: info?.url === url });
}

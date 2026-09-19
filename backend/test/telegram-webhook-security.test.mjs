import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";
import { verifyTelegramWebhook, handleTelegramWebhookSetup, getTelegramWebhookInfo } from "../src/telegram-webhook-security.js";

const FLAG = "telegram_webhook_secured";
const SETUP_URL = "https://preview.school.test/api/ops/telegram-webhook";
const HEADER = "X-Telegram-Bot-Api-Secret-Token";

function fixture(t) {
    const db = new DatabaseSync(":memory:");
    class Statement {
        constructor(sql, values = []) { Object.assign(this, { sql, values }); }
        bind(...values) { return new Statement(this.sql, values); }
        async first() { return db.prepare(this.sql).get(...this.values) || null; }
        async run() { const result = db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
    }
    const env = {
        DB: { prepare(sql) { return new Statement(sql); } },
        PUBLIC_APP_URL: "https://school.test/",
        TELEGRAM_BOT_TOKEN: "fake-bot-token",
        TELEGRAM_WEBHOOK_SECRET: "real_webhook_secret-0123456789abcdef",
        TELEGRAM_WEBHOOK_SETUP_KEY: "temporary_setup_key-0123456789abcdef"
    };
    const calls = [];
    const behavior = { rejectSet: false, wrongResult: false, network: false, infoFails: false, unexpectedUrl: false };
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(new URL(url).hostname, "api.telegram.org");
        const method = new URL(url).pathname.split("/").at(-1);
        assert.ok(["setWebhook", "getWebhookInfo"].includes(method), "Never send messages or delete the webhook");
        const payload = JSON.parse(options.body);
        calls.push({ method, payload });
        if (behavior.network) throw new Error(`Network failure for ${url}`);
        if (method === "setWebhook") {
            if (behavior.rejectSet) return Response.json({ ok: false, error_code: 400, description: `Private provider error ${env.TELEGRAM_BOT_TOKEN}` }, { status: 400 });
            return Response.json({ ok: true, result: !behavior.wrongResult });
        }
        if (behavior.infoFails) return Response.json({ ok: false }, { status: 503 });
        return Response.json({ ok: true, result: {
            url: behavior.unexpectedUrl ? `https://old.test/${env.TELEGRAM_BOT_TOKEN}` : "https://school.test/api/webhooks/telegram",
            pending_update_count: 7, last_error_message: `sensitive ${env.TELEGRAM_WEBHOOK_SECRET}`, ip_address: "192.0.2.1"
        } });
    });
    t.mock.method(console, "error", () => assert.fail("Security helpers must not log token-bearing provider errors"));
    t.after(() => db.close());
    const setupRequest = (authorization = `Bearer ${env.TELEGRAM_WEBHOOK_SETUP_KEY}`, options = {}) => new Request(SETUP_URL, {
        method: "POST", headers: authorization === null ? {} : { Authorization: authorization }, ...options
    });
    const webhook = (secret = null) => new Request("https://school.test/api/webhooks/telegram", {
        method: "POST", headers: secret === null ? {} : { [HEADER]: secret }, body: '{"message":{"from":{"id":101}}}'
    });
    function activate(value = "1") {
        db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
        db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)").run(FLAG, value);
    }
    function flag() {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE name='app_settings'").get()) return undefined;
        return db.prepare("SELECT value FROM app_settings WHERE key=?").get(FLAG)?.value;
    }
    return { db, env, calls, behavior, setupRequest, webhook, activate, flag };
}

test("legacy webhook traffic remains untouched until the activation flag exists", async t => {
    const f = fixture(t);
    assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count, 0);
    f.db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)");
    assert.equal(await verifyTelegramWebhook(f.webhook("irrelevant-before-activation"), f.env), true);
    assert.equal(f.flag(), undefined);
    assert.equal(f.calls.length, 0);
});

for (const token of [null, "", "wrong", "Bearer real_webhook_secret-0123456789abcdef", "two secrets", "bad,duplicate", "x".repeat(257)]) {
    test(`activated webhook rejects malformed or absent header (${token === null ? "missing" : token.length})`, async t => {
        const f = fixture(t);
        f.activate();
        assert.equal(await verifyTelegramWebhook(f.webhook(token), f.env), false);
    });
}

test("activated webhook accepts only the exact configured secret using standard WebCrypto", async t => {
    const f = fixture(t);
    f.activate();
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), true);
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET.toUpperCase()), f.env), false);
    delete f.env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), false);
});

test("Cloudflare timingSafeEqual receives fixed-length hashes rather than secret strings", async t => {
    const f = fixture(t);
    f.activate();
    let comparisons = 0;
    const previous = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
    Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value(left, right) {
        comparisons++;
        assert.equal(left.byteLength, 32);
        assert.equal(right.byteLength, 32);
        return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
    } });
    t.after(() => previous ? Object.defineProperty(crypto.subtle, "timingSafeEqual", previous) : delete crypto.subtle.timingSafeEqual);
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), true);
    assert.equal(await verifyTelegramWebhook(f.webhook("different-length-secret"), f.env), false);
    assert.equal(comparisons, 2);
});

test("configuration and D1 failures fail closed after activation", async t => {
    const f = fixture(t);
    f.activate("unexpected-corrupt-value");
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), false);
    f.env.DB.prepare = () => { throw new Error("D1 unavailable"); };
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), false);
    delete f.env.DB;
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), false);
});

for (const authorization of [null, "Bearer wrong", "Basic temporary_setup_key-0123456789abcdef", "Bearer first, Bearer second"]) {
    test(`setup rejects unauthorized requests without D1 writes or Telegram calls (${authorization ?? "missing"})`, async t => {
        const f = fixture(t);
        const result = await handleTelegramWebhookSetup(f.setupRequest(authorization), f.env);
        assert.equal(result.status, 401);
        assert.equal(f.calls.length, 0);
        assert.equal(f.flag(), undefined);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count, 0);
    });
}

test("successful setup on a preview URL preserves pending updates and configures only the canonical production URL", async t => {
    const f = fixture(t);
    const result = await handleTelegramWebhookSetup(f.setupRequest(undefined, { body: JSON.stringify({ url: "https://attacker.test", enabled: false, drop_pending_updates: true }) }), f.env);
    assert.equal(result.status, 200);
    assert.deepEqual(f.calls[0], { method: "setWebhook", payload: {
        url: "https://school.test/api/webhooks/telegram", secret_token: f.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"], drop_pending_updates: false
    } });
    assert.equal(f.flag(), "1");
    assert.deepEqual(await result.json(), { ok: true, secured: true, url: "https://school.test/api/webhooks/telegram", pending_update_count: 7, verified: true });
    assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), false);
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), true);
});

for (const failure of ["rejectSet", "wrongResult", "network"]) {
    test(`provider failure (${failure}) never activates the gate or exposes credentials`, async t => {
        const f = fixture(t);
        f.behavior[failure] = true;
        const result = await handleTelegramWebhookSetup(f.setupRequest(), f.env);
        assert.equal(result.status, 502);
        assert.equal(f.flag(), undefined);
        assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), true);
        const text = await result.text();
        for (const secret of [f.env.TELEGRAM_BOT_TOKEN, f.env.TELEGRAM_WEBHOOK_SECRET, f.env.TELEGRAM_WEBHOOK_SETUP_KEY, "api.telegram.org/bot"]) assert.ok(!text.includes(secret));
    });
}

test("a setup failure never disables an already active gate", async t => {
    const f = fixture(t);
    f.activate();
    f.behavior.rejectSet = true;
    assert.equal((await handleTelegramWebhookSetup(f.setupRequest(), f.env)).status, 502);
    assert.equal(f.flag(), "1");
    assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), false);
});

test("failed activation persistence is reported and a repeated setup can safely finish it", async t => {
    const f = fixture(t);
    const prepare = f.env.DB.prepare;
    f.env.DB.prepare = sql => {
        if (sql.startsWith("INSERT INTO app_settings")) throw new Error("D1 write failed");
        return prepare(sql);
    };
    const failed = await handleTelegramWebhookSetup(f.setupRequest(), f.env);
    assert.equal(failed.status, 503);
    assert.equal(f.flag(), undefined);
    assert.equal(f.calls.filter(call => call.method === "setWebhook").length, 1);
    f.env.DB.prepare = prepare;
    const retried = await handleTelegramWebhookSetup(f.setupRequest(), f.env);
    assert.equal(retried.status, 200);
    assert.equal(f.flag(), "1");
    assert.equal(await verifyTelegramWebhook(f.webhook(), f.env), false);
});

test("repeated setup is idempotent and removing the setup key closes the bootstrap endpoint", async t => {
    const f = fixture(t);
    const request = f.setupRequest();
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 200);
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 200);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE key=?").get(FLAG).count, 1);
    assert.ok(f.calls.filter(call => call.method === "setWebhook").every(call => call.payload.drop_pending_updates === false));
    const before = f.calls.length;
    delete f.env.TELEGRAM_WEBHOOK_SETUP_KEY;
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 404);
    assert.equal(f.calls.length, before);
    assert.equal(await verifyTelegramWebhook(f.webhook(f.env.TELEGRAM_WEBHOOK_SECRET), f.env), true);
});

test("missing secrets and invalid configured origins cannot alter Telegram", async t => {
    const f = fixture(t);
    const request = f.setupRequest();
    f.env.PUBLIC_APP_URL = "https://user:password@school.test";
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 503);
    f.env.PUBLIC_APP_URL = "https://school.test/unexpected-path";
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 503);
    f.env.PUBLIC_APP_URL = "http://school.test";
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 503);
    f.env.PUBLIC_APP_URL = "https://school.test";
    delete f.env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal((await handleTelegramWebhookSetup(request.clone(), f.env)).status, 503);
    assert.equal(f.calls.length, 0);
});

test("safe webhook info exposes neither credentials in unexpected URLs nor provider diagnostics", async t => {
    const f = fixture(t);
    f.behavior.unexpectedUrl = true;
    const info = await getTelegramWebhookInfo(f.env);
    assert.deepEqual(info, { url: null, pending_update_count: 7 });
    f.behavior.infoFails = true;
    const result = await handleTelegramWebhookSetup(f.setupRequest(), f.env);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, secured: true, url: "https://school.test/api/webhooks/telegram", pending_update_count: null, verified: false });
    assert.equal(f.flag(), "1");
});

test("only the POST setup route can run the bootstrap operation", async t => {
    const f = fixture(t);
    const request = f.setupRequest(undefined, { method: "GET" });
    assert.equal((await handleTelegramWebhookSetup(request, f.env)).status, 405);
    assert.equal((await handleTelegramWebhookSetup(new Request("https://school.test/api/ops/other", { method: "POST" }), f.env)).status, 404);
    assert.equal(f.calls.length, 0);
});

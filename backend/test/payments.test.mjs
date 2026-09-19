import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { createSemesterCheckout, ensurePaymentTables, getPaymentOptions, getPaymentSettings, getSemesterOrder,
    handlePaymentRequest, handleYooMoneyWebhook, processSemesterTributeEvent, updatePaymentSettings,
    verifyTributeSignature, verifyYooMoneySignature } from "../src/payments.js";

const baseSchema = readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8");
// Snapshot of the production D1 table definitions, inspected read-only. The
// repository predates these changes, so both supported shapes must execute SQL.
const liveTables = `
DROP TABLE payments;
CREATE TABLE payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,course_id INTEGER NOT NULL,amount INTEGER NOT NULL,
 currency TEXT NOT NULL DEFAULT 'KZT',status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','waiting_confirmation','paid','rejected','refunded')),
 provider TEXT NOT NULL DEFAULT 'tribute',tribute_product_id TEXT,tribute_purchase_id TEXT,tribute_subscription_id TEXT,
 payment_type TEXT NOT NULL DEFAULT 'one_time' CHECK(payment_type IN ('one_time','subscription')),
 payment_url TEXT,telegram_payment_url TEXT,webhook_event_id TEXT UNIQUE,paid_at TEXT,expires_at TEXT,raw_data TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE);
DROP TABLE user_semesters;
CREATE TABLE checkout_orders(id TEXT PRIMARY KEY);
CREATE TABLE user_semesters (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,program_id INTEGER NOT NULL,semester_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','blocked')),access_until TEXT,granted_by INTEGER,
 source_checkout_order_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,semester_id),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(program_id) REFERENCES programs(id) ON DELETE CASCADE,FOREIGN KEY(semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
 FOREIGN KEY(granted_by) REFERENCES users(id) ON DELETE SET NULL,
 FOREIGN KEY(source_checkout_order_id) REFERENCES checkout_orders(id) ON DELETE SET NULL);
CREATE TABLE semester_payment_methods (semester_id INTEGER PRIMARY KEY,yoomoney_enabled INTEGER NOT NULL DEFAULT 1,
 tribute_enabled INTEGER NOT NULL DEFAULT 0,tribute_url TEXT NOT NULL DEFAULT '');
CREATE TABLE semester_payment_grants (order_label TEXT PRIMARY KEY,user_id INTEGER NOT NULL,semester_id INTEGER NOT NULL,
 granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`;

class Statement {
    constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
    bind(...values) { return new Statement(this.db, this.sql, values); }
    execute() {
        const prepared = this.db.prepare(this.sql);
        if (prepared.columns().length) return { success: true, results: prepared.all(...this.values), meta: { changes: 0 } };
        const result = prepared.run(...this.values);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
}

async function fixture(t, live = false) {
    const db = new DatabaseSync(":memory:");
    db.exec(baseSchema);
    if (live) db.exec(liveTables);
    db.exec(`INSERT INTO users(id,telegram_id,first_name,role) VALUES(1,1001,'Owner','owner'),(2,2001,'Student','student'),(3,3001,'Other','student'),(4,4001,'Admin','admin');
        INSERT INTO courses(id,name) VALUES(1,'Курс');
        INSERT INTO programs(id,course_id,name) VALUES(1,1,'Внутренняя программа');
        INSERT INTO semesters(id,course_id,program_id,number,name,price_rub) VALUES(1,1,1,1,'Первый семестр',1500),(2,1,1,2,'Второй семестр',2000);
        CREATE TABLE telegram_learning_links(kind TEXT,id INTEGER,url TEXT,PRIMARY KEY(kind,id));
        INSERT INTO telegram_learning_links VALUES('semester',1,'https://t.me/+private-semester');`);
    const env = { TRIBUTE_API_KEY: "tribute-test-secret", YOOMONEY_WEBHOOK_SECRET: "yoo-test-secret", TELEGRAM_BOT_TOKEN: "fake-token",
        PUBLIC_APP_URL: "https://school.test", DB: { prepare(sql) { return new Statement(db, sql); },
            async batch(statements) {
                db.exec("BEGIN");
                try { const results = statements.map(statement => statement.execute()); db.exec("COMMIT"); return results; }
                catch (error) { db.exec("ROLLBACK"); throw error; }
            } } };
    const messages = [];
    const delivery = { fail: false };
    const product = { id: 123, type: "digital", status: "approved", amount: 150000, currency: "rub",
        link: "https://t.me/tribute/app?startapp=p123", webLink: "https://web.tribute.tg/p/123" };
    t.mock.method(globalThis, "fetch", async (url, options) => {
        if (new URL(url).hostname === "tribute.tg") {
            assert.equal(new URL(url).pathname, `/api/v1/products/${product.id}`);
            assert.equal(options.headers["Api-Key"], env.TRIBUTE_API_KEY);
            assert.equal(options.redirect, "error", "Credentials must never follow a redirect");
            assert.equal(options.method, undefined, "Product lookup is GET only");
            if (delivery.tributeFail) return Response.json({ error: "Unavailable" }, { status: 503 });
            return Response.json(product);
        }
        assert.equal(new URL(url).hostname, "api.telegram.org", "No real payment request is allowed in tests");
        assert.ok(url.endsWith("/sendMessage"));
        if (delivery.fail) return Response.json({ ok: false }, { status: 500 });
        messages.push(JSON.parse(options.body));
        return Response.json({ ok: true, result: { message_id: messages.length } });
    });
    t.after(() => db.close());
    await ensurePaymentTables(env);
    const enable = () => updatePaymentSettings(env, {
        settings: { tribute_enabled: true, yoomoney_enabled: true, yoomoney_wallet: "4100123456789" },
        semesters: [{ id: 1, tribute_enabled: true, tribute_product_id: "123", tribute_payment_url: "https://t.me/tribute/app?startapp=p123", tribute_currency: "RUB", tribute_amount_minor: 150000 }]
    });
    return { db, env, messages, delivery, enable, live, product,
        checkout(provider = "tribute", userId = 2, semesterId = 1) { return createSemesterCheckout(env, { userId, semesterId, provider }); },
        access(userId = 2, semesterId = 1) { return db.prepare("SELECT * FROM user_semesters WHERE user_id=? AND semester_id=?").get(userId,semesterId); }
    };
}

const purchase = (overrides = {}) => ({ name: "new_digital_product", created_at: new Date().toISOString(),
    payload: { product_id: 123, telegram_user_id: 2001, purchase_id: 987, amount: 150000, currency: "rub", ...overrides } });
const hmac = (key, value) => createHmac("sha256", key).update(value).digest("hex");
function yooParams(order, overrides = {}) {
    return new URLSearchParams({ notification_type: "p2p-incoming", operation_id: "yoo123", amount: "1485.15", withdraw_amount: "1500.00",
        currency: "643", datetime: new Date().toISOString(), sender: "4100999999999", codepro: "false", label: order.order_uid,
        unaccepted: "false", ...overrides });
}
function signYoo(params, secret = "yoo-test-secret") {
    const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const raw = [...params.keys()].filter(key => key !== "sign").sort().map(key => `${key}=${encode(params.get(key))}`).join("&");
    params.set("sign", hmac(secret, raw));
    return new Request("https://school.test/api/webhooks/yoomoney", { method: "POST", body: params });
}
const helpers = (userId = 2, role = "student") => ({
    requireUser: async () => ({ ok: true, user: { id: userId, role } }),
    requireAdmin: async () => ({ ok: true, user: { id: userId, role } }),
    authError: auth => Response.json(auth, { status: auth.status || 401 }),
    json: (body, status) => Response.json(body, { status })
});

test("YooMoney uses the official 2026 HMAC example and rejects obsolete SHA1-only notifications", async () => {
    const params = new URLSearchParams({ notification_type: "p2p-incoming", operation_id: "441361714955017004", amount: "98.00", withdraw_amount: "100.00",
        currency: "643", datetime: "2013-12-26T08:28:34Z", sender: "41000000000", codepro: "false", label: "ML23045", unaccepted: "false",
        sha1_hash: "ac13833bd6ba9eff1fa9e4bed76f3d6ebb57f6c0", sign: "a452af731650e2c5b39abcdc7c28dd27db7b3b654c2230ad2c386e64afb98605" });
    assert.equal(await verifyYooMoneySignature(params, "secret123"), true);
    params.delete("sign");
    assert.equal(await verifyYooMoneySignature(params, "secret123"), false);
});

test("Tribute requires raw-body HMAC with API key, not a shared header or truthy Promise", async () => {
    const raw = JSON.stringify(purchase());
    const env = { TRIBUTE_API_KEY: "key" };
    const req = signature => new Request("https://school.test/api/webhooks/tribute", { headers: { "trbt-signature": signature, "X-Tribute-Webhook-Secret": "key" } });
    assert.equal(await verifyTributeSignature(req(hmac("key", raw)), raw, env), true);
    assert.equal(await verifyTributeSignature(req(hmac("key", raw)), `${raw} `, env), false);
    assert.equal(await verifyTributeSignature(req("key"), raw, env), false);
    assert.equal(await verifyTributeSignature(req(hmac("key", raw)), raw, {}), false);
});

for (const live of [false, true]) {
    const label = live ? "live D1 schema" : "repository schema";
    test(`${label}: disabled defaults, owner metadata contains no secrets`, async t => {
        const f = await fixture(t, live);
        const result = await getPaymentSettings(f.env);
        assert.equal(result.settings.tribute_enabled, false);
        assert.equal(result.integration.tribute.secret_configured, true);
        assert.ok(!JSON.stringify(result).includes(f.env.TRIBUTE_API_KEY));
        const options = await getPaymentOptions(f.env, 2, 1);
        assert.equal(options.options.length, 2);
        assert.ok(options.options.every(option => !option.enabled));
        assert.ok(!JSON.stringify(options).includes("private-semester"));
    });

    test(`${label}: concurrent checkout creates one ledger row, durable order, and Telegram message`, async t => {
        const f = await fixture(t, live);
        await f.enable();
        const result = await Promise.all([f.checkout(), f.checkout(), f.checkout()]);
        assert.equal(new Set(result.map(order => order.order_uid)).size, 1);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 1);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM semester_payment_orders").get().n, 1);
        assert.equal(f.messages.length, 1);
        assert.equal(f.messages[0].chat_id, 2001);
        assert.match(f.messages[0].reply_markup.inline_keyboard[0][0].url, /t.me\/tribute/);
        assert.equal(f.access(), undefined);
    });

    test(`${label}: confirmed Tribute grants only purchased semester and repeat is idempotent`, async t => {
        const f = await fixture(t, live);
        await f.enable();
        const order = await f.checkout();
        const body = purchase();
        assert.equal((await processSemesterTributeEvent(f.env, body)).paid, true);
        assert.equal((await processSemesterTributeEvent(f.env, body)).paid, true);
        assert.equal(f.access().status, "active");
        assert.equal(f.access(2, 2), undefined);
        assert.equal(f.access(3), undefined);
        assert.equal(f.access().access_until, live ? null : "9999-12-31 23:59:59");
        if (live) assert.equal(f.access().program_id, 1);
        assert.equal((await getSemesterOrder(f.env, 2, order.order_uid)).status, "paid");
        assert.equal(f.messages.length, 2);
        assert.match(JSON.stringify(f.messages[1]), /https:\/\/t.me\/\+private-semester/);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM semester_payment_grants").get().n, 1);
        assert.equal((await getPaymentOptions(f.env, 2, 1)).access_granted, true);
        await assert.rejects(f.checkout(), /уже оплачен/);
    });

    test(`${label}: YooMoney signed amount/currency/label grants and replay does not duplicate`, async t => {
        const f = await fixture(t, live);
        await f.enable();
        const order = await f.checkout("yoomoney");
        assert.match(order.payment_url, /^https:\/\/school.test\/api\/payments\/pay\/ri_/);
        const body = yooParams(order);
        assert.equal((await handleYooMoneyWebhook(signYoo(body), f.env)).status, 200);
        assert.equal((await handleYooMoneyWebhook(signYoo(body), f.env)).status, 200);
        assert.equal(f.access().status, "active");
        assert.equal(f.messages.length, 2);
        assert.equal((await getSemesterOrder(f.env, 2, order.order_uid)).status, "paid");
    });

    test(`${label}: atomic rollback leaves no ledger or entitlement on SQL failure`, async t => {
        const f = await fixture(t, live);
        await f.enable();
        await f.checkout();
        f.db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON user_semesters BEGIN SELECT RAISE(ABORT,'failed grant'); END");
        await assert.rejects(processSemesterTributeEvent(f.env, purchase()), /failed grant/);
        assert.equal(f.db.prepare("SELECT status FROM payments").get().status, "pending");
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM semester_payment_events").get().n, 0);
        assert.equal(f.db.prepare("SELECT provider_payment_id FROM semester_payment_orders").get().provider_payment_id, null);
        assert.equal(f.access(), undefined);
    });

    test(`${label}: refund revokes owned access and delayed paid event cannot reopen it`, async t => {
        const f = await fixture(t, live);
        await f.enable();
        await f.checkout();
        const event = purchase();
        await processSemesterTributeEvent(f.env, event);
        await processSemesterTributeEvent(f.env, { ...event, name: "digital_product_refunded" });
        assert.equal(f.access().status, "expired");
        await processSemesterTributeEvent(f.env, event);
        assert.equal(f.access().status, "expired");
        assert.equal(f.db.prepare("SELECT status FROM payments").get().status, "refunded");
    });
}

test("Tribute does not grant for wrong payer, product, currency, amount, unknown order, or historical purchase", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    for (const override of [{ telegram_user_id: 3001 }, { product_id: 124 }, { currency: "usd" }, { amount: 1500 }, { purchase_id: undefined }, { purchase_created_at: "2020-01-01T00:00:00Z" }]) {
        const result = await processSemesterTributeEvent(f.env, purchase(override));
        assert.ok(result.ignored, JSON.stringify(override));
        assert.equal(f.access(), undefined);
    }
});

test("refund delivered before payment prevents later grant", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    const event = purchase();
    await processSemesterTributeEvent(f.env, { ...event, name: "digital_product_refunded" });
    assert.equal((await processSemesterTributeEvent(f.env, event)).ignored, "already_refunded");
    assert.equal(f.access(), undefined);
});

test("blocked semester remains blocked after a pending order is paid", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    f.db.exec("INSERT INTO user_semesters(user_id,program_id,semester_id,status) VALUES(2,1,1,'blocked')");
    await processSemesterTributeEvent(f.env, purchase());
    assert.equal(f.access().status, "blocked");
    assert.ok(!JSON.stringify(f.messages[1]).includes("private-semester"));
});

test("YooMoney refuses bad signatures, unsigned amount changes, duplicates, test transfers and held funds", async t => {
    const f = await fixture(t);
    await f.enable();
    const order = await f.checkout("yoomoney");
    const malformed = yooParams(order);
    signYoo(malformed);
    malformed.set("withdraw_amount", "1600.00");
    assert.equal((await handleYooMoneyWebhook(new Request("https://school.test", { method: "POST", body: malformed }), f.env)).status, 401);
    for (const override of [{ currency: "840" }, { withdraw_amount: "1499.00" }, { label: "other-order" }, { unaccepted: "true" }, { codepro: "true" }, { test_notification: "true" }, { datetime: "2020-01-01" }]) {
        const result = await handleYooMoneyWebhook(signYoo(yooParams(order, override)), f.env);
        assert.equal(result.status, 200);
        assert.equal(f.access(), undefined);
    }
    const duplicate = yooParams(order);
    signYoo(duplicate);
    duplicate.append("amount", "1500.00");
    assert.equal(await verifyYooMoneySignature(duplicate, f.env.YOOMONEY_WEBHOOK_SECRET), false);
});

test("a YooMoney operation cannot pay a second user's order", async t => {
    const f = await fixture(t);
    await f.enable();
    const first = await f.checkout("yoomoney");
    const second = await f.checkout("yoomoney", 3);
    await handleYooMoneyWebhook(signYoo(yooParams(first)), f.env);
    const response = await handleYooMoneyWebhook(signYoo(yooParams(second)), f.env);
    assert.equal((await response.json()).ignored, "operation_already_used");
    assert.equal(f.access(3), undefined);
});

test("Telegram failure preserves paid state, retries notification once, and includes current semester link", async t => {
    const f = await fixture(t);
    await f.enable();
    const order = await f.checkout("yoomoney");
    f.delivery.fail = true;
    const body = yooParams(order);
    assert.equal((await handleYooMoneyWebhook(signYoo(body), f.env)).status, 503);
    assert.equal(f.access().status, "active");
    f.delivery.fail = false;
    f.db.exec("UPDATE telegram_learning_links SET url='https://t.me/+updated-link'");
    assert.equal((await handleYooMoneyWebhook(signYoo(body), f.env)).status, 200);
    assert.equal(f.messages.length, 2);
    assert.match(JSON.stringify(f.messages[1]), /updated-link/);
});

test("a linked Telegram identity is required and other users cannot inspect an order", async t => {
    const f = await fixture(t);
    await f.enable();
    const order = await f.checkout();
    await assert.rejects(getSemesterOrder(f.env, 3, order.order_uid), /не найден/);
    f.db.exec("UPDATE users SET telegram_id=-3001 WHERE id=3");
    await assert.rejects(f.checkout("tribute", 3), /привяжите Telegram/);
    f.db.exec("UPDATE users SET telegram_id=9999 WHERE id=2");
    assert.equal((await processSemesterTributeEvent(f.env, purchase())).ignored, "telegram_link_changed");
    assert.equal(f.access(), undefined);
});

test("settings update validates complete batch, exact product URL, unique semester product and wallet", async t => {
    const f = await fixture(t);
    await f.enable();
    await assert.rejects(updatePaymentSettings(f.env, { settings: { yoomoney_wallet: "evil" }, semesters: [{ id: 1, price_rub: 777 }] }), /кошелька/);
    await assert.rejects(updatePaymentSettings(f.env, { semesters: [{ id: 1, price_rub: 777 }, { id: 2, tribute_payment_url: "https://evil.test" }] }), /Tribute/);
    assert.equal(f.db.prepare("SELECT price_rub FROM semesters WHERE id=1").get().price_rub, 1500);
    await assert.rejects(updatePaymentSettings(f.env, { semesters: [{ id: 2, tribute_product_id: "123" }] }), /отдельный/);
    await updatePaymentSettings(f.env, { semesters: [{ id: 1, tribute_payment_url: "https://t.me/tribute/app?startapp=p124" }] });
    await assert.rejects(f.checkout(), /не совпадают/);
    await assert.rejects(updatePaymentSettings(f.env, { settings: { TRIBUTE_API_KEY: "should-never-save" } }), /поля/);
    assert.ok(!JSON.stringify(await getPaymentSettings(f.env)).includes("should-never-save"));
});

test("admin payment API enforces owner on both reads and writes, even for an admin", async t => {
    const f = await fixture(t);
    for (const method of ["GET", "PUT"]) {
        const request = new Request("https://school.test/api/admin/payment-settings", { method, ...(method === "PUT" ? { body: JSON.stringify({ settings: { tribute_enabled: true } }) } : {}) });
        const result = await handlePaymentRequest(request, f.env, helpers(4, "admin"));
        assert.equal(result.status, 403);
    }
    const result = await handlePaymentRequest(new Request("https://school.test/api/admin/payment-settings"), f.env, helpers(1, "owner"));
    assert.equal(result.status, 200);
});

test("checkout ignores client amount/user/status and the hosted form never treats return navigation as payment", async t => {
    const f = await fixture(t);
    await f.enable();
    const response = await handlePaymentRequest(new Request("https://school.test/api/payments/checkout", { method: "POST",
        body: JSON.stringify({ semester_id: 1, provider: "yoomoney", amount: 1, status: "paid", user_id: 3 }) }), f.env, helpers());
    const { order } = await response.json();
    assert.equal(order.amount_rub, 1500);
    assert.equal(order.status, "pending");
    assert.equal(f.db.prepare("SELECT user_id FROM payments").get().user_id, 2);
    const form = await handlePaymentRequest(new Request(`${order.payment_url}?paid=true`), f.env, helpers());
    const html = await form.text();
    assert.match(html, /action="https:\/\/yoomoney.ru\/quickpay\/confirm" method="POST"/);
    assert.match(html, /name="sum" value="1500.00"/);
    assert.ok(!html.includes("private-semester"));
    assert.equal(f.access(), undefined);
});

test("Worker Tribute route awaits verification before any legacy program access grant", async t => {
    const f = await fixture(t);
    const payload = JSON.stringify({ event_id: "legacy-test", type: "payment.succeeded", data: { status: "paid", metadata: { user_id: 2, program_id: 1 } } });
    const make = signature => new Request("https://school.test/api/webhooks/tribute", { method: "POST", body: payload, headers: { "trbt-signature": signature } });
    assert.equal((await worker.fetch(make("wrong"), f.env)).status, 401);
    const result = await worker.fetch(make(hmac(f.env.TRIBUTE_API_KEY, payload)), f.env);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).access_granted, true);
    assert.equal(f.db.prepare("SELECT status FROM user_program_access WHERE user_id=2 AND program_id=1").get().status, "active");
});

test("guarded Telegram save consumes its exact draft once and rejects replays", async t => {
    const f = await fixture(t);
    f.db.exec("CREATE TABLE telegram_payment_drafts(chat_id INTEGER PRIMARY KEY,state TEXT,after_id INTEGER NOT NULL DEFAULT 0)");
    const state = JSON.stringify({ field: "price_rub", semesterId: 1 });
    f.db.prepare("INSERT INTO telegram_payment_drafts VALUES(1001,?,10)").run(state);
    const guard = { chatId: 1001, state, messageId: 11 };
    await updatePaymentSettings(f.env, { semesters: [{ id: 1, price_rub: 2500 }] }, { guard });
    assert.equal(f.db.prepare("SELECT price_rub FROM semesters WHERE id=1").get().price_rub, 2500);
    assert.deepEqual({ ...f.db.prepare("SELECT state,after_id FROM telegram_payment_drafts").get() }, { state: null, after_id: 11 });
    await assert.rejects(updatePaymentSettings(f.env, { semesters: [{ id: 1, price_rub: 6666 }] }, { guard }), /отменён или обработан/);
    assert.equal(f.db.prepare("SELECT price_rub FROM semesters WHERE id=1").get().price_rub, 2500);
});

test("cancelling or replacing a Telegram draft during save leaves all payment settings unchanged", async t => {
    const f = await fixture(t);
    f.db.exec("CREATE TABLE telegram_payment_drafts(chat_id INTEGER PRIMARY KEY,state TEXT,after_id INTEGER NOT NULL DEFAULT 0)");
    const state = JSON.stringify({ field: "wallet" });
    f.db.prepare("INSERT INTO telegram_payment_drafts VALUES(1001,?,10)").run(state);
    const originalBatch = f.env.DB.batch.bind(f.env.DB);
    // Simulate a navigation webhook arriving after validation, immediately
    // before D1 serializes the attempted save transaction.
    t.mock.method(f.env.DB, "batch", async statements => {
        f.db.prepare("UPDATE telegram_payment_drafts SET state=?,after_id=12 WHERE chat_id=1001").run(JSON.stringify({ field: "newer" }));
        return originalBatch(statements);
    });
    await assert.rejects(updatePaymentSettings(f.env, { settings: { yoomoney_enabled: true, yoomoney_wallet: "4100123456789" },
        semesters: [{ id: 1, price_rub: 7500 }] }, { guard: { chatId: 1001, state, messageId: 11 } }), /отменён или обработан/);
    assert.equal(f.db.prepare("SELECT price_rub FROM semesters WHERE id=1").get().price_rub, 1500);
    assert.equal((await getPaymentSettings(f.env)).settings.yoomoney_enabled, false);
    assert.equal(f.db.prepare("SELECT after_id FROM telegram_payment_drafts").get().after_id, 12);
});

test("legacy YooMoney notification secret/wallet alias and shared master switch remain usable", async t => {
    const f = await fixture(t);
    delete f.env.YOOMONEY_WEBHOOK_SECRET;
    f.env.YOOMONEY_NOTIFICATION_SECRET = "yoo-test-secret";
    f.env.YOOMONEY_WALLET = "4100123456789";
    assert.equal((await getPaymentSettings(f.env)).settings.yoomoney_wallet, "4100123456789");
    assert.equal((await getPaymentSettings(f.env)).integration.yoomoney.env_name, "YOOMONEY_NOTIFICATION_SECRET");
    await f.enable();
    await updatePaymentSettings(f.env, { settings: { payments_enabled: false } });
    assert.equal(f.db.prepare("SELECT value FROM app_settings WHERE key='payments_enabled'").get().value, "0");
    await assert.rejects(f.checkout("yoomoney"), /выключена/);
    f.db.exec("UPDATE app_settings SET value='1' WHERE key='payments_enabled'");
    const order = await f.checkout("yoomoney");
    assert.equal((await handleYooMoneyWebhook(signYoo(yooParams(order)), f.env)).status, 200);
    assert.equal(f.access().status, "active");
});

test("non-RUB Tribute checkout keeps actual minor amount/currency in ledger and tuition separately", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await updatePaymentSettings(f.env, { semesters: [{ id: 1, tribute_currency: "USD", tribute_amount_minor: 1999 }] });
    Object.assign(f.product, { currency: "usd", amount: 1999 });
    const order = await f.checkout();
    assert.equal(order.amount_rub, 1500);
    assert.equal(order.amount_minor, 1999);
    assert.equal(order.currency, "USD");
    assert.deepEqual({ ...f.db.prepare("SELECT amount,currency FROM payments").get() }, { amount: 1999, currency: "USD" });
    assert.equal((await processSemesterTributeEvent(f.env, purchase({ amount: 1999, currency: "usd" }))).paid, true);
});

test("hidden or mismatched programs cannot sell a semester or disclose its private channel", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    f.db.exec("UPDATE programs SET is_active=0 WHERE id=1");
    await assert.rejects(f.checkout("yoomoney"), /не найден/);
    await processSemesterTributeEvent(f.env, purchase());
    assert.equal(f.messages.length, 2);
    assert.ok(!JSON.stringify(f.messages[1]).includes("private-semester"));
    f.db.exec("INSERT INTO courses(id,name) VALUES(2,'Other'); UPDATE programs SET is_active=1,course_id=2 WHERE id=1");
    await assert.rejects(getPaymentOptions(f.env, 3, 1), /не найден/);
});

test("after wallet changes a fresh order is generated and old form refuses obsolete receiver", async t => {
    const f = await fixture(t);
    await f.enable();
    const old = await f.checkout("yoomoney");
    await updatePaymentSettings(f.env, { settings: { yoomoney_wallet: "4100555555555" } });
    const fresh = await f.checkout("yoomoney");
    assert.notEqual(old.order_uid, fresh.order_uid);
    const oldForm = await handlePaymentRequest(new Request(old.payment_url), f.env, helpers());
    assert.equal(oldForm.status, 409);
    const newForm = await handlePaymentRequest(new Request(fresh.payment_url), f.env, helpers());
    assert.match(await newForm.text(), /4100555555555/);
});

test("all purchases supporting access must be refunded before owned entitlement is revoked", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    await updatePaymentSettings(f.env, { semesters: [{ id: 1, tribute_amount_minor: 160000 }] });
    f.product.amount = 160000;
    await f.checkout();
    const first = purchase();
    const second = purchase({ amount: 160000, purchase_id: 988 });
    await processSemesterTributeEvent(f.env, first);
    await processSemesterTributeEvent(f.env, second);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM semester_payment_grants").get().n, 2);
    await processSemesterTributeEvent(f.env, { ...first, name: "digital_product_refunded" });
    assert.equal(f.access().status, "active");
    await processSemesterTributeEvent(f.env, { ...second, name: "digital_product_refunded" });
    assert.equal(f.access().status, "expired");
});

test("manual entitlement granted while a payment is pending is not revoked by that payment's refund", async t => {
    const f = await fixture(t, true);
    await f.enable();
    await f.checkout();
    f.db.exec("INSERT INTO user_semesters(user_id,program_id,semester_id,status,granted_by) VALUES(2,1,1,'active',1)");
    const event = purchase();
    await processSemesterTributeEvent(f.env, event);
    await processSemesterTributeEvent(f.env, { ...event, name: "digital_product_refunded" });
    assert.equal(f.access().status, "active");
});

test("official Tribute opaque link sample is verified against numeric product ID before creating an order", async t => {
    const f = await fixture(t);
    await f.enable();
    Object.assign(f.product, { id: 2548, amount: 499, currency: "usd", link: "https://t.me/tribute_bot/app?startapp=pf6", webLink: "https://web.tribute.tg/p/f6" });
    await updatePaymentSettings(f.env, { semesters: [{ id: 1, tribute_product_id: "2548", tribute_payment_url: f.product.link,
        tribute_amount_minor: 499, tribute_currency: "USD" }] });
    const order = await f.checkout();
    assert.equal(order.payment_url, f.product.link);
    assert.equal((await processSemesterTributeEvent(f.env, purchase({ product_id: 2548, currency: "usd", amount: 499 }))).paid, true);
});

test("Tribute mismatch, unavailable API or unapproved product cannot create payable orders", async t => {
    const f = await fixture(t);
    await f.enable();
    for (const mismatch of [{ amount: 149900 }, { currency: "usd" }, { status: "pending" }, { type: "physical" }, { link: "https://t.me/tribute/app?startapp=pwrong", webLink: "https://web.tribute.tg/p/wrong" }]) {
        const original = { ...f.product };
        Object.assign(f.product, mismatch);
        await assert.rejects(f.checkout(), /не совпадают/);
        Object.assign(f.product, original);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM semester_payment_orders").get().n, 0);
    }
    f.delivery.tributeFail = true;
    await assert.rejects(f.checkout(), /Не удалось проверить/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { handleTelegramWebhook } from "../src/telegram-bot.js";
import { updatePaymentSettings } from "../src/payments.js";

class Statement {
    constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
    bind(...values) { return new Statement(this.db, this.sql, values); }
    execute() {
        const statement = this.db.prepare(this.sql);
        if (statement.columns().length) return { success: true, results: statement.all(...this.values), meta: { changes: 0 } };
        const row = statement.run(...this.values);
        return { success: true, meta: { changes: Number(row.changes), last_row_id: Number(row.lastInsertRowid) } };
    }
    async first(column) { const row = this.db.prepare(this.sql).get(...this.values); return row ? (column ? row[column] : row) : null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
}

async function fixture(t) {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO users(id,telegram_id,first_name,role,account_id) VALUES
        (1,101,'Owner','owner',10000001),(2,102,'Student','student',10000002),
        (3,103,'Payment admin','admin',10000003),(4,104,'Other student','student',10000004);
        INSERT INTO admin_permissions(admin_id,permission) VALUES(3,'payments');
        INSERT INTO courses(id,name) VALUES(1,'Курс');
        INSERT INTO programs(id,course_id,name) VALUES(1,1,'Программа');
        INSERT INTO semesters(id,course_id,program_id,number,name,price_rub,payment_enabled) VALUES(1,1,1,1,'Первый семестр',1500,1);`);
    const env = {
        OWNER_TELEGRAM_ID: "101", TELEGRAM_BOT_TOKEN: "fake-test-token", PUBLIC_APP_URL: "https://school.test",
        TRIBUTE_API_KEY: "test-tribute-secret", YOOMONEY_WEBHOOK_SECRET: "test-yoo-secret",
        DB: {
            prepare(sql) { return new Statement(db, sql); },
            async batch(statements) {
                db.exec("BEGIN");
                try { const rows = statements.map(statement => statement.execute()); db.exec("COMMIT"); return rows; }
                catch (error) { db.exec("ROLLBACK"); throw error; }
            }
        }
    };
    const calls = [];
    let id = 10;
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(new URL(url).hostname, "api.telegram.org", "Tests must not contact a real payment provider");
        calls.push(JSON.parse(options.body));
        return Response.json({ ok: true, result: { message_id: ++id } });
    });
    t.mock.method(console, "error", (...args) => { throw new Error(`Unexpected webhook error: ${args.map(String).join(" ")}`); });
    t.after(() => db.close());
    await updatePaymentSettings(env, {
        settings: { tribute_enabled: true, yoomoney_enabled: true, yoomoney_wallet: "4100123456789" },
        semesters: [{ id: 1, tribute_enabled: true, tribute_product_id: "123", tribute_payment_url: "https://web.tribute.tg/p/123", tribute_amount_minor: 150000 }]
    });
    const deliver = update => handleTelegramWebhook(new Request("https://school.test/api/webhooks/telegram", { method: "POST", body: JSON.stringify(update) }), env);
    return {
        db, env, calls,
        callback(data, sender = 102) { return deliver({ callback_query: { id: `test${++id}`, data, from: { id: sender }, message: { message_id: id, chat: { id: sender, type: "private" } } } }); },
        message(text, sender = 101) { return deliver({ message: { message_id: ++id, text, from: { id: sender }, chat: { id: sender, type: "private" } } }); },
        last() { return calls.filter(call => call.text).at(-1); },
        order() { return db.prepare("SELECT * FROM semester_payment_orders ORDER BY created_at DESC LIMIT 1").get(); }
    };
}

test("Telegram semester payment options expose the actual enabled provider callbacks", async t => {
    const f = await fixture(t);
    await f.callback("pay_options_1");
    const buttons = f.last().reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some(button => button.callback_data === "pay_buy_1_yoomoney"));
    assert.ok(buttons.some(button => button.callback_data === "pay_buy_1_tribute"));
    assert.ok(!JSON.stringify(f.last()).includes("test-tribute-secret"));
});

test("the visible check-payment button accepts a real generated order id", async t => {
    const f = await fixture(t);
    await f.callback("pay_buy_1_yoomoney");
    const status = f.last().reply_markup.inline_keyboard.flat().find(button => button.callback_data?.startsWith("pay_status_"));
    assert.match(status.callback_data, /^pay_status_ri_[a-f0-9]{32}$/);
    await f.callback(status.callback_data);
    assert.match(f.last().text, /Подтверждение оплаты ещё не получено/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM user_semesters").get().count, 0);
});

test("students cannot change payment settings and payment admins cannot change owner-only settings", async t => {
    const f = await fixture(t);
    const before = f.db.prepare("SELECT value FROM app_settings WHERE key='semester_payment_settings'").get().value;
    for (const sender of [102, 103]) {
        await f.callback("pay_global_yoomoney_0", sender);
        await f.callback("pay_set_1_payment_enabled_0", sender);
        await f.callback("pay_edit_wallet_0", sender);
    }
    assert.equal(f.db.prepare("SELECT value FROM app_settings WHERE key='semester_payment_settings'").get().value, before);
    assert.equal(f.db.prepare("SELECT payment_enabled FROM semesters WHERE id=1").get().payment_enabled, 1);
    const draftsExist = f.db.prepare("SELECT name FROM sqlite_master WHERE name='telegram_payment_drafts'").get();
    assert.equal(draftsExist ? f.db.prepare("SELECT COUNT(*) AS count FROM telegram_payment_drafts WHERE state IS NOT NULL").get().count : 0, 0);
});

test("payment status of another student's order is not exposed through direct callbacks", async t => {
    const f = await fixture(t);
    await f.callback("pay_buy_1_yoomoney");
    const order = f.order();
    await f.callback(`pay_status_${order.order_uid}`, 104);
    assert.match(f.last().text, /Заказ не найден/);
    assert.ok(!JSON.stringify(f.last()).includes(order.payment_url));
});

test("owner form navigation cancels draft without saving a menu label", async t => {
    const f = await fixture(t);
    await f.callback("pay_edit_wallet_0", 101);
    await f.message("⬅️ Админ-панель");
    assert.equal(f.db.prepare("SELECT state FROM telegram_payment_drafts WHERE chat_id=101").get().state, null);
    assert.match(f.db.prepare("SELECT value FROM app_settings WHERE key='semester_payment_settings'").get().value, /4100123456789/);
    await f.callback("pay_edit_price_1", 101);
    await f.message("2200");
    assert.equal(f.db.prepare("SELECT price_rub FROM semesters WHERE id=1").get().price_rub, 2200);
});

test("generated YooMoney URL resolves through the production worker routing to the exact order form", async t => {
    const f = await fixture(t);
    await f.callback("pay_buy_1_yoomoney");
    const order = f.order();
    assert.equal(new URL(order.payment_url).origin, f.env.PUBLIC_APP_URL);
    const response = await worker.fetch(new Request(order.payment_url), f.env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('action="https://yoomoney.ru/quickpay/confirm"'));
    assert.ok(html.includes(`name="label" value="${order.order_uid}"`));
    assert.ok(html.includes('name="sum" value="1500.00"'));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM user_semesters").get().count, 0);
});

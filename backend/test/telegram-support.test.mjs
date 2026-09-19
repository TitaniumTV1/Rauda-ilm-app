import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleSupportCallback, handleSupportMessage, cancelSupportDraft } from "../src/telegram-support.js";

const schema = readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8");
const OWNER = 1001;
const SUPPORT_ADMIN = 2001;
const OTHER_ADMIN = 2002;
const STUDENT = 3001;
const OTHER_STUDENT = 3002;

class Statement {
    constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
    bind(...values) { return new Statement(this.db, this.sql, values); }
    execute() {
        const statement = this.db.prepare(this.sql);
        if (statement.columns().length) return { success: true, results: statement.all(...this.values), meta: { changes: 0 } };
        const result = statement.run(...this.values);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
}

function fixture(t) {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    const insert = db.prepare("INSERT INTO users (telegram_id, first_name, role, status) VALUES (?, ?, ?, 'active')");
    for (const [id, role] of [[OWNER, "owner"], [SUPPORT_ADMIN, "admin"], [OTHER_ADMIN, "admin"], [STUDENT, "student"], [OTHER_STUDENT, "student"]]) {
        insert.run(id, `User ${id}`, role);
    }
    db.prepare("INSERT INTO admin_permissions (admin_id, permission) SELECT id, 'support' FROM users WHERE telegram_id = ?").run(SUPPORT_ADMIN);
    const env = {
        DB: {
            prepare(sql) { return new Statement(db, sql); },
            async batch(statements) {
                db.exec("BEGIN");
                try { const result = statements.map(statement => statement.execute()); db.exec("COMMIT"); return result; }
                catch (error) { db.exec("ROLLBACK"); throw error; }
            }
        },
        OWNER_TELEGRAM_ID: String(OWNER),
        TELEGRAM_BOT_TOKEN: "local-test-token"
    };
    const calls = [];
    const failures = new Map();
    let sequence = 100;
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(new URL(url).hostname, "api.telegram.org");
        assert.ok(url.endsWith("/sendMessage"));
        const payload = JSON.parse(options.body);
        const id = ++sequence;
        const failure = failures.get(payload.chat_id);
        const call = { ...payload, telegramId: id, success: !failure };
        calls.push(call);
        if (failure === "network") throw new Error("Network unavailable");
        if (failure === "body") return Response.json({ ok: false, error_code: 403, description: "Forbidden" });
        if (failure) return Response.json({ ok: false, error_code: 403 }, { status: 403 });
        return Response.json({ ok: true, result: { message_id: id, chat: { id: Number(payload.chat_id) } } });
    });
    t.mock.method(console, "error", () => {});
    t.after(() => db.close());
    function message(text, sender = STUDENT, extra = {}) {
        return { message_id: ++sequence, chat: { id: sender, type: "private" }, from: { id: sender, first_name: "Test <name>" }, ...(text === undefined ? {} : { text }), ...extra };
    }
    async function callback(data, sender = STUDENT, extra = {}) {
        return handleSupportCallback(env, {
            id: String(++sequence), data,
            from: { id: sender }, message: { message_id: sequence, chat: { id: sender, type: "private" } }, ...extra
        });
    }
    return {
        db, env, calls, failures, message, callback,
        send(text, sender = STUDENT, extra = {}) { return handleSupportMessage(env, message(text, sender, extra)); },
        async question(text = "Как начать обучение?", sender = STUDENT) {
            await callback("support", sender);
            await handleSupportMessage(env, message(text, sender));
            return db.prepare("SELECT * FROM telegram_support_messages WHERE kind = 'question' ORDER BY id DESC LIMIT 1").get();
        },
        draft(sender = STUDENT) { return db.prepare("SELECT state FROM telegram_support_drafts WHERE chat_id = ?").get(String(sender)); },
        delivered(sender, needle = "") { return calls.filter(call => call.success && call.chat_id === String(sender) && call.text.includes(needle)); },
        revoke(sender = SUPPORT_ADMIN) {
            db.prepare("DELETE FROM admin_permissions WHERE admin_id = (SELECT id FROM users WHERE telegram_id = ?)").run(sender);
        }
    };
}

test("student message reaches the owner and only active admins with support permission", async t => {
    const f = fixture(t);
    f.db.prepare("UPDATE users SET status = 'blocked' WHERE telegram_id = ?").run(OTHER_ADMIN);
    const question = await f.question();
    assert.equal(f.delivered(OWNER, "Обращение №").length, 1);
    assert.equal(f.delivered(SUPPORT_ADMIN, "Обращение №").length, 1);
    assert.equal(f.delivered(OTHER_ADMIN).length, 0);
    assert.equal(f.delivered(STUDENT, "✅ Сообщение доставлено").length, 1);
    assert.equal(f.draft(), undefined);
    const deliveries = f.db.prepare("SELECT * FROM telegram_support_deliveries WHERE support_message_id = ?").all(question.id);
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every(row => row.status === "sent" && row.telegram_message_id > 0));
});

for (const staff of [OWNER, SUPPORT_ADMIN]) {
    test(`authorized staff ${staff} replies through the database callback`, async t => {
        const f = fixture(t);
        const question = await f.question();
        await f.callback(`support_reply_${question.id}`, staff);
        await f.send("Откройте раздел «Моё обучение».", staff);
        assert.equal(f.delivered(STUDENT, "Ответ поддержки RAUDA ILM").length, 1);
        assert.equal(f.delivered(staff, "✅ Ответ доставлен ученику").length, 1);
        assert.equal(f.draft(staff), undefined);
    });

    test(`authorized staff ${staff} replies natively to the delivered message`, async t => {
        const f = fixture(t);
        await f.question();
        const original = f.delivered(staff, "Обращение №")[0];
        await f.send("Спасибо за вопрос", staff, { reply_to_message: { message_id: original.telegramId } });
        assert.equal(f.delivered(STUDENT, "Спасибо за вопрос").length, 1);
    });
}

test("student can continue by replying to the support answer", async t => {
    const f = fixture(t);
    const question = await f.question();
    await f.callback(`support_reply_${question.id}`, OWNER);
    await f.send("Первый ответ", OWNER);
    const answer = f.delivered(STUDENT, "Ответ поддержки RAUDA ILM")[0];
    await f.send("Спасибо, есть уточнение", STUDENT, { reply_to_message: { message_id: answer.telegramId } });
    assert.equal(f.delivered(OWNER, "Спасибо, есть уточнение").length, 1);
});

for (const attacker of [STUDENT, OTHER_STUDENT, OTHER_ADMIN]) {
    test(`unauthorized user ${attacker} cannot open the inbox or reply using a guessed database id`, async t => {
        const f = fixture(t);
        const question = await f.question("Частное обращение");
        const before = f.calls.length;
        await f.callback("admin_support", attacker);
        await f.callback(`support_reply_${question.id}`, attacker);
        assert.equal(f.draft(attacker), undefined);
        assert.ok(f.calls.slice(before).every(call => !call.text.includes("Частное обращение")));
    });
}

test("revoked support permission is rechecked after the reply prompt and on native reply", async t => {
    const f = fixture(t);
    const question = await f.question();
    const original = f.delivered(SUPPORT_ADMIN, "Обращение №")[0];
    await f.callback(`support_reply_${question.id}`, SUPPORT_ADMIN);
    f.revoke();
    await f.send("Недопустимый ответ", SUPPORT_ADMIN);
    await f.send("Ещё один ответ", SUPPORT_ADMIN, { reply_to_message: { message_id: original.telegramId } });
    assert.equal(f.delivered(STUDENT, "Ответ поддержки RAUDA ILM").length, 0);
    assert.equal(f.draft(SUPPORT_ADMIN), undefined);
});

test("inactive support staff receive no messages and cannot reply", async t => {
    const f = fixture(t);
    f.db.prepare("UPDATE users SET status = 'blocked' WHERE telegram_id = ?").run(SUPPORT_ADMIN);
    const question = await f.question();
    await f.callback(`support_reply_${question.id}`, SUPPORT_ADMIN);
    assert.equal(f.delivered(SUPPORT_ADMIN, "Обращение №").length, 0);
    assert.equal(f.draft(SUPPORT_ADMIN), undefined);
});

test("a native reply cannot use another chat's Telegram message mapping", async t => {
    const f = fixture(t);
    await f.question();
    const ownerMessage = f.delivered(OWNER, "Обращение №")[0];
    const handled = await f.send("Поддельный ответ", OTHER_STUDENT, { reply_to_message: { message_id: ownerMessage.telegramId } });
    assert.equal(handled, false);
    assert.equal(f.delivered(STUDENT, "Поддельный ответ").length, 0);
});

for (const failure of [true, "body", "network"]) {
    test(`failed Telegram delivery (${failure}) remains retryable without duplicate successful recipients`, async t => {
        const f = fixture(t);
        f.failures.set(String(SUPPORT_ADMIN), failure);
        const question = await f.question();
        assert.ok(f.draft());
        assert.equal(f.delivered(STUDENT, "✅ Сообщение доставлено").length, 0);
        assert.equal(f.delivered(OWNER, "Обращение №").length, 1);
        f.failures.clear();
        await f.callback(`support_retry_${question.id}`);
        assert.equal(f.delivered(OWNER, "Обращение №").length, 1);
        assert.equal(f.delivered(SUPPORT_ADMIN, "Обращение №").length, 1);
        assert.equal(f.delivered(STUDENT, "✅ Сообщение доставлено").length, 1);
        assert.equal(f.draft(), undefined);
    });
}

test("failed reply is not acknowledged as delivered and can be retried after permission recheck", async t => {
    const f = fixture(t);
    const question = await f.question();
    await f.callback(`support_reply_${question.id}`, SUPPORT_ADMIN);
    f.failures.set(String(STUDENT), true);
    await f.send("Нужный ответ", SUPPORT_ADMIN);
    assert.equal(f.delivered(SUPPORT_ADMIN, "✅ Ответ доставлен").length, 0);
    const reply = f.db.prepare("SELECT id FROM telegram_support_messages WHERE kind = 'reply'").get();
    f.revoke();
    f.failures.clear();
    await f.callback(`support_retry_${reply.id}`, SUPPORT_ADMIN);
    assert.equal(f.delivered(STUDENT, "Нужный ответ").length, 0);
});

test("an old retry cannot erase a newer draft", async t => {
    const f = fixture(t);
    f.failures.set(String(SUPPORT_ADMIN), true);
    const question = await f.question();
    await f.callback("support");
    const newerDraft = f.draft().state;
    f.failures.clear();
    await f.callback(`support_retry_${question.id}`);
    assert.equal(f.draft().state, newerDraft);
});

test("replayed and simultaneous incoming updates produce one message and one copy per recipient", async t => {
    const f = fixture(t);
    await f.callback("support");
    const message = f.message("Один вопрос");
    await Promise.all([handleSupportMessage(f.env, message), handleSupportMessage(f.env, message)]);
    await handleSupportMessage(f.env, message);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM telegram_support_messages").get().count, 1);
    assert.equal(f.delivered(OWNER, "Один вопрос").length, 1);
    assert.equal(f.delivered(SUPPORT_ADMIN, "Один вопрос").length, 1);
});

test("replayed staff reply is delivered to the student once", async t => {
    const f = fixture(t);
    const question = await f.question();
    await f.callback(`support_reply_${question.id}`, OWNER);
    const message = f.message("Один ответ", OWNER);
    await Promise.all([handleSupportMessage(f.env, message), handleSupportMessage(f.env, message)]);
    await handleSupportMessage(f.env, message);
    assert.equal(f.delivered(STUDENT, "Один ответ").length, 1);
});

for (const navigation of ["❌ Отмена", "/cancel", "/start", "⬅️ Главное меню", "📚 Курсы", "⚙️ Управление"]) {
    test(`${navigation} never becomes feedback`, async t => {
        const f = fixture(t);
        await f.callback("support");
        await f.send(navigation);
        assert.equal(f.draft(), undefined);
        assert.equal(f.delivered(OWNER, "Обращение №").length, 0);
    });
}

test("media and oversized messages keep a usable draft", async t => {
    const f = fixture(t);
    await f.callback("support");
    await f.send(undefined, STUDENT, { photo: [{ file_id: "unused" }] });
    await f.send("x".repeat(3001));
    assert.ok(f.draft());
    assert.equal(f.delivered(OWNER, "Обращение №").length, 0);
    await f.send("Теперь текст");
    assert.equal(f.delivered(OWNER, "Теперь текст").length, 1);
});

test("HTML is escaped and no user-provided chat ID is interpreted as a destination", async t => {
    const f = fixture(t);
    await f.question('<a href="tg://user?id=9999">9999 & text</a>');
    const copy = f.delivered(OWNER, "Обращение №")[0];
    assert.ok(copy.text.includes("&lt;a href="));
    assert.ok(copy.text.includes("&amp; text"));
    assert.ok(copy.text.includes("Test &lt;name&gt;"));
    assert.equal(f.calls.filter(call => call.chat_id === "9999").length, 0);
});

test("group and mismatched sender identities cannot create or consume drafts", async t => {
    const f = fixture(t);
    await f.callback("support");
    assert.equal(await f.send("group", STUDENT, { chat: { id: -100, type: "group" } }), false);
    assert.equal(await f.send("mismatch", STUDENT, { from: { id: OTHER_STUDENT } }), false);
    await f.callback("support", STUDENT, { message: { chat: { id: -100, type: "group" } } });
    assert.ok(f.draft());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM telegram_support_messages").get().count, 0);
});

test("cancellation preserves course state and independent student drafts", async t => {
    const f = fixture(t);
    f.db.exec("CREATE TABLE bot_states (chat_id INTEGER PRIMARY KEY, state TEXT, updated_at TEXT)");
    f.db.prepare("INSERT INTO bot_states (chat_id, state) VALUES (?, 'create_course_name')").run(STUDENT);
    await f.callback("support");
    await f.callback("support", OTHER_STUDENT);
    await cancelSupportDraft(f.env, STUDENT);
    assert.equal(f.draft(), undefined);
    assert.ok(f.draft(OTHER_STUDENT));
    assert.equal(f.db.prepare("SELECT state FROM bot_states WHERE chat_id = ?").get(STUDENT).state, "create_course_name");
});

test("unknown non-support callbacks and ordinary messages are not consumed", async t => {
    const f = fixture(t);
    assert.equal(await f.callback("admin_courses"), false);
    assert.equal(await f.send("Обычное сообщение"), false);
    assert.equal(f.calls.length, 0);
});

test("new native support reply awaits the interaction hook before storage or delivery and never hooks its replay", async t => {
    const f = fixture(t);
    await f.question();
    const original = f.delivered(OWNER, "Обращение №")[0];
    const message = f.message("Ответ после смены режима", OWNER, { reply_to_message: { message_id: original.telegramId } });
    let hookCalls = 0;
    const hook = async () => {
        hookCalls++;
        await Promise.resolve();
        assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM telegram_support_messages WHERE kind = 'reply'").get().count, 0);
        assert.equal(f.delivered(STUDENT, "Ответ после смены режима").length, 0);
    };
    assert.equal(await handleSupportMessage(f.env, message, hook), true);
    assert.equal(await handleSupportMessage(f.env, message, hook), true);
    assert.equal(hookCalls, 1);
    assert.equal(f.delivered(STUDENT, "Ответ после смены режима").length, 1);
});

test("concurrent duplicate native replies invoke the interaction hook only once", async t => {
    const f = fixture(t);
    await f.question();
    const original = f.delivered(SUPPORT_ADMIN, "Обращение №")[0];
    const message = f.message("Параллельный ответ", SUPPORT_ADMIN, { reply_to_message: { message_id: original.telegramId } });
    let calls = 0;
    const hook = async () => { calls++; await Promise.resolve(); };
    await Promise.all([
        handleSupportMessage(f.env, message, hook),
        handleSupportMessage(f.env, message, hook)
    ]);
    assert.equal(calls, 1);
    assert.equal(f.delivered(STUDENT, "Параллельный ответ").length, 1);
});

test("invalid, unauthorized and unrelated inputs never invoke the interaction hook", async t => {
    const f = fixture(t);
    await f.question();
    const original = f.delivered(SUPPORT_ADMIN, "Обращение №")[0];
    let calls = 0;
    const hook = async () => { calls++; };
    await handleSupportMessage(f.env, f.message("Обычный текст", OTHER_STUDENT), hook);
    await f.callback("support");
    await handleSupportMessage(f.env, f.message(undefined, STUDENT, { photo: [{}] }), hook);
    await handleSupportMessage(f.env, f.message("x".repeat(3001)), hook);
    f.revoke();
    await handleSupportMessage(f.env, f.message("Запрещённый ответ", SUPPORT_ADMIN, { reply_to_message: { message_id: original.telegramId } }), hook);
    assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { handleTelegramWebhook } from "../src/telegram-bot.js";

const schema = readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8");
const OWNER = 1001;
const COURSE_ADMIN = 2001;
const OTHER_ADMIN = 2002;
const STUDENT = 3001;

// Real SQLite executes the application's SQL; only the D1 transport is adapted.
class D1Statement {
    constructor(database, sql, values = []) {
        this.database = database;
        this.sql = sql;
        this.values = values;
    }

    bind(...values) {
        return new D1Statement(this.database, this.sql, values);
    }

    execute() {
        const statement = this.database.prepare(this.sql);
        if (statement.columns().length) {
            const results = statement.all(...this.values);
            return { success: true, results, meta: { changes: 0 } };
        }
        const result = statement.run(...this.values);
        return {
            success: true,
            results: [],
            meta: {
                changes: Number(result.changes),
                last_row_id: Number(result.lastInsertRowid)
            }
        };
    }

    async first(column) {
        const row = this.database.prepare(this.sql).get(...this.values);
        return row ? (column ? row[column] : row) : null;
    }

    async all() {
        return this.execute();
    }

    async run() {
        return this.execute();
    }
}

function createFixture(t, { throughWorker = false, expectedErrors = 0 } = {}) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(schema);
    const seedUser = sqlite.prepare("INSERT INTO users (telegram_id, first_name, role) VALUES (?, ?, ?)");
    seedUser.run(OWNER, "Owner", "owner");
    seedUser.run(COURSE_ADMIN, "Course administrator", "admin");
    seedUser.run(OTHER_ADMIN, "Other administrator", "admin");
    seedUser.run(STUDENT, "Student", "student");
    sqlite.prepare(`
        INSERT INTO admin_permissions (admin_id, permission)
        SELECT id, 'courses' FROM users WHERE telegram_id = ?
    `).run(COURSE_ADMIN);

    const env = {
        TELEGRAM_BOT_TOKEN: "test-token-no-network",
        OWNER_TELEGRAM_ID: String(OWNER),
        DB: {
            prepare(sql) {
                return new D1Statement(sqlite, sql);
            },
            async batch(statements) {
                sqlite.exec("BEGIN");
                try {
                    const results = statements.map(statement => statement.execute());
                    sqlite.exec("COMMIT");
                    return results;
                } catch (error) {
                    sqlite.exec("ROLLBACK");
                    throw error;
                }
            }
        }
    };

    const calls = [];
    const errors = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.hostname, "api.telegram.org");
        const method = parsed.pathname.split("/").at(-1);
        assert.ok(["sendMessage", "answerCallbackQuery"].includes(method), method);
        calls.push({ method, ...JSON.parse(options.body) });
        return Response.json({ ok: true, result: { message_id: calls.length } });
    });
    t.mock.method(console, "error", (...args) => errors.push(args));
    t.after(() => {
        sqlite.close();
        assert.equal(errors.length, expectedErrors, "Webhook must not swallow an unexpected error");
    });

    let nextId = 1;
    async function deliver(update) {
        const request = new Request("https://example.test/api/webhooks/telegram", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update)
        });
        const response = throughWorker
            ? await worker.fetch(request, env)
            : await handleTelegramWebhook(request, env);
        assert.equal(response.status, 200);
        return response;
    }

    function textUpdate(text, userId = OWNER, fields = {}) {
        const id = nextId++;
        return {
            update_id: id,
            message: {
                message_id: id,
                chat: { id: userId, type: "private" },
                from: { id: userId, first_name: "Test" },
                ...(text === undefined ? {} : { text }),
                ...fields
            }
        };
    }

    return {
        sqlite,
        env,
        calls,
        errors,
        deliver,
        textUpdate,
        async message(text, userId = OWNER, fields = {}) {
            return deliver(textUpdate(text, userId, fields));
        },
        async callback(data, userId = OWNER) {
            const id = nextId++;
            return deliver({
                update_id: id,
                callback_query: {
                    id: String(id),
                    data,
                    from: { id: userId, first_name: "Test" },
                    message: {
                        message_id: id,
                        chat: { id: userId, type: "private" }
                    }
                }
            });
        },
        messages() {
            return calls.filter(call => call.method === "sendMessage");
        },
        lastMessage() {
            return this.messages().at(-1);
        },
        courses() {
            return sqlite.prepare("SELECT id, name, is_active FROM courses ORDER BY id").all();
        }
    };
}

function buttons(message) {
    const markup = message?.reply_markup || {};
    return [...(markup.keyboard || []), ...(markup.inline_keyboard || [])].flat();
}

function hasButton(message, label) {
    assert.ok(buttons(message).some(button => button.text === label), `Missing button: ${label}`);
}

for (const [name, userId] of [["owner", OWNER], ["administrator with courses permission", COURSE_ADMIN]]) {
    test(`${name} can create a course through private messages`, async t => {
        const f = createFixture(t);
        await f.message("⚙️ Управление", userId);
        hasButton(f.lastMessage(), "📚 Курсы");
        await f.message("📚 Курсы", userId);
        hasButton(f.lastMessage(), "➕ Создать курс");
        hasButton(f.lastMessage(), "📚 Список курсов");
        await f.message("➕ Создать курс", userId);
        hasButton(f.lastMessage(), "❌ Отмена");
        assert.equal(f.courses().length, 0);
        await f.message("  Подготовительный курс  ", userId);
        assert.equal(f.courses().length, 1);
        assert.equal(f.courses()[0].name, "Подготовительный курс");
        assert.equal(f.courses()[0].is_active, 1);
        assert.match(f.lastMessage().text, /Курс создан/i);
        hasButton(f.lastMessage(), "📚 Список курсов");
        hasButton(f.lastMessage(), "⬅️ Админ-панель");
        await f.message("📚 Список курсов", userId);
        assert.match(f.lastMessage().text, /Подготовительный курс/);
    });
}

for (const [name, userId] of [["administrator without courses permission", OTHER_ADMIN], ["student", STUDENT]]) {
    test(`${name} cannot start or submit course creation or read courses`, async t => {
        const f = createFixture(t);
        f.sqlite.prepare("INSERT INTO courses (name) VALUES (?)").run("Private course title");
        await f.message("📚 Курсы", userId);
        assert.match(f.lastMessage().text, /нет доступа/i);
        await f.message("➕ Создать курс", userId);
        assert.match(f.lastMessage().text, /нет доступа/i);
        await f.message("Unauthorized new course", userId);
        assert.equal(f.courses().length, 1);
        await f.message("📚 Список курсов", userId);
        assert.match(f.lastMessage().text, /нет доступа/i);
        await f.callback("admin_courses_list", userId);
        assert.match(f.lastMessage().text, /нет доступа/i);
        assert.ok(f.messages().every(message => !message.text.includes("Private course title")));
    });
}

test("revoking permission between the prompt and name prevents saving", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс", COURSE_ADMIN);
    f.sqlite.prepare(`
        DELETE FROM admin_permissions WHERE admin_id =
            (SELECT id FROM users WHERE telegram_id = ?)
    `).run(COURSE_ADMIN);
    await f.message("Must not be saved", COURSE_ADMIN);
    assert.equal(f.courses().length, 0);
    assert.match(f.lastMessage().text, /нет доступа/i);
});

for (const destination of ["❌ Отмена", "/cancel", "⬅️ Админ-панель", "⬅️ Главное меню", "/start", "📚 Список курсов", "⚙️ Управление"]) {
    test(`${destination} exits course input without becoming a name`, async t => {
        const f = createFixture(t);
        await f.message("➕ Создать курс");
        await f.message(destination);
        assert.equal(f.courses().length, 0);
        if (["❌ Отмена", "/cancel", "📚 Список курсов"].includes(destination)) {
            hasButton(f.lastMessage(), "⬅️ Админ-панель");
        } else if (["⬅️ Админ-панель", "⚙️ Управление"].includes(destination)) {
            hasButton(f.lastMessage(), "📚 Курсы");
        } else {
            hasButton(f.lastMessage(), "⚙️ Управление");
        }
        await f.message("Ordinary message after exit");
        assert.equal(f.courses().length, 0, "Leaving the flow must discard the pending input");
    });
}

test("admin navigation callbacks abandon pending course input", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс");
    await f.callback("admin");
    hasButton(f.lastMessage(), "📚 Курсы");
    await f.message("Unrelated message");
    assert.equal(f.courses().length, 0);
    assert.ok(f.calls.some(call => call.method === "answerCallbackQuery"));
});

test("empty, non-text, short and long names keep the prompt usable", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс");
    for (const invalid of ["   ", undefined, "Я", "А".repeat(101)]) {
        await f.message(invalid, OWNER, invalid === undefined ? { photo: [{ file_id: "fake-photo" }] } : {});
        assert.equal(f.courses().length, 0);
        assert.doesNotMatch(f.lastMessage().text, /Курс создан/i);
    }
    await f.message("Корректный курс");
    assert.equal(f.courses()[0].name, "Корректный курс");
});

test("course names are stored literally and escaped in HTML messages", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс");
    const name = "Курс <b> & ислам";
    await f.message(name);
    assert.equal(f.courses()[0].name, name);
    assert.match(f.lastMessage().text, /Курс &lt;b&gt; &amp; ислам/);
    await f.message("📚 Список курсов");
    assert.match(f.lastMessage().text, /Курс &lt;b&gt; &amp; ислам/);
});

test("an empty list includes course navigation", async t => {
    const f = createFixture(t);
    await f.message("📚 Список курсов");
    assert.match(f.lastMessage().text, /курсов.*нет|нет.*курсов/i);
    hasButton(f.lastMessage(), "⬅️ Админ-панель");
    await f.callback("admin_courses_list");
    assert.match(f.lastMessage().text, /курсов.*нет|нет.*курсов/i);
});

test("large course lists paginate and every course remains reachable", async t => {
    const f = createFixture(t);
    const names = Array.from({ length: 25 }, (_, index) => `Course ${String(index + 1).padStart(2, "0")} ${"a".repeat(80)}`);
    const insert = f.sqlite.prepare("INSERT INTO courses (name) VALUES (?)");
    for (const name of names) insert.run(name);
    await f.message("📚 Список курсов");
    const pending = [];
    const visited = new Set();
    const displayed = new Set();
    let inspectedMessages = 0;
    function inspectPage() {
        const messages = f.messages();
        for (const page of messages.slice(inspectedMessages)) {
            assert.ok(page.text.length <= 4096, "Telegram message must fit the text limit");
            const present = names.filter(name => page.text.includes(name));
            assert.ok(present.length <= 10, "Page must contain at most ten courses");
            for (const name of present) displayed.add(name);
            for (const button of buttons(page)) {
                if (/^admin_courses_page_\d+$/.test(button.callback_data || "") && !visited.has(button.callback_data)) {
                    pending.push(button.callback_data);
                }
            }
        }
        inspectedMessages = messages.length;
    }
    inspectPage();
    assert.ok(pending.length, "A large list needs a next page button");
    while (pending.length) {
        const callback = pending.shift();
        if (visited.has(callback)) continue;
        visited.add(callback);
        assert.ok(visited.size <= 10, "Pagination must be bounded by the available courses");
        await f.callback(callback);
        inspectPage();
    }
    assert.equal(displayed.size, names.length);
});

test("parallel delivery of the same course name creates only one row", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс");
    const update = f.textUpdate("Concurrent delivery course");
    await Promise.all([f.deliver(update), f.deliver(update)]);
    assert.equal(f.courses().length, 1);
    assert.equal(f.courses()[0].name, "Concurrent delivery course");
    await f.deliver(update);
    assert.equal(f.courses().length, 1, "A later replay must also be harmless");
});

test("a replayed earlier message cannot supply a name for a newer prompt", async t => {
    const f = createFixture(t);
    const earlierUpdate = f.textUpdate("Earlier ordinary message");
    await f.deliver(earlierUpdate);
    await f.message("➕ Создать курс");
    await f.deliver(earlierUpdate);
    assert.equal(f.courses().length, 0);
    await f.message("New course after prompt");
    assert.equal(f.courses()[0].name, "New course after prompt");
});

test("a failed state transition rolls back the course insert and permits retry", async t => {
    const f = createFixture(t, { expectedErrors: 1 });
    await f.message("➕ Создать курс");
    f.sqlite.exec(`
        CREATE TRIGGER reject_course_draft_transition
        BEFORE UPDATE ON bot_states
        BEGIN
            SELECT RAISE(ABORT, 'Simulated D1 transaction failure');
        END
    `);
    await f.message("Retry after database failure");
    assert.equal(f.courses().length, 0, "The course insert must be rolled back with the failed state transition");
    assert.match(f.lastMessage().text, /не удалось сохранить/i);
    hasButton(f.lastMessage(), "❌ Отмена");
    f.sqlite.exec("DROP TRIGGER reject_course_draft_transition");
    await f.message("Retry after database failure");
    assert.equal(f.courses().length, 1);
    assert.equal(f.courses()[0].name, "Retry after database failure");
});

test("replaying the entire successful creation cannot create a duplicate", async t => {
    const f = createFixture(t);
    const start = f.textUpdate("➕ Создать курс");
    const name = f.textUpdate("Already created course");
    await f.deliver(start);
    await f.deliver(name);
    assert.equal(f.courses().length, 1);

    await f.deliver(start);
    await f.deliver(name);
    assert.equal(f.courses().length, 1, "Replaying both the prompt command and name must remain harmless");

    await f.message("➕ Создать курс");
    await f.message("A genuinely new course");
    assert.equal(f.courses().length, 2, "A newer creation must still work after ignoring stale messages");
    assert.equal(f.courses()[1].name, "A genuinely new course");
});

for (const cancellation of ["❌ Отмена", "/cancel", "⬅️ Админ-панель"]) {
    test(`replaying creation after ${cancellation} cannot revive the cancelled draft`, async t => {
        const f = createFixture(t);
        const start = f.textUpdate("➕ Создать курс");
        const delayedName = f.textUpdate("Name sent before cancellation");
        const cancel = f.textUpdate(cancellation);
        await f.deliver(start);
        await f.deliver(cancel);

        await f.deliver(start);
        await f.deliver(delayedName);
        await f.deliver(cancel);
        assert.equal(f.courses().length, 0, "Old creation commands and delayed names must not undo cancellation");

        await f.message("➕ Создать курс");
        await f.message("New course after cancellation");
        assert.equal(f.courses().length, 1);
        assert.equal(f.courses()[0].name, "New course after cancellation");
    });
}

for (const destination of ["❌ Отмена", "/cancel", "⬅️ Админ-панель", "⬅️ Главное меню", "/start", "📚 Список курсов", "⚙️ Управление"]) {
    test(`replaying old ${destination} cannot cancel a newer course draft`, async t => {
        const f = createFixture(t);
        const firstStart = f.textUpdate("➕ Создать курс", OWNER, { message_id: 10 });
        const oldNavigation = f.textUpdate(destination, OWNER, { message_id: 11 });
        const newStart = f.textUpdate("➕ Создать курс", OWNER, { message_id: 12 });
        const newName = f.textUpdate("The currently requested course", OWNER, { message_id: 13 });
        await f.deliver(firstStart);
        await f.deliver(oldNavigation);
        await f.deliver(newStart);
        await f.deliver(oldNavigation);
        await f.deliver(newName);
        assert.equal(f.courses().length, 1, "A stale navigation delivery must not abandon a newer prompt");
        assert.equal(f.courses()[0].name, "The currently requested course");
    });
}

test("a fresh inline callback on an older bot message still abandons course input", async t => {
    const f = createFixture(t);
    await f.deliver(f.textUpdate("➕ Создать курс", OWNER, { message_id: 12 }));
    await f.deliver({
        update_id: 13,
        callback_query: {
            id: "fresh-click-on-an-old-bot-message",
            data: "admin",
            from: { id: OWNER },
            message: { message_id: 5, chat: { id: OWNER, type: "private" } }
        }
    });
    hasButton(f.lastMessage(), "📚 Курсы");
    await f.deliver(f.textUpdate("Ordinary message after a fresh callback", OWNER, { message_id: 14 }));
    assert.equal(f.courses().length, 0, "An old bot message ID must not make a fresh inline click look stale");
});

test("private-chat identity checks prevent group or mismatched senders consuming a draft", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс");
    for (const fields of [
        { chat: { id: -100123, type: "supergroup" } },
        { chat: { id: OWNER, type: "group" } },
        { from: { id: STUDENT, first_name: "Different sender" } },
        { from: undefined }
    ]) {
        await f.message("Must remain outside course input", OWNER, fields);
        assert.equal(f.courses().length, 0);
    }
    await f.deliver({ callback_query: {
        id: "invalid-private-callback",
        data: "admin",
        from: { id: STUDENT },
        message: { message_id: 500, chat: { id: OWNER, type: "private" } }
    } });
    await f.message("Owner completes their own course");
    assert.equal(f.courses().length, 1, "Unrelated chats and senders must not clear the owner's draft");
    assert.equal(f.courses()[0].name, "Owner completes their own course");
});

test("two administrators have independent course drafts", async t => {
    const f = createFixture(t);
    await f.message("➕ Создать курс", OWNER);
    await f.message("➕ Создать курс", COURSE_ADMIN);
    await f.message("❌ Отмена", COURSE_ADMIN);
    await f.message("Course administrator's unrelated message", COURSE_ADMIN);
    await f.message("Owner's own course", OWNER);
    assert.equal(f.courses().length, 1);
    assert.equal(f.courses()[0].name, "Owner's own course");
});

test("existing legacy course input can still complete", async t => {
    const f = createFixture(t);
    // This is the already-deployed state table, not a new application schema.
    f.sqlite.exec(`CREATE TABLE bot_states (
        chat_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    f.sqlite.prepare("INSERT INTO bot_states (chat_id, state) VALUES (?, ?)").run(OWNER, "create_course_name");
    await f.message("Legacy flow course");
    assert.equal(f.courses().length, 1);
    assert.equal(f.courses()[0].name, "Legacy flow course");
});

test("the production worker route dispatches course messages to the Telegram handler", async t => {
    const f = createFixture(t, { throughWorker: true });
    await f.message("➕ Создать курс");
    await f.message("Course through worker route");
    assert.equal(f.courses().length, 1);
    assert.equal(f.courses()[0].name, "Course through worker route");
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM payments").get().count, 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM user_semesters").get().count, 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('tribute_events', 'user_program_access')").get().count, 0);
});

test("webhook keeps its existing unconfigured and malformed request responses", async () => {
    const unconfigured = await handleTelegramWebhook(new Request("https://example.test", { method: "POST", body: "{}" }), {});
    assert.equal(unconfigured.status, 503);
    const malformed = await handleTelegramWebhook(new Request("https://example.test", { method: "POST", body: "{" }), { TELEGRAM_BOT_TOKEN: "test" });
    assert.equal(malformed.status, 400);
});

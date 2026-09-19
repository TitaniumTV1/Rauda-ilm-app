// Semester payments use the existing payments ledger and user_semesters grants.
// This sidecar stores checkout correlation, never a client assertion of payment.
const schemaPromises = new WeakMap();
const encoder = new TextEncoder();
const SETTINGS_KEY = "semester_payment_settings";
const CURRENCIES = new Set(["RUB", "USD", "EUR"]);
const DEFAULT_SETTINGS = { payments_enabled: true, tribute_enabled: false, yoomoney_enabled: false, yoomoney_wallet: "" };
const yooSecret = env => env.YOOMONEY_NOTIFICATION_SECRET || env.YOOMONEY_WEBHOOK_SECRET;

export class PaymentError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
const stmt = (db, sql, values = []) => db.prepare(sql).bind(...values);
const first = (db, sql, values) => stmt(db, sql, values).first();
const rows = async (db, sql, values) => (await stmt(db, sql, values).all()).results || [];
const run = (db, sql, values) => stmt(db, sql, values).run();
const changed = result => Number(result?.meta?.changes || 0) > 0;
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

async function initialize(db) {
    await db.batch([
        stmt(db, `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
        stmt(db, `CREATE TABLE IF NOT EXISTS semester_payment_methods (
            semester_id INTEGER PRIMARY KEY, yoomoney_enabled INTEGER NOT NULL DEFAULT 1,
            tribute_enabled INTEGER NOT NULL DEFAULT 0, tribute_url TEXT NOT NULL DEFAULT '',
            tribute_product_id TEXT NOT NULL DEFAULT '', tribute_currency TEXT NOT NULL DEFAULT 'RUB',
            tribute_amount_minor INTEGER NOT NULL DEFAULT 0)`),
        stmt(db, `CREATE TABLE IF NOT EXISTS semester_payment_grants (
            order_label TEXT PRIMARY KEY, user_id INTEGER NOT NULL, semester_id INTEGER NOT NULL,
            granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        stmt(db, `CREATE TABLE IF NOT EXISTS semester_payment_orders (
            order_uid TEXT PRIMARY KEY, payment_id INTEGER UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
            semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK(provider IN ('tribute','yoomoney')),
            telegram_id INTEGER NOT NULL, provider_product_id TEXT NOT NULL DEFAULT '',
            amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, tuition_price_rub INTEGER NOT NULL, receiver TEXT NOT NULL DEFAULT '',
            payment_url TEXT NOT NULL, active_key TEXT UNIQUE, provider_payment_id TEXT,
            checkout_sent_at TEXT, confirmation_sent_at TEXT, checkout_claimed_at INTEGER,
            confirmation_claimed_at INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(provider, provider_payment_id))`),
        stmt(db, `CREATE TABLE IF NOT EXISTS semester_payment_events (
            provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL,
            order_uid TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(provider,event_id,event_type))`)
    ]);
    const methods = await rows(db, "PRAGMA table_info(semester_payment_methods)");
    const fields = new Set(methods.map(row => row.name));
    for (const [name, definition] of [
        ["tribute_product_id", "TEXT NOT NULL DEFAULT ''"],
        ["tribute_currency", "TEXT NOT NULL DEFAULT 'RUB'"],
        ["tribute_amount_minor", "INTEGER NOT NULL DEFAULT 0"]
    ]) {
        if (!fields.has(name)) {
            try { await run(db, `ALTER TABLE semester_payment_methods ADD COLUMN ${name} ${definition}`); }
            catch (error) {
                // Another isolate can finish the same additive migration first.
                if (!(await rows(db, "PRAGMA table_info(semester_payment_methods)")).some(row => row.name === name)) throw error;
            }
        }
    }
    await run(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_semester_tribute_product ON semester_payment_methods(tribute_product_id) WHERE tribute_product_id<>''");
    const [paymentColumns, accessColumns] = await Promise.all([
        rows(db, "PRAGMA table_info(payments)"), rows(db, "PRAGMA table_info(user_semesters)")
    ]);
    return { paymentColumns: new Set(paymentColumns.map(row => row.name)), accessColumns };
}

export async function ensurePaymentTables(env) {
    if (!env.DB) throw new PaymentError("База данных не настроена", 503);
    if (!schemaPromises.has(env.DB)) schemaPromises.set(env.DB, initialize(env.DB).catch(error => { schemaPromises.delete(env.DB); throw error; }));
    return schemaPromises.get(env.DB);
}

async function settingsFor(env) {
    await ensurePaymentTables(env);
    const row = await first(env.DB, "SELECT value FROM app_settings WHERE key = ?", [SETTINGS_KEY]);
    const master = await first(env.DB, "SELECT value FROM app_settings WHERE key='payments_enabled'");
    let saved = {};
    try { saved = JSON.parse(row?.value || "{}"); } catch { /* Disabled defaults on invalid config. */ }
    return { payments_enabled: !["0", "false"].includes(master?.value), tribute_enabled: saved?.tribute_enabled === true, yoomoney_enabled: saved?.yoomoney_enabled === true,
        yoomoney_wallet: typeof saved?.yoomoney_wallet === "string" ? saved.yoomoney_wallet : String(env.YOOMONEY_WALLET || "") };
}

function bool(value, field) {
    if ([true, 1, "1"].includes(value)) return true;
    if ([false, 0, "0"].includes(value)) return false;
    throw new PaymentError(`Некорректное значение ${field}`);
}
function integer(value, minimum, maximum, label) {
    if (value === "" || value === null || typeof value === "boolean" || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new PaymentError(`Некорректное значение: ${label}`);
    return Number(value);
}
function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new PaymentError(`Некорректные поля: ${label}`);
}
function tributeReference(url) {
    if (url.hostname === "t.me" && ["/tribute/app", "/tribute_bot/app"].includes(url.pathname)
        && [...url.searchParams.keys()].length === 1) return url.searchParams.get("startapp")?.match(/^p([A-Za-z0-9_-]{1,128})$/)?.[1];
    if (url.hostname === "web.tribute.tg" && !url.search) return url.pathname.match(/^\/p\/([A-Za-z0-9_-]{1,128})$/)?.[1];
    return null;
}
function tributeUrl(value) {
    if (!value) return "";
    let url;
    try { url = new URL(value); } catch { throw new PaymentError("Некорректная ссылка Tribute"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !tributeReference(url)) throw new PaymentError("Ссылка Tribute должна вести на цифровой продукт");
    return url.href;
}

async function verifyTributeProduct(env, semester) {
    let response, product;
    try {
        response = await fetch(`https://tribute.tg/api/v1/products/${semester.tribute_product_id}`, {
            headers: { "Api-Key": env.TRIBUTE_API_KEY, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error("Product unavailable");
        product = await response.json();
    } catch {
        throw new PaymentError("Не удалось проверить продукт Tribute. Повторите позже или напишите администратору.", 503);
    }
    const reference = tributeReference(new URL(tributeUrl(semester.tribute_url)));
    const references = [];
    for (const value of [product.link,product.webLink]) {
        try { references.push(tributeReference(new URL(tributeUrl(value)))); } catch { /* Invalid upstream links never authorize a checkout. */ }
    }
    if (Number(product.id) !== Number(semester.tribute_product_id) || product.type !== "digital" || product.status !== "approved"
        || Number(product.amount) !== semester.tribute_amount_minor || String(product.currency).toUpperCase() !== semester.tribute_currency
        || !references.includes(reference)) throw new PaymentError("Настройки Tribute не совпадают с продуктом: проверьте ID, ссылку, сумму, валюту и статус публикации.", 409);
}

async function semesterRows(env) {
    return rows(env.DB, `SELECT s.id,s.name,s.number,s.program_id,s.course_id,s.price_rub,s.payment_enabled,s.is_active,
        c.name AS course_name,c.is_active AS course_active,p.is_active AS program_active,
        COALESCE(m.yoomoney_enabled,1) AS yoomoney_enabled,COALESCE(m.tribute_enabled,0) AS tribute_enabled,
        COALESCE(m.tribute_url,'') AS tribute_payment_url,COALESCE(m.tribute_product_id,'') AS tribute_product_id,
        COALESCE(m.tribute_currency,'RUB') AS tribute_currency,COALESCE(m.tribute_amount_minor,0) AS tribute_amount_minor
        FROM semesters s JOIN courses c ON c.id=s.course_id JOIN programs p ON p.id=s.program_id AND p.course_id=s.course_id
        LEFT JOIN semester_payment_methods m ON m.semester_id=s.id
        ORDER BY c.id,s.number,s.id`);
}

export async function getPaymentSettings(env) {
    const settings = await settingsFor(env);
    return {
        settings,
        integration: {
            tribute: { secret_configured: Boolean(env.TRIBUTE_API_KEY), env_name: "TRIBUTE_API_KEY", webhook_path: "/api/webhooks/tribute", docs_url: "https://wiki.tribute.tg/for-content-creators/info-products-and-content/api-integration" },
            yoomoney: { secret_configured: Boolean(yooSecret(env)), env_name: env.YOOMONEY_NOTIFICATION_SECRET ? "YOOMONEY_NOTIFICATION_SECRET" : "YOOMONEY_WEBHOOK_SECRET", webhook_path: "/api/webhooks/yoomoney", docs_url: "https://yoomoney.ru/docs/payment-buttons/using-api/notifications" }
        },
        semesters: await semesterRows(env)
    };
}

export async function updatePaymentSettings(env, body, { guard } = {}) {
    exactKeys(body, ["settings", "semesters"], "настройки оплаты");
    const current = await getPaymentSettings(env);
    const settings = { ...current.settings };
    if (body.settings !== undefined) {
        exactKeys(body.settings, Object.keys(DEFAULT_SETTINGS), "способы оплаты");
        for (const key of ["payments_enabled", "tribute_enabled", "yoomoney_enabled"]) if (key in body.settings) settings[key] = bool(body.settings[key], key);
        if ("yoomoney_wallet" in body.settings) {
            settings.yoomoney_wallet = String(body.settings.yoomoney_wallet).trim();
            if (settings.yoomoney_wallet && !/^4100\d{7,16}$/.test(settings.yoomoney_wallet)) throw new PaymentError("Введите номер кошелька ЮMoney, начинающийся с 4100");
        }
    }
    if (body.semesters !== undefined && (!Array.isArray(body.semesters) || body.semesters.length > 200)) throw new PaymentError("Некорректный список семестров");
    const updates = [];
    const seen = new Set();
    const merged = new Map(current.semesters.map(row => [Number(row.id), { ...row }]));
    for (const input of body.semesters || []) {
        exactKeys(input, ["id", "price_rub", "payment_enabled", "yoomoney_enabled", "tribute_enabled", "tribute_product_id", "tribute_payment_url", "tribute_currency", "tribute_amount_minor"], "семестр");
        const id = positiveId(input.id);
        if (!id || !merged.has(id) || seen.has(id)) throw new PaymentError("Семестр не найден или указан повторно");
        seen.add(id);
        const item = merged.get(id);
        if ("price_rub" in input) item.price_rub = integer(input.price_rub, 0, 1000000, "цена семестра");
        for (const key of ["payment_enabled", "yoomoney_enabled", "tribute_enabled"]) if (key in input) item[key] = Number(bool(input[key], key));
        if ("tribute_product_id" in input) {
            item.tribute_product_id = String(input.tribute_product_id).trim();
            if (item.tribute_product_id && !/^[1-9]\d{0,14}$/.test(item.tribute_product_id)) throw new PaymentError("Укажите числовой ID цифрового продукта Tribute");
        }
        if ("tribute_currency" in input) item.tribute_currency = String(input.tribute_currency).toUpperCase();
        if (!CURRENCIES.has(item.tribute_currency)) throw new PaymentError("Валюта Tribute: RUB, USD или EUR");
        if ("tribute_amount_minor" in input) item.tribute_amount_minor = integer(input.tribute_amount_minor, 0, 100000000, "сумма Tribute");
        item.tribute_payment_url = tributeUrl("tribute_payment_url" in input ? String(input.tribute_payment_url).trim() : item.tribute_payment_url, item.tribute_product_id);
        if (item.tribute_enabled && (!item.tribute_product_id || !item.tribute_payment_url || item.tribute_amount_minor < 1)) throw new PaymentError("Для Tribute задайте ID продукта, его ссылку, валюту и точную сумму");
        updates.push(item);
    }
    const products = new Set();
    for (const item of merged.values()) {
        if (!item.tribute_product_id) continue;
        if (products.has(item.tribute_product_id)) throw new PaymentError("Каждому семестру нужен отдельный цифровой продукт Tribute");
        products.add(item.tribute_product_id);
        const historical = await first(env.DB, "SELECT semester_id FROM semester_payment_orders WHERE provider='tribute' AND provider_product_id=? AND semester_id<>? LIMIT 1", [item.tribute_product_id,item.id]);
        if (historical) throw new PaymentError("Этот продукт Tribute уже использовался для другого семестра. Создайте отдельный продукт.");
    }
    if (guard && (!positiveId(guard.chatId) || !positiveId(guard.messageId) || typeof guard.state !== "string")) throw new PaymentError("Некорректное состояние ввода", 409);
    const guardSql = guard ? `EXISTS(SELECT 1 FROM telegram_payment_drafts d JOIN users u ON u.telegram_id=d.chat_id
        WHERE d.chat_id=? AND d.state=? AND d.after_id<? AND u.role='owner' AND u.status='active')` : "1";
    const guardValues = guard ? [guard.chatId,guard.state,guard.messageId] : [];
    const statements = [stmt(env.DB, `INSERT INTO app_settings(key,value,updated_at) SELECT ?,?,CURRENT_TIMESTAMP WHERE ${guardSql}
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP WHERE ${guardSql}`, [SETTINGS_KEY, JSON.stringify(settings),...guardValues,...guardValues]),
    stmt(env.DB, `INSERT INTO app_settings(key,value,updated_at) SELECT 'payments_enabled',?,CURRENT_TIMESTAMP WHERE ${guardSql}
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP WHERE ${guardSql}`, [settings.payments_enabled ? "1" : "0",...guardValues,...guardValues])];
    for (const item of updates) {
        statements.push(stmt(env.DB, `UPDATE semesters SET price_rub=?,payment_enabled=? WHERE id=? AND ${guardSql}`, [item.price_rub, item.payment_enabled, item.id,...guardValues]));
        statements.push(stmt(env.DB, `INSERT INTO semester_payment_methods(semester_id,yoomoney_enabled,tribute_enabled,tribute_url,tribute_product_id,tribute_currency,tribute_amount_minor)
            SELECT ?,?,?,?,?,?,? WHERE ${guardSql} ON CONFLICT(semester_id) DO UPDATE SET yoomoney_enabled=excluded.yoomoney_enabled,
            tribute_enabled=excluded.tribute_enabled,tribute_url=excluded.tribute_url,tribute_product_id=excluded.tribute_product_id,
            tribute_currency=excluded.tribute_currency,tribute_amount_minor=excluded.tribute_amount_minor WHERE ${guardSql}`,
        [item.id,item.yoomoney_enabled,item.tribute_enabled,item.tribute_payment_url,item.tribute_product_id,item.tribute_currency,item.tribute_amount_minor,...guardValues,...guardValues]));
    }
    if (guard) statements.push(stmt(env.DB, `UPDATE telegram_payment_drafts SET state=NULL,after_id=? WHERE chat_id=? AND state=? AND after_id<?
        AND EXISTS(SELECT 1 FROM users WHERE telegram_id=telegram_payment_drafts.chat_id AND role='owner' AND status='active')`, [guard.messageId,...guardValues]));
    const saved = await env.DB.batch(statements);
    if (guard && !changed(saved.at(-1))) throw new PaymentError("Этот ввод уже отменён или обработан", 409);
    return getPaymentSettings(env);
}

async function activeUser(env, userId) {
    const user = await first(env.DB, "SELECT id,telegram_id,status FROM users WHERE id=?", [userId]);
    if (!user || user.status !== "active") throw new PaymentError("Аккаунт недоступен", 403);
    return user;
}

export async function getPaymentOptions(env, userId, semesterId) {
    const settings = await settingsFor(env);
    const user = await activeUser(env, userId);
    const semester = (await semesterRows(env)).find(item => Number(item.id) === Number(semesterId) && item.is_active && item.course_active && item.program_active);
    if (!semester) throw new PaymentError("Семестр не найден", 404);
    const access = await first(env.DB, "SELECT status FROM user_semesters WHERE user_id=? AND semester_id=?", [userId, semesterId]);
    const enabledSetting = await first(env.DB, "SELECT value FROM app_settings WHERE key='payments_enabled'");
    const baseReason = access?.status === "blocked" ? "Доступ к семестру заблокирован. Напишите администратору."
        : access?.status === "active" ? "Этот семестр уже оплачен"
        : !positiveId(user.telegram_id) ? "Сначала привяжите Telegram и запустите бота"
        : ["0", "false"].includes(enabledSetting?.value) || !semester.payment_enabled ? "Оплата семестра выключена"
        : semester.price_rub <= 0 ? "Цена семестра ещё не указана" : "";
    const options = ["tribute", "yoomoney"].map(provider => {
        let reason = baseReason;
        if (!reason && (!settings[`${provider}_enabled`] || !semester[`${provider}_enabled`])) reason = "Способ оплаты выключен";
        if (!reason && provider === "tribute" && (!env.TRIBUTE_API_KEY || !semester.tribute_product_id || !semester.tribute_payment_url || !semester.tribute_amount_minor)) reason = "Tribute ещё не настроен";
        if (!reason && provider === "yoomoney" && (!yooSecret(env) || !settings.yoomoney_wallet)) reason = "ЮMoney ещё не настроен";
        return { provider, label: provider === "tribute" ? "Tribute" : "ЮMoney", enabled: !reason, reason,
            amount: provider === "tribute" ? semester.tribute_amount_minor / 100 : semester.price_rub,
            amount_minor: provider === "tribute" ? semester.tribute_amount_minor : semester.price_rub * 100,
            currency: provider === "tribute" ? semester.tribute_currency : "RUB" };
    });
    return { semester: { id: semester.id, name: semester.name || `${semester.number} семестр`, course_name: semester.course_name,
        price_rub: semester.price_rub, payment_enabled: Boolean(semester.payment_enabled) },
    access_granted: access?.status === "active", telegram_linked: Boolean(positiveId(user.telegram_id)), options };
}

const ORDER_SELECT = `SELECT o.*,p.user_id,p.course_id,o.tuition_price_rub AS amount_rub,p.status,p.paid_at,
    s.program_id,s.name AS semester_name,s.number AS semester_number,c.name AS course_name
    FROM semester_payment_orders o JOIN payments p ON p.id=o.payment_id
    JOIN semesters s ON s.id=o.semester_id JOIN courses c ON c.id=s.course_id`;

function publicOrder(order) {
    return { order_uid: order.order_uid, semester_id: order.semester_id, provider: order.provider,
        amount_rub: order.amount_rub, amount: order.amount_minor / 100, amount_minor: order.amount_minor, currency: order.currency,
        status: order.status, payment_url: order.payment_url, telegram_sent: Boolean(order.checkout_sent_at),
        confirmed_in_telegram: Boolean(order.confirmation_sent_at) };
}
export async function getSemesterOrder(env, userId, orderUid) {
    await ensurePaymentTables(env);
    await activeUser(env, userId);
    const order = await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=? AND p.user_id=?`, [orderUid, userId]);
    if (!order) throw new PaymentError("Заказ не найден", 404);
    if (order.status === "paid" && !order.confirmation_sent_at) await sendOrderNotification(env, order, "confirmation");
    return publicOrder(await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=?`, [orderUid]));
}

function appOrigin(env, origin) {
    let url;
    try { url = new URL(env.PUBLIC_APP_URL || origin); } catch { throw new PaymentError("Не настроен адрес приложения", 503); }
    if (url.protocol !== "https:" || url.username || url.password) throw new PaymentError("Не настроен HTTPS-адрес приложения", 503);
    return url.origin;
}

export async function createSemesterCheckout(env, { userId, semesterId, provider, origin }) {
    if (!positiveId(semesterId) || !["tribute", "yoomoney"].includes(provider)) throw new PaymentError("Выберите семестр и способ оплаты");
    const schema = await ensurePaymentTables(env);
    const available = await getPaymentOptions(env, userId, semesterId);
    const option = available.options.find(item => item.provider === provider);
    if (!option.enabled) throw new PaymentError(option.reason, 409);
    const [settings, semester, user] = await Promise.all([
        settingsFor(env), first(env.DB, `SELECT s.*,m.tribute_product_id,m.tribute_url,m.tribute_currency,m.tribute_amount_minor
            FROM semesters s LEFT JOIN semester_payment_methods m ON m.semester_id=s.id WHERE s.id=?`, [semesterId]), activeUser(env, userId)
    ]);
    if (provider === "tribute") await verifyTributeProduct(env, semester);
    const uid = `ri_${crypto.randomUUID().replaceAll("-", "")}`;
    const key = `${userId}:${semesterId}:${provider}:${provider === "tribute" ? `${semester.tribute_product_id}:${semester.tribute_currency}:${semester.tribute_amount_minor}` : `${settings.yoomoney_wallet}:RUB:${semester.price_rub * 100}`}`;
    const url = provider === "tribute" ? tributeUrl(semester.tribute_url, semester.tribute_product_id) : `${appOrigin(env, origin)}/api/payments/pay/${uid}`;
    const fields = ["user_id", "course_id", "amount", "currency", "status"];
    const values = [userId, semester.course_id, provider === "tribute" ? semester.tribute_amount_minor : semester.price_rub * 100,
        provider === "tribute" ? semester.tribute_currency : "RUB", "pending"];
    if (schema.paymentColumns.has("provider")) { fields.push("provider"); values.push(provider); }
    if (schema.paymentColumns.has("payment_method")) { fields.push("payment_method"); values.push(provider); }
    await env.DB.batch([
        stmt(env.DB, `INSERT OR IGNORE INTO semester_payment_orders(order_uid,semester_id,provider,telegram_id,provider_product_id,
            amount_minor,currency,tuition_price_rub,receiver,payment_url,active_key) SELECT ?,?,?,?,?,?,?,?,?,?,?
            WHERE EXISTS(SELECT 1 FROM semesters s JOIN courses c ON c.id=s.course_id JOIN programs p ON p.id=s.program_id
                AND p.course_id=s.course_id WHERE s.id=? AND s.is_active=1 AND c.is_active=1 AND p.is_active=1)
            AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND telegram_id=?)`,
        [uid,semesterId,provider,user.telegram_id,provider === "tribute" ? semester.tribute_product_id : "",
            provider === "tribute" ? semester.tribute_amount_minor : semester.price_rub * 100,
            provider === "tribute" ? semester.tribute_currency : "RUB",semester.price_rub,provider === "yoomoney" ? settings.yoomoney_wallet : "",url,key,
            semesterId,userId,user.telegram_id]),
        stmt(env.DB, `INSERT INTO payments(${fields.join(",")}) SELECT ${fields.map(() => "?").join(",")}
            FROM semester_payment_orders WHERE order_uid=? AND payment_id IS NULL`, [...values,uid]),
        stmt(env.DB, "UPDATE semester_payment_orders SET payment_id=last_insert_rowid() WHERE order_uid=? AND payment_id IS NULL", [uid])
    ]);
    let order = await first(env.DB, `${ORDER_SELECT} WHERE o.active_key=?`, [key]);
    if (!order) throw new PaymentError("Не удалось создать заказ", 503);
    await sendOrderNotification(env, order, "checkout");
    order = await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=?`, [order.order_uid]);
    return publicOrder(order);
}

async function sendOrderNotification(env, order, kind) {
    if (!env.TELEGRAM_BOT_TOKEN || order[`${kind}_sent_at`]) return Boolean(order[`${kind}_sent_at`]);
    const user = await first(env.DB, "SELECT telegram_id,status FROM users WHERE id=?", [order.user_id]);
    if (user?.status !== "active" || Number(user.telegram_id) !== Number(order.telegram_id)) return false;
    const claimed = await run(env.DB, `UPDATE semester_payment_orders SET ${kind}_claimed_at=unixepoch()
        WHERE order_uid=? AND ${kind}_sent_at IS NULL AND (${kind}_claimed_at IS NULL OR ${kind}_claimed_at < unixepoch()-90)`, [order.order_uid]);
    if (!changed(claimed)) return false;
    try {
        const title = `${order.course_name} · ${order.semester_name || `${order.semester_number} семестр`}`;
        let text = kind === "checkout" ? `💳 Оплата семестра\n${title}\n${order.amount_minor / 100} ${order.currency}\nСпособ: ${order.provider === "tribute" ? "Tribute" : "ЮMoney"}\n\nПосле оплаты дождитесь подтверждения в этом чате.`
            : `✅ Оплата подтверждена\n${title}\n\nДоступ к оплаченному семестру открыт. Найти его можно через «📚 Курсы».`;
        const keyboard = [];
        if (kind === "checkout") keyboard.push([{ text: "Перейти к оплате", url: order.payment_url }]);
        if (kind === "confirmation") {
            const access = await first(env.DB, `SELECT us.status FROM user_semesters us JOIN semesters s ON s.id=us.semester_id
                JOIN courses c ON c.id=s.course_id JOIN programs p ON p.id=s.program_id AND p.course_id=s.course_id
                WHERE us.user_id=? AND us.semester_id=? AND s.is_active=1 AND c.is_active=1 AND p.is_active=1`, [order.user_id, order.semester_id]);
            if (access?.status !== "active") text = `✅ Оплата получена\n${title}\n\nДоступ сейчас ограничен. Напишите администратору через обратную связь.`;
            else {
                const linkTable = await first(env.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_learning_links'");
                const link = linkTable ? await first(env.DB, "SELECT url FROM telegram_learning_links WHERE kind='semester' AND id=?", [order.semester_id]) : null;
                if (link?.url && /^https:\/\/(t\.me|telegram\.me)\//.test(link.url)) keyboard.push([{ text: "Открыть канал семестра", url: link.url }]);
                keyboard.push([{ text: "📚 Открыть семестр", callback_data: `learn_semester_${order.semester_id}_0` }]);
            }
        }
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: order.telegram_id, text,
                ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error("Telegram delivery failed");
        await run(env.DB, `UPDATE semester_payment_orders SET ${kind}_sent_at=CURRENT_TIMESTAMP,${kind}_claimed_at=NULL WHERE order_uid=?`, [order.order_uid]);
        return true;
    } catch {
        await run(env.DB, `UPDATE semester_payment_orders SET ${kind}_claimed_at=NULL WHERE order_uid=?`, [order.order_uid]);
        return false;
    }
}

async function hmacHex(secret, value) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameSignature(actual, expected) {
    if (!/^[a-fA-F0-9]{64}$/.test(actual || "")) return false;
    let difference = 0;
    const normalized = actual.toLowerCase();
    for (let i = 0; i < expected.length; i++) difference |= normalized.charCodeAt(i) ^ expected.charCodeAt(i);
    return difference === 0;
}
export async function verifyTributeSignature(request, rawBody, env) {
    if (!env.TRIBUTE_API_KEY) return false;
    return sameSignature(request.headers.get("trbt-signature"), await hmacHex(env.TRIBUTE_API_KEY, rawBody));
}
const rfc3986 = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export async function verifyYooMoneySignature(params, secret) {
    if (!secret) return false;
    const keys = [...params.keys()];
    if (keys.length !== new Set(keys).size) return false;
    const canonical = keys.filter(key => key !== "sign").sort().map(key => `${key}=${rfc3986(params.get(key))}`).join("&");
    return sameSignature(params.get("sign"), await hmacHex(secret, canonical));
}
function moneyMinor(value) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
    const [whole, decimal = ""] = String(value).split(".");
    const minor = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
    return Number.isSafeInteger(minor) ? minor : null;
}

async function settleOrder(env, order, eventId) {
    const { accessColumns, paymentColumns } = await ensurePaymentTables(env);
    const accessNames = new Set(accessColumns.map(column => column.name));
    const insertFields = ["user_id", "semester_id", "status", "access_until"];
    // The repository's old schema requires a date; live D1 allows NULL.
    // Access checks use status, so no paid semester expires by this value.
    const legacyDate = accessColumns.find(column => column.name === "access_until")?.notnull ? "9999-12-31 23:59:59" : null;
    const insertValues = [order.user_id, order.semester_id, "active", legacyDate];
    if (accessNames.has("program_id")) { insertFields.push("program_id"); insertValues.push(order.program_id); }
    if (accessNames.has("payment_source")) { insertFields.push("payment_source"); insertValues.push(order.provider); }
    if (accessNames.has("external_payment_id")) { insertFields.push("external_payment_id"); insertValues.push(eventId); }
    const paymentExtras = [];
    const paymentValues = [];
    if (paymentColumns.has("external_payment_id")) { paymentExtras.push("external_payment_id=?"); paymentValues.push(eventId); }
    if (paymentColumns.has("webhook_event_id")) { paymentExtras.push("webhook_event_id=?"); paymentValues.push(`${order.provider}:${eventId}`); }
    if (order.provider === "tribute" && paymentColumns.has("tribute_purchase_id")) { paymentExtras.push("tribute_purchase_id=?"); paymentValues.push(eventId); }
    await env.DB.batch([
        stmt(env.DB, `INSERT OR IGNORE INTO semester_payment_events(provider,event_id,event_type,order_uid) VALUES(?,?,'paid',?)`, [order.provider,eventId,order.order_uid]),
        stmt(env.DB, `UPDATE semester_payment_orders SET provider_payment_id=?,active_key=NULL WHERE order_uid=?
            AND (provider_payment_id IS NULL OR provider_payment_id=?)
            AND NOT EXISTS(SELECT 1 FROM semester_payment_events WHERE provider=? AND event_id=? AND event_type='refunded')`, [eventId,order.order_uid,eventId,order.provider,eventId]),
        stmt(env.DB, `UPDATE payments SET status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
            ${paymentExtras.length ? `,${paymentExtras.join(",")}` : ""} WHERE id=? AND status='pending'
            AND EXISTS(SELECT 1 FROM semester_payment_orders WHERE order_uid=? AND provider_payment_id=?)
            AND NOT EXISTS(SELECT 1 FROM semester_payment_events WHERE provider=? AND event_id=? AND event_type='refunded')`, [...paymentValues,order.payment_id,order.order_uid,eventId,order.provider,eventId]),
        stmt(env.DB, `INSERT OR IGNORE INTO semester_payment_grants(order_label,user_id,semester_id)
            SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM payments WHERE id=? AND status='paid')
            AND NOT EXISTS(SELECT 1 FROM user_semesters WHERE user_id=? AND semester_id=? AND status='blocked')
            AND (NOT EXISTS(SELECT 1 FROM user_semesters WHERE user_id=? AND semester_id=? AND status='active')
                OR EXISTS(SELECT 1 FROM semester_payment_grants g JOIN semester_payment_orders o ON o.order_uid=g.order_label
                    JOIN payments p ON p.id=o.payment_id WHERE g.user_id=? AND g.semester_id=? AND p.status='paid'))`,
        [order.order_uid,order.user_id,order.semester_id,order.payment_id,order.user_id,order.semester_id,order.user_id,order.semester_id,order.user_id,order.semester_id]),
        stmt(env.DB, `INSERT INTO user_semesters(${insertFields.join(",")}) SELECT ${insertFields.map(() => "?").join(",")}
            WHERE EXISTS(SELECT 1 FROM semester_payment_grants WHERE order_label=?)
            AND EXISTS(SELECT 1 FROM payments WHERE id=? AND status='paid')
            ON CONFLICT(user_id,semester_id) DO UPDATE SET status='active',access_until=excluded.access_until,updated_at=CURRENT_TIMESTAMP
            ${accessNames.has("payment_source") ? ",payment_source=excluded.payment_source,external_payment_id=excluded.external_payment_id" : ""}
            WHERE user_semesters.status='expired'`, [...insertValues,order.order_uid,order.payment_id])
    ]);
    const updated = await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=?`, [order.order_uid]);
    if (updated.status === "paid") return { paid: true, notified: await sendOrderNotification(env, updated, "confirmation") };
    return { paid: false, notified: true };
}

async function refundOrder(env, order, eventId) {
    const { accessColumns } = await ensurePaymentTables(env);
    const hasGrantedBy = accessColumns.some(column => column.name === "granted_by");
    await env.DB.batch([
        stmt(env.DB, "INSERT OR IGNORE INTO semester_payment_events(provider,event_id,event_type,order_uid) VALUES(?,?,'refunded',?)", [order.provider,eventId,order.order_uid]),
        stmt(env.DB, "UPDATE payments SET status='refunded',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid'", [order.payment_id]),
        stmt(env.DB, `UPDATE user_semesters SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND semester_id=? AND status='active'
            ${hasGrantedBy ? "AND granted_by IS NULL" : ""}
            AND EXISTS(SELECT 1 FROM semester_payment_grants WHERE order_label=?)
            AND NOT EXISTS(SELECT 1 FROM semester_payment_orders o JOIN payments p ON p.id=o.payment_id
                WHERE p.user_id=? AND o.semester_id=? AND p.status='paid')`,
        [order.user_id,order.semester_id,order.order_uid,order.user_id,order.semester_id])
    ]);
}

// Called only after the raw Tribute signature has been awaited and verified.
export async function processSemesterTributeEvent(env, payload) {
    if (!["new_digital_product", "digital_product_refunded"].includes(payload.name)) return { handled: false };
    await ensurePaymentTables(env);
    const data = payload.payload;
    if (!data || !positiveId(data.product_id) || !positiveId(data.telegram_user_id) || !positiveId(data.purchase_id)
        || !positiveId(data.amount) || !CURRENCIES.has(String(data.currency).toUpperCase())) return { handled: true, ignored: "missing_purchase_reference" };
    const eventId = String(data.purchase_id);
    const refunded = payload.name === "digital_product_refunded";
    let order = await first(env.DB, `${ORDER_SELECT} WHERE o.provider='tribute' AND o.provider_payment_id=?`, [eventId]);
    if (!order && !refunded) {
        // Digital product links cannot carry our order id: bind the verified
        // Telegram buyer + product to one durable pending checkout instead.
        order = await first(env.DB, `${ORDER_SELECT} WHERE o.provider='tribute' AND o.telegram_id=? AND o.provider_product_id=?
            AND o.amount_minor=? AND o.currency=? AND p.status='pending' ORDER BY o.created_at,o.order_uid LIMIT 1`,
        [data.telegram_user_id,String(data.product_id),Number(data.amount),String(data.currency).toUpperCase()]);
    }
    if (!order) {
        // Remember refund-before-payment events so delayed purchase events
        // cannot resurrect a refunded purchase.
        if (refunded) await run(env.DB, "INSERT OR IGNORE INTO semester_payment_events(provider,event_id,event_type) VALUES('tribute',?,'refunded')", [eventId]);
        return { handled: true, ignored: "unknown_order" };
    }
    if (Number(order.telegram_id) !== Number(data.telegram_user_id) || order.provider_product_id !== String(data.product_id)
        || Number(data.amount) !== order.amount_minor || String(data.currency).toUpperCase() !== order.currency) return { handled: true, ignored: "payment_mismatch" };
    const currentUser = await first(env.DB, "SELECT telegram_id FROM users WHERE id=?", [order.user_id]);
    if (!refunded && Number(currentUser?.telegram_id) !== Number(order.telegram_id)) return { handled: true, ignored: "telegram_link_changed" };
    const purchaseAt = data.purchase_created_at || (!refunded ? payload.created_at : null);
    if (!refunded && (!purchaseAt || !Number.isFinite(Date.parse(purchaseAt)) || Date.parse(purchaseAt) + 1000 < Date.parse(`${order.created_at.replace(" ", "T")}Z`))) return { handled: true, ignored: "purchase_before_checkout" };
    if (refunded) { await refundOrder(env, order, eventId); return { handled: true, refunded: true }; }
    if (await first(env.DB, "SELECT event_id FROM semester_payment_events WHERE provider='tribute' AND event_id=? AND event_type='refunded'", [eventId])) return { handled: true, ignored: "already_refunded" };
    const result = await settleOrder(env, order, eventId);
    return { handled: true, ...result };
}

export async function handleYooMoneyWebhook(request, env) {
    const params = new URLSearchParams(await request.text());
    if (!await verifyYooMoneySignature(params, yooSecret(env))) return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });
    await ensurePaymentTables(env);
    if (params.get("test_notification") === "true") return Response.json({ ok: true, test: true });
    const eventId = params.get("operation_id");
    if (!eventId || !/^[\w-]{1,128}$/.test(eventId) || !["p2p-incoming", "card-incoming"].includes(params.get("notification_type"))
        || params.get("codepro") !== "false" || params.get("unaccepted") !== "false") return Response.json({ ok: true, ignored: "unsupported_notification" });
    const order = await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=? AND o.provider='yoomoney'`, [params.get("label") || ""]);
    if (!order) return Response.json({ ok: true, ignored: "unknown_order" });
    const settings = await settingsFor(env);
    const paidAt = Date.parse(params.get("datetime"));
    if (params.get("currency") !== "643" || moneyMinor(params.get("withdraw_amount")) !== order.amount_minor
        || !moneyMinor(params.get("amount")) || moneyMinor(params.get("amount")) > order.amount_minor
        || order.receiver !== settings.yoomoney_wallet || !Number.isFinite(paidAt)
        || paidAt + 1000 < Date.parse(`${order.created_at.replace(" ", "T")}Z`)
        || (order.provider_payment_id && order.provider_payment_id !== eventId)) return Response.json({ ok: true, ignored: "payment_mismatch" });
    const used = await first(env.DB, "SELECT order_uid FROM semester_payment_orders WHERE provider='yoomoney' AND provider_payment_id=?", [eventId]);
    if (used && used.order_uid !== order.order_uid) return Response.json({ ok: true, ignored: "operation_already_used" });
    const result = await settleOrder(env, order, eventId);
    return Response.json({ ok: true, ...result }, { status: result.notified ? 200 : 503 });
}

async function paymentPage(env, uid) {
    await ensurePaymentTables(env);
    const order = await first(env.DB, `${ORDER_SELECT} WHERE o.order_uid=? AND o.provider='yoomoney'`, [uid]);
    if (!order) return new Response("Заказ не найден", { status: 404 });
    const user = await first(env.DB, "SELECT status FROM users WHERE id=?", [order.user_id]);
    if (user?.status !== "active") return new Response("Аккаунт недоступен", { status: 403 });
    const pending = order.status === "pending";
    if (pending && order.receiver !== (await settingsFor(env)).yoomoney_wallet) return new Response("Реквизиты оплаты изменились. Создайте новую ссылку оплаты в боте или приложении.", { status: 409 });
    const fields = { receiver: order.receiver, "quickpay-form": "button", sum: (order.amount_minor / 100).toFixed(2), label: uid };
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата семестра · RAUDA ILM</title>
        <style>body{font:18px system-ui;max-width:560px;margin:8vh auto;padding:24px;color:#182b27;background:#f5f4ed}button{padding:14px 20px;background:#145e4c;color:white;border:0;border-radius:8px;font:inherit}label{display:block;margin:16px 0}</style>
        <h1>${pending ? "Оплата через ЮMoney" : order.status === "paid" ? "Оплата подтверждена" : "Заказ закрыт"}</h1>
        <p>${esc(order.course_name)} · ${esc(order.semester_name || `${order.semester_number} семестр`)}</p><p>${esc(order.amount_minor / 100)} ₽</p>
        ${pending ? `<form action="https://yoomoney.ru/quickpay/confirm" method="POST">${Object.entries(fields).map(([name,value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}
        <label><input type="radio" name="paymentType" value="PC" checked> Кошелёк ЮMoney</label><label><input type="radio" name="paymentType" value="AC"> Банковская карта</label><button type="submit">Продолжить в ЮMoney</button></form><p>Подтверждение оплаты и ссылка на обучение придут в чат бота после уведомления от ЮMoney.</p>` : "<p>Вернитесь в Telegram-бот, чтобы открыть свой семестр.</p>"}</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://yoomoney.ru; frame-ancestors 'none'; base-uri 'none'" } });
}

export async function handlePaymentRequest(request, env, helpers) {
    const url = new URL(request.url);
    if (url.pathname === "/api/webhooks/yoomoney" && request.method === "POST") return handleYooMoneyWebhook(request, env);
    const payPage = url.pathname.match(/^\/api\/payments\/pay\/(ri_[a-f0-9]{32})$/);
    if (payPage && request.method === "GET") return paymentPage(env, payPage[1]);
    const isSettings = url.pathname === "/api/admin/payment-settings";
    if (!isSettings && !url.pathname.startsWith("/api/payments/")) return null;
    const { requireUser, requireAdmin, json, authError } = helpers;
    const auth = await (isSettings ? requireAdmin : requireUser)(request, env);
    if (!auth.ok) return authError(auth, env);
    if (isSettings && auth.user.role !== "owner") return json({ ok: false, error: "Доступно только владельцу" }, 403, env);
    try {
        if (isSettings) {
            if (request.method === "GET") return json({ ok: true, ...await getPaymentSettings(env) }, 200, env);
            if (request.method === "PUT") return json({ ok: true, ...await updatePaymentSettings(env, await request.json()) }, 200, env);
        }
        if (url.pathname === "/api/payments/catalog" && request.method === "GET") {
            await ensurePaymentTables(env);
            const semesters = (await semesterRows(env)).filter(item => item.is_active && item.course_active && item.program_active);
            const access = await rows(env.DB, "SELECT semester_id FROM user_semesters WHERE user_id=? AND status='active'", [auth.user.id]);
            const granted = new Set(access.map(item => Number(item.semester_id)));
            const courses = [];
            for (const item of semesters) {
                let course = courses.find(course => course.id === item.course_id);
                if (!course) { course = { id: item.course_id, name: item.course_name, semesters: [] }; courses.push(course); }
                course.semesters.push({ id: item.id, name: item.name || `${item.number} семестр`, price_rub: item.price_rub,
                    payment_enabled: Boolean(item.payment_enabled), access_granted: granted.has(Number(item.id)) });
            }
            return json({ ok: true, courses }, 200, env);
        }
        if (url.pathname === "/api/payments/options" && request.method === "GET") return json({ ok: true, ...await getPaymentOptions(env, auth.user.id, url.searchParams.get("semester_id")) }, 200, env);
        if (url.pathname === "/api/payments/checkout" && request.method === "POST") {
            const body = await request.json();
            return json({ ok: true, order: await createSemesterCheckout(env, { userId: auth.user.id, semesterId: body.semester_id, provider: body.provider, origin: url.origin }) }, 200, env);
        }
        const status = url.pathname.match(/^\/api\/payments\/orders\/(ri_[a-f0-9]{32})$/);
        if (status && request.method === "GET") return json({ ok: true, order: await getSemesterOrder(env, auth.user.id, status[1]) }, 200, env);
        return json({ ok: false, error: "Маршрут оплаты не найден" }, 404, env);
    } catch (error) {
        if (error instanceof PaymentError || error instanceof SyntaxError) return json({ ok: false, error: error instanceof SyntaxError ? "Некорректный JSON" : error.message }, error.status || 400, env);
        throw error;
    }
}

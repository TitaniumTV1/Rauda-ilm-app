// Payments never write legacy user_semesters/checkout_orders. A purchase owns one
// immutable entitlement; retries and refunds cannot change another purchase.
const YOO_API = "https://api.yookassa.ru/v3";
const TRIBUTE_API = "https://tribute.tg/api/v1";
const DAY = 86400000;
const MAX_BODY = 65536;
const RETRY_WINDOW = 23 * 3600000; // YooKassa only guarantees keys for 24 hours.

export class CommerceError extends Error {
    constructor(status, message, code = "commerce_error") {
        super(message); this.status = status; this.code = code;
    }
}
const fail = (status, message, code) => { throw new CommerceError(status, message, code); };
const now = () => new Date().toISOString();
const first = (db, sql, args = []) => db.prepare(sql).bind(...args).first();
const run = (db, sql, args = []) => db.prepare(sql).bind(...args).run();
const all = async (db, sql, args = []) => (await db.prepare(sql).bind(...args).all()).results || [];
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const bool = value => value === true || value === 1 || value === "1";
const integer = (value, min, max, label) => {
    const n = Number(value);
    if (value === null || value === "" || typeof value === "boolean" || !Number.isSafeInteger(n) || n < min || n > max) fail(400, `Некорректное поле: ${label}`);
    return n;
};
const text = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const activeUser = user => {
    if (!user?.id) fail(401, "Требуется вход");
    if (user.status && user.status !== "active") fail(403, "Аккаунт неактивен");
};
const ownerOnly = user => {
    activeUser(user);
    if (user.role !== "owner") fail(403, "Настройки школы и тарифы изменяет только владелец");
};

export const COMMERCE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS school_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS school_offers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('course','program','semester')),
        scope_id INTEGER NOT NULL, course_id INTEGER, program_id INTEGER, semester_id INTEGER,
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL CHECK(currency='RUB'),
        access_days INTEGER CHECK(access_days>0), access_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(access_unlimited IN(0,1)),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN(0,1)), yookassa_enabled INTEGER NOT NULL DEFAULT 0,
        tribute_product_id INTEGER UNIQUE, tribute_stars_amount INTEGER, tribute_link TEXT, tribute_web_link TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((access_unlimited=1 AND access_days IS NULL) OR (access_unlimited=0 AND access_days IS NOT NULL)))`,
    `CREATE TABLE IF NOT EXISTS school_tribute_products (
        product_id INTEGER PRIMARY KEY, offer_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS school_orders (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), telegram_id TEXT, offer_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN('yookassa','tribute')), request_key TEXT NOT NULL,
        idempotence_key TEXT NOT NULL UNIQUE, provider_payment_id TEXT, snapshot_json TEXT NOT NULL,
        request_json TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL CHECK(currency='RUB'),
        status TEXT NOT NULL CHECK(status IN('creating','pending','uncertain','paid','partially_refunded','canceled','failed','refunded','needs_review')),
        confirmation_url TEXT, refunded_minor INTEGER NOT NULL DEFAULT 0, receipt_registration TEXT, charged_amount INTEGER, charged_currency TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, last_error TEXT,
        UNIQUE(user_id,request_key), UNIQUE(provider,provider_payment_id))`,
    `CREATE TRIGGER IF NOT EXISTS school_orders_immutable BEFORE UPDATE OF offer_id,provider,request_key,idempotence_key,snapshot_json,request_json,amount_minor,currency ON school_orders
        WHEN NEW.offer_id IS NOT OLD.offer_id OR NEW.provider IS NOT OLD.provider
        OR NEW.request_key IS NOT OLD.request_key OR NEW.idempotence_key IS NOT OLD.idempotence_key
        OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.request_json IS NOT OLD.request_json
        OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
        BEGIN SELECT RAISE(ABORT,'Immutable payment snapshot'); END`,
    `CREATE TRIGGER IF NOT EXISTS school_orders_user_transfer BEFORE UPDATE OF user_id ON school_orders
        WHEN NEW.user_id IS NOT OLD.user_id AND NOT EXISTS(
            SELECT 1 FROM users source JOIN users target ON target.id=NEW.user_id
            JOIN school_link_challenges c ON c.user_id=target.id AND c.telegram_id=target.telegram_id AND c.status='confirmed'
            JOIN school_link_receipts r ON r.challenge_id=c.id
            WHERE source.id=OLD.user_id AND source.status='blocked'
              AND source.blocked_reason='Аккаунт перенесён при подтверждённой привязке' AND target.status='active'
              AND OLD.telegram_id=CAST(target.telegram_id AS TEXT))
        BEGIN SELECT RAISE(ABORT,'Payment ownership requires confirmed account transfer'); END`,
    `CREATE TRIGGER IF NOT EXISTS school_orders_provider_id_immutable BEFORE UPDATE OF provider_payment_id ON school_orders
        WHEN OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS NOT OLD.provider_payment_id
        BEGIN SELECT RAISE(ABORT,'Immutable provider payment id'); END`,
    `CREATE TABLE IF NOT EXISTS school_entitlements (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, source_order_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN('course','program','semester')), scope_id INTEGER NOT NULL,
        course_id INTEGER, program_id INTEGER, semester_id INTEGER,
        status TEXT NOT NULL CHECK(status IN('active','revoked')), starts_at TEXT NOT NULL, expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source,source_order_id))`,
    `CREATE INDEX IF NOT EXISTS school_entitlements_user ON school_entitlements(user_id,status)`,
    `CREATE TABLE IF NOT EXISTS school_payment_events (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_key TEXT NOT NULL, event_type TEXT NOT NULL,
        order_id TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,event_key))`,
    `CREATE TABLE IF NOT EXISTS school_refund_tombstones (
        provider TEXT NOT NULL, purchase_id TEXT NOT NULL, product_id INTEGER, telegram_id TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(provider,purchase_id))`,
    `CREATE TABLE IF NOT EXISTS school_refunds (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES school_orders(id), request_key TEXT NOT NULL,
        idempotence_key TEXT NOT NULL UNIQUE, provider_refund_id TEXT UNIQUE, amount_minor INTEGER NOT NULL,
        status TEXT NOT NULL, request_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(order_id,request_key))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS school_refunds_one_request ON school_refunds(order_id)
        WHERE request_key NOT LIKE 'provider:%' AND status IN('creating','submitting','uncertain','pending','needs_review','succeeded')`,
    `CREATE TABLE IF NOT EXISTS school_checkout_intents (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
        offer_id TEXT NOT NULL, product_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        confirmation_url TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN('web','telegram')), created_at TEXT NOT NULL, UNIQUE(user_id,request_key))`,
    `CREATE INDEX IF NOT EXISTS school_orders_user ON school_orders(user_id,created_at)`
];

export async function ensureCommerceSchema(db) {
    if (!db) fail(503, "База данных не настроена");
    await db.batch(COMMERCE_SCHEMA.map(sql => db.prepare(sql)));
}

export const SCHOOL_SETTING_DEFAULTS = Object.freeze({
    school_name: "RAUDA ILM", school_description: "", support_url: "", public_app_url: "",
    telegram_bot_username: "", telegram_channel: "", support_telegram_id: "", terms_url: "", privacy_url: "",
    registration_enabled: true, payments_enabled: false, maintenance_mode: false,
    yookassa_enabled: false, tribute_enabled: false,
    receipt_mode: "receipt", receipt_tax_system_code: null, receipt_vat_code: null,
    receipt_payment_subject: "", receipt_payment_mode: "", receipt_measure: "",
    payment_success_text: "Оплата получена. Доступ открыт.", order_help_text: "", about_text: ""
});
const BOOL_SETTINGS = new Set(["registration_enabled", "payments_enabled", "maintenance_mode", "yookassa_enabled", "tribute_enabled"]);
const URL_SETTINGS = new Set(["support_url", "public_app_url", "terms_url", "privacy_url"]);
const RECEIPT_SUBJECTS = ["service", "intellectual_activity", "property_right", "job", "another"];
export const RECEIPT_OPTIONS = Object.freeze({
    tax_system_codes: [1,2,3,4,5,6], vat_codes: [1,2,3,4,5,6,7,8,9,10,11,12],
    payment_subjects: RECEIPT_SUBJECTS, payment_modes: ["full_payment"], measures: ["piece", "day", "hour", "another"],
    mode: "receipt", customer_required: "email_or_phone", scenario: "payment_and_receipt"
});
function httpsUrl(value, label) {
    let u; try { u = new URL(value); } catch { fail(400, `Укажите HTTPS-ссылку: ${label}`); }
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname || u.hash) fail(400, `Недопустимая ссылка: ${label}`);
    return u.href;
}
function validateSettings(input, base) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Нужен объект settings");
    const result = { ...base };
    for (const [key, value] of Object.entries(input)) {
        if (!own(SCHOOL_SETTING_DEFAULTS, key)) fail(400, `Настройка не разрешена: ${key}`);
        if (BOOL_SETTINGS.has(key)) {
            if (![true,false,0,1,"0","1"].includes(value)) fail(400, `Нужен переключатель: ${key}`);
            result[key] = bool(value);
        } else if (key === "receipt_mode") {
            if (value !== "receipt") fail(400, "Для школы обязательны чеки онлайн-кассы");
            result[key] = "receipt";
        } else if (key === "receipt_tax_system_code" || key === "receipt_vat_code") {
            result[key] = value === null || value === "" ? null : integer(value, 1, key.endsWith("vat_code") ? 12 : 6, key);
        } else if (key === "receipt_payment_subject" || key === "receipt_payment_mode" || key === "receipt_measure") {
            const allowed = key.endsWith("subject") ? RECEIPT_SUBJECTS : key.endsWith("mode") ? ["full_payment"] : RECEIPT_OPTIONS.measures;
            if (value !== "" && !allowed.includes(value)) fail(400, `Неподдерживаемое значение: ${key}`);
            result[key] = value;
        } else if (URL_SETTINGS.has(key)) {
            result[key] = value ? httpsUrl(String(value), key) : "";
        } else if (key === "telegram_channel") {
            const v = text(value, 500);
            if (v && !/^@[A-Za-z0-9_]{5,32}$/.test(v)) {
                const u = new URL(httpsUrl(v, key));
                if (!["t.me","telegram.me"].includes(u.hostname)) fail(400, "Нужна ссылка Telegram");
            }
            result[key] = v;
        } else if (key === "telegram_bot_username") {
            const v = text(value).replace(/^@/, "");
            if (v && !/^[A-Za-z0-9_]{5,32}$/.test(v)) fail(400, "Некорректное имя бота");
            result[key] = v;
        } else if (key === "support_telegram_id") {
            const v = text(value); if (v && !/^-?\d{1,18}$/.test(v)) fail(400, "Некорректный Telegram ID поддержки"); result[key] = v;
        } else {
            if (typeof value !== "string" || value.length > 4000) fail(400, `Слишком длинный текст: ${key}`);
            result[key] = value.trim();
        }
    }
    if (!result.school_name) fail(400, "Укажите название школы");
    return result;
}
export async function getSchoolSettings(db) {
    await ensureCommerceSchema(db);
    const result = { ...SCHOOL_SETTING_DEFAULTS };
    // Only safe legacy presentation/registration values migrate implicitly.
    const compatible = new Set(["school_name","support_url","telegram_channel","registration_enabled","maintenance_mode"]);
    for (const row of await all(db, "SELECT key,value FROM app_settings")) {
        if (compatible.has(row.key)) {
            try { Object.assign(result, validateSettings({ [row.key]: row.value }, result)); } catch { /* Invalid legacy values cannot enable payments. */ }
        }
    }
    for (const row of await all(db, "SELECT key,value_json FROM school_settings")) {
        if (own(result, row.key)) {
            try { Object.assign(result, validateSettings({ [row.key]: parse(row.value_json) }, result)); } catch { /* Keep safe default. */ }
        }
    }
    return result;
}
function fiscalReady(settings) {
    return settings.receipt_mode === "receipt" && Number.isInteger(settings.receipt_tax_system_code) &&
        Number.isInteger(settings.receipt_vat_code) && RECEIPT_SUBJECTS.includes(settings.receipt_payment_subject) &&
        settings.receipt_payment_mode === "full_payment" && RECEIPT_OPTIONS.measures.includes(settings.receipt_measure);
}
export function paymentProviderStatus(env, settings) {
    return {
        yookassa: { configured: Boolean(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY), enabled: settings.yookassa_enabled, receipt_ready: fiscalReady(settings) },
        tribute: { configured: Boolean(env.TRIBUTE_API_KEY), enabled: settings.tribute_enabled }
    };
}
export async function updateSchoolSettings(env, user, input) {
    ownerOnly(user);
    const settings = validateSettings(input, await getSchoolSettings(env.DB));
    const state = paymentProviderStatus(env, settings);
    if (settings.yookassa_enabled && (!state.yookassa.configured || !fiscalReady(settings) || !settings.public_app_url)) fail(400, "Перед включением ЮKassa настройте секреты, HTTPS-адрес сайта и все параметры чека");
    if (settings.tribute_enabled && !state.tribute.configured) fail(400, "Сначала настройте секрет TRIBUTE_API_KEY");
    if (settings.payments_enabled && !settings.yookassa_enabled && !settings.tribute_enabled) fail(400, "Включите хотя бы один настроенный способ оплаты");
    const stamp = now();
    await env.DB.batch(Object.entries(settings).flatMap(([key,value]) => [
        env.DB.prepare(`INSERT INTO school_settings(key,value_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(key,JSON.stringify(value),user.id,stamp),
        env.DB.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key,typeof value === "boolean" ? (value ? "1":"0") : String(value ?? ""),stamp)
    ]));
    return settings;
}

async function boundedText(response, limit = MAX_BODY) {
    if (Number(response.headers.get("Content-Length")) > limit) fail(413, "Слишком большой запрос");
    if (!response.body) return "";
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
        for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); fail(413, "Слишком большой запрос"); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c,offset); offset += c.byteLength; }
    return new TextDecoder().decode(bytes);
}
async function readBody(request, optional = false) {
    const raw=await boundedText(request);
    if(optional && !raw.trim()) return {};
    const body = parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Некорректный JSON");
    return body;
}
async function providerRequest(env, provider, path, { method = "GET", body, key } = {}) {
    const yoo = provider === "yookassa";
    if (yoo ? !(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY) : !env.TRIBUTE_API_KEY) fail(503, "Платежный провайдер не настроен");
    const headers = { Accept: "application/json" };
    if (yoo) headers.Authorization = `Basic ${btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`)}`;
    else headers["Api-Key"] = env.TRIBUTE_API_KEY;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotence-Key"] = key;
    let response;
    try { response = await fetch(`${yoo ? YOO_API : TRIBUTE_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch { fail(502, "Провайдер не подтвердил результат. Повторите проверку этого же заказа.", "provider_uncertain"); }
    let data; try { data = parse(await boundedText(response, 262144)); } catch { fail(502, "Некорректный ответ провайдера", "provider_uncertain"); }
    if (!response.ok) {
        const uncertain = response.status >= 500 || response.status === 429 || response.status === 408;
        fail(uncertain ? 502 : 400, uncertain ? "Провайдер временно недоступен. Проверьте тот же заказ." : "Провайдер отклонил запрос. Проверьте настройки и данные.", uncertain ? "provider_uncertain" : "provider_rejected");
    }
    if (!data || typeof data !== "object") fail(502, "Некорректный ответ провайдера", "provider_uncertain");
    return data;
}
function tributeUrl(value, telegram) {
    const u = new URL(httpsUrl(value, "Tribute"));
    const valid = telegram ? ["t.me","telegram.me"].includes(u.hostname) && /^\/(tribute|tribute_bot)\/app$/.test(u.pathname) && /^p[A-Za-z0-9]+$/.test(u.searchParams.get("startapp") || "")
        : u.hostname === "web.tribute.tg" && /^\/p\/[A-Za-z0-9]+\/?$/.test(u.pathname);
    if (!valid) fail(400, "Провайдер вернул неподдерживаемую ссылку Tribute");
    return u.href;
}
async function validatedTributeProduct(env, productId, amountMinor) {
    const p = await providerRequest(env, "tribute", `/products/${productId}`);
    if (Number(p.id) !== Number(productId) || p.type !== "digital" || p.isCustom || p.status !== "approved") fail(400, "Требуется одобренный цифровой товар Tribute");
    if (String(p.currency).toUpperCase() !== "RUB" || Number(p.amount) !== amountMinor) fail(400, "Цена и валюта товара Tribute должны совпадать с тарифом");
    const stars = p.starsAmountEnabled === true && Number.isSafeInteger(p.starsAmount) && p.starsAmount > 0 ? p.starsAmount : null;
    return { tribute_product_id: productId, tribute_stars_amount: stars, tribute_link: tributeUrl(p.link, true), tribute_web_link: tributeUrl(p.webLink, false) };
}
async function resolveScope(db, type, id) {
    if (!["course","program","semester"].includes(type)) fail(400, "Выберите курс, программу или семестр");
    id = integer(id,1,Number.MAX_SAFE_INTEGER,"scope_id");
    const table = {course:"courses",program:"programs",semester:"semesters"}[type];
    const row = await first(db, `SELECT * FROM ${table} WHERE id=?`, [id]);
    if (!row) fail(400, "Выбранный объект обучения не найден");
    return { scope_type:type, scope_id:id, course_id:type === "course" ? id : row.course_id || null, program_id:type === "program" ? id : type === "semester" ? row.program_id || null : null, semester_id:type === "semester" ? id : null };
}
function offerSnapshot(offer) {
    return { name:offer.name, scope_type:offer.scope_type, scope_id:offer.scope_id, course_id:offer.course_id,program_id:offer.program_id,semester_id:offer.semester_id,
        amount_minor:offer.amount_minor,currency:"RUB",access_days:offer.access_days,access_unlimited:bool(offer.access_unlimited),tribute_product_id:offer.tribute_product_id || null,tribute_stars_amount:offer.tribute_stars_amount || null };
}
export async function saveOffer(env, user, input, id = null) {
    ownerOnly(user); await ensureCommerceSchema(env.DB);
    const existing = id ? await first(env.DB,"SELECT * FROM school_offers WHERE id=?",[id]) : null;
    if (id && !existing) fail(404,"Тариф не найден");
    const merged = {...existing,...input}; const name = text(merged.name,128);
    if (!name) fail(400,"Укажите название тарифа");
    const scope = await resolveScope(env.DB,merged.scope_type,merged.scope_id);
    const amount = integer(merged.amount_minor,100,10000000000,"amount_minor");
    if (merged.currency && merged.currency !== "RUB") fail(400,"Поддерживается RUB");
    if (!existing && !own(input,"access_days") && !own(input,"access_unlimited")) fail(400,"Владелец должен задать срок доступа тарифа");
    const unlimited = bool(merged.access_unlimited);
    const days = unlimited ? null : integer(merged.access_days,1,36500,"access_days");
    if (unlimited && input.access_days != null) fail(400,"При бессрочном доступе access_days должен быть null");
    const productId = merged.tribute_product_id ? integer(merged.tribute_product_id,1,Number.MAX_SAFE_INTEGER,"tribute_product_id") : null;
    let provider = {tribute_product_id:null,tribute_stars_amount:null,tribute_link:null,tribute_web_link:null};
    if (productId) provider = await validatedTributeProduct(env,productId,amount);
    const stamp=now(); const offer={ id:id || crypto.randomUUID(),name,...scope,amount_minor:amount,currency:"RUB",access_days:days,access_unlimited:unlimited?1:0,
        is_active:bool(merged.is_active)?1:0,yookassa_enabled:bool(merged.yookassa_enabled)?1:0,...provider,created_at:existing?.created_at || stamp,updated_at:stamp };
    if (existing?.tribute_product_id && productId !== existing.tribute_product_id) fail(409,"Для другого товара Tribute создайте новый тариф; старые покупки сохраняют прежние условия");
    const mapping = productId ? await first(env.DB,"SELECT * FROM school_tribute_products WHERE product_id=?",[productId]) : null;
    const snapshot=JSON.stringify(offerSnapshot(offer));
    if (mapping && (mapping.offer_id !== offer.id || mapping.snapshot_json !== snapshot)) fail(409,"Условия связанного товара Tribute неизменяемы. Создайте новый товар и тариф.");
    const cols=Object.keys(offer);
    const statements=[env.DB.prepare(`INSERT INTO school_offers(${cols.join(",")}) VALUES(${cols.map(()=>"?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(k=>k!=="id" && k!=="created_at").map(k=>`${k}=excluded.${k}`).join(",")}`).bind(...cols.map(k=>offer[k]))];
    if (productId) statements.push(env.DB.prepare("INSERT OR IGNORE INTO school_tribute_products(product_id,offer_id,snapshot_json,created_at) VALUES(?,?,?,?)").bind(productId,offer.id,snapshot,stamp));
    await env.DB.batch(statements); return offer;
}
export async function listOffers(env, user, channel="web") {
    activeUser(user); if (!["web","telegram"].includes(channel)) fail(400,"Неизвестный канал оплаты");
    const settings=await getSchoolSettings(env.DB); const status=paymentProviderStatus(env,settings);
    const offers=await all(env.DB,"SELECT * FROM school_offers WHERE is_active=1 ORDER BY created_at,id");
    return offers.map(o=>({...o,access_unlimited:bool(o.access_unlimited),providers:!settings.payments_enabled || settings.maintenance_mode ? [] : [
        channel === "web" && bool(o.yookassa_enabled) && settings.yookassa_enabled && status.yookassa.configured && fiscalReady(settings) ? "yookassa":null,
        o.tribute_product_id && settings.tribute_enabled && status.tribute.configured && (channel === "web" || o.tribute_stars_amount>0) ? "tribute":null
    ].filter(Boolean),receipt_required:true}));
}
function decimal(minor) { return `${Math.floor(minor/100)}.${String(minor%100).padStart(2,"0")}`; }
function minorUnits(value) {
    if (typeof value !== "string" || !/^\d{1,12}\.\d{2}$/.test(value)) return null;
    const [a,b]=value.split("."); const n=Number(a)*100+Number(b); return Number.isSafeInteger(n)?n:null;
}
function requestKey(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) fail(400,"Нужен стабильный request_key длиной 16–64 символа");
    return value;
}
function receiptFor(settings, customer, snapshot) {
    if (!fiscalReady(settings)) fail(503,"Владелец еще не настроил онлайн-кассу");
    const c={};
    if (customer?.email) { const email=text(customer.email,254); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,"Некорректный email для чека"); c.email=email; }
    if (customer?.phone) { const phone=String(customer.phone).replace(/^\+/,""); if (!/^\d{10,15}$/.test(phone)) fail(400,"Номер для чека должен включать код страны"); c.phone=phone; }
    if (!c.email && !c.phone) fail(400,"Укажите email или телефон для чека");
    return {customer:c,tax_system_code:settings.receipt_tax_system_code,internet:true,items:[{description:snapshot.name,quantity:"1.000",amount:{value:decimal(snapshot.amount_minor),currency:"RUB"},
        vat_code:settings.receipt_vat_code,payment_mode:settings.receipt_payment_mode,payment_subject:settings.receipt_payment_subject,measure:settings.receipt_measure}]};
}
function publicOrder(row) {
    if (!row) return null;
    const s=parse(row.snapshot_json) || {};
    return {id:row.id,user_id:row.user_id,offer_id:row.offer_id,name:s.name,provider:row.provider,status:row.status,amount_minor:row.amount_minor,currency:row.currency,
        confirmation_url:row.confirmation_url || null,provider_payment_id:row.provider_payment_id || null,created_at:row.created_at,updated_at:row.updated_at,paid_at:row.paid_at || null,
        refunded_minor:row.refunded_minor || 0,charged_amount:row.charged_amount ?? null,charged_currency:row.charged_currency || null,
        receipt_registration:row.receipt_registration || null,last_error:row.last_error || null,refund_status:row.refund_status || null,
        provider_refund_id:row.refund_provider_id || null,scope_type:s.scope_type,scope_id:s.scope_id,access_days:s.access_days,access_unlimited:s.access_unlimited};
}
const ORDER_WITH_REFUND=`SELECT o.*,
    (SELECT r.status FROM school_refunds r WHERE r.order_id=o.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS refund_status,
    (SELECT r.provider_refund_id FROM school_refunds r WHERE r.order_id=o.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS refund_provider_id
    FROM school_orders o`;
const readPublicOrder=async (db,id)=>publicOrder(await first(db,`${ORDER_WITH_REFUND} WHERE o.id=?`,[id]));
export async function createOrder(env, user, input) {
    activeUser(user); const key=requestKey(input.request_key); const channel=input.channel || "web";
    if (!["web","telegram"].includes(channel)) fail(400,"Неизвестный канал оплаты");
    if (!["yookassa","tribute"].includes(input.provider)) fail(400,"Неизвестный способ оплаты");
    if (input.provider === "yookassa" && channel !== "web") fail(400,"В Telegram цифровые товары оплачиваются в Stars через Tribute");
    await ensureCommerceSchema(env.DB);
    const settings=await getSchoolSettings(env.DB);
    assertCheckoutEnabled(env,settings,input.provider);
    const existing=await first(env.DB,"SELECT * FROM school_orders WHERE user_id=? AND request_key=?",[user.id,key]);
    if (existing) {
        if (existing.offer_id!==input.offer_id || existing.provider!==input.provider) fail(409,"request_key уже используется другим заказом");
        return existing.provider === "yookassa" ? publicOrder(await submitYooOrder(env,existing)) : publicOrder(existing);
    }
    const intent=await first(env.DB,"SELECT * FROM school_checkout_intents WHERE user_id=? AND request_key=?",[user.id,key]);
    if (intent) {
        if(input.provider!=="tribute" || input.offer_id!==intent.offer_id || intent.channel!==channel) fail(409,"request_key уже используется другим заказом или каналом");
        return tributeIntent(intent);
    }
    const offer=(await listOffers(env,user,channel)).find(o=>o.id===input.offer_id);
    if (!offer || !offer.providers.includes(input.provider)) fail(400,"Этот тариф или способ оплаты сейчас недоступен");
    const snapshot=offerSnapshot(offer); const stamp=now();
    if (input.provider === "tribute") {
        if (!user.telegram_id || !/^[1-9]\d+$/.test(String(user.telegram_id))) fail(400,"Для Tribute сначала привяжите Telegram к аккаунту");
        const product=await validatedTributeProduct(env,offer.tribute_product_id,offer.amount_minor);
        if (channel === "telegram" && !product.tribute_stars_amount) fail(400,"Для товара Tribute не включены Telegram Stars");
        if(channel === "telegram" && product.tribute_stars_amount!==snapshot.tribute_stars_amount) fail(409,"Цена Tribute Stars изменилась. Владелец должен создать новый тариф.");
        const link=channel === "telegram" ? product.tribute_link : product.tribute_web_link;
        await run(env.DB,"INSERT OR IGNORE INTO school_checkout_intents(id,user_id,request_key,offer_id,product_id,snapshot_json,confirmation_url,channel,created_at) VALUES(?,?,?,?,?,?,?,?,?)",[crypto.randomUUID(),user.id,key,offer.id,offer.tribute_product_id,JSON.stringify(snapshot),link,channel,stamp]);
        const savedIntent=await first(env.DB,"SELECT * FROM school_checkout_intents WHERE user_id=? AND request_key=?",[user.id,key]);
        if(savedIntent.offer_id!==offer.id || savedIntent.channel!==channel) fail(409,"request_key уже используется другим заказом или каналом");
        return tributeIntent(savedIntent);
    }
    const id=crypto.randomUUID(); const returnUrl=new URL(settings.public_app_url); returnUrl.searchParams.set("payment_order",id);
    const payload={amount:{value:decimal(offer.amount_minor),currency:"RUB"},capture:true,confirmation:{type:"redirect",return_url:returnUrl.href},description:`${settings.school_name} — ${offer.name}`.slice(0,128),
        metadata:{school_order_id:id},receipt:receiptFor(settings,input.customer,snapshot)};
    await run(env.DB,`INSERT OR IGNORE INTO school_orders(id,user_id,telegram_id,offer_id,provider,request_key,idempotence_key,snapshot_json,request_json,amount_minor,currency,status,created_at,updated_at)
        VALUES(?,?,?,?,'yookassa',?,?,?,?,?,'RUB','creating',?,?)`,[id,user.id,user.telegram_id?String(user.telegram_id):null,offer.id,key,crypto.randomUUID(),JSON.stringify(snapshot),JSON.stringify(payload),offer.amount_minor,stamp,stamp]);
    const saved=await first(env.DB,"SELECT * FROM school_orders WHERE user_id=? AND request_key=?",[user.id,key]);
    if(saved.offer_id!==input.offer_id || saved.provider!==input.provider) fail(409,"request_key уже используется");
    return publicOrder(await submitYooOrder(env,saved));
}
function assertCheckoutEnabled(env,settings,provider) {
    if (!settings.payments_enabled || settings.maintenance_mode || !settings[`${provider}_enabled`]) fail(503,"Прием оплаты временно выключен");
    const status=paymentProviderStatus(env,settings)[provider];
    if (!status.configured || (provider==="yookassa" && !fiscalReady(settings))) fail(503,"Способ оплаты еще не настроен");
}
function tributeIntent(intent) {
    const s=parse(intent.snapshot_json);
    return {id:intent.id,offer_id:intent.offer_id,provider:"tribute",status:"pending",name:s.name,amount_minor:s.amount_minor,currency:"RUB",confirmation_url:intent.confirmation_url,created_at:intent.created_at,
        note:"Доступ предоставляется Telegram-аккаунту покупателя после уведомления Tribute. Возврат на сайт не подтверждает оплату."};
}
async function submitYooOrder(env,order) {
    if (order.provider_payment_id || !["creating","uncertain"].includes(order.status)) return order;
    if (Date.now()-Date.parse(order.created_at)>RETRY_WINDOW) {
        await run(env.DB,"UPDATE school_orders SET status='needs_review',last_error=?,updated_at=? WHERE id=? AND provider_payment_id IS NULL",["Истек безопасный срок повтора. Сверьте заказ в ЮKassa; новый платеж автоматически не создается.",now(),order.id]);
        return first(env.DB,"SELECT * FROM school_orders WHERE id=?",[order.id]);
    }
    assertCheckoutEnabled(env,await getSchoolSettings(env.DB),"yookassa");
    try {
        const payment=await providerRequest(env,"yookassa","/payments",{method:"POST",body:parse(order.request_json),key:order.idempotence_key});
        await applyYooPayment(env,order,payment);
    } catch(error) {
        const ambiguous=error.code!=="provider_rejected";
        await run(env.DB,"UPDATE school_orders SET status=?,last_error=?,updated_at=? WHERE id=? AND provider_payment_id IS NULL AND status IN('creating','uncertain')",[ambiguous?"uncertain":"failed",text(error.message,400),now(),order.id]);
        if (!(error instanceof CommerceError)) throw error;
    }
    return first(env.DB,"SELECT * FROM school_orders WHERE id=?",[order.id]);
}
function validDate(value) {
    const n=Date.parse(value); return Number.isFinite(n) && n>0 && n<=Date.now()+60000 ? new Date(n).toISOString() : null;
}
function grantStatement(db,order,paidAt) {
    const s=parse(order.snapshot_json); const expires=s.access_unlimited?null:new Date(Date.parse(paidAt)+s.access_days*DAY).toISOString();
    return db.prepare(`INSERT OR IGNORE INTO school_entitlements(id,user_id,source,source_order_id,scope_type,scope_id,course_id,program_id,semester_id,status,starts_at,expires_at,created_at,updated_at)
        SELECT ?,user_id,provider,id,?,?,?,?,?,'active',?,?,?,? FROM school_orders WHERE id=? AND status IN('paid','partially_refunded')
        AND NOT EXISTS(SELECT 1 FROM school_refund_tombstones t WHERE t.provider=school_orders.provider AND t.purchase_id=school_orders.provider_payment_id)`)
        .bind(`purchase:${order.id}`,s.scope_type,s.scope_id,s.course_id,s.program_id,s.semester_id,paidAt,expires,paidAt,paidAt,order.id);
}
async function applyYooPayment(env,order,payment) {
    if (!payment.id || (order.provider_payment_id && order.provider_payment_id!==payment.id) || payment.metadata?.school_order_id!==order.id ||
        payment.amount?.currency!=="RUB" || minorUnits(payment.amount?.value)!==order.amount_minor ||
        (payment.recipient?.account_id && String(payment.recipient.account_id)!==String(env.YOOKASSA_SHOP_ID))) fail(409,"Данные платежа не совпадают с заказом","payment_mismatch");
    const refunded=payment.refunded_amount ? minorUnits(payment.refunded_amount.value) : 0;
    if (refunded===null || refunded<0 || refunded>order.amount_minor || (payment.refunded_amount && payment.refunded_amount.currency!=="RUB")) fail(409,"Некорректная сумма возврата","payment_mismatch");
    let status;
    if (refunded>=order.amount_minor) status="refunded";
    else if(payment.status==="succeeded" && payment.paid===true) status=refunded>0?"partially_refunded":"paid";
    else if(payment.status==="canceled") status="canceled";
    else if(["pending","waiting_for_capture"].includes(payment.status)) status="pending";
    else fail(409,"Неподтвержденное состояние платежа","payment_mismatch");
    const stamp=now(); const paidAt=order.paid_at || validDate(payment.captured_at) || stamp;
    let link=null;
    if(payment.confirmation?.confirmation_url) link=httpsUrl(payment.confirmation.confirmation_url,"ЮKassa");
    const statements=[env.DB.prepare(`UPDATE school_orders SET provider_payment_id=?,status=CASE WHEN status='refunded' THEN 'refunded'
        WHEN status='partially_refunded' AND ?='paid' THEN 'partially_refunded'
        WHEN status IN('paid','partially_refunded') AND ? IN('pending','canceled') THEN status ELSE ? END,
        confirmation_url=COALESCE(?,confirmation_url),refunded_minor=MAX(refunded_minor,?),receipt_registration=?,
        charged_amount=CASE WHEN ? IN('paid','partially_refunded','refunded') THEN amount_minor ELSE charged_amount END,
        charged_currency=CASE WHEN ? IN('paid','partially_refunded','refunded') THEN 'RUB' ELSE charged_currency END,
        paid_at=CASE WHEN ? IN('paid','partially_refunded','refunded') THEN COALESCE(paid_at,?) ELSE paid_at END,last_error=NULL,updated_at=? WHERE id=?`)
        .bind(payment.id,status,status,status,link,refunded,payment.receipt_registration || null,status,status,status,paidAt,stamp,order.id)];
    if(status==="paid" || status==="partially_refunded") statements.push(grantStatement(env.DB,order,paidAt));
    if(status==="refunded") statements.push(env.DB.prepare("UPDATE school_entitlements SET status='revoked',updated_at=? WHERE source='yookassa' AND source_order_id=?").bind(stamp,order.id));
    await env.DB.batch(statements);
}
export function isYooKassaSourceIp(ip) {
    const value=String(ip || "").toLowerCase();
    if(/^2a02:5180:[0-9a-f:]+$/.test(value)) return true;
    if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
    const p=value.split(".").map(Number); if(p.some(n=>n>255)) return false;
    return (p[0]===185 && p[1]===71 && [76,77].includes(p[2]) && p[3]<=31) ||
        (p[0]===77 && p[1]===75 && ((p[2]===153 && p[3]<=127) || (p[2]===154 && p[3]>=128) || (p[2]===156 && [11,35].includes(p[3]))));
}
export async function handleYooKassaWebhookRequest(request,env) {
    if(!isYooKassaSourceIp(request.headers.get("CF-Connecting-IP"))) fail(403,"Недопустимый источник уведомления");
    await ensureCommerceSchema(env.DB); const event=await readBody(request);
    if(event.type!=="notification" || !["payment.succeeded","payment.canceled","payment.waiting_for_capture","refund.succeeded"].includes(event.event)) fail(400,"Неподдерживаемое событие");
    const id=text(event.object?.id,128); if(!/^[A-Za-z0-9_-]{8,128}$/.test(id)) fail(400,"Некорректный ID события");
    let payment,refund;
    if(event.event==="refund.succeeded") {
        refund=await providerRequest(env,"yookassa",`/refunds/${encodeURIComponent(id)}`);
        if(refund.id!==id || refund.status!=="succeeded" || !refund.payment_id) fail(409,"Возврат не подтвержден");
        payment=await providerRequest(env,"yookassa",`/payments/${encodeURIComponent(refund.payment_id)}`);
    } else payment=await providerRequest(env,"yookassa",`/payments/${encodeURIComponent(id)}`);
    const order=await first(env.DB,"SELECT * FROM school_orders WHERE provider='yookassa' AND (provider_payment_id=? OR id=?) LIMIT 1",[payment.id || "",payment.metadata?.school_order_id || ""]);
    if(!order) fail(409,"Платеж не сопоставлен с заказом","unmapped_payment");
    await applyYooPayment(env,order,payment);
    if(refund) await recordVerifiedRefund(env,{...order,provider_payment_id:payment.id},refund);
    await recordEvent(env.DB,"yookassa",`${event.event}:${id}`,event.event,order.id,{payment_id:payment.id,refund_id:refund?.id || null},"processed");
    return json({ok:true});
}
async function recordVerifiedRefund(env,order,refund) {
    const amount=minorUnits(refund.amount?.value);
    if(refund.payment_id!==order.provider_payment_id || refund.amount?.currency!=="RUB" || !amount || amount>order.amount_minor) fail(409,"Возврат не совпадает с платежом");
    const stamp=now();
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO school_refunds(id,order_id,request_key,idempotence_key,provider_refund_id,amount_minor,status,request_json,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'succeeded','{}',?,?) ON CONFLICT(provider_refund_id) DO UPDATE SET status='succeeded',updated_at=excluded.updated_at`)
            .bind(`provider:${refund.id}`,order.id,`provider:${refund.id}`,`provider:${refund.id}`,refund.id,amount,stamp,stamp),
        env.DB.prepare(`UPDATE school_orders SET refunded_minor=MAX(refunded_minor,(SELECT COALESCE(SUM(amount_minor),0) FROM school_refunds WHERE order_id=? AND status='succeeded')),
            status=CASE WHEN MAX(refunded_minor,(SELECT COALESCE(SUM(amount_minor),0) FROM school_refunds WHERE order_id=? AND status='succeeded'))>=amount_minor THEN 'refunded' ELSE 'partially_refunded' END,updated_at=? WHERE id=?`).bind(order.id,order.id,stamp,order.id),
        env.DB.prepare(`UPDATE school_entitlements SET status='revoked',updated_at=? WHERE source='yookassa' AND source_order_id=? AND EXISTS(SELECT 1 FROM school_orders WHERE id=? AND status='refunded')`).bind(stamp,order.id,order.id)
    ]);
}
async function recordEvent(db,provider,key,type,orderId,payload,status,reason=null) {
    const stamp=now(); await run(db,`INSERT INTO school_payment_events(id,provider,event_key,event_type,order_id,payload_json,status,reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,event_key) DO UPDATE SET order_id=COALESCE(excluded.order_id,order_id),status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`,
        [`${provider}:${key}`,provider,key,type,orderId,JSON.stringify(payload),status,reason,stamp,stamp]);
}
async function verifyTributeSignature(raw,signature,key) {
    if(!key || !signature) return false;
    // Tribute signs the exact UTF-8 request bytes with HMAC-SHA256. Both common
    // digest transports decode to the same 32 bytes; the MAC is never weakened.
    let bytes;
    try {
        if(/^[a-fA-F0-9]{64}$/.test(signature)) bytes=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16));
        else { const s=atob(signature.replace(/-/g,"+").replace(/_/g,"/")); bytes=Uint8Array.from(s,x=>x.charCodeAt(0)); }
        if(bytes.length!==32) return false;
        const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(key),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
        return crypto.subtle.verify("HMAC",k,bytes,new TextEncoder().encode(raw));
    } catch { return false; }
}
export async function handleTributeWebhookRequest(request,env) {
    if(!env.TRIBUTE_API_KEY) fail(503,"Tribute не настроен");
    const raw=await boundedText(request);
    if(!await verifyTributeSignature(raw,request.headers.get("trbt-signature"),env.TRIBUTE_API_KEY)) fail(401,"Неверная подпись Tribute");
    const event=parse(raw); if(!event || !event.payload) fail(400,"Некорректное событие Tribute");
    await ensureCommerceSchema(env.DB);
    return processTributeEvent(env,event);
}
async function processTributeEvent(env,event) {
    if(!["new_digital_product","digital_product_refunded"].includes(event.name)) fail(400,"Неподдерживаемое событие Tribute");
    const p=event.payload; const purchase=String(integer(p.purchase_id,1,Number.MAX_SAFE_INTEGER,"purchase_id"));
    const product=integer(p.product_id,1,Number.MAX_SAFE_INTEGER,"product_id"); const telegram=String(integer(p.telegram_user_id,1,Number.MAX_SAFE_INTEGER,"telegram_user_id"));
    const key=`${event.name}:${purchase}`; const stamp=now();
    let order=await first(env.DB,"SELECT * FROM school_orders WHERE provider='tribute' AND provider_payment_id=?",[purchase]);
    if(order) {
        const s=parse(order.snapshot_json);
        if(s.tribute_product_id!==product || order.telegram_id!==telegram || Number(p.amount)!==order.charged_amount || String(p.currency).toUpperCase()!==order.charged_currency) fail(409,"Покупка Tribute не совпадает с сохраненным заказом");
    }
    if(event.name==="digital_product_refunded") {
        const tomb=await first(env.DB,"SELECT * FROM school_refund_tombstones WHERE provider='tribute' AND purchase_id=?",[purchase]);
        if(tomb && (tomb.product_id!==product || tomb.telegram_id!==telegram)) fail(409,"Данные возврата Tribute изменились");
        await env.DB.batch([
            env.DB.prepare("INSERT OR IGNORE INTO school_refund_tombstones(provider,purchase_id,product_id,telegram_id,created_at) VALUES('tribute',?,?,?,?)").bind(purchase,product,telegram,stamp),
            env.DB.prepare("UPDATE school_orders SET status='refunded',refunded_minor=amount_minor,updated_at=? WHERE provider='tribute' AND provider_payment_id=?").bind(stamp,purchase),
            env.DB.prepare("UPDATE school_entitlements SET status='revoked',updated_at=? WHERE source='tribute' AND source_order_id IN(SELECT id FROM school_orders WHERE provider='tribute' AND provider_payment_id=?)").bind(stamp,purchase)
        ]);
        await recordEvent(env.DB,"tribute",key,event.name,order?.id || null,event,"processed");
        return json({ok:true,access_granted:false,access_revoked:Boolean(order)});
    }
    // Exact purchase duplicates are independent of later catalog edits or outages.
    if(order) { await recordEvent(env.DB,"tribute",key,event.name,order.id,event,"processed"); return json({ok:true,order_id:order.id,access_granted:["paid","partially_refunded"].includes(order.status)}); }
    const mapping=await first(env.DB,"SELECT * FROM school_tribute_products WHERE product_id=?",[product]);
    const user=await first(env.DB,"SELECT id,telegram_id,status FROM users WHERE telegram_id=?",[telegram]);
    const snapshot=mapping && parse(mapping.snapshot_json);
    let issue=!mapping?"Не настроено соответствие товара тарифу":!user?"Telegram покупателя не привязан к ученику":null;
    const chargedCurrency=String(p.currency).toUpperCase();
    const chargedAmount=Number(p.amount);
    if(!issue && (!Number.isSafeInteger(chargedAmount) || chargedAmount<=0 ||
        !((chargedCurrency==="RUB" && chargedAmount===snapshot.amount_minor) ||
          (chargedCurrency==="XTR" && snapshot.tribute_stars_amount>0 && chargedAmount===snapshot.tribute_stars_amount)))) issue="Сумма или валюта не совпадает с тарифом";
    const paidAt=validDate(p.purchase_created_at || event.created_at);
    if(!paidAt) issue="Отсутствует корректная дата покупки";
    if(issue) { await recordEvent(env.DB,"tribute",key,event.name,null,event,"needs_review",issue); fail(409,issue,"unmapped_payment"); }
    try {
        const current=await validatedTributeProduct(env,product,snapshot.amount_minor);
        if(chargedCurrency==="XTR" && current.tribute_stars_amount!==chargedAmount) fail(409,"Цена Tribute Stars не совпадает с покупкой");
    }
    catch(error) { await recordEvent(env.DB,"tribute",key,event.name,null,event,"needs_review",text(error.message,400)); throw error; }
    const tomb=await first(env.DB,"SELECT * FROM school_refund_tombstones WHERE provider='tribute' AND purchase_id=?",[purchase]);
    if(tomb && (tomb.product_id!==product || tomb.telegram_id!==telegram)) fail(409,"Возврат не совпадает с покупкой");
    const id=`tribute:${purchase}`;
    order={id,user_id:user.id,provider:"tribute",provider_payment_id:purchase,snapshot_json:mapping.snapshot_json};
    // The INSERT, grant and tombstone check are one D1 transaction. A refund
    // racing this batch can never be undone by a delayed purchase notification.
    await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO school_orders(id,user_id,telegram_id,offer_id,provider,request_key,idempotence_key,provider_payment_id,snapshot_json,amount_minor,currency,status,refunded_minor,charged_amount,charged_currency,created_at,updated_at,paid_at)
            VALUES(?,?,?,?,'tribute',?,?,?,?,?,'RUB',CASE WHEN EXISTS(SELECT 1 FROM school_refund_tombstones WHERE provider='tribute' AND purchase_id=?) THEN 'refunded' ELSE 'paid' END,
            CASE WHEN EXISTS(SELECT 1 FROM school_refund_tombstones WHERE provider='tribute' AND purchase_id=?) THEN ? ELSE 0 END,?,?,?,?,?)`)
            .bind(id,user.id,telegram,mapping.offer_id,id,id,purchase,mapping.snapshot_json,snapshot.amount_minor,purchase,purchase,snapshot.amount_minor,chargedAmount,chargedCurrency,stamp,stamp,paidAt),
        grantStatement(env.DB,order,paidAt)
    ]);
    await recordEvent(env.DB,"tribute",key,event.name,id,event,"processed");
    const saved=await first(env.DB,"SELECT * FROM school_orders WHERE id=?",[id]);
    return json({ok:true,order_id:id,access_granted:saved.status==="paid"});
}
export async function checkPayment(env,id,input={}) {
    await ensureCommerceSchema(env.DB);
    let order=await first(env.DB,"SELECT * FROM school_orders WHERE id=?",[id]); if(!order) fail(404,"Платеж не найден");
    if(order.provider==="yookassa") {
        if(!order.provider_payment_id && input.provider_payment_id) {
            if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.provider_payment_id)) fail(400,"Некорректный ID платежа ЮKassa");
            await applyYooPayment(env,order,await providerRequest(env,"yookassa",`/payments/${encodeURIComponent(input.provider_payment_id)}`));
        } else if(!order.provider_payment_id) order=await submitYooOrder(env,order);
        else await applyYooPayment(env,order,await providerRequest(env,"yookassa",`/payments/${encodeURIComponent(order.provider_payment_id)}`));
        order=await first(env.DB,"SELECT * FROM school_orders WHERE id=?",[id]);
        if(order.provider_payment_id) await reconcileYooRefunds(env,order,input.provider_refund_id);
    } else {
        // Tribute documents no GET purchase/status endpoint. Reconciliation
        // replays an authenticated stored webhook, never invents a paid state.
        const event=await first(env.DB,"SELECT payload_json FROM school_payment_events WHERE provider='tribute' AND order_id=? AND event_type='new_digital_product'",[id]);
        if(event) await processTributeEvent(env,parse(event.payload_json));
    }
    return readPublicOrder(env.DB,id);
}

async function applyYooRefund(env,order,refund,result) {
    if(!result.id || (refund?.provider_refund_id && refund.provider_refund_id!==result.id) || result.payment_id!==order.provider_payment_id ||
        result.amount?.currency!=="RUB" || minorUnits(result.amount?.value)!==(refund?.amount_minor ?? order.amount_minor) ||
        !["pending","succeeded","canceled"].includes(result.status)) fail(409,"Некорректный ответ на возврат");
    if(refund) await run(env.DB,"UPDATE school_refunds SET provider_refund_id=?,status=?,updated_at=? WHERE id=? AND status<>'succeeded'",[result.id,result.status,now(),refund.id]);
    if(result.status==="succeeded") await recordVerifiedRefund(env,order,result);
}
async function reconcileYooRefunds(env,order,manualId) {
    const refunds=await all(env.DB,"SELECT * FROM school_refunds WHERE order_id=? AND status IN('creating','uncertain','pending','needs_review')",[order.id]);
    if(manualId) {
        if(!/^[A-Za-z0-9_-]{8,128}$/.test(manualId)) fail(400,"Некорректный ID возврата ЮKassa");
        const result=await providerRequest(env,"yookassa",`/refunds/${encodeURIComponent(manualId)}`);
        if(result.id!==manualId) fail(409,"ID возврата не совпадает с запросом");
        const refund=refunds.find(r=>r.provider_refund_id===manualId) || refunds.find(r=>!r.provider_refund_id);
        if(!refund && result.status!=="succeeded") fail(409,"Нет ожидающего возврата для сопоставления");
        await applyYooRefund(env,order,refund,result);
    }
    for(const refund of refunds) {
        if(manualId && (!refund.provider_refund_id || refund.provider_refund_id===manualId)) continue;
        if(refund.provider_refund_id) {
            await applyYooRefund(env,order,refund,await providerRequest(env,"yookassa",`/refunds/${encodeURIComponent(refund.provider_refund_id)}`));
        } else if(Date.now()-Date.parse(refund.created_at)>RETRY_WINDOW) {
            // A status check must never issue a financial POST. An unknown result
            // outside the provider's guaranteed key window requires reconciliation.
            await run(env.DB,"UPDATE school_refunds SET status='needs_review',updated_at=? WHERE id=? AND provider_refund_id IS NULL AND status IN('creating','uncertain')",[now(),refund.id]);
        }
    }
}

async function refundOrder(env,user,id,input) {
    ownerOnly(user); if(input.confirmed!==true) fail(400,"Подтвердите возврат конкретного платежа");
    const key=requestKey(input.request_key); const order=await first(env.DB,"SELECT * FROM school_orders WHERE id=?",[id]);
    if(!order) fail(404,"Платеж не найден");
    if(order.status==="refunded") return readPublicOrder(env.DB,id);
    if(order.status!=="paid" || order.refunded_minor) fail(409,"Автоматический возврат доступен только для полностью оплаченного заказа без предыдущих возвратов");
    if(order.provider==="tribute") return refundTributeOrder(env,order,key,input);
    const receipt=parse(order.request_json)?.receipt;
    if(!receipt) fail(409,"Для возврата отсутствует снимок чека");
    const reason=text(input.reason,250); if(!reason) fail(400,"Укажите причину возврата");
    const payload={payment_id:order.provider_payment_id,amount:{value:decimal(order.amount_minor),currency:"RUB"},description:reason,receipt};
    let refund=await first(env.DB,"SELECT * FROM school_refunds WHERE order_id=? AND request_key=?",[id,key]);
    if(!refund) {
        const existing=await first(env.DB,"SELECT id FROM school_refunds WHERE order_id=? AND status IN('creating','uncertain','pending','needs_review','succeeded')",[id]);
        if(existing) fail(409,"Для платежа уже создан возврат. Проверьте его статус.");
        const stamp=now();
        await run(env.DB,"INSERT OR IGNORE INTO school_refunds(id,order_id,request_key,idempotence_key,amount_minor,status,request_json,created_at,updated_at) VALUES(?,?,?,?,?,'creating',?,?,?)",[crypto.randomUUID(),id,key,crypto.randomUUID(),order.amount_minor,JSON.stringify(payload),stamp,stamp]);
        refund=await first(env.DB,"SELECT * FROM school_refunds WHERE order_id=? AND request_key=?",[id,key]);
        if(!refund)fail(409,"Для заказа уже создан другой возврат");
    }
    if(!refund.provider_refund_id && Date.now()-Date.parse(refund.created_at)>RETRY_WINDOW) fail(409,"Истек безопасный срок повтора возврата. Нужна сверка в ЮKassa.");
    try {
        const result=refund.provider_refund_id ? await providerRequest(env,"yookassa",`/refunds/${encodeURIComponent(refund.provider_refund_id)}`)
            : await providerRequest(env,"yookassa","/refunds",{method:"POST",body:parse(refund.request_json),key:refund.idempotence_key});
        await applyYooRefund(env,order,refund,result);
    } catch(error) {
        await run(env.DB,"UPDATE school_refunds SET status='uncertain',updated_at=? WHERE id=? AND status NOT IN('succeeded','canceled')",[now(),refund.id]); throw error;
    }
    return readPublicOrder(env.DB,id);
}
async function refundTributeOrder(env,order,key,input) {
    const reason=text(input.reason,250);if(!reason)fail(400,"Укажите причину возврата");
    let refund=await first(env.DB,"SELECT * FROM school_refunds WHERE order_id=? AND request_key=?",[order.id,key]);
    if(!refund) {
        const existing=await first(env.DB,"SELECT id FROM school_refunds WHERE order_id=? AND status IN('creating','submitting','uncertain','pending','succeeded')",[order.id]);
        if(existing)fail(409,"Возврат уже отправлен. Ожидайте уведомление Tribute или сверьте покупку в кабинете.");
        const stamp=now();
        await run(env.DB,"INSERT OR IGNORE INTO school_refunds(id,order_id,request_key,idempotence_key,amount_minor,status,request_json,created_at,updated_at) VALUES(?,?,?,?,?,'creating',?,?,?)",[crypto.randomUUID(),order.id,key,crypto.randomUUID(),order.amount_minor,JSON.stringify({reason}),stamp,stamp]);
        refund=await first(env.DB,"SELECT * FROM school_refunds WHERE order_id=? AND request_key=?",[order.id,key]);
        if(!refund)fail(409,"Для заказа уже создан другой возврат");
    }
    // Tribute documents no idempotency key or purchase GET. Never blindly repeat
    // a cancellation after an ambiguous network response, even on UI retries.
    const claim=await run(env.DB,"UPDATE school_refunds SET status='submitting',updated_at=? WHERE id=? AND status='creating'",[now(),refund.id]);
    if(!claim.meta?.changes) return {...publicOrder(order),refund_status:refund.status,note:"Возврат уже отправлен; ожидайте webhook Tribute или проверьте кабинет провайдера."};
    try {
        const result=await providerRequest(env,"tribute",`/products/purchases/${encodeURIComponent(order.provider_payment_id)}/cancel`,{method:"POST"});
        if(result.success!==true || String(result.purchaseId)!==order.provider_payment_id)fail(502,"Tribute не подтвердил возврат","provider_uncertain");
        const stamp=now();const snapshot=parse(order.snapshot_json);
        await env.DB.batch([
            env.DB.prepare("UPDATE school_refunds SET status='succeeded',updated_at=? WHERE id=?").bind(stamp,refund.id),
            env.DB.prepare("INSERT OR IGNORE INTO school_refund_tombstones(provider,purchase_id,product_id,telegram_id,created_at) VALUES('tribute',?,?,?,?)").bind(order.provider_payment_id,snapshot.tribute_product_id,order.telegram_id,stamp),
            env.DB.prepare("UPDATE school_orders SET status='refunded',refunded_minor=amount_minor,updated_at=? WHERE id=?").bind(stamp,order.id),
            env.DB.prepare("UPDATE school_entitlements SET status='revoked',updated_at=? WHERE source='tribute' AND source_order_id=?").bind(stamp,order.id)
        ]);
    } catch(error) {
        await run(env.DB,"UPDATE school_refunds SET status=?,updated_at=? WHERE id=? AND status='submitting'",[error.code==="provider_rejected"?"failed":"uncertain",now(),refund.id]);throw error;
    }
    return publicOrder(await first(env.DB,"SELECT * FROM school_orders WHERE id=?",[order.id]));
}

export async function handleCommerceRequest(request,env,ctx) {
    const url=new URL(request.url); const path=url.pathname;
    const matches=path==="/api/admin/school-settings" || /^\/api\/admin\/offers(?:\/[^/]+)?$/.test(path) || /^\/api\/admin\/payments(?:\/[^/]+\/(check|refund))?$/.test(path) ||
        /^\/api\/admin\/payment-events\/[^/]+\/retry$/.test(path) || ["/api/offers","/api/checkout","/api/payments","/api/webhooks/tribute","/api/webhooks/yookassa"].includes(path);
    if(!matches) return null;
    try {
        if(path.startsWith("/api/webhooks/")) {
            if(request.method!=="POST") fail(405,"Метод не поддерживается");
            return path.endsWith("tribute") ? await handleTributeWebhookRequest(request,env) : await handleYooKassaWebhookRequest(request,env);
        }
        const auth=await ctx.requireUser(request,env); if(!auth.ok) return ctx.authError(auth,env);
        activeUser(auth.user); await ensureCommerceSchema(env.DB);
        const respond=(data,status=200)=>ctx.json?ctx.json(data,status,env):json(data,status);
        if(path==="/api/admin/school-settings") {
            ownerOnly(auth.user); let settings;
            if(request.method==="GET") settings=await getSchoolSettings(env.DB);
            else if(request.method==="PUT") settings=await updateSchoolSettings(env,auth.user,(await readBody(request)).settings);
            else fail(405,"Метод не поддерживается");
            return respond({ok:true,settings,providers:paymentProviderStatus(env,settings),receipt_options:RECEIPT_OPTIONS});
        }
        if(path.startsWith("/api/admin/offers")) {
            ownerOnly(auth.user); const id=path.split("/")[4] ? decodeURIComponent(path.split("/")[4]) : null;
            if(request.method==="GET" && !id) return respond({ok:true,offers:await all(env.DB,"SELECT * FROM school_offers ORDER BY created_at DESC,id")});
            if((request.method==="POST" && !id) || (request.method==="PUT" && id)) return respond({ok:true,offer:await saveOffer(env,auth.user,await readBody(request),id)},id?200:201);
            if(request.method==="DELETE" && id) { await run(env.DB,"UPDATE school_offers SET is_active=0,updated_at=? WHERE id=?",[now(),id]); return respond({ok:true}); }
            fail(405,"Метод не поддерживается");
        }
        if(path==="/api/offers" && request.method==="GET") return respond({ok:true,offers:await listOffers(env,auth.user,url.searchParams.get("channel") || "web")});
        if(path==="/api/checkout" && request.method==="POST") return respond({ok:true,order:await createOrder(env,auth.user,await readBody(request))},201);
        if(path.startsWith("/api/admin/payments") || path.startsWith("/api/admin/payment-events")) {
            const admin=await ctx.requireAdminPermission(request,env,"payments"); if(!admin.ok) return ctx.authError(admin,env);
            const action=path.match(/^\/api\/admin\/payments\/([^/]+)\/(check|refund)$/);
            if(action && request.method==="POST") return respond({ok:true,order:action[2]==="check"?await checkPayment(env,decodeURIComponent(action[1]),await readBody(request,true)):await refundOrder(env,auth.user,decodeURIComponent(action[1]),await readBody(request))});
            const replay=path.match(/^\/api\/admin\/payment-events\/([^/]+)\/retry$/);
            if(replay && request.method==="POST") {
                const event=await first(env.DB,"SELECT * FROM school_payment_events WHERE id=? AND provider='tribute'",[decodeURIComponent(replay[1])]);
                if(!event) fail(404,"Событие не найдено"); return await processTributeEvent(env,parse(event.payload_json));
            }
            if(path!=="/api/admin/payments" || request.method!=="GET") fail(405,"Метод не поддерживается");
            const limit=integer(url.searchParams.get("limit") || 50,1,100,"limit"); const offset=integer(url.searchParams.get("offset") || 0,0,1000000,"offset");
                const payments=(await all(env.DB,`${ORDER_WITH_REFUND} ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`,[limit,offset])).map(publicOrder);
            const unmatched_events=await all(env.DB,"SELECT id,provider,event_type,status,reason,created_at FROM school_payment_events WHERE status='needs_review' ORDER BY created_at DESC LIMIT 50");
            return respond({ok:true,payments,unmatched_events,limit,offset});
        }
        if(path==="/api/payments" && request.method==="GET") return respond({ok:true,payments:(await all(env.DB,`${ORDER_WITH_REFUND} WHERE o.user_id=? ORDER BY o.created_at DESC,o.id LIMIT 100`,[auth.user.id])).map(publicOrder)});
        fail(405,"Метод не поддерживается");
    } catch(error) {
        const status=error instanceof CommerceError?error.status:500;
        if(status===500) console.error("Commerce request failed", {path, message:error.message});
        const data={ok:false,error:status===500?"Не удалось обработать платежную операцию":error.message,code:error.code || "commerce_error"};
        return ctx.json?ctx.json(data,status,env):json(data,status);
    }
}

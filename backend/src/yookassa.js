const YOOKASSA_API =
    "https://api.yookassa.ru/v3";

const YOOKASSA_IPV4_RANGES = [
    ["185.71.76.0", "185.71.76.31"],
    ["185.71.77.0", "185.71.77.31"],
    ["77.75.153.0", "77.75.153.127"],
    ["77.75.156.11", "77.75.156.11"],
    ["77.75.156.35", "77.75.156.35"],
    ["77.75.154.128", "77.75.154.255"]
];

function ipv4ToNumber(ip) {
    const parts = String(ip)
        .split(".")
        .map(Number);

    if (
        parts.length !== 4 ||
        parts.some(
            part =>
                !Number.isInteger(part) ||
                part < 0 ||
                part > 255
        )
    ) {
        return null;
    }

    return (
        ((parts[0] << 24) >>> 0) +
        (parts[1] << 16) +
        (parts[2] << 8) +
        parts[3]
    ) >>> 0;
}

function isYooKassaSourceIp(ip) {
    const value = String(ip || "")
        .trim()
        .toLowerCase();

    if (!value) {
        return false;
    }

    // Официальная IPv6-сеть ЮKassa:
    // 2a02:5180::/32
    if (
        value === "2a02:5180::" ||
        value.startsWith("2a02:5180:")
    ) {
        return true;
    }

    const numericIp =
        ipv4ToNumber(value);

    if (numericIp === null) {
        return false;
    }

    return YOOKASSA_IPV4_RANGES.some(
        ([start, end]) => {
            const startNumber =
                ipv4ToNumber(start);

            const endNumber =
                ipv4ToNumber(end);

            return (
                startNumber !== null &&
                endNumber !== null &&
                numericIp >= startNumber &&
                numericIp <= endNumber
            );
        }
    );
}

export function isYooKassaConfigured(env) {
    return Boolean(
        env.YOOKASSA_SHOP_ID &&
        env.YOOKASSA_SECRET_KEY
    );
}

function authHeader(env) {
    const credentials =
        `${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`;

    return `Basic ${btoa(credentials)}`;
}

async function ensureYooKassaSchema(env) {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS yookassa_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            order_uid TEXT NOT NULL UNIQUE,

            user_id INTEGER NOT NULL,
            telegram_id TEXT NOT NULL,

            course_id INTEGER NOT NULL,
            program_id INTEGER,
            semester_id INTEGER NOT NULL,

            amount_rub INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'RUB',

            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (
                    status IN (
                        'pending',
                        'paid',
                        'canceled',
                        'failed'
                    )
                ),

            idempotence_key TEXT NOT NULL UNIQUE,

            yookassa_payment_id TEXT UNIQUE,
            confirmation_url TEXT,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            paid_at TEXT,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY (course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE,

            FOREIGN KEY (semester_id)
                REFERENCES semesters(id)
                ON DELETE CASCADE
        )
    `).run();

    await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_yookassa_orders_user
        ON yookassa_orders(user_id)
    `).run();

    await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS
        idx_yookassa_orders_payment
        ON yookassa_orders(yookassa_payment_id)
    `).run();

    /*
     * Эта таблица уже используется ботом.
     * CREATE IF NOT EXISTS ничего не сломает.
     */
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    await env.DB.prepare(`
        INSERT OR IGNORE INTO bot_settings (
            key,
            value
        )
        VALUES (
            'prep_course_price',
            '1500'
        )
    `).run();
}

async function getPaymentTarget(
    env,
    semesterId = null
) {
    if (semesterId) {
        return env.DB.prepare(`
            SELECT
                s.id AS semester_id,
                s.course_id,
                s.program_id,
                s.number AS semester_number,
                s.access_months,
                s.price_rub,
                c.name AS course_name
            FROM semesters s
            JOIN courses c
                ON c.id = s.course_id
            WHERE s.id = ?
              AND s.is_active = 1
              AND s.payment_enabled = 1
            LIMIT 1
        `)
            .bind(semesterId)
            .first();
    }

    /*
     * Пока бот продаёт Подготовительный курс
     * без отдельного выбора семестра.
     * Поэтому берём первый активный платный семестр.
     */
    return env.DB.prepare(`
        SELECT
            s.id AS semester_id,
            s.course_id,
            s.program_id,
            s.number AS semester_number,
            s.access_months,
            s.price_rub,
            c.name AS course_name
        FROM semesters s
        JOIN courses c
            ON c.id = s.course_id
        WHERE s.is_active = 1
          AND s.payment_enabled = 1
          AND (
                LOWER(c.name) LIKE '%подготов%'
                OR LOWER(c.name) LIKE '%prep%'
          )
        ORDER BY
            s.number ASC,
            s.id ASC
        LIMIT 1
    `).first();
}

async function getCurrentPrice(
    env,
    fallbackPrice
) {
    const row = await env.DB.prepare(`
        SELECT value
        FROM bot_settings
        WHERE key = 'prep_course_price'
        LIMIT 1
    `).first();

    const price =
        Number(row?.value || fallbackPrice);

    if (
        !Number.isSafeInteger(price) ||
        price <= 0
    ) {
        throw new Error(
            "Некорректная цена курса"
        );
    }

    return price;
}

export async function createYooKassaPayment(
    env,
    telegramId,
    semesterId = null
) {
    if (!isYooKassaConfigured(env)) {
        throw new Error(
            "ЮKassa ещё не подключена"
        );
    }

    await ensureYooKassaSchema(env);

    const user = await env.DB.prepare(`
        SELECT
            id,
            telegram_id
        FROM users
        WHERE telegram_id = ?
        LIMIT 1
    `)
        .bind(String(telegramId))
        .first();

    if (!user) {
        throw new Error(
            "Пользователь не найден. Отправьте /start."
        );
    }

    const target =
        await getPaymentTarget(
            env,
            semesterId
        );

    if (!target) {
        throw new Error(
            "Активный семестр для оплаты не найден"
        );
    }

    const price =
        await getCurrentPrice(
            env,
            target.price_rub
        );

    const orderUid =
        crypto.randomUUID();

    const idempotenceKey =
        crypto.randomUUID();

    await env.DB.prepare(`
        INSERT INTO yookassa_orders (
            order_uid,
            user_id,
            telegram_id,
            course_id,
            program_id,
            semester_id,
            amount_rub,
            currency,
            status,
            idempotence_key
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            'RUB',
            'pending',
            ?
        )
    `)
        .bind(
            orderUid,
            user.id,
            String(telegramId),
            target.course_id,
            target.program_id || null,
            target.semester_id,
            price,
            idempotenceKey
        )
        .run();

    const returnUrl =
        env.YOOKASSA_RETURN_URL ||
        (
            env.TELEGRAM_BOT_USERNAME
                ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}`
                : "https://t.me/"
        );

    const response =
        await fetch(
            `${YOOKASSA_API}/payments`,
            {
                method: "POST",

                headers: {
                    Authorization:
                        authHeader(env),

                    "Idempotence-Key":
                        idempotenceKey,

                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    amount: {
                        value:
                            `${price}.00`,
                        currency: "RUB"
                    },

                    capture: true,

                    confirmation: {
                        type: "redirect",
                        return_url:
                            returnUrl
                    },

                    description:
                        `RAUDA ILM — ${target.course_name}`,

                    metadata: {
                        order_uid:
                            orderUid,

                        telegram_id:
                            String(telegramId),

                        semester_id:
                            String(
                                target.semester_id
                            )
                    }
                })
            }
        );

    const payment =
        await response.json()
            .catch(() => null);

    if (
        !response.ok ||
        !payment?.id
    ) {
        await env.DB.prepare(`
            UPDATE yookassa_orders
            SET
                status = 'failed',
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE order_uid = ?
        `)
            .bind(orderUid)
            .run();

        console.error(
            "YooKassa create payment failed:",
            response.status,
            payment
        );

        throw new Error(
            "Не удалось создать платёж"
        );
    }

    const confirmationUrl =
        payment?.confirmation
            ?.confirmation_url;

    if (!confirmationUrl) {
        throw new Error(
            "ЮKassa не вернула ссылку на оплату"
        );
    }

    await env.DB.prepare(`
        UPDATE yookassa_orders
        SET
            yookassa_payment_id = ?,
            confirmation_url = ?,
            updated_at =
                CURRENT_TIMESTAMP
        WHERE order_uid = ?
    `)
        .bind(
            payment.id,
            confirmationUrl,
            orderUid
        )
        .run();

    return {
        orderUid,
        paymentId: payment.id,
        confirmationUrl,
        amount: price,
        semesterId:
            target.semester_id
    };
}

async function getPaymentFromYooKassa(
    env,
    paymentId
) {
    const response =
        await fetch(
            `${YOOKASSA_API}/payments/${encodeURIComponent(paymentId)}`,
            {
                headers: {
                    Authorization:
                        authHeader(env),
                    Accept:
                        "application/json"
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `YooKassa verification failed: ${response.status}`
        );
    }

    return response.json();
}

function addMonths(
    months
) {
    const date =
        new Date();

    const value =
        Number.isSafeInteger(
            Number(months)
        )
            ? Number(months)
            : 3;

    date.setUTCMonth(
        date.getUTCMonth() +
        Math.max(1, value)
    );

    return date.toISOString();
}

async function buildSemesterGrant(
    env,
    order,
    paymentId,
    accessUntil
) {
    /*
     * У тебя структура user_semesters
     * уже менялась.
     * Поэтому определяем доступные колонки
     * автоматически.
     */
    const info =
        await env.DB.prepare(`
            PRAGMA table_info(user_semesters)
        `).all();

    const existing =
        new Set(
            (info.results || [])
                .map(row => row.name)
        );

    const columns = [];
    const values = [];
    const placeholders = [];

    function add(
        column,
        value
    ) {
        if (!existing.has(column)) {
            return;
        }

        columns.push(column);
        values.push(value);
        placeholders.push("?");
    }

    add("user_id", order.user_id);

    add(
        "program_id",
        order.program_id
    );

    add(
        "semester_id",
        order.semester_id
    );

    add(
        "status",
        "active"
    );

    add(
        "access_until",
        accessUntil
    );

    add(
        "payment_source",
        "yookassa"
    );

    add(
        "external_payment_id",
        paymentId
    );

    add(
        "source_checkout_order_id",
        order.order_uid
    );

    const update = [
        "status = 'active'",
        "access_until = excluded.access_until"
    ];

    if (
        existing.has(
            "payment_source"
        )
    ) {
        update.push(
            "payment_source = excluded.payment_source"
        );
    }

    if (
        existing.has(
            "external_payment_id"
        )
    ) {
        update.push(
            "external_payment_id = excluded.external_payment_id"
        );
    }

    if (
        existing.has(
            "source_checkout_order_id"
        )
    ) {
        update.push(
            "source_checkout_order_id = excluded.source_checkout_order_id"
        );
    }

    if (
        existing.has(
            "updated_at"
        )
    ) {
        update.push(
            "updated_at = CURRENT_TIMESTAMP"
        );
    }

    const sql = `
        INSERT INTO user_semesters (
            ${columns.join(", ")}
        )
        VALUES (
            ${placeholders.join(", ")}
        )

        ON CONFLICT(
            user_id,
            semester_id
        )
        DO UPDATE SET
            ${update.join(", ")}
    `;

    return env.DB
        .prepare(sql)
        .bind(...values);
}

async function sendTelegramSuccess(
    env,
    telegramId,
    order
) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return;
    }

    const response =
        await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    chat_id:
                        telegramId,

                    parse_mode:
                        "HTML",

                    text: [
                        "✅ <b>Оплата прошла успешно</b>",
                        "",
                        "RAUDA ILM получила оплату.",
                        "",
                        `💳 Сумма: <b>${order.amount_rub} ₽</b>`,
                        "",
                        "📚 Доступ к оплаченному семестру открыт."
                    ].join("\n")
                })
            }
        );

    if (!response.ok) {
        console.error(
            "Telegram payment notification failed:",
            await response.text()
        );
    }
}

export async function handleYooKassaWebhook(
    request,
    env
) {
        const sourceIp =
        request.headers.get("CF-Connecting-IP") ||
        "";

    if (!isYooKassaSourceIp(sourceIp)) {
        console.warn(
            "Rejected YooKassa webhook from IP:",
            sourceIp || "unknown"
        );

        return new Response(
            "Forbidden",
            {
                status: 403
            }
        );
    }
    
    if (!isYooKassaConfigured(env)) {
        return new Response(
            "YooKassa is not configured",
            {
                status: 503
            }
        );
    }

    await ensureYooKassaSchema(env);

    let notification;

    try {
        notification =
            await request.json();
    } catch {
        return new Response(
            "Bad Request",
            {
                status: 400
            }
        );
    }

    const event =
        String(
            notification?.event || ""
        );

    const incomingPaymentId =
        notification?.object?.id;

    if (!incomingPaymentId) {
        return new Response(
            "OK",
            {
                status: 200
            }
        );
    }

    /*
     * Не доверяем одному только webhook.
     * Запрашиваем платёж прямо у ЮKassa.
     */
    let payment;

    try {
        payment =
            await getPaymentFromYooKassa(
                env,
                incomingPaymentId
            );
    } catch (error) {
        console.error(
            "YooKassa webhook verification:",
            error
        );

        /*
         * Не отвечаем 200,
         * чтобы ЮKassa повторила webhook.
         */
        return new Response(
            "Verification failed",
            {
                status: 502
            }
        );
    }

    const orderUid =
        payment?.metadata?.order_uid;

    const order =
        await env.DB.prepare(`
            SELECT
                yo.*,
                s.access_months
            FROM yookassa_orders yo
            LEFT JOIN semesters s
                ON s.id =
                    yo.semester_id
            WHERE
                yo.yookassa_payment_id = ?
                OR yo.order_uid = ?
            LIMIT 1
        `)
            .bind(
                incomingPaymentId,
                orderUid || ""
            )
            .first();

    /*
     * Это может быть другой платёж
     * того же магазина.
     */
    if (!order) {
        return new Response(
            "OK",
            {
                status: 200
            }
        );
    }

    const expectedAmount =
        Number(order.amount_rub)
            .toFixed(2);

    if (
        payment?.amount?.currency !==
            "RUB" ||
        String(
            payment?.amount?.value
        ) !== expectedAmount ||
        (
            orderUid &&
            orderUid !==
                order.order_uid
        )
    ) {
        console.error(
            "YooKassa payment validation failed",
            {
                paymentId:
                    incomingPaymentId,
                orderUid
            }
        );

        return new Response(
            "Invalid payment",
            {
                status: 400
            }
        );
    }

    if (
        event ===
            "payment.canceled" ||
        payment.status ===
            "canceled"
    ) {
        await env.DB.prepare(`
            UPDATE yookassa_orders
            SET
                status = 'canceled',
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
              AND status <> 'paid'
        `)
            .bind(order.id)
            .run();

        return new Response(
            "OK",
            {
                status: 200
            }
        );
    }

    if (
        event !==
            "payment.succeeded" ||
        payment.status !==
            "succeeded" ||
        payment.paid !== true
    ) {
        return new Response(
            "OK",
            {
                status: 200
            }
        );
    }

    const accessUntil =
        addMonths(
            order.access_months
        );

    const semesterGrant =
        await buildSemesterGrant(
            env,
            order,
            incomingPaymentId,
            accessUntil
        );

    const statements = [
        semesterGrant
    ];

    /*
     * Старый уровень доступа к курсу
     * тоже обновляем, если таблица существует.
     */
    const userCoursesTable =
        await env.DB.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE
                type = 'table'
                AND name =
                    'user_courses'
            LIMIT 1
        `).first();

    if (userCoursesTable) {
        statements.push(
            env.DB.prepare(`
                INSERT INTO user_courses (
                    user_id,
                    course_id,
                    status,
                    access_until,
                    payment_required,
                    created_at,
                    updated_at
                )
                VALUES (
                    ?, ?,
                    'active',
                    ?,
                    1,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )

                ON CONFLICT(
                    user_id,
                    course_id
                )
                DO UPDATE SET
                    status = 'active',
                    access_until =
                        excluded.access_until,
                    updated_at =
                        CURRENT_TIMESTAMP
            `)
                .bind(
                    order.user_id,
                    order.course_id,
                    accessUntil
                )
        );
    }

    statements.push(
        env.DB.prepare(`
            UPDATE yookassa_orders
            SET
                status = 'paid',
                paid_at =
                    COALESCE(
                        paid_at,
                        CURRENT_TIMESTAMP
                    ),
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
              AND status <> 'paid'
        `)
            .bind(order.id)
    );

    const results =
        await env.DB.batch(
            statements
        );

    const paidUpdate =
        results[
            results.length - 1
        ];

    /*
     * Сообщение отправляем только при первом
     * переходе заказа в paid.
     * Повторный webhook доступ не продублирует.
     */
    if (
        Number(
            paidUpdate?.meta?.changes || 0
        ) > 0
    ) {
        await sendTelegramSuccess(
            env,
            order.telegram_id,
            order
        );
    }

    return new Response(
        "OK",
        {
            status: 200
        }
    );
}

export async function getYooKassaPaymentHistory(
    env,
    limit = 10
) {
    await ensureYooKassaSchema(env);

    const safeLimit =
        Math.min(
            25,
            Math.max(
                1,
                Number(limit) || 10
            )
        );

    const result =
        await env.DB.prepare(`
            SELECT
                yo.id,
                yo.telegram_id,
                yo.amount_rub,
                yo.currency,
                yo.status,
                yo.yookassa_payment_id,
                yo.created_at,
                yo.paid_at,

                u.first_name,
                u.last_name,
                u.username,

                c.name AS course_name,

                s.number
                    AS semester_number

            FROM yookassa_orders yo

            LEFT JOIN users u
                ON u.id = yo.user_id

            LEFT JOIN courses c
                ON c.id =
                    yo.course_id

            LEFT JOIN semesters s
                ON s.id =
                    yo.semester_id

            ORDER BY
                yo.id DESC

            LIMIT ?
        `)
            .bind(safeLimit)
            .all();

    return result.results || [];
}

// deploy trigger
// trigger deploy
// deploy trigger 2
// deploy trigger 3
// deploy trigger 4
import {
    createYooKassaPayment,
    isYooKassaConfigured,
    getYooKassaPaymentHistory
} from "./yookassa.js";
import {
    syncTelegramUser,
    getBotAccess,
    getAdmins,
    setUserRole,
    getAdminPermissions,
    hasPermission,
    togglePermission,
    grantAllPermissions,
    revokeAllPermissions
} from "./bot-access.js";

const TELEGRAM_API = "https://api.telegram.org";


// =========================================================
// WEBHOOK
// =========================================================

export async function handleTelegramWebhook(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response(
            "Telegram bot is not configured",
            { status: 503 }
        );
    }

    if (!String(env.TELEGRAM_WEBHOOK_SECRET || "").trim()) {
        return new Response(
            "Telegram webhook secret is not configured",
            { status: 503 }
        );
    }

    if (!isValidTelegramWebhookSecret(request, env)) {
        return new Response(
            "Unauthorized",
            { status: 401 }
        );
    }

    let update;

    try {
        update = await request.json();
    } catch {
        return new Response(
            "Bad Request",
            { status: 400 }
        );
    }

    const telegramUserId =
    update?.callback_query?.from?.id ||
    update?.message?.from?.id ||
    null;

if (
    telegramUserId &&
    env.TELEGRAM_RATE_LIMITER
) {
    const { success } =
        await env.TELEGRAM_RATE_LIMITER.limit({
            key: `telegram-user:${telegramUserId}`
        });

    if (!success) {
        return new Response(
            "Too Many Requests",
            { status: 429 }
        );
    }
}
    
    try {
        if (update?.callback_query) {
            await answerCallback(
                env,
                update.callback_query.id
            );

            await handleCallback(
                env,
                update.callback_query
            );

            return ok();
        }

        if (update?.channel_post) {
    await handleChannelPost(
        env,
        update.channel_post
    );

    return ok();
}
        
        const message = update?.message;

        if (!message?.chat?.id) {
            return ok();
        }

        await syncTelegramUser(
            env,
            message.from
        );

        await handleMessage(
            env,
            message
        );
    } catch (error) {
        console.error(
            "Telegram webhook error:",
            error
        );
    }

    return ok();
}

async function handleChannelPost(
    env,
    message
) {
    if (
        message?.chat?.type !== "channel" ||
        !message?.chat?.id
    ) {
        return;
    }

    const text =
        String(message.text || "")
            .trim()
            .toUpperCase();

    if (
        !/^RAUDA-[A-Z0-9]{6}$/.test(text)
    ) {
        return;
    }

    await ensureSubjectTelegramChannelSchema(
        env
    );

    const state =
        await env.DB.prepare(`
            SELECT
                chat_id,
                subject_id,
                bind_code
            FROM subject_channel_edit_state
            WHERE bind_code = ?
              AND waiting = 1
            LIMIT 1
        `)
            .bind(text)
            .first();

    if (!state) {
        return;
    }

    const subject =
        await env.DB.prepare(`
            SELECT
                id,
                name
            FROM subjects
            WHERE id = ?
            LIMIT 1
        `)
            .bind(state.subject_id)
            .first();

    if (!subject) {
        return;
    }

    await env.DB.batch([
        env.DB.prepare(`
            UPDATE subjects
            SET telegram_chat_id = ?
            WHERE id = ?
        `)
            .bind(
                String(message.chat.id),
                state.subject_id
            ),

        env.DB.prepare(`
            UPDATE subject_channel_edit_state
            SET
                waiting = 0,
                bind_code = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ?
        `)
            .bind(state.chat_id)
    ]);

    return sendMessage(
        env,
        state.chat_id,
        [
            "✅ <b>Telegram-канал привязан</b>",
            "",
            `🎓 Предмет: <b>${escapeHtml(subject.name)}</b>`,
            "",
            `📢 Канал: <b>${escapeHtml(message.chat.title || "Без названия")}</b>`,
            "",
            "Теперь этот канал связан",
            "с выбранным предметом."
        ].join("\n")
    );
}

// =========================================================
// СООБЩЕНИЯ
// =========================================================

async function handleMessage(env, message) {
    const chatId = message.chat.id;

    // States and the existing permission helpers use the private Telegram ID.
    if (!isPrivateBotChat(message.chat, message.from)) {
        return;
    }

    const text = String(message.text || "").trim();
    const command = text.split(/\s+/)[0].split("@")[0];

    await ensureBotStates(env);

    if (command === "/start") {
    await setTributeProductEditWaiting(
        env,
        chatId,
        false
    );

    await setPriceEditWaiting(
        env,
        chatId,
        false
    );

    await env.DB.prepare(`
        UPDATE support_state
        SET waiting = 0
        WHERE user_id = ?
    `)
        .bind(String(message.from.id))
        .run();

    await clearCourseDraft(
        env,
        chatId,
        message.message_id
    );

    return sendWelcome(
        env,
        chatId
    );
}
    
    // Ответ администратора на сообщение поддержки
if (message.reply_to_message?.message_id) {
    const adminId = String(message.from.id);

    const mapping = await env.DB.prepare(`
        SELECT user_id
        FROM support_messages
        WHERE admin_id = ?
          AND admin_message_id = ?
        LIMIT 1
    `)
        .bind(
            adminId,
            message.reply_to_message.message_id
        )
        .first();

    if (mapping?.user_id) {
        // Проверяем, что отвечает владелец или действующий администратор
        const isOwner =
            String(adminId) ===
            String(env.OWNER_TELEGRAM_ID);

        let isAdmin = isOwner;

        if (!isAdmin) {
            const adminUser = await env.DB.prepare(`
                SELECT role
                FROM users
                WHERE telegram_id = ?
                LIMIT 1
            `)
                .bind(adminId)
                .first();

            isAdmin =
                adminUser?.role === "admin";
        }

        if (!isAdmin) {
            return sendMessage(
                env,
                chatId,
                "❌ У вас больше нет прав для ответа от имени поддержки."
            );
        }

        await sendMessage(
            env,
            mapping.user_id,
            "💬 <b>Ответ поддержки RAUDA ILM</b>"
        );

        const copied = await copyMessage(
            env,
            mapping.user_id,
            message.chat.id,
            message.message_id
        );

        if (!copied?.ok) {
            console.error(
                "Support reply delivery failed:",
                copied
            );

            return sendMessage(
                env,
                chatId,
                "❌ Не удалось отправить ответ ученику."
            );
        }

        return sendMessage(
            env,
            chatId,
            "✅ Ответ отправлен ученику."
        );
    }
}
    
    const botState = await env.DB.prepare(`
        SELECT state FROM bot_states WHERE chat_id = ? LIMIT 1
    `).bind(chatId).first();
    const courseState = parseCourseState(botState?.state);
    // Replayed navigation must not cancel a newer prompt either. Real inline
    // callbacks are handled separately: their message ID belongs to the bot.
    if (courseState && message.message_id <= courseState.afterMessageId) {
        return;
    }

    const menuCallbacks = {
        "📚 Программа курса": "program",
        "🛒 Оформить заказ": "order",
        "ℹ️ О школе": "about",
        "💬 Поддержка": "support",
        "⚙️ Управление": "admin",
        "⬅️ Админ-панель": "admin",
        "📚 Курсы": "admin_courses",
        "⬅️ К курсам": "admin_courses",
        "➕ Создать курс": "admin_courses_create",
        "📚 Список курсов": "admin_courses_list",
        "👥 Ученики": "admin_students",
        "👨‍👩‍👧‍👦 Группы": "admin_groups",
        "📝 Экзамены": "admin_exams",
        "💳 Оплата": "admin_payments",
        "📜 Сертификаты": "admin_certificates",
        "📊 Статистика": "admin_stats",
        "👮 Администраторы": "admin_staff"
    };

    // Navigation must be handled before a message can become a course name.
    if (menuCallbacks[text]) {
        return handleCallback(env, {
            from: message.from,
            message,
            data: menuCallbacks[text]
        }, true);
    }

    const supportState = await env.DB.prepare(`
    SELECT waiting
    FROM support_state
    WHERE user_id = ?
    LIMIT 1
`).bind(String(message.from.id)).first();

if (supportState?.waiting === 1) {
    await handleSupportMessage(
        env,
        message
    );
    return;
}
    const tributeProductEditWaiting =
    await isTributeProductEditWaiting(
        env,
        chatId
    );

if (tributeProductEditWaiting) {
    if (command === "/start") {
    await setTributeProductEditWaiting(
        env,
        chatId,
        false
    );

    return sendWelcome(
        env,
        chatId
    );
}
    if (command === "/cancel") {
        await setTributeProductEditWaiting(
            env,
            chatId,
            false
        );

        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Изменение товара Tribute отменено</b>",
                "",
                "Ссылка Tribute осталась прежней."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "💳 Вернуться к оплате",
                            callback_data: "admin_payments"
                        }
                    ]
                ]
            }
        );
    }

    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        await setTributeProductEditWaiting(
            env,
            chatId,
            false
        );

        return;
    }

    const productInput =
    String(text || "").trim();
let tributeUrl;

try {
    tributeUrl =
        new URL(productInput);
} catch {
    return sendMessage(
        env,
        chatId,
        [
            "❌ <b>Неверная ссылка Tribute</b>",
            "",
            "Отправьте ссылку вида:",
            "<code>https://web.tribute.tg/p/EUa</code>"
        ].join("\n")
    );
}

if (
    tributeUrl.protocol !== "https:" ||
    tributeUrl.hostname !== "web.tribute.tg"
) {
    return sendMessage(
        env,
        chatId,
        [
            "❌ <b>Неверная ссылка Tribute</b>",
            "",
            "Нужна ссылка из раздела",
            "«Инфопродукты и контент».",
            "",
            "Например:",
            "<code>https://web.tribute.tg/p/EUa</code>"
        ].join("\n")
    );
}
    
let tributeProduct;

try {
    tributeProduct =
        await resolveTributeProduct(
            env,
            productInput
        );
} catch (error) {
    console.error(
        "Tribute product resolve failed:",
        error
    );

    return sendMessage(
        env,
        chatId,
       [
    "❌ <b>Инфопродукт Tribute не найден</b>",
    "",
    "Проверьте, что ссылка скопирована",
    "из раздела «Инфопродукты и контент».",
    "",
    "Пример:",
    "<code>https://web.tribute.tg/p/EUa</code>"
].join("\n")
    );
}

const productId =
    Number(
        tributeProduct.id
    );

    await setTributeProductId(
        env,
        productId
    );

    await setTributeProductEditWaiting(
        env,
        chatId,
        false
    );
return sendMessage(
    env,
    chatId,
    [
    "✅ <b>Ссылка Tribute сохранена</b>",
    "",
    "Инфопродукт найден и подключён.",
    "",
    `🔗 <code>${escapeHtml(productInput)}</code>`,
    "",
    "Теперь эта ссылка будет использоваться",
    "при оплате через Tribute."
].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "💳 Вернуться к оплате",
                        callback_data: "admin_payments"
                    }
                ]
            ]
        }
    );
}
    const priceEditWaiting =
    await isPriceEditWaiting(
        env,
        chatId
    );
    if (priceEditWaiting) {
    // Отмена изменения цены
    if (command === "/cancel") {
        await setPriceEditWaiting(
            env,
            chatId,
            false
        );

        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Изменение цены отменено</b>",
                "",
                "Цена осталась прежней."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "💳 Вернуться к оплате",
                            callback_data: "admin_payments"
                        }
                    ]
                ]
            }
        );
    }

    // Проверяем право на управление оплатой
    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        await setPriceEditWaiting(
            env,
            chatId,
            false
        );

        return;
    }

    // Разрешаем ввод вида:
    // 1500
    // 1 500
    const cleanPrice =
        text.replace(/\s+/g, "");

    if (!/^\d+$/.test(cleanPrice)) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Неверная цена</b>",
                "",
                "Отправьте только число.",
                "",
                "Например:",
                "<code>1500</code>"
            ].join("\n")
        );
    }

    const newPrice =
        Number(cleanPrice);

    if (
        !Number.isSafeInteger(newPrice) ||
        newPrice < 1 ||
        newPrice > 1000000
    ) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Недопустимая цена</b>",
                "",
                "Укажите сумму от",
                "1 до 1 000 000 ₽."
            ].join("\n")
        );
    }

    // Сохраняем новую цену в D1
    await setCoursePrice(
        env,
        newPrice
    );

    // Выключаем режим редактирования
    await setPriceEditWaiting(
        env,
        chatId,
        false
    );

    return sendMessage(
        env,
        chatId,
        [
            "✅ <b>Цена изменена</b>",
            "",
            `💰 Новая цена: <b>${formatPrice(newPrice)} ₽</b>`,
            "",
            "Изменение сохранено в D1."
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "💳 Вернуться к оплате",
                        callback_data: "admin_payments"
                    }
                ]
            ]
        }
    );
}

if (priceEditWaiting) {
    if (text === "❌ Отмена" || command === "/cancel") {
        await setPriceEditWaiting(
            env,
            chatId,
            false
        );

        return sendMessage(
            env,
            chatId,
            "❌ Изменение цены отменено."
        );
    }

    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        await setPriceEditWaiting(
            env,
            chatId,
            false
        );

        return;
    }

    const cleanPrice =
        text.replace(/\s+/g, "");

    if (!/^\d+$/.test(cleanPrice)) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Неверная цена</b>",
                "",
                "Введите только число.",
                "",
                "Например:",
                "<code>1500</code>"
            ].join("\n")
        );
    }

    const newPrice = Number(cleanPrice);

    if (
        !Number.isSafeInteger(newPrice) ||
        newPrice < 1 ||
        newPrice > 1000000
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Цена должна быть от 1 до 1 000 000 ₽."
        );
    }

    await setCoursePrice(
        env,
        newPrice
    );

    await setPriceEditWaiting(
        env,
        chatId,
        false
    );

    return sendMessage(
        env,
        chatId,
        [
            "✅ <b>Цена изменена</b>",
            "",
            `💰 Новая цена: <b>${formatPrice(newPrice)} ₽</b>`,
            "",
            "Цена сохранена в D1."
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "💳 Вернуться к оплате",
                        callback_data: "admin_payments"
                    }
                ]
            ]
        }
    );
}
     // -----------------------------------------------------
    // ИЗМЕНЕНИЕ ЦЕНЫ ЧЕРЕЗ АДМИНКУ
    // -----------------------------------------------------

    if (priceEditWaiting) {
        // Если пользователь решил выйти
        if (
            text === "⬅️ Главное меню" ||
            text.startsWith("/")
        ) {
            await setPriceEditWaiting(
                env,
                chatId,
                false
            );

            if (command === "/cancel") {
                return sendAdminPayments(
                    env,
                    chatId
                );
            }
        } else {
            if (
                !await requirePermission(
                    env,
                    chatId,
                    "payments"
                )
            ) {
                await setPriceEditWaiting(
                    env,
                    chatId,
                    false
                );

                return;
            }

            const cleanPrice =
                text.replace(/\s+/g, "");

            if (!/^\d+$/.test(cleanPrice)) {
                return sendMessage(
                    env,
                    chatId,
                    [
                        "❌ <b>Неверная цена</b>",
                        "",
                        "Отправьте только число.",
                        "",
                        "Например:",
                        "<code>1500</code>"
                    ].join("\n")
                );
            }

            const newPrice =
                Number(cleanPrice);

            if (
                !Number.isSafeInteger(newPrice) ||
                newPrice < 1 ||
                newPrice > 1000000
            ) {
                return sendMessage(
                    env,
                    chatId,
                    [
                        "❌ Цена должна быть",
                        "от 1 до 1 000 000 ₽."
                    ].join("\n")
                );
            }

            await setCoursePrice(
                env,
                newPrice
            );

            await setPriceEditWaiting(
                env,
                chatId,
                false
            );

            await sendMessage(
                env,
                chatId,
                [
                    "✅ <b>Цена изменена</b>",
                    "",
                    `💰 Новая цена: <b>${formatPrice(newPrice)} ₽</b>`,
                    "",
                    "Новая цена уже отображается",
                    "ученикам при оформлении заказа."
                ].join("\n")
            );

            return sendAdminPayments(
                env,
                chatId
            );
        }
    }
    
    if (text === "❌ Отмена" || command === "/cancel") {
        await clearCourseDraft(env, chatId, message.message_id);
        if (!await requirePermission(env, chatId, "courses")) {
            return;
        }
        return sendCoursesMenu(env, chatId, "❌ Создание курса отменено.");
    }

    if (text === "⬅️ Главное меню" || text.startsWith("/")) {
        await clearCourseDraft(env, chatId, message.message_id);

        if (command === "/admin_add") {
            return addAdministrator(env, chatId, text);
        }
        if (command === "/admin_remove") {
            return removeAdministrator(env, chatId, text);
        }
        return sendWelcome(env, chatId);
    }

    const draft = parseCourseDraft(botState?.state);

    if (draft) {
        if (!await requirePermission(env, chatId, "courses")) {
            await clearCourseDraft(env, chatId, message.message_id);
            return;
        }

        const name = text.replace(/\s+/g, " ");
        if (typeof message.text !== "string" || [...name].length < 2 || [...name].length > 100) {
            return sendMessage(
                env,
                chatId,
                "❌ Отправьте название текстом: от 2 до 100 символов.",
                courseNameKeyboard()
            );
        }

        let saved;
        try {
            // D1 batch is atomic: only one delivery can consume this draft.
            [saved] = await env.DB.batch([
                env.DB.prepare(`
                    INSERT INTO courses (name, is_active)
                    SELECT ?, 1
                    WHERE EXISTS (
                        SELECT 1 FROM bot_states WHERE chat_id = ? AND state = ?
                    )
                `).bind(name, chatId, botState.state),
                env.DB.prepare(`
                    UPDATE bot_states SET state = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE chat_id = ? AND state = ?
                `).bind(idleCourseState(message.message_id), chatId, botState.state)
            ]);
        } catch (error) {
            console.error("Telegram course creation failed:", error);
            return sendMessage(
                env,
                chatId,
                "❌ Не удалось сохранить курс. Повторите название или нажмите «❌ Отмена».",
                courseNameKeyboard()
            );
        }

        if (!saved.meta?.changes) {
            return;
        }

        return sendMessage(env, chatId, [
            "✅ <b>Курс создан</b>",
            "",
            `📚 ${escapeHtml(name)}`
        ].join("\n"), coursesKeyboard());
    }

    return sendWelcome(env, chatId);
}

async function handleSupportMessage(env, message) {
    const userId = String(message.from.id);

    const adminRows = await env.DB.prepare(`
        SELECT telegram_id
        FROM users
        WHERE role = 'admin'
          AND telegram_id IS NOT NULL
    `).all();

    const recipients = new Set();

    // Добавляем владельца
    if (env.OWNER_TELEGRAM_ID) {
        recipients.add(
            String(env.OWNER_TELEGRAM_ID)
        );
    }

    // Добавляем всех администраторов
    for (const admin of adminRows.results || []) {
        if (admin.telegram_id) {
            recipients.add(
                String(admin.telegram_id)
            );
        }
    }

    if (recipients.size === 0) {
        await env.DB.prepare(`
            UPDATE support_state
            SET waiting = 0
            WHERE user_id = ?
        `)
            .bind(userId)
            .run();

        return sendMessage(
            env,
            userId,
            "❌ Сейчас поддержка недоступна. Попробуйте позже."
        );
    }

    const userName = formatUserName(
        message.from
    );

    let delivered = 0;

    for (const adminId of recipients) {
        try {
            await sendMessage(
                env,
                adminId,
                [
                    "📩 <b>Новое сообщение поддержки</b>",
                    "",
                    `👤 ${escapeHtml(userName)}`,
                    `🆔 <code>${escapeHtml(userId)}</code>`,
                    "",
                    "Ответьте через Reply на сообщение ниже 👇"
                ].join("\n")
            );

            const copied = await copyMessage(
                env,
                adminId,
                message.chat.id,
                message.message_id
            );

            if (
                copied?.ok &&
                copied?.result?.message_id
            ) {
                await env.DB.prepare(`
                    INSERT INTO support_messages (
                        admin_id,
                        admin_message_id,
                        user_id
                    )
                    VALUES (?, ?, ?)
                `)
                    .bind(
                        adminId,
                        copied.result.message_id,
                        userId
                    )
                    .run();

                delivered++;
            }
        } catch (error) {
            console.error(
                "Support delivery failed:",
                adminId,
                error
            );
        }
    }

    await env.DB.prepare(`
        UPDATE support_state
        SET waiting = 0
        WHERE user_id = ?
    `)
        .bind(userId)
        .run();

    if (delivered === 0) {
        return sendMessage(
            env,
            userId,
            "❌ Не удалось отправить сообщение поддержке. Попробуйте позже."
        );
    }

    return sendMessage(
        env,
        userId,
        [
            "✅ <b>Сообщение отправлено</b>",
            "",
            "Поддержка получила ваше сообщение.",
            "Ответ придёт сюда в бот."
        ].join("\n")
    );
}


function isPrivateBotChat(chat, from) {
    return chat?.type === "private" && from?.id != null &&
        String(chat.id) === String(from.id);
}

async function ensureBotStates(env) {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bot_states (
            chat_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
}

function parseCourseState(state) {
    // Accept drafts started by the previously deployed version.
    if (state === "create_course_name") {
        return { action: state, afterMessageId: 0 };
    }
    try {
        const parsed = JSON.parse(state);
        return ["create_course_name", "courses_menu"].includes(parsed?.action) &&
            Number.isSafeInteger(parsed.afterMessageId) ? parsed : null;
    } catch {
        return null;
    }
}

function parseCourseDraft(state) {
    const parsed = parseCourseState(state);
    return parsed?.action === "create_course_name" ? parsed : null;
}

function idleCourseState(messageId) {
    return JSON.stringify({ action: "courses_menu", afterMessageId: messageId });
}

async function ensureSubjectTelegramChannelSchema(
    env
) {
    const info =
        await env.DB.prepare(`
            PRAGMA table_info(subjects)
        `).all();

    const columns =
        new Set(
            (info.results || [])
                .map(row => row.name)
        );

    if (
        !columns.has(
            "telegram_chat_id"
        )
    ) {
        await env.DB.prepare(`
            ALTER TABLE subjects
            ADD COLUMN telegram_chat_id TEXT
        `).run();
    }
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS subject_channel_edit_state (
        chat_id INTEGER PRIMARY KEY,
        subject_id INTEGER NOT NULL,
        bind_code TEXT,
        waiting INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`).run();
}

async function setSubjectChannelEditWaiting(
    env,
    chatId,
    subjectId,
    waiting
) {
    await ensureSubjectTelegramChannelSchema(
        env
    );

    const bindCode =
        waiting
            ? `RAUDA-${crypto.randomUUID()
                .replace(/-/g, "")
                .slice(0, 6)
                .toUpperCase()}`
            : null;

    await env.DB.prepare(`
        INSERT INTO subject_channel_edit_state (
            chat_id,
            subject_id,
            bind_code,
            waiting,
            updated_at
        )
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)

        ON CONFLICT(chat_id)
        DO UPDATE SET
            subject_id = excluded.subject_id,
            bind_code = excluded.bind_code,
            waiting = excluded.waiting,
            updated_at = CURRENT_TIMESTAMP
    `)
        .bind(
            chatId,
            subjectId,
            bindCode,
            waiting ? 1 : 0
        )
        .run();

    return bindCode;
}

async function getSubjectChannelEditState(
    env,
    chatId
) {
    await ensureSubjectTelegramChannelSchema(
        env
    );

    return env.DB.prepare(`
        SELECT
            subject_id,
            waiting
        FROM subject_channel_edit_state
        WHERE chat_id = ?
        LIMIT 1
    `)
        .bind(chatId)
        .first();
}

async function clearCourseDraft(env, chatId, messageId = 0, fromInlineCallback = false) {
    const row = await env.DB.prepare(`
        SELECT state FROM bot_states WHERE chat_id = ? LIMIT 1
    `).bind(chatId).first();

    const state = parseCourseState(row?.state);
    if (state) {
        if (!fromInlineCallback && messageId <= state.afterMessageId) {
            return;
        }
        // Retain the last handled message so old create/name pairs stay consumed.
        const lastMessageId = Math.max(state.afterMessageId, messageId);
        await env.DB.prepare(`
            UPDATE bot_states SET state = ?, updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ? AND state = ?
        `).bind(idleCourseState(lastMessageId), chatId, row.state).run();
    }
}

function coursesKeyboard() {
    return {
        keyboard: [
            [{ text: "➕ Создать курс" }, { text: "📚 Список курсов" }],
            [{ text: "⬅️ Админ-панель" }]
        ],
        resize_keyboard: true,
        is_persistent: true
    };
}

function courseNameKeyboard() {
    return {
        keyboard: [
            [{ text: "❌ Отмена" }],
            [{ text: "⬅️ Админ-панель" }]
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: "Введите название курса..."
    };
}

async function sendCoursesMenu(env, chatId, notice = "") {
    return sendMessage(env, chatId, [
        ...(notice ? [notice, ""] : []),
        "📚 <b>Управление курсами</b>",
        "",
        "Выберите действие:"
    ].join("\n"), coursesKeyboard());
}

async function startCourseCreation(env, chatId, messageId) {
    const previous = await env.DB.prepare(`
        SELECT state FROM bot_states WHERE chat_id = ? LIMIT 1
    `).bind(chatId).first();
    const previousState = parseCourseState(previous?.state);
    if (!Number.isSafeInteger(messageId) ||
        (previousState && messageId <= previousState.afterMessageId)) {
        return;
    }

    const state = JSON.stringify({
        action: "create_course_name",
        afterMessageId: messageId,
        nonce: crypto.randomUUID()
    });

    try {
        const started = await env.DB.prepare(`
            INSERT INTO bot_states (chat_id, state, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(chat_id) DO UPDATE SET
                state = excluded.state,
                updated_at = CURRENT_TIMESTAMP
            WHERE bot_states.state = ?
        `).bind(chatId, state, previous?.state ?? null).run();
        if (!started.meta?.changes) {
            return;
        }
    } catch (error) {
        console.error("Telegram course input failed:", error);
        return sendMessage(env, chatId,
            "❌ Не удалось начать создание курса. Попробуйте ещё раз.", coursesKeyboard());
    }

    return sendMessage(env, chatId, [
        "➕ <b>Создание курса</b>",
        "",
        "Отправьте название курса (от 2 до 100 символов).",
        "",
        "Например:",
        "<i>Подготовительный курс</i>"
    ].join("\n"), courseNameKeyboard());
}

async function sendCoursesList(
    env,
    chatId,
    page = 0
) {
    const pageSize = 10;

    const result = await env.DB.prepare(`
        SELECT id, name, is_active
        FROM courses
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `)
        .bind(
            pageSize + 1,
            page * pageSize
        )
        .all();

    const allCourses =
        result.results || [];

    const courses =
        allCourses.slice(
            0,
            pageSize
        );

    if (!courses.length) {
        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Курсы</b>",
                "",
                page === 0
                    ? "Курсов пока нет."
                    : "На этой странице курсов нет."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "⬅️ Назад",
                            callback_data:
                                "admin_courses"
                        }
                    ]
                ]
            }
        );
    }

    const keyboard = [];

    for (const course of courses) {
        const rawName =
            String(
                course.name || "Без названия"
            )
                .replace(/\s+/g, " ")
                .trim();

        const chars =
            [...rawName];

        const name =
            chars
                .slice(0, 45)
                .join("") +
            (
                chars.length > 45
                    ? "…"
                    : ""
            );

        keyboard.push([
            {
                text:
                    `${course.is_active ? "✅" : "⛔"} ${name}`,
                callback_data:
                    `admin_course_${course.id}`
            }
        ]);
    }

    const navigation = [];

    if (page > 0) {
        navigation.push({
            text: "⬅️",
            callback_data:
                `admin_courses_page_${page - 1}`
        });
    }

    if (allCourses.length > pageSize) {
        navigation.push({
            text: "➡️",
            callback_data:
                `admin_courses_page_${page + 1}`
        });
    }

    if (navigation.length) {
        keyboard.push(
            navigation
        );
    }

    keyboard.push([
        {
            text: "⬅️ К управлению курсами",
            callback_data:
                "admin_courses"
        }
    ]);

    return sendMessage(
        env,
        chatId,
        [
            "📚 <b>Курсы</b>",
            "",
            "Выберите курс:"
        ].join("\n"),
        {
            inline_keyboard:
                keyboard
        }
    );
}
async function sendCourseCard(
    env,
    chatId,
    courseId
) {
    const course = await env.DB.prepare(`
        SELECT
            id,
            name,
            description,
            purpose,
            is_active
        FROM courses
        WHERE id = ?
        LIMIT 1
    `)
        .bind(courseId)
        .first();

    if (!course) {
        return sendMessage(
            env,
            chatId,
            "❌ Курс не найден.",
            {
                inline_keyboard: [
                    [
                        {
                            text: "⬅️ К списку курсов",
                            callback_data:
                                "admin_courses_list"
                        }
                    ]
                ]
            }
        );
    }

    const description =
        String(
            course.description || ""
        ).trim();

    const purpose =
        String(
            course.purpose || ""
        ).trim();

    return sendMessage(
        env,
        chatId,
        [
            "📚 <b>Управление курсом</b>",
            "",
            `<b>${escapeHtml(course.name)}</b>`,
            "",
            `Статус: ${
                course.is_active
                    ? "✅ Активен"
                    : "⛔ Неактивен"
            }`,
            "",
            description
                ? `📝 <b>Описание:</b>\n${escapeHtml(description)}`
                : "📝 Описание не указано",
            "",
            purpose
                ? `🎯 <b>Цель:</b>\n${escapeHtml(purpose)}`
                : "🎯 Цель не указана"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "📖 Семестры",
                        callback_data:
                            `admin_course_semesters_${course.id}`
                    }
                ],
                [
                    {
                        text: "⬅️ К списку курсов",
                        callback_data:
                            "admin_courses_list"
                    }
                ]
            ]
        }
    );
}

async function sendCourseSemesters(
    env,
    chatId,
    courseId
) {
    const course = await env.DB.prepare(`
        SELECT id, name
        FROM courses
        WHERE id = ?
        LIMIT 1
    `)
        .bind(courseId)
        .first();

    if (!course) {
        return sendMessage(
            env,
            chatId,
            "❌ Курс не найден."
        );
    }

    const result = await env.DB.prepare(`
        SELECT
            id,
            number,
            name,
            is_active
        FROM semesters
        WHERE course_id = ?
        ORDER BY number ASC, id ASC
    `)
        .bind(courseId)
        .all();

    const semesters =
        result.results || [];

    if (!semesters.length) {
        return sendMessage(
            env,
            chatId,
            [
                `📚 <b>${escapeHtml(course.name)}</b>`,
                "",
                "📖 Семестров пока нет."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "⬅️ К курсу",
                            callback_data:
                                `admin_course_${courseId}`
                        }
                    ]
                ]
            }
        );
    }

    const keyboard =
        semesters.map(
            semester => [
                {
                    text:
                        `${semester.is_active ? "✅" : "⛔"} ${semester.number} семестр${semester.name ? ` — ${semester.name}` : ""}`,
                    callback_data:
                        `admin_semester_${semester.id}`
                }
            ]
        );

    keyboard.push([
        {
            text: "⬅️ К курсу",
            callback_data:
                `admin_course_${courseId}`
        }
    ]);

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(course.name)}</b>`,
            "",
            "📖 Выберите семестр:"
        ].join("\n"),
        {
            inline_keyboard:
                keyboard
        }
    );
}

async function sendSemesterCard(
    env,
    chatId,
    semesterId
) {
    const semester = await env.DB.prepare(`
        SELECT
            s.id,
            s.course_id,
            s.number,
            s.name,
            s.description,
            s.price_rub,
            s.access_months,
            s.payment_enabled,
            s.is_active,
            c.name AS course_name
        FROM semesters s
        JOIN courses c
            ON c.id = s.course_id
        WHERE s.id = ?
        LIMIT 1
    `)
        .bind(semesterId)
        .first();

    if (!semester) {
        return sendMessage(
            env,
            chatId,
            "❌ Семестр не найден."
        );
    }

    const semesterName =
        semester.name
            ? ` — ${escapeHtml(semester.name)}`
            : "";

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(semester.course_name)}</b>`,
            "",
            `📖 <b>${semester.number} семестр${semesterName}</b>`,
            "",
            `Статус: ${
                semester.is_active
                    ? "✅ Активен"
                    : "⛔ Неактивен"
            }`,
            `💳 Оплата: ${
                semester.payment_enabled
                    ? "✅ Включена"
                    : "❌ Отключена"
            }`,
            `💰 Цена: <b>${formatPrice(semester.price_rub)} ₽</b>`,
            `🕒 Доступ: <b>${semester.access_months} мес.</b>`,
            "",
            semester.description
                ? `📝 ${escapeHtml(semester.description)}`
                : "📝 Описание не указано"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "📚 Предметы",
                        callback_data:
                            `admin_semester_lessons_${semester.id}`
                    }
                ],
                [
                    {
                        text: "⬅️ К семестрам",
                        callback_data:
                            `admin_course_semesters_${semester.course_id}`
                    }
                ]
            ]
        }
    );
}

async function sendSemesterSubjects(
    env,
    chatId,
    semesterId
) {
    await ensureSubjectTelegramChannelSchema(
        env
    );

    const semester =
        await env.DB.prepare(`
            SELECT
                s.id,
                s.course_id,
                s.number,
                s.name,
                c.name AS course_name
            FROM semesters s
            JOIN courses c
                ON c.id = s.course_id
            WHERE s.id = ?
            LIMIT 1
        `)
            .bind(semesterId)
            .first();

    if (!semester) {
        return sendMessage(
            env,
            chatId,
            "❌ Семестр не найден."
        );
    }

    const result =
        await env.DB.prepare(`
            SELECT
                id,
                name,
                is_active,
                telegram_chat_id
            FROM subjects
            WHERE semester_id = ?
            ORDER BY
                sort_order ASC,
                id ASC
        `)
            .bind(semesterId)
            .all();

    const subjects =
        result.results || [];

    if (!subjects.length) {
        return sendMessage(
            env,
            chatId,
            [
                `📚 <b>${escapeHtml(semester.course_name)}</b>`,
                "",
                `📖 <b>${semester.number} семестр</b>`,
                "",
                "Предметов пока нет."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "⬅️ К семестру",
                            callback_data:
                                `admin_semester_${semesterId}`
                        }
                    ]
                ]
            }
        );
    }

    const keyboard =
        subjects.map(
            subject => {
                const rawName =
                    String(
                        subject.name ||
                        "Без названия"
                    )
                        .replace(/\s+/g, " ")
                        .trim();

                const name =
                    [...rawName]
                        .slice(0, 45)
                        .join("") +
                    (
                        [...rawName].length > 45
                            ? "…"
                            : ""
                    );

                const channelStatus =
                    subject.telegram_chat_id
                        ? "📢"
                        : "⚠️";

                return [
                    {
                        text:
                            `${channelStatus} ${name}`,
                        callback_data:
                            `admin_subject_${subject.id}`
                    }
                ];
            }
        );

    keyboard.push([
        {
            text: "⬅️ К семестру",
            callback_data:
                `admin_semester_${semesterId}`
        }
    ]);

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(semester.course_name)}</b>`,
            "",
            `📖 <b>${semester.number} семестр</b>`,
            "",
            "Выберите предмет:",
            "",
            "📢 — канал привязан",
            "⚠️ — канал не привязан"
        ].join("\n"),
        {
            inline_keyboard:
                keyboard
        }
    );
}

async function sendSemesterLessons(
    env,
    chatId,
    semesterId
) {
    const semester = await env.DB.prepare(`
        SELECT
            s.id,
            s.course_id,
            s.number,
            s.name,
            c.name AS course_name
        FROM semesters s
        JOIN courses c
            ON c.id = s.course_id
        WHERE s.id = ?
        LIMIT 1
    `)
        .bind(semesterId)
        .first();

    if (!semester) {
        return sendMessage(
            env,
            chatId,
            "❌ Семестр не найден."
        );
    }

    const result = await env.DB.prepare(`
        SELECT
            id,
            title,
            lesson_number,
            is_visible
        FROM lessons
        WHERE semester_id = ?
        ORDER BY
            sort_order ASC,
            lesson_number ASC,
            id ASC
    `)
        .bind(semesterId)
        .all();

    const lessons =
        result.results || [];

    if (!lessons.length) {
        return sendMessage(
            env,
            chatId,
            [
                `📚 <b>${escapeHtml(semester.course_name)}</b>`,
                "",
                `📖 <b>${semester.number} семестр</b>`,
                "",
                "Уроков пока нет."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "⬅️ К семестру",
                            callback_data:
                                `admin_semester_${semesterId}`
                        }
                    ]
                ]
            }
        );
    }

    const keyboard =
        lessons.map(
            lesson => {
                const title =
                    String(
                        lesson.title ||
                        "Без названия"
                    )
                        .replace(/\s+/g, " ")
                        .trim();

                const shortTitle =
                    [...title]
                        .slice(0, 45)
                        .join("") +
                    (
                        [...title].length > 45
                            ? "…"
                            : ""
                    );

                const number =
                    lesson.lesson_number
                        ? `${lesson.lesson_number}. `
                        : "";

                return [
                    {
                        text:
                            `${lesson.is_visible ? "✅" : "⛔"} ${number}${shortTitle}`,
                        callback_data:
                            `admin_lesson_${lesson.id}`
                    }
                ];
            }
        );

    keyboard.push([
        {
            text: "⬅️ К семестру",
            callback_data:
                `admin_semester_${semesterId}`
        }
    ]);

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(semester.course_name)}</b>`,
            "",
            `📖 <b>${semester.number} семестр</b>`,
            "",
            "Выберите урок:"
        ].join("\n"),
        {
            inline_keyboard:
                keyboard
        }
    );
}

async function sendSubjectCard(
    env,
    chatId,
    subjectId
) {
    await ensureSubjectTelegramChannelSchema(
        env
    );

    const subject =
        await env.DB.prepare(`
            SELECT
                s.id,
                s.name,
                s.description,
                s.semester_id,
                s.telegram_chat_id,
                s.is_active,
                sem.number AS semester_number,
                c.name AS course_name
            FROM subjects s
            JOIN semesters sem
                ON sem.id = s.semester_id
            JOIN courses c
                ON c.id = s.course_id
            WHERE s.id = ?
            LIMIT 1
        `)
            .bind(subjectId)
            .first();

    if (!subject) {
        return sendMessage(
            env,
            chatId,
            "❌ Предмет не найден."
        );
    }

    const channelLinked =
        Boolean(
            String(
                subject.telegram_chat_id || ""
            ).trim()
        );

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(subject.course_name)}</b>`,
            "",
            `📖 ${subject.semester_number} семестр`,
            "",
            `🎓 <b>${escapeHtml(subject.name)}</b>`,
            "",
            `Статус: ${
                subject.is_active
                    ? "✅ Активен"
                    : "⛔ Неактивен"
            }`,
            "",
            channelLinked
                ? "📢 Telegram-канал: ✅ привязан"
                : "📢 Telegram-канал: ⚠️ не привязан",
            "",
            subject.description
                ? `📝 ${escapeHtml(subject.description)}`
                : "📝 Описание не указано"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text:
                            channelLinked
                                ? "📢 Изменить канал"
                                : "📢 Привязать канал",
                        callback_data:
                            `admin_subject_channel_${subject.id}`
                    }
                ],
                [
                    {
                        text: "⬅️ К предметам",
                        callback_data:
                            `admin_semester_subjects_${subject.semester_id}`
                    }
                ]
            ]
        }
    );
}

async function sendLessonCard(
    env,
    chatId,
    lessonId
) {
    const lesson = await env.DB.prepare(`
        SELECT
            l.id,
            l.semester_id,
            l.title,
            l.description,
            l.content,
            l.lesson_number,
            l.is_visible,
            s.number AS semester_number,
            c.name AS course_name
        FROM lessons l
        JOIN semesters s
            ON s.id = l.semester_id
        JOIN courses c
            ON c.id = l.course_id
        WHERE l.id = ?
        LIMIT 1
    `)
        .bind(lessonId)
        .first();

    if (!lesson) {
        return sendMessage(
            env,
            chatId,
            "❌ Урок не найден."
        );
    }

    const files = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM lesson_files
        WHERE lesson_id = ?
    `)
        .bind(lessonId)
        .first();

    const description =
        String(
            lesson.description || ""
        ).trim();

    const content =
        String(
            lesson.content || ""
        ).trim();

    const preview =
        content
            ? [...content]
                .slice(0, 500)
                .join("") +
              (
                  [...content].length > 500
                      ? "…"
                      : ""
              )
            : "";

    return sendMessage(
        env,
        chatId,
        [
            `📚 <b>${escapeHtml(lesson.course_name)}</b>`,
            "",
            `📖 ${lesson.semester_number} семестр`,
            "",
            `🎓 <b>${
                lesson.lesson_number
                    ? `${lesson.lesson_number}. `
                    : ""
            }${escapeHtml(lesson.title)}</b>`,
            "",
            `Статус: ${
                lesson.is_visible
                    ? "✅ Видимый"
                    : "⛔ Скрытый"
            }`,
            `📎 Материалов: <b>${Number(files?.count || 0)}</b>`,
            "",
            description
                ? `📝 <b>Описание:</b>\n${escapeHtml(description)}`
                : "📝 Описание не указано",
            "",
            preview
                ? `📄 <b>Содержание:</b>\n${escapeHtml(preview)}`
                : "📄 Содержание не добавлено"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "📎 Материалы",
                        callback_data:
                            `admin_lesson_files_${lesson.id}`
                    }
                ],
                [
                    {
                        text: "⬅️ К урокам",
                        callback_data:
                            `admin_semester_lessons_${lesson.semester_id}`
                    }
                ]
            ]
        }
    );
}

// =========================================================
// НАСТРОЙКИ ОПЛАТЫ И ЦЕНЫ
// =========================================================

async function ensurePaymentSettings(env) {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS price_edit_state (
            chat_id INTEGER PRIMARY KEY,
            waiting INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tribute_product_edit_state (
        chat_id INTEGER PRIMARY KEY,
        waiting INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`).run();
    
    await env.DB.prepare(`
    INSERT OR IGNORE INTO bot_settings (key, value)
    VALUES ('tribute_product_id', '')
`).run();
    
    await env.DB.prepare(`
        INSERT OR IGNORE INTO bot_settings (key, value)
        VALUES ('prep_course_price', '1500')
    `).run();
}


async function getCoursePrice(env) {
    await ensurePaymentSettings(env);

    const row = await env.DB.prepare(`
        SELECT value
        FROM bot_settings
        WHERE key = 'prep_course_price'
        LIMIT 1
    `).first();

    const price = Number(row?.value);

    if (
        !Number.isSafeInteger(price) ||
        price <= 0
    ) {
        return 1500;
    }

    return price;
}


async function setCoursePrice(env, price) {
    await ensurePaymentSettings(env);

    await env.DB.prepare(`
        INSERT INTO bot_settings (
            key,
            value,
            updated_at
        )
        VALUES (
            'prep_course_price',
            ?,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(key)
        DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
    `)
        .bind(String(price))
        .run();
}

async function getTributeProductId(env) {
    await ensurePaymentSettings(env);

    const row = await env.DB.prepare(`
        SELECT value
        FROM bot_settings
        WHERE key = 'tribute_product_id'
        LIMIT 1
    `).first();

    return String(row?.value || "").trim();
}

async function getTributeProduct(env) {
    const productId =
        await getTributeProductId(env);

    if (!productId) {
        throw new Error(
            "Tribute product ID is not configured"
        );
    }

    if (!env.TRIBUTE_API_KEY) {
        throw new Error(
            "TRIBUTE_API_KEY is not configured"
        );
    }

    const response = await fetch(
        `https://tribute.tg/api/v1/products/${encodeURIComponent(productId)}`,
        {
            method: "GET",
            headers: {
                "Api-Key":
                    env.TRIBUTE_API_KEY,
                "Accept":
                    "application/json"
            }
        }
    );

    const product =
        await response.json()
            .catch(() => null);

    if (
        !response.ok ||
        !product?.id
    ) {
        console.error(
            "Tribute product fetch failed:",
            response.status,
            product
        );

        throw new Error(
            "Не удалось получить товар Tribute"
        );
    }

    return product;
}

async function resolveTributeProduct(
    env,
    input
) {
    const value =
        String(input || "").trim();

    if (!env.TRIBUTE_API_KEY) {
        throw new Error(
            "TRIBUTE_API_KEY is not configured"
        );
    }

    // Если администратор ввёл обычный числовой ID.
    if (/^\d+$/.test(value)) {
        const productId =
            Number(value);

        if (
            !Number.isSafeInteger(productId) ||
            productId <= 0
        ) {
            throw new Error(
                "Некорректный ID товара Tribute"
            );
        }

        const response = await fetch(
            `https://tribute.tg/api/v1/products/${productId}`,
            {
                headers: {
                    "Api-Key":
                        env.TRIBUTE_API_KEY,
                    "Accept":
                        "application/json"
                }
            }
        );

        const product =
            await response.json()
                .catch(() => null);

        if (
            !response.ok ||
            !product?.id
        ) {
            throw new Error(
                "Товар Tribute не найден"
            );
        }

        if (product.type !== "digital") {
            throw new Error(
                "Нужен цифровой товар Tribute"
            );
        }

        return product;
    }

    // Если введена ссылка.
    let requestedUrl;

    try {
        requestedUrl =
            new URL(value);
    } catch {
        throw new Error(
            "Укажите ID или ссылку Tribute"
        );
    }

    if (
        requestedUrl.protocol !== "https:" ||
        requestedUrl.hostname !==
            "web.tribute.tg"
    ) {
        throw new Error(
            "Это не ссылка web.tribute.tg"
        );
    }

    const target =
        requestedUrl.href
            .replace(/\/+$/, "");

    let page = 1;

    while (page <= 50) {
        const response = await fetch(
            `https://tribute.tg/api/v1/products?type=digital&page=${page}&size=100&desc=true`,
            {
                headers: {
                    "Api-Key":
                        env.TRIBUTE_API_KEY,
                    "Accept":
                        "application/json"
                }
            }
        );

        const result =
            await response.json()
                .catch(() => null);

        if (
            !response.ok ||
            !Array.isArray(result?.rows)
        ) {
            throw new Error(
                "Не удалось получить товары Tribute"
            );
        }

        const product =
            result.rows.find(
                item => {
                    const webLink =
                        String(
                            item?.webLink || ""
                        )
                            .replace(/\/+$/, "");

                    return (
                        item?.type === "digital" &&
                        webLink === target
                    );
                }
            );

        if (product) {
            return product;
        }

        const total =
            Number(result?.meta?.total || 0);

        if (
            page * 100 >= total ||
            result.rows.length === 0
        ) {
            break;
        }

        page++;
    }

    throw new Error(
        "Цифровой товар по этой ссылке не найден"
    );
}

async function setTributeProductId(
    env,
    productId
) {
    await ensurePaymentSettings(env);

    await env.DB.prepare(`
        INSERT INTO bot_settings (
            key,
            value,
            updated_at
        )
        VALUES (
            'tribute_product_id',
            ?,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(key)
        DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
    `)
        .bind(String(productId).trim())
        .run();
}

async function setPriceEditWaiting(
    env,
    chatId,
    waiting
) {
    await ensurePaymentSettings(env);

    await env.DB.prepare(`
        INSERT INTO price_edit_state (
            chat_id,
            waiting,
            updated_at
        )
        VALUES (?, ?, CURRENT_TIMESTAMP)

        ON CONFLICT(chat_id)
        DO UPDATE SET
            waiting = excluded.waiting,
            updated_at = CURRENT_TIMESTAMP
    `)
        .bind(
            chatId,
            waiting ? 1 : 0
        )
        .run();
}


async function isPriceEditWaiting(
    env,
    chatId
) {
    await ensurePaymentSettings(env);

    const row = await env.DB.prepare(`
        SELECT waiting
        FROM price_edit_state
        WHERE chat_id = ?
        LIMIT 1
    `)
        .bind(chatId)
        .first();

    return row?.waiting === 1;
}

async function setTributeProductEditWaiting(
    env,
    chatId,
    waiting
) {
    await ensurePaymentSettings(env);

    await env.DB.prepare(`
        INSERT INTO tribute_product_edit_state (
            chat_id,
            waiting,
            updated_at
        )
        VALUES (?, ?, CURRENT_TIMESTAMP)

        ON CONFLICT(chat_id)
        DO UPDATE SET
            waiting = excluded.waiting,
            updated_at = CURRENT_TIMESTAMP
    `)
        .bind(
            chatId,
            waiting ? 1 : 0
        )
        .run();
}


async function isTributeProductEditWaiting(
    env,
    chatId
) {
    await ensurePaymentSettings(env);

    const row = await env.DB.prepare(`
        SELECT waiting
        FROM tribute_product_edit_state
        WHERE chat_id = ?
        LIMIT 1
    `)
        .bind(chatId)
        .first();

    return row?.waiting === 1;
}

function formatPrice(price) {
    return String(price)
        .replace(
            /\B(?=(\d{3})+(?!\d))/g,
            " "
        );
}

async function ensurePriceEditState(env) {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS price_edit_state (
            chat_id INTEGER PRIMARY KEY,
            waiting INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
}

async function sendAdminPayments(
    env,
    chatId
) {
    const price = await getCoursePrice(env);
    const formattedPrice = formatPrice(price);
let tributeProductLink = "";

try {
    const configuredProductId =
        await getTributeProductId(env);

    if (configuredProductId) {
        const product =
            await getTributeProduct(env);

        tributeProductLink =
            String(
                product?.webLink ||
                product?.link ||
                ""
            ).trim();
    }
} catch (error) {
    console.error(
        "Tribute product link load failed:",
        error
    );
}
    
    return sendMessage(
        env,
        chatId,
        [
            "💳 <b>Оплата и тарифы</b>",
            "",
            "📚 Подготовительный курс",
            "",
            `💰 Текущая цена: <b>${formattedPrice} ₽</b>`,
            `🔗 Tribute: <code>${escapeHtml(tributeProductLink || "не указана")}</code>`,
            "",
            "Цена используется автоматически",
            "при оформлении заказа учеником."
        ].join("\n"),
        {
            inline_keyboard: [
                [
    {
        text: "💰 Изменить цену",
        callback_data: "admin_price"
    }
],
[
    {
        text: "🔗 Изменить ссылку Tribute",
        callback_data: "admin_tribute_product"
    }
],
                [
                    {
                        text: "📋 История платежей",
                        callback_data:
                            "admin_payment_history"
                    }
                ],
                [
                    {
                        text: "⬅️ Назад",
                        callback_data: "admin"
                    }
                ]
            ]
        }
    );
}

// =========================================================
// ГЛАВНОЕ МЕНЮ
// =========================================================

async function sendWelcome(env, chatId) {
    const access = await getBotAccess(
        env,
        chatId
    );

    const keyboard = [
        [
            {
                text: "📚 Программа курса"
            },
            {
                text: "🛒 Оформить заказ"
            }
        ],
        [
            {
                text: "ℹ️ О школе"
            },
            {
                text: "💬 Поддержка"
            }
        ]
    ];


    if (access.isAdmin) {
        keyboard.push([
            {
                text: "⚙️ Управление"
            }
        ]);
    }


    return sendMessage(
        env,
        chatId,
        [
            "<b>RAUDA ILM</b>",
            "",
            "Онлайн-школа исламских дисциплин.",
            "",
            "Выберите нужный раздел:"
        ].join("\n"),
        {
            keyboard,
            resize_keyboard: true,
            is_persistent: true,
            input_field_placeholder:
                "Выберите раздел..."
        }
    );
}

// =========================================================
// CALLBACK
// =========================================================

async function handleCallback(env, callback, fromMessage = false) {
    const chatId =
        callback?.message?.chat?.id;

    if (!chatId || !isPrivateBotChat(callback.message.chat, callback.from)) {
        return;
    }

    const data =
        String(callback.data || "");

    await ensureBotStates(env);
    if (data !== "admin_courses_create") {
        await clearCourseDraft(env, chatId, callback.message.message_id, !fromMessage);
    }

    const access = await getBotAccess(
        env,
        chatId
    );


    // -----------------------------------------------------
    // АДМИН-ПАНЕЛЬ
    // -----------------------------------------------------

    if (data === "admin") {
        if (!access.isAdmin) {
            return accessDenied(
                env,
                chatId
            );
        }

        return sendAdminMenu(
            env,
            chatId,
            access
        );
    }


    // -----------------------------------------------------
    // КУРСЫ
    // -----------------------------------------------------

    if (data.startsWith("admin_course_")) {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    if (
    data.startsWith(
        "admin_course_semesters_"
    )
) {
    const courseId =
        Number(
            data.slice(
                "admin_course_semesters_".length
            )
        );

    if (
        !Number.isSafeInteger(courseId) ||
        courseId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный курс."
        );
    }

    return sendCourseSemesters(
        env,
        chatId,
        courseId
    );
}
        
    const courseId =
        Number(
            data.slice(
                "admin_course_".length
            )
        );

    if (
        !Number.isSafeInteger(courseId) ||
        courseId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный курс."
        );
    }

    return sendCourseCard(
        env,
        chatId,
        courseId
    );
}
   if (data.startsWith("admin_semester_")) {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    // ---------------------------------------------
    // ПРЕДМЕТЫ СЕМЕСТРА
    // ---------------------------------------------

    if (
        data.startsWith(
            "admin_semester_subjects_"
        )
    ) {
        const semesterId =
            Number(
                data.slice(
                    "admin_semester_subjects_".length
                )
            );

        if (
            !Number.isSafeInteger(semesterId) ||
            semesterId <= 0
        ) {
            return sendMessage(
                env,
                chatId,
                "❌ Некорректный семестр."
            );
        }

        return sendSemesterSubjects(
            env,
            chatId,
            semesterId
        );
    }

    // ---------------------------------------------
    // СТАРЫЙ СПИСОК УРОКОВ
    // Пока оставляем для совместимости.
    // ---------------------------------------------

    if (
        data.startsWith(
            "admin_semester_lessons_"
        )
    ) {
        const semesterId =
            Number(
                data.slice(
                    "admin_semester_lessons_".length
                )
            );

        if (
            !Number.isSafeInteger(semesterId) ||
            semesterId <= 0
        ) {
            return sendMessage(
                env,
                chatId,
                "❌ Некорректный семестр."
            );
        }

        return sendSemesterLessons(
            env,
            chatId,
            semesterId
        );
    }

    // ---------------------------------------------
    // КАРТОЧКА СЕМЕСТРА
    // ---------------------------------------------

    const semesterId =
        Number(
            data.slice(
                "admin_semester_".length
            )
        );

    if (
        !Number.isSafeInteger(semesterId) ||
        semesterId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный семестр."
        );
    }

    return sendSemesterCard(
        env,
        chatId,
        semesterId
    );
}
    if (data.startsWith("admin_subject_")) {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    // Привязку Telegram-канала подключим следующим шагом.
   if (
    data.startsWith(
        "admin_subject_channel_"
    )
) {
    const subjectId =
        Number(
            data.slice(
                "admin_subject_channel_".length
            )
        );

    if (
        !Number.isSafeInteger(subjectId) ||
        subjectId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный предмет."
        );
    }

    const bindCode =
    await setSubjectChannelEditWaiting(
        env,
        chatId,
        subjectId,
        true
    );

return sendMessage(
        env,
        chatId,
        [
    "📢 <b>Привязка Telegram-канала</b>",
    "",
    "1. Добавьте @Rauda_ilmapp_bot",
    "администратором нужного закрытого канала.",
    "",
    "2. Отправьте в этот канал",
    "следующий код отдельным сообщением:",
    "",
    `<code>${escapeHtml(bindCode)}</code>`,
    "",
    "После этого бот автоматически",
    "определит канал и привяжет его",
    "к выбранному предмету.",
    "",
    "Для отмены:",
    "<code>/cancel</code>"
].join("\n")
    );
}

    const subjectId =
        Number(
            data.slice(
                "admin_subject_".length
            )
        );

    if (
        !Number.isSafeInteger(subjectId) ||
        subjectId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный предмет."
        );
    }

    return sendSubjectCard(
        env,
        chatId,
        subjectId
    );
}
    if (data.startsWith("admin_lesson_")) {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    // Материалы урока подключим отдельно.
    if (
        data.startsWith(
            "admin_lesson_files_"
        )
    ) {
        return;
    }

    const lessonId =
        Number(
            data.slice(
                "admin_lesson_".length
            )
        );

    if (
        !Number.isSafeInteger(lessonId) ||
        lessonId <= 0
    ) {
        return sendMessage(
            env,
            chatId,
            "❌ Некорректный урок."
        );
    }

    return sendLessonCard(
        env,
        chatId,
        lessonId
    );
}
    
    if (data === "admin_courses" || data === "admin_courses_create" ||
        data === "admin_courses_list" || data.startsWith("admin_courses_page_")) {
        if (!await requirePermission(env, chatId, "courses")) {
            return;
        }

        if (data === "admin_courses_create") {
            return startCourseCreation(env, chatId, callback.message.message_id);
        }
        if (data === "admin_courses") {
            return sendCoursesMenu(env, chatId);
        }
        const page = data === "admin_courses_list"
            ? 0 : Number(data.slice("admin_courses_page_".length));
        if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) {
            return sendCoursesMenu(env, chatId);
        }
        try {
            return await sendCoursesList(env, chatId, page);
        } catch (error) {
            console.error("Telegram course list failed:", error);
            return sendMessage(env, chatId,
                "❌ Не удалось загрузить курсы. Попробуйте ещё раз.", coursesKeyboard());
        }
    }

    // -----------------------------------------------------
    // УЧЕНИКИ
    // -----------------------------------------------------

    if (data === "admin_students") {
        if (
            !await requirePermission(
                env,
                chatId,
                "students"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "👥 <b>Ученики</b>",
                "",
                "Здесь будет:",
                "",
                "• список учеников",
                "• поиск",
                "• профиль",
                "• доступ",
                "• прогресс",
                "• группы"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // -----------------------------------------------------
    // ГРУППЫ
    // -----------------------------------------------------

    if (data === "admin_groups") {
        if (
            !await requirePermission(
                env,
                chatId,
                "groups"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "👨‍👩‍👧‍👦 <b>Группы</b>",
                "",
                "Здесь будет:",
                "",
                "• создание групп",
                "• список групп",
                "• участники",
                "• добавление учеников",
                "• удаление учеников"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // -----------------------------------------------------
    // ЭКЗАМЕНЫ
    // -----------------------------------------------------

    if (data === "admin_exams") {
        if (
            !await requirePermission(
                env,
                chatId,
                "exams"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "📝 <b>Экзамены</b>",
                "",
                "Здесь будет:",
                "",
                "• экзамены",
                "• вопросы",
                "• результаты",
                "• попытки",
                "• пересдачи"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // -----------------------------------------------------
    // ОПЛАТА
    // -----------------------------------------------------

    if (data === "admin_payments") {
    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        return;
    }

    await setPriceEditWaiting(
        env,
        chatId,
        false
    );

    await setTributeProductEditWaiting(
        env,
        chatId,
        false
    );

    return sendAdminPayments(
        env,
        chatId
    );
}

    if (data === "admin_price") {
        if (
            !await requirePermission(
                env,
                chatId,
                "payments"
            )
        ) {
            return;
        }

         const price = await getCoursePrice(env);

    await setPriceEditWaiting(
        env,
        chatId,
        true
    );

    return sendMessage(
        env,
        chatId,
        [
            "💰 <b>Изменение цены</b>",
            "",
            "Сейчас установлено:",
            `<b>${formatPrice(price)} ₽</b>`,
            "",
            "Отправьте новую цену одним сообщением.",
            "",
            "Например:",
            "<code>2000</code>",
            "",
            "Для отмены:",
            "<code>/cancel</code>"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "⬅️ Отмена",
                        callback_data: "admin_payments"
                    }
                ]
            ]
        }
    );
}

    if (data === "admin_tribute_product") {
    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        return;
    }
        
    await setTributeProductEditWaiting(
        env,
        chatId,
        true
    );

    return sendMessage(
        env,
        chatId,
        [
    "🔗 <b>Ссылка Tribute</b>",
    "",
    "Отправьте ссылку на ваш инфопродукт",
    "из раздела «Инфопродукты и контент».",
    "",
    "Например:",
    "<code>https://web.tribute.tg/p/EUa</code>",
    "",
    "ID товара искать не нужно —",
    "бот определит его автоматически.",
    "",
    "Для отмены:",
    "<code>/cancel</code>"
].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "⬅️ Отмена",
                        callback_data:
                            "admin_payments"
                    }
                ]
            ]
        }
    );
}
    
    if (
    data ===
    "admin_payment_history"
) {
    if (
        !await requirePermission(
            env,
            chatId,
            "payments"
        )
    ) {
        return;
    }

    try {
        const payments =
            await getYooKassaPaymentHistory(
                env,
                10
            );

        if (!payments.length) {
            return sendMessage(
                env,
                chatId,
                [
                    "📋 <b>История платежей</b>",
                    "",
                    "Платежей ЮKassa пока нет."
                ].join("\n"),
                backToAdminKeyboard()
            );
        }

        const statusNames = {
            pending:
                "⏳ Ожидает оплаты",
            paid:
                "✅ Оплачен",
            canceled:
                "❌ Отменён",
            failed:
                "⚠️ Ошибка"
        };

        const lines = [
            "📋 <b>История платежей</b>",
            ""
        ];

        for (
            const payment
            of payments
        ) {
            const name =
                [
                    payment.first_name,
                    payment.last_name
                ]
                    .filter(Boolean)
                    .join(" ") ||
                payment.username ||
                payment.telegram_id;

            lines.push(
                `👤 ${escapeHtml(name)}`,
                `💰 ${formatPrice(payment.amount_rub)} ₽`,
                `📚 ${escapeHtml(payment.course_name || "Курс")}`,
                `📖 Семестр: ${payment.semester_number || "—"}`,
                `📌 ${statusNames[payment.status] || payment.status}`,
                `🕒 ${escapeHtml(payment.created_at || "")}`,
                ""
            );
        }

        return sendMessage(
            env,
            chatId,
            lines.join("\n"),
            backToAdminKeyboard()
        );

    } catch (error) {
        console.error(
            "Payment history error:",
            error
        );

        return sendMessage(
            env,
            chatId,
            "❌ Не удалось загрузить историю платежей.",
            backToAdminKeyboard()
        );
    }
}
    // -----------------------------------------------------
    // СЕРТИФИКАТЫ
    // -----------------------------------------------------

    if (data === "admin_certificates") {
        if (
            !await requirePermission(
                env,
                chatId,
                "certificates"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "📜 <b>Сертификаты</b>",
                "",
                "Здесь будет:",
                "",
                "• шаблоны",
                "• условия выдачи",
                "• выданные сертификаты",
                "• отправка ученикам"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // -----------------------------------------------------
    // СТАТИСТИКА
    // -----------------------------------------------------

    if (data === "admin_stats") {
        if (
            !await requirePermission(
                env,
                chatId,
                "stats"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "📊 <b>Статистика</b>",
                "",
                "Здесь будет статистика:",
                "",
                "• ученики",
                "• курсы",
                "• группы",
                "• оплаты",
                "• результаты"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // -----------------------------------------------------
    // АДМИНИСТРАТОРЫ
    // -----------------------------------------------------

    if (data === "admin_staff") {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        return sendStaffMenu(
            env,
            chatId
        );
    }


    if (data === "admin_staff_add") {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        return sendMessage(
            env,
            chatId,
            [
                "➕ <b>Добавить администратора</b>",
                "",
                "Пользователь сначала должен",
                "открыть бот и отправить /start.",
                "",
                "После этого отправьте:",
                "",
                "<code>/admin_add TELEGRAM_ID</code>",
                "",
                "Например:",
                "<code>/admin_add 123456789</code>",
                "",
                "Новый администратор будет",
                "создан без выданных прав."
            ].join("\n"),
            backToStaffKeyboard()
        );
    }


    if (data === "admin_staff_remove") {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        return sendMessage(
            env,
            chatId,
            [
                "➖ <b>Снять администратора</b>",
                "",
                "Отправьте:",
                "",
                "<code>/admin_remove TELEGRAM_ID</code>",
                "",
                "Например:",
                "<code>/admin_remove 123456789</code>"
            ].join("\n"),
            backToStaffKeyboard()
        );
    }


    if (data === "admin_staff_list") {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        return sendAdministratorsList(
            env,
            chatId
        );
    }


    if (data === "admin_staff_permissions") {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        return sendAdminPermissionList(
            env,
            chatId
        );
    }


    // -----------------------------------------------------
    // ВЫБОР АДМИНИСТРАТОРА
    // -----------------------------------------------------

    if (
        data.startsWith(
            "admin_perm_user_"
        )
    ) {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        const telegramId =
            data.substring(
                "admin_perm_user_".length
            );

        return sendPermissionEditor(
            env,
            chatId,
            telegramId
        );
    }


    // -----------------------------------------------------
    // ПЕРЕКЛЮЧЕНИЕ ОДНОГО ПРАВА
    // -----------------------------------------------------

    if (
        data.startsWith(
            "admin_perm_toggle_"
        )
    ) {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        const rest =
            data.substring(
                "admin_perm_toggle_".length
            );

        const separator =
            rest.lastIndexOf("_");

        if (separator === -1) {
            return;
        }

        const telegramId =
            rest.substring(
                0,
                separator
            );

        const permission =
            rest.substring(
                separator + 1
            );

        try {
            await togglePermission(
                env,
                telegramId,
                permission
            );

            return sendPermissionEditor(
                env,
                chatId,
                telegramId
            );
        } catch (error) {
            return sendMessage(
                env,
                chatId,
                `❌ ${escapeHtml(error.message)}`
            );
        }
    }


    // -----------------------------------------------------
    // ВСЕ ПРАВА
    // -----------------------------------------------------

    if (
        data.startsWith(
            "admin_perm_all_"
        )
    ) {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        const telegramId =
            data.substring(
                "admin_perm_all_".length
            );

        try {
            await grantAllPermissions(
                env,
                telegramId
            );

            return sendPermissionEditor(
                env,
                chatId,
                telegramId
            );
        } catch (error) {
            return sendMessage(
                env,
                chatId,
                `❌ ${escapeHtml(error.message)}`
            );
        }
    }


    // -----------------------------------------------------
    // УБРАТЬ ВСЕ ПРАВА
    // -----------------------------------------------------

    if (
        data.startsWith(
            "admin_perm_none_"
        )
    ) {
        if (!access.isOwner) {
            return ownerOnly(
                env,
                chatId
            );
        }

        const telegramId =
            data.substring(
                "admin_perm_none_".length
            );

        try {
            await revokeAllPermissions(
                env,
                telegramId
            );

            return sendPermissionEditor(
                env,
                chatId,
                telegramId
            );
        } catch (error) {
            return sendMessage(
                env,
                chatId,
                `❌ ${escapeHtml(error.message)}`
            );
        }
    }


    // -----------------------------------------------------
    // ПУБЛИЧНЫЕ РАЗДЕЛЫ
    // -----------------------------------------------------

    if (data === "program") {
        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Подготовительный курс RAUDA ILM</b>",
                "",
                "Программа состоит из",
                "последовательных учебных",
                "материалов и уроков."
            ].join("\n")
        );
    }


    if (data === "order") {
        const price = await getCoursePrice(env);
    const formattedPrice = formatPrice(price);
        return sendMessage(
            env,
            chatId,
            [
                "🛒 <b>Подготовительный курс RAUDA ILM</b>",
            "",
            "📚 Доступ к образовательной программе,",
            "учебным материалам и урокам.",
            "",
            `💳 Стоимость: <b>${formattedPrice} ₽</b>`,
            "",
            "После успешной оплаты",
            "открывается доступ к программе."
            ].join("\n"),
 {
            inline_keyboard: [
                [
                    {
                        text: `💳 Оплатить ${formattedPrice} ₽`,
                        callback_data: "order_pay"
                    }
                ],
                [
                    {
                        text: "📚 Подробнее о программе",
                        callback_data: "program"
                    }
                ]
            ]
        }
    );
}

if (data === "order_pay") {
    const price =
        await getCoursePrice(env);

    return sendMessage(
        env,
        chatId,
        [
            "💳 <b>Выберите способ оплаты</b>",
            "",
            "📚 Подготовительный курс RAUDA ILM",
            `💰 Сумма: <b>${formatPrice(price)} ₽</b>`,
            "",
            "Выберите удобный способ оплаты:"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "🇷🇺 ЮKassa",
                        callback_data:
                            "order_pay_yookassa"
                    }
                ],
                [
                    {
                        text: "💎 Tribute",
                        callback_data:
                            "order_pay_tribute"
                    }
                ],
                [
                    {
                        text: "⬅️ Вернуться к заказу",
                        callback_data:
                            "order"
                    }
                ]
            ]
        }
    );
}

    if (data === "order_pay_yookassa") {
    const price =
        await getCoursePrice(env);

    if (
        !isYooKassaConfigured(env)
    ) {
        return sendMessage(
            env,
            chatId,
            [
                "🇷🇺 <b>ЮKassa</b>",
                "",
                "📚 Подготовительный курс RAUDA ILM",
                `💰 Сумма: <b>${formatPrice(price)} ₽</b>`,
                "",
                "ЮKassa пока не подключена.",
                "",
                "После подключения магазина",
                "здесь появится кнопка безопасной оплаты."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "💎 Оплатить через Tribute",
                            callback_data:
                                "order_pay_tribute"
                        }
                    ],
                    [
                        {
                            text: "⬅️ Назад к способам оплаты",
                            callback_data:
                                "order_pay"
                        }
                    ]
                ]
            }
        );
    }

    try {
        const payment =
            await createYooKassaPayment(
                env,
                chatId
            );

        return sendMessage(
            env,
            chatId,
            [
                "🇷🇺 <b>Оплата через ЮKassa</b>",
                "",
                "📚 Подготовительный курс RAUDA ILM",
                "",
                `💰 Сумма: <b>${formatPrice(payment.amount)} ₽</b>`,
                "",
                "Нажмите кнопку ниже.",
                "",
                "После успешной оплаты",
                "доступ будет выдан автоматически."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text:
                                `💳 Оплатить ${formatPrice(payment.amount)} ₽`,
                            url:
                                payment.confirmationUrl
                        }
                    ],
                    [
                        {
                            text: "⬅️ Назад к способам оплаты",
                            callback_data:
                                "order_pay"
                        }
                    ]
                ]
            }
        );
    } catch (error) {
        console.error(
            "YooKassa order error:",
            error
        );

        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Не удалось создать платёж через ЮKassa</b>",
                "",
                "Попробуйте ещё раз позже."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "💎 Попробовать Tribute",
                            callback_data:
                                "order_pay_tribute"
                        }
                    ],
                    [
                        {
                            text: "⬅️ Назад",
                            callback_data:
                                "order_pay"
                        }
                    ]
                ]
            }
        );
    }
}
    if (data === "order_pay_tribute") {
    try {
        const product =
            await getTributeProduct(env);

        const paymentUrl =
            product?.link ||
            product?.webLink ||
            "";

        if (!paymentUrl) {
            throw new Error(
                "Tribute product link is missing"
            );
        }

        const tributeAmount =
    Number(product?.amount);

const tributeCurrency =
    String(
        product?.currency || ""
    ).toUpperCase();

const tributePrice =
    Number.isFinite(tributeAmount)
        ? tributeAmount / 100
        : null;

const tributePriceText =
    tributePrice !== null
        ? `${tributePrice.toLocaleString(
              "ru-RU",
              {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 2
              }
          )} ${tributeCurrency}`
        : "указана в Tribute";

        return sendMessage(
            env,
            chatId,
            [
                "💎 <b>Оплата через Tribute</b>",
                "",
                "📚 Подготовительный курс RAUDA ILM",
                "",
                `💰 Стоимость в Tribute: <b>${tributePriceText}</b>`,
                "",
                "Нажмите кнопку ниже для оплаты.",
                "",
                "После успешной оплаты",
                "доступ будет выдан автоматически."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "💎 Перейти к оплате Tribute",
                            url: paymentUrl
                        }
                    ],
                    [
                        {
                            text: "🇷🇺 Оплатить через ЮKassa",
                            callback_data:
                                "order_pay_yookassa"
                        }
                    ],
                    [
                        {
                            text: "⬅️ Назад к способам оплаты",
                            callback_data:
                                "order_pay"
                        }
                    ]
                ]
            }
        );
    } catch (error) {
        console.error(
            "Tribute product error:",
            error
        );

        return sendMessage(
            env,
            chatId,
            [
                "❌ <b>Tribute пока недоступен</b>",
                "",
                "Товар Tribute не настроен",
                "или произошла ошибка подключения.",
                "",
                "Администратор может изменить",
"ссылку Tribute в разделе оплаты."
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "🇷🇺 Попробовать ЮKassa",
                            callback_data:
                                "order_pay_yookassa"
                        }
                    ],
                    [
                        {
                            text: "⬅️ Назад",
                            callback_data:
                                "order_pay"
                        }
                    ]
                ]
            }
        );
    }
}
    if (data === "about") {
        return sendMessage(
            env,
            chatId,
            [
                "<b>RAUDA ILM</b>",
                "",
                "Онлайн-школа с обучением",
                "через Telegram и веб-платформу.",
                "",
                "Telegram и сайт используют",
                "общую систему данных."
            ].join("\n")
        );
    }


  if (data === "support") {
    await env.DB.prepare(`
        INSERT INTO support_state (user_id, waiting)
        VALUES (?, 1)
        ON CONFLICT(user_id)
        DO UPDATE SET waiting = 1
    `)
        .bind(String(chatId))
        .run();

    await sendMessage(
        env,
        chatId,
        `💬 <b>Поддержка RAUDA ILM</b>

Напишите ваше сообщение.

Вы можете отправить текст, фотографию, видео, документ или голосовое сообщение.`
    );

    return;
}
}


// =========================================================
// АДМИН-МЕНЮ
// =========================================================

async function sendAdminMenu(
    env,
    chatId,
    access
) {
    const buttons = [];


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "courses"
        )
    ) {
        buttons.push("📚 Курсы");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "students"
        )
    ) {
        buttons.push("👥 Ученики");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "groups"
        )
    ) {
        buttons.push("👨‍👩‍👧‍👦 Группы");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "exams"
        )
    ) {
        buttons.push("📝 Экзамены");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "payments"
        )
    ) {
        buttons.push("💳 Оплата");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "certificates"
        )
    ) {
        buttons.push("📜 Сертификаты");
    }


    if (
        access.isOwner ||
        await hasPermission(
            env,
            chatId,
            "stats"
        )
    ) {
        buttons.push("📊 Статистика");
    }


    if (access.isOwner) {
        buttons.push(
            "👮 Администраторы"
        );
    }


    if (
        !access.isOwner &&
        buttons.length === 0
    ) {
        return sendMessage(
            env,
            chatId,
            [
                "⚙️ <b>Управление RAUDA ILM</b>",
                "",
                "👮 Роль: Администратор",
                "",
                "🔒 Вам пока не назначены",
                "права управления."
            ].join("\n"),
            {
                keyboard: [
                    [
                        {
                            text: "⬅️ Главное меню"
                        }
                    ]
                ],
                resize_keyboard: true,
                is_persistent: true
            }
        );
    }


    const keyboard = [];

    for (
        let i = 0;
        i < buttons.length;
        i += 2
    ) {
        keyboard.push(
            buttons
                .slice(i, i + 2)
                .map(text => ({
                    text
                }))
        );
    }


    keyboard.push([
        {
            text: "⬅️ Главное меню"
        }
    ]);


    return sendMessage(
        env,
        chatId,
        [
            "⚙️ <b>Управление RAUDA ILM</b>",
            "",
            access.isOwner
                ? "👑 Роль: Владелец"
                : "👮 Роль: Администратор",
            "",
            "Выберите раздел:"
        ].join("\n"),
        {
            keyboard,
            resize_keyboard: true,
            is_persistent: true,
            input_field_placeholder:
                "Выберите раздел..."
        }
    );
}

// =========================================================
// МЕНЮ АДМИНИСТРАТОРОВ
// =========================================================

async function sendStaffMenu(
    env,
    chatId
) {
    return sendMessage(
        env,
        chatId,
        [
            "👮 <b>Администраторы</b>",
            "",
            "Управление командой RAUDA ILM."
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    {
                        text: "➕ Добавить администратора",
                        callback_data:
                            "admin_staff_add"
                    }
                ],
                [
                    {
                        text: "🔐 Настроить права",
                        callback_data:
                            "admin_staff_permissions"
                    }
                ],
                [
                    {
                        text: "👥 Список администраторов",
                        callback_data:
                            "admin_staff_list"
                    }
                ],
                [
                    {
                        text: "➖ Снять администратора",
                        callback_data:
                            "admin_staff_remove"
                    }
                ],
                [
                    {
                        text: "⬅️ Назад",
                        callback_data: "admin"
                    }
                ]
            ]
        }
    );
}


// =========================================================
// ВЫБОР АДМИНА ДЛЯ ПРАВ
// =========================================================

async function sendAdminPermissionList(
    env,
    chatId
) {
    const admins =
        await getAdmins(env);

    const editable =
        admins.filter(
            admin =>
                admin.role !== "owner"
        );

    if (!editable.length) {
        return sendMessage(
            env,
            chatId,
            [
                "🔐 <b>Права администраторов</b>",
                "",
                "Пока нет назначенных",
                "администраторов."
            ].join("\n"),
            backToStaffKeyboard()
        );
    }

    const keyboard =
        editable.map(admin => {
            const name =
                admin.first_name ||
                admin.username ||
                String(admin.telegram_id);

            return [
                {
                    text: `👮 ${name}`,
                    callback_data:
                        `admin_perm_user_${admin.telegram_id}`
                }
            ];
        });

    keyboard.push([
        {
            text: "⬅️ Назад",
            callback_data: "admin_staff"
        }
    ]);

    return sendMessage(
        env,
        chatId,
        [
            "🔐 <b>Права администраторов</b>",
            "",
            "Выберите администратора:"
        ].join("\n"),
        {
            inline_keyboard: keyboard
        }
    );
}


// =========================================================
// РЕДАКТОР ПРАВ
// =========================================================

async function sendPermissionEditor(
    env,
    chatId,
    telegramId
) {
    const admins =
        await getAdmins(env);

    const admin =
        admins.find(
            item =>
                String(item.telegram_id) ===
                String(telegramId)
        );

    if (!admin) {
        return sendMessage(
            env,
            chatId,
            "❌ Администратор не найден.",
            backToStaffKeyboard()
        );
    }

    if (admin.role === "owner") {
        return sendMessage(
            env,
            chatId,
            "🔒 Права владельца нельзя ограничить.",
            backToStaffKeyboard()
        );
    }

    const permissions =
        await getAdminPermissions(
            env,
            telegramId
        );

    const enabled = permission =>
        permissions.includes(permission);

    const button = (
        permission,
        title
    ) => ({
        text:
            `${enabled(permission) ? "✅" : "❌"} ${title}`,
        callback_data:
            `admin_perm_toggle_${telegramId}_${permission}`
    });

    const name =
        admin.first_name ||
        admin.username ||
        telegramId;

    return sendMessage(
        env,
        chatId,
        [
            "🔐 <b>Настройка прав</b>",
            "",
            `👤 ${escapeHtml(name)}`,
            `🆔 <code>${escapeHtml(telegramId)}</code>`,
            "",
            "✅ — доступ разрешён",
            "❌ — доступ запрещён"
        ].join("\n"),
        {
            inline_keyboard: [
                [
                    button(
                        "courses",
                        "Курсы"
                    )
                ],
                [
                    button(
                        "students",
                        "Ученики"
                    )
                ],
                [
                    button(
                        "groups",
                        "Группы"
                    )
                ],
                [
                    button(
                        "exams",
                        "Экзамены"
                    )
                ],
                [
                    button(
                        "payments",
                        "Оплата"
                    )
                ],
                [
                    button(
                        "certificates",
                        "Сертификаты"
                    )
                ],
                [
                    button(
                        "stats",
                        "Статистика"
                    )
                ],
                [
                    {
                        text: "✅ Выдать все права",
                        callback_data:
                            `admin_perm_all_${telegramId}`
                    }
                ],
                [
                    {
                        text: "❌ Убрать все права",
                        callback_data:
                            `admin_perm_none_${telegramId}`
                    }
                ],
                [
                    {
                        text: "⬅️ Назад",
                        callback_data:
                            "admin_staff_permissions"
                    }
                ]
            ]
        }
    );
}


// =========================================================
// ДОБАВИТЬ АДМИНИСТРАТОРА
// =========================================================

async function addAdministrator(
    env,
    chatId,
    text
) {
    const access =
        await getBotAccess(
            env,
            chatId
        );

    if (!access.isOwner) {
        return ownerOnly(
            env,
            chatId
        );
    }

    const telegramId =
        text.split(/\s+/)[1]?.trim();

    if (
        !telegramId ||
        !/^\d+$/.test(telegramId)
    ) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ Неверный Telegram ID.",
                "",
                "Используйте:",
                "<code>/admin_add 123456789</code>"
            ].join("\n")
        );
    }

    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        return sendMessage(
            env,
            chatId,
            "👑 Это владелец RAUDA ILM."
        );
    }

    const user = await env.DB
        .prepare(`
            SELECT
                id,
                telegram_id,
                username,
                first_name,
                last_name,
                role
            FROM users
            WHERE telegram_id = ?
            LIMIT 1
        `)
        .bind(telegramId)
        .first();

    if (!user) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ Пользователь не найден.",
                "",
                "Он должен сначала открыть",
                "бота и отправить /start."
            ].join("\n")
        );
    }

    await setUserRole(
        env,
        telegramId,
        "admin"
    );

    await revokeAllPermissions(
        env,
        telegramId
    );

    const name =
        user.first_name ||
        user.username ||
        telegramId;

    return sendMessage(
        env,
        chatId,
        [
            "✅ <b>Администратор добавлен</b>",
            "",
            `👤 ${escapeHtml(name)}`,
            `🆔 <code>${escapeHtml(telegramId)}</code>`,
            "",
            "🔐 Права пока не выданы.",
            "",
            "Откройте:",
            "Администраторы → Настроить права."
        ].join("\n"),
        backToStaffKeyboard()
    );
}


// =========================================================
// СНЯТЬ АДМИНИСТРАТОРА
// =========================================================

async function removeAdministrator(
    env,
    chatId,
    text
) {
    const access =
        await getBotAccess(
            env,
            chatId
        );

    if (!access.isOwner) {
        return ownerOnly(
            env,
            chatId
        );
    }

    const telegramId =
        text.split(/\s+/)[1]?.trim();

    if (
        !telegramId ||
        !/^\d+$/.test(telegramId)
    ) {
        return sendMessage(
            env,
            chatId,
            [
                "❌ Неверный Telegram ID.",
                "",
                "Используйте:",
                "<code>/admin_remove 123456789</code>"
            ].join("\n")
        );
    }

    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        return sendMessage(
            env,
            chatId,
            "🔒 Владельца удалить невозможно."
        );
    }

    const user = await env.DB
        .prepare(`
            SELECT id, role
            FROM users
            WHERE telegram_id = ?
            LIMIT 1
        `)
        .bind(telegramId)
        .first();

    if (!user) {
        return sendMessage(
            env,
            chatId,
            "❌ Пользователь не найден."
        );
    }

    if (
        user.role !== "admin" &&
        user.role !== "superadmin"
    ) {
        return sendMessage(
            env,
            chatId,
            "ℹ️ Пользователь не является администратором."
        );
    }

    await setUserRole(
        env,
        telegramId,
        "student"
    );

    return sendMessage(
        env,
        chatId,
        [
            "✅ <b>Администратор снят</b>",
            "",
            `🆔 <code>${escapeHtml(telegramId)}</code>`,
            "",
            "Все административные права",
            "также удалены."
        ].join("\n"),
        backToStaffKeyboard()
    );
}


// =========================================================
// СПИСОК АДМИНИСТРАТОРОВ
// =========================================================

async function sendAdministratorsList(
    env,
    chatId
) {
    const admins =
        await getAdmins(env);

    if (!admins.length) {
        return sendMessage(
            env,
            chatId,
            "👥 Список пуст.",
            backToStaffKeyboard()
        );
    }

    const lines = [
        "👥 <b>Администраторы RAUDA ILM</b>",
        ""
    ];

    for (const admin of admins) {
        const name =
            admin.first_name ||
            admin.username ||
            "Без имени";

        let role =
            "👮 Администратор";

        if (admin.role === "owner") {
            role =
                "👑 Владелец";
        }

        if (
            admin.role ===
            "superadmin"
        ) {
            role =
                "🛡 Старший администратор";
        }

        lines.push(
            role,
            `👤 ${escapeHtml(name)}`,
            `🆔 <code>${escapeHtml(
                String(admin.telegram_id)
            )}</code>`,
            ""
        );
    }

    return sendMessage(
        env,
        chatId,
        lines.join("\n"),
        backToStaffKeyboard()
    );
}


// =========================================================
// ПРОВЕРКА ПРАВ
// =========================================================

async function requirePermission(
    env,
    chatId,
    permission
) {
    const access =
        await getBotAccess(
            env,
            chatId
        );

    if (access.isOwner) {
        return true;
    }

    if (!access.isAdmin) {
        await accessDenied(
            env,
            chatId
        );

        return false;
    }

    const allowed =
        await hasPermission(
            env,
            chatId,
            permission
        );

    if (!allowed) {
        await sendMessage(
            env,
            chatId,
            [
                "🔒 <b>Нет доступа</b>",
                "",
                "Владелец RAUDA ILM",
                "не выдал вам право",
                "на этот раздел."
            ].join("\n")
        );

        return false;
    }

    return true;
}


// =========================================================
// КЛАВИАТУРЫ
// =========================================================

function backToAdminKeyboard() {
    return {
        inline_keyboard: [
            [
                {
                    text: "⬅️ Назад",
                    callback_data: "admin"
                }
            ]
        ]
    };
}


function backToStaffKeyboard() {
    return {
        inline_keyboard: [
            [
                {
                    text: "⬅️ Назад",
                    callback_data:
                        "admin_staff"
                }
            ]
        ]
    };
}


// =========================================================
// ОШИБКИ ДОСТУПА
// =========================================================

async function accessDenied(
    env,
    chatId
) {
    return sendMessage(
        env,
        chatId,
        "⛔ У вас нет доступа к управлению."
    );
}


async function ownerOnly(
    env,
    chatId
) {
    return sendMessage(
        env,
        chatId,
        [
            "🔒 <b>Только для владельца</b>",
            "",
            "Эту настройку может изменять",
            "только владелец RAUDA ILM."
        ].join("\n")
    );
}


// =========================================================
// TELEGRAM API
// =========================================================

async function sendMessage(
    env,
    chatId,
    text,
    replyMarkup = null
) {
    const payload = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
    };

    if (replyMarkup) {
        payload.reply_markup =
            replyMarkup;
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body:
                JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        console.error(
            "Telegram sendMessage failed:",
            response.status,
            await response.text()
        );
    }

    return response;
}

async function sendProtectedMessage(
    env,
    chatId,
    text,
    replyMarkup = null
) {
    const payload = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        protect_content: true
    };

    if (replyMarkup) {
        payload.reply_markup =
            replyMarkup;
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body:
                JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        console.error(
            "Telegram protected sendMessage failed:",
            response.status,
            await response.text()
        );
    }

    return response;
}

async function copyMessage(env, chatId, fromChatId, messageId) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/copyMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId
      })
    }
  );

  return await response.json();
}

async function copyProtectedMessage(
    env,
    chatId,
    fromChatId,
    messageId
) {
    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/copyMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body: JSON.stringify({
                chat_id: chatId,
                from_chat_id: fromChatId,
                message_id: messageId,
                protect_content: true
            })
        }
    );

    const result =
        await response.json();

    if (!response.ok) {
        console.error(
            "Telegram protected copyMessage failed:",
            response.status,
            result
        );
    }

    return result;
}

async function sendProtectedDocument(
    env,
    chatId,
    document,
    caption = ""
) {
    const payload = {
        chat_id: chatId,
        document,
        protect_content: true
    };

    if (caption) {
        payload.caption = caption;
        payload.parse_mode = "HTML";
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body:
                JSON.stringify(payload)
        }
    );

    const result =
        await response.json();

    if (!response.ok) {
        console.error(
            "Telegram protected sendDocument failed:",
            response.status,
            result
        );
    }

    return result;
}

async function sendProtectedMedia(
    env,
    chatId,
    type,
    media,
    caption = ""
) {
    const methods = {
        photo: {
            method: "sendPhoto",
            field: "photo"
        },
        video: {
            method: "sendVideo",
            field: "video"
        },
        audio: {
            method: "sendAudio",
            field: "audio"
        }
    };

    const config = methods[type];

    if (!config) {
        throw new Error(
            `Unsupported protected media type: ${type}`
        );
    }

    const payload = {
        chat_id: chatId,
        [config.field]: media,
        protect_content: true
    };

    if (caption) {
        payload.caption = caption;
        payload.parse_mode = "HTML";
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${config.method}`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body:
                JSON.stringify(payload)
        }
    );

    const result =
        await response.json();

    if (!response.ok) {
        console.error(
            `Telegram protected ${config.method} failed:`,
            response.status,
            result
        );
    }

    return result;
}

function formatUserName(user) {
  const name = [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ");

  if (user.username) {
    return `${name || "Пользователь"} (@${user.username})`;
  }

  return name || "Пользователь";
}


async function answerCallback(
    env,
    callbackQueryId
) {
    if (!callbackQueryId) {
        return;
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json"
            },
            body:
                JSON.stringify({
                    callback_query_id:
                        callbackQueryId
                })
        }
    );

    if (!response.ok) {
        console.error(
            "Telegram answerCallbackQuery failed:",
            response.status,
            await response.text()
        );
    }
}


// =========================================================
// ВСПОМОГАТЕЛЬНЫЕ
// =========================================================

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}


function ok() {
    return new Response(
        "OK",
        { status: 200 }
    );
}

function constantTimeEqual(first, second) {
    const a = new TextEncoder().encode(String(first));
    const b = new TextEncoder().encode(String(second));

    if (a.length !== b.length) {
        return false;
    }

    let difference = 0;

    for (let index = 0; index < a.length; index++) {
        difference |= a[index] ^ b[index];
    }

    return difference === 0;
}

function isValidTelegramWebhookSecret(request, env) {
    const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();

    if (!expected) {
        return false;
    }

    const supplied = String(
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") || ""
    );

    return constantTimeEqual(supplied, expected);
}

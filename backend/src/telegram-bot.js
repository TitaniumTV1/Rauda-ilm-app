// trigger deploy
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

    let update;

    try {
        update = await request.json();
    } catch {
        return new Response(
            "Bad Request",
            { status: 400 }
        );
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


// =========================================================
// СООБЩЕНИЯ
// =========================================================

async function handleMessage(env, message) {
    const chatId = message.chat.id;

    const text = String(
        message.text || ""
    ).trim();

await env.DB
    .prepare(`
        CREATE TABLE IF NOT EXISTS bot_states (
            chat_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        )
    `)
    .run();

const botState = await env.DB
    .prepare(`
        SELECT state
        FROM bot_states
        WHERE chat_id = ?
        LIMIT 1
    `)
    .bind(chatId)
    .first();


if (botState?.state === "create_course_name") {

    if (text === "❌ Отмена") {
        await env.DB
            .prepare(`
                DELETE FROM bot_states
                WHERE chat_id = ?
            `)
            .bind(chatId)
            .run();

        return sendMessage(
            env,
            chatId,
            "❌ Создание курса отменено.",
            {
                keyboard: [
                    [
                        {
                            text: "➕ Создать курс"
                        },
                        {
                            text: "📚 Список курсов"
                        }
                    ],
                    [
                        {
                            text: "⬅️ Админ-панель"
                        }
                    ]
                ],
                resize_keyboard: true,
                is_persistent: true
            }
        );
    }


    if (text.length < 2) {
        return sendMessage(
            env,
            chatId,
            "❌ Название курса слишком короткое.\n\nВведите другое название:"
        );
    }


    if (text.length > 100) {
        return sendMessage(
            env,
            chatId,
            "❌ Название курса слишком длинное.\n\nВведите название короче:"
        );
    }


    await env.DB
        .prepare(`
            INSERT INTO courses (
                name,
                is_active
            )
            VALUES (?, 1)
        `)
        .bind(text)
        .run();


    await env.DB
        .prepare(`
            DELETE FROM bot_states
            WHERE chat_id = ?
        `)
        .bind(chatId)
        .run();


    return sendMessage(
        env,
        chatId,
        [
            "✅ <b>Курс создан</b>",
            "",
            `📚 ${escapeHtml(text)}`
        ].join("\n"),
        {
            keyboard: [
                [
                    {
                        text: "➕ Создать курс"
                    },
                    {
                        text: "📚 Список курсов"
                    }
                ],
                [
                    {
                        text: "⬅️ Админ-панель"
                    }
                ]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    );
}
    
    // -----------------------------------------------------
    // НИЖНЯЯ НАВИГАЦИЯ
    // -----------------------------------------------------

    const menuCallbacks = {
        "📚 Программа курса": "program",
        "🛒 Оформить заказ": "order",
        "ℹ️ О школе": "about",
        "💬 Поддержка": "support",

        "⚙️ Управление": "admin",

        "📚 Курсы": "admin_courses",
        "👥 Ученики": "admin_students",
        "👨‍👩‍👧‍👦 Группы": "admin_groups",
        "📝 Экзамены": "admin_exams",
        "💳 Оплата": "admin_payments",
        "📜 Сертификаты": "admin_certificates",
        "📊 Статистика": "admin_stats",
        "👮 Администраторы": "admin_staff"
    };


    if (menuCallbacks[text]) {
        return handleCallback(
            env,
            {
                message: {
                    chat: {
                        id: chatId
                    }
                },
                data: menuCallbacks[text]
            }
        );
    }


    if (text === "⬅️ Главное меню") {
        return sendWelcome(
            env,
            chatId
        );
    }


    if (text === "⬅️ Админ-панель") {
        const access = await getBotAccess(
            env,
            chatId
        );

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

   if (text === "➕ Создать курс") {
    await env.DB
        .prepare(`
            CREATE TABLE IF NOT EXISTS bot_states (
                chat_id INTEGER PRIMARY KEY,
                state TEXT NOT NULL,
                updated_at TEXT NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
            )
        `)
        .run();

    await env.DB
        .prepare(`
            INSERT INTO bot_states (
                chat_id,
                state,
                updated_at
            )
            VALUES (?, ?, CURRENT_TIMESTAMP)

            ON CONFLICT(chat_id)
            DO UPDATE SET
                state = excluded.state,
                updated_at = CURRENT_TIMESTAMP
        `)
        .bind(
            chatId,
            "create_course_name"
        )
        .run();

    return sendMessage(
        env,
        chatId,
        [
            "➕ <b>Создание курса</b>",
            "",
            "Отправьте название курса.",
            "",
            "Например:",
            "<i>Подготовительный курс</i>"
        ].join("\n"),
        {
            keyboard: [
                [
                    {
                        text: "❌ Отмена"
                    }
                ]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    );
}

if (text === "📚 Список курсов") {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    const result = await env.DB
        .prepare(`
            SELECT
                id,
                name,
                is_active
            FROM courses
            ORDER BY id DESC
        `)
        .all();

    const courses =
        result?.results || [];

    if (!courses.length) {
        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Список курсов</b>",
                "",
                "Курсов пока нет."
            ].join("\n")
        );
    }

    const lines = [
        "📚 <b>Список курсов</b>",
        ""
    ];

    for (const course of courses) {
        lines.push(
            `• ${escapeHtml(course.name)}`
        );
    }

    return sendMessage(
        env,
        chatId,
        lines.join("\n")
    );
}
    
    // -----------------------------------------------------
    // КОМАНДЫ
    // -----------------------------------------------------

    if (text.startsWith("/admin_add ")) {
        return addAdministrator(
            env,
            chatId,
            text
        );
    }


    if (text.startsWith("/admin_remove ")) {
        return removeAdministrator(
            env,
            chatId,
            text
        );
    }


    return sendWelcome(
        env,
        chatId
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

async function handleCallback(env, callback) {
    const chatId =
        callback?.message?.chat?.id;

    if (!chatId) {
        return;
    }

    const data =
        String(callback.data || "");

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

    if (data === "admin_courses") {
    if (
        !await requirePermission(
            env,
            chatId,
            "courses"
        )
    ) {
        return;
    }

    return sendMessage(
    env,
    chatId,
    [
        "📚 <b>Управление курсами</b>",
        "",
        "Выберите действие:"
    ].join("\n"),
    {
        keyboard: [
            [
                {
                    text: "➕ Создать курс"
                },
                {
                    text: "📚 Список курсов"
                }
            ],
            [
                {
                    text: "⬅️ Админ-панель"
                }
            ]
        ],
        resize_keyboard: true,
        is_persistent: true
    }
);
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

        return sendMessage(
            env,
            chatId,
            [
                "💳 <b>Оплата и тарифы</b>",
                "",
                "📚 Подготовительный курс",
                "",
                "💰 Текущая цена: <b>1 500 ₽</b>",
                "",
                "Цена пока временно указана",
                "непосредственно в боте."
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

        return sendMessage(
            env,
            chatId,
            [
                "💰 <b>Изменение цены</b>",
                "",
                "Сейчас установлено:",
                "<b>1 500 ₽</b>",
                "",
                "Редактирование цены через D1",
                "подключим следующим этапом."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    if (data === "admin_payment_history") {
        if (
            !await requirePermission(
                env,
                chatId,
                "payments"
            )
        ) {
            return;
        }

        return sendMessage(
            env,
            chatId,
            [
                "📋 <b>История платежей</b>",
                "",
                "Здесь будут отображаться",
                "платежи YooKassa и Tribute."
            ].join("\n"),
            backToAdminKeyboard()
        );
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
        return sendMessage(
            env,
            chatId,
            [
                "🛒 <b>Подготовительный курс</b>",
                "",
                "💳 Стоимость: <b>1 500 ₽</b>",
                "",
                "Оплата через ЮKassa",
                "находится на этапе подключения."
            ].join("\n")
        );
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
        return sendMessage(
            env,
            chatId,
            [
                "💬 <b>Поддержка RAUDA ILM</b>",
                "",
                "Обратную связь подключим",
                "отдельным этапом.",
                "",
                "Она сможет поддерживать",
                "текст, голосовые сообщения",
                "и другие файлы."
            ].join("\n")
        );
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

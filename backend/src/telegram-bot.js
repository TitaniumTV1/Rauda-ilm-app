import {
    syncTelegramUser,
    getBotAccess,
    getAdmins,
    setUserRole
} from "./bot-access.js";

const TELEGRAM_API = "https://api.telegram.org";

export async function handleTelegramWebhook(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("Telegram bot is not configured", {
            status: 503
        });
    }

    let update;

    try {
        update = await request.json();
    } catch {
        return new Response("Bad Request", {
            status: 400
        });
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
    const text = String(message.text || "").trim();

    /*
     * Добавление администратора.
     *
     * Владелец отправляет:
     *
     * /admin_add 123456789
     *
     * Пользователь должен хотя бы один раз
     * открыть бота и отправить /start.
     */

    if (text.startsWith("/admin_add ")) {
        return addAdministrator(
            env,
            chatId,
            text
        );
    }

    /*
     * Снятие администратора:
     *
     * /admin_remove 123456789
     */

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
                text: "📚 Программа курса",
                callback_data: "program"
            }
        ],
        [
            {
                text: "🛒 Оформить заказ",
                callback_data: "order"
            }
        ],
        [
            {
                text: "ℹ️ О школе",
                callback_data: "about"
            }
        ],
        [
            {
                text: "💬 Поддержка",
                callback_data: "support"
            }
        ]
    ];

    if (access.isAdmin) {
        keyboard.push([
            {
                text: "⚙️ Управление",
                callback_data: "admin"
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
            "📚 <b>Подготовительный курс</b>",
            "",
            "Доступ к урокам и учебным материалам RAUDA ILM.",
            "",
            "💳 <b>Стоимость: 1 500 ₽</b>",
            "",
            "Выберите нужный раздел:"
        ].join("\n"),
        {
            inline_keyboard: keyboard
        }
    );
}


// =========================================================
// CALLBACK-КНОПКИ
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

    // =====================================================
    // АДМИН-ПАНЕЛЬ
    // =====================================================

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


    // =====================================================
    // КУРСЫ
    // =====================================================

    if (data === "admin_courses") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Управление курсами</b>",
                "",
                "Здесь будет управление:",
                "",
                "• программами",
                "• семестрами",
                "• дисциплинами",
                "• уроками",
                "• учебными материалами"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // УЧЕНИКИ
    // =====================================================

    if (data === "admin_students") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
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
                "• поиск ученика",
                "• профиль",
                "• доступ к курсам",
                "• семестры",
                "• группы",
                "• прогресс",
                "• блокировка доступа"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // ГРУППЫ
    // =====================================================

    if (data === "admin_groups") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
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
                "• добавление учеников",
                "• удаление учеников",
                "• просмотр участников"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // ЭКЗАМЕНЫ
    // =====================================================

    if (data === "admin_exams") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📝 <b>Экзамены</b>",
                "",
                "Здесь будет:",
                "",
                "• создание экзаменов",
                "• вопросы и ответы",
                "• результаты",
                "• лимит попыток",
                "• время прохождения",
                "• назначение пересдачи"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // ОПЛАТА
    // =====================================================

    if (data === "admin_payments") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
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
                "На следующем этапе подключим",
                "цену непосредственно к D1."
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
                            callback_data: "admin_payment_history"
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
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
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
                "Дальше подключим изменение",
                "цены непосредственно через D1."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    if (data === "admin_payment_history") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📋 <b>История платежей</b>",
                "",
                "Историю YooKassa и Tribute",
                "подключим к этому разделу."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // СЕРТИФИКАТЫ
    // =====================================================

    if (data === "admin_certificates") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📜 <b>Сертификаты</b>",
                "",
                "Здесь будет:",
                "",
                "• шаблон сертификата",
                "• условия выдачи",
                "• список выданных",
                "• отзыв сертификата",
                "• отправка ученику"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // АДМИНИСТРАТОРЫ
    // =====================================================

    if (data === "admin_staff") {
        if (!access.isOwner) {
            return sendMessage(
                env,
                chatId,
                [
                    "🔒 <b>Только для владельца</b>",
                    "",
                    "Управлять администраторами",
                    "может только владелец RAUDA ILM."
                ].join("\n"),
                backToAdminKeyboard()
            );
        }

        return sendStaffMenu(
            env,
            chatId
        );
    }


    if (data === "admin_staff_list") {
        if (!access.isOwner) {
            return accessDenied(env, chatId);
        }

        return sendAdministratorsList(
            env,
            chatId
        );
    }


    if (data === "admin_staff_add") {
        if (!access.isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "➕ <b>Добавить администратора</b>",
                "",
                "Сначала пользователь должен",
                "открыть бота и нажать /start.",
                "",
                "После этого отправьте:",
                "",
                "<code>/admin_add TELEGRAM_ID</code>",
                "",
                "Например:",
                "<code>/admin_add 123456789</code>"
            ].join("\n"),
            backToStaffKeyboard()
        );
    }


    if (data === "admin_staff_remove") {
        if (!access.isOwner) {
            return accessDenied(env, chatId);
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
                "<code>/admin_remove 123456789</code>",
                "",
                "Владельца удалить невозможно."
            ].join("\n"),
            backToStaffKeyboard()
        );
    }


    // =====================================================
    // СТАТИСТИКА
    // =====================================================

    if (data === "admin_stats") {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📊 <b>Статистика</b>",
                "",
                "Здесь будет отображаться:",
                "",
                "• количество учеников",
                "• активные курсы",
                "• группы",
                "• оплаты",
                "• результаты обучения"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // НЕ РЕАЛИЗОВАННЫЕ АДМИН-ФУНКЦИИ
    // =====================================================

    if (data.startsWith("admin_")) {
        if (!access.isAdmin) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "🛠 <b>Раздел готовится</b>",
                "",
                "Эту функцию подключим",
                "на следующем этапе."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }


    // =====================================================
    // ПРОГРАММА
    // =====================================================

    if (data === "program") {
        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Подготовительный курс RAUDA ILM</b>",
                "",
                "Программа состоит из",
                "последовательных учебных",
                "материалов и уроков.",
                "",
                "После оплаты ученик получает",
                "доступ к соответствующему",
                "учебному периоду."
            ].join("\n")
        );
    }


    // =====================================================
    // ЗАКАЗ
    // =====================================================

    if (data === "order") {
        return sendMessage(
            env,
            chatId,
            [
                "🛒 <b>Подготовительный курс</b>",
                "",
                "💳 Стоимость: <b>1 500 ₽</b>",
                "",
                "Подключение оплаты через ЮKassa",
                "будет следующим этапом.",
                "",
                "После подключения здесь",
                "появится кнопка оплаты."
            ].join("\n")
        );
    }


    // =====================================================
    // О ШКОЛЕ
    // =====================================================

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
                "Уроки, прогресс, экзамены,",
                "оплаты и доступ используют",
                "общую систему."
            ].join("\n")
        );
    }


    // =====================================================
    // ПОДДЕРЖКА
    // =====================================================

    if (data === "support") {
        return sendMessage(
            env,
            chatId,
            [
                "💬 <b>Поддержка RAUDA ILM</b>",
                "",
                "По вопросам обучения и оплаты",
                "обратитесь в поддержку RAUDA ILM."
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
    const keyboard = [
        [
            {
                text: "📚 Курсы",
                callback_data: "admin_courses"
            },
            {
                text: "👥 Ученики",
                callback_data: "admin_students"
            }
        ],
        [
            {
                text: "👨‍👩‍👧‍👦 Группы",
                callback_data: "admin_groups"
            },
            {
                text: "📝 Экзамены",
                callback_data: "admin_exams"
            }
        ],
        [
            {
                text: "💳 Оплата",
                callback_data: "admin_payments"
            },
            {
                text: "📜 Сертификаты",
                callback_data: "admin_certificates"
            }
        ]
    ];

    if (access.isOwner) {
        keyboard.push([
            {
                text: "👮 Администраторы",
                callback_data: "admin_staff"
            }
        ]);
    }

    keyboard.push([
        {
            text: "📊 Статистика",
            callback_data: "admin_stats"
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
            inline_keyboard: keyboard
        }
    );
}


// =========================================================
// МЕНЮ АДМИНИСТРАТОРОВ
// =========================================================

async function sendStaffMenu(env, chatId) {
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
                        callback_data: "admin_staff_add"
                    }
                ],
                [
                    {
                        text: "➖ Снять администратора",
                        callback_data: "admin_staff_remove"
                    }
                ],
                [
                    {
                        text: "👥 Список администраторов",
                        callback_data: "admin_staff_list"
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
// ДОБАВЛЕНИЕ АДМИНИСТРАТОРА
// =========================================================

async function addAdministrator(
    env,
    chatId,
    text
) {
    const access = await getBotAccess(
        env,
        chatId
    );

    if (!access.isOwner) {
        return accessDenied(
            env,
            chatId
        );
    }

    const telegramId =
        text.split(/\s+/)[1]?.trim();

    if (!telegramId || !/^\d+$/.test(telegramId)) {
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
            "👑 Этот пользователь уже является владельцем."
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
                "Попросите его сначала открыть",
                "бота RAUDA ILM и отправить /start.",
                "",
                "После этого повторите команду."
            ].join("\n")
        );
    }

    await setUserRole(
        env,
        telegramId,
        "admin"
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
            "Теперь пользователь имеет",
            "доступ к панели управления."
        ].join("\n")
    );
}


// =========================================================
// СНЯТИЕ АДМИНИСТРАТОРА
// =========================================================

async function removeAdministrator(
    env,
    chatId,
    text
) {
    const access = await getBotAccess(
        env,
        chatId
    );

    if (!access.isOwner) {
        return accessDenied(
            env,
            chatId
        );
    }

    const telegramId =
        text.split(/\s+/)[1]?.trim();

    if (!telegramId || !/^\d+$/.test(telegramId)) {
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
            [
                "🔒 <b>Действие запрещено</b>",
                "",
                "Роль владельца нельзя удалить."
            ].join("\n")
        );
    }

    const user = await env.DB
        .prepare(`
            SELECT
                id,
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
            "ℹ️ Этот пользователь не является администратором."
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
            "Пользователю установлена",
            "роль ученика."
        ].join("\n")
    );
}


// =========================================================
// СПИСОК АДМИНИСТРАТОРОВ
// =========================================================

async function sendAdministratorsList(
    env,
    chatId
) {
    const admins = await getAdmins(env);

    if (!admins.length) {
        return sendMessage(
            env,
            chatId,
            "👥 Список администраторов пуст.",
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

        let role = "👮 Администратор";

        if (admin.role === "owner") {
            role = "👑 Владелец";
        }

        if (admin.role === "superadmin") {
            role = "🛡 Старший администратор";
        }

        lines.push(
            `${role}`,
            `👤 ${escapeHtml(name)}`,
            `🆔 <code>${escapeHtml(String(admin.telegram_id))}</code>`,
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
                    callback_data: "admin_staff"
                }
            ]
        ]
    };
}


// =========================================================
// ДОСТУП
// =========================================================

async function accessDenied(env, chatId) {
    return sendMessage(
        env,
        chatId,
        "⛔ У вас нет доступа к управлению."
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
        payload.reply_markup = replyMarkup;
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
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
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                callback_query_id: callbackQueryId
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
    return new Response("OK", {
        status: 200
    });
}
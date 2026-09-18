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

    const message = update?.message;
    const callback = update?.callback_query;

    if (callback) {
        await answerCallback(env, callback.id);
        await handleCallback(env, callback);
        return ok();
    }

    if (!message?.chat?.id) {
        return ok();
    }

    const text = String(message.text || "").trim();

    if (
        text === "/start" ||
        text.startsWith("/start ")
    ) {
        await sendWelcome(env, message.chat.id);
        return ok();
    }

    await sendWelcome(env, message.chat.id);
    return ok();
}


async function sendWelcome(env, chatId) {
    const isOwner =
        String(chatId) ===
        String(env.OWNER_TELEGRAM_ID);

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

    if (isOwner) {
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


async function handleCallback(env, callback) {
    const chatId =
        callback?.message?.chat?.id;

    if (!chatId) {
        return;
    }

    const data =
        String(callback.data || "");

    const isOwner =
        String(chatId) ===
        String(env.OWNER_TELEGRAM_ID);

    // ==========================
    // ГЛАВНАЯ АДМИН-ПАНЕЛЬ
    // ==========================

    if (data === "admin") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendAdminMenu(env, chatId);
    }

    // ==========================
    // КУРСЫ
    // ==========================

    if (data === "admin_courses") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Курсы</b>",
                "",
                "Здесь будет управление:",
                "• программами",
                "• семестрами",
                "• предметами",
                "• уроками"
            ].join("\n"),
            {
                inline_keyboard: [
                    [
                        {
                            text: "➕ Добавить",
                            callback_data: "admin_courses_add"
                        }
                    ],
                    [
                        {
                            text: "✏️ Редактировать",
                            callback_data: "admin_courses_edit"
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

    // ==========================
    // УЧЕНИКИ
    // ==========================

    if (data === "admin_students") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "👥 <b>Ученики</b>",
                "",
                "Здесь будет управление учениками:",
                "• поиск",
                "• профиль",
                "• доступ",
                "• курс",
                "• группа",
                "• прогресс"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // ГРУППЫ
    // ==========================

    if (data === "admin_groups") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "👨‍👩‍👧‍👦 <b>Группы</b>",
                "",
                "Здесь будет создание и управление группами."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // ЭКЗАМЕНЫ
    // ==========================

    if (data === "admin_exams") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📝 <b>Экзамены</b>",
                "",
                "Здесь будет управление:",
                "• экзаменами",
                "• результатами",
                "• попытками",
                "• пересдачами"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // ОПЛАТА
    // ==========================

    if (data === "admin_payments") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "💳 <b>Оплата и тарифы</b>",
                "",
                "📚 Подготовительный курс",
                "💰 Текущая цена: <b>1 500 ₽</b>",
                "",
                "После подключения D1 цена будет",
                "изменяться прямо через бот."
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
                            text: "📋 Платежи",
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
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "💰 <b>Изменение цены</b>",
                "",
                "Сейчас установлено: <b>1 500 ₽</b>",
                "",
                "Следующим этапом подключим хранение",
                "цены в D1.",
                "",
                "После этого владелец и назначенные",
                "администраторы смогут менять цену",
                "прямо через Telegram."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // СЕРТИФИКАТЫ
    // ==========================

    if (data === "admin_certificates") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📜 <b>Сертификаты</b>",
                "",
                "Здесь будет управление сертификатами."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // АДМИНИСТРАТОРЫ
    // ==========================

    if (data === "admin_staff") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "👮 <b>Администраторы</b>",
                "",
                "Здесь владелец сможет:",
                "• добавить администратора",
                "• удалить администратора",
                "• настроить его права",
                "",
                "Систему ролей подключим к D1."
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

    // ==========================
    // СТАТИСТИКА
    // ==========================

    if (data === "admin_stats") {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "📊 <b>Статистика</b>",
                "",
                "Здесь будет статистика RAUDA ILM:",
                "• ученики",
                "• группы",
                "• оплаты",
                "• активные курсы"
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // ПОКА НЕ РЕАЛИЗОВАННЫЕ
    // АДМИН-КНОПКИ
    // ==========================

    if (data.startsWith("admin_")) {
        if (!isOwner) {
            return accessDenied(env, chatId);
        }

        return sendMessage(
            env,
            chatId,
            [
                "🛠 <b>Раздел готовится</b>",
                "",
                "Эту функцию подключим на следующем этапе."
            ].join("\n"),
            backToAdminKeyboard()
        );
    }

    // ==========================
    // ПРОГРАММА КУРСА
    // ==========================

    if (data === "program") {
        return sendMessage(
            env,
            chatId,
            [
                "📚 <b>Подготовительный курс RAUDA ILM</b>",
                "",
                "Программа состоит из последовательных",
                "учебных материалов и уроков.",
                "",
                "После подключения ученик получает",
                "доступ к материалам курса."
            ].join("\n")
        );
    }

    // ==========================
    // ОФОРМЛЕНИЕ ЗАКАЗА
    // ==========================

    if (data === "order") {
        return sendMessage(
            env,
            chatId,
            [
                "🛒 <b>Подготовительный курс</b>",
                "",
                "💳 Стоимость: <b>1 500 ₽</b>",
                "",
                "Оплата через ЮKassa находится",
                "на этапе подключения.",
                "",
                "После подключения здесь появится",
                "кнопка оплаты."
            ].join("\n")
        );
    }

    // ==========================
    // О ШКОЛЕ
    // ==========================

    if (data === "about") {
        return sendMessage(
            env,
            chatId,
            [
                "<b>RAUDA ILM</b>",
                "",
                "Онлайн-школа с обучением через Telegram.",
                "",
                "Учебный процесс включает уроки,",
                "материалы и проверку знаний."
            ].join("\n")
        );
    }

    // ==========================
    // ПОДДЕРЖКА
    // ==========================

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


async function sendAdminMenu(env, chatId) {
    return sendMessage(
        env,
        chatId,
        [
            "⚙️ <b>Управление RAUDA ILM</b>",
            "",
            "Выберите раздел:"
        ].join("\n"),
        {
            inline_keyboard: [
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
                ],
                [
                    {
                        text: "👮 Администраторы",
                        callback_data: "admin_staff"
                    },
                    {
                        text: "📊 Статистика",
                        callback_data: "admin_stats"
                    }
                ]
            ]
        }
    );
}


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


async function accessDenied(env, chatId) {
    return sendMessage(
        env,
        chatId,
        "⛔ У вас нет доступа к управлению."
    );
}


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


function ok() {
    return new Response("OK", {
        status: 200
    });
}
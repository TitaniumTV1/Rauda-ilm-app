const TELEGRAM_API = "https://api.telegram.org";

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

    const message = update?.message;
    const callback = update?.callback_query;

    if (callback) {
        await answerCallback(
            env,
            callback.id
        );

        await handleCallback(
            env,
            callback
        );

        return ok();
    }

    if (!message?.chat?.id) {
        return ok();
    }

    const text =
        String(message.text || "").trim();

    if (
        text === "/start" ||
        text.startsWith("/start ")
    ) {
        await sendWelcome(
            env,
            message.chat.id
        );

        return ok();
    }

    await sendWelcome(
        env,
        message.chat.id
    );

    return ok();
}


async function sendWelcome(
    env,
    chatId
) {
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

    const response =
        await fetch(
            `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body:
                    JSON.stringify(
                        payload
                    )
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

    await fetch(
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
}


function ok() {
    return new Response(
        "OK",
        { status: 200 }
    );
}
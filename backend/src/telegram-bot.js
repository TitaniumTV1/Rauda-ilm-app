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
            "Выберите нужный раздел:"
        ].join("\n"),
        {
            inline_keyboard: [
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
            ]
        }
    );
}


async function handleCallback(
    env,
    callback
) {
    const chatId =
        callback?.message?.chat?.id;

    if (!chatId) {
        return;
    }

    const data =
        String(callback.data || "");

    if (data === "program") {
        return sendMessage(
            env,
            chatId,
            [
                "<b>Подготовительный курс RAUDA ILM</b>",
                "",
                "Программа состоит из последовательных учебных материалов и уроков.",
                "",
                "После подключения ученик получает доступ к материалам курса."
            ].join("\n")
        );
    }

    if (data === "order") {
        return sendMessage(
            env,
            chatId,
            [
                "<b>Подготовительный курс</b>",
                "",
                "Оплата через ЮKassa находится на этапе подключения.",
                "",
                "После подключения здесь появится кнопка оплаты."
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
                "Онлайн-школа с обучением через Telegram.",
                "",
                "Учебный процесс включает уроки, материалы и проверку знаний."
            ].join("\n")
        );
    }

    if (data === "support") {
        return sendMessage(
            env,
            chatId,
            "По вопросам обучения и оплаты обратитесь в поддержку RAUDA ILM."
        );
    }
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
import { getAdmins, getBotAccess, hasPermission } from "./bot-access.js";

const MAX_TEXT_LENGTH = 3000;
const MENU_TEXT = new Set([
    "💬 Поддержка", "⚙️ Управление", "📚 Курсы", "📚 Программа курса",
    "📚 Моё обучение", "📖 Моё обучение", "🛒 Оформить заказ", "ℹ️ О школе",
    "➕ Создать курс", "📚 Список курсов", "👥 Ученики", "👨‍👩‍👧‍👦 Группы",
    "📝 Экзамены", "💳 Оплата", "📜 Сертификаты", "📊 Статистика", "👮 Администраторы"
]);

function privateChat(message, from = message?.from) {
    return message?.chat?.type === "private" && from?.id != null &&
        String(message.chat.id) === String(from.id);
}

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shortText(value, length) {
    return [...String(value || "").replace(/\s+/g, " ")].slice(0, length).join("");
}

function composeKeyboard(admin = false) {
    return {
        keyboard: [[{ text: "❌ Отмена" }], [{ text: admin ? "⬅️ Админ-панель" : "⬅️ Главное меню" }]],
        resize_keyboard: true,
        is_persistent: true
    };
}

function menuKeyboard(admin = false) {
    return { inline_keyboard: [
        [{ text: admin ? "💬 Обращения" : "✉️ Написать ещё", callback_data: admin ? "admin_support" : "support" }],
        [{ text: admin ? "⬅️ Админ-панель" : "⬅️ Главное меню", callback_data: admin ? "admin" : "home" }]
    ] };
}

async function sendText(env, chatId, text, replyMarkup) {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram support bot is not configured");
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        })
    });
    const body = await response.json();
    if (!response.ok || body?.ok !== true || !Number.isSafeInteger(body.result?.message_id)) {
        // Never log a request URL containing the token, or private message text.
        throw new Error(`Telegram support send failed (${response.status}/${body?.error_code || "invalid_response"})`);
    }
    return body.result;
}

async function ensureSchema(env) {
    await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_support_drafts (
            chat_id TEXT PRIMARY KEY, state TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_support_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('question', 'reply')),
            parent_id INTEGER, sender_name TEXT NOT NULL, body TEXT NOT NULL, draft_state TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (source_chat_id, source_message_id)
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_support_deliveries (
            support_message_id INTEGER NOT NULL, recipient_chat_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', telegram_message_id INTEGER,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (support_message_id, recipient_chat_id)
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_support_interactions (
            source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
            ready INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source_chat_id, source_message_id)
        )`)
    ]);
}

async function canManage(env, chatId) {
    const access = await getBotAccess(env, chatId);
    if (!access.isAdmin) return false;
    const user = access.user || await env.DB.prepare(
        "SELECT status FROM users WHERE telegram_id = ? LIMIT 1"
    ).bind(String(chatId)).first();
    if (user && user.status !== "active") return false;
    return access.isOwner || await hasPermission(env, chatId, "support");
}

async function supportRecipients(env) {
    const candidates = new Set((await getAdmins(env))
        .filter(user => user.status === "active")
        .map(user => String(user.telegram_id)));
    if (/^[1-9]\d*$/.test(String(env.OWNER_TELEGRAM_ID || ""))) {
        candidates.add(String(env.OWNER_TELEGRAM_ID));
    }
    const recipients = [];
    for (const chatId of candidates) {
        if (await canManage(env, chatId)) recipients.push(chatId);
    }
    return recipients;
}

async function getDraft(env, chatId) {
    const row = await env.DB.prepare("SELECT state FROM telegram_support_drafts WHERE chat_id = ?")
        .bind(String(chatId)).first();
    if (!row) return null;
    try {
        const state = JSON.parse(row.state);
        return ["question", "reply"].includes(state.kind) ? { ...state, raw: row.state } : null;
    } catch { return null; }
}

async function setDraft(env, chatId, kind, parentId = null) {
    const state = JSON.stringify({ kind, parentId, nonce: crypto.randomUUID() });
    await env.DB.prepare(`INSERT INTO telegram_support_drafts (chat_id, state) VALUES (?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP`)
        .bind(String(chatId), state).run();
    return state;
}

export async function cancelSupportDraft(env, chatId) {
    await ensureSchema(env);
    await env.DB.prepare("DELETE FROM telegram_support_drafts WHERE chat_id = ?")
        .bind(String(chatId)).run();
}

async function clearExactDraft(env, chatId, raw) {
    if (!raw) return;
    await env.DB.prepare("DELETE FROM telegram_support_drafts WHERE chat_id = ? AND state = ?")
        .bind(String(chatId), raw).run();
}

async function questionForReply(env, id, actorId) {
    if (!Number.isSafeInteger(id) || id < 1 || !await canManage(env, actorId)) return null;
    return env.DB.prepare("SELECT * FROM telegram_support_messages WHERE id = ? AND kind = 'question'")
        .bind(id).first();
}

async function inbox(env, chatId) {
    if (!await canManage(env, chatId)) {
        await sendText(env, chatId, "⛔ Нет доступа к обращениям в поддержку.");
        return;
    }
    await cancelSupportDraft(env, chatId);
    const { results = [] } = await env.DB.prepare(`SELECT id, sender_name, body
        FROM telegram_support_messages WHERE kind = 'question' ORDER BY id DESC LIMIT 10`).all();
    const lines = ["💬 <b>Обращения в поддержку</b>", ""];
    for (const row of results) lines.push(`№${row.id} · ${escapeHtml(shortText(row.sender_name, 50))}\n${escapeHtml(shortText(row.body, 130))}\n`);
    if (!results.length) lines.push("Обращений пока нет.");
    const buttons = results.map(row => [{ text: `Ответить на №${row.id}`, callback_data: `support_reply_${row.id}` }]);
    buttons.push([{ text: "⬅️ Админ-панель", callback_data: "admin" }]);
    await sendText(env, chatId, lines.join("\n"), { inline_keyboard: buttons });
}

export async function handleSupportCallback(env, callback) {
    const data = String(callback?.data || "");
    if (data !== "support" && data !== "admin_support" && !data.startsWith("support_")) return false;
    if (!privateChat(callback?.message, callback?.from)) return true;
    const chatId = String(callback.message.chat.id);
    await ensureSchema(env);

    if (data === "admin_support") {
        await inbox(env, chatId);
        return true;
    }
    if (data === "support") {
        await setDraft(env, chatId, "question");
        await sendText(env, chatId, "💬 <b>Поддержка RAUDA ILM</b>\n\nОтправьте вопрос одним текстовым сообщением (до 3000 символов). Ответ придёт сюда, в бот.", composeKeyboard());
        return true;
    }
    if (data === "support_cancel") {
        await cancelSupportDraft(env, chatId);
        await sendText(env, chatId, "Написание сообщения отменено.", menuKeyboard(await canManage(env, chatId)));
        return true;
    }
    const reply = /^support_reply_([1-9]\d*)$/.exec(data);
    if (reply) {
        const question = await questionForReply(env, Number(reply[1]), chatId);
        if (!question) {
            await sendText(env, chatId, "⛔ Обращение недоступно или право поддержки не выдано.");
            return true;
        }
        await setDraft(env, chatId, "reply", question.id);
        await sendText(env, chatId, `✉️ <b>Ответ на обращение №${question.id}</b>\n\n${escapeHtml(shortText(question.sender_name, 80))}:\n${escapeHtml(shortText(question.body, 500))}\n\nОтправьте ответ текстом (до 3000 символов).`, composeKeyboard(true));
        return true;
    }
    const retry = /^support_retry_([1-9]\d*)$/.exec(data);
    if (retry) {
        const record = await env.DB.prepare("SELECT * FROM telegram_support_messages WHERE id = ? AND source_chat_id = ?")
            .bind(Number(retry[1]), chatId).first();
        if (!record || (record.kind === "reply" && !await questionForReply(env, record.parent_id, chatId))) {
            await sendText(env, chatId, "⛔ Это сообщение недоступно для повторной отправки.");
            return true;
        }
        await deliverRecord(env, record, await getDraft(env, chatId));
        return true;
    }
    await sendText(env, chatId, "Эта кнопка поддержки больше недоступна.", menuKeyboard(await canManage(env, chatId)));
    return true;
}

export async function handleSupportMessage(env, message, onNewInteraction) {
    if (!privateChat(message)) return false;
    const chatId = String(message.chat.id);
    const text = typeof message.text === "string" ? message.text.trim() : "";
    await ensureSchema(env);
    let draft = await getDraft(env, chatId);
    if (text === "❌ Отмена" || /^\/cancel(?:@\w+)?(?:\s|$)/.test(text)) {
        if (!draft) return false;
        await cancelSupportDraft(env, chatId);
        await sendText(env, chatId, "Написание сообщения отменено.", menuKeyboard(draft.kind === "reply"));
        return true;
    }
    if (text.startsWith("/") || text.startsWith("⬅") || MENU_TEXT.has(text)) {
        if (draft) await cancelSupportDraft(env, chatId);
        return false;
    }
    if (!Number.isSafeInteger(message.message_id) || message.message_id < 1) return false;
    const previous = await env.DB.prepare(`SELECT * FROM telegram_support_messages
        WHERE source_chat_id = ? AND source_message_id = ?`).bind(chatId, message.message_id).first();
    if (previous) {
        // A Telegram replay must never create a second message or consume a newer draft.
        if (previous.kind === "reply" && !await questionForReply(env, previous.parent_id, chatId)) return true;
        await deliverRecord(env, previous, null, true);
        return true;
    }

    if (message.reply_to_message?.message_id) {
        const mapped = await env.DB.prepare(`SELECT m.* FROM telegram_support_messages m
            JOIN telegram_support_deliveries d ON d.support_message_id = m.id
            WHERE d.recipient_chat_id = ? AND d.telegram_message_id = ? AND d.status = 'sent'
            LIMIT 1`).bind(chatId, message.reply_to_message.message_id).first();
        if (mapped?.kind === "question") {
            if (!await questionForReply(env, mapped.id, chatId)) {
                await sendText(env, chatId, "⛔ Право отвечать на обращения больше недоступно.");
                return true;
            }
            draft = { kind: "reply", parentId: mapped.id, raw: draft?.raw };
        } else if (mapped?.kind === "reply") {
            draft = { kind: "question", parentId: mapped.parent_id, raw: draft?.raw };
        } else if (draft) {
            await sendText(env, chatId, "Отправьте текст отдельным сообщением или ответьте на сообщение поддержки.", composeKeyboard(draft.kind === "reply"));
            return true;
        }
    }
    if (!draft) return false;
    if (draft.kind === "reply" && !await questionForReply(env, draft.parentId, chatId)) {
        await clearExactDraft(env, chatId, draft.raw);
        await sendText(env, chatId, "⛔ Право отвечать на обращения больше недоступно.");
        return true;
    }
    if (!text || text.length > MAX_TEXT_LENGTH) {
        await sendText(env, chatId, "Отправьте текст от 1 до 3000 символов. Фото, голосовые сообщения и файлы пока не поддерживаются.", composeKeyboard(draft.kind === "reply"));
        return true;
    }
    if (typeof onNewInteraction === "function") {
        // Reserve the Telegram event before invoking navigation cleanup. Concurrent
        // deliveries must not run that cleanup twice or erase a newer input mode.
        const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO telegram_support_interactions
            (source_chat_id, source_message_id) VALUES (?, ?)`)
            .bind(chatId, message.message_id).run();
        if (claimed.meta.changes) {
            try {
                await onNewInteraction();
                await env.DB.prepare(`UPDATE telegram_support_interactions SET ready = 1
                    WHERE source_chat_id = ? AND source_message_id = ?`)
                    .bind(chatId, message.message_id).run();
            } catch (error) {
                await env.DB.prepare(`DELETE FROM telegram_support_interactions
                    WHERE source_chat_id = ? AND source_message_id = ? AND ready = 0`)
                    .bind(chatId, message.message_id).run();
                throw error;
            }
        } else {
            const interaction = await env.DB.prepare(`SELECT ready FROM telegram_support_interactions
                WHERE source_chat_id = ? AND source_message_id = ?`)
                .bind(chatId, message.message_id).first();
            if (!interaction?.ready) return true;
        }
    }
    const name = shortText([message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username || chatId, 80);
    await env.DB.prepare(`INSERT OR IGNORE INTO telegram_support_messages
        (source_chat_id, source_message_id, kind, parent_id, sender_name, body, draft_state) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(chatId, message.message_id, draft.kind, draft.parentId || null, name, text, draft.raw || null).run();
    const record = await env.DB.prepare("SELECT * FROM telegram_support_messages WHERE source_chat_id = ? AND source_message_id = ?")
        .bind(chatId, message.message_id).first();
    await deliverRecord(env, record, draft);
    return true;
}

async function deliverRecord(env, record, draft, silentReplay = false) {
    let recipients;
    if (record.kind === "reply") {
        const question = await questionForReply(env, record.parent_id, record.source_chat_id);
        if (!question) return;
        recipients = [question.source_chat_id];
    } else {
        recipients = await supportRecipients(env);
    }
    if (!recipients.length) {
        await sendText(env, record.source_chat_id, "Не удалось связаться с поддержкой. Сообщение сохранено, попробуйте отправить его ещё раз.", {
            inline_keyboard: [[{ text: "🔄 Повторить отправку", callback_data: `support_retry_${record.id}` }]]
        });
        return;
    }
    // Existing sent deliveries are retained across retries; newly authorized staff
    // receive future questions, not replays of messages sent before their assignment.
    const existing = await env.DB.prepare("SELECT * FROM telegram_support_deliveries WHERE support_message_id = ?")
        .bind(record.id).all();
    if (!existing.results.length) {
        await env.DB.batch(recipients.map(recipient => env.DB.prepare(`INSERT OR IGNORE INTO telegram_support_deliveries
            (support_message_id, recipient_chat_id) VALUES (?, ?)`).bind(record.id, recipient)));
    }
    const deliveries = await env.DB.prepare("SELECT * FROM telegram_support_deliveries WHERE support_message_id = ?")
        .bind(record.id).all();
    let attempted = false;
    for (const delivery of deliveries.results) {
        if (delivery.status === "sent") continue;
        if (record.kind === "question" && !await canManage(env, delivery.recipient_chat_id)) continue;
        if (record.kind === "reply" && !await canManage(env, record.source_chat_id)) return;
        const claimed = await env.DB.prepare(`UPDATE telegram_support_deliveries
            SET status = 'sending', updated_at = CURRENT_TIMESTAMP
            WHERE support_message_id = ? AND recipient_chat_id = ? AND status IN ('pending', 'failed')`)
            .bind(record.id, delivery.recipient_chat_id).run();
        if (!claimed.meta.changes) continue;
        attempted = true;
        let sent;
        try {
            const text = record.kind === "question"
                ? `💬 <b>Обращение №${record.id}</b>\n👤 ${escapeHtml(record.sender_name)}\n🆔 <code>${escapeHtml(record.source_chat_id)}</code>\n\n${escapeHtml(record.body)}`
                : `💬 <b>Ответ поддержки RAUDA ILM</b>\nОбращение №${record.parent_id}\n\n${escapeHtml(record.body)}`;
            const markup = record.kind === "question"
                ? { inline_keyboard: [[{ text: "✉️ Ответить", callback_data: `support_reply_${record.id}` }]] }
                : { inline_keyboard: [[{ text: "✉️ Написать в поддержку", callback_data: "support" }]] };
            sent = await sendText(env, delivery.recipient_chat_id, text, markup);
        } catch (error) {
            console.error("Telegram support delivery failed", { id: record.id, error: error.message });
            await env.DB.prepare(`UPDATE telegram_support_deliveries SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                WHERE support_message_id = ? AND recipient_chat_id = ? AND status = 'sending'`)
                .bind(record.id, delivery.recipient_chat_id).run();
            continue;
        }
        // Keep Telegram success outside the catch above: if this D1 write fails,
        // retrying an uncertain external delivery could duplicate a private message.
        await env.DB.prepare(`UPDATE telegram_support_deliveries
            SET status = 'sent', telegram_message_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE support_message_id = ? AND recipient_chat_id = ? AND status = 'sending'`)
            .bind(sent.message_id, record.id, delivery.recipient_chat_id).run();
    }
    const final = await env.DB.prepare("SELECT status, recipient_chat_id FROM telegram_support_deliveries WHERE support_message_id = ?")
        .bind(record.id).all();
    const relevant = final.results.filter(delivery => recipients.includes(delivery.recipient_chat_id));
    const delivered = relevant.some(delivery => delivery.status === "sent");
    const unfinished = relevant.some(delivery => delivery.status !== "sent");
    if (silentReplay && !attempted) return;
    if (delivered && !unfinished) {
        await clearExactDraft(env, record.source_chat_id, record.draft_state);
        await sendText(env, record.source_chat_id,
            record.kind === "reply" ? "✅ Ответ доставлен ученику." : "✅ Сообщение доставлено поддержке. Ответ придёт в этот чат.",
            menuKeyboard(record.kind === "reply"));
    } else {
        await sendText(env, record.source_chat_id,
            delivered ? "Сообщение доставлено части команды поддержки. Можно повторить доставку остальным." : "Не удалось подтвердить доставку. Сообщение сохранено — попробуйте ещё раз.",
            { inline_keyboard: [
                [{ text: "🔄 Повторить отправку", callback_data: `support_retry_${record.id}` }],
                [{ text: "❌ Отмена", callback_data: "support_cancel" }]
            ] });
    }
}

import { getBotAccess, getTelegramUser, hasPermission } from "./bot-access.js";
import { getPaymentSettings, updatePaymentSettings, getPaymentOptions, createSemesterCheckout, getSemesterOrder, ensurePaymentTables, PaymentError } from "./payments.js";

const esc = v => String(v ?? "").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const short = v => [...String(v ?? "")].slice(0,90).join("");
const b = (text,callback_data) => ({text,callback_data});
const back = id => [b("⬅️ Назад",id)];
const privateChat = (message,from=message?.from) => message?.chat?.type === "private" && String(message.chat.id)===String(from?.id);
async function send(env,chatId,text,rows) {
    const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:rows}})});
    const d=await r.json();if(!r.ok || !d.ok) throw new Error("Не удалось отправить сообщение Telegram");return d.result;
}
async function ensureDrafts(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_payment_drafts (
        chat_id INTEGER PRIMARY KEY,state TEXT,after_id INTEGER NOT NULL DEFAULT 0)` ).run();
}
export async function cancelPaymentDraft(env,chatId,messageId=0) {
    await ensureDrafts(env);
    await env.DB.prepare(`INSERT INTO telegram_payment_drafts(chat_id,state,after_id) VALUES(?,NULL,?)
        ON CONFLICT(chat_id) DO UPDATE SET state=NULL,after_id=MAX(after_id,excluded.after_id)`)
        .bind(chatId,messageId || 0).run();
}
async function owner(env,chatId) {
    const user=await getTelegramUser(env,chatId);
    return (!user || user.status==="active") && (await getBotAccess(env,chatId)).isOwner;
}
async function paymentAdmin(env,chatId) {
    const user=await getTelegramUser(env,chatId);
    return (!user || user.status==="active") && await hasPermission(env,chatId,"payments");
}
const amountLabel = (amount,currency) => `${Number(amount).toLocaleString("ru-RU")} ${currency === "RUB" ? "₽" : currency}`;

async function showOptions(env,chatId,id) {
    const user=await getTelegramUser(env,chatId);
    if(!user) throw new PaymentError("Откройте бот командой /start.");
    const result=await getPaymentOptions(env,user.id,id);
    const rows=result.options.map(option=>[b(`${option.label}${option.enabled ? ` · ${amountLabel(option.amount,option.currency)}` : " · недоступно"}`,`pay_buy_${id}_${option.provider}`)]);
    rows.push(back(`learn_semester_${id}_0`),[b("💬 Поддержка","support")]);
    const unavailable=result.options.filter(x=>!x.enabled).map(x=>`${x.label}: ${x.reason}`).join("\n");
    return send(env,chatId,`💳 <b>${esc(short(result.semester.name))}</b>\n📚 ${esc(short(result.semester.course_name))}\n\nВыберите способ оплаты. После подтверждения платежа бот пришлёт ссылку закрытого канала семестра.${unavailable ? `\n\n${esc(unavailable)}` : ""}`,rows);
}

async function showAdmin(env,chatId,page=0) {
    const data=await getPaymentSettings(env);
    const isOwner=await owner(env,chatId);
    const rows=[];
    const flags=[];
    flags.push(`Приём оплаты: ${data.settings.payments_enabled ? "включён" : "выключен"}`);
    if(isOwner) rows.push([b(data.settings.payments_enabled ? "⏸ Выключить приём оплаты" : "▶️ Включить приём оплаты",`pay_master_${data.settings.payments_enabled?0:1}`)]);
    for(const [provider,label] of [["tribute","Tribute"],["yoomoney","ЮMoney"]]) {
        const enabled=data.settings[`${provider}_enabled`];
        flags.push(`${label}: ${enabled ? "включён" : "выключен"}; секрет ${data.integration[provider].secret_configured ? "задан" : "не задан"}`);
        if(isOwner) rows.push([b(`${enabled ? "Выключить" : "Включить"} ${label}`,`pay_global_${provider}_${enabled?0:1}`)]);
    }
    if(isOwner) rows.push([b("✏️ Кошелёк ЮMoney","pay_edit_wallet_0")]);
    const semesters=data.semesters.slice(page*8,page*8+8);
    for(const item of semesters) rows.push([b(`🎓 ${short(item.course_name)} · ${short(item.name || `${item.number} семестр`)}`.slice(0,70),`pay_admin_semester_${item.id}`)]);
    const pages=[];
    if(page>0) pages.push(b("⬅️ Ещё",`pay_admin_page_${page-1}`));
    if(data.semesters.length>(page+1)*8) pages.push(b("Ещё ➡️",`pay_admin_page_${page+1}`));
    if(pages.length) rows.push(pages);
    rows.push([b("📋 История платежей","pay_history_0")],[b("ℹ️ Настройка уведомлений","pay_help")],back("admin"));
    return send(env,chatId,`💳 <b>Оплата семестров</b>\n\n${flags.join("\n")}\n\nВыберите семестр, чтобы изменить цену и способы оплаты.${!isOwner ? "\nНастройки провайдеров изменяет владелец." : ""}`,rows);
}

async function showAdminSemester(env,chatId,id) {
    const data=await getPaymentSettings(env);
    const s=data.semesters.find(s=>Number(s.id)===id);
    if(!s) throw new PaymentError("Семестр не найден",404);
    const rows=[];
    if(await owner(env,chatId)) {
        for(const [key,label] of [["payment_enabled","Приём оплаты"],["tribute_enabled","Tribute"],["yoomoney_enabled","ЮMoney"]])
            rows.push([b(`${s[key] ? "✅" : "⛔"} ${label}`,`pay_set_${id}_${key}_${s[key]?0:1}`)]);
        rows.push([b("💰 Цена ЮMoney (₽)",`pay_edit_price_${id}`)],
            [b("🔢 ID продукта Tribute",`pay_edit_product_${id}`)],
            [b("🔗 Продукт Tribute",`pay_edit_tribute_${id}`)],
            [b("💰 Цена Tribute",`pay_edit_amount_${id}`)],
            [b("💱 Валюта Tribute",`pay_edit_currency_${id}`)]);
    }
    rows.push(back("admin_payments"));
    return send(env,chatId,`🎓 <b>${esc(short(s.name || `${s.number} семестр`))}</b>\n📚 ${esc(short(s.course_name))}\n\nЦена ЮMoney: ${s.price_rub} ₽\nTribute: ${amountLabel(s.tribute_amount_minor/100,s.tribute_currency)}\nID продукта: ${esc(s.tribute_product_id || "не задан")}\nСсылка: ${s.tribute_payment_url ? esc(s.tribute_payment_url) : "не задана"}\n\nДля каждого семестра в Tribute нужен отдельный цифровой продукт. Цена и валюта должны совпадать с его настройками.`,rows);
}

async function showHistory(env,chatId,page) {
    await ensurePaymentTables(env);
    const result=await env.DB.prepare(`SELECT o.provider,o.amount_minor,o.currency,p.status,u.first_name,s.name,s.number
        FROM semester_payment_orders o JOIN payments p ON p.id=o.payment_id JOIN users u ON u.id=p.user_id
        JOIN semesters s ON s.id=o.semester_id ORDER BY o.created_at DESC,o.order_uid DESC LIMIT 9 OFFSET ?`).bind(page*8).all();
    const list=result.results || [];
    const lines=list.slice(0,8).map(r=>`${r.provider === "tribute" ? "Tribute" : "ЮMoney"}: ${esc(short(r.first_name))} · ${esc(short(r.name || `${r.number} семестр`))}\n${amountLabel(r.amount_minor/100,r.currency)} — ${({pending:"ожидается",paid:"оплачен",refunded:"возврат",rejected:"отклонён",waiting_confirmation:"проверяется"})[r.status] || esc(r.status)}`);
    const rows=[];
    if(page>0) rows.push([b("⬅️ Ещё",`pay_history_${page-1}`)]);
    if(list.length>8) rows.push([b("Ещё ➡️",`pay_history_${page+1}`)]);
    rows.push(back("admin_payments"));
    return send(env,chatId,`📋 <b>Платежи семестров</b>\n\n${lines.join("\n\n") || "Новых платежей семестров пока нет."}`,rows);
}

async function prompt(env,callback,kind,id) {
    await ensureDrafts(env);
    const chatId=callback.message.chat.id;
    const state={kind,id,nonce:crypto.randomUUID()};
    await env.DB.prepare(`INSERT INTO telegram_payment_drafts(chat_id,state,after_id) VALUES(?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,after_id=MAX(after_id,excluded.after_id)`)
        .bind(chatId,JSON.stringify(state),callback.message.message_id || 0).run();
    const instructions={wallet:"Отправьте номер кошелька ЮMoney, начинающийся с 4100. Секреты и пароли сюда отправлять не нужно.",
        price:"Отправьте цену семестра в рублях целым числом от 1 до 1 000 000.",
        tribute:"Отправьте ссылку цифрового продукта Tribute, например https://web.tribute.tg/p/f6 или https://t.me/tribute_bot/app?startapp=pf6. Чтобы убрать, отправьте «-».",
        product:"Отправьте числовой ID цифрового продукта из кабинета или API Tribute. Код в платёжной ссылке может отличаться от ID продукта.",
        amount:"Отправьте точную цену продукта Tribute в выбранной валюте (например, 1500 или 15.50).",
        currency:"Отправьте валюту цифрового продукта Tribute: RUB, USD или EUR."};
    return send(env,chatId,instructions[kind],[[b("❌ Отмена",`pay_cancel_${state.nonce}`)]]);
}

export async function handlePaymentMessage(env,message) {
    if(!privateChat(message)) return false;
    await ensureDrafts(env);
    const row=await env.DB.prepare("SELECT * FROM telegram_payment_drafts WHERE chat_id=?").bind(message.chat.id).first();
    if(!row?.state) return false;
    if(!Number.isSafeInteger(message.message_id) || message.message_id<=row.after_id) return true;
    if(!await owner(env,message.chat.id)) { await cancelPaymentDraft(env,message.chat.id,message.message_id);await send(env,message.chat.id,"🔒 Настройки оплаты изменяет владелец.",[back("admin")]);return true; }
    const draft=JSON.parse(row.state);const input=String(message.text || "").trim();
    const body=draft.kind === "wallet" ? {settings:{yoomoney_wallet:input}} : {semesters:[{id:draft.id}]};
    const item=body.semesters?.[0];
    try {
        if(draft.kind === "price") { if(!/^\d+$/.test(input) || Number(input)<1) throw new PaymentError("Введите целую цену в рублях от 1.");item.price_rub=Number(input); }
        if(draft.kind === "amount") { if(!/^\d+(?:[.,]\d{1,2})?$/.test(input)) throw new PaymentError("Введите сумму числом, до двух знаков после запятой.");item.tribute_amount_minor=Math.round(Number(input.replace(",","."))*100); }
        if(draft.kind === "currency") item.tribute_currency=input.toUpperCase();
        if(draft.kind === "product") item.tribute_product_id=input;
        if(draft.kind === "tribute") {
            if(input === "-") { item.tribute_payment_url="";item.tribute_product_id="";item.tribute_enabled=false; }
            else {
                item.tribute_payment_url=input;
            }
        }
        await updatePaymentSettings(env,body,{guard:{chatId:message.chat.id,state:row.state,messageId:message.message_id}});
        await send(env,message.chat.id,"✅ Настройки оплаты сохранены.",[back(draft.id ? `pay_admin_semester_${draft.id}` : "admin_payments")]);
    } catch(error) {
        await send(env,message.chat.id,`❌ ${esc(error instanceof PaymentError ? error.message : "Не удалось сохранить настройки. Повторите ввод.")}`,[[b("❌ Отмена",`pay_cancel_${draft.nonce}`)]]);
    }
    return true;
}

export async function handlePaymentCallback(env,callback) {
    const data=String(callback.data || "");
    if(!data.startsWith("pay_") && !["admin_payments","admin_price","admin_payment_history"].includes(data)) return false;
    if(!privateChat(callback.message,callback.from)) return true;
    const chatId=callback.message.chat.id;
    const admin=!/^pay_(options_|buy_|status_)/.test(data);
    try {
        if(admin && !await paymentAdmin(env,chatId)) throw new PaymentError("Нет права управлять оплатой.",403);
        const writes=/^pay_(?:master_|global_|set_|edit_|cancel_)/.test(data);
        if(writes && !await owner(env,chatId)) throw new PaymentError("Настройки оплаты изменяет владелец.",403);
        let m;
        if((m=data.match(/^pay_cancel_([a-f0-9-]+)$/))) {
            await ensureDrafts(env);const row=await env.DB.prepare("SELECT state FROM telegram_payment_drafts WHERE chat_id=?").bind(chatId).first();
            if(row?.state && JSON.parse(row.state).nonce===m[1]) await cancelPaymentDraft(env,chatId);
            await send(env,chatId,"Ввод завершён.",[back("admin_payments")]);return true;
        }
        if((m=data.match(/^pay_edit_(wallet|price|tribute|product|amount|currency)_(\d+)$/))) { await prompt(env,callback,m[1],Number(m[2]));return true; }
        await cancelPaymentDraft(env,chatId);
        if((m=data.match(/^pay_options_(\d+)$/))) await showOptions(env,chatId,Number(m[1]));
        else if((m=data.match(/^pay_buy_(\d+)_(tribute|yoomoney)$/))) {
            const user=await getTelegramUser(env,chatId);
            if(!user) throw new PaymentError("Откройте бот командой /start.");
            const order=await createSemesterCheckout(env,{userId:user.id,semesterId:Number(m[1]),provider:m[2]});
            await send(env,chatId,`Ссылка на оплату подготовлена. Статус изменится после уведомления платёжного сервиса.`,
                [[{text:`Оплатить через ${m[2]==="tribute"?"Tribute":"ЮMoney"}`,url:order.payment_url}],
                [b("🔄 Проверить оплату",`pay_status_${order.order_uid}`)],back(`learn_semester_${m[1]}_0`)]);
        } else if((m=data.match(/^pay_status_(ri_[a-f0-9]{32})$/))) {
            const user=await getTelegramUser(env,chatId);if(!user) throw new PaymentError("Откройте бот командой /start.");
            const order=await getSemesterOrder(env,user.id,m[1]);
            await send(env,chatId,order.status==="paid"?"✅ Оплата подтверждена. Откройте семестр.":"⏳ Подтверждение оплаты ещё не получено. Если деньги списаны, дождитесь уведомления или напишите в поддержку.",
                [[b("📚 Открыть семестр",`learn_semester_${order.semester_id}_0`)],[b("💬 Поддержка","support")]]);
        } else if(["admin_payments","admin_price"].includes(data)) await showAdmin(env,chatId);
        else if((m=data.match(/^pay_admin_page_(\d+)$/))) await showAdmin(env,chatId,Math.min(Number(m[1]),100000));
        else if((m=data.match(/^pay_admin_semester_(\d+)$/))) await showAdminSemester(env,chatId,Number(m[1]));
        else if((m=data.match(/^pay_master_(0|1)$/))) { await updatePaymentSettings(env,{settings:{payments_enabled:m[1]==="1"}});await showAdmin(env,chatId); }
        else if((m=data.match(/^pay_global_(tribute|yoomoney)_(0|1)$/))) { await updatePaymentSettings(env,{settings:{[`${m[1]}_enabled`]:m[2]==="1"}});await showAdmin(env,chatId); }
        else if((m=data.match(/^pay_set_(\d+)_(payment_enabled|tribute_enabled|yoomoney_enabled)_(0|1)$/))) { await updatePaymentSettings(env,{semesters:[{id:Number(m[1]),[m[2]]:m[3]==="1"}]});await showAdminSemester(env,chatId,Number(m[1])); }
        else if(data === "admin_payment_history" || (m=data.match(/^pay_history_(\d+)$/))) await showHistory(env,chatId,m?Math.min(Number(m[1]),100000):0);
        else if(data === "pay_help") {
            const settings=await getPaymentSettings(env);
            const origin=String(env.PUBLIC_APP_URL || "").replace(/\/$/,"");
            await send(env,chatId,`ℹ️ <b>Подключение оплаты</b>\n\nTribute: создайте отдельный цифровой продукт для каждого семестра. В настройках семестра укажите его ссылку, точную цену и валюту.\n\nЮMoney: укажите кошелёк, включите HTTP-уведомления в ЮMoney и задайте адрес ${esc(origin+settings.integration.yoomoney.webhook_path)}.\n\nСекреты провайдеров хранятся в Cloudflare. Подробные инструкции и состояние подключения доступны владельцу в приложении: «Админ-панель → Оплата».\n\nКнопка «Проверить оплату» только проверяет статус и сама не подтверждает платёж.`,[back("admin_payments")]);
        } else await send(env,chatId,"Кнопка устарела. Откройте раздел заново.",[back(admin?"admin_payments":"program")]);
    } catch(error) {
        await send(env,chatId,`❌ ${esc(error instanceof PaymentError ? error.message : "Не удалось выполнить действие. Попробуйте ещё раз.")}`,[back(admin?"admin":"program")]);
    }
    return true;
}

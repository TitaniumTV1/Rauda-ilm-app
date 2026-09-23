import {first,all,hasPermission,HttpError} from './school-core.js';
import {getSchoolSettings,listOffers,createOrder,ensureCommerceSchema} from './commerce.js';
import {ensureLearningSchema} from './learning.js';
import {handleLearningBot} from './telegram-learning.js';
const escape=s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const sectionMap={admin_students:['students','Ученики','students'],admin_groups:['groups','Группы','groups'],admin_exams:['exams','Экзамены','exams'],admin_certificates:['certificates','Сертификаты','certificates'],admin_stats:['stats','Статистика','overview'],admin_payments:['payments','Платежи','payments'],admin_settings:['settings','Настройки школы','settings']};
const textMap={'👥 Ученики':'admin_students','👨‍👩‍👧‍👦 Группы':'admin_groups','📝 Экзамены':'admin_exams','📜 Сертификаты':'admin_certificates','📊 Статистика':'admin_stats','💳 Оплата':'admin_payments','⚙️ Настройки школы':'admin_settings'};
export async function handleSchoolBot(env,update,user,send) {
    const chatId=user.telegram_id;
    const text=String(update.message?.text||'').trim();
    const data=String(update.callback_query?.data||'');
    if(text==='/learn'||text==='📖 Мои уроки'||text==='📚 Программа курса'||data==='program') {
        return handleLearningBot(env,{...update,message:{...update.message,chat:{id:chatId,type:'private'},from:{id:chatId},text:'/learn'}},user,send);
    }
    if(await handleLearningBot(env,update,user,send)) return true;
    if(text==='⚙️ Настройки школы') {
        const s=await getSchoolSettings(env.DB);
        await send(env,chatId,[
            '<b>⚙️ Настройки школы</b>',
            '',
            `Название: ${escape(s.school_name||'RAUDA ILM')}`,
            `Регистрация: ${s.registration_enabled?'включена':'выключена'}`,
            `Оплата: ${s.payments_enabled?'включена':'выключена'}`,
            `ЮKassa: ${s.yookassa_enabled?'включена':'выключена'}`,
            `Tribute: ${s.tribute_enabled?'включен':'выключен'}`
        ].join('\n'),{inline_keyboard:[[{text:'⬅️ Назад в управление',callback_data:'admin'}]]});
        return true;
    }
    if(data==='admin'||data.startsWith('admin_')) return false;
    if(text==='/terms'||text==='/paysupport'||text==='/support') {
        const s=await getSchoolSettings(env.DB); const url=text==='/terms'?s.terms_url:s.support_url;
        await send(env,chatId,url?escape(url):'Обратитесь в раздел «Поддержка» главного меню.');return true;
    }
    if(text==='🌐 Мой кабинет') {
        const s=await getSchoolSettings(env.DB);
        await send(env,chatId,'Уроки и прогресс в вашем кабинете. Для общего аккаунта выберите вход через Telegram или привяжите Telegram в профиле сайта.',{inline_keyboard:[[{text:'Открыть кабинет',url:'https://rauda-ilm-app.team-rauda-ilm.workers.dev/'}]]});return true;
    }
    const buy=data.match(/^school:buy:([a-f0-9-]{36})$/);
    if(buy) {
        const order=await createOrder(env,user,{offer_id:buy[1],provider:'tribute',channel:'telegram',request_key:`tg_${String(update.callback_query.id).replace(/[^A-Za-z0-9_-]/g,'').padStart(16,'0')}`});
        await send(env,chatId,'После подтверждения оплаты доступ появится в «Мои уроки».',{inline_keyboard:[[{text:'Оплатить в Tribute Stars',url:order.confirmation_url}],[{text:'Мои уроки',callback_data:'learn:home'}]]});return true;
    }
    if(text==='🛒 Оформить заказ'||data==='order'||data.startsWith('order_pay')) {
        const s=await getSchoolSettings(env.DB);const offers=(await listOffers(env,user,'telegram')).filter(o=>o.providers.includes('tribute'));
        const keyboard=offers.map(o=>[{text:`${o.name} · ${o.tribute_stars_amount} ⭐`,callback_data:`school:buy:${o.id}`}]);
        if(s.terms_url) keyboard.push([{text:'Условия обучения',url:s.terms_url}]);
        await send(env,chatId,offers.length?'Выберите тариф. Нажимая оплату, вы соглашаетесь с условиями обучения. Доступ действует в течение срока выбранного тарифа.':'Сейчас нет доступных тарифов для оплаты в Telegram. Обратитесь в поддержку.',{inline_keyboard:keyboard});return true;
    }
    // Old payment editing buttons cannot mutate a disconnected legacy price.
    const section=sectionMap[data] || (data.startsWith('admin_payment')||data.startsWith('admin_price')||data.startsWith('admin_tribute')?sectionMap.admin_payments:null);
    if(!section) return false;
    if(!await hasPermission(env.DB,user,section[0])) throw new HttpError(403,'Нет разрешения на этот раздел');
    await ensureCommerceSchema(env.DB);await ensureLearningSchema(env.DB);
    const s=await getSchoolSettings(env.DB);const lines=[`<b>${section[1]}</b>`,''];
    const rows=section[0]==='students'?await all(env.DB,"SELECT id,first_name,last_name,status FROM users WHERE role='student' ORDER BY id DESC LIMIT 10"):
        section[0]==='groups'?await all(env.DB,'SELECT id,name FROM groups ORDER BY id DESC LIMIT 10'):
        section[0]==='exams'?await all(env.DB,'SELECT id,title FROM exams ORDER BY id DESC LIMIT 10'):
        section[0]==='payments'?await all(env.DB,'SELECT id,status,amount_minor FROM school_orders ORDER BY created_at DESC LIMIT 10'):
        section[0]==='certificates'?await all(env.DB,'SELECT id,certificate_name,certificate_number FROM certificates ORDER BY id DESC LIMIT 10'):[];
    for(const r of rows) lines.push(escape(`${r.id} · ${r.name||r.title||r.certificate_name||r.first_name||r.status}${r.last_name?' '+r.last_name:''}${r.amount_minor?' · '+(r.amount_minor/100)+' ₽':''}${r.status?' · '+r.status:''}`));
    if(section[0]==='stats') for(const [table,label] of [['users','Аккаунтов'],['courses','Курсов'],['groups','Групп'],['school_orders','Заказов']]) lines.push(`${label}: ${(await first(env.DB,`SELECT COUNT(*) AS n FROM ${table}`)).n}`);
    else if(!rows.length&&section[0]!=='settings') lines.push('Записей пока нет.');
    lines.push('','Откройте этот раздел в панели школы для поиска, редактирования и подробной истории.');
    const url=new URL('/admin/',s.public_app_url||env.PUBLIC_APP_URL);url.hash=section[2];
    await send(env,chatId,lines.join('\n'),{inline_keyboard:[[{text:`Открыть: ${section[1]}`,url:url.href}],[{text:'Назад в управление',callback_data:'admin'}]]});return true;
}

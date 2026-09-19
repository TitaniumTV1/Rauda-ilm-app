import { getBotAccess, hasPermission } from "./bot-access.js";

const sections={
    students:{title:"👥 Ученики",permission:"students",query:"SELECT id,first_name,last_name,telegram_id,status FROM users WHERE role='student' ORDER BY id DESC",format:r=>`${r.first_name || "Ученик"} ${r.last_name || ""} · ${r.status === "active" ? "активен" : "доступ ограничен"} · ID ${r.telegram_id}`},
    groups:{title:"👨‍👩‍👧‍👦 Группы",permission:"groups",query:"SELECT g.id,g.name,COUNT(ug.id) AS members FROM groups g LEFT JOIN user_groups ug ON ug.group_id=g.id GROUP BY g.id ORDER BY g.id DESC",format:r=>`${r.name} · учеников: ${r.members}`},
    exams:{title:"📝 Экзамены",permission:"exams",query:"SELECT id,title,is_active FROM exams ORDER BY id DESC",format:r=>`${r.title} · ${r.is_active ? "активен" : "скрыт"}`},
    certificates:{title:"📜 Сертификаты",permission:"certificates",query:"SELECT id,certificate_number,certificate_name,is_valid FROM certificates ORDER BY id DESC",format:r=>`${r.certificate_number} · ${r.certificate_name} · ${r.is_valid ? "действует" : "отозван"}`}
};
const esc=v=>String(v ?? "").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const short=v=>[...String(v)].slice(0,180).join("");
async function send(env,id,text,rows){
    const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:id,text,parse_mode:"HTML",reply_markup:{inline_keyboard:rows}})});
    const data=await r.json();if(!r.ok || !data.ok) throw new Error("Telegram administration message failed");
}
export async function handleAdminOverview(env,callback){
    const match=String(callback.data || "").match(/^admin_(students|groups|exams|certificates|stats)(?:_page_(\d+))?$/);
    if(!match)return false;
    const chatId=callback.message?.chat?.id;
    if(callback.message?.chat?.type!=="private" || String(chatId)!==String(callback.from?.id)) return true;
    const kind=match[1],page=Math.min(Number(match[2]||0),100000),rows=[];
    const access=await getBotAccess(env,chatId);
    if((access.user && access.user.status!=="active") || !await hasPermission(env,chatId,kind)) {
        await send(env,chatId,"🔒 У вас нет доступа к этому разделу.",[[{text:"⬅️ Админ-панель",callback_data:"admin"}]]);return true;
    }
    let text;
    if(kind==="stats"){
        const result=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE role='student') AS students,
            (SELECT COUNT(*) FROM courses) AS courses,(SELECT COUNT(*) FROM semesters) AS semesters,
            (SELECT COUNT(*) FROM subjects) AS subjects,(SELECT COUNT(*) FROM lessons) AS lessons,
            (SELECT COUNT(*) FROM user_semesters WHERE status='active') AS grants`).first();
        text=`📊 <b>Статистика школы</b>\n\nУченики: ${result.students}\nКурсы: ${result.courses}\nСеместры: ${result.semesters}\nПредметы: ${result.subjects}\nУроки: ${result.lessons}\nАктивные доступы к семестрам: ${result.grants}`;
    }else{
        const section=sections[kind];
        const result=await env.DB.prepare(`${section.query} LIMIT 11 OFFSET ?`).bind(page*10).all();
        const items=result.results || [];
        text=`<b>${section.title}</b>\n\n${items.slice(0,10).map(r=>`• ${esc(short(section.format(r)))}`).join("\n") || "Записей пока нет."}`;
        if(page>0) rows.push([{text:"⬅️ Ещё",callback_data:`admin_${kind}_page_${page-1}`}]);
        if(items.length>10) rows.push([{text:"Ещё ➡️",callback_data:`admin_${kind}_page_${page+1}`}]);
    }
    rows.push([{text:"⬅️ Админ-панель",callback_data:"admin"}]);
    await send(env,chatId,text,rows);return true;
}

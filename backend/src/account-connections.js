import {HttpError,all,first,run,columns,tableExists} from './school-core.js';
import {getSchoolSettings} from './commerce.js';
const TTL = 10 * 60 * 1000;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,'0')).join('');
const escape = value => String(value??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
export async function connectionState(db,userId) {
    const u=await first(db,'SELECT * FROM users WHERE id=?',[userId]);
    if(!u) throw new HttpError(404,'Аккаунт не найден');
    const alternate=Boolean(u.login&&u.password_hash || u.email&&u.email_verified_at);
    return {telegram:{linked:Number(u.telegram_id)>0,id:Number(u.telegram_id)>0?String(u.telegram_id):null},email:{value:u.email||null,verified:Boolean(u.email_verified_at)},password:{configured:Boolean(u.password_hash)},can_unlink:alternate&&u.role!=='owner'};
}
export async function handleAccountRequest(request,env,ctx) {
    const path=new URL(request.url).pathname;
    if(!['/api/account/connections','/api/account/telegram/link','/api/account/telegram/unlink'].includes(path)) return null;
    const auth=await ctx.requireUser(request,env); if(!auth.ok) return ctx.authError(auth,env);
    const user=await first(env.DB,'SELECT * FROM users WHERE id=?',[auth.user.id]);
    if(path==='/api/account/connections'&&request.method==='GET') return ctx.json({ok:true,...await connectionState(env.DB,user.id)},200,env);
    if(request.method!=='POST') throw new HttpError(405,'Метод не поддерживается');
    if(path.endsWith('/link')) {
        if(Number(user.telegram_id)>0) throw new HttpError(409,'Telegram уже привязан');
        if(!user.login&&!user.email_verified_at) throw new HttpError(409,'Сначала добавьте способ входа на сайт');
        const settings=await getSchoolSettings(env.DB);
        const username=String(settings.telegram_bot_username||env.TELEGRAM_BOT_USERNAME||'');
        if(!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new HttpError(503,'Бот не настроен');
        const token=crypto.randomUUID().replaceAll('-','');
        const id=crypto.randomUUID().replaceAll('-','');
        const expiresAt=new Date(Date.now()+TTL).toISOString();
        await env.DB.batch([
            env.DB.prepare("UPDATE school_link_challenges SET status='cancelled' WHERE user_id=? AND status IN('pending','claimed')").bind(user.id),
            env.DB.prepare('INSERT INTO school_link_challenges(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').bind(id,user.id,await digest(token),expiresAt)
        ]);
        return ctx.json({ok:true,url:`https://t.me/${username}?start=link_${token}`,expires_at:expiresAt},200,env);
    }
    const state=await connectionState(env.DB,user.id);
    if(!state.telegram.linked) return ctx.json({ok:true,...state},200,env);
    if(!state.can_unlink) throw new HttpError(409,user.role==='owner'?'Привязка владельца защищена. Смену владельца нужно выполнять отдельно.':'Сначала подтвердите почту или добавьте пароль, чтобы сохранить вход');
    const body=await request.json();
    let verified=false;
    if(body.password&&user.password_hash) verified=await ctx.verifyPassword(String(body.password),user.password_hash);
    if(!verified&&body.code&&user.email_verified_at) {
        const result=await ctx.verifyEmailCode(env.DB,user.email,'unlink',String(body.code),env);
        verified=result.ok;
    }
    if(!verified) throw new HttpError(403,'Подтвердите пароль или код, отправленный на вашу почту');
    const token=auth.token;
    const technicalId=await ctx.generateTechnicalTelegramId(env.DB);
    await env.DB.batch([
        env.DB.prepare('UPDATE users SET telegram_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND telegram_id=?').bind(technicalId,user.id,user.telegram_id),
        env.DB.prepare('DELETE FROM school_identity_aliases WHERE user_id=?').bind(user.id),
        env.DB.prepare("UPDATE school_link_challenges SET status='cancelled' WHERE user_id=? AND status<>'confirmed'").bind(user.id),
        // Expire every other session, including sessions originally issued by Telegram.
        env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token<>?').bind(user.id,token),
        env.DB.prepare("INSERT INTO school_account_events(user_id,action,telegram_id) VALUES(?,'telegram_unlinked',?)").bind(user.id,user.telegram_id)
    ]);
    return ctx.json({ok:true,...await connectionState(env.DB,user.id)},200,env);
}

// Both sides prove possession: authenticated website creates a short-lived secret,
// verified private Telegram update claims it, then the user confirms in that chat.
export async function handleAccountBot(env,update,send) {
    const message=update.message, callback=update.callback_query;
    const from=message?.from||callback?.from, chat=message?.chat||callback?.message?.chat;
    if(chat?.type!=='private'||String(chat.id)!==String(from?.id)) return false;
    const match=String(message?.text||'').match(/^\/start(?:@\w+)? link_([a-f0-9]{32})$/);
    const action=String(callback?.data||'').match(/^account:(confirm|cancel):([a-f0-9]{32})$/);
    if(!match&&!action) return false;
    const now=new Date().toISOString();
    const challenge=match
        ? await first(env.DB,"SELECT * FROM school_link_challenges WHERE token_hash=? AND status IN('pending','claimed') AND expires_at>?",[await digest(match[1]),now])
        : await first(env.DB,"SELECT * FROM school_link_challenges WHERE id=? AND status='claimed' AND telegram_id=? AND expires_at>?",[action[2],from.id,now]);
    if(!challenge) {await send(env,chat.id,'Ссылка недействительна или уже использована. Создайте новую в настройках сайта.');return true;}
    if(match) {
        const result=await run(env.DB,"UPDATE school_link_challenges SET status='claimed',telegram_id=? WHERE id=? AND (status='pending' OR telegram_id=?) AND expires_at>?",[from.id,challenge.id,from.id,now]);
        if(!result.meta?.changes) {await send(env,chat.id,'Эта ссылка уже открыта другим аккаунтом. Создайте новую.');return true;}
        const target=await first(env.DB,'SELECT id,first_name,login FROM users WHERE id=?',[challenge.user_id]);
        await send(env,chat.id,`Связать Telegram с аккаунтом сайта <b>${escape(target.login||target.first_name||target.id)}</b>?\nУроки, оплаты и прогресс будут общими. Если вы не создавали эту ссылку на сайте, нажмите «Отмена».`,{inline_keyboard:[[{text:'Подтвердить связь',callback_data:`account:confirm:${challenge.id}`}],[{text:'Отмена',callback_data:`account:cancel:${challenge.id}`}]]});
        return true;
    }
    if(action[1]==='cancel') {
        await run(env.DB,"UPDATE school_link_challenges SET status='cancelled' WHERE id=? AND telegram_id=?",[challenge.id,from.id]);
        await send(env,chat.id,'Привязка отменена.');return true;
    }
    const target=await first(env.DB,'SELECT * FROM users WHERE id=?',[challenge.user_id]);
    const source=await first(env.DB,'SELECT * FROM users WHERE telegram_id=?',[from.id]);
    if(!target||target.status!=='active'||Number(target.telegram_id)>0) {await send(env,chat.id,'Аккаунт сайта недоступен или уже связан. Создайте новую ссылку.');return true;}
    // A separate established login or privileged account must never be silently merged.
    if(source && (source.role!=='student'||source.status!=='active'||source.login||source.email_verified_at)) {
        await send(env,chat.id,'Этот Telegram уже связан с отдельным аккаунтом школы. Войдите на сайт через Telegram и используйте его профиль. Автоматическое объединение двух самостоятельных аккаунтов отключено.');return true;
    }
    // The first statement is a transactional gate: a NULL or repeated key aborts
    // the entire batch, including concurrent confirmations of the same challenge.
    const statements=[env.DB.prepare(`INSERT INTO school_link_receipts(challenge_id)
        VALUES((SELECT c.id FROM school_link_challenges c JOIN users u ON u.id=c.user_id
        WHERE c.id=? AND c.status='claimed' AND c.telegram_id=? AND c.expires_at>?
          AND u.status='active' AND u.telegram_id<=0
          AND NOT EXISTS(SELECT 1 FROM users s WHERE s.telegram_id=? AND
            (s.role<>'student' OR s.status<>'active' OR s.login IS NOT NULL OR s.email_verified_at IS NOT NULL))))`).bind(challenge.id,from.id,now,from.id)];
    if(source&&source.id!==target.id) {
        // A bot-only account has no independent login. Preserve its learning history.
        const composite={user_courses:['course_id'],user_semesters:['semester_id'],user_program_access:['program_id'],user_programs:['program_id'],user_groups:['group_id'],lesson_progress:['lesson_id'],school_playback:['lesson_id'],school_media_progress:['lesson_id','file_id'],assessment_access:['assessment_type','assessment_id'],assessment_retake_permissions:['assessment_type','assessment_id']};
        for(const [table,keys] of Object.entries(composite)) {
            if(!await tableExists(env.DB,table)) continue;
            const cols=(await columns(env.DB,table)).filter(c=>c!=='id');
            if(!cols.includes('user_id')||keys.some(k=>!cols.includes(k))) continue;
            const select=cols.map(c=>c==='user_id'?'?':`s.${c}`);
            statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(',')}) SELECT ${select.join(',')} FROM ${table} s WHERE s.user_id=?`).bind(target.id,source.id));
            if(table==='lesson_progress') {
                for(const field of ['completed','is_completed','progress_percent'].filter(c=>cols.includes(c))) statements.push(env.DB.prepare(`UPDATE lesson_progress SET ${field}=MAX(${field},COALESCE((SELECT s.${field} FROM lesson_progress s WHERE s.user_id=? AND s.lesson_id=lesson_progress.lesson_id),0)) WHERE user_id=?`).bind(source.id,target.id));
            }
            // Preserve the longer active access while never overriding an explicit block.
            const expiry=cols.includes('access_until')?'access_until':cols.includes('expires_at')?'expires_at':null;
            if(expiry&&cols.includes('status')) {
                const relation=keys.map(k=>`s.${k}=${table}.${k}`).join(' AND ');
                statements.push(env.DB.prepare(`UPDATE ${table} SET ${expiry}=CASE
                    WHEN ${expiry} IS NULL OR (SELECT s.${expiry} FROM ${table} s WHERE s.user_id=? AND ${relation}) IS NULL THEN NULL
                    ELSE MAX(${expiry},(SELECT s.${expiry} FROM ${table} s WHERE s.user_id=? AND ${relation})) END
                    WHERE user_id=? AND status='active' AND EXISTS(SELECT 1 FROM ${table} s WHERE s.user_id=? AND ${relation} AND s.status='active')`).bind(source.id,source.id,target.id,source.id));
            }
        }
        for(const table of ['payments','tribute_orders','yookassa_orders','test_attempts','exam_attempts','certificates','school_entitlements','school_checkout_intents','school_exam_attempts','school_certificate_issues']) {
            if(await tableExists(env.DB,table)&&(await columns(env.DB,table)).includes('user_id')) statements.push(env.DB.prepare(`UPDATE ${table} SET user_id=? WHERE user_id=?`).bind(target.id,source.id));
        }
        const min=await first(env.DB,'SELECT MIN(telegram_id) AS value FROM users');
        const synthetic=Math.min(-1,Number(min?.value||0)-1);
        statements.push(env.DB.prepare("UPDATE users SET telegram_id=?,status='blocked',blocked_reason='Аккаунт перенесён при подтверждённой привязке',updated_at=CURRENT_TIMESTAMP WHERE id=? AND role='student'").bind(synthetic,source.id));
        statements.push(env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(source.id));
    }
    // Conditional claim makes repeated callbacks harmless; one D1 batch is atomic.
    statements.push(env.DB.prepare("UPDATE school_link_challenges SET status='confirmed',confirmed_at=? WHERE id=? AND status='claimed' AND telegram_id=? AND expires_at>?").bind(now,challenge.id,from.id,now));
    statements.push(env.DB.prepare('UPDATE users SET telegram_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(from.id,target.id));
    if(source&&source.id!==target.id&&await tableExists(env.DB,'school_orders')) statements.push(env.DB.prepare('UPDATE school_orders SET user_id=? WHERE user_id=?').bind(target.id,source.id));
    statements.push(env.DB.prepare("INSERT INTO school_account_events(user_id,action,telegram_id) VALUES(?,'telegram_linked',?)").bind(target.id,from.id));
    try { await env.DB.batch(statements); }
    catch(error) {
        if(!await first(env.DB,'SELECT challenge_id FROM school_link_receipts WHERE challenge_id=?',[challenge.id])) throw error;
        await send(env,chat.id,'Привязка уже подтверждена. Откройте /learn.');return true;
    }
    await send(env,chat.id,'Telegram связан. Оплаты и прогресс доступны в боте и на сайте. Откройте /learn. Отвязать Telegram можно в настройках сайта после подтверждения входа.');
    return true;
}

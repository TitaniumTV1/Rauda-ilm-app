import {ensureSchoolSchema} from './school-schema.js';
import {handleAccountRequest} from './account-connections.js';
import {handleCommerceRequest,getSchoolSettings,ensureCommerceSchema} from './commerce.js';
import {handleLearningRequest,ensureLearningSchema} from './learning.js';
import {HttpError,hasPermission,canonicalPermission,adminCourseAllowed,resolveScope,all,first,run,saveProgress,assertLessonAccess,audit} from './school-core.js';

export function permissionForPath(path) {
    if(/^\/api\/admin\/(users|school-settings|settings)/.test(path)) return 'settings';
    if(/\/admin\/(offers|payments|payment-events)/.test(path)) return 'payments';
    if(/\/admin\/learning\/groups/.test(path)) return 'groups';
    if(/\/admin\/learning\/certificates/.test(path)) return 'certificates';
    if(/assessment|\/exams|\/grade|\/retake/.test(path)) return 'exams';
    if(/\/students/.test(path)) return 'students';
    if(/\/stats|\/dashboard/.test(path)) return 'stats';
    if(/\/schedules?/.test(path)) return 'schedule';
    return 'courses';
}
export async function guardSchoolRequest(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith('/api/')) return;
    if(!env.DB) throw new HttpError(503,'База школы не подключена');
    await ensureSchoolSchema(env.DB);
    const isWebhook=path.startsWith('/api/webhooks/');
    if(request.method==='POST'&&env.AUTH_RATE_LIMITER&&(path.startsWith('/api/auth/')||path.startsWith('/api/account/'))) {
        const {success}=await env.AUTH_RATE_LIMITER.limit({key:`school-auth:${request.headers.get('CF-Connecting-IP')||'local'}`});
        if(!success) throw new HttpError(429,'Слишком много попыток. Подождите минуту.');
    }
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!isWebhook) {
        const origin=request.headers.get('Origin');
        const allowed=[url.origin,env.PUBLIC_APP_URL,env.CORS_ORIGIN].filter(Boolean).map(v=>{try{return new URL(v).origin;}catch{return '';}});
        if(origin&&!allowed.includes(origin)||request.headers.get('Sec-Fetch-Site')==='cross-site') throw new HttpError(403,'Запрос с другого сайта запрещён');
    }
    if(path.startsWith('/api/admin/')) {
        const auth=await ctx.requireUser(request,env);
        if(!auth.ok) throw new HttpError(auth.status,auth.error);
        const permission=permissionForPath(path);
        if(!await hasPermission(env.DB,auth.user,permission)) throw new HttpError(403,'Нет разрешения на этот раздел');
        // Legacy mutations need the same course boundary as new routes.
        if(permission==='courses'&&auth.user.role==='admin') {
            let target=null;
            const scopes=await all(env.DB,'SELECT course_id FROM admin_courses WHERE admin_id=?',[auth.user.id]);
            if(scopes.length&&path==='/api/admin/courses'&&request.method==='POST') throw new HttpError(403,'Создавать новые курсы может администратор без ограничения по курсам');
            const match=path.match(/\/(courses|programs|semesters|subjects|lessons|lesson-files)\/(\d+)/);
            if(match) {
                const table=match[1]==='lesson-files'?'lesson_files':match[1];
                const row=await first(env.DB,`SELECT * FROM ${table} WHERE id=?`,[Number(match[2])]);
                if(row) target=table==='courses'?row.id:row.course_id;
            }
            if(!target&&!['GET','HEAD'].includes(request.method)&&request.headers.get('content-type')?.includes('application/json')) {
                const body=await request.clone().json(); target=Number(body.course_id)||null;
            }
            if(target&&!await adminCourseAllowed(env.DB,auth.user,target)) throw new HttpError(403,'Нет доступа к этому курсу');
        }
    }
    const settings=await getSchoolSettings(env.DB);
    const disabled=v=>v===false||v===0||v==='0'||v==='false';
    const enabled=v=>v===true||v===1||v==='1'||v==='true';
    if(['/api/auth/register','/api/auth/email/register'].includes(path)&&disabled(settings.registration_enabled)) throw new HttpError(403,'Регистрация временно закрыта');
    if(enabled(settings.maintenance_mode)&&!isWebhook&&!path.startsWith('/api/auth/')&&!path.startsWith('/api/admin/')&&path!=='/api/public/settings'&&path!=='/api/health') {
        const auth=await ctx.requireUser(request,env);
        if(!auth.ok||auth.user.role!=='owner') throw new HttpError(503,'Проводятся технические работы. Попробуйте позже.');
    }
}
export async function handleSchoolRequest(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith('/api/')) return null;
    if(path==='/api/public/settings'&&request.method==='GET') {
        const s=await getSchoolSettings(env.DB);
        const keys=['school_name','school_description','support_url','telegram_channel','registration_enabled','maintenance_mode','terms_url','privacy_url'];
        return ctx.json({ok:true,settings:{...Object.fromEntries(keys.map(k=>[k,s[k]??''])),telegram_bot_username:s.telegram_bot_username||env.TELEGRAM_BOT_USERNAME||''}},200,env);
    }
    if(path==='/api/admin/settings') throw new HttpError(410,'Настройки перенесены в раздел «Настройки школы»');
    if(path==='/api/admin/courses'&&request.method==='GET') {
        const auth=await ctx.requireAdminPermission(request,env,'courses');if(!auth.ok)return ctx.authError(auth,env);
        const rows=await all(env.DB,'SELECT * FROM courses ORDER BY id');
        const allowed=await Promise.all(rows.map(row=>adminCourseAllowed(env.DB,auth.user,row.id)));
        return ctx.json({ok:true,courses:rows.filter((_,i)=>allowed[i])},200,env);
    }
    const studentAccess=path.match(/^\/api\/admin\/students\/(\d+)\/access(?:\/([a-f0-9-]{36}))?$/);
    if(studentAccess) {
        const auth=await ctx.requireUser(request,env);if(!auth.ok)return ctx.authError(auth,env);
        if(auth.user.role!=='owner')throw new HttpError(403,'Ручную выдачу доступа выполняет владелец');
        await ensureCommerceSchema(env.DB);
        const uid=Number(studentAccess[1]),grantId=studentAccess[2];
        if(!await first(env.DB,"SELECT id FROM users WHERE id=? AND role='student'",[uid]))throw new HttpError(404,'Ученик не найден');
        if(request.method==='GET'&&!grantId)return ctx.json({ok:true,grants:await all(env.DB,'SELECT * FROM school_entitlements WHERE user_id=? ORDER BY created_at DESC',[uid]),legacy_courses:await all(env.DB,'SELECT * FROM user_courses WHERE user_id=?',[uid]),legacy_semesters:await all(env.DB,'SELECT * FROM user_semesters WHERE user_id=?',[uid])},200,env);
        if(request.method==='DELETE'&&grantId) {
            const grant=await first(env.DB,'SELECT * FROM school_entitlements WHERE id=? AND user_id=?',[grantId,uid]);
            if(!grant||grant.source!=='manual')throw new HttpError(409,'Платный доступ изменяется через платёж; здесь можно отозвать только ручную выдачу');
            await run(env.DB,"UPDATE school_entitlements SET status='revoked',updated_at=? WHERE id=?",[new Date().toISOString(),grant.id]);
            await audit(env.DB,auth.user,'access.revoke','user',uid,{grant_id:grant.id});return ctx.json({ok:true},200,env);
        }
        if(request.method==='POST'&&!grantId) {
            const b=await request.json(),type=b.scope_type,sid=Number(b.scope_id),days=Number(b.access_days),unlimited=b.access_unlimited===true;
            if(!['course','program','semester'].includes(type)||!Number.isSafeInteger(sid)||sid<1)throw new HttpError(400,'Выберите курс, программу или семестр');
            if(!unlimited&&(!Number.isInteger(days)||days<1||days>36500))throw new HttpError(400,'Задайте срок доступа в днях или явно выберите бессрочный доступ');
            if(!/^[A-Za-z0-9_-]{16,64}$/.test(String(b.request_key||'')))throw new HttpError(400,'Требуется уникальный ключ выдачи');
            const reason=String(b.reason||'').trim();if(reason.length<3||reason.length>500)throw new HttpError(400,'Укажите причину выдачи доступа (3–500 символов)');
            const scope=await resolveScope(env.DB,{[type+'_id']:sid});if(!scope?.active)throw new HttpError(400,'Учебный раздел не найден или скрыт');
            const orderKey=`${uid}:${b.request_key}`,existing=await first(env.DB,"SELECT * FROM school_entitlements WHERE source='manual' AND source_order_id=?",[orderKey]);
            if(existing) {
                const priorDays=existing.expires_at?(Date.parse(existing.expires_at)-Date.parse(existing.starts_at))/86400000:null;
                if(existing.scope_type!==type||existing.scope_id!==sid||priorDays!==(unlimited?null:days))throw new HttpError(409,'Ключ выдачи уже использован с другими параметрами');
                return ctx.json({ok:true,grant:existing},200,env);
            }
            const id=crypto.randomUUID(),now=new Date().toISOString(),expires=unlimited?null:new Date(Date.parse(now)+days*86400000).toISOString();
            await env.DB.batch([
                env.DB.prepare("INSERT OR IGNORE INTO school_entitlements(id,user_id,source,source_order_id,scope_type,scope_id,course_id,program_id,semester_id,status,starts_at,expires_at,created_at,updated_at) VALUES(?,?,'manual',?,?,?,?,?,?,'active',?,?,?,?)").bind(id,uid,orderKey,type,sid,scope.course_id,scope.program_id,scope.semester_id,now,expires,now,now),
                env.DB.prepare("INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,details) SELECT ?,'access.grant','user',?,? WHERE EXISTS(SELECT 1 FROM school_entitlements WHERE id=?)").bind(auth.user.id,uid,JSON.stringify({grant_id:id,reason}),id)
            ]);
            return ctx.json({ok:true,grant:await first(env.DB,"SELECT * FROM school_entitlements WHERE source='manual' AND source_order_id=?",[orderKey])},201,env);
        }
        throw new HttpError(405,'Метод не поддерживается');
    }
    const studentProgress=path.match(/^\/api\/admin\/students\/(\d+)\/progress$/);
    if(studentProgress&&request.method==='GET') {
        const auth=await ctx.requireAdminPermission(request,env,'students');if(!auth.ok)return ctx.authError(auth,env);
        const student=await first(env.DB,"SELECT id,account_id,first_name,last_name,role,status FROM users WHERE id=? AND role='student'",[Number(studentProgress[1])]);
        if(!student)throw new HttpError(404,'Ученик не найден');
        const lessons=await all(env.DB,`SELECT l.id,l.title,l.course_id,l.semester_id,p.completed,p.is_completed,p.progress_percent,p.updated_at FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=? ORDER BY l.course_id,l.sort_order,l.id`,[student.id]);
        return ctx.json({ok:true,user:student,lessons,summary:{started:lessons.length,completed:lessons.filter(l=>l.completed||l.is_completed).length}},200,env);
    }
    const accounts=await handleAccountRequest(request,env,ctx); if(accounts) return accounts;
    const commerce=await handleCommerceRequest(request,env,ctx); if(commerce) return commerce;
    if(path.startsWith('/api/learning/')||path.startsWith('/api/admin/learning/')||path==='/api/admin/students/retake') {
        const learning=await handleLearningRequest(request,env,ctx); if(learning) return learning;
    }
    if(path==='/api/progress') {
        const auth=await ctx.requireUser(request,env); if(!auth.ok) return ctx.authError(auth,env);
        if(request.method==='POST') {
            const body=await request.json();
            const progress=await saveProgress(env.DB,auth.user,body.lesson_id,{...body,completed:body.completed===true||body.is_completed===true});
            return ctx.json({ok:true,progress},200,env);
        }
        if(request.method==='GET') {
            const id=Number(url.searchParams.get('lesson_id'));
            const lesson=await first(env.DB,'SELECT * FROM lessons WHERE id=?',[id]);
            await assertLessonAccess(env.DB,auth.user,lesson);
            const progress=await first(env.DB,'SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?',[auth.user.id,id]);
            const fileId=Number(url.searchParams.get('file_id')||0);
            if(fileId&&!await first(env.DB,'SELECT id FROM lesson_files WHERE id=? AND lesson_id=?',[fileId,id])) throw new HttpError(404,'Материал не найден');
            const playback=await first(env.DB,'SELECT position_seconds,duration_seconds,updated_at FROM school_media_progress WHERE user_id=? AND lesson_id=? AND file_id=?',[auth.user.id,id,fileId]);
            return ctx.json({ok:true,progress:{...progress,...playback}},200,env);
        }
    }
    if(path==='/api/admin/students/status'&&request.method==='POST') {
        const auth=await ctx.requireAdminPermission(request,env,'students'); if(!auth.ok) return ctx.authError(auth,env);
        const body=await request.json(); const target=await first(env.DB,'SELECT * FROM users WHERE id=?',[Number(body.user_id)]);
        if(!target||target.role!=='student') throw new HttpError(403,'Здесь можно изменять статус только ученика');
        if(!['active','blocked'].includes(body.status)) throw new HttpError(400,'Недопустимый статус');
        await run(env.DB,'UPDATE users SET status=?,blocked_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[body.status,body.status==='blocked'?String(body.reason||'Доступ ограничен администратором').slice(0,500):null,target.id]);
        if(body.status==='blocked') await run(env.DB,'DELETE FROM auth_sessions WHERE user_id=?',[target.id]);
        await audit(env.DB,auth.user,'student_status','user',target.id,{status:body.status});
        return ctx.json({ok:true},200,env);
    }
    if(path==='/api/admin/course-rules'&&['GET','PUT'].includes(request.method)) {
        const auth=await ctx.requireAdminPermission(request,env,'courses'); if(!auth.ok) return ctx.authError(auth,env);
        const body=request.method==='PUT'?await request.json():{};
        const id=Number(body.course_id||url.searchParams.get('course_id'));
        if(!await adminCourseAllowed(env.DB,auth.user,id)) throw new HttpError(403,'Нет доступа к курсу');
        if(request.method==='PUT') await run(env.DB,'INSERT INTO school_course_rules(course_id,sequential_lessons) VALUES(?,?) ON CONFLICT(course_id) DO UPDATE SET sequential_lessons=excluded.sequential_lessons',[id,body.sequential_lessons===false?0:1]);
        return ctx.json({ok:true,rules:await first(env.DB,'SELECT * FROM school_course_rules WHERE course_id=?',[id])||{course_id:id,sequential_lessons:1}},200,env);
    }
    return null;
}

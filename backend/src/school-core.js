// Shared authorization and progress rules for the website and Telegram.
export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export async function all(db, sql, args = []) { return (await db.prepare(sql).bind(...args).all()).results || []; }
export function first(db, sql, args = []) { return db.prepare(sql).bind(...args).first(); }
export function run(db, sql, args = []) { return db.prepare(sql).bind(...args).run(); }
export function json(data, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
export const PERMISSIONS = Object.freeze(['courses','students','groups','exams','payments','certificates','stats','schedule','settings']);
const aliases = { content: 'courses', assessments: 'exams', grades: 'exams' };
export function canonicalPermission(key) { return aliases[key] || key; }
export async function hasPermission(db, user, key) {
    if (!user || user.status !== 'active') return false;
    if (user.role === 'owner') return true;
    if (key === 'settings' || key === 'administrators') return false;
    if (user.role === 'superadmin') return true;
    if (user.role !== 'admin') return false;
    const wanted = canonicalPermission(key);
    const rows = await all(db, 'SELECT permission FROM admin_permissions WHERE admin_id = ?', [user.id]);
    return rows.some(row => canonicalPermission(row.permission) === wanted);
}
export async function requirePermission(db, user, key) {
    if (!await hasPermission(db,user,key)) throw new HttpError(403,'Нет разрешения на это действие');
}
export async function columns(db, table) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table');
    return (await all(db, `PRAGMA table_info(${table})`)).map(c => c.name);
}
export async function tableExists(db, table) { return Boolean(await first(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table])); }
export async function addColumn(db, table, name, type) {
    if (!(await columns(db,table)).includes(name)) await run(db,`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
export function dateActive(value, now = Date.now()) {
    if (!value) return true;
    const date = Date.parse(/[TZ+]/.test(value) ? value : value.replace(' ', 'T') + 'Z');
    return Number.isFinite(date) && date > now;
}
export async function adminCourseAllowed(db,user,courseId) {
    if (!await hasPermission(db,user,'courses')) return false;
    if (['owner','superadmin'].includes(user.role)) return true;
    const rows = await all(db,'SELECT course_id FROM admin_courses WHERE admin_id=?',[user.id]);
    return !rows.length || rows.some(r=>Number(r.course_id)===Number(courseId));
}
export async function resolveScope(db, target) {
    const scope = { course_id: Number(target.course_id)||null, program_id: Number(target.program_id)||null, semester_id: Number(target.semester_id)||null };
    let semester,program,course;
    if (scope.semester_id) {
        semester=await first(db,'SELECT * FROM semesters WHERE id=?',[scope.semester_id]);
        if(!semester) return null;
        if(scope.course_id && scope.course_id!==Number(semester.course_id) || scope.program_id && scope.program_id!==Number(semester.program_id)) return null;
        scope.program_id=Number(semester.program_id); scope.course_id=Number(semester.course_id);
    }
    if(scope.program_id) {
        program=await first(db,'SELECT * FROM programs WHERE id=?',[scope.program_id]);
        if(!program || scope.course_id && scope.course_id!==Number(program.course_id)) return null;
        scope.course_id=Number(program.course_id);
    }
    if(scope.course_id) course=await first(db,'SELECT * FROM courses WHERE id=?',[scope.course_id]);
    if(!course) return null;
    return {...scope, active:[course,program,semester].filter(Boolean).every(r=>Number(r.is_active ?? 1)===1)};
}
export async function canReadScope(db,user,target) {
    if(!user || user.status!=='active') return false;
    const scope=await resolveScope(db,target); if(!scope) return false;
    if(await adminCourseAllowed(db,user,scope.course_id)) return true;
    if(!scope.active) return false;
    const course=await first(db,'SELECT * FROM user_courses WHERE user_id=? AND course_id=?',[user.id,scope.course_id]);
    if(course?.status==='blocked') return false;
    if(scope.semester_id) {
        const grant=await first(db,'SELECT * FROM user_semesters WHERE user_id=? AND semester_id=?',[user.id,scope.semester_id]);
        if(grant?.status==='blocked') return false;
        if(grant?.status==='active' && dateActive(grant.access_until)) return true;
    }
    if(await tableExists(db,'school_entitlements')) {
        const grants=await all(db,"SELECT * FROM school_entitlements WHERE user_id=? AND status='active'",[user.id]);
        if(grants.some(g=>{
            if(!dateActive(g.expires_at) || g.starts_at && Date.parse(g.starts_at)>Date.now()) return false;
            if(g.semester_id) return Number(g.semester_id)===scope.semester_id;
            if(g.program_id) return Number(g.program_id)===scope.program_id;
            return Number(g.course_id)===scope.course_id;
        })) return true;
    }
    if(scope.program_id && await tableExists(db,'user_program_access')) {
        const grant=await first(db,'SELECT * FROM user_program_access WHERE user_id=? AND program_id=?',[user.id,scope.program_id]);
        if(grant?.status==='active' && dateActive(grant.expires_at)) return true;
    }
    return course?.status==='active' && dateActive(course.access_until) || false;
}
export async function assertLessonAccess(db,user,lesson,{sequential=true}={}) {
    if(!lesson) throw new HttpError(404,'Урок не найден');
    if(await adminCourseAllowed(db,user,lesson.course_id)) return;
    if(Number(lesson.is_visible ?? 1)!==1 || !await canReadScope(db,user,lesson)) throw new HttpError(403,'Нет доступа к этому уроку');
    if(lesson.subject_id) {
        const subject=await first(db,'SELECT is_active FROM subjects WHERE id=?',[lesson.subject_id]);
        if(!subject || Number(subject.is_active)!==1) throw new HttpError(403,'Предмет недоступен');
    }
    if(!sequential) return;
    const rule=await tableExists(db,'school_course_rules') ? await first(db,'SELECT sequential_lessons FROM school_course_rules WHERE course_id=?',[lesson.course_id]) : null;
    if(rule && Number(rule.sequential_lessons)===0) return;
    const lessons=await all(db,'SELECT l.id,l.sort_order FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id WHERE l.semester_id=? AND l.is_visible=1 AND (l.subject_id IS NULL OR s.is_active=1) ORDER BY l.sort_order,l.id',[lesson.semester_id]);
    const index=lessons.findIndex(l=>Number(l.id)===Number(lesson.id));
    if(index<=0) return;
    const progressColumns=await columns(db,'lesson_progress');
    const done='('+['is_completed','completed'].filter(c=>progressColumns.includes(c)).map(c=>`${c}=1`).join(' OR ')+')';
    const completed=new Set((await all(db,`SELECT lesson_id FROM lesson_progress WHERE user_id=? AND ${done}`,[user.id])).map(r=>Number(r.lesson_id)));
    if(lessons.slice(0,index).some(l=>!completed.has(Number(l.id)))) throw new HttpError(409,'Сначала завершите предыдущие уроки');
}
export async function saveProgress(db,user,lessonId,input={}) {
    const lesson=await first(db,'SELECT * FROM lessons WHERE id=?',[Number(lessonId)]);
    await assertLessonAccess(db,user,lesson);
    const fileId=Number(input.file_id||0);
    if(!Number.isSafeInteger(fileId)||fileId<0) throw new HttpError(400,'Некорректный материал');
    if(fileId&&!await first(db,'SELECT id FROM lesson_files WHERE id=? AND lesson_id=?',[fileId,lesson.id])) throw new HttpError(404,'Материал не найден в уроке');
    const hasPlayback=input.position_seconds!==undefined||input.duration_seconds!==undefined;
    const position=Number(input.position_seconds),duration=Number(input.duration_seconds);
    if(hasPlayback&&(!Number.isFinite(position)||position<0||position>86400||!Number.isFinite(duration)||duration<0||duration>86400)) throw new HttpError(400,'Некорректная позиция воспроизведения');
    const cols=await columns(db,'lesson_progress');
    const prior=await first(db,'SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?',[user.id,lesson.id]);
    // Completion is monotonic; a delayed player event cannot undo a Telegram completion.
    const completed=Boolean(prior?.completed || prior?.is_completed || input.completed===true);
    const values={user_id:user.id,course_id:lesson.course_id,lesson_id:lesson.id,completed:completed?1:0,is_completed:completed?1:0,progress_percent:completed?100:Number(prior?.progress_percent||0),completed_at:completed?(prior?.completed_at||new Date().toISOString()):null,updated_at:new Date().toISOString()};
    const keys=Object.keys(values).filter(k=>cols.includes(k));
    const updates=keys.filter(k=>!['user_id','lesson_id','course_id'].includes(k));
    const updateSql=updates.map(k=>['completed','is_completed','progress_percent'].includes(k)?`${k}=MAX(lesson_progress.${k},excluded.${k})`:k==='completed_at'?`${k}=COALESCE(lesson_progress.${k},excluded.${k})`:`${k}=excluded.${k}`);
    await run(db,`INSERT INTO lesson_progress (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')}) ON CONFLICT(user_id,lesson_id) DO UPDATE SET ${updateSql.join(',')}`,keys.map(k=>values[k]));
    if(hasPlayback) {
        await run(db,`INSERT INTO school_media_progress(user_id,lesson_id,file_id,position_seconds,duration_seconds,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,lesson_id,file_id) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`,[user.id,lesson.id,fileId,Math.min(position,duration||position),duration,new Date().toISOString()]);
    }
    const progress=await first(db,'SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?',[user.id,lesson.id]);
    const playback=await first(db,'SELECT * FROM school_media_progress WHERE user_id=? AND lesson_id=? AND file_id=?',[user.id,lesson.id,fileId]);
    return {...progress,position_seconds:playback?.position_seconds||0,duration_seconds:playback?.duration_seconds||0};
}
export async function audit(db,user,action,entityType,entityId,details={}) {
    await run(db,'INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[user?.id||null,action,entityType,String(entityId),JSON.stringify(details)]);
}

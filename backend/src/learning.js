import {
    all, first, run, HttpError, json, requirePermission, canReadScope,
    assertLessonAccess, saveProgress
} from './school-core.js';

// Only additive tables are created here. Original records stay visible to the
// existing grading, payment, recovery and Telegram integrations.
const schema = [
    `CREATE TABLE IF NOT EXISTS school_exam_rules (exam_id INTEGER PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE, require_all_lessons INTEGER NOT NULL DEFAULT 1, required_lesson_ids TEXT NOT NULL DEFAULT '[]', assignment_required INTEGER NOT NULL DEFAULT 0, certificate_required INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS school_exam_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, target_type TEXT NOT NULL CHECK(target_type IN ('user','group')), target_id INTEGER NOT NULL, is_open INTEGER NOT NULL DEFAULT 1, opens_at TEXT, closes_at TEXT, granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, UNIQUE(exam_id,target_type,target_id))`,
    `CREATE TABLE IF NOT EXISTS school_exam_attempts (attempt_id INTEGER PRIMARY KEY REFERENCES exam_attempts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('started','submitted','timed_out')), deadline_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, created_at TEXT NOT NULL, submitted_at TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS school_exam_one_active ON school_exam_attempts(user_id,exam_id) WHERE status='started'`,
    `CREATE TABLE IF NOT EXISTS school_group_scopes (group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE, program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL, semester_id INTEGER REFERENCES semesters(id) ON DELETE SET NULL, cohort TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS school_certificate_rules (course_id INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE, require_progress INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL DEFAULT 'Сертификат об окончании', issuer TEXT NOT NULL DEFAULT 'RAUDA ILM', accent TEXT NOT NULL DEFAULT '#126b55', footer TEXT NOT NULL DEFAULT 'Выдан по результатам обучения')`,
    `CREATE TABLE IF NOT EXISTS school_learning_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS school_telegram_exam_answers (telegram_id TEXT NOT NULL, attempt_id INTEGER NOT NULL REFERENCES school_exam_attempts(attempt_id) ON DELETE CASCADE, answers_json TEXT NOT NULL DEFAULT '{}', question_index INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(telegram_id,attempt_id))`,
    `CREATE TABLE IF NOT EXISTS assessment_access (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, assessment_type TEXT NOT NULL CHECK(assessment_type IN ('test','exam')), assessment_id INTEGER NOT NULL, is_open INTEGER, extra_attempts INTEGER NOT NULL DEFAULT 0, opens_at TEXT, closes_at TEXT, reason TEXT, granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,assessment_type,assessment_id))`
];
const initialized = new WeakMap();
export async function ensureLearningSchema(db) {
    if (!initialized.has(db)) initialized.set(db, (async () => {
        await db.batch(schema.map(sql => db.prepare(sql)));
        // Transfer the legacy retake grant once, preserving both existing counts.
        const legacy = await first(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='assessment_retake_permissions'");
        if (legacy) await db.batch([
            db.prepare(`INSERT INTO assessment_access(user_id,assessment_type,assessment_id,extra_attempts,granted_by)
                SELECT user_id,assessment_type,assessment_id,extra_attempts,granted_by FROM assessment_retake_permissions
                WHERE NOT EXISTS(SELECT 1 FROM school_learning_meta WHERE key='legacy_retakes_v1')
                ON CONFLICT(user_id,assessment_type,assessment_id) DO UPDATE SET extra_attempts=assessment_access.extra_attempts+excluded.extra_attempts`),
            db.prepare("INSERT OR IGNORE INTO school_learning_meta(key,value) VALUES('legacy_retakes_v1','migrated')")
        ]);
    })().catch(error => { initialized.delete(db); throw error; }));
    await initialized.get(db);
}

const bool = value => value === true || value === 1 || value === '1';
const clean = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const positive = (value, name = 'ID') => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `Некорректное значение ${name}`);
    return n;
};
const integer = (value, fallback, min, max, name) => {
    const n = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `Некорректное значение ${name}`);
    return n;
};
const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const active = user => { if (!user || user.status !== 'active') throw new HttpError(403, 'Доступ к аккаунту ограничен'); };
const completed = p => Boolean(Number(p?.is_completed) || Number(p?.completed) || Number(p?.progress_percent) >= 100);
export async function canReadLearningScope(db,user,scope) {
    if(await canReadScope(db,user,scope))return true;
    if(scope.semester_id)return false;
    const semesters=await all(db,`SELECT * FROM semesters WHERE course_id=? AND is_active=1 ${scope.program_id?'AND program_id=?':''}`,[scope.course_id,...(scope.program_id?[scope.program_id]:[])]);
    if(!semesters.length)return false;
    for(const semester of semesters)if(!await canReadScope(db,user,{course_id:semester.course_id,program_id:semester.program_id,semester_id:semester.id}))return false;
    return true;
}
const date = value => {
    if (!value) return null;
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) throw new HttpError(400, 'Некорректная дата');
    return d.toISOString();
};
const inWindow = (start, end, now = Date.now()) => (!start || new Date(start).getTime() <= now) && (!end || new Date(end).getTime() > now);
const endTime = (...dates) => {
    const valid = dates.filter(Boolean).map(d => new Date(d).getTime()).filter(Number.isFinite);
    return valid.length ? new Date(Math.min(...valid)).toISOString() : null;
};
async function body(request) {
    let value;
    try { value = await request.json(); } catch { throw new HttpError(400, 'Неверный JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Ожидается объект');
    return value;
}
async function record(db, table, id) {
    const item = await first(db, `SELECT * FROM ${table} WHERE id=?`, [positive(id)]);
    if (!item) throw new HttpError(404, 'Запись не найдена');
    return item;
}
async function allowedAdminCourse(db,user,courseId) {
    if(['owner','superadmin'].includes(user.role))return true;
    const rows=await all(db,'SELECT course_id FROM admin_courses WHERE admin_id=?',[user.id]);
    return !rows.length || rows.some(row=>Number(row.course_id)===Number(courseId));
}
async function scopePermission(db,user,key,courseId) {
    await requirePermission(db,user,key);
    if(courseId && !await allowedAdminCourse(db,user,courseId))throw new HttpError(403,'Этот курс не назначен администратору');
}
async function filterAdminCourses(db,user,rows,courseField='course_id') {
    const filtered=[];for(const row of rows)if(await allowedAdminCourse(db,user,row[courseField]))filtered.push(row);return filtered;
}
async function audit(db, user, action, entity, id) {
    // Audit storage is shared with the core; do not let missing optional columns
    // in old production schemas change whether the learning operation succeeds.
    const columns = await all(db, 'PRAGMA table_info(audit_logs)');
    const known = new Set(columns.map(c => c.name));
    if (!known.has('action')) return;
    const values = { admin_id: user.id, action, entity_type: entity, entity_id: String(id), details: '{}' };
    const keys = Object.keys(values).filter(k => known.has(k));
    await run(db, `INSERT INTO audit_logs(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, keys.map(k => values[k]));
}

export async function learningCatalog(db, user, admin = false) {
    active(user);
    if (admin) await requirePermission(db, user, 'courses');
    const result = {};
    for (const table of ['courses', 'programs', 'semesters', 'subjects']) {
        const rows = await all(db, `SELECT * FROM ${table} ${admin ? '' : 'WHERE is_active=1'} ORDER BY id`);
        result[table] = [];
        for (const row of rows) {
            if(admin && !await allowedAdminCourse(db,user,table==='courses'?row.id:row.course_id))continue;
            // Ancestor visibility is checked separately from purchased access so
            // the catalogue remains browsable without exposing learning content.
            if (!admin && !await visibleScope(db, table, row)) continue;
            const scope = { ...row };
            if (table === 'courses') scope.course_id = row.id;
            if (table === 'programs') scope.program_id = row.id;
            if (table === 'semesters') scope.semester_id = row.id;
            if (table === 'subjects') scope.subject_id = row.id;
            result[table].push({ ...row, has_access: admin || await canReadScope(db, user, scope) });
        }
    }
    if (admin) result.lessons = await filterAdminCourses(db,user,await all(db, 'SELECT * FROM lessons ORDER BY sort_order,id'));
    return result;
}
async function visibleScope(db, table, row) {
    if (table !== 'courses' && row.course_id && !Number((await first(db, 'SELECT is_active FROM courses WHERE id=?', [row.course_id]))?.is_active)) return false;
    if (!['courses', 'programs'].includes(table) && row.program_id && !Number((await first(db, 'SELECT is_active FROM programs WHERE id=?', [row.program_id]))?.is_active)) return false;
    if (table === 'subjects' && !Number((await first(db, 'SELECT is_active FROM semesters WHERE id=?', [row.semester_id]))?.is_active)) return false;
    return true;
}
export async function listLearningLessons(db, user, filters = {}) {
    active(user);
    const where = ['l.is_visible=1']; const args = [];
    for (const key of ['course_id', 'program_id', 'semester_id', 'subject_id']) {
        if (filters[key]) { where.push(`l.${key}=?`); args.push(positive(filters[key])); }
    }
    const rows = await all(db, `SELECT l.* FROM lessons l WHERE ${where.join(' AND ')} ORDER BY l.sort_order,l.id`, args);
    const progress = await all(db, 'SELECT * FROM lesson_progress WHERE user_id=?', [user.id]);
    const result = [];
    for (const row of rows) {
        if (!await visibleScope(db, 'subjects', row)) continue;
        if (row.subject_id && !Number((await first(db, 'SELECT is_active FROM subjects WHERE id=?', [row.subject_id]))?.is_active)) continue;
        let locked = false; let reason = '';
        try { await assertLessonAccess(db, user, row); } catch (error) { if (![403,404,409].includes(error.status)) throw error; locked = true; reason = error.message; }
        const p = progress.find(p => Number(p.lesson_id) === Number(row.id));
        result.push({ id: row.id, title: row.title, description: row.description, course_id: row.course_id,
            program_id: row.program_id, semester_id: row.semester_id, subject_id: row.subject_id,
            lesson_number: row.lesson_number, sort_order: row.sort_order, locked, lock_reason: reason,
            is_completed: completed(p), progress_percent: completed(p) ? 100 : Number(p?.progress_percent || 0) });
    }
    return result;
}
export async function learningLesson(db, user, id) {
    active(user);
    const lesson = await record(db, 'lessons', id);
    await assertLessonAccess(db, user, lesson);
    const files = await all(db, 'SELECT * FROM lesson_files WHERE lesson_id=? ORDER BY sort_order,id', [lesson.id]);
    return { ...lesson, files: files.map(f => ({ id: f.id, file_name: f.file_name, mime_type: f.mime_type,
        file_size: f.file_size, url: `/api/lesson-files/${f.id}` })),
        progress: await first(db, 'SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?', [user.id, lesson.id]) };
}
export async function completeLearningLesson(db, user, id) {
    const lesson = await record(db, 'lessons', id);
    const saved = await saveProgress(db, user, lesson.id, { completed: true });
    const lessons = await listLearningLessons(db, user, { semester_id: lesson.semester_id });
    const index = lessons.findIndex(l => l.id === lesson.id);
    return { progress: saved, next_lesson_id: lessons.slice(index + 1).find(l => !l.locked)?.id || null };
}

const contentTables = new Set(['courses', 'programs', 'semesters', 'subjects', 'lessons']);
export async function saveLearningContent(db, user, table, input, id = null) {
    if (!contentTables.has(table)) throw new HttpError(404, 'Раздел не найден');
    await requirePermission(db, user, 'courses');
    if(table==='courses'&&!id&&user.role==='admin'&&(await all(db,'SELECT course_id FROM admin_courses WHERE admin_id=?',[user.id])).length)throw new HttpError(403,'Создавать новые курсы может администратор без ограничения отдельными курсами');
    const current = id ? await record(db, table, id) : {};
    if(id)await scopePermission(db,user,'courses',table==='courses'?current.id:current.course_id);
    const merged = { ...current, ...input };
    const nameKey = table === 'lessons' ? 'title' : 'name';
    const name = clean(merged[nameKey], 200);
    if (name.length < 2) throw new HttpError(400, 'Название должно содержать не менее двух символов');
    const data = { [nameKey]: name, description: clean(merged.description) };
    if (table === 'courses' || table === 'programs') data.purpose = clean(merged.purpose);
    if (table !== 'courses') {
        // Resolve every parent from the closest canonical parent and reject
        // inconsistent combinations rather than accepting unrelated foreign IDs.
        let parent = null;
        if (table === 'lessons' && merged.subject_id) parent = await record(db, 'subjects', merged.subject_id);
        else if (['subjects', 'lessons'].includes(table)) parent = await record(db, 'semesters', positive(merged.semester_id, 'семестра'));
        else if (table === 'semesters') parent = await record(db, 'programs', positive(merged.program_id, 'программы'));
        else parent = await record(db, 'courses', positive(merged.course_id, 'курса'));
        data.course_id = table === 'programs' ? parent.id : parent.course_id;
        if (table === 'semesters') data.program_id = parent.id;
        if (table === 'subjects') { data.program_id = parent.program_id; data.semester_id = parent.id; }
        if (table === 'lessons') {
            data.program_id = parent.program_id;
            data.semester_id = merged.subject_id ? parent.semester_id : parent.id;
            data.subject_id = merged.subject_id ? parent.id : null;
        }
        for (const key of ['course_id', 'program_id', 'semester_id']) {
            if (has(input, key) && input[key] && data[key] && Number(input[key]) !== Number(data[key])) throw new HttpError(400, 'Родительские разделы не связаны между собой');
        }
        // Moving an existing parent would silently orphan its descendants.
        if (id) for (const key of ['course_id','program_id','semester_id']) {
            if (current[key] && data[key] && Number(current[key]) !== Number(data[key]) && table !== 'lessons') throw new HttpError(400, 'Для переноса структуры создайте новый раздел');
        }
    }
    if (table === 'semesters') {
        data.number = integer(merged.number, 1, 1, 100, 'номера семестра');
        data.price_rub = integer(merged.price_rub, 3000, 1, 1000000, 'цены');
        data.access_months = integer(merged.access_months, 3, 1, 120, 'срока доступа');
        data.payment_enabled = has(merged, 'payment_enabled') ? Number(bool(merged.payment_enabled)) : 0;
        if ((has(input,'price_rub') || has(input,'access_months') || has(input,'payment_enabled')) && id) await requirePermission(db, user, 'payments');
    }
    if (['subjects', 'lessons'].includes(table)) data.sort_order = integer(merged.sort_order, 0, 0, 100000, 'порядка');
    if (table === 'lessons') {
        data.lesson_number = integer(merged.lesson_number, 1, 1, 100000, 'номера урока');
        data.content = clean(merged.content, 200000);
        data.is_visible = has(merged, 'is_visible') ? Number(bool(merged.is_visible)) : 1;
    } else data.is_active = has(merged,'is_active') ? Number(bool(merged.is_active)) : 1;
    if(data.course_id)await scopePermission(db,user,'courses',data.course_id);
    const keys = Object.keys(data);
    let itemId = id;
    try {
        if (id) await run(db, `UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, [...keys.map(k => data[k]), id]);
        else { const result = await run(db, `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, keys.map(k => data[k])); itemId = Number(result.meta.last_row_id); }
    } catch (error) {
        if (/UNIQUE|constraint/i.test(error.message)) throw new HttpError(409, 'Проверьте уникальность номера и связанные разделы');
        throw error;
    }
    await audit(db, user, id ? 'learning.update' : 'learning.create', table, itemId);
    return record(db, table, itemId);
}

export async function listLearningGroups(db, user, admin = false) {
    active(user);
    if (admin) await requirePermission(db, user, 'groups');
    const rows=await all(db, `SELECT g.*,s.program_id,s.semester_id,s.cohort,COALESCE(s.is_active,1) AS is_active,
        (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) AS member_count
        FROM groups g LEFT JOIN school_group_scopes s ON s.group_id=g.id
        ${admin ? '' : 'WHERE COALESCE(s.is_active,1)=1 AND EXISTS(SELECT 1 FROM user_groups ug WHERE ug.group_id=g.id AND ug.user_id=?)'} ORDER BY g.id DESC`, admin ? [] : [user.id]);
    return admin?filterAdminCourses(db,user,rows):rows;
}
async function saveGroup(db, user, input, id) {
    await requirePermission(db, user, 'groups');
    const existing = id ? (await listLearningGroups(db, user, true)).find(g => g.id === id) : {};
    if (!existing) throw new HttpError(404, 'Группа не найдена');
    const value = { ...existing, ...input };
    const name = clean(value.name, 120); if (name.length < 2) throw new HttpError(400, 'Введите название группы');
    let semester = value.semester_id ? await record(db, 'semesters', value.semester_id) : null;
    let program = (semester?.program_id || value.program_id) ? await record(db, 'programs', semester?.program_id || value.program_id) : null;
    const courseId = positive(semester?.course_id || program?.course_id || value.course_id, 'курса');
    await scopePermission(db,user,'groups',courseId);
    await record(db, 'courses', courseId);
    if (value.course_id && Number(value.course_id) !== courseId || semester && value.program_id && Number(value.program_id) !== semester.program_id) throw new HttpError(400, 'Разделы группы не связаны');
    let groupId = id;
    if (id) await run(db, 'UPDATE groups SET name=?,description=?,course_id=? WHERE id=?', [name, clean(value.description), courseId, id]);
    else { const r = await run(db, 'INSERT INTO groups(name,description,course_id) VALUES(?,?,?)', [name,clean(value.description),courseId]); groupId = Number(r.meta.last_row_id); }
    await run(db, `INSERT INTO school_group_scopes(group_id,program_id,semester_id,cohort,is_active) VALUES(?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET program_id=excluded.program_id,semester_id=excluded.semester_id,cohort=excluded.cohort,is_active=excluded.is_active`,
        [groupId,program?.id || null,semester?.id || null,clean(value.cohort,120),has(value,'is_active') ? Number(bool(value.is_active)) : 1]);
    await audit(db,user,'group.save','group',groupId);
    return (await listLearningGroups(db,user,true)).find(g=>g.id===groupId);
}
async function groupMembers(db, user, id) {
    await requirePermission(db,user,'groups');
    const group = (await listLearningGroups(db,user,true)).find(g=>g.id===id);
    if (!group) throw new HttpError(404,'Группа не найдена');
    const members = await all(db, `SELECT u.id,u.first_name,u.last_name,u.username,u.role,u.status FROM user_groups ug JOIN users u ON u.id=ug.user_id WHERE ug.group_id=? ORDER BY u.id`,[id]);
    const lessons = await all(db, `SELECT id FROM lessons WHERE course_id=? AND is_visible=1 ${group.semester_id ? 'AND semester_id=?' : group.program_id ? 'AND program_id=?' : ''}`,[group.course_id,...(group.semester_id ? [group.semester_id] : group.program_id ? [group.program_id] : [])]);
    for (const member of members) {
        const p = await all(db,'SELECT * FROM lesson_progress WHERE user_id=?',[member.id]);
        const done = new Set(p.filter(completed).map(x=>Number(x.lesson_id)));
        member.progress_percent = lessons.length ? Math.round(100*lessons.filter(l=>done.has(l.id)).length/lessons.length) : 0;
    }
    return members;
}

export function validateExamQuestions(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new HttpError(400,'Нужно от 1 до 100 вопросов');
    return input.map((q,index)=>{
        const question=clean(q.question,4000); if (!question) throw new HttpError(400,`Введите вопрос ${index+1}`);
        const type=q.question_type || 'single';
        if (!['single','multiple'].includes(type)) throw new HttpError(400,'Поддерживаются один или несколько вариантов ответа');
        if (!Array.isArray(q.answers) || q.answers.length<2 || q.answers.length>8) throw new HttpError(400,'Нужно от 2 до 8 вариантов ответа');
        const answers=q.answers.map(a=>({answer_text:clean(a.answer_text,2000),is_correct:Number(bool(a.is_correct))}));
        if (answers.some(a=>!a.answer_text) || new Set(answers.map(a=>a.answer_text)).size!==answers.length) throw new HttpError(400,'Варианты ответа должны быть непустыми и различаться');
        const correct=answers.filter(a=>a.is_correct).length;
        if (correct<1 || type==='single' && correct!==1) throw new HttpError(400,'Проверьте правильные ответы');
        return {question,question_type:type,points:integer(q.points,1,1,100,'баллов'),answers};
    });
}
async function examDefinition(db,id,withAnswers=true) {
    const exam=await record(db,'exams',id);
    const rules=await first(db,'SELECT * FROM school_exam_rules WHERE exam_id=?',[exam.id]);
    const questions=await all(db,'SELECT * FROM exam_questions WHERE exam_id=? ORDER BY sort_order,id',[exam.id]);
    for (const q of questions) {
        q.answers=await all(db,`SELECT id,answer_text${withAnswers ? ',is_correct' : ''} FROM exam_answers WHERE question_id=? ORDER BY sort_order,id`,[q.id]);
    }
    return {...exam,require_all_lessons:rules ? Boolean(rules.require_all_lessons) : true,
        required_lesson_ids:parse(rules?.required_lesson_ids,[]),assignment_required:Boolean(rules?.assignment_required),
        certificate_required:rules ? Boolean(rules.certificate_required) : true,questions};
}
async function saveExam(db,user,input,id) {
    await requirePermission(db,user,'exams');
    const current=id ? await examDefinition(db,id) : {};
    if(id)await scopePermission(db,user,'exams',current.course_id);
    const value={...current,...input};
    const questions=validateExamQuestions(value.questions);
    const title=clean(value.title,200);if(title.length<2)throw new HttpError(400,'Введите название экзамена');
    const semester=value.semester_id ? await record(db,'semesters',value.semester_id) : null;
    const program=(semester?.program_id || value.program_id) ? await record(db,'programs',semester?.program_id || value.program_id) : null;
    const course=await record(db,'courses',semester?.course_id || program?.course_id || value.course_id);
    await scopePermission(db,user,'exams',course.id);
    if(value.course_id && Number(value.course_id)!==course.id || semester && value.program_id && Number(value.program_id)!==semester.program_id)throw new HttpError(400,'Разделы экзамена не связаны');
    const subject=value.subject_id ? await record(db,'subjects',value.subject_id) : null;
    if(subject && (subject.course_id!==course.id || semester && subject.semester_id!==semester.id))throw new HttpError(400,'Предмет не относится к выбранному семестру');
    const starts=date(value.starts_at),ends=date(value.ends_at);if(starts&&ends&&starts>=ends)throw new HttpError(400,'Конец экзамена должен быть после начала');
    const required=(value.required_lesson_ids || []).map(n=>positive(n,'урока'));
    if(new Set(required).size!==required.length)throw new HttpError(400,'Урок указан несколько раз');
    for(const lid of required){const l=await record(db,'lessons',lid);if(l.course_id!==course.id || semester && l.semester_id!==semester.id)throw new HttpError(400,'Условие содержит урок из другого раздела');}
    const data={course_id:course.id,program_id:program?.id || null,semester_id:semester?.id || null,subject_id:subject?.id || null,
        title,description:clean(value.description),max_score:questions.reduce((sum,q)=>sum+q.points,0),
        passing_score:integer(value.passing_score,60,0,100,'проходного процента'),attempts_allowed:integer(value.attempts_allowed,1,1,20,'попыток'),
        time_limit_minutes:integer(value.time_limit_minutes,60,1,240,'времени'),starts_at:starts,ends_at:ends,is_active:has(value,'is_active')?Number(bool(value.is_active)):1};
    const keys=Object.keys(data);let examId=id;
    if(!id){const r=await run(db,`INSERT INTO exams(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(k=>data[k]));examId=Number(r.meta.last_row_id);}
    const statements=[db.prepare(`UPDATE exams SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).bind(...keys.map(k=>data[k]),examId),
        db.prepare('DELETE FROM exam_answers WHERE question_id IN(SELECT id FROM exam_questions WHERE exam_id=?)').bind(examId),db.prepare('DELETE FROM exam_questions WHERE exam_id=?').bind(examId)];
    // Last insert ID links answer inserts to their own question within one batch.
    // Answer rows themselves advance last_insert_rowid(), therefore select the
    // freshly inserted question by its exam and unique sort position instead.
    questions.forEach((q,qi)=>{
        statements.push(db.prepare('INSERT INTO exam_questions(exam_id,question,question_type,points,sort_order) VALUES(?,?,?,?,?)').bind(examId,q.question,q.question_type,q.points,qi));
        q.answers.forEach((a,ai)=>statements.push(db.prepare(`INSERT INTO exam_answers(question_id,answer_text,is_correct,sort_order) SELECT id,?,?,? FROM exam_questions WHERE exam_id=? AND sort_order=?`).bind(a.answer_text,a.is_correct,ai,examId,qi)));
    });
    statements.push(db.prepare(`INSERT INTO school_exam_rules(exam_id,require_all_lessons,required_lesson_ids,assignment_required,certificate_required) VALUES(?,?,?,?,?) ON CONFLICT(exam_id) DO UPDATE SET require_all_lessons=excluded.require_all_lessons,required_lesson_ids=excluded.required_lesson_ids,assignment_required=excluded.assignment_required,certificate_required=excluded.certificate_required`).bind(examId,has(value,'require_all_lessons')?Number(bool(value.require_all_lessons)):1,JSON.stringify(required),Number(bool(value.assignment_required)),has(value,'certificate_required')?Number(bool(value.certificate_required)):1));
    await db.batch(statements);
    await audit(db,user,'exam.save','exam',examId);
    return examDefinition(db,examId);
}

export async function examAccess(db,user,exam) {
    active(user);
    const override=await first(db,"SELECT * FROM assessment_access WHERE user_id=? AND assessment_type='exam' AND assessment_id=?",[user.id,exam.id]);
    const used=Number((await first(db,'SELECT COUNT(*) AS count FROM exam_attempts WHERE user_id=? AND exam_id=?',[user.id,exam.id]))?.count || 0);
    const total=Math.max(1,Number(exam.attempts_allowed)||1)+Math.max(0,Number(override?.extra_attempts)||0);
    const attempts_remaining=Math.max(0,total-used);
    const state={attempts_used:used,attempts_remaining,total_attempts:total,can_attempt:false,reason:'',closes_at:override?.closes_at || exam.ends_at || null};
    if(!await canReadLearningScope(db,user,exam))return{...state,reason:'Нет действующего доступа к учебному разделу'};
    const open=override?.is_open==null ? Number(exam.is_active)===1 : Number(override.is_open)===1;
    if(!open || !inWindow(override?.opens_at || exam.starts_at,override?.closes_at || exam.ends_at))return{...state,reason:'Экзамен закрыт или ещё не начался'};
    if(exam.assignment_required && Number(override?.is_open)!==1){
        const assignments=await all(db,`SELECT a.* FROM school_exam_assignments a WHERE a.exam_id=? AND a.is_open=1 AND
            ((a.target_type='user' AND a.target_id=?) OR (a.target_type='group' AND EXISTS(SELECT 1 FROM user_groups ug LEFT JOIN school_group_scopes gs ON gs.group_id=ug.group_id WHERE ug.group_id=a.target_id AND ug.user_id=? AND COALESCE(gs.is_active,1)=1)))`,[exam.id,user.id,user.id]);
        const allowed=assignments.filter(a=>inWindow(a.opens_at,a.closes_at));
        if(!allowed.length)return{...state,reason:'Экзамен не назначен вам или вашей группе'};
        // Any assignment can grant access; use the latest of their closing times.
        const assignmentEnd=allowed.some(a=>!a.closes_at)?null:new Date(Math.max(...allowed.map(a=>new Date(a.closes_at).getTime()))).toISOString();
        state.closes_at=endTime(state.closes_at,assignmentEnd);
    }
    let required=exam.required_lesson_ids || [];
    if(exam.require_all_lessons){
        const where=['l.course_id=?','l.is_visible=1','sem.is_active=1','p.is_active=1','(l.subject_id IS NULL OR sub.is_active=1)'];const values=[exam.course_id];
        for(const k of ['program_id','semester_id','subject_id'])if(exam[k]){where.push(`l.${k}=?`);values.push(exam[k]);}
        required=[...required,...(await all(db,`SELECT l.id FROM lessons l JOIN semesters sem ON sem.id=l.semester_id JOIN programs p ON p.id=l.program_id LEFT JOIN subjects sub ON sub.id=l.subject_id WHERE ${where.join(' AND ')}`,values)).map(l=>l.id)];
    }
    const progress=await all(db,'SELECT * FROM lesson_progress WHERE user_id=?',[user.id]);
    const done=new Set(progress.filter(completed).map(p=>Number(p.lesson_id)));
    if(required.some(id=>!done.has(Number(id))))return{...state,reason:'Сначала завершите обязательные уроки'};
    if(!attempts_remaining)return{...state,reason:'Попытки закончились. Администратор может назначить пересдачу'};
    return{...state,can_attempt:true};
}
function publicAttempt(row) {
    const snapshot=parse(row.snapshot_json,{});
    return{id:row.attempt_id,exam_id:row.exam_id,title:snapshot.title,status:row.status,deadline_at:row.deadline_at,answers:parse(row.answers_json,{}),
        questions:(snapshot.questions||[]).map(q=>({id:q.id,question:q.question,question_type:q.question_type,points:q.points,
            answers:q.answers.map(a=>({id:a.id,answer_text:a.answer_text}))}))};
}
export async function startLearningExam(db,user,id,now=Date.now()) {
    await ensureLearningSchema(db);active(user);
    const exam=await examDefinition(db,id);
    if(!await canReadLearningScope(db,user,exam))throw new HttpError(403,'Нет действующего доступа к экзамену');
    let existing=await first(db,"SELECT * FROM school_exam_attempts WHERE user_id=? AND exam_id=? AND status='started'",[user.id,exam.id]);
    if(existing && new Date(existing.deadline_at).getTime()>now)return publicAttempt(existing);
    if(existing)await submitLearningExam(db,user,existing.attempt_id,{},now);
    const access=await examAccess(db,user,exam);if(!access.can_attempt)throw new HttpError(403,access.reason);
    validateExamQuestions(exam.questions);
    const snapshot={title:exam.title,passing_score:exam.passing_score,max_score:exam.questions.reduce((n,q)=>n+Number(q.points),0),questions:exam.questions};
    const started=new Date(now).toISOString();const deadline=endTime(new Date(now+(Number(exam.time_limit_minutes)||60)*60000).toISOString(),access.closes_at);
    const statements=[
        db.prepare(`INSERT INTO exam_attempts(exam_id,user_id,course_id,attempt_number,max_score,started_at)
            SELECT ?,?,?,(SELECT COUNT(*)+1 FROM exam_attempts WHERE user_id=? AND exam_id=?),?,?
            WHERE (SELECT COUNT(*) FROM exam_attempts WHERE user_id=? AND exam_id=?)<?
            AND NOT EXISTS(SELECT 1 FROM school_exam_attempts WHERE user_id=? AND exam_id=? AND status='started')`)
            .bind(exam.id,user.id,exam.course_id,user.id,exam.id,snapshot.max_score,started,user.id,exam.id,access.total_attempts,user.id,exam.id),
        db.prepare(`INSERT INTO school_exam_attempts(attempt_id,user_id,exam_id,status,deadline_at,snapshot_json,created_at)
            SELECT last_insert_rowid(),?,?,'started',?,?,? WHERE changes()=1`).bind(user.id,exam.id,deadline,JSON.stringify(snapshot),started)
    ];
    try{await db.batch(statements);}catch(error){
        existing=await first(db,"SELECT * FROM school_exam_attempts WHERE user_id=? AND exam_id=? AND status='started'",[user.id,exam.id]);
        if(existing)return publicAttempt(existing);throw error;
    }
    existing=await first(db,"SELECT * FROM school_exam_attempts WHERE user_id=? AND exam_id=? AND status='started'",[user.id,exam.id]);
    if(!existing)throw new HttpError(409,'Попытки закончились или экзамен уже открыт в другом окне');
    return publicAttempt(existing);
}
export function gradeSnapshot(snapshot,answers,timedOut=false) {
    if(!answers || typeof answers!=='object' || Array.isArray(answers))throw new HttpError(400,'Неверный формат ответов');
    const ids=new Set(snapshot.questions.map(q=>String(q.id)));
    if(Object.keys(answers).some(id=>!ids.has(id)))throw new HttpError(400,'Ответ на неизвестный вопрос');
    let score=0;const normalized={};
    for(const q of snapshot.questions){
        const given=answers[String(q.id)] || [];
        if(!Array.isArray(given) || given.length>q.answers.length)throw new HttpError(400,'Неверный ответ');
        const selected=given.map(n=>positive(n,'ответа'));const valid=new Set(q.answers.map(a=>Number(a.id)));
        if(new Set(selected).size!==selected.length || selected.some(id=>!valid.has(id)) || q.question_type==='single' && selected.length>1)throw new HttpError(400,'Ответ не относится к вопросу');
        normalized[q.id]=selected;
        const correct=q.answers.filter(a=>Number(a.is_correct)===1).map(a=>Number(a.id));
        if(!timedOut && selected.length===correct.length && selected.every(id=>correct.includes(id)))score+=Number(q.points);
    }
    const max_score=Number(snapshot.max_score);const percentage=max_score ? Math.round(score/max_score*10000)/100 : 0;
    return{answers:normalized,result:{score,max_score,percentage,passed:!timedOut && percentage>=Number(snapshot.passing_score),timed_out:timedOut}};
}
export async function submitLearningExam(db,user,id,answers,now=Date.now()) {
    await ensureLearningSchema(db);active(user);
    const attempt=await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=? AND user_id=?',[positive(id),user.id]);
    if(!attempt)throw new HttpError(404,'Попытка не найдена');
    const exam=await record(db,'exams',attempt.exam_id);if(!await canReadLearningScope(db,user,exam))throw new HttpError(403,'Доступ к экзамену прекращён');
    if(attempt.status!=='started')return{attempt:publicAttempt(attempt),result:parse(attempt.result_json,{})};
    const timedOut=now>=new Date(attempt.deadline_at).getTime();
    const {result,answers:normalized}=gradeSnapshot(parse(attempt.snapshot_json,{}),timedOut?{}:answers,timedOut);
    const status=timedOut?'timed_out':'submitted';const submitted=new Date(now).toISOString();
    const grade=result.percentage>=90?'5':result.percentage>=75?'4':result.percentage>=60?'3':'2';
    await db.batch([
        db.prepare(`UPDATE school_exam_attempts SET status=?,answers_json=?,result_json=?,submitted_at=? WHERE attempt_id=? AND user_id=? AND status='started'`).bind(status,JSON.stringify(normalized),JSON.stringify(result),submitted,attempt.attempt_id,user.id),
        db.prepare(`UPDATE exam_attempts SET score=?,max_score=?,percentage=?,passed=?,grade=?,submitted_at=? WHERE id=? AND changes()=1`).bind(result.score,result.max_score,result.percentage,Number(result.passed),grade,submitted,attempt.attempt_id)
    ]);
    const saved=await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=?',[attempt.attempt_id]);
    return{attempt:publicAttempt(saved),result:parse(saved.result_json,{})};
}
export async function saveLearningExamAnswers(db,user,id,answers,now=Date.now()) {
    active(user);const attempt=await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=? AND user_id=?',[positive(id),user.id]);
    if(!attempt)throw new HttpError(404,'Попытка не найдена');
    const exam=await record(db,'exams',attempt.exam_id);if(!await canReadLearningScope(db,user,exam))throw new HttpError(403,'Доступ к экзамену прекращён');
    if(attempt.status!=='started')throw new HttpError(409,'Попытка уже завершена');
    if(now>=new Date(attempt.deadline_at).getTime()){await submitLearningExam(db,user,id,{},now);throw new HttpError(409,'Время экзамена истекло');}
    const normalized=gradeSnapshot(parse(attempt.snapshot_json,{}),answers).answers;
    await run(db,"UPDATE school_exam_attempts SET answers_json=? WHERE attempt_id=? AND user_id=? AND status='started'",[JSON.stringify(normalized),attempt.attempt_id,user.id]);
    return publicAttempt(await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=?',[attempt.attempt_id]));
}
export async function listLearningExams(db,user,admin=false) {
    active(user);if(admin)await requirePermission(db,user,'exams');
    const rows=await all(db,'SELECT id FROM exams ORDER BY id DESC');const result=[];
    for(const row of rows){
        const exam=await examDefinition(db,row.id,admin);
        if(admin){if(await allowedAdminCourse(db,user,exam.course_id))result.push(exam);continue;}
        if(!await canReadLearningScope(db,user,exam))continue;
        const {questions,...visible}=exam;
        const state=await examAccess(db,user,exam);
        const open=await first(db,"SELECT attempt_id,deadline_at FROM school_exam_attempts WHERE user_id=? AND exam_id=? AND status='started'",[user.id,exam.id]);
        result.push({...visible,...state,active_attempt_id:open?.attempt_id || null,deadline_at:open?.deadline_at || null});
    }
    return result;
}

async function saveAssignment(db,user,examId,input) {
    const exam=await record(db,'exams',examId);await scopePermission(db,user,'exams',exam.course_id);
    const target_type=input.target_type;if(!['user','group'].includes(target_type))throw new HttpError(400,'Назначение должно быть ученику или группе');
    const target_id=positive(input.target_id);const target=await record(db,target_type==='user'?'users':'groups',target_id);
    if(target_type==='group'&&target.course_id!==exam.course_id)throw new HttpError(400,'Группа относится к другому курсу');
    const opens_at=date(input.opens_at),closes_at=date(input.closes_at);
    if(opens_at&&closes_at&&opens_at>=closes_at)throw new HttpError(400,'Проверьте даты назначения');
    await db.batch([
        db.prepare(`INSERT INTO school_exam_assignments(exam_id,target_type,target_id,is_open,opens_at,closes_at,granted_by) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(exam_id,target_type,target_id) DO UPDATE SET is_open=excluded.is_open,opens_at=excluded.opens_at,closes_at=excluded.closes_at,granted_by=excluded.granted_by`)
            .bind(examId,target_type,target_id,has(input,'is_open')?Number(bool(input.is_open)):1,opens_at,closes_at,user.id),
        db.prepare(`INSERT INTO school_exam_rules(exam_id,assignment_required) VALUES(?,1) ON CONFLICT(exam_id) DO UPDATE SET assignment_required=1`).bind(examId)
    ]);
    await audit(db,user,'exam.assign','exam',examId);
    return all(db,'SELECT * FROM school_exam_assignments WHERE exam_id=? ORDER BY id',[examId]);
}
export async function grantLearningRetake(db,user,input) {
    await ensureLearningSchema(db);await requirePermission(db,user,'exams');
    const type=input.type || input.assessment_type || 'exam';if(!['exam','test'].includes(type))throw new HttpError(400,'Некорректный тип работы');
    const assessmentId=positive(input.assessment_id);const userId=positive(input.user_id);
    const assessment=await record(db,type==='exam'?'exams':'tests',assessmentId);await scopePermission(db,user,'exams',assessment.course_id);await record(db,'users',userId);
    const extra=integer(input.extra_attempts,1,1,20,'дополнительных попыток');
    await run(db,`INSERT INTO assessment_access(user_id,assessment_type,assessment_id,is_open,extra_attempts,granted_by,reason)
        VALUES(?,?,?,1,?,?,?) ON CONFLICT(user_id,assessment_type,assessment_id) DO UPDATE SET
        extra_attempts=assessment_access.extra_attempts+excluded.extra_attempts,is_open=1,granted_by=excluded.granted_by,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP`,
        [userId,type,assessmentId,extra,user.id,clean(input.reason,500)]);
    await audit(db,user,'exam.retake',type,assessmentId);
    return first(db,'SELECT extra_attempts,updated_at AS granted_at FROM assessment_access WHERE user_id=? AND assessment_type=? AND assessment_id=?',[userId,type,assessmentId]);
}

export async function certificateSettings(db,courseId) {
    const course=await record(db,'courses',courseId);
    const settings=await first(db,'SELECT * FROM certificate_settings WHERE course_id=?',[course.id]);
    const rules=await first(db,'SELECT * FROM school_certificate_rules WHERE course_id=?',[course.id]);
    return{course_id:course.id,enabled:Number(course.certificate_enabled)!==0,
        template_key:settings?.template_key || course.certificate_template_key || 'html:rauda',
        require_exam:settings ? Boolean(settings.require_exam) : true,require_passing_score:settings ? Boolean(settings.require_passing_score) : true,
        passing_score:Number(settings?.passing_score ?? course.certificate_passing_score ?? 60),
        allow_student_name:settings ? Boolean(settings.allow_student_name) : true,require_progress:rules ? Boolean(rules.require_progress) : true,
        title:rules?.title || 'Сертификат об окончании',issuer:rules?.issuer || 'RAUDA ILM',accent:rules?.accent || '#126b55',footer:rules?.footer || 'Выдан по результатам обучения'};
}
async function saveCertificateSettings(db,user,courseId,input) {
    await scopePermission(db,user,'certificates',courseId);
    const current=await certificateSettings(db,courseId);const v={...current,...input};
    const accent=clean(v.accent,7);if(!/^#[0-9a-f]{6}$/i.test(accent))throw new HttpError(400,'Цвет должен быть в формате #126b55');
    const score=integer(v.passing_score,60,0,100,'проходного процента');
    await db.batch([
        db.prepare('UPDATE courses SET certificate_enabled=?,certificate_passing_score=? WHERE id=?').bind(Number(bool(v.enabled)),score,courseId),
        db.prepare(`INSERT INTO certificate_settings(course_id,template_key,require_exam,require_passing_score,passing_score,allow_student_name) VALUES(?,'html:rauda',?,?,?,?)
            ON CONFLICT(course_id) DO UPDATE SET template_key='html:rauda',require_exam=excluded.require_exam,require_passing_score=excluded.require_passing_score,passing_score=excluded.passing_score,allow_student_name=excluded.allow_student_name`)
            .bind(courseId,Number(bool(v.require_exam)),Number(bool(v.require_passing_score)),score,Number(bool(v.allow_student_name))),
        db.prepare(`INSERT INTO school_certificate_rules(course_id,require_progress,title,issuer,accent,footer) VALUES(?,?,?,?,?,?) ON CONFLICT(course_id) DO UPDATE SET require_progress=excluded.require_progress,title=excluded.title,issuer=excluded.issuer,accent=excluded.accent,footer=excluded.footer`)
            .bind(courseId,Number(bool(v.require_progress)),clean(v.title,150),clean(v.issuer,150),accent,clean(v.footer,500))
    ]);
    await audit(db,user,'certificate.settings','course',courseId);
    return certificateSettings(db,courseId);
}
export async function certificateEligibility(db,user,courseId) {
    active(user);const course=await record(db,'courses',courseId);const settings=await certificateSettings(db,courseId);
    if(!settings.enabled)return{eligible:false,reason:'Выдача сертификатов для этого курса отключена',settings};
    if(!await canReadLearningScope(db,user,{course_id:course.id}))return{eligible:false,reason:'Нет доступа к курсу',settings};
    if(settings.require_progress){
        const lessons=await all(db,`SELECT l.id FROM lessons l JOIN semesters s ON s.id=l.semester_id JOIN programs p ON p.id=l.program_id
            LEFT JOIN subjects sub ON sub.id=l.subject_id WHERE l.course_id=? AND l.is_visible=1 AND s.is_active=1 AND p.is_active=1 AND (l.subject_id IS NULL OR sub.is_active=1)`,[course.id]);
        if(!lessons.length)return{eligible:false,reason:'Программа курса ещё не опубликована',settings};
        const progress=await all(db,'SELECT * FROM lesson_progress WHERE user_id=?',[user.id]);const done=new Set(progress.filter(completed).map(p=>p.lesson_id));
        if(lessons.some(l=>!done.has(l.id)))return{eligible:false,reason:'Завершите все уроки курса',settings};
    }
    if(settings.require_exam){
        const exams=await all(db,`SELECT e.id FROM exams e LEFT JOIN school_exam_rules r ON r.exam_id=e.id WHERE e.course_id=? AND e.is_active=1 AND COALESCE(r.certificate_required,1)=1`,[course.id]);
        if(!exams.length)return{eligible:false,reason:'Итоговый экзамен ещё не опубликован',settings};
        for(const e of exams){
            const passed=await first(db,`SELECT id FROM exam_attempts WHERE user_id=? AND exam_id=? AND submitted_at IS NOT NULL AND passed=1 ${settings.require_passing_score?'AND percentage>=?':''} LIMIT 1`,[user.id,e.id,...(settings.require_passing_score?[settings.passing_score]:[])]);
            if(!passed)return{eligible:false,reason:'Сдайте обязательные экзамены курса',settings};
        }
    }
    return{eligible:true,reason:'',settings};
}
export async function listLearningCertificates(db,user,admin=false) {
    active(user);if(admin)await requirePermission(db,user,'certificates');
    const rows=await all(db,`SELECT c.*,co.name AS course_name FROM certificates c JOIN courses co ON co.id=c.course_id ${admin?'':'WHERE c.user_id=?'} ORDER BY c.id DESC`,admin?[]:[user.id]);
    const allowed=admin?await filterAdminCourses(db,user,rows):rows;
    return allowed.map(c=>({...c,format:'html',download_url:`/api/learning/certificates/${c.id}/download`}));
}
export async function issueLearningCertificate(db,user,input,admin=false) {
    active(user);if(admin)await requirePermission(db,user,'certificates');
    const student=admin?await record(db,'users',positive(input.user_id)):user;
    const courseId=positive(input.course_id);const eligibility=await certificateEligibility(db,student,courseId);
    if(admin)await scopePermission(db,user,'certificates',courseId);
    if(!eligibility.eligible)throw new HttpError(403,eligibility.reason);
    const defaultName=[student.first_name,student.last_name].filter(Boolean).join(' ').trim() || student.username;
    const name=clean(eligibility.settings.allow_student_name ? (input.certificate_name || defaultName) : defaultName,160);
    if(name.length<2)throw new HttpError(400,'Укажите имя или кунью для сертификата');
    const number=`RAUDA-${new Date().getUTCFullYear()}-${crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase()}`;
    await run(db,`INSERT INTO certificates(user_id,course_id,certificate_number,certificate_name,template_key)
        SELECT ?,?,?,?,'html:rauda' WHERE NOT EXISTS(SELECT 1 FROM certificates WHERE user_id=? AND course_id=? AND is_valid=1)`,[student.id,courseId,number,name,student.id,courseId]);
    const certificate=await first(db,'SELECT * FROM certificates WHERE user_id=? AND course_id=? AND is_valid=1 ORDER BY id DESC LIMIT 1',[student.id,courseId]);
    await audit(db,user,'certificate.issue','certificate',certificate.id);
    return{...certificate,format:'html',download_url:`/api/learning/certificates/${certificate.id}/download`};
}
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function learningCertificateDocument(db,user,id) {
    active(user);const certificate=await record(db,'certificates',id);
    if(Number(certificate.user_id)!==Number(user.id))await scopePermission(db,user,'certificates',certificate.course_id);
    if(!Number(certificate.is_valid))throw new HttpError(410,'Сертификат отозван');
    const course=await record(db,'courses',certificate.course_id);const settings=await certificateSettings(db,course.id);
    const accent=/^#[0-9a-f]{6}$/i.test(settings.accent)?settings.accent:'#126b55';
    const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(certificate.certificate_number)}</title>
<style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;background:#f4f1e9;color:#1b3029;font:18px Georgia,serif}.notice{padding:18px;text-align:center;font:14px Arial,sans-serif}.certificate{margin:24px auto;padding:48px;max-width:1060px;min-height:650px;border:7px double ${accent};background:#fffdf6;text-align:center}.issuer{letter-spacing:.25em;color:${accent};font:700 25px Arial,sans-serif}h1{font-size:42px;margin:45px 0 32px}.name{font-size:40px;color:${accent};margin:25px 0}.course{font-size:29px;margin:22px 0}.footer{margin-top:48px;font-size:17px}.number{font:13px Arial,sans-serif;margin-top:25px;overflow-wrap:anywhere}@media print{body{background:white}.notice{display:none}.certificate{margin:0;max-width:none;min-height:170mm;padding:15mm}}</style>
<div class="notice">Печатный сертификат HTML. Чтобы сохранить PDF, выберите «Печать» → «Сохранить как PDF» в браузере.</div><main class="certificate">
<div class="issuer">${escapeHtml(settings.issuer)}</div><h1>${escapeHtml(settings.title)}</h1><p>Настоящим подтверждается, что</p>
<div class="name">${escapeHtml(certificate.certificate_name)}</div><p>завершил(а) обучение по курсу</p><div class="course">${escapeHtml(course.name)}</div>
<div class="footer">${escapeHtml(settings.footer)}</div><p>${escapeHtml(String(certificate.issued_at).slice(0,10))}</p><div class="number">№ ${escapeHtml(certificate.certificate_number)}</div></main></html>`;
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Disposition':`inline; filename="${certificate.certificate_number}.html"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}});
}

/** Shared HTTP surface for both app and the replacement web administration. */
export async function handleLearningRequest(request,env,ctx={}) {
    const url=new URL(request.url);const path=url.pathname;const method=request.method;
    if(!path.startsWith('/api/learning/') && !path.startsWith('/api/admin/learning/') && path!=='/api/admin/students/retake')return null;
    const response=(data,status=200)=>ctx.json?ctx.json({ok:true,...data},status,env):json({ok:true,...data},status);
    try{
        if(!env.DB)throw new HttpError(503,'База данных не настроена');
        const auth=await ctx.requireUser(request,env);if(!auth.ok)return ctx.authError?ctx.authError(auth,env):json({ok:false,error:auth.error},auth.status||401);
        const user=auth.user;active(user);const db=env.DB;await ensureLearningSchema(db);
        let match;
        if(['/api/learning/catalog','/api/learning/tree','/api/admin/learning/catalog','/api/admin/learning/tree'].includes(path)&&method==='GET')return response(await learningCatalog(db,user,path.includes('/admin/')));
        if(path==='/api/learning/lessons'&&method==='GET')return response({lessons:await listLearningLessons(db,user,Object.fromEntries(url.searchParams))});
        if((match=path.match(/^\/api\/learning\/lessons\/(\d+)$/))&&method==='GET')return response({lesson:await learningLesson(db,user,Number(match[1]))});
        if((match=path.match(/^\/api\/learning\/lessons\/(\d+)\/complete$/))&&method==='POST')return response(await completeLearningLesson(db,user,Number(match[1])));
        if((match=path.match(/^\/api\/admin\/learning\/(courses|programs|semesters|subjects|lessons)(?:\/(\d+))?$/))){
            const table=match[1],id=match[2]?Number(match[2]):null;
            if(method==='GET'){
                await requirePermission(db,user,'courses');
                if(id){const item=await record(db,table,id);await scopePermission(db,user,'courses',table==='courses'?item.id:item.course_id);return response({item});}
                return response({[table]:await filterAdminCourses(db,user,await all(db,`SELECT * FROM ${table} ORDER BY id`),table==='courses'?'id':'course_id')});
            }
            if(method==='POST'&&!id || method==='PATCH'&&id)return response({item:await saveLearningContent(db,user,table,await body(request),id)},id?200:201);
            if(method==='DELETE'&&id){const item=await record(db,table,id);await scopePermission(db,user,'courses',table==='courses'?item.id:item.course_id);await run(db,`UPDATE ${table} SET ${table==='lessons'?'is_visible':'is_active'}=0 WHERE id=?`,[id]);await audit(db,user,'learning.hide',table,id);return response({archived:true});}
        }
        if(path==='/api/learning/groups'&&method==='GET')return response({groups:await listLearningGroups(db,user)});
        if(path==='/api/admin/learning/groups'&&method==='GET')return response({groups:await listLearningGroups(db,user,true)});
        if(path==='/api/admin/learning/groups'&&method==='POST')return response({item:await saveGroup(db,user,await body(request),null)},201);
        if((match=path.match(/^\/api\/admin\/learning\/groups\/(\d+)$/))){
            const id=Number(match[1]);
            if(method==='PATCH')return response({item:await saveGroup(db,user,await body(request),id)});
            if(method==='DELETE'){const group=await record(db,'groups',id);await scopePermission(db,user,'groups',group.course_id);await run(db,'INSERT INTO school_group_scopes(group_id,is_active) VALUES(?,0) ON CONFLICT(group_id) DO UPDATE SET is_active=0',[id]);await audit(db,user,'group.archive','group',id);return response({archived:true});}
        }
        if((match=path.match(/^\/api\/admin\/learning\/groups\/(\d+)\/members(?:\/(\d+))?$/))){
            const id=Number(match[1]);const group=await record(db,'groups',id);await scopePermission(db,user,'groups',group.course_id);
            if(method==='GET')return response({members:await groupMembers(db,user,id)});
            if(method==='POST'&&!match[2]){const data=await body(request);const uid=positive(data.user_id);await record(db,'users',uid);await run(db,'INSERT OR IGNORE INTO user_groups(user_id,group_id) VALUES(?,?)',[uid,id]);await audit(db,user,'group.member.add','group',id);return response({members:await groupMembers(db,user,id)});}
            if(method==='DELETE'&&match[2]){await run(db,'DELETE FROM user_groups WHERE group_id=? AND user_id=?',[id,Number(match[2])]);await audit(db,user,'group.member.remove','group',id);return response({removed:true});}
        }
        if(path==='/api/learning/exams'&&method==='GET')return response({exams:await listLearningExams(db,user)});
        if(path==='/api/admin/learning/exams'&&method==='GET')return response({exams:await listLearningExams(db,user,true)});
        if(path==='/api/admin/learning/exams'&&method==='POST')return response({item:await saveExam(db,user,await body(request),null)},201);
        if((match=path.match(/^\/api\/admin\/learning\/exams\/(\d+)$/))){
            const id=Number(match[1]);
            if(method==='GET'){const item=await examDefinition(db,id);await scopePermission(db,user,'exams',item.course_id);return response({item});}
            if(method==='PATCH')return response({item:await saveExam(db,user,await body(request),id)});
            if(method==='DELETE'){const item=await record(db,'exams',id);await scopePermission(db,user,'exams',item.course_id);await run(db,'UPDATE exams SET is_active=0 WHERE id=?',[id]);await audit(db,user,'exam.archive','exam',id);return response({archived:true});}
        }
        if((match=path.match(/^\/api\/admin\/learning\/exams\/(\d+)\/assignments(?:\/(\d+))?$/))){
            const id=Number(match[1]);const exam=await record(db,'exams',id);await scopePermission(db,user,'exams',exam.course_id);
            if(method==='GET')return response({assignments:await all(db,'SELECT * FROM school_exam_assignments WHERE exam_id=? ORDER BY id',[id])});
            if(method==='POST'&&!match[2])return response({assignments:await saveAssignment(db,user,id,await body(request))});
            if(method==='DELETE'&&match[2]){await run(db,'DELETE FROM school_exam_assignments WHERE exam_id=? AND id=?',[id,Number(match[2])]);return response({removed:true});}
        }
        if((match=path.match(/^\/api\/admin\/learning\/exams\/(\d+)\/attempts$/))&&method==='GET'){
            const exam=await record(db,'exams',Number(match[1]));await scopePermission(db,user,'exams',exam.course_id);return response({attempts:await all(db,`SELECT a.*,u.first_name,u.last_name,s.status,s.deadline_at FROM exam_attempts a JOIN users u ON u.id=a.user_id LEFT JOIN school_exam_attempts s ON s.attempt_id=a.id WHERE a.exam_id=? ORDER BY a.id DESC`,[Number(match[1])])});
        }
        if((match=path.match(/^\/api\/learning\/exams\/(\d+)\/start$/))&&method==='POST')return response({attempt:await startLearningExam(db,user,Number(match[1]))});
        if((match=path.match(/^\/api\/learning\/attempts\/(\d+)$/))&&method==='GET'){
            const a=await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=? AND user_id=?',[Number(match[1]),user.id]);if(!a)throw new HttpError(404,'Попытка не найдена');
            const exam=await record(db,'exams',a.exam_id);if(!await canReadLearningScope(db,user,exam))throw new HttpError(403,'Нет доступа к экзамену');
            return response({attempt:publicAttempt(a),result:a.result_json?parse(a.result_json,{}):null});
        }
        if((match=path.match(/^\/api\/learning\/attempts\/(\d+)\/submit$/))&&method==='POST')return response(await submitLearningExam(db,user,Number(match[1]),(await body(request)).answers||{}));
        if((match=path.match(/^\/api\/learning\/attempts\/(\d+)\/answers$/))&&method==='PATCH')return response({attempt:await saveLearningExamAnswers(db,user,Number(match[1]),(await body(request)).answers||{})});
        if(path==='/api/admin/students/retake'&&method==='POST')return response(await grantLearningRetake(db,user,await body(request)));
        if(path==='/api/learning/certificates'&&method==='GET')return response({certificates:await listLearningCertificates(db,user)});
        if(path==='/api/admin/learning/certificates'&&method==='GET')return response({certificates:await listLearningCertificates(db,user,true)});
        if(['/api/learning/certificates','/api/admin/learning/certificates'].includes(path)&&method==='POST')return response({certificate:await issueLearningCertificate(db,user,await body(request),path.includes('/admin/'))},201);
        if((match=path.match(/^\/api\/learning\/certificates\/eligibility\/(\d+)$/))&&method==='GET')return response(await certificateEligibility(db,user,Number(match[1])));
        if((match=path.match(/^\/api\/learning\/certificates\/(\d+)\/download$/))&&method==='GET')return learningCertificateDocument(db,user,Number(match[1]));
        if((match=path.match(/^\/api\/admin\/learning\/certificates\/(\d+)\/revoke$/))&&method==='POST'){
            const id=Number(match[1]);const certificate=await record(db,'certificates',id);await scopePermission(db,user,'certificates',certificate.course_id);await run(db,'UPDATE certificates SET is_valid=0,revoked_at=CURRENT_TIMESTAMP WHERE id=?',[id]);await audit(db,user,'certificate.revoke','certificate',id);return response({revoked:true});
        }
        if((match=path.match(/^\/api\/admin\/learning\/certificate-settings\/(\d+)$/))){
            const id=Number(match[1]);await scopePermission(db,user,'certificates',id);
            if(method==='GET')return response({settings:await certificateSettings(db,id)});
            if(method==='PATCH')return response({settings:await saveCertificateSettings(db,user,id,await body(request))});
        }
        throw new HttpError(404,'Маршрут обучения не найден');
    }catch(error){
        const status=Number(error.status)||500;if(status===500)console.error('Learning request failed',error);
        return ctx.json?ctx.json({ok:false,error:status===500?'Не удалось выполнить операцию обучения':error.message},status,env):json({ok:false,error:status===500?'Не удалось выполнить операцию обучения':error.message},status);
    }
}

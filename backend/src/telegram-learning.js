import { getTelegramUser, hasPermission } from "./bot-access.js";

const PAGE_SIZE = 8;
const entityConfig = {
    course: { table: "courses", name: "name", visible: "is_active" },
    semester: { table: "semesters", name: "name", visible: "is_active" },
    subject: { table: "subjects", name: "name", visible: "is_active" },
    lesson: { table: "lessons", name: "title", visible: "is_visible" }
};
const html = value => String(value ?? "").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const label = value => [...String(value ?? "").replace(/\s+/g, " ")].slice(0, 70).join("");
const button = (text, callback_data) => ({ text: label(text), callback_data });
const back = callback => [button("⬅️ Назад", callback)];
const privateChat = message => message?.chat?.type === "private" && String(message.chat.id) === String(message.from?.id);

async function send(env, chatId, text, rows = []) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
            ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Не удалось отправить сообщение Telegram");
    return data.result;
}

export async function ensureLearningTables(env) {
    await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_learning_links (
            kind TEXT NOT NULL CHECK(kind IN ('semester','lesson')), id INTEGER NOT NULL,
            url TEXT NOT NULL, PRIMARY KEY(kind,id))`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_learning_states (
            chat_id INTEGER PRIMARY KEY, state TEXT, after_id INTEGER NOT NULL DEFAULT 0)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_learning_actions (
            action_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    ]);
}

export function validateTelegramLearningUrl(value) {
    try {
        const url = new URL(String(value).trim());
        if (url.protocol !== "https:" || url.hostname !== "t.me" || url.username || url.password || url.port ||
            !/^\/(?:\+[\w-]+|joinchat\/[\w-]+|c\/\d+\/\d+|[A-Za-z0-9_]{3,}(?:\/\d+)?)\/?$/.test(url.pathname) || url.hash) return null;
        return url.href;
    } catch { return null; }
}

export async function cancelLearningDraft(env, chatId, messageId = 0) {
    await ensureLearningTables(env);
    await env.DB.prepare(`INSERT INTO telegram_learning_states(chat_id,state,after_id) VALUES (?,NULL,?)
        ON CONFLICT(chat_id) DO UPDATE SET state=NULL,after_id=MAX(after_id,excluded.after_id)`)
        .bind(chatId, messageId || 0).run();
}

async function mayEdit(env, chatId, permission = "courses") {
    const user = await getTelegramUser(env, chatId);
    if (user && user.status !== "active") return false;
    return hasPermission(env, chatId, permission);
}

async function entity(env, kind, id) {
    if (!entityConfig[kind]) return null;
    return env.DB.prepare(`SELECT * FROM ${entityConfig[kind].table} WHERE id=?`).bind(id).first();
}

async function semesterContext(env, id, onlyActive = false) {
    return env.DB.prepare(`SELECT s.*,c.name AS course_name FROM semesters s JOIN courses c ON c.id=s.course_id
        JOIN programs p ON p.id=s.program_id AND p.course_id=c.id
        WHERE s.id=? ${onlyActive ? "AND s.is_active=1 AND c.is_active=1 AND p.is_active=1" : ""}`)
        .bind(id).first();
}

async function canStudy(env, userId, semesterId) {
    const user = await env.DB.prepare("SELECT status FROM users WHERE id=?").bind(userId).first();
    if (user?.status !== "active") return false;
    const access = await env.DB.prepare("SELECT status FROM user_semesters WHERE user_id=? AND semester_id=?")
        .bind(userId, semesterId).first();
    // Payment grants a specific semester. Legacy access_until is intentionally not an expiry gate.
    return access?.status === "active";
}

export async function getSemesterLearningLinks(env, userId, semesterId) {
    await ensureLearningTables(env);
    const semester = await semesterContext(env, semesterId, true);
    if (!semester || !await canStudy(env, userId, semesterId)) return { allowed: false, channelUrl: null, lessons: [] };
    const link = await env.DB.prepare("SELECT url FROM telegram_learning_links WHERE kind='semester' AND id=?").bind(semesterId).first();
    const lessons = await env.DB.prepare(`SELECT l.id,l.title,l.lesson_number AS lessonNumber,s.name AS subjectName,k.url
        FROM lessons l JOIN subjects s ON s.id=l.subject_id AND s.semester_id=l.semester_id
        LEFT JOIN telegram_learning_links k ON k.kind='lesson' AND k.id=l.id
        WHERE l.semester_id=? AND l.is_visible=1 AND s.is_active=1 ORDER BY s.sort_order,s.id,l.sort_order,l.id LIMIT 100`)
        .bind(semesterId).all();
    return { allowed: true, courseName: semester.course_name, semesterName: semester.name || `${semester.number} семестр`,
        channelUrl: validateTelegramLearningUrl(link?.url), lessons: (lessons.results || []).map(row => ({ ...row, url: validateTelegramLearningUrl(row.url) })) };
}

async function paged(env, chatId, title, sql, params, render, navPrefix, page, tail) {
    const result = await env.DB.prepare(`${sql} LIMIT ? OFFSET ?`).bind(...params, PAGE_SIZE + 1, page * PAGE_SIZE).all();
    const rows = (result.results || []).slice(0, PAGE_SIZE).map(row => [render(row)]);
    const pagination = [];
    if (page > 0) pagination.push(button("⬅️ Ещё", `${navPrefix}${page - 1}`));
    if ((result.results || []).length > PAGE_SIZE) pagination.push(button("Ещё ➡️", `${navPrefix}${page + 1}`));
    if (pagination.length) rows.push(pagination);
    rows.push(...tail);
    return send(env, chatId, `${title}${(result.results || []).length ? "" : "\n\nПока ничего не добавлено."}`, rows);
}

export async function showLearningCourses(env, chatId, page = 0) {
    const user = await getTelegramUser(env, chatId);
    if (!user || user.status !== "active") return send(env, chatId, "Доступ к обучению ограничен. Обратитесь в поддержку.", [[button("💬 Поддержка", "support")]]);
    return paged(env, chatId, "📚 <b>Курсы</b>\nВыберите курс, затем семестр и предмет.",
        "SELECT id,name FROM courses WHERE is_active=1 ORDER BY id", [],
        row => button(`📚 ${row.name}`, `learn_course_${row.id}_0`), "learn_courses_", page,
        [[button("🏠 Главное меню", "main")]]);
}

async function showStudentSemesters(env, chatId, courseId, page) {
    const course = await entity(env, "course", courseId);
    if (!course?.is_active) return send(env, chatId, "Курс недоступен.", [back("program")]);
    return paged(env, chatId, `📚 <b>${html(label(course.name))}</b>\nВыберите семестр.`,
        `SELECT s.* FROM semesters s JOIN programs p ON p.id=s.program_id AND p.course_id=s.course_id
         WHERE s.course_id=? AND s.is_active=1 AND p.is_active=1 ORDER BY s.number,s.id`, [courseId],
        row => button(`🎓 ${row.name || `${row.number} семестр`}`, `learn_semester_${row.id}_0`),
        `learn_course_${courseId}_`, page, [back("program")]);
}

async function showStudentSemester(env, chatId, semesterId, page = 0) {
    const semester = await semesterContext(env, semesterId, true);
    const user = await getTelegramUser(env, chatId);
    if (!semester || !user || user.status !== "active") return send(env, chatId, "Семестр недоступен.", [back("program")]);
    const allowed = await canStudy(env, user.id, semesterId);
    const rows = [];
    if (allowed) {
        const link = await env.DB.prepare("SELECT url FROM telegram_learning_links WHERE kind='semester' AND id=?").bind(semesterId).first();
        const url = validateTelegramLearningUrl(link?.url);
        if (url) rows.push([{ text: "🔗 Закрытый канал семестра", url }]);
    } else {
        rows.push([button("💳 Оплатить семестр", `pay_options_${semesterId}`)]);
    }
    rows.push(back(`learn_course_${semester.course_id}_0`));
    return paged(env, chatId,
        `🎓 <b>${html(label(semester.name || `${semester.number} семестр`))}</b>\n📚 ${html(label(semester.course_name))}\n\n${allowed ? "✅ Семестр оплачен. Выберите предмет или откройте канал." : `Для доступа оплатите этот семестр. Цена: ${semester.price_rub} ₽.`}`,
        "SELECT * FROM subjects WHERE semester_id=? AND is_active=1 ORDER BY sort_order,id", [semesterId],
        row => button(`📖 ${row.name} · ${semester.number} семестр`, `learn_subject_${row.id}_0`),
        `learn_semester_${semesterId}_`, page, rows);
}

async function showStudentSubject(env, chatId, subjectId, page) {
    const subject = await entity(env, "subject", subjectId);
    const semester = subject && await semesterContext(env, subject.semester_id, true);
    if (!subject?.is_active || !semester || subject.course_id !== semester.course_id || subject.program_id !== semester.program_id) {
        return send(env, chatId, "Предмет недоступен.", [back("program")]);
    }
    return paged(env, chatId, `📖 <b>${html(label(subject.name))}</b>\n🎓 ${html(label(semester.name || `${semester.number} семестр`))}`,
        "SELECT * FROM lessons WHERE subject_id=? AND semester_id=? AND is_visible=1 ORDER BY sort_order,id", [subjectId,semester.id],
        row => button(`Урок ${row.lesson_number || row.sort_order || 1}: ${row.title}`, `learn_lesson_${row.id}`),
        `learn_subject_${subjectId}_`, page, [back(`learn_semester_${semester.id}_0`)]);
}

async function showStudentLesson(env, chatId, lessonId) {
    const lesson = await entity(env, "lesson", lessonId);
    const subject = lesson?.subject_id && await entity(env, "subject", lesson.subject_id);
    const semester = lesson && await semesterContext(env, lesson.semester_id, true);
    const user = await getTelegramUser(env, chatId);
    if (!lesson?.is_visible || !subject?.is_active || !semester || subject.semester_id !== semester.id || !user || user.status !== "active") {
        return send(env, chatId, "Урок недоступен.", [back("program")]);
    }
    const heading = `📖 <b>${html(label(subject.name))}</b>\n🎓 ${html(label(semester.name || `${semester.number} семестр`))}\nУрок ${lesson.lesson_number || 1}: ${html(label(lesson.title))}`;
    if (!await canStudy(env, user.id, semester.id)) return send(env, chatId, `${heading}\n\n🔒 Материалы доступны после оплаты семестра.`,
        [[button("💳 Оплатить семестр", `pay_options_${semester.id}`)],back(`learn_subject_${subject.id}_0`)]);
    const links = await env.DB.prepare("SELECT kind,url FROM telegram_learning_links WHERE (kind='lesson' AND id=?) OR (kind='semester' AND id=?)")
        .bind(lesson.id,semester.id).all();
    const rows = (links.results || []).flatMap(link => {
        const url = validateTelegramLearningUrl(link.url);
        return url ? [[{ text: link.kind === "lesson" ? "▶️ Открыть урок" : "🔗 Закрытый канал семестра", url }]] : [];
    });
    const content = rows.length ? "Материалы находятся в Telegram." : "Преподаватель готовит материалы. Можно написать в поддержку.";
    rows.push([button("💬 Поддержка", "support")],back(`learn_subject_${subject.id}_0`));
    return send(env, chatId, `${heading}\n\n${content}`, rows);
}

async function showAdminCourse(env, chatId, id) {
    const course = await entity(env, "course", id);
    if (!course) return send(env, chatId, "Курс не найден.", [back("admin_courses_list")]);
    return send(env, chatId, `📚 <b>${html(label(course.name))}</b>\n${course.is_active ? "Виден ученикам" : "Скрыт от учеников"}`, [
        [button("🎓 Семестры", `learn_as_${id}_0`)],
        [button("✏️ Название курса", `learn_edit_course_${id}`)],
        [button(course.is_active ? "🙈 Скрыть курс" : "👁 Показать курс", `learn_toggle_course_${id}_${course.is_active ? 0 : 1}`)],
        back("admin_courses_list")
    ]);
}

async function showAdminSemesters(env, chatId, courseId, page) {
    const course = await entity(env,"course",courseId);
    if (!course) return send(env,chatId,"Курс не найден.",[back("admin_courses_list")]);
    return paged(env, chatId, `🎓 <b>Семестры: ${html(label(course.name))}</b>`,
        "SELECT * FROM semesters WHERE course_id=? ORDER BY number,id", [courseId],
        row => button(`${row.is_active ? "🎓" : "🙈"} ${row.name || `${row.number} семестр`}`, `learn_am_${row.id}_0`),
        `learn_as_${courseId}_`,page, [[button("➕ Добавить семестр", `learn_new_semester_${courseId}`)],back(`learn_ac_${courseId}`)]);
}

async function showAdminSemester(env, chatId, id, page) {
    const semester = await semesterContext(env,id);
    if (!semester) return send(env,chatId,"Семестр не найден.",[back("admin_courses_list")]);
    const link = await env.DB.prepare("SELECT url FROM telegram_learning_links WHERE kind='semester' AND id=?").bind(id).first();
    return paged(env,chatId,
        `🎓 <b>${html(label(semester.name || `${semester.number} семестр`))}</b>\n📚 ${html(label(semester.course_name))}\nЦена: ${semester.price_rub} ₽\n${semester.is_active ? "Виден ученикам" : "Скрыт"}\nКанал: ${link?.url ? html(link.url) : "ссылка ещё не задана"}`,
        "SELECT * FROM subjects WHERE semester_id=? ORDER BY sort_order,id",[id],
        row=>button(`${row.is_active ? "📖" : "🙈"} ${row.name}`,`learn_au_${row.id}_0`),`learn_am_${id}_`,page,[
            [button("➕ Добавить предмет",`learn_new_subject_${id}`)],
            [button("🔗 Ссылка закрытого канала",`learn_edit_channel_${id}`)],
            [button("✏️ Название",`learn_edit_semester_${id}`),button("💰 Цена",`learn_edit_price_${id}`)],
            [button("💳 Способы оплаты",`pay_admin_semester_${id}`)],
            [button(semester.is_active ? "🙈 Скрыть семестр" : "👁 Показать семестр",`learn_toggle_semester_${id}_${semester.is_active ? 0 : 1}`)],
            back(`learn_as_${semester.course_id}_0`)
        ]);
}

async function showAdminSubject(env,chatId,id,page) {
    const subject=await entity(env,"subject",id);
    if (!subject) return send(env,chatId,"Предмет не найден.",[back("admin_courses_list")]);
    const semester=await semesterContext(env,subject.semester_id);
    return paged(env,chatId,`📖 <b>${html(label(subject.name))}</b>\n🎓 ${html(label(semester?.name || `${semester?.number} семестр`))}`,
        "SELECT * FROM lessons WHERE subject_id=? ORDER BY sort_order,id",[id],
        row=>button(`${row.is_visible ? "▶️" : "🙈"} Урок ${row.lesson_number || 1}: ${row.title}`,`learn_al_${row.id}`),`learn_au_${id}_`,page,[
            [button("➕ Добавить урок",`learn_new_lesson_${id}`)],
            [button("✏️ Название предмета",`learn_edit_subject_${id}`)],
            [button(subject.is_active ? "🙈 Скрыть предмет" : "👁 Показать предмет",`learn_toggle_subject_${id}_${subject.is_active ? 0 : 1}`)],
            back(`learn_am_${subject.semester_id}_0`)
        ]);
}

async function showAdminLesson(env,chatId,id) {
    const lesson=await entity(env,"lesson",id);
    if (!lesson) return send(env,chatId,"Урок не найден.",[back("admin_courses_list")]);
    const subject=await entity(env,"subject",lesson.subject_id);
    const semester=await semesterContext(env,lesson.semester_id);
    const link=await env.DB.prepare("SELECT url FROM telegram_learning_links WHERE kind='lesson' AND id=?").bind(id).first();
    return send(env,chatId,`▶️ <b>Урок ${lesson.lesson_number || 1}: ${html(label(lesson.title))}</b>\n📖 ${html(label(subject?.name))}\n🎓 ${html(label(semester?.name || `${semester?.number} семестр`))}\n\nПост урока: ${link?.url ? html(link.url) : "не задан; будет доступна ссылка канала семестра"}`, [
        [button("✏️ Название урока",`learn_edit_lesson_${id}`)],
        [button("🔗 Ссылка на пост урока",`learn_edit_post_${id}`)],
        [button(lesson.is_visible ? "🙈 Скрыть урок" : "👁 Показать урок",`learn_toggle_lesson_${id}_${lesson.is_visible ? 0 : 1}`)],
        back(`learn_au_${lesson.subject_id}_0`)
    ]);
}

function parentScreen(kind,id) {
    return ({course:`learn_ac_${id}`,semester:`learn_am_${id}_0`,subject:`learn_au_${id}_0`,lesson:`learn_al_${id}`,channel:`learn_am_${id}_0`,price:`learn_am_${id}_0`,post:`learn_al_${id}`})[kind];
}

async function prompt(env,callback,mode,kind,id) {
    const chatId=callback.message.chat.id;
    if (kind === "price" && !await mayEdit(env,chatId,"payments")) return send(env,chatId,"🔒 Нет права изменять оплату.",[back(`learn_am_${id}_0`)]);
    const parentKind= mode === "new" ? ({semester:"course",subject:"semester",lesson:"subject"})[kind] : ({channel:"semester",post:"lesson",price:"semester"})[kind] || kind;
    const target=await entity(env,parentKind,id);
    if (!target) return send(env,chatId,"Объект не найден.",[back("admin_courses_list")]);
    const draft={mode,kind,id,nonce:crypto.randomUUID()};
    const eventId=callback.id || `message:${chatId}:${callback.message.message_id}:${callback.data}`;
    const [saved]=await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO telegram_learning_actions(action_id) VALUES (?)").bind(eventId),
        env.DB.prepare(`INSERT INTO telegram_learning_states(chat_id,state,after_id) SELECT ?,?,? WHERE changes()=1
            ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,after_id=MAX(after_id,excluded.after_id)`)
            .bind(chatId,JSON.stringify(draft),callback.message.message_id || 0)
    ]);
    if (!saved.meta?.changes) return;
    let instruction;
    if (kind === "channel") instruction="Отправьте ссылку-приглашение в закрытый канал этого семестра: https://t.me/+…\nПосле подтверждённой оплаты ученик получит её в чате. Чтобы убрать ссылку, отправьте «-».";
    else if (kind === "post") instruction="Отправьте ссылку https://t.me/… на пост урока. Для закрытого поста ученик должен вступить в канал по ссылке семестра. Отправьте «-», чтобы убрать ссылку.";
    else if (kind === "price") instruction="Отправьте цену семестра в рублях целым числом от 1 до 1 000 000.";
    else instruction=`Отправьте ${mode === "new" ? "название нового" : "новое название"} ${({course:"курса",semester:"семестра",subject:"предмета",lesson:"урока"})[kind]} (2–100 символов).`;
    return send(env,chatId,instruction,[[button("❌ Отмена",`learn_cancel_${draft.nonce}`)]]);
}

export async function handleLearningMessage(env,message) {
    if (!privateChat(message)) return false;
    await ensureLearningTables(env);
    const row=await env.DB.prepare("SELECT * FROM telegram_learning_states WHERE chat_id=?").bind(message.chat.id).first();
    if (!row?.state) return false;
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= row.after_id) return true;
    const draft=JSON.parse(row.state);
    if (!await mayEdit(env,message.chat.id) || (draft.kind === "price" && !await mayEdit(env,message.chat.id,"payments"))) {
        await cancelLearningDraft(env,message.chat.id,message.message_id);
        await send(env,message.chat.id,"🔒 Нет права изменять этот раздел.",[back("admin")]); return true;
    }
    const input=String(message.text || "").trim();
    if (input.startsWith("/")) return false;
    let value=input.replace(/\s+/g," ");
    let error="";
    if (draft.kind === "channel" || draft.kind === "post") {
        value = input === "-" ? "" : validateTelegramLearningUrl(input);
        if (value === null || (draft.kind === "channel" && value && !/^https:\/\/t\.me\/(?:\+|joinchat\/)/.test(value))) error="Нужна ссылка-приглашение https://t.me/+… для канала или корректная ссылка https://t.me/… для поста.";
    } else if (draft.kind === "price") {
        if (!/^\d+$/.test(input) || Number(input)<1 || Number(input)>1000000) error="Введите целую сумму от 1 до 1 000 000 рублей.";
        value=Number(input);
    } else if (!message.text || [...value].length<2 || [...value].length>100) error="Отправьте название текстом: от 2 до 100 символов.";
    if (error) { await send(env,message.chat.id,`❌ ${error}`,[[button("❌ Отмена",`learn_cancel_${draft.nonce}`)]]); return true; }
    const guard="EXISTS (SELECT 1 FROM telegram_learning_states WHERE chat_id=? AND state=?)";
    const binds=[message.chat.id,row.state];
    const statements=[];
    if (draft.mode === "new" && draft.kind === "semester") {
        statements.push(env.DB.prepare(`INSERT INTO programs(course_id,name,is_active) SELECT c.id,c.name,1 FROM courses c
            WHERE c.id=? AND NOT EXISTS(SELECT 1 FROM programs WHERE course_id=c.id AND is_active=1) AND ${guard}`)
            .bind(draft.id,...binds));
        statements.push(env.DB.prepare(`INSERT INTO semesters(course_id,program_id,number,name,price_rub,payment_enabled)
            SELECT p.course_id,p.id,COALESCE((SELECT MAX(number) FROM semesters WHERE course_id=p.course_id),0)+1,?,3000,0
            FROM programs p WHERE p.id=(SELECT id FROM programs WHERE course_id=? AND is_active=1 ORDER BY id LIMIT 1) AND ${guard}`)
            .bind(value,draft.id,...binds));
    } else if (draft.mode === "new" && draft.kind === "subject") {
        statements.push(env.DB.prepare(`INSERT INTO subjects(course_id,program_id,semester_id,name,sort_order)
            SELECT course_id,program_id,id,?,COALESCE((SELECT MAX(sort_order) FROM subjects WHERE semester_id=s.id),0)+1
            FROM semesters s WHERE id=? AND ${guard}`).bind(value,draft.id,...binds));
    } else if (draft.mode === "new" && draft.kind === "lesson") {
        statements.push(env.DB.prepare(`INSERT INTO lessons(course_id,program_id,semester_id,subject_id,title,lesson_number,sort_order)
            SELECT course_id,program_id,semester_id,id,?,COALESCE((SELECT MAX(lesson_number) FROM lessons WHERE subject_id=s.id),0)+1,
            COALESCE((SELECT MAX(sort_order) FROM lessons WHERE subject_id=s.id),0)+1 FROM subjects s WHERE id=? AND ${guard}`)
            .bind(value,draft.id,...binds));
    } else if (draft.kind === "channel" || draft.kind === "post") {
        const kind=draft.kind === "channel" ? "semester" : "lesson";
        statements.push(env.DB.prepare(`INSERT INTO telegram_learning_links(kind,id,url) SELECT ?,?,? WHERE ${guard}
            AND EXISTS(SELECT 1 FROM ${entityConfig[kind].table} WHERE id=?)
            ON CONFLICT(kind,id) DO UPDATE SET url=excluded.url`).bind(kind,draft.id,value,...binds,draft.id));
    } else if (draft.kind === "price") {
        statements.push(env.DB.prepare(`UPDATE semesters SET price_rub=? WHERE id=? AND ${guard}`).bind(value,draft.id,...binds));
    } else {
        const config=entityConfig[draft.kind];
        if (!config) return false;
        statements.push(env.DB.prepare(`UPDATE ${config.table} SET ${config.name}=? WHERE id=? AND ${guard}`).bind(value,draft.id,...binds));
    }
    statements.push(env.DB.prepare("UPDATE telegram_learning_states SET state=NULL,after_id=? WHERE chat_id=? AND state=?")
        .bind(message.message_id,...binds));
    let result;
    try { result=await env.DB.batch(statements); }
    catch { await send(env,message.chat.id,"❌ Не удалось сохранить. Повторите сообщение или отмените ввод.",[[button("❌ Отмена",`learn_cancel_${draft.nonce}`)]]); return true; }
    const saved=result[result.length-2];
    if (!saved.meta?.changes) { await send(env,message.chat.id,"Изменение уже обработано или объект больше недоступен.",[back("admin_courses_list")]); return true; }
    const screen=draft.mode === "new" ? parentScreen(draft.kind, saved.meta.last_row_id) : parentScreen(draft.kind,draft.id);
    await send(env,message.chat.id,"✅ Сохранено.",[[button("Открыть",screen)],back("admin_courses_list")]);
    return true;
}

export async function handleLearningCallback(env,callback) {
    const data=String(callback.data || "");
    if (!data.startsWith("learn_") && !["program","order"].includes(data)) return false;
    const message={...callback.message,from:callback.from};
    if (!privateChat(message)) return true;
    const chatId=message.chat.id;
    await ensureLearningTables(env);
    const admin=/^learn_(?:ac_|as_|am_|au_|al_|new_|edit_|toggle_|cancel_)/.test(data);
    if (admin && !await mayEdit(env,chatId)) { await send(env,chatId,"🔒 Нет права управлять курсами.",[back("admin")]); return true; }
    const user=await getTelegramUser(env,chatId);
    if (user && user.status!=="active") { await send(env,chatId,"Доступ ограничен. Обратитесь в поддержку.",[[button("💬 Поддержка","support")]]); return true; }
    let m;
    if ((m=data.match(/^learn_cancel_([a-f0-9-]+)$/))) {
        const state=await env.DB.prepare("SELECT state FROM telegram_learning_states WHERE chat_id=?").bind(chatId).first();
        const draft=state?.state ? JSON.parse(state.state) : null;
        if (!draft || draft.nonce!==m[1]) { await send(env,chatId,"Этот ввод уже завершён.",[back("admin_courses_list")]); return true; }
        await cancelLearningDraft(env,chatId,message.message_id);
        const kind=draft.mode === "new" ? ({semester:"course",subject:"semester",lesson:"subject"})[draft.kind] : draft.kind;
        await send(env,chatId,"Ввод отменён.",[back(parentScreen(kind,draft.id))]); return true;
    }
    if ((m=data.match(/^learn_(new|edit)_(course|semester|subject|lesson|channel|post|price)_(\d+)$/))) {
        await prompt(env,callback,m[1],m[2],Number(m[3])); return true;
    }
    await cancelLearningDraft(env,chatId,message.message_id);
    if ((m=data.match(/^learn_toggle_(course|semester|subject|lesson)_(\d+)_(0|1)$/))) {
        const config=entityConfig[m[1]];
        await env.DB.prepare(`UPDATE ${config.table} SET ${config.visible}=? WHERE id=?`).bind(Number(m[3]),Number(m[2])).run();
        await send(env,chatId,m[3]==="1"?"✅ Показано ученикам.":"🙈 Скрыто от учеников.",[back(parentScreen(m[1],Number(m[2])))]); return true;
    }
    if (["program","order"].includes(data)) await showLearningCourses(env,chatId);
    else if ((m=data.match(/^learn_courses_(\d+)$/))) await showLearningCourses(env,chatId,Math.min(Number(m[1]),100000));
    else if ((m=data.match(/^learn_course_(\d+)_(\d+)$/))) await showStudentSemesters(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_semester_(\d+)_(\d+)$/))) await showStudentSemester(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_subject_(\d+)_(\d+)$/))) await showStudentSubject(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_lesson_(\d+)$/))) await showStudentLesson(env,chatId,Number(m[1]));
    else if ((m=data.match(/^learn_ac_(\d+)$/))) await showAdminCourse(env,chatId,Number(m[1]));
    else if ((m=data.match(/^learn_as_(\d+)_(\d+)$/))) await showAdminSemesters(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_am_(\d+)_(\d+)$/))) await showAdminSemester(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_au_(\d+)_(\d+)$/))) await showAdminSubject(env,chatId,Number(m[1]),Math.min(Number(m[2]),100000));
    else if ((m=data.match(/^learn_al_(\d+)$/))) await showAdminLesson(env,chatId,Number(m[1]));
    else await send(env,chatId,"Кнопка устарела. Откройте раздел заново.",[back("program")]);
    return true;
}

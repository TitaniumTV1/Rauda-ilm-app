import { all, first, run, HttpError, canReadScope, hasPermission } from './school-core.js';
import {
    ensureLearningSchema, learningCatalog, listLearningLessons, learningLesson,
    completeLearningLesson, listLearningExams, startLearningExam, submitLearningExam,
    listLearningCertificates, issueLearningCertificate, listLearningGroups, canReadLearningScope, saveLearningExamAnswers
} from './learning.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trim = (value, length=65) => [...String(value ?? '').replace(/\s+/g,' ')].slice(0,length).join('');
const button = (text, data) => ({text:trim(text),callback_data:data});
const back = (data='learn:home') => [button('⬅️ Назад',data)];
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const number = text => /^\d+$/.test(text || '') && Number.isSafeInteger(Number(text)) ? Number(text) : 0;
function appUrl(env, path='') {
    try {const url=new URL(env.PUBLIC_APP_URL || env.CORS_ORIGIN);if(url.protocol!=='https:')return null;return new URL(path,url.origin).href;}catch{return null;}
}

/** sendMessage uses the existing bot helper signature (env, chatId, text, markup). */
export async function handleLearningBot(env,update,user,sendMessage) {
    const callback=update?.callback_query;
    const message=callback?.message || update?.message;
    const from=callback?.from || message?.from;
    const text=String(message?.text || '').trim();
    let data=callback?.data || '';
    if(!callback){
        const command=text.split(/\s+/)[0].split('@')[0];
        const commands={'/learn':'learn:home','/exams':'learn:exams','/certificates':'learn:certificates','/groups':'learn:groups','/admin_learning':'learn:admin'};
        data=commands[command] || (text==='📚 Программа курса'?'learn:home':'');
    }
    if(data==='program')data='learn:home';
    if(!String(data).startsWith('learn:'))return false;
    if(message?.chat?.type!=='private' || String(message.chat.id)!==String(from?.id) || String(user?.telegram_id)!==String(from?.id))return true;
    const chatId=message.chat.id;
    const send=(content,rows=[])=>sendMessage(env,chatId,content,rows.length?{inline_keyboard:rows}:undefined);
    try{
        if(!user || user.status!=='active')throw new HttpError(403,'Доступ к аккаунту ограничен. Обратитесь в поддержку.');
        await ensureLearningSchema(env.DB);
        const db=env.DB;
        const bits=String(data).split(':');const action=bits[1];const id=number(bits[2]);const page=number(bits[3]);
        const paged=async(title,items,render,prefix,tail=[])=>{
            const size=8;const offset=Math.min(page,10000)*size;const rows=items.slice(offset,offset+size).map(i=>[render(i)]);const nav=[];
            if(page>0)nav.push(button('⬅️ Ещё',`${prefix}:${page-1}`));if(items.length>offset+size)nav.push(button('Ещё ➡️',`${prefix}:${page+1}`));
            if(nav.length)rows.push(nav);rows.push(...tail);await send(title+(items.length?'':'\n\nПока ничего не добавлено.'),rows);
        };
        if(action==='home'){
            const catalog=await learningCatalog(db,user);
            const rows=catalog.courses.map(c=>[button(`📚 ${c.name}`,`learn:course:${c.id}:0`)]);
            rows.push([button('📝 Экзамены','learn:exams'),button('📜 Сертификаты','learn:certificates')],[button('👥 Мои группы','learn:groups')]);
            if(['owner','superadmin','admin'].includes(user.role))rows.push([button('⚙️ Управление обучением','learn:admin')]);
            const url=appUrl(env,'/');if(url)rows.push([{text:'🌐 Открыть приложение',url}]);
            await send('📚 <b>Моё обучение</b>\nВыберите курс. Прогресс в Telegram и приложении общий.',rows);return true;
        }
        if(action==='course'){
            const catalog=await learningCatalog(db,user);const course=catalog.courses.find(c=>c.id===id);if(!course)throw new HttpError(404,'Курс недоступен');
            const programs=catalog.programs.filter(p=>p.course_id===id);
            await paged(`📚 <b>${escape(course.name)}</b>\nВыберите программу.`,programs,p=>button(p.name,`learn:program:${p.id}:0`),`learn:course:${id}`,[back()]);return true;
        }
        if(action==='program'){
            const catalog=await learningCatalog(db,user);const program=catalog.programs.find(p=>p.id===id);if(!program)throw new HttpError(404,'Программа недоступна');
            await paged(`📖 <b>${escape(program.name)}</b>\nВыберите семестр.`,catalog.semesters.filter(s=>s.program_id===id),s=>button(`${s.has_access?'✅':'🔒'} ${s.number} семестр · ${s.name||''}`,`learn:semester:${s.id}:0`),`learn:program:${id}`,[back(`learn:course:${program.course_id}:0`)]);return true;
        }
        if(action==='semester'){
            const catalog=await learningCatalog(db,user);const semester=catalog.semesters.find(s=>s.id===id);if(!semester)throw new HttpError(404,'Семестр недоступен');
            const subjects=catalog.subjects.filter(s=>s.semester_id===id);const tail=[];
            if(!semester.has_access){const url=appUrl(env,`/#payments`);if(url)tail.push([{text:'💳 Оплата и доступ',url}]);}
            tail.push([button('📚 Все уроки семестра',`learn:lessons:${id}:0`)],back(`learn:program:${semester.program_id}:0`));
            await paged(`🎓 <b>${semester.number} семестр · ${escape(semester.name||'')}</b>\n${semester.has_access?'✅ Доступ открыт':'🔒 Для материалов нужен действующий доступ'}`,subjects,s=>button(s.name,`learn:subject:${s.id}:0`),`learn:semester:${id}`,tail);return true;
        }
        if(action==='subject' || action==='lessons'){
            const catalog=await learningCatalog(db,user);
            const subject=action==='subject'?catalog.subjects.find(s=>s.id===id):null;
            const semesterId=subject?.semester_id || id;
            if(action==='subject'&&!subject || !catalog.semesters.some(s=>s.id===semesterId))throw new HttpError(404,'Раздел недоступен');
            const lessons=await listLearningLessons(db,user,subject?{subject_id:id}:{semester_id:id});
            await paged(`📖 <b>${escape(subject?.name || 'Уроки семестра')}</b>`,lessons,l=>button(`${l.is_completed?'✅':l.locked?'🔒':'▶️'} ${l.lesson_number||''}. ${l.title}`,`learn:lesson:${l.id}:0`),`learn:${action}:${id}`,[back(`learn:semester:${semesterId}:0`)]);return true;
        }
        if(action==='lesson'){
            const lesson=await learningLesson(db,user,id);const content=String(lesson.content||lesson.description||'Материалы урока находятся в приложении.');
            const pages=[...content];const slice=pages.slice(page*2300,(page+1)*2300).join('');const rows=[];
            if(page>0)rows.push([button('⬅️ Текст',`learn:lesson:${id}:${page-1}`)]);
            if(pages.length>(page+1)*2300)rows.push([button('Текст ➡️',`learn:lesson:${id}:${page+1}`)]);
            const url=appUrl(env,`/#lesson/${id}`);if(url)rows.push([{text:lesson.files.length?'📎 Материалы и плеер':'🌐 Урок в приложении',url}]);
            rows.push([button('✅ Завершить урок',`learn:complete:${id}`)],back(`learn:${lesson.subject_id?'subject':'lessons'}:${lesson.subject_id||lesson.semester_id}:0`));
            await send(`📖 <b>${escape(trim(lesson.title,150))}</b>\n\n${escape(slice)}`,rows);return true;
        }
        if(action==='complete'){
            const result=await completeLearningLesson(db,user,id);const rows=[];
            if(result.next_lesson_id)rows.push([button('Следующий урок ➡️',`learn:lesson:${result.next_lesson_id}:0`)]);
            rows.push([button('📝 Экзамены','learn:exams')],back());await send('✅ Урок завершён. Прогресс сохранён.',rows);return true;
        }
        if(action==='groups'){
            const groups=await listLearningGroups(db,user);
            await send('👥 <b>Мои группы</b>\n\n'+(groups.map(g=>`${escape(g.name)}${g.cohort?' · '+escape(g.cohort):''}`).join('\n')||'Вы пока не состоите в группе.'),[back()]);return true;
        }
        if(action==='exams'){
            const exams=await listLearningExams(db,user);const rows=exams.map(e=>[button(`${e.active_attempt_id?'▶️':e.can_attempt?'📝':'🔒'} ${e.title}`,`learn:exam:${e.id}`)]);
            rows.push(back());await send('📝 <b>Экзамены</b>\n'+(exams.length?'Выберите экзамен. Таймер и попытки общие для приложения и Telegram.':'Доступных экзаменов пока нет.'),rows);return true;
        }
        if(action==='exam'){
            const exams=await listLearningExams(db,user);const exam=exams.find(e=>e.id===id);if(!exam)throw new HttpError(404,'Экзамен недоступен');
            const rows=[];
            if(exam.active_attempt_id || exam.can_attempt)rows.push([button(exam.active_attempt_id?'▶️ Продолжить':'▶️ Начать экзамен',`learn:begin:${id}`)]);
            rows.push(back('learn:exams'));
            await send(`📝 <b>${escape(exam.title)}</b>\nВремя: ${exam.time_limit_minutes||60} мин.\nПроходной результат: ${exam.passing_score}%\nОсталось попыток: ${exam.attempts_remaining}\n${exam.reason?escape(exam.reason):''}`,rows);return true;
        }
        const loadAttempt=async attemptId=>{
            const attempt=await first(db,'SELECT * FROM school_exam_attempts WHERE attempt_id=? AND user_id=?',[attemptId,user.id]);
            if(!attempt)throw new HttpError(404,'Попытка не найдена');
            const exam=await first(db,'SELECT * FROM exams WHERE id=?',[attempt.exam_id]);if(!await canReadLearningScope(db,user,exam))throw new HttpError(403,'Доступ к экзамену прекращён');
            return attempt;
        };
        const showResult=async result=>send(`${result.timed_out?'⌛ Время истекло':result.passed?'✅ Экзамен сдан':'📝 Экзамен завершён'}\nРезультат: ${result.score}/${result.max_score} (${result.percentage}%).`,[[button('📜 Сертификаты','learn:certificates')],back('learn:exams')]);
        const showQuestion=async attemptId=>{
            const attempt=await loadAttempt(attemptId);
            if(attempt.status!=='started'){await showResult(parse(attempt.result_json,{}));return;}
            if(Date.now()>=new Date(attempt.deadline_at).getTime()){await showResult((await submitLearningExam(db,user,attemptId,{})).result);return;}
            const snapshot=parse(attempt.snapshot_json,{questions:[]});
            const state=await first(db,'SELECT * FROM school_telegram_exam_answers WHERE telegram_id=? AND attempt_id=?',[String(user.telegram_id),attemptId]);
            const index=Math.min(Number(state?.question_index||0),snapshot.questions.length-1);const q=snapshot.questions[index];
            if(!q)throw new HttpError(409,'Вопросы экзамена не найдены');
            const selected=parse(attempt.answers_json,{})[q.id]||[];
            const rows=q.answers.map(a=>[button(`${selected.includes(a.id)?'☑️':'◻️'} ${trim(a.answer_text,50)}`,`learn:pick:${attemptId}:${q.id}:${a.id}:${selected.includes(a.id)?0:1}`)]);
            if(index+1<snapshot.questions.length)rows.push([button('Следующий вопрос ➡️',`learn:next:${attemptId}:${index}`)]);
            else rows.push([button('✅ Отправить ответы',`learn:submit:${attemptId}`)]);
            const url=appUrl(env,`/#attempt/${attempt.exam_id}`);if(url)rows.push([{text:'🌐 Открыть экзамен в приложении',url}]);
            await send(`📝 <b>Вопрос ${index+1} из ${snapshot.questions.length}</b>\n${escape(trim(q.question,1800))}\n\n${q.question_type==='multiple'?'Выберите все правильные ответы.':'Выберите один ответ.'}\nОсталось ${Math.max(1,Math.ceil((new Date(attempt.deadline_at)-Date.now())/60000))} мин.`,rows);
        };
        if(action==='begin'){
            const attempt=await startLearningExam(db,user,id);
            await run(db,'INSERT OR IGNORE INTO school_telegram_exam_answers(telegram_id,attempt_id) VALUES(?,?)',[String(user.telegram_id),attempt.id]);
            await showQuestion(attempt.id);return true;
        }
        if(action==='pick'){
            const attempt=await loadAttempt(id);if(attempt.status!=='started'){await showResult(parse(attempt.result_json,{}));return true;}
            if(Date.now()>=new Date(attempt.deadline_at).getTime()){await showResult((await submitLearningExam(db,user,id,{})).result);return true;}
            const state=await first(db,'SELECT * FROM school_telegram_exam_answers WHERE telegram_id=? AND attempt_id=?',[String(user.telegram_id),id]);
            if(!state)throw new HttpError(409,'Откройте экзамен заново');
            const snapshot=parse(attempt.snapshot_json,{questions:[]});const q=snapshot.questions[Number(state.question_index)];
            const questionId=number(bits[3]),answerId=number(bits[4]),selected=bits[5]==='1';
            if(!q || q.id!==questionId || !q.answers.some(a=>a.id===answerId)){await showQuestion(id);return true;}
            const answers=parse(attempt.answers_json,{});let chosen=answers[q.id]||[];
            if(q.question_type==='single')chosen=selected?[answerId]:[];
            else chosen=selected?[...new Set([...chosen,answerId])]:chosen.filter(x=>x!==answerId);
            answers[q.id]=chosen;
            await saveLearningExamAnswers(db,user,id,answers);
            await showQuestion(id);return true;
        }
        if(action==='next'){
            await loadAttempt(id);const index=number(bits[3]);
            await run(db,'UPDATE school_telegram_exam_answers SET question_index=question_index+1 WHERE telegram_id=? AND attempt_id=? AND question_index=?',[String(user.telegram_id),id,index]);
            await showQuestion(id);return true;
        }
        if(action==='submit'){
            const attempt=await loadAttempt(id);
            const result=await submitLearningExam(db,user,id,parse(attempt.answers_json,{}));await showResult(result.result);return true;
        }
        if(action==='certificates'){
            const certificates=await listLearningCertificates(db,user);const catalog=await learningCatalog(db,user);const rows=[];
            for(const c of certificates){const url=appUrl(env,c.download_url);if(url&&Number(c.is_valid))rows.push([{text:`📜 ${trim(c.course_name,45)}`,url}]);}
            for(const c of catalog.courses)if(!certificates.some(cert=>cert.course_id===c.id&&Number(cert.is_valid)))rows.push([button(`Получить: ${c.name}`,`learn:certificate:${c.id}`)]);
            rows.push(back());await send('📜 <b>Сертификаты</b>\nГотовый сертификат откроется после входа в приложение. Формат — печатный HTML, который можно сохранить как PDF в браузере.\nИмя или кунью можно указать при получении в приложении.',rows);return true;
        }
        if(action==='certificate'){
            const certificate=await issueLearningCertificate(db,user,{course_id:id});const url=appUrl(env,certificate.download_url);const rows=url?[[{text:'📜 Открыть сертификат',url}],back('learn:certificates')]:[back('learn:certificates')];
            await send(`✅ Сертификат выпущен на имя <b>${escape(certificate.certificate_name)}</b>.\n${escape(certificate.certificate_number)}`,rows);return true;
        }
        if(action==='admin'){
            const rows=[];const names={courses:'📚 Курсы и уроки',groups:'👥 Группы',exams:'📝 Экзамены',certificates:'📜 Сертификаты'};
            for(const [permission,name] of Object.entries(names))if(await hasPermission(db,user,permission)){const url=appUrl(env,`/admin/#${permission}`);if(url)rows.push([{text:name,url}]);}
            if(!rows.length)throw new HttpError(403,'Нет прав управления обучением');rows.push(back());
            await send('⚙️ <b>Управление обучением</b>\nРедакторы вопросов, групп, материалов и шаблона сертификата открываются в защищённой админке. Данные общие с Telegram.',rows);return true;
        }
        await send('Эта кнопка устарела. Откройте раздел заново.',[back()]);return true;
    }catch(error){
        if(!error.status)console.error('Telegram learning failed',error);
        await send(error.status?`❗ ${escape(error.message)}`:'Не удалось открыть обучение. Попробуйте ещё раз.',[back()]);return true;
    }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchoolSchema } from '../src/school-schema.js';
import {
    ensureLearningSchema, handleLearningRequest, startLearningExam, submitLearningExam,
    grantLearningRetake, completeLearningLesson, learningLesson, listLearningLessons,
    certificateEligibility, issueLearningCertificate, learningCertificateDocument,
    validateExamQuestions
} from '../src/learning.js';
import { handleLearningBot } from '../src/telegram-learning.js';

class Statement {
    constructor(db,sql,args=[]) {this.db=db;this.sql=sql;this.args=args;}
    bind(...args) {return new Statement(this.db,this.sql,args);}
    execute() {
        const stmt=this.db.prepare(this.sql);
        if(stmt.columns().length)return{success:true,results:stmt.all(...this.args),meta:{changes:0}};
        const r=stmt.run(...this.args);return{success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};
    }
    async all(){return this.execute();}
    async run(){return this.execute();}
    async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
}
async function fixture(t) {
    const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
    sql.exec(readFileSync(new URL('../../database/schema.sql',import.meta.url),'utf8'));
    const db={prepare:q=>new Statement(sql,q),async batch(statements){sql.exec('BEGIN');try{const r=statements.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
    await ensureSchoolSchema(db);await ensureLearningSchema(db);
    sql.exec(`INSERT INTO users(id,telegram_id,first_name,role,status) VALUES
        (1,1001,'Owner','owner','active'),(2,2001,'Student','student','active'),(3,3001,'Other','student','active'),(4,4001,'Limited admin','admin','active');
        INSERT INTO courses(id,name) VALUES(1,'Course');
        INSERT INTO programs(id,course_id,name) VALUES(1,1,'Program');
        INSERT INTO semesters(id,course_id,program_id,number,name) VALUES(1,1,1,1,'Semester');
        INSERT INTO subjects(id,course_id,program_id,semester_id,name) VALUES(1,1,1,1,'Subject');
        INSERT INTO lessons(id,course_id,program_id,semester_id,subject_id,title,content,sort_order,is_visible) VALUES
        (1,1,1,1,1,'First','Secret first text',1,1),(2,1,1,1,1,'Second','Secret second text',2,1),(3,1,1,1,1,'Hidden','Secret hidden text',3,0);
        INSERT INTO user_semesters(user_id,semester_id,status,access_until) VALUES(2,1,'active','2099-01-01T00:00:00.000Z');`);
    const users=Object.fromEntries(sql.prepare('SELECT * FROM users').all().map(u=>[u.id,u]));
    const env={DB:db,PUBLIC_APP_URL:'https://school.invalid'};
    const ctx={requireUser:async req=>({ok:true,user:users[Number(req.headers.get('X-Test-User')||2)]}),json:(data,status)=>Response.json(data,{status})};
    async function api(path,method='GET',payload,userId=2){
        const response=await handleLearningRequest(new Request('https://school.invalid'+path,{method,headers:{'X-Test-User':String(userId),...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})}),env,ctx);
        return{status:response.status,data:await response.json()};
    }
    async function exam(extra={}){
        const r=await api('/api/admin/learning/exams','POST',{title:'Exam',course_id:1,program_id:1,semester_id:1,subject_id:1,time_limit_minutes:10,attempts_allowed:1,passing_score:60,
            questions:[{question:'Choose correct',question_type:'single',points:2,answers:[{answer_text:'Correct',is_correct:true},{answer_text:'Wrong',is_correct:false}]}],...extra},1);
        assert.equal(r.status,201,JSON.stringify(r.data));return r.data.item;
    }
    async function finish(){await completeLearningLesson(db,users[2],1);await completeLearningLesson(db,users[2],2);}
    const correct=e=>Object.fromEntries(e.questions.map(q=>[q.id,q.answers.filter(a=>a.is_correct).map(a=>a.id)]));
    return{sql,db,users,env,api,exam,finish,correct};
}

test('learning lists summaries, enforces purchase and expiry, and does not reveal hidden lessons',async t=>{
    const f=await fixture(t);
    const denied=await f.api('/api/learning/lessons/1','GET',null,3);assert.equal(denied.status,403);
    const list=await f.api('/api/learning/lessons?semester_id=1');assert.equal(list.status,200);
    assert.deepEqual(list.data.lessons.map(l=>l.id),[1,2]);assert.equal(list.data.lessons[1].locked,true);
    assert.ok(!JSON.stringify(list).includes('Secret'));
    assert.equal((await f.api('/api/learning/lessons/3')).status,403);
    f.sql.prepare("UPDATE user_semesters SET access_until='2020-01-01' WHERE user_id=2").run();
    assert.equal((await f.api('/api/learning/lessons/1')).status,403);
});

test('sequential completion and next lesson share the canonical D1 progress',async t=>{
    const f=await fixture(t);
    assert.equal((await f.api('/api/learning/lessons/2/complete','POST',{})).status,409);
    const first=await f.api('/api/learning/lessons/1/complete','POST',{});
    assert.equal(first.status,200);assert.equal(first.data.next_lesson_id,2);assert.equal(first.data.progress.is_completed,1);
    const second=await learningLesson(f.db,f.users[2],2);assert.equal(second.title,'Second');
    assert.equal((await f.api('/api/learning/lessons/3/complete','POST',{})).status,403);
});

test('content creation derives parents and rejects mismatches and powerless administrators',async t=>{
    const f=await fixture(t);
    assert.equal((await f.api('/api/admin/learning/subjects','POST',{semester_id:1,name:'Other subject'},4)).status,403);
    const r=await f.api('/api/admin/learning/subjects','POST',{semester_id:1,name:'Other subject'},1);
    assert.equal(r.status,201);assert.equal(r.data.item.course_id,1);assert.equal(r.data.item.program_id,1);
    assert.equal((await f.api('/api/admin/learning/lessons','POST',{subject_id:r.data.item.id,course_id:999,title:'Broken'},1)).status,400);
    assert.equal((await f.api('/api/admin/learning/lessons','POST',{subject_id:r.data.item.id,title:'New lesson'},1)).status,201);
});

test('exam input validates keys, unique answers and supported question types',()=>{
    assert.throws(()=>validateExamQuestions([]),/от 1/);
    assert.throws(()=>validateExamQuestions([{question:'?',answers:[{answer_text:'same',is_correct:true},{answer_text:'same'}]}]),/различаться/);
    assert.throws(()=>validateExamQuestions([{question:'?',answers:[{answer_text:'A',is_correct:true},{answer_text:'B',is_correct:true}]}]),/правильные/);
    assert.throws(()=>validateExamQuestions([{question:'?',question_type:'text',answers:[]}]),/вариантов/);
});

test('exams require completed lessons and exclude answer keys from all learner data',async t=>{
    const f=await fixture(t);const exam=await f.exam();
    const before=await f.api(`/api/learning/exams/${exam.id}/start`,'POST',{});assert.equal(before.status,403);assert.match(before.data.error,/уроки/);
    await f.finish();
    const list=await f.api('/api/learning/exams');assert.equal(list.status,200);assert.ok(!JSON.stringify(list.data).includes('is_correct'));
    const attempt=await f.api(`/api/learning/exams/${exam.id}/start`,'POST',{});assert.equal(attempt.status,200);
    assert.ok(!JSON.stringify(attempt.data).includes('is_correct'));assert.ok(!JSON.stringify(attempt.data).includes('snapshot_json'));
    const other=await f.api(`/api/learning/attempts/${attempt.data.attempt.id}`,'GET',null,3);assert.equal(other.status,404);
});

test('simultaneous start resumes exactly one attempt; simultaneous submit cannot replace a result',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();
    const [a,b]=await Promise.all([startLearningExam(f.db,f.users[2],exam.id),startLearningExam(f.db,f.users[2],exam.id)]);
    assert.equal(a.id,b.id);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM exam_attempts').get().n,1);
    const [r1,r2]=await Promise.all([submitLearningExam(f.db,f.users[2],a.id,f.correct(exam)),submitLearningExam(f.db,f.users[2],a.id,{})]);
    assert.deepEqual(r1.result,r2.result);assert.equal(r1.result.passed,true);
    await assert.rejects(startLearningExam(f.db,f.users[2],exam.id),/Попытки закончились/);
});

test('snapshot preserves questions and scoring when an administrator edits the exam',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();const attempt=await startLearningExam(f.db,f.users[2],exam.id);
    const edited=await f.api(`/api/admin/learning/exams/${exam.id}`,'PATCH',{questions:[{question:'Different',question_type:'single',points:100,answers:[{answer_text:'New right',is_correct:true},{answer_text:'New wrong'}]}]},1);
    assert.equal(edited.status,200);
    const result=await submitLearningExam(f.db,f.users[2],attempt.id,f.correct(exam));assert.equal(result.result.score,2);assert.equal(result.result.max_score,2);assert.equal(result.result.passed,true);
});

test('deadline is enforced on the server even with correct answers',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();const attempt=await startLearningExam(f.db,f.users[2],exam.id);
    const result=await submitLearningExam(f.db,f.users[2],attempt.id,f.correct(exam),Date.parse(attempt.deadline_at)+1);
    assert.equal(result.result.timed_out,true);assert.equal(result.result.passed,false);assert.equal(result.result.score,0);
    assert.equal(f.sql.prepare('SELECT submitted_at FROM exam_attempts WHERE id=?').get(attempt.id).submitted_at,result.attempt.status==='timed_out'?f.sql.prepare('SELECT submitted_at FROM school_exam_attempts WHERE attempt_id=?').get(attempt.id).submitted_at:null);
});

test('canonical extra attempt permits a retake after success and respects administrator rights',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();const a=await startLearningExam(f.db,f.users[2],exam.id);await submitLearningExam(f.db,f.users[2],a.id,f.correct(exam));
    assert.equal((await f.api('/api/admin/students/retake','POST',{user_id:2,assessment_id:exam.id,type:'exam'},4)).status,403);
    const grant=await f.api('/api/admin/students/retake','POST',{user_id:2,assessment_id:exam.id,type:'exam'},1);assert.equal(grant.status,200);assert.equal(grant.data.extra_attempts,1);
    const next=await startLearningExam(f.db,f.users[2],exam.id);assert.notEqual(next.id,a.id);
    assert.equal(f.sql.prepare("SELECT extra_attempts FROM assessment_access WHERE user_id=2 AND assessment_type='exam'").get().extra_attempts,1);
});

test('group assignment grants exam visibility only to assigned members and does not grant paid access',async t=>{
    const f=await fixture(t);const exam=await f.exam({assignment_required:true});await f.finish();
    assert.equal((await f.api(`/api/learning/exams/${exam.id}/start`,'POST',{})).status,403);
    const group=await f.api('/api/admin/learning/groups','POST',{name:'Cohort A',semester_id:1,cohort:'Autumn'},1);assert.equal(group.status,201);
    const gid=group.data.item.id;
    assert.equal((await f.api(`/api/admin/learning/groups/${gid}/members`,'POST',{user_id:2},1)).status,200);
    assert.equal((await f.api(`/api/admin/learning/exams/${exam.id}/assignments`,'POST',{target_type:'group',target_id:gid},1)).status,200);
    assert.equal((await f.api(`/api/learning/exams/${exam.id}/start`,'POST',{})).status,200);
    await f.api(`/api/admin/learning/groups/${gid}/members`,'POST',{user_id:3},1);
    assert.equal((await f.api(`/api/learning/exams/${exam.id}/start`,'POST',{},3)).status,403);
    const members=await f.api(`/api/admin/learning/groups/${gid}/members`,'GET',null,1);assert.equal(members.data.members.find(m=>m.id===2).progress_percent,100);
    assert.equal((await f.api(`/api/admin/learning/groups/${gid}/members`,'GET')).status,403);
});

test('student-specific assignment dates constrain the attempt deadline',async t=>{
    const f=await fixture(t);const exam=await f.exam({assignment_required:true});await f.finish();const closes=new Date(Date.now()+60000).toISOString();
    await f.api(`/api/admin/learning/exams/${exam.id}/assignments`,'POST',{target_type:'user',target_id:2,closes_at:closes},1);
    const a=await startLearningExam(f.db,f.users[2],exam.id);assert.equal(a.deadline_at,closes);
});

test('invalid answer IDs are rejected instead of affecting scoring',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();const a=await startLearningExam(f.db,f.users[2],exam.id);
    await assert.rejects(submitLearningExam(f.db,f.users[2],a.id,{[exam.questions[0].id]:[999999]}),/не относится/);
    assert.equal(f.sql.prepare('SELECT status FROM school_exam_attempts').get().status,'started');
});

test('certificate requires completion and passed exams, issues once, escapes names and enforces ownership/revocation',async t=>{
    const f=await fixture(t);const exam=await f.exam();
    assert.equal((await certificateEligibility(f.db,f.users[2],1)).eligible,false);await f.finish();
    assert.equal((await certificateEligibility(f.db,f.users[2],1)).eligible,false);
    const a=await startLearningExam(f.db,f.users[2],exam.id);await submitLearningExam(f.db,f.users[2],a.id,f.correct(exam));
    const [c1,c2]=await Promise.all([issueLearningCertificate(f.db,f.users[2],{course_id:1,certificate_name:'Абу <script>alert(1)</script>'}),issueLearningCertificate(f.db,f.users[2],{course_id:1,certificate_name:'Абу <script>alert(1)</script>'})]);
    assert.equal(c1.id,c2.id);assert.equal(c1.format,'html');
    const doc=await learningCertificateDocument(f.db,f.users[2],c1.id);const html=await doc.text();assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
    await assert.rejects(learningCertificateDocument(f.db,f.users[3],c1.id),e=>e.status===403);
    assert.equal((await f.api(`/api/admin/learning/certificates/${c1.id}/revoke`,'POST',{},4)).status,403);
    assert.equal((await f.api(`/api/admin/learning/certificates/${c1.id}/revoke`,'POST',{},1)).status,200);
    await assert.rejects(learningCertificateDocument(f.db,f.users[2],c1.id),e=>e.status===410);
});

test('blocked users cannot bypass learning through the Telegram handler; unknown updates are ignored',async t=>{
    const f=await fixture(t);const messages=[];const send=async(_env,_chat,text,markup)=>messages.push({text,markup});
    assert.equal(await handleLearningBot(f.env,{message:{text:'/other'}},f.users[2],send),false);
    const blocked={...f.users[2],status:'blocked'};
    await handleLearningBot(f.env,{message:{text:'/learn',from:{id:2001},chat:{id:2001,type:'private'}}},blocked,send);
    assert.match(messages.at(-1).text,/ограничен/);assert.ok(!messages.some(m=>m.text.includes('Secret')));
});

test('Telegram completes the same lesson and conducts an exam without exposing answer keys',async t=>{
    const f=await fixture(t);const exam=await f.exam();const messages=[];const send=async(_env,_chat,text,markup)=>messages.push({text,markup});
    const callback=async data=>handleLearningBot(f.env,{callback_query:{id:crypto.randomUUID(),data,from:{id:2001},message:{message_id:1,chat:{id:2001,type:'private'}}}},f.users[2],send);
    await callback('learn:complete:1');assert.equal(f.sql.prepare('SELECT is_completed FROM lesson_progress WHERE lesson_id=1').get().is_completed,1);
    await callback('learn:complete:2');await callback(`learn:begin:${exam.id}`);
    const attempt=f.sql.prepare('SELECT attempt_id FROM school_exam_attempts').get().attempt_id;
    const q=exam.questions[0],answer=q.answers.find(a=>a.is_correct);
    await callback(`learn:pick:${attempt}:${q.id}:${answer.id}:1`);await callback(`learn:pick:${attempt}:${q.id}:${answer.id}:1`);
    await callback(`learn:submit:${attempt}`);assert.equal(f.sql.prepare('SELECT passed FROM exam_attempts').get().passed,1);
    assert.ok(!JSON.stringify(messages).includes('is_correct'));
});

test('admin course assignment restricts content lists and mutations, including nested identifiers',async t=>{
    const f=await fixture(t);
    f.sql.exec(`INSERT INTO courses(id,name) VALUES(2,'Other course'); INSERT INTO programs(id,course_id,name) VALUES(2,2,'Other program');
        INSERT INTO admin_permissions(admin_id,permission) VALUES(4,'courses');INSERT INTO admin_courses(admin_id,course_id) VALUES(4,1);`);
    const catalog=await f.api('/api/admin/learning/catalog','GET',null,4);assert.equal(catalog.status,200);assert.deepEqual(catalog.data.courses.map(c=>c.id),[1]);
    assert.equal((await f.api('/api/admin/learning/courses/2','PATCH',{name:'Unauthorized change'},4)).status,403);
    assert.equal((await f.api('/api/admin/learning/programs/2','DELETE',null,4)).status,403);
    assert.equal((await f.api('/api/admin/learning/semesters','POST',{program_id:2,name:'Foreign semester',number:1},4)).status,403);
});

test('multiple choice awards only the complete correct set; shared answer drafts resume between channels',async t=>{
    const f=await fixture(t);const exam=await f.exam({questions:[{question:'Two choices',question_type:'multiple',points:4,answers:[{answer_text:'A',is_correct:true},{answer_text:'B',is_correct:true},{answer_text:'C'}]}]});await f.finish();
    const a=await startLearningExam(f.db,f.users[2],exam.id);const q=exam.questions[0];
    const draft=await f.api(`/api/learning/attempts/${a.id}/answers`,'PATCH',{answers:{[q.id]:[q.answers[0].id]}});assert.equal(draft.status,200);
    const resumed=await startLearningExam(f.db,f.users[2],exam.id);assert.deepEqual(resumed.answers[String(q.id)],[q.answers[0].id]);
    const messages=[];const send=async(_env,_id,text,markup)=>messages.push({text,markup});
    await handleLearningBot(f.env,{callback_query:{data:`learn:begin:${exam.id}`,from:{id:2001},message:{chat:{id:2001,type:'private'}}}},f.users[2],send);
    assert.ok(messages.at(-1).markup.inline_keyboard[0][0].text.startsWith('☑️'));
    const result=await submitLearningExam(f.db,f.users[2],a.id,resumed.answers);assert.equal(result.result.score,0);
});

test('expired active attempt is closed before a granted extra attempt starts',async t=>{
    const f=await fixture(t);const exam=await f.exam();await f.finish();const old=await startLearningExam(f.db,f.users[2],exam.id);
    f.sql.prepare("UPDATE school_exam_attempts SET deadline_at='2020-01-01T00:00:00Z' WHERE attempt_id=?").run(old.id);
    await grantLearningRetake(f.db,f.users[1],{user_id:2,assessment_id:exam.id});
    const fresh=await startLearningExam(f.db,f.users[2],exam.id);assert.notEqual(fresh.id,old.id);
    assert.equal(f.sql.prepare('SELECT status FROM school_exam_attempts WHERE attempt_id=?').get(old.id).status,'timed_out');
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM school_exam_attempts WHERE status='started'").get().n,1);
});

test('legacy retake counts transfer exactly once without discarding canonical grants',async t=>{
    const f=await fixture(t);const exam=await f.exam();
    f.sql.exec(`CREATE TABLE assessment_retake_permissions(user_id INTEGER,assessment_type TEXT,assessment_id INTEGER,extra_attempts INTEGER,granted_by INTEGER);
        INSERT INTO assessment_retake_permissions VALUES(2,'exam',${exam.id},2,1);
        INSERT INTO assessment_access(user_id,assessment_type,assessment_id,extra_attempts) VALUES(2,'exam',${exam.id},1);`);
    // A new D1 wrapper represents a fresh Worker isolate over the same database.
    const fresh={prepare:f.db.prepare,batch:f.db.batch};await ensureLearningSchema(fresh);
    assert.equal(f.sql.prepare('SELECT extra_attempts FROM assessment_access').get().extra_attempts,3);
    await ensureLearningSchema({prepare:f.db.prepare,batch:f.db.batch});assert.equal(f.sql.prepare('SELECT extra_attempts FROM assessment_access').get().extra_attempts,3);
});

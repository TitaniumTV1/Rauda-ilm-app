import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleTelegramWebhook} from '../src/telegram-bot.js';

class Statement {
    constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
    bind(...args){return new Statement(this.db,this.sql,args);}
    execute(){const s=this.db.prepare(this.sql);if(s.columns().length)return{results:s.all(...this.args),meta:{changes:0}};const r=s.run(...this.args);return{results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
    async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
    async all(){return this.execute();}
    async run(){return this.execute();}
}
function fixture(t,{scoped=true}={}){
    const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec(readFileSync(new URL('../../database/schema.sql',import.meta.url),'utf8'));
    sql.exec(`INSERT INTO users(id,telegram_id,first_name,role) VALUES(1,1001,'Owner','owner'),(2,2001,'Scoped admin','admin');
        INSERT INTO admin_permissions(admin_id,permission) VALUES(2,'courses');
        INSERT INTO courses(id,name) VALUES(1,'Assigned course'),(2,'FOREIGN PRIVATE COURSE');
        INSERT INTO programs(id,course_id,name) VALUES(1,1,'Assigned program'),(2,2,'FOREIGN PRIVATE PROGRAM');
        INSERT INTO semesters(id,course_id,program_id,number,name) VALUES(1,1,1,1,'Assigned semester'),(2,2,2,1,'FOREIGN PRIVATE SEMESTER');
        INSERT INTO subjects(id,course_id,program_id,semester_id,name) VALUES(1,1,1,1,'Assigned subject'),(2,2,2,2,'FOREIGN PRIVATE SUBJECT');
        INSERT INTO lessons(id,course_id,program_id,semester_id,subject_id,title,content) VALUES(1,1,1,1,1,'Assigned lesson','Accessible'),(2,2,2,2,2,'FOREIGN PRIVATE LESSON','FOREIGN PRIVATE CONTENT');`);
    if(scoped)sql.exec('INSERT INTO admin_courses(admin_id,course_id) VALUES(2,1)');
    const env={TELEGRAM_BOT_TOKEN:'mock',TELEGRAM_WEBHOOK_SECRET:'mock',OWNER_TELEGRAM_ID:'1001',PUBLIC_APP_URL:'https://school.invalid',DB:{prepare:s=>new Statement(sql,s),async batch(a){sql.exec('BEGIN');try{const r=a.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}}};
    const messages=[];t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(new URL(url).hostname,'api.telegram.org');const payload=JSON.parse(options.body);if(url.endsWith('/sendMessage'))messages.push(payload);return Response.json({ok:true,result:{message_id:messages.length}});});
    let seq=1;
    async function update(body){const r=await handleTelegramWebhook(new Request('https://school.invalid/api/webhooks/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'mock','Content-Type':'application/json'},body:JSON.stringify(body)}),env);assert.equal(r.status,200);}
    return{sql,env,messages,update,last:()=>messages.at(-1),callback:async data=>{const id=seq++;await update({callback_query:{id:String(id),data,from:{id:2001},message:{message_id:id,chat:{id:2001,type:'private'}}}});},message:async text=>{const id=seq++;await update({message:{message_id:id,text,from:{id:2001},chat:{id:2001,type:'private'}}});}};
}

test('scoped Telegram administrator sees only assigned courses and cannot forge nested callbacks',async t=>{
    const f=fixture(t);await f.callback('admin_courses_list');assert.match(f.last().text,/Assigned course/);assert.ok(!f.last().text.includes('FOREIGN'));
    const blocked=['admin_course_2','admin_course_semesters_2','admin_semester_2','admin_semester_subjects_2','admin_semester_lessons_2','admin_subject_2','admin_subject_channel_2','admin_lesson_2','admin_lesson_files_2'];
    for(const data of blocked){await f.callback(data);assert.match(f.last().text,/нет доступа/i,data);assert.ok(!f.last().text.includes('FOREIGN'));}
    await f.callback('admin_lesson_1');assert.match(f.last().text,/Assigned lesson/);
});

test('scoped administrator cannot create a course; narrowing scope invalidates pending creation',async t=>{
    const f=fixture(t,{scoped:false});await f.message('➕ Создать курс');assert.match(f.last().text,/Отправьте название/);
    f.sql.exec('INSERT INTO admin_courses(admin_id,course_id) VALUES(2,1)');
    await f.message('Must not be saved');assert.match(f.last().text,/Нет доступа/);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM courses').get().n,2);
    await f.callback('admin_courses_create');assert.match(f.last().text,/Нет доступа/);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM courses').get().n,2);
});

test('course creation atomic guard rechecks course scope at database mutation',async t=>{
    const f=fixture(t,{scoped:false});await f.message('➕ Создать курс');
    const batch=f.env.DB.batch;let changed=false;
    f.env.DB.batch=async statements=>{
        if(!changed&&statements.some(s=>s.sql.includes('INSERT INTO courses (name, is_active)'))){f.sql.exec('INSERT INTO admin_courses(admin_id,course_id) VALUES(2,1)');changed=true;}
        return batch(statements);
    };
    await f.message('Rejected by atomic scope guard');assert.equal(changed,true);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM courses').get().n,2);
});

test('pending channel binding is rejected if the subject course is no longer assigned',async t=>{
    const f=fixture(t);await f.callback('admin_subject_channel_1');const state=f.sql.prepare('SELECT bind_code FROM subject_channel_edit_state WHERE chat_id=2001').get();assert.ok(state.bind_code);
    f.sql.exec('UPDATE admin_courses SET course_id=2 WHERE admin_id=2');
    await f.update({channel_post:{message_id:42,chat:{id:-10077,type:'channel',title:'Target'},text:state.bind_code}});
    assert.equal(f.sql.prepare('SELECT telegram_chat_id FROM subjects WHERE id=1').get().telegram_chat_id,null);
});

test('authorized lesson materials button opens its authenticated editor',async t=>{
    const f=fixture(t);await f.callback('admin_lesson_files_1');const link=f.last().reply_markup.inline_keyboard[0][0].url;
    assert.equal(link,'https://school.invalid/admin/#learning/lessons/1');
});

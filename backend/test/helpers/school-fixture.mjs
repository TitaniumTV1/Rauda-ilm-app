import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureSchoolSchema} from '../../src/school-schema.js';
import {ensureCommerceSchema} from '../../src/commerce.js';
import {ensureLearningSchema} from '../../src/learning.js';
import worker from '../../src/index.js';
export function adapt(sqlite,onWrite=()=>{}) {
    class Statement {
        constructor(sql,args=[]){this.sql=sql;this.args=args;}
        bind(...args){return new Statement(this.sql,args);}
        execute(){const s=sqlite.prepare(this.sql);if(s.columns().length)return {results:s.all(...this.args),success:true,meta:{changes:0}};const r=s.run(...this.args);onWrite(this.sql,this.args);return {results:[],success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
        async all(){return this.execute();}async run(){return this.execute();}
        async first(column){const row=sqlite.prepare(this.sql).get(...this.args);return row?(column?row[column]:row):null;}
    }
    return {prepare:sql=>new Statement(sql),async batch(stmts){sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
export async function fixture(t,{live=false,seed=true}={}) {
    const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL(`../../../database/${live?'baseline-2026-09-23.sql':'schema.sql'}`,import.meta.url),'utf8'));
    t?.after(()=>sqlite.close());const DB=adapt(sqlite);await ensureSchoolSchema(DB);await ensureCommerceSchema(DB);await ensureLearningSchema(DB);
    const env={DB,FILES:{},PUBLIC_APP_URL:'https://school.test',CORS_ORIGIN:'https://school.test',TELEGRAM_BOT_USERNAME:'Test_rauda_bot',TELEGRAM_BOT_TOKEN:'test',TELEGRAM_WEBHOOK_SECRET:'secret',OWNER_TELEGRAM_ID:'9001',EMAIL_AUTH_SECRET:'test-only-key'};
    if(seed) {
        sqlite.exec(`INSERT INTO users(id,telegram_id,first_name,role,status) VALUES(1,9001,'Owner','owner','active'),(2,9002,'Learner','student','active'),(3,9003,'Admin','admin','active');
            INSERT INTO courses(id,name) VALUES(1,'Основы'),(2,'Акыда');
            INSERT INTO programs(id,course_id,name) VALUES(1,1,'Программа');
            INSERT INTO semesters(id,course_id,program_id,number) VALUES(1,1,1,1);
            INSERT INTO subjects(id,course_id,program_id,semester_id,name) VALUES(1,1,1,1,'Предмет');
            INSERT INTO lessons(id,course_id,program_id,semester_id,subject_id,title,sort_order,is_visible) VALUES(1,1,1,1,1,'Первый',1,1),(2,1,1,1,1,'Второй',2,1),(3,1,1,1,1,'Скрытый',3,0);
            INSERT INTO lesson_files(id,lesson_id,course_id,file_name,storage_key,mime_type) VALUES(1,1,1,'audio.mp3','audio','audio/mpeg'),(2,1,1,'video.mp4','video','video/mp4'),(3,3,1,'private.pdf','hidden','application/pdf');`);
        for(const id of [1,2,3])sqlite.prepare('INSERT INTO auth_sessions(user_id,token,expires_at) VALUES(?,?,?)').run(id,'test-session-'+id,new Date(Date.now()+3600000).toISOString());
    }
    async function request(path,{user=2,method='GET',body,headers={}}={}) {
        const r=await worker.fetch(new Request('https://school.test'+path,{method,headers:{...(user?{Authorization:'Bearer test-session-'+user}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),env);
        const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,headers:r.headers};
    }
    return {sqlite,env,DB,request,user:id=>sqlite.prepare('SELECT * FROM users WHERE id=?').get(id)};
}

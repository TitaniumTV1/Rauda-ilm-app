import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/school-fixture.mjs';
import {handleAccountBot} from '../src/account-connections.js';
import {saveProgress,assertLessonAccess} from '../src/school-core.js';
import {handleTelegramWebhook} from '../src/telegram-bot.js';
const future=()=>new Date(Date.now()+86400000).toISOString();

for(const live of [false,true]) {
test(`registration and profile work on ${live?'recovered production':'repository'} schema`,async t=>{
 const f=await fixture(t,{live});const r=await f.request('/api/auth/register',{user:null,method:'POST',body:{login:'newlearner',password:'secure-password-123',first_name:'Ученик'}});
 assert.equal(r.status,201,JSON.stringify(r.data));assert.ok(r.headers.get('set-cookie')?.includes('HttpOnly'));assert.equal(r.data.token,undefined);
 const cookie=r.headers.get('set-cookie').split(';')[0];const me=await f.request('/api/auth/me',{user:null,headers:{Cookie:cookie}});
 assert.equal(me.status,200);assert.equal(me.data.user.login,'newlearner');
 assert.ok(f.sqlite.prepare("SELECT * FROM users WHERE login='newlearner'").get().telegram_id<0);
 const login=await f.request('/api/auth/login',{user:null,method:'POST',body:{login:'newlearner',password:'secure-password-123'}});assert.equal(login.status,200);
});
test(`paid, hidden and sequential content enforced through legacy worker routes (${live?'live':'repo'})`,async t=>{
 const f=await fixture(t,{live});
 for(const path of ['/api/lessons/1','/api/lesson-files/1'])assert.equal((await f.request(path)).status,403,path);
 assert.equal((await f.request('/api/progress',{method:'POST',body:{lesson_id:3,completed:true}})).status,403);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lesson_progress').get().n,0);
 f.sqlite.prepare("INSERT INTO user_courses(user_id,course_id,status,access_until) VALUES(2,1,'active',?)").run(future());
 assert.equal((await f.request('/api/lessons/1')).status,200);
 assert.equal((await f.request('/api/lessons/2')).status,409);
 assert.equal((await f.request('/api/lessons/3')).status,403);
 assert.equal((await f.request('/api/lesson-files/3')).status,403);
 assert.equal((await f.request('/api/progress',{method:'POST',body:{lesson_id:1,completed:true}})).status,200);
 assert.equal((await f.request('/api/lessons/2')).status,200);
 f.sqlite.exec("UPDATE user_courses SET access_until='2000-01-01'");assert.equal((await f.request('/api/lessons/1')).status,403);
});
}
test('files use cookie auth, Range, no-store and cannot take token from URL',async t=>{
 const f=await fixture(t);f.sqlite.exec("INSERT INTO user_courses(user_id,course_id,status) VALUES(2,1,'active')");
 let fetched=0;f.env.FILES={async head(){return {size:100};},async get(key,opts){fetched++;return {body:new TextEncoder().encode('abc'),size:100,httpEtag:'"media"',httpMetadata:{contentType:'audio/mpeg'},range:opts?.range?{offset:0,length:3}:undefined};}};
 assert.equal((await f.request('/api/lesson-files/1?token=test-session-2',{user:null})).status,401);
 const r=await f.request('/api/lesson-files/1',{user:null,headers:{Cookie:'__Host-rauda_session=test-session-2',Range:'bytes=0-2'}});
 assert.equal(r.status,206);assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal(r.headers.get('Content-Range'),'bytes 0-2/100');assert.equal(fetched,1);
});
test('per-file playback stays separate and racing save cannot undo completion',async t=>{
 const f=await fixture(t);f.sqlite.exec("INSERT INTO user_courses(user_id,course_id,status) VALUES(2,1,'active')");
 await Promise.all([saveProgress(f.DB,f.user(2),1,{completed:true}),saveProgress(f.DB,f.user(2),1,{file_id:1,position_seconds:30,duration_seconds:60})]);
 await saveProgress(f.DB,f.user(2),1,{file_id:2,position_seconds:12,duration_seconds:120});
 assert.equal(f.sqlite.prepare('SELECT completed FROM lesson_progress').get().completed,1);
 const one=await f.request('/api/progress?lesson_id=1&file_id=1');assert.equal(one.data.progress.position_seconds,30);
 const two=await f.request('/api/progress?lesson_id=1&file_id=2');assert.equal(two.data.progress.position_seconds,12);
 await assert.rejects(()=>saveProgress(f.DB,f.user(2),2,{position_seconds:-1,duration_seconds:10}),/Некорректная/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lesson_progress WHERE lesson_id=2').get().n,0);
 assert.equal((await f.request('/api/progress?lesson_id=1&file_id=3')).status,404);
});
test('inactive earlier subject cannot trap a student behind an invisible prerequisite',async t=>{
 const f=await fixture(t);f.sqlite.exec("INSERT INTO user_courses(user_id,course_id,status) VALUES(2,1,'active'); INSERT INTO subjects(id,course_id,program_id,semester_id,name,is_active) VALUES(2,1,1,1,'Архив',0);UPDATE lessons SET subject_id=2 WHERE id=1");
 await assertLessonAccess(f.DB,f.user(2),f.sqlite.prepare('SELECT * FROM lessons WHERE id=2').get());
});
test('permission aliases work but blocked administrators and owner-only settings stay denied',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/admin/courses',{user:3})).status,403);
 f.sqlite.exec("INSERT INTO admin_permissions(admin_id,permission) VALUES(3,'content')");assert.equal((await f.request('/api/admin/courses',{user:3})).status,200);
 assert.equal((await f.request('/api/admin/school-settings',{user:3})).status,403);
 f.sqlite.exec("UPDATE users SET status='blocked' WHERE id=3");assert.equal((await f.request('/api/admin/courses',{user:3})).status,403);
});
test('writes reject cross-site requests and disabled registration; unknown API does not serve HTML',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/progress',{method:'POST',body:{lesson_id:1,completed:true},headers:{Origin:'https://evil.test'}})).status,403);
 f.sqlite.exec(`INSERT INTO school_settings(key,value_json,updated_at) VALUES('registration_enabled','false',CURRENT_TIMESTAMP)`);
 assert.equal((await f.request('/api/auth/register',{user:null,method:'POST',body:{login:'newuser',password:'long-password'}})).status,403);
 assert.equal((await f.request('/api/missing')).status,404);
});
async function createLink(f){
 f.sqlite.exec("INSERT INTO users(id,telegram_id,first_name,role,status,login,password_hash) VALUES(4,-4,'Сайт','student','active','siteuser','test-hash')");
 f.sqlite.prepare('INSERT INTO auth_sessions(user_id,token,expires_at) VALUES(4,?,?)').run('test-session-4',future());
 const link=await f.request('/api/account/telegram/link',{user:4,method:'POST',body:{}});assert.equal(link.status,200);
 return new URL(link.data.url).searchParams.get('start');
}
test('explicit Telegram link merges only bot-only learner with progress, and concurrent confirmation is once',async t=>{
 const f=await fixture(t,{live:true});f.sqlite.exec("INSERT INTO user_courses(user_id,course_id,status) VALUES(2,1,'active');INSERT INTO lesson_progress(user_id,course_id,lesson_id,completed,is_completed) VALUES(2,1,1,1,1)");
 const token=await createLink(f);const messages=[];const send=async(_e,_id,text,markup)=>messages.push({text,markup});
 const update={message:{from:{id:9002},chat:{id:9002,type:'private'},text:'/start '+token}};
 assert.equal(await handleAccountBot(f.env,update,send),true);assert.equal(f.user(4).telegram_id,-4);
 const callback={callback_query:{from:{id:9002},message:{chat:{id:9002,type:'private'}},data:messages.at(-1).markup.inline_keyboard[0][0].callback_data}};
 await Promise.all([handleAccountBot(f.env,callback,send),handleAccountBot(f.env,callback,send)]);
 assert.equal(f.user(4).telegram_id,9002);assert.equal(f.user(2).status,'blocked');
 assert.equal(f.sqlite.prepare('SELECT completed FROM lesson_progress WHERE user_id=4').get().completed,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM school_account_events WHERE action='telegram_linked'").get().n,1);
});
test('link rejects wrong Telegram, expiry, and independent credentialed account',async t=>{
 const f=await fixture(t);const token=await createLink(f);const out=[];const send=async(...a)=>out.push(a);
 await handleAccountBot(f.env,{message:{from:{id:9002},chat:{id:9002,type:'private'},text:'/start '+token}},send);
 const id=f.sqlite.prepare('SELECT id FROM school_link_challenges').get().id;
 const cb=who=>({callback_query:{from:{id:who},message:{chat:{id:who,type:'private'}},data:'account:confirm:'+id}});
 await handleAccountBot(f.env,cb(9003),send);assert.equal(f.user(4).telegram_id,-4);
 f.sqlite.exec("UPDATE users SET login='separate' WHERE id=2");await handleAccountBot(f.env,cb(9002),send);assert.equal(f.user(4).telegram_id,-4);
 f.sqlite.exec("UPDATE school_link_challenges SET expires_at='2000-01-01'");await handleAccountBot(f.env,cb(9002),send);assert.equal(f.user(4).telegram_id,-4);
});
test('unlink requires alternate login and fresh proof, preserves progress and invalidates other sessions',async t=>{
 const f=await fixture(t);const reg=await f.request('/api/auth/register',{user:null,method:'POST',body:{login:'unlinkuser',password:'strong-password-123',first_name:'Ученик'}});assert.equal(reg.status,201);
 const u=f.sqlite.prepare("SELECT * FROM users WHERE login='unlinkuser'").get();f.sqlite.prepare('UPDATE users SET telegram_id=8008 WHERE id=?').run(u.id);
 f.sqlite.prepare('INSERT INTO auth_sessions(user_id,token,expires_at) VALUES(?,?,?)').run(u.id,'other-session',future());
 const headers={Cookie:reg.headers.get('set-cookie').split(';')[0]};
 assert.equal((await f.request('/api/account/telegram/unlink',{user:null,method:'POST',body:{password:'wrong'},headers})).status,403);
 const r=await f.request('/api/account/telegram/unlink',{user:null,method:'POST',body:{password:'strong-password-123'},headers});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.telegram.linked,false);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM auth_sessions WHERE token='other-session'").get().n,0);
 assert.equal((await f.request('/api/account/telegram/unlink',{user:1,method:'POST',body:{password:'anything'}})).status,409);
});
test('blocked owner cannot use Telegram bypass or invalid webhook secret',async t=>{
 const f=await fixture(t);f.sqlite.exec("UPDATE users SET status='blocked' WHERE id=1");const sent=[];t.mock.method(globalThis,'fetch',async(_url,o)=>{sent.push(JSON.parse(o.body));return Response.json({ok:true});});
 const mk=secret=>new Request('https://school.test/api/webhooks/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({message:{from:{id:9001},chat:{id:9001,type:'private'},text:'➕ Создать курс'}})});
 assert.equal((await handleTelegramWebhook(mk('wrong'),f.env)).status,401);assert.equal(sent.length,0);
 assert.equal((await handleTelegramWebhook(mk('secret'),f.env)).status,200);assert.match(sent[0].text,/ограничен/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM courses').get().n,2);
});
test('owner grants explicit access once and revocation survives a repeated grant request',async t=>{
 const f=await fixture(t);const path='/api/admin/students/2/access',body={scope_type:'semester',scope_id:1,access_days:30,reason:'Перенос оплаченного доступа',request_key:'manual_access_00000001'};
 assert.equal((await f.request(path,{user:3,method:'POST',body})).status,403);
 assert.equal((await f.request(path,{user:1,method:'POST',body:{...body,access_days:null}})).status,400);
 const a=await f.request(path,{user:1,method:'POST',body});assert.equal(a.status,201,JSON.stringify(a.data));
 const b=await f.request(path,{user:1,method:'POST',body});assert.equal(b.data.grant.id,a.data.grant.id);assert.equal(b.data.grant.expires_at,a.data.grant.expires_at);
 assert.equal((await f.request('/api/lessons/1')).status,200);
 assert.equal((await f.request(path+'/'+a.data.grant.id,{user:1,method:'DELETE'})).status,200);
 await f.request(path,{user:1,method:'POST',body});assert.equal((await f.request('/api/lessons/1')).status,403);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='access.grant'").get().n,1);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleTelegramWebhook } from "../src/telegram-bot.js";
import { ensureLearningTables, getSemesterLearningLinks, validateTelegramLearningUrl } from "../src/telegram-learning.js";

function fixture(t) {
    const db=new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../database/schema.sql",import.meta.url),"utf8"));
    db.exec(`INSERT INTO users(id,telegram_id,first_name,role) VALUES(1,101,'Owner','owner'),(2,102,'Admin','admin'),(3,103,'Student','student');
        INSERT INTO admin_permissions(admin_id,permission) VALUES(2,'courses');
        INSERT INTO courses(id,name) VALUES(1,'Ислам');`);
    class Statement {
        constructor(sql,values=[]) { this.sql=sql;this.values=values; }
        bind(...values) { return new Statement(this.sql,values); }
        execute() { const p=db.prepare(this.sql); if(p.columns().length) return {results:p.all(...this.values),success:true,meta:{changes:0}};
            const r=p.run(...this.values);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; }
        async run(){return this.execute();} async all(){return this.execute();}
        async first(column){const r=db.prepare(this.sql).get(...this.values);return r?(column?r[column]:r):null;}
    }
    const env={OWNER_TELEGRAM_ID:"101",TELEGRAM_BOT_TOKEN:"local-test",DB:{prepare:sql=>new Statement(sql),async batch(statements){
        db.exec("BEGIN");try {const results=statements.map(s=>s.execute());db.exec("COMMIT");return results;}catch(e){db.exec("ROLLBACK");throw e;}
    }}};
    const calls=[]; let seq=10;
    t.mock.method(globalThis,"fetch",async(url,options)=>{
        assert.equal(new URL(url).hostname,"api.telegram.org");const data=JSON.parse(options.body);calls.push(data);
        return Response.json({ok:true,result:{message_id:++seq}});
    });
    t.mock.method(console,"error",(...args)=>{throw new Error(`Unexpected webhook error: ${args.map(String).join(" ")}`);});
    t.after(()=>db.close());
    const deliver=update=>handleTelegramWebhook(new Request("https://example.test/api/webhooks/telegram",{method:"POST",body:JSON.stringify(update)}),env);
    const message=(text,user=101,extra={})=>deliver({message:{message_id:++seq,text,chat:{id:user,type:"private"},from:{id:user},...extra}});
    const callback=(data,user=101)=>deliver({callback_query:{id:`cb${++seq}`,data,from:{id:user},message:{message_id:seq,chat:{id:user,type:"private"}}}});
    const last=()=>calls.filter(c=>c.text).at(-1);
    const rows=sql=>db.prepare(sql).all();
    return {db,env,calls,deliver,message,callback,last,rows};
}

async function hierarchy(f) {
    await f.callback("learn_new_semester_1");await f.message("Первый семестр");
    await f.callback("learn_new_subject_1");await f.message("Акыда");
    await f.callback("learn_new_lesson_1");await f.message("Основы веры");
}

test("Telegram admin creates semester, subject and numbered lesson with one internal program",async t=>{
    const f=fixture(t);await hierarchy(f);
    assert.equal(f.rows("SELECT * FROM courses").length,1);
    assert.equal(f.rows("SELECT * FROM programs").length,1);
    assert.equal(f.rows("SELECT * FROM semesters")[0].name,"Первый семестр");
    assert.equal(f.rows("SELECT * FROM subjects")[0].name,"Акыда");
    assert.equal(f.rows("SELECT * FROM lessons")[0].lesson_number,1);
    await f.callback("learn_new_semester_1");await f.message("Второй семестр");
    assert.equal(f.rows("SELECT * FROM programs").length,1);
    assert.equal(f.rows("SELECT number FROM semesters ORDER BY number")[1].number,2);
    await f.callback("learn_al_1");assert.match(f.last().text,/Основы веры/);assert.match(f.last().text,/Акыда/);assert.match(f.last().text,/Первый семестр/);
});

test("course list opens a real course management screen",async t=>{
    const f=fixture(t);await f.message("📚 Список курсов");
    assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="learn_ac_1"));
    await f.callback("learn_ac_1");assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="learn_as_1_0"));
});

test("private channel is sent only for an active paid semester; legacy expiry does not deny access",async t=>{
    const f=fixture(t);await hierarchy(f);
    await f.callback("learn_edit_channel_1");await f.message("https://t.me/+PrivateSemester");
    await f.callback("learn_edit_post_1");await f.message("https://t.me/c/123456/99");
    await f.callback("learn_semester_1_0",103);
    assert.ok(!JSON.stringify(f.last()).includes("PrivateSemester"));
    assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="pay_options_1"));
    await f.callback("learn_lesson_1",103);assert.ok(!JSON.stringify(f.last()).includes("123456/99"));
    f.db.exec("INSERT INTO user_semesters(user_id,semester_id,status,access_until) VALUES(3,1,'active','2000-01-01')");
    await f.callback("learn_semester_1_0",103);assert.ok(JSON.stringify(f.last()).includes("PrivateSemester"));
    await f.callback("learn_lesson_1",103);assert.ok(JSON.stringify(f.last()).includes("123456/99"));
    const links=await getSemesterLearningLinks(f.env,3,1);assert.equal(links.allowed,true);assert.equal(links.channelUrl,"https://t.me/+PrivateSemester");
    f.db.exec("UPDATE user_semesters SET status='blocked'");
    assert.equal((await getSemesterLearningLinks(f.env,3,1)).allowed,false);
    await f.callback("learn_lesson_1",103);assert.ok(!JSON.stringify(f.last()).includes("123456/99"));
});

test("student menu shows course, semester, subject and named lesson",async t=>{
    const f=fixture(t);await hierarchy(f);
    for (const [data,expected] of [["program","learn_course_1_0"],["learn_course_1_0","learn_semester_1_0"],["learn_semester_1_0","learn_subject_1_0"],["learn_subject_1_0","learn_lesson_1"]]) {
        await f.callback(data,103);assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data===expected));
    }
    assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.text.includes("Урок 1: Основы веры")));
});

test("student cannot use any admin content callback or forge a content prompt",async t=>{
    const f=fixture(t);await hierarchy(f);const before=JSON.stringify(f.rows("SELECT * FROM lessons"));
    for(const data of ["learn_ac_1","learn_as_1_0","learn_am_1_0","learn_au_1_0","learn_al_1","learn_edit_channel_1","learn_new_semester_1","learn_toggle_course_1_0"]) {
        await f.callback(data,103);assert.match(f.last().text,/Нет права/);
    }
    f.db.prepare("INSERT INTO telegram_learning_states(chat_id,state,after_id) VALUES(?,?,0)").run(103,JSON.stringify({mode:"edit",kind:"lesson",id:1,nonce:"fake"}));
    await f.message("Взлом",103);assert.equal(JSON.stringify(f.rows("SELECT * FROM lessons")),before);
});

test("payment permission is required in addition to content permission for price changes",async t=>{
    const f=fixture(t);await hierarchy(f);await f.callback("learn_edit_price_1",102);assert.match(f.last().text,/Нет права/);
    f.db.exec("INSERT INTO admin_permissions(admin_id,permission) VALUES(2,'payments')");
    await f.callback("learn_edit_price_1",102);await f.message("4500",102);assert.equal(f.rows("SELECT price_rub FROM semesters")[0].price_rub,4500);
});

test("revoked permissions before submitting title prevent database writes",async t=>{
    const f=fixture(t);await f.callback("learn_new_semester_1",102);f.db.exec("DELETE FROM admin_permissions WHERE admin_id=2");await f.message("Must not exist",102);
    assert.equal(f.rows("SELECT * FROM semesters").length,0);
});

for(const navigation of ["/start","/cancel","❌ Отмена","⬅️ Главное меню","⬅️ Админ-панель","📚 Список курсов","💬 Поддержка"]) {
    test(`${navigation} abandons content input without being stored as a title`,async t=>{
        const f=fixture(t);await f.callback("learn_new_semester_1");await f.message(navigation);assert.equal(f.rows("SELECT * FROM semesters").length,0);
        assert.equal(f.rows("SELECT state FROM telegram_learning_states")[0].state,null);
    });
}

test("replaying prompt and title or concurrent name delivery creates no duplicate",async t=>{
    const f=fixture(t);
    const start={callback_query:{id:"same-event",data:"learn_new_semester_1",from:{id:101},message:{message_id:500,chat:{id:101,type:"private"}}}};
    const title={message:{message_id:501,text:"Первый семестр",from:{id:101},chat:{id:101,type:"private"}}};
    await f.deliver(start);await Promise.all([f.deliver(title),f.deliver(title)]);
    await f.deliver(start);await f.deliver(title);
    assert.equal(f.rows("SELECT * FROM semesters").length,1);assert.equal(f.rows("SELECT * FROM programs").length,1);
});

test("an old cancel button does not cancel a newer draft",async t=>{
    const f=fixture(t);await f.callback("learn_new_semester_1");const cancel=f.last().reply_markup.inline_keyboard[0][0].callback_data;
    await f.callback("learn_new_semester_1");await f.callback(cancel);await f.message("Новый семестр");
    assert.equal(f.rows("SELECT * FROM semesters")[0].name,"Новый семестр");
});

test("failed atomic insert leaves a usable draft and does not orphan internal program",async t=>{
    const f=fixture(t);await f.callback("learn_new_semester_1");
    f.db.exec("CREATE TRIGGER fail_semester BEFORE INSERT ON semesters BEGIN SELECT RAISE(ABORT,'test'); END");
    await f.message("Первый семестр");assert.match(f.last().text,/Не удалось/);assert.equal(f.rows("SELECT * FROM programs").length,0);
    f.db.exec("DROP TRIGGER fail_semester");await f.message("Первый семестр");assert.equal(f.rows("SELECT * FROM semesters").length,1);
});

test("invalid URLs and names keep the form open; links and titles remain editable",async t=>{
    const f=fixture(t);await hierarchy(f);await f.callback("learn_edit_channel_1");
    for(const link of ["https://evil.test/+token","https://t.me@evil.test/+token","http://t.me/+test","https://t.me/c/1/2"]) {
        await f.message(link);assert.match(f.last().text,/Нужна ссылка/);
    }
    await f.message("https://t.me/+ValidInvite");await f.callback("learn_edit_channel_1");await f.message("-");
    assert.equal(f.rows("SELECT url FROM telegram_learning_links")[0].url,"");
    await f.callback("learn_edit_lesson_1");await f.message("<b> Урок & веры");await f.callback("learn_al_1");assert.match(f.last().text,/&lt;b&gt; Урок &amp; веры/);
});

test("blocked students and hidden parent courses never receive links",async t=>{
    const f=fixture(t);await hierarchy(f);await ensureLearningTables(f.env);
    f.db.exec("INSERT INTO telegram_learning_links VALUES('semester',1,'https://t.me/+Secret'); INSERT INTO user_semesters(user_id,semester_id,status,access_until) VALUES(3,1,'active','9999-01-01')");
    f.db.exec("UPDATE courses SET is_active=0");assert.equal((await getSemesterLearningLinks(f.env,3,1)).allowed,false);
    await f.callback("learn_lesson_1",103);assert.ok(!JSON.stringify(f.last()).includes("Secret"));
    f.db.exec("UPDATE courses SET is_active=1; UPDATE users SET status='blocked' WHERE id=3");
    await f.callback("learn_semester_1_0",103);assert.ok(!JSON.stringify(f.last()).includes("Secret"));
});

test("Telegram URL validator rejects unsafe schemes, hostnames and embedded credentials",()=>{
    for(const url of ["javascript:alert(1)","https://t.me.evil.test/+abc","https://u:p@t.me/+abc","https://t.me:8080/+abc","https://t.me/"]) assert.equal(validateTelegramLearningUrl(url),null);
    assert.equal(validateTelegramLearningUrl("https://t.me/c/123/10"),"https://t.me/c/123/10");
});

test("remaining admin buttons show real empty lists or counts and support back navigation",async t=>{
    const f=fixture(t);
    for(const data of ["admin_students","admin_groups","admin_exams","admin_certificates","admin_stats"]){
        await f.callback(data);assert.doesNotMatch(f.last().text,/Здесь будет|подключим/);
        assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="admin"));
        await f.callback(data,103);assert.match(f.last().text,/нет доступа/);
    }
});

test("new native support reply clears an older learning input instead of consuming the next title",async t=>{
    const f=fixture(t);await f.callback("support",103);await f.message("Нужна помощь",103);
    const delivered=f.db.prepare("SELECT telegram_message_id FROM telegram_support_deliveries WHERE recipient_chat_id='101'").get();
    await f.callback("learn_new_semester_1");
    await f.message("Ответ преподавателя",101,{reply_to_message:{message_id:delivered.telegram_message_id}});
    assert.equal(f.rows("SELECT state FROM telegram_learning_states WHERE chat_id=101")[0].state,null);
    await f.message("Обычный текст");assert.equal(f.rows("SELECT * FROM semesters").length,0);
});

test("active webhook protection rejects spoofed owner payment changes before dispatch",async t=>{
    const f=fixture(t);
    f.db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO app_settings(key,value) VALUES('telegram_webhook_secured','1')");
    f.env.TELEGRAM_WEBHOOK_SECRET="local-private-verification-key";
    const payload={message:{message_id:99,text:"➕ Создать курс",chat:{id:101,type:"private"},from:{id:101}}};
    const unsigned=await f.deliver(payload);assert.equal(unsigned.status,401);assert.equal(f.calls.length,0);
    const signed=await handleTelegramWebhook(new Request("https://example.test/api/webhooks/telegram",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":f.env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(payload)}),f.env);
    assert.equal(signed.status,200);assert.match(f.last().text,/Создание курса/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
    ensureCommerceSchema, getSchoolSettings, updateSchoolSettings, saveOffer, listOffers,
    createOrder, checkPayment, handleCommerceRequest, handleYooKassaWebhookRequest,
    handleTributeWebhookRequest, isYooKassaSourceIp
} from "../src/commerce.js";

const OWNER={id:1,role:"owner",status:"active",telegram_id:1001};
const STUDENT={id:2,role:"student",status:"active",telegram_id:2001};
class Statement {
    constructor(db,sql,values=[]) { this.db=db;this.sql=sql;this.values=values; }
    bind(...values) { return new Statement(this.db,this.sql,values); }
    execute() {
        const s=this.db.prepare(this.sql);
        if(s.columns().length) return {results:s.all(...this.values),meta:{changes:0}};
        const r=s.run(...this.values);return {results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};
    }
    async run(){return this.execute();}
    async all(){return this.execute();}
    async first(){return this.db.prepare(this.sql).get(...this.values)||null;}
}
async function fixture(t, baseline="schema.sql") {
    const sqlite=new DatabaseSync(":memory:");
    sqlite.exec(readFileSync(new URL(`../../database/${baseline}`,import.meta.url),"utf8"));
    sqlite.exec(`INSERT INTO users(id,telegram_id,role) VALUES(1,1001,'owner'),(2,2001,'student'),(3,3001,'student');
        INSERT INTO courses(id,name) VALUES(1,'Подготовительный курс'),(2,'Другая программа');
        INSERT INTO programs(id,course_id,name) VALUES(1,1,'Программа');
        INSERT INTO semesters(id,course_id,program_id,number) VALUES(1,1,1,1),(2,1,1,2);`);
    const env={DB:{prepare:sql=>new Statement(sqlite,sql),async batch(statements){sqlite.exec("BEGIN");try{const r=statements.map(s=>s.execute());sqlite.exec("COMMIT");return r;}catch(e){sqlite.exec("ROLLBACK");throw e;}}},
        YOOKASSA_SHOP_ID:"test-shop",YOOKASSA_SECRET_KEY:"not-a-real-key",TRIBUTE_API_KEY:"test-tribute-key"};
    const calls=[];const providerPayments=new Map();const providerRefunds=new Map();let outage=false;let refundStatus="succeeded";
    const product={id:501,type:"digital",isCustom:false,status:"approved",amount:150000,currency:"RUB",starsAmountEnabled:true,starsAmount:800,link:"https://t.me/tribute/app?startapp=p501",webLink:"https://web.tribute.tg/p/501"};
    t.mock.method(globalThis,"fetch",async (url,options={})=>{
        const u=new URL(url);const body=options.body?JSON.parse(options.body):null;calls.push({url:u.href,method:options.method||"GET",body,headers:options.headers});
        if(outage) throw new Error("simulated network loss");
        if(u.hostname==="tribute.tg" && u.pathname==="/api/v1/products/501") return Response.json(product);
        if(u.hostname==="tribute.tg" && /^\/api\/v1\/products\/purchases\/\d+\/cancel$/.test(u.pathname)) return Response.json({success:true,purchaseId:Number(u.pathname.split("/").at(-2))});
        if(u.hostname!=="api.yookassa.ru") throw new Error(`Unexpected external request ${u.href}`);
        if(u.pathname==="/v3/payments" && options.method==="POST") {
            const existing=[...providerPayments.values()].find(p=>p.key===options.headers["Idempotence-Key"]);
            if(existing)return Response.json(existing);
            const p={id:`payment-${providerPayments.size+1}`,key:options.headers["Idempotence-Key"],metadata:body.metadata,amount:body.amount,status:"pending",paid:false,recipient:{account_id:"test-shop"},confirmation:{confirmation_url:"https://yoomoney.ru/checkout/pay"}};
            providerPayments.set(p.id,p);return Response.json(p);
        }
        if(u.pathname.startsWith("/v3/payments/")) {const p=providerPayments.get(u.pathname.split("/").at(-1));return p?Response.json(p):Response.json({error:"not found"},{status:404});}
        if(u.pathname.startsWith("/v3/refunds/")) {const p=providerRefunds.get(u.pathname.split("/").at(-1));return p?Response.json(p):Response.json({error:"not found"},{status:404});}
        if(u.pathname==="/v3/refunds" && options.method==="POST") {
            const existing=[...providerRefunds.values()].find(r=>r.key===options.headers["Idempotence-Key"]);if(existing)return Response.json(existing);
            const r={id:`refund-${providerRefunds.size+1}`,key:options.headers["Idempotence-Key"],payment_id:body.payment_id,amount:body.amount,status:refundStatus};providerRefunds.set(r.id,r);return Response.json(r);
        }
        throw new Error(`Unexpected provider call ${u.href}`);
    });
    t.after(()=>sqlite.close());await ensureCommerceSchema(env.DB);
    const configured={public_app_url:"https://school.example/app",receipt_tax_system_code:2,receipt_vat_code:1,receipt_payment_subject:"service",receipt_payment_mode:"full_payment",receipt_measure:"piece",yookassa_enabled:true,tribute_enabled:true,payments_enabled:true};
    async function configure(){return updateSchoolSettings(env,OWNER,configured);}
    async function offer(extra={}){return saveOffer(env,OWNER,{name:"Первый семестр",scope_type:"semester",scope_id:1,amount_minor:150000,currency:"RUB",access_days:90,access_unlimited:false,is_active:true,yookassa_enabled:true,...extra});}
    const ctx={requireUser:async()=>({ok:true,user:OWNER}),requireAdminPermission:async()=>({ok:true,user:OWNER}),authError:a=>Response.json(a,{status:a.status}),json:(b,s)=>Response.json(b,{status:s})};
    return {sqlite,env,calls,providerPayments,providerRefunds,product,configure,offer,ctx,setOutage:x=>{outage=x;},setRefundStatus:x=>{refundStatus=x;}};
}
function checkout(offer,key="request_key_00000001",extra={}) {return {offer_id:offer.id,provider:"yookassa",request_key:key,channel:"web",customer:{email:"student@example.test"},...extra};}
function success(p) {Object.assign(p,{status:"succeeded",paid:true,captured_at:new Date().toISOString(),receipt_registration:"succeeded"});return p;}
function yooRequest(p,event="payment.succeeded",ip="185.71.76.1") {return new Request("https://school.example/api/webhooks/yookassa",{method:"POST",headers:{"CF-Connecting-IP":ip},body:JSON.stringify({type:"notification",event,object:{id:p.id}})});}
async function tributeRequest(env,payload,name="new_digital_product") {
    const raw=JSON.stringify({name,created_at:new Date().toISOString(),payload});
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.TRIBUTE_API_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const sig=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,"0")).join("");
    return new Request("https://school.example/api/webhooks/tribute",{method:"POST",headers:{"trbt-signature":sig},body:raw});
}
const purchase=(id,extra={})=>({purchase_id:id,product_id:501,telegram_user_id:2001,amount:150000,currency:"rub",purchase_created_at:new Date().toISOString(),...extra});

test("migration is additive and matches runtime schema; legacy FK does not receive payment IDs",async t=>{
    const f=await fixture(t);f.sqlite.exec(readFileSync(new URL("../../database/migrations/007_commerce.sql",import.meta.url),"utf8"));
    f.sqlite.exec(`DROP TABLE user_semesters;CREATE TABLE checkout_orders(id TEXT PRIMARY KEY);CREATE TABLE user_semesters(id INTEGER PRIMARY KEY,source_checkout_order_id TEXT REFERENCES checkout_orders(id));`);
    await f.configure();const o=await f.offer();const order=await createOrder(f.env,STUDENT,checkout(o));const p=success(f.providerPayments.get(order.provider_payment_id));
    await handleYooKassaWebhookRequest(yooRequest(p),f.env);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM user_semesters").get().n,0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM school_entitlements").get().n,1);
});
test("settings default to payments off, receipts required; only owner may configure non-secrets",async t=>{
    const f=await fixture(t);const s=await getSchoolSettings(f.env.DB);assert.equal(s.payments_enabled,false);assert.equal(s.registration_enabled,true);assert.equal(s.receipt_mode,"receipt");
    await assert.rejects(updateSchoolSettings(f.env,{...OWNER,role:"admin"},{school_name:"X"}),e=>e.status===403);
    await assert.rejects(updateSchoolSettings(f.env,OWNER,{YOOKASSA_SECRET_KEY:"leak"}),e=>e.status===400);
    await assert.rejects(updateSchoolSettings(f.env,OWNER,{receipt_mode:"no_receipt"}),e=>e.status===400);
    await assert.rejects(updateSchoolSettings(f.env,OWNER,{yookassa_enabled:true}),e=>e.status===400);
    await f.configure();const saved=await getSchoolSettings(f.env.DB);assert.equal(saved.receipt_vat_code,1);
    const response=await handleCommerceRequest(new Request("https://school.example/api/admin/school-settings"),f.env,f.ctx);
    const raw=await response.text();assert.ok(!raw.includes("not-a-real-key"));assert.ok(!raw.includes("test-tribute-key"));assert.match(raw,/configured/);
});
test("tariff duration must be explicit and scope must exist",async t=>{
    const f=await fixture(t);
    await assert.rejects(saveOffer(f.env,OWNER,{name:"X",scope_type:"semester",scope_id:1,amount_minor:100}),e=>e.status===400);
    await assert.rejects(f.offer({scope_id:999}),e=>e.status===400);
    await assert.rejects(f.offer({amount_minor:10.5}),e=>e.status===400);
    const o=await f.offer({access_days:null,access_unlimited:true});assert.equal(o.access_days,null);assert.equal(o.access_unlimited,1);
});
test("checkout snapshots explicit scope, price and fiscal fields; duplicate key is the same payment",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,undefined,{customer:{}})),e=>e.status===400);
    const order=await createOrder(f.env,STUDENT,checkout(offer));assert.equal(order.status,"pending");
    const req=f.calls.find(c=>c.method==="POST").body;assert.equal(req.receipt.customer.email,"student@example.test");assert.equal(req.receipt.items[0].vat_code,1);assert.equal(req.amount.value,"1500.00");
    await saveOffer(f.env,OWNER,{amount_minor:200000,access_days:30},offer.id);
    const duplicate=await createOrder(f.env,STUDENT,checkout(offer));assert.equal(duplicate.id,order.id);assert.equal(duplicate.amount_minor,150000);assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
    assert.throws(()=>f.sqlite.prepare("UPDATE school_orders SET amount_minor=1 WHERE id=?").run(order.id),/Immutable/);
});
test("network ambiguity retains persisted idempotence key and byte-equivalent request",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();f.setOutage(true);
    const uncertain=await createOrder(f.env,STUDENT,checkout(offer));assert.equal(uncertain.status,"uncertain");f.setOutage(false);
    await updateSchoolSettings(f.env,OWNER,{school_name:"Changed later",receipt_vat_code:11});
    const order=await createOrder(f.env,STUDENT,checkout(offer));assert.equal(order.id,uncertain.id);assert.equal(order.status,"pending");
    assert.deepEqual(f.calls[0].body,f.calls[1].body);assert.equal(f.calls[0].headers["Idempotence-Key"],f.calls[1].headers["Idempotence-Key"]);
});
test("expired ambiguous payment is never automatically submitted after Yoo idempotency window",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();f.setOutage(true);const order=await createOrder(f.env,STUDENT,checkout(offer));f.setOutage(false);
    f.sqlite.prepare("UPDATE school_orders SET created_at=? WHERE id=?").run(new Date(Date.now()-25*3600000).toISOString(),order.id);
    const checked=await checkPayment(f.env,order.id);assert.equal(checked.status,"needs_review");assert.equal(f.calls.length,1);
});
test("success duplicate cannot extend expired access or restore manually revoked grant",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const order=await createOrder(f.env,STUDENT,checkout(offer));const p=success(f.providerPayments.get(order.provider_payment_id));
    await handleYooKassaWebhookRequest(yooRequest(p),f.env);const before=f.sqlite.prepare("SELECT * FROM school_entitlements").get();
    f.sqlite.prepare("UPDATE school_entitlements SET status='revoked'").run();
    await handleYooKassaWebhookRequest(yooRequest(p),f.env);const after=f.sqlite.prepare("SELECT * FROM school_entitlements").get();
    assert.equal(after.expires_at,before.expires_at);assert.equal(after.status,"revoked");assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,1);
});
test("a spoofed or amount-mismatched Yoo event grants nothing",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const order=await createOrder(f.env,STUDENT,checkout(offer));const p=success(f.providerPayments.get(order.provider_payment_id));
    await assert.rejects(handleYooKassaWebhookRequest(yooRequest(p,undefined,"1.2.3.4"),f.env),e=>e.status===403);
    p.amount.value="1.00";await assert.rejects(handleYooKassaWebhookRequest(yooRequest(p),f.env),e=>e.status===409);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,0);
});
test("full refund revokes originating grant only; late success cannot resurrect it",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const orders=[];
    for(let n=1;n<=2;n++){const order=await createOrder(f.env,STUDENT,checkout(offer,`request_key_0000000${n}`));orders.push(order);const p=success(f.providerPayments.get(order.provider_payment_id));await handleYooKassaWebhookRequest(yooRequest(p),f.env);}
    const p=f.providerPayments.get(orders[0].provider_payment_id);p.refunded_amount={value:"1500.00",currency:"RUB"};
    await checkPayment(f.env,orders[0].id);delete p.refunded_amount;await handleYooKassaWebhookRequest(yooRequest(p),f.env);
    const ent=f.sqlite.prepare("SELECT source_order_id,status FROM school_entitlements ORDER BY source_order_id").all();
    assert.equal(ent.find(e=>e.source_order_id===orders[0].id).status,"revoked");assert.equal(ent.find(e=>e.source_order_id===orders[1].id).status,"active");
});
test("verified partial refund keeps access and a subsequent full refund revokes it",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const o=await createOrder(f.env,STUDENT,checkout(offer));const p=success(f.providerPayments.get(o.provider_payment_id));await handleYooKassaWebhookRequest(yooRequest(p),f.env);
    const r={id:"refund-111",payment_id:p.id,status:"succeeded",amount:{value:"500.00",currency:"RUB"}};f.providerRefunds.set(r.id,r);
    await handleYooKassaWebhookRequest(yooRequest(r,"refund.succeeded"),f.env);assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"active");
    const r2={...r,id:"refund-222",amount:{value:"1000.00",currency:"RUB"}};f.providerRefunds.set(r2.id,r2);await handleYooKassaWebhookRequest(yooRequest(r2,"refund.succeeded"),f.env);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"revoked");
    await handleYooKassaWebhookRequest(yooRequest(r2,"refund.succeeded"),f.env);assert.equal(f.sqlite.prepare("SELECT refunded_minor FROM school_orders").get().refunded_minor,150000);
});
test("explicit owner refund sends the original fiscal snapshot and cannot double refund",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const o=await createOrder(f.env,STUDENT,checkout(offer));success(f.providerPayments.get(o.provider_payment_id));await checkPayment(f.env,o.id);
    const url=`https://school.example/api/admin/payments/${o.id}/refund`;
    const req=()=>new Request(url,{method:"POST",body:JSON.stringify({confirmed:true,request_key:"refund_key_00000001",reason:"Запрос ученика"})});
    const res=await handleCommerceRequest(req(),f.env,f.ctx);assert.equal(res.status,200,await res.clone().text());
    assert.equal((await res.json()).order.status,"refunded");await handleCommerceRequest(req(),f.env,f.ctx);
    assert.equal(f.calls.filter(c=>c.url.endsWith("/refunds") && c.method==="POST").length,1);
    assert.equal(f.calls.find(c=>c.url.endsWith("/refunds")).body.receipt.items[0].vat_code,1);
});
test("Telegram shows only Tribute Stars; no ruble Yoo checkout is created",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer({tribute_product_id:501});const offers=await listOffers(f.env,STUDENT,"telegram");assert.deepEqual(offers[0].providers,["tribute"]);
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,undefined,{channel:"telegram"})),e=>e.status===400);
    const intent=await createOrder(f.env,STUDENT,checkout(offer,undefined,{provider:"tribute",channel:"telegram"}));assert.match(intent.confirmation_url,/t.me\/tribute\/app/);
    assert.equal(f.calls.filter(c=>c.method==="POST").length,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,0);
});
test("Tribute rejects mismatched provider product and freezes the mapped product scope",async t=>{
    const f=await fixture(t);f.product.amount=123;await assert.rejects(f.offer({tribute_product_id:501}),e=>e.status===400);f.product.amount=150000;
    const offer=await f.offer({tribute_product_id:501});await assert.rejects(saveOffer(f.env,OWNER,{scope_id:2},offer.id),e=>e.status===409);
    await assert.rejects(f.offer({tribute_product_id:501}),e=>e.status===409);
});
test("Tribute HMAC fails closed, unknown product/user events remain reviewable",async t=>{
    const f=await fixture(t);
    await assert.rejects(handleTributeWebhookRequest(new Request("https://school.example/webhook",{method:"POST",headers:{"trbt-signature":"0".repeat(64)},body:"{}"}),f.env),e=>e.status===401);
    await assert.rejects(handleTributeWebhookRequest(await tributeRequest(f.env,purchase(801)),f.env),e=>e.status===409);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_payment_events").get().status,"needs_review");assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,0);
});
test("Tribute purchase is exactly once and valid duplicate does not depend on current provider availability",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});const p=purchase(801);
    await handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env);const before=f.sqlite.prepare("SELECT * FROM school_entitlements").get();f.setOutage(true);
    await handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,1);assert.equal(f.sqlite.prepare("SELECT expires_at FROM school_entitlements").get().expires_at,before.expires_at);
});
test("Tribute out-of-order refund tombstone prevents delayed success from granting",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});const p=purchase(801);
    await handleTributeWebhookRequest(await tributeRequest(f.env,p,"digital_product_refunded"),f.env);
    await handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env);assert.equal(f.sqlite.prepare("SELECT status FROM school_orders").get().status,"refunded");assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,0);
});
test("Tribute Stars amount is checked and stored as XTR without ruble reinterpretation",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});
    await assert.rejects(handleTributeWebhookRequest(await tributeRequest(f.env,purchase(801,{currency:"XTR",amount:150000})),f.env),e=>e.status===409);
    const p=purchase(801,{currency:"XTR",amount:800});await handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env);
    const order=f.sqlite.prepare("SELECT charged_amount,charged_currency,amount_minor FROM school_orders").get();assert.equal(order.charged_amount,800);assert.equal(order.charged_currency,"XTR");assert.equal(order.amount_minor,150000);
    await handleTributeWebhookRequest(await tributeRequest(f.env,p,"digital_product_refunded"),f.env);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"revoked");
});
test("browser Tribute intent cannot be reused as a Telegram payment link",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer({tribute_product_id:501});
    await createOrder(f.env,STUDENT,checkout(offer,undefined,{provider:"tribute"}));
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,undefined,{provider:"tribute",channel:"telegram"})),e=>e.status===409);
});
test("Tribute explicit refund is single-submit even if its API response is lost",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});await handleTributeWebhookRequest(await tributeRequest(f.env,purchase(801)),f.env);
    const req=()=>new Request("https://school.example/api/admin/payments/tribute%3A801/refund",{method:"POST",body:JSON.stringify({confirmed:true,request_key:"refund_key_00000001",reason:"Запрос ученика"})});
    f.setOutage(true);const failed=await handleCommerceRequest(req(),f.env,f.ctx);assert.equal(failed.status,502);f.setOutage(false);
    const retried=await handleCommerceRequest(req(),f.env,f.ctx);assert.equal(retried.status,200);assert.equal((await retried.json()).order.refund_status,"uncertain");
    assert.equal(f.calls.filter(c=>c.url.endsWith("/cancel")).length,1);assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"active");
    await handleTributeWebhookRequest(await tributeRequest(f.env,purchase(801),"digital_product_refunded"),f.env);assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"revoked");
});
test("Tribute confirmed API refund revokes only the originating entitlement",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});for(const id of [801,802])await handleTributeWebhookRequest(await tributeRequest(f.env,purchase(id)),f.env);
    const req=new Request("https://school.example/api/admin/payments/tribute%3A801/refund",{method:"POST",body:JSON.stringify({confirmed:true,request_key:"refund_key_00000001",reason:"Запрос ученика"})});
    const res=await handleCommerceRequest(req,f.env,f.ctx);assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json()).order.status,"refunded");
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements WHERE source_order_id='tribute:802'").get().status,"active");
});
test("order owner can change only with a confirmed link receipt and blocked source",async t=>{
    const f=await fixture(t);await f.configure();const o=await f.offer();const order=await createOrder(f.env,STUDENT,checkout(o));
    f.sqlite.exec("CREATE TABLE school_link_challenges(id TEXT PRIMARY KEY,user_id INTEGER,telegram_id INTEGER,status TEXT);CREATE TABLE school_link_receipts(challenge_id TEXT PRIMARY KEY REFERENCES school_link_challenges(id));");
    assert.throws(()=>f.sqlite.prepare("UPDATE school_orders SET user_id=3 WHERE id=?").run(order.id),/confirmed account transfer/);
    f.sqlite.exec("UPDATE users SET status='blocked',blocked_reason='Аккаунт перенесён при подтверждённой привязке' WHERE id=2;INSERT INTO school_link_challenges VALUES('proof',3,3001,'confirmed');");
    assert.throws(()=>f.sqlite.prepare("UPDATE school_orders SET user_id=3 WHERE id=?").run(order.id),/confirmed account transfer/);
    f.sqlite.exec("INSERT INTO school_link_receipts VALUES('proof')");
    assert.throws(()=>f.sqlite.prepare("UPDATE school_orders SET user_id=3 WHERE id=?").run(order.id),/confirmed account transfer/);
    f.sqlite.exec("UPDATE users SET telegram_id=-2 WHERE id=2;UPDATE users SET telegram_id=2001 WHERE id=3;UPDATE school_link_challenges SET telegram_id=2001 WHERE id='proof'");
    f.sqlite.prepare("UPDATE school_orders SET user_id=3 WHERE id=?").run(order.id);
    assert.equal(f.sqlite.prepare("SELECT user_id FROM school_orders WHERE id=?").get(order.id).user_id,3);
});
test("Tribute refund revokes only matching purchase; old success never revokes a newer purchase",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});const old=purchase(801),fresh=purchase(802);
    for(const p of [old,fresh])await handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env);
    await handleTributeWebhookRequest(await tributeRequest(f.env,old,"digital_product_refunded"),f.env);await handleTributeWebhookRequest(await tributeRequest(f.env,old),f.env);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements WHERE source_order_id='tribute:801'").get().status,"revoked");
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements WHERE source_order_id='tribute:802'").get().status,"active");
});
test("unmapped Tribute event can be reconciled after mapping without forged paid status",async t=>{
    const f=await fixture(t);const p=purchase(801);await assert.rejects(handleTributeWebhookRequest(await tributeRequest(f.env,p),f.env));
    await f.offer({tribute_product_id:501});const event=f.sqlite.prepare("SELECT id FROM school_payment_events").get();
    const res=await handleCommerceRequest(new Request(`https://school.example/api/admin/payment-events/${encodeURIComponent(event.id)}/retry`,{method:"POST"}),f.env,f.ctx);
    assert.equal(res.status,200,await res.clone().text());assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,1);
});
test("payment history does not disclose other students and blocked users cannot purchase",async t=>{
    const f=await fixture(t);await f.configure();const o=await f.offer();await createOrder(f.env,STUDENT,checkout(o));
    await assert.rejects(createOrder(f.env,{...STUDENT,status:"blocked"},checkout(o,"other_request_00001")),e=>e.status===403);
    const ctx={...f.ctx,requireUser:async()=>({ok:true,user:{id:3,role:"student",status:"active"}})};
    const res=await handleCommerceRequest(new Request("https://school.example/api/payments"),f.env,ctx);assert.deepEqual((await res.json()).payments,[]);
});
test("IP allowlist rejects invalid or lookalike addresses",()=>{
    for(const ip of ["185.71.76.1","77.75.154.255","2a02:5180::1"])assert.equal(isYooKassaSourceIp(ip),true);
    for(const ip of ["185.71.76.32","77.75.154.127","2a02:51800::1","","185.71.76.1evil","185.71.76.999"])assert.equal(isYooKassaSourceIp(ip),false);
});

for(const baseline of ["schema.sql","baseline-2026-09-23.sql"]) test(`commerce grants every explicit scope on ${baseline} without touching legacy access`,async t=>{
    const f=await fixture(t,baseline);await f.configure();
    for(const [i,scope_type] of ["course","program","semester"].entries()) {
        const offer=await f.offer({scope_type,scope_id:1});
        const order=await createOrder(f.env,STUDENT,checkout(offer,`scope_request_key_${i}`));
        const p=success(f.providerPayments.get(order.provider_payment_id));
        await handleYooKassaWebhookRequest(yooRequest(p),f.env);
        assert.equal(f.sqlite.prepare("SELECT scope_type FROM school_entitlements WHERE source_order_id=?").get(order.id).scope_type,scope_type);
    }
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,3);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM user_semesters").get().n,0);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM user_courses").get().n,0);
    f.sqlite.exec(readFileSync(new URL("../../database/migrations/007_commerce.sql",import.meta.url),"utf8"));
});

test("disabled payments stop new checkout, saved intent links and ambiguous creation retries, but settle existing purchases",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer({tribute_product_id:501});
    await createOrder(f.env,STUDENT,checkout(offer,"tribute_request_key_1",{provider:"tribute"}));
    f.setOutage(true);const uncertain=await createOrder(f.env,STUDENT,checkout(offer));f.setOutage(false);
    await updateSchoolSettings(f.env,OWNER,{payments_enabled:false});const count=f.calls.length;
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer)),e=>e.status===503);
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,"new_request_key_001")),e=>e.status===503);
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,"tribute_request_key_1",{provider:"tribute"})),e=>e.status===503);
    await assert.rejects(checkPayment(f.env,uncertain.id),e=>e.status===503);assert.equal(f.calls.length,count);
    await handleTributeWebhookRequest(await tributeRequest(f.env,purchase(901)),f.env);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,1);
});

test("a saved Yoo checkout cannot be replayed through the Telegram channel",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();await createOrder(f.env,STUDENT,checkout(offer));const count=f.calls.length;
    await assert.rejects(createOrder(f.env,STUDENT,checkout(offer,undefined,{channel:"telegram"})),e=>e.status===400);
    assert.equal(f.calls.length,count);
});

test("pending refund is reconciled with GET after the retry window, never a second financial POST",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const o=await createOrder(f.env,STUDENT,checkout(offer));success(f.providerPayments.get(o.provider_payment_id));await checkPayment(f.env,o.id);
    f.setRefundStatus("pending");const response=await handleCommerceRequest(new Request(`https://school.example/api/admin/payments/${o.id}/refund`,{method:"POST",body:JSON.stringify({confirmed:true,request_key:"refund_request_key_1",reason:"Заявка ученика"})}),f.env,f.ctx);
    const pending=await response.json();assert.equal(pending.order.refund_status,"pending");assert.equal(pending.order.status,"paid");
    f.sqlite.prepare("UPDATE school_refunds SET created_at=?").run(new Date(Date.now()-25*3600000).toISOString());
    f.providerRefunds.get(pending.order.provider_refund_id).status="succeeded";
    const checked=await checkPayment(f.env,o.id);assert.equal(checked.status,"refunded");assert.equal(checked.refund_status,"succeeded");
    assert.equal(f.calls.filter(c=>c.url.endsWith("/refunds")&&c.method==="POST").length,1);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_entitlements").get().status,"revoked");
});

test("refund with lost response needs manual verified ID after timeout and cannot be resubmitted",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();const o=await createOrder(f.env,STUDENT,checkout(offer));success(f.providerPayments.get(o.provider_payment_id));await checkPayment(f.env,o.id);
    const req=()=>new Request(`https://school.example/api/admin/payments/${o.id}/refund`,{method:"POST",body:JSON.stringify({confirmed:true,request_key:"refund_request_key_1",reason:"Заявка ученика"})});
    f.setOutage(true);assert.equal((await handleCommerceRequest(req(),f.env,f.ctx)).status,502);f.setOutage(false);
    f.sqlite.prepare("UPDATE school_refunds SET created_at=?").run(new Date(Date.now()-25*3600000).toISOString());
    const checked=await checkPayment(f.env,o.id);assert.equal(checked.refund_status,"needs_review");assert.equal(checked.status,"paid");
    assert.equal((await handleCommerceRequest(req(),f.env,f.ctx)).status,409);
    assert.equal(f.calls.filter(c=>c.url.endsWith("/refunds")&&c.method==="POST").length,1);
    f.providerRefunds.set("refund-manual-1",{id:"refund-manual-1",payment_id:o.provider_payment_id,status:"succeeded",amount:{value:"1500.00",currency:"RUB"}});
    const reconciled=await checkPayment(f.env,o.id,{provider_refund_id:"refund-manual-1"});assert.equal(reconciled.status,"refunded");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_refunds").get().n,1);
});

test("a valid Tribute signature cannot authenticate an altered raw body",async t=>{
    const f=await fixture(t);await f.offer({tribute_product_id:501});const signed=await tributeRequest(f.env,purchase(902));
    const raw=await signed.text();const changed=raw.replace('"amount":150000','"amount":150001');assert.notEqual(changed,raw);const calls=f.calls.length;
    await assert.rejects(handleTributeWebhookRequest(new Request(signed.url,{method:"POST",headers:signed.headers,body:changed}),f.env),e=>e.status===401);
    assert.equal(f.calls.length,calls);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_orders").get().n,0);
});

test("refund webhook safely reconciles an order whose create response was lost",async t=>{
    const f=await fixture(t);await f.configure();const offer=await f.offer();f.setOutage(true);const o=await createOrder(f.env,STUDENT,checkout(offer));f.setOutage(false);
    const p=success({id:"payment-lost-1",metadata:{school_order_id:o.id},amount:{value:"1500.00",currency:"RUB"},refunded_amount:{value:"1500.00",currency:"RUB"},recipient:{account_id:"test-shop"}});f.providerPayments.set(p.id,p);
    const r={id:"refund-lost-1",payment_id:p.id,status:"succeeded",amount:{value:"1500.00",currency:"RUB"}};f.providerRefunds.set(r.id,r);
    await handleYooKassaWebhookRequest(yooRequest(r,"refund.succeeded"),f.env);
    assert.equal(f.sqlite.prepare("SELECT status FROM school_orders").get().status,"refunded");assert.equal(f.sqlite.prepare("SELECT count(*) n FROM school_entitlements").get().n,0);
});

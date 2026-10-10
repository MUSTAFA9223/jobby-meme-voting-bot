import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{normalizeTweet,normalizeHandle} from '../worker.js';

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  function prepare(sql){let args=[];const q={bind(...a){args=a;return q;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:db.prepare(sql).run(...args)};},exec(){if(/^SELECT/i.test(sql))return {results:db.prepare(sql).all(...args)};return {meta:db.prepare(sql).run(...args)};}};return q;}
  return {db,env:{JOBBY_BOT_TOKEN:'test-token',JOBBY_ADMIN_IDS:'8355389673',JOBBY_WEBHOOK_SECRET:'test-secret',JOBBY_BOT_USERNAME:'JOBBYMemeVoteBot',DB:{prepare,async batch(qs){db.exec('BEGIN');try{const r=qs.map(q=>q.exec());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}}};
}
const post=(env,u,secret='test-secret')=>worker.fetch(new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(u)}),env);
const message=(id,text,admin=8355389673)=>({update_id:id,message:{message_id:id,chat:{id:admin,type:'private'},from:{id:admin},text}});
const mediaMessage=(id,type,fileId,admin=8355389673)=>{const u=message(id,'',admin);u.message[type]=type==='photo'?[{file_id:fileId}]:{file_id:fileId};return u;};
const cb=(id,data,user=44)=>({update_id:id,callback_query:{id:String(id),data,from:{id:user,username:'voter'},message:{message_id:99,chat:{id:user,type:'private'},photo:[{file_id:'photo'}]}}});
function seed(db,id=1){db.prepare('INSERT INTO entries(id,photo_file_id,tweet_url,x_username,telegram_username,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id,'photo',`https://x.com/creator/status/${id}`,'creator','creatorname',8355389673,'today');}
test('unauthenticated requests cannot write; malformed updates are rejected',async()=>{
 const {env,db}=fixture();assert.equal((await post(env,message(1,'/pause'),'wrong')).status,403);assert.equal((await post(env,{update_id:'1'})).status,400);assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_updates').get().n,0);
});
test('full photo wizard survives requests and duplicate publishing creates one entry',async()=>{
 const {env,db}=fixture();const sent=[];globalThis.fetch=async(url,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{}});};
 const inputs=[message(1,'/add'),{...message(2,''),message:{...message(2,'').message,photo:[{file_id:'small'},{file_id:'large'}]}},message(3,'https://twitter.com/creator/status/123?s=20'),message(4,'@creator'),message(5,'@creatorname'),cb(6,'admin:confirm',8355389673)];
 for(const u of inputs)assert.equal((await post(env,u)).status,200);
 assert.equal((await post(env,inputs[5])).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get().n,1);assert.deepEqual({...db.prepare('SELECT photo_file_id,media_type FROM entries').get()},{photo_file_id:'large',media_type:'photo'});assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n,0);assert.ok(sent.some(x=>x.caption?.includes('Review before publishing')));
});
test('video and GIF memes publish with the correct Telegram media methods',async()=>{
 for(const [type,method] of [['video','sendVideo'],['animation','sendAnimation']]){
  const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
  const inputs=[message(1,'/add'),mediaMessage(2,type,`${type}-file`),message(3,'https://x.com/creator/status/123'),message(4,'@creator'),message(5,'@creatorname'),cb(6,'admin:confirm',8355389673)];
  for(const u of inputs)assert.equal((await post(env,u)).status,200);
  assert.deepEqual({...db.prepare('SELECT photo_file_id,media_type FROM entries').get()},{photo_file_id:`${type}-file`,media_type:type});
  assert.ok(sent.some(x=>x.method===method&&x.payload.caption?.includes('Review before publishing')));
  assert.ok(sent.some(x=>x.method===method&&x.payload.caption?.includes('JOBBY MEME CONTEST')));
 }
});
test('one vote across entries; ratings update; paused and non-admin commands are enforced',async()=>{
 const {env,db}=fixture();seed(db);seed(db,2);globalThis.fetch=async()=>Response.json({ok:true,result:{}});
 for(const [i,data] of ['vote:1','vote:2','rate:2:5','rate:2:3'].entries())assert.equal((await post(env,cb(i+1,data))).status,200);
 assert.deepEqual({...db.prepare('SELECT user_id,entry_id FROM votes').get()},{user_id:44,entry_id:2});assert.equal(db.prepare('SELECT value FROM ratings').get().value,3);
 await post(env,message(5,'/pause',44));assert.equal(db.prepare("SELECT value FROM config WHERE key='status'").get().value,'open');
 await post(env,message(6,'/pause'));await post(env,cb(7,'vote:1'));assert.equal(db.prepare('SELECT entry_id FROM votes').get().entry_id,2);
});
test('failed delivery retries the outbox without repeating draft mutations',async()=>{
 const {env,db}=fixture();globalThis.fetch=async()=>Response.json({ok:false,error_code:500},{status:500});
 const u=message(1,'/add');assert.equal((await post(env,u)).status,503);assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n,1);
 globalThis.fetch=async()=>Response.json({ok:true,result:{}});assert.equal((await post(env,u)).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_outbox').get().n,1);assert.equal(db.prepare('SELECT completed FROM webhook_updates').get().completed,1);
});
test('URLs and handles reject hostile inputs and normalize official URLs',()=>{
 assert.equal(normalizeTweet('https://twitter.com/a/status/123?s=4'),'https://x.com/a/status/123');assert.throws(()=>normalizeTweet('https://x.com.evil.test/a/status/123'));assert.throws(()=>normalizeTweet('http://x.com/a/status/123'));assert.throws(()=>normalizeHandle('<script>',true));assert.equal(normalizeHandle('@creatorname',true),'creatorname');
});

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
const groupCb=(id,data,type='photo',user=44)=>({update_id:id,callback_query:{id:String(id),data,from:{id:user,username:'voter'},message:{message_id:99,chat:{id:-100123,type:'supergroup',title:'JOBBY Community'},[type]:type==='photo'?[{file_id:'public'}]:{file_id:'public'}}}});
const membership=(id,chatId,title,type,status='administrator',user=8355389673)=>({update_id:id,my_chat_member:{from:{id:user},chat:{id:chatId,title,type},new_chat_member:{status}}});
function seed(db,id=1,type='photo'){db.prepare('INSERT INTO entries(id,photo_file_id,media_type,tweet_url,x_username,telegram_username,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,`${type}-file`,type,`https://x.com/creator/status/${id}`,'creator','creatorname',8355389673,'today');}
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
test('connected groups and channels appear in the publish menu and receive media voting posts',async()=>{
 const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 await post(env,membership(1,-100123,'JOBBY Community','supergroup'));
 const forwarded=message(2,'');forwarded.message.forward_origin={type:'channel',chat:{id:-100456,title:'JOBBY Channel',type:'channel'}};await post(env,forwarded);
 assert.deepEqual(db.prepare('SELECT chat_type,COUNT(*) n FROM destinations GROUP BY chat_type ORDER BY chat_type').all().map(x=>({...x})),[{chat_type:'channel',n:1},{chat_type:'supergroup',n:1}]);
 seed(db,1,'video');
 await post(env,message(3,'/publish 1'));
 const menu=sent.find(x=>x.method==='sendMessage'&&x.payload.text.includes('Choose where'));
 assert.ok(menu.payload.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='admin:post:1:-100123'));
 await post(env,cb(4,'admin:post:1:-100123',8355389673));
 const published=sent.find(x=>x.method==='sendVideo'&&x.payload.chat_id===-100123);
 assert.ok(published);assert.match(published.payload.caption,/Vote and rate directly below/);assert.match(published.payload.caption,/View original post on X/);assert.ok(published.payload.reply_markup.inline_keyboard.flat().some(x=>x.text==='🐦 View Tweet on X'&&x.url==='https://x.com/creator/status/1'));assert.ok(!published.payload.caption.includes('Your vote'));
});
test('only the configured organizer can connect a group or use submission controls',async()=>{
 const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 await post(env,membership(1,-100999,'Unauthorized Group','supergroup','member',44));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM destinations').get().n,0);
 const groupCommand={...message(2,'/register',44),message:{...message(2,'/register',44).message,chat:{id:-100999,type:'supergroup',title:'Unauthorized Group'}}};
 await post(env,groupCommand);assert.equal(db.prepare('SELECT COUNT(*) n FROM destinations').get().n,0);
 await post(env,message(3,'/add',44));assert.ok(sent.some(x=>x.payload.text==='Organizer-only command. Try /start.'));
});
test('members vote and rate directly on a shared group or channel post',async()=>{
 const {env,db}=fixture(),sent=[];seed(db,1,'animation');globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 assert.equal((await post(env,groupCb(1,'vote:1','animation'))).status,200);
 assert.equal((await post(env,groupCb(2,'rate:1:5','animation'))).status,200);
 assert.deepEqual({...db.prepare('SELECT user_id,entry_id FROM votes').get()},{user_id:44,entry_id:1});assert.equal(db.prepare('SELECT value FROM ratings').get().value,5);
 const edits=sent.filter(x=>x.method==='editMessageCaption');assert.equal(edits.length,2);assert.ok(edits.every(x=>x.payload.caption.includes('Vote and rate directly below.')&&!x.payload.caption.includes('Your vote')));
});
test('one fixed vote per meme; users can vote for every entry; ratings and permissions are enforced',async()=>{
 const {env,db}=fixture();seed(db);seed(db,2);globalThis.fetch=async()=>Response.json({ok:true,result:{}});
 for(const [i,data] of ['vote:1','vote:1','vote:2','vote:2','rate:2:5','rate:2:3'].entries())assert.equal((await post(env,cb(i+1,data))).status,200);
 assert.deepEqual(db.prepare('SELECT user_id,entry_id FROM votes ORDER BY entry_id').all().map(x=>({...x})),[{user_id:44,entry_id:1},{user_id:44,entry_id:2}]);
 assert.deepEqual(db.prepare('SELECT entry_id,COUNT(*) n FROM votes GROUP BY entry_id ORDER BY entry_id').all().map(x=>({...x})),[{entry_id:1,n:1},{entry_id:2,n:1}]);
 assert.equal(db.prepare('SELECT value FROM ratings').get().value,3);
 await post(env,message(5,'/pause',44));assert.equal(db.prepare("SELECT value FROM config WHERE key='status'").get().value,'open');
 await post(env,message(7,'/pause'));await post(env,cb(8,'vote:1',45));assert.equal(db.prepare('SELECT COUNT(*) n FROM votes').get().n,2);
});
test('failed delivery retries the outbox without repeating draft mutations',async()=>{
 const {env,db}=fixture();globalThis.fetch=async()=>Response.json({ok:false,error_code:500},{status:500});
 const u=message(1,'/add');assert.equal((await post(env,u)).status,503);assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n,1);
 globalThis.fetch=async()=>Response.json({ok:true,result:{}});assert.equal((await post(env,u)).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_outbox').get().n,1);assert.equal(db.prepare('SELECT completed FROM webhook_updates').get().completed,1);
});
test('URLs and handles reject hostile inputs and normalize official URLs',()=>{
 assert.equal(normalizeTweet('https://twitter.com/a/status/123?s=4'),'https://x.com/a/status/123');assert.throws(()=>normalizeTweet('https://x.com.evil.test/a/status/123'));assert.throws(()=>normalizeTweet('http://x.com/a/status/123'));assert.throws(()=>normalizeHandle('<script>',true));assert.equal(normalizeHandle('@creatorname',true),'creatorname');
});

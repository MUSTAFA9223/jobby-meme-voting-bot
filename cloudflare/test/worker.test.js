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
 const {env,db}=fixture();const sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 const inputs=[message(1,'/add'),{...message(2,''),message:{...message(2,'').message,photo:[{file_id:'small'},{file_id:'large'}]}},message(3,'https://twitter.com/creator/status/123?s=20'),message(4,'@creator'),message(5,'@creatorname'),cb(6,'admin:confirm',8355389673)];
 for(const u of inputs)assert.equal((await post(env,u)).status,200);
 assert.equal((await post(env,inputs[5])).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get().n,1);assert.deepEqual({...db.prepare('SELECT photo_file_id,media_type FROM entries').get()},{photo_file_id:'large',media_type:'photo'});assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n,0);assert.ok(sent.some(x=>x.method==='sendMessage'&&x.payload.text?.includes('Review before publishing')&&x.payload.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='admin:confirm')));
});
test('admin can forward a community meme and the bot prepares every detected field',async()=>{
 const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 const forwarded=mediaMessage(1,'photo','community-meme');
 forwarded.message.caption='New submission https://twitter.com/MemeArtist/status/98765?s=20';
 forwarded.message.forward_origin={type:'user',sender_user:{id:77,username:'memeartisttg'}};
 assert.equal((await post(env,forwarded)).status,200);
 const draft=db.prepare('SELECT step,data FROM drafts WHERE admin_id=?').get(8355389673);
 assert.equal(draft.step,'confirm');
 assert.deepEqual(JSON.parse(draft.data),{media_type:'photo',photo_file_id:'community-meme',forwarded_import:true,tweet_url:'https://x.com/MemeArtist/status/98765',x_username:'MemeArtist',telegram_username:'memeartisttg'});
 assert.ok(sent.some(x=>x.payload.text?.includes('Telegram username is optional')));
 assert.ok(sent.some(x=>x.method==='sendPhoto'&&x.payload.caption?.includes('Meme preview')&&!x.payload.reply_markup));
 assert.ok(sent.some(x=>x.method==='sendMessage'&&x.payload.text?.includes('@memeartisttg')&&x.payload.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='admin:confirm')));
 assert.equal((await post(env,cb(2,'admin:confirm',8355389673))).status,200);
 assert.deepEqual({...db.prepare('SELECT photo_file_id,tweet_url,x_username,telegram_username FROM entries').get()},{photo_file_id:'community-meme',tweet_url:'https://x.com/MemeArtist/status/98765',x_username:'MemeArtist',telegram_username:'memeartisttg'});
});
test('X-link media submission saves when no Telegram username is provided',async()=>{
 const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 const imported=mediaMessage(1,'photo','https://pbs.twimg.com/media/meme.jpg');
 imported.message.text='https://x.com/Creator/status/123456';
 imported.message.forward_origin={type:'user',sender_user:{id:0}};
 assert.equal((await post(env,imported)).status,200);
 assert.equal(db.prepare('SELECT step FROM drafts WHERE admin_id=?').get(8355389673).step,'confirm');
 assert.equal((await post(env,cb(2,'admin:confirm',8355389673))).status,200);
 assert.deepEqual({...db.prepare('SELECT photo_file_id,tweet_url,x_username,telegram_username FROM entries').get()},
  {photo_file_id:'https://pbs.twimg.com/media/meme.jpg',tweet_url:'https://x.com/Creator/status/123456',x_username:'Creator',telegram_username:''});
 assert.ok(sent.some(x=>x.method==='answerCallbackQuery'&&x.payload.text==='Entry #1 published'));
});
test('forward import asks only for metadata Telegram could not detect',async()=>{
 const {env,db}=fixture();globalThis.fetch=async()=>Response.json({ok:true,result:{}});
 const forwarded=mediaMessage(1,'video','community-video');forwarded.message.forward_origin={type:'user',sender_user:{id:77,username:'creatorname'}};
 await post(env,forwarded);assert.equal(db.prepare('SELECT step FROM drafts').get().step,'tweet');
 await post(env,message(2,'https://x.com/creator/status/456'));
 const draft=db.prepare('SELECT step,data FROM drafts').get();assert.equal(draft.step,'confirm');
 const data=JSON.parse(draft.data);assert.equal(data.x_username,'creator');assert.equal(data.telegram_username,'creatorname');
});
test('X link preview is accepted first and only the actual media is requested',async()=>{
 const {env,db}=fixture();globalThis.fetch=async()=>Response.json({ok:true,result:{}});
 const previewOnly=message(1,'First entry\nhttps://x.com/Simdavv/status/2108992018710245825');
 previewOnly.message.forward_origin={type:'user',sender_user:{id:91,username:'simdav'}};
 await post(env,previewOnly);
 let draft=db.prepare('SELECT step,data FROM drafts').get();assert.equal(draft.step,'media');
 assert.equal(JSON.parse(draft.data).tweet_url,'https://x.com/Simdavv/status/2108992018710245825');
 await post(env,mediaMessage(2,'photo','actual-meme'));
 draft=db.prepare('SELECT step,data FROM drafts').get();assert.equal(draft.step,'confirm');
 assert.equal(JSON.parse(draft.data).photo_file_id,'actual-meme');
});
test('video and GIF memes publish with the correct Telegram media methods',async()=>{
 for(const [type,method] of [['video','sendVideo'],['animation','sendAnimation']]){
  const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
  const inputs=[message(1,'/add'),mediaMessage(2,type,`${type}-file`),message(3,'https://x.com/creator/status/123'),message(4,'@creator'),message(5,'@creatorname'),cb(6,'admin:confirm',8355389673)];
  for(const u of inputs)assert.equal((await post(env,u)).status,200);
  assert.deepEqual({...db.prepare('SELECT photo_file_id,media_type FROM entries').get()},{photo_file_id:`${type}-file`,media_type:type});
  assert.ok(sent.some(x=>x.method===method&&x.payload.caption?.includes('Meme preview')&&!x.payload.reply_markup));assert.ok(sent.some(x=>x.method==='sendMessage'&&x.payload.text?.includes('Review before publishing')&&x.payload.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='admin:confirm')));
  assert.ok(sent.some(x=>x.method===method&&x.payload.caption?.includes('JOBBY MEME ENTRY')));
 }
});
test('gallery opens as a lightweight menu and caches X-only media after first view',async()=>{
 const {env,db}=fixture(),sent=[];seed(db);db.prepare("UPDATE entries SET telegram_username='',photo_file_id='https://d.fxtwitter.com/creator/status/1' WHERE id=1").run();
 globalThis.fetch=async(url,opts)=>{const method=String(url).split('/').at(-1),payload=JSON.parse(opts.body);sent.push({method,payload});return Response.json({ok:true,result:method==='sendPhoto'?{photo:[{file_id:'cached-photo'}]}:{}});};
 await post(env,message(1,'/entries',44));
 const menu=sent.find(x=>x.method==='sendMessage'&&x.payload.text.includes('Choose an entry'));
 assert.ok(menu);assert.ok(menu.payload.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='open:1'));
 assert.equal(sent.some(x=>x.method==='sendPhoto'),false);
 await post(env,cb(2,'open:1',44));
 const gallery=sent.find(x=>x.method==='sendPhoto');
 assert.ok(gallery);assert.match(gallery.payload.caption,/@creator/);assert.doesNotMatch(gallery.payload.caption,/Telegram:/);
 const buttons=gallery.payload.reply_markup.inline_keyboard.flat();
 assert.ok(buttons.some(x=>x.text==='X creator'));assert.ok(buttons.every(x=>x.text!=='Telegram creator'));
 assert.equal(db.prepare('SELECT photo_file_id FROM entries WHERE id=1').get().photo_file_id,'cached-photo');
});
test('connected groups and channels receive gallery posts without voting controls',async()=>{
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
 assert.ok(published);assert.match(published.payload.caption,/JOBBY MEME ENTRY/);assert.match(published.payload.caption,/View on X/);
 const buttons=published.payload.reply_markup.inline_keyboard.flat();assert.ok(buttons.some(x=>x.text==='🐦 View original post on X'&&x.url==='https://x.com/creator/status/1'));assert.ok(buttons.every(x=>!x.callback_data));
 assert.ok(!/Votes|Rating|vote|rate/i.test(published.payload.caption));
});
test('only the configured organizer can connect a group or use submission controls',async()=>{
 const {env,db}=fixture(),sent=[];globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 await post(env,membership(1,-100999,'Unauthorized Group','supergroup','member',44));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM destinations').get().n,0);
 const groupCommand={...message(2,'/register',44),message:{...message(2,'/register',44).message,chat:{id:-100999,type:'supergroup',title:'Unauthorized Group'}}};
 await post(env,groupCommand);assert.equal(db.prepare('SELECT COUNT(*) n FROM destinations').get().n,0);
 await post(env,message(3,'/add',44));assert.ok(sent.some(x=>x.payload.text==='Organizer-only command. Try /start.'));
});
test('voting and rating callbacks are disabled and never write records',async()=>{
 const {env,db}=fixture(),sent=[];seed(db);globalThis.fetch=async(url,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{}});};
 for(const [i,data] of ['vote:1','rate:1:5'].entries())assert.equal((await post(env,cb(i+1,data))).status,200);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM votes').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM ratings').get().n,0);
 assert.ok(sent.filter(x=>x.callback_query_id).every(x=>x.text==='This action is no longer available.'));
 const group=await post(env,groupCb(3,'vote:1'));assert.equal(group.status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM votes').get().n,0);
});
test('failed delivery retries the outbox without repeating draft mutations',async()=>{
 const {env,db}=fixture();globalThis.fetch=async()=>Response.json({ok:false,error_code:500},{status:500});
 const u=message(1,'/add');assert.equal((await post(env,u)).status,503);assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n,1);
 globalThis.fetch=async()=>Response.json({ok:true,result:{}});assert.equal((await post(env,u)).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_outbox').get().n,1);assert.equal(db.prepare('SELECT completed FROM webhook_updates').get().completed,1);
});
test('Telegram responses are delivered sequentially in outbox order',async()=>{
 const {env,db}=fixture();seed(db);db.prepare('INSERT INTO destinations(chat_id,title,chat_type,active,registered_by,updated_at) VALUES(?,?,?,?,?,?)').run(-100123,'JOBBY Community','supergroup',1,8355389673,'today');
 let active=0,maxActive=0;const order=[];
 globalThis.fetch=async(url,opts)=>{active++;maxActive=Math.max(maxActive,active);order.push(String(url).split('/').at(-1));await new Promise(resolve=>setTimeout(resolve,5));active--;return Response.json({ok:true,result:{}});};
 assert.equal((await post(env,cb(1,'admin:post:1:-100123',8355389673))).status,200);
 assert.equal(maxActive,1,`expected one Telegram call at a time, saw ${maxActive}`);
 assert.deepEqual(order,['sendPhoto','answerCallbackQuery','sendMessage']);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_outbox WHERE delivered=1').get().n,3);
});
test('URLs and handles reject hostile inputs and normalize official URLs',()=>{
 assert.equal(normalizeTweet('https://twitter.com/a/status/123?s=4'),'https://x.com/a/status/123');assert.throws(()=>normalizeTweet('https://x.com.evil.test/a/status/123'));assert.throws(()=>normalizeTweet('http://x.com/a/status/123'));assert.throws(()=>normalizeHandle('<script>',true));assert.equal(normalizeHandle('@creatorname',true),'creatorname');
});


test('organizer chooses destination first, then publishes visible memes in batches of ten',async()=>{
 const {env,db}=fixture(),sent=[];
 globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 seed(db,1,'photo');seed(db,2,'video');seed(db,3,'animation');db.prepare('UPDATE entries SET active=0 WHERE id=2').run();
 for(const [id,title] of [[-100123,'JOBBY Community'],[-100456,'JOBBY Channel']])db.prepare('INSERT INTO destinations(chat_id,title,chat_type,active,registered_by,updated_at) VALUES(?,?,?,?,?,?)').run(id,title,id===-100456?'channel':'supergroup',1,8355389673,'today');
 assert.equal((await post(env,message(1,'/publish all'))).status,200);
 const menu=sent.find(x=>x.method==='sendMessage'&&x.payload.text.includes('Step 1/2'));
 assert.ok(menu);
 const options=menu.payload.reply_markup.inline_keyboard.flat().map(x=>x.callback_data);
 assert.ok(options.includes('admin:publishdest:-100123'));
 assert.ok(options.includes('admin:publishdest:-100456'));
 assert.ok(options.includes('admin:publishdestall'));
 assert.equal(options.some(x=>x.startsWith('admin:postbatch:')),false);
 assert.equal((await post(env,cb(2,'admin:publishdest:-100123',8355389673))).status,200);
 const batches=sent.filter(x=>x.method==='sendMessage'&&x.payload.text.includes('Step 2/2')).at(-1);
 assert.ok(batches);
 const batchOptions=batches.payload.reply_markup.inline_keyboard.flat().map(x=>x.callback_data);
 assert.deepEqual(batchOptions,['admin:postbatch:-100123:0']);
 assert.equal((await post(env,cb(3,'admin:postbatch:-100123:0',8355389673))).status,200);
 assert.equal(sent.filter(x=>['sendPhoto','sendAnimation'].includes(x.method)&&x.payload.chat_id===-100123).length,2);
 assert.equal(sent.filter(x=>x.method==='sendVideo').length,0);
 assert.equal((await post(env,cb(4,'admin:publishdestall',8355389673))).status,200);
 const allBatches=sent.filter(x=>x.method==='sendMessage'&&x.payload.text.includes('Step 2/2')).at(-1);
 assert.ok(allBatches.payload.text.includes('all connected destinations'));
 assert.deepEqual(allBatches.payload.reply_markup.inline_keyboard.flat().map(x=>x.callback_data),['admin:postbatchall:0']);
 assert.equal((await post(env,cb(5,'admin:postbatchall:0',8355389673))).status,200);
 assert.equal(sent.filter(x=>['sendPhoto','sendAnimation','sendVideo'].includes(x.method)).length,6);
 assert.ok(sent.some(x=>x.method==='sendMessage'&&x.payload.text.includes('2 memes for 2 destinations')));
});

test('second batch publishes entries 11–20 in order and falls back to text for rejected media',async()=>{
 const {env,db}=fixture(),sent=[];
 for(let id=1;id<=20;id++){seed(db,id,'photo');db.prepare('UPDATE entries SET photo_file_id=? WHERE id=?').run('photo-file-'+id,id);}
 db.prepare('INSERT INTO destinations(chat_id,title,chat_type,active,registered_by,updated_at) VALUES(?,?,?,?,?,?)').run(-100123,'JOBBY Community','supergroup',1,8355389673,'today');
 globalThis.fetch=async(url,opts)=>{
  const method=String(url).split('/').at(-1),payload=JSON.parse(opts.body);sent.push({method,payload});
  if(method==='sendPhoto'&&payload.photo==='photo-file-11')return Response.json({ok:false,error_code:400,description:'Bad Request: wrong file identifier'}, {status:400});
  return Response.json({ok:true,result:{}});
 };
 assert.equal((await post(env,cb(77,'admin:postbatch:-100123:10',8355389673))).status,200);
 const published=sent.filter(x=>x.method==='sendPhoto'&&x.payload.chat_id===-100123).map(x=>x.payload.photo);
 assert.deepEqual(published,['photo-file-11','photo-file-12','photo-file-13','photo-file-14','photo-file-15','photo-file-16','photo-file-17','photo-file-18','photo-file-19','photo-file-20']);
 assert.ok(sent.some(x=>x.method==='sendMessage'&&x.payload.text.includes('Media could not be attached')&&x.payload.text.includes('JOBBY MEME ENTRY — #011')));
 assert.equal(db.prepare('SELECT completed FROM webhook_updates WHERE update_id=77').get().completed,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_outbox WHERE update_id=77 AND delivered=0').get().n,0);
});

test('admin duplicate report renders participant cards with submitted post links',async()=>{
 const {env,db}=fixture(),sent=[];
 seed(db,1);seed(db,2);seed(db,3);
 db.prepare('UPDATE entries SET x_username=?,telegram_username=? WHERE id=?').run('RepeatX','alpha_tg',1);
 db.prepare('UPDATE entries SET x_username=?,telegram_username=? WHERE id=?').run('repeatx','beta_tg',2);
 db.prepare('UPDATE entries SET x_username=?,telegram_username=? WHERE id=?').run('uniqueX','alpha_tg',3);
 globalThis.fetch=async(url,opts)=>{sent.push({method:String(url).split('/').at(-1),payload:JSON.parse(opts.body)});return Response.json({ok:true,result:{}});};
 assert.equal((await post(env,message(90,'/duplicates'))).status,200);
 const report=sent.filter(x=>x.method==='sendMessage').map(x=>x.payload.text).join('\n');
 assert.ok(report.includes('PARTICIPANT'));
 assert.ok(report.includes('Telegram account:'));
 assert.ok(report.includes('X account:'));
 assert.ok(report.includes('Number of participations:'));
 assert.ok(report.includes('Participation 1'));
 assert.ok(report.includes('Participation 2'));
 assert.ok(report.includes('Entry #001'));
 assert.ok(report.includes('Entry #002'));
 assert.ok(report.includes('Entry #003'));
 assert.ok(report.includes('Open tweet'));
 assert.ok(report.includes('https://x.com/'));
});

const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (text, callback_data) => ({text, callback_data});
const link = (text, url) => ({text, url});
const keyboard = (...rows) => ({inline_keyboard: rows});
const now = () => new Date().toISOString();

export function normalizeHandle(raw, telegram = false) {
  let value = raw.trim().replace(/^@/, '');
  const prefix = telegram ? /^https:\/\/t\.me\//i : /^https:\/\/(x\.com|twitter\.com)\//i;
  if (prefix.test(value)) value = new URL(value).pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!(telegram ? /^[A-Za-z0-9_]{5,32}$/ : /^[A-Za-z0-9_]{1,15}$/).test(value))
    throw new Error(telegram ? 'Enter a valid Telegram username.' : 'Enter a valid X username.');
  return value;
}
export function normalizeTweet(raw) {
  try {
    const u = new URL(raw.trim());
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    if (u.protocol !== 'https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname) || !m) throw 0;
    return `https://x.com/${m[1]}/status/${m[2]}`;
  } catch { throw new Error('Send a valid X post URL: https://x.com/user/status/123'); }
}

// All mutations and outgoing responses are committed with the update ID in one
// D1 transaction. A Telegram retry only replays undelivered responses.
export class Contest {
  constructor(env, state, userId) {
    this.env = env; this.userId = userId; this.state = state;
    this.sql = []; this.responses = [];
    this.admins = new Set((env.JOBBY_ADMIN_IDS || '').split(',').map(Number));
  }
  static async load(env, userId) {
    const queries = [
      `SELECT e.*, COALESCE(v.n,0) votes, COALESCE(r.n,0) rating_count, COALESCE(r.avg_stars,0) average_stars FROM entries e LEFT JOIN (SELECT entry_id,COUNT(*) n FROM votes GROUP BY entry_id) v ON v.entry_id=e.id LEFT JOIN (SELECT entry_id,COUNT(*) n,AVG(value) avg_stars FROM ratings GROUP BY entry_id) r ON r.entry_id=e.id`,
      'SELECT key,value FROM config', 'SELECT * FROM drafts WHERE admin_id=?',
      'SELECT entry_id FROM votes WHERE user_id=?', 'SELECT entry_id,value FROM ratings WHERE user_id=?',
      'SELECT * FROM destinations WHERE active=1 ORDER BY title,chat_id'
    ];
    const result = await env.DB.batch(queries.map((q,i) => i < 2 || i === 5 ? env.DB.prepare(q) : env.DB.prepare(q).bind(userId)));
    return new Contest(env, {entries: result[0].results, config: Object.fromEntries(result[1].results.map(r=>[r.key,r.value])),
      draft: result[2].results[0] ? {step:result[2].results[0].step,data:JSON.parse(result[2].results[0].data)} : null,
      vote:result[3].results[0]?.entry_id ?? null, ratings:Object.fromEntries(result[4].results.map(r=>[r.entry_id,r.value])),
      destinations:result[5].results}, userId);
  }
  write(sql, ...args) { this.sql.push(this.env.DB.prepare(sql).bind(...args)); }
  api(method, payload) { this.responses.push({method,payload}); }
  send(chat_id,text,reply_markup) { this.api('sendMessage',{chat_id,text,parse_mode:'HTML',...(reply_markup?{reply_markup}:{})}); }
  media(chat_id,type,file_id,caption,reply_markup) {
    const method={photo:'sendPhoto',video:'sendVideo',animation:'sendAnimation'}[type]||'sendPhoto';
    const field={photo:'photo',video:'video',animation:'animation'}[type]||'photo';
    this.api(method,{chat_id,[field]:file_id,caption,parse_mode:'HTML',...(reply_markup?{reply_markup}:{})});
  }
  ack(id,text='') { this.api('answerCallbackQuery',{callback_query_id:id,text}); }
  get status() { return this.state.config.status || 'open'; }
  isAdmin() { return this.admins.has(this.userId); }
  entry(id,active=true) { return this.state.entries.find(e=>e.id===id && (!active||e.active===1)); }
  standings() { return this.state.entries.filter(e=>e.active===1).sort((a,b)=>b.votes-a.votes || b.average_stars-a.average_stars || b.rating_count-a.rating_count || a.id-b.id); }
  ids() { return this.state.entries.filter(e=>e.active===1).map(e=>e.id).sort((a,b)=>a-b); }
  draft(step,data) {
    this.state.draft={step,data};
    this.write('INSERT INTO drafts(admin_id,step,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(admin_id) DO UPDATE SET step=excluded.step,data=excluded.data,updated_at=excluded.updated_at',this.userId,step,JSON.stringify(data),now());
  }
  clearDraft() { this.state.draft=null; this.write('DELETE FROM drafts WHERE admin_id=?',this.userId); }
  setDestination(chat,active=true) {
    if(!chat?.id||chat.type==='private')return;
    const title=String(chat.title||chat.username||chat.id).slice(0,120);
    this.write('INSERT INTO destinations(chat_id,title,chat_type,active,registered_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,chat_type=excluded.chat_type,active=excluded.active,registered_by=excluded.registered_by,updated_at=excluded.updated_at',chat.id,title,chat.type,active?1:0,this.userId,now());
    this.state.destinations=this.state.destinations.filter(d=>d.chat_id!==chat.id);
    if(active)this.state.destinations.push({chat_id:chat.id,title,chat_type:chat.type,active:1,registered_by:this.userId,updated_at:now()});
  }
  startDraft(chat) { this.draft('media',{}); this.send(chat,'➕ <b>Add JOBBY meme</b>\nStep 1/4: Send the meme as a photo, video, or GIF.\n/cancel to stop.'); }
  welcome(chat) {
    const rows=[[button('🖼 Browse memes','menu:entries')],[button('🏆 Leaderboard','menu:leaderboard'),button('ℹ️ Rules','menu:rules')]];
    if(this.isAdmin()) rows.push([button('➕ Add meme (admin)','admin:add')]);
    this.send(chat,'🏆 <b>JOBBY Meme Voting</b>\n\nBrowse memes, rate creativity from 1–5 stars, and cast ONE contest vote for your favorite. You can change it before voting closes.\nOnly the organizer can submit entries.',{inline_keyboard:rows});
  }
  rules(chat) { this.send(chat,`<b>Contest rules</b>\n• One contest vote per Telegram account across all memes.\n• One 1–5 star rating per meme.\n• You can change votes and ratings while voting is open.\n• Votes rank first; star averages break ties.\n• Organizers upload memes and original X links.\n• Status: <b>${esc(this.status.toUpperCase())}</b>.\nPlease vote fairly.`); }
  caption(e) { return `🏆 <b>JOBBY MEME CONTEST — #${String(e.id).padStart(3,'0')}</b>\n\n🐦 X creator: <b>@${esc(e.x_username)}</b>\n💬 Telegram: <b>@${esc(e.telegram_username)}</b>\n\n🗳 Votes: <b>${e.votes}</b> | ⭐ Rating: <b>${Number(e.average_stars).toFixed(2)}/5</b> (${e.rating_count} ratings)\nContest: <b>${esc(this.status.toUpperCase())}</b>\n\nYour vote: <b>${this.state.vote ? '#'+this.state.vote : 'None'}</b> | Your rating: <b>${this.state.ratings[e.id] || '—'}</b>`; }
  publicCaption(e) { return `🏆 <b>JOBBY MEME CONTEST — #${String(e.id).padStart(3,'0')}</b>\n\n🐦 X creator: <b>@${esc(e.x_username)}</b>\n💬 Telegram: <b>@${esc(e.telegram_username)}</b>\n\n🗳 Votes: <b>${e.votes}</b> | ⭐ Rating: <b>${Number(e.average_stars).toFixed(2)}/5</b> (${e.rating_count} ratings)\nContest: <b>${esc(this.status.toUpperCase())}</b>\n\nVote and rate directly below.`; }
  entryKeyboard(e) {
    const ids=this.ids(), i=ids.indexOf(e.id), before=ids[(i-1+ids.length)%ids.length], after=ids[(i+1)%ids.length];
    return keyboard([1,2,3,4,5].map(n=>button(`⭐ ${n}`,`rate:${e.id}:${n}`)),[button('🗳 Vote for this meme',`vote:${e.id}`)],
      [link('🔗 Original X post',e.tweet_url)],[link('X creator',`https://x.com/${e.x_username}`),link('Telegram creator',`https://t.me/${e.telegram_username}`)],
      [button('◀ Previous',`nav:${before}`),button('🏆 Top','menu:leaderboard'),button('Next ▶',`nav:${after}`)]);
  }
  publicKeyboard(e) {
    return keyboard([1,2,3,4,5].map(n=>button(`⭐ ${n}`,`rate:${e.id}:${n}`)),[button('🗳 Vote for this meme',`vote:${e.id}`)],
      [link('🔗 Original X post',e.tweet_url)],[link('Open full voting',`https://t.me/${this.env.JOBBY_BOT_USERNAME}?start=m${e.id}`)]);
  }
  show(chat,id,origin) {
    const e=this.entry(id); if(!e) {this.send(chat,'That entry is not available.');return;}
    const type=e.media_type||'photo';
    if(origin&&(origin.photo||origin.video||origin.animation)) this.api('editMessageMedia',{chat_id:chat,message_id:origin.message_id,media:{type,media:e.photo_file_id,caption:this.caption(e),parse_mode:'HTML'},reply_markup:this.entryKeyboard(e)});
    else this.media(chat,type,e.photo_file_id,this.caption(e),this.entryKeyboard(e));
  }
  browse(chat) { const ids=this.ids(); ids.length ? this.show(chat,ids[0]) : this.send(chat,'No meme entries yet. Check back soon!'); }
  leaderboard(chat) {
    const entries=this.standings().slice(0,10); if(!entries.length){this.send(chat,'No memes have been added yet.');return;}
    const lines=entries.map((e,i)=>`${i+1}. <b>#${String(e.id).padStart(3,'0')} @${esc(e.x_username)}</b> — ${e.votes} votes | ⭐ ${Number(e.average_stars).toFixed(2)} (${e.rating_count})`);
    const rows=[];for(let i=0;i<entries.length;i+=3) rows.push(entries.slice(i,i+3).map(e=>button(`View #${e.id}`,`nav:${e.id}`)));
    rows.push([button('🖼 Browse all memes','menu:entries')]);
    this.send(chat,`🏆 <b>JOBBY Leaderboard</b> (${esc(this.status.toUpperCase())})\n\n${lines.join('\n')}\n\nRanked by votes, then average stars.`,{inline_keyboard:rows});
  }
  destinationList(chat) {
    const rows=this.state.destinations;
    if(!rows.length){this.send(chat,'No groups or channels are connected yet.\n\nGroup: add the bot, then send /register in the group.\nChannel: add the bot as an admin with permission to post, then forward any channel post to this private chat.');return;}
    this.send(chat,'<b>Connected publishing destinations</b>\n\n'+rows.map((d,i)=>`${i+1}. ${esc(d.title)} — <code>${d.chat_id}</code> (${esc(d.chat_type)})`).join('\n'));
  }
  publishMenu(chat,entryId) {
    const e=this.entry(entryId);if(!e){this.send(chat,'Entry not found or hidden.');return;}
    const destinations=this.state.destinations;
    if(!destinations.length){this.destinationList(chat);return;}
    const rows=destinations.map(d=>[button(`📣 ${String(d.title).slice(0,40)}`,`admin:post:${entryId}:${d.chat_id}`)]);
    if(destinations.length>1)rows.push([button('📣 Publish to all',`admin:postall:${entryId}`)]);
    this.send(chat,`Choose where to publish entry #${entryId}:`,{inline_keyboard:rows});
  }
  publishEntry(entryId,destination) {
    const e=this.entry(entryId);if(!e||!destination)return false;
    this.media(destination.chat_id,e.media_type||'photo',e.photo_file_id,this.publicCaption(e),this.publicKeyboard(e));
    return true;
  }
  preview(chat) {
    const d=this.state.draft?.data;if(this.state.draft?.step!=='confirm'){this.send(chat,'No complete draft. Use /add.');return;}
    this.media(chat,d.media_type||'photo',d.photo_file_id,`<b>Review before publishing</b>\nX post: ${esc(d.tweet_url)}\nX creator: @${esc(d.x_username)}\nTelegram: @${esc(d.telegram_username)}`,keyboard([button('✅ Publish entry','admin:confirm'),button('❌ Cancel','admin:cancel')]));
  }
  handleDraft(chat,message) {
    const draft=this.state.draft;if(!draft)return false;const {step,data}=draft;
    if(step==='confirm'){this.send(chat,'Tap Publish or Cancel on the preview.');return true;}
    if(step==='media'||step==='photo'){
      const photo=message.photo?.at(-1),video=message.video,animation=message.animation;
      const media=photo?{type:'photo',file_id:photo.file_id}:video?{type:'video',file_id:video.file_id}:animation?{type:'animation',file_id:animation.file_id}:null;
      if(!media){this.send(chat,'Send the meme as a Telegram photo, video, or GIF. /cancel to stop.');return true;}
      this.draft('tweet',{...data,media_type:media.type,photo_file_id:media.file_id});this.send(chat,'Step 2/4: Paste the original X post URL.');return true;
    }
    try {
      const text=message.text||'';
      if(step==='tweet'){this.draft('x',{...data,tweet_url:normalizeTweet(text)});this.send(chat,"Step 3/4: Send the participant's X username.");}
      else if(step==='x'){this.draft('tg',{...data,x_username:normalizeHandle(text)});this.send(chat,"Step 4/4: Send the participant's Telegram username.");}
      else if(step==='tg'){this.draft('confirm',{...data,telegram_username:normalizeHandle(text,true)});this.preview(chat);}
      else this.send(chat,'Unknown draft state. /cancel then /add.');
    } catch(e){this.send(chat,`⚠️ ${esc(e.message)} Try again.`);}return true;
  }
  command(message) {
    const chat=message.chat.id,parts=message.text.trim().split(/\s+/),cmd=parts[0].split('@')[0].toLowerCase();
    if(cmd==='/myid'){this.send(chat,`Your Telegram ID: <code>${this.userId}</code>`);return;}
    if(message.chat.type!=='private'&&['/register','/connect'].includes(cmd)){
      if(!this.isAdmin()){this.send(chat,'Only the JOBBY organizer can connect this chat.');return;}
      this.setDestination(message.chat,true);this.send(chat,'✅ This chat is connected to JOBBY voting. Publishing is controlled from the bot private chat.');return;
    }
    if(message.chat.type!=='private'&&['/unregister','/disconnect'].includes(cmd)){
      if(!this.isAdmin()){this.send(chat,'Only the JOBBY organizer can disconnect this chat.');return;}
      this.setDestination(message.chat,false);this.send(chat,'This chat was disconnected from JOBBY publishing.');return;
    }
    if(message.chat.type!=='private'){this.send(chat,'Open the voting bot in a private chat.');return;}
    if(cmd==='/start'){/^m\d{1,9}$/.test(parts[1]||'')?this.show(chat,Number(parts[1].slice(1))):this.welcome(chat);return;}
    if(['/entries','/memes'].includes(cmd)){this.browse(chat);return;}
    if(['/leaderboard','/results'].includes(cmd)){this.leaderboard(chat);return;}
    if(cmd==='/rules'){this.rules(chat);return;}
    if(!this.isAdmin()){this.send(chat,'Organizer-only command. Try /start.');return;}
    if(['/admin','/help'].includes(cmd)) this.send(chat,'<b>JOBBY Admin</b>\n/add — Add photo, video, or GIF meme\n/cancel — Cancel draft\n/list — Entries\n/publish 12 — Publish in a group/channel\n/destinations — Connected groups/channels\n/register — Run inside a group to connect it\nForward a channel post here to connect that channel\n/remove 12 — Hide\n/restore 12 — Restore\n/pause — Freeze voting\n/resume — Reopen\n/close — Close voting\n/results — Leaderboard\n/stats — Counters\n/share 12 — Private voting link');
    else if(cmd==='/add') this.startDraft(chat);
    else if(cmd==='/cancel'){this.clearDraft();this.send(chat,'Draft canceled. Nothing published.');}
    else if(cmd==='/destinations')this.destinationList(chat);
    else if(cmd==='/publish'){
      if(parts.length!==2||!/^\d+$/.test(parts[1]))this.send(chat,'Usage: /publish &lt;entry number&gt;');
      else this.publishMenu(chat,Number(parts[1]));
    }
    else if(['/pause','/resume','/close'].includes(cmd)){
      const status={'/pause':'paused','/resume':'open','/close':'closed'}[cmd];this.state.config.status=status;this.write("UPDATE config SET value=? WHERE key='status'",status);this.send(chat,`Voting and ratings are now ${status}.`);
    } else if(cmd==='/list') this.send(chat,'<b>Latest entries</b>\n'+(this.state.entries.slice().sort((a,b)=>b.id-a.id).slice(0,50).map(e=>`#${e.id} @${esc(e.x_username)} — ${e.active?'visible':'hidden'}`).join('\n')||'None'));
    else if(cmd==='/stats'){
      const active=this.standings();this.send(chat,`<b>Contest stats</b>\nActive: ${active.length}\nHidden: ${this.state.entries.length-active.length}\nValid votes: ${active.reduce((n,e)=>n+e.votes,0)}\nRatings: ${active.reduce((n,e)=>n+e.rating_count,0)}\nStatus: ${esc(this.status)}`);
    } else if(['/remove','/restore','/share'].includes(cmd)){
      if(parts.length!==2||!/^\d+$/.test(parts[1])){this.send(chat,`Usage: ${esc(cmd)} &lt;entry number&gt;`);return;}
      const id=Number(parts[1]),e=this.entry(id,cmd==='/share');if(!e){this.send(chat,'Entry not found.');return;}
      if(cmd==='/share')this.send(chat,`Share: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${id}`);
      else {e.active=cmd==='/restore'?1:0;this.write('UPDATE entries SET active=? WHERE id=?',e.active,id);this.send(chat,`Entry #${id} ${e.active?'restored':'hidden'}.`);}
    } else this.send(chat,'Unknown command. Try /admin.');
  }
  async hasAccess() {
    if(!this.env.JOBBY_REQUIRED_CHAT_ID||this.isAdmin())return true;
    try {const r=await telegram(this.env,'getChatMember',{chat_id:this.env.JOBBY_REQUIRED_CHAT_ID,user_id:this.userId});return ['member','administrator','creator'].includes(r.status)||(r.status==='restricted'&&r.is_member===true);}catch{return false;}
  }
  async callback(c) {
    const chat=c.message?.chat,id=c.id,action=c.data||'',cid=chat?.id;
    if(!cid){this.ack(id,'Message unavailable.');return;}
    const privateChat=chat.type==='private';
    if(!privateChat&&!/^(vote|rate):/.test(action)){this.ack(id,'Open the bot private chat for this action.');return;}
    if(action==='menu:entries'){this.ack(id);this.browse(cid);return;}
    if(action==='menu:leaderboard'){this.ack(id);this.leaderboard(cid);return;}
    if(action==='menu:rules'){this.ack(id);this.rules(cid);return;}
    if(action.startsWith('admin:')){
      if(!this.isAdmin()){this.ack(id,'Organizer only.');return;}
      if(action==='admin:add'){this.ack(id);this.startDraft(cid);}
      else if(action==='admin:cancel'){this.clearDraft();this.ack(id,'Draft canceled');this.send(cid,'Draft canceled; nothing published.');}
      else if(/^admin:publish:\d+$/.test(action)){const entryId=Number(action.split(':')[2]);this.ack(id);this.publishMenu(cid,entryId);}
      else if(/^admin:share:\d+$/.test(action)){const entryId=Number(action.split(':')[2]);this.ack(id);this.send(cid,`Share: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${entryId}`);}
      else if(/^admin:post:\d+:-?\d+$/.test(action)){
        const [, , entryRaw,destinationRaw]=action.split(':'),entryId=Number(entryRaw),destinationId=Number(destinationRaw);
        const destination=this.state.destinations.find(d=>d.chat_id===destinationId);
        if(!this.publishEntry(entryId,destination)){this.ack(id,'Entry or destination unavailable.');return;}
        this.ack(id,'Publishing…');this.send(cid,`✅ Entry #${entryId} queued for ${esc(destination.title)}.`);
      }
      else if(/^admin:postall:\d+$/.test(action)){
        const entryId=Number(action.split(':')[2]),count=this.state.destinations.filter(d=>this.publishEntry(entryId,d)).length;
        if(!count){this.ack(id,'No available destinations.');return;}
        this.ack(id,'Publishing to all…');this.send(cid,`✅ Entry #${entryId} queued for ${count} destinations.`);
      }
      else if(action==='admin:confirm'){
        if(this.state.draft?.step!=='confirm'){this.ack(id,'Draft already handled or expired.');return;}
        const d=this.state.draft.data,n=Math.max(0,...this.state.entries.map(e=>e.id))+1;
        this.write('INSERT INTO entries(id,photo_file_id,media_type,tweet_url,x_username,telegram_username,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',n,d.photo_file_id,d.media_type||'photo',d.tweet_url,d.x_username,d.telegram_username,this.userId,now());
        this.state.entries.push({...d,media_type:d.media_type||'photo',id:n,created_by:this.userId,active:1,votes:0,rating_count:0,average_stars:0});this.clearDraft();
        this.ack(id,`Entry #${n} published`);this.send(cid,`✅ Entry #${n} saved.`,keyboard([button('📣 Publish to group/channel',`admin:publish:${n}`),button('🔗 Get private voting link',`admin:share:${n}`)]));this.show(cid,n);
      } else this.ack(id,'Unknown action.');return;
    }
    const m=action.match(/^(nav|vote|rate):(\d+)(?::([1-5]))?$/);
    if(!m||(m[1]==='rate'?!m[3]:!!m[3])){this.ack(id,'Unknown action.');return;}
    const entryId=Number(m[2]),e=this.entry(entryId);if(!e){this.ack(id,'Entry unavailable.');return;}
    if(m[1]==='nav'){if(!privateChat){this.ack(id,'Open the bot for the full gallery.');return;}this.ack(id);this.show(cid,entryId,c.message);return;}
    if(!await this.hasAccess()){this.ack(id,'Join the official community first.');return;}
    if((c.from.username||'').toLowerCase()===e.telegram_username.toLowerCase()){this.ack(id,'Creators cannot vote for their own meme.');return;}
    if(this.status!=='open'){this.ack(id,'Voting and ratings are closed.');return;}
    if(m[1]==='vote'){
      const prior=this.state.vote;this.ack(id,prior===entryId?'You already voted for this meme.':prior?'Vote changed!':'Vote recorded!');
      if(prior!==entryId){const old=this.entry(prior,false);if(old)old.votes--;e.votes++;this.state.vote=entryId;
        this.write('INSERT INTO votes(user_id,entry_id,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET entry_id=excluded.entry_id,updated_at=excluded.updated_at',this.userId,entryId,now());}
    } else {
      const value=Number(m[3]),old=this.state.ratings[entryId];e.average_stars=(e.average_stars*e.rating_count-(old||0)+value)/(e.rating_count+(old?0:1));if(!old)e.rating_count++;
      this.state.ratings[entryId]=value;this.write('INSERT INTO ratings(user_id,entry_id,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,entry_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',this.userId,entryId,value,now());this.ack(id,'Rating saved!');
    }
    if(c.message.photo||c.message.video||c.message.animation)this.api('editMessageCaption',{chat_id:cid,message_id:c.message.message_id,caption:privateChat?this.caption(e):this.publicCaption(e),parse_mode:'HTML',reply_markup:privateChat?this.entryKeyboard(e):this.publicKeyboard(e)});
  }
  async handle(update) {
    if(update.callback_query){await this.callback(update.callback_query);return;}
    if(update.my_chat_member){const membership=update.my_chat_member,status=membership.new_chat_member?.status;this.setDestination(membership.chat,['member','administrator','creator'].includes(status));return;}
    const m=update.message||update.channel_post;if(!m?.chat?.id||!m.from?.id)return;
    const forwardedChannel=m.forward_origin?.type==='channel'?m.forward_origin.chat:(m.forward_from_chat?.type==='channel'?m.forward_from_chat:null);
    if(this.isAdmin()&&m.chat.type==='private'&&forwardedChannel){this.setDestination(forwardedChannel,true);this.send(m.chat.id,`✅ Channel connected: ${esc(forwardedChannel.title||forwardedChannel.id)}. Use /publish &lt;entry number&gt; to post voting.`);return;}
    if(m.text?.startsWith('/'))this.command(m);
    else if(this.isAdmin()&&m.chat.type==='private'&&this.handleDraft(m.chat.id,m))return;
    else if(m.chat.type==='private')this.send(m.chat.id,'Use /start to browse memes and vote. Only the organizer can submit entries.');
  }
}

async function telegram(env,method,payload) {
  let response;
  try { response=await fetch(`https://api.telegram.org/bot${env.JOBBY_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); }
  catch { throw new Error('Telegram transport unavailable'); }
  let data;try {data=await response.json();}catch {throw new Error('Invalid Telegram response');}
  if(!response.ok||!data.ok) {const e=new Error('Telegram request rejected');e.code=data.error_code;e.description=data.description;throw e;}
  return data.result;
}

async function deliver(env,updateId) {
  const pending=await env.DB.prepare('SELECT * FROM webhook_outbox WHERE update_id=? AND delivered=0 ORDER BY id').bind(updateId).all();
  for(const row of pending.results){
    const payload=JSON.parse(row.payload);
    try {await telegram(env,row.method,payload);}
    catch(e) {
      // Expired callback IDs and unchanged edits are harmless. Other failed
      // deliveries remain pending and cause Telegram to retry the webhook.
      const unavailableDestination=['sendPhoto','sendVideo','sendAnimation'].includes(row.method)&&Number(payload.chat_id)<0&&[400,403].includes(e.code)&&/(chat not found|bot was kicked|not enough rights|not a member|have no rights)/i.test(e.description||'');
      if(unavailableDestination)await env.DB.prepare('UPDATE destinations SET active=0,updated_at=? WHERE chat_id=?').bind(now(),payload.chat_id).run();
      else if(!(row.method==='answerCallbackQuery'&&e.code===400)&&!(row.method.startsWith('editMessage')&&e.code===400&&/message is not modified/i.test(e.description||'')))throw e;
    }
    await env.DB.prepare('UPDATE webhook_outbox SET delivered=1 WHERE id=?').bind(row.id).run();
  }
  await env.DB.prepare('UPDATE webhook_updates SET completed=1 WHERE update_id=?').bind(updateId).run();
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET'){
      try {if(!env.DB||!env.JOBBY_BOT_TOKEN||!env.JOBBY_WEBHOOK_SECRET||!env.JOBBY_ADMIN_IDS)return new Response('Not configured',{status:503});if(!await env.DB.prepare("SELECT value FROM config WHERE key='status'").first())return new Response('Database not ready',{status:503});return new Response('JOBBY ready');}
      catch{return new Response('Database not ready',{status:503});}
    }
    if(path!=='/webhook'||request.method!=='POST')return new Response('Not found',{status:404});
    if(!env.JOBBY_WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.JOBBY_WEBHOOK_SECRET)return new Response('Forbidden',{status:403});
    if(Number(request.headers.get('content-length')||0)>1048576)return new Response('Too large',{status:413});
    let u;try {const raw=await request.text();if(raw.length>1048576)return new Response('Too large',{status:413});u=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
    if(!Number.isSafeInteger(u.update_id)||u.update_id<0)return new Response('Invalid update',{status:400});
    try {
      const seen=await env.DB.prepare('SELECT completed FROM webhook_updates WHERE update_id=?').bind(u.update_id).first();
      if(seen?.completed)return new Response('OK');
      if(!seen){
        const userId=u.callback_query?.from?.id||u.message?.from?.id||u.channel_post?.from?.id||u.my_chat_member?.from?.id||0;
        const bot=await Contest.load(env,userId);await bot.handle(u);
        const statements=[env.DB.prepare('INSERT INTO webhook_updates(update_id,received_at) VALUES(?,?)').bind(u.update_id,now()),...bot.sql,
          ...bot.responses.map(r=>env.DB.prepare('INSERT INTO webhook_outbox(update_id,method,payload) VALUES(?,?,?)').bind(u.update_id,r.method,JSON.stringify(r.payload)))];
        try {await env.DB.batch(statements);}catch {if(!await env.DB.prepare('SELECT update_id FROM webhook_updates WHERE update_id=?').bind(u.update_id).first())throw new Error('Update commit failed');}
      }
      await deliver(env,u.update_id);return new Response('OK');
    } catch {return new Response('Please retry',{status:503});}
  }
};

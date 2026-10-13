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
function tweetFromMessage(message) {
  const candidates=[];
  for(const field of ['caption','text'])if(message[field])candidates.push(message[field]);
  for(const field of ['caption_entities','entities'])for(const entity of message[field]||[]){
    if(entity.type==='text_link'&&entity.url)candidates.push(entity.url);
    else if(entity.type==='url'&&message[field==='caption_entities'?'caption':'text']){
      const source=message[field==='caption_entities'?'caption':'text'];
      candidates.push(source.slice(entity.offset,entity.offset+entity.length));
    }
  }
  for(const candidate of candidates){
    const matches=String(candidate).match(/https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:[^\s<>]*)?/ig)||[];
    for(const match of matches)try{return normalizeTweet(match.replace(/[),.;!?]+$/,''));}catch{}
  }
  return '';
}
function xHandleFromTweet(url) { return new URL(url).pathname.split('/')[1]; }
function forwardedTelegramUsername(message) {
  const origin=message.forward_origin;
  if(origin?.type==='user')return origin.sender_user?.username||'';
  if(origin?.type==='chat'||origin?.type==='channel')return origin.sender_chat?.username||origin.chat?.username||'';
  return message.forward_from?.username||message.forward_from_chat?.username||'';
}
function forwardedDisplayName(message) {
  const origin=message.forward_origin;
  const user=origin?.type==='user'?origin.sender_user:message.forward_from;
  const chat=origin?.type==='chat'||origin?.type==='channel'?(origin.sender_chat||origin.chat):message.forward_from_chat;
  const name=[user?.first_name,user?.last_name].filter(Boolean).join(' ').trim();
  return (name||chat?.title||'').slice(0,120);
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
      'SELECT * FROM entries',
      'SELECT key,value FROM config', 'SELECT * FROM drafts WHERE admin_id=?',
      'SELECT * FROM destinations WHERE active=1 ORDER BY title,chat_id'
    ];
    const result = await env.DB.batch(queries.map((q,i) => i < 2 || i === 3 ? env.DB.prepare(q) : env.DB.prepare(q).bind(userId)));
    return new Contest(env, {entries: result[0].results, config: Object.fromEntries(result[1].results.map(r=>[r.key,r.value])),
      draft: result[2].results[0] ? {step:result[2].results[0].step,data:JSON.parse(result[2].results[0].data)} : null,
      destinations:result[3].results}, userId);
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
  isAdmin() { return this.admins.has(this.userId); }
  entry(id,active=true) { return this.state.entries.find(e=>e.id===id && (!active||e.active===1)); }
  standings() { return this.state.entries.filter(e=>e.active===1).sort((a,b)=>a.id-b.id); }
  ids() { return this.state.entries.filter(e=>e.active===1).map(e=>e.id).sort((a,b)=>a-b); }
  duplicateReport(chat) {
    const entries=this.state.entries.slice().sort((a,b)=>a.id-b.id);
    const parent=entries.map((_,i)=>i);
    const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
    const owner=new Map();
    entries.forEach((e,i)=>{
      for(const [kind,raw] of [['X',e.x_username],['Telegram',e.telegram_username]]){
        const handle=String(raw||'').trim().replace(/^@/,'').toLowerCase();
        if(!handle)continue;
        const key=kind+':'+handle;
        if(owner.has(key))join(i,owner.get(key));else owner.set(key,i);
      }
    });
    const grouped=new Map();
    entries.forEach((e,i)=>{const root=find(i);if(!grouped.has(root))grouped.set(root,[]);grouped.get(root).push(e);});
    const duplicates=[...grouped.values()].filter(group=>group.length>1).sort((a,b)=>a[0].id-b[0].id);
    if(!duplicates.length){
      this.send(chat,'<b>Duplicate participant check</b>\nNo X or Telegram account appears on more than one entry.');
      return;
    }
    this.send(chat,'<b>Duplicate participants</b>\nEach participant has a separate, clearly ordered card.');
    for(const group of duplicates){
      const tg=[...new Set(group.map(e=>String(e.telegram_username||'').trim().replace(/^@/,'' )).filter(Boolean))];
      const xs=[...new Set(group.map(e=>String(e.x_username||'').trim().replace(/^@/,'' )).filter(Boolean))];
      const submissions=group.slice().sort((a,b)=>a.id-b.id);
      const postLines=submissions.map((e,i)=>{
        const number=String(e.id).padStart(3,'0');
        const status=e.active===1?'':' (hidden)';
        const tweet=e.tweet_url?'<a href="'+esc(e.tweet_url)+'">Open tweet</a>':'Tweet link unavailable';
        return '<b>Participation '+(i+1)+'</b> — Entry #'+number+status+'\n'+tweet;
      }).join('\n\n');
      const card='<b>PARTICIPANT</b>\n'
        +'Telegram account: '+(tg.length?tg.map(h=>'<a href="https://t.me/'+encodeURIComponent(h)+'">@'+esc(h)+'</a>').join(', '):'Not provided')+'\n'
        +'X account: '+(xs.length?xs.map(h=>'@'+esc(h)).join(', '):'Not provided')+'\n'
        +'Number of participations: <b>'+submissions.length+'</b>\n\n'
        +postLines;
      this.send(chat,card);
    }
  }
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
    const rows=[[button('Browse meme gallery','menu:entries')],[button('About the gallery','menu:about')]];
    if(this.isAdmin()) rows.push([button('ADMIN PANEL','admin:menu')]);
    this.send(chat,'<b>JOBBY Meme Gallery</b>\\nBrowse memes and open their original X posts.',{inline_keyboard:rows});
  }
  adminMenu(chat) {
    this.send(chat,'<b>JOBBY — Admin Panel</b>\\nChoose a tool below. These controls are only available to the organizer.',{inline_keyboard:[
      [button('Add a meme','admin:add')],
      [button('Publish memes (batches of 10)','admin:publishall')],
      [button('Manage entries','admin:entries')],
      [button('Connected channels and groups','admin:destinations')],
      [button('Statistics','admin:stats'),button('Find duplicate accounts','admin:duplicates')]
    ]});
  }
  adminEntries(chat) {
    const entries=this.state.entries.slice().sort((a,b)=>b.id-a.id).slice(0,30);
    if(!entries.length){this.send(chat,'<b>Manage entries</b>\\nNo entries yet.',{inline_keyboard:[[button('Back to Admin Panel','admin:menu')]]});return;}
    const rows=[];
    for(const e of entries) rows.push([button('#'+e.id+' '+(e.active?'Visible':'Hidden')+' — @'+String(e.x_username||'').slice(0,15),`admin:entry:${e.id}`)]);
    rows.push([button('Back to Admin Panel','admin:menu')]);
    this.send(chat,'<b>Manage entries</b>\\nChoose an entry to hide, restore, publish, or get its link.',{inline_keyboard:rows});
  }
  adminEntryActions(chat,id) {
    const e=this.state.entries.find(x=>x.id===id);
    if(!e){this.send(chat,'Entry not found.',{inline_keyboard:[[button('Back to entries','admin:entries')]]});return;}
    this.send(chat,`<b>Entry #${e.id}</b>\\nX account: @${esc(e.x_username||'not set')}\\nStatus: ${e.active?'Visible':'Hidden'}`,{inline_keyboard:[
      [button(e.active?'Hide entry':'Restore entry',e.active?`admin:hide:${id}`:`admin:restore:${id}`)],
      [button('Publish this entry',`admin:publish:${id}`),button('Get entry link',`admin:share:${id}`)],
      [button('Back to entries','admin:entries'),button('Admin Panel','admin:menu')]
    ]});
  }
  about(chat) { this.send(chat,'<b>JOBBY Meme Gallery</b>\n• Browse every official entry.\n• Open the original X post and creator profiles from each card.\n• Entries can only be added, changed, or published by the organizer.'); }
  caption(e) {
    const name=e.creator_name?`\n👤 Name: <b>${esc(e.creator_name)}</b>`:'';
    const telegram=e.telegram_username?`\n💬 Telegram: <b>@${esc(e.telegram_username)}</b>`:'';
    return `🖼 <b>JOBBY MEME ENTRY — #${String(e.id).padStart(3,'0')}</b>${name}\n\n🐦 X creator: <b>@${esc(e.x_username)}</b>${telegram}\n🔗 Original post: <a href="${esc(e.tweet_url)}">View on X</a>`;
  }
  publicCaption(e) { return this.caption(e); }
  entryKeyboard(e) {
    const ids=this.ids(), i=ids.indexOf(e.id), before=ids[(i-1+ids.length)%ids.length], after=ids[(i+1)%ids.length];
    const creators=[link('X creator',`https://x.com/${e.x_username}`)];
    if(e.telegram_username)creators.push(link('Telegram creator',`https://t.me/${e.telegram_username}`));
    return keyboard([link('🐦 View original post on X',e.tweet_url)],creators,
      [button('◀ Previous',`nav:${before}`),button('🖼 Gallery','menu:entries'),button('Next ▶',`nav:${after}`)]);
  }
  publicKeyboard(e) {
    const creators=[link('X creator',`https://x.com/${e.x_username}`)];
    if(e.telegram_username)creators.push(link('Telegram creator',`https://t.me/${e.telegram_username}`));
    return keyboard([link('🐦 View original post on X',e.tweet_url)],creators,[link('🖼 Open full gallery',`https://t.me/${this.env.JOBBY_BOT_USERNAME}?start=m${e.id}`)]);
  }
  show(chat,id,origin) {
    const e=this.entry(id); if(!e) {this.send(chat,'That entry is not available.');return;}
    const type=e.media_type||'photo';
    if(origin&&(origin.photo||origin.video||origin.animation)) this.api('editMessageMedia',{chat_id:chat,message_id:origin.message_id,media:{type,media:e.photo_file_id,caption:this.caption(e),parse_mode:'HTML'},reply_markup:this.entryKeyboard(e)});
    else this.media(chat,type,e.photo_file_id,this.caption(e),this.entryKeyboard(e));
  }
  browse(chat) {
    const entries=this.standings();
    if(!entries.length){this.send(chat,'No meme entries yet. Check back soon!');return;}
    const buttons=entries.map(e=>button(`#${String(e.id).padStart(3,'0')} @${String(e.x_username).slice(0,15)}`,`open:${e.id}`));
    const rows=[];for(let i=0;i<buttons.length;i+=2)rows.push(buttons.slice(i,i+2));
    this.send(chat,`🖼 <b>JOBBY Meme Gallery</b> — ${entries.length} entries\n\nChoose an entry to view its meme and creator links.`,{inline_keyboard:rows});
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
  publishAllMenu(chat) {
    const entries=this.standings(),destinations=this.state.destinations;
    if(!entries.length){this.send(chat,'There are no visible meme entries to publish.');return;}
    if(!destinations.length){this.destinationList(chat);return;}
    const rows=destinations.map(d=>[button(`📣 ${String(d.title).slice(0,40)}`,`admin:publishdest:${d.chat_id}`)]);
    if(destinations.length>1)rows.push([button('📣 All connected destinations','admin:publishdestall')]);
    this.send(chat,`<b>Step 1/2 — Choose destination</b>\\n\\n${entries.length} visible memes are ready. First choose the channel or group; then choose which batch of 10 to publish.`,{inline_keyboard:rows});
  }
  publishBatchMenu(chat,destinationId=null) {
    const entries=this.standings(),destinations=destinationId===null?this.state.destinations:this.state.destinations.filter(d=>d.chat_id===destinationId);
    if(!entries.length){this.send(chat,'There are no visible meme entries to publish.');return;}
    if(!destinations.length){this.send(chat,'Destination unavailable. Run /publish all and choose again.');return;}
    const rows=[];
    for(let offset=0;offset<entries.length;offset+=10){
      const first=offset+1,last=Math.min(offset+10,entries.length),batch=Math.floor(offset/10)+1;
      rows.push([button(`Publish ${first}–${last}${last-first+1<10?' ('+(last-first+1)+')':''}`,destinationId===null?`admin:postbatchall:${offset}`:`admin:postbatch:${destinationId}:${offset}`)]);
    }
    const target=destinationId===null?'all connected destinations':destinations[0].title;
    this.send(chat,`<b>Step 2/2 — Choose batch</b>\\nDestination: <b>${esc(target)}</b>\\n${entries.length} visible memes. Each button publishes up to 10 entries in order. Avoid pressing the same batch twice.`,{inline_keyboard:rows});
  }
  publishAllEntries(destination,offset=0,limit=10) {
    const entries=this.standings().slice(offset,offset+limit);
    if(!destination)return 0;
    for(const entry of entries)this.publishEntry(entry.id,destination);
    return entries.length;
  }
  publishEntry(entryId,destination) {
    const e=this.entry(entryId);if(!e||!destination)return false;
    this.media(destination.chat_id,e.media_type||'photo',e.photo_file_id,this.publicCaption(e),this.publicKeyboard(e));
    return true;
  }
  preview(chat) {
    const d=this.state.draft?.data;
    if(this.state.draft?.step!=='confirm'){this.send(chat,'No complete draft. Use /add.');return;}
    const details=`<b>Review before publishing</b>\nName: ${esc(d.creator_name||'Not available')}\nX post: ${esc(d.tweet_url)}\nX creator: @${esc(d.x_username)}\nTelegram: @${esc(d.telegram_username||'Not available')}`;
    // Keep the media preview separate from the action controls. If Telegram
    // cannot render the media, the review details and Save/Cancel buttons still
    // appear as a normal text message instead of looking like a lone button row.
    this.media(chat,d.media_type||'photo',d.photo_file_id,'<b>Meme preview</b>');
    this.send(chat,details,keyboard([button('Publish entry','admin:confirm'),button('Cancel','admin:cancel')]));
  }
  importForwarded(chat,message) {
    const forwarded=message.forward_origin||message.forward_from||message.forward_from_chat||message.is_automatic_forward;
    if(!forwarded)return false;
    const photo=message.photo?.at(-1),video=message.video,animation=message.animation;
    const media=photo?{media_type:'photo',photo_file_id:photo.file_id}:video?{media_type:'video',photo_file_id:video.file_id}:animation?{media_type:'animation',photo_file_id:animation.file_id}:null;
    const tweet_url=tweetFromMessage(message),telegram_username=forwardedTelegramUsername(message),creator_name=forwardedDisplayName(message);
    const data={...(media||{}),forwarded_import:true};
    if(creator_name)data.creator_name=creator_name;
    if(tweet_url){data.tweet_url=tweet_url;data.x_username=xHandleFromTweet(tweet_url);}
    if(telegram_username)try{data.telegram_username=normalizeHandle(telegram_username,true);}catch{}
    if(!media){
      if(data.tweet_url){this.draft('media',data);this.send(chat,'✅ X link and available usernames detected. The picture shown above is only an X link preview, so Telegram did not provide the media file. Now send the meme itself as a photo, video, or GIF.');}
      else this.send(chat,'Forward a meme containing a photo, video, or GIF, or include its original X post link.');
      return true;
    }
    if(!data.tweet_url){this.draft('tweet',data);this.send(chat,'Meme received. Send the original X post URL to finish the entry.');return true;}
    // An X post URL is sufficient to identify a submission. Telegram usernames
    // are optional and are never requested for link-based imports.
    this.draft('confirm',data);this.send(chat,'✅ Meme media and X post detected. Telegram username is optional.');this.preview(chat);return true;
  }
  handleDraft(chat,message) {
    const draft=this.state.draft;if(!draft)return false;const {step,data}=draft;
    if(step==='confirm'){this.send(chat,'Tap Publish or Cancel on the preview.');return true;}
    if(step==='media'||step==='photo'){
      const photo=message.photo?.at(-1),video=message.video,animation=message.animation;
      const media=photo?{type:'photo',file_id:photo.file_id}:video?{type:'video',file_id:video.file_id}:animation?{type:'animation',file_id:animation.file_id}:null;
      if(!media){this.send(chat,'Send the meme as a Telegram photo, video, or GIF. /cancel to stop.');return true;}
      const next={...data,media_type:media.type,photo_file_id:media.file_id};
      if(data.forwarded_import&&next.tweet_url){
        this.draft('confirm',next);this.preview(chat);
      }else{this.draft('tweet',next);this.send(chat,'Step 2/4: Paste the original X post URL.');}
      return true;
    }
    try {
      const text=message.text||'';
      if(step==='tweet'){
        const tweet_url=normalizeTweet(text),next={...data,tweet_url,x_username:xHandleFromTweet(tweet_url)};
        if(data.forwarded_import){
          this.draft('confirm',next);this.preview(chat);
        }else{this.draft('x',next);this.send(chat,"Step 3/4: Send the participant's X username.");}
      }
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
      this.setDestination(message.chat,true);this.send(chat,'✅ This chat is connected to the JOBBY meme gallery. Publishing is controlled from the bot private chat.');return;
    }
    if(message.chat.type!=='private'&&['/unregister','/disconnect'].includes(cmd)){
      if(!this.isAdmin()){this.send(chat,'Only the JOBBY organizer can disconnect this chat.');return;}
      this.setDestination(message.chat,false);this.send(chat,'This chat was disconnected from JOBBY publishing.');return;
    }
    if(message.chat.type!=='private'){this.send(chat,'Open the JOBBY meme gallery in a private chat.');return;}
    if(cmd==='/start'){/^m\d{1,9}$/.test(parts[1]||'')?this.show(chat,Number(parts[1].slice(1))):this.welcome(chat);return;}
    if(['/entries','/memes'].includes(cmd)){this.browse(chat);return;}
    if(['/about','/rules'].includes(cmd)){this.about(chat);return;}
    if(!this.isAdmin()){this.send(chat,'Organizer-only command. Try /start.');return;}
    if(['/admin','/help'].includes(cmd)) this.adminMenu(chat);
    else if(cmd==='/add') this.startDraft(chat);
    else if(cmd==='/cancel'){this.clearDraft();this.send(chat,'Draft canceled. Nothing published.');}
    else if(cmd==='/destinations')this.destinationList(chat);
    else if(cmd==='/duplicates'||cmd==='/dupes')this.duplicateReport(chat);
    else if(cmd==='/publish'){ if(parts.length!==2)this.send(chat,'Usage: /publish &lt;entry number&gt; or /publish all'); else if(parts[1].toLowerCase()==='all')this.publishAllMenu(chat); else if(!/^\d+$/.test(parts[1]))this.send(chat,'Usage: /publish &lt;entry number&gt; or /publish all'); else this.publishMenu(chat,Number(parts[1])); }
    else if(cmd==='/list') this.send(chat,'<b>Latest entries</b>\n'+(this.state.entries.slice().sort((a,b)=>b.id-a.id).slice(0,50).map(e=>`#${e.id} @${esc(e.x_username)} — ${e.active?'visible':'hidden'}`).join('\n')||'None'));
    else if(cmd==='/stats'){
      const active=this.standings();this.send(chat,`<b>Gallery stats</b>\nVisible entries: ${active.length}\nHidden entries: ${this.state.entries.length-active.length}`);
    } else if(['/remove','/restore','/share'].includes(cmd)){
      if(parts.length!==2||!/^\d+$/.test(parts[1])){this.send(chat,`Usage: ${esc(cmd)} &lt;entry number&gt;`);return;}
      const id=Number(parts[1]),e=this.entry(id,cmd==='/share');if(!e){this.send(chat,'Entry not found.');return;}
      if(cmd==='/share')this.send(chat,`Share entry: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${id}`);
      else {e.active=cmd==='/restore'?1:0;this.write('UPDATE entries SET active=? WHERE id=?',e.active,id);this.send(chat,`Entry #${id} ${e.active?'restored':'hidden'}.`);}
    } else this.send(chat,'Unknown command. Try /admin.');
  }
  async callback(c) {
    const chat=c.message?.chat,id=c.id,action=c.data||'',cid=chat?.id;
    if(!cid){this.ack(id,'Message unavailable.');return;}
    const privateChat=chat.type==='private';
    if(!privateChat){this.ack(id,'Open the bot private chat for this action.');return;}
    if(action==='menu:entries'){this.ack(id);this.browse(cid);return;}
    if(action==='menu:about'){this.ack(id);this.about(cid);return;}
    if(action.startsWith('admin:')){
      if(!this.isAdmin()){this.ack(id,'Organizer only.');return;}
      if(action==='admin:menu'){this.ack(id);this.adminMenu(cid);}
      else if(action==='admin:entries'){this.ack(id);this.adminEntries(cid);}
      else if(action==='admin:destinations'){this.ack(id);this.destinationList(cid);}
      else if(action==='admin:stats'){const active=this.standings();this.ack(id);this.send(cid,`<b>Gallery Statistics</b>\\nVisible entries: ${active.length}\\nHidden entries: ${this.state.entries.length-active.length}`,{inline_keyboard:[[button('Back to Admin Panel','admin:menu')]]});}
      else if(/^admin:entry:\\d+$/.test(action)){this.ack(id);this.adminEntryActions(cid,Number(action.split(':')[2]));}
      else if(/^admin:(hide|restore):\\d+$/.test(action)){const [,verb,raw]=action.split(':'),entryId=Number(raw),e=this.state.entries.find(x=>x.id===entryId);if(!e){this.ack(id,'Entry not found.');return;}e.active=verb==='restore'?1:0;this.write('UPDATE entries SET active=? WHERE id=?',e.active,entryId);this.ack(id,verb==='restore'?'Entry restored':'Entry hidden');this.adminEntryActions(cid,entryId);}
      else if(action==='admin:add'){this.ack(id);this.startDraft(cid);} else if(action==='admin:publishall'){this.ack(id);this.publishAllMenu(cid);} else if(action==='admin:duplicates'){this.ack(id,'Checking duplicate accounts…');this.duplicateReport(cid);}
      else if(action==='admin:publishdestall'){this.ack(id);this.publishBatchMenu(cid,null);}
      else if(/^admin:publishdest:-?\d+$/.test(action)){const destinationId=Number(action.split(':')[2]);this.ack(id);this.publishBatchMenu(cid,destinationId);}
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
      else if(/^admin:postbatch:-?\d+:\d+$/.test(action)){
        const [, ,destinationRaw,offsetRaw]=action.split(':'),destinationId=Number(destinationRaw),offset=Number(offsetRaw);
        const destination=this.state.destinations.find(d=>d.chat_id===destinationId);
        if(!destination){this.ack(id,'Destination unavailable.');return;}
        const count=this.standings().slice(offset,offset+10).length,first=offset+1,last=offset+count;
        if(!count){this.ack(id,'No visible memes in this batch.');return;}
        // Answer the Telegram callback before enqueueing media, so the button
        // responds immediately instead of timing out behind ten network sends.
        this.ack(id,'Batch accepted. Publishing…');
        this.publishAllEntries(destination,offset,10);
        this.send(cid,`Queued batch entries ${first}–${last} (${count} memes) for ${esc(destination.title)}.`);
      }
      else if(/^admin:postbatchall:\d+$/.test(action)){
        const offset=Number(action.split(':')[2]),entries=this.standings().slice(offset,offset+10),destinations=this.state.destinations;
        if(!entries.length||!destinations.length){this.ack(id,'No visible memes or destinations in this batch.');return;}
        const count=entries.length*destinations.length;
        // Acknowledge first; Telegram callback queries expire while media sends
        // are pending if the acknowledgement is placed after the batch.
        this.ack(id,'Batch accepted. Publishing…');
        for(const destination of destinations)this.publishAllEntries(destination,offset,10);
        this.send(cid,`Queued batch entries ${offset+1}–${offset+entries.length}: ${entries.length} memes for ${destinations.length} destinations (${count} posts).`);
      }
      else if(action==='admin:confirm'){
        if(this.state.draft?.step!=='confirm'){this.ack(id,'Draft already handled or expired.');return;}
        const d=this.state.draft.data,n=Math.max(0,...this.state.entries.map(e=>e.id))+1;
        this.write('INSERT INTO entries(id,photo_file_id,media_type,tweet_url,x_username,telegram_username,creator_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',n,d.photo_file_id,d.media_type||'photo',d.tweet_url,d.x_username,d.telegram_username||'',d.creator_name||'',this.userId,now());
        this.state.entries.push({...d,media_type:d.media_type||'photo',id:n,created_by:this.userId,active:1});this.clearDraft();
        this.ack(id,`Entry #${n} published`);this.send(cid,`✅ Entry #${n} saved.`,keyboard([button('📣 Publish to group/channel',`admin:publish:${n}`),button('🔗 Get private entry link',`admin:share:${n}`)]));this.show(cid,n);
      } else this.ack(id,'Unknown action.');return;
    }
    const open=action.match(/^open:(\d+)$/);
    if(open){
      const entryId=Number(open[1]),e=this.entry(entryId);if(!e){this.ack(id,'Entry unavailable.');return;}
      this.ack(id);this.show(cid,entryId);return;
    }
    const m=action.match(/^nav:(\d+)$/);
    if(!m){this.ack(id,'This action is no longer available.');return;}
    const entryId=Number(m[1]),e=this.entry(entryId);if(!e){this.ack(id,'Entry unavailable.');return;}
    this.ack(id);this.show(cid,entryId,c.message);
  }
  async handle(update) {
    if(update.callback_query){await this.callback(update.callback_query);return;}
    if(update.my_chat_member){
      const membership=update.my_chat_member,status=membership.new_chat_member?.status,active=['member','administrator','creator'].includes(status);
      if(!active||this.isAdmin())this.setDestination(membership.chat,active);
      return;
    }
    const m=update.message||update.channel_post;if(!m?.chat?.id||!m.from?.id)return;
    const forwardedChannel=m.forward_origin?.type==='channel'?m.forward_origin.chat:(m.forward_from_chat?.type==='channel'?m.forward_from_chat:null);
    if(this.isAdmin()&&m.chat.type==='private'&&forwardedChannel){this.setDestination(forwardedChannel,true);this.send(m.chat.id,`✅ Channel connected: ${esc(forwardedChannel.title||forwardedChannel.id)}. Use /publish &lt;entry number&gt; to publish an entry.`);return;}
    if(m.text?.startsWith('/'))this.command(m);
    else if(this.isAdmin()&&m.chat.type==='private'&&!this.state.draft&&this.importForwarded(m.chat.id,m))return;
    else if(this.isAdmin()&&m.chat.type==='private'&&this.handleDraft(m.chat.id,m))return;
    else if(m.chat.type==='private')this.send(m.chat.id,'Use /start to browse the JOBBY meme gallery. Only the organizer can add entries.');
  }
}

async function telegram(env,method,payload) {
  // Telegram may temporarily rate-limit a large contest batch. A 429 response
  // confirms that this request was not accepted, so retrying it is safe.
  for(let attempt=0;attempt<3;attempt++) {
    let response;
    try { response=await fetch(`https://api.telegram.org/bot${env.JOBBY_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)}); }
    catch { throw new Error('Telegram transport unavailable'); }
    let data;try {data=await response.json();}catch {throw new Error('Invalid Telegram response');}
    if(response.ok&&data.ok)return data.result;
    if((response.status===429||data.error_code===429)&&attempt<2) {
      const retryAfter=Number(data.parameters?.retry_after)||1;
      await new Promise(resolve=>setTimeout(resolve,Math.min(Math.max(retryAfter,1),5)*1000));
      continue;
    }
    const e=new Error('Telegram request rejected');e.code=data.error_code||response.status;e.description=data.description;e.retryAfter=data.parameters?.retry_after;throw e;
  }
  throw new Error('Telegram rate limit retry exhausted');
}

async function deliver(env,updateId) {
  const pending=await env.DB.prepare('SELECT * FROM webhook_outbox WHERE update_id=? AND delivered=0 ORDER BY id').bind(updateId).all();
  // Preserve the exact outbox order. Concurrent sends can reorder a bulk
  // publish and trigger Telegram flood limits, leaving part of the batch stuck.
  for(let i=0;i<pending.results.length;i++) {
    const row=pending.results[i],payload=JSON.parse(row.payload);
    try {
      const delivered=await telegram(env,row.method,payload);
      const caption=payload.caption||payload.media?.caption||'';
      const entryMatch=String(caption).match(/JOBBY MEME ENTRY — #(\d+)/);
      const source=row.method==='editMessageMedia'?payload.media?.media:
        row.method==='sendPhoto'?payload.photo:row.method==='sendVideo'?payload.video:
        row.method==='sendAnimation'?payload.animation:'';
      const fileId=delivered?.photo?.at(-1)?.file_id||delivered?.video?.file_id||delivered?.animation?.file_id||'';
      if(entryMatch&&fileId&&typeof source==='string'&&source.startsWith('https://'))
        await env.DB.prepare('UPDATE entries SET photo_file_id=? WHERE id=? AND photo_file_id=?')
          .bind(fileId,Number(entryMatch[1]),source).run();
    }
    catch(e) {
      if(['sendPhoto','sendVideo','sendAnimation'].includes(row.method)&&e.code===400) {
        // Do not silently skip a meme or let one invalid Telegram file_id block
        // the entire batch. Publish this same entry's caption and original X link
        // as a text fallback, then continue in order.
        const caption=payload.caption||'';
        const markup=payload.reply_markup;
        await telegram(env,'sendMessage',{chat_id:payload.chat_id,
          text:caption+'\\n\\nMedia could not be attached by Telegram; open the original X post to view this entry.',
          parse_mode:'HTML',...(markup?{reply_markup:markup}:{})});
      } else if((row.method==='answerCallbackQuery'&&e.code===400)||
        (row.method.startsWith('editMessage')&&e.code===400&&/message is not modified/i.test(e.description||''))) {
        // These responses are already obsolete or have already taken effect.
      } else {
        // Stop exactly at the failed item. Keep it and all later items pending,
        // so successful earlier posts are not repeated and nothing is skipped.
        throw e;
      }
    }
    await env.DB.prepare('UPDATE webhook_outbox SET delivered=1 WHERE id=?').bind(row.id).run();
    if(i<pending.results.length-1) await new Promise(resolve=>setTimeout(resolve,350));
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

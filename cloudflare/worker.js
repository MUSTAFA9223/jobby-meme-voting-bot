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
      'SELECT * FROM destinations WHERE active=1 ORDER BY title,chat_id',
      'SELECT language FROM user_settings WHERE user_id=?'
    ];
    const result = await env.DB.batch(queries.map((q,i) => i < 2 || i === 5 ? env.DB.prepare(q) : env.DB.prepare(q).bind(userId)));
    return new Contest(env, {entries: result[0].results, config: Object.fromEntries(result[1].results.map(r=>[r.key,r.value])),
      draft: result[2].results[0] ? {step:result[2].results[0].step,data:JSON.parse(result[2].results[0].data)} : null,
      votes:new Set(result[3].results.map(r=>r.entry_id)), ratings:Object.fromEntries(result[4].results.map(r=>[r.entry_id,r.value])),
      destinations:result[5].results, language:result[6].results[0]?.language || null}, userId);
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
  get ar() { return this.state.language==='ar'; }
  t(en,ar) { return this.ar?ar:en; }
  statusLabel() { return this.ar?({open:'مفتوح',paused:'متوقف مؤقتًا',closed:'مغلق'}[this.status]||this.status):this.status.toUpperCase(); }
  setLanguage(language) {
    this.state.language=language;
    this.write('INSERT INTO user_settings(user_id,language,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET language=excluded.language,updated_at=excluded.updated_at',this.userId,language,now());
  }
  detectLanguage(from) {
    if(this.state.language||!from?.id)return;
    this.setLanguage(String(from.language_code||'').toLowerCase().startsWith('ar')?'ar':'en');
  }
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
  startDraft(chat) { this.draft('media',{}); this.send(chat,this.t('➕ <b>Add JOBBY meme</b>\nStep 1/4: Send the meme as a photo, video, or GIF.\n/cancel to stop.','➕ <b>إضافة ميم JOBBY</b>\nالخطوة 1/4: أرسل الميم كصورة أو فيديو أو GIF.\nأرسل /cancel للإلغاء.')); }
  languageMenu(chat) { this.send(chat,this.t('Choose your language:','اختر لغة البوت:'),keyboard([button('العربية','lang:ar'),button('English','lang:en')])); }
  welcome(chat) {
    const rows=[[button(this.t('🖼 Browse memes','🖼 تصفح الميمات'),'menu:entries')],[button(this.t('🏆 Leaderboard','🏆 المتصدرون'),'menu:leaderboard'),button(this.t('ℹ️ Rules','ℹ️ القواعد'),'menu:rules')],[button(this.t('🌐 العربية','🌐 English'),'menu:language')]];
    if(this.isAdmin()) rows.push([button(this.t('➕ Add meme (admin)','➕ إضافة ميم (الإدارة)'),'admin:add')]);
    this.send(chat,this.t('🏆 <b>JOBBY Meme Voting</b>\n\nBrowse the memes and vote once for every meme you support. Each vote is final and cannot be added twice.\nOnly the organizer can submit entries.','🏆 <b>تصويت ميمات JOBBY</b>\n\nتصفّح الميمات وصوّت مرة واحدة لكل ميم يعجبك. كل صوت نهائي ولا يمكن احتسابه مرتين.\nإضافة المشاركات متاحة للمنظّم فقط.'),{inline_keyboard:rows});
  }
  rules(chat) { this.send(chat,this.t(`<b>Contest rules</b>\n• Each Telegram account can vote once for every meme.\n• A recorded vote is final and cannot be added twice or changed.\n• One 1–5 star rating per meme; ratings can be updated while voting is open.\n• Votes rank first; star averages break ties.\n• Organizers upload memes and original X links.\n• Status: <b>${esc(this.statusLabel())}</b>.\nPlease vote fairly.`,`<b>قواعد المسابقة</b>\n• يمكن لكل حساب تيليجرام التصويت مرة واحدة لكل ميم.\n• الصوت المسجل نهائي ولا يمكن تكراره أو تغييره.\n• تقييم واحد من 1–5 نجوم لكل ميم، ويمكن تحديث التقييم أثناء فتح التصويت.\n• ترتيب النتائج حسب الأصوات، ثم متوسط النجوم عند التعادل.\n• المنظّم هو من يضيف الميمات وروابط منشورات X الأصلية.\n• الحالة: <b>${esc(this.statusLabel())}</b>.\nيرجى التصويت بعدالة.`)); }
  caption(e) {
    const n=String(e.id).padStart(3,'0'),stars=Number(e.average_stars).toFixed(2),voted=this.state.votes.has(e.id),rating=this.state.ratings[e.id]||'—';
    return this.t(`🏆 <b>JOBBY MEME CONTEST — #${n}</b>\n\n🐦 X creator: <b>@${esc(e.x_username)}</b>\n💬 Telegram: <b>@${esc(e.telegram_username)}</b>\n🔗 Tweet: <a href="${esc(e.tweet_url)}">View original post on X</a>\n\n🗳 Votes: <b>${e.votes}</b> | ⭐ Rating: <b>${stars}/5</b> (${e.rating_count} ratings)\nContest: <b>${esc(this.statusLabel())}</b>\n\nYour vote: <b>${voted?'Recorded':'Not voted'}</b> | Your rating: <b>${rating}</b>`,`🏆 <b>مسابقة ميمات JOBBY — #${n}</b>\n\n🐦 صاحب المشاركة على X: <b>@${esc(e.x_username)}</b>\n💬 تيليجرام: <b>@${esc(e.telegram_username)}</b>\n🔗 التغريدة: <a href="${esc(e.tweet_url)}">عرض المنشور الأصلي على X</a>\n\n🗳 الأصوات: <b>${e.votes}</b> | ⭐ التقييم: <b>${stars}/5</b> (${e.rating_count} تقييمات)\nحالة المسابقة: <b>${esc(this.statusLabel())}</b>\n\nتصويتك: <b>${voted?'مسجّل':'لم تصوّت'}</b> | تقييمك: <b>${rating}</b>`);
  }
  publicCaption(e) { return `🏆 <b>مسابقة ميمات JOBBY / JOBBY MEME CONTEST — #${String(e.id).padStart(3,'0')}</b>\n\n🐦 X: <b>@${esc(e.x_username)}</b>\n💬 Telegram: <b>@${esc(e.telegram_username)}</b>\n🔗 <a href="${esc(e.tweet_url)}">عرض التغريدة الأصلية / View original post</a>\n\n🗳 الأصوات / Votes: <b>${e.votes}</b> | ⭐ التقييم / Rating: <b>${Number(e.average_stars).toFixed(2)}/5</b> (${e.rating_count})\n\nصوّت وقيّم من الأزرار أدناه. / Vote and rate below.`; }
  entryKeyboard(e) {
    const ids=this.ids(), i=ids.indexOf(e.id), before=ids[(i-1+ids.length)%ids.length], after=ids[(i+1)%ids.length];
    return keyboard([1,2,3,4,5].map(n=>button(`⭐ ${n}`,`rate:${e.id}:${n}`)),[button(this.t('🗳 Vote for this meme','🗳 صوّت لهذا الميم'),`vote:${e.id}`)],
      [link(this.t('🐦 View Tweet on X','🐦 عرض التغريدة على X'),e.tweet_url)],[link(this.t('X creator','حساب X'),`https://x.com/${e.x_username}`),link(this.t('Telegram creator','حساب تيليجرام'),`https://t.me/${e.telegram_username}`)],
      [button(this.t('◀ Previous','◀ السابق'),`nav:${before}`),button(this.t('🏆 Top','🏆 المتصدرون'),'menu:leaderboard'),button(this.t('Next ▶','التالي ▶'),`nav:${after}`)]);
  }
  publicKeyboard(e) {
    return keyboard([1,2,3,4,5].map(n=>button(`⭐ ${n}`,`rate:${e.id}:${n}`)),[button('🗳 صوّت لهذا الميم / Vote',`vote:${e.id}`)],
      [link('🐦 عرض التغريدة / View on X',e.tweet_url)],[link('فتح البوت / Open bot',`https://t.me/${this.env.JOBBY_BOT_USERNAME}?start=m${e.id}`)]);
  }
  show(chat,id,origin) {
    const e=this.entry(id); if(!e) {this.send(chat,this.t('That entry is not available.','هذه المشاركة غير متاحة.'));return;}
    const type=e.media_type||'photo';
    if(origin&&(origin.photo||origin.video||origin.animation)) this.api('editMessageMedia',{chat_id:chat,message_id:origin.message_id,media:{type,media:e.photo_file_id,caption:this.caption(e),parse_mode:'HTML'},reply_markup:this.entryKeyboard(e)});
    else this.media(chat,type,e.photo_file_id,this.caption(e),this.entryKeyboard(e));
  }
  browse(chat) { const ids=this.ids(); ids.length ? this.show(chat,ids[0]) : this.send(chat,this.t('No meme entries yet. Check back soon!','لا توجد مشاركات ميمات حتى الآن. عد لاحقًا!')); }
  leaderboard(chat) {
    const entries=this.standings().slice(0,10); if(!entries.length){this.send(chat,this.t('No memes have been added yet.','لم تتم إضافة أي ميمات حتى الآن.'));return;}
    const lines=entries.map((e,i)=>`${i+1}. <b>#${String(e.id).padStart(3,'0')} @${esc(e.x_username)}</b> — ${e.votes} ${this.t('votes','صوت')} | ⭐ ${Number(e.average_stars).toFixed(2)} (${e.rating_count})`);
    const rows=[];for(let i=0;i<entries.length;i+=3) rows.push(entries.slice(i,i+3).map(e=>button(`${this.t('View','عرض')} #${e.id}`,`nav:${e.id}`)));
    rows.push([button(this.t('🖼 Browse all memes','🖼 تصفح كل الميمات'),'menu:entries')]);
    this.send(chat,this.t(`🏆 <b>JOBBY Leaderboard</b> (${esc(this.statusLabel())})\n\n${lines.join('\n')}\n\nRanked by votes, then average stars.`,`🏆 <b>ترتيب JOBBY</b> (${esc(this.statusLabel())})\n\n${lines.join('\n')}\n\nالترتيب حسب الأصوات، ثم متوسط النجوم.`),{inline_keyboard:rows});
  }
  destinationList(chat) {
    const rows=this.state.destinations;
    if(!rows.length){this.send(chat,this.t('No groups or channels are connected yet.\n\nGroup: add the bot, then send /register in the group.\nChannel: add the bot as an admin with permission to post, then forward any channel post to this private chat.','لا توجد مجموعات أو قنوات متصلة بعد.\n\nالمجموعة: أضف البوت ثم أرسل /register داخل المجموعة.\nالقناة: أضف البوت مشرفًا بصلاحية النشر، ثم حوّل أي منشور من القناة إلى البوت في الخاص.'));return;}
    this.send(chat,this.t('<b>Connected publishing destinations</b>','<b>وجهات النشر المتصلة</b>')+'\n\n'+rows.map((d,i)=>`${i+1}. ${esc(d.title)} — <code>${d.chat_id}</code> (${esc(d.chat_type)})`).join('\n'));
  }
  publishMenu(chat,entryId) {
    const e=this.entry(entryId);if(!e){this.send(chat,this.t('Entry not found or hidden.','المشاركة غير موجودة أو مخفية.'));return;}
    const destinations=this.state.destinations;
    if(!destinations.length){this.destinationList(chat);return;}
    const rows=destinations.map(d=>[button(`📣 ${String(d.title).slice(0,40)}`,`admin:post:${entryId}:${d.chat_id}`)]);
    if(destinations.length>1)rows.push([button(this.t('📣 Publish to all','📣 النشر في الكل'),`admin:postall:${entryId}`)]);
    this.send(chat,this.t(`Choose where to publish entry #${entryId}:`,`اختر مكان نشر المشاركة #${entryId}:`),{inline_keyboard:rows});
  }
  publishEntry(entryId,destination) {
    const e=this.entry(entryId);if(!e||!destination)return false;
    this.media(destination.chat_id,e.media_type||'photo',e.photo_file_id,this.publicCaption(e),this.publicKeyboard(e));
    return true;
  }
  preview(chat) {
    const d=this.state.draft?.data;if(this.state.draft?.step!=='confirm'){this.send(chat,this.t('No complete draft. Use /add.','لا توجد مشاركة مكتملة. استخدم /add.'));return;}
    this.media(chat,d.media_type||'photo',d.photo_file_id,this.t(`<b>Review before publishing</b>\nX post: ${esc(d.tweet_url)}\nX creator: @${esc(d.x_username)}\nTelegram: @${esc(d.telegram_username)}`,`<b>مراجعة قبل الحفظ</b>\nمنشور X: ${esc(d.tweet_url)}\nحساب X: @${esc(d.x_username)}\nتيليجرام: @${esc(d.telegram_username)}`),keyboard([button(this.t('✅ Publish entry','✅ حفظ المشاركة'),'admin:confirm'),button(this.t('❌ Cancel','❌ إلغاء'),'admin:cancel')]));
  }
  handleDraft(chat,message) {
    const draft=this.state.draft;if(!draft)return false;const {step,data}=draft;
    if(step==='confirm'){this.send(chat,this.t('Tap Publish or Cancel on the preview.','اضغط حفظ المشاركة أو إلغاء من المعاينة.'));return true;}
    if(step==='media'||step==='photo'){
      const photo=message.photo?.at(-1),video=message.video,animation=message.animation;
      const media=photo?{type:'photo',file_id:photo.file_id}:video?{type:'video',file_id:video.file_id}:animation?{type:'animation',file_id:animation.file_id}:null;
      if(!media){this.send(chat,this.t('Send the meme as a Telegram photo, video, or GIF. /cancel to stop.','أرسل الميم كصورة أو فيديو أو GIF. أرسل /cancel للإلغاء.'));return true;}
      this.draft('tweet',{...data,media_type:media.type,photo_file_id:media.file_id});this.send(chat,this.t('Step 2/4: Paste the original X post URL.','الخطوة 2/4: أرسل رابط منشور X الأصلي.'));return true;
    }
    try {
      const text=message.text||'';
      if(step==='tweet'){this.draft('x',{...data,tweet_url:normalizeTweet(text)});this.send(chat,this.t("Step 3/4: Send the participant's X username.",'الخطوة 3/4: أرسل اسم مستخدم المشارك على X.'));}
      else if(step==='x'){this.draft('tg',{...data,x_username:normalizeHandle(text)});this.send(chat,this.t("Step 4/4: Send the participant's Telegram username.",'الخطوة 4/4: أرسل اسم مستخدم المشارك في تيليجرام.'));}
      else if(step==='tg'){this.draft('confirm',{...data,telegram_username:normalizeHandle(text,true)});this.preview(chat);}
      else this.send(chat,this.t('Unknown draft state. /cancel then /add.','حالة غير معروفة. أرسل /cancel ثم /add.'));
    } catch(e){this.send(chat,this.t(`⚠️ ${esc(e.message)} Try again.`,'⚠️ البيانات غير صحيحة. حاول مرة أخرى.'));}return true;
  }
  command(message) {
    const chat=message.chat.id,parts=message.text.trim().split(/\s+/),cmd=parts[0].split('@')[0].toLowerCase();
    if(cmd==='/myid'){this.send(chat,this.t(`Your Telegram ID: <code>${this.userId}</code>`,`معرّف تيليجرام الخاص بك: <code>${this.userId}</code>`));return;}
    if(message.chat.type!=='private'&&['/register','/connect'].includes(cmd)){
      if(!this.isAdmin()){this.send(chat,this.t('Only the JOBBY organizer can connect this chat.','منظّم JOBBY فقط يمكنه ربط هذه المحادثة.'));return;}
      this.setDestination(message.chat,true);this.send(chat,this.t('✅ This chat is connected to JOBBY voting. Publishing is controlled from the bot private chat.','✅ تم ربط هذه المحادثة بتصويت JOBBY. يتم التحكم بالنشر من خاص البوت.'));return;
    }
    if(message.chat.type!=='private'&&['/unregister','/disconnect'].includes(cmd)){
      if(!this.isAdmin()){this.send(chat,this.t('Only the JOBBY organizer can disconnect this chat.','منظّم JOBBY فقط يمكنه فصل هذه المحادثة.'));return;}
      this.setDestination(message.chat,false);this.send(chat,this.t('This chat was disconnected from JOBBY publishing.','تم فصل هذه المحادثة عن نشر JOBBY.'));return;
    }
    if(message.chat.type!=='private'){this.send(chat,this.t('Open the voting bot in a private chat.','افتح بوت التصويت في المحادثة الخاصة.'));return;}
    if(cmd==='/start'){/^m\d{1,9}$/.test(parts[1]||'')?this.show(chat,Number(parts[1].slice(1))):this.welcome(chat);return;}
    if(['/entries','/memes'].includes(cmd)){this.browse(chat);return;}
    if(['/leaderboard','/results'].includes(cmd)){this.leaderboard(chat);return;}
    if(cmd==='/rules'){this.rules(chat);return;}
    if(cmd==='/language'||cmd==='/lang'){this.languageMenu(chat);return;}
    if(!this.isAdmin()){this.send(chat,this.t('Organizer-only command. Try /start.','هذا الأمر للمنظّم فقط. استخدم /start.'));return;}
    if(['/admin','/help'].includes(cmd)) this.send(chat,this.t('<b>JOBBY Admin</b>\n/add — Add photo, video, or GIF meme\n/cancel — Cancel draft\n/list — Entries\n/publish 12 — Publish in a group/channel\n/destinations — Connected groups/channels\n/register — Run inside a group to connect it\nForward a channel post here to connect that channel\n/remove 12 — Hide\n/restore 12 — Restore\n/pause — Freeze voting\n/resume — Reopen\n/close — Close voting\n/results — Leaderboard\n/stats — Counters\n/share 12 — Private voting link\n/language — Change language','<b>إدارة JOBBY</b>\n/add — إضافة صورة أو فيديو أو GIF\n/cancel — إلغاء المشاركة الحالية\n/list — عرض المشاركات\n/publish 12 — النشر في مجموعة أو قناة\n/destinations — الوجهات المتصلة\n/register — أرسله داخل المجموعة لربطها\nلربط قناة: حوّل منشورًا منها إلى خاص البوت\n/remove 12 — إخفاء مشاركة\n/restore 12 — استعادة مشاركة\n/pause — إيقاف التصويت مؤقتًا\n/resume — فتح التصويت\n/close — إغلاق التصويت\n/results — المتصدرون\n/stats — الإحصائيات\n/share 12 — رابط التصويت الخاص\n/language — تغيير اللغة'));
    else if(cmd==='/add') this.startDraft(chat);
    else if(cmd==='/cancel'){this.clearDraft();this.send(chat,this.t('Draft canceled. Nothing published.','تم إلغاء المسودة ولم يتم نشر شيء.'));}
    else if(cmd==='/destinations')this.destinationList(chat);
    else if(cmd==='/publish'){
      if(parts.length!==2||!/^\d+$/.test(parts[1]))this.send(chat,this.t('Usage: /publish &lt;entry number&gt;','الاستخدام: /publish &lt;رقم المشاركة&gt;'));
      else this.publishMenu(chat,Number(parts[1]));
    }
    else if(['/pause','/resume','/close'].includes(cmd)){
      const status={'/pause':'paused','/resume':'open','/close':'closed'}[cmd];this.state.config.status=status;this.write("UPDATE config SET value=? WHERE key='status'",status);this.send(chat,this.t(`Voting and ratings are now ${status}.`,`أصبحت حالة التصويت والتقييم: ${this.statusLabel()}.`));
    } else if(cmd==='/list') this.send(chat,this.t('<b>Latest entries</b>','<b>أحدث المشاركات</b>')+'\n'+(this.state.entries.slice().sort((a,b)=>b.id-a.id).slice(0,50).map(e=>`#${e.id} @${esc(e.x_username)} — ${this.t(e.active?'visible':'hidden',e.active?'ظاهرة':'مخفية')}`).join('\n')||this.t('None','لا يوجد')));
    else if(cmd==='/stats'){
      const active=this.standings();this.send(chat,this.t(`<b>Contest stats</b>\nActive: ${active.length}\nHidden: ${this.state.entries.length-active.length}\nValid votes: ${active.reduce((n,e)=>n+e.votes,0)}\nRatings: ${active.reduce((n,e)=>n+e.rating_count,0)}\nStatus: ${esc(this.statusLabel())}`,`<b>إحصائيات المسابقة</b>\nالمشاركات الظاهرة: ${active.length}\nالمخفية: ${this.state.entries.length-active.length}\nالأصوات الصحيحة: ${active.reduce((n,e)=>n+e.votes,0)}\nالتقييمات: ${active.reduce((n,e)=>n+e.rating_count,0)}\nالحالة: ${esc(this.statusLabel())}`));
    } else if(['/remove','/restore','/share'].includes(cmd)){
      if(parts.length!==2||!/^\d+$/.test(parts[1])){this.send(chat,this.t(`Usage: ${esc(cmd)} &lt;entry number&gt;`,`الاستخدام: ${esc(cmd)} &lt;رقم المشاركة&gt;`));return;}
      const id=Number(parts[1]),e=this.entry(id,cmd==='/share');if(!e){this.send(chat,this.t('Entry not found.','المشاركة غير موجودة.'));return;}
      if(cmd==='/share')this.send(chat,this.t(`Share: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${id}`,`رابط المشاركة: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${id}`));
      else {e.active=cmd==='/restore'?1:0;this.write('UPDATE entries SET active=? WHERE id=?',e.active,id);this.send(chat,this.t(`Entry #${id} ${e.active?'restored':'hidden'}.`,`المشاركة #${id} ${e.active?'تمت استعادتها':'تم إخفاؤها'}.`));}
    } else this.send(chat,this.t('Unknown command. Try /admin.','أمر غير معروف. جرّب /admin.'));
  }
  async hasAccess() {
    if(!this.env.JOBBY_REQUIRED_CHAT_ID||this.isAdmin())return true;
    try {const r=await telegram(this.env,'getChatMember',{chat_id:this.env.JOBBY_REQUIRED_CHAT_ID,user_id:this.userId});return ['member','administrator','creator'].includes(r.status)||(r.status==='restricted'&&r.is_member===true);}catch{return false;}
  }
  async callback(c) {
    const chat=c.message?.chat,id=c.id,action=c.data||'',cid=chat?.id;
    if(!cid){this.ack(id,this.t('Message unavailable.','الرسالة غير متاحة.'));return;}
    const privateChat=chat.type==='private';
    if(!privateChat&&!/^(vote|rate):/.test(action)){this.ack(id,this.t('Open the bot private chat for this action.','افتح خاص البوت لتنفيذ هذا الإجراء.'));return;}
    if(action==='menu:language'){this.ack(id);this.languageMenu(cid);return;}
    if(/^lang:(ar|en)$/.test(action)){const language=action.slice(5);this.setLanguage(language);this.ack(id,language==='ar'?'تم اختيار اللغة العربية.':'Language changed to English.');this.welcome(cid);return;}
    if(action==='menu:entries'){this.ack(id);this.browse(cid);return;}
    if(action==='menu:leaderboard'){this.ack(id);this.leaderboard(cid);return;}
    if(action==='menu:rules'){this.ack(id);this.rules(cid);return;}
    if(action.startsWith('admin:')){
      if(!this.isAdmin()){this.ack(id,this.t('Organizer only.','للمنظّم فقط.'));return;}
      if(action==='admin:add'){this.ack(id);this.startDraft(cid);}
      else if(action==='admin:cancel'){this.clearDraft();this.ack(id,this.t('Draft canceled','تم إلغاء المسودة'));this.send(cid,this.t('Draft canceled; nothing published.','تم إلغاء المسودة ولم يتم نشر شيء.'));}
      else if(/^admin:publish:\d+$/.test(action)){const entryId=Number(action.split(':')[2]);this.ack(id);this.publishMenu(cid,entryId);}
      else if(/^admin:share:\d+$/.test(action)){const entryId=Number(action.split(':')[2]);this.ack(id);this.send(cid,`Share: https://t.me/${esc(this.env.JOBBY_BOT_USERNAME)}?start=m${entryId}`);}
      else if(/^admin:post:\d+:-?\d+$/.test(action)){
        const [, , entryRaw,destinationRaw]=action.split(':'),entryId=Number(entryRaw),destinationId=Number(destinationRaw);
        const destination=this.state.destinations.find(d=>d.chat_id===destinationId);
        if(!this.publishEntry(entryId,destination)){this.ack(id,this.t('Entry or destination unavailable.','المشاركة أو وجهة النشر غير متاحة.'));return;}
        this.ack(id,this.t('Publishing…','جارٍ النشر…'));this.send(cid,this.t(`✅ Entry #${entryId} queued for ${esc(destination.title)}.`,`✅ تم إرسال المشاركة #${entryId} للنشر في ${esc(destination.title)}.`));
      }
      else if(/^admin:postall:\d+$/.test(action)){
        const entryId=Number(action.split(':')[2]),count=this.state.destinations.filter(d=>this.publishEntry(entryId,d)).length;
        if(!count){this.ack(id,this.t('No available destinations.','لا توجد وجهات نشر متاحة.'));return;}
        this.ack(id,this.t('Publishing to all…','جارٍ النشر في الكل…'));this.send(cid,this.t(`✅ Entry #${entryId} queued for ${count} destinations.`,`✅ تم إرسال المشاركة #${entryId} إلى ${count} وجهات.`));
      }
      else if(action==='admin:confirm'){
        if(this.state.draft?.step!=='confirm'){this.ack(id,this.t('Draft already handled or expired.','تم التعامل مع المسودة أو انتهت صلاحيتها.'));return;}
        const d=this.state.draft.data,n=Math.max(0,...this.state.entries.map(e=>e.id))+1;
        this.write('INSERT INTO entries(id,photo_file_id,media_type,tweet_url,x_username,telegram_username,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',n,d.photo_file_id,d.media_type||'photo',d.tweet_url,d.x_username,d.telegram_username,this.userId,now());
        this.state.entries.push({...d,media_type:d.media_type||'photo',id:n,created_by:this.userId,active:1,votes:0,rating_count:0,average_stars:0});this.clearDraft();
        this.ack(id,this.t(`Entry #${n} published`,`تم حفظ المشاركة #${n}`));this.send(cid,this.t(`✅ Entry #${n} saved.`,`✅ تم حفظ المشاركة #${n}.`),keyboard([button(this.t('📣 Publish to group/channel','📣 النشر في مجموعة/قناة'),`admin:publish:${n}`),button(this.t('🔗 Get private voting link','🔗 رابط التصويت الخاص'),`admin:share:${n}`)]));this.show(cid,n);
      } else this.ack(id,this.t('Unknown action.','إجراء غير معروف.'));return;
    }
    const m=action.match(/^(nav|vote|rate):(\d+)(?::([1-5]))?$/);
    if(!m||(m[1]==='rate'?!m[3]:!!m[3])){this.ack(id,this.t('Unknown action.','إجراء غير معروف.'));return;}
    const entryId=Number(m[2]),e=this.entry(entryId);if(!e){this.ack(id,this.t('Entry unavailable.','المشاركة غير متاحة.'));return;}
    if(m[1]==='nav'){if(!privateChat){this.ack(id,this.t('Open the bot for the full gallery.','افتح البوت لمشاهدة كل المشاركات.'));return;}this.ack(id);this.show(cid,entryId,c.message);return;}
    if(!await this.hasAccess()){this.ack(id,this.t('Join the official community first.','انضم إلى المجتمع الرسمي أولًا.'));return;}
    if((c.from.username||'').toLowerCase()===e.telegram_username.toLowerCase()){this.ack(id,this.t('Creators cannot vote for their own meme.','لا يمكن لصاحب الميم التصويت لمشاركته.'));return;}
    if(this.status!=='open'){this.ack(id,this.t('Voting and ratings are closed.','التصويت والتقييم مغلقان.'));return;}
    if(m[1]==='vote'){
      const voted=this.state.votes.has(entryId);this.ack(id,this.t(voted?'You already voted for this meme.':'Vote recorded!',voted?'لقد صوّت لهذا الميم مسبقًا.':'تم تسجيل صوتك!'));
      if(!voted){e.votes++;this.state.votes.add(entryId);
        this.write('INSERT OR IGNORE INTO votes(user_id,entry_id,updated_at) VALUES(?,?,?)',this.userId,entryId,now());}
    } else {
      const value=Number(m[3]),old=this.state.ratings[entryId];e.average_stars=(e.average_stars*e.rating_count-(old||0)+value)/(e.rating_count+(old?0:1));if(!old)e.rating_count++;
      this.state.ratings[entryId]=value;this.write('INSERT INTO ratings(user_id,entry_id,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,entry_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',this.userId,entryId,value,now());this.ack(id,this.t('Rating saved!','تم حفظ التقييم!'));
    }
    if(c.message.photo||c.message.video||c.message.animation)this.api('editMessageCaption',{chat_id:cid,message_id:c.message.message_id,caption:privateChat?this.caption(e):this.publicCaption(e),parse_mode:'HTML',reply_markup:privateChat?this.entryKeyboard(e):this.publicKeyboard(e)});
  }
  async handle(update) {
    this.detectLanguage(update.callback_query?.from||update.message?.from||update.channel_post?.from||update.my_chat_member?.from);
    if(update.callback_query){await this.callback(update.callback_query);return;}
    if(update.my_chat_member){
      const membership=update.my_chat_member,status=membership.new_chat_member?.status,active=['member','administrator','creator'].includes(status);
      if(!active||this.isAdmin())this.setDestination(membership.chat,active);
      return;
    }
    const m=update.message||update.channel_post;if(!m?.chat?.id||!m.from?.id)return;
    const forwardedChannel=m.forward_origin?.type==='channel'?m.forward_origin.chat:(m.forward_from_chat?.type==='channel'?m.forward_from_chat:null);
    if(this.isAdmin()&&m.chat.type==='private'&&forwardedChannel){this.setDestination(forwardedChannel,true);this.send(m.chat.id,this.t(`✅ Channel connected: ${esc(forwardedChannel.title||forwardedChannel.id)}. Use /publish &lt;entry number&gt; to post voting.`,`✅ تم ربط القناة: ${esc(forwardedChannel.title||forwardedChannel.id)}. استخدم /publish &lt;رقم المشاركة&gt; لنشر التصويت.`));return;}
    if(m.text?.startsWith('/'))this.command(m);
    else if(this.isAdmin()&&m.chat.type==='private'&&this.handleDraft(m.chat.id,m))return;
    else if(m.chat.type==='private')this.send(m.chat.id,this.t('Use /start to browse memes and vote. Only the organizer can submit entries.','استخدم /start لتصفح الميمات والتصويت. إضافة المشاركات متاحة للمنظّم فقط.'));
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

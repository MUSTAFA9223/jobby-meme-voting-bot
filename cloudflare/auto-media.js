import worker from './worker.js';

const X_POST = /https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/i;
const X_MEDIA_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);

function safeXMediaUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && X_MEDIA_HOSTS.has(url.hostname) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function fxMediaFromPayload(payload) {
  const status = payload?.status || payload?.tweet;
  if (!status || ![200, undefined].includes(payload?.code)) return null;
  const media = status.media || {};
  const items = Array.isArray(media.all) && media.all.length
    ? media.all : [...(media.videos || []), ...(media.photos || [])];
  for (const item of items) {
    if (!['photo', 'video', 'gif'].includes(item?.type)) continue;
    let url = '';
    if (item.type === 'video' || item.type === 'gif') {
      const mp4 = (item.formats || [])
        .filter(format => format?.container === 'mp4' && safeXMediaUrl(format.url))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
      url = safeXMediaUrl(mp4[0]?.url) || safeXMediaUrl(item.url);
    } else {
      url = safeXMediaUrl(item.url);
    }
    if (url) return {type: item.type === 'gif' ? 'animation' : item.type, url};
  }
  return null;
}

async function fetchXMedia(postId, fetcher) {
  const response = await fetcher(`https://api.fxtwitter.com/2/status/${postId}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'JOBBYMemeGallery/1.0 (+https://t.me/JOBBYMemeVoteBot)',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error('X media lookup failed');
  const raw = await response.text();
  if (raw.length > 524288) throw new Error('X media response too large');
  const media = fxMediaFromPayload(JSON.parse(raw));
  if (!media) throw new Error('No supported X media');
  return media;
}

export async function enrichForwardedXMedia(update, env, fetcher = fetch) {
  const message = update?.message;
  const admins = new Set((env.JOBBY_ADMIN_IDS || '').split(',').map(Number));
  const forwarded = message?.forward_origin || message?.forward_from ||
    message?.forward_from_chat || message?.is_automatic_forward;
  if (!message || message.chat?.type !== 'private' || !admins.has(message.from?.id) ||
      !forwarded || message.photo || message.video || message.animation) return update;
  const source = `${message.text || ''}\n${message.caption || ''}`;
  const match = source.match(X_POST);
  if (!match) return update;
  try {
    const media = await fetchXMedia(match[1], fetcher);
    const enriched = structuredClone(update);
    if (media.type === 'photo') enriched.message.photo = [{file_id: media.url}];
    else enriched.message[media.type] = {file_id: media.url};
    return enriched;
  } catch {
    return update;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const authorized = url.pathname === '/webhook' && request.method === 'POST' &&
      env.JOBBY_WEBHOOK_SECRET &&
      request.headers.get('X-Telegram-Bot-Api-Secret-Token') === env.JOBBY_WEBHOOK_SECRET;
    if (!authorized) return worker.fetch(request, env, ctx);
    try {
      const raw = await request.clone().text();
      if (raw.length > 1048576) return worker.fetch(request, env, ctx);
      const update = JSON.parse(raw);
      const enriched = await enrichForwardedXMedia(update, env);
      if (enriched === update) {
        const response = await worker.fetch(request, env, ctx);
        const headers = new Headers(response.headers);
        headers.set('X-Jobby-X-Media', 'not-enriched');
        return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
      }
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const transformed = new Request(request.url, {
        method: 'POST', headers, body: JSON.stringify(enriched),
      });
      const response = await worker.fetch(transformed, env, ctx);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('X-Jobby-X-Media', 'enriched');
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers: responseHeaders});
    } catch {
      return worker.fetch(request, env, ctx);
    }
  },
};

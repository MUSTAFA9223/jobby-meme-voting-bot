import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enrichForwardedXMedia, fxMediaFromPayload, safeFxRedirectTarget} from '../auto-media.js';

const forwarded = (admin = 8355389673) => ({
  update_id: 1,
  message: {
    message_id: 1,
    chat: {id: admin, type: 'private'},
    from: {id: admin},
    text: 'First entry\nhttps://x.com/Simdavv/status/2108992018710245825',
    forward_origin: {type: 'user', sender_user: {id: 91, username: 'simdav'}},
  },
});

test('forwarded X previews are enriched with an allowed photo URL', async () => {
  const update = forwarded();
  const fetcher = async () => Response.json({code: 200, status: {media: {all: [
    {type: 'photo', url: 'https://pbs.twimg.com/media/meme.jpg?name=orig'},
  ]}}});
  const result = await enrichForwardedXMedia(update, {JOBBY_ADMIN_IDS: '8355389673'}, fetcher);
  assert.equal(result.message.photo[0].file_id, 'https://pbs.twimg.com/media/meme.jpg?name=orig');
  assert.equal(update.message.photo, undefined);
});

test('video chooses the highest bitrate MP4 and GIF becomes animation', () => {
  const video = fxMediaFromPayload({code: 200, status: {media: {all: [{type: 'video',
    url: 'https://video.twimg.com/low.mp4', formats: [
      {container: 'mp4', bitrate: 128000, url: 'https://video.twimg.com/low.mp4'},
      {container: 'mp4', bitrate: 832000, url: 'https://video.twimg.com/high.mp4'},
    ]}]}}});
  assert.deepEqual(video, {type: 'video', url: 'https://video.twimg.com/high.mp4'});
  assert.equal(fxMediaFromPayload({status: {media: {all: [
    {type: 'gif', url: 'https://video.twimg.com/meme.mp4'},
  ]}}}).type, 'animation');
  assert.equal(fxMediaFromPayload({status: {media: {all: [
    {type: 'photo', url: 'https://evil.example/meme.jpg'},
  ]}}}), null);
});

test('vxTwitter is used when the primary provider is unavailable', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('d.fxtwitter.com')) return new Response(null, {status: 503});
    if (url.includes('api.fxtwitter.com')) return new Response('blocked', {status: 403});
    return Response.json({user_screen_name: 'Simdavv', media_extended: [
      {type: 'image', url: 'https://pbs.twimg.com/media/fallback.jpg'},
    ]});
  };
  const result = await enrichForwardedXMedia(forwarded(), {JOBBY_ADMIN_IDS: '8355389673'}, fetcher);
  assert.equal(result.message.photo[0].file_id, 'https://pbs.twimg.com/media/fallback.jpg');
  assert.ok(calls.some(url => /api\.vxtwitter\.com\/Simdavv\/status\/2108992018710245825$/.test(url)));
});

test('direct-media redirect works without either JSON API', async () => {
  const fetcher = async url => {
    if (url.includes('d.fxtwitter.com')) return new Response(null, {status: 302,
      headers: {location: 'https://pbs.twimg.com/media/direct.jpg?name=orig'}});
    throw new Error('JSON API must not be called after a valid redirect');
  };
  const result = await enrichForwardedXMedia(forwarded(), {JOBBY_ADMIN_IDS: '8355389673'}, fetcher);
  assert.equal(result.message.photo[0].file_id, 'https://pbs.twimg.com/media/direct.jpg?name=orig');
});

test('FxEmbed video redirect is safely unwrapped and classified as video', async () => {
  const rawVideo = 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/meme.mp4?tag=12';
  const wrapper = `https://api.fxtwitter.com/2/go?url=${encodeURIComponent(rawVideo)}`;
  const fetcher = async () => new Response(null, {status: 302, headers: {location: wrapper}});
  const result = await enrichForwardedXMedia(forwarded(), {JOBBY_ADMIN_IDS: '8355389673'}, fetcher);
  assert.equal(result.message.video.file_id, rawVideo);
  assert.equal(result.message.photo, undefined);
  assert.equal(safeFxRedirectTarget('https://api.fxtwitter.com/2/go?url=https%3A%2F%2Fevil.example%2Fmeme.mp4'), '');
  assert.equal(safeFxRedirectTarget('https://evil.example/2/go?url=' + encodeURIComponent(rawVideo)), '');
});

test('non-admin and ordinary messages never call the external service', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json({}); };
  const nonAdmin = forwarded(44);
  assert.equal(await enrichForwardedXMedia(nonAdmin, {JOBBY_ADMIN_IDS: '8355389673'}, fetcher), nonAdmin);
  const ordinary = forwarded(); delete ordinary.message.forward_origin;
  assert.equal(await enrichForwardedXMedia(ordinary, {JOBBY_ADMIN_IDS: '8355389673'}, fetcher), ordinary);
  assert.equal(calls, 0);
});

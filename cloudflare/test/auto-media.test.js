import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enrichForwardedXMedia, fxMediaFromPayload} from '../auto-media.js';

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

test('non-admin and ordinary messages never call the external service', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json({}); };
  const nonAdmin = forwarded(44);
  assert.equal(await enrichForwardedXMedia(nonAdmin, {JOBBY_ADMIN_IDS: '8355389673'}, fetcher), nonAdmin);
  const ordinary = forwarded(); delete ordinary.message.forward_origin;
  assert.equal(await enrichForwardedXMedia(ordinary, {JOBBY_ADMIN_IDS: '8355389673'}, fetcher), ordinary);
  assert.equal(calls, 0);
});

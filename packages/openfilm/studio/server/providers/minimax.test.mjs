import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import minimax, { baseFor, polling, sniffMime } from './minimax.mjs';

const KEY = 'sk-cp-test-0123456789abcdef';
let server, base;
let reply = () => [404, {}];
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(call);
    const [status, body, type = 'application/json'] = await reply(call);
    res.writeHead(status, { 'content-type': type }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENFILM_MINIMAX_URL = base;
  polling.ms.video = 5;
});
after(() => {
  delete process.env.OPENFILM_MINIMAX_URL;
  server.close();
});

const ctx = (files = {}, signal = new AbortController().signal) => ({
  key: KEY, root: '/project', signal, say: () => {}, read: async (p) => files[p],
});

test('host routing picks api.minimax.cn for sk-cp- keys and respects MINIMAX_API_HOST', () => {
  const prev = process.env.MINIMAX_API_HOST;
  try {
    delete process.env.MINIMAX_API_HOST;
    assert.equal(baseFor('sk-cp-abc123'), 'https://api.minimax.cn');
    assert.equal(baseFor('sk-api-abc123'), 'https://api.minimax.io');
    process.env.MINIMAX_API_HOST = 'https://api.minimaxi.com/';
    assert.equal(baseFor('sk-api-abc123'), 'https://api.minimaxi.com');
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_API_HOST;
    else process.env.MINIMAX_API_HOST = prev;
  }
});

test('text-to-video submits to /v2/video_generation, polls, downloads, and returns receipt', async () => {
  seen.length = 0;
  let polls = 0;
  reply = (call) => {
    if (call.method === 'POST' && call.url.pathname === '/v2/video_generation') {
      return [200, { task_id: 'task-001', base_resp: { status_code: 0, status_msg: 'success' } }];
    }
    if (call.method === 'GET' && call.url.pathname === '/v2/query/video_generation/task-001') {
      polls += 1;
      if (polls < 2) return [200, { task: { status: 'processing' } }];
      return [200, { task: { status: 'succeeded', content: { url: `${base}/cdn/clip.mp4` } } }];
    }
    if (call.method === 'GET' && call.url.pathname === '/cdn/clip.mp4') {
      return [200, Buffer.from('fake-mp4-bytes'), 'video/mp4'];
    }
    return [404, {}];
  };
  const result = await minimax.run('video', {
    out: 'sh01-t1', prompt: 'Warm morning light over espresso cup', duration: 3, resolution: '720p', 'aspect-ratio': '16:9',
  }, ctx());
  const submit = seen.find((c) => c.method === 'POST');
  assert.equal(submit.headers.authorization, `Bearer ${KEY}`);
  const payload = JSON.parse(submit.body);
  assert.equal(payload.model, 'MiniMax-H3');
  assert.equal(payload.duration, 4);
  assert.equal(payload.resolution, '768P');
  assert.equal(payload.ratio, '16:9');
  assert.deepEqual(payload.content, [{ type: 'text', text: 'Warm morning light over espresso cup' }]);
  assert.equal(polls, 2);
  assert.equal(result.files[0].path, 'assets/video/sh01-t1.mp4');
  assert.equal(result.receipt.provider, 'minimax');
  assert.equal(result.receipt.model, 'MiniMax-H3');
  assert.equal(result.receipt.taskId, 'task-001');
  assert.equal(result.receipt.notes.length, 2);
});

test('first/last frames sniff real MIME bytes and omit ratio; mixing frames and refs rejects', async () => {
  seen.length = 0;
  reply = (call) => {
    if (call.method === 'POST') return [200, { task_id: 'task-002' }];
    if (call.url.pathname === '/v2/query/video_generation/task-002') {
      return [200, { task: { status: 'succeeded', content: { url: `${base}/cdn/clip.mp4` } } }];
    }
    return [200, Buffer.from('mp4'), 'video/mp4'];
  };
  /* JPEG bytes stored under a .png path */
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffMime(jpegBytes, 'assets/image/a.png'), 'image/jpeg');
  const files = { 'assets/image/a.png': jpegBytes, 'assets/image/b.png': jpegBytes };
  await minimax.run('video', {
    out: 'sh02-t1', prompt: 'Smooth transition', duration: 5, 'aspect-ratio': '16:9',
    'first-frame': 'assets/image/a.png', 'last-frame': 'assets/image/b.png',
  }, ctx(files));
  const payload = JSON.parse(seen.find((c) => c.method === 'POST').body);
  assert.equal('ratio' in payload, false);
  assert.equal(payload.content[1].role, 'first_frame');
  assert.match(payload.content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(payload.content[2].role, 'last_frame');

  await assert.rejects(minimax.run('video', {
    out: 'bad', prompt: 'mix', 'first-frame': 'assets/image/a.png', 'input-reference': ['assets/image/b.png'],
  }, ctx(files)), /cannot mix/);
});

test('base_resp balance and auth errors map to noBalance and clear auth messages', async () => {
  reply = () => [200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }];
  await assert.rejects(minimax.run('video', { out: 'x', prompt: 'hi' }, ctx()), (e) => e.code === 'balance');

  reply = () => [200, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } }];
  await assert.rejects(minimax.run('video', { out: 'x', prompt: 'hi' }, ctx()), /did not accept your key/);

  await assert.rejects(minimax.run('image', { out: 'x', prompt: 'hi' }, ctx()), /MiniMax does not do image/);
});

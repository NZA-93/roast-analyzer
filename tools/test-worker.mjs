// Worker smoke test with a mocked GitHub API: valid batch -> 201 + 3 files; junk -> 400; oversize -> 413; rate limit -> 429.
import assert from 'assert/strict';
import worker from '../worker/index.js';
import { makeRecord, BATCH_SCHEMA } from '../docs/js/swipe-core.js';
const puts = []; globalThis.fetch = async (url, init) => { puts.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 201 }); };
const kv = new Map(); const env = { GITHUB_TOKEN: 'x', RATE: { get: async k => kv.get(k), put: async (k, v) => kv.set(k, v) } };
const image = { name: 'a.jpg', sha256: 'b'.repeat(64), width: 100, height: 100 };
const bean = { id: 1, x: 10, y: 10, L: 40, glare: 0 };
const batch = { schema: BATCH_SCHEMA, id: 'abcdef-123', createdAt: '2026-10-17T10:00:00Z', image, beanRadius: 5, detectorVersion: '1.1.0', paramsHash: 'abcdef123456', params: {},
  answers: [makeRecord({ image, bean, detectorVersion: '1.1.0', paramsHash: 'abcdef123456', answer: 'correct', pick: 'random', R: 5 })], missed: [{ x: 50, y: 50 }] };
const post = (b, h = {}) => worker.fetch(new Request('https://w.example/batch', { method: 'POST', headers: { origin: 'https://nza-93.github.io', 'cf-connecting-ip': '1.2.3.4', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) }), env);
let r = await post(batch); assert.equal(r.status, 201); assert.equal(puts.length, 2); // raw + random (no targeted answers)
assert.ok(puts[0].url.includes('/contents/feedback/swipe/raw/')); assert.ok(puts[1].url.endsWith('-random.json'));
assert.equal((await post({ ...batch, answers: [{ ...batch.answers[0], answer: 'band:Dark' }] })).status, 400);
assert.equal((await post('x'.repeat(70000))).status, 413);
assert.equal((await post(batch, { origin: 'https://evil.example' })).status, 403);
for (let i = 0; i < 30; i++) await post({ ...batch, answers: [] }); assert.equal((await post(batch)).status, 429);
console.log('worker tests passed');

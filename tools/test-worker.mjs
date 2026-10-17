// Worker tests with a mocked GitHub API.
import assert from 'assert/strict';
import worker, { MAX_PER_HOUR } from '../worker/index.js';
import { makeRecord, BATCH_SCHEMA, KNOWN_IMAGES } from '../docs/js/swipe-core.js';
import jpeg from 'jpeg-js'; import { PNG } from 'pngjs'; import crypto from 'crypto';
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// --- fake GitHub: refs, contents, pulls ---
let gh; const resetGH = () => { gh = { refs: { main: 'sha-main' }, files: {}, prs: [], calls: [] }; };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), p = u.pathname.replace('/repos/NZA-93/roast-analyzer', ''), m = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
  gh.calls.push(`${m} ${p}`); const J = (s, j) => new Response(JSON.stringify(j), { status: s });
  let r;
  if (r = p.match(/^\/git\/ref\/heads\/(.+)$/)) return gh.refs[r[1]] ? J(200, { object: { sha: gh.refs[r[1]] } }) : J(404, {});
  if (p === '/git/refs' && m === 'POST') { gh.refs[body.ref.replace('refs/heads/', '')] = body.sha; return J(201, {}); }
  if (r = p.match(/^\/contents\/(.+)$/)) { const key = `${m === 'PUT' ? body.branch : u.searchParams.get('ref')}:${r[1]}`;
    if (m === 'GET') return gh.files[key] ? J(200, {}) : J(404, {}); if (gh.files[key]) return J(422, {}); gh.files[key] = body.content; return J(201, {}); }
  if (p === '/pulls' && m === 'GET') return J(200, gh.prs.filter(x => `NZA-93:${x.head}` === u.searchParams.get('head')));
  if (p === '/pulls' && m === 'POST') { const pr = { head: body.head, base: body.base, html_url: `https://github.com/NZA-93/roast-analyzer/pull/${10 + gh.prs.length}` }; gh.prs.push(pr); return J(201, pr); }
  return J(500, { p });
};
const mkKV = () => { const kv = new Map(); return { get: async k => kv.get(k), put: async (k, v) => kv.set(k, v) }; };
const env0 = () => ({ GITHUB_TOKEN: 'x', RATE: mkKV() });
const ORIGIN = 'https://nza-93.github.io';
const mk = (sha, extra = {}) => { const image = { name: 'a.jpg', sha256: sha, width: 400, height: 300, originalWidth: 4032, originalHeight: 3024, scale: +(400 / 4032).toFixed(6) }, bean = { id: 1, x: 10, y: 10, L: 40, a: 8, b: 20, glare: 0 };
  return { schema: BATCH_SCHEMA, id: 'abcdef-123', createdAt: '2026-10-17T10:00:00Z', image, beanRadius: 5, detectorVersion: '1.1.0', paramsHash: 'abcdef123456', params: {}, detectionsOnPlate: 50,
    colourPipelineVersion: 'wbplane-1+srgb-tone-1', colorSpace: 'srgb', wbGains: [1, 1, 1], gapTiles: [{ rect: [0, 0, 50, 50], gapArea: 100, stratum: 'dense', prob: 0.5, missed: 1 }], totalGapArea: 400, gapSelection: { method: 'stratified-random', seed: 1, strata: [{ name: 'dense', N: 2, k: 1 }] },
    answers: [makeRecord({ image, bean, detectorVersion: '1.1.0', paramsHash: 'abcdef123456', answer: 'correct', pick: 'random', R: 5 })], missed: [{ x: 30, y: 30 }], ...extra }; };
const post = (env, b, h = { origin: ORIGIN }) => worker.fetch(new Request('https://w.example/batch', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) }), env);
const known = KNOWN_IMAGES[0], unknown = 'e'.repeat(64);
const realJpeg = (w, h) => 'data:image/jpeg;base64,' + Buffer.from(jpeg.encode({ width: w, height: h, data: Buffer.alloc(w * h * 4, 180) }, 80).data).toString('base64');

await t('valid batch on a known photo -> branch + files under feedback/swipe/ + PR (never main)', async () => { resetGH(); const env = env0();
  const r = await post(env, mk(known)); const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j));
  assert.ok(gh.refs['swipe-feedback'], 'branch created'); assert.ok(j.files.every(f => f.startsWith('feedback/swipe/')));
  assert.ok(Object.keys(gh.files).every(k => k.startsWith('swipe-feedback:')), 'nothing written to main');
  assert.equal(gh.prs.length, 1); assert.equal(j.pr, gh.prs[0].html_url);
  const r2 = await post(env, mk(known, { id: 'second-batch', answers: [{ ...mk(known).answers[0], answer: 'skip' }] })); assert.equal(r2.status, 201); assert.equal(gh.prs.length, 1, 'PR reused'); });
await t('Origin required', async () => { resetGH(); assert.equal((await post(env0(), mk(known), {})).status, 403); assert.equal((await post(env0(), mk(known), { origin: 'https://evil.example' })).status, 403); });
await t('rate limit is mandatory and enforced', async () => { resetGH();
  assert.equal((await post({ GITHUB_TOKEN: 'x' }, mk(known))).status, 503);
  const env = env0(); for (let i = 0; i < MAX_PER_HOUR; i++) await post(env, { junk: 1 }); assert.equal((await post(env, mk(known))).status, 429); });
await t('unknown photo without image -> 422 with a clear message', async () => { resetGH(); const r = await post(env0(), mk(unknown)); assert.equal(r.status, 422); assert.match((await r.json()).detail, /send it with the answers/); });
await t('unknown photo with image -> photo stored, GT points at it', async () => { resetGH();
  const r = await post(env0(), mk(unknown, { photo: realJpeg(400, 300) })); const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j));
  const img = j.files.find(f => f.startsWith('feedback/images/')); assert.ok(img);
  const gt = JSON.parse(Buffer.from(gh.files[`swipe-feedback:${j.files.find(f => f.endsWith('-random.json'))}`], 'base64').toString()); assert.equal(gt.image.path, img);
  const raw = JSON.parse(Buffer.from(gh.files[`swipe-feedback:${j.files.find(f => f.includes('/raw/'))}`], 'base64').toString()); assert.equal(raw.photo, undefined, 'photo not duplicated in raw JSON');
  assert.equal(raw.image.originalSha256, unknown); assert.equal(raw.image.uploadedSha256, crypto.createHash('sha256').update(Buffer.from(realJpeg(400, 300).split(',')[1], 'base64')).digest('hex'));
  assert.equal(raw.image.scale, +(400 / 4032).toFixed(6)); assert.equal(gt.image.uploadedSha256, raw.image.uploadedSha256); });
await t('photo bytes validated: garbage, truncated, wrong size, tiny -> 422, nothing committed; PNG accepted', async () => {
  for (const [photo, re] of [['data:image/jpeg;base64,' + Buffer.from('not a jpeg').toString('base64'), /not a JPEG or PNG/], [realJpeg(400, 300).slice(0, -40), /truncated|broken/],
    [realJpeg(640, 480), /answers were made on 400×300/], [realJpeg(100, 75), /out of range/]]) { resetGH();
    const r = await post(env0(), mk(unknown, { photo })); assert.equal(r.status, 422); assert.match((await r.json()).detail, re); assert.equal(Object.keys(gh.files).length, 0); }
  resetGH(); const png = new PNG({ width: 400, height: 300 }); png.data.fill(200); const pu = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const r = await post(env0(), mk(unknown, { photo: pu })); assert.equal(r.status, 201); assert.ok((await r.json()).files.some(f => f.endsWith('.png'))); });
await t('photo without original size/scale fails schema', async () => { resetGH(); const b = mk(unknown, { photo: realJpeg(400, 300) }); delete b.image.scale; assert.equal((await post(env0(), b)).status, 400); });
await t('dedupe by content hash (same answers, new id) -> 409', async () => { resetGH(); const env = env0();
  assert.equal((await post(env, mk(known))).status, 201); assert.equal((await post(env, mk(known, { id: 'resent-copy', createdAt: '2026-10-17T10:00:09Z' }))).status, 409); });
await t('schema, nulls and size are rejected', async () => { resetGH();
  assert.equal((await post(env0(), mk(known, { answers: [{ ...mk(known).answers[0], rawA: null }] }))).status, 400);
  assert.equal((await post(env0(), mk(known, { answers: [{ ...mk(known).answers[0], answer: 'band:Dark' }] }))).status, 400);
  assert.equal((await post(env0(), 'x'.repeat(2e6))).status, 413); });
console.log(`\n${n} worker tests passed`);

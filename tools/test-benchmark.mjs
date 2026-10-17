// Benchmark/tuner: biased (targeted) swipe files are skipped; whole photos are held out of tuning and the gate.
import assert from 'assert/strict'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import { execFileSync, spawnSync } from 'child_process';
import jpeg from 'jpeg-js'; import { analyzeImage } from '../docs/js/analyzer.js'; import { makeGroundTruthFile, emptyCorrections } from '../docs/js/evaluate.js';
import { toGroundTruth, makeRecord, BATCH_SCHEMA } from '../docs/js/swipe-core.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-bench-')); fs.mkdirSync(path.join(dir, 'swipe'));
const load = n => { const buf = fs.readFileSync(new URL(`../docs/demo/${n}`, import.meta.url)); const img = jpeg.decode(buf, { useTArray: true }); return { buf, img, sha: crypto.createHash('sha256').update(buf).digest('hex'), r: analyzeImage(img, {}) }; };
const ph = [load('sample1.jpg'), load('sample2.jpg')];
ph.forEach((p, i) => { const image = { name: `sample${i + 1}.jpg`, sha256: p.sha, width: p.img.width, height: p.img.height, path: `docs/demo/sample${i + 1}.jpg` };
  fs.writeFileSync(path.join(dir, `full-${i + 1}.json`), JSON.stringify(makeGroundTruthFile({ image, detectorVersion: 't', params: {}, roi: null, detections: p.r.beans, corrections: emptyCorrections(), R: p.r.params.beanRadius })));
  // a swipe batch: 10 random cards correct, 10 targeted cards all "not a bean" (poison if it were used)
  const rec = (b, answer, reason, pick) => makeRecord({ image, bean: b, detectorVersion: 't', paramsHash: 'abcdef123456', answer, reason, pick, R: p.r.params.beanRadius });
  const batch = { schema: BATCH_SCHEMA, id: `bench-${i}`, image, beanRadius: p.r.params.beanRadius, detectorVersion: 't', paramsHash: 'abcdef123456', detectionsOnPlate: p.r.beans.length,
    answers: [...p.r.beans.slice(0, 10).map(b => rec(b, 'correct', null, 'random')), ...p.r.beans.slice(10, 20).map(b => rec(b, 'wrong', 'not-bean', 'targeted'))], missed: [], gapTiles: [{ rect: [0, 0, 400, 400], gapArea: 5000, stratum: 'dense', prob: 0.5, missed: 0 }], totalGapArea: 10000, missedScreenShown: true,
    gapSelection: { method: 'stratified-random', seed: 1, strata: [{ name: 'dense', N: 2, k: 1 }] } };
  for (const sub of ['random', 'targeted']) fs.writeFileSync(path.join(dir, 'swipe', `s${i}-${sub}.json`), JSON.stringify(toGroundTruth(batch, sub)));
  if (i === 1) fs.writeFileSync(path.join(dir, 'top-swipe.json'), JSON.stringify(toGroundTruth(batch, 'targeted'))); });
const run = (...a) => execFileSync('node', [new URL('./benchmark.mjs', import.meta.url).pathname, ...a], { env: { ...process.env, RA_FEEDBACK: dir }, encoding: 'utf8' });
const run2 = (env, ...a) => { const r = spawnSync('node', [new URL('./benchmark.mjs', import.meta.url).pathname, ...a], { env: { ...process.env, ...env }, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const plain = run('--dry'); console.log(plain.trim().split('\n').slice(0, 5).join('\n'));
assert.match(plain, /skip swipe\/s0-targeted\.json: biased/); assert.match(plain, /skipped biased: 2/);
assert.match(plain, /skip top-swipe\.json: swipe-review files belong in feedback\/swipe/);
assert.match(plain, /holdout: full-2\.json/); assert.match(plain, /F1 1 /, 'swipe files never enter F1');
assert.match(plain, /swipe 6ecd408b1be6 \(1 session\): precision 1 \(n=10, 95% 0\.\d+–1\) · Recall 100\.0% \(95% \d+\.\d–100\.0%, n=10, gaps checked 50%\)/, 'swipe recall reported as text via plateRecall');
// tuning refuses a single photo
const one = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-one-')); fs.copyFileSync(path.join(dir, 'full-1.json'), path.join(one, 'full-1.json'));
const r1 = run2({ RA_FEEDBACK: one }, '--tune', '--dry'); assert.equal(r1.code, 2); assert.match(r1.out, /REFUSING to tune: ground truth covers 1 photo/);
const c1 = run2({ RA_FEEDBACK: one }, '--ci', '--dry'); assert.equal(c1.code, 0); assert.match(c1.out, /gate only .* no tuning/); assert.doesNotMatch(c1.out, /better:/);
// per-photo gate: history says sample1 used to score 1.0 and now (per a fake history entry) we pretend it was higher on another photo
const fp = JSON.parse(plain.trim().split('\n').find(l => l.startsWith('{"dry"'))); const k1 = Object.keys(fp.perPhoto)[0];
const hist = path.join(dir, 'history.json'); const fpr = /fingerprint (\w+)/.exec(plain)[1];
fs.writeFileSync(hist, JSON.stringify([{ date: 'x', version: '1.1.0', gtFingerprint: fpr, f1: fp.f1, holdoutF1: fp.holdoutF1, perPhoto: { ...fp.perPhoto, [k1]: Math.min(1.5, fp.perPhoto[k1] + 0.03) } }]));
const g = run2({ RA_FEEDBACK: dir, RA_HISTORY: hist }, '--dry'); assert.match(g.out, /REGRESSION: per-photo F1 dropped > 2 points/);
fs.writeFileSync(hist, JSON.stringify([{ date: 'x', version: '1.1.0', gtFingerprint: fpr, f1: fp.f1, holdoutF1: fp.holdoutF1, perPhoto: { ...fp.perPhoto, [k1]: fp.perPhoto[k1] + 0.015 } }]));
assert.doesNotMatch(run2({ RA_FEEDBACK: dir, RA_HISTORY: hist }, '--dry').out, /REGRESSION/, '1.5-point drop is allowed');
const tuned = run('--tune', '--dry'); const j = JSON.parse(tuned.trim().split('\n').find(l => l.startsWith('{"dry"')));
assert.deepEqual(j.holdout, ['full-2.json']); assert.equal(j.skippedBiased, 2); assert.equal(j.holdoutF1, 1);
console.log('benchmark tests passed (swipe reported via shared plateRecall, biased skipped, tune refuses <2 photos (--ci gate-only), per-photo 2-point gate, holdout)');

// Benchmark/tuner: biased (targeted) swipe files are skipped; whole photos are held out of tuning and the gate.
import assert from 'assert/strict'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import { execFileSync } from 'child_process';
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
    answers: [...p.r.beans.slice(0, 10).map(b => rec(b, 'correct', null, 'random')), ...p.r.beans.slice(10, 20).map(b => rec(b, 'wrong', 'not-bean', 'targeted'))], missed: [], gapTiles: [], totalGapArea: 0, missedScreenShown: true };
  for (const sub of ['random', 'targeted']) fs.writeFileSync(path.join(dir, 'swipe', `s${i}-${sub}.json`), JSON.stringify(toGroundTruth(batch, sub))); });
const run = (...a) => execFileSync('node', [new URL('./benchmark.mjs', import.meta.url).pathname, ...a], { env: { ...process.env, RA_FEEDBACK: dir }, encoding: 'utf8' });
const plain = run('--dry'); console.log(plain.trim().split('\n').slice(0, 4).join('\n'));
assert.match(plain, /skip swipe\/s0-targeted\.json: biased/); assert.match(plain, /skipped biased: 2/);
assert.match(plain, /holdout: full-2\.json, swipe\/s1-random\.json/, 'sample2 (whole photo, all its files) is held out');
assert.match(plain, /F1 1 /, 'random swipe answers agree with the detector; poison targeted answers ignored');
const tuned = run('--tune', '--dry'); const j = JSON.parse(tuned.trim().split('\n').find(l => l.startsWith('{"dry"')));
assert.deepEqual(j.holdout, ['full-2.json', 'swipe/s1-random.json']); assert.equal(j.skippedBiased, 2); assert.equal(j.holdoutF1, 1);
console.log('benchmark tests passed (biased skipped, per-photo holdout in tuner + gate)');

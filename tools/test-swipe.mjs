// Swipe review tests: recorded batch -> ground-truth JSON -> score() gives the expected TP/FP/FN,
// random and targeted answers land in separate scores, selection is 70/30 and the schema check rejects junk.
import assert from 'assert/strict';
import { toGroundTruth, scoreBatch, selectCards, validateBatch, makeRecord, BATCH_SCHEMA, estimatedMisses, reviewedShare, contentHash } from '../docs/js/swipe-core.js';
import { loadTruth, score, GT_SCHEMA } from '../docs/js/evaluate.js';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const R = 10, sha = 'a'.repeat(64), ver = '1.1.0', ph = 'abcdef123456';
// 12 detections on a grid, 60 px apart
const dets = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, x: 50 + 60 * (i % 4), y: 50 + 60 * Math.floor(i / 4), conf: i / 12, sizeRatio: 1, L: 40, Lraw: 40, a: 8, b: 20, glare: 0.01 }));
const image = { name: 'synthetic.jpg', sha256: sha, width: 400, height: 300 };
const rec = (id, answer, reason, pick, extra = {}) => makeRecord({ image, bean: dets[id - 1], sibling: dets[id], detectorVersion: ver, paramsHash: ph, answer, reason, pick, R, ...extra });
const answers = [
  rec(1, 'correct', null, 'random'), rec(2, 'correct', null, 'random'), rec(3, 'wrong', 'not-bean', 'random'), rec(4, 'wrong', 'wrong-colour', 'random'),
  rec(5, 'skip', null, 'random'),
  rec(6, 'correct', null, 'targeted'), rec(7, 'wrong', 'unspecified', 'targeted'), rec(8, 'wrong', 'two-beans', 'targeted', { mergeN: 2 }),
  rec(9, 'wrong', 'part-of-bean', 'targeted'), rec(10, 'wrong', 'two-beans', 'targeted', { mergeN: '4+' }),
  rec(11, 'wrong', 'not-bean', 'targeted'), rec(11, 'correct', null, 'targeted'), // undo/re-answer: last wins
];
const batch = { schema: BATCH_SCHEMA, id: 'test-batch-1', createdAt: '2026-10-17T12:00:00+02:00', image, beanRadius: R, detectorVersion: ver, paramsHash: ph, params: {},
  answers, missed: [{ x: 380, y: 280 }, { x: 20, y: 280 }], missedScreenShown: true, detectionsOnPlate: 12,
  colourPipelineVersion: 'wbplane-1+srgb-tone-1', colorSpace: 'srgb', wbGains: [1.1, 1, 0.9], gapTiles: [{ rect: [0, 0, 400, 300], gapArea: 1000, missed: 2 }], totalGapArea: 1000 };

t('batch passes schema', () => assert.deepEqual(validateBatch(batch), []));

t('all answers -> GT JSON -> score() expected TP/FP/FN', () => {
  const gt = toGroundTruth(batch, 'all');
  assert.equal(gt.schema, GT_SCHEMA);
  const json = JSON.parse(JSON.stringify(gt));               // round-trip like a committed feedback/ file
  const m = score(loadTruth(json), dets, R, json.roi);
  // in scope: 1,2,3,4,6,7,8,9,11 (5 skipped, 10 = merge 4+ excluded, 12 never shown) + 2 missed taps
  // truth: 1,2,4,6,11 (TP) + 8 x2 (merge) + 2 added = 9 ; detections in scope 9 ; TP = 1,2,4,6,8,11 = 6
  assert.equal(m.detected, 9); assert.equal(m.truth, 9);
  assert.equal(m.tp, 6); assert.equal(m.fp, 3); assert.equal(m.fn, 3);   // FP = 3 not-bean, 7 unspecified, 9 split ; FN = 2nd merge bean + 2 missed
  assert.equal(gt.colourFlags.length, 1); assert.equal(gt.corrections.band.length, 0);
  assert.ok(gt.excluded.some(e => e.why === 'merge 4+'));
});

t('random vs targeted scored separately; count error not computed', () => {
  const s = scoreBatch(batch, dets);
  // random: 1,2,3,4 reviewed (5 skipped) -> TP 3 (1,2,4), FP 1 (3)
  assert.deepEqual([s.random.tp, s.random.fp], [3, 1]); assert.equal(s.random.precision, 0.75);
  // targeted: 6,7,8,9,11 (10 = 4+ excluded) -> TP 3 (6,8,11), FP 2 (7 unspecified, 9 split)
  assert.deepEqual([s.targeted.tp, s.targeted.fp], [3, 2]); assert.equal(s.targeted.precision, 0.6);
  assert.equal(s.all.tp, s.random.tp + s.targeted.tp);
  assert.equal(toGroundTruth(batch, 'targeted').source.biased, true);
  for (const k of ['random', 'targeted', 'all']) assert.equal(s[k].countError, null);
  // recall from the random precision over the whole plate: 12 × 0.75 = 9 TP vs 2 misses
  assert.equal(s.random.recall, +(9 / 11).toFixed(4));
});

t('Critic case: 100 detections, 2 misses, 6 random cards all correct -> recall 0.98', () => {
  const d = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, x: 20 + 30 * (i % 10), y: 20 + 30 * Math.floor(i / 10), L: 40, a: 8, b: 20, glare: 0 }));
  const img = { name: 'p.jpg', sha256: 'c'.repeat(64), width: 400, height: 400 };
  const ans = d.slice(0, 6).map(b => makeRecord({ image: img, bean: b, detectorVersion: ver, paramsHash: ph, answer: 'correct', pick: 'random', R }));
  const bt = { ...batch, image: img, answers: ans, missed: [{ x: 390, y: 5 }, { x: 5, y: 390 }], detectionsOnPlate: 100, gapTiles: [{ rect: [0, 0, 400, 400], gapArea: 500, missed: 2 }], totalGapArea: 500 };
  assert.deepEqual(validateBatch(bt), []);
  const s = scoreBatch(bt, d); assert.equal(s.random.precision, 1); assert.equal(+s.random.recall.toFixed(2), 0.98); assert.equal(s.random.countError, null);
});

t('misses scaled by the reviewed gap share', () => {
  const bt = { ...batch, gapTiles: [{ rect: [0, 0, 100, 100], gapArea: 250, missed: 2 }], totalGapArea: 1000 };
  assert.equal(reviewedShare(bt), 0.25); assert.equal(estimatedMisses(bt), 8);
  const s = scoreBatch(bt, dets); assert.equal(s.missesEstimated, 8); assert.equal(s.random.recall, +(9 / 17).toFixed(4)); // 12×0.75 = 9 TP vs 8 est. misses
  assert.equal(toGroundTruth(bt, 'random').source.reviewedShare, 0.25);
});

t('records carry raw L*/a*/b*, glare; schema refuses nulls; colour pipeline stored', async () => {
  const a0 = answers[0]; assert.equal(a0.rawA, 8); assert.equal(a0.rawB, 20); assert.equal(a0.rawL, 40);
  for (const k of ['rawL', 'rawA', 'rawB', 'glare']) assert.ok(validateBatch({ ...batch, answers: [{ ...a0, [k]: null }] }).includes('answers[0]'), k);
  assert.ok(validateBatch({ ...batch, wbGains: null }).length); assert.ok(validateBatch({ ...batch, colourPipelineVersion: undefined }).length);
  assert.equal(toGroundTruth(batch).source.colourPipelineVersion, 'wbplane-1+srgb-tone-1');
  const src = toGroundTruth(batch).source; assert.equal(src.colorSpace, 'srgb'); assert.deepEqual(src.wbGains, [1.1, 1, 0.9]);
  assert.ok(validateBatch((({ colorSpace, ...b }) => b)(batch)).includes('colorSpace')); assert.ok(validateBatch({ ...batch, colorSpace: 'display-p3-lies' }).includes('colorSpace'));
  assert.deepEqual(validateBatch({ ...batch, colorSpace: 'display-p3' }), []);
  const noGlare = makeRecord({ image, bean: { id: 99, x: 5, y: 5, L: 40, a: 1, b: 1 }, detectorVersion: ver, paramsHash: ph, answer: 'correct', pick: 'random', R });
  assert.equal(noGlare.glare, undefined); assert.ok(validateBatch({ ...batch, answers: [noGlare] }).includes('answers[0]'), 'missing glare is rejected, not defaulted');
});

t('selection: 70% targeted / 30% random, tagged, most uncertain first', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, x: i, y: i, conf: i / 100, sizeRatio: 1, L: 40 }));
  const c = selectCards(many, 20, { seed: 7 });
  assert.equal(c.length, 20); assert.equal(c.filter(x => x.pick === 'targeted').length, 14); assert.equal(c.filter(x => x.pick === 'random').length, 6);
  assert.equal(new Set(c.map(x => x.id)).size, 20);
  const tIds = c.filter(x => x.pick === 'targeted').map(x => x.id); assert.ok(Math.max(...tIds) <= 14, 'targeted = lowest confidence');
  assert.deepEqual(selectCards(many, 20, { seed: 7 }), c, 'reproducible from seed');
});

t('schema rejects bad batches', () => {
  assert.ok(validateBatch({ ...batch, answers: [] }).length);
  assert.ok(validateBatch({ ...batch, image: { ...image, sha256: 'x' } }).length);
  assert.ok(validateBatch({ ...batch, answers: [{ ...answers[0], answer: 'band:Light' }] }).length);
  assert.ok(validateBatch({ ...batch, missed: [{ x: 9999, y: 1 }] }).length);
});
const h1 = await contentHash(batch), h2 = await contentHash({ ...batch, id: 'other-id-2', createdAt: 'x' }); assert.equal(h1, h2); n++; console.log('ok - content hash ignores id/time (dedupe)');
console.log(`\n${n} tests passed`);

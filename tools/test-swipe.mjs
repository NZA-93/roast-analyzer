// Swipe review tests: recorded batch -> ground-truth JSON -> score() gives the expected TP/FP/FN,
// random and targeted answers land in separate scores, selection is 70/30 and the schema check rejects junk.
import assert from 'assert/strict';
import { toGroundTruth, scoreBatch, selectCards, validateBatch, makeRecord, BATCH_SCHEMA, estimatedMisses, reviewedShare, contentHash } from '../docs/js/swipe-core.js';
import { plateRecall, wilson, RECALL_MIN_RANDOM, RECALL_MIN_SHARE, recallText, sessionMisses } from '../docs/js/evaluate.js';
import { pooledRecall, poolSessions } from '../docs/js/swipe-core.js';
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
  colourPipelineVersion: 'wbplane-1+srgb-tone-1', colorSpace: 'srgb', wbGains: [1.1, 1, 0.9], gapTiles: [{ rect: [0, 0, 400, 300], gapArea: 1000, stratum: 'dense', prob: 1, missed: 2 }], totalGapArea: 1000,
  gapSelection: { method: 'stratified-random', seed: 1, strata: [{ name: 'dense', N: 1, k: 1 }] } };

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
  // only 4 random cards: recall is withheld, never filled in from targeted precision
  assert.equal(s.random.recall, null); assert.match(s.recall.reason, /only 4 random cards/);
});

t('misses scaled by inclusion probability; share null for zero gap area', () => {
  const bt = { ...batch, gapTiles: [{ rect: [0, 0, 100, 100], gapArea: 250, stratum: 'dense', prob: 0.25, missed: 2 }], totalGapArea: 1000 };
  assert.equal(reviewedShare(bt), 0.25); assert.equal(estimatedMisses(bt), 8); assert.equal(reviewedShare({ ...bt, totalGapArea: 0 }), null);
  assert.equal(toGroundTruth(bt, 'random').source.reviewedShare, 0.25); assert.equal(toGroundTruth(bt, 'random').source.gapTiles[0].prob, 0.25);
  assert.ok(validateBatch({ ...bt, gapTiles: [{ ...bt.gapTiles[0], prob: undefined }] }).includes('gapTiles'));
});
const plate = (nRandom, o = {}) => { const d = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, x: 20 + 30 * (i % 10), y: 20 + 30 * Math.floor(i / 10), L: 40, a: 8, b: 20, glare: 0 }));
  const img = { name: 'p.jpg', sha256: 'c'.repeat(64), width: 400, height: 400 };
  const ans = d.slice(0, nRandom).map(b => makeRecord({ image: img, bean: b, detectorVersion: ver, paramsHash: ph, answer: 'correct', pick: 'random', R }));
  return [{ ...batch, image: img, answers: ans, missed: [{ x: 390, y: 5 }, { x: 5, y: 390 }], detectionsOnPlate: 100, gapTiles: [{ rect: [0, 0, 400, 400], gapArea: 500, stratum: 'dense', prob: 1, missed: 2 }], totalGapArea: 500, ...o }, d]; };
t('Critic case: 100 detections, 2 misses, full gap review, 10 random cards all correct -> recall 0.98 with interval', () => {
  const [bt, d] = plate(10); assert.deepEqual(validateBatch(bt), []);
  const s = scoreBatch(bt, d); assert.equal(s.random.precision, 1); assert.equal(+s.random.recall.toFixed(2), 0.98); assert.equal(s.random.countError, null);
  assert.equal(s.recall.confidence, 'ok'); assert.equal(s.recall.nRandom, 10); assert.ok(s.recall.ci[0] < 0.98 && s.recall.ci[1] >= 0.98);
});
t('recall withheld: 6 random cards, tiny gap share, zero gap area, no random cards', () => {
  const [b6, d] = plate(6); assert.equal(scoreBatch(b6, d).random.recall, null);
  const [bs] = plate(10, { gapTiles: [{ rect: [0, 0, 8, 8], gapArea: 10, stratum: 'dense', prob: 0.01, missed: 0 }], missed: [], totalGapArea: 100000 }); const ss = scoreBatch(bs, d);
  assert.equal(ss.random.recall, null); assert.match(ss.recall.reason, /cover 0\.0% of the gap area/);
  const [bz] = plate(10, { gapTiles: [], missed: [], totalGapArea: 0 }); const sz = scoreBatch(bz, d); assert.equal(sz.reviewedShare, null); assert.equal(sz.random.recall, null);
  const [b0] = plate(0); const tg = d.slice(0, 8).map(b => makeRecord({ image: b0.image, bean: b, detectorVersion: ver, paramsHash: ph, answer: 'correct', pick: 'targeted', R }));
  assert.equal(scoreBatch({ ...b0, answers: tg }, d).random.recall, null, 'no fallback to targeted precision');
});
t('Wilson interval + Horvitz–Thompson scaling by inclusion probability', () => {
  const [lo, hi] = wilson(9, 10); assert.ok(lo > 0.59 && lo < 0.6 && hi > 0.98);
  const r = plateRecall({ tpRandom: 10, nRandom: 10, detections: 100, sessions: [{ tiles: [{ rect: [0, 0, 1, 1], gapArea: 300, prob: 0.25, missed: 1 }, { rect: [1, 0, 2, 1], gapArea: 200, prob: 0.5, missed: 1 }], totalGapArea: 1000 }] });
  assert.equal(r.missesEstimated, 6); assert.equal(r.recall, +(100 / 106).toFixed(4)); assert.equal(r.share, 0.5);
  assert.equal(plateRecall({ tpRandom: 10, nRandom: 10, detections: 100, sessions: [{ tiles: [{ rect: [0, 0, 1, 1], gapArea: 500, missed: 1 }], totalGapArea: 1000 }] }).recall, null, 'missing probabilities -> null');
  assert.equal(RECALL_MIN_RANDOM, 10);
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
// synthetic plate shared by the gap-tile tests: dense centre, sparse rim, empty plate around
const { gapTiles } = await import('../docs/js/swipe.js');
const plateS = (() => { const W = 900, H = 900, beans = []; let id = 1;
  for (let y = 5; y < H; y += 20) for (let x = 5; x < W; x += 20) { const r = Math.hypot(x - 450, y - 450); if (r < 360 && ((x * 7 + y * 13) % 100) < (r < 200 ? 90 : r < 300 ? 50 : 15)) beans.push({ id: id++, x, y }); }
  const labelMap = new Int32Array(W * H); beans.forEach(b => { for (let yy = b.y - 7; yy <= b.y + 7; yy++) for (let xx = b.x - 7; xx <= b.x + 7; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) labelMap[yy * W + xx] = b.id; });
  return { width: W, height: H, beans, labelMap, params: { beanRadius: 10 } }; })();
t('gap tiles: 4 strata incl. empty plate, independent draws, prob = k/N, schema enforces it', () => {
  const g = gapTiles(plateS, 4, 3); assert.equal(g.tiles.length, 4); assert.equal(g.selection.method, 'stratified-random');
  assert.deepEqual(g.selection.strata.map(x => x.name), ['empty plate', 'sparse/rim', 'medium', 'dense']);
  for (const t2 of g.tiles) { const st = g.selection.strata.find(x => x.name === t2.stratum); assert.equal(t2.prob, +(st.k / st.N).toFixed(6)); }
  assert.notDeepEqual(gapTiles(plateS, 4, 4).tiles.map(t2 => t2.rect), g.tiles.map(t2 => t2.rect), 'random, not the 4 largest');
  const bt = { ...batch, image: { ...image, width: 900, height: 900 }, gapTiles: g.tiles.map(t2 => ({ ...t2, missed: 0 })), missed: [], totalGapArea: g.total, gapSelection: g.selection };
  assert.deepEqual(validateBatch(bt), []);
  assert.ok(validateBatch({ ...bt, gapTiles: bt.gapTiles.map((t2, i) => i ? t2 : { ...t2, prob: Math.min(1, t2.prob * 2) }) }).some(e => /k\/N/.test(e)), 'wrong prob rejected');
  assert.ok(validateBatch({ ...bt, gapTiles: bt.gapTiles.slice(1), gapSelection: g.selection }).some(e => /k\/N/.test(e)), 'tile count must equal k');
});
t('HT unbiased with UNEVEN misses inside strata (single session and pooled average)', () => {
  // ground truth: misses concentrated in a few tiles of each stratum (0 in most, up to 5 in some)
  const all = gapTiles(plateS, 9999, 1).tiles, truth = new Map(all.map((t2, i) => [t2.rect.join(','), (i * 7919) % 11 === 0 ? 1 + (i % 5) : 0]));
  const trueTotal = [...truth.values()].reduce((a, b) => a + b, 0); assert.ok(trueTotal > 5);
  const est = seed => { const g = gapTiles(plateS, 4, seed); return { tiles: g.tiles.map(t2 => ({ ...t2, missed: truth.get(t2.rect.join(',')) })), totalGapArea: g.total }; };
  const N = 3000; let one = 0, pooled = 0;
  for (let k = 1; k <= N; k++) { one += sessionMisses(est(k).tiles); const a = est(N + 2 * k), b = est(N + 2 * k + 1); pooled += (sessionMisses(a.tiles) + sessionMisses(b.tiles)) / 2; }
  assert.ok(Math.abs(one / N - trueTotal) / trueTotal < 0.06, `single-session mean ${one / N} vs truth ${trueTotal}`);
  assert.ok(Math.abs(pooled / N - trueTotal) / trueTotal < 0.05, `pooled mean ${pooled / N} vs truth ${trueTotal}`);
  // and a deliberately biased estimator (ignoring prob, scaling by share) does NOT pass this test -> the test can fail
  let naive = 0; for (let k = 1; k <= N; k++) { const e = est(k), sh = e.tiles.reduce((a, t2) => a + t2.gapArea, 0) / e.totalGapArea; naive += e.tiles.reduce((a, t2) => a + t2.missed, 0) / sh; }
  assert.ok(Math.abs(naive / N - trueTotal) / trueTotal > 0.06, `naive estimator should be off (got ${naive / N} vs ${trueTotal})`);
});
t('pooling: same sha + detector version + params; union coverage; mean HT; random cards pooled; first duplicate wins', () => {
  const mkB = (seed, id, extra = {}) => { const g = gapTiles(plateS, 4, seed); const img = { ...image, width: 900, height: 900 };
    const ans = plateS.beans.slice(seed * 4, seed * 4 + 4).map(b => makeRecord({ image: img, bean: { ...b, L: 40, a: 8, b: 20, glare: 0 }, detectorVersion: ver, paramsHash: ph, answer: 'correct', pick: 'random', R }));
    return { ...batch, id, image: img, answers: ans, detectionsOnPlate: plateS.beans.length, gapTiles: g.tiles.map(t2 => ({ ...t2, missed: 0 })), missed: [], totalGapArea: g.total, gapSelection: g.selection, ...extra }; };
  const b1 = mkB(1, 'b-1'), b2 = mkB(2, 'b-2'), b3 = mkB(3, 'b-3'), other = mkB(4, 'b-4', { paramsHash: 'ffffff000000' });
  const groups = poolSessions([b1, b2, b3, other, { ...b1 }]); assert.equal(groups.length, 2);
  const g = groups.find(x => x.key.endsWith(ph)); assert.equal(g.batches, 3, 'duplicate id ignored, other params in another group'); assert.equal(g.nRandom, 12);
  const share1 = plateRecall({ tpRandom: 4, nRandom: 4, detections: 100, sessions: g.sessions.slice(0, 1) }).share, shareAll = plateRecall({ tpRandom: 4, nRandom: 4, detections: 100, sessions: g.sessions }).share;
  assert.ok(shareAll > share1, 'coverage grows with sessions (union of distinct tiles)');
  const pr = pooledRecall([b1, b2, b3]); assert.equal(pr.length, 1); assert.equal(pr[0].nRandom, 12);
  // grow sessions until coverage ≥ RECALL_MIN_SHARE: recall then becomes available
  const bs = [b1]; let k = 10; while ((pooledRecall(bs)[0].share ?? 0) < RECALL_MIN_SHARE && bs.length < 20) bs.push(mkB(k, `b-${k++}`));
  const fin = pooledRecall(bs)[0]; assert.ok(fin.share >= RECALL_MIN_SHARE); assert.notEqual(fin.recall, null); assert.equal(fin.sessions, bs.length);
  console.log(`   (coverage ${Math.round(pooledRecall([b1])[0].share * 100)}% after 1 session, ${Math.round(fin.share * 100)}% after ${bs.length}; ${recallText(fin)})`);
});
t('recall text is plain, wide intervals flagged', () => {
  assert.equal(recallText({ recall: null, nRandom: 6, share: 0.12 }), 'Recall: not enough answers yet (n=6, gaps checked 12%)');
  assert.match(recallText({ recall: 0.98, ci: [0.9, 1], nRandom: 12, share: 0.3, wide: false }), /^Recall 98\.0% \(95% 90\.0–100\.0%, n=12, gaps checked 30%\)$/);
  assert.match(recallText({ recall: 0.9, ci: [0.6, 1], nRandom: 12, share: 0.3, wide: true }), /wide interval/);
  const r = plateRecall({ tpRandom: 10, nRandom: 10, detections: 100, sessions: [{ tiles: [{ rect: [0, 0, 1, 1], gapArea: 300, prob: 0.05, missed: 2 }], totalGapArea: 1000 }] });
  assert.equal(r.wide, true); assert.equal(RECALL_MIN_SHARE, 0.20);
});
console.log(`\n${n} tests passed`);

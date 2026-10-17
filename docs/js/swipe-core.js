// Swipe review: pure logic shared by the page (docs/js/swipe.js), the Cloudflare Worker (worker/) and the tests.
// No DOM here. A "batch" is what one review session produces; toGroundTruth() turns it into the existing
// roast-analyzer/ground-truth@1 files that tools/benchmark.mjs and score() already read.
import { GT_SCHEMA, makeGroundTruthFile, emptyCorrections, loadTruth, score } from './evaluate.js';

export const BATCH_SCHEMA = 'roast-analyzer/swipe-batch@1';
export const ANSWERS = ['correct', 'wrong', 'skip'];
export const REASONS = ['not-bean', 'two-beans', 'part-of-bean', 'wrong-colour', 'unspecified'];
export const LIMITS = { maxAnswers: 200, maxMissed: 200, maxTiles: 6, maxBytes: 64 * 1024, maxPhotoBytes: 1536 * 1024 };
export const COLOUR_PIPELINE_VERSION = 'wbplane-1+srgb-tone-1'; // flat-field/white-balance model + fixed crop tone curve
// sha256 of the photos the repo already has (docs/demo). Batches on any other photo must carry the photo.
export const KNOWN_IMAGES = ['6ecd408b1be6a552b40bc8a2721828246af60a607cac7db4ba0921ef8bdda076', '1080e0ed3e36e6ee47ace656d37569cadd0c43d23488653bafc58a8cd8d84283',
  'd6af52a34d35e2970f44a0a4a5a94eae5d49451dc5009fd5a458c97b79745156', '0768602e9d747af19940ffb82641455642d78f6c89b7efa94cbcb5d5de777eff'];
export const TARGET_SHARE = 0.7;

// Seeded PRNG so a session's card order is reproducible from its seed (recorded in the batch).
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// How "uncertain" a detection is: low detector confidence, size far from typical, colour far from the batch.
export function uncertainty(b, ctx) {
  const conf = b.conf ?? 0.5;
  const size = Math.min(1, Math.abs(Math.log(b.sizeRatio ?? 1)) / Math.log(2));
  const band = ctx.madL ? Math.min(1, Math.abs((b.Lraw ?? b.L) - ctx.medL) / (4 * ctx.madL)) : 0;
  return +(0.5 * (1 - conf) + 0.3 * size + 0.2 * band).toFixed(4);
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// Pick n cards: ~70% the most uncertain beans, ~30% uniformly random from the rest, interleaved so the random ones
// are not all at the end. Each pick is tagged 'targeted' or 'random'. exclude = bean ids already answered.
export function selectCards(beans, n = 20, { seed = 1, exclude = [] } = {}) {
  const pool = beans.filter(b => !exclude.includes(b.id)); if (!pool.length) return [];
  n = Math.min(n, pool.length);
  const Ls = pool.map(b => b.Lraw ?? b.L), medL = med(Ls), madL = med(Ls.map(v => Math.abs(v - medL))) * 1.4826;
  const scored = pool.map(b => ({ b, u: uncertainty(b, { medL, madL }) })).sort((x, y) => y.u - x.u);
  const nT = Math.round(n * TARGET_SHARE), targeted = scored.slice(0, nT);
  const rest = scored.slice(nT), r = rng(seed);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const random = rest.slice(0, n - nT);
  const out = []; let ti = 0, ri = 0;
  for (let k = 0; k < n; k++) { const wantRandom = ri < random.length && (ti >= targeted.length || (k + 1) * (1 - TARGET_SHARE) > ri + 0.5);
    if (wantRandom) out.push({ id: random[ri].b.id, pick: 'random', u: random[ri++].u }); else out.push({ id: targeted[ti].b.id, pick: 'targeted', u: targeted[ti++].u }); }
  return out;
}

// Nearest other detection within 2.2 R: shown ringed on "Part of bean" cards so the fragments are linked.
export function siblingOf(bean, beans, R) {
  let best = null, bd = (2.2 * R) ** 2;
  for (const o of beans) { if (o.id === bean.id) continue; const d = (o.x - bean.x) ** 2 + (o.y - bean.y) ** 2; if (d < bd) { bd = d; best = o; } }
  return best;
}

// One answer record. Everything needed to rescore it later against a newer detector.
export function makeRecord({ image, bean, sibling, detectorVersion, paramsHash, answer, reason = null, mergeN = null, pick, R }) {
  const rec = { imageSha256: image.sha256, beanId: bean.id, x: Math.round(bean.x), y: Math.round(bean.y), r: R ? +R.toFixed(2) : undefined, detectorVersion, paramsHash,
    answer, reason: answer === 'wrong' ? (reason || 'unspecified') : null, pick, rawL: +(bean.Lraw ?? bean.L).toFixed(2), rawA: +(bean.araw ?? bean.a).toFixed(2), rawB: +(bean.braw ?? bean.b).toFixed(2), glare: bean.glare ?? 0, ts: new Date().toISOString() };
  if (rec.reason === 'two-beans') rec.mergeN = mergeN === '4+' ? '4+' : Math.max(2, Math.min(3, mergeN | 0 || 2));
  if (rec.reason === 'part-of-bean' && sibling) rec.sibling = { id: sibling.id, x: Math.round(sibling.x), y: Math.round(sibling.y) };
  if (rec.reason === 'wrong-colour') rec.colourFlag = true; // a flag for glare/shadow analysis — never a band label
  return rec;
}

// Latest answer per bean wins (undo + re-queue of 'unspecified' beans can produce several).
export function latestAnswers(answers) { const m = new Map(); for (const a of answers) m.set(a.beanId, a); return [...m.values()]; }

// Batch -> ground-truth files. subset: 'random' | 'targeted' | 'all'. Missed-bean taps (FN) go with 'random' and 'all'
// (the gaps screen covers the whole plate, so its taps are not biased by the card selection).
// Mapping:  correct -> TP · not-bean / unspecified -> FP · two-beans n -> merged n (4+ left out of the scope, so it never
// touches count error) · part-of-bean -> split · wrong-colour -> still a bean (TP), colour flag only · skip -> unlabelled (out of scope).
export function toGroundTruth(batch, subset = 'all') {
  const R = batch.beanRadius, tol = Math.max(3, R * 0.6);
  const ans = latestAnswers(batch.answers).filter(a => a.answer !== 'skip' && (subset === 'all' || a.pick === subset));
  const corr = emptyCorrections(); const dets = [], scope = [], colourFlags = [], excluded = [];
  for (const a of ans) {
    const p = { x: a.x, y: a.y };
    if (a.answer === 'wrong' && a.reason === 'two-beans' && a.mergeN === '4+') { excluded.push({ ...p, why: 'merge 4+' }); continue; }
    dets.push(p); scope.push([a.x, a.y]);
    if (a.answer === 'correct') continue;
    if (a.reason === 'not-bean' || a.reason === 'unspecified') corr.falsePos.push({ ...p, reason: a.reason === 'not-bean' ? 'other' : 'unspecified' });
    else if (a.reason === 'two-beans') corr.merged.push({ ...p, n: a.mergeN });
    else if (a.reason === 'part-of-bean') corr.split.push({ ...p, ...(a.sibling ? { sibling: [a.sibling.x, a.sibling.y] } : {}) });
    else if (a.reason === 'wrong-colour') colourFlags.push({ ...p, rawL: a.rawL, rawA: a.rawA, rawB: a.rawB, glare: a.glare });
  }
  if (subset !== 'targeted') for (const m of batch.missed || []) { corr.added.push({ x: m.x, y: m.y }); scope.push([m.x, m.y]); }
  const gt = makeGroundTruthFile({ image: batch.image, detectorVersion: batch.detectorVersion, params: batch.params || {}, roi: scope.length ? { points: scope, r: tol } : { points: [], r: tol },
    detections: dets, corrections: corr, R, detectedCount: dets.length,
    note: `Swipe review ${batch.id} (${subset}): ${ans.length} answers, ${(batch.missed || []).length} missed-bean taps. Scope = reviewed beans only.` });
  gt.createdAt = batch.createdAt || gt.createdAt;
  gt.source = { kind: 'swipe-review', batchId: batch.id, subset, paramsHash: batch.paramsHash, biased: subset === 'targeted', missedScreenShown: !!batch.missedScreenShown,
    detectionsOnPlate: batch.detectionsOnPlate, reviewedShare: reviewedShare(batch), colourPipelineVersion: batch.colourPipelineVersion, wbGains: batch.wbGains };
  if (batch.photoPath) gt.image = { ...gt.image, path: batch.photoPath };
  gt.colourFlags = colourFlags; // never used as band labels (no `band` corrections are produced here)
  gt.excluded = excluded;
  return gt;
}

// Share of the plate's gap area (uncovered plate between detections) that the gaps tiles showed.
export function reviewedShare(batch) {
  const tot = batch.totalGapArea, rev = (batch.gapTiles || []).reduce((t, g) => t + (g.gapArea || 0), 0);
  return tot > 0 ? Math.min(1, rev / tot) : (batch.missedScreenShown ? 1 : 0);
}
// Misses on the whole plate, estimated from the taps in the reviewed tiles.
export function estimatedMisses(batch) { const sh = reviewedShare(batch); return sh > 0 ? (batch.missed || []).length / sh : null; }

// Score a batch, separately per subset. A swipe batch covers only some beans, so:
//  precision = from the reviewed cards (Critic: quote the 'random' one),
//  recall    = TP_est / (TP_est + misses_est) over the WHOLE plate, TP_est = detectionsOnPlate × precision(random),
//  count error is not computed (a partial batch cannot measure it).
export function scoreBatch(batch, detections) {
  const out = {}; const D = batch.detectionsOnPlate ?? detections.length, miss = estimatedMisses(batch);
  for (const sub of ['random', 'targeted', 'all']) { const gt = toGroundTruth(batch, sub);
    const noMiss = { ...gt, truth: gt.truth, roi: { points: gt.roi.points.filter(q => !(batch.missed || []).some(m => m.x === q[0] && m.y === q[1])), r: gt.roi.r } };
    const m = score(loadTruth(gt).filter(t => !(batch.missed || []).some(mm => mm.x === t.x && mm.y === t.y)), detections, batch.beanRadius, noMiss.roi);
    out[sub] = { tp: m.tp, fp: m.fp, fn: m.fn, precision: m.precision, reviewed: m.detected, countError: null }; }
  const P = out.random.reviewed ? out.random.precision : out.all.precision;
  const tpEst = D * P; const recall = miss == null ? null : +(tpEst / Math.max(1e-9, tpEst + miss)).toFixed(4);
  for (const sub of ['random', 'targeted', 'all']) { out[sub].recall = recall; out[sub].f1 = recall == null ? null : +(2 * out[sub].precision * recall / Math.max(1e-9, out[sub].precision + recall)).toFixed(4); }
  out.missesEstimated = miss == null ? null : +miss.toFixed(2); out.reviewedShare = +reviewedShare(batch).toFixed(4);
  return out;
}

// Server-side + client-side schema check. Returns [] when valid, else a list of problems.
export function validateBatch(b) {
  const e = []; const isNum = v => typeof v === 'number' && Number.isFinite(v); const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  if (!b || typeof b !== 'object') return ['not an object'];
  if (b.schema !== BATCH_SCHEMA) e.push('schema');
  if (typeof b.id !== 'string' || !/^[\w-]{6,64}$/.test(b.id)) e.push('id');
  if (!b.image || !hex(b.image.sha256, 64) || !isNum(b.image.width) || !isNum(b.image.height) || b.image.width > 4000 || b.image.height > 4000) e.push('image');
  if (typeof b.image?.name !== 'string' || b.image.name.length > 120) e.push('image.name');
  if (!isNum(b.beanRadius) || b.beanRadius <= 0 || b.beanRadius > 200) e.push('beanRadius');
  if (typeof b.detectorVersion !== 'string' || b.detectorVersion.length > 40) e.push('detectorVersion');
  if (!hex(b.paramsHash, 12) && b.paramsHash !== 'none') e.push('paramsHash');
  if (!Array.isArray(b.answers) || !b.answers.length || b.answers.length > LIMITS.maxAnswers) e.push('answers');
  else b.answers.forEach((a, i) => {
    const bad = !a || !Number.isInteger(a.beanId) || !isNum(a.x) || !isNum(a.y) || a.x < 0 || a.y < 0 || a.x > b.image.width || a.y > b.image.height
      || !ANSWERS.includes(a.answer) || !['random', 'targeted'].includes(a.pick) || a.imageSha256 !== b.image.sha256 || a.paramsHash !== b.paramsHash || a.detectorVersion !== b.detectorVersion
      || (a.answer === 'wrong' ? !REASONS.includes(a.reason) : a.reason !== null) || !isNum(a.rawL) || !isNum(a.rawA) || !isNum(a.rawB) || !isNum(a.glare) || typeof a.ts !== 'string'
      || (a.reason === 'two-beans' && !(a.mergeN === 2 || a.mergeN === 3 || a.mergeN === '4+'));
    if (bad) e.push(`answers[${i}]`); });
  if (!Array.isArray(b.missed) || b.missed.length > LIMITS.maxMissed || b.missed.some(m => !isNum(m?.x) || !isNum(m?.y) || m.x < 0 || m.y < 0 || m.x > b.image.width || m.y > b.image.height)) e.push('missed');
  if (!Number.isInteger(b.detectionsOnPlate) || b.detectionsOnPlate < 1) e.push('detectionsOnPlate');
  if (typeof b.colourPipelineVersion !== 'string' || !Array.isArray(b.wbGains) || b.wbGains.length !== 3 || !b.wbGains.every(isNum)) e.push('colour pipeline');
  if (!isNum(b.totalGapArea) || b.totalGapArea < 0 || !Array.isArray(b.gapTiles) || b.gapTiles.length > LIMITS.maxTiles
    || b.gapTiles.some(g => !Array.isArray(g?.rect) || g.rect.length !== 4 || !g.rect.every(isNum) || !isNum(g.gapArea) || g.gapArea < 0)) e.push('gapTiles');
  if (b.photo != null && (typeof b.photo !== 'string' || !b.photo.startsWith('data:image/jpeg;base64,') || b.photo.length > LIMITS.maxPhotoBytes)) e.push('photo');
  return e;
}
// Canonical content hash of a batch's answers (dedupe: the same answers sent twice are one batch).
export async function contentHash(b) {
  const canon = JSON.stringify([b.image.sha256, b.paramsHash, latestAnswers(b.answers).map(a => [a.beanId, a.answer, a.reason, a.mergeN ?? null]).sort((x, y) => x[0] - y[0]), (b.missed || []).map(m => [m.x, m.y])]);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// 12-hex hash of params.json content (same idea as the benchmark's gtFingerprint).
export async function paramsHash(params) {
  if (!params) return 'none';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(params)));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
export { GT_SCHEMA };

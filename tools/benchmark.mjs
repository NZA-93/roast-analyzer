#!/usr/bin/env node
// Detector benchmark + tuner + regression gate.
//   node tools/benchmark.mjs            evaluate docs/params.json against feedback/*.json
//   node tools/benchmark.mjs --tune     also tune parameters to maximise F1 and write docs/params.json
//   node tools/benchmark.mjs --ci       tune + write history; exit 1 on regression
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js'; import { PNG } from 'pngjs';
import { analyzeImage, ALGO_VERSION, TUNABLE } from '../docs/js/analyzer.js';
import { score, loadTruth, GT_SCHEMA, plateRecall, recallText } from '../docs/js/evaluate.js';
import { poolGapTiles } from '../docs/js/swipe-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2)); const TUNE = args.has('--tune') || args.has('--ci'), CI = args.has('--ci'), DRY = args.has('--dry');
const FEEDBACK = process.env.RA_FEEDBACK || null;
const P = (...a) => path.join(ROOT, ...a);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const PHOTO_DROP = 0.02; // per-photo gate: no photo may lose more than 2 F1 points
const MIN_GAIN = 0.005, REGRESSION_TOL = 0.01, STABILITY_TOL = 0.10;
const DEFAULTS = { bodySigma: 0.42, nmsRadius: 0.85, markerMin: 0.3, openK: 0.5, minBeanC: 0.55, distW: 1.5 };
const BOUNDS = { bodySigma: [0.25, 0.8], nmsRadius: [0.5, 1.4], markerMin: [0.1, 0.6], openK: [0.25, 0.9], minBeanC: [0.3, 0.8], distW: [0, 4] };

// ---------- images ----------
const imageIndex = new Map();
for (const dir of ['docs/demo', 'feedback/images']) { if (!fs.existsSync(P(dir))) continue;
  for (const f of fs.readdirSync(P(dir))) if (/\.(jpe?g|png)$/i.test(f)) { const buf = fs.readFileSync(P(dir, f)); imageIndex.set(crypto.createHash('sha256').update(buf).digest('hex'), P(dir, f)); } }
function decode(file) { const buf = fs.readFileSync(file); if (/\.png$/i.test(file)) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) }; }
  const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 }); return { width: j.width, height: j.height, data: j.data }; }
function resizeTo(img, W, H) { if (img.width === W && img.height === H) return img; const out = new Uint8ClampedArray(W * H * 4); const sx = img.width / W, sy = img.height / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const x0 = Math.floor(x * sx), y0 = Math.floor(y * sy), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy)); const acc = [0, 0, 0, 0]; let n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = 4 * (yy * img.width + xx); for (let c = 0; c < 4; c++) acc[c] += img.data[i + c]; n++; }
    for (let c = 0; c < 4; c++) out[4 * (y * W + x) + c] = acc[c] / n; } return { width: W, height: H, data: out }; }

// ---------- ground truth ----------
const FB = FEEDBACK || P('feedback');
// Hand-marked ground truth: top-level feedback/*.json (used for F1, tuning and gates).
// Swipe-review files (feedback/swipe/*.json): random subset only, REPORTED separately (precision + plateRecall with interval);
// they do not enter F1, tuning or the gates. Targeted (biased) files are skipped.
const listJSON = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).sort() : [];
const gtFiles = listJSON(FB), swipeFiles = listJSON(path.join(FB, 'swipe')).map(f => path.join('swipe', f));
const swipeSets = [];
let skippedBiased = 0;
const sets = [];
for (const f of gtFiles) { const j = readJSON(path.join(FB, f)); if (!j || j.schema !== GT_SCHEMA) { console.warn(`skip ${f}: not a ground-truth file`); continue; }
  if (j.source?.kind === 'swipe-review') { console.log(`skip ${f}: swipe-review files belong in feedback/swipe/ and are reported, not scored`); continue; }
  if (j.source?.biased) { skippedBiased++; console.log(`skip ${f}: biased (targeted swipe answers are for analysis, not tuning or gating)`); continue; }
  const file = imageIndex.get(j.image?.sha256) || (j.image?.path && fs.existsSync(P(j.image.path)) ? P(j.image.path) : null);
  if (!file) { console.warn(`skip ${f}: image ${j.image?.sha256?.slice(0, 12)} not found (add it to feedback/images/)`); continue; }
  sets.push({ name: f, gt: j, truth: loadTruth(j), img: resizeTo(decode(file), j.image.width, j.image.height) }); }
for (const f of swipeFiles) { const j = readJSON(path.join(FB, f)); if (!j || j.schema !== GT_SCHEMA || j.source?.kind !== 'swipe-review') continue;
  if (j.source.biased) { skippedBiased++; console.log(`skip ${f}: biased (targeted swipe answers)`); continue; }
  const file = imageIndex.get(j.image?.sha256) || (j.image?.path && fs.existsSync(P(j.image.path)) ? P(j.image.path) : null); if (!file) { console.warn(`skip ${f}: image not found`); continue; }
  swipeSets.push({ name: f, gt: j, truth: loadTruth(j), img: resizeTo(decode(file), j.image.width, j.image.height) }); }
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(sets.map(s => [s.name, s.gt.truth, s.gt.roi]))).digest('hex').slice(0, 12);
if (!sets.length) { console.log('No usable ground truth in feedback/ — nothing to do.'); process.exit(0); }
// Per-photo holdout: whole photos are held out of tuning so tuned params are judged on photos the tuner never saw.
const photos = [...new Set(sets.map(s => s.gt.image.sha256))].sort();
let holdoutPhotos = photos.length >= 2 ? photos.filter(h => parseInt(h.slice(0, 8), 16) % 4 === 0) : [];
if (photos.length >= 2 && !holdoutPhotos.length) holdoutPhotos = [photos[0]];
if (holdoutPhotos.length === photos.length) holdoutPhotos = holdoutPhotos.slice(0, -1);
if (TUNE && photos.length < 2) { console.error(`REFUSING to tune: ground truth covers ${photos.length} photo(s); tuning needs at least 2 so one can be held out.`); process.exit(2); }
const trainSets = sets.filter(s => !holdoutPhotos.includes(s.gt.image.sha256)), holdSets = sets.filter(s => holdoutPhotos.includes(s.gt.image.sha256));
console.log(`photos: ${photos.length} · holdout: ${holdSets.length ? holdSets.map(s => s.name).join(', ') : 'none (needs ≥ 2 photos; gate uses all ground truth)'} · skipped biased: ${skippedBiased}`);

// Swipe-review files, pooled per photo + detector params (sessions on the same photo add up): precision on the reviewed
// random cards; whole-plate recall from the shared plateRecall() over the pooled gap tiles (poolGapTiles: deduped, pooled
// inclusion probabilities), with taps re-checked against the new detections. null + plain reason when evidence is thin.
function scoreSwipeGroup(group, params) {
  const r = analyzeImage(group[0].img, params), R = r.params.beanRadius; let tp = 0, n = 0; const sessions = [];
  for (const s of group) { const added = s.gt.corrections?.added || [], isAdded = p => added.some(a => a.x === p.x && a.y === p.y);
    const roi = { points: s.gt.roi.points.filter(q => !added.some(a => a.x === q[0] && a.y === q[1])), r: s.gt.roi.r };
    const sc = score(s.truth.filter(t => !isAdded(t)), r.beans, R, roi); tp += sc.tp; n += sc.detected;
    const still = a => !r.beans.some(d => (d.x - a.x) ** 2 + (d.y - a.y) ** 2 <= R * R);
    sessions.push({ paramsHash: s.gt.source.paramsHash, totalGapArea: s.gt.source.totalGapArea, strata: (s.gt.source.gapSelection?.strata || []).map(st => ({ name: st.name, N: st.N })),
      tiles: (s.gt.source.gapTiles || []).map(g => ({ ...g, missed: added.filter(a => a.x >= g.rect[0] && a.x < g.rect[2] && a.y >= g.rect[1] && a.y < g.rect[3] && still(a)).length })) }); }
  const pooled = poolGapTiles(sessions);
  const rec = plateRecall({ tpRandom: tp, nRandom: n, detections: r.beans.length, tiles: pooled?.tiles || [], totalGapArea: pooled?.totalGapArea ?? 0 });
  return { photo: group[0].gt.image.sha256.slice(0, 12), files: group.map(s => s.name), sessions: pooled?.sessions || 0, reviewed: n, precision: n ? Math.round(tp / n * 1e4) / 1e4 : null, ...rec, text: recallText(rec) };
}
function evaluate(params, list = sets) {
  let tp = 0, fp = 0, fn = 0, ce = 0, nce = 0, bn = 0, bok = 0; const per = [];
  for (const s of list) { const r = analyzeImage(s.img, params);
    const sc = score(s.truth, r.beans, r.params.beanRadius, s.gt.roi);
    tp += sc.tp; fp += sc.fp; fn += sc.fn; if (sc.countError != null) { ce += Math.abs(sc.countError); nce++; } if (sc.bandChecked) { bn += sc.bandChecked; bok += sc.bandAgreement * sc.bandChecked; }
    per.push({ file: s.name, photo: s.gt.image.sha256.slice(0, 12), tp: sc.tp, fp: sc.fp, fn: sc.fn, truth: sc.truth, detected: sc.detected, precision: sc.precision, recall: sc.recall, f1: sc.f1, countError: sc.countError }); }
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn), f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const r4 = v => Math.round(v * 10000) / 10000;
  return { f1: r4(f1), precision: r4(precision), recall: r4(recall), meanAbsCountError: nce ? r4(ce / nce) : null, bandAgreement: bn ? r4(bok / bn) : null, bandChecked: bn, images: list.length, truthBeans: Math.round(tp + fn), per };
}
function perPhoto(m) { const g = {}; for (const p of m.per) { const x = g[p.photo] ||= { tp: 0, fp: 0, fn: 0 }; x.tp += p.tp; x.fp += p.fp; x.fn += p.fn; }
  return Object.fromEntries(Object.entries(g).map(([k, x]) => [k, Math.round(2 * x.tp / Math.max(1, 2 * x.tp + x.fp + x.fn) * 1e4) / 1e4])); }
const photoDrops = (before, after) => Object.keys(before).filter(k => k in after && after[k] < before[k] - PHOTO_DROP).map(k => `${k} ${before[k]}→${after[k]}`);
// unlabeled stability guard: total bean count on the demo photos must not swing > STABILITY_TOL
const demo = fs.readdirSync(P('docs/demo')).filter(f => /\.jpe?g$/i.test(f)).map(f => decode(P('docs/demo', f)));
const demoCount = params => demo.reduce((s, im) => s + analyzeImage(im, params).beans.length, 0);

const current = readJSON(P('docs/params.json'), null);
const curParams = { ...DEFAULTS, ...(current?.params || {}) };
const base = evaluate(curParams);
const gateSets = holdSets.length ? holdSets : sets, baseGate = holdSets.length ? evaluate(curParams, holdSets) : base;
console.log(`ground truth: ${sets.length} file(s), ${base.truthBeans} beans, fingerprint ${fingerprint}`);
console.log(`current params ${current?.version || '(defaults)'}: F1 ${base.f1}  P ${base.precision}  R ${base.recall}  |count err| ${base.meanAbsCountError}`);

// regression gate vs. last history entry measured on the same ground-truth set
const history = readJSON(process.env.RA_HISTORY || P('docs/metrics/history.json'), []);
const last = [...history].reverse().find(h => h.gtFingerprint === fingerprint);
let regression = null;
const basePhotos = perPhoto(base);
const lastGate = last ? (last.holdoutF1 ?? last.f1) : null;
if (last?.perPhoto && photoDrops(last.perPhoto, basePhotos).length) regression = `per-photo F1 dropped > ${PHOTO_DROP * 100} points: ${photoDrops(last.perPhoto, basePhotos).join(', ')}`;
else if (last && baseGate.f1 < lastGate - REGRESSION_TOL) regression = `${holdSets.length ? 'holdout ' : ''}F1 fell from ${lastGate} (${last.version}, ${last.date}) to ${baseGate.f1} with the current code/params`;

const trainBase = holdSets.length ? evaluate(curParams, trainSets) : base;
let best = { params: curParams, m: trainBase }, changed = false, note = 'no change';
if (TUNE) {
  const cands = k => { const v = best.params[k]; const [lo, hi] = BOUNDS[k]; return [...new Set([v * 0.8, v * 0.9, v * 1.1, v * 1.25].map(x => +Math.min(hi, Math.max(lo, x)).toFixed(3)))].filter(x => x !== v); };
  for (let round = 0; round < 2; round++) for (const k of TUNABLE) for (const v of cands(k)) {
    const p = { ...best.params, [k]: v }; const m = evaluate(p, trainSets);
    if (m.f1 > best.m.f1 + 1e-4 || (m.f1 === best.m.f1 && m.meanAbsCountError < best.m.meanAbsCountError - 1e-4)) { best = { params: p, m }; console.log(`  better: ${k}=${v} → F1 ${m.f1}`); } }
  const holdBest = holdSets.length ? evaluate(best.params, holdSets) : null;
  const candDrops = best.params !== curParams ? photoDrops(basePhotos, perPhoto(evaluate(best.params))) : [];
  if (candDrops.length) note = `rejected tuned params: per-photo F1 would drop > ${PHOTO_DROP * 100} points (${candDrops.join(', ')})`;
  else if (holdBest && best.params !== curParams && holdBest.f1 < baseGate.f1 - 1e-4) note = `rejected tuned params: train F1 ${trainBase.f1} → ${best.m.f1} but holdout F1 ${baseGate.f1} → ${holdBest.f1} (overfitting)`;
  else if (best.m.f1 >= trainBase.f1 + MIN_GAIN) {
    const c0 = demoCount(curParams), c1 = demoCount(best.params); const swing = Math.abs(c1 - c0) / c0;
    if (swing > STABILITY_TOL) note = `rejected tuned params: demo bean count would swing ${(swing * 100).toFixed(1)}% (${c0}→${c1}), likely overfitting`;
    else { changed = true; note = `tuned: F1 ${base.f1} → ${best.m.f1} (demo count ${c0}→${c1})`; }
  } else note = `tuning found no gain ≥ ${MIN_GAIN} (best ${best.m.f1})`;
  if (changed) best = { params: best.params, m: evaluate(best.params) };
  console.log(note);
}
const ship = changed ? best : { params: curParams, m: base };
const prevV = current?.version || `${ALGO_VERSION}.0`; const [maj, min, patch] = prevV.split('.').map(Number);
const algoChanged = `${maj}.${min}` !== ALGO_VERSION;
const version = algoChanged ? `${ALGO_VERSION}.0` : changed ? `${maj}.${min}.${patch + 1}` : prevV;
const today = new Date().toISOString().slice(0, 10);
const { per, ...summary } = ship.m; if (holdSets.length) summary.holdoutF1 = evaluate(ship.params, holdSets).f1; summary.perPhoto = perPhoto(ship.m);
const groups = new Map(); for (const s of swipeSets) { const k = `${s.gt.image.sha256}|${s.gt.source.paramsHash}`; (groups.get(k) || groups.set(k, []).get(k)).push(s); }
const swipeReport = [...groups.values()].map(g => scoreSwipeGroup(g, ship.params));
for (const w of swipeReport) console.log(`swipe ${w.photo} (${w.sessions} session${w.sessions === 1 ? '' : 's'}): precision ${w.precision ?? 'n/a'} (n=${w.nRandom}${w.precisionCI ? `, 95% ${w.precisionCI[0]}–${w.precisionCI[1]}` : ''}) · ${w.text}${w.reason ? ' — ' + w.reason : ''}`);
const out = { version, algoVersion: ALGO_VERSION, date: changed || !current ? today : current.date, params: ship.params, benchmark: { ...summary, gtFingerprint: fingerprint, perImage: per }, ...(swipeReport.length ? { swipeReport } : {}), note };
if (DRY) console.log(JSON.stringify({ dry: true, version, params: ship.params, f1: summary.f1, holdoutF1: summary.holdoutF1 ?? null, holdout: holdSets.map(s => s.name), skippedBiased, note, perPhoto: summary.perPhoto, swipe: swipeReport }));
else if (TUNE || !current) {
  fs.writeFileSync(P('docs/params.json'), JSON.stringify(out, null, 1) + '\n');
  if (!last || last.f1 !== summary.f1 || last.version !== version || last.gtFingerprint !== fingerprint) {
    history.push({ date: today, version, gtFingerprint: fingerprint, ...summary, note }); fs.mkdirSync(P('docs/metrics'), { recursive: true }); fs.writeFileSync(P('docs/metrics/history.json'), JSON.stringify(history, null, 1) + '\n'); }
  const cl = readJSON(P('docs/changelog.json'), []);
  if (changed || algoChanged || !current) { cl.unshift({ date: today, version, text: changed ? note : algoChanged ? `Algorithm ${ALGO_VERSION}; benchmark F1 ${summary.f1}` : `Benchmark baseline F1 ${summary.f1} on ${summary.truthBeans} hand-checked beans` }); fs.writeFileSync(P('docs/changelog.json'), JSON.stringify(cl, null, 1) + '\n'); }
}
console.log(`shipping ${version}: F1 ${summary.f1}  P ${summary.precision}  R ${summary.recall}`);
if (regression) { console.error(`REGRESSION: ${regression}`); if (CI) process.exit(1); }

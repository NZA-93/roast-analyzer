#!/usr/bin/env node
// Detector benchmark + tuner + regression gate.
//   node tools/benchmark.mjs            evaluate docs/params.json against feedback/*.json
//   node tools/benchmark.mjs --tune     also tune parameters to maximise F1 and write docs/params.json
//   node tools/benchmark.mjs --ci       tune + write history; exit 1 on regression
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js'; import { PNG } from 'pngjs';
import { analyzeImage, ALGO_VERSION, TUNABLE } from '../docs/js/analyzer.js';
import { score, loadTruth, GT_SCHEMA } from '../docs/js/evaluate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2)); const TUNE = args.has('--tune') || args.has('--ci'), CI = args.has('--ci'), DRY = args.has('--dry');
const FEEDBACK = process.env.RA_FEEDBACK || null;
const P = (...a) => path.join(ROOT, ...a);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
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
const gtFiles = fs.existsSync(FB) ? fs.readdirSync(FB).filter(f => f.endsWith('.json')).sort() : [];
const sets = [];
for (const f of gtFiles) { const j = readJSON(path.join(FB, f)); if (!j || j.schema !== GT_SCHEMA) { console.warn(`skip ${f}: not a ground-truth file`); continue; }
  const file = imageIndex.get(j.image?.sha256) || (j.image?.path && fs.existsSync(P(j.image.path)) ? P(j.image.path) : null);
  if (!file) { console.warn(`skip ${f}: image ${j.image?.sha256?.slice(0, 12)} not found (add it to feedback/images/)`); continue; }
  sets.push({ name: f, gt: j, truth: loadTruth(j), img: resizeTo(decode(file), j.image.width, j.image.height) }); }
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(sets.map(s => [s.name, s.gt.truth, s.gt.roi]))).digest('hex').slice(0, 12);
if (!sets.length) { console.log('No usable ground truth in feedback/ — nothing to do.'); process.exit(0); }

function evaluate(params) {
  let tp = 0, fp = 0, fn = 0, ce = 0, bn = 0, bok = 0; const per = [];
  for (const s of sets) { const r = analyzeImage(s.img, params); const sc = score(s.truth, r.beans, r.params.beanRadius, s.gt.roi);
    tp += sc.tp; fp += sc.fp; fn += sc.fn; ce += Math.abs(sc.countError); if (sc.bandChecked) { bn += sc.bandChecked; bok += sc.bandAgreement * sc.bandChecked; }
    per.push({ file: s.name, truth: sc.truth, detected: sc.detected, precision: sc.precision, recall: sc.recall, f1: sc.f1, countError: sc.countError }); }
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn), f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const r4 = v => Math.round(v * 10000) / 10000;
  return { f1: r4(f1), precision: r4(precision), recall: r4(recall), meanAbsCountError: r4(ce / sets.length), bandAgreement: bn ? r4(bok / bn) : null, bandChecked: bn, images: sets.length, truthBeans: tp + fn, per };
}
// unlabeled stability guard: total bean count on the demo photos must not swing > STABILITY_TOL
const demo = fs.readdirSync(P('docs/demo')).filter(f => /\.jpe?g$/i.test(f)).map(f => decode(P('docs/demo', f)));
const demoCount = params => demo.reduce((s, im) => s + analyzeImage(im, params).beans.length, 0);

const current = readJSON(P('docs/params.json'), null);
const curParams = { ...DEFAULTS, ...(current?.params || {}) };
const base = evaluate(curParams);
console.log(`ground truth: ${sets.length} file(s), ${base.truthBeans} beans, fingerprint ${fingerprint}`);
console.log(`current params ${current?.version || '(defaults)'}: F1 ${base.f1}  P ${base.precision}  R ${base.recall}  |count err| ${base.meanAbsCountError}`);

// regression gate vs. last history entry measured on the same ground-truth set
const history = readJSON(P('docs/metrics/history.json'), []);
const last = [...history].reverse().find(h => h.gtFingerprint === fingerprint);
let regression = null;
if (last && base.f1 < last.f1 - REGRESSION_TOL) regression = `F1 fell from ${last.f1} (${last.version}, ${last.date}) to ${base.f1} with the current code/params`;

let best = { params: curParams, m: base }, changed = false, note = 'no change';
if (TUNE) {
  const cands = k => { const v = best.params[k]; const [lo, hi] = BOUNDS[k]; return [...new Set([v * 0.8, v * 0.9, v * 1.1, v * 1.25].map(x => +Math.min(hi, Math.max(lo, x)).toFixed(3)))].filter(x => x !== v); };
  for (let round = 0; round < 2; round++) for (const k of TUNABLE) for (const v of cands(k)) {
    const p = { ...best.params, [k]: v }; const m = evaluate(p);
    if (m.f1 > best.m.f1 + 1e-4 || (m.f1 === best.m.f1 && m.meanAbsCountError < best.m.meanAbsCountError - 1e-4)) { best = { params: p, m }; console.log(`  better: ${k}=${v} → F1 ${m.f1}`); } }
  if (best.m.f1 >= base.f1 + MIN_GAIN) {
    const c0 = demoCount(curParams), c1 = demoCount(best.params); const swing = Math.abs(c1 - c0) / c0;
    if (swing > STABILITY_TOL) note = `rejected tuned params: demo bean count would swing ${(swing * 100).toFixed(1)}% (${c0}→${c1}), likely overfitting`;
    else { changed = true; note = `tuned: F1 ${base.f1} → ${best.m.f1} (demo count ${c0}→${c1})`; }
  } else note = `tuning found no gain ≥ ${MIN_GAIN} (best ${best.m.f1})`;
  console.log(note);
}
const ship = changed ? best : { params: curParams, m: base };
const prevV = current?.version || `${ALGO_VERSION}.0`; const [maj, min, patch] = prevV.split('.').map(Number);
const algoChanged = `${maj}.${min}` !== ALGO_VERSION;
const version = algoChanged ? `${ALGO_VERSION}.0` : changed ? `${maj}.${min}.${patch + 1}` : prevV;
const today = new Date().toISOString().slice(0, 10);
const { per, ...summary } = ship.m;
const out = { version, algoVersion: ALGO_VERSION, date: changed || !current ? today : current.date, params: ship.params, benchmark: { ...summary, gtFingerprint: fingerprint, perImage: per }, note };
if (DRY) console.log(JSON.stringify({ dry: true, version, params: ship.params, f1: summary.f1 }));
else if (TUNE || !current) {
  fs.writeFileSync(P('docs/params.json'), JSON.stringify(out, null, 1) + '\n');
  if (!last || last.f1 !== summary.f1 || last.version !== version || last.gtFingerprint !== fingerprint) {
    history.push({ date: today, version, gtFingerprint: fingerprint, ...summary, note }); fs.mkdirSync(P('docs/metrics'), { recursive: true }); fs.writeFileSync(P('docs/metrics/history.json'), JSON.stringify(history, null, 1) + '\n'); }
  const cl = readJSON(P('docs/changelog.json'), []);
  if (changed || algoChanged || !current) { cl.unshift({ date: today, version, text: changed ? note : algoChanged ? `Algorithm ${ALGO_VERSION}; benchmark F1 ${summary.f1}` : `Benchmark baseline F1 ${summary.f1} on ${summary.truthBeans} hand-checked beans` }); fs.writeFileSync(P('docs/changelog.json'), JSON.stringify(cl, null, 1) + '\n'); }
}
console.log(`shipping ${version}: F1 ${summary.f1}  P ${summary.precision}  R ${summary.recall}`);
if (regression) { console.error(`REGRESSION: ${regression}`); if (CI) process.exit(1); }

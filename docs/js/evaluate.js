// Ground truth + scoring, shared by the page (live metrics) and tools/eval.mjs (benchmark/tuning).
import { BANDS } from './analyzer.js';

// Corrections reference detections by centre point (not id), so ground truth stays valid when the detector changes.
// corrections = { added:[{x,y,band?}], falsePos:[{x,y,reason}], merged:[{x,y,n}], split:[{x,y}], band:[{x,y,band}] }
export function emptyCorrections() { return { added: [], falsePos: [], merged: [], split: [], band: [] }; }

const near = (a, b, r) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= r * r;

// Build the true bean list from a detection snapshot + user corrections.
export function buildTruth(detections, corr, R) {
  const tol = Math.max(3, R * 0.5);
  const isMarked = (d, list) => list.some(c => near(c, d, tol));
  const truth = [];
  for (const d of detections) {
    if (isMarked(d, corr.falsePos) || isMarked(d, corr.split)) continue;
    const bc = corr.band.find(c => near(c, d, tol));
    const m = corr.merged.find(c => near(c, d, tol));
    const n = m ? Math.max(2, m.n | 0) : 1;
    for (let k = 0; k < n; k++) truth.push({ x: Math.round(d.x), y: Math.round(d.y), band: bc ? bc.band : undefined, bandChecked: !!bc, group: m ? `m${Math.round(d.x)}_${Math.round(d.y)}` : undefined });
  }
  for (const a of corr.added) truth.push({ x: Math.round(a.x), y: Math.round(a.y), band: a.band, bandChecked: !!a.band });
  return truth;
}

// roi is either a rectangle [x0,y0,x1,y1] or a point scope {points:[[x,y],...], r} (swipe review: only the beans
// that were actually shown, plus the missed beans tapped on the gaps screen, count).
const inRoi = (p, roi) => { if (!roi) return true; if (Array.isArray(roi)) return p.x >= roi[0] && p.x < roi[2] && p.y >= roi[1] && p.y < roi[3];
  const r2 = (roi.r || 3) ** 2; return roi.points.some(q => (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2 <= r2); };

// Greedy one-to-one matching of truth points to detections within matchK * R (merged groups get a wider radius).
export function score(truth, detections, R, roi = null, matchK = 1.0) {
  const T = truth.filter(p => inRoi(p, roi)), D = detections.filter(p => inRoi(p, roi));
  const pairs = [];
  T.forEach((t, i) => D.forEach((d, j) => { const r = R * matchK * (t.group ? 1.6 : 1); const dd = (t.x - d.x) ** 2 + (t.y - d.y) ** 2; if (dd <= r * r) pairs.push([dd, i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const ut = new Int32Array(T.length).fill(-1), ud = new Int32Array(D.length).fill(-1);
  for (const [, i, j] of pairs) if (ut[i] < 0 && ud[j] < 0) { ut[i] = j; ud[j] = i; }
  const tp = [...ut].filter(v => v >= 0).length, fp = D.length - tp, fn = T.length - tp;
  const precision = D.length ? tp / D.length : 1, recall = T.length ? tp / T.length : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  let bandN = 0, bandOk = 0, bandWithin1 = 0;
  T.forEach((t, i) => { if (!t.bandChecked || ut[i] < 0) return; const d = D[ut[i]]; bandN++; const a = BANDS.findIndex(b => b.name === t.band), b = BANDS.findIndex(b => b.name === d.band); if (a === b) bandOk++; if (Math.abs(a - b) <= 1) bandWithin1++; });
  return { truth: T.length, detected: D.length, tp, fp, fn, precision: r4(precision), recall: r4(recall), f1: r4(f1), countError: T.length ? r4((D.length - T.length) / T.length) : 0,
    bandChecked: bandN, bandAgreement: bandN ? r4(bandOk / bandN) : null, bandWithin1: bandN ? r4(bandWithin1 / bandN) : null,
    unmatchedTruth: T.filter((_, i) => ut[i] < 0), unmatchedDet: D.filter((_, j) => ud[j] < 0) };
}
const r4 = v => Math.round(v * 10000) / 10000;

// Ground-truth file (one per image) — what the page exports and feedback/ stores.
// truth entries are compact: [x, y] or [x, y, {band?, group?}]  (coordinates in the analysed frame, max side 1600 px)
export const GT_SCHEMA = 'roast-analyzer/ground-truth@1';
export function makeGroundTruthFile({ image, detectorVersion, params, roi, detections, corrections, R, note, detectedCount }) {
  const truth = buildTruth(detections, corrections, R).filter(p => inRoi(p, roi)).map(({ x, y, band, bandChecked, group }) => {
    const extra = {}; if (bandChecked && band) extra.band = band; if (group) extra.group = group; return Object.keys(extra).length ? [x, y, extra] : [x, y]; });
  return { schema: GT_SCHEMA, createdAt: new Date().toISOString(), image, detectorVersion, params: params || {}, roi: roi || null, beanRadius: R,
    detectedAtReview: detectedCount ?? detections.filter(p => inRoi(p, roi)).length, note: note || '', corrections, truth };
}
export function loadTruth(file) {
  if (!file || file.schema !== GT_SCHEMA || !Array.isArray(file.truth)) throw new Error('Not a roast-analyzer ground-truth file');
  return file.truth.map(t => Array.isArray(t) ? { x: t[0], y: t[1], band: t[2]?.band, bandChecked: !!t[2]?.band, group: t[2]?.group } : { ...t, bandChecked: !!t.band });
}

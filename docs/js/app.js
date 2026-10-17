import { BANDS, DEFAULT_CAL, agtronFromL, bandOf, batchReport, ALGO_VERSION } from './analyzer.js';
import { tester } from './tester.js';
import * as swipe from './swipe.js';

const $ = (id) => document.getElementById(id);
const MAX = 1600;
const state = { samples: [], report: null, current: 0, selected: null, cal: loadCal(), detector: null };
// tuned detector parameters produced by tools/benchmark.mjs from the feedback/ ground truth
const detectorReady = fetch('params.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null).then(d => { state.detector = d; showDetector(); return d; });
let worker = null, seq = 0; const pending = new Map();

function loadCal() { try { const c = JSON.parse(localStorage.getItem('roastCal')); if (c && isFinite(c.L1) && isFinite(c.L2) && c.L1 !== c.L2) return c; } catch {} return { ...DEFAULT_CAL }; }
function status(t, cls) { $('status').textContent = t; $('status').className = cls || ''; }
function bandColor(name) { return (BANDS.find(b => b.name === name) || BANDS[0]).color; }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); };
  return worker;
}
async function analyzeInWorker(img) {
  const id = ++seq; const w = getWorker();
  return new Promise((res, rej) => { pending.set(id, { res, rej }); const buf = img.data.buffer.slice(0); w.postMessage({ id, width: img.width, height: img.height, buffer: buf, opts: state.detector?.params || {} }, [buf]); });
}

async function loadBitmap(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const sc = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const cw = Math.round(bmp.width * sc), ch = Math.round(bmp.height * sc);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch; const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, cw, ch);
  return { canvas: c, imageData: ctx.getImageData(0, 0, cw, ch), sha256 };
}

async function addSources(list) {
  $('clear').hidden = false;
  for (let k = 0; k < list.length; k++) {
    const { src, name } = list[k];
    status(`Analysing ${name} (${k + 1}/${list.length})…`);
    try {
      const { canvas, imageData, sha256 } = await loadBitmap(src);
      await detectorReady; const r = await analyzeInWorker(imageData);
      r.name = name; r.canvas = canvas; r.sha256 = sha256; r.demoPath = typeof src === 'string' ? 'docs/' + src : null; state.samples.push(r);
    } catch (e) { status(`${name}: ${e.message}`, 'warn'); await new Promise(r => setTimeout(r, 1500)); }
  }
  recompute(); state.current = Math.max(0, state.samples.length - 1);
  if (list.length > 1) state.current = 0;
  render();
  const n = state.samples.reduce((s, x) => s + x.beans.length, 0);
  status(state.samples.length ? `Done: ${n} beans in ${state.samples.length} photo${state.samples.length > 1 ? 's' : ''}.` : 'No usable photos.');
}

function recompute() {
  if (!state.samples.length) { state.report = null; return; }
  state.report = batchReport(state.samples, state.cal);
}

// ---------- rendering ----------
function render() {
  const rep = state.report; $('report').hidden = !rep; if (!rep) return;
  const c = rep.combined;
  const cards = [
    ['Beans measured', c.n, `${state.samples.length} sample${state.samples.length > 1 ? 's' : ''}`],
    ['Roast level', `<span class="sw" style="background:${bandColor(c.band)}"></span>${c.band}`, `Agtron-like ${c.meanAgtron} ± ${c.sdAgtron}${state.cal.provisional ? ' · uncalibrated' : ''}`, 'band'],
    ['Mean L*', c.meanL, `SD ${c.sdL} · median Agtron ${c.medianAgtron}`],
    ['Uniformity', `${c.uniformityPct}%`, `beans within ±5 of median · ±10: ${c.uniformity10Pct}%`],
    ['Outliers', `${c.outlierPct}%`, `${c.outlierCounts.quaker} quaker · ${c.outlierCounts.underdeveloped} pale · ${c.outlierCounts['scorched/dark']} dark`],
    ['Consistency', rep.consistency.verdict.split(' — ')[0], `sample means span ${rep.consistency.meanRange} Agtron`],
  ];
  $('summary').innerHTML = cards.map(([k, v, s, cls]) => `<div class="card ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  $('tabs').innerHTML = state.samples.map((s, i) => `<button role="tab" aria-selected="${i === state.current}" data-i="${i}">${i + 1}. ${esc(s.name)} · ${s.beans.length}</button>`).join('');
  $('legend').innerHTML = BANDS.map(b => `<span><i class="sw" style="background:${b.color}"></i>${b.name}</span>`).join('') + '<span><i class="sw" style="background:#888;border:2px solid #fff;outline:1px solid #888"></i>outlier (white outline)</span>';
  drawPhoto(); drawMap(); drawHist(); drawTable(); drawOutliers(); calUI(); tester.update(); swipe.update();
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function drawPhoto() {
  const s = state.samples[state.current]; if (!s) return; const cv = $('photo');
  cv.width = s.width; cv.height = s.height; const ctx = cv.getContext('2d'); ctx.drawImage(s.canvas, 0, 0);
  if (!$('showOverlay').checked) { if (tester.on) tester.drawMarks(ctx, s); return; }
  const img = ctx.getImageData(0, 0, s.width, s.height), d = img.data, lm = s.labelMap, w = s.width;
  const col = new Map(), out = new Set(); s.beans.forEach(b => { col.set(b.id, hex(bandColor(b.band))); if (b.outlier) out.add(b.id); });
  const selId = state.selected && state.selected.sample === state.current + 1 ? state.selected.id : -1;
  for (let i = w; i < lm.length - w; i++) { const l = lm[i]; if (!l) continue;
    const edge = lm[i - 1] !== l || lm[i + 1] !== l || lm[i - w] !== l || lm[i + w] !== l;
    const c = col.get(l); if (!c) continue;
    if (edge) { const e2 = l === selId ? [255, 255, 0] : out.has(l) ? [255, 255, 255] : c; d[4 * i] = e2[0]; d[4 * i + 1] = e2[1]; d[4 * i + 2] = e2[2]; }
    else if (l === selId) { d[4 * i] = (d[4 * i] + 255) / 2; d[4 * i + 1] = (d[4 * i + 1] + 255) / 2; }
    else { d[4 * i] = d[4 * i] * 0.55 + c[0] * 0.45; d[4 * i + 1] = d[4 * i + 1] * 0.55 + c[1] * 0.45; d[4 * i + 2] = d[4 * i + 2] * 0.55 + c[2] * 0.45; } }
  ctx.putImageData(img, 0, 0);
  // thicken outlines for small screens
  ctx.lineWidth = Math.max(2, s.width / 500);
  s.rejected.forEach(q => { ctx.fillStyle = '#ffffffaa'; ctx.fillRect(q.x - 3, q.y - 3, 6, 6); });
  if (tester.on) tester.drawMarks(ctx, s);
}
function hex(h) { return [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)); }

function pickOnPhoto(ev) {
  const s = state.samples[state.current]; if (!s) return; const cv = $('photo'); const r = cv.getBoundingClientRect();
  const x = Math.round((ev.clientX - r.left) / r.width * s.width), y = Math.round((ev.clientY - r.top) / r.height * s.height);
  if (tester.on) { tester.tap(s, x, y); return; }
  let id = s.labelMap[y * s.width + x];
  if (!id) { let bd = 1e9; const tol = (s.params.beanRadius * 1.6) ** 2; s.beans.forEach(b => { const d = (b.x - x) ** 2 + (b.y - y) ** 2; if (d < bd && d < tol) { bd = d; id = b.id; } }); }
  const b = s.beans.find(q => q.id === id); select(b || null);
}
function select(b) {
  state.selected = b; const el = $('beanInfo');
  if (!b) el.textContent = 'No bean here — tap inside a bean outline.';
  else el.innerHTML = `<b>Bean #${b.id}</b> (sample ${b.sample}) · <span class="sw" style="background:${bandColor(b.band)}"></span> <b>${b.band}</b>, Agtron-like ${b.agtron}${b.outlier ? ` · <b class="warn">${b.outlier}</b>` : ''}<br>L* ${b.L} · a* ${b.a} · b* ${b.b} · hue ${b.hue}° · area ${b.area}px · z ${b.z}`;
  drawPhoto(); drawMap();
}

function setupCanvas(cv, hRatio) { const w = Math.min(940, cv.parentElement.clientWidth - 4); const dpr = window.devicePixelRatio || 1; const h = Math.round(w * hRatio);
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px'; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); return { ctx, w, h }; }

let mapGeom = null;
function drawMap() {
  const rep = state.report; const cv = $('map'); const narrow = cv.parentElement.clientWidth < 520;
  const { ctx, w, h } = setupCanvas(cv, narrow ? 1.05 : 0.6);
  const beans = rep.beans; const cal = state.cal;
  const Ls = beans.map(b => b.L), bs = beans.map(b => b.b);
  const Lmin = Math.floor(Math.min(...Ls, 25) - 2), Lmax = Math.ceil(Math.max(...Ls, 65) + 2), bmin = Math.floor(Math.min(...bs) - 2), bmax = Math.ceil(Math.max(...bs) + 2);
  const m = { l: 44, r: narrow ? 74 : 92, t: 10, b: 36 };
  const X = v => m.l + (v - bmin) / (bmax - bmin) * (w - m.l - m.r), Y = L => h - m.b - (L - Lmin) / (Lmax - Lmin) * (h - m.t - m.b);
  // band strips: invert agtron->L
  const LfromA = A => cal.L1 + (A - cal.A1) * (cal.L2 - cal.L1) / (cal.A2 - cal.A1);
  ctx.font = `${narrow ? 11 : 12}px system-ui`;
  BANDS.forEach((bd, i) => { const top = i === 0 ? 200 : BANDS[i - 1].min, bot = bd.min; let y1 = Y(Math.min(Lmax, LfromA(top))), y2 = Y(Math.max(Lmin, LfromA(Math.max(bot, -50))));
    if (y2 <= m.t || y1 >= h - m.b) return; y1 = Math.max(m.t, y1); y2 = Math.min(h - m.b, y2);
    ctx.fillStyle = bd.color + '33'; ctx.fillRect(m.l, y1, w - m.l - m.r, y2 - y1); ctx.fillStyle = bd.color; ctx.fillRect(w - m.r + 2, y1, 6, y2 - y1);
    if (y2 - y1 > 12) { ctx.fillStyle = '#2b1a10'; ctx.fillText(bd.name, w - m.r + 11, (y1 + y2) / 2 + 4); } });
  ctx.strokeStyle = '#0002'; ctx.fillStyle = '#7a6656';
  for (let L = Math.ceil(Lmin / 10) * 10; L <= Lmax; L += 10) { ctx.beginPath(); ctx.moveTo(m.l, Y(L)); ctx.lineTo(w - m.r, Y(L)); ctx.stroke(); ctx.fillText(L, 8, Y(L) + 4); }
  for (let v = Math.ceil(bmin / 5) * 5; v <= bmax; v += 5) ctx.fillText(v, X(v) - 6, h - m.b + 16);
  ctx.fillText('b* (yellowness) →', w / 2 - 50, h - 4); ctx.save(); ctx.translate(12, h / 2 + 40); ctx.rotate(-Math.PI / 2); ctx.fillText('L* lightness', 0, 0); ctx.restore();
  const r = narrow ? 2.4 : 3;
  beans.forEach(b => { ctx.fillStyle = bandColor(b.band); ctx.globalAlpha = b.sample === state.current + 1 ? 0.95 : 0.45; ctx.beginPath(); ctx.arc(X(b.b), Y(b.L), r, 0, 7); ctx.fill(); });
  ctx.globalAlpha = 1;
  if (state.selected) { const b = state.selected; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(b.b), Y(b.L), 7, 0, 7); ctx.stroke(); ctx.lineWidth = 1; }
  mapGeom = { X, Y };
  ctx.fillStyle = '#2b1a10'; const mL = rep.combined.meanL; ctx.setLineDash([5, 4]); ctx.strokeStyle = '#2b1a10'; ctx.beginPath(); ctx.moveTo(m.l, Y(mL)); ctx.lineTo(w - m.r, Y(mL)); ctx.stroke(); ctx.setLineDash([]); ctx.fillText('batch mean', m.l + 4, Y(mL) - 4);
}
function pickOnMap(ev) {
  if (!mapGeom) return; const r = $('map').getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top;
  let best = null, bd = 400; state.report.beans.forEach(b => { const d = (mapGeom.X(b.b) - x) ** 2 + (mapGeom.Y(b.L) - y) ** 2; if (d < bd) { bd = d; best = b; } });
  if (best) { state.current = best.sample - 1; render(); select(best); $('photo').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function drawHist() {
  const rep = state.report; const cv = $('hist'); const { ctx, w, h } = setupCanvas(cv, 0.42);
  const ags = rep.beans.map(b => b.agtron); const lo = Math.floor(Math.min(...ags) / 2.5) * 2.5, hi = Math.ceil(Math.max(...ags) / 2.5) * 2.5 + 2.5; const nb = Math.round((hi - lo) / 2.5);
  const cnt = new Array(nb).fill(0); ags.forEach(a => cnt[Math.min(nb - 1, Math.floor((a - lo) / 2.5))]++); const mx = Math.max(...cnt);
  const m = { l: 34, r: 8, t: 8, b: 34 }; const bw = (w - m.l - m.r) / nb;
  cnt.forEach((c, i) => { const a = lo + (i + 0.5) * 2.5; ctx.fillStyle = BANDS[bandOf(a)].color; const bh = c / mx * (h - m.t - m.b); ctx.fillRect(m.l + i * bw + 0.5, h - m.b - bh, bw - 1, bh); });
  ctx.fillStyle = '#7a6656'; ctx.font = '11px system-ui';
  for (let a = Math.ceil(lo / 10) * 10; a <= hi; a += 10) ctx.fillText(a, m.l + (a - lo) / 2.5 * bw - 6, h - m.b + 14);
  ctx.fillText('Agtron-like (← darker · lighter →)', w / 2 - 90, h - 4); ctx.fillText(mx, 4, m.t + 10);
  const mean = rep.combined.meanAgtron; const xm = m.l + (mean - lo) / 2.5 * bw; ctx.strokeStyle = '#000'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(xm, m.t); ctx.lineTo(xm, h - m.b); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#000'; ctx.fillText(`mean ${mean}`, Math.min(w - 70, xm + 4), m.t + 12);
}

function drawTable() {
  const rep = state.report; const rows = rep.perSample.map((p, i) => { const c = rep.consistency.perSample[i];
    return `<tr><td>${p.sample}. ${esc(p.name || '')}</td><td>${p.n}</td><td>${p.meanL}</td><td>${p.meanAgtron} ± ${p.sdAgtron}</td><td>${p.band}</td><td>${p.uniformityPct}%</td><td>${p.outliers}</td><td>${c.deltaAgtron > 0 ? '+' : ''}${c.deltaAgtron}</td></tr>`; }).join('');
  const c = rep.combined;
  $('perSample').innerHTML = `<tr><th>Sample</th><th>Beans</th><th>L*</th><th>Agtron ± SD</th><th>Band</th><th>Unif.</th><th>Outl.</th><th>Δ vs batch</th></tr>${rows}<tr><th>Batch</th><th>${c.n}</th><th>${c.meanL}</th><th>${c.meanAgtron} ± ${c.sdAgtron}</th><th>${c.band}</th><th>${c.uniformityPct}%</th><th>${c.outliers}</th><th></th></tr>`;
  $('verdict').innerHTML = `Sample-to-sample: <b>${rep.consistency.verdict}</b> (means span ${rep.consistency.meanRange} Agtron-like points; within ~3 is what you expect from random sampling + lighting).`;
}
function drawOutliers() {
  const all = state.report.beans.filter(b => b.outlier); const c = state.report.combined;
  if (!all.length) { $('outliers').innerHTML = '<p>No outlier beans.</p>'; return; }
  const kinds = [['quaker', 'Quakers — very pale, yellow-tan, no roast development'], ['underdeveloped', 'Underdeveloped — ≥2 bands lighter than the batch'], ['scorched/dark', 'Scorched/dark — ≥2 bands darker than the batch']];
  $('outliers').innerHTML = `<p><b>${all.length}</b> of ${c.n} beans (${c.outlierPct}%) are ≥2 roast bands away from the batch median. White outlines on the photo. Tap a bean to locate it.</p>` +
    kinds.map(([k, label]) => { const o = all.filter(b => b.outlier === k).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      return `<details><summary>${label}: <b>&nbsp;${o.length}</b></summary><div class="ol">${o.slice(0, 40).map(b => `<button data-s="${b.sample}" data-id="${b.id}">S${b.sample} #${b.id} · ${b.agtron}</button>`).join('')}${o.length > 40 ? `<span class="muted">…and ${o.length - 40} more (see CSV)</span>` : ''}</div></details>`; }).join('');
}
function calUI() { const c = state.cal; $('L1').value = c.L1; $('A1').value = c.A1; $('L2').value = c.L2; $('A2').value = c.A2;
  $('calState').textContent = c.provisional ? 'Using the provisional default (not calibrated). Treat band names as indicative only.' : 'Using your calibration (saved on this device).'; }

function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function exportCSV() { const cols = ['sample', 'id', 'x', 'y', 'area', 'L', 'a', 'b', 'C', 'hue', 'agtron', 'band', 'z', 'outlier'];
  download('roast-beans.csv', [cols.join(','), ...state.report.beans.map(b => cols.map(c => b[c] ?? '').join(','))].join('\n'), 'text/csv'); }
function exportJSON() { const r = state.report; const out = { generated: new Date().toISOString(), calibration: state.cal, perSample: r.perSample, combined: r.combined, consistency: r.consistency,
  samples: state.samples.map(s => ({ name: s.name, width: s.width, height: s.height, params: s.params, rejected: s.rejected.length })), beans: r.beans };
  download('roast-report.json', JSON.stringify(out, null, 1), 'application/json'); }

// ---------- events ----------
$('files').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; addSources(f.map(x => ({ src: x, name: x.name }))); });
$('demo').addEventListener('click', () => { state.samples = []; addSources([1, 2, 3, 4].map(i => ({ src: `demo/sample${i}.jpg`, name: `sample${i}.jpg` }))); });
$('clear').addEventListener('click', () => { state.samples = []; state.selected = null; recompute(); render(); $('report').hidden = true; $('clear').hidden = true; status(''); });
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.current = +b.dataset.i; state.selected = null; render(); });
$('photo').addEventListener('click', pickOnPhoto);
$('map').addEventListener('click', pickOnMap);
$('showOverlay').addEventListener('change', drawPhoto);
$('zoom').addEventListener('click', () => { const z = $('photo').classList.toggle('zoomed'); $('zoom').textContent = z ? 'Fit to screen' : '🔍 Zoom 2×'; $('zoom').setAttribute('aria-pressed', z); });
window.__report = () => state.report && { calibration: state.cal, perSample: state.report.perSample, combined: state.report.combined, consistency: state.report.consistency,
  samples: state.samples.map(s => ({ name: s.name, width: s.width, height: s.height, params: s.params, rejected: s.rejected.length })), beans: state.report.beans };
$('outliers').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const bean = state.report.beans.find(q => q.sample === +b.dataset.s && q.id === +b.dataset.id); state.current = bean.sample - 1; render(); select(bean); $('photo').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('csv').addEventListener('click', exportCSV); $('json').addEventListener('click', exportJSON);
$('saveCal').addEventListener('click', () => { const c = { L1: +$('L1').value, A1: +$('A1').value, L2: +$('L2').value, A2: +$('A2').value };
  if (![c.L1, c.A1, c.L2, c.A2].every(isFinite) || c.L1 === c.L2) { $('calState').textContent = 'Enter two different L* values.'; return; }
  state.cal = c; localStorage.setItem('roastCal', JSON.stringify(c)); recompute(); render(); });
$('resetCal').addEventListener('click', () => { localStorage.removeItem('roastCal'); state.cal = { ...DEFAULT_CAL }; recompute(); render(); });
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.report) { drawMap(); drawHist(); } }, 200); });
if (new URLSearchParams(location.search).has('demo')) $('demo').click();
calUI();
tester.init({ state, drawPhoto, status, version: () => state.detector?.version || ALGO_VERSION + '.0' });
swipe.init({ state, version: () => state.detector?.version || ALGO_VERSION + '.0' });
function showDetector() { const d = state.detector, el = $('detector'); if (!el) return;
  if (!d) { el.innerHTML = `Detector ${ALGO_VERSION} (default parameters)`; return; }
  const b = d.benchmark || {};
  el.innerHTML = `<b>Detector v${d.version}</b> · benchmark F1 <b>${b.f1}</b> (precision ${b.precision}, recall ${b.recall}) on ${b.truthBeans} beans of the seed tile (one annotator, started from detector output — not an independent test yet) · tuned ${d.date}`;
  fetch('changelog.json', { cache: 'no-cache' }).then(r => r.json()).then(cl => { $('changelog').innerHTML = cl.slice(0, 6).map(c => `<li><b>${esc(c.version)}</b> (${esc(c.date)}): ${esc(c.text)}</li>`).join(''); }).catch(() => {}); }

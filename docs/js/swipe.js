// Tinder-style bean review: one bean card at a time. Right = correct, left = wrong (+ one reason chip), up = skip.
import { selectCards, siblingOf, makeRecord, validateBatch, paramsHash, BATCH_SCHEMA, COLOUR_PIPELINE_VERSION, KNOWN_IMAGES } from './swipe-core.js';
import { FEEDBACK_ENDPOINT, CARDS_PER_SESSION } from './config.js';

const $ = id => document.getElementById(id);
const OUTBOX = 'ra-swipe-outbox', SENDPHOTO = 'ra-swipe-send-photo', GAP_TILES = 4, REQUEUE = sha => 'ra-swipe-requeue:' + sha, SEEN = sha => 'ra-swipe-seen:' + sha;
const CHIP_MS = 2000, LONG_MS = 450;
let api, S = null, tintEl = null; // session
const tint = () => (tintEl ||= document.getElementById('tint'));

// ---------- corrected crop rendering (same flat-field + white balance as the analyser, fixed sRGB tone curve) ----------
const s2l = new Float32Array(256).map((_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const l2s = v => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
const TONE = new Uint8ClampedArray(4097).map((_, i) => l2s(i / 4096)); // fixed curve, identical for every card
function renderCrop(s, bean, sibling, size) {
  const R = s.params.beanRadius, half = Math.round(R * 3); // bean ≈ 1/3 of the card, ~1.5× context around its outline
  const x0 = Math.max(0, Math.round(bean.x) - half), y0 = Math.max(0, Math.round(bean.y) - half);
  const x1 = Math.min(s.width, Math.round(bean.x) + half), y1 = Math.min(s.height, Math.round(bean.y) + half), w = x1 - x0, h = y1 - y0;
  const src = s.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h), d = src.data;
  const ff = s.params.flatField, sc = Math.max(s.width, s.height), cx = s.width / 2, cy = s.height / 2;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const i = 4 * (yy * w + xx), nx = (x0 + xx - cx) / sc, ny = (y0 + yy - cy) / sc;
    for (let c = 0; c < 3; c++) { const f = ff ? ff[c] : [0.8, 0, 0]; const g = 0.8 / Math.max(0.02, f[0] + f[1] * nx + f[2] * ny); d[i + c] = TONE[Math.min(4096, (s2l[d[i + c]] * g * 4096) | 0)]; } }
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h; tmp.getContext('2d').putImageData(src, 0, 0);
  const cv = document.createElement('canvas'); const dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = cv.height = Math.round(size * dpr);
  const ctx = cv.getContext('2d'); const k = cv.width / (2 * half); ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(tmp, (x0 - (Math.round(bean.x) - half)) * k, (y0 - (Math.round(bean.y) - half)) * k, w * k, h * k);
  const P = q => [(q.x - (Math.round(bean.x) - half)) * k, (q.y - (Math.round(bean.y) - half)) * k];
  ctx.lineWidth = Math.max(3, cv.width / 110);
  const [bx, by] = P(bean);
  if (sibling) { const [sx, sy] = P(sibling); ctx.setLineDash([]); ctx.lineWidth = Math.max(1.5, cv.width / 300); ctx.strokeStyle = '#d4d4d4cc'; ctx.beginPath(); ctx.arc(sx, sy, R * 1.25 * k, 0, 7); ctx.stroke(); }
  // one bold ring on the subject (dark halo + yellow) so it reads on light and dark beans
  ctx.lineWidth = Math.max(7, cv.width / 55); ctx.strokeStyle = '#000b'; ctx.beginPath(); ctx.arc(bx, by, R * 1.4 * k, 0, 7); ctx.stroke();
  ctx.lineWidth = Math.max(4, cv.width / 90); ctx.strokeStyle = '#ffe14d'; ctx.stroke();
  return cv;
}

// ---------- session ----------
function cur() { return api.state.samples[api.state.current]; }
const readJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
async function start() {
  const s = cur(); if (!s || !s.beans.length) return;
  const requeue = readJ(REQUEUE(s.sha256), []), seen = readJ(SEEN(s.sha256), []);
  const seed = (Date.now() ^ parseInt(s.sha256.slice(0, 8), 16)) >>> 0;
  // beans left "wrong, unspecified" last time come back first (same random/targeted tag), then a fresh 70/30 pick
  const back = requeue.map(r => ({ id: r.id, pick: r.pick, requeued: true })).filter(c => s.beans.some(b => b.id === c.id)).slice(0, 5);
  const fresh = selectCards(s.beans, CARDS_PER_SESSION - back.length, { seed, exclude: [...back.map(c => c.id), ...(seen.length < s.beans.length - CARDS_PER_SESSION ? seen : [])] });
  const det = api.state.detector;
  S = { s, cards: [...back, ...fresh], i: 0, answers: [], history: [], missed: [], seed, R: s.params.beanRadius,
    version: api.version(), phash: await paramsHash(det?.params || null), params: det?.params || {}, cache: new Map(), id: `${new Date().toISOString().slice(0, 10)}-${s.sha256.slice(0, 8)}-${seed.toString(36)}` };
  $('swipe').hidden = false; document.body.classList.add('noscroll'); show();
}
function close() { clearTimeout(S?.chipTimer); if (S?.pendingSend) { clearTimeout(S.pendingSend); S.pendingSend = null; flush(); } $('swipe').hidden = true; document.body.classList.remove('noscroll'); S = null; }
function cardCanvas(k) {
  if (k >= S.cards.length) return null; if (S.cache.has(k)) return S.cache.get(k);
  const b = S.s.beans.find(q => q.id === S.cards[k].id), sib = siblingOf(b, S.s.beans, S.R);
  // outline the neighbour only for a likely split: this detection AND the neighbour are both clearly smaller than a typical
  // bean and they touch. A whole neighbour next to a small bean is never outlined.
  const showSib = sib && (b.sizeRatio ?? 1) < 0.7 && (sib.sizeRatio ?? 1) < 0.85 && Math.hypot(sib.x - b.x, sib.y - b.y) < 1.6 * S.R;
  const size = Math.min(window.innerWidth * 0.7, window.innerHeight * 0.55, 620);
  const c = { bean: b, sib, cv: renderCrop(S.s, b, showSib ? sib : null, size) }; S.cache.set(k, c); return c;
}
function show() {
  clearTimeout(S.chipTimer); $('chips').hidden = true; $('mergeMore').hidden = true; $('swButtons').hidden = false;
  const n = S.cards.length; $('swProgress').textContent = `${Math.min(S.i + 1, n)}/${n}`; $('swBar').style.width = `${100 * S.i / n}%`; $('swUndo').disabled = !S.history.length;
  if (S.i >= n) return gaps();
  $('gaps').hidden = true; $('done').hidden = true; $('deck').hidden = false;
  const c = cardCanvas(S.i); const card = $('card'); card.replaceChildren(c.cv); card.style.transform = ''; card.style.transition = ''; tint().style.opacity = 0;
  card.append(tint());
  // render the next one now so it is ready well under 150 ms
  (window.requestIdleCallback || setTimeout)(() => S && cardCanvas(S.i + 1));
}
function answer(kind, reason = null, mergeN = null) {
  const c = cardCanvas(S.i), card = S.cards[S.i];
  const rec = makeRecord({ image: { sha256: S.s.sha256 }, bean: c.bean, sibling: c.sib, detectorVersion: S.version, paramsHash: S.phash, answer: kind, reason, mergeN, pick: card.pick, R: S.R });
  if (card.requeued) rec.requeued = true;
  S.history.push({ i: S.i, n: S.answers.length }); S.answers.push(rec); S.i++; show();
}
function fly(dir, then) {
  const card = $('card'); const dx = dir === 'left' ? -1.4 : dir === 'right' ? 1.4 : 0, dy = dir === 'up' ? -1.4 : 0;
  card.style.transition = 'transform .16s ease-out'; card.style.transform = `translate(${dx * window.innerWidth}px, ${dy * window.innerHeight}px) rotate(${dx * 20}deg)`;
  setTimeout(then, 160);
}
function right() { if (busy()) return; fly('right', () => answer('correct')); }
function up() { if (busy()) return; fly('up', () => answer('skip')); }
function left() { if (busy()) return; fly('left', () => { // card stays answered-as-wrong until a chip (or 2 s) says why
  const card = $('card'); card.style.transition = 'transform .12s'; card.style.transform = 'scale(.8)'; tint().style.background = '#dc2626'; tint().style.opacity = 0.35;
  $('swButtons').hidden = true; $('chips').hidden = false; $('chipBar').style.animation = 'none'; void $('chipBar').offsetWidth; $('chipBar').style.animation = `chipcount ${CHIP_MS}ms linear forwards`;
  S.chipTimer = setTimeout(() => answer('wrong', 'unspecified'), CHIP_MS); }); }
const busy = () => !S || S.i >= S.cards.length || !$('chips').hidden;
function chip(reason, mergeN) { clearTimeout(S.chipTimer); answer('wrong', reason, mergeN); }
function undo() {
  if (!S) return; clearTimeout(S.chipTimer);
  if (!$('chips').hidden) { show(); return; } // mid-chip: just bring the card back
  if (!$('gaps').hidden) { const mine = S.tileMissed[S.gi]; if (mine.length) { mine.pop(); drawGaps(); return; } if (S.gi > 0) { S.gi--; gaps(); return; } S.gap = null; }
  const h = S.history.pop(); if (!h) return; S.answers.length = h.n; S.i = h.i; show();
}

// ---------- drag ----------
function setupDrag() {
  const card = $('card'); let p = null;
  card.addEventListener('pointerdown', e => { if (busy()) return; p = { x: e.clientX, y: e.clientY }; card.setPointerCapture(e.pointerId); card.style.transition = ''; });
  card.addEventListener('pointermove', e => { if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 40)}px) rotate(${dx / 18}deg)`;
    const t = tint(); const up = -dy > Math.abs(dx); t.style.background = up ? '#64748b' : dx > 0 ? '#16a34a' : '#dc2626'; t.style.opacity = Math.min(0.45, Math.max(Math.abs(dx), up ? -dy : 0) / 300); });
  const end = e => { if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y, th = Math.min(110, window.innerWidth * 0.22); p = null;
    if (-dy > th && -dy > Math.abs(dx)) up(); else if (dx > th) right(); else if (dx < -th) left();
    else { card.style.transition = 'transform .15s'; card.style.transform = ''; tint().style.opacity = 0; } };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}

// ---------- gap tiles (missed beans -> FN with locations) ----------
// The pile is cut into tiles of ~8 bean radii. Gap area = pixels inside the pile's tiles not covered by a detection.
// The GAP_TILES tiles with the most gap area are shown one per screen; the rest of the gap area is unreviewed and the
// miss estimate is scaled by the reviewed share (reviewedShare in swipe-core).
export function gapTiles(s, n = GAP_TILES) {
  const R = s.params.beanRadius, T = Math.round(8 * R), lm = s.labelMap, w = s.width, tiles = [];
  for (let y0 = 0; y0 + T / 2 < s.height; y0 += T) for (let x0 = 0; x0 + T / 2 < w; x0 += T) {
    const x1 = Math.min(w, x0 + T), y1 = Math.min(s.height, y0 + T);
    const nDet = s.beans.filter(b => b.x >= x0 && b.x < x1 && b.y >= y0 && b.y < y1).length; if (nDet < 3) continue; // outside the pile
    let gap = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if (!lm[y * w + x]) gap += 4;
    tiles.push({ rect: [x0, y0, x1, y1], gapArea: gap, nDet }); }
  // keep tiles inside the pile (at least the median bean density) so empty plate at the rim doesn't win
  const dens = tiles.map(t => t.nDet).sort((a, b) => a - b), medD = dens[dens.length >> 1] || 0;
  tiles.splice(0, tiles.length, ...tiles.filter(t => t.nDet >= medD).map(({ nDet, ...t }) => t));
  const total = tiles.reduce((t, g) => t + g.gapArea, 0);
  return { total, tiles: [...tiles].sort((a, b) => b.gapArea - a.gapArea).slice(0, n) };
}
function gaps() {
  if (!S.gap) { S.gap = gapTiles(S.s); S.gi = 0; S.tileMissed = S.gap.tiles.map(() => []); }
  if (S.gi >= S.gap.tiles.length) return finish();
  $('deck').hidden = true; $('swButtons').hidden = true; $('gaps').hidden = false; $('done').hidden = true;
  $('swProgress').textContent = `Missed any? ${S.gi + 1}/${S.gap.tiles.length}`; $('swBar').style.width = '100%'; $('swUndo').disabled = false;
  S.missedScreenShown = true; drawGaps();
}
function drawGaps() {
  const s = S.s, R = S.R, [x0, y0, x1, y1] = S.gap.tiles[S.gi].rect, cv = $('gapCanvas'), size = Math.min(window.innerWidth - 24, window.innerHeight * 0.62, 760);
  const dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = cv.height = Math.round(size * dpr); cv.style.width = cv.style.height = size + 'px';
  const k = cv.width / Math.max(x1 - x0, y1 - y0), ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(s.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, (x1 - x0) * k, (y1 - y0) * k);
  // found beans get a dark dot; anything bean-shaped without one is a miss
  ctx.fillStyle = '#000000b0'; ctx.strokeStyle = '#fff8'; ctx.lineWidth = 2;
  s.beans.forEach(b => { if (b.x < x0 - R || b.x > x1 + R || b.y < y0 - R || b.y > y1 + R) return; ctx.beginPath(); ctx.arc((b.x - x0) * k, (b.y - y0) * k, R * 0.45 * k, 0, 7); ctx.fill(); ctx.stroke(); });
  const mine = S.tileMissed[S.gi]; ctx.lineWidth = Math.max(4, cv.width / 120);
  mine.forEach(m => { ctx.strokeStyle = '#22c55e'; ctx.beginPath(); ctx.arc((m.x - x0) * k, (m.y - y0) * k, R * 1.2 * k, 0, 7); ctx.stroke(); });
  $('gapsDone').textContent = mine.length ? `Next ✓ (${mine.length} marked)` : 'None ✓';
}
function tapGap(e) {
  const [x0, y0, x1, y1] = S.gap.tiles[S.gi].rect, cv = $('gapCanvas'), r = cv.getBoundingClientRect(), sc = Math.max(x1 - x0, y1 - y0);
  const x = Math.round(x0 + (e.clientX - r.left) / r.width * sc), y = Math.round(y0 + (e.clientY - r.top) / r.height * sc); if (x >= x1 || y >= y1) return;
  const mine = S.tileMissed[S.gi], j = mine.findIndex(m => (m.x - x) ** 2 + (m.y - y) ** 2 < (S.R * 1.3) ** 2);
  if (j >= 0) mine.splice(j, 1); else mine.push({ x, y }); drawGaps();
}
function nextTile() { S.gi++; gaps(); }

// ---------- finish: store, queue, send ----------
function photoDataURL(s) { for (const q of [0.85, 0.7, 0.55]) { const u = s.canvas.toDataURL('image/jpeg', q); if (u.length < 1.4e6) return u; } return null; }
async function finish() {
  const s = S.s, missed = S.tileMissed.flat();
  const batch = { schema: BATCH_SCHEMA, id: S.id, createdAt: new Date().toISOString(), image: { name: s.name, sha256: s.sha256, width: s.width, height: s.height, ...(s.demoPath ? { path: s.demoPath } : {}) },
    beanRadius: S.R, detectorVersion: S.version, paramsHash: S.phash, params: S.params, seed: S.seed, detectionsOnPlate: s.beans.length,
    colourPipelineVersion: COLOUR_PIPELINE_VERSION, colorSpace: 'srgb', wbGains: s.params.wbGains || [1, 1, 1],
    answers: S.answers, missed, gapTiles: S.gap.tiles.map((g, i) => ({ rect: g.rect, gapArea: g.gapArea, missed: S.tileMissed[i].length })), totalGapArea: S.gap.total, missedScreenShown: !!S.missedScreenShown };
  const latest = new Map(); S.answers.forEach(a => latest.set(a.beanId, a));
  localStorage.setItem(REQUEUE(s.sha256), JSON.stringify([...latest.values()].filter(a => a.reason === 'unspecified').map(a => ({ id: a.beanId, pick: a.pick }))));
  localStorage.setItem(SEEN(s.sha256), JSON.stringify([...new Set([...readJ(SEEN(s.sha256), []), ...latest.keys()])]));
  $('gaps').hidden = true; $('done').hidden = false; $('swUndo').disabled = true; $('swProgress').textContent = 'Done';
  if (!S.answers.length) { $('doneMsg').textContent = 'No answers to save.'; $('photoToggle').hidden = true; return; }
  const problems = validateBatch(batch); if (problems.length) { $('doneMsg').textContent = 'Could not save: ' + problems.join(', '); return; }
  // own photos must travel with the answers or they cannot be scored; demo photos are already in the repo
  // the photo toggle only exists once sending does (FEEDBACK_ENDPOINT set); in the on-device release it stays hidden
  const needsPhoto = !KNOWN_IMAGES.includes(s.sha256); $('photoToggle').hidden = !(needsPhoto && FEEDBACK_ENDPOINT); $('sendPhoto').checked = readJ(SENDPHOTO, true);
  const box = readJ(OUTBOX, []); box.push({ batch, sent: false, needsPhoto, photo: needsPhoto ? photoDataURL(s) : null }); try { localStorage.setItem(OUTBOX, JSON.stringify(box)); } catch { box.at(-1).photo = null; localStorage.setItem(OUTBOX, JSON.stringify(box)); }
  $('doneMsg').textContent = FEEDBACK_ENDPOINT ? 'Saved ✓' : 'Saved on this device · use Export answers to share them'; // any upload runs in the background via the outbox; never blocks
  S.pendingSend = setTimeout(sendNow, 5000); // a moment to switch the photo toggle; leaving the screen sends at once (in the background)
}
function sendNow() { if (!S?.pendingSend) return; clearTimeout(S.pendingSend); S.pendingSend = null; uploadInBackground(); }
async function uploadInBackground() {
  const done = $('doneMsg'); const ok = await flush(); const box = readJ(OUTBOX, []), left = box.filter(b => !b.sent).length, rej = box.find(b => !b.sent && b.rejected);
  if ($('done').hidden) return;
  if (!FEEDBACK_ENDPOINT) return; // nothing is sent in this release; the message stays 'Saved on this device · use Export answers…'
  done.textContent = ok && !left ? 'Saved ✓ · sent' : rej ? `Saved ✓ on this device · not sent: ${rej.rejected}` : `Saved ✓ · will send later (${left} waiting)`;
}
let flushing = null;
export function flush() { return flushing ||= doFlush().finally(() => { flushing = null; }); }
async function doFlush() {
  const box = readJ(OUTBOX, []); if (!FEEDBACK_ENDPOINT || !navigator.onLine) return false; let all = true;
  for (const item of box) { if (item.sent) continue;
    try { const r = await fetch(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.needsPhoto && readJ(SENDPHOTO, true) && item.photo ? { ...item.batch, photo: item.photo } : item.batch) });
      if (r.ok || r.status === 409) { item.sent = new Date().toISOString(); item.photo = null; } else { all = false; if (r.status === 400 || r.status === 422) item.rejected = ((await r.json().catch(() => ({}))).detail || 'rejected by server').slice(0, 200); } } catch { all = false; } }
  localStorage.setItem(OUTBOX, JSON.stringify(box.filter(b => !b.sent || Date.now() - Date.parse(b.sent) < 30 * 864e5))); return all;
}
function exportAll() {
  const box = readJ(OUTBOX, []); const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(box.map(b => b.batch), null, 1)], { type: 'application/json' })); a.download = `roast-swipe-answers-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function init(a) {
  api = a; tintEl = document.getElementById('tint');
  $('swipeStart').addEventListener('click', start);
  $('swClose').addEventListener('click', close);
  $('swUndo').addEventListener('click', undo);
  $('btnLeft').addEventListener('click', left); $('btnRight').addEventListener('click', right); $('btnUp').addEventListener('click', up);
  // chips: tap = answer; "Two beans" long-press offers 3 / 4+
  $('chips').addEventListener('click', e => { const b = e.target.closest('button[data-r]'); if (!b || b.dataset.long === '1') { if (b) b.dataset.long = ''; return; } chip(b.dataset.r, b.dataset.n ? (b.dataset.n === '4+' ? '4+' : +b.dataset.n) : (b.dataset.r === 'two-beans' ? 2 : null)); });
  const two = $('chipTwo'); let lt;
  two.addEventListener('pointerdown', () => { lt = setTimeout(() => { two.dataset.long = '1'; clearTimeout(S.chipTimer); $('chipBar').style.animation = 'none'; $('mergeMore').hidden = false; }, LONG_MS); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => two.addEventListener(ev, () => clearTimeout(lt)));
  two.addEventListener('contextmenu', e => e.preventDefault());
  $('gapCanvas').addEventListener('click', tapGap);
  $('gapsDone').addEventListener('click', nextTile);
  $('sendPhoto').addEventListener('change', e => localStorage.setItem(SENDPHOTO, JSON.stringify(e.target.checked)));
  $('swExport').addEventListener('click', exportAll);
  $('swAgain').addEventListener('click', () => { sendNow(); close(); start(); });
  $('swDoneClose').addEventListener('click', () => { sendNow(); close(); });
  document.addEventListener('keydown', e => { if (!S || $('swipe').hidden) return; if (e.key === 'ArrowRight') right(); else if (e.key === 'ArrowLeft') left(); else if (e.key === 'ArrowUp') up(); else if (e.key === 'Escape') close(); else if (e.key === 'z' || e.key === 'Backspace') undo(); });
  setupDrag();
  window.addEventListener('online', flush); flush();
}
export function update() { const s = cur(); $('swipeStart').hidden = !s; }

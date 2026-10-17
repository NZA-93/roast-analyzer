// "Test detection" mode: user corrections -> ground truth -> live precision/recall -> feedback for the tuner.
import { BANDS } from './analyzer.js';
import { emptyCorrections, buildTruth, score, makeGroundTruthFile, GT_SCHEMA } from './evaluate.js';

const REPO = 'NZA-93/roast-analyzer';
const $ = id => document.getElementById(id);
const KEY = sha => 'ra-gt:' + sha;
const TOOLS = {
  missed: { label: '＋ Missed bean', help: 'Tap a bean the detector did not outline.' },
  false: { label: '✕ Not a bean', help: 'Tap an outline that is a crumb, a gap or glare.' },
  merged: { label: '⧉ Merged', help: 'Tap an outline that covers 2 or more beans.' },
  split: { label: '÷ Split', help: 'Tap an outline that is only a piece of a bean (another outline has the rest).' },
  band: { label: '🎨 Band', help: 'Pick the correct band, then tap the bean.' },
  area: { label: '▭ Area', help: 'Optional: tap two corners to limit the check to the part you reviewed.' },
};
let api, on = false, tool = 'missed', undo = [];
const t = { get on() { return on; }, init, update, drawMarks, tap };
export const tester = t;

function load(s) { try { const j = JSON.parse(localStorage.getItem(KEY(s.sha256))); if (j?.corrections) return j; } catch {} return { corrections: emptyCorrections(), roi: null }; }
function save(s, rec) { localStorage.setItem(KEY(s.sha256), JSON.stringify({ ...rec, name: s.name, width: s.width, height: s.height, demoPath: s.demoPath, updated: new Date().toISOString() })); }
function cur() { const s = api.state.samples[api.state.current]; if (s && !s._gt) s._gt = load(s); return s; }
const R = s => s.params.beanRadius;

function init(a) {
  api = a;
  $('testToggle').addEventListener('click', () => { on = !on; $('testToggle').setAttribute('aria-pressed', on); $('testToggle').textContent = on ? '✓ Done testing' : '🧪 Test detection'; $('tester').hidden = !on; api.drawPhoto(); update(); });
  $('tools').innerHTML = Object.entries(TOOLS).map(([k, v]) => `<button data-tool="${k}" aria-pressed="${k === tool}">${v.label}</button>`).join('');
  $('tools').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; tool = b.dataset.tool; [...$('tools').children].forEach(c => c.setAttribute('aria-pressed', c === b)); update(); });
  $('bandPick').innerHTML = BANDS.map(b => `<option>${b.name}</option>`).join('');
  $('undo').addEventListener('click', () => { const s = cur(); const u = undo.pop(); if (!s || !u) return; s._gt = u; save(s, s._gt); api.drawPhoto(); update(); });
  $('resetGt').addEventListener('click', () => { const s = cur(); if (!s || !confirm('Clear all your corrections for this photo?')) return; push(s); s._gt = { corrections: emptyCorrections(), roi: null }; save(s, s._gt); api.drawPhoto(); update(); });
  $('exportGt').addEventListener('click', exportAll);
  $('importGt').addEventListener('change', importFiles);
  $('submitGt').addEventListener('click', submit);
}
function push(s) { undo.push(JSON.parse(JSON.stringify(s._gt))); if (undo.length > 50) undo.shift(); }

function tap(s, x, y) {
  cur(); push(s); const c = s._gt.corrections, r = R(s), tol = r * 0.9;
  const id = s.labelMap[y * s.width + x]; const bean = id ? s.beans.find(b => b.id === id) : null;
  const near = (list) => list.findIndex(p => (p.x - x) ** 2 + (p.y - y) ** 2 < tol * tol);
  const onBean = (list) => bean ? list.findIndex(p => (p.x - bean.x) ** 2 + (p.y - bean.y) ** 2 < 4) : -1;
  const toggle = (list, extra) => { const i = onBean(list); if (i >= 0) list.splice(i, 1); else if (bean) { ['falsePos', 'split', 'merged'].forEach(k => { const j = onBean(c[k]); if (j >= 0) c[k].splice(j, 1); }); list.push({ x: Math.round(bean.x), y: Math.round(bean.y), ...extra }); } else { undo.pop(); api.status('Tap inside an outlined bean for this tool.'); return; } };
  if (tool === 'missed') { const i = near(c.added); if (i >= 0) c.added.splice(i, 1); else { c.added.push({ x, y }); if (bean) api.status('Added. (That spot was inside another outline — fine if the outline swallowed this bean.)'); } }
  else if (tool === 'false') toggle(c.falsePos, { reason: $('reason').value });
  else if (tool === 'merged') toggle(c.merged, { n: +$('mergeN').value || 2 });
  else if (tool === 'split') toggle(c.split, {});
  else if (tool === 'band') { const target = bean || (near(c.added) >= 0 ? c.added[near(c.added)] : null); if (!target) { undo.pop(); return; }
    if (!bean) target.band = $('bandPick').value; else { const i = onBean(c.band); if (i >= 0) c.band.splice(i, 1); c.band.push({ x: Math.round(bean.x), y: Math.round(bean.y), band: $('bandPick').value }); } }
  else if (tool === 'area') { const g = s._gt; if (!g._p || g.roi) { g._p = [x, y]; g.roi = null; } else { g.roi = [Math.min(g._p[0], x), Math.min(g._p[1], y), Math.max(g._p[0], x), Math.max(g._p[1], y)]; delete g._p; } }
  save(s, s._gt); api.drawPhoto(); update();
}

function metrics(s) { const g = s._gt; const truth = buildTruth(s.beans, g.corrections, R(s)); return score(truth, s.beans, R(s), g.roi); }

function update() {
  if (!api) return; const s = cur(); $('testToggle').hidden = !s; if (!on || !s) return;
  $('toolHelp').textContent = TOOLS[tool].help;
  $('reasonWrap').hidden = tool !== 'false'; $('mergeWrap').hidden = tool !== 'merged'; $('bandWrap').hidden = tool !== 'band';
  const c = s._gt.corrections, m = metrics(s); const n = c.added.length + c.falsePos.length + c.merged.length + c.split.length + c.band.length;
  const pct = v => (v * 100).toFixed(1) + '%';
  $('liveMetrics').innerHTML = `<div class="mgrid">
    <div><span>Precision</span><b>${pct(m.precision)}</b></div><div><span>Recall</span><b>${pct(m.recall)}</b></div>
    <div><span>F1</span><b>${pct(m.f1)}</b></div><div><span>Count error</span><b>${m.countError > 0 ? '+' : ''}${pct(m.countError)}</b></div></div>
    <p class="muted">${m.detected} detected vs ${m.truth} true beans ${s._gt.roi ? 'in your area' : 'on the whole photo'} · ${c.added.length} missed, ${c.falsePos.length} not-a-bean, ${c.merged.length} merged, ${c.split.length} split${m.bandChecked ? ` · band agreement ${pct(m.bandAgreement)} (${m.bandChecked} checked)` : ''}.
    ${n ? '' : 'No corrections yet: the numbers read 100% until you mark mistakes.'} ${s._gt._p ? '<b>Tap the second corner.</b>' : ''}</p>`;
  $('submitGt').disabled = !n;
}

function drawMarks(ctx, s) {
  cur(); const g = s._gt, c = g.corrections, r = R(s); const lw = Math.max(2, s.width / 400); ctx.lineWidth = lw; ctx.font = `bold ${Math.round(r * 1.1)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ring = (p, col) => { ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.05, 0, 7); ctx.stroke(); };
  const label = (p, txt, col) => { ctx.fillStyle = '#000a'; ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.75, 0, 7); ctx.fill(); ctx.fillStyle = col; ctx.fillText(txt, p.x, p.y + 1); };
  // faint dot on every detection so the user can see what was found
  ctx.fillStyle = '#ffffffcc'; s.beans.forEach(b => { ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(2, r * 0.13), 0, 7); ctx.fill(); });
  c.added.forEach(p => { ring(p, '#22c55e'); label(p, '+', '#22c55e'); });
  c.falsePos.forEach(p => { ring(p, '#ef4444'); label(p, '✕', '#ef4444'); });
  c.merged.forEach(p => { ring(p, '#38bdf8'); label(p, String(p.n), '#38bdf8'); });
  c.split.forEach(p => { ring(p, '#f59e0b'); label(p, '÷', '#f59e0b'); });
  c.band.forEach(p => { ctx.fillStyle = (BANDS.find(b => b.name === p.band) || BANDS[0]).color; ctx.fillRect(p.x - r * 0.5, p.y + r * 0.6, r, r * 0.35); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(p.x - r * 0.5, p.y + r * 0.6, r, r * 0.35); ctx.lineWidth = lw; });
  if (g.roi) { ctx.setLineDash([12, 8]); ctx.strokeStyle = '#fff'; ctx.strokeRect(g.roi[0], g.roi[1], g.roi[2] - g.roi[0], g.roi[3] - g.roi[1]); ctx.setLineDash([]); }
  if (g._p) { ctx.fillStyle = '#fff'; ctx.fillRect(g._p[0] - 6, g._p[1] - 6, 12, 12); }
}

function gtFile(s) {
  cur(); const d = api.state.detector;
  return makeGroundTruthFile({ image: { name: s.name, sha256: s.sha256, width: s.width, height: s.height, ...(s.demoPath ? { path: s.demoPath } : {}) },
    detectorVersion: api.version(), params: d?.params || {}, roi: s._gt.roi, detections: s.beans, corrections: s._gt.corrections, R: R(s), note: $('gtNote').value || '' });
}
function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function exportAll() {
  const files = api.state.samples.filter(s => { cur(); return true; }).map(s => { if (!s._gt) s._gt = load(s); return gtFile(s); });
  download(`roast-ground-truth-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(files.length === 1 ? files[0] : files, null, 1));
}
async function importFiles(e) {
  let n = 0; for (const f of e.target.files) { try { const j = JSON.parse(await f.text()); for (const g of (Array.isArray(j) ? j : [j])) { if (g.schema !== GT_SCHEMA) continue;
    localStorage.setItem(KEY(g.image.sha256), JSON.stringify({ corrections: g.corrections, roi: g.roi, name: g.image.name, width: g.image.width, height: g.image.height, demoPath: g.image.path, updated: new Date().toISOString() })); n++;
    const s = api.state.samples.find(x => x.sha256 === g.image.sha256); if (s) s._gt = load(s); } } catch (err) { api.status(`${f.name}: ${err.message}`, 'warn'); } }
  e.target.value = ''; api.status(`Imported corrections for ${n} photo${n === 1 ? '' : 's'}. They apply when that photo is loaded.`); api.drawPhoto(); update();
}
async function submit() {
  const s = cur(); if (!s) return; const g = gtFile(s); const m = metrics(s); const json = JSON.stringify(g);
  try { await navigator.clipboard.writeText(json); } catch {}
  const isDemo = !!s.demoPath; const fname = `roast-feedback-${s.name.replace(/\W+/g, '-')}-${s.sha256.slice(0, 8)}.json`;
  const head = `Detector v${g.detectorVersion} on \`${s.name}\` (sha256 \`${s.sha256.slice(0, 12)}…\`): precision ${(m.precision * 100).toFixed(1)}%, recall ${(m.recall * 100).toFixed(1)}%, ${m.detected} detected vs ${m.truth} true${g.roi ? ' (in the reviewed area)' : ''}.\n\n` +
    (isDemo ? '' : '**Photo:** drag the original photo into this box so the benchmark can re-run on it.\n\n') + (g.note ? `Note: ${g.note}\n\n` : '');
  const fenced = '```json\n' + json + '\n```';
  let body = head + fenced;
  if (encodeURIComponent(body).length > 7000) { // compress: gzip + base64 keeps a full-photo review (~500 beans) under GitHub's URL limit
    try { const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      let bin = ''; new Uint8Array(gz).forEach(b => { bin += String.fromCharCode(b); }); const b64 = btoa(bin).replace(/.{1,76}/g, '$&\n');
      body = head + 'Ground truth (gzip + base64, decoded automatically):\n\n```roastgt-gz\n' + b64 + '```'; } catch {} }
  if (encodeURIComponent(body).length > 7000) { download(fname, JSON.stringify(g, null, 1)); body = head + 'The ground-truth JSON was too long for the link: it was **copied to your clipboard** and downloaded as `' + fname + '`. Paste it below between the json fences (or attach the file):\n\n```json\nPASTE HERE\n```'; }
  const url = `https://github.com/${REPO}/issues/new?labels=detector-feedback&title=${encodeURIComponent(`Detector feedback: ${s.name} (${m.truth} beans, F1 ${(m.f1 * 100).toFixed(1)}%)`)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank', 'noopener');
}

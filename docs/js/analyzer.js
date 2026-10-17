// Roast Analyzer core — pure JS, no dependencies. Works in browser and Node.
// Input: {width,height,data:Uint8ClampedArray RGBA}. Output: per-bean measurements + label map.

export const BANDS = [
  // Agtron-like (whole-bean, SCA tile scale) lower bounds, provisional
  // color = high-contrast overlay colour, tone = approximate real bean tone
  { name: 'Green/Yellow', min: 90, color: '#84cc16', tone: '#c9b46a' },
  { name: 'Cinnamon',     min: 80, color: '#facc15', tone: '#c8955a' },
  { name: 'Light',        min: 70, color: '#fb923c', tone: '#b07a45' },
  { name: 'City',         min: 60, color: '#ef4444', tone: '#94602f' },
  { name: 'City+',        min: 50, color: '#d946ef', tone: '#7a4a22' },
  { name: 'Full City',    min: 40, color: '#6366f1', tone: '#5e3518' },
  { name: 'Vienna',       min: 30, color: '#0ea5e9', tone: '#432410' },
  { name: 'French',       min: -1e9, color: '#0f172a', tone: '#24130a' },
];

// Provisional L* -> Agtron mapping (two-point linear). MUST be calibrated per camera/light.
export const DEFAULT_CAL = { L1: 45, A1: 65, L2: 55, A2: 80, provisional: true };
export function agtronFromL(L, cal = DEFAULT_CAL) {
  return cal.A1 + (L - cal.L1) * (cal.A2 - cal.A1) / (cal.L2 - cal.L1);
}
export function bandOf(ag) { for (let i = 0; i < BANDS.length; i++) if (ag >= BANDS[i].min) return i; return BANDS.length - 1; }

const s2l = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; s2l[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
export function linToLab(r, g, b) {
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function median(arr) { if (!arr.length) return NaN; const a = Float64Array.from(arr).sort(); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function quantile(arr, q) { const a = Float64Array.from(arr).sort(); if (!a.length) return NaN; const p = (a.length - 1) * q, lo = Math.floor(p); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (p - lo); }

// connected components on a Uint8 mask (8-conn); returns {labels Int32Array, sizes[]}
function components(mask, w, h) {
  const lab = new Int32Array(w * h); const sizes = [0]; const stack = new Int32Array(w * h); let n = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] && !lab[i]) {
    n++; let sp = 0, sz = 0; stack[sp++] = i; lab[i] = n;
    while (sp) { const p = stack[--sp]; sz++; const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const q = yy * w + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; } } } }
    sizes.push(sz);
  }
  return { labels: lab, sizes, n };
}
function erode(m, w, h, r = 1) { let a = m; for (let k = 0; k < r; k++) { const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x;
    o[i] = a[i] && a[i - 1] && a[i + 1] && a[i - w] && a[i + w] ? 1 : 0; } a = o; } return a; }
function dilate(m, w, h, r = 1) { let a = m; for (let k = 0; k < r; k++) { const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x;
    o[i] = a[i] || a[i - 1] || a[i + 1] || a[i - w] || a[i + w] ? 1 : 0; } a = o; } return a; }

// Felzenszwalb exact EDT (returns distance in px to nearest 0 pixel)
function edt1d(f, n, d, v, z) { let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) { let s; do { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) k--; else break; } while (k >= 0);
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20; }
  k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; } }
export function edt(mask, w, h) {
  const INF = 1e20, g = new Float64Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? INF : 0;
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[y * w + x]; edt1d(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]; edt1d(f, w, d, v, z); for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]); }
  return g;
}

// approximate Gaussian blur (3 box passes), Float32 in/out
export function blur(src, w, h, sigma) { if (sigma < 0.5) return Float32Array.from(src); const r = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1) / 2));
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) { let acc = 0; const o = y * w; for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { b[o + x] = acc / (2 * r + 1); acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = acc / (2 * r + 1); acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; } } }
  return a; }

function convexHull(pts) { pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up); }
function rasterPoly(poly, w, h) { const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const xs = []; for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1)); }
    xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, xs[k + 1]); x++) m[y * w + x] = 1; }
  return m; }

function otsu(vals, lo, hi, bins = 256) { const hst = new Float64Array(bins); for (const v of vals) { const b = Math.min(bins - 1, Math.max(0, ((v - lo) / (hi - lo) * bins) | 0)); hst[b]++; }
  let tot = vals.length, sum = 0; for (let i = 0; i < bins; i++) sum += i * hst[i];
  let sB = 0, wB = 0, best = 0, th = 0; for (let i = 0; i < bins; i++) { wB += hst[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hst[i];
    const mB = sB / wB, mF = (sum - sB) / wF, b = wB * wF * (mB - mF) ** 2; if (b > best) { best = b; th = i; } }
  return lo + (th + 0.5) / bins * (hi - lo); }

export function analyzeImage(img, opts = {}) {
  const { width: w, height: h, data } = img; const N = w * h; const cal = opts.cal || DEFAULT_CAL;
  // 1. Plate: bright, low-saturation pixels -> largest component -> convex hull
  const white = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    white[i] = mx > 140 && (mx - mn) < 0.16 * mx + 6 ? 1 : 0; }
  const wo = erode(white, w, h, 2);
  const cc = components(wo, w, h); let best = 1; for (let k = 1; k <= cc.n; k++) if (cc.sizes[k] > cc.sizes[best]) best = k;
  if (!cc.n || cc.sizes[best] < N * 0.05) throw new Error('No white plate found — shoot beans on a white plate filling most of the frame.');
  const pts = []; for (let y = 0; y < h; y += 2) { let l = -1, r = -1; for (let x = 0; x < w; x++) if (cc.labels[y * w + x] === best) { if (l < 0) l = x; r = x; } if (l >= 0) { pts.push([l, y]); pts.push([r, y]); } }
  const hull = convexHull(pts); let plate = rasterPoly(hull, w, h);
  let plateArea = 0; for (let i = 0; i < N; i++) plateArea += plate[i];
  const plateR = Math.sqrt(plateArea / Math.PI);
  const inner = erode(plate, w, h, Math.max(3, Math.round(plateR * 0.035)));
  // 2. White balance on plate pixels (bright half of white-component pixels inside inner plate)
  // Flat-field: fit a plane to plate linear RGB (lighting falls off across the plate), so every bean is normalised
  // against the white plate *at its own position*, not just the global plate median.
  const ref = 0.80; // assumed plate linear reflectance after normalisation (L* ~ 91.7)
  const fit = []; // per channel [c0, cx, cy]
  { const S = [[0,0,0],[0,0,0],[0,0,0]], T = [[0,0,0],[0,0,0],[0,0,0]];
    const samples = []; for (let i = 0; i < N; i += 5) if (inner[i] && cc.labels[i] === best) samples.push(i);
    // drop the darkest 30% of plate samples (shadows cast by beans/rim) per channel via luminance
    const lum = samples.map(i => s2l[data[4 * i]] + s2l[data[4 * i + 1]] + s2l[data[4 * i + 2]]); const cut = quantile(lum, 0.3);
    const cxp = w / 2, cyp = h / 2, sc = Math.max(w, h);
    samples.forEach((i, k) => { if (lum[k] < cut) return; const x = (i % w - cxp) / sc, y = (((i / w) | 0) - cyp) / sc; const v = [1, x, y];
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c]; for (let ch = 0; ch < 3; ch++) T[ch][r] += v[r] * s2l[data[4 * i + ch]]; } });
    const solve = (M, y) => { const m = M.map((r, i) => [...r, y[i]]); for (let i = 0; i < 3; i++) { let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k; [m[i], m[p]] = [m[p], m[i]];
        for (let k = 0; k < 3; k++) if (k !== i) { const f = m[k][i] / m[i][i]; for (let c = i; c < 4; c++) m[k][c] -= f * m[i][c]; } } return m.map((r, i) => r[3] / r[i]); };
    for (let ch = 0; ch < 3; ch++) fit.push(opts.flatField === false ? [quantile(samples.map(i => s2l[data[4 * i + ch]]), 0.6), 0, 0] : solve(S, T[ch]));
    fit.sc = sc; fit.cx = cxp; fit.cy = cyp; }
  const gainAt = (i, ch) => { const x = (i % w - fit.cx) / fit.sc, y = (((i / w) | 0) - fit.cy) / fit.sc; const f = fit[ch]; return ref / Math.max(0.02, f[0] + f[1] * x + f[2] * y); };
  const wb = [ref / fit[0][0], ref / fit[1][0], ref / fit[2][0]];
  // 3. Lab per pixel inside inner plate
  const L = new Float32Array(N), A = new Float32Array(N), B = new Float32Array(N);
  const Lvals = [];
  for (let i = 0; i < N; i++) if (inner[i]) { const lab = linToLab(Math.min(1.5, s2l[data[4 * i]] * gainAt(i, 0)), Math.min(1.5, s2l[data[4 * i + 1]] * gainAt(i, 1)), Math.min(1.5, s2l[data[4 * i + 2]] * gainAt(i, 2)));
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2]; if ((i & 3) === 0) Lvals.push(lab[0]); }
  const thr = Math.min(otsu(Lvals, 0, 100), 78);
  const Cvals = []; for (let i = 0; i < N; i += 4) if (inner[i]) Cvals.push(Math.hypot(A[i], B[i]));
  const cthr = opts.chromaThr ?? Math.max(8, otsu(Cvals, 0, 60) * (opts.chromaK ?? 1.0));
  // bean pixels: saturated brown. Low-chroma contact shadows between touching beans are excluded,
  // which separates most touching beans before the watershed.
  // bean pixels = (saturated brown) OR (dark AND wide). Contact shadows between touching beans are dark but thin
  // and low-chroma, so a morphological opening of the dark mask (disk ~0.45 bean half-width) removes them while
  // keeping genuinely dark beans.
  const R0 = opts.beanRadius || plateR * (opts.beanFrac ?? 0.029);
  let mask = new Uint8Array(N); const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (inner[i]) { const ch = Math.hypot(A[i], B[i]); mask[i] = ch > cthr && L[i] < 82 ? 1 : 0; dark[i] = L[i] < Math.min(thr, 52) ? 1 : 0; }
  { const r = R0 * (opts.openK ?? 0.5); const d1 = edt(dark, w, h); const er = new Uint8Array(N); for (let i = 0; i < N; i++) er[i] = d1[i] > r ? 0 : 1;
    const d2 = edt(er, w, h); for (let i = 0; i < N; i++) if (d2[i] <= r + 0.5 && inner[i]) mask[i] = 1; }
  mask = dilate(erode(mask, w, h, 1), w, h, 1);
  // fill holes: tiny ones (specular highlights) and dark ones (the centre crease, excluded by the chroma rule)
  { const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = inner[i] && !mask[i] ? 1 : 0; const hc = components(inv, w, h);
    const sumL = new Float64Array(hc.n + 1); for (let i = 0; i < N; i++) if (inv[i]) sumL[hc.labels[i]] += L[i];
    const tiny = opts.holeMax ?? Math.max(12, (plateR * 0.011) ** 2 * 0.6);
    const fill = hc.sizes.map((s, k) => k > 0 && (s <= tiny || (s < 0.5 * R0 * R0 && sumL[k] / s < (opts.creaseL ?? 36))));
    for (let i = 0; i < N; i++) if (inv[i] && fill[hc.labels[i]]) mask[i] = 1; }
  // 4. Markers. Touching beans in a dense layer rarely leave background between them, so the distance transform alone
  // under-splits. We combine it with a 'body' map: each bean is a convex, shaded dome, so the bean-masked lightness
  // blurred at ~0.6 bean half-width peaks once near each bean centre (the thin crease and contact shadows blur away).
  const dist = edt(mask, w, h);
  let R = R0;
  const body0 = new Float32Array(N); for (let i = 0; i < N; i++) body0[i] = mask[i] ? L[i] + 25 : 0;
  const body = blur(body0, w, h, R * (opts.bodySigma ?? 0.42));
  const score = new Float32Array(N); for (let i = 0; i < N; i++) score[i] = mask[i] ? body[i] + (opts.distW ?? 1.5) * Math.min(dist[i], R) : -1;
  const peaks = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, d = score[i]; if (dist[i] < R * (opts.markerMin ?? 0.3)) continue;
    if (d >= score[i - 1] && d >= score[i + 1] && d >= score[i - w] && d >= score[i + w] && d >= score[i - w - 1] && d >= score[i - w + 1] && d >= score[i + w - 1] && d >= score[i + w + 1]) peaks.push([d, x, y]); }
  peaks.sort((a, b) => b[0] - a[0]);
  const sup = R * (opts.nmsRadius ?? 0.85);
  const markers = []; const grid = new Map(); const cs = Math.ceil(sup);
  for (const [d, x, y] of peaks) { const gx = (x / cs) | 0, gy = (y / cs) | 0; let ok = true;
    for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) { const cell = grid.get((gx + a) + ',' + (gy + b)); if (cell) for (const m of cell) if ((m[0] - x) ** 2 + (m[1] - y) ** 2 < sup * sup) { ok = false; break; } }
    if (ok) { const m = [x, y, dist[y * w + x]]; markers.push(m); const key = gx + ',' + gy; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(m); } }
  // 5. Watershed (bucket queue on -dist) restricted to mask
  const lab = new Int32Array(N); const Q = 1024; const buckets = Array.from({ length: Q + 1 }, () => []);
  const fine = blur(body0, w, h, 1.2); let smax = 0; const elev = new Float32Array(N);
  for (let i = 0; i < N; i++) if (mask[i]) { elev[i] = fine[i] + (opts.distW ?? 1.5) * Math.min(dist[i], R); if (elev[i] > smax) smax = elev[i]; }
  const lvl = i => Math.max(0, Math.min(Q, Math.round(Q * (1 - elev[i] / smax))));
  markers.forEach((m, k) => { const i = m[1] * w + m[0]; lab[i] = k + 1; buckets[lvl(i)].push(i); });
  for (let q = 0; q <= Q; q++) { const bk = buckets[q]; while (bk.length) { const p = bk.pop(); const x = p % w, y = (p / w) | 0, l = lab[p];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const n = yy * w + xx;
        if (mask[n] && !lab[n]) { lab[n] = l; buckets[Math.max(q, lvl(n))].push(n); } } } }
  // 5b. Post-process: merge over-split fragments into their neighbour, split over-large blobs (k-means on coordinates)
  let K = markers.length;
  { const ar = new Int32Array(K + 1); for (let i = 0; i < N; i++) if (lab[i]) ar[lab[i]]++;
    const mA = median(Array.from(ar).slice(1).filter(v => v > R * R * 1.5));
    const border = new Map(); // small label -> Map(neighbour -> shared length)
    for (let i = w; i < N - w; i++) { const l = lab[i]; if (!l || ar[l] >= 0.5 * mA) continue;
      for (const n of [i + 1, i - 1, i + w, i - w]) { const m = lab[n]; if (m && m !== l) { if (!border.has(l)) border.set(l, new Map()); const bm = border.get(l); bm.set(m, (bm.get(m) || 0) + 1); } } }
    const remap = new Int32Array(K + 1).map((_, k) => k);
    const order = [...border.keys()].sort((a, b) => ar[a] - ar[b]);
    const find = k => { while (remap[k] !== k) k = remap[k]; return k; };
    for (const l of order) { let best = 0, bl = 0; for (const [m, c] of border.get(l)) { const fm = find(m); if (fm === find(l)) continue; const merged = ar[fm] + ar[find(l)];
        if (merged < 1.45 * mA && c > bl) { bl = c; best = fm; } }
      if (best && bl > Math.max(4, 0.25 * Math.sqrt(ar[find(l)]) * 2)) { const fl = find(l); ar[best] += ar[fl]; ar[fl] = 0; remap[fl] = best; } }
    for (let i = 0; i < N; i++) if (lab[i]) lab[i] = find(lab[i]);
    // split blobs
    const pixOf = new Map(); for (let i = 0; i < N; i++) { const l = lab[i]; if (l && ar[l] > 1.8 * mA) { if (!pixOf.has(l)) pixOf.set(l, []); pixOf.get(l).push(i); } }
    for (const [l, px] of pixOf) { const k = Math.max(2, Math.round(px.length / mA)); const cx = [], cy = [];
      // init centres along principal axis
      let mx = 0, my = 0; for (const i of px) { mx += i % w; my += (i / w) | 0; } mx /= px.length; my /= px.length;
      let sxx = 0, syy = 0, sxy = 0; for (const i of px) { const dx = i % w - mx, dy = ((i / w) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), sd = Math.sqrt((sxx + syy) / px.length);
      for (let j = 0; j < k; j++) { const t = (j - (k - 1) / 2) * 1.6 * sd / k; cx.push(mx + t * Math.cos(th)); cy.push(my + t * Math.sin(th)); }
      const asg = new Int32Array(px.length);
      for (let it = 0; it < 8; it++) { const ax = new Float64Array(k), ay = new Float64Array(k), an = new Float64Array(k);
        px.forEach((i, n) => { const x = i % w, y = (i / w) | 0; let bj = 0, bd = 1e18; for (let j = 0; j < k; j++) { const d = (x - cx[j]) ** 2 + (y - cy[j]) ** 2; if (d < bd) { bd = d; bj = j; } } asg[n] = bj; ax[bj] += x; ay[bj] += y; an[bj]++; });
        for (let j = 0; j < k; j++) if (an[j]) { cx[j] = ax[j] / an[j]; cy[j] = ay[j] / an[j]; } }
      const ids = [l]; for (let j = 1; j < k; j++) { K++; ids.push(K); markers.push([Math.round(cx[j]), Math.round(cy[j]), R]); }
      px.forEach((i, n) => { lab[i] = ids[asg[n]]; }); }
  }
  // 6. Region stats
  const area = new Int32Array(K + 1), sx = new Float64Array(K + 1), sy = new Float64Array(K + 1), edge = new Uint8Array(K + 1);
  const minx = new Int32Array(K + 1).fill(w), maxx = new Int32Array(K + 1), miny = new Int32Array(K + 1).fill(h), maxy = new Int32Array(K + 1);
  const pix = Array.from({ length: K + 1 }, () => []);
  for (let i = 0; i < N; i++) { const l = lab[i]; if (!l) continue; const x = i % w, y = (i / w) | 0; area[l]++; sx[l] += x; sy[l] += y;
    if (x < minx[l]) minx[l] = x; if (x > maxx[l]) maxx[l] = x; if (y < miny[l]) miny[l] = y; if (y > maxy[l]) maxy[l] = y; pix[l].push(i);
    if (!inner[i - 1] || !inner[i + 1] || !inner[i - w] || !inner[i + w]) edge[l] = 1; }
  const medA = median(Array.from(area).slice(1).filter(a => a > R * R));
  const beans = []; const rejected = [];
  const keep = new Int32Array(K + 1);
  for (let l = 1; l <= K; l++) {
    const a = area[l]; if (!a) continue; const cx0 = sx[l] / a, cy0 = sy[l] / a; const reason = edge[l] ? 'plate edge' : a < 0.3 * medA ? 'crumb/fragment' : null;
    if (reason) { rejected.push({ x: cx0, y: cy0, area: a, reason }); continue; }
    // robust colour: interior pixels only (dist from bean boundary), drop crease (dark tail) and specular (bright/low-chroma tail)
    const cx = cx0, cy = cy0; const core = pix[l].filter(i => dist[i] > 0.3 * R);
    const src = core.length > 20 ? core : pix[l];
    const Ls = src.map(i => L[i]); const lo = quantile(Ls, 0.15), hi = quantile(Ls, 0.92);
    const sel = src.filter(i => L[i] >= lo && L[i] <= hi && !(L[i] > hi - 3 && Math.hypot(A[i], B[i]) < 10));
    const s2 = sel.length > 10 ? sel : src;
    const Lm = median(s2.map(i => L[i])), am = median(s2.map(i => A[i])), bm = median(s2.map(i => B[i]));
    const Cm = Math.hypot(am, bm);
    const why = Cm < (opts.minBeanC ?? 0.55) * cthr ? 'shadow/gap' : Lm > thr + 6 && Cm < cthr ? 'plate glare' : null;
    if (why) { rejected.push({ x: cx0, y: cy0, area: a, reason: why }); continue; }
    const ag = agtronFromL(Lm, cal);
    keep[l] = beans.length + 1;
    beans.push({ id: beans.length + 1, x: +cx.toFixed(1), y: +cy.toFixed(1), area: a, bbox: [minx[l], miny[l], maxx[l], maxy[l]],
      L: +Lm.toFixed(2), a: +am.toFixed(2), b: +bm.toFixed(2), C: +Math.hypot(am, bm).toFixed(2), hue: +(Math.atan2(bm, am) * 180 / Math.PI).toFixed(1),
      agtron: +ag.toFixed(1), band: BANDS[bandOf(ag)].name });
  }
  // Spatial detrend: beans are spread at random, so any linear trend of bean colour with position is lighting
  // (light from one side, the phone's shadow), not roast. Remove the planar trend, keep the mean.
  let trend = null;
  if (opts.detrend !== false && beans.length >= 30) {
    const S = [[0,0,0],[0,0,0],[0,0,0]], T = [[0,0,0],[0,0,0],[0,0,0]], sc = Math.max(w, h);
    for (const bn of beans) { const v = [1, (bn.x - w / 2) / sc, (bn.y - h / 2) / sc]; const y = [bn.L, bn.a, bn.b];
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c]; for (let k = 0; k < 3; k++) T[k][r] += v[r] * y[k]; } }
    const solve = (M, y) => { const m = M.map((r, i) => [...r, y[i]]); for (let i = 0; i < 3; i++) { for (let k = 0; k < 3; k++) if (k !== i) { const f = m[k][i] / m[i][i]; for (let c = i; c < 4; c++) m[k][c] -= f * m[i][c]; } } return m.map((r, i) => r[3] / r[i]); };
    const co = T.map(t => solve(S, t)); const mx = beans.reduce((s, b) => s + (b.x - w / 2) / sc, 0) / beans.length, my = beans.reduce((s, b) => s + (b.y - h / 2) / sc, 0) / beans.length;
    for (const bn of beans) { const dx = (bn.x - w / 2) / sc - mx, dy = (bn.y - h / 2) / sc - my; bn.Lraw = bn.L;
      bn.L = +(bn.L - co[0][1] * dx - co[0][2] * dy).toFixed(2); bn.a = +(bn.a - co[1][1] * dx - co[1][2] * dy).toFixed(2); bn.b = +(bn.b - co[2][1] * dx - co[2][2] * dy).toFixed(2);
      bn.C = +Math.hypot(bn.a, bn.b).toFixed(2); bn.hue = +(Math.atan2(bn.b, bn.a) * 180 / Math.PI).toFixed(1); bn.agtron = +agtronFromL(bn.L, cal).toFixed(1); bn.band = BANDS[bandOf(bn.agtron)].name; }
    trend = { dLdx: +co[0][1].toFixed(2), dLdy: +co[0][2].toFixed(2) }; }
  const labelMap = new Int32Array(N); for (let i = 0; i < N; i++) if (lab[i]) labelMap[i] = keep[lab[i]];
  return { width: w, height: h, beans, rejected, labelMap, debug: opts.debug ? { mask, markers, lab } : null, params: { plateRadius: +plateR.toFixed(1), beanRadius: +R.toFixed(2), Lthreshold: +thr.toFixed(1), chromaThreshold: +cthr.toFixed(1), wbGains: wb.map(g => +g.toFixed(3)), lightingTrend: trend, flatField: fit.map(f => f.map(v => +v.toFixed(4))), markers: K } };
}

export function stats(beans, cal = DEFAULT_CAL) {
  const n = beans.length; if (!n) return null; const Ls = beans.map(b => b.L), ags = beans.map(b => b.agtron);
  const mean = ags.reduce((s, v) => s + v, 0) / n; const sd = Math.sqrt(ags.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const med = median(ags); const mad = median(ags.map(v => Math.abs(v - med))) * 1.4826 || sd;
  const within = ags.filter(v => Math.abs(v - med) <= 5).length, within10 = ags.filter(v => Math.abs(v - med) <= 10).length;
  const meanL = Ls.reduce((s, v) => s + v, 0) / n;
  const hist = BANDS.map(b => ({ band: b.name, count: 0 })); beans.forEach(b => hist[BANDS.findIndex(x => x.name === b.band)].count++);
  return { n, meanAgtron: +mean.toFixed(1), sdAgtron: +sd.toFixed(2), medianAgtron: +med.toFixed(1), robustSD: +mad.toFixed(2), meanL: +meanL.toFixed(2),
    band: BANDS[bandOf(mean)].name, uniformityPct: +(100 * within / n).toFixed(1), uniformity10Pct: +(100 * within10 / n).toFixed(1), sdL: +Math.sqrt(Ls.reduce((s, v) => s + (v - meanL) ** 2, 0) / Math.max(1, n - 1)).toFixed(2), bandHistogram: hist };
}

// outliers relative to the whole batch (robust z on Agtron)
// Outliers relative to the whole batch. A bean is flagged if it is BOTH statistically unusual (robust z) and
// practically different (>= 2 roast bands, i.e. 20 Agtron-like points, from the batch median).
export function classifyOutliers(beans, o = {}) {
  const ags = beans.map(b => b.agtron); const med = median(ags); const mad = Math.max(1.5, median(ags.map(v => Math.abs(v - med))) * 1.4826);
  const Cmed = median(beans.map(b => b.C)), Hmed = median(beans.map(b => b.hue)); const gap = o.gap ?? 20;
  for (const b of beans) { const z = (b.agtron - med) / mad, d = b.agtron - med; b.z = +z.toFixed(2);
    b.outlier = z > 1.8 && d > gap + 5 && (b.hue > Hmed + 3 || b.C < Cmed - 2) ? 'quaker' : z > 1.5 && d > gap ? 'underdeveloped' : z < -1.5 && d < -gap ? 'scorched/dark' : null; }
  return { median: med, robustSD: mad };
}

export function batchReport(samples, cal = DEFAULT_CAL) {
  const all = []; samples.forEach((s, si) => s.beans.forEach(b => { b.sample = si + 1; b.agtron = +agtronFromL(b.L, cal).toFixed(1); b.band = BANDS[bandOf(b.agtron)].name; all.push(b); }));
  const ref = classifyOutliers(all);
  const per = samples.map((s, si) => ({ sample: si + 1, name: s.name, ...stats(s.beans, cal), outliers: s.beans.filter(b => b.outlier).length }));
  const combined = stats(all, cal); const outl = all.filter(b => b.outlier);
  const counts = { quaker: 0, underdeveloped: 0, 'scorched/dark': 0 }; outl.forEach(b => counts[b.outlier]++);
  // consistency: each sample mean vs pooled mean, standardised by SE; plus range of means
  const means = per.map(p => p.meanAgtron); const range = Math.max(...means) - Math.min(...means);
  const consistency = per.map(p => ({ sample: p.sample, deltaAgtron: +(p.meanAgtron - combined.meanAgtron).toFixed(2), z: +((p.meanAgtron - combined.meanAgtron) / (combined.sdAgtron / Math.sqrt(p.n))).toFixed(2) }));
  const verdict = range <= 3 && consistency.every(c => Math.abs(c.z) < 3.5) ? 'consistent' : range <= 6 ? 'minor differences' : 'inconsistent — check sampling/lighting';
  return { calibration: cal, perSample: per, combined: { ...combined, outliers: outl.length, outlierPct: +(100 * outl.length / all.length).toFixed(1), outlierCounts: counts },
    consistency: { meanRange: +range.toFixed(2), perSample: consistency, verdict }, beans: all };
}

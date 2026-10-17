// Cloudflare Worker: receives swipe-review batches from the page, validates them, and commits them to a review branch
// (BRANCH, default "swipe-feedback") with one open PR into main — never straight to main.
// Secrets/vars (`wrangler secret put` / wrangler.toml — never in the page):
//   GITHUB_TOKEN   fine-grained PAT, repository access = NZA-93/roast-analyzer only, Contents: read & write, Pull requests: read & write
//   REPO "NZA-93/roast-analyzer" · BASE "main" · BRANCH "swipe-feedback" · ALLOWED_ORIGIN "https://nza-93.github.io"
//   RATE           KV namespace binding — REQUIRED (the Worker refuses to run without its rate limit)
import { validateBatch, toGroundTruth, contentHash, LIMITS, KNOWN_IMAGES } from '../docs/js/swipe-core.js';

export const MAX_PER_HOUR = 30; // batches per IP per hour

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://nza-93.github.io';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/batch') return reply(404, { error: 'not found' });
    if (req.headers.get('origin') !== origin) return reply(403, { error: 'origin required' });
    if (!env.RATE) return reply(503, { error: 'rate limit store (RATE KV) not configured' });
    if (!env.GITHUB_TOKEN) return reply(503, { error: 'not configured' });

    const cap = LIMITS.maxBytes + LIMITS.maxPhotoBytes;
    if (+req.headers.get('content-length') > cap) return reply(413, { error: 'too large' });
    const text = await req.text(); if (text.length > cap) return reply(413, { error: 'too large' });

    const ip = req.headers.get('cf-connecting-ip') || 'unknown', key = `r:${ip}:${Math.floor(Date.now() / 3.6e6)}`;
    const n = +(await env.RATE.get(key)) || 0; if (n >= MAX_PER_HOUR) return reply(429, { error: 'rate limited' });
    await env.RATE.put(key, String(n + 1), { expirationTtl: 3700 });

    let batch; try { batch = JSON.parse(text); } catch { return reply(400, { error: 'bad json' }); }
    const problems = validateBatch(batch); if (problems.length) return reply(400, { error: 'schema', problems });
    if (text.length - (batch.photo?.length || 0) > LIMITS.maxBytes) return reply(413, { error: 'answers too large' });
    const known = KNOWN_IMAGES.includes(batch.image.sha256);
    if (!known && !batch.photo) return reply(422, { error: 'unknown photo', detail: 'This photo is not in the repo; send it with the answers (toggle "Send photo with answers") or the answers cannot be scored.' });

    const gh = github(env); const ch = await contentHash(batch);
    const base = `swipe-${batch.createdAt.slice(0, 10).replace(/[^\d-]/g, '')}-${batch.image.sha256.slice(0, 8)}-${ch}`;
    try {
      await gh.ensureBranch();
      if (await gh.exists(`feedback/swipe/raw/${base}.json`)) return reply(409, { error: 'duplicate batch', contentHash: ch });
      const files = [];
      if (batch.photo && !known) {
        const info = await inspectImage(batch.photo, batch.image); if (info.error) return reply(422, { error: 'bad photo', detail: info.error });
        const p = `feedback/images/${batch.image.sha256.slice(0, 16)}.${info.type}`;
        if (!(await gh.exists(p))) files.push([p, batch.photo.split(',')[1]]); batch.photoPath = p;
        batch.image = { ...batch.image, originalSha256: batch.image.sha256, uploadedSha256: info.sha256, uploadedWidth: info.width, uploadedHeight: info.height }; }
      const { photo, ...raw } = batch; files.push([`feedback/swipe/raw/${base}.json`, b64(JSON.stringify(raw, null, 1))]);
      for (const sub of ['random', 'targeted']) { const gt = toGroundTruth(batch, sub); if (gt.detectedAtReview || gt.corrections.added.length) files.push([`feedback/swipe/${base}-${sub}.json`, b64(JSON.stringify(gt, null, 1))]); }
      for (const [p, c] of files) await gh.put(p, c, `Swipe feedback ${ch} (${batch.answers.length} answers)`);
      const pr = await gh.ensurePR();
      return reply(201, { ok: true, contentHash: ch, files: files.map(f => f[0]), pr });
    } catch (e) { return reply(502, { error: 'github', detail: String(e.message).slice(0, 200) }); }
  },
};

const b64 = s => { const u = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
function github(env) {
  const repo = env.REPO || 'NZA-93/roast-analyzer', baseBr = env.BASE || 'main', br = env.BRANCH || 'swipe-feedback', api = `https://api.github.com/repos/${repo}`;
  const call = async (method, path, body) => { const r = await fetch(api + path, { method, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'roast-feedback-worker', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) }; };
  const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); return r.json; };
  return {
    async ensureBranch() { const r = await call('GET', `/git/ref/heads/${br}`); if (r.status === 200) return;
      const b = ok(await call('GET', `/git/ref/heads/${baseBr}`), 'base ref'); ok(await call('POST', '/git/refs', { ref: `refs/heads/${br}`, sha: b.object.sha }), 'create branch'); },
    async exists(p) { return (await call('GET', `/contents/${p}?ref=${br}`)).status === 200; },
    async put(p, content, message) { ok(await call('PUT', `/contents/${p}`, { message, content, branch: br }), `put ${p}`); },
    async ensurePR() { const owner = repo.split('/')[0]; const l = ok(await call('GET', `/pulls?state=open&head=${owner}:${br}&base=${baseBr}`), 'list PRs');
      if (l.length) return l[0].html_url;
      return ok(await call('POST', '/pulls', { title: 'Swipe-review feedback (auto)', head: br, base: baseBr, body: 'Batches from the swipe review, validated by the feedback Worker. New batches are added to this PR. Merge to let the benchmark use them.' }), 'create PR').html_url; },
  };
}

// Check the uploaded photo really is a JPEG/PNG with sane dimensions matching the analysed frame (structure-level check:
// JPEG SOI/SOF/EOI markers, PNG signature/IHDR/IEND). Returns {type,width,height,sha256} or {error}.
export async function inspectImage(dataUrl, image) {
  let bytes; try { const bin = atob(dataUrl.split(',')[1] || ''); bytes = Uint8Array.from(bin, c => c.charCodeAt(0)); } catch { return { error: 'photo is not valid base64' }; }
  let type = null, width = 0, height = 0;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) { type = 'jpg';
    if (!(bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9)) return { error: 'JPEG is truncated (no end marker)' };
    for (let i = 2; i + 9 < bytes.length;) { if (bytes[i] !== 0xFF) return { error: 'JPEG marker structure is broken' }; const m = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) { height = (bytes[i + 5] << 8) | bytes[i + 6]; width = (bytes[i + 7] << 8) | bytes[i + 8]; break; }
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; } i += 2 + len; } }
  else if ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((v, i) => bytes[i] === v)) { type = 'png';
    const dv = new DataView(bytes.buffer); if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return { error: 'PNG has no IHDR' };
    width = dv.getUint32(16); height = dv.getUint32(20); if (String.fromCharCode(...bytes.subarray(bytes.length - 8, bytes.length - 4)) !== 'IEND') return { error: 'PNG is truncated' }; }
  else return { error: 'photo is not a JPEG or PNG' };
  if (!width || !height) return { error: 'could not read photo dimensions' };
  if (Math.max(width, height) > 4000 || Math.min(width, height) < 200) return { error: `photo size ${width}×${height} is out of range` };
  if (Math.abs(width - image.width) > 1 || Math.abs(height - image.height) > 1) return { error: `photo is ${width}×${height}, answers were made on ${image.width}×${image.height}` };
  const h = await crypto.subtle.digest('SHA-256', bytes); const sha256 = [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
  return { type, width, height, sha256 };
}

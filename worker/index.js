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
      if (batch.photo && !known) { const p = `feedback/images/${batch.image.sha256.slice(0, 16)}.jpg`;
        if (!(await gh.exists(p))) files.push([p, batch.photo.split(',')[1]]); batch.photoPath = p; }
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

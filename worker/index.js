// Cloudflare Worker: receives swipe-review batches from the page, validates them, and commits them to feedback/.
// Secrets/vars (set with `wrangler secret put` / wrangler.toml — never in the page):
//   GITHUB_TOKEN   fine-grained PAT, repository access = NZA-93/roast-analyzer only, permission Contents: read & write
//   REPO           "NZA-93/roast-analyzer"   BRANCH  "main"   ALLOWED_ORIGIN  "https://nza-93.github.io"
//   RATE (KV namespace binding, optional) for the per-IP rate limit
import { validateBatch, toGroundTruth, LIMITS } from '../docs/js/swipe-core.js';

const MAX_PER_HOUR = 30; // batches per IP per hour

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://nza-93.github.io';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
    const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/batch') return reply(404, { error: 'not found' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin' });

    // size cap (header + actual body)
    if (+req.headers.get('content-length') > LIMITS.maxBytes) return reply(413, { error: 'too large' });
    const text = await req.text(); if (text.length > LIMITS.maxBytes) return reply(413, { error: 'too large' });

    // rate limit per IP (KV, fixed hourly window)
    if (env.RATE) { const ip = req.headers.get('cf-connecting-ip') || 'unknown', key = `r:${ip}:${Math.floor(Date.now() / 3.6e6)}`;
      const n = +(await env.RATE.get(key)) || 0; if (n >= MAX_PER_HOUR) return reply(429, { error: 'rate limited' });
      await env.RATE.put(key, String(n + 1), { expirationTtl: 3700 }); }

    let batch; try { batch = JSON.parse(text); } catch { return reply(400, { error: 'bad json' }); }
    const problems = validateBatch(batch); if (problems.length) return reply(400, { error: 'schema', problems });

    // one raw batch (for rescoring later) + two ground-truth files: random (unbiased, carries the missed-bean taps) and targeted (biased, tuning only)
    const day = batch.createdAt.slice(0, 10).replace(/[^\d-]/g, ''), base = `swipe-${day}-${batch.image.sha256.slice(0, 8)}-${batch.id.slice(-8)}`;
    const files = [[`feedback/swipe/raw/${base}.json`, batch]];
    for (const sub of ['random', 'targeted']) { const gt = toGroundTruth(batch, sub); if (gt.detectedAtReview || gt.corrections.added.length) files.push([`feedback/${base}-${sub}.json`, gt]); }
    try {
      for (const [path, obj] of files) { const r = await put(env, path, obj, `Swipe feedback ${batch.id} (${batch.answers.length} answers)`); if (r === 'exists') return reply(409, { error: 'duplicate batch' }); }
    } catch (e) { return reply(502, { error: 'github', detail: String(e.message).slice(0, 200) }); }
    return reply(201, { ok: true, files: files.map(f => f[0]) });
  },
};

async function put(env, path, obj, message) {
  const url = `https://api.github.com/repos/${env.REPO || 'NZA-93/roast-analyzer'}/contents/${path}`;
  const body = JSON.stringify(obj, null, 1); const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  const r = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'roast-feedback-worker', 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: b64, branch: env.BRANCH || 'main' }) });
  if (r.status === 422) return 'exists'; // file already there (no sha given) -> duplicate submission
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return 'ok';
}

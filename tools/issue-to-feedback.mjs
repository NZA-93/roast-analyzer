// Turns a "detector-feedback" issue into feedback/issue-<n>.json (+ the photo, if attached).
// Used by .github/workflows/feedback-issue.yml. Reads the event payload from GITHUB_EVENT_PATH.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { fileURLToPath } from 'url';
import { GT_SCHEMA } from '../docs/js/evaluate.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); const issue = ev.issue;
const out = msg => { fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null', `result<<EOF\n${msg}\nEOF\n`); console.log(msg); };
import zlib from 'zlib';
const body = issue.body || '';
const gz = /```roastgt-gz\s*([\s\S]*?)```/.exec(body), m = /```json\s*([\s\S]*?)```/.exec(body);
let gt;
try { if (gz) gt = JSON.parse(zlib.gunzipSync(Buffer.from(gz[1].replace(/\s+/g, ''), 'base64')).toString('utf8')); else if (m) gt = JSON.parse(m[1]); }
catch (e) { out(`Could not decode the ground-truth block: ${e.message}`); process.exit(0); }
if (!gt) { out('No ```json or ```roastgt-gz block found in the issue body.'); process.exit(0); }
if (gt.schema !== GT_SCHEMA || !Array.isArray(gt.truth) || !gt.image?.sha256) { out('JSON is not a roast-analyzer ground-truth file.'); process.exit(0); }
if (gt.truth.length > 5000) { out('Too many beans in ground truth (>5000), refusing.'); process.exit(0); }
gt.source = { issue: issue.number, author: issue.user?.login, url: issue.html_url };
// find the photo: demo samples, existing feedback images, or an attachment in the issue
const known = new Set(); for (const dir of ['docs/demo', 'feedback/images']) { const d = path.join(ROOT, dir); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) known.add(crypto.createHash('sha256').update(fs.readFileSync(path.join(d, f))).digest('hex')); }
let photo = known.has(gt.image.sha256) ? 'already in repo' : null;
if (!photo) { const urls = [...(issue.body || '').matchAll(/https:\/\/(?:github\.com\/user-attachments\/assets|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com)\/[^\s)"'>]+/g)].map(x => x[0]);
  for (const u of urls) { try { const r = await fetch(u, { redirect: 'follow' }); if (!r.ok) continue; const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 25e6) continue;
      const h = crypto.createHash('sha256').update(buf).digest('hex'); const ext = (r.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';
      fs.mkdirSync(path.join(ROOT, 'feedback/images'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'feedback/images', `${h.slice(0, 16)}.${ext}`), buf);
      if (h === gt.image.sha256) { photo = 'attached photo matches'; break; } photo = photo || `attached photo hash ${h.slice(0, 12)} ≠ ${gt.image.sha256.slice(0, 12)} (GitHub may have re-encoded it)`; } catch {} } }
fs.writeFileSync(path.join(ROOT, 'feedback', `issue-${issue.number}.json`), JSON.stringify(gt, null, 1));
out(`Saved feedback/issue-${issue.number}.json: ${gt.truth.length} true beans${gt.roi ? ' in a reviewed area' : ''}. Photo: ${photo || 'NOT FOUND — attach the original photo (or add it to feedback/images/) so the benchmark can use this feedback'}.`);

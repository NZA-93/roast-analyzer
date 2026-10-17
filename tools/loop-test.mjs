// Proves the feedback loop moves the detector: synthesise "user feedback" that disagrees with the shipped
// detector in a known direction, run the tuner on it (dry run) and check F1 improves.
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import { execFileSync } from 'child_process';
import jpeg from 'jpeg-js'; import { analyzeImage } from '../docs/js/analyzer.js'; import { makeGroundTruthFile, emptyCorrections } from '../docs/js/evaluate.js';
const f = new URL('../docs/demo/sample2.jpg', import.meta.url); const buf = fs.readFileSync(f); const img = jpeg.decode(buf, { useTArray: true });
const alt = { nmsRadius: 1.15, bodySigma: 0.5 };                 // the "truth" a user would mark: fewer, larger beans (marks the extras as split)
const shipped = analyzeImage(img, {}), truthDet = analyzeImage(img, alt);
const tol = shipped.params.beanRadius * 0.6, c = emptyCorrections();
for (const d of shipped.beans) if (!truthDet.beans.some(t => (t.x - d.x) ** 2 + (t.y - d.y) ** 2 < tol * tol)) c.split.push({ x: Math.round(d.x), y: Math.round(d.y) });
for (const t of truthDet.beans) if (!shipped.beans.some(d => (t.x - d.x) ** 2 + (t.y - d.y) ** 2 < tol * tol)) c.added.push({ x: Math.round(t.x), y: Math.round(t.y) });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-loop-'));
const gt = makeGroundTruthFile({ image: { name: 'sample2.jpg', sha256: crypto.createHash('sha256').update(buf).digest('hex'), width: img.width, height: img.height, path: 'docs/demo/sample2.jpg' },
  detectorVersion: 'loop-test', params: {}, roi: null, detections: shipped.beans, corrections: c, R: shipped.params.beanRadius, note: 'synthetic' });
fs.writeFileSync(path.join(dir, 'synthetic.json'), JSON.stringify(gt));
console.log(`synthetic feedback: ${c.split.length} split, ${c.added.length} missed, ${gt.truth.length} true beans`);
const log = execFileSync('node', [new URL('./benchmark.mjs', import.meta.url).pathname, '--tune', '--dry'], { env: { ...process.env, RA_FEEDBACK: dir }, encoding: 'utf8' });
console.log(log.trim());
const before = +/current params .*?F1 ([\d.]+)/.exec(log)[1], after = JSON.parse(log.trim().split('\n').find(l => l.startsWith('{"dry"'))).f1;
if (!(after > before)) { console.error(`LOOP TEST FAILED: F1 ${before} -> ${after}`); process.exit(1); }
console.log(`LOOP TEST OK: F1 ${before} -> ${after}`);

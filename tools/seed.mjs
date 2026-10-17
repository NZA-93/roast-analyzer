import fs from 'fs'; import jpeg from 'jpeg-js'; import crypto from 'crypto';
import { analyzeImage, ALGO_VERSION } from '../docs/js/analyzer.js'; import { makeGroundTruthFile, emptyCorrections } from '../docs/js/evaluate.js';
const f = '../docs/demo/sample1.jpg'; const buf = fs.readFileSync(f); const raw = jpeg.decode(buf, { useTArray: true }); const r = analyzeImage(raw, {});
const c = emptyCorrections(); c.split.push({ x: 682, y: 512 }, { x: 722, y: 647 }); c.added.push({ x: 657, y: 625 }, { x: 667, y: 683 });
const gt = makeGroundTruthFile({ image: { name: 'sample1.jpg', sha256: crypto.createHash('sha256').update(buf).digest('hex'), width: r.width, height: r.height, path: 'docs/demo/sample1.jpg' },
  detectorVersion: ALGO_VERSION + '+defaults', params: {}, roi: [640, 440, 970, 790], detections: r.beans, corrections: c, R: r.params.beanRadius,
  note: 'Seed: central tile of sample 1 (17 Oct 2026 batch), hand-audited at 3x zoom by the build agent: 2 split fragments removed, 2 missed pale beans added. Single annotator; started from detector output, so it may under-report misses the annotator also overlooked.' });
gt.createdAt = '2026-10-17T11:30:00+02:00';
fs.writeFileSync('../feedback/sample1-tile-seed-2026-10-17.json', JSON.stringify(gt, null, 1)); console.log(gt.truth.length);

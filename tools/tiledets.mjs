import fs from 'fs'; import jpeg from 'jpeg-js'; import { analyzeImage } from '../docs/js/analyzer.js';
const raw = jpeg.decode(fs.readFileSync(process.argv[2]), { useTArray: true }); const r = analyzeImage(raw, {});
const [x0, y0, x1, y1] = process.argv[3].split(',').map(Number);
const d = r.beans.filter(b => b.x >= x0 - 20 && b.x < x1 + 20 && b.y >= y0 - 20 && b.y < y1 + 20).map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), inside: b.x >= x0 && b.x < x1 && b.y >= y0 && b.y < y1 }));
fs.writeFileSync(process.argv[4], JSON.stringify({ R: r.params.beanRadius, dets: d }));

import fs from 'fs'; import jpeg from 'jpeg-js'; import { PNG } from 'pngjs';
import { analyzeImage, batchReport, BANDS } from '../docs/js/analyzer.js';
const files = process.argv.slice(2); const samples = [];
for (const f of files) { const raw = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 2048 });
  const t = Date.now(); const r = analyzeImage({ width: raw.width, height: raw.height, data: raw.data }); r.name = f.split('/').pop();
  console.error(r.name, r.beans.length, 'rej', r.rejected.length, JSON.stringify(r.params), Date.now() - t, 'ms');
  if (process.env.OVL) { const png = new PNG({ width: r.width, height: r.height }); png.data = Buffer.from(raw.data); const W = r.width;
    for (let i = 0; i < W * r.height; i++) { const l = r.labelMap[i]; if (!l) continue; const x = i % W; const edgeP = r.labelMap[i - 1] !== l || r.labelMap[i + 1] !== l || r.labelMap[i - W] !== l || r.labelMap[i + W] !== l;
      if (edgeP) { png.data[4*i]=0; png.data[4*i+1]=255; png.data[4*i+2]=255; } }
    r.rejected.forEach(q => { for (let d=-3; d<=3; d++){ const i=Math.round(q.y)*W+Math.round(q.x)+d; png.data[4*i]=255; png.data[4*i+1]=0; png.data[4*i+2]=0; }});
    fs.writeFileSync(process.env.OVL + '/' + r.name + '.ovl.png', PNG.sync.write(png)); }
  delete r.labelMap; samples.push(r); }
const rep = batchReport(samples); rep.date = process.env.DATE || null; rep.samples = samples.map(s => ({ name: s.name, width: s.width, height: s.height, params: s.params, rejected: s.rejected.length }));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(rep));
console.log(JSON.stringify({ perSample: rep.perSample.map(p => ({ n: p.n, mean: p.meanAgtron, L: p.meanL, sd: p.sdAgtron, u: p.uniformityPct, o: p.outliers, band: p.band })), combined: { ...rep.combined, bandHistogram: undefined }, consistency: rep.consistency }, null, 1));

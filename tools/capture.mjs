import { chromium } from 'playwright-core'; import fs from 'fs';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage(); await p.goto((process.argv[2] || 'http://localhost:8765') + '/?demo');
await p.waitForFunction(() => /Done:/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
const r = await p.evaluate(() => window.__report()); r.date = '2026-10-17'; r.batch = 'Popper roast, morning of 17 Oct 2026 — 4 independent samples = 100% of the batch'; r.generatedWith = 'Chrome (headless), same code as the live page';
fs.mkdirSync('../docs/reports', { recursive: true }); fs.writeFileSync('../docs/reports/2026-10-17.json', JSON.stringify(r));
console.log(JSON.stringify({ per: r.perSample.map(s => [s.name, s.n, s.meanL, s.meanAgtron, s.sdAgtron, s.band, s.uniformityPct, s.outliers]), c: { ...r.combined, bandHistogram: r.combined.bandHistogram.map(h => h.band + ':' + h.count).join(' ') }, cons: r.consistency }, null, 1));
await b.close();

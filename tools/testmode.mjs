import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://localhost:8765/?demo'; const tag = process.argv[3] || '';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
const popups = []; ctx.on('page', pg => popups.push(pg.url()));
await p.goto(url); await p.waitForFunction(() => /Done:/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
console.log('detector:', await p.locator('#detector').textContent());
await p.locator('#testToggle').click();
const cv = p.locator('#photo'); await cv.scrollIntoViewIfNeeded(); const bb = await cv.boundingBox();
// image coords -> css
const tapImg = async (x, y) => { await cv.tap({ position: { x: x / 1600 * bb.width, y: y / 1200 * bb.height } }); await p.waitForTimeout(150); };
await p.locator('[data-tool=missed]').tap(); await tapImg(657, 625);           // missed pale bean (also in seed)
await p.locator('[data-tool=split]').tap(); await tapImg(682, 512);            // split fragment
await p.locator('[data-tool=false]').tap(); await tapImg(800, 600);            // mark some detection false
await p.locator('[data-tool=merged]').tap(); await tapImg(900, 700);
await p.locator('[data-tool=band]').tap(); await p.selectOption('#bandPick', 'Light'); await tapImg(750, 500);
console.log('metrics:', (await p.locator('#liveMetrics').innerText()).replace(/\s+/g, ' '));
await p.locator('#tester').screenshot({ path: `/workspace/roast-tester${tag}-panel-mobile.png` });
await cv.screenshot({ path: `/workspace/roast-tester${tag}-overlay-mobile.png` });
await p.screenshot({ path: `/workspace/roast-tester${tag}-mobile.png`, fullPage: false });
// export + submit
const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('#exportGt').click()]); console.log('export:', dl.suggestedFilename());
await p.locator('#submitGt').click(); await p.waitForTimeout(1500); console.log('issue url length:', popups[0]?.length); (await import('fs')).writeFileSync('/tmp/issueurl.txt', popups[0] || '');
const ls = await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ra-gt:')).length); console.log('localStorage records:', ls, 'errors:', errs);
await b.close();

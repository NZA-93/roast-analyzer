import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://localhost:8765/?demo';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 900 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); await p.waitForFunction(() => /Done:/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  // click a bean near the centre of photo
  await p.locator('#photo').scrollIntoViewIfNeeded(); const box = await p.locator('#photo').boundingBox(); await p.locator('#photo').click({ position: { x: box.width * 0.47, y: box.height * 0.45 } }); await p.waitForTimeout(500);
  await p.screenshot({ path: `/workspace/roast-analyzer-${name}.png`, fullPage: true });
  await p.locator('#photo').screenshot({ path: `/workspace/roast-analyzer-overlay-${name}.png` });
  console.log(name, await p.locator('#status').textContent(), await p.locator('#beanInfo').textContent(), errs);
  await p.close(); }
await b.close();

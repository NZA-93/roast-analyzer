// E2E: load demo, open swipe review, answer 20 cards with swipes/chips, mark one missed bean, finish; time it.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['ipad', { width: 820, height: 1180 }]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; p.on('pageerror', e => errs.push(e.stack.split('\n').slice(0,3).join(' | '))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8765/?demo'); await p.waitForFunction(() => /Done:/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  await p.click('#swipeStart'); await p.waitForSelector('#card canvas');
  await p.screenshot({ path: `/workspace/swipe-${name}-card.png` });
  const t0 = Date.now(); const lat = [];
  for (let k = 0; k < 20; k++) {
    const box = await p.locator('#card').boundingBox(); const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const kind = k % 5 === 1 ? 'left' : k % 7 === 3 ? 'up' : 'right';
    await p.mouse.move(cx, cy); await p.mouse.down();
    for (let s = 1; s <= 6; s++) await p.mouse.move(cx + (kind === 'right' ? 30 : kind === 'left' ? -30 : 0) * s, cy + (kind === 'up' ? -30 * s : 0));
    if (k === 0) await p.screenshot({ path: `/workspace/swipe-${name}-drag.png` });
    await p.mouse.up();
    if (kind === 'left') { await p.waitForSelector('#chips:not([hidden])'); if (k === 1) await p.screenshot({ path: `/workspace/swipe-${name}-chips.png` });
      if (k === 6) { /* let it time out -> unspecified */ } else await p.click(k === 11 ? '#chipTwo' : '[data-r="not-bean"]'); }
    const tA = Date.now(); await p.waitForFunction(n => document.getElementById('swProgress').textContent.startsWith(String(n)) || !document.getElementById('gaps').hidden, Math.min(k + 2, 20) + '/', { timeout: 5000 }).catch(() => {}); lat.push(Date.now() - tA);
    if (k === 2) { await p.click('#swUndo'); await p.waitForTimeout(50); const bx = await p.locator('#card').boundingBox(); await p.click('#btnRight'); await p.waitForTimeout(200); }
  }
  await p.waitForSelector('#gaps:not([hidden])'); await p.screenshot({ path: `/workspace/swipe-${name}-gaps.png` });
  const g = await p.locator('#gapCanvas').boundingBox(); await p.mouse.click(g.x + 5, g.y + 5);
  const el = Date.now() - t0;
  await p.click('#gapsDone'); await p.waitForSelector('#done:not([hidden])'); await p.waitForTimeout(300);
  await p.screenshot({ path: `/workspace/swipe-${name}-done.png` });
  const out = await p.evaluate(() => JSON.parse(localStorage.getItem('ra-swipe-outbox')));
  const bt = out.at(-1).batch; const cnt = {}; bt.answers.forEach(a => { const k = a.answer + (a.reason ? ':' + a.reason : ''); cnt[k] = (cnt[k] || 0) + 1; });
  console.log(name, { ms: el, answers: bt.answers.length, picks: bt.answers.reduce((o, a) => (o[a.pick] = (o[a.pick] || 0) + 1, o), {}), cnt, missed: bt.missed.length, msg: await p.locator('#doneMsg').textContent(), sample: bt.answers[0], errs });
  await p.close(); }
await b.close();

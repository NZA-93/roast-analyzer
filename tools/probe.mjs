import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage(); p.on('pageerror', e => console.log('ERR', e.message)); p.on('console', m => console.log('C', m.text()));
await p.goto('http://localhost:8765/?demo'); await p.waitForTimeout(15000); console.log(await p.locator('#status').textContent()); await b.close();

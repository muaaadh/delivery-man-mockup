// Screenshot pages at desktop + phone widths with Playwright (cached under ~/.npm/_npx).
// Usage: node tools/shot.js <outDir> <path>[,<path>...] [--widths=1280,390] [--full] [--base=http://localhost:4180]
// Example: node tools/shot.js /tmp/shots /,/request/,/admin/#/orders --full
const path = require('path');
const fs = require('fs');
module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
(async () => {
  const [outDir, list, ...flags] = process.argv.slice(2);
  const opt = Object.fromEntries(flags.map(f => { const [k, v] = f.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const widths = String(opt.widths || '1280,390').split(',').map(Number);
  const base = opt.base || 'http://localhost:4180';
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  for (const p of list.split(',')) {
    for (const w of widths) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 800 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push({ path: p, width: w, error: String(e) }));
      page.on('console', m => { if (m.type() === 'error') errors.push({ path: p, width: w, console: m.text() }); });
      await page.goto(base + p, { waitUntil: 'networkidle' }).catch(e => errors.push({ path: p, width: w, error: 'goto: ' + e.message }));
      await page.waitForTimeout(600);
      const name = (p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home') + '-' + w + '.png';
      await page.screenshot({ path: path.join(outDir, name), fullPage: !!opt.full });
      const overflow = await page.evaluate(() => {
        const bad = [];
        const dw = document.documentElement.clientWidth;
        document.querySelectorAll('body *').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > dw + 1 || r.left < -1)) bad.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '') + ' right=' + Math.round(r.right));
        });
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: dw, offenders: bad.slice(0, 8) };
      });
      if (overflow.scrollWidth > overflow.clientWidth + 1) errors.push({ path: p, width: w, overflow });
      console.log('shot', name);
      await ctx.close();
    }
  }
  await browser.close();
  if (errors.length) { console.log('ISSUES:\n' + JSON.stringify(errors, null, 1)); } else console.log('no page errors, no horizontal overflow');
})();

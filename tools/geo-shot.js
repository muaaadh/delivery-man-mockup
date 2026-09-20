// Screenshot the corridor calibration page. Usage: node tools/geo-shot.js <outDir> [fit1,fit2,...]
const path = require('path'); const fs = require('fs');
module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2] || '/tmp/mdm-shots'; fs.mkdirSync(out, { recursive: true });
  const fits = (process.argv[3] || 'all,south,bridge,north').split(',');
  const b = await chromium.launch();
  for (const f of fits) {
    const p = await b.newPage({ viewport: { width: 1000, height: 900 } });
    await p.goto('http://localhost:4180/mr-delivery-man-mockup/tools/geo-preview.html?fit=' + f, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => window.__ready).catch(() => {});
    await p.waitForTimeout(3500);
    await p.screenshot({ path: path.join(out, 'geo-' + f + '.png') }); console.log('geo-' + f + '.png');
    await p.close();
  }
  await b.close();
})();

module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://localhost:4180/mr-delivery-man-mockup/tools/_scratch/ui-int.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.MDM && MDM.ui);
  const r = await page.evaluate(() => ({
    storeBadge: MDM.badgeFor.toString().includes('statusLabel') === false, bf: MDM.badgeFor('in_transit', { customer: true }), sb: MDM.ui.statusBadge('delivered'),
    money: MDM.ui.money(1250), moneyNeg: MDM.ui.money(-20), cents: MDM.ui.money(1250, { cents: true }), delegates: MDM.ui.money(7) === MDM.pricing.format(7),
    keys: Object.keys(MDM.ui).sort(), globals: Object.keys(window).filter(k => /^(el|esc|toast|drawer|dialog|confirm|phone)$/.test(k)),
  }));
  console.log(JSON.stringify(r, null, 1)); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();

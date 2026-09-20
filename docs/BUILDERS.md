# Page builder guide

Read `docs/SPEC.md` first (binding). This file is the practical checklist for building one page.

## Files
- Each page is a folder with `index.html` (`request/index.html` …) plus `page.js` in the same folder (`request/page.js`). The root home is `index.html` + `home.js`.
- Page-scoped CSS goes in `<page>/page.css` (root home: `home.css`), linked after `css/pages.css`, with every rule scoped under the page's body class (`body.page-request …`). Never restyle base components; add only the layout the page needs. Do not edit `css/pages.css` (shared, owned by the CSS builder).
- Never edit `css/base.css`, `js/*.js` shared files, or another page's folder. If a shared file has a bug that blocks you, work around it in your page script and report it.

## Head and script order (copy exactly; from a subfolder the prefix is `../`, from the root it is `./`)
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Request a delivery · Mr. Delivery Man</title>
<meta name="description" content="…">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23111114'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='Inter,system-ui,sans-serif' font-weight='600' font-size='18' fill='%23fff'%3EM%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<!-- only on pages with a map: -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css" integrity="sha384-K282sW/zFjTkrjR/+yr1H+gCukuy4OEYrkXRybV88g7pk+kZZYpNV6SAV59NcgFg" crossorigin="anonymous">
<link rel="stylesheet" href="../css/base.css">
<link rel="stylesheet" href="../css/pages.css">
<link rel="stylesheet" href="./page.css">
<!-- only on pages with a map: -->
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js" integrity="sha384-KKgyz2mG25bKJ1O2PyqTJPlAF8Kw2BpDmsLTNBXslICOBvhTAyF5F0XhLWF2ZovY" crossorigin="anonymous"></script>
<script defer src="../js/mdm.js"></script>
<script defer src="../js/icons.js"></script>
<script defer src="../js/store.js"></script>
<script defer src="../js/roads.js"></script>
<script defer src="../js/geo.js"></script>
<script defer src="../js/pricing.js"></script>
<script defer src="../js/map.js"></script>
<script defer src="../js/live.js"></script>
<script defer src="../js/ui.js"></script>
<script defer src="../js/shell.js"></script>
<script defer src="../js/seed.js"></script>
<script defer src="./page.js"></script>
</head>
<body class="page-request" data-page="request">
<a class="sr-only" href="#main">Skip to content</a>
<header data-shell="public"></header>
<main id="main"> … </main>
<footer data-shell="public-footer"></footer>
</body>
</html>
```
Admin pages use `<div data-shell="admin"><main id="main"></main></div>` instead of the public header/footer.

## Page script shape
```js
(function (MDM) { 'use strict';
  const { el, esc } = MDM.ui;
  async function main() {
    await MDM.store.ready;
    const settings = await MDM.store.settings();
    // render(); subscribe; …
  }
  main();
})(window.MDM);
```
- Read data only through `MDM.store` (every call returns a Promise). Never touch `localStorage` directly except the keys the spec assigns to your page (`sessionStorage mdm:draft`, `mdm:me`, `mdm:session`, `mdm:driver`, `mdm:timeScale`).
- Re-render from one `render()` on `MDM.store.subscribe(...)`; never patch DOM from the message payload.
- Prices: only `MDM.pricing.quote/recalc/format/feeLines/lineLabel/sizePriceLabel/reasonText`. Status badges: only `MDM.badgeFor(status, { customer })`. Status text: `MDM.STATUS[status].label|customer`.
- Links: relative with trailing slash (`../track/?order=…`) or `MDM.href('track/?order=' + id)`.
- Maps: `MDM.map.create(el, opts)` (Promise; on rejection show `.map__fallback`), `MDM.map.marker`, `MDM.map.stopMarkers`, `MDM.map.route`, `MDM.map.driverMarker`, `MDM.map.fit`, `MDM.map.refresh`, `MDM.map.destroy`. Only pages that include the MapLibre tags may call these; check `MDM.map.available()`.
- Icons: `MDM.icon(name, size)` (throws on unknown; list in `MDM.iconNames`). Icons only inside buttons, nav, timeline, markers, alerts, close controls.
- Build DOM with `MDM.ui.el`; escape every interpolated string with `MDM.ui.esc` when you use a template literal.
- Dialogs: `MDM.ui.confirm`, `MDM.ui.dialog`; drawer: `MDM.ui.drawer`; toasts: `MDM.ui.toast`. Never `alert/confirm/prompt`.
- `data-testid` attributes exactly as listed in SPEC §3 for your page and §5.

## Local testing
- Dev server: `node tools/serve.js 4180 &` serves the PARENT folder; open `http://localhost:4180/mr-delivery-man-mockup/<page>/`.
- Playwright: `module.paths.push('/Users/muadhhashim/.npm/_npx/6bcb61ec6d5aea22/node_modules'); const { chromium } = require('playwright');`
- Screenshots: `node tools/shot.js /tmp/shots /mr-delivery-man-mockup/request/ --full` (1280 + 390; reports page errors and horizontal overflow).
- Wait for readiness: `await page.waitForFunction(() => window.MDM && MDM.store.readyState === 'ready')`.
- Admin login skip: `context.addInitScript(() => localStorage.setItem('mdm:session', JSON.stringify({ user: 'admin', at: new Date().toISOString() })))`.
- Seed facts: 23 orders MDM-1025…MDM-1047; MDM-1038 is in transit with rider `drv_nazim`; MDM-1036/1037 are in payment review with slips; MDM-1034 is quote pending (Villimalé); MDM-1035 awaiting payment; MDM-1040 on hold; MDM-1041/1042 confirmed and unassigned; MDM-1039 assigned to `drv_shiyam`; business account `bacc_kandu` with 4 delivered orders this month. `MDM.store.reset()` restores this.
- Before you finish: `bash tools/check.sh` must print nothing for your files; screenshots at 1280 and 390 show no overflow, no overlap, no unreadable text; every interactive element on your page works in the headless flow you script; no `console.error`/page errors.

## Shared package editor (`js/package-editor.js`, owned by the request-page builder; used by the admin "New order" drawer)
```js
MDM.packageEditor.create({
  service: 'pick' | 'shop' | 'business',
  settings,                       // from MDM.store.settings()
  value: pkg | null,              // edit mode when given
  first: pkg | null,              // package 1, enables "Same drop-off and recipient as package 1" (checked by default) for later packages
  me: { name, phone } | null,     // the customer, for "Same as me" / "Deliver to me"
  savedAddresses: [{ label, address, zone, meetAt }],   // optional, offers "Use a saved address"
  onSave(pkg), onCancel(),
}) → { el: HTMLElement, validate() → boolean, getValue() → pkg, focus(), destroy() }
MDM.packageEditor.summary(pkg, service) → { title, pickupLine, dropoffLine, flags: ['Fragile', 'Vehicle'] }
```
`pkg` shape (no price; the store/pricing add it): `{ id, size:'bag'|'box'|'xl', description, needsVehicle, fragile, underOneFt (business only), pickup:{ address, zone, landmark, contact:{ name, phone }, cargo:{ terminal, boat, time, consignee, receiptNo }|null, meetAt }|null, dropoff:{ address, zone, landmark, recipient:{ name, phone }, cargo:{…}|null, meetAt }, shop:{ name, zone, address, list, budget, unavailable:'call'|'skip'|'closest' }|null, notes }`.
The editor renders every field in SPEC §3.2 Step 1 (size segmented with live prices from `MDM.pricing.sizePriceLabel`, cargo/airport variants, contact/recipient blocks, "Same as me"/"Deliver to me", fragile/vehicle, notes) using base.css components only, validates on blur/save with `MDM.ui.setError`, and carries the `data-testid`s from §3.2. It contains no page-specific layout. Load it after `js/shell.js` and before `js/seed.js` on pages that use it.

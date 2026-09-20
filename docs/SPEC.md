# Mr. Delivery Man — web app mockup spec (v2)

Client: Mr. Delivery Man, a delivery service in the Greater Malé area (Malé, Hulhumalé Phase 1 & 2, Villimalé, Velana International
Airport). Deliverable: a static website (vanilla HTML/CSS/JS, no build step, GitHub Pages) with a customer site, a working
request → cart → bank-transfer checkout with slip upload, live delivery tracking that works in the browser, a driver console, and an
admin portal that functions on demo data. Everything persists in the browser (localStorage) through one store layer shaped so a
real backend (Supabase: Postgres + Realtime + Storage) replaces it later without rewriting pages.

This is the contract. Builders follow it exactly; reviewers fail pages that deviate. Where it says "from settings", the value is read
at render time from `MDM.store.settings()` and never typed into HTML.

---------------------------------------------------------------------------------------------------------------------------------

## 1. The client's brief (verbatim facts) and how the mockup models them

Verbatim from the client:
- "We provide delivery service within greater Male' Area."
- Services: **We pick & deliver** · **We shop & deliver** · **Delivery service to businesses**.
- Rates depend on the size of the package. Within Malé & Hulhumalé: Bags MVR 35 to 45 · Box MVR 45 to 60 · XL packages MVR 60++
- Shopping fee 10% of price · Cargo fee MVR 20 · Airport fee MVR 40
- "In case packages cannot be carried by bike there will be an extra vehicle charge."
- Business: MVR 25 per package within Malé, Hulhumalé Phase 1 & 2 (packages below 1 foot)

Rule R1, size × same-island/cross-island (mockup interpretation; Admin → Rates shows the caption "Assumed rule, confirm with client"):
- `settings.rates.sizes = { bag:{same:35, cross:45}, box:{same:45, cross:60}, xl:{same:60, cross:60, quoted:true} }` — absolute figures
  per cell so the owner types the numbers they actually charge. "cross" applies when pickup island ≠ drop-off island.
- Islands (from zones): `male`, `hulhumale` (Phase 1 and Phase 2 share it), `hulhule` (airport), `villimale`.
- The public rates table prints the client's ranges verbatim ("Bags MVR 35 to 45") with the line "Lower figure within one island,
  higher figure when we cross the bridge." XL prints "from MVR 60" and never a computed figure.
- Fees: `settings.rates.cargo = 20`, `settings.rates.airport = 40`, `settings.rates.shoppingPct = 10`, `settings.rates.business = 25`.
- Fee scope (`settings.rules`, Admin → Rates, caption "Assumed, confirm with client"): `airportReplacesCross:true` (a package touching
  the airport is priced at its same-island figure and the airport fee is added once per order), `cargoFeePer:'package'` (cargo fee per
  package whose pickup or drop-off is a terminal), `airportFeePer:'order'`.
- Extra vehicle: no fixed figure from the client. Customer ticks "Too big or heavy for a bike" → `needsVehicle:true` → quote required.
  Admin adds it as an adjustment (preset "Extra vehicle charge") when sending the quote.
- Quote-required orders (`totals.quoteRequired`, reasons from `xl`, `vehicle`, `villimale`, `other_zone`): the customer does not
  transfer money first. The order is saved as `quote_pending`; admin sends a quote (final total + note) → `awaiting_payment` → the
  customer pays. See §3 Request step 4, §3 Checkout, §3 Admin drawer.
- Shop & deliver: the shop is the pickup (shop name, shop zone, optional address, shopping list, budget, "If something is unavailable":
  Call me · Skip it · Buy the closest match). Amount due at checkout = budget + 10% of budget (shopping fee) + delivery line + fees.
  Copy on the review step: "You pay the shopping budget up front. We refund or ask for the difference after we show you the receipt."
  Driver "Picked up" on a shop stop requires the receipt total (MVR) and a receipt photo; the shopping fee is recomputed as 10% of the
  receipt; `order.settlement` records the balance; the track page shows it; admin marks it settled.
- Business: MVR 25 per package under 1 ft within Malé + Hulhumalé. Business customers are invoiced monthly. Business orders are created
  by admin (New order → business account) with per-package "Under 1 ft" (default on); packages that are not, or that touch a zone
  outside male/hulhumale, are priced at the standard rule and appear on the same invoice with their own rate.
- Villimalé: ferry only, quote on request (`quoteReasons:['villimale']`). Zone select also offers "Other (we'll confirm)" → `other_zone`.
- Currency: `MVR 45` (thousands separator, no decimals); invoices/receipts `MVR 1,250.00`; negatives with a true minus `−MVR 20`.
- Phones: mobile `/^(\+?960[ -]?)?[79]\d{6}$/`; landline `/^(\+?960[ -]?)?3\d{6}$/` (business form only); recipient phone for airport
  deliveries may be international (`+` and 8 to 15 digits). Display `+960 7XX XXXX`. Links: `tel:+9607XXXXXX`,
  `https://wa.me/9607XXXXXX?text=…`, `viber://chat?number=%2B9607XXXXXX`.
- Addresses: Malé uses ward prefix + house name + floor + road ("M. Kaneerumaage, 2nd floor, Majeedhee Magu"); Hulhumalé Phase 1
  uses building/block/apartment ("Amin Avenue, Block B, Apt 4-02"), Phase 2 mostly towers ("Hiyaa Tower 5, Apt 14-03"). Free text with a
  zone select beside it and an optional "Landmark or instructions" line.
- Demo bank details (`settings.banks`): Bank of Maldives, account name "Mr. Delivery Man", `7730 0000 12345`; Maldives Islamic Bank
  `9010 0000 67890`. Transfer reference = the order code. The checkout bank block is the only public element labelled demo.

---------------------------------------------------------------------------------------------------------------------------------

## 2. Design direction: "Plain, precise, product-grade"

Standing rule from the studio: functional clarity over editorial flourish; plain sans-serif; readable labels; nothing that looks
generated. Reviewers fail a page on any violation of the hard rules.

### 2.1 Hard rules
- White background, near-black text, one grey scale, one brand blue used sparingly. No gradients, glass, blur, glow, gradient text,
  emoji, purple/indigo, illustrations, stock photos, fake testimonials, fake logos, fake counts, or superlatives ("seamless",
  "effortless", "elevate", "unleash", "revolutionize", "supercharge").
- All text is left-aligned. No centred headings, paragraphs, button pairs, confirmation panels or empty states. The admin login card is
  the only vertically centred layout and its contents are still left-aligned. Body paragraphs max-width 60ch.
- No `text-transform: uppercase` anywhere; no letter-spaced eyebrow labels; no small-caps table headers. Sentence case everywhere.
- Links are named for their destination ("See all rates", "Request a business account"). Never "Learn more", "Get started",
  "Explore", or a link/button ending in an arrow or chevron. Inline links `--brand`, underline on hover/focus. Nav links `--text-2`,
  active `--text`.
- Icons appear only inside buttons, nav items, the timeline, map markers, alerts and close controls. Never beside a heading, never in a
  tinted circle, never as decoration in a list row. No avatars or initials circles; people are shown by name.
- No 3-icon feature grids. "What we do" and "How it works" are rows separated by 1px borders.
- Cards (`1px solid --border`, radius 8px, no shadow) are for discrete objects only: an order, a package row, the summary, a driver, a
  KPI row, the login form. Page sections are never wrapped in a card. Never a card inside a card. Cards never lift or gain a shadow on
  hover; an interactive card only changes its border to `--border-strong`.
- Shadows only on floating layers: drawer, dialog, toast, map popups (`--shadow`).
- Motion: opacity/transform transitions ≤ 200ms on hover/focus and drawer/dialog open. No scroll reveals, parallax, shimmer or pulse.
  `@media (prefers-reduced-motion: reduce)` disables transitions; the simulated marker still moves, in steps.
- Copy: short, concrete, the client's voice. No exclamation marks. No em dashes in UI strings (use a comma or " · "). Ranges use "to"
  ("35 to 45"). Numbers as digits. Time estimates always carry "usually" or "estimated".
- Every number on the public site is a §1 rate or a value from settings (`ops`, `contact`, `banks`, `sizeGuide`, `terms`).
- Never leave `TODO`, `lorem`, placeholder brackets, "TBC", or `console.log` in shipped files. Never `href="/…"` or `src="/…"`.

### 2.2 Tokens (`css/base.css` `:root`)
```
--bg:#ffffff; --surface:#f7f7f8; --surface-2:#f0f0f2; --border:#e5e5ea; --border-strong:#d4d4d9;
--text:#111114; --text-2:#5c5c66; --text-3:#8a8a94;
--accent:#111114; --accent-hover:#2a2a30;      /* primary buttons are black */
--brand:#0f6fde; --brand-hover:#0b5cb8;        /* links, focus, driver marker, in-transit */
--ok:#1a7f4b; --ok-bg:#e8f5ee;  --warn:#b86e00; --warn-bg:#fff4e0;  --danger:#c62828; --danger-bg:#fdecec;  --info:#0f6fde; --info-bg:#e9f1fd;
--radius:8px; --radius-sm:6px; --radius-xs:4px;
--shadow:0 8px 24px rgba(17,17,20,.08), 0 1px 2px rgba(17,17,20,.06);  --focus:0 0 0 3px rgba(15,111,222,.25);
--font:"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;  --container:1120px;  --gutter:24px (16px < 720px);  --header-h:64px;
```
Surface usage: `--surface` only for the admin main area behind cards, the sticky "Your request" panel, `.dropzone`, interactive row
hover and the login page background. `--surface-2` only for `.skeleton` and the active sidebar item. Public sections are always on
`--bg`; never alternate section backgrounds.

### 2.3 Typography
Inter (Google Fonts `wght@400;500;600`, `display=swap`) with the system stack as fallback. Body 15px/1.5. Small 13px/1.4. Labels
13px/500. H1 30px/600 letter-spacing -0.01em (26px < 720px), H2 22px/600, H3 16px/600, no tracking on H2/H3. One H1 size site-wide (the
home headline is the same size as any other H1). Weight 600 only on H1–H3, the wordmark, `.btn--primary` and totals; everything else
400/500. Prices, order codes, phone numbers and table numbers use `.mono` (= `font-variant-numeric: tabular-nums`, same family).
Form controls are 16px on screens < 720px (so iOS does not zoom) and 15px above.

### 2.4 Brand
Wordmark only: "Mr. Delivery Man" (16px/600, letter-spacing -0.01em, `--text`) in the header and footer. `MDM.logo()` returns the
wordmark markup (a `<span class="brand__word">`). Favicon: 32px black square with a white "M" as an inline SVG data URI. No other mark.

### 2.5 Components (all in `css/base.css`; pages never restyle them)
- `.container` (1120px, gutters), `.container--narrow` (760px), `.page-head` (H1, optional `.page-head__desc` 15px `--text-2` 60ch,
  optional `.page-head__actions` right on desktop / below on mobile; 32px bottom margin, 24px mobile), `.section-head` (H2, optional desc,
  optional single action link right; 20px bottom margin). Every page starts with `.page-head`; every section is
  `<section aria-labelledby>` starting with `.section-head`. `<hr class="divider">` separates sections when spacing is not enough.
- Buttons `.btn`: 40px, padding 0 14px, 14px/500, radius `--radius-sm`, 8px gap to a 16px icon, nowrap. `--primary` black/white (hover
  `--accent-hover`); `--secondary` white, 1px `--border-strong` (hover `--surface`); `--ghost` no border, `--text-2` (hover `--surface`);
  `--danger` red/white; `--sm` 32px/13px/0 10px; `--lg` 48px/15px/0 20px (driver primary 52px via `.btn--xl`); `--block`; `:focus-visible`
  `--focus`; `[disabled]` opacity .5 not-allowed; `.is-loading` prepends a 16px spinner, keeps label and width, `aria-busy`. Labels are
  verb phrases ("Continue", "Submit for verification", "Verify payment", "Assign rider"); never "Submit", "OK", "Yes".
- Inputs `.input .select .textarea`: 40px (textarea min 96px), padding 0 12px, 1px `--border-strong`, radius `--radius-sm`, white; focus
  border `--brand` + `--focus`; `.is-invalid` border `--danger`. `.checkbox`/`.radio` native with `accent-color: var(--text)`, 18px box,
  15px label right, 44px tall click area. `.field`: label above (13px/500), 6px gap, `.field__hint` 13px `--text-2`, `.field__error` 13px
  `--danger` replaces the hint; control gets `.is-invalid`, `aria-invalid`, `aria-describedby`. Placeholders only show format examples.
  Required is the default and unmarked; optional fields say "(optional)" in the label; no asterisks. Forms max-width 640px; paired fields
  in `.grid-2`. Validate on blur and on Continue; pristine fields never show errors; on Continue with errors, focus the first invalid
  control. `.form-actions`: Back (`--ghost`, left), Continue (`--primary`, right).
- `.segmented`: a `<fieldset>` of real radios (`.sr-only` inputs) rendered as one joined row of 40px options, 1px `--border-strong`,
  6px outer radius; selected bg `--text` text white; unselected white/`--text-2`. Below 420px, more than 2 options stack vertically.
  Optional `small` under the option label (e.g. price) at 12px.
- `.stepper`: `<ol>` in a row; items "1 Service", "2 Schedule", "3 Your details", "4 Review" as 13px/500 text, number and label inline;
  no circles, no lines. Current `--text` + 2px `--text` underline; done `--text-2` with a 16px check replacing the number and rendered as
  a button that goes back; upcoming `--text-3`. `aria-current="step"`. Below 720px only the current item shows its label; "Step 2 of 4"
  13px `--text-2` sits at the right.
- `.steps` (home "How it works"): `<ol>` of rows with 1px `--border` between; each row `.grid-2`: (13px `.mono` `--text-3` number +
  16px/600 title) and one 15px `--text-2` sentence. No circles, no icons, no equal columns.
- `.alert` + `--info|warn|danger|ok`: 1px solid border in the variant colour, variant `-bg` background, radius `--radius-sm`, padding
  12px 14px, 14px/1.45 `--text`, optional `.alert__title` 14px/600, optional 16px icon on the first line, optional `.alert__action`
  link. Used for every notice (quote on request, vehicle charge, Villimalé, demo bank details, business note, rejected payment,
  geolocation denied, map unavailable, closed hours, public notice bar). Never a badge, toast or coloured text for these.
- `.badge` + `--ok|warn|danger|info|neutral`: 22px, 12px/500, padding 0 8px, 999px, tinted bg + coloured text, 6px dot before the
  text, never an icon; always `data-status`. `MDM.badgeFor(status, {customer})` is the only source of status badges.
- `.card` `.card__header` (14px 16px, 1px bottom border, H2/H3 15px/600) `.card__body` (16px; 20px on ≥ 720px) `.card__footer`.
- `.rate-table`: the generic label · value component (rates, order details, customer, driver, bank details, invoice header): rows
  min-height 40px, label 13px `--text-2` left, value 15px right-aligned (`.mono` when numeric), 1px `--border` between rows,
  `.rate-table__row--head` for a group heading, `.rate-table__label small` for a sub-line.
- `.summary`: a `.card`; `.summary__line` rows (description left, `.mono` amount right; fee rows `--text-2`; sub-line 13px), a 1px
  `--border-strong` rule, then `.summary__total` 17px/600. Quote-required orders label the total "Estimated total" and add one
  `.alert--warn` under the card listing `quoteReasons` in plain words.
- `.table`: `th` 13px/500 `--text-2` sentence case, 1px bottom border; rows min 48px, 15px, `td` padding 12px, 1px `--border` between,
  no zebra. Numeric/price columns `.num .mono` right-aligned; status column uses the badge. Hover bg `--surface` only when the row is
  interactive. Clickable rows: the first cell is a real `<a href>`/`<button>` that opens the target; the whole row also opens on click.
  Address cells `max-width: 280px` ellipsis + `title`; never ellipsis on code/name/status. Newest first; no column sorting.
  `.table--stack` (< 720px): `thead` visually hidden; each row a bordered block; every `td` carries `data-label` rendered by
  `td::before`; cells with `.table__primary` (code, status) sit first on one line. `.table-wrap { overflow-x: auto }` for wide tables.
  `.pagination`: "Showing 1 to 25 of 140" 13px `--text-2` left, Previous/Next `.btn--secondary .btn--sm` right; page size 25.
- `.kpi-row`: one `.card` holding 4–5 `.kpi` columns separated by 1px dividers (2 per row < 720px). `.kpi`: label 13px `--text-2`,
  value 24px/600 `.mono`, optional third line 13px `--text-3` in words ("9 yesterday"). No arrows, coloured percentages, sparklines, icons.
- `.list` / `.list__item` (`.list__main`, `.list__title` 14px/500, `.list__meta` 13px `--text-2`, `.list__aside`), `.list__item--link`.
- `.timeline`: vertical, 8px dot at x=0, 1px `--border-strong` line; done dot `--text`, current dot white with 2px `--brand` ring,
  upcoming `--border-strong`; item: 15px label, 13px `--text-2` time, optional 13px detail; no per-event icons or cards.
- `.stops` / `.stop` (route list): 24px marker (square for pickup, circle for drop-off) with the stop number; `is-done`, `is-current`,
  `is-failed`; title 14px/500, meta 13px `--text-2`, aside right 13px.
- `.tabs` / `.tab[aria-selected]`, `.filters` (row of `.select`s + `.segmented` + `type="search"` input), active-filter chips
  (`.btn--ghost .btn--sm` "Status: Assigned ×") + "Clear filters".
- `.drawer`: right, 480px (600px for an order), backdrop `rgba(17,17,20,.4)`, `--shadow`, `100dvh`; header 56px (title 17px/600, badge,
  close `.btn--ghost .btn--sm` icon x with `.sr-only` "Close"); body scrolls; sections are `<h3>` + `.rate-table`/`.list` separated by
  1px `--border`, no nested cards; sticky footer with the action buttons. Below 720px full width; footer adds
  `padding-bottom: env(safe-area-inset-bottom)`. Focus trap; Escape closes; focus returns to the opener. If the record changes from
  another tab while open, re-render but keep unsent textarea text.
- `.dialog` on `<dialog>` + `showModal()`: `min(420px, calc(100vw - 32px))`, radius, shadow, title 17px/600, body 15px `--text-2`,
  optional `.field`s, footer Cancel (`--secondary`) then the confirming button (`--primary` or `--danger`). Used for Cancel order,
  Reject payment (reason), Decline request, Remove package, Reset demo data, Mark delivered, Send quote, Couldn't complete, Mark paid.
- `.toast`: bottom-right, max 360px, white, 1px `--border`, radius, shadow, 14px, `role="status"`, auto-dismiss 4s (8s danger), max 3
  stacked; kind = a 16px icon in the variant colour only. Below 720px: bottom-centre, `calc(100vw - 32px)`, `bottom: calc(var(--bottombar-h, 0px)
  + env(safe-area-inset-bottom) + 12px)`.
- `.empty`: left-aligned, 15px/500 title, 13px `--text-2` one-sentence hint, optional `.btn--secondary .btn--sm`; no icon; 32px padding.
  Standard copy: track "No order with the code MDM-1043. Check the code in your confirmation message."; admin orders "No orders match
  these filters." + Clear filters; driver "No stops assigned to you today."; live "No riders online."; customers/business "Nothing here yet."
- `.skeleton`: static `--surface-2` block, radius `--radius-xs`, no animation; for table rows before render and the map box until the
  style loads.
- `.dropzone`: 1px dashed `--border-strong`, radius, `--surface`, 24px padding, 15px/500 "Upload your transfer slip", 13px "JPG, PNG or
  PDF, up to 8 MB", `.btn--secondary .btn--sm` "Choose a file" ("Choose a file or take a photo" < 720px; drag wording hidden under
  `@media (hover: none)`); the real `<input type=file>` is `.sr-only` (not `display:none`). Once chosen: a row with a 56px thumbnail (or a
  "PDF" label), file name, size, and "Remove" (`.btn--ghost .btn--sm`).
- `.map`: explicit height (300px < 720px, 420px desktop; `.map--tall` 560px; `.map--fill` fills its column), 1px `--border`, radius 8px,
  `position: relative`; `.map__overlay` top-right holds the "Recenter" `.btn--secondary .btn--sm`; `.map__fallback` shows `.alert--warn`
  "Map unavailable right now. Stops and status are still updated below." when the style fails or 6s pass without a load event.
  Markers: `.marker--pickup` (14px black square, r=4, white 2px border), `.marker--dropoff` (14px brand circle), `.marker--done` (green),
  `.marker--failed` (red), `.marker--driver` (28px white circle, 2px brand ring, 16px navigation icon rotated by `--heading`, initials
  label below), `.is-stale` (50% opacity). `.marker__label` 11px/500 white chip under the marker. `.map-legend` 13px row.
- Public shell: `.site-header` sticky 64px white with 1px bottom border; brand left; `.site-nav` (Services · Rates · Business · Track
  an order) `--text-2` 14px/500, active `--text`; `.site-header__actions` with "Request a delivery" `.btn--primary` (hidden < 860px, where
  a menu button opens the nav as a panel and the CTA appears inside it). Optional `.notice-bar` (13px `--text-2`, `--surface`, 1px
  bottom border) under the header when `settings.notice.active`. `.site-footer`: 1px top border, one row on desktop (contact as text
  links + hours left; page links right), stacked on mobile; no columns, newsletter, social icons or "made with" line.
- Admin shell: `.admin` grid 240px sidebar + fluid main; sidebar white, 1px right border, nav items 36px 14px/500 `--text-2` with a 16px
  icon, active `--surface-2` `--text`, count chips right (`.count`, `.is-hot` warn tint); no coloured bar, no dark sidebar. Below 960px a
  56px `.topbar` (menu button + view title 16px/600) and the sidebar becomes a left drawer. Main area `--surface`, 24px padding (16px
  mobile); content in `.card`s; each view starts with `.page-head` whose H1 has `tabindex="-1"` for focus.
- `.mobile-bar` (request page < 960px): fixed bottom, 56px + safe area, white, 1px top border, total `.mono` 17px/600 + package count
  left, Continue `.btn--primary` right; sets `--bottombar-h: 56px` on `body`.
- Print (`@media print` in base.css): hides header, footer, sidebar, topbar, `.btn`, toasts, drawer; `body.page-invoice` 20mm margins,
  black text, borders no lighter than `#999`, table header repeats.

### 2.6 Mobile conventions
Viewport `width=device-width, initial-scale=1, viewport-fit=cover`. Full-height layouts use `100dvh`. Tap targets ≥ 44px on public and
driver pages (`.btn--sm` only inside admin tables/drawers). `@media (hover: hover)` guards hover styles. Keyboards: phone
`type="tel" inputmode="numeric" autocomplete="tel"`; amounts `inputmode="decimal"`; order code `inputmode="numeric"`; name
`autocomplete="name"`; address `autocomplete="street-address"`; email `type="email" autocomplete="email"`; last field of a step
`enterkeyhint="next"`. Addresses and descriptions `overflow-wrap: anywhere`; only admin tables truncate. No horizontal scroll at 360px.

---------------------------------------------------------------------------------------------------------------------------------

## 3. Pages

URLs are folders with `index.html` so GitHub Pages serves clean paths. The site lives at `https://<user>.github.io/<repo>/`, so links are
relative to the page (`../track/?order=…` from a subfolder, `./track/` from the root index; always with the trailing slash) or built with
`MDM.href('track/?order=' + id)`. Never `href="/…"`.

Every page: `<!doctype html>`, `lang="en"`, the viewport meta above, `<title>… · Mr. Delivery Man</title>` (the title is the one place
" · " joins), `<meta name="description">`, favicon data URI, Google Fonts preconnect + Inter, `../css/base.css` (+ `../css/pages.css`),
MapLibre CSS/JS on pages with a map, then the shared scripts in the fixed order (§4.1), then the page script, all `defer`.
`<body class="page-<name>" data-page="<name>">` (home, request, checkout, track, business, driver, admin, invoice). First child of body:
`<a class="sr-only" href="#main">Skip to content</a>`; public pages then `<header data-shell="public"></header>`, `<main id="main">`,
`<footer data-shell="public-footer"></footer>`. Admin: `<div data-shell="admin"><main id="main"></main></div>`.

### 3.1 `/` Home (`index.html`)
1. Left-aligned block, max-width 640px: H1 "Delivery within Greater Malé" (or equally plain), one paragraph ≤ 25 words, the two buttons
   side by side (Request a delivery `--primary`, Track an order `--secondary`), then the hours line 13px `--text-2` from `settings.ops`
   ("Open today 09:00 to 23:00 · Malé and Hulhumalé"; outside hours "Closed now, open from 09:00"). No dot, no pulse, no badge.
2. "What we do": three rows separated by 1px borders: service name 16px/600, one sentence, "From MVR 35" `.mono` (from settings), and a
   named link ("Request a pickup", "Request a shopping run", "For businesses").
3. "Rates": `.rate-table` with the three size lines exactly as §1 (ranges verbatim + the bridge note), size guides from
   `settings.sizeGuide`, and a second group with the fees (Shopping fee 10% of the receipt · Cargo fee MVR 20 · Airport fee MVR 40 ·
   Vehicle charge "confirmed before dispatch" · Business MVR 25 per package, under 1 ft). One line: "Prices in Maldivian Rufiyaa."
4. "How it works": `.steps` with four rows: Request → Transfer and upload your slip → We pick up → Track it to the door (one sentence
   each; review time from `settings.ops.reviewText`).
5. "Where we deliver": a non-interactive `.map--short` (zones as labelled drop-off markers, corridor drawn at 35% opacity) with a
   `.map-legend` and one sentence listing the zones and the Villimalé/other-zone note.
6. Footer from the shell.

### 3.2 `/request/` Request a delivery
One `<form data-testid="request-form">` with the `.stepper` and four sections; only the current step is visible. Steps push
`#step-1..#step-4` so Back works; a direct load of `#step-3` with an empty draft goes to `#step-1`. The draft state object is written to
`sessionStorage['mdm:draft']` on every change and restored on load; "Start over" (`.btn--ghost` in the panel) clears it. Only the Review
step's button is `type="submit"`; every other button is `type="button"`; the form's submit handler advances the current step. Desktop
layout `.request-layout { grid-template-columns: minmax(0,1fr) 320px; gap: 32px }`; the panel is a `.card` `position: sticky; top: 80px`
holding a compact `.summary` (package lines, fees, total or "Estimated total", "Start over"); below 960px the `.mobile-bar` replaces it.

Step 1 Service and packages
- `.segmented` `data-testid="request-service"` with options Pick & deliver (`request-service-pick`), Shop & deliver
  (`request-service-shop`), For a business (`request-service-business`). Choosing business does not navigate: it shows `.alert--info`
  "Business deliveries are MVR 25 per package and invoiced monthly. Request a business account." (link to `../business/`) and hides the
  package editor.
- Packages list ("Your packages", 1 to 10). Each saved package is a `.card` (`data-testid="package-row"`, `data-package-id`) showing size,
  description, pickup and drop-off (one line each, zone in `--text-2`), fragile tag if set, line price `.mono` right, and actions Edit ·
  Duplicate · Remove (`.btn--ghost .btn--sm`; Remove confirms via dialog only if the row has a description). "Add a package"
  (`data-testid="request-add-package"`, `.btn--secondary`) opens the inline editor inside the list (not a modal), in add or edit mode.
  Continue is blocked with `.field__error` "Add at least 1 package" when the list is empty.
- Package editor (Pick & deliver): Size `.segmented` (`package-size-bag|box|xl`) with option labels "Bag · MVR 35", "Box · MVR 45",
  "XL · from MVR 60" (same-island figures from settings; when the two zones differ the cross figure replaces it live); a 13px hint under
  it from `settings.sizeGuide`. "What is it" (`package-description`, short text, `autocomplete="off"`). "Too big or heavy for a bike"
  checkbox (`package-vehicle`) and "Fragile" checkbox (`package-fragile`). Pickup: address (`package-pickup-address`), zone select
  (`package-pickup-zone`, options from `MDM.geo.zoneOptions()`), landmark (optional), "Cargo boat or terminal" checkbox → replaces the
  address with terminal select (Malé North Harbour · Malé T-Jetty · Hulhumalé ferry terminal · Villimalé ferry terminal · MPL commercial
  harbour), boat name, expected time, consignee name as written on the cargo, cargo receipt no. (optional); airport zone → "Meeting point"
  select (Arrivals hall · Departures entrance · MACL cargo terminal · Seaplane terminal · Hulhulé Island Hotel). Pickup contact name +
  phone (default "Same as me" checkbox checked → uses step 3 details). Drop-off: address (`package-dropoff-address`), zone
  (`package-dropoff-zone`), landmark, the same cargo/airport variants, "Meet at" select (Door · Lobby, I'll come down · Reception or
  security), recipient name + phone with "Deliver to me" checkbox. Packages after the first show "Same drop-off and recipient as package
  1" (checked by default) which hides those fields. Notes for the rider (optional). Save (`package-save`, `--primary`) · Cancel.
- Package editor (Shop & deliver): Shop name, shop zone (drives same/cross), shop address or landmark (optional), Shopping list
  (textarea), Budget MVR (`inputmode="decimal"`, `package-budget`), "If something is unavailable" `.segmented` (Call me · Skip it · Buy
  the closest match), expected package size (Bag default), then the same drop-off block. The live line shows "Shopping fee 10% ·
  MVR 41" under the budget.

Step 2 Schedule: `.segmented` ASAP (default, hint `settings.ops.asapText`) or "Pick a time": date input + window select built from
`settings.ops.slotStart/slotEnd/slotMinutes`; for today, windows starting before now + 30 min are not offered; windows inside
`ops.closedWindows` are not offered; if none remain today the date defaults to tomorrow and ASAP is disabled with the hint "We are closed
now. ASAP requests are picked up from 09:00." (from settings).

Step 3 Your details: name, phone (mobile regex), email (optional), notify `.segmented` (SMS · WhatsApp · Viber), "Remember me on this
device" checkbox (stores `mdm:me`). If a saved customer exists, fields are prefilled and the pickup/drop-off address fields in step 1
offer "Use a saved address". Step 3 offers "Save this address as Home".

Step 4 Review: `.summary` with each package line ("Bag · Malé to Hulhumalé Phase 1" + description sub-line), fee rows with reasons
("Airport fee, pickup at Arrivals"), adjustments none, total. For shop orders the budget line and the up-front copy from §1. When
`quoteRequired`: total labelled "Estimated total", `.alert--warn` listing the reasons ("XL packages are quoted before pickup", "A vehicle
may be needed", "Villimalé is quoted before pickup"), and the button reads "Send request for a quote" (`request-submit`); otherwise
"Continue to payment" (`request-submit`). Submit: `upsertCustomer`, then `insert('orders', …)` in one call with `status:'awaiting_payment'`
(or `'quote_pending'`), `payment:{ method:'transfer', status:'unpaid' }`, `source:'web'`, a `created` event by `customer`, then navigate to
`MDM.href('checkout/?order=' + order.id)`. `sessionStorage` draft is cleared after insert.

### 3.3 `/checkout/` Pay by bank transfer
Reads `?order=<id>` (or `?code=`). Guards: missing/unknown → `.empty` "This payment link is not valid" + "Request a delivery".
`quote_pending` → `.alert--info` "We're confirming your price. We'll message you the payment link on <channel>." + track link, no bank
details. `payment_review` → the confirmation panel. `confirmed` or later → redirect to `../track/?order=`. `cancelled` → `.alert--danger`
"This order was cancelled" + track link. `service:'business'` → `.alert--info` "No payment needed now. This order goes on your monthly
invoice." + track link. `payment.status === 'rejected'` → `.alert--danger` "We could not match your transfer: <reason>. Upload the slip
again or contact us." with the form re-enabled and payer fields prefilled.

Form (max-width 640px, `.rate-table` blocks): order code 24px `.mono` (`checkout-code`) with Copy; "Amount due" (`checkout-amount`);
the `.alert--info` "Demo bank details, replace before launch" then one `.rate-table` row per bank with the account number 17px `.mono`
and a Copy button (`checkout-copy-account`; label "Copy" → "Copied" 1.5s; clipboard fallback selects the text); the line "Use the order
code <code> as the transfer reference"; "Paid from" bank select (`checkout-bank`: Bank of Maldives · MIB · Other bank), "Account holder
name" (`checkout-payer-name`), "Amount transferred" MVR (`checkout-paid-amount`, prefilled with the total), "Transfer reference or
transaction ID" (optional, `checkout-reference`); the `.dropzone` with the `.sr-only` file input (`checkout-slip-input`,
`accept="image/jpeg,image/png,image/webp,application/pdf"`) and preview (`checkout-slip-preview`), and under it 13px "Your slip is seen
only by our admin and used to match your transfer."; the terms line from `settings.terms` with a required checkbox "I've read what we
carry" (`checkout-terms`); "Submit for verification" (`checkout-submit`, `--primary`).

File rules: max 8 MB before processing; images drawn to a canvas at ≤ 1200px long edge, `toBlob('image/jpeg', 0.8)`; if > 1.2 MB retry
900px/0.7; still larger → `.field__error` "Please choose a smaller image". PDFs up to 1 MB raw, previewed as a file row with "Open"
(object URL, `target=_blank rel=noopener`; never navigate to a data: URL). HEIC/HEIF → error "Upload a JPG, PNG or PDF. On iPhone, take a
screenshot of the transfer receipt instead." No `capture` attribute. The file is inserted into `files` immediately on select and
`order.payment.slip = { fileId, name, type, size }` is written (status unchanged) so a reload keeps the preview; `StoreError('quota')` →
`.field__error` "This browser is out of storage space for the demo. Reset demo data from the admin or use a smaller file."

Submit: `update('orders', id, { payment:{ …, bank, payerName, paidAmount, reference, submittedAt } })` then
`transition(id, 'payment_review', { by:'customer' })`. Confirmation panel: a `.card` with H2 "Payment submitted", the code 24px `.mono` +
Copy, "We will message you on WhatsApp at +960 7XX XXXX" (channel from `customer.notify`), "What happens next" `<ol>` (review time from
`settings.ops.reviewText`), and one `.btn--primary` "Track this order" (`checkout-track-link`). No large icon, no green panel.

### 3.4 `/track/` Track an order
Input (`track-input`, `inputmode="numeric"`, "MDM-" optional, case-insensitive, trimmed; `/^\d+$/` → prefixed) + "Track" (`track-submit`).
Also reads `?order=<id>` or `?code=`. Unknown → the `.empty` copy. The result replaces the input; "Track another order" (`--ghost`)
returns. Result header: status badge (`track-status`, `data-status`), customer label, "Updated 4 min ago" (`timeAgo`, else `fmtDate`),
the code `.mono`, buttons "Copy tracking link", "Share with recipient" (wa.me + viber links carrying the URL), "Call us" (settings).

Per status: `quote_pending`: `.alert--warn` "We're confirming your price. We'll send the payment link on <channel>." + "Cancel this
request" (`--ghost`, dialog; sets cancelled by customer). `awaiting_payment`: `.alert--warn` "Awaiting your transfer" + `.btn--primary`
"Pay and upload your slip" → checkout + "Cancel this request"; no map. `payment_review`: "Slip received, we'll confirm shortly (usually
within <reviewText>)"; no map. `confirmed`: map with pins only. `assigned` with no position in the last 2 min: map with pins +
`.alert--info` "Rider assigned. Live location appears once the rider starts." `picked_up` / `in_transit`: live marker, ETA (`track-eta`)
"Estimated arrival 14:20" from `MDM.geo`; staleness: > 15s "Updated N s ago" beside the driver card; > 60s hide the ETA and show "Rider
location unavailable right now" and set the marker `.is-stale`; no position → no marker. `on_hold`: `.alert--warn` "We couldn't complete
a stop (<reason in words>). We'll contact you." `delivered`: static route, proof-of-delivery row ("Delivered to Aminath (family) at
14:32", photo thumbnail from `files` if any), settlement block for shop orders ("Receipt MVR 412 · Shopping fee MVR 41 · We owe you
MVR 46" or "Please pay the difference MVR 30"). `cancelled`: `.alert--danger` with the public reason ("Cancelled, refund sent" when a
refund exists); no map; timeline kept. From `payment_review` onward "Ask to cancel" opens the customer's channel with a prefilled message.

Below the map: `.stops` list (`track-stop` rows with `data-stop-id`, `data-status`; tapping a stop pans the map), the driver card
(`.rate-table`: name, vehicle, "Call rider" tel link, source badge "Demo"/"GPS"), the totals (`.summary` incl. adjustments; "Total
updated" events appear in the timeline), the payment state, and the `.timeline` (`track-timeline`) of public events only. Only the status
text and ETA sit inside the `aria-live="polite"` region. Map 300px < 720px, 420px desktop; "Recenter" overlay. The page re-renders from
`store.subscribe('orders')` + `live.onPosition(driverId)`; no polling.

### 3.5 `/business/` For businesses
`.page-head`; the rate and conditions as a `.rate-table` (MVR 25 per package · Malé and Hulhumalé Phase 1 & 2 · packages under 1 ft ·
larger packages at standard rates · invoiced monthly, due in `settings.invoiceDueDays` days); "How it works" `.steps` (Request an
account → Daily pickups from your shop → One invoice a month → Track every package); the account request form (max 640px): business
name, contact person, mobile, landline (optional, 3xxxxxx), email, island (zone select limited to male/hulhumale zones), pickup address,
pickup window (select: Morning 09:00 to 12:00 · Afternoon 13:00 to 17:00 · Evening 18:00 to 22:00), expected packages per week (select:
1 to 10 · 11 to 30 · 31 to 100 · More than 100), notes (optional). Submit → `insert('business_requests', …)`; the form is replaced by a
`.card` "Request received" with the business name, "We will call <phone> within 1 working day" (from `settings.ops.businessReplyText`),
and "Back to home". A second submission with the same normalised phone shows `.alert--warn` "We already have a request for this number".

### 3.6 `/driver/` Driver console (mobile-first)
One column, max-width 560px, no tables. Top: driver select (`driver-select`; demo, in production a login) and an `.segmented` Online /
Offline (`driver-online`), a 13px status line ("Sharing location · GPS · 12 s ago", "Sharing location · Demo route", "Location off",
"Weak GPS signal" when accuracy > 100 m), and the note "Keep this screen open while on route; phones pause location sharing in the
background." Buttons: "Simulate route" (`driver-simulate`, `--secondary`) and "Use my GPS" (`driver-gps`, `--secondary`; disabled with
the inline note "Location sharing needs an https address (it works on the published site)" when `!isSecureContext`). `?speed=N` (and
`localStorage mdm:timeScale`) sets the simulation time scale. The chosen driver id and online state live in `sessionStorage`.

Route: the driver's active orders as ordered stops from `store.driverRoute(driverId)`. Each order block starts with the code, customer,
and a "Start route" `.btn--primary .btn--xl .btn--block` when the order is `assigned` (→ `in_transit`, driver `on_route`). Each stop is a
`.card` (`driver-stop`, `data-stop-id`): type + package size line 13px `--text-2` (+ "Fragile" tag, "Shop" for shop pickups with the list
and budget), the address 17px/500 `overflow-wrap: anywhere` never truncated, landmark/meeting point line, contact name with `tel:`; a
`.grid-2` of "Call" and "Directions" (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>&travelmode=driving`) as
`.btn--secondary .btn--block`, then the primary action `.btn--primary .btn--xl .btn--block`: "Arrived" (`driver-stop-arrived`) → "Picked
up" / "Delivered" (`driver-stop-done`) and a secondary "Couldn't complete" (`driver-stop-failed`, dialog: reason select No answer · Wrong
address · Closed · Refused · Not ready · Boat not arrived + note → stop `failed`, order `on_hold`). Shop pickup "Picked up" dialog: receipt
total MVR + receipt photo (required). "Delivered" dialog: "Handed to" `.segmented` (Recipient · Family or colleague · Security or
reception · Left as instructed), name (required unless left as instructed, `autocomplete="name"`), optional photo
(`accept="image/*" capture="environment"`, resized ≤ 800px, stored in `files`), "Skip photo" allowed. Completed stops collapse to a
one-line row with a check icon and time; the next stop gets `is-current` and scrolls into view. `navigator.wakeLock` on Go online,
released on Go offline, failures ignored. Empty: "No stops assigned to you today."

Location: "Use my GPS" calls `watchPosition` synchronously inside the click handler (`{ enableHighAccuracy:true, maximumAge:1000,
timeout:10000 }`); errors by code: 1 → `.alert--danger` "Location permission is off. Allow location for this site in your browser
settings, or use Simulate route for the demo."; 2/3 → "Could not get a location fix. Try again outdoors." Publish ≤ 1/s and only when
moved ≥ 3 m or heading changed ≥ 10°. "Simulate route" runs `MDM.live.simulate(driverId, route.polyline, { stops, autoStops:false,
timeScale })` and pauses within 40 m of each stop until the driver taps the stop action.

### 3.7 `/admin/` Admin portal
Login (any hash while signed out): a 400px `.card` centred, wordmark, username (`admin-user`) + password (`admin-pass`), "Sign in"
(`admin-login`), `.alert--info` "Demo sign-in: admin / delivery", error `.alert--danger` "Wrong username or password" (username kept).
Session `localStorage['mdm:session'] = { user:'admin', at }`; after sign-in route to the requested hash. Sidebar bottom: "Signed in as
Admin" + "Sign out".

Router grammar `#/<view>[/<id>][?<query>]`. Routes: `#/overview`, `#/orders`, `#/orders?status=&service=&zone=&range=&q=&customer=&account=`,
`#/orders/:orderId` (drawer over the list), `#/live`, `#/live?driver=`, `#/drivers`, `#/customers`, `#/business`, `#/business/:accountId`,
`#/rates`, `#/settings`. Empty/unknown → `location.replace('#/overview')`. Views register as `MDM.admin.views[name] = { title,
mount(el, params) → Promise, unmount() }`; the router awaits `unmount()` (unsubscribe everything, clear intervals, close the drawer,
remove maps) before `mount()`; sets `document.title`, `aria-current="page"` on the sidebar link, focuses the view H1. Filters write back
to the hash with `history.replaceState`.

- `#/overview`: `.kpi-row` (Orders today · Awaiting verification · Quotes to send · In transit · Delivered today · Payments verified today
  MVR), "Needs attention" `.list` (payment reviews, quotes pending, unassigned confirmed, on-hold orders, business requests; each links
  to the order/route), recent orders table (10), `.map--short` of online riders.
- `#/orders`: `.page-head` with "New order" (`orders-new`, `--primary`); `.filters` (Status, Service, Zone selects; `.segmented` Today ·
  7 days · 30 days · All; search `type="search"` by code/name/phone; below 960px a "Filters" button with a count opens a drawer with the
  same controls); active filter chips + "Clear filters". Table (`orders-row`, `data-order-id`, `data-status`): Code (link to
  `#/orders/<id>`), Customer (name + phone sub-line), Service, Route ("Malé → HM Ph. 1", packages count), Total `.mono`, Payment badge,
  Status badge, Rider, Created. Drafts excluded unless Status = Draft. Pagination 25.
  **Order drawer** (600px, `drawer`): header code + status badge + close; sections: Customer (`.rate-table`: name, phone with tel/wa/viber
  links, notify channel, source), Packages (`.list` rows: size, description, pickup → drop-off with zones, contact/recipient, flags),
  Route (`.stops` with statuses/times/handedTo; proof photo thumbnails from `files`), Pricing (`.summary` with adjustments; "Add
  adjustment" `drawer-add-adjustment` → dialog: preset select Extra vehicle charge · Waiting time · Boat freight advanced · Re-delivery ·
  Discount · Other + amount (negative only for Discount); after verification it also logs a public "Total updated" event), Payment
  (declared amount vs total with a "Matches"/"Does not match" badge, reference, bank, payer, slip preview from `files` (image thumbnail
  → opens full-size in a dialog; PDF → "Open" object URL), verified/rejected details; refund details when present), Quote (when
  `quote.status !== 'none'`), Settlement (shop orders), Notes (`.list` + textarea "Add note"), Activity (`.timeline` of all events;
  internal ones marked "Internal" in `--text-3`). Footer actions by status (only these):
  - `quote_pending`: Cancel · Send quote (`drawer-send-quote`, dialog: final total prefilled with the estimate, note; records the
    difference as an adjustment "Quote adjustment", sets `quote`, transitions to `awaiting_payment`, logs public "Quote sent: MVR 150",
    then offers "Send update" via the customer's channel with the checkout link).
  - `awaiting_payment`: Cancel unpaid order (reason) · Mark as paid (dialog, note required; sets payment verified, transitions to confirmed).
  - `payment_review`: Reject (`drawer-reject`, dialog, reason required → payment rejected, back to `awaiting_payment`) · Verify payment
    (`drawer-verify`, `--primary`; enabled only after ticking "Amount received in our account" → payment verified, `confirmed`).
  - `confirmed`: Cancel · Assign rider (`drawer-assign-driver` select listing online riders first, offline marked "(offline)";
    `drawer-assign` button → `assignDriver`).
  - `assigned`: Reassign · Cancel · Mark picked up. `picked_up` / `in_transit`: Mark delivered (dialog: handed to + name).
  - `on_hold`: Retry stop (stop → pending, attempts+1, optional adjustment) · Return to sender (adds a return drop-off at the pickup;
    order back to `in_transit`) · Cancel.
  - `delivered`: Mark settled (shop orders with a balance; reference). `cancelled`: Record refund (when payment was verified; amount, bank,
    account, reference → customer label "Cancelled, refund sent").
  - Always (except delivered/cancelled): "Send update" opens the customer's channel with "Mr. Delivery Man: order MDM-1043 is <customer
    label>. Track: <url>" and logs "Update sent via WhatsApp" (internal). Cancelling after a verified payment requires the refund dialog.
  **New order** (drawer): source `.segmented` (Web · Viber · WhatsApp · Phone · Walk-in), customer by phone (upsert; existing customer
  autofills) or business account picker; the same package editor as `/request/` (with "Under 1 ft" per package for business); schedule;
  Create → transfer orders insert as `awaiting_payment` (or `quote_pending`), business orders as `confirmed` with
  `payment:{ method:'invoice', status:'invoiced' }`.
- `#/live`: map fills the main height (`calc(100dvh - 56px)` < 960px) with a 320px right column listing riders (status, current order,
  current stop, "Updated 12 s ago"; click selects: that rider's route at full opacity, others at 35%; `?driver=`); active orders below.
  Empty "No riders online."
- `#/drivers`: table (name, phone, vehicle, status, today's stops) + "Add rider" drawer (name, phone, vehicle Bike · Car · Pickup) and
  edit/set offline.
- `#/customers`: table (name, phone, orders, last order) → click filters `#/orders?customer=`.
- `#/business`: tabs Requests (approve → creates `business_accounts` row; decline with reason) and Accounts (name, contact, this month's
  packages, invoice total, "View invoice"). `#/business/:accountId`: account details, this month's orders, "Generate invoice" (creates
  `invoices` row INV-<YYYY-MM>-<seq> with itemised lines from delivered business orders that month, due in `settings.invoiceDueDays`,
  optional GST line when `settings.gstPercent > 0`), invoice list with "Mark paid" (date, reference) and "Send" (wa.me/viber link with
  the invoice URL). `/admin/invoice.html?id=<invoiceId>` is the printable invoice (`body.page-invoice`): number, period, issued, due,
  business name/address/TIN, itemised rows (date, order code, recipient, packages, rate, amount), subtotal, GST, total `MVR 0.00`, bank
  details, "Reference: INV-…", print button (`no-print`).
- `#/rates`: form editing `settings.rates` (the 3×2 size grid, xl quoted flag, cargo, airport, shoppingPct, business), `settings.rules`
  (caption "Assumed, confirm with client"), `settings.sizeGuide` (caption "Wording to confirm with client"), `settings.ops` ("Operations ·
  demo defaults, not from the client brief"), `settings.banks`, `settings.terms`, `settings.invoiceDueDays`, `settings.gstPercent`. Save →
  `saveSettings(patch)`; the public site reads the new values on next render.
- `#/settings`: "Demo contact details, replace before launch" (`settings.contact`: phone, whatsapp, viber, email), public notice
  (`settings.notice.text` + on/off), `settings.demo.autopilot` on/off, Reset demo data (dialog), Export JSON (with/without files), Import
  JSON.

---------------------------------------------------------------------------------------------------------------------------------

## 4. Shared code (`js/`) — contracts

### 4.1 Files, load order, wrapper
Fixed order on every page: `[maplibre-gl.js when the page has a map]`, `js/mdm.js`, `js/icons.js`, `js/store.js`, `js/roads.js`,
`js/geo.js`, `js/pricing.js`, `js/map.js`, `js/live.js`, `js/ui.js`, `js/shell.js`, `js/seed.js`, then the page script; all `<script defer>`.
(`js/roads.js` is a generated road graph, 74 KB, that geo.js routes over; it is loaded on every page because assignDriver needs it.)
Dependency direction is strictly left-to-right and only inside functions (no load-time calls except seed.js's boot call). Wrapper:
```
(function (MDM) { 'use strict';
  MDM.store = { … };   // exactly one export per file, named after the file (icons.js exports MDM.icon)
})(window.MDM);
```
No other globals, no `type="module"`, `'use strict'` everywhere. Page scripts: `async function main() { await MDM.store.ready; … } main();`.

`js/mdm.js` (first): `window.MDM = { ROOT, SCHEMA: 1, href(p), id(prefix) }` where `ROOT = new URL('../', document.currentScript.src).href`,
`href(p) = ROOT + p.replace(/^\/+/, '')`, `id(prefix) = prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)`
(never `crypto.randomUUID`). Prefixes: ord_, cus_, drv_, pkg_, stp_, evt_, adj_, breq_, bacc_, inv_, file_.

MapLibre tags (exact; verified SRI):
```
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css" integrity="<SRI-CSS>" crossorigin="anonymous">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js" integrity="<SRI-JS>" crossorigin="anonymous"></script>
```
(The exact `integrity` values are in `docs/CDN.md`; copy them verbatim.) Tiles: OpenFreeMap `https://tiles.openfreemap.org/styles/positron`
(free, no key). Attribution control stays visible.

### 4.2 `MDM.store` (js/store.js)
Every data method returns a real Promise (resolved in a microtask; no loading UI needed) and pages `await` every call. Docs cross the
boundary through `structuredClone`; mutating a returned object never changes the store.
```
MDM.store.ready : Promise<void>; MDM.store.readyState : 'booting'|'ready'
get(col, id) → doc|null
list(col, q?) → doc[]            // q = { where?:{ field: value|value[] }, order?:'createdAt'|'-createdAt'|'-updatedAt', limit?:n }; default '-createdAt'
insert(col, doc) → doc           // fills id, createdAt, updatedAt (and orders.code from meta.orderSeq) when absent
update(col, id, patchOrFn) → doc // shallow merge at top level; a nested object/array in the patch REPLACES the old value; fn form gets a clone and returns a patch; read-modify-write against localStorage in one synchronous step; StoreError('not_found')
remove(col, id) → void
settings() → settings; saveSettings(patch) → settings   // deep-merges only known top-level keys
subscribe(col|'*', cb) → unsubscribe                     // cb({ collection, id, op:'insert'|'update'|'remove'|'reset', origin:'local'|'remote' })
reset() / exportJSON({ includeFiles }) / importJSON(text)
```
Collections: `orders`, `customers`, `drivers`, `business_requests`, `business_accounts`, `invoices`, `positions` (id = driverId),
`events` (audit log, capped at 1000, oldest trimmed), `files` (`{ id, kind:'slip'|'proof'|'receipt', orderId, name, type, size, dataUrl, at }`).
Keys: `mdm:schema`, `mdm:v1:<collection>`, `mdm:v1:settings`, `mdm:v1:meta = { seededAt, dirty, orderSeq, invoiceSeq }`, `mdm:me`,
`mdm:session`, `mdm:timeScale`, `mdm:simlease`, `sessionStorage mdm:draft`, `mdm:driver`. Boot (`MDM.store._boot(buildSeed)`): if
`mdm:schema !== MDM.SCHEMA` → remove all `mdm:` keys and seed; else if `!meta.dirty && now - seededAt > 12h` → reseed silently; `dirty`
becomes true on the first write to any collection except `positions`. `MDM.StoreError extends Error` with `.code` in
`not_found|quota|transition|validation|schema`. `localStorage.setItem` is wrapped; quota → `StoreError('quota')`.
Cross-tab: exactly one transport (`BroadcastChannel('mdm')` if available, else the `storage` event). Message `{ v:1, tabId, collection,
id, op }`. Local writes invalidate the local cache and notify local subscribers the same way (`origin:'local'`). On receipt invalidate the
cache (re-read lazily) and flush subscribers via `setTimeout(0)` coalesced per collection. `op:'reset'` notifies everything.
`visibilitychange → visible` and `focus` invalidate all caches and notify `'*'` (so no page polls). Pages render from one `async render()`
that re-reads through the store; they never patch DOM from the message payload.

Domain (the only writers of `status`, `events`, `route.stops`, `fees.adjustments`, `notes`, `quote`, `settlement`):
```
MDM.STATUS = { draft, quote_pending, awaiting_payment, payment_review, confirmed, assigned, picked_up, in_transit, on_hold, delivered, returned, cancelled }
   // each { label (admin), customer (label), kind: 'neutral'|'warn'|'info'|'ok'|'danger' }
   // labels: Draft/Draft · Quote pending/Confirming your price · Awaiting payment/Awaiting your transfer · Payment review/Checking your payment ·
   // Confirmed/Confirmed, assigning a rider · Assigned/Rider assigned · Picked up/Picked up · In transit/On the way · On hold/We couldn't complete a stop ·
   // Delivered/Delivered · Returned/Returned to sender · Cancelled/Cancelled
MDM.ALLOWED = { draft:[awaiting_payment,quote_pending,cancelled], quote_pending:[awaiting_payment,cancelled], awaiting_payment:[payment_review,confirmed,cancelled],
   payment_review:[confirmed,awaiting_payment,cancelled], confirmed:[assigned,cancelled], assigned:[in_transit,picked_up,cancelled], picked_up:[in_transit,on_hold,delivered,cancelled],
   in_transit:[picked_up,delivered,on_hold,cancelled], on_hold:[in_transit,picked_up,returned,cancelled], delivered:[], returned:[], cancelled:[] }
MDM.EVENT_TYPES = created, quote_sent, payment_submitted, payment_verified, payment_rejected, payment_marked, confirmed, assigned, reassigned, route_started,
   arrived, picked_up, delivered, stop_failed, stop_retried, return_added, on_hold, returned, cancelled, refund, adjustment, quote_adjustment, settled, note, update_sent
MDM.store.transition(orderId, next, { by, label?, meta?, visibility? }) → order      // StoreError('transition') if not allowed; appends the event
MDM.store.addEvent(orderId, { type, label, by, visibility:'public'|'internal', meta? }) → order   // appends to order.events and inserts into `events`
MDM.store.addNote(orderId, { text, by }) → order
MDM.store.addAdjustment(orderId, { preset, label, amount, by, visibility }) → order   // recalcs totals via MDM.pricing.recalc; public event "Total updated: <label> MVR n" when payment is verified
MDM.store.sendQuote(orderId, { total, note, by }) → order                            // quote:{status:'sent', total, note, sentAt, by}; adjustment for the difference; → awaiting_payment; public event
MDM.store.assignDriver(orderId, driverId, { by }) → order    // builds route.stops (pickups first then drop-offs, ids stp_*, geocoded) + route.polyline via MDM.geo.routeThrough; → assigned (or reassigns)
MDM.store.startRoute(orderId, { by }) → order                // assigned → in_transit; driver.status 'on_route'
MDM.store.setStop(orderId, stopId, { status:'arrived'|'done'|'failed'|'pending', by, handedTo?, recipientName?, photoId?, receiptTotal?, receiptPhotoId?, failReason?, note? }) → order
   // derives: any pickup done → picked_up; all pickups done and drop-offs remain → in_transit; all drop-offs done → delivered (+ settlement for shop orders); any failed → on_hold
MDM.store.retryStop(orderId, stopId, { by }) / returnToSender(orderId, { by }) → order
MDM.store.driverRoute(driverId) → { orders:[...], stops:[...stop, orderId, code], polyline }   // computed from that driver's active orders (assigned/picked_up/in_transit/on_hold), never stored
MDM.store.upsertCustomer({ name, phone, email, notify, address? }) → customer        // keyed by MDM.ui.phone.normalize(phone)
MDM.store.markPaid / verifyPayment / rejectPayment / recordRefund / markSettled (orderId, {...}) → order
MDM.badgeFor(status, { customer:false }) → HTML string of <span class="badge badge--kind" data-status>
```
`by` ∈ `'customer' | 'admin' | 'driver:<driverId>' | 'system'`. `order.events` is what pages render; `/track/` renders `visibility:'public'`
only. Pages never push into `order.events`, `route.stops`, `fees.adjustments` or `notes` directly.

Order shape:
```
{ id:'ord_…', code:'MDM-1042', createdAt, updatedAt, source:'web'|'viber'|'whatsapp'|'phone'|'walkin',
  service:'pick'|'shop'|'business', customerId, customer:{ name, phone, email, notify:'sms'|'whatsapp'|'viber' }, accountId?,
  packages:[{ id:'pkg_…', size:'bag'|'box'|'xl', description, needsVehicle, fragile, underOneFt?,
     pickup:{ address, zone, landmark, lat, lng, contact:{ name, phone }, cargo:{ terminal, boat, time, consignee, receiptNo }|null, meetAt }|null,
     dropoff:{ address, zone, landmark, lat, lng, recipient:{ name, phone }, cargo:{…}|null, meetAt },
     shop:{ name, zone, address, list, budget, unavailable:'call'|'skip'|'closest', receiptTotal, receiptPhotoId }|null, notes,
     price:{ same, cross, crossIsland:bool, lineTotal } }],
  fees:{ cargo, airport, shopping, adjustments:[{ id, preset, label, amount, at, by }] },
  totals:{ packages, fees, adjustments, total, quoteRequired, quoteReasons:[] },
  schedule:{ type:'asap' } | { type:'slot', date:'YYYY-MM-DD', window:'09:00-11:00' },
  payment:{ method:'transfer'|'invoice', status:'unpaid'|'review'|'verified'|'rejected'|'invoiced', bank, payerName, paidAmount, reference,
     slip:{ fileId, name, type, size }|null, submittedAt, verifiedAt, verifiedBy, rejectReason, note, refund:{ amount, toBank, toAccount, at, by, reference }|null },
  quote:{ status:'none'|'pending'|'sent', total, note, sentAt, by },
  settlement:{ status:'none'|'refund_due'|'topup_due'|'settled', paid, due, balance, settledAt, reference }|null,
  status, driverId, route:{ stops:[{ id:'stp_…', packageId, type:'pickup'|'dropoff'|'return', label, address, zone, lat, lng, contact:{ name, phone },
     status:'pending'|'arrived'|'done'|'failed', at, attempts, handedTo, recipientName, photoId, failReason, note }], polyline:[[lat,lng],…] },
  events:[{ id, at, type, label, by, visibility, meta }], notes:[{ id, at, text, by }] }
```
Customer: `{ id, name, phone (normalised 7 digits), email, notify, addresses:[{ label, address, zone, meetAt }], createdAt, lastOrderAt, orderCount }`.
Driver: `{ id, name, phone, vehicle:'bike'|'car'|'pickup', vehicleNote, status:'offline'|'online'|'on_route' }` (no colour).
Position: `{ id (= driverId), driverId, lat, lng, heading, speed, accuracy, at, source:'sim'|'gps' }`.
Business request: `{ id, name, contactName, phone, landline, email, zone, pickupAddress, pickupWindow, volume, notes, status:'pending'|'approved'|'declined', declineReason, createdAt }`.
Business account: `{ id, name, contactName, phone, landline, email, tin, zone, pickupAddress, pickupWindow, ratePerPackage, status:'approved'|'paused', approvedAt }`.
Invoice: `{ id, accountId, number:'INV-2026-09-001', month:'2026-09', lines:[{ date, orderCode, recipient, packages, rate, amount }], subtotal, gstPercent, gst, total, status:'draft'|'sent'|'paid', issuedAt, dueAt, paidAt, reference }`.

Settings (`mdm:v1:settings`):
```
{ rates:{ sizes:{ bag:{same:35,cross:45}, box:{same:45,cross:60}, xl:{same:60,cross:60,quoted:true} }, cargo:20, airport:40, shoppingPct:10, business:25 },
  rules:{ airportReplacesCross:true, cargoFeePer:'package', airportFeePer:'order' },
  sizeGuide:{ bag:'Fits in a carrier bag: documents, food, small parcels', box:'A carton up to about 1 ft (30 cm) a side, strapped on the bike', xl:'Bigger than a box or needs two hands; may need a pickup, price confirmed first' },
  ops:{ hours:{ open:'09:00', close:'23:00' }, days:'Every day', asapText:'Usually within 60 to 90 minutes in Malé and Hulhumalé', reviewText:'about 30 minutes',
        businessReplyText:'within 1 working day', slotStart:'09:00', slotEnd:'23:00', slotMinutes:120, speedCityKmh:18, speedHighwayKmh:40, peakBufferMin:10,
        peakWindows:['08:00-09:30','17:00-19:30'], closedWindows:['Fri 12:00-13:30'] },
  banks:[ { id:'bml', name:'Bank of Maldives', accountName:'Mr. Delivery Man', accountNo:'7730 0000 12345' }, { id:'mib', name:'Maldives Islamic Bank', accountName:'Mr. Delivery Man', accountNo:'9010 0000 67890' } ],
  contact:{ phone:'7XXXXXX', whatsapp:'7XXXXXX', viber:'7XXXXXX', email:'hello@example.com' },   // demo values, edited in Admin → Settings
  terms:"We don't carry items prohibited under Maldives law or cash. Fragile items travel at the sender's risk unless they are boxed.",
  notice:{ text:'', active:false }, invoiceDueDays:14, gstPercent:0, demo:{ autopilot:true } }
```
All amounts are integers in MVR. `saveSettings` deep-merges only these top-level keys.

Seed (`js/seed.js`, `MDM.seed.build(now) → { settings, customers, drivers, business_requests, business_accounts, invoices, orders, positions, events, files }`, pure):
fixed ids and codes (`ord_seed_01`…, `drv_nazim`, `drv_shiyam`, `drv_rasheed`, codes MDM-1025 … MDM-1040; `orderSeq` = max + 1).
Drivers: Ahmed Nazim (bike, Honda Wave), Ibrahim Shiyam (bike, Yamaha), Hassan Rasheed (pickup, Toyota Hilux). Customers: Aishath Shifza,
Mariyam Nazeeha, Mohamed Rilwan, Fathimath Zeena, Ali Waheed, Hussain Afeef (phones 7XX XXXX / 9XX XXXX patterns). Addresses: Malé
"M. Kaneerumaage, 2nd floor, Majeedhee Magu", "H. Dhonveli, Boduthakurufaanu Magu", "G. Handhuvareege, Sosun Magu", "Ma. Ranfaru, Ameenee
Magu", "H. Meerubahuruge, Chandhanee Magu"; Phase 1 "Amin Avenue, Block B, Apt 4-02", "Rehendhi Flat 3, Apt 205"; Phase 2 "Hiyaa Tower 5,
Apt 14-03", "Vinares Tower 3, Apt 9-01"; Villimalé "V. Hiyaleege" (quote_pending order); airport "Velana International Airport, Arrivals
hall"; cargo "Malé North Harbour, boat Alihaa Express from Thoddoo" (a "to boat" order). Business account "Kandu Books & Stationery,
M. Kaneerumaage, Chandhanee Magu" (approved, 8 to 10 delivered business packages this month, one draft invoice); pending request
"Shifa's Cakes, home baker, Hulhumalé Phase 1, 11 to 30/week". Orders (16) across every status, dated relative to `now` over the last 7
days including today: 1 quote_pending (Villimalé), 1 awaiting_payment, 2 payment_review with generated sample slips (a plain SVG
"transfer receipt" data URL, not a real bank's branding), 2 confirmed (unassigned), 1 assigned (not started), **MDM-1038 in_transit**
(Ahmed Nazim, Malé → Hulhumalé Phase 1, position seeded on the bridge at lat 4.1800 lng 73.5210 heading 45 speed 40 source 'sim'),
1 picked_up, 1 on_hold (no answer, Hiyaa tower), 1 delivered shop order whose receipt is below the budget (refund_due), 3 delivered today
(with handedTo and one proof photo file), 1 cancelled, plus the business packages. The tracking demo link is always `/track/?code=MDM-1038`.

### 4.3 `MDM.pricing` (js/pricing.js)
```
MDM.pricing.quote(draft, settings) → { packages:[{ …pkg, price:{ same, cross, crossIsland, lineTotal } }], fees:{ cargo, airport, shopping, adjustments:[] }, totals:{ packages, fees, adjustments:0, total, quoteRequired, quoteReasons:[] }, feeLines:[{ key, label, amount, reason }] }
MDM.pricing.recalc(order, settings) → order       // re-derives totals from packages[].price, fees and fees.adjustments (and shop receiptTotal)
MDM.pricing.format(n, { cents=false }) → 'MVR 1,250' | 'MVR 1,250.00' | '−MVR 20'
MDM.pricing.lineLabel(pkg) → 'Bag · Malé to Hulhumalé Phase 1'
```
`draft = { service, packages:[{ size, needsVehicle, underOneFt?, pickup:{ zone, cargo }|null, dropoff:{ zone, cargo }, shop:{ zone, budget }|null }] }`.
Rules in order: shop packages use `shop.zone` as the pickup island. `crossIsland` = `MDM.geo.island(pickupZone) !== MDM.geo.island(dropZone)`,
except when either zone is `airport` and `rules.airportReplacesCross`. Line = `sizes[size].same` or `.cross`. Airport fee once per order
(`airportFeePer:'order'`) if any endpoint is `airport`. Cargo fee per package with a cargo pickup or drop-off (`cargoFeePer:'package'`).
Shopping fee = `Math.round(sum(budget) × shoppingPct / 100)` (or of `receiptTotal` when present). `quoteRequired` with reasons from
`{ xl, vehicle, villimale, other_zone }`. Business service: `underOneFt && island ∈ {male, hulhumale}` → `rates.business`; otherwise
the standard rule; no cross-island surcharge on business-rate packages; no fees. Integers only. Prices are frozen onto the order at
insert; later rate changes affect new quotes only. `total = packages + fees + adjustments` (+ budget up front for shop orders is shown
as its own line "Shopping budget (paid up front)" and included in `totals.total`). No page does arithmetic on prices.

### 4.4 `MDM.geo` (js/geo.js) — already written (routes follow real streets via Dijkstra over `MDM.roads`); builders use:
`ZONES`, `ZONE_LIST`, `zone(k)`, `zoneLabel(k)`, `island(k)`, `zoneOptions()` (→ `[{ value, label }]` plus `{ value:'other', label:"Other (we'll confirm)" }`),
`isCrossIsland(a, b)`, `CORRIDOR`, `routeBetween(a, b)` (villimale endpoints → `{ ferry:true }` handled by callers: no line, both pins),
`routeThrough(stops)`, `distanceKm`, `pointAt(polyline, t)`, `pointAtDistance(polyline, km)`, `projectOnto(polyline, {lat,lng})`,
`remainingKm`, `inHighway(lat, lng)`, `etaMinutes(km, crossIsland, settings)` (adds `peakBufferMin` inside a peak window when crossing),
`geocodeZone(zone, key)` (deterministic), `terminals()`, `airportPoints()`, `meetAtOptions()`.

### 4.5 `MDM.map` (js/map.js) — MapLibre wrapper; pages never call `maplibregl` directly
```
MDM.map.create(el, { interactive=true, center, zoom=12.4, fallbackEl? }) → Promise<map>   // resolves on style load; rejects after 6s or on error → caller shows .map__fallback
MDM.map.marker(map, kind, [lat,lng], { label, done, failed, heading, testid, driverId, stopId }) → { el, setLatLng, setHeading, setDone, setFailed, setStale, setLabel, remove }
MDM.map.stopMarkers(map, stops) → { update(stops), remove() }
MDM.map.route(map, id, polyline, { active=true, dashed }) → { update(polyline), setActive(bool), remove() }
MDM.map.driverMarker(map, pos, driver) → { moveTo(pos, ms=1000), setStale(bool), remove() }   // rAF lerp of lat/lng/heading only while visible; jumps when > 500 m; never extrapolates
MDM.map.fit(map, points, { padding=48, maxZoom=16 })
MDM.map.refresh(map)      // requestAnimationFrame(() => map.resize()); mandatory after revealing a map (drawer, tab, hash view)
MDM.map.destroy(map)
```
Marker roots carry `data-testid="marker-<kind>"` and `data-driver-id`/`data-stop-id`. Driver marker shows two-letter initials.

### 4.6 `MDM.live` (js/live.js)
```
MDM.live.publishPosition({ driverId, lat, lng, heading, speed, accuracy, source }) → Promise   // sets at; ≤ 1/s per driver; drops identical fixes
MDM.live.onPosition(driverId|'*', cb) → unsubscribe        // fed by store.subscribe('positions'); cb(position)
MDM.live.last(driverId) → position|null                     // sync, in-memory (test hook)
MDM.live.simulate(driverId, polyline, { speedKmh=25, timeScale=1, stops=[], dwellMs=0, autoStops=false, onStop(stop), loop=false }) → { stop(), pause(), resume(), get state }
MDM.live.watchGPS(driverId) → Promise<void>; MDM.live.stopGPS(); MDM.live.gpsState() → 'off'|'on'|'denied'|'unavailable'
MDM.live.autopilot()                                        // demo only; see below
```
Simulation is time-based (`position = pointAtDistance(polyline, elapsed × speed × timeScale)`), ticks every 1s and on `visibilitychange`;
speed 40 km/h inside `inHighway` else `speedKmh`. Pauses within 40 m of each stop and fires `onStop`; with `autoStops` it calls
`store.setStop` (arrived → done) after `dwellMs` and continues. Autopilot: when `settings.demo.autopilot`, shell.js calls it on every
page after `store.ready`; it drives MDM-1038's driver along its polyline with `autoStops:false` looping (positions only, no status
changes) so the tracking demo always moves; one tab holds the lease `mdm:simlease = { tabId, at }` refreshed every 2s, taken when missing
or older than 6s, released on `pagehide`; the driver page's Simulate/GPS takes the lease explicitly. Positions from autopilot carry
`source:'sim'`. Header comment: production deletes `autopilot()` and nothing else changes.

### 4.7 `MDM.ui` (js/ui.js)
```
el(tag, attrs?, ...children)  // attrs: class, id, dataset, on:{ event: fn }, aria-*, any attribute; children Node | string (escaped text) | array | null
esc(str), toast(msg, kind='neutral'|'ok'|'warn'|'danger', { timeout }), drawer.open({ title, badge?, body, footer?, size:'md'|'lg', onClose }) / drawer.close() / drawer.isOpen() / drawer.setBody(node)
confirm({ title, message, okLabel='Confirm', danger=false }) → Promise<bool>
dialog({ title, message?, fields:[{ name, label, type:'text'|'number'|'select'|'textarea'|'segmented'|'file'|'checkbox', options?, required?, value?, hint?, accept? }], okLabel, danger }) → Promise<values|null>
badge(kind, label, attrs?) → HTML string; statusBadge = MDM.badgeFor
setError(fieldEl, message|null); validate(formEl, rules) helpers; phone = { normalize(raw) → '7712345'|null, valid(raw, {landline, intl}) → bool, format(raw) → '+960 771 2345', links(raw, text?) → { tel, wa, viber, sms } }
fmtDate(iso, { time=true, dateOnly }) → '21 Sep, 14:32' / '21 Sep 2026'; timeAgo(iso) (< 60 min, else fmtDate); dayKey(d) → 'YYYY-MM-DD' (local); window(str) → '14:00 to 16:00'
copy(text) → Promise<bool>; debounce(fn, ms); money = MDM.pricing.format; imageToJpeg(file, { maxEdge, quality }) → Promise<{ dataUrl, size, type }>
```
Rule: pages build DOM with `el()`; where a template literal is used, every interpolated value is wrapped in `esc()`. Never `window.prompt`
/`window.confirm`/`alert`.

### 4.8 `MDM.shell` (js/shell.js)
Renders the public header (brand, nav with `aria-current` from `data-page`, CTA, mobile menu), the notice bar, the footer (contact/hours
from settings), and the admin sidebar/topbar. `MDM.logo()`. Calls `MDM.live.autopilot()` after `store.ready`. Exposes
`MDM.shell.contactLinks()` for pages.

### 4.9 Dates and "today"
All timestamps ISO 8601 UTC strings; display only through `fmtDate`/`timeAgo`. "Today" = `dayKey(iso) === dayKey(new Date())` local. KPIs:
Orders today = non-draft, non-cancelled orders created today; Awaiting verification = `payment.status === 'review'`; Quotes to send =
`quote_pending`; In transit = `assigned|picked_up|in_transit|on_hold`; Delivered today = `delivered` whose `delivered` event is today;
Payments verified today = Σ `totals.total` where `payment.verifiedAt` is today. Business monthly invoice = that account's delivered
business orders whose `delivered` event falls in the month.

---------------------------------------------------------------------------------------------------------------------------------

## 5. Test hooks and verification

`data-testid` values are required exactly as listed in §3 (kebab-case `<page>-<thing>`), plus: `toast` (`data-kind`), `confirm-ok`,
`confirm-cancel`, `dialog-ok`, `dialog-cancel`, `drawer`, `drawer-close`, `marker-driver` (`data-driver-id`), `marker-pickup`/`marker-dropoff`
(`data-stop-id`). Every status badge and status-bearing row carries `data-status`. `window.MDM` stays global and unminified; tests wait
with `page.waitForFunction(() => window.MDM && MDM.store.readyState === 'ready')`, pre-set `localStorage mdm:session` via
`addInitScript` to skip login, read positions with `MDM.live.last(id)`, and open the driver page with `?speed=30`.

Local serving: `node tools/serve.js` serves the PARENT folder so pages open at `http://localhost:4180/mr-delivery-man-mockup/…` and
sub-path mistakes surface locally. `tools/shot.js` screenshots pages at 1280 and 390; `tools/check.sh` greps for forbidden patterns
(`console.log`, `TODO`, `lorem`, `href="/`, `src="/`, `$` amounts, emoji, `—` in JS/HTML strings) and must print nothing.

Reviewers run the full flow headlessly: request 2 packages (one cross-island, one airport drop-off) → checkout with a generated PNG slip
→ admin verify → assign rider → driver simulate (`?speed=30`) → track page shows the moving marker and stops completing → delivered with
handedTo; plus: quote flow (XL → quote_pending → send quote → pay), reject flow, on-hold flow, business order → invoice, reset, two-tab sync,
refresh persistence; screenshots at 1280 and 390 for every page and admin view; the anti-slop and domain checklists in §2 and §1.

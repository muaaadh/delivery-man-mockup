# Mr. Delivery Man — web app mockup

A working mockup of the customer site, ordering, tracking, business portal, e-store, driver console, staff portal and office portal
for Mr. Delivery Man, a delivery service in Greater Malé. Static HTML/CSS/JS, no build step; everything runs in the browser on demo data so the whole product can be
clicked through end to end.

## Demo walkthrough

| Surface | URL | Notes |
| --- | --- | --- |
| Home | `/` | Customer one-pager: live order in the hero phone, the three service categories (Pick & Deliver: home, shop or godown, postal & courier, administrative services · Shop & Deliver · Business Delivery), delivery methods, rates as ranges, how it works, coverage, FAQ |
| Sign in | `/login/` | Five roles. Customer and Business by mobile + one-time code (any 4 digits); Driver and Staff by name + PIN; Office by username + password (`admin`, `operator`, `lamya`, password `delivery`) with "Forgot password" |
| Request a delivery | `/request/?category=pick` | Pick a category, then the request type (home collection; shop or godown with invoice or quotation and payment slip; postal & courier with location and tracking number; administrative services; shop & deliver with an item list). Saved addresses with labels (Home, Wife's home, Office…), order again from recent and frequent orders, Bag / Box / XL with a photo (no measurements), extra vehicle for more than one box or XL, delivery method (home, boat / ferry / speedboat, Maldivian Cargo, airport resort counter), pay after delivery or upfront |
| Track an order | `/track/?code=MDM-1038` | Status timeline with who and when, payment step, price estimate vs confirmed, cancellation request, proofs, documents, invoice link, live driver on the map |
| Pay | `/checkout/?code=MDM-1032` | Bank transfer and slip upload once payment is requested (or optional upfront after confirmation) |
| Invoice | `/invoice/?order=MDM-1031` | Printable customer invoice |
| My orders | `/account/` | History with payment and delivery status, order detail, cancellation request, messages, saved addresses |
| Business portal | `/business/` | Sign in with 780 1122 (Kandu Books) or 763 3221 (Fonu): size categories at the business's agreed rates, single orders, bulk orders by rows or Excel import (template, checks, review), collection points with a preferred time, boat details update, cancel one order inside a bulk order, cash on delivery, invoices, labels. New businesses apply with a typical package photo |
| Labels | `/labels/?batch=blk_seed_1001` | 100 × 150 mm shipping labels with QR, one per package (`?order=`, `?orders=`, `?code=`, `?batch=`) |
| E-store | `/store/` | Packaging, supplies and delivery bundles; cart and checkout into a normal delivery order |
| Staff portal | `/staff/` | Punch in / out, attendance, leave requests, accumulated off days |
| Driver console | `/driver/` | Punch in, own and zone jobs, Start → Arrived → Collected (photo, size, naalu) → Out for delivery → Delivered (photo, recipient, naalu, packing charge, cash collected), boat changed or missed, returns, report a problem with reason and photo, leave requests (collapsible) with accumulated off days, GPS or simulation |
| Office portal | `/admin/` | Role-based (admin / operator / office). Overview KPIs and action queues; orders with price confirmation, package category change, extra vehicle charge, other charges, payments, assignment, failures, cancellations, priority, change history; bulk orders by zone; Cash & COD (driver cash handover, payment to businesses, naalu and charges to reimburse); live map; drivers; customers; business accounts and agreed rates; e-store; team & HR with off days; reports with CSV; notifications; activity log; zones; rates; settings |

Useful seeded orders: `MDM-1035` (XL with a package photo) and `MDM-1034`, `MDM-1048`, `MDM-1055` need the price confirmed;
`MDM-1036` and `MDM-1037` have slips to verify; `MDM-1040` failed (recipient unavailable) and waits for a decision; `MDM-1051` has a
cancellation request; `MDM-1049` (business) and `MDM-1048` (express) have priority requests; `MDM-1032` is delivered and waiting
for payment; `MDM-1038` is out for delivery and always moving (demo autopilot); `BLK-1001` is a bulk order being delivered by zone and
`BLK-1002` is waiting for collection. Admin → Settings → "Reset demo data" restores everything; the demo also re-seeds itself after
12 hours if nothing was changed.

Orders that show the 11 October 2026 updates (full data contract in `docs/UPDATES-2026-10-11.md`):

| Update | Orders |
| --- | --- |
| Boat delivery, naalu, boat changed | `MDM-1030` (dhoni, naalu 20), `MDM-1067` (speedboat swapped, naalu 10), `MDM-1062` (bulk, speedboat to Thulusdhoo) |
| Maldivian Cargo (fee only on this method) | `MDM-1068`, `MDM-1066` (bulk) |
| Airport delivery to a resort counter | `MDM-1069`, `MDM-1050`, `MDM-1048` |
| Extra vehicle (2 XL) | `MDM-1070` |
| Packing charge on delivery / other charge | `MDM-1032`, `MDM-1054` |
| Shop & Deliver item list | `MDM-1071`, `MDM-1026`, `MDM-1033` |
| Business size categories + cash on delivery | `MDM-1072` (Fonu, medium, COD 890), `BLK-1001` (COD at each stage), `MDM-1046` (paid to the business) |
| Business cancels one order after dispatch | `MDM-1060` (return to sender) |
| Collection points + preferred time | Kandu (Shop, Godown), Fonu (Warehouse, Showroom); `BLK-1002` |
| Account request with a package photo | Shifa's Cakes (Admin → Business) |
| Labelled saved addresses, order again | Mohamed Rilwan (777 8901): Home / Wife's home / Office; `MDM-1073` and `MDM-1039` make his most frequent order |
| Accumulated off days | Ahmed Nazim, Ibrahim Shiyam, Hassan Rasheed (Team & HR, driver console, staff portal) |

The whole flow to try: request a delivery → office confirms the price, assigns and dispatches → driver console (choose that driver,
punch in, run the job with photos) → the customer pays the invoice from the tracking page → office verifies the payment.

## Pricing as modelled

Shown to customers as ranges: Bag MVR 35 to 45 · Box MVR 45 to 60 · XL MVR 60++ (the lower figure is "within one island", the higher
"across the bridge"). Shopping fee 10% · Maldivian Cargo fee MVR 20, charged once and only when that delivery method is chosen ·
airport fee MVR 40. Business accounts are priced by size category (Small / Medium / Large, starting at MVR 25 / 35 / 60) and each
business can have its own agreed rates (Kandu and Fonu are seeded with different ones). Naalu paid by drivers is reimbursed to
them and not billed to the customer unless the office marks it billable. XL, extra vehicle and Villimalé jobs are "quote first".
All of it is editable in Admin → Rates and labelled as an assumption to confirm with the client.

## Running locally

```
node tools/serve.js 4180      # serves the parent folder, open http://localhost:4180/<repo-folder>/
node tools/shot.js /tmp/shots '/<repo-folder>/,/<repo-folder>/track/?code=MDM-1038' --full   # screenshots at 1280 and 390
bash tools/check.sh           # forbidden-pattern scan (must print nothing)
```

## How it is built (and how it goes to production)

- `js/store.js` is the only thing that touches storage. Every call returns a Promise; the order status machine, events, stops,
  adjustments and quotes are written only through its helpers. The header comment maps each call to a Supabase table / Realtime
  channel / Storage bucket, so the swap is a store-only change.
- `js/live.js` publishes rider positions (real `watchPosition` on a phone, or a time-based simulation) through the same store;
  tabs stay in sync through a BroadcastChannel. In production this becomes a Realtime channel and the demo autopilot is deleted.
- Maps are MapLibre GL with OpenFreeMap's free Positron style (no API key). Routes follow real streets: `js/roads.js` is a small road
  graph of Greater Malé extracted from OpenStreetMap, and `js/geo.js` routes over it (swap for a routing API when needed).
- `docs/SPEC.md` is the contract every page was built and reviewed against; `docs/BUILDERS.md` explains the file layout and testing.

Map data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap / OpenMapTiles.

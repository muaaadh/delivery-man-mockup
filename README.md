# Mr. Delivery Man — web app mockup

A working mockup of the customer site, ordering, tracking, business portal, e-store, driver console, staff portal and office portal
for Mr. Delivery Man, a delivery service in Greater Malé. Static HTML/CSS/JS, no build step; everything runs in the browser on demo data so the whole product can be
clicked through end to end.

## Demo walkthrough

| Surface | URL | Notes |
| --- | --- | --- |
| Home | `/` | Customer one-pager: live order in the hero phone, how it works, every service (home, shop, postal & courier, airport & baggage, office assistance, e-store), normal / express / advance, rates, business, coverage, FAQ |
| Sign in | `/login/` | Five roles. Customer and Business by mobile + one-time code (any 4 digits); Driver and Staff by name + PIN; Office by username + password (`admin`, `operator`, `lamya`, password `delivery`) with "Forgot password" |
| Request a delivery | `/request/?type=postal` | Six request types with their own fields (carriers and collection codes, airport flight and baggage, office documents, shop invoice), service level, collection, Bag/Box/XL quantities with an estimated range, photo and dimensions, delivery, pay after delivery or upfront |
| Track an order | `/track/?code=MDM-1038` | Status timeline with who and when, payment step, price estimate vs confirmed, cancellation request, proofs, documents, invoice link, live driver on the map |
| Pay | `/checkout/?code=MDM-1032` | Bank transfer and slip upload once payment is requested (or optional upfront after confirmation) |
| Invoice | `/invoice/?order=MDM-1031` | Printable customer invoice |
| My orders | `/account/` | History with payment and delivery status, order detail, cancellation request, messages, saved addresses |
| Business portal | `/business/` | Sign in with 780 1122 (Kandu Books) or 763 3221 (Fonu): single orders, bulk orders with CSV, order tracking, priority requests, invoices, labels |
| Labels | `/labels/?batch=blk_seed_1001` | 100 × 150 mm shipping labels with QR, one per package (`?order=`, `?orders=`, `?code=`, `?batch=`) |
| E-store | `/store/` | Packaging, supplies and delivery bundles; cart and checkout into a normal delivery order |
| Staff portal | `/staff/` | Punch in / out, attendance, leave requests |
| Driver console | `/driver/` | Punch in, own and zone jobs, Start → Arrived → Collected (photo, size) → Out for delivery → Delivered (photo, recipient), report a problem with reason and photo, leave request, GPS or simulation |
| Office portal | `/admin/` | Role-based (admin / operator / office). Overview KPIs and action queues; orders with price confirmation, payments, assignment, failures, cancellations, priority, change history; bulk orders by zone; live map; drivers; customers; business; e-store; team & HR; reports with CSV; notifications; activity log; zones; rates; settings |

Useful seeded orders: `MDM-1035` (XL with a package photo) and `MDM-1034`, `MDM-1048`, `MDM-1055` need the price confirmed;
`MDM-1036` and `MDM-1037` have slips to verify; `MDM-1040` failed (recipient unavailable) and waits for a decision; `MDM-1051` has a
cancellation request; `MDM-1049` (business) and `MDM-1048` (express) have priority requests; `MDM-1032` is delivered and waiting
for payment; `MDM-1038` is out for delivery and always moving (demo autopilot); `BLK-1001` is a bulk order being delivered by zone and
`BLK-1002` is waiting for collection. Admin → Settings → "Reset demo data" restores everything; the demo also re-seeds itself after
12 hours if nothing was changed.

The whole flow to try: request a delivery → office confirms the price, assigns and dispatches → driver console (choose that driver,
punch in, run the job with photos) → the customer pays the invoice from the tracking page → office verifies the payment.

## Pricing as modelled

From the client's brief: Bags MVR 35 to 45 · Box MVR 45 to 60 · XL from MVR 60 · shopping fee 10% · cargo fee MVR 20 · airport
fee MVR 40 · business MVR 25 per package under 1 ft. The mockup reads the lower figure as "within one island" and the higher as
"across the bridge", treats the airport fee as covering the airport leg, and marks XL, vehicle and Villimalé jobs as "quote first".
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

# Mr. Delivery Man — web app mockup

A working mockup of the customer site, checkout, live tracking, rider console and admin portal for Mr. Delivery Man, a delivery
service in Greater Malé. Static HTML/CSS/JS, no build step; everything runs in the browser on demo data so the whole product can be
clicked through end to end.

## Demo walkthrough

| Surface | URL | Notes |
| --- | --- | --- |
| Home | `/` | Marketing page: sign-in card, at-a-glance rates, services, how it works, coverage map |
| Sign in | `/login/` | Customers by mobile number + one-time code (any 4 digits in the demo), riders by name + PIN, admin `admin` / `delivery` |
| My orders | `/account/` | The signed-in customer's orders with pay/track actions and saved addresses |
| Request a delivery | `/request/` | Pick & deliver / Shop & deliver, multi-package cart, schedule, review with live pricing |
| Checkout | `/checkout/?order=…` | Bank transfer details, slip upload (image/PDF), submit for verification |
| Track an order | `/track/?code=MDM-1038` | Live rider on the map, stops, ETA, timeline. MDM-1038 is always on the way (demo autopilot) |
| For businesses | `/business/` | MVR 25/package account request |
| Rider console | `/driver/` | Choose a rider, Start route, Arrived / Picked up / Delivered, Simulate route or Use my GPS |
| Admin | `/admin/` | Sign in with `admin` / `delivery`: overview, orders + verification drawer, live map, riders, customers, business accounts + invoices, rates, settings |

Useful seeded orders: `MDM-1036` and `MDM-1037` are waiting for payment verification (with slips), `MDM-1034` needs a quote
(Villimalé), `MDM-1035` is awaiting the customer's transfer, `MDM-1040` is on hold (no answer at the door), `MDM-1041`/`MDM-1042` are
confirmed and need a rider, `MDM-1039` is assigned to Ibrahim Shiyam. Admin → Settings → "Reset demo data" restores everything; the
demo also re-seeds itself after 12 hours if nothing was changed.

The whole flow to try: request two packages → checkout with any image as the slip → admin verifies and assigns a rider → rider
console (choose that rider, Start route, Simulate route) → the tracking page follows the rider to the door.

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

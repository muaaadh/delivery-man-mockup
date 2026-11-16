# Updates of 16/11/2026, afternoon (client points of 16/11/2026)

**A payment button at the bottom of the order.** "Can add a button down there for payments once it reaches payment stages (Finalise
price, request payment, mark as paid / verify payment)." The client's order was delivered with "Payment requested": the bottom bar had
Labels, Send update and Undo delivered, and "Mark as paid" only further up, in the Payment section.

- On a delivered order the bottom bar's main button is now the payment step the order is at, the same steps as the board's cards:
  **Finalise price** while the price is still open, then **Request payment**, then **Mark as paid**, or **Verify payment** once the
  customer's slip is in. Each opens the same dialog as the button in the Payment section, which stays where it was.
- Payment is requested by itself at delivery, so a delivered order normally opens on "Mark as paid".
- No button on an order that is paid, or on a business order on the weekly invoice (it is paid with its invoice).
- Before delivery the bottom bar keeps to the delivery steps (Assign, Dispatch, Collected…); the Payment section has the payment
  buttons at every stage, as before.

**Orders booked together for a business are one bulk order.** "These orders are submitted as bulk from backend, but [we have to]
assign [them] individually now. Can the collection assigning and collection be the same as BLK orders when placed by business login."
The office had used New order → For a business account → "Add another order" three times; each card became an order of its own, to
be assigned one by one.

- **Two or more orders on that form are now one bulk order** (BLK number), exactly like a bulk order from the business portal: the
  office names one driver to collect them all ("Assign collector"), the driver sees one bulk collection on the phone and ticks every
  package off with one photo, and the packages then go out by zone ("Assign by zone" or "Driver for this zone", then "Dispatch").
- The form says so before it is sent: beside "Add another order" it reads "2 orders, booked as one bulk order: one driver collects
  them together", and the button becomes **Create bulk order**. After creating, the bulk order opens, where the collector is chosen.
- Everything typed on a card is kept on its order: the receiver and the delivery method (home, boat with the boat's own contact,
  Maldivian Cargo, airport), the size, how many packages, fragile, cash to collect, the reference, the extra vehicle. The price of
  each order is what the same card costs as a single order.
- The timing of the form goes with the bulk order: the preferred collection time, a delivery time, Express, or an advance collection
  date and time. The bulk order's page has a "When" row for an advance date or a delivery time; the board shows the time on the bulk
  order's card, and an advance bulk order for a later day waits as one card under "Advance / Office".
- What the collector has to know is on the driver's bulk collection: when to collect and to deliver, an "Express" tag, the collection
  instructions, and "Fragile" and "Needs a vehicle" on the orders they apply to. (Express, the instructions and Fragile now show on
  every bulk collection, the business portal's too.)
- On the board the bulk order is one card ("Business bulk · 5 packages to collect"; it now counts packages, not receivers, as
  Overview does), with "Express" and "Extra vehicle" on it when they apply, so there is nothing to assign order by order. The bulk
  order's page marks the order that asked for an extra vehicle, and "Assign collector" says so before the driver is chosen.
- Every card stays an order of its own, as the form lists and prices it, also two cards for the same receiver (in a bulk order from
  the portal or a spreadsheet, lines for the same receiver are still one delivery).
- One card is still a single order, assigned to a driver as before.
- The business sees it in its portal as a bulk order, marked "Booked by our team". It keeps getting the emails it got for these
  orders before (confirmed, collected, delivered, one per order): a bulk order the business sends itself still sends none.
- Office staff without the "Bulk orders" page (the "office" role) keep getting separate orders from the form, which they can assign
  themselves: they could not open a bulk order to name its collector.

Also fixed on the way: the driver's job for an advance order from the office's form read "Collect 18 Nov at 10:00, deliver by" with
nothing after it.

In the data: `store.createBatch({ …, schedule, separate: true, rows: [{ …, fragile, extraVehicle, more: [{ tier, description,
fragile }] }] })`; `batch.schedule` is copied to each order of the bulk; the orders have `requestType: 'bulk'` and the source the
office chose (`MDM.OFFICE_SOURCES`: phone, WhatsApp, Viber, walk-in), which is also what keeps their emails on.

On the live service: the emails of one call go out eight at a time, a second apart (a bulk order of up to 20 orders has one email
per order, and the mail service takes 10 a second), and one refused for the rate is tried once more. A bulk order from before the
page's 60 days still loads, with all its orders, while one of them is open (an advance bulk order booked far ahead, or one never
collected). A bulk order sent through the business portal ignores the form's extras (timing, a card per order, extra vehicle).

Tests: demo `tools/_scratch/r18-footer.js`, `tools/_scratch/r18-bulk.js`; live `tools/supabase/test-live.js` (section 18),
`test-api.js`, `test-r10.js` (the mailer).

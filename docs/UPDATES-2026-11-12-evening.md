# Updates of 12/11/2026, evening (client points of 12/11 after the board went live)

**The price as an item table you can edit.** The order's Pricing section is now a table: Item, Qty, Rate, Amount. Packages of the
same category on the same route at the same price share one row ("Bag · Malé to Malé", 3 at MVR 40, MVR 120), then the fees, then any
other rows, then the total.

"Confirm price" (also "Finalise price" and "Change confirmed price", and "Confirm price" on a board card) opens the same table to
edit:

- Each package row has its **rate**. Type it and the amount and the total follow. A row with several packages has "Price each one",
  which opens it into one row per package when they should not cost the same.
- **Add row** adds a line: what it is (Extra vehicle charge, Naalu, Packing charge, Waiting time, Extra collection, Express
  handling, Re-delivery, Boat freight advanced, Size correction, Maldivian Cargo charges, Discount, Other), a description, a quantity
  and a rate. A discount takes the amount off. The × at the end of a row removes it. Rows added before can be changed or removed the
  same way.
- On a shopping order each shop has an "Items at …" row for what the items cost; the shopping fee follows it by itself.
- Lines that follow the order by themselves cannot be typed over: the airport fee, the Maldivian Cargo fee, the shopping fee and a
  charge billed from Charges (change that one under Charges).
- When the customer asked for an extra vehicle, or a package needs one, a button adds the vehicle row at the rate card's rate.
- "Remarks" and "Ask the customer to pay now" are as before.

The customer sees the same rows on the tracking page, the invoice and the payment page, each with its description
("Extra vehicle charge, Pickup Hire - Phase 2 > Male'") and, when there is more than one, "2 × MVR 30". "Price changes" in the order
keeps who changed what ("package MVR 35 to MVR 40", "added Naalu MVR 60").

**A confirmed total is shared out evenly.** Three bags confirmed at MVR 120 now read MVR 40 each (they read 50, 35, 35 since this
morning: the difference went on the first package). This also applies to orders confirmed before today. A price typed per row in the
new table is kept exactly as typed.

**Filter each board column by status.** The counts under a column's title ("Failed 2", "Out for delivery 2", "Delivered 14") are
now buttons. Press one to see only that status in the column; press more to add statuses; press one again to take it off; "All"
shows the whole column. Each column has its own choice, the others are not touched. While a column is filtered its count reads
"2 of 18". The choice stays while the browser tab is open.

**Cancel before anyone is assigned.** Every card in the New order column has "Cancel order" under its step button, with or without
a driver: it asks for the reason, the customer is told, and the card leaves the board. In the order itself "Cancel order" is now on
every order that is not collected yet (new, confirmed, assigned, dispatched, on the way, arrived), for the operator, office staff
and customer service as well as the admin. The dialog says what happens: "No driver is assigned yet", or the driver is told not to
collect it. Once a package is collected, cancelling still goes through "Report failed" and "Decide", which brings it back to the
sender.

**Jobs with more than one stop, for the driver.** A job with several collections or several deliveries now shows it in purple, a
colour nothing else in the driver app uses:

- a tag in the job's head, "2 collections" or "2 collections · 2 deliveries", also in the Upcoming list;
- a list of every stop in the order to do them, numbered, with the one to go to marked "Now" and the finished ones ticked green,
  and how many are left ("3 to go");
- "Collection 2 of 2" (or "Delivery 1 of 2") above the address in hand;
- the count on the big button: "Collected · 1 of 2", "Delivered · 2 of 2";
- right after a collection or delivery with another one to go, a message: "Next collection, 2 of 2: G. Second Shop".

A job with one collection and one delivery looks as before.

Tests: demo `tools/_scratch/r16-client.js` (price table, column filters, cancel, the driver's stops) and `r16-driver-flow.js` (the
driver's buttons through a job with two collections and two deliveries).

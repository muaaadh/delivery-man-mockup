# Weekly business billing (client answer, 25 Oct 2026)

The client settled the open question: businesses are billed **weekly**, not monthly.

## The billing week

- A billing week runs **Sunday to Saturday** (the Maldives working week starts on Sunday), on local dates.
- `MDM.billingWeek(dateOrKey)` → `{ from, to }`: the Sunday and the Saturday of that day's week, as `YYYY-MM-DD` keys.
- `MDM.invoicePeriod(x)` → `{ from, to }` for an invoice, a `{ from, to }` or a `YYYY-MM` month (1st to last day).
- `MDM.inPeriod(x, at)` → whether a timestamp falls on a local day inside the period.
- `MDM.periodLabel(x, { year })` → `19–25 Oct 2026`, `26 Oct – 1 Nov 2026`, `28 Dec 2026 – 3 Jan 2027`; an invoice that has only
  a month reads `October 2026`.

All four live in `js/store.js`, so the browser and the live API (which runs the same file) agree.

## Invoices

- `MDM.store.createInvoice(accountId, period)` takes a billing week `{ from, to }`. A `YYYY-MM` string still works and makes a
  monthly invoice the way it did before.
- Lines are the account's orders whose **delivered** event falls on a local day inside the period.
- The invoice keeps `month` (the month its week starts in) and adds `period: { from, to }`:
  - `month` matters because the live `invoices.month` column checks `^\d{4}-\d{2}$` and is indexed.
  - `period` is not a column, so `js/schema-map.js` stores it in the row's `extra` jsonb. No migration is needed.
- The number format is unchanged (`INV-2026-10-002`). The due date is the issue date plus `settings.invoiceDueDays`.
- Invoices made before this change have only `month` and still read and print as that whole month.

## Where it shows

- **Office, business account (`admin/#/business/<id>`)**:
  - The subtitle reads "invoiced weekly" and the orders section is "Delivered this week".
  - **Generate invoice** asks which week to invoice. The choices are the last 8 billing weeks with deliveries, labelled with
    their package count and total, and weeks already invoiced are marked. It preselects the newest week without an invoice.
  - The invoices table shows the period.
  - The accounts list shows "This week".
- **Printable invoice (`admin/invoice.html`)**:
  - Shows the week and "Deliveries in the week …".
  - Its cash on delivery summary covers the same week.
- **Business portal**:
  - The overview KPIs count this billing week: "Delivered this week" and "This week · Invoiced weekly".
  - The Invoices tab shows "This week so far" and lists invoices by week, newest first.
  - Billing reads "Weekly".
- **Wording**: monthly invoice wording became weekly in these places:
  - the payment status `invoiced` ("Weekly invoice");
  - the Business Delivery hint;
  - the track, checkout and order invoice pages;
  - the office order drawer;
  - bulk orders;
  - the request form's business panel.

## Demo data

- `inv_seed_01` (Kandu Books & Stationery) is last week's invoice, sent on Sunday morning.
- Business orders delivered before last week are moved into last week when the demo is seeded, so that invoice always has lines
  on any weekday. They used to be moved into the current month instead.

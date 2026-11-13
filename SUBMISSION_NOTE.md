# Submission note

**DRAFT. Unfinished:** the connector has not yet run against a real Sage business. Logging in to the trial fails on Sage's side with `error-id-provider` (web app, Postman and my own script alike). Everything below was tested with unit tests and end to end against `mock/sage`, a local stand-in that answers like Sage's API reference. It is **not Sage**, so field names are marked `UNVERIFIED` until a real response confirms them.

## What I pulled, and what I left out

- **Ledger accounts** become `LedgerAccount`. The type comes from Sage's account group (assets, liabilities, equity, income, expenditure). The code is the nominal code.
- **Contacts** become `Party`. A contact is a customer, a supplier (Sage `VENDOR`) or both. The email is the contact's own, else the main contact person's, else left out.
- **Sales and purchase invoices** become `Invoice`.
  - Each line's `net` is before VAT. The invoice's `total` and `outstanding` include VAT, as Sage reports them: what the customer owes.
  - Amounts stay in the invoice's own currency. Sage's base-currency figures are never read.
  - The status is Sage's: draft, unpaid, part paid, paid or void.
  - A purchase invoice's number is the supplier's reference.
- **Cash** becomes `BankTransaction`, from three sources:
  - Contact payments: receipts in, supplier payments out, refunds the other way.
  - Other payments: these carry their posting account when every line uses one account.
  - Bank transfers: each becomes two legs that cancel out.
  - `bankAccountId` is the bank account's ledger account. Cash is a running total of these transactions, not Sage's own balance.
- **Opening balances:** Sage's test data loads them as invoices referenced `O/BAL`, posted to account 9998. I kept them, because the money is really owed and Sage's outstanding figures include it. Since they post to 9998, they never show up as spend.
  - Limit: they count toward the invoiced total of the month they are dated in, and toward customer rankings.
- **Left out:**
  - **Credit notes:** there's no canonical type for them. Each invoice's outstanding already reflects any credit notes allocated to it, but unallocated credit is not shown.
  - **Journals:** they don't move money in or out of the bank or onto invoices.
  - **Products, tax rates, quotes and estimates:** nothing in Buki reads them.
  - **Sage's base-currency amounts:** never read, as above.
  - **Fields Sage doesn't supply:** left out of the record, never filled in. An open invoice with no due date has no `dueDate`. The brief says "no due date on file, not counted" rather than calling it overdue or current.

## How it stays in sync

- **Sign-in:** `npm run sage:auth` is a one-time sign-in that stores the tokens under `.data/`.
- **What each sync does:** it takes a full copy of the four collections, pulled in parallel. One token refresh is shared by all four pulls, and the new refresh token is saved before it's used.
- **Paging:** the client asks for every attribute and 200 records per page, and follows `$next` to the end.
- **Deletions and timing:** because every sync is a full copy, a record deleted in Sage disappears on the next sync. A change made in Sage arrives within one `SYNC_INTERVAL_SECONDS` (300 by default).
- **Tested:** against the stand-in, `cron` logged `changed 1` on the next run after an invoice was edited, and 0 on the runs either side.
- **Not used yet:** `updated_or_created_since` is supported by the client and provider, but `runSync` doesn't pass it. A full copy is simpler and can't miss a deletion. That's fine at test-data volumes.

## When Sage is slow, down, or returns something unexpected

- **When a pull fails:** the whole finance sync fails before anything is written. The store keeps the previous records and their synced-at time, the failed run is recorded with its reason, and the brief keeps answering, citing the old sync time. A partial set is never written, and nothing missing is shown as 0.
- **Each case:**
  - Each request times out after 15 seconds.
  - 429, 502, 503 and 504 are retried up to 3 times, honouring `Retry-After`. A wait over 30 seconds fails at once rather than stalling the schedule.
  - A 401 gets one token refresh and one retry; a second 401 is an `auth` error that says to run `sage:auth`.
  - A 403 says to check `SAGE_BUSINESS_ID`.
  - An HTML page, text that isn't JSON, or a list with no `$items` is a `shape` error, never an empty list.
  - A record missing a required field, or with a status or type the connector doesn't know, fails the sync and names the record and field.
- **Safety:** error messages never contain tokens or the client secret. The client won't follow a next-page link to another host.
- **Shown against the stand-in:** unreachable, 500, HTML, hang, rate limit and revoked tokens. Each failure kept the previous data and its synced-at time. Nine requests rejected with 401 at once led to exactly one token refresh.

## What I would still worry about

- **The real API:** whether Sage returns the field names and value types I assumed: amounts as numbers or strings, account group ids, `VENDOR` versus `SUPPLIER`, and whether `bank_transfers` exists in v3.1. First job once logged in: run `npm run check` on the real output.
- **Strictness:** one unexpected record stops the whole finance sync. It's safe, but in a real company's books a single odd invoice would block all updates until the code handles it.
- **Credit notes and opening balances:** these limit the "invoiced" and customer-ranking figures.
- **Volume:** a full copy every 5 minutes is fine for a trial, not for years of books. Incremental sync plus a periodic full sync to catch deletions would come next.
- **Token storage:** tokens sit in a plain file under `.data/`. Fine locally; the satellite needs proper secret storage.

## Questions I asked

TODO: add the Discussions links and answers. Asked so far: whether cash should come from payments and transfers; whether to leave credit notes out; whether net means before VAT; invoice currency versus base currency; full copy versus incremental; whether we can add October 2026 demo invoices; and access to a Buki-owned trial business because of the login error.

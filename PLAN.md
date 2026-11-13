# Sage connector: plan and tracker

The working plan for the **Bring Sage into Buki** evaluation. Update it as work happens: tick a box, add a log line, move a question to answered.

Status key: `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked

## Goal

A Sage Accounting connector for Buki: it keeps a company's Sage invoices, customers, suppliers, ledger accounts and bank transactions synced into Buki's canonical finance records on a schedule, so `npm run ask -- "who owes us money"`, `npm run ask -- "what did we spend on software last month"` and `npm run show -- finance` answer from Sage.

## What the reviewer asked for (reply to the day-3 plan)

Send **before the call**: the private repo (collaborator `vivekschandrasekar-beep`), a video of 5 minutes or less, and the note.

- [ ] Video 1: setup from a fresh clone using the README
- [ ] Video 2: "Who owes us money?" and "What did we spend on software last month?" from Sage, plus `npm run show -- finance`
- [ ] Video 3: an invoice edited in Sage, picked up by the scheduled sync (`npm run cron`)
- [ ] Video 4: a failed sync that keeps the previous records and their synced-at time
- [~] Test results: missing optional fields, VAT vs net, multiple currencies, pagination, auth and retry failures (92 tests + mock end-to-end; still to run against real Sage)
- [x] Explain the treatment of opening balances and credit notes, and the limits they put on the figures (in `SUBMISSION_NOTE.md`; recheck once real Sage data is in)
- [~] Clearly mark anything unfinished or unverified (README status, note header, `UNVERIFIED` in types; recheck before sending)
- [ ] No credentials or tokens in any shared evidence (video, screenshots, commits)
- [ ] Reply with 2 or 3 call times this week, with time zone

## Parts

| # | Part | Status | Done when |
|---|---|---|---|
| 1 | Run and understand the kit | `[x]` | Smoke test matches the README |
| 2 | Study the finance contract | `[x]` | Every finance field and rule understood |
| 3 | Sage raw types (`sage/raw/types.ts`) | `[x]` | Types for every resource we pull; typecheck passes (field names UNVERIFIED until the first real GET, Part 8) |
| 4 | Sage client (`sage/client.ts`) | `[x]` | Unit tests: pagination, 401 refresh, 429 retry, timeout, shape errors, single token refresh per sync |
| 5 | Sign-in script (`npm run sage:auth`) | `[!]` | Works end to end against `mock/sage`; real Sage login blocked (see Blockers) |
| 6 | Normalize (`sage/normalize.ts`) | `[x]` | Unit tests: absent-not-default, VAT vs net, currencies, statuses, ids; `npm run check` passes on output |
| 7 | Provider + registry, `FINANCE_SOURCE=sage` | `[~]` | `npm run health` and `npm run sync` work (done against `mock/sage`; real Sage waits on the login) |
| 8 | End to end against the Sage trial | `[!]` | The two questions and `show finance` answer from Sage |
| 9 | Scheduled sync and failure demo | `[~]` | `cron` logs `changed: 1` after an edit; failed run keeps old data (both shown against `mock/sage`; repeat on the trial for the video) |
| 10 | README, note, video, repo, send | `[~]` | Everything in "What the reviewer asked for" ticked |

Everything that needs no Sage login is done. What is left needs the login (Parts 5, 7, 8, 9 on the real trial) or only me (videos, repo, sending, call times): see "Next, once the login works" below.

## Next, once the login works

1. `npm run sage:auth -- full_access`, load the Postman test data (order below), then `npm run sage:auth` for the readonly token; set `SAGE_BUSINESS_ID` and `FINANCE_SOURCE=sage`. Remove any `mock/sage` settings from `.env` first.
2. Add the demo data (D below) and turn on VAT.
3. `npm run health`, `npm run sync`. If a `shape` error names a field, compare one raw response with `sage/raw/types.ts`, fix the types and normalize, and clear the `UNVERIFIED` marks that are now confirmed.
4. Write the finance part of `.data/store.json` to a file and `npm run check` it: 0 errors, 0 warnings.
5. Record the videos (fresh clone; the two questions and `show finance`; `cron` + an edit in Sage; a failed sync, e.g. `SAGE_API_BASE_URL=http://localhost:4999/v3.1/ npm run sync`). Check no token, secret or business id is on screen.
6. Update `SUBMISSION_NOTE.md` (remove the DRAFT header, fill in Discussions links), push to the private repo, add `vivekschandrasekar-beep`, send with 2 or 3 call times.

## Sage setup (things only I can do)

- [x] A. Trial business created (UK, Accounting Standard)
- [x] B. App Registry app created; Client ID and secret in `.env`
- [!] Log in to the trial: fails everywhere with `error-id-provider` / "Authentication Error"
- [ ] VAT turned on for the business
- [ ] C. Test data loaded with Postman (order below)
- [ ] D. Demo data added: an October 2026 software purchase invoice, and an overdue unpaid sales invoice
- [ ] `SAGE_BUSINESS_ID` set in `.env` (printed by `npm run sage:auth`)

**Postman load order** (from the collection itself). Data files are in `D:\Downloads\SBC_Accounting_Data\SBC_Accounting_Data_2026\`.

1. Initial Requests: Default ledgers, Ledger data, Financial settings (no file)
2. Bank Post Requests: `bank_accounts.json`, then Bank GET Requests
3. Contact POST Requests: `contacts.json`, then Contact GET Requests
4. Opening balances: `opening_balances.json`
5. Other payments: `other_payments.json`
6. Sales invoices: `sales_invoices.json`, then sales credits: `sales_credits.json`
7. Purchase invoices: `purchase_invoices.json`, then purchase credits: `purchase_credits.json`
8. Contact payments: `contact_payments.json` (same session as 6 and 7; do not re-run step 1 in between)
9. Journals: `journals.json`
10. Products: GET request, then `products.json`

Needs a `full_access` token (`npm run sage:auth -- full_access`), copied into the Postman environment's `accessToken` and `refreshToken`. Afterwards run `npm run sage:auth` again for the connector's own read-only token.

## Blockers

| Since | Blocker | What I did | Next |
|---|---|---|---|
| 2026-11-03 | Sage login fails (web app, Postman OAuth, own script) with `error-id-provider` | Tried Postman's embedded login, "Authorize using browser", own script with `country=gb`, incognito | Password reset or a fresh trial with an alias email on another network; posted in Discussions for a Buki-owned trial user |

## Decisions

- **Net** on an invoice line = amount before VAT. Invoice `total` and `outstanding` include VAT (what the customer owes).
- **Currency**: every amount in the invoice's own currency, never converted, never Sage's base-currency figure.
- **Cash**: BankTransaction comes from Sage bank transactions, contact payments (customer receipts, supplier payments) and other payments, as the sample README models it (`bt-5001`, `bt-5005`, `bt-5006`, `bt-5008`). Cash is a running total from the transactions on file, not a statement balance.
- **Absent, not default**: a field Sage does not supply is left out, never `0`, `null`, `""` or a guessed date.
- **Invoice lines**: `description`, `accountId`, `net` are required. A Sage line missing one fails the pull with a `shape` error, not defaulted or dropped silently.
- **Unknown invoice status**: fails the pull loudly instead of being guessed.
- **Token refresh**: once per sync, shared across the four parallel pulls (runSync uses `Promise.all`); the new refresh token is saved after every refresh.
- **Full pull every sync**: runSync passes no `since`; a deleted Sage record disappears on the next sync.
- **Retries**: 429, 502, 503 and 504 are retried up to 3 times, honouring Retry-After (seconds or HTTP date), else 1s, 2s, 4s. A Retry-After over 30s fails at once as `rate_limit` rather than stalling the sync. Other 4xx/5xx are not retried. 403 is `auth` (wrong business id or user).
- **Timeouts**: 15s per request; a stalled call is a `timeout` error.
- **Token safety**: the client refuses a `$next` link to any host but Sage API, so the bearer token is never sent elsewhere; error messages never carry tokens or the secret.
- **One client per process**: the provider builds one SageClient from `.env` and reuses it, so runSync's four parallel pulls share one token refresh, and `cron` reuses a token that is still good. Config is read at call time, so a missing setting is a `config` error in `health`/`sync`, not a crash on start.
- **Bank accounts and financial settings** are read in full on every pull, even when `since` is given, because a changed payment can point at any bank account. `since` goes to invoices, contact payments, other payments and transfers.
- **Health** lists businesses and reads financial settings; it fails if the signed-in user cannot see `SAGE_BUSINESS_ID`, and reports the base currency.
- **Scope**: the connector uses `readonly`; `full_access` only for loading test data.
- **Credit notes**: not pulled yet (no canonical type). Outstanding comes from Sage's own figure, so it already reflects allocated credit notes. Pending the founder's answer.
- **Cash sources**: contact payments, other payments and bank transfers (a transfer is two BankTransactions, out of one account and into the other). A `bank_transactions` list endpoint is not confirmed in v3.1; check on the first real call. Sage's own bank `balance` is not used.
- **List calls** send `attributes=all` (lists return only id and name otherwise) and `items_per_page=200`.
- **Opening balances**: kept as ordinary invoices. The test pack loads contact opening balances as invoices with reference `O/BAL`, dated 2025-12-31, posting to 9998. They are real money owed and Sage's outstanding includes them, so dropping them would understate "who owes us money". They post to 9998, never to a spend account, so spend-by-account is unaffected. Limit for the note: they count toward the invoiced total of December 2025 and toward customers' invoiced ranking. Opening balances loaded as credit notes are not pulled (credit notes are out). Bank opening balances are not yet confirmed.
- **Deleted records**: a record with `deleted_at` is left out.
- **Required fields fail the pull**: missing name, date, currency, total, outstanding, contact, status, or a line's description, account or net is a `shape` error naming the record and field. Unknown account group, contact type, invoice status or payment type fails the same way.
- **Purchase invoice number** is Sage's `vendor_reference` (the supplier's number); absent when Sage has none.
- **Party email**: the contact's email, else the main contact person's; absent if neither.
- **Bank transaction details**: `bankAccountId` is the bank account's ledger account. Currency is the payment's, else its bank account's, else the business base currency (a bank account with no currency is in base currency); otherwise the pull fails. A transfer between two currencies fails rather than inventing a rate. `description` is built only from Sage fields (type, contact name, reference, line details). Other payments carry `accountId` only when every line posts to one account.

## Open questions (for Discussions)

1. Cash: is mapping bank transactions, contact payments and other payments to BankTransaction what you intended?
2. Credit notes: leave them out, or apply them to outstanding and spend?
3. Net: is "before VAT" right on lines and in the spend figures?
4. Multi-currency: invoice currency, or Sage's base-currency figures?
5. Full pull each run, or `updated_or_created_since` now?
6. Test data is dated 2025. Fine to add our own October 2026 invoices for the demo?
7. Sage login fails with `error-id-provider`: can I get a user on a Buki-owned trial business?

## Test checklist

Mark on the Proof page too. Every one is run again from a fresh start before submitting.

- [x] `npm run check` on the connector's output: 0 errors, 0 warnings (unit test on a normalized fixture set; real Sage output still to check)
- [x] Invoice with no due date: no `dueDate` key at all (unit test)
- [x] Contact with no email: no `email` key (unit test)
- [x] Line net 100, VAT 20: line `net` 100, invoice `total` 120 (unit test)
- [x] Void and draft invoices: status kept, left out of every figure (unit test)
- [x] USD invoice in a GBP business: currency USD, nothing converted (unit test)
- [x] Every id is `sage:<sage id>` and every reference resolves (unit test)
- [x] Client follows `$next` across three pages: every item once (unit test, fake Sage)
- [x] 401: one refresh, retry succeeds; second 401: `auth` error (unit test, fake Sage)
- [x] 429 with Retry-After: waits and retries; still 429: typed error (unit test, fake Sage)
- [x] No answer: `timeout` error, never hangs (unit test, fake Sage)
- [x] HTML or missing `$items`: `shape` error, not an empty list (unit test, fake Sage)
- [x] Four pulls at once: exactly one token refresh (unit test, fake Sage)
- [~] Sage unreachable: run `ok: false`, old records and synced-at kept, brief still answers (mock Sage: unreachable, 500, HTML, hang; all kept old data and synced-at; repeat on the trial)
- [~] `ask "who owes us money"`: overdue invoices from Sage, citing Sage and synced-at (mock Sage only; repeat on the trial)
- [~] `ask "what did we spend on software last month"`: a figure from Sage purchase lines (mock Sage only: GBP 2,350 net; repeat on the trial)
- [~] `show finance`: Sage figures with source and synced-at (mock Sage only; repeat on the trial)
- [~] `cron` running, invoice edited in Sage: next run logs `changed: 1` (mock Sage only; repeat on the trial)

## Files

| File | Status |
|---|---|
| `src/data/canonical/sage/auth.ts` | written: authorize URL, code exchange, refresh, token file in `.data/`; `SAGE_AUTHORIZE_URL`/`SAGE_TOKEN_URL` overrides for the stand-in only |
| `src/sage-auth.ts` + `sage:auth` in `package.json` | works against `mock/sage` (`--no-browser` flag added); not yet against Sage |
| `src/data/canonical/sage/raw/types.ts` | written, typechecks; GET field names unverified (marked `UNVERIFIED` in the file) |
| `src/data/canonical/sage/client.ts` | written, 29 unit tests pass against a fake Sage; not yet run against the real API |
| `src/data/canonical/sage/normalize.ts` | written, 30 unit tests pass |
| `src/data/canonical/sage/provider.ts` | written, registered; 6 tests against a fake Sage pass; real `health`/`sync` wait on the login |
| `src/data/canonical/sage/*.test.ts` | `client.test.ts` (29), `normalize.test.ts` (30), `provider.test.ts` (6) |
| `src/data/canonical/providers/index.ts` | `sage: sageProvider` registered |
| `SUBMISSION_NOTE.md` | drafted, marked DRAFT; Discussions links still TODO |
| `mock/sage/server.mjs`, `mock/sage/data/business.json`, `mock:sage` in `package.json` | local stand-in for Sage API + OAuth, with failure switches; NOT Sage |
| `README.md` | "The Sage connector" section: real Sage steps, stand-in steps, status |

## Log

Newest last. One line per thing that happened, was decided, broke or was tested.

- 2026-11-02: Cloned the kit; `npm install`; `npm test` 27/27 pass (Node 24.15, Windows 11).
- 2026-11-02: Smoke test against the mock BambooHR: all 5 answers match the README (November run, so "last month" = October).
- 2026-11-02: `npm run sync` prints a Node/libuv assertion (`async.c` line 76) on exit on Windows + Node 24; the store is written correctly. Check whether it affects `cron`; Node 22 is the fallback.
- 2026-11-02: Read the finance contract. runSync pulls the four finance collections in parallel, so the token must be refreshed once and shared.
- 2026-11-02: Sample README models contact payments and the opening deposit as BankTransactions; plan question 1 is now a confirmation.
- 2026-11-02: Day-3 plan sent. Reviewer replied asking for a working implementation, demo video, test results and call times.
- 2026-11-03: Sage's site blocks automated reading of the test-data guide (403); read the Postman collection and environment files directly.
- 2026-11-03: Test-data pack is dated 2025 and sets accounts start to 01/01/2025, so "last month" in November 2026 is empty; adding October 2026 demo invoices.
- 2026-11-03: Pack includes sales and purchase credit notes and contact opening balances (`O/BAL`).
- 2026-11-03: Postman OAuth: embedded login fails human verification; with "Authorize using browser" it ends on `error-id-provider`.
- 2026-11-03: Wrote `sage/auth.ts` and `npm run sage:auth` (scope `readonly` by default, `full_access` as an option). Same `error-id-provider`; no callback within 5 minutes.
- 2026-11-03: A plain login to app.sageone.com fails with the same Authentication Error, so the problem is the account or Sage, not the code.
- 2026-11-03: Started Part 3. Field names from the test-data files: invoices have `contact_id`, `date`, `due_date`, `invoice_lines[]` (`description`, `ledger_account_id`, `tax_amount`, `total_amount`, `unit_price`, `quantity`); credit notes have `credit_note_lines[]`; contact payments have `transaction_type_id`, `bank_account_id`, `allocated_artefacts[]`; other payments have `payment_lines[]` with `net_amount`; journals have `journal_lines[]` with `debit`/`credit`. These are POST shapes; GET responses still to confirm.
- 2026-11-12: Part 3 done. `sage/raw/types.ts` covers businesses, financial settings, ledger accounts, contacts, sales and purchase invoices, sales and purchase credit notes (typed, not mapped), bank accounts, contact payments, other payments and bank transfers, plus the list envelope and error body. `npm run typecheck` passes. GET shapes written from the API reference and the test-data POST bodies (GET returns link objects like `contact: { id }` where POST has `contact_id`); amounts typed as number or decimal string until a real response settles it. Unverified field names are marked `UNVERIFIED` in the file.
- 2026-11-12: Part 4 done. `sage/client.ts`: token loaded from `.data/`, refreshed when under 60s left or on a 401, as one shared in-flight refresh (four parallel pulls make exactly one; a late 401 reuses a token another pull already refreshed); new tokens saved before use. Follows `$next` (relative, absolute or `/v3.1/` prefixed), sends `attributes=all` and `items_per_page=200`, guards against `$next` loops and links to other hosts. Typed errors: config, auth, http, network, timeout, rate_limit, shape. `client.test.ts` 28 tests pass; full suite 55/55; typecheck clean. Not yet run against real Sage (login blocked).
- 2026-11-12: Part 6 done. `sage/normalize.ts` maps ledger accounts, contacts, sales and purchase invoices, contact payments, other payments and bank transfers (two legs, `<id>:from` / `<id>:to`) to canonical. Absent stays absent; required fields and unknown enums fail with a `shape` error; amounts accept numbers or decimal strings. Opening balances kept as invoices (see Decisions). `normalize.test.ts` 30 tests pass, including a full normalized set through `validateFinanceSet` with 0 errors and 0 warnings. Full suite 85/85; typecheck clean. Contact type ids widened to CUSTOMER/VENDOR/SUPPLIER in `raw/types.ts`.
- 2026-11-12: Part 7 code done. `sage/provider.ts` wires client and normalize (`createSageProvider` takes the client, so tests use a fake Sage); registered as `sage` in `providers/index.ts`; `.env.example` documents `FINANCE_SOURCE=sage` and an optional `SAGE_API_BASE_URL`. `provider.test.ts` 6 tests pass (four parallel pulls: one refresh, paging, output passes `validateFinanceSet` with 0/0; `since` handling; shape failure; health). Full suite 91/91; typecheck clean. `FINANCE_SOURCE=sage npm run health` reports `config: SAGE_BUSINESS_ID must be set` cleanly. Real `health` and `sync` wait on the Sage login, so Part 7 stays in progress.
- 2026-11-12: Review fixes. The client now adds `attributes=all` and `items_per_page` to every page (a `$next` without them would have returned ids only and failed every sync); `sage:auth` asks for business attributes (it printed "(no name)"); refused connections now read `ECONNREFUSED` instead of an empty reason. 92/92 tests, typecheck clean.
- 2026-11-12: Built `mock/sage` (NOT Sage): API v3.1 and OAuth stand-in, re-reads its data file, failure switches. End to end against it from a scratch folder: `sage:auth` signs in and saves tokens; `health` ok; `sync` pulled 38; `check` on the store output 0 errors 0 warnings; who owes = 4 overdue, GBP 14,550 and $5,000, 1 with no due date; software in October = GBP 2,350 from 2 lines; `cron` logged `changed 1` after editing SI-102; unreachable, 500, HTML and hang each failed and kept the old records and synced-at, brief still answered; 429 retried and recovered; 9 parallel 401s made exactly 1 refresh. Figures checked by hand.
- 2026-11-12: README "The Sage connector" section and `SUBMISSION_NOTE.md` draft written. Node 24 `async.c` assertion still prints on exit after `health` (harmless; Node 22 is the fallback if it ever affects `cron`).
- 2026-11-13: Committed all work on branch `sage-connector` (commit 5f5a1b6), not pushed. 92/92 tests, typecheck clean at commit time.

import { describe, expect, it } from "vitest";
import { validateFinanceSet } from "../../../lib/check/validate";
import { overdueReceivables, spendOnAccountIn } from "../../../lib/finance/figures";
import { SageError } from "./client";
import {
  amount,
  bankContext,
  normalizeBankTransactions,
  normalizeBankTransfer,
  normalizeContact,
  normalizeContactPayment,
  normalizeContacts,
  normalizeInvoice,
  normalizeInvoices,
  normalizeLedgerAccount,
  normalizeLedgerAccounts,
  normalizeOtherPayment,
} from "./normalize";
import type {
  SageBankAccount,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageLedgerAccount,
  SageOtherPayment,
  SagePurchaseInvoice,
  SageSalesInvoice,
} from "./raw/types";

// ---------------------------------------------------------------------------
// Fixtures, in the GET shape (link objects, decimal strings as Sage may send)
// ---------------------------------------------------------------------------

const link = (id: string, displayed_as?: string) => (displayed_as ? { id, displayed_as } : { id });

const ledger = (id: string, name: string, group: string, code?: number): SageLedgerAccount => ({
  id,
  name,
  ledger_account_group: link(group),
  ...(code !== undefined ? { nominal_code: code } : {}),
  updated_at: "2026-01-05T09:00:00Z",
});

const ledgers: SageLedgerAccount[] = [
  ledger("la-1200", "Bank Current Account", "ASSETS", 1200),
  ledger("la-1210", "Bank Deposit Account", "ASSETS", 1210),
  ledger("la-4000", "Sales Type A", "INCOME", 4000),
  ledger("la-7500", "Software subscriptions", "EXPENDITURE", 7500),
  ledger("la-7100", "Rent and rates", "EXPENDITURE", 7100),
  ledger("la-9998", "Opening balances (suspense)", "LIABILITIES", 9998),
  ledger("la-2200", "VAT on sales", "LIABILITIES", 2200),
];

const contact = (id: string, name: string, types: string[], over: Partial<SageContact> = {}): SageContact => ({
  id,
  name,
  contact_types: types.map((t) => link(t)),
  updated_at: "2026-03-11T15:20:00Z",
  ...over,
});

const contacts: SageContact[] = [
  contact("c-ste", "Steel Fabrications", ["CUSTOMER"], { email: "accounts@steel.example" }),
  contact("c-nor", "Northgate Analytics", ["CUSTOMER"], { main_contact_person: { name: "Ana", email: "ana@northgate.example" } }),
  contact("c-tol", "Tolliver & Reed", ["CUSTOMER"]),
  contact("c-ovl", "Ovelo Cloud", ["VENDOR"], { email: "billing@ovelo.example" }),
  contact("c-usa", "Brightline Inc", ["CUSTOMER", "VENDOR"]),
];

const line = (description: string, account: string, net: string | number, tax: string | number) => ({
  description,
  ledger_account: link(account),
  net_amount: net,
  tax_amount: tax,
  total_amount: Number(net) + Number(tax),
});

const sales = (id: string, over: Partial<SageSalesInvoice> = {}): SageSalesInvoice => ({
  id,
  invoice_number: `SI-${id}`,
  contact: link("c-ste", "Steel Fabrications"),
  date: "2026-09-15",
  due_date: "2026-10-15",
  status: link("UNPAID"),
  currency: link("GBP"),
  net_amount: "100.0",
  tax_amount: "20.0",
  total_amount: "120.0",
  outstanding_amount: "120.0",
  invoice_lines: [line("Consulting", "la-4000", "100.0", "20.0")],
  updated_at: "2026-10-01T10:00:00Z",
  ...over,
});

const purchase = (id: string, over: Partial<SagePurchaseInvoice> = {}): SagePurchaseInvoice => ({
  id,
  vendor_reference: `OV-${id}`,
  contact: link("c-ovl", "Ovelo Cloud"),
  date: "2026-10-03",
  due_date: "2026-11-02",
  status: link("UNPAID"),
  currency: link("GBP"),
  total_amount: 2820,
  outstanding_amount: 2820,
  invoice_lines: [line("Hosting, October", "la-7500", 2000, 400), line("Support seats", "la-7500", 350, 70)],
  updated_at: "2026-10-03T11:00:00Z",
  ...over,
});

const banks: SageBankAccount[] = [
  { id: "ba-1", ledger_account: link("la-1200"), currency: link("GBP"), bank_account_details: { account_name: "Current" } },
  { id: "ba-2", ledger_account: link("la-1210"), bank_account_details: { account_name: "Deposit" } }, // no currency on file
];

const ctx = () => bankContext(banks, "GBP");

const receipt = (over: Partial<SageContactPayment> = {}): SageContactPayment => ({
  id: "cp-1",
  transaction_type: link("CUSTOMER_RECEIPT"),
  contact: link("c-ste", "Steel Fabrications"),
  bank_account: link("ba-1"),
  date: "2026-10-20",
  reference: "5897532",
  total_amount: "500.00",
  currency: link("GBP"),
  updated_at: "2026-10-20T09:00:00Z",
  ...over,
});

const otherPayment = (over: Partial<SageOtherPayment> = {}): SageOtherPayment => ({
  id: "op-1",
  transaction_type: link("OTHER_PAYMENT"),
  bank_account: link("ba-1"),
  date: "2026-10-09",
  reference: "CARD",
  total_amount: 60,
  payment_lines: [{ details: "Figma seat", ledger_account: link("la-7500"), net_amount: 50, tax_amount: 10, total_amount: 60 }],
  ...over,
});

const transfer = (over: Partial<SageBankTransfer> = {}): SageBankTransfer => ({
  id: "bt-1",
  from_bank_account: link("ba-1"),
  to_bank_account: link("ba-2"),
  date: "2026-10-01",
  amount: "10000.00",
  reference: "TRF",
  ...over,
});

const shapeError = (fn: () => unknown, text: RegExp) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SageError);
  expect((err as SageError).kind).toBe("shape");
  expect((err as SageError).message).toMatch(text);
};

// ---------------------------------------------------------------------------

describe("ids", () => {
  it("every id is sage:<sage id> and references point at canonical ids", () => {
    const inv = normalizeInvoice(sales("si-1"), "sales")!;
    expect(inv).toMatchObject({ id: "sage:si-1", source: "sage", sourceId: "si-1", partyId: "sage:c-ste" });
    expect(inv.lines[0].accountId).toBe("sage:la-4000");
    const t = normalizeContactPayment(receipt(), ctx())!;
    expect(t).toMatchObject({ id: "sage:cp-1", bankAccountId: "sage:la-1200", partyId: "sage:c-ste" });
  });
});

describe("absent, not default", () => {
  it("an invoice with no due date has no dueDate key at all", () => {
    for (const due of [undefined, null, ""] as const) {
      const inv = normalizeInvoice(sales("si-2", { due_date: due as string | null | undefined }), "sales")!;
      expect("dueDate" in inv).toBe(false);
    }
  });

  it("a contact with no email has no email key", () => {
    const p = normalizeContact(contact("c-tol", "Tolliver & Reed", ["CUSTOMER"], { email: "  " }));
    expect("email" in p).toBe(false);
  });

  it("falls back to the main contact person's email, which is still Sage's data", () => {
    expect(normalizeContact(contacts[1]).email).toBe("ana@northgate.example");
  });

  it("no invoice number, nominal code or updated_at: those keys are absent", () => {
    const inv = normalizeInvoice(sales("si-3", { invoice_number: undefined, updated_at: undefined }), "sales")!;
    expect("number" in inv).toBe(false);
    expect("sourceUpdatedAt" in inv).toBe(false);
    const acc = normalizeLedgerAccount({ id: "la-x", name: "X", ledger_account_group: link("ASSETS") });
    expect("code" in acc).toBe(false);
  });

  it("an other payment split across accounts has no accountId; no contact means no partyId", () => {
    const t = normalizeOtherPayment(
      otherPayment({
        payment_lines: [
          { details: "Rent", ledger_account: link("la-7100"), total_amount: 30 },
          { details: "Software", ledger_account: link("la-7500"), total_amount: 30 },
        ],
      }),
      ctx(),
    )!;
    expect("accountId" in t).toBe(false);
    expect("partyId" in t).toBe(false);
  });

  it("a required field is never filled in: missing currency, date, total or contact fails the pull", () => {
    shapeError(() => normalizeInvoice(sales("si-4", { currency: undefined }), "sales"), /si-4: currency is missing/);
    shapeError(() => normalizeInvoice(sales("si-4", { date: undefined }), "sales"), /date is missing/);
    shapeError(() => normalizeInvoice(sales("si-4", { total_amount: undefined }), "sales"), /total_amount is missing/);
    shapeError(() => normalizeInvoice(sales("si-4", { outstanding_amount: null as unknown as string }), "sales"), /outstanding_amount is missing/);
    shapeError(() => normalizeInvoice(sales("si-4", { contact: undefined }), "sales"), /contact is missing/);
    shapeError(() => normalizeContact(contact("c-x", "", ["CUSTOMER"])), /name is missing/);
  });

  it("an invoice line missing description, account or net fails the pull, not dropped", () => {
    const bad = (l: object) => sales("si-5", { invoice_lines: [line("ok", "la-4000", 1, 0), l as never] });
    shapeError(() => normalizeInvoice(bad({ ledger_account: link("la-4000"), net_amount: 5 }), "sales"), /invoice_lines\[1\]\.description is missing/);
    shapeError(() => normalizeInvoice(bad({ description: "x", net_amount: 5 }), "sales"), /invoice_lines\[1\]\.ledger_account is missing/);
    shapeError(() => normalizeInvoice(bad({ description: "x", ledger_account: link("la-4000") }), "sales"), /invoice_lines\[1\]\.net_amount is missing/);
    shapeError(() => normalizeInvoice(sales("si-5", { invoice_lines: undefined }), "sales"), /invoice_lines is missing/);
  });
});

describe("VAT vs net", () => {
  it("line net 100, VAT 20: line net is 100, invoice total and outstanding are 120", () => {
    const inv = normalizeInvoice(sales("si-6"), "sales")!;
    expect(inv.lines).toEqual([{ description: "Consulting", accountId: "sage:la-4000", net: 100 }]);
    expect(inv.total).toBe(120);
    expect(inv.outstanding).toBe(120);
  });

  it("spend on software reads the net of purchase lines, not the VAT-inclusive total", () => {
    const invoices = normalizeInvoices([], [purchase("pi-1")]);
    const rows = spendOnAccountIn(invoices, normalizeLedgerAccounts(ledgers), "2026-10", "software");
    expect(rows).toHaveLength(1);
    expect(rows[0].total.get("GBP")).toBe(2350);
    expect(invoices[0].total).toBe(2820);
  });
});

describe("currencies", () => {
  it("a USD invoice in a GBP business stays USD, using the invoice amounts, never the base figures", () => {
    const inv = normalizeInvoice(
      sales("si-7", {
        currency: link("USD"),
        exchange_rate: "0.79",
        total_amount: "1200.00",
        outstanding_amount: "1200.00",
        base_currency_total_amount: "948.00",
        base_currency_outstanding_amount: "948.00",
        invoice_lines: [line("Licence", "la-4000", "1000.00", "200.00")],
      }),
      "sales",
    )!;
    expect(inv).toMatchObject({ currency: "USD", total: 1200, outstanding: 1200 });
    expect(inv.lines[0].net).toBe(1000);
  });

  it("a lower-case currency id is upper-cased; a non-code is a shape error", () => {
    expect(normalizeInvoice(sales("si-8", { currency: link("eur") }), "sales")!.currency).toBe("EUR");
    shapeError(() => normalizeInvoice(sales("si-8", { currency: link("Pounds") }), "sales"), /not a currency code/);
  });

  it("a payment with no currency takes its bank account's; a bank account with none takes the base currency", () => {
    expect(normalizeContactPayment(receipt({ currency: undefined }), ctx())!.currency).toBe("GBP");
    const usdBank = bankContext([{ id: "ba-1", ledger_account: link("la-1200"), currency: link("USD") }], "GBP");
    expect(normalizeContactPayment(receipt({ currency: undefined }), usdBank)!.currency).toBe("USD");
    expect(normalizeOtherPayment(otherPayment({ bank_account: link("ba-2") }), ctx())!.currency).toBe("GBP");
    shapeError(() => normalizeOtherPayment(otherPayment({ bank_account: link("ba-2") }), bankContext(banks)), /currency is missing/);
  });
});

describe("statuses", () => {
  it("maps Sage's five statuses", () => {
    const map = { DRAFT: "draft", UNPAID: "unpaid", PART_PAID: "part_paid", PAID: "paid", VOID: "void" } as const;
    for (const [sage, canonical] of Object.entries(map)) {
      expect(normalizeInvoice(sales("si-9", { status: link(sage) }), "sales")!.status).toBe(canonical);
    }
  });

  it("an unknown status fails the pull loudly", () => {
    shapeError(() => normalizeInvoice(sales("si-9", { status: link("DISPUTED") }), "sales"), /status "DISPUTED" is not one this connector knows/);
    shapeError(() => normalizeInvoice(sales("si-9", { status: undefined }), "sales"), /status is missing/);
  });

  it("void and draft keep their status and are left out of the overdue figure", () => {
    const invoices = normalizeInvoices(
      [
        sales("si-a", { status: link("VOID"), outstanding_amount: 0 }),
        sales("si-b", { status: link("DRAFT") }),
        sales("si-c", { status: link("UNPAID") }),
      ],
      [],
    );
    expect(invoices.map((i) => i.status)).toEqual(["void", "draft", "unpaid"]);
    const overdue = overdueReceivables(invoices, "2026-11-12");
    expect(overdue.invoices.map((i) => i.id)).toEqual(["sage:si-c"]);
  });

  it("a deleted invoice is left out", () => {
    expect(normalizeInvoices([sales("si-d", { deleted_at: "2026-10-30T10:00:00Z" })], [])).toEqual([]);
  });
});

describe("amounts", () => {
  it("parses numbers and decimal strings, rejects anything else", () => {
    expect(amount("120.0", "x", "f")).toBe(120);
    expect(amount(-4.5, "x", "f")).toBe(-4.5);
    expect(() => amount("12,000.00", "x", "f")).toThrow(/not a number/);
    expect(() => amount("abc", "x", "f")).toThrow(/not a number/);
    expect(() => amount(Number.NaN, "x", "f")).toThrow(/not a number/);
  });

  it("a malformed date is a shape error; an ISO timestamp is cut to its date", () => {
    shapeError(() => normalizeInvoice(sales("si-e", { date: "31/12/2025" }), "sales"), /date is not a date/);
    shapeError(() => normalizeInvoice(sales("si-e", { date: "2026-02-30" }), "sales"), /not a real date/);
    expect(normalizeInvoice(sales("si-e", { date: "2026-09-15T00:00:00Z" }), "sales")!.date).toBe("2026-09-15");
  });
});

describe("accounts and contacts", () => {
  it("maps account groups, and fails on an unknown one", () => {
    expect(normalizeLedgerAccounts(ledgers).map((a) => a.type)).toEqual(["asset", "asset", "income", "expense", "expense", "liability", "liability"]);
    expect(normalizeLedgerAccount(ledgers[0]).code).toBe("1200");
    shapeError(() => normalizeLedgerAccount(ledger("la-z", "Z", "MYSTERY")), /ledger_account_group "MYSTERY"/);
  });

  it("maps contact kinds: customer, VENDOR or SUPPLIER as supplier, both; neither fails", () => {
    expect(normalizeContacts(contacts).map((p) => p.kind)).toEqual(["customer", "customer", "customer", "supplier", "both"]);
    expect(normalizeContact(contact("c-s", "S", ["SUPPLIER"])).kind).toBe("supplier");
    shapeError(() => normalizeContact(contact("c-n", "N", [])), /neither CUSTOMER nor VENDOR/);
  });
});

describe("bank transactions", () => {
  it("signs contact payments by type: receipts in, payments out", () => {
    const sign = (type: string) => normalizeContactPayment(receipt({ transaction_type: link(type), total_amount: "75.5" }), ctx())!.amount;
    expect(sign("CUSTOMER_RECEIPT")).toBe(75.5);
    expect(sign("VENDOR_REFUND")).toBe(75.5);
    expect(sign("VENDOR_PAYMENT")).toBe(-75.5);
    expect(sign("CUSTOMER_REFUND")).toBe(-75.5);
    shapeError(() => sign("MYSTERY"), /transaction_type "MYSTERY"/);
  });

  it("a description is built only from what Sage sent", () => {
    expect(normalizeContactPayment(receipt(), ctx())!.description).toBe("Customer receipt, Steel Fabrications, ref 5897532");
    expect(normalizeContactPayment(receipt({ contact: link("c-ste"), reference: undefined }), ctx())!.description).toBe("Customer receipt");
  });

  it("an other payment posted to one account carries that account, signed out", () => {
    const t = normalizeOtherPayment(otherPayment(), ctx())!;
    expect(t).toMatchObject({ amount: -60, accountId: "sage:la-7500", description: "Figma seat, ref CARD" });
    expect(normalizeOtherPayment(otherPayment({ transaction_type: link("OTHER_RECEIPT") }), ctx())!.amount).toBe(60);
  });

  it("a transfer is two legs that cancel out", () => {
    const legs = normalizeBankTransfer(transfer(), ctx());
    expect(legs.map((l) => [l.id, l.bankAccountId, l.amount])).toEqual([
      ["sage:bt-1:from", "sage:la-1200", -10000],
      ["sage:bt-1:to", "sage:la-1210", 10000],
    ]);
    expect(legs[0].description).toBe("Transfer to Deposit, ref TRF");
  });

  it("a transfer between two currencies fails rather than inventing a rate", () => {
    const mixed = bankContext([...banks.slice(0, 1), { id: "ba-2", ledger_account: link("la-1210"), currency: link("USD") }], "GBP");
    shapeError(() => normalizeBankTransfer(transfer(), mixed), /between a GBP and a USD account/);
  });

  it("a payment against a bank account Sage did not list fails", () => {
    shapeError(() => normalizeContactPayment(receipt({ bank_account: link("ba-9") }), ctx()), /bank_account ba-9 is not in bank_accounts/);
  });

  it("deleted payments and transfers are left out", () => {
    const out = normalizeBankTransactions(
      {
        contactPayments: [receipt({ deleted_at: "2026-10-30T00:00:00Z" })],
        otherPayments: [otherPayment({ deleted_at: "2026-10-30T00:00:00Z" })],
        bankTransfers: [transfer({ deleted_at: "2026-10-30T00:00:00Z" })],
      },
      ctx(),
    );
    expect(out).toEqual([]);
  });

  it("two Sage records with the same id fail instead of merging", () => {
    shapeError(
      () => normalizeBankTransactions({ contactPayments: [receipt({ id: "dup" })], otherPayments: [otherPayment({ id: "dup" })], bankTransfers: [] }, ctx()),
      /same id came from two Sage records/,
    );
  });
});

describe("npm run check on the connector's output", () => {
  it("a full normalized set: 0 errors, 0 warnings", () => {
    const set = {
      accounts: normalizeLedgerAccounts(ledgers),
      parties: normalizeContacts(contacts),
      invoices: normalizeInvoices(
        [
          sales("si-1"),
          sales("si-2", { due_date: null, contact: link("c-nor") }),
          sales("si-3", { status: link("PART_PAID"), outstanding_amount: "50.0" }),
          sales("si-4", { status: link("PAID"), outstanding_amount: "0.0" }),
          sales("si-5", { status: link("VOID"), outstanding_amount: 0 }),
          sales("si-6", { status: link("DRAFT"), contact: link("c-tol") }),
          sales("si-7", { currency: link("USD"), contact: link("c-usa") }),
          // An opening balance as the test pack loads it.
          sales("si-ob", {
            reference: "O/BAL",
            date: "2025-12-31",
            due_date: "2026-02-14",
            total_amount: 150,
            outstanding_amount: 150,
            invoice_lines: [line("Opening Balance", "la-9998", 150, 0)],
          }),
        ],
        [purchase("pi-1"), purchase("pi-2", { contact: link("c-usa"), vendor_reference: undefined, status: link("PAID"), outstanding_amount: 0 })],
      ),
      bankTransactions: normalizeBankTransactions(
        {
          contactPayments: [receipt(), receipt({ id: "cp-2", transaction_type: link("VENDOR_PAYMENT"), contact: link("c-ovl") })],
          otherPayments: [otherPayment()],
          bankTransfers: [transfer()],
        },
        ctx(),
      ),
    };
    const result = validateFinanceSet(JSON.parse(JSON.stringify(set)));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

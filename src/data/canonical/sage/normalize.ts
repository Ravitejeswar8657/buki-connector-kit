/**
 * Sage to canonical. The only file that knows both shapes.
 *
 * The rules (PLAN.md Decisions), each enforced here and tested in
 * normalize.test.ts:
 *
 * - Absent, not default. A field Sage does not supply is left OUT of the
 *   canonical record: no 0, null, "" or guessed date. An open invoice with no
 *   due date has no `dueDate` key, and the brief says so.
 * - Required means required. A record missing something Buki cannot do
 *   without (a name, a date, a currency, a line's account) fails the whole pull
 *   with a `shape` error naming the record and field. It is never filled in,
 *   and never silently dropped, because a missing invoice is a wrong figure.
 * - Unknown enums fail loudly: an invoice status, account group, contact type or
 *   payment type this file does not know is an error, not a guess.
 * - Net is before VAT. Invoice `total` and `outstanding` include VAT, as Sage
 *   reports them (what the customer owes).
 * - Every amount stays in the record's own currency. Sage's base_currency_*
 *   figures are never read.
 * - Every id is `sage:<sage id>`. A bank transfer is the one Sage record that
 *   becomes two canonical records, so its legs are `<id>:from` and `<id>:to`.
 * - A record Sage marks deleted (`deleted_at`) is left out: it no longer exists.
 *
 * Opening balances: the test pack loads contact opening balances as ordinary
 * invoices with reference "O/BAL", dated the day before the accounts start,
 * posting to the opening-balance ledger account (9998). They are kept as
 * invoices, because they are real money owed and Sage's outstanding figures
 * include them; dropping them would understate "who owes us money". Their
 * lines post to 9998, never to a spend account like Software, so they do not
 * distort "what did we spend on X". They do count toward the invoiced total of
 * the month they are dated in, which the note states as a limit.
 *
 * Credit notes are not mapped (no canonical type). Invoice `outstanding` is
 * Sage's own figure, so it already reflects credit notes allocated to it.
 */

import type { BankTransaction, Invoice, InvoiceLine, LedgerAccount, Party } from "../types";
import { SageError } from "./client";
import type {
  SageBankAccount,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageDecimal,
  SageInvoiceLine,
  SageLedgerAccount,
  SageLink,
  SageOtherPayment,
  SagePurchaseInvoice,
  SageSalesInvoice,
} from "./raw/types";

const SOURCE = "sage" as const;
const cid = (sageId: string) => `${SOURCE}:${sageId}`;

// ---------------------------------------------------------------------------
// Field readers: each returns a clean value or throws a shape error naming
// where it was. "opt" readers return undefined for anything that is not a real
// value, so the caller can leave the field out.
// ---------------------------------------------------------------------------

function fail(where: string, problem: string): never {
  throw new SageError("shape", `Sage ${where}: ${problem}`);
}

/** A string with something in it, or undefined. */
function optText(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t && t !== "null" && t !== "undefined" ? t : undefined;
}

function text(v: unknown, where: string, field: string): string {
  return optText(v) ?? fail(where, `${field} is missing`);
}

function linkId(v: SageLink | null | undefined, where: string, field: string): string {
  return optText(v?.id) ?? fail(where, `${field} is missing`);
}

function optLinkId(v: SageLink | null | undefined): string | undefined {
  return optText(v?.id);
}

/** Sage amounts arrive as numbers or decimal strings ("120.0"). Anything else is a shape error. */
export function amount(v: SageDecimal | null | undefined, where: string, field: string): number {
  if (v === undefined || v === null || v === "") fail(where, `${field} is missing`);
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) fail(where, `${field} is not a number (${JSON.stringify(v)})`);
  return n;
}

/** YYYY-MM-DD, or an ISO timestamp cut to its date. Must be a real calendar date. */
function optDate(v: unknown, where: string, field: string): string | undefined {
  const s = optText(v);
  if (s === undefined) return undefined;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!m) fail(where, `${field} is not a date (${JSON.stringify(v)})`);
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const check = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (check.toISOString().slice(0, 10) !== d) fail(where, `${field} is not a real date (${JSON.stringify(v)})`);
  return d;
}

function date(v: unknown, where: string, field: string): string {
  return optDate(v, where, field) ?? fail(where, `${field} is missing`);
}

/** ISO 4217, upper case. Sage's currency ids are the codes ("GBP"). */
function optCurrency(v: SageLink | null | undefined, where: string, field: string): string | undefined {
  const id = optLinkId(v);
  if (id === undefined) return undefined;
  const code = id.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail(where, `${field} is not a currency code (${JSON.stringify(id)})`);
  return code;
}

const isDeleted = (r: { deleted_at?: string | null }) => optText(r.deleted_at) !== undefined;

function setIf<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

// ---------------------------------------------------------------------------
// Ledger accounts
// ---------------------------------------------------------------------------

const ACCOUNT_TYPE: Record<string, LedgerAccount["type"]> = {
  ASSETS: "asset",
  ASSET: "asset",
  LIABILITIES: "liability",
  LIABILITY: "liability",
  EQUITY: "equity",
  INCOME: "income",
  EXPENDITURE: "expense",
  EXPENSE: "expense",
  EXPENSES: "expense",
};

export function normalizeLedgerAccount(raw: SageLedgerAccount): LedgerAccount {
  const sourceId = text(raw.id, "ledger account", "id");
  const where = `ledger account ${sourceId}`;
  const group = linkId(raw.ledger_account_group, where, "ledger_account_group");
  const type = ACCOUNT_TYPE[group.toUpperCase()] ?? fail(where, `ledger_account_group "${group}" is not one this connector knows`);
  const account: LedgerAccount = {
    id: cid(sourceId),
    source: SOURCE,
    sourceId,
    name: optText(raw.name) ?? optText(raw.display_name) ?? fail(where, "name is missing"),
    type,
  };
  setIf(account, "code", optText(raw.nominal_code));
  setIf(account, "sourceUpdatedAt", optText(raw.updated_at));
  return account;
}

export function normalizeLedgerAccounts(raw: SageLedgerAccount[]): LedgerAccount[] {
  return raw.map(normalizeLedgerAccount);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function normalizeContact(raw: SageContact): Party {
  const sourceId = text(raw.id, "contact", "id");
  const where = `contact ${sourceId}`;
  const types = (raw.contact_types ?? []).map((t) => optText(t?.id)?.toUpperCase());
  const customer = types.includes("CUSTOMER");
  const supplier = types.includes("VENDOR") || types.includes("SUPPLIER");
  if (!customer && !supplier) {
    fail(where, `contact_types ${JSON.stringify(types)} has neither CUSTOMER nor VENDOR`);
  }
  const party: Party = {
    id: cid(sourceId),
    source: SOURCE,
    sourceId,
    name: text(raw.name, where, "name"),
    kind: customer && supplier ? "both" : customer ? "customer" : "supplier",
  };
  setIf(party, "email", optText(raw.email) ?? optText(raw.main_contact_person?.email));
  setIf(party, "sourceUpdatedAt", optText(raw.updated_at));
  return party;
}

export function normalizeContacts(raw: SageContact[]): Party[] {
  return raw.map(normalizeContact);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const INVOICE_STATUS: Record<string, Invoice["status"]> = {
  DRAFT: "draft",
  UNPAID: "unpaid",
  PART_PAID: "part_paid",
  PAID: "paid",
  VOID: "void",
};

function normalizeLine(raw: SageInvoiceLine, where: string, i: number): InvoiceLine {
  const at = `invoice_lines[${i}]`;
  return {
    description: text(raw?.description, where, `${at}.description`),
    accountId: cid(linkId(raw?.ledger_account, where, `${at}.ledger_account`)),
    net: amount(raw?.net_amount, where, `${at}.net_amount`),
  };
}

/** One invoice, or null when Sage marks it deleted. */
export function normalizeInvoice(raw: SageSalesInvoice | SagePurchaseInvoice, kind: Invoice["kind"]): Invoice | null {
  if (isDeleted(raw)) return null;
  const sourceId = text(raw.id, `${kind} invoice`, "id");
  const where = `${kind} invoice ${sourceId}`;
  const statusId = linkId(raw.status, where, "status").toUpperCase();
  const status = INVOICE_STATUS[statusId] ?? fail(where, `status "${statusId}" is not one this connector knows`);
  if (!Array.isArray(raw.invoice_lines)) fail(where, "invoice_lines is missing");

  const invoice: Invoice = {
    id: cid(sourceId),
    source: SOURCE,
    sourceId,
    kind,
    partyId: cid(linkId(raw.contact, where, "contact")),
    date: date(raw.date, where, "date"),
    status,
    currency: optCurrency(raw.currency, where, "currency") ?? fail(where, "currency is missing"),
    total: amount(raw.total_amount, where, "total_amount"),
    outstanding: amount(raw.outstanding_amount, where, "outstanding_amount"),
    lines: raw.invoice_lines.map((line, i) => normalizeLine(line, where, i)),
  };
  // Sales invoices carry our number; purchase invoices the supplier's.
  const number = kind === "sales" ? optText((raw as SageSalesInvoice).invoice_number) : optText((raw as SagePurchaseInvoice).vendor_reference);
  setIf(invoice, "number", number);
  setIf(invoice, "dueDate", optDate(raw.due_date, where, "due_date"));
  setIf(invoice, "sourceUpdatedAt", optText(raw.updated_at));
  return invoice;
}

export function normalizeInvoices(sales: SageSalesInvoice[], purchase: SagePurchaseInvoice[]): Invoice[] {
  const out: Invoice[] = [];
  for (const raw of sales) {
    const inv = normalizeInvoice(raw, "sales");
    if (inv) out.push(inv);
  }
  for (const raw of purchase) {
    const inv = normalizeInvoice(raw, "purchase");
    if (inv) out.push(inv);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bank transactions
// ---------------------------------------------------------------------------

/** What payments need to know about bank accounts: which ledger account and currency each one is. */
export interface BankContext {
  /** Sage bank account id to its canonical ledger account id and currency. */
  accounts: Map<string, { ledgerAccountId: string; currency?: string; name?: string }>;
  /** The business's base currency, used only for a bank account that names none. */
  baseCurrency?: string;
}

export function bankContext(bankAccounts: SageBankAccount[], baseCurrency?: string): BankContext {
  const accounts: BankContext["accounts"] = new Map();
  for (const raw of bankAccounts) {
    const sourceId = text(raw.id, "bank account", "id");
    const where = `bank account ${sourceId}`;
    const entry: { ledgerAccountId: string; currency?: string; name?: string } = {
      ledgerAccountId: cid(linkId(raw.ledger_account, where, "ledger_account")),
    };
    setIf(entry, "currency", optCurrency(raw.currency, where, "currency"));
    setIf(entry, "name", optText(raw.bank_account_details?.account_name) ?? optText(raw.displayed_as));
    accounts.set(sourceId, entry);
  }
  return { accounts, baseCurrency: baseCurrency?.toUpperCase() };
}

function bankAccount(link: SageLink | null | undefined, ctx: BankContext, where: string, field = "bank_account") {
  const id = linkId(link, where, field);
  const account = ctx.accounts.get(id) ?? fail(where, `${field} ${id} is not in bank_accounts`);
  return { id, ...account };
}

/**
 * The payment's own currency; else its bank account's; else, for a bank account
 * that names none, the business base currency (a Sage bank account with no
 * currency is in base currency). Never a hard-coded default.
 */
function paymentCurrency(own: SageLink | null | undefined, bank: { currency?: string }, ctx: BankContext, where: string): string {
  return optCurrency(own, where, "currency") ?? bank.currency ?? ctx.baseCurrency ?? fail(where, "currency is missing, and neither the bank account nor the business names one");
}

const CONTACT_PAYMENT_SIGN: Record<string, 1 | -1> = {
  CUSTOMER_RECEIPT: 1,
  VENDOR_REFUND: 1,
  VENDOR_PAYMENT: -1,
  CUSTOMER_REFUND: -1,
};

const CONTACT_PAYMENT_LABEL: Record<string, string> = {
  CUSTOMER_RECEIPT: "Customer receipt",
  VENDOR_REFUND: "Supplier refund",
  VENDOR_PAYMENT: "Supplier payment",
  CUSTOMER_REFUND: "Customer refund",
};

/** "Label, Contact name, ref 123": a description built only from what Sage sent. */
function describeTxn(label: string, ...parts: (string | undefined)[]): string {
  return [label, ...parts.filter((p): p is string => p !== undefined)].join(", ");
}

export function normalizeContactPayment(raw: SageContactPayment, ctx: BankContext): BankTransaction | null {
  if (isDeleted(raw)) return null;
  const sourceId = text(raw.id, "contact payment", "id");
  const where = `contact payment ${sourceId}`;
  const typeId = linkId(raw.transaction_type, where, "transaction_type").toUpperCase();
  const sign = CONTACT_PAYMENT_SIGN[typeId] ?? fail(where, `transaction_type "${typeId}" is not one this connector knows`);
  const bank = bankAccount(raw.bank_account, ctx, where);
  const reference = optText(raw.reference);

  const txn: BankTransaction = {
    id: cid(sourceId),
    source: SOURCE,
    sourceId,
    bankAccountId: bank.ledgerAccountId,
    date: date(raw.date, where, "date"),
    amount: sign * Math.abs(amount(raw.total_amount, where, "total_amount")),
    currency: paymentCurrency(raw.currency, bank, ctx, where),
    description: describeTxn(CONTACT_PAYMENT_LABEL[typeId], optText(raw.contact?.displayed_as), reference && `ref ${reference}`),
    partyId: cid(linkId(raw.contact, where, "contact")),
  };
  setIf(txn, "sourceUpdatedAt", optText(raw.updated_at));
  return txn;
}

const OTHER_PAYMENT_SIGN: Record<string, 1 | -1> = { OTHER_RECEIPT: 1, OTHER_PAYMENT: -1 };

export function normalizeOtherPayment(raw: SageOtherPayment, ctx: BankContext): BankTransaction | null {
  if (isDeleted(raw)) return null;
  const sourceId = text(raw.id, "other payment", "id");
  const where = `other payment ${sourceId}`;
  const typeId = linkId(raw.transaction_type, where, "transaction_type").toUpperCase();
  const sign = OTHER_PAYMENT_SIGN[typeId] ?? fail(where, `transaction_type "${typeId}" is not one this connector knows`);
  const bank = bankAccount(raw.bank_account, ctx, where);
  const lines = Array.isArray(raw.payment_lines) ? raw.payment_lines : [];
  const details = [...new Set(lines.map((l) => optText(l?.details)).filter((d): d is string => d !== undefined))];
  const reference = optText(raw.reference);

  const txn: BankTransaction = {
    id: cid(sourceId),
    source: SOURCE,
    sourceId,
    bankAccountId: bank.ledgerAccountId,
    date: date(raw.date, where, "date"),
    amount: sign * Math.abs(amount(raw.total_amount, where, "total_amount")),
    currency: paymentCurrency(raw.currency, bank, ctx, where),
    description: describeTxn(
      details.length ? details.join("; ") : typeId === "OTHER_RECEIPT" ? "Other receipt" : "Other payment",
      optText(raw.contact?.displayed_as),
      reference && `ref ${reference}`,
    ),
  };
  // The posting account only when every line agrees; a split payment has no single account.
  const lineAccounts = new Set(lines.map((l) => optLinkId(l?.ledger_account)));
  const [onlyAccount] = lineAccounts;
  if (lineAccounts.size === 1 && onlyAccount) txn.accountId = cid(onlyAccount);
  const party = optLinkId(raw.contact);
  setIf(txn, "partyId", party && cid(party));
  setIf(txn, "sourceUpdatedAt", optText(raw.updated_at));
  return txn;
}

/** A transfer between two of the company's bank accounts: one leg out, one leg in. */
export function normalizeBankTransfer(raw: SageBankTransfer, ctx: BankContext): BankTransaction[] {
  if (isDeleted(raw)) return [];
  const sourceId = text(raw.id, "bank transfer", "id");
  const where = `bank transfer ${sourceId}`;
  const from = bankAccount(raw.from_bank_account, ctx, where, "from_bank_account");
  const to = bankAccount(raw.to_bank_account, ctx, where, "to_bank_account");
  const fromCurrency = from.currency ?? ctx.baseCurrency ?? fail(where, "from_bank_account has no currency, and the business names none");
  const toCurrency = to.currency ?? ctx.baseCurrency ?? fail(where, "to_bank_account has no currency, and the business names none");
  if (fromCurrency !== toCurrency) {
    fail(where, `moves money between a ${fromCurrency} and a ${toCurrency} account; one amount cannot be both`);
  }
  const value = Math.abs(amount(raw.amount, where, "amount"));
  const day = date(raw.date, where, "date");
  const reference = optText(raw.reference);
  const note = optText(raw.description);

  const leg = (suffix: "from" | "to", bank: typeof from, signed: number, label: string): BankTransaction => {
    const legId = `${sourceId}:${suffix}`;
    const txn: BankTransaction = {
      id: cid(legId),
      source: SOURCE,
      sourceId: legId,
      bankAccountId: bank.ledgerAccountId,
      date: day,
      amount: signed,
      currency: fromCurrency,
      description: describeTxn(label, note, reference && `ref ${reference}`),
    };
    setIf(txn, "sourceUpdatedAt", optText(raw.updated_at));
    return txn;
  };
  return [
    leg("from", from, -value, `Transfer to ${to.name ?? "another bank account"}`),
    leg("to", to, value, `Transfer from ${from.name ?? "another bank account"}`),
  ];
}

export interface SageCashRecords {
  contactPayments: SageContactPayment[];
  otherPayments: SageOtherPayment[];
  bankTransfers: SageBankTransfer[];
}

export function normalizeBankTransactions(raw: SageCashRecords, ctx: BankContext): BankTransaction[] {
  const out: BankTransaction[] = [];
  for (const p of raw.contactPayments) {
    const t = normalizeContactPayment(p, ctx);
    if (t) out.push(t);
  }
  for (const p of raw.otherPayments) {
    const t = normalizeOtherPayment(p, ctx);
    if (t) out.push(t);
  }
  for (const t of raw.bankTransfers) out.push(...normalizeBankTransfer(t, ctx));

  // Sage ids are unique across resources; if two ever collide, two records would merge in the store.
  const seen = new Set<string>();
  for (const t of out) {
    if (seen.has(t.id)) fail(`bank transaction ${t.sourceId}`, "the same id came from two Sage records");
    seen.add(t.id);
  }
  return out;
}

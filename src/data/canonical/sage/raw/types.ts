/**
 * Sage Accounting API v3.1 shapes, the subset the connector reads. They mirror
 * the GET responses so the client can pass them through untouched and the
 * normalizer is the only place that knows both Sage's shape and Buki's.
 *
 * Two rules, stated once here and enforced by the types:
 *
 * 1. A field Sage may not send is OPTIONAL here, and normalize() leaves the
 *    canonical field absent when it is missing. Nothing is defaulted.
 * 2. Nothing here is trusted. These types say what we expect; the client checks
 *    the envelope and normalize() checks the fields it needs, and a record that
 *    does not match fails the pull with a `shape` error.
 *
 * UNVERIFIED: written from Sage's API reference and the POST shapes in Sage's
 * test-data pack, before a single real GET (the trial login is blocked, see
 * PLAN.md). Field names to confirm on the first real response are marked
 * `UNVERIFIED`. The test-data files are POST bodies: there a reference is a bare
 * `contact_id` / `ledger_account_id`; a GET returns a link object instead
 * (`contact: { id, displayed_as, $path }`), which is what is typed below.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A decimal amount. Sage's reference documents amounts as numbers, but some
 * responses carry them as decimal strings ("120.0"). UNVERIFIED which one the
 * trial sends, so both are allowed and normalize() parses either, failing on
 * anything that is not a finite number.
 */
export type SageDecimal = number | string;

/** YYYY-MM-DD. */
export type SageDate = string;

/** ISO 8601 timestamp, e.g. "2026-10-14T09:12:44Z". */
export type SageTimestamp = string;

/**
 * Sage's reference to another record: what a GET returns where the POST body
 * had a bare `*_id`. `id` is the only part the connector relies on.
 */
export interface SageLink<Id extends string = string> {
  id: Id;
  displayed_as?: string;
  $path?: string;
}

/** Fields every top-level Sage record carries. */
export interface SageRecord {
  id: string;
  displayed_as?: string;
  $path?: string;
  created_at?: SageTimestamp;
  updated_at?: SageTimestamp;
}

/**
 * Every list endpoint returns this envelope. Follow `$next` (a path relative to
 * the API root, or null) until it is null. `$items` missing, or a body that is
 * not this envelope at all (an HTML error page), is a `shape` error in the
 * client, never an empty list.
 */
export interface SageList<T> {
  $total: number;
  $page: number;
  $next: string | null;
  $back: string | null;
  $itemsPerPage: number;
  $items: T[];
}

/**
 * Sage's error body: an array of these, on 4xx and 5xx. The client reads
 * `$message` for the error text and never logs the request headers.
 */
export interface SageApiErrorItem {
  $severity?: string;
  $dataCode?: string;
  $message?: string;
  $source?: string;
}

/**
 * List endpoints return only `id`, `displayed_as` and `$path` per item unless
 * asked for more, so every list call the connector makes sends this. One call
 * per page instead of one per record.
 */
export const SAGE_LIST_ATTRIBUTES = "all";

/** The page size the client asks for. 200 is Sage's maximum. */
export const SAGE_ITEMS_PER_PAGE = 200;

/** Endpoint paths under https://api.accounting.sage.com/v3.1/, one per resource pulled. */
export const SAGE_PATHS = {
  businesses: "businesses",
  financialSettings: "financial_settings",
  ledgerAccounts: "ledger_accounts",
  contacts: "contacts",
  salesInvoices: "sales_invoices",
  purchaseInvoices: "purchase_invoices",
  salesCreditNotes: "sales_credit_notes",
  purchaseCreditNotes: "purchase_credit_notes",
  bankAccounts: "bank_accounts",
  contactPayments: "contact_payments",
  otherPayments: "other_payments",
  bankTransfers: "bank_transfers",
} as const;

export type SagePath = (typeof SAGE_PATHS)[keyof typeof SAGE_PATHS];

// ---------------------------------------------------------------------------
// Business and settings (health, base currency)
// ---------------------------------------------------------------------------

/** GET /businesses. No X-Business header on this call. */
export interface SageBusiness extends SageRecord {
  name: string;
}

/**
 * GET /financial_settings (a single object, not a list). Health reads it as a
 * cheap call that needs the business header; the base currency is recorded so
 * the note can say which currency Sage's own base figures are in. Buki never
 * uses those base figures (see PLAN.md Decisions: Currency).
 */
export interface SageFinancialSettings {
  $path?: string;
  base_currency?: SageLink;
  multi_currency_enabled?: boolean;
  accounts_start_date?: SageDate;
  year_end_date?: SageDate;
  tax_number?: string;
}

// ---------------------------------------------------------------------------
// Ledger accounts
// ---------------------------------------------------------------------------

/**
 * Sage's top-level grouping. Normalize maps it to the canonical `type`. An id
 * not listed here fails the pull rather than being guessed. UNVERIFIED ids.
 */
export type SageLedgerAccountGroupId = "ASSETS" | "LIABILITIES" | "EQUITY" | "INCOME" | "EXPENDITURE";

/** GET /ledger_accounts?attributes=all */
export interface SageLedgerAccount extends SageRecord {
  name?: string;
  display_name?: string;
  /** The account code. An integer in the reference; "7500" style in the test data. */
  nominal_code?: number | string;
  ledger_account_group?: SageLink<string>;
  /** Finer type: SALES, OVERHEADS, BANK, CURRENT_ASSETS, ... Kept for the note, not mapped. */
  ledger_account_type?: SageLink<string>;
  included_in_chart?: boolean;
  visible_in_banking?: boolean;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** Sage's reference names suppliers VENDOR; SUPPLIER is accepted too. UNVERIFIED which the trial sends. */
export type SageContactTypeId = "CUSTOMER" | "VENDOR" | "SUPPLIER";

export interface SageContactPerson {
  name?: string;
  email?: string;
  is_main_contact?: boolean;
}

/** GET /contacts?attributes=all */
export interface SageContact extends SageRecord {
  name?: string;
  /** Sage's short code, e.g. "STE001". The test data's contact ids are these. */
  reference?: string;
  /** A contact can be both. An empty list fails the pull: kind is required. */
  contact_types?: SageLink<string>[];
  /** UNVERIFIED whether the top-level `email` is on the GET; the main person's is the fallback. */
  email?: string;
  main_contact_person?: SageContactPerson;
  currency?: SageLink;
}

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------

/**
 * An invoice's status id. Normalize maps the five canonical ones; anything else
 * (Sage adds statuses by region and plan) fails the pull loudly. UNVERIFIED
 * whether DISPUTED or PRO_FORMA appear on the trial.
 */
export type SageArtefactStatusId = "DRAFT" | "UNPAID" | "PART_PAID" | "PAID" | "VOID";

export interface SageInvoiceLine {
  id?: string;
  displayed_as?: string;
  /** Required by Buki. Missing fails the pull with a `shape` error. */
  description?: string;
  /** Required by Buki: the canonical line's accountId. */
  ledger_account?: SageLink;
  quantity?: SageDecimal;
  unit_price?: SageDecimal;
  /** Before VAT. This is the canonical line `net` (PLAN.md Decisions: Net). */
  net_amount?: SageDecimal;
  tax_amount?: SageDecimal;
  /** Net plus VAT. */
  total_amount?: SageDecimal;
  discount_amount?: SageDecimal;
  tax_rate?: SageLink;
}

/** Fields sales and purchase invoices share. */
interface SageArtefact extends SageRecord {
  contact?: SageLink;
  contact_name?: string;
  contact_reference?: string;
  date?: SageDate;
  /** Absent or null when Sage holds no due date: the canonical `dueDate` is then absent. */
  due_date?: SageDate | null;
  reference?: string;
  notes?: string;
  status?: SageLink<string>;
  /** In the invoice's own currency, which is what Buki uses. */
  currency?: SageLink;
  exchange_rate?: SageDecimal;
  net_amount?: SageDecimal;
  tax_amount?: SageDecimal;
  /** Including VAT: the canonical `total`. */
  total_amount?: SageDecimal;
  /** Including VAT, after payments and allocated credit notes: the canonical `outstanding`. */
  outstanding_amount?: SageDecimal;
  total_paid?: SageDecimal;
  /** Base-currency figures. Typed so normalize can be seen NOT to use them. */
  base_currency_total_amount?: SageDecimal;
  base_currency_outstanding_amount?: SageDecimal;
  /** Set when the record was deleted, on endpoints that return deleted records. */
  deleted_at?: SageTimestamp | null;
  void_reason?: string | null;
}

/** GET /sales_invoices?attributes=all */
export interface SageSalesInvoice extends SageArtefact {
  invoice_number?: string;
  invoice_lines?: SageInvoiceLine[];
}

/** GET /purchase_invoices?attributes=all. Purchase invoices carry the supplier's number, not one of ours. */
export interface SagePurchaseInvoice extends SageArtefact {
  vendor_reference?: string;
  invoice_lines?: SageInvoiceLine[];
}

/**
 * GET /sales_credit_notes and /purchase_credit_notes. Not mapped to a canonical
 * record yet (there is no canonical credit note; PLAN.md open question 2).
 * Typed now because the opening-balance decision in Part 6 reads them: the test
 * pack loads some contact opening balances as credit notes with reference
 * "O/BAL".
 */
export interface SageCreditNote extends SageArtefact {
  credit_note_number?: string;
  vendor_reference?: string;
  credit_note_lines?: SageInvoiceLine[];
}

// ---------------------------------------------------------------------------
// Bank and cash
// ---------------------------------------------------------------------------

/** GET /bank_accounts?attributes=all. The bank account is also a ledger account. */
export interface SageBankAccount extends SageRecord {
  bank_account_details?: {
    account_name?: string;
    account_number?: string;
    sort_code?: string;
  };
  /** The ledger account behind it: the canonical bankAccountId points there. */
  ledger_account?: SageLink;
  bank_account_type?: SageLink<string>;
  nominal_code?: number | string;
  currency?: SageLink;
  /** Sage's own balance. Not used: cash is the running total of transactions on file. */
  balance?: SageDecimal;
}

/** Customer receipts and supplier payments, and their refunds. */
export type SageContactPaymentTypeId = "CUSTOMER_RECEIPT" | "VENDOR_PAYMENT" | "CUSTOMER_REFUND" | "VENDOR_REFUND";

export interface SageAllocatedArtefact {
  id?: string;
  artefact?: SageLink;
  amount?: SageDecimal;
  discount?: SageDecimal;
}

/**
 * GET /contact_payments?attributes=all. Money in or out of a bank account
 * against a customer or supplier: one canonical BankTransaction each, signed by
 * `transaction_type` (receipts in, payments out).
 */
export interface SageContactPayment extends SageRecord {
  transaction_type?: SageLink<string>;
  contact?: SageLink;
  bank_account?: SageLink;
  date?: SageDate;
  reference?: string;
  /** Always positive in Sage; the sign comes from transaction_type. UNVERIFIED for refunds. */
  total_amount?: SageDecimal;
  net_amount?: SageDecimal;
  tax_amount?: SageDecimal;
  currency?: SageLink;
  payment_method?: SageLink;
  allocated_artefacts?: SageAllocatedArtefact[];
  payment_on_account?: unknown;
  deleted_at?: SageTimestamp | null;
}

export type SageOtherPaymentTypeId = "OTHER_PAYMENT" | "OTHER_RECEIPT";

export interface SagePaymentLine {
  id?: string;
  details?: string;
  ledger_account?: SageLink;
  net_amount?: SageDecimal;
  tax_amount?: SageDecimal;
  total_amount?: SageDecimal;
  tax_rate?: SageLink;
}

/**
 * GET /other_payments?attributes=all. Bank money in or out not against an
 * invoice (fees, the opening deposit, a card payment for software). One
 * canonical BankTransaction each; `accountId` is set only when every line posts
 * to the same ledger account, otherwise left absent.
 */
export interface SageOtherPayment extends SageRecord {
  transaction_type?: SageLink<string>;
  contact?: SageLink | null;
  bank_account?: SageLink;
  date?: SageDate;
  reference?: string;
  total_amount?: SageDecimal;
  net_amount?: SageDecimal;
  tax_amount?: SageDecimal;
  currency?: SageLink;
  payment_method?: SageLink;
  payment_lines?: SagePaymentLine[];
  deleted_at?: SageTimestamp | null;
}

/**
 * GET /bank_transfers?attributes=all. Money moved between two of the company's
 * own bank accounts: total cash is unchanged, but cash per account is not, so it
 * becomes two canonical BankTransactions (out of one, into the other).
 */
export interface SageBankTransfer extends SageRecord {
  from_bank_account?: SageLink;
  to_bank_account?: SageLink;
  date?: SageDate;
  reference?: string;
  description?: string;
  amount?: SageDecimal;
  deleted_at?: SageTimestamp | null;
}

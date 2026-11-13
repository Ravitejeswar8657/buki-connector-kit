import { describe, expect, it } from "vitest";
import { validateFinanceSet } from "../../../lib/check/validate";
import type { SageTokens } from "./auth";
import { SageClient, type SageClientConfig } from "./client";
import { createSageProvider } from "./provider";

const NOW = new Date("2026-11-12T10:00:00Z");
const BASE = "https://api.accounting.sage.com/v3.1/";

const config: SageClientConfig = {
  oauth: { clientId: "cid", clientSecret: "secret", callbackUrl: "http://localhost:3000/api/sage/callback" },
  businessId: "biz-1",
  baseUrl: BASE,
};

const link = (id: string, displayed_as?: string) => (displayed_as ? { id, displayed_as } : { id });

/** A tiny Sage: each list endpoint serves its items two per page. */
const DATA: Record<string, unknown[]> = {
  businesses: [{ id: "biz-1", name: "Halden Trial Ltd" }],
  ledger_accounts: [
    { id: "la-1200", name: "Bank Current Account", nominal_code: 1200, ledger_account_group: link("ASSETS") },
    { id: "la-4000", name: "Sales", nominal_code: 4000, ledger_account_group: link("INCOME") },
    { id: "la-7500", name: "Software subscriptions", nominal_code: 7500, ledger_account_group: link("EXPENDITURE") },
  ],
  contacts: [
    { id: "c-1", name: "Steel Fabrications", contact_types: [link("CUSTOMER")], email: "accounts@steel.example" },
    { id: "c-2", name: "Ovelo Cloud", contact_types: [link("VENDOR")] },
  ],
  sales_invoices: [
    {
      id: "si-1",
      invoice_number: "SI-1",
      contact: link("c-1"),
      date: "2026-09-15",
      due_date: "2026-10-15",
      status: link("UNPAID"),
      currency: link("GBP"),
      total_amount: "120.0",
      outstanding_amount: "120.0",
      invoice_lines: [{ description: "Consulting", ledger_account: link("la-4000"), net_amount: "100.0", tax_amount: "20.0" }],
    },
  ],
  purchase_invoices: [
    {
      id: "pi-1",
      contact: link("c-2"),
      date: "2026-10-03",
      status: link("UNPAID"),
      currency: link("GBP"),
      total_amount: 2820,
      outstanding_amount: 2820,
      invoice_lines: [
        { description: "Hosting", ledger_account: link("la-7500"), net_amount: 2000 },
        { description: "Seats", ledger_account: link("la-7500"), net_amount: 350 },
      ],
    },
  ],
  bank_accounts: [{ id: "ba-1", ledger_account: link("la-1200"), currency: link("GBP") }],
  contact_payments: [
    { id: "cp-1", transaction_type: link("CUSTOMER_RECEIPT"), contact: link("c-1"), bank_account: link("ba-1"), date: "2026-10-20", total_amount: 500 },
    { id: "cp-2", transaction_type: link("VENDOR_PAYMENT"), contact: link("c-2"), bank_account: link("ba-1"), date: "2026-10-21", total_amount: 100 },
    { id: "cp-3", transaction_type: link("VENDOR_PAYMENT"), contact: link("c-2"), bank_account: link("ba-1"), date: "2026-10-22", total_amount: 50 },
  ],
  other_payments: [
    { id: "op-1", transaction_type: link("OTHER_PAYMENT"), bank_account: link("ba-1"), date: "2026-10-09", total_amount: 60, payment_lines: [{ details: "Figma", ledger_account: link("la-7500") }] },
  ],
  bank_transfers: [],
};

function fakeSage(opts: { tokenExpiresInMs?: number; broken?: string; businessId?: string } = {}) {
  const paths: string[] = [];
  let refreshes = 0;
  let stored: SageTokens = {
    accessToken: "old",
    accessTokenExpiresAt: new Date(NOW.getTime() + (opts.tokenExpiresInMs ?? 0)).toISOString(),
    refreshToken: "rt-old",
    obtainedAt: NOW.toISOString(),
  };
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const resource = url.pathname.replace("/v3.1/", "");
    paths.push(`${resource}${url.searchParams.get("updated_or_created_since") ? "?since" : ""}`);
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== `Bearer ${stored.accessToken}`) return new Response("[]", { status: 401 });
    if (resource === opts.broken) return new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (resource === "financial_settings") return Response.json({ base_currency: link("GBP") });
    const all = DATA[resource];
    if (!all) return Response.json([{ $message: "not found" }], { status: 404 });
    const pageNo = Number(url.searchParams.get("page") ?? "1");
    const items = all.slice((pageNo - 1) * 2, pageNo * 2);
    const next = pageNo * 2 < all.length ? `/${resource}?page=${pageNo + 1}` : null;
    return Response.json({ $total: all.length, $page: pageNo, $next: next, $back: null, $itemsPerPage: 2, $items: items });
  }) as typeof fetch;

  const client = new SageClient(config, {
    fetch: fetchFn,
    now: () => NOW,
    tokens: {
      read: async () => stored,
      write: async (t) => {
        stored = t;
      },
    },
    refresh: async () => {
      refreshes++;
      return { accessToken: `fresh${refreshes}`, accessTokenExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(), refreshToken: `rt-${refreshes}`, obtainedAt: NOW.toISOString() };
    },
  });
  const provider = createSageProvider(() => ({ client, config: { ...config, businessId: opts.businessId ?? config.businessId } }));
  return { provider, paths, refreshes: () => refreshes };
}

const pullAll = (p: ReturnType<typeof createSageProvider>, since?: string) =>
  Promise.all([p.accounts(), p.parties(), p.invoices(since), p.bankTransactions(since)]);

describe("sageProvider", () => {
  it("a sync's four parallel pulls: one token refresh, every record, and a set that passes npm run check", async () => {
    const { provider, refreshes } = fakeSage();
    const [accounts, parties, invoices, bankTransactions] = await pullAll(provider);
    expect(refreshes()).toBe(1);
    expect(accounts).toHaveLength(3);
    expect(parties).toHaveLength(2);
    expect(invoices.map((i) => i.id)).toEqual(["sage:si-1", "sage:pi-1"]);
    expect(bankTransactions.map((t) => [t.id, t.amount, t.bankAccountId])).toEqual([
      ["sage:cp-1", 500, "sage:la-1200"],
      ["sage:cp-2", -100, "sage:la-1200"],
      ["sage:cp-3", -50, "sage:la-1200"],
      ["sage:op-1", -60, "sage:la-1200"],
    ]);
    const result = validateFinanceSet(JSON.parse(JSON.stringify({ accounts, parties, invoices, bankTransactions })));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("passes since to invoices and payments, but always reads bank accounts in full", async () => {
    const { provider, paths } = fakeSage({ tokenExpiresInMs: 240_000 });
    await provider.invoices("2026-11-01T00:00:00Z");
    await provider.bankTransactions("2026-11-01T00:00:00Z");
    expect(paths).toContain("sales_invoices?since");
    expect(paths).toContain("contact_payments?since");
    expect(paths).toContain("bank_accounts");
    expect(paths).not.toContain("bank_accounts?since");
  });

  it("one malformed endpoint fails the pull that reads it with a shape error", async () => {
    const { provider } = fakeSage({ broken: "contact_payments" });
    await expect(pullAll(provider)).rejects.toMatchObject({ kind: "shape" });
  });

  it("health names the business and its base currency", async () => {
    const { provider } = fakeSage();
    expect(await provider.health()).toEqual({ ok: true, detail: 'Sage business "Halden Trial Ltd", base currency GBP' });
  });

  it("health says so when the user cannot see SAGE_BUSINESS_ID", async () => {
    const { provider } = fakeSage({ businessId: "biz-9" });
    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/cannot see business biz-9.*SAGE_BUSINESS_ID/);
  });

  it("health reports a failure as its kind, never throwing", async () => {
    const { provider } = fakeSage({ broken: "financial_settings" });
    expect(await provider.health()).toMatchObject({ ok: false, detail: expect.stringMatching(/^shape: /) });
  });
});

/**
 * The Sage provider: the one object the registry hands to the rest of the app.
 * It wires client + normalize and nothing more.
 *
 * runSync calls accounts(), parties(), invoices() and bankTransactions() in
 * parallel. They share ONE client, so the token is refreshed once for all four
 * (PLAN.md Decisions: Token refresh). The client lives for the process, which
 * also lets `npm run cron` reuse a token that is still good between runs.
 */

import type { FinanceProvider } from "../providers/types";
import { configFromEnv, describe, SageClient, SageError, type SageClientConfig } from "./client";
import {
  bankContext,
  normalizeBankTransactions,
  normalizeContacts,
  normalizeInvoices,
  normalizeLedgerAccounts,
} from "./normalize";
import {
  SAGE_PATHS,
  type SageBankAccount,
  type SageBankTransfer,
  type SageBusiness,
  type SageContact,
  type SageContactPayment,
  type SageFinancialSettings,
  type SageLedgerAccount,
  type SageOtherPayment,
  type SagePurchaseInvoice,
  type SageSalesInvoice,
} from "./raw/types";

/** The provider, built on whatever hands it a client. Tests pass one backed by a fake Sage. */
export function createSageProvider(getClient: () => { client: SageClient; config: SageClientConfig }): FinanceProvider {
  const settings = async (client: SageClient): Promise<SageFinancialSettings> => {
    const body = await client.get<SageFinancialSettings>(SAGE_PATHS.financialSettings);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SageError("shape", "Sage's financial_settings did not answer with an object");
    }
    return body;
  };

  return {
    source: "sage",

    async health() {
      try {
        const { client, config } = getClient();
        const [businesses, fin] = await Promise.all([client.businesses<SageBusiness>(), settings(client)]);
        const business = businesses.find((b) => b.id === config.businessId);
        if (!business) {
          return {
            ok: false,
            detail: `auth: the signed-in Sage user cannot see business ${config.businessId}; it can see ${businesses.length}. Check SAGE_BUSINESS_ID.`,
          };
        }
        const base = fin.base_currency?.id ? `, base currency ${fin.base_currency.id}` : "";
        return { ok: true, detail: `Sage business "${business.name ?? business.displayed_as ?? business.id}"${base}` };
      } catch (err) {
        const kind = err instanceof SageError ? err.kind : "unknown";
        return { ok: false, detail: `${kind}: ${describe(err)}` };
      }
    },

    async accounts() {
      const { client } = getClient();
      return normalizeLedgerAccounts(await client.list<SageLedgerAccount>(SAGE_PATHS.ledgerAccounts));
    },

    async parties() {
      const { client } = getClient();
      return normalizeContacts(await client.list<SageContact>(SAGE_PATHS.contacts));
    },

    async invoices(since?: string) {
      const { client } = getClient();
      const [sales, purchase] = await Promise.all([
        client.list<SageSalesInvoice>(SAGE_PATHS.salesInvoices, { since }),
        client.list<SagePurchaseInvoice>(SAGE_PATHS.purchaseInvoices, { since }),
      ]);
      return normalizeInvoices(sales, purchase);
    },

    async bankTransactions(since?: string) {
      const { client } = getClient();
      // Bank accounts are always read in full: a payment changed since `since` can point at any of them.
      const [banks, fin, contactPayments, otherPayments, bankTransfers] = await Promise.all([
        client.list<SageBankAccount>(SAGE_PATHS.bankAccounts),
        settings(client),
        client.list<SageContactPayment>(SAGE_PATHS.contactPayments, { since }),
        client.list<SageOtherPayment>(SAGE_PATHS.otherPayments, { since }),
        client.list<SageBankTransfer>(SAGE_PATHS.bankTransfers, { since }),
      ]);
      return normalizeBankTransactions({ contactPayments, otherPayments, bankTransfers }, bankContext(banks, fin.base_currency?.id));
    },
  };
}

/**
 * One client per process, rebuilt only if the configuration changes. configFromEnv
 * runs on every call, so a missing setting is a `config` error at sync time, not
 * an import-time crash for people who never set FINANCE_SOURCE.
 */
let shared: { key: string; client: SageClient; config: SageClientConfig } | null = null;

function processClient(): { client: SageClient; config: SageClientConfig } {
  const config = configFromEnv();
  const key = JSON.stringify([config.baseUrl, config.businessId, config.oauth.clientId]);
  if (!shared || shared.key !== key) shared = { key, client: new SageClient(config), config };
  return shared;
}

export const sageProvider: FinanceProvider = createSageProvider(processClient);

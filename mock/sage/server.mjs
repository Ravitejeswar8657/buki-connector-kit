// A local stand-in for the Sage Accounting API v3.1 and its OAuth endpoints, so
// the connector can run end to end (sign-in, sync, ask, show, cron, failures)
// while the real trial login is blocked.
//
// It is NOT Sage. Its shapes follow Sage's API reference and are as unverified
// as src/data/canonical/sage/raw/types.ts; passing against it proves the
// connector's plumbing, not that Sage answers this way. Evidence made with it
// must say "mock Sage".
//
// The data file is re-read on every request, so editing
// mock/sage/data/business.json is "a change made in Sage".
//
// It reads only MOCK_SAGE_* settings and never the real SAGE_CLIENT_SECRET.
//
//   MOCK_SAGE_PORT           default 4020
//   MOCK_SAGE_CLIENT_ID      default mock-client-id
//   MOCK_SAGE_CLIENT_SECRET  default mock-client-secret
//   MOCK_SAGE_PAGE_SIZE      the largest page it serves, default 200 (set 2 to see paging)
//   MOCK_SAGE_TOKEN_TTL      access token lifetime in seconds, default 300 like Sage
//
// Failure switches, for the demo and the note (curl -X POST):
//   /__mock/mode?set=ok         normal
//   /__mock/mode?set=error500   every API call answers 500 with a Sage error body
//   /__mock/mode?set=html       every API call answers 200 with an HTML page
//   /__mock/mode?set=slow       every API call hangs (the client times out)
//   /__mock/mode?set=ratelimit  each resource answers 429 Retry-After: 1 once, then normally
//   /__mock/expire              every access token is rejected once (forces a refresh)

import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.MOCK_SAGE_PORT) || 4020;
const CLIENT_ID = process.env.MOCK_SAGE_CLIENT_ID ?? "mock-client-id";
const CLIENT_SECRET = process.env.MOCK_SAGE_CLIENT_SECRET ?? "mock-client-secret";
const PAGE_SIZE = Math.max(1, Math.min(200, Number(process.env.MOCK_SAGE_PAGE_SIZE) || 200));
const TOKEN_TTL = Number(process.env.MOCK_SAGE_TOKEN_TTL) || 300;
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "business.json");

const LISTS = new Set([
  "businesses",
  "ledger_accounts",
  "contacts",
  "sales_invoices",
  "purchase_invoices",
  "sales_credit_notes",
  "purchase_credit_notes",
  "bank_accounts",
  "contact_payments",
  "other_payments",
  "bank_transfers",
]);

let mode = "ok";
const rateLimited = new Set(); // resources that have had their one 429
const codes = new Map(); // auth code -> expiry ms
const accessTokens = new Map(); // token -> expiry ms
const liveRefreshTokens = new Set();
const revokedRefreshTokens = new Set();

const readData = () => JSON.parse(readFileSync(DATA_FILE, "utf8"));
const token = (prefix) => `${prefix}-${randomBytes(12).toString("hex")}`;
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const sageError = (res, status, message, dataCode = "Error") => send(res, status, [{ $severity: "error", $dataCode: dataCode, $message: message, $source: "" }]);

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function issueTokens() {
  const access = token("mock-at");
  const refresh = token("mock-rt");
  accessTokens.set(access, Date.now() + TOKEN_TTL * 1000);
  liveRefreshTokens.add(refresh);
  return { access_token: access, expires_in: TOKEN_TTL, refresh_token: refresh, refresh_token_expires_in: 2678400, scope: "readonly", token_type: "bearer" };
}

/** Sage's $items carry id, displayed_as and $path only, unless attributes=all is asked for. */
function shape(resource, item, all) {
  const displayed_as = item.displayed_as ?? item.name ?? item.invoice_number ?? item.reference ?? item.id;
  const base = { id: item.id, displayed_as, $path: `/${resource}/${item.id}` };
  return all ? { ...base, ...item } : base;
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // --- switches -----------------------------------------------------------
  if (url.pathname === "/__mock/mode" && req.method === "POST") {
    mode = url.searchParams.get("set") ?? "ok";
    rateLimited.clear();
    log(`mode: ${mode}`);
    return send(res, 200, { mode });
  }
  if (url.pathname === "/__mock/expire" && req.method === "POST") {
    accessTokens.clear();
    log("every access token expired");
    return send(res, 200, { expired: true });
  }

  // --- OAuth ---------------------------------------------------------------
  if (url.pathname === "/oauth2/auth" && req.method === "GET") {
    // Sage would show its sign-in here. The mock signs the "user" in at once.
    const redirect = url.searchParams.get("redirect_uri");
    if (url.searchParams.get("client_id") !== CLIENT_ID || !redirect) return send(res, 400, { error: "invalid_client" });
    const code = token("mock-code");
    codes.set(code, Date.now() + 60_000);
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    log("authorize: signed in, redirecting with a code");
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
      return send(res, 401, { error: "invalid_client", error_description: "client_id or client_secret is wrong" });
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const expires = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!expires || expires < Date.now()) return send(res, 400, { error: "invalid_grant", error_description: "code is invalid or expired" });
      log("token: code exchanged");
      return send(res, 200, issueTokens());
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      // A refresh token from before a mock restart is accepted once, so a restart does not force a new sign-in.
      if (!rt.startsWith("mock-rt-") || revokedRefreshTokens.has(rt)) {
        return send(res, 400, { error: "invalid_grant", error_description: "refresh token is invalid or already used" });
      }
      liveRefreshTokens.delete(rt);
      revokedRefreshTokens.add(rt); // rotated, like Sage
      log("token: refreshed (refresh token rotated)");
      return send(res, 200, issueTokens());
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  // --- API -----------------------------------------------------------------
  const m = url.pathname.match(/^\/v3\.1\/([a-z_]+)$/);
  if (!m || req.method !== "GET") return sageError(res, 404, `No route for ${req.method} ${url.pathname}`, "RecordNotFound");
  const resource = m[1];

  const auth = req.headers.authorization ?? "";
  const expires = accessTokens.get(auth.replace(/^Bearer /, ""));
  if (!expires || expires < Date.now()) {
    log(`${resource}: 401`);
    return sageError(res, 401, "Your access token is invalid or has expired", "AuthenticationError");
  }
  if (resource !== "businesses") {
    const business = readData().businesses?.[0]?.id;
    if (req.headers["x-business"] !== business) return sageError(res, 403, "You do not have access to this business", "AccessDenied");
  }

  if (mode === "error500") {
    log(`${resource}: 500 (mode)`);
    return sageError(res, 500, "An unexpected error occurred", "InternalServerError");
  }
  if (mode === "html") {
    log(`${resource}: HTML (mode)`);
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<html><body><h1>Down for maintenance</h1></body></html>");
  }
  if (mode === "slow") {
    log(`${resource}: hanging (mode)`);
    return; // never answers; the client's timeout ends it
  }
  if (mode === "ratelimit" && !rateLimited.has(resource)) {
    rateLimited.add(resource);
    log(`${resource}: 429 (mode)`);
    res.setHeader("Retry-After", "1");
    return sageError(res, 429, "Rate limit exceeded", "TooManyRequests");
  }

  const data = readData();
  if (resource === "financial_settings") return send(res, 200, { $path: "/financial_settings", ...data.financial_settings });
  if (!LISTS.has(resource)) return sageError(res, 404, `Unknown resource ${resource}`, "RecordNotFound");

  let items = data[resource] ?? [];
  const since = url.searchParams.get("updated_or_created_since");
  if (since) items = items.filter((i) => !i.updated_at || i.updated_at >= since);
  const size = Math.min(PAGE_SIZE, Number(url.searchParams.get("items_per_page")) || 20);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const slice = items.slice((page - 1) * size, page * size);
  const all = url.searchParams.get("attributes") === "all";
  const more = page * size < items.length;
  log(`${resource}: page ${page}, ${slice.length} of ${items.length}${all ? "" : " (ids only: no attributes=all)"}`);
  // The next link deliberately leaves out attributes=all, to prove the client adds it back on every page.
  return send(res, 200, {
    $total: items.length,
    $page: page,
    $next: more ? `/${resource}?page=${page + 1}&items_per_page=${size}` : null,
    $back: page > 1 ? `/${resource}?page=${page - 1}&items_per_page=${size}` : null,
    $itemsPerPage: size,
    $items: slice.map((i) => shape(resource, i, all)),
  });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error: ${err.message}`);
      if (!res.headersSent) sageError(res, 500, "Mock error");
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    log(`Mock Sage (NOT Sage) on http://localhost:${PORT}, page size ${PAGE_SIZE}, token life ${TOKEN_TTL}s`);
    log(`Data: ${DATA_FILE}`);
  });

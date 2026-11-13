import { describe, expect, it } from "vitest";
import type { SageTokens } from "./auth";
import { retryWaitMs, SageClient, SageError, type SageClientConfig, type TokenStore } from "./client";

const NOW = new Date("2026-11-12T10:00:00Z");
const BASE = "https://api.accounting.sage.com/v3.1/";

const config: SageClientConfig = {
  oauth: { clientId: "cid", clientSecret: "secret", callbackUrl: "http://localhost:3000/api/sage/callback" },
  businessId: "biz-1",
  baseUrl: BASE,
};

const tokens = (access: string, expiresInMs: number, refresh = `rt-${access}`): SageTokens => ({
  accessToken: access,
  accessTokenExpiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
  refreshToken: refresh,
  obtainedAt: NOW.toISOString(),
});

function memoryStore(initial: SageTokens | null) {
  const writes: SageTokens[] = [];
  let current = initial;
  const store: TokenStore = {
    read: async () => current,
    write: async (t) => {
      writes.push(t);
      current = t;
    },
  };
  return { store, writes };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init.headers as Record<string, string> });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const page = (items: unknown[], next: string | null, n = 1) => ({
  $total: 6,
  $page: n,
  $next: next,
  $back: null,
  $itemsPerPage: 2,
  $items: items,
});

function client(handler: Handler, opts: { stored?: SageTokens | null; refresh?: (rt: string) => Promise<SageTokens>; timeoutMs?: number } = {}) {
  const f = fakeFetch(handler);
  const { store, writes } = memoryStore(opts.stored === undefined ? tokens("good", 240_000) : opts.stored);
  const refreshed: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const c = new SageClient(config, {
    fetch: f.fn,
    tokens: store,
    refresh: async (_cfg, rt) => {
      refreshed.push(rt);
      return opts.refresh ? opts.refresh(rt) : tokens(`fresh${++n}`, 300_000);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    requestTimeoutMs: opts.timeoutMs ?? 1000,
  });
  return { c, calls: f.calls, writes, refreshed, sleeps };
}

describe("SageClient.list", () => {
  it("follows $next across three pages and returns every item once, in order", async () => {
    const { c, calls } = client((url) => {
      const p = url.searchParams.get("page");
      if (!p) return json(page([{ id: "1" }, { id: "2" }], "/contacts?page=2"));
      if (p === "2") return json(page([{ id: "3" }, { id: "4" }], "contacts?page=3", 2));
      return json(page([{ id: "5" }, { id: "6" }], null, 3));
    });
    const items = await c.list<{ id: string }>("contacts");
    expect(items.map((i) => i.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url.searchParams.get("attributes")).toBe("all");
    expect(calls[0].url.searchParams.get("items_per_page")).toBe("200");
    expect(calls.every((call) => call.url.pathname === "/v3.1/contacts")).toBe(true);
    // A $next that drops our parameters still gets every attribute on later pages.
    expect(calls.map((call) => call.url.searchParams.get("attributes"))).toEqual(["all", "all", "all"]);
    expect(calls[2].url.searchParams.get("page")).toBe("3");
  });

  it("a $next that sets its own items_per_page keeps it", async () => {
    const { c, calls } = client((url) =>
      url.searchParams.get("page") ? json(page([{ id: "2" }], null, 2)) : json(page([{ id: "1" }], "/contacts?page=2&items_per_page=50")),
    );
    await c.list("contacts");
    expect(calls[1].url.searchParams.get("items_per_page")).toBe("50");
  });

  it("accepts an absolute $next on Sage's host and one that repeats the /v3.1 prefix", async () => {
    const { c, calls } = client((url) => {
      const p = url.searchParams.get("page");
      if (!p) return json(page([{ id: "1" }], `${BASE}contacts?page=2`));
      if (p === "2") return json(page([{ id: "2" }], "/v3.1/contacts?page=3", 2));
      return json(page([{ id: "3" }], null, 3));
    });
    expect((await c.list<{ id: string }>("contacts")).map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(calls.map((call) => call.url.pathname)).toEqual(["/v3.1/contacts", "/v3.1/contacts", "/v3.1/contacts"]);
  });

  it("refuses a $next that points at another host, so the token never leaves Sage", async () => {
    const { c, calls } = client(() => json(page([{ id: "1" }], "https://evil.example/steal")));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "shape" });
    expect(calls).toHaveLength(1);
  });

  it("fails on a $next loop instead of spinning", async () => {
    const { c } = client(() => json(page([{ id: "1" }], "/contacts?page=2")));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "shape" });
  });

  it("passes since as updated_or_created_since", async () => {
    const { c, calls } = client(() => json(page([], null)));
    await c.list("sales_invoices", { since: "2026-11-01T00:00:00Z" });
    expect(calls[0].url.searchParams.get("updated_or_created_since")).toBe("2026-11-01T00:00:00Z");
  });

  it("sends the bearer token and X-Business, but no X-Business on /businesses", async () => {
    const { c, calls } = client(() => json(page([], null)));
    await c.list("contacts");
    await c.businesses();
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer good", "X-Business": "biz-1" });
    expect(calls[1].headers["X-Business"]).toBeUndefined();
  });
});

describe("shape errors", () => {
  it("an HTML page is a shape error, not an empty list", async () => {
    const { c } = client(() => new Response("<html><body>Maintenance</body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "shape" });
  });

  it("a body without $items is a shape error, not an empty list", async () => {
    const { c } = client(() => json({ $total: 0, $next: null }));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "shape" });
  });

  it("a later page without $items fails the whole list", async () => {
    const { c } = client((url) => (url.searchParams.get("page") ? json({ oops: true }) : json(page([{ id: "1" }], "/contacts?page=2"))));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "shape" });
  });

  it("text that is not JSON is a shape error", async () => {
    const { c } = client(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(c.get("financial_settings")).rejects.toMatchObject({ kind: "shape" });
  });
});

describe("auth", () => {
  it("401 once: refreshes, saves the new tokens, retries and succeeds", async () => {
    const { c, refreshed, writes, calls } = client((_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer good" ? json([{ $message: "expired" }], 401) : json(page([{ id: "1" }], null));
    });
    expect(await c.list("contacts")).toHaveLength(1);
    expect(refreshed).toEqual(["rt-good"]);
    expect(writes.map((w) => w.accessToken)).toEqual(["fresh1"]);
    expect(calls.map((call) => call.headers.Authorization)).toEqual(["Bearer good", "Bearer fresh1"]);
  });

  it("401 again after the refresh is an auth error, with no second refresh", async () => {
    const { c, refreshed } = client(() => json([{ $message: "nope" }], 401));
    const err = await c.list("contacts").catch((e) => e);
    expect(err).toBeInstanceOf(SageError);
    expect(err.kind).toBe("auth");
    expect(refreshed).toHaveLength(1);
  });

  it("refreshes before the call when the token has under a minute left", async () => {
    const { c, refreshed, calls } = client(() => json(page([], null)), { stored: tokens("old", 30_000) });
    await c.list("contacts");
    expect(refreshed).toEqual(["rt-old"]);
    expect(calls[0].headers.Authorization).toBe("Bearer fresh1");
  });

  it("no tokens on file is an auth error that says to run sage:auth", async () => {
    const { c, calls } = client(() => json(page([], null)), { stored: null });
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "auth", message: expect.stringContaining("sage:auth") });
    expect(calls).toHaveLength(0);
  });

  it("a refused refresh is an auth error and does not leak the client secret or tokens", async () => {
    const { c } = client(() => json(page([], null)), {
      stored: tokens("old", 0),
      refresh: async () => {
        throw new Error("invalid_grant");
      },
    });
    const err = await c.list("contacts").catch((e) => e);
    expect(err.kind).toBe("auth");
    expect(err.message).not.toMatch(/secret|rt-old|Bearer/);
  });

  it("403 is an auth error that names the business id setting", async () => {
    const { c } = client(() => json([{ $message: "Access denied" }], 403));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "auth", status: 403, message: expect.stringContaining("SAGE_BUSINESS_ID") });
  });
});

describe("one token refresh per sync", () => {
  it("four pulls at once with an expired token: exactly one refresh, all use the new token", async () => {
    const { c, refreshed, writes, calls } = client(() => json(page([{ id: "x" }], null)), { stored: tokens("old", 0) });
    await Promise.all(["ledger_accounts", "contacts", "sales_invoices", "other_payments"].map((p) => c.list(p)));
    expect(refreshed).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(c.refreshCount).toBe(1);
    expect(calls.every((call) => call.headers.Authorization === "Bearer fresh1")).toBe(true);
  });

  it("four pulls at once that all get 401: exactly one refresh", async () => {
    const { c, refreshed } = client((_url, init) =>
      (init.headers as Record<string, string>).Authorization === "Bearer good" ? json([], 401) : json(page([{ id: "x" }], null)),
    );
    const results = await Promise.all(["ledger_accounts", "contacts", "sales_invoices", "other_payments"].map((p) => c.list(p)));
    expect(results.flat()).toHaveLength(4);
    expect(refreshed).toHaveLength(1);
  });

  it("a 401 that arrives after another pull already refreshed reuses the new token", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const { c, refreshed } = client(async (url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === "Bearer good") {
        if (url.pathname.endsWith("/slow")) await slowGate;
        return json([], 401);
      }
      return json(page([{ id: "x" }], null));
    });
    const fast = c.list("fast");
    const slow = c.list("slow");
    await fast; // fast has refreshed by now
    releaseSlow();
    await slow;
    expect(refreshed).toHaveLength(1);
  });
});

describe("rate limits and retries", () => {
  it("429 with Retry-After: waits that long and retries", async () => {
    let n = 0;
    const { c, sleeps } = client(() => (n++ === 0 ? json([], 429, { "retry-after": "3" }) : json(page([{ id: "1" }], null))));
    expect(await c.list("contacts")).toHaveLength(1);
    expect(sleeps).toEqual([3000]);
  });

  it("429 without Retry-After backs off 1s, 2s, 4s", async () => {
    let n = 0;
    const { c, sleeps } = client(() => (n++ < 3 ? json([], 429) : json(page([], null))));
    await c.list("contacts");
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("still 429 after the retries: a typed rate_limit error", async () => {
    const { c, sleeps } = client(() => json([], 429, { "retry-after": "1" }));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
    expect(sleeps).toHaveLength(3);
  });

  it("a Retry-After longer than the limit fails at once instead of hanging the sync", async () => {
    const { c, sleeps } = client(() => json([], 429, { "retry-after": "3600" }));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(sleeps).toHaveLength(0);
  });

  it("503 is retried, then an http error", async () => {
    const { c, sleeps } = client(() => json([], 503));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(sleeps).toHaveLength(3);
  });

  it("500 is not retried and carries Sage's message", async () => {
    const { c, calls } = client(() => json([{ $severity: "error", $message: "Something broke" }], 500));
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "http", status: 500, message: expect.stringContaining("Something broke") });
    expect(calls).toHaveLength(1);
  });

  it("retryWaitMs reads an HTTP date", () => {
    expect(retryWaitMs(new Date(NOW.getTime() + 5000).toUTCString(), 0, NOW)).toBe(5000);
  });
});

describe("network and timeout", () => {
  it("no answer: a timeout error, never a hang", async () => {
    const { c } = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 50 },
    );
    const started = Date.now();
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("unreachable: a network error", async () => {
    const { c } = client(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    });
    await expect(c.list("contacts")).rejects.toMatchObject({ kind: "network" });
  });
});

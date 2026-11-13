/**
 * The Sage Accounting HTTP client. Knows the base URL, the business header, the
 * access token and its refresh, pagination, rate limits and timeouts. Returns
 * raw API shapes and nothing else; mapping to canonical lives in normalize.ts.
 *
 * Token rules (PLAN.md Decisions: Token refresh):
 * - runSync pulls the four finance collections in parallel through one client.
 *   The token is refreshed at most once for all of them: the refresh is a
 *   single shared promise, and a 401 only refreshes if nobody has refreshed
 *   since the failing request picked up its token.
 * - Access tokens last 300 seconds, so a token with less than a minute left is
 *   refreshed before use. With syncs more than five minutes apart that is one
 *   refresh per sync.
 * - Sage may rotate the refresh token, so the new pair is written to disk after
 *   every refresh, before it is used.
 *
 * Error messages never contain a token, a client secret or a request header.
 */

import {
  oauthConfigFromEnv,
  readTokens,
  refreshTokens,
  SageAuthError,
  writeTokens,
  type SageOAuthConfig,
  type SageTokens,
} from "./auth";
import {
  SAGE_ITEMS_PER_PAGE,
  SAGE_LIST_ATTRIBUTES,
  type SageApiErrorItem,
  type SageList,
} from "./raw/types";

export const SAGE_API_BASE_URL = "https://api.accounting.sage.com/v3.1/";

export type SageErrorKind = "config" | "auth" | "http" | "network" | "timeout" | "rate_limit" | "shape";

export class SageError extends Error {
  constructor(
    public readonly kind: SageErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SageError";
  }
}

export interface SageClientConfig {
  oauth: SageOAuthConfig;
  businessId: string;
  /** Ends with a slash. Overridable so a local mock can stand in for Sage. */
  baseUrl: string;
}

/** Where tokens come from and go to. The default is the file under .data/. */
export interface TokenStore {
  read(): Promise<SageTokens | null>;
  write(tokens: SageTokens): Promise<void>;
}

export interface SageClientOptions {
  fetch?: typeof fetch;
  tokens?: TokenStore;
  refresh?: (config: SageOAuthConfig, refreshToken: string) => Promise<SageTokens>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Retries after the first attempt, for 429 and 502/503/504. */
  maxRetries?: number;
  /** The longest Retry-After the client will honour. Longer than this fails as rate_limit instead of hanging a sync. */
  maxRetryWaitMs?: number;
  /** A guard against a `$next` that never ends. */
  maxPages?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_MAX_PAGES = 500;
/** Refresh a token that has less than this left. */
const EXPIRY_MARGIN_MS = 60_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SageClientConfig {
  let oauth: SageOAuthConfig;
  try {
    oauth = oauthConfigFromEnv(env);
  } catch (err) {
    throw new SageError("config", describe(err));
  }
  const businessId = env.SAGE_BUSINESS_ID?.trim();
  if (!businessId) {
    throw new SageError("config", "SAGE_BUSINESS_ID must be set in .env (npm run sage:auth prints it)");
  }
  const base = env.SAGE_API_BASE_URL?.trim() || SAGE_API_BASE_URL;
  return { oauth, businessId, baseUrl: base.endsWith("/") ? base : `${base}/` };
}

const fileTokenStore: TokenStore = { read: () => readTokens(), write: (t) => writeTokens(t) };

interface RequestOptions {
  query?: Record<string, string>;
  /** GET /businesses is the one call without X-Business. */
  noBusiness?: boolean;
}

export class SageClient {
  private readonly fetchFn: typeof fetch;
  private readonly store: TokenStore;
  private readonly refreshFn: (config: SageOAuthConfig, refreshToken: string) => Promise<SageTokens>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly maxPages: number;

  private tokens: SageTokens | null = null;
  /** In-flight token load or refresh, shared by every caller that needs a token meanwhile. */
  private pending: Promise<SageTokens> | null = null;
  /** How many refreshes this client has made. Tests read it; a sync should make at most one. */
  refreshCount = 0;

  constructor(
    private readonly config: SageClientConfig,
    options: SageClientOptions = {},
  ) {
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.store = options.tokens ?? fileTokenStore;
    this.refreshFn = options.refresh ?? ((c, rt) => refreshTokens(c, rt));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /** A token good for at least another minute, refreshing (once, shared) if needed. */
  private async accessToken(): Promise<string> {
    if (this.tokens && !this.expiresSoon(this.tokens)) return this.tokens.accessToken;
    if (!this.pending) {
      this.pending = (async () => {
        const current = this.tokens ?? (await this.loadTokens());
        return this.expiresSoon(current) ? this.doRefresh(current) : current;
      })().finally(() => {
        this.pending = null;
      });
    }
    return (await this.pending).accessToken;
  }

  /**
   * Called after a 401. If another request has already replaced the token the
   * failing request used, use that one; otherwise refresh, sharing the refresh
   * with anyone else who hits a 401 meanwhile.
   */
  private async tokenAfter401(staleAccessToken: string): Promise<string> {
    if (this.pending) return (await this.pending).accessToken;
    if (this.tokens && this.tokens.accessToken !== staleAccessToken) return this.tokens.accessToken;
    const current = this.tokens ?? (await this.loadTokens());
    this.pending = this.doRefresh(current).finally(() => {
      this.pending = null;
    });
    return (await this.pending).accessToken;
  }

  private async loadTokens(): Promise<SageTokens> {
    let tokens: SageTokens | null;
    try {
      tokens = await this.store.read();
    } catch (err) {
      throw new SageError("auth", describe(err));
    }
    if (!tokens?.refreshToken) {
      throw new SageError("auth", "No Sage tokens on file. Run npm run sage:auth first.");
    }
    this.tokens = tokens;
    return tokens;
  }

  private async doRefresh(current: SageTokens): Promise<SageTokens> {
    let next: SageTokens;
    try {
      next = await this.refreshFn(this.config.oauth, current.refreshToken);
    } catch (err) {
      const hint = err instanceof SageAuthError && err.status === 400 ? " The refresh token may have expired; run npm run sage:auth again." : "";
      throw new SageError("auth", `Could not refresh the Sage token: ${describe(err)}${hint}`, err instanceof SageAuthError ? err.status : undefined);
    }
    this.refreshCount++;
    // Save before use: if Sage rotated the refresh token, the old one is already dead.
    try {
      await this.store.write(next);
    } catch (err) {
      throw new SageError("auth", `Refreshed the Sage token but could not save it: ${describe(err)}`);
    }
    this.tokens = next;
    return next;
  }

  private expiresSoon(tokens: SageTokens): boolean {
    const at = Date.parse(tokens.accessTokenExpiresAt);
    return !Number.isFinite(at) || at - this.now().getTime() < EXPIRY_MARGIN_MS;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private url(pathOrUrl: string, query?: Record<string, string>): URL {
    const base = new URL(this.config.baseUrl);
    let u: URL;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      u = new URL(pathOrUrl);
      // Never send the token anywhere but Sage's API host.
      if (u.origin !== base.origin) {
        throw new SageError("shape", `Sage returned a next-page link to another host (${u.origin})`);
      }
    } else {
      // `$next` may be "/contacts?page=2", "contacts?page=2" or "/v3.1/contacts?page=2".
      let rel = pathOrUrl.replace(/^\/+/, "");
      const basePath = base.pathname.replace(/^\/+/, "");
      if (basePath && rel.startsWith(basePath)) rel = rel.slice(basePath.length);
      u = new URL(rel, base);
    }
    // Our parameters fill in what the link leaves out; a $next link's own values (its page) win.
    for (const [k, v] of Object.entries(query ?? {})) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    return u;
  }

  /** One GET with auth, the 401 refresh, retries and the timeout. Returns parsed JSON. */
  async get<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(pathOrUrl, options.query);
    const label = url.pathname.replace(/^\/v3\.1\//, "");
    let token = await this.accessToken();
    let refreshedFor401 = false;
    let attempt = 0;

    for (;;) {
      const res = await this.send(url, label, token, options.noBusiness);

      if (res.status === 401) {
        await drain(res);
        if (refreshedFor401) {
          throw new SageError("auth", `Sage rejected the token on ${label} again after a refresh. Run npm run sage:auth.`, 401);
        }
        refreshedFor401 = true;
        token = await this.tokenAfter401(token);
        continue;
      }
      if (res.status === 403) {
        const why = await errorText(res);
        throw new SageError("auth", `Sage refused ${label} (HTTP 403)${why}. Check SAGE_BUSINESS_ID and that the signed-in user belongs to that business.`, 403);
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        const wait = retryWaitMs(res.headers.get("retry-after"), attempt, this.now());
        await drain(res);
        const kind: SageErrorKind = res.status === 429 ? "rate_limit" : "http";
        if (attempt >= this.maxRetries) {
          throw new SageError(kind, `Sage answered ${label} with HTTP ${res.status} after ${attempt + 1} attempts`, res.status);
        }
        if (wait > this.maxRetryWaitMs) {
          throw new SageError(kind, `Sage answered ${label} with HTTP ${res.status} and asked to wait ${Math.ceil(wait / 1000)}s, longer than the ${this.maxRetryWaitMs / 1000}s limit`, res.status);
        }
        attempt++;
        await this.sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new SageError("http", `Sage answered ${label} with HTTP ${res.status}${await errorText(res)}`, res.status);
      }
      return parseJson<T>(res, label);
    }
  }

  private async send(url: URL, label: string, token: string, noBusiness?: boolean): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (!noBusiness) headers["X-Business"] = this.config.businessId;
    try {
      return await this.fetchFn(url.toString(), { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new SageError("timeout", `Sage did not answer ${label} within ${this.timeoutMs / 1000}s`);
      }
      throw new SageError("network", `Could not reach Sage at ${url.origin}: ${describe(err)}`);
    }
  }

  /**
   * Every item of a list endpoint, following `$next` until it is null. Asks for
   * all attributes and the largest page. `since` maps to
   * `updated_or_created_since`. Any page that is not the envelope fails the
   * whole list: a partial list is not a list.
   */
  async list<T>(path: string, options: { since?: string; query?: Record<string, string>; noBusiness?: boolean } = {}): Promise<T[]> {
    const query: Record<string, string> = {
      attributes: SAGE_LIST_ATTRIBUTES,
      items_per_page: String(SAGE_ITEMS_PER_PAGE),
      ...options.query,
    };
    if (options.since) query.updated_or_created_since = options.since;

    const items: T[] = [];
    const seen = new Set<string>();
    let next: string | null = path;
    let pages = 0;

    while (next) {
      if (++pages > this.maxPages) {
        throw new SageError("shape", `Sage's ${path} list ran past ${this.maxPages} pages`);
      }
      // Every page carries our parameters, in case Sage's $next drops attributes=all.
      const key = this.url(next, query).toString();
      if (seen.has(key)) throw new SageError("shape", `Sage's ${path} list sent the same next-page link twice`);
      seen.add(key);

      const page: unknown = await this.get(next, { query, noBusiness: options.noBusiness });
      assertEnvelope<T>(page, path);
      items.push(...page.$items);
      next = page.$next;
    }
    return items;
  }

  /** The businesses the signed-in user can see. */
  businesses<T>(): Promise<T[]> {
    return this.list<T>("businesses", { noBusiness: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertEnvelope<T>(body: unknown, path: string): asserts body is SageList<T> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SageError("shape", `Sage's ${path} list did not answer with an object`);
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.$items)) {
    throw new SageError("shape", `Sage's ${path} list has no $items array`);
  }
  if (b.$next !== null && b.$next !== undefined && typeof b.$next !== "string") {
    throw new SageError("shape", `Sage's ${path} list has a $next that is not a link`);
  }
  // A missing $next is treated as the last page; Sage sends null, but absent means the same.
  if (b.$next === undefined) b.$next = null;
}

async function parseJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type) || /^\s*</.test(text)) {
    throw new SageError("shape", `Sage answered ${label} with an HTML page instead of JSON`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SageError("shape", `Sage answered ${label} with something that is not JSON`, res.status);
  }
}

/** Sage's error body is an array of { $message }. A short, token-free summary for the error text. */
async function errorText(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  try {
    const body = JSON.parse(text) as SageApiErrorItem[] | SageApiErrorItem;
    const items = Array.isArray(body) ? body : [body];
    const messages = items.map((i) => i?.$message).filter((m): m is string => typeof m === "string" && m.length > 0);
    if (messages.length) return `: ${messages.join("; ").slice(0, 300)}`;
  } catch {
    // not JSON; fall through
  }
  return "";
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to do
  }
}

/** Retry-After in seconds or as an HTTP date; without one, 1s, 2s, 4s... */
export function retryWaitMs(header: string | null, attempt: number, now: Date): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now.getTime());
  }
  return 1000 * 2 ** attempt;
}

export function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as (Error & { code?: string }) | undefined;
  if (!(cause instanceof Error)) return err.message;
  // Node puts a refused connection in an AggregateError with an empty message and the reason in .code.
  const why = cause.message || cause.code || (cause instanceof AggregateError ? cause.errors.map((e: { code?: string; message?: string }) => e.code ?? e.message).join(", ") : "") || cause.name;
  return `${err.message} (${why})`;
}

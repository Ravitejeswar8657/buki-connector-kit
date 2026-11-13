/**
 * Sage OAuth: the authorize URL, the code exchange, the refresh, and the token
 * file under .data/. The one-time `npm run sage:auth` script and the connector's
 * client both call this file, so there is one place that knows how tokens work.
 * In the satellite the same job is a route that calls the same functions.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const AUTHORIZE_URL = "https://www.sageone.com/oauth2/auth/central?filter=apiv3.1";
export const TOKEN_URL = "https://oauth.accounting.sage.com/token";
export const TOKEN_PATH = path.join(process.cwd(), ".data", "sage-tokens.json");

/**
 * SAGE_AUTHORIZE_URL and SAGE_TOKEN_URL exist only to point the flow at the
 * local stand-in (mock/sage). Unset, which is the normal case, means Sage.
 * The client secret goes to the token URL, so only point it at Sage or localhost.
 */
const authorizeBase = () => process.env.SAGE_AUTHORIZE_URL?.trim() || AUTHORIZE_URL;
const tokenUrl = () => process.env.SAGE_TOKEN_URL?.trim() || TOKEN_URL;

const TOKEN_TIMEOUT_MS = 15_000;

export class SageAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SageAuthError";
  }
}

export interface SageOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** What we keep on disk. Times are ISO strings so the file reads plainly. */
export interface SageTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string; // absent when Sage does not say
  scope?: string;
  obtainedAt: string;
}

/** Sage's token endpoint response, as sent. */
interface RawTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SageOAuthConfig {
  const clientId = env.SAGE_CLIENT_ID?.trim();
  const clientSecret = env.SAGE_CLIENT_SECRET?.trim();
  const callbackUrl = env.SAGE_CALLBACK_URL?.trim();
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new SageAuthError("SAGE_CLIENT_ID, SAGE_CLIENT_SECRET and SAGE_CALLBACK_URL must all be set in .env");
  }
  return { clientId, clientSecret, callbackUrl };
}

/** The URL the user opens to sign in. `country=gb` pins the UK Sage ID. */
export function authorizeUrl(config: SageOAuthConfig, state: string, scope: "readonly" | "full_access" = "readonly"): string {
  const u = new URL(authorizeBase());
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", config.callbackUrl);
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  u.searchParams.set("country", "gb");
  return u.toString();
}

async function postToken(form: Record<string, string>, now: Date): Promise<SageTokens> {
  let res: Response;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? `no answer within ${TOKEN_TIMEOUT_MS / 1000}s` : String(err);
    throw new SageAuthError(`Could not reach Sage's token endpoint: ${why}`);
  }
  const text = await res.text();
  let body: RawTokenResponse;
  try {
    body = JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new SageAuthError(`Sage's token endpoint answered HTTP ${res.status} with something that is not JSON: ${text.slice(0, 200)}`, res.status);
  }
  if (!res.ok || body.error) {
    throw new SageAuthError(`Sage refused the token request (HTTP ${res.status}): ${body.error ?? "no error code"}${body.error_description ? `, ${body.error_description}` : ""}`, res.status);
  }
  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    throw new SageAuthError("Sage's token response is missing access_token, refresh_token or expires_in", res.status);
  }
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  const tokens: SageTokens = {
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken: body.refresh_token,
    obtainedAt: now.toISOString(),
  };
  if (typeof body.refresh_token_expires_in === "number") tokens.refreshTokenExpiresAt = at(body.refresh_token_expires_in);
  if (body.scope) tokens.scope = body.scope;
  return tokens;
}

/** Trade the one-time code from the callback for tokens. The code expires in 60 seconds. */
export function exchangeCode(config: SageOAuthConfig, code: string, now = new Date()): Promise<SageTokens> {
  return postToken(
    { grant_type: "authorization_code", code, redirect_uri: config.callbackUrl, client_id: config.clientId, client_secret: config.clientSecret },
    now,
  );
}

/** Trade the refresh token for a new pair. Sage may rotate the refresh token, so always save what comes back. */
export function refreshTokens(config: SageOAuthConfig, refreshToken: string, now = new Date()): Promise<SageTokens> {
  return postToken(
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret },
    now,
  );
}

export async function readTokens(file = TOKEN_PATH): Promise<SageTokens | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SageTokens;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SageAuthError(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Temp file and rename, so a crash mid-write never leaves half a refresh token. */
export async function writeTokens(tokens: SageTokens, file = TOKEN_PATH): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

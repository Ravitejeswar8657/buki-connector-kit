/**
 * npm run sage:auth: the one-time Sage sign-in. A thin wrapper: it listens on
 * SAGE_CALLBACK_URL, sends you to Sage, and hands the code to sage/auth.ts,
 * which exchanges it and stores the tokens under .data/. Then it lists the
 * businesses the signed-in user can see, so you can set SAGE_BUSINESS_ID.
 *
 *   npm run sage:auth                 readonly, what the connector needs
 *   npm run sage:auth -- full_access  for loading Sage's test data with Postman
 *   npm run sage:auth -- --no-browser print the sign-in URL instead of opening a browser
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { loadDotEnv } from "../scripts/env.mjs";
import { authorizeUrl, exchangeCode, oauthConfigFromEnv, TOKEN_PATH, writeTokens } from "./data/canonical/sage/auth";

loadDotEnv();

const WAIT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  // rundll32 avoids cmd.exe treating the "&" in the URL as a command separator.
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function listBusinesses(accessToken: string): Promise<void> {
  const base = process.env.SAGE_API_BASE_URL?.trim() || "https://api.accounting.sage.com/v3.1/";
  const res = await fetch(new URL("businesses?attributes=all", base.endsWith("/") ? base : `${base}/`), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.log(`Could not list businesses: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const list = (await res.json()) as Array<{ id: string; name?: string; displayed_as?: string }> | { $items?: Array<{ id: string; name?: string; displayed_as?: string }> };
  const items = Array.isArray(list) ? list : (list.$items ?? []);
  if (items.length === 0) {
    console.log("This user can see no businesses. Sign in as a user of your trial business.");
    return;
  }
  console.log("\nBusinesses this user can see. Put the right id in .env as SAGE_BUSINESS_ID:");
  for (const b of items) console.log(`  ${b.id}  ${b.name ?? b.displayed_as ?? "(no name)"}`);
}

async function main(): Promise<void> {
  const config = oauthConfigFromEnv();
  const callback = new URL(config.callbackUrl);
  if (callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") {
    throw new Error(`SAGE_CALLBACK_URL must point at localhost for this script, found ${callback.host}`);
  }
  const state = randomBytes(16).toString("hex");
  const args = process.argv.slice(2);
  const scope = args.includes("full_access") ? "full_access" : "readonly";
  const noBrowser = args.includes("--no-browser");
  const url = authorizeUrl(config, state, scope);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("No callback from Sage within 5 minutes. Run npm run sage:auth again.")), WAIT_MS);
    const server = createServer(async (req, res) => {
      const got = new URL(req.url ?? "/", config.callbackUrl);
      if (got.pathname !== callback.pathname) {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, text: string) => res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
      const error = got.searchParams.get("error");
      if (error) {
        const description = got.searchParams.get("error_description") ?? "";
        reply(400, `Sage returned an error: ${error} ${description}\nYou can close this tab.`);
        return finish(new Error(`Sage returned an error on the callback: ${error}${description ? `, ${description}` : ""}`));
      }
      if (got.searchParams.get("state") !== state) {
        reply(400, "State mismatch. You can close this tab and run npm run sage:auth again.");
        return finish(new Error("The callback's state did not match; ignored it in case it was not ours."));
      }
      const code = got.searchParams.get("code");
      if (!code) {
        reply(400, "No code in the callback.");
        return finish(new Error("Sage called back without a code."));
      }
      try {
        const tokens = await exchangeCode(config, code);
        await writeTokens(tokens);
        reply(200, "Signed in to Sage. You can close this tab and go back to the terminal.");
        console.log(`Tokens saved to ${TOKEN_PATH} (gitignored). Access token valid until ${tokens.accessTokenExpiresAt}.`);
        await listBusinesses(tokens.accessToken);
        finish();
      } catch (err) {
        reply(500, "The code exchange failed. See the terminal.");
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    function finish(err?: Error): void {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve();
    }

    server.on("error", (err) => finish(new Error(`Could not listen on ${callback.host}: ${err.message}`)));
    server.listen(Number(callback.port || 80), callback.hostname === "localhost" ? "127.0.0.1" : callback.hostname, () => {
      console.log(`Scope: ${scope}${scope === "readonly" ? " (pass full_access to load test data with Postman)" : ""}`);
      console.log(`Listening for Sage's callback on ${config.callbackUrl}`);
      if (noBrowser) {
        console.log(`Open this in a browser and sign in as a user of your TRIAL BUSINESS:\n\n${url}\n`);
      } else {
        console.log("Opening Sage's sign-in in your browser. Sign in as a user of your TRIAL BUSINESS.");
        console.log(`If no browser opens, paste this into one:\n\n${url}\n`);
        openBrowser(url);
      }
    });
  });
}

main().catch((err) => {
  console.error(`sage:auth failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

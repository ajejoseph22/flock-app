/**
 * Preflight for a deployed environment: config, database, Telegram bot and webhook, Stripe account and
 * webhook destinations, and the public health endpoint. Read-only; prints ✔/✘/⚠ per check.
 *
 *   pnpm deploy:check              # locally, with the environment's variables set
 *   node tools/deploy-check.js     # inside the worker container (Coolify → worker → Terminal)
 *
 * Exits 1 if any check fails. Never prints tokens or secrets.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "@flock/core";
import { createDb } from "@flock/db";
import { createStripeClient, inspectWebhookDestinations } from "@flock/payments";
import { createTelegramApi } from "@flock/telegram";
import { sql } from "drizzle-orm";

const rootEnv = resolve(import.meta.dirname, "../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let failures = 0;
const ok = (msg: string) => console.log(`✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`✘ ${msg}`);
};
const warn = (msg: string) => console.log(`⚠ ${msg}`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    fail(`${name}: ${errText(err)}`);
  }
}

async function main() {
  const config = getConfig();
  ok(`config valid (FLOCK_ENV=${config.env}, APP_URL=${config.appUrl}, TELEGRAM_MODE=${config.telegram.mode})`);
  if (config.stripe.livemode) warn("STRIPE_SECRET_KEY is a live key");
  else ok("Stripe key is test mode");

  await check("database", async () => {
    const handle = createDb(config.databaseUrl, { max: 1, applicationName: "flock-deploy-check" });
    try {
      await handle.db.execute(sql`select 1`);
      const res = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      ok(`database reachable, ${res.rows[0]?.n ?? 0} migration(s) applied`);
    } finally {
      await handle.close();
    }
  });

  await check("telegram", async () => {
    const api = createTelegramApi({ token: config.telegram.botToken, apiRoot: config.telegram.apiRoot });
    const me = await api.getMe();
    if (me.username?.toLowerCase() === config.telegram.botUsername.toLowerCase()) ok(`Telegram bot @${me.username}`);
    else fail(`Telegram token belongs to @${me.username}, but TELEGRAM_BOT_USERNAME is ${config.telegram.botUsername}`);
    if (config.telegram.mode !== "webhook") return warn("TELEGRAM_MODE=polling: skipping webhook check");
    const info = await api.getWebhookInfo();
    const expected = `${config.appUrl}/api/webhooks/telegram`;
    if (info.url !== expected) fail(`Telegram webhook is "${info.url || "(none)"}", expected ${expected}. Run tools/set-telegram-webhook.js`);
    else if (info.last_error_message) fail(`Telegram webhook set, last error: ${info.last_error_message} (pending ${info.pending_update_count})`);
    else ok(`Telegram webhook ${info.url} (pending ${info.pending_update_count})`);
  });

  const stripe = createStripeClient({ secretKey: config.stripe.secretKey, apiOverride: config.stripe.apiOverride });
  await check("stripe account", async () => {
    const account = await stripe.accounts.retrieveCurrent();
    ok(`Stripe platform ${account.id} (${account.country ?? "?"}, ${account.settings?.dashboard?.display_name ?? "no display name"})`);
  });
  await check("stripe accounts v2", async () => {
    await stripe.v2.core.accounts.list({ limit: 1 });
    ok("Accounts v2 API available on this platform");
  });
  await check("stripe webhooks", async () => {
    for (const s of await inspectWebhookDestinations(stripe, config.appUrl)) {
      if (!s.id) fail(`Stripe ${s.spec.label}: no destination for ${s.url}. Run \`pnpm stripe:webhooks --create\``);
      else if (!s.enabled || s.missingEvents.length) fail(`Stripe ${s.spec.label}: ${!s.enabled ? "disabled; " : ""}missing ${s.missingEvents.join(", ") || "nothing"}`);
      else ok(`Stripe ${s.spec.label} → ${s.url}${s.apiVersionMismatch ? ` (API version ${s.apiVersionMismatch})` : ""}`);
      if (s.apiVersionMismatch) warn(`${s.spec.label} renders events as ${s.apiVersionMismatch}; Flock's SDK expects its pinned version`);
    }
  });

  await check("health", async () => {
    const res = await fetch(`${config.appUrl}/api/health?worker=1`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { worker?: string };
    if (res.ok) ok(`${config.appUrl}/api/health?worker=1 → web, database and worker up`);
    else fail(`${config.appUrl}/api/health?worker=1 → ${res.status} (worker ${body.worker ?? "?"})`);
  });

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(errText(err));
  process.exit(1);
});

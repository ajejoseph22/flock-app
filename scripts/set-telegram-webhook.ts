/**
 * Register Flock's Telegram webhook (run once per environment, and after rotating TELEGRAM_WEBHOOK_SECRET).
 *
 *   pnpm telegram:set-webhook            # uses APP_URL from the environment / root .env
 *   pnpm telegram:set-webhook --info     # print current webhook info only
 *
 * Telegram will then POST updates to ${APP_URL}/api/webhooks/telegram with the secret header.
 * Prints the result Telegram reports; never prints the bot token or secret.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "@flock/core";
import { createTelegramApi, registerWebhook } from "@flock/telegram";

const rootEnv = resolve(import.meta.dirname, "../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main() {
  const config = getConfig();
  if (config.telegram.mode !== "webhook") {
    throw new Error("TELEGRAM_MODE is 'polling'. Webhooks are for deployed environments; the worker polls locally.");
  }
  if (!config.appUrl.startsWith("https://")) throw new Error("Telegram requires an https APP_URL for webhooks.");
  const api = createTelegramApi({ token: config.telegram.botToken, apiRoot: config.telegram.apiRoot });
  if (process.argv.includes("--info")) {
    console.log(await api.getWebhookInfo());
    return;
  }
  const url = `${config.appUrl}/api/webhooks/telegram`;
  const info = await registerWebhook(api, url, config.telegram.webhookSecret);
  console.log(`Webhook set to ${info.url}`);
  console.log(`Pending updates: ${info.pending_update_count}${info.last_error_message ? `; last error: ${info.last_error_message}` : ""}`);
  console.log(`Allowed updates: ${(info.allowed_updates ?? []).join(", ")}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

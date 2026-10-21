/**
 * Boots the full E2E stack: fresh Postgres database, local provider mocks (Telegram + Stripe),
 * the real worker, and the production Next.js build (`next start`). Playwright runs this as its webServer.
 *
 * Nothing here talks to real Stripe or Telegram. Stripe webhooks are signed by the mock and POSTed
 * to the app's real webhook endpoints, so signature verification runs exactly as in production.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { runMigrations } from "../../packages/db/src/migrate";
import { StripeMock } from "../mocks/stripe-mock";
import { TelegramMock } from "../mocks/telegram-mock";
import { APP_URL, BOT_ID, E2E_ENV, E2E_PORTS } from "./env";

const root = resolve(import.meta.dirname, "../..");
const children: ChildProcess[] = [];

async function resetDatabase() {
  const url = new URL(E2E_ENV.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  await admin.query(`drop database if exists "${dbName}"`);
  await admin.query(`create database "${dbName}"`);
  await admin.end();
  await runMigrations(E2E_ENV.DATABASE_URL!);
}

function run(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const { PORT: _ignored, ...inherited } = process.env;
  const child = spawn(cmd, args, { cwd, env: { ...inherited, ...E2E_ENV, ...env }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] ${name} exited with ${code}`);
      process.exit(1);
    }
  });
  children.push(child);
}

async function main() {
  await resetDatabase();

  const tg = new TelegramMock({ botId: BOT_ID, botUsername: E2E_ENV.TELEGRAM_BOT_USERNAME! });
  await tg.start(E2E_PORTS.telegram);
  const stripeMock = new StripeMock({
    connectWebhookSecret: E2E_ENV.STRIPE_CONNECT_WEBHOOK_SECRET!,
    platformWebhookSecret: E2E_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET!,
    accountsWebhookSecret: E2E_ENV.STRIPE_ACCOUNTS_WEBHOOK_SECRET!,
    deliver: async (target, rawBody, signature) => {
      const res = await fetch(`${APP_URL}/api/webhooks/stripe/${target}`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: rawBody,
      });
      if (!res.ok) console.error(`[e2e] stripe webhook ${target} -> ${res.status} ${await res.text()}`);
    },
  });
  await stripeMock.start(E2E_PORTS.stripe);

  const web = resolve(root, "apps/web");
  if (!existsSync(resolve(web, ".next/BUILD_ID"))) {
    console.log("[e2e] building web app (next build)…");
    const build = spawnSync("pnpm", ["--filter", "@flock/web", "build"], { cwd: root, stdio: "inherit" });
    if (build.status !== 0) process.exit(1);
  }
  run("worker", "pnpm", ["exec", "tsx", "src/main.ts"], resolve(root, "apps/worker"));
  run("web", "pnpm", ["exec", "next", "start", "--port", String(E2E_PORTS.app)], web, { PORT: String(E2E_PORTS.app) });
  console.log(`[e2e] stack starting: app ${APP_URL}, telegram mock :${E2E_PORTS.telegram}, stripe mock :${E2E_PORTS.stripe}`);
}

const shutdown = () => {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err: unknown) => {
  console.error(err);
  shutdown();
  process.exit(1);
});

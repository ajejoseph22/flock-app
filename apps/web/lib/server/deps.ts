import "server-only";
import { createLogger, getConfig, type Deps } from "@flock/core";
import { createDb, type DbHandle } from "@flock/db";
import { createStripeClient, createStripeGateway } from "@flock/payments";
import { createTelegramGateway } from "@flock/telegram";
import type Stripe from "stripe";

interface WebContext {
  deps: Deps;
  handle: DbHandle;
  stripe: Stripe;
}

const globalForFlock = globalThis as unknown as { __flockWeb?: WebContext };

/** Process-wide dependencies for the web app (cached across dev hot reloads). */
export function web(): WebContext {
  if (globalForFlock.__flockWeb) return globalForFlock.__flockWeb;
  const config = getConfig();
  const handle = createDb(config.databaseUrl, { max: 10, applicationName: "flock-web" });
  const stripe = createStripeClient({ secretKey: config.stripe.secretKey, apiOverride: config.stripe.apiOverride });
  const deps: Deps = {
    db: handle.db,
    config,
    log: createLogger({ name: "flock-web", level: config.logLevel }),
    now: () => new Date(),
    telegram: createTelegramGateway({
      token: config.telegram.botToken,
      botId: config.telegram.botId,
      botUsername: config.telegram.botUsername,
      apiRoot: config.telegram.apiRoot,
    }),
    stripe: createStripeGateway(stripe),
  };
  globalForFlock.__flockWeb = { deps, handle, stripe };
  return globalForFlock.__flockWeb;
}

export const deps = () => web().deps;

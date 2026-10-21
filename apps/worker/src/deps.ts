import { createLogger, type AppConfig, type Deps } from "@flock/core";
import { createDb, type DbHandle } from "@flock/db";
import { createStripeClient, createStripeGateway } from "@flock/payments";
import { createTelegramGateway } from "@flock/telegram";

export function createWorkerDeps(config: AppConfig): { deps: Deps; handle: DbHandle } {
  const handle = createDb(config.databaseUrl, { max: config.workerConcurrency + 4, applicationName: "flock-worker" });
  const log = createLogger({ name: "flock-worker", level: config.logLevel });
  const deps: Deps = {
    db: handle.db,
    config,
    log,
    now: () => new Date(),
    telegram: createTelegramGateway({ token: config.telegram.botToken, botId: config.telegram.botId, botUsername: config.telegram.botUsername, apiRoot: config.telegram.apiRoot }),
    stripe: createStripeGateway(createStripeClient({ secretKey: config.stripe.secretKey, apiOverride: config.stripe.apiOverride })),
  };
  return { deps, handle };
}

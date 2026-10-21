import type { Database } from "@flock/db";
import type { AppConfig } from "./config";
import type { StripeGateway, TelegramGateway } from "./gateways";
import type { Logger } from "./logger";

/** Everything a service needs. Tests construct this with mocks pointed at local fake providers. */
export interface Deps {
  db: Database;
  config: AppConfig;
  telegram: TelegramGateway;
  stripe: StripeGateway;
  log: Logger;
  now: () => Date;
}

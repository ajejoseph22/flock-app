/** E2E stack configuration. All provider endpoints are LOCAL MOCKS; values are fake. */
import { TEST_ENV } from "../integration/env";

export const E2E_PORTS = { app: 3100, telegram: 4101, stripe: 4102, workerHealth: 8181 } as const;
export const APP_URL = `http://localhost:${E2E_PORTS.app}`;
export const TELEGRAM_MOCK_URL = `http://127.0.0.1:${E2E_PORTS.telegram}`;
export const STRIPE_MOCK_URL = `http://127.0.0.1:${E2E_PORTS.stripe}`;
export const BOT_ID = 7000000001;

export const E2E_ENV: Record<string, string> = {
  ...TEST_ENV,
  APP_URL,
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/flock_e2e",
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
  TELEGRAM_API_ROOT: TELEGRAM_MOCK_URL,
  STRIPE_API_HOST: "127.0.0.1",
  STRIPE_API_PORT: String(E2E_PORTS.stripe),
  STRIPE_API_PROTOCOL: "http",
  ADMIN_TELEGRAM_USER_IDS: "5550001",
  WORKER_HEALTH_PORT: String(E2E_PORTS.workerHealth),
  WORKER_CONCURRENCY: "4",
};

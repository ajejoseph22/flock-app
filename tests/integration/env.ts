/** Shared test configuration. Values are fake and only valid against the local mocks. */
export const TEST_ENV = {
  FLOCK_ENV: "test",
  APP_URL: "http://localhost:3999",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/flock_test",
  LOG_LEVEL: "silent",
  TELEGRAM_BOT_TOKEN: "7000000001:TEST_mock_token_not_real_aaaaaaaaaaaaaaa",
  TELEGRAM_BOT_USERNAME: "flock_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test_telegram_webhook_secret_0123456789",
  TELEGRAM_MODE: "webhook",
  STRIPE_SECRET_KEY: "sk_test_mock_not_real",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_test_connect",
  STRIPE_PLATFORM_WEBHOOK_SECRET: "whsec_test_platform",
  STRIPE_ACCOUNTS_WEBHOOK_SECRET: "whsec_test_accounts",
  RENEWAL_GRACE_HOURS: "48",
  SUPPORT_EMAIL: "support@useflock.com",
} as const;
export const BOT_ID = 7000000001;

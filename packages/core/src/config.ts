import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const csvInts = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isSafeInteger(n)),
  );

const EnvSchema = z.object({
  FLOCK_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, "must look like 123456:ABC..."),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/, "32-256 chars of A-Z a-z 0-9 _ -"),
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("webhook"),
  TELEGRAM_API_ROOT: z.url().optional(),

  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_/, "must be a Stripe secret or restricted key"),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_PLATFORM_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_ACCOUNTS_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_API_HOST: z.string().optional(),
  STRIPE_API_PORT: z.coerce.number().int().optional(),
  STRIPE_API_PROTOCOL: z.enum(["http", "https"]).optional(),

  PLATFORM_BILLING_ENABLED: bool,
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_GROWTH: z.string().optional(),

  RENEWAL_GRACE_HOURS: z.coerce.number().min(0).max(24 * 14).default(48),
  INVITE_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  SUPPORT_EMAIL: z.email().default("support@useflock.com"),
  ADMIN_TELEGRAM_USER_IDS: csvInts,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type AppConfig = ReturnType<typeof parseConfig>;

export function parseConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid Flock configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.FLOCK_ENV === "production";
  if (isProduction && !e.APP_URL.startsWith("https://")) {
    throw new Error("Invalid Flock configuration:\n  - APP_URL: must use https in production");
  }
  if (e.PLATFORM_BILLING_ENABLED && (!e.STRIPE_PRICE_STARTER || !e.STRIPE_PRICE_GROWTH)) {
    throw new Error("Invalid Flock configuration:\n  - STRIPE_PRICE_STARTER/GROWTH are required when PLATFORM_BILLING_ENABLED");
  }
  return {
    env: e.FLOCK_ENV,
    isProduction,
    appUrl: e.APP_URL.replace(/\/$/, ""),
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      botId: Number(e.TELEGRAM_BOT_TOKEN.split(":")[0]),
      botUsername: e.TELEGRAM_BOT_USERNAME,
      webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
      mode: e.TELEGRAM_MODE,
      // Provider overrides exist for local mocks only and are ignored in production (D-015).
      apiRoot: isProduction ? undefined : e.TELEGRAM_API_ROOT,
    },
    stripe: {
      secretKey: e.STRIPE_SECRET_KEY,
      livemode: e.STRIPE_SECRET_KEY.includes("_live_"),
      connectWebhookSecret: e.STRIPE_CONNECT_WEBHOOK_SECRET,
      platformWebhookSecret: e.STRIPE_PLATFORM_WEBHOOK_SECRET,
      accountsWebhookSecret: e.STRIPE_ACCOUNTS_WEBHOOK_SECRET,
      apiOverride:
        !isProduction && e.STRIPE_API_HOST
          ? { host: e.STRIPE_API_HOST, port: e.STRIPE_API_PORT, protocol: e.STRIPE_API_PROTOCOL ?? "http" }
          : undefined,
    },
    platformBilling: {
      enabled: e.PLATFORM_BILLING_ENABLED,
      priceIds: { starter: e.STRIPE_PRICE_STARTER, growth: e.STRIPE_PRICE_GROWTH },
    },
    access: {
      renewalGraceMs: e.RENEWAL_GRACE_HOURS * 3_600_000,
      inviteLinkTtlMs: e.INVITE_LINK_TTL_HOURS * 3_600_000,
    },
    supportEmail: e.SUPPORT_EMAIL,
    adminTelegramUserIds: e.ADMIN_TELEGRAM_USER_IDS,
    workerConcurrency: e.WORKER_CONCURRENCY,
  };
}

let cached: AppConfig | undefined;
/** Lazily parsed process config. */
export function getConfig(): AppConfig {
  cached ??= parseConfig();
  return cached;
}

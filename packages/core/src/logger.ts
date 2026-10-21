import pino, { type Logger } from "pino";

export type { Logger };

export const REDACT_PATHS = [
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.secret",
  "*.password",
  "*.botToken",
  "*.secretKey",
  "headers.authorization",
  "headers.cookie",
  'headers["stripe-signature"]',
  'headers["x-telegram-bot-api-secret-token"]',
];

export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: options.name ?? "flock",
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: options.name ?? "flock" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Strip anything that looks like a bot token or Stripe key from free-form text. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[bot-token]")
    .replace(/\b(sk|rk)_(test|live)_[A-Za-z0-9]+/g, "[stripe-key]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[webhook-secret]");
}

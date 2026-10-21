/** Expected, user-presentable failure. `code` is stable for tests and UI. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("not_found", message, 404);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have access to this resource") {
    super("forbidden", message, 403);
  }
}

export type TelegramErrorKind =
  | "rate_limited"
  | "transient"
  | "permission"
  | "chat_not_found"
  | "user_blocked_bot"
  | "already_participant"
  | "request_missing"
  | "bad_request";

/** Normalised Telegram Bot API failure produced by the Telegram gateway. */
export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = "TelegramApiError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

/** Classify Bot API error responses. Descriptions are stable enough to key on in practice. */
export function classifyTelegramError(errorCode: number, description: string): TelegramErrorKind {
  const d = description.toLowerCase();
  if (errorCode === 429) return "rate_limited";
  if (errorCode >= 500) return "transient";
  if (d.includes("user_already_participant")) return "already_participant";
  if (d.includes("hide_requester_missing") || d.includes("request not found")) return "request_missing";
  if (d.includes("bot was blocked by the user") || d.includes("user is deactivated") || d.includes("can't initiate conversation")) {
    return "user_blocked_bot";
  }
  if (d.includes("chat not found") || d.includes("group chat was upgraded") || d.includes("chat_id_invalid")) {
    return "chat_not_found";
  }
  if (
    errorCode === 403 ||
    d.includes("not enough rights") ||
    d.includes("have no rights") ||
    d.includes("chat_admin_required") ||
    d.includes("bot is not a member") ||
    d.includes("bot was kicked") ||
    d.includes("need administrator rights")
  ) {
    return "permission";
  }
  return "bad_request";
}

/** Stripe failure normalised by the payments gateway. */
export class StripeGatewayError extends Error {
  constructor(
    readonly kind: "rate_limited" | "transient" | "invalid_request" | "permission" | "not_found" | "card",
    message: string,
    readonly stripeCode?: string,
  ) {
    super(message);
    this.name = "StripeGatewayError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

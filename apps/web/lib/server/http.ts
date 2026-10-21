import "server-only";
import { AppError, StripeGatewayError, TelegramApiError } from "@flock/core";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { deps } from "./deps";

/** Reject cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const appOrigin = new URL(deps().config.appUrl).origin;
  if (origin) return origin === appOrigin;
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

export function clientIp(req: Request | Headers): string | null {
  const h = req instanceof Headers ? req : req.headers;
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Map an error to a message that is safe to show a user. Unexpected errors are logged, not leaked. */
export function userMessage(err: unknown, context: string): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Please check the form.";
  if (err instanceof AppError) return err.message;
  if (err instanceof StripeGatewayError) {
    deps().log.warn({ err: err.message, kind: err.kind, context }, "stripe error");
    return err.retryable ? "Stripe is temporarily unavailable. Please try again in a moment." : "Stripe couldn't complete that request.";
  }
  if (err instanceof TelegramApiError) {
    deps().log.warn({ err: err.message, kind: err.kind, context }, "telegram error");
    return err.retryable ? "Telegram is temporarily unavailable. Please try again in a moment." : "Telegram couldn't complete that request.";
  }
  deps().log.error({ err: err instanceof Error ? err.message : String(err), context }, "unexpected error");
  return "Something went wrong. Please try again.";
}

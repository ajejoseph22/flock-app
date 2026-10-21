import Stripe from "stripe";

export interface StripeClientOptions {
  secretKey: string;
  /** Local mock override; ignored in production by config (D-015). */
  apiOverride?: { host: string; port?: number; protocol: "http" | "https" };
}

/** One pinned API version for v1 and v2 calls (stripe-node 23 → 2026-09-30.endive). */
export function createStripeClient(opts: StripeClientOptions): Stripe {
  return new Stripe(opts.secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: "Flock", url: "https://useflock.co" },
    ...(opts.apiOverride ? { host: opts.apiOverride.host, port: opts.apiOverride.port, protocol: opts.apiOverride.protocol } : {}),
  });
}

export type { Stripe };

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Monorepo: share the root .env with the worker in local development. Never present in production.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The container image (infra/docker/Dockerfile) sets NEXT_OUTPUT=standalone to ship a traced, minimal server.
  // `pnpm start` (next start) leaves it unset.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  transpilePackages: ["@flock/core", "@flock/db", "@flock/payments", "@flock/telegram"],
  serverExternalPackages: ["pg", "pino", "grammy", "stripe"],
  typescript: { tsconfigPath: "tsconfig.json" },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

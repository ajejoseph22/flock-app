import "server-only";
import { hitRateLimit } from "@flock/core";
import { deps } from "./deps";

export async function allow(key: string, limit: number, windowMs: number) {
  const d = deps();
  return hitRateLimit(d.db, key, limit, windowMs, d.now());
}

import { analyticsEvents, auditLogs, type DbOrTx } from "@flock/db";
import type { AnalyticsEventName } from "../analytics-events";

export interface AuditEntry {
  actorType: "user" | "system" | "stripe" | "telegram";
  actorUserId?: string | null;
  creatorId?: string | null;
  communityId?: string | null;
  subjectUserId?: string | null;
  action: string;
  details?: Record<string, unknown>;
}

export async function audit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: entry.actorType,
    actorUserId: entry.actorUserId ?? null,
    creatorId: entry.creatorId ?? null,
    communityId: entry.communityId ?? null,
    subjectUserId: entry.subjectUserId ?? null,
    action: entry.action,
    details: entry.details ?? {},
  });
}

export async function track(
  db: DbOrTx,
  name: AnalyticsEventName,
  ids: { userId?: string | null; creatorId?: string | null; communityId?: string | null },
  properties: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(analyticsEvents).values({
    name,
    userId: ids.userId ?? null,
    creatorId: ids.creatorId ?? null,
    communityId: ids.communityId ?? null,
    properties,
  });
}

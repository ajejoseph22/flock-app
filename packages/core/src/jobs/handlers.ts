import type { Deps } from "../deps";
import { issueInvite, reconcileAccess, revokeAccess, handleJoinRequest } from "../services/access";
import { syncCheckoutIntent, syncConnectedSubscription } from "../services/billing-sync";
import { notifyQuietly } from "../services/chat-connection";
import { refreshMerchant } from "../services/merchant";
import { syncPlatformSubscription } from "../services/platform-billing";
import { runExpirySweep, runReconciliation, runRetention } from "../services/reconciliation";
import { processWebhookEvent } from "../services/webhooks";
import type { JobPayloads, JobType } from "./types";

type Handler<T extends JobType> = (deps: Deps, payload: JobPayloads[T]) => Promise<unknown>;

/** Job type → service call. Payloads are IDs; services reload state. */
export const jobHandlers: { [T in JobType]: Handler<T> } = {
  "webhook.process": (deps, p) => processWebhookEvent(deps, p.webhookEventId),
  "stripe.sync_subscription": (deps, p) => syncConnectedSubscription(deps, p.stripeAccountId, p.stripeSubscriptionId),
  "stripe.sync_checkout": (deps, p) => syncCheckoutIntent(deps, p.checkoutIntentId),
  "stripe.refresh_merchant": (deps, p) => refreshMerchant(deps, p.stripeAccountId),
  "stripe.sync_platform_subscription": (deps, p) => syncPlatformSubscription(deps, p.stripeSubscriptionId),
  "access.reconcile": (deps, p) => reconcileAccess(deps, p.userId, p.communityId),
  "access.issue_invite": (deps, p) => issueInvite(deps, p.userId, p.communityId),
  "access.revoke": (deps, p) => revokeAccess(deps, p.userId, p.communityId),
  "access.handle_join_request": (deps, p) => handleJoinRequest(deps, p.telegramUserId, p.telegramChatId),
  "telegram.notify": (deps, p) => notifyQuietly(deps, p.telegramUserId, p.html, p.buttons),
  "cron.expiry_sweep": (deps) => runExpirySweep(deps),
  "cron.reconcile": (deps) => runReconciliation(deps),
  "cron.retention": (deps) => runRetention(deps),
};

export async function runJob(deps: Deps, type: JobType, payload: Record<string, unknown>) {
  const handler = jobHandlers[type] as Handler<JobType> | undefined;
  if (!handler) throw new Error(`Unknown job type ${type}`);
  return handler(deps, payload as never);
}

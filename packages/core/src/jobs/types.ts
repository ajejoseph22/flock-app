/** Job type → payload. Payloads carry IDs only; handlers always load fresh state. */
export interface JobPayloads {
  "webhook.process": { webhookEventId: string };
  "stripe.sync_subscription": { stripeAccountId: string; stripeSubscriptionId: string };
  "stripe.sync_checkout": { checkoutIntentId: string };
  "stripe.refresh_merchant": { stripeAccountId: string };
  "stripe.sync_platform_subscription": { stripeSubscriptionId: string };
  "access.reconcile": { userId: string; communityId: string };
  "access.issue_invite": { userId: string; communityId: string };
  "access.revoke": { userId: string; communityId: string };
  "access.handle_join_request": { telegramUserId: number; telegramChatId: number; userChatId: number | null };
  "telegram.notify": { telegramUserId: number; html: string; buttons?: { text: string; url: string }[][] };
  "cron.expiry_sweep": Record<string, never>;
  "cron.reconcile": Record<string, never>;
  "cron.retention": Record<string, never>;
}

export type JobType = keyof JobPayloads;

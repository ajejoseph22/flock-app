export const ANALYTICS = {
  creatorRegistered: "creator_registered",
  communityCreated: "community_created",
  telegramConnected: "telegram_community_connected",
  stripeConnected: "stripe_account_connected",
  planCreated: "membership_plan_created",
  pagePublished: "membership_page_published",
  subscriberLinked: "subscriber_identity_linked",
  checkoutStarted: "checkout_started",
  checkoutCompleted: "checkout_completed",
  subscriptionActivated: "subscription_activated",
  accessGranted: "access_granted",
  accessGrantFailed: "access_grant_failed",
  subscriptionCanceled: "subscription_canceled",
  accessRevoked: "access_revoked",
  webhookProcessed: "webhook_processed",
} as const;

export type AnalyticsEventName = (typeof ANALYTICS)[keyof typeof ANALYTICS];

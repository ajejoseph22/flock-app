/**
 * Provider ports. Implemented by @flock/telegram and @flock/payments; services depend only on these.
 * Shapes are the minimal normalised data Flock needs, not full provider objects.
 */
import type { MemberStatus } from "./domain/access";

// ─── Telegram ────────────────────────────────────────────────────────────────

export interface TgChatMember {
  status: MemberStatus;
  /** For `restricted`: whether the user is currently in the chat. */
  isMember?: boolean;
  canInviteUsers?: boolean;
  canRestrictMembers?: boolean;
  isAnonymous?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export type InlineButton = { text: string; url: string } | { text: string; callbackData: string };

export interface TelegramGateway {
  readonly botId: number;
  readonly botUsername: string;
  getChat(chatId: number): Promise<TgChat>;
  getChatMember(chatId: number, userId: number): Promise<TgChatMember>;
  createJoinRequestLink(chatId: number, opts: { name: string; expireDate: Date }): Promise<string>;
  revokeInviteLink(chatId: number, inviteLink: string): Promise<void>;
  approveJoinRequest(chatId: number, userId: number): Promise<void>;
  declineJoinRequest(chatId: number, userId: number): Promise<void>;
  banChatMember(chatId: number, userId: number): Promise<void>;
  unbanChatMember(chatId: number, userId: number, opts: { onlyIfBanned: boolean }): Promise<void>;
  sendMessage(chatId: number, html: string, opts?: { buttons?: InlineButton[][] }): Promise<{ messageId: number }>;
  editMessage(chatId: number, messageId: number, html: string, opts?: { buttons?: InlineButton[][] }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

export interface MerchantAccountSnapshot {
  id: string;
  livemode: boolean;
  displayName: string | null;
  country: string | null;
  defaultCurrency: string | null;
  cardPaymentsStatus: string | null;
  requirementsStatus: string | null;
  requirements: { description: string; awaitingActionFrom: string; deadlineStatus: string | null }[];
}

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  endedAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  priceId: string | null;
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
  created: Date;
  livemode: boolean;
}

export interface InvoiceSnapshot {
  id: string;
  status: string;
  subscriptionId: string | null;
  /** Period end of the subscription line item (what the invoice paid for). */
  periodEnd: Date | null;
  amountPaid: number;
  currency: string;
  paidAt: Date | null;
}

export interface CheckoutSessionSnapshot {
  id: string;
  url: string | null;
  status: string;
  subscriptionId: string | null;
  customerId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
}

export interface CreateCheckoutParams {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
}

export interface StripeGateway {
  // Connected accounts (Accounts v2)
  createMerchantAccount(
    params: { displayName: string; contactEmail: string; defaultCurrency: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<MerchantAccountSnapshot>;
  retrieveMerchantAccount(accountId: string): Promise<MerchantAccountSnapshot>;
  createOnboardingLink(accountId: string, urls: { refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;

  // Catalog on the connected account
  createProduct(
    accountId: string,
    params: { name: string; description: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  updateProduct(accountId: string, productId: string, params: { name: string; description: string }): Promise<void>;
  createMonthlyPrice(
    accountId: string,
    params: { productId: string; amountMinor: number; currency: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  setPriceActive(accountId: string, priceId: string, active: boolean): Promise<void>;

  // Customers, checkout, subscriptions on the connected account
  createCustomer(accountId: string, params: { name: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createSubscriptionCheckout(accountId: string, params: CreateCheckoutParams, idempotencyKey: string): Promise<CheckoutSessionSnapshot>;
  retrieveCheckoutSession(accountId: string, sessionId: string): Promise<CheckoutSessionSnapshot>;
  retrieveSubscription(accountId: string, subscriptionId: string): Promise<SubscriptionSnapshot>;
  listSubscriptionInvoices(accountId: string, subscriptionId: string): Promise<InvoiceSnapshot[]>;
  retrieveInvoice(accountId: string, invoiceId: string): Promise<InvoiceSnapshot>;
  /** Invoice paid by a PaymentIntent (via InvoicePayments), or null. */
  findInvoiceIdForPaymentIntent(accountId: string, paymentIntentId: string): Promise<string | null>;
  retrieveChargePaymentIntent(accountId: string, chargeId: string): Promise<{ paymentIntentId: string | null; amount: number; amountRefunded: number }>;
  createPortalConfiguration(accountId: string, params: { headline: string; returnUrl: string }): Promise<{ id: string }>;
  createPortalSession(accountId: string, params: { customerId: string; returnUrl: string; configurationId: string }): Promise<{ url: string }>;

  // Platform (Flock's own SaaS billing)
  createPlatformCustomer(params: { name: string; email: string | null; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createPlatformCheckout(params: CreateCheckoutParams, idempotencyKey: string): Promise<CheckoutSessionSnapshot>;
  retrievePlatformSubscription(subscriptionId: string): Promise<SubscriptionSnapshot>;
  createPlatformPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

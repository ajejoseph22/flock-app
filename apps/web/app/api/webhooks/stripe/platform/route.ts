import { stripeWebhookRoute } from "@/lib/server/stripe-webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = stripeWebhookRoute("platform");

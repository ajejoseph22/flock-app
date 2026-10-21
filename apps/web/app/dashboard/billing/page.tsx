import { platformBillingAvailable, platformPlanInfo } from "@flock/core";
import { PLATFORM_PLANS, type PlatformPlanKey } from "@flock/core/pricing";
import { platformSubscriptions } from "@flock/db";
import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { platformCheckoutAction, platformPortalAction } from "@/app/dashboard/actions";
import { ActionButton } from "@/components/ui/action-button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const { creator } = await requireCreator("/dashboard/billing");
  const { checkout } = await searchParams;
  const d = deps();
  const enabled = platformBillingAvailable(d);
  const current = platformPlanInfo(creator.platformPlan as PlatformPlanKey);
  const [sub] = await d.db
    .select()
    .from(platformSubscriptions)
    .where(eq(platformSubscriptions.creatorId, creator.id))
    .orderBy(desc(platformSubscriptions.createdAt))
    .limit(1);

  return (
    <>
      <PageHeader title="Billing" description="Your Flock plan. This is separate from the payments your members make to you." />
      {checkout === "success" && (
        <Alert tone="info" title="Thanks! We're confirming your payment with Stripe." className="mb-4">
          Your plan updates as soon as Stripe confirms it, usually within a minute.
        </Alert>
      )}
      <Card className="mb-4">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>{current.name}</CardTitle>
            <CardDescription>{current.blurb}</CardDescription>
          </div>
          <Badge tone="primary">Current plan</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>
            {formatMoney(current.priceMonthlyMinor, current.currency)} / month
            {sub && ` · ${sub.status.replace(/_/g, " ")}`}
            {sub?.currentPeriodEnd && ` · ${sub.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(sub.currentPeriodEnd)}`}
          </p>
          {enabled && creator.platformStripeCustomerId && (
            <ActionButton action={platformPortalAction} variant="outline" size="sm">
              Manage billing on Stripe
            </ActionButton>
          )}
        </CardContent>
      </Card>

      {enabled ? (
        <div className="grid gap-4 md:grid-cols-2">
          {PLATFORM_PLANS.filter((p) => p.key !== "beta" && p.key !== creator.platformPlan).map((p) => (
            <Card key={p.key}>
              <CardHeader>
                <CardTitle>{p.name}</CardTitle>
                <CardDescription>{p.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-xl font-semibold">{formatMoney(p.priceMonthlyMinor, p.currency)} / month</p>
                <ActionButton action={platformCheckoutAction.bind(null, p.key)} pendingText="Opening Stripe…">
                  Choose {p.name}
                </ActionButton>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Alert tone="info" title="Flock is free during early access">
          There&apos;s nothing to pay. We&apos;ll give you advance notice before paid plans start.
        </Alert>
      )}
    </>
  );
}

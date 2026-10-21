import { getMerchantForCreator, getOwnedCommunity, listPlans, listPriceVersions } from "@flock/core";
import { currencyExponent } from "@flock/core/domain/money";
import { Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PlanDetailsForm, PlanPriceForm, PlanStatusButton } from "@/components/dashboard/plan-editor";
import { CreatePlanForm } from "@/components/dashboard/plan-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Plans" };

function majorString(amountMinor: number, currency: string) {
  const exp = currencyExponent(currency);
  return (amountMinor / 10 ** exp).toFixed(exp);
}

export default async function PlansPage() {
  const { creator } = await requireCreator("/dashboard/plans");
  const d = deps();
  const community = await getOwnedCommunity(d.db, creator.id);
  const merchant = await getMerchantForCreator(d.db, creator.id);
  if (!community || !merchant) {
    return (
      <>
        <PageHeader title="Plans" />
        <EmptyState icon={<Tags />} title="Finish setup first">
          Create your community and connect Stripe on the{" "}
          <Link className="underline" href="/dashboard/setup">
            setup page
          </Link>
          .
        </EmptyState>
      </>
    );
  }
  const plans = await listPlans(d.db, community.id);
  const versions = new Map(await Promise.all(plans.map(async (p) => [p.plan.id, await listPriceVersions(d.db, p.plan.id)] as const)));
  const hasActive = plans.some((p) => p.plan.status === "active");

  return (
    <>
      <PageHeader title="Plans" description="During early access each community has one monthly plan." />
      <div className="flex flex-col gap-4">
        {!hasActive && (
          <Card>
            <CardHeader>
              <CardTitle>Create a plan</CardTitle>
              <CardDescription>The plan and its price are created on your Stripe account.</CardDescription>
            </CardHeader>
            <CardContent>
              <CreatePlanForm defaultCurrency={merchant.defaultCurrency ?? "usd"} />
            </CardContent>
          </Card>
        )}
        {plans.map(({ plan, price }) => (
          <Card key={plan.id} data-testid="plan-card">
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{price ? `${formatMoney(price.amountMinor, price.currency)} / month` : "No price"}</CardDescription>
              </div>
              <Badge tone={plan.status === "active" ? "success" : "neutral"}>{plan.status === "active" ? "Active" : "Inactive"}</Badge>
            </CardHeader>
            <CardContent className="grid gap-8 lg:grid-cols-2">
              <PlanDetailsForm planId={plan.id} name={plan.name} description={plan.description} />
              <div className="flex flex-col gap-6">
                {price && plan.status === "active" && <PlanPriceForm planId={plan.id} price={majorString(price.amountMinor, price.currency)} currency={price.currency} />}
                <div>
                  <p className="mb-2 text-sm font-medium">Price history</p>
                  <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {(versions.get(plan.id) ?? []).map((v) => (
                      <li key={v.id} className="flex justify-between gap-3">
                        <span>{formatMoney(v.amountMinor, v.currency)} / month</span>
                        <span>
                          {v.id === plan.currentPriceId ? "Current" : "Retired"} · since {formatDate(v.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {(plan.status === "active" || !hasActive) && <PlanStatusButton planId={plan.id} active={plan.status === "active"} />}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

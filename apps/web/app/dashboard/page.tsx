import { displayTelegramName, getDashboardStats, getSetupState } from "@flock/core";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatMoney, formatMoneyByCurrency } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const { creator } = await requireCreator("/dashboard");
  const d = deps();
  const setup = await getSetupState(d.db, creator.id);
  const doneCount = setup.steps.filter((s) => s.done).length;

  if (!setup.community) {
    return (
      <>
        <PageHeader title="Welcome to Flock" description="Let's get your paid Telegram community set up." />
        <SetupCallout done={doneCount} total={setup.steps.length} />
      </>
    );
  }

  const stats = await getDashboardStats(d.db, setup.community.id, d.now());
  return (
    <>
      <PageHeader title="Overview" description={setup.community.name} />
      {doneCount < setup.steps.length && (
        <div className="mb-6">
          <SetupCallout done={doneCount} total={setup.steps.length} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Members with access" value={String(stats.activeMembers)} testId="stat-active-members" />
        <Stat label="Active subscriptions" value={String(stats.activeSubscriptions)} testId="stat-active-subscriptions" />
        <Stat label="Monthly recurring revenue" value={formatMoneyByCurrency(stats.mrr)} hint="Before Stripe fees" testId="stat-mrr" />
      </div>

      {stats.attention.length > 0 && (
        <Card className="mt-6 border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" aria-hidden /> Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {stats.attention.map((a, i) => (
                <li key={`${a.userId ?? "chat"}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div>
                    <p className="font-medium">
                      {a.userId ? (
                        <Link className="hover:underline" href={`/dashboard/members/${a.userId}`}>
                          {a.name}
                        </Link>
                      ) : (
                        a.name
                      )}
                    </p>
                    <p className="text-muted-foreground">{a.issue}</p>
                  </div>
                  {a.detail && <p className="max-w-md text-xs text-muted-foreground">{a.detail}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent payments</CardTitle>
            <CardDescription>Paid invoices synced from Stripe.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.recentPayments.length === 0 ? (
              <EmptyState title="No payments yet">When members pay, they appear here.</EmptyState>
            ) : (
              <ul className="divide-y">
                {stats.recentPayments.map(({ invoice, user }) => (
                  <li key={invoice.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <Link href={`/dashboard/members/${user.id}`} className="hover:underline">
                      {displayTelegramName(user)}
                    </Link>
                    <div className="flex items-center gap-3">
                      {invoice.refunded && <Badge tone="danger">Refunded</Badge>}
                      <span className="font-medium tabular-nums">{formatMoney(invoice.amountPaidMinor, invoice.currency)}</span>
                      <span className="text-muted-foreground">{formatDate(invoice.paidAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent cancellations</CardTitle>
            <CardDescription>Members who canceled or whose subscription ended.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.recentCancellations.length === 0 ? (
              <EmptyState title="No cancellations" />
            ) : (
              <ul className="divide-y">
                {stats.recentCancellations.map(({ subscription, user }) => (
                  <li key={subscription.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <Link href={`/dashboard/members/${user.id}`} className="hover:underline">
                      {displayTelegramName(user)}
                    </Link>
                    <span className="text-muted-foreground">
                      {subscription.status === "canceled" ? `Ended ${formatDate(subscription.endedAt ?? subscription.canceledAt)}` : `Ends ${formatDate(subscription.currentPeriodEnd)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function SetupCallout({ done, total }: { done: number; total: number }) {
  return (
    <Card className="border-primary/40 bg-primary-soft/40">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <p className="font-medium">
            Setup: {done} of {total} steps done
          </p>
          <div className="h-2 w-56 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <div className="h-full bg-primary" style={{ width: `${(done / total) * 100}%` }} />
          </div>
        </div>
        <Link href="/dashboard/setup" className={buttonClasses("primary")}>
          Continue setup <ArrowRight aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}

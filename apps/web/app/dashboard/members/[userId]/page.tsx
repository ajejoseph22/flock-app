import { displayTelegramName, getMemberDetail, getOwnedCommunity } from "@flock/core";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { accessLabel, auditLabel, telegramLabel } from "@/components/dashboard/labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Member" };

export default async function MemberDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const { creator } = await requireCreator(`/dashboard/members/${userId}`);
  if (!/^[0-9a-f-]{36}$/.test(userId)) notFound();
  const d = deps();
  const community = await getOwnedCommunity(d.db, creator.id);
  if (!community) notFound();
  const detail = await getMemberDetail(d.db, community.id, userId);
  if (!detail) notFound();
  const latest = detail.subscriptions[0];
  const a = accessLabel(latest?.entitlement?.status ?? null, latest?.entitlement?.reason ?? null);
  const t = telegramLabel(detail.grant?.state ?? null);

  return (
    <>
      <Link href="/dashboard/members" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Members
      </Link>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{displayTelegramName(detail.user)}</h1>
          <p className="text-sm text-muted-foreground">
            {detail.user.telegramUsername ? `@${detail.user.telegramUsername} · ` : ""}Telegram ID {detail.user.telegramUserId}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone={a.tone}>{a.label}</Badge>
          <Badge tone={t.tone}>{t.label}</Badge>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Membership</CardTitle>
          </CardHeader>
          <CardContent>
            {latest ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Plan</dt>
                <dd>{latest.planName}</dd>
                <dt className="text-muted-foreground">Price</dt>
                <dd>{formatMoney(latest.subscription.amountMinor, latest.subscription.currency)} / mo</dd>
                <dt className="text-muted-foreground">Stripe status</dt>
                <dd className="capitalize">{latest.subscription.status.replace(/_/g, " ")}</dd>
                <dt className="text-muted-foreground">Paid through</dt>
                <dd>{formatDate(latest.subscription.paidThrough)}</dd>
                <dt className="text-muted-foreground">Access until</dt>
                <dd>{formatDate(latest.entitlement?.accessEndsAt)}</dd>
                <dt className="text-muted-foreground">Auto-renew</dt>
                <dd>{latest.subscription.cancelAtPeriodEnd || latest.subscription.status === "canceled" ? "Off" : "On"}</dd>
                <dt className="text-muted-foreground">Joined chat</dt>
                <dd>{formatDate(detail.grant?.joinedAt)}</dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No subscription.</p>
            )}
            {detail.grant?.state === "failed" && detail.grant.lastError && (
              <p className="mt-4 rounded-md bg-danger-soft p-3 text-xs text-danger">{detail.grant.lastError}</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {detail.payments.length === 0 ? (
              <EmptyState title="No invoices yet" />
            ) : (
              <ul className="divide-y text-sm">
                {detail.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-muted-foreground">{formatDate(p.paidAt ?? p.createdAt)}</span>
                    <span className="flex items-center gap-2">
                      {p.refunded && <Badge tone="danger">Refunded</Badge>}
                      <Badge tone={p.status === "paid" ? "success" : "neutral"}>{p.status}</Badge>
                      <span className="w-24 text-right font-medium tabular-nums">{p.status === "paid" ? formatMoney(p.amountPaidMinor, p.currency) : "—"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Access timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {detail.timeline.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              <ol className="relative flex flex-col gap-4 border-l pl-5">
                {detail.timeline.map((e) => (
                  <li key={e.id} className="text-sm">
                    <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full bg-primary" aria-hidden />
                    <p className="font-medium">{auditLabel(e.action)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(e.createdAt)} · by {e.actorType}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

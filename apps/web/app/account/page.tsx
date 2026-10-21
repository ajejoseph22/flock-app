import { displayTelegramName, listMemberships } from "@flock/core";
import { Send, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { accessLabel } from "@/components/dashboard/labels";
import { Logo } from "@/components/site/logo";
import { UserMenu } from "@/components/site/user-menu";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireUser } from "@/lib/server/session";
import { manageBillingAction } from "./actions";

export const metadata: Metadata = { title: "My memberships", robots: { index: false } };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const memberships = await listMemberships(deps(), user.id);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <UserMenu user={user} />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-display font-bold tracking-[-0.025em]">My memberships</h1>
        <p className="mt-1 text-sm text-muted-foreground">Signed in as {displayTelegramName(user)}. Cancel or change your card any time through Stripe.</p>

        <div className="mt-6 flex flex-col gap-4">
          {memberships.length === 0 ? (
            <EmptyState icon={<Users />} title="No memberships yet">
              When you join a community through Flock, it shows up here.
            </EmptyState>
          ) : (
            memberships.map((m) => {
              const a = accessLabel(m.active ? "active" : m.reason ? "ended" : null, m.reason);
              return (
                <Card key={m.subscriptionId} data-testid="membership-card">
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <Link href={`/join/${m.communitySlug}`} className="font-semibold hover:underline">
                          {m.communityName}
                        </Link>
                        <p className="text-sm text-muted-foreground">{formatMoney(m.amountMinor, m.currency)} / month</p>
                      </div>
                      <Badge tone={a.tone}>{a.label}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {m.active
                        ? m.renewsAt
                          ? `Renews ${formatDate(m.renewsAt)}.`
                          : `Access until ${formatDate(m.accessEndsAt)}.`
                        : m.accessEndsAt
                          ? `Access ended ${formatDate(m.accessEndsAt)}.`
                          : "Payment not completed."}
                      {m.active && m.cancelAtPeriodEnd && " Auto-renew is off."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {m.inviteLink && (
                        <a href={m.inviteLink} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "sm")}>
                          <Send aria-hidden /> Join the chat
                        </a>
                      )}
                      {m.status !== "incomplete" && m.status !== "incomplete_expired" && (
                        <ActionButton action={manageBillingAction.bind(null, m.subscriptionId)} variant="outline" size="sm" pendingText="Opening Stripe…">
                          {m.active ? "Manage or cancel" : "Billing history"}
                        </ActionButton>
                      )}
                      {!m.active && (
                        <Link href={`/join/${m.communitySlug}`} className={buttonClasses("ghost", "sm")}>
                          Join again
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
        <p className="mt-10 text-sm text-muted-foreground">
          Run a community yourself?{" "}
          <Link href="/dashboard" className="text-accent underline">
            Open the creator dashboard
          </Link>
        </p>
      </main>
    </div>
  );
}

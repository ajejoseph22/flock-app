import { getSetupState } from "@flock/core";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { disconnectChatAction, publishAction, unpublishAction } from "@/app/dashboard/actions";
import { ChatStatus } from "@/components/dashboard/chat-status";
import { CommunityForm } from "@/components/dashboard/community-form";
import { MerchantRequirements, MerchantStatusBadge, merchantStatus } from "@/components/dashboard/merchant-status";
import { StripeContinueButtons } from "@/components/dashboard/stripe-connect";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { creator } = await requireCreator("/dashboard/settings");
  const d = deps();
  const s = await getSetupState(d.db, creator.id);
  if (!s.community) {
    return (
      <>
        <PageHeader title="Settings" />
        <EmptyState title="No community yet">
          <Link className="underline" href="/dashboard/setup">
            Create your community
          </Link>{" "}
          first.
        </EmptyState>
      </>
    );
  }
  const ms = merchantStatus(s.merchant);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Membership page</CardTitle>
              <CardDescription>
                {d.config.appUrl}/join/{s.community.slug}
              </CardDescription>
            </div>
            <Badge tone={s.community.status === "published" ? "success" : "neutral"}>{s.community.status === "published" ? "Published" : "Draft"}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <CommunityForm
              appUrl={d.config.appUrl}
              defaults={{
                name: s.community.name,
                slug: s.community.slug,
                description: s.community.description,
                benefits: s.community.benefits,
                supportContact: s.community.supportContact,
                avatarUrl: s.community.avatarUrl,
              }}
            />
            <div className="border-t pt-5">
              {s.community.status === "published" ? (
                <ActionButton action={unpublishAction} variant="outline" confirm="Unpublish your page? New members can't join, but existing members keep their access.">
                  Unpublish page
                </ActionButton>
              ) : s.publishBlockers.length === 0 ? (
                <ActionButton action={publishAction}>Publish page</ActionButton>
              ) : (
                <p className="text-sm text-muted-foreground">To publish, finish: {s.publishBlockers.join(", ")}.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Telegram chat</CardTitle>
            <CardDescription>The bot invites paying members and removes members whose access ended.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {s.chat ? (
              <>
                <ChatStatus chat={s.chat} />
                <p className="text-xs text-muted-foreground">Last verified {formatDateTime(s.chat.lastVerifiedAt)}</p>
                <div className="border-t pt-5">
                  <ActionButton
                    action={disconnectChatAction}
                    variant="ghost"
                    size="sm"
                    confirm="Disconnect this chat? Your page will be unpublished. This isn't allowed while members still have paid access."
                  >
                    Disconnect chat
                  </ActionButton>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No chat connected.{" "}
                <Link href="/dashboard/setup" className="underline">
                  Connect one on the setup page
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Stripe</CardTitle>
              <CardDescription>Payments are made directly to your Stripe account.</CardDescription>
            </div>
            <MerchantStatusBadge merchant={s.merchant} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{ms.body}</p>
            {s.merchant && <MerchantRequirements merchant={s.merchant} />}
            {s.merchant ? (
              <>
                <StripeContinueButtons showContinue={ms.state !== "ready" && ms.state !== "rejected"} />
                <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-sm text-primary underline">
                  Open your Stripe dashboard <ExternalLink className="size-3.5" aria-hidden />
                </a>
                <p className="text-xs text-muted-foreground">
                  Account {s.merchant.stripeAccountId} · {s.merchant.livemode ? "Live" : "Test"} mode · synced {formatDateTime(s.merchant.lastSyncedAt)}
                </p>
              </>
            ) : (
              <Link href="/dashboard/setup" className="text-sm underline">
                Connect Stripe on the setup page
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

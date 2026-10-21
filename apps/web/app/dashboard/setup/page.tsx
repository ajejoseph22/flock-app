import { getSetupState } from "@flock/core";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { publishAction } from "@/app/dashboard/actions";
import { ChatStatus } from "@/components/dashboard/chat-status";
import { CommunityForm } from "@/components/dashboard/community-form";
import { MerchantRequirements, merchantStatus } from "@/components/dashboard/merchant-status";
import { CreatePlanForm } from "@/components/dashboard/plan-form";
import { StripeContinueButtons, StripeStartForm } from "@/components/dashboard/stripe-connect";
import { TelegramConnect } from "@/components/dashboard/telegram-connect";
import { ActionButton } from "@/components/ui/action-button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Setup" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ stripe?: string; error?: string }> }) {
  const { creator } = await requireCreator("/dashboard/setup");
  const params = await searchParams;
  const d = deps();
  const s = await getSetupState(d.db, creator.id);
  const ms = merchantStatus(s.merchant);
  const current = s.steps.find((st) => !st.done)?.key ?? null;
  const step = (key: string) => s.steps.find((st) => st.key === key)!;
  const index = (key: string) => s.steps.findIndex((st) => st.key === key) + 1;

  return (
    <>
      <PageHeader title="Set up your membership" description="Finish each step to publish your page. You can come back any time." />
      {params.stripe === "returned" && (
        <Alert tone={ms.state === "ready" ? "success" : "info"} title="Back from Stripe" className="mb-4">
          {ms.body}
        </Alert>
      )}
      {params.error && <Alert tone="danger" title={params.error.slice(0, 200)} className="mb-4" />}

      <ol className="flex flex-col gap-4">
        <StepCard n={index("identity")} title="Telegram identity" done current={false}>
          <p className="text-sm text-muted-foreground">You&apos;re signed in with Telegram.</p>
        </StepCard>

        <StepCard n={index("community")} title="Create your community" done={step("community").done} current={current === "community"}>
          <CommunityForm
            appUrl={d.config.appUrl}
            defaults={
              s.community
                ? {
                    name: s.community.name,
                    slug: s.community.slug,
                    description: s.community.description,
                    benefits: s.community.benefits,
                    supportContact: s.community.supportContact,
                    avatarUrl: s.community.avatarUrl,
                  }
                : null
            }
          />
        </StepCard>

        <StepCard n={index("telegram")} title="Connect your Telegram channel or group" done={step("telegram").done} current={current === "telegram"} blocked={!s.community}>
          {!s.community ? (
            <p className="text-sm text-muted-foreground">Create your community first.</p>
          ) : s.chat ? (
            <ChatStatus chat={s.chat} />
          ) : (
            <TelegramConnect botUsername={d.config.telegram.botUsername} />
          )}
        </StepCard>

        <StepCard n={index("stripe")} title="Connect Stripe" done={step("stripe").done} current={current === "stripe"} badge={<Badge tone={ms.tone}>{ms.label}</Badge>}>
          {ms.state === "not_connected" ? (
            <StripeStartForm defaultEmail={creator.contactEmail} />
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{ms.body}</p>
              {s.merchant && <MerchantRequirements merchant={s.merchant} />}
              {ms.state !== "ready" && <StripeContinueButtons showContinue={ms.state !== "rejected"} />}
            </div>
          )}
        </StepCard>

        <StepCard n={index("plan")} title="Create your membership plan" done={step("plan").done} current={current === "plan"} blocked={!s.merchant}>
          {!s.merchant ? (
            <p className="text-sm text-muted-foreground">Connect Stripe first. Plans are created as products on your Stripe account.</p>
          ) : s.plan?.price ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                <span className="font-medium">{s.plan.plan.name}</span> · {formatMoney(s.plan.price.amountMinor, s.plan.price.currency)} / month
              </p>
              <Link href="/dashboard/plans" className={buttonClasses("outline", "sm")}>
                Manage plan
              </Link>
            </div>
          ) : (
            <CreatePlanForm defaultCurrency={s.merchant.defaultCurrency ?? "usd"} />
          )}
        </StepCard>

        <StepCard n={index("publish")} title="Publish your membership page" done={step("publish").done} current={current === "publish"}>
          {s.community?.status === "published" ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">Your page is live. Share this link:</p>
              <code className="w-fit rounded-md bg-muted px-3 py-2 text-sm break-all" data-testid="public-link">
                {d.config.appUrl}/join/{s.community.slug}
              </code>
            </div>
          ) : s.publishBlockers.length > 0 ? (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>Finish these first:</p>
              <ul className="list-disc pl-5">
                {s.publishBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {s.community && (
                <Link href={`/join/${s.community.slug}`} target="_blank" className="text-sm text-primary underline">
                  Preview your page
                </Link>
              )}
              <ActionButton action={publishAction} pendingText="Publishing…">
                Publish page
              </ActionButton>
            </div>
          )}
        </StepCard>
      </ol>
    </>
  );
}

function StepCard({
  n,
  title,
  done,
  current,
  blocked,
  badge,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  current: boolean;
  blocked?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li
      className={cn("rounded-lg border bg-card", current && "border-primary ring-1 ring-primary", blocked && "opacity-70")}
      aria-current={current ? "step" : undefined}
      data-testid={`setup-step-${n}`}
    >
      <div className="flex items-center gap-3 p-5 pb-0 sm:px-6">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            done ? "bg-success-soft text-success" : current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {done ? <Check className="size-4" aria-label="Done" /> : n}
        </span>
        <h2 className="flex-1 font-semibold">{title}</h2>
        {badge}
      </div>
      <div className="p-5 sm:px-6">{children}</div>
    </li>
  );
}

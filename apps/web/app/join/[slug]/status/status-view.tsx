"use client";

import { CheckCircle2, Clock, ExternalLink, Loader2, Send, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type View =
  | { state: "confirming" | "payment_failed" | "checkout_expired" | "preparing_access" | "member" }
  | { state: "access_problem"; message: string }
  | { state: "invite_ready"; inviteLink: string; expiresAt: string | null }
  | { state: "join_pending"; inviteLink: string | null }
  | { state: "ended"; endedAt: string | null };

const POLLING_STATES = new Set(["confirming", "preparing_access", "invite_ready", "join_pending", "access_problem"]);
const MAX_POLL_MS = 15 * 60_000;

export function StatusView(props: { intentId: string; initial: View; communityName: string; slug: string; chatType: string | null; supportContact: string | null }) {
  const [view, setView] = useState<View>(props.initial);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!POLLING_STATES.has(view.state)) return;
    const started = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/checkout/status?intent=${props.intentId}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { view: View };
          if (cancelled) return;
          setView(body.view);
          if (!POLLING_STATES.has(body.view.state)) return;
        }
      } catch {
        // keep polling
      }
      const elapsed = Date.now() - started;
      if (elapsed > 60_000) setSlow(true);
      if (!cancelled && elapsed < MAX_POLL_MS) timer = setTimeout(poll, elapsed < 60_000 ? 2000 : 6000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view.state, props.intentId]);

  const where = props.chatType === "channel" ? "channel" : "group";

  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col gap-5 text-center" aria-live="polite">
        {view.state === "confirming" && (
          <>
            <Icon tone="muted">
              <Loader2 className="animate-spin" />
            </Icon>
            <Title>Confirming your payment</Title>
            <p className="text-sm text-muted-foreground">We&apos;re waiting for Stripe to confirm the payment. This usually takes a few seconds.</p>
            {slow && (
              <Alert tone="info" title="Still confirming">
                Some payment methods take longer. You can close this page; we&apos;ll message you in Telegram when your invite is ready.
              </Alert>
            )}
          </>
        )}
        {view.state === "preparing_access" && (
          <>
            <Icon tone="success">
              <CheckCircle2 />
            </Icon>
            <Title>Payment confirmed</Title>
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Creating your personal invite to {props.communityName}…
            </p>
          </>
        )}
        {view.state === "invite_ready" && (
          <>
            <Icon tone="success">
              <CheckCircle2 />
            </Icon>
            <Title>You&apos;re in! Join {props.communityName}</Title>
            <p className="text-sm text-muted-foreground">
              Open the link with the same Telegram account you signed in with and tap <strong>Request to join</strong>. The Flock bot approves you
              automatically.
            </p>
            <a href={view.inviteLink} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "lg", "w-full")} data-testid="invite-link">
              <Send aria-hidden /> Open the {where} in Telegram
            </a>
            <p className="text-xs text-muted-foreground">This link is personal. If someone else uses it, the bot won&apos;t let them in. We also sent it to you in Telegram.</p>
          </>
        )}
        {view.state === "join_pending" && (
          <>
            <Icon tone="muted">
              <Clock />
            </Icon>
            <Title>Approving your join request…</Title>
            <p className="text-sm text-muted-foreground">This takes a few seconds.</p>
            {view.inviteLink && (
              <a href={view.inviteLink} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
                Reopen the invite link
              </a>
            )}
          </>
        )}
        {view.state === "member" && (
          <>
            <Icon tone="success">
              <CheckCircle2 />
            </Icon>
            <Title>Welcome to {props.communityName}</Title>
            <p className="text-sm text-muted-foreground">You&apos;re a member of the {where}. Open Telegram to start reading.</p>
            <Link href="/account" className={buttonClasses("outline", "md", "w-full")}>
              Manage my membership
            </Link>
          </>
        )}
        {view.state === "access_problem" && (
          <>
            <Icon tone="danger">
              <XCircle />
            </Icon>
            <Title>Your payment went through</Title>
            <Alert tone="warning" title="There's a problem with your invite">
              {view.message}
            </Alert>
            {props.supportContact && <p className="text-sm text-muted-foreground">Community support: {props.supportContact}</p>}
          </>
        )}
        {(view.state === "payment_failed" || view.state === "checkout_expired") && (
          <>
            <Icon tone="danger">
              <XCircle />
            </Icon>
            <Title>{view.state === "payment_failed" ? "The payment didn't go through" : "This checkout expired"}</Title>
            <p className="text-sm text-muted-foreground">You haven&apos;t been given access and, unless Stripe says otherwise, you haven&apos;t been charged.</p>
            <Link href={`/join/${props.slug}`} className={buttonClasses("primary", "md", "w-full")}>
              Try again
            </Link>
          </>
        )}
        {view.state === "ended" && (
          <>
            <Icon tone="muted">
              <Clock />
            </Icon>
            <Title>This membership has ended</Title>
            <Link href={`/join/${props.slug}`} className={buttonClasses("primary", "md", "w-full")}>
              Join again
            </Link>
          </>
        )}
        <Link href="/account" className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground underline">
          My memberships <ExternalLink className="size-3" aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-xl font-semibold tracking-tight" data-testid="status-title">
      {children}
    </h1>
  );
}

function Icon({ tone, children }: { tone: "success" | "danger" | "muted"; children: React.ReactNode }) {
  const cls = tone === "success" ? "bg-success-soft text-success" : tone === "danger" ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground";
  return <div className={`mx-auto flex size-14 items-center justify-center rounded-full [&_svg]:size-7 ${cls}`} aria-hidden>{children}</div>;
}

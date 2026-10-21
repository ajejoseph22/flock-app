"use client";

import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Send, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Challenge = { deepLink: string; appLink: string; expiresAt: string; qrSvg: string };
type Phase = "starting" | "waiting" | "claimed" | "signed_in" | "expired" | "rejected" | "error";

const POLL_MS = 1500;

async function fetchChallenge(returnTo: string | null): Promise<Challenge | { error: string }> {
  try {
    const res = await fetch("/api/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnTo }),
    });
    const body = (await res.json()) as Challenge & { error?: string };
    if (!res.ok) return { error: body.error ?? "Couldn't start sign-in." };
    return body;
  } catch {
    return { error: "Couldn't reach Flock. Check your connection and try again." };
  }
}

export function LoginFlow({ returnTo }: { returnTo: string | null }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchChallenge(returnTo).then((r) => {
      if (cancelled) return;
      if ("error" in r) {
        setError(r.error);
        setPhase("error");
      } else {
        setChallenge(r);
        setPhase("waiting");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [returnTo, attempt]);

  const start = () => {
    setPhase("starting");
    setError(null);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (phase !== "waiting" && phase !== "claimed") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/auth/challenge/status", { method: "POST" });
        const body = (await res.json()) as { state: string; redirectTo?: string };
        if (cancelled) return;
        if (body.state === "signed_in") {
          setPhase("signed_in");
          window.location.assign(body.redirectTo ?? "/account");
          return;
        }
        if (body.state === "claimed") setPhase("claimed");
        else if (body.state === "expired" || body.state === "invalid") return setPhase("expired");
        else if (body.state === "rejected") return setPhase("rejected");
      } catch {
        // Network blip: keep polling.
      }
      if (!cancelled) timer.current = setTimeout(poll, POLL_MS);
    };
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase]);

  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Sign in with Telegram</h1>
          <p className="text-sm text-muted-foreground">Open the Flock bot, then tap Confirm.</p>
        </div>

        {phase === "starting" && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Preparing a secure sign-in link…
          </div>
        )}

        {(phase === "waiting" || phase === "claimed") && challenge && (
          <>
            <ol className="flex flex-col gap-3 text-sm">
              <Step n={1} done={phase === "claimed"}>
                Open Telegram with the button below{showQr ? " or scan the code" : ""}, then press <strong>Start</strong>.
              </Step>
              <Step n={2} done={false} active={phase === "claimed"}>
                Tap <strong>Confirm sign-in</strong> in the bot&apos;s message.
              </Step>
            </ol>
            <a href={challenge.deepLink} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "lg", "w-full")} data-testid="telegram-login-link">
              <Send aria-hidden /> Open Telegram
            </a>
            <a href={challenge.appLink} className="-mt-2 text-center text-xs text-muted-foreground underline">
              Telegram app installed? Open it directly
            </a>
            {showQr ? (
              <div className="flex flex-col items-center gap-2">
                <div
                  className="size-48 rounded-md bg-white p-2 [&_svg]:size-full"
                  role="img"
                  aria-label="QR code that opens the Flock bot in Telegram"
                  dangerouslySetInnerHTML={{ __html: challenge.qrSvg }}
                />
                <p className="text-xs text-muted-foreground">Scan with your phone camera</p>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setShowQr(true)}>
                <Smartphone aria-hidden /> Use your phone instead
              </Button>
            )}
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {phase === "claimed" ? "Waiting for you to confirm in Telegram…" : "Waiting for Telegram…"}
            </p>
          </>
        )}

        {phase === "signed_in" && (
          <Alert tone="success" title="Signed in. Redirecting…" />
        )}

        {phase === "expired" && (
          <div className="flex flex-col gap-3">
            <Alert tone="warning" title="This sign-in link expired">For your security, links work for 10 minutes and only once.</Alert>
            <Button onClick={start}>
              <RefreshCw aria-hidden /> Get a new link
            </Button>
          </div>
        )}

        {phase === "rejected" && (
          <div className="flex flex-col gap-3">
            <Alert tone="danger" title="Sign-in was declined in Telegram">If that wasn&apos;t you, you can ignore it. Nobody was signed in.</Alert>
            <Button variant="outline" onClick={start}>
              Try again
            </Button>
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <Alert tone="danger" title={error ?? "Something went wrong"} />
            <Button variant="outline" onClick={start}>
              Try again
            </Button>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Don&apos;t have Telegram?{" "}
          <a href="https://telegram.org/apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            Get it here <ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

function Step({ n, done, active, children }: { n: number; done: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-success-soft text-success" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
        aria-hidden
      >
        {done ? <CheckCircle2 className="size-4" /> : n}
      </span>
      <span className={done ? "text-muted-foreground line-through" : ""}>{children}</span>
    </li>
  );
}

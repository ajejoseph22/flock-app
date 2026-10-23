"use client";

import { ArrowLeft, CircleCheck, ExternalLink, Loader2, Megaphone, MessagesSquare, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { startTelegramConnectionAction } from "@/app/dashboard/actions";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";

type Status = "pending" | "completed" | "failed" | "expired" | "canceled";

export function TelegramConnect({ botUsername }: { botUsername: string }) {
  const router = useRouter();
  const [pendingStart, startTransition] = useTransition();
  const [request, setRequest] = useState<{ id: string; deepLink: string; chatType: "channel" | "group" } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // First-time creators may not have a chat yet, so ask before showing the connect flow.
  const [stage, setStage] = useState<"ask" | "create" | "connect">("ask");

  const begin = (chatType: "channel" | "group") =>
    startTransition(async () => {
      setError(null);
      setMessage(null);
      const r = await startTelegramConnectionAction(chatType);
      if (r.error || !r.requestId || !r.deepLink) return setError(r.error ?? "Couldn't start.");
      setRequest({ id: r.requestId, deepLink: r.deepLink, chatType });
      setStatus("pending");
    });

  useEffect(() => {
    if (!request || status !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/telegram/connection?id=${request.id}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { status: Status; failureMessage: string | null; chatTitle: string | null };
          if (cancelled) return;
          if (body.status !== "pending") {
            setStatus(body.status);
            setMessage(body.failureMessage);
            if (body.status === "completed") router.refresh();
            return;
          }
        }
      } catch {
        // keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request, status, router]);

  if (request && status === "pending") {
    return (
      <div className="flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>Open Telegram with the button below.</li>
          <li>Pick your private {request.chatType} from the list.</li>
          <li>
            Keep the admin rights <strong>Invite users via link</strong> and <strong>Ban users</strong> switched on, then confirm.
          </li>
        </ol>
        <a href={request.deepLink} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md", "w-fit")} data-testid="add-bot-link">
          Add @{botUsername} to your {request.chatType} <ExternalLink aria-hidden />
        </a>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for Telegram to tell us the bot was added…
        </p>
        <p className="text-xs text-muted-foreground">
          Already added the bot before? Remove it from the chat and add it again with the button, or promote it to admin now.
        </p>
      </div>
    );
  }

  if (stage === "ask" && !status && !error) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Do you already have a Telegram channel or group for your members?</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="outline" className={choiceClasses} onClick={() => setStage("connect")} data-testid="has-chat-yes">
            <span className="flex items-center gap-2 font-medium">
              <CircleCheck aria-hidden /> Yes, I have one
            </span>
            <span className="text-xs font-normal text-muted-foreground">Connect it to Flock now.</span>
          </Button>
          <Button variant="outline" className={choiceClasses} onClick={() => setStage("create")} data-testid="has-chat-no">
            <span className="flex items-center gap-2 font-medium">
              <Plus aria-hidden /> Not yet
            </span>
            <span className="text-xs font-normal text-muted-foreground">We&apos;ll show you how to start one. It takes a minute.</span>
          </Button>
        </div>
      </div>
    );
  }

  if (stage === "create") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium">Start a private chat in Telegram</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Open Telegram and tap <strong>New Channel</strong> or <strong>New Group</strong>. On a phone, it&apos;s under the pencil icon.
          </li>
          <li>
            Pick a channel if you&apos;ll do the posting. Pick a group if members should talk to each other.
          </li>
          <li>Give it a name and a photo. Members see both before they join.</li>
          <li>
            If Telegram asks, choose <strong>Private</strong>. Flock sends each paying member their own invite, so you don&apos;t need a public link.
          </li>
          <li>You can skip adding members. Come back here and connect it.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setStage("connect")} data-testid="created-chat">
            I&apos;ve made it, connect it
          </Button>
          <Button variant="ghost" onClick={() => setStage("ask")}>
            <ArrowLeft aria-hidden /> Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {status === "completed" && <Alert tone="success" title="Chat connected." />}
      {(status === "failed" || status === "expired" || status === "canceled") && (
        <Alert tone="danger" title={status === "expired" ? "The connection request expired" : "We couldn't connect that chat"}>
          {message ?? "Please try again."}
        </Alert>
      )}
      {error && <Alert tone="danger" title={error} />}
      <p className="text-sm text-muted-foreground">Which kind of Telegram chat do members join?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button variant="outline" className={choiceClasses} disabled={pendingStart} onClick={() => begin("channel")}>
          <span className="flex items-center gap-2 font-medium">
            <Megaphone aria-hidden /> Private channel
          </span>
          <span className="text-xs font-normal text-muted-foreground">You post, members read.</span>
        </Button>
        <Button variant="outline" className={choiceClasses} disabled={pendingStart} onClick={() => begin("group")}>
          <span className="flex items-center gap-2 font-medium">
            <MessagesSquare aria-hidden /> Private group
          </span>
          <span className="text-xs font-normal text-muted-foreground">Members can chat with each other.</span>
        </Button>
      </div>
      <button type="button" className="w-fit text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setStage("create")}>
        Don&apos;t have one yet? See how to start one.
      </button>
    </div>
  );
}

const choiceClasses = "h-auto flex-col items-start gap-1 p-4 text-left whitespace-normal";

"use client";

import { ExternalLink, Loader2, Megaphone, MessagesSquare } from "lucide-react";
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
        <Button variant="outline" className="h-auto flex-col items-start gap-1 p-4 text-left whitespace-normal" disabled={pendingStart} onClick={() => begin("channel")}>
          <span className="flex items-center gap-2 font-medium">
            <Megaphone aria-hidden /> Private channel
          </span>
          <span className="text-xs font-normal text-muted-foreground">You post, members read.</span>
        </Button>
        <Button variant="outline" className="h-auto flex-col items-start gap-1 p-4 text-left whitespace-normal" disabled={pendingStart} onClick={() => begin("group")}>
          <span className="flex items-center gap-2 font-medium">
            <MessagesSquare aria-hidden /> Private group
          </span>
          <span className="text-xs font-normal text-muted-foreground">Members can chat with each other.</span>
        </Button>
      </div>
    </div>
  );
}

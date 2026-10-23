import type { telegramChats } from "@flock/db";
import { Megaphone, MessagesSquare } from "lucide-react";
import { recheckChatAction } from "@/app/dashboard/actions";
import { ActionButton } from "@/components/ui/action-button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export function ChatStatus({ chat }: { chat: typeof telegramChats.$inferSelect }) {
  const Icon = chat.chatType === "channel" ? Megaphone : MessagesSquare;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-accent">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="font-medium">{chat.title}</p>
          <p className="text-xs text-muted-foreground">{chat.chatType === "channel" ? "Private channel" : "Private group"}</p>
        </div>
        {chat.status === "connected" ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Needs attention</Badge>}
      </div>
      {chat.status === "needs_attention" && (
        <Alert tone="danger" title="The bot can't manage this chat right now">
          {chat.statusReason ?? "Check the bot's admin rights."} New invites and removals are paused until this is fixed.
        </Alert>
      )}
      <ActionButton action={recheckChatAction} variant="outline" size="sm" pendingText="Checking…">
        Check bot permissions
      </ActionButton>
    </div>
  );
}

import { displayTelegramName } from "@flock/core/telegram-html";
import { LogOut } from "lucide-react";
import type { SessionUser } from "@/lib/server/session";

export function UserMenu({ user }: { user: SessionUser }) {
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right text-sm sm:block">
        <p className="font-medium leading-tight">{displayTelegramName(user)}</p>
        {user.telegramUsername && <p className="text-xs text-muted-foreground">@{user.telegramUsername}</p>}
      </div>
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
          <LogOut className="size-4" aria-hidden />
          <span>Sign out</span>
        </button>
      </form>
    </div>
  );
}

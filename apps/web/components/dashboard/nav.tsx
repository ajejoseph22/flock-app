"use client";

import { CreditCard, LayoutDashboard, ListChecks, Settings, Tags, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/dashboard/setup", label: "Setup", icon: ListChecks },
  { href: "/dashboard/members", label: "Members", icon: Users },
  { href: "/dashboard/plans", label: "Plans", icon: Tags },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
];

export function DashboardNav({ setupIncomplete }: { setupIncomplete: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard" className="flex gap-1 overflow-x-auto md:flex-col">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
              active ? "bg-primary-soft font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
            {item.href === "/dashboard/setup" && setupIncomplete && <span className="ml-auto size-2 rounded-full bg-warning" aria-label="Setup incomplete" />}
          </Link>
        );
      })}
    </nav>
  );
}

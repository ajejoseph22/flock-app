import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

type Tone = "info" | "success" | "warning" | "danger";
const tones: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: { box: "border-primary/30 bg-primary-soft text-foreground", Icon: Info },
  success: { box: "border-success/30 bg-success-soft text-foreground", Icon: CheckCircle2 },
  warning: { box: "border-warning/40 bg-warning-soft text-foreground", Icon: AlertTriangle },
  danger: { box: "border-danger/30 bg-danger-soft text-foreground", Icon: XCircle },
};

export function Alert({ tone = "info", title, children, className }: { tone?: Tone; title?: string; children?: React.ReactNode; className?: string }) {
  const { box, Icon } = tones[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border p-4 text-sm", box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground [&_a]:underline">{children}</div>}
      </div>
    </div>
  );
}

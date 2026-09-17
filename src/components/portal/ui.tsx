import Link from "next/link";
import { ChevronRight, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Small server-safe building blocks the portal tabs share: one card style,
// one honest failure notice, one row link. No hooks, no client code.

export function Card({ children, className, tone = "default" }: { children: React.ReactNode; className?: string; tone?: "default" | "brand" | "success" }) {
  return (
    <div className={cn("panel-shadow rounded-2xl border bg-surface/70 p-4 backdrop-blur", tone === "brand" ? "border-brand/30" : tone === "success" ? "border-success/30" : "border-border", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ icon: Icon, children, action }: { icon?: LucideIcon; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm font-semibold">{Icon && <Icon className="size-4 text-brand" />} {children}</span>
      {action}
    </div>
  );
}

/** A failed load says it failed — never an empty state that reads as "nothing here". */
export function LoadFailed({ what }: { what: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <span className="text-xs">We couldn&rsquo;t load {what} just now — refresh to try again. If it keeps happening, text us.</span>
    </div>
  );
}

export function Empty({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/70 p-6 text-center text-sm text-muted">
      <Icon className="mx-auto size-6 text-muted-2" />
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function RowLink({ href, icon: Icon, children, tone = "default" }: { href: string; icon: LucideIcon; children: React.ReactNode; tone?: "default" | "brand" }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 rounded-2xl border p-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tone === "brand" ? "border-brand/30 bg-brand-soft/40 hover:bg-brand-soft/60" : "border-border bg-surface/70 hover:bg-surface")}>
      <Icon className={cn("size-4 shrink-0", tone === "brand" ? "text-brand" : "text-brand")} />
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight className={cn("size-4 shrink-0", tone === "brand" ? "text-brand" : "text-muted-2")} />
    </Link>
  );
}

export const fmtDate = (d: Date | string, tz = "America/New_York") => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
export const fmtShort = (d: Date | string, tz = "America/New_York") => new Date(d).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
export const fmtTime = (d: Date | string, tz = "America/New_York") => new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
/** "ET" / "CT" — the zone's short name as the browser would print it. */
export const tzShort = (tz: string, d: Date = new Date()) => (new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? tz);

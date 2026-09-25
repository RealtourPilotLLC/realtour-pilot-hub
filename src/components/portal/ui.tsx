import Link from "next/link";
import {
  AlertCircle, CalendarCheck, Camera, CheckCircle2, ChevronRight, Clock, Cog, Lightbulb, ListChecks, PackageCheck, PencilLine, PlayCircle, ScrollText, TriangleAlert, Wrench, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { contactLine } from "@/components/portal/ContactTeam";
import type { Word, WordIcon, WordTone } from "@/lib/portalWords";

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
      <span className="text-xs">We couldn&rsquo;t load {what} just now — refresh to try again. If it keeps happening, {contactLine()}.</span>
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

// ---- UI-01 (Sep 24 2026): the v2 layout's shared pieces ------------------------

const WORD_ICON: Record<WordIcon, LucideIcon> = {
  review: PlayCircle, changes: Wrench, check: CheckCircle2, delivered: PackageCheck, production: Cog, idea: Lightbulb, selected: ListChecks,
  preparing: PencilLine, filmed: Camera, script: ScrollText, calendar: CalendarCheck, clock: Clock, alert: AlertCircle,
};
const WORD_TONE: Record<WordTone, string> = {
  brand: "bg-brand-soft text-brand", success: "bg-success-soft text-success", warning: "bg-warning-soft text-warning", muted: "bg-surface-2 text-muted", danger: "bg-danger-soft text-danger",
};

/** A status from lib/portalWords — always an icon AND words, never colour alone. */
export function StatusChip({ word, className }: { word: Word; className?: string }) {
  const Icon = WORD_ICON[word.icon];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold", WORD_TONE[word.tone], className)}>
      <Icon className="size-3" aria-hidden /> {word.label}
    </span>
  );
}

/** A count on a nav item or a subview tab. The number is read out with its meaning. */
export function CountBadge({ n, label, className }: { n: number; label: string; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold leading-5 text-white tabular-nums", className)}>
      {n > 99 ? "99+" : n}<span className="sr-only"> {label}</span>
    </span>
  );
}

/** Segmented subviews (My Plan's This month · Scripts · Topic bank · Strategy). Real links, 44px tall, equal columns that fit a 375px screen (a phone reads the short label). */
export function SubNav({ items, label }: { items: { href: string; label: string; short?: string; active: boolean; count?: number; countLabel?: string }[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="grid auto-cols-fr grid-flow-col gap-1 rounded-2xl border border-border bg-surface/70 p-1">
        {items.map((i) => (
          <li key={i.href} className="min-w-0">
            <Link href={i.href} aria-current={i.active ? "page" : undefined} className={cn("flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-xl px-2 text-[13px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", i.active ? "bg-brand text-white shadow" : "text-muted hover:text-foreground")}>
              <span className="truncate sm:hidden">{i.short ?? i.label}</span>
              <span className="hidden truncate sm:inline">{i.label}</span>
              {!!i.count && <CountBadge n={i.count} label={i.countLabel ?? "waiting"} className={i.active ? "bg-white text-brand" : ""} />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

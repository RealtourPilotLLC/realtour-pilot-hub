import Link from "next/link";
import { AlertOctagon, Coins, ExternalLink, FlaskConical, Images, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { CreditStripView, StripData } from "./types";

// ---------------------------------------------------------------------------
// THE GLOBAL STRIP (plan 9.2), on every Photo Delivery page:
//   · the AutoHDR credits chip: green at the warning level or above, amber
//     between the two levels, red below critical, gray "API not connected";
//     with the runway and the credits already committed to approved fixes;
//   · a CRITICAL banner while the balance is below the critical level;
//   · the shadow-mode note while QC is advisory (plan 7.7);
//   · the section's own links (Queue, Credits, Settings for the owner).
// Credits are operational, so admins see them; the dollar rate never shows here.
// ---------------------------------------------------------------------------

const TONE: Record<CreditStripView["level"] | "off", string> = {
  ok: "bg-success-soft text-success ring-success/30",
  warn: "bg-warning-soft text-warning ring-warning/30",
  critical: "bg-danger-soft text-danger ring-danger/40",
  unknown: "bg-surface-2 text-muted ring-border",
  off: "bg-surface-2 text-muted ring-border",
};

export function CreditChip({ credit, isOwner }: { credit: CreditStripView | null; isOwner: boolean }) {
  if (!credit) {
    return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ui-status font-medium ring-1 ring-inset", TONE.unknown)}><Coins aria-hidden className="size-3.5" /> AutoHDR credits could not be read</span>;
  }
  if (!credit.connected) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ui-status font-medium ring-1 ring-inset", TONE.off)}>
          <Coins aria-hidden className="size-3.5" /> AutoHDR API not connected
        </span>
        {isOwner ? (
          <Link href="/connections" className="text-ui-status font-medium text-brand hover:underline">Connect it on Connections</Link>
        ) : (
          <span className="text-ui-status text-muted">Jordan connects it on Connections.</span>
        )}
      </span>
    );
  }
  const level = credit.level;
  const label = credit.balance == null ? "Balance not read yet" : `${credit.balance.toLocaleString("en-US")} credits`;
  const parts: string[] = [];
  if (credit.runwayDays != null) parts.push(`about ${credit.runwayDays} day${credit.runwayDays === 1 ? "" : "s"} left at the 14-day pace`);
  else if (credit.balance != null) parts.push("no recent spend to project a runway");
  if (credit.committed > 0) parts.push(`${credit.committed.toLocaleString("en-US")} committed to approved fixes`);
  if (credit.checkedAt) parts.push(`checked ${etDateTime(credit.checkedAt)}`);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Link
        href="/ops/photo-delivery/credits"
        title={`Warning below ${credit.warn}, critical below ${credit.critical}`}
        className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ui-status font-semibold ring-1 ring-inset hover:brightness-110", TONE[level])}
      >
        <Coins aria-hidden className="size-3.5" /> AutoHDR: {label}
      </Link>
      {parts.length > 0 && <span className="text-ui-status text-muted">{parts.join(" · ")}</span>}
    </span>
  );
}

export function GlobalStrip({ strip, current }: { strip: StripData; current: "queue" | "credits" | "settings" | "job" }) {
  const c = strip.credit;
  const critical = !!c && c.connected && c.balance != null && c.level === "critical";
  const tab = (key: typeof current, href: string, label: string, Icon: typeof Images) => (
    <Link
      href={href}
      aria-current={current === key ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium",
        current === key ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4" /> {label}
    </Link>
  );
  return (
    <div className="space-y-2">
      {critical && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm">
          <AlertOctagon aria-hidden className="size-4 shrink-0 text-danger" />
          <span className="min-w-0 flex-1">
            <strong className="text-danger">AutoHDR credits are at {c!.balance!.toLocaleString("en-US")}, below {c!.critical}.</strong>{" "}
            New edits and fixes may fail. Top up in AutoHDR: the hub never buys credits.
          </span>
          <Link href="/ops/photo-delivery/credits" className="inline-flex min-h-11 items-center gap-1 font-semibold text-danger hover:underline">
            Credits <ExternalLink aria-hidden className="size-3.5" />
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/70 px-3 py-2">
        <CreditChip credit={c} isOwner={strip.isOwner} />
        <nav aria-label="Photo Delivery" className="flex flex-wrap items-center gap-1">
          {tab("queue", "/ops/photo-delivery", "Queue", Images)}
          {tab("credits", "/ops/photo-delivery/credits", "Credits", Coins)}
          {strip.isOwner && tab("settings", "/ops/photo-delivery/settings", "Settings", Settings2)}
        </nav>
      </div>
      {strip.qcShadow && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-[13px] text-muted">
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
          <span>
            <strong className="font-semibold text-foreground">QC is in shadow mode:</strong> results are advisory while Kyle keeps his manual check.
            {!strip.qcEnabled && " QC itself is switched off right now, so galleries are tracked but not inspected."}
          </span>
        </p>
      )}
      {!strip.qcShadow && !strip.qcEnabled && (
        <p className="rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-[13px] text-muted">QC is switched off: galleries are tracked but not inspected.</p>
      )}
    </div>
  );
}

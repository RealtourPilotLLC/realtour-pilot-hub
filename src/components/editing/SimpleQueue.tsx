"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, ExternalLink, FolderOpen, Scissors } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

// The Slack tracker, rebuilt as the owner/admin Editor Queue — Jordan: "clear
// out data in the editor queue and make this editor queue as simple as
// possible … I really like the way we have it set up in Slack."
//
// Three tabs = the three questions: what's being edited (Queue), what's coming
// (Upcoming — ANY scheduled shoot with video, per Jordan, not just this week),
// what shipped (Delivered). One row per job, the Slack columns: address+client,
// video type, status, editor, due date, RAW + edit-page links. Everything else
// lives one click away on /edit/<id>.

export type QueueRow = {
  id: string;
  street: string;
  client: string;
  tier: "standard" | "premium" | "branding";
  status: string; // Ready to edit | In editing | In review | Revisions | Waiting | Delivered
  editor: string | null;
  auto: boolean; // editor comes from the routing rules, not a person pick
  dueISO: string | null; // deliveryDue (queue) or shootDate (upcoming)
  late: boolean; // computed server-side (render must stay pure)
  rawUrl: string | null;
  photographer?: string | null;
};

const TIER = {
  standard: { label: "Standard", color: "#38bdf8" },
  premium: { label: "Premium", color: "#a78bfa" },
  branding: { label: "Personal Branding", color: "#f59e0b" },
} as const;

const STATUS_COLOR: Record<string, string> = {
  "Ready to edit": "#38bdf8",
  "In editing": "#a78bfa",
  "In review": "#f59e0b",
  Revisions: "#f87171",
  Waiting: "#94a3b8",
  Delivered: "#34d399",
};

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

function Row({ r, dateLabel }: { r: QueueRow; dateLabel: "Due" | "Shoots" }) {
  const t = TIER[r.tier];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
      <div className="min-w-0 flex-1 basis-52">
        <Link href={`/edit/${r.id}`} className="block truncate text-sm font-semibold hover:underline">
          {r.street} <span className="font-normal text-muted">({r.client})</span>
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Badge color={t.color} className="px-1.5 py-0 text-[10px]">{t.label}</Badge>
          <Badge color={STATUS_COLOR[r.status] ?? "#94a3b8"} className="px-1.5 py-0 text-[10px]">{r.status}</Badge>
        </div>
      </div>
      <div className="text-right text-xs">
        <p className={cn("font-medium", r.late ? "text-danger" : "text-foreground/85")}>
          {dateLabel} {fmtDay(r.dueISO)}{r.late ? " · late" : ""}
        </p>
        <p className="text-muted">{r.editor ? `${r.editor}${r.auto ? " (auto)" : ""}` : r.photographer ? `📷 ${r.photographer}` : "unassigned"}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {r.rawUrl && (
          <a href={r.rawUrl} target="_blank" rel="noopener noreferrer" title="RAW footage folder"
             className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted transition hover:text-foreground">
            <FolderOpen className="size-3.5" /> RAW
          </a>
        )}
        <Link href={`/edit/${r.id}`} title="Open the edit workspace"
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-brand transition hover:border-brand">
          Open <ExternalLink className="size-3" />
        </Link>
      </div>
    </li>
  );
}

export function SimpleQueue({ queue, upcoming, delivered }: { queue: QueueRow[]; upcoming: QueueRow[]; delivered: QueueRow[] }) {
  const [tab, setTab] = useState<"queue" | "upcoming" | "delivered">("queue");
  const TABS = [
    { key: "queue" as const, label: "Queue", icon: Scissors, n: queue.length },
    { key: "upcoming" as const, label: "Upcoming edits", icon: CalendarClock, n: upcoming.length },
    { key: "delivered" as const, label: "Delivered", icon: CheckCircle2, n: delivered.length },
  ];
  const rows = tab === "queue" ? queue : tab === "upcoming" ? upcoming : delivered;
  const dateLabel = tab === "upcoming" ? ("Shoots" as const) : ("Due" as const);
  const empty =
    tab === "queue" ? "Nothing in the queue — new edits appear the moment raws land."
    : tab === "upcoming" ? "No upcoming video shoots on the schedule."
    : "Nothing delivered in the last 60 days.";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
              tab === t.key ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2")}>
            <t.icon className="size-3.5" /> {t.label}
            {t.n > 0 && (
              <span className={cn("rounded-full px-1.5 text-xs font-semibold", tab === t.key ? "bg-white/20" : "bg-surface-2")}>{t.n}</span>
            )}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {rows.map((r) => <Row key={r.id} r={r} dateLabel={dateLabel} />)}
        </ul>
      )}
    </div>
  );
}

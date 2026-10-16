"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, Check, ScrollText } from "lucide-react";
import type { PortalBulkView, PortalBulkItem } from "@/lib/portalBulk";
import type { Word } from "@/lib/portalWords";
import { portalMarkScriptDone } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { Card, Empty, StatusChip } from "@/components/portal/ui";

// ---------------------------------------------------------------------------
// YOUR SESSIONS — a bulk plan in the client portal (Oct 15 2026, Rick
// Schultz: 48 scripts over about six weekly sessions). Every session can be
// opened; the next one to film opens by itself. Each script reads in full and
// has a "Done" tick the client can set and undo. The tick is the client's own
// note — "Filmed", "Being edited" and "Ready" come from our side.
// ---------------------------------------------------------------------------

const WORDS: Record<PortalBulkItem["state"], Word> = {
  to_film: { label: "To film", tone: "muted", icon: "script" },
  marked_done: { label: "You marked it done", tone: "brand", icon: "check" },
  filmed: { label: "Filmed", tone: "success", icon: "filmed" },
  editing: { label: "Being edited", tone: "brand", icon: "production" },
  in_review: { label: "In review", tone: "brand", icon: "review" },
  delivered: { label: "Ready", tone: "success", icon: "delivered" },
};

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) : null;

export function BulkSessions({ d, canAct, readOnly }: { d: PortalBulkView; canAct: boolean; readOnly: boolean }) {
  if (!d.sessions.length) {
    return <Empty icon={ScrollText}>Your scripts are being added. They will show here, grouped by filming session.</Empty>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {d.totals.planned} videos across {d.sessions.length} filming session{d.sessions.length === 1 ? "" : "s"} · {d.totals.filmed} filmed · {d.totals.delivered} ready
      </p>
      <nav aria-label="Sessions" className="flex flex-wrap gap-2">
        {d.sessions.map((s) => (
          <a
            key={s.no}
            href={`#session-${s.no}`}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${s.no === d.focusSessionNo ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-foreground hover:border-brand/40"}`}
          >
            Session {s.no}
            <span className="text-xs text-muted">{s.done}/{s.items.length}</span>
          </a>
        ))}
      </nav>
      {d.sessions.map((s) => (
        <details key={s.no} id={`session-${s.no}`} open={s.no === d.focusSessionNo} className="group scroll-mt-20 rounded-2xl border border-border bg-surface/70">
          <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            <span className="flex items-center gap-2 text-base font-semibold">
              <CalendarCheck aria-hidden className="size-4 text-brand" />
              Session {s.no}
              {s.dateISO && <span className="text-sm font-normal text-muted">· {s.booked ? "" : "planned for "}{fmtDay(s.dateISO)}</span>}
            </span>
            <span className="text-xs text-muted">{s.done} of {s.items.length} done{s.no === d.focusSessionNo ? " · up next" : ""}</span>
          </summary>
          <ol className="space-y-3 px-3 pb-4 sm:px-4">
            {s.items.map((x) => (
              <li key={`${s.no}-${x.no}`}>
                <ScriptCard x={x} canAct={canAct && !readOnly} />
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

function ScriptCard({ x, canAct }: { x: PortalBulkItem; canAct: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  // Only the client's own tick can be undone here; filmed and later are ours.
  const ours = x.state !== "to_film" && x.state !== "marked_done";
  const toggle = () =>
    start(async () => {
      if (!x.scriptId) return;
      const r = await portalMarkScriptDone(portalAuthFromLocation(), x.scriptId, !x.markedDone).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg(r.ok ? null : r.message);
      if (r.ok) router.refresh();
    });
  return (
    <Card className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted">Video {x.no}{x.pillar ? ` · ${x.pillar}` : ""}</p>
          <h3 className="text-base font-semibold leading-snug">{x.title}</h3>
        </div>
        <StatusChip word={WORDS[x.state]} />
      </div>
      {x.body ? (
        <ScriptBody body={x.body} size="sm" />
      ) : (
        <p className="text-sm text-muted">This script will show here once it is ready.</p>
      )}
      {x.captionCta && <p className="text-sm"><span className="font-medium text-muted">Caption: </span>{x.captionCta}</p>}
      {x.scriptId && canAct && !ours && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            aria-pressed={x.markedDone}
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-60 ${x.markedDone ? "border-brand bg-brand text-white" : "border-border bg-surface hover:border-brand/50"}`}
          >
            <Check aria-hidden className="size-4" /> {x.markedDone ? "Done (tap to undo)" : "Mark done"}
          </button>
          {msg && <span role="alert" className="text-sm text-danger">{msg}</span>}
        </div>
      )}
    </Card>
  );
}

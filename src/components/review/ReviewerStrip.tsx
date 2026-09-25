"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hand, Loader2, UserCheck } from "lucide-react";
import { claimCutReview, reassignCutReviewer } from "@/app/review/actions";
import type { ReviewerStripData, ReviewerStripRow } from "./reviewerTypes";

// ---------------------------------------------------------------------------
// WHO IS THIS CUT WAITING ON (unified handoff §8.1, Sep 25 2026).
//
// One line per cut waiting on a verdict, naming the ONE person it waits on —
// James by default, Kyle when James is away or Kyle took it, Jordan last.
// The desk (owner/admin, or a named review seat) gets three small doors:
//   · I'll take it  — put it on your own name
//   · I'll cover it — the same move, offered once the primary has held it past
//                     the covered-hours line; recorded as a cover
//   · Hand to…      — give it to a named person who can rule
// None of them rules on the cut, and a notification never moves it: the row
// this reads is the truth. An editor sees the name only. The server re-checks
// every press (lib/reviewerAssignment); this file is presentation.
// ---------------------------------------------------------------------------

const first = (name: string) => name.split(/\s+/)[0] || name;
const hoursWords = (h: number) => (h < 1 ? "under an hour" : `${Math.floor(h)} covered hour${Math.floor(h) === 1 ? "" : "s"}`);

function Row({ row, data }: { row: ReviewerStripRow; data: ReviewerStripData }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [handTo, setHandTo] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      setMsg(null);
      const r = await fn().catch(() => ({ ok: false, message: "That didn't work — try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  const others = data.candidates.filter((c) => c.id !== row.reviewer?.id && c.canRule);

  return (
    <li className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="min-w-0 truncate font-medium">{row.label}</span>
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">v{row.round}</span>
        <span className="text-muted">·</span>
        {row.reviewer ? (
          <span className={row.mine ? "font-semibold text-brand" : "text-foreground/90"}>
            {row.mine ? "Waiting on you" : `With ${first(row.reviewer.name)}`}
          </span>
        ) : (
          <span className="text-warning">Nobody holds it yet — the office</span>
        )}
        {row.reviewer && <span className="text-xs text-muted-2">{hoursWords(row.coveredHours)}</span>}
        {row.role === "COVER" && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">covering</span>}
      </div>

      {data.canRule && !row.mine && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {data.viewerTeamMemberId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => claimCutReview(row.submissionId, { cover: row.coverOffered }))}
              className={
                row.coverOffered
                  ? "inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
                  : "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
              }
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Hand className="size-3.5" />}
              {row.coverOffered ? "I'll cover it" : "I'll take it"}
            </button>
          )}
          {others.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <select
                value={handTo}
                onChange={(e) => setHandTo(e.target.value)}
                disabled={busy}
                aria-label="Hand this cut to"
                className="rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand disabled:opacity-50"
              >
                <option value="">Hand to…</option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.awayUntil ? " (away)" : ""}
                  </option>
                ))}
              </select>
              {handTo && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => reassignCutReviewer(row.submissionId, handTo))}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
                >
                  Hand it over
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {row.coverOffered && data.canRule && !row.mine && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
          {row.reviewer ? first(row.reviewer.name) : "The reviewer"} hasn&rsquo;t got to it in {data.coverOfferHours} covered
          hours — approve it or send it back in the Review Room; you don&rsquo;t need to take it first.
        </p>
      )}
      {msg && <p className={`mt-1.5 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </li>
  );
}

export function ReviewerStrip({ data }: { data: ReviewerStripData }) {
  if (data.rows.length === 0) return null;
  return (
    <section id="cut-reviewer" className="scroll-mt-20 rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <UserCheck className="size-4 text-brand" />
        <h3 className="text-sm font-semibold">Who&rsquo;s reviewing</h3>
        <span className="text-[11px] text-muted-2">· whose it is first — anyone on the desk can rule in the Review Room</span>
      </div>
      <ul className="mt-2 space-y-2">
        {data.rows.map((r) => (
          <Row key={r.submissionId} row={r} data={data} />
        ))}
      </ul>
    </section>
  );
}

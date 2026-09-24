import Link from "next/link";
import { CalendarClock, Clapperboard, Eye, EyeOff, Film, Layers } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { decideRevisionFeeForm, holdReviewWindowForm, restartReviewClockForm } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// CONTENT — the shared video library, seen with STAFF permissions (spec §17).
//
// The point of the tab is the second column: for every video, what the CLIENT
// has actually been shown. Staff see all the rounds, including cuts that never
// left the building and cuts that were withdrawn; the client's view is the
// subset that was released to them, and a video with internal rounds and no
// release says exactly that rather than looking finished.
//
// The counts here are library counts. When the library has no rows but the
// pipeline does, the panel says so instead of rendering an empty page.
// ---------------------------------------------------------------------------

export type LibraryCutUi = {
  id: string; round: number; slot: number; status: string; fileName: string | null; submittedBy: string | null;
  createdAtISO: string; decidedAtISO: string | null; decidedBy: string | null; releasedToClientAtISO: string | null;
  withdrawn: boolean; note: string | null; clientDecision: string | null;
};
/** One client review window (CP-02): a released version's deadline and what became of it. */
export type LibraryWindowUi = {
  id: string; submissionId: string; round: number; state: string; source: string;
  openedAtISO: string; deadlineISO: string; originalDeadlineISO: string | null; restartedBy: string | null;
  notifiedAtISO: string | null; viewedAtISO: string | null; heldReason: string | null;
  expiryOutcome: string | null; closedReason: string | null; evidence: string | null; decidedBy: string | null;
};
/** One revision round on the per-video ledger. `feeCents` is null unless the
 *  viewer is OWNER/ADMIN — the fee never reaches anyone else's screen. */
export type LibraryRoundUi = {
  id: string; ordinal: number; included: boolean; includedRounds: number; state: string; requestedBy: string | null; createdAtISO: string;
  feeAckBy: string | null; feeAckAtISO: string | null; feeDecision: string | null; feeDecidedBy: string | null; feeCents: number | null;
  lateOverrideBy: string | null; answeredAtISO: string | null;
};
export type LibraryVideoUi = {
  id: string; title: string; monthKey: string | null; kind: string; countsTowardAllowance: boolean; status: string;
  format: string | null; pillarName: string | null; filmedAtISO: string | null; deliveredAtISO: string | null;
  releasedAtISO: string | null; postedAtISO: string | null; projectId: string | null; scriptId: string | null; topicId: string | null;
  finalVersionLabel: string | null; source: string;
  sources: { kind: string; isFinal: boolean; label: string | null }[];
  cuts: LibraryCutUi[];
  reviewWindows?: LibraryWindowUi[];
  revisionRounds?: LibraryRoundUi[];
  /** OWNER/ADMIN: may see the fee, charge or waive it, and restart or hold a
   *  client's review clock (the actions behind these refuse anyone else). */
  moneyEyes?: boolean;
};

const day = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);
const when = (isoStr: string | null) => (isoStr ? `${new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET` : null);

const STATUS_TONE: Record<string, string> = {
  PLANNED: "bg-surface-2 text-muted-2", FILMED: "bg-brand-soft text-brand", EDITING: "bg-brand-soft text-brand",
  CLIENT_REVIEW: "bg-[#8b93e6]/20 text-[#8b93e6]", APPROVED: "bg-success/15 text-success", DELIVERED: "bg-success/15 text-success", ARCHIVED: "bg-surface-2 text-muted-2",
};

export function ContentLibraryPanel({
  rows, pipelineOnly, monthLabelText,
}: {
  rows: LibraryVideoUi[];
  pipelineOnly: { id: string; title: string; status: string; monthKey: string | null; shootDateISO: string | null }[];
  monthLabelText: string | null;
}) {
  const released = rows.filter((v) => v.cuts.some((c) => c.releasedToClientAtISO)).length;
  const internalOnly = rows.filter((v) => v.cuts.length > 0 && !v.cuts.some((c) => c.releasedToClientAtISO)).length;

  if (rows.length === 0) {
    return (
      <Section icon={Film} title={monthLabelText ? `Videos — ${monthLabelText}` : "Videos"} flush>
        <div className="px-5 py-5 text-sm">
          <p className="text-muted">No rows in the video library for this client{monthLabelText ? ` in ${monthLabelText}` : ""}.</p>
          {pipelineOnly.length > 0 && (
            <>
              <p className="mt-2 text-warning">
                The pipeline has {pipelineOnly.length} shoot{pipelineOnly.length === 1 ? "" : "s"} attached to their program months. The library has not been built
                for them yet, so this tab cannot show a video history — it is not the same thing as &ldquo;nothing was delivered&rdquo;.
              </p>
              <ul className="mt-2 space-y-1 text-[13px]">
                {pipelineOnly.slice(0, 12).map((p) => (
                  <li key={p.id}>
                    <Link href={`/edit/${p.id}`} className="text-brand hover:underline">{p.title}</Link>
                    <span className="text-muted-2"> · {p.status.toLowerCase()}{p.monthKey ? ` · ${p.monthKey}` : ""}{p.shootDateISO ? ` · ${day(p.shootDateISO)}` : ""}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Section>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="In the library" value={rows.length} />
        <Stat label="Seen by the client" value={released} tone="success" />
        <Stat label="Internal only" value={internalOnly} tone={internalOnly > 0 ? "warning" : undefined} />
      </div>

      <Section
        icon={Clapperboard}
        title={monthLabelText ? `Videos — ${monthLabelText}` : "Every video"}
        count={rows.length}
        flush
        action={<span className="hidden text-[11px] text-muted-2 sm:inline">staff view — all rounds, including what the client never saw</span>}
      >
        <div className="divide-y divide-border">
          {rows.map((v) => {
            const releasedCuts = v.cuts.filter((c) => c.releasedToClientAtISO && !c.withdrawn);
            return (
              <details key={v.id} className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-5 py-3 hover:bg-surface-2/60">
                  <span className="min-w-0 flex-1 basis-40 truncate text-[14px] font-medium">{v.title}</span>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_TONE[v.status] ?? "bg-surface-2 text-muted-2")}>{v.status.toLowerCase().replace(/_/g, " ")}</span>
                  {v.kind !== "PROGRAM" && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted-2">{v.kind.toLowerCase()}</span>}
                  {!v.countsTowardAllowance && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted-2">extra — not against the allowance</span>}
                  <span className="shrink-0 text-[11px] text-muted-2">{v.monthKey ?? "no month"}</span>
                  <span className="shrink-0 text-[11px]">
                    <Layers className="mr-0.5 inline size-3 text-muted-2" />{v.cuts.length} cut{v.cuts.length === 1 ? "" : "s"}
                  </span>
                  <span className={cn("shrink-0 text-[11px]", releasedCuts.length > 0 ? "text-success" : "text-muted-2")}>
                    {releasedCuts.length > 0 ? <><Eye className="mr-0.5 inline size-3" />{releasedCuts.length} released</> : <><EyeOff className="mr-0.5 inline size-3" />never shown to them</>}
                  </span>
                </summary>
                <div className="space-y-2 border-t border-border/70 bg-surface-2/30 px-5 py-3 text-[12px]">
                  <p className="text-muted">
                    {[v.pillarName, v.format, v.filmedAtISO ? `filmed ${day(v.filmedAtISO)}` : null, v.deliveredAtISO ? `delivered ${day(v.deliveredAtISO)}` : null,
                      v.releasedAtISO ? `released ${day(v.releasedAtISO)}` : null, v.postedAtISO ? `they marked it posted ${day(v.postedAtISO)}` : null,
                      `source: ${v.source}`].filter(Boolean).join(" · ")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {v.projectId && <Link href={`/edit/${v.projectId}`} className="rounded-md border border-border px-2 py-0.5 font-medium text-muted hover:bg-surface-2 hover:text-foreground">Editing room</Link>}
                    {v.sources.map((s, i) => <span key={i} className="rounded-md bg-surface-2 px-2 py-0.5 text-muted-2">{s.kind.toLowerCase()}{s.isFinal ? " (final)" : ""}</span>)}
                  </div>
                  {v.cuts.length === 0 ? (
                    <p className="text-muted-2">No cut has been submitted for this video yet.</p>
                  ) : (
                    <table className="w-full text-left">
                      <thead className="text-[10px] uppercase tracking-wide text-muted-2">
                        <tr><th className="py-1 pr-2">Round</th><th className="pr-2">Internal</th><th className="pr-2">Editor</th><th className="pr-2">Client saw it</th><th>Their answer</th></tr>
                      </thead>
                      <tbody>
                        {v.cuts.map((c) => (
                          <tr key={c.id} className={cn("border-t border-border/50", c.withdrawn && "opacity-50")}>
                            <td className="py-1 pr-2 font-medium">v{c.round}{c.slot > 1 ? `·${c.slot}` : ""}{c.withdrawn && " (withdrawn)"}</td>
                            <td className="pr-2">{c.status.toLowerCase().replace(/_/g, " ")}{c.decidedAtISO ? ` ${day(c.decidedAtISO)}` : ""}{c.decidedBy ? ` · ${c.decidedBy}` : ""}</td>
                            <td className="pr-2 text-muted">{c.submittedBy ?? "—"}</td>
                            <td className="pr-2">{c.releasedToClientAtISO ? <span className="text-success">{day(c.releasedToClientAtISO)}</span> : <span className="text-muted-2">no</span>}</td>
                            <td>{c.clientDecision ? <span className={c.clientDecision === "APPROVE" ? "text-success" : "text-warning"}>{c.clientDecision.toLowerCase().replace(/_/g, " ")}</span> : <span className="text-muted-2">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <ClientReview v={v} />
                </div>
              </details>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

const WINDOW_TONE: Record<string, string> = {
  OPEN: "text-brand", CHANGES_REQUESTED: "text-warning", APPROVED: "text-success", AUTO_APPROVED: "text-success", SUPERSEDED: "text-muted-2", REMOVED: "text-muted-2",
};

/**
 * The client's review of this video, staff-side (CP-02): every window — when
 * it opened, its deadline, whether they were told and whether they looked,
 * and how it closed — and every revision round on the ledger. The office's
 * controls live here: restart a client's clock, hold a window from automatic
 * approval, and (OWNER/ADMIN) charge or waive an extra round. Plain forms:
 * nothing on this panel needs the browser to do more than submit.
 */
function ClientReview({ v }: { v: LibraryVideoUi }) {
  const windows = v.reviewWindows ?? [];
  const rounds = v.revisionRounds ?? [];
  if (windows.length === 0 && rounds.length === 0) return null;
  const used = rounds.filter((r) => r.state !== "CANCELLED").length;
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-surface px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
        <CalendarClock className="size-3" /> Client review · rounds used {used}{rounds[0] ? ` of ${rounds[0].includedRounds} included` : ""}
      </p>
      {windows.length > 0 && (
        <ul className="space-y-1">
          {windows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">v{w.round}</span>
              <span className={cn("font-semibold", WINDOW_TONE[w.state] ?? "text-muted")}>{w.state.toLowerCase().replace(/_/g, " ")}</span>
              <span className="text-muted">opened {when(w.openedAtISO)} · due {when(w.deadlineISO)}{w.originalDeadlineISO ? ` (was ${when(w.originalDeadlineISO)}, restarted by ${w.restartedBy ?? "staff"})` : ""}</span>
              <span className="text-muted-2">{w.source === "LAZY" ? "released before windows were recorded" : w.source.toLowerCase()}</span>
              <span className="text-muted-2">{w.notifiedAtISO ? `told ${day(w.notifiedAtISO)}` : "not emailed"} · {w.viewedAtISO ? `opened by them ${day(w.viewedAtISO)}` : "not opened yet"}</span>
              {w.decidedBy && <span className="text-muted">· {w.decidedBy}</span>}
              {w.heldReason && <span className="text-warning">on hold: {w.heldReason}</span>}
              {w.expiryOutcome && <span className="text-muted-2">expiry: {w.expiryOutcome.toLowerCase()}</span>}
              {w.evidence && <span className="basis-full text-[11px] text-muted-2">evidence — {w.evidence}</span>}
              {w.state === "OPEN" && v.moneyEyes && (
                <span className="flex gap-1.5">
                  <form action={restartReviewClockForm}>
                    <input type="hidden" name="windowId" value={w.id} />
                    <button type="submit" className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground">Restart clock</button>
                  </form>
                  <form action={holdReviewWindowForm}>
                    <input type="hidden" name="windowId" value={w.id} />
                    <input type="hidden" name="hold" value={w.heldReason ? "0" : "1"} />
                    <button type="submit" className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground">{w.heldReason ? "Release hold" : "Hold"}</button>
                  </form>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {rounds.length > 0 && (
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-wide text-muted-2">
            <tr><th className="py-1 pr-2">Round</th><th className="pr-2">Asked by</th><th className="pr-2">State</th><th>Extra round</th></tr>
          </thead>
          <tbody>
            {rounds.map((r) => (
              <tr key={r.id} className="border-t border-border/50 align-top">
                <td className="py-1 pr-2 font-medium">{r.ordinal}{r.included ? "" : " (extra)"}</td>
                <td className="pr-2 text-muted">{r.requestedBy ?? "—"} · {day(r.createdAtISO)}{r.lateOverrideBy ? ` · late, let through by ${r.lateOverrideBy}` : ""}</td>
                <td className="pr-2">{r.state.toLowerCase()}{r.answeredAtISO ? ` ${day(r.answeredAtISO)}` : ""}</td>
                <td>
                  {r.included ? <span className="text-muted-2">included</span> : (
                    <span className="space-y-1">
                      <span className="block text-muted">
                        {r.feeAckBy ? `acknowledged by ${r.feeAckBy} ${day(r.feeAckAtISO)}` : "no acknowledgement (policy was off)"}
                        {v.moneyEyes && r.feeCents != null ? ` · $${(r.feeCents / 100).toFixed(0)} may apply` : ""}
                      </span>
                      {r.feeDecision && r.feeDecision !== "PENDING" && <span className="block font-semibold">{r.feeDecision.toLowerCase()}{r.feeDecidedBy ? ` (${r.feeDecidedBy})` : ""}</span>}
                      {r.feeDecision === "PENDING" && v.moneyEyes && (
                        <span className="flex gap-1.5">
                          {(["CHARGE", "WAIVE"] as const).map((d) => (
                            <form key={d} action={decideRevisionFeeForm}>
                              <input type="hidden" name="roundId" value={r.id} />
                              <input type="hidden" name="decision" value={d} />
                              <button type="submit" className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", d === "CHARGE" ? "bg-warning/15 text-warning hover:bg-warning/25" : "border border-border text-muted hover:bg-surface-2")}>{d === "CHARGE" ? "Charge" : "Waive"}</button>
                            </form>
                          ))}
                        </span>
                      )}
                      {r.feeDecision === "PENDING" && !v.moneyEyes && <span className="block text-muted-2">waiting on the office</span>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.moneyEyes && rounds.some((r) => r.feeDecision === "PENDING") && <p className="text-[11px] text-muted-2">Charge records the decision only — the hub bills nothing. Invoice it the usual way.</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface px-3 py-2.5">
      <div className={cn("text-xl font-semibold tracking-tight", tone === "success" && "text-success", tone === "warning" && "text-warning")}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

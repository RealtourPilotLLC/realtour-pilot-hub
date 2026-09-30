import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, AlertTriangle, Send } from "lucide-react";
import type { ReadyBoard } from "@/lib/readyToSend";

type Row = { id: string; label: string; stage: string; detail: string; owner: string; at: string; action: string; href: string; cutHref: string };

function rowsFor(board: ReadyBoard): Row[] {
  return [
    ...board.rendering.map((r) => ({
      id: r.submissionId, label: `${r.street} · ${r.cutLabel} · v${r.round}`,
      stage: r.held ? "1080p held for sound check" : "Finishing 1080p",
      detail: r.says, owner: "Kyle", at: r.approvedAtISO,
      action: r.held ? "Check sound and resolve the held file" : "Watch the render; follow up if stalled",
      href: "/#video-review", cutHref: `/review/${r.projectId}?cut=${r.submissionId}`,
    })),
    ...board.ready.map((r) => ({
      id: r.submissionId, label: `${r.street} · ${r.cutLabel} · v${r.round}`,
      stage: r.monthlyProgram ? "Monthly destination needs confirmation" : "Ready for delivery",
      detail: r.monthlyProgram
        ? `${r.monthlyPortalReleased ? "Portal release is recorded, but client access or the Aryeo copy is unresolved." : "Portal release is still pending."} Keep this delivery open until the route for this job is confirmed. Exact file: ${r.file.fileName}`
        : `${r.file.fileName} · ${r.aryeoUrl ? "Aryeo listing" : "Aryeo destination missing"}`,
      owner: "Kyle", at: r.approvedAtISO,
      action: r.monthlyProgram ? "Confirm portal access and whether Aryeo is required" : "Check the final file, upload and record delivery",
      href: "/#video-review", cutHref: r.reviewHref,
    })),
    ...board.needsFinishing.map((r) => ({
      id: r.submissionId, label: r.street,
      stage: "Delivery recorded; follow-up incomplete", detail: r.why,
      owner: "Kyle", at: r.sentAtISO,
      action: "Reconcile the records; do not upload again", href: "/#video-review",
      cutHref: `/review/${r.projectId}?cut=${r.submissionId}`,
    })),
    ...(board.notTold ?? []).map((r) => ({
      id: r.submissionId, label: `${r.street} · ${r.fileName}`,
      stage: "Delivery recorded; client notification pending", detail: "The video is marked sent, but the client has not been told yet.",
      owner: "Kyle", at: r.sentAtISO,
      action: "Record how the client was notified", href: "/#video-review",
      cutHref: `/review/${r.projectId}?cut=${r.submissionId}`,
    })),
  ];
}

/** Read-only handoff beside creative review. Home owns the delivery controls. */
export function DeliveryExitSummary({ board }: { board: ReadyBoard }) {
  const rows = rowsFor(board);
  const incomplete = board.boardUnavailable || board.followUpChecks?.needsFinishing === null || board.followUpChecks?.notTold === null;
  return (
    <section id="delivery-exit" className="rounded-2xl border border-border bg-surface p-4 sm:p-5" aria-labelledby="delivery-exit-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="delivery-exit-title" className="flex items-center gap-2 text-base font-semibold"><Send className="size-4 text-brand" /> After review: delivery</h2>
          <p className="mt-1 text-sm text-muted">The same delivery work Kyle sees on Home. Each video stays tied to its exact version.</p>
        </div>
        {rows.length > 0 && <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand">{rows.length} waiting</span>}
      </div>
      {incomplete && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Some delivery follow-up could not be checked. Work may still be waiting; check Home again.
      </p>}
      {!rows.length && !incomplete ? (
        <p className="mt-4 text-sm text-muted">No delivery action is currently waiting in this view.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={`${r.stage}-${r.id}`} className="rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-brand">{r.stage}</p>
                  <Link href={r.cutHref} className="mt-0.5 block break-words text-sm font-semibold hover:text-brand">{r.label}</Link>
                </div>
                <span className="shrink-0 text-xs text-muted">{r.owner} · {formatDistanceToNow(new Date(r.at), { addSuffix: true })}</span>
              </div>
              <p className="mt-1 break-words text-xs leading-relaxed text-muted">{r.detail}</p>
              <Link href={r.href} className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:border-brand/50 hover:text-brand">
                {r.action} <ArrowUpRight className="size-3.5 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

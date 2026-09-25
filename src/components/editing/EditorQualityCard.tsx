import Link from "next/link";
import { cn } from "@/lib/utils";
import type { EditorQualityReport, Example } from "@/lib/editorQuality";

// ---------------------------------------------------------------------------
// ONE EDITOR'S REVIEW RESULTS (§8.4). The same card for the editor's own view
// and each editor on the team view — never a table sorted by score. Every
// number carries its n, and below the thin-sample floor it says so instead of
// a percentage. Plain markup, no client code.
// ---------------------------------------------------------------------------

const THIN = "not enough to judge yet";
const hrs = (h: number | null) => (h == null ? "—" : h < 24 ? `${h}h` : `${Math.round((h / 24) * 10) / 10} weekdays`);

function Block({ title, n, children, thin }: { title: string; n: number; children: React.ReactNode; thin?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{title}</p>
        <p className="text-[11px] text-muted-2">n = {n}{thin ? ` · ${THIN}` : ""}</p>
      </div>
      <div className="mt-1.5 text-sm">{children}</div>
    </div>
  );
}

// `own`: the editor reading their own card — the Review Room redirects them,
// so their examples open the job's issue list instead (review fix, Sep 25).
function Examples({ items, own = false }: { items: (Example & { reason?: string })[]; own?: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {items.map((e, i) => (
        <li key={i} className="text-xs text-muted">
          <Link href={own ? e.editHref : e.href} className="text-brand hover:underline">{e.street}</Link> — {e.text}
          {e.reason ? <span className="text-muted-2"> (said: {e.reason})</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function EditorQualityCard({ report, own = false }: { report: EditorQualityReport; own?: boolean }) {
  const fr = report.firstReview;
  const since = new Date(report.fromISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface-2/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{own ? "Your review results" : report.editorName}</h3>
        <p className="text-xs text-muted">Since {since}. Numbers only — nothing here touches pay.</p>
      </div>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <Block title="First review" n={fr.reviewed} thin={fr.thin}>
          <p>
            <span className={cn("text-xl font-semibold tabular-nums", fr.thin && "text-muted")}>{fr.rate == null ? "—" : `${fr.rate}%`}</span>{" "}
            <span className="text-xs text-muted">passed first time · {fr.passed} of {fr.reviewed}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted-2">
            Not counted: {fr.pendingReview} waiting on review · {fr.pendingClassification} waiting on a cause · {fr.replacedBeforeReview} replaced before review
          </p>
          {fr.byProduct.length > 0 && (
            <p className="mt-0.5 text-[11px] text-muted-2">{fr.byProduct.map((p) => `${p.product}: ${p.passed}/${p.reviewed}`).join(" · ")}</p>
          )}
        </Block>
        <Block title="Missed corrections" n={report.missed.asked} thin={report.missed.thin}>
          <p><span className="text-xl font-semibold tabular-nums">{report.missed.count}</span> <span className="text-xs text-muted">earlier asks not fixed in the next version</span></p>
          <Examples items={report.missed.examples} own={own} />
          {report.declaredNotDone.count > 0 && (
            <>
              <p className="mt-1.5 text-[11px] text-muted-2">
                Not counted as missed: {report.declaredNotDone.count} ask{report.declaredNotDone.count === 1 ? "" : "s"} the check said openly
                weren&rsquo;t done yet, with the reason.
              </p>
              <Examples items={report.declaredNotDone.examples} own={own} />
            </>
          )}
        </Block>
        <Block title="Revision turnaround" n={report.turnaround.n} thin={report.turnaround.thin}>
          <p><span className="text-xl font-semibold tabular-nums">{hrs(report.turnaround.medianHours)}</span> <span className="text-xs text-muted">median, ask → next version (weekday hours)</span></p>
          <p className="mt-0.5 text-[11px] text-muted-2">
            Processing (1080p pass): {hrs(report.turnaround.medianProcessingHours)} (n = {report.turnaround.processingN}) · Waiting on assets or feedback:{" "}
            {report.turnaround.waitingOnAssetsHours == null ? "not recorded" : hrs(report.turnaround.waitingOnAssetsHours)} · Client&rsquo;s total wait: {hrs(report.turnaround.medianClientWaitHours)} (n = {report.turnaround.clientWaitN})
          </p>
        </Block>
        <Block title="Found after approval" n={report.clientVisible.n}>
          <p className="text-xs text-muted">
            {report.clientVisible.editingFault} editing · {report.clientVisible.reviewMiss} review miss · {report.clientVisible.unclassified} not classified · {report.clientVisible.other} other cause
          </p>
          <Examples items={report.clientVisible.examples} own={own} />
        </Block>
      </div>
      <div className="mt-2.5">
        <Block title={own ? "What to focus on" : "Recurring issues"} n={report.recurring.n} thin={report.recurring.thin}>
          {report.recurring.groups.length === 0 ? (
            <p className="text-xs text-muted">No confirmed editor-caused issues{report.recurring.n === 0 ? " yet" : ""}.</p>
          ) : (
            <ul className="space-y-2">
              {report.recurring.groups.slice(0, 5).map((g) => (
                <li key={`${g.category}|${g.product}`}>
                  <p className="text-sm"><span className="font-medium">{g.category}</span> <span className="text-xs text-muted">· {g.product} · {g.count}</span></p>
                  <Examples items={g.examples} own={own} />
                </li>
              ))}
            </ul>
          )}
          {report.recurring.weekly.length > 1 && (
            <p className="mt-1.5 text-[11px] text-muted-2">By week: {report.recurring.weekly.map((w) => `${w.weekISO.slice(5)} ${w.count}`).join(" · ")}</p>
          )}
        </Block>
      </div>
      {!own && (
        <div className="mt-2.5">
          <Block title="Review waiting (the reviewer's clock, not the editor's)" n={report.reviewWaiting.n} thin={report.reviewWaiting.thin}>
            {report.reviewWaiting.byReviewer.length === 0 ? (
              <p className="text-xs text-muted">No ruled cuts yet.</p>
            ) : (
              <p className="text-xs text-muted">{report.reviewWaiting.byReviewer.map((r) => `${r.name}: median ${hrs(r.medianHours)} over ${r.n}`).join(" · ")}</p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-2">
              {report.reviewWaiting.pending} waiting now{report.reviewWaiting.oldestPendingHours != null ? ` · oldest ${hrs(report.reviewWaiting.oldestPendingHours)}` : ""}
            </p>
          </Block>
        </div>
      )}
    </section>
  );
}

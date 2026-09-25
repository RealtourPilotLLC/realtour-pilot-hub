import Link from "next/link";
import { Camera, FileWarning, Film } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { Badge } from "@/components/ui/Badge";
import { monthLabel } from "@/lib/contentProgram";
import { PRODUCTION_VIEWS } from "@/lib/contentNav";
import { staffMonthView } from "@/lib/monthProgress";
import { stageMeta } from "@/lib/pipeline";
import { SessionMonthMover } from "@/components/content/MonthControls";
import { SessionsPanel } from "@/components/content/SessionsPanel";
import { ContentLibraryPanel } from "@/components/content/ContentLibraryPanel";
import { loadContentTab, loadRevisionsView, loadSessionsView } from "../workspaceData";
import { MonthHeader, SubNav, type TabCtx } from "./shared";

// ---------------------------------------------------------------------------
// PRODUCTION (UI-02) — what happens once the month is planned: the filming
// sessions (and which topics a person confirmed were filmed at each), the
// videos library, and the revisions in motion. The session list is the one
// month-progress reader's (staffMonthView), unchanged — it moved here from
// the Overview, together with the requests/addresses panel beside it.
// ---------------------------------------------------------------------------

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);

export async function ProductionTab({ ctx, badges }: { ctx: TabCtx; badges: Record<string, number> }) {
  const { id, month, progress, client } = ctx;
  const v = ctx.view ?? "sessions";
  const monthName = monthLabel(month?.monthKey ?? ctx.activeKey);
  const sub = <SubNav id={id} tab="production" current={v} views={PRODUCTION_VIEWS} month={month?.monthKey ?? null} badges={badges} />;

  if (v === "videos") {
    const d = await loadContentTab(id, client.id, null);
    return (
      <div className="space-y-5">
        {sub}
        <ContentLibraryPanel
          rows={d.rows} pipelineOnly={d.pipelineOnly} monthLabelText={null}
          // CP-12: the identity tool, for the roles its actions accept (OWNER/ADMIN).
          identity={ctx.staffEyes ? d.identity : null}
        />
      </div>
    );
  }

  if (v === "revisions") {
    const d = await loadRevisionsView(id);
    const open = d.briefs.filter((b) => b.open);
    const closed = d.briefs.filter((b) => !b.open);
    return (
      <div className="space-y-5">
        {sub}
        <Section icon={FileWarning} title="Revision asks" count={open.length} flush
          action={<span className="text-[11px] text-muted-2">every month · newest first</span>}>
          <div className="divide-y divide-border">
            {open.length === 0 && <p className="px-5 py-3 text-sm text-muted">No open revision asks.</p>}
            {open.map((b) => (
              <Link key={b.id} href={`/edit/${b.projectId}`} className="block px-5 py-2.5 hover:bg-surface-2/60">
                <div className="text-[13px] font-medium">{b.headline}</div>
                <div className="text-[12px] text-muted">
                  {b.projectTitle}{b.monthKey ? ` · ${monthLabel(b.monthKey)}` : ""} · {b.total > 0 ? `${b.done} of ${b.total} done` : "not itemised yet"} · from {b.source.replace(/_/g, " ")} · {fmtDay(b.createdAtISO)}
                </div>
              </Link>
            ))}
          </div>
          {closed.length > 0 && (
            <details className="border-t border-border px-5 py-2 text-[12px] text-muted">
              <summary className="cursor-pointer">{closed.length} finished</summary>
              <ul className="mt-1 space-y-0.5">
                {closed.map((b) => <li key={b.id}><Link href={`/edit/${b.projectId}`} className="hover:underline">{b.headline}</Link> <span className="text-muted-2">· {b.projectTitle}</span></li>)}
              </ul>
            </details>
          )}
        </Section>
        <Section icon={Film} title="Cuts in motion" count={d.cuts.length} flush
          action={<Link href="/review" className="text-[12px] font-medium text-brand hover:underline">Review Room →</Link>}>
          <div className="divide-y divide-border">
            {d.cuts.length === 0 && <p className="px-5 py-3 text-sm text-muted">No cut is waiting on review or back with the editor.</p>}
            {d.cuts.map((c) => (
              <Link key={c.id} href={c.status === "PENDING" ? "/review" : `/edit/${c.projectId}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2/60">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{c.fileName ?? "Cut"} <span className="font-normal text-muted-2">v{c.round}</span></div>
                  <div className="text-[12px] text-muted">{c.projectTitle}{c.monthKey ? ` · ${monthLabel(c.monthKey)}` : ""} · {fmtDay(c.createdAtISO)}</div>
                </div>
                <span className={c.status === "PENDING" ? "shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand" : "shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning"}>
                  {c.status === "PENDING" ? "waiting for review" : "back with the editor"}
                </span>
              </Link>
            ))}
          </div>
        </Section>
      </div>
    );
  }

  // SESSIONS — one row per DISTINCT session from the reader, then the jobs on
  // the month that are not a session at all (listed so Kyle can see them;
  // never counted), then the requests and exact addresses behind them.
  const view = progress ? staffMonthView(progress) : null;
  const { projects } = await loadSessionsView(month ? { id: month.id } : null);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const sessionIds = new Set(view?.sessionRows.map((r) => r.projectId).filter((x): x is string => !!x) ?? []);
  const shells = projects.filter((p) => !sessionIds.has(p.id));
  const monthKeys = ctx.months.map((m) => m.monthKey);
  return (
    <div className="space-y-5">
      {sub}
      <MonthHeader ctx={ctx} tab="production" view="sessions" title={`Sessions — ${monthName}`} />
      {!month ? (
        <p className="text-sm text-muted">No month workspace yet — the hourly sweep creates the current month automatically.</p>
      ) : (
        <>
          <Section icon={Camera} title="Filming sessions" count={view?.sessionsCount ?? `0/${ctx.enrollment.sessionsPerMonth}`} flush>
            <div className="divide-y divide-border">
              {view?.sessionRows.map((r) => {
                const p = r.projectId ? byId.get(r.projectId) ?? null : null;
                const chipTone = r.tone === "success" ? "bg-success/15 text-success" : r.tone === "warning" ? "border border-dashed border-warning/60 text-warning" : "bg-brand/15 text-brand";
                return (
                  <div key={r.key} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <Link href={p ? `/edit/${p.id}` : "#"} className="min-w-0 flex-1 basis-56 hover:text-brand">
                      <div className="truncate text-[15px] font-medium">{r.title}</div>
                      <div className="mt-0.5 text-[13px] text-muted">
                        {r.when}
                        {r.photographer ? ` · ${r.photographer}` : ""}
                        {p && p.pendingReview > 0 ? ` · ${p.pendingReview} in review` : ""}
                        {r.evidence ? ` · ${r.evidence}` : ""}
                      </div>
                      {p && p.topicsPlanned > 0 && (
                        <div className="mt-0.5 text-[12px] text-muted-2">
                          {p.topicsConfirmedHere} of {p.topicsPlanned} topic{p.topicsPlanned === 1 ? "" : "s"} confirmed filmed at this session
                          {p.reportPending && <span className="text-warning"> · filming report {p.reportPending.state.toLowerCase().replace(/_/g, " ")} — confirmation pending</span>}
                        </div>
                      )}
                    </Link>
                    {p && <SessionMonthMover projectId={p.id} currentKey={month.monthKey} monthKeys={monthKeys} />}
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${chipTone}`}>{r.chip}</span>
                  </div>
                );
              })}
              {shells.map((p) => {
                const st = stageMeta(p.status as never);
                return (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <Link href={`/edit/${p.id}`} className="min-w-0 flex-1 basis-56 hover:text-brand">
                      <div className="truncate text-[15px] font-medium">{p.title}</div>
                      <div className="mt-0.5 text-[13px] text-muted">{p.status === "CANCELLED" ? "cancelled — not counted as a session" : "no date and no appointment — not counted as a session"}</div>
                    </Link>
                    <SessionMonthMover projectId={p.id} currentKey={month.monthKey} monthKeys={monthKeys} />
                    <Badge color={st.color} soft={st.soft} className="px-2 py-0.5 text-xs">{st.short}</Badge>
                  </div>
                );
              })}
              {view && view.missing > 0 && (
                <p className="px-5 py-3 text-[13px] text-warning">
                  {view.missing} of {ctx.enrollment.sessionsPerMonth} session{ctx.enrollment.sessionsPerMonth === 1 ? "" : "s"} still to book
                </p>
              )}
              {projects.length === 0 && (view?.sessionRows.length ?? 0) === 0 && (
                <p className="px-5 py-4 text-sm text-muted">
                  Nothing on the calendar for {monthName} yet — when the Aryeo booking lands it attaches here on its own.
                </p>
              )}
            </div>
          </Section>
          {/* CP-04/CP-05: the requests behind these sessions (confirm, decline,
              retry the hub's booking) and each exact address. */}
          <SessionsPanel enrollmentId={id} monthId={month.id} />
        </>
      )}
    </div>
  );
}

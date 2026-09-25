import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity, AlertTriangle, Bell, BrainCircuit, CalendarCheck, CheckCircle2, FileUp, Gauge, Phone, ScrollText,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { cn } from "@/lib/utils";
import { aiRunLedger, aiQuotaUse, failedAutomations, sessionRequestState, reminderLedger, importOverview } from "@/lib/programMonitoring";
import { allAutomations } from "@/lib/programAutomation";
import { transcriptJobsSnapshot } from "@/lib/transcriptJobs";
import { listCallRecords, callReviewQueue } from "@/lib/contentCallRecords";
import { CallReviewQueue } from "@/components/content/CallReviewQueue";
import { deployStamp, lastRunDeploy } from "@/lib/cron";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// AUTOMATION MONITORING (spec §13 · §20 · §24) — the one screen that answers
// "what has the machine been doing, what did it cost, and what has it handed
// back to a person?".
//
// It is deliberately unglamorous and deliberately literal. Where nothing has
// happened it says nothing has happened AND why (almost always: the switch has
// never been turned on), because an empty panel that could mean "healthy" or
// could mean "never ran" is worse than no panel.
// ---------------------------------------------------------------------------
export default async function ContentMonitoringPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content/monitoring");
  if (me && !canAccess(me, "content")) redirect("/");
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();

  const [runs, quota, jobs, calls, queue, sessions, reminders, failures, switches, imports, months, lastSync] = await Promise.all([
    aiRunLedger({ take: 60 }).catch(() => []),
    aiQuotaUse().catch(() => null),
    transcriptJobsSnapshot().catch(() => null),
    listCallRecords({ onlyReview: true, limit: 40 }).catch(() => []),
    callReviewQueue().catch(() => ({ aliases: [], unlinkedTranscripts: [] })),
    sessionRequestState().catch(() => ({ counts: [], stuck: [] })),
    reminderLedger({ take: 60 }).catch(() => []),
    failedAutomations({ sinceDays: 30 }).catch(() => []),
    allAutomations().catch(() => []),
    importOverview().catch(() => ({ batches: [], unapplied: 0 })),
    prisma.contentMonth.findMany({ select: { monthKey: true }, distinct: ["monthKey"], orderBy: { monthKey: "desc" }, take: 18 }).catch(() => []),
    lastRunDeploy("sync").catch(() => null),
  ]);
  // CP-15: which build is answering, and which build the hourly run that wrote
  // most of these rows was. Right after a deploy they differ until the next
  // hour — that is the point of showing both.
  const pageBuild = deployStamp();
  // ContentEnrollment.clientId is a plain ref, so the enrolled clients are
  // resolved in two steps rather than through a relation filter.
  const enrolled = await prisma.contentEnrollment.findMany({ select: { clientId: true } }).catch(() => [] as { clientId: string }[]);
  const clientList = enrolled.length
    ? await prisma.client.findMany({ where: { id: { in: enrolled.map((e) => e.clientId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => [] as { id: string; name: string }[])
    : [];

  const money = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
  const when = (d: Date | null) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const switchOf = (k: string) => switches.find((s) => s.key === k);
  const offNote = (k: string, what: string) => {
    const s = switchOf(k);
    if (!s) return null;
    return s.enabled ? null : <span className="text-muted-2"> · the <code className="rounded bg-surface-2 px-1">{k}</code> switch is {s.missing ? "never configured" : "off"}, so {what}</span>;
  };

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader eyebrow="Content program" title="Automation monitoring" subtitle="what ran, what it cost, and what needs a person" />

      <div className="mx-auto max-w-5xl space-y-6 p-4 pb-16 sm:p-6">
        {/* CP-15: the deployed build, as this page and the last hourly run recorded it. */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>
            This page: <code className="rounded bg-surface-2 px-1">{pageBuild ?? "build not stamped"}</code>
          </span>
          <span>
            Last hourly run:{" "}
            {lastSync ? (
              <>
                <code className="rounded bg-surface-2 px-1">{lastSync.deploy ?? "not stamped"}</code>
                <span className="text-muted-2"> · started {when(lastSync.startedAt)}{lastSync.finishedAt ? "" : " · not finished (running now, or killed)"}</span>
              </>
            ) : (
              <span className="text-muted-2">none recorded</span>
            )}
          </span>
          {pageBuild && lastSync?.deploy && pageBuild !== lastSync.deploy && (
            <span className="text-warning">the hourly run has not run on this build yet</span>
          )}
        </p>

        {/* FAILED AUTOMATIONS — the same list the overview's filter reads. */}
        <Section
          icon={AlertTriangle}
          title="Failed automations"
          count={failures.length}
          tone={failures.length ? "warning" : "default"}
          flush
          action={<Link href="/content?filter=failed_automation" className="text-[12px] font-medium text-brand hover:underline">See the clients →</Link>}
        >
          <div className="divide-y divide-border">
            {failures.length === 0 && (
              <p className="px-5 py-3 text-sm text-success"><CheckCircle2 className="mr-1 inline size-4" />Nothing has recorded a failure in the last 30 days.</p>
            )}
            {failures.map((f) => (
              <div key={`${f.kind}:${f.ref}`} className="px-5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{f.title}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">{f.kind.replace(/_/g, " ")}</span>
                  {f.retryable && <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">can be retried</span>}
                  <span className="ml-auto text-[11px] text-muted-2">{when(f.at)}</span>
                </div>
                <p className="text-muted">{f.error.slice(0, 260)}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* CALL REVIEW QUEUE — unmatched invitees, alias proposals, ambiguous transcripts. */}
        <div id="calls" className="scroll-mt-20">
          <CallReviewQueue
            calls={calls.map((c) => ({
              id: c.id, callType: c.callType, status: c.status, matchState: c.matchState, matchNote: c.matchNote,
              transcriptState: c.transcriptState, scheduledStartISO: c.scheduledStart?.toISOString() ?? null,
              clientName: c.client?.name ?? null, inviteeEmail: c.inviteeEmail, inviteeName: c.inviteeName,
              eventTypeName: c.eventTypeName, targetMonthKey: c.targetMonthKey, lastError: c.lastError,
              candidates: c.candidates, jobs: c.jobs,
              transcripts: c.transcripts.map((t) => ({ id: t.id, title: t.title, sourceUrl: t.sourceUrl, matchState: t.matchState, recordedAtISO: t.recordedAt?.toISOString() ?? null })),
            }))}
            aliases={queue.aliases.map((a) => ({ id: a.id, clientName: a.clientName, email: a.email, source: a.source, createdAtISO: a.createdAt.toISOString() }))}
            unlinked={queue.unlinkedTranscripts.map((u) => ({ id: u.id, title: u.title, sourceUrl: u.sourceUrl, recordedAtISO: u.recordedAt?.toISOString() ?? null, candidates: u.candidates }))}
            clients={clientList}
            monthKeys={months.map((m) => m.monthKey)}
            isOwner={ownerEyes}
          />
        </div>

        {/* TRANSCRIPT JOBS. */}
        <div id="transcripts" className="scroll-mt-20">
          <Section icon={ScrollText} title="Transcript jobs" count={jobs ? jobs.counts.reduce((n, c) => n + c.n, 0) : null} flush>
            <div className="space-y-2 px-5 py-3 text-[13px]">
              {!jobs ? (
                <p className="text-muted">The job queue could not be read.</p>
              ) : (
                <>
                  <p>
                    Driver: <span className={jobs.enabled ? "font-medium text-success" : "font-medium text-muted"}>{jobs.enabled ? "enabled" : "disabled"}</span>
                    {offNote("transcript_jobs", "queued jobs will sit where they are")}
                  </p>
                  <p className="text-muted">
                    Handlers present: {Object.entries(jobs.handlers).map(([k, v]) => `${k}${v ? "" : " (none)"}`).join(" · ")}.
                    A job of a kind with no handler is left QUEUED rather than failed — it is work nobody has written yet, not work that went wrong.
                  </p>
                  {jobs.counts.length === 0 ? (
                    <p className="text-muted">No transcript job has ever been queued.</p>
                  ) : (
                    <p>{jobs.counts.map((c) => `${c.kind} ${c.state.toLowerCase()}: ${c.n}`).join(" · ")}</p>
                  )}
                  {jobs.oldestQueuedAt && <p className="text-warning">Oldest queued job has been waiting since {when(jobs.oldestQueuedAt)}.</p>}
                </>
              )}
            </div>
            {jobs && jobs.recent.length > 0 && (
              <div className="divide-y divide-border border-t border-border">
                {jobs.recent.map((j) => (
                  <div key={j.id} className="flex flex-wrap items-center gap-2 px-5 py-1.5 text-[12px]">
                    <span className="font-medium">{j.kind}</span>
                    <span className={cn(j.state === "FAILED" || j.state === "NEEDS_REVIEW" ? "text-warning" : "text-muted")}>{j.state.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="text-muted-2">attempt {j.attempts}</span>
                    {(j.reviewReason ?? j.lastError) && <span className="min-w-0 flex-1 truncate text-muted-2">{j.reviewReason ?? j.lastError}</span>}
                    <span className="ml-auto text-muted-2">{when(j.updatedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* SESSION REQUESTS. */}
        <div id="sessions" className="scroll-mt-20">
          <Section icon={CalendarCheck} title="Session requests" count={sessions.counts.reduce((n, c) => n + c.n, 0)} flush>
            <div className="px-5 py-3 text-[13px]">
              {sessions.counts.length === 0 ? (
                <p className="text-muted">
                  No session request exists. Sessions are booked by Kyle in Aryeo today
                  {offNote("session_booking", "a client cannot create one from the portal")}.
                </p>
              ) : (
                <p>{sessions.counts.map((c) => `${c.status.toLowerCase().replace(/_/g, " ")}: ${c.n}`).join(" · ")}</p>
              )}
            </div>
            {sessions.stuck.length > 0 && (
              <div className="divide-y divide-border border-t border-border">
                {sessions.stuck.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 px-5 py-1.5 text-[12px]">
                    <span className="font-medium">{s.clientName}</span>
                    <span className="text-muted-2">{s.monthKey ?? "no month"}</span>
                    <span>{s.status.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="text-muted-2">booking {s.bookingState.toLowerCase()} · {s.attempts} attempt{s.attempts === 1 ? "" : "s"}</span>
                    {s.lastError && <span className="min-w-0 flex-1 truncate text-warning">{s.lastError}</span>}
                    <span className="ml-auto text-muted-2">{when(s.updatedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* AI RUNS + QUOTA — owner sees the money. */}
        <div id="ai-runs" className="scroll-mt-20 space-y-4">
          {ownerEyes && quota && (
            <Section icon={Gauge} title="AI spend" flush>
              <div className="px-5 py-3 text-[13px]">
                <p>
                  Today: <span className="font-semibold">{quota.today.runs}</span> run{quota.today.runs === 1 ? "" : "s"}, {money(quota.today.costCents)} ·
                  {" "}This month: <span className="font-semibold">{quota.month.runs}</span> run{quota.month.runs === 1 ? "" : "s"}, {money(quota.month.costCents)}
                </p>
                {quota.byKindMonth.length > 0 && (
                  <p className="mt-1 text-muted">{quota.byKindMonth.map((k) => `${k.kind}: ${k.runs} · ${money(k.costCents)}`).join(" · ")}</p>
                )}
                {quota.quotas.length === 0 ? (
                  <p className="mt-1 text-muted-2">No quota is configured — there is no ceiling on program AI spend other than the switches themselves.</p>
                ) : (
                  <ul className="mt-1 text-muted">
                    {quota.quotas.map((q) => (
                      <li key={q.id}>
                        {q.scope}{q.scopeRef ? ` ${q.scopeRef}` : ""} · {q.period.toLowerCase()} · {q.maxRuns != null ? `${q.maxRuns} runs` : "no run cap"} · {q.maxCostCents != null ? money(q.maxCostCents) : "no cost cap"} · {q.enabled ? "enforced" : "not enforced"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Section>
          )}

          <Section icon={BrainCircuit} title="AI run ledger" count={runs.length} flush
            action={<span className="hidden text-[11px] text-muted-2 sm:inline">every generation, with the prompt and policy version it used</span>}>
            <div className="divide-y divide-border">
              {runs.length === 0 && (
                <p className="px-5 py-3 text-sm text-muted">Nothing has been generated{offNote("ai_runs", "nothing can be")}.</p>
              )}
              {runs.map((r) => (
                <div key={r.id} className="px-5 py-2 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.kind}</span>
                    {r.clientName && <span className="text-muted">{r.clientName}</span>}
                    <span className={cn(r.status === "FAILED" || r.status === "QUOTA_BLOCKED" ? "text-warning" : r.status === "SUCCEEDED" ? "text-success" : "text-muted")}>{r.status.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="rounded bg-surface-2 px-1.5 text-[10px] text-muted-2">{r.disposition.toLowerCase()}</span>
                    {ownerEyes && <span className="text-muted-2">{money(r.costCents)}</span>}
                    <span className="ml-auto text-muted-2">{when(r.createdAt)}</span>
                  </div>
                  <p className="text-muted-2">
                    {[r.promptKey, r.promptVersion ? `prompt ${r.promptVersion}` : null, r.model, r.policyVersionNo != null ? `policy v${r.policyVersionNo}` : null,
                      r.strategyVersionNo != null ? `strategy v${r.strategyVersionNo}` : null, r.inputTokens != null ? `${r.inputTokens}→${r.outputTokens ?? 0} tokens` : null,
                      r.requestedBy].filter(Boolean).join(" · ")}
                  </p>
                  {r.error && <p className="text-warning">{r.error.slice(0, 200)}</p>}
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* REMINDER LEDGER. */}
        <div id="reminders" className="scroll-mt-20">
          <Section icon={Bell} title="Reminder ledger" count={reminders.length} flush>
            <div className="divide-y divide-border">
              {reminders.length === 0 && (
                <p className="px-5 py-3 text-sm text-muted">
                  No reminder row exists — this system has never contacted a client automatically
                  {offNote("reminders", "it will not")}.
                </p>
              )}
              {reminders.map((r) => (
                <div key={r.id} className="px-5 py-2 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.clientName}</span>
                    <span>{r.action.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="text-muted-2">{r.monthKey ?? "—"} · attempt {r.attempt} · {r.channel}</span>
                    <span className={cn(r.state === "SENT" ? "text-success" : r.state === "FAILED" || r.state === "BOUNCED" ? "text-warning" : "text-muted")}>{r.state.toLowerCase()}</span>
                    {r.manual && <span className="rounded bg-surface-2 px-1.5 text-[10px] text-muted-2">sent by hand</span>}
                    <span className="ml-auto text-muted-2">{when(r.sentAt ?? r.createdAt)}</span>
                  </div>
                  {(r.suppressionReason || r.lastError) && (
                    <p className="text-muted-2">{r.suppressionReason ? `suppressed: ${r.suppressionReason.replace(/_/g, " ")}` : ""}{r.lastError ? ` ${r.lastError.slice(0, 160)}` : ""}</p>
                  )}
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* IMPORT BATCHES — the program-wide §14 view. */}
        <div id="imports" className="scroll-mt-20">
          <Section icon={FileUp} title="Imports" count={imports.batches.length} flush
            action={imports.unapplied > 0 ? <span className="text-[12px] font-medium text-warning">{imports.unapplied} previewed, never applied</span> : undefined}>
            <div className="divide-y divide-border">
              {imports.batches.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing has been imported through the tool.</p>}
              {imports.batches.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-2 px-5 py-2 text-[12px]">
                  <span className="font-medium">{b.clientName}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{b.fileName ?? b.id} · {b.kind.toLowerCase()} · {b.items} item{b.items === 1 ? "" : "s"}</span>
                  {b.proposedMonthKey && <span className="text-muted-2">→ {b.proposedMonthKey}</span>}
                  <span className={b.appliedAt ? "text-success" : "text-warning"}>{b.appliedAt ? `applied ${when(b.appliedAt)}${b.appliedBy ? ` by ${b.appliedBy}` : ""}` : "preview only"}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <Activity className="size-3.5" />
          Everything on this page is read from the durable rows the automations leave behind. Nothing here starts work; the switches live in{" "}
          <Link href="/settings#program-automations" className="font-medium text-brand hover:underline">Settings</Link>.
          <Phone className="ml-2 size-3.5" /> Call matching never guesses a client — an ambiguous call waits here for a person.
        </p>
      </div>
    </div>
  );
}

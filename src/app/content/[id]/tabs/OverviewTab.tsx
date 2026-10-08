import Link from "next/link";
import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardCheck, FileText, MessageSquare, Rocket } from "lucide-react";
import { MonthBriefPanel } from "@/components/brief/MonthBriefPanel";
import { Section } from "@/components/ui/Section";
import { MonthJourney, journeyFromOverview, monthJourneyLinks } from "@/components/content/MonthJourney";
import { BlockedChip, SESSION_TONE } from "@/components/content/OverviewRow";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts } from "@/lib/programOverview";
import { progressKey, staffMonthView } from "@/lib/monthProgress";
import { loadOverviewTab } from "../workspaceData";
import { MonthHeader, type TabCtx } from "./shared";
import { CatchUpControl } from "@/components/content/CatchUpControl";
import { monthLabel } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// OVERVIEW (UI-02) — the month at a glance, and nothing to edit.
//
// Everything on it comes from ONE programOverview row for this client-month
// (the enrollment filter), built over the same MonthProgress the shell read —
// so the tracker, the next action, who holds it and when it is due are the
// very words on this client's roster card and table row. The work itself
// lives one click away: every line links to the Plan or Production view that
// holds it. Scripts are approved on Plan › Scripts only (version-exact); the
// Overview's old script list with its own Approve button is gone.
// ---------------------------------------------------------------------------

const fmtDay = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : null;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const ONBOARDING_WORDS: Record<string, string> = {
  NOT_STARTED: "not started", DISCOVERY_BOOKED: "discovery call booked", DISCOVERY_HELD: "discovery call held",
  TRANSCRIPT_PENDING: "waiting on the discovery transcript", STRATEGY_DRAFTED: "strategy drafted — needs review",
  STRATEGY_IN_REVIEW: "strategy in review", STRATEGY_APPROVED: "strategy approved", BANK_GENERATED: "topic bank generated",
};

export async function OverviewTab({ ctx }: { ctx: TabCtx }) {
  const { id, month, progress } = ctx;
  if (!month) {
    return <p className="text-sm text-muted">No month workspace yet — the hourly sweep creates the current month automatically.</p>;
  }
  const given = progress ? new Map([[progressKey(id, month.id, month.monthKey), progress]]) : undefined;
  const { row, onboarding, lastMessage } = await loadOverviewTab(id, month.monthKey, given);
  const view = progress ? staffMonthView(progress) : null;
  const f = row ? overviewFacts(row) : null;
  const owed = row?.production.owed ?? month.videosOwed;
  // Oct 7 2026: "Approve a catch-up session" — owner/admin only, an exception
  // (Oct 8: a missed month is forfeited); shown when this month carries a
  // catch-up, or an earlier month could be caught up here.
  const catchUp = ctx.staffEyes ? await import("@/lib/monthCatchUp").then((m) => m.catchUpPanel(month.id)).catch(() => null) : null;
  const mk = month.monthKey;
  // Oct 8 2026: the client's creative brief for this month — shown for a
  // client who plans their own content, or whenever one is on file.
  const clientPlanned = !!progress?.topics.clientSupplies;
  const brief = await import("@/lib/monthBrief").then(async (m) => m.briefView(await m.monthBrief(month.id), null)).catch(() => null);
  const showBrief = !month.historical && (clientPlanned || (!!brief && (brief.files.length > 0 || !!brief.notes)));
  const planHref = (v: string) => contentHref(id, { tab: "plan", view: v, month: mk });
  const prodHref = (v: string) => contentHref(id, { tab: "production", view: v, month: mk });
  // The roster's "Open the history" / "Open" point at THIS page (ended,
  // skipped and imported months): useful on a card, dead here — the one
  // dominant button reloaded the page it sat on (Sep 24). Words only, then.
  const selfLink = !!row && row.nextAction.href === contentHref(id, { month: mk });

  // What is still to do, and what waits on a decision — each with the view that holds it.
  const work: { text: string; href: string; tone: "us" | "client" | "approval" }[] = [];
  if (row) {
    const w = row.work;
    if (w.strategyReviewNeeded > 0) work.push({ text: `${plural(w.strategyReviewNeeded, "strategy version")} waiting for approval`, href: planHref("strategy"), tone: "approval" });
    if (w.scriptsReviewNeeded > 0) work.push({ text: `${plural(w.scriptsReviewNeeded, "script")} waiting for approval`, href: planHref("scripts"), tone: "approval" });
    if (w.openScriptRequests > 0) work.push({ text: `${plural(w.openScriptRequests, "client script request")} to answer`, href: planHref("scripts"), tone: "us" });
    if (w.scriptsDrafting > 0) work.push({ text: `${plural(w.scriptsDrafting, "script")} still in draft`, href: planHref("scripts"), tone: "us" });
    if (w.topicsNeeded > 0) work.push({ text: `${plural(w.topicsNeeded, "topic")} still to pick`, href: planHref("topics"), tone: "us" });
    if (w.answersOutstanding > 0) work.push({ text: `${plural(w.answersOutstanding, "topic")} waiting on their answers`, href: planHref("topics"), tone: "client" });
    if (row.production.awaitingInternalReview > 0) work.push({ text: `${plural(row.production.awaitingInternalReview, "cut")} waiting in the Review Room`, href: "/review", tone: "approval" });
    if (row.production.clientReview > 0) work.push({ text: `${plural(row.production.clientReview, "cut")} with the client`, href: prodHref("videos"), tone: "client" });
    if (row.session.missing > 0 && row.enrollmentStatus === "ACTIVE") work.push({ text: `${plural(row.session.missing, "session")} still to book`, href: prodHref("sessions"), tone: "us" });
  }

  return (
    <div className="space-y-6">
      <MonthHeader ctx={ctx} tab="overview" withSkip subtitle={`${plural(owed, "video")} this month`} />
      {catchUp && (
        <CatchUpControl
          monthId={catchUp.monthId} monthName={monthLabel(catchUp.monthKey).split(" ")[0]}
          sessionsNow={catchUp.sessionsNow} videosNow={catchUp.videosNow} refusal={catchUp.refusal}
          carrying={catchUp.carrying ? { missedLabel: catchUp.carrying.missedLabel, extraSessions: catchUp.carrying.extraSessions, extraVideos: catchUp.carrying.extraVideos, by: catchUp.carrying.by, at: catchUp.carrying.at, undoRefusal: catchUp.carrying.undoRefusal } : null}
          caughtUpNote={catchUp.caughtUpIn ? `Caught up in ${catchUp.caughtUpIn.targetLabel}${catchUp.caughtUpIn.by ? ` by ${catchUp.caughtUpIn.by}` : ""}${catchUp.caughtUpIn.at ? ` on ${new Date(catchUp.caughtUpIn.at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}: its videos are filmed in ${catchUp.caughtUpIn.targetLabel}'s extra session, so nothing is owed or chased here. To reopen it, undo the catch-up on ${catchUp.caughtUpIn.targetLabel}.` : null}
          options={catchUp.options.map((o) => ({ monthId: o.monthId, label: o.label, videosOwed: o.videosOwed, refusal: o.refusal, forfeited: o.forfeited }))}
          initialPick={ctx.catchupPick ?? null}
        />
      )}

      {/* THE TRACKER and THE ONE NEXT STEP — who holds it and by when. */}
      <div className="panel-shadow rounded-2xl border bg-surface p-4 sm:p-6">
        <div className="mx-auto max-w-2xl">
          {row ? <MonthJourney size="hero" input={journeyFromOverview(row)} hrefs={monthJourneyLinks(row)} contextLabel={`${row.clientName}, ${row.monthName}`} /> : <p className="text-sm text-warning">Couldn&rsquo;t read this month&rsquo;s progress — refresh to try again.</p>}
        </div>
        {view && view.unknownLines.length > 0 && (
          <ul className="mt-5 space-y-1 border-t border-border pt-3 text-[13px] text-muted">
            {view.unknownLines.map((line, i) => (
              <li key={i} className="flex items-start gap-1.5"><span className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-2 text-[10px] font-semibold" aria-hidden>?</span><span>{line}</span></li>
            ))}
          </ul>
        )}
        {row && f && (
          f.deliveredDone && f.blocked === "nobody" ? (
            <p className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-[15px] font-medium text-success">
              <CheckCircle2 className="size-4.5" /> {row.nextAction.text}
            </p>
          ) : (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex items-start gap-2">
                  <BlockedChip blocked={f.blocked} closed={f.closed} />
                  <p className="text-[15px] font-medium">{row.nextAction.text}</p>
                </div>
                <p className="mt-1 text-[12px] text-muted-2">
                  {f.owner} · {f.ownerDuty}{f.dueLabel ? ` · due ${f.dueLabel}` : ""}
                </p>
              </div>
              {!selfLink && (
                <Link href={row.nextAction.href} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90">
                  {row.nextAction.cta}
                </Link>
              )}
            </div>
          )
        )}
      </div>

      {/* THE CLIENT'S CREATIVE BRIEF (Oct 8 2026) — what they planned for this month. */}
      {showBrief && brief && (
        <Section icon={FileText} title={`Creative brief · ${monthLabel(mk).split(" ")[0]}`} action={clientPlanned ? <span className="text-[11px] font-semibold text-brand">Client-planned</span> : undefined}>
          <div id="brief" className="scroll-mt-24">
            {clientPlanned && <p className="mb-2 text-[13px] text-muted">They plan their own videos — no topics or scripts from us. The crew and the editor see this brief on the job.</p>}
            <MonthBriefPanel mode="staff" monthId={month.id} files={brief.files} notes={brief.notes} canEdit={ctx.staffEyes} />
          </div>
        </Section>
      )}

      {/* ONBOARDING — only while the discovery → strategy → bank ladder is still running. */}
      {onboarding && onboarding.status !== "COMPLETE" && onboarding.status !== "WAIVED" && (
        <Section icon={Rocket} title="Onboarding" action={<span className="text-[11px] text-muted-2">{ONBOARDING_WORDS[onboarding.status] ?? onboarding.status.toLowerCase()}</span>}>
          <ul className="space-y-1 text-[13px]">
            <li>Discovery call: {onboarding.call ? `${onboarding.call.status.toLowerCase()}${onboarding.call.scheduledStart ? ` · ${fmtDay(onboarding.call.scheduledStart.toISOString())}` : ""} · transcript ${onboarding.call.transcriptState.toLowerCase()}` : onboarding.discoveryRequired ? "not booked yet" : "not required"}</li>
            <li>Strategy: {onboarding.approved ? `v${onboarding.approved.versionNo} approved${onboarding.approved.releasedAt ? " and released" : ""}` : onboarding.draft ? `v${onboarding.draft.versionNo} drafted — ${onboarding.draft.status.toLowerCase().replace(/_/g, " ")}` : "no draft yet"}
              {" "}<Link href={planHref("strategy")} className="font-medium text-brand hover:underline">Open</Link></li>
            {onboarding.missingItems.length > 0 && <li className="text-warning">Missing: {onboarding.missingItems.slice(0, 6).join(", ")}</li>}
            {onboarding.lastError && <li className="text-warning">Last error: {onboarding.lastError.slice(0, 160)}</li>}
          </ul>
        </Section>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {/* APPOINTMENTS — the call and the filming sessions, read-only here. */}
        <Section icon={CalendarDays} title="Appointments">
          {row ? (
            <div className="space-y-3 text-[13px]">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Strategy call</p>
                <p>{row.planning.requirementWord}{row.strategyCall.atISO ? ` · ${fmtDay(row.strategyCall.atISO)}` : ""} · {(row.strategyCall.status ?? row.planning.callStatus).toLowerCase().replace(/_/g, " ")}</p>
                <p className="text-muted">evidence: {row.strategyCall.evidence ?? "nothing recorded"}</p>
                {row.strategyCall.problem && <p className="text-warning">{row.strategyCall.problem}</p>}
                <Link href={planHref("calls")} className="text-[12px] font-medium text-brand hover:underline">Plan › Calls →</Link>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Filming sessions</p>
                <p className={SESSION_TONE[f!.sessionTone]}>{f!.sessionLabel}{row.session.dateISO ? ` · ${fmtDay(row.session.dateISO)}` : ""}</p>
                {row.session.detail && <p className="text-muted">{row.session.detail}</p>}
                {row.session.requestedCount > 0 && <p className="text-muted-2">{plural(row.session.requestedCount, "request")} on record</p>}
                <Link href={prodHref("sessions")} className="text-[12px] font-medium text-brand hover:underline">Production › Sessions →</Link>
              </div>
            </div>
          ) : <p className="text-sm text-muted">Nothing to read.</p>}
        </Section>

        {/* MISSING WORK & APPROVALS. */}
        <Section icon={ClipboardCheck} title="Missing work & approvals" count={work.length}>
          {work.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[13px] text-success"><CheckCircle2 className="size-4" /> Nothing outstanding on {month ? "this month" : "the program"}.</p>
          ) : (
            <ul className="space-y-1.5 text-[13px]">
              {work.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className={w.tone === "client" ? "mt-0.5 shrink-0 rounded bg-[#8b93e6]/20 px-1.5 text-[10px] font-semibold text-[#8b93e6]" : w.tone === "approval" ? "mt-0.5 shrink-0 rounded bg-brand-soft px-1.5 text-[10px] font-semibold text-brand" : "mt-0.5 shrink-0 rounded bg-warning/15 px-1.5 text-[10px] font-semibold text-warning"}>
                    {w.tone === "client" ? "them" : w.tone === "approval" ? "approve" : "us"}
                  </span>
                  <Link href={w.href} className="hover:text-brand hover:underline">{w.text}</Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* COMMUNICATION — reminders are READ from the ledger (an empty one says so), plus the program conversation. */}
      {row && (
        <Section icon={MessageSquare} title="Communication" action={<Link href={contentHref(id, { tab: "messages" })} className="text-[12px] font-medium text-brand hover:underline">Messages →</Link>}>
          <div className="space-y-1 text-[13px]">
            {row.comms.messagesWaiting > 0 ? (
              <p className="text-warning">{plural(row.comms.messagesWaiting, "client message")} waiting for an answer{row.comms.oldestWaitingAt ? ` since ${fmtDay(row.comms.oldestWaitingAt.toISOString())}` : ""}</p>
            ) : (
              <p className="text-muted">No client message waiting.</p>
            )}
            {lastMessage && (
              <p className="text-muted">
                Last on the thread: <span className="font-medium text-foreground/85">{lastMessage.authorLabel}</span> ({lastMessage.authorKind === "CLIENT" ? "client" : "office"}), {fmtDay(lastMessage.createdAt.toISOString())} — &ldquo;{lastMessage.body.slice(0, 140)}{lastMessage.body.length > 140 ? "…" : ""}&rdquo;
              </p>
            )}
            {row.comms.everSent ? (
              <p>Last reminder: {row.comms.lastAction?.toLowerCase().replace(/_/g, " ")} · {fmtDay(row.comms.lastAt?.toISOString())}</p>
            ) : (
              <p className="text-muted">No reminder has ever been sent for this month.</p>
            )}
            {row.comms.nextEligibleAt && <p className="text-muted">Next reminder eligible {fmtDay(row.comms.nextEligibleAt.toISOString())}</p>}
            {row.comms.failure && <p className="text-warning">A reminder failed: {row.comms.failure.slice(0, 120)}</p>}
          </div>
        </Section>
      )}

      {/* FAILURES — anything automatic that errored on this client. */}
      {row && row.failures.length > 0 && (
        <Section icon={AlertTriangle} title="Failed automation" count={row.failures.length} tone="warning">
          <ul className="space-y-1 text-[13px]">
            {row.failures.slice(0, 6).map((x) => (
              <li key={x.ref}><Link href={x.href} className="font-medium hover:underline">{x.title}</Link> <span className="text-muted-2">— {x.error.slice(0, 120)}</span></li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

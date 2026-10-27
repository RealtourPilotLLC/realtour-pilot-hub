import Link from "next/link";
import { AlertTriangle, CalendarDays, CheckCircle2, FileText, FileUp, Hand, Hourglass, MessageSquare, Rocket } from "lucide-react";
import { MonthBriefPanel } from "@/components/brief/MonthBriefPanel";
import { Section } from "@/components/ui/Section";
import { MonthJourney, journeyFromOverview, monthJourneyLinks } from "@/components/content/MonthJourney";
import { SESSION_TONE } from "@/components/content/OverviewRow";
import { StatusNotes, StatusSentence } from "@/components/content/ClientStatus";
import { SendReminderButton } from "@/components/content/SendReminderButton";
import { bookingReminderLine, clientCallName } from "@/lib/contentStatusLine";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts } from "@/lib/programOverview";
import { progressKey, staffMonthView } from "@/lib/monthProgress";
import { loadOverviewTab } from "../workspaceData";
import { MonthHeader, type TabCtx } from "./shared";
import { CatchUpControl } from "@/components/content/CatchUpControl";
import { LateSessionControl } from "@/components/content/LateSessionControl";
import { MonthPlanningControl } from "@/components/content/MonthPlanningControl";
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
//
// Oct 27 2026 (Jordan: "This could be, like, way cleaner ... One session still
// to book. That's not on us, that's on them."): the hero says who the month
// waits on in one sentence, and the old "Missing work & approvals" list with
// its us/them/approve chips is now two plain lists side by side, "Waiting on
// <client>" and "Waiting on us", from the roster row's own items
// (contentStatusLine.ts). The booking reminder's last send shows with them.
// ---------------------------------------------------------------------------

const fmtDay = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : null;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const REMINDER_WORDS: Record<string, string> = {
  BOOK_SESSION: "book the content session", BOOK_CALL: "book the strategy call", CHOOSE_PATH: "choose a call or written planning",
  COMPLETE_ANSWERS: "answer the topic questions", PICK_TOPICS: "pick the month's topics", REVIEW_WORK: "review the videos",
};

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
  // Oct 13 2026: a month that also films an earlier month's session shows both months' work.
  // The shell read it already (audit D15: hostJourney ran twice per render).
  const view = ctx.pview !== undefined ? ctx.pview : progress ? staffMonthView(progress, await (await import("@/lib/monthProgress")).hostJourney(progress).catch(() => null)) : null;
  const f = row ? overviewFacts(row) : null;
  const owed = row?.production.owed ?? month.videosOwed;
  // Oct 7 2026: "Approve a catch-up session" — owner/admin only, an exception
  // (Oct 8: a missed month is forfeited); shown when this month carries a
  // catch-up, or an earlier month could be caught up here.
  const catchUp = ctx.officeEyes ? await import("@/lib/monthCatchUp").then((m) => m.catchUpPanel(month.id)).catch(() => null) : null;
  // Oct 12 2026: "Bring September's session into October" — owner/admin only,
  // an exception: a planned month's session booked late, nothing moved.
  const late = ctx.officeEyes ? await import("@/lib/monthLateSession").then((m) => m.lateSessionPanel(month.id)).catch(() => null) : null;
  const mk = month.monthKey;
  // Oct 8 2026: the client's creative brief for this month — shown for a
  // client who plans their own content, or whenever one is on file.
  const clientPlanned = !!progress?.topics.clientSupplies;
  const brief = await import("@/lib/monthBrief").then(async (m) => m.briefView(await m.monthBrief(month.id), null)).catch(() => null);
  const showBrief = !month.historical && (clientPlanned || (!!brief && (brief.files.length > 0 || !!brief.notes)));
  const planHref = (v: string) => contentHref(id, { tab: "plan", view: v, month: mk });
  // Oct 12 2026: a call whose transcript is in but nobody has analyzed — the
  // month's call card runs it ("Analyze the call").
  const unanalyzed = (await import("@/lib/callAnalysis").then((m) => m.loadCallTranscripts({ monthId: month.id })).catch(() => []))
    .filter((c) => c.state === "in" || c.state === "failed").length;
  const prodHref = (v: string) => contentHref(id, { tab: "production", view: v, month: mk });
  // Oct 13 2026 (Jordan, "as simple as possible"): internal machinery is not
  // Overview material. Failed automation, an onboarding error and a failed
  // reminder are counted into ONE line that opens Monitoring, where the detail
  // lives; reminder bookkeeping shows only while reminders are switched on.
  const remindersOn = await import("@/lib/programAutomation").then((m) => m.isAutomationEnabled("reminders")).catch(() => false);
  const automationIssues = (row?.failures.length ?? 0)
    + (onboarding && onboarding.status !== "COMPLETE" && onboarding.status !== "WAIVED" && onboarding.lastError ? 1 : 0)
    + (remindersOn && row?.comms.failure ? 1 : 0);
  // The roster's "Open the history" / "Open" point at THIS page (ended,
  // skipped and imported months): useful on a card, dead here — the one
  // dominant button reloaded the page it sat on (Sep 24). Words only, then.
  const selfLink = !!row && row.nextAction.href === contentHref(id, { month: mk });

  // WHO IT WAITS ON (Oct 27 2026): the roster row's items, each linked to the
  // view that holds the work, plus two only this page counts (a call
  // transcript nobody analysed, cuts waiting in the Review Room).
  const ITEM_HREF: Record<string, string> = {
    book_discovery: planHref("strategy"), build_strategy: planHref("strategy"), approve_strategy: planHref("strategy"),
    call_notes: contentHref(id, { tab: "plan", view: "calls", month: mk, anchor: "call" }), book_call: planHref("calls"), choose_path: planHref("calls"),
    reconcile: planHref("topics"), pick_topics: planHref("topics"), answers: planHref("topics"),
    approve_scripts: planHref("scripts"), write_scripts: planHref("scripts"), script_requests: planHref("scripts"),
    confirm_session: prodHref("sessions"), book_session: prodHref("sessions"), confirm_appointment: prodHref("sessions"), confirm_filmed: prodHref("sessions"),
    approve_videos: prodHref("videos"), review_cuts: prodHref("videos"), send_videos: "/", finish_videos: prodHref("videos"),
  };
  const theirs = (row?.waiting.them ?? []).map((x) => ({ key: x.key, text: x.text, href: ITEM_HREF[x.key] ?? contentHref(id, { month: mk }) }));
  const ours = (row?.waiting.us ?? []).map((x) => ({ key: x.key, text: x.text, href: ITEM_HREF[x.key] ?? contentHref(id, { month: mk }) }));
  if (unanalyzed > 0 && !ours.some((x) => x.key === "call_notes")) ours.unshift({ key: "analyze", text: `analyze ${plural(unanalyzed, "call transcript")}`, href: contentHref(id, { tab: "plan", view: "calls", month: mk, anchor: "call" }) });
  if (row && row.production.awaitingInternalReview > 0) ours.push({ key: "review_room", text: `review ${plural(row.production.awaitingInternalReview, "cut")} in the Review Room`, href: "/review" });
  const name = row ? clientCallName(row.clientName) : "the client";
  const bookingWaiting = !!row && row.waiting.them.some((x) => x.key === "book_session");
  const booking = row && bookingWaiting ? bookingReminderLine(row.comms, new Date()) : null;

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
      {late && (
        <LateSessionControl
          monthId={late.monthId} monthName={late.monthName}
          carrying={late.carrying ? {
            lateMonthId: late.carrying.lateMonthId, lateLabel: late.carrying.lateLabel, state: late.carrying.state, filmed: late.carrying.filmed, startsAtISO: late.carrying.startsAtISO,
            scriptsReleased: late.carrying.scriptsReleased, scriptsReady: late.carrying.scriptsReady, scriptsSentOutside: late.carrying.scriptsSentOutside, lateVideosOwed: late.carrying.lateVideosOwed,
            by: late.carrying.by, at: late.carrying.at, undoRefusal: late.carrying.undoRefusal, lateHref: contentHref(id, { month: late.carrying.lateMonthKey }),
            combine: late.carrying.combine,
          } : null}
          options={late.options.map((o) => ({ monthId: o.monthId, label: o.label, refusal: o.refusal, scriptsReleased: o.scriptsReleased }))}
          filmingIn={late.filmingIn ? { hostLabel: late.filmingIn.hostLabel, hostHref: contentHref(id, { month: late.filmingIn.hostMonthKey }), state: late.filmingIn.state, startsAtISO: late.filmingIn.startsAtISO, by: late.filmingIn.by, at: late.filmingIn.at, undoRefusal: late.filmingIn.undoRefusal, combine: late.filmingIn.combine } : null}
          offer={late.offer ? { hostMonthId: late.offer.hostMonthId, hostLabel: late.offer.hostLabel, refusal: late.offer.refusal, scriptsReleased: late.offer.scriptsReleased } : null}
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
              <div className="min-w-0 flex-1 basis-64 space-y-1.5">
                <StatusSentence r={row} size="lg" />
                <StatusNotes r={row} now={new Date()} />
                <p className="text-xs text-muted-2">
                  Next step: {row.nextAction.text.replace(/\s+[—–]\s+/g, ". ")} ({f.owner}{f.dueLabel ? `, due ${f.dueLabel}` : ""})
                </p>
              </div>
              {!selfLink && (
                <Link href={row.nextAction.href} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90">
                  {row.nextAction.cta}
                </Link>
              )}
            </div>
          )
        )}
      </div>

      {/* Oct 12 2026: no scripts on the month yet — the office can upload its own. Owner/admin only. */}
      {ctx.staffEyes && !month.historical && month.status === "OPEN" && !clientPlanned && !progress?.forfeited && progress?.scripts.total === 0 && (
        <Link href={contentHref(id, { tab: "plan", view: "scripts", month: mk, anchor: "upload" })} className="panel-shadow flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-brand/40 bg-surface px-4 py-3 hover:bg-surface-2">
          <FileUp className="size-5 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0 flex-1 basis-56">
            <span className="block text-sm font-semibold">No scripts for {monthLabel(mk).split(" ")[0]} yet</span>
            <span className="block text-[13px] text-muted">Wrote them yourself? Upload this month&rsquo;s scripts — they set the month&rsquo;s topics and go to the client for review.</span>
          </span>
          <span className="text-sm font-semibold text-brand">Upload scripts →</span>
        </Link>
      )}

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
            <li>Discovery call: {onboarding.call ? `${onboarding.call.status.toLowerCase()}${onboarding.call.scheduledStart ? ` · ${fmtDay(onboarding.call.scheduledStart.toISOString())}` : ""} · transcript ${onboarding.call.transcriptState.toLowerCase().replace(/_/g, " ")}` : onboarding.discoveryRequired ? "not booked yet" : "not required"}</li>
            <li>Strategy: {onboarding.approved ? `v${onboarding.approved.versionNo} approved${onboarding.approved.releasedAt ? " and released" : ", not in their portal yet"}` : onboarding.draft ? `v${onboarding.draft.versionNo} drafted — ${onboarding.draft.status.toLowerCase().replace(/_/g, " ")}` : "no draft yet"}
              {" "}<Link href={planHref("strategy")} className="font-medium text-brand hover:underline">Open</Link></li>
            {onboarding.missingItems.length > 0 && <li className="text-warning">Still to confirm for the strategy draft: {onboarding.missingItems.slice(0, 6).join(", ")}</li>}
            {onboarding.status === "BANK_GENERATED" && onboarding.bankToReview > 0 && (
              <li>Last step: review the first topic bank ({onboarding.bankToReview} suggestion{onboarding.bankToReview === 1 ? "" : "s"}){" "}<Link href={planHref("topics")} className="font-medium text-brand hover:underline">Open</Link></li>
            )}
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
                {row.strategyCall.problem && <p className="text-warning">{row.strategyCall.problem}</p>}
                <Link href={planHref("calls")} className="inline-flex min-h-9 items-center text-[12px] font-medium text-brand hover:underline">Plan › Calls →</Link>
                {/* Oct 12 2026: how this month is planned, when the client told us (owner/admin). */}
                {ctx.staffEyes && !month.historical && month.status === "OPEN" && !clientPlanned && !progress?.forfeited && (
                  <MonthPlanningControl
                    monthId={month.id}
                    current={row.planning.planningMode === "CALL" ? "CALL" : row.planning.planningMode === "WRITTEN" ? (month.planningChosenBy?.startsWith("office:") ? "OFFICE" : "TOPICS") : null}
                  />
                )}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Filming sessions</p>
                <p className={SESSION_TONE[f!.sessionTone]}>{f!.sessionLabel}{row.session.dateISO ? ` · ${fmtDay(row.session.dateISO)}` : ""}</p>
                {row.session.detail && <p className="text-muted">{row.session.detail}</p>}
                {row.session.requestedCount > 0 && <p className="text-muted-2">{plural(row.session.requestedCount, "request")} on record</p>}
                <Link href={prodHref("sessions")} className="inline-flex min-h-9 items-center text-[12px] font-medium text-brand hover:underline">Production › Sessions →</Link>
              </div>
            </div>
          ) : <p className="text-sm text-muted">Nothing to read.</p>}
        </Section>

        {/* WHO IT WAITS ON (Oct 27 2026): theirs and ours, never one mixed list. */}
        <div className="space-y-5">
          <Section icon={Hourglass} title={`Waiting on ${name}`} count={theirs.length}>
            {theirs.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {theirs.map((w) => <li key={w.key}><Link href={w.href} className="hover:text-brand hover:underline">{w.text[0].toUpperCase() + w.text.slice(1)}</Link></li>)}
              </ul>
            )}
            {booking && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-xs text-muted">
                <span>{booking.text}</span>
                {ctx.officeEyes && row?.monthId && <SendReminderButton monthId={row.monthId} clientName={row.clientName} />}
              </div>
            )}
          </Section>
          <Section icon={Hand} title="Waiting on us" count={ours.length}>
            {ours.length === 0 ? (
              <p className="flex items-center gap-1.5 text-[13px] text-muted"><CheckCircle2 className="size-4 text-success" /> Nothing on our side.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {ours.map((w) => <li key={w.key} className="flex items-start gap-2"><span aria-hidden className="mt-[0.45em] size-1.5 shrink-0 rounded-full bg-brand" /><Link href={w.href} className="hover:text-brand hover:underline">{w.text[0].toUpperCase() + w.text.slice(1)}</Link></li>)}
              </ul>
            )}
          </Section>
        </div>
      </div>

      {/* COMMUNICATION — reminders are READ from the ledger (an empty one says so), plus the program conversation. */}
      {row && (
        <Section icon={MessageSquare} title="Communication" action={<Link href={contentHref(id, { tab: "messages" })} className="inline-flex min-h-9 items-center text-[12px] font-medium text-brand hover:underline">Messages →</Link>}>
          <div className="space-y-1 text-[13px]">
            {row.comms.messagesWaiting > 0 ? (
              <p className="font-medium text-brand">{plural(row.comms.messagesWaiting, "new client message")} waiting for an answer{row.comms.oldestWaitingAt ? ` since ${fmtDay(row.comms.oldestWaitingAt.toISOString())}` : ""}</p>
            ) : (
              <p className="text-muted">No client message waiting.</p>
            )}
            {lastMessage && (
              <p className="text-muted">
                Last on the thread: <span className="font-medium text-foreground/85">{lastMessage.authorLabel}</span> ({lastMessage.authorKind === "CLIENT" ? "client" : "office"}), {fmtDay(lastMessage.createdAt.toISOString())} — &ldquo;{lastMessage.body.slice(0, 140)}{lastMessage.body.length > 140 ? "…" : ""}&rdquo;
              </p>
            )}
            {remindersOn && (row.comms.everSent ? (
              <p className="text-muted">Last reminder email: {row.comms.lastAction ? REMINDER_WORDS[row.comms.lastAction] ?? row.comms.lastAction.toLowerCase().replace(/_/g, " ") : "a reminder"}, {fmtDay(row.comms.lastAt?.toISOString())}</p>
            ) : (
              <p className="text-muted">No reminder has been sent for this month.</p>
            ))}
          </div>
        </Section>
      )}

      {/* AUTOMATION ISSUES — one line; the detail lives on Monitoring. */}
      {automationIssues > 0 && (
        <Link href="/content/monitoring" className="flex min-h-11 items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-4 py-2 text-[13px] font-medium text-warning hover:bg-warning/10">
          <AlertTriangle className="size-4 shrink-0" aria-hidden /> {plural(automationIssues, "automation issue")} on this client · Monitoring →
        </Link>
      )}
    </div>
  );
}

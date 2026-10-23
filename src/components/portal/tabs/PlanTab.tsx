import Link from "next/link";
import { CheckCheck, ChevronRight, PencilLine, ScrollText } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalInterviewView, PortalStrategyView, PortalTopicsData } from "@/lib/portal";
import { planModel } from "@/lib/portalHome";
import type { PlanView } from "@/lib/portalNav";
import { SCRIPT_WORDS, filmedWords } from "@/lib/portalWords";
import { Card, Empty, LoadFailed, StatusChip, SubNav, fmtShort } from "@/components/portal/ui";
import { TopicBank } from "@/components/portal/TopicBank";
import { InterviewFlow } from "@/components/portal/InterviewFlow";
import { ScriptApprovalCard } from "@/components/portal/ScriptApprovalCard";
import { ScriptThread } from "@/components/portal/ScriptThread";
import { MonthScriptsPdfButton } from "@/components/portal/MonthScriptsPdfButton";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { StrategyTab } from "@/components/portal/tabs/StrategyTab";
import { YourMonth, type YourMonthData } from "@/components/portal/YourMonth";
import type { PortalStrategyGate } from "@/lib/yourMonth";
import { portalMonthHref } from "@/lib/portalScheduling";
import type { PortalBulkView } from "@/lib/portalBulk";
import { BulkSessions } from "@/components/portal/BulkSessions";
import type { PortalScriptUpdate } from "@/lib/scriptRequests";

// ---------------------------------------------------------------------------
// MY PLAN — the v2 layout (UI-01, Sep 24 2026). What used to be one long
// Video Topics page (ideas, this month's picks, interviews and full scripts
// together) plus a separate My Strategy tab, as four clear subviews:
//
//   This month — the month's chosen topics, one next action each, carryovers
//                labelled, the capacity line (TopicBank view="month");
//   Scripts    — every script waiting on the client's read, with the words in
//                front of them and the two answers (ScriptApprovalCard, R1);
//   Topic bank — everything not on a month yet, Suggested first (view="bank");
//   Strategy   — the released strategy (StrategyTab). Since C14 (Oct 13 2026)
//                not in the sub-nav: an old link opens it read-only.
//
// ?iv=<id> opens one topic's questions (InterviewFlow) inside the plan. All
// of it is the shipped data: portalTopics / portalInterview / portalStrategy,
// partitioned by portalHome.planModel — no new query, no new rule.
//
// YOUR MONTH (§6.4 / §11, Sep 25 2026): the page is "Your Month" and its month
// view is the guided plan — route, topics, answers or the call, Book filming
// (or Schedule later), scripts — in components/portal/YourMonth. The counts on
// every subview come from the one planning reader (R01) through planModel.
// ---------------------------------------------------------------------------

export type PlanTabData = {
  view: PlanView;
  topics: PortalTopicsData | null;
  topicsFailed: boolean;
  interview: PortalInterviewView | null;
  interviewFailed: boolean;
  strategy: PortalStrategyView | null;
  strategyFailed: boolean;
  priorities: string[];
  monthKey: string;
  canAct: boolean;
  readOnly: boolean;
  filter: string | undefined;
  /** My Plan's own address for each subview (query-only). */
  hrefs: Record<PlanView, string>;
  /** Oct 8 2026: the client plans their own content — no Scripts or Topic bank views, just the month. */
  clientPlanned?: boolean;
  /** Oct 15 2026: the client is on a bulk plan — Your sessions replaces the month, scripts and bank views. */
  bulk?: PortalBulkView | null;
  /** Oct 20 2026: the months whose scripts are all approved, each as one PDF (Rick's "Download all scripts", for every client). */
  scriptPdfs?: { monthKey: string; label: string; count: number }[];
  /** Oct 20 2026 (audit E1): may approve scripts (the account owner). */
  canApprove?: boolean;
  /** The month view's guided plan: planning, this month's scheduling card and the slots. Absent → the plain month list. */
  yourMonth?: Omit<YourMonthData, "topics" | "readOnly" | "filter" | "hrefs"> | null;
  /** Oct 21 2026 (lib/strategyGate): closed = the Strategy page's empty state shows the discovery call; null = open. */
  strategyGate?: PortalStrategyGate | null;
  /** Oct 22 2026: scripts whose shared version answered their change request (scriptRequests.portalScriptUpdates), by script id. */
  scriptUpdates?: Record<string, PortalScriptUpdate>;
};

export function PlanTab({ d }: { d: PlanTabData }) {
  if (d.interviewFailed) return <div className="mt-6"><LoadFailed what="those questions" /></div>;
  // The questions sit inside the plan; "All topics" goes back to the month they belong to.
  if (d.interview) return <div className="mt-6"><InterviewFlow iv={d.interview} backHref={portalMonthHref(d.hrefs.month, d.interview.monthKey)} canAct={d.canAct && !d.readOnly} /></div>;

  // Oct 15 2026: a bulk plan is planned by us, session by session — one view.
  if (d.bulk && d.view !== "strategy") {
    return (
      <div className="mt-6 space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{d.bulk.title || "Your sessions"}</h1>
          <p className="mt-0.5 text-sm text-muted">Every script, grouped by filming session. Open any session to read ahead, and tick a script once you have filmed it.</p>
        </div>
        <BulkSessions d={d.bulk} canAct={d.canAct} readOnly={d.readOnly} />
      </div>
    );
  }
  const plan = d.topics ? planModel(d.topics, d.monthKey) : null;
  const tabs = [
    { key: "month" as const, label: plan?.month ? `${monthLabel(plan.month.monthKey).split(" ")[0]}` : "This month", short: "Month" },
    { key: "scripts" as const, label: "Scripts", short: "Scripts", count: plan?.scripts.length ?? 0, countLabel: "waiting across all months" },
    { key: "bank" as const, label: "Topic bank", short: "Topics" },
    // Oct 23 2026 (Jordan: "I just don't see Your Strategy anywhere on anyone's
    // portal"): the Strategy tab is back for every client (C14, Oct 13, had
    // hidden it). The strategy gate tells new clients it appears here.
    { key: "strategy" as const, label: "Strategy", short: "Strategy" },
  ].filter((t) => !d.clientPlanned || t.key === "month" || t.key === d.view);
  const intro = {
    month: d.clientPlanned
      ? { title: "Your Month", detail: "You plan the videos. Upload your plan (PDF or Word) and book your filming time whenever suits you." }
      : { title: "Your Month", detail: "Plan this month's videos step by step, then book the filming time that fits." },
    scripts: { title: "Scripts to review", detail: "All program months. Each script shows the month it belongs to and the version waiting for your decision." },
    bank: { title: "Topic bank", detail: "Ideas not yet placed on an open month. Choose one when your monthly plan has room." },
    strategy: { title: "Content strategy", detail: "Your account-wide direction for future topics and videos." },
  }[d.view];
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{intro.title}</h1>
        <p className="mt-0.5 text-sm text-muted">{intro.detail}</p>
      </div>
      <SubNav label="Your Month" items={tabs.map((t) => ({ href: d.hrefs[t.key], label: t.label, short: t.short, active: d.view === t.key, count: t.count, countLabel: t.countLabel }))} />

      {d.view === "strategy" ? (
        <StrategyTab strategy={d.strategy} failed={d.strategyFailed} priorities={d.priorities} monthKey={d.monthKey} gate={d.strategyGate ?? null} />
      ) : d.topicsFailed ? (
        <LoadFailed what="your plan" />
      ) : !d.topics || !plan ? null : d.view === "scripts" ? (
        <ScriptsView plan={plan} canAct={d.canAct} canApprove={!!d.canApprove} readOnly={d.readOnly} monthHref={d.hrefs.month} pdfs={d.scriptPdfs ?? []} updates={d.scriptUpdates ?? {}} />
      ) : d.view === "month" && d.yourMonth ? (
        <YourMonth d={{
          ...d.yourMonth, topics: d.topics, readOnly: d.readOnly, filter: d.filter,
          // A21: "Schedule later" is per session. The filming step books the
          // schedule month's NEXT session, so it reads that session's choice —
          // not the month's first stamp, which on Pro would still say
          // "you chose to schedule later" about session 2 after session 1 was
          // deferred and then booked.
          planning: d.yourMonth.planning && d.yourMonth.schedule
            ? { ...d.yourMonth.planning, deferredAtISO: d.yourMonth.schedule.deferredAtISO }
            : d.yourMonth.planning,
          hrefs: { month: d.hrefs.month, bank: d.hrefs.bank, scripts: d.hrefs.scripts },
        }} />
      ) : (
        <>
          {d.view === "month" && plan.month && (
            <p className="text-sm text-muted">
              {plan.month.selected} of {plan.month.owed} video{plan.month.owed === 1 ? "" : "s"} chosen for {monthLabel(plan.month.monthKey)}
              {plan.month.planning && <> · {plan.month.planning.headline.text}</>}
              {plan.month.selected < plan.month.owed && d.canAct && !d.readOnly && <> · <Link href={d.hrefs.bank} className="font-medium text-brand hover:underline">choose {plan.month.owed - plan.month.selected} more from your bank</Link></>}
            </p>
          )}
          <TopicBank
            key={`${d.view}:${plan.month?.id ?? "none"}`}
            groups={d.topics.groups} months={d.topics.months} archivedCount={d.topics.archivedCount} total={d.topics.total} strategyLabel={d.topics.strategyLabel} videoStyle={d.topics.videoStyle} skitsPerMonth={d.topics.skitsPerMonth}
            canAct={d.canAct} readOnly={d.readOnly} canApprove={!!d.canApprove}
            // The bank opens on what is still to choose from; a filter in the address wins.
            initialFilter={d.view === "bank" ? d.filter ?? "SUGGESTED" : undefined}
            tabHref={d.hrefs.month} view={d.view} initialMonthId={plan.month?.id ?? null} scriptsHref={d.hrefs.scripts}
          />
        </>
      )}
    </div>
  );
}

/** Oct 22 2026: a folded script opens while our reply under it is the last word (for two weeks). */
function freshReply(t: { script: { thread?: { from: string; atISO: string }[] } | null }, now: number = Date.now()): boolean {
  const last = t.script?.thread?.at(-1);
  return !!last && last.from === "office" && now - Date.parse(last.atISO) < 14 * 86_400_000;
}

/** Scripts waiting on the client's read, the words in full, the two answers beside them. */
function ScriptsView({ plan, canAct, canApprove, readOnly, monthHref, pdfs, updates }: { plan: ReturnType<typeof planModel>; canAct: boolean; canApprove: boolean; readOnly: boolean; monthHref: string; pdfs: { monthKey: string; label: string; count: number }[]; updates: Record<string, PortalScriptUpdate> }) {
  // A script answered a moment ago stays a card, in the same keyed list, so
  // the ScriptApprovalCard that sent the answer keeps its result line (Sep 24).
  const just = new Set(plan.justDecided.map((t) => t.id));
  const cards = [...plan.scripts, ...plan.justDecided.filter((t) => !plan.scripts.some((x) => x.id === t.id))];
  const earlier = plan.decidedScripts.filter((t) => !just.has(t.id));
  const approvedEarlier = earlier.filter((t) => t.script?.decision === "APPROVED");
  const otherEarlier = earlier.filter((t) => t.script?.decision !== "APPROVED");
  return (
    <div className="space-y-4">
      {/* Oct 20 2026 (Jordan: "download all the scripts as PDFs once they are
          all approved, just like Rick can"): one PDF per month, offered once
          every script of that month is approved. */}
      {pdfs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pdfs.map((p) => <MonthScriptsPdfButton key={p.monthKey} monthKey={p.monthKey} label={`Download all ${p.label.split(" ")[0]} scripts (PDF, ${p.count})`} />)}
        </div>
      )}
      {cards.length === 0 ? (
        <Empty icon={ScrollText}>
          No scripts are waiting on you. When we share one, it lands here for your read-through. <Link href={monthHref} className="font-medium text-brand hover:underline">See this month&rsquo;s topics</Link>.
        </Empty>
      ) : (
        cards.map((t) => {
          // Oct 22 2026 (Main / Portal-Updated boards): a script waiting on
          // them shows its parts with "Change this part" on each; a version
          // that answered their request says so, with the message on top.
          const actHere = canAct && !readOnly && !!t.script;
          const inline = actHere && !t.script?.decision && !!t.scriptText?.parts;
          const up = t.script ? updates[t.script.id] ?? null : null;
          const fresh = up && !t.script?.decision ? up : null;
          return (
            <section key={t.id} id={`script-${t.id}`} aria-labelledby={`script-title-${t.id}`} className="scroll-mt-24">
              <Card tone="brand">
                {fresh && <p className="text-[11px] font-bold uppercase tracking-wider text-brand">Updated version</p>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <h2 id={`script-title-${t.id}`} className="min-w-0 flex-1 basis-48 break-words text-lg font-semibold">{fresh?.changed.includes("title") ? fresh.title : t.title}</h2>
                  <StatusChip word={t.script?.decision === "APPROVED" ? SCRIPT_WORDS.APPROVED : t.script?.decision ? SCRIPT_WORDS.CHANGES_REQUESTED : SCRIPT_WORDS.AWAITING} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  {t.selection ? `For ${monthLabel(t.selection.monthKey)}` : `No month assigned · ${t.pillarName}`}
                  {fresh ? ` · version ${fresh.versionNo} · from your change on ${fmtShort(fresh.requestedAtISO)}` : t.scriptText?.versionLabel ? ` · script ${t.scriptText.versionLabel}` : ""}
                  {/* Oct 22 2026: a skit is filmed differently, so the script says which it is. */}
                  {t.script?.format === "SKIT" ? " · Skit" : t.script?.format && t.format === "SKIT" ? " · Talking to camera" : ""}
                </p>
                {fresh?.message && (
                  <div className="mt-3 flex gap-2.5 rounded-xl border border-brand/20 bg-brand-soft/30 px-3 py-2.5">
                    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-action text-xs font-bold text-white">{fresh.message.initials}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">{fresh.message.by} · {fmtShort(fresh.message.atISO)}</p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{fresh.message.body}</p>
                    </div>
                  </div>
                )}
                {fresh?.previous && fresh.fromVersionNo != null && (
                  <details className="mt-2 text-sm">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Compare with version {fresh.fromVersionNo}</summary>
                    <div className="mt-1 space-y-1 rounded-xl border border-border bg-surface-2/40 px-3 py-2 text-sm text-muted">
                      {fresh.changed.includes("title") && <p><span className="text-[10.5px] font-bold uppercase tracking-wider">Title</span><br />{fresh.previous.title}</p>}
                      <p><span className="text-[10.5px] font-bold uppercase tracking-wider">Hook</span><br />{fresh.previous.parts.hook}</p>
                      {fresh.previous.parts.points.map((p, i) => <p key={i}><span className="text-[10.5px] font-bold uppercase tracking-wider">Talking point {i + 1}</span><br />{p.text}</p>)}
                      <p><span className="text-[10.5px] font-bold uppercase tracking-wider">Close</span><br />{fresh.previous.parts.close}</p>
                    </div>
                  </details>
                )}
                {t.scriptText && !inline && <div className="mt-3 rounded-xl border border-border bg-surface-2/40 px-4 py-4"><div className="max-w-[70ch]"><ScriptBody body={t.scriptText.body} size="lg" /></div></div>}
                {actHere ? (
                  <div className={inline ? "mt-3" : ""}><ScriptApprovalCard script={t.script!} parts={t.scriptText?.parts ?? null} large canApprove={canApprove} inlineParts={inline} update={fresh} /></div>
                ) : (
                  <p className="mt-2 text-xs text-muted">{readOnly ? "Scripts can’t be approved while your program is paused or ended." : "The program owner approves scripts on this account."}</p>
                )}
              </Card>
            </section>
          );
        })
      )}
      {/* Oct 14 2026: an approved script stays theirs to read, edit and
          download (Jordan: "able to edit the scripts themselves after they
          approve it"), so each one opens to its words and those two buttons. */}
      {approvedEarlier.length > 0 && (
        <section aria-labelledby="approved-scripts" className="space-y-2">
          <h2 id="approved-scripts" className="text-sm font-semibold">Your approved scripts ({approvedEarlier.length})</h2>
          <p className="text-xs text-muted">Open one to read it, change the wording yourself, or download it as a PDF.</p>
          {approvedEarlier.map((t) => (
            <details key={t.id} id={`script-${t.id}`} open={freshReply(t)} className="scroll-mt-24 rounded-2xl border border-border bg-surface/70 p-3 text-sm">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                <span className="min-w-0 flex-1 basis-40 break-words font-medium">{t.title}<span className="ml-1 text-xs font-normal text-muted">· {t.selection ? monthLabel(t.selection.monthKey) : "No month assigned"}{t.scriptText?.versionLabel ? ` · script ${t.scriptText.versionLabel}` : ""}{t.script?.format === "SKIT" ? " · Skit" : ""}</span></span>
                <StatusChip word={SCRIPT_WORDS.APPROVED} />
              </summary>
              {t.scriptText && <div className="mt-2 rounded-xl border border-border bg-surface-2/40 px-4 py-4"><div className="max-w-[70ch]"><ScriptBody body={t.scriptText.body} size="lg" /></div></div>}
              {canAct && !readOnly && t.script && <ScriptApprovalCard script={t.script} parts={t.scriptText?.parts ?? null} large canApprove={canApprove} />}
            </details>
          ))}
        </section>
      )}
      {/* Oct 22 2026 (Jordan): filmed before they approved it. Nothing is
          asked: they can read it and download it, and it says when it was filmed. */}
      {plan.filmedScripts.length > 0 && (
        <section aria-labelledby="filmed-scripts" className="space-y-2">
          <h2 id="filmed-scripts" className="text-sm font-semibold">Filmed ({plan.filmedScripts.length})</h2>
          <p className="text-xs text-muted">We&rsquo;ve filmed these, so there&rsquo;s nothing for you to approve. Open one to read it or download it as a PDF.</p>
          {plan.filmedScripts.map((t) => (
            <details key={t.id} id={`script-${t.id}`} className="scroll-mt-24 rounded-2xl border border-border bg-surface/70 p-3 text-sm">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                <span className="min-w-0 flex-1 basis-40 break-words font-medium">{t.title}<span className="ml-1 text-xs font-normal text-muted">· {t.selection ? monthLabel(t.selection.monthKey) : "No month assigned"}{t.scriptText?.versionLabel ? ` · script ${t.scriptText.versionLabel}` : ""}</span></span>
                <StatusChip word={{ ...SCRIPT_WORDS.FILMED, label: filmedWords(t.script?.filmed?.atISO) }} />
              </summary>
              {t.scriptText && <div className="mt-2 rounded-xl border border-border bg-surface-2/40 px-4 py-4"><div className="max-w-[70ch]"><ScriptBody body={t.scriptText.body} size="lg" /></div></div>}
              {canAct && !readOnly && t.script && <ScriptApprovalCard script={t.script} parts={t.scriptText?.parts ?? null} large canApprove={canApprove} />}
            </details>
          ))}
        </section>
      )}
      {/* Oct 22 2026: each one with its thread (their request, our replies), so a reply
          about a script is read under it, not in Messages. Open while our reply is the last word. */}
      {otherEarlier.length > 0 && (
        <details open={otherEarlier.some((t) => freshReply(t))} className="rounded-2xl border border-border bg-surface/70 p-4 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Scripts you asked us to change ({otherEarlier.length})</summary>
          <ul className="mt-2 space-y-3">
            {otherEarlier.map((t) => (
              <li key={t.id} id={`script-${t.id}`} className="scroll-mt-24">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 basis-40 break-words">{t.title}<span className="ml-1 text-xs text-muted">· {t.selection ? monthLabel(t.selection.monthKey) : "No month assigned"}</span></span>
                  {t.script?.decision === "APPROVED" ? <StatusChip word={SCRIPT_WORDS.APPROVED} /> : <StatusChip word={SCRIPT_WORDS.CHANGES_REQUESTED} />}
                  {t.script?.decidedAtISO && <span className="text-[11px] text-muted-2">{fmtShort(t.script.decidedAtISO)}</span>}
                </div>
                {t.script && <ScriptThread scriptId={t.script.id} items={t.script.thread ?? []} canReply={canAct && !readOnly} large />}
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.monthTopics.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <CheckCheck className="size-3.5" aria-hidden />
          <span>This month: {plan.month ? `${plan.month.selected} of ${plan.month.owed}` : plan.monthTopics.length} topic{(plan.month?.owed ?? plan.monthTopics.length) === 1 ? "" : "s"} chosen.</span>
          <Link href={monthHref} className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">Open the month <ChevronRight className="size-3" aria-hidden /></Link>
          {plan.toAnswer.length > 0 && <span className="inline-flex items-center gap-1"><PencilLine className="size-3" aria-hidden /> {plan.toAnswer.length} still need{plan.toAnswer.length === 1 ? "s" : ""} your answers</span>}
        </p>
      )}
    </div>
  );
}

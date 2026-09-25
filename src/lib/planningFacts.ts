import "server-only";
import { prisma } from "@/lib/prisma";
import { ALLOWANCE_SELECTION_STATUSES } from "@/lib/contentTopics";
import { CONFIDENTIAL_PHRASE_RE, CONFIDENTIAL_RE, confidentialFilter } from "@/lib/clientFacts";
import { deriveMonthState, priorCallHeldFrom, type CallMode, type ProgramDb } from "@/lib/programMonths";
import {
  allowanceOrder, monthPlanning,
  type AllowanceSelection, type AllowanceSlot, type CallState, type MonthPlanning, type PlanningRoute, type TopicPlanFacts,
} from "@/lib/planningState";

// ---------------------------------------------------------------------------
// THE ONE PLANNING READER — the server half (R01, unified handoff Sep 25 2026).
//
// planningState.ts states the rule; this loads the facts it needs for any
// number of months in a fixed number of queries, and every surface asks it:
// portal Home / Your Month / the topic bank (portalTopics, portalPlanning),
// the staff month reader (monthProgress), the filming gate (recalcProgramMonth
// reads monthAllowances) and the drafting sweep (scriptWorkForMonth,
// sweepInterviewPlans). Nothing here writes.
//
// What each fact is, and where it is read from:
//   · the ALLOWANCE — live selections (ALLOWANCE_SELECTION_STATUSES, the one
//     list) plus a topic that points at the month with no live selection (the
//     rows that predate selections; monthProgress has always counted them),
//     ordered by planningState.allowanceOrder. The stored overflow flag is
//     frozen at insert and is not read.
//   · SCRIPTS — this month's hub scripts (non-historical, monthId = month) and
//     historical imports filed against THIS month. An import on another month
//     is someone else's history and cannot hide a new gap. The client's
//     decision is scriptDecisions.currentScriptDecision over the ledger, and
//     "released" is postingKit.scriptVisibility — both called, not restated.
//   · CALL MATERIAL — speaker-tagged client/Jordan lines from THIS month's
//     call: the selection's own evidence, else the newest DISCUSSED event from
//     this month's call (a topic the client picked in the portal and then
//     talked through on the call keeps its excerpts there — contentTopics'
//     KEPT branch). Each line passes the same scrub safeTopicExcerpts applies
//     (clientFacts.confidentialFilter + scrubOtherClients) before it counts,
//     so a confidential-only mention never reads as material.
//   · ROUTE and CALL — deriveMonthState over the month's call records and the
//     enrollment's effective call mode, the same derivation the gate uses.
// ---------------------------------------------------------------------------

/** ContentTopic.status values a legacy month pointer carries (monthProgress's union). */
const TOPIC_ON_MONTH = ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"];
const FOOTAGE_VIDEO_STATUSES = ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"];

export type AllowanceEntry = AllowanceSelection & {
  selectionId: string | null;
  evidenceJson: string | null;
  callRecordId: string | null;
  /** A topic pointer with no live selection row, read as SELECTED. */
  legacy: boolean;
};

export type MonthAllowance = {
  monthId: string;
  videosOwed: number;
  entries: AllowanceEntry[];
  slots: Map<string, AllowanceSlot>;
  chosen: number;
  extras: number;
};

type AllowanceMonth = { id: string; videosOwed: number };

async function allowancesFor(months: AllowanceMonth[], db: ProgramDb): Promise<Map<string, MonthAllowance>> {
  const out = new Map<string, MonthAllowance>();
  if (!months.length) return out;
  const ids = months.map((m) => m.id);
  const [sels, pointers] = await Promise.all([
    db.contentTopicSelection.findMany({
      where: { monthId: { in: ids }, status: { in: ALLOWANCE_SELECTION_STATUSES } },
      select: { id: true, topicId: true, monthId: true, status: true, rank: true, createdAt: true, evidenceJson: true, callRecordId: true },
    }),
    db.contentTopic.findMany({ where: { monthId: { in: ids }, status: { in: TOPIC_ON_MONTH } }, select: { id: true, monthId: true, createdAt: true } }),
  ]);
  for (const m of months) {
    const live = sels.filter((s) => s.monthId === m.id);
    const liveTopics = new Set(live.map((s) => s.topicId));
    const entries: AllowanceEntry[] = [
      ...live.map((s) => ({ topicId: s.topicId, status: s.status, rank: s.rank, createdAt: s.createdAt, selectionId: s.id, evidenceJson: s.evidenceJson, callRecordId: s.callRecordId, legacy: false })),
      ...pointers.filter((t) => t.monthId === m.id && !liveTopics.has(t.id))
        .map((t) => ({ topicId: t.id, status: "SELECTED", rank: null, createdAt: t.createdAt, selectionId: null, evidenceJson: null, callRecordId: null, legacy: true })),
    ];
    const slots = allowanceOrder(entries, m.videosOwed);
    const chosen = [...slots.values()].filter((s) => s === "IN").length;
    out.set(m.id, { monthId: m.id, videosOwed: m.videosOwed, entries, slots, chosen, extras: slots.size - chosen });
  }
  return out;
}

/** Which topics are each month's allowance and which are extras — what the filming gate needs. */
export async function monthAllowances(monthIds: string[], db: ProgramDb = prisma): Promise<Map<string, MonthAllowance>> {
  const ids = [...new Set(monthIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const months = await db.contentMonth.findMany({ where: { id: { in: ids } }, select: { id: true, videosOwed: true } });
  return allowancesFor(months, db);
}

export type MonthPlanningFacts = {
  monthId: string;
  enrollmentId: string;
  clientId: string;
  monthKey: string;
  videosOwed: number;
  historical: boolean;
  route: PlanningRoute;
  call: CallState;
  /** This month's held call has been read (a live monthly record's transcript ANALYZED). */
  callRead: boolean;
  callMode: CallMode;
  /** The written route may be offered (effective call mode OPTIONAL_WRITTEN and not switched off for this client). */
  noCallEligible: boolean;
  chosenAt: Date | null;
  chosenBy: string | null;
  deferredAt: Date | null;
  allowance: MonthAllowance;
  facts: TopicPlanFacts[];
  planning: MonthPlanning;
};

/** Speaker-tagged lines, shape-tolerant (the evidence JSON has two historical shapes, as in topicCallExcerpts). */
function evidenceLines(json: string | null): { speaker: string; text: string }[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as { excerpts?: unknown[] } | unknown[];
    const arr = Array.isArray(v) ? v : Array.isArray(v?.excerpts) ? v.excerpts : [];
    return arr
      .filter((x): x is { speaker?: string; text: string } => !!x && typeof (x as { text?: unknown }).text === "string")
      .map((x) => ({ speaker: x.speaker === "client" || x.speaker === "jordan" ? x.speaker : "third-party", text: x.text.trim() }));
  } catch {
    return [];
  }
}

function storedInterviewReading(json: string | null): { sufficient: boolean | null; missing: number } {
  if (!json) return { sufficient: null, missing: 0 };
  try {
    const v = JSON.parse(json) as { sufficient?: unknown; missing?: unknown; fields?: unknown };
    const missing = Array.isArray(v.missing) && v.missing.length > 0 ? v.missing.length : Array.isArray(v.fields) ? v.fields.length : 0;
    return { sufficient: typeof v.sufficient === "boolean" ? v.sufficient : null, missing };
  } catch {
    return { sufficient: null, missing: 0 };
  }
}

/** confidentialFilter's reading for a client with no confidential fact on file: the two markers. */
export const markedConfidential = (text: string): boolean => CONFIDENTIAL_RE.test(text) || CONFIDENTIAL_PHRASE_RE.test(text);

const callStateOf = (status: string): CallState => (status === "COMPLETED" ? "HELD" : status === "SCHEDULED" ? "BOOKED" : "NONE");

/**
 * The planning facts for any number of months. A month id that does not exist
 * is simply absent from the map — a caller that needs an answer treats that as
 * unknown, never as "nothing planned".
 */
export async function planningFactsForMonths(monthIdsIn: string[], opts: { now?: Date } = {}): Promise<Map<string, MonthPlanningFacts>> {
  const now = opts.now ?? new Date();
  const out = new Map<string, MonthPlanningFacts>();
  const monthIds = [...new Set(monthIdsIn.filter((x) => typeof x === "string" && x.length > 0))];
  if (!monthIds.length) return out;
  const months = await prisma.contentMonth.findMany({
    where: { id: { in: monthIds } },
    select: {
      id: true, enrollmentId: true, clientId: true, monthKey: true, videosOwed: true, historical: true, callRecordId: true,
      strategyCallStatus: true, strategyCallAt: true, transcriptText: true, planningMode: true, preparationStatus: true, preparationCompletedAt: true,
      preparationWindowDays: true, preparationExceptionAt: true, preparationExceptionReason: true, filmingReadyAt: true,
      planningChosenAt: true, planningChosenBy: true, schedulingDeferredAt: true,
    },
  });
  if (!months.length) return out;
  const enrollmentIds = [...new Set(months.map((m) => m.enrollmentId))];
  const clientIds = [...new Set(months.map((m) => m.clientId))];
  const allowances = await allowancesFor(months, prisma);
  const topicIds = [...new Set([...allowances.values()].flatMap((a) => a.entries.map((e) => e.topicId)))];

  // Every read runs whatever the months hold (no skip on an empty list), so
  // the reader costs the same statements for one month or a roster — the
  // monthProgress guard (cp10 §10) measures exactly that.
  const [enrollments, records, priorRecords, completedMonths, topics, interviews, scripts, footage, events] = await Promise.all([
    prisma.contentEnrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, callMode: true, strategyCallRequired: true, noCallEligible: true } }),
    prisma.programCallRecord.findMany({
      where: { monthId: { in: monthIds } },
      select: { id: true, monthId: true, callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
    }),
    prisma.programCallRecord.findMany({
      where: { enrollmentId: { in: enrollmentIds }, callType: "MONTHLY_STRATEGY", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] } },
      select: { enrollmentId: true, monthId: true, callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
    }),
    prisma.contentMonth.findMany({ where: { enrollmentId: { in: enrollmentIds }, strategyCallStatus: "COMPLETED" }, select: { id: true, enrollmentId: true } }),
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true, status: true } }),
    prisma.contentInterview.findMany({ where: { monthId: { in: monthIds }, topicId: { in: topicIds } }, select: { topicId: true, monthId: true, status: true, sufficiencyJson: true } }),
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, topicId: { in: topicIds } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, topicId: true, monthId: true, status: true, historical: true, releaseState: true, sharedVersionId: true },
    }),
    prisma.contentVideo.findMany({ where: { topicId: { in: topicIds }, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { topicId: true } }),
    prisma.contentTopicEvent.findMany({
      where: { topicId: { in: topicIds }, kind: "DISCUSSED", evidenceJson: { contains: '"text"' } },
      orderBy: { createdAt: "desc" },
      select: { topicId: true, monthId: true, sourceRef: true, evidenceJson: true },
    }),
  ]);

  const hub = scripts.filter((s) => !s.historical);
  const sharedIds = [...new Set(hub.map((s) => s.sharedVersionId).filter((x): x is string => !!x))];
  const [{ currentScriptDecision }, { scriptVisibility }, { otherClientScrubbers }, ledger] = await Promise.all([
    import("@/lib/scriptDecisions"),
    import("@/lib/postingKit"),
    import("@/lib/contentGeneration"),
    prisma.contentScriptRelease.findMany({
      where: { scriptId: { in: hub.map((s) => s.id) }, scriptVersionId: { in: sharedIds }, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } },
      select: { id: true, scriptId: true, action: true, createdAt: true, scriptVersionId: true, actorEmail: true },
    }),
  ]);

  const enrollmentOf = new Map(enrollments.map((e) => [e.id, e]));
  const topicOf = new Map(topics.map((t) => [t.id, t]));
  const filmedTopics = new Set(footage.map((v) => v.topicId).filter((x): x is string => !!x));
  for (const t of topics) if (["FILMED", "EDITING", "DELIVERED"].includes(t.status)) filmedTopics.add(t.id);

  // ---- call material, scrubbed once per client --------------------------------
  // The raw candidate lines per (month, topic): client/Jordan speakers, long
  // enough to be a statement (the drafting sweep's old excerptCount floor).
  const rawLines = new Map<string, string[]>();
  const lineKey = (monthId: string, topicId: string) => `${monthId}:${topicId}`;
  for (const m of months) {
    const a = allowances.get(m.id)!;
    const callIds = new Set([...records.filter((r) => r.monthId === m.id).map((r) => r.id), ...(m.callRecordId ? [m.callRecordId] : [])]);
    const fromThisCall = (ref: string | null) => !!ref && (callIds.has(ref) || (ref.startsWith("ProgramCallRecord:") && callIds.has(ref.slice("ProgramCallRecord:".length))));
    for (const e of a.entries) {
      let lines = evidenceLines(e.evidenceJson);
      if (!lines.length) {
        const ev = events.find((x) => x.topicId === e.topicId && (x.monthId === m.id || fromThisCall(x.sourceRef)));
        lines = evidenceLines(ev?.evidenceJson ?? null);
      }
      const usable = lines.filter((l) => l.speaker !== "third-party" && l.text.length > 20).map((l) => l.text);
      if (usable.length) rawLines.set(lineKey(m.id, e.topicId), usable);
    }
  }
  // Batched so a roster costs the same handful of queries as one month (the
  // monthProgress guard): one read says which clients hold confidential facts
  // at all, one pair loads every other-client name. A client with no
  // confidential fact has nothing for confidentialFilter to overlap, so its
  // test is exactly the two markers; one with facts goes through
  // confidentialFilter itself (b2-planning holds the two readings equal).
  const keptByClient = new Map<string, Set<string>>();
  const textsOf = (clientId: string) => [...new Set(months.filter((m) => m.clientId === clientId).flatMap((m) => allowances.get(m.id)!.entries.flatMap((e) => rawLines.get(lineKey(m.id, e.topicId)) ?? [])))];
  const speaking = clientIds.filter((id) => textsOf(id).length > 0);
  if (speaking.length) {
    const [secretHolders, scrubbers] = await Promise.all([
      prisma.clientFact.groupBy({ by: ["clientId"], where: { clientId: { in: speaking }, confidential: true } }).then((rows) => new Set(rows.map((r) => r.clientId))),
      otherClientScrubbers(speaking),
    ]);
    for (const clientId of speaking) {
      const secret = secretHolders.has(clientId) ? await confidentialFilter(clientId) : markedConfidential;
      const cleared = textsOf(clientId).filter((t) => !secret(t));
      keptByClient.set(clientId, new Set(scrubbers.get(clientId)?.(cleared) ?? []));
    }
  }

  for (const m of months) {
    const e = enrollmentOf.get(m.enrollmentId);
    const allowance = allowances.get(m.id)!;
    if (!e) continue;
    const monthRecords = records.filter((r) => r.monthId === m.id);
    const priorCallHeld = priorCallHeldFrom(
      m.id,
      priorRecords.filter((r) => r.enrollmentId === m.enrollmentId),
      completedMonths.filter((x) => x.enrollmentId === m.enrollmentId).map((x) => x.id),
      now,
    );
    // Route and call from the SAME derivation the gate uses. Neither depends on
    // scripts, interviews or topics, so the month-only input is exact.
    const d = deriveMonthState({ now, month: m, enrollment: { ...e, priorCallHeld }, records: monthRecords, scripts: [], interviews: [] });
    const route = d.planningMode as PlanningRoute;
    const call = callStateOf(d.strategyCallStatus);
    // "Held" is not "read": a record counts as held the moment its end passes,
    // and a pasted transcript keeps a stored COMPLETED, but only an ANALYZED
    // transcript says which topics the call actually covered. Until then a
    // topic with no excerpts is unread material, not a gap to put to the
    // client (planningState.topicPlanStep). Same live-record filter as
    // deriveMonthState's.
    const callRead = call === "HELD" && monthRecords.some((r) =>
      r.callType === "MONTHLY_STRATEGY" && r.transcriptState === "ANALYZED" &&
      (r.matchState === "MATCHED" || r.matchState === "CONFIRMED_BY_STAFF" || r.matchState === "AMBIGUOUS_CLIENT") &&
      r.status !== "CANCELLED" && r.status !== "RESCHEDULED");
    const kept = keptByClient.get(m.clientId) ?? new Set<string>();

    const facts: TopicPlanFacts[] = allowance.entries.map((entry) => {
      const t = topicOf.get(entry.topicId);
      const iv = interviews.find((x) => x.topicId === entry.topicId && x.monthId === m.id) ?? null;
      const reading = storedInterviewReading(iv?.sufficiencyJson ?? null);
      const hubScript = scripts.find((s) => s.topicId === entry.topicId && s.monthId === m.id && !s.historical) ?? null;
      const imported = scripts.some((s) => s.topicId === entry.topicId && s.monthId === m.id && s.historical);
      const decision = hubScript?.sharedVersionId
        ? currentScriptDecision(hubScript.sharedVersionId, ledger.filter((r) => r.scriptId === hubScript.id)).decision
        : null;
      return {
        topicId: entry.topicId,
        title: t?.title ?? null,
        selectionStatus: entry.status,
        rank: entry.rank ?? null,
        selectedAt: entry.createdAt ?? null,
        filmed: filmedTopics.has(entry.topicId),
        script: hubScript || imported
          ? {
              importedHere: imported,
              hubScript: !!hubScript,
              released: !!hubScript && scriptVisibility(hubScript) === "released",
              decidable: !!hubScript?.sharedVersionId,
              decision,
            }
          : null,
        interview: iv ? { status: iv.status, missing: reading.missing, sufficient: reading.sufficient } : null,
        callExcerpts: (rawLines.get(lineKey(m.id, entry.topicId)) ?? []).filter((l) => kept.has(l)).length,
      };
    });

    out.set(m.id, {
      monthId: m.id, enrollmentId: m.enrollmentId, clientId: m.clientId, monthKey: m.monthKey, videosOwed: m.videosOwed, historical: m.historical,
      route, call, callRead, callMode: d.callMode,
      noCallEligible: d.callMode === "OPTIONAL_WRITTEN" && e.noCallEligible !== false,
      chosenAt: m.planningChosenAt, chosenBy: m.planningChosenBy, deferredAt: m.schedulingDeferredAt,
      allowance, facts,
      planning: monthPlanning(facts, { route, call, videosOwed: m.videosOwed, callRead }),
    });
  }
  return out;
}

/** One month's planning, or null when the month does not exist. */
export async function planningForMonth(monthId: string, opts: { now?: Date } = {}): Promise<MonthPlanningFacts | null> {
  return (await planningFactsForMonths([monthId], opts)).get(monthId) ?? null;
}

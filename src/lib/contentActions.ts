import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { contentHref } from "@/lib/contentNav";
import type { ScriptReadiness } from "@/lib/contentDrafting";
import type { MonthProgress } from "@/lib/monthProgress";
import type { PlanStep } from "@/lib/planningState";
import { monthStarted, monthTouched } from "@/lib/forfeit";

// ---------------------------------------------------------------------------
// MONTHLY CONTENT: WHAT NEEDS YOU, ON THE DASHBOARD (Oct 20 2026). Jordan:
// "I need to make sure we are able to see the scripts that need scripting",
// then, on seeing one line per script: "it can just say Ashley Brunner -
// October - Needs 4 Scripts, etc. I want it to be an update thing where I can
// see what actions are needed from me for the monthly content, whether its
// topics, or messages, etc."
//
// ONE ROW PER CLIENT AND MONTH (this month and next, real clients, live
// programs), each with the actions the office owes on it, in a few words:
//   · topics   — the month's next step when it is ours: pick the topics, keep
//                or drop the ones the call proposed (monthProgress.nextAction);
//   · scripts  — videos with no script that need a person (nothing to draft
//                from, thin answers, an unsettled plan; never one the hub
//                drafts itself, never a client who writes their own), drafts
//                waiting on an OK, the client's change requests and
//                suggestions on shared scripts;
//   · messages — the client's portal messages nobody has answered;
//   · strategy — a strategy draft to approve, suggested changes to review,
//                topic ideas the client suggested.
// An EARLIER open month joins when a script on it waits on an OK or a client
// request (audit D10), with only those items. Reads only; no model call.
//
// NEXT MONTH (Oct 21 2026) is made early so clients can get ahead
// (contentProgram.ensureNextMonths). Until its 1st it joins the card only once
// the client has done something on it (topics chosen, answers, a script, a
// session or call booked: forfeit.monthTouched); an untouched next month
// stays quiet.
//
// THE MONTH PAGE IS THE SOURCE OF TRUTH (Oct 22 2026, audit M5). The card
// reads the month page's own reader (monthProgress) and must never say
// something that page does not:
//   · "Needs N scripts" counts a topic only when the month page puts it on
//     our side. A topic whose step is the client's (choose the route, answer
//     the questions, fill a gap) or the call's is not a script we owe yet:
//     Ashley Brunner's October read "Needs 4 scripts" while her month page
//     said she had not chosen how to plan it.
//   · scripts to approve: the month page's two counts (in review, drafts) in
//     its own words (monthProgress.scriptsAwaitingWords).
//   · a FINISHED month (every video owed delivered: staffMonthView's
//     deliveredDone) is off the card; leftover drafts on it are not work.
// ---------------------------------------------------------------------------

export type ActionItem = { key: string; words: string; tone: "warn" | "brand" | "muted"; href: string };
export type ContentActionRow = { key: string; clientName: string; monthKey: string; href: string; items: ActionItem[] };
export type ContentActions = { rows: ContentActionRow[] };

const NEEDS_A_PERSON: ReadonlySet<ScriptReadiness> = new Set<ScriptReadiness>(["THIN", "THIN_ANSWERS", "WAITING_ON_PLANNING"]);
/**
 * A topic at one of these steps (the planning reader's, as the month page
 * shows them) waits on the client or on the call, not on us: the route is
 * not chosen (CHOSEN), the answers are theirs to give (NEEDS_ANSWERS,
 * NEEDS_MORE: the month page says "waiting on their answers"), or the call
 * has not happened (ON_CALL). Audit M5, Oct 22 2026.
 */
export const NOT_OURS_YET: ReadonlySet<PlanStep> = new Set<PlanStep>(["CHOSEN", "NEEDS_ANSWERS", "NEEDS_MORE", "ON_CALL"]);
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The month key `count` months before `key`. */
function monthsBefore(key: string, count: number): string {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) - count;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** How far back an earlier month's waiting approvals and change requests still reach the card. */
const EARLIER_MONTHS = 6;

export async function monthlyContentActions(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<ContentActions> {
  const now = opts.now ?? new Date();
  const thisMonth = etMonthKey(now);
  const keys = [thisMonth, nextMonthKey(thisMonth)];
  const exclude = new Set(opts.excludeClientIds ?? []);
  const notExcluded = exclude.size ? { clientId: { notIn: [...exclude] } } : {};
  // Oct 20 2026 (audit D10): an OPEN month only (a skipped or imported month
  // owes nothing), on an ACTIVE program (a paused or ended client is not
  // chased for scripts). And an EARLIER open month reaches the card too when
  // something on it waits on the office: a script to approve or the client's
  // change request (a late session, a catch-up, last month's scripts
  // changed). Only its approvals and requests show, never its topics or
  // missing scripts.
  const [months, earlier] = await Promise.all([
    prisma.contentMonth.findMany({
      where: { historical: false, status: "OPEN", monthKey: { in: keys }, ...notExcluded },
      orderBy: { monthKey: "asc" },
      select: { id: true, monthKey: true, enrollmentId: true, clientId: true },
    }),
    prisma.contentMonth.findMany({
      where: { historical: false, status: "OPEN", monthKey: { lt: thisMonth, gte: monthsBefore(thisMonth, EARLIER_MONTHS) }, ...notExcluded },
      orderBy: { monthKey: "asc" },
      select: { id: true, monthKey: true, enrollmentId: true, clientId: true },
    }),
  ]);
  const earlierWaiting = await monthsWithScriptsWaiting(earlier);
  const all = [...earlierWaiting, ...months];
  if (!all.length) return { rows: [] };
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { id: { in: [...new Set(all.map((m) => m.enrollmentId))] }, status: "ACTIVE" },
    select: { id: true, clientId: true, clientSuppliesTopics: true },
  });
  const live = new Map(enrollments.map((e) => [e.id, e]));
  const owed = all.filter((m) => live.has(m.enrollmentId));
  if (!owed.length) return { rows: [] };
  const isEarlier = new Set(earlierWaiting.map((m) => m.id));
  const clientIds = [...new Set(owed.map((m) => m.clientId))];
  const enrollmentIds = [...live.keys()];

  const [{ monthProgressMany, progressKey, staffMonthView, scriptsAwaitingWords }, { scriptWorkForMonth }, { strategyAwaitingCounts }] = await Promise.all([
    import("@/lib/monthProgress"),
    import("@/lib/contentDrafting"),
    import("@/lib/contentStrategy"),
  ]);
  const [progress, clients, strategiesWaiting, proposals, clientTopics, messages] = await Promise.all([
    monthProgressMany(owed.map((m) => ({ enrollmentId: m.enrollmentId, monthId: m.id, monthKey: m.monthKey })), { now, owners: true }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    // Oct 20 2026 (audit D4): the one "waiting for approval" rule (DRAFT or
    // INTERNAL_REVIEW, newer than the version in force). This card counted
    // only DRAFT; the Plan badge and the roster only INTERNAL_REVIEW.
    strategyAwaitingCounts(enrollmentIds),
    prisma.contentStrategyProposal.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, status: "PROPOSED" }, _count: { _all: true } }),
    prisma.contentTopic.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, source: "client", approvalState: "PROPOSED" }, _count: { _all: true } }),
    // One grouped read (audit D16): programMessages.unansweredCount's rule, for every client at once.
    prisma.programMessage.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, authorKind: "CLIENT", handledAt: null }, _count: { _all: true } }),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const countBy = (rows: { enrollmentId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.enrollmentId, r._count._all]));
  const changes = countBy(proposals), ideas = countBy(clientTopics), waiting = countBy(messages);

  // Oct 21 2026: next month before its 1st, untouched, is quiet (read off the same progress).
  const quiet = new Set(owed.filter((m) => !monthStarted(m.monthKey, now) && !progressTouched(progress.get(progressKey(m.enrollmentId, m.id, m.monthKey)))).map((m) => m.id));
  // Oct 22 2026 (audit M5): a month the month page calls finished (every
  // video owed delivered) carries nothing; its leftover drafts are not work.
  const finished = new Set(owed.filter((m) => {
    const p = progress.get(progressKey(m.enrollmentId, m.id, m.monthKey));
    return !!p && staffMonthView(p).deliveredDone;
  }).map((m) => m.id));
  // Videos that need a person to get a script, per month (six months at a
  // time): this month and next only, and never a month the reader mutes
  // (skipped, imported or forfeited: nothing is owed on it).
  const needScript = new Map<string, number>();
  const toCheck = owed.filter((m) => !isEarlier.has(m.id) && !quiet.has(m.id) && !finished.has(m.id) && !live.get(m.enrollmentId)?.clientSuppliesTopics && !progress.get(progressKey(m.enrollmentId, m.id, m.monthKey))?.muted);
  for (let i = 0; i < toCheck.length; i += 6) {
    await Promise.all(toCheck.slice(i, i + 6).map(async (m) => {
      const work = await scriptWorkForMonth(m.id).catch(() => []);
      // Audit M5: only a topic the month page puts on our side.
      const stepOf = new Map((progress.get(progressKey(m.enrollmentId, m.id, m.monthKey))?.planning?.topics ?? []).map((t) => [t.topicId, t.step] as const));
      needScript.set(m.id, work.filter((w) => {
        const step = stepOf.get(w.topicId);
        return !w.scriptId && NEEDS_A_PERSON.has(w.readiness) && !(step && NOT_OURS_YET.has(step));
      }).length);
    }));
  }

  // The account-wide items ride on the client's first row the card shows:
  // the first month that is not finished, else (only finished months on the
  // card) the first one, so a waiting message never drops off with them.
  const home = new Map<string, string>();
  for (const m of owed) {
    if (progress.get(progressKey(m.enrollmentId, m.id, m.monthKey))?.muted) continue;
    const had = home.get(m.enrollmentId);
    if (!had || (finished.has(had) && !finished.has(m.id))) home.set(m.enrollmentId, m.id);
  }

  const rows: ContentActionRow[] = [];
  for (const m of owed) {
    const p = progress.get(progressKey(m.enrollmentId, m.id, m.monthKey));
    // A forfeited (or otherwise muted) month owes nothing (Oct 8 2026).
    if (p?.muted) continue;
    const at = (tab: "plan" | "messages", view?: "topics" | "scripts" | "strategy") => contentHref(m.enrollmentId, { tab, view, month: m.monthKey, now });
    const items: ActionItem[] = [];
    // An untouched next month carries nothing of its own (only, if it is the
    // client's home row, the account-wide items below). Nor does a finished
    // one (audit M5), unless its month page asks for its history to be
    // reconciled: that page's own next step.
    const na = quiet.has(m.id) ? null : p?.nextAction;
    const done = finished.has(m.id);
    if (!isEarlier.has(m.id) && na && na.blocked === "us" && (na.ownerDuty === "month reconciliation" || (!done && na.ownerDuty === "strategy"))) items.push({ key: "topics", words: na.text, tone: "warn", href: at("plan", "topics") });
    if (!done) {
      const write = needScript.get(m.id) ?? 0;
      if (write) items.push({ key: "write", words: `Needs ${n(write, "script")}`, tone: "warn", href: at("plan", "scripts") });
      // Oct 20 2026 (audit D9): a DRAFT waits for the same OK as INTERNAL_REVIEW
      // (the Scripts tab lists both under "needs your OK"), so it is one count;
      // Oct 22 (M5): in the month page's words, its split said when both wait.
      const toApprove = p ? scriptsAwaitingWords(p.scripts, "to approve") : null;
      if (toApprove) items.push({ key: "approve", words: toApprove, tone: "brand", href: at("plan", "scripts") });
      if (p?.scripts.changesRequested) items.push({ key: "changes", words: `Changes asked on ${n(p.scripts.changesRequested, "script")}`, tone: "warn", href: at("plan", "scripts") });
      if (p?.scripts.openSuggestions) items.push({ key: "suggestions", words: `${n(p.scripts.openSuggestions, "script suggestion")} from the client`, tone: "brand", href: at("plan", "scripts") });
    }
    // The account-wide ones ride on the client's home row.
    if (home.get(m.enrollmentId) === m.id) {
      const msgs = waiting.get(m.enrollmentId) ?? 0;
      if (msgs) items.push({ key: "messages", words: `${n(msgs, "message")} waiting on a reply`, tone: "warn", href: at("messages") });
      if (strategiesWaiting.get(m.enrollmentId)) items.push({ key: "strategy", words: "Strategy to approve", tone: "brand", href: at("plan", "strategy") });
      const ch = changes.get(m.enrollmentId) ?? 0;
      if (ch) items.push({ key: "proposals", words: `${n(ch, "strategy change")} to review`, tone: "muted", href: at("plan", "strategy") });
      const id = ideas.get(m.enrollmentId) ?? 0;
      if (id) items.push({ key: "ideas", words: `${n(id, "topic idea")} from the client`, tone: "brand", href: at("plan", "topics") });
    }
    if (!items.length) continue;
    rows.push({ key: `${m.enrollmentId}:${m.monthKey}`, clientName: nameOf.get(m.clientId) ?? "A client", monthKey: m.monthKey, href: contentHref(m.enrollmentId, { month: m.monthKey, now }), items });
  }
  // What needs a person most first: rows with a warning, then the oldest month first, then by how much is on them.
  const warns = (r: ContentActionRow) => r.items.filter((i) => i.tone === "warn").length;
  rows.sort((a, b) => Number(warns(b) > 0) - Number(warns(a) > 0) || a.monthKey.localeCompare(b.monthKey) || b.items.length - a.items.length || a.clientName.localeCompare(b.clientName));
  return { rows };
}

/**
 * Has the client (or anyone) done something on this month: topics chosen, a
 * script, a session asked for or on the calendar, a call booked or held, a
 * video? forfeit.monthTouched's rule, read off the progress the card already
 * has (no extra query).
 */
function progressTouched(p: MonthProgress | undefined): boolean {
  if (!p) return false;
  return monthTouched({ strategyCallStatus: p.call.status }, {
    shoots: p.sessions.list.length, sessionRequests: p.sessions.pendingRequests, videos: p.production.libraryRows,
    filmedTopics: p.production.filmed, plannedWork: p.topics.selected + p.topics.overflow + p.scripts.total, calls: 0,
  });
}

/**
 * The earlier months on which a script waits on the approver (its CURRENT
 * version is DRAFT or INTERNAL_REVIEW) or carries an open client request.
 * Cheap reads, so only those months go through the progress reader.
 */
async function monthsWithScriptsWaiting<M extends { id: string }>(months: M[]): Promise<M[]> {
  if (!months.length) return [];
  const scripts = await prisma.contentScript.findMany({
    where: { monthId: { in: months.map((m) => m.id) }, historical: false },
    select: { id: true, monthId: true, currentVersionId: true },
  });
  if (!scripts.length) return [];
  const versionIds = scripts.map((x) => x.currentVersionId).filter((x): x is string => !!x);
  const [openVersions, openRequests] = await Promise.all([
    versionIds.length ? prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, select: { id: true } }) : Promise.resolve([]),
    prisma.scriptSuggestion.findMany({ where: { scriptId: { in: scripts.map((x) => x.id) }, status: "OPEN" }, select: { scriptId: true } }),
  ]);
  const waitingVersion = new Set(openVersions.map((v) => v.id));
  const requested = new Set(openRequests.map((r) => r.scriptId));
  const hit = new Set(scripts.filter((x) => (!!x.currentVersionId && waitingVersion.has(x.currentVersionId)) || requested.has(x.id)).map((x) => x.monthId));
  return months.filter((m) => hit.has(m.id));
}

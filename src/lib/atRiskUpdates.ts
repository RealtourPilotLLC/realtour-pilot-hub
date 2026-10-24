import "server-only";
import { prisma } from "@/lib/prisma";
import { AT_RISK_HOURS, owedNow, owedPhrase, owedVerb, parseEvidence, sameCategory } from "@/lib/statusEvidence";
import { pinnedPromise } from "@/lib/turnaround";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// PROMISES AT RISK, AND THE CLIENT UPDATE NOBODY HAS DRAFTED YET
// (AU-24 / F5, unified handoff §9–§10, Sep 26 2026).
//
// "For new at-risk client updates, draft from an actual recorded promise and
// reason; never invent a new delivery date. Keep new client auto-sending
// closed until approved."
//
// Delay updates were reactive: the client asked "where's my video?" and Kyle
// wrote an apology from scratch. Everything needed to be ahead of that already
// existed — every owed video carries its pinned client deadline
// (DeliverableOutput.promisedAt) and every job its frozen promise
// (Project.promisedDueAt) — and the status card already calls a job "At risk"
// inside AT_RISK_HOURS of it. Nothing turned that into a message.
//
// THREE RULES, and the drill (scripts/_drill/at-risk-drafts.ts) holds each:
//   1. THE ONLY DATES IN A DRAFT ARE ONES A PERSON STANDS BEHIND. The recorded
//      promise, and a time the office TYPED: either the new delivery time they
//      have confirmed, or the time by which they will confirm one. No typed
//      time, no draft — the model is never asked to pick a date, and a draft
//      that mentions a date nobody typed is flagged on the task for a human.
//   2. NOTHING IS SENT. The draft lands in one task on Kyle's list (dedupe on
//      the output and the promise it is about); he reads it and sends it from
//      the conversation himself. There is no send path in this file.
//   3. THE AI RUNS ON A CLICK. Listing what is at risk is a database read; the
//      model is called only when somebody presses Draft update.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
/** A promise missed longer ago than this is the delivery board's overdue
 *  problem, not a fresh update to write. */
const LOOKBACK_DAYS = 7;
/** The draft's task is due this long before the promise it is about. */
const DUE_BEFORE_PROMISE_HOURS = 4;

export type AtRiskRow = {
  /** `${outputId ?? projectId}` — one row per owed thing */
  key: string;
  projectId: string;
  outputId: string | null;
  street: string;
  clientId: string;
  clientName: string;
  /** the recorded client deadline this row is about */
  promisedAt: Date;
  promiseSource: string | null;
  /** "the video", "His and hers (video 2)", "the photos and the video" */
  owed: string;
  overdue: boolean;
  hoursLeft: number;
  /** the at_risk_update task already drafted for THIS promise, if any */
  taskId: string | null;
  /** A PROGRAM video (Oct 15 2026, lib/programWatch): the milestone it missed,
   *  in the office's words. Null on every other row. */
  why?: string | null;
};

const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "the job";

export function atRiskTaskKey(r: { outputId: string | null; projectId: string; promisedAt: Date }): string {
  return `at-risk:${r.outputId ?? r.projectId}:${r.promisedAt.toISOString()}`;
}

/** Everything owed to a client whose recorded promise is inside AT_RISK_HOURS
 *  or already past (up to LOOKBACK_DAYS). Read-only. */
export async function atRiskOutputs(now: Date = new Date(), opts: { excludeClientIds?: string[] } = {}): Promise<AtRiskRow[]> {
  const horizon = new Date(now.getTime() + AT_RISK_HOURS * HOUR);
  const floor = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const live = { status: { notIn: ["DELIVERED", "CANCELLED"] as ("DELIVERED" | "CANCELLED")[] } };
  // Output rows carry a plain projectId, so exclude synthetic projects before
  // the 200-row safety cap rather than trimming their rows after pagination.
  const excludedProjectIds = opts.excludeClientIds?.length
    ? (await prisma.project.findMany({ where: { clientId: { in: opts.excludeClientIds } }, select: { id: true } })).map((p) => p.id)
    : [];
  const [outputs, projects] = await Promise.all([
    // Per video: the pinned client deadline, still owed — not delivered, not
    // waived, not dropped from the order — on a job that is still live.
    prisma.deliverableOutput.findMany({
      where: {
        promisedAt: { not: null, lte: horizon, gte: floor },
        deliveredAt: null, waivedAt: null, removedFromOrderAt: null,
        ...(excludedProjectIds.length ? { projectId: { notIn: excludedProjectIds } } : {}),
      },
      // briefJson: a video waiting on a second shoot (Oct 22 2026) is never at risk.
      select: { id: true, projectId: true, slot: true, category: true, title: true, promisedAt: true, promiseSource: true, briefJson: true },
      orderBy: { promisedAt: "asc" },
      take: 200,
    }).then(async (rows) => {
      const { isWaitingJson } = await import("@/lib/secondShootCore");
      return rows.filter((o) => !isWaitingJson(o.briefJson));
    }),
    // Per job, for the work that has no per-output row (photo-only jobs): the
    // frozen promise, read the way every reader must (pinnedPromise — a
    // rebooked visit voids a pin, nothing else does).
    prisma.project.findMany({
      where: { ...live, deliveredAt: null, promisedDueAt: { not: null, lte: horizon, gte: floor }, ...(opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {}) },
      select: { id: true, title: true, clientId: true, promisedDueAt: true, shootDate: true, statusEvidence: true, promisedTierKey: true, client: { select: { name: true } } },
      take: 200,
    }),
  ]);
  const projectIds = [...new Set(outputs.map((o) => o.projectId))];
  const outputProjects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds }, ...live, ...(opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {}) },
        select: { id: true, title: true, clientId: true, client: { select: { name: true } } },
      })
    : [];
  const pById = new Map(outputProjects.map((p) => [p.id, p]));
  // A job whose videos are tracked per output is represented by THOSE rows; the
  // job-level row is only for work with no output of its own.
  const withOutputs = new Set(
    (projectIds.length || projects.length
      ? await prisma.deliverableOutput.findMany({ where: { projectId: { in: [...projectIds, ...projects.map((p) => p.id)] } }, select: { projectId: true }, distinct: ["projectId"] })
      : []
    ).map((o) => o.projectId),
  );

  const rows: AtRiskRow[] = [];
  for (const o of outputs) {
    const p = pById.get(o.projectId);
    if (!p || !o.promisedAt) continue;
    const cat = o.category.toLowerCase().replace(/_/g, " ");
    const owed = o.title ? `${o.title} (${cat} ${o.slot})` : o.slot > 1 ? `${cat} ${o.slot}` : `the ${cat}`;
    rows.push(row(now, { projectId: p.id, outputId: o.id, title: p.title, clientId: p.clientId, clientName: p.client.name, promisedAt: o.promisedAt, promiseSource: o.promiseSource, owed }));
  }
  for (const p of projects) {
    if (withOutputs.has(p.id)) continue;
    const pin = pinnedPromise(p);
    if (!pin || pin > horizon || pin < floor) continue;
    const phrase = owedPhrase(owedNow(parseEvidence(p.statusEvidence)));
    rows.push(row(now, { projectId: p.id, outputId: null, title: p.title, clientId: p.clientId, clientName: p.client.name, promisedAt: pin, promiseSource: p.promisedTierKey ?? "project", owed: phrase || "the order" }));
  }
  // PROGRAM VIDEOS (Oct 15 2026, lib/programWatch): a monthly video is at risk
  // the moment it misses a milestone (editing started, first cut in review,
  // final approved), not only inside AT_RISK_HOURS of its promise, and most
  // of them carry no promise of their own (the job's answers for them), so
  // the per-output read above never saw them. Their rows replace any clock
  // row for the same video.
  const program = await import("@/lib/programWatch")
    .then((m) => m.programAtRiskRows({ now, lookbackDays: LOOKBACK_DAYS, excludeClientIds: opts.excludeClientIds }))
    .catch(() => []);
  for (const pr of program) {
    if (!pr.promisedAt) continue;
    const at = rows.findIndex((r) => r.outputId === pr.outputId);
    const next = row(now, {
      projectId: pr.projectId, outputId: pr.outputId, title: `${pr.monthWords} videos`, clientId: pr.clientId, clientName: pr.clientName,
      promisedAt: pr.promisedAt, promiseSource: "program", owed: `the video "${pr.title.replace(/"/g, "'")}"`,
    });
    next.why = pr.why;
    if (at >= 0) rows[at] = next;
    else rows.push(next);
  }
  if (rows.length) {
    // A program video is also covered by the watch's one draft for its month's
    // job (keyed on the job and the promise, not the video).
    const jobKey = (r: AtRiskRow) => atRiskTaskKey({ outputId: null, projectId: r.projectId, promisedAt: r.promisedAt });
    const keys = [...new Set([...rows.map(atRiskTaskKey), ...rows.filter((r) => r.why).map(jobKey)])];
    const tasks = await prisma.smartTask.findMany({
      where: { dedupeKey: { in: keys }, status: { notIn: ["CANCELLED"] } },
      select: { id: true, dedupeKey: true, status: true },
    });
    for (const r of rows) {
      const t = tasks.find((x) => x.dedupeKey === atRiskTaskKey(r)) ?? (r.why ? tasks.find((x) => x.dedupeKey === jobKey(r)) : undefined);
      r.taskId = t?.id ?? null;
    }
  }
  return rows.sort((a, b) => a.promisedAt.getTime() - b.promisedAt.getTime());
}

function row(now: Date, r: Omit<AtRiskRow, "key" | "street" | "overdue" | "hoursLeft" | "taskId"> & { title: string }): AtRiskRow {
  const left = (r.promisedAt.getTime() - now.getTime()) / HOUR;
  return {
    key: r.outputId ?? r.projectId,
    projectId: r.projectId,
    outputId: r.outputId,
    street: streetOf(r.title),
    clientId: r.clientId,
    clientName: r.clientName,
    promisedAt: r.promisedAt,
    promiseSource: r.promiseSource,
    owed: r.owed,
    overdue: left < 0,
    hoursLeft: Math.round(left * 10) / 10,
    taskId: null,
  };
}

// ---- the draft --------------------------------------------------------------

export type AtRiskDraftInput = {
  projectId: string;
  outputId?: string | null;
  /** the delivery time the office has CONFIRMED — the client may be told it */
  newTime?: Date | null;
  /** the time by which the office will confirm one — nothing else is promised */
  confirmBy?: Date | null;
  actor: string;
  now?: Date;
};

export type AtRiskDraftResult =
  | { ok: true; taskId: string; draft: string; created: boolean; dateWarning: string | null }
  | { ok: false; message: string };

/** The exact words the model is given — exported so the drill can hold the
 *  one rule that matters: the only dates in it are the promise and the typed
 *  time. */
export function atRiskInstruction(r: { owed: string; street: string; promisedAt: Date; newTime?: Date | null; confirmBy?: Date | null }): string {
  const promised = `${etDateTime(r.promisedAt)} ET`;
  if (r.newTime) {
    return (
      `Let the client know ${r.owed} for ${r.street}, which we promised by ${promised}, will now be delivered by ${etDateTime(r.newTime)} ET. ` +
      "Apologise briefly for the change. Do not give a reason, and do not mention any other date or time."
    );
  }
  return (
    `Let the client know ${r.owed} for ${r.street}, which we promised by ${promised}, is running behind, and that we will confirm the exact delivery time by ${etDateTime(r.confirmBy ?? null)} ET. ` +
    "Apologise briefly. Do not give a reason, do not promise a delivery time, and do not mention any other date or time."
  );
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun";

/** Dates the draft names that nobody typed — a weekday or a month-and-day the
 *  allowed instants do not account for. Pure; null when clean. */
export function foreignDates(draft: string, allowed: Date[]): string | null {
  const ok = new Set<string>();
  for (const d of allowed) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    ok.add(get("weekday").toLowerCase());
    ok.add(get("weekday").toLowerCase().slice(0, 3));
    ok.add(`${get("month").toLowerCase().slice(0, 3)} ${get("day")}`);
  }
  const found: string[] = [];
  const text = draft.toLowerCase();
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"))) {
    const key = `${m[1].slice(0, 3)} ${Number(m[2])}`;
    if (!ok.has(key)) found.push(m[0]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAYS})\\b`, "g"))) {
    const w = m[1];
    if (!ok.has(w) && !ok.has(w.slice(0, 3))) found.push(m[0]);
  }
  for (const m of text.matchAll(/\b(today|tonight|tomorrow)\b/g)) found.push(m[0]);
  return found.length ? [...new Set(found)].join(", ") : null;
}

/** Draft ONE client update for ONE at-risk promise, into ONE task for Kyle.
 *  Refuses without a typed time. Never sends. */
export async function draftAtRiskUpdate(input: AtRiskDraftInput): Promise<AtRiskDraftResult> {
  const now = input.now ?? new Date();
  const hasNew = !!input.newTime && !isNaN(input.newTime.getTime());
  const hasConfirm = !!input.confirmBy && !isNaN(input.confirmBy.getTime());
  if (hasNew === hasConfirm) {
    return { ok: false, message: "Type either the new delivery time you have confirmed, or the time you will confirm one by — one of the two. The draft never picks a date for you." };
  }
  const when = (hasNew ? input.newTime : input.confirmBy) as Date;
  if (when.getTime() <= now.getTime()) return { ok: false, message: "That time has already passed — type a time that is still ahead." };

  const rows = await atRiskOutputs(now);
  const r = rows.find((x) => x.projectId === input.projectId && (x.outputId ?? null) === (input.outputId ?? null));
  if (!r) return { ok: false, message: "That promise is no longer at risk (delivered, waived, or not within a day of its deadline) — nothing to draft." };

  const instruction = atRiskInstruction({ ...r, newTime: hasNew ? when : null, confirmBy: hasConfirm ? when : null });
  let draft: string;
  try {
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const { getSecret } = await import("@/lib/integrations/connections");
    if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft updates." };
    // No transcript on purpose: the thread is where stray dates live ("you
    // said Thursday"), and this message may carry only the two dates above.
    draft = (await draftReplyWithContext({ channel: "text", clientName: r.clientName, propertyAddress: r.street, transcript: [], instruction })).trim();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The draft could not be written — try again." };
  }
  if (!draft || /^NO_REPLY_NEEDED$/i.test(draft)) return { ok: false, message: "The model returned nothing usable — try again." };
  const foreign = foreignDates(draft, [r.promisedAt, when]);
  const dateWarning = foreign ? `The draft mentions ${foreign} — check every date against the promise and the time you typed before sending.` : null;

  const kyle = await prisma.teamMember
    .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { id: true } })
    .catch(() => null);
  const dueAt = new Date(Math.max(now.getTime() + HOUR, r.promisedAt.getTime() - DUE_BEFORE_PROMISE_HOURS * HOUR));
  const typed = hasNew ? `new delivery time ${etDateTime(when)} ET (confirmed by ${input.actor})` : `will confirm by ${etDateTime(when)} ET (set by ${input.actor})`;
  const data = {
    taskType: "at_risk_update",
    title: `Send ${r.clientName} an update — ${r.street}`.slice(0, 120),
    summary: `${r.owed} promised by ${etDateTime(r.promisedAt)} ET; ${typed}. Draft ready — read it, then send it from the conversation.`.slice(0, 500),
    description: [
      dateWarning ? `⚠ ${dateWarning}` : null,
      draft,
      "—",
      "Drafted from the recorded promise and the time typed above. Nothing has been sent: copy it into the client's conversation (Communications → Replies, or the client page) and send it yourself.",
    ].filter(Boolean).join("\n\n"),
    reasonCreated: `Promise at risk (${r.overdue ? "past" : `${r.hoursLeft}h left`}) — update drafted on request`,
    source: "system",
    sourceDetail: `/tasks?tab=comms`,
    priority: r.overdue ? "URGENT" : "HIGH",
    ownerId: kyle?.id ?? null,
    assignedKey: "kyle",
    clientId: r.clientId,
    projectId: r.projectId,
    outputId: r.outputId,
    propertyAddress: r.street,
    dueAt,
    status: "OPEN",
    completedAt: null,
  };
  const dedupeKey = atRiskTaskKey(r);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data });
    return { ok: true, taskId: existing.id, draft, created: false, dateWarning };
  }
  try {
    const t = await prisma.smartTask.create({ data: { ...data, dedupeKey }, select: { id: true } });
    return { ok: true, taskId: t.id, draft, created: true, dateWarning };
  } catch {
    // Two clicks at once: the other one made the row — update it instead.
    const again = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (!again) return { ok: false, message: "The task could not be saved — try again." };
    await prisma.smartTask.update({ where: { id: again.id }, data });
    return { ok: true, taskId: again.id, draft, created: false, dateWarning };
  }
}

/** "Tue Sep 29, 5:00 PM" for a card — re-exported so the page and the drill
 *  print the same words the instruction uses. */
export const promiseWords = (d: Date) => `${etDateTime(d)} ET`;
/** The exceptions board's rows for this kind (lib/opsExceptions, kind
 *  "at-risk-promise"): an at-risk promise with NO update drafted for it yet.
 *  Once one is drafted the task on Kyle's list is the record, and the board
 *  stops repeating it. `total` is the real pile, `rows` the capped page. */
export async function atRiskExceptionRows(opts: { now?: Date; cap: number; excludeClientIds?: string[] }): Promise<{
  rows: import("@/lib/opsExceptions").OpsException[];
  total: { all: number; high: number };
}> {
  const now = opts.now ?? new Date();
  const undrafted = (await atRiskOutputs(now, { excludeClientIds: opts.excludeClientIds })).filter((r) => !r.taskId);
  const rows = undrafted.slice(0, opts.cap).map((r) => ({
    id: `at-risk:${r.key}`,
    kind: "at-risk-promise" as const,
    severity: r.overdue ? ("high" as const) : ("medium" as const),
    title: r.street,
    why: r.why
      ? `${r.owed} (${r.clientName}): ${r.why}. Due ${promiseWords(r.promisedAt)}; the client has not been updated`.slice(0, 220)
      : r.overdue
      ? `${r.owed} was promised by ${promiseWords(r.promisedAt)} and the client has not been updated`
      : `${r.owed} is due ${promiseWords(r.promisedAt)} (${Math.max(0, Math.round(r.hoursLeft))}h left) and the client has not been updated`,
    owner: "Kyle",
    nextAction: "Draft an update from Tasks → Comms (Promises at risk) and send it",
    href: "/tasks?tab=comms#at-risk",
    ageDays: r.overdue ? Math.floor(-r.hoursLeft / 24) : 0,
  }));
  return { rows, total: { all: undrafted.length, high: undrafted.filter((r) => r.overdue).length } };
}

// ---------------------------------------------------------------------------
// THE DELIVERY WATCH'S OWN DRAFT (Oct 14 2026, lib/promiseWatch.ts).
//
// Three covered hours before a job's promise, the watch Slacks Kyle the job's
// stage and leaves this draft on his list so the update is ready before the
// client asks "when will it be ready?" (5.6 a week in the comms audit). It
// keeps every rule above:
//   1. the ONLY date in it is the recorded promise. It names no new time and
//      no "confirm by" time, because nobody has typed one: it says the office
//      will confirm the exact time (the house rule's own wording for "we do
//      not know yet"). foreignDates() is asked anyway, and a draft that names
//      anything else is refused rather than filed;
//   2. NOTHING IS SENT. It is a task on Kyle's list, the same task (same
//      dedupe key) a click on Draft update would write; if a person already
//      drafted one for this promise, theirs stands untouched;
//   3. no model call: the words are fixed, so a cron can write them.
// ---------------------------------------------------------------------------

/** The watch's words. Pure; only the promise is a date. */
export function atRiskTemplate(r: { firstName: string | null; street: string; owed: string; verb: string; promisedAt: Date }): string {
  const hi = r.firstName ? `Hi ${r.firstName}, ` : "Hi, ";
  return `${hi}a quick update on ${r.street}: ${r.owed} ${r.verb} running behind the time we promised (${promiseWords(r.promisedAt)}). We'll confirm the exact delivery time with you. Sorry for the wait.`;
}

/** Marks a task this file wrote for the watch (the close-on-delivery sweep reads it). */
export const WATCH_DRAFT_REASON = "Delivery watch: 3 covered hours before the promise";

export async function autoDraftAtRiskUpdate(input: {
  projectId: string;
  promisedAt: Date;
  stage?: string | null;
  now?: Date;
  /** PROGRAM videos (Oct 15 2026, lib/programWatch): what the update is about
   *  in place of the street ("your October videos"), what is owed in place of
   *  the evidence phrase ("your video \"Tip #1\""), its verb, and the reason
   *  stamped on the task (the program watch closes its own drafts). */
  about?: string;
  owed?: string;
  verb?: "is" | "are";
  reason?: string;
}): Promise<
  { ok: true; taskId: string; created: boolean; draft: string } | { ok: false; message: string }
> {
  const now = input.now ?? new Date();
  const p = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, title: true, clientId: true, statusEvidence: true, client: { select: { name: true } } },
  });
  if (!p) return { ok: false, message: "No such job." };
  const owed = owedNow(parseEvidence(p.statusEvidence));
  const phrase = input.owed ?? owedPhrase(owed);
  const draft = atRiskTemplate({
    firstName: (p.client.name ?? "").trim().split(/\s+/)[0] || null,
    street: input.about ?? streetOf(p.title),
    owed: phrase || "your order",
    verb: input.verb ?? (phrase ? owedVerb(owed) : "is"),
    promisedAt: input.promisedAt,
  });
  const foreign = foreignDates(draft, [input.promisedAt]);
  if (foreign) return { ok: false, message: `The template named ${foreign}; nothing filed.` };
  const dedupeKey = atRiskTaskKey({ outputId: null, projectId: p.id, promisedAt: input.promisedAt });
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return { ok: true, taskId: existing.id, created: false, draft };
  const { kyleDesk } = await import("@/lib/kyleNotice");
  const kyle = await kyleDesk();
  try {
    const t = await prisma.smartTask.create({
      data: {
        taskType: "at_risk_update",
        title: `Send ${p.client.name} an update: ${input.about ?? streetOf(p.title)}`.slice(0, 120),
        summary: `${phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : "The order"} promised by ${promiseWords(input.promisedAt)}.${input.stage ? ` Now: ${input.stage}.` : ""} The update below is drafted and NOT sent. If the job will not make it, send it from the client's conversation; if it will, close this task.`.slice(0, 500),
        description: draft,
        reasonCreated: input.reason ?? WATCH_DRAFT_REASON,
        source: "system",
        sourceDetail: "/tasks?tab=comms",
        priority: "HIGH",
        ownerId: kyle?.id ?? null,
        assignedKey: kyle?.key ?? null,
        clientId: p.clientId,
        projectId: p.id,
        propertyAddress: streetOf(p.title),
        dueAt: new Date(Math.max(now.getTime() + 30 * 60_000, input.promisedAt.getTime() - 2 * HOUR)),
        status: "OPEN",
        dedupeKey,
      },
      select: { id: true },
    });
    return { ok: true, taskId: t.id, created: true, draft };
  } catch {
    // Two sweeps at once: the other one made the row.
    const again = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
    return again ? { ok: true, taskId: again.id, created: false, draft } : { ok: false, message: "The draft task could not be saved." };
  }
}

/**
 * A WATCH DRAFT SAYS WHAT IS STILL OWED (Oct 23 2026, Jordan, about 30 Caedman
 * Dr: "Hub is saying photos aren't delivered … but they are. It's just the
 * floorplan that's missing"). The draft is written once, three covered hours
 * before the promise, from that moment's evidence ("the photos and the floor
 * plan"); a job that then delivers part of its order stays undelivered as a
 * whole, so the close sweep below leaves it open, still naming what went out.
 * Each sweep re-reads the job's evidence and rewrites the draft, the title's
 * summary and the client text, to the parts still owed. A text a person has
 * edited (it no longer reads as the template) keeps its words; only the
 * summary is brought up to date. Nothing is ever sent from here.
 */
export async function refreshWatchDrafts(): Promise<{ refreshed: number }> {
  const open = await prisma.smartTask.findMany({
    where: { taskType: "at_risk_update", reasonCreated: WATCH_DRAFT_REASON, status: { notIn: ["COMPLETED", "CANCELLED"] }, projectId: { not: null } },
    select: { id: true, projectId: true, dedupeKey: true, description: true, summary: true },
    take: 100,
  });
  if (open.length === 0) return { refreshed: 0 };
  const projects = await prisma.project.findMany({
    where: { id: { in: open.map((t) => t.projectId as string) }, status: { notIn: ["DELIVERED", "CANCELLED"] }, deliveredAt: null },
    select: { id: true, title: true, statusEvidence: true, client: { select: { name: true } } },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  let refreshed = 0;
  for (const t of open) {
    const p = byId.get(t.projectId as string);
    const iso = t.dedupeKey?.match(/^at-risk:[^:]+:(.+)$/)?.[1];
    const promisedAt = iso ? new Date(iso) : null;
    if (!p || !promisedAt || Number.isNaN(promisedAt.getTime())) continue;
    const ev = parseEvidence(p.statusEvidence);
    const owed = owedNow(ev);
    const phrase = owedPhrase(owed);
    if (!phrase) continue; // nothing named as owed: the close sweep decides
    const street = streetOf(p.title);
    const firstName = (p.client.name ?? "").trim().split(/\s+/)[0] || null;
    const draft = atRiskTemplate({ firstName, street, owed: phrase, verb: owedVerb(owed), promisedAt });
    const done = (ev?.present ?? []).filter((c) => !owed.categories.some((o) => sameCategory(o, c)));
    const summary = `Still owed: ${phrase}, promised by ${promiseWords(promisedAt)}.${done.length ? ` Already delivered: ${done.map((c) => `the ${c.trim().toLowerCase()}`).join(" and ")}.` : ""} The update below is drafted and NOT sent. If the job will not make it, send it from the client's conversation; if it will, close this task.`.slice(0, 500);
    // The template's own shape: a text a person rewrote is theirs to keep.
    const untouched = (t.description ?? "").startsWith(`${firstName ? `Hi ${firstName}, ` : "Hi, "}a quick update on ${street}: `) && / running behind the time we promised \(.+\)\. We'll confirm the exact delivery time with you\. Sorry for the wait\.$/.test(t.description ?? "");
    const description = untouched ? draft : t.description;
    if (description === t.description && summary === t.summary) continue;
    const r = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] }, description: t.description, summary: t.summary },
      data: { description, summary },
    });
    refreshed += r.count;
  }
  return { refreshed };
}

/** A watch draft whose job went out after all is noise on Kyle's list: closed, with the reason. */
export async function closeDeliveredWatchDrafts(): Promise<{ closed: number }> {
  const open = await prisma.smartTask.findMany({
    where: { taskType: "at_risk_update", reasonCreated: WATCH_DRAFT_REASON, status: { notIn: ["COMPLETED", "CANCELLED"] }, projectId: { not: null } },
    select: { id: true, projectId: true },
    take: 100,
  });
  if (open.length === 0) return { closed: 0 };
  const delivered = await prisma.project.findMany({
    where: { id: { in: open.map((t) => t.projectId as string) }, OR: [{ status: "DELIVERED" }, { deliveredAt: { not: null } }] },
    select: { id: true },
  });
  const done = new Set(delivered.map((d) => d.id));
  const ids = open.filter((t) => done.has(t.projectId as string)).map((t) => t.id);
  if (ids.length === 0) return { closed: 0 };
  const r = await prisma.smartTask.updateMany({
    where: { id: { in: ids }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED", summary: "Closed by the delivery watch: the job was delivered, so no update was needed. Nothing was sent." },
  });
  return { closed: r.count };
}

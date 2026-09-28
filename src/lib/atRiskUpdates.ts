import "server-only";
import { prisma } from "@/lib/prisma";
import { AT_RISK_HOURS, owedNow, owedPhrase, parseEvidence } from "@/lib/statusEvidence";
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
};

const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "the job";

export function atRiskTaskKey(r: { outputId: string | null; projectId: string; promisedAt: Date }): string {
  return `at-risk:${r.outputId ?? r.projectId}:${r.promisedAt.toISOString()}`;
}

/** Everything owed to a client whose recorded promise is inside AT_RISK_HOURS
 *  or already past (up to LOOKBACK_DAYS). Read-only. */
export async function atRiskOutputs(now: Date = new Date()): Promise<AtRiskRow[]> {
  const horizon = new Date(now.getTime() + AT_RISK_HOURS * HOUR);
  const floor = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const live = { status: { notIn: ["DELIVERED", "CANCELLED"] as ("DELIVERED" | "CANCELLED")[] } };
  const [outputs, projects] = await Promise.all([
    // Per video: the pinned client deadline, still owed — not delivered, not
    // waived, not dropped from the order — on a job that is still live.
    prisma.deliverableOutput.findMany({
      where: {
        promisedAt: { not: null, lte: horizon, gte: floor },
        deliveredAt: null, waivedAt: null, removedFromOrderAt: null,
      },
      select: { id: true, projectId: true, slot: true, category: true, title: true, promisedAt: true, promiseSource: true },
      orderBy: { promisedAt: "asc" },
      take: 200,
    }),
    // Per job, for the work that has no per-output row (photo-only jobs): the
    // frozen promise, read the way every reader must (pinnedPromise — a
    // rebooked visit voids a pin, nothing else does).
    prisma.project.findMany({
      where: { ...live, deliveredAt: null, promisedDueAt: { not: null, lte: horizon, gte: floor } },
      select: { id: true, title: true, clientId: true, promisedDueAt: true, shootDate: true, statusEvidence: true, promisedTierKey: true, client: { select: { name: true } } },
      take: 200,
    }),
  ]);
  const projectIds = [...new Set(outputs.map((o) => o.projectId))];
  const outputProjects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds }, ...live },
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
  if (rows.length) {
    const tasks = await prisma.smartTask.findMany({
      where: { dedupeKey: { in: rows.map(atRiskTaskKey) }, status: { notIn: ["CANCELLED"] } },
      select: { id: true, dedupeKey: true, status: true },
    });
    for (const r of rows) {
      const t = tasks.find((x) => x.dedupeKey === atRiskTaskKey(r));
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
export async function atRiskExceptionRows(opts: { now?: Date; cap: number }): Promise<{
  rows: import("@/lib/opsExceptions").OpsException[];
  total: { all: number; high: number };
}> {
  const now = opts.now ?? new Date();
  const undrafted = (await atRiskOutputs(now)).filter((r) => !r.taskId);
  const rows = undrafted.slice(0, opts.cap).map((r) => ({
    id: `at-risk:${r.key}`,
    kind: "at-risk-promise" as const,
    severity: r.overdue ? ("high" as const) : ("medium" as const),
    title: r.street,
    why: r.overdue
      ? `${r.owed} was promised by ${promiseWords(r.promisedAt)} and the client has not been updated`
      : `${r.owed} is due ${promiseWords(r.promisedAt)} (${Math.max(0, Math.round(r.hoursLeft))}h left) and the client has not been updated`,
    owner: "Kyle",
    nextAction: "Draft an update from Tasks → Comms (Promises at risk) and send it",
    href: "/tasks?tab=comms#at-risk",
    ageDays: r.overdue ? Math.floor(-r.hoursLeft / 24) : 0,
  }));
  return { rows, total: { all: undrafted.length, high: undrafted.filter((r) => r.overdue).length } };
}

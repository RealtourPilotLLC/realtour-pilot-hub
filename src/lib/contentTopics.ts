import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256, activePolicyVersion } from "@/lib/aiRuns";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { topicSourceIsCall, topicSourceNeedsApproval } from "@/lib/contentPolicy/topicBank";
import { approvedStrategy } from "@/lib/contentStrategy";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";
import { confidentialFilter } from "@/lib/clientFacts";
import { normalizeTitle, titleSimilarity, NEAR_DUPLICATE_THRESHOLD, rankRecommendations, clientReasonFor, GENERATION_POLICY, type Topic, type FilmedRecord, type PriorScript, type StrategyGoal, type SourceExcerpt } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Video Topics (spec §5/§18/§27). A topic carries audience need, business
// goal, intended message, an approval state separate from its production
// status, and an append-only history (ContentTopicEvent). "Discussed on a
// call" is an EVENT, never a status. Selection for a month is its own row
// (ContentTopicSelection, unique per topic+month); overflow past the package
// capacity is kept and flagged, never deleted.
//
// Refresh = a ContentTopicRefreshRun job (duplicate clicks collide on
// dedupeKey) whose output is ContentTopicSuggestion rows Jordan accepts,
// edits, archives or regenerates one by one. Archived/rejected concepts are
// remembered by dedupeHash and never resurface. The AI half of a run lives
// in contentGeneration.ts; this file owns the bookkeeping.
// ---------------------------------------------------------------------------

export type TopicEventKind = "CREATED" | "IMPORTED" | "SUGGESTED" | "DISCUSSED" | "SELECTED" | "DESELECTED" | "APPROVED" | "REJECTED" | "ARCHIVED" | "SCRIPTED" | "FILMED" | "DELIVERED" | "EDITED" | "RECONCILED" | "CARRIED" | "REINTRODUCED" | "DECLINED";
export type Actor = { kind: "CLIENT" | "STAFF" | "AI" | "SYSTEM" | "IMPORT"; clientUserId?: string | null; staffUserId?: string | null };
/** The shared client, or the transaction a caller is already inside. PGlite (the drills) is one session, so a write inside a transaction must go through ITS client or it waits on itself. */
type Db = Prisma.TransactionClient;

export function topicDedupeHash(title: string): string {
  return sha256(normalizeTitle(title));
}

export async function recordTopicEvent(topicId: string, enrollmentId: string, kind: TopicEventKind, actor: Actor, opts: { monthId?: string | null; fromStatus?: string | null; toStatus?: string | null; sourceRef?: string | null; evidence?: unknown; note?: string | null; db?: Db } = {}): Promise<void> {
  const db = opts.db ?? prisma;
  await db.contentTopicEvent.create({
    data: {
      topicId, enrollmentId, kind, monthId: opts.monthId ?? null, fromStatus: opts.fromStatus ?? null, toStatus: opts.toStatus ?? null,
      actorKind: actor.kind, clientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? null,
      sourceRef: opts.sourceRef ?? null, evidenceJson: opts.evidence ? JSON.stringify(opts.evidence).slice(0, 20_000) : null, note: opts.note?.slice(0, 2000) ?? null,
    },
  });
  await db.contentTopic.updateMany({ where: { id: topicId }, data: { lastEventAt: new Date() } });
}

export type CreateTopicInput = {
  enrollmentId: string; title: string; concept?: string | null; pillarId?: string | null; pillarLabel?: string | null;
  audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null;
  source: "ai" | "client" | "strategy_call" | "discovery_call" | "staff" | "import"; sourceRef?: string | null; importItemId?: string | null; suggestionId?: string | null;
  status?: string; approvalState?: "PROPOSED" | "APPROVED" | null; approvedBy?: string | null; monthId?: string | null; clientUserId?: string | null; clientWording?: string | null;
  importedMark?: string | null; proposedState?: string | null; actor: Actor; eventKind?: TopicEventKind; evidence?: unknown; note?: string | null;
};

/** Create a topic with its first history row. Same-title duplicates inside the enrollment are refused (returns the existing id) so no path can double it. */
export async function createTopic(input: CreateTopicInput): Promise<{ id: string; existed: boolean }> {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Error("Give the topic a title.");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const dedupeHash = topicDedupeHash(title);
  const dup = await prisma.contentTopic.findFirst({ where: { enrollmentId: input.enrollmentId, OR: [{ dedupeHash }, { title: { equals: title, mode: "insensitive" } }] }, select: { id: true } });
  if (dup) return { id: dup.id, existed: true };
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(input.enrollmentId)]);
  const pillarId = input.pillarId ?? (input.pillarLabel ? await resolvePillarByLabel(input.enrollmentId, input.pillarLabel) : null);
  const row = await prisma.contentTopic.create({
    data: {
      enrollmentId: input.enrollmentId, clientId: e.clientId, monthId: input.monthId ?? null, title,
      concept: input.concept?.trim().slice(0, 2000) || null, pillar: input.pillarLabel?.trim().slice(0, 120) || null, pillarId,
      source: input.source, status: input.status ?? (input.monthId ? "SELECTED" : "SAVED"),
      audienceNeed: input.audienceNeed?.slice(0, 1000) ?? null, businessGoal: input.businessGoal?.slice(0, 500) ?? null, intendedMessage: input.intendedMessage?.slice(0, 1000) ?? null,
      approvalState: input.approvalState ?? "PROPOSED", sourceRef: input.sourceRef ?? null, importItemId: input.importItemId ?? null, suggestionId: input.suggestionId ?? null,
      // An APPROVED topic always says who approved it — a staff-typed topic is approved by its author.
      ...(input.approvalState === "APPROVED" ? { approvedBy: input.approvedBy ?? input.actor.staffUserId ?? input.actor.kind, approvedAt: new Date() } : {}),
      strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id, clientUserId: input.clientUserId ?? null, clientWording: input.clientWording ?? null,
      importedMark: input.importedMark ?? null, proposedState: input.proposedState ?? null, dedupeHash, lastEventAt: new Date(),
    },
    select: { id: true },
  });
  await recordTopicEvent(row.id, input.enrollmentId, input.eventKind ?? (input.source === "import" ? "IMPORTED" : input.source === "ai" ? "SUGGESTED" : "CREATED"), input.actor, { monthId: input.monthId, toStatus: input.status ?? null, sourceRef: input.sourceRef ?? input.importItemId ?? null, evidence: input.evidence, note: input.note });
  return { id: row.id, existed: false };
}

export async function updateTopicFields(topicId: string, patch: { title?: string; concept?: string | null; pillarId?: string | null; audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null }, actor: Actor): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true } });
  if (!t) throw new Error("Topic not found.");
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) { const title = patch.title.trim().slice(0, 200); if (title) { data.title = title; data.dedupeHash = topicDedupeHash(title); } }
  if (patch.concept !== undefined) data.concept = patch.concept?.trim().slice(0, 2000) || null;
  if (patch.pillarId !== undefined) data.pillarId = patch.pillarId;
  if (patch.audienceNeed !== undefined) data.audienceNeed = patch.audienceNeed?.slice(0, 1000) || null;
  if (patch.businessGoal !== undefined) data.businessGoal = patch.businessGoal?.slice(0, 500) || null;
  if (patch.intendedMessage !== undefined) data.intendedMessage = patch.intendedMessage?.slice(0, 1000) || null;
  await prisma.contentTopic.update({ where: { id: topicId }, data });
  await recordTopicEvent(topicId, t.enrollmentId, "EDITED", actor, { note: Object.keys(data).join(", ") });
}

// ---- selection ---------------------------------------------------------------

/**
 * The selection statuses that occupy a month's allowance — the ONE list.
 * CARRIED was read in six places and counted in none of the arithmetic: the
 * portal's month card counted it and monthCapacity did not, so the day a carry
 * was written selectTopicForMonth would have treated the carried slot as free
 * and double-counted the allowance (CP-07, Sep 24 2026).
 */
export const ALLOWANCE_SELECTION_STATUSES = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
/** Production states: a topic here has a script or footage somewhere. */
const PRODUCTION_STATUSES = ["SCRIPTED", "FILMED", "EDITING", "DELIVERED"];
const FOOTAGE_VIDEO_STATUSES = ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"];

/**
 * How full a month's plan is. `overflow` is DERIVED from the two numbers, not
 * read off the rows: ContentTopicSelection.overflow is a flag frozen when the
 * row was inserted, and enrollmentChanges rewrites ContentMonth.videosOwed
 * when a package changes — so a Pro→Starter downgrade left eight rows flagged
 * "not overflow" against a two-video month and the panel printed a green
 * "4/2 at capacity" (review, Sep 17). The stored flag is still what the
 * per-row "beyond capacity" marker reads, because that one is about the row's
 * own history; the MONTH's arithmetic is arithmetic.
 */
export async function monthCapacity(monthId: string, db: Db = prisma): Promise<{ owed: number; selected: number; overflow: number }> {
  const m = await db.contentMonth.findUnique({ where: { id: monthId }, select: { videosOwed: true } });
  const sel = await db.contentTopicSelection.findMany({ where: { monthId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { overflow: true } });
  const owed = m?.videosOwed ?? 0;
  const total = sel.length;
  const overflow = Math.max(0, total - owed);
  return { owed, selected: total - overflow, overflow };
}

// ---- what the CLIENT may see, and what counts as stock ---------------------------

type VisibilityInput = { status: string; approvalState: string | null; source: string; proposedState: string | null; clientDeclinedAt: Date | string | null };

/**
 * May the client see this topic in their bank? (CP-07.)
 *
 * A call analysis creates its discussed ideas and its "declined on the call"
 * ideas as bank topics, PROPOSED and unreviewed — and the bank read filtered on
 * status alone, so both reached the client's page the moment the call was
 * analysed (ContentTopic.clientVisible, "server-enforced", was read nowhere).
 * Jordan's rule: an AI- or call-generated topic is not the client's until he
 * approves it. The exception is the call's own PROPOSED selection for a month,
 * which the portal shows as "proposed on your call" — the client chose it out
 * loud. The client's own ideas, staff topics and imported banks are visible.
 */
export function clientCanSeeTopic(t: VisibilityInput, hasLiveSelection: boolean): boolean {
  if (t.status === "REJECTED" || t.status === "ARCHIVED") return false;
  if (t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED") return false;
  if (t.clientDeclinedAt) return false;
  if (t.proposedState === "REJECTED") return false;
  if (topicSourceNeedsApproval(t.source) && t.approvalState !== "APPROVED" && !hasLiveSelection) return false;
  return true;
}

/** A topic the bank can still offer: unselected, not declined, visible to the client. What replenishment counts. */
export function isUsableStock(t: VisibilityInput): boolean {
  return ["IDEA", "SAVED", "RECOMMENDED"].includes(t.status) && clientCanSeeTopic(t, false);
}

export type SelectOutcome = "SELECTED" | "PROPOSED" | "KEPT" | "WITHHELD";

/**
 * Select a topic for a named month. One row per (topic, month) — Postgres
 * enforces it. Beyond the package capacity the selection is kept with
 * overflow=true and the caller explains it; nothing is deleted.
 *
 * A PROPOSED selection (a call, the AI) never overrides what a person decided
 * (review finding, Sep 17: a second analysis of the same call turned a
 * RECONCILED row back into PROPOSED, revived a REMOVED one and re-proposed a
 * REJECTED topic). So, for a proposal: an existing SELECTED/RECONCILED row is
 * KEPT and the mention lands on the history; a REMOVED row stays removed; a
 * REJECTED/ARCHIVED topic is WITHHELD with a DISCUSSED event. A person
 * selecting a rejected topic must reintroduce it first — on the record.
 *
 * CP-07: a person selecting a topic that is SCRIPTED and not yet filmed — a
 * script parked by a swap, or one left in a past month — re-uses that script:
 * the selection is handed to carryScriptedTopic, which moves the pointers and
 * keeps every version, so the month never drafts a second script for it.
 * `db` lets a caller run this inside its own transaction (the swap does).
 */
export async function selectTopicForMonth(topicId: string, monthId: string, opts: { source: "client" | "call" | "staff" | "ai" | "import"; actor: Actor; callRecordId?: string | null; evidence?: unknown; status?: "PROPOSED" | "SELECTED"; db?: Db }): Promise<{ overflow: boolean; capacity: { owed: number; selected: number }; outcome: SelectOutcome }> {
  const db = opts.db ?? prisma;
  const [t, m] = await Promise.all([
    db.contentTopic.findUnique({ where: { id: topicId }, select: { id: true, enrollmentId: true, clientId: true, status: true, approvalState: true, monthId: true, clientDeclinedAt: true } }),
    db.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, videosOwed: true } }),
  ]);
  if (!t || !m) throw new Error("Topic or month not found.");
  if (t.enrollmentId !== m.enrollmentId) throw new Error("That month belongs to another client.");
  const status = opts.status ?? "SELECTED";
  // THE CLIENT SAID "NOT INTERESTED" (review, Sep 24 2026). That set the topic
  // aside for good — but only rejected/archived were ruled out here, so a later
  // call that mentioned it again re-proposed it into the NEXT month (a new row,
  // so the REMOVED one below never fired): it took an allowance slot, showed on
  // the client's month card, and staff "Keep" scripted it while it was still
  // marked declined. A proposal is withheld with the mention on the record; a
  // person selecting it undoes the "not interested" first, on the record (the
  // client's own re-suggestion does exactly that in the portal).
  if (t.clientDeclinedAt) {
    if (status === "SELECTED") throw new Error("The client marked this topic \"Not interested\" — undo that first (it is recorded), then select it.");
    await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) but the client marked this "Not interested" — not re-proposed; undo that by hand if they changed their mind`, db });
    return { overflow: false, capacity: { owed: m.videosOwed, selected: (await monthCapacity(monthId, db)).selected }, outcome: "WITHHELD" };
  }
  if (status === "SELECTED" && t.status === "SCRIPTED") {
    // `monthId: { not }` alone would skip a PARKED script: SQL's `<>` is never
    // true of NULL, and a parked script is exactly the one with no month.
    const parked = await db.contentScript.findFirst({ where: { topicId, historical: false, OR: [{ monthId: null }, { monthId: { not: monthId } }] }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (parked) {
      const r = await carryScriptedTopic(topicId, monthId, { actor: opts.actor, reason: "RESELECTED", source: opts.source, db: opts.db });
      if (r.outcome === "SELECTED") return { overflow: !!r.overflow, capacity: r.capacity ?? { owed: m.videosOwed, selected: 0 }, outcome: "SELECTED" };
      if (r.refusal) throw new Error(r.refusal);
    }
  }
  const cap = await monthCapacity(monthId, db);
  const existing = await db.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId } } });
  const ruledOut = t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED";
  if (ruledOut) {
    if (status === "SELECTED") throw new Error("This topic was rejected or archived — reintroduce it first (that is recorded), then select it.");
    await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) but this topic is ${t.status === "REJECTED" || t.approvalState === "REJECTED" ? "rejected" : "archived"} — not re-proposed; reintroduce it by hand if that changed`, db });
    return { overflow: false, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "WITHHELD" };
  }
  if (status === "PROPOSED" && existing) {
    if (existing.status === "SELECTED" || existing.status === "RECONCILED" || existing.status === "CARRIED") {
      await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) — already ${existing.status.toLowerCase()} for this month by ${existing.staffUserId ?? existing.clientUserId ?? existing.source}; left as is`, db });
      return { overflow: existing.overflow, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "KEPT" };
    }
    if (existing.status === "REMOVED") {
      await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) — it was removed from this month by ${existing.removedBy ?? "staff"}; not revived, select it by hand if that changed`, db });
      return { overflow: existing.overflow, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "WITHHELD" };
    }
  }
  // A row that is live already holds its slot; a REMOVED one being revived
  // takes a slot again, so its overflow is re-derived rather than inherited.
  const live = !!existing && ALLOWANCE_SELECTION_STATUSES.includes(existing.status);
  const overflow = live ? existing!.overflow : cap.selected >= Math.max(m.videosOwed, 1);
  // …and it joins the queue NOW. The allowance is ordered by createdAt
  // (planningState.allowanceOrder — rank is never written for a selection),
  // so a revived row that kept its first pick's time jumped ahead of every
  // pick made since it was removed: re-adding A as an extra took C's slot
  // (batch-2 review, Sep 25 2026). The first pick stays on the topic's event
  // history; the row's time is its place in line.
  await db.contentTopicSelection.upsert({
    where: { topicId_monthId: { topicId, monthId } },
    create: { topicId, monthId, enrollmentId: t.enrollmentId, clientId: t.clientId, status, source: opts.source, clientUserId: opts.actor.clientUserId ?? null, staffUserId: opts.actor.staffUserId ?? null, callRecordId: opts.callRecordId ?? null, evidenceJson: opts.evidence ? JSON.stringify(opts.evidence).slice(0, 20_000) : null, overflow },
    update: { status, overflow, removedAt: null, removedBy: null, removedReason: null, replacedByTopicId: null, source: opts.source, clientUserId: opts.actor.clientUserId ?? undefined, staffUserId: opts.actor.staffUserId ?? undefined, callRecordId: opts.callRecordId ?? undefined, ...(live ? {} : { createdAt: new Date() }) },
  });
  // The legacy single pointer follows a real (non-proposed) selection so every
  // existing reader (roster, tracker, script generator) keeps working.
  if (status === "SELECTED" && !PRODUCTION_STATUSES.includes(t.status)) {
    await db.contentTopic.update({ where: { id: topicId }, data: { monthId, status: "SELECTED" } });
  }
  if (status === "SELECTED") await markRecommendationChosen(topicId, monthId, opts.actor, db).catch(() => 0);
  await recordTopicEvent(topicId, t.enrollmentId, "SELECTED", opts.actor, { monthId, fromStatus: t.status, toStatus: status === "SELECTED" ? "SELECTED" : t.status, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: overflow ? "Beyond this month's capacity — kept as overflow" : status === "PROPOSED" ? "Proposed from a call — not selected until reconciled" : null, db });
  return { overflow, capacity: { owed: m.videosOwed, selected: cap.selected + (overflow || live ? 0 : 1) }, outcome: status };
}

/**
 * Remove an uncommitted selection. CP-07: "committed" is about THIS month —
 * a script or footage for this topic IN this month — not the topic's global
 * status. The old test refused on status alone, so reconcileSelection(keep=
 * false) threw on a call's PROPOSED re-mention of a topic scripted months ago.
 * A PROPOSED row is the call's suggestion and is always removable.
 */
export async function deselectTopic(topicId: string, monthId: string, actor: Actor): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true, monthId: true } });
  if (!t) throw new Error("Topic not found.");
  const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId } }, select: { status: true } });
  if (sel?.status !== "PROPOSED") {
    const [script, footage] = await Promise.all([
      prisma.contentScript.findFirst({ where: { topicId, monthId, historical: false }, select: { id: true } }),
      prisma.contentVideo.findFirst({ where: { topicId, monthId, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } }),
    ]);
    if (script || footage) throw new Error(sel?.status === "CARRIED" ? "This is a carried-over script — swap it for another topic instead (the script is kept)." : "This topic already has a script or footage for this month — it stays on the month.");
  }
  await prisma.contentTopicSelection.updateMany({ where: { topicId, monthId, status: { in: ["SELECTED", "PROPOSED", "RECONCILED"] } }, data: { status: "REMOVED", removedAt: new Date(), removedBy: actor.staffUserId ?? actor.clientUserId ?? actor.kind, removedReason: "DESELECTED" } });
  // The legacy pointer goes back to the bank only when the topic has no script
  // anywhere: a topic scripted in an earlier month stays SCRIPTED.
  if (t.monthId === monthId) {
    const anyScript = await prisma.contentScript.findFirst({ where: { topicId, historical: false }, select: { id: true } });
    await prisma.contentTopic.update({ where: { id: topicId }, data: anyScript ? { monthId: null } : { monthId: null, status: "SAVED" } });
  }
  await recordTopicEvent(topicId, t.enrollmentId, "DESELECTED", actor, { monthId, fromStatus: t.status, toStatus: t.monthId === monthId && !PRODUCTION_STATUSES.includes(t.status) ? "SAVED" : t.status });
}

/** Staff reconcile a call's PROPOSED selections into real ones (or drop them). */
export async function reconcileSelection(topicId: string, monthId: string, keep: boolean, actor: Actor): Promise<void> {
  if (keep) {
    await selectTopicForMonth(topicId, monthId, { source: "staff", actor, status: "SELECTED" });
    await prisma.contentTopicSelection.updateMany({ where: { topicId, monthId }, data: { status: "RECONCILED", committedAt: new Date() } });
  } else {
    await deselectTopic(topicId, monthId, actor);
  }
}

// ---- approval / rejection / archive (kept apart from production status) ---------

export async function approveTopic(topicId: string, by: string): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, approvalState: true } });
  if (!t) throw new Error("Topic not found.");
  await prisma.contentTopic.update({ where: { id: topicId }, data: { approvalState: "APPROVED", approvedBy: by, approvedAt: new Date() } });
  await recordTopicEvent(topicId, t.enrollmentId, "APPROVED", { kind: "STAFF", staffUserId: by }, { fromStatus: t.approvalState, toStatus: "APPROVED" });
}

export async function rejectTopic(topicId: string, by: string, reason: string | null): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true } });
  if (!t) throw new Error("Topic not found.");
  await prisma.contentTopic.update({ where: { id: topicId }, data: { approvalState: "REJECTED", rejectionReason: reason?.slice(0, 1000) ?? null, status: "REJECTED", monthId: null } });
  await prisma.contentTopicSelection.updateMany({ where: { topicId, status: { in: ["SELECTED", "PROPOSED"] } }, data: { status: "REMOVED", removedAt: new Date(), removedBy: by } });
  await recordTopicEvent(topicId, t.enrollmentId, "REJECTED", { kind: "STAFF", staffUserId: by }, { fromStatus: t.status, toStatus: "REJECTED", note: reason });
}

export async function archiveTopic(topicId: string, by: string, reason: string | null): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true } });
  if (!t) throw new Error("Topic not found.");
  await prisma.contentTopic.update({ where: { id: topicId }, data: { approvalState: "ARCHIVED", archiveReason: reason?.slice(0, 1000) ?? null, status: "ARCHIVED", monthId: null } });
  await recordTopicEvent(topicId, t.enrollmentId, "ARCHIVED", { kind: "STAFF", staffUserId: by }, { fromStatus: t.status, toStatus: "ARCHIVED", note: reason });
}

/** Undo a rejection/archive on purpose — the only way an archived concept comes back (REINTRODUCED, on the record). */
export async function reintroduceTopic(topicId: string, by: string, note: string | null): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true } });
  if (!t) throw new Error("Topic not found.");
  await prisma.contentTopic.update({ where: { id: topicId }, data: { approvalState: "PROPOSED", status: "SAVED", rejectionReason: null, archiveReason: null } });
  await recordTopicEvent(topicId, t.enrollmentId, "REINTRODUCED", { kind: "STAFF", staffUserId: by }, { fromStatus: t.status, toStatus: "SAVED", note });
}

/** "Discussed" is an event on the topic's history — it changes no status (spec §5). */
export async function discussTopic(topicId: string, note: string, actor: Actor, sourceRef?: string | null): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true } });
  if (!t) throw new Error("Topic not found.");
  await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", actor, { note, sourceRef });
}

export async function topicHistory(topicId: string) {
  return prisma.contentTopicEvent.findMany({ where: { topicId }, orderBy: { createdAt: "asc" } });
}

// ---- the bank, grouped by pillar (Arielle's presentation) ----------------------

export type BankTopic = {
  id: string; title: string; concept: string | null; pillarId: string | null; pillarLabel: string | null; status: string; approvalState: string | null; source: string;
  audienceNeed: string | null; businessGoal: string | null; intendedMessage: string | null; monthId: string | null; importedMark: string | null; proposedState: string | null; lastEventAt: string | null;
  /** CP-07: the client said "not interested", and why (optional). */
  clientDeclinedAt: string | null; clientDeclineReason: string | null;
};
export type BankGroup = { pillarId: string | null; pillarName: string; topics: BankTopic[] };

/**
 * The bank by pillar. `declined` is returned BESIDE the groups, not inside
 * them: a topic the client set aside is not stock, is not on their page, and is
 * never re-suggested — but it is kept, with the reason, for staff to read.
 */
export async function topicBankByPillar(enrollmentId: string): Promise<{ groups: BankGroup[]; total: number; archived: number; declined: BankTopic[] }> {
  const [topics, pillars] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } }, orderBy: [{ createdAt: "asc" }] }),
    listPillars(enrollmentId),
  ]);
  const archived = await prisma.contentTopic.count({ where: { enrollmentId, status: { in: ["REJECTED", "ARCHIVED"] } } });
  const toRow = (t: (typeof topics)[number]): BankTopic => ({
    id: t.id, title: t.title, concept: t.concept, pillarId: t.pillarId, pillarLabel: t.pillar, status: t.status, approvalState: t.approvalState, source: t.source,
    audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, monthId: t.monthId, importedMark: t.importedMark, proposedState: t.proposedState, lastEventAt: t.lastEventAt?.toISOString() ?? null,
    clientDeclinedAt: t.clientDeclinedAt?.toISOString() ?? null, clientDeclineReason: t.clientDeclineReason,
  });
  const live = topics.filter((t) => !t.clientDeclinedAt);
  const groups: BankGroup[] = pillars.map((p) => ({ pillarId: p.id, pillarName: p.name, topics: live.filter((t) => t.pillarId === p.id).map(toRow) }));
  const unmapped = live.filter((t) => !t.pillarId || !pillars.some((p) => p.id === t.pillarId));
  if (unmapped.length) groups.push({ pillarId: null, pillarName: "Not yet linked to a pillar", topics: unmapped.map(toRow) });
  return { groups, total: live.length, archived, declined: topics.filter((t) => t.clientDeclinedAt).map(toRow) };
}

// ---- "Not interested" (CP-07) -----------------------------------------------------

/**
 * The client says a topic is not for them, optionally why. Nothing is deleted:
 * the topic stays on the record with the reason, leaves their bank, stops
 * counting as stock (so replenishment can fill the gap), and its title joins
 * blockedTopicHashes so no refresh offers it again. Undo is one click.
 *
 * Refused for a topic that is already COMMITTED for a month — a reconciled or
 * carried selection, or a script or footage for that month. Declining is about
 * the bank; changing a month's plan is a swap.
 */
export async function declineTopicForClient(topicId: string, actor: Actor, reason: string | null): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true, monthId: true, clientDeclinedAt: true } });
  if (!t) throw new Error("Topic not found.");
  if (t.clientDeclinedAt) return;
  const live = await prisma.contentTopicSelection.findMany({ where: { topicId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { monthId: true, status: true } });
  for (const s of live) {
    if (s.status === "RECONCILED" || s.status === "CARRIED") throw new Error("This one is already planned for a month — swap it for another topic instead.");
    const [script, footage] = await Promise.all([
      prisma.contentScript.findFirst({ where: { topicId, monthId: s.monthId, historical: false }, select: { id: true } }),
      prisma.contentVideo.findFirst({ where: { topicId, monthId: s.monthId, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } }),
    ]);
    if (script || footage) throw new Error("This one already has a script or footage — swap it for another topic instead.");
  }
  const by = actor.clientUserId ?? actor.staffUserId ?? actor.kind;
  const clean = reason?.trim().slice(0, 500) || null;
  await prisma.contentTopicSelection.updateMany({ where: { topicId, status: { in: ["SELECTED", "PROPOSED"] } }, data: { status: "REMOVED", removedAt: new Date(), removedBy: by, removedReason: "DECLINED" } });
  const anyScript = await prisma.contentScript.findFirst({ where: { topicId, historical: false }, select: { id: true } });
  await prisma.contentTopic.update({
    where: { id: topicId },
    data: { clientDeclinedAt: new Date(), clientDeclinedBy: by, clientDeclineReason: clean, ...(t.monthId ? { monthId: null } : {}), ...(t.status === "SELECTED" && !anyScript ? { status: "SAVED" } : {}) },
  });
  await recordTopicEvent(topicId, t.enrollmentId, "DECLINED", actor, { fromStatus: t.status, note: clean ? `Not interested: ${clean}` : "Not interested (no reason given)" });
}

/** Undo "not interested" — back in their bank, on the record. */
export async function undeclineTopicForClient(topicId: string, actor: Actor): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true, clientDeclinedAt: true } });
  if (!t) throw new Error("Topic not found.");
  if (!t.clientDeclinedAt) return;
  await prisma.contentTopic.update({ where: { id: topicId }, data: { clientDeclinedAt: null, clientDeclinedBy: null, clientDeclineReason: null } });
  await recordTopicEvent(topicId, t.enrollmentId, "REINTRODUCED", actor, { fromStatus: t.status, toStatus: t.status, note: "Back in the bank — the \"not interested\" was undone" });
}

/**
 * The client typed an idea that is already on file but HIDDEN from them — a
 * call's or the AI's topic Jordan has not approved, or one the call recorded as
 * a proposed rejection (review, Sep 24 2026). createTopic de-duplicates onto
 * that row, and the portal used to answer "We already have that idea on your
 * list" about a topic the client could neither see nor select. Jordan's rule is
 * that a client's own idea is usable without approval, so the row becomes
 * theirs: source "client", their words and name on it, the call's proposed
 * rejection cleared — and the event keeps where it came from. Nothing else
 * moves (approval state, pillar, history). Returns false if it was already
 * visible, or is not this enrollment's.
 */
export async function adoptTopicAsClientIdea(topicId: string, enrollmentId: string, actor: Actor, wording: string): Promise<boolean> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true } });
  if (!t || t.enrollmentId !== enrollmentId) return false;
  const live = (await prisma.contentTopicSelection.count({ where: { topicId, status: { in: ALLOWANCE_SELECTION_STATUSES } } })) > 0;
  if (clientCanSeeTopic({ ...t, clientDeclinedAt: null }, live)) return false;
  // Rejected or archived by the office is a conversation, not an adoption.
  if (t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED") return false;
  await prisma.contentTopic.update({
    where: { id: topicId },
    data: { source: "client", clientUserId: actor.clientUserId ?? undefined, clientWording: wording.slice(0, 200), ...(t.proposedState === "REJECTED" ? { proposedState: null } : {}) },
  });
  await recordTopicEvent(topicId, t.enrollmentId, "CREATED", actor, {
    fromStatus: t.status, toStatus: t.status,
    evidence: { adoptedFrom: { source: t.source, approvalState: t.approvalState, proposedState: t.proposedState } },
    note: `The client suggested this themselves on the portal — it was already on file (${topicSourceIsCall(t.source) ? "from a call" : t.source}${t.proposedState === "REJECTED" ? ", as a proposed rejection" : ", not yet approved"}); it is now their idea and usable without approval`,
  });
  return true;
}

/**
 * An INTERNAL flag on a client's own idea (CP-07): no pillar, or a title close
 * to something set aside before. Recorded as a DISCUSSED event by SYSTEM for
 * staff to see. It never blocks — a client's idea is usable without approval
 * (Jordan, Sep 24).
 */
export async function flagClientTopicAlignment(topicId: string): Promise<string | null> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, title: true, pillarId: true } });
  if (!t) return null;
  const notes: string[] = [];
  if (!t.pillarId) notes.push("no pillar chosen");
  const setAside = await prisma.contentTopic.findMany({
    where: { enrollmentId: t.enrollmentId, id: { not: topicId }, OR: [{ status: { in: ["REJECTED", "ARCHIVED"] } }, { approvalState: { in: ["REJECTED", "ARCHIVED"] } }, { clientDeclinedAt: { not: null } }, { proposedState: "REJECTED" }] },
    select: { title: true },
    take: 400,
  });
  const close = setAside.find((x) => normalizeTitle(x.title) === normalizeTitle(t.title) || titleSimilarity(x.title, t.title) >= NEAR_DUPLICATE_THRESHOLD);
  if (close) notes.push(`close to “${close.title}”, which was set aside before`);
  if (!notes.length) return null;
  const note = `Alignment check: ${notes.join("; ")} — the client can still use it; worth a look`;
  await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", { kind: "SYSTEM" }, { note });
  return note;
}

// ---- the call's own words about a topic (CP-07/CP-08) ------------------------------

export type TopicExcerpt = SourceExcerpt & { callRecordId: string | null; callDateISO: string | null };

/**
 * Speaker-tagged excerpts recorded for a topic by call analysis — this month's
 * selection first, else the newest event that carries evidence. Moved here
 * from contentGeneration so the interview (sufficiency, suggested answers) and
 * the script generator read ONE source. Shape-tolerant: the evidence JSON has
 * two historical shapes.
 */
export async function topicCallExcerpts(topicId: string, monthId: string | null): Promise<TopicExcerpt[]> {
  // This month's selection first; then any selection of the topic that carries
  // call excerpts (a carried topic's excerpts are on the month it came from);
  // then the newest event that does. "Carries excerpts" (a quoted line has a
  // `"text"` key in both historical shapes), not merely "has evidence": CARRIED
  // and swap events hold script ids, and taking one of those would read as "no
  // call excerpts" and quietly drop them from a revision.
  const HAS_EXCERPTS = { contains: '"text"' };
  const sel = (monthId ? await prisma.contentTopicSelection.findFirst({ where: { topicId, monthId, evidenceJson: HAS_EXCERPTS }, select: { evidenceJson: true, callRecordId: true } }) : null)
    ?? (await prisma.contentTopicSelection.findFirst({ where: { topicId, evidenceJson: HAS_EXCERPTS }, orderBy: { createdAt: "desc" }, select: { evidenceJson: true, callRecordId: true } }));
  let ev = sel?.evidenceJson ?? null;
  let callRecordId = sel?.callRecordId ?? null;
  if (!ev) {
    const e = await prisma.contentTopicEvent.findFirst({ where: { topicId, evidenceJson: HAS_EXCERPTS }, orderBy: { createdAt: "desc" }, select: { evidenceJson: true, sourceRef: true } });
    ev = e?.evidenceJson ?? null;
    if (e?.sourceRef?.startsWith("ProgramCallRecord:")) callRecordId = e.sourceRef.slice("ProgramCallRecord:".length);
  }
  if (!ev) return [];
  let arr: unknown[] = [];
  try {
    const v = JSON.parse(ev) as { excerpts?: unknown[] } | unknown[];
    arr = Array.isArray(v) ? v : Array.isArray(v?.excerpts) ? v.excerpts : [];
  } catch { return []; }
  const call = callRecordId ? await prisma.programCallRecord.findUnique({ where: { id: callRecordId }, select: { scheduledStart: true } }).catch(() => null) : null;
  return arr
    .filter((x): x is { speaker?: string; speakerName?: string | null; source?: string; text: string } => !!x && typeof (x as { text?: unknown }).text === "string")
    .map((x): TopicExcerpt => ({
      speaker: x.speaker === "client" || x.speaker === "jordan" ? x.speaker : "third-party",
      speakerName: x.speakerName ?? null, source: x.source ?? "call", text: x.text.slice(0, 1200),
      callRecordId, callDateISO: call?.scheduledStart?.toISOString() ?? null,
    }))
    .slice(0, 12);
}

/**
 * The excerpts that may reach anything a client could read — a question, a
 * suggested answer, a script. The raw excerpt list applied no confidentiality
 * filter at all (excerptsForTopic, found Sep 24), so this drops:
 *   · a line carrying a [CONFIDENTIAL] mark, or saying it is private
 *     ("between you and me", "off the record" — A09, Sep 25 2026);
 *   · a line that overlaps a confidential ClientFact of this client (same
 *     words, or most of the fact's content words);
 *   · a line naming another enrolled client (scrubOtherClients).
 * The first two are clientFacts.confidentialFilter — the one test the
 * strategy draft and the strategy release guard use too.
 */
export async function safeTopicExcerpts(topicId: string, monthId: string | null, clientId: string): Promise<{ kept: TopicExcerpt[]; stripped: number }> {
  const raw = await topicCallExcerpts(topicId, monthId);
  if (!raw.length) return { kept: [], stripped: 0 };
  const secret = await confidentialFilter(clientId);
  const cleared = raw.filter((e) => !secret(e.text));
  const { scrubOtherClients } = await import("@/lib/contentGeneration");
  const scrub = await scrubOtherClients(clientId, cleared.map((e) => e.text));
  const kept = cleared.filter((e) => scrub.kept.includes(e.text));
  return { kept, stripped: raw.length - kept.length };
}

// ---- refresh runs + suggestions ---------------------------------------------------

export type RefreshKind = "BANK" | "REFRESH" | "RECOMMENDATION";

/** Everything a refresh must not re-suggest: archived/rejected topics, topics the client said "not interested" to (CP-07), and archived suggestions, by dedupe hash. A HELD suggestion (6.3, Sep 25) counts as archived until staff release it. */
export async function blockedTopicHashes(enrollmentId: string): Promise<Set<string>> {
  const [topics, suggs] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId, OR: [{ status: { in: ["REJECTED", "ARCHIVED"] } }, { approvalState: { in: ["REJECTED", "ARCHIVED"] } }, { clientDeclinedAt: { not: null } }] }, select: { title: true, dedupeHash: true } }),
    prisma.contentTopicSuggestion.findMany({ where: { enrollmentId, disposition: { in: ["ARCHIVED", "HELD"] } }, select: { title: true, dedupeHash: true } }),
  ]);
  const set = new Set<string>();
  for (const r of [...topics, ...suggs]) set.add(r.dedupeHash ?? topicDedupeHash(r.title));
  return set;
}

/** Suggestions still PENDING from earlier runs, by dedupe hash — a refresh must not offer the same title twice (review finding). */
export async function pendingSuggestionHashes(enrollmentId: string): Promise<Set<string>> {
  const rows = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId, disposition: "PENDING" }, select: { title: true, dedupeHash: true } });
  return new Set(rows.map((r) => r.dedupeHash ?? topicDedupeHash(r.title)));
}

type RefreshRequest = { enrollmentId: string; kind: RefreshKind; monthId?: string | null; topicsPerPillar?: number | null; pillarId?: string | null; keep?: number | null };

/**
 * The run's inputs and its dedupe key — ONE computation, so a person's click
 * and the unattended queue collide on the same key for the same work (a click
 * while the cron's run is queued claims that run instead of paying twice).
 */
async function refreshPlan(opts: RefreshRequest) {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: opts.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(opts.enrollmentId)]);
  // The prompt's count stays inside the policy's band (10–15: the bank prompt
  // refuses anything else); how many of the results are KEPT is `keep`.
  const perPillar = Math.min(Math.max(opts.topicsPerPillar ?? policy.topicsPerPillar, GENERATION_POLICY.topicsPerPillar.min), policy.topicsPerPillarMax);
  const keep = opts.keep && opts.keep > 0 ? Math.floor(opts.keep) : null;
  const inputsHash = sha256(JSON.stringify({ s: strategy?.versionId ?? null, p: policy.id, n: perPillar, m: opts.monthId ?? null, pillar: opts.pillarId ?? null, keep }));
  return {
    clientId: e.clientId, policyId: policy.id, strategyVersionId: strategy?.versionId ?? null, perPillar, keep,
    dedupeKey: `${opts.enrollmentId}:${opts.kind}:${inputsHash}`,
    inputs: { strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id, topicsPerPillar: perPillar, pillarId: opts.pillarId ?? null, keep },
  };
}

/** A run left RUNNING past its lease (function timeout, deploy mid-call) must not hold the dedupe key forever — every later click would "join" a corpse. */
async function expireStaleRefreshLeases(): Promise<void> {
  await prisma.contentTopicRefreshRun.updateMany({
    where: { status: "RUNNING", leaseUntil: { lt: new Date() } },
    data: { status: "FAILED", lastError: "Lease expired — the run never finished (timed out or the server restarted). Start it again.", lastErrorAt: new Date(), finishedAt: new Date(), dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
}

/** Take a QUEUED run for execution. count === 1 is the only proof the run is ours. */
async function claimQueuedRun(runId: string, leaseBy: string): Promise<boolean> {
  const r = await prisma.contentTopicRefreshRun.updateMany({
    where: { id: runId, status: "QUEUED" },
    data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 10 * 60_000), leaseBy, attempts: { increment: 1 }, startedAt: new Date(), nextAttemptAt: null },
  });
  return r.count === 1;
}

/**
 * Start (or join) a refresh run. Duplicate clicks with the same inputs
 * collide on dedupeKey while a run is active → the caller gets the existing
 * run back. Execution is synchronous for a staff click (the AI half is in
 * contentGeneration.ts); the row records lease/attempts either way.
 *
 * CP-07: a person's whole-bank click (no pillar) takes over a whole-bank run
 * the queue is still holding — approving a strategy queues one, and it only
 * runs once `topic_refresh` is on. Joining it would have told Jordan "already
 * running" about a job that may never start; running it is what he asked for.
 */
export async function startTopicRefresh(opts: RefreshRequest & { requestedBy: string; unattended?: boolean; /** Store only the top N new suggestions (a single-suggestion regeneration keeps 1); the prompt itself always asks for the policy's count. */ keep?: number | null }): Promise<{ runId: string; joined: boolean }> {
  const plan = await refreshPlan(opts);
  const { dedupeKey, keep } = plan;
  await expireStaleRefreshLeases();
  const person = !opts.unattended;
  const active = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, status: true } });
  if (active && !(person && active.status === "QUEUED")) return { runId: active.id, joined: true };
  const queuedWhole = person && !opts.pillarId && !keep && opts.kind !== "RECOMMENDATION"
    ? active ?? (await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: opts.enrollmentId, status: "QUEUED", kind: { in: ["BANK", "REFRESH"] } }, orderBy: { createdAt: "asc" }, select: { id: true, inputsJson: true } }))
        .find((r) => { try { return !(JSON.parse(r.inputsJson ?? "{}") as { pillarId?: string | null }).pillarId; } catch { return false; } }) ?? null
    : active;
  if (queuedWhole && (await claimQueuedRun(queuedWhole.id, opts.requestedBy))) {
    // The queued row's own inputs, not this click's: it may be a pillar refill
    // with the same key, and its `keep` is part of what was asked for.
    const row = await prisma.contentTopicRefreshRun.findUnique({ where: { id: queuedWhole.id }, select: { inputsJson: true } });
    let inputs: { pillarId?: string | null; keep?: number | null } = {};
    try { inputs = JSON.parse(row?.inputsJson ?? "{}"); } catch { inputs = {}; }
    await executeClaimedRefresh(queuedWhole.id, { unattended: false, pillarId: inputs.pillarId ?? null, keep: inputs.keep ?? null });
    return { runId: queuedWhole.id, joined: false };
  }
  if (active) return { runId: active.id, joined: true };
  let runId: string;
  try {
    const row = await prisma.contentTopicRefreshRun.create({
      data: {
        enrollmentId: opts.enrollmentId, clientId: plan.clientId, kind: opts.kind, strategyVersionId: plan.strategyVersionId, policyVersionId: plan.policyId,
        requestedBy: opts.requestedBy, monthId: opts.monthId ?? null, status: "RUNNING", attempts: 1, leaseUntil: new Date(Date.now() + 10 * 60_000), leaseBy: opts.requestedBy,
        topicsPerPillar: plan.perPillar, dedupeKey, startedAt: new Date(),
        inputsJson: JSON.stringify(plan.inputs),
      },
      select: { id: true },
    });
    runId = row.id;
  } catch {
    const again = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    if (again) return { runId: again.id, joined: true };
    throw new Error("Could not start the refresh.");
  }
  if (opts.kind === "RECOMMENDATION") {
    try { await executeRecommendationRun(runId); } catch (e) { await failRefreshRun(runId, e); throw e; }
  } else {
    await executeClaimedRefresh(runId, { unattended: opts.unattended ?? false, pillarId: opts.pillarId ?? null, keep });
  }
  return { runId, joined: false };
}

async function failRefreshRun(runId: string, e: unknown): Promise<void> {
  await prisma.contentTopicRefreshRun.update({ where: { id: runId }, data: { status: "FAILED", lastError: (e instanceof Error ? e.message : String(e)).slice(0, 2000), lastErrorAt: new Date(), finishedAt: new Date(), dedupeKey: null, leaseUntil: null, leaseBy: null } }).catch(() => {});
}

/** Run a BANK/REFRESH row we hold the lease on. A failure is recorded and rethrown; the caller decides whether a closed switch is a pause. */
async function executeClaimedRefresh(runId: string, o: { unattended: boolean; pillarId: string | null; keep: number | null }): Promise<void> {
  const { executeTopicRefreshRun } = await import("@/lib/contentGeneration");
  try {
    await executeTopicRefreshRun(runId, o);
  } catch (e) {
    // A closed switch is a PAUSE, not a failure (the transcriptJobs rule,
    // 4b8658e): the run goes back on the queue with its attempt refunded, so
    // turning `ai_runs` back on resumes it instead of leaving a FAILED row
    // somebody has to notice and re-click.
    if (e instanceof Error && e.name === "AutomationDisabledError") {
      await prisma.contentTopicRefreshRun.update({ where: { id: runId }, data: { status: "QUEUED", attempts: { decrement: 1 }, leaseUntil: null, leaseBy: null, startedAt: null } }).catch(() => {});
    } else {
      await failRefreshRun(runId, e);
    }
    throw e;
  }
}

// ---- the bank keeps itself stocked (CP-07) -------------------------------------------
//
// Until today the ONLY callers of bank generation were two staff buttons. The
// onboarding ladder "checked for" a bank run and nothing created one, and
// `topic_refresh` — the switch the settings screen said gated this — was read by
// nothing at all. Now:
//   · approving a strategy QUEUES the initial bank (no AI call, no spend);
//   · the hourly sweep, behind `topic_refresh`, runs queued work and queues a
//     per-pillar refill when a pillar's usable stock falls below the policy's
//     target (10) — pending suggestions count as stock, so an unreviewed
//     backlog stops new spend, and a pillar is refilled at most once a week;
//   · `ai_runs` still gates the model call underneath, and a closed switch puts
//     the run back on the queue rather than failing it.
// Suggestions are what a run produces, never topics: Jordan approves every
// AI topic before a client can see it.

/** Queue a BANK/REFRESH run for the unattended drain. Spends nothing. Joins an active run with the same inputs. */
export async function queueTopicRefresh(opts: { enrollmentId: string; kind: "BANK" | "REFRESH"; requestedBy: string; pillarId?: string | null; keep?: number | null; reason: string }): Promise<{ runId: string; joined: boolean }> {
  const plan = await refreshPlan(opts);
  await expireStaleRefreshLeases();
  const active = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey: plan.dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (active) return { runId: active.id, joined: true };
  try {
    const row = await prisma.contentTopicRefreshRun.create({
      data: {
        enrollmentId: opts.enrollmentId, clientId: plan.clientId, kind: opts.kind, strategyVersionId: plan.strategyVersionId, policyVersionId: plan.policyId,
        requestedBy: opts.requestedBy, status: "QUEUED", attempts: 0, topicsPerPillar: plan.perPillar, dedupeKey: plan.dedupeKey,
        inputsJson: JSON.stringify({ ...plan.inputs, reason: opts.reason.slice(0, 200) }),
      },
      select: { id: true },
    });
    return { runId: row.id, joined: false };
  } catch {
    const again = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey: plan.dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    if (again) return { runId: again.id, joined: true };
    throw new Error("Could not queue the topic bank.");
  }
}

/** Run up to `max` queued BANK/REFRESH runs, oldest first. A closed `ai_runs` switch stops the drain and leaves every run queued. */
export async function drainTopicRefreshQueue(opts: { max?: number; budgetMs?: number; now?: Date } = {}): Promise<{ ran: number; succeeded: number; failed: number; paused: string | null; lastError: string | null }> {
  const started = Date.now();
  const max = opts.max ?? 2;
  const budgetMs = opts.budgetMs ?? 60_000;
  await expireStaleRefreshLeases();
  const now = opts.now ?? new Date();
  const due = await prisma.contentTopicRefreshRun.findMany({
    where: { status: "QUEUED", kind: { in: ["BANK", "REFRESH"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    take: max * 3,
    select: { id: true, enrollmentId: true, inputsJson: true },
  });
  let ran = 0, succeeded = 0, failed = 0;
  let paused: string | null = null;
  let lastError: string | null = null;
  for (const run of due) {
    if (ran >= max || Date.now() - started > budgetMs) break;
    if (!(await claimQueuedRun(run.id, "topic-bank-cron"))) continue;
    ran++;
    let inputs: { pillarId?: string | null; keep?: number | null } = {};
    try { inputs = JSON.parse(run.inputsJson ?? "{}"); } catch { inputs = {}; }
    try {
      await executeClaimedRefresh(run.id, { unattended: true, pillarId: inputs.pillarId ?? null, keep: inputs.keep ?? null });
      const done = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run.id }, select: { status: true, generatedCount: true } });
      if (done?.status === "SUCCEEDED") {
        succeeded++;
        if (done.generatedCount > 0) await bellSuggestionsReady(run.id, run.enrollmentId, done.generatedCount);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "AutomationDisabledError") { paused = msg.slice(0, 300); ran--; break; }
      failed++;
      lastError = msg.slice(0, 300);
    }
  }
  return { ran, succeeded, failed, paused, lastError };
}

/** Jordan's bell when unattended suggestions are waiting. Internal; never for a TEST client. */
async function bellSuggestionsReady(runId: string, enrollmentId: string, n: number): Promise<void> {
  try {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
    const c = e ? await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }) : null;
    const { isTestClientName } = await import("@/lib/testClients");
    if (isTestClientName(c?.name)) return;
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "topic_suggestions_ready",
      title: `Topic suggestions to review — ${c?.name ?? "client"}`.slice(0, 90),
      body: `${n} new suggestion${n === 1 ? "" : "s"} for the bank. Nothing reaches the client until you accept it.`,
      href: `/content/${enrollmentId}?tab=ideas`,
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `topic-suggestions:${runId}`,
    });
  } catch { /* the bell is best-effort; the suggestions are on the Video Topics tab either way */ }
}

export type PillarStock = { pillarId: string; pillarName: string; usable: number; pending: number; declined: number; target: number; need: number };

/** Usable topics per active pillar against the policy's target. Pending suggestions count — Jordan's backlog is stock he has not reviewed yet. */
export async function bankStock(enrollmentId: string): Promise<PillarStock[]> {
  const [policy, pillars, topics, pending] = await Promise.all([
    activePolicyVersion(),
    listPillars(enrollmentId),
    prisma.contentTopic.findMany({ where: { enrollmentId, pillarId: { not: null } }, select: { pillarId: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true } }),
    prisma.contentTopicSuggestion.groupBy({ by: ["pillarId"], where: { enrollmentId, disposition: "PENDING", kind: "BANK" }, _count: { _all: true } }),
  ]);
  const target = policy.topicsPerPillar;
  return pillars.map((p) => {
    const mine = topics.filter((t) => t.pillarId === p.id);
    const usable = mine.filter(isUsableStock).length;
    const waiting = pending.find((g) => g.pillarId === p.id)?._count._all ?? 0;
    return { pillarId: p.id, pillarName: p.name, usable, pending: waiting, declined: mine.filter((t) => t.clientDeclinedAt).length, target, need: Math.max(0, target - usable - waiting) };
  });
}

const REFILL_COOLDOWN_MS = 7 * 86_400_000;
const FAILED_INITIAL_BACKOFF_MS = 86_400_000;

/**
 * HOURLY, behind `topic_refresh`. For each ACTIVE enrollment with an approved
 * strategy and pillars: queue the initial bank if none has run since the
 * approval, else queue a targeted refill for each pillar below target (at most
 * once a week per pillar). Then drain. Nothing here reaches a client.
 */
export async function sweepTopicBanks(opts: { max?: number; budgetMs?: number; now?: Date } = {}): Promise<{ skipped: string } | { queued: number; initial: number; refills: number; drained: Awaited<ReturnType<typeof drainTopicRefreshQueue>> }> {
  if (!(await isAutomationEnabled("topic_refresh"))) return { skipped: "topic_refresh is off" };
  const now = opts.now ?? new Date();
  let queued = 0, initial = 0, refills = 0;
  let lastError: string | null = null;
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  for (const e of live) {
    try {
      const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: e.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { approvedAt: true, createdAt: true } });
      if (!approved) continue;
      const pillars = await listPillars(e.id);
      if (!pillars.length) continue;
      const since = approved.approvedAt ?? approved.createdAt;
      const runs = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: e.id, kind: { in: ["BANK", "REFRESH"] }, createdAt: { gte: since } }, select: { status: true, inputsJson: true, createdAt: true } });
      const counted = runs.filter((r) => r.status !== "FAILED" && r.status !== "CANCELLED");
      if (!counted.length) {
        // A run that failed in the last day is not retried every hour — a
        // deterministic failure would otherwise be a 16k-token loop.
        if (runs.some((r) => r.status === "FAILED" && r.createdAt.getTime() > now.getTime() - FAILED_INITIAL_BACKOFF_MS)) continue;
        const bankTopics = await prisma.contentTopic.count({ where: { enrollmentId: e.id, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
        const r = await queueTopicRefresh({ enrollmentId: e.id, kind: bankTopics ? "REFRESH" : "BANK", requestedBy: "cron", reason: "initial bank after strategy approval" });
        if (!r.joined) { queued++; initial++; }
        continue;
      }
      const pillarOf = (r: { inputsJson: string | null }) => { try { return (JSON.parse(r.inputsJson ?? "{}") as { pillarId?: string | null }).pillarId ?? null; } catch { return null; } };
      const active = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: e.id, kind: { in: ["BANK", "REFRESH"] }, status: { in: ["QUEUED", "RUNNING"] } }, select: { inputsJson: true } });
      // A whole-bank run still waiting covers every pillar.
      if (active.some((r) => !pillarOf(r))) continue;
      // The weekly cooldown is per pillar and counts only that pillar's own
      // refills, whatever became of them.
      const recent = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: e.id, kind: "REFRESH", createdAt: { gte: new Date(now.getTime() - REFILL_COOLDOWN_MS) } }, select: { inputsJson: true } });
      for (const p of await bankStock(e.id)) {
        if (p.need <= 0) continue;
        if (active.some((r) => pillarOf(r) === p.pillarId) || recent.some((r) => pillarOf(r) === p.pillarId)) continue;
        const r = await queueTopicRefresh({ enrollmentId: e.id, kind: "REFRESH", requestedBy: "cron", pillarId: p.pillarId, keep: p.need, reason: `${p.pillarName}: ${p.usable} usable + ${p.pending} pending of ${p.target}` });
        if (!r.joined) { queued++; refills++; }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  const drained = await drainTopicRefreshQueue({ max: opts.max ?? 2, budgetMs: opts.budgetMs ?? 60_000, now });
  // A pause Jordan asked for is not an error on the monitoring screen.
  await recordAutomationRun("topic_refresh", lastError ?? drained.lastError).catch(() => {});
  return { queued, initial, refills, drained };
}

export async function finishRefreshRun(runId: string, patch: { status: "SUCCEEDED" | "NEEDS_INPUT" | "FAILED"; generatedCount?: number; changeSummary?: string | null; missingContext?: unknown; pillarCount?: number; aiRunId?: string | null; lastError?: string | null }): Promise<void> {
  await prisma.contentTopicRefreshRun.update({
    where: { id: runId },
    data: {
      status: patch.status, generatedCount: patch.generatedCount ?? 0, changeSummary: patch.changeSummary ?? null, missingContextJson: patch.missingContext ? JSON.stringify(patch.missingContext) : null,
      pillarCount: patch.pillarCount ?? null, aiRunId: patch.aiRunId ?? null, lastError: patch.lastError ?? null, lastErrorAt: patch.lastError ? new Date() : null, finishedAt: new Date(), dedupeKey: null, leaseUntil: null, leaseBy: null,
    },
  });
}

export async function refreshRuns(enrollmentId: string, take = 10) {
  return prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, take });
}

export async function pendingSuggestions(enrollmentId: string, kind?: "BANK" | "RECOMMENDED" | "ALTERNATIVE") {
  return prisma.contentTopicSuggestion.findMany({ where: { enrollmentId, disposition: "PENDING", ...(kind ? { kind } : {}) }, orderBy: [{ pillarId: "asc" }, { rank: "asc" }, { createdAt: "asc" }] });
}

/** Accept a suggestion → a real bank topic (or, for a recommendation, a selection of its bank topic for the month). */
export async function acceptSuggestion(suggestionId: string, by: string, opts: { edits?: { title?: string; description?: string | null; audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null }; monthId?: string | null } = {}): Promise<{ topicId: string }> {
  const s = await prisma.contentTopicSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s || s.disposition !== "PENDING") throw new Error("That suggestion was already handled.");
  const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: s.refreshRunId }, select: { monthId: true } });
  const actor: Actor = { kind: "STAFF", staffUserId: by };
  let topicId: string;
  if (s.kind === "RECOMMENDED" && s.relatedTopicId) {
    topicId = s.relatedTopicId;
    const monthId = opts.monthId ?? run?.monthId ?? null;
    if (monthId) await selectTopicForMonth(topicId, monthId, { source: "staff", actor, evidence: { suggestionId, whyNow: s.whyNow, linkedGoal: s.linkedGoal } });
  } else {
    const edited = opts.edits ?? {};
    const r = await createTopic({
      enrollmentId: s.enrollmentId, title: edited.title ?? s.title, concept: edited.description ?? s.description, pillarId: s.pillarId,
      audienceNeed: edited.audienceNeed ?? s.audienceNeed, businessGoal: edited.businessGoal ?? s.businessGoal, intendedMessage: edited.intendedMessage ?? s.intendedMessage,
      source: "ai", sourceRef: `refresh:${s.refreshRunId}`, suggestionId, status: "SAVED", approvalState: "APPROVED", actor, eventKind: "SUGGESTED", note: `Accepted from a topic refresh by ${by}${Object.keys(edited).length ? " (edited)" : ""}`,
    });
    topicId = r.id;
    await prisma.contentTopic.update({ where: { id: topicId }, data: { approvedBy: by, approvedAt: new Date() } });
    if (opts.monthId) await selectTopicForMonth(topicId, opts.monthId, { source: "staff", actor });
  }
  await prisma.contentTopicSuggestion.update({ where: { id: suggestionId }, data: { disposition: opts.edits && Object.keys(opts.edits).length ? "EDITED" : "ACCEPTED", dispositionBy: by, dispositionAt: new Date(), acceptedTopicId: topicId } });
  return { topicId };
}

/** Archive a suggestion: remembered by dedupeHash, never re-suggested unless explicitly reintroduced. */
export async function archiveSuggestion(suggestionId: string, by: string): Promise<void> {
  const s = await prisma.contentTopicSuggestion.findUnique({ where: { id: suggestionId }, select: { title: true, dedupeHash: true } });
  if (!s) throw new Error("Suggestion not found.");
  await prisma.contentTopicSuggestion.update({ where: { id: suggestionId }, data: { disposition: "ARCHIVED", dispositionBy: by, dispositionAt: new Date(), dedupeHash: s.dedupeHash ?? topicDedupeHash(s.title) } });
}

/** Regenerate ONE suggestion: mark it REGENERATED and run a one-topic refresh for its pillar. */
export async function regenerateSuggestion(suggestionId: string, by: string): Promise<{ runId: string }> {
  const s = await prisma.contentTopicSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s || s.disposition !== "PENDING") throw new Error("That suggestion was already handled.");
  await prisma.contentTopicSuggestion.update({ where: { id: suggestionId }, data: { disposition: "REGENERATED", dispositionBy: by, dispositionAt: new Date(), dedupeHash: s.dedupeHash ?? topicDedupeHash(s.title) } });
  const { executeSingleSuggestionRegeneration } = await import("@/lib/contentGeneration");
  return executeSingleSuggestionRegeneration(s, by);
}

// ---- "Recommended for next session" (pure ranking; verified history only) -----------

/**
 * Verified filming history = evidence, never inference: a ContentVideo with
 * a filmedAt/delivered status linked to a topic, or a topic on a month whose
 * filming session (Project) is SHOT/DELIVERED. Imported scripts and
 * selections are NOT history. null = no verified history at all.
 */
export async function verifiedFilmingHistory(enrollmentId: string): Promise<FilmedRecord[] | null> {
  const pillars = await listPillars(enrollmentId, { includeRetired: true });
  const nameOf = (id: string | null, label: string | null) => pillars.find((p) => p.id === id)?.name ?? label ?? "(no pillar)";
  const out: FilmedRecord[] = [];
  const videos = await prisma.contentVideo.findMany({ where: { enrollmentId, topicId: { not: null }, OR: [{ filmedAt: { not: null } }, { status: { in: ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"] } }] }, select: { topicId: true, title: true, pillarId: true, filmedAt: true, deliveredAt: true, createdAt: true } });
  const topicIds = videos.map((v) => v.topicId!).filter(Boolean);
  const topics = topicIds.length ? await prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true, pillarId: true, pillar: true } }) : [];
  for (const v of videos) {
    const t = topics.find((x) => x.id === v.topicId);
    out.push({ topicId: v.topicId, title: t?.title ?? v.title ?? "(untitled)", pillarName: nameOf(v.pillarId ?? t?.pillarId ?? null, t?.pillar ?? null), filmedAt: (v.filmedAt ?? v.deliveredAt ?? v.createdAt).toISOString(), verified: true });
  }
  // Topics marked FILMED/DELIVERED whose month has a shot/delivered session.
  const filmedTopics = await prisma.contentTopic.findMany({ where: { enrollmentId, status: { in: ["FILMED", "DELIVERED"] }, monthId: { not: null } }, select: { id: true, title: true, pillarId: true, pillar: true, monthId: true, updatedAt: true } });
  if (filmedTopics.length) {
    const projects = await prisma.project.findMany({ where: { contentMonthId: { in: filmedTopics.map((t) => t.monthId!) }, status: { in: ["SHOT", "EDITING", "REVIEW", "DELIVERED"] as never[] } }, select: { contentMonthId: true, shootDate: true } });
    for (const t of filmedTopics) {
      const p = projects.find((x) => x.contentMonthId === t.monthId);
      if (!p) continue;
      if (out.some((o) => o.topicId === t.id)) continue;
      out.push({ topicId: t.id, title: t.title, pillarName: nameOf(t.pillarId, t.pillar), filmedAt: (p.shootDate ?? t.updatedAt).toISOString(), verified: true });
    }
  }
  // TOPIC-linked evidence only. Approved cuts, delivered sessions or library
  // rows that no topic is linked to are real filming, but they say nothing
  // about WHICH topics were filmed — so the ranking honestly reports "No
  // verified filming history" (null) rather than pretending every topic is new
  // against a blank slate; unlinkedFilmingEvidence() surfaces the count so
  // staff can link them (spec §9) and the next ranking improves.
  return out.length ? out : null;
}

/** Approved cuts / library rows / delivered sessions on this enrollment that no topic is linked to yet — evidence waiting for a link, not history. */
export async function unlinkedFilmingEvidence(enrollmentId: string): Promise<{ approvedCuts: number; libraryVideos: number; deliveredSessions: number }> {
  const monthIds = (await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true } })).map((m) => m.id);
  const projectIds = monthIds.length ? (await prisma.project.findMany({ where: { contentMonthId: { in: monthIds } }, select: { id: true, status: true } })) : [];
  const [approvedCuts, libraryVideos] = await Promise.all([
    projectIds.length ? prisma.reviewSubmission.count({ where: { projectId: { in: projectIds.map((p) => p.id) }, status: "APPROVED", videoId: null } }) : Promise.resolve(0),
    prisma.portalVideo.count({ where: { enrollmentId, videoId: null } }),
  ]);
  return { approvedCuts, libraryVideos, deliveredSessions: projectIds.filter((p) => p.status === "DELIVERED").length };
}

function toPolicyTopic(t: { id: string; clientId: string; title: string; concept: string | null; pillarId: string | null; pillar: string | null; audienceNeed: string | null; businessGoal: string | null; intendedMessage: string | null; source: string; status: string; monthId: string | null }, pillarName: string): Topic {
  const state: Topic["state"] = t.status === "SELECTED" || t.status === "SCRIPTED" ? "SELECTED" : t.status === "FILMED" || t.status === "DELIVERED" || t.status === "EDITING" ? "FILMED" : t.status === "REJECTED" || t.status === "ARCHIVED" ? "ARCHIVED" : "SUGGESTED";
  return {
    id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage,
    source: t.source === "import" ? "IMPORTED" : t.source === "client" ? "CLIENT_SUGGESTED" : topicSourceIsCall(t.source) ? "CALL" : t.source === "staff" ? "STAFF" : "GENERATED",
    sourceRef: null, state, selectedForMonth: t.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: null, stamp: null,
  };
}

/** The pure ranking over the bank → ContentTopicSuggestion rows kind=RECOMMENDED (no AI call). */
export async function executeRecommendationRun(runId: string): Promise<void> {
  const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Run not found.");
  const [strategy, pillars, history, e, unlinked] = await Promise.all([approvedStrategy(run.enrollmentId), listPillars(run.enrollmentId, { includeRetired: true }), verifiedFilmingHistory(run.enrollmentId), prisma.contentEnrollment.findUnique({ where: { id: run.enrollmentId }, select: { videosPerMonth: true } }), unlinkedFilmingEvidence(run.enrollmentId)]);
  const unlinkedNote = unlinked.approvedCuts + unlinked.libraryVideos + unlinked.deliveredSessions > 0 ? ` · ${unlinked.approvedCuts} approved cut(s), ${unlinked.libraryVideos} library video(s), ${unlinked.deliveredSessions} delivered session(s) not linked to any topic yet` : "";
  const nameOf = (id: string | null, label: string | null) => pillars.find((p) => p.id === id)?.name ?? label ?? "(no pillar)";
  // 6.3 (Sep 25 2026): ONLY THE SLOTS THAT ARE LEFT. This recommended a full
  // package's worth (enrollment.videosPerMonth) on top of whatever the month
  // already held — carried-over scripts included — so a month owing 4 with one
  // carried script got 4 recommendations for 3 open slots. The month's own
  // arithmetic (monthCapacity: CARRIED counts) decides now, and a full month
  // gets no ranking at all.
  const cap = run.monthId ? await monthCapacity(run.monthId) : null;
  if (cap && cap.owed - cap.selected <= 0) {
    await finishRefreshRun(runId, { status: "NEEDS_INPUT", missingContext: { missing: [`This month already has its ${cap.owed} video${cap.owed === 1 ? "" : "s"} chosen (carried-over scripts count) — nothing left to recommend.`] }, changeSummary: "month already full" });
    return;
  }
  // The bank a CLIENT could choose from: visible to them, not set aside, and
  // not already on an open month's plan (a topic chosen for October is not a
  // recommendation for November).
  const openMonths = await prisma.contentMonth.findMany({ where: { enrollmentId: run.enrollmentId, historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] } }, select: { id: true } });
  const planned = new Set((await prisma.contentTopicSelection.findMany({ where: { enrollmentId: run.enrollmentId, monthId: { in: openMonths.map((m) => m.id) }, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true } })).map((x) => x.topicId));
  const bankRows = (await prisma.contentTopic.findMany({ where: { enrollmentId: run.enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } } }))
    .filter((t) => !t.clientDeclinedAt && !planned.has(t.id) && clientCanSeeTopic(t, false));
  const bank = bankRows.map((t) => toPolicyTopic(t, nameOf(t.pillarId, t.pillar)));
  const goals: StrategyGoal[] = (strategy?.document?.contentGoals.items ?? []).map((g, i) => ({ id: `goal-${i + 1}`, text: g }));
  const scriptsRows = await prisma.contentScript.findMany({ where: { enrollmentId: run.enrollmentId }, select: { topicId: true, title: true, status: true, monthId: true, pillarId: true } });
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId: run.enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const priorScripts: PriorScript[] = scriptsRows.map((s) => ({ topicId: s.topicId, title: s.title, pillarName: nameOf(s.pillarId, null), status: s.status === "INTERNAL_REVIEW" || s.status === "DRAFT" ? "DRAFT" : "APPROVED", monthKey: s.monthId ? monthKeys.get(s.monthId) ?? null : null }));
  const capacity = cap ? cap.owed - cap.selected : Math.max(1, e?.videosPerMonth ?? 4);
  const emphasisSentence = strategy?.document?.contentPillars.preamble.join(" ") ?? "";
  const pillarEmphasis: Record<string, number> = {};
  for (const p of pillars) if (emphasisSentence && new RegExp(p.name.split(/\s+/)[0], "i").test(emphasisSentence) && /lead|primary|emphasi/i.test(emphasisSentence)) pillarEmphasis[p.name] = 1.2;
  const result = rankRecommendations({ bank, goals, brandMessage: strategy?.document?.brandOverview.brandMessage ?? null, pillarEmphasis, relationshipPhase: strategy?.document?.strategicDirection?.paragraphs.join(" ") ?? null, filmingHistory: history, priorScripts, capacity, alternatives: Math.min(3, capacity) });
  const rows = [...result.recommended.map((r) => ({ r, kind: "RECOMMENDED" })), ...result.alternatives.map((r) => ({ r, kind: "ALTERNATIVE" }))];
  if (!rows.length) {
    await finishRefreshRun(runId, { status: "NEEDS_INPUT", missingContext: { missing: bank.length ? ["Every bank topic is already selected, scripted or filmed — refresh the bank first."] : ["The topic bank is empty — import or generate a bank first."], historyNote: result.historyNote }, changeSummary: result.historyNote });
    return;
  }
  await prisma.contentTopicSuggestion.createMany({
    data: rows.map(({ r, kind }) => ({
      refreshRunId: runId, enrollmentId: run.enrollmentId, clientId: run.clientId, pillarId: r.topic.pillarRef.pillarId, kind, rank: r.rank, title: r.topic.title, description: r.topic.description,
      audienceNeed: r.topic.audienceNeed, businessGoal: r.topic.businessGoal, intendedMessage: r.topic.intendedMessage, rationale: r.reasons.join("; ") || null, whyNow: r.whyNow, linkedGoal: r.linkedGoal,
      // The line a client reads; whyNow stays the staff account (6.3).
      clientReason: clientReasonFor(r, { pillarFilmedCounts: result.pillarFilmedCounts }),
      priorContentRelation: history === null ? "NO_VERIFIED_HISTORY" : r.priorContentRelationship === "new" ? "NEW_ANGLE" : r.priorContentRelationship === "sequel" ? "SEQUEL" : r.priorContentRelationship === "follow-up" ? "REVISIT" : "NONE",
      relatedTopicId: r.topic.id, dedupeHash: topicDedupeHash(r.topic.title),
    })),
  });
  await finishRefreshRun(runId, { status: "SUCCEEDED", generatedCount: rows.length, pillarCount: pillars.length, changeSummary: `${result.recommended.length} recommended · ${result.alternatives.length} alternatives · ${result.excluded.length} excluded · ${result.historyNote}${unlinkedNote}` });
}

// ---- CARRYOVER AND SWAP (CP-07, Sep 24 2026) ---------------------------------------
//
// "Topics carried forward occupy the next month's allowance, but can be
// replaced if unfilmed" (the audit's workflow, Jordan's rule). Until today
// CARRIED was READ in six places and WRITTEN in none: a month was minted with
// nothing carried into it, and a scripted-but-unfilmed topic simply stayed on a
// past month where no reader of "this month's scripts" would ever see it.
//
// A carry MOVES THE POINTERS and records where they came from. Seven readers
// key "this month's script" on ContentScript.monthId (drafting, filming,
// preparation, the overview, the workspace), so moving the script's month is
// what makes every one of them agree without touching any of them; the old
// month is kept on the row (carriedFromMonthId) and on a CARRIED event with the
// versions, so nothing about the script's history is lost. The previous month's
// selection is left exactly as it was: that WAS the plan then.
//
// A swap PARKS the script (monthId → null, status stays SCRIPTED — "scripted,
// not filmed") and puts the replacement in the freed slot, in one transaction,
// so the allowance never counts both. Selecting a parked topic again re-uses
// its script through the same carry — nothing is drafted twice.

export type CarryReason = "ROLLOVER" | "RESELECTED";
export type CarryResult = {
  outcome: "CARRIED" | "SELECTED" | "SKIPPED";
  /** A person-facing refusal (the caller throws it); absent on a quiet skip. */
  refusal?: string;
  note?: string;
  selectionId?: string;
  scriptId?: string;
  fromMonthId?: string | null;
  overflow?: boolean;
  capacity?: { owed: number; selected: number };
};

const monthIsOpen = (m: { historical: boolean; status: string }) => !m.historical && !["CLOSED", "CANCELLED", "IMPORTED"].includes(m.status);

/** Move a scripted, unfilmed topic (and its script) into `toMonthId`. Runs in its own transaction unless given one. */
export async function carryScriptedTopic(topicId: string, toMonthId: string, opts: { actor: Actor; reason: CarryReason; source?: string; db?: Db; now?: Date }): Promise<CarryResult> {
  const work = async (tx: Db): Promise<CarryResult> => {
    const [t, to] = await Promise.all([
      tx.contentTopic.findUnique({ where: { id: topicId }, select: { id: true, enrollmentId: true, clientId: true, status: true, monthId: true, title: true } }),
      tx.contentMonth.findUnique({ where: { id: toMonthId }, select: { id: true, enrollmentId: true, monthKey: true, videosOwed: true, historical: true, status: true } }),
    ]);
    if (!t || !to) return { outcome: "SKIPPED", refusal: "Topic or month not found." };
    if (t.enrollmentId !== to.enrollmentId) return { outcome: "SKIPPED", refusal: "That month belongs to another client." };
    if (!monthIsOpen(to)) return { outcome: "SKIPPED", refusal: "That month is closed." };
    if (["FILMED", "EDITING", "DELIVERED"].includes(t.status)) return { outcome: "SKIPPED", note: "already filmed" };
    const footage = await tx.contentVideo.findFirst({ where: { topicId, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } });
    if (footage) return { outcome: "SKIPPED", note: "already filmed" };
    const script = await tx.contentScript.findFirst({ where: { topicId, historical: false }, orderBy: { updatedAt: "desc" }, select: { id: true, monthId: true, carriedFromMonthId: true, currentVersionId: true, sharedVersionId: true, clientApprovedVersionId: true } });
    if (!script) return { outcome: "SKIPPED", note: "no script to carry" };
    if (script.monthId === toMonthId) return { outcome: "SKIPPED", note: "already on that month" };
    // Still planned in a month that is open now or later — including the one
    // its script sits in: moving the script would take it from a month that is
    // about to film it. A past month's selection is history and does not count.
    const elsewhere = await tx.contentTopicSelection.findMany({ where: { topicId, monthId: { not: toMonthId }, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { monthId: true } });
    if (elsewhere.length) {
      const { etMonthKey } = await import("@/lib/contentProgram");
      const current = etMonthKey(opts.now ?? new Date());
      const others = await tx.contentMonth.findMany({ where: { id: { in: elsewhere.map((x) => x.monthId) } }, select: { id: true, monthKey: true, historical: true, status: true } });
      const live = others.find((m) => monthIsOpen(m) && m.monthKey >= current);
      if (live) return { outcome: "SKIPPED", refusal: `This topic is already planned for ${live.monthKey} — swap it out there first.` };
    }
    const cap = await monthCapacity(toMonthId, tx);
    const existing = await tx.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId: toMonthId } } });
    const live = !!existing && ALLOWANCE_SELECTION_STATUSES.includes(existing.status);
    const overflow = live ? existing!.overflow : cap.selected >= Math.max(to.videosOwed, 1);
    const status = opts.reason === "ROLLOVER" ? "CARRIED" : "SELECTED";
    const fromMonthId = script.monthId ?? script.carriedFromMonthId ?? null;
    const source = opts.source ?? (opts.reason === "ROLLOVER" ? "carryover" : opts.actor.kind === "CLIENT" ? "client" : "staff");
    const sel = await tx.contentTopicSelection.upsert({
      where: { topicId_monthId: { topicId, monthId: toMonthId } },
      create: {
        topicId, monthId: toMonthId, enrollmentId: t.enrollmentId, clientId: t.clientId, status, source, overflow,
        clientUserId: opts.actor.clientUserId ?? null, staffUserId: opts.actor.staffUserId ?? null, carriedFromMonthId: fromMonthId, carriedScriptId: script.id,
      },
      // A revived REMOVED row takes its place in line now (see selectTopicForMonth).
      update: { status, overflow, source, removedAt: null, removedBy: null, removedReason: null, replacedByTopicId: null, carriedFromMonthId: fromMonthId, carriedScriptId: script.id, ...(live ? {} : { createdAt: new Date() }) },
      select: { id: true },
    });
    await tx.contentScript.update({ where: { id: script.id }, data: { monthId: toMonthId, carriedFromMonthId: fromMonthId } });
    await tx.contentTopic.update({ where: { id: topicId }, data: { monthId: toMonthId } });
    await recordTopicEvent(topicId, t.enrollmentId, "CARRIED", opts.actor, {
      monthId: toMonthId, fromStatus: t.status, toStatus: t.status, db: tx,
      evidence: { fromMonthId, scriptId: script.id, currentVersionId: script.currentVersionId, sharedVersionId: script.sharedVersionId, clientApprovedVersionId: script.clientApprovedVersionId, reason: opts.reason },
      note: opts.reason === "ROLLOVER" ? `Scripted and not filmed — carried into ${to.monthKey}; the script and every version come with it, and it can be swapped for another topic.` : `Its script (not filmed yet) is re-used for ${to.monthKey} — nothing new is drafted.`,
    });
    return { outcome: opts.reason === "ROLLOVER" ? "CARRIED" : "SELECTED", selectionId: sel.id, scriptId: script.id, fromMonthId, overflow, capacity: { owed: to.videosOwed, selected: cap.selected + (overflow || live ? 0 : 1) } };
  };
  if (opts.db) return work(opts.db);
  return prisma.$transaction((tx) => work(tx), { maxWait: 15_000, timeout: 30_000 });
}

export type CarryCandidate = { topicId: string; title: string; fromMonthKey: string; toMonthKey: string; scriptId: string };

/**
 * Carry every scripted, unfilmed topic from a PAST month of this enrollment into
 * the current ET month. `dryRun` returns the list and writes nothing — Jordan
 * sees exactly which scripts would move before the switch goes on. A parked
 * topic (monthId null, after a swap) is never auto-carried: someone chose to
 * take it off a month.
 */
export async function carryUnfilmedTopics(enrollmentId: string, opts: { now?: Date; dryRun?: boolean; actor?: Actor } = {}): Promise<{ candidates: CarryCandidate[]; carried: number; skipped: { topicId: string; why: string }[] }> {
  const now = opts.now ?? new Date();
  const { etMonthKey } = await import("@/lib/contentProgram");
  const currentKey = etMonthKey(now);
  const current = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey: currentKey } }, select: { id: true, monthKey: true, historical: true, status: true } });
  if (!current || !monthIsOpen(current)) return { candidates: [], carried: 0, skipped: [] };
  const past = await prisma.contentMonth.findMany({ where: { enrollmentId, historical: false, monthKey: { lt: currentKey } }, select: { id: true, monthKey: true } });
  if (!past.length) return { candidates: [], carried: 0, skipped: [] };
  const keyOf = new Map(past.map((m) => [m.id, m.monthKey]));
  const topics = await prisma.contentTopic.findMany({ where: { enrollmentId, status: "SCRIPTED", monthId: { in: past.map((m) => m.id) } }, select: { id: true, title: true, monthId: true } });
  const candidates: CarryCandidate[] = [];
  for (const t of topics) {
    const [script, footage, ahead] = await Promise.all([
      prisma.contentScript.findFirst({ where: { topicId: t.id, historical: false }, orderBy: { updatedAt: "desc" }, select: { id: true } }),
      prisma.contentVideo.findFirst({ where: { topicId: t.id, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } }),
      prisma.contentTopicSelection.findFirst({ where: { topicId: t.id, status: { in: ALLOWANCE_SELECTION_STATUSES }, monthId: { notIn: past.map((m) => m.id) } }, select: { id: true } }),
    ]);
    if (!script || footage || ahead) continue;
    candidates.push({ topicId: t.id, title: t.title, fromMonthKey: keyOf.get(t.monthId!) ?? "?", toMonthKey: current.monthKey, scriptId: script.id });
  }
  if (opts.dryRun) return { candidates, carried: 0, skipped: [] };
  let carried = 0;
  const skipped: { topicId: string; why: string }[] = [];
  for (const c of candidates) {
    const r = await carryScriptedTopic(c.topicId, current.id, { actor: opts.actor ?? { kind: "SYSTEM" }, reason: "ROLLOVER", now });
    if (r.outcome === "CARRIED") carried++;
    else skipped.push({ topicId: c.topicId, why: r.refusal ?? r.note ?? "skipped" });
  }
  return { candidates, carried, skipped };
}

/** HOURLY, behind `topic_carryover` (a missing row is OFF). Must run after the month is minted (contentProgram). */
export async function sweepCarryover(opts: { now?: Date } = {}): Promise<{ skipped: string } | { enrollments: number; carried: number; skippedTopics: number }> {
  if (!(await isAutomationEnabled("topic_carryover"))) return { skipped: "topic_carryover is off" };
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  let carried = 0, skippedTopics = 0, touched = 0;
  let lastError: string | null = null;
  for (const e of live) {
    try {
      const r = await carryUnfilmedTopics(e.id, { now: opts.now });
      if (r.carried) touched++;
      carried += r.carried;
      skippedTopics += r.skipped.length;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  await recordAutomationRun("topic_carryover", lastError).catch(() => {});
  return { enrollments: touched, carried, skippedTopics };
}

/**
 * Replace a carried-over, unfilmed topic with another one for the same month.
 * The carried selection is REMOVED (reason SWAPPED, pointing at the
 * replacement); its script, every version and every client decision stay
 * exactly as they are, parked with the topic as "scripted, not filmed"; the
 * replacement takes the freed slot. One transaction: the allowance never counts
 * both, and a failure leaves the carry in place.
 */
export async function swapCarriedTopic(selectionId: string, replacementTopicId: string, actor: Actor): Promise<{ overflow: boolean; capacity: { owed: number; selected: number } }> {
  const sel = await prisma.contentTopicSelection.findUnique({ where: { id: selectionId } });
  if (!sel || !(sel.status === "CARRIED" || (sel.carriedScriptId && ALLOWANCE_SELECTION_STATUSES.includes(sel.status)))) throw new Error("That isn't a carried-over topic any more.");
  if (sel.topicId === replacementTopicId) throw new Error("Pick a different topic to swap in.");
  const [month, topic, repl] = await Promise.all([
    prisma.contentMonth.findUnique({ where: { id: sel.monthId }, select: { id: true, monthKey: true, historical: true, status: true, enrollmentId: true } }),
    prisma.contentTopic.findUnique({ where: { id: sel.topicId }, select: { id: true, title: true, status: true, enrollmentId: true } }),
    prisma.contentTopic.findUnique({ where: { id: replacementTopicId }, select: { id: true, title: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true, enrollmentId: true } }),
  ]);
  if (!month || !topic || !repl) throw new Error("Topic or month not found.");
  if (!monthIsOpen(month)) throw new Error("That month is closed.");
  if (repl.enrollmentId !== month.enrollmentId || topic.enrollmentId !== month.enrollmentId) throw new Error("That topic belongs to another client.");
  if (["FILMED", "EDITING", "DELIVERED"].includes(topic.status)) throw new Error("That one has been filmed — there is nothing to swap.");
  const footage = await prisma.contentVideo.findFirst({ where: { topicId: topic.id, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } });
  if (footage) throw new Error("That one has been filmed — there is nothing to swap.");
  if (!clientCanSeeTopic(repl, false)) throw new Error("That topic isn't available to swap in.");
  if (["FILMED", "EDITING", "DELIVERED"].includes(repl.status)) throw new Error("That topic has already been filmed.");
  const already = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: repl.id, monthId: month.id } }, select: { status: true } });
  if (already && ALLOWANCE_SELECTION_STATUSES.includes(already.status)) throw new Error("That topic is already planned for this month.");
  const by = actor.clientUserId ?? actor.staffUserId ?? actor.kind;
  return prisma.$transaction(async (tx) => {
    // Guarded: a second swap of the same carried row finds nothing to remove.
    const removed = await tx.contentTopicSelection.updateMany({ where: { id: sel.id, status: sel.status }, data: { status: "REMOVED", removedAt: new Date(), removedBy: by, removedReason: "SWAPPED", replacedByTopicId: repl.id } });
    if (removed.count !== 1) throw new Error("That swap already happened.");
    // Park the script (and its topic): versions, the shared copy and the
    // client's decisions are untouched rows — only the month pointer moves.
    const scriptId = sel.carriedScriptId ?? (await tx.contentScript.findFirst({ where: { topicId: topic.id, monthId: month.id, historical: false }, select: { id: true } }))?.id ?? null;
    if (scriptId) await tx.contentScript.updateMany({ where: { id: scriptId, monthId: month.id }, data: { monthId: null } });
    await tx.contentTopic.updateMany({ where: { id: topic.id, monthId: month.id }, data: { monthId: null } });
    await recordTopicEvent(topic.id, month.enrollmentId, "DESELECTED", actor, { monthId: month.id, fromStatus: topic.status, toStatus: topic.status, db: tx, note: `Swapped for “${repl.title}” in ${month.monthKey}. The script is kept — scripted, not filmed — and can be used for another month.`, evidence: { selectionId: sel.id, scriptId, replacedByTopicId: repl.id } });
    const r = await selectTopicForMonth(repl.id, month.id, { source: actor.kind === "CLIENT" ? "client" : "staff", actor, status: "SELECTED", db: tx });
    return { overflow: r.overflow, capacity: r.capacity };
  }, { maxWait: 15_000, timeout: 30_000 });
}

/**
 * A late filming confirmation for the month a topic was carried FROM (the
 * photographer confirms September's session on October 2nd): the carry was
 * wrong after all. The later month's CARRIED slot is released (reason
 * FILMED_LATE) and the script goes back to the month it was filmed in.
 * Called by confirmFilmedTopics after its commit; a no-op for any other topic.
 */
export async function releaseCarryAfterLateFilming(topicId: string, filmedMonthId: string): Promise<boolean> {
  const carried = await prisma.contentTopicSelection.findFirst({ where: { topicId, status: "CARRIED", monthId: { not: filmedMonthId }, carriedFromMonthId: filmedMonthId }, select: { id: true, monthId: true, carriedScriptId: true, enrollmentId: true } });
  if (!carried) return false;
  await prisma.$transaction(async (tx) => {
    await tx.contentTopicSelection.update({ where: { id: carried.id }, data: { status: "REMOVED", removedAt: new Date(), removedBy: "SYSTEM", removedReason: "FILMED_LATE" } });
    if (carried.carriedScriptId) await tx.contentScript.updateMany({ where: { id: carried.carriedScriptId, monthId: carried.monthId }, data: { monthId: filmedMonthId } });
    await tx.contentTopic.updateMany({ where: { id: topicId, monthId: carried.monthId }, data: { monthId: filmedMonthId } });
    await recordTopicEvent(topicId, carried.enrollmentId, "DESELECTED", { kind: "SYSTEM" }, { monthId: carried.monthId, db: tx, note: "Confirmed filmed in the month it was carried from — the carry is undone and that slot is free again." });
  }, { maxWait: 15_000, timeout: 30_000 });
  return true;
}

// ---- RECOMMENDATIONS THE CLIENT SEES (6.3, unified handoff Sep 25 2026) ------------
//
// The ranking above existed and was staff-only: "Rank the bank" wrote
// RECOMMENDED suggestions that only the Video Topics tab read, so the client —
// the person choosing — never saw a recommendation or why. These are the
// pieces that carry it to them without a second source of truth:
//   · recommendationsForMonth — the latest ranking for ONE month, cut to the
//     slots still open, limited to topics the client may see and could choose;
//   · autoRankMonth / sweepRecommendations — the pure ranking (no AI, no spend)
//     re-run when the month's allowance or bank changes, behind topic_refresh;
//   · markRecommendationChosen — choosing one closes its suggestion, on the
//     record, whoever chose it.
// Staff controls for the suggestion queue (6.3): approve all shown, hold
// (HELD — out of the queue, the client's views and every refresh until
// released), regenerate selected, and the client-facing reason, editable.

/** Suggestion kinds a ranking writes. */
const RANKED_KINDS = ["RECOMMENDED", "ALTERNATIVE"];

/**
 * A topic chosen for a month closes the ranking's suggestion for it, whoever
 * chose it — the client from the strip, staff from the tab, or the client
 * straight from the bank. Returns how many suggestions it closed.
 */
export async function markRecommendationChosen(topicId: string, monthId: string, actor: Actor, db: Db = prisma): Promise<number> {
  const runs = await db.contentTopicRefreshRun.findMany({ where: { monthId, kind: "RECOMMENDATION" }, select: { id: true } });
  if (!runs.length) return 0;
  const by = actor.kind === "CLIENT" ? `client:${actor.clientUserId ?? "unknown"}` : actor.staffUserId ?? actor.kind.toLowerCase();
  const r = await db.contentTopicSuggestion.updateMany({
    where: { refreshRunId: { in: runs.map((x) => x.id) }, relatedTopicId: topicId, kind: { in: RANKED_KINDS }, disposition: "PENDING" },
    data: { disposition: "ACCEPTED", dispositionBy: by, dispositionAt: new Date(), acceptedTopicId: topicId },
  });
  return r.count;
}

export type MonthRecommendation = { suggestionId: string; topicId: string; kind: "RECOMMENDED" | "ALTERNATIVE"; rank: number; reason: string | null };

/**
 * What the client is recommended for ONE month: the latest successful ranking
 * for it, cut to the slots still open (carried-over scripts use slots first),
 * and only topics the client may see, has not set aside, and has not already
 * put on an open month. An alternative moves up when a recommended topic
 * drops out, so the strip always offers the slots that are actually open.
 */
export async function recommendationsForMonth(enrollmentId: string, monthId: string): Promise<{ slotsLeft: number; recommended: MonthRecommendation[]; alternatives: MonthRecommendation[]; runId: string | null }> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true, historical: true, status: true } });
  if (!month || month.enrollmentId !== enrollmentId || month.historical || ["CLOSED", "CANCELLED", "IMPORTED"].includes(month.status)) return { slotsLeft: 0, recommended: [], alternatives: [], runId: null };
  const cap = await monthCapacity(monthId);
  const slotsLeft = Math.max(0, cap.owed - cap.selected);
  const run = await prisma.contentTopicRefreshRun.findFirst({ where: { enrollmentId, monthId, kind: "RECOMMENDATION", status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!run || slotsLeft === 0) return { slotsLeft, recommended: [], alternatives: [], runId: run?.id ?? null };
  const rows = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: run.id, kind: { in: RANKED_KINDS }, disposition: "PENDING", relatedTopicId: { not: null } }, orderBy: [{ kind: "desc" }, { rank: "asc" }] });
  const topicIds = rows.map((r) => r.relatedTopicId as string);
  const [topics, openMonths] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: topicIds }, enrollmentId }, select: { id: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true } }),
    prisma.contentMonth.findMany({ where: { enrollmentId, historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] } }, select: { id: true } }),
  ]);
  const planned = new Set((await prisma.contentTopicSelection.findMany({ where: { topicId: { in: topicIds }, monthId: { in: openMonths.map((m) => m.id) }, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true } })).map((s) => s.topicId));
  const ok = new Set(topics.filter((t) => ["IDEA", "SAVED", "RECOMMENDED"].includes(t.status) && !t.clientDeclinedAt && !planned.has(t.id) && clientCanSeeTopic(t, false)).map((t) => t.id));
  // RECOMMENDED first by rank, then ALTERNATIVE by rank: "RECOMMENDED" > "ALTERNATIVE" alphabetically, hence kind desc above.
  const eligible = rows.filter((r) => ok.has(r.relatedTopicId as string)).map((r): MonthRecommendation => ({ suggestionId: r.id, topicId: r.relatedTopicId as string, kind: r.kind as "RECOMMENDED" | "ALTERNATIVE", rank: r.rank ?? 0, reason: r.clientReason }));
  return { slotsLeft, recommended: eligible.slice(0, slotsLeft), alternatives: eligible.slice(slotsLeft), runId: run.id };
}

/** What a ranking depends on: the slots, what fills them, the strategy and the bank a client could choose from. */
async function allowanceHash(enrollmentId: string, monthId: string): Promise<{ hash: string; slotsLeft: number }> {
  const [cap, taken, strategy, bank] = await Promise.all([
    monthCapacity(monthId),
    prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true } }),
    approvedStrategy(enrollmentId),
    prisma.contentTopic.findMany({ where: { enrollmentId, status: { in: ["IDEA", "SAVED", "RECOMMENDED"] } }, select: { id: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true } }),
  ]);
  const visible = bank.filter((t) => isUsableStock(t)).map((t) => t.id).sort();
  const hash = sha256(JSON.stringify({ owed: cap.owed, taken: taken.map((t) => t.topicId).sort(), s: strategy?.versionId ?? null, bank: visible })).slice(0, 24);
  return { hash, slotsLeft: Math.max(0, cap.owed - cap.selected) };
}

/**
 * Re-rank one month when (and only when) what the ranking depends on has
 * changed. Pure ranking — no model call, no spend. A rerun with nothing
 * changed creates no second run; a new run supersedes the old one's
 * unreviewed rows so the strip and the tab read one ranking.
 */
export async function autoRankMonth(monthId: string, opts: { requestedBy?: string } = {}): Promise<{ ran: boolean; runId: string | null; why: string }> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, historical: true, status: true } });
  if (!month || month.historical || ["CLOSED", "CANCELLED", "IMPORTED"].includes(month.status)) return { ran: false, runId: null, why: "not an open month" };
  const { hash, slotsLeft } = await allowanceHash(month.enrollmentId, monthId);
  const same = await prisma.contentTopicRefreshRun.findFirst({ where: { monthId, kind: "RECOMMENDATION", status: { in: ["SUCCEEDED", "NEEDS_INPUT", "RUNNING"] }, inputsJson: { contains: `"allowanceHash":"${hash}"` } }, select: { id: true } });
  if (same) return { ran: false, runId: same.id, why: "nothing changed since the last ranking" };
  if (slotsLeft === 0) return { ran: false, runId: null, why: "month already full" };
  const dedupeKey = `rec:${monthId}:${hash}`;
  let runId: string;
  try {
    const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(month.enrollmentId)]);
    const row = await prisma.contentTopicRefreshRun.create({
      data: {
        enrollmentId: month.enrollmentId, clientId: month.clientId, kind: "RECOMMENDATION", monthId, strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id,
        requestedBy: opts.requestedBy ?? "system", status: "RUNNING", attempts: 1, startedAt: new Date(), leaseUntil: new Date(Date.now() + 5 * 60_000), leaseBy: opts.requestedBy ?? "system",
        dedupeKey, inputsJson: JSON.stringify({ allowanceHash: hash, slotsLeft, auto: true }),
      },
      select: { id: true },
    });
    runId = row.id;
  } catch {
    return { ran: false, runId: null, why: "another ranking for this month is running" };
  }
  try {
    await executeRecommendationRun(runId);
  } catch (e) {
    await failRefreshRun(runId, e);
    throw e;
  }
  const done = await prisma.contentTopicRefreshRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (done?.status === "SUCCEEDED") {
    const older = await prisma.contentTopicRefreshRun.findMany({ where: { monthId, kind: "RECOMMENDATION", id: { not: runId } }, select: { id: true } });
    if (older.length) await prisma.contentTopicSuggestion.updateMany({ where: { refreshRunId: { in: older.map((o) => o.id) }, kind: { in: RANKED_KINDS }, disposition: "PENDING" }, data: { disposition: "SUPERSEDED", dispositionBy: "system", dispositionAt: new Date() } });
  }
  return { ran: true, runId, why: done?.status ?? "ran" };
}

/**
 * HOURLY, behind `topic_refresh` (the unattended topic work's switch; a
 * missing row is off). Re-ranks each ACTIVE enrollment's open months whose
 * allowance or bank has changed. Pure ranking only: nothing here spends AI
 * credit, writes a topic or reaches a client — the client sees the result on
 * their Your Month page (portal_layout_v2), nothing is sent.
 */
export async function sweepRecommendations(opts: { max?: number; now?: Date } = {}): Promise<{ skipped: string } | { checked: number; ranked: number; unchanged: number; errors: number }> {
  if (!(await isAutomationEnabled("topic_refresh"))) return { skipped: "topic_refresh is off" };
  const cur = (opts.now ?? new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const months = live.length ? await prisma.contentMonth.findMany({ where: { enrollmentId: { in: live.map((e) => e.id) }, historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] }, monthKey: { gte: cur } }, select: { id: true }, orderBy: { monthKey: "asc" }, take: opts.max ?? 60 }) : [];
  let ranked = 0, unchanged = 0, errors = 0;
  for (const m of months) {
    try { const r = await autoRankMonth(m.id, { requestedBy: "cron" }); if (r.ran) ranked++; else unchanged++; } catch { errors++; }
  }
  return { checked: months.length, ranked, unchanged, errors };
}

/** Approve every suggestion shown, one by one (each is already idempotent). A second click finds nothing PENDING. */
export async function acceptSuggestions(ids: string[], by: string, opts: { monthId?: string | null } = {}): Promise<{ accepted: number; skipped: number; errors: { id: string; error: string }[] }> {
  let accepted = 0, skipped = 0;
  const errors: { id: string; error: string }[] = [];
  for (const id of [...new Set(ids)].slice(0, 100)) {
    const s = await prisma.contentTopicSuggestion.findUnique({ where: { id }, select: { disposition: true } });
    if (!s || s.disposition !== "PENDING") { skipped++; continue; }
    try { await acceptSuggestion(id, by, { monthId: opts.monthId ?? null }); accepted++; }
    catch (e) { errors.push({ id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { accepted, skipped, errors };
}

/**
 * HOLD a suggestion: out of the review queue, out of every client view, and
 * never re-suggested by a refresh — without archiving it. Only a PENDING one
 * can be held; releasing puts it back exactly as it was.
 */
export async function holdSuggestion(id: string, by: string, note?: string | null): Promise<void> {
  const r = await prisma.contentTopicSuggestion.updateMany({ where: { id, disposition: "PENDING" }, data: { disposition: "HELD", dispositionBy: by, dispositionAt: new Date() } });
  if (r.count === 0) throw new Error("Only a suggestion still waiting for review can be held.");
  if (note?.trim()) {
    const s = await prisma.contentTopicSuggestion.findUnique({ where: { id }, select: { rationale: true } });
    await prisma.contentTopicSuggestion.update({ where: { id }, data: { rationale: [s?.rationale, `Held by ${by}: ${note.trim().slice(0, 300)}`].filter(Boolean).join(" · ") } });
  }
}

export async function releaseSuggestionHold(id: string, by: string): Promise<void> {
  const r = await prisma.contentTopicSuggestion.updateMany({ where: { id, disposition: "HELD" }, data: { disposition: "PENDING", dispositionBy: by, dispositionAt: new Date() } });
  if (r.count === 0) throw new Error("That suggestion is not on hold.");
}

export async function heldSuggestions(enrollmentId: string) {
  return prisma.contentTopicSuggestion.findMany({ where: { enrollmentId, disposition: "HELD" }, orderBy: [{ dispositionAt: "desc" }] });
}

/** Staff edit the one line a client reads beside a recommendation. Plain words, one sentence. */
export async function setSuggestionClientReason(id: string, text: string): Promise<void> {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const r = await prisma.contentTopicSuggestion.updateMany({ where: { id, kind: { in: RANKED_KINDS } }, data: { clientReason: t || null } });
  if (r.count === 0) throw new Error("That is not a recommendation.");
}

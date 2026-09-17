import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256, activePolicyVersion } from "@/lib/aiRuns";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { approvedStrategy } from "@/lib/contentStrategy";
import { normalizeTitle, rankRecommendations, GENERATION_POLICY, type Topic, type FilmedRecord, type PriorScript, type StrategyGoal } from "@/lib/contentPolicy";

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

export type TopicEventKind = "CREATED" | "IMPORTED" | "SUGGESTED" | "DISCUSSED" | "SELECTED" | "DESELECTED" | "APPROVED" | "REJECTED" | "ARCHIVED" | "SCRIPTED" | "FILMED" | "DELIVERED" | "EDITED" | "RECONCILED" | "CARRIED" | "REINTRODUCED";
export type Actor = { kind: "CLIENT" | "STAFF" | "AI" | "SYSTEM" | "IMPORT"; clientUserId?: string | null; staffUserId?: string | null };

export function topicDedupeHash(title: string): string {
  return sha256(normalizeTitle(title));
}

export async function recordTopicEvent(topicId: string, enrollmentId: string, kind: TopicEventKind, actor: Actor, opts: { monthId?: string | null; fromStatus?: string | null; toStatus?: string | null; sourceRef?: string | null; evidence?: unknown; note?: string | null } = {}): Promise<void> {
  await prisma.contentTopicEvent.create({
    data: {
      topicId, enrollmentId, kind, monthId: opts.monthId ?? null, fromStatus: opts.fromStatus ?? null, toStatus: opts.toStatus ?? null,
      actorKind: actor.kind, clientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? null,
      sourceRef: opts.sourceRef ?? null, evidenceJson: opts.evidence ? JSON.stringify(opts.evidence).slice(0, 20_000) : null, note: opts.note?.slice(0, 2000) ?? null,
    },
  });
  await prisma.contentTopic.update({ where: { id: topicId }, data: { lastEventAt: new Date() } }).catch(() => {});
}

export type CreateTopicInput = {
  enrollmentId: string; title: string; concept?: string | null; pillarId?: string | null; pillarLabel?: string | null;
  audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null;
  source: "ai" | "client" | "strategy_call" | "staff" | "import"; sourceRef?: string | null; importItemId?: string | null; suggestionId?: string | null;
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
 * How full a month's plan is. `overflow` is DERIVED from the two numbers, not
 * read off the rows: ContentTopicSelection.overflow is a flag frozen when the
 * row was inserted, and enrollmentChanges rewrites ContentMonth.videosOwed
 * when a package changes — so a Pro→Starter downgrade left eight rows flagged
 * "not overflow" against a two-video month and the panel printed a green
 * "4/2 at capacity" (review, Sep 17). The stored flag is still what the
 * per-row "beyond capacity" marker reads, because that one is about the row's
 * own history; the MONTH's arithmetic is arithmetic.
 */
export async function monthCapacity(monthId: string): Promise<{ owed: number; selected: number; overflow: number }> {
  const m = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { videosOwed: true } });
  const sel = await prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: ["SELECTED", "RECONCILED", "PROPOSED"] } }, select: { overflow: true } });
  const owed = m?.videosOwed ?? 0;
  const total = sel.length;
  const overflow = Math.max(0, total - owed);
  return { owed, selected: total - overflow, overflow };
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
 */
export async function selectTopicForMonth(topicId: string, monthId: string, opts: { source: "client" | "call" | "staff" | "ai" | "import"; actor: Actor; callRecordId?: string | null; evidence?: unknown; status?: "PROPOSED" | "SELECTED" }): Promise<{ overflow: boolean; capacity: { owed: number; selected: number }; outcome: SelectOutcome }> {
  const [t, m] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: topicId }, select: { id: true, enrollmentId: true, clientId: true, status: true, approvalState: true, monthId: true } }),
    prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, videosOwed: true } }),
  ]);
  if (!t || !m) throw new Error("Topic or month not found.");
  if (t.enrollmentId !== m.enrollmentId) throw new Error("That month belongs to another client.");
  const cap = await monthCapacity(monthId);
  const status = opts.status ?? "SELECTED";
  const existing = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId } } });
  const ruledOut = t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED";
  if (ruledOut) {
    if (status === "SELECTED") throw new Error("This topic was rejected or archived — reintroduce it first (that is recorded), then select it.");
    await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) but this topic is ${t.status === "REJECTED" || t.approvalState === "REJECTED" ? "rejected" : "archived"} — not re-proposed; reintroduce it by hand if that changed` });
    return { overflow: false, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "WITHHELD" };
  }
  if (status === "PROPOSED" && existing) {
    if (existing.status === "SELECTED" || existing.status === "RECONCILED" || existing.status === "CARRIED") {
      await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) — already ${existing.status.toLowerCase()} for this month by ${existing.staffUserId ?? existing.clientUserId ?? existing.source}; left as is` });
      return { overflow: existing.overflow, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "KEPT" };
    }
    if (existing.status === "REMOVED") {
      await recordTopicEvent(topicId, t.enrollmentId, "DISCUSSED", opts.actor, { monthId, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: `Raised again (${opts.source}) — it was removed from this month by ${existing.removedBy ?? "staff"}; not revived, select it by hand if that changed` });
      return { overflow: existing.overflow, capacity: { owed: m.videosOwed, selected: cap.selected }, outcome: "WITHHELD" };
    }
  }
  const overflow = existing ? existing.overflow : cap.selected >= Math.max(m.videosOwed, 1);
  await prisma.contentTopicSelection.upsert({
    where: { topicId_monthId: { topicId, monthId } },
    create: { topicId, monthId, enrollmentId: t.enrollmentId, clientId: t.clientId, status, source: opts.source, clientUserId: opts.actor.clientUserId ?? null, staffUserId: opts.actor.staffUserId ?? null, callRecordId: opts.callRecordId ?? null, evidenceJson: opts.evidence ? JSON.stringify(opts.evidence).slice(0, 20_000) : null, overflow },
    update: { status, removedAt: null, removedBy: null, source: opts.source, clientUserId: opts.actor.clientUserId ?? undefined, staffUserId: opts.actor.staffUserId ?? undefined, callRecordId: opts.callRecordId ?? undefined },
  });
  // The legacy single pointer follows a real (non-proposed) selection so every
  // existing reader (roster, tracker, script generator) keeps working.
  if (status === "SELECTED" && !["SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status)) {
    await prisma.contentTopic.update({ where: { id: topicId }, data: { monthId, status: "SELECTED" } });
  }
  await recordTopicEvent(topicId, t.enrollmentId, "SELECTED", opts.actor, { monthId, fromStatus: t.status, toStatus: status === "SELECTED" ? "SELECTED" : t.status, sourceRef: opts.callRecordId ?? null, evidence: opts.evidence, note: overflow ? "Beyond this month's capacity — kept as overflow" : status === "PROPOSED" ? "Proposed from a call — not selected until reconciled" : null });
  return { overflow, capacity: { owed: m.videosOwed, selected: cap.selected + (overflow || existing ? 0 : 1) }, outcome: status };
}

/** Remove an uncommitted selection (a scripted/filmed topic stays where it is). */
export async function deselectTopic(topicId: string, monthId: string, actor: Actor): Promise<void> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, status: true, monthId: true } });
  if (!t) throw new Error("Topic not found.");
  if (["SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status)) throw new Error("This topic already has a script or footage — it stays on the month.");
  await prisma.contentTopicSelection.updateMany({ where: { topicId, monthId, status: { in: ["SELECTED", "PROPOSED", "RECONCILED"] } }, data: { status: "REMOVED", removedAt: new Date(), removedBy: actor.staffUserId ?? actor.clientUserId ?? actor.kind } });
  if (t.monthId === monthId) await prisma.contentTopic.update({ where: { id: topicId }, data: { monthId: null, status: "SAVED" } });
  await recordTopicEvent(topicId, t.enrollmentId, "DESELECTED", actor, { monthId, fromStatus: t.status, toStatus: "SAVED" });
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

export type BankTopic = { id: string; title: string; concept: string | null; pillarId: string | null; pillarLabel: string | null; status: string; approvalState: string | null; source: string; audienceNeed: string | null; businessGoal: string | null; intendedMessage: string | null; monthId: string | null; importedMark: string | null; proposedState: string | null; lastEventAt: string | null };
export type BankGroup = { pillarId: string | null; pillarName: string; topics: BankTopic[] };

export async function topicBankByPillar(enrollmentId: string): Promise<{ groups: BankGroup[]; total: number; archived: number }> {
  const [topics, pillars] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } }, orderBy: [{ createdAt: "asc" }] }),
    listPillars(enrollmentId),
  ]);
  const archived = await prisma.contentTopic.count({ where: { enrollmentId, status: { in: ["REJECTED", "ARCHIVED"] } } });
  const toRow = (t: (typeof topics)[number]): BankTopic => ({
    id: t.id, title: t.title, concept: t.concept, pillarId: t.pillarId, pillarLabel: t.pillar, status: t.status, approvalState: t.approvalState, source: t.source,
    audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, monthId: t.monthId, importedMark: t.importedMark, proposedState: t.proposedState, lastEventAt: t.lastEventAt?.toISOString() ?? null,
  });
  const groups: BankGroup[] = pillars.map((p) => ({ pillarId: p.id, pillarName: p.name, topics: topics.filter((t) => t.pillarId === p.id).map(toRow) }));
  const unmapped = topics.filter((t) => !t.pillarId || !pillars.some((p) => p.id === t.pillarId));
  if (unmapped.length) groups.push({ pillarId: null, pillarName: "Not yet linked to a pillar", topics: unmapped.map(toRow) });
  return { groups, total: topics.length, archived };
}

// ---- refresh runs + suggestions ---------------------------------------------------

export type RefreshKind = "BANK" | "REFRESH" | "RECOMMENDATION";

/** Everything a refresh must not re-suggest: archived/rejected topics and archived suggestions, by dedupe hash. */
export async function blockedTopicHashes(enrollmentId: string): Promise<Set<string>> {
  const [topics, suggs] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId, OR: [{ status: { in: ["REJECTED", "ARCHIVED"] } }, { approvalState: { in: ["REJECTED", "ARCHIVED"] } }] }, select: { title: true, dedupeHash: true } }),
    prisma.contentTopicSuggestion.findMany({ where: { enrollmentId, disposition: "ARCHIVED" }, select: { title: true, dedupeHash: true } }),
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

/**
 * Start (or join) a refresh run. Duplicate clicks with the same inputs
 * collide on dedupeKey while a run is active → the caller gets the existing
 * run back. Execution is synchronous for a staff click (the AI half is in
 * contentGeneration.ts); the row records lease/attempts either way.
 */
export async function startTopicRefresh(opts: { enrollmentId: string; kind: RefreshKind; requestedBy: string; monthId?: string | null; topicsPerPillar?: number | null; pillarId?: string | null; unattended?: boolean; /** Store only the top N new suggestions (a single-suggestion regeneration keeps 1); the prompt itself always asks for the policy's count. */ keep?: number | null }): Promise<{ runId: string; joined: boolean }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: opts.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(opts.enrollmentId)]);
  // The prompt's count stays inside the policy's band (10–15: the bank prompt
  // refuses anything else); how many of the results are KEPT is `keep`.
  const perPillar = Math.min(Math.max(opts.topicsPerPillar ?? policy.topicsPerPillar, GENERATION_POLICY.topicsPerPillar.min), policy.topicsPerPillarMax);
  const keep = opts.keep && opts.keep > 0 ? Math.floor(opts.keep) : null;
  const inputsHash = sha256(JSON.stringify({ s: strategy?.versionId ?? null, p: policy.id, n: perPillar, m: opts.monthId ?? null, pillar: opts.pillarId ?? null, keep }));
  const dedupeKey = `${opts.enrollmentId}:${opts.kind}:${inputsHash}`;
  // A run left RUNNING past its lease (function timeout, deploy mid-call) must
  // not hold the dedupe key forever — every later click would "join" a corpse.
  await prisma.contentTopicRefreshRun.updateMany({
    where: { status: "RUNNING", leaseUntil: { lt: new Date() } },
    data: { status: "FAILED", lastError: "Lease expired — the run never finished (timed out or the server restarted). Start it again.", lastErrorAt: new Date(), finishedAt: new Date(), dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
  const active = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (active) return { runId: active.id, joined: true };
  let runId: string;
  try {
    const row = await prisma.contentTopicRefreshRun.create({
      data: {
        enrollmentId: opts.enrollmentId, clientId: e.clientId, kind: opts.kind, strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id,
        requestedBy: opts.requestedBy, monthId: opts.monthId ?? null, status: "RUNNING", attempts: 1, leaseUntil: new Date(Date.now() + 10 * 60_000), leaseBy: opts.requestedBy,
        topicsPerPillar: perPillar, dedupeKey, startedAt: new Date(),
        inputsJson: JSON.stringify({ strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id, topicsPerPillar: perPillar, pillarId: opts.pillarId ?? null, keep }),
      },
      select: { id: true },
    });
    runId = row.id;
  } catch {
    const again = await prisma.contentTopicRefreshRun.findFirst({ where: { dedupeKey, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    if (again) return { runId: again.id, joined: true };
    throw new Error("Could not start the refresh.");
  }
  try {
    if (opts.kind === "RECOMMENDATION") await executeRecommendationRun(runId);
    else {
      const { executeTopicRefreshRun } = await import("@/lib/contentGeneration");
      await executeTopicRefreshRun(runId, { unattended: opts.unattended ?? false, pillarId: opts.pillarId ?? null, keep });
    }
  } catch (e) {
    await prisma.contentTopicRefreshRun.update({ where: { id: runId }, data: { status: "FAILED", lastError: (e instanceof Error ? e.message : String(e)).slice(0, 2000), lastErrorAt: new Date(), finishedAt: new Date(), dedupeKey: null, leaseUntil: null } }).catch(() => {});
    throw e;
  }
  return { runId, joined: false };
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
    source: t.source === "import" ? "IMPORTED" : t.source === "client" ? "CLIENT_SUGGESTED" : t.source === "strategy_call" ? "CALL" : t.source === "staff" ? "STAFF" : "GENERATED",
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
  const bankRows = await prisma.contentTopic.findMany({ where: { enrollmentId: run.enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
  const bank = bankRows.map((t) => toPolicyTopic(t, nameOf(t.pillarId, t.pillar)));
  const goals: StrategyGoal[] = (strategy?.document?.contentGoals.items ?? []).map((g, i) => ({ id: `goal-${i + 1}`, text: g }));
  const scriptsRows = await prisma.contentScript.findMany({ where: { enrollmentId: run.enrollmentId }, select: { topicId: true, title: true, status: true, monthId: true, pillarId: true } });
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId: run.enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const priorScripts: PriorScript[] = scriptsRows.map((s) => ({ topicId: s.topicId, title: s.title, pillarName: nameOf(s.pillarId, null), status: s.status === "INTERNAL_REVIEW" || s.status === "DRAFT" ? "DRAFT" : "APPROVED", monthKey: s.monthId ? monthKeys.get(s.monthId) ?? null : null }));
  const capacity = Math.max(1, e?.videosPerMonth ?? 4);
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
      priorContentRelation: history === null ? "NO_VERIFIED_HISTORY" : r.priorContentRelationship === "new" ? "NEW_ANGLE" : r.priorContentRelationship === "sequel" ? "SEQUEL" : r.priorContentRelationship === "follow-up" ? "REVISIT" : "NONE",
      relatedTopicId: r.topic.id, dedupeHash: topicDedupeHash(r.topic.title),
    })),
  });
  await finishRefreshRun(runId, { status: "SUCCEEDED", generatedCount: rows.length, pillarCount: pillars.length, changeSummary: `${result.recommended.length} recommended · ${result.alternatives.length} alternatives · ${result.excluded.length} excluded · ${result.historyNote}${unlinkedNote}` });
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { factDedupeHash } from "@/lib/clientFacts";
import { normalizeTitle } from "@/lib/contentPolicy";
import {
  CURATOR, CURATOR_SCHEMA, CURATOR_SYSTEM, ONE_OFF_GRACE_MS, curatorPrompt, curatorTag, planCuration, readCuratorTag,
  keptPlaceOf, type CurateFact, type CurationPlan, type CurrentNote, type KeptPlace, type PlannedAction,
} from "@/lib/knowledgeCuratorCore";

// ---------------------------------------------------------------------------
// THE KNOWLEDGE CURATOR (Oct 27 2026), the I/O half: see knowledgeCuratorCore
// for what goes where and why.
//
// Which facts: everything a call, an old note, an import or a message left
// that NO PERSON decided (reviewedBy empty, "auto", or the Oct 22 cleanup's
// marks), still PROPOSED or ACCEPTED. A person's own decision (their email on
// reviewedBy, an undo) is never re-curated, and neither are field reports
// (the office confirms those on the client page) or staff-typed facts.
//
// Fail safe: no answer from the model means nothing is written. Every write
// is compare-and-set on the row's updatedAt + status, so a fact a person
// touched mid-run is skipped. Nothing is deleted. The run itself
// (ProgramAiRun kind knowledge_curation) holds the model's whole answer.
// ---------------------------------------------------------------------------

export const CURATOR_BY = "ai-curator";
const CURATE_SOURCES = ["call", "ai", "comms", "import", "note_migration", "client", "review"];
const BATCH = 40;
/** A client's facts are curated at most this often by the sweep (new PROPOSED facts go first). */
const CLIENT_COOLDOWN_MS = 6 * 3600_000;

const undecidedWhere = (clientId?: string) => ({
  ...(clientId ? { clientId } : {}),
  source: { in: CURATE_SOURCES },
  status: { in: ["PROPOSED", "ACCEPTED"] },
  undoneBy: null,
  OR: [{ reviewedBy: null }, { reviewedBy: "auto" }, { reviewedBy: { startsWith: "ai-cleanup-oct22" } }],
});

export type CurateResult =
  | { ok: true; runId: string | null; seen: number; confidential: number; plan: CurationPlan | null; applied: Record<string, number>; skippedChanged: string[]; issues: number; profileChanges: number }
  | { ok: false; reason: string };

type FactRow = {
  id: string; clientId: string; enrollmentId: string | null; category: string; fieldKey: string | null; body: string; source: string; speaker: string | null;
  factDate: Date | null; createdAt: Date; updatedAt: Date; status: string; confidential: boolean; monthId: string | null; callRecordId: string | null; conflictsWithId: string | null;
};
const FACT_SELECT = { id: true, clientId: true, enrollmentId: true, category: true, fieldKey: true, body: true, source: true, speaker: true, factDate: true, createdAt: true, updatedAt: true, status: true, confidential: true, monthId: true, callRecordId: true, conflictsWithId: true } as const;

/** How many undecided facts each client has (read-only; the live script's dry run). */
export async function undecidedCounts(): Promise<{ clientId: string; n: number }[]> {
  const rows = await prisma.clientFact.groupBy({ by: ["clientId"], where: undecidedWhere(), _count: { _all: true } });
  return rows.map((r) => ({ clientId: r.clientId, n: r._count._all })).sort((a, b) => b.n - a.n);
}

/** The facts no person decided, for one client: PROPOSED first, then the oldest. */
export async function undecidedFacts(clientId: string, take = BATCH): Promise<FactRow[]> {
  return prisma.clientFact.findMany({ where: undecidedWhere(clientId), orderBy: [{ status: "desc" }, { createdAt: "asc" }], take, select: FACT_SELECT });
}

/**
 * Curate one client's undecided facts (up to 40 per call). `dryRun`: reads
 * only and never calls the model (the live script's dry run lists what it
 * WOULD send). Throws nothing a caller must catch for a model failure: the
 * result says why and nothing changed.
 */
export async function curateClientKnowledge(clientId: string, opts: { requestedBy: string; unattended: boolean; dryRun?: boolean; now?: Date; take?: number }): Promise<CurateResult> {
  const now = opts.now ?? new Date();
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, reason: "client not found" };
  const enrollments = await prisma.contentEnrollment.findMany({ where: { clientId }, select: { id: true, status: true }, orderBy: { createdAt: "desc" } });
  const enrollment = enrollments.find((e) => e.status === "ACTIVE") ?? enrollments[0] ?? null;
  const rows = await undecidedFacts(clientId, opts.take ?? BATCH);
  const confidential = rows.filter((f) => f.confidential);
  const open = rows.filter((f) => !f.confidential);
  const applied: Record<string, number> = {};
  const bump = (k: string) => { applied[k] = (applied[k] ?? 0) + 1; };
  const skippedChanged: string[] = [];
  if (opts.dryRun) return { ok: true, runId: null, seen: rows.length, confidential: confidential.length, plan: null, applied, skippedChanged, issues: 0, profileChanges: 0 };

  // Said in confidence: kept for the team by rule, never shown to the model.
  for (const f of confidential) {
    const w = await prisma.clientFact.updateMany({ where: { id: f.id, updatedAt: f.updatedAt, status: f.status }, data: { status: "ACCEPTED", aiContext: "DENIED", reviewedBy: curatorTag("TEAM_NOTE", "rule", "said in confidence: kept for the team, never used in content"), reviewedAt: now } });
    if (w.count) bump("confidential"); else skippedChanged.push(f.id);
  }
  if (!open.length) return { ok: true, runId: null, seen: rows.length, confidential: confidential.length, plan: { actions: [], complaints: [], untouched: [] }, applied, skippedChanged, issues: 0, profileChanges: 0 };

  const [noteRows, knownRows, months] = await Promise.all([
    prisma.clientFact.findMany({
      where: { clientId, status: "ACCEPTED", confidential: false, OR: [{ fieldKey: { startsWith: "identity." } }, { fieldKey: { startsWith: "strategy_note." } }, { fieldKey: { startsWith: "editing." } }, { fieldKey: { startsWith: "production." } }] },
      orderBy: { updatedAt: "desc" }, take: 40, select: { id: true, fieldKey: true, body: true },
    }),
    // Nothing said in confidence ever reaches the model, not even as "already known".
    prisma.clientFact.findMany({ where: { clientId, status: "ACCEPTED", confidential: false, id: { notIn: open.map((f) => f.id) } }, orderBy: { updatedAt: "desc" }, take: 60, select: { body: true } }),
    prisma.contentMonth.findMany({ where: { id: { in: [...new Set(open.map((f) => f.monthId).filter((x): x is string => !!x))] } }, select: { id: true, monthKey: true } }),
  ]);
  const notes: CurrentNote[] = noteRows.filter((n) => !!n.fieldKey).map((n) => ({ fieldKey: n.fieldKey!, body: n.body }));
  const keyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  const facts: CurateFact[] = open.map((f) => ({ id: f.id, category: f.category, fieldKey: f.fieldKey, body: f.body, source: f.source, speaker: f.speaker, factDate: f.factDate, createdAt: f.createdAt, confidential: false, monthKey: f.monthId ? keyOf.get(f.monthId) ?? null : null }));

  let runId: string;
  let output: unknown;
  try {
    const { runAiJson } = await import("@/lib/aiRuns");
    const r = await runAiJson<unknown>({
      kind: "knowledge_curation", enrollmentId: enrollment?.id ?? null, clientId, scope: { clientId, factIds: facts.map((f) => f.id) },
      promptKey: "knowledge-curator", promptVersion: "knowledge-curator.v1", requestedBy: opts.requestedBy, unattended: opts.unattended,
      system: CURATOR_SYSTEM, prompt: curatorPrompt(client, facts, notes, knownRows.map((k) => k.body), now), schema: CURATOR_SCHEMA as unknown as Record<string, unknown>, maxTokens: 10_000,
    });
    runId = r.runId;
    output = r.output;
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const plan = planCuration(facts, output, now);
  const byId = new Map(open.map((f) => [f.id, f]));
  const cas = async (f: FactRow, data: Record<string, unknown>): Promise<boolean> => {
    const w = await prisma.clientFact.updateMany({ where: { id: f.id, updatedAt: f.updatedAt, status: f.status }, data });
    if (!w.count) skippedChanged.push(f.id);
    return w.count > 0;
  };
  const tag = (a: PlannedAction, decision?: string) => curatorTag(decision ?? (a.kind === "keep" ? a.decision : a.kind === "note" ? a.decision : a.kind === "oneoff" ? (a.expired ? "EXPIRED" : "ONE_OFF") : a.kind === "cast" ? "SKIT_CAST" : "DROP"), runId, a.reason);
  const keptIds = new Set<string>();
  const droppedIds = new Set<string>();
  const mergedIds = new Set<string>();
  const notesForProfile: { factId: string; fieldKey: string; line: string; callRecordId: string | null }[] = [];

  for (const a of plan.actions) {
    if (a.kind === "keep") {
      const f = byId.get(a.factId)!;
      const ok = await cas(f, { status: "ACCEPTED", aiContext: a.decision === "SCRIPT" ? "ALLOWED" : "DENIED", reviewedBy: tag(a), reviewedAt: now, conflictsWithId: null, ...(f.conflictsWithId ? { supersedesId: f.conflictsWithId } : {}) });
      if (ok && f.conflictsWithId) await prisma.clientFact.updateMany({ where: { id: f.conflictsWithId, status: "ACCEPTED" }, data: { status: "SUPERSEDED", supersededById: f.id } });
      if (ok) { keptIds.add(f.id); bump(a.decision); }
    } else if (a.kind === "drop") {
      if (await cas(byId.get(a.factId)!, { status: "REJECTED", aiContext: "DENIED", reviewedBy: tag(a), reviewedAt: now })) { droppedIds.add(a.factId); bump("DROP"); }
    } else if (a.kind === "oneoff") {
      if (await cas(byId.get(a.factId)!, { status: a.expired ? "REJECTED" : "ACCEPTED", aiContext: "DENIED", fieldKey: a.fieldKey, factDate: a.at, reviewedBy: tag(a), reviewedAt: now })) { bump(a.expired ? "EXPIRED" : "ONE_OFF"); if (a.expired) droppedIds.add(a.factId); else keptIds.add(a.factId); }
    } else if (a.kind === "cast") {
      const f = byId.get(a.factId)!;
      if (!(await cas(f, { status: "ACCEPTED", aiContext: "ALLOWED", fieldKey: "skit_cast", reviewedBy: tag(a), reviewedAt: now }))) continue;
      keptIds.add(f.id);
      bump("SKIT_CAST");
      // Settings › Skit cast (programStyle.setSkitCast: compare-and-swap, ledgered, deduped by role + name).
      if (enrollment) {
        const { setSkitCast } = await import("@/lib/programStyle");
        await setSkitCast(enrollment.id, { add: { name: a.name, role: a.role, note: `Said on a call${f.factDate ? ` (${f.factDate.toISOString().slice(0, 10)})` : ""}` } }, CURATOR_BY)
          .then((r) => { if (r.changed) bump("castAdded"); })
          .catch((e) => console.warn("[knowledge curator] skit cast not added", clientId, e instanceof Error ? e.message : e));
      }
    } else {
      // ONE LINE PER KEY: the note replaces its source facts and any older note on the same key.
      const sources = a.sourceIds.map((id) => byId.get(id)!).filter(Boolean);
      const single = sources.length === 1 && normalizeTitle(sources[0].body) === normalizeTitle(a.line) ? sources[0] : null;
      let noteId: string | null = null;
      if (single) {
        if (await cas(single, { status: "ACCEPTED", aiContext: "ALLOWED", category: a.category, fieldKey: a.fieldKey, reviewedBy: tag(a), reviewedAt: now, conflictsWithId: null })) noteId = single.id;
      } else {
        const hash = factDedupeHash(a.line);
        const same = await prisma.clientFact.findFirst({ where: { clientId, dedupeHash: hash, status: { not: "UNDONE" } }, select: { id: true } });
        const latest = sources.reduce<Date | null>((m, s) => { const d = s.factDate ?? s.createdAt; return !m || d > m ? d : m; }, null);
        const data = {
          status: "ACCEPTED", aiContext: "ALLOWED", category: a.category, fieldKey: a.fieldKey, reviewedBy: tag(a), reviewedAt: now,
          autoAccepted: true, confidence: a.confidence, aiRunId: runId, conflictsWithId: null,
        };
        if (same) { await prisma.clientFact.update({ where: { id: same.id }, data }); noteId = same.id; }
        else {
          const row = await prisma.clientFact.create({
            data: {
              ...data, clientId, enrollmentId: enrollment?.id ?? sources[0]?.enrollmentId ?? null, body: a.line, source: "ai",
              sourceRef: `curated:${a.sourceIds.join(",")}`.slice(0, 300), callRecordId: sources[0]?.callRecordId ?? null, speaker: "client",
              factDate: latest, scope: "PERMANENT", visibility: "INTERNAL", confidential: false, dedupeHash: hash,
            },
            select: { id: true },
          });
          noteId = row.id;
        }
        for (const s of sources) {
          if (s.id === noteId) continue;
          if (await cas(s, { status: "SUPERSEDED", supersededById: noteId, aiContext: "DENIED", reviewedBy: curatorTag(`${a.decision}_MERGED`, runId, `folded into the ${a.fieldKey} line`), reviewedAt: now })) mergedIds.add(s.id);
        }
      }
      if (!noteId) continue;
      keptIds.add(noteId);
      bump(a.decision);
      await prisma.clientFact.updateMany({ where: { clientId, fieldKey: a.fieldKey, status: "ACCEPTED", id: { not: noteId } }, data: { status: "SUPERSEDED", supersededById: noteId } });
      if (a.decision === "EDITING" || a.decision === "FILMING") notesForProfile.push({ factId: noteId, fieldKey: a.fieldKey, line: a.line, callRecordId: sources[0]?.callRecordId ?? null });
    }
  }

  // THE PROFILE FIELDS THE BRIEF READS (Jordan, Oct 27 2026: "This should be
  // automatically filled out from the AI notes"): a curated editing or filming
  // line with a profile slot (music, pace, captions, wardrobe, …) is applied to
  // that slot (history kept, the editor told as for any brand change); the
  // call's own proposals for facts folded into a line or dropped are closed.
  let profileChanges = 0;
  if (enrollment) {
    const pf = await import("@/lib/profileFields");
    const proposals = await pf.openFieldProposals(clientId).catch(() => []);
    for (const p of proposals) {
      if (!p.factId) continue;
      if (mergedIds.has(p.factId) || droppedIds.has(p.factId)) await pf.ignoreFieldProposal(p.id, CURATOR_BY, mergedIds.has(p.factId) ? "folded into a curated line" : "the fact was dropped").catch(() => null);
      else if (keptIds.has(p.factId)) { const r = await pf.applyFieldProposal(p.id, { email: CURATOR_BY }, { note: "Applied automatically from the call (AI curator)" }).catch(() => null); if (r?.ok) profileChanges++; }
    }
    for (const n of notesForProfile) {
      const id = await pf.proposeFieldChange({ clientId, enrollmentId: enrollment.id, factId: n.factId, fieldKey: n.fieldKey, proposedValue: n.line, callRecordId: n.callRecordId, sourceRef: `curated:${runId}` }).catch(() => null);
      if (!id) continue;
      const r = await pf.applyFieldProposal(id, { email: CURATOR_BY }, { note: "Applied automatically from the client's calls (AI curator)" }).catch(() => null);
      if (r?.ok) profileChanges++;
    }
  }

  // COMPLAINTS (Jordan, Oct 27 2026: "record a complaint, I think they should
  // automatically be recorded"): one per fact, the fact named as its source.
  let issues = 0;
  if (plan.complaints.length) {
    const { createClientIssue } = await import("@/lib/clientIssues");
    for (const c of plan.complaints) {
      const f = byId.get(c.factId);
      if (!f) continue;
      const sourceRef = `ClientFact:${f.id}`;
      if (await prisma.clientIssue.findFirst({ where: { sourceRef }, select: { id: true } })) continue;
      const when = (f.factDate ?? f.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const r = await createClientIssue({ clientId, title: c.title, whatHappened: `Said on a call (${when}): ${f.body}`, source: "call", sourceRef, createdBy: "hub" }).catch(() => null);
      if (r?.ok) issues++;
    }
  }
  return { ok: true, runId, seen: rows.length, confidential: confidential.length, plan, applied, skippedChanged, issues, profileChanges };
}

/**
 * ONE-OFFS EXPIRE (Jordan, Oct 27 2026: "That's not something that should be
 * remembered permanently, that's this month"). A kept one-off is REJECTED a
 * day after the moment it names, the reason on the row. No model.
 */
export async function expireOneOffFacts(now: Date = new Date()): Promise<{ expired: number }> {
  const rows = await prisma.clientFact.findMany({
    where: { status: "ACCEPTED", fieldKey: { startsWith: "oneoff." }, factDate: { lt: new Date(now.getTime() - ONE_OFF_GRACE_MS) } },
    select: { id: true, reviewedBy: true, updatedAt: true }, take: 200,
  });
  let expired = 0;
  for (const r of rows) {
    const t = readCuratorTag(r.reviewedBy);
    const w = await prisma.clientFact.updateMany({ where: { id: r.id, updatedAt: r.updatedAt, status: "ACCEPTED" }, data: { status: "REJECTED", reviewedBy: curatorTag("EXPIRED", t?.runId ?? "rule", "the date it was about has passed"), reviewedAt: now } });
    expired += w.count;
  }
  return { expired };
}

/** The calls a kept one-off said would happen (fieldKey oneoff.call), around now. */
export async function expectedCalls(now: Date = new Date()): Promise<{ factId: string; clientId: string; at: Date; callRecordId: string | null; monthId: string | null; body: string }[]> {
  const rows = await prisma.clientFact.findMany({
    where: { status: "ACCEPTED", fieldKey: "oneoff.call", factDate: { gte: new Date(now.getTime() - 3 * 864e5), lte: new Date(now.getTime() + 45 * 864e5) } },
    select: { id: true, clientId: true, factDate: true, callRecordId: true, monthId: true, body: true }, take: 200,
  });
  return rows.filter((r) => !!r.factDate).map((r) => ({ factId: r.id, clientId: r.clientId, at: r.factDate!, callRecordId: r.callRecordId, monthId: r.monthId, body: r.body }));
}

/** A one-off that found its call has done its job: it expires, the call named on the row. */
export async function markExpectedCallUsed(factId: string, callRecordId: string, now: Date = new Date()): Promise<void> {
  const f = await prisma.clientFact.findUnique({ where: { id: factId }, select: { reviewedBy: true, status: true } });
  if (!f || f.status !== "ACCEPTED") return;
  await prisma.clientFact.updateMany({ where: { id: factId, status: "ACCEPTED" }, data: { status: "REJECTED", reviewedBy: curatorTag("EXPIRED", readCuratorTag(f.reviewedBy)?.runId ?? "rule", `the call it expected is on file (${callRecordId})`), reviewedAt: now } });
}

/**
 * THE 15-MINUTE SWEEP (api/cron/topics, inside the transcript-jobs step): a
 * few clients a run, those with new PROPOSED facts first, each at most every
 * six hours, none whose last curation failed in that time. After a client's
 * run changed something, their agent profile is filled from the calls and the
 * strategy (contentPipeline.buildAgentProfileFromHistory: only empty fields,
 * a person's words always win), at most once a day. Behind `ai_runs`.
 */
export async function sweepKnowledgeCuration(opts: { max?: number; budgetMs?: number; minStartMs?: number; now?: Date } = {}): Promise<{ curated: number; failed: number; profiles: number; expired: number; outOfTime: boolean; skipped?: string }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const left = () => (opts.budgetMs ?? 120_000) - (Date.now() - started);
  const { expired } = await expireOneOffFacts(now);
  const { isAutomationEnabled } = await import("@/lib/programAutomation");
  if (!(await isAutomationEnabled("ai_runs"))) return { curated: 0, failed: 0, profiles: 0, expired, outOfTime: false, skipped: "ai_runs is off" };
  const active = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true } });
  const ids = active.map((e) => e.clientId);
  if (!ids.length) return { curated: 0, failed: 0, profiles: 0, expired, outOfTime: false };
  const [proposed, any, recent] = await Promise.all([
    prisma.clientFact.groupBy({ by: ["clientId"], where: { ...undecidedWhere(), clientId: { in: ids }, status: "PROPOSED" }, _count: { _all: true } }),
    prisma.clientFact.groupBy({ by: ["clientId"], where: { ...undecidedWhere(), clientId: { in: ids } }, _count: { _all: true } }),
    prisma.programAiRun.findMany({ where: { kind: "knowledge_curation", clientId: { in: ids }, createdAt: { gte: new Date(now.getTime() - CLIENT_COOLDOWN_MS) } }, select: { clientId: true, status: true } }),
  ]);
  const cooling = new Set(recent.map((r) => r.clientId).filter((x): x is string => !!x));
  const order = [...new Set([...proposed.map((p) => p.clientId), ...any.map((p) => p.clientId)])].filter((id) => !cooling.has(id));
  let curated = 0, failed = 0, profiles = 0, outOfTime = false;
  for (const clientId of order.slice(0, opts.max ?? 2)) {
    if (left() < (opts.minStartMs ?? 60_000)) { outOfTime = true; break; }
    const r = await curateClientKnowledge(clientId, { requestedBy: "cron", unattended: true, now });
    if (!r.ok) { failed++; if (/switched off/i.test(r.reason)) break; continue; }
    curated++;
    const changed = Object.values(r.applied).some((n) => n > 0);
    if (!changed || left() < (opts.minStartMs ?? 60_000)) continue;
    const lastProfile = await prisma.programAiRun.findFirst({ where: { kind: "profile_draft", clientId, status: "SUCCEEDED", createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } }, select: { id: true } });
    if (lastProfile) continue;
    const { buildAgentProfileFromHistory } = await import("@/lib/contentPipeline");
    await buildAgentProfileFromHistory(clientId, { requestedBy: "cron", unattended: true }).then(() => { profiles++; }).catch((e) => console.warn("[knowledge curator] profile fill failed", clientId, e instanceof Error ? e.message : e));
  }
  return { curated, failed, profiles, expired, outOfTime };
}

// ---------------------------------------------------------------------------
// WHAT THE AI KEPT — the read behind Plan › Knowledge (read-only).
// ---------------------------------------------------------------------------
export type KeptItem = { id: string; body: string; place: KeptPlace; reason: string | null; when: string | null; by: "ai" | "person" | "auto" };
export type DroppedItem = { id: string; body: string; reason: string | null; when: string | null };
export type KnowledgeViewData = { kept: KeptItem[]; dropped: DroppedItem[]; waiting: number; merged: number; lastRunAt: string | null };

const fmtDay = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);

export async function loadKnowledgeView(clientId: string): Promise<KnowledgeViewData> {
  const [kept, dropped, waiting, merged, lastRun] = await Promise.all([
    prisma.clientFact.findMany({ where: { clientId, status: "ACCEPTED", source: { not: "field" } }, orderBy: [{ updatedAt: "desc" }], take: 200, select: { id: true, body: true, fieldKey: true, category: true, aiContext: true, confidential: true, reviewedBy: true, factDate: true, createdAt: true } }),
    prisma.clientFact.findMany({ where: { clientId, status: "REJECTED", source: { not: "field" } }, orderBy: [{ updatedAt: "desc" }], take: 60, select: { id: true, body: true, reviewedBy: true, factDate: true, createdAt: true } }),
    prisma.clientFact.count({ where: undecidedWhere(clientId) }),
    prisma.clientFact.count({ where: { clientId, status: "SUPERSEDED" } }),
    prisma.programAiRun.findFirst({ where: { kind: "knowledge_curation", clientId, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return {
    kept: kept.map((f) => {
      const t = readCuratorTag(f.reviewedBy);
      return { id: f.id, body: f.body, place: keptPlaceOf(f), reason: t?.reason ?? null, when: fmtDay(f.factDate ?? f.createdAt), by: t ? "ai" : !f.reviewedBy || f.reviewedBy === "auto" || f.reviewedBy.startsWith("ai-") ? "auto" : "person" };
    }),
    dropped: dropped.map((f) => ({ id: f.id, body: f.body, reason: readCuratorTag(f.reviewedBy)?.reason ?? null, when: fmtDay(f.factDate ?? f.createdAt) })),
    waiting, merged, lastRunAt: lastRun?.createdAt.toISOString() ?? null,
  };
}

/** Accepted style-inspiration lines, for the creative identity card (identity.style_inspirations). */
export async function styleInspirationsFor(clientId: string): Promise<string[]> {
  const rows = await prisma.clientFact.findMany({ where: { clientId, status: "ACCEPTED", fieldKey: "identity.style_inspirations", confidential: false }, orderBy: { updatedAt: "desc" }, take: 6, select: { body: true } });
  return rows.map((r) => r.body);
}

/** The one-line strategy notes from the calls (strategy_note.*), for Plan › Strategy. */
export async function strategyNotesFor(clientId: string): Promise<{ id: string; key: string; line: string; when: string | null }[]> {
  const rows = await prisma.clientFact.findMany({ where: { clientId, status: "ACCEPTED", fieldKey: { startsWith: "strategy_note." }, confidential: false }, orderBy: { updatedAt: "desc" }, take: 20, select: { id: true, fieldKey: true, body: true, factDate: true, createdAt: true } });
  return rows.map((r) => ({ id: r.id, key: r.fieldKey!.slice("strategy_note.".length), line: r.body, when: fmtDay(r.factDate ?? r.createdAt) }));
}

export { CURATOR };

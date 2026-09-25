import "server-only";
import { prisma } from "@/lib/prisma";
import { monthLabel, ownersFor } from "@/lib/contentProgram";
import { parseStoredSections, openStrategyProposals, strategyVersions, monthPriorities } from "@/lib/contentStrategy";
import { listPillars, pillarMappingProposal, dismissedPillarLabels } from "@/lib/contentPillars";
import { topicBankByPillar, pendingSuggestions, refreshRuns, monthCapacity, bankStock } from "@/lib/contentTopics";
import { interviewState, interviewsForMonth, answersChangedSinceLastDraft } from "@/lib/contentInterview";
import { scriptsAwaitingReview } from "@/lib/contentScripts";
import { factsForReview, factCounts } from "@/lib/clientFacts";
import { importBatches, importReviewItems } from "@/lib/contentImport";
import { activePolicyVersion } from "@/lib/aiRuns";
import type { VersionRow, ProposalRow, PillarRowUi, MappingRowUi, OwnerUi } from "@/components/content/StrategyPanel";
import type { GroupUi, ProposedUi, SuggestionUi, RunUi, EventUi, TopicUi } from "@/components/content/TopicsPanel";
import type { InterviewUi } from "@/components/content/InterviewPanel";
import { interviewPlanningContext } from "@/lib/contentInterview";
import { scriptWorkForMonth } from "@/lib/contentDrafting";
import { scriptDecisionsFor } from "@/lib/scriptDecisions";
import type { ScriptUi, VersionUi } from "@/components/content/ScriptsPanel";
import type { FactUi } from "@/components/content/FactsPanel";
import type { BatchUi, ReviewUi } from "@/components/content/ImportPanel";

// Server-side loaders for the workspace tabs — one function per tab so the
// page stays a layout and each tab pays only for its own queries.

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function loadStrategyTab(enrollmentId: string, month: { id: string; monthKey: string; prioritiesJson: string | null; prioritiesSourceRef: string | null } | null) {
  const [versions, proposals, pillars, mappingRaw, dismissed, owners, staff] = await Promise.all([
    strategyVersions(enrollmentId), openStrategyProposals(enrollmentId), listPillars(enrollmentId), pillarMappingProposal(enrollmentId), dismissedPillarLabels(enrollmentId), ownersFor(enrollmentId, month?.id),
    prisma.appUser.findMany({ where: { status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } }, select: { id: true, name: true, email: true } }),
  ]);
  const vrows: VersionRow[] = versions.map((v) => {
    const stored = parseStoredSections(v.sectionsJson);
    return {
      id: v.id, versionNo: v.versionNo, status: v.status, structureTemplate: v.structureTemplate, sourceKind: v.sourceKind, sourceRef: v.sourceRef, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(),
      approvedBy: v.approvedBy, approvedAt: iso(v.approvedAt), releasedAt: iso(v.releasedAt), changeSummary: v.changeSummary,
      sections: (stored?.sections ?? []).map((s) => ({ heading: s.heading, text: s.text })), pillarNames: stored?.document?.contentPillars.pillars.map((p) => p.name) ?? [],
    };
  });
  const prows: ProposalRow[] = proposals.map((p) => ({ id: p.id, kind: p.kind, summary: p.summary, impact: p.impact, sourceKind: p.sourceKind, sourceRef: p.sourceRef, createdAt: p.createdAt.toISOString() }));
  const pil: PillarRowUi[] = pillars.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, focusAreas: p.focusAreas, aliases: p.aliases, status: p.status }));
  const mapping: MappingRowUi[] = mappingRaw.filter((m) => !dismissed.has(m.label));
  const ow: OwnerUi[] = Object.values(owners).map((o) => ({ duty: o.duty, label: o.label, scope: o.scope, appUserId: o.appUserId }));
  return {
    versions: vrows, proposals: prows, pillars: pil, mapping, owners: ow, staff: staff.map((s) => ({ id: s.id, name: s.name ?? s.email })),
    month: month ? { id: month.id, label: monthLabel(month.monthKey), priorities: monthPriorities(month.prioritiesJson), sourceRef: month.prioritiesSourceRef } : null,
  };
}

export async function loadTopicsTab(enrollmentId: string, month: { id: string; monthKey: string } | null) {
  const [bank, suggestions, runs, pillars, policy, capacity, stock] = await Promise.all([
    topicBankByPillar(enrollmentId), pendingSuggestions(enrollmentId), refreshRuns(enrollmentId, 5), listPillars(enrollmentId), activePolicyVersion(), month ? monthCapacity(month.id) : Promise.resolve(null),
    // CP-07: usable stock per pillar against the target, pending shown apart.
    bankStock(enrollmentId).catch(() => []),
  ]);
  const scriptTopics = new Map((await prisma.contentScript.findMany({ where: { enrollmentId, historical: false, topicId: { not: null }, ...(month ? { monthId: month.id } : {}) }, select: { id: true, topicId: true } })).map((s) => [s.topicId!, s.id]));
  // CP-07: where a month's topic was carried from, and the internal alignment
  // flag on a client's own idea (a SYSTEM event — it never blocked them).
  const monthKeyOfId = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const carriedSel = month ? await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: "CARRIED" }, select: { topicId: true, carriedFromMonthId: true } }) : [];
  const carriedFrom = new Map(carriedSel.map((c) => [c.topicId, c.carriedFromMonthId ? monthKeyOfId.get(c.carriedFromMonthId) ?? "an earlier month" : "an earlier month"]));
  const alignmentRows = await prisma.contentTopicEvent.findMany({ where: { enrollmentId, kind: "DISCUSSED", actorKind: "SYSTEM", note: { startsWith: "Alignment check:" } }, orderBy: { createdAt: "desc" }, select: { topicId: true, note: true } });
  const alignmentOf = new Map<string, string>();
  for (const r of alignmentRows) if (!alignmentOf.has(r.topicId) && r.note) alignmentOf.set(r.topicId, r.note.replace(/^Alignment check:\s*/, ""));
  const withScript = (t: Omit<TopicUi, "scriptId">): TopicUi => ({ ...t, scriptId: scriptTopics.get(t.id) ?? null, carriedFrom: carriedFrom.get(t.id) ?? null, alignment: alignmentOf.get(t.id) ?? null });
  const groups: GroupUi[] = bank.groups.map((g) => ({ pillarId: g.pillarId, pillarName: g.pillarName, topics: g.topics.filter((t) => !month || t.monthId !== month.id).map(withScript) }));
  const monthTopics: TopicUi[] = month ? bank.groups.flatMap((g) => g.topics).filter((t) => t.monthId === month.id).map(withScript) : [];
  const declined: TopicUi[] = bank.declined.map(withScript);
  // Call-PROPOSED selections awaiting a person.
  let proposed: ProposedUi[] = [];
  if (month) {
    const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: "PROPOSED" } });
    const all = bank.groups.flatMap((g) => g.topics);
    proposed = sels.map((s) => {
      const t = all.find((x) => x.id === s.topicId);
      if (!t) return null;
      let ev: { excerpts?: { speaker: string; text: string }[]; clientSpoken?: boolean } = {};
      try { ev = s.evidenceJson ? JSON.parse(s.evidenceJson) : {}; } catch { ev = {}; }
      return { topic: withScript(t), evidence: (ev.excerpts ?? []).map((e) => ({ speaker: e.speaker, text: e.text })), clientSpoken: ev.clientSpoken !== false && (ev.excerpts ?? []).some((e) => e.speaker === "client"), overflow: s.overflow };
    }).filter((x): x is ProposedUi => !!x);
  }
  const pillarName = (id: string | null) => pillars.find((p) => p.id === id)?.name ?? null;
  const toSug = (s: (typeof suggestions)[number]): SuggestionUi => ({ id: s.id, kind: s.kind, rank: s.rank, title: s.title, description: s.description, pillarName: pillarName(s.pillarId), audienceNeed: s.audienceNeed, businessGoal: s.businessGoal, intendedMessage: s.intendedMessage, rationale: s.rationale, whyNow: s.whyNow, linkedGoal: s.linkedGoal, priorContentRelation: s.priorContentRelation, relatedTopicId: s.relatedTopicId, runSummary: null });
  const latestRec = runs.find((r) => r.kind === "RECOMMENDATION" && r.status === "SUCCEEDED");
  const recommended = suggestions.filter((s) => (s.kind === "RECOMMENDED" || s.kind === "ALTERNATIVE") && (!latestRec || s.refreshRunId === latestRec.id)).map(toSug);
  const bankSugg = suggestions.filter((s) => s.kind === "BANK").map(toSug);
  const runRows: RunUi[] = runs.map((r) => { let missing: string[] = []; try { const mc = r.missingContextJson ? (JSON.parse(r.missingContextJson) as { missing?: string[]; gaps?: string[] }) : null; missing = [...(mc?.missing ?? []), ...(mc?.gaps ?? [])]; } catch { /* none */ } return { id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt.toISOString(), changeSummary: r.changeSummary, missing, requestedBy: r.requestedBy }; });
  // Histories for the month's topics + proposed (the bank rows load theirs lazily through the same map when small).
  const histTopicIds = [...monthTopics.map((t) => t.id), ...proposed.map((p) => p.topic.id), ...groups.flatMap((g) => g.topics.slice(0, 15).map((t) => t.id))];
  const events = histTopicIds.length ? await prisma.contentTopicEvent.findMany({ where: { topicId: { in: histTopicIds } }, orderBy: { createdAt: "asc" } }) : [];
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const histories: Record<string, EventUi[]> = {};
  for (const e of events) (histories[e.topicId] ??= []).push({ kind: e.kind, actorKind: e.actorKind, note: e.note, createdAt: e.createdAt.toISOString(), monthKey: e.monthId ? monthKeys.get(e.monthId) ?? null : null });
  // Interviews on the month.
  const interviews: Record<string, InterviewUi> = {};
  if (month) {
    for (const iv of await interviewsForMonth(month.id)) {
      const st = await interviewState(iv.id);
      const t = monthTopics.find((x) => x.id === iv.topicId) ?? proposed.find((p) => p.topic.id === iv.topicId)?.topic;
      const hasDraft = (await prisma.contentScriptVersion.count({ where: { interviewId: iv.id } })) > 0;
      interviews[iv.topicId] = {
        interviewId: iv.id, topicId: iv.topicId, topicTitle: t?.title ?? "", status: st.status, answeredCount: st.answeredCount, nextKey: st.nextKey,
        tailored: (await interviewPlanningContext(iv.id).catch(() => null))?.hasPlan ?? false,
        next: st.next.kind === "done" ? { kind: "done" } : { kind: st.next.kind, prompt: st.next.prompt, label: st.next.question.id, condition: st.next.kind === "follow-up" ? st.next.condition : undefined, substantive: st.next.question.substantive },
        sufficiency: st.sufficiency, answers: st.answers.map((a) => ({ questionKey: a.questionKey, questionText: a.questionText, answerText: a.answerText, answerKind: a.answerKind, version: a.version })),
        answersChangedSinceDraft: await answersChangedSinceLastDraft(iv.id), hasDraft,
      };
    }
  }
  return { groups, proposed, monthTopics, suggestions: bankSugg, recommended, runs: runRows, interviews, histories, pillars: pillars.map((p) => ({ id: p.id, name: p.name })), topicsPerPillar: policy.topicsPerPillar, capacity, archivedCount: bank.archived, declined, stock };
}

export async function loadScriptsTab(enrollmentId: string, month: { id: string } | null) {
  const [scripts, queue, owners, pillars, strategyVs, policies] = await Promise.all([
    prisma.contentScript.findMany({ where: { enrollmentId, ...(month ? { monthId: month.id } : {}) }, orderBy: { createdAt: "asc" } }),
    scriptsAwaitingReview(enrollmentId), ownersFor(enrollmentId, month?.id), listPillars(enrollmentId, { includeRetired: true }),
    prisma.contentStrategyVersion.findMany({ where: { enrollmentId }, select: { id: true, versionNo: true } }), prisma.programGenerationPolicyVersion.findMany({ select: { id: true, versionNo: true } }),
  ]);
  const versions = scripts.length ? await prisma.contentScriptVersion.findMany({ where: { scriptId: { in: scripts.map((s) => s.id) } }, orderBy: { versionNo: "desc" } }) : [];
  // The CLIENT's verdict on each shared script (F09) — the fact that decides
  // whether it is safe to put on a call sheet, and the one nobody could see.
  const verdicts = scripts.length ? await scriptDecisionsFor(enrollmentId, scripts.map((s) => s.id)).catch(() => new Map()) : new Map();
  const months = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const rows: ScriptUi[] = scripts.map((s) => {
    const vs = versions.filter((v) => v.scriptId === s.id);
    const toV = (v: (typeof vs)[number]): VersionUi => {
      let findings: VersionUi["findings"] = [], gaps: VersionUi["gaps"] = [], points = 0, answers = 0, regenerated: string[] = [];
      try { if (v.validationJson) findings = (JSON.parse(v.validationJson) as { findings: { severity: string; message: string }[] }).findings ?? []; } catch { /* none */ }
      try { if (v.gapsJson) gaps = JSON.parse(v.gapsJson); } catch { /* none */ }
      try { points = (JSON.parse(v.pointsJson) as unknown[]).length; } catch { /* none */ }
      try { if (v.answerIdsJson) answers = (JSON.parse(v.answerIdsJson) as unknown[]).length; } catch { /* none */ }
      try { if (v.regeneratedSections) regenerated = JSON.parse(v.regeneratedSections); } catch { /* none */ }
      const basedOn = v.basedOnVersionId ? vs.find((x) => x.id === v.basedOnVersionId)?.versionNo ?? null : null;
      return {
        id: v.id, versionNo: v.versionNo, status: v.status, source: v.source, body: v.body, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(), changeSummary: v.changeSummary, approvedBy: v.approvedBy, approvedAt: iso(v.approvedAt), sharedAt: iso(v.sharedAt),
        estimatedSeconds: v.estimatedSeconds, spokenWordCount: v.spokenWordCount, pointCount: points, findings, gaps, strategyVersionNo: strategyVs.find((x) => x.id === v.strategyVersionId)?.versionNo ?? null, policyVersionNo: policies.find((x) => x.id === v.policyVersionId)?.versionNo ?? null,
        answerCount: answers, path: v.interviewId ? "written answers" : v.callRecordId ? "call" : v.source.toLowerCase().replace("_", " "), basedOnVersionNo: basedOn, regeneratedSections: regenerated,
      };
    };
    // A pre-versioning script shows its legacy body as an implicit v1 until an action lifts it.
    const vlist = vs.length ? vs.map(toV) : [{ id: `legacy:${s.id}`, versionNo: 1, status: ["APPROVED", "READY_TO_FILM", "CLIENT_VISIBLE"].includes(s.status) && !s.historical ? "APPROVED" : "DRAFT", source: s.source.toUpperCase(), body: s.body, createdBy: null, createdAt: s.createdAt.toISOString(), changeSummary: "pre-versioning row (not yet lifted)", approvedBy: null, approvedAt: null, sharedAt: null, estimatedSeconds: null, spokenWordCount: null, pointCount: 3, findings: [], gaps: [], strategyVersionNo: null, policyVersionNo: null, answerCount: 0, path: s.source, basedOnVersionNo: null, regeneratedSections: [] } as VersionUi];
    return {
      id: s.id, title: s.title, status: s.status, historical: s.historical, releaseState: s.releaseState, monthKey: s.monthId ? months.get(s.monthId) ?? null : null, pillarName: pillars.find((p) => p.id === s.pillarId)?.name ?? null,
      currentVersionId: s.currentVersionId, approvedVersionId: s.approvedVersionId, sharedVersionId: s.sharedVersionId, approvedBy: s.approvedBy, approvedAt: iso(s.approvedAt), sharedAt: iso(s.sharedAt), versions: vlist, sourceFile: s.sourceFile,
      clientVerdict: verdicts.get(s.id)?.decision ?? (verdicts.get(s.id)?.staleApproval ? "STALE" : null), clientVerdictAt: verdicts.get(s.id)?.decidedAt ?? null,
    };
  });
  // What the month still OWES, and why each one is or is not ready to draft
  // (F07/F08). Read-only; the doing lives in src/lib/contentDrafting.ts.
  const owed = month ? await scriptWorkForMonth(month.id).catch(() => []) : [];
  return { scripts: rows, queueCount: queue.filter((q) => !month || q.monthId === month.id).length, scriptOwner: owners.SCRIPTS.label, owed: owed.filter((o) => o.readiness !== "HAS_SCRIPT") };
}

export async function loadFactsTab(clientId: string, enrollmentId: string) {
  const [facts, counts, months, projects] = await Promise.all([
    factsForReview(clientId, 120), factCounts(clientId), prisma.contentMonth.findMany({ where: { enrollmentId }, orderBy: { monthKey: "desc" }, select: { id: true, monthKey: true }, take: 24 }),
    prisma.project.findMany({ where: { clientId, contentMonthId: { not: null } }, orderBy: { shootDate: "desc" }, select: { id: true, title: true }, take: 24 }),
  ]);
  const conflictIds = facts.map((f) => f.conflictsWithId).filter((x): x is string => !!x);
  const conflicts = conflictIds.length ? await prisma.clientFact.findMany({ where: { id: { in: conflictIds } }, select: { id: true, body: true } }) : [];
  const rows: FactUi[] = facts.map((f) => {
    let excerpt: string | null = null;
    try { if (f.excerptJson) { const ex = JSON.parse(f.excerptJson) as { text?: string }[]; excerpt = ex[0]?.text ?? null; } } catch { /* none */ }
    return {
      id: f.id, category: f.category, body: f.body, source: f.source, sourceRef: f.sourceRef, speaker: f.speaker, factDate: iso(f.factDate), scope: f.scope, monthKey: f.monthId ? months.find((m) => m.id === f.monthId)?.monthKey ?? null : null, projectId: f.projectId,
      status: f.status, aiContext: f.aiContext, confidential: f.confidential, conflictsWithBody: f.conflictsWithId ? conflicts.find((c) => c.id === f.conflictsWithId)?.body ?? null : null, autoAccepted: f.autoAccepted, reviewedBy: f.reviewedBy, undoneBy: f.undoneBy, excerpt,
    };
  });
  return { facts: rows, counts, months: months.map((m) => ({ id: m.id, key: m.monthKey })), projects };
}

export async function loadImportTab(enrollmentId: string) {
  const [batches, reviewItems, pillars, migrated] = await Promise.all([importBatches(enrollmentId), importReviewItems(enrollmentId), listPillars(enrollmentId), prisma.contentNote.count({ where: { migratedFactId: { not: null } } })]);
  const b: BatchUi[] = batches.map((x) => ({ id: x.id, kind: x.kind, fileName: x.fileName, mode: x.mode, proposedMonthKey: x.proposedMonthKey, appliedAt: iso(x.appliedAt), appliedBy: x.appliedBy, created: x.itemsCreated, linked: x.itemsLinked, updated: x.itemsUpdated, conflicts: x.itemsConflict, skipped: x.itemsSkipped }));
  const r: ReviewUi[] = reviewItems.map((x) => ({ kind: x.kind, monthKey: x.monthKey, title: x.title, detail: x.detail }));
  return { batches: b, reviewItems: r, pillars: pillars.map((p) => ({ id: p.id, name: p.name })), migrationDone: migrated > 0 };
}

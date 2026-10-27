import "server-only";
import { prisma } from "@/lib/prisma";
import { monthLabel, ownersFor } from "@/lib/contentProgram";
import { withCanonicalFrameworkSections, creativeIdentityFromOverrides } from "@/lib/contentPolicy";
import type { CreativeIdentityUi } from "@/components/content/CreativeIdentityCard";
import { parseStoredSections, openStrategyProposals, strategyVersions, monthPriorities } from "@/lib/contentStrategy";
import { listPillars } from "@/lib/contentPillars";
import { topicBankByPillar, pendingSuggestions, refreshRuns, monthCapacity, bankStock, heldSuggestions, suggestionFormats } from "@/lib/contentTopics";
import { videoStyleFromOverrides, skitsPerMonthFromOverrides, resolvedTopicFormat, versionFormatOf, topicFormatOf, defaultFormatFor } from "@/lib/contentPolicy/videoFormat";
import { interviewState, interviewsForMonth, answersChangedSinceLastDraft } from "@/lib/contentInterview";
import { readAngle, readJudge, judgeLine, judgeFlagged } from "@/lib/scriptJudgeRecord";
import { writerCardOf } from "@/lib/scriptWriter/record";
import { factsForReview, factCounts } from "@/lib/clientFacts";
import { importBatches, importReviewItems } from "@/lib/contentImport";
import { activePolicyVersion } from "@/lib/aiRuns";
import { queueStateFor, type QueueItemUi } from "@/lib/aiQueue";
import type { VersionRow, ProposalRow, PillarRowUi, OwnerUi, DiscoveryUi } from "@/components/content/StrategyPanel";
import type { GroupUi, ProposedUi, SuggestionUi, RunUi, EventUi, TopicUi } from "@/components/content/TopicsPanel";
import type { InterviewUi } from "@/components/content/InterviewPanel";
import { interviewPlanningContext } from "@/lib/contentInterview";
import { scriptWorkForMonth } from "@/lib/contentDrafting";
import { scriptDecisionsFor } from "@/lib/scriptDecisions";
import { LEGACY_CLIENT_STATUSES, rewriteRefusal } from "@/lib/scriptRewriteRule";
import type { ScriptUi, VersionUi } from "@/components/content/ScriptsPanel";
import type { FactUi } from "@/components/content/FactsPanel";
import type { MonthBriefsUi, TopicBriefUi } from "@/components/content/TopicBriefFold";
import type { BriefRow } from "@/lib/scriptWriter/topicBrief";
import { monthBriefText, topicBriefText } from "@/lib/scriptWriter/briefFormat";
import type { BatchUi, ReviewUi } from "@/components/content/ImportPanel";

// Server-side loaders for the workspace tabs — one function per tab so the
// page stays a layout and each tab pays only for its own queries.

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function loadStrategyTab(enrollmentId: string, month: { id: string; monthKey: string; prioritiesJson: string | null; prioritiesSourceRef: string | null } | null) {
  const [versions, proposals, pillars, owners, staff] = await Promise.all([
    strategyVersions(enrollmentId), openStrategyProposals(enrollmentId), listPillars(enrollmentId), ownersFor(enrollmentId, month?.id),
    prisma.appUser.findMany({ where: { status: "ACTIVE", role: { in: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] } }, select: { id: true, name: true, email: true } }),
  ]);
  const vrows: VersionRow[] = versions.map((v) => {
    const stored = parseStoredSections(v.sectionsJson);
    return {
      id: v.id, versionNo: v.versionNo, status: v.status, structureTemplate: v.structureTemplate, sourceKind: v.sourceKind, sourceRef: v.sourceRef, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(),
      approvedBy: v.approvedBy, approvedAt: iso(v.approvedAt), releasedAt: iso(v.releasedAt), changeSummary: v.changeSummary,
      // A08: section ids ride along — a hand edit names the ONE section it changes.
      // Oct 6 2026: the Video Structure Framework reads as the house framework
      // for every client (read-time swap; the stored version is untouched).
      sections: withCanonicalFrameworkSections((stored?.sections ?? []).map((s) => ({ id: s.id, heading: s.heading, text: s.text }))), pillarNames: stored?.document?.contentPillars.pillars.map((p) => p.name) ?? [],
    };
  });
  const discovery = await loadDiscoveryUi(enrollmentId, versions).catch(() => null);
  // Oct 12: "Draft from the discovery call" runs in the background (aiQueue.ts).
  const queue = await queueStateFor(enrollmentId).catch(() => ({ topics: {}, scripts: {}, strategy: null, active: [] as string[] }));
  const newestVersionAt = versions.reduce<string | null>((m, v) => { const at = v.createdAt.toISOString(); return !m || at > m ? at : m; }, null);
  const strategyDraft = queue.strategy && !(queue.strategy.state === "failed" && newestVersionAt && newestVersionAt > queue.strategy.at) ? queue.strategy : null;
  if (discovery) discovery.drafting = strategyDraft;
  const prows: ProposalRow[] = proposals.map((p) => ({ id: p.id, kind: p.kind, summary: p.summary, impact: p.impact, sourceKind: p.sourceKind, sourceRef: p.sourceRef, createdAt: p.createdAt.toISOString() }));
  const pil: PillarRowUi[] = pillars.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, focusAreas: p.focusAreas, aliases: p.aliases, status: p.status, emphasis: p.emphasis }));
  const ow: OwnerUi[] = Object.values(owners).map((o) => ({ duty: o.duty, label: o.label, scope: o.scope, appUserId: o.appUserId }));
  // Oct 14 2026: the auto-built creative identity, read-only, with the strategy version it was built from.
  const enr = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true, clientId: true } });
  const ci = creativeIdentityFromOverrides(enr?.overridesJson ?? null);
  const approvedNow = versions.filter((v) => v.status === "APPROVED").sort((a, b) => b.versionNo - a.versionNo)[0] ?? null;
  // Oct 27 2026: plus the style inspirations the knowledge curator kept from their calls.
  const styleInspirations = ci && enr ? await import("@/lib/knowledgeCurator").then((m) => m.styleInspirationsFor(enr.clientId)).catch(() => []) : [];
  const creativeIdentity: CreativeIdentityUi | null = ci
    ? { identity: ci, builtFromVersionNo: versions.find((v) => v.id === ci.strategyVersionId)?.versionNo ?? null, stale: !!approvedNow && approvedNow.id !== ci.strategyVersionId, derivedAt: ci.derivedAt || null, styleInspirations }
    : null;
  return {
    discovery, queueActive: queue.active, creativeIdentity, hasApprovedStrategy: !!approvedNow,
    versions: vrows, proposals: prows, pillars: pil, owners: ow, staff: staff.map((s) => ({ id: s.id, name: s.name ?? s.email })),
    month: month ? { id: month.id, label: monthLabel(month.monthKey), priorities: monthPriorities(month.prioritiesJson), sourceRef: month.prioritiesSourceRef } : null,
  };
}

/**
 * The brand-discovery strip on the Strategy tab (A08, Sep 25 2026): the
 * discovery call on file, whether its transcript is confirmed (so a draft can
 * be made from it now, by a click), whether its analysis has run, and the
 * version it already produced. Read-only.
 */
async function loadDiscoveryUi(enrollmentId: string, versions: { versionNo: number; callRecordId: string | null }[]): Promise<DiscoveryUi | null> {
  const ob = await prisma.programOnboarding.findUnique({ where: { enrollmentId }, select: { discoveryCallRecordId: true, discoveryRequired: true, discoveryWaivedAt: true, discoveryWaivedBy: true, discoveryWaivedReason: true } });
  const select = { id: true, status: true, scheduledStart: true, transcriptState: true, matchState: true, rawJson: true } as const;
  const call = ob?.discoveryCallRecordId
    ? await prisma.programCallRecord.findUnique({ where: { id: ob.discoveryCallRecordId }, select })
    : await prisma.programCallRecord.findFirst({ where: { enrollmentId, callType: "BRAND_DISCOVERY", status: { notIn: ["CANCELLED", "RESCHEDULED"] } }, orderBy: { scheduledStart: "desc" }, select });
  if (!ob && !call) return null;
  const { discoveryAnalysisDone } = await import("@/lib/contentGeneration");
  const drafted = call ? versions.filter((v) => v.callRecordId === call.id).sort((a, b) => a.versionNo - b.versionNo)[0] ?? null : null;
  return {
    required: ob?.discoveryRequired ?? true,
    waived: ob?.discoveryWaivedAt ? { reason: ob.discoveryWaivedReason, by: ob.discoveryWaivedBy } : null,
    call: call ? { id: call.id, whenISO: iso(call.scheduledStart), status: call.status, transcriptState: call.transcriptState, verified: call.matchState === "MATCHED" || call.matchState === "CONFIRMED_BY_STAFF" } : null,
    draftedVersionNo: drafted?.versionNo ?? null,
    analysed: call ? await discoveryAnalysisDone(call.id, call.transcriptState, call.rawJson) : false,
    // Oct 12 2026: the transcript line with "Analyze the call" (callAnalysis.ts).
    transcript: call ? (await import("@/lib/callAnalysis").then((m) => m.loadCallTranscripts({ callRecordIds: [call.id] })).catch(() => []))[0] ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// WHAT THE AGENT SAID, PER TOPIC (Oct 26 2026): the month's current summaries
// (lib/scriptWriter/topicBrief.currentBriefs, newest row per topic, no model
// call), shaped for the office (components/content/TopicBriefFold). Read in
// one round of small queries beside the month's chosen topics, then one for
// the date of the call they were written from ("From the October 20 call").
// ---------------------------------------------------------------------------
const BRIEF_CHOSEN = ["SELECTED", "RECONCILED", "CARRIED"];
const briefDay = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });

export async function loadMonthBriefs(monthId: string): Promise<MonthBriefsUi> {
  const { currentBriefs } = await import("@/lib/scriptWriter/topicBrief");
  const [cur, sels, links] = await Promise.all([
    currentBriefs(monthId),
    prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: BRIEF_CHOSEN }, removedAt: null }, orderBy: [{ rank: "asc" }, { createdAt: "asc" }], select: { topicId: true } }),
    prisma.contentTopicBrief.findMany({ where: { monthId, callRecordId: { not: null } }, select: { id: true, callRecordId: true } }),
  ]);
  const callIds = [...new Set(links.map((l) => l.callRecordId!))];
  const calls = callIds.length ? await prisma.programCallRecord.findMany({ where: { id: { in: callIds } }, select: { id: true, scheduledStart: true } }) : [];
  const callOf = new Map(links.map((l) => [l.id, l.callRecordId!]));
  const dayOf = (briefId: string) => { const at = calls.find((c) => c.id === callOf.get(briefId))?.scheduledStart; return at ? briefDay(at) : null; };
  const ui = (r: BriefRow): TopicBriefUi | null => (!r.brief && !r.text.trim() ? null : {
    briefId: r.id, title: r.brief?.title ?? "", text: r.text, route: r.route === "WRITTEN" ? "WRITTEN" : "CALL", edited: r.edited, editedBy: r.editedBy,
    discussed: r.brief ? r.brief.discussed !== false : true, createdAt: r.createdAt.toISOString(), callDate: r.route === "WRITTEN" ? null : dayOf(r.id),
  });
  const chosenIds = [...new Set(sels.map((s) => s.topicId))];
  const byTopic: Record<string, TopicBriefUi | null> = {};
  for (const [topicId, r] of cur.byTopic) byTopic[topicId] = ui(r);
  for (const id of chosenIds) byTopic[id] ??= null;
  const h = cur.header?.header ?? null;
  const header = cur.header && h ? { opening: h.opening, mainRequest: h.mainRequest ?? null, held: (h.held ?? []).map((x) => ({ title: String(x.title ?? ""), why: String(x.why ?? "") })), callDate: dayOf(cur.header.id) } : null;
  // "Copy all": the month in Jordan's layout (monthBriefText), each topic in
  // its chosen order and in the office's wording where it was edited.
  const numbered = (r: BriefRow, n: number) => {
    if (!r.edited && r.brief) return topicBriefText(r.brief, n);
    const title = r.brief?.title?.trim() ?? "";
    return title && r.text.split("\n")[0].trim() !== title ? `${n}. ${title}\n\n${r.text.trim()}` : `${n}. ${r.text.trim()}`;
  };
  const rows = chosenIds.map((id) => cur.byTopic.get(id)).filter((r): r is BriefRow => !!r && !!ui(r));
  const parts = [
    h ? monthBriefText({ opening: h.opening, mainRequest: h.mainRequest ?? null, topics: [], held: [] }) : "",
    ...rows.map((r, i) => numbered(r, i + 1)),
    h?.held?.length ? monthBriefText({ opening: "", mainRequest: null, topics: [], held: h.held.map((x) => ({ title: String(x.title ?? ""), why: String(x.why ?? ""), ideas: Array.isArray(x.ideas) ? x.ideas.map(String) : [] })) }) : "",
  ].map((x) => x.trim()).filter(Boolean);
  return { monthId, chosenIds, header, byTopic, copyText: parts.length ? parts.join("\n\n") : null };
}

export async function loadTopicsTab(enrollmentId: string, month: { id: string; monthKey: string } | null) {
  const [bank, suggestions, runs, pillars, policy, capacity, stock, queue, briefs] = await Promise.all([
    topicBankByPillar(enrollmentId), pendingSuggestions(enrollmentId), refreshRuns(enrollmentId, 5), listPillars(enrollmentId), activePolicyVersion(), month ? monthCapacity(month.id) : Promise.resolve(null),
    // CP-07: usable stock per pillar against the target, pending shown apart.
    bankStock(enrollmentId).catch(() => []),
    // Oct 12: the month's queued / drafting / failed script drafts (aiQueue.ts).
    queueStateFor(enrollmentId, { monthId: month?.id ?? null }).catch(() => ({ topics: {}, scripts: {}, strategy: null, active: [] as string[] })),
    // Oct 26 2026: what the agent said, per chosen topic (no model call).
    month ? loadMonthBriefs(month.id).catch(() => null) : Promise.resolve(null),
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
  // Oct 22 2026: each topic's format (its own, else the account's default) and the account's style.
  const enr = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const videoStyle = videoStyleFromOverrides(enr?.overridesJson ?? null);
  const skitsPerMonth = skitsPerMonthFromOverrides(enr?.overridesJson ?? null);
  const withScript = (t: Omit<TopicUi, "scriptId" | "format" | "formatOwn"> & { videoFormat?: import("@/lib/contentPolicy/videoFormat").VideoFormat | null }): TopicUi => ({ ...t, scriptId: scriptTopics.get(t.id) ?? null, carriedFrom: carriedFrom.get(t.id) ?? null, alignment: alignmentOf.get(t.id) ?? null, format: resolvedTopicFormat(t.videoFormat ?? null, videoStyle), formatOwn: !!t.videoFormat });
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
  // Oct 22 2026: a pending idea's format, kept on its run (a skit concept says so before it is accepted).
  const sugFormat = await suggestionFormats(suggestions).catch(() => new Map<string, import("@/lib/contentPolicy/videoFormat").VideoFormat>());
  const toSug = (s: (typeof suggestions)[number]): SuggestionUi => ({ id: s.id, kind: s.kind, rank: s.rank, title: s.title, description: s.description, pillarName: pillarName(s.pillarId), audienceNeed: s.audienceNeed, businessGoal: s.businessGoal, intendedMessage: s.intendedMessage, rationale: s.rationale, whyNow: s.whyNow, linkedGoal: s.linkedGoal, priorContentRelation: s.priorContentRelation, relatedTopicId: s.relatedTopicId, runSummary: null, clientReason: s.clientReason, format: sugFormat.get(s.id) ?? defaultFormatFor(videoStyle) });
  // 6.3: suggestions staff put on hold — off the review list until released.
  const held = (await heldSuggestions(enrollmentId).catch(() => [])).map(toSug);
  const latestRec = runs.find((r) => r.kind === "RECOMMENDATION" && r.status === "SUCCEEDED");
  const recommended = suggestions.filter((s) => (s.kind === "RECOMMENDED" || s.kind === "ALTERNATIVE") && (!latestRec || s.refreshRunId === latestRec.id)).map(toSug);
  const bankSugg = suggestions.filter((s) => s.kind === "BANK").map(toSug);
  const runRows: RunUi[] = runs.map((r) => { let missing: string[] = []; try { const mc = r.missingContextJson ? (JSON.parse(r.missingContextJson) as { missing?: string[]; gaps?: string[] }) : null; missing = [...(mc?.missing ?? []), ...(mc?.gaps ?? [])]; } catch { /* none */ } return { id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt.toISOString(), changeSummary: r.changeSummary, missing, requestedBy: r.requestedBy }; });
  // Histories for the month's topics + proposed (the bank rows load theirs lazily through the same map when small).
  const histTopicIds = [...monthTopics.map((t) => t.id), ...proposed.map((p) => p.topic.id), ...groups.flatMap((g) => g.topics.slice(0, 15).map((t) => t.id))];
  const events = histTopicIds.length ? await prisma.contentTopicEvent.findMany({ where: { topicId: { in: histTopicIds } }, orderBy: { createdAt: "asc" } }) : [];
  // The month keys read above (audit D15: they were read twice).
  const histories: Record<string, EventUi[]> = {};
  for (const e of events) (histories[e.topicId] ??= []).push({ kind: e.kind, actorKind: e.actorKind, note: e.note, createdAt: e.createdAt.toISOString(), monthKey: e.monthId ? monthKeyOfId.get(e.monthId) ?? null : null });
  // Interviews on the month — each one's four reads together, and the
  // interviews side by side (audit D15: about four awaited reads per
  // interview, one interview after another).
  const interviews: Record<string, InterviewUi> = {};
  if (month) {
    const read = await Promise.all((await interviewsForMonth(month.id)).map(async (iv) => {
      const [st, draftCount, plan, changed] = await Promise.all([
        interviewState(iv.id),
        prisma.contentScriptVersion.count({ where: { interviewId: iv.id } }),
        interviewPlanningContext(iv.id).catch(() => null),
        answersChangedSinceLastDraft(iv.id),
      ]);
      return { iv, st, hasDraft: draftCount > 0, tailored: plan?.hasPlan ?? false, changed };
    }));
    for (const { iv, st, hasDraft, tailored, changed } of read) {
      const t = monthTopics.find((x) => x.id === iv.topicId) ?? proposed.find((p) => p.topic.id === iv.topicId)?.topic;
      interviews[iv.topicId] = {
        interviewId: iv.id, topicId: iv.topicId, topicTitle: t?.title ?? "", status: st.status, answeredCount: st.answeredCount, nextKey: st.nextKey,
        tailored,
        next: st.next.kind === "done" ? { kind: "done" } : { kind: st.next.kind, prompt: st.next.prompt, label: st.next.question.id, condition: st.next.kind === "follow-up" ? st.next.condition : undefined, substantive: st.next.question.substantive },
        sufficiency: st.sufficiency, answers: st.answers.map((a) => ({ questionKey: a.questionKey, questionText: a.questionText, answerText: a.answerText, answerKind: a.answerKind, version: a.version })),
        answersChangedSinceDraft: changed, hasDraft,
      };
    }
  }
  return { groups, proposed, monthTopics, suggestions: bankSugg, recommended, held, runs: runRows, interviews, histories, pillars: pillars.map((p) => ({ id: p.id, name: p.name })), topicsPerPillar: policy.topicsPerPillar, capacity, archivedCount: bank.archived, declined, stock, drafts: queue.topics, queueActive: queue.active, videoStyle, skitsPerMonth, briefs };
}

export async function loadScriptsTab(enrollmentId: string, month: { id: string } | null) {
  const [scripts, owners, pillars, strategyVs, policies, briefs] = await Promise.all([
    // Oct 23 2026: a draft withdrawn for a question request is not a script of the month (its card is the request's).
    prisma.contentScript.findMany({ where: { enrollmentId, status: { not: "WITHDRAWN" }, ...(month ? { monthId: month.id } : {}) }, orderBy: { createdAt: "asc" } }),
    ownersFor(enrollmentId, month?.id), listPillars(enrollmentId, { includeRetired: true }),
    prisma.contentStrategyVersion.findMany({ where: { enrollmentId }, select: { id: true, versionNo: true } }), prisma.programGenerationPolicyVersion.findMany({ select: { id: true, versionNo: true } }),
    // Oct 26 2026: what the agent said about each script's topic, for the card's fold above the Writer's notes.
    month ? loadMonthBriefs(month.id).catch(() => null) : Promise.resolve(null),
  ]);
  const versions = scripts.length ? await prisma.contentScriptVersion.findMany({ where: { scriptId: { in: scripts.map((s) => s.id) } }, orderBy: { versionNo: "desc" } }) : [];
  // Oct 22 2026: each script's topic format (its own, else the account's default), beside the format each version was written in.
  const enr = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const accountStyle = videoStyleFromOverrides(enr?.overridesJson ?? null);
  const topicIdsOfScripts = [...new Set(scripts.map((s) => s.topicId).filter((x): x is string => !!x))];
  const topicFormats = new Map((topicIdsOfScripts.length ? await prisma.contentTopic.findMany({ where: { id: { in: topicIdsOfScripts } }, select: { id: true, scoresJson: true } }) : []).map((t) => [t.id, topicFormatOf(t.scoresJson)]));
  // The CLIENT's verdict on each shared script (F09) — the fact that decides
  // whether it is safe to put on a call sheet, and the one nobody could see.
  const verdicts = scripts.length ? await scriptDecisionsFor(enrollmentId, scripts.map((s) => s.id)).catch(() => new Map()) : new Map();
  const months = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  // Oct 22 2026 (audit M5): a bulk plan's months (bulkPlan.ts): its released scripts are the client's bank, never awaiting their approval.
  const bulkMonths = new Set((await prisma.contentBulkPlan.findMany({ where: { enrollmentId, status: { not: "CANCELLED" } }, select: { monthId: true } })).map((b) => b.monthId));
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
      // Oct 22 2026: the new writer's brief, creative review and rationale
      // (staff only). Its review line lives in those notes, not the old check line.
      const writer = writerCardOf(v.validationJson);
      return {
        id: v.id, versionNo: v.versionNo, status: v.status, source: v.source, body: v.body, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(), changeSummary: v.changeSummary, approvedBy: v.approvedBy, approvedAt: iso(v.approvedAt), sharedAt: iso(v.sharedAt),
        estimatedSeconds: v.estimatedSeconds, spokenWordCount: v.spokenWordCount, pointCount: points, findings, gaps, strategyVersionNo: strategyVs.find((x) => x.id === v.strategyVersionId)?.versionNo ?? null, policyVersionNo: policies.find((x) => x.id === v.policyVersionId)?.versionNo ?? null,
        answerCount: answers, path: v.interviewId ? "written answers" : v.callRecordId ? "call" : v.source.toLowerCase().replace(/_/g, " "), basedOnVersionNo: basedOn, regeneratedSections: regenerated,
        skit: !!v.speakerLabelsJson, filmingNotes: v.filmingNotes,
        // Oct 22 2026: the format this version was written in (its stamp, else speaker labels mean a skit).
        format: versionFormatOf(v) ?? "DIRECT",
        // Oct 14 2026: the writer's angle and the automatic check's line (staff only).
        angle: readAngle(v.validationJson), flagged: judgeFlagged(readJudge(v.validationJson)),
        writer, check: writer?.review ? null : judgeLine(readJudge(v.validationJson)),
      };
    };
    // A pre-versioning script shows its legacy body as an implicit v1 until an action lifts it.
    const vlist = vs.length ? vs.map(toV) : [{ id: `legacy:${s.id}`, versionNo: 1, status: ["APPROVED", "READY_TO_FILM", "CLIENT_VISIBLE"].includes(s.status) && !s.historical ? "APPROVED" : "DRAFT", source: s.source.toUpperCase(), body: s.body, createdBy: null, createdAt: s.createdAt.toISOString(), changeSummary: "pre-versioning row (not yet lifted)", approvedBy: null, approvedAt: null, sharedAt: null, estimatedSeconds: null, spokenWordCount: null, pointCount: 3, findings: [], gaps: [], strategyVersionNo: null, policyVersionNo: null, answerCount: 0, path: s.source, basedOnVersionNo: null, regeneratedSections: [], skit: false } as VersionUi];
    return {
      id: s.id, title: s.title, status: s.status, historical: s.historical, releaseState: s.releaseState, monthKey: s.monthId ? months.get(s.monthId) ?? null : null, pillarName: pillars.find((p) => p.id === s.pillarId)?.name ?? null,
      currentVersionId: s.currentVersionId, approvedVersionId: s.approvedVersionId, sharedVersionId: s.sharedVersionId, approvedBy: s.approvedBy, approvedAt: iso(s.approvedAt), sharedAt: iso(s.sharedAt), versions: vlist, sourceFile: s.sourceFile,
      clientVerdict: verdicts.get(s.id)?.decision ?? (verdicts.get(s.id)?.staleApproval ? "STALE" : null), clientVerdictAt: verdicts.get(s.id)?.decidedAt ?? null,
      // Oct 22 2026: filmed (lib/scriptFilmed). Not the client's verdict: a chip of its own, and no "hasn't answered yet".
      filmed: verdicts.get(s.id)?.filmed ? { atISO: verdicts.get(s.id)!.filmed!.atISO, signal: verdicts.get(s.id)!.filmed!.signal } : null,
      topicFormat: s.topicId ? resolvedTopicFormat(topicFormats.get(s.topicId) ?? null, accountStyle) : null,
      bulkBank: !!s.monthId && bulkMonths.has(s.monthId),
      // Oct 26 2026: the topic's summary of what the agent said (TopicBriefFold), on a monthly topic's script.
      brief: briefs && s.topicId && s.monthId === briefs.monthId && !s.historical ? briefs.byTopic[s.topicId] ?? null : null,
      // Oct 23 2026: "Write it again" and why it is greyed (lib/scriptRewriteRule; the action checks again, the ledger and siblings too).
      rewrite: rewriteRefusal({
        historical: s.historical || s.releaseState === "historical",
        filmed: !!verdicts.get(s.id)?.filmed,
        clientApproved: !!s.clientApprovedVersionId || !!s.clientApprovedAt || verdicts.get(s.id)?.decision === "APPROVED",
        everShared: !!s.sharedVersionId || !!s.sharedAt || s.clientVisible || (LEGACY_CLIENT_STATUSES as readonly string[]).includes(s.status) || vs.some((v) => !!v.sharedAt || v.status === "SHARED"),
        bulkBank: !!s.monthId && bulkMonths.has(s.monthId),
        hasTopic: !!s.topicId,
        hasMonth: !!s.monthId,
      }),
    };
  });
  // 6.5: the client changed an answer after this script was drafted — nothing
  // redrafts on its own, so the reviewer is told here.
  // Side by side (audit D15: one script after another).
  await Promise.all(rows.map(async (row) => {
    const iv = scripts.find((x) => x.id === row.id)?.interviewId;
    if (iv && !row.historical) row.answersChanged = await answersChangedSinceLastDraft(iv).catch(() => false);
  }));
  // What the month still OWES, and why each one is or is not ready to draft
  // (F07/F08). Read-only; the doing lives in src/lib/contentDrafting.ts.
  const owed = month ? await scriptWorkForMonth(month.id).catch(() => []) : [];
  // Oct 12: what the AI queue is doing for this month's scripts — a revision
  // per script (a failure only until a newer version supersedes it), and the
  // owed topics being drafted.
  const aq = await queueStateFor(enrollmentId, { monthId: month?.id ?? null }).catch(() => ({ topics: {}, scripts: {}, strategy: null, active: [] as string[] }));
  const revising: Record<string, QueueItemUi> = {};
  for (const [scriptId, item] of Object.entries(aq.scripts)) {
    const newest = rows.find((r) => r.id === scriptId)?.versions[0]?.createdAt ?? null;
    if (item.state === "failed" && newest && newest > item.at) continue;
    revising[scriptId] = item;
  }
  // The review queue's count is the rows the panel lists under it (audit D15):
  // counted from the scripts already loaded, never every script of the client.
  // Oct 23 2026: the CURRENT version (an automatic fix round set aside in the history can be newer than it).
  const curOf = (r: ScriptUi) => r.versions.find((x) => x.id === r.currentVersionId) ?? r.versions[0];
  const queueCount = rows.filter((r) => !r.historical && (curOf(r)?.status === "DRAFT" || curOf(r)?.status === "INTERNAL_REVIEW")).length;
  // Oct 23 2026: the month's open question requests (Send Question Request): "Questions sent · waiting on …", Undo, Resend.
  const questionRequests = month ? await import("@/lib/questionRequests").then((m) => m.questionRequestsForMonth(month.id)).catch(() => []) : [];
  // Oct 26 2026: scripts removed from this month (Remove from this month), each with Put it back.
  const removed = month ? await import("@/lib/scriptRemoval").then((m) => m.removedScriptsForMonth(month.id)).catch(() => []) : [];
  return { scripts: rows, queueCount, scriptOwner: owners.SCRIPTS.label, owed: owed.filter((o) => o.readiness !== "HAS_SCRIPT"), revising, drafting: aq.topics, queueActive: aq.active, questionRequests, removed };
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
  // Oct 20 2026 (audit D21): the company-wide "one-time lifts" button is gone
  // from every client's Import tab (the lifts ran Sep 17), and with it this
  // count of notes across ALL clients.
  const [batches, reviewItems, pillars] = await Promise.all([importBatches(enrollmentId), importReviewItems(enrollmentId), listPillars(enrollmentId)]);
  const b: BatchUi[] = batches.map((x) => ({ id: x.id, kind: x.kind, fileName: x.fileName, mode: x.mode, proposedMonthKey: x.proposedMonthKey, appliedAt: iso(x.appliedAt), appliedBy: x.appliedBy, created: x.itemsCreated, linked: x.itemsLinked, updated: x.itemsUpdated, conflicts: x.itemsConflict, skipped: x.itemsSkipped }));
  const r: ReviewUi[] = reviewItems.map((x) => ({ kind: x.kind, monthKey: x.monthKey, title: x.title, detail: x.detail }));
  return { batches: b, reviewItems: r, pillars: pillars.map((p) => ({ id: p.id, name: p.name })) };
}

// ---------------------------------------------------------------------------
// PLAN › CALLS and PLAN › SCRIPTS extras (UI-02).
// ---------------------------------------------------------------------------

/** Every call record on the enrollment, newest first, with what we hold from it. */
export async function loadCallsTab(enrollmentId: string) {
  const [calls, months] = await Promise.all([
    prisma.programCallRecord.findMany({
      where: { enrollmentId }, orderBy: { scheduledStart: "desc" }, take: 40,
      select: { id: true, callType: true, status: true, scheduledStart: true, transcriptState: true, matchState: true, lastError: true, monthId: true, targetMonthKey: true },
    }),
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } }),
  ]);
  const keyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  return calls.map((c) => ({
    id: c.id, callType: c.callType, status: c.status, scheduledStartISO: iso(c.scheduledStart), transcriptState: c.transcriptState, matchState: c.matchState,
    lastError: c.lastError, monthKey: (c.monthId ? keyOf.get(c.monthId) : null) ?? c.targetMonthKey ?? null,
  }));
}
export type CallRowUi = Awaited<ReturnType<typeof loadCallsTab>>[number];

/**
 * The client's OPEN script change requests on the month, grouped per script —
 * the queue the Overview's retired ScriptReview list used to hold (and the
 * only place staff ever saw it; see scriptDecisions.ts).
 */
export async function loadScriptRequests(month: { id: string } | null) {
  if (!month) return [];
  // Oct 20 2026: open AND handled requests, each with the version the client
  // read, her words laid over it, and the office's replies (lib/scriptRequests).
  const { loadScriptRequestsForMonth } = await import("@/lib/scriptRequests");
  return loadScriptRequestsForMonth(month.id);
}

/** The legacy free-text notes, shown under Knowledge while they migrate to facts. */
export async function loadLegacyNotes(clientId: string) {
  const notes = await prisma.contentNote.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 30 });
  return notes.map((n) => ({ id: n.id, body: n.body, authorName: n.authorName, intelligence: n.intelligence, at: n.createdAt.toISOString() }));
}

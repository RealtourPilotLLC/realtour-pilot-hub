import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { canonicalFromParts, createScriptVersion, partsFromBody, STRUCTURAL_CODES, type VersionParts } from "@/lib/contentScripts";
import { ALLOWANCE_SELECTION_STATUSES, createTopic, recordTopicEvent, selectTopicForMonth, type Actor } from "@/lib/contentTopics";
import { GENERATION_POLICY, normalizeTitle, renderScript, titleSimilarity, validateNewScript } from "@/lib/contentPolicy";
import { checkAsWritten, hasScriptParts, locateScriptBlocks, pickPillarByWords, readUploadedScript, shapeProblems, splitUploadedScripts, type AsWrittenCheck, type ScriptFormat, type UploadPoint, type UploadSource } from "@/lib/scriptUploadParse";
import { AS_WRITTEN_PROMPT_KEY, AS_WRITTEN_SCHEMA, AS_WRITTEN_SYSTEM, asWrittenPrompt, dimensionsRecord, itemsFromAsWritten, type AsWrittenOut, type PillarChoice, type PillarSource } from "@/lib/scriptUploadAi";

// ---------------------------------------------------------------------------
// "UPLOAD THIS MONTH'S SCRIPTS" (Jordan, Oct 12 2026) — the writing half.
//
//   preview  reads the documents (scriptUploadParse) and proposes, per script,
//            a title, a topic (a bank topic when the title matches one, else a
//            new one), a pillar, its length and anything that stops approval.
//            A document in the house labels is read by the parser (fast); any
//            other shape (a skit, unlabelled paragraphs) is read by the AI AS
//            WRITTEN — attended, logged — and every script it files is checked
//            word for word against the document (Oct 12 2026, Joe Sutow).
//            WRITES NOTHING (the AI run is the log row of a person's click).
//   apply    is the office saying "we planned this month": the scripts' topics
//            become the month's plan (selections, in document order, ahead of
//            anything already picked), each script is a live hub script — a
//            MANUAL version "Written by <name>", in the review queue — and a
//            month with no strategy call on record moves to the written route,
//            stamped as the office's choice (planningChosenBy "office:<email>"),
//            so nothing asks the client for a call or for answers. A month whose
//            call is booked or held keeps its call; these are its scripts.
//   send     approves + releases the month's uploaded scripts through the one
//            canonical share (scriptShare.shareApprovedScripts) — the portal
//            shows them; the email stays behind its own switch (off).
//   undo     takes an upload back while nothing from it has reached the client:
//            its scripts go, the topics it created go, every selection it moved
//            and the route it chose are put back exactly.
//
// The ledger is the existing import ledger: one ContentImportBatch (kind
// MONTH_SCRIPTS) per upload, one ContentImportItem per script with the text
// kept whole. No schema change.
// ---------------------------------------------------------------------------

export const UPLOAD_KIND = "MONTH_SCRIPTS";
export const OFFICE_PLANNED_PREFIX = "office:";
const MAX_SCRIPTS = 30;
const MAX_SOURCE_CHARS = 150_000;

export type UploadDraft = {
  key: string;
  sourceName: string;
  title: string;
  titleFound: boolean;
  /** The script's text (labels in house words) — what apply reads again. */
  text: string;
  /** The script as it will be saved, in the house layout. */
  houseText: string;
  parts: { hook: string; points: UploadPoint[]; close: string; captionCta: string | null };
  categoryLabel: string | null;
  words: number;
  seconds: number;
  pace: "under" | "on" | "over";
  pillarId: string | null;
  topicId: string | null;
  matchKind: "exact" | "month" | null;
  suggestion: { topicId: string; title: string } | null;
  /** A title that names a topic which cannot take a new script (rejected, declined, scripted, picked for another month). */
  conflict: string | null;
  /** Blocks approval until fixed (the house shape). */
  shape: string[];
  /** Words that are not in the script, wording checks, look-alikes. */
  notes: string[];
  isScript: boolean;
  format: ScriptFormat;
  speakers: string[];
  directions: number;
  goal: string | null;
  topicLine: string | null;
  dimensions: string | null;
  /** How the pillar was chosen, in words ("Picked by AI: …", "From the document's Category line"). */
  pillarWhy: string | null;
  /** The word-for-word check against the document (skits and AI readings); null when not run. */
  asWritten: AsWrittenCheck | null;
};

/** A pillar the staff can pick: one of the client's pillars, or a pillar named in their strategy that has no record yet. */
export type PillarOptionUi = { id: string; name: string; from: "pillar" | "approved" | "draft" };

export type BankTopicUi = { id: string; title: string; norm: string; pillarId: string | null; onMonth: boolean; eligible: boolean; why: string | null };
export type MonthSelectionUi = { topicId: string; title: string; status: string; hasScript: boolean; answersStarted: boolean; carried: boolean; replaceable: boolean };

export type UploadPreview = {
  enrollmentId: string;
  monthId: string;
  monthKey: string;
  monthName: string;
  clientName: string;
  fileNames: string[];
  parser: "house" | "ai";
  aiRunId: string | null;
  drafts: UploadDraft[];
  owed: number;
  /** Carried-over scripts take the month's first slots. */
  carried: number;
  selections: MonthSelectionUi[];
  bank: BankTopicUi[];
  pillars: PillarOptionUi[];
  /** Where the pillar list came from: the client's pillars, the approved strategy (records made on Add), a draft strategy, or none. */
  pillarSource: PillarSource;
  route: { keep: boolean; text: string };
  notes: string[];
  /** The extracted documents, kept for "Let AI split it". */
  sources: UploadSource[];
  suggestAi: boolean;
  /** Not in the house labels (a skit, paragraphs, dropped lines): the upload hands it to the AI reading. */
  aiRecommended: boolean;
};

export type UploadItemInput = { text: string; title: string; topicId: string | null; pillarId: string | null; sourceName: string; key?: string };

const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PRODUCTION_DONE = new Set(["FILMED", "EDITING", "DELIVERED"]);
const RULED_OUT = new Set(["REJECTED", "ARCHIVED"]);

function paceOf(seconds: number): UploadDraft["pace"] {
  const t = GENERATION_POLICY.timing;
  return seconds > t.warnAboveSec ? "over" : seconds < t.warnBelowSec ? "under" : "on";
}

/** The month the upload lands on, or the plain reason it can't take one. */
async function uploadMonth(enrollmentId: string, monthId: string) {
  const m = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, videosOwed: true, historical: true, status: true, planningMode: true, planningChosenAt: true, planningChosenBy: true } });
  if (!m || m.enrollmentId !== enrollmentId) throw new Error("That month isn't on this client's program.");
  if (m.historical) throw new Error("That month is imported history — scripts can't be uploaded to it.");
  if (m.status !== "OPEN") throw new Error(`${monthName(m.monthKey)} is ${m.status.toLowerCase()} — open it again before uploading scripts.`);
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, clientSuppliesTopics: true, status: true } });
  if (!e) throw new Error("Enrollment not found.");
  if (e.clientSuppliesTopics) throw new Error("This client plans their own videos — there are no scripts from us to upload. Turn that off in Settings first.");
  const client = await prisma.client.findUnique({ where: { id: m.clientId }, select: { name: true } });
  return { ...m, clientName: client?.name ?? "the client" };
}

const STRATEGY_PILLAR = /^(strategy|draft):([^:]+):(\d{1,2})$/;

/**
 * The content pillars a script can be filed under: the client's pillars; else
 * the pillars their APPROVED strategy names (Joe Sutow, Oct 12: an approved
 * strategy naming five pillars, no pillar records — the version was lifted
 * before approval made them; Add makes them, as approval does); else the
 * latest draft strategy's (kept as the script's label only — a draft makes no
 * pillar); else none.
 */
async function pillarChoices(enrollmentId: string): Promise<{ options: (PillarChoice & { from: PillarOptionUi["from"] })[]; source: PillarSource }> {
  const rows = await listPillars(enrollmentId);
  if (rows.length) return { source: "pillars", options: rows.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, focusAreas: p.focusAreas, from: "pillar" as const })) };
  const { approvedStrategy, parseStoredSections } = await import("@/lib/contentStrategy");
  const approved = await approvedStrategy(enrollmentId).catch(() => null);
  const fromDoc = (versionId: string, kind: "strategy" | "draft", list: { name: string; purpose?: string | null; focusAreas?: string | null }[]) =>
    list.filter((p) => p.name?.trim()).map((p, i) => ({ id: `${kind}:${versionId}:${i}`, name: p.name.trim(), purpose: p.purpose ?? null, focusAreas: p.focusAreas ?? null, from: (kind === "strategy" ? "approved" : "draft") as PillarOptionUi["from"] }));
  const approvedList = approved?.document?.contentPillars?.pillars ?? [];
  if (approved && approvedList.length) return { source: "approved", options: fromDoc(approved.versionId, "strategy", approvedList) };
  const latest = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, orderBy: { versionNo: "desc" }, select: { id: true, sectionsJson: true } });
  const draftList = latest ? parseStoredSections(latest.sectionsJson)?.document?.contentPillars?.pillars ?? [] : [];
  if (latest && draftList.length) return { source: "draft", options: fromDoc(latest.id, "draft", draftList) };
  return { source: "none", options: [] };
}

type TopicRow = { id: string; title: string; status: string; approvalState: string | null; clientDeclinedAt: Date | null; pillarId: string | null; monthId: string | null };

/** Every topic on the enrollment with whether a NEW script for this month may hang off it. */
// ---------------------------------------------------------------------------
// THE HUB'S OWN DRAFTS STEP ASIDE (Jordan, Oct 13 2026): "if I upload scripts
// manually for a month, the scripts that the system wrote should be removed
// from the review queue." Joe Sutow's October: four AI drafts sat in the
// queue with no way to clear them, and because a topic with a script "can't
// take" another, his upload added four NEW topics beside them (8 for 4 owed).
// A system draft is an AI-written script on the month that no person has
// approved, shared, filmed or had the client answer. Uploading for the month
// removes each one from the queue, and its topic from the month unless the
// upload uses that same topic. The full rows go on the upload's ledger, so
// Undo puts them back exactly.
// ---------------------------------------------------------------------------
type SystemDraft = { id: string; title: string; topicId: string | null };
async function systemDraftsInReview(monthId: string): Promise<SystemDraft[]> {
  const rows = await prisma.contentScript.findMany({
    where: {
      monthId, historical: false, source: { in: ["ai", "AI"] }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] },
      approvedVersionId: null, sharedVersionId: null, clientApprovedVersionId: null, clientChangesAt: null, videoId: null,
    },
    select: { id: true, title: true, topicId: true },
  });
  if (!rows.length) return [];
  // Never one a person already acted on: no release row, no client suggestion.
  const [releases, suggestions] = await Promise.all([
    prisma.contentScriptRelease.findMany({ where: { scriptId: { in: rows.map((r) => r.id) } }, select: { scriptId: true } }),
    prisma.scriptSuggestion.findMany({ where: { scriptId: { in: rows.map((r) => r.id) } }, select: { scriptId: true } }),
  ]);
  const touched = new Set([...releases.map((r) => r.scriptId), ...suggestions.map((r) => r.scriptId)]);
  return rows.filter((r) => !touched.has(r.id));
}

async function bankFor(enrollmentId: string, monthId: string): Promise<{ rows: TopicRow[]; ui: BankTopicUi[] }> {
  const [rows, sels, scripts, months] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId }, select: { id: true, title: true, status: true, approvalState: true, clientDeclinedAt: true, pillarId: true, monthId: true }, orderBy: { createdAt: "desc" }, take: 1500 }),
    prisma.contentTopicSelection.findMany({ where: { enrollmentId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true, monthId: true } }),
    prisma.contentScript.findMany({ where: { enrollmentId, historical: false, topicId: { not: null } }, select: { topicId: true, monthId: true } }),
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true, historical: true, status: true } }),
  ]);
  const monthOf = new Map(months.map((m) => [m.id, m]));
  const stepping = new Set((await systemDraftsInReview(monthId)).map((d) => d.topicId).filter(Boolean));
  const ui = rows.map((t): BankTopicUi => {
    let why: string | null = null;
    const otherSel = sels.find((s) => s.topicId === t.id && s.monthId !== monthId && monthOf.get(s.monthId)?.status === "OPEN" && !monthOf.get(s.monthId)?.historical);
    // A topic whose only script is one of this month's system drafts can take the upload: the draft steps aside.
    const script = scripts.find((s) => s.topicId === t.id && !(s.monthId === monthId && stepping.has(t.id)));
    if (RULED_OUT.has(t.status) || (t.approvalState && RULED_OUT.has(t.approvalState))) why = "it was rejected or archived";
    else if (t.clientDeclinedAt) why = "the client marked it “Not interested”";
    else if (PRODUCTION_DONE.has(t.status)) why = "it has already been filmed";
    else if (script) why = script.monthId === monthId ? "it already has a script this month" : `it already has a script${script.monthId && monthOf.get(script.monthId) ? ` (${monthName(monthOf.get(script.monthId)!.monthKey)})` : ""}`;
    else if (otherSel) why = `it's picked for ${monthName(monthOf.get(otherSel.monthId)!.monthKey)}`;
    return { id: t.id, title: t.title, norm: normalizeTitle(t.title), pillarId: t.pillarId, onMonth: sels.some((s) => s.topicId === t.id && s.monthId === monthId), eligible: !why, why };
  });
  return { rows, ui };
}

async function monthSelections(monthId: string): Promise<MonthSelectionUi[]> {
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, orderBy: { createdAt: "asc" }, select: { topicId: true, status: true } });
  if (!sels.length) return [];
  const ids = sels.map((s) => s.topicId);
  const [topics, scripts, interviews, drafts] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
    prisma.contentScript.findMany({ where: { monthId, historical: false, topicId: { in: ids } }, select: { id: true, topicId: true } }),
    prisma.contentInterview.findMany({ where: { monthId, topicId: { in: ids } }, select: { topicId: true, status: true } }),
    systemDraftsInReview(monthId),
  ]);
  const stepping = new Set(drafts.map((d) => d.id));
  return sels.map((s) => {
    const hasScript = scripts.some((x) => x.topicId === s.topicId && !stepping.has(x.id));
    const answersStarted = interviews.some((i) => i.topicId === s.topicId && i.status !== "NOT_STARTED" && i.status !== "ABANDONED");
    const carried = s.status === "CARRIED";
    return { topicId: s.topicId, title: topics.find((t) => t.id === s.topicId)?.title ?? "(topic)", status: s.status, hasScript, answersStarted, carried, replaceable: !hasScript && !answersStarted && !carried };
  });
}

/** What the month's route does on apply, in words, from the same derivation the gate uses. */
async function routePlan(monthId: string): Promise<{ keep: boolean; text: string; callStatus: string; planningMode: string }> {
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  const r = await recalcProgramMonth(monthId, { dryRun: true });
  const d = r?.after;
  const liveCall = !!d && d.planningMode === "CALL" && (d.strategyCallStatus === "SCHEDULED" || d.strategyCallStatus === "COMPLETED");
  if (liveCall) {
    return { keep: true, callStatus: d!.strategyCallStatus, planningMode: d!.planningMode, text: d!.strategyCallStatus === "COMPLETED" ? "The month's strategy call was held — it stays the plan, and these are its scripts." : "The month's strategy call is booked — it stays on the calendar, and these are its scripts." };
  }
  return { keep: false, callStatus: d?.strategyCallStatus ?? "NOT_SCHEDULED", planningMode: d?.planningMode ?? "UNDECIDED", text: "This marks the month as planned by the office — no strategy call or questions are asked of the client. They review the scripts on their portal." };
}

/** A script's spoken text, normalized, for "already on file" checks. */
const spokenKey = (hook: string, close: string) => normalizeTitle(`${hook} ${close}`).slice(0, 400);

/** Per-script extras the AI reading hands the preview (by position in `items`). */
export type DraftExtra = { notes?: string[]; pillarWhy?: string | null; titleAsWritten?: string | null };

const PLAIN_LEFT_OUT = /isn't in the script|isn't a part we know/;

/**
 * THE PREVIEW. Reads only. `sources` = documents to split; `items` = a list of
 * scripts the staff already shaped (a merge re-reads through here) or the AI
 * filed (`parser: "ai"`).
 */
export async function buildUploadPreview(opts: {
  enrollmentId: string; monthId: string;
  sources?: UploadSource[];
  items?: UploadItemInput[];
  parser?: "house" | "ai"; aiRunId?: string | null;
  extras?: Map<number, DraftExtra>;
  keepSources?: UploadSource[];
}): Promise<UploadPreview> {
  const month = await uploadMonth(opts.enrollmentId, opts.monthId);
  const sources = (opts.sources ?? []).map((s) => ({ name: s.name.slice(0, 160) || "Pasted text", text: s.text.slice(0, MAX_SOURCE_CHARS) }));
  const notes: string[] = [];
  type Raw = ReturnType<typeof readUploadedScript> & { wantTopicId?: string | null; wantPillarId?: string | null; key?: string };
  let raws: Raw[] = [];
  if (opts.items) {
    // What the AI filed is read line by line as written, like a skit — never by the archive reader, which drops lines it can't label.
    raws = opts.items.slice(0, MAX_SCRIPTS + 10).map((it) => ({ ...readUploadedScript(it.text, { title: it.title, sourceName: it.sourceName, asWritten: opts.parser === "ai" }), wantTopicId: it.topicId, wantPillarId: it.pillarId, key: it.key }));
  } else {
    for (const s of sources) {
      const split = splitUploadedScripts(s);
      if (split.preamble) notes.push(`${s.name}: ${plural(split.preamble.split("\n").filter((l) => l.trim()).length, "line")} before the first script (a cover or header) ${split.preamble.split("\n").filter((l) => l.trim()).length === 1 ? "was" : "were"} left out.`);
      if (!split.scripts.length) notes.push(`${s.name}: no scripts found.`);
      raws.push(...split.scripts);
    }
  }
  if (raws.length > MAX_SCRIPTS) {
    notes.push(`Only the first ${MAX_SCRIPTS} scripts are shown — upload the rest separately.`);
    raws = raws.slice(0, MAX_SCRIPTS);
  }

  // The hub's own drafts for this month come out of the review queue on Add.
  const stepAside = await systemDraftsInReview(month.id);
  if (stepAside.length) notes.push(`${plural(stepAside.length, "script")} the hub drafted for ${monthName(month.monthKey)} (${stepAside.map((d) => `“${d.title}”`).join(", ")}) ${stepAside.length === 1 ? "comes" : "come"} out of the review queue when you add these, along with ${stepAside.length === 1 ? "its topic" : "their topics"} unless one of your scripts uses the same topic. Undo puts them back.`);

  // The document's own month, when it names one that is not this month.
  const { monthFromText } = await import("@/lib/contentImport");
  for (const s of sources) {
    const named = monthFromText(s.name) ?? monthFromText(s.text.slice(0, 400));
    if (named && named.slice(5) !== month.monthKey.slice(5)) { notes.push(`${s.name} mentions ${monthName(named)} — you're adding these to ${monthName(month.monthKey)}.`); break; }
  }

  const [bank, selections, choices, route, existingScripts] = await Promise.all([
    bankFor(opts.enrollmentId, month.id),
    monthSelections(month.id),
    pillarChoices(opts.enrollmentId),
    routePlan(month.id),
    prisma.contentScript.findMany({ where: { enrollmentId: opts.enrollmentId, historical: false, currentVersionId: { not: null } }, select: { id: true, title: true, monthId: true, currentVersionId: true } }),
  ]);
  const options = choices.options;
  const versions = existingScripts.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: existingScripts.map((s) => s.currentVersionId!) } }, select: { id: true, hook: true, close: true } }) : [];
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId: opts.enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const onFile = new Map<string, string>();
  for (const s of existingScripts) {
    const v = versions.find((x) => x.id === s.currentVersionId);
    if (v) onFile.set(spokenKey(v.hook, v.close), `“${s.title}”${s.monthId && monthKeys.get(s.monthId) ? ` (${monthName(monthKeys.get(s.monthId)!)})` : ""}`);
  }

  // Where each script sits in the documents, for the word-for-word check of a
  // list (the AI's, or one the staff merged): found by its title, else its hook.
  const parser = opts.parser ?? "house";
  const docText = (opts.keepSources ?? sources).map((s) => s.text).join("\n");
  const located = opts.items && docText.trim()
    ? locateScriptBlocks(docText, raws.map((r, i) => ({ title: opts.extras?.get(i)?.titleAsWritten || r.title, hook: r.hook })))
    : [];

  const optionByLabel = (label: string | null) => {
    if (!label) return null;
    const key = normalizeTitle(label.split(/\s+(?:\/|•|\||·)\s+/)[0]);
    return options.find((o) => normalizeTitle(o.name) === key)?.id ?? null;
  };

  const claimed = new Set<string>();
  const drafts: UploadDraft[] = [];
  for (const [i, r] of raws.entries()) {
    const norm = normalizeTitle(r.title);
    let topicId: string | null = null;
    let matchKind: UploadDraft["matchKind"] = null;
    let suggestion: UploadDraft["suggestion"] = null;
    let conflict: string | null = null;
    const exact = norm ? bank.ui.find((t) => t.norm === norm) : undefined;
    const wanted = r.wantTopicId ? bank.ui.find((t) => t.id === r.wantTopicId && t.eligible) : undefined;
    if (wanted && !claimed.has(wanted.id)) { topicId = wanted.id; matchKind = wanted.norm === norm ? "exact" : wanted.onMonth ? "month" : null; }
    else if (exact) {
      if (exact.eligible && !claimed.has(exact.id)) { topicId = exact.id; matchKind = "exact"; }
      else if (!exact.eligible) conflict = `A topic called “${exact.title}” already exists and can't take this script — ${exact.why}. Change this title to add it as a new topic.`;
    }
    if (!topicId && !conflict && norm) {
      let best: { t: BankTopicUi; sim: number } | null = null;
      for (const t of bank.ui) {
        if (!t.eligible || claimed.has(t.id)) continue;
        const sim = titleSimilarity(r.title, t.title);
        if (sim >= 0.7 && (!best || sim > best.sim)) best = { t, sim };
      }
      if (best && best.t.onMonth && best.sim >= 0.75) { topicId = best.t.id; matchKind = "month"; }
      else if (best) suggestion = { topicId: best.t.id, title: best.t.title };
    }
    if (topicId) claimed.add(topicId);
    const matched = topicId ? bank.rows.find((t) => t.id === topicId) : null;
    const extra = opts.extras?.get(i);

    // The pillar: the staff's pick (a merge), the document's own Category
    // line, the AI's pick (with its reason), the bank topic's, else the
    // closest by words.
    let pillarId: string | null = null;
    let pillarWhy: string | null = null;
    const byCategory = r.categoryLabel ? (choices.source === "pillars" ? await resolvePillarByLabel(opts.enrollmentId, r.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0]) : null) ?? optionByLabel(r.categoryLabel) : null;
    const wantedPillar = r.wantPillarId && options.some((o) => o.id === r.wantPillarId) ? r.wantPillarId : null;
    if (wantedPillar && !(extra && byCategory)) { pillarId = wantedPillar; pillarWhy = extra?.pillarWhy ? `Picked by AI: ${extra.pillarWhy}` : null; }
    if (!pillarId && byCategory) { pillarId = byCategory; pillarWhy = `The document says “${r.categoryLabel}”.`; }
    if (!pillarId && matched?.pillarId && options.some((o) => o.id === matched.pillarId)) { pillarId = matched.pillarId; pillarWhy = "The pillar of the topic it uses."; }
    if (!pillarId && !r.wantPillarId && options.length && hasScriptParts(r)) {
      const pick = pickPillarByWords([r.title, r.topic, r.goal, r.hook, ...r.points.map((p) => p.text), r.close].filter(Boolean).join("\n"), options);
      if (pick) { pillarId = pick.id; pillarWhy = pick.why; }
    }

    const rowNotes = [...r.notes, ...(extra?.notes ?? [])];
    if (r.categoryLabel && !pillarId) rowNotes.push(`“${r.categoryLabel}” isn't one of this client's pillars — pick one.`);
    const dup = onFile.get(spokenKey(r.hook, r.close));
    if (dup && (r.hook || r.close)) rowNotes.push(`Looks like ${dup}, already on file.`);
    const pillarName = pillarId ? options.find((p) => p.id === pillarId)?.name ?? null : null;
    const parts: VersionParts = { title: r.title || "(untitled)", categoryLabel: pillarName ?? r.categoryLabel, pillarId: pillarId && !STRATEGY_PILLAR.test(pillarId) ? pillarId : null, hook: r.hook, points: r.points, close: r.close, captionCta: r.caption };

    // Word for word against the document: every skit, and everything the AI filed.
    let asWritten: AsWrittenCheck | null = null;
    const block = r.sourceBlock ?? located[i] ?? null;
    if (r.format === "skit" || parser === "ai") {
      asWritten = block ? checkAsWritten(block, r) : { checked: false, ok: false, missing: [], added: [], missingCount: 0, addedCount: 0 };
    }
    drafts.push({
      key: r.key ?? sha256(`${i}\n${r.sourceName}\n${r.text}`).slice(0, 16),
      sourceName: r.sourceName, title: r.title, titleFound: r.titleFound, text: r.text,
      houseText: renderScript(canonicalFromParts(parts), { audience: "client" }).trim(),
      parts: { hook: r.hook, points: r.points, close: r.close, captionCta: r.caption },
      categoryLabel: r.categoryLabel, words: r.words, seconds: r.seconds, pace: paceOf(r.seconds),
      pillarId, topicId, matchKind, suggestion, conflict,
      shape: hasScriptParts(r) ? shapeProblems(r) : ["Not a script — no Hook, Talking points or Close found."],
      notes: rowNotes, isScript: hasScriptParts(r),
      format: r.format, speakers: r.speakers, directions: r.directions, goal: r.goal, topicLine: r.topic, dimensions: r.dimensions,
      pillarWhy, asWritten,
    });
  }
  const notHouse = drafts.length === 0 || drafts.some((d) => !d.isScript || d.format === "skit" || d.notes.some((n) => PLAIN_LEFT_OUT.test(n)));
  return {
    enrollmentId: opts.enrollmentId, monthId: month.id, monthKey: month.monthKey, monthName: monthName(month.monthKey), clientName: month.clientName,
    fileNames: [...new Set((opts.keepSources ?? sources).map((s) => s.name))],
    parser, aiRunId: opts.aiRunId ?? null,
    drafts, owed: month.videosOwed, carried: selections.filter((s) => s.carried).length,
    selections, bank: bank.ui.slice(0, 800), pillars: options.map((p) => ({ id: p.id, name: p.name, from: p.from })), pillarSource: choices.source,
    route: { keep: route.keep, text: route.text }, notes,
    sources: opts.keepSources ?? sources,
    suggestAi: parser === "house" && (notHouse || drafts.some((d) => d.shape.length > 0)),
    aiRecommended: parser === "house" && !opts.items && sources.length > 0 && notHouse,
  };
}

// ---------------------------------------------------------------------------
// THE AI READING, AS WRITTEN — attended only: it runs because a person
// uploaded a document the house labels don't describe (or clicked "Let AI
// read it"). The model files each script's own lines into the five parts and
// picks its pillar (scriptUploadAi); the preview then reads what it filed with
// the same reader as any upload and checks every word against the document.
// The same document read again reuses the earlier answer (the same prompt,
// word for word) instead of paying for it twice.
// ---------------------------------------------------------------------------
export async function aiSplitUpload(opts: { enrollmentId: string; monthId: string; sources: UploadSource[]; requestedBy: string }): Promise<UploadPreview> {
  const month = await uploadMonth(opts.enrollmentId, opts.monthId);
  const sources = opts.sources.map((s) => ({ name: (s.name || "Pasted text").slice(0, 160), text: String(s.text ?? "").slice(0, MAX_SOURCE_CHARS) }));
  if (!sources.some((s) => s.text.trim())) throw new Error("There's no text to read.");
  const choices = await pillarChoices(opts.enrollmentId);
  const prompt = asWrittenPrompt(sources, choices.options, choices.source);
  const promptHash = sha256(`${AS_WRITTEN_SYSTEM}\n${prompt}`);
  const earlier = await prisma.programAiRun.findFirst({
    where: { kind: "import_split", enrollmentId: opts.enrollmentId, promptKey: AS_WRITTEN_PROMPT_KEY, status: "SUCCEEDED", inputRefsJson: { contains: promptHash } },
    orderBy: { createdAt: "desc" }, select: { id: true, outputJson: true },
  });
  let output: AsWrittenOut | null = null;
  let runId: string;
  try { output = earlier?.outputJson ? (JSON.parse(earlier.outputJson) as AsWrittenOut) : null; } catch { output = null; }
  if (earlier && output?.scripts) runId = earlier.id;
  else {
    const { runAiJson } = await import("@/lib/aiRuns");
    const run = await runAiJson<AsWrittenOut>({
      kind: "import_split", enrollmentId: opts.enrollmentId, clientId: month.clientId,
      scope: { monthId: month.id, purpose: "month_script_upload" }, inputRefs: { files: sources.map((s) => s.name), docHash: sha256(sources.map((s) => s.text).join("\n")), pillarSource: choices.source },
      promptKey: AS_WRITTEN_PROMPT_KEY, requestedBy: opts.requestedBy, unattended: false,
      dedupeKey: `script-upload-read:${month.id}:${promptHash.slice(0, 16)}`,
      system: AS_WRITTEN_SYSTEM, prompt, schema: AS_WRITTEN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 16_000,
    });
    output = run.output;
    runId = run.runId;
  }
  const filed = itemsFromAsWritten(output ?? { scripts: [] }, choices.options, sources.map((s) => s.text).join("\n")).slice(0, MAX_SCRIPTS);
  const sourceName = sources.length === 1 ? sources[0].name : "Your documents";
  const extras = new Map<number, DraftExtra>();
  filed.forEach((f, i) => extras.set(i, {
    pillarWhy: f.pillarWhy, titleAsWritten: f.titleAsWritten,
    notes: f.leftOut ? [`The AI left this out of the script: “${f.leftOut.slice(0, 160)}${f.leftOut.length > 160 ? "…" : ""}”`] : [],
  }));
  const items: UploadItemInput[] = filed.map((f) => ({ text: f.text, title: f.title, topicId: null, pillarId: f.pillarId, sourceName }));
  const preview = await buildUploadPreview({ enrollmentId: opts.enrollmentId, monthId: opts.monthId, items, parser: "ai", aiRunId: runId, extras, keepSources: sources });
  if (!items.length) preview.notes.push("The AI found no scripts in the document either.");
  return preview;
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
export type UploadActor = { email: string; appUserId: string | null; name: string | null };

type PriorSelection = {
  topicId: string; selectionId: string | null; status: string | null; rank: number | null; createdAt: string | null;
  removedAt?: string | null; removedBy?: string | null; removedReason?: string | null;
  topicMonthId: string | null; topicStatus: string; topicPillarId: string | null;
};
const priorOf = (topicId: string, sel: { id: string; status: string; rank: number | null; createdAt: Date; removedAt: Date | null; removedBy: string | null; removedReason: string | null } | null, t: { monthId: string | null; status: string; pillarId: string | null }): PriorSelection => ({
  topicId, selectionId: sel?.id ?? null, status: sel?.status ?? null, rank: sel?.rank ?? null, createdAt: sel?.createdAt.toISOString() ?? null,
  removedAt: sel?.removedAt?.toISOString() ?? null, removedBy: sel?.removedBy ?? null, removedReason: sel?.removedReason ?? null,
  topicMonthId: t.monthId, topicStatus: t.status, topicPillarId: t.pillarId,
});
type UploadLedger = {
  monthId: string; monthKey: string; by: string; byName: string; at: string;
  scriptIds: string[]; createdTopicIds: string[]; matched: PriorSelection[]; replaced: PriorSelection[];
  route: { chosen: boolean; before: { mode: "CALL" | "WRITTEN" | null; chosenAt: string | null; chosenBy: string | null; strategyCallStatus: string } | null; at: string | null };
  parser: "house" | "ai"; aiRunId: string | null; owed: number;
  /** Pillars made from the approved strategy because a script here was filed under one (kept on undo — they are the strategy's). */
  pillarsCreated?: number;
  sent?: { by: string; at: string; versionIds: string[] }[];
  undone?: { by: string; at: string; routeRestored: boolean };
  /** Oct 13 2026: the hub's own drafts this upload took out of the review queue — whole rows, so Undo can put them back. */
  withdrawn?: { script: Record<string, unknown>; versions: Record<string, unknown>[] }[];
};

const firstName = (a: UploadActor) => (a.name?.trim().split(/\s+/)[0]) || a.email.split("@")[0];

function readLedger(json: string | null): UploadLedger | null {
  try { const v = JSON.parse(json ?? "null") as UploadLedger | null; return v && Array.isArray(v.scriptIds) ? v : null; } catch { return null; }
}

export async function applyScriptUpload(input: {
  enrollmentId: string; monthId: string; fileNames: string[]; parser?: "house" | "ai"; aiRunId?: string | null;
  items: UploadItemInput[]; replaceTopicIds?: string[];
}, actor: UploadActor): Promise<{ batchId: string; created: number; newTopics: number; fromBank: number; extras: number; open: number; replaced: number; routeChosen: boolean; monthName: string; message: string }> {
  const month = await uploadMonth(input.enrollmentId, input.monthId);
  const items = (input.items ?? []).filter((it) => it && typeof it.text === "string" && it.text.trim());
  if (!items.length) throw new Error("Nothing to add — every script was dropped.");
  if (items.length > MAX_SCRIPTS) throw new Error(`That's more than ${MAX_SCRIPTS} scripts — upload them in two goes.`);

  // Read every script again from its text: what the browser sent back is the
  // staff's titles and choices, never parts to be trusted as they are.
  const read = items.map((it, i) => {
    const r = readUploadedScript(it.text, { title: it.title, sourceName: it.sourceName, asWritten: input.parser === "ai" });
    if (!hasScriptParts(r)) throw new Error(`Script ${i + 1} has no Hook, Talking points or Close — drop it or fix it.`);
    const title = (it.title ?? "").trim().slice(0, 200) || r.title;
    if (!title) throw new Error(`Script ${i + 1} needs a title.`);
    return { it, r, title };
  });

  // The same scripts on the same month again (a double click, a second tab) —
  // said plainly before anything else is checked.
  const contentHash = sha256(JSON.stringify({ e: input.enrollmentId, m: month.id, items: read.map((x) => [x.title, x.it.text]) }));
  const prior = await prisma.contentImportBatch.findUnique({ where: { kind_contentHash: { kind: UPLOAD_KIND, contentHash } }, select: { id: true, mode: true } });
  if (prior) throw new Error(prior.mode === "APPLIED" ? `These scripts were already added to ${monthName(month.monthKey)} — undo that upload first to add them again.` : "These scripts are being added right now — give it a moment.");

  // Topics: the one each script hangs off. A named bank topic must still be
  // free for a new script; a NEW title must not collide with one that isn't.
  const bank = await bankFor(input.enrollmentId, month.id);
  let pillars = await listPillars(input.enrollmentId, { includeRetired: true });
  // A pillar picked from the client's strategy document (no pillar record yet):
  // from the APPROVED strategy, its pillars are made now — exactly what approving
  // it does (contentStrategy.syncPillarsFromVersion) — and the script is filed
  // under the real one; from a draft, the name is kept as the script's label.
  const docPicks = items.map((it) => STRATEGY_PILLAR.exec(it.pillarId ?? "")).filter((m): m is RegExpExecArray => !!m);
  let pillarsCreated = 0;
  const docNames = new Map<string, string>();
  if (docPicks.length) {
    const choices = await pillarChoices(input.enrollmentId);
    for (const o of choices.options) docNames.set(o.id, o.name);
    const approvedIds = [...new Set(docPicks.filter((m) => m[1] === "strategy").map((m) => m[2]))];
    for (const versionId of approvedIds) {
      const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true, status: true } });
      if (!v || v.enrollmentId !== input.enrollmentId || v.status !== "APPROVED") throw new Error("That strategy isn't approved any more — pick the pillars again.");
      const { syncPillarsFromVersion } = await import("@/lib/contentStrategy");
      pillarsCreated += await syncPillarsFromVersion(versionId, actor.email);
    }
    if (approvedIds.length) pillars = await listPillars(input.enrollmentId, { includeRetired: true });
  }
  const pillarFor = (id: string | null): { pillarId: string | null; label: string | null } => {
    if (!id) return { pillarId: null, label: null };
    if (pillars.some((p) => p.id === id)) return { pillarId: id, label: null };
    const m = STRATEGY_PILLAR.exec(id);
    const name = m ? docNames.get(id) ?? null : null;
    if (!m || !name) return { pillarId: null, label: null };
    if (m[1] === "strategy") {
      const key = normalizeTitle(name);
      const row = pillars.find((p) => normalizeTitle(p.name) === key || p.aliases.some((a) => normalizeTitle(a) === key));
      return { pillarId: row?.id ?? null, label: row ? null : name };
    }
    return { pillarId: null, label: name };
  };
  const used = new Set<string>();
  const resolved = read.map(({ it, r, title }, i) => {
    let topicId: string | null = null;
    if (it.topicId) {
      const t = bank.ui.find((x) => x.id === it.topicId);
      if (!t) throw new Error(`Script ${i + 1}: that topic isn't on this client's file.`);
      if (!t.eligible) throw new Error(`“${title}”: the topic “${t.title}” can't take a new script — ${t.why}.`);
      topicId = t.id;
    } else {
      const same = bank.ui.find((x) => x.norm === normalizeTitle(title));
      if (same && !same.eligible) throw new Error(`“${title}”: a topic with this title already exists and ${same.why} — change the title.`);
      if (same) topicId = same.id;
    }
    if (topicId && used.has(topicId)) throw new Error(`Two scripts point at the same topic (“${title}”) — give one its own topic.`);
    if (topicId) used.add(topicId);
    const { pillarId, label: pillarLabel } = pillarFor(it.pillarId);
    return { it, r, title, topicId, pillarId, pillarLabel };
  });

  const fileLabel = input.fileNames.filter(Boolean).join(", ").slice(0, 300) || "Pasted text";
  let batchId: string;
  try {
    batchId = (await prisma.contentImportBatch.create({
      data: { kind: UPLOAD_KIND, enrollmentId: input.enrollmentId, clientId: month.clientId, fileName: fileLabel, contentHash, proposedMonthKey: month.monthKey, mode: "PREVIEW", uploadedBy: actor.email },
      select: { id: true },
    })).id;
  } catch (e) {
    if (String(e).includes("Unique constraint")) throw new Error("These scripts are being added right now — give it a moment.");
    throw e;
  }

  const staff: Actor = { kind: "STAFF", staffUserId: actor.appUserId ?? actor.email };
  const ledger: UploadLedger = {
    monthId: month.id, monthKey: month.monthKey, by: actor.email, byName: firstName(actor), at: new Date().toISOString(),
    scriptIds: [], createdTopicIds: [], matched: [], replaced: [], route: { chosen: false, before: null, at: null },
    parser: input.parser ?? "house", aiRunId: input.aiRunId ?? null, owed: month.videosOwed,
    ...(pillarsCreated ? { pillarsCreated } : {}),
  };
  const saveLedger = () => prisma.contentImportBatch.update({ where: { id: batchId }, data: { previewJson: JSON.stringify(ledger) } });

  try {
    // 1 · the month's earlier picks the staff chose to replace go back to the bank — recorded, restorable.
    const selections = await monthSelections(month.id);
    const replaceIds = new Set((input.replaceTopicIds ?? []).filter((id) => !used.has(id)));
    for (const s of selections) {
      if (!replaceIds.has(s.topicId)) continue;
      if (!s.replaceable) throw new Error(`“${s.title}” can't be moved off the month (${s.carried ? "a carried-over script" : s.hasScript ? "it has a script" : "the client has started its answers"}).`);
      const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: s.topicId, monthId: month.id } } });
      const t = await prisma.contentTopic.findUnique({ where: { id: s.topicId }, select: { monthId: true, status: true, pillarId: true, enrollmentId: true } });
      if (!sel || !t) continue;
      ledger.replaced.push(priorOf(s.topicId, sel, t));
      await prisma.contentTopicSelection.update({ where: { id: sel.id }, data: { status: "REMOVED", removedAt: new Date(), removedBy: actor.email, removedReason: `UPLOAD_REPLACED:${batchId}` } });
      if (t.monthId === month.id && t.status === "SELECTED") await prisma.contentTopic.update({ where: { id: s.topicId }, data: { monthId: null, status: "SAVED" } });
      await recordTopicEvent(s.topicId, t.enrollmentId, "DESELECTED", staff, { monthId: month.id, fromStatus: t.status, toStatus: t.monthId === month.id && t.status === "SELECTED" ? "SAVED" : t.status, note: `Replaced by the scripts ${firstName(actor)} uploaded` });
    }
    await saveLedger();

    // 1b · the hub's own drafts for this month step aside (see systemDraftsInReview).
    await stepAsideSystemDrafts({ monthId: month.id, keepTopicIds: used, batchId, actor, ledger, save: saveLedger });

    // 2 · each script: its topic on the month (document order first), then the script itself.
    const approvedPillars = pillars.map((p) => ({ id: p.id, name: p.name, status: p.status, aliases: p.aliases }));
    const { clientScriptFormat } = await import("@/lib/bulkPlan");
    const clientFormat = await clientScriptFormat(input.enrollmentId);
    // The upload's order is the month's order: its picks rank AHEAD of whatever
    // stays on the month (planningState.allowanceOrder sorts by rank first).
    // Production writes no rank on a selection, so this is plain 1…N there.
    const others = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: { in: ALLOWANCE_SELECTION_STATUSES }, topicId: { notIn: [...used] }, rank: { not: null } }, select: { rank: true } });
    const minOther = others.length ? Math.min(...others.map((o) => o.rank as number)) : null;
    const rankBase = minOther == null ? 0 : Math.min(0, minOther - 1 - resolved.length);
    for (const [i, x] of resolved.entries()) {
      let topicId = x.topicId;
      if (topicId) {
        const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId: month.id } } });
        const t = await prisma.contentTopic.findUniqueOrThrow({ where: { id: topicId }, select: { monthId: true, status: true, pillarId: true } });
        ledger.matched.push(priorOf(topicId, sel, t));
        // A call's PROPOSED pick (or a removed one) becomes a real pick: the office has planned it.
        if (!sel || (sel.status !== "SELECTED" && sel.status !== "RECONCILED")) await selectTopicForMonth(topicId, month.id, { source: "staff", actor: staff, status: "SELECTED" });
        if (x.pillarId && !t.pillarId) await prisma.contentTopic.update({ where: { id: topicId }, data: { pillarId: x.pillarId } });
      } else {
        const created = await createTopic({
          enrollmentId: input.enrollmentId, title: x.title, pillarId: x.pillarId, pillarLabel: x.pillarLabel, concept: x.r.topic ?? x.r.goal, source: "staff", status: "SELECTED", monthId: month.id,
          approvalState: "APPROVED", approvedBy: actor.email, actor: staff, sourceRef: `upload:${batchId}`,
          note: `From the scripts ${firstName(actor)} uploaded (${fileLabel})`,
        });
        topicId = created.id;
        if (!created.existed) ledger.createdTopicIds.push(topicId);
        else {
          const t = await prisma.contentTopic.findUniqueOrThrow({ where: { id: topicId }, select: { monthId: true, status: true, pillarId: true } });
          ledger.matched.push(priorOf(topicId, await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId: month.id } } }), t));
        }
        await selectTopicForMonth(topicId, month.id, { source: "staff", actor: staff, status: "SELECTED" });
      }
      await prisma.contentTopicSelection.update({ where: { topicId_monthId: { topicId, monthId: month.id } }, data: { rank: rankBase + i + 1 } });
      await saveLedger();

      const item = await prisma.contentImportItem.create({
        data: {
          batchId, ordinal: i + 1, kind: "SCRIPT", sourceHash: sha256(`${i}\n${x.it.text}`), sourceText: x.it.text.slice(0, 50_000),
          parsedJson: JSON.stringify({ title: x.title, topicId, pillarId: x.pillarId, pillarLabel: x.pillarLabel, format: x.r.format, speakers: x.r.speakers, points: x.r.points.length, words: x.r.words, seconds: x.r.seconds, category: x.r.categoryLabel }),
          proposedMode: "CREATE", decidedMode: "CREATE", decidedBy: actor.email, decidedAt: new Date(), targetKind: "ContentScript",
          proposedMonthKey: month.monthKey, pillarLabel: x.r.categoryLabel,
        },
        select: { id: true },
      });
      // A script read as written (a skit, or what the AI filed) keeps every line
      // as the reader holds it — speakers, [directions], scene headings — and
      // its Purpose, speakers and dimension line ride along as internal notes.
      // A house-format script is read by the archive reader, as it always was.
      const asWritten = input.parser === "ai" || x.r.format === "skit";
      const base: VersionParts = asWritten
        ? { title: x.title, categoryLabel: x.r.categoryLabel, hook: x.r.hook, points: x.r.points, close: x.r.close, captionCta: x.r.caption, goal: x.r.goal, speakerLabels: x.r.speakers.length ? x.r.speakers : undefined, dimensionsCheck: dimensionsRecord(x.r.dimensions) }
        : partsFromBody(x.title, x.r.text);
      const pillarName = x.pillarId ? pillars.find((p) => p.id === x.pillarId)?.name ?? null : x.pillarLabel;
      const parts: VersionParts = { ...base, title: x.title, pillarId: x.pillarId, categoryLabel: pillarName ?? base.categoryLabel ?? null };
      const validation = validateNewScript(canonicalFromParts(parts, month.clientId), { approvedPillars, clientFormat });
      const v = await createScriptVersion({
        enrollmentId: input.enrollmentId, monthId: month.id, topicId, parts, source: "MANUAL", status: "INTERNAL_REVIEW",
        createdBy: actor.email, importItemId: item.id, sourceFile: fileLabel.slice(0, 200),
        changeSummary: `Written by ${firstName(actor)} — uploaded${fileLabel !== "Pasted text" ? ` from ${fileLabel.slice(0, 120)}` : " (pasted)"}`,
        validation: { ok: validation.ok, findings: validation.findings }, gaps: validation.gaps,
      });
      ledger.scriptIds.push(v.scriptId);
      await prisma.contentImportItem.update({ where: { id: item.id }, data: { resultId: v.scriptId } });
      await saveLedger();
    }

    // 3 · the route: no call on record → the office planned it (the written
    // route, stamped as ours). A booked or held call keeps the month.
    const route = await routePlan(month.id);
    if (!route.keep) {
      const { choosePlanningMode } = await import("@/lib/programMonths");
      const r = await choosePlanningMode(month.id, "WRITTEN", `${OFFICE_PLANNED_PREFIX}${actor.email}`);
      if (r) {
        ledger.route = {
          chosen: true,
          before: { mode: r.before.mode, chosenAt: r.before.chosenAt?.toISOString() ?? null, chosenBy: r.before.chosenBy, strategyCallStatus: r.before.strategyCallStatus },
          at: r.at.toISOString(),
        };
      }
    }
  } catch (e) {
    // Keep what was written on the ledger so Undo can take it back; say what happened.
    await prisma.contentImportBatch.update({ where: { id: batchId }, data: { mode: "APPLIED", appliedAt: new Date(), appliedBy: actor.email, itemsCreated: ledger.scriptIds.length, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 1000), previewJson: JSON.stringify(ledger) } }).catch(() => {});
    throw new Error(`${e instanceof Error ? e.message : "Something went wrong"}${ledger.scriptIds.length || ledger.createdTopicIds.length || ledger.replaced.length ? " — what was already added is on the upload card; Undo takes it back." : ""}`);
  }

  await prisma.contentImportBatch.update({ where: { id: batchId }, data: { mode: "APPLIED", appliedAt: new Date(), appliedBy: actor.email, itemsCreated: ledger.scriptIds.length, itemsLinked: ledger.matched.length, previewJson: JSON.stringify(ledger) } });

  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true, status: true, rank: true, createdAt: true } });
  const { allowanceOrder } = await import("@/lib/planningState");
  const slots = allowanceOrder(sels, month.videosOwed);
  const scripts = await prisma.contentScript.findMany({ where: { id: { in: ledger.scriptIds } }, select: { topicId: true } });
  const extras = scripts.filter((s) => s.topicId && slots.get(s.topicId) === "EXTRA").length;
  const inCount = [...slots.values()].filter((v) => v === "IN").length;
  const open = Math.max(0, month.videosOwed - inCount);
  const mName = monthName(month.monthKey);
  const message = [
    `Added ${plural(ledger.scriptIds.length, "script")} to ${mName} (${ledger.createdTopicIds.length} new topic${ledger.createdTopicIds.length === 1 ? "" : "s"}, ${ledger.matched.length} from the bank).`,
    pillarsCreated ? `${month.clientName}'s ${plural(pillarsCreated, "content pillar")} from the approved strategy ${pillarsCreated === 1 ? "is" : "are"} now set up.` : "",
    extras ? `${extras === 1 ? "1 is an extra" : `${extras} are extras`} beyond the ${month.videosOwed} owed — kept on the month, waiting ${extras === 1 ? "its" : "their"} turn.` : "",
    open ? `${plural(open, "slot")} still open for ${mName}.` : "",
    ledger.withdrawn?.length ? `${plural(ledger.withdrawn.length, "draft")} the hub wrote for ${mName} came out of the review queue.` : "",
    "They're in the review queue — send them to the client when you're ready.",
  ].filter(Boolean).join(" ");
  return { batchId, created: ledger.scriptIds.length, newTopics: ledger.createdTopicIds.length, fromBank: ledger.matched.length, extras, open, replaced: ledger.replaced.length, routeChosen: ledger.route.chosen, monthName: mName, message };
}

// ---------------------------------------------------------------------------
// THE UPLOAD CARD — what each upload on a month looks like now.
// ---------------------------------------------------------------------------
export type UploadScriptUi = { id: string; title: string; extra: boolean; state: "review" | "approved" | "released" | "client_approved" | "changes" ; versionNo: number | null; sendable: boolean; problem: string | null };
export type UploadBatchUi = {
  id: string; fileName: string; byName: string; atISO: string; parser: "house" | "ai";
  scripts: UploadScriptUi[]; removed: number;
  counts: { review: number; approved: number; released: number; clientApproved: number; changes: number; extras: number };
  canSend: number; canUndo: boolean; undoWhy: string | null; routeChosen: boolean; lastError: string | null;
};

const SENT_STATES = new Set(["released", "client_approved", "changes"]);

export async function monthUploads(enrollmentId: string, monthId: string): Promise<{ batches: UploadBatchUi[]; monthHasScripts: boolean }> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { monthKey: true, videosOwed: true, enrollmentId: true } });
  if (!month || month.enrollmentId !== enrollmentId) return { batches: [], monthHasScripts: false };
  const [rows, monthScripts] = await Promise.all([
    prisma.contentImportBatch.findMany({ where: { kind: UPLOAD_KIND, enrollmentId, proposedMonthKey: month.monthKey, mode: "APPLIED" }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.contentScript.count({ where: { monthId, historical: false } }),
  ]);
  if (!rows.length) return { batches: [], monthHasScripts: monthScripts > 0 };
  const [sels, { allowanceOrder }, { scriptDecisionsFor }] = await Promise.all([
    prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true, status: true, rank: true, createdAt: true } }),
    import("@/lib/planningState"), import("@/lib/scriptDecisions"),
  ]);
  const slots = allowanceOrder(sels, month.videosOwed);
  const batches: UploadBatchUi[] = [];
  for (const b of rows) {
    const led = readLedger(b.previewJson);
    if (!led) continue;
    const scripts = await prisma.contentScript.findMany({ where: { id: { in: led.scriptIds } }, select: { id: true, title: true, topicId: true, currentVersionId: true, approvedVersionId: true, sharedVersionId: true, releaseState: true } });
    const versions = scripts.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId).filter((x): x is string => !!x) } }, select: { id: true, versionNo: true, status: true, validationJson: true } }) : [];
    const verdicts = scripts.length ? await scriptDecisionsFor(enrollmentId, scripts.map((s) => s.id)).catch(() => new Map()) : new Map();
    const ui: UploadScriptUi[] = led.scriptIds.map((id) => scripts.find((s) => s.id === id)).filter((s): s is (typeof scripts)[number] => !!s).map((s) => {
      const v = versions.find((x) => x.id === s.currentVersionId);
      const verdict = verdicts.get(s.id)?.decision ?? null;
      const released = !!s.sharedVersionId && s.releaseState === "released";
      const state: UploadScriptUi["state"] = verdict === "APPROVED" ? "client_approved" : verdict === "CHANGES_REQUESTED" ? "changes" : released ? "released" : s.approvedVersionId ? "approved" : "review";
      let problem: string | null = null;
      try {
        const val = v?.validationJson ? (JSON.parse(v.validationJson) as { findings: { severity: string; code: string; message: string }[] }) : null;
        const shape = val?.findings.filter((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code)) ?? [];
        if (shape.length) problem = shape.map((f) => f.message).join(" ");
      } catch { /* none */ }
      const extra = !!s.topicId && slots.get(s.topicId) === "EXTRA";
      const sendable = !extra && !problem && !!s.currentVersionId && s.sharedVersionId !== s.currentVersionId;
      return { id: s.id, title: s.title, extra, state, versionNo: v?.versionNo ?? null, sendable, problem };
    });
    const anySent = ui.some((s) => SENT_STATES.has(s.state));
    batches.push({
      id: b.id, fileName: b.fileName ?? "Pasted text", byName: led.byName, atISO: (b.appliedAt ?? b.createdAt).toISOString(), parser: led.parser,
      scripts: ui, removed: led.scriptIds.length - ui.length,
      counts: {
        review: ui.filter((s) => s.state === "review").length, approved: ui.filter((s) => s.state === "approved").length, released: ui.filter((s) => s.state === "released").length,
        clientApproved: ui.filter((s) => s.state === "client_approved").length, changes: ui.filter((s) => s.state === "changes").length, extras: ui.filter((s) => s.extra).length,
      },
      canSend: ui.filter((s) => s.sendable).length,
      canUndo: !anySent, undoWhy: anySent ? "Some of these scripts are already on the client's portal." : null,
      routeChosen: led.route.chosen, lastError: b.lastError,
    });
  }
  return { batches, monthHasScripts: monthScripts > 0 };
}

/** The client and month an upload belongs to (the duty-owner check reads it before a send). */
export async function uploadScope(batchId: string): Promise<{ enrollmentId: string; monthId: string }> {
  const b = await prisma.contentImportBatch.findUnique({ where: { id: batchId }, select: { kind: true, enrollmentId: true, previewJson: true } });
  const led = b ? readLedger(b.previewJson) : null;
  if (!b || b.kind !== UPLOAD_KIND || !b.enrollmentId || !led) throw new Error("That upload isn't on file any more.");
  return { enrollmentId: b.enrollmentId, monthId: led.monthId };
}

// ---------------------------------------------------------------------------
// SEND — "Send to the client for review": approve + release, the one share.
// ---------------------------------------------------------------------------
export async function sendScriptUpload(batchId: string, actor: UploadActor): Promise<{ sent: number; skipped: { title: string; why: string }[]; emailNote: string | null; message: string; monthId: string; enrollmentId: string }> {
  const b = await prisma.contentImportBatch.findUnique({ where: { id: batchId } });
  const led = b ? readLedger(b.previewJson) : null;
  if (!b || b.kind !== UPLOAD_KIND || b.mode !== "APPLIED" || !led || !b.enrollmentId) throw new Error("That upload isn't on file any more.");
  const view = (await monthUploads(b.enrollmentId, led.monthId)).batches.find((x) => x.id === batchId);
  if (!view) throw new Error("That upload isn't on file any more.");
  const skipped: { title: string; why: string }[] = [];
  const sendIds: string[] = [];
  for (const s of view.scripts) {
    // A script whose current words are already on the portal has nothing to
    // send; a reworked one (a newer version after a change request) does.
    if (s.sendable) { sendIds.push(s.id); continue; }
    if (SENT_STATES.has(s.state) && !s.problem) continue;
    if (s.extra) skipped.push({ title: s.title, why: "an extra beyond what the month owes — release it on its own when it gets a slot" });
    else if (s.problem) skipped.push({ title: s.title, why: `fix the format first: ${s.problem}` });
  }
  if (!sendIds.length) {
    return { sent: 0, skipped, emailNote: null, monthId: led.monthId, enrollmentId: b.enrollmentId, message: skipped.length ? `Nothing sent. ${skipped.map((s) => `“${s.title}”: ${s.why}.`).join(" ")}` : "Everything from this upload is already with the client." };
  }
  const scripts = await prisma.contentScript.findMany({ where: { id: { in: sendIds } }, select: { id: true, title: true, currentVersionId: true } });
  const { shareApprovedScripts } = await import("@/lib/scriptShare");
  const r = await shareApprovedScripts(scripts.map((s) => s.currentVersionId!).filter(Boolean), { email: actor.email, appUserId: actor.appUserId }, { note: `Sent for review with the scripts ${firstName(actor)} uploaded` });
  for (const err of r.errors) {
    const s = scripts.find((x) => x.currentVersionId === err.versionId);
    skipped.push({ title: s?.title ?? "a script", why: err.error.replace(/^Format check:\s*/, "").replace(/\s*—\s*fix the script, or approve it anyway with a note saying why\.$/, " — approve it on its own with a note, or fix it") });
  }
  led.sent = [...(led.sent ?? []), { by: actor.email, at: new Date().toISOString(), versionIds: r.results.map((x) => x.versionId) }];
  await prisma.contentImportBatch.update({ where: { id: batchId }, data: { previewJson: JSON.stringify(led) } });
  const sent = r.results.length;
  const emailed = r.results.some((x) => x.email === "queued");
  const emailNote = emailed ? "The scripts-ready email is queued." : "No email went out — they'll see them on their portal.";
  const message = [
    sent ? `Sent ${plural(sent, "script")} to the client's portal for review.` : "Nothing sent.",
    sent ? emailNote : "",
    skipped.length ? `Not sent: ${skipped.map((s) => `“${s.title}” (${s.why})`).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  return { sent, skipped, emailNote: sent ? emailNote : null, message, monthId: led.monthId, enrollmentId: b.enrollmentId };
}

async function stepAsideSystemDrafts(o: { monthId: string; keepTopicIds: Set<string>; batchId: string; actor: UploadActor; ledger: UploadLedger; save: () => Promise<unknown> }): Promise<number> {
  const drafts = await systemDraftsInReview(o.monthId);
  if (!drafts.length) return 0;
  const staff: Actor = { kind: "STAFF", staffUserId: o.actor.appUserId ?? o.actor.email };
  o.ledger.withdrawn = o.ledger.withdrawn ?? [];
  for (const d of drafts) {
    const script = await prisma.contentScript.findUnique({ where: { id: d.id } });
    if (!script) continue;
    const versions = await prisma.contentScriptVersion.findMany({ where: { scriptId: d.id }, orderBy: { versionNo: "asc" } });
    // Its topic leaves the month too, unless an uploaded script took that topic.
    if (d.topicId && !o.keepTopicIds.has(d.topicId)) {
      const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: d.topicId, monthId: o.monthId } } });
      const t = await prisma.contentTopic.findUnique({ where: { id: d.topicId }, select: { monthId: true, status: true, pillarId: true, enrollmentId: true } });
      if (sel && t && ALLOWANCE_SELECTION_STATUSES.includes(sel.status) && sel.status !== "CARRIED") {
        o.ledger.replaced.push(priorOf(d.topicId, sel, t));
        await prisma.contentTopicSelection.update({ where: { id: sel.id }, data: { status: "REMOVED", rank: null, removedAt: new Date(), removedBy: o.actor.email, removedReason: `UPLOAD_REPLACED:${o.batchId}` } });
        if (t.monthId === o.monthId && t.status === "SELECTED") await prisma.contentTopic.update({ where: { id: d.topicId }, data: { monthId: null, status: "SAVED" } });
        await recordTopicEvent(d.topicId, t.enrollmentId, "DESELECTED", staff, { monthId: o.monthId, fromStatus: t.status, toStatus: t.monthId === o.monthId && t.status === "SELECTED" ? "SAVED" : t.status, note: `The hub's draft stepped aside for the scripts ${firstName(o.actor)} uploaded` });
      }
    }
    o.ledger.withdrawn.push({ script: script as unknown as Record<string, unknown>, versions: versions as unknown as Record<string, unknown>[] });
    await o.save();
    await prisma.contentScriptVersion.deleteMany({ where: { scriptId: d.id } });
    await prisma.contentScript.deleteMany({ where: { id: d.id } });
  }
  await o.save();
  return drafts.length;
}

/**
 * For an upload made before Oct 13 2026 (Joe Sutow's October): take the hub's
 * drafts for its month out of the review queue now, on that upload's ledger,
 * exactly as a new upload does. Its scripts' topics stay; Undo still restores.
 */
export async function stepAsideForUpload(batchId: string, actor: UploadActor): Promise<{ removed: number; monthId: string; enrollmentId: string }> {
  const b = await prisma.contentImportBatch.findUnique({ where: { id: batchId } });
  const led = b ? readLedger(b.previewJson) : null;
  if (!b || b.kind !== UPLOAD_KIND || !led || !b.enrollmentId || b.mode !== "APPLIED") throw new Error("That upload isn't an applied upload on file.");
  const keep = new Set((await prisma.contentScript.findMany({ where: { id: { in: led.scriptIds } }, select: { topicId: true } })).map((s) => s.topicId).filter((t): t is string => !!t));
  const removed = await stepAsideSystemDrafts({ monthId: led.monthId, keepTopicIds: keep, batchId, actor, ledger: led, save: () => prisma.contentImportBatch.update({ where: { id: batchId }, data: { previewJson: JSON.stringify(led) } }) });
  return { removed, monthId: led.monthId, enrollmentId: b.enrollmentId };
}

// ---------------------------------------------------------------------------
// UNDO — only while nothing from the upload has reached the client.
// ---------------------------------------------------------------------------
async function restoreSelection(p: PriorSelection, monthId: string, enrollmentId: string, batchId: string, actor: UploadActor, why: string): Promise<void> {
  const staff: Actor = { kind: "STAFF", staffUserId: actor.appUserId ?? actor.email };
  const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: p.topicId, monthId } } });
  if (p.status && sel) {
    await prisma.contentTopicSelection.update({
      where: { id: sel.id },
      data: { status: p.status, rank: p.rank, removedAt: p.removedAt ? new Date(p.removedAt) : null, removedBy: p.removedBy ?? null, removedReason: p.removedReason ?? null, ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}) },
    });
  } else if (sel && ALLOWANCE_SELECTION_STATUSES.includes(sel.status)) {
    await prisma.contentTopicSelection.update({ where: { id: sel.id }, data: { status: "REMOVED", rank: null, removedAt: new Date(), removedBy: actor.email, removedReason: `UPLOAD_UNDONE:${batchId}` } });
  }
  const t = await prisma.contentTopic.findUnique({ where: { id: p.topicId }, select: { id: true } });
  if (t) {
    await prisma.contentTopic.update({ where: { id: p.topicId }, data: { monthId: p.topicMonthId, status: p.topicStatus, pillarId: p.topicPillarId } });
    await recordTopicEvent(p.topicId, enrollmentId, p.status ? "SELECTED" : "DESELECTED", staff, { monthId, toStatus: p.topicStatus, note: why });
  }
}

export async function undoScriptUpload(batchId: string, actor: UploadActor): Promise<{ message: string; monthId: string; enrollmentId: string }> {
  const b = await prisma.contentImportBatch.findUnique({ where: { id: batchId } });
  const led = b ? readLedger(b.previewJson) : null;
  if (!b || b.kind !== UPLOAD_KIND || !led || !b.enrollmentId) throw new Error("That upload isn't on file any more.");
  if (b.mode !== "APPLIED") throw new Error("That upload was already undone.");
  const enrollmentId = b.enrollmentId;
  const scripts = await prisma.contentScript.findMany({ where: { id: { in: led.scriptIds } }, select: { id: true, title: true, sharedVersionId: true, releaseState: true, clientApprovedVersionId: true, clientChangesAt: true, videoId: true, topicId: true } });
  const shares = scripts.length ? await prisma.contentScriptRelease.count({ where: { scriptId: { in: scripts.map((s) => s.id) }, action: { in: ["SHARE", "APPROVE_AND_SHARE", "CLIENT_APPROVED", "CLIENT_CHANGES"] } } }) : 0;
  const reached = scripts.filter((s) => s.sharedVersionId || s.releaseState === "released" || s.clientApprovedVersionId || s.clientChangesAt || s.videoId);
  if (reached.length || shares) throw new Error(`Too late to undo — ${reached.length ? `“${reached[0].title}”${reached.length > 1 ? ` and ${reached.length - 1} more` : ""} ${reached.length > 1 ? "are" : "is"}` : "some of these scripts are"} already with the client. Take a script back with “Back to the queue” on its own instead.`);

  const ids = scripts.map((s) => s.id);
  // 1 · the scripts this upload wrote (every version, and any edits made to them since).
  if (ids.length) {
    await prisma.scriptSuggestion.deleteMany({ where: { scriptId: { in: ids } } });
    await prisma.contentScriptVersion.deleteMany({ where: { scriptId: { in: ids } } });
    await prisma.contentScript.deleteMany({ where: { id: { in: ids } } });
  }
  // 2 · topics it created: gone, when nothing else hangs off them; otherwise just off the month.
  let topicsRemoved = 0;
  for (const topicId of led.createdTopicIds) {
    const [otherSel, otherScript, interviews, videos] = await Promise.all([
      prisma.contentTopicSelection.count({ where: { topicId, monthId: { not: led.monthId } } }),
      prisma.contentScript.count({ where: { topicId } }),
      prisma.contentInterview.count({ where: { topicId } }),
      prisma.contentVideo.count({ where: { topicId } }),
    ]);
    if (!otherSel && !otherScript && !interviews && !videos) {
      await prisma.contentTopicEvent.deleteMany({ where: { topicId } });
      await prisma.contentTopicSelection.deleteMany({ where: { topicId } });
      await prisma.contentTopic.deleteMany({ where: { id: topicId } });
      topicsRemoved++;
    } else {
      await restoreSelection({ topicId, selectionId: null, status: null, rank: null, createdAt: null, topicMonthId: null, topicStatus: "SAVED", topicPillarId: null }, led.monthId, enrollmentId, batchId, actor, "Upload undone");
    }
  }
  // 3 · bank topics it used, and the picks it replaced: exactly as they were.
  for (const p of [...led.matched].reverse()) await restoreSelection(p, led.monthId, enrollmentId, batchId, actor, "Upload undone — put back as it was");
  for (const p of led.replaced) await restoreSelection(p, led.monthId, enrollmentId, batchId, actor, "Upload undone — back on the month");
  // 3b · the hub's own drafts it took out of the queue: back, exactly as they were.
  for (const w of led.withdrawn ?? []) {
    const id = String(w.script.id);
    if (await prisma.contentScript.findUnique({ where: { id }, select: { id: true } })) continue;
    await prisma.contentScript.create({ data: w.script as never });
    if (w.versions.length) await prisma.contentScriptVersion.createMany({ data: w.versions as never });
  }
  // 4 · the route it chose, compare-and-set on the stamp it wrote.
  let routeRestored = false;
  if (led.route.chosen && led.route.before && led.route.at) {
    const { restorePlanningMode } = await import("@/lib/programMonths");
    const before = led.route.before;
    const r = await restorePlanningMode(led.monthId, { mode: before.mode, chosenAt: before.chosenAt ? new Date(before.chosenAt) : null, chosenBy: before.chosenBy, strategyCallStatus: before.strategyCallStatus }, new Date(led.route.at)).catch(() => ({ restored: false }));
    routeRestored = r.restored;
  }
  if (!routeRestored) {
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    await recalcProgramMonth(led.monthId).catch(() => null);
  }
  led.undone = { by: actor.email, at: new Date().toISOString(), routeRestored };
  // Free the content key so the same document can be uploaded again; the batch and its items stay as the record.
  await prisma.contentImportBatch.update({ where: { id: batchId }, data: { mode: "UNDONE", contentHash: `${b.contentHash}:undone:${Date.now()}`, previewJson: JSON.stringify(led) } });
  const mName = monthName(led.monthKey);
  return {
    monthId: led.monthId, enrollmentId,
    message: `Undone — ${plural(ids.length, "script")} removed from ${mName}${topicsRemoved ? `, ${plural(topicsRemoved, "new topic")} removed` : ""}${led.replaced.length ? `, ${plural(led.replaced.length, "earlier pick")} back on the month` : ""}${led.withdrawn?.length ? `, ${plural(led.withdrawn.length, "hub draft")} back in the review queue` : ""}${led.route.chosen ? (routeRestored ? ", and the month's planning is back to how it was" : " (the month's planning was changed since, so it was left as it is)") : ""}.`,
  };
}

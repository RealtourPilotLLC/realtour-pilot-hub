import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { canonicalFromParts, createScriptVersion, partsFromBody, STRUCTURAL_CODES, type VersionParts } from "@/lib/contentScripts";
import { ALLOWANCE_SELECTION_STATUSES, createTopic, recordTopicEvent, selectTopicForMonth, type Actor } from "@/lib/contentTopics";
import { GENERATION_POLICY, normalizeTitle, renderScript, titleSimilarity, validateNewScript } from "@/lib/contentPolicy";
import { hasScriptParts, readUploadedScript, shapeProblems, splitUploadedScripts, type UploadPoint, type UploadSource } from "@/lib/scriptUploadParse";

// ---------------------------------------------------------------------------
// "UPLOAD THIS MONTH'S SCRIPTS" (Jordan, Oct 12 2026) — the writing half.
//
//   preview  reads the documents (scriptUploadParse) and proposes, per script,
//            a title, a topic (a bank topic when the title matches one, else a
//            new one), a pillar, its length and anything that stops approval.
//            WRITES NOTHING.
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
};

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
  pillars: { id: string; name: string }[];
  route: { keep: boolean; text: string };
  notes: string[];
  /** The extracted documents, kept for "Let AI split it". */
  sources: UploadSource[];
  suggestAi: boolean;
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

type TopicRow = { id: string; title: string; status: string; approvalState: string | null; clientDeclinedAt: Date | null; pillarId: string | null; monthId: string | null };

/** Every topic on the enrollment with whether a NEW script for this month may hang off it. */
async function bankFor(enrollmentId: string, monthId: string): Promise<{ rows: TopicRow[]; ui: BankTopicUi[] }> {
  const [rows, sels, scripts, months] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId }, select: { id: true, title: true, status: true, approvalState: true, clientDeclinedAt: true, pillarId: true, monthId: true }, orderBy: { createdAt: "desc" }, take: 1500 }),
    prisma.contentTopicSelection.findMany({ where: { enrollmentId, status: { in: ALLOWANCE_SELECTION_STATUSES } }, select: { topicId: true, monthId: true } }),
    prisma.contentScript.findMany({ where: { enrollmentId, historical: false, topicId: { not: null } }, select: { topicId: true, monthId: true } }),
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true, historical: true, status: true } }),
  ]);
  const monthOf = new Map(months.map((m) => [m.id, m]));
  const ui = rows.map((t): BankTopicUi => {
    let why: string | null = null;
    const otherSel = sels.find((s) => s.topicId === t.id && s.monthId !== monthId && monthOf.get(s.monthId)?.status === "OPEN" && !monthOf.get(s.monthId)?.historical);
    const script = scripts.find((s) => s.topicId === t.id);
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
  const [topics, scripts, interviews] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
    prisma.contentScript.findMany({ where: { monthId, historical: false, topicId: { in: ids } }, select: { topicId: true } }),
    prisma.contentInterview.findMany({ where: { monthId, topicId: { in: ids } }, select: { topicId: true, status: true } }),
  ]);
  return sels.map((s) => {
    const hasScript = scripts.some((x) => x.topicId === s.topicId);
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

/**
 * THE PREVIEW. Reads only. `sources` = documents to split; `items` = a list of
 * scripts the staff already shaped (a merge re-reads through here).
 */
export async function buildUploadPreview(opts: {
  enrollmentId: string; monthId: string;
  sources?: UploadSource[];
  items?: UploadItemInput[];
  parser?: "house" | "ai"; aiRunId?: string | null;
  extraNotes?: Map<number, string[]>;
  keepSources?: UploadSource[];
}): Promise<UploadPreview> {
  const month = await uploadMonth(opts.enrollmentId, opts.monthId);
  const sources = (opts.sources ?? []).map((s) => ({ name: s.name.slice(0, 160) || "Pasted text", text: s.text.slice(0, MAX_SOURCE_CHARS) }));
  const notes: string[] = [];
  type Raw = ReturnType<typeof readUploadedScript> & { wantTopicId?: string | null; wantPillarId?: string | null; key?: string };
  let raws: Raw[] = [];
  if (opts.items) {
    raws = opts.items.slice(0, MAX_SCRIPTS + 10).map((it) => ({ ...readUploadedScript(it.text, { title: it.title, sourceName: it.sourceName }), wantTopicId: it.topicId, wantPillarId: it.pillarId, key: it.key }));
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

  // The document's own month, when it names one that is not this month.
  const { monthFromText } = await import("@/lib/contentImport");
  for (const s of sources) {
    const named = monthFromText(s.name) ?? monthFromText(s.text.slice(0, 400));
    if (named && named.slice(5) !== month.monthKey.slice(5)) { notes.push(`${s.name} mentions ${monthName(named)} — you're adding these to ${monthName(month.monthKey)}.`); break; }
  }

  const [bank, selections, pillarRows, route, existingScripts] = await Promise.all([
    bankFor(opts.enrollmentId, month.id),
    monthSelections(month.id),
    listPillars(opts.enrollmentId),
    routePlan(month.id),
    prisma.contentScript.findMany({ where: { enrollmentId: opts.enrollmentId, historical: false, currentVersionId: { not: null } }, select: { id: true, title: true, monthId: true, currentVersionId: true } }),
  ]);
  const versions = existingScripts.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: existingScripts.map((s) => s.currentVersionId!) } }, select: { id: true, hook: true, close: true } }) : [];
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId: opts.enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const onFile = new Map<string, string>();
  for (const s of existingScripts) {
    const v = versions.find((x) => x.id === s.currentVersionId);
    if (v) onFile.set(spokenKey(v.hook, v.close), `“${s.title}”${s.monthId && monthKeys.get(s.monthId) ? ` (${monthName(monthKeys.get(s.monthId)!)})` : ""}`);
  }

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
    const pillarId = (r.wantPillarId && pillarRows.some((p) => p.id === r.wantPillarId) ? r.wantPillarId : null)
      ?? (r.categoryLabel ? await resolvePillarByLabel(opts.enrollmentId, r.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0]) : null)
      ?? (matched?.pillarId && pillarRows.some((p) => p.id === matched.pillarId) ? matched.pillarId : null);
    const rowNotes = [...r.notes, ...(opts.extraNotes?.get(i) ?? [])];
    if (r.categoryLabel && !pillarId) rowNotes.push(`“${r.categoryLabel}” isn't one of this client's pillars — pick one.`);
    else if (!pillarId) rowNotes.push(pillarRows.length ? "No pillar — pick one before sending it." : "This client has no pillars yet — approve a strategy with pillars, or approve this script with a note.");
    const dup = onFile.get(spokenKey(r.hook, r.close));
    if (dup && (r.hook || r.close)) rowNotes.push(`Looks like ${dup}, already on file.`);
    const pillarName = pillarId ? pillarRows.find((p) => p.id === pillarId)?.name ?? null : null;
    const parts: VersionParts = { title: r.title || "(untitled)", categoryLabel: pillarName ?? r.categoryLabel, pillarId, hook: r.hook, points: r.points, close: r.close, captionCta: r.caption };
    drafts.push({
      key: r.key ?? sha256(`${i}\n${r.sourceName}\n${r.text}`).slice(0, 16),
      sourceName: r.sourceName, title: r.title, titleFound: r.titleFound, text: r.text,
      houseText: renderScript(canonicalFromParts(parts), { audience: "client" }).trim(),
      parts: { hook: r.hook, points: r.points, close: r.close, captionCta: r.caption },
      categoryLabel: r.categoryLabel, words: r.words, seconds: r.seconds, pace: paceOf(r.seconds),
      pillarId, topicId, matchKind, suggestion, conflict,
      shape: hasScriptParts(r) ? shapeProblems(r) : ["Not a script — no Hook, Talking points or Close found."],
      notes: rowNotes, isScript: hasScriptParts(r),
    });
  }
  const parser = opts.parser ?? "house";
  return {
    enrollmentId: opts.enrollmentId, monthId: month.id, monthKey: month.monthKey, monthName: monthName(month.monthKey), clientName: month.clientName,
    fileNames: [...new Set((opts.keepSources ?? sources).map((s) => s.name))],
    parser, aiRunId: opts.aiRunId ?? null,
    drafts, owed: month.videosOwed, carried: selections.filter((s) => s.carried).length,
    selections, bank: bank.ui.slice(0, 800), pillars: pillarRows.map((p) => ({ id: p.id, name: p.name })),
    route: { keep: route.keep, text: route.text }, notes,
    sources: opts.keepSources ?? sources,
    suggestAi: parser === "house" && (drafts.length === 0 || drafts.some((d) => !d.isScript || d.shape.length > 0 || d.notes.some((n) => /isn't in the script|isn't a part we know/.test(n)))),
  };
}

// ---------------------------------------------------------------------------
// AI ASSIST — attended only. A person clicks "Let AI split it" on a messy
// document; the model returns each script's parts COPIED from the document,
// which are then read by the same deterministic reader as any upload. Every
// word the model hands back is checked against the document.
// ---------------------------------------------------------------------------
type AiSplitOut = { scripts: { title: string; category: string | null; hook: string; talkingPoints: { label: string | null; text: string }[]; close: string; caption: string | null }[] };

const wordsOf = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/'/g, ""));

export async function aiSplitUpload(opts: { enrollmentId: string; monthId: string; sources: UploadSource[]; requestedBy: string }): Promise<UploadPreview> {
  const month = await uploadMonth(opts.enrollmentId, opts.monthId);
  const doc = opts.sources.map((s) => `=== FILE: ${s.name} ===\n${s.text}`).join("\n\n").slice(0, 60_000);
  if (!doc.trim()) throw new Error("There's no text to split.");
  const { runAiJson } = await import("@/lib/aiRuns");
  const run = await runAiJson<AiSplitOut>({
    kind: "import_split", enrollmentId: opts.enrollmentId, clientId: month.clientId,
    scope: { monthId: month.id, purpose: "month_script_upload" }, inputRefs: { files: opts.sources.map((s) => s.name), docHash: sha256(doc) },
    promptKey: "script-upload-split", requestedBy: opts.requestedBy, unattended: false,
    dedupeKey: `script-upload-split:${month.id}:${sha256(doc).slice(0, 16)}`,
    system: `You split a real estate agent's document of short-form video scripts into the individual scripts, and sort each script's lines into the House Video Structure Framework: Hook; Talking Point 1 (Re-hook); Talking Point 2 (Build up); Talking Point 3 (Payoff); Close / Call to action; optional caption.

STRICT RULES:
1. COPY THE WORDS EXACTLY. Never rewrite, shorten, add, reorder, correct or improve a word. Every word you return must appear in the document.
2. One entry per video script, in document order. Skip cover pages, headers, notes to the team and anything that is not a script.
3. The title is the script's own heading as written. If it has none, use its first few words.
4. Keep the talking points as the document has them. If it has four, return four; if it has none labelled, split the body between the hook and the close as written.
5. "label" is the talking point's own label from the document (e.g. "Rehook", "Build up", "Payoff"), or null.
6. category is the pillar/category line if the script has one, else null. caption is a caption line if present, else null.`,
    prompt: doc,
    schema: {
      type: "object",
      properties: {
        scripts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              category: { type: ["string", "null"] },
              hook: { type: "string" },
              talkingPoints: { type: "array", items: { type: "object", properties: { label: { type: ["string", "null"] }, text: { type: "string" } }, required: ["label", "text"] } },
              close: { type: "string" },
              caption: { type: ["string", "null"] },
            },
            required: ["title", "category", "hook", "talkingPoints", "close", "caption"],
          },
        },
      },
      required: ["scripts"],
    },
    maxTokens: 8000,
  });
  const docWords = new Set(wordsOf(doc));
  const items: UploadItemInput[] = [];
  const extraNotes = new Map<number, string[]>();
  for (const [i, s] of (run.output.scripts ?? []).slice(0, MAX_SCRIPTS).entries()) {
    const lines: string[] = [s.title?.trim() || `Script ${i + 1}`];
    if (s.category?.trim()) lines.push(`Category: ${s.category.trim()}`);
    lines.push("HOOK", s.hook ?? "");
    (s.talkingPoints ?? []).forEach((p, j) => {
      const role = p.label ? /re-?\s?hook/i.test(p.label) ? " - RE-HOOK" : /build|set-?\s?up|context/i.test(p.label) ? " - BUILD UP" : /pay-?\s?off/i.test(p.label) ? " - PAYOFF" : "" : "";
      lines.push(`TALKING POINT ${j + 1}${role}`, p.text ?? "");
    });
    lines.push("CLOSE / CTA", s.close ?? "");
    if (s.caption?.trim()) lines.push("CAPTION", s.caption.trim());
    const spoken = wordsOf([s.hook, ...(s.talkingPoints ?? []).map((p) => p.text), s.close].join(" "));
    const missing = spoken.filter((w) => !docWords.has(w)).length;
    if (spoken.length && missing / spoken.length > 0.03) extraNotes.set(i, [`AI: ${plural(missing, "word")} here ${missing === 1 ? "isn't" : "aren't"} in your document — check the wording against it.`]);
    items.push({ text: lines.join("\n"), title: s.title?.trim() || "", topicId: null, pillarId: null, sourceName: opts.sources.length === 1 ? opts.sources[0].name : "Your documents" });
  }
  const preview = await buildUploadPreview({ enrollmentId: opts.enrollmentId, monthId: opts.monthId, items, parser: "ai", aiRunId: run.runId, extraNotes, keepSources: opts.sources });
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
  sent?: { by: string; at: string; versionIds: string[] }[];
  undone?: { by: string; at: string; routeRestored: boolean };
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
    const r = readUploadedScript(it.text, { title: it.title, sourceName: it.sourceName });
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
  const pillars = await listPillars(input.enrollmentId, { includeRetired: true });
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
    const pillarId = it.pillarId && pillars.some((p) => p.id === it.pillarId) ? it.pillarId : null;
    return { it, r, title, topicId, pillarId };
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

    // 2 · each script: its topic on the month (document order first), then the script itself.
    const approvedPillars = pillars.map((p) => ({ id: p.id, name: p.name, status: p.status, aliases: p.aliases }));
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
          enrollmentId: input.enrollmentId, title: x.title, pillarId: x.pillarId, source: "staff", status: "SELECTED", monthId: month.id,
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
          parsedJson: JSON.stringify({ title: x.title, topicId, pillarId: x.pillarId, points: x.r.points.length, words: x.r.words, seconds: x.r.seconds, category: x.r.categoryLabel }),
          proposedMode: "CREATE", decidedMode: "CREATE", decidedBy: actor.email, decidedAt: new Date(), targetKind: "ContentScript",
          proposedMonthKey: month.monthKey, pillarLabel: x.r.categoryLabel,
        },
        select: { id: true },
      });
      const base = partsFromBody(x.title, x.r.text);
      const pillarName = x.pillarId ? pillars.find((p) => p.id === x.pillarId)?.name ?? null : null;
      const parts: VersionParts = { ...base, title: x.title, pillarId: x.pillarId, categoryLabel: pillarName ?? base.categoryLabel ?? null };
      const validation = validateNewScript(canonicalFromParts(parts, month.clientId), { approvedPillars });
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
    extras ? `${extras === 1 ? "1 is an extra" : `${extras} are extras`} beyond the ${month.videosOwed} owed — kept on the month, waiting ${extras === 1 ? "its" : "their"} turn.` : "",
    open ? `${plural(open, "slot")} still open for ${mName}.` : "",
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
    message: `Undone — ${plural(ids.length, "script")} removed from ${mName}${topicsRemoved ? `, ${plural(topicsRemoved, "new topic")} removed` : ""}${led.replaced.length ? `, ${plural(led.replaced.length, "earlier pick")} back on the month` : ""}${led.route.chosen ? (routeRestored ? ", and the month's planning is back to how it was" : " (the month's planning was changed since, so it was left as it is)") : ""}.`,
  };
}

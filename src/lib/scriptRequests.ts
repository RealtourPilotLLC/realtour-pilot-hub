import "server-only";
import { prisma } from "@/lib/prisma";
import type { TalkingPointRole } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// THE CLIENT'S SCRIPT CHANGE REQUESTS, WORKED BY THE OFFICE (Oct 20 2026).
//
// Jordan, on Marcee McMullen's requests: "I'd like to be able to take what
// she wrote and apply it, or take what she wrote and edit it and then apply
// it, and then add a message below to be able to respond. I don't want to hit
// Apply with AI and then lose her response. I also would like to be able to
// see my original version here to compare them ... I want these features for
// anyone asking for a script change."
//
// A request (ScriptSuggestion) is the client's words: a note, a pasted
// rewrite ("HOOK … TALKING POINT 1 … CLOSE / CTA"), or their own edit of the
// script (editedPartsJson). Their words are never deleted: a handled request
// stays on the card with how it was handled and the version it became.
// Replies go to their Messages, marked as about that script, and show under
// the script on their page.
//
// OCT 22 2026 (Jordan's decisions on the approved design, mock-script-requests):
//   · TWO WAYS TO ASK. A client changes one or more PARTS (hook, a talking
//     point, the close; each with an optional note), or sends a MESSAGE (a
//     free note, optionally a pasted rewrite, "about" the whole script, the
//     title, the hook or the close). Both file the same work item; the shape
//     is kept in editedPartsJson (`kind`, `changed`, `notes`, `about`).
//   · THE OFFICE READS IT FIRST. An AI read (scriptRequestAi.readScriptRequest)
//     classifies the feedback and says what they are after, before anything is
//     rewritten. Nothing is rewritten by that read.
//   · NEITHER VERSION WINS AUTOMATICALLY. "Use their change" runs the quality
//     check (length, the five parts, claims nobody made, dashes) and shows it;
//     sending anyway stays one press (decision 4).
//   · PREVIEW FIRST. Every path ends in a preview of the new version and the
//     message; nothing reaches the client until Send (decision 5). Send makes a
//     NEW version (the shared one is never edited, an old one never re-sent),
//     shares it for their OK, posts the message under the script and in their
//     Messages, and keeps their request (and any AI rewrite) on the card.
//   · THE DECISION IS RECORDED for the later learning phase: editedPartsJson
//     .office.decision (classification, action, kept and left out with
//     reasons, the final words, the message, who and when), plus the AI run's
//     disposition. Requests filed before today read exactly as they did.
// ---------------------------------------------------------------------------

export type RequestParts = { hook: string; points: { role: "re-hook" | "build-up" | "payoff" | null; text: string }[]; close: string; captionCta: string | null };
export type EditedWords = { hook: string; points: string[]; close: string; captionCta?: string | null };
export type RequestPart = "hook" | "point1" | "point2" | "point3" | "point4" | "close" | "caption";

const asRole = (r: string | null | undefined): RequestParts["points"][number]["role"] => (r === "re-hook" || r === "build-up" || r === "payoff" ? r : null);
const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
const ID_RE = /^[a-z0-9]{10,40}$/i;

export function editedWordsOf(json: string | null | undefined): EditedWords | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as EditedWords;
    return v && typeof v.hook === "string" && Array.isArray(v.points) && typeof v.close === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Which parts differ between two sets of parts. */
export function changedParts(a: RequestParts, b: RequestParts): RequestPart[] {
  const out: RequestPart[] = [];
  if (norm(a.hook) !== norm(b.hook)) out.push("hook");
  b.points.forEach((p, i) => { if (norm(a.points[i]?.text) !== norm(p.text)) out.push(`point${i + 1}` as RequestPart); });
  if (norm(a.close) !== norm(b.close)) out.push("close");
  if (norm(a.captionCta) !== norm(b.captionCta)) out.push("caption");
  return out;
}

/**
 * Their words laid over the version they read. Null when there is nothing in
 * them shaped like a script part (a plain note): then only "Edit it myself"
 * (starting from the version they read) or "Rewrite with AI" can act on it.
 * `full` = they rewrote the hook, every talking point and the close.
 */
export async function mergeRequestParts(base: RequestParts, input: { body: string; editedPartsJson?: string | null; title?: string | null }): Promise<{ parts: RequestParts; full: boolean; changed: RequestPart[] } | null> {
  const edited = editedWordsOf(input.editedPartsJson);
  if (edited) {
    const parts: RequestParts = {
      hook: edited.hook,
      points: base.points.map((p, i) => ({ role: p.role, text: edited.points[i] ?? p.text })),
      close: edited.close,
      captionCta: edited.captionCta === undefined ? base.captionCta : edited.captionCta ?? null,
    };
    const changed = changedParts(base, parts);
    if (!changed.length) return null;
    // Oct 22: a part change names its parts; an in-place edit (Oct 20) counts as a full rewrite, as before.
    const env = envelopeOf(input.editedPartsJson);
    const full = env.kind === "PARTS" ? changed.includes("hook") && changed.includes("close") && base.points.every((_, i) => changed.includes(`point${i + 1}` as RequestPart)) : true;
    return { parts, full, changed };
  }
  const { readUploadedScript, hasScriptParts } = await import("@/lib/scriptUploadParse");
  const r = readUploadedScript(input.body ?? "", { title: input.title ?? null });
  if (!hasScriptParts(r)) return null;
  const parts: RequestParts = { hook: base.hook, points: base.points.map((p) => ({ ...p })), close: base.close, captionCta: base.captionCta };
  const pts = r.points.filter((p) => p.text.trim());
  if (r.hook.trim()) parts.hook = r.hook.trim();
  if (pts.length === base.points.length) {
    pts.forEach((p, i) => { parts.points[i] = { role: base.points[i].role, text: p.text.trim() }; });
  } else {
    // A note on one or two points: each lands on the point with its role.
    for (const p of pts) {
      const i = p.role ? base.points.findIndex((b) => b.role === p.role) : -1;
      if (i >= 0) parts.points[i] = { role: base.points[i].role, text: p.text.trim() };
    }
  }
  if (r.close.trim()) parts.close = r.close.trim();
  if (r.caption?.trim()) parts.captionCta = r.caption.trim();
  const changed = changedParts(base, parts);
  if (!changed.length) return null;
  return { parts, full: !!r.hook.trim() && pts.length === base.points.length && !!r.close.trim(), changed };
}

type VersionRow = Parameters<typeof import("@/lib/contentScripts").partsFromVersionRow>[0] & { id: string; versionNo: number; scriptId: string; enrollmentId: string; clientId: string };

function requestPartsOf(v: { hook: string; points: { role: TalkingPointRole | null; text: string }[]; close: string; captionCta?: string | null }): RequestParts {
  return { hook: v.hook, points: v.points.map((p) => ({ role: asRole(p.role), text: p.text })), close: v.close, captionCta: v.captionCta ?? null };
}

/** Script text in the house layout, for a client's in-place edit filed as a request. */
export function wordsAsText(base: RequestParts, w: EditedWords): string {
  const label = (i: number) => {
    const role = base.points[i]?.role;
    return `TALKING POINT ${i + 1}${role === "re-hook" ? ": RE-HOOK" : role === "build-up" ? ": BUILD-UP" : role === "payoff" ? ": PAYOFF" : ""}`;
  };
  return [
    "I edited the script:", "",
    "HOOK", w.hook.trim(), "",
    ...w.points.flatMap((t, i) => [label(i), t.trim(), ""]),
    "CLOSE", w.close.trim(),
    ...(w.captionCta?.trim() ? ["", "CAPTION", w.captionCta.trim()] : []),
  ].join("\n");
}

/** The version a request was made on (else the script's current one), and its parts. */
async function readVersionFor(sugg: { scriptId: string; scriptVersionId: string | null }): Promise<{ row: VersionRow; parts: RequestParts } | null> {
  const s = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { currentVersionId: true, sharedVersionId: true } });
  const id = sugg.scriptVersionId ?? s?.sharedVersionId ?? s?.currentVersionId ?? null;
  if (!id) return null;
  const row = await prisma.contentScriptVersion.findUnique({ where: { id } });
  if (!row || row.scriptId !== sugg.scriptId) return null;
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  return { row: row as unknown as VersionRow, parts: requestPartsOf(partsFromVersionRow(row)) };
}

/** Plain words for a shape rule the office's edit broke (the editor keeps the text). */
function plainShape(f: { code: string; path?: string | null }): string {
  const n = /points\[(\d+)\]/.exec(f.path ?? "")?.[1];
  const tp = n != null ? `Talking point ${Number(n) + 1}` : "A talking point";
  switch (f.code) {
    case "hook.missing": return "The hook can't be empty.";
    case "hook.banned-opener": return "The hook starts with a greeting or an introduction. Start with the point itself.";
    case "intro.greeting": return `${tp} has a greeting or an introduction in it.`;
    case "talking-points.empty": return `${tp} is empty.`;
    case "close.missing": return "The close can't be empty.";
    case "title.missing": return "The title can't be empty.";
    default: return "That breaks the script's shape (a hook, three talking points and a close).";
  }
}

// ---------------------------------------------------------------------------
// THE ENVELOPE (Oct 22 2026). editedPartsJson keeps the client's words in the
// Oct 20 shape ({hook, points, close, captionCta}, so every older reader still
// works) and, beside them, how they asked and the office's side. The client's
// words are never rewritten: the office only ever adds `office`.
// ---------------------------------------------------------------------------

export type RequestKind = "PARTS" | "MESSAGE";
export type ClientAbout = "whole" | "title" | "hook" | "close";
export const ABOUT_LABEL: Record<ClientAbout, string> = { whole: "The whole script", title: "Title", hook: "Hook", close: "Close" };

export type FeedbackType =
  | "FACTUAL_CORRECTION" | "PERSONAL_EXPERIENCE" | "WORDING_PREFERENCE" | "MISSING_INFORMATION" | "ADDITIONAL_EXPERTISE"
  | "TOPIC_CHANGE" | "STRUCTURE_SUGGESTION" | "LENGTH_PACING" | "PURPOSE_DISAGREEMENT";
/** Jordan's brief §10 Stage 7, in his words. */
export const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  FACTUAL_CORRECTION: "Factual correction",
  PERSONAL_EXPERIENCE: "Personal experience or chronology",
  WORDING_PREFERENCE: "Wording preference",
  MISSING_INFORMATION: "Missing information",
  ADDITIONAL_EXPERTISE: "Additional expertise",
  TOPIC_CHANGE: "Topic change request",
  STRUCTURE_SUGGESTION: "Creative structure suggestion",
  LENGTH_PACING: "Length or pacing",
  PURPOSE_DISAGREEMENT: "Disagreement about the purpose",
};

/** The AI's read of a request (scriptRequestAi.readScriptRequest), stored on it. */
export type RequestRead = {
  types: FeedbackType[]; intent: string; useful: string[]; recommendation: string; keepTopic: boolean;
  watch: string | null; profileNote: string | null;
  runId: string; atISO: string; by: string;
};
/** An AI rewrite waiting for the office (scriptRequestAi.rewriteScriptRequest). Not sent; only the office sees it. */
export type RequestDraft = {
  runId: string; atISO: string; by: string;
  title: string; words: EditedWords;
  /** Where each part came from, in a few words ("their belief, our framing"). Keys: hook, point1…, close. */
  tags: Record<string, string>;
  kept: string[]; leftOut: { what: string; why: string }[];
  review: { key: string; label: string; pass: boolean; note: string }[];
  message: string;
  steer: string | null; redo: string[];
};
export type DecisionAction = "USE_THEIRS" | "EDIT_THEIRS" | "EDIT_MINE" | "AI_REWRITE" | "AI_REWRITE_EDITED" | "DISMISS";
/** What the office did with a request, for the learning phase to read (brief §10 Stage 8). */
export type RequestDecision = {
  v: 1; action: DecisionAction; requestKind: RequestKind; legacy: boolean;
  classification: { types: FeedbackType[]; intent: string; recommendation: string; runId: string } | null;
  fromVersionId: string | null; fromVersionNo: number | null;
  versionId: string | null; versionNo: number | null;
  final: { title: string; hook: string; points: string[]; close: string; captionCta: string | null } | null;
  changed: string[];
  kept: string[]; leftOut: { what: string; why: string }[];
  check: VersionCheck | null; sentWithFix: boolean;
  aiRunId: string | null; aiDraftEdited: boolean; steer: string | null; redo: string[];
  message: string | null; messageId: string | null;
  by: string; byName: string | null; atISO: string;
};
type OfficeRecord = { read?: RequestRead; draft?: RequestDraft | null; decision?: RequestDecision };
type Envelope = Partial<EditedWords> & {
  kind?: RequestKind; changed?: RequestPart[]; notes?: Partial<Record<RequestPart, string>>; about?: ClientAbout[];
  office?: OfficeRecord;
};

export function envelopeOf(json: string | null | undefined): Envelope {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Envelope) : {};
  } catch {
    return {};
  }
}

/**
 * Adds to the office's side of a request, compare-and-swap on the column so
 * two writers cannot drop each other's half. The client's words are untouched.
 */
export async function updateOfficeRecord(suggestionId: string, fn: (office: OfficeRecord) => OfficeRecord): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId }, select: { editedPartsJson: true } });
    if (!cur) return false;
    const env = envelopeOf(cur.editedPartsJson);
    const next = JSON.stringify({ ...env, office: fn({ ...(env.office ?? {}) }) });
    const w = await prisma.scriptSuggestion.updateMany({ where: { id: suggestionId, editedPartsJson: cur.editedPartsJson }, data: { editedPartsJson: next } });
    if (w.count) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// THE QUALITY CHECK (decision 4). Deterministic and instant, so it runs before
// every preview: the length (Jordan, Oct 22: "aim for 55 to 85 words without
// making it dry or incomplete"; 110 is the hard cap), the five parts, claims
// nobody made (a number, a credential or a client story that is in neither
// their words, our version nor their accepted facts) and dashes. It informs;
// it never blocks a send.
// ---------------------------------------------------------------------------

export const SCRIPT_LENGTH = { aimMin: 55, aimMax: 85, cap: 110 } as const;
export type CheckItem = { key: "length" | "structure" | "claims" | "dashes" | "base"; status: "pass" | "advisory" | "fix"; label: string };
export type VersionCheck = { words: number; items: CheckItem[]; needsFix: boolean };

/** Spoken words of the five parts (the caption is not spoken). */
export function spokenWords(p: { hook: string; points: { text: string }[] | string[]; close: string }): number {
  const pts = (p.points as (string | { text: string })[]).map((x) => (typeof x === "string" ? x : x.text));
  return [p.hook, ...pts, p.close].join(" ").split(/\s+/).filter((t) => /[0-9A-Za-zÀ-ɏ]/.test(t)).length;
}

const CLAIM_PHRASE_RE = /\b(?:my clients?|a client of mine|one of my clients|true story|this really happened|this actually happened|#1|number one|top \d+%?|award[- ]winning|best in|certified|guarantee[ds]?|(?:\d+|twenty|thirty|forty|fifty) years? of experience)\b/gi;
const NUMBER_RE = /[$£€]?\d[\d,.]*\s?(?:%|percent|k\b|million|billion)?/gi;
const digitsOf = (t: string) => t.replace(/[^\d]/g, "");

/** Claim-shaped bits of `text` that appear nowhere in `sources`. */
export function claimsNotInSources(text: string, sources: string[]): string[] {
  const src = sources.join("\n").toLowerCase();
  const srcDigits = new Set((src.match(NUMBER_RE) ?? []).map(digitsOf).filter(Boolean));
  const out = new Set<string>();
  for (const m of text.match(NUMBER_RE) ?? []) {
    const d = digitsOf(m);
    if (d && !srcDigits.has(d)) out.add(m.trim());
  }
  for (const m of text.match(CLAIM_PHRASE_RE) ?? []) {
    if (!src.includes(m.toLowerCase())) out.add(m.trim());
  }
  return [...out].slice(0, 4);
}

export async function checkRequestVersion(
  v: { title: string; words: EditedWords; dashesRemoved?: number },
  ctx: { base: { row: VersionRow; parts: RequestParts }; sources: string[]; enrollmentId: string; clientId: string },
): Promise<VersionCheck> {
  const items: CheckItem[] = [];
  const words = spokenWords(v.words);
  if (words > SCRIPT_LENGTH.cap) items.push({ key: "length", status: "fix", label: `A bit long: needs a fix. ${words} spoken words; the cap is ${SCRIPT_LENGTH.cap} and the aim is ${SCRIPT_LENGTH.aimMin} to ${SCRIPT_LENGTH.aimMax}.` });
  else if (words > SCRIPT_LENGTH.aimMax) items.push({ key: "length", status: "advisory", label: `Longer than the ${SCRIPT_LENGTH.aimMin} to ${SCRIPT_LENGTH.aimMax} aim: ${words} spoken words (under the ${SCRIPT_LENGTH.cap} cap).` });
  else if (words < SCRIPT_LENGTH.aimMin) items.push({ key: "length", status: "advisory", label: `Shorter than the ${SCRIPT_LENGTH.aimMin} to ${SCRIPT_LENGTH.aimMax} aim: ${words} spoken words. Check nothing important is missing.` });
  else items.push({ key: "length", status: "pass", label: `${words} spoken words, inside the ${SCRIPT_LENGTH.aimMin} to ${SCRIPT_LENGTH.aimMax} aim.` });

  const { partsFromVersionRow, canonicalFromParts, approvedPillarsFor, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const kept = partsFromVersionRow(ctx.base.row);
  const parts = { ...kept, title: v.title, hook: v.words.hook, points: kept.points.map((p, i) => ({ role: p.role, text: v.words.points[i] ?? "" })), close: v.words.close, captionCta: v.words.captionCta === undefined ? kept.captionCta : v.words.captionCta };
  const check = validateNewScript(canonicalFromParts(parts, ctx.clientId), { approvedPillars: await approvedPillarsFor(ctx.enrollmentId), clientFormat: await clientScriptFormat(ctx.enrollmentId) });
  const shape = check.findings.filter((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  const roles = kept.points.map((p) => p.role);
  const fivePart = roles.length === 3 && roles[0] === "re-hook" && roles[1] === "build-up" && roles[2] === "payoff";
  if (shape.length) items.push({ key: "structure", status: "fix", label: `Structure: ${plainShape(shape[0])}` });
  else items.push({ key: "structure", status: "pass", label: fivePart ? "Hook, re-hook, build-up, payoff and close are all there." : `Hook, ${roles.length} talking points and the close are all there.` });

  const spoken = [v.words.hook, ...v.words.points, v.words.close, v.words.captionCta ?? ""].join("\n");
  const fresh = claimsNotInSources(spoken, ctx.sources);
  items.push(fresh.length
    ? { key: "claims", status: "fix", label: `Claims nobody made: ${fresh.map((c) => `"${c}"`).join(", ")} ${fresh.length === 1 ? "is" : "are"} in neither their words, our version nor their facts.` }
    : { key: "claims", status: "pass", label: "Every number and claim is in their words, our version or their accepted facts." });

  items.push(v.dashesRemoved
    ? { key: "dashes", status: "advisory", label: `${v.dashesRemoved} dash${v.dashesRemoved === 1 ? "" : "es"} in the wording became commas or periods (scripts never carry em dashes).` }
    : { key: "dashes", status: "pass", label: "No em dashes." });
  return { words, items, needsFix: items.some((i) => i.status === "fix") };
}

/** The client-facing message: plain, no dashes (Oct 12 rule), at most the Messages cap. */
async function cleanMessage(raw: string | null | undefined): Promise<string> {
  const { stripScriptDashes } = await import("@/lib/contentPolicy");
  return stripScriptDashes((raw ?? "").replace(/\r\n?/g, "\n").trim()).slice(0, 3500);
}

/** "Never promise views or reach": a nudge on the preview when the message reads like one. */
export function promisesReach(message: string): boolean {
  return /\b(?:go(?:es|ing)? viral|guarantee[ds]?\b.{0,40}\b(?:views|reach|followers|engagement))|\b(?:more|get you|boost|increase|double|triple)\b.{0,30}\b(?:views|reach|followers|engagement|likes)\b/i.test(message);
}

// ---------------------------------------------------------------------------
// THE NEW VERSION: preview, then send.
// ---------------------------------------------------------------------------

export type SendHow = "HERS" | "EDITED" | "AI" | "AI_EDITED";
export type ApplyOutcome = { ok: boolean; message: string; versionNo?: number };
export type RequestPreview = {
  ok: true; how: SendHow; title: string; titleChanged: boolean; words: EditedWords; points: { role: RequestParts["points"][number]["role"]; text: string }[];
  changed: string[]; check: VersionCheck; nextVersionNo: number; readVersionNo: number;
  message: string; messageWarning: string | null;
};
type Actor = { email: string; appUserId: string | null; name?: string | null };

/** Everything the send, the preview and the AI calls (scriptRequestAi) read about one request. */
export async function loadRequest(suggestionId: string) {
  if (!ID_RE.test(suggestionId)) return null;
  const sugg = await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId } });
  if (!sugg) return null;
  const script = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { id: true, title: true, historical: true, clientId: true, enrollmentId: true, monthId: true, topicId: true, sharedVersionId: true } });
  if (!script) return null;
  const read = await readVersionFor(sugg);
  const client = await prisma.client.findUnique({ where: { id: script.clientId }, select: { name: true } }).catch(() => null);
  const first = (client?.name ?? "").split(" ")[0] || "the client";
  return { sugg, script, read, env: envelopeOf(sugg.editedPartsJson), first };
}
export type Loaded = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

/** The client's own words in a request (never the office's side of the envelope). */
function clientWordsText(json: string | null | undefined): string {
  const env = envelopeOf(json);
  return [env.hook, ...(Array.isArray(env.points) ? env.points : []), env.close, env.captionCta, ...Object.values(env.notes ?? {})].filter((x): x is string => typeof x === "string" && !!x).join("\n");
}

/** What a check counts as "said before": their words, the version they read, their accepted facts. */
async function claimSources(sugg: { body: string; editedPartsJson: string | null }, read: { row: { title: string }; parts: RequestParts }, script: { clientId: string; monthId: string | null }): Promise<string[]> {
  const { factsForPrompt } = await import("@/lib/clientFacts");
  const facts = await factsForPrompt(script.clientId, { monthId: script.monthId, take: 60 }).catch(() => []);
  return [sugg.body, clientWordsText(sugg.editedPartsJson), read.row.title, read.parts.hook, ...read.parts.points.map((p) => p.text), read.parts.close, read.parts.captionCta ?? "", ...facts.map((f) => f.body)];
}
const sourcesFor = (l: Loaded) => claimSources(l.sugg, l.read!, l.script);

/**
 * A newer version was shared after they asked (a second request on the same
 * version, answered first). The new version starts from the one they READ, so
 * whatever that newer version changed would quietly go back: said on the check,
 * never decided for the office.
 */
async function withBaseCheck(l: Loaded, check: VersionCheck): Promise<VersionCheck> {
  const shared = l.script.sharedVersionId;
  if (!shared || !l.read || shared === l.read.row.id) return check;
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: shared }, select: { versionNo: true } });
  if (!v || v.versionNo <= l.read.row.versionNo) return check;
  const item: CheckItem = { key: "base", status: "fix", label: `Version ${v.versionNo} was shared after ${l.first} asked (they asked on version ${l.read.row.versionNo}). This starts from version ${l.read.row.versionNo}, so anything changed in version ${v.versionNo} goes back unless you edit it in.` };
  return { ...check, items: [...check.items, item], needsFix: true };
}

/** The words a path sends: their merged words (HERS), the office's (EDITED / AI_EDITED) or the stored AI draft (AI). */
async function wordsFor(l: Loaded, how: SendHow, input: { words?: EditedWords | null; title?: string | null; draftRunId?: string | null }): Promise<{ ok: true; title: string; words: EditedWords; draft: RequestDraft | null } | { ok: false; message: string }> {
  const r = l.read!;
  const draft = l.env.office?.draft ?? null;
  if (how === "HERS") {
    const m = await mergeRequestParts(r.parts, { body: l.sugg.body, editedPartsJson: l.sugg.editedPartsJson, title: l.script.title });
    if (!m) return { ok: false, message: "Their note isn't laid out as a script (hook, talking points, close), so there's nothing to use as it is. Use Edit it myself, or Rewrite with AI." };
    return { ok: true, title: r.row.title, words: { hook: m.parts.hook, points: m.parts.points.map((p) => p.text), close: m.parts.close, captionCta: m.parts.captionCta }, draft: null };
  }
  if (how === "AI" || how === "AI_EDITED") {
    if (!draft || !input.draftRunId || draft.runId !== input.draftRunId) return { ok: false, message: "That AI draft has changed or was discarded. Reload the page and look at it again." };
  }
  if (how === "AI") return { ok: true, title: draft!.title, words: draft!.words, draft };
  if (!input.words) return { ok: false, message: "Nothing to save." };
  const title = (input.title ?? "").trim() || (how === "AI_EDITED" ? draft!.title : r.row.title);
  return { ok: true, title, words: input.words, draft: how === "AI_EDITED" ? draft : null };
}

/** Clean words, same number of talking points as the version they read. */
async function cleanWords(r: { parts: RequestParts }, title: string, w: EditedWords): Promise<{ ok: true; title: string; words: EditedWords; dashes: number } | { ok: false; message: string }> {
  if (!Array.isArray(w.points) || w.points.length !== r.parts.points.length) return { ok: false, message: "Something changed on the page. Reload it and try again." };
  const { stripScriptDashes, hasScriptDash } = await import("@/lib/contentPolicy");
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, 2000);
  let dashes = 0;
  const strip = (t: string, isTitle = false) => { if (hasScriptDash(t)) dashes += (t.match(/[–—]/g) ?? []).length || 1; return stripScriptDashes(t, { title: isTitle }); };
  const words: EditedWords = {
    hook: strip(clean(w.hook)), points: w.points.map((p) => strip(clean(p))), close: strip(clean(w.close)),
    captionCta: w.captionCta === undefined ? undefined : strip(clean(w.captionCta)) || null,
  };
  const t = strip(clean(title).slice(0, 200), true);
  if (!t) return { ok: false, message: "The title can't be empty." };
  return { ok: true, title: t, words, dashes };
}

function partsAsRequest(base: RequestParts, w: EditedWords): RequestParts {
  return { hook: w.hook, points: base.points.map((p, i) => ({ role: p.role, text: w.points[i] ?? "" })), close: w.close, captionCta: w.captionCta === undefined ? base.captionCta : w.captionCta ?? null };
}

async function nextVersionNo(scriptId: string): Promise<number> {
  const last = await prisma.contentScriptVersion.findFirst({ where: { scriptId }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  return (last?.versionNo ?? 0) + 1;
}

const PART_WORD: Record<string, string> = { title: "title", hook: "hook", point1: "talking point 1", point2: "talking point 2", point3: "talking point 3", point4: "talking point 4", close: "close", caption: "caption" };
export function partList(parts: string[]): string {
  const w = parts.map((p) => PART_WORD[p] ?? p);
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

/**
 * THE PREVIEW (decision 5). The new version and the check, computed and
 * written nowhere: the office reads it, adds the message, and only Send acts.
 */
export async function previewRequestVersion(suggestionId: string, how: SendHow, input: { words?: EditedWords | null; title?: string | null; draftRunId?: string | null; message?: string | null } = {}): Promise<RequestPreview | { ok: false; message: string }> {
  const l = await loadRequest(suggestionId);
  if (!l) return { ok: false, message: "That request is gone." };
  if (l.sugg.status !== "OPEN") return { ok: false, message: "That request was already handled." };
  if (l.script.historical) return { ok: false, message: "This is an imported historical script. It isn't rewritten; draft a new script for the topic instead." };
  if (!l.read) return { ok: false, message: "The version they read isn't on file any more." };
  const got = await wordsFor(l, how, input);
  if (!got.ok) return got;
  const c = await cleanWords(l.read, got.title, got.words);
  if (!c.ok) return c;
  const changed = [...(c.title !== l.read.row.title ? ["title"] : []), ...changedParts(l.read.parts, partsAsRequest(l.read.parts, c.words))];
  if (!changed.length) return { ok: false, message: "That's the same as the version they read. Change something, or Dismiss the request." };
  const check = await withBaseCheck(l, await checkRequestVersion({ title: c.title, words: c.words, dashesRemoved: c.dashes }, { base: l.read, sources: await sourcesFor(l), enrollmentId: l.script.enrollmentId, clientId: l.script.clientId }));
  const theirs = l.env.kind === "PARTS" ? (l.env.changed ?? []) : [];
  const message = input.message != null
    ? await cleanMessage(input.message)
    : how === "AI" ? got.draft?.message ?? ""
      : how === "HERS" ? `Thank you, ${l.first}! I used your ${theirs.length ? `new ${partList(theirs)}` : "version"} as written. Take a look and let me know.`
        : "";
  return {
    ok: true, how, title: c.title, titleChanged: c.title !== l.read.row.title, words: c.words,
    points: l.read.parts.points.map((p, i) => ({ role: p.role, text: c.words.points[i] ?? "" })),
    changed, check, nextVersionNo: await nextVersionNo(l.script.id), readVersionNo: l.read.row.versionNo,
    message, messageWarning: promisesReach(message) ? "This message reads like a promise of views or reach. We never promise those." : null,
  };
}

/** Kept / left out for a path the office wrote by hand: which of their changed parts went in as written, edited, or not at all. */
async function keptOf(l: Loaded, finalParts: RequestParts): Promise<{ kept: string[]; leftOut: { what: string; why: string }[] }> {
  const r = l.read!;
  const m = await mergeRequestParts(r.parts, { body: l.sugg.body, editedPartsJson: l.sugg.editedPartsJson, title: l.script.title });
  if (!m) return { kept: [], leftOut: [] };
  const mine = m.parts;
  const kept: string[] = [], leftOut: { what: string; why: string }[] = [];
  for (const p of m.changed) {
    const pick = (x: RequestParts) => (p === "hook" ? x.hook : p === "close" ? x.close : p === "caption" ? x.captionCta : x.points[Number(p.slice(5)) - 1]?.text) ?? "";
    if (norm(pick(finalParts)) === norm(pick(mine))) kept.push(`Their ${PART_WORD[p]}, as written`);
    else if (norm(pick(finalParts)) === norm(pick(r.parts))) leftOut.push({ what: `Their ${PART_WORD[p]}`, why: "kept our wording" });
    else kept.push(`Their ${PART_WORD[p]}, edited`);
  }
  return { kept, leftOut };
}

/**
 * SEND (decision 5): a NEW version on top of the version they read (the shared
 * one is never edited), approved by the person who pressed it and shared with
 * the client for their OK (never a sign-off on their behalf), the message
 * posted under the script and in their Messages, the request kept as handled
 * with the decision recorded.
 */
export async function sendRequestVersion(suggestionId: string, how: SendHow, input: { words?: EditedWords | null; title?: string | null; draftRunId?: string | null; message?: string | null; startedFrom?: "theirs" | "ours" | "draft" | null }, actor: Actor): Promise<ApplyOutcome & { versionId?: string }> {
  const l = await loadRequest(suggestionId);
  if (!l || l.sugg.status !== "OPEN") return { ok: false, message: "That request was already handled." };
  if (l.script.historical) return { ok: false, message: "This is an imported historical script. It isn't rewritten; draft a new script for the topic instead." };
  if (!l.read) return { ok: false, message: "The version they read isn't on file any more." };
  const got = await wordsFor(l, how, input);
  if (!got.ok) return got;
  const c = await cleanWords(l.read, got.title, got.words);
  if (!c.ok) return c;
  const read = l.read;
  const { partsFromVersionRow, canonicalFromParts, approvedPillarsFor, createScriptVersion, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const kept = partsFromVersionRow(read.row);
  const parts = {
    ...kept, title: c.title,
    hook: c.words.hook, points: kept.points.map((p, i) => ({ role: p.role, text: c.words.points[i] })), close: c.words.close,
    captionCta: c.words.captionCta === undefined ? kept.captionCta : c.words.captionCta || null,
  };
  const finalParts = requestPartsOf(parts);
  const changed = [...(c.title !== read.row.title ? ["title"] : []), ...changedParts(read.parts, finalParts)];
  if (!changed.length) return { ok: false, message: "That's the same as the version they read. Change something, or Dismiss the request." };
  const validation = validateNewScript(canonicalFromParts(parts, l.script.clientId), { approvedPillars: await approvedPillarsFor(l.script.enrollmentId), clientFormat: await clientScriptFormat(l.script.enrollmentId) });
  const shape = validation.findings.find((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  if (shape) return { ok: false, message: plainShape(shape) };
  const check = await withBaseCheck(l, await checkRequestVersion({ title: c.title, words: c.words, dashesRemoved: c.dashes }, { base: read, sources: await sourcesFor(l), enrollmentId: l.script.enrollmentId, clientId: l.script.clientId }));
  const message = await cleanMessage(input.message);

  // One person at a time (a double click must not make two versions).
  const claimed = await prisma.scriptSuggestion.updateMany({ where: { id: l.sugg.id, status: "OPEN" }, data: { status: "APPLYING", resolvedAt: new Date() } });
  if (claimed.count !== 1) return { ok: false, message: "That request is being applied already." };
  const when = l.sugg.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const summary = how === "HERS"
    ? `The client's version from their change request of ${when}, used as written (from v${read.row.versionNo})`
    : how === "EDITED"
      ? `The client's change request of ${when}, edited by ${actor.email} (from v${read.row.versionNo})`
      : `The client's change request of ${when}: AI rewrite${how === "AI_EDITED" ? `, edited by ${actor.email}` : ` chosen by ${actor.email}`} (from v${read.row.versionNo})`;
  const draft = got.draft;
  try {
    // A NEW version, always: on top of the version they read, never over it.
    const v = await createScriptVersion({
      scriptId: l.script.id, enrollmentId: l.script.enrollmentId, monthId: l.script.monthId, topicId: l.script.topicId, parts,
      source: how === "HERS" ? "CLIENT_REQUEST" : how === "EDITED" ? "MANUAL" : "REVISION",
      basedOnVersionId: read.row.id, regeneratedSections: changed, changeSummary: summary, createdBy: actor.email,
      aiRunId: draft?.runId ?? null, status: "INTERNAL_REVIEW",
      validation: { ok: validation.ok, findings: validation.findings }, gaps: validation.gaps,
    });
    // The version is on the request at once, so a failure below leaves a trail (audit D2).
    await prisma.scriptSuggestion.update({ where: { id: l.sugg.id }, data: { appliedVersionId: v.versionId } });
    // Approve AND share in one step, through the same path as "Approve and send",
    // which also queues the client's "script ready" email when that is switched on.
    const { shareApprovedScript } = await import("@/lib/scriptShare");
    await shareApprovedScript(v.versionId, actor, { note: summary });
    // The message, under the script (Oct 22 2026: no longer in their Messages).
    let messageId: string | null = null;
    if (message) {
      const { postStaffMessage } = await import("@/lib/programMessages");
      const posted = await postStaffMessage(l.script.enrollmentId, { id: actor.appUserId, name: actor.name ?? null, email: actor.email }, message, null, { ref: { kind: "SCRIPT", id: l.script.id }, placement: "script" });
      messageId = posted.ok ? posted.id ?? null : null;
    }
    const k = how === "AI" || how === "AI_EDITED" ? { kept: draft?.kept ?? [], leftOut: draft?.leftOut ?? [] } : await keptOf(l, finalParts);
    const read0 = l.env.office?.read ?? null;
    const decision: RequestDecision = {
      v: 1,
      action: how === "HERS" ? "USE_THEIRS" : how === "EDITED" ? (input.startedFrom === "ours" ? "EDIT_MINE" : "EDIT_THEIRS") : how === "AI" ? "AI_REWRITE" : "AI_REWRITE_EDITED",
      requestKind: l.env.kind ?? (editedWordsOf(l.sugg.editedPartsJson) ? "PARTS" : "MESSAGE"), legacy: !l.env.kind,
      classification: read0 ? { types: read0.types, intent: read0.intent, recommendation: read0.recommendation, runId: read0.runId } : null,
      fromVersionId: read.row.id, fromVersionNo: read.row.versionNo, versionId: v.versionId, versionNo: v.versionNo,
      final: { title: c.title, hook: c.words.hook, points: c.words.points, close: c.words.close, captionCta: parts.captionCta ?? null },
      changed, kept: k.kept, leftOut: k.leftOut, check, sentWithFix: check.needsFix,
      aiRunId: draft?.runId ?? null, aiDraftEdited: how === "AI_EDITED", steer: draft?.steer ?? null, redo: draft?.redo ?? [],
      message: message || null, messageId, by: actor.email, byName: actor.name ?? null, atISO: new Date().toISOString(),
    };
    await updateOfficeRecord(l.sugg.id, (o) => ({ ...o, decision }));
    await prisma.scriptSuggestion.update({ where: { id: l.sugg.id }, data: { status: "APPLIED", appliedHow: how, appliedVersionId: v.versionId, resolvedAt: new Date(), resolvedBy: actor.email } });
    if (draft) {
      const { setRunDisposition, setRunOutputRef } = await import("@/lib/aiRuns");
      await setRunDisposition(draft.runId, how === "AI" ? "ACCEPTED" : "EDITED", actor.email);
      await setRunOutputRef(draft.runId, `ContentScriptVersion:${v.versionId}`);
    } else if (l.env.office?.draft) {
      // A draft was written and another path was chosen.
      const { setRunDisposition } = await import("@/lib/aiRuns");
      await setRunDisposition(l.env.office.draft.runId, "REJECTED", actor.email);
    }
    return { ok: true, versionNo: v.versionNo, versionId: v.versionId, message: `Saved as v${v.versionNo} and shared with ${l.first} for their OK.${message ? " Your message is under the script on their page." : ""}` };
  } catch (e) {
    await prisma.scriptSuggestion.updateMany({ where: { id: l.sugg.id, status: "APPLYING" }, data: { status: "OPEN", resolvedAt: null } }).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message : "That didn't save. Try again." };
  }
}

/**
 * "Use their version" (HERS) or "Edit and use" (EDITED, with the editor's
 * words), sent at once. Kept for the Oct 20 callers; the card now previews
 * first (previewRequestVersion) and sends through sendRequestVersion.
 */
export async function applyRequestWords(suggestionId: string, how: "HERS" | "EDITED", words: EditedWords | null, actor: { email: string; appUserId: string | null }): Promise<ApplyOutcome> {
  return sendRequestVersion(suggestionId, how, { words }, actor);
}

/** Dismiss: the request stays on the card, with the decision recorded. */
export async function dismissScriptRequest(suggestionId: string, actor: Actor): Promise<ApplyOutcome> {
  const l = await loadRequest(suggestionId);
  if (!l || l.sugg.status !== "OPEN") return { ok: false, message: "That request was already handled." };
  const w = await prisma.scriptSuggestion.updateMany({ where: { id: l.sugg.id, status: "OPEN" }, data: { status: "DISMISSED", resolvedAt: new Date(), resolvedBy: actor.email } });
  if (!w.count) return { ok: false, message: "That request was already handled." };
  const read0 = l.env.office?.read ?? null;
  await updateOfficeRecord(l.sugg.id, (o) => ({
    ...o,
    decision: {
      v: 1, action: "DISMISS", requestKind: l.env.kind ?? (editedWordsOf(l.sugg.editedPartsJson) ? "PARTS" : "MESSAGE"), legacy: !l.env.kind,
      classification: read0 ? { types: read0.types, intent: read0.intent, recommendation: read0.recommendation, runId: read0.runId } : null,
      fromVersionId: l.read?.row.id ?? null, fromVersionNo: l.read?.row.versionNo ?? null, versionId: null, versionNo: null, final: null,
      changed: [], kept: [], leftOut: [], check: null, sentWithFix: false, aiRunId: null, aiDraftEdited: false, steer: null, redo: [],
      message: null, messageId: null, by: actor.email, byName: actor.name ?? null, atISO: new Date().toISOString(),
    },
  }));
  if (l.env.office?.draft) {
    const { setRunDisposition } = await import("@/lib/aiRuns");
    await setRunDisposition(l.env.office.draft.runId, "REJECTED", actor.email);
  }
  return { ok: true, message: "Dismissed. Their request stays on the card." };
}

/** "Discard the draft": the AI rewrite leaves the card; their request stays open. */
export async function discardRequestDraft(suggestionId: string, actor: Actor): Promise<ApplyOutcome> {
  const l = await loadRequest(suggestionId);
  if (!l) return { ok: false, message: "That request is gone." };
  const runId = l.env.office?.draft?.runId ?? null;
  if (!runId) return { ok: true, message: "There's no draft to discard." };
  await updateOfficeRecord(l.sugg.id, (o) => ({ ...o, draft: null }));
  const { setRunDisposition } = await import("@/lib/aiRuns");
  await setRunDisposition(runId, "REJECTED", actor.email);
  return { ok: true, message: "Draft discarded. Their request is still open." };
}

// "Apply with AI" (Oct 20) runs on the AI queue, so the request is settled
// when the job lands, not when the button is pressed. The card no longer
// offers it (Oct 22: Rewrite with AI drafts for a preview instead); a job
// already queued still lands here.

/** The queued revision made a version: APPLIED by AI, pointing at that version. */
export async function settleAiApply(suggestionId: string, versionId: string, by: string): Promise<void> {
  // OPEN too: a claim reopened while the job waited is still the request this version applies.
  await prisma.scriptSuggestion.updateMany({
    where: { id: suggestionId, status: { in: ["APPLYING", "OPEN"] } },
    data: { status: "APPLIED", appliedHow: "AI", appliedVersionId: versionId, resolvedAt: new Date(), resolvedBy: by },
  });
}

/** The queued revision stopped before it made a version: the request is open again. */
export async function releaseAiApply(suggestionId: string): Promise<void> {
  await prisma.scriptSuggestion.updateMany({ where: { id: suggestionId, status: "APPLYING" }, data: { status: "OPEN", originalBody: null, resolvedAt: null } });
}

// ---------------------------------------------------------------------------
// THE CLIENT'S SIDE: filing a request.
// ---------------------------------------------------------------------------

/** The version the client is reading, if it is theirs; and its parts. */
async function clientVersion(viewer: import("@/lib/portal").PortalViewer, scriptId: string, readVersionId: string) {
  if (!ID_RE.test(scriptId) || !ID_RE.test(readVersionId)) return null;
  const row = await prisma.contentScriptVersion.findUnique({ where: { id: readVersionId } });
  if (!row || row.scriptId !== scriptId || row.enrollmentId !== viewer.enrollment.id) return null;
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  const kept = partsFromVersionRow(row);
  return { row, kept, base: requestPartsOf(kept) };
}

/** Shape rules on the client's words: plain words, the text left in the box. */
async function clientShape(row: { clientId: string; enrollmentId: string }, kept: import("@/lib/contentScripts").VersionParts, next: RequestParts): Promise<string | null> {
  const { canonicalFromParts, approvedPillarsFor, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const check = validateNewScript(canonicalFromParts({ ...kept, hook: next.hook, points: next.points, close: next.close, captionCta: next.captionCta }, row.clientId), { approvedPillars: await approvedPillarsFor(row.enrollmentId), clientFormat: await clientScriptFormat(row.enrollmentId) });
  const shape = check.findings.find((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  return shape ? plainShape(shape) : null;
}

/**
 * The client edits the words of a script that is waiting on their OK (Oct 20
 * 2026, Jordan: "I also want them to be able to edit the scripts on their
 * side"). Their edit is a change request carrying the exact words, so the
 * office can use it as written, polish it, or answer it. (An APPROVED script
 * is theirs to edit directly: scriptEdits.adoptEditedScript.)
 */
export async function clientEditAsRequest(viewer: import("@/lib/portal").PortalViewer, scriptId: string, readVersionId: string, words: EditedWords): Promise<{ ok: boolean; message: string }> {
  const v = await clientVersion(viewer, scriptId, readVersionId);
  if (!v) return { ok: false, message: "That script isn't on your page." };
  const { base, kept, row } = v;
  if (!Array.isArray(words.points) || words.points.length !== base.points.length) return { ok: false, message: "Something changed on the page. Reload it and try again." };
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 2000);
  const w: EditedWords = { hook: clean(words.hook), points: words.points.map(clean), close: clean(words.close), captionCta: words.captionCta === undefined ? undefined : clean(words.captionCta) || null };
  const next: RequestParts = { hook: w.hook, points: base.points.map((p, i) => ({ role: p.role, text: w.points[i] })), close: w.close, captionCta: w.captionCta === undefined ? base.captionCta : w.captionCta ?? null };
  if (!changedParts(base, next).length) return { ok: false, message: "No changes to send." };
  const shape = await clientShape(row, kept, next);
  if (shape) return { ok: false, message: shape };
  const { clientRequestScriptChanges } = await import("@/lib/scriptDecisions");
  const r = await clientRequestScriptChanges(viewer, scriptId, wordsAsText(base, w), readVersionId, { editedParts: w });
  return r.ok ? { ok: true, message: "Sent. We'll read your edit and share the final version here for your OK." } : { ok: false, message: r.message };
}

export type ClientPartChange = { part: RequestPart; text: string; note?: string | null };
const PART_LABEL_FOR_CLIENT = (base: RequestParts, p: RequestPart): string => {
  if (p === "hook") return "the hook";
  if (p === "close") return "the close";
  if (p === "caption") return "the caption";
  const i = Number(p.slice(5)) - 1;
  const role = base.points[i]?.role;
  return `talking point ${i + 1}${role === "re-hook" ? " (re-hook)" : role === "build-up" ? " (build up)" : role === "payoff" ? " (payoff)" : ""}`;
};

/**
 * OCT 22 2026: "Change this part", on one or more parts at once (decision 6).
 * Each changed part carries their new words and an optional note; the rest of
 * the script stays as it is. Filed as one request, with the parts kept exactly.
 */
export async function clientPartChangeRequest(viewer: import("@/lib/portal").PortalViewer, scriptId: string, readVersionId: string, changes: ClientPartChange[]): Promise<{ ok: boolean; message: string; stale?: boolean }> {
  const v = await clientVersion(viewer, scriptId, readVersionId);
  if (!v) return { ok: false, message: "That script isn't on your page." };
  const { base, kept, row } = v;
  const clean = (t: string | null | undefined, cap = 2000) => (t ?? "").replace(/\r\n?/g, "\n").trim().slice(0, cap);
  const valid = new Set<RequestPart>(["hook", "close", ...base.points.map((_, i) => `point${i + 1}` as RequestPart)]);
  const next: RequestParts = { hook: base.hook, points: base.points.map((p) => ({ ...p })), close: base.close, captionCta: base.captionCta };
  const notes: Partial<Record<RequestPart, string>> = {};
  for (const ch of Array.isArray(changes) ? changes.slice(0, 8) : []) {
    if (!ch || !valid.has(ch.part)) continue;
    const text = clean(ch.text);
    if (!text) return { ok: false, message: `Write the new wording for ${PART_LABEL_FOR_CLIENT(base, ch.part)}, or leave that part as it is.` };
    if (ch.part === "hook") next.hook = text;
    else if (ch.part === "close") next.close = text;
    else next.points[Number(ch.part.slice(5)) - 1] = { ...next.points[Number(ch.part.slice(5)) - 1], text };
    const note = clean(ch.note, 600);
    if (note) notes[ch.part] = note;
  }
  const changed = changedParts(base, next);
  if (!changed.length) return { ok: false, message: "That reads the same as the script. Change the wording, or send us a message instead." };
  const shape = await clientShape(row, kept, next);
  if (shape) return { ok: false, message: shape };
  const words: EditedWords = { hook: next.hook, points: next.points.map((p) => p.text), close: next.close };
  // The record's words: each changed part, its note under it, for the bell, the ledger and any older reader.
  const pick = (x: RequestParts, p: RequestPart) => (p === "hook" ? x.hook : p === "close" ? x.close : x.points[Number(p.slice(5)) - 1]?.text ?? "");
  const body = [
    `I changed ${partList(changed.map((p) => PART_LABEL_FOR_CLIENT(base, p)))}:`,
    ...changed.flatMap((p) => ["", PART_LABEL_FOR_CLIENT(base, p).toUpperCase(), pick(next, p), ...(notes[p] ? [`(Note: ${notes[p]})`] : [])]),
  ].join("\n");
  const { clientRequestScriptChanges } = await import("@/lib/scriptDecisions");
  const r = await clientRequestScriptChanges(viewer, scriptId, body, readVersionId, { editedParts: words, extra: { kind: "PARTS", changed, notes } });
  return r.ok ? { ok: true, message: "Sent. Jordan looks at your wording and sends back an updated version here for your OK." } : { ok: false, message: r.message, stale: "stale" in r ? r.stale : undefined };
}

/** OCT 22 2026: "Ask for a change in your own words": a message, optionally with a pasted rewrite, about part of the script or all of it. */
export async function clientMessageRequest(viewer: import("@/lib/portal").PortalViewer, scriptId: string, readVersionId: string, note: string, about: string[] = []): Promise<{ ok: boolean; message: string; stale?: boolean }> {
  const ab = [...new Set((Array.isArray(about) ? about : []).filter((a): a is ClientAbout => a === "whole" || a === "title" || a === "hook" || a === "close"))];
  const { clientRequestScriptChanges } = await import("@/lib/scriptDecisions");
  const r = await clientRequestScriptChanges(viewer, scriptId, note, readVersionId, { extra: { kind: "MESSAGE", about: ab } });
  return r.ok ? { ok: true, message: r.duplicate ? r.message : "Sent. Jordan replies right here and sends you an updated version for your OK." } : { ok: false, message: r.message, stale: "stale" in r ? r.stale : undefined };
}

/**
 * A reply to the client about their request. Oct 22 2026 (Jordan: "Can the
 * replies to the script changes not go to the messages but under the
 * scripts?"): it lives UNDER the script, on their page and on this card, and
 * no longer in their Messages. It answers their messages under this script and
 * nothing else they wrote (audit D3: a booking question stays waiting). They
 * are emailed a link to it by the same "the office replied" email
 * (programMessages, switch program_message_notice). The script itself is
 * never changed by a reply.
 */
export async function replyToScriptRequest(suggestionId: string, bodyRaw: string, me: { id: string | null; name: string | null; email: string | null }): Promise<{ ok: boolean; message: string }> {
  const body = await cleanMessage(bodyRaw);
  if (body.length < 2) return { ok: false, message: "Write the reply first." };
  const sugg = await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId }, select: { scriptId: true, enrollmentId: true } });
  if (!sugg) return { ok: false, message: "That request is gone." };
  const { postStaffMessage, NOTICE_KEY } = await import("@/lib/programMessages");
  const r = await postStaffMessage(sugg.enrollmentId, me, body, null, { ref: { kind: "SCRIPT", id: sugg.scriptId }, placement: "script" });
  if (!r.ok) return { ok: false, message: r.message };
  const { isAutomationEnabled } = await import("@/lib/programAutomation");
  const emailed = await isAutomationEnabled(NOTICE_KEY).catch(() => false);
  return { ok: true, message: emailed ? "Sent. It's under the script on their page, and they get an email with a link to it." : "Sent. It's under the script on their page. The reply email is off, so they see it next time they open their scripts." };
}

/** "About your script "…":" off the front of a reply, for showing it under that script. */
export function replyText(body: string): string {
  return body.replace(/^About your script "[^"\n]*":\s*/, "").trim();
}

// ---------------------------------------------------------------------------
// THE OFFICE CARD'S DATA.
// ---------------------------------------------------------------------------

export type RequestReadView = Omit<RequestRead, "types"> & { types: { key: FeedbackType; label: string }[] };
export type RequestDraftView = RequestDraft & { points: { role: RequestParts["points"][number]["role"]; text: string }[]; check: VersionCheck | null; nextVersionNo: number; messageWarning: string | null };
export type RequestDecisionView = Pick<RequestDecision, "action" | "versionNo" | "message" | "kept" | "leftOut" | "sentWithFix" | "aiDraftEdited" | "by" | "byName" | "atISO" | "changed"> & {
  final: { title: string; parts: RequestParts } | null; checkSummary: string | null;
};

export type ScriptRequestView = {
  id: string; body: string; createdAtISO: string; status: string;
  appliedHow: string | null; appliedVersionNo: number | null; resolvedAtISO: string | null; resolvedBy: string | null;
  readVersionNo: number | null; readParts: RequestParts | null; readTitle: string | null;
  merged: { parts: RequestParts; full: boolean; changed: RequestPart[] } | null;
  edited: boolean;
  /** The script's thread after this request (Oct 22 2026): the office's replies and, written under the script, the client's; `waiting` = a client's words nobody has answered yet. */
  replies: { id: string; body: string; atISO: string; by: string; from: "office" | "client"; waiting: boolean }[];
  /** Oct 22 2026: how they asked. A request from before today: an in-place edit reads as PARTS, a note as MESSAGE. */
  kind: RequestKind;
  legacy: boolean;
  notes: Partial<Record<RequestPart, string>>;
  about: string[];
  /** Spoken words of their wording when it reads as a script (their pasted rewrite, or the script with their parts in). */
  theirWords: number | null;
  read: RequestReadView | null;
  draft: RequestDraftView | null;
  decision: RequestDecisionView | null;
};
export type ScriptRequestGroupView = { scriptId: string; title: string; versionNo: number | null; nextVersionNo: number; clientFirst: string; requests: ScriptRequestView[] };

export function readView(r: RequestRead | undefined | null): RequestReadView | null {
  if (!r) return null;
  return { ...r, types: (r.types ?? []).filter((t) => t in FEEDBACK_TYPE_LABEL).map((t) => ({ key: t, label: FEEDBACK_TYPE_LABEL[t] })) };
}

/** Every request on this month's scripts: open ones first, the handled ones kept (60 days) with how. */
export async function loadScriptRequestsForMonth(monthId: string): Promise<ScriptRequestGroupView[]> {
  const scripts = await prisma.contentScript.findMany({ where: { monthId }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, currentVersionId: true, clientId: true, enrollmentId: true, monthId: true } });
  if (!scripts.length) return [];
  const since = new Date(Date.now() - 60 * 86_400_000);
  // A claim left behind by a function that was killed mid-apply (audit D8):
  // APPLYING stamps resolvedAt when claimed; ten minutes later it is open again,
  // unless its "Apply with AI" is still on the AI queue (Oct 20 2026): that
  // claim is live however long the queue takes, and the job settles it.
  const stale = await prisma.scriptSuggestion.findMany({
    where: { scriptId: { in: scripts.map((s) => s.id) }, status: "APPLYING", OR: [{ resolvedAt: null }, { resolvedAt: { lt: new Date(Date.now() - 10 * 60_000) } }] },
    select: { id: true },
  }).catch(() => []);
  if (stale.length) {
    const { suggestionsInFlight } = await import("@/lib/aiQueue");
    const live = await suggestionsInFlight(stale.map((r) => r.id)).catch(() => null);
    const dead = live ? stale.filter((r) => !live.has(r.id)).map((r) => r.id) : [];
    if (dead.length) {
      await prisma.scriptSuggestion.updateMany({ where: { id: { in: dead }, status: "APPLYING" }, data: { status: "OPEN", resolvedAt: null } }).catch(() => {});
    }
  }
  // Oct 22 2026: the script's own thread. The office's replies (under the
  // script from today; in Messages, marked with the script, before), and the
  // client's replies written under the script, which also wait on Messages.
  const { SCRIPT_THREAD } = await import("@/lib/programMessages");
  const replies = await prisma.programMessage.findMany({
    where: { refId: { in: scripts.map((s) => s.id) }, OR: [{ refKind: SCRIPT_THREAD }, { refKind: "SCRIPT", authorKind: "STAFF" }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, refId: true, body: true, createdAt: true, authorLabel: true, authorKind: true, handledAt: true },
  });
  // A script whose client wrote under it lately keeps its card, however old the request.
  const talkedOn = [...new Set(replies.filter((m) => m.authorKind === "CLIENT" && (!m.handledAt || m.createdAt >= since)).map((m) => m.refId).filter((x): x is string => !!x))];
  const reqs = await prisma.scriptSuggestion.findMany({
    where: { scriptId: { in: scripts.map((s) => s.id) }, OR: [{ status: { in: ["OPEN", "APPLYING"] } }, { resolvedAt: { gte: since } }, { createdAt: { gte: since } }, ...(talkedOn.length ? [{ scriptId: { in: talkedOn } }] : [])] },
    orderBy: { createdAt: "asc" },
  });
  if (!reqs.length) return [];
  const versionIds = [...new Set([...scripts.map((s) => s.currentVersionId), ...reqs.map((r) => r.scriptVersionId), ...reqs.map((r) => r.appliedVersionId)].filter((x): x is string => !!x))];
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } } });
  const vById = new Map(versions.map((v) => [v.id, v]));
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  const client = await prisma.client.findUnique({ where: { id: scripts[0].clientId }, select: { name: true } }).catch(() => null);
  const clientFirst = (client?.name ?? "").split(" ")[0] || "the client";
  const lastNo = await prisma.contentScriptVersion.groupBy({ by: ["scriptId"], where: { scriptId: { in: scripts.map((s) => s.id) } }, _max: { versionNo: true } }).catch(() => []);
  const nextNoOf = new Map(lastNo.map((r) => [r.scriptId, (r._max.versionNo ?? 0) + 1]));
  const out: ScriptRequestGroupView[] = [];
  for (const s of scripts) {
    const mine = reqs.filter((r) => r.scriptId === s.id);
    if (!mine.length) continue;
    const requests: ScriptRequestView[] = [];
    for (const [i, r] of mine.entries()) {
      const readRow = (r.scriptVersionId && vById.get(r.scriptVersionId)) || (s.currentVersionId && vById.get(s.currentVersionId)) || null;
      const readParts = readRow ? requestPartsOf(partsFromVersionRow(readRow)) : null;
      const merged = readParts ? await mergeRequestParts(readParts, { body: r.body, editedPartsJson: r.editedPartsJson, title: s.title }) : null;
      const next = mine[i + 1]?.createdAt ?? null;
      const env = envelopeOf(r.editedPartsJson);
      const edited = !!editedWordsOf(r.editedPartsJson);
      const open = r.status === "OPEN" || r.status === "APPLYING";
      const draft = open && env.office?.draft ? env.office.draft : null;
      let draftView: RequestDraftView | null = null;
      if (draft && readRow && readParts) {
        const base = { row: readRow as unknown as VersionRow, parts: readParts };
        const check = await checkRequestVersion({ title: draft.title, words: draft.words }, { base, sources: await claimSources(r, base, s), enrollmentId: s.enrollmentId, clientId: s.clientId }).catch(() => null);
        draftView = { ...draft, points: readParts.points.map((p, j) => ({ role: p.role, text: draft.words.points[j] ?? "" })), check, nextVersionNo: nextNoOf.get(s.id) ?? 1, messageWarning: promisesReach(draft.message) ? "This message reads like a promise of views or reach. We never promise those." : null };
      }
      const d = env.office?.decision ?? null;
      requests.push({
        id: r.id, body: r.body, createdAtISO: r.createdAt.toISOString(), status: r.status,
        appliedHow: r.appliedHow, appliedVersionNo: r.appliedVersionId ? vById.get(r.appliedVersionId)?.versionNo ?? null : null,
        resolvedAtISO: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy,
        readVersionNo: readRow?.versionNo ?? null, readParts, readTitle: readRow?.title ?? null, merged, edited,
        // Everything after this request and before the next one.
        replies: replies.filter((m) => m.refId === s.id && m.createdAt >= r.createdAt && (!next || m.createdAt < next)).map((m) => {
          const office = m.authorKind === "STAFF";
          return { id: m.id, body: office ? replyText(m.body) : m.body, atISO: m.createdAt.toISOString(), by: m.authorLabel, from: office ? "office" as const : "client" as const, waiting: !office && !m.handledAt };
        }),
        kind: env.kind ?? (edited ? "PARTS" : "MESSAGE"), legacy: !env.kind,
        notes: env.notes ?? {}, about: (env.about ?? []).map((a) => ABOUT_LABEL[a]).filter(Boolean),
        theirWords: merged && (merged.full || edited) ? spokenWords(merged.parts) : null,
        read: readView(env.office?.read),
        draft: draftView,
        decision: d ? {
          action: d.action, versionNo: d.versionNo, message: d.message, kept: d.kept ?? [], leftOut: d.leftOut ?? [], sentWithFix: !!d.sentWithFix, aiDraftEdited: !!d.aiDraftEdited,
          by: d.by, byName: d.byName, atISO: d.atISO, changed: d.changed ?? [],
          final: d.final && readParts ? { title: d.final.title, parts: { hook: d.final.hook, points: readParts.points.map((p, j) => ({ role: p.role, text: d.final!.points[j] ?? "" })), close: d.final.close, captionCta: d.final.captionCta } } : null,
          checkSummary: d.check ? d.check.items.filter((x) => x.status !== "pass").map((x) => x.label).join(" ") || "Passed every check." : null,
        } : null,
      });
    }
    // Open first, then handled newest first.
    requests.sort((a, b) => Number(b.status === "OPEN" || b.status === "APPLYING") - Number(a.status === "OPEN" || a.status === "APPLYING") || (a.status === "OPEN" ? a.createdAtISO.localeCompare(b.createdAtISO) : b.createdAtISO.localeCompare(a.createdAtISO)));
    out.push({ scriptId: s.id, title: s.title, versionNo: s.currentVersionId ? vById.get(s.currentVersionId)?.versionNo ?? null : null, nextVersionNo: nextNoOf.get(s.id) ?? 1, clientFirst, requests });
  }
  // Scripts with something open first.
  return out.sort((a, b) => Number(b.requests.some((r) => r.status === "OPEN")) - Number(a.requests.some((r) => r.status === "OPEN")));
}

// ---------------------------------------------------------------------------
// THE CLIENT'S PAGE: "the updated version comes back" (Portal-Updated board).
// A shared version that answered their request carries the request's date,
// the version it came from, which parts changed, and the message sent with it.
// ---------------------------------------------------------------------------

export type PortalScriptUpdate = {
  versionNo: number; fromVersionNo: number | null; requestedAtISO: string;
  changed: string[]; title: string; previous: { title: string; parts: RequestParts } | null;
  message: { body: string; by: string; initials: string; atISO: string } | null;
};

export async function portalScriptUpdates(enrollmentId: string, scriptIds: string[]): Promise<Record<string, PortalScriptUpdate>> {
  const ids = scriptIds.filter((id) => ID_RE.test(id));
  if (!ids.length) return {};
  const scripts = await prisma.contentScript.findMany({ where: { id: { in: ids }, enrollmentId, releaseState: "released" }, select: { id: true, sharedVersionId: true } });
  const shared = scripts.map((s) => s.sharedVersionId).filter((x): x is string => !!x);
  if (!shared.length) return {};
  const reqs = await prisma.scriptSuggestion.findMany({ where: { enrollmentId, status: "APPLIED", appliedVersionId: { in: shared } }, orderBy: { resolvedAt: "desc" } });
  if (!reqs.length) return {};
  const vIds = [...new Set(reqs.flatMap((r) => [r.appliedVersionId, r.scriptVersionId]).filter((x): x is string => !!x))];
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: vIds } } });
  const vById = new Map(versions.map((v) => [v.id, v]));
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  const msgIds = reqs.map((r) => envelopeOf(r.editedPartsJson).office?.decision?.messageId).filter((x): x is string => !!x);
  const msgs = msgIds.length ? await prisma.programMessage.findMany({ where: { id: { in: msgIds }, enrollmentId }, select: { id: true, body: true, authorLabel: true, createdAt: true } }) : [];
  const out: Record<string, PortalScriptUpdate> = {};
  for (const s of scripts) {
    const r = reqs.find((x) => x.scriptId === s.id && x.appliedVersionId === s.sharedVersionId);
    const now = r?.appliedVersionId ? vById.get(r.appliedVersionId) : null;
    if (!r || !now) continue;
    const before = r.scriptVersionId ? vById.get(r.scriptVersionId) ?? null : null;
    const nowParts = requestPartsOf(partsFromVersionRow(now));
    const prevParts = before ? requestPartsOf(partsFromVersionRow(before)) : null;
    const changed = prevParts ? [...(before!.title !== now.title ? ["title"] : []), ...changedParts(prevParts, nowParts)] : [];
    const mid = envelopeOf(r.editedPartsJson).office?.decision?.messageId ?? null;
    const m = mid ? msgs.find((x) => x.id === mid) ?? null : null;
    const label = (m?.authorLabel ?? "").trim();
    out[s.id] = {
      versionNo: now.versionNo, fromVersionNo: before?.versionNo ?? null, requestedAtISO: r.createdAt.toISOString(),
      changed, title: now.title, previous: before && prevParts ? { title: before.title, parts: prevParts } : null,
      message: m ? { body: replyText(m.body), by: label.split(/\s+/)[0] || "Realtour Pilot", initials: label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "RP", atISO: m.createdAt.toISOString() } : null,
    };
  }
  return out;
}

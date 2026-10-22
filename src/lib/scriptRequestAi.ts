import "server-only";
import { prisma } from "@/lib/prisma";
import {
  FEEDBACK_TYPE_LABEL, SCRIPT_LENGTH, ABOUT_LABEL, envelopeOf, editedWordsOf, mergeRequestParts, partList, readView, spokenWords, updateOfficeRecord, loadRequest,
  type Loaded, type FeedbackType, type RequestDraft, type RequestPart, type RequestParts, type RequestRead, type RequestReadView,
} from "@/lib/scriptRequests";

// ---------------------------------------------------------------------------
// THE TWO AI CALLS ON A CLIENT'S SCRIPT CHANGE REQUEST (Oct 22 2026).
//
//   1. THE READ (readScriptRequest): before anything is rewritten, what they
//      are asking for: the feedback types (Jordan's brief §10 Stage 7), their
//      intent in one sentence, what is useful from their words, and a
//      recommendation. It rewrites nothing.
//   2. THE REWRITE (rewriteScriptRequest): a draft of the next version for the
//      office to read: the five parts, what was kept from their version, what
//      was left out and why, a self-review, and a message to the client. It
//      sends nothing; the office previews it and presses Send
//      (scriptRequests.sendRequestVersion).
//
// Both go through runAiJson (aiRuns.ts) exactly like every other Content
// Program call: a ProgramAiRun row each, quota-checked, a person's click (never
// unattended). EVERYTHING A PROMPT SAYS LIVES IN THIS FILE: the two system
// prompts, the two builders, the two schemas, the model (REQUEST_AI_MODEL) and
// the prompt versions, so moving these calls to the newer scripting model is a
// one-line change here.
// ---------------------------------------------------------------------------

/** undefined = the hub's default model (integrations/ai SMART). Set it to repoint both calls. */
export const REQUEST_AI_MODEL: string | undefined = undefined;
const READ_PROMPT_VERSION = "script-request-read.v1";
const REWRITE_PROMPT_VERSION = "script-request-rewrite.v1";

const FEEDBACK_MEANING: Record<FeedbackType, string> = {
  FACTUAL_CORRECTION: "a fact in our version is wrong",
  PERSONAL_EXPERIENCE: "their own story, history, or the order things happened in",
  WORDING_PREFERENCE: "how something is said: their phrasing, vocabulary or voice",
  MISSING_INFORMATION: "something they want in that is missing",
  ADDITIONAL_EXPERTISE: "their process, knowledge or advice added",
  TOPIC_CHANGE: "a different topic, angle or title direction for the video",
  STRUCTURE_SUGGESTION: "a different hook, order or creative shape",
  LENGTH_PACING: "too long, too short, too slow or rushed",
  PURPOSE_DISAGREEMENT: "they disagree with what the video is for",
};

/** The five parts and the close rule, in Jordan's words (brief §6), for both prompts. */
const FRAMEWORK = [
  "HOOK: capture attention at once with a relatable belief or misconception, a real problem, an unexpected contrast, an interesting question or a personal experience, in the words a homeowner or buyer would use. No greeting, no \"Today I want to talk about\".",
  "RE-HOOK (talking point 1): a new reason to keep watching: curiosity, contrast, tension, a surprising detail or a shift in perspective. Never a restatement of the hook.",
  "BUILD-UP (talking point 2): develop the idea with enough context, using concrete examples and the client's real expertise. No over-explaining.",
  "PAYOFF (talking point 3): deliver what the hook promised: practical advice, the client's own process, or a real insight that builds trust.",
  "CLOSE: finish naturally. When the video teaches or offers help, end on a clear call to action (\"Let's talk\", \"Message me\"); when it is a personal story or a belief, end on a callback to the hook. Never force a sales pitch into a personal story.",
];
const LENGTH_RULE = `Aim for ${SCRIPT_LENGTH.aimMin} to ${SCRIPT_LENGTH.aimMax} spoken words across the five parts; ${SCRIPT_LENGTH.cap} is the hard cap. Never make it dry or incomplete to hit the number, and never drop substance or the client's legitimate points: a short script without meaningful information is not acceptable, and neither is a longer one padded with unnecessary detail. Every sentence should create interest, build understanding, deliver value, build credibility or move the story to its end.`;
const NO_DASH_RULE = "Never write an em dash or an en dash anywhere (script or message). Use a comma, a period or the word \"and\".";

const READ_SYSTEM = [
  "You are the first reader of a client's change request on a short-form video script at Realtour Pilot, a video agency for real estate agents. The client is the agent who will say the script on camera.",
  "You do NOT rewrite anything. You read what they asked for, classify it, and say what they are trying to achieve, so the creative director can decide what to do before anything is rewritten.",
  "Realtour Pilot owns creative direction; the client owns the truth of their experience, opinions and brand. Neither their version nor ours wins automatically.",
  "Write in plain, short sentences. Refer to the client by first name or as \"they\". " + NO_DASH_RULE,
].join("\n");

const READ_SCHEMA = {
  type: "object",
  properties: {
    types: { type: "array", items: { type: "string", enum: Object.keys(FEEDBACK_TYPE_LABEL) }, description: "Every kind of feedback in the request." },
    intent: { type: "string", description: "What they are trying to accomplish, in one sentence." },
    useful: { type: "array", items: { type: "string" }, description: "Specific points, phrases or facts from their words worth keeping, short, in their words where possible." },
    recommendation: { type: "string", description: "One or two sentences for the creative director." },
    keepTopic: { type: "boolean", description: "False only when they ask for a different video topic." },
    watch: { type: "string", description: "Anything to be careful with, or empty." },
    profileNote: { type: "string", description: "One line from their profile or facts that bears on this, naming the source, or empty." },
  },
  required: ["types", "intent", "useful", "recommendation", "keepTopic"],
} as const;

const REVIEW_KEYS = ["on_topic", "their_meaning", "hook_grabs", "rehook_new", "payoff_delivers", "close_natural", "sounds_like_them", "claims_supported"] as const;
export const REVIEW_LABEL: Record<(typeof REVIEW_KEYS)[number], string> = {
  on_topic: "On topic", their_meaning: "Their meaning", hook_grabs: "Hook grabs", rehook_new: "Re-hook adds something new",
  payoff_delivers: "Payoff delivers", close_natural: "Close feels natural", sounds_like_them: "Sounds like them", claims_supported: "Every claim supported",
};

const REWRITE_SYSTEM = [
  "You are Realtour Pilot's script editor. A real estate agent asked for changes to a short-form video script they will say on camera. Write the next version for the creative director to read before anything is sent.",
  "Keep their legitimate intent and their vocabulary, and apply our standards. Neither their version nor ours wins automatically. Realtour Pilot owns creative direction; the client owns the truth of their experience, opinions and brand.",
  "",
  "THE FIVE PARTS, in this order:",
  ...FRAMEWORK.map((l) => `- ${l}`),
  "",
  "RULES:",
  `- LENGTH: ${LENGTH_RULE}`,
  "- TOPIC: keep the topic. Change it only when the request is a real topic change AND the creative director's steer says to change it. Keep the title unless the steer says otherwise.",
  "- THEIR WORDS: keep their legitimate intent, their phrasing and their vocabulary where they work, and use their best points. Their wording strongly shapes how it sounds; it does not decide the structure, the length or the creative direction.",
  "- TRUTH: no claims they did not make. No numbers, statistics, credentials, client stories, outcomes, market reasons or causes unless they appear in their words, our version or their accepted facts. Background reasoning is not spoken content: an explanation the creative director might know (rates, the economy) is not something the client said, so leave it out.",
  "- LANGUAGE: plain spoken sentences in homeowner language, not industry jargon. Never note a duration or a time length in the script. " + NO_DASH_RULE,
  "- A PART CHANGE: start from the parts they changed and their wording; keep the other parts word for word unless a small change is needed so the script still flows (then say which in kept or left out).",
  "- KEPT and LEFT OUT: name what you kept from their version, and every thing you shortened or left out with the reason (the topic, pacing, attention, a claim they did not make).",
  "- REVIEW: judge your own draft honestly against each check. Do not pass a check it fails.",
  "",
  "THE MESSAGE TO THE CLIENT (the creative director reads and edits it before it is sent; it goes out under their name):",
  "- Address them by first name. Thank them for their input.",
  "- Name the ideas of theirs that are in this version.",
  "- Explain briefly what was shortened or left out and why (the topic, pacing, holding the viewer's attention). Reinforce the topic and the strategy when relevant.",
  "- Invite them to correct anything that isn't accurate or doesn't sound like them, without reopening every creative decision.",
  "- Never promise views, reach, followers or engagement. Never mention seconds or a runtime.",
  "- Warm, plain, two to five sentences, first person. Gender-neutral. " + NO_DASH_RULE,
].join("\n");

function rewriteSchema(points: number) {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "The video title. The current one unless the steer says to change it." },
      hook: { type: "string" },
      points: { type: "array", items: { type: "string" }, minItems: points, maxItems: points, description: `Exactly ${points} talking points, in order: re-hook, build-up, payoff.` },
      close: { type: "string" },
      tags: {
        type: "object",
        description: "Where each part came from, in two to five words (for example: \"their belief, our framing\", \"new: tension\", \"their process\", \"ties back to the hook\").",
        properties: { hook: { type: "string" }, ...Object.fromEntries(Array.from({ length: points }, (_, i) => [`point${i + 1}`, { type: "string" }])), close: { type: "string" } },
      },
      kept: { type: "array", items: { type: "string" }, description: "What this version keeps from their version or message." },
      leftOut: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what", "why"] } },
      review: { type: "array", items: { type: "object", properties: { key: { type: "string", enum: [...REVIEW_KEYS] }, pass: { type: "boolean" }, note: { type: "string" } }, required: ["key", "pass"] } },
      message: { type: "string", description: "The message to the client." },
    },
    required: ["title", "hook", "points", "close", "kept", "leftOut", "review", "message"],
  } as const;
}

// ---------------------------------------------------------------------------
// The context both prompts are built from.
// ---------------------------------------------------------------------------

const POINT_HEADING = (i: number, role: RequestParts["points"][number]["role"]) => `TALKING POINT ${i + 1}${role === "re-hook" ? " (RE-HOOK)" : role === "build-up" ? " (BUILD-UP)" : role === "payoff" ? " (PAYOFF)" : ""}`;
function scriptText(title: string | null, p: RequestParts): string {
  return [
    ...(title ? [`TITLE: ${title}`] : []),
    `HOOK: ${p.hook}`,
    ...p.points.map((x, i) => `${POINT_HEADING(i, x.role)}: ${x.text}`),
    `CLOSE: ${p.close}`,
    ...(p.captionCta ? [`CAPTION (not spoken): ${p.captionCta}`] : []),
  ].join("\n");
}
const partText = (p: RequestParts, k: RequestPart) => (k === "hook" ? p.hook : k === "close" ? p.close : k === "caption" ? p.captionCta ?? "" : p.points[Number(k.slice(5)) - 1]?.text ?? "");
const PART_HEADING = (p: RequestParts, k: RequestPart) => (k === "hook" ? "HOOK" : k === "close" ? "CLOSE" : k === "caption" ? "CAPTION" : POINT_HEADING(Number(k.slice(5)) - 1, p.points[Number(k.slice(5)) - 1]?.role ?? null));

type Ctx = {
  l: Loaded; read: { row: { id: string; title: string; versionNo: number; validationJson?: string | null }; parts: RequestParts };
  kind: "PARTS" | "MESSAGE"; merged: Awaited<ReturnType<typeof mergeRequestParts>>;
  topicLines: string[]; facts: string[]; identity: string; angle: string[];
};

async function contextFor(suggestionId: string): Promise<Ctx | { error: string }> {
  const l = await loadRequest(suggestionId);
  if (!l) return { error: "That request is gone." };
  if (l.script.historical) return { error: "This is an imported historical script. It isn't rewritten; draft a new script for the topic instead." };
  if (!l.read) return { error: "The version they read isn't on file any more." };
  const read = l.read as unknown as Ctx["read"];
  const merged = await mergeRequestParts(l.read.parts, { body: l.sugg.body, editedPartsJson: l.sugg.editedPartsJson, title: l.script.title });
  const kind = l.env.kind ?? (editedWordsOf(l.sugg.editedPartsJson) ? "PARTS" : "MESSAGE");
  const [topic, enrollment, facts] = await Promise.all([
    l.script.topicId ? prisma.contentTopic.findUnique({ where: { id: l.script.topicId }, select: { title: true, concept: true, audienceNeed: true, businessGoal: true, intendedMessage: true, clientWording: true } }) : Promise.resolve(null),
    prisma.contentEnrollment.findUnique({ where: { id: l.script.enrollmentId }, select: { overridesJson: true } }),
    import("@/lib/clientFacts").then((m) => m.factsForPrompt(l.script.clientId, { monthId: l.script.monthId, take: 30 }).then(m.factLines)).catch(() => [] as string[]),
  ]);
  const topicLines = topic ? [
    `Title: ${topic.title}`,
    ...(topic.concept ? [`Concept: ${topic.concept}`] : []),
    ...(topic.audienceNeed ? [`Audience need: ${topic.audienceNeed}`] : []),
    ...(topic.businessGoal ? [`Goal: ${topic.businessGoal}`] : []),
    ...(topic.intendedMessage ? [`Intended message: ${topic.intendedMessage}`] : []),
    ...(topic.clientWording ? [`Their own words for the topic: ${topic.clientWording}`] : []),
  ] : [`Title: ${l.script.title}`];
  const { creativeIdentityFromOverrides, creativeIdentityBlock } = await import("@/lib/contentPolicy");
  const identity = creativeIdentityBlock(creativeIdentityFromOverrides(enrollment?.overridesJson ?? null));
  const { readAngle } = await import("@/lib/scriptJudgeRecord");
  const angle = Object.entries(readAngle(read.row.validationJson ?? null) ?? {}).map(([k, v]) => `${k}: ${v}`);
  return { l, read, kind, merged, topicLines, facts, identity, angle };
}

function requestText(c: Ctx): string {
  const { l, read, merged } = c;
  const when = l.sugg.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  if (c.kind === "PARTS" && merged) {
    const changed = (l.env.changed?.length ? l.env.changed : merged.changed).filter((k) => k !== "caption");
    const notes = l.env.notes ?? {};
    return [
      `A PART CHANGE (${when}): they changed ${partList(changed)} and left the rest as it is.`,
      ...changed.flatMap((k) => ["", PART_HEADING(read.parts, k), `  OURS: ${partText(read.parts, k)}`, `  THEIRS: ${partText(merged.parts, k)}`, ...(notes[k] ? [`  THEIR NOTE: ${notes[k]}`] : [])]),
    ].join("\n");
  }
  const about = (l.env.about ?? []).map((a) => ABOUT_LABEL[a]).filter(Boolean);
  return [
    `A MESSAGE (${when})${about.length ? `, about: ${about.join(", ")}` : ""}. Their words, exactly:`,
    '"""', l.sugg.body, '"""',
    ...(merged ? ["", merged.full ? `It contains a full rewrite of the script (${spokenWords(merged.parts)} spoken words), read as parts:` : `It contains new wording for the ${partList(merged.changed)}, read as parts:`, scriptText(null, merged.parts)] : []),
  ].join("\n");
}

function contextBlock(c: Ctx): string {
  return [
    `THE CLIENT: ${c.l.first}`,
    "",
    "THE TOPIC:",
    ...c.topicLines.map((x) => `- ${x}`),
    ...(c.angle.length ? ["", "THE ANGLE WE WROTE IT ON:", ...c.angle.map((x) => `- ${x}`)] : []),
    "",
    `OUR VERSION THEY READ (v${c.read.row.versionNo}, ${spokenWords(c.read.parts)} spoken words):`,
    scriptText(c.read.row.title, c.read.parts),
    "",
    "THEIR REQUEST:",
    requestText(c),
    "",
    ...(c.identity ? [c.identity, ""] : []),
    c.facts.length ? "ACCEPTED FACTS ABOUT THEM (the only facts beyond their words and our version):" : "ACCEPTED FACTS ABOUT THEM: none on file.",
    ...c.facts.map((f) => `- ${f}`),
  ].join("\n");
}

const strip = async (t: string) => (await import("@/lib/contentPolicy")).stripScriptDashes(t);
const str = (v: unknown, cap = 2000) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, cap) : "");
const strs = (v: unknown, n = 12, cap = 400) => (Array.isArray(v) ? v.map((x) => str(x, cap)).filter(Boolean).slice(0, n) : []);

// ---------------------------------------------------------------------------
// 1. THE READ.
// ---------------------------------------------------------------------------

export async function readScriptRequest(suggestionId: string, opts: { requestedBy: string; again?: boolean }): Promise<{ ok: true; read: RequestReadView } | { ok: false; message: string }> {
  const c = await contextFor(suggestionId);
  if ("error" in c) return { ok: false, message: c.error };
  const have = c.l.env.office?.read;
  if (have && !opts.again) return { ok: true, read: readView(have)! };
  const prompt = [
    contextBlock(c),
    "",
    "OUR STANDARDS:",
    "- Five parts: hook, re-hook, build-up, payoff, close.",
    `- ${LENGTH_RULE}`,
    "",
    "YOUR TASK (nothing is rewritten yet):",
    "1. types: every kind of feedback in their request, from this list:",
    ...(Object.keys(FEEDBACK_MEANING) as FeedbackType[]).map((k) => `   ${k}: ${FEEDBACK_MEANING[k]}`),
    "2. intent: what they are trying to accomplish, in one sentence.",
    "3. useful: the specific points, phrases or facts from their words worth keeping. Empty when there are none.",
    "4. recommendation: one or two sentences for the creative director: keep the topic or not, what to use from their words, what to leave out, and the length to aim for. Keep the topic unless the request is a real topic change.",
    "5. keepTopic: false only when they are asking for a different video topic.",
    "6. watch: anything to be careful with (a claim that needs their confirmation, background reasoning that is not theirs to say, a promise). Empty when there is nothing.",
    "7. profileNote: one line from their profile or accepted facts that bears on this request, naming where it comes from. Empty when there is nothing.",
  ].join("\n");
  try {
    const { runAiJson, activePolicyVersion } = await import("@/lib/aiRuns");
    const policy = await activePolicyVersion().catch(() => null);
    const run = await runAiJson<Record<string, unknown>>({
      // NEEDS (aiRuns.ts is the writer's): a kind of its own, "script_request_read".
      kind: "creative_review", enrollmentId: c.l.script.enrollmentId, clientId: c.l.script.clientId,
      scope: { scriptId: c.l.script.id, suggestionId: c.l.sugg.id, step: "script_request_read" },
      inputRefs: { suggestionId: c.l.sugg.id, readVersionId: c.read.row.id, facts: c.facts.length },
      promptKey: "script-request-read", promptVersion: READ_PROMPT_VERSION, policyVersionId: policy?.id ?? null,
      requestedBy: opts.requestedBy, unattended: false, dedupeKey: `script-request-read:${c.l.sugg.id}`,
      system: READ_SYSTEM, prompt, schema: READ_SCHEMA as unknown as Record<string, unknown>, maxTokens: 1200, model: REQUEST_AI_MODEL,
    });
    const o = run.output;
    const types = [...new Set(strs(o.types, 9, 40).filter((t): t is FeedbackType => t in FEEDBACK_TYPE_LABEL))];
    const read: RequestRead = {
      types, intent: await strip(str(o.intent, 400)), useful: await Promise.all(strs(o.useful, 10, 300).map(strip)), recommendation: await strip(str(o.recommendation, 700)),
      keepTopic: o.keepTopic !== false, watch: (await strip(str(o.watch, 500))) || null, profileNote: (await strip(str(o.profileNote, 400))) || null,
      runId: run.runId, atISO: new Date().toISOString(), by: opts.requestedBy,
    };
    if (!read.intent) return { ok: false, message: "The AI read came back empty. Try again." };
    await updateOfficeRecord(c.l.sugg.id, (off) => ({ ...off, read }));
    return { ok: true, read: readView(read)! };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The AI read didn't work. Try again." };
  }
}

// ---------------------------------------------------------------------------
// 2. THE REWRITE. The read comes first, always: a rewrite of a request nobody
// has read would decide what they meant without saying so.
// ---------------------------------------------------------------------------

export async function rewriteScriptRequest(suggestionId: string, opts: { requestedBy: string; steer?: string | null; redo?: string | null }): Promise<{ ok: true; draft: RequestDraft } | { ok: false; message: string }> {
  const first = await contextFor(suggestionId);
  if ("error" in first) return { ok: false, message: first.error };
  if (first.l.sugg.status !== "OPEN") return { ok: false, message: "That request was already handled." };
  let readRec = first.l.env.office?.read ?? null;
  if (!readRec) {
    const r = await readScriptRequest(suggestionId, { requestedBy: opts.requestedBy });
    if (!r.ok) return { ok: false, message: `The request has to be read first, and that didn't work: ${r.message}` };
    readRec = envelopeOf((await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId }, select: { editedPartsJson: true } }))?.editedPartsJson).office?.read ?? null;
  }
  const c = first;
  const prev = opts.redo ? c.l.env.office?.draft ?? null : null;
  if (opts.redo && !prev) return { ok: false, message: "There's no draft to redo. Press Rewrite with AI first." };
  const steer = str(opts.steer ?? prev?.steer ?? "", 1000) || null;
  const redoNote = str(opts.redo ?? "", 1000) || null;
  const n = c.read.parts.points.length;
  const prompt = [
    contextBlock(c),
    "",
    "WHAT THEY ARE ASKING FOR (read before this rewrite):",
    ...(readRec ? [
      `- Feedback: ${readRec.types.map((t) => FEEDBACK_TYPE_LABEL[t]).join(", ") || "not classified"}`,
      `- Their intent: ${readRec.intent}`,
      ...(readRec.useful.length ? [`- Useful from their words: ${readRec.useful.join("; ")}`] : []),
      `- Recommendation: ${readRec.recommendation}`,
      `- Keep the topic: ${readRec.keepTopic ? "yes" : "they asked for a change; keep it unless the steer says otherwise"}`,
      ...(readRec.watch ? [`- Watch: ${readRec.watch}`] : []),
    ] : ["- (no read on file)"]),
    "",
    steer ? `THE CREATIVE DIRECTOR'S STEER (only you see this; follow it):\n${steer}` : "THE CREATIVE DIRECTOR'S STEER: none.",
    ...(prev && redoNote ? ["", "YOUR PREVIOUS DRAFT:", scriptText(prev.title, { hook: prev.words.hook, points: c.read.parts.points.map((p, i) => ({ role: p.role, text: prev.words.points[i] ?? "" })), close: prev.words.close, captionCta: null }), "", `THE CREATIVE DIRECTOR'S NOTE ON IT (change this, keep the rest that works):\n${redoNote}`] : []),
    "",
    `Write the next version: the title, the hook, exactly ${n} talking points (${c.read.parts.points.map((p, i) => p.role ?? `point ${i + 1}`).join(", ")}), and the close. Then the tags, kept, left out, your review against each check (${REVIEW_KEYS.join(", ")}), and the message to ${c.l.first}.`,
  ].join("\n");
  try {
    const { runAiJson, activePolicyVersion, setRunDisposition } = await import("@/lib/aiRuns");
    const policy = await activePolicyVersion().catch(() => null);
    const run = await runAiJson<Record<string, unknown>>({
      kind: "script_revise", enrollmentId: c.l.script.enrollmentId, clientId: c.l.script.clientId,
      scope: { scriptId: c.l.script.id, suggestionId: c.l.sugg.id, step: "script_request_rewrite", basedOnVersionId: c.read.row.id },
      inputRefs: { suggestionId: c.l.sugg.id, readVersionId: c.read.row.id, readRunId: readRec?.runId ?? null, previousRunId: prev?.runId ?? null, facts: c.facts.length },
      promptKey: "script-request-rewrite", promptVersion: REWRITE_PROMPT_VERSION, policyVersionId: policy?.id ?? null,
      requestedBy: opts.requestedBy, unattended: false, dedupeKey: `script-request-rewrite:${c.l.sugg.id}`,
      system: REWRITE_SYSTEM, prompt, schema: rewriteSchema(n) as unknown as Record<string, unknown>, maxTokens: 2500, model: REQUEST_AI_MODEL,
    });
    const o = run.output;
    const pts = Array.isArray(o.points) ? o.points.map((x) => str(x)) : [];
    if (!str(o.hook) || !str(o.close) || pts.filter(Boolean).length < n) return { ok: false, message: "The AI draft came back missing a part. Try again." };
    const tagsIn = o.tags && typeof o.tags === "object" ? (o.tags as Record<string, unknown>) : {};
    const tags: Record<string, string> = {};
    for (const k of ["hook", ...Array.from({ length: n }, (_, i) => `point${i + 1}`), "close"]) { const t = await strip(str(tagsIn[k], 60)); if (t) tags[k] = t; }
    const reviewIn = Array.isArray(o.review) ? (o.review as Record<string, unknown>[]) : [];
    const review = REVIEW_KEYS.flatMap((k) => {
      const r = reviewIn.find((x) => x && x.key === k);
      return r ? [{ key: k, label: REVIEW_LABEL[k], pass: r.pass === true, note: str(r.note, 300) }] : [];
    });
    const leftOut = (Array.isArray(o.leftOut) ? (o.leftOut as Record<string, unknown>[]) : []).map((x) => ({ what: str(x?.what, 300), why: str(x?.why, 300) })).filter((x) => x.what).slice(0, 10);
    const draft: RequestDraft = {
      runId: run.runId, atISO: new Date().toISOString(), by: opts.requestedBy,
      title: (await strip(str(o.title, 200))) || c.read.row.title,
      words: { hook: await strip(str(o.hook)), points: await Promise.all(pts.slice(0, n).map(strip)), close: await strip(str(o.close)) },
      tags, kept: await Promise.all(strs(o.kept, 10, 300).map(strip)),
      leftOut: await Promise.all(leftOut.map(async (x) => ({ what: await strip(x.what), why: await strip(x.why) }))),
      review: await Promise.all(review.map(async (r) => ({ ...r, note: await strip(r.note) }))),
      message: await strip(str(o.message, 3000)),
      steer, redo: [...(prev?.redo ?? []), ...(redoNote ? [redoNote] : [])],
    };
    await updateOfficeRecord(c.l.sugg.id, (off) => ({ ...off, draft }));
    if (prev) await setRunDisposition(prev.runId, "SUPERSEDED", opts.requestedBy);
    return { ok: true, draft };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The AI rewrite didn't work. Try again." };
  }
}

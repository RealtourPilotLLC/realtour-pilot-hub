// ---------------------------------------------------------------------------
// DRILL: the new script writer (Oct 22 2026, src/lib/scriptWriter), phases 1
// and 2 of the scripting plan, and the one-time fact cleanup.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct22-script-writer.ts
//
//    1. the model path: claude-opus-5-5, structured output, an explicit effort
//       per step, the system prompt cached, no forced tool_choice, no tools, no
//       prefill, no temperature, no thinking field, anthropic-version
//       unchanged, the fallback opt-in; a refusal, a max_tokens stop and a
//       refused beta handled
//    2. retrieval: the topic's call read in full; passages found verbatim with
//       the lines around them; an invented quote dropped; internal talk and
//       our own lines held back; an older call's window found by the topic's
//       words
//    3. facts: a client-spoken unreviewed fact reaches the writer (labelled),
//       a TEAM fact, a production preference and a fact Jordan said do not
//    4. voice: a discontinued series is skipped; the same-subject script comes
//       first; each example says why it is there
//    5. the topic description is labelled our assumption; the title a label
//    6. the brief is saved with the version, its quotes verified
//    7. five hooks asked for; the best accurate one kept word for word; the
//       others kept as alternates
//    8. the review: a 124-word draft is trimmed by the trim pass and passes;
//       a must-fix failure runs two fix rounds and arrives FLAGGED; a draft
//       that stays long is flagged "A bit long: needs a fix", never shared
//    9. the close rule and the length aim in the writer, review and brief
//   10. a shared script is never touched by the review loop
//   11. the switch off: the writer the hub had keeps its model and request
//   12. a person's revision keeps the whole instruction
//   13. the fact cleanup: the dry run writes nothing and sorts a fixture set
//       correctly; --apply is compare-and-set, idempotent and resumable
//   14. the listening fix (Oct 22 2026, LISTENING.md): with "Jordan Spackman
//       TEST" enrolled, Jordan's lines still reach the writer and only a real
//       other client's turn goes; her older calls are read by HER words in a
//       second retrieval; an accepted fact from an older month reaches the
//       writer, a month-bound one does not; the brief caps must-keep and never
//       keeps a live deal; a story's hook opens on her moment; a failed
//       re-hook starts the next round from the runner-up hook (the automatic
//       check and the offline run); no client's finals in any rule
//   15. v2.3, the craft fix (Oct 22 2026): hooks eligible on curiosity and
//       tension, ranked by curiosity + tension + specificity (her moment on a
//       tie when the proof is her story), the month's other openings in the
//       hooks step; hook_echo and the hedge re-hook; the proof is her story;
//       how she helps once, must-keep 3, never the invitation; the close rule,
//       generic_close and the close check at must-fix; the aim trim above 78
//       and the kept-longer guard; the jargon list; the craft block (a hook or
//       re-hook under 4 goes to the runner-up hook)
//   16. v2.3, the model map: each step's model and effort, nothing the 5.5
//       models refuse, the cached prefix of a second review round byte for
//       byte, and the cost of each model with cache reads and writes
//   17. v2.4, the calibration fix (Oct 22 2026), one section per fix, on the
//       real v2.3 retest examples (Erica Walker, John Collins, Marcee): keep
//       the good hook (a re-hook-only failure revises under the locked hook;
//       the runner-up's re-hook is never passed; the final pick prefers craft
//       and refuses over the cap); the gate (check 13 at a total of 19, a 3 a
//       flag, the picked hook's score advice, generic_close a flag that takes
//       a re-hook callback, "sleeping" stems to "sleep"); length (the aim trim
//       before the first review at 87 words, the trim in fix rounds, the part
//       budgets, a told story up to 110); the build-up in full sentences; the
//       live deal and the story she already filmed kept out of the proof
//   Sections 8 to 15 were re-pointed for v2.4 where the behaviour changed on
//   purpose (the aim trim now runs before the first review; a failed re-hook
//   no longer switches hooks; the hook's budget is 14 words).
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; the Anthropic API is
// faked at fetch with canned answers; nothing else may leave.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7781);
const STAFF = "dev@local";
installNextStubs();

// ---- canned words --------------------------------------------------------------
const VOCAB = "we look at your home the way a buyer will see it and decide what matters before you spend on things nobody notices so the work protects your sale".split(" ");
function words(n: number, offset = 0): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(VOCAB[(i + offset) % VOCAB.length]);
  return `${out.join(" ")}.`;
}
const CLIENT = "Dana Brooks TEST";
const TRANSCRIPT = [
  "Notes by Gemini",
  "Dana explained her pre-listing inspection process and her move from senior living (00:12:10).",
  "",
  "00:12:00",
  "Jordan Spackman: So what do people get wrong about repairs before they list?",
  `${CLIENT}: They look at it through their own eyes and their own preferences.`,
  `${CLIENT}: I always recommend a pre-listing inspection, it runs about $350 to $500, so we can make controlled repairs before the buyer has leverage.`,
  "Jordan Spackman: Love that.",
  `${CLIENT}: Buyers and their agents look at the roof and the major systems first.`,
  "00:14:30",
  "Jordan Spackman: Can we film on Tuesday next week instead?",
  `${CLIENT}: Erica Walker told me her listing on Elm went under contract in two days.`,
  `${CLIENT}: Tuesday works, and I uploaded the raw files to the Dropbox last night.`,
  "Jordan Spackman: Perfect.",
  "00:20:00",
  `${CLIENT}: I used to run sales and marketing for a retirement community before I got my license.`,
  `${CLIENT}: I wanted the freedom to build my own business, so I left.`,
  `${CLIENT}: Then the first-time buyers started calling, and they felt the need to be protected and cared for.`,
  "Jordan Spackman: Mhm.",
  `${CLIENT}: It's every bit as scary as when a senior is moving out of a home they've lived in for sixty years.`,
  "Jordan Spackman: That is a great way to put it. So what do you do for them?",
  `${CLIENT}: I explain their options and I fiercely protect their interests.`,
].join("\n");
const OLDER = [
  "00:05:00",
  "Jordan Spackman: Anything on prep this month?",
  `${CLIENT}: Fresh paint and rearranging furniture help a sale more than big repairs before listing.`,
  `${CLIENT}: Honestly the deep clean is the step people fight me on.`,
].join("\n");
const Q_INSPECTION = "I always recommend a pre-listing inspection, it runs about $350 to $500, so we can make controlled repairs before the buyer has leverage.";
const Q_PAINT = "Fresh paint and rearranging furniture help a sale more than big repairs before listing.";
const Q_SENIOR = "I used to run sales and marketing for a retirement community before I got my license.";
const Q_TURN = "Then the first-time buyers started calling, and they felt the need to be protected and cared for.";

const TOPIC_A = "The Repairs That Actually Protect Your Sale";
const TOPIC_B = "I Used to Think I Would Only Work With Seniors";
const TOPIC_C = "What Sellers Need to Know This Month";
const TOPIC_D = "A Topic the Old Writer Drafts";
const TOPIC_E = "Why the First Weekend Sets Your Price";
const TOPIC_F = "What I Check Before Every Listing";
const TOPIC_H = "Offline Topic That Passes After a Trim";
const TOPIC_I = "Offline Topic Whose Trim Loses Substance";
const TOPIC_G = "A Topic Whose Re-hook Fails Review";
const TOPIC_J = "Offline Topic Whose Re-hook Fails Once";
// v2.3 (the craft fix)
const TOPIC_K = "Offline Topic Drafted At Eighty Words";
const TOPIC_L = "Offline Topic Whose Trim Fails The Same Close";
const TOPIC_M = "A Topic Whose Trim Fails The Same Close";
const TOPIC_N = "A Topic Whose Re-hook Scores Two On Craft";
// v2.4 (the calibration fix)
const TOPIC_P = "Offline Topic Whose Re-hook Alone Fails";
const TOPIC_Q = "A Topic Whose Draft Had The Best Craft";
const TOPIC_R = "A Topic Whose Picked Hook Scores Two";
const TOPIC_S = "Offline Topic Whose Proof Was Filmed Before";
const HOOK_RUNNER_UP = "Fresh paint can do more than a new kitchen.";
const HOOK_THIRD = "Before you renovate, look at your house the way a buyer will.";
const CONCEPT_A = "Items buyers and inspectors flag every single time, and most are never cosmetic.";
// v2.4: 14 words, the hook's budget (rules.PART_WORDS); it was 15 ("... where your money should go.").
const HOOK_WIN = "The repairs you think your house needs might not be where your money goes.";
/** v2.4: what the fake writer answers for the hook on a fix when told to rewrite it on its own (code must copy the locked hook back). */
const HOOK_REWRITTEN = "A hook the writer rewrote on its own.";
const HOOK_WIN_B = "I loved working in senior living. So why did I leave?";

// ---- the fake Anthropic API ------------------------------------------------------
type Req = { step: string; body: Record<string, unknown>; headers: Record<string, string>; system: string; prompt: string };
const reqs: Req[] = [];
const ctl = {
  refuse: null as string | null,
  truncate: 0,
  rejectBeta: false,
  /** Per topic title fragment: the word counts of [rehook, buildup, payoff, close] for each successive writer answer. */
  sizes: new Map<string, number[][]>(),
  /** Per topic: a queue of review verdicts: the keys that fail. */
  reviews: new Map<string, string[][]>(),
  /** v2.3: per topic, a queue of craft scores the review gives (a part left out scores 4). */
  craft: new Map<string, Record<string, number>[]>(),
  /** v2.4: topics whose fix rounds answer with a hook of the writer's own (the lock must hold it). */
  rewriteHook: new Set<string>(),
  /** v2.4: per topic, fields merged into the fake brief (a proof, must-keep points). */
  brief: new Map<string, Record<string, unknown>>(),
};
const usage = { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// v2.3 (the model map): the fake answers as the model the request named, as the API does.
let answeringModel = "claude-opus-5-5";
const ok = (json: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "msg_drill", type: "message", role: "assistant", model: answeringModel, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(json) }], stop_reason: "end_turn", usage, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
const TOPICS: [string, string][] = [["A", TOPIC_A], ["B", TOPIC_B], ["C", TOPIC_C], ["E", TOPIC_E], ["F", TOPIC_F], ["H", TOPIC_H], ["I", TOPIC_I], ["G", TOPIC_G], ["J", TOPIC_J], ["K", TOPIC_K], ["L", TOPIC_L], ["M", TOPIC_M], ["N", TOPIC_N], ["P", TOPIC_P], ["Q", TOPIC_Q], ["R", TOPIC_R], ["S", TOPIC_S]];
const topicOf = (prompt: string) => TOPICS.find(([, title]) => prompt.includes(title))?.[0] ?? "?";
/** v2.3: a user message sent as blocks (the cache breakpoints) reads as the blocks' texts joined, like StepPrompt.prompt. */
const promptOf = (content: unknown) => (Array.isArray(content) ? (content as { text?: string }[]).map((b) => b.text ?? "").join("\n\n") : String(content ?? ""));
/** The hook's longest word: the fake writer's close calls it back (v2.3: a close with nothing from the hook is generic_close). */
const callbackWord = (hook: string) => hook.replace(/[^A-Za-z ]+/g, " ").split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), "").toLowerCase();
const stepOf = (system: string, prompt: string) =>
  /^You read call transcripts for ONE video topic/.test(system) ? "retrieval"
  : /^You write the TOPIC BRIEF/.test(system) ? "brief"
  : /^You write FIVE hooks/.test(system) ? "hooks"
  : /^You write ONE monthly personal-brand video script/.test(system) ? (/THE TRIM INSTRUCTION/.test(prompt) ? "trim" : /THE INDEPENDENT REVIEW'S FIX INSTRUCTION/.test(prompt) ? "fix" : /CURRENT VERSION \(v/.test(prompt) ? "revise" : "draft")
  : /^You are the INDEPENDENT CREATIVE REVIEWER/.test(system) ? "review"
  : /^You sort ONE real estate agent's recorded facts/.test(system) ? "cleanup"
  : /You are the quality judge/.test(system) ? "old-judge"
  : /writing ONE personal-branding video script/.test(system) ? "old-script"
  : "other";

function writerAnswer(t: string, step: string, prompt: string) {
  const queue = ctl.sizes.get(t) ?? [];
  const sz = queue.shift() ?? [15, 15, 15, 12];
  ctl.sizes.set(t, queue);
  // A redraft from the runner-up hook (Oct 22 2026) is answered with that hook, as the model is told to.
  const told = /THE CHOSEN HOOK \(use it word for word\): (.*)/.exec(prompt)?.[1];
  const hook = step !== "draft" && told ? told : step === "fix" && ctl.rewriteHook.has(t) ? HOOK_REWRITTEN : t === "B" ? HOOK_WIN_B : HOOK_WIN;
  // v2.3: the close calls back the hook the version opens with (the draft's is the chosen one the code puts back).
  const cb = callbackWord(told ?? hook);
  const tail = (n: number, offset: number) => `${words(Math.max(1, n - 1), offset).replace(/\.$/, "")} ${cb}.`;
  return {
    title: step === "draft" ? `Draft for ${t}` : `Revised ${t}`, hook: step === "draft" ? "A hook the code must replace with the winner." : hook,
    rehook: words(sz[0], 1), buildup: words(sz[1], 3), payoff: words(sz[2], 5), close: t === "A" ? `Before you change everything, ${tail(Math.max(2, sz[3] - 4), 7)}` : tail(sz[3], 9),
    closeType: "cta", captionCta: "Send me a message to plan your prep.", filmingNotes: "",
    rationale: { hook: "It names the belief a homeowner already has.", takeaway: "Spend where buyers look.", strategy: "Her seller pillar and her inspection process." },
    sourcesUsed: ["P1"], gaps: [], _promptHasHook: prompt.includes(hook),
  };
}

const fence = fenceFetch(async (url, init) => {
  if (url !== "https://api.anthropic.com/v1/messages") return null;
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const system = Array.isArray(body.system) ? String((body.system as { text?: string }[])[0]?.text ?? "") : String(body.system ?? "");
  const prompt = promptOf(((body.messages as { content?: unknown }[]) ?? [])[0]?.content);
  const step = stepOf(system, prompt);
  reqs.push({ step, body, headers, system, prompt });
  answeringModel = typeof body.model === "string" ? body.model : "claude-opus-5-5";
  if (ctl.rejectBeta && headers["anthropic-beta"]) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: not available for this organization" } }), { status: 400, headers: { "content-type": "application/json" } });
  if (ctl.refuse && ctl.refuse === step) { ctl.refuse = null; return new Response(JSON.stringify({ id: "msg_r", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, usage }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (ctl.truncate > 0) { ctl.truncate--; return new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens", usage }), { status: 200, headers: { "content-type": "application/json" } }); }
  const t = topicOf(prompt);
  switch (step) {
    case "retrieval":
      return ok({
        overview: "She explained her inspection process and her move from senior living.",
        passages: [
          { sourceId: "c1", speaker: "client", kind: "process", quote: Q_INSPECTION, forViewer: true, reason: "", why: "her process and the cost" },
          { sourceId: "c1", speaker: "client", kind: "fact", quote: "Tuesday works, and I uploaded the raw files to the Dropbox last night.", forViewer: false, reason: "scheduling and production logistics", why: "" },
          { sourceId: "c1", speaker: "client", kind: "fact", quote: "I uploaded the raw files to the Dropbox last night", forViewer: true, reason: "", why: "the model got this one wrong" },
          { sourceId: "c1", speaker: "client", kind: "opinion", quote: "I guarantee every single home I list sells within one week flat.", forViewer: true, reason: "", why: "invented: not in the call" },
          { sourceId: "c1", speaker: "us", kind: "agreement", quote: "So what do people get wrong about repairs before they list?", forViewer: true, reason: "", why: "Jordan's question" },
          { sourceId: "o1", speaker: "client", kind: "opinion", quote: Q_PAINT, forViewer: true, reason: "", why: "a contrast she drew before" },
          { sourceId: "c1", speaker: "client", kind: "story", quote: Q_SENIOR, forViewer: true, reason: "", why: "her career before real estate" },
          { sourceId: "c1", speaker: "client", kind: "story", quote: Q_TURN, forViewer: true, reason: "", why: "the turn in her story" },
        ],
      });
    case "brief":
      return ok({
        centralMessage: t === "B" ? "The same fear, the same protection: why first-time buyers found her." : "Spend on what buyers and their agents will judge, not on what you would change.",
        viewer: "A homeowner getting ready to sell", whyChosen: "Picked on her October call.", pillar: "Seller Strategy",
        whatSheSaid: ["P1", "P2", "P9"], mustKeep: [{ text: "She recommends a pre-listing inspection", source: "P1" }], herPhrases: [{ text: "fiercely protect their interests", source: "call at 00:20:00" }], optional: [{ text: "Fresh paint and furniture over renovation", source: "P2" }],
        excluded: [{ text: "Filming logistics", reason: "internal talk" }], contradictions: [], verifiedFacts: [{ text: "Pre-listing inspection costs $350 to $500", source: "P1" }],
        opinions: [{ text: "Paint beats a renovation", source: "P2" }], creativeIdeas: [], ourAssumptions: [{ text: CONCEPT_A, source: "our assumption" }], closeType: "cta", closeWhy: "An educational topic: a natural next step.",
        ...(ctl.brief.get(t) ?? {}),
      });
    case "hooks":
      return ok({ hooks: [
        // v2.3: tension scored too. The winner and the runner-up tie on curiosity + tension + specificity (12); the total breaks it.
        { text: "Sellers, your repairs list is probably wrong.", rehook: "Here is why.", lever: "belief", scores: { relevance: 5, curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "names the audience" },
        { text: "Your buyer will never see the kitchen you are about to redo.", rehook: "They look elsewhere.", lever: "contrast", scores: { relevance: 5, curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 5, accuracy: 3, herVoice: 5, payoffConnection: 5 }, note: "not quite what she said" },
        { text: t === "B" ? HOOK_WIN_B : HOOK_WIN, rehook: "Sometimes paint does more than a renovation.", lever: "belief", scores: { relevance: 5, curiosity: 4, tension: 4, specificity: 4, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "her own contrast" },
        { text: "Fresh paint can do more than a new kitchen.", rehook: "But not always.", lever: "contrast", scores: { relevance: 4, curiosity: 4, tension: 4, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 3 }, note: "" },
        { text: "Before you renovate, look at your house the way a buyer will.", rehook: "They start with the roof.", lever: "advice", scores: { relevance: 4, curiosity: 3, tension: 3, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "" },
      ] });
    case "draft": case "trim": case "fix": case "revise":
      return ok(writerAnswer(t, step, prompt));
    case "review": {
      const queue = ctl.reviews.get(t) ?? [];
      const failing = queue.shift() ?? [];
      ctl.reviews.set(t, queue);
      const keys = ["on_topic", "her_meaning", "hook", "rehook", "story", "substance", "payoff", "close", "her_voice", "claims", "length", "nothing_extra"];
      const cq = ctl.craft.get(t) ?? [];
      const low = cq.shift() ?? {};
      ctl.craft.set(t, cq);
      const craft = Object.fromEntries(["hook", "rehook", "buildup", "payoff", "close"].map((k) => [k, { score: low[k] ?? 4, note: `CRAFT NOTE ${k}: ${(low[k] ?? 4) < 4 ? "it only explains the hook" : "it does its job"}` }]));
      return ok({ checks: keys.map((key) => ({ key, pass: !failing.includes(key), reason: failing.includes(key) ? `REVIEW NOTE ${key}: the chronology is bent (she worked in senior living before real estate).` : "ok" })), craft, fixInstruction: failing.length || Object.keys(low).length ? "Put her senior-living career before her license, as she said it." : "", summary: failing.length ? "Not yet." : "Strong." });
    }
    case "cleanup": {
      const ids = [...prompt.matchAll(/^\[([^\]]+)\] \(([^)]*)\) (.*)$/gm)].map((m) => ({ id: m[1], body: m[3] }));
      return ok({ facts: ids.map(({ id, body }) => ({ id, cls: /again/i.test(body) ? "DROP" : /pre-listing|retirement/i.test(body) ? "SCRIPT" : /Tuesday|confidential detail/i.test(body) ? "SCRIPT" : "TEAM", reason: /again/i.test(body) ? "duplicate of the pre-listing inspection fact" : "sorted by the drill" })) });
    }
    case "old-script":
      return new Response(JSON.stringify({ id: "msg_o", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "tu1", name: "emit", input: { angle: { viewer: "v", belief: "b", stake: "s", angle: "a", clientTake: "c", payoff: "p" }, title: "Old writer draft", category: "Seller Strategy", hook: "An old writer hook for the drill.", points: [{ role: "re-hook", text: words(12) }, { role: "build-up", text: words(12, 2) }, { role: "payoff", text: words(12, 4) }], close: words(8, 6), captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [] } }], stop_reason: "tool_use", usage }), { status: 200, headers: { "content-type": "application/json" } });
    case "old-judge":
      return new Response(JSON.stringify({ id: "msg_j", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "tu2", name: "emit", input: { criteria: ["hook", "rehook", "buildup", "payoff", "close", "voice", "truth"].map((key) => ({ key, pass: true, note: "ok" })), fixInstruction: null } }], stop_reason: "tool_use", usage }), { status: 200, headers: { "content-type": "application/json" } });
    default:
      return ok({ result: "plain" });
  }
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const ai = await import("@/lib/integrations/ai");
  const { runAiJson } = await import("@/lib/aiRuns");
  const gen = await import("@/lib/contentGeneration");
  const pipe = await import("@/lib/scriptWriter/pipeline");
  const rules = await import("@/lib/scriptWriter/rules");
  const record = await import("@/lib/scriptWriter/record");
  const sources = await import("@/lib/scriptWriter/sources");
  const cleanup = await import("@/lib/scriptWriter/factCleanup");
  const prompts = await import("@/lib/scriptWriter/prompts");
  try {
    await saveSecret("ai", ["sk", "ant", "drill", "0000000000"].join("-"));
    const f = await buildContentMonth(prisma, {
      name: CLIENT, package: "Pro", monthKey: "2026-10",
      topics: [TOPIC_A, TOPIC_B, TOPIC_C, TOPIC_D, TOPIC_E, TOPIC_F, TOPIC_H, TOPIC_I, TOPIC_G, TOPIC_J, TOPIC_K, TOPIC_L, TOPIC_M, TOPIC_N, TOPIC_P, TOPIC_Q, TOPIC_R, TOPIC_S].map((title) => ({ title, selection: "SELECTED" as const, source: "ai" })),
    });
    const [tA, tB, tC, tD, tE, tF, tH, tI, tG, tJ, tK, tL, tM, tN, tP, tQ, tR, tS] = f.topicIds;
    // v2.4: the drill drafts more topics than one client's default 40 runs a day (drafts and revisions count toward it).
    await prisma.programAiQuota.create({ data: { scope: "ENROLLMENT", scopeRef: f.enrollmentId, period: "DAY", maxRuns: 200, setBy: "drill" } });
    // The listening fix (Oct 22 2026): production holds "Jordan Spackman TEST" enrolled beside real clients.
    // With the old filter that one row deleted every line Jordan said; a real other client still goes.
    const enroll = async (name: string) => { const cl = await prisma.client.create({ data: { name } }); await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Pro", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } }); return cl; };
    await enroll("Jordan Spackman TEST");
    await enroll("Erica Walker");
    // A real client row carrying a staff member's name (production's two real "Jordan Spackman" rows are Jordan).
    await prisma.teamMember.create({ data: { name: "Harrison Drillwell", email: "harrison.drill@example.test" } });
    await enroll("Harrison Drillwell");
    await prisma.contentTopic.update({ where: { id: tA }, data: { concept: CONCEPT_A, intendedMessage: "Inspectors flag the same things every time." } });
    await prisma.contentEnrollment.update({ where: { id: f.enrollmentId }, data: { overridesJson: JSON.stringify({ creative: { discontinued: [{ name: "Fairy God Realtor", by: "jordan", at: "2026-10-01T00:00:00.000Z", reason: "she stopped the series" }] } }) } });
    // The topic's call, confirmed, with its transcript; an older month's pasted transcript.
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: f.monthId, scheduledStart: new Date("2026-10-15T14:00:00Z"), status: "COMPLETED", matchState: "MATCHED", transcriptState: "ANALYZED" } });
    await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "drive", text: TRANSCRIPT, contentHash: `drill-${Date.now()}`, matchState: "CONFIRMED", recordedAt: new Date("2026-10-15T14:00:00Z") } });
    const feb = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-02", videosOwed: 4, status: "COMPLETED", transcriptText: OLDER, strategyCallAt: new Date("2026-02-05T15:00:00Z") } });
    // Facts.
    const fact = (d: Record<string, unknown>) => prisma.clientFact.create({ data: { clientId: f.clientId, enrollmentId: f.enrollmentId, category: "BRAND_PREFERENCE", source: "call", status: "PROPOSED", aiContext: "DENIED", ...d } as never, select: { id: true } });
    const fUnreviewed = await fact({ body: "Recommends the pre-listing inspection to every seller so repairs happen on her terms", category: "PROPOSED_CHANGE", speaker: "client", factDate: new Date("2026-10-15T14:30:00Z") });
    const fJordan = await fact({ body: "Jordan suggested a series about repairs that protect the sale", category: "PROPOSED_CHANGE", speaker: "jordan" });
    const fProduction = await fact({ body: "Prefers to film inspection videos on Tuesday mornings", category: "PRODUCTION_PREFERENCE", speaker: "client" });
    const fTeam = await fact({ body: "Wants her listing repair checklist mailed to past clients", category: "PROPOSED_CHANGE", speaker: "client", status: "ACCEPTED", aiContext: "DENIED", reviewedBy: cleanup.TEAM_REVIEWER });
    const fAccepted = await fact({ body: "Her husband Dan is a professional renovator who prices repairs on walkthroughs", category: "PROPOSED_CHANGE", source: "staff", status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: STAFF });
    // The listening fix: facts filed under an OLDER month (her migrated notes).
    const OLD_HISTORY = "Left senior living for real estate because she did not have total control over everything";
    const OLD_LOGISTICS = "Wants to film the February repair series at her office";
    const OLD_CLAIM = "Transitioned into real estate from a role as sales and marketing director";
    await fact({ body: OLD_HISTORY, category: "PROPOSED_CHANGE", source: "note_migration", status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: "ai-cleanup-oct22", scope: "MONTH", monthId: feb.id });
    await fact({ body: OLD_LOGISTICS, category: "PROPOSED_CHANGE", source: "note_migration", status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: "ai-cleanup-oct22", scope: "MONTH", monthId: feb.id });
    await fact({ body: OLD_CLAIM, category: "BRAND_PREFERENCE", source: "call", status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: STAFF });
    // Scripts: a discontinued series, a same-subject filmed script, an office-approved one on another subject.
    const histScript = async (title: string, body: string) => prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, title, body, source: "import", historical: true, status: "APPROVED", createdAt: new Date("2026-03-01T00:00:00Z") } });
    await histScript("Fairy God Realtor Tip #5", "Sellers, buyers notice the little repairs before they list and the roof too.");
    const same = await histScript("Why Pre-Listing Inspections Can Make Sellers More Money", "You fix the repairs that protect your sale. You use your own people. You control the cost.");
    await histScript("Why Honesty Matters More Than Winning", "I tell you the truth even when it is not what you want to hear.");
    await prisma.appSetting.create({ data: { key: pipe.WRITER_SWITCH_KEY, value: JSON.stringify({ on: true }) } });

    // =======================================================================
    c.head("1 · the model path (claude-opus-5-5, structured output, effort, no forced tool)");
    {
      const shape = ai.buildStructuredRequest({ system: "S", prompt: "P", schema: { type: "object" }, effort: "high", maxTokens: 9000 });
      const b = shape.body as Record<string, unknown> & { output_config: { effort: string; format: { type: string } }; system: { cache_control?: { type: string } }[]; messages: { role: string }[] };
      c.ok("model claude-opus-5-5", b.model === "claude-opus-5-5");
      c.ok("structured output: output_config.format json_schema, and the effort named", b.output_config?.format?.type === "json_schema" && b.output_config.effort === "high");
      c.ok("no tool_choice, no tools, no temperature, no thinking field", !("tool_choice" in b) && !("tools" in b) && !("temperature" in b) && !("thinking" in b));
      c.ok("one user message, no assistant prefill", b.messages.length === 1 && b.messages[0].role === "user");
      c.ok("the system prompt is cached (cache_control ephemeral)", b.system[0]?.cache_control?.type === "ephemeral");
      c.ok("the refusal fallback opt-in: claude-opus-5 with its beta header", JSON.stringify(b.fallbacks) === JSON.stringify([{ model: "claude-opus-5" }]) && shape.headers["anthropic-beta"] === "server-side-fallback-2026-06-01");

      const before = reqs.length;
      const r = await ai.aiStructuredWithUsage<{ result: string }>({ system: "drill", prompt: "drill", schema: { type: "object" }, effort: "medium", maxTokens: 4000 });
      const sent = reqs[before];
      c.ok("a call: the JSON read from the text block (thinking block first)", r.result.result === "plain" && r.model === "claude-opus-5-5", JSON.stringify(r.result));
      c.ok("…sent with anthropic-version 2023-06-01, unchanged", sent?.headers["anthropic-version"] === "2023-06-01", sent?.headers["anthropic-version"]);

      ctl.refuse = "other";
      let refused: Error | null = null;
      try { await ai.aiStructuredWithUsage({ system: "drill", prompt: "drill", schema: { type: "object" }, effort: "medium" }); } catch (e) { refused = e as Error; }
      c.ok("stop_reason refusal → AiRefusalError with the category, content never read", refused?.name === "AiRefusalError" && (refused as unknown as { category: string }).category === "cyber", refused?.message);
      ctl.refuse = "other";
      let runErr: Error | null = null;
      try { await runAiJson({ kind: "script_review", engine: "writer", effort: "high", promptKey: "drill-refusal", requestedBy: STAFF, unattended: false, system: "drill", prompt: "drill", schema: { type: "object" } }); } catch (e) { runErr = e as Error; }
      const refusedRun = await prisma.programAiRun.findFirst({ where: { promptKey: "drill-refusal" }, select: { status: true, error: true, model: true } });
      c.ok("…through the run ledger: FAILED, the reason kept, model recorded", runErr?.name === "AiRefusalError" && refusedRun?.status === "FAILED" && /declined/.test(refusedRun.error ?? "") && refusedRun.model === "claude-opus-5-5", JSON.stringify(refusedRun));

      ctl.truncate = 1;
      const b2 = reqs.length;
      const t = await ai.aiStructuredWithUsage<{ result: string }>({ system: "drill", prompt: "drill", schema: { type: "object" }, effort: "medium", maxTokens: 5000 });
      c.ok("stop_reason max_tokens → one retry with twice the room, then the answer; both attempts' usage counted", t.result.result === "plain" && reqs[b2].body.max_tokens === 5000 && reqs[b2 + 1].body.max_tokens === 10000 && t.usage.inputTokens === 2400, `${reqs[b2]?.body.max_tokens} → ${reqs[b2 + 1]?.body.max_tokens}`);

      ctl.rejectBeta = true;
      const b3 = reqs.length;
      const nb = await ai.aiStructuredWithUsage<{ result: string }>({ system: "drill", prompt: "drill", schema: { type: "object" }, effort: "low" });
      ctl.rejectBeta = false;
      c.ok("an account without the fallback beta: the same request once more without it", nb.result.result === "plain" && !!reqs[b3].headers["anthropic-beta"] && !reqs[b3 + 1].headers["anthropic-beta"] && !("fallbacks" in reqs[b3 + 1].body));
    }

    // =======================================================================
    c.head("2-7 · topic A: retrieval, facts, voice, assumptions, the brief, five hooks");
    ctl.sizes.set("A", [[40, 36, 26, 18], [16, 18, 14, 10]]); // the draft: 14 + 120 = 134 words; v2.4: trimmed before its first review to 14 + 58 = 72, every part inside its budget
    ctl.reviews.set("A", [[], []]);
    const before = reqs.length;
    const rA = await gen.generateScriptForTopic({ topicId: tA, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    const mine = reqs.slice(before);
    const step = (s: string) => mine.filter((r) => r.step === s);
    {
      const ret = step("retrieval")[0];
      c.ok("the retrieval step read the topic's call IN FULL (every line of it)", !!ret && ret.prompt.includes(Q_SENIOR) && ret.prompt.includes("Buyers and their agents look at the roof"), `${ret?.prompt.length} chars`);
      // Oct 22 2026 (the listening fix): the topic's call is read first; her words there choose the older windows,
      // read in a second retrieval that is told what she already said (this assertion used to read the first request).
      const ret2 = step("retrieval")[1];
      c.ok("…and an older call's window found by HER words, read in a second retrieval told what she already said", !!ret2 && ret2.prompt.includes(Q_PAINT) && /older call for 2026-02/.test(ret2.prompt) && !ret.prompt.includes(Q_PAINT) && /WHAT SHE ALREADY SAID ON THIS TOPIC'S CALL[\s\S]*I always recommend a pre-listing inspection/.test(ret2.prompt) && ret2.system === ret.system, `${step("retrieval").length} retrievals`);
      // v2.3, the model map (pipeline STEP_MODEL / STEP_EFFORT).
      const me = (r: Req | undefined) => `${r?.body.model}/${(r?.body.output_config as { effort?: string } | undefined)?.effort}`;
      c.ok("the model map: retrieval Haiku 5.5 medium, brief Sonnet 5.5 medium, hooks Opus 5.5 high, draft Sonnet 5.5 high, review Sonnet 5.5 medium, the trim Sonnet 5.5 high",
        me(ret) === "claude-haiku-5-5/medium" && me(step("retrieval")[1]) === "claude-haiku-5-5/medium" && me(step("brief")[0]) === "claude-sonnet-5-5/medium" && me(step("hooks")[0]) === "claude-opus-5-5/high" && me(step("draft")[0]) === "claude-sonnet-5-5/high" && step("review").every((r) => me(r) === "claude-sonnet-5-5/medium") && me(step("trim")[0]) === "claude-sonnet-5-5/high",
        ["retrieval", "brief", "hooks", "draft", "review", "trim"].map((s) => `${s}=${me(step(s)[0])}`).join(" "));
      const STEP_OF: Record<string, keyof typeof pipe.STEP_MODEL> = { retrieval: "retrieval", brief: "brief", hooks: "hooks", draft: "draft", review: "review", trim: "revise", fix: "revise", revise: "revise" };
      c.ok("every writer request: its step's model and effort exact (no date suffix), json_schema, no tool_choice, no temperature, top_p, top_k or thinking budget, version unchanged",
        mine.filter((r) => r.step !== "other").every((r) => r.body.model === pipe.STEP_MODEL[STEP_OF[r.step]] && (r.body.output_config as { effort: string }).effort === pipe.STEP_EFFORT[STEP_OF[r.step]] && !/\d{8}$/.test(String(r.body.model)) && (r.body.output_config as { format: { type: string } }).format.type === "json_schema" && !("tool_choice" in r.body) && !("temperature" in r.body) && !("top_p" in r.body) && !("top_k" in r.body) && !("thinking" in r.body) && !JSON.stringify(r.body).includes("budget_tokens") && r.headers["anthropic-version"] === "2023-06-01"), mine.map((r) => r.step).join(","));

      const v1 = await prisma.contentScriptVersion.findFirst({ where: { scriptId: rA.scriptId, versionNo: 1 } });
      const w = record.readWriter(v1?.validationJson);
      const P = w?.passages ?? [];
      c.ok("passages: the inspection quote kept, verbatim, with the lines around it", P.some((p) => p.quote === Q_INSPECTION && p.context.includes("through their own eyes") && p.context.includes("roof and the major systems") && p.time === "00:12:00"), JSON.stringify(P.map((p) => [p.id, p.time, p.quote.slice(0, 30)])));
      c.ok("…the older call's passage kept, labelled", P.some((p) => p.quote === Q_PAINT && /older call/.test(p.source)));
      c.ok("…an invented quote (not in the call) dropped", !P.some((p) => /guarantee/.test(p.quote)) && !w?.excludedPassages.some((p) => /guarantee/.test(p.quote)));
      c.ok("…and the lines around a kept passage never carry our internal talk", P.length > 0 && !P.some((p) => /Dropbox|raw files/.test(p.context)), JSON.stringify(P.map((p) => p.context.length)));
      c.ok("…scheduling and Dropbox talk held back, even where the model called it fine; Jordan's line is his, not hers", !P.some((p) => /Dropbox|Tuesday|get wrong/.test(p.quote)) && (w?.excludedPassages ?? []).filter((x) => /Dropbox/.test(x.quote)).length === 2 && (w?.excludedPassages ?? []).some((x) => /Realtour Pilot, not her/.test(x.reason)), JSON.stringify(w?.excludedPassages.map((x) => x.reason)));

      const brief = step("brief")[0]?.prompt ?? "";
      const draft = step("draft")[0]?.prompt ?? "";
      c.ok("a client-spoken fact nobody reviewed reaches the writer, labelled \"not reviewed yet\"", /Recommends the pre-listing inspection to every seller[^\n]*not reviewed yet/.test(draft) && /not reviewed yet/.test(brief));
      c.ok("…an accepted fact too", draft.includes("Her husband Dan is a professional renovator") && /renovator[^\n]*\(accepted\)/.test(draft));
      c.ok("a TEAM fact, a production preference and a fact Jordan said do not", !draft.includes("checklist mailed") && !draft.includes("Tuesday mornings") && !draft.includes("Jordan suggested a series"));
      c.ok("voice: no script of the discontinued series is shown as an example, anywhere", ![brief, draft, step("hooks")[0]?.prompt ?? ""].some((p) => /Fairy God Realtor Tip/.test(p)));
      c.ok("…and the guard tells the writer the series is discontinued", /DISCONTINUED: "Fairy God Realtor"/.test(draft));
      c.ok("…the same-subject filmed script comes first, labelled why", /HER EARLIER SCRIPTS ON THE SAME SUBJECT[\s\S]*Why Pre-Listing Inspections Can Make Sellers More Money \(a script from her filmed archive, same subject\)/.test(draft));
      c.ok("…each voice example says why it is there", /VOICE EXAMPLES[\s\S]*Why Honesty Matters More Than Winning \(a script from her filmed archive; her most recent example, no same-subject script on file\)/.test(draft), (/VOICE EXAMPLES[^\n]*\n[^\n]*/.exec(draft) ?? [""])[0]);
      void same;
      c.ok("the topic description is labelled OUR assumption, the title a label", /OUR ASSUMPTIONS ABOUT THIS TOPIC \(written by us or an AI; never a claim source, never her words\):\n- description: Items buyers and inspectors flag/.test(draft) && /TOPIC \(an organizing label, not spoken copy\): The Repairs That Actually Protect Your Sale/.test(draft));
      c.ok("…and the writer's rules say why (assumptions are never a claim source)", step("draft")[0]?.system.includes("OUR ASSUMPTIONS ARE NOT HER CLAIMS"));

      c.ok("the brief is saved with the version", !!w && /Spend on what buyers/.test(w.brief.centralMessage) && w.brief.closeType === "cta" && w.brief.ourAssumptions.some((a) => a.text === CONCEPT_A));
      c.ok("…what she said is the verified passages only (an id the brief made up is dropped)", w?.brief.whatSheSaid.length === 2 && w.brief.whatSheSaid[0].quote === Q_INSPECTION, JSON.stringify(w?.brief.whatSheSaid.map((x) => x.passageId)));
      c.ok("five hooks asked for", /Write exactly five hooks/.test(step("hooks")[0]?.prompt ?? "") && w?.hooks.length === 5);
      c.ok("the best ACCURATE hook kept word for word (a higher score with accuracy 3, and one opening \"Sellers,\", set aside)", v1?.hook === HOOK_WIN && w?.chosen === 2 && w.hooks[0].disqualified === "opens by naming the audience" && w.hooks[1].disqualified === "accuracy under 4", `${v1?.hook} · chosen ${w?.chosen}`);
      c.ok("…the other four kept as alternates; the draft was told the winner", (JSON.parse(v1?.alternateHooksJson ?? "[]") as string[]).length === 4 && draft.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_WIN}`));
      c.ok("the rationale is kept for the card", w?.rationale?.takeaway === "Spend where buyers look.");
    }

    // =======================================================================
    c.head("8a · a 134-word draft: v2.4 trims it BEFORE its first review (over the cap, so it is the cap trim too) → passed");
    {
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rA.scriptId }, orderBy: { versionNo: "asc" } });
      const j1 = (await import("@/lib/scriptJudgeRecord")).readJudge(vs[0].validationJson);
      c.ok("v1: 134 spoken words, never reviewed: sent to the trim before any review (v2.4)", vs[0].spokenWordCount === 134 && j1?.trimKind === "first" && !(j1.checks ?? []).length && mine.findIndex((r) => r.step === "trim") < mine.findIndex((r) => r.step === "review"), `${vs[0].spokenWordCount} words · ${j1?.state}/${j1?.trimKind}`);
      const trimP = step("trim")[0]?.prompt ?? "";
      c.ok("…one trim (no fix round for length alone), told it is over the cap and must end at 110 or fewer", step("trim").length === 1 && step("fix").length === 0 && /LENGTH TRIM: this version is 134 spoken words[\s\S]*over the 110-word cap[\s\S]*Trim it toward 65 to 75 spoken words[\s\S]*it must end at 110 words or fewer/.test(trimP), trimP.slice(trimP.indexOf("LENGTH TRIM"), trimP.indexOf("LENGTH TRIM") + 200));
      c.ok("…naming the brief's must-keep points, none of which may be dropped", /These must-keep points from the brief survive, in substance: "She recommends a pre-listing inspection"/.test(trimP) && /Never drop a must-keep point/.test(trimP));
      const last = vs[vs.length - 1];
      const jl = (await import("@/lib/scriptJudgeRecord")).readJudge(last.validationJson);
      c.ok("v2: trimmed to 72 words, then reviewed: passed, 13 of 13, marked trimmed (it was over the cap) and aim-trimmed", vs.length === 2 && last.spokenWordCount === 72 && jl?.state === "passed" && jl.trimmed === true && jl.aimTrimmed === true && !jl.aimTrimOf && rules.reviewHeadline(jl.checks ?? []) === "Creative review: 13 of 13 pass", `${last.spokenWordCount} · ${jl?.state} · ${rules.reviewHeadline(jl?.checks ?? [])}`);
      c.ok("…its brief carried forward, the change summary says it was trimmed before its first review", !!record.readWriter(last.validationJson)?.brief && /before its first review/.test(last.changeSummary ?? ""), last.changeSummary ?? "");
      const card = record.writerCardOf(last.validationJson);
      c.ok("the card: the review headline, the rationale, the brief", card?.review?.headline === "Creative review: 13 of 13 pass" && card.review.trimmed && !!card.rationale?.hook && card.brief.whatSheSaid.length === 2);
      c.ok("…the one review ran on the writer path, its own kind (script_review), on Sonnet 5.5 (v2.3), counted apart from the client cap", (await prisma.programAiRun.count({ where: { kind: "script_review", enrollmentId: f.enrollmentId, model: "claude-sonnet-5-5" } })) === 1);
    }

    // =======================================================================
    c.head("8b · a must-fix failure: two fix rounds, still failing → FLAGGED, never passed");
    ctl.sizes.set("B", [[14, 14, 14, 12], [14, 14, 13, 12], [14, 13, 14, 12]]); // v2.4: the hook is locked, so the fix rounds differ only where the writer changed a part
    ctl.reviews.set("B", [["her_meaning", "close"], ["her_meaning"], ["her_meaning"]]);
    const b0 = reqs.length;
    const rB = await gen.generateScriptForTopic({ topicId: tB, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineB = reqs.slice(b0);
      const fixes = mineB.filter((r) => r.step === "fix");
      c.ok("two fix rounds ran, each with the review's notes and the reviewer's instruction; a failed close is MUST FIX now (v2.3)", fixes.length === 2 && /MUST FIX:\n- 2\. Her meaning: REVIEW NOTE her_meaning[^\n]*\n- 8\. Close: REVIEW NOTE close/.test(fixes[0].prompt) && /Put her senior-living career before her license/.test(fixes[0].prompt) && !/ALSO IMPROVE IF YOU CAN[\s\S]*8\. Close/.test(fixes[0].prompt), String(fixes.length));
      c.ok("…three reviews, no trim (it was never over the cap)", mineB.filter((r) => r.step === "review").length === 3 && mineB.filter((r) => r.step === "trim").length === 0, mineB.map((r) => r.step).join(","));
      c.ok("…v2.4: the hook never failed, so each fix round is a revision with the hook LOCKED, never a redraft", fixes.every((r) => /KEEP EXACTLY \(copied back word for word after you answer; return them unchanged\): Hook\./.test(r.prompt) && !/REDRAFT RULES/.test(r.prompt)));
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: rB.scriptId } });
      const cur = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: s.currentVersionId! } });
      const j = (await import("@/lib/scriptJudgeRecord")).readJudge(cur.validationJson);
      c.ok("it arrives FLAGGED, with the failing check named", j?.state === "flagged" && (j.checks ?? []).some((x) => x.key === "her_meaning" && !x.pass && x.level === "must-fix"), j?.state);
      const card = record.writerCardOf(cur.validationJson);
      c.ok("the card says so: 12 of 13 pass, the must-fix check and its reason", card?.review?.headline === "Creative review: 12 of 13 pass" && /Still failing a must-fix check/.test(card.review.note ?? "") && card.review.failing.some((x) => x.n === 2 && x.level === "must-fix"), `${card?.review?.headline} · ${JSON.stringify(card?.review?.failing)} · ${cur.spokenWordCount}w`);
      c.ok("…sorted first in the review queue (flagged), and still waiting for Jordan", (await import("@/lib/scriptJudgeRecord")).judgeFlagged(j) && cur.status === "INTERNAL_REVIEW" && !s.approvedVersionId && !s.sharedVersionId);
    }

    // =======================================================================
    c.head("8c · a draft that stays long: trimmed (before its first review, v2.4), fixed twice, still over 110 → flagged \"A bit long: needs a fix\", never shared");
    ctl.sizes.set("C", [[40, 36, 26, 18], [36, 36, 26, 18], [36, 34, 26, 18], [35, 34, 26, 16]]);
    ctl.reviews.set("C", [[], [], [], []]);
    const c0 = reqs.length;
    const rC = await gen.generateScriptForTopic({ topicId: tC, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineC = reqs.slice(c0);
      c.ok("the trim pass once, then two fix rounds (each told to trim), then no more", mineC.filter((r) => r.step === "trim").length === 1 && mineC.filter((r) => r.step === "fix").length === 2 && mineC.filter((r) => r.step === "fix").every((r) => /it must end at 110 words or fewer/.test(r.prompt)));
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: rC.scriptId } });
      const cur = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: s.currentVersionId! } });
      const j = (await import("@/lib/scriptJudgeRecord")).readJudge(cur.validationJson);
      const label = rules.lengthLabel(cur.spokenWordCount ?? 0);
      c.ok("flagged, over the cap, and the card's length line reads \"A bit long: needs a fix\" with its seconds", j?.state === "flagged" && (cur.spokenWordCount ?? 0) > 110 && label?.band === "over" && /^A bit long: needs a fix \(\d+ words, about \d+ seconds; the cap is 110\)/.test(label.text), `${cur.spokenWordCount} · ${label?.text}`);
      const releases = await prisma.contentScriptRelease.count({ where: { scriptId: rC.scriptId } });
      c.ok("never shared: no approval, no release, nothing in the portal", !s.sharedVersionId && !s.approvedVersionId && releases === 0 && !s.clientVisible);
      c.ok("the one-press fix sends the trim instruction (the card's button)", rules.trimInstruction(124).includes("124 spoken words") && rules.trimInstruction(124).includes("Never make it dry or incomplete") && rules.isLengthTrimInstruction(rules.trimInstruction(124)));
    }

    // =======================================================================
    c.head("8d · the aim made real (v2.4): an 87-word draft (Sonnet's average) is trimmed toward 65 to 75 BEFORE its first review → 72 words, passed");
    ctl.sizes.set("E", [[20, 22, 18, 13], [14, 18, 14, 12]]);
    ctl.reviews.set("E", [[]]);
    const e0 = reqs.length;
    const rE = await gen.generateScriptForTopic({ topicId: tE, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineE = reqs.slice(e0);
      const draftP = mineE.find((r) => r.step === "draft")?.prompt ?? "";
      c.ok("the draft prompt asks for about 68 spoken words (v2.3), plainly, with the must-keep points as the only things that must survive", draftP.includes("Write the script in about 68 spoken words (55 to 85; 110 is the hard cap). The brief's must-keep points are the only things that must survive"));
      const trims = mineE.filter((r) => r.step === "trim");
      c.ok("one trim toward 65 to 75 (not a cap trim), its must-keep points named", trims.length === 1 && /LENGTH TRIM: this version is 87 spoken words/.test(trims[0].prompt) && /Trim it toward 65 to 75 spoken words \(the aim is 55 to 85\)/.test(trims[0].prompt) && !/over the 110-word cap/.test(trims[0].prompt) && /"She recommends a pre-listing inspection"/.test(trims[0].prompt));
      c.ok("…in this order: draft, trim, ONE review (no review of the 87-word draft), no fix round", mineE.filter((r) => ["draft", "trim", "review", "fix"].includes(r.step)).map((r) => r.step).join(",") === "draft,trim,review", mineE.map((r) => r.step).join(","));
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rE.scriptId }, orderBy: { versionNo: "asc" } });
      const jl = (await import("@/lib/scriptJudgeRecord")).readJudge(vs[vs.length - 1].validationJson);
      c.ok("87 → 72 words: the trimmed version is current and passed, said to be trimmed before its first review", vs.length === 2 && vs[0].spokenWordCount === 87 && vs[1].spokenWordCount === 72 && jl?.state === "passed" && jl.aimTrimmed === true && !jl.trimmed && /Trimmed toward 65 to 75 words by the creative review before its first review/.test(vs[1].changeSummary ?? ""), `${vs.map((v) => v.spokenWordCount).join(" → ")} · ${vs[1]?.changeSummary}`);
      const j0 = (await import("@/lib/scriptJudgeRecord")).readJudge(vs[0].validationJson);
      c.ok("…the 87-word draft carries no review at all (it never reached one)", !!j0 && !(j0.checks ?? []).length && j0.trimKind === "first", JSON.stringify(j0));
    }

    // =======================================================================
    c.head("8e · a trim that drops a must-keep point is undone: the longer passing version stands, the advisory flag stays");
    // v2.4: the draft (69 words) is reviewed straight away and fails; fix 1 comes back at 96 and passes; the aim trim of
    // that passing version (69) drops a must-keep point, so the 96-word version stands.
    ctl.sizes.set("F", [[14, 14, 14, 13], [24, 24, 20, 14], [14, 14, 14, 13]]);
    ctl.reviews.set("F", [["her_meaning"], [], ["substance"]]);
    const rF = await gen.generateScriptForTopic({ topicId: tF, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rF.scriptId }, orderBy: { versionNo: "asc" } });
      const head = await prisma.contentScript.findUniqueOrThrow({ where: { id: rF.scriptId } });
      const cur = vs.find((v) => v.id === head.currentVersionId)!;
      const jr = (await import("@/lib/scriptJudgeRecord")).readJudge;
      c.ok("v1 69 failed → v2 (fix 1) 96 passed → v3 trimmed to 69 failed Enough substance → v4 = v2 again, current", vs.length === 4 && vs.map((v) => v.spokenWordCount).join(",") === "69,96,69,96" && cur.id === vs[3].id && cur.body === vs[1].body, vs.map((v) => `v${v.versionNo}:${v.spokenWordCount}`).join(" "));
      c.ok("…v4 carries v2's passing review, marked trimmed; v3 is flagged with the reason", jr(cur.validationJson)?.state === "passed" && jr(cur.validationJson)?.aimTrimmed === true && jr(vs[2].validationJson)?.state === "flagged" && /dropped a must-keep point; v2 is kept/.test(jr(vs[2].validationJson)?.error ?? ""));
      const card = record.writerCardOf(cur.validationJson);
      c.ok("the card says why the longer version stands, and the length line keeps its advice", /Kept v2 \(96 words, about 44 seconds\): the trim toward 65 to 75 words dropped a must-keep point, so the longer passing version stands\. "Longer than the 55 to 85 aim" stays as advice\.$/.test(card?.lengthNote ?? "") && rules.lengthBand(96) === "long" && /Longer than the 55 to 85 aim/.test(rules.lengthLabel(96)?.text ?? ""), card?.lengthNote ?? "none");
    }

    // =======================================================================
    c.head("8f · the same on a person's \"Fix with AI\" / revise: a trim that loses substance comes back; one that keeps it stands");
    {
      const head0 = await prisma.contentScript.findUniqueOrThrow({ where: { id: rF.scriptId } });
      const before = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: head0.currentVersionId! } });
      ctl.sizes.set("F", [[16, 14, 14, 13], [16, 14, 14, 13]]);
      ctl.reviews.set("F", [["substance"], []]);
      const p0 = reqs.length;
      await gen.reviseScript(rF.scriptId, rules.trimInstruction(96, ["She recommends a pre-listing inspection"]), STAFF, "REVISION");
      const steps1 = reqs.slice(p0).map((r) => r.step);
      const head1 = await prisma.contentScript.findUniqueOrThrow({ where: { id: rF.scriptId } });
      const cur1 = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: head1.currentVersionId! } });
      c.ok("the press: one trim by the writer, reviewed straight away", steps1.join(",") === "trim,review", steps1.join(","));
      c.ok("…it dropped a must-keep point, so the 96-word version is current again", cur1.body === before.body && cur1.spokenWordCount === 96 && cur1.id !== before.id);
      const p1 = reqs.length;
      await gen.reviseScript(rF.scriptId, rules.trimInstruction(96, ["She recommends a pre-listing inspection"]), STAFF, "REVISION");
      const head2 = await prisma.contentScript.findUniqueOrThrow({ where: { id: rF.scriptId } });
      const cur2 = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: head2.currentVersionId! } });
      c.ok("pressed again, the trim keeps its substance: 71 words, passed, current", reqs.slice(p1).map((r) => r.step).join(",") === "trim,review" && cur2.spokenWordCount === 71 && (await import("@/lib/scriptJudgeRecord")).readJudge(cur2.validationJson)?.state === "passed", `${cur2.spokenWordCount}`);
    }

    // =======================================================================
    c.head("8g · draftOffline (the retro test) takes the same steps, writes no script");
    {
      ctl.sizes.set("H", [[26, 24, 20, 13], [18, 18, 16, 10]]);
      ctl.reviews.set("H", [[]]);
      const off = await pipe.draftOffline({ topicId: tH, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: 97 → one trim toward 65 to 75 before its first review (v2.4: the draft is never reviewed) → 76 words, passed", off.state === "passed" && off.attempts.map((a) => `${a.label}:${a.words}:${a.review ? "reviewed" : "not reviewed"}`).join(",") === "draft:97:not reviewed,trim to aim:76:reviewed" && off.final.words === 76 && !off.keptLonger, off.attempts.map((a) => `${a.label}:${a.words}`).join(","));
      ctl.sizes.set("I", [[14, 14, 14, 13], [24, 24, 20, 14], [14, 14, 14, 13]]);
      ctl.reviews.set("I", [["her_meaning"], [], ["substance"]]);
      const offI = await pipe.draftOffline({ topicId: tI, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: a trim of a passing fix round that loses substance → the 96-word fix 1 is the result, with the note", offI.state === "passed" && offI.keptLonger && offI.final.words === 96 && offI.final.label === "fix 1" && /Kept fix 1 \(96 words/.test(offI.final.note ?? ""), `${offI.final.label}:${offI.final.words} · ${offI.attempts.map((a) => `${a.label}:${a.words}`).join(",")}`);
      c.ok("…and nothing was written for either topic but AI run rows", (await prisma.contentScript.count({ where: { topicId: { in: [tH, tI] } } })) === 0);
    }

    // =======================================================================
    c.head("9b · her material, our wording; the whole call; Jordan's craft rules; the insight and how she helps");
    {
      const lines = (await import("@/lib/scriptWriter/passages")).segmentTranscript(TRANSCRIPT);
      const P = await import("@/lib/scriptWriter/passages");
      const range = P.locateQuote(lines, Q_TURN)!;
      const ctxText = P.contextAround(lines, range);
      c.ok("a passage window finishes her thought past the listener's \"Mhm.\" and takes the next turn with her answer", !!range && ctxText.includes("every bit as scary as when a senior is moving out of a home") && ctxText.includes("I fiercely protect their interests"), ctxText.slice(-160));
      const wB = record.readWriter((await prisma.contentScriptVersion.findFirst({ where: { scriptId: rB.scriptId, versionNo: 1 } }))?.validationJson);
      c.ok("…so the stored passage for the turn carries the central line too", (wB?.passages ?? []).some((p) => p.quote === Q_TURN && p.context.includes("every bit as scary")));
      const briefReq = reqs.find((r) => r.step === "brief" && r.prompt.includes(TOPIC_B));
      const reviewReq = reqs.find((r) => r.step === "review" && r.prompt.includes(TOPIC_B));
      c.ok("the brief and the review are given THE FULL CALL to check what she said", !!briefReq && /THE FULL CALL \(to check what she said, anywhere in it/.test(briefReq.prompt) && briefReq.prompt.includes("every bit as scary") && !!reviewReq && /THE FULL CALL/.test(reviewReq.prompt) && reviewReq.prompt.includes("Buyers and their agents look at the roof"));
      c.ok("brief rules: the insight plus how she helps (not a fun fact); must-keep are POINTS; her real reason is never \"biography\"; check the whole call", prompts.BRIEF_SYSTEM.includes("the INSIGHT plus HOW SHE HELPS") && prompts.BRIEF_SYSTEM.includes("Not a fun fact about her (who her favorite clients are") && prompts.BRIEF_SYSTEM.includes("the POINTS the script cannot lose") && prompts.BRIEF_SYSTEM.includes("never excluded as \"biography\"") && prompts.BRIEF_SYSTEM.includes("CHECK AGAINST THE WHOLE CALL"));
      c.ok("…and her best short phrases are kept apart (herPhrases), stored with the brief", wB?.brief.herPhrases?.[0]?.text === "fiercely protect their interests");
      for (const [name, sys] of [["writer", prompts.WRITER_SYSTEM], ["brief", prompts.BRIEF_SYSTEM], ["hooks", prompts.HOOKS_SYSTEM], ["review", prompts.REVIEW_SYSTEM]] as const) {
        c.ok(`${name}: her material, our wording, and Jordan's craft rules (story progression, her ACTUAL reason, the insight, educational contrast)`, sys.includes("HER MATERIAL, OUR WORDING") && sys.includes("Never paste her spoken sentences") && sys.includes("her ACTUAL reason for the change") && sys.includes("the insight that connects her past to the viewer's need") && sys.includes("meaningful contrast"));
      }
      c.ok("close: a callback to the hook, then a warm invitation (the default), a callback alone only for a story with no service angle", rules.CLOSE_RULE.includes("a warm invitation that names THIS video's specific next step") && rules.CLOSE_RULE.includes("\"cta\" (the default)") && rules.CLOSE_RULE.includes("only when the video is purely a story with no service angle") && prompts.REVIEW_SYSTEM.includes("a warm invitation that names this video's specific next step in her voice"));
      c.ok("review: transcript sentences pasted in fail her voice; a faithful paraphrase is supported; a fun fact is not a payoff", prompts.REVIEW_SYSTEM.includes("Her transcript sentences pasted in (rambling, filler, restarts) fail") && prompts.REVIEW_SYSTEM.includes("a faithful paraphrase is supported") && prompts.REVIEW_SYSTEM.includes("a fun fact about her (who her favorite clients are, a hobby, an award) is not a payoff"));
      const pasted = rules.hardNumbers({ hook: "I loved working in senior living.", points: [{ role: "re-hook", text: "I used to run sales and marketing for a retirement community before I got my license." }], close: "Let's talk." }, TRANSCRIPT);
      const phrase = rules.hardNumbers({ hook: "I loved working in senior living.", points: [{ role: "payoff", text: "Both needed someone to explain their options and fiercely protect their interests." }], close: "Let's talk." }, TRANSCRIPT);
      c.ok("code: a sentence pasted from the call (11 words or more in a row) fails Sounds like her, must-fix; her short phrase does not", pasted.findings.some((x) => x.key === "pasted" && x.level === "must-fix") && !phrase.findings.some((x) => x.key === "pasted"), JSON.stringify(pasted.findings.map((x) => x.key)));
      c.ok("…and it counts against check 9 at must-fix level", (() => { const m = rules.mergeReview([{ key: "her_voice", pass: true, reason: "ok" }], pasted.findings, 40).find((x) => x.key === "her_voice"); return !!m && !m.pass && m.level === "must-fix"; })());
      c.ok("retrieval: whole thoughts, and a reader's summary is never her words", prompts.RETRIEVAL_SYSTEM.includes("Return WHOLE THOUGHTS") && prompts.RETRIEVAL_SYSTEM.includes("not her words"));
    }

    // =======================================================================
    c.head("9 · the close rule and the length aim, in the writer, the review and the brief");
    {
      const sys = prompts.WRITER_SYSTEM;
      c.ok("writer: the close rule (a callback, then a warm invitation by default; a callback alone where the story has no service angle); the old caption-only rule gone", sys.includes(rules.CLOSE_RULE) && sys.includes("\"cta\" (the default)") && sys.includes("\"callback\": only when the video is purely a story") && !/contact ask goes in the caption|memorable final line/i.test(sys));
      c.ok("writer: about 68 words (v2.3) inside 55 to 85, cap 110, never dry or incomplete", sys.includes("write about 68 spoken words") && sys.includes("inside the 55 to 85 range") && sys.includes("110 spoken words is the hard cap") && sys.includes("Never make it dry or incomplete"));
      c.ok("review: 86 to 110 is advice only; over 110 is must-fix", prompts.REVIEW_SYSTEM.includes("86 to 110 is advice only") && prompts.REVIEW_SYSTEM.includes("Over 110 words is must-fix"));
      c.ok("brief: closeType cta or callback, decided per message", prompts.BRIEF_SYSTEM.includes("closeType") && (prompts.BRIEF_SCHEMA as { properties: { closeType: { enum: string[] } } }).properties.closeType.enum.join() === "cta,callback");
      const l = rules.lengthCheck(96), a = rules.lengthCheck(80), s = rules.lengthCheck(40);
      c.ok("96 words: \"Longer than the 55 to 85 aim\", a flag, never must-fix", !l.pass && l.level === "flag" && /Longer than the 55 to 85 aim/.test(l.reason));
      c.ok("80 words passes; 40 words passes the length check (substance guards dry or incomplete)", a.pass && s.pass);
      const h = rules.hardNumbers({ hook: "Sellers, mortgage rates are up 7% and that changes everything", points: [{ role: "re-hook", text: "Know your buyer avatar — it matters (10 seconds)." }], close: "Let's talk." }, "she talked about her inspection process");
      const keys = h.findings.map((x) => x.key).sort().join(",");
      c.ok("hard numbers by code: audience opener, dash, duration note, a figure and a market claim she never made, jargon, and (v2.3) a close with nothing from the hook", keys === "audience_vocative,dash,duration,generic_close,jargon,market_claim,market_claim", keys);
    }

    // =======================================================================
    c.head("10 · a script already shared with the client is never touched by any of this");
    {
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: rA.scriptId } });
      const sharedId = s.currentVersionId!;
      await prisma.contentScriptVersion.update({ where: { id: sharedId }, data: { status: "SHARED", sharedAt: new Date() } });
      await prisma.contentScript.update({ where: { id: rA.scriptId }, data: { sharedVersionId: sharedId, approvedVersionId: sharedId, sharedAt: new Date() } });
      const shared = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sharedId } });
      const s0 = reqs.length;
      let refused: Error | null = null;
      try { await gen.generateScriptForTopic({ topicId: tA, monthId: f.monthId, requestedBy: "cron", unattended: false, onlyIfUnscripted: true }); } catch (e) { refused = e as Error; }
      c.ok("the drafting sweep (onlyIfUnscripted) stops before any model call", refused?.name === "AlreadyDraftedError" && reqs.length === s0, refused?.message);
      ctl.sizes.set("A", [[14, 14, 14, 12]]);
      await gen.generateScriptForTopic({ topicId: tA, monthId: f.monthId, requestedBy: STAFF, unattended: false });
      const after = reqs.slice(s0).map((r) => r.step);
      c.ok("a person's explicit new draft: the retrieval and the brief reused, the hooks asked again (v2.3: this month's other openings changed), the draft; no review, fix or trim on a shared script", after.join(",") === "hooks,draft", after.join(","));
      const sharedAfter = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sharedId } });
      const headAfter = await prisma.contentScript.findUniqueOrThrow({ where: { id: rA.scriptId } });
      c.ok("the shared version is byte for byte what the client saw, and still the shared one", sharedAfter.body === shared.body && sharedAfter.status === "SHARED" && sharedAfter.validationJson === shared.validationJson && headAfter.sharedVersionId === sharedId);
      const newest = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: headAfter.currentVersionId! } });
      const jn = (await import("@/lib/scriptJudgeRecord")).readJudge(newest.validationJson);
      c.ok("…the new draft waits for a person, saying why the review did not run", newest.id !== sharedId && newest.status === "INTERNAL_REVIEW" && jn?.state === "not_checked" && /already shared with the client/.test(jn.error ?? ""));
    }

    // =======================================================================
    c.head("11 · the switch off: the writer the hub had keeps its model and its request");
    {
      await prisma.appSetting.update({ where: { key: pipe.WRITER_SWITCH_KEY }, data: { value: JSON.stringify({ on: false }) } });
      const d0 = reqs.length;
      await gen.generateScriptForTopic({ topicId: tD, monthId: f.monthId, requestedBy: STAFF, unattended: false });
      const old = reqs.slice(d0);
      c.ok("old path: claude-sonnet-4-6 with its forced emit tool, no output_config, no new steps", old.length >= 1 && old[0].step === "old-script" && old[0].body.model === "claude-sonnet-4-6" && !!old[0].body.tool_choice && !("output_config" in old[0].body) && !old.some((r) => ["retrieval", "brief", "hooks", "review"].includes(r.step)), old.map((r) => r.step).join(","));
      const p0 = reqs.length;
      let paused: Error | null = null;
      try { await pipe.prepareDraft({ topicId: tD, monthId: f.monthId, requestedBy: "cron", unattended: true, deadline: Date.now() + 5_000 }); } catch (e) { paused = e as Error; }
      c.ok("a sweep with too little clock left: the writer pauses before a step (WriterPausedError, skipped by the sweep), nothing sent", paused?.name === "WriterPausedError" && reqs.length === p0, paused?.message);
      c.ok("a pilot list: on for one enrollment only", await (async () => { await prisma.appSetting.update({ where: { key: pipe.WRITER_SWITCH_KEY }, data: { value: JSON.stringify({ on: true, enrollmentIds: ["someone-else"] }) } }); const off = await pipe.writerOnFor(f.enrollmentId); await prisma.appSetting.update({ where: { key: pipe.WRITER_SWITCH_KEY }, data: { value: JSON.stringify({ on: true, enrollmentIds: [f.enrollmentId] }) } }); return !off && (await pipe.writerOnFor(f.enrollmentId)); })());
    }

    // =======================================================================
    c.head("12 · a person's revision of a writer script: the writer revises it, the whole instruction kept");
    {
      const long = `Keep her inspection detail and the roof line. ${"Make the payoff land on what she does differently, in her words, and keep the close a natural next step. ".repeat(6)}END-OF-INSTRUCTION`;
      ctl.sizes.set("B", [[14, 14, 14, 12]]);
      const r0 = reqs.length;
      const v = await gen.reviseScript(rB.scriptId, long, STAFF, "REVISION");
      const rv = reqs.slice(r0);
      c.ok("revised by the writer (v2.3: Sonnet 5.5, high), the instruction whole in the prompt", rv.length === 1 && rv[0].step === "revise" && rv[0].prompt.includes("END-OF-INSTRUCTION") && rv[0].body.model === "claude-sonnet-5-5" && (rv[0].body.output_config as { effort: string }).effort === "high");
      const row = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: v.versionId } });
      const run = await prisma.programAiRun.findUniqueOrThrow({ where: { id: row.aiRunId! } });
      c.ok("the full instruction is on the run and on the version (not cut to 160 characters)", (JSON.parse(run.inputRefsJson ?? "{}") as { instructionText?: string }).instructionText === long && (JSON.parse(row.validationJson ?? "{}") as { instruction?: string }).instruction === long && long.length > 600, String(long.length));
      c.ok("…its brief carried forward for the card; no automatic review on a person's revision", !!record.readWriter(row.validationJson) && !(await import("@/lib/scriptJudgeRecord")).readJudge(row.validationJson));
    }

    // =======================================================================
    c.head("3b · the writer's fact rules, pure");
    {
      const rows = await prisma.clientFact.findMany({ where: { clientId: f.clientId }, select: { id: true, body: true, category: true, status: true, aiContext: true, confidential: true, conflictsWithId: true, reviewedBy: true, source: true, speaker: true, excerptJson: true, factDate: true, createdAt: true } });
      const got = sources.writerFactsFrom(rows, { names: [CLIENT, "Dana"], keywords: ["inspect"] });
      const bodies = got.map((x) => x.body).join(" | ");
      c.ok("kept: the client-spoken unreviewed fact and the accepted one", bodies.includes("Recommends the pre-listing inspection") && bodies.includes("husband Dan"));
      c.ok("left out: TEAM, production preference, Jordan's", !/checklist mailed|Tuesday mornings|Jordan suggested/.test(bodies), bodies);
      void fUnreviewed; void fJordan; void fProduction; void fTeam; void fAccepted;
    }

    // =======================================================================
    c.head("13 · the fact cleanup: dry run writes nothing; --apply is compare-and-set");
    {
      const other = await prisma.client.create({ data: { name: "Second Agent TEST" } });
      const cf = (d: Record<string, unknown>) => prisma.clientFact.create({ data: { clientId: other.id, category: "PROPOSED_CHANGE", source: "note_migration", status: "PROPOSED", aiContext: "DENIED", ...d } as never, select: { id: true } });
      const x = {
        script: await cf({ body: "Recommends a pre-listing inspection before every listing" }),
        prodAiSaysScript: await cf({ body: "Likes to film on Tuesday mornings", category: "PRODUCTION_PREFERENCE" }),
        dup: await cf({ body: "Recommends a pre-listing inspection again before listing" }),
        conf: await cf({ body: "A confidential detail about her divorce", confidential: true }),
        team: await cf({ body: "Invoices go to her assistant" }),
        retire: await cf({ body: "Worked in a retirement community before real estate" }),
        field: await cf({ body: "Photographer noticed she likes wide shots", source: "field" }),
        accepted: await cf({ body: "Already accepted fact", status: "ACCEPTED", aiContext: "ALLOWED" }),
      };
      const accepted = await prisma.clientFact.findUniqueOrThrow({ where: { id: x.accepted.id } });
      const conflict = await cf({ body: "Wants calmer music than before", conflictsWithId: accepted.id });
      const snap = async () => JSON.stringify(await prisma.clientFact.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, aiContext: true, reviewedBy: true, updatedAt: true } }));
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "drill-fact-cleanup-"));
      const beforeDb = await snap();
      const settingsBefore = await prisma.appSetting.count();
      const q0 = reqs.length;
      const dry = await cleanup.runFactCleanup({ db: prisma, classify: cleanup.aiClassifier("drill"), apply: false, outDir: out });
      const afterDb = await snap();
      c.ok("dry run: no fact and no setting changed (its only rows are the AI run ledger's)", beforeDb === afterDb && (await prisma.appSetting.count()) === settingsBefore);
      const cleanupReqs = reqs.slice(q0).filter((r) => r.step === "cleanup");
      c.ok("…sorted by the writer's model path (opus 5.5, medium), one call per client batch", cleanupReqs.length === 2 && cleanupReqs.every((r) => r.body.model === "claude-opus-5-5" && (r.body.output_config as { effort: string }).effort === "medium"), String(cleanupReqs.length));
      const cls = JSON.parse(fs.readFileSync(dry.classesPath, "utf8")) as Record<string, { cls: string; by: string }>;
      c.ok("SCRIPT: her process and her background", cls[x.script.id]?.cls === "SCRIPT" && cls[x.retire.id]?.cls === "SCRIPT");
      c.ok("TEAM by rule where the AI said SCRIPT: a production preference, a confidential fact", cls[x.prodAiSaysScript.id]?.cls === "TEAM" && cls[x.prodAiSaysScript.id]?.by === "rule" && cls[x.conf.id]?.cls === "TEAM" && cls[x.conf.id]?.by === "rule");
      c.ok("TEAM: billing; DROP: the duplicate, and by rule the fact in conflict", cls[x.team.id]?.cls === "TEAM" && cls[x.dup.id]?.cls === "DROP" && cls[conflict.id]?.cls === "DROP" && cls[conflict.id]?.by === "rule");
      c.ok("field reports and accepted facts are not part of it", !cls[x.field.id] && !cls[x.accepted.id]);
      const report = fs.readFileSync(dry.reportPath, "utf8");
      c.ok("the report: DRY RUN, per client, per class with samples, every DROP with its reason, and the effect on other AI features", /DRY RUN: nothing was changed/.test(report) && /\| Second Agent TEST \|/.test(report) && /## SCRIPT: 10 samples/.test(report) && /## Every DROP, with its reason[\s\S]*duplicate of the pre-listing inspection fact/.test(report) && /portal Profile prefill/.test(report));

      // Somebody edits one fact after it was sorted: --apply must skip it.
      await new Promise((r) => setTimeout(r, 15));
      await prisma.clientFact.update({ where: { id: x.team.id }, data: { body: "Invoices go to her assistant, Pat" } });
      const q1 = reqs.length;
      const ap = await cleanup.runFactCleanup({ db: prisma, classify: cleanup.aiClassifier("drill"), apply: true, outDir: out });
      const get = (id: string) => prisma.clientFact.findUniqueOrThrow({ where: { id } });
      const [s1, t1, c1, d1, k1, e1] = await Promise.all([get(x.script.id), get(x.prodAiSaysScript.id), get(x.conf.id), get(x.dup.id), get(conflict.id), get(x.team.id)]);
      c.ok("--apply: SCRIPT → accepted, AI context on, reviewed by ai-cleanup-oct22", s1.status === "ACCEPTED" && s1.aiContext === "ALLOWED" && s1.reviewedBy === "ai-cleanup-oct22");
      c.ok("TEAM → accepted, AI context unchanged (off), marked :team", t1.status === "ACCEPTED" && t1.aiContext === "DENIED" && t1.reviewedBy === "ai-cleanup-oct22:team" && c1.aiContext === "DENIED" && c1.confidential);
      c.ok("DROP → still waiting, the reason as its note", d1.status === "PROPOSED" && /^ai-cleanup-oct22 suggests dropping: duplicate/.test(d1.reviewedBy ?? "") && k1.status === "PROPOSED" && /conflicts with an accepted fact/.test(k1.reviewedBy ?? ""));
      c.ok("the fact edited after it was sorted was re-sorted (its classification was stale), not applied blind", reqs.slice(q1).filter((r) => r.step === "cleanup").length === 1 && e1.status === "ACCEPTED" && /Pat/.test(e1.body));
      // Compare-and-set proper: a change between sorting and writing is refused.
      const fresh = await cf({ body: "Recommends a pre-listing inspection to first-time sellers" });
      const sorter = cleanup.aiClassifier("drill");
      const race: typeof sorter = async (cl, facts, acc) => { const r = await sorter(cl, facts, acc); await prisma.clientFact.update({ where: { id: fresh.id }, data: { scope: "PERMANENT", body: "Edited while the cleanup ran" } }); return r; };
      const raced = await cleanup.runFactCleanup({ db: prisma, classify: race, apply: true, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "drill-fact-race-")), onlyClientId: other.id });
      const fr = await get(fresh.id);
      c.ok("compare-and-set: a fact changed between sorting and writing is skipped and listed, untouched", raced.skippedChanged.includes(fresh.id) && fr.status === "PROPOSED" && fr.reviewedBy === null && fr.body === "Edited while the cleanup ran");
      const before3 = await snap();
      const q2 = reqs.length;
      const again = await cleanup.runFactCleanup({ db: prisma, classify: cleanup.aiClassifier("drill"), apply: true, outDir: out, onlyClientId: f.clientId });
      c.ok("idempotent: a second --apply for an already cleaned client changes nothing and pays nothing", (await snap()) === before3 && reqs.slice(q2).filter((r) => r.step === "cleanup").length === 0 && again.total === 0, JSON.stringify(again.counts));
      const rows = await prisma.clientFact.findMany({ where: { clientId: other.id }, select: { id: true, body: true, category: true, status: true, aiContext: true, confidential: true, conflictsWithId: true, reviewedBy: true, source: true, speaker: true, excerptJson: true, factDate: true, createdAt: true } });
      const wf = sources.writerFactsFrom(rows, { names: ["Second Agent TEST"], keywords: [] }).map((y) => y.body).join(" | ");
      c.ok("after the cleanup the writer reads the SCRIPT facts, never TEAM or a DROP suggestion", wf.includes("Recommends a pre-listing inspection before every listing") && !/Tuesday|Invoices|again before/.test(wf), wf);
      void ap; void d1;
    }

    // =======================================================================
    c.head("14 · the listening fix (Oct 22 2026): Jordan's lines, her older calls and facts, a brief that chooses, the hook's job");
    {
      // --- 1. the name filter, end to end (topic A was drafted with "Jordan Spackman TEST" and "Erica Walker" enrolled)
      const ret = reqs.find((r) => r.step === "retrieval" && r.prompt.includes(TOPIC_A))?.prompt ?? "";
      c.ok("with \"Jordan Spackman TEST\" enrolled, every line Jordan said reaches the writer", ["So what do people get wrong about repairs", "Jordan Spackman: Love that.", "Can we film on Tuesday next week", "That is a great way to put it"].every((x) => ret.includes(x)));
      c.ok("…and the real other client's turn does not (her other lines around it stay)", !ret.includes("Erica Walker") && !ret.includes("went under contract in two days") && ret.includes("Tuesday works, and I uploaded"));
      const wA = record.readWriter((await prisma.contentScriptVersion.findFirst({ where: { scriptId: rA.scriptId, versionNo: 1 } }))?.validationJson);
      const briefA = reqs.find((r) => r.step === "brief" && r.prompt.includes(TOPIC_A))?.prompt ?? "";
      c.ok("the interviewer's question reaches the brief as WHAT WE ASKED (never as her words)", /WHAT WE ASKED[^\n]*\n- "So what do people get wrong about repairs before they list\?" \(strategy call/.test(briefA) && !(wA?.passages ?? []).some((p) => /get wrong/.test(p.quote)), (/WHAT WE ASKED[^\n]*\n[^\n]*/.exec(briefA) ?? [""])[0]);

      // --- 2. older calls by her words (pure, on a Marcee-shaped older export)
      const P = await import("@/lib/scriptWriter/passages");
      const OLD_EXPORT = [
        "📝 Notes", "", "Summary", "",
        "Jordan Spackman met with Marcee McMullen to discuss a work plan for her senior niche, her type of client and her life today.", "",
        "📖 Transcript", "", "Jan 26, 2026", "",
        "00:13:48", "",
        " Jordan Spackman: What do buyers tell you when they first call?Marcee McMullen: Buyers often share with me that they feel lost and kind of on their own or uncertain what to do.Jordan Spackman: Mhm.Marcee McMullen: Especially first-time home buyers. They like me because I protect them and I'm very honest with them.",
        "00:20:10", "",
        " Jordan Spackman: Okay, and the video style?Marcee McMullen: I like the bright edits we did, the music was great.Jordan Spackman: Okay.",
      ].join("\n");
      const seniorsPassages = [
        { quote: "In my case, what surprised me was how many first-time home buyers were attracted to me. And I think it's because um they felt the need to be protected and cared for.", context: "Jordan Spackman: how did you transition into real estate?" },
        { quote: "it's every bit as scary and difficult as when you're a senior that is moving out of a home", context: "Marcee McMullen: honest guidance for first-time buyers" },
      ];
      const kw = P.herKeywords({ title: "I Used to Think I Would Only Work With Seniors", passages: seniorsPassages });
      const aiKw = P.topicKeywords("I Used to Think I Would Only Work With Seniors", "The original assumption about a senior niche, the moment it changed and the type of client she works with today", "Make the advisor relatable to every type of client in life");
      const scrubbed = (await gen.scrubTranscriptForGeneration(f.clientId, OLD_EXPORT)).text;
      const docLines = P.segmentTranscript(P.transcriptBody(scrubbed));
      const wins = sources.olderWindowsFor([{ label: "older call for 2026-01", lines: docLines }], kw);
      c.ok("her keywords come from her words (first-time, protect, scary), never the generic AI words (work, type, life, make)", ["first", "protect", "scary"].every((k) => kw.includes(k)) && !["work", "type", "life", "make", "moment", "original"].some((k) => kw.includes(k)) && aiKw.length > 0, kw.join(","));
      c.ok("an old one-line-per-block export is read turn by turn, Jordan's turns kept, Gemini's notes skipped", docLines.some((l) => l.text.startsWith("Jordan Spackman: What do buyers tell you")) && docLines.some((l) => l.text.startsWith("Marcee McMullen: Buyers often share")) && !docLines.some((l) => /met with Marcee/.test(l.text)), docLines.map((l) => l.text.slice(0, 30)).join(" | "));
      c.ok("…and the window found by her words is her \"feel lost ... uncertain\" answer at 00:13:48, not the notes and not the video-style talk", wins.length >= 1 && wins[0].text.includes("feel lost") && wins[0].time === "00:13:48" && !wins.some((w) => /bright edits/.test(w.text) && !/feel lost/.test(w.text)), JSON.stringify(wins.map((w) => [w.time, w.score, w.text.slice(0, 60)])));
      const longLines = Array.from({ length: 30 }, (_, i) => ({ i, text: i === 22 ? "Marcee McMullen: the pre-listing inspection protects the seller and the inspection cost is small" : `Marcee McMullen: filler line number ${i} about nothing in particular at all, padded out to some length.`, time: i >= 20 ? "00:53:00" : "00:50:00", speaker: "Marcee McMullen" }));
      const centred = P.keywordWindows(longLines, ["inspection", "protect", "cost", "small"], { radius: 12, max: 1, maxChars: 500 });
      c.ok("a long window is cut AROUND its best line, with that line's time", centred.length === 1 && centred[0].text.includes("pre-listing inspection protects") && centred[0].time === "00:53:00", centred[0]?.text.slice(0, 80));

      // --- 3. her durable facts from older months (topic A's draft prompt)
      const draftA = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_A))?.prompt ?? "";
      c.ok("an accepted fact filed under an older month, about her, reaches the writer", draftA.includes(OLD_HISTORY));
      c.ok("…a month-bound one (that month's filming plan) does not", !draftA.includes(OLD_LOGISTICS));
      c.ok("…and a brand-preference fact that is a claim about her is labelled sayable, not \"never a line to say\"", new RegExp(`${OLD_CLAIM}[^\\n]*about her, so it can be said`).test(draftA) && !new RegExp(`${OLD_CLAIM}[^\\n]*never a line to say`).test(draftA));
      c.ok("isDurableFact / isDirectionFact (pure)", sources.isDurableFact({ body: OLD_HISTORY, category: "PROPOSED_CHANGE" }) && !sources.isDurableFact({ body: "Next month she wants the open house series", category: "PROPOSED_CHANGE" }) && !sources.isDurableFact({ body: "Decided on three repair videos", category: "DECISION" }) && sources.isDirectionFact("Her brand voice is fun and honest") && !sources.isDirectionFact(OLD_CLAIM));

      // --- 4. the brief chooses (pure)
      const six = ["the belief", "reason one", "reason two", "her process", "the contrast", "the invitation"].map((text, i) => ({ text, source: `P${i + 1}` }));
      const edu = pipe.briefFrom({ videoType: "educational", angle: "Your neighbor's sale is not your price.", whatWeAsked: "What do sellers need to know? (01:21:57)", proof: { text: "buyers have options", source: "P2" }, mustKeep: [...six, { text: "her buyer's offer on the overpriced listing, $20,000 over", source: "P7", inProgress: true }] }, []);
      c.ok("an educational brief keeps at most three must-keep points (v2.3); the rest move to optional, marked; the invitation is never must-keep", edu.mustKeep.length === 3 && edu.mustKeep.map((m) => m.text).join() === "the belief,reason one,reason two" && edu.optional.slice(0, 2).every((o) => /moved from must-keep: the belief, the proof, how she helps/.test(o.text)) && edu.optional.some((o) => /^the invitation \(moved from must-keep: the invitation belongs to the close\)$/.test(o.text)), JSON.stringify([edu.mustKeep.map((m) => m.text), edu.optional.map((o) => o.text)]));
      c.ok("…a deal still in progress is never must-keep: it is excluded, with the reason", !edu.mustKeep.some((m) => /20,000/.test(m.text)) && edu.excluded.some((x) => /20,000/.test(x.text) && /still in progress/.test(x.reason)));
      c.ok("…the angle, the one proof and what we asked are kept, and the brief text shows them", edu.angle === "Your neighbor's sale is not your price." && edu.proof?.text === "buyers have options" && /What we asked her[^\n]*What do sellers need to know/.test(prompts.briefText(edu)) && /Angle \(the one thing\)/.test(prompts.briefText(edu)));
      const story = pipe.briefFrom({ videoType: "story", mustKeep: [...six, { text: "seventh beat", source: "P9" }] }, []);
      const old = pipe.briefFrom({ mustKeep: six }, []);
      c.ok("a story keeps its beats up to six (never the invitation); a brief with no video type is read as educational (three)", story.mustKeep.length === 6 && !story.mustKeep.some((m) => /invitation/.test(m.text)) && story.videoType === "story" && old.mustKeep.length === 3 && old.videoType === "educational");
      c.ok("the brief prompt asks for one angle, one proof, the interviewer's question, the cap and no live deal", ["angle: ONE sentence", "proof: the ONE proof", "whatWeAsked:", "at most 3", "NEVER A LIVE DEAL", "when her story serves two groups, the viewer is both"].every((x) => prompts.BRIEF_SYSTEM.includes(x)));

      // --- 5. the hook for the story's job, and the runner-up on a failed re-hook (pure)
      const sc = (n: number) => ({ relevance: n, curiosity: n, tension: n, specificity: n, naturalDelivery: n, accuracy: 5, herVoice: n, payoffConnection: n });
      const raw = [
        { text: "Buying my first home shouldn't feel this scary, right?", rehook: "It should.", lever: "viewer question", fit: "viewer_line", scores: sc(5) },
        { text: "Every senior I helped move felt like my responsibility. Then I walked away.", rehook: "Here is why.", lever: "her moment", fit: "her_moment", scores: sc(4) },
        // v2.3: eligible (curiosity and tension 4), the same rank as the one above, a lower total.
        { text: "I came into real estate sure I'd only work with seniors. I was wrong.", rehook: "First-time buyers called.", lever: "her moment", fit: "her_moment", scores: { ...sc(3), curiosity: 4, tension: 4, specificity: 4 } },
      ];
      const asStory = rules.pickHook(raw, { videoType: "story" });
      const asEdu = rules.pickHook(raw, { videoType: "educational" });
      c.ok("a personal story opens on HER moment, even when a viewer's line scores higher; an educational video keeps the score order", asStory.chosen === 1 && asEdu.chosen === 0, `${asStory.chosen} / ${asEdu.chosen}`);
      c.ok("the runner-up: the next usable hook not yet tried, in the same order", rules.runnerUpHook(asStory.hooks, [raw[1].text], "story")?.text === raw[2].text && rules.runnerUpHook(asStory.hooks, raw.map((r) => r.text), "story") === null);
      // v2.4: only a failed HOOK can switch hooks (HOOK_SWITCH_CHECKS); a failed re-hook is revised under the locked hook.
      const only = (key: string, reason: string) => rules.mergeReview(rules.REVIEW_CHECK_KEYS.map((k) => ({ key: k, pass: k !== key, reason: k === key ? reason : "x" })), [], 70);
      const rehookInstr = pipe.writerFixInstruction({ checks: only("rehook", "It should. tells a nervous buyer the fear is warranted") });
      const hookInstr = pipe.writerFixInstruction({ checks: only("hook", "it bends what she said about seniors") });
      c.ok("v2.4: a failed hook is read from the fix instruction; a failed re-hook or close is not (only the hook switches)", rules.hookFailed({ instruction: hookInstr }) && !rules.hookFailed({ instruction: rehookInstr }) && !rules.hookFailed({ instruction: pipe.writerFixInstruction({ checks: only("close", "x") }) }) && rules.HOOK_SWITCH_CHECKS.join() === "hook");
      c.ok("the hooks prompt: a story opens on her moment; the viewer's line is for an educational video; each hook says its fit", prompts.HOOKS_SYSTEM.includes("A PERSONAL STORY opens on HER moment") && prompts.HOOKS_SYSTEM.includes("An EDUCATIONAL video voices the viewer's own belief") && JSON.stringify(prompts.HOOKS_SCHEMA).includes("her_moment"));

      // --- 6. the runner-up hook in the automatic check: a hook that keeps failing on her meaning
      // (v2.4: only a hook that failed on accuracy, meaning or a hard finding switches; the fake reason says "bent").
      ctl.reviews.set("G", [["hook"], ["hook"], ["hook"]]);
      const g0 = reqs.length;
      const rG = await gen.generateScriptForTopic({ topicId: tG, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const fixesG = reqs.slice(g0).filter((r) => r.step === "fix");
      c.ok("fix round 1 starts again from the runner-up hook (a redraft, not a patch around the failed one)", fixesG.length === 2 && fixesG[0].prompt.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_RUNNER_UP}`) && /REDRAFT RULES/.test(fixesG[0].prompt) && /THE PREVIOUS VERSION \(v1\), which failed the review/.test(fixesG[0].prompt), String(fixesG.length));
      c.ok("…fix round 2, the hook failing again, takes the third hook (never one already tried)", fixesG[1]?.prompt.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_THIRD}`));
      const vsG = await prisma.contentScriptVersion.findMany({ where: { scriptId: rG.scriptId }, orderBy: { versionNo: "asc" }, select: { hook: true } });
      c.ok("…and the versions carry those hooks", vsG.map((v) => v.hook).join(" | ") === [HOOK_WIN, HOOK_RUNNER_UP, HOOK_THIRD].join(" | ") || vsG.length >= 3 && vsG[1].hook === HOOK_RUNNER_UP && vsG[2].hook === HOOK_THIRD, vsG.map((v) => v.hook).join(" | "));
      // ... and in the offline run
      ctl.reviews.set("J", [["hook"], []]);
      const offJ = await pipe.draftOffline({ topicId: tJ, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: a hook failed on her meaning → \"fix 1 (runner-up hook)\" with the runner-up word for word, then passed", offJ.state === "passed" && offJ.attempts[1]?.label === "fix 1 (runner-up hook)" && offJ.attempts[1].parts.hook === HOOK_RUNNER_UP, offJ.attempts.map((a) => `${a.label}:${a.parts.hook.slice(0, 20)}`).join(","));

      // --- 7. no client's finals in any rule or system prompt (they were the answer key for Marcee's test)
      const FINALS = [
        "I absolutely loved working in senior living. So why did I leave? I wanted the freedom to do more. So I became a Realtor, expecting to help older adults downsize. Then the first-time buyers started calling. And surprisingly, both groups were asking the same questions. Where do I start? Who can I trust? What am I not asking? They needed someone to explain their options and fiercely protect their interests. That's the work I've always loved, but now I have the opportunity to help even more people. Whether it's your first home or your next chapter, you don't need all the answers before calling me. That's what I'm here for.",
        "But my house is different. Maybe it is. But that doesn't automatically mean it'll sell for more. The market has changed. But some homeowners still expect a bidding war by Sunday. Buyers have options. Your neighbor's sale isn't the whole story, and pricing, preparation, and marketing all matter. That's why I study what's selling, what's sitting, and what buyers are passing over. I'll give you honest advice on what to do next. There are still great opportunities. And your home is different! That's why it deserves a strategy built for today's market. Let's talk.",
        "The repairs you think your house needs before you sell? They might not be where your money should go. Sometimes, fresh paint and rearranging furniture do more than an expensive renovation. But preparation goes deeper than appearances. Buyers and their agents are also looking at the roof, major systems, and any signs of potentially costly problems. That's why I recommend a pre-listing inspection. We can identify issues early and decide what to repair, refresh, or leave alone before negotiations. I'm here to help you see your home through their eyes. Before you change everything, let's talk about what actually matters.",
      ].join("\n");
      const allRules = [prompts.RETRIEVAL_SYSTEM, prompts.BRIEF_SYSTEM, prompts.HOOKS_SYSTEM, prompts.WRITER_SYSTEM, prompts.REVIEW_SYSTEM, rules.CLOSE_RULE, rules.HOUSE_CRAFT_RULES, rules.WORDING_RULE, rules.HOMEOWNER_LANGUAGE_RULE, rules.trimInstruction(98), JSON.stringify([prompts.BRIEF_SCHEMA, prompts.HOOKS_SCHEMA, prompts.DRAFT_SCHEMA, prompts.REVIEW_SCHEMA])].join("\n");
      const leaked = rules.pastedRuns(FINALS, allRules, 5);
      c.ok("no run of five or more words from Jordan's three finals appears in any rule, system prompt or schema", leaked.length === 0, leaked.join(" | "));
      c.ok("…nor their signature phrases", !/fiercely protect|every bit as scary|my house is different|bidding war|first home or your next chapter|through their eyes|senior living/i.test(allRules));
    }

    // =======================================================================
    // v2.3, THE CRAFT FIX (Oct 22 2026). The fixtures are the independent
    // review's real examples from the offline drafts (Erica Walker, John
    // Collins); the rules themselves quote no client.
    // =======================================================================
    const S = (o: Partial<Record<string, number>>) => ({ relevance: 4, curiosity: 4, tension: 4, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 4, ...o });
    c.head("15.1 · hooks: tension scored; curiosity 4 and tension 4 to be eligible; ranked by curiosity + tension + specificity");
    {
      c.ok("HOOK_CRITERIA, the hooks prompt and its schema score tension", (rules.HOOK_CRITERIA as readonly string[]).includes("tension") && /tension \(5 = a real cost, reversal or unanswered question/.test(prompts.HOOKS_SYSTEM) && JSON.stringify(prompts.HOOKS_SCHEMA).includes("\"tension\""));
      c.ok("house craft: a belief line carries its own tension", rules.HOUSE_CRAFT_RULES.includes("A belief line must carry its own tension: a cost, a reversal or an unanswered question. A bare wish or belief with nothing at stake is not a hook."));
      // The backyard video: the viewer's wish had the highest total and won; it has nothing at stake.
      const KITCHEN = "We just want to walk out of the kitchen straight to the pool.";
      const HER_LOT = "My buyers wanted a kitchen-level walkout to the pool. Their lot had other plans.";
      const backyard = [
        { text: KITCHEN, rehook: "It's what buyers picture from homes they loved.", lever: "viewer belief", fit: "viewer_line", scores: S({ relevance: 5, curiosity: 4, tension: 2, specificity: 5, naturalDelivery: 5, herVoice: 5, payoffConnection: 5 }) },
        { text: "The backyard you're picturing probably came from someone else's lot.", rehook: "Your lot gets a say.", lever: "contrast", fit: "other", scores: S({ curiosity: 5, tension: 4, specificity: 3 }) },
        { text: HER_LOT, rehook: "So we pictured the views from the deck instead.", lever: "her moment", fit: "her_moment", scores: S({ curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 3 }) },
      ];
      const by = rules.pickHook(backyard, { videoType: "educational" });
      c.ok("the viewer's wish (\"We just want to walk out of the kitchen straight to the pool.\") is ineligible on tension, though its total is the highest", by.hooks[0].weak === "tension under 4" && by.hooks[0].total > by.hooks[2].total && by.chosen === 2 && by.fallback === null, `${by.hooks.map((h) => `${h.total}:${h.weak}`).join(" | ")} chosen ${by.chosen}`);
      const rank = rules.pickHook([
        { text: "A hook with the bigger total.", rehook: "r", scores: S({ relevance: 5, curiosity: 4, tension: 4, specificity: 4, naturalDelivery: 5, herVoice: 5, payoffConnection: 5 }) },
        { text: "A hook with more curiosity and tension.", rehook: "r", scores: S({ relevance: 3, curiosity: 5, tension: 5, specificity: 4, naturalDelivery: 3, herVoice: 3, payoffConnection: 3 }) },
      ]);
      c.ok("ranked by curiosity + tension + specificity (14 beats 12), the total only a tiebreak (the bigger total lost)", rank.chosen === 1 && rank.hooks[0].total > rank.hooks[1].total && rules.hookRank(rank.hooks[1]) === 14 && rules.hookRank(rank.hooks[0]) === 12, `${rank.hooks.map((h) => `${rules.hookRank(h)}/${h.total}`).join(" vs ")}`);
      const tie = [
        { text: "The agent who agreed with my price must really believe in my house.", rehook: "r", lever: "viewer belief", fit: "viewer_line", scores: S({ curiosity: 4, tension: 4, specificity: 4, relevance: 5, naturalDelivery: 5 }) },
        { text: "I showed a seller every proof source, and another agent still won the listing.", rehook: "r", lever: "her moment", fit: "her_moment", scores: S({ curiosity: 4, tension: 4, specificity: 4 }) },
      ];
      c.ok("a tie on the rank: her moment wins when the brief's proof is a story she told; otherwise the total decides", rules.pickHook(tie, { proofIsStory: true }).chosen === 1 && rules.pickHook(tie, { proofIsStory: false }).chosen === 0);
      const proof = (isHerStory: boolean | undefined, source: string) => pipe.proofIsHerStory({ proof: { text: "the deal over the doorknob", source, ...(isHerStory === undefined ? {} : { isHerStory }) } }, [{ id: "P3", kind: "story" }, { id: "P4", kind: "opinion" }]);
      c.ok("…\"a story she told\": the brief says so (isHerStory), or the proof cites a passage read as her story", proof(true, "call at 00:31:10") && proof(undefined, "P3") && !proof(undefined, "P4") && !proof(false, "written answers"));
      const none = rules.pickHook([
        { text: "We've outgrown this place. We just need a bigger house.", rehook: "r", scores: S({ curiosity: 4, tension: 3, specificity: 4 }) },
        { text: "Do you actually need more space, or space that works better?", rehook: "r", scores: S({ curiosity: 3, tension: 3, specificity: 3 }) },
      ]);
      c.ok("no hook reaches the bar: the strongest of the rest is used, and the fallback is recorded", none.chosen === 0 && /^No hook reached curiosity 4 and tension 4; the strongest of the rest was used \(tension under 4\)\.$/.test(none.fallback ?? ""), none.fallback ?? "none");
      const mixed = [{ ...backyard[0] }, { ...backyard[2] }, { ...backyard[1] }];
      const picked = rules.pickHook(mixed);
      c.ok("the runner-up after a failed hook is the next ELIGIBLE one before any weak one", rules.runnerUpHook(picked.hooks, [HER_LOT])?.text === backyard[1].text && rules.runnerUpHook(picked.hooks, [HER_LOT, backyard[1].text])?.text === KITCHEN);
      const bHooks = reqs.find((r) => r.step === "hooks" && r.prompt.includes(TOPIC_B))?.prompt ?? "";
      const aHooks = reqs.find((r) => r.step === "hooks" && r.prompt.includes(TOPIC_A))?.prompt ?? "";
      c.ok("variety: the hooks step sees this month's other openings (topic B's lists topic A's hook; topic A, drafted first, had none)", new RegExp(`THIS MONTH'S OTHER VIDEOS FOR HER OPEN WITH[^\\n]*\\n- ${HOOK_WIN.replace(/[.?]/g, "\\$&")}`).test(bHooks) && !aHooks.includes("THIS MONTH'S OTHER VIDEOS") && prompts.HOOKS_SYSTEM.includes("At most two of the five are a viewer's sentence spoken in the first person"));
      const card = record.writerCardOf(JSON.stringify({ writer: { v: 2, version: rules.WRITER_VERSION, brief: { centralMessage: "m", viewer: "v", whyChosen: "w", pillar: "p", whatSheSaid: [], mustKeep: [], optional: [], excluded: [], contradictions: [], verifiedFacts: [], opinions: [], creativeIdeas: [], ourAssumptions: [], closeType: "cta", closeWhy: "", target: { aim: [55, 85], cap: 110, seconds: [25, 39] } }, hooks: none.hooks, chosen: none.chosen, hookFallback: none.fallback } }));
      c.ok("the card shows each hook out of 40, why one was below the bar, and the fallback", card?.hooks[0].max === 40 && card.hooks[0].weak === "tension under 4" && card.hookFallback === none.fallback);
    }

    c.head("15.2 · re-hooks: a hedge or the hook's words again is hook_echo (code); the re-hook check names both");
    {
      const PRICE = "The agent who agreed with my price must really believe in my house.";
      const hedge = rules.hardNumbers({ hook: PRICE, points: [{ role: "re-hook", text: "Maybe. But without proof, they may care more about your open house buyers than selling your home." }, { role: "build-up", text: "Anybody could throw in a price. Ask how they got it." }, { role: "payoff", text: "x" }], close: "Ask any agent for the proof behind that price." }, "");
      const h = hedge.findings.find((x) => x.key === "hook_echo");
      c.ok("\"Maybe. But without proof...\" is flagged as a hedge: must-fix, against the re-hook", !!h && h.level === "must-fix" && h.check === "rehook" && /opens on a hedge \("Maybe"\)/.test(h.detail), JSON.stringify(hedge.findings));
      c.ok("…\"Not exactly.\" too; a re-hook that turns (\"The irony? ...\") is not", rules.craftFindings({ hook: "x y z", points: [{ role: "re-hook", text: "Not exactly. It depends on the lot." }], close: "" }).some((x) => x.key === "hook_echo") && !rules.craftFindings({ hook: "I once watched a deal fall apart over a doorknob.", points: [{ role: "re-hook", text: "The irony? One wanted to sell, one wanted to buy. Same goal." }], close: "" }).some((x) => x.key === "hook_echo"));
      const echo = rules.craftFindings({ hook: "Pre-listing inspections save sellers money on repairs.", points: [{ role: "re-hook", text: "A pre-listing inspection saves sellers real money on repairs." }, { role: "build-up", text: "Inspections catch repairs early, and sellers keep their money." }], close: "" });
      c.ok("a re-hook sharing 3 or more of the hook's content words is must-fix; a build-up that does is a flag (Nothing extra)", echo.some((x) => x.key === "hook_echo" && x.part === "rehook" && x.level === "must-fix" && /repeats the hook's words/.test(x.detail)) && echo.some((x) => x.key === "hook_echo" && x.part === "buildup" && x.level === "flag" && x.check === "nothing_extra"), JSON.stringify(echo.map((x) => [x.part, x.level, x.detail])));
      const merged = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "fine" })), hedge.findings, 70, null);
      c.ok("…merged: the re-hook check fails at must-fix; v2.4: the hook did not fail, so the next round keeps it (locked), no runner-up", merged.some((x) => x.key === "rehook" && !x.pass && x.level === "must-fix") && !rules.hookFailed({ checks: merged }) && pipe.reviewRoundPlan({ hooks: rules.pickHook([{ text: PRICE, rehook: "r", scores: S({}) }, { text: "Anybody could throw in a price.", rehook: "r", scores: S({}) }]).hooks, chosen: 0, brief: { videoType: "educational", proof: null } as never }, { body: PRICE, hook: PRICE }, { checks: merged, hard: hedge.findings }).lock.join() === "hook");
      const spec = rules.REVIEW_CHECKS.find((x) => x.key === "rehook")!;
      c.ok("REVIEW_CHECKS.rehook, word for word", spec.passes === "Adds a fact, turn or stake that is not in the hook. Fails if it opens with a hedge (Maybe, Not exactly), restates the hook's subject in other words, or only explains why the hook is true." && prompts.REVIEW_SYSTEM.includes(spec.passes));
    }

    c.head("15.3 · the proof is a real moment she told; her answer to an ask for an example is kept");
    {
      c.ok("house craft: prove it with one real moment she told", rules.HOUSE_CRAFT_RULES.includes("Prove it with one real moment she told: what happened, one number or detail, how it ended. When the interviewer asked for an example (have you ever, a real example, what was the outcome), her answer is the proof and a must-keep. A restated opinion is never the proof. A story that seems to contradict the message is framed, not dropped."));
      c.ok("the brief's proof line no longer allows \"the one reason the belief is not the whole story\"; it asks for her moment and keeps the example question", !prompts.BRIEF_SYSTEM.includes("the one reason the belief is not the whole story") && prompts.BRIEF_SYSTEM.includes("Prove it with one real moment she told") && prompts.BRIEF_SYSTEM.includes("keep that question in whatWeAsked, word for word") && JSON.stringify(prompts.BRIEF_SCHEMA).includes("isHerStory"));
      c.ok("Enough substance fails a script that leaves out the story she told", (rules.REVIEW_CHECKS.find((x) => x.key === "substance")!.passes as string).includes("Fails when it leaves out the story she told about this topic") && prompts.REVIEW_SYSTEM.includes("a script that leaves it out fails"));
      const asked = [{ quote: "Have you ever had a deal almost fall apart over something small? What was the outcome?", time: "00:31:02" }];
      const kept = pipe.briefFrom({ whatWeAsked: "What do buyers and sellers fight about?", proof: { text: "the deal over the doorknob", source: "P3", isHerStory: true } }, [], asked);
      const already = pipe.briefFrom({ whatWeAsked: "Have you ever had a deal almost fall apart over something small? What was the outcome? (00:31:02)" }, [], asked);
      c.ok("when the brief lost the interviewer's example question, code puts it back in whatWeAsked; when it kept it, nothing is added", /The interviewer asked for an example \(her answer is the proof\): "Have you ever had a deal almost fall apart/.test(kept.whatWeAsked ?? "") && kept.proof?.isHerStory === true && !/The interviewer asked for an example/.test(already.whatWeAsked ?? ""), kept.whatWeAsked);
      c.ok("…and the brief text tells the writer to keep what happened, the detail and how it ended", prompts.briefText(kept).includes("The one proof (a moment she told: keep what happened, the detail and how it ended): the deal over the doorknob [P3]"));
      c.ok("retrieval: return the example question and her whole answer", prompts.RETRIEVAL_SYSTEM.includes("When he asked for an example (have you ever, a real example, what was the outcome), return that question, and return her answer to it in full"));
    }

    c.head("15.4 · self-pitch: how she helps once; the payoff answers the hook; must-keep 3, never the invitation");
    {
      const ONCE = "how she helps appears once, in the payoff or the close, never both";
      const payoff = rules.REVIEW_CHECKS.find((x) => x.key === "payoff")!.passes as string;
      const substance = rules.REVIEW_CHECKS.find((x) => x.key === "substance")!.passes as string;
      c.ok("\"how she helps appears once, in the payoff or the close, never both\": house craft, the payoff and substance checks, the brief's must-keep", rules.HOUSE_CRAFT_RULES.includes(ONCE) && payoff.includes("How she helps appears once, in the payoff or the close, never both") && substance.includes(ONCE) && prompts.BRIEF_SYSTEM.includes(`how she helps (${ONCE})`));
      c.ok("the payoff check: answers the hook in one line the viewer could repeat; a \"My job\" line that does not answer the hook fails", payoff.startsWith("Answers the hook's question in one line the viewer could repeat. A \"My job\" or credential line that does not answer the hook fails."));
      c.ok("BRIEF_MUST_KEEP_MAX: educational 3, story 6; the invitation is never must-keep (the prompt and the code)", rules.BRIEF_MUST_KEEP_MAX.educational === 3 && rules.BRIEF_MUST_KEEP_MAX.story === 6 && prompts.BRIEF_SYSTEM.includes("The invitation and what the viewer should do next are never must-keep") && pipe.INVITATION_RE.test("Invite viewers to reach out for a consult") && !pipe.INVITATION_RE.test("She protects first-time buyers"));
    }

    c.head("15.5 · closes: a callback to the hook, then this video's own next step; must-fix; generic_close by code");
    {
      c.ok("CLOSE_RULE: at most two beats, the callback first, the specific next step second; \"Let's talk\" alone and \"Thinking about X?\" fail; no hard sell, no slogan", ["the close is at most two beats", "calls back a concrete word or image from the hook", "names THIS video's specific next step", "\"Let's talk\" as the whole invitation fails, and so does an invitation that opens \"Thinking about X?\"", "Never a hard sell", "A slogan or a rhyming aphorism is not a close"].every((x) => rules.CLOSE_RULE.includes(x)));
      c.ok("the close check is must-fix now", rules.REVIEW_CHECKS.find((x) => x.key === "close")!.level === "must-fix" && rules.mustFixFailures(rules.mergeReview([{ key: "close", pass: false, reason: "a slogan" }], [], 70, null)).some((x) => x.key === "close"));
      const gc = (hook: string, close: string) => rules.craftFindings({ hook, points: [], close }).find((x) => x.key === "generic_close");
      const nest = gc("Want more room now that the kids moved out? Don't feel like you're weird.", "Want the home everyone comes back to? Let's talk.");
      const yard = gc("We just want to walk out of the kitchen straight to the pool.", "You may have one vision. Tell me what your backyard should do before the plans are set.");
      const knob = gc("I once watched a deal fall apart over a doorknob.", "Don't lose the house over a doorknob. Buying or selling? Let's talk.");
      const paoli = gc("In Paoli, you can buy a newer townhome or a house over 200 years old.", "Something for everyone in Paoli. Thinking about Paoli? Give me a call.");
      const good = gc("I once watched a deal fall apart over a doorknob.", "Don't lose the house over a doorknob. Bring me the repair list, and we'll sort out what is worth the fight.");
      c.ok("\"[question]? Let's talk.\" as the whole close is generic_close (the regex)", !!nest && /ends on a question and "Let's talk\."/.test(nest.detail) && rules.GENERIC_CLOSE_RE.test("Want the home everyone comes back to? Let's talk."), nest?.detail);
      c.ok("…and as the close's last beat, after a good callback", !!knob && /ends on a question and "Let's talk\."/.test(knob.detail) && !/nothing from the hook/.test(knob.detail), knob?.detail);
      c.ok("a close that shares no content word with the hook (or the re-hook, v2.4) is generic_close", !!yard && /nothing from the hook or the re-hook comes back in it/.test(yard.detail), yard?.detail);
      c.ok("a \"Thinking about X?\" invitation is generic_close; a callback with this video's own next step is not", !!paoli && /opens "Thinking about \.\.\.\?"/.test(paoli.detail) && !good, `${paoli?.detail} | ${good?.detail}`);
      const m = rules.mergeReview([{ key: "close", pass: true, reason: "fine" }], [nest!], 70, null).find((x) => x.key === "close")!;
      c.ok("…merged, it fails a close the reviewer passed AS A FLAG (v2.4: generic_close is a flag; the reviewer's own close check stays must-fix)", !m.pass && m.level === "flag" && nest!.level === "flag" && (m.parts ?? []).includes("close"));
    }

    c.head("15.6 · length: target 68, the aim trim above 78 toward 65 to 75; the kept longer version may not say the failed line");
    {
      c.ok("WRITER_LENGTH: aim 55 to 85, cap 110, target 68, trim to 65 to 75, trim above 78", rules.WRITER_LENGTH.aim.join() === "55,85" && rules.WRITER_LENGTH.cap === 110 && rules.WRITER_LENGTH.target === 68 && rules.WRITER_LENGTH.trimTo.join() === "65,75" && rules.WRITER_LENGTH.trimAbove === 78);
      c.ok("a passing 80-word draft gets the aim trim; 78 does not; neither is \"long\" (the aim is unchanged)", pipe.nextWriterStep({ mustFails: [], words: 80, fixRounds: 0, trimmed: false }) === "aim-trim" && pipe.nextWriterStep({ mustFails: [], words: 78, fixRounds: 0, trimmed: false }) === "pass" && rules.lengthBand(80) === "aim" && rules.lengthCheck(80).pass);
      ctl.sizes.set("K", [[18, 17, 17, 14], [14, 14, 13, 14]]);
      ctl.reviews.set("K", [[]]);
      const offK = await pipe.draftOffline({ topicId: tK, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: an 80-word draft → one trim toward 65 to 75 (v2.4: before its first review) → 69 words, passed", offK.state === "passed" && offK.attempts.map((a) => `${a.label}:${a.words}`).join(",") === "draft:80,trim to aim:69" && !offK.attempts[0].review, offK.attempts.map((a) => `${a.label}:${a.words}`).join(","));
      // The kept-longer guard, pure.
      const trimParts = { hook: "H one two.", points: [{ role: "re-hook", text: "R short." }, { role: "build-up", text: "B short." }, { role: "payoff", text: "P short." }], close: "Same close for both versions." };
      const keptParts = { hook: "H one two.", points: [{ role: "re-hook", text: "R longer one." }, { role: "build-up", text: "B longer one." }, { role: "payoff", text: "P longer one." }], close: "Same close for both versions." };
      const fours = rules.readCraft(Object.fromEntries(rules.SCRIPT_PART_KEYS.map((k) => [k, { score: 4, note: "ok" }])));
      const only = (key: string, reason: string) => rules.mergeReview(rules.MODEL_CHECK_KEYS.map((k) => ({ key: k, pass: k !== key, reason: k === key ? reason : "ok" })), [], 60, fours);
      const failClose = only("close", "a slogan, not a callback");
      const failSubst = only("substance", "dropped the inspection");
      const failClaim = only("claims", "\"R longer one\" is not something she said");
      c.ok("guard: the trim failed the close, and the longer version has the same close → a conflict", rules.keptLongerConflicts({ parts: trimParts, checks: failClose }, keptParts).some((x) => x.key === "close" && x.line === "Same close for both versions."));
      c.ok("…a different close in the longer version → no conflict; a trim that only lost substance → none", rules.keptLongerConflicts({ parts: trimParts, checks: failClose }, { ...keptParts, close: "A different close." }).every((x) => x.key !== "close") && rules.keptLongerConflicts({ parts: trimParts, checks: failSubst }, keptParts).length === 0);
      c.ok("…a line the reviewer quoted, said in both versions → a conflict", rules.keptLongerConflicts({ parts: { ...trimParts, points: keptParts.points }, checks: failClaim }, keptParts).some((x) => x.key === "claims" && x.line === "R longer one"));
      // ... offline
      // v2.4: a draft over 78 is trimmed before any review, so the kept-longer path starts from a PASSING fix round:
      // the draft (69) fails, fix 1 comes back at 89 and passes, its aim trim (73) fails the same close.
      ctl.sizes.set("L", [[14, 14, 14, 13], [22, 20, 18, 15], [16, 14, 14, 15]]);
      ctl.reviews.set("L", [["her_meaning"], [], ["close"]]);
      const offL = await pipe.draftOffline({ topicId: tL, monthId: f.monthId, requestedBy: STAFF });
      const lClose = offL.final.review?.checks.find((x) => x.key === "close");
      c.ok("offline: the trim (73) failed its close, the 89-word fix 1 says the same close → kept, but FLAGGED, with the line named and the failed check said (not \"dropped a must-keep point\")", offL.state === "flagged" && offL.keptLonger && offL.final.label === "fix 1" && offL.final.words === 89 && /the trim toward 65 to 75 words failed a must-fix check \(8\. Close\), so the longer version stands/.test(offL.final.note ?? "") && /Flagged: the trim's review failed a line this version says too \(8\. Close: "/.test(offL.final.note ?? "") && !!lClose && !lClose.pass && lClose.level === "must-fix", `${offL.state} · ${offL.attempts.map((a) => `${a.label}:${a.words}`).join(",")} · ${offL.final.note}`);
      // ... and in the automatic check
      ctl.sizes.set("M", [[14, 14, 14, 13], [22, 20, 18, 15], [16, 14, 14, 15]]);
      ctl.reviews.set("M", [["her_meaning"], [], ["close"]]);
      const rM = await gen.generateScriptForTopic({ topicId: tM, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const vsM = await prisma.contentScriptVersion.findMany({ where: { scriptId: rM.scriptId }, orderBy: { versionNo: "asc" } });
      const headM = await prisma.contentScript.findUniqueOrThrow({ where: { id: rM.scriptId } });
      const curM = vsM.find((v) => v.id === headM.currentVersionId)!;
      const jM = (await import("@/lib/scriptJudgeRecord")).readJudge(curM.validationJson);
      const cardM = record.writerCardOf(curM.validationJson);
      c.ok("automatic check: v1 69 failed → v2 89 passed → v3 73 failed its close → v4 = v2, FLAGGED, the close check failing on it with the trim's reason", vsM.map((v) => v.spokenWordCount).join(",") === "69,89,73,89" && curM.id === vsM[3].id && curM.body === vsM[1].body && jM?.state === "flagged" && (jM.checks ?? []).some((x) => x.key === "close" && !x.pass && x.level === "must-fix" && /The trim's review failed this line, and this version says it too/.test(x.reason)), `${vsM.map((v) => `v${v.versionNo}:${v.spokenWordCount}`).join(" ")} · ${jM?.state}`);
      c.ok("…the card says so, and it waits for a person (never shared)", /Flagged: the trim's review failed a line this version says too/.test(cardM?.lengthNote ?? "") && /Flagged: the trim's review failed a line v2 says too/.test(curM.changeSummary ?? "") && curM.status === "INTERNAL_REVIEW" && !headM.sharedVersionId && !headM.approvedVersionId, cardM?.lengthNote ?? "none");
      c.ok("…a kept 80-word version carries no \"Longer than the aim\" advice (it is inside the aim)", !/Longer than the/.test(pipe.keptLongerNote("v1", 80)) && /Longer than the 55 to 85 aim/.test(pipe.keptLongerNote("v1", 96)));
    }

    c.head("15.7 · jargon: her phrases never override plain words; four more terms by code");
    {
      c.ok("HOMEOWNER_LANGUAGE_RULE: a phrase of hers is still jargon", rules.HOMEOWNER_LANGUAGE_RULE.includes("A phrase of hers is still jargon if a homeowner would not say it; her phrases never override this rule.") && prompts.BRIEF_SYSTEM.includes(rules.HOMEOWNER_LANGUAGE_RULE) && prompts.BRIEF_SYSTEM.includes("her phrases never override plain words"));
      const j = rules.hardNumbers({ hook: "Your lot decides the backyard.", points: [{ role: "payoff", text: "I look at grading, impervious coverage, setbacks, and what the actives and pendings say." }], close: "Bring me your backyard wish list." }, "").findings.find((x) => x.key === "jargon");
      c.ok("\"impervious coverage\", \"setbacks\", \"actives\", \"pendings\" are caught as industry terms, and must be fixed (Oct 22: not a flag)", !!j && j.level === "must-fix" && ["impervious coverage", "setback", "actives", "pendings"].every((t) => j.detail.includes(t)), j?.detail);
      c.ok("…\"impervious surface\" too; \"active\" and \"pending\" as plain words are not", rules.hardNumbers({ hook: "x", points: [{ role: "payoff", text: "An impervious surface limit." }], close: "x" }, "").findings.some((x) => x.key === "jargon") && !rules.hardNumbers({ hook: "x", points: [{ role: "payoff", text: "Homes are pending and buyers are active." }], close: "x" }, "").findings.some((x) => x.key === "jargon"));
    }

    c.head("15.8 · the review gate judges craft: five parts scored (v2.4: a total of 19, a 2 is must-fix, a 3 a flag); a failed re-hook keeps the hook");
    {
      c.ok("check 13 (Craft, must-fix) in REVIEW_CHECKS; the review schema's craft block has the five parts, score and note; the model answers twelve checks", rules.REVIEW_CHECKS.length === 13 && rules.REVIEW_CHECKS[12].key === "craft" && rules.REVIEW_CHECKS[12].level === "must-fix" && ["hook", "rehook", "buildup", "payoff", "close"].every((k) => JSON.stringify((prompts.REVIEW_SCHEMA as { properties: { craft: { properties: Record<string, unknown> } } }).properties.craft.properties[k]).includes("\"score\"")) && !(prompts.REVIEW_SCHEMA as { properties: { checks: { items: { properties: { key: { enum: string[] } } } } } }).properties.checks.items.properties.key.enum.includes("craft"));
      c.ok("the review prompt: the CRAFT block with the psychology each part is judged on, and v2.4's gate (19, a 3 is a flag, 2 or under sent back)", /CRAFT \(check 13, the craft block\)/.test(prompts.REVIEW_SYSTEM) && ["what lever it pulls", "how it escalates", "what it sets up for the payoff", "delivers the hook's promise", "memorable and tied to the hook"].every((x) => prompts.REVIEW_SYSTEM.includes(x)) && prompts.REVIEW_SYSTEM.includes("3 works but could be stronger (a flag, not a reason to send it back); 2 or under he would send back. The craft check passes on a total of 19 or more with no part at 2 or under.") && !prompts.REVIEW_SYSTEM.includes("Any part under 4 is must-fix"));
      const cs = (o: Partial<Record<string, number>>) => rules.readCraft(Object.fromEntries(["hook", "rehook", "buildup", "payoff", "close"].map((k) => [k, { score: o[k] ?? 4, note: `${k} note` }])));
      const rh = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, cs({ rehook: 2 }));
      c.ok("a re-hook scored 2: the craft check AND the re-hook check fail at must-fix; v2.4: the hook stays (from the checks and from the instruction)", rh.some((x) => x.key === "craft" && !x.pass && x.level === "must-fix" && /Re-hook 2 of 5: rehook note/.test(x.reason)) && rh.some((x) => x.key === "rehook" && !x.pass && x.level === "must-fix" && /^Craft: Re-hook 2 of 5/.test(x.reason)) && !rules.hookFailed({ checks: rh }) && !rules.hookFailed({ instruction: pipe.writerFixInstruction({ checks: rh }) }));
      const rh3 = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, cs({ rehook: 3 }));
      c.ok("…a re-hook scored 3 (total 19): craft passes, the re-hook check fails AS A FLAG, nothing must-fix", rh3.find((x) => x.key === "craft")!.pass && rh3.some((x) => x.key === "rehook" && !x.pass && x.level === "flag" && /a flag/.test(x.reason)) && rules.mustFixFailures(rh3).length === 0);
      const po = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, cs({ payoff: 2 }));
      c.ok("a payoff scored 2: craft fails at must-fix (a fix round), the hook stays", rules.mustFixFailures(po).map((x) => x.key).join() === "craft" && !rules.hookFailed({ checks: po }) && (po.find((x) => x.key === "craft")!.parts ?? []).join() === "payoff");
      const allOk = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, cs({}));
      const missing = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, null);
      const partial = rules.mergeReview(rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), [], 70, rules.readCraft({ hook: { score: 5, note: "n" } }));
      c.ok("every part 4 or more passes (13 of 13); no craft block, or a part not scored, fails, never passes", allOk.every((x) => x.pass) && rules.reviewHeadline(allOk) === "Creative review: 13 of 13 pass" && !missing.find((x) => x.key === "craft")!.pass && !partial.find((x) => x.key === "craft")!.pass && /Re-hook not scored/.test(partial.find((x) => x.key === "craft")!.reason));
      // End to end (v2.4): the craft block scores the re-hook 2 → fix round 1 REVISES with the hook locked (no runner-up),
      // and the writer's own new hook is put back by code.
      ctl.reviews.set("N", [[], []]);
      ctl.craft.set("N", [{ rehook: 2 }, {}]);
      ctl.rewriteHook.add("N");
      const n0 = reqs.length;
      const rN = await gen.generateScriptForTopic({ topicId: tN, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const fixN = reqs.slice(n0).filter((r) => r.step === "fix");
      const vsN = await prisma.contentScriptVersion.findMany({ where: { scriptId: rN.scriptId }, orderBy: { versionNo: "asc" } });
      const jN1 = (await import("@/lib/scriptJudgeRecord")).readJudge(vsN[0].validationJson);
      const jN2 = (await import("@/lib/scriptJudgeRecord")).readJudge(vsN[vsN.length - 1].validationJson);
      c.ok("automatic check: the re-hook scored 2 on craft → fix 1 revises with the hook LOCKED (not a redraft); the writer's own hook is copied back; then it passes", fixN.length === 1 && !fixN[0].prompt.includes("THE CHOSEN HOOK") && !/REDRAFT RULES/.test(fixN[0].prompt) && /KEEP EXACTLY \(copied back word for word after you answer; return them unchanged\): Hook\./.test(fixN[0].prompt) && /MUST FIX:[\s\S]*- 4\. Re-hook: Craft: Re-hook 2 of 5/.test(fixN[0].prompt) && vsN.length === 2 && vsN[1].hook === HOOK_WIN && !vsN.some((v) => v.hook === (HOOK_REWRITTEN as string)) && jN2?.state === "passed", `${fixN.length} fixes · ${vsN.map((v) => v.hook).join(" | ")} · ${jN2?.state}`);
      const cardN = record.writerCardOf(vsN[0].validationJson);
      c.ok("…the craft block is kept on the judge record, and the card shows it part by part", jN1?.craft?.rehook.score === 2 && cardN?.review?.craft.length === 5 && cardN.review.craft.some((x) => x.label === "Re-hook" && x.score === 2 && x.under && /it only explains the hook/.test(x.note)) && record.writerCardOf(vsN[1].validationJson)?.review?.craft.every((x) => !x.under) === true);
      c.ok("a format agreed on the call is a creative decision: house craft, the retrieval, the brief (never internal talk), the review", rules.HOUSE_CRAFT_RULES.includes("A format agreed on the call (word association, two voices, a trend alert) is a creative decision the script follows, not production talk.") && prompts.RETRIEVAL_SYSTEM.includes("A FORMAT AGREED ON THE CALL for this video (word association, two voices, a trend alert) is a creative decision the script follows, never internal talk") && prompts.BRIEF_SYSTEM.includes("A format agreed on the call for this video is never internal talk and never excluded") && prompts.BRIEF_SYSTEM.includes("a format agreed on the call for this video (word association, two voices, a trend alert, whoever proposed it)") && prompts.REVIEW_SYSTEM.includes("following it is never a fault"));
      c.ok("WRITER_VERSION is writer.v2.4-2026-10-22 (v2.4), on every writer run", rules.WRITER_VERSION === "writer.v2.4-2026-10-22" && (await prisma.programAiRun.count({ where: { kind: "script_review", promptVersion: "writer.v2.4-2026-10-22" } })) > 0);
      c.ok("no dash in any rule or prompt the model reads (it copies punctuation; the no-dash rule's own text aside)", ![prompts.RETRIEVAL_SYSTEM, prompts.BRIEF_SYSTEM, prompts.HOOKS_SYSTEM, prompts.WRITER_SYSTEM, prompts.REVIEW_SYSTEM, rules.CLOSE_RULE, rules.HOUSE_CRAFT_RULES, rules.HOMEOWNER_LANGUAGE_RULE, ...rules.REVIEW_CHECKS.map((x) => x.passes), ...rules.CRAFT_PARTS.map((x) => x.asks)].some((t) => /[‒–—―]/.test(t.split(rules.NO_DASH_RULE).join(""))));
    }

    // =======================================================================
    c.head("16 · the model map: each step's model and effort; the cached prefix of a second review round; the cost of each model");
    {
      // The new writer's runs (promptKey writer-<step>); the old writer's draft in section 11 stays on Sonnet 4.6.
      const ledger = async (kind: string) => (await prisma.programAiRun.findMany({ where: { kind: kind as never, enrollmentId: f.enrollmentId, status: "SUCCEEDED", promptKey: { startsWith: "writer-" } }, select: { model: true } })).map((r) => r.model);
      const kinds = { script_retrieval: "claude-haiku-5-5", script_brief: "claude-sonnet-5-5", script_hooks: "claude-opus-5-5", script_draft: "claude-sonnet-5-5", script_review: "claude-sonnet-5-5", script_revise: "claude-sonnet-5-5" } as const;
      const stamped = await Promise.all(Object.entries(kinds).map(async ([k, m]) => ({ k, m, got: await ledger(k) })));
      c.ok("every ProgramAiRun is stamped with its step's model (retrieval Haiku 5.5; brief, draft, review, revise Sonnet 5.5; hooks Opus 5.5)", stamped.every((x) => x.got.length > 0 && x.got.every((g) => g === x.m)), stamped.map((x) => `${x.k}:${[...new Set(x.got)].join("/")}`).join(" "));
      c.ok("no writer request sent temperature, top_p, top_k or a thinking budget; none forced a tool", reqs.filter((r) => ["retrieval", "brief", "hooks", "draft", "review", "trim", "fix", "revise"].includes(r.step)).every((r) => !("temperature" in r.body) && !("top_p" in r.body) && !("top_k" in r.body) && !("thinking" in r.body) && !JSON.stringify(r.body).includes("budget_tokens") && !("tool_choice" in r.body) && !("tools" in r.body)));
      // Topic B's first two reviews (the draft, then fix 1): the same prefix, byte for byte, in front of the breakpoints.
      // (v2.4: topic A's draft is trimmed before its first review, so it has one review.)
      const revA = reqs.filter((r) => r.step === "review" && r.prompt.includes(TOPIC_B)).slice(0, 2);
      type Block = { type: string; text: string; cache_control?: { type: string } };
      const blocks = revA.map((r) => ((r.body.messages as { content: Block[] }[])[0].content));
      const okShape = blocks.length === 2 && blocks.every((b) => Array.isArray(b) && b.length === 3 && b[0].cache_control?.type === "ephemeral" && b[1].cache_control?.type === "ephemeral" && !b[2].cache_control);
      c.ok("the review's user message: two cached blocks, then the version under review (no breakpoint after it)", okShape, blocks.map((b) => (Array.isArray(b) ? b.map((x) => (x.cache_control ? "C" : "-")).join("") : typeof b)).join(" / "));
      c.ok("…the second round's cached prefix is byte for byte the first round's, and the full call (the transcript) sits before the first breakpoint", okShape && blocks[0][0].text === blocks[1][0].text && blocks[0][1].text === blocks[1][1].text && blocks[0][2].text !== blocks[1][2].text && blocks[0][0].text.includes("THE FULL CALL") && blocks[0][0].text.includes(Q_SENIOR) && revA[0].system === revA[1].system && (revA[0].body.system as Block[])[0].cache_control?.type === "ephemeral", okShape ? [blocks[0][0].text === blocks[1][0].text, blocks[0][1].text === blocks[1][1].text, blocks[0][2].text !== blocks[1][2].text, blocks[0][0].text.includes("THE FULL CALL"), blocks[0][0].text.includes(Q_SENIOR), revA[0].system === revA[1].system].join(",") : "shape");
      c.ok("…nothing per round before the breakpoints (the version, the counts, the hard checks come after)", okShape && blocks.every((b) => !/SCRIPT TO REVIEW|COUNTED BY CODE|THE WRITER SAYS THE CLOSE/.test(b[0].text + b[1].text) && /^SCRIPT TO REVIEW:/.test(b[2].text)));
      const draftA = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_A));
      const dBlocks = (draftA?.body.messages as { content: Block[] }[] | undefined)?.[0].content ?? [];
      const retA = reqs.find((r) => r.step === "retrieval" && r.prompt.includes(TOPIC_A));
      const rBlocks = (retA?.body.messages as { content: Block[] }[] | undefined)?.[0].content ?? [];
      c.ok("the draft caches her material and puts the chosen hook after the breakpoint; the retrieval caches the call and asks for the topic after it", Array.isArray(dBlocks) && dBlocks.length === 2 && !!dBlocks[0].cache_control && !dBlocks[0].text.includes("THE CHOSEN HOOK") && dBlocks[1].text.startsWith("THE CHOSEN HOOK") && Array.isArray(rBlocks) && !!rBlocks[0].cache_control && rBlocks[0].text.includes(Q_SENIOR) && !rBlocks[0].text.includes(TOPIC_A) && rBlocks[1].text.includes(TOPIC_A));
      const shape = ai.buildStructuredRequest({ system: "S", prompt: "a\n\nb\n\nc", schema: { type: "object" }, effort: "medium", maxTokens: 9000, model: "claude-sonnet-5-5", promptBlocks: [{ text: "a", cache: true }, { text: "  ", cache: true }, { text: "b", cache: true }, { text: "c", cache: true }] });
      const sb = (shape.body.messages as { content: Block[] }[])[0].content;
      c.ok("the request builder: the model and effort per call; empty blocks dropped; two user breakpoints at most (the system's is the third)", shape.body.model === "claude-sonnet-5-5" && (shape.body.output_config as { effort: string }).effort === "medium" && sb.length === 3 && sb.filter((x) => x.cache_control).length === 2 && !sb[2].cache_control && typeof (ai.buildStructuredRequest({ system: "S", prompt: "plain", schema: {}, effort: "high", maxTokens: 10 }).body.messages as { content: unknown }[])[0].content === "string");
      const { estimateCostCents } = await import("@/lib/aiRuns");
      const { aiCostUsd } = await import("@/lib/aiUsage");
      const M = 1_000_000;
      const each = { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M };
      c.ok("cost per million: Opus 5.5 $4 in, $20 out, $0.20 cache read, $5 cache write = $29.20", estimateCostCents("claude-opus-5-5", each) === 2920, String(estimateCostCents("claude-opus-5-5", each)));
      c.ok("…Sonnet 5.5 $2, $10, $0.20, $2.50 = $14.70 (it used to be priced as Sonnet 4.6 in the run ledger)", estimateCostCents("claude-sonnet-5-5", each) === 1470, String(estimateCostCents("claude-sonnet-5-5", each)));
      c.ok("…Haiku 5.5 $0.10, $0.50, $0.01, $0.125 (ten million each: $7.35)", estimateCostCents("claude-haiku-5-5", { inputTokens: 10 * M, outputTokens: 10 * M, cacheReadTokens: 10 * M, cacheWriteTokens: 10 * M }) === 735, String(estimateCostCents("claude-haiku-5-5", { inputTokens: 10 * M, outputTokens: 10 * M, cacheReadTokens: 10 * M, cacheWriteTokens: 10 * M })));
      c.ok("…a cache read costs a tenth of fresh input; the run ledger and the usage ledger price a call the same way", estimateCostCents("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10 * M, cacheWriteTokens: 0 }) * 10 === estimateCostCents("claude-sonnet-5-5", { inputTokens: 10 * M, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) && ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-6"].every((m) => estimateCostCents(m, { inputTokens: 31_000, outputTokens: 4_200, cacheReadTokens: 27_000, cacheWriteTokens: 3_000 }) === Math.round(aiCostUsd(m, { inputTokens: 31_000, outputTokens: 4_200, cacheReadTokens: 27_000, cacheWriteTokens: 3_000 }) * 100)));
    }

    // =======================================================================
    // v2.4, THE CALIBRATION FIX (Oct 22 2026). The fixtures are the v2.3
    // offline retest's real drafts, hooks and review notes (Erica Walker, John
    // Collins, Marcee); the rules themselves quote no client.
    // =======================================================================
    const craftOf = (o: Partial<Record<string, number>>, note = "n") => rules.readCraft(Object.fromEntries(["hook", "rehook", "buildup", "payoff", "close"].map((k) => [k, { score: o[k] ?? 4, note }])))!;
    const modelFails = (fails: Record<string, string>) => rules.MODEL_CHECK_KEYS.map((key) => ({ key, pass: !(key in fails), reason: fails[key] ?? "ok" }));
    // Erica, "The Agent Who Agreed With Your Price": the five hooks as Opus scored them.
    const PRICE_HOOK = "I told sellers their house was worth $1.2 million, not $1.4, and I lost the listing.";
    const PRICE_HOOKS = [
      { text: PRICE_HOOK, rehook: "Another agent said yes to their number and got it. What happened next is why you should ask every agent to prove their price.", lever: "her moment", fit: "her_moment", scores: { relevance: 4, curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 4, accuracy: 5, herVoice: 5, payoffConnection: 5 } },
      { text: "The agent who agreed with my price felt like the one on my side.", rehook: "Then ask where that number came from. If they can't show you, they may be after the buyers your listing brings in, not the sale.", lever: "viewer belief", fit: "viewer_line", scores: { relevance: 5, curiosity: 4, tension: 4, specificity: 3, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 5 } },
      { text: "Anybody could tell you a price. The real question is how they got it.", rehook: "I've watched a seller pick the agent who just said yes over the one with proof, and that house sat.", lever: "contrast", fit: "other", scores: { relevance: 5, curiosity: 3, tension: 3, specificity: 2, naturalDelivery: 5, accuracy: 5, herVoice: 5, payoffConnection: 5 } },
      { text: "Your agent loving your price might be the biggest warning sign.", rehook: "Saying yes can win them the listing, and a high price can bring buyers to their open houses. Selling your home at that number is a different job.", lever: "reversal", fit: "other", scores: { relevance: 5, curiosity: 4, tension: 4, specificity: 2, naturalDelivery: 4, accuracy: 4, herVoice: 4, payoffConnection: 5 } },
      { text: "How do I know the price an agent gives me is real?", rehook: "Ask them to walk you through what's for sale near you now, what sold, and what's under contract. A yes with nothing behind it tells you something.", lever: "viewer question", fit: "viewer_line", scores: { relevance: 5, curiosity: 3, tension: 2, specificity: 3, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 4 } },
    ];
    const priceBrief = { videoType: "educational", proof: { text: "Sellers wanted $1.4 million; she showed it was worth $1.2 million at most; another agent said yes, the house sat, and they fired that agent.", source: "P3", isHerStory: true } } as never;

    c.head("17.1 · v2.4 keep the good hook: a re-hook-only failure keeps the hook (locked); the runner-up's re-hook never rides in; the final pick prefers craft and refuses over the cap");
    {
      c.ok("HOOK_SWITCH_CHECKS is the hook only", rules.HOOK_SWITCH_CHECKS.join() === "hook");
      const picked = rules.pickHook(PRICE_HOOKS, { videoType: "educational", proofIsStory: true });
      c.ok("Erica's pricing video: Opus's first choice is her \"$1.2 million, not $1.4\" moment, a pick that met HOOK_BAR", picked.chosen === 0 && rules.hookIsBarPick(picked.hooks, PRICE_HOOK) && !rules.hookIsBarPick(picked.hooks, PRICE_HOOKS[2].text) && !rules.hookIsBarPick(picked.hooks, "A hook the writer made up."));
      // Its v2.3 draft review: her meaning, the re-hook (the reviewer's own fail and Re-hook 3), substance, the close (2) and a claim failed; the hook passed.
      const craftP = craftOf({ hook: 5, rehook: 3, buildup: 3, payoff: 4, close: 2 });
      const checksP = rules.mergeReview(modelFails({
        her_meaning: "The script never says her reason for the lost listing; the re-hook 'why every agent should prove their price' misframes the story.",
        rehook: "It adds the other agent saying yes, but it then teases 'What happened next is why...' and the build-up simply answers it.",
        substance: "The first must-keep, an agent who agrees without proof is after buyers off the listing, is missing.",
        close: "A generic invitation that does not call back the $1.4 million or the listing lost.",
        claims: "'every agent should prove their price' is a new claim.",
      }), [], 85, craftP, { hookAdvisory: rules.hookIsBarPick(picked.hooks, PRICE_HOOK) });
      const recP = { hooks: picked.hooks, chosen: picked.chosen, brief: priceBrief, passages: [] };
      const planP = pipe.reviewRoundPlan(recP, { body: PRICE_HOOK, hook: PRICE_HOOK }, { checks: checksP, hard: [], craft: craftP });
      c.ok("its re-hook-only failure (v2.3 swapped this hook away): the hook passes, the re-hook fails at must-fix, and the round keeps the hook LOCKED, no runner-up", checksP.find((x) => x.key === "hook")!.pass && checksP.some((x) => x.key === "rehook" && !x.pass && x.level === "must-fix") && planP.switchTo === null && planP.lock.join() === "hook", `${JSON.stringify(planP.lock)} · ${planP.switchTo?.text}`);
      const reviseP = prompts.buildReviseWriterPrompt({ clientName: "x", speakerNames: [], strategyText: null, identityBlock: "", guardBlock: "", monthPriorities: [], topic: { title: "t", pillar: "p", description: null, intendedMessage: null, audienceNeed: null, businessGoal: null, whyChosen: "w" }, facts: [], voiceRefs: [], relatedScripts: [], answers: [], captionExamples: [] }, { ...(priceBrief as object), centralMessage: "m", viewer: "v", whyChosen: "w", pillar: "p", whatSheSaid: [], mustKeep: [], optional: [], excluded: [], contradictions: [], verifiedFacts: [], opinions: [], creativeIdeas: [], ourAssumptions: [], closeType: "cta", closeWhy: "", target: { aim: [55, 85], cap: 110, seconds: [25, 39], words: 68 } } as never, [], { versionNo: 1, body: PRICE_HOOK }, "fix it", { who: "review", lockedLabels: planP.lock.map(pipe.partLabel) });
      c.ok("…the revise prompt says KEEP EXACTLY: Hook (code copies it back)", /KEEP EXACTLY \(copied back word for word after you answer; return them unchanged\): Hook\./.test(reviseP.prompt));
      // Backyard, fix 1 of v2.3: the runner-up hook "We'll pick the lot first ..." bent her story (the lot was the only one left).
      const YARD_HOOKS = [
        { text: "We'll pick the lot first and figure out the backyard later.", rehook: "Except the slope of that lot already decided whether you walk out to the pool from the kitchen or from the basement.", fit: "viewer_line", scores: { relevance: 5, curiosity: 4, tension: 4, specificity: 3, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 5 } },
        { text: "Most buyers see a sloped lot as a problem. It's actually a decision.", rehook: "That slope shapes everything, from where your garage goes to whether your patio sits under a deck with views up top.", fit: "other", scores: { relevance: 4, curiosity: 4, tension: 4, specificity: 3, naturalDelivery: 5, accuracy: 5, herVoice: 5, payoffConnection: 5 } },
        { text: "My clients wanted to step from the kitchen straight out to the pool. Their lot said no.", rehook: "The only lot left was a walkout basement, so instead of fighting the slope we used it, and it's still going to be amazing.", fit: "other", scores: { relevance: 4, curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 4, accuracy: 4, herVoice: 4, payoffConnection: 4 } },
      ];
      const yard = rules.pickHook(YARD_HOOKS, { videoType: "educational" });
      const yardCraft = craftOf({ hook: 2, rehook: 3, buildup: 2 }, "A flat belief with no cost or unanswered question gives the viewer no reason to lean in, and it bends her story.");
      const yardChecks = rules.mergeReview(modelFails({ her_meaning: "The hook, 'We'll pick the lot first and figure out the backyard later,' frames the buyers as choosing the lot first. Erica said the lot was the only one available." }), [], 86, yardCraft, { hookAdvisory: false });
      const yardPlan = pipe.reviewRoundPlan({ hooks: yard.hooks, chosen: yard.chosen, brief: { videoType: "educational", proof: null } as never }, { body: YARD_HOOKS[0].text, hook: YARD_HOOKS[0].text }, { checks: yardChecks, hard: [], craft: yardCraft });
      c.ok("a hook that failed on her meaning (her_meaning quotes it, the craft note says it bends her story) DOES switch, to the next unused hook", rules.hookVerdict({ checks: yardChecks, craft: yardCraft }, YARD_HOOKS[0].text).hard && yardPlan.switchTo?.text === YARD_HOOKS[1].text, yardPlan.switchTo?.text);
      // The craft path, pure: a hook scored 2 switches only to a runner-up that ranks at least as high.
      const crafty = () => rules.mergeReview(modelFails({}), [], 70, craftOf({ hook: 2 }, "nothing at stake"), { hookAdvisory: false });
      const weakNow = pipe.switchHookFor(recP, { body: PRICE_HOOKS[2].text, hook: PRICE_HOOKS[2].text }, { checks: crafty(), craft: craftOf({ hook: 2 }) });
      const strongNow = pipe.reviewRoundPlan(recP, { body: PRICE_HOOK, hook: PRICE_HOOK }, { checks: crafty(), craft: craftOf({ hook: 2 }) });
      c.ok("…craft hook 2 with a runner-up ranked at least as high (11 vs 8) switches; against a weaker runner-up (11 vs her 15) it keeps the hook, locked", weakNow?.text === PRICE_HOOKS[1].text && strongNow.switchTo === null && strongNow.lock.join() === "hook", `${weakNow?.text} · ${strongNow.switchTo?.text ?? "kept"}`);
      // The runner-up's re-hook never rides in (topic G's redraft, section 14).
      const gFix = reqs.filter((r) => r.step === "fix" && r.prompt.includes(TOPIC_G))[0]?.prompt ?? "";
      c.ok("the redraft from the runner-up passes its HOOK only: no \"THE CHOSEN RE-HOOK\", not its re-hook (\"But not always.\"); the parts that passed are kept", !!gFix && gFix.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_RUNNER_UP}`) && !gFix.includes("THE CHOSEN RE-HOOK") && !gFix.includes("But not always.") && /KEEP EXACTLY \(these passed the review; copied back word for word after you answer; return them unchanged\): Re-hook, Build-up, Payoff, Close\./.test(gFix), (/KEEP EXACTLY[^\n]*/.exec(gFix) ?? [""])[0]);
      // Offline: a re-hook-only failure, the writer rewriting the hook on its own → code keeps the hook.
      ctl.reviews.set("P", [["rehook"], []]);
      ctl.rewriteHook.add("P");
      const p0 = reqs.length;
      const offP = await pipe.draftOffline({ topicId: tP, monthId: f.monthId, requestedBy: STAFF });
      const fixP = reqs.slice(p0).filter((r) => r.step === "fix");
      c.ok("offline: a failed re-hook → \"fix 1\" (not the runner-up), the hook LOCKED and copied back word for word though the writer rewrote it, then passed", offP.state === "passed" && offP.attempts.map((a) => a.label).join(",") === "draft,fix 1" && offP.attempts[1].parts.hook === HOOK_WIN && fixP.length === 1 && /KEEP EXACTLY[^\n]*: Hook\./.test(fixP[0].prompt) && !fixP[0].prompt.includes("THE CHOSEN HOOK"), offP.attempts.map((a) => `${a.label}:${a.parts.hook}`).join(" | "));

      // The final pick. Marcee's "Repairs" retest, v2.3's attempts as reviewed: v2.3 kept the 111-word fix 2.
      const REPAIRS = [
        { label: "draft", words: 101, mustFix: 5, craft: craftOf({ hook: 4, rehook: 4, buildup: 3, payoff: 3, close: 4 }) },
        { label: "fix 1", words: 107, mustFix: 7, craft: craftOf({ hook: 2, rehook: 2, buildup: 3, payoff: 3, close: 3 }) },
        { label: "fix 2 (runner-up hook)", words: 111, mustFix: 5, craft: craftOf({ hook: 4, rehook: 3, buildup: 3, payoff: 4, close: 3 }) },
        { label: "trim", words: 92, mustFix: 7, craft: craftOf({ hook: 3, rehook: 2, buildup: 2, payoff: 3, close: 4 }) },
      ];
      c.ok("Marcee's Repairs: the final pick is the 101-word draft (craft 22 with the hook twice), never the 111-word fix 2 v2.3 kept", REPAIRS[rules.pickFinal(REPAIRS)].label === "draft" && rules.craftRankTotal(REPAIRS[0].craft) === 22, REPAIRS[rules.pickFinal(REPAIRS)].label);
      c.ok("…over the cap never wins while one at or under it exists, even with the best craft", rules.pickFinal([{ words: 111, mustFix: 0, craft: craftOf({ hook: 5, rehook: 5, buildup: 5, payoff: 5, close: 5 }) }, { words: 110, mustFix: 9, craft: craftOf({ hook: 1, rehook: 1, buildup: 1, payoff: 1, close: 1 }) }]) === 1 && rules.pickFinal([{ words: 120, mustFix: 3, craft: null }, { words: 112, mustFix: 3, craft: null }]) === 1);
      c.ok("…craft before must-fixes, the hook counted twice (5/3/3/3/4 = 23 beats 3/4/4/4/4 = 22, though its plain total is lower), then must-fixes, then words over 85", rules.pickFinal([{ words: 80, mustFix: 1, craft: craftOf({ hook: 3, rehook: 4, buildup: 4, payoff: 4, close: 4 }) }, { words: 80, mustFix: 3, craft: craftOf({ hook: 5, rehook: 3, buildup: 3, payoff: 3, close: 4 }) }]) === 1 && rules.pickFinal([{ words: 80, mustFix: 2, craft: craftOf({}) }, { words: 80, mustFix: 1, craft: craftOf({}) }]) === 1 && rules.pickFinal([{ words: 95, mustFix: 1, craft: craftOf({}) }, { words: 88, mustFix: 1, craft: craftOf({}) }]) === 1);
      // ... and in the automatic check: the draft had the best craft; the two fix rounds did not; it is kept (copied forward).
      ctl.reviews.set("Q", [["her_meaning"], ["her_meaning", "close"], ["her_meaning"]]);
      ctl.craft.set("Q", [{ hook: 5, rehook: 5, buildup: 5, payoff: 5, close: 5 }, {}, {}]);
      const rQ = await gen.generateScriptForTopic({ topicId: tQ, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const vsQ = await prisma.contentScriptVersion.findMany({ where: { scriptId: rQ.scriptId }, orderBy: { versionNo: "asc" } });
      const headQ = await prisma.contentScript.findUniqueOrThrow({ where: { id: rQ.scriptId } });
      const jQ = (await import("@/lib/scriptJudgeRecord")).readJudge(vsQ[vsQ.length - 1].validationJson);
      c.ok("automatic check (finishFlagged): still flagged after two fix rounds, the draft with the best craft is copied forward as current (v2.3 kept the newest on a tie of failures)", vsQ.length === 4 && headQ.currentVersionId === vsQ[3].id && vsQ[3].body === vsQ[0].body && jQ?.state === "flagged" && jQ.keptVersionNo === 1 && /kept v1, the better of the attempts/.test(vsQ[3].changeSummary ?? ""), `${vsQ.map((v) => `v${v.versionNo}`).join(",")} · kept ${jQ?.keptVersionNo}`);
    }

    c.head("17.2 · v2.4 gate calibration: check 13 at a total of 19, a 3 a flag; the picked hook's craft score is advice; generic_close a flag with a re-hook callback; -ing and -ed stems; tension");
    {
      const all = (craft: ReturnType<typeof craftOf>, o: { hookAdvisory?: boolean } = {}) => rules.mergeReview(modelFails({}), [], 70, craft, o);
      const c19 = all(craftOf({ buildup: 3 }));
      c.ok("4/4/3/4/4 (total 19): check 13 PASSES; the 3 is named as a flag", c19.find((x) => x.key === "craft")!.pass && /Total 19 of 25/.test(c19.find((x) => x.key === "craft")!.reason) && /Build-up 3 of 5: n \(a flag\)/.test(c19.find((x) => x.key === "craft")!.reason) && rules.mustFixFailures(c19).length === 0, c19.find((x) => x.key === "craft")!.reason);
      const c2 = all(craftOf({ hook: 5, rehook: 5, buildup: 5, payoff: 5, close: 2 }));
      const c18 = all(craftOf({ buildup: 3, close: 3 }));
      c.ok("…anything with a 2 fails at must-fix (5/5/5/5/2, total 22), and so does a total of 18 (4/4/3/4/3)", !c2.find((x) => x.key === "craft")!.pass && c2.find((x) => x.key === "craft")!.level === "must-fix" && (c2.find((x) => x.key === "craft")!.parts ?? []).join() === "close" && !c18.find((x) => x.key === "craft")!.pass && (c18.find((x) => x.key === "craft")!.parts ?? []).join() === "buildup,close");
      c.ok("the check text says so", (rules.REVIEW_CHECKS.find((x) => x.key === "craft")!.passes as string).includes("Passes on a total of 19 or more with no part at 2 or under; a part at 3 is a flag, not a must-fix.") && rules.CRAFT_TOTAL_PASS === 19 && rules.CRAFT_FAIL_AT === 2);
      const adv = all(craftOf({ hook: 2 }), { hookAdvisory: true });
      const notAdv = all(craftOf({ hook: 2 }), { hookAdvisory: false });
      c.ok("the picked hook scored 2: its score is ADVICE (check 3 and check 13 pass, the reason says so); a hook the writer changed scored 2 fails both at must-fix", adv.find((x) => x.key === "hook")!.pass && adv.find((x) => x.key === "craft")!.pass && /its craft score is advice/.test(adv.find((x) => x.key === "craft")!.reason) && !notAdv.find((x) => x.key === "hook")!.pass && notAdv.find((x) => x.key === "hook")!.level === "must-fix" && !notAdv.find((x) => x.key === "craft")!.pass);
      // The Backyard draft: the reviewer failed check 3 itself on the picked hook ("opens inside the clients' story with no belief the viewer holds").
      const advModel = rules.mergeReview(modelFails({ hook: "There is a real moment and a reversal, but it opens inside the clients' story with no belief the viewer holds." }), [], 83, craftOf({ hook: 3, buildup: 3 }), { hookAdvisory: true });
      const advBent = rules.mergeReview(modelFails({ hook: "A flat belief that bends her story: the lot was the only one left." }), [], 83, craftOf({}), { hookAdvisory: true });
      c.ok("…and the reviewer's own check-3 fail on the picked hook is advice (a flag) too, since the round keeps that hook locked; one that says it bends her story stays must-fix", advModel.some((x) => x.key === "hook" && !x.pass && x.level === "flag" && /^Advice \(the scored hook, unchanged\)/.test(x.reason)) && rules.mustFixFailures(advModel).length === 0 && advBent.some((x) => x.key === "hook" && !x.pass && x.level === "must-fix"));
      ctl.craft.set("R", [{ hook: 2 }]);
      ctl.reviews.set("R", [[]]);
      const rR = await gen.generateScriptForTopic({ topicId: tR, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const vR = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: rR.scriptId }, orderBy: { versionNo: "desc" } });
      const jR = (await import("@/lib/scriptJudgeRecord")).readJudge(vR.validationJson);
      c.ok("…end to end: the chosen hook, unchanged, scored 2 by the reviewer → passed, 13 of 13, no fix round", vR.versionNo === 1 && vR.hook === HOOK_WIN && jR?.state === "passed" && rules.reviewHeadline(jR.checks ?? []) === "Creative review: 13 of 13 pass" && jR.craft?.hook.score === 2, `${jR?.state} · ${rules.reviewHeadline(jR?.checks ?? [])}`);
      // generic_close: a flag, and a callback to the re-hook counts (Erica, "More Space").
      const SPACE_HOOK = "Cramped doesn't always mean your house is too small.";
      const SPACE_REHOOK = "One full bathroom for three kids is a space problem. Not seeing the kids while you cook is a layout problem.";
      const SPACE_CLOSE = "Tell me whether it's a space problem or a layout problem, and we'll plan the next home around it.";
      const withRehook = rules.craftFindings({ hook: SPACE_HOOK, points: [{ role: "re-hook", text: SPACE_REHOOK }], close: SPACE_CLOSE }).find((x) => x.key === "generic_close");
      const noRehook = rules.craftFindings({ hook: SPACE_HOOK, points: [], close: SPACE_CLOSE }).find((x) => x.key === "generic_close");
      c.ok("generic_close accepts a callback to the RE-HOOK (\"space problem ... layout problem\"); without the re-hook the same close is flagged, AS A FLAG", !withRehook && !!noRehook && noRehook.level === "flag" && /nothing from the hook or the re-hook/.test(noRehook.detail), noRehook?.detail);
      const SLEEP_HOOK = "The kids moved out, and the grandkids have nowhere to sleep.";
      const SLEEP_CLOSE = "No more sleeping on air mattresses. Tell me who you hope comes home.";
      c.ok("\"sleep\" and \"sleeping\" stem alike (and \"priced\", \"pricing\", \"price\"; \"running\", \"run\"), so a close that calls back \"sleep\" is not generic", rules.stemWord("sleeping") === rules.stemWord("sleep") && rules.stemWord("priced") === rules.stemWord("price") && rules.stemWord("pricing") === rules.stemWord("price") && rules.stemWord("running") === rules.stemWord("run") && rules.sharedWithHook(SLEEP_HOOK, SLEEP_CLOSE).join() === rules.stemWord("sleep") && !rules.craftFindings({ hook: SLEEP_HOOK, points: [], close: SLEEP_CLOSE }).some((x) => x.key === "generic_close"), rules.sharedWithHook(SLEEP_HOOK, SLEEP_CLOSE).join());
      c.ok("tension in the review's craft text: an implied stake, a surprise, and humor in a format agreed on the call (the shape described; no client's line quoted)", prompts.REVIEW_SYSTEM.includes("An implied stake (what the viewer stands to lose, left unsaid), a surprise (a turn the viewer did not see coming) and humor in a comedic format agreed on the call (a deadpan line that turns on its own words) all carry tension") && !/driving past at midnight/i.test(prompts.REVIEW_SYSTEM));
      // A flag-level finding on a must-fix check now fails it AS A FLAG (it used to keep the check's must-fix level).
      const longHook = rules.mergeReview(modelFails({}), [{ key: "hook_length", level: "flag", detail: "The hook is 17 words; one breath is 16 at most.", part: "hook" }], 70, craftOf({}));
      c.ok("a flag on a must-fix check fails it as a flag, never as a must-fix (the backyard hook's 17 words)", longHook.some((x) => x.key === "hook" && !x.pass && x.level === "flag") && rules.mustFixFailures(longHook).length === 0);
    }

    c.head("17.3 · v2.4 length: the aim trim before the first review at 87 words; the trim in fix rounds over 78; part budgets; a told story up to 110");
    {
      c.ok("nextWriterStep before any review: 87 → aim-trim; 78 → review; a told story at 100 → review; a fix round's version → review", pipe.nextWriterStep({ reviewed: false, mustFails: [], words: 87, fixRounds: 0, trimmed: false }) === "aim-trim" && pipe.nextWriterStep({ reviewed: false, mustFails: [], words: 78, fixRounds: 0, trimmed: false }) === "review" && pipe.nextWriterStep({ reviewed: false, mustFails: [], words: 100, fixRounds: 0, trimmed: false, story: true }) === "review" && pipe.nextWriterStep({ reviewed: false, mustFails: [], words: 90, fixRounds: 1, trimmed: false }) === "review");
      const e87 = reqs.filter((r) => r.step === "trim" && r.prompt.includes(TOPIC_E))[0]?.prompt ?? "";
      c.ok("…end to end (section 8d): the 87-word draft was trimmed toward 65 to 75 before any review", /LENGTH TRIM: this version is 87 spoken words/.test(e87) && reqs.findIndex((r) => r.step === "trim" && r.prompt.includes(TOPIC_E)) < reqs.findIndex((r) => r.step === "review" && r.prompt.includes(TOPIC_E)));
      const failing = rules.mergeReview(modelFails({ payoff: "does not answer the hook" }), [], 80, craftOf({}));
      c.ok("writerFixInstruction carries the trim whenever words exceed 78 (80: yes; 78: no); a told story only over the cap", /LENGTH TRIM: this version is 80 spoken words[\s\S]*Trim it toward 65 to 75/.test(pipe.writerFixInstruction({ checks: failing, words: 80 })) && !/LENGTH TRIM/.test(pipe.writerFixInstruction({ checks: failing, words: 78 })) && !/LENGTH TRIM/.test(pipe.writerFixInstruction({ checks: failing, words: 100 }, [], { story: true })) && /It is her told personal story, which may use up to 110 spoken words: trim it to 110 words or fewer/.test(pipe.writerFixInstruction({ checks: failing, words: 115 }, [], { story: true })));
      c.ok("PART_WORDS: hook 14, re-hook 16, build-up 22, payoff 16, close 18", JSON.stringify(rules.PART_WORDS) === JSON.stringify({ hook: 14, rehook: 16, buildup: 22, payoff: 16, close: 18 }) && rules.LENGTH_RULE.includes("hook 14 words, re-hook 16, build-up 22, payoff 16, close 18"));
      // Real v2.3 parts over budget: Erica's pricing hook (16), her empty-nester re-hook (24), John's listing-phrases build-up (24), Marcee's 2022 close (25).
      const pl = rules.partLengthFindings({
        hook: PRICE_HOOK,
        points: [
          { role: "re-hook", text: "Then why are the empty nesters I'm building for at Helings at Sussex choosing about 6,000 square feet, with giant pools for the grandkids?" },
          { role: "build-up", text: "Cozy? Small. Bring your imagination? It's a dump. Original owners? Never been updated. Unique layout? You'll be renovating. Great bones? A lot of work." },
          { role: "payoff", text: "The friendlier the word, the plainer the truth. Know it before you tour." },
        ],
        close: "Before you count on a weekend sale, ask me what your home would sell for today and what to do before listing. I'll be honest.",
      });
      c.ok("part_length flags each part over its budget (hook 16 > 14, re-hook 24 > 16, build-up 24 > 22, close 25 > 18; the 13-word payoff passes), as flags against Nothing extra", pl.map((x) => `${x.part}:${x.level}:${x.check}`).join(",") === "hook:flag:nothing_extra,rehook:flag:nothing_extra,buildup:flag:nothing_extra,close:flag:nothing_extra" && pl.every((x) => /is \d+ words; its budget is \d+/.test(x.detail)), pl.map((x) => x.detail).join(" | "));
      const hn = rules.hardNumbers({ hook: "My clients wanted to step from the kitchen straight out to the pool. Their lot said no.", points: [{ role: "re-hook", text: "The only lot left was a walkout basement, so we used the slope." }], close: "Bring me the lot." }, "");
      c.ok("…a 17-word hook is hook_length (one breath), not counted twice as part_length", hn.findings.some((x) => x.key === "hook_length") && !hn.findings.some((x) => x.key === "part_length" && x.part === "hook"));
      c.ok("a told story: its build-up and payoff budgets do not apply; 86 to 110 passes the length check without the long advice", rules.partLengthFindings({ hook: "h", points: [{ role: "re-hook", text: "r" }, { role: "build-up", text: words(40) }, { role: "payoff", text: words(30) }], close: "c" }, { story: true }).length === 0 && rules.lengthCheck(100, { story: true }).pass && !rules.lengthCheck(100).pass && rules.lengthCheck(100).level === "flag" && !rules.lengthCheck(111, { story: true }).pass);
      const storyBrief = pipe.briefFrom({ videoType: "story" }, []);
      c.ok("…a story's brief targets about 95 words inside 55 to 110; its draft is asked to tell it in order, never padded; the length rule says so", storyBrief.target.words === 95 && storyBrief.target.aim.join() === "55,110" && prompts.draftLengthAsk(storyBrief) === prompts.DRAFT_LENGTH_ASK_STORY && /never pad it to reach a number/.test(prompts.DRAFT_LENGTH_ASK_STORY) && prompts.draftLengthAsk(pipe.briefFrom({}, [])) === prompts.DRAFT_LENGTH_ASK && rules.LENGTH_RULE.includes("An educational script aims for 85 words or fewer. A told personal story (the brief says the video is a personal story) may use up to 110 words"));
    }

    c.head("17.4 · v2.4 the build-up in full sentences: the house rule, and a flag for a colon list or a verbless sentence");
    {
      c.ok("HOUSE_CRAFT_RULES (EDUCATIONAL): the build-up is one beat in full spoken sentences; the insight is the proof when her story will not fit", rules.HOUSE_CRAFT_RULES.includes("The build-up is one beat in full spoken sentences: what happened, then what changed. When her story cannot be told clearly in about 25 words, or she called it a weak example, the insight is the proof.") && rules.HOUSE_CRAFT_RULES.indexOf("full spoken sentences") > rules.HOUSE_CRAFT_RULES.indexOf("EDUCATIONAL VIDEOS:") && prompts.WRITER_SYSTEM.includes(rules.HOUSE_CRAFT_RULES));
      const marcee = rules.buildupFragments("Quick sales still happen, but nothing like it was in 2022. Buyers are decidedly more choosy: inspections, negotiating, an appraisal.");
      const john = rules.buildupFragments("Cozy? Small. Bring your imagination? It's a dump. Original owners? Never been updated. Unique layout? You'll be renovating. Great bones? A lot of work.");
      const erica = rules.buildupFragments("I had clients who wanted to walk out from their kitchen straight to the pool. Their lot was a walkout basement. Different grade, different layout.");
      const full = rules.buildupFragments("One couple wanted $1.4 million. I showed proof it was worth $1.2 at most. Another agent said yes, it sat, and they fired that agent.");
      c.ok("Marcee's 2022 colon list, John's \"Original owners? ... Great bones?\" and Erica's \"Different grade, different layout.\" are flagged; a beat told in full sentences is not", marcee.some((x) => /colon list/.test(x.detail)) && john.some((x) => /no verb/.test(x.detail) && /"Original owners\?"/.test(x.detail) && /"Unique layout\?"/.test(x.detail)) && erica.some((x) => /"Different grade, different layout\."/.test(x.detail)) && full.length === 0 && [...marcee, ...john, ...erica].every((x) => x.level === "flag" && x.check === "story" && x.part === "buildup"), [...marcee, ...john, ...erica].map((x) => x.detail).join(" | "));
      const mergedFrag = rules.mergeReview(modelFails({}), erica, 70, craftOf({}));
      c.ok("…merged, it fails Story holds together as a flag (never a must-fix)", mergedFrag.some((x) => x.key === "story" && !x.pass && x.level === "flag") && rules.mustFixFailures(mergedFrag).length === 0);
    }

    c.head("17.5 · v2.4 unsafe or used proofs: a live deal and a story she already filmed are never the proof");
    {
      c.ok("LIVE_DEAL_RE: \"just wrote an offer\", \"made an offer\", \"on the market for over\", \"currently\", \"under contract now\"", ["I have a client that just wrote an offer on a property", "we made an offer Tuesday", "it's been on the market for over a month", "it's currently listed at", "the house is under contract now"].every((t) => pipe.LIVE_DEAL_RE.test(t)) && !pipe.LIVE_DEAL_RE.test("the house sat for a month and the seller fired that agent"));
      // Marcee, "This Is Not 2022": the brief's proof cited P5, where her buyer "just wrote an offer" on the listing.
      const P = (id: string, quote: string, time: string | null) => ({ id, source: "strategy call of Oct 15, 2026", time, speaker: "client", kind: "story", quote, context: quote, why: "" });
      const mPass = [
        P("P2", "They've gotten accustomed to expecting the house to sell in a matter of days, if not hours, for over asking with multiple offers and without any contingencies.", "01:23:04"),
        P("P3", "Buyers have become decidedly more choosy and they are experiencing, you know, being able to get deals on properties again.", "01:23:04"),
        P("P5", "I have a client that just wrote an offer on a property that um it's it's in good condition, but nothing's been updated in years. Um, it's grossly overpriced in comparison to everything else that's on the market in that neighborhood.", "01:24:42"),
        P("P6", "and in trying to have a conversation with her about, you know, meeting in the middle and having realistic expectations when it's been on the the market for over a month.", "01:26:08"),
      ];
      const m2022 = pipe.briefFrom({
        videoType: "educational",
        proof: { text: "A seller's house, in good condition but not updated in years, was priced about $20,000 above a fully updated house with nearly the same floor plan nearby. It sat on the market over a month, and the seller held to 2022 expectations.", source: "P5, P6 (call at 01:26:08)", isHerStory: true },
        mustKeep: [
          { text: "Sellers still expect the 2022 sale: house gone in days or hours, over asking, several offers, no conditions.", source: "P2" },
          { text: "Proof: a seller priced an un-updated house about $20,000 above a fully updated near-identical one, expected 2022 terms, refused inspections, and the house sat over a month.", source: "P5, P6" },
          { text: "Buyers are choosier: they expect inspections, negotiation on the findings, and an appraisal that supports the price.", source: "P3, P4" },
        ],
      }, mPass);
      c.ok("Marcee's 2022 proof (P5: \"just wrote an offer\") is moved to excluded, isHerStory cleared, and its must-keep goes with it; the other two stay", m2022.proof === null && !pipe.proofIsHerStory(m2022, mPass) && /^The proof: A seller's house/.test(m2022.excluded[0]?.text ?? "") && /a deal still in progress \(P5: "just wrote an offer"\)/.test(m2022.excluded[0]?.reason ?? "") && m2022.excluded.some((x) => /^Proof: a seller priced an un-updated house/.test(x.text)) && m2022.mustKeep.map((x) => x.source).join("|") === "P2|P3, P4", JSON.stringify([m2022.proof, m2022.excluded.map((x) => x.reason.slice(0, 50)), m2022.mustKeep.map((x) => x.source)]));
      c.ok("…and the brief text the writer reads has no \"one proof\" line, but says why it is excluded", !/The one proof/.test(prompts.briefText(m2022)) && /Excluded:\n- The proof: A seller's house[^\n]*a deal still in progress/.test(prompts.briefText(m2022)));
      // Erica, "I Once Watched a Deal Fall Apart Over a Doorknob": the proof was the Red Bud $1,000 story she filmed in August.
      const FILMED = { title: "What It Feels Like When a Deal Almost Falls Apart", text: "A seller of mine wouldn't budge on $1,000. The buyers walked and bought something else. Deals don't fall apart all at once. It happens in small moments." };
      const ePass = [P("P2", "like frustration, right? Frustration that you're arguing over a door knob.", "00:57:11"), P("P5", "Um, so the seller wanted to she wouldn't even negotiate $1,000, which in the grand scheme of things, was that worth it? No. I mean, she lost out on an offer at So,", null)];
      const RED_BUD = "A Red Bud seller would not negotiate $1,000 on her $609K listing and lost a $601K offer. The deal re-formed with a new buyer at $599K, then nearly fell apart again when a relocation company added unauthorized language. Erica saved it by telling the seller to stop pushing.";
      const used = rules.usedStory(RED_BUD, [FILMED]);
      c.ok("the used-story check: the Red Bud $1,000 story matches her filmed August script (a shared figure and three or more shared words)", !!used && used.title === FILMED.title && used.figures.includes("1000") && used.words.length >= rules.USED_STORY_WORDS, JSON.stringify(used));
      c.ok("…figures are read as stories say them: \"$1.2 million\", \"$609K\", \"a thousand dollars\"; a bare year is not a figure; her pricing story does not match the $1,000 script", rules.storyFigures("$1.2 million and $609K").join() === "1200000,609000" && rules.storyFigures("she dug in on a thousand dollars").join() === "1000" && rules.storyFigures("like it's 2022").length === 0 && rules.usedStory("Sellers wanted $1.4 million; she showed it was worth $1.2 million at most; another agent said yes and it sat.", [FILMED]) === null);
      const door = pipe.briefFrom({
        videoType: "educational",
        proof: { text: RED_BUD, source: "F1, P5 (older call 2026-03, around 00:07:49)", isHerStory: true },
        mustKeep: [
          { text: "Frustration over something small, like arguing over a doorknob, is the pressure that can kill a deal.", source: "P2" },
          { text: "Proof: a seller who would not move $1,000 lost a real offer, and the deal later nearly fell apart again until Erica told her to stop pushing.", source: "P5" },
          { text: "How she helps: she holds back her own frustration, puts herself in both people's shoes, remembers each side's goal to buy or sell, and asks how to get there.", source: "P3" },
        ],
      }, ePass, [], { onCamera: [{ title: "Why Honesty Matters More Than Winning", text: "I tell you the truth even when it is not what you want to hear." }, FILMED] });
      c.ok("Erica's doorknob brief: the Red Bud proof is moved to excluded as a story she already told on camera, naming the script; its must-keep goes too", door.proof === null && /a story she has already told on camera \("What It Feels Like When a Deal Almost Falls Apart": 1000/.test(door.excluded[0]?.reason ?? "") && door.excluded.some((x) => /^Proof: a seller who would not move \$1,000/.test(x.text)) && door.mustKeep.length === 2 && !door.mustKeep.some((x) => /1,000/.test(x.text)), JSON.stringify([door.excluded.map((x) => x.reason.slice(0, 80)), door.mustKeep.map((x) => x.source)]));
      c.ok("the brief prompt: a story she has already told on camera is never this video's proof", prompts.BRIEF_SYSTEM.includes("A story she has already told on camera is never this video's proof."));
      // End to end, offline: the brief's proof is a story in a script from her filmed archive (every approved or filmed script is checked).
      await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, title: "The Inspection That Caught The Roof", body: "My seller paid $350 for a pre-listing inspection. It caught the roof before the buyer had leverage, and we fixed it on her terms.", source: "import", historical: true, status: "APPROVED", createdAt: new Date("2026-08-01T00:00:00Z") } });
      ctl.brief.set("S", {
        proof: { text: "She had a seller do the pre-listing inspection, $350 to $500, and it caught the roof before the buyer had leverage.", source: "P1", isHerStory: true },
        mustKeep: [{ text: "Proof: the $350 pre-listing inspection that caught the roof", source: "P1" }, { text: "Spend on what buyers and their agents judge", source: "P2" }],
      });
      ctl.reviews.set("S", [[]]);
      const s0 = reqs.length;
      const offS = await pipe.draftOffline({ topicId: tS, monthId: f.monthId, requestedBy: STAFF });
      const draftS = reqs.slice(s0).find((r) => r.step === "draft")?.prompt ?? "";
      c.ok("offline end to end: the stored brief has no proof; it is excluded naming the filmed script; the draft prompt carries no \"one proof\"", offS.record.brief.proof === null && /a story she has already told on camera \("The Inspection That Caught The Roof": 350/.test(offS.record.brief.excluded[0]?.reason ?? "") && offS.record.brief.mustKeep.map((x) => x.text).join() === "Spend on what buyers and their agents judge" && !/The one proof/.test(draftS) && /Excluded:\n- The proof: She had a seller do the pre-listing inspection/.test(draftS), JSON.stringify([offS.record.brief.proof, offS.record.brief.excluded[0]]));
    }

    c.ok("nothing left the drill but the faked model", fence.blocked.length === 0 && fence.faked.every((u) => u === "https://api.anthropic.com/v1/messages"), fence.blocked.join(", "));
  } finally {
    quiet.restore();
    // Let the pool's sockets close while PGlite is still open: a socket that
    // closed after db.close() crashed the socket server's teardown.
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });

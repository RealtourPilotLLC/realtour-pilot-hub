// ---------------------------------------------------------------------------
// DRILL: the new script writer (Oct 22 2026, src/lib/scriptWriter), phases 1
// and 2 of the scripting plan, the one-time fact cleanup, and (Oct 23 2026)
// writer v2.6, ONE THOUGHT.
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
//    3. facts: a client-spoken unreviewed fact reaches the brief (labelled),
//       a TEAM fact, a production preference and a fact Jordan said do not
//    4. voice: a discontinued series is skipped; the same-subject script goes
//       to the brief; the writer sees one earlier script for her voice
//    5. the topic description is labelled our assumption; the title a label
//    6. the brief is saved with the version, its quotes verified
//    7. v2.6: ONE drafting call writes all five parts (no hooks step)
//    8. v2.6, the loop on the version trail: the review reads as a viewer
//       first; a failure (the reviewer's read, or a hard check by code: the
//       cap, a dash, a duration, a number or a quotation not in her sources,
//       a live deal) gets ONE whole rewrite with the reason, never a part
//       patch; the rewrite is current only when it reads better; never a
//       second; a person's edit, revision or trim is left alone; draftOffline
//       takes the same steps
//    9. the close and the length: the brief's rules, the writer's short ones
//   10. a script already shared with the client is never touched by any of this
//   11. the switch off: the writer the hub had keeps its model and request
//   12. a person's revision keeps the whole instruction
//   13. the fact cleanup: the dry run writes nothing and sorts a fixture set
//       correctly; --apply is compare-and-set, idempotent and resumable
//   14. the listening fix (Oct 22 2026, LISTENING.md): with "Jordan Spackman
//       TEST" enrolled, Jordan's lines still reach the writer and only a real
//       other client's turn goes; her older calls are read by HER words in a
//       second retrieval; an accepted fact from an older month reaches the
//       brief, a month-bound one does not; the brief caps must-keep and never
//       keeps a live deal; no client's finals in any rule
//   15. the craft rules that stayed: the brief's (the proof is her story, how
//       she helps once, the close, plain words, an agreed format) and code's
//       advice (a hedged or echoing re-hook, a template close, jargon)
//   16. the model map: each step's model and effort, the cached prefix of the
//       second review byte for byte, and the cost of each model
//   17. unsafe or used proofs (v2.4): a live deal and a story she already
//       filmed are never the proof
//   18. the live deal never reaches the script (v2.5); the build-up advice;
//       the brief's contradiction rule
//   19. v2.6 itself: the short prompt in full; the bar: scripts Jordan
//       approved and sent to OTHER clients, picked at draft time (never
//       hers, never one another login approved, never over length, dashed,
//       imported or a skit, one per client; none qualifying, none shown);
//       the review's four questions and its read; calls per script; a v2.5
//       record mid-loop
//   Sections 2 to 18 were re-pointed for v2.6 where the behaviour changed on
//   purpose: the hooks step, the trims, the fix rounds that patched one part,
//   the runner-up hook, the craft gate and the third round are gone, and the
//   house rules other than the hard ones are advice, not must-fix.
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
const TOPIC_H = "Offline Topic That Passes First Time";
const TOPIC_I = "Offline Topic Whose Rewrite Reads Better";
const TOPIC_G = "A Topic Whose Draft Quotes A Seller";
const TOPIC_J = "Offline Topic Whose Rewrite Reads Worse";
// v2.6
const TOPIC_K = "A Topic A Person Edits Before Its Review";
const TOPIC_L = "A Topic Left Mid Loop By The Old Writer";
const TOPIC_S = "Offline Topic Whose Proof Was Filmed Before";
const TOPIC_T = "Offline Topic With A Deal Still In Progress";
const LIVE_LINE = "The listing down the street is priced $20,000 over a fully updated twin, and it still sits.";
const CONCEPT_A = "Items buyers and inspectors flag every single time, and most are never cosmetic.";
// 14 words (rules.PART_WORDS.hook).
const HOOK_WIN = "The repairs you think your house needs might not be where your money goes.";
const HOOK_WIN_B = "I loved working in senior living. So why did I leave?";
/** v2.6: what the fake writer answers for the hook of the one whole rewrite (14 words: the whole script is new). */
const REWRITE_HOOK = "Most of what you would fix before listing is not what the buyers judge.";
/** v2.6: a seller's line nobody said, as the Doorknob hook had one (code fails it: a quotation her sources do not contain). */
const INVENTED_QUOTE_LINE = "My seller told me, \"I'm not replacing a doorknob for them. If they push, they can walk.\" It cost her $4,700.";

/** v2.6, the bar (scriptWriter/barExamples): an OWNER login and a creative manager's (ADMIN), and the hooks of the scripts seeded as released. */
const OWNER_EMAIL = "owner@drill.test";
const JAMES_EMAIL = "james@drill.test";
const HOOK_ONE_OLD = "Older pick from the first agent, never shown beside her newer one.";
const HOOK_ONE_NEW = "Newer pick from the first agent, shown first because it went out last.";
const HOOK_TWO_JAMES = "A script the creative manager approved, never the bar.";
const HOOK_TWO_LONG = "A script that runs far past the cap for the drill.";
const HOOK_TWO_DASH = "A script whose build-up carries a dash for the drill.";
const HOOK_TWO_SHORT = "A script too short to be the bar for the drill.";
const HOOK_TWO_GOOD = "Steady pick from the second agent, sent early in the month.";
const HOOK_THREE_IMPORT = "An imported script from the filmed archive, never the bar.";
const HOOK_THREE_SKIT = "A skit with two speakers that the bar never shows.";
const HOOK_THREE_SAME = "Third agent pick that shares its title with a drill topic.";
const HOOK_HERS = "One of her own released scripts, never her own bar.";

// ---- the fake Anthropic API ------------------------------------------------------
type Req = { step: string; body: Record<string, unknown>; headers: Record<string, string>; system: string; prompt: string };
const reqs: Req[] = [];
const ctl = {
  refuse: null as string | null,
  truncate: 0,
  rejectBeta: false,
  /** Per topic: the word counts of [rehook, buildup, payoff, close] for each successive writer answer (the draft, then the rewrite). */
  sizes: new Map<string, number[][]>(),
  /** v2.6: per topic, a queue of review answers: the viewer's questions that fail (sense, voice, hook, invented). */
  reviews: new Map<string, string[][]>(),
  /** v2.6: per topic, a queue of the review's 1 to 10 read (8 when nothing fails, 4 when something does). */
  reads: new Map<string, number[]>(),
  /** v2.4: per topic, fields merged into the fake brief (a proof, must-keep points). */
  brief: new Map<string, Record<string, unknown>>(),
  /** v2.5: per topic, a queue of sentences added to the build-up of each successive writer answer ("" adds none). */
  extra: new Map<string, string[]>(),
};
const usage = { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// v2.3 (the model map): the fake answers as the model the request named, as the API does.
let answeringModel = "claude-opus-5-5";
const ok = (json: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "msg_drill", type: "message", role: "assistant", model: answeringModel, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(json) }], stop_reason: "end_turn", usage, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
const TOPICS: [string, string][] = [["A", TOPIC_A], ["B", TOPIC_B], ["C", TOPIC_C], ["E", TOPIC_E], ["F", TOPIC_F], ["H", TOPIC_H], ["I", TOPIC_I], ["G", TOPIC_G], ["J", TOPIC_J], ["K", TOPIC_K], ["L", TOPIC_L], ["S", TOPIC_S], ["T", TOPIC_T]];
const topicOf = (prompt: string) => TOPICS.find(([, title]) => prompt.includes(title))?.[0] ?? "?";
/** v2.3: a user message sent as blocks (the cache breakpoints) reads as the blocks' texts joined, like StepPrompt.prompt. */
const promptOf = (content: unknown) => (Array.isArray(content) ? (content as { text?: string }[]).map((b) => b.text ?? "").join("\n\n") : String(content ?? ""));
/** The hook's longest word: the fake writer's close calls it back (a close with nothing from the hook is advice: generic_close). */
const callbackWord = (hook: string) => hook.replace(/[^A-Za-z ]+/g, " ").split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), "").toLowerCase();
const stepOf = (system: string, prompt: string) =>
  /^You read call transcripts for ONE video topic/.test(system) ? "retrieval"
  : /^You write the TOPIC BRIEF/.test(system) ? "brief"
  : /^You write ONE short video script/.test(system) ? (/THE VERSION THAT DID NOT WORK/.test(prompt) ? "rewrite" : /THE TRIM INSTRUCTION/.test(prompt) ? "trim" : /CURRENT VERSION \(v/.test(prompt) ? "revise" : "draft")
  : /^You read ONE short video script the way a viewer would hear it/.test(system) ? "review"
  : /^You write FIVE hooks/.test(system) ? "hooks"
  : /^You sort ONE real estate agent's recorded facts/.test(system) ? "cleanup"
  : /You are the quality judge/.test(system) ? "old-judge"
  : /writing ONE personal-branding video script/.test(system) ? "old-script"
  : "other";

function writerAnswer(t: string, step: string) {
  const queue = ctl.sizes.get(t) ?? [];
  // A 12-word re-hook (its budget) and an 18-word build-up: 71 spoken words with the hook.
  const sz = queue.shift() ?? [12, 18, 15, 12];
  ctl.sizes.set(t, queue);
  // v2.6: the draft writes its own hook; the one whole rewrite writes a new one (nothing is copied back).
  const hook = step === "rewrite" ? REWRITE_HOOK : t === "B" ? HOOK_WIN_B : HOOK_WIN;
  const cb = callbackWord(hook);
  const tail = (n: number, offset: number) => `${words(Math.max(1, n - 1), offset).replace(/\.$/, "")} ${cb}.`;
  const extras = ctl.extra.get(t) ?? [];
  const extra = extras.shift() ?? "";
  ctl.extra.set(t, extras);
  const o = step === "rewrite" ? 2 : 0;
  return {
    title: step === "draft" ? `Draft for ${t}` : `Revised ${t}`, hook,
    rehook: words(sz[0], 1 + o), buildup: `${words(sz[1], 3 + o)}${extra ? ` ${extra}` : ""}`, payoff: words(sz[2], 5 + o), close: t === "A" ? `Before you change everything, ${tail(Math.max(2, sz[3] - 4), 7)}` : tail(sz[3], 9 + o),
    closeType: "cta", captionCta: "Send me a message to plan your prep.", filmingNotes: "",
    rationale: { hook: "It names the belief a homeowner already has.", takeaway: "Spend where buyers look.", strategy: "Her seller pillar and her inspection process." },
    sourcesUsed: ["P1"], gaps: [],
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
    case "draft": case "rewrite": case "trim": case "revise":
      return ok(writerAnswer(t, step));
    case "review": {
      const queue = ctl.reviews.get(t) ?? [];
      const failing = queue.shift() ?? [];
      ctl.reviews.set(t, queue);
      const rq = ctl.reads.get(t) ?? [];
      const reads = rq.shift() ?? (failing.length ? 4 : 8);
      ctl.reads.set(t, rq);
      const ans = (k: string) => ({ pass: !failing.includes(k), reason: failing.includes(k) ? `REVIEW NOTE ${k}: it does not hold together as one thought.` : "Reads as one thought." });
      return ok({ sense: ans("sense"), voice: ans("voice"), hook: ans("hook"), invented: ans("invented"), reads, note: failing.length ? "REWRITE NOTE: the hook asks one thing and the payoff answers another; tell it as one thought from her inspection process." : "", summary: failing.length ? "Not yet." : "Strong." });
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
      topics: [TOPIC_A, TOPIC_B, TOPIC_C, TOPIC_D, TOPIC_E, TOPIC_F, TOPIC_H, TOPIC_I, TOPIC_G, TOPIC_J, TOPIC_K, TOPIC_L, TOPIC_S, TOPIC_T].map((title) => ({ title, selection: "SELECTED" as const, source: "ai" })),
    });
    const [tA, tB, tC, tD, tE, tF, tH, tI, tG, tJ, tK, tL, tS, tT] = f.topicIds;
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
    // v2.6, THE BAR (scriptWriter/barExamples): scripts approved by an OWNER login and sent to OTHER clients.
    // An owner and a creative manager (ADMIN); three other clients; one of hers.
    await prisma.appUser.create({ data: { email: OWNER_EMAIL, role: "OWNER", status: "ACTIVE" } });
    await prisma.appUser.create({ data: { email: JAMES_EMAIL, role: "ADMIN", status: "ACTIVE" } });
    const { createScriptVersion } = await import("@/lib/contentScripts");
    const barClient = async (name: string) => { const cl = await prisma.client.create({ data: { name } }); const en = await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Pro", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } }); return { clientId: cl.id, enrollmentId: en.id }; };
    /** One released script: the hook given, a 12-word re-hook, a build-up of `build` words, a 14-word payoff, a 12-word close. */
    const sent = async (who: { enrollmentId: string }, title: string, hook: string, o: { at: string; by?: string; source?: string; build?: number; dash?: boolean; skit?: boolean }) => {
      const build = `${words(o.build ?? 20, 2).replace(/\.$/, "")}${o.dash ? " — and that is the point" : ""}.`;
      const r = await createScriptVersion({ enrollmentId: who.enrollmentId, parts: { title, hook, points: [{ role: "re-hook", text: words(12, 1) }, { role: "build-up", text: build }, { role: "payoff", text: words(14, 4) }], close: words(12, 6), ...(o.skit ? { speakerLabels: ["AGENT", "BUYER"] } : {}) }, source: "AI", createdBy: "drill", status: "INTERNAL_REVIEW" });
      // Every version written through the hub loses its dashes (the no-dash rule), so a dashed script is put on the row as an older one would sit there.
      if (o.dash) await prisma.contentScriptVersion.update({ where: { id: r.versionId }, data: { pointsJson: JSON.stringify([{ role: "re-hook", text: words(12, 1) }, { role: "build-up", text: build }, { role: "payoff", text: words(14, 4) }]) } });
      await prisma.contentScript.update({ where: { id: r.scriptId }, data: { source: o.source ?? "ai", approvedAt: new Date(o.at), approvedBy: o.by ?? OWNER_EMAIL, sharedAt: new Date(o.at), approvedVersionId: r.versionId, sharedVersionId: r.versionId } });
      return r.scriptId;
    };
    const barOne = await barClient("Olivia Barrow");
    const barTwo = await barClient("Peter Quillon");
    const barThree = await barClient("Rosa Dimarco");
    const BAR = {
      oneOld: await sent(barOne, "Staging Before You List", HOOK_ONE_OLD, { at: "2026-10-10T15:00:00Z" }),
      oneNew: await sent(barOne, "Why Your First Weekend Matters", HOOK_ONE_NEW, { at: "2026-10-12T15:00:00Z" }),
      twoJames: await sent(barTwo, "A Script James Approved", HOOK_TWO_JAMES, { at: "2026-10-15T15:00:00Z", by: JAMES_EMAIL }),
      twoLong: await sent(barTwo, "A Script That Runs Long", HOOK_TWO_LONG, { at: "2026-10-14T15:00:00Z", build: 82 }),
      twoDash: await sent(barTwo, "A Script With A Dash", HOOK_TWO_DASH, { at: "2026-10-13T15:00:00Z", dash: true }),
      twoShort: await sent(barTwo, "A Script That Is Too Short", HOOK_TWO_SHORT, { at: "2026-10-12T16:00:00Z", build: 2 }),
      twoGood: await sent(barTwo, "Pricing The First Week", HOOK_TWO_GOOD, { at: "2026-10-05T15:00:00Z" }),
      threeImport: await sent(barThree, "An Imported Script", HOOK_THREE_IMPORT, { at: "2026-10-11T15:00:00Z", source: "import" }),
      threeSkit: await sent(barThree, "A Skit", HOOK_THREE_SKIT, { at: "2026-10-10T16:00:00Z", skit: true }),
      threeSame: await sent(barThree, TOPIC_A, HOOK_THREE_SAME, { at: "2026-10-09T15:00:00Z" }),
      hers: await sent({ enrollmentId: f.enrollmentId }, "One Of Her Own", HOOK_HERS, { at: "2026-10-20T15:00:00Z" }),
    };

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
    c.head("2-7 · topic A: retrieval, facts, voice, assumptions, the brief; v2.6: ONE drafting call writes all five parts");
    const { readJudge: jr } = await import("@/lib/scriptJudgeRecord");
    const judgeLib = await import("@/lib/scriptJudge");
    const scriptsLib = await import("@/lib/contentScripts");
    const versionsOf = (scriptId: string) => prisma.contentScriptVersion.findMany({ where: { scriptId }, orderBy: { versionNo: "asc" } });
    const currentOf = async (scriptId: string) => { const h = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId } }); return { head: h, cur: await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: h.currentVersionId! } }) }; };
    const LOOP_STEPS = ["draft", "review", "rewrite", "trim", "revise", "hooks"];
    const loopOf = (rs: Req[]) => rs.filter((r) => LOOP_STEPS.includes(r.step)).map((r) => r.step).join(",");
    ctl.reviews.set("A", [[]]);
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
      // v2.3, the model map (pipeline STEP_MODEL / STEP_EFFORT); v2.6: no hooks step.
      const me = (r: Req | undefined) => `${r?.body.model}/${(r?.body.output_config as { effort?: string } | undefined)?.effort}`;
      c.ok("the model map: retrieval Haiku 5.5 medium, brief Sonnet 5.5 medium, draft Sonnet 5.5 high, review Sonnet 5.5 medium; no hooks step (v2.6)",
        me(ret) === "claude-haiku-5-5/medium" && me(step("retrieval")[1]) === "claude-haiku-5-5/medium" && me(step("brief")[0]) === "claude-sonnet-5-5/medium" && me(step("draft")[0]) === "claude-sonnet-5-5/high" && step("review").every((r) => me(r) === "claude-sonnet-5-5/medium") && step("hooks").length === 0 && !("hooks" in pipe.STEP_MODEL),
        ["retrieval", "brief", "draft", "review"].map((s) => `${s}=${me(step(s)[0])}`).join(" "));
      const STEP_OF: Record<string, keyof typeof pipe.STEP_MODEL> = { retrieval: "retrieval", brief: "brief", draft: "draft", review: "review", rewrite: "revise", trim: "revise", revise: "revise" };
      c.ok("every writer request: its step's model and effort exact (no date suffix), json_schema, no tool_choice, no temperature, top_p, top_k or thinking budget, version unchanged",
        mine.filter((r) => r.step !== "other").every((r) => r.body.model === pipe.STEP_MODEL[STEP_OF[r.step]] && (r.body.output_config as { effort: string }).effort === pipe.STEP_EFFORT[STEP_OF[r.step]] && !/\d{8}$/.test(String(r.body.model)) && (r.body.output_config as { format: { type: string } }).format.type === "json_schema" && !("tool_choice" in r.body) && !("temperature" in r.body) && !("top_p" in r.body) && !("top_k" in r.body) && !("thinking" in r.body) && !JSON.stringify(r.body).includes("budget_tokens") && r.headers["anthropic-version"] === "2023-06-01"), mine.map((r) => r.step).join(","));
      c.ok("v2.6 calls per script: a draft that passes takes FIVE model calls (retrieval twice, the brief, the draft, the review)", mine.map((r) => r.step).join(",") === "retrieval,retrieval,brief,draft,review", mine.map((r) => r.step).join(","));

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
      const review = step("review")[0]?.prompt ?? "";
      // v2.6: the brief reads her facts and chooses; the draft is given the brief and her words, not every fact on file.
      c.ok("a client-spoken fact nobody reviewed reaches the brief, labelled \"not reviewed yet\"", /Recommends the pre-listing inspection to every seller[^\n]*not reviewed yet/.test(brief));
      c.ok("…an accepted fact too (and the review reads them, to check nothing is invented)", brief.includes("Her husband Dan is a professional renovator") && /renovator[^\n]*\(accepted\)/.test(brief) && review.includes("Her husband Dan is a professional renovator"));
      c.ok("a TEAM fact, a production preference and a fact Jordan said do not, anywhere", ![brief, draft, review].some((p) => p.includes("checklist mailed") || p.includes("Tuesday mornings") || p.includes("Jordan suggested a series")));
      c.ok("voice: no script of the discontinued series is shown as an example, anywhere", ![brief, draft, review].some((p) => /Fairy God Realtor Tip/.test(p)));
      c.ok("…and the guard tells the writer the series is discontinued", /DISCONTINUED: "Fairy God Realtor"/.test(draft));
      c.ok("…the same-subject filmed script reaches the brief, labelled why", /HER EARLIER SCRIPTS ON THE SAME SUBJECT[\s\S]*Why Pre-Listing Inspections Can Make Sellers More Money \(a script from her filmed archive, same subject\)/.test(brief));
      c.ok("…the writer sees her voice: an earlier script of hers, labelled as her voice and never its lines or stories", /HOW SHE SOUNDS ON CAMERA \(her earlier scripts; her voice, never their lines or their stories\):\n--- Why Honesty Matters More Than Winning ---/.test(draft), (/HOW SHE SOUNDS[^\n]*\n[^\n]*/.exec(draft) ?? [""])[0]);
      void same;
      c.ok("the topic description is labelled OUR assumption in the brief, the title a label; the draft is never given our assumptions", /OUR ASSUMPTIONS ABOUT THIS TOPIC \(written by us or an AI; never a claim source, never her words\):\n- description: Items buyers and inspectors flag/.test(brief) && /TOPIC \(an organizing label, not spoken copy\): The Repairs That Actually Protect Your Sale/.test(brief) && /Topic \(a label, not a line to say\): The Repairs That Actually Protect Your Sale/.test(draft) && !draft.includes(CONCEPT_A));
      c.ok("…and the brief's rules say why (assumptions are never a claim source)", step("brief")[0]?.system.includes("OUR ASSUMPTIONS ARE NOT HER CLAIMS"));

      c.ok("the brief is saved with the version", !!w && /Spend on what buyers/.test(w.brief.centralMessage) && w.brief.closeType === "cta" && w.brief.ourAssumptions.some((a) => a.text === CONCEPT_A));
      c.ok("…what she said is the verified passages only (an id the brief made up is dropped)", w?.brief.whatSheSaid.length === 2 && w.brief.whatSheSaid[0].quote === Q_INSPECTION, JSON.stringify(w?.brief.whatSheSaid.map((x) => x.passageId)));
      c.ok("ONE drafting call writes all five parts: no hooks step, the prompt names the five parts, the hook on v1 is the draft's own, no alternates", step("draft").length === 1 && !mine.some((r) => /You write FIVE hooks/.test(r.system)) && ["- HOOK: the first line.", "- RE-HOOK:", "- BUILD-UP:", "- PAYOFF:", "- CLOSE:"].every((x) => step("draft")[0].system.includes(x)) && v1?.hook === HOOK_WIN && (w?.hooks.length ?? 1) === 0 && w?.chosen === -1 && (JSON.parse(v1?.alternateHooksJson ?? "[]") as string[]).length === 0 && !draft.includes("THE CHOSEN HOOK"), `${v1?.hook} · ${w?.hooks.length} hooks`);
      c.ok("the rationale is kept for the card", w?.rationale?.takeaway === "Spend where buyers look.");
      const j1 = jr(v1?.validationJson);
      c.ok("the review passed it first time: 11 of 11, its read kept (8), no rewrite", j1?.state === "passed" && (j1.checks ?? []).length === 11 && rules.reviewHeadline(j1.checks ?? []) === "Creative review: 11 of 11 pass" && j1.reads === 8 && j1.fixRounds === 0 && step("rewrite").length === 0, `${j1?.state} · ${rules.reviewHeadline(j1?.checks ?? [])} · ${j1?.reads}`);
      c.ok("…the one review ran on the writer path, its own kind (script_review), on Sonnet 5.5, counted apart from the client cap", (await prisma.programAiRun.count({ where: { kind: "script_review", enrollmentId: f.enrollmentId, model: "claude-sonnet-5-5" } })) === 1);
    }

    // =======================================================================
    c.head("8a · v2.6 the hard cap: a 134-word draft fails Length (code) → ONE whole rewrite, told why → 71 words, it reads better → current, passed");
    ctl.sizes.set("C", [[40, 36, 26, 18], [12, 18, 15, 12]]); // the draft: 14 + 120 = 134 words; the rewrite 14 + 57 = 71
    ctl.reviews.set("C", [[], []]);
    const c0 = reqs.length;
    const rC = await gen.generateScriptForTopic({ topicId: tC, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineC = reqs.slice(c0);
      const vs = await versionsOf(rC.scriptId);
      const { head, cur } = await currentOf(rC.scriptId);
      const j0 = jr(vs[0].validationJson), j1 = jr(vs[1]?.validationJson);
      c.ok("the 134-word draft is reviewed as written (no trim first): the reviewer passed all four questions, code failed the cap", vs[0].spokenWordCount === 134 && (j0?.checks ?? []).filter((x) => rules.VIEWER_CHECK_KEYS.includes(x.key)).every((x) => x.pass) && (j0?.checks ?? []).some((x) => x.key === "length" && !x.pass && x.level === "must-fix" && /A bit long: needs a fix: 134 words/.test(x.reason)), JSON.stringify(j0?.checks?.filter((x) => !x.pass)));
      const rw = mineC.filter((r) => r.step === "rewrite");
      c.ok("…ONE whole rewrite, told the reason in code's words; never a patch: no part kept, no hook chosen, no trim", rw.length === 1 && /THE VERSION THAT DID NOT WORK \(v1\):\nHOOK: The repairs you think/.test(rw[0].prompt) && /- Length: A bit long: needs a fix: 134 words/.test(rw[0].prompt) && rw[0].prompt.includes(prompts.REWRITE_ASK) && !/KEEP EXACTLY|copied back|THE CHOSEN HOOK|LENGTH TRIM/.test(rw[0].prompt), rw[0]?.prompt.slice(rw[0].prompt.indexOf("WHY"), rw[0].prompt.indexOf("WHY") + 300));
      c.ok("…in this order: draft, review, rewrite, review (no trim, no fix round): seven model calls in all", loopOf(mineC) === "draft,review,rewrite,review" && mineC.length === 7, mineC.map((r) => r.step).join(","));
      c.ok("v2 (71 words): reviewed, it reads better (no must-fix) → the current version, passed, one rewrite counted", vs.length === 2 && cur.id === vs[1].id && vs[1].spokenWordCount === 71 && j1?.state === "passed" && j1.fixRounds === 1 && j1.candidateOf === vs[0].id && vs[1].hook === REWRITE_HOOK, `${vs.map((v) => `v${v.versionNo}:${v.spokenWordCount}`).join(" ")} · ${j1?.state}`);
      c.ok("…its change summary says it was rewritten whole (the card's notes read \"polished by the AI after its own review\"); the brief carried forward", /^Auto-fixed: rewritten whole after the creative review read it as a viewer/.test(vs[1].changeSummary ?? "") && (await import("@/components/content/WriterNotes")).versionHow(vs[1].changeSummary, "AI") === "polished by the AI after its own review" && !!record.readWriter(vs[1].validationJson)?.brief, vs[1].changeSummary ?? "");
      const releases = await prisma.contentScriptRelease.count({ where: { scriptId: rC.scriptId } });
      c.ok("never shared: no approval, no release, nothing in the portal", !head.sharedVersionId && !head.approvedVersionId && releases === 0 && !head.clientVisible && cur.status === "INTERNAL_REVIEW");
      c.ok("the card's one-press fix still sends the trim instruction (a person's request; see 8f)", rules.trimInstruction(124).includes("124 spoken words") && rules.trimInstruction(124).includes("Never make it dry or incomplete") && rules.isLengthTrimInstruction(rules.trimInstruction(124)));
    }

    // =======================================================================
    c.head("8b · v2.6 the viewer's read: \"it does not make sense\" → ONE whole rewrite with the reviewer's note, never a part patch; it reads better → current");
    ctl.sizes.set("B", [[12, 18, 15, 12], [11, 17, 14, 12]]);
    ctl.reviews.set("B", [["sense"], []]);
    ctl.reads.set("B", [3, 8]);
    const b0 = reqs.length;
    const rB = await gen.generateScriptForTopic({ topicId: tB, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineB = reqs.slice(b0);
      const rw = mineB.filter((r) => r.step === "rewrite");
      c.ok("one rewrite, carrying the reviewer's note as a viewer and the failed question in its words", rw.length === 1 && /The reviewer, reading it as a viewer: REWRITE NOTE: the hook asks one thing/.test(rw[0].prompt) && /- One thought: REVIEW NOTE sense/.test(rw[0].prompt), String(rw.length));
      c.ok("…never a part patch: nothing kept or locked, no hook handed over, no fix-round wording", !/KEEP EXACTLY|copied back|THE CHOSEN HOOK|REDRAFT RULES|MUST FIX:/.test(rw[0]?.prompt ?? "") && /Do not patch the old version part by part/.test(rw[0]?.prompt ?? ""));
      c.ok("…the order: draft, review, rewrite, review; no second rewrite", loopOf(mineB) === "draft,review,rewrite,review", loopOf(mineB));
      const vs = await versionsOf(rB.scriptId);
      const { cur } = await currentOf(rB.scriptId);
      const v1p = pipe.partsOfVersion(vs[0]), v2p = pipe.partsOfVersion(vs[1]);
      c.ok("the whole script was written again: every part of v2 differs from v1 (code copied nothing back)", vs.length === 2 && rules.SCRIPT_PART_KEYS.every((k) => rules.partTextOf(v1p, k) !== rules.partTextOf(v2p, k)) && v2p.hook === REWRITE_HOOK, rules.SCRIPT_PART_KEYS.map((k) => `${k}:${rules.partTextOf(v1p, k) === rules.partTextOf(v2p, k) ? "same" : "new"}`).join(" "));
      const j1 = jr(vs[0].validationJson), j2 = jr(vs[1].validationJson);
      c.ok("v1 failed One thought (read 3); v2 passed (read 8) and is current", (j1?.checks ?? []).some((x) => x.key === "sense" && !x.pass && x.level === "must-fix") && j1?.reads === 3 && cur.id === vs[1].id && j2?.state === "passed" && j2.reads === 8, `${j1?.reads} → ${j2?.reads} · ${j2?.state}`);
    }

    // =======================================================================
    c.head("8c · v2.6 no second rewrite: the rewrite fails too → FLAGGED (quietly), the one that reads better is current; one rewrite, never two");
    ctl.sizes.set("E", [[12, 18, 15, 12], [12, 18, 15, 12]]);
    ctl.reviews.set("E", [["hook"], ["hook"]]);
    ctl.reads.set("E", [3, 5]);
    const e0 = reqs.length;
    const rE = await gen.generateScriptForTopic({ topicId: tE, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineE = reqs.slice(e0);
      c.ok("draft, review, ONE rewrite, review, and nothing more", loopOf(mineE) === "draft,review,rewrite,review", loopOf(mineE));
      const vs = await versionsOf(rE.scriptId);
      const { head, cur } = await currentOf(rE.scriptId);
      const jc = jr(cur.validationJson);
      c.ok("both fail \"The hook lands\"; the rewrite reads better (5 over 3), so it is current, FLAGGED, one rewrite counted", vs.length === 2 && cur.id === vs[1].id && jc?.state === "flagged" && jc.fixRounds === 1 && (jc.checks ?? []).some((x) => x.key === "hook" && !x.pass), `${cur.versionNo} · ${jc?.state}`);
      c.ok("…sorted first in the review queue (flagged), waiting for Jordan, never shared; the card's notes say nothing about it", (await import("@/lib/scriptJudgeRecord")).judgeFlagged(jc) && cur.status === "INTERNAL_REVIEW" && !head.sharedVersionId && !head.approvedVersionId);
      const p0 = reqs.length;
      const again = await judgeLib.autoCheckScript(rE.scriptId, { requestedBy: STAFF, unattended: false });
      const sweep = await judgeLib.sweepScriptChecks({ max: 10 });
      c.ok("the automatic check and the cron sweep run again: nothing is sent (no second rewrite, ever)", reqs.length === p0 && again.state === "flagged" && sweep.checked === 0, `${again.state} · ${reqs.slice(p0).map((r) => r.step).join(",")}`);
    }

    // =======================================================================
    c.head("8d · v2.6 a rewrite that reads worse stays in the history (set aside); the draft stays current, flagged");
    ctl.sizes.set("F", [[12, 18, 15, 12], [12, 18, 15, 12]]);
    ctl.reviews.set("F", [["voice"], ["voice", "sense"]]);
    ctl.reads.set("F", [5, 3]);
    const rF = await gen.generateScriptForTopic({ topicId: tF, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const vs = await versionsOf(rF.scriptId);
      const { cur } = await currentOf(rF.scriptId);
      const j1 = jr(vs[0].validationJson), j2 = jr(vs[1]?.validationJson);
      c.ok("v1 (one must-fix, read 5) stays current and FLAGGED; v2 (two must-fix, read 3) is set aside, kept in the history", vs.length === 2 && cur.id === vs[0].id && j1?.state === "flagged" && j1.fixRounds === 1 && j2?.state === "set_aside" && j2.keptInstead === 1, `${vs.map((v) => `v${v.versionNo}:${jr(v.validationJson)?.state}`).join(" ")}`);
    }

    // =======================================================================
    c.head("8e · v2.6 code catches an invented quote and an invented number though the reviewer passed every question → the one rewrite, told why");
    ctl.extra.set("G", [INVENTED_QUOTE_LINE, ""]);
    ctl.reviews.set("G", [[], []]);
    const g0 = reqs.length;
    const rG = await gen.generateScriptForTopic({ topicId: tG, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const vs = await versionsOf(rG.scriptId);
      const j1 = jr(vs[0].validationJson);
      const q = (j1?.checks ?? []).find((x) => x.key === "quotes"), n = (j1?.checks ?? []).find((x) => x.key === "numbers");
      c.ok("the draft quotes a seller nobody heard: Her quotes fails at must-fix by code", !!q && !q.pass && q.level === "must-fix" && /A quotation her sources do not contain: "I'm not replacing a doorknob for them\. If they push, they can walk\."/.test(q.reason), q?.reason);
      c.ok("…and its $4,700 is a number her sources do not contain: Her numbers fails at must-fix", !!n && !n.pass && n.level === "must-fix" && /4700/.test(n.reason), n?.reason);
      c.ok("…though the reviewer passed all four questions", (j1?.checks ?? []).filter((x) => rules.VIEWER_CHECK_KEYS.includes(x.key)).every((x) => x.pass));
      const rw = reqs.slice(g0).filter((r) => r.step === "rewrite");
      c.ok("the one rewrite is told both, in code's words; the rewrite carries neither and passes, current", rw.length === 1 && /- Her quotes: A quotation her sources do not contain/.test(rw[0].prompt) && /- Her numbers: Numbers the sources do not contain: 4700/.test(rw[0].prompt) && jr(vs[1]?.validationJson)?.state === "passed" && (await currentOf(rG.scriptId)).cur.id === vs[1].id);
      const real = rules.hardNumbers({ hook: "She put it plainly.", points: [{ role: "build-up", text: "In her words: \"I explain their options and I fiercely protect their interests.\" That is the job." }], close: "Call me." }, TRANSCRIPT);
      const scare = rules.hardNumbers({ hook: "Buyers want the \"right price\" more than ever.", points: [], close: "Call me." }, TRANSCRIPT);
      c.ok("pure: a quotation that IS in her call passes (case and punctuation aside); a two-word \"scare quote\" is not checked", !real.findings.some((x) => x.key === "invented_quote") && !scare.findings.some((x) => x.key === "invented_quote") && rules.inventedQuotes("He said “we walk away today”.", TRANSCRIPT).join() === "we walk away today");
    }

    // =======================================================================
    c.head("8f · v2.6 person-edited versions are left alone: a person's edit, revision or Fix with AI gets no review and no rewrite");
    {
      // a. A person's "Fix with AI" (the card's length trim): written as asked, never reviewed or undone (it was, until v2.6).
      const p0 = reqs.length;
      const t1 = await gen.reviseScript(rF.scriptId, rules.trimInstruction(96, ["She recommends a pre-listing inspection"]), STAFF, "REVISION");
      const tv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: t1.versionId } });
      c.ok("a person's Fix with AI: one trim call by the writer, then nothing; the trimmed version is current with no review owed", reqs.slice(p0).map((r) => r.step).join(",") === "trim" && !jr(tv.validationJson) && (await currentOf(rF.scriptId)).cur.id === tv.id && /^Trimmed toward 65 to 75 words/.test(tv.changeSummary ?? ""), reqs.slice(p0).map((r) => r.step).join(","));
      // b. A person's edit by hand of a draft whose review has not run yet (the check ran out of clock).
      ctl.reviews.set("K", [["sense"], []]);
      const k0 = reqs.length;
      const rK = await gen.generateScriptForTopic({ topicId: tK, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id, checkDeadline: Date.now() + 1_000 });
      const v1 = (await versionsOf(rK.scriptId))[0];
      c.ok("a draft whose check had no clock left: drafted, its review still owed (pending)", loopOf(reqs.slice(k0)) === "draft" && jr(v1.validationJson)?.state === "pending", loopOf(reqs.slice(k0)));
      const p = pipe.partsOfVersion(v1);
      const edit = await scriptsLib.editScriptVersion(rK.scriptId, { title: v1.title, categoryLabel: v1.categoryLabel, hook: "A hook Jordan wrote himself.", points: p.points.map((x) => ({ role: x.role as never, text: x.text })), close: p.close }, STAFF);
      const s0 = reqs.length;
      const direct = await judgeLib.autoCheckScript(rK.scriptId, { requestedBy: STAFF, unattended: false });
      const swept = await judgeLib.sweepScriptChecks({ max: 10 });
      const ev = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: edit.versionId } });
      c.ok("…a person edits it by hand: the automatic check and the cron sweep leave both versions alone (no review, no rewrite, nothing sent)", reqs.length === s0 && direct.state === "skipped" && /not an automatic draft/.test(direct.reason ?? "") && swept.checked === 0 && !jr(ev.validationJson) && ev.hook === "A hook Jordan wrote himself." && (await currentOf(rK.scriptId)).cur.id === ev.id && jr((await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: v1.id } })).validationJson)?.state === "pending", `${direct.state}/${direct.reason} · swept ${swept.checked}`);
    }

    // =======================================================================
    c.head("8g · draftOffline (the retro test) takes the same steps, writes no script");
    {
      ctl.reviews.set("H", [[]]);
      const h0 = reqs.length;
      const off = await pipe.draftOffline({ topicId: tH, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline, it passes first time: the draft and one review, nothing else", off.state === "passed" && off.attempts.map((a) => `${a.label}:${a.words}`).join(",") === "draft:71" && loopOf(reqs.slice(h0)) === "draft,review" && off.final.label === "draft", off.attempts.map((a) => `${a.label}:${a.words}`).join(","));
      ctl.reviews.set("I", [["sense"], []]);
      ctl.reads.set("I", [3, 8]);
      const offI = await pipe.draftOffline({ topicId: tI, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline, it fails: the one whole rewrite with the note; the rewrite reads better and is the result", offI.state === "passed" && offI.attempts.map((a) => a.label).join(",") === "draft,rewrite" && offI.final.label === "rewrite" && offI.final.parts.hook === REWRITE_HOOK, `${offI.state} · ${offI.final.label}`);
      ctl.reviews.set("J", [["voice"], ["voice", "invented"]]);
      ctl.reads.set("J", [5, 2]);
      const offJ = await pipe.draftOffline({ topicId: tJ, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline, the rewrite reads worse: the draft is the result, flagged; never a second rewrite", offJ.state === "flagged" && offJ.attempts.length === 2 && offJ.final.label === "draft", `${offJ.state} · ${offJ.attempts.map((a) => a.label).join(",")} · ${offJ.final.label}`);
      c.ok("…and nothing was written for any of them but AI run rows", (await prisma.contentScript.count({ where: { topicId: { in: [tH, tI, tJ] } } })) === 0);
    }
    // =======================================================================
    c.head("9b · her material, our wording; the whole call; Jordan's craft rules in the brief; the writer and the reviewer kept short (v2.6)");
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
      c.ok("…and her best short phrases are kept apart (herPhrases), stored with the brief, and handed to the writer to use where they fit", wB?.brief.herPhrases?.[0]?.text === "fiercely protect their interests" && /Her phrases \(use them where they fit\):\n- "fiercely protect their interests"/.test(reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_B))?.prompt ?? ""));
      c.ok("the brief keeps her material, our wording, and Jordan's craft rules (story progression, her ACTUAL reason, the insight, educational contrast)", prompts.BRIEF_SYSTEM.includes("HER MATERIAL, OUR WORDING") && prompts.BRIEF_SYSTEM.includes("Never paste her spoken sentences") && prompts.BRIEF_SYSTEM.includes("her ACTUAL reason for the change") && prompts.BRIEF_SYSTEM.includes("the insight that connects her past to the viewer's need") && prompts.BRIEF_SYSTEM.includes("meaningful contrast"));
      c.ok("v2.6: the writer and the reviewer carry none of that long rule list (it distorted the writing): the brief chooses, code advises", [prompts.WRITER_SYSTEM, prompts.REVIEW_SYSTEM].every((s) => !s.includes("HER MATERIAL, OUR WORDING") && !s.includes("HOUSE CRAFT") && !s.includes(rules.CLOSE_RULE) && !s.includes("PLAIN WORDS FOR HOMEOWNERS") && !s.includes("LENGTH (Jordan")));
      const pasted = rules.hardNumbers({ hook: "I loved working in senior living.", points: [{ role: "re-hook", text: "I used to run sales and marketing for a retirement community before I got my license." }], close: "Let's talk." }, TRANSCRIPT);
      const phrase = rules.hardNumbers({ hook: "I loved working in senior living.", points: [{ role: "payoff", text: "Both needed someone to explain their options and fiercely protect their interests." }], close: "Let's talk." }, TRANSCRIPT);
      c.ok("code: a sentence pasted from the call (11 words or more in a row) is noted; her short phrase is not", pasted.findings.some((x) => x.key === "pasted") && !phrase.findings.some((x) => x.key === "pasted"), JSON.stringify(pasted.findings.map((x) => x.key)));
      c.ok("…v2.6: as advice (a flag under Advice), never a reason to rewrite", (() => { const m = rules.mergeViewerReview([], pasted.findings, 40).find((x) => x.key === "advice"); return !!m && !m.pass && m.level === "flag" && pasted.findings.every((x) => x.key !== "pasted" || x.level === "flag"); })());
      c.ok("retrieval: whole thoughts, and a reader's summary is never her words", prompts.RETRIEVAL_SYSTEM.includes("Return WHOLE THOUGHTS") && prompts.RETRIEVAL_SYSTEM.includes("not her words"));
    }

    // =======================================================================
    c.head("9 · the close and the length: the brief's rule, the writer's short one, code's length check");
    {
      const sys = prompts.WRITER_SYSTEM;
      c.ok("writer: the close is a call to action tied to the message, or a line that pays off the hook; the brief decides which (closeType) and the writer is told", sys.includes("- CLOSE: a call to action tied to the message, or a line that pays off the hook.") && /The close: a call to action tied to the message\./.test(reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_A))?.prompt ?? "") && !/contact ask goes in the caption|memorable final line/i.test(sys));
      c.ok("writer: 55 to 85 spoken words, plainly", sys.includes("Length: 55 to 85 spoken words.") && prompts.DRAFT_ASK.includes("55 to 85 spoken words"));
      c.ok("the brief keeps the full close rule (a callback, then a warm invitation by default; a callback alone where the story has no service angle)", prompts.BRIEF_SYSTEM.includes(rules.CLOSE_RULE) && rules.CLOSE_RULE.includes("\"cta\" (the default)") && rules.CLOSE_RULE.includes("only when the video is purely a story with no service angle"));
      c.ok("brief: closeType cta or callback, decided per message", prompts.BRIEF_SYSTEM.includes("closeType") && (prompts.BRIEF_SCHEMA as { properties: { closeType: { enum: string[] } } }).properties.closeType.enum.join() === "cta,callback");
      const l = rules.lengthCheck(96), a = rules.lengthCheck(80), s = rules.lengthCheck(40), o = rules.lengthCheck(111);
      c.ok("96 words: \"Longer than the 55 to 85 aim\", a flag, never must-fix; 111 is must-fix (the cap)", !l.pass && l.level === "flag" && /Longer than the 55 to 85 aim/.test(l.reason) && !o.pass && o.level === "must-fix");
      c.ok("80 words passes; 40 words passes the length check", a.pass && s.pass);
      const h = rules.hardNumbers({ hook: "Sellers, mortgage rates are up 7% and that changes everything", points: [{ role: "re-hook", text: "Know your buyer avatar — it matters (10 seconds)." }], close: "Let's talk." }, "she talked about her inspection process");
      const keys = h.findings.map((x) => x.key).sort().join(",");
      c.ok("code's findings: audience opener, dash, duration note, a figure and a market statement she never made, jargon, a close with nothing from the hook", keys === "audience_vocative,dash,duration,generic_close,jargon,market_claim,market_term", keys);
      const must = h.findings.filter((x) => x.level === "must-fix").map((x) => x.key).sort().join(",");
      c.ok("…v2.6: only the hard ones are must-fix (the dash, the duration, the figure); the rest are advice", must === "dash,duration,market_claim", must);
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
      c.ok("a person's explicit new draft: the retrieval and the brief reused, the draft; no review and no rewrite on a shared script (v2.6: no hooks step)", after.join(",") === "draft", after.join(","));
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

      // --- 3. her durable facts from older months (topic A's brief prompt; v2.6: the brief reads her facts, the draft gets the brief and her words)
      const draftA = briefA;
      c.ok("an accepted fact filed under an older month, about her, reaches the brief", draftA.includes(OLD_HISTORY));
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

      // --- 5. v2.6: no hooks step; a story's brief tells the writer to tell it in order, and no proof means no story made up
      const storyCtx = { topic: { title: TOPIC_B } } as never;
      const eduText = prompts.writerBriefText(storyCtx, pipe.briefFrom({ videoType: "educational" }, []));
      const storyText = prompts.writerBriefText(storyCtx, pipe.briefFrom({ videoType: "story", angle: "She expected seniors; first-time buyers called.", proof: { text: "First-time buyers started calling her", source: "P9", isHerStory: true } }, []));
      c.ok("a personal story's brief tells the writer to tell it in the order it happened, up to 110 words, never padded; an educational one does not", /It is her told personal story: tell it in the order it happened\. It may run to 110 words, never padded\./.test(storyText) && !/told personal story/.test(eduText) && /Her proof: First-time buyers started calling her/.test(storyText), storyText);
      c.ok("…and with no proof from her, the writer is told not to make a story up (the Doorknob brief said she told no doorknob story)", /Her proof: None from her: the message itself, in her words, carries it\. Do not make a story up\./.test(eduText));
      // --- 7. no client's finals in any rule or system prompt (they were the answer key for Marcee's test)
      const FINALS = [
        "I absolutely loved working in senior living. So why did I leave? I wanted the freedom to do more. So I became a Realtor, expecting to help older adults downsize. Then the first-time buyers started calling. And surprisingly, both groups were asking the same questions. Where do I start? Who can I trust? What am I not asking? They needed someone to explain their options and fiercely protect their interests. That's the work I've always loved, but now I have the opportunity to help even more people. Whether it's your first home or your next chapter, you don't need all the answers before calling me. That's what I'm here for.",
        "But my house is different. Maybe it is. But that doesn't automatically mean it'll sell for more. The market has changed. But some homeowners still expect a bidding war by Sunday. Buyers have options. Your neighbor's sale isn't the whole story, and pricing, preparation, and marketing all matter. That's why I study what's selling, what's sitting, and what buyers are passing over. I'll give you honest advice on what to do next. There are still great opportunities. And your home is different! That's why it deserves a strategy built for today's market. Let's talk.",
        "The repairs you think your house needs before you sell? They might not be where your money should go. Sometimes, fresh paint and rearranging furniture do more than an expensive renovation. But preparation goes deeper than appearances. Buyers and their agents are also looking at the roof, major systems, and any signs of potentially costly problems. That's why I recommend a pre-listing inspection. We can identify issues early and decide what to repair, refresh, or leave alone before negotiations. I'm here to help you see your home through their eyes. Before you change everything, let's talk about what actually matters.",
      ].join("\n");
      const allRules = [prompts.RETRIEVAL_SYSTEM, prompts.BRIEF_SYSTEM, prompts.WRITER_SYSTEM, prompts.REVIEW_SYSTEM, prompts.DRAFT_ASK, prompts.REWRITE_ASK, rules.CLOSE_RULE, rules.HOUSE_CRAFT_RULES, rules.WORDING_RULE, rules.HOMEOWNER_LANGUAGE_RULE, rules.trimInstruction(98), JSON.stringify([prompts.BRIEF_SCHEMA, prompts.DRAFT_SCHEMA, prompts.REVIEW_SCHEMA])].join("\n");
      const leaked = rules.pastedRuns(FINALS, allRules, 5);
      c.ok("no run of five or more words from Jordan's three finals appears in any rule, system prompt or schema", leaked.length === 0, leaked.join(" | "));
      c.ok("…nor their signature phrases", !/fiercely protect|every bit as scary|my house is different|bidding war|first home or your next chapter|through their eyes|senior living/i.test(allRules));
    }

    // =======================================================================
    // 15 · THE CRAFT RULES THAT STAYED (v2.3 to v2.5; re-pointed for v2.6).
    // The brief still chooses by Jordan's craft rules; code's craft checks are
    // advice now (flags on the record, never a reason to rewrite). The hooks
    // step, the trims and the craft gate are gone (section 19 says what came
    // instead). The fixtures are the independent review's real examples.
    // =======================================================================
    c.head("15.1 · a version drafted before v2.6 keeps its scored hooks on the card's notes");
    {
      const S = (o: Partial<Record<string, number>>) => ({ relevance: 4, curiosity: 4, tension: 4, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 4, ...o });
      const old = [{ text: "We've outgrown this place. We just need a bigger house.", rehook: "r", lever: "belief", scores: S({ tension: 3 }), total: 31, note: "", disqualified: null, weak: "tension under 4" }];
      const card = record.writerCardOf(JSON.stringify({ writer: { v: 2, version: "writer.v2.5-2026-10-22", brief: { centralMessage: "m", viewer: "v", whyChosen: "w", pillar: "p", whatSheSaid: [], mustKeep: [], optional: [], excluded: [], contradictions: [], verifiedFacts: [], opinions: [], creativeIdeas: [], ourAssumptions: [], closeType: "cta", closeWhy: "", target: { aim: [55, 85], cap: 110, seconds: [25, 39] } }, hooks: old, chosen: 0, hookFallback: "No hook reached curiosity 4 and tension 4." } }));
      c.ok("the card shows each stored hook out of 40, why one was below the bar, and the fallback", card?.hooks[0].max === 40 && card.hooks[0].weak === "tension under 4" && card.hooks[0].chosen && /No hook reached/.test(card.hookFallback ?? ""));
      const cardA = record.writerCardOf((await prisma.contentScriptVersion.findFirst({ where: { scriptId: rA.scriptId, versionNo: 1 } }))?.validationJson);
      c.ok("…a v2.6 version has none to show", !!cardA && cardA.hooks.length === 0 && cardA.hookFallback === null);
    }

    c.head("15.2 · a hedged or echoing re-hook is code's advice now (it used to send the script back)");
    {
      const PRICE = "The agent who agreed with my price must really believe in my house.";
      const hedge = rules.hardNumbers({ hook: PRICE, points: [{ role: "re-hook", text: "Maybe. But without proof, they may care more about your open house buyers than selling your home." }, { role: "build-up", text: "Anybody could throw in a price. Ask how they got it." }, { role: "payoff", text: "x" }], close: "Ask any agent for the proof behind that price." }, "");
      const h = hedge.findings.find((x) => x.key === "hook_echo");
      c.ok("\"Maybe. But without proof...\" is noted as a hedge, on the re-hook, as a flag", !!h && h.level === "flag" && h.part === "rehook" && /opens on a hedge \("Maybe"\)/.test(h.detail), JSON.stringify(hedge.findings));
      c.ok("…\"Not exactly.\" too; a re-hook that turns (\"The irony? ...\") is not", rules.craftFindings({ hook: "x y z", points: [{ role: "re-hook", text: "Not exactly. It depends on the lot." }], close: "" }).some((x) => x.key === "hook_echo") && !rules.craftFindings({ hook: "I once watched a deal fall apart over a doorknob.", points: [{ role: "re-hook", text: "The irony? One wanted to sell, one wanted to buy. Same goal." }], close: "" }).some((x) => x.key === "hook_echo"));
      const echo = rules.craftFindings({ hook: "Pre-listing inspections save sellers money on repairs.", points: [{ role: "re-hook", text: "A pre-listing inspection saves sellers real money on repairs." }, { role: "build-up", text: "Inspections catch repairs early, and sellers keep their money." }], close: "" });
      c.ok("a re-hook or a build-up sharing 3 or more of the hook's content words is noted, a flag each", echo.some((x) => x.key === "hook_echo" && x.part === "rehook" && x.level === "flag" && /repeats the hook's words/.test(x.detail)) && echo.some((x) => x.key === "hook_echo" && x.part === "buildup" && x.level === "flag"), JSON.stringify(echo.map((x) => [x.part, x.level, x.detail])));
      const merged = rules.mergeViewerReview(rules.VIEWER_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "fine" })), hedge.findings, 70);
      c.ok("…merged: Advice fails as a flag, nothing must-fix, so no rewrite", merged.some((x) => x.key === "advice" && !x.pass && x.level === "flag") && rules.mustFixFailures(merged).length === 0 && pipe.nextWriterStep({ mustFails: rules.mustFixFailures(merged), rewrites: 0 }) === "pass");
    }

    c.head("15.3 · the proof is a real moment she told; her answer to an ask for an example is kept (the brief)");
    {
      c.ok("house craft (the brief): prove it with one real moment she told", rules.HOUSE_CRAFT_RULES.includes("Prove it with one real moment she told: what happened, one number or detail, how it ended. When the interviewer asked for an example (have you ever, a real example, what was the outcome), her answer is the proof and a must-keep. A restated opinion is never the proof. A story that seems to contradict the message is framed, not dropped.") && prompts.BRIEF_SYSTEM.includes(rules.HOUSE_CRAFT_RULES));
      c.ok("the brief's proof line asks for her moment and keeps the example question", !prompts.BRIEF_SYSTEM.includes("the one reason the belief is not the whole story") && prompts.BRIEF_SYSTEM.includes("Prove it with one real moment she told") && prompts.BRIEF_SYSTEM.includes("keep that question in whatWeAsked, word for word") && JSON.stringify(prompts.BRIEF_SCHEMA).includes("isHerStory"));
      const asked = [{ quote: "Have you ever had a deal almost fall apart over something small? What was the outcome?", time: "00:31:02" }];
      const kept = pipe.briefFrom({ whatWeAsked: "What do buyers and sellers fight about?", proof: { text: "the deal over the doorknob", source: "P3", isHerStory: true } }, [], asked);
      const already = pipe.briefFrom({ whatWeAsked: "Have you ever had a deal almost fall apart over something small? What was the outcome? (00:31:02)" }, [], asked);
      c.ok("when the brief lost the interviewer's example question, code puts it back in whatWeAsked; when it kept it, nothing is added", /The interviewer asked for an example \(her answer is the proof\): "Have you ever had a deal almost fall apart/.test(kept.whatWeAsked ?? "") && kept.proof?.isHerStory === true && !/The interviewer asked for an example/.test(already.whatWeAsked ?? ""), kept.whatWeAsked);
      c.ok("…and the writer reads what we asked and her proof", /What we asked her: What do buyers and sellers fight about\?/.test(prompts.writerBriefText({ topic: { title: "t" } } as never, kept)) && /Her proof: the deal over the doorknob/.test(prompts.writerBriefText({ topic: { title: "t" } } as never, kept)));
      c.ok("retrieval: return the example question and her whole answer", prompts.RETRIEVAL_SYSTEM.includes("When he asked for an example (have you ever, a real example, what was the outcome), return that question, and return her answer to it in full"));
    }

    c.head("15.4 · self-pitch: how she helps once; must-keep 3, never the invitation (the brief)");
    {
      const ONCE = "how she helps appears once, in the payoff or the close, never both";
      c.ok("\"how she helps appears once, in the payoff or the close, never both\": house craft and the brief's must-keep", rules.HOUSE_CRAFT_RULES.includes(ONCE) && prompts.BRIEF_SYSTEM.includes(`how she helps (${ONCE})`));
      c.ok("BRIEF_MUST_KEEP_MAX: educational 3, story 6; the invitation is never must-keep (the prompt and the code)", rules.BRIEF_MUST_KEEP_MAX.educational === 3 && rules.BRIEF_MUST_KEEP_MAX.story === 6 && prompts.BRIEF_SYSTEM.includes("The invitation and what the viewer should do next are never must-keep") && pipe.INVITATION_RE.test("Invite viewers to reach out for a consult") && !pipe.INVITATION_RE.test("She protects first-time buyers"));
    }

    c.head("15.5 · closes: the brief's rule; a template close is code's advice");
    {
      c.ok("CLOSE_RULE (in the brief): at most two beats, the callback first, the specific next step second; \"Let's talk\" alone and \"Thinking about X?\" fail; no hard sell, no slogan", ["the close is at most two beats", "calls back a concrete word or image from the hook", "names THIS video's specific next step", "\"Let's talk\" as the whole invitation fails, and so does an invitation that opens \"Thinking about X?\"", "Never a hard sell", "A slogan or a rhyming aphorism is not a close"].every((x) => rules.CLOSE_RULE.includes(x)));
      const gc = (hook: string, close: string) => rules.craftFindings({ hook, points: [], close }).find((x) => x.key === "generic_close");
      const nest = gc("Want more room now that the kids moved out? Don't feel like you're weird.", "Want the home everyone comes back to? Let's talk.");
      const yard = gc("We just want to walk out of the kitchen straight to the pool.", "You may have one vision. Tell me what your backyard should do before the plans are set.");
      const paoli = gc("In Paoli, you can buy a newer townhome or a house over 200 years old.", "Something for everyone in Paoli. Thinking about Paoli? Give me a call.");
      const good = gc("I once watched a deal fall apart over a doorknob.", "Don't lose the house over a doorknob. Bring me the repair list, and we'll sort out what is worth the fight.");
      c.ok("\"[question]? Let's talk.\", a close with nothing from the hook or the re-hook, and \"Thinking about X?\" are noted; a callback with this video's own next step is not", !!nest && /ends on a question and "Let's talk\."/.test(nest.detail) && !!yard && /nothing from the hook or the re-hook comes back in it/.test(yard.detail) && !!paoli && /opens "Thinking about \.\.\.\?"/.test(paoli.detail) && !good);
      const m = rules.mergeViewerReview(rules.VIEWER_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "fine" })), [nest!], 70).find((x) => x.key === "advice")!;
      c.ok("…merged, Advice fails as a flag: never a reason to rewrite", !m.pass && m.level === "flag" && nest!.level === "flag" && rules.HARD_TO_CHECK.generic_close === "advice");
    }

    c.head("15.6 · length: the aim and the cap");
    {
      c.ok("WRITER_LENGTH: aim 55 to 85, cap 110", rules.WRITER_LENGTH.aim.join() === "55,85" && rules.WRITER_LENGTH.cap === 110);
      c.ok("80 and 85 are inside the aim; 86 is long (advice); 111 is over the cap (must-fix)", rules.lengthBand(80) === "aim" && rules.lengthCheck(85).pass && rules.lengthBand(86) === "long" && rules.lengthCheck(86).level === "flag" && rules.lengthBand(111) === "over" && rules.lengthCheck(111).level === "must-fix");
    }

    c.head("15.7 · jargon: the brief asks for plain words; code notes four more terms, as advice");
    {
      c.ok("HOMEOWNER_LANGUAGE_RULE (in the brief): a phrase of hers is still jargon", rules.HOMEOWNER_LANGUAGE_RULE.includes("A phrase of hers is still jargon if a homeowner would not say it; her phrases never override this rule.") && prompts.BRIEF_SYSTEM.includes(rules.HOMEOWNER_LANGUAGE_RULE) && prompts.BRIEF_SYSTEM.includes("her phrases never override plain words"));
      const j = rules.hardNumbers({ hook: "Your lot decides the backyard.", points: [{ role: "payoff", text: "I look at grading, impervious coverage, setbacks, and what the actives and pendings say." }], close: "Bring me your backyard wish list." }, "").findings.find((x) => x.key === "jargon");
      c.ok("\"impervious coverage\", \"setbacks\", \"actives\", \"pendings\" are caught as industry terms; v2.6: a flag", !!j && j.level === "flag" && ["impervious coverage", "setback", "actives", "pendings"].every((t) => j.detail.includes(t)), j?.detail);
      c.ok("…\"impervious surface\" too; \"active\" and \"pending\" as plain words are not", rules.hardNumbers({ hook: "x", points: [{ role: "payoff", text: "An impervious surface limit." }], close: "x" }, "").findings.some((x) => x.key === "jargon") && !rules.hardNumbers({ hook: "x", points: [{ role: "payoff", text: "Homes are pending and buyers are active." }], close: "x" }, "").findings.some((x) => x.key === "jargon"));
    }

    c.head("15.8 · an agreed format is a creative decision; the version is stamped; no dash in any prompt");
    {
      c.ok("a format agreed on the call: house craft, the retrieval, the brief (never internal talk), and the writer is told it", rules.HOUSE_CRAFT_RULES.includes("A format agreed on the call (word association, two voices, a trend alert) is a creative decision the script follows, not production talk.") && prompts.RETRIEVAL_SYSTEM.includes("A FORMAT AGREED ON THE CALL for this video (word association, two voices, a trend alert) is a creative decision the script follows, never internal talk") && prompts.BRIEF_SYSTEM.includes("A format agreed on the call for this video is never internal talk and never excluded") && /\nAgreed format: word association, dry humor\.\n/.test(prompts.writerBriefText({ topic: { title: "t" } } as never, pipe.briefFrom({ creativeIdeas: [{ text: "Agreed format: word association, dry humor.", source: "call" }] } as never, []))));
      c.ok("WRITER_VERSION is writer.v2.6-2026-10-23, on every writer run and in the writer's prompt", rules.WRITER_VERSION === "writer.v2.6-2026-10-23" && (await prisma.programAiRun.count({ where: { kind: "script_review", promptVersion: "writer.v2.6-2026-10-23" } })) > 0 && /\(writer\.v2\.6-2026-10-23\)/.test(prompts.WRITER_SYSTEM));
      c.ok("no dash in any rule or prompt the model reads (an example with one is never picked, 19.1) (it copies punctuation; the no-dash rule's own text aside)", ![prompts.RETRIEVAL_SYSTEM, prompts.BRIEF_SYSTEM, prompts.WRITER_SYSTEM, prompts.REVIEW_SYSTEM, prompts.DRAFT_ASK, prompts.REWRITE_ASK, rules.CLOSE_RULE, rules.HOUSE_CRAFT_RULES, rules.HOMEOWNER_LANGUAGE_RULE, ...rules.REVIEW_CHECKS.map((x) => x.passes)].some((t) => /[‒–—―]/.test(t.split(rules.NO_DASH_RULE).join(""))));
    }
    // =======================================================================
    c.head("16 · the model map: each step's model and effort; the cached prefix of the second review; the cost of each model");
    {
      // The new writer's runs (promptKey writer-<step>); the old writer's draft in section 11 stays on Sonnet 4.6.
      const ledger = async (kind: string) => (await prisma.programAiRun.findMany({ where: { kind: kind as never, enrollmentId: f.enrollmentId, status: "SUCCEEDED", promptKey: { startsWith: "writer-" } }, select: { model: true } })).map((r) => r.model);
      const kinds = { script_retrieval: "claude-haiku-5-5", script_brief: "claude-sonnet-5-5", script_draft: "claude-sonnet-5-5", script_review: "claude-sonnet-5-5", script_revise: "claude-sonnet-5-5" } as const;
      const stamped = await Promise.all(Object.entries(kinds).map(async ([k, m]) => ({ k, m, got: await ledger(k) })));
      c.ok("every ProgramAiRun is stamped with its step's model (retrieval Haiku 5.5; brief, draft, review, the rewrite Sonnet 5.5); v2.6: no script_hooks run", stamped.every((x) => x.got.length > 0 && x.got.every((g) => g === x.m)) && (await ledger("script_hooks")).length === 0, stamped.map((x) => `${x.k}:${[...new Set(x.got)].join("/")}`).join(" "));
      c.ok("no writer request sent temperature, top_p, top_k or a thinking budget; none forced a tool", reqs.filter((r) => ["retrieval", "brief", "draft", "review", "rewrite", "trim", "revise"].includes(r.step)).every((r) => !("temperature" in r.body) && !("top_p" in r.body) && !("top_k" in r.body) && !("thinking" in r.body) && !JSON.stringify(r.body).includes("budget_tokens") && !("tool_choice" in r.body) && !("tools" in r.body)));
      // Topic B's two reviews (the draft, then its rewrite): the same prefix, byte for byte, in front of the breakpoints.
      const revB = reqs.filter((r) => r.step === "review" && r.prompt.includes(TOPIC_B)).slice(0, 2);
      type Block = { type: string; text: string; cache_control?: { type: string } };
      const blocks = revB.map((r) => ((r.body.messages as { content: Block[] }[])[0].content));
      const okShape = blocks.length === 2 && blocks.every((b) => Array.isArray(b) && b.length === 3 && b[0].cache_control?.type === "ephemeral" && b[1].cache_control?.type === "ephemeral" && !b[2].cache_control);
      c.ok("the review's user message: two cached blocks, then the script under review (no breakpoint after it)", okShape, blocks.map((b) => (Array.isArray(b) ? b.map((x) => (x.cache_control ? "C" : "-")).join("") : typeof b)).join(" / "));
      c.ok("…the rewrite's review reads the same cached prefix byte for byte, and the full call (the transcript) sits before the first breakpoint", okShape && blocks[0][0].text === blocks[1][0].text && blocks[0][1].text === blocks[1][1].text && blocks[0][2].text !== blocks[1][2].text && blocks[0][0].text.includes("THE FULL CALL") && blocks[0][0].text.includes(Q_SENIOR) && revB[0].system === revB[1].system && (revB[0].body.system as Block[])[0].cache_control?.type === "ephemeral");
      c.ok("…the script comes last, and nothing of code's checks is shown to the reviewer (it reads as a viewer first)", okShape && blocks.every((b) => !/^SCRIPT:/m.test(b[0].text + b[1].text) && /^SCRIPT:\nHOOK: /.test(b[2].text) && !/COUNTED BY CODE|Hard checks|must-fix/i.test(b.map((x) => x.text).join("\n"))));
      const draftA = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_A));
      const dBlocks = (draftA?.body.messages as { content: Block[] }[] | undefined)?.[0].content ?? [];
      const retA = reqs.find((r) => r.step === "retrieval" && r.prompt.includes(TOPIC_A));
      const rBlocks = (retA?.body.messages as { content: Block[] }[] | undefined)?.[0].content ?? [];
      c.ok("the draft caches who speaks and the bar, then this video's brief and her words; the ask comes after; the retrieval caches the call and asks for the topic after it", Array.isArray(dBlocks) && dBlocks.length === 3 && !!dBlocks[0].cache_control && /^CLIENT: Dana Brooks TEST\. She is the one speaking\./.test(dBlocks[0].text) && dBlocks[0].text.includes("EXAMPLES OF THE BAR") && !!dBlocks[1].cache_control && /^THIS VIDEO\n/.test(dBlocks[1].text) && !dBlocks[2].cache_control && dBlocks[2].text === prompts.DRAFT_ASK && Array.isArray(rBlocks) && !!rBlocks[0].cache_control && rBlocks[0].text.includes(Q_SENIOR) && !rBlocks[0].text.includes(TOPIC_A) && rBlocks[1].text.includes(TOPIC_A));
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
      c.ok("Marcee's 2022 proof (P5: \"just wrote an offer\") is moved to excluded (v2.5: named by its passages, its details out, \"never in the script\"), isHerStory cleared, and its must-keep goes with it; the other two stay", m2022.proof === null && m2022.excluded[0]?.text === "The deal in P5, P6 (her example; its details stay out)" && /a deal still in progress \(P5: "just wrote an offer"\): never in the script$/.test(m2022.excluded[0]?.reason ?? "") && !m2022.excluded.some((x) => /20,000/.test(x.text)) && m2022.mustKeep.map((x) => x.source).join("|") === "P2|P3, P4", JSON.stringify([m2022.proof, m2022.excluded.map((x) => x.reason.slice(0, 50)), m2022.mustKeep.map((x) => x.source)]));
      const wb2022 = prompts.writerBriefText({ topic: { title: "This Is Not 2022" } } as never, m2022);
      c.ok("…and the brief the writer reads has no proof from her (it is told not to make one up), and says why the deal is left out", /Her proof: None from her/.test(wb2022) && /Leave out:\n- The deal in P5, P6 \(her example; its details stay out\) \(a deal still in progress/.test(wb2022) && !/20,000/.test(wb2022), wb2022);
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
      c.ok("offline end to end: the stored brief has no proof; it is excluded naming the filmed script; the draft prompt carries no proof from her, only why it is left out", offS.record.brief.proof === null && /a story she has already told on camera \("The Inspection That Caught The Roof": 350/.test(offS.record.brief.excluded[0]?.reason ?? "") && offS.record.brief.mustKeep.map((x) => x.text).join() === "Spend on what buyers and their agents judge" && /Her proof: None from her/.test(draftS) && /Leave out:\n- The proof: She had a seller do the pre-listing inspection/.test(draftS), JSON.stringify([offS.record.brief.proof, offS.record.brief.excluded[0]]));
    }

    // =======================================================================
    // v2.5, THE SECOND CALIBRATION FIX (Oct 22 2026), one section per fix. The
    // fixtures are the v2.4 offline retest's real hooks, briefs, drafts and
    // review notes (John Collins 4, Marcee 3); the rules themselves quote no
    // client.
    // =======================================================================
    {
      const P22 = (id: string, quote: string, time: string | null) => ({ id, source: "strategy call of Oct 15, 2026", time, speaker: "client", kind: "story", quote, context: quote, why: "" });
      // [relevance, curiosity, tension, specificity, naturalDelivery, accuracy, herVoice, payoffConnection], as Opus scored them.
      const V24: Record<string, { videoType: "story" | "educational"; proofIsStory: boolean; v24Pick: number; hooks: [string, string, string, number[]][] }> = {
        paoli: { videoType: "educational", proofIsStory: false, v24Pick: 1, hooks: [
          ["Paoli doesn't even have a downtown. So why would anyone want to live there?", "Because the whole town is centered on a train station with Amtrak and SEPTA, and it covers two school districts.", "viewer_line", [5, 4, 4, 4, 5, 5, 4, 5]],
          ["No real downtown, and I've still sold 14 homes in Paoli in two years.", "Newer townhomes, and houses over 200 years old. What draws people is the station, with Amtrak and SEPTA, and a great spot on the Main Line.", "other", [4, 4, 4, 5, 4, 5, 4, 4]],
          ["Why would someone pick Paoli over Wayne?", "You keep Wayne and Valley Forge Park close by, and you get a station with Amtrak and SEPTA plus two school districts to choose from.", "viewer_line", [4, 4, 3, 4, 5, 4, 4, 4]],
          ["The British bayoneted Americans in Paoli, and it backfired on them.", "Today the town is known for quieter things: Amtrak and SEPTA at the station, and homes from new townhomes to 200-plus-year-old historic houses.", "other", [2, 4, 3, 4, 4, 5, 3, 3]],
          ["Skipping Paoli because there's no downtown could mean missing the right house.", "The homes run from condos and new townhomes to 200-plus-year-old historic houses, so there's something for everyone, all near a station with Amtrak and SEPTA.", "other", [4, 3, 4, 3, 4, 5, 3, 4]],
        ] },
        renovating: { videoType: "educational", proofIsStory: true, v24Pick: 0, hooks: [
          ["I'm putting in a home theater before we list. It'll pay for itself.", "Stop right there. A Malvern seller of mine spent on floors, paint and a new front door instead, and walked away with about 80 grand more than they expected.", "viewer_line", [5, 4, 4, 4, 5, 5, 4, 5]],
          ["Thinking of adding a hot tub before you sell? Stop right there.", "You won't get that money back. What pays is cheaper and far less exciting: worn carpet, fresh paint, and a free one, decluttering.", "viewer_line", [5, 3, 3, 3, 5, 5, 5, 5]],
          ["The hot tub feels like the upgrade. The fresh paint is what buyers actually pay for.", "One Malvern seller redid the floors, painted the whole house and stained the deck, then came out about 80 grand ahead of what they expected.", "other", [4, 4, 3, 4, 4, 5, 4, 5]],
          ["Floors, paint, a deck and a front door. Then about 80 grand more than the seller expected.", "No hot tub, no home theater. That prep plus listing at the right number is what hit it out of the park.", "other", [4, 4, 3, 5, 3, 4, 4, 4]],
          ["We'll spend the money now and get it back when we sell, right?", "On a steam sauna or a wine cellar, just not happening. On worn carpet and paint, it comes back right away, and I've watched it add up.", "viewer_line", [5, 4, 4, 3, 5, 5, 4, 5]],
        ] },
        showings: { videoType: "educational", proofIsStory: true, v24Pick: 4, hooks: [
          ["Lots of showings, great feedback, and still no offer. What are we doing wrong?", "Your marketing is doing its job. The buyers walking through are telling you something else, and when the feedback is good, it's almost always the price.", "viewer_line", [5, 4, 4, 4, 5, 5, 4, 5]],
          ["If your house gets showings but no offers, what should you check first?", "Not the photos and not the marketing. If people are walking through, the exposure is working. It's price, always, and the market is speaking to us.", "viewer_line", [5, 4, 3, 4, 5, 5, 4, 5]],
          ["Everyone who walks through loves it, so the offers have to be coming, right?", "If they haven't come by now, the buyers already answered. Good feedback with no offers means the house is fine, and the number is what they're saying no to.", "viewer_line", [5, 4, 4, 3, 4, 5, 4, 5]],
          ["Showings with no offers and no showings at all are telling you the same thing.", "One is the market speaking. The other is the market saying it louder: an empty inbox means you're priced way too high. Here's how to read both.", "other", [4, 4, 3, 4, 4, 5, 4, 4]],
          ["A $5,000 fence turned into about $40,000 more than we expected.", "The yard was only partly fenced, and buyer after buyer said they wanted a bigger yard. They were telling us exactly what was missing. We just had to listen.", "other", [4, 5, 4, 5, 5, 4, 4, 3]],
        ] },
        phrases: { videoType: "educational", proofIsStory: false, v24Pick: 2, hooks: [
          ["The listing said 'bring your imagination.' I thought that meant potential.", "In plain English, it means brace yourself. And cozy? Cozy means small.", "viewer_line", [5, 4, 4, 5, 5, 5, 4, 5]],
          ["What does 'great bones' really mean on a listing? Nothing good about the rest.", "It means the house needs total updating. The bones are the only part that's great.", "viewer_line", [5, 4, 3, 4, 4, 5, 4, 4]],
          ["Cozy, great bones, convenient location. Every one of those is covering for something.", "Listing copy is written to sell the house, not describe it. So let's translate, plainly.", "other", [5, 5, 4, 4, 5, 5, 5, 5]],
          ["Original owners sounds like a lovingly kept home. Usually, it means something else.", "It means never been updated. Longtime homeowner? Same thing, different wording.", "other", [4, 4, 3, 4, 4, 5, 4, 4]],
          ["Convenient location sounds great, until you hear it at midnight.", "It means busy road, lots of traffic. And a partially finished basement? That's a dungeon.", "other", [4, 4, 4, 5, 5, 5, 5, 4]],
        ] },
        seniors: { videoType: "story", proofIsStory: true, v24Pick: 0, hooks: [
          ["I walked away from a job I loved, sure I'd only ever work with seniors.", "Then first-time buyers started finding me, and they wanted exactly what my seniors wanted: to feel protected and cared for.", "her_moment", [4, 4, 4, 4, 5, 5, 5, 5]],
          ["Even though I loved helping seniors move, I had no say over my own success.", "So I built my own business in real estate, planning to serve the same people. The clients who showed up instead surprised me.", "her_moment", [3, 3, 4, 3, 4, 5, 5, 3]],
          ["The clients I never planned for became my favorite clients.", "I went into real estate expecting to help seniors downsize. Instead, nervous first-time buyers were drawn to me, and I knew exactly what they needed.", "her_moment", [4, 4, 3, 3, 5, 5, 5, 5]],
          ["Why would a first-time buyer trust someone who spent years helping seniors move?", "Because leaving a home of 60 years and buying your very first one are both scary, and it turns out they take the same skill set.", "viewer_line", [4, 4, 3, 4, 4, 5, 4, 5]],
          ["Moving out of a 60-year home and buying your first one feel exactly the same.", "I learned that by accident. I left senior living expecting seniors, and first-time buyers showed up needing the same protection.", "other", [4, 4, 3, 4, 4, 4, 4, 5]],
        ] },
        y2022: { videoType: "educational", proofIsStory: false, v24Pick: 2, hooks: [
          ["My neighbor sold in a weekend, over asking, so mine will too. Right?", "That was 2022. Today buyers expect an inspection, room to negotiate on what it finds, and a price that appraises.", "viewer_line", [5, 4, 4, 4, 5, 5, 4, 5]],
          ["Sold in hours, over asking, no inspections. It's nothing like that in 2022 anymore.", "Buyers have become decidedly more choosy, and they're getting deals on homes again. Which means you have to prepare yours before it lists.", "other", [4, 3, 3, 4, 3, 4, 4, 4]],
          ["Why is a nice house, priced like it's 2022, still sitting after a month?", "Because the seller refused inspections, and buyers just aren't willing to skip that anymore. Here's what they expect now.", "other", [4, 5, 4, 4, 4, 4, 4, 4]],
          ["I'm not doing inspections. Buyers can take my house as it is.", "In 2026, buyers expect that inspection and expect to negotiate on what it finds. And the home has to appraise.", "viewer_line", [4, 4, 4, 4, 5, 5, 4, 5]],
          ["Buyers are getting deals again, and a 2022 price won't hold up.", "They expect inspections, they negotiate on the findings, and the house has to appraise. It's a much more even playing field now.", "other", [4, 3, 4, 3, 4, 5, 4, 5]],
        ] },
        repairs: { videoType: "educational", proofIsStory: true, v24Pick: 2, hooks: [
          ["We should probably redo the bathroom before we list, right?", "Maybe not. The answer depends on who will actually buy your house, and most sellers start spending before they ever find that out.", "viewer_line", [5, 4, 3, 4, 5, 5, 4, 5]],
          ["Adding a half bath before you sell could be money that never needed spending.", "The right repairs come in two steps and in order: first who is buying, then what an inspector would flag.", "other", [5, 4, 4, 5, 4, 5, 4, 5]],
          ["One seller wanted a balcony off the office, and kept the 1995 bathroom.", "I had to tell them plainly the money belonged somewhere else, and knowing who would buy the house is how I knew where.", "her_moment", [4, 5, 4, 5, 4, 4, 4, 4]],
          ["The updates you would want in this house are rarely the ones buyers pay for.", "Sellers plan the work through their own eyes, but the buyer's inspector checks for something else entirely: a safe, solid investment.", "other", [5, 4, 4, 3, 4, 4, 4, 5]],
          ["What would a home inspector flag in your house before a buyer's does?", "A pre-listing inspection runs about $350 to $500, and it puts you in control of the repairs instead of the buyer.", "viewer_line", [4, 4, 4, 4, 4, 5, 3, 4]],
        ] },
      };
      // The v2.4 drafts as they came out (the final attempt each).
      const V24_FINAL: Record<string, { hook: string; points: { role: string | null; text: string }[]; close: string }> = {
        renovating: { hook: "I'm putting in a home theater before we list. It'll pay for itself.", points: [{ role: "re-hook", text: "Stop right there. Hot tubs, wine cellars, home theaters never pay back. Just not happening." }, { role: "build-up", text: "A recent Malvern seller redid the floors, painted, power washed and stained the deck, replaced the front door, and got about 80 grand more than expected." }, { role: "payoff", text: "Spend on carpet, paint, decluttering and the outside, then list at the right number." }], close: "Skip the home theater. Let me walk your house and say what's worth fixing, and what to skip." },
        showings: { hook: "A $5,000 fence turned into about $40,000 more than we expected.", points: [{ role: "re-hook", text: "The yard was only partly fenced, and buyers kept asking for a bigger one." }, { role: "build-up", text: "Showings, good feedback, no offers? Your marketing is working. The market is speaking. We need to listen." }, { role: "payoff", text: "It's price, always. No showings at all? You're priced too high. That empty inbox is the feedback." }], close: "That fence was the market speaking. Bring me your showing feedback and we'll read it together." },
        phrases: { hook: "Cozy, great bones, convenient location. Every one of those is covering for something.", points: [{ role: "re-hook", text: "The one you least want to find out in person: partially finished basement means a dungeon." }, { role: "build-up", text: "Bring your imagination means brace yourself. Original owners means never updated. Cozy means small. Great bones means total updating. Convenient location means busy traffic." }, { role: "payoff", text: "Ask what the charming word is being polite about. That's the real condition." }], close: "Send me a listing you're curious about and I'll tell you plainly what it's covering." },
        seniors: { hook: "I walked away from a job I loved, sure I'd only ever work with seniors.", points: [{ role: "re-hook", text: "I wanted the say over my own success. Then a group I never expected found me." }, { role: "build-up", text: "I was so comfortable with seniors, I assumed that was it. Instead, first-time buyers were drawn to me. I think they needed to feel protected and cared for." }, { role: "payoff", text: "Leaving a home of 60 years and buying your first are both scary. Same skill set, different place. First-time buyers became my favorite clients." }], close: "So much for only seniors. If a first home has you nervous, send me your questions and I'll answer honestly." },
        y2022: { hook: "Why is a nice house, priced like it's 2022, still sitting after a month?", points: [{ role: "re-hook", text: "Not updated in years, yet priced $20,000 above a fully updated house with a near-identical layout." }, { role: "build-up", text: "That seller still expects 2022: a sale in days, over asking, no contingencies. It's nothing like it was in 2022." }, { role: "payoff", text: "Buyers are decidedly more choosy now, so prepare your home and expect to negotiate." }], close: "Yours shouldn't be the house that sits. Bring me your home and price, and we'll look at both." },
        repairs: { hook: "Adding a half bath before you sell could be money that never needed spending.", points: [{ role: "re-hook", text: "Sellers update through their own eyes, but the buyer's agent checks everything anyway." }, { role: "build-up", text: "Step one: find who will buy your house and what they value. Step two: get an inspector through it before listing." }, { role: "payoff", text: "Think like a buyer, not a seller. That saves a ton of money and a ton of hassle." }], close: "So before that half bath, let's walk your house together and find your buyer and what to check first." },
      };
      const M22_PASSAGES = [
        P22("P2", "They've gotten accustomed to expecting the house to sell in a matter of days, if not hours, for over asking with multiple offers and without any contingencies. And the market is changing and in this area we have seen that while there can still be situations where homes will go quickly and they'll go maybe for over asking and they might have um you know two or three offers. It's nothing like it was in 2022.", "01:23:04"),
        P22("P3", "And sellers need to have a more realistic understanding of where they stand in relation into being able to call the shots. They need to provide a quality home. Um they're not able to just put it on the market in whatever condition it's in and expect to get top dollar for it. Buyers have become decidedly more choosy and they are experiencing, you know, being able to get deals on properties again. They're they expect to be able to get inspections. Um they expect to be able to negotiate based on the findings from the inspections. Um homes are expected to be able to appraise now.", "01:23:04"),
        P22("P6", "and in trying to have a conversation with her about, you know, meeting in the middle and having realistic expectations when it's been on the the market for over a month. um just being very staunch and and telling me that the seller, you know, that the seller doesn't feel that she should have to have any inspections or like it's 2022, right? The expectations are that of a 20 22 market instead of a 2026 market. And um you know, people just aren't they're not willing to do that anymore.", "01:26:08"),
        P22("P5", "I have a client that just wrote an offer on a property that um it's it's in good condition, but nothing's been updated in years. Um, it's grossly overpriced in comparison to everything else that's on the market in that neighborhood.", "01:24:42"),
        P22("P4", "So sellers need to adjust their expectations and prepare their home appropriately and go into the sale of their home expecting to negotiate. It's a much more even playing field for people now.", "01:24:42"),
        P22("P1", "Let's do the what sellers need to know. This is not 2022.", "01:03:54"),
      ];
      const M22_PROOF = "A home that is in good condition but not updated in years was priced about $20,000 above a fully updated house with nearly the same floor plan. The seller's agent held to 2022 expectations and refused inspections, and after more than a month on the market it still had not sold. Told with no names and no mention of the agent's experience.";
      const M22_PROOF_KEEP = "Proof: an overpriced, not-updated home priced about $20,000 above a fully updated one with the same floor plan, on the market over a month because the expectations were still 2022 (no names, no mention of the agent's experience).";
      const M22_OUT = {
        videoType: "educational", angle: "Sellers who still expect 2022 (a quick sale, over asking, no contingencies) are pricing for a market that is gone, and the viewer leaves knowing that today they have to prepare the home well and expect to negotiate.", centralMessage: "The 2022 playbook no longer works: buyers are choosier and expect inspections, negotiation and a fair appraisal, so a seller needs a home that is prepared and a price that matches today. Marcee helps by setting realistic expectations and preparing the home so it does not sit.",
        proof: { text: M22_PROOF, source: "P5, P6 (call at 01:24:42 to 01:26:08)", isHerStory: true },
        whatSheSaid: ["P2", "P3", "P6", "P5", "P4", "P1"],
        mustKeep: [...[{ text: "Belief: sellers still expect a sale in days, over asking, with multiple offers and no contingencies. That was 2022, and here today it is not the same.", source: "P2" }, { text: "Payoff: buyers are choosier now and expect inspections, negotiation and a fair appraisal, so sellers must prepare the home and expect to negotiate on a more even playing field. How she helps: she sets them up for success with realistic expectations (said once, in the payoff or the close).", source: "P3, P4" }], { text: M22_PROOF_KEEP, source: "P5, P6" }],
        optional: [{ text: "Pre-listing inspection of about $350 to $500 lets the seller fix things on their own terms rather than at a buyer's demand.", source: "F3" }, { text: "Sellers cannot put the home on the market in any condition and expect top dollar.", source: "P3" }, { text: "A home that is prepared well and gets maximum exposure draws more competition; she almost always sells in the first weekend of open houses.", source: "F5" }, { text: "Clients who followed her preparation plan sold for $15K, $20K, sometimes $50K more.", source: "F17" }, { text: "Even though the neighbor sold for a given number, that does not set your price.", source: "P5" }, { text: "A good agent tells sellers the truth rather than that they can sell for whatever price they imagine.", source: "F20, F29" }],
        excluded: [{ text: "That the other agent has had very few sales and has not been in the business long.", reason: "Criticizes a specific agent, could identify her, and was held back; the example is told without it." }, { text: "That the client just wrote an offer on the property, and any detail identifying the listing.", reason: "Live deal. It stays out as a must-keep; in optional only in general terms, with no listing or person identified." }, { text: "The $200,000 off-market example.", reason: "A different topic (exposure and off-market), and she has already told it on camera in an earlier script." }, { text: "The unprompted comparison to how realtors watching the video would agree.", reason: "Speaks to other agents, not to the seller viewer." }, { text: "Interest rates or any other market cause, plus any statistics.", reason: "She did not present them as part of this message." }, { text: "Comments about our service, James, the portal and the Fairy God Realtor series.", reason: "Internal talk about our work with her; the series is discontinued." }],
        contradictions: [{ text: "Her wording of the example says her client 'just wrote an offer' on the property, but she also says the listing has been on the market over a month and the other agent will not budge, which makes it a live deal. The example must be told generally with no identifiers. She also corrected her own figure on the call from about $15,000 to about $20,000; use the corrected $20,000.", sources: "P5, P6 (call at 01:24:42 to 01:26:08)" }, { text: "She says homes can still go quickly, over asking, with two or three offers, so the message is a shift and not a collapse. Avoid claiming that over-asking sales no longer happen.", sources: "P2" }],
        verifiedFacts: [{ text: "Homes in her area can still sell quickly and over asking with two or three offers, but it is nothing like 2022.", source: "P2" }, { text: "Buyers now expect inspections, negotiating on the findings, and a fair appraisal.", source: "P3" }, { text: "A seller recently priced an unupdated home about $20,000 above a fully updated one with nearly the same floor plan, and it sat on the market more than a month.", source: "P5, P6" }, { text: "Her seller strategy centers on maximum visibility and she almost always sells in the first weekend's open houses.", source: "F5" }, { text: "A pre-listing inspection costs about $350 to $500 and lets the seller handle repairs on their terms.", source: "F3" }, { text: "She tells the truth even if it is not what the client wants to hear.", source: "F20" }],
        opinions: [{ text: "Sellers are used to naming their price and running the show; they must adjust their expectations.", source: "P2, P4" }, { text: "It is important for sellers to choose a realtor who recognizes the shift and sets them up for success instead of telling them what they want to hear.", source: "P5" }, { text: "It is a much more even playing field now.", source: "P4" }],
        creativeIdeas: [{ text: "Hook on the seller's own sentence, such as 'My neighbor sold in a weekend, over asking, so mine will too', with a cost or an unanswered question attached.", source: "our assumption" }, { text: "Contrast 2022 (days, over asking, no contingencies) with now (inspection, negotiation, appraisal) as the two things set side by side.", source: "P2, P3" }, { text: "Fully scripted, direct to camera in the house framework, with her brand fonts and colors in the text overlays.", source: "strategy" }],
        herPhrases: [{ text: "It's nothing like it was in 2022", source: "P2" }, { text: "A much more even playing field", source: "P4" }, { text: "Buyers have become decidedly more choosy", source: "P3" }],
      };
      const ctx0 = { clientName: "x", speakerNames: [], strategyText: null, identityBlock: "", guardBlock: "", monthPriorities: [], topic: { title: "This Is Not 2022", pillar: "p", description: null, intendedMessage: null, audienceNeed: null, businessGoal: null, whyChosen: "w" }, facts: [], voiceRefs: [], relatedScripts: [], answers: [], captionExamples: [] } as never;

      c.head("18.1 · v2.5 the live deal never reaches the script: the brief, the writer's passages, and a code finding (Marcee's 2022)");
      {
        const b22 = pipe.briefFrom(M22_OUT as never, M22_PASSAGES);
        const text22 = prompts.writerBriefText(ctx0, b22);
        c.ok("Marcee's 2022 brief, rerun from its v2.4 answer: the proof is out, and P5 and P6 (the deal) leave what she said; P2, P3, P4 and P1 stay", b22.proof === null && b22.whatSheSaid.map((p) => p.passageId).join() === "P2,P3,P4,P1", b22.whatSheSaid.map((p) => p.passageId).join());
        c.ok("…the verified fact, the optional point, the opinion and the contradiction that cite P5 or P6 are dropped; her own $15K to $50K results (F17) stay", !b22.verifiedFacts.some((x) => /20,000/.test(x.text)) && b22.verifiedFacts.length === 5 && !b22.optional.some((x) => /\bP5\b/.test(x.source)) && b22.optional.some((x) => x.source === "F17") && !b22.opinions.some((x) => /\bP5\b/.test(x.source)) && b22.contradictions.length === 1 && !/20,000/.test(b22.contradictions[0]?.text ?? ""));
        c.ok("…excluded names the deal by its passages, \"never in the script\", without its details; code keeps its words for itself (heldBack, live)", b22.excluded[0]?.text === "The deal in P5, P6 (her example; its details stay out)" && /a deal still in progress \(P5: "just wrote an offer"\): never in the script$/.test(b22.excluded[0]?.reason ?? "") && (b22.heldBack ?? []).length === 1 && b22.heldBack![0].kind === "live" && b22.heldBack![0].ids.slice().sort().join() === "P5,P6");
        c.ok("the brief text the writer reads carries no \"$20,000\" and none of her P5 sentence", !/20,000/.test(text22) && !/grossly overpriced/.test(text22), (/[^\n]*20,000[^\n]*/.exec(text22) ?? ["none"])[0]);
        const draft22 = prompts.buildDraftPrompt(ctx0, b22, M22_PASSAGES).prompt;
        const review22 = prompts.buildReviewPrompt(ctx0, b22, M22_PASSAGES, { body: "x" }).prompt;
        c.ok("the writer's prompt leaves out the deal's passages (P5 \"grossly overpriced\", P6 \"meeting in the middle\") and keeps the rest; the reviewer still reads them all", !/grossly overpriced/.test(draft22) && !/meeting in the middle/.test(draft22) && /It's nothing like it was in 2022/.test(draft22) && /grossly overpriced/.test(review22) && /meeting in the middle/.test(review22));
        const hn22 = rules.hardNumbers(V24_FINAL.y2022, M22_PASSAGES.map((p) => p.quote).join("\n"), undefined, { liveDeal: pipe.liveDealOf(b22), kept: pipe.keptTextOf(b22) });
        const ld = hn22.findings.find((x) => x.key === "live_deal");
        const merged22 = rules.mergeViewerReview(rules.VIEWER_CHECK_KEYS.map((key) => ({ key, pass: true, reason: "ok" })), hn22.findings, hn22.words);
        c.ok("live_deal: the v2.4 2022 draft as written fails \"No live deal\" at must-fix by code, naming the re-hook, though the reviewer passed every question", !!ld && ld.level === "must-fix" && ld.part === "rehook" && merged22.some((x) => x.key === "live_deal" && !x.pass && x.level === "must-fix" && /A deal still in progress is told/.test(x.reason)) && rules.HARD_TO_CHECK.live_deal === "live_deal" && pipe.nextWriterStep({ mustFails: rules.mustFixFailures(merged22), rewrites: 0 }) === "rewrite", ld?.detail);
        const f17 = rules.hardNumbers({ hook: V24.y2022.hooks[0][0], points: [{ role: "re-hook", text: "Sellers who followed my prep plan sold for $20,000 more." }], close: "Ask me what yours needs." }, "$20K", undefined, { liveDeal: pipe.liveDealOf(b22), kept: pipe.keptTextOf(b22) });
        c.ok("…her $20K result from another fact (F17) is not the live deal: words the brief uses elsewhere (sellers, plan, sold) do not count", !f17.findings.some((x) => x.key === "live_deal"), f17.findings.map((x) => x.key).join() || "none");
        const said = rules.liveDealFinding({ hook: "My buyer just wrote an offer on a house like yours.", points: [], close: "" }, null);
        c.ok("…a script that says a deal is still in progress (\"just wrote an offer\") fails with no brief at all, in the hook", !!said && said.part === "hook" && said.level === "must-fix");
        c.ok("the brief prompt: a live deal is never in the script (no \"in general terms only\")", prompts.BRIEF_SYSTEM.includes("never must-keep and never the proof. Put it in excluded: never in the script.") && !/in general terms only/.test(prompts.BRIEF_SYSTEM));
        // End to end, offline: a must-keep point marked in progress, and a draft that tells it anyway.
        ctl.brief.set("T", { mustKeep: [{ text: "Her buyer just wrote an offer on a listing priced $20,000 over a fully updated twin.", source: "P1", inProgress: true }, { text: "Spend on what buyers and their agents judge", source: "P2" }] });
        ctl.sizes.set("T", [[10, 10, 10, 10], [10, 10, 10, 10]]);
        ctl.extra.set("T", [LIVE_LINE, ""]);
        ctl.reviews.set("T", [[], []]);
        const t0 = reqs.length;
        const offT = await pipe.draftOffline({ topicId: tT, monthId: f.monthId, requestedBy: STAFF });
        const rwT = reqs.slice(t0).filter((r) => r.step === "rewrite");
        const r1 = offT.attempts[0].review;
        c.ok("offline: the draft that tells the deal anyway fails \"No live deal\" at must-fix by code (in the build-up) though the reviewer passed everything; the ONE rewrite is told; then it passes", offT.state === "passed" && offT.attempts.map((a) => a.label).join() === "draft,rewrite" && !!r1?.hard.some((x) => x.key === "live_deal" && x.part === "buildup") && !!r1?.checks.some((x) => x.key === "live_deal" && !x.pass && x.level === "must-fix") && rwT.length === 1 && /- No live deal: A deal still in progress is told/.test(rwT[0].prompt) && offT.final.label === "rewrite", `${offT.state} · ${offT.attempts.map((a) => `${a.label}:${a.review?.mustFails.map((m) => m.key).join("+")}`).join(", ")}`);
      }

      c.head("18.3 · the part budgets and the trim's sentences (a person's Fix with AI)");
      {
        c.ok("the trim instruction: cut whole sentences or clauses; every sentence keeps its verb", rules.trimInstruction(90).includes("Cut whole sentences or clauses; every sentence keeps its verb."));
        const sum = Object.values(rules.PART_WORDS).reduce((a, b) => a + b, 0);
        c.ok("the part budgets add up to 80 (advice when a part runs over)", sum === 80 && rules.partLengthFindings({ hook: "h", points: [{ role: "re-hook", text: Array.from({ length: 20 }, () => "word").join(" ") }], close: "" }).every((x) => x.level === "flag"), String(sum));
      }

      c.head("18.4 · the build-up advice: an agreed format's translations are no echo; \"offers\"; numbered steps");
      {
        const PH = V24_FINAL.phrases;
        const fmt = rules.agreedFormatOf({ creativeIdeas: [{ text: "Agreed format: word association, James says the listing phrase, John gives the deadpan translation, dry humor, straight to camera." }, { text: "Personality video to show his dry humor." }] });
        const echo = (fs: { key: string; part?: string }[]) => fs.some((x) => x.key === "hook_echo" && x.part === "buildup");
        c.ok("John's Phrases build-up translates the hook's words in the agreed word association (five \"X means Y\" beats): no hook_echo with the agreed format, noted without it", !!fmt && /^Agreed format: word association/.test(fmt) && rules.translationBeats(rules.partTextOf(PH, "buildup")) === 5 && !echo(rules.craftFindings(PH, { agreedFormat: fmt })) && echo(rules.craftFindings(PH)));
        const sh = rules.buildupFragments(rules.partTextOf(V24_FINAL.showings, "buildup"));
        c.ok("\"offers\" is not a verb: John's Showings build-up \"Showings, good feedback, no offers?\" is noted as a sentence with no verb", sh.some((x) => /no verb/.test(x.detail) && /"Showings, good feedback, no offers\?"/.test(x.detail)) && !rules.hasVerb("Showings, good feedback, no offers?") && rules.hasVerb("She offers a pre-listing walk-through."), sh.map((x) => x.detail).join(" | "));
        const st = rules.buildupFragments(rules.partTextOf(V24_FINAL.repairs, "buildup"));
        c.ok("numbered steps are a list: Marcee's Repairs build-up \"Step one: ... Step two: ...\" is noted (a flag)", st.some((x) => /numbered steps \("Step one:", "Step two:"\)/.test(x.detail) && x.level === "flag"), st.map((x) => x.detail).join(" | "));
      }

      c.head("18.5 · v2.5 the brief: when a contradiction says the proof does not support the message, the angle takes the message the proof supports");
      {
        c.ok("BRIEF_SYSTEM says so, in plain words, quoting no client", prompts.BRIEF_SYSTEM.includes("WHEN THE PROOF AND THE MESSAGE DISAGREE: when a contradiction you list says her proof does not support the message") && prompts.BRIEF_SYSTEM.includes("the angle takes the message the proof supports, and centralMessage and mustKeep follow it") && prompts.BRIEF_SYSTEM.includes("Never frame a story around a message it contradicts"));
      }
    }

    // =======================================================================
    // 19 · WRITER v2.6, ONE THOUGHT (Oct 23 2026). Jordan: "Erica's scripts are
    // awful... They make no sense." On the Doorknob script: "it's not really
    // thinking about the topic, or the agent and what they said completely.
    // Like it's overanalyzing and overcompensating, maybe?"
    // =======================================================================
    c.head("19.1 · the drafting prompt: the short rule list; the bar is scripts Jordan approved and sent to OTHER clients, picked at draft time");
    {
      const sys = prompts.WRITER_SYSTEM;
      c.ok("the five parts and what each does, written as ONE thought", sys.includes("Write the whole script as ONE thought, in five parts that follow from each other:") && ["- HOOK: the first line. It lands on its own", "- RE-HOOK: the next line raises it", "- BUILD-UP: what makes it true: her proof from the brief", "- PAYOFF: the answer to the hook, in a line the viewer could repeat.", "- CLOSE: a call to action tied to the message, or a line that pays off the hook."].every((x) => sys.includes(x)));
      c.ok("her voice (first person, as she talks; her phrases where they fit); 55 to 85 words; no dashes or durations; never invent, never words in anyone's mouth", sys.includes("Her voice: she is the one speaking, in the first person, the way she talks. Use her phrases where they fit.") && sys.includes("Length: 55 to 85 spoken words.") && sys.includes("No em dashes or en dashes. No durations or timing notes.") && sys.includes("Never invent a fact, a number, a quote or a story, and never put words in anyone else's mouth: only what her sources say."));
      c.ok("…and nothing else: none of the old rule blocks, and a short prompt (under 2,000 characters; v2.5's was over 9,000)", sys.length < 2000 && !/HOUSE CRAFT|HER MATERIAL, OUR WORDING|PLAIN WORDS FOR HOMEOWNERS|OUR ASSUMPTIONS ARE NOT|BACKGROUND IS NOT|NEITHER VERSION WINS|CLOSE \(Jordan|LENGTH \(Jordan|TRUTH:|THE FRAMEWORK/.test(sys), String(sys.length));
      c.ok("the examples are named for what they are (approved and sent to other clients), shape and voice, never content", sys.includes("Any examples below are scripts Jordan approved and sent to other clients: they show the bar, in shape and voice. Never copy their content, lines, facts or stories."));
      const draftA = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_A))?.prompt ?? "";
      const draftB = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_B))?.prompt ?? "";
      const SKIPPED = [HOOK_ONE_OLD, HOOK_TWO_JAMES, HOOK_TWO_LONG, HOOK_TWO_DASH, HOOK_TWO_SHORT, HOOK_THREE_IMPORT, HOOK_THREE_SKIT, HOOK_HERS];
      c.ok("topic A's draft: the most recent qualifying script of each OTHER client, in five labelled parts, under the label \"scripts Jordan approved and sent to other clients\"", /EXAMPLES OF THE BAR \(2 scripts Jordan approved and sent to other clients\. They show the shape and the voice: one thought from the first line to the last, short spoken sentences, a hook that lands at once\. Never copy their content, lines, facts or stories\.\)/.test(draftA) && draftA.indexOf(`--- Example 1 ---\nHOOK: ${HOOK_ONE_NEW}`) > 0 && draftA.indexOf(`--- Example 2 ---\nHOOK: ${HOOK_TWO_GOOD}`) > draftA.indexOf(HOOK_ONE_NEW), (/EXAMPLES OF THE BAR[^\n]*/.exec(draftA) ?? ["none"])[0]);
      c.ok("…never her own, one James approved, one over 110 or under 55 words, one with a dash, an imported one, a skit, or one on the same topic; at most one per client (the older of Olivia's is not shown)", SKIPPED.every((h) => !draftA.includes(h)) && !draftA.includes(HOOK_THREE_SAME), SKIPPED.filter((h) => draftA.includes(h)).join(" | ") || "none");
      c.ok("…topic B's draft (not that topic) also gets the third client's script: three, most recently sent first", (draftB.match(/--- Example \d ---\nHOOK: /g) ?? []).length === 3 && draftB.indexOf(HOOK_ONE_NEW) < draftB.indexOf(HOOK_THREE_SAME) && draftB.indexOf(HOOK_THREE_SAME) < draftB.indexOf(HOOK_TWO_GOOD) && SKIPPED.every((h) => !draftB.includes(h)));
      const runA = await prisma.programAiRun.findFirst({ where: { kind: "script_draft", promptKey: "writer-draft", scopeJson: { contains: tA } }, orderBy: { createdAt: "asc" }, select: { inputRefsJson: true } });
      c.ok("the draft's run records which scripts were shown", (JSON.parse(runA?.inputRefsJson ?? "{}") as { barExampleScriptIds?: string[] }).barExampleScriptIds?.join() === [BAR.oneNew, BAR.twoGood].join(), runA?.inputRefsJson?.slice(0, 200));
      const blk = (r: Req | undefined) => ((r?.body.messages as { content: { text: string }[] }[] | undefined)?.[0].content ?? [])[0]?.text ?? "";
      const dB = reqs.find((r) => r.step === "draft" && r.prompt.includes(TOPIC_B));
      const rwB = reqs.find((r) => r.step === "rewrite" && r.prompt.includes(TOPIC_B));
      const rvB = reqs.filter((r) => r.step === "review" && r.prompt.includes(TOPIC_B));
      c.ok("deterministic for a topic: the draft and its rewrite carry the same examples block, byte for byte (the cached block stays stable); both reviews show the same bar", !!dB && !!rwB && blk(dB) === blk(rwB) && rvB.length === 2 && rvB.every((r) => r.prompt.includes(HOOK_ONE_NEW) && r.prompt.includes(HOOK_THREE_SAME)));
      const bar = await import("@/lib/scriptWriter/barExamples");
      const again1 = await bar.barExamplesFor({ enrollmentId: f.enrollmentId, topicTitle: TOPIC_B });
      const again2 = await bar.barExamplesFor({ enrollmentId: f.enrollmentId, topicTitle: TOPIC_B });
      c.ok("…and asking twice gives the same scripts in the same order", again1.map((x) => x.scriptId).join() === again2.map((x) => x.scriptId).join() && again1.map((x) => x.scriptId).join() === [BAR.oneNew, BAR.threeSame, BAR.twoGood].join());
      c.ok("…for one of the other clients, its own scripts are never shown and hers can be", (await bar.barExamplesFor({ enrollmentId: barOne.enrollmentId, topicTitle: TOPIC_B })).map((x) => x.scriptId).join() === [BAR.hers, BAR.threeSame, BAR.twoGood].join());
      c.ok("offline as of a past moment: only scripts sent by then", (await bar.barExamplesFor({ enrollmentId: f.enrollmentId, topicTitle: TOPIC_B, asOf: new Date("2026-10-06T00:00:00Z") })).map((x) => x.scriptId).join() === BAR.twoGood);
      // The picker itself (pure), on hand-built candidates.
      const cand = (id: string, o: Partial<import("@/lib/scriptWriter/barExamples").BarCandidate> & { build?: number } = {}) => ({ scriptId: id, enrollmentId: o.enrollmentId ?? `e-${id}`, clientId: o.clientId ?? `c-${id}`, title: o.title ?? `Script ${id}`, topicTitle: o.topicTitle ?? null, source: o.source ?? "ai", historical: o.historical ?? false, approvedBy: o.approvedBy === undefined ? OWNER_EMAIL : o.approvedBy, approvedAt: o.approvedAt === undefined ? new Date("2026-10-01") : o.approvedAt, sharedAt: o.sharedAt === undefined ? new Date("2026-10-01") : o.sharedAt, version: o.version ?? { hook: `Hook ${id} for the drill.`, pointsJson: JSON.stringify([{ text: words(12, 1) }, { text: words(o.build ?? 20, 2) }, { text: words(14, 4) }]), close: words(12, 6) } });
      const pick = (cs: ReturnType<typeof cand>[], owners = [OWNER_EMAIL]) => bar.pickBarExamples(cs, { enrollmentId: "mine", topicTitle: TOPIC_A, owners }).map((x) => x.scriptId).join();
      c.ok("pure: never the same enrollment; never one another login approved; the approver read from a stamp like \"info@... (via ...)\"", pick([cand("a", { enrollmentId: "mine" }), cand("b", { approvedBy: JAMES_EMAIL }), cand("c", { approvedBy: `${OWNER_EMAIL.toUpperCase()} (via Claude)` })]) === "c");
      c.ok("pure: never over 110 or under 55 spoken words, a dash, an import, a historical one, an unsent or unapproved one, or a skit", pick([cand("long", { build: 82 }), cand("short", { build: 2 }), cand("dash", { version: { hook: "A hook — with a dash.", pointsJson: JSON.stringify([{ text: words(12, 1) }, { text: words(20, 2) }, { text: words(14, 4) }]), close: words(12, 6) } }), cand("imp", { source: "import" }), cand("hist", { historical: true }), cand("unsent", { sharedAt: null }), cand("unapproved", { approvedAt: null }), cand("skit", { version: { hook: "Skit hook for the drill.", pointsJson: JSON.stringify([{ text: words(12, 1) }, { text: words(20, 2) }, { text: words(14, 4) }]), close: words(12, 6), speakerLabelsJson: JSON.stringify(["AGENT", "BUYER"]) } }), cand("ok")]) === "ok");
      c.ok("pure: not the five parts (two talking points) is skipped; at most one per client; up to three, most recently sent first", pick([cand("two", { version: { hook: "Hook two points.", pointsJson: JSON.stringify([{ text: words(30, 1) }, { text: words(30, 2) }]), close: words(12, 6) } })]) === "" && pick([cand("x1", { clientId: "same", sharedAt: new Date("2026-10-02") }), cand("x2", { clientId: "same", sharedAt: new Date("2026-10-03") }), cand("y", { sharedAt: new Date("2026-10-01") }), cand("z", { sharedAt: new Date("2026-09-01") }), cand("w", { sharedAt: new Date("2026-08-01") })]) === "x2,y,z");
      c.ok("pure: nothing qualifies (no owner login, or no candidate) → no examples", pick([cand("ok")], []) === "" && pick([]) === "");
      // Audit, Oct 23 2026: never words that are not Jordan's bar, whoever approved them.
      const okV = (createdBy: string) => ({ hook: "Hook for the drill.", pointsJson: JSON.stringify([{ text: words(12, 1) }, { text: words(20, 2) }, { text: words(14, 4) }]), close: words(12, 6), createdBy });
      c.ok("audit: never a bulk plan's script (the client's own bank), a version a local one-off wrote (dev@local, \"(via Claude ...)\"), or Erica's four hand-rewritten October scripts", pick([{ ...cand("bulk"), bulkBank: true }, cand("local", { version: okV("dev@local") }), cand("viaClaude", { version: okV("info@realtourpilot.com (via Claude: best version current, Oct 23 2026)") }), cand("cmvh4spk600aujs08mxo7xf8b"), cand("cmvh4a9mt005ujs08ucz5bvdp"), cand("mine2", { version: okV("info@realtourpilot.com") })]) === "mine2" && bar.CLAUDE_HAND_WRITTEN.size === 4);
      const ctxNone = { clientName: "Erica Walker", guardBlock: "", boundaries: [], barExamples: [], facts: [], strategyText: null, topic: { title: "I Once Watched a Deal Fall Apart Over a Doorknob" }, answers: [], voiceRefs: [], captionExamples: [] } as never;
      const bD = pipe.briefFrom({ videoType: "educational", angle: "Deals die of frustration, not doorknobs.", proof: null, mustKeep: [{ text: "She stays the calm one", source: "P3" }], herPhrases: [{ text: "how do we get there?", source: "P3" }], excluded: [{ text: "A specific doorknob deal as if she had witnessed it", reason: "She did not tell a doorknob story." }] } as never, []);
      const pD = prompts.buildDraftPrompt(ctxNone, bD, []).prompt;
      c.ok("with no examples, the draft and the review prompts carry no examples block (rules only); the brief still carries her phrases, what to leave out and no proof to make a story from", !/EXAMPLES OF THE BAR|--- Example 1 ---/.test(pD) && !/EXAMPLES OF THE BAR/.test(prompts.buildReviewPrompt(ctxNone, bD, [], { body: "x" }).prompt) && /Her phrases \(use them where they fit\):\n- "how do we get there\?"/.test(pD) && /Leave out:\n- A specific doorknob deal as if she had witnessed it \(She did not tell a doorknob story\.\)/.test(pD) && /Her proof: None from her/.test(pD));
      // End to end with no owner login left: the offline draft is written from the rules alone.
      await prisma.appUser.update({ where: { email: OWNER_EMAIL }, data: { status: "DISABLED" } });
      ctl.reviews.set("H", [[]]);
      const n0 = reqs.length;
      await pipe.draftOffline({ topicId: tH, monthId: f.monthId, requestedBy: STAFF });
      const noneDraft = reqs.slice(n0).find((r) => r.step === "draft");
      await prisma.appUser.update({ where: { email: OWNER_EMAIL }, data: { status: "ACTIVE" } });
      c.ok("…end to end: with no owner login, the offline draft and its review have no examples block", !!noneDraft && !/EXAMPLES OF THE BAR/.test(noneDraft.prompt) && reqs.slice(n0).filter((r) => r.step === "review").every((r) => !/EXAMPLES OF THE BAR/.test(r.prompt)));
      c.ok("the review is shown the same bar as the writer", (reqs.find((r) => r.step === "review" && r.prompt.includes(TOPIC_A))?.prompt ?? "").includes(`HOOK: ${HOOK_ONE_NEW}`));
    }

    c.head("19.2 · the review reads it as a viewer FIRST: four questions, a read, one note; code's hard checks after");
    {
      const rs = prompts.REVIEW_SYSTEM;
      c.ok("the reviewer reads the script first, start to finish, as a viewer would hear it", /^You read ONE short video script the way a viewer would hear it, before anything else\./.test(rs) && rs.includes("Read the SCRIPT once, start to finish, as someone scrolling would hear it."));
      c.ok("…its four questions: one thought; would THIS agent say it; the hook lands and the rest follows; is anything invented", ["- sense: does it make sense from start to finish as ONE thought?", "- voice: would THIS agent say it, in these words?", "- hook: does the hook land in the first line, on its own? Do the re-hook, the build-up and the payoff follow from it", "- invented: is anything invented?"].every((x) => rs.includes(x)) && rs.includes("A line in a client's or a viewer's voice that she would not say as herself fails"));
      c.ok("…a 1 to 10 read, and ONE note about the script as a whole, never a list of parts to patch", rs.includes("reads: 1 to 10, how well it works for a viewer as one thought") && rs.includes("note: when any question fails, ONE note to the writer about the script as a whole") && rs.includes("Never a list of parts to patch."));
      const schema = prompts.REVIEW_SCHEMA as { properties: Record<string, unknown>; required: string[] };
      c.ok("the schema: sense, voice, hook, invented (pass and a reason each), reads, note, summary; no checks list, no craft block", schema.required.join() === "sense,voice,hook,invented,reads,note,summary" && !("craft" in schema.properties) && !("checks" in schema.properties));
      c.ok("REVIEW_CHECKS: the four viewer questions, then code's six hard checks, then Advice (a flag)", rules.REVIEW_CHECKS.map((x) => x.key).join() === "sense,voice,hook,invented,length,dashes,durations,numbers,quotes,live_deal,advice" && rules.REVIEW_CHECKS.filter((x) => x.level === "flag").map((x) => x.key).join() === "advice" && rules.VIEWER_CHECK_KEYS.join() === "sense,voice,hook,invented");
      const none = rules.mergeViewerReview([], [], 70);
      c.ok("a question the reviewer did not answer fails, never passes", none.filter((x) => rules.VIEWER_CHECK_KEYS.includes(x.key)).every((x) => !x.pass && x.level === "must-fix" && /Not answered by the reviewer/.test(x.reason)));
      c.ok("readViewerReview: the read is clamped to 1..10 (null when missing); an answer without pass reads as a fail", pipe.readViewerReview({ reads: 14 }).reads === 10 && pipe.readViewerReview({}).reads === null && rules.mergeViewerReview(pipe.readViewerReview({ sense: { reason: "?" } }).answers, [], 70).find((x) => x.key === "sense")?.pass === false);
      c.ok("nextWriterStep: nothing must-fix → pass; a must-fix and no rewrite yet → the one rewrite; a rewrite spent → flag (MAX_REWRITES 1)", rules.MAX_REWRITES === 1 && pipe.nextWriterStep({ mustFails: [], rewrites: 0 }) === "pass" && pipe.nextWriterStep({ mustFails: [{}], rewrites: 0 }) === "rewrite" && pipe.nextWriterStep({ mustFails: [{}], rewrites: 1 }) === "flag" && pipe.nextWriterStep({ mustFails: [], rewrites: 1 }) === "pass");
      c.ok("…reads better: fewer must-fix first, then the read (a v2.5 version: its craft total), then the length", rules.isBetterAttempt({ mustFix: 0, reads: 2, words: 70 }, { mustFix: 1, reads: 9, words: 70 }) && rules.isBetterAttempt({ mustFix: 1, reads: 6, words: 70 }, { mustFix: 1, reads: 5, words: 70 }) && !rules.isBetterAttempt({ mustFix: 1, reads: 5, words: 70 }, { mustFix: 1, reads: 5, words: 70 }) && rules.qualityOf({ reads: 7 }) === 21 && rules.qualityOf({ craft: rules.CRAFT_PARTS.reduce((o, p) => ({ ...o, [p.key]: { score: 4, note: "" } }), {}) as never }) === 24);
    }

    c.head("19.3 · calls per script: five for a draft that passes, seven when it is rewritten (v2.5: five at the least, about ten on Erica's drafts)");
    {
      const per = async (topicId: string) => { const scope = await prisma.programAiRun.findMany({ where: { enrollmentId: f.enrollmentId, kind: { in: ["script_retrieval", "script_brief", "script_draft", "script_review", "script_revise", "script_hooks"] }, promptKey: { startsWith: "writer-" } }, select: { scopeJson: true, kind: true } }); const s = await prisma.contentScript.findFirst({ where: { topicId }, select: { id: true } }); return scope.filter((r) => { const j = JSON.parse(r.scopeJson ?? "{}") as { topicId?: string; scriptId?: string }; return j.topicId === topicId || (!!s && j.scriptId === s.id); }).length; };
      // Topic A passed first time in 5 calls (section 2-7; section 10 then drafted it again by hand); B was revised by a person in section 12.
      const cc = await per(tC), e = await per(tE), g = await per(tG);
      c.ok("in the run ledger: topics C, E and G (one rewrite each) took 7 calls: retrieval twice, the brief, the draft, its review, the rewrite, its review", cc === 7 && e === 7 && g === 7, `C ${cc} · E ${e} · G ${g}`);
      c.ok("…no hooks run, no trim, no fix round anywhere in this drill's writer runs", (await prisma.programAiRun.count({ where: { kind: "script_hooks" } })) === 0 && !reqs.some((r) => r.step === "hooks" || r.step === "fix"));
    }

    c.head("19.4 · a v2.5 record left mid-loop: no trim runs, and a spent round is never rewritten");
    {
      ctl.reviews.set("L", [[]]);
      const rL = await gen.generateScriptForTopic({ topicId: tL, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id, checkDeadline: Date.now() + 1_000 });
      const v = (await versionsOf(rL.scriptId))[0];
      const bag = JSON.parse(v.validationJson ?? "{}") as Record<string, unknown>;
      // As v2.5 left it: owed its trim before the first review.
      await prisma.contentScriptVersion.update({ where: { id: v.id }, data: { validationJson: JSON.stringify({ ...bag, judge: { ...(bag.judge as object), state: "trimming", trimKind: "first", words: v.spokenWordCount } }) } });
      const l0 = reqs.length;
      const res = await judgeLib.autoCheckScript(rL.scriptId, { requestedBy: STAFF, unattended: false });
      c.ok("\"trimming\" with no review yet: reviewed as it stands (no trim call), passed", loopOf(reqs.slice(l0)) === "review" && res.state === "passed", `${loopOf(reqs.slice(l0))} · ${res.state}`);
      // As v2.5 left another: two fix rounds spent, still failing, a fix owed.
      const fixing = { ...(jr(v.validationJson) as object), state: "fixing", fixRounds: 2, checks: [{ key: "on_topic", n: 1, label: "On topic", level: "must-fix", pass: false, reason: "v2.5" }] };
      await prisma.contentScriptVersion.update({ where: { id: v.id }, data: { validationJson: JSON.stringify({ ...JSON.parse((await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: v.id } })).validationJson ?? "{}"), judge: fixing }) } });
      const l1 = reqs.length;
      const res2 = await judgeLib.autoCheckScript(rL.scriptId, { requestedBy: STAFF, unattended: false });
      c.ok("\"fixing\" with its rounds spent (v2.5): flagged as it stands, nothing sent", reqs.length === l1 && res2.state === "flagged", `${res2.state} · ${reqs.slice(l1).map((r) => r.step).join(",")}`);
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

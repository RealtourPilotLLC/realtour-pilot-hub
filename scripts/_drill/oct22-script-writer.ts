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
const HOOK_RUNNER_UP = "Fresh paint can do more than a new kitchen.";
const HOOK_THIRD = "Before you renovate, look at your house the way a buyer will.";
const CONCEPT_A = "Items buyers and inspectors flag every single time, and most are never cosmetic.";
const HOOK_WIN = "The repairs you think your house needs might not be where your money should go.";
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
};
const usage = { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const ok = (json: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "msg_drill", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(json) }], stop_reason: "end_turn", usage, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
const topicOf = (prompt: string) => (prompt.includes(TOPIC_A) ? "A" : prompt.includes(TOPIC_B) ? "B" : prompt.includes(TOPIC_C) ? "C" : prompt.includes(TOPIC_E) ? "E" : prompt.includes(TOPIC_F) ? "F" : prompt.includes(TOPIC_H) ? "H" : prompt.includes(TOPIC_I) ? "I" : prompt.includes(TOPIC_G) ? "G" : prompt.includes(TOPIC_J) ? "J" : "?");
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
  const hook = step !== "draft" && told ? told : t === "B" ? HOOK_WIN_B : HOOK_WIN;
  return {
    title: step === "draft" ? `Draft for ${t}` : `Revised ${t}`, hook: step === "draft" ? "A hook the code must replace with the winner." : hook,
    rehook: words(sz[0], 1), buildup: words(sz[1], 3), payoff: words(sz[2], 5), close: t === "A" ? `Before you change everything, ${words(Math.max(1, sz[3] - 4), 7)}` : words(sz[3], 9),
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
  const prompt = String(((body.messages as { content?: string }[]) ?? [])[0]?.content ?? "");
  const step = stepOf(system, prompt);
  reqs.push({ step, body, headers, system, prompt });
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
      });
    case "hooks":
      return ok({ hooks: [
        { text: "Sellers, your repairs list is probably wrong.", rehook: "Here is why.", lever: "belief", scores: { relevance: 5, curiosity: 5, specificity: 5, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "names the audience" },
        { text: "Your buyer will never see the kitchen you are about to redo.", rehook: "They look elsewhere.", lever: "contrast", scores: { relevance: 5, curiosity: 5, specificity: 5, naturalDelivery: 5, accuracy: 3, herVoice: 5, payoffConnection: 5 }, note: "not quite what she said" },
        { text: t === "B" ? HOOK_WIN_B : HOOK_WIN, rehook: "Sometimes paint does more than a renovation.", lever: "belief", scores: { relevance: 5, curiosity: 4, specificity: 4, naturalDelivery: 5, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "her own contrast" },
        { text: "Fresh paint can do more than a new kitchen.", rehook: "But not always.", lever: "contrast", scores: { relevance: 4, curiosity: 4, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 3 }, note: "" },
        { text: "Before you renovate, look at your house the way a buyer will.", rehook: "They start with the roof.", lever: "advice", scores: { relevance: 4, curiosity: 3, specificity: 4, naturalDelivery: 4, accuracy: 5, herVoice: 4, payoffConnection: 4 }, note: "" },
      ] });
    case "draft": case "trim": case "fix": case "revise":
      return ok(writerAnswer(t, step, prompt));
    case "review": {
      const queue = ctl.reviews.get(t) ?? [];
      const failing = queue.shift() ?? [];
      ctl.reviews.set(t, queue);
      const keys = ["on_topic", "her_meaning", "hook", "rehook", "story", "substance", "payoff", "close", "her_voice", "claims", "length", "nothing_extra"];
      return ok({ checks: keys.map((key) => ({ key, pass: !failing.includes(key), reason: failing.includes(key) ? `REVIEW NOTE ${key}: the chronology is bent (she worked in senior living before real estate).` : "ok" })), fixInstruction: failing.length ? "Put her senior-living career before her license, as she said it." : "", summary: failing.length ? "Not yet." : "Strong." });
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
      topics: [TOPIC_A, TOPIC_B, TOPIC_C, TOPIC_D, TOPIC_E, TOPIC_F, TOPIC_H, TOPIC_I, TOPIC_G, TOPIC_J].map((title) => ({ title, selection: "SELECTED" as const, source: "ai" })),
    });
    const [tA, tB, tC, tD, tE, tF, tH, tI, tG, tJ] = f.topicIds;
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
    ctl.sizes.set("A", [[40, 36, 26, 18], [22, 20, 16, 12]]); // the draft: 15 + 120 = 135 words; the trim: 15 + 70 = 85
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
      c.ok("retrieval and brief at medium effort; hooks, draft and review at high", ret?.body && (ret.body.output_config as { effort: string }).effort === "medium" && (step("brief")[0]?.body.output_config as { effort: string }).effort === "medium" && (step("hooks")[0]?.body.output_config as { effort: string }).effort === "high" && (step("draft")[0]?.body.output_config as { effort: string }).effort === "high" && (step("review")[0]?.body.output_config as { effort: string }).effort === "high");
      c.ok("every writer request: opus 5.5, json_schema, no tool_choice, no temperature, version unchanged", mine.filter((r) => r.step !== "other").every((r) => r.body.model === "claude-opus-5-5" && (r.body.output_config as { format: { type: string } }).format.type === "json_schema" && !("tool_choice" in r.body) && !("temperature" in r.body) && r.headers["anthropic-version"] === "2023-06-01"), mine.map((r) => r.step).join(","));

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
    c.head("8a · a 135-word draft: the review fails only the length → the trim pass → passed");
    {
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rA.scriptId }, orderBy: { versionNo: "asc" } });
      const j1 = (await import("@/lib/scriptJudgeRecord")).readJudge(vs[0].validationJson);
      c.ok("v1: 135 spoken words, the length check failed by CODE (must-fix: A bit long: needs a fix)", vs[0].spokenWordCount === 135 && j1?.checks?.find((x) => x.key === "length")?.pass === false && /A bit long: needs a fix/.test(j1?.checks?.find((x) => x.key === "length")?.reason ?? ""), `${vs[0].spokenWordCount} words`);
      const trimP = step("trim")[0]?.prompt ?? "";
      c.ok("…straight to the trim pass (no fix round for length alone)", step("trim").length === 1 && step("fix").length === 0 && /LENGTH TRIM: this version is 135 spoken words[\s\S]*over the 110-word cap[\s\S]*Trim it toward 75 to 80 spoken words[\s\S]*it must end at 110 words or fewer/.test(trimP), trimP.slice(trimP.indexOf("LENGTH TRIM"), trimP.indexOf("LENGTH TRIM") + 200));
      c.ok("…naming the brief's must-keep points, none of which may be dropped", /These must-keep points from the brief survive, in substance: "She recommends a pre-listing inspection"/.test(trimP) && /Never drop a must-keep point/.test(trimP));
      const last = vs[vs.length - 1];
      const jl = (await import("@/lib/scriptJudgeRecord")).readJudge(last.validationJson);
      c.ok("v2: trimmed to 85 words, reviewed again: passed, 12 of 12", vs.length === 2 && last.spokenWordCount === 85 && jl?.state === "passed" && jl.trimmed === true && rules.reviewHeadline(jl.checks ?? []) === "Creative review: 12 of 12 pass", `${last.spokenWordCount} · ${jl?.state}`);
      c.ok("…its brief carried forward, the change summary says it was trimmed", !!record.readWriter(last.validationJson)?.brief && /Trimmed by the creative review/.test(last.changeSummary ?? ""));
      const card = record.writerCardOf(last.validationJson);
      c.ok("the card: the review headline, the rationale, the brief", card?.review?.headline === "Creative review: 12 of 12 pass" && card.review.trimmed && !!card.rationale?.hook && card.brief.whatSheSaid.length === 2);
      c.ok("…review steps ran on the writer path, their own kind (script_review), counted apart from the client cap", (await prisma.programAiRun.count({ where: { kind: "script_review", enrollmentId: f.enrollmentId, model: "claude-opus-5-5" } })) === 2);
    }

    // =======================================================================
    c.head("8b · a must-fix failure: two fix rounds, still failing → FLAGGED, never passed");
    ctl.sizes.set("B", [[14, 14, 14, 12], [14, 14, 14, 12], [14, 14, 14, 12]]);
    ctl.reviews.set("B", [["her_meaning", "close"], ["her_meaning"], ["her_meaning"]]);
    const b0 = reqs.length;
    const rB = await gen.generateScriptForTopic({ topicId: tB, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineB = reqs.slice(b0);
      const fixes = mineB.filter((r) => r.step === "fix");
      c.ok("two fix rounds ran, each with the review's notes and the reviewer's instruction", fixes.length === 2 && /MUST FIX:\n- 2\. Her meaning: REVIEW NOTE her_meaning/.test(fixes[0].prompt) && /Put her senior-living career before her license/.test(fixes[0].prompt) && /ALSO IMPROVE IF YOU CAN[\s\S]*8\. Close/.test(fixes[0].prompt), String(fixes.length));
      c.ok("…three reviews, no trim (it was never over the cap)", mineB.filter((r) => r.step === "review").length === 3 && mineB.filter((r) => r.step === "trim").length === 0, mineB.map((r) => r.step).join(","));
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: rB.scriptId } });
      const cur = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: s.currentVersionId! } });
      const j = (await import("@/lib/scriptJudgeRecord")).readJudge(cur.validationJson);
      c.ok("it arrives FLAGGED, with the failing check named", j?.state === "flagged" && (j.checks ?? []).some((x) => x.key === "her_meaning" && !x.pass && x.level === "must-fix"), j?.state);
      const card = record.writerCardOf(cur.validationJson);
      c.ok("the card says so: 11 of 12 pass, the must-fix check and its reason", card?.review?.headline === "Creative review: 11 of 12 pass" && /Still failing a must-fix check/.test(card.review.note ?? "") && card.review.failing.some((x) => x.n === 2 && x.level === "must-fix"), `${card?.review?.headline} · ${JSON.stringify(card?.review?.failing)} · ${cur.spokenWordCount}w`);
      c.ok("…sorted first in the review queue (flagged), and still waiting for Jordan", (await import("@/lib/scriptJudgeRecord")).judgeFlagged(j) && cur.status === "INTERNAL_REVIEW" && !s.approvedVersionId && !s.sharedVersionId);
    }

    // =======================================================================
    c.head("8c · a draft that stays long: trimmed, fixed twice, still over 110 → flagged \"A bit long: needs a fix\", never shared");
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
    c.head("8d · the aim made real: a passing 98-word draft gets ONE trim toward 75 to 80, reviewed again → 78 words, passed");
    ctl.sizes.set("E", [[26, 24, 20, 13], [18, 18, 16, 11]]);
    ctl.reviews.set("E", [[], []]);
    const e0 = reqs.length;
    const rE = await gen.generateScriptForTopic({ topicId: tE, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const mineE = reqs.slice(e0);
      const draftP = mineE.find((r) => r.step === "draft")?.prompt ?? "";
      c.ok("the draft prompt asks for about 75 spoken words, plainly, with the must-keep points as the only things that must survive", draftP.includes("Write the script in about 75 spoken words (55 to 85; 110 is the hard cap). The brief's must-keep points are the only things that must survive"));
      const trims = mineE.filter((r) => r.step === "trim");
      c.ok("one trim pass toward 75 to 80 (not a cap trim), its must-keep points named", trims.length === 1 && /Trim it toward 75 to 80 spoken words \(the aim is 55 to 85\)/.test(trims[0].prompt) && !/over the 110-word cap/.test(trims[0].prompt) && /"She recommends a pre-listing inspection"/.test(trims[0].prompt));
      c.ok("…then reviewed again (two reviews), no fix round", mineE.filter((r) => r.step === "review").length === 2 && !mineE.some((r) => r.step === "fix"), mineE.map((r) => r.step).join(","));
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rE.scriptId }, orderBy: { versionNo: "asc" } });
      const jl = (await import("@/lib/scriptJudgeRecord")).readJudge(vs[vs.length - 1].validationJson);
      c.ok("98 → 78 words: the trimmed version is current and passed", vs.length === 2 && vs[0].spokenWordCount === 98 && vs[1].spokenWordCount === 78 && jl?.state === "passed" && jl.aimTrimmed === true && /Trimmed toward 75 to 80 words by the creative review/.test(vs[1].changeSummary ?? ""), vs.map((v) => v.spokenWordCount).join(" → "));
      c.ok("…the 98-word draft's review said \"Longer than the 55 to 85 aim\" as a flag, not a must-fix", (() => { const j0 = (JSON.parse(vs[0].validationJson ?? "{}") as { judge?: { checks?: { key: string; level: string; pass: boolean; reason: string }[] } }).judge; const l = j0?.checks?.find((x) => x.key === "length"); return !!l && !l.pass && l.level === "flag" && /Longer than the 55 to 85 aim/.test(l.reason); })());
    }

    // =======================================================================
    c.head("8e · a trim that drops a must-keep point is undone: the longer passing version stands, the advisory flag stays");
    ctl.sizes.set("F", [[24, 24, 20, 13], [14, 14, 14, 13]]);
    ctl.reviews.set("F", [[], ["substance"]]);
    const rF = await gen.generateScriptForTopic({ topicId: tF, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
    {
      const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: rF.scriptId }, orderBy: { versionNo: "asc" } });
      const head = await prisma.contentScript.findUniqueOrThrow({ where: { id: rF.scriptId } });
      const cur = vs.find((v) => v.id === head.currentVersionId)!;
      const jr = (await import("@/lib/scriptJudgeRecord")).readJudge;
      c.ok("v1 96 words passed → v2 trimmed to 70 failed Enough substance → v3 = v1 again, current", vs.length === 3 && vs[0].spokenWordCount === 96 && vs[1].spokenWordCount === 70 && cur.id === vs[2].id && cur.body === vs[0].body, vs.map((v) => `v${v.versionNo}:${v.spokenWordCount}`).join(" "));
      c.ok("…v3 carries v1's passing review, marked trimmed; v2 is flagged with the reason", jr(cur.validationJson)?.state === "passed" && jr(cur.validationJson)?.aimTrimmed === true && jr(vs[1].validationJson)?.state === "flagged" && /dropped a must-keep point; v1 is kept/.test(jr(vs[1].validationJson)?.error ?? ""));
      const card = record.writerCardOf(cur.validationJson);
      c.ok("the card says why the longer version stands, and the length line keeps its advice", /Kept v1 \(96 words, about 44 seconds\): the trim toward 75 to 80 words dropped a must-keep point/.test(card?.lengthNote ?? "") && rules.lengthLabel(96)?.band === "long" && /Longer than the 55 to 85 aim/.test(rules.lengthLabel(96)?.text ?? ""), card?.lengthNote ?? "none");
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
      c.ok("pressed again, the trim keeps its substance: 72 words, passed, current", reqs.slice(p1).map((r) => r.step).join(",") === "trim,review" && cur2.spokenWordCount === 72 && (await import("@/lib/scriptJudgeRecord")).readJudge(cur2.validationJson)?.state === "passed");
    }

    // =======================================================================
    c.head("8g · draftOffline (the retro test) takes the same steps, writes no script");
    {
      ctl.sizes.set("H", [[26, 24, 20, 13], [18, 18, 16, 10]]);
      ctl.reviews.set("H", [[], []]);
      const off = await pipe.draftOffline({ topicId: tH, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: 98 → one trim toward 75 to 80 → 77 words, passed", off.state === "passed" && off.attempts.map((a) => `${a.label}:${a.words}`).join(",") === "draft:98,trim to aim:77" && off.final.words === 77 && !off.keptLonger, off.attempts.map((a) => `${a.label}:${a.words}`).join(","));
      ctl.sizes.set("I", [[24, 24, 20, 13], [14, 14, 14, 13]]);
      ctl.reviews.set("I", [[], ["substance"]]);
      const offI = await pipe.draftOffline({ topicId: tI, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: a trim that loses substance → the 96-word draft is the result, with the note", offI.state === "passed" && offI.keptLonger && offI.final.words === 96 && offI.final.label === "draft" && /Kept draft \(96 words/.test(offI.final.note ?? ""), `${offI.final.label}:${offI.final.words}`);
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
      c.ok("close: a warm invitation by default, a callback alone only for a story with no service angle", rules.CLOSE_RULE.includes("by default, ends on a natural, warm invitation") && rules.CLOSE_RULE.includes("only when the video is purely a story with no service angle") && prompts.REVIEW_SYSTEM.includes("by default a warm, natural invitation tied to the message"));
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
      c.ok("writer: a warm invitation by default, a callback where the story has no service angle; the old caption-only rule gone", sys.includes("by default, ends on a natural, warm invitation") && sys.includes("\"callback\": only when the video is purely a story") && !/contact ask goes in the caption|memorable final line/i.test(sys));
      c.ok("writer: about 75 words inside 55 to 85, cap 110, never dry or incomplete", sys.includes("write about 75 spoken words") && sys.includes("inside the 55 to 85 range") && sys.includes("110 spoken words is the hard cap") && sys.includes("Never make it dry or incomplete"));
      c.ok("review: 86 to 110 is advice only; over 110 is must-fix", prompts.REVIEW_SYSTEM.includes("86 to 110 is advice only") && prompts.REVIEW_SYSTEM.includes("Over 110 words is must-fix"));
      c.ok("brief: closeType cta or callback, decided per message", prompts.BRIEF_SYSTEM.includes("closeType") && (prompts.BRIEF_SCHEMA as { properties: { closeType: { enum: string[] } } }).properties.closeType.enum.join() === "cta,callback");
      const l = rules.lengthCheck(96), a = rules.lengthCheck(80), s = rules.lengthCheck(40);
      c.ok("96 words: \"Longer than the 55 to 85 aim\", a flag, never must-fix", !l.pass && l.level === "flag" && /Longer than the 55 to 85 aim/.test(l.reason));
      c.ok("80 words passes; 40 words passes the length check (substance guards dry or incomplete)", a.pass && s.pass);
      const h = rules.hardNumbers({ hook: "Sellers, mortgage rates are up 7% and that changes everything", points: [{ role: "re-hook", text: "Know your buyer avatar — it matters (10 seconds)." }], close: "Let's talk." }, "she talked about her inspection process");
      const keys = h.findings.map((x) => x.key).sort().join(",");
      c.ok("hard numbers by code: audience opener, dash, duration note, a figure and a market claim she never made, jargon", keys === "audience_vocative,dash,duration,jargon,market_claim,market_claim", keys);
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
      c.ok("a person's explicit new draft: only the draft call ran (the earlier steps reused); no review, fix or trim on a shared script", after.join(",") === "draft", after.join(","));
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
      c.ok("revised by the writer (opus 5.5, high), the instruction whole in the prompt", rv.length === 1 && rv[0].step === "revise" && rv[0].prompt.includes("END-OF-INSTRUCTION") && rv[0].body.model === "claude-opus-5-5");
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
      c.ok("an educational brief keeps at most four must-keep points; the rest move to optional, marked", edu.mustKeep.length === 4 && edu.mustKeep.map((m) => m.text).join() === "the belief,reason one,reason two,her process" && edu.optional.slice(0, 2).every((o) => /moved from must-keep/.test(o.text)), JSON.stringify(edu.mustKeep.map((m) => m.text)));
      c.ok("…a deal still in progress is never must-keep: it is excluded, with the reason", !edu.mustKeep.some((m) => /20,000/.test(m.text)) && edu.excluded.some((x) => /20,000/.test(x.text) && /still in progress/.test(x.reason)));
      c.ok("…the angle, the one proof and what we asked are kept, and the brief text shows them", edu.angle === "Your neighbor's sale is not your price." && edu.proof?.text === "buyers have options" && /What we asked her[^\n]*What do sellers need to know/.test(prompts.briefText(edu)) && /Angle \(the one thing\)/.test(prompts.briefText(edu)));
      const story = pipe.briefFrom({ videoType: "story", mustKeep: [...six, { text: "seventh beat", source: "P9" }] }, []);
      const old = pipe.briefFrom({ mustKeep: six }, []);
      c.ok("a story keeps its beats up to six; a brief with no video type is read as educational (four)", story.mustKeep.length === 6 && story.videoType === "story" && old.mustKeep.length === 4 && old.videoType === "educational");
      c.ok("the brief prompt asks for one angle, one proof, the interviewer's question, the cap and no live deal", ["angle: ONE sentence", "proof: the ONE proof", "whatWeAsked:", "at most 4", "NEVER A LIVE DEAL", "when her story serves two groups, the viewer is both"].every((x) => prompts.BRIEF_SYSTEM.includes(x)));

      // --- 5. the hook for the story's job, and the runner-up on a failed re-hook (pure)
      const sc = (n: number) => ({ relevance: n, curiosity: n, specificity: n, naturalDelivery: n, accuracy: 5, herVoice: n, payoffConnection: n });
      const raw = [
        { text: "Buying my first home shouldn't feel this scary, right?", rehook: "It should.", lever: "viewer question", fit: "viewer_line", scores: sc(5) },
        { text: "Every senior I helped move felt like my responsibility. Then I walked away.", rehook: "Here is why.", lever: "her moment", fit: "her_moment", scores: sc(4) },
        { text: "I came into real estate sure I'd only work with seniors. I was wrong.", rehook: "First-time buyers called.", lever: "her moment", fit: "her_moment", scores: sc(3) },
      ];
      const asStory = rules.pickHook(raw, { videoType: "story" });
      const asEdu = rules.pickHook(raw, { videoType: "educational" });
      c.ok("a personal story opens on HER moment, even when a viewer's line scores higher; an educational video keeps the score order", asStory.chosen === 1 && asEdu.chosen === 0, `${asStory.chosen} / ${asEdu.chosen}`);
      c.ok("the runner-up: the next usable hook not yet tried, in the same order", rules.runnerUpHook(asStory.hooks, [raw[1].text], "story")?.text === raw[2].text && rules.runnerUpHook(asStory.hooks, raw.map((r) => r.text), "story") === null);
      const instr = pipe.writerFixInstruction({ checks: rules.mergeReview([{ key: "rehook", pass: false, reason: "It should. tells a nervous buyer the fear is warranted" }], [], 70) });
      c.ok("a failed re-hook is read from the fix instruction; a failed close is not", rules.hookFailed({ instruction: instr }) && !rules.hookFailed({ instruction: pipe.writerFixInstruction({ checks: rules.mergeReview(rules.REVIEW_CHECK_KEYS.map((key) => ({ key, pass: key !== "close", reason: "x" })), [], 70) }) }));
      c.ok("the hooks prompt: a story opens on her moment; the viewer's line is for an educational video; each hook says its fit", prompts.HOOKS_SYSTEM.includes("A PERSONAL STORY opens on HER moment") && prompts.HOOKS_SYSTEM.includes("An EDUCATIONAL video voices the viewer's own belief") && JSON.stringify(prompts.HOOKS_SCHEMA).includes("her_moment"));

      // --- 6. the runner-up hook in the automatic check: a re-hook that keeps failing
      ctl.reviews.set("G", [["rehook"], ["rehook"], ["rehook"]]);
      const g0 = reqs.length;
      const rG = await gen.generateScriptForTopic({ topicId: tG, monthId: f.monthId, requestedBy: STAFF, unattended: false, callRecordId: call.id });
      const fixesG = reqs.slice(g0).filter((r) => r.step === "fix");
      c.ok("fix round 1 starts again from the runner-up hook (a redraft, not a patch around the locked one)", fixesG.length === 2 && fixesG[0].prompt.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_RUNNER_UP}`) && /REDRAFT RULES/.test(fixesG[0].prompt) && /THE PREVIOUS VERSION \(v1\), which failed the review/.test(fixesG[0].prompt), String(fixesG.length));
      c.ok("…fix round 2, the re-hook failing again, takes the third hook (never one already tried)", fixesG[1]?.prompt.includes(`THE CHOSEN HOOK (use it word for word): ${HOOK_THIRD}`));
      const vsG = await prisma.contentScriptVersion.findMany({ where: { scriptId: rG.scriptId }, orderBy: { versionNo: "asc" }, select: { hook: true } });
      c.ok("…and the versions carry those hooks", vsG.map((v) => v.hook).join(" | ") === [HOOK_WIN, HOOK_RUNNER_UP, HOOK_THIRD].join(" | ") || vsG.length >= 3 && vsG[1].hook === HOOK_RUNNER_UP && vsG[2].hook === HOOK_THIRD, vsG.map((v) => v.hook).join(" | "));
      // ... and in the offline run
      ctl.reviews.set("J", [["rehook"], []]);
      const offJ = await pipe.draftOffline({ topicId: tJ, monthId: f.monthId, requestedBy: STAFF });
      c.ok("offline: a failed re-hook → \"fix 1 (runner-up hook)\" with the runner-up word for word, then passed", offJ.state === "passed" && offJ.attempts[1]?.label === "fix 1 (runner-up hook)" && offJ.attempts[1].parts.hook === HOOK_RUNNER_UP, offJ.attempts.map((a) => `${a.label}:${a.parts.hook.slice(0, 20)}`).join(","));

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

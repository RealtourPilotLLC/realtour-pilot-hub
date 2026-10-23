// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 23 2026, THE SCRIPT CARD SHOWS THE SCRIPT; THE AUTO-FIX NEVER
// MAKES A WORSE VERSION CURRENT.
//
// Jordan, with a screenshot of Bernadette's "My Actual Saturday in the Lehigh
// Valley" (v12, "needs your OK"): "For the scripting for the monthly content,
// I don't need to see that it needs fixes; I just need it to be fixed. This
// is way too much. I just want to come in and either make a quick edit or
// just approve and send."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-script-card-best-version.ts --logs <dir>
//
//   1. the card: the title, the format chip, "needs your OK", the pillar chip,
//      the parts and caption CTA, the filming notes, Copy and Download; two
//      actions up front (Approve and send, Edit); a More menu with everything
//      else; nothing red and nothing about checks, gaps, craft, fix rounds or
//      word counts; one closed grey "Writer's notes" fold at the very bottom
//   2. Approve and send: one press approves and shares through the same
//      ledger; a house-format refusal and a format check are refused in words;
//      the creative manager's permissions are what they were
//   3. the loop: a fix round is a candidate, current only when better (fewer
//      must-fix failures, then craft, then length); a worse round stays in
//      the history; still failing, the best stays current with nothing copied;
//      a person's approve in between wins; the cron sweep settles a candidate
//   4. the dry run's rule (scriptJudgeRecord.betterEarlierVersion) and the
//      live script's guards
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; every outbound call
// is fenced; the model is stubbed at aiJsonWithUsage; nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7151);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
// The panel's queue watch asks for the router; the card is only drawn here.
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {} });
const fence = fenceFetch(async () => null);
// after(): captured and never run (a month recalc is not what these checks are about).
const pendingAfter: (() => Promise<unknown> | unknown)[] = [];
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: (fn: () => Promise<unknown> | unknown) => { pendingAfter.push(fn); } }));

// ---- the model boundary: the old judge and the old writer's revise ---------
type JudgeMode = "pass" | "fail" | "fail2" | "fail3";
const judgeQueue: JudgeMode[] = [];
const calls: { kind: string; prompt: string }[] = [];
let reviseNo = 0;
const usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ANGLE = { viewer: "A buyer new to the Lehigh Valley", belief: "Weekends are for errands", stake: "A house that never feels like home", angle: "Pick your Saturday before your street", clientTake: "She walks clients through her own Saturday", payoff: "Your Saturday tells you where to live" };
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        const s = opts.system;
        const kind = /You are the quality judge/.test(s) ? "judge" : /creative identity for ONE real estate agent/.test(s) ? "identity" : /writing ONE personal-branding video script/.test(s) ? (/REVIEWER'S INSTRUCTION/.test(opts.prompt) ? "revise" : "script") : "other";
        calls.push({ kind, prompt: opts.prompt });
        if (kind === "judge") {
          const mode = judgeQueue.shift() ?? "pass";
          const keys = ["hook", "rehook", "buildup", "payoff", "close", "voice", "truth", "skit"];
          const failing = mode === "fail" ? ["rehook"] : mode === "fail2" ? ["rehook", "payoff"] : mode === "fail3" ? ["rehook", "payoff", "voice"] : [];
          return { result: { criteria: keys.map((key) => ({ key, pass: !failing.includes(key), note: failing.includes(key) ? `JUDGE NOTE ${key}` : "ok" })), fixInstruction: failing.length ? "Make the re-hook add a consequence." : null }, usage, model: "drill-stub" };
        }
        if (kind === "identity") return { result: { humorStyle: "dry", comedyComfort: "light", onCameraEnergy: "calm", toneWords: ["warm"], boundaries: [], interests: [], formatsLiked: [], formatsAvoided: [], filmingConstraints: [] }, usage, model: "drill-stub" };
        if (kind === "revise" || kind === "script") {
          const n = kind === "revise" ? ++reviseNo : 0;
          const hook = kind === "revise" ? `Round ${n} hook: where do you get coffee around here?` : "Pick the town first and figure out brunch later.";
          return { result: {
            angle: ANGLE, title: "Saturday drill", category: "Local Life",
            hook, points: [{ role: "re-hook", text: `Round ${n}: the Saturday shows you the town.` }, { role: "build-up", text: "Coffee, the trail, the farmers market." }, { role: "payoff", text: "Live where your Saturday already is." }], close: "Tell me your perfect Saturday.",
            captionCta: "DM me SATURDAY for my list.", filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
          }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call: ${s.slice(0, 80)}`);
      };
    },
  }),
);

const RED = /\b(?:text|bg|border)-(?:danger|warning)\b/;
const MACHINERY = /Creative review|must[- ]fix|still failing|auto-fixed|needs? (?:a )?fix|flagged|Craft:|Gap \(|Topic brief|7 of 13|A bit long|Still flagged/i;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-script-card", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  const A = await import("@/app/content/actions");
  const scripts = await import("@/lib/contentScripts");
  const gen = await import("@/lib/contentGeneration");
  const judge = await import("@/lib/scriptJudge");
  const rec = await import("@/lib/scriptJudgeRecord");
  const rules = await import("@/lib/scriptWriter/rules");
  const { createPillar } = await import("@/lib/contentPillars");
  const { loadScriptsTab } = await import("@/app/content/[id]/programData");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { ScriptsPanel } = await import("@/components/content/ScriptsPanel");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
  const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];

  try {
    const jordan = await prisma.appUser.create({ data: { email: "jordan@oct23-card.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const james = await prisma.appUser.create({ data: { email: "james@oct23-card.test", name: "James", role: "CREATIVE_MANAGER", status: "ACTIVE" } });
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await as(jordan);
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    const staff = { email: jordan.email, appUserId: jordan.id };

    const F = await buildContentMonth(prisma, { name: "Bernadette Card TEST", package: "Accelerator", topics: [
      { title: "My Actual Saturday", selection: "SELECTED", excerpts: ["Saturday I get coffee in Emmaus, then the trail."] },
      { title: "Worse round stays in history", selection: "SELECTED", excerpts: ["Buyers ask me where I actually go."] },
      { title: "Rounds run out", selection: "SELECTED", excerpts: ["The farmers market is my Saturday."] },
      { title: "Candidate waits", selection: "SELECTED", excerpts: ["I pick the town before the street."] },
      { title: "Person approves meanwhile", selection: "SELECTED", excerpts: ["Coffee first, always."] },
      { title: "The sweep settles it", selection: "SELECTED", excerpts: ["The trail on Saturday mornings."] },
      { title: "Clean one to send", selection: "SELECTED" },
      { title: "Four points", selection: "SELECTED" },
      { title: "No pillar yet", selection: "SELECTED" },
      { title: "Approved earlier", selection: "SELECTED" },
    ] });
    const pillarId = await createPillar({ enrollmentId: F.enrollmentId, clientId: F.clientId, name: "Local Life", createdBy: jordan.email });
    const T = (i: number) => F.topicIds[i];
    /** An AI draft owed the automatic check (the old judge), as a draft lands. */
    const draft = async (i: number, title: string, hook: string) => scripts.createScriptVersion({
      enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(i), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email,
      parts: { title, hook, points: pts("The Saturday shows you the town.", "Coffee, the trail, the farmers market.", "Live where your Saturday already is."), close: "Tell me your perfect Saturday.", captionCta: "DM me SATURDAY.", pillarId, categoryLabel: "Local Life" },
      validation: { ok: true, findings: [], angle: ANGLE, judge: rec.pendingJudge(0) },
    });
    const head = (id: string) => prisma.contentScript.findUniqueOrThrow({ where: { id } });
    const versionsOf = (id: string) => prisma.contentScriptVersion.findMany({ where: { scriptId: id }, orderBy: { versionNo: "asc" } });
    const jOf = (v: { validationJson: string | null } | undefined | null) => rec.readJudge(v?.validationJson);

    // =======================================================================
    c.head("3 · the loop: a fix round becomes current only when it is better");
    // a) fail (1) → round 1 fail3 (worse: set aside) → round 2 from v1 passes (better: current).
    const a = await draft(1, "Worse round stays in history", "Every relocating client asks me where I actually go.");
    judgeQueue.push("fail", "fail3", "pass");
    const ra = await judge.autoCheckScript(a.scriptId, { requestedBy: jordan.email, unattended: false });
    const vA = await versionsOf(a.scriptId);
    const hA = await head(a.scriptId);
    c.ok("three versions: the draft, a worse round, a better round", vA.length === 3, String(vA.length));
    c.ok("the worse round (3 failing) never became current: set aside, v1 kept instead", jOf(vA[1])?.state === "set_aside" && jOf(vA[1])?.keptInstead === 1 && jOf(vA[1])?.candidateOf === vA[0].id, JSON.stringify(jOf(vA[1])));
    c.ok("…the next round started again from v1 (the better version), not from the worse one", vA[2].basedOnVersionId === vA[0].id && vA[1].basedOnVersionId === vA[0].id);
    c.ok("the better round (passes) is current, passed, with both rounds counted", hA.currentVersionId === vA[2].id && ra.state === "passed" && jOf(vA[2])?.state === "passed" && jOf(vA[2])?.fixRounds === 2, `${ra.state} · current v${vA.find((v) => v.id === hA.currentVersionId)?.versionNo}`);
    c.ok("every round stays in the history, none approved or shared by the loop", vA.every((v) => v.status === "INTERNAL_REVIEW" && !v.sharedAt) && !hA.approvedVersionId && !hA.sharedVersionId);

    // b) fail (1) → fail2 → fail3: the rounds run out; v1 is the best and stays current, flagged quietly, nothing copied.
    const b = await draft(2, "Rounds run out", "Saturday tells you where to live.");
    judgeQueue.push("fail", "fail2", "fail3");
    const rb = await judge.autoCheckScript(b.scriptId, { requestedBy: jordan.email, unattended: false });
    const vB = await versionsOf(b.scriptId);
    const hB = await head(b.scriptId);
    c.ok("still failing after two rounds: the best (v1) stays current, nothing copied forward", vB.length === 3 && hB.currentVersionId === vB[0].id && rb.state === "flagged" && rb.versionId === vB[0].id, `${vB.length} versions · current v${vB.find((v) => v.id === hB.currentVersionId)?.versionNo}`);
    c.ok("…v1 carries the two rounds spent; both rounds are set aside in the history", jOf(vB[0])?.state === "flagged" && jOf(vB[0])?.fixRounds === 2 && vB.slice(1).every((v) => jOf(v)?.state === "set_aside"));
    c.ok("…the legacy body mirrors the current version (v1's words)", hB.body === vB[0].body);

    // c) the candidate waits in the history: reviseScript(candidate) never moves the current version.
    const cc = await draft(3, "Candidate waits", "I pick the town before the street.");
    await prisma.contentScriptVersion.update({ where: { id: cc.versionId }, data: { validationJson: JSON.stringify({ ok: true, findings: [], angle: ANGLE, judge: { ...rec.pendingJudge(0), state: "fixing", criteria: [{ key: "rehook", pass: false, note: "n" }, { key: "hook", pass: true, note: "ok" }], issues: ["rehook: n"] } }) } });
    const cand = await gen.reviseScript(cc.scriptId, "Fix the re-hook.", jordan.email, "REVISION", { autoFix: { round: 1, candidate: true } });
    const hC = await head(cc.scriptId);
    const candRow = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: cand.versionId } });
    c.ok("a candidate round is written into the history while v1 stays current", hC.currentVersionId === cc.versionId && cand.versionNo === 2 && jOf(candRow)?.state === "pending" && jOf(candRow)?.candidateOf === cc.versionId);
    judgeQueue.push("fail3");
    await judge.autoCheckScript(cc.scriptId, { requestedBy: jordan.email, unattended: false, deadline: Date.now() + 40_000 });
    c.ok("…judged worse, it is set aside and v1 is still current", (await head(cc.scriptId)).currentVersionId === cc.versionId && jOf(await prisma.contentScriptVersion.findUnique({ where: { id: cand.versionId } }))?.state === "set_aside");

    // d) a person's approve while a candidate waits: the person wins; the candidate never becomes current.
    const d = await draft(4, "Person approves meanwhile", "Coffee first, always.");
    await prisma.contentScriptVersion.update({ where: { id: d.versionId }, data: { validationJson: JSON.stringify({ ok: true, findings: [], angle: ANGLE, judge: { ...rec.pendingJudge(0), state: "fixing", criteria: [{ key: "rehook", pass: false, note: "n" }], issues: ["rehook: n"] } }) } });
    const dCand = await gen.reviseScript(d.scriptId, "Fix the re-hook.", jordan.email, "REVISION", { autoFix: { round: 1, candidate: true } });
    await scripts.approveScriptVersion(d.versionId, staff);
    const judgedBefore = calls.filter((x) => x.kind === "judge").length;
    const rd = await judge.autoCheckScript(d.scriptId, { requestedBy: jordan.email, unattended: false });
    c.ok("…and nothing was judged or revised for it after the approve", calls.filter((x) => x.kind === "judge").length === judgedBefore);
    const hD = await head(d.scriptId);
    c.ok("Jordan approved v1 while a round waited: v1 stays current and approved; the round is never current", hD.currentVersionId === d.versionId && hD.approvedVersionId === d.versionId && rd.reason === "already reviewed" && hD.currentVersionId !== dCand.versionId, `${rd.reason}`);
    c.ok("makeVersionCurrent is compare-and-set: refused once the current version moved or was approved", !(await scripts.makeVersionCurrent(d.scriptId, dCand.versionId, { expectCurrentId: d.versionId })));

    // e) the cron sweep settles a waiting candidate (a draft's own run ran out of time).
    // (c) still owes a round; it is put to rest first so the sweep's one pick is this script.
    await prisma.contentScriptVersion.update({ where: { id: cc.versionId }, data: { validationJson: JSON.stringify({ ok: true, findings: [], angle: ANGLE, judge: { ...jOf(await prisma.contentScriptVersion.findUnique({ where: { id: cc.versionId } })), state: "flagged" } }) } });
    const e = await draft(5, "The sweep settles it", "The trail on Saturday mornings.");
    await prisma.contentScriptVersion.update({ where: { id: e.versionId }, data: { validationJson: JSON.stringify({ ok: true, findings: [], angle: ANGLE, judge: { ...rec.pendingJudge(0), state: "fixing", criteria: [{ key: "rehook", pass: false, note: "n" }, { key: "payoff", pass: false, note: "n" }], issues: ["rehook: n", "payoff: n"] } }) } });
    const eCand = await gen.reviseScript(e.scriptId, "Fix the re-hook.", jordan.email, "REVISION", { autoFix: { round: 1, candidate: true } });
    judgeQueue.push("fail");
    const sweep = await judge.sweepScriptChecks({ max: 1, budgetMs: 60_000, minStartMs: 0 });
    const vE = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: eCand.versionId } });
    c.ok("the sweep picks the current version (fixing), reviews its waiting round, and makes it current when better (1 failing < 2)", sweep.checked >= 1 && (await head(e.scriptId)).currentVersionId === eCand.versionId && jOf(vE)?.state === "fixing" && jOf(vE)?.fixRounds === 1, JSON.stringify(sweep));

    // f) the rule itself (pure): must-fix first, then craft (hook twice), then the length rule; a tie keeps the current one.
    const craft = (h: number, r = 3, b = 3, p = 3, cl = 3) => ({ hook: { score: h, note: "" }, rehook: { score: r, note: "" }, buildup: { score: b, note: "" }, payoff: { score: p, note: "" }, close: { score: cl, note: "" } });
    c.ok("fewer must-fix failures wins, whatever the craft", rules.isBetterAttempt({ mustFix: 1, craft: craft(1, 1, 1, 1, 1), words: 70 }, { mustFix: 2, craft: craft(5, 5, 5, 5, 5), words: 70 }));
    c.ok("…then the craft total, the hook counted twice (a weaker hook loses)", rules.isBetterAttempt({ mustFix: 2, craft: craft(4), words: 70 }, { mustFix: 2, craft: craft(2, 4), words: 70 }) && !rules.isBetterAttempt({ mustFix: 2, craft: craft(2, 4), words: 70 }, { mustFix: 2, craft: craft(4), words: 70 }));
    c.ok("…then the length rule (inside 85 beats over it; over 110 is worst; a told story is not ranked on the aim)", rules.isBetterAttempt({ mustFix: 1, craft: craft(3), words: 80 }, { mustFix: 1, craft: craft(3), words: 90 }) && rules.isBetterAttempt({ mustFix: 1, craft: craft(3), words: 100 }, { mustFix: 1, craft: craft(3), words: 112 }) && !rules.isBetterAttempt({ mustFix: 1, craft: craft(3), words: 80, story: true }, { mustFix: 1, craft: craft(3), words: 100, story: true }));
    c.ok("…a tie is not better: the current version stays", !rules.isBetterAttempt({ mustFix: 1, craft: craft(3), words: 70 }, { mustFix: 1, craft: craft(3), words: 70 }) && rules.bestAttempt([{ mustFix: 1, words: 70 }, { mustFix: 1, words: 70 }]) === 0);
    c.ok("Bernadette's Saturday rounds (v10 8 must-fix → v11 6 → v12 4) each beat the one before by this rule", rules.isBetterAttempt({ mustFix: 6, craft: craft(2, 2, 3, 2, 2), words: 77 }, { mustFix: 8, craft: craft(2, 2, 3, 2, 3), words: 75 }) && rules.isBetterAttempt({ mustFix: 4, craft: craft(2, 2, 3, 2, 3), words: 72 }, { mustFix: 6, craft: craft(2, 2, 3, 2, 2), words: 77 }));
    const loopSrc = read("src/lib/scriptJudge.ts");
    // Oct 23 2026 (writer v2.6): the new writer's automatic round is its ONE whole rewrite (no fix rounds, no cap trim); it is a candidate too.
    c.ok("the new writer's one whole rewrite is a candidate too, settled by the same rule", /autoFix: \{ round: j\.fixRounds \+ 1, rewrite: true, candidate: true \}/.test(loopSrc) && /candidateWins\(cand, parent/.test(loopSrc) && /makeVersionCurrent\(scriptId, cand\.v\.id, \{ expectCurrentId: v\.id \}\)/.test(loopSrc));

    // =======================================================================
    c.head("1 · the card shows the script, not the machinery");
    // Bernadette's Saturday as Jordan saw it: the new writer's review flagged, 7 of 13, two gaps, craft, rationale, brief, over the cap.
    const LONG = "Okay, but where do you actually get your coffee around here, and where do you go when the week is finally over and the house is quiet";
    const sat = await scripts.createScriptVersion({
      enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(0), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email,
      parts: { title: "My Actual Saturday in the Lehigh Valley", hook: LONG, points: pts(`${LONG}, that is the question every relocating client asks me first.`, `I start in Emmaus with coffee, then the trail, then the farmers market, and every stop tells you something about the town you are choosing.`, `So before you pick a street, pick a Saturday, because the right Saturday is the right town.`), close: "Tell me your perfect Saturday and I will show you the town that already has it.", captionCta: "DM me SATURDAY for my list.", pillarId, categoryLabel: "Local Life", filmingNotes: "Film at the Emmaus coffee shop, then the trail head." },
      validation: { ok: true, findings: [{ severity: "warn", code: "hook.long", message: "The hook is long" } as never], angle: null, judge: null },
      gaps: [{ kind: "missing-source", text: "Which coffee shop she goes to", question: "Where do you get coffee?" }, { kind: "missing-source", text: "The trail's name", question: null }] as never,
    });
    const checks = [
      { key: "hook", n: 1, label: "Hook", level: "must-fix", pass: false, reason: "The hook is weak." },
      { key: "rehook", n: 2, label: "Re-hook", level: "must-fix", pass: false, reason: "It restates the hook." },
      { key: "close", n: 8, label: "Close", level: "flag", pass: false, reason: "Generic." },
      { key: "story", n: 4, label: "Story", level: "must-fix", pass: true, reason: "ok" },
    ];
    const writerRec = { v: 2, version: rules.WRITER_VERSION, brief: { videoType: "educational", centralMessage: "Pick your Saturday before your street.", viewer: "A buyer moving to the Lehigh Valley", whyChosen: "Her clients ask it first.", pillar: "Local Life", whatSheSaid: [{ passageId: "P1", quote: "Saturday I get coffee in Emmaus", source: "Oct call", time: "12:01" }], mustKeep: [{ text: "Coffee, trail, market", source: "P1" }], herPhrases: [], optional: [], excluded: [], contradictions: [], verifiedFacts: [], opinions: [], creativeIdeas: [], ourAssumptions: [], closeType: "cta", closeWhy: "An invitation.", target: { aim: [55, 85], cap: 110, seconds: [25, 39], words: 68 } }, passages: [], excludedPassages: [], hooks: [{ text: "You found the house. Now you need a Saturday.", rehook: "r", lever: "l", scores: {}, total: 30, note: "", disqualified: null }], chosen: 0, rationale: { hook: "A question every mover asks.", takeaway: "Pick the town by its Saturday.", strategy: "Local Life pillar, warm and specific." }, facts: [], sources: { calls: [], olderWindows: 0, relatedScripts: [], voiceRefs: [], answers: 0 }, runs: { retrieval: null, brief: null, hooks: null, draft: null }, asOf: null };
    const satJudge = { ...rec.pendingJudge(2, { writer: true }), state: "flagged", checks, craft: craft(2, 2, 3, 2, 3), words: 120, criteria: checks.map((x) => ({ key: x.key, pass: x.pass, note: x.reason })), issues: ["1. Hook: weak"], error: null };
    const satRow = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sat.versionId } });
    await prisma.contentScriptVersion.update({ where: { id: sat.versionId }, data: { validationJson: JSON.stringify({ ...JSON.parse(satRow.validationJson ?? "{}"), writer: writerRec, judge: satJudge }), changeSummary: "Auto-fixed after the creative review (round 2): MUST FIX: 1. Hook" } });
    // An approved, released script and one approved with a newer draft, for the More menu's other items.
    const rel = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(9), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email, parts: { title: "Approved earlier", hook: "The first weekend decides it.", points: pts("Buyers decide in two days.", "Price it right and they compete.", "That is how you win the weekend."), close: "Call me before you list.", pillarId, categoryLabel: "Local Life" } });
    await scripts.approveScriptVersion(rel.versionId, staff);
    await scripts.releaseScriptVersion(rel.scriptId, staff);

    const sd = await loadScriptsTab(F.enrollmentId, { id: F.monthId });
    const html = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: F.enrollmentId, scripts: sd.scripts, queueCount: sd.queueCount, scriptOwner: sd.scriptOwner, owed: [], revising: sd.revising, drafting: sd.drafting, queueActive: sd.queueActive })));
    const cardOf = (id: string) => { const i = html.indexOf(`data-script-card="${id}"`); const j = html.indexOf("data-script-card=", i + 20); return i < 0 ? "" : html.slice(i, j < 0 ? html.length : j); };
    const card = cardOf(sat.scriptId);
    const notesAt = card.indexOf("data-writer-notes");
    const top = notesAt < 0 ? card : card.slice(0, notesAt);
    const notes = notesAt < 0 ? "" : card.slice(notesAt);
    c.ok("the title, the format chip (Talking to camera) and \"needs your OK\"", /My Actual Saturday in the Lehigh Valley/.test(top) && />Talking to camera</.test(top) && />needs your OK</.test(top));
    c.ok("the pillar chip, Copy and Download", />Local Life</.test(top) && /Copy</.test(top) && /Download</.test(top));
    c.ok("the script parts and the caption CTA", ["Hook", "Talking Point 1", "Talking Point 2", "Talking Point 3", "Close", "Caption CTA"].every((l) => text(top).includes(l)) && text(top).includes("DM me SATURDAY for my list."), text(top).slice(0, 300));
    c.ok("the filming notes, in small type", /text-\[11px\][^>]*><span class="font-semibold">Filming notes:<\/span> Film at the Emmaus coffee shop/.test(top));
    const actions = top.slice(top.indexOf("data-card-actions"));
    const buttons = [...actions.slice(0, actions.indexOf("data-more-menu")).matchAll(/<button[^>]*>((?:(?!<\/button>).)*)<\/button>/g)].map((m) => text(m[1]).trim());
    c.ok("two actions up front, in order: Approve and send, Edit", buttons.length === 2 && buttons[0] === "Approve and send" && buttons[1] === "Edit", JSON.stringify(buttons));
    const more = actions.slice(actions.indexOf("data-more-menu"), actions.indexOf("</details>", actions.indexOf("data-more-menu")));
    c.ok("a More menu holds the rest: Approve only, Ask AI to revise, Shorten with AI (it is over 110 words)", /<summary[^>]*>More/.test(more) && ["Approve only", "Ask AI to revise", "Shorten with AI"].every((x) => text(more).includes(x)), text(more));
    c.ok("nothing red on the card (no danger or warning colours)", !RED.test(card), (card.match(RED) ?? [""])[0]);
    c.ok("no review, gap, craft, fix-round or warning text anywhere on the card", !MACHINERY.test(text(card)), (text(card).match(MACHINERY) ?? [""])[0]);
    c.ok("…and no word count, rationale or brief above the fold", !/spoken words|words, about|Takeaway:|Her strategy:|The message:/.test(text(top)));
    const afterNotes = notes.slice(notes.indexOf("</details>") + "</details>".length);
    c.ok("one \"Writer's notes\" fold, closed, grey, at the very bottom", (card.match(/data-writer-notes/g) ?? []).length === 1 && /^data-writer-notes="true" class="[^"]*text-muted[^"]*">/.test(notes) && !/^data-writer-notes[^>]* open/.test(notes) && afterNotes.startsWith("</div></details>"), afterNotes.slice(0, 60));
    c.ok("…holding the neutral notes: the version, the length, the rationale, the brief, what her sources lack", /Writer.s notes/.test(text(notes)) && /polished by the AI after its own review/.test(text(notes)) && /spoken words, about/.test(text(notes)) && /Takeaway:/.test(text(notes)) && /The message:/.test(text(notes)) && /Which coffee shop she goes to/.test(text(notes)));
    const cardB = cardOf(b.scriptId);
    c.ok("a script whose rounds were set aside shows its CURRENT version (v1), never the newer rounds", cardB.includes("Saturday tells you where to live.") && !/Round \d hook/.test(cardB.slice(0, cardB.indexOf("data-version-history") > 0 ? cardB.indexOf("data-version-history") : cardB.indexOf("data-writer-notes"))));
    const moreB = cardB.slice(cardB.indexOf("data-more-menu"), cardB.indexOf("</details>", cardB.indexOf("data-more-menu")));
    c.ok("…its More menu holds the version history (3 versions: the rounds are kept, View and Restore under it)", /Show version history \(3\)/.test(text(moreB)) && /restoreScriptVersionAction\(s\.id, v\.id, cur\?\.id \?\? null\)/.test(read("src/components/content/ScriptsPanel.tsx")), text(moreB));
    c.ok("…and the queue counts it by its current version", sd.queueCount === sd.scripts.filter((s) => !s.historical && ["DRAFT", "INTERNAL_REVIEW"].includes((s.versions.find((v) => v.id === s.currentVersionId) ?? s.versions[0]).status)).length);
    const relCard = cardOf(rel.scriptId);
    c.ok("a released script: no Approve and send; Edit up front; More holds Pull back and the history", !/Approve and send/.test(text(relCard.slice(0, relCard.indexOf("data-more-menu")))) && />released to the portal</.test(relCard) && /Pull back from the client.s portal/.test(text(relCard)) && !RED.test(relCard));
    const panelSrc = read("src/components/content/ScriptsPanel.tsx");
    c.ok("Edit is the existing edit path: the current version loads on click and saves as a new version (saveScriptText)", /const startEdit = \(\) => \{ setBody\(cur\?\.body \?\? ""\); setNotes\(cur\?\.filmingNotes \?\? ""\); setBaseId\(cur\?\.id \?\? null\)/.test(panelSrc) && /saveScriptText\(s\.id, body, \{ baseVersionId: baseId, filmingNotes: notes \}\)/.test(panelSrc));
    c.ok("Approve and send is the existing one-press path (approveAndSendScriptAction on the current version)", /approveAndSendScriptAction\(cur\.id\)/.test(panelSrc) && /const cur = currentOf\(s\)/.test(panelSrc));
    c.ok("the card has no role branches: the creative manager sees the same card", !/\b(?:user|me|viewer)\.role\b|isOwner|creativeManager|CREATIVE_MANAGER/.test(panelSrc.slice(panelSrc.indexOf("function ScriptItem"), panelSrc.indexOf("WHAT THIS MONTH STILL OWES"))));
    const portalSrc = ["src/app/portal", "src/components/portal"].flatMap((d) => fs.readdirSync(path.join(REPO, d), { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => read(path.join(d, f)))).join("\n");
    c.ok("the portal is unchanged: it never draws the office card or the writer's notes", !/ScriptsPanel|WriterNotes/.test(portalSrc));
    c.ok("change requests keep their own panel, unchanged (ScriptRequestsPanel beside the card)", /<ScriptRequestsPanel groups=\{requests\} \/>/.test(read("src/app/content/[id]/tabs/PlanTab.tsx")));

    // =======================================================================
    c.head("2 · Approve and send: one press, the same ledger and checks; refused in words");
    await as(jordan);
    const clean = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(6), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email, parts: { title: "Clean one to send", hook: "Your Saturday picks your town.", points: pts("Not the listing photos.", "Coffee, the trail, the market.", "Live where your Saturday is."), close: "Tell me your Saturday.", pillarId, categoryLabel: "Local Life" } });
    const sent = await A.approveAndSendScriptAction(clean.versionId);
    const hs = await head(clean.scriptId);
    const ledger = await prisma.contentScriptRelease.findMany({ where: { scriptId: clean.scriptId }, select: { action: true } });
    c.ok("one press: approved and shared, this exact version", sent.ok && hs.approvedVersionId === clean.versionId && hs.sharedVersionId === clean.versionId && hs.releaseState === "released", sent.message);
    c.ok("…on the same release ledger (APPROVE and SHARE), the email only behind its switch", ledger.some((l) => l.action === "APPROVE") && ledger.some((l) => l.action === "SHARE") && /suppressed/i.test(sent.message), `${ledger.map((l) => l.action).join(",")} · ${sent.message}`);
    const four = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(7), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email, parts: { title: "Four points", hook: "Four things about Saturday.", points: [...pts("One.", "Two.", "Three."), { role: "payoff" as const, text: "Four." }], close: "Call me.", pillarId, categoryLabel: "Local Life" } });
    const r4 = await A.approveAndSendScriptAction(four.versionId);
    const h4 = await head(four.scriptId);
    c.ok("a house-format refusal is said in words, and nothing is approved or shared", !r4.ok && /^House script format:/.test(r4.message) && !h4.approvedVersionId && !h4.sharedVersionId, r4.message);
    const nop = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(8), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email, parts: { title: "No pillar yet", hook: "Saturday, honestly.", points: pts("Buyers ask.", "I answer with my Saturday.", "Pick the town."), close: "Call me.", categoryLabel: "Nonexistent Pillar" } });
    const rNo = await A.approveAndSendScriptAction(nop.versionId);
    c.ok("a format check refuses in words (the card then asks for a written reason)", !rNo.ok && /^Format check:/.test(rNo.message) && !(await head(nop.scriptId)).sharedVersionId, rNo.message);
    const rWhy = await A.approveAndSendScriptAction(nop.versionId, "Pillar renamed this month; mapping is fine.");
    c.ok("…with a written reason it goes, recorded", rWhy.ok && (await head(nop.scriptId)).sharedVersionId === nop.versionId, rWhy.message);
    c.ok("script_auto_share is untouched: nothing here shares on its own (no automation row turned on)", !(await prisma.programAutomation.findFirst({ where: { key: "script_auto_share", enabled: true } })));
    // James (the creative manager): Edit as before; Approve and send answered by the same owner rule as Approve only.
    await as(james);
    const jEdit = await A.saveScriptText(b.scriptId, "HOOK:\nSaturday tells you where to live, honestly.\n\nTALKING POINT 1 (RE-HOOK):\nThe Saturday shows you the town.\n\nTALKING POINT 2 (BUILD-UP):\nCoffee, the trail, the farmers market.\n\nTALKING POINT 3 (PAYOFF):\nLive where your Saturday already is.\n\nCLOSE / CTA:\nTell me your perfect Saturday.", { baseVersionId: hB.currentVersionId });
    const jSend = await A.approveAndSendScriptAction(a.versionId);
    const jOnly = await A.approveScriptVersionAction(a.versionId);
    c.ok("the creative manager: Edit saves a new version as before", jEdit.ok && /Saved as version/.test(jEdit.message), jEdit.message);
    c.ok("…and Approve and send is answered exactly as Approve only (the script owner rule, unchanged)", jSend.ok === jOnly.ok && (jSend.ok || jSend.message === jOnly.message), `${jSend.message} | ${jOnly.message}`);
    await as(jordan);

    // =======================================================================
    c.head("4 · the dry run's rule and the live script's guards");
    const vrow = (id: string, versionNo: number, judgeRec: unknown, words = 72) => ({ id, versionNo, spokenWordCount: words, validationJson: JSON.stringify({ judge: judgeRec }) });
    const wj = (must: number, cr: ReturnType<typeof craft>, extra: Record<string, unknown> = {}) => ({ state: "flagged", fixRounds: 0, criteria: [{ key: "x", pass: false, note: "" }], issues: [], attempts: 0, writer: 2, checks: [...Array.from({ length: must }, (_, i) => ({ key: `k${i}`, n: i + 1, label: "L", level: "must-fix", pass: false, reason: "" })), { key: "ok", n: 13, label: "OK", level: "must-fix", pass: true, reason: "" }], craft: cr, ...extra });
    // Bernadette's Saturday, as the live data has it (the dry run printed it): v12 current, v7 better on craft with the same must-fix count.
    const v12 = vrow("v12", 12, wj(4, craft(2, 2, 3, 2, 3)), 72);
    const others = [vrow("v4", 4, wj(8, craft(2, 2, 1, 2, 4)), 85), vrow("v5", 5, { ...wj(3, craft(5, 5, 5, 5, 5)), state: "not_checked", error: "Paused on Oct 22 2026 (Jordan's redo)" }, 83), vrow("v7", 7, wj(4, craft(4, 4, 2, 2, 3)), 87), vrow("v10", 10, wj(8, craft(2, 2, 3, 2, 3)), 75), vrow("v11", 11, wj(6, craft(2, 2, 3, 2, 2)), 77), vrow("v9", 9, { state: "flagged", fixRounds: 2, criteria: [{ key: "x", pass: true, note: "" }], issues: [], attempts: 0 }, 85)];
    const pick = rec.betterEarlierVersion(v12, [...others, v12]);
    c.ok("Saturday: v7 (4 must-fix, the stronger hook: craft 19) beats the current v12 (4 must-fix, craft 14) → propose v7", pick?.pick.id === "v7", pick?.pick.id ?? "none");
    c.ok("…a version the Oct 22 pause set aside is never proposed, even when it scores better", rec.betterEarlierVersion(v12, [others[1]]) === null);
    c.ok("…the old judge's versions are not compared with the creative review's", rec.betterEarlierVersion(v12, [others[5]]) === null);
    c.ok("the current version at its best stays (a tie keeps it)", rec.betterEarlierVersion(v12, [vrow("t", 3, wj(4, craft(2, 2, 3, 2, 3)), 72), others[3], others[4]]) === null);
    c.ok("a person's current version (no review of its own) is never replaced", rec.betterEarlierVersion({ id: "p", versionNo: 13, spokenWordCount: 70, validationJson: JSON.stringify({ ok: true, findings: [] }) }, others) === null);
    c.ok("fewer must-fix failures first: Empty Nesters' v7 (1) beats its current v8 (2) though v8 is shorter", rec.betterEarlierVersion(vrow("v8", 8, wj(2, craft(3, 4, 4, 4, 4)), 79), [vrow("v7", 7, wj(1, craft(4, 4, 4, 5, 5)), 87)])?.pick.id === "v7");
    const live = read("scripts/_live/oct23-best-version-current.ts");
    c.ok("the live script is a dry run by default on a read-only connection", /process\.argv\.includes\("--apply"\)/.test(live) && /default_transaction_read_only%3Don/.test(live) && /if \(!apply\) \{ console\.log\("Dry run: nothing written/.test(live));
    c.ok("…it never touches a shared, approved or client-approved script, or history", /sharedVersionId: null, approvedVersionId: null, sharedAt: null, approvedAt: null, clientApprovedAt: null/.test(live) && /historical: false/.test(live) && /status === "APPROVED" \|\| v\.status === "SHARED"/.test(live));
    c.ok("…it restores through the app's restore path, compare-and-set on the version it read", /restoreScriptVersion\(p\.scriptId, p\.fromId, BY, \{ baseVersionId: p\.curId \}\)/.test(live) && /s\.currentVersionId !== p\.curId\) \{ console\.log\(`\$\{p\.label\} changed since the dry run/.test(live) && /betterEarlierVersion\(cur, vs, story\)/.test(live));

    // =======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("only the stubbed model answered (judge and revise)", calls.every((x) => ["judge", "revise", "script", "identity"].includes(x.kind)), [...new Set(calls.map((x) => x.kind))].join(","));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

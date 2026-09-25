// ---------------------------------------------------------------------------
// DRILL: unified handoff batch 2 — SCRIPTS & TOPICS (Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b2-scripts-topics.ts
//
// The OLD behaviour is asserted first wherever it can be observed: the old
// ScriptBody regex, contentTopics.ts and contentInterview.ts are read from
// f2555f7 (where this batch starts), their `@/` imports pointed at this tree.
//
//   P · pure: the one script layout (every renderScript shape, label variants,
//       archive shapes, zero word loss), the client's reason, GAPS_ONLY, the
//       approval-email moment and template, the policy's new values.
//   U01 the portal hands the renderer parts + the CURRENT pillar; no "(no pillar".
//   U02 the TEST fixture wording, and its repair proven on PGlite only.
//   6.3 bank target follows the policy; recommendations fit the open slots,
//       carry a client reason, reach the portal, close on the client's choice,
//       re-rank only on change; staff approve-all / hold / release.
//   6.5 gaps-only questions + profile suggestions; a draft failing twice owns
//       a task; release controls (auto-share OFF, three switches, every client
//       script surface free of DRAFT/INTERNAL_REVIEW text); version-exact
//       decisions; approval reminders 48h/24h, Kyle's task, never a cancellation.
//
// ISOLATION: PGlite on 127.0.0.1:5622. Production is never opened; every
// outbound call is fenced and counted; the model is stubbed at
// aiJsonWithUsage and the outbox's sendThroughOutbox is captured (the ledger,
// dedupe and switches are the shipped code). Clocks are passed explicitly.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5622);
const REPO = path.resolve(__dirname, "../..");
const BASE = "f2555f7"; // where this batch starts
const STAFF_EMAIL = "jordan@drill.invalid";

installNextStubs();
const fence = fenceFetch();

// ---- the model boundary ----------------------------------------------------
let aiCalls = 0;
let failNextAi = 0;
const prompts: string[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        prompts.push(`${opts.system}\n${opts.prompt}`);
        if (failNextAi > 0) { failNextAi--; throw new Error("drill: the model is unavailable"); }
        const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").replace(/\s*\(pillar:.*$/, "").trim().slice(0, 90);
        return {
          result: {
            title, category: "Market Authority",
            hook: "The first weekend decides your price, and most sellers miss it.",
            points: [{ role: "re-hook", text: "Buyers read every week on the market as a signal." }, { role: "build-up", text: "A stale listing invites the low offers you were hoping to avoid." }, { role: "payoff", text: "Price it right on day one and the buyers compete for you." }],
            close: "Planning to sell this spring? Call me before you pick a price.",
            captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
          },
          usage: { inputTokens: 500, outputTokens: 200 }, model: "drill-stub",
        };
      };
    },
  }),
);

// ---- the outbox boundary: every email is captured, none leaves --------------
const outbox: { toRef: string; body: string; dedupeKey: string }[] = [];
interceptModule(
  (r) => r === "@/lib/outbox",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "sendThroughOutbox") return t[k];
      return async (msg: { toRef: string; body: string; dedupeKey: string }) => {
        outbox.push({ toRef: msg.toRef, body: msg.body, dedupeKey: msg.dedupeKey });
        return { outcome: "accepted", id: `drill-outbox-${outbox.length}`, providerId: `drill-${outbox.length}` };
      };
    },
  }),
);

function writeBaseCopies(): { dir: string; topics: string; interview: string; scriptBody: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-scripts-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = { dir, topics: path.join(dir, "contentTopics.base.ts"), interview: path.join(dir, "contentInterview.base.ts"), scriptBody: show("src/components/portal/ScriptBody.tsx") };
  fs.writeFileSync(out.topics, point(show("src/lib/contentTopics.ts")));
  fs.writeFileSync(out.interview, point(show("src/lib/contentInterview.ts")));
  return out;
}
function removeBaseCopies(dir: string) {
  try { fs.unlinkSync(path.join(dir, "node_modules")); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* harmless */ }
}

const shiftMonth = (key: string, n: number) => { const [y, m] = key.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
/** November 2026 is EST (UTC-5): 10:00 ET = 15:00Z. */
const et = (day: number, hh = 10, mm = 0) => new Date(Date.UTC(2026, 10, day, hh + 5, mm));

async function strategyText(name: string): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers before they list", "Show local pricing expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Lead with pricing and timing."], pillars: [
      { number: 1, name: "Market Authority", heading: "Pillar 1: Market Authority", purpose: "Show command of the local market.", focusAreas: "pricing, timing", contentApproach: null, otherFields: [] },
      { number: 2, name: "Seller Education", heading: "Pillar 2: Seller Education", purpose: "Teach sellers what to do before listing.", focusAreas: "prep, repairs", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PRICE."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Lead with pricing this quarter."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  // Booted first: the pure sections below import modules that construct the
  // Prisma client (programReminders), and it must point here, never at .env.
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const c = makeChecker();
  const pure = await import("@/lib/scriptLayout");
  const policy = await import("@/lib/contentPolicy");

  // ==========================================================================
  c.head("P1 · U01 — every house render lays out as Hook · 3 Talking Points · Close");
  // ==========================================================================
  const base = writeBaseCopies();
  const oldRe = (() => {
    const m = /const SECTION_RE = (\/.+\/[a-z]*);/.exec(base.scriptBody);
    if (!m) return null;
    const lit = m[1];
    return new RegExp(lit.slice(1, lit.lastIndexOf("/")), lit.slice(lit.lastIndexOf("/") + 1));
  })();
  c.ok("the old ScriptBody regex is read from f2555f7", !!oldRe);
  const gen = (o: { category?: string; caption?: string | null; roles?: ("re-hook" | "build-up" | "payoff")[] } = {}) => policy.scriptFromGeneratorOutput({
    title: "Why the first weekend decides your price", category: o.category ?? "Market Authority",
    hook: "The first weekend decides your price.",
    points: (o.roles ?? ["re-hook", "build-up", "payoff"]).map((role, i) => ({ role, text: [`Buyers read days on market as a signal.`, `A stale listing invites low offers.`, `Price it right on day one.`][i] })),
    close: "Call me before you pick a price.", captionCta: o.caption ?? null,
  }, null);
  for (const [label, canon] of [["caption CTA present", gen({ caption: "Comment PLAN for my checklist." })], ["no caption CTA", gen()]] as const) {
    const text = policy.renderScript(canon);
    const L = pure.scriptBlocksFromText(text);
    const roles = L.sections.map((s) => s.role).join(",");
    const want = label === "no caption CTA" ? "hook,point,point,point,close" : "hook,point,point,point,close,caption";
    c.ok(`${label}: sections are ${want}`, roles === want, roles);
    c.ok(`${label}: the three roles are read from "Talking Point n: Role"`, L.sections.filter((s) => s.role === "point").map((s) => s.pointRole).join(",") === "re-hook,build-up,payoff");
    c.ok(`${label}: canonical bold labels`, L.sections.slice(0, 5).map((s) => s.label).join(" | ") === "Hook | Talking Point 1 — Re-hook | Talking Point 2 — Build-up | Talking Point 3 — Payoff | Close / CTA", L.sections.map((s) => s.label).join(" | "));
    c.ok(`${label}: no word lost (layout words == body words)`, JSON.stringify(pure.layoutWords(L)) === JSON.stringify(pure.scriptWords(text)));
    const spoken = [canon.hook?.text, ...canon.points.map((p) => p.text), canon.close?.text].join(" ");
    c.ok(`${label}: the spoken words are exactly the parts' words`, JSON.stringify(pure.spokenLayoutWords(L)) === JSON.stringify(pure.scriptWords(spoken)));
    c.ok(`${label}: category chip is the pillar`, L.category === "Market Authority");
    if (oldRe) {
      const oldSections = text.split("\n").filter((l) => oldRe.test(l.trim())).length;
      c.ok(`${label}: OLD — ScriptBody found ${oldSections} heading (only HOOK); NEW finds ${L.sections.length}`, oldSections === 1 && L.sections.length >= 5, `${oldSections}`);
    }
  }
  {
    const noPillar = gen({ category: "" });
    const text = policy.renderScript(noPillar);
    c.ok("OLD render (what the portal served at f2555f7) carries '(no pillar linked)'", /Category: \(no pillar linked\)/.test(text));
    c.ok("NEW text path: no category chip for a no-pillar placeholder", pure.scriptBlocksFromText(text).category === null);
    c.ok("NEW client render: no Category line at all", !/Category/i.test(policy.renderScript(noPillar, { audience: "client" })));
    c.ok("NEW parts path: '(no pillar)' is never a pillar", pure.scriptBlocksFromParts({ hook: "h one", points: [], close: "c" }, { pillarName: null, categoryLabel: "(no pillar)" }).category === null);
    c.ok("the stored (staff) render is unchanged", policy.renderScript(noPillar).includes("Category: (no pillar linked)"));
    // Batch-2 review: the posting kit's Copy / Download hand over the exact
    // body, so the client render must carry no placeholder of any kind.
    const bare = policy.scriptFromGeneratorOutput({ title: "Bare bones", category: "", hook: "", points: [], close: "Call me before you pick a price.", captionCta: null }, null);
    const staffBare = policy.renderScript(bare);
    const clientBare = policy.renderScript(bare, { audience: "client" });
    c.ok("OLD (the default render the posting kit used): '(no pillar linked)' and '(no hook)' in the text a client copies", /\(no pillar linked\)/.test(staffBare) && /\(no hook\)/.test(staffBare));
    c.ok("NEW client render: no placeholder at all — empty blocks are left out, the close stays", !/\(no pillar|\(no hook\)|\(empty\)|\(no close\)|\(untitled\)/i.test(clientBare) && clientBare.includes("Call me before you pick a price."), clientBare);
    c.ok("a STORED body a client is shown loses only the placeholder lines", policy.stripRenderPlaceholders(staffBare) === staffBare.split("\n").filter((l) => !/^(Category: \(no pillar linked\)|\(no hook\))$/.test(l)).join("\n") && !/\(no pillar|\(no hook\)/.test(policy.stripRenderPlaceholders(staffBare)));
  }

  // ==========================================================================
  c.head("P2 · U01 — label variants and archive shapes: zero word loss");
  // ==========================================================================
  const variants: { name: string; body: string; sections: string; spokenIncludes?: string }[] = [
    { name: "colon + inline text", body: "Pricing Right\nCategory: Market Authority\nHook: The first weekend decides your price.\nTalking Point 1 (Re-hook): Buyers read days on market.\nTalking Point 2 (Build-up): Stale listings invite low offers.\nTalking Point 3 (Payoff): Price it right on day one.\nClose/CTA: Call me before you list.", sections: "hook,point,point,point,close", spokenIncludes: "first weekend" },
    { name: "archive dashes, CALLBACK/CTA", body: "HOOK\nYou are leaving money on the table.\nTALKING POINT 1 - RE-HOOK\nMost sellers price from a feeling.\nTALKING POINT 2 - BUILD UP\nBuyers price from the comps.\nTALKING POINT 3 - PAYOFF\nMeet them there and they compete.\nCALLBACK/CTA\nDM me PRICE.", sections: "hook,point,point,point,close" },
    { name: "Close: + optional caption", body: "HOOK:\nStop guessing.\nTalking Point 1: Re-hook\nGuessing costs weeks.\nTalking Point 2 – Build up: Weeks cost offers.\nTalking Point 3: Payoff\nA plan wins.\nClose:\nLet's plan it.\nOptional Caption CTA\nComment PLAN.", sections: "hook,point,point,point,close,caption" },
    { name: "archive re-hook/payoff blocks + OUTRO", body: "INTRO\nA quick one today.\nRe-hook (as delivered)\nHere is the part nobody says.\nPayoff (as delivered)\nThat is why it works.\nOUTRO\nSee you next week.", sections: "other,rehook-extra,payoff-extra,close" },
    { name: "bullets become a list", body: "HOOK\nThree things before you list:\n• paint the front door\n• fix the lights\n• clear the counters\nCLOSE / CALL TO ACTION\nCall me.", sections: "hook,close" },
    { name: "an unlabelled import stays prose", body: "The first weekend decides your price.\nBuyers read days on market.\nCall me.", sections: "" },
    { name: "sentences that START with a label word are prose", body: "HOOK\nClose the deal before the weekend.\nHook them early with a question.\nCTA\nCall me today.", sections: "hook,close", spokenIncludes: "close the deal" },
  ];
  for (const v of variants) {
    const L = pure.scriptBlocksFromText(v.body);
    c.ok(`${v.name}: sections ${v.sections || "(none)"}`, L.sections.map((s) => s.role).join(",") === v.sections, L.sections.map((s) => s.role).join(","));
    c.ok(`${v.name}: zero word loss`, JSON.stringify(pure.layoutWords(L)) === JSON.stringify(pure.scriptWords(v.body)));
    if (v.spokenIncludes) c.ok(`${v.name}: "${v.spokenIncludes}" stays spoken text`, pure.spokenLayoutWords(L).join(" ").includes(v.spokenIncludes));
  }
  c.ok("bullets: three list items", pure.scriptBlocksFromText(variants[4].body).sections[0].lines.some((l) => l.kind === "list" && l.items.length === 3));
  c.ok("inline hook text is the hook's first line", (() => { const s = pure.scriptBlocksFromText(variants[0].body).sections[0]; return s.lines[0]?.kind === "para" && s.lines[0].text === "The first weekend decides your price."; })());
  c.ok("title line recognised above a category", pure.scriptBlocksFromText(variants[0].body).title === "Pricing Right");
  {
    // The representative month's scripts, through the house renderer: nine topics, three pillars.
    const src = fs.readFileSync(path.join(REPO, "scripts/_fixtures/representativeMonth.ts"), "utf8");
    const sets = [...src.matchAll(/\["([^"]+)", "([^"]+)", "([^"]+)"\]/g)].map((m) => [m[1], m[2], m[3]]);
    let lost = 0;
    for (const [i, s] of sets.entries()) {
      const canon = policy.scriptFromGeneratorOutput({ title: `Topic ${i}`, category: "Seller Playbook", hook: "Here is what the listings never tell you.", points: [{ role: "re-hook", text: s[0] }, { role: "build-up", text: s[1] }, { role: "payoff", text: s[2] }], close: "Call me.", captionCta: "Comment PLAN." }, null);
      const text = policy.renderScript(canon);
      if (JSON.stringify(pure.layoutWords(pure.scriptBlocksFromText(text))) !== JSON.stringify(pure.scriptWords(text))) lost++;
    }
    c.ok(`representative month: ${sets.length} point sets render and parse with zero word loss`, sets.length >= 9 && lost === 0, `${sets.length} sets, ${lost} lost`);
    c.ok("U02: representative month topics each carry their own concept", (src.match(/^\s+"[^"]+": "[^"]+\.",$/gm) ?? []).length >= 30);
    c.ok("U02: the strategy subtitle and the transcript header carry no marker", !/Social Content Strategy \$\{REPRESENTATIVE_MARKER\}/.test(src) && !/planning \$\{monthKey\} \$\{REPRESENTATIVE_MARKER\}/.test(src));
  }

  // ==========================================================================
  c.head("P3 · 6.3 — the client's reason is plain and never staff wording");
  // ==========================================================================
  {
    const staffWords = /filler|verified|signal|score|rank|priority/i;
    const cases = [
      policy.clientReasonFor({ linkedGoal: "Build trust with sellers before they list", pillar: "Market Authority", priorContentRelationship: "new", reasons: ["supports goal"] }),
      policy.clientReasonFor({ linkedGoal: null, pillar: "Seller Education", priorContentRelationship: "new", reasons: [] }, { pillarFilmedCounts: { "Market Authority": 4, "Seller Education": 1 } }),
      policy.clientReasonFor({ linkedGoal: null, pillar: "Market Authority", priorContentRelationship: "follow-up", reasons: ["adds a new angle to filmed content (“Days on market”)"] }),
      policy.clientReasonFor({ linkedGoal: null, pillar: "(no pillar)", priorContentRelationship: "new", reasons: ["in the bank with no goal — a filler, not a priority"] }),
    ];
    c.ok("a linked goal is named", cases[0].includes("Build trust with sellers before they list"), cases[0]);
    c.ok("pillar balance is said plainly", /Balances your videos/.test(cases[1]), cases[1]);
    c.ok("a follow-up names what it builds on", /fresh angle on “Days on market”/.test(cases[2]), cases[2]);
    c.ok("no reason carries staff wording or a no-pillar placeholder", cases.every((r) => !staffWords.test(r) && !/no pillar/i.test(r)), cases.join(" | "));
  }

  // ==========================================================================
  c.head("P4 · 6.5 — GAPS_ONLY asks only what the call left missing");
  // ==========================================================================
  {
    const topic = { id: "t1", clientId: "c1", title: "Pricing for the first weekend", description: null, pillarRef: { pillarId: null, pillarName: "Market Authority" }, audienceNeed: null, businessGoal: null, intendedMessage: null, source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: null, proposedState: null, importedMark: null, history: [], strategyVersion: null, stamp: null } as unknown as Parameters<typeof policy.nextQuestion>[1]["topic"];
    const sufficiency = { topicAudienceNeed: null, callExcerpts: [{ speaker: "client", text: "Every listing I took that sat past the first weekend sold for less than the one priced right from day one." }] };
    const base0 = { topic, audience: null, clientName: "Drill", sufficiency };
    const full = policy.nextQuestion([], base0);
    c.ok("FULL (unchanged): starts at question 1", full.kind === "question" && full.question.id === "audienceProblem");
    const g1 = policy.nextQuestion([], { ...base0, mode: "GAPS_ONLY" });
    c.ok("GAPS_ONLY: premise and stance come from the call, so the first ask is the talking points", g1.kind === "question" && g1.question.id === "talkingPoints", g1.kind === "question" ? g1.question.id : g1.kind);
    const answers = [{ questionId: "talkingPoints" as const, status: "answered" as const, text: "First, buyers read days on market. Second, a stale listing invites low offers. Finally, the right price brings competing offers.", followUps: [], reusedFrom: null, answeredAt: new Date().toISOString() }];
    const g2 = policy.nextQuestion(answers, { ...base0, mode: "GAPS_ONLY" });
    c.ok("…one answer and it is done", g2.kind === "done");
    c.ok("…and sufficient (a script can exist)", policy.evaluateSufficiency(answers, sufficiency).ready === true);
    const skipped = policy.nextQuestion([{ ...answers[0], status: "skipped" as const, text: null }], { ...base0, mode: "GAPS_ONLY" });
    c.ok("a skipped gap question is not asked again", skipped.kind === "done");
  }

  // ==========================================================================
  c.head("P5 · 6.5 — the approval email's moment, words and policy");
  // ==========================================================================
  const pr = await import("@/lib/programReminders");
  const tpl = await import("@/lib/reminderTemplates");
  {
    const p = pr.REMINDER_DEFAULTS;
    c.ok("defaults: 48h email, 24h deadline, 24h desk task, 72h bell", p.scriptApproval.clientLeadHours === 48 && p.scriptApproval.deadlineHoursBefore === 24 && p.scriptApproval.deskTaskLeadHours === 24 && p.scriptApproval.ownerBellLeadHours === 72);
    c.ok("Thu 10:00 ET session → email Tue 10:00 ET", pr.scriptApprovalReminderAt(et(12), p).toISOString() === et(10).toISOString(), pr.scriptApprovalReminderAt(et(12), p).toISOString());
    c.ok("Mon 10:00 ET session → back to Friday 9:00 ET", pr.scriptApprovalReminderAt(et(16), p).toISOString() === et(13, 9).toISOString(), pr.scriptApprovalReminderAt(et(16), p).toISOString());
    c.ok("Thu 18:00 ET session → Tue office opening (moved back into hours)", pr.scriptApprovalReminderAt(et(12, 18), p).toISOString() === et(10, 9).toISOString(), pr.scriptApprovalReminderAt(et(12, 18), p).toISOString());
    c.ok("deadline = 24h before filming", pr.scriptApprovalDeadline(et(12), p).toISOString() === et(11).toISOString());
    const body = tpl.renderReminder(tpl.templateForAction("APPROVE_SCRIPTS"), { firstName: "Ada", month: "November", portalLink: "https://drill.invalid/p", bookCallLink: null, noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 1, titles: ["Why the first weekend decides your price"], updatedTitles: [], deadline: null, sessionDay: "Thursday, November 12", approvalDeadline: "Wednesday, November 11 at 10:00 AM ET" });
    c.ok("the email names the session, the deadline and the title", body.includes("Thursday, November 12") && body.includes("by Wednesday, November 11 at 10:00 AM ET") && body.includes("Why the first weekend decides your price"));
    c.ok("…says the shoot goes ahead either way, and threatens nothing", /We film either way/.test(body) && !/cancel|reschedul|moved/i.test(body));
    c.ok("…with no em dash (Jordan's rule)", !body.includes("—"));
    c.ok("the default policy validates", pr.validateReminderPolicy(pr.REMINDER_DEFAULTS).ok === true);
    const bad = pr.validateReminderPolicy({ ...pr.REMINDER_DEFAULTS, scriptApproval: { clientLeadHours: 20, deadlineHoursBefore: 24 } });
    c.ok("an email after its own deadline is refused", !bad.ok && bad.errors.some((e) => /clientLeadHours must be more than/.test(e)));
    const oldTpl = execFileSync("git", ["show", `${BASE}:src/lib/reminderTemplates.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok("OLD: no script-approval reminder existed", !oldTpl.includes("APPROVE_SCRIPTS"));
  }

  // ==========================================================================
  // THE DATABASE
  // ==========================================================================
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { etMonthKey } = await import("@/lib/contentProgram");
  const CUR = etMonthKey(new Date());
  const NEXT = shiftMonth(CUR, 1);
  const ct = await import("@/lib/contentTopics");
  const cs = await import("@/lib/contentStrategy");
  const scr = await import("@/lib/contentScripts");
  const share = await import("@/lib/scriptShare");
  const portal = await import("@/lib/portal");
  const ci = await import("@/lib/contentInterview");
  const desk = await import("@/lib/programDeskTasks");
  const auto = await import("@/lib/scriptAutoShare");
  const { renamePillar } = await import("@/lib/contentPillars");
  const setSwitch = async (key: string, enabled: boolean, configJson?: string) => {
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: configJson ?? null }, update: { enabled, ...(configJson ? { configJson } : {}) } });
  };
  // The duty owners the defaults mint from: Jordan (OWNER, company address) and Kyle (ADMIN).
  await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
  await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" } });
  const approvedStrategyFor = async (enrollmentId: string, name: string) => {
    const text = await strategyText(name);
    const { stored } = cs.structuredFromText(text);
    const sv = await cs.createStrategyVersion({ enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof cs.createStrategyVersion>[0]);
    await cs.approveStrategyVersion(sv.versionId, STAFF_EMAIL);
    const pillars = await prisma.contentPillar.findMany({ where: { enrollmentId }, orderBy: { sortOrder: "asc" } });
    return { strategyVersionId: sv.versionId, pillars };
  };
  const PARTS = (hook: string) => ({
    hook,
    points: [
      { role: "re-hook" as const, text: "Most sellers learn this the expensive way, after the listing is live." },
      { role: "build-up" as const, text: "Buyers read every week on the market as a signal about your price." },
      { role: "payoff" as const, text: "Get the price and the photos right before day one and they compete." },
    ],
    close: "Planning to sell this year? Call me before you book the photographer.",
  });
  const validationOf = (parts: ReturnType<typeof PARTS> & { title: string; categoryLabel: string | null; pillarId: string | null }) => {
    const v = policy.validateNewScript(scr.canonicalFromParts(parts));
    return { ok: v.ok, findings: v.findings };
  };

  try {
    // ======================================================================
    c.head("U01 · the portal hands the renderer parts and the CURRENT pillar");
    // ======================================================================
    const A = await buildContentMonth(db, { name: "Layout Drill TEST", package: "Accelerator", monthKey: NEXT, topics: [{ title: "Why the first weekend decides your price", selection: "SELECTED" }, { title: "A topic without a category", selection: "SELECTED" }] });
    const aS = await approvedStrategyFor(A.enrollmentId, "Layout Drill TEST");
    const mkt = aS.pillars.find((p) => p.name === "Market Authority")!;
    await prisma.contentTopic.update({ where: { id: A.topicIds[0] }, data: { pillarId: mkt.id, pillar: mkt.name } });
    const p1 = { title: "Why the first weekend decides your price", categoryLabel: mkt.name, pillarId: mkt.id, ...PARTS("The first weekend decides your price.") };
    const v1 = await scr.createScriptVersion({ enrollmentId: A.enrollmentId, monthId: A.monthId, topicId: A.topicIds[0], parts: p1, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: aS.strategyVersionId, validation: validationOf(p1) });
    await share.shareApprovedScript(v1.versionId, { email: STAFF_EMAIL });
    await renamePillar(mkt.id, "Market Mastery", STAFF_EMAIL);
    const p2 = { title: "A topic without a category", categoryLabel: null, pillarId: null, ...PARTS("Nobody tells you this about pricing.") };
    const v2 = await scr.createScriptVersion({ enrollmentId: A.enrollmentId, monthId: A.monthId, topicId: A.topicIds[1], parts: p2, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: aS.strategyVersionId, validation: validationOf(p2) });
    await share.shareApprovedScript(v2.versionId, { email: STAFF_EMAIL }, { note: "drill: no pillar on purpose" });
    const topicsA = await portal.portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    const tA = topicsA.groups.flatMap((g) => g.topics);
    const s1 = tA.find((t) => t.id === A.topicIds[0])?.scriptText;
    const s2 = tA.find((t) => t.id === A.topicIds[1])?.scriptText;
    c.ok("the released script arrives with its parts: three roled points", s1?.parts?.points.length === 3 && s1.parts.points.map((p) => p.role).join(",") === "re-hook,build-up,payoff", JSON.stringify(s1?.parts?.points.map((p) => p.role)));
    c.ok("…and the pillar's CURRENT name, though the version froze the old one", s1?.pillarName === "Market Mastery", `${s1?.pillarName}`);
    c.ok("…the body quotes the current name too", !!s1?.body.includes("Category: Market Mastery"));
    c.ok("a no-pillar script: no pillar, no Category line, no placeholder", s2 !== undefined && s2 !== null && s2.pillarName === null && !/Category/.test(s2.body) && !/\(no pillar/i.test(s2.body), s2?.body.split("\n").slice(0, 2).join(" / "));
    c.ok("the renderer lays the parts out as five sections", !!s1?.parts && pure.scriptBlocksFromParts(s1.parts, { pillarName: s1.pillarName }).sections.length === 5);
    c.ok("nothing on the client's page says '(no pillar'", !/\(no pillar/i.test(JSON.stringify(topicsA)));
    const oldPortal = execFileSync("git", ["show", `${BASE}:src/lib/portal.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok("OLD: the portal rendered the default body, placeholder and frozen label included", oldPortal.includes("body: stripMoneySentences(renderScript(canonical))"));

    // ======================================================================
    c.head("U02 · the TEST fixture wording, and its repair (PGlite only)");
    // ======================================================================
    const repair = await import("../repair-test-fixture-wording");
    const B = await buildContentMonth(db, { name: "Wording Drill TEST", package: "Starter", monthKey: NEXT, topics: [] });
    const legacyPillar = await prisma.contentPillar.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, name: repair.LEGACY_FIXTURE_PILLAR_NAME, purpose: `${repair.SCENARIO_TAG} a pillar for the §25 walkthrough`, createdBy: repair.FIXTURE_PILLAR_BY } });
    for (const f of repair.FIXTURE_TOPICS) {
      await prisma.contentTopic.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, title: f.title, pillarId: legacyPillar.id, pillar: legacyPillar.name, concept: repair.LEGACY_FIXTURE_CONCEPT, source: "strategy_call", status: "SAVED", approvalState: "APPROVED", notes: `${repair.SCENARIO_TAG} raised on the call`, clientVisible: true } });
    }
    const bRun = await prisma.contentTopicRefreshRun.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, kind: "REFRESH", status: "SUCCEEDED", requestedBy: "acceptance-fixture", changeSummary: `${repair.SCENARIO_TAG} refresh` } });
    for (const title of Object.keys(repair.FIXTURE_SUGGESTION_CONCEPTS)) {
      await prisma.contentTopicSuggestion.create({ data: { refreshRunId: bRun.id, enrollmentId: B.enrollmentId, clientId: B.clientId, pillarId: legacyPillar.id, kind: "BANK", title, description: `${repair.SCENARIO_TAG} suggested by a refresh after the month's scripts were approved.`, disposition: "PENDING" } });
    }
    // A REAL client (no TEST in the name) carrying the same wording: must be refused, never written.
    const realClient = await prisma.client.create({ data: { name: "Harbor Realty Group" }, select: { id: true } });
    const realEnr = await prisma.contentEnrollment.create({ data: { clientId: realClient.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 }, select: { id: true } });
    const realPillar = await prisma.contentPillar.create({ data: { enrollmentId: realEnr.id, clientId: realClient.id, name: repair.LEGACY_FIXTURE_PILLAR_NAME, purpose: `${repair.SCENARIO_TAG} x`, createdBy: repair.FIXTURE_PILLAR_BY } });
    const realTopic = await prisma.contentTopic.create({ data: { enrollmentId: realEnr.id, clientId: realClient.id, title: "What a pre-listing inspection saves you", concept: repair.LEGACY_FIXTURE_CONCEPT, pillar: repair.LEGACY_FIXTURE_PILLAR_NAME, source: "staff", status: "SAVED", notes: `${repair.SCENARIO_TAG} x` } });
    const clientRe = /acceptance|fixture|CP-15|§25|\(no pillar/i;
    const beforePayload = JSON.stringify(await portal.portalTopics({ id: B.enrollmentId, clientId: B.clientId }));
    c.ok("OLD wording reached the TEST client's page", clientRe.test(beforePayload));
    const plan = await repair.repairTestFixtureWording(db, { write: false });
    c.ok("dry run: 1 pillar, 5 topics, 2 suggestions planned", plan.plan.pillars.length === 1 && plan.plan.topics.length === 5 && plan.plan.suggestions.length === 2, `${plan.plan.pillars.length}/${plan.plan.topics.length}/${plan.plan.suggestions.length}`);
    c.ok("…every planned row is the TEST client's", [...plan.plan.pillars, ...plan.plan.topics, ...plan.plan.suggestions].every((r) => r.clientName === "Wording Drill TEST"));
    c.ok("…the real client's rows are listed as REFUSED", plan.plan.refused.some((r) => r.id === realPillar.id) && plan.plan.refused.some((r) => r.id === realTopic.id));
    c.ok("…and the dry run wrote nothing", (await prisma.contentPillar.findUnique({ where: { id: legacyPillar.id } }))?.name === repair.LEGACY_FIXTURE_PILLAR_NAME && plan.backupPath === null);
    const inRepo = await repair.repairTestFixtureWording(db, { write: true, backupDir: path.join(REPO, "tmp-backup") }).then(() => null, (e: Error) => e.message);
    c.ok("a backup inside the repository is refused, before any write", !!inRepo && /inside the repository/.test(inRepo) && (await prisma.contentPillar.findUnique({ where: { id: legacyPillar.id } }))?.name === repair.LEGACY_FIXTURE_PILLAR_NAME, inRepo ?? "");
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-wording-backup-"));
    const done = await repair.repairTestFixtureWording(db, { write: true, backupDir, now: new Date("2026-09-25T20:00:00Z") });
    c.ok("--write: backup saved outside git first, with the before-rows", !!done.backupPath && fs.existsSync(done.backupPath) && JSON.parse(fs.readFileSync(done.backupPath, "utf8")).pillars[0]?.name === repair.LEGACY_FIXTURE_PILLAR_NAME, done.backupPath ?? "");
    c.ok("--write: 1 / 5 / 2 rows written, 0 non-TEST touched", done.written.pillars === 1 && done.written.topics === 5 && done.written.suggestions === 2 && done.nonTestTouched === 0, JSON.stringify(done.written));
    const pAfter = await prisma.contentPillar.findUnique({ where: { id: legacyPillar.id } });
    c.ok("readback: the pillar is 'Seller Playbook' with a plain purpose", pAfter?.name === "Seller Playbook" && pAfter.purpose === repair.FIXTURE_PILLAR.purpose);
    c.ok("readback: the old name is kept as a PREVIOUS alias", !!(await prisma.contentPillarAlias.findFirst({ where: { pillarId: legacyPillar.id, name: repair.LEGACY_FIXTURE_PILLAR_NAME, kind: "PREVIOUS" } })));
    c.ok("readback: every topic has its own concept", (await prisma.contentTopic.findMany({ where: { enrollmentId: B.enrollmentId } })).every((t) => t.concept && t.concept !== repair.LEGACY_FIXTURE_CONCEPT && t.pillar === "Seller Playbook"));
    c.ok("readback: the marker moved to the suggestions' staff rationale", (await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: B.enrollmentId } })).every((s) => !(s.description ?? "").includes(repair.SCENARIO_TAG) && (s.rationale ?? "").includes(repair.SCENARIO_TAG)));
    c.ok("the real client's rows are untouched", (await prisma.contentPillar.findUnique({ where: { id: realPillar.id } }))?.name === repair.LEGACY_FIXTURE_PILLAR_NAME && (await prisma.contentTopic.findUnique({ where: { id: realTopic.id } }))?.concept === repair.LEGACY_FIXTURE_CONCEPT);
    const afterPayload = JSON.stringify(await portal.portalTopics({ id: B.enrollmentId, clientId: B.clientId }));
    c.ok("the TEST client's page carries none of acceptance / fixture / CP-15 / §25 / (no pillar", !clientRe.test(afterPayload), (afterPayload.match(clientRe) ?? [])[0] ?? "");
    const again = await repair.repairTestFixtureWording(db, { write: true, backupDir });
    c.ok("a second run finds nothing to do", again.plan.pillars.length + again.plan.topics.length + again.plan.suggestions.length === 0 && again.backupPath === null);
    const seeder = fs.readFileSync(path.join(REPO, "scripts/create-test-client.ts"), "utf8");
    c.ok("create-test-client: the pillar is found by who made it, never by the old name", /createdBy: FIXTURE_PILLAR_BY/.test(seeder) && !/name: "Acceptance pillar"/.test(seeder) && !seeder.includes('concept: "Discussed on the acceptance call."'));
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* scratch */ }

    // ======================================================================
    c.head("6.3 · the bank target follows the policy");
    // ======================================================================
    const { activePolicyVersion, setTopicsPerPillar } = await import("@/lib/aiRuns");
    c.ok("bankStock target = the policy's topicsPerPillar (10)", (await ct.bankStock(A.enrollmentId)).every((p) => p.target === 10) && (await activePolicyVersion()).topicsPerPillar === 10);
    await setTopicsPerPillar(12);
    c.ok("an owner change to 12 moves every pillar's target to 12", (await ct.bankStock(A.enrollmentId)).every((p) => p.target === 12));
    await setTopicsPerPillar(10);

    // ======================================================================
    c.head("6.3 · recommendations fit the open slots and reach the client");
    // ======================================================================
    const C = await buildContentMonth(db, { name: "Rec Drill TEST", package: "Accelerator", monthKey: NEXT, owner: { email: "info+recdrill@realtourpilot.com" }, topics: [] });
    const cS = await approvedStrategyFor(C.enrollmentId, "Rec Drill TEST");
    const [cMkt, cEdu] = cS.pillars;
    const bankTitles = ["Building trust with sellers before they list", "Local pricing expertise in one chart", "What days on market tell a buyer", "The three rooms buyers decide on", "What staging costs here", "The paperwork to have ready", "How to read your first offer", "When to say yes to an early offer"];
    const bankIds: string[] = [];
    for (const [i, title] of bankTitles.entries()) {
      const pl = i % 2 ? cEdu : cMkt;
      bankIds.push((await prisma.contentTopic.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, title, pillarId: pl.id, pillar: pl.name, concept: `${title}.`, source: "staff", status: "SAVED", approvalState: "APPROVED" } })).id);
    }
    const declined = await prisma.contentTopic.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, title: "Building trust with a seller video series", pillarId: cMkt.id, source: "staff", status: "SAVED", approvalState: "APPROVED", clientDeclinedAt: new Date(), clientDeclineReason: "not for me" } });
    const aiProposed = await prisma.contentTopic.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, title: "Building trust with sellers through local pricing", pillarId: cMkt.id, source: "ai", status: "SAVED", approvalState: "PROPOSED" } });
    // One scripted-but-unfilmed topic CARRIED into the month: it takes a slot first.
    const carried = await prisma.contentTopic.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, title: "Carried: the first weekend", pillarId: cMkt.id, source: "staff", status: "SCRIPTED", approvalState: "APPROVED", monthId: C.monthId } });
    await prisma.contentTopicSelection.create({ data: { topicId: carried.id, monthId: C.monthId, enrollmentId: C.enrollmentId, clientId: C.clientId, status: "CARRIED", source: "system" } });
    // OLD: f2555f7's ranking recommended a full package on top of the carry.
    const oldTopics = (await import(base.topics)) as { executeRecommendationRun: (id: string) => Promise<void> };
    const oldRun = await prisma.contentTopicRefreshRun.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, kind: "RECOMMENDATION", monthId: C.monthId, status: "RUNNING", requestedBy: "drill-old" } });
    await oldTopics.executeRecommendationRun(oldRun.id);
    const oldRec = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: oldRun.id, kind: "RECOMMENDED" } });
    c.ok("OLD: 4 recommended for a 4-video month that already has 1 carried", oldRec.length === 4, `${oldRec.length}`);
    c.ok("OLD: the client's declined topic or an unapproved AI topic could be recommended", (await prisma.contentTopicSuggestion.count({ where: { refreshRunId: oldRun.id, relatedTopicId: { in: [declined.id, aiProposed.id] } } })) > 0);
    c.ok("OLD: the reason was staff wording only (no client line)", oldRec.every((s) => s.clientReason === null));
    await prisma.contentTopicSuggestion.updateMany({ where: { refreshRunId: oldRun.id }, data: { disposition: "SUPERSEDED" } });
    await prisma.contentTopicRefreshRun.update({ where: { id: oldRun.id }, data: { status: "CANCELLED" } });

    const r1 = await ct.startTopicRefresh({ enrollmentId: C.enrollmentId, kind: "RECOMMENDATION", requestedBy: STAFF_EMAIL, monthId: C.monthId });
    const recRows = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: r1.runId } });
    const rec = recRows.filter((s) => s.kind === "RECOMMENDED");
    c.ok("NEW: owed 4 with 1 carried → exactly 3 recommended", rec.length === 3, `${rec.length}`);
    c.ok("…plus alternatives", recRows.some((s) => s.kind === "ALTERNATIVE"));
    c.ok("…never the declined, the unapproved AI or the carried topic", !recRows.some((s) => [declined.id, aiProposed.id, carried.id].includes(s.relatedTopicId ?? "")));
    c.ok("…every one carries a plain client reason", recRows.every((s) => !!s.clientReason && !/filler|verified|signal|score/i.test(s.clientReason)), recRows.map((s) => s.clientReason).join(" | "));
    c.ok("…a goal-linked one names the goal", recRows.some((s) => /Supports your goal: Build trust with sellers before they list/.test(s.clientReason ?? "")));
    const viewC = async () => (await portal.portalTopics({ id: C.enrollmentId, clientId: C.clientId })).groups.flatMap((g) => g.topics);
    const onPage = (await viewC()).filter((t) => t.recommended?.monthId === C.monthId);
    c.ok("the client's page carries 3 RECOMMENDED for the month, each with its reason", onPage.filter((t) => t.recommended?.kind === "RECOMMENDED").length === 3 && onPage.every((t) => !!t.recommended?.reason));
    const chosen = onPage.find((t) => t.recommended?.kind === "RECOMMENDED")!;
    await ct.selectTopicForMonth(chosen.id, C.monthId, { source: "client", actor: { kind: "CLIENT", clientUserId: C.clientUserId }, status: "SELECTED" });
    const closed = await prisma.contentTopicSuggestion.findFirst({ where: { refreshRunId: r1.runId, relatedTopicId: chosen.id } });
    c.ok("choosing one marks its suggestion ACCEPTED, by the client", closed?.disposition === "ACCEPTED" && closed.dispositionBy === `client:${C.clientUserId}`, `${closed?.disposition}/${closed?.dispositionBy}`);
    const after = (await viewC()).filter((t) => t.recommended?.monthId === C.monthId);
    c.ok("…the strip now offers the 2 slots left", after.filter((t) => t.recommended?.kind === "RECOMMENDED").length === 2 && !after.some((t) => t.id === chosen.id));
    const runsBefore = await prisma.contentTopicRefreshRun.count({ where: { monthId: C.monthId, kind: "RECOMMENDATION" } });
    const a1 = await ct.autoRankMonth(C.monthId);
    const a2 = await ct.autoRankMonth(C.monthId);
    c.ok("auto-rank: the changed plan re-ranks once; unchanged, no second run", a1.ran === true && a2.ran === false && (await prisma.contentTopicRefreshRun.count({ where: { monthId: C.monthId, kind: "RECOMMENDATION" } })) === runsBefore + 1, `${a1.why} / ${a2.why}`);
    c.ok("…and the older ranking's unreviewed rows are superseded", (await prisma.contentTopicSuggestion.count({ where: { refreshRunId: r1.runId, disposition: "PENDING" } })) === 0);
    const D = await buildContentMonth(db, { name: "Full Month TEST", package: "Starter", monthKey: NEXT, topics: [{ title: "One", selection: "SELECTED" }, { title: "Two", selection: "SELECTED" }, { title: "Three" }] });
    const rD = await ct.startTopicRefresh({ enrollmentId: D.enrollmentId, kind: "RECOMMENDATION", requestedBy: STAFF_EMAIL, monthId: D.monthId });
    const runD = await prisma.contentTopicRefreshRun.findUnique({ where: { id: rD.runId } });
    c.ok("owed 2 with 2 chosen → NEEDS_INPUT, 'already full'", runD?.status === "NEEDS_INPUT" && /full/.test(runD.changeSummary ?? ""), `${runD?.status} ${runD?.changeSummary}`);
    c.ok("…and the client sees 0 slots, nothing recommended", (await ct.recommendationsForMonth(D.enrollmentId, D.monthId)).slotsLeft === 0);
    c.ok("the hourly re-rank is behind topic_refresh (off → skipped)", "skipped" in (await ct.sweepRecommendations()));

    // ======================================================================
    c.head("6.3 · staff bank controls: approve all shown, hold, release");
    // ======================================================================
    const bankRun = await prisma.contentTopicRefreshRun.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, kind: "REFRESH", status: "SUCCEEDED", requestedBy: "drill" } });
    const mkSug = (title: string) => prisma.contentTopicSuggestion.create({ data: { refreshRunId: bankRun.id, enrollmentId: C.enrollmentId, clientId: C.clientId, pillarId: cEdu.id, kind: "BANK", title, description: `${title}.`, disposition: "PENDING" } });
    const sg = [await mkSug("Open houses that sell"), await mkSug("The listing paragraph"), await mkSug("Curb appeal in a weekend")];
    const contentActions = await import("@/app/content/actions");
    const all1 = await contentActions.suggestionBulkAction(sg.map((s) => s.id), "ACCEPT");
    const approvedTopics = await prisma.contentTopic.findMany({ where: { suggestionId: { in: sg.map((s) => s.id) } } });
    c.ok("approve all shown: 3 PENDING → 3 approved bank topics", all1.ok && approvedTopics.length === 3 && approvedTopics.every((t) => t.approvalState === "APPROVED"), all1.message);
    const all2 = await ct.acceptSuggestions(sg.map((s) => s.id), STAFF_EMAIL);
    c.ok("…a second click approves 0 new", all2.accepted === 0 && all2.skipped === 3);
    const h = await mkSug("A hold-worthy idea");
    const held = await contentActions.suggestionBulkAction([h.id], "HOLD");
    c.ok("hold: out of the review queue", held.ok && !(await ct.pendingSuggestions(C.enrollmentId)).some((s) => s.id === h.id), held.message);
    c.ok("…never re-suggested by a refresh (blocked by its hash)", (await ct.blockedTopicHashes(C.enrollmentId)).has(ct.topicDedupeHash("A hold-worthy idea")));
    c.ok("…not stock, and nothing a client can reach (it is not a topic)", !(await prisma.contentTopic.findFirst({ where: { title: "A hold-worthy idea" } })) && (await ct.heldSuggestions(C.enrollmentId)).length === 1);
    const rel = await contentActions.releaseSuggestionHoldAction(h.id);
    c.ok("release: back to PENDING and off the blocked list", rel.ok && (await prisma.contentTopicSuggestion.findUnique({ where: { id: h.id } }))?.disposition === "PENDING" && !(await ct.blockedTopicHashes(C.enrollmentId)).has(ct.topicDedupeHash("A hold-worthy idea")));
    c.ok("only a waiting suggestion can be held", await ct.holdSuggestion(sg[0].id, STAFF_EMAIL).then(() => false, () => true));
    const why = await contentActions.setSuggestionReasonAction(recRows.find((s) => s.kind === "ALTERNATIVE")!.id, "  A great one for spring.  ");
    c.ok("staff can edit what the client reads beside a recommendation", why.ok && (await prisma.contentTopicSuggestion.findUnique({ where: { id: recRows.find((s) => s.kind === "ALTERNATIVE")!.id } }))?.clientReason === "A great one for spring.");

    // ======================================================================
    c.head("6.5 · questions: a call topic asks only the gaps; profile suggestions");
    // ======================================================================
    const callLine = "Every listing I took that sat past the first weekend sold for less than the one priced right from day one.";
    const E = await buildContentMonth(db, { name: "Questions Drill TEST", package: "Accelerator", monthKey: NEXT, topics: [{ title: "Pricing for the first weekend OLD", selection: "SELECTED", excerpts: [callLine] }, { title: "Pricing for the first weekend", selection: "SELECTED", excerpts: [callLine] }] });
    // The month is on the CALL route and its call was HELD (R01's reader decides).
    await prisma.programCallRecord.create({ data: { clientId: E.clientId, enrollmentId: E.enrollmentId, monthId: E.monthId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(Date.now() - 2 * 864e5), scheduledEnd: new Date(Date.now() - 2 * 864e5 + 45 * 60_000) } as never });
    const eFacts = await (await import("@/lib/planningFacts")).planningForMonth(E.monthId);
    c.ok("the fixture month reads as the CALL route with the call HELD", eFacts?.route === "CALL" && eFacts.call === "HELD", `${eFacts?.route}/${eFacts?.call}`);
    const W = await buildContentMonth(db, { name: "Written Route TEST", package: "Accelerator", monthKey: NEXT, topics: [{ title: "Pricing for the first weekend", selection: "SELECTED", excerpts: [callLine] }] });
    const wIv = await ci.getOrCreateInterview(W.topicIds[0], W.monthId, {});
    c.ok("no held call on the month: the full questionnaire (WRITTEN)", (await prisma.contentInterview.findUnique({ where: { id: wIv } }))?.sourceKind === "WRITTEN" && (await ci.interviewState(wIv)).mode === "FULL");
    const oldIv = (await import(base.interview)) as { getOrCreateInterview: (t: string, m: string, a: object) => Promise<string>; interviewState: (id: string) => Promise<{ next: { kind: string; question?: { id: string } } }> };
    const oldId = await oldIv.getOrCreateInterview(E.topicIds[0], E.monthId, {});
    const oldSt = await oldIv.interviewState(oldId);
    c.ok("OLD: a topic already talked through on a call starts the full questionnaire", (await prisma.contentInterview.findUnique({ where: { id: oldId } }))?.sourceKind === "WRITTEN" && oldSt.next.question?.id === "audienceProblem");
    const ivId = await ci.getOrCreateInterview(E.topicIds[1], E.monthId, {});
    const st = await ci.interviewState(ivId);
    c.ok("NEW: it opens as a CALL interview in GAPS_ONLY", (await prisma.contentInterview.findUnique({ where: { id: ivId } }))?.sourceKind === "CALL" && st.mode === "GAPS_ONLY");
    c.ok("…and asks for the missing talking points first, not question 1", st.next.kind === "question" && st.next.question.id === "talkingPoints", st.next.kind === "question" ? st.next.question.id : st.next.kind);
    // Profile facts: one usable, five that must never be offered.
    const fact = (body: string, o: Partial<{ confidential: boolean; aiContext: string; visibility: string; speaker: string | null; category: string; status: string }> = {}) =>
      prisma.clientFact.create({ data: { clientId: E.clientId, enrollmentId: E.enrollmentId, category: o.category ?? "DECISION", body, source: "client", scope: "PERMANENT", status: o.status ?? "ACCEPTED", aiContext: o.aiContext ?? "ALLOWED", visibility: o.visibility ?? "CLIENT", speaker: o.speaker === undefined ? null : o.speaker, confidential: o.confidential ?? false, factDate: new Date("2026-09-10T15:00:00Z") } });
    await fact("I always price for the first weekend because that is when the buyers show up.");
    await fact("Pricing for the first weekend is my secret weapon with investors.", { confidential: true });
    await fact("Pricing the first weekend matters more than any staging choice.", { aiContext: "DENIED" });
    await fact("Staff note: pricing for the first weekend comes up with this client.", { visibility: "INTERNAL" });
    await fact("[§25 acceptance fixture] Pricing for the first weekend fixture line here.");
    await fact("Between you and me, pricing for the first weekend is how I beat the other agent.");
    const sug = await ci.suggestedAnswersFor(ivId);
    const prof = sug.filter((s) => s.kind === "profile");
    c.ok("exactly one profile suggestion, with its provenance", prof.length === 1 && prof[0].provenance.source === "your profile notes" && !!prof[0].provenance.factId, prof.map((p) => p.text).join(" | "));
    c.ok("…never a confidential, AI-denied, staff-only, marked or 'between you and me' note", !sug.some((s) => /secret weapon|staging choice|Staff note|fixture|Between you/i.test(s.text)));
    const piv = await portal.portalInterview({ id: E.enrollmentId, clientId: E.clientId }, ivId);
    c.ok("the portal shows it as a profile suggestion, and the mode", !!piv && piv.mode === "GAPS_ONLY" && piv.suggestions.some((s) => s.from === "profile"));
    await ci.answerQuestion(ivId, "talkingPoints", { text: prof[0].text, kind: "TYPED", actor: { clientUserId: E.clientUserId }, suggestionId: prof[0].id });
    const ansRow = await prisma.contentInterviewAnswer.findFirst({ where: { interviewId: ivId, questionKey: "talkingPoints" }, orderBy: { version: "desc" } });
    c.ok("a profile suggestion used as is is TYPED with its source — never 'said on the call'", ansRow?.answerKind === "TYPED" && /"source":"profile"/.test(ansRow.flagsJson ?? ""), `${ansRow?.answerKind} ${ansRow?.flagsJson}`);
    await ci.answerQuestion(ivId, "talkingPoints", { text: "First, buyers read days on market. Second, a stale listing invites low offers. Finally, the right price brings competing offers.", kind: "TYPED", actor: { clientUserId: E.clientUserId } });
    const st2 = await ci.interviewState(ivId);
    c.ok("after the one missing piece: done and sufficient", st2.next.kind === "done" && st2.status === "SUFFICIENT", `${st2.next.kind}/${st2.status}`);
    const flowSrc = fs.readFileSync(path.join(REPO, "src/components/portal/InterviewFlow.tsx"), "utf8");
    c.ok("the portal's 'sent' line no longer promises an automatic new draft", !flowSrc.includes("Sent. We draft the script from these answers; changing an answer now makes a new draft") && flowSrc.includes("we&rsquo;ll see it and update the script before it reaches you"));
    // Batch-2 review: that line showed after RELEASE too ("before it reaches
    // you" — it had), and a JS string beside it carried a literal "&rsquo;"
    // (React does not decode entities in a string, so the client saw it).
    const oldFlow = execFileSync("git", ["show", `${BASE}:src/components/portal/InterviewFlow.tsx`], { cwd: REPO, encoding: "utf8" });
    const entityInString = /[?:]\s*"[^"\n]*&[a-z]+;[^"\n]*"/;
    c.ok("OLD: a JS string in the interview page carried a raw '&rsquo;' entity", entityInString.test(oldFlow));
    c.ok("NEW: no JS string carries an HTML entity (a client would see it raw)", !entityInString.test(flowSrc));
    c.ok("the 'before it reaches you' line is only for a script not yet released; a released one says how to change it", /iv\.script\.stage !== "released" && <p[^>]*>Sent\. We write the script from these answers\. If you change an answer, we&rsquo;ll see it and update the script before it reaches you\./.test(flowSrc) && /iv\.script\.stage === "released" && <p[^>]*>Sent\. Your script is written from these answers\. Changing an answer here won&rsquo;t change it: to change the script, choose Request changes on it\./.test(flowSrc));
    c.ok("…and 'we'll use the newest ones' (an automatic redraft) is no longer promised", !/use the newest ones/.test(flowSrc));

    // ======================================================================
    c.head("6.5 · drafting durability: a draft failing twice owns a task");
    // ======================================================================
    const F = await buildContentMonth(db, { name: "Draft Drill TEST", package: "Accelerator", monthKey: NEXT, topics: [{ title: "Days on market, explained", selection: "SELECTED", excerpts: ["Buyers read every extra week on market as a reason to offer less, and they are usually right."] }] });
    await approvedStrategyFor(F.enrollmentId, "Draft Drill TEST");
    await setSwitch("ai_runs", true);
    await setSwitch("script_drafting", true);
    const { draftOwedScriptsForMonth } = await import("@/lib/contentDrafting");
    const key = desk.draftFailedKey(F.topicIds[0], F.monthId);
    const aiBefore = aiCalls;
    failNextAi = 1;
    const d1 = await draftOwedScriptsForMonth(F.monthId, { requestedBy: "cron", unattended: true });
    c.ok("first failure: recorded, no task yet", d1.failed === 1 && !(await prisma.smartTask.findUnique({ where: { dedupeKey: key } })), JSON.stringify(d1.outcomes.map((o) => o.result)));
    failNextAi = 1;
    const d2 = await draftOwedScriptsForMonth(F.monthId, { requestedBy: "cron", unattended: true });
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    c.ok("second failure in a row: ONE task on the scripts owner, with the error", d2.failed === 1 && task?.status === "OPEN" && task.assignedKey === "jordan" && /unavailable/.test(task.description ?? ""), `${task?.assignedKey} ${task?.status}`);
    const d3 = await draftOwedScriptsForMonth(F.monthId, { requestedBy: "cron", unattended: true });
    c.ok("the next success drafts once and closes the task", d3.drafted === 1 && (await prisma.smartTask.findUnique({ where: { dedupeKey: key } }))?.status === "COMPLETED");
    c.ok("…three model calls in all: two failed, one drafted", aiCalls - aiBefore === 3, `${aiCalls - aiBefore}`);
    c.ok("…one script, one version — no double draft", (await prisma.contentScript.count({ where: { topicId: F.topicIds[0], monthId: F.monthId } })) === 1 && (await prisma.contentScriptVersion.count({ where: { enrollmentId: F.enrollmentId } })) === 1);
    await setSwitch("script_drafting", false);

    // ======================================================================
    c.head("6.5 · release controls: three switches; DRAFT text reaches no client surface");
    // ======================================================================
    const { AUTOMATION_KEYS, isAutomationEnabled } = await import("@/lib/programAutomation");
    const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
    c.ok("script_auto_share is its own switch, and a missing row is OFF", (AUTOMATION_KEYS as readonly string[]).includes("script_auto_share") && !(await isAutomationEnabled("script_auto_share")));
    c.ok("…with words that say what it does", AUTOMATION_EFFECTS.script_auto_share.title === "Share scripts without my approval" && AUTOMATION_EFFECTS.script_auto_share.reaches === "clients");
    const panel = fs.readFileSync(path.join(REPO, "src/components/settings/ProgramAutomationPanel.tsx"), "utf8");
    c.ok("settings: the three rows, each with its dependency", ["Draft scripts automatically", "Share scripts without my approval", "Email the client when a script is shared", "has no effect while drafting is off", "emails only what has been shared"].every((s) => panel.toLowerCase().includes(s.toLowerCase())));
    const MARK = "Quillfeather";
    const G = await buildContentMonth(db, { name: "Release Drill TEST", package: "Accelerator", monthKey: NEXT, owner: { email: "info+releasedrill@realtourpilot.com" }, topics: [{ title: "The pricing myth", selection: "SELECTED" }, { title: "Too long to share", selection: "SELECTED" }, { title: "Two points only", selection: "SELECTED" }, { title: "Jordan gets there first", selection: "SELECTED" }] });
    const gS = await approvedStrategyFor(G.enrollmentId, "Release Drill TEST");
    const gP = gS.pillars[0];
    const run = await prisma.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", status: "SUCCEEDED" } });
    const draft = async (topicIdx: number, parts: ReturnType<typeof PARTS>, extra: { interviewId?: string | null; createdBy?: string; source?: "AI" | "MANUAL" } = {}) => {
      const p = { title: ["The pricing myth", "Too long to share", "Two points only", "Jordan gets there first"][topicIdx], categoryLabel: gP.name, pillarId: gP.id, ...parts };
      return scr.createScriptVersion({ enrollmentId: G.enrollmentId, monthId: G.monthId, topicId: G.topicIds[topicIdx], parts: p, source: extra.source ?? "AI", createdBy: extra.createdBy ?? "cron", status: "INTERNAL_REVIEW", strategyVersionId: gS.strategyVersionId, aiRunId: run.id, interviewId: extra.interviewId ?? null, validation: validationOf(p) });
    };
    const gIv = await ci.getOrCreateInterview(G.topicIds[0], G.monthId, {});
    const g0 = await draft(0, PARTS(`${MARK} is the word every seller should know before listing.`), { interviewId: gIv });
    const g1 = await draft(1, { ...PARTS("Long one."), points: PARTS("x").points.map((p) => ({ ...p, text: `${p.text} ${"and that is the long version of it ".repeat(6)}` })) });
    const g2 = await draft(2, { ...PARTS("Short one."), points: PARTS("x").points.slice(0, 2) });
    const g3 = await draft(3, PARTS("Jordan will read this one first."));
    const video = await prisma.contentVideo.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, topicId: G.topicIds[0], scriptId: g0.scriptId, title: "The pricing myth", monthId: G.monthId, monthKey: G.monthKey } });
    const enrG = { id: G.enrollmentId, clientId: G.clientId };
    const viewerG = {
      enrollment: { id: G.enrollmentId, clientId: G.clientId, clientName: G.clientName, status: "ACTIVE", videosPerMonth: G.videosPerMonth, sessionsPerMonth: G.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: G.clientUserId!, email: "info+releasedrill@realtourpilot.com", name: "Release", membershipId: G.membershipId!, membershipRole: "OWNER" },
      access: "FULL", via: "LOGIN",
    } as unknown as import("@/lib/portal").PortalViewer;
    const pk = await import("@/lib/postingKit");
    const { planModel } = await import("@/lib/portalHome");
    /** EVERY surface a client reads a script through, by name. */
    const clientSurfaces = async (): Promise<Record<string, string>> => {
      const topics = await portal.portalTopics(enrG);
      const out: Record<string, string> = {
        "portalTopics (bank, month, scripts views)": JSON.stringify(topics),
        "portalTopicScript (one topic)": JSON.stringify(await portal.portalTopicScript(enrG, G.topicIds[0])),
        "portalInterview (the questions page)": JSON.stringify(await portal.portalInterview(enrG, gIv)),
        "postingKitFor (the script under a video)": JSON.stringify(await pk.postingKitFor(viewerG, (await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } })))),
        "scriptForEnrollment (the change-request gate)": JSON.stringify(await portal.scriptForEnrollment(G.enrollmentId, g0.scriptId)),
        "planModel (Home / My Plan)": JSON.stringify(planModel(topics, G.monthKey)),
        "portalRecommendations (the month strip)": JSON.stringify(await portal.portalRecommendations(enrG, G.monthId)),
      };
      return out;
    };
    const before = await clientSurfaces();
    for (const [name, payload] of Object.entries(before)) c.ok(`all OFF — ${name}: no DRAFT/INTERNAL_REVIEW text`, !payload.includes(MARK));
    const kitBefore = await pk.postingKitFor(viewerG, await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } }));
    c.ok("…the posting kit has no script at all", kitBefore.script === null);
    c.ok("…the interview says 'preparing', never the words", JSON.parse(before["portalInterview (the questions page)"]).script.stage === "preparing");
    c.ok("…and the model never saw it either (no caption drafted from it)", !prompts.some((p) => p.includes(MARK)));
    c.ok("switch OFF: the sweep does nothing", "skipped" in (await auto.sweepAutoShare({ now: new Date(Date.now() + 3 * 3_600_000) })));
    await setSwitch("script_share_email", true);
    c.ok("email ON, auto-share OFF: still nothing released", "skipped" in (await auto.sweepAutoShare({ now: new Date(Date.now() + 3 * 3_600_000) })) && (await prisma.contentScriptRelease.count({ where: { scriptId: g0.scriptId } })) === 0);
    await setSwitch("script_share_email", false);
    const later = new Date(Date.now() + 3 * 3_600_000);
    const early = new Date(Date.now() + 10 * 60_000);
    c.ok("eligibility: a clean sweep draft qualifies after the hold", (await auto.autoShareEligible(g0.versionId, { now: later })).ok);
    c.ok("…not inside the hold", (await auto.autoShareEligible(g3.versionId, { now: early })).reasons.some((r) => /hold/.test(r)));
    c.ok("…never outside the 20-30 s target", (await auto.autoShareEligible(g1.versionId, { now: later })).reasons.some((r) => /20-30 second/.test(r)));
    c.ok("…never with a blocking format finding", (await auto.autoShareEligible(g2.versionId, { now: later })).reasons.some((r) => /blocking format/.test(r)));
    // Jordan approves g3 by hand inside the hold.
    await share.shareApprovedScript(g3.versionId, { email: STAFF_EMAIL });
    await setSwitch("script_auto_share", true);
    const outboxBefore = outbox.length;
    const sw1 = await auto.sweepAutoShare({ now: later });
    const sw2 = await auto.sweepAutoShare({ now: later });
    const rels = await prisma.contentScriptRelease.findMany({ where: { scriptId: g0.scriptId } });
    c.ok("auto-share ON, email OFF: the clean draft is approved AND shared, by 'auto-share'", "shared" in sw1 && sw1.shared >= 1 && rels.filter((r) => r.action === "APPROVE").length === 1 && rels.filter((r) => r.action === "SHARE").length === 1 && rels.every((r) => r.actorEmail === "auto-share"), JSON.stringify(sw1));
    c.ok("…the notice is SUPPRESSED and no email exists", rels.find((r) => r.action === "SHARE")?.notificationState === "SUPPRESSED" && outbox.length === outboxBefore && (await prisma.programReminder.count({ where: { action: "SCRIPTS_READY" } })) === 0);
    c.ok("a second sweep: still 1 APPROVE and 1 SHARE", "shared" in sw2 && sw2.shared === 0 && (await prisma.contentScriptRelease.count({ where: { scriptId: g0.scriptId } })) === 2);
    c.ok("the long and the two-point drafts were never shared", (await prisma.contentScriptRelease.count({ where: { scriptId: { in: [g1.scriptId, g2.scriptId] } } })) === 0);
    c.ok("Jordan's approval inside the hold left the sweep nothing to do", (await prisma.contentScriptRelease.findMany({ where: { scriptId: g3.scriptId } })).every((r) => r.actorEmail === STAFF_EMAIL));
    const H = await buildContentMonth(db, { name: "Real Share Drill TEST", package: "Accelerator", monthKey: NEXT, topics: [{ title: "A real client's draft", selection: "SELECTED" }] });
    await prisma.client.update({ where: { id: H.clientId }, data: { name: "Maple Street Realty" } });
    const hS = await approvedStrategyFor(H.enrollmentId, "Maple Street Realty");
    const hp = { title: "A real client's draft", categoryLabel: hS.pillars[0].name, pillarId: hS.pillars[0].id, ...PARTS("Real clients wait for launch.") };
    const hv = await scr.createScriptVersion({ enrollmentId: H.enrollmentId, monthId: H.monthId, topicId: H.topicIds[0], parts: hp, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: hS.strategyVersionId, aiRunId: run.id, validation: validationOf(hp) });
    await auto.sweepAutoShare({ now: later });
    c.ok("testClientsOnly (default): a real client's script is never auto-shared", (await prisma.contentScriptRelease.count({ where: { scriptId: hv.scriptId } })) === 0 && (await auto.autoShareEligible(hv.versionId, { now: later })).reasons.some((r) => /testClientsOnly/.test(r)));
    {
      // Batch-2 review: the window was the OLDEST max×4 cron versions, and rows
      // that can never qualify (a cron v1 a person replaced, a real client's
      // draft under testClientsOnly) stay in it for good.
      const K = await buildContentMonth(db, { name: "Window Drill TEST", package: "Accelerator", monthKey: NEXT, owner: { email: "info+windowdrill@realtourpilot.com" }, topics: [{ title: "Window one", selection: "SELECTED" }, { title: "Window two", selection: "SELECTED" }, { title: "Window three", selection: "SELECTED" }, { title: "Window four", selection: "SELECTED" }] });
      const kS = await approvedStrategyFor(K.enrollmentId, "Window Drill TEST");
      const kp = (i: number, hook: string) => ({ title: `Window ${["one", "two", "three", "four"][i]}`, categoryLabel: kS.pillars[0].name, pillarId: kS.pillars[0].id, ...PARTS(hook) });
      for (let i = 0; i < 3; i++) {
        const v1 = await scr.createScriptVersion({ enrollmentId: K.enrollmentId, monthId: K.monthId, topicId: K.topicIds[i], parts: kp(i, "The sweep's first go at it."), source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: kS.strategyVersionId, aiRunId: run.id, validation: validationOf(kp(i, "x")) });
        await scr.editScriptVersion(v1.scriptId, kp(i, "A person rewrote the hook."), STAFF_EMAIL, "rewritten");
      }
      const E = await scr.createScriptVersion({ enrollmentId: K.enrollmentId, monthId: K.monthId, topicId: K.topicIds[3], parts: kp(3, "The first weekend decides your price, every time."), source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: kS.strategyVersionId, aiRunId: run.id, validation: validationOf(kp(3, "x")) });
      const pastHold = { status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, source: "AI", createdBy: "cron", createdAt: { lte: new Date(later.getTime() - 120 * 60_000) }, id: { not: E.versionId } };
      const allBefore = await prisma.contentScriptVersion.findMany({ where: pastHold, select: { id: true, scriptId: true, clientId: true } });
      const scriptsOf = new Map((await prisma.contentScript.findMany({ where: { id: { in: allBefore.map((v) => v.scriptId) } }, select: { id: true, currentVersionId: true, clientId: true } })).map((x) => [x.id, x]));
      const namesOf = new Map((await prisma.client.findMany({ where: { id: { in: allBefore.map((v) => v.clientId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
      const { isTestClientName } = await import("@/lib/testClients");
      const nNew = allBefore.filter((v) => scriptsOf.get(v.scriptId)?.currentVersionId === v.id && isTestClientName(namesOf.get(v.clientId))).length;
      const max = Math.floor(nNew / 4) + 1; // the new window (max×4) reaches E; the old one of the same size does not
      const oldWindow = await prisma.contentScriptVersion.findMany({ where: { status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, source: "AI", createdBy: "cron", createdAt: { lte: new Date(later.getTime() - 120 * 60_000) } }, orderBy: { createdAt: "asc" }, take: max * 4, select: { id: true } });
      c.ok(`OLD read (the oldest ${max * 4} cron versions, ${allBefore.length - nNew} of them never shareable): the eligible TEST draft was never looked at`, !oldWindow.some((v) => v.id === E.versionId) && (await auto.autoShareEligible(E.versionId, { now: later })).ok, `${oldWindow.length} in the window`);
      const swK = await auto.sweepAutoShare({ now: later, max });
      const eRels = await prisma.contentScriptRelease.findMany({ where: { scriptId: E.scriptId } });
      c.ok("NEW: the read takes only current, TEST, un-returned versions — E is shared by 'auto-share'", "shared" in swK && eRels.some((r) => r.action === "SHARE" && r.actorEmail === "auto-share"), JSON.stringify("outcomes" in swK ? swK.outcomes.map((o) => `${o.title}:${o.shared}`) : swK));
      c.ok("…and the replaced cron drafts were never candidates", "outcomes" in swK && !swK.outcomes.some((o) => o.title.startsWith("Window") && o.versionId !== E.versionId));
      // A script a person pulls back goes to the queue for a PERSON.
      await scr.returnScriptToQueue(E.scriptId, { email: STAFF_EMAIL }, "not yet");
      const back = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: E.versionId }, select: { status: true } });
      await auto.sweepAutoShare({ now: new Date(later.getTime() + 3_600_000) });
      c.ok("returned to the queue: the same cron version is INTERNAL_REVIEW again — the next sweep does NOT re-share it", back.status === "INTERNAL_REVIEW" && (await prisma.contentScriptRelease.count({ where: { scriptId: E.scriptId, action: "SHARE" } })) === 1);
      c.ok("…its preview says why", (await auto.autoShareEligible(E.versionId, { now: later })).reasons.some((r) => /returned this script to the queue/.test(r)));
    }
    await setSwitch("script_auto_share", false);
    // 6.5 script framework (no code change): the house shape is still enforced at the gate, with no override.
    const shape = await scr.approveScriptVersion(g2.versionId, { email: STAFF_EMAIL }, "approve it anyway").then(() => "approved", (e: Error) => e.message);
    c.ok("framework held: a two-point script cannot be approved even with a note", /House script format/.test(shape), shape.slice(0, 90));
    const afterShare = await clientSurfaces();
    c.ok("released now: the client reads it on their topic (the gate, not a word filter)", afterShare["portalTopics (bank, month, scripts views)"].includes(MARK));
    {
      // The posting kit's body (what Copy and Download .txt hand over) for a
      // released script with no pillar and no hook.
      const npTopic = await prisma.contentTopic.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, title: "No pillar yet", source: "staff", status: "SCRIPTED" } });
      const npScript = await prisma.contentScript.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, topicId: npTopic.id, title: "No pillar yet", body: "b", status: "APPROVED", releaseState: "released" } });
      const npVer = await prisma.contentScriptVersion.create({ data: { scriptId: npScript.id, enrollmentId: G.enrollmentId, clientId: G.clientId, versionNo: 1, title: "No pillar yet", hook: "", pointsJson: "[]", close: "Call me before you pick a price.", body: "b", source: "AI", status: "SHARED", categoryLabel: null } });
      await prisma.contentScript.update({ where: { id: npScript.id }, data: { sharedVersionId: npVer.id, approvedVersionId: npVer.id, currentVersionId: npVer.id } });
      const npVideo = await prisma.contentVideo.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, topicId: npTopic.id, scriptId: npScript.id, title: "No pillar yet", monthId: G.monthId, monthKey: G.monthKey } });
      const npKit = await pk.postingKitFor(viewerG, npVideo);
      c.ok("the posting kit's Copy / Download text carries no '(no pillar linked)' and no '(no hook)'", !!npKit.script && !/\(no pillar|\(no hook\)|\(empty\)|\(no close\)/i.test(npKit.script.body) && npKit.script.body.includes("Call me before you pick a price."), npKit.script?.body);
    }

    // ======================================================================
    c.head("6.5 · decisions attach to the exact released version (already fixed — held)");
    // ======================================================================
    const { clientApproveScript } = await import("@/lib/scriptDecisions");
    const staleTry = await clientApproveScript(viewerG, g0.scriptId, "not-the-shared-version");
    c.ok("approving a version the page did not show is refused", staleTry.ok === false);
    const okTry = await clientApproveScript(viewerG, g0.scriptId, g0.versionId);
    c.ok("approving the shared version works", okTry.ok === true, okTry.message);
    const g0v2 = await scr.editScriptVersion(g0.scriptId, { title: "The pricing myth", categoryLabel: gP.name, pillarId: gP.id, ...PARTS(`${MARK} is still the word, said better.`) }, STAFF_EMAIL, "tightened");
    await share.shareApprovedScript(g0v2.versionId, { email: STAFF_EMAIL });
    const dec = (await (await import("@/lib/scriptDecisions")).scriptDecisionsFor(G.enrollmentId, [g0.scriptId])).get(g0.scriptId);
    c.ok("changed words need a new decision: the approval is stale, the buttons are back", dec?.decision === null && dec.staleApproval === true, JSON.stringify(dec));

    // ======================================================================
    c.head("6.5 · scripts not approved before filming: 48h email, 24h Kyle task, never a cancellation");
    // ======================================================================
    const mkR = async (name: string, pkg: "Accelerator" | "Pro", appts: Date[]) => {
      const f = await buildContentMonth(db, { name, package: pkg, monthKey: "2026-11", owner: { email: `info+${name.split(" ")[0].toLowerCase()}@realtourpilot.com` }, appointments: appts.map((startAt) => ({ startAt, durationMin: 240 })), topics: [{ title: `${name}: pricing for the first weekend`, selection: "SELECTED" }, { title: `${name}: still with us`, selection: "SELECTED" }] });
      await prisma.project.update({ where: { id: f.projectId! }, data: { addressLine: "117 Kyle Lane", city: "Doylestown", state: "PA", zip: "18901" } });
      const s = await approvedStrategyFor(f.enrollmentId, name);
      const pp = { title: `${name}: pricing for the first weekend`, categoryLabel: s.pillars[0].name, pillarId: s.pillars[0].id, ...PARTS("The first weekend decides your price.") };
      const v = await scr.createScriptVersion({ enrollmentId: f.enrollmentId, monthId: f.monthId, topicId: f.topicIds[0], parts: pp, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: s.strategyVersionId, validation: validationOf(pp) });
      await share.shareApprovedScript(v.versionId, { email: STAFF_EMAIL });
      // The second topic's script is still in the team's queue.
      const pq = { title: `${name}: still with us`, categoryLabel: s.pillars[0].name, pillarId: s.pillars[0].id, ...PARTS("Still in review.") };
      await scr.createScriptVersion({ enrollmentId: f.enrollmentId, monthId: f.monthId, topicId: f.topicIds[1], parts: pq, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", strategyVersionId: s.strategyVersionId, validation: validationOf(pq) });
      return { f, v };
    };
    const R = await mkR("Rhea TEST", "Accelerator", [et(12)]);
    const R2 = await mkR("Rory TEST", "Accelerator", [et(12)]);
    const M = await mkR("Milo TEST", "Accelerator", [et(16)]);
    const P = await mkR("Pia TEST", "Pro", [et(12), et(17)]);
    const only = (ids: string[]) => ({ enrollmentIds: ids });
    const apptBefore = await prisma.appointment.findMany({ where: { projectId: { in: [R.f.projectId!, P.f.projectId!] } }, orderBy: { id: "asc" }, select: { id: true, startAt: true, status: true } });

    // reminders OFF (production today): nothing evaluated for sending, but the dry run computes it.
    const offRun = await pr.evaluateReminders({ dryRun: false, now: et(10), ...only([R.f.enrollmentId]) });
    c.ok("reminders OFF: nothing evaluated, nothing written", offRun.enabled === false && (await prisma.programReminder.count({ where: { action: "APPROVE_SCRIPTS" } })) === 0);
    const offDry = await pr.evaluateReminders({ dryRun: true, now: et(10), ...only([R.f.enrollmentId]) });
    c.ok("…the dry run still computes the candidate (would send Tue 10:00)", offDry.scriptApprovalLane.some((a) => a.decision === "send" && a.titles.length === 1));
    await setSwitch("reminders", true, JSON.stringify(pr.REMINDER_DEFAULTS));
    const monDry = await pr.evaluateReminders({ dryRun: true, now: et(9), ...only([R.f.enrollmentId]) });
    const monRow = monDry.scriptApprovalLane[0];
    c.ok("Monday: waits for Tue 10:00 ET, deadline Wed 10:00 ET", monRow?.decision === "wait" && monRow.remindAt.toISOString() === et(10).toISOString() && monRow.deadlineAt.toISOString() === et(11).toISOString(), `${monRow?.decision} ${monRow?.remindAt.toISOString()}`);
    // R2's client approves Tue 09:00, before the reminder.
    const viewerR2 = { enrollment: { id: R2.f.enrollmentId, clientId: R2.f.clientId, clientName: R2.f.clientName, status: "ACTIVE" }, actor: { kind: "CLIENT", clientUserId: R2.f.clientUserId!, membershipId: R2.f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as unknown as import("@/lib/portal").PortalViewer;
    const r2ok = await clientApproveScript(viewerR2, R2.v.scriptId, R2.v.versionId);
    c.ok("R2's client approved Tuesday morning", r2ok.ok === true, r2ok.message);
    const sentBefore = outbox.length;
    const tue = await pr.evaluateReminders({ dryRun: false, now: et(10), requestedBy: "drill", ...only([R.f.enrollmentId, R2.f.enrollmentId]) });
    const mails = outbox.slice(sentBefore).filter((m) => m.dedupeKey.includes(":APPROVE_SCRIPTS:"));
    c.ok("Tue 10:00 ET: exactly one approval email, to the client with pending scripts", mails.length === 1 && mails[0].toRef === "info+rhea@realtourpilot.com", mails.map((m) => m.toRef).join(","));
    c.ok("…naming the session, the 24h deadline and the script", !!mails[0] && mails[0].body.includes("Thursday, November 12") && mails[0].body.includes("by Wednesday, November 11 at 10:00 AM ET") && mails[0].body.includes("Rhea TEST: pricing for the first weekend"));
    {
      const ob = await import("@/lib/outbox");
      const subj = mails[0] ? ob.subjectFor(ob.outboxKind(mails[0].dedupeKey), mails[0].dedupeKey) : "";
      const oldOutbox = execFileSync("git", ["show", `${BASE}:src/lib/outbox.ts`], { cwd: REPO, encoding: "utf8" });
      c.ok("OLD: the subject had no APPROVE_SCRIPTS case (it fell to \"Let's plan your … content\")", !/APPROVE_SCRIPTS/.test(oldOutbox));
      c.ok("NEW: it goes out under 'Please approve your November scripts before filming'", subj === "Please approve your November scripts before filming", subj);
    }
    c.ok("…with the ledger row SENT under its session key", (await prisma.programReminder.findMany({ where: { action: "APPROVE_SCRIPTS", enrollmentId: R.f.enrollmentId } })).length === 1 && (await prisma.programReminder.findFirst({ where: { action: "APPROVE_SCRIPTS", enrollmentId: R.f.enrollmentId } }))?.state === "SENT");
    c.ok("R2 (approved at 09:00): suppressed, nothing written", tue.scriptApprovalLane.some((a) => a.enrollmentId === R2.f.enrollmentId && a.suppressionReason === "scripts_approved") && (await prisma.programReminder.count({ where: { action: "APPROVE_SCRIPTS", enrollmentId: R2.f.enrollmentId } })) === 0);
    const sentAgain = outbox.length;
    await pr.evaluateReminders({ dryRun: false, now: et(10, 11), requestedBy: "drill", ...only([R.f.enrollmentId]) });
    c.ok("a second pass: no duplicate row, no second email", (await prisma.programReminder.count({ where: { action: "APPROVE_SCRIPTS", enrollmentId: R.f.enrollmentId } })) === 1 && outbox.slice(sentAgain).filter((m) => m.dedupeKey.includes(":APPROVE_SCRIPTS:")).length === 0);
    const monDryM = await pr.evaluateReminders({ dryRun: true, now: et(12), ...only([M.f.enrollmentId]) });
    c.ok("a Monday session's email moves back to Friday 9:00 ET", monDryM.scriptApprovalLane[0]?.remindAt.toISOString() === et(13, 9).toISOString(), monDryM.scriptApprovalLane[0]?.remindAt.toISOString());
    // Pro: two sessions, two independent identities.
    await pr.evaluateReminders({ dryRun: false, now: et(10), requestedBy: "drill", ...only([P.f.enrollmentId]) });
    await pr.evaluateReminders({ dryRun: false, now: et(13, 10), requestedBy: "drill", ...only([P.f.enrollmentId]) });
    await pr.evaluateReminders({ dryRun: false, now: et(13, 11), requestedBy: "drill", ...only([P.f.enrollmentId]) });
    const pRows = await prisma.programReminder.findMany({ where: { action: "APPROVE_SCRIPTS", enrollmentId: P.f.enrollmentId } });
    c.ok("Pro: two sessions → two rows with two dedupe keys, no duplicates on re-runs", pRows.length === 2 && new Set(pRows.map((r) => r.dedupeKey)).size === 2, `${pRows.length}`);
    {
      // Batch-2 review: the email listed ContentScript.title — written once,
      // from the first draft — not the title of the version the client sees.
      const mv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: M.v.versionId }, select: { categoryLabel: true, pillarId: true } });
      const renamed = await scr.editScriptVersion(M.v.scriptId, { title: "Milo: the price that wins the weekend", categoryLabel: mv.categoryLabel, pillarId: mv.pillarId, ...PARTS("The first weekend decides your price.") }, STAFF_EMAIL, "renamed before sharing");
      await share.shareApprovedScript(renamed.versionId, { email: STAFF_EMAIL });
      const head = await prisma.contentScript.findUniqueOrThrow({ where: { id: M.v.scriptId }, select: { title: true } });
      const mAp = await pr.monthScriptApprovals(M.f.monthId);
      const mLane = (await pr.evaluateReminders({ dryRun: true, now: et(13, 9), ...only([M.f.enrollmentId]) })).scriptApprovalLane[0];
      c.ok("the head row still carries the first draft's title (nothing updates it)", head.title === "Milo TEST: pricing for the first weekend", head.title);
      c.ok("…but the approval list — and the email's titles — name the SHARED version", mAp.awaitingClient[0]?.title === "Milo: the price that wins the weekend" && mLane?.titles.join() === "Milo: the price that wins the weekend", `${mAp.awaitingClient[0]?.title} / ${mLane?.titles.join()}`);
    }
    {
      // Batch-2 review: a staff snooze ("no emails for two weeks") stopped the
      // planning and review lanes but not this one.
      const Sn = await mkR("Sage TEST", "Accelerator", [et(19)]);
      const unsnoozed = (await pr.evaluateReminders({ dryRun: true, now: et(17), ...only([Sn.f.enrollmentId]) })).scriptApprovalLane[0];
      c.ok("(control) unsnoozed, Tue Nov 17 10:00 ET would send", unsnoozed?.decision === "send", unsnoozed?.reason);
      await pr.snoozeMonthReminders(Sn.f.monthId, et(30), "family emergency, no emails for two weeks", STAFF_EMAIL);
      const snRow = (await pr.evaluateReminders({ dryRun: true, now: et(17), ...only([Sn.f.enrollmentId]) })).scriptApprovalLane[0];
      c.ok("snoozed: the approval email is suppressed 'snoozed' (evaluateMonth's rule)", snRow?.decision === "suppressed" && snRow.suppressionReason === "snoozed", `${snRow?.decision} ${snRow?.suppressionReason}`);
      const snSent = outbox.length;
      await pr.evaluateReminders({ dryRun: false, now: et(17), requestedBy: "drill", ...only([Sn.f.enrollmentId]) });
      c.ok("…a live pass sends nothing and writes no ledger row", outbox.length === snSent && (await prisma.programReminder.count({ where: { action: "APPROVE_SCRIPTS", enrollmentId: Sn.f.enrollmentId } })) === 0);
    }

    // The owner's bell three days out, Kyle's task at 24 hours.
    await setSwitch("reminders", false);
    const b1 = await desk.reconcileScriptApprovalTasks({ now: et(9, 11) });
    const b2 = await desk.reconcileScriptApprovalTasks({ now: et(9, 12) });
    c.ok("72h out: the scripts owner is rung once per session about scripts still with us", b1.bells >= 1 && b2.bells === 0 && (await prisma.notification.count({ where: { dedupeKey: { startsWith: "scripts-before-shoot:" } } })) === b1.bells, `${b1.bells}/${b2.bells}`);
    c.ok("…and no Kyle task yet (more than 24h out)", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: desk.SCRIPTS_UNAPPROVED_TASK_PREFIX } } })) === 0);
    const dry = await desk.reconcileScriptApprovalTasks({ now: et(11, 10, 30), dryRun: true });
    c.ok("the desk-task dry run lists what would open, and writes nothing", dry.wouldOpen.length === 3 && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: desk.SCRIPTS_UNAPPROVED_TASK_PREFIX } } })) === 0, dry.wouldOpen.join(" | "));
    const I = await buildContentMonth(db, { name: "Ivy TEST", package: "Accelerator", monthKey: "2026-11", topics: [{ title: "An imported script's topic", selection: "SELECTED" }] });
    await prisma.contentScript.create({ data: { enrollmentId: I.enrollmentId, clientId: I.clientId, monthId: I.monthId, topicId: I.topicIds[0], title: "Imported", body: "HOOK\nImported words.", status: "CLIENT_VISIBLE", historical: true, releaseState: "historical", source: "import" } });
    const ivy = await pr.monthScriptApprovals(I.monthId);
    c.ok("an imported (historical) script is not chased: nothing awaiting, nothing 'not shared'", ivy.awaitingClient.length === 0 && ivy.notShared.length === 0, JSON.stringify(ivy));
    const k1 = await desk.reconcileScriptApprovalTasks({ now: et(11, 10, 30) });
    const k2 = await desk.reconcileScriptApprovalTasks({ now: et(11, 11) });
    const rTask = await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: `${desk.SCRIPTS_UNAPPROVED_TASK_PREFIX}${R.f.monthId}:` } } });
    c.ok("24h out, reminders OFF: Kyle gets exactly one follow-up for the session", k1.opened >= 1 && k2.opened === 0 && rTask?.assignedKey === "kyle" && rTask.status === "OPEN", `${rTask?.assignedKey} ${k1.opened}/${k2.opened}`);
    c.ok("…it lists what is waiting on the client and what is not shared yet", /Waiting on the client's approval/.test(rTask?.description ?? "") && /Not shared with the client yet/.test(rTask?.description ?? "") && /nothing is cancelled or moved/.test(rTask?.description ?? ""));
    c.ok("Pro: each session is its own task", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `${desk.SCRIPTS_UNAPPROVED_TASK_PREFIX}${P.f.monthId}:` } } })) === 1, "only the Nov 12 session is inside 24h");
    const apptAfter = await prisma.appointment.findMany({ where: { projectId: { in: [R.f.projectId!, P.f.projectId!] } }, orderBy: { id: "asc" }, select: { id: true, startAt: true, status: true } });
    c.ok("no session was cancelled or moved by any of it", JSON.stringify(apptAfter) === JSON.stringify(apptBefore) && (await prisma.programSessionRequest.count({ where: { status: "CANCELLED" } })) === 0);
    // The client approves and the team shares the second script: the task closes.
    const viewerR = { enrollment: { id: R.f.enrollmentId, clientId: R.f.clientId, clientName: R.f.clientName, status: "ACTIVE" }, actor: { kind: "CLIENT", clientUserId: R.f.clientUserId!, membershipId: R.f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as unknown as import("@/lib/portal").PortalViewer;
    await clientApproveScript(viewerR, R.v.scriptId, R.v.versionId);
    const rSecond = await prisma.contentScript.findFirst({ where: { topicId: R.f.topicIds[1], monthId: R.f.monthId }, select: { currentVersionId: true, id: true } });
    await share.shareApprovedScript(rSecond!.currentVersionId!, { email: STAFF_EMAIL });
    const rSecondV = await prisma.contentScript.findUnique({ where: { id: rSecond!.id }, select: { sharedVersionId: true } });
    await clientApproveScript(viewerR, rSecond!.id, rSecondV!.sharedVersionId!);
    const k3 = await desk.reconcileScriptApprovalTasks({ now: et(11, 12) });
    c.ok("everything approved: Kyle's task closes itself", k3.closed >= 1 && (await prisma.smartTask.findUnique({ where: { id: rTask!.id } }))?.status === "COMPLETED");
    const oldDesk = execFileSync("git", ["show", `${BASE}:src/lib/programDeskTasks.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok("OLD: no desk task for unapproved scripts before a shoot existed", !/scripts-unapproved|APPROVE_SCRIPTS/.test(oldDesk));

    c.head("isolation");
    c.ok("no outbound network call was attempted", fence.blocked.length === 0, fence.blocked.join(", "));
    c.ok("every email stayed in the drill's capture, on staff-controlled addresses", outbox.every((m) => /@realtourpilot\.com$/.test(m.toRef)));
  } finally {
    quiet.restore();
    removeBaseCopies(base.dir);
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

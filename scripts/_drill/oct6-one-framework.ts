// ---------------------------------------------------------------------------
// DRILL: OCT 6 2026 — ONE VIDEO STRUCTURE FRAMEWORK FOR EVERY CLIENT (Jordan:
// "For each content strategy — the video structure framework should be the
// same for each client", with the five parts worded verbatim, the Hook now
// naming a "bold statement").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-one-framework.ts --logs <dir>
//
// Imported strategy documents are stored immutably with THEIR OWN section 4
// (S1 "Hook (0–3s) / Context / Payoff / Close", their own S3 wording, a
// "Style:" line, a "Visual and Delivery Style" block, or none at all). Every
// reader now swaps it for the house framework at read time:
//
//   1  The policy: the five parts equal Jordan's wording exactly; the Hook
//      says "bold statement" in the framework, the hook-type list, the
//      interview plan and the rules text every prompt carries.
//   2  renderStrategy (what prompts embed) prints the house framework for an
//      S3 document with its own wording, an S1 timed four-part document, a
//      "Style:" document, a "Visual and Delivery Style" document and an S2
//      document with no framework — never the document's parts, timings or
//      "Context", never the old "(framework: policy default …)" annotation;
//      a client's delivery note survives WHOLE as one "Client style notes"
//      line; Caption CTA Examples stay the client's own.
//   3  The parser: a multi-line "Style:" note and a "Visual and Delivery
//      Style" block land in framework.style, not glued onto the Close.
//   4  The staff view: a framework section's text becomes the house
//      framework + the note + the verbatim tail (idempotent, so saving an edit
//      of it stores the same); a legacy "Video Structure Framework" key is
//      recognised; an S2 strategy gets a canonical (non-editable) section 4.
//   5  The validator reports frameworkSource "house" for every document and
//      what the document itself carried, as a separate fact.
//   6  REAL STACK on an isolated DB: an S1 import is approved; approvedStrategy,
//      buildClientContext → buildScriptPrompt / buildTopicBankPrompt, and the
//      Strategy tab's loader all carry the house framework and the note.
//
// Fixtures are synthetic ("Pat Example") — no client prose enters git.
// ISOLATION: PGlite on 127.0.0.1:6890; every non-loopback call is fenced; no
// AI call is made (prompts are BUILT, never sent).
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6890;
installNextStubs();
const fence = fenceFetch();

// Jordan's message, verbatim (straight apostrophes normalised before comparing).
const JORDAN = {
  hook: "Open with a specific concern, misconception, bold statement, or surprising observation that feels immediately relevant to a buyer or seller. Give viewers a reason to keep watching.",
  tp1: "Clarify the situation and introduce the overlooked detail or consequence. Deepen the curiosity while making the topic's relevance clear.",
  tp2: "Develop the idea with a practical example, a behind-the-scenes detail, or the reasoning behind the team's approach. Each point should lead naturally to the next.",
  tp3: "Resolve the opening question and deliver a useful takeaway. Help the viewer understand what to consider, what to do next, or why the team's approach matters.",
  close: "Finish with a memorable takeaway or a relevant invitation to connect. Keep the close natural and concise, with the primary contact CTA in the caption when appropriate.",
};
const HEADINGS = ["Hook", "Talking Point 1 - Rehook", "Talking Point 2 - Build Up", "Talking Point 3 - Payoff", "Close / Call to Action"];
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

const HEAD = `Pat Example Team
2026 Social Content Strategy
Built around Trust, Value, Credibility, and Entertainment

1. Brand Overview
Core Values: Honesty, preparation, care
Brand Message: Calm guidance through a big decision.
Brand Voice: Warm, direct, a little funny
Target Audience
Primary service areas: Example County
Primary client types: Move-up sellers
Long-term positioning goal: The go-to seller advisor in Example County

2. Content Goals
• Two seller conversations a month

3. Content Pillars
Every video should build Trust through empathy and honesty, provide Value through a useful takeaway, establish Credibility through experience and clear reasoning, and create Entertainment through curiosity, storytelling, visual interest, or natural personality.
Pillar 1: Seller Strategy
Purpose: Help sellers plan.
Focus Areas: Pricing, prep
Pillar 2: Local Life
Purpose: Show the area.
Focus Areas: Parks, food
`;
const TAIL = `Caption CTA Examples
• Thinking about selling? DM me PLAN.
Strategic Direction
Lead with seller education for the first quarter.`;

const DOCS = {
  s3Own: `${HEAD}
4. Video Structure Framework
Each reel follows a five-part flow in Pat's own words.
Hook
Open with a recognizable situation Pat's neighbours run into.
Talking Point 1 - Rehook
Explain why it matters to Pat's sellers.
Talking Point 2 - Build Up
Walk through Pat's own example.
Talking Point 3 - Payoff
Land the lesson Pat wants remembered.
Close / Call to Action
Invite a call with Pat.
${TAIL}`,
  s1Timed: `${HEAD}
4. Video Structure Framework
Each reel follows a simple four-part flow:
1. Hook (0–3s): Strong and direct. Start with a frustration.
2. Context (3–10s): Clarify who this is for.
3. Payoff (10–45s): Deliver the value in Pat's voice.
4. Close (last 3–5s): Wrap with a takeaway.
Caption CTA Examples:
• DM me SELLER for a prep plan.`,
  styleLine: `${HEAD}
4. Video Structure Framework
Each video follows a clear five-part flow in Pat's natural voice.
1. Hook: Capture attention with a relatable frustration.
2. Talking Point 1 - Rehook: Clarify the overlooked detail.
3. Talking Point 2 - Build Up: Develop the story.
4. Talking Point 3 - Payoff: Deliver the answer.
5. Close / Call to action: Finish with one invitation.
Style: Usually 30–60 seconds, with a mix of direct-to-camera advice, storytelling,
street interviews and playful concepts. Keep Pat's spontaneous reactions.
${TAIL}`,
  visualStyle: `${HEAD}
4. Video Structure Framework
Each video should follow a connected five-part flow built around one clear idea.
1. Hook: Open with a visual that gives the viewer a reason to watch.
2. Talking Point 1 Rehook: Clarify the situation.
3. Talking Point 2 Build Up: Develop the idea.
4. Talking Point 3 Payoff: Answer the opening question.
5. Close or Call to Action: Finish naturally.

Visual and Delivery Style
Favor conversational direct-to-camera advice and occasional local footage.
Keep the energy natural, with no shouted delivery.
${TAIL}`,
  s2None: HEAD,
};

async function main() {
  const c = makeChecker();
  const policy = await import("@/lib/contentPolicy");
  const view = await import("@/components/content/StrategyDocView");

  // =========================================================================
  c.head("1 · the policy: Jordan's five parts, verbatim; 'bold statement' everywhere the Hook is defined");
  // =========================================================================
  {
    const fw = policy.POLICY_DEFAULT_FRAMEWORK;
    c.ok("five parts, Jordan's headings, in order", JSON.stringify(fw.parts.map((p) => p.heading)) === JSON.stringify(HEADINGS), fw.parts.map((p) => p.heading).join(" → "));
    c.ok("every definition equals Jordan's wording", [JORDAN.hook, JORDAN.tp1, JORDAN.tp2, JORDAN.tp3, JORDAN.close].every((t, i) => norm(fw.parts[i].text) === norm(t)), fw.parts.map((p) => p.text.slice(0, 30)).join(" | "));
    c.ok("the Hook says 'bold statement'", /bold statement/.test(fw.parts[0].text));
    c.ok("talking-point roles: re-hook → build-up → payoff (no 'Context', no fourth point)", JSON.stringify(fw.parts.map((p) => p.role)) === JSON.stringify([null, "re-hook", "build-up", "payoff", null]) && policy.GENERATION_POLICY.talkingPoints.count === 3);
    c.ok("the framework's hook-type entry names a bold statement", policy.HOOK_TYPES.some((h) => /misconception, bold statement, or surprising observation/.test(h.name)));
    const q = policy.INTERVIEW_QUESTION_PLAN.find((x) => x.id === "audienceProblem");
    c.ok("the interview plan's hook premise names a bold statement", !!q && /bold statement/.test(q.captures));
    const rules = policy.policyRulesText();
    c.ok("the rules text every prompt carries holds the whole framework (5 parts, the Hook's 'bold statement')", /=== VIDEO STRUCTURE FRAMEWORK/.test(rules) && HEADINGS.every((h) => rules.includes(`${h} — `)) && rules.includes(policy.FRAMEWORK_HOOK.definition));
    c.ok("the policy version was bumped with the change", policy.GENERATION_POLICY_VERSION === "2026-10-06.1");
  }

  // =========================================================================
  c.head("2 · renderStrategy: the house framework for EVERY imported document");
  // =========================================================================
  const canonicalBlock = ["4. Video Structure Framework", policy.POLICY_DEFAULT_FRAMEWORK.preamble, ...policy.POLICY_DEFAULT_FRAMEWORK.parts.flatMap((p) => ["", p.heading, p.text])].join("\n");
  const rendered: Record<string, string> = {};
  for (const [k, text] of Object.entries(DOCS)) {
    const parsed = policy.parseStrategyDocument(text);
    rendered[k] = policy.renderStrategy(parsed, { preserveSourceHeadings: true });
  }
  for (const [k, r] of Object.entries(rendered)) {
    c.ok(`${k}: section 4 is the house framework, word for word`, r.includes(canonicalBlock), r.slice(r.indexOf("4. Video"), r.indexOf("4. Video") + 200));
  }
  c.ok("no document's own part wording reaches the render (S3 own words, S1 timings / Context, 'relatable frustration', 'a visual that')",
    !/recognizable situation Pat|Explain why it matters to Pat|\(0–3s\)|\bContext\b|\(10–45s\)|relatable frustration|a visual that gives/.test(Object.values(rendered).join("\n")));
  c.ok("no document's own framework preamble either", !/in Pat's own words|simple four-part flow|clear five-part flow in Pat|should follow a connected/.test(Object.values(rendered).join("\n")));
  c.ok("no '(framework: policy default …)' annotation, even with no framework (S2)", !Object.values(rendered).some((r) => /framework: policy default/.test(r)));
  c.ok("'Style:' document: the WHOLE note as one Client style notes line",
    rendered.styleLine.includes("Client style notes: Usually 30–60 seconds, with a mix of direct-to-camera advice, storytelling, street interviews and playful concepts. Keep Pat's spontaneous reactions."), rendered.styleLine.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
  c.ok("'Visual and Delivery Style' document: its block as the Client style notes line",
    rendered.visualStyle.includes("Client style notes: Favor conversational direct-to-camera advice and occasional local footage. Keep the energy natural, with no shouted delivery."), rendered.visualStyle.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
  c.ok("documents with no delivery note carry no Client style notes line", !/Client style notes/.test(rendered.s3Own + rendered.s1Timed + rendered.s2None));
  c.ok("Caption CTA Examples and Strategic Direction stay the client's own", rendered.s3Own.includes("DM me PLAN") && rendered.s3Own.includes("Lead with seller education") && rendered.s1Timed.includes("DM me SELLER"));

  // =========================================================================
  c.head("3 · the parser keeps a delivery note whole and the Close clean");
  // =========================================================================
  {
    const mike = policy.parseStrategyDocument(DOCS.styleLine);
    const close = mike.framework?.parts.find((p) => p.key === "close");
    c.ok("a multi-line 'Style:' note is all in framework.style", /^Usually 30–60 seconds.*street interviews and playful concepts\. Keep Pat's spontaneous reactions\.$/.test(mike.framework?.style ?? ""), mike.framework?.style ?? "(null)");
    c.ok("…and none of it is glued onto the Close", close?.text === "Finish with one invitation.", close?.text);
    const jan = policy.parseStrategyDocument(DOCS.visualStyle);
    const jclose = jan.framework?.parts.find((p) => p.key === "close");
    c.ok("a 'Visual and Delivery Style' block (over two lines) is framework.style", /^Favor conversational.*no shouted delivery\.$/.test(jan.framework?.style ?? ""), jan.framework?.style ?? "(null)");
    c.ok("…and the Close is just the Close", jclose?.text === "Finish naturally.", jclose?.text);
    c.ok("the caption examples still parse after the note", (jan.captionCtaExamples?.items.length ?? 0) === 1 && (mike.captionCtaExamples?.items.length ?? 0) === 1);
    // An older stored parse glued the note's later lines onto the Close; the
    // read-time swap takes the note from the section TEXT, so it is still whole.
    const glued = { ...mike, framework: { ...mike.framework!, style: "Usually 30–60 seconds, with a mix of direct-to-camera advice, storytelling,", parts: mike.framework!.parts.map((p) => (p.key === "close" ? { ...p, text: `${p.text} street interviews and playful concepts. Keep Pat's spontaneous reactions.` } : p)) } };
    const fwText = DOCS.styleLine.slice(DOCS.styleLine.indexOf("4. Video Structure Framework\n") + "4. Video Structure Framework\n".length);
    const fixed = policy.withCanonicalFramework(glued, fwText);
    c.ok("withCanonicalFramework on an OLD glued parse: the note is whole again, the parts are the house's", /street interviews and playful concepts\. Keep Pat's spontaneous reactions\.$/.test(fixed.framework?.style ?? "") && fixed.framework?.parts.every((p, i) => p.text === policy.POLICY_DEFAULT_FRAMEWORK.parts[i].text) === true, fixed.framework?.style ?? "");
  }

  // =========================================================================
  c.head("4 · the staff view: section text, legacy keys, an S2 strategy");
  // =========================================================================
  {
    const s1Section = DOCS.s1Timed.slice(DOCS.s1Timed.indexOf("4. Video Structure Framework\n") + "4. Video Structure Framework\n".length);
    const t = policy.canonicalFrameworkSectionText(s1Section);
    c.ok("an S1 section becomes the house framework + its caption tail, verbatim", t.startsWith(policy.canonicalFrameworkText()) && t.endsWith("Caption CTA Examples:\n• DM me SELLER for a prep plan.") && !/Context|\(0–3s\)/.test(t), t);
    c.ok("idempotent — the canonical text read again is itself (saving an edit stores the same)", policy.canonicalFrameworkSectionText(t) === t);
    const styled = policy.canonicalFrameworkSectionText(DOCS.styleLine.slice(DOCS.styleLine.indexOf("4. Video Structure Framework\n") + 29));
    c.ok("a 'Style:' section keeps the note as one labelled line, then the tail", /\n\nClient style notes: Usually 30–60 seconds.*spontaneous reactions\.\n\nCaption CTA Examples\n/.test(styled) && policy.canonicalFrameworkSectionText(styled) === styled);
    const blocks = view.strategyBlocks(styled);
    c.ok("StrategyDocView: the five parts are sub-headings, the note a labelled row", HEADINGS.every((h) => blocks.some((b) => b.kind === "subheading" && b.text === h)) && blocks.some((b) => b.kind === "fields" && b.rows.some((r) => r.label === "Client style notes")));
    const legacy = policy.withCanonicalFrameworkSections([
      { id: "legacy-1", heading: "Overview", text: "x" },
      { id: "legacy-5", heading: "Video Structure Framework", text: s1Section },
    ]);
    c.ok("a legacy 'Video Structure Framework' key is recognised and swapped", legacy[1].text.startsWith(policy.canonicalFrameworkText()) && !legacy[1].canonical);
    const s2 = policy.withCanonicalFrameworkSections([
      { id: "brand-overview", heading: "1. Brand Overview", text: "a" },
      { id: "content-goals", heading: "2. Content Goals", text: "b" },
      { id: "content-pillars", heading: "3. Content Pillars", text: "c" },
    ]);
    c.ok("an S2 strategy (no framework) shows a canonical section 4 after the pillars, marked not-stored", s2.length === 4 && s2[3].id === "video-structure-framework" && s2[3].heading === "4. Video Structure Framework" && s2[3].canonical === true && s2[3].text === policy.canonicalFrameworkText());
    const single = policy.withCanonicalFrameworkSections([{ id: "document", heading: "Document", text: "free text" }]);
    c.ok("a one-block 'Document' (no numbered sections) is left alone", single.length === 1);
  }

  // =========================================================================
  c.head("5 · the validator never treats a document framework as authoritative");
  // =========================================================================
  {
    const vs = Object.entries(DOCS).map(([k, t]) => [k, policy.validateStrategyStructure(policy.parseStrategyDocument(t))] as const);
    c.ok("frameworkSource is 'house' for every document", vs.every(([, v]) => v.frameworkSource === "house"), vs.map(([k, v]) => `${k}:${v.frameworkSource}`).join(" "));
    c.ok("documentFramework says what the document carried", vs.every(([k, v]) => v.documentFramework === (k === "s2None" ? "none" : "own wording")));
    c.ok("a document with its own framework gets the 'replaced' note; none never warns", vs.every(([k, v]) => (k === "s2None" || v.findings.some((f) => f.code === "strategy.framework.replaced")) && !v.findings.some((f) => f.path?.startsWith("framework") && f.severity !== "info")));
  }

  // =========================================================================
  c.head("6 · real stack: an approved S1 import prompts and displays with the house framework");
  // =========================================================================
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const cs = await import("@/lib/contentStrategy");
    const gen = await import("@/lib/contentGeneration");
    const client = await prisma.client.create({ data: { name: "Pat Example TEST" } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Starter", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } });
    const s1Styled = DOCS.s1Timed.replace("Caption CTA Examples:", "Style: Keep it under a minute, filmed outdoors when the weather allows.\nCaption CTA Examples:");
    const imp = await cs.importStrategyVersion({ enrollmentId: e.id, text: s1Styled, fileName: "pat-example.pdf", createdBy: "drill" });
    const versionId = imp.versionId;
    const stored = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: versionId } });
    c.ok("the stored version keeps the document's own S1 framework (nothing rewritten)", /Context \(3–10s\)/.test(stored.sectionsJson) && stored.structureTemplate === "S1");
    c.ok("the import's summary names the house framework", /framework: the house framework \(the document’s own is not used\)/.test(stored.changeSummary ?? ""), stored.changeSummary ?? "");
    await cs.approveStrategyVersion(versionId, "drill");
    const ap = await cs.approvedStrategy(e.id);
    c.ok("approvedStrategy().document: the house parts, the note as style", !!ap?.document?.framework && ap.document.framework.parts.map((p) => p.text).join("|") === policy.POLICY_DEFAULT_FRAMEWORK.parts.map((p) => p.text).join("|") && ap.document.framework.style === "Keep it under a minute, filmed outdoors when the weather allows.", ap?.document?.framework?.style ?? "");
    const after = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: versionId } });
    c.ok("…and the stored sections are still byte-identical", after.sectionsJson === stored.sectionsJson);

    const built = await gen.buildClientContext(e.id);
    const topic = policy.makeTopic({ title: "Pricing in a slow month", pillarName: "Seller Strategy", clientId: client.id });
    const script = policy.buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: [], selectedOnCall: false });
    const bank = policy.buildTopicBankPrompt(built.ctx);
    for (const [name, b] of [["script prompt", script], ["topic-bank prompt", bank]] as const) {
      const all = `${b.system}\n${b.user}`;
      c.ok(`${name}: the strategy's section 4 is the house framework, word for word`, b.user.includes(canonicalBlock));
      c.ok(`${name}: the Hook definition with 'bold statement' is present`, all.includes(JORDAN.hook));
      c.ok(`${name}: none of the S1 document's framework (Context, timings, its own Hook)`, !/Context \(3|\(0–3s\)|Start with a frustration|simple four-part flow/.test(all));
      c.ok(`${name}: the client's style note rides along, labelled`, b.user.includes("Client style notes: Keep it under a minute, filmed outdoors when the weather allows."));
    }

    const { loadStrategyTab } = await import("@/app/content/[id]/programData");
    const tab = await loadStrategyTab(e.id, null);
    const fwSec = tab.versions[0]?.sections.find((s) => policy.isFrameworkSection(s));
    c.ok("the Strategy tab shows the house framework + the note + the caption tail for this S1 import",
      !!fwSec && fwSec.text.startsWith(policy.canonicalFrameworkText()) && fwSec.text.includes("Client style notes: Keep it under a minute") && fwSec.text.includes("DM me SELLER") && !/Context|\(0–3s\)/.test(fwSec.text), fwSec?.text.slice(0, 120));
  } finally {
    c.ok("fence: nothing left the machine", fence.blocked.length === 0, fence.blocked.join(" | "));
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

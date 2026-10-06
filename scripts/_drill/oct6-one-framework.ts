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
//   7  (Oct 6 2026, Jordan: "Yes") client-specific direction written INSIDE a
//      document's own framework parts — a do/don't, a voice descriptor, a
//      place, "show <client> …", genuinely new wording — is carried into the
//      Client style notes; generic restatements of a hook / talking point /
//      close (even with the client's name swapped in) are not; no duration
//      ever reaches the notes ("Usually 30–60 seconds", "under a minute").
//   8  (Oct 6 2026, Jordan: "between 30-50 seconds long, sometimes a minute")
//      the length target is 30–50 s, the heuristic and the part budgets are
//      recomputed from the 2.2 words/s rate, the timing finding is a soft
//      warning only under 25 s / over 65 s, and no prompt or policy text
//      states the superseded 20–30 s.
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
  // Pat's own S3 wording: generic definitions with Pat's name swapped in, plus
  // ONE client-specific sentence in the preamble (the "Show <client> …" shape).
  s3Own: `${HEAD}
4. Video Structure Framework
Each reel follows a connected five-part flow, built around one clear idea. Show Pat walking the
house or talking with a neighbour whenever the topic allows.
Hook
Open with a specific concern, recognizable situation, or overlooked detail that feels immediately
relevant to a homeowner. Give viewers a reason to keep watching.
Talking Point 1 - Rehook
Clarify the situation and explain why it matters.
Talking Point 2 - Build Up
Develop the idea with a real example, a visible detail, or the reasoning behind Pat's approach.
Talking Point 3 - Payoff
Show what the viewer should understand, consider, or do differently because of Pat's guidance.
Close / Call to Action
Finish with a memorable takeaway or a relevant invitation to connect.
${TAIL}`,
  // Every sentence generic (house wording with the name swapped in) → no notes at all.
  genericOwn: `${HEAD}
4. Video Structure Framework
Each reel follows a connected five-part flow, built around one clear idea.
Hook
Open with a specific concern, misconception, or surprising observation that feels immediately relevant to a buyer or seller.
Talking Point 1 - Rehook
Clarify the situation and introduce the overlooked detail or consequence.
Talking Point 2 - Build Up
Develop the idea through a practical example, a client experience, or the reasoning behind Pat's approach.
Talking Point 3 - Payoff
Resolve the opening question and deliver a useful takeaway.
Close / Call to Action
Finish with a memorable takeaway or a relevant invitation to connect.
${TAIL}`,
  s1Timed: `${HEAD}
4. Video Structure Framework
Each reel follows a simple four-part flow:
1. Hook (0–3s): Strong, direct, and attention-grabbing. No props, no dancing, and no forced
trends. Start with a frustration.
2. Context (3–10s): Clarify who this is for.
3. Payoff (10–45s): Deliver the value in Pat's voice: calm, dry, and a little funny. Keep it
practical, structured, and easy to follow.
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
    c.ok("the policy version was bumped with the change (length + carried direction)", policy.GENERATION_POLICY_VERSION === "2026-10-06.2");
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
  c.ok("no document's own GENERIC part wording reaches the render (name-swapped definitions, S1 timings / Context, 'relatable frustration', 'a visual that')",
    !/recognizable situation, or overlooked|reasoning behind Pat's approach|because of Pat's guidance|Pat's approach|\(0–3s\)|\bContext\b|\(10–45s\)|relatable frustration|a visual that gives|Start with a frustration|Strong, direct, and attention-grabbing|practical, structured, and easy to follow/.test(Object.values(rendered).join("\n")));
  c.ok("no document's own framework preamble either", !/simple four-part flow|clear five-part flow in Pat|should follow a connected/.test(Object.values(rendered).join("\n")));
  c.ok("no '(framework: policy default …)' annotation, even with no framework (S2)", !Object.values(rendered).some((r) => /framework: policy default/.test(r)));
  c.ok("'Style:' document: the note as one Client style notes line, its duration removed",
    rendered.styleLine.includes("Client style notes: A mix of direct-to-camera advice, storytelling, street interviews and playful concepts. Keep Pat's spontaneous reactions.") && !/30–60|seconds/.test(rendered.styleLine), rendered.styleLine.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
  c.ok("'Visual and Delivery Style' document: its block as the Client style notes line",
    rendered.visualStyle.includes("Client style notes: Favor conversational direct-to-camera advice and occasional local footage. Keep the energy natural, with no shouted delivery."), rendered.visualStyle.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
  c.ok("documents with no client-specific direction carry no Client style notes line", !/Client style notes/.test(rendered.genericOwn + rendered.s2None));
  c.ok("S3 own wording: only the client-specific preamble sentence becomes a note",
    rendered.s3Own.includes("Client style notes: Show Pat walking the house or talking with a neighbour whenever the topic allows.\n"), rendered.s3Own.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
  c.ok("S1 timed: the do/don't and the voice descriptor become notes, no timing, no generic S1 line",
    rendered.s1Timed.includes("Client style notes: No props, no dancing, and no forced trends. Deliver the value in Pat's voice: calm, dry, and a little funny.\n"), rendered.s1Timed.split("\n").find((l) => /style notes/i.test(l)) ?? "(none)");
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
    c.ok("a 'Style:' section keeps the note as one labelled line (no duration), then the tail", /\n\nClient style notes: A mix of direct-to-camera advice.*spontaneous reactions\.\n\nCaption CTA Examples\n/.test(styled) && policy.canonicalFrameworkSectionText(styled) === styled, styled.slice(styled.indexOf("Client style")));
    const s1Notes = policy.canonicalFrameworkSectionText(s1Section);
    c.ok("an S1 section's carried direction is one labelled line before the tail, and idempotent", s1Notes.includes("\n\nClient style notes: No props, no dancing, and no forced trends. Deliver the value in Pat's voice: calm, dry, and a little funny.\n\nCaption CTA Examples:") && policy.canonicalFrameworkSectionText(s1Notes) === s1Notes);
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
    const s1v = vs.find(([k]) => k === "s1Timed")![1];
    const note = s1v.findings.find((f) => f.code === "strategy.framework.style-note");
    c.ok("the style-note finding names the carried direction and states no length target", !!note && note.severity === "info" && /No props/.test(note.message) && !/20–30|30–50/.test(note.message), note?.message);
    c.ok("a document with its own framework gets the 'replaced' note; none never warns", vs.every(([k, v]) => (k === "s2None" || v.findings.some((f) => f.code === "strategy.framework.replaced")) && !v.findings.some((f) => f.path?.startsWith("framework") && f.severity !== "info")));
  }

  // =========================================================================
  c.head("7 · client-specific direction inside a document's own parts is kept; generic wording and durations are not");
  // =========================================================================
  {
    const names = ["Pat"];
    const cls = (s: string) => policy.classifyFrameworkSentence(s, names);
    // Shapes measured in the Oct 6 2026 probe of every active client's latest
    // strategy (synthetic wording, the client is "Pat Example").
    const keep: [string, string][] = [
      ["a do/don't inside an S1 Hook", "No gimmicks, no dancing, and no forced trends."],
      ["what to show, in a preamble", "Show Pat making a decision, explaining a situation, or interacting with someone whenever the topic allows."],
      ["an S1 Payoff's voice descriptor (colon)", "Deliver the value clearly and confidently in Pat's voice: smart, witty, direct, and educational."],
      ["…and in parentheses", "Deliver the value clearly and confidently in Pat's voice (fun, honest, super knowledgeable)."],
      ["a place-specific audience", "Make the situation feel specific to the Example County market and to the client type Pat wants to attract."],
      ["genuinely new wording about the client's delivery", "This gives filming structure while leaving room for Pat's own wording and reactions."],
      ["a positioning message in a Close", "The close should leave the viewer feeling that the process can be simpler, more strategic, and lower stress with the right agent."],
    ];
    for (const [what, s] of keep) { const v = cls(s); c.ok(`KEEP ${what}`, v.kept === s, `${v.reason} → ${v.kept}`); }
    const drop: [string, string][] = [
      ["the house Hook definition", policy.FRAMEWORK_HOOK.definition.split(". ")[0] + "."],
      ["a house definition with the client's name swapped in", "Develop the idea with a practical example, a behind-the-scenes detail, or the reasoning behind Pat's approach."],
      ["…a reworded one", "Show what the viewer should understand, consider, or do differently because of Pat's guidance."],
      ["…the client named as the subject of a generic line", "Show what is at stake, what Pat considers, and why the decision matters."],
      ["the S1 template's Hook line", "Strong, direct, and attention-grabbing."],
      ["the S1 template's Payoff line", "Keep it practical, structured, and easy to follow."],
      ["the S1 template's Close line", "Keep the primary CTA in the caption."],
      ["a generic voice mention without a descriptor", "Give viewers a reason to keep watching while staying natural to Pat's voice."],
      ["an S1 preamble", "Each reel follows a simple four-part flow:"],
    ];
    for (const [what, s] of drop) { const v = cls(s); c.ok(`drop ${what}`, v.kept === null, `${v.reason}`); }
    // "What's" in the caption tail must not make "What" a name — or "Show what …" would read as "show <client>".
    const contraction = policy.explainFrameworkDirection("Talking Point 2 - Build Up\nShow what is at stake, what Pat considers, and why Pat's approach matters.\nCaption CTA Examples\n• Let's talk. What's next?");
    c.ok("a contraction (\"Let's\", \"What's\") is never taken for the client's name", contraction.length === 1 && contraction[0].kept === null, JSON.stringify(contraction));

    // Durations never travel.
    const dur: [string, string | null][] = [
      ["Usually 30–60 seconds, with a mix of direct-to-camera advice and street interviews.", "A mix of direct-to-camera advice and street interviews."],
      ["Keep it under a minute, filmed outdoors when the weather allows.", "Filmed outdoors when the weather allows."],
      ["Keep videos under 45 seconds.", null],
      ["Deliver the value (10–45s) in Pat's voice: calm and direct.", "Deliver the value in Pat's voice: calm and direct."],
      ["A 30-second tour of the kitchen works best.", "A tour of the kitchen works best."],
      ["No gimmicks, no dancing, and no forced trends.", "No gimmicks, no dancing, and no forced trends."],
    ];
    for (const [inp, want] of dur) { const got = policy.stripDurationPhrases(inp); c.ok(`durations stripped: “${inp}”`, got === want, String(got)); }
    const timedNote = policy.frameworkStyleNotesFromText("1. Hook (0–3s): No gimmicks, no dancing.\n2. Payoff (10–45s): Deliver the value in Pat's voice: calm.\nStyle: Usually 30–60 seconds, with a mix of street interviews.\nCaption CTA Examples\n• DM me.");
    c.ok("notes from an S1 section: direction in order, then the style note — no timing anywhere", timedNote === "No gimmicks, no dancing. Deliver the value in Pat's voice: calm. A mix of street interviews.", String(timedNote));
    c.ok("a style note that is ONLY a duration leaves no notes", policy.frameworkStyleNotesFromText("Hook\nOpen with a specific concern.\nStyle: Usually 30–60 seconds.") === null);
    // Text path and parsed-document path agree.
    for (const k of ["s3Own", "s1Timed", "styleLine", "visualStyle", "genericOwn"] as const) {
      const doc = DOCS[k];
      const sec = doc.slice(doc.indexOf("4. Video Structure Framework\n") + "4. Video Structure Framework\n".length);
      const a = policy.frameworkStyleNotesFromText(sec), b = policy.frameworkStyleNotesFromDocument(policy.parseStrategyDocument(doc).framework);
      c.ok(`${k}: the section-text path and the parsed-document path give the same notes`, a === b, `${a} ≠ ${b}`);
    }
  }

  // =========================================================================
  c.head("8 · length: 30–50 s target, soft warning only under 25 s / over 65 s, no 20–30 anywhere");
  // =========================================================================
  {
    const t = policy.GENERATION_POLICY.timing;
    c.ok("target 30–50 s (Jordan, Oct 6 2026)", t.targetSec[0] === 30 && t.targetSec[1] === 50);
    c.ok("warn only under 25 s or over 65 s", t.warnBelowSec === 25 && t.warnAboveSec === 65);
    c.ok("the word heuristic is the target × the existing 2.2 words/s (66–110)", t.wordsPerSec === 2.2 && t.heuristicWords[0] === Math.round(30 * 2.2) && t.heuristicWords[1] === Math.round(50 * 2.2), JSON.stringify(t.heuristicWords));
    const B = policy.SCRIPT_PART_BUDGETS;
    c.ok("the part budgets sum to the heuristic's ceiling (a full draft lands inside 50 s)", B.hookWords + 3 * B.pointWords + B.closeWords === t.heuristicWords[1], JSON.stringify(B));
    const rules = policy.policyRulesText();
    const topic = policy.makeTopic({ title: "Pricing in a slow month", pillarName: "Seller Strategy", clientId: "c1" });
    const ctx = { clientId: "c1", clientName: "Pat Example", strategy: null, priorScripts: [{ title: "Old one", monthKey: "2026-01", text: "HOOK\nx" }] } as unknown as Parameters<typeof policy.buildScriptPrompt>[0];
    let prompt = "";
    try { const b = policy.buildScriptPrompt(ctx, { path: "transcript", topic, excerpts: [], selectedOnCall: false }); prompt = `${b.system}\n${b.user}`; } catch (e) { prompt = `ERR ${(e as Error).message}`; }
    const stale = /20\s*(?:–|-|to)\s*30|45\s*(?:–|-)\s*65/;
    c.ok("the rules text every prompt carries says 30–50 and never 20–30 / 45–65", rules.includes("30–50 seconds") && rules.includes("30 to 50 second") && !stale.test(rules), (rules.match(stale) ?? [""])[0]);
    c.ok("the script prompt (system + user, prior-scripts line included) says 30–50 and never 20–30", !prompt.startsWith("ERR") && prompt.includes("30–50") && /exactly three points, 30–50 s/.test(prompt) && !stale.test(prompt), prompt.startsWith("ERR") ? prompt : (prompt.match(stale) ?? [""])[0]);
    c.ok("the LENGTH override quotes Jordan's Oct 6 words", policy.POLICY_OVERRIDES.some((o) => o.startsWith("LENGTH:") && o.includes("between 30-50 seconds long, sometimes a minute")));

    const mk = (total: number) => {
      const w = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "Sellers" : "word")).join(" ") + ".";
      const per = Math.round((total - 20) / 3);
      return policy.scriptFromGeneratorOutput({ title: "Length probe", category: "Seller Strategy", hook: w(10), points: [{ role: "re-hook", text: w(per) }, { role: "build-up", text: w(per) }, { role: "payoff", text: w(total - 20 - 2 * per) }], close: w(10), captionCta: null, filmingNotes: null, contentPillarCheck: null, sourceExcerpts: [], gaps: [] } as unknown as Parameters<typeof policy.scriptFromGeneratorOutput>[0], null, "c1");
    };
    const at = (words: number) => { const v = policy.validateNewScript(mk(words), { requirePillar: false }); return { v, f: v.findings.filter((f) => f.code === "timing.out-of-range") }; };
    const s40 = at(88), s55 = at(121), s70 = at(154), s20 = at(44);
    c.ok("≈40 s: inside the target, no timing finding", s40.v.estimate.seconds === 40 && s40.v.estimate.inTarget && s40.f.length === 0, `${s40.v.estimate.seconds}s`);
    c.ok("≈55 s ('sometimes a minute'): outside the target, NOT nagged", s55.v.estimate.seconds === 55 && !s55.v.estimate.inTarget && s55.v.estimate.withinTolerance && s55.f.length === 0, `${s55.v.estimate.seconds}s`);
    c.ok("≈70 s: one soft WARNING, never a block — the script still passes", s70.v.estimate.seconds === 70 && s70.f.length === 1 && s70.f[0].severity === "warn" && s70.v.ok, s70.f[0]?.message);
    c.ok("…its words name the 30–50 s target and that about a minute is fine", /30–50 s/.test(s70.f[0]?.message ?? "") && /about a minute is fine/.test(s70.f[0]?.message ?? "") && !stale.test(s70.f[0]?.message ?? ""));
    c.ok("≈20 s: a soft warning (clearly short), never a block", s20.v.estimate.seconds === 20 && s20.f.length === 1 && s20.f[0].severity === "warn" && s20.v.ok, s20.f[0]?.message);
    const edge = [at(55), at(143)];
    c.ok("the edges are inclusive: 25 s and 65 s raise nothing", edge.every((e) => e.f.length === 0), edge.map((e) => e.v.estimate.seconds).join(","));
    const ti = policy.tightenInstruction({ seconds: 70, words: 154, wordsPerSec: t.wordsPerSec, target: t.targetSec });
    c.ok("the one-click Tighten aims at 30–50 s / 110 words", /30–50 second target/.test(ti) && /at or under 110 words/.test(ti), ti.slice(0, 160));
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
    const S1_NOTES = "No props, no dancing, and no forced trends. Deliver the value in Pat's voice: calm, dry, and a little funny. Filmed outdoors when the weather allows.";
    const s1Styled = DOCS.s1Timed.replace("Caption CTA Examples:", "Style: Keep it under a minute, filmed outdoors when the weather allows.\nCaption CTA Examples:");
    const imp = await cs.importStrategyVersion({ enrollmentId: e.id, text: s1Styled, fileName: "pat-example.pdf", createdBy: "drill" });
    const versionId = imp.versionId;
    const stored = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: versionId } });
    c.ok("the stored version keeps the document's own S1 framework (nothing rewritten)", /Context \(3–10s\)/.test(stored.sectionsJson) && stored.structureTemplate === "S1");
    c.ok("the import's summary names the house framework", /framework: the house framework \(the document’s own is not used\)/.test(stored.changeSummary ?? ""), stored.changeSummary ?? "");
    await cs.approveStrategyVersion(versionId, "drill");
    const ap = await cs.approvedStrategy(e.id);
    c.ok("approvedStrategy().document: the house parts, the note as style", !!ap?.document?.framework && ap.document.framework.parts.map((p) => p.text).join("|") === policy.POLICY_DEFAULT_FRAMEWORK.parts.map((p) => p.text).join("|") && ap.document.framework.style === S1_NOTES, ap?.document?.framework?.style ?? "");
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
      c.ok(`${name}: the client's direction + style note ride along, labelled, with no duration`, b.user.includes(`Client style notes: ${S1_NOTES}`) && !/under a minute/.test(b.user));
    }

    const { loadStrategyTab } = await import("@/app/content/[id]/programData");
    const tab = await loadStrategyTab(e.id, null);
    const fwSec = tab.versions[0]?.sections.find((s) => policy.isFrameworkSection(s));
    c.ok("the Strategy tab shows the house framework + the note + the caption tail for this S1 import",
      !!fwSec && fwSec.text.startsWith(policy.canonicalFrameworkText()) && fwSec.text.includes(`Client style notes: ${S1_NOTES}`) && fwSec.text.includes("DM me SELLER") && !/Context|\(0–3s\)/.test(fwSec.text), fwSec?.text.slice(0, 120));
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

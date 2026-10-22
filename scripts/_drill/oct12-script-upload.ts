// ---------------------------------------------------------------------------
// DRILL: "Upload this month's scripts" (Oct 12 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-script-upload.ts
//
// Jordan, Oct 12: "a spot where I can manually upload the scripts for the
// month in case I scripted them manually. Then it is analyzed and sets the
// topics for that month, and then adds the scripts for that month as well —
// then it allows the agent to view, review, approve them or request revisions
// on the scripts with a spot to say what they want revised and then to submit."
//
//   §1 the reader: house labels, shorthand ("TP1 Rehook", "Close-CTA",
//      "**Hook:**", "Pillar:", "Script 2" + title below, bare Build up), loose
//      titles, four points kept four, no spoken word lost.
//   §2 who may: signed out, an editor, a photographer and an owner's "view
//      as" are refused at preview, AI split, confirm, send and undo.
//   §3 preview from a real .docx (4 scripts): titles, a bank topic matched
//      exactly, this month's own pick matched, pillars, the 4-point script
//      flagged, the earlier pick offered for replacing — and nothing written.
//   §4 confirm: the month's topics (upload order first), live MANUAL scripts
//      "Written by Jordan" in the review queue, the ledger, the month planned
//      by the office (written route, stamped office:), script approval next;
//      no reminder asks for a call or answers; the client sees nothing yet and
//      their month reads "We planned this month's videos for you".
//   §5 the same document twice is refused (no double upload).
//   §6 undo before release: scripts and new topics gone, every pick and the
//      route back exactly as they were; the same file uploads again after.
//   §7 counts vs owed: 5 for 4 → one extra (kept, waits its turn); 3 for 4 →
//      one slot open; pasted text works.
//   §8 send: approve + release through the one share (email suppressed), the
//      4-point one held back with its reason, undo now refused; fixed, it
//      goes too; all approved → the month is ready for filming per the gate.
//   §9 the portal: released scripts only, read in full; approve one; request
//      changes with a note → the office's queue + the bell; all approved →
//      "All 4 scripts approved".
//   §10 a messy document (no labels): the AI reads it straight away on upload
//       (attended, logged, words checked against the document); "Let AI read
//       it" on the same document reuses that reading.
//   §11 a month whose strategy call is booked keeps its call.
//
// Jordan, Oct 12 (Joe Sutow's PDF): "his are written in a different way, and
// the upload does not accept PDFs … AI should analyze the upload and upload it
// as written. Also, a Pillar should automatically be assigned based on the
// context of the script. I should be able to change it, though."
//   §12 a skit PDF, read where production has no canvas module (the live
//       site refused every PDF: "DOMMatrix is not defined"): the AI files each
//       script's own lines into the five parts — multi-scene build up and a
//       second re-hook in Build up, speaker labels inline ("ALEX (HOST): …"),
//       [directions] and [CUT] cues kept, headings without dashes, the
//       document's curly quotes back — the title is the script's name, the
//       structure check passes, the length is spoken lines only; a dropped
//       line is flagged word for word; the pillar comes from the APPROVED
//       strategy that has no pillar records (Joe's case), with a reason; the
//       staff changes one; Add makes the pillars and files the scripts; the
//       versions keep speakers/directions, no dash; the portal and the
//       editor's brief read the scene; a hand edit keeps it all.
//   §13 the same document again reuses the AI's reading (no second call).
//   §14 the AI is down: the parser's own skit reading, with a plain note.
//   §15 pillars from a draft strategy (kept as a label) and no pillars at all
//       (said plainly; added without one).
//   §16 nothing sent, nothing left the machine.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened;
// every non-loopback call is fenced; the model is stubbed at aiJsonWithUsage
// and the outbox's sendThroughOutbox is captured. THE CLOCK IS PINNED to
// Mon Oct 12 2026 10:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5663);
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 12, 14, 0, 0); // Mon Oct 12 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const now = () => new RealDate(RealDate.now() + offset);

installNextStubs();
const fence = fenceFetch();

// ---- the model boundary ----------------------------------------------------
// The AS-WRITTEN reading's answer (scriptUploadAi), by document. The skit
// answer is written the way a model really answers: straight quotes for the
// document's curly ones, a label with its dash, a scene heading and a cue
// unbracketed, a stray "PAYOFF" label inside the payoff — and, on script 2,
// one line dropped and one word added, which the word check must catch.
let aiCalls = 0;
let aiPrompt = "";
let aiDown = false;
const pillarList = (prompt: string) => (prompt.split("THE DOCUMENT:")[0].match(/^\d+\. ([^|\n]+?)(?: \||$)/gm) ?? []).map((l) => l.replace(/^\d+\. /, "").replace(/ \|$/, "").trim());
const pick = (prompt: string, want: RegExp, at: number) => { const l = pillarList(prompt); return l.find((n) => want.test(n)) ?? l[at] ?? l[0] ?? null; };
const SCRIPT_FIELDS = { purpose: null, topic: null, dimensions: null, category: null, speakers: [] as string[], caption: null, leftOut: null, pillar: null, pillarWhy: null };
function skitAnswer(prompt: string) {
  const p1 = pick(prompt, /personal brand/i, 0), p2 = pick(prompt, /seller/i, 1);
  return {
    scripts: [
      {
        ...SCRIPT_FIELDS,
        title: "THE OPEN HOUSE INTERVIEW",
        purpose: "Use a sideline-reporter parody to show that a strong open house comes from preparation, pricing, and follow-up, not luck.",
        dimensions: "Credibility + Entertainment | Trust + Value",
        speakers: ["ALEX — HOST", "DANA", "ALEX", "DANA — TO CAMERA"],
        hook: 'ALEX — HOST: "Dana, huge crowd out there today. What\'s the secret?"\n[Dana is in a referee jersey. Dead serious.]',
        rehook: 'DANA: "Honestly, it starts long before the doors open."\n"We priced it where buyers could see the value."\n[Pause.]\n"Everything else follows."',
        buildUp: 'BUILD UP — SCENE 1: THE PREP\n[Dana walks the kitchen with a clipboard.]\nDANA: "Fresh paint, bright bulbs — nothing on the counters."\nCUT TO ALEX REACTION\n[Impressed nod.]\nBUILD UP — SCENE 2: THE CROWD\nALEX: "And the people?"\nDANA: "We told every neighbor first. Neighbors know buyers."\n[SECOND REHOOK]\n[Crowd noise rises.]\nDANA: "But here\'s what most agents miss."\n"The follow-up after the open house is where the offers come from."',
        payoff: 'PAYOFF\nDANA — TO CAMERA: "Prepare the house, price it right, and follow up the same day."\n[Dana nods.]',
        close: 'DANA: "Thinking about selling this spring? Let\'s talk before you pick a price."\n[Walks off, then turns back.]\n"And bring snacks."',
        pillar: p1, pillarWhy: p1 ? "A parody skit built on humor that shows how Dana works." : null,
      },
      {
        ...SCRIPT_FIELDS,
        title: "THE PRICE IS WRONG AND THE BUYERS KNOW IT BEFORE YOU DO",
        topic: "Why overpricing costs you more than it saves.",
        dimensions: "Value + Credibility | Trust + Entertainment",
        speakers: ["DANA"],
        hook: '[Game show lights. Dana stands behind a podium.]\nDANA: "Contestant number one, come on down… and lower your price."',
        rehook: 'DANA: "Overpriced homes sit, and sitting homes get cheaper."',
        buildUp: 'DANA: "Buyers really compare every listing against the ones they can afford."',
        payoff: 'DANA: "Price it where buyers compete, and they push the price up for you."',
        close: 'DANA: "Want the real number for your home? Message me today."',
        pillar: p2, pillarWhy: p2 ? "It teaches sellers how pricing decides the offers." : null,
      },
    ],
  };
}
function messyAnswer() {
  return {
    scripts: [
      { ...SCRIPT_FIELDS, title: "first weekend pricing", hook: "so the first weekend decides your price and most sellers miss it.", rehook: "buyers read every week on market as a signal.", buildUp: "a stale listing invites low offers.", payoff: "price it right on day one and buyers compete.", close: "call me before you pick a price." },
      // Two words the document never said — the word check must flag them.
      { ...SCRIPT_FIELDS, title: "repairs", hook: "not every repair pays you back, honestly.", rehook: "some fixes cost more than they return.", buildUp: "paint and lighting usually pay, absolutely.", payoff: "spend where buyers look first.", close: "ask me for my checklist." },
    ],
  };
}
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        aiPrompt = opts.prompt;
        if (aiDown) throw new Error("Anthropic 529: Overloaded");
        const result = /OPEN HOUSE INTERVIEW/.test(opts.prompt) ? skitAnswer(opts.prompt) : messyAnswer();
        return { result, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "drill-stub" };
      };
    },
  }),
);

// ---- the outbox boundary: nothing leaves ------------------------------------
const outbox: string[] = [];
interceptModule(
  (r) => r === "@/lib/outbox",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "sendThroughOutbox") return t[k];
      return async (msg: { dedupeKey: string }) => { outbox.push(msg.dedupeKey); return { outcome: "accepted", id: `drill-${outbox.length}`, providerId: `drill-${outbox.length}` }; };
    },
  }),
);

// ---- a real .docx -------------------------------------------------------------
async function docx(lines: string[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = lines.map((l) => `<w:p><w:r>${/^(Hook|TP\d|Close|Script)/.test(l) ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---- a real PDF (pdf-lib, in package.json) ------------------------------------
async function pdf(pages: string[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((l, i) => { if (l) page.drawText(l, { x: 54, y: 740 - i * 14, size: 10, font }); });
  }
  return Buffer.from(await doc.save());
}

// Modelled on Joe Sutow's October PDF (Oct 12): numbered skit scripts with
// Purpose / Topic / "Pillars:" (the quality dimensions) lines, HOOK / REHOOK /
// BUILD UP scenes / SECOND REHOOK / PAYOFF / CLOSE, speaker labels on their
// own line (one with a dash), [directions], a CUT cue, a line the PDF wraps,
// a wrapped capitalised title, a spoken em dash, two pages.
const SKIT_PAGE_1 = [
  "1. THE OPEN HOUSE INTERVIEW",
  "Purpose: Use a sideline-reporter parody to show that a strong open house comes from preparation,",
  "pricing, and follow-up, not luck.",
  "Pillars: Credibility + Entertainment | Trust + Value",
  "HOOK",
  "ALEX — HOST",
  "“Dana, huge crowd out there today. What's the secret?”",
  "[Dana is in a referee jersey. Dead serious.]",
  "REHOOK",
  "DANA",
  "“Honestly, it starts long before the doors open.”",
  "“We priced it where buyers could see the value.”",
  "[Pause.]",
  "“Everything else follows.”",
  "BUILD UP — SCENE 1: THE PREP",
  "[Dana walks the kitchen with a clipboard.]",
  "DANA",
  "“Fresh paint, bright bulbs — nothing on the counters.”",
  "CUT TO ALEX REACTION",
  "Impressed nod.",
  "BUILD UP — SCENE 2: THE CROWD",
  "ALEX",
  "“And the people?”",
  "DANA",
  "“We told every neighbor first. Neighbors know buyers.”",
  "SECOND REHOOK",
  "[Crowd noise rises.]",
  "DANA",
  "“But here's what most agents miss.”",
  "“The follow-up after the open house is where the offers",
  "come from.”",
  "PAYOFF",
  "DANA — TO CAMERA",
  "“Prepare the house, price it right, and follow up the same day.”",
  "[Dana nods.]",
  "CLOSE",
  "DANA",
  "“Thinking about selling this spring? Let's talk before you pick a price.”",
  "[Walks off, then turns back.]",
  "“And bring snacks.”",
];
const SKIT_PAGE_2 = [
  "2. THE PRICE IS WRONG AND THE BUYERS KNOW IT BEFORE",
  "YOU DO",
  "Topic: Why overpricing costs you more than it saves.",
  "Pillars: Value + Credibility | Trust + Entertainment",
  "HOOK",
  "[Game show lights. Dana stands behind a podium.]",
  "DANA",
  "“Contestant number one, come on down… and lower your price.”",
  "REHOOK",
  "DANA",
  "“Overpriced homes sit, and sitting homes get cheaper.”",
  "BUILD UP",
  "DANA",
  "“Buyers compare every listing against the ones they can afford.”",
  "“If yours looks like the worst deal, it gets skipped.”",
  "PAYOFF",
  "DANA",
  "“Price it where buyers compete, and they push the price up for you.”",
  "CLOSE",
  "DANA",
  "“Want the real number for your home? Message me today.”",
];

// Jordan's October document for Ashley: four scripts in the shorthand people type.
const OCT_DOC = [
  "October scripts — Ashley Upload",
  "",
  "Script 1: Why the first weekend decides your price",
  "Pillar: Market Authority",
  "Hook: The first weekend decides your price, and most sellers miss it.",
  "TP1 Rehook: Buyers read every week on the market as a signal.",
  "TP2 Build Up: A stale listing invites the low offers you hoped to avoid.",
  "TP3 Payoff: Price it right on day one and buyers compete for you.",
  "Close-CTA: Planning to sell this spring? Call me before you pick a price.",
  "",
  "Script 2: Repairs before listing",
  "Pillar: Seller Education",
  "Hook: Not every repair pays you back.",
  "TP1 Rehook: Some fixes cost more than they return at the closing table.",
  "TP2 Build Up: Paint and lighting usually pay; kitchens rarely do.",
  "TP3 Payoff: Spend where buyers look first, and skip the rest.",
  "Close-CTA: Ask me for my repair checklist before you call a contractor.",
  "",
  "Script 3",
  "Rates are not the whole story",
  "Hook: Everyone is watching rates, and they're missing the real number.",
  "Rehook: Your monthly payment depends on more than the rate.",
  "Build up: Taxes and insurance moved more than rates this year.",
  "Payoff: Ask your lender for the full payment, not the rate.",
  "CTA: Want the real number for your budget? Message me today.",
  "",
  "Script 4: Should you sell before you buy?",
  "Hook: Selling first feels safe, but it isn't always.",
  "TP1: You might end up renting twice.",
  "TP2: A bridge loan can change the math entirely.",
  "TP3: The right order depends on your market.",
  "TP4: And honestly, on your nerves.",
  "Close: Call me and we'll map your order of moves.",
];

const SPOKEN = (lines: string[]) => lines.filter((l) => /^(Hook|TP\d|Rehook|Build up|Payoff|Close|CTA)/i.test(l)).map((l) => l.replace(/^[^:]+:\s*/, ""));

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct12-script-upload", PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const parse = await import("@/lib/scriptUploadParse");
    const up = await import("@/lib/scriptUpload");
    const act = await import("@/app/content/scriptUploadActions");
    const staffActions = await import("@/app/content/actions");
    const portalActions = await import("@/app/portal/actions");
    const portal = await import("@/lib/portal");
    const home = await import("@/lib/portalHome");
    const { yourMonthSteps } = await import("@/lib/yourMonth");
    const { allowanceOrder } = await import("@/lib/planningState");
    const reminders = await import("@/lib/programReminders");
    const programData = await import("@/app/content/[id]/programData");
    const { scriptsAwaitingReview } = await import("@/lib/contentScripts");

    const owner = await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "jordan@oct12.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@oct12.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@oct12.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const shooterTm = await prisma.teamMember.create({ data: { name: "Harrison", email: "harrison@oct12.test", role: "PHOTOGRAPHER", active: true } });
    const shooter = await prisma.appUser.create({ data: { name: "Harrison", email: "harrison@oct12.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: shooterTm.id } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // Ashley: Accelerator (4 a month). October has two earlier picks: one the
    // upload will reuse (a near-identical title), one it replaces. The bank
    // holds "Repairs before listing" (an exact match). Two pillars.
    const A = await buildContentMonth(prisma, {
      name: "Ashley Upload TEST", package: "Accelerator", monthKey: "2026-10", project: false,
      topics: [
        { title: "Spring market outlook", selection: "SELECTED" },
        { title: "Why the first weekend decides the price", selection: "SELECTED" },
        { title: "Repairs before listing", selection: null },
      ],
    });
    const [springId, weekendId, repairsId] = A.topicIds;
    const mkt = await prisma.contentPillar.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, name: "Market Authority", status: "ACTIVE" } });
    const edu = await prisma.contentPillar.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, name: "Seller Education", status: "ACTIVE" } });
    const ashleyMonthBefore = await prisma.contentMonth.findUniqueOrThrow({ where: { id: A.monthId } });

    // =======================================================================
    c.head("§1 · the reader: house labels and the shorthand people type");
    // =======================================================================
    const octText = OCT_DOC.join("\n");
    const split = parse.splitUploadedScripts({ name: "October scripts.docx", text: octText });
    c.ok("four scripts, the cover line left out", split.scripts.length === 4 && /October scripts/.test(split.preamble ?? ""), `${split.scripts.length} / ${split.preamble}`);
    c.ok("titles read off 'Script 1: …' and 'Script 3' + the line under it", split.scripts.map((s) => s.title).join(" | ") === "Why the first weekend decides your price | Repairs before listing | Rates are not the whole story | Should you sell before you buy?", split.scripts.map((s) => s.title).join(" | "));
    c.ok("'Pillar:' is the category", split.scripts[0].categoryLabel === "Market Authority" && split.scripts[1].categoryLabel === "Seller Education" && split.scripts[2].categoryLabel === null);
    c.ok("'TP1 Rehook / TP2 Build Up / TP3 Payoff' → Re-hook, Build up, Payoff", split.scripts[0].points.map((p) => p.role).join(",") === "re-hook,build-up,payoff");
    c.ok("bare 'Rehook: / Build up: / Payoff:' → Talking points 1-2-3 with roles", split.scripts[2].points.map((p) => p.role).join(",") === "re-hook,build-up,payoff" && split.scripts[2].points[1].text === "Taxes and insurance moved more than rates this year.");
    c.ok("'Close-CTA' / 'CTA' / 'Close' are the close", split.scripts.every((s) => !!s.close) && split.scripts[2].close === "Want the real number for your budget? Message me today.");
    c.ok("four talking points stay four (never trimmed) and are flagged", split.scripts[3].points.length === 4 && parse.shapeProblems(split.scripts[3]).some((x) => /4 talking points/.test(x)));
    const allSpoken = split.scripts.flatMap((s) => [s.hook, ...s.points.map((p) => p.text), s.close]).join(" ");
    c.ok("no spoken word lost: every Hook/TP/Close line of the document is in a script", SPOKEN(OCT_DOC).every((l) => allSpoken.includes(l)), SPOKEN(OCT_DOC).filter((l) => !allSpoken.includes(l)).join(" | "));
    const md = parse.splitUploadedScripts({ name: "notes.md", text: "## Open houses still work\n**HOOK:** Open houses are not dead.\n**Talking point 1 (Rehook):** They bring in neighbors who know buyers.\n**Talking point 2 (Build up):** They create urgency on a Sunday.\n**Talking point 3 (Payoff):** They give you feedback in real time.\n**Close / Call to action:** Thinking of listing? Let's talk.\n\n## Downsizing without the stress\n**HOOK:** Downsizing is a project, not a weekend.\n**Talking point 1 (Rehook):** The hardest part is deciding what stays.\n**Talking point 2 (Build up):** Start with the rooms you never use.\n**Talking point 3 (Payoff):** Measure the new place before you sort.\n**Close / Call to action:** DM me DOWNSIZE for my plan." });
    c.ok("markdown bold labels and headings: two clean house-format scripts", md.scripts.length === 2 && md.scripts.every((s) => parse.shapeProblems(s).length === 0) && md.scripts[1].title === "Downsizing without the stress", md.scripts.map((s) => `${s.title}:${parse.shapeProblems(s).join(";")}`).join(" | "));
    const spokenLine = parse.labelLine("Point 1 is that buyers compare.");
    c.ok("a spoken line that merely starts like a label is left alone", spokenLine === null && parse.labelLine("Close the deal before Friday.") === null && parse.labelLine("Hook your buyers early.") === null);

    // =======================================================================
    c.head("§2 · owner and admin only");
    // =======================================================================
    const octDocx = await docx(OCT_DOC);
    const form = () => { const f = new FormData(); f.append("file", new File([new Uint8Array(octDocx)], "October scripts.docx")); return f; };
    const sampleItems = [{ text: "1. X\nHOOK\nA hook line here.\nTALKING POINT 1\nOne.\nTALKING POINT 2\nTwo.\nTALKING POINT 3\nThree.\nCLOSE / CTA\nCall me.", title: "X", topicId: null, pillarId: null, sourceName: "Pasted text" }];
    const tryAll = async () => [
      await act.previewScriptUploadAction(A.enrollmentId, A.monthId, form()),
      await act.aiSplitScriptUploadAction(A.enrollmentId, A.monthId, [{ name: "x.txt", text: "anything" }]),
      await act.confirmScriptUploadAction({ enrollmentId: A.enrollmentId, monthId: A.monthId, fileNames: ["x"], items: sampleItems }),
      await act.sendScriptUploadAction("nonexistent-batch-id-000"),
      await act.undoScriptUploadAction("nonexistent-batch-id-000"),
    ];
    await clearSession();
    const anon = await tryAll();
    await signIn(editor);
    const ed = await tryAll();
    await signIn(shooter);
    const ph = await tryAll();
    await signIn(owner, admin.id);
    const viewAs = await tryAll();
    c.ok("signed out: all five refused", anon.every((r) => !r.ok), anon.map((r) => r.message).join(" | "));
    c.ok("an editor and a photographer: refused", ed.every((r) => !r.ok && /access/i.test(r.message)) && ph.every((r) => !r.ok));
    c.ok("an owner previewing as someone else: refused", viewAs.every((r) => !r.ok && /previewing/i.test(r.message)), viewAs[0].message);
    c.ok("nothing was written by any of them", (await prisma.contentImportBatch.count()) === 0 && (await prisma.contentScript.count()) === 0 && aiCalls === 0);

    // =======================================================================
    c.head("§3 · preview from a real .docx — writes nothing");
    // =======================================================================
    await signIn(admin);
    const snapshot = async () => JSON.stringify([await prisma.contentScript.count(), await prisma.contentTopic.count(), await prisma.contentTopicSelection.findMany({ orderBy: { id: "asc" } }), await prisma.contentImportBatch.count(), await prisma.contentMonth.findUniqueOrThrow({ where: { id: A.monthId } })]);
    const before = await snapshot();
    const pv = await act.previewScriptUploadAction(A.enrollmentId, A.monthId, form());
    if (!pv.ok) throw new Error(pv.message);
    const p = pv.preview;
    c.ok("'Found 4 scripts for October'", pv.message === "Found 4 scripts for October." && p.drafts.length === 4 && p.owed === 4, pv.message);
    c.ok("the .docx was read (mammoth), the file named", p.fileNames.join() === "October scripts.docx" && p.sources[0].text.includes("Rates are not the whole story"));
    const d1 = p.drafts[0], d2 = p.drafts[1], d3 = p.drafts[2], d4 = p.drafts[3];
    c.ok("#1 matches October's own pick (near-identical title)", d1.topicId === weekendId && d1.matchKind === "month", `${d1.topicId} ${d1.matchKind}`);
    c.ok("#2 matches the bank topic exactly", d2.topicId === repairsId && d2.matchKind === "exact");
    c.ok("#3 and #4 are new topics", d3.topicId === null && d4.topicId === null);
    c.ok("pillars resolved from 'Pillar:' lines (with the reason); none guessed for #3 (no shared words)", d1.pillarId === mkt.id && d2.pillarId === edu.id && /document says “Market Authority”/.test(d1.pillarWhy ?? "") && d3.pillarId === null && d3.pillarWhy === null && p.pillarSource === "pillars");
    c.ok("a document in the house labels is read by the parser — no AI call, nothing to check word for word", p.parser === "house" && !p.aiRecommended && aiCalls === 0 && p.drafts.every((d) => d.format === "house" && d.asWritten === null));
    c.ok("length estimates on every script", p.drafts.every((d) => d.words > 10 && d.seconds > 0 && ["under", "on", "over"].includes(d.pace)));
    c.ok("#4 (four talking points) says what stops it; #1-#3 are clean", d4.shape.some((x) => /4 talking points/.test(x)) && [d1, d2, d3].every((d) => d.shape.length === 0), d4.shape.join(";"));
    c.ok("each script in the house layout (Hook · Talking Point 1: Re-hook · … · Close)", /HOOK[\s\S]*Talking Point 1: Re-hook[\s\S]*Talking Point 2: Build up[\s\S]*Talking Point 3: Payoff[\s\S]*Close \/ Call to action/.test(d1.houseText), d1.houseText.slice(0, 200));
    c.ok("the earlier pick 'Spring market outlook' is offered for replacing; the matched one is not", p.selections.find((s) => s.topicId === springId)?.replaceable === true && p.drafts.some((d) => d.topicId === weekendId));
    c.ok("the route: no call on record → 'planned by the office'", !p.route.keep && /planned by the office/.test(p.route.text));
    c.ok("the document's cover line is reported as left out", p.notes.some((n) => /before the first script/.test(n)));
    c.ok("NOTHING was written by the preview", (await snapshot()) === before);

    // =======================================================================
    c.head("§4 · confirm: the month's topics, the scripts, the plan");
    // =======================================================================
    await signIn(owner);
    const items = p.drafts.map((d) => ({ key: d.key, text: d.text, title: d.title, topicId: d.topicId, pillarId: d.pillarId, sourceName: d.sourceName }));
    items[2].pillarId = mkt.id; // the staff picks #3's pillar
    items[3].pillarId = edu.id; // …and #4's
    const conf = await act.confirmScriptUploadAction({ enrollmentId: A.enrollmentId, monthId: A.monthId, fileNames: p.fileNames, items, replaceTopicIds: [springId] });
    c.ok("'Added 4 scripts to October (2 new topics, 2 from the bank)…'", conf.ok && /^Added 4 scripts to October \(2 new topics, 2 from the bank\)\./.test(conf.message) && /review queue/.test(conf.message), conf.message);
    const batchId = conf.batchId!;
    const scripts = await prisma.contentScript.findMany({ where: { monthId: A.monthId }, orderBy: { createdAt: "asc" } });
    const versions = await prisma.contentScriptVersion.findMany({ where: { scriptId: { in: scripts.map((s) => s.id) } } });
    c.ok("four LIVE scripts on October: manual, in review, not historical, not released", scripts.length === 4 && scripts.every((s) => !s.historical && s.source === "manual" && s.status === "INTERNAL_REVIEW" && !s.sharedVersionId && !s.approvedVersionId && s.sourceFile === "October scripts.docx"));
    c.ok("each a version 1 'Written by Jordan', by his email", versions.length === 4 && versions.every((v) => v.versionNo === 1 && v.source === "MANUAL" && v.status === "INTERNAL_REVIEW" && v.createdBy === owner.email && /^Written by Jordan — uploaded from October scripts\.docx/.test(v.changeSummary ?? "")), versions[0]?.changeSummary ?? "");
    c.ok("titles kept, the pillar the staff picked stamped on #3", scripts.map((s) => s.title).join(" | ") === "Why the first weekend decides your price | Repairs before listing | Rates are not the whole story | Should you sell before you buy?" && scripts[2].pillarId === mkt.id && scripts[1].pillarId === edu.id);
    const v1 = versions.find((v) => v.scriptId === scripts[0].id)!;
    c.ok("the words are the document's, in the House framework parts", v1.hook === "The first weekend decides your price, and most sellers miss it." && JSON.parse(v1.pointsJson).map((x: { role: string }) => x.role).join(",") === "RE_HOOK,BUILD_UP,PAYOFF" && v1.close === "Planning to sell this spring? Call me before you pick a price.");
    const queue = await scriptsAwaitingReview(A.enrollmentId);
    c.ok("all four are in the ONE review queue (path: manual)", queue.length === 4 && queue.every((q) => q.path === "manual" && q.monthKey === "2026-10"));
    const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: A.monthId } });
    const slots = allowanceOrder(sels.filter((s) => ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"].includes(s.status)), 4);
    const scriptTopics = scripts.map((s) => s.topicId!);
    c.ok("the month's topics ARE the four scripts' topics, all inside the allowance", scriptTopics.every((t) => slots.get(t) === "IN") && [...slots.values()].filter((v) => v === "IN").length === 4, JSON.stringify([...slots]));
    c.ok("#1 reused October's pick, #2 the bank topic (now selected for October)", scriptTopics[0] === weekendId && scriptTopics[1] === repairsId && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: repairsId } })).monthId === A.monthId);
    const newTopics = await prisma.contentTopic.findMany({ where: { id: { in: [scriptTopics[2], scriptTopics[3]] } } });
    c.ok("#3/#4 are new staff topics, approved by Jordan, selected for October", newTopics.length === 2 && newTopics.every((t) => t.source === "staff" && t.approvalState === "APPROVED" && t.approvedBy === owner.email && t.status === "SELECTED" && t.monthId === A.monthId));
    const spring = await prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: springId, monthId: A.monthId } } });
    c.ok("'Spring market outlook' went back to the bank (recorded, restorable)", spring.status === "REMOVED" && spring.removedReason === `UPLOAD_REPLACED:${batchId}` && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: springId } })).status === "SAVED");
    const batch = await prisma.contentImportBatch.findUniqueOrThrow({ where: { id: batchId } });
    const bItems = await prisma.contentImportItem.findMany({ where: { batchId }, orderBy: { ordinal: "asc" } });
    c.ok("one upload on the import ledger, four items with the text kept whole", batch.kind === "MONTH_SCRIPTS" && batch.mode === "APPLIED" && batch.proposedMonthKey === "2026-10" && batch.itemsCreated === 4 && bItems.length === 4 && bItems.every((it, i) => it.resultId === scripts[i].id && it.sourceText.includes("HOOK")));
    const mA = await prisma.contentMonth.findUniqueOrThrow({ where: { id: A.monthId } });
    c.ok("the month: planned by the office (written route, stamped office:jordan@…)", mA.planningMode === "WRITTEN" && mA.planningChosenBy === `office:${owner.email}`, `${mA.planningMode} ${mA.planningChosenBy}`);
    c.ok("…and it moved to script approval (no call to book, no answers to give)", mA.preparationStatus === "AWAITING_SCRIPT_APPROVAL" && mA.strategyCallStatus === "SKIPPED", `${mA.preparationStatus} ${mA.strategyCallStatus}`);
    const rem = await reminders.previewReminders(A.monthId, { now: now() });
    c.ok("no reminder asks for a call, a route or answers", rem.lanes.every((l) => !["BOOK_CALL", "CHOOSE_PATH", "COMPLETE_ANSWERS"].includes(l.candidate.action ?? "")), JSON.stringify(rem.lanes.map((l) => [l.lane, l.candidate.action])));
    const gate0 = await portal.sessionGate(A.enrollmentId, A.monthId, { now: now() });
    c.ok("filming stays shut while the office reviews — 'preparing', never 'send your answers'", gate0.locked && /still preparing this month/.test(gate0.reason) && !/answers/.test(gate0.reason), gate0.reason);
    const viewerA = await (async () => { const r = await portal.resolvePortalViewer({ token: A.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; })();
    const pm0 = home.planModel(await portal.portalTopics(viewerA.enrollment), "2026-10", now());
    c.ok("the client sees no script yet", pm0.scripts.length === 0);
    const plan0 = (await portal.portalPlanning(viewerA.enrollment))!;
    const stepsOf = (pl: typeof plan0) => yourMonthSteps({
      monthLabel: "October",
      planning: { callMode: pl.callMode, planningMode: pl.planningMode, callStatus: pl.callStatus, callAtISO: pl.callAtISO, noCallEligible: pl.noCallEligible, chosenAtISO: pl.chosenAtISO, deferredAtISO: pl.deferredAtISO, officePlanned: pl.officePlanned },
      month: pl.planning!, schedule: { locked: true, reason: "x", earliestISO: null, sessionsRequired: 1, sessionsMissing: 1, pendingRequest: false, capacityRemaining: 1 },
      can: { suggest: true, session: true }, readOnly: false, hrefs: { bank: "?pv=bank", month: "?pv=month", scripts: "?pv=scripts", bookingUrl: "https://calendly.invalid" }, now: now(),
    });
    const s0 = stepsOf(plan0);
    c.ok("their month: 'We planned this month's videos for you' · '4 of 4 topics chosen' · 'Nothing to answer' · 'Our team is reviewing your scripts'", plan0.officePlanned && s0[0].title === "We planned this month's videos for you" && /^4 of 4 topics chosen/.test(s0[1].title) && s0[2].title === "Nothing to answer this month" && s0.some((s) => s.key === "scripts" && s.title === "Our team is reviewing your scripts"), s0.map((s) => s.title).join(" | "));
    c.ok("…headline 'Our team is reviewing your scripts'; no route to switch to a call", plan0.planning?.headline.key === "TEAM_REVIEW" && !!plan0.switchBlocked.CALL && !!plan0.undoBlocked, `${plan0.planning?.headline.text} / ${plan0.switchBlocked.CALL}`);
    c.ok("the client cannot switch the office's month to a call", !(await portalActions.portalPlanWithCall({ token: A.portalToken }, A.monthId)).ok);
    const card0 = (await up.monthUploads(A.enrollmentId, A.monthId)).batches[0];
    c.ok("the upload card: 4 scripts waiting for the OK, 3 sendable (#4 must be fixed), Undo offered", card0.scripts.length === 4 && card0.counts.review === 4 && card0.canSend === 3 && card0.canUndo && !!card0.scripts[3].problem && card0.byName === "Jordan", JSON.stringify({ send: card0.canSend, p: card0.scripts[3].problem }));
    const tab = await programData.loadScriptsTab(A.enrollmentId, { id: A.monthId });
    c.ok("Plan › Scripts shows them in the review queue, 'from October scripts.docx'", tab.queueCount === 4 && tab.scripts.every((s) => s.sourceFile === "October scripts.docx" && s.versions[0].changeSummary?.startsWith("Written by Jordan")));

    // =======================================================================
    c.head("§5 · the same document twice is refused");
    // =======================================================================
    const again = await act.confirmScriptUploadAction({ enrollmentId: A.enrollmentId, monthId: A.monthId, fileNames: p.fileNames, items, replaceTopicIds: [springId] });
    c.ok("'already added — undo that upload first'", !again.ok && /already added to October/.test(again.message) && (await prisma.contentScript.count({ where: { monthId: A.monthId } })) === 4, again.message);

    // =======================================================================
    c.head("§6 · undo before anything is released");
    // =======================================================================
    const undo = await act.undoScriptUploadAction(batchId);
    c.ok("'Undone — 4 scripts removed from October, 2 new topics removed, 1 earlier pick back…'", undo.ok && /^Undone — 4 scripts removed from October, 2 new topics removed, 1 earlier pick back on the month, and the month's planning is back to how it was\.$/.test(undo.message), undo.message);
    c.ok("the scripts and their versions are gone; the two new topics too", (await prisma.contentScript.count({ where: { monthId: A.monthId } })) === 0 && (await prisma.contentScriptVersion.count({ where: { scriptId: { in: scripts.map((s) => s.id) } } })) === 0 && (await prisma.contentTopic.count({ where: { id: { in: [scriptTopics[2], scriptTopics[3]] } } })) === 0);
    const selsAfter = await prisma.contentTopicSelection.findMany({ where: { monthId: A.monthId } });
    const st = (id: string) => selsAfter.find((s) => s.topicId === id);
    c.ok("the earlier picks are exactly as they were (status and rank)", st(springId)?.status === "SELECTED" && st(springId)?.rank === 1 && st(weekendId)?.status === "SELECTED" && st(weekendId)?.rank === 2 && !st(springId)?.removedReason, JSON.stringify(selsAfter.map((s) => [s.status, s.rank, s.removedReason])));
    c.ok("the bank topic is back in the bank (off October)", st(repairsId)?.status === "REMOVED" && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: repairsId } })).monthId === null && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: repairsId } })).status === "IDEA");
    const mUndone = await prisma.contentMonth.findUniqueOrThrow({ where: { id: A.monthId } });
    c.ok("the month's route is back to no choice", mUndone.planningMode === ashleyMonthBefore.planningMode && mUndone.planningChosenBy === null && mUndone.preparationStatus !== "AWAITING_SCRIPT_APPROVAL", `${mUndone.planningMode} ${mUndone.preparationStatus}`);
    c.ok("the upload stays on the ledger as UNDONE (its items kept)", (await prisma.contentImportBatch.findUniqueOrThrow({ where: { id: batchId } })).mode === "UNDONE" && (await prisma.contentImportItem.count({ where: { batchId } })) === 4);
    c.ok("undoing twice is refused", !(await act.undoScriptUploadAction(batchId)).ok);
    const re = await act.confirmScriptUploadAction({ enrollmentId: A.enrollmentId, monthId: A.monthId, fileNames: p.fileNames, items: items.map((x, i) => ({ ...x, topicId: i < 2 ? x.topicId : null })), replaceTopicIds: [springId] });
    c.ok("the same document uploads again after the undo", re.ok && (await prisma.contentScript.count({ where: { monthId: A.monthId } })) === 4, re.message);
    const batch2 = re.batchId!;

    // =======================================================================
    c.head("§7 · counts against what the month owes");
    // =======================================================================
    const B = await buildContentMonth(prisma, { name: "Bernie Five TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const fiveText = OCT_DOC.slice(0, 26).join("\n") + "\n\nScript 5: Open houses still work\nHook: Open houses are not dead.\nTP1 Rehook: They bring in neighbors who know buyers.\nTP2 Build Up: They create urgency on a Sunday.\nTP3 Payoff: They give you feedback in real time.\nClose: Thinking of listing? Let's talk.\n\nScript 6: Pricing a condo\nHook: Condos price differently than houses.\nTP1 Rehook: The building is part of the price.\nTP2 Build Up: Fees and reserves move buyers more than finishes.\nTP3 Payoff: Show the building's health up front.\nClose: Selling a condo? Ask me how.";
    const pasteForm = new FormData(); pasteForm.append("text", fiveText);
    const pB = await act.previewScriptUploadAction(B.enrollmentId, B.monthId, pasteForm);
    c.ok("pasted text works: 5 scripts read", pB.ok && pB.preview.drafts.length === 5 && pB.preview.fileNames.join() === "Pasted text", pB.ok ? pB.preview.drafts.map((d) => d.title).join(" | ") : pB.message);
    if (!pB.ok) throw new Error(pB.message);
    const cB = await act.confirmScriptUploadAction({ enrollmentId: B.enrollmentId, monthId: B.monthId, fileNames: pB.preview.fileNames, items: pB.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: null, sourceName: d.sourceName })) });
    c.ok("5 for 4: '1 is an extra beyond the 4 owed — kept on the month, waiting its turn'", cB.ok && /1 is an extra beyond the 4 owed — kept on the month, waiting its turn\./.test(cB.message), cB.message);
    const cardB = (await up.monthUploads(B.enrollmentId, B.monthId)).batches[0];
    c.ok("…the fifth is the extra (document order decides), and it is not sendable with the rest", cardB.scripts[4].extra && cardB.scripts.slice(0, 4).every((s) => !s.extra) && !cardB.scripts[4].sendable);
    const mB = await prisma.contentMonth.findUniqueOrThrow({ where: { id: B.monthId } });
    c.ok("…an extra's draft does not hold the month: still 'awaiting script approval' for the four", mB.preparationStatus === "AWAITING_SCRIPT_APPROVAL");
    const C = await buildContentMonth(prisma, { name: "Cara Three TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const threeForm = new FormData(); threeForm.append("file", new File([Buffer.from(OCT_DOC.slice(0, 26).join("\n"))], "three.txt"));
    const pC = await act.previewScriptUploadAction(C.enrollmentId, C.monthId, threeForm);
    if (!pC.ok) throw new Error(pC.message);
    const cC = await act.confirmScriptUploadAction({ enrollmentId: C.enrollmentId, monthId: C.monthId, fileNames: pC.preview.fileNames, items: pC.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: null, sourceName: d.sourceName })) });
    c.ok("3 for 4: '1 slot still open for October'", cC.ok && /1 slot still open for October\./.test(cC.message), cC.message);
    const mC = await prisma.contentMonth.findUniqueOrThrow({ where: { id: C.monthId } });
    c.ok("…a short month is not 'planned': it waits for the fourth topic (no false 'script approval')", mC.planningMode === "WRITTEN" && mC.preparationStatus === "WRITTEN_SELECTED", `${mC.preparationStatus}`);

    // =======================================================================
    c.head("§7b · the hub's own drafts step aside (Jordan, Oct 13: Joe Sutow's October)");
    // =======================================================================
    {
      const { createScriptVersion } = await import("@/lib/contentScripts");
      const { createTopic, selectTopicForMonth } = await import("@/lib/contentTopics");
      const G = await buildContentMonth(prisma, { name: "Gio Drafts TEST", package: "Starter", monthKey: "2026-10", project: false });
      const sys = { kind: "AI" } as const;
      const mkDraft = async (title: string) => {
        const t = await createTopic({ enrollmentId: G.enrollmentId, title, source: "strategy_call", status: "SAVED", approvalState: "PROPOSED", actor: sys });
        await selectTopicForMonth(t.id, G.monthId, { source: "call", actor: sys, status: "RECONCILED" as never });
        const v = await createScriptVersion({ enrollmentId: G.enrollmentId, monthId: G.monthId, topicId: t.id, parts: { title, hook: `${title}: the hook.`, points: [{ role: "RE_HOOK", text: "One." }, { role: "BUILD_UP", text: "Two." }, { role: "PAYOFF", text: "Three." }], close: "Call me." }, source: "AI", status: "INTERNAL_REVIEW", createdBy: "cron" } as never);
        return { topicId: t.id, scriptId: (v as { scriptId: string }).scriptId };
      };
      const same = await mkDraft("Open houses still work");
      const other = await mkDraft("An idea the AI had");
      const twoText = "Script 1: Open houses still work\nHook: Open houses are not dead.\nTP1 Rehook: They bring in neighbors who know buyers.\nTP2 Build Up: They create urgency on a Sunday.\nTP3 Payoff: They give you feedback in real time.\nClose: Thinking of listing? Let's talk.\n\nScript 2: Pricing a condo\nHook: Condos price differently than houses.\nTP1 Rehook: The building is part of the price.\nTP2 Build Up: Fees and reserves move buyers more than finishes.\nTP3 Payoff: Show the building's health up front.\nClose: Selling a condo? Ask me how.";
      const fG = new FormData(); fG.append("text", twoText);
      const pG = await act.previewScriptUploadAction(G.enrollmentId, G.monthId, fG);
      if (!pG.ok) throw new Error(pG.message);
      c.ok("the preview says the hub's 2 drafts come out of the queue on Add", pG.preview.notes.some((n) => /2 scripts the hub drafted for October/.test(n) && /Undo puts them back/.test(n)), pG.preview.notes.join(" | "));
      const dSame = pG.preview.drafts.find((d) => d.title === "Open houses still work")!;
      c.ok("a title matching a topic that only has a hub draft is no longer refused: it takes that topic", !dSame.conflict && dSame.topicId === same.topicId, `${dSame.conflict} · ${dSame.topicId}`);
      const cG = await act.confirmScriptUploadAction({ enrollmentId: G.enrollmentId, monthId: G.monthId, fileNames: pG.preview.fileNames, items: pG.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: null, sourceName: d.sourceName })) });
      c.ok("Add says the drafts came out of the queue", cG.ok && /2 drafts the hub wrote for October came out of the review queue\./.test(cG.message), cG.message);
      const left = await prisma.contentScript.findMany({ where: { monthId: G.monthId }, select: { id: true, source: true } });
      c.ok("only the uploaded scripts are on October now (no hub drafts in the queue)", left.length === 2 && left.every((x) => x.source === "manual") && !(await scriptsAwaitingReview(G.enrollmentId)).some((q) => q.path !== "manual"));
      const otherSel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: other.topicId, monthId: G.monthId } } });
      const sameSel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: same.topicId, monthId: G.monthId } } });
      c.ok("the draft's topic the upload didn't use leaves the month; the one it used stays", otherSel?.status === "REMOVED" && /UPLOAD_REPLACED/.test(otherSel.removedReason ?? "") && sameSel?.status !== "REMOVED", `${otherSel?.status} / ${sameSel?.status}`);
      const uG = await act.undoScriptUploadAction(cG.batchId!);
      const back = await prisma.contentScript.findMany({ where: { id: { in: [same.scriptId, other.scriptId] } }, select: { id: true, status: true, source: true } });
      const backVersions = await prisma.contentScriptVersion.count({ where: { scriptId: { in: [same.scriptId, other.scriptId] } } });
      c.ok("Undo puts both hub drafts back in the queue, exactly (same ids, versions)", uG.ok && /2 hub drafts back in the review queue/.test(uG.message) && back.length === 2 && back.every((x) => x.source === "ai" && x.status === "INTERNAL_REVIEW") && backVersions === 2, uG.message);
      c.ok("…and the draft's topic is back on the month", (await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: other.topicId, monthId: G.monthId } } }))?.status === "RECONCILED");
    }

    // =======================================================================
    c.head("§8 · send to the client for review");
    // =======================================================================
    await signIn(editor);
    c.ok("an editor cannot send", !(await act.sendScriptUploadAction(batch2)).ok);
    await signIn(owner);
    const sent = await act.sendScriptUploadAction(batch2);
    c.ok("'Sent 3 scripts to the client's portal for review. No email went out…' and #4 held back with its reason", sent.ok && /^Sent 3 scripts to the client's portal for review\. No email went out — they'll see them on their portal\. Not sent: “Should you sell before you buy\?” \(fix the format first: Exactly 3 talking points/.test(sent.message), sent.message);
    const after = await prisma.contentScript.findMany({ where: { monthId: A.monthId }, orderBy: { createdAt: "asc" } });
    c.ok("three approved + released (version SHARED, release state 'released'), #4 untouched", after.slice(0, 3).every((s) => !!s.approvedVersionId && s.sharedVersionId === s.approvedVersionId && s.releaseState === "released") && !after[3].approvedVersionId && !after[3].sharedVersionId);
    const shares = await prisma.contentScriptRelease.findMany({ where: { scriptId: { in: after.map((s) => s.id) }, action: "SHARE" } });
    c.ok("each release on the ledger by Jordan, the email SUPPRESSED (its switch is off)", shares.length === 3 && shares.every((r) => r.actorEmail === owner.email && r.notificationState === "SUPPRESSED"));
    c.ok("undo is now refused — the scripts are with the client", !(await act.undoScriptUploadAction(batch2)).ok && (await prisma.contentScript.count({ where: { monthId: A.monthId } })) === 4);
    const fixed = await staffActions.saveScriptText(after[3].id, "Should you sell before you buy?\nCategory: Seller Education\nHOOK\nSelling first feels safe, but it isn't always.\nTALKING POINT 1 - RE-HOOK\nYou might end up renting twice.\nTALKING POINT 2 - BUILD UP\nA bridge loan can change the math entirely.\nTALKING POINT 3 - PAYOFF\nThe right order depends on your market.\nCLOSE / CTA\nCall me and we'll map your order of moves.");
    const sent2 = await act.sendScriptUploadAction(batch2);
    c.ok("fixed by hand (a new version), it goes too", fixed.ok && sent2.ok && /^Sent 1 script/.test(sent2.message), `${fixed.message} / ${sent2.message}`);
    const mSent = await prisma.contentMonth.findUniqueOrThrow({ where: { id: A.monthId } });
    c.ok("all four approved → the month is ready for filming (the existing gate), stamped", mSent.preparationStatus === "READY_FOR_FILMING" && !!mSent.filmingReadyAt, `${mSent.preparationStatus}`);
    const gate1 = await portal.sessionGate(A.enrollmentId, A.monthId, { now: now() });
    c.ok("…filming opens after the preparation window from the approval", !gate1.locked && gate1.earliest.getTime() > now().getTime() + 24 * 3_600_000, `${gate1.locked} ${gate1.earliest.toISOString()} ${gate1.reason}`);
    c.ok("nothing left to send", (await up.monthUploads(A.enrollmentId, A.monthId)).batches[0].canSend === 0);

    // =======================================================================
    c.head("§9 · the portal: read, approve, or ask for changes");
    // =======================================================================
    const pm1 = home.planModel(await portal.portalTopics(viewerA.enrollment), "2026-10", now());
    const scriptsNow = await prisma.contentScript.findMany({ where: { monthId: A.monthId }, select: { id: true, title: true } });
    // The portal names each card by its TOPIC (#1 reused October's own pick, "…decides the price").
    const tA = (title: string) => pm1.scripts.find((t) => t.script?.id === scriptsNow.find((x) => x.title === title)?.id)!;
    c.ok("the client's Scripts view: the four released scripts, each with the version to answer", pm1.scripts.length === 4 && pm1.scripts.every((t) => !!t.script?.sharedVersionId && !!t.scriptText?.body), pm1.scripts.map((t) => t.title).join(" | "));
    const words = tA("Repairs before listing")?.scriptText?.body ?? "";
    c.ok("…read in full in the house layout", /HOOK[\s\S]*Talking Point 1: Re-hook[\s\S]*Close \/ Call to action/.test(words) && words.includes("Paint and lighting usually pay; kitchens rarely do."));
    c.ok("…another client's (Bernie's) unreleased scripts are nowhere on Ashley's page", !pm1.scripts.some((t) => /Open houses|Pricing a condo/.test(t.title)));
    const vB = await (async () => { const r = await portal.resolvePortalViewer({ token: B.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; })();
    c.ok("…and Bernie (nothing released) sees no script at all", home.planModel(await portal.portalTopics(vB.enrollment), "2026-10", now()).scripts.length === 0);
    const plan1 = (await portal.portalPlanning(viewerA.enrollment))!;
    c.ok("their headline: '4 scripts are ready for your review'", plan1.planning?.headline.text === "4 scripts are ready for your review", plan1.planning?.headline.text);
    const auth = { token: A.portalToken };
    // Oct 20 2026 (audit E1): approving is the account owner's (a signed-in OWNER
    // seat), never the shared link. The portal action is a thin gate around
    // these two calls; the drill acts as the owner through them.
    const ownerAuth = await (async () => {
      const who = await prisma.clientUser.findUniqueOrThrow({ where: { id: A.clientUserId! } });
      const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: A.enrollmentId }, select: { id: true, clientId: true } });
      const c = await prisma.client.findUniqueOrThrow({ where: { id: e.clientId }, select: { name: true } });
      return { enrollment: { id: e.id, clientId: e.clientId, clientName: c.name }, actor: { kind: "CLIENT" as const, clientUserId: who.id, email: who.email, name: who.name, membershipId: A.membershipId!, membershipRole: "OWNER" as const }, access: "FULL" as const, via: "LOGIN" as const };
    })();
    const { clientApproveScript: approveAsOwnerRaw } = await import("@/lib/scriptDecisions");
    const { adoptEditedScript: adoptAsOwner } = await import("@/lib/scriptEdits");
    const approveAsOwner = (scriptId: string, versionId: string) => approveAsOwnerRaw(ownerAuth as never, scriptId, versionId);
    const editAsOwner = async (scriptId: string, baseVersionId: string, words: { hook: string; points: string[]; close: string; captionCta?: string | null }) => { const r = await adoptAsOwner(scriptId, baseVersionId, words, { kind: "CLIENT", viewer: ownerAuth as never }); return { ok: r.ok, message: r.message }; };
    const weekendScript = await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Why the first weekend decides your price" } });
    c.ok("…the card carries the script and the version the page shows", tA("Why the first weekend decides your price").script?.id === weekendScript.id && tA("Why the first weekend decides your price").script?.sharedVersionId === weekendScript.sharedVersionId);
    const yes = await approveAsOwner(weekendScript.id, weekendScript.sharedVersionId!);
    c.ok("Approve: recorded against the exact version they read", yes.ok && !!(await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Why the first weekend decides your price" } })).clientApprovedVersionId, yes.message);
    const repairs = await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Repairs before listing" } });
    const short = await portalActions.portalRequestScriptChanges(auth, repairs.id, "no", repairs.sharedVersionId!);
    c.ok("Request changes needs words (a two-letter note is refused)", !short.ok, short.message);
    const NOTE = "Can the hook mention first-time sellers? And drop the kitchen line.";
    const ask = await portalActions.portalRequestScriptChanges(auth, repairs.id, NOTE, repairs.sharedVersionId!);
    // Oct 22 2026 (the approved design, Portal-Message): the message goes to Jordan, who replies on the page with an updated version.
    c.ok("Request changes + Send: 'Sent. Jordan replies right here and sends you an updated version for your OK.' (no em dash, audit E7)", ask.ok && /^Sent\. Jordan replies right here/.test(ask.message) && !/[\u2013\u2014]/.test(ask.message), ask.message);
    const sugg = await prisma.scriptSuggestion.findMany({ where: { scriptId: repairs.id } });
    const ledgerAsk = await prisma.contentScriptRelease.findFirst({ where: { scriptId: repairs.id, action: "CLIENT_CHANGES" } });
    c.ok("…it lands with the office: a work item with their words, on the version they read", sugg.length === 1 && sugg[0].body === NOTE && sugg[0].scriptVersionId === repairs.sharedVersionId && sugg[0].status === "OPEN" && ledgerAsk?.note === NOTE);
    const bell = await prisma.notification.findMany({ where: { kind: "script_change_request" } });
    c.ok("…the bell rings for the owner and admins with the note", bell.length >= 1 && bell.some((n) => /OWNER/.test(n.audience) && /ADMIN/.test(n.audience) && (n.body ?? "").includes("first-time sellers")), JSON.stringify(bell.map((n) => [n.audience, n.body])));
    const requests = await programData.loadScriptRequests({ id: A.monthId });
    c.ok("…and on Plan › Scripts as an open client request", requests.length === 1 && requests[0].scriptId === repairs.id && requests[0].requests[0].body === NOTE);
    const card1 = (await up.monthUploads(A.enrollmentId, A.monthId)).batches[0];
    c.ok("the upload card: 'With Ashley: 1 approved, 1 asked for changes, 2 to read'", card1.counts.clientApproved === 1 && card1.counts.changes === 1 && card1.counts.released === 2, JSON.stringify(card1.counts));
    for (const t of ["Rates are not the whole story", "Should you sell before you buy?"]) {
      const s = await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: t } });
      await approveAsOwner(s.id, s.sharedVersionId!);
    }
    const plan2 = (await portal.portalPlanning(viewerA.enrollment))!;
    c.ok("with three approved and one in rework: 'We're making the changes you asked for'", plan2.planning?.headline.key === "CHANGES_REQUESTED", plan2.planning?.headline.text);
    // The office reworks it (a new version) and sends it again — the client approves the new words.
    await staffActions.saveScriptText(repairs.id, "Repairs before listing\nCategory: Seller Education\nHOOK\nFirst-time sellers: not every repair pays you back.\nTALKING POINT 1 - RE-HOOK\nSome fixes cost more than they return at the closing table.\nTALKING POINT 2 - BUILD UP\nPaint and lighting usually pay.\nTALKING POINT 3 - PAYOFF\nSpend where buyers look first, and skip the rest.\nCLOSE / CTA\nAsk me for my repair checklist before you call a contractor.");
    const sent3 = await act.sendScriptUploadAction(batch2);
    const repairs2 = await prisma.contentScript.findUniqueOrThrow({ where: { id: repairs.id } });
    const yes2 = await approveAsOwner(repairs.id, repairs2.sharedVersionId!);
    const plan3 = (await portal.portalPlanning(viewerA.enrollment))!;
    c.ok("reworked, re-sent and approved: 'All 4 scripts approved'", sent3.ok && yes2.ok && plan3.planning?.headline.text === "All 4 scripts approved", `${sent3.message} / ${plan3.planning?.headline.text}`);
    const card = fs.readFileSync(path.join(REPO, "src/components/portal/ScriptApprovalCard.tsx"), "utf8");
    c.ok("the change box says what it's for and sends (label, box, Send to Jordan, Cancel)", /What would you like changed\?/.test(card) && />Send to \{READER\}</.test(card) && />Cancel</.test(card) && /portalRequestScriptChanges\(portalAuthFromLocation\(\), script\.id, changeNote, script\.sharedVersionId \?\? ""(?:, about)?\)/.test(card));

    // =======================================================================
    c.head("§10 · a messy document: the AI reads it on upload (attended)");
    // =======================================================================
    const D = await buildContentMonth(prisma, { name: "Dana Messy TEST", package: "Starter", monthKey: "2026-10", project: false });
    const messy = "Dana — October ideas (rough)\n\nfirst weekend pricing\nso the first weekend decides your price and most sellers miss it. buyers read every week on market as a signal. a stale listing invites low offers. price it right on day one and buyers compete. call me before you pick a price.\n\nrepairs\nnot every repair pays you back. some fixes cost more than they return. paint and lighting usually pay. spend where buyers look first. ask me for my checklist.";
    const mForm = new FormData(); mForm.append("file", new File([Buffer.from(messy)], "dana ideas.txt"));
    const pD = await act.previewScriptUploadAction(D.enrollmentId, D.monthId, mForm);
    if (!pD.ok) throw new Error(pD.message);
    c.ok("no labels → the AI reads it straight away on upload: two scripts in the house parts", pD.preview.parser === "ai" && pD.preview.drafts.length === 2 && pD.preview.drafts.every((d) => d.isScript && d.shape.length === 0) && aiCalls === 1, `${pD.message} · ${pD.preview.drafts.map((d) => `${d.title}:${d.shape.join(";")}`).join(" | ")}`);
    const run = await prisma.programAiRun.findFirstOrThrow({ where: { kind: "import_split" } });
    c.ok("one ProgramAiRun: import_split, as written, requested by the person who uploaded, succeeded", run.requestedBy === owner.email && run.status === "SUCCEEDED" && run.promptKey === "script-upload-as-written" && run.enrollmentId === D.enrollmentId && pD.preview.aiRunId === run.id && aiPrompt.includes("first weekend pricing"));
    c.ok("words the document never said are flagged on that script, word for word; the clean one matches", pD.preview.drafts[1].asWritten?.checked === true && pD.preview.drafts[1].asWritten.ok === false && pD.preview.drafts[1].asWritten.added.join(" ").includes("honestly") && pD.preview.drafts[1].asWritten.added.join(" ").includes("absolutely") && pD.preview.drafts[0].asWritten?.ok === true && /One needs a look/.test(pD.message), JSON.stringify(pD.preview.drafts.map((d) => d.asWritten)));
    await signIn(editor);
    c.ok("an editor cannot run it", !(await act.aiSplitScriptUploadAction(D.enrollmentId, D.monthId, pD.preview.sources)).ok && aiCalls === 1);
    await signIn(admin);
    const ai = await act.aiSplitScriptUploadAction(D.enrollmentId, D.monthId, pD.preview.sources);
    if (!ai.ok) throw new Error(ai.message);
    c.ok("Kyle's 'Let AI read it' on the same document reuses that reading — no second model call", ai.preview.parser === "ai" && ai.preview.drafts.length === 2 && ai.preview.aiRunId === run.id && aiCalls === 1 && (await prisma.programAiRun.count({ where: { kind: "import_split" } })) === 1);
    c.ok("the AI changed nothing on its own: no topic, script or month write", (await prisma.contentScript.count({ where: { enrollmentId: D.enrollmentId } })) === 0 && (await prisma.contentTopic.count({ where: { enrollmentId: D.enrollmentId } })) === 0);

    // =======================================================================
    c.head("§11 · a month whose strategy call is booked keeps its call");
    // =======================================================================
    const E = await buildContentMonth(prisma, { name: "Evan Call TEST", package: "Starter", monthKey: "2026-10", project: false });
    await prisma.programCallRecord.create({ data: { enrollmentId: E.enrollmentId, clientId: E.clientId, monthId: E.monthId, callType: "MONTHLY_STRATEGY", status: "SCHEDULED", matchState: "MATCHED", scheduledStart: new RealDate(RealDate.UTC(2026, 9, 15, 17)), scheduledEnd: new RealDate(RealDate.UTC(2026, 9, 15, 17, 30)), transcriptState: "NONE" } });
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    await recalcProgramMonth(E.monthId, { now: now() });
    const twoForm = new FormData(); twoForm.append("text", OCT_DOC.slice(2, 18).join("\n"));
    const pE = await act.previewScriptUploadAction(E.enrollmentId, E.monthId, twoForm);
    if (!pE.ok) throw new Error(pE.message);
    c.ok("the preview says the call stays", pE.preview.route.keep && /booked/.test(pE.preview.route.text), pE.preview.route.text);
    const cE = await act.confirmScriptUploadAction({ enrollmentId: E.enrollmentId, monthId: E.monthId, fileNames: pE.preview.fileNames, items: pE.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: null, sourceName: d.sourceName })) });
    const mE = await prisma.contentMonth.findUniqueOrThrow({ where: { id: E.monthId } });
    c.ok("…the route is untouched (no office stamp), the call stays booked, scripts await approval", cE.ok && mE.planningChosenBy === null && mE.strategyCallStatus === "SCHEDULED" && mE.preparationStatus === "AWAITING_SCRIPT_APPROVAL", `${cE.message} | ${mE.planningMode} ${mE.strategyCallStatus} ${mE.preparationStatus}`);

    // =======================================================================
    c.head("§12 · a skit PDF, read as written (Joe Sutow, Oct 12)");
    // =======================================================================
    // Production's bundle has no @napi-rs/canvas: every PDF failed there with
    // "DOMMatrix is not defined". The same here, from now on in this process.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require("node:module") as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
    const resolveReal = Module._resolveFilename;
    Module._resolveFilename = function (req: string, ...rest: unknown[]) {
      if (req.startsWith("@napi-rs/canvas")) throw new Error(`Cannot find module '${req}'`);
      return resolveReal.call(this, req, ...rest);
    };
    const { renderStrategy } = await import("@/lib/contentPolicy");
    const cs = await import("@/lib/contentStrategy");
    const JOE_PILLARS = [
      { number: 1, name: "Buyer Strategy & Competitive Market Education", purpose: "Help buyers win in a competitive market.", focusAreas: "pre-approval, offers, financing" },
      { number: 2, name: "Seller Strategy & Listing Preparation", purpose: "Help sellers prepare, price and negotiate.", focusAreas: "pricing, repairs, staging, overpricing" },
      { number: 3, name: "Personal Brand, Humor & Trust Building", purpose: "Use humor and personality to build trust.", focusAreas: "funny skits, parody, personality" },
    ];
    const strategyFor = async (enrollmentId: string, approved: boolean, pillars = JOE_PILLARS) => {
      const text = renderStrategy({
        clientName: "Skit Client", year: 2026, subtitle: "Content Strategy",
        brandOverview: { coreValues: "Plain advice.", brandMessage: "Prepared wins.", shortBrandStatement: null, brandVoice: "Warm, witty.", otherFields: [], paragraphs: [] },
        targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Main Line", pricePositioning: null, primaryClientTypes: "Buyers and sellers", longTermPositioningGoal: "The agent people call first.", otherFields: [], paragraphs: [] },
        contentGoals: { heading: "Content Goals", items: ["Build trust"], numbered: false },
        contentPillars: { heading: "Content Pillars", preamble: [], pillars: pillars.map((p) => ({ ...p, heading: `Pillar ${p.number}: ${p.name}`, contentApproach: null, otherFields: [] })) },
        framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me."] }, strategicDirection: { heading: "Strategic Direction", paragraphs: ["Lead with skits."] }, otherSections: [],
      } as unknown as Parameters<typeof renderStrategy>[0]);
      const { stored } = cs.structuredFromText(text);
      const sv = await cs.createStrategyVersion({ enrollmentId, stored, rawText: text, sourceKind: "import", createdBy: "drill", status: approved ? "DRAFT" : "INTERNAL_REVIEW" } as Parameters<typeof cs.createStrategyVersion>[0]);
      // Joe's shape: APPROVED (lifted by the migration) with NO pillar records.
      if (approved) await prisma.contentStrategyVersion.update({ where: { id: sv.versionId }, data: { status: "APPROVED", approvedBy: "legacy-import", approvedAt: new Date() } });
      return sv.versionId;
    };
    const J = await buildContentMonth(prisma, { name: "Jo Skit TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const joStrategy = await strategyFor(J.enrollmentId, true);
    c.ok("the client's shape (Joe Sutow): an approved strategy naming 3 pillars, 0 pillar records", (await prisma.contentPillar.count({ where: { enrollmentId: J.enrollmentId } })) === 0 && !!(await cs.approvedStrategy(J.enrollmentId))?.document?.contentPillars.pillars.length);
    const skitPdf = await pdf([SKIT_PAGE_1, SKIT_PAGE_2]);
    const { extractDocumentText } = await import("@/lib/documentText");
    const ex = await extractDocumentText(skitPdf, "Jo Sutow - October Content Session Scripts.pdf");
    c.ok("a PDF reads where the canvas module is missing (production) — every line, both pages", ex.ok && ex.text.includes("1. THE OPEN HOUSE INTERVIEW") && ex.text.includes("“Want the real number for your home? Message me today.”") && /--\s*1 of 2\s*--/.test(ex.text), ex.ok ? ex.text.slice(0, 120) : ex.message);
    const panel = fs.readFileSync(path.join(REPO, "src/components/content/ScriptUploadPanel.tsx"), "utf8");
    c.ok("the upload takes .pdf and says 'Reading your scripts…' at once (then what it's doing)", /accept="\.docx,\.pdf,/.test(panel) && /read\(form, "Reading your scripts…"\)/.test(panel) && /This can take up to a minute/.test(panel));
    const pdfForm = () => { const f = new FormData(); f.append("file", new File([new Uint8Array(skitPdf)], "Jo Sutow - October Content Session Scripts.pdf", { type: "application/pdf" })); return f; };
    const callsBefore = aiCalls;
    const pJ = await act.previewScriptUploadAction(J.enrollmentId, J.monthId, pdfForm());
    if (!pJ.ok) throw new Error(pJ.message);
    const pj = pJ.preview;
    const [s1, s2] = pj.drafts;
    c.ok("not the house labels → the AI read it on upload (attended, logged, one call)", pj.parser === "ai" && aiCalls === callsBefore + 1 && !!pj.aiRunId && /Found 2 scripts for October, read as written\. One needs a look/.test(pJ.message), pJ.message);
    c.ok("titles are the scripts' names (not the 'Pillars:' line), a wrapped capitalised title joined", s1.title === "The Open House Interview" && s2.title === "The Price Is Wrong and the Buyers Know It Before You Do", `${s1.title} | ${s2.title}`);
    c.ok("five parts each, the structure check passes (scenes are not extra talking points)", pj.drafts.every((d) => d.parts.points.length === 3 && d.parts.points.map((x) => x.role).join(",") === "re-hook,build-up,payoff" && d.shape.length === 0), pj.drafts.map((d) => d.shape.join(";")).join(" | "));
    const tp2 = s1.parts.points[1].text.split("\n");
    c.ok("Build up holds BOTH scenes and the second re-hook, in order, headings without dashes", tp2[0] === "[BUILD UP, SCENE 1: THE PREP]" && tp2.indexOf("[BUILD UP, SCENE 2: THE CROWD]") > 0 && tp2.indexOf("[SECOND REHOOK]") > tp2.indexOf("[BUILD UP, SCENE 2: THE CROWD]"), tp2.join(" / "));
    c.ok("speakers inline as written, labels cleaned ('ALEX (HOST)', 'DANA (TO CAMERA)'); the document's curly quotes back", s1.parts.hook.startsWith("ALEX (HOST): “Dana, huge crowd out there today. What's the secret?”") && s1.parts.points[2].text.startsWith("DANA (TO CAMERA): “Prepare the house") && s1.speakers.includes("ALEX (HOST)") && !/[—–]/.test(s1.speakers.join(" ")), s1.parts.hook);
    c.ok("[directions] and the CUT cue kept as directions; a stray 'PAYOFF' label taken out", tp2.includes("[CUT TO ALEX REACTION]") && tp2.includes("[Impressed nod.]") && s1.parts.hook.includes("[Dana is in a referee jersey. Dead serious.]") && !/^PAYOFF$/m.test(s1.parts.points[2].text) && s1.directions >= 8, `${s1.directions}`);
    c.ok("the wrapped spoken line is one line again; no 'isn't a part we know' anywhere", tp2.includes("“The follow-up after the open house is where the offers come from.”") && pj.drafts.every((d) => !d.notes.some((n) => /isn't a part we know|isn't in the script/.test(n))));
    c.ok("Purpose → goal, Topic → topic, the 'Pillars:' line → dimensions (never the content pillar)", /sideline-reporter parody/.test(s1.goal ?? "") && s2.topicLine === "Why overpricing costs you more than it saves." && s1.dimensions === "Credibility + Entertainment | Trust + Value" && s1.categoryLabel === null);
    c.ok("script 1: every word matches the document", s1.asWritten?.checked === true && s1.asWritten.ok === true, JSON.stringify(s1.asWritten));
    c.ok("script 2: the dropped line and the added word are shown, word for word", s2.asWritten?.ok === false && s2.asWritten.missing.some((m) => /If yours looks like the worst deal it gets skipped/.test(m)) && s2.asWritten.added.includes("really"), JSON.stringify(s2.asWritten));
    const spokenOnly = (t: string) => t.split("\n").filter((l) => !/^\[.*\]$/.test(l.trim())).map((l) => l.replace(/^[A-Z][A-Z ()]*:\s+/, "")).join(" ").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    const allLines = [s1.parts.hook, ...s1.parts.points.map((x) => x.text), s1.parts.close].join("\n");
    c.ok("length counts spoken lines only (no labels, no directions) and is never flagged red for a skit", s1.words === spokenOnly(allLines) && s1.words < allLines.split(/\s+/).length - 20 && s1.format === "skit", `${s1.words} vs ${spokenOnly(allLines)}`);
    c.ok("pillars from the APPROVED strategy, labelled so; each script picked with a reason", pj.pillarSource === "approved" && pj.pillars.length === 3 && pj.pillars.every((x) => x.from === "approved") && pj.pillars.find((x) => x.id === s1.pillarId)?.name === "Personal Brand, Humor & Trust Building" && /^Picked by AI: /.test(s1.pillarWhy ?? "") && pj.pillars.find((x) => x.id === s2.pillarId)?.name === "Seller Strategy & Listing Preparation", JSON.stringify([s1.pillarId, s1.pillarWhy, s2.pillarId]));
    c.ok("no 'no pillars yet' scare on any card", pj.drafts.every((d) => !d.notes.some((n) => /no pillars yet|No pillar/.test(n))));
    // The staff reads script 2 against the document, ticks it, and moves it to the Buyer pillar.
    const buyerOpt = pj.pillars.find((x) => /^Buyer/.test(x.name))!;
    const jItems = pj.drafts.map((d) => ({ key: d.key, text: d.text, title: d.title, topicId: d.topicId, pillarId: d.key === s2.key ? buyerOpt.id : d.pillarId, sourceName: d.sourceName }));
    const cJ = await act.confirmScriptUploadAction({ enrollmentId: J.enrollmentId, monthId: J.monthId, fileNames: pj.fileNames, parser: pj.parser, aiRunId: pj.aiRunId, items: jItems });
    c.ok("Add: 'Added 2 scripts… Jo Skit TEST's 3 content pillars from the approved strategy are now set up.'", cJ.ok && /^Added 2 scripts to October/.test(cJ.message) && /3 content pillars from the approved strategy are now set up/.test(cJ.message), cJ.message);
    const jPillars = await prisma.contentPillar.findMany({ where: { enrollmentId: J.enrollmentId } });
    const jScripts = await prisma.contentScript.findMany({ where: { monthId: J.monthId }, orderBy: { createdAt: "asc" } });
    c.ok("the pillars are made from the approved document (stable ids), the scripts filed under them — the staff's change kept", jPillars.length === 3 && jPillars.every((x) => x.strategyVersionId === joStrategy) && jScripts[0].pillarId === jPillars.find((x) => /^Personal Brand/.test(x.name))?.id && jScripts[1].pillarId === jPillars.find((x) => /^Buyer/.test(x.name))?.id);
    const jv = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: jScripts[0].id } });
    const jPoints = JSON.parse(jv.pointsJson) as { role: string; text: string }[];
    const { hasScriptDash } = await import("@/lib/contentPolicy");
    c.ok("the version keeps every line: speakers inline, [directions], scene headings, three roled points", jv.hook.startsWith("ALEX (HOST): “Dana") && jPoints.map((x) => x.role).join(",") === "RE_HOOK,BUILD_UP,PAYOFF" && jPoints[1].text.includes("[BUILD UP, SCENE 2: THE CROWD]") && jPoints[1].text.includes("DANA: “We told every neighbor first. Neighbors know buyers.”") && jv.close.endsWith("“And bring snacks.”"));
    c.ok("no dash in anything the script says or shows (the spoken one became a comma at save)", ![jv.title, jv.hook, jv.close, ...jPoints.map((x) => x.text)].some((x) => hasScriptDash(x)) && jPoints[1].text.includes("“Fresh paint, bright bulbs, nothing on the counters.”"));
    const jVal = JSON.parse(jv.validationJson ?? "{}") as { ok: boolean; findings: { code: string; severity: string }[] };
    c.ok("internal notes ride along: speakers, the Purpose as goal, the dimension line; validation passes (no block)", JSON.parse(jv.speakerLabelsJson ?? "[]").includes("ALEX (HOST)") && /sideline-reporter/.test(jv.goal ?? "") && /Lead/.test(jv.dimensionsCheckJson ?? "") && jVal.ok === true && !jVal.findings.some((f) => f.severity === "block"), JSON.stringify(jVal.findings.map((f) => f.code)));
    c.ok("the stored length is the spoken lines only, the same as the preview said", jv.spokenWordCount === s1.words, `${jv.spokenWordCount} vs ${s1.words}`);
    const jTab = await programData.loadScriptsTab(J.enrollmentId, { id: J.monthId });
    c.ok("Plan › Scripts: both in the review queue, marked as skits (length a note, no Tighten offered)", jTab.queueCount === 2 && jTab.scripts.every((x) => x.versions[0].skit === true));
    const jTopics = await prisma.contentTopic.findMany({ where: { id: { in: jScripts.map((x) => x.topicId!) } } });
    c.ok("the new topics carry the script's Topic / Purpose as their concept", jTopics.some((t) => t.concept === "Why overpricing costs you more than it saves.") && jTopics.some((t) => /sideline-reporter/.test(t.concept ?? "")));
    // Send, then the client's portal and the editor's brief.
    const jBatch = (await up.monthUploads(J.enrollmentId, J.monthId)).batches[0];
    await signIn(owner);
    const jSent = await act.sendScriptUploadAction(jBatch.id);
    c.ok("sent to the client's portal", jSent.ok && /^Sent 2 scripts/.test(jSent.message), jSent.message);
    const vJ = await (async () => { const r = await portal.resolvePortalViewer({ token: J.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; })();
    const jPm = home.planModel(await portal.portalTopics(vJ.enrollment), "2026-10", now());
    const onPortal = jPm.scripts.find((t) => t.script?.id === jScripts[0].id);
    const layout = await import("@/lib/scriptLayout");
    const portalLines = (onPortal?.scriptText?.parts?.points[1].text ?? "").split("\n");
    c.ok("the client reads the scene: speaker lines, directions and headings in Talking Point 2", portalLines.includes("[BUILD UP, SCENE 1: THE PREP]") && portalLines.some((l) => l.startsWith("DANA: “Fresh paint")) && layout.lineShape("DANA: “Fresh paint”").speaker === "DANA" && layout.lineShape("[Impressed nod.]").kind === "direction" && layout.lineShape("[BUILD UP, SCENE 1: THE PREP]").kind === "heading", portalLines.slice(0, 4).join(" / "));
    const brief = layout.scriptBlocksFromText(jv.body);
    c.ok("the editor's brief (stored body → the one layout): Hook, three talking points, Close, every line kept", brief.sections.map((x) => x.role).join(",") === "hook,point,point,point,close" && layout.spokenLayoutWords(brief).length === layout.scriptWords([jv.hook, ...jPoints.map((x) => x.text), jv.close].join("\n")).length, brief.sections.map((x) => x.label).join(" | "));
    // A hand edit keeps the scene (the archive reader would strip it).
    const edited = jv.body.replace("“And bring snacks.”", "“And bring the snacks.”");
    const savedEdit = await staffActions.saveScriptText(jScripts[0].id, edited);
    const jv2 = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: jScripts[0].id, versionNo: 2 } });
    const jv2Points = JSON.parse(jv2.pointsJson) as { text: string }[];
    c.ok("a hand edit keeps speakers, directions and headings (a new version)", savedEdit.ok && jv2.close.endsWith("“And bring the snacks.”") && jv2.hook.startsWith("ALEX (HOST): “Dana") && jv2Points[1].text.includes("[BUILD UP, SCENE 1: THE PREP]") && jv2Points[1].text.includes("[Impressed nod.]") && JSON.parse(jv2.speakerLabelsJson ?? "[]").includes("DANA"), savedEdit.message);

    // =======================================================================
    c.head("§13 · the same document again reuses the AI's reading");
    // =======================================================================
    const J2 = await buildContentMonth(prisma, { name: "Jo Again TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await strategyFor(J2.enrollmentId, true);
    await signIn(admin);
    const firstRead = await act.previewScriptUploadAction(J2.enrollmentId, J2.monthId, pdfForm());
    const calls2 = aiCalls;
    const again2 = await act.previewScriptUploadAction(J2.enrollmentId, J2.monthId, pdfForm());
    c.ok("cancelled and uploaded again: the same reading, no second model call", firstRead.ok && again2.ok && again2.preview.aiRunId === firstRead.preview.aiRunId && aiCalls === calls2 && again2.preview.drafts.map((d) => d.text).join() === firstRead.preview.drafts.map((d) => d.text).join());

    // =======================================================================
    c.head("§14 · the AI is down: the parser's own skit reading, said plainly");
    // =======================================================================
    const J3 = await buildContentMonth(prisma, { name: "Jo Fallback TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await strategyFor(J3.enrollmentId, true);
    aiDown = true;
    const down = await act.previewScriptUploadAction(J3.enrollmentId, J3.monthId, pdfForm());
    aiDown = false;
    if (!down.ok) throw new Error(down.message);
    const [f1, f2] = down.preview.drafts;
    c.ok("a plain note, and the parser's reading instead (no error, nothing lost)", down.preview.parser === "house" && /The AI couldn't read it just now \(Anthropic 529: Overloaded\), so this is the plain reading/.test(down.preview.notes[0] ?? ""), down.preview.notes.join(" | "));
    c.ok("…the same five parts, names, speakers, scenes and directions as the AI's", f1.title === "The Open House Interview" && f2.title === s2.title && f1.parts.hook === s1.parts.hook && f1.parts.points.map((x) => x.text).join("\n") === s1.parts.points.map((x) => x.text).join("\n") && f1.parts.close === s1.parts.close && f1.shape.length === 0 && f2.shape.length === 0);
    c.ok("…every word of both matches the document", f1.asWritten?.ok === true && f2.asWritten?.ok === true);
    c.ok("…the pillar by its words, with the reason", down.preview.pillars.find((x) => x.id === f2.pillarId)?.name === "Seller Strategy & Listing Preparation" && /^Closest match by its words/.test(f2.pillarWhy ?? ""), `${f2.pillarId} ${f2.pillarWhy}`);

    // =======================================================================
    c.head("§15 · pillars from a draft strategy, and none at all");
    // =======================================================================
    const J4 = await buildContentMonth(prisma, { name: "Jo Draft TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await strategyFor(J4.enrollmentId, false);
    const skitText = [...SKIT_PAGE_1, "", ...SKIT_PAGE_2].join("\n");
    const pasteJ4 = new FormData(); pasteJ4.append("text", skitText);
    const pJ4 = await act.previewScriptUploadAction(J4.enrollmentId, J4.monthId, pasteJ4);
    if (!pJ4.ok) throw new Error(pJ4.message);
    c.ok("a draft strategy's pillars are offered, labelled 'from the draft strategy', and picked", pJ4.preview.pillarSource === "draft" && pJ4.preview.pillars.every((x) => x.from === "draft") && !!pJ4.preview.drafts[0].pillarId);
    const cJ4 = await act.confirmScriptUploadAction({ enrollmentId: J4.enrollmentId, monthId: J4.monthId, fileNames: pJ4.preview.fileNames, parser: pJ4.preview.parser, aiRunId: pJ4.preview.aiRunId, items: pJ4.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: d.pillarId, sourceName: d.sourceName })) });
    const j4Script = await prisma.contentScript.findFirstOrThrow({ where: { monthId: J4.monthId }, orderBy: { createdAt: "asc" } });
    const j4v = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: j4Script.id } });
    const j4Topic = await prisma.contentTopic.findUniqueOrThrow({ where: { id: j4Script.topicId! } });
    c.ok("…added: the pillar kept as the script's label (a draft makes no pillar), no pillar record created", cJ4.ok && (await prisma.contentPillar.count({ where: { enrollmentId: J4.enrollmentId } })) === 0 && j4v.pillarId === null && j4v.categoryLabel === "Personal Brand, Humor & Trust Building" && j4Topic.pillar === "Personal Brand, Humor & Trust Building", cJ4.message);
    const J5 = await buildContentMonth(prisma, { name: "Jo None TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const pasteJ5 = new FormData(); pasteJ5.append("text", skitText);
    const pJ5 = await act.previewScriptUploadAction(J5.enrollmentId, J5.monthId, pasteJ5);
    if (!pJ5.ok) throw new Error(pJ5.message);
    c.ok("no pillars at all: said plainly once ('none'), no warning on any card, nothing blocks", pJ5.preview.pillarSource === "none" && pJ5.preview.pillars.length === 0 && pJ5.preview.drafts.every((d) => d.pillarId === null && d.shape.length === 0 && !d.notes.some((n) => /pillar/i.test(n))) && /has no content pillars on file yet\. That&rsquo;s fine/.test(panel));
    const cJ5 = await act.confirmScriptUploadAction({ enrollmentId: J5.enrollmentId, monthId: J5.monthId, fileNames: pJ5.preview.fileNames, parser: pJ5.preview.parser, aiRunId: pJ5.preview.aiRunId, items: pJ5.preview.drafts.map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: null, sourceName: d.sourceName })) });
    c.ok("…and they go in without one", cJ5.ok && (await prisma.contentScript.count({ where: { monthId: J5.monthId } })) === 2, cJ5.message);
    Module._resolveFilename = resolveReal;

    // =======================================================================
    c.head("§16 · nothing sent, nothing left the machine");
    // =======================================================================
    c.ok("no outbox message — no client was messaged", outbox.length === 0 && (await prisma.outboxMessage.count()) === 0, outbox.join(","));
    c.ok("the model ran only on uploads that needed it (Dana, Jo, Jo again once, the failed try, the draft and no-pillar clients)", aiCalls === 6, `${aiCalls}`);
    c.ok("no request left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
    console.log(await drill.evidence());
  } finally {
    quiet.restore();
    c.summary();
    try { await drill.stop(); } finally { fence.restore(); }
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

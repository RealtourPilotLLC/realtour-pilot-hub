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
//   §10 a messy document: no scripts → "Let AI split it" (attended, logged,
//       words checked against the document).
//   §11 a month whose strategy call is booked keeps its call.
//   §12 nothing sent, nothing left the machine.
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
let aiCalls = 0;
let aiPrompt = "";
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        aiPrompt = opts.prompt;
        return {
          result: {
            scripts: [
              { title: "first weekend pricing", category: null, hook: "so the first weekend decides your price and most sellers miss it.", talkingPoints: [{ label: null, text: "buyers read every week on market as a signal." }, { label: null, text: "a stale listing invites low offers." }, { label: null, text: "price it right on day one and buyers compete." }], close: "call me before you pick a price.", caption: null },
              // Two words the document never said — the reader must flag them.
              { title: "repairs", category: null, hook: "not every repair pays you back, honestly.", talkingPoints: [{ label: "Rehook", text: "some fixes cost more than they return." }, { label: "Build up", text: "paint and lighting usually pay, absolutely." }, { label: "Payoff", text: "spend where buyers look first." }], close: "ask me for my checklist.", caption: null },
            ],
          },
          usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "drill-stub",
        };
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
    c.ok("pillars resolved from 'Pillar:' lines; none guessed for #3", d1.pillarId === mkt.id && d2.pillarId === edu.id && d3.pillarId === null && d3.notes.some((n) => /No pillar/.test(n)));
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
    const weekendScript = await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Why the first weekend decides your price" } });
    c.ok("…the card carries the script and the version the page shows", tA("Why the first weekend decides your price").script?.id === weekendScript.id && tA("Why the first weekend decides your price").script?.sharedVersionId === weekendScript.sharedVersionId);
    const yes = await portalActions.portalApproveScript(auth, weekendScript.id, weekendScript.sharedVersionId!);
    c.ok("Approve: recorded against the exact version they read", yes.ok && !!(await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Why the first weekend decides your price" } })).clientApprovedVersionId, yes.message);
    const repairs = await prisma.contentScript.findFirstOrThrow({ where: { monthId: A.monthId, title: "Repairs before listing" } });
    const short = await portalActions.portalRequestScriptChanges(auth, repairs.id, "no", repairs.sharedVersionId!);
    c.ok("Request changes needs words (a two-letter note is refused)", !short.ok, short.message);
    const NOTE = "Can the hook mention first-time sellers? And drop the kitchen line.";
    const ask = await portalActions.portalRequestScriptChanges(auth, repairs.id, NOTE, repairs.sharedVersionId!);
    c.ok("Request changes + Submit: 'Sent — we'll rework it and share the new version here.'", ask.ok && /^Sent — we.ll rework it/.test(ask.message), ask.message);
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
      await portalActions.portalApproveScript(auth, s.id, s.sharedVersionId!);
    }
    const plan2 = (await portal.portalPlanning(viewerA.enrollment))!;
    c.ok("with three approved and one in rework: 'We're making the changes you asked for'", plan2.planning?.headline.key === "CHANGES_REQUESTED", plan2.planning?.headline.text);
    // The office reworks it (a new version) and sends it again — the client approves the new words.
    await staffActions.saveScriptText(repairs.id, "Repairs before listing\nCategory: Seller Education\nHOOK\nFirst-time sellers: not every repair pays you back.\nTALKING POINT 1 - RE-HOOK\nSome fixes cost more than they return at the closing table.\nTALKING POINT 2 - BUILD UP\nPaint and lighting usually pay.\nTALKING POINT 3 - PAYOFF\nSpend where buyers look first, and skip the rest.\nCLOSE / CTA\nAsk me for my repair checklist before you call a contractor.");
    const sent3 = await act.sendScriptUploadAction(batch2);
    const repairs2 = await prisma.contentScript.findUniqueOrThrow({ where: { id: repairs.id } });
    const yes2 = await portalActions.portalApproveScript(auth, repairs.id, repairs2.sharedVersionId!);
    const plan3 = (await portal.portalPlanning(viewerA.enrollment))!;
    c.ok("reworked, re-sent and approved: 'All 4 scripts approved'", sent3.ok && yes2.ok && plan3.planning?.headline.text === "All 4 scripts approved", `${sent3.message} / ${plan3.planning?.headline.text}`);
    const card = fs.readFileSync(path.join(REPO, "src/components/portal/ScriptApprovalCard.tsx"), "utf8");
    c.ok("the change box says what it's for and submits (label, box, Submit changes, Cancel)", /What would you like changed\?/.test(card) && />Submit changes</.test(card) && />Cancel</.test(card) && /portalRequestScriptChanges\(portalAuthFromLocation\(\), script\.id, changeNote, script\.sharedVersionId \?\? ""\)/.test(card));

    // =======================================================================
    c.head("§10 · a messy document: let AI split it (attended)");
    // =======================================================================
    const D = await buildContentMonth(prisma, { name: "Dana Messy TEST", package: "Starter", monthKey: "2026-10", project: false });
    const messy = "Dana — October ideas (rough)\n\nfirst weekend pricing\nso the first weekend decides your price and most sellers miss it. buyers read every week on market as a signal. a stale listing invites low offers. price it right on day one and buyers compete. call me before you pick a price.\n\nrepairs\nnot every repair pays you back. some fixes cost more than they return. paint and lighting usually pay. spend where buyers look first. ask me for my checklist.";
    const mForm = new FormData(); mForm.append("file", new File([Buffer.from(messy)], "dana ideas.txt"));
    const pD = await act.previewScriptUploadAction(D.enrollmentId, D.monthId, mForm);
    c.ok("no labels → nothing usable found, and the AI is offered", pD.ok && pD.preview.drafts.every((d) => !d.isScript) && pD.preview.suggestAi, pD.ok ? `${pD.message} ${pD.preview.drafts.length}` : pD.message);
    if (!pD.ok) throw new Error(pD.message);
    await signIn(editor);
    c.ok("an editor cannot run it", !(await act.aiSplitScriptUploadAction(D.enrollmentId, D.monthId, pD.preview.sources)).ok && aiCalls === 0);
    await signIn(admin);
    const ai = await act.aiSplitScriptUploadAction(D.enrollmentId, D.monthId, pD.preview.sources);
    c.ok("Kyle clicks it: two scripts, read into the house parts", ai.ok && ai.preview.parser === "ai" && ai.preview.drafts.length === 2 && ai.preview.drafts.every((d) => d.isScript && d.shape.length === 0), ai.ok ? ai.preview.drafts.map((d) => `${d.title}:${d.shape.join(";")}`).join(" | ") : ai.message);
    if (!ai.ok) throw new Error(ai.message);
    const run = await prisma.programAiRun.findFirstOrThrow({ where: { kind: "import_split" } });
    c.ok("one ProgramAiRun: import_split, requested by Kyle, attended, succeeded", aiCalls === 1 && run.requestedBy === admin.email && run.status === "SUCCEEDED" && run.enrollmentId === D.enrollmentId && ai.preview.aiRunId === run.id && aiPrompt.includes("first weekend pricing"));
    c.ok("words the document never said are flagged on that script", ai.preview.drafts[1].notes.some((n) => /aren't in your document/.test(n)) && !ai.preview.drafts[0].notes.some((n) => /in your document/.test(n)), ai.preview.drafts[1].notes.join(" | "));
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
    c.head("§12 · nothing sent, nothing left the machine");
    // =======================================================================
    c.ok("no outbox message — no client was messaged", outbox.length === 0 && (await prisma.outboxMessage.count()) === 0, outbox.join(","));
    c.ok("the model ran once, on the click", aiCalls === 1);
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

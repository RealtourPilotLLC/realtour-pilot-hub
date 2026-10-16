// ---------------------------------------------------------------------------
// LIVE: what the hub keeps from Marcee McMullen's Oct 15 2026 call with Jordan.
//
//   DRY RUN (default):  set -a; source .env; set +a; NODE_OPTIONS=--conditions=react-server \
//                         npx tsx scripts/_fix/oct15/marcee-call-facts.ts
//   APPLY:              … --apply
//
// The call was analysed automatically: 14 PROPOSED facts, none reviewed, none
// marked confidential (the one about her unhappiness and the price, the
// contract month, her assistant). Jordan: "take this call with Marcee today
// into consideration ... make sure our system and workflows and UI and
// everything is built to handle that."
//
//   · confidential + accepted (a record, never AI context): her dissatisfaction
//     and the price, the extra month, the assistant;
//   · accepted, kept out of AI context (operational, not content): the bio
//     video commitment, the Malvern email, her headshots;
//   · accepted, AI context (they shape her scripts and edits): fully scripted
//     format, Fairy God Realtor discontinued, fonts from her signs, a look
//     consistent with her website and signs, Dan, her story, first-time buyers,
//     the pre-listing process;
//   · ADDED (said on the call, missed by the analysis): Dan's photo pops up in
//     the renovation video; her videos must not look like the other agents';
//     vague feedback goes to a creative conversation; missed months carry to
//     the end of her contract and no refund was agreed (confidential).
// Every write goes through lib/clientFacts (acceptFact, markFactConfidential,
// setFactAiContext, createFact) and can be undone on her Knowledge tab.
// ---------------------------------------------------------------------------
export {};
const MARCEE = "cmqiksjju007v9k9qtuql2n4e";
const ENROLLMENT = "cmt7h6azc00049kcj0b39k6si";
const BY = "info@realtourpilot.com (Oct 15 call, filed by Claude)";
const APPLY = process.argv.includes("--apply");

type Rule = { match: RegExp; confidential?: boolean; ai: boolean };
const RULES: Rule[] = [
  { match: /strong dissatisfaction/i, confidential: true, ai: false },
  { match: /add one month to the end/i, confidential: true, ai: false },
  { match: /assistant whose skills/i, confidential: true, ai: false },
  { match: /lifestyle biography video/i, ai: false },
  { match: /email Jordan her specific thoughts.*Malvern/i, ai: false },
  { match: /new professional headshots/i, ai: false },
  { match: /fully scripted videos/i, ai: true },
  { match: /discontinue the Fairy God Realtor/i, ai: true },
  { match: /font used on her professional property signs/i, ai: true },
  { match: /consistent with her website and print marketing/i, ai: true },
  { match: /husband Dan is a professional property renovator/i, ai: true },
  { match: /pre-listing seller process/i, ai: true },
  { match: /transitioned into real estate/i, ai: true },
  { match: /First-time buyers are Marcee's/i, ai: true },
];

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const lib = await import("@/lib/clientFacts");
  const since = new Date("2026-10-15T00:00:00Z");
  const facts = await prisma.clientFact.findMany({ where: { clientId: MARCEE, createdAt: { gte: since }, status: "PROPOSED" }, select: { id: true, body: true, category: true } });
  console.log(`${facts.length} proposed facts from today`);
  for (const f of facts) {
    const r = RULES.find((x) => x.match.test(f.body));
    console.log(`  ${r ? (r.confidential ? "CONFIDENTIAL+ACCEPT" : r.ai ? "ACCEPT (AI ok)" : "ACCEPT (no AI)") : "LEAVE for Jordan"} | ${f.body.slice(0, 110)}`);
    if (!APPLY || !r) continue;
    if (r.confidential) await lib.markFactConfidential(f.id, BY);
    await lib.acceptFact(f.id, BY);
    if (!r.ai && !r.confidential) await lib.setFactAiContext(f.id, false, BY);
  }

  const oct = await prisma.contentMonth.findUniqueOrThrow({ where: { enrollmentId_monthKey: { enrollmentId: ENROLLMENT, monthKey: "2026-10" } }, select: { id: true } });
  const ADD: { body: string; category: "PRODUCTION_PREFERENCE" | "BRAND_PREFERENCE" | "DECISION"; scope?: "MONTH"; confidential?: boolean; ai: boolean; quote: string }[] = [
    {
      category: "PRODUCTION_PREFERENCE", scope: "MONTH", ai: true,
      body: "Renovation-cost video (October): when Marcee asks \"Do you want to know how I know what a renovation is going to cost you?\", a photo of her husband Dan pops up on screen. He renovates properties for a living. Get a good photo of Dan from Marcee before the edit.",
      quote: "I think we should have a picture of my husband pop up on the screen",
    },
    {
      category: "BRAND_PREFERENCE", ai: true,
      body: "Her videos must not look interchangeable with the other agents in her area who use Realtour Pilot (Mike, Erica and her team, Rory Birkhart). One consistent look on every edit: her brand fonts and colors, matching her signs and website. Animated text is fine in her brand colors.",
      quote: "I just didn't want it to be identical to them",
    },
    {
      category: "PRODUCTION_PREFERENCE", ai: false,
      body: "Marcee often can't put what's wrong into words (\"I know I don't like something about it, but I wouldn't know how to tell someone to fix it\"). A vague note from her goes to Jordan or James to talk it through with her, not to the editor as a literal fix.",
      quote: "it's very hard for me to put into words",
    },
    {
      category: "DECISION", confidential: true, ai: false,
      body: "Jordan (Oct 15 call): the months Marcee missed carry to the end of her contract, on top of one extra month for the July session. No refund was agreed; she said that if the next one or two sessions don't go well she would like to talk about a refund of the remainder.",
      quote: "we'll add that extra month and then you also the the months you missed",
    },
  ];
  for (const a of ADD) {
    console.log(`  ADD ${a.category}${a.confidential ? " (confidential)" : ""}: ${a.body.slice(0, 100)}`);
    if (!APPLY) continue;
    const r = await lib.createFact({
      clientId: MARCEE, enrollmentId: ENROLLMENT, category: a.category, body: a.body, source: "call", sourceRef: "gemini-notes:2026-10-15 10:00 EDT",
      excerpt: [{ speaker: "Marcee McMullen", text: a.quote }], speaker: "Marcee McMullen", factDate: new Date("2026-10-15T14:00:00Z"),
      scope: a.scope ?? "PERMANENT", monthId: a.scope === "MONTH" ? oct.id : null, confidential: !!a.confidential,
    });
    await lib.acceptFact(r.id, BY, a.scope === "MONTH" ? { scope: "MONTH", monthId: oct.id } : {});
    if (!a.ai && !a.confidential) await lib.setFactAiContext(r.id, false, BY);
  }
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

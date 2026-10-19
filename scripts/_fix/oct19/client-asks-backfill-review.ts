// ---------------------------------------------------------------------------
// LIVE (Oct 19 2026): the lead's review of the client-asks backfill. The
// backfill read 14 days of texts and emails and filed 37 asks; a handful are
// not delivery checks and would only hold work or clutter Kyle's list:
//   · Rick Schultz (bulk plan; portal videos, never held): his script-bank
//     email and park idea, listed once per job across his two no-address jobs;
//   · Mike Flatley, 1316 Blair Cir: the booking (that session is today) and
//     two on-the-day filming instructions;
//   · Georgiana Torrella: the SoundCloud song for 2625 Wassergass (delivered,
//     so no job in flight) and "don't send Harrison" (who shoots, not what);
//   · Nehemiah Lindo, 7261 N 21st: "intro, drone and floor plans" (what was
//     ordered) and "affordable luxury" (a theme); the basement/porch one stays.
// Each is marked Not needed through lib/clientAsks with the reason, so it
// shows under Closed on /ops/requests with Reopen.
//   DRY RUN (default) · --apply
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
const BY = "Claude (backfill review, Oct 19)";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { markNotNeeded } = await import("@/lib/clientAsks");
  const open = await prisma.clientAsk.findMany({ where: { state: "OPEN" }, select: { id: true, clientId: true, summary: true, text: true, projectId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(open.map((a) => a.clientId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const rules: { who: RegExp; what: RegExp; why: string }[] = [
    { who: /rick schultz/i, what: /./, why: "Bulk-plan client: his portal videos are never held, and his scripts and ideas already live on his plan." },
    { who: /mike flatley/i, what: /book monday|before ross|builder on site/i, why: "Booking and on-the-day filming instructions for today's session, not a check on the finished work." },
    { who: /georgiana/i, what: /soundcloud|harrison/i, why: "The song was for 2625 Wassergass (already delivered); who shoots is a scheduling choice, not a delivery check." },
    { who: /nehemiah/i, what: /agent intro video|affordable luxury/i, why: "What was ordered and the theme, not a specific check; the basement and porch ask stays open." },
  ];
  let n = 0;
  for (const a of open) {
    const who = nameOf.get(a.clientId) ?? "";
    const r = rules.find((x) => x.who.test(who) && x.what.test(`${a.summary ?? ""} ${a.text}`));
    if (!r) continue;
    n++;
    console.log(`${APPLY ? "NOT NEEDED" : "would mark"} | ${who} | ${a.summary}`);
    if (APPLY) await markNotNeeded(a.id, BY, r.why);
  }
  console.log(`${n} asks ${APPLY ? "marked" : "would be marked"} Not needed.`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

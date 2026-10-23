// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, comms audit M2). Ashley Brunner's open
// scheduling ask is on the wrong job.
//
// Her text, Mon Oct 19, 9:55 AM: "I'm actually going to cancel the work order
// for next Wednesday at the mansion over in Wrightsville. If one of you could
// push that cancellation through the dashboard, I would appreciate it." Kyle
// answered at 10:05 AM: "we can get the Wrightsville order canceled."
//
// The backfill that filed it put it on 825 State St, Lancaster, and wrote
// "Cancel the scheduled shoot for 825 State St on Oct 28." Both are wrong:
//   · the order she cancelled is the pin drop near Wrightsville (Aryeo order
//     01a0a0ad…, the hub's "[No address provided], 40.0256531,-76.5299655",
//     city Wrightsville). Its one appointment, Wed Oct 28 at 10 AM, was
//     cancelled on Aryeo at 10:43 AM that morning; the order itself is still
//     open in the hub (status BOOKED, 4 videos owed);
//   · 825 State St is still booked for Wed Oct 28 at 3 PM, and nobody asked
//     to cancel it.
// This puts the ask on the Wrightsville order with clientAsks.assignAskProject
// (the app's own "put on a job", which records it in the ask's history) and
// rewrites its one-line summary. Her own words (`text`) are already right
// and stay as they are. The ask stays OPEN: the order still has to be
// cancelled. Nothing messages anyone; no booking changes.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-ashley-cancel-ask.ts
// Write it:
//   ... scripts/_live/oct22-ashley-cancel-ask.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const ASK_ID = "cmvfdmxtj000n9k2gpxcy9nzz";
const WRONG_PROJECT = "cmv8jn6ui000sjs06e3pdpeck"; // 825 State St, Lancaster
const RIGHT_PROJECT = "cmu1gn0w000o4jv04m5gv5d1o"; // the pin drop near Wrightsville
const SOURCE_COMM = "cmvfbh0m8000vig07f0dslja7";
const SUMMARY = "Cancel the Wrightsville order (the pin drop near Wrightsville; its Wed Oct 28, 10 AM shoot is already cancelled). Not 825 State St, which stays booked for Oct 28 at 3 PM.";
const BY = "Hub repair (Oct 22 audit)";

const one = (s: string | null | undefined, n = 200) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const et = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "none");

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { assignAskProject } = await import("@/lib/clientAsks");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: comms audit M2, Ashley Brunner's cancel ask\n`);

  const ask = await prisma.clientAsk.findUnique({ where: { id: ASK_ID }, select: { id: true, clientId: true, projectId: true, kind: true, state: true, text: true, summary: true, sourceRef: true, askedAt: true, historyJson: true, askedBy: true } });
  if (!ask) throw new Error(`ask ${ASK_ID} not found`);
  console.log(`ask ${ask.id} (${ask.kind}, ${ask.state}) from ${ask.askedBy}, ${et(ask.askedAt)}`);
  console.log(`  her words: "${one(ask.text, 300)}"`);
  console.log(`  summary now: "${ask.summary}"`);

  const src = ask.sourceRef ? await prisma.commLog.findUnique({ where: { id: ask.sourceRef }, select: { id: true, occurredAt: true, direction: true, body: true } }) : null;
  console.log(`  source message ${src?.id ?? "none"} (${et(src?.occurredAt)}): "${one(src?.body, 300)}"`);
  const reply = await prisma.commLog.findFirst({ where: { clientId: ask.clientId, direction: "out", occurredAt: { gte: ask.askedAt, lte: new Date(ask.askedAt.getTime() + 2 * 3_600_000) } }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true, body: true } });
  console.log(`  our reply (${et(reply?.occurredAt)}): "${one(reply?.body, 160)}"\n`);

  const jobs = await prisma.project.findMany({
    where: { id: { in: [WRONG_PROJECT, RIGHT_PROJECT] } },
    select: { id: true, title: true, city: true, status: true, clientId: true, aryeoOrderId: true, appointments: { select: { startAt: true, status: true, updatedAt: true } } },
  });
  for (const p of jobs) {
    console.log(`${p.id === RIGHT_PROJECT ? "THE ORDER SHE CANCELLED" : "WHERE THE ASK IS NOW"}: ${p.title} (${p.city ?? "?"}), ${p.status}, Aryeo order ${p.aryeoOrderId}`);
    for (const a of p.appointments) console.log(`  appointment ${et(a.startAt)}: ${a.status}${a.status === "CANCELED" ? ` (row last synced ${et(a.updatedAt)}; the hub logged "All Aryeo appointments are canceled" Mon Oct 19, 10:43 AM)` : ""}`);
  }
  const right = jobs.find((p) => p.id === RIGHT_PROJECT);
  const wrong = jobs.find((p) => p.id === WRONG_PROJECT);
  console.log("");

  // Refuse unless the facts are still the ones above.
  const why: string[] = [];
  if (ask.state !== "OPEN") why.push(`the ask is ${ask.state}, not OPEN`);
  if (ask.projectId !== WRONG_PROJECT) why.push(`the ask is on ${ask.projectId}, not 825 State St any more`);
  if (ask.sourceRef !== SOURCE_COMM || !/Wrightsville/i.test(src?.body ?? "")) why.push("the source message is not her Wrightsville text");
  if (!right || right.clientId !== ask.clientId || !/wrightsville/i.test(`${right.city} ${right.title}`)) why.push("the Wrightsville order is not hers or not in Wrightsville");
  if (!wrong || !/^825 State St/.test(wrong.title)) why.push("825 State St not found");
  if (why.length) {
    console.log(`REFUSED: ${why.join("; ")}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log("PLAN");
  console.log(`  1. summary: "${ask.summary}"`);
  console.log(`          → "${SUMMARY}"`);
  console.log(`  2. job: ${wrong!.title} → ${right!.title} (clientAsks.assignAskProject, by "${BY}")`);
  console.log("  her words stay as they are; the ask stays OPEN (the Wrightsville order is still open in the hub)");
  console.log("  825 State St and its Oct 28, 3 PM shoot are not touched");

  if (!APPLY) {
    console.log("\nNothing was written. Run with --apply to write it.");
    await prisma.$disconnect();
    return;
  }
  let hist: { at: string; by: string; what: string }[] = [];
  try { hist = ask.historyJson ? JSON.parse(ask.historyJson) : []; } catch { hist = []; }
  if (!Array.isArray(hist)) hist = [];
  hist.push({ at: new Date().toISOString(), by: BY, what: `summary corrected (was: ${ask.summary ?? "none"})` });
  const w = await prisma.clientAsk.updateMany({ where: { id: ask.id, projectId: WRONG_PROJECT, state: "OPEN" }, data: { summary: SUMMARY, historyJson: JSON.stringify(hist.slice(-30)) } });
  if (!w.count) throw new Error("the ask changed while this ran; nothing written");
  const r = await assignAskProject(ask.id, RIGHT_PROJECT, BY);
  const after = await prisma.clientAsk.findUnique({ where: { id: ask.id }, select: { projectId: true, state: true, summary: true } });
  console.log(`\nAPPLIED: ${r.message} Now: ${JSON.stringify(after)}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

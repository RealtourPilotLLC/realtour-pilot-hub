// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, photo audit, low). The orphan ask.
//
// ClientAsk cmvfdmxkt000i9k2gg2byce1z holds delivery but is on no job
// (projectId null): Georgiana Torrella's email (Oct 15) asking to digitally
// stage 4 photos (3 bedrooms, the basement as a family or game room). An ask
// on no job holds nothing and sits on no photo job's checklist. This reads its
// source message (the CommLog it was filed from: its job, subject and words)
// and her jobs around that day, and proposes ONE of:
//   ATTACH  the message names one job (its CommLog job when not a guess, or a
//           street of hers in the subject or words, else her only job shot
//           within 10 days of the message): put the ask on it
//           (clientAsks.assignAskProject);
//   CLOSE   nothing ties it to a job she has in flight (all delivered long
//           before, or none): set aside as Not needed with the reason.
// Nothing is sent.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-audit-orphan-ask.ts
// Write it:
//   … scripts/_live/oct22-photo-audit-orphan-ask.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const ASK_ID = "cmvfdmxkt000i9k2gg2byce1z";
const one = (s: string | null | undefined, n = 200) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const et = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-");

(async () => {
  const { prisma } = await import("@/lib/prisma");
  console.log(APPLY ? "APPLYING" : "DRY RUN (read-only connection)");
  const ask = await prisma.clientAsk.findUnique({ where: { id: ASK_ID } });
  if (!ask) throw new Error("the orphan ask is not there");
  console.log(`ask ${ask.id}: ${ask.state}, holds ${ask.holdsDelivery}, project ${ask.projectId ?? "none"}, ${ask.source} from ${ask.askedBy}, ${et(ask.askedAt)}\n  "${one(ask.text, 260)}"`);
  if (ask.state !== "OPEN" || ask.projectId) {
    console.log("Nothing to do: it is no longer an open ask on no job.");
    return prisma.$disconnect();
  }
  const msg = ask.sourceRef ? await prisma.commLog.findUnique({ where: { id: ask.sourceRef }, select: { id: true, channel: true, subject: true, body: true, occurredAt: true, projectId: true, projectGuess: true, contactName: true, clientId: true } }) : null;
  console.log(`\nsource message: ${msg ? `${msg.id} (${msg.channel}, ${et(msg.occurredAt)}, from ${msg.contactName}) subject "${one(msg.subject, 120)}"; job ${msg.projectId ?? "none"}${msg.projectGuess ? " (a guess)" : ""}\n  "${one(msg.body, 400)}"` : "not found"}`);
  // Her jobs (an assistant's account folds onto the agent's).
  const client = await prisma.client.findUnique({ where: { id: ask.clientId }, select: { id: true, name: true, parentClientId: true } });
  const clientIds = [ask.clientId, ...(client?.parentClientId ? [client.parentClientId] : [])];
  const jobs = await prisma.project.findMany({ where: { clientId: { in: clientIds } }, orderBy: { shootDate: "desc" }, take: 20, select: { id: true, title: true, status: true, shootDate: true, deliveredAt: true, addressLine: true } });
  console.log(`\n${client?.name ?? "the client"}'s jobs (newest first):`);
  for (const j of jobs) console.log(`  ${j.id}  ${one(j.title, 44).padEnd(44)} ${j.status.padEnd(10)} shot ${et(j.shootDate)}  delivered ${et(j.deliveredAt)}`);

  const words = `${msg?.subject ?? ""} ${msg?.body ?? ""} ${ask.text}`.toLowerCase();
  const street = (t: string) => t.split(",")[0].trim().toLowerCase();
  const named = jobs.filter((j) => {
    const s = street(j.addressLine || j.title);
    const num = /^\d+/.exec(s)?.[0];
    const name = s.replace(/^\d+\s*/, "").split(/\s+/)[0];
    return !!num && !!name && words.includes(num) && words.includes(name);
  });
  const near = jobs.filter((j) => j.shootDate && Math.abs(j.shootDate.getTime() - ask.askedAt.getTime()) <= 10 * 86_400_000);
  let plan: { action: "ATTACH"; projectId: string; why: string } | { action: "CLOSE"; why: string };
  if (msg?.projectId && !msg.projectGuess && jobs.some((j) => j.id === msg.projectId)) plan = { action: "ATTACH", projectId: msg.projectId, why: "the message itself is filed on that job (a named match, not a guess)" };
  else if (named.length === 1) plan = { action: "ATTACH", projectId: named[0].id, why: `the message names its street (${street(named[0].title)})` };
  else if (near.length === 1) plan = { action: "ATTACH", projectId: near[0].id, why: `her only job shot within 10 days of the message (${et(near[0].shootDate)})` };
  else plan = { action: "CLOSE", why: named.length > 1 || near.length > 1 ? `the message could be about ${Math.max(named.length, near.length)} of her jobs: a person files it (Special requests, Put on a job)` : "nothing ties it to a job she has: set aside" };
  const target = plan.action === "ATTACH" ? jobs.find((j) => j.id === plan.projectId) : null;
  console.log(`\nPROPOSAL: ${plan.action}${target ? ` on ${one(target.title, 60)} (${target.status})` : ""}: ${plan.why}`);
  if (plan.action === "CLOSE" && /a person files it/.test(plan.why)) console.log("  (with more than one candidate the script does not guess: on --apply it is left open for Kyle's Special requests screen.)");
  if (!APPLY) return prisma.$disconnect();
  const by = "photo audit (Oct 22 2026): the orphan ask";
  if (plan.action === "ATTACH") {
    const { assignAskProject } = await import("@/lib/clientAsks");
    console.log((await assignAskProject(ask.id, plan.projectId, by)).message);
  } else if (!/a person files it/.test(plan.why)) {
    const { markNotNeeded } = await import("@/lib/clientAsks");
    console.log((await markNotNeeded(ask.id, by, `On no job, and nothing in the message ties it to one in flight: ${plan.why}`)).message);
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// DRILL: an ask filed under the wrong client moves to the right client's job
// (Oct 23 2026, Olivia Vecere's Sussex change request).
//
//   DRILL_PORT=7101 node scripts/_drill/run-all.cjs scripts/_drill/oct23-refile-ask-client.ts
//
// Olivia Vecere (Sharra Mercer's assistant) emailed Sharra's Sussex video
// changes; her client row folds onto Mike Flatley, so the email and its ask
// were filed on Mike Flatley with no job. The app's "put on a job"
// (assignAskProject) keeps an ask on its own client and refuses another
// client's job; refileAskToClientJob is the office's correction:
//
//   1 · assignAskProject still refuses another client's job (and still takes
//       the assistant fold: an assistant's ask on the agent's job)
//   2 · refileAskToClientJob moves client and job together, the reason on
//       the ask's history and on the job's timeline; the ask stays open and
//       still holds delivery
//   3 · it refuses with no reason, a closed ask, a job not in the hub; a
//       second run says "Already on"
//
// ISOLATION: PGlite via the shared harness; nothing leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const LONG_DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7101) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const A = await import("@/lib/clientAsks");
    const mike = await prisma.client.create({ data: { name: "Mike Flatley Drill" } });
    const sharra = await prisma.client.create({ data: { name: "Sharra Mercer Drill" } });
    const olivia = await prisma.client.create({ data: { name: "Olivia Vecere Drill", parentClientId: mike.id } as never });
    const mikeJob = await prisma.project.create({ data: { title: "913 Lakeview Ct, Exton, PA", clientId: mike.id, status: "EDITING" } });
    const sussex = await prisma.project.create({ data: { title: "1337 Carolannes Way, West Chester, PA 19382", clientId: sharra.id, status: "DELIVERED", deliveredAt: new Date(Date.now() - 60 * 86_400_000) } });
    const ask = await prisma.clientAsk.create({
      data: {
        clientId: mike.id, projectId: null, kind: "SPECIAL_REQUEST", medium: "video", source: "email", askedBy: "Olivia Vecere", askedAt: new Date(), state: "OPEN", holdsDelivery: true,
        text: "The people are still a bit glitchy and need to be slowed down in the kitchen and bedroom with the built-in bunk beds clip.",
        summary: "Slow down glitchy people in kitchen and bunk bed bedroom clips", historyJson: "[]", dedupeKey: "msg:drill-olivia",
      },
    });

    c.head("1 · assignAskProject keeps an ask on its own client");
    const refused = await A.assignAskProject(ask.id, sussex.id, "Jordan");
    c.ok("another client's job is refused ('That job belongs to a different client.')", !refused.ok && refused.message === "That job belongs to a different client." && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask.id } })).projectId === null, refused.message);
    const assistantAsk = await prisma.clientAsk.create({ data: { clientId: olivia.id, kind: "SPECIAL_REQUEST", medium: "video", source: "email", askedAt: new Date(), state: "OPEN", text: "x", historyJson: "[]", dedupeKey: "msg:drill-fold" } as never });
    const folded = await A.assignAskProject(assistantAsk.id, mikeJob.id, "Jordan");
    c.ok("…the assistant fold still works (an assistant's ask on the agent's job)", folded.ok, folded.message);

    c.head("2 · refileAskToClientJob moves client and job together");
    const why = "Olivia Vecere is Sharra Mercer's assistant; her links open 1337 Carolannes Way, Premium Cinematic Film, Video 1 and 2.";
    const r = await A.refileAskToClientJob(ask.id, sussex.id, "info@ re-file v2 (Oct 23 2026)", why);
    const after = await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask.id } });
    c.ok("moved: Sharra's client and the 1337 Carolannes Way job", r.ok && after.clientId === sharra.id && after.projectId === sussex.id && r.message === "Moved to Sharra Mercer Drill, 1337 Carolannes Way.", r.message);
    c.ok("…still open, still holds delivery, the client's words untouched", after.state === "OPEN" && after.holdsDelivery && after.text.startsWith("The people are still a bit glitchy"));
    const hist = JSON.parse(after.historyJson ?? "[]") as { by: string; what: string }[];
    c.ok("…its history says from whom, to whom, and why", hist.some((h) => h.by === "info@ re-file v2 (Oct 23 2026)" && h.what.startsWith("moved from Mike Flatley Drill to Sharra Mercer Drill, 1337 Carolannes Way:") && h.what.includes("Sharra Mercer's assistant")), JSON.stringify(hist));
    const tl = await prisma.activity.findMany({ where: { projectId: sussex.id } });
    c.ok("…and the job's timeline has one line for it", tl.length === 1 && /^Client ask moved here from Mike Flatley Drill/.test(tl[0].body) && tl[0].body.includes("Slow down glitchy people"), tl.map((x) => x.body).join(" | "));
    c.ok("a hold that is not swept away: the delivered-job sweep leaves a holding ask open", (await A.closeAsksOnDeliveredJobs()).ids.every((id) => id !== ask.id) && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask.id } })).state === "OPEN");

    c.head("3 · what it refuses");
    const again = await A.refileAskToClientJob(ask.id, sussex.id, "Jordan", why);
    c.ok("a second run: 'Already on 1337 Carolannes Way.', nothing written", again.ok && again.message === "Already on 1337 Carolannes Way." && JSON.parse((await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask.id } })).historyJson ?? "[]").length === hist.length, again.message);
    const noWhy = await A.refileAskToClientJob(assistantAsk.id, sussex.id, "Jordan", " ");
    c.ok("no reason: refused", !noWhy.ok && /Say why/.test(noWhy.message));
    await prisma.clientAsk.update({ where: { id: assistantAsk.id }, data: { state: "DONE" } });
    const closed = await A.refileAskToClientJob(assistantAsk.id, sussex.id, "Jordan", why);
    c.ok("a closed ask: refused", !closed.ok && /Only an open ask/.test(closed.message));
    const gone = await A.refileAskToClientJob(ask.id, "no-such-job", "Jordan", why);
    c.ok("a job not in the hub: refused", !gone.ok && /not in the hub/.test(gone.message));
    c.ok("no em or en dashes in what it writes", !LONG_DASH.test(JSON.stringify([r, again, noWhy, closed, gone, hist, tl.map((x) => x.body)])));

    c.head("isolation");
    c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

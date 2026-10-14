// ---------------------------------------------------------------------------
// DRILL: THE MONDAY PHOTO DIGEST (Oct 14 2026, plan §12 item 8).
//   · counts delivered galleries, on time against each job's promise, the
//     median turnaround, the top QC issues and on-site issues per photographer
//   · AutoHDR credits used = pipeline spends + AutoHDR's own (adjustments),
//     net of refunds, never counting a refill
//   · the QC cost in dollars is in the OWNER-only lines, never Kyle's text
//   · sends once per Monday, only from 8 AM ET; no em dashes
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5998) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const dg = await import("@/lib/photoDelivery/digest");
    // Monday Oct 19 2026, 8:10 AM EDT = 12:10 UTC.
    const monday = new Date("2026-10-19T12:10:00Z");
    const H = 3_600_000;
    const client = await prisma.client.create({ data: { name: "Digest Client TEST" } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "h-digest@example.test" } });
    const mk = async (shootAgoH: number, deliveredAgoH: number, promiseAgoH: number) => {
      const p = await prisma.project.create({ data: { title: `${shootAgoH} Digest St, PA`, clientId: client.id, photographerId: harrison.id, shootDate: new Date(monday.getTime() - shootAgoH * H), promisedDueAt: new Date(monday.getTime() - promiseAgoH * H) } });
      return prisma.photoJob.create({ data: { projectId: p.id, stage: "DELIVERED", deliveredAt: new Date(monday.getTime() - deliveredAgoH * H) } });
    };
    const j1 = await mk(48, 30, 28); // 18 h turnaround, on time (delivered before the promise)
    await mk(72, 40, 50); // late (delivered 10 h after the promise)
    await mk(400, 380, 390); // older than a week: not counted
    const run = await prisma.photoQcRun.create({ data: { jobId: j1.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1", costUsd: 2.25, startedAt: new Date(monday.getTime() - 35 * H) } });
    const f = (ruleId: string, responsibility: string, status = "OPEN") =>
      prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: j1.id, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "P1", specificIssue: "x", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility, fixStrategy: "HUMAN_REVIEW", status, createdAt: new Date(monday.getTime() - 34 * H) } });
    await f("BATH_TOILET_SEAT_OPEN", "PHOTOGRAPHER");
    await f("BATH_TOILET_SEAT_OPEN", "PHOTOGRAPHER");
    await f("PREP_TRASH_CANS", "EDITOR", "FALSE_POSITIVE");
    const at = (h: number) => new Date(monday.getTime() - h * H);
    await prisma.autohdrCreditEntry.createMany({ data: [
      { at: at(100), kind: "ADJUSTMENT", credits: -60, note: "used outside the pipeline" },
      { at: at(90), kind: "TRANSFORM", credits: -2 },
      { at: at(80), kind: "REFUND", credits: 1 },
      { at: at(70), kind: "ADJUSTMENT", credits: 1000, note: "refill or top-up" },
      { at: at(1), kind: "BALANCE_SNAPSHOT", credits: 0, balanceAfter: 1337 },
    ] });

    const d = await dg.buildPhotoDigest(monday);
    const text = d.lines.join("\n");
    c.ok("2 galleries delivered last week (the old one is not counted)", /2 galleries delivered/.test(text), text);
    c.ok("on time 1 of 2 (50%)", /On time: 1 of 2 \(50%\)/.test(text));
    c.ok("median turnaround reported in hours", /Median shoot to delivery: \d+ h/.test(text));
    c.ok("top issue named by its short label", /Toilet seat/i.test(text));
    c.ok("on-site issues attributed to the photographer by first name", /Harrison 2/.test(text));
    c.ok("not-an-issue marks counted for tuning", /Marked not an issue: 1/.test(text));
    c.ok("credits used = 60 + 2 - 1 = 61 (the 1,000 refill is not spend)", /AutoHDR credits used: 61/.test(text), text);
    c.ok("Kyle's lines carry no dollar amount", !/\$/.test(text));
    c.ok("the owner-only lines carry the QC cost", d.ownerOnlyLines.some((l) => /\$2\.25/.test(l)));
    c.ok("no em or en dash anywhere", !/[–—]/.test([text, ...d.ownerOnlyLines].join(" ")));

    const early = await dg.maybeSendPhotoDigest(new Date("2026-10-19T11:30:00Z")); // 7:30 AM EDT
    c.ok("before 8 AM ET Monday: not sent", !early.sent);
    const tuesday = await dg.maybeSendPhotoDigest(new Date("2026-10-20T13:00:00Z"));
    c.ok("on a Tuesday: not sent", !tuesday.sent);
    const first = await dg.maybeSendPhotoDigest(monday);
    const second = await dg.maybeSendPhotoDigest(new Date(monday.getTime() + 5 * 60_000));
    c.ok("sent once on Monday after 8 AM, not twice", first.sent && !second.sent, JSON.stringify({ first, second }));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

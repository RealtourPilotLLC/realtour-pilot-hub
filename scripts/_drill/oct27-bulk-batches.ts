// ---------------------------------------------------------------------------
// DRILL: BULK PLANS ARE EDITED IN BATCHES OF 8 (Oct 27 2026). Jordan: "We
// should have 8 videos done every 7 - 10 business days." Rick Schultz's plan
// (31 videos filmed Oct 20, 17 on Oct 27) replayed:
//   1  the clock, pure: video n is in batch ceil(n/8); batch k is due 10k
//      business days after the first session (aim 7k), never sooner than
//      10 business days after the session that filmed the video
//   2  the stamp: a dry run lists and writes nothing; the run writes each
//      video's due, aim and window start; a second run changes nothing; a
//      video dated by another rule keeps its date but still counts
//   3  THE video due reads the batch: the job is due on its earliest open
//      video's batch, moves to the next batch when the first 8 are approved,
//      and the office's own date still wins
//   3b the Shoots board and the job page (outstandingPromise) read the same
//      batch: Rick's job read "6 days late" there once the office date went
//   4  a session's videos that arrive later are dated without moving the rest
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6991). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const PORT = Number(process.env.DRILL_PORT ?? 6991);

// Tue Oct 27 2026, 6 PM ET.
const NOW = new Date("2026-10-27T22:00:00Z");
const S1 = new Date("2026-10-20T04:30:00Z"); // Rick's first session, as stored
const S2 = new Date("2026-10-27T13:00:00Z");
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/bulkBatchCore");
    const { stampBulkBatches } = await import("@/lib/bulkBatches");
    const { videoDuesFor } = await import("@/lib/editorDue");

    c.head("1 · the clock (pure)");
    const videos = [
      ...Array.from({ length: 31 }, (_, i) => ({ key: `a${i + 1}`, sessionNo: 1, slot: i + 1, shootAt: S1 })),
      ...Array.from({ length: 17 }, (_, i) => ({ key: `b${i + 1}`, sessionNo: 2, slot: i + 1, shootAt: S2 })),
    ];
    const st = new Map(core.batchStamps([...videos].reverse(), S1).map((s) => [s.key, s]));
    c.ok("counted by session then slot, whatever order they come in", st.get("a1")!.index === 1 && st.get("a31")!.index === 31 && st.get("b1")!.index === 32 && st.get("b17")!.index === 48);
    c.ok("videos 1-8: batch 1, due Tue Nov 3 5 PM ET, aim Thu Oct 29 5 PM ET",
      st.get("a8")!.batchNo === 1 && iso(st.get("a1")!.dueAt) === "2026-11-03T22:00:00.000Z" && iso(st.get("a1")!.aimAt) === "2026-10-29T21:00:00.000Z",
      `${iso(st.get("a1")!.dueAt)} aim ${iso(st.get("a1")!.aimAt)}`);
    c.ok("video 9: batch 2, due Tue Nov 17, aim Mon Nov 9",
      st.get("a9")!.batchNo === 2 && iso(st.get("a9")!.dueAt) === "2026-11-17T22:00:00.000Z" && iso(st.get("a9")!.aimAt) === "2026-11-09T22:00:00.000Z",
      `${iso(st.get("a9")!.dueAt)} aim ${iso(st.get("a9")!.aimAt)}`);
    c.ok("the second session's first video is #32: batch 4, due Wed Dec 16 (Thanksgiving skipped), aim Mon Nov 30", st.get("b1")!.batchNo === 4 && iso(st.get("b1")!.dueAt) === "2026-12-16T22:00:00.000Z" && iso(st.get("b1")!.aimAt) === "2026-11-30T22:00:00.000Z", `${iso(st.get("b1")!.dueAt)} aim ${iso(st.get("b1")!.aimAt)}`);
    c.ok("the six holidays, observed on a weekday", core.batchHolidayKeys(2026).join(" ") === "2026-01-01 2026-05-25 2026-07-03 2026-09-07 2026-11-26 2026-12-25" && core.batchHolidayKeys(2028)[0] === "2027-12-31", core.batchHolidayKeys(2026).join(" "));
    c.ok("video 48: batch 6, due Fri Jan 15 2027 (Thanksgiving, Christmas, New Year's skipped)", st.get("b17")!.batchNo === 6 && iso(st.get("b17")!.dueAt) === "2027-01-15T22:00:00.000Z", iso(st.get("b17")!.dueAt) ?? "");
    c.ok("batch 1's window starts at the shoot; batch 2's at batch 1's due", iso(st.get("a1")!.anchorAt) === iso(S1) && iso(st.get("a9")!.anchorAt) === "2026-11-03T22:00:00.000Z");
    const late = core.batchStamps([{ key: "x", sessionNo: 3, slot: 1, shootAt: new Date("2026-12-28T15:00:00Z") }, ...videos.slice(0, 16).map((v) => ({ ...v }))], S1);
    const x = late.find((s) => s.key === "x")!;
    c.ok("a video filmed after its batch's date is due 10 business days after its own shoot", x.batchNo === 3 && iso(x.dueAt) === "2027-01-12T22:00:00.000Z", iso(x.dueAt) ?? "");

    c.head("2 · the stamp");
    const client = await prisma.client.create({ data: { name: "Rick Drill" } });
    const monthId = "drill-bulk-month";
    await prisma.contentBulkPlan.create({ data: { enrollmentId: "drill-enrollment", clientId: client.id, monthId, totalVideos: 48, perSession: 8, sessionsPlanned: 2, startsOn: S1, status: "ACTIVE" } });
    const job = async (title: string, shoot: Date, n: number) => {
      const p = await prisma.project.create({ data: { title, clientId: client.id, status: "REVIEW" as never, shootDate: shoot, contentMonthId: monthId } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO" as never, label: "Full Day Content Shoot", quantity: 4 } });
      for (let s = 1; s <= n; s++) await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: s, category: "VIDEO" } });
      return { p, d };
    };
    const one = await job("1671 N Providence Rd, Media, PA 19063", S1, 31);
    const two = await job("Session 2, Media, PA 19063", S2, 4);
    const other = await prisma.project.create({ data: { title: "9 Ordinary Ln, Wayne, PA 19087", clientId: client.id, status: "REVIEW" as never, shootDate: S2 } });
    const od = await prisma.deliverable.create({ data: { projectId: other.id, type: "VIDEO" as never, label: "Listing Video", quantity: 1 } });
    await prisma.deliverableOutput.create({ data: { deliverableId: od.id, projectId: other.id, slot: 1, category: "VIDEO" } });
    // One of session 2's videos was already dated by another rule.
    await prisma.deliverableOutput.updateMany({ where: { projectId: two.p.id, slot: 4 }, data: { promisedAt: new Date("2026-11-20T22:00:00Z"), promiseSource: "second-shoot" } });

    const dry = await stampBulkBatches({ dryRun: true });
    const untouched = await prisma.deliverableOutput.count({ where: { promiseSource: "bulk-batch" } });
    c.ok("dry run: 35 videos, 34 to date, one kept, nothing written", dry.videos === 35 && dry.changed === 34 && dry.keptOtherRule === 1 && untouched === 0, JSON.stringify({ ...dry, changes: dry.changes.length }));
    const run = await stampBulkBatches();
    c.ok("the run dates the same 34", run.changed === 34);
    const a9 = await prisma.deliverableOutput.findFirst({ where: { projectId: one.p.id, slot: 9 } });
    c.ok("video 9's row: due Nov 17, aim Nov 9, window from Nov 3, source bulk-batch",
      iso(a9?.promisedAt) === "2026-11-17T22:00:00.000Z" && iso(a9?.targetAt) === "2026-11-09T22:00:00.000Z" && iso(a9?.promiseAnchorAt) === "2026-11-03T22:00:00.000Z" && a9?.promiseSource === "bulk-batch");
    const kept = await prisma.deliverableOutput.findFirst({ where: { projectId: two.p.id, slot: 4 } });
    c.ok("the video another rule dated keeps its date", iso(kept?.promisedAt) === "2026-11-20T22:00:00.000Z" && kept?.promiseSource === "second-shoot");
    const plain = await prisma.deliverableOutput.findFirst({ where: { projectId: other.id } });
    c.ok("a job on no bulk plan is not touched", !plain?.promisedAt && !plain?.promiseSource);
    c.ok("a second run changes nothing", (await stampBulkBatches()).changed === 0);

    c.head("3 · THE video due reads the batch");
    let dues = await videoDuesFor([one.p.id, two.p.id, other.id], { now: NOW });
    const d1 = dues.get(one.p.id)!;
    c.ok("session 1: due Nov 3 (batch 1), aim Oct 29, source batch", d1.source === "batch" && iso(d1.at) === "2026-11-03T22:00:00.000Z" && iso(d1.aimAt) === "2026-10-29T21:00:00.000Z", `${d1.source} ${iso(d1.at)}`);
    c.ok("session 2: due Dec 16 (its first video is #32)", dues.get(two.p.id)!.source === "batch" && iso(dues.get(two.p.id)!.at) === "2026-12-16T22:00:00.000Z", iso(dues.get(two.p.id)!.at) ?? "");
    c.ok("the ordinary job still reads its own clock", dues.get(other.id)!.source !== "batch" && !!dues.get(other.id)!.at, dues.get(other.id)!.source ?? "null");
    await prisma.deliverableOutput.updateMany({ where: { projectId: one.p.id, slot: { lte: 7 } }, data: { approvedAt: NOW } });
    dues = await videoDuesFor([one.p.id], { now: NOW });
    c.ok("7 of the first 8 approved: still batch 1", iso(dues.get(one.p.id)!.at) === "2026-11-03T22:00:00.000Z");
    await prisma.deliverableOutput.updateMany({ where: { projectId: one.p.id, slot: 8 }, data: { deliveredAt: NOW } });
    dues = await videoDuesFor([one.p.id], { now: NOW });
    c.ok("all 8 done: the job moves to batch 2 (Nov 17, aim Nov 9)", iso(dues.get(one.p.id)!.at) === "2026-11-17T22:00:00.000Z" && iso(dues.get(one.p.id)!.aimAt) === "2026-11-09T22:00:00.000Z", iso(dues.get(one.p.id)!.at) ?? "");
    await prisma.project.update({ where: { id: one.p.id }, data: { dueOverrideAt: new Date("2026-11-04T14:27:00Z") } });
    dues = await videoDuesFor([one.p.id], { now: NOW });
    c.ok("the office's own date still wins", dues.get(one.p.id)!.source === "office" && iso(dues.get(one.p.id)!.computedAt) === "2026-11-17T22:00:00.000Z", `${dues.get(one.p.id)!.source} hub=${iso(dues.get(one.p.id)!.computedAt)}`);

    c.head("3b · the Shoots board and the job page read the same batch (outstandingPromise)");
    const { outstandingPromise } = await import("@/lib/deliveryBoard");
    const { batchDuesFor } = await import("@/lib/bulkBatches");
    const base = {
      status: "REVIEW", shootDate: S1, deliveredAt: null, revisionRequestedAt: null, dueOverrideAt: null, tierOverride: null, packageName: null, statusEvidence: null,
      orderItems: [{ title: "Full Day Content Shoot", quantity: 1 }],
      deliverables: [{ type: "VIDEO", status: "PENDING", uploadedAt: null, label: "Full Day Content Shoot" }],
      appointments: [{ startAt: S1, status: "COMPLETED" }],
    };
    const batch2 = (await batchDuesFor([one.p.id])).get(one.p.id) ?? null;
    const viaBoard = outstandingPromise({ ...base, batchDue: batch2 }, { now: NOW });
    c.ok("the board's date is the batch (Nov 17), labelled as the batch, not late", iso(viaBoard.at) === "2026-11-17T22:00:00.000Z" && viaBoard.tierLabel === "batch of 8" && iso(viaBoard.targetAt) === "2026-11-09T22:00:00.000Z", `${iso(viaBoard.at)} ${viaBoard.tierLabel}`);
    const orderOnly = outstandingPromise(base, { now: NOW });
    c.ok("control: without the batch the order's own date reads (the 'days late' Jordan would have seen)", iso(orderOnly.at) !== iso(viaBoard.at) && !!orderOnly.at && orderOnly.at < NOW, iso(orderOnly.at) ?? "null");
    const officeWins = outstandingPromise({ ...base, dueOverrideAt: new Date("2026-11-04T14:27:00Z"), batchDue: batch2 }, { now: NOW });
    c.ok("the office's own date still wins on the board", officeWins.office && iso(officeWins.at) === "2026-11-04T14:27:00.000Z");
    c.ok("the ordinary job has no batch", !(await batchDuesFor([other.id])).has(other.id));

    c.head("4 · a session's videos that arrive later");
    for (let s = 5; s <= 17; s++) await prisma.deliverableOutput.create({ data: { deliverableId: two.d.id, projectId: two.p.id, slot: s, category: "VIDEO" } });
    const more = await stampBulkBatches({ monthId });
    c.ok("only the 13 new videos are dated", more.changed === 13 && more.changes.every((ch) => ch.projectId === two.p.id && ch.slot >= 5), `${more.changed}`);
    const last = await prisma.deliverableOutput.findFirst({ where: { projectId: two.p.id, slot: 17 } });
    c.ok("video 48 is due Jan 15 2027", iso(last?.promisedAt) === "2027-01-15T22:00:00.000Z", iso(last?.promisedAt) ?? "");

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

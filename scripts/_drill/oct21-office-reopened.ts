// ---------------------------------------------------------------------------
// DRILL: Project.officeReopenedAt (Oct 21 2026, audit B11).
//
//   1. the rule: which board moves are the office putting a finished job back
//      (lib/officeReopen.boardMoveReopens), and the same rule read off the
//      timeline wording for jobs from before the stamp (isOfficeReopenLine);
//   2. the one-off backfill (scripts/_fix/oct21/backfill-office-reopened.ts)
//      on a drill database: the dry run writes nothing, --apply stamps each
//      unstamped job from its NEWEST put-back line, never overwrites a stamp,
//      and a second run has nothing to do.
//   (The live writers and readers are drilled in b4-reopen.ts §4b and §5.)
//
// ISOLATION: PGlite via the shared harness; nothing leaves.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6984);
installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { boardMoveReopens, isOfficeReopenLine, OFFICE_NEW_CUT_LINE } = await import("@/lib/officeReopen");
  const { backfillOfficeReopened } = await import("../_fix/oct21/backfill-office-reopened");
  try {
    // =======================================================================
    c.head("1 · the rule, live and on the timeline");
    {
      const moves: [string, string, boolean][] = [
        ["DELIVERED", "REVISION", true],
        ["EDITING", "REVISION", true],
        ["DELIVERED", "EDITING", true],
        ["DELIVERED", "SHOT", true],
        ["DELIVERED", "REVIEW", true],
        ["DELIVERED", "ON_HOLD", false],
        ["DELIVERED", "SCHEDULED", false],
        ["DELIVERED", "CANCELLED", false],
        ["SHOT", "EDITING", false],
        ["REVIEW", "DELIVERED", false],
        ["REVISION", "REVISION", false],
      ];
      for (const [from, to, want] of moves) {
        c.ok(`${from} → ${to}: ${want ? "a put-back" : "not a put-back"}`, boardMoveReopens(from as never, to as never) === want);
      }
      const lines: [string, boolean][] = [
        ["Moved from Delivered to Revisions.", true],
        ["Moved from In Editing to Revisions.", true],
        ["Moved from Delivered to Revisions with 1 video still missing on Aryeo.", true],
        ["Moved from Delivered to In Editing.", true],
        ["Moved from Delivered to Shot / Uploaded.", true],
        ["Moved from Delivered to Review / QC.", true],
        ["Moved from Delivered to On Hold.", false],
        ["Moved from Delivered to Cancelled.", false],
        ["Moved from Review / QC to Delivered with 2 videos still missing on Aryeo.", false],
        ["Moved from Shot / Uploaded to In Editing.", false],
        ["Moved from Revisions to Delivered.", false],
        [`${OFFICE_NEW_CUT_LINE} by Kyle Cabrera — routed to Kim Miguel. Note: shorter`, true],
        [`${OFFICE_NEW_CUT_LINE} — routed to John Mark.`, true],
        ["Moved from Delivered to Revisionsish.", false],
        ["Status re-evaluated: REVIEW → REVISION.", false],
      ];
      for (const [body, want] of lines) c.ok(`"${body.slice(0, 70)}": ${want ? "counted" : "not counted"}`, isOfficeReopenLine(body) === want);
    }

    // =======================================================================
    c.head("2 · the backfill on a drill database");
    {
      const client = await prisma.client.create({ data: { name: "Backfill Agent" }, select: { id: true } });
      const job = (title: string, data: Record<string, unknown> = {}) => prisma.project.create({ data: { title, clientId: client.id, status: "REVISION", ...data }, select: { id: true } });
      const line = (projectId: string, body: string, at: string) => prisma.activity.create({ data: { projectId, type: "STATUS_CHANGE", body, createdAt: new Date(at) } });
      const A = await job("1 Board Move Ln");
      await line(A.id, "Moved from Delivered to Revisions.", "2026-10-15T14:00:00Z");
      await line(A.id, "Moved from Revisions to Delivered.", "2026-10-16T14:00:00Z");
      await line(A.id, "Moved from Delivered to Cancelled.", "2026-10-17T14:00:00Z");
      const B = await job("2 New Cut Ct");
      await line(B.id, "Moved from Delivered to In Editing.", "2026-10-10T14:00:00Z");
      await line(B.id, `${OFFICE_NEW_CUT_LINE} by Kyle Cabrera — routed to Kim Miguel.`, "2026-10-19T15:30:00Z");
      const stampC = new Date("2026-10-21T04:00:00Z");
      const C = await job("3 Already Stamped St", { officeReopenedAt: stampC });
      await line(C.id, "Moved from Delivered to Revisions.", "2026-10-01T14:00:00Z");
      const D = await job("4 On Hold Ave", { status: "ON_HOLD" });
      await line(D.id, "Moved from Delivered to On Hold.", "2026-10-12T14:00:00Z");
      const E = await job("5 Delivered Dr", { status: "DELIVERED" });
      await line(E.id, "Moved from Review / QC to Delivered with 1 video still missing on Aryeo.", "2026-10-12T14:00:00Z");
      const stamps = async () => new Map((await prisma.project.findMany({ where: { clientId: client.id }, select: { id: true, officeReopenedAt: true } })).map((p) => [p.id, p.officeReopenedAt?.toISOString() ?? null]));

      const dry = await backfillOfficeReopened(prisma as unknown as PrismaClient, { apply: false });
      const afterDry = await stamps();
      c.ok("dry run: plans the two unstamped put-backs and nothing else", dry.plan.length === 2 && dry.plan.some((p) => p.projectId === A.id) && dry.plan.some((p) => p.projectId === B.id) && dry.alreadyStamped === 1, JSON.stringify(dry.plan.map((p) => [p.projectId === A.id ? "A" : p.projectId === B.id ? "B" : "?", p.at.toISOString()])));
      c.ok("…and writes nothing", dry.wrote === 0 && afterDry.get(A.id) === null && afterDry.get(B.id) === null && afterDry.get(C.id) === stampC.toISOString(), JSON.stringify([...afterDry.values()]));

      const run = await backfillOfficeReopened(prisma as unknown as PrismaClient, { apply: true });
      const s = await stamps();
      c.ok("--apply: A from its newest put-back line (the board move to Revisions, not the later moves away)", s.get(A.id) === "2026-10-15T14:00:00.000Z", s.get(A.id) ?? "null");
      c.ok("…B from its newest put-back (the queued new cut, not the older move to In Editing)", s.get(B.id) === "2026-10-19T15:30:00.000Z", s.get(B.id) ?? "null");
      c.ok("…an existing stamp is never overwritten by an older line", s.get(C.id) === stampC.toISOString(), s.get(C.id) ?? "null");
      c.ok("…a move to On Hold and a move to Delivered stamp nothing", s.get(D.id) === null && s.get(E.id) === null);
      c.ok("…two written", run.wrote === 2, String(run.wrote));
      const again = await backfillOfficeReopened(prisma as unknown as PrismaClient, { apply: true });
      c.ok("a second run has nothing to do", again.plan.length === 0 && again.wrote === 0, JSON.stringify(again.plan));
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });

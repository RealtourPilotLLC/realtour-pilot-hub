/**
 * A SENT-BACK CUT ON A JOB THAT WAS DELIVERED AFTERWARDS LEAVES "IN REVISIONS"
 * (Jordan, Sep 28 2026: "38 E Gay St project is done but its still in the
 * review room").
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx \
 *     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/room-delivered-closeout.ts
 *
 * 38 E Gay St was sent back on Sep 1 and delivered on Sep 14; the Review Room
 * still listed it under "In revisions" 27 days later, as did the home card's
 * video review board. The Room already hid a still-PENDING cut on a delivered
 * job; a sent-back one had no such rule. Four jobs, both readers, old code vs
 * new: only the finished one leaves. Isolated PGlite; nothing else touched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5925);
const BASE = "3de6023"; // the code before this change
const REPO = path.resolve(__dirname, "../..");

async function main() {
  installNextStubs();
  fenceFetch();
  const c = makeChecker();
  const db = await bootDrillDb({ port: PORT });
  const { prisma } = await import("@/lib/prisma");
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 16));

  const client = await prisma.client.create({ data: { name: "Joe DRILL" }, select: { id: true } });
  const mk = async (title: string, status: string, deliveredAt: Date | null, decidedAt: Date) => {
    const p = await prisma.project.create({ data: { title, status: status as never, deliveredAt, clientId: client.id }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 }, select: { id: true } });
    await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "CHANGES_REQUESTED", source: "folder", fileName: `${title}.mov`, assetPath: `/final/${title}.mov`, decidedAt, decidedBy: "Jordan", createdAt: new Date(decidedAt.getTime() - 3600_000) },
    });
    return p.id;
  };
  // 1 · the 38 E Gay St shape: sent back Sep 1, delivered Sep 14, still DELIVERED
  const finished = await mk("38 E Gay DRILL", "DELIVERED", day(14), day(1));
  // 2 · sent back AFTER delivery, nobody reopened it: real open work
  const afterDelivery = await mk("After Delivery DRILL", "DELIVERED", day(10), day(20));
  // 3 · a client reopened it after delivery: the job is REVISION again
  const reopened = await mk("Reopened DRILL", "REVISION", day(14), day(22));
  // 4 · an ordinary revision on a job never delivered
  const ordinary = await mk("Ordinary DRILL", "REVISION", null, day(25));

  const room = await import("@/lib/reviewRoom");
  const cuts = await import("@/lib/reviewCuts");
  const roomIds = async (mod: typeof room) => new Set((await mod.getReviewQueue()).waitingOnEditor.map((s) => s.projectId));
  const boardIds = async (mod: typeof cuts) => new Set((await mod.videoReviewBoard()).revising.map((x) => x.projectId));

  c.head("OLD (" + BASE + "): the finished job never leaves");
  // Load the pre-change modules from the pinned commit, with their @/ imports
  // pointed at this tree (only these two files differ).
  // Inside the repo so bare imports (server-only, @prisma/client) resolve; removed below.
  const dir = fs.mkdtempSync(path.join(REPO, "scripts/_drill/.old-room-closeout-"));
  const oldFile = (rel: string) => {
    const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" })
      .replace(/from "@\/lib\/(reviewRoom|reviewCuts)"/g, (_m, n) => `from "${path.join(dir, n)}"`)
      .replace(/from "@\//g, `from "${REPO}/src/`)
      .replace(/import\("@\//g, `import("${REPO}/src/`);
    const out = path.join(dir, path.basename(rel));
    fs.writeFileSync(out, src);
    return out;
  };
  const oldCutsPath = oldFile("src/lib/reviewCuts.ts");
  const oldRoomPath = oldFile("src/lib/reviewRoom.ts");
  const oldRoom = (await import(oldRoomPath)) as typeof room;
  const oldCuts = (await import(oldCutsPath)) as typeof cuts;
  const oR = await roomIds(oldRoom);
  const oB = await boardIds(oldCuts);
  c.ok("OLD Review Room lists 38 E Gay (sent back Sep 1, delivered Sep 14) under In revisions", oR.has(finished), [...oR].length + " rows");
  c.ok("OLD home board lists it too", oB.has(finished));

  c.head("NEW: only the finished job leaves, on both readers");
  const nR = await roomIds(room);
  const nB = await boardIds(cuts);
  c.ok("Review Room: the finished job is gone", !nR.has(finished));
  c.ok("Review Room: sent back AFTER delivery (nobody reopened it) still shows", nR.has(afterDelivery));
  c.ok("Review Room: a job the client reopened still shows", nR.has(reopened));
  c.ok("Review Room: an ordinary revision still shows", nR.has(ordinary));
  c.ok("home board: the finished job is gone", !nB.has(finished));
  c.ok("home board: the other three still show", nB.has(afterDelivery) && nB.has(reopened) && nB.has(ordinary), JSON.stringify([...nB].length));

  c.head("nothing was written: the rows are exactly as they were");
  const rows = await prisma.reviewSubmission.findMany({ select: { status: true, decidedBy: true } });
  c.ok("every cut is still CHANGES_REQUESTED by Jordan (a display rule, not a data change)", rows.length === 4 && rows.every((r) => r.status === "CHANGES_REQUESTED" && r.decidedBy === "Jordan"));

  fs.rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
  c.summary();
  await db.stop();
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

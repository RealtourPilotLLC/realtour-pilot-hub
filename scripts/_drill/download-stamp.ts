/**
 * A DOWNLOAD IS NOT A DELIVERY (Jordan, Sep 21 2026).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server \
 *      npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/download-stamp.ts
 *
 * Runs the shipped readyToSend / markCutDownloaded / markVideoSent against an
 * ISOLATED in-process PGlite Postgres. Production Neon is never touched —
 * DATABASE_URL is overwritten below before any app module loads.
 *
 * WHAT IT HAS TO SHOW. Pressing Download now writes a stamp, and the whole
 * value of the card depends on that stamp never turning into "sent". Three
 * approved videos sat unsent for up to three days (5 Raymond Cir, 453 Cardigan
 * Terrace, 5642 Limeport Rd) precisely because nothing on any screen could say
 * whether a finished file had reached a client — so:
 *
 *   1. a row offers a Dropbox LINK that opens the FILE, not a path, and still
 *      names the file;
 *   2. the hand-off stamps who and when. Since Sep 21 the PRESS no longer
 *      writes it — the two download routes call markCutDownloaded once Dropbox
 *      has handed over a link or the store has started returning bytes, so a
 *      409/404/502 leaves the row honestly untouched. This drill exercises that
 *      same function directly; the routes' own guards (download intent, no
 *      portal token, a real OWNER/ADMIN) live in stampHandOff;
 *   3. the row is STILL on the card afterwards, still owed, with sentToClientAt,
 *      DeliverableOutput.deliveredAt and the project's status all untouched and
 *      no "sent" line on the timeline;
 *   4. the first press wins — a second press by somebody else does not rewrite
 *      the name or restart the clock;
 *   5. marking it sent is what actually clears it, and it leaves the download
 *      stamp alone.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5502;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  if (good) pass++; else fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const DAY = 86_400_000;

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { readyToSend, markCutDownloaded, markVideoSent } = await import("@/lib/readyToSend");

  console.log("=".repeat(74));
  console.log("A download is not a delivery");
  console.log("=".repeat(74));

  // The shape of the three real jobs: an approved cut, bytes in the hub's own
  // store, a filed copy in the job's Final Video folder, no 1080p job (case c).
  const client = await prisma.client.create({ data: { name: "Brie Martinez" }, select: { id: true } });
  const project = await prisma.project.create({
    data: {
      title: "5 Raymond Cir, Royersford, PA", clientId: client.id, status: "EDITING",
      shootDate: new Date(Date.now() - 5 * DAY),
    },
    select: { id: true },
  });
  const deliverable = await prisma.deliverable.create({
    data: { projectId: project.id, type: "VIDEO", label: "Standard Cinematic Video", quantity: 1, manual: false },
    select: { id: true },
  });
  const FINAL = "/AutoHDR/2026/Q3/September/5 Raymond Cir (Brie Martinez)/05-Final-Video/Done_5 Raymond Cir_1.mp4";
  const approvedAt = new Date(Date.now() - 3 * DAY);
  const cut = await prisma.reviewSubmission.create({
    data: {
      projectId: project.id, deliverableId: deliverable.id, slot: 1, round: 1,
      status: "APPROVED", source: "upload", fileName: "Done_5 Raymond Cir_1.mp4",
      blobUrl: "https://blob.invalid/done-5-raymond.mp4", finalPath: FINAL,
      decidedAt: approvedAt, decidedBy: "Kyle", completedAt: approvedAt,
    },
    select: { id: true },
  });
  // The per-video row the project view, the promise clock and the content meter
  // all read. If a download could stamp THIS, the job would read delivered.
  const output = await prisma.deliverableOutput.create({
    data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO" },
    select: { id: true },
  });

  const rowFor = async (id: string) => (await readyToSend()).ready.find((r) => r.submissionId === id) ?? null;

  console.log("\n1. THE ROW AS IT ARRIVES");
  let r = await rowFor(cut.id);
  ok("the approved video is on the card", !!r, r ? `${r.street} · ${r.cutLabel}` : "missing");
  ok("it has been waiting ~3 days", (r?.waitingHours ?? 0) >= 70, `${r?.waitingHours}h`);
  ok("nobody has downloaded it", r?.downloadedAtISO === null && r?.downloadedHoursAgo === null);

  console.log("\n2. A LINK, NOT A PATH (Jordan: \"a link to the dropbox would be better\")");
  ok("the row carries a Dropbox web link", (r?.file.dropboxUrl ?? "").startsWith("https://www.dropbox.com/home/"), r?.file.dropboxUrl ?? "none");
  // THE SHAPE, NOT THE INGREDIENTS (review, Sep 21 2026). This check used to
  // read "the link is built from the file's OWN path", which passed happily
  // while the URL was /home/<the whole file path> under a label reading "Open
  // the Dropbox folder" — a test of how the string was assembled, not of where
  // it goes. The known-good form for linking to a FILE is the one
  // src/app/edit/[id]/page.tsx:225 and components/editing/music.actions.ts:607
  // already use: the PARENT folder under /home, with the file named in
  // ?preview=. Built here from the raw path the same way they build theirs, so
  // this asserts against the repo's proven form rather than against
  // readyToSend's own helper.
  const parentOf = FINAL.slice(0, FINAL.lastIndexOf("/"));
  const nameOf = FINAL.slice(FINAL.lastIndexOf("/") + 1);
  const knownGood = `https://www.dropbox.com/home${parentOf.split("/").map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(nameOf)}`;
  ok("the link opens the FILE, the way /edit/[id] does: parent folder + ?preview=", r?.file.dropboxUrl === knownGood, r?.file.dropboxUrl ?? "none");
  ok("the path in the URL stops at the folder, so /home isn't handed a file", !decodeURIComponent((r?.file.dropboxUrl ?? "").split("?")[0]).endsWith(nameOf));
  ok("the spaces and brackets are escaped, so the URL survives a paste", !(r?.file.dropboxUrl ?? "x").includes(" "));
  ok("the full path is still on the row for the day the link misses", r?.file.dropboxPath === FINAL);
  ok("the file name is still named — that is what you check a download against", r?.file.fileName === "Done_5 Raymond Cir_1.mp4");

  console.log("\n3. THE HAND-OFF (what the download route calls once the file was served)");
  const first = await markCutDownloaded(cut.id, "Kyle");
  ok("the hand-off is recorded", first.ok && !first.already, first.message);
  r = await rowFor(cut.id);
  ok("the row says who has it", r?.downloadedBy === "Kyle", r?.downloadedBy ?? "nobody");
  ok("…and since when", r?.downloadedAtISO != null && (r?.downloadedHoursAgo ?? 99) === 0);

  console.log("\n4. AND IT IS STILL OWED — the whole point");
  ok("THE ROW IS STILL ON THE CARD", !!r);
  const after = await prisma.reviewSubmission.findUniqueOrThrow({
    where: { id: cut.id },
    select: { sentToClientAt: true, sentToClientBy: true, status: true },
  });
  ok("sentToClientAt is untouched", after.sentToClientAt === null);
  ok("the cut is still APPROVED, not something else", after.status === "APPROVED");
  const out = await prisma.deliverableOutput.findUniqueOrThrow({
    where: { id: output.id },
    select: { deliveredAt: true, deliveredBy: true, sentSubmissionId: true },
  });
  ok("the per-video row is NOT delivered", out.deliveredAt === null && out.sentSubmissionId === null);
  const proj = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { status: true, deliveredAt: true } });
  ok("the project is not marked delivered", proj.status === "EDITING" && proj.deliveredAt === null);
  const acts = await prisma.activity.count({ where: { projectId: project.id } });
  ok("nothing claimed on the timeline that a video went out", acts === 0, `${acts} activity rows`);

  console.log("\n5. THE FIRST HAND-OFF WINS");
  const second = await markCutDownloaded(cut.id, "Jordan");
  ok("a second one is accepted and says so", second.ok && second.already === true, second.message);
  const stamp = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id }, select: { downloadedBy: true, downloadedAt: true } });
  ok("the first person's name survives", stamp.downloadedBy === "Kyle", stamp.downloadedBy ?? "none");
  const held = stamp.downloadedAt!.getTime();
  await markCutDownloaded(cut.id, "Jordan");
  ok("and the clock is not restarted", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id }, select: { downloadedAt: true } })).downloadedAt!.getTime() === held);

  console.log("\n6. WHAT ACTUALLY CLEARS IT");
  const sent = await markVideoSent(cut.id, "Kyle");
  ok("marking it sent is accepted", sent.ok && !sent.already, sent.message);
  ok("NOW the row leaves the card", (await rowFor(cut.id)) === null);
  const done = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id }, select: { sentToClientAt: true, downloadedAt: true, downloadedBy: true } });
  ok("sentToClientAt is set by the press, not by the download", done.sentToClientAt !== null);
  ok("the download stamp is left exactly as it was", done.downloadedAt!.getTime() === held && done.downloadedBy === "Kyle");

  console.log("\n7. A CUT WITH NO PATH ANYWHERE — no link to offer, and it says so");
  const p2 = await prisma.project.create({
    data: { title: "453 Cardigan Terrace, Royersford, PA", clientId: client.id, status: "EDITING", shootDate: new Date(Date.now() - 2 * DAY) },
    select: { id: true },
  });
  const d2 = await prisma.deliverable.create({
    data: { projectId: p2.id, type: "VIDEO", label: "Standard Cinematic Video", quantity: 1, manual: false },
    select: { id: true },
  });
  const cut2 = await prisma.reviewSubmission.create({
    data: {
      projectId: p2.id, deliverableId: d2.id, slot: 1, round: 1, status: "APPROVED", source: "upload",
      fileName: "Cardigan_1.mp4", blobUrl: "https://blob.invalid/cardigan.mp4",
      decidedAt: new Date(Date.now() - 2 * DAY), decidedBy: "Kyle",
    },
    select: { id: true },
  });
  const r2 = await rowFor(cut2.id);
  ok("the row is on the card", !!r2);
  ok("no filed copy means no link, and no invented one", r2?.file.dropboxUrl === null && r2?.file.dropboxPath === null);
  ok("the Download button still has bytes to hand over", (r2?.file.downloadHref ?? "").includes(`/api/review/cut/${cut2.id}/stream`));
  // dl=1 is what tells the stream route this is the office TAKING the file
  // rather than somebody pressing play on it — the route stamps nothing
  // without it, and every row's Download href has to carry it.
  ok("and it asks as a download, not as playback", (r2?.file.downloadHref ?? "").includes("dl=1"), r2?.file.downloadHref ?? "none");

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

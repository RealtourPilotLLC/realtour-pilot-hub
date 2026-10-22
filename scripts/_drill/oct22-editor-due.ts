// ---------------------------------------------------------------------------
// DRILL: THE EDIT'S DUE DATE IN EVERY "YOU HAVE WORK" MESSAGE (Oct 22 2026).
// Jordan: "it would be helpful for the editors to know when a project is due."
//   · the words: Eastern day and hour, with the editor's own time beside it;
//   · editDueFor reads the same date as the brief's header (the video clock
//     from the visit that shot it), and an office date override wins;
//   · a job that owes no video has no date and no words;
//   · the four messages carry the words (source checks).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6427) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const ed = await import("@/lib/editorDue");

    c.head("1 · the words");
    const due = new Date("2026-10-23T20:00:00Z"); // Fri Oct 23, 4 PM ET = Sat Oct 24, 4 AM Manila
    const w = ed.dueWordsFor(due, "Asia/Manila");
    c.ok("Eastern day and hour, then the editor's own", w === "due Fri, Oct 23, 4 PM ET (Sat, Oct 24, 4 AM Manila)", w);
    c.ok("an Eastern reader gets one time", ed.dueWordsFor(due, "America/New_York") === "due Fri, Oct 23, 4 PM ET", ed.dueWordsFor(due, "America/New_York"));
    c.ok("minutes are kept when they are not :00", ed.dueWordsFor(new Date("2026-10-23T20:30:00Z"), null) === "due Fri, Oct 23, 4:30 PM ET");
    c.ok("no em dash in the words", !/[—–]/.test(w));

    c.head("2 · the date is the brief's");
    const client = await prisma.client.create({ data: { name: "Due Drill" } });
    const reel = await prisma.project.create({ data: { title: "1 Reel Rd, Malvern, PA", clientId: client.id, status: "EDITING", shootDate: new Date("2026-10-21T14:00:00Z") } });
    await prisma.deliverable.create({ data: { projectId: reel.id, type: "SOCIAL_REEL" as never, label: "Social Reel" } });
    const d1 = await ed.editDueFor(reel.id);
    c.ok("a standard reel: 48 hours from the shoot", d1?.toISOString() === "2026-10-23T14:00:00.000Z", d1?.toISOString());
    await prisma.project.update({ where: { id: reel.id }, data: { dueOverrideAt: new Date("2026-10-25T21:00:00Z") } });
    c.ok("an office date override wins", (await ed.editDueFor(reel.id))?.toISOString() === "2026-10-25T21:00:00.000Z");
    const photosOnly = await prisma.project.create({ data: { title: "2 Still St, Malvern, PA", clientId: client.id, status: "EDITING", shootDate: new Date("2026-10-21T14:00:00Z") } });
    await prisma.deliverable.create({ data: { projectId: photosOnly.id, type: "PHOTOS" as never, label: "Photos" } });
    c.ok("a job that owes no video: no date, no words", (await ed.editDueFor(photosOnly.id)) === null && (await ed.editDueWords(photosOnly.id, "kim")) === "");
    c.ok("the words for Kim are in Manila time too", /\(.* Manila\)$/.test(await ed.editDueWords(reel.id, "kim")), await ed.editDueWords(reel.id, "kim"));

    c.head("3 · the messages carry it");
    // Oct 22 2026 (audit L1): each title is built by editDueTitle, which keeps
    // the due words whole under the bell's 90-character cut.
    c.ok("Ready for editing", /Ready for editing — \$\{street\}`;\s*const title = await \(await import\("@\/lib\/editorDue"\)\)\.editDueTitle\(head, projectId, routedKey\)/.test(read("src/lib/tasks.ts")));
    c.ok("Reassigned to you and New edit", /editDueTitle\(`Reassigned to you — \$\{street\}`, projectId, key\)/.test(read("src/app/editing/actions.ts")) && /editDueTitle\(`New edit — \$\{street\}`, projectId, key\)/.test(read("src/app/editing/actions.ts")));
    c.ok("Task for you", /editDueTitle\(head, t\.projectId, assignedKey\)/.test(read("src/app/actions.ts")));
    c.ok("the desk list shows the hour in their time", /your time/.test(read("src/components/editing/EditorDesk.tsx")) && /dueWords\(j, tz\)/.test(read("src/components/editing/EditorDesk.tsx")));

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

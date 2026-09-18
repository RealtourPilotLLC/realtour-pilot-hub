// THE "REPLACE THE APPROVED VIDEO" DOOR, drilled on the real cut slots.
//
// One number matters: the doors that RENDER and the doors the server would
// ACCEPT have to be the same set. They were not. The /edit panel drew the door
// from the viewer's role and the cut's status alone, while uploadAuthor scoped
// an EDITOR to a job carrying an OPEN edit_video/revision task assigned to them
// — which is exactly the task an approved, submitted and delivered cut has
// already closed. So the refusal arrived after the editor had picked the file
// and typed their justification.
//
// The drill walks every (approved cut slot × real EDITOR account) pair, because
// that pair is what a rendered door actually is: any editor can open
// /edit/<id>, the panel has no per-editor gate of its own. For each pair it
// asks the four questions in the two regimes.
//
// Read-only. Every query is a findMany/count; nothing is written.
//
// Run:
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/replace-approved.ts
import { prisma } from "@/lib/prisma";
import { videoLaneRevisionWhere } from "@/lib/reviewCuts";

// The page's OWN copy of "is a video-lane revision open", as it stood before
// the fix — kept here so the drill can SHOW the drift rather than assert it.
// The server's copy also counts external_agency, also counts a task titled
// "Video revision…" / "New cut…" whatever key it carries, and subtracts the
// photo-lane dedupe key.
const OLD_PAGE_KEYS = new Set(["kim", "john", "remar", "luma"]);

async function main() {
  // Only slots — deliverable × slot. A legacy row the Dropbox sweep filed with
  // no deliverable never becomes a row in the Send-to-Review panel, so it can
  // never draw a door. (The Sep 18 commit counted those in its "20 cut slots".)
  const subs = await prisma.reviewSubmission.findMany({
    where: { kind: "video", deliverableId: { not: null } },
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, round: true, status: true,
      submittedByKey: true, submittedByName: true, sentToClientAt: true,
      project: { select: { title: true, editorVendorKey: true } },
    },
    orderBy: { round: "asc" },
  });
  // The STANDING version of each slot — UPLOADING / UPLOAD_FAILED / WITHDRAWN
  // are not versions in play, which is the rule the page and startCutUpload
  // both already use.
  const standing = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    if (["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"].includes(s.status)) continue;
    standing.set(`${s.projectId}|${s.deliverableId}|${s.slot}`, s); // round-asc → latest wins
  }

  const projectIds = [...new Set([...standing.values()].map((s) => s.projectId))];
  const openTasks = await prisma.smartTask.findMany({
    where: {
      projectId: { in: projectIds },
      taskType: { in: ["edit_video", "revision"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: { id: true, projectId: true, taskType: true, assignedKey: true, title: true },
  });
  // The server's predicate, asked of the database rather than restated.
  const serverLaneIds = new Set<string>();
  for (const pid of projectIds) {
    for (const r of await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(pid), select: { id: true } })) serverLaneIds.add(r.id);
  }
  const serverRevisionOpen = (pid: string) => openTasks.some((t) => t.projectId === pid && serverLaneIds.has(t.id));
  const oldPageRevisionOpen = (pid: string) =>
    openTasks.some((t) => t.projectId === pid && t.taskType === "revision" && (t.assignedKey == null || OLD_PAGE_KEYS.has(t.assignedKey)));

  // Who can actually sign in as an EDITOR. Their key is what uploadAuthor
  // compares against, so these are the people a door is drawn for.
  const editorAccounts = await prisma.appUser.findMany({
    where: { role: "EDITOR", status: { not: "DISABLED" } },
    select: { email: true, name: true, editorKey: true },
  });
  const editorKeys = [...new Set(editorAccounts.map((u) => u.editorKey).filter((k): k is string => !!k))];
  console.log(`EDITOR accounts that can sign in: ${editorAccounts.length} · keys: ${editorKeys.join(", ") || "(none)"}`);

  const approved = [...standing.values()].filter((s) => s.status === "APPROVED");
  console.log(`Cut slots holding a standing version: ${standing.size} · of them APPROVED: ${approved.length}`);
  console.log(`  already sent to the client: ${approved.filter((s) => s.sentToClientAt).length}`);
  console.log(`Page/server disagreement about an open video revision, on a job with an approved cut: ${approved.filter((s) => oldPageRevisionOpen(s.projectId) !== serverRevisionOpen(s.projectId)).length}`);

  let oldDoors = 0, oldDead = 0, newDoors = 0, newDead = 0, lost = 0;
  const lines: string[] = [];
  for (const s of approved) {
    const pid = s.projectId;
    for (const ek of editorKeys) {
      const hasOpenTask = openTasks.some((t) => t.projectId === pid && t.assignedKey === ek);
      // BEFORE — the door: role + APPROVED + the page's own revision test.
      const doorBefore = !oldPageRevisionOpen(pid);
      // BEFORE — the server: an EDITOR needs an open task of their own.
      const serverBefore = hasOpenTask;
      // AFTER — the server: a replacement (an upload carrying a reason) also
      // takes the editor whose key is on the standing APPROVED version of this
      // exact slot.
      const serverAfter = hasOpenTask || s.submittedByKey === ek;
      // AFTER — the door: it asks the server (canReplaceApprovedCut), so it is
      // the same answer by construction. What the drill measures is the
      // POPULATION that changes hands.
      const doorAfter = !serverRevisionOpen(pid) && serverAfter;
      if (doorBefore) {
        oldDoors++;
        if (!serverBefore) oldDead++;
      }
      if (doorAfter) newDoors++;
      if (doorAfter && !serverAfter) newDead++;
      if (doorBefore && serverBefore && !doorAfter) lost++;
      if (doorBefore && !serverBefore) {
        lines.push(
          `  DEAD DOOR (before) ${ek} on ${s.project.title?.split(",")[0]} v${s.round}` +
            ` · made by ${s.submittedByKey ?? `(no key — ${s.submittedByName ?? "nobody"})`}` +
            ` · now ${serverAfter ? "OPENS" : "not drawn (office only)"}` +
            `${s.sentToClientAt ? " · already sent to the client" : ""}` +
            `${s.project.editorVendorKey ? ` · vendor=${s.project.editorVendorKey}` : ""}`,
        );
      }
    }
  }
  console.log("");
  console.log(`(approved slot × editor) doors drawn BEFORE: ${oldDoors} — of which the server refuses: ${oldDead}`);
  console.log(`(approved slot × editor) doors drawn AFTER:  ${newDoors} — of which the server refuses: ${newDead}`);
  console.log(`Doors that worked before and are gone now: ${lost}`);
  console.log(lines.join("\n"));
  console.log("");
  console.log("Per approved slot, who the door is now drawn for:");
  for (const s of approved) {
    const forKeys = editorKeys.filter((ek) => !serverRevisionOpen(s.projectId) && (openTasks.some((t) => t.projectId === s.projectId && t.assignedKey === ek) || s.submittedByKey === ek));
    console.log(`  ${s.project.title?.split(",")[0]} v${s.round} → ${forKeys.length ? forKeys.join(", ") : "office only (owner/admin)"}`);
  }
  await prisma.$disconnect();
}
void main();

// READ-ONLY. Sizing the revision-linkage change: which open revisions sit on a
// job with more than one owed cut, and whether any review round points at a
// slot cutSlots no longer mints.
import { prisma } from "@/lib/prisma";
import { cutSlots, videoLaneRevisionWhere } from "@/lib/reviewCuts";

async function main() {
  const open = await prisma.smartTask.findMany({
    where: { taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, projectId: true, title: true, createdAt: true, assignedKey: true },
  });
  console.log(`open revision tasks: ${open.length}`);
  for (const t of open) {
    if (!t.projectId) { console.log(`  (no project) ${t.title}`); continue; }
    const slots = await cutSlots(t.projectId).catch(() => []);
    const lane = await prisma.smartTask.count({ where: videoLaneRevisionWhere(t.projectId) });
    const briefs = await prisma.revisionBrief.findMany({
      where: { projectId: t.projectId }, orderBy: { createdAt: "desc" }, take: 1,
      select: { id: true, itemsJson: true, doneJson: true, createdAt: true },
    });
    let items = 0, done = 0, scoped = 0;
    if (briefs[0]?.itemsJson) {
      try {
        const parsed = JSON.parse(briefs[0].itemsJson) as { items?: { cuts?: string[] }[] };
        items = parsed.items?.length ?? 0;
        scoped = (parsed.items ?? []).filter((i) => Array.isArray(i.cuts) && i.cuts.length > 0).length;
      } catch { /* unreadable */ }
    }
    if (briefs[0]?.doneJson) { try { done = (JSON.parse(briefs[0].doneJson) as string[]).length; } catch { /* */ } }
    console.log(`  ${t.title} — owed cuts ${slots.length}, video-lane rows ${lane}, brief items ${items} (scoped ${scoped}, ticked ${done})`);
  }

  // Review rounds pointing at a slot the current arithmetic does not mint.
  const subs = await prisma.reviewSubmission.findMany({
    where: { deliverableId: { not: null } },
    select: { id: true, projectId: true, deliverableId: true, slot: true, status: true, fileName: true },
  });
  console.log(`\nreview rounds with a deliverable identity: ${subs.length}`);
  const byProject = new Map<string, typeof subs>();
  for (const s of subs) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);
  let orphan = 0;
  for (const [pid, rows] of byProject) {
    const keys = new Set((await cutSlots(pid).catch(() => [])).map((s) => `${s.deliverableId}:${s.slot}`));
    for (const r of rows) {
      const k = `${r.deliverableId}:${r.slot ?? 1}`;
      if (!keys.has(k)) { orphan++; console.log(`  ORPHAN round ${r.id} ${k} [${r.status}] ${r.fileName ?? ""}`); }
    }
  }
  console.log(`rounds whose slot is not in cutSlots: ${orphan}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

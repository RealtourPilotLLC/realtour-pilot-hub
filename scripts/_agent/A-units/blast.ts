// READ-ONLY. The blast radius of the new close rule: for every open revision in
// production, what the OLD heuristic would have said versus what the new
// per-video rule says, if a cut were approved right now.
import { prisma } from "@/lib/prisma";
import { cutSlots, slotKeyOf, videoLaneRevisionWhere } from "@/lib/reviewCuts";
import { outstandingItems, outstandingReason, type ScopedItem } from "@/lib/revisionBrief";

async function main() {
  const tasks = await prisma.smartTask.findMany({
    where: { taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, projectId: true, title: true, createdAt: true },
  });
  console.log(`open revision tasks: ${tasks.length}`);
  for (const t of tasks) {
    if (!t.projectId) continue;
    const lane = await prisma.smartTask.count({ where: videoLaneRevisionWhere(t.projectId) });
    const p = await prisma.project.findUnique({ where: { id: t.projectId }, select: { revisionRequestedAt: true } });
    const raisedAt = p?.revisionRequestedAt ?? t.createdAt;
    const since = await prisma.reviewSubmission.findMany({
      where: { projectId: t.projectId, kind: "video", createdAt: { gte: raisedAt }, status: { notIn: ["WITHDRAWN", "UPLOAD_FAILED"] } },
      select: { id: true, deliverableId: true, slot: true, assetPath: true, status: true },
    });
    const approvedBySlot = new Map<string, boolean>();
    for (const r of since) {
      const k = r.deliverableId ? slotKeyOf(r.deliverableId, r.slot) : (r.assetPath ?? r.id);
      approvedBySlot.set(k, (approvedBySlot.get(k) ?? false) || r.status === "APPROVED");
    }
    const approvedKeys = new Set([...approvedBySlot.entries()].filter(([, ok]) => ok).map(([k]) => k));
    const brief = await prisma.revisionBrief.findFirst({
      where: { projectId: t.projectId, createdAt: { gte: new Date(raisedAt.getTime() - 60_000) } },
      orderBy: { createdAt: "desc" },
      select: { itemsJson: true, doneJson: true },
    });
    let items: ScopedItem[] = [];
    let done: string[] = [];
    try { items = brief?.itemsJson ? ((JSON.parse(brief.itemsJson) as { items?: ScopedItem[] }).items ?? []) : []; } catch { /* */ }
    try { done = brief?.doneJson ? (JSON.parse(brief.doneJson) as string[]) : []; } catch { /* */ }
    const owedKeys = (await cutSlots(t.projectId).catch(() => [])).map((s) => slotKeyOf(s.deliverableId, s.slot));

    // OLD rule: a slot re-cut since the ask and not approved, or a partly ticked brief.
    const waiting = [...approvedBySlot.values()].filter((ok) => !ok).length;
    const oldHold = waiting > 0 || (items.length > 0 && done.length > 0 && done.length < items.length);
    // NEW rule.
    const open = items.length > 0 ? outstandingItems({ items, done, approvedKeys, owedKeys }) : [];
    const newHold = items.length > 0 ? open.length > 0 : waiting > 0;
    console.log(
      `\n${t.title}\n  video-lane rows ${lane} · owed cuts ${owedKeys.length} · rounds since the ask ${since.length} ` +
        `· brief items ${items.length} (ticked ${done.length})\n  OLD would hold: ${oldHold}   NEW would hold: ${newHold}` +
        (newHold && open.length ? `\n  reason: ${outstandingReason(open, items.length)}` : ""),
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

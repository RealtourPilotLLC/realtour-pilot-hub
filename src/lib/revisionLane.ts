import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";
import { isEcho, mediumOfItem } from "@/lib/itemMedium";

// ---------------------------------------------------------------------------
// THE REVISION'S LANE, FROM WHAT ITS ITEMS ASK FOR (Oct 22 2026, video audit
// H3b). raiseRevision (lib/comms) picks the task's lane (the editor's video
// card, or Kyle's photo / unclear card) from the WORDS of the message, before
// the work order is read. On 859 N Lawrence St all three revision tasks went
// to Kyle, the purely video "Cafe La Maude sign" text included: its ask
// sentence names neither a video nor a photo, the job has photos too, and the
// conversation around it was about staged photos. No card reached John.
//
// Once the analyser has split the message into items and labelled each one
// (lib/itemMedium), the lane is set again from them:
//   · any item about the video (video or both): the editor's video card;
//   · every item about the photos only: Kyle's photo card (the photo part is
//     already on the photo job's asks, lib/briefPhotoAsks);
//   · nothing placed (no items, unclear only, echoes of earlier messages):
//     left where it is.
// Only a task this message made is moved; a card carrying other asks, or one
// a person assigned by hand, is left alone. A portal or staff ask is pinned
// to a video and never moves. Never throws.
// ---------------------------------------------------------------------------

export type RevisionLane = "video" | "photo";

/** Pure: the lane this work order's own items ask for, or null when they do not say. */
export function laneFromItems(items: { medium?: unknown; quote?: string | null }[], message: string): RevisionLane | null {
  const own = items.filter((it) => !isEcho(it.quote ?? null, message));
  const media = own.map((it) => mediumOfItem(it));
  if (media.some((m) => m === "video" || m === "both")) return "video";
  if (media.length > 0 && media.every((m) => m === "photo")) return "photo";
  return null;
}

/** Pure: which lane a revision task is on now, read from its key and title. */
export function laneOfTask(t: { dedupeKey: string | null; title: string | null }, photoKey: string): RevisionLane | "unclear" {
  if (t.dedupeKey === photoKey) return "photo";
  if (/^Video revision/.test(t.title ?? "")) return "video";
  return "unclear";
}

const DONE = ["COMPLETED", "CANCELLED"];
const VIDEO_ONLY_SOURCES = new Set(["portal", "review_room_staff"]);

export type LaneMove = { briefId: string; taskId: string; from: RevisionLane | "unclear"; to: RevisionLane; assignedKey: string | null; mergedInto: string | null; dryRun: boolean };

/**
 * Set this work order's task on the lane its items ask for. `dryRun`: say
 * what would move, write nothing. Null when nothing moves.
 */
export async function settleRevisionLane(briefId: string, opts: { dryRun?: boolean } = {}): Promise<LaneMove | null> {
  try {
    return await settle(briefId, !!opts.dryRun);
  } catch (e) {
    console.error("[revision lane] settling failed", briefId, e);
    return null;
  }
}

async function settle(briefId: string, dryRun: boolean): Promise<LaneMove | null> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: { id: true, projectId: true, taskId: true, source: true, decisionId: true, submissionId: true, originalText: true, itemsJson: true },
  });
  if (!brief?.taskId || !brief.itemsJson || VIDEO_ONLY_SOURCES.has(brief.source) || brief.decisionId || brief.submissionId) return null;
  let items: { medium?: unknown; quote?: string | null }[] = [];
  try { items = (JSON.parse(brief.itemsJson) as { items?: typeof items }).items ?? []; } catch { return null; }
  const want = laneFromItems(items, brief.originalText);
  if (!want) return null;

  const task = await prisma.smartTask.findUnique({
    where: { id: brief.taskId },
    select: { id: true, status: true, title: true, dedupeKey: true, assignedKey: true, assignedManually: true, description: true, summary: true, taskType: true },
  });
  if (!task || task.taskType !== "revision" || DONE.includes(task.status) || task.assignedManually) return null;
  const { revisionTaskKey } = await import("@/lib/comms");
  const videoKey = revisionTaskKey(brief.projectId, false);
  const photoKey = revisionTaskKey(brief.projectId, true);
  const now = laneOfTask(task, photoKey);
  if (now === want) return null;
  // A move to another card's key: only a card this message made (another ask
  // on it keeps it where it is). The unclear card becoming the video card
  // keeps its key, its asks and its history: only who has it changes.
  const keyChanges = task.dedupeKey !== (want === "video" ? videoKey : photoKey);
  if (keyChanges && (await prisma.revisionBrief.count({ where: { taskId: task.id, id: { not: briefId } } })) > 0) return null;

  const project = await prisma.project.findUnique({
    where: { id: brief.projectId },
    select: { title: true, contentMonthId: true, editorManual: true, editorVendorKey: true, editor: { select: { name: true } }, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } } },
  });
  if (!project) return null;
  const videoDeliv = project.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (want === "video" && !videoDeliv) return null;
  let assignedKey: string | null = "kyle";
  if (want === "video") {
    // The same routing raiseRevision uses for a video ask: the pinned editor, else the rules.
    const { editorForDeliverable, pinnedEditorFor } = await import("@/lib/editors");
    const { isMonthlyContentJob } = await import("@/lib/pipeline");
    const { editorRouting } = await import("@/lib/settings");
    const pin = pinnedEditorFor(project);
    const pinnedKey = pin.pinned ? (pin.key === "kim" || pin.key === "john" || pin.key === "remar" ? pin.key : "kyle") : null;
    assignedKey = pinnedKey ?? editorForDeliverable(videoDeliv!.type, videoDeliv!.label, isMonthlyContentJob(project.deliverables), await editorRouting());
  }
  const toKey = want === "video" ? videoKey : photoKey;
  const title = `${want === "video" ? "Video revision" : "Photo revision"} — ${project.title}`;
  const move: LaneMove = { briefId, taskId: task.id, from: now, to: want, assignedKey, mergedInto: null, dryRun };

  // The lane's key may already be held by another card.
  const holder = task.dedupeKey === toKey ? null : await prisma.smartTask.findUnique({ where: { dedupeKey: toKey }, select: { id: true, status: true, description: true } });
  if (holder && !DONE.includes(holder.status)) {
    // That lane's card is open: this ask joins it, and this card closes.
    move.mergedInto = holder.id;
    if (dryRun) return move;
    const words = clip(task.description ?? brief.originalText, 1500);
    const description = holder.description?.includes(words) ? holder.description : `${holder.description ?? ""}\n\nNew request: ${words}`.trim();
    await prisma.smartTask.update({ where: { id: holder.id }, data: { description: description.length > 4000 ? "…" + description.slice(-4000) : description } });
    await prisma.revisionBrief.update({ where: { id: briefId }, data: { taskId: holder.id } });
    await prisma.smartTask.update({ where: { id: task.id }, data: { status: "CANCELLED", completedAt: new Date() } });
    await note(brief.projectId, `Revision moved to the ${want === "video" ? "editor's video" : "photo"} card: its items are about the ${want === "video" ? "video" : "photos"}.`);
    return move;
  }
  if (dryRun) return move;
  if (holder) {
    // A finished card holds the key: it keeps its history under a retired key.
    await prisma.smartTask.update({ where: { id: holder.id }, data: { dedupeKey: `${toKey}:retired:${holder.id}` } });
  }
  await prisma.smartTask.update({
    where: { id: task.id },
    data: {
      dedupeKey: toKey,
      title,
      assignedKey,
    },
  });
  await note(brief.projectId, `Revision set on the ${want === "video" ? "editor's video" : "photo"} card${assignedKey ? ` (${assignedKey})` : ""}: its items are about the ${want === "video" ? "video" : "photos"}.`);
  return move;
}

async function note(projectId: string, body: string): Promise<void> {
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: clip(body, 300) } }).catch(() => null);
}

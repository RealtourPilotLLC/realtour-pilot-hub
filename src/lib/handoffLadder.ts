import "server-only";
import { prisma } from "@/lib/prisma";
import { handoffEvidence, ladderRows, type CategoryEvidence, type LadderRow } from "@/lib/handoff";

// ---------------------------------------------------------------------------
// THE EVIDENCE LADDER, READ ONCE (§7.3, Sep 28 2026).
//
// lib/handoff's handoffEvidence is the pure reader: ticked, found, handed off,
// ready or blocked, started, cuts. Until now only the upload page fed it, from
// its own project read, so the edit tracker and the project summary said
// nothing about the files at all. This is the one database read behind both of
// them. It asks exactly two things the upload page never needed:
//
//   · editing STARTED — an editor pressed Start (EditorWorkItem.firstStartedAt,
//     §7.1). Never inferred from the job's EDITING status, which a board move
//     or an office pin also sets.
//   · cuts HANDED IN — distinct videos with a version in review or decided,
//     never one still uploading, failed or taken back.
//
// Read-only. The one write in this file is stampRawIn below, and only the
// status sweep calls it.
// ---------------------------------------------------------------------------

const NOT_HANDED_IN = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];

/** The ladder for one job, one entry per half it owes; null when the job is not there. */
export async function handoffLadderFor(projectId: string): Promise<CategoryEvidence[] | null> {
  const [p, started, subs] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        statusEvidence: true, photosHandoffAt: true, videoHandoffAt: true, debriefSubmittedAt: true,
        handoffReadyAt: true, handoffBlockedReason: true,
        deliverables: { select: { type: true, uploadedAt: true, notCompletedReason: true, waivedAt: true, removedFromOrderAt: true } },
      },
    }),
    prisma.editorWorkItem.findFirst({
      where: { projectId, firstStartedAt: { not: null } },
      orderBy: { firstStartedAt: "asc" },
      select: { firstStartedAt: true },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId, withdrawnAt: null, status: { notIn: NOT_HANDED_IN } },
      select: { id: true, deliverableId: true, slot: true, assetPath: true },
    }),
  ]);
  if (!p) return null;
  // A video handed in three times is still one cut: key by the slot, or by
  // the file for a round from before rounds carried one.
  const cuts = new Set(subs.map((s) => (s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : s.assetPath ?? s.id))).size;
  return handoffEvidence({
    deliverables: p.deliverables,
    statusEvidence: p.statusEvidence,
    photosHandoffAt: p.photosHandoffAt,
    videoHandoffAt: p.videoHandoffAt,
    debriefSubmittedAt: p.debriefSubmittedAt,
    handoffReadyAt: p.handoffReadyAt,
    handoffBlockedReason: p.handoffBlockedReason,
    editingStartedAt: started?.firstStartedAt ?? null,
    outputsSubmitted: cuts,
  });
}

/** The same ladder, as screens print it (Eastern times). Empty when the job owes neither half. */
export async function handoffLadderRows(projectId: string): Promise<LadderRow[]> {
  const ev = await handoffLadderFor(projectId);
  return ev ? ladderRows(ev) : [];
}

// ---------------------------------------------------------------------------
// RAWS IN, PER VIDEO (DeliverableOutput.rawInAt — COMPLETION-CONTRACT §9).
//
// The column has existed since Sep 18 and nothing wrote it. It means "this
// video's raw footage was first confirmed in Dropbox", so it is written only
// when that is PROVABLE for that one video:
//
//   · by the status sweep, on a FRESH read that found files in the job's Raw
//     Video folder — a stale (carried-forward) count proves nothing new, and a
//     failed read is unknown, never evidence;
//   · only when the job owes exactly ONE live video. The job has one Raw Video
//     folder; with two videos in it (a reel and an MLS video, a four-video
//     session) files in the folder do not say whose raws they are, and a
//     guess here would be the tick-is-a-file mistake over again. Those stay
//     unstamped until something can tell them apart (a per-topic count);
//   · once — the FIRST confirmation. A later pass never moves it;
//   · only by the pass that FIRST sees the footage (firstSightOfRawVideo,
//     review Sep 28). A job whose last evidence already showed raw video had
//     its raws confirmed by an earlier pass (every job in flight the day this
//     shipped: the sweep found its footage days before and set uploadedAt), so
//     "now" would be days late, and nothing ever corrects the stamp. Those
//     stay unstamped: unknown, not wrong;
//   · never on a job already delivered: its raws were in before then;
//   · never back-dated or invented on a video that already has a cut handed
//     in (reviewReadyAt): its raws were in before then, and "now" would be a
//     lie about when.
//
// evidenceSource is recorded only when the row has none yet, so a delivery's
// "review-sent" is never overwritten by the older fact.
// ---------------------------------------------------------------------------
export const RAW_IN_SOURCE = "dropbox-raw-video";

/**
 * Is this pass the FIRST to see the job's raw video? Only then is its read
 * time the moment the raws were first confirmed. `prior` is the Dropbox half
 * of the evidence the job carried INTO this pass (parseEvidence(...).dropbox).
 *   · it has a raw-video count: first sight only if that count was 0 (the
 *     last reading saw none, so the footage arrived since);
 *   · it has none (never read, read failed past the 48h carry, or Aryeo alone
 *     answered): first sight only if no raws were ever detected on the job
 *     (Project.uploadedAt still empty). Otherwise the hub may well have seen
 *     them before, and the stamp stays unknown rather than late.
 * Pure.
 */
export function firstSightOfRawVideo(
  prior: { rawVideo?: number | null } | null | undefined,
  uploadedAt: Date | null | undefined,
): boolean {
  if (prior && typeof prior.rawVideo === "number") return !(prior.rawVideo > 0);
  return !uploadedAt;
}

export async function stampRawIn(projectId: string, at: Date): Promise<{ stamped: number; reason: string }> {
  const outs = await prisma.deliverableOutput.findMany({
    where: { projectId, category: "VIDEO", waivedAt: null, removedFromOrderAt: null },
    select: { id: true, rawInAt: true, reviewReadyAt: true },
  });
  if (outs.length === 0) return { stamped: 0, reason: "no video owed" };
  if (outs.length > 1) return { stamped: 0, reason: "more than one video shares the Raw Video folder" };
  const o = outs[0];
  if (o.rawInAt) return { stamped: 0, reason: "already stamped" };
  if (o.reviewReadyAt) return { stamped: 0, reason: "a cut was already handed in" };
  const when = Number.isNaN(at.getTime()) ? new Date() : at;
  const r = await prisma.deliverableOutput.updateMany({
    where: { id: o.id, rawInAt: null, reviewReadyAt: null },
    data: { rawInAt: when },
  });
  if (r.count === 1) {
    await prisma.deliverableOutput.updateMany({ where: { id: o.id, evidenceSource: null }, data: { evidenceSource: RAW_IN_SOURCE } });
  }
  return { stamped: r.count, reason: r.count ? "stamped" : "raced" };
}

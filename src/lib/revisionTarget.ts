import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// IS THERE ANYTHING ON THIS JOB TO REVISE? (Oct 29 2026, 4008 Oakland Rd.)
//
// Jordan, on two Creative review cards in the Video Review Room: "Why is this
// coming up? I don't think it's needed". Nehemiah Lindo texted "4008 Oakland I
// need photos and reel" and "We did these already but we need better photos",
// then called Kyle to order the package (standard reel with agent intro,
// photos, floor plans), booked for Tue Nov 3. The new Aryeo order reached the
// hub a minute after the call, so both messages matched the only 4008
// Oakland job there was: a photos-only job delivered in July. Each became a
// revision on it, with a creative review for a reel the job never had.
//
// A client message that reads as "change it" is a revision on its job only
// when that job still has the thing to change:
//   · an ask about a video, on a job that had no video (no video on the order
//     and no version ever uploaded), is new work;
//   · a photo ask, or an ask that names neither on a job with no video, more
//     than REVISION_WINDOW_DAYS after delivery is new work too (a reshoot, a
//     new order). An old video job still reopens for a video ask or an
//     unclear one (lib/cutReopen): there the video is the likely subject.
// New work is the office's: the message keeps the to-do the brain opened for
// Kyle, and its words go on the client's not-yet-delivered job at the same
// street when the hub already has one (the in-flight special request).
// ---------------------------------------------------------------------------

export const REVISION_WINDOW_DAYS = 30;
const DAY = 86_400_000;

export type RevisionTargetVerdict =
  | { revise: true }
  | { revise: false; why: string };

/** Pure: may this message be a revision on this job? */
export function revisionTargetVerdict(input: {
  medium: "video" | "photo" | "unclear";
  hasVideo: boolean;
  deliveredAt: Date | null;
  now: Date;
}): RevisionTargetVerdict {
  if (input.medium === "video" && !input.hasVideo) {
    return { revise: false, why: "it asks about a video, and this job had no video to change" };
  }
  const days = input.deliveredAt ? Math.floor((input.now.getTime() - input.deliveredAt.getTime()) / DAY) : null;
  const photoSide = input.medium === "photo" || (input.medium === "unclear" && !input.hasVideo);
  if (days != null && days > REVISION_WINDOW_DAYS && photoSide) {
    return { revise: false, why: `this job was delivered ${days} days ago, so it reads as new work (a reshoot or a new order), not a change to what was delivered` };
  }
  return { revise: true };
}

/** The street part of a job title, for matching two jobs at one address. Pure. */
export function streetOf(title: string | null | undefined): string {
  return (title ?? "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
}

const NOT_LIVE = ["DELIVERED", "REVISION", "REVIEW", "CANCELLED"] as const;

/**
 * The verdict for a job the message was anchored to, read from the job, and
 * the client's not-yet-delivered job at the same street (where the words
 * belong when the verdict is "new work"). Never throws: a failed read revises
 * as before.
 */
export async function revisionTargetFor(
  projectId: string,
  medium: "video" | "photo" | "unclear",
  now: Date = new Date(),
): Promise<RevisionTargetVerdict & { sibling: { id: string; title: string } | null }> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true, clientId: true, deliveredAt: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true } } },
    });
    if (!project) return { revise: true, sibling: null };
    const { NOT_A_CUT } = await import("@/lib/reviewCuts");
    const hasVideo =
      project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ||
      (await prisma.reviewSubmission.count({ where: { projectId, status: { notIn: [...NOT_A_CUT] } } })) > 0;
    const verdict = revisionTargetVerdict({
      medium,
      hasVideo,
      deliveredAt: project.deliveredAt,
      now,
    });
    if (verdict.revise || !project.clientId) return { ...verdict, sibling: null };
    const street = streetOf(project.title);
    const others = street
      ? await prisma.project.findMany({
          where: { clientId: project.clientId, id: { not: projectId }, status: { notIn: [...NOT_LIVE] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true },
          take: 20,
        })
      : [];
    return { ...verdict, sibling: others.find((o) => streetOf(o.title) === street) ?? null };
  } catch {
    return { revise: true, sibling: null };
  }
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { videoShareLink } from "@/lib/mediaShareCore";

/**
 * Each program video's share link (lib/mediaShareCore: the client's portal,
 * never Dropbox), by ContentVideo id. Three batched reads; a video with no
 * portal home is simply absent. Read only.
 */
export async function shareLinksFor(contentVideoIds: (string | null | undefined)[], now: Date = new Date()): Promise<Map<string, string>> {
  const ids = [...new Set(contentVideoIds.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const videos = await prisma.contentVideo.findMany({ where: { id: { in: ids } }, select: { id: true, enrollmentId: true, clientId: true } });
  const enrollmentIds = [...new Set(videos.map((v) => v.enrollmentId))];
  if (!enrollmentIds.length) return out;
  const [enrollments, seats] = await Promise.all([
    prisma.contentEnrollment.findMany({
      where: { id: { in: enrollmentIds } },
      select: { id: true, clientId: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true },
    }),
    prisma.clientMembership.findMany({ where: { enrollmentId: { in: enrollmentIds }, revokedAt: null }, select: { enrollmentId: true } }),
  ]);
  const byId = new Map(enrollments.map((e) => [e.id, e]));
  const seated = new Set(seats.map((s) => s.enrollmentId));
  const base = appBase();
  for (const v of videos) {
    const url = videoShareLink(base, { contentVideoId: v.id, video: v, enrollment: byId.get(v.enrollmentId) ?? null, hasSeat: seated.has(v.enrollmentId) }, now);
    if (url) out.set(v.id, url);
  }
  return out;
}

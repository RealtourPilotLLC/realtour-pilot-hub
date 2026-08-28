import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// The client portal's data layer (interactive layer, Aug 28). EVERYTHING here
// is reachable WITHOUT a login — the unguessable token is the only gate — so
// every function takes the token, resolves it to ONE active enrollment, and
// scopes every read and write to that enrollment's own records. No function
// in this file may accept a bare id from the client without proving it
// belongs to the token's enrollment. And never money, anywhere.
// ---------------------------------------------------------------------------

// The one list of script statuses a client may ever see or act on — the page
// renders with it and the WRITE layer enforces it (review finding: the proofs
// checked ownership but not visibility, so a stale tab could act on a script
// that had dropped back to internal review).
export const CLIENT_VISIBLE_SCRIPT = ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];

export type PortalEnrollment = { id: string; clientId: string; videosPerMonth: number };

export async function portalEnrollment(token: string): Promise<PortalEnrollment | null> {
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(token)) return null;
  const e = await prisma.contentEnrollment.findUnique({
    where: { portalToken: token },
    select: { id: true, clientId: true, status: true, videosPerMonth: true },
  });
  if (!e || e.status !== "ACTIVE") return null;
  return { id: e.id, clientId: e.clientId, videosPerMonth: e.videosPerMonth };
}

// The month keys a portal shows: the current ET month plus the one before, so
// a cut approved on the 1st for last month's session doesn't vanish overnight.
export function portalMonthKeys(): string[] {
  const cur = etMonthKey();
  const [y, m] = cur.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return [cur, prev];
}

export type PortalCut = {
  submissionId: string;
  projectId: string;
  fileName: string | null;
  assetUrl: string; // streamable — cuts without a link are not shown
  approvedAtISO: string | null;
  monthKey: string;
  revisionOpen: boolean; // a re-cut is already in motion
  comments: { id: string; timeSec: number | null; body: string; status: string; createdAtISO: string }[];
};

/**
 * The cuts a client may watch: the latest INTERNALLY-APPROVED round per video
 * file, on projects attached to this enrollment's current/previous month.
 * A cut Jordan hasn't approved yet never reaches the client (the human-approval
 * gate the whole program runs on).
 */
export async function portalCuts(enrollmentId: string): Promise<PortalCut[]> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId, monthKey: { in: portalMonthKeys() } },
    select: { id: true, monthKey: true },
  });
  if (months.length === 0) return [];
  const monthByProject = new Map<string, string>();
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { in: months.map((m) => m.id) }, status: { not: "CANCELLED" } },
    select: { id: true, contentMonthId: true },
  });
  if (projects.length === 0) return [];
  const monthKeyById = new Map(months.map((m) => [m.id, m.monthKey]));
  for (const p of projects) monthByProject.set(p.id, monthKeyById.get(p.contentMonthId!) ?? "");

  const subs = await prisma.reviewSubmission.findMany({
    where: { projectId: { in: projects.map((p) => p.id) } },
    orderBy: { round: "asc" },
    select: { id: true, projectId: true, status: true, assetUrl: true, assetPath: true, fileName: true, decidedAt: true },
  });
  // Which submissions carry THIS client's notes — a cut they bounced (their
  // revision flips it to CHANGES_REQUESTED) stays on their page; an
  // internally-bounced cut they never saw does not.
  const allComments = await prisma.portalComment.findMany({
    where: { submissionId: { in: subs.map((s) => s.id) }, enrollmentId },
    orderBy: { createdAt: "asc" },
    select: { id: true, submissionId: true, timeSec: true, body: true, status: true, createdAt: true },
  });
  const commented = new Set(allComments.map((c) => c.submissionId));

  // Latest client-visible round per cut — deliberately NOT latest-round-then-
  // filter: while a redo is pending review, the client keeps watching the last
  // cut they were shown instead of the video vanishing mid-revision (the
  // "Updates in progress" chip tells them the new one is coming).
  const latestPerCut = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const visible = s.status === "APPROVED" || (s.status === "CHANGES_REQUESTED" && commented.has(s.id));
    if (visible && s.assetUrl) latestPerCut.set(`${s.projectId}:${s.assetPath ?? s.id}`, s);
  }
  const shown = [...latestPerCut.values()];
  if (shown.length === 0) return [];

  const comments = allComments.filter((c) => shown.some((s) => s.id === c.submissionId));
  const bySub = new Map<string, typeof comments>();
  for (const c of comments) {
    const arr = bySub.get(c.submissionId) ?? [];
    arr.push(c);
    bySub.set(c.submissionId, arr);
  }
  // An open video-lane revision on the project = the re-cut is in motion; the
  // portal says so instead of inviting a second identical request.
  const revisionTasks = await prisma.smartTask.findMany({
    where: { projectId: { in: shown.map((s) => s.projectId) }, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { projectId: true },
  });
  const revisionByProject = new Set(revisionTasks.map((t) => t.projectId).filter(Boolean) as string[]);

  return shown
    .map((s) => ({
      submissionId: s.id,
      projectId: s.projectId,
      fileName: s.fileName,
      assetUrl: s.assetUrl!,
      approvedAtISO: s.decidedAt ? s.decidedAt.toISOString() : null,
      monthKey: monthByProject.get(s.projectId) ?? "",
      revisionOpen: revisionByProject.has(s.projectId),
      comments: (bySub.get(s.id) ?? []).map((c) => ({
        id: c.id,
        timeSec: c.timeSec,
        body: c.body,
        status: c.status,
        createdAtISO: c.createdAt.toISOString(),
      })),
    }))
    .sort((a, b) => (b.approvedAtISO ?? "").localeCompare(a.approvedAtISO ?? ""));
}

/**
 * Prove a submission belongs to the token's enrollment AND was shown to the
 * client (internally approved — or already bounced BY this client, so their
 * follow-up notes on the same cut still land).
 */
export async function submissionForEnrollment(enrollmentId: string, submissionId: string) {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, status: true, project: { select: { contentMonthId: true, title: true, clientId: true } } },
  });
  if (!sub?.project?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({
    where: { id: sub.project.contentMonthId },
    select: { enrollmentId: true },
  });
  if (month?.enrollmentId !== enrollmentId) return null;
  if (sub.status !== "APPROVED") {
    // Never approved = internal — unless this enrollment already acted on it
    // (their own revision flipped it to CHANGES_REQUESTED).
    const theirs = await prisma.portalComment.count({ where: { submissionId, enrollmentId } });
    if (theirs === 0) return null;
  }
  return sub;
}

/** Prove a script belongs to the token's enrollment AND is client-visible. */
export async function scriptForEnrollment(enrollmentId: string, scriptId: string) {
  const script = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, title: true, status: true, monthId: true },
  });
  if (!script || script.enrollmentId !== enrollmentId) return null;
  if (!CLIENT_VISIBLE_SCRIPT.includes(script.status)) return null;
  return script;
}

// ---------------------------------------------------------------------------
// THE CLIENT'S FULL HISTORY (Jordan, Aug 28: "are we able to see backfilled
// content too from Aryeo and their other content sessions and scripts?").
// Month-by-month: sessions, client-visible scripts, and the DELIVERED videos
// straight from Aryeo's CDN — watchable and downloadable, no proxy needed.
// ---------------------------------------------------------------------------

export type PortalMonthVideo = {
  title: string | null;
  thumb: string | null;
  playback: string | null;
  download: string | null;
};
export type PortalMonth = {
  monthKey: string;
  videosOwed: number;
  strategyCallStatus: string;
  strategyCallAtISO: string | null;
  sessions: { dateISO: string | null; delivered: boolean }[];
  scripts: { id: string; title: string; body: string }[];
  videos: PortalMonthVideo[]; // delivered, from Aryeo
};

// Aryeo lookups are the slow part — cap how many delivered listings one page
// load will fetch, newest shoots first.
const ARYEO_LOOKUP_CAP = 8;

export async function portalMonths(enrollmentId: string): Promise<PortalMonth[]> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId },
    orderBy: { monthKey: "desc" },
    take: 12,
    select: { id: true, monthKey: true, videosOwed: true, strategyCallStatus: true, strategyCallAt: true },
  });
  if (months.length === 0) return [];
  const monthIds = months.map((m) => m.id);

  const [scripts, projects] = await Promise.all([
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, status: { in: CLIENT_VISIBLE_SCRIPT } },
      orderBy: { createdAt: "asc" },
      select: { id: true, monthId: true, title: true, body: true },
    }),
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" } },
      orderBy: { shootDate: "desc" },
      select: { id: true, contentMonthId: true, shootDate: true, status: true, aryeoListingId: true },
    }),
  ]);

  // Delivered videos from Aryeo — newest delivered sessions first, capped,
  // fetched 4 at a time. Best-effort: an Aryeo hiccup just means fewer videos
  // this load, never a broken page.
  const delivered = projects.filter((p) => p.status === "DELIVERED" && p.aryeoListingId).slice(0, ARYEO_LOOKUP_CAP);
  const videosByProject = new Map<string, PortalMonthVideo[]>();
  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  for (let i = 0; i < delivered.length; i += 4) {
    await Promise.all(
      delivered.slice(i, i + 4).map(async (p) => {
        const media = await getListingMedia(p.aryeoListingId!).catch(() => null);
        if (!media?.videos?.length) return;
        videosByProject.set(
          p.id,
          media.videos
            .filter((v) => v.playback || v.download)
            .map((v) => ({ title: v.title, thumb: v.thumb, playback: v.playback, download: v.download })),
        );
      }),
    );
  }

  return months.map((m) => ({
    monthKey: m.monthKey,
    videosOwed: m.videosOwed,
    strategyCallStatus: m.strategyCallStatus,
    strategyCallAtISO: m.strategyCallAt ? m.strategyCallAt.toISOString() : null,
    sessions: projects
      .filter((p) => p.contentMonthId === m.id)
      .map((p) => ({ dateISO: p.shootDate ? p.shootDate.toISOString() : null, delivered: p.status === "DELIVERED" })),
    scripts: scripts.filter((s) => s.monthId === m.id).map((s) => ({ id: s.id, title: s.title, body: s.body })),
    videos: projects.filter((p) => p.contentMonthId === m.id).flatMap((p) => videosByProject.get(p.id) ?? []),
  }));
}

// ---------------------------------------------------------------------------
// FIXTURE: a program client with cuts to review (R04, Sep 28 2026).
//
// Extracted from cp02-revision-policy.ts so the PGlite drills and the real-
// Postgres race drills build the same world the same way:
//
//   const { world, mkCut, release, note } = await reviewWorldKit({ staffUserId });
//   const A = await world("Ada Vance");        // "Ada Vance TEST", 10 videos
//   const a1 = await mkCut(A, 1, 1);            // v1 of video 1, PENDING, playable
//   await release(a1);                          // Jordan's QC approve = the release
//   await note(A, a1, "The intro is too slow"); // an OPEN note on the cut
//
// world() is buildContentMonth (Accelerator, 4 videos a month, October 2026)
// plus its per-video DeliverableOutputs, `slots` ContentVideo rows, and three
// ways in: the client's OWNER seat (`viewer`), our staff on their behalf
// (`staff`, acting as the login given here), and the emailed link (`token`).
//
// Call it only AFTER bootDrillDb: it imports the app (and so @/lib/prisma),
// which must not happen before DATABASE_URL points at the drill database.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import { buildContentMonth, type ContentMonthFixture, type ContentMonthFixtureOptions } from "../_drill/_fixtures/contentMonth";

export type ReviewWorld = { f: ContentMonthFixture; viewer: PortalViewer; staff: PortalViewer; token: PortalViewer; videos: string[] };

export type ReviewWorldKit = {
  /** A TEST client's month. `over` goes to buildContentMonth; `slots` is how
   *  many ContentVideo rows (and so distinct videos) the month carries. */
  world: (name: string, over?: Partial<ContentMonthFixtureOptions>, opts?: { slots?: number }) => Promise<ReviewWorld>;
  /** A cut the editor handed in: PENDING, playable, on video `slot`. Returns its id. */
  mkCut: (w: ReviewWorld, slot: number, round: number, over?: Record<string, unknown>) => Promise<string>;
  /** Jordan's QC approve in the Review Room, then its portal publication (the release). Throws if refused. */
  release: (submissionId: string) => Promise<{ ok: boolean; message: string }>;
  /** An OPEN top-level note on the cut, written by the client's seat. */
  note: (w: ReviewWorld, submissionId: string, body: string) => Promise<{ id: string }>;
};

export async function reviewWorldKit(opts: { staffUserId: string; staffName?: string; staffRole?: string }): Promise<ReviewWorldKit> {
  const { prisma } = await import("@/lib/prisma");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const rr = await import("@/app/review/actions");
  const staffName = opts.staffName ?? "Kyle Drill";
  const staffRole = opts.staffRole ?? "ADMIN";
  // Every cut gets a distinct createdAt, in the order it was made: the chain
  // (cutChainOf) orders a video's versions by round, then upload time.
  let seq = 0;

  const world: ReviewWorldKit["world"] = async (name, over = {}, o = {}) => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10",
      owner: { email: `${slug}@realtourpilot.com`, name }, ...over,
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= (o.slots ?? 10); slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return {
      f, videos,
      viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@realtourpilot.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer,
      staff: { enrollment, actor: { kind: "STAFF", staffUserId: opts.staffUserId, staffName, staffRole }, access: "FULL", via: "STAFF" } as PortalViewer,
      token: { enrollment, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" } as PortalViewer,
    };
  };

  const mkCut: ReviewWorldKit["mkCut"] = async (w, slot, round, over = {}) => {
    const row = await prisma.reviewSubmission.create({
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `${w.f.clientName.split(" ")[0].toLowerCase()}-video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", videoId: w.videos[slot - 1], createdAt: new Date(Date.now() - 1000 + seq++), ...over },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };

  // Since the portal publication gate (a60424b, Oct 2) approval no longer IS
  // the release: a monthly cut reaches the client when its checked 1080p file
  // is published (contentVideos.publishApprovedCutToLibrary → the monthly
  // handoff). That needs Topaz and Dropbox, which a drill fences off, so the
  // fixture records the part these drills are about — the release to the
  // client — then opens the window and answers the open round, as
  // publishApprovedCutToLibrary does. (The handoff's sent stamp is left off: the
  // OLD-code comparisons in realpg-revision-expiry predate its marker and would
  // read it as a send outside the portal.)
  const publish = async (id: string) => {
    await prisma.reviewSubmission.update({ where: { id }, data: { clientReleasedAt: new Date(), clientReleasedBy: "Portal publication" } });
    const { openReviewWindow } = await import("@/lib/reviewWindows");
    await openReviewWindow(id, { by: "Portal publication" });
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
    const { correctedCutApproved } = await import("@/lib/reviewCuts");
    await correctedCutApproved(cut.projectId, { cutCreatedAt: cut.createdAt, round: cut.round, cut: { id: cut.id, deliverableId: cut.deliverableId, slot: cut.slot, assetPath: cut.assetPath } });
  };

  const release: ReviewWorldKit["release"] = async (id) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
    await publish(id);
    return r;
  };

  const note: ReviewWorldKit["note"] = (w, sub, body) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: 12, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });

  return { world, mkCut, release, note };
}

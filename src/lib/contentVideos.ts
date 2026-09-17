import "server-only";
import { prisma } from "@/lib/prisma";
import { DELIVERED_STAMP, NOT_A_CUT, cutKeyOf } from "@/lib/reviewCuts";
import { isMonthlyContentJob } from "@/lib/pipeline";

// ---------------------------------------------------------------------------
// LOGICAL VIDEOS (spec §7, Sep 17 2026). The client's library used to be a
// flat list of PortalVideo rows — one per SOURCE (an Aryeo listing file, a
// review cut) — so a video that reached them twice (cut in the Review Room,
// then the same file on Aryeo) counted twice, and a listing shoot that
// happened to sit on a program month counted toward the monthly allowance.
//
// ContentVideo is ONE row per deliverable the client was promised — grouped by
// the program month it FULFILS (the obligation), never the month it was filmed
// or delivered in — and ContentVideoSource links every version and every
// delivery source to it. The @@unique([kind, ref]) on the source table is what
// makes source synchronisation idempotent: the review cut's id and the
// PortalVideo's externalKey (aryeo:<listing>:<n> / sub:<id>, the upsert keys
// portalLibrary.ts has always used) are the refs, so re-running this never
// mints a second video for the same file.
//
// Counts come from HERE (countsTowardAllowance), never from order quantities.
// A listing video is labelled LISTING and does not consume allowance unless
// staff mapped it in (mappedBy set) — this file never flips a staff mapping.
// ---------------------------------------------------------------------------

export type VideoKind = "PROGRAM" | "LISTING" | "EXTRA" | "CARRYOVER" | "OTHER";

/** The client-facing state of one logical video. */
export type ClientVideoState = "FOR_REVIEW" | "CHANGES_IN_PROGRESS" | "APPROVED" | "DELIVERED" | "IN_PRODUCTION";

/**
 * When a cut became visible to the client. The CPOS column (clientReleasedAt)
 * is the truth going forward; until the Review Room stamps it (handover to the
 * review actions' owner) an internally APPROVED cut that was not the delivery
 * auto-stamp is treated as released at its QC time — exactly the rule the
 * portal has applied since Aug 28, now in one place.
 */
export function cutReleasedAt(s: { status: string; decidedBy: string | null; decidedAt: Date | null; clientReleasedAt: Date | null; clientRequestedAt?: Date | null }): Date | null {
  if (s.clientReleasedAt) return s.clientReleasedAt;
  if (s.status === "APPROVED" && s.decidedBy !== DELIVERED_STAMP) return s.decidedAt ?? null;
  // A cut the client themselves bounced stays theirs to see (their request is the stamp).
  if (s.status === "CHANGES_REQUESTED" && s.clientRequestedAt) return s.clientRequestedAt;
  return null;
}

/** A readable title from an editor's file name: "cara-reel-v1.mp4" → "Cara reel". */
export function titleFromFileName(fileName: string | null | undefined, fallback: string): string {
  if (!fileName) return fallback;
  const base = fileName.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[-_ ]?v\d+(?:[-_ ]?final)?$/i, "").replace(/[-_]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : fallback;
}

type SubRow = {
  id: string; projectId: string; round: number; status: string; assetUrl: string | null; assetPath: string | null; fileName: string | null;
  deliverableId: string | null; slot: number; decidedAt: Date | null; decidedBy: string | null; clientReleasedAt: Date | null; clientRequestedAt: Date | null;
  clientApprovedDecisionId: string | null; completedAt: Date | null; finalPath: string | null; videoId: string | null; createdAt: Date;
};

const SUB_SELECT = {
  id: true, projectId: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, deliverableId: true, slot: true,
  decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true, clientApprovedDecisionId: true, completedAt: true, finalPath: true, videoId: true, createdAt: true,
} as const;

/** Derive the video's status column from its cuts and delivery sources. */
function deriveStatus(cuts: SubRow[], delivered: boolean, filmed: boolean): string {
  const released = cuts.filter((c) => cutReleasedAt(c));
  const latest = released[released.length - 1];
  if (latest?.clientApprovedDecisionId && delivered) return "DELIVERED";
  if (latest?.clientApprovedDecisionId) return "APPROVED";
  if (delivered) return "DELIVERED";
  if (latest) return latest.status === "CHANGES_REQUESTED" ? "EDITING" : "CLIENT_REVIEW";
  if (cuts.length > 0) return "EDITING";
  return filmed ? "FILMED" : "PLANNED";
}

/**
 * Build / refresh the logical videos of one enrollment from its review cuts
 * and library rows. Idempotent and additive: creates what is missing, updates
 * pointers that moved, never deletes, never flips a staff mapping.
 */
export async function syncEnrollmentVideos(enrollment: { id: string; clientId: string }): Promise<{ videos: number; created: number }> {
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, monthKey: true } });
  if (months.length === 0) return { videos: 0, created: 0 };
  const monthKeyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  // THIS CLIENT'S projects only — a job filed on the wrong client's month is
  // hidden by every portal read (portal.ts ownProjects) and must not become
  // one of this client's videos either.
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { in: months.map((m) => m.id) }, clientId: enrollment.clientId, status: { not: "CANCELLED" } },
    select: { id: true, contentMonthId: true, shootDate: true, deliveredAt: true, status: true, packageName: true, deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true, label: true, productTitle: true, videoStyle: true, quantity: true } } },
  });
  if (projects.length === 0) return { videos: 0, created: 0 };
  const projectIds = projects.map((p) => p.id);
  const [subs, libraryRows, existingVideos] = await Promise.all([
    prisma.reviewSubmission.findMany({ where: { projectId: { in: projectIds }, status: { notIn: [...NOT_A_CUT] } }, orderBy: [{ round: "asc" }, { createdAt: "asc" }], select: SUB_SELECT }),
    prisma.portalVideo.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { deliveredAt: "asc" } }),
    prisma.contentVideo.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, projectId: true, deliverableId: true, slot: true, currentSubmissionId: true, approvedSubmissionId: true, finalSubmissionId: true } }),
  ]);
  // Source rows are read ONLY to find this enrollment's own videos (every hit
  // goes through liveOr below, which discards anything outside it), so the
  // query is scoped to them — unscoped it grew with the whole company's
  // library on every Home and My Videos render.
  const existingSources = existingVideos.length
    ? await prisma.contentVideoSource.findMany({ where: { videoId: { in: existingVideos.map((v) => v.id) }, OR: [{ kind: "REVIEW_CUT" }, { kind: "PORTAL_VIDEO" }] }, select: { kind: true, ref: true, videoId: true } })
    : [];
  const sourceVideo = new Map(existingSources.map((s) => [`${s.kind}:${s.ref}`, s.videoId]));
  // A video this enrollment ALREADY has for the same deliverable × slot on the
  // same project, or one whose pointers already name one of these cuts, IS
  // that cut's video — even when nothing linked it through a source row yet
  // (a row written by hand or by another tool). Without this the sync minted a
  // second logical video for a cut that was already represented, and the
  // client's library showed the same video twice.
  const videoBySlot = new Map(existingVideos.filter((v) => v.projectId && v.deliverableId).map((v) => [`${v.projectId}:${v.deliverableId}:${v.slot ?? 1}`, v.id]));
  const videoBySubmission = new Map<string, string>();
  for (const v of existingVideos) for (const s of [v.currentSubmissionId, v.approvedSubmissionId, v.finalSubmissionId]) if (s && !videoBySubmission.has(s)) videoBySubmission.set(s, v.id);
  // A pointer to a video that no longer exists is NOT an answer. ContentVideo
  // has no cascade onto the source rows or onto ReviewSubmission.videoId, so a
  // deleted row leaves dangling ids behind — and trusting one made the video
  // disappear from the library entirely (nothing to create, nothing to read).
  // Every candidate below is proven live first, and a stale link is repaired.
  const live = new Set(existingVideos.map((v) => v.id));
  const liveOr = (id: string | null | undefined): string | null => (id && live.has(id) ? id : null);
  let created = 0;
  const videosByProject = new Map<string, { videoId: string; slotOrder: number }[]>();
  // Which logical video each cut really belongs to, decided by the cut key.
  const cutOwner = new Map<string, string>();

  const ensureVideo = async (data: {
    projectId: string; monthId: string; kind: VideoKind; title: string; deliverableId: string | null; slot: number | null; format: string | null;
    filmedAt: Date | null; deliveredAt: Date | null; source: string; existingId: string | null;
  }): Promise<string> => {
    if (data.existingId) return data.existingId;
    const row = await prisma.contentVideo.create({
      data: {
        enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: data.monthId, monthKey: monthKeyOf.get(data.monthId) ?? null,
        kind: data.kind, countsTowardAllowance: data.kind === "PROGRAM", title: data.title, format: data.format, projectId: data.projectId,
        deliverableId: data.deliverableId, slot: data.slot, filmedAt: data.filmedAt, deliveredAt: data.deliveredAt, source: data.source, status: "PLANNED",
      },
      select: { id: true },
    });
    created++;
    return row.id;
  };

  for (const p of projects) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const defaultKind: VideoKind = monthly ? "PROGRAM" : "LISTING";
    const projectSubs = subs.filter((s) => s.projectId === p.id);
    const projectLibrary = libraryRows.filter((r) => r.projectId === p.id);
    const filmedAt = p.shootDate && p.shootDate < new Date() ? p.shootDate : null;
    const projectVideos: { videoId: string; slotOrder: number }[] = [];

    // 1. Review cuts → one video per cut key (deliverable × slot, or the file for legacy rows), every round a source.
    const byKey = new Map<string, SubRow[]>();
    for (const s of projectSubs) {
      const key = cutKeyOf(s);
      byKey.set(key, [...(byKey.get(key) ?? []), s]);
    }
    let slotOrder = 0;
    for (const [, cuts] of byKey) {
      const first = cuts[0];
      const latest = cuts[cuts.length - 1];
      const known =
        cuts.map((c) => liveOr(c.videoId) ?? liveOr(sourceVideo.get(`REVIEW_CUT:${c.id}`)) ?? liveOr(videoBySubmission.get(c.id))).find((v): v is string => !!v) ??
        (first.deliverableId ? liveOr(videoBySlot.get(`${p.id}:${first.deliverableId}:${first.slot ?? 1}`)) : null);
      const deliverable = first.deliverableId ? p.deliverables.find((d) => d.id === first.deliverableId) : null;
      const format = deliverable?.videoStyle ?? (deliverable?.type === "SOCIAL_REEL" ? "reel" : deliverable?.type === "VIDEO" ? "video" : null);
      // A library row from the review hook (sub:<id>) may carry a LISTING/EXTRA label staff set.
      const labelled = projectLibrary.find((r) => cuts.some((c) => r.externalKey === `sub:${c.id}`))?.label ?? null;
      const kind = (labelled === "LISTING" || labelled === "EXTRA" ? labelled : defaultKind) as VideoKind;
      const videoId = await ensureVideo({
        projectId: p.id, monthId: p.contentMonthId!, kind, title: titleFromFileName(latest.fileName ?? first.fileName, deliverable?.productTitle ?? "Video"),
        deliverableId: first.deliverableId, slot: first.deliverableId ? first.slot : null, format, filmedAt, deliveredAt: null, source: "review", existingId: known,
      });
      projectVideos.push({ videoId, slotOrder: slotOrder++ });
      for (const c of cuts) cutOwner.set(c.id, videoId);
      for (const c of cuts) {
        const ref = `REVIEW_CUT:${c.id}`;
        // Write the link when there isn't one, and re-point it when the one on
        // file names a video that has since been removed.
        if (liveOr(sourceVideo.get(ref)) !== videoId) {
          await prisma.contentVideoSource.upsert({
            where: { kind_ref: { kind: "REVIEW_CUT", ref: c.id } },
            update: { videoId, round: c.round, isFinal: !!c.completedAt, label: c.fileName },
            create: { videoId, kind: "REVIEW_CUT", ref: c.id, submissionId: c.id, round: c.round, isFinal: !!c.completedAt, label: c.fileName },
          }).catch(() => {});
          sourceVideo.set(ref, videoId);
        }
        // The CUT KEY is the identity of a logical video, so the chain decides
        // which video a round belongs to — a pointer that says otherwise (unset,
        // dangling, or set by another writer to a row that is not this chain's)
        // is corrected. Idempotent: the second run finds nothing to change.
        if (c.videoId !== videoId) await prisma.reviewSubmission.update({ where: { id: c.id }, data: { videoId } }).catch(() => {});
      }
      // Review-hook library rows for these cuts are sources of the same video.
      for (const r of projectLibrary.filter((r) => r.source === "review" && cuts.some((c) => r.externalKey === `sub:${c.id}`))) {
        await linkPortalVideo(r, videoId, sourceVideo, false, live);
      }
      const releasedCuts = cuts.filter((c) => cutReleasedAt(c));
      const approvedCut = [...releasedCuts].reverse().find((c) => c.clientApprovedDecisionId) ?? null;
      const finalCut = [...cuts].reverse().find((c) => c.completedAt) ?? null;
      const delivered = !!finalCut || p.status === "DELIVERED";
      await prisma.contentVideo.update({
        where: { id: videoId },
        data: {
          currentSubmissionId: releasedCuts[releasedCuts.length - 1]?.id ?? latest.id,
          approvedSubmissionId: approvedCut?.id ?? null,
          finalSubmissionId: finalCut?.id ?? null,
          finalFileRef: finalCut?.finalPath ?? null,
          finalVersionLabel: finalCut ? `v${finalCut.round}` : null,
          status: deriveStatus(cuts, delivered, !!filmedAt),
          filmedAt, releasedToClientAt: releasedCuts[0] ? cutReleasedAt(releasedCuts[0]) : null,
          deliveredAt: finalCut?.completedAt ?? (p.status === "DELIVERED" ? p.deliveredAt : null),
          ...(monthKeyOf.get(p.contentMonthId!) ? { monthKey: monthKeyOf.get(p.contentMonthId!) } : {}),
        },
      }).catch(() => {});
    }

    // 2. Aryeo listing files → paired index-wise with the cut videos (the n-th
    //    delivered file is the n-th cut) when the counts line up; otherwise
    //    each is its own video. Pairing is the one heuristic here and it only
    //    LINKS a source — it never merges two videos or deletes a row.
    const aryeoRows = projectLibrary.filter((r) => r.source === "aryeo");
    const cutVideos = [...projectVideos].sort((a, b) => a.slotOrder - b.slotOrder);
    for (let i = 0; i < aryeoRows.length; i++) {
      const r = aryeoRows[i];
      const known = liveOr(r.videoId) ?? liveOr(sourceVideo.get(`PORTAL_VIDEO:${r.externalKey}`));
      const pairable = !known && aryeoRows.length === cutVideos.length ? cutVideos[i]?.videoId ?? null : null;
      const kind = (r.label === "LISTING" || r.label === "EXTRA" ? r.label : defaultKind) as VideoKind;
      const videoId = pairable ?? (await ensureVideo({
        projectId: p.id, monthId: p.contentMonthId!, kind, title: r.title ?? `Video ${i + 1}`, deliverableId: null, slot: null, format: null,
        filmedAt, deliveredAt: r.deliveredAt, source: "aryeo", existingId: known,
      }));
      if (!pairable && !known) projectVideos.push({ videoId, slotOrder: 100 + i });
      await linkPortalVideo(r, videoId, sourceVideo, true, live);
      await prisma.contentVideo.update({
        where: { id: videoId },
        data: { deliveredAt: r.deliveredAt, status: "DELIVERED", finalFileRef: r.download ?? r.playback ?? undefined, ...(filmedAt ? { filmedAt } : {}) },
      }).catch(() => {});
    }
    videosByProject.set(p.id, projectVideos);
  }
  // A ContentVideo that points at a cut belonging to ANOTHER chain is holding a
  // stale pointer — a cut belongs to exactly one logical video, and the cut key
  // decides which. Left alone it made the library list the same cut twice (one
  // row under each video) and the month's "in production" count double it.
  // The pointer is cleared; the row itself is never deleted here.
  for (const v of existingVideos) {
    const data: { currentSubmissionId?: null; approvedSubmissionId?: null; finalSubmissionId?: null } = {};
    if (v.currentSubmissionId && (cutOwner.get(v.currentSubmissionId) ?? v.id) !== v.id) data.currentSubmissionId = null;
    if (v.approvedSubmissionId && (cutOwner.get(v.approvedSubmissionId) ?? v.id) !== v.id) data.approvedSubmissionId = null;
    if (v.finalSubmissionId && (cutOwner.get(v.finalSubmissionId) ?? v.id) !== v.id) data.finalSubmissionId = null;
    if (Object.keys(data).length) await prisma.contentVideo.update({ where: { id: v.id }, data }).catch(() => {});
  }
  const videos = await prisma.contentVideo.count({ where: { enrollmentId: enrollment.id } });
  return { videos, created };
}

async function linkPortalVideo(r: { id: string; externalKey: string; videoId: string | null; submissionId: string | null; title: string | null }, videoId: string, sourceVideo: Map<string, string>, isFinal: boolean, live: Set<string>): Promise<void> {
  const ref = `PORTAL_VIDEO:${r.externalKey}`;
  const linked = sourceVideo.get(ref);
  if (!(linked && live.has(linked) && linked === videoId)) {
    await prisma.contentVideoSource.upsert({
      where: { kind_ref: { kind: "PORTAL_VIDEO", ref: r.externalKey } },
      update: { videoId, isFinal, label: r.title },
      create: { videoId, kind: "PORTAL_VIDEO", ref: r.externalKey, portalVideoId: r.id, submissionId: r.submissionId, isFinal, label: r.title },
    }).catch(() => {});
    sourceVideo.set(ref, videoId);
  }
  if (!(r.videoId && live.has(r.videoId))) await prisma.portalVideo.update({ where: { id: r.id }, data: { videoId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// READS — everything below is scoped to one enrollment by construction.
// ---------------------------------------------------------------------------

export type VideoListRow = {
  id: string;
  title: string;
  monthKey: string | null;
  kind: VideoKind;
  countsTowardAllowance: boolean;
  state: ClientVideoState;
  filmedAtISO: string | null;
  deliveredAtISO: string | null;
  thumb: string | null;
  format: string | null;
  pillarName: string | null;
  /** The released cut the client should act on, if any. */
  currentSubmissionId: string | null;
  needsDecision: boolean;
  approved: boolean;
  hasFinalFile: boolean;
};

export type VideoListPage = {
  rows: VideoListRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  years: number[];
  year: number | null;
};

export const VIDEOS_PER_PAGE = 24;

function stateOf(v: { status: string; approvedSubmissionId: string | null; currentSubmissionId: string | null; deliveredAt: Date | null }, currentDecided: boolean): ClientVideoState {
  if (v.status === "DELIVERED" && (v.approvedSubmissionId || !v.currentSubmissionId || currentDecided)) return "DELIVERED";
  if (v.approvedSubmissionId && v.approvedSubmissionId === v.currentSubmissionId) return "APPROVED";
  if (v.status === "EDITING" && v.currentSubmissionId) return "CHANGES_IN_PROGRESS";
  if (v.currentSubmissionId && !currentDecided) return "FOR_REVIEW";
  if (v.status === "DELIVERED") return "DELIVERED";
  if (v.currentSubmissionId) return "CHANGES_IN_PROGRESS";
  return "IN_PRODUCTION";
}

/** Thumbnail for a video: the Mux poster of its delivered file when there is one; hub cuts have none (a placeholder renders). */
function thumbFor(sources: { kind: string; portalThumb: string | null }[]): string | null {
  return sources.find((s) => s.portalThumb)?.portalThumb ?? null;
}

/**
 * The library, newest obligation month first, with year navigation and
 * pagination — no 18-month or 200-row ceiling: every video the client was
 * ever given is reachable.
 */
export async function portalVideoList(enrollment: { id: string; clientId: string }, opts: { year?: number | null; page?: number; perPage?: number } = {}): Promise<VideoListPage> {
  const perPage = Math.min(Math.max(opts.perPage ?? VIDEOS_PER_PAGE, 6), 60);
  const all = await prisma.contentVideo.findMany({
    where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, status: { not: "ARCHIVED" } },
    orderBy: [{ monthKey: "desc" }, { filmedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, monthKey: true },
  });
  const years = [...new Set(all.map((v) => v.monthKey?.slice(0, 4)).filter((y): y is string => !!y))].map(Number).sort((a, b) => b - a);
  const year = opts.year && years.includes(opts.year) ? opts.year : null;
  const inScope = year ? all.filter((v) => v.monthKey?.startsWith(String(year))) : all;
  const total = inScope.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
  const ids = inScope.slice((page - 1) * perPage, page * perPage).map((v) => v.id);
  if (ids.length === 0) return { rows: [], total, page, pages, perPage, years, year };

  const [videos, sources, decisions, pillars] = await Promise.all([
    prisma.contentVideo.findMany({ where: { id: { in: ids } } }),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, kind: true, ref: true, submissionId: true, portalVideoId: true, isFinal: true } }),
    prisma.clientDecision.findMany({ where: { enrollmentId: enrollment.id, videoId: { in: ids } }, select: { videoId: true, submissionId: true, decision: true } }),
    prisma.contentPillar.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, name: true } }),
  ]);
  const portalIds = sources.map((s) => s.portalVideoId).filter((x): x is string => !!x);
  const portalRows = portalIds.length ? await prisma.portalVideo.findMany({ where: { id: { in: portalIds } }, select: { id: true, thumb: true, download: true, playback: true } }) : [];
  const thumbOf = new Map(portalRows.map((r) => [r.id, r.thumb]));
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = videos
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((v): VideoListRow => {
      const vs = sources.filter((s) => s.videoId === v.id);
      const currentDecided = !!v.currentSubmissionId && decisions.some((d) => d.videoId === v.id && d.submissionId === v.currentSubmissionId);
      const state = stateOf(v, currentDecided);
      return {
        id: v.id, title: v.title ?? "Video", monthKey: v.monthKey, kind: (v.kind as VideoKind) ?? "PROGRAM", countsTowardAllowance: v.countsTowardAllowance,
        state, filmedAtISO: v.filmedAt?.toISOString() ?? null, deliveredAtISO: v.deliveredAt?.toISOString() ?? null,
        thumb: thumbFor(vs.map((s) => ({ kind: s.kind, portalThumb: s.portalVideoId ? thumbOf.get(s.portalVideoId) ?? null : null }))),
        format: v.format, pillarName: pillars.find((p) => p.id === v.pillarId)?.name ?? null,
        currentSubmissionId: v.currentSubmissionId, needsDecision: state === "FOR_REVIEW", approved: !!v.approvedSubmissionId,
        hasFinalFile: !!v.finalSubmissionId || vs.some((s) => s.kind === "PORTAL_VIDEO" && s.isFinal),
      };
    });
  return { rows, total, page, pages, perPage, years, year };
}

/**
 * The client-facing state of ONE video, derived by the SAME rule the list
 * uses — so a video can never read one way in My Videos and another on its own
 * page (it used to be re-derived from the cut history when the row fell
 * outside the page that was fetched to find it).
 */
export async function videoState(enrollmentId: string, v: { id: string; status: string; approvedSubmissionId: string | null; currentSubmissionId: string | null; deliveredAt: Date | null }): Promise<ClientVideoState> {
  const currentDecided = v.currentSubmissionId
    ? (await prisma.clientDecision.count({ where: { enrollmentId, videoId: v.id, submissionId: v.currentSubmissionId } })) > 0
    : false;
  return stateOf(v, currentDecided);
}

export type LibraryAttention = { needReview: number; readyToUse: number; readyWithFile: number };

/**
 * How many videos in the WHOLE library want the client's attention. Home used
 * to count these off page one, so "3 videos waiting on you" was really "3 on
 * this page" for anyone with more than a page of videos.
 */
export async function libraryAttention(enrollment: { id: string; clientId: string }): Promise<LibraryAttention> {
  const videos = await prisma.contentVideo.findMany({
    where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, status: { not: "ARCHIVED" } },
    select: { id: true, status: true, approvedSubmissionId: true, currentSubmissionId: true, finalSubmissionId: true, deliveredAt: true },
  });
  if (videos.length === 0) return { needReview: 0, readyToUse: 0, readyWithFile: 0 };
  const ids = videos.map((v) => v.id);
  const [decisions, finals] = await Promise.all([
    prisma.clientDecision.findMany({ where: { enrollmentId: enrollment.id, videoId: { in: ids } }, select: { videoId: true, submissionId: true } }),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids }, kind: "PORTAL_VIDEO", isFinal: true }, select: { videoId: true } }),
  ]);
  const decided = new Set(decisions.map((d) => `${d.videoId}:${d.submissionId}`));
  const withFile = new Set(finals.map((f) => f.videoId));
  const out: LibraryAttention = { needReview: 0, readyToUse: 0, readyWithFile: 0 };
  for (const v of videos) {
    const st = stateOf(v, !!v.currentSubmissionId && decided.has(`${v.id}:${v.currentSubmissionId}`));
    if (st === "FOR_REVIEW") out.needReview++;
    else if (st === "APPROVED" || st === "DELIVERED") {
      out.readyToUse++;
      if (v.finalSubmissionId || withFile.has(v.id)) out.readyWithFile++;
    }
  }
  return out;
}

/** Program videos delivered per month, counted from the library (countsTowardAllowance), never from orders. */
export async function programCountsByMonth(enrollmentId: string, monthKeys: string[]): Promise<Map<string, { delivered: number; total: number }>> {
  if (monthKeys.length === 0) return new Map();
  const rows = await prisma.contentVideo.findMany({
    where: { enrollmentId, monthKey: { in: monthKeys }, countsTowardAllowance: true, status: { not: "ARCHIVED" } },
    select: { monthKey: true, status: true, deliveredAt: true, finalSubmissionId: true },
  });
  const out = new Map<string, { delivered: number; total: number }>();
  for (const k of monthKeys) out.set(k, { delivered: 0, total: 0 });
  for (const r of rows) {
    const c = out.get(r.monthKey!)!;
    c.total++;
    // DELIVERED is only ever derived from a real delivery row, so it counts —
    // but an APPROVED video is not yet delivered and must not be reported as
    // one; it shows up in "in production or review" instead.
    if (r.status === "DELIVERED" || !!r.deliveredAt || !!r.finalSubmissionId) c.delivered++;
  }
  return out;
}

/** Prove a ContentVideo belongs to this enrollment AND client; null otherwise. */
export async function videoForEnrollment(enrollment: { id: string; clientId: string }, videoId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(videoId)) return null;
  const v = await prisma.contentVideo.findUnique({ where: { id: videoId } });
  if (!v || v.enrollmentId !== enrollment.id || v.clientId !== enrollment.clientId) return null;
  return v;
}

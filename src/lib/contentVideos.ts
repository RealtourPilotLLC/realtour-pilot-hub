import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { DELIVERED_STAMP, NOT_A_CUT, cutKeyOf } from "@/lib/reviewCuts";
import { isMonthlyContentJob } from "@/lib/pipeline";
import type { Prisma } from "@prisma/client";
// Types only: cutEntitlement imports this file, so its CODE is loaded lazily
// inside syncEnrollmentVideos rather than forming an import cycle.
import type { AryeoFinal, Entitlement } from "@/lib/cutEntitlement";

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

/**
 * The identity of a video, reduced to letters and digits, with a trailing
 * version marker removed: "Mike's Video 2 v2.mov" and "Mike's Video 2 v1.mov"
 * are one video, and so are the Review Room's "Joe's Ideal Date Night in West
 * Chester ( no border ).mov" and Aryeo's "Ideal Date Night In West Chester
 * ( No Border )".
 */
function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[-_ ]*\(?\s*v\s*\d+\s*\)?(?:[-_ ]*final)?\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Do two names describe the same video? Equal after normalisation, or one
 * wholly contains the other and the shorter is long enough to be an identity
 * rather than a coincidence ("video1" must never match "video12"). Used ONLY
 * to link a delivered Aryeo file to a cut of the same video — it never merges
 * two existing rows and never deletes one.
 */
function sameVideo(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 12 && long.includes(short);
}

/** sameVideo over two raw names — how cutEntitlement tells a name-paired Aryeo
 *  file from one tied to a cut chain only by list position. */
export const sameVideoTitle = (a: string | null | undefined, b: string | null | undefined): boolean => sameVideo(normTitle(a), normTitle(b));

/**
 * The identity of a cut FOR THE LIBRARY. Uploaded cuts are (deliverable, slot)
 * — reviewCuts.cutKeyOf, unchanged, and the Review Room's own answer. Legacy
 * cuts carry no deliverable, and cutKeyOf falls back to the FILE PATH, so every
 * re-uploaded revision became its own logical video: Mike Ciunci's 2026-08
 * month held five one-cut "videos" (v1/v2/v3 of two videos) against an
 * allowance of two, and both the staff overview and the client's own page said
 * 7 delivered (review blocker, Sep 17). For those rows the file NAME is the
 * identity — that is what the "v2"/"v3" convention means — and the path is
 * still the fallback when a name is missing or too short to identify anything.
 *
 * Exported as videoCutKey (CP-01): approval, cut history, supersession and the
 * download rule group rounds by THIS key too, so a legacy "X v1.mov" can no
 * longer be approved beside the "X v2.mov" the library shows as current.
 */
function libraryCutKey(s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; fileName?: string | null; id: string }): string {
  if (s.deliverableId) return cutKeyOf(s);
  const name = normTitle(s.fileName);
  return name.length >= 6 ? `file:${name}` : cutKeyOf(s);
}
export const videoCutKey = libraryCutKey;

type SubRow = {
  id: string; projectId: string; round: number; status: string; assetUrl: string | null; assetPath: string | null; fileName: string | null;
  deliverableId: string | null; slot: number; decidedAt: Date | null; decidedBy: string | null; clientReleasedAt: Date | null; clientRequestedAt: Date | null;
  clientApprovedDecisionId: string | null; completedAt: Date | null; finalPath: string | null; videoId: string | null; createdAt: Date;
  sentToClientAt: Date | null; blobUrl: string | null; blobPathname: string | null; sizeBytes: number | null; contentHash: string | null;
};

// The last five columns are what the release rule (cutEntitlement) reads: the
// Mark-as-sent stamp, and the bytes and identity an approval is checked against.
const SUB_SELECT = {
  id: true, projectId: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, deliverableId: true, slot: true,
  decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true, clientApprovedDecisionId: true, completedAt: true, finalPath: true, videoId: true, createdAt: true,
  sentToClientAt: true, blobUrl: true, blobPathname: true, sizeBytes: true, contentHash: true,
} as const;

/**
 * The video's status column, from the release rule's answer. It used to be
 * derived from completedAt — INTERNAL completion, stamped by the Review Room's
 * Dropbox copy — so a cut the client had never decided on read "Delivered",
 * and so did one they had sent back.
 */
function statusFromEntitlement(e: Entitlement, hasCuts: boolean, filmed: boolean): string {
  // An earlier approved version is downloadable, but the video's standing is
  // the NEWER version's: still with the client, or back with the editor.
  if (e.priorVersion) return e.current?.state === "CHANGES_REQUESTED" ? "EDITING" : "CLIENT_REVIEW";
  if (e.basis === "CLIENT_APPROVED") return "APPROVED";
  if (e.basis !== "NONE") return "DELIVERED";
  if (e.current?.state === "CHANGES_REQUESTED") return "EDITING";
  if (e.current) return e.current.state === "APPROVED" && e.blockedBy !== "HASH_DRIFT" ? "APPROVED" : "CLIENT_REVIEW";
  if (hasCuts) return "EDITING";
  return filmed ? "FILMED" : "PLANNED";
}

/**
 * Build / refresh the logical videos of one enrollment from its review cuts
 * and library rows. Idempotent and additive: creates what is missing, updates
 * pointers that moved, never deletes, never flips a staff mapping.
 */
export async function syncEnrollmentVideos(enrollment: { id: string; clientId: string }): Promise<{ videos: number; created: number; archived: number }> {
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, monthKey: true, historical: true, status: true } });
  if (months.length === 0) return { videos: 0, created: 0, archived: 0 };
  const monthKeyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  const historicalMonth = new Set(months.filter((m) => m.historical || m.status === "IMPORTED").map((m) => m.id));
  // THIS CLIENT'S projects only — a job filed on the wrong client's month is
  // hidden by every portal read (portal.ts ownProjects) and must not become
  // one of this client's videos either.
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { in: months.map((m) => m.id) }, clientId: enrollment.clientId, status: { not: "CANCELLED" } },
    select: { id: true, contentMonthId: true, shootDate: true, deliveredAt: true, status: true, packageName: true, deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true, label: true, productTitle: true, videoStyle: true, quantity: true } } },
  });
  if (projects.length === 0) return { videos: 0, created: 0, archived: 0 };
  const projectIds = projects.map((p) => p.id);
  const [subs, libraryRows, existingVideos] = await Promise.all([
    prisma.reviewSubmission.findMany({ where: { projectId: { in: projectIds }, status: { notIn: [...NOT_A_CUT] } }, orderBy: [{ round: "asc" }, { createdAt: "asc" }], select: SUB_SELECT }),
    prisma.portalVideo.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { deliveredAt: "asc" } }),
    prisma.contentVideo.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, projectId: true, status: true, deliverableId: true, slot: true, currentSubmissionId: true, approvedSubmissionId: true, finalSubmissionId: true, topicId: true, filmedConfirmedAt: true, finalFileRef: true, finalVersionLabel: true, deliveredAt: true } }),
  ]);
  // The client's own decisions on these cuts — the only thing that turns an
  // internally approved cut into THEIR video (cutEntitlement). One query per
  // enrollment; superseded rows never count.
  const { decideEntitlement, foldDecisions, aryeoMatchBasis } = await import("@/lib/cutEntitlement");
  const decisionRows = subs.length
    ? await prisma.clientDecision.findMany({ where: { enrollmentId: enrollment.id, submissionId: { in: subs.map((s) => s.id) } }, select: { id: true, submissionId: true, decision: true, actorLabel: true, decidedAt: true, contentHash: true, supersededById: true } })
    : [];
  // Source rows are read ONLY to find this enrollment's own videos (every hit
  // goes through liveOr below, which discards anything outside it), so the
  // query is scoped to them — unscoped it grew with the whole company's
  // library on every Home and My Videos render.
  const existingSources = existingVideos.length
    ? await prisma.contentVideoSource.findMany({ where: { videoId: { in: existingVideos.map((v) => v.id) }, OR: [{ kind: "REVIEW_CUT" }, { kind: "PORTAL_VIDEO" }] }, select: { kind: true, ref: true, videoId: true, matchBasis: true, confirmedAt: true } })
    : [];
  const sourceVideo = new Map(existingSources.map((s) => [`${s.kind}:${s.ref}`, s.videoId]));
  // CP-12: how each delivered file came to be linked, and whether a person
  // has since confirmed it. A staff link or confirmation is the pairing from
  // then on — this run neither re-points it nor relabels it.
  const sourceMeta = new Map(existingSources.map((s) => [`${s.kind}:${s.ref}`, { matchBasis: s.matchBasis, confirmedAt: s.confirmedAt }]));
  const staffPinned = (key: string) => { const m = sourceMeta.get(key); return !!m && (m.matchBasis === "staff" || !!m.confirmedAt); };
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
  // F12: rows whose filming date came from a person, not from an appointment.
  const confirmedFilming = new Set(
    (await prisma.contentVideo.findMany({ where: { enrollmentId: enrollment.id, filmedConfirmedAt: { not: null } }, select: { id: true } })).map((v) => v.id),
  );
  let created = 0;
  const videosByProject = new Map<string, { videoId: string; slotOrder: number; titleKey: string }[]>();
  // Which logical video each cut really belongs to, decided by the cut key.
  const cutOwner = new Map<string, string>();
  // Every cut chain this run rebuilt, and the Aryeo file paired to it (if
  // any) — the facts the release rule is applied to once pairing is done.
  const pendingChains: { videoId: string; cuts: SubRow[]; project: (typeof projects)[number]; filmed: boolean }[] = [];
  const aryeoFor = new Map<string, AryeoFinal>();

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
    const projectVideos: { videoId: string; slotOrder: number; titleKey: string }[] = [];

    // 1. Review cuts → one video per cut key (deliverable × slot, or the file for legacy rows), every round a source.
    const byKey = new Map<string, SubRow[]>();
    for (const s of projectSubs) {
      const key = libraryCutKey(s);
      byKey.set(key, [...(byKey.get(key) ?? []), s]);
    }
    // This project's Aryeo-delivered files. A chain's delivery is no longer
    // inferred from their mere existence: each one paired to a chain becomes
    // that chain's aryeoFinal fact (step 2), and the release rule weighs it.
    const aryeoRows = projectLibrary.filter((r) => r.source === "aryeo");
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
      projectVideos.push({ videoId, slotOrder: slotOrder++, titleKey: normTitle(latest.fileName ?? first.fileName) });
      for (const c of cuts) cutOwner.set(c.id, videoId);
      for (const c of cuts) {
        const ref = `REVIEW_CUT:${c.id}`;
        // Write the link when there isn't one, and re-point it when the one on
        // file names a video that has since been removed.
        if (liveOr(sourceVideo.get(ref)) !== videoId) {
          // matchBasis "cut" (CP-12): the cut key put it here, nothing weaker.
          await prisma.contentVideoSource.upsert({
            where: { kind_ref: { kind: "REVIEW_CUT", ref: c.id } },
            update: { videoId, round: c.round, isFinal: !!c.completedAt, label: c.fileName, matchBasis: "cut" },
            create: { videoId, kind: "REVIEW_CUT", ref: c.id, submissionId: c.id, round: c.round, isFinal: !!c.completedAt, label: c.fileName, matchBasis: "cut" },
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
        await linkPortalVideo(r, videoId, sourceVideo, false, live, "cut", sourceMeta);
      }
      const releasedCuts = cuts.filter((c) => cutReleasedAt(c));
      // What the client may HAVE — approved, final file, status, delivered —
      // is written after the Aryeo pairing below, from the release rule
      // (cutEntitlement), because an Aryeo file paired to this chain is one of
      // its facts. It used to be written here from completedAt, which is the
      // Review Room's internal Dropbox copy and not anything the client did.
      pendingChains.push({ videoId, cuts, project: p, filmed: !!filmedAt });
      await prisma.contentVideo.update({
        where: { id: videoId },
        data: {
          currentSubmissionId: releasedCuts[releasedCuts.length - 1]?.id ?? latest.id,
          // F12 (Sep 22 2026) — A DERIVED DATE MAY NOT OVERWRITE A CONFIRMED ONE.
          //
          // `filmedAt` here is inferred from Project.shootDate, and 100% of the
          // filming dates in production were inferred that way. When the
          // photographer has actually confirmed on the upload portal WHICH
          // topics they filmed, that row carries filmedConfirmedAt and its
          // filmedAt is a stated fact — this hourly sweep must not quietly
          // replace it with the appointment's date again.
          ...(confirmedFilming.has(videoId) ? {} : { filmedAt }),
          releasedToClientAt: releasedCuts[0] ? cutReleasedAt(releasedCuts[0]) : null,
          ...(monthKeyOf.get(p.contentMonthId!) ? { monthKey: monthKeyOf.get(p.contentMonthId!) } : {}),
        },
      }).catch(() => {});
    }

    // 2. Aryeo listing files → paired with the cut they are the delivery OF, by
    //    NAME first (the editor's file and Aryeo's title are the same video
    //    written twice), then index-wise when the counts line up; otherwise
    //    each is its own video. Requiring the counts to line up meant that the
    //    moment they differed by one, EVERY delivered file was minted a second
    //    time beside its own cut (review blocker, Sep 17). Pairing only LINKS a
    //    source — it never merges two videos or deletes a row.
    const cutVideos = [...projectVideos].sort((a, b) => a.slotOrder - b.slotOrder);
    const claimed = new Set<string>();
    // CP-12: a video a person pinned a file to is spoken for — no other file
    // is paired onto it by title or by position behind their back.
    for (const r of aryeoRows) {
      const k = `PORTAL_VIDEO:${r.externalKey}`;
      const pinnedTo = staffPinned(k) ? liveOr(sourceVideo.get(k)) : null;
      if (pinnedTo) claimed.add(pinnedTo);
    }
    for (let i = 0; i < aryeoRows.length; i++) {
      const r = aryeoRows[i];
      const srcKey = `PORTAL_VIDEO:${r.externalKey}`;
      // A staff-pinned link (CP-12 relink/confirm) outranks the PortalVideo's
      // own pointer: the two are written together, but if they ever disagree
      // the person's decision is the one that stands.
      const known = (staffPinned(srcKey) ? liveOr(sourceVideo.get(srcKey)) : null) ?? liveOr(r.videoId) ?? liveOr(sourceVideo.get(srcKey));
      const byName = known ? null : cutVideos.find((c) => !claimed.has(c.videoId) && sameVideo(normTitle(r.title), c.titleKey))?.videoId ?? null;
      const byIndex = known || byName || aryeoRows.length !== cutVideos.length ? null
        : cutVideos[i] && !claimed.has(cutVideos[i].videoId) ? cutVideos[i].videoId : null;
      const pairable = byName ?? byIndex;
      if (pairable) claimed.add(pairable);
      const kind = (r.label === "LISTING" || r.label === "EXTRA" ? r.label : defaultKind) as VideoKind;
      const videoId = pairable ?? (await ensureVideo({
        projectId: p.id, monthId: p.contentMonthId!, kind, title: r.title ?? `Video ${i + 1}`, deliverableId: null, slot: null, format: null,
        filmedAt, deliveredAt: r.deliveredAt, source: "aryeo", existingId: known,
      }));
      if (!pairable && !known) projectVideos.push({ videoId, slotOrder: 100 + i, titleKey: normTitle(r.title) });
      const chain = pendingChains.find((c) => c.videoId === videoId);
      // CP-12: record HOW this file came to sit under this video. Index
      // pairing is the weak one — a reordered listing binds a delivered file
      // to the wrong title — so it is written down and shown to staff as
      // "check pairing". A link made before this was recorded is described by
      // what it evidently is: the titles agree, or they do not.
      const basis = byName ? "name" : byIndex ? "index" : !known ? "own" : chain ? aryeoMatchBasis(r.title, chain.cuts) ?? "own" : "own";
      await linkPortalVideo(r, videoId, sourceVideo, true, live, basis, sourceMeta);
      // A video with a cut chain gets its delivery state from the release rule
      // (below), where this file is one fact among several: stamping DELIVERED
      // here let an Aryeo file paired only by list position deliver a chain
      // the client was still reviewing.
      if (chain) {
        if (!aryeoFor.has(videoId) && (r.download || r.playback)) {
          // `confirmed` is a person's word on this pairing (CP-12), read from
          // the source row; the rule then serves an index-paired file.
          aryeoFor.set(videoId, { portalVideoId: r.id, url: (r.download ?? r.playback)!, title: r.title, deliveredAt: r.deliveredAt, matchBasis: aryeoMatchBasis(r.title, chain.cuts), confirmed: staffPinned(srcKey) && sourceVideo.get(srcKey) === videoId });
        }
        if (filmedAt && !confirmedFilming.has(videoId)) await prisma.contentVideo.update({ where: { id: videoId }, data: { filmedAt } }).catch(() => {});
        continue;
      }
      await prisma.contentVideo.update({
        where: { id: videoId },
        data: { deliveredAt: r.deliveredAt, status: "DELIVERED", finalFileRef: r.download ?? r.playback ?? undefined, ...(filmedAt ? { filmedAt } : {}) },
      }).catch(() => {});
    }
    videosByProject.set(p.id, projectVideos);
  }
  // THE RELEASE RULE, applied to every chain this run rebuilt: approved, final
  // file, status and delivered date are all ITS answer (cutEntitlement), so the
  // list, Home's counts, the download door and captions cannot disagree.
  // approvedSubmissionId names the decisive round only when the client's own
  // approval of it still matches its bytes — never an older round's approval.
  // Superseded rows never count for the decisive round; they are kept for the
  // prior-approved-version fallback (cutEntitlement.KEEP_PRIOR_APPROVED_VERSION).
  const { approvals, changeRequests } = foldDecisions(decisionRows.filter((d) => !d.supersededById));
  const priorApprovals = foldDecisions(decisionRows).approvals;
  const cachedById = new Map(existingVideos.map((v) => [v.id, v]));
  // A paused or ended program cannot approve in the portal; the rule takes a
  // delivered project as delivered there (cutEntitlement.enrollmentActive).
  const enrollmentActive = ((await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { status: true } }))?.status ?? "ACTIVE") === "ACTIVE";
  for (const { videoId, cuts, project: p, filmed } of pendingChains) {
    const e = decideEntitlement({
      chain: cuts, approvals, changeRequests, priorApprovals,
      projectDelivered: p.status === "DELIVERED", projectDeliveredAt: p.deliveredAt,
      monthHistorical: historicalMonth.has(p.contentMonthId!),
      aryeoFinal: aryeoFor.get(videoId) ?? null,
      enrollmentActive,
    });
    const fileCut = e.file?.kind === "cut" ? cuts.find((c) => c.id === e.file!.submissionId) ?? null : null;
    const data = {
      approvedSubmissionId: e.current?.state === "APPROVED" && e.blockedBy !== "HASH_DRIFT" ? e.current.submissionId : null,
      finalSubmissionId: fileCut?.id ?? null,
      finalFileRef: fileCut ? fileCut.finalPath ?? fileCut.assetPath ?? e.file!.url : e.file?.url ?? null,
      finalVersionLabel: fileCut ? `v${fileCut.round}` : null,
      status: statusFromEntitlement(e, cuts.length > 0, filmed),
      deliveredAt: e.deliveredAt,
    };
    // Every portal render runs this sync; a row whose answer did not move is
    // not rewritten.
    const was = cachedById.get(videoId);
    if (was && was.approvedSubmissionId === data.approvedSubmissionId && was.finalSubmissionId === data.finalSubmissionId && was.finalFileRef === data.finalFileRef
      && was.finalVersionLabel === data.finalVersionLabel && was.status === data.status && (was.deliveredAt?.getTime() ?? null) === (data.deliveredAt?.getTime() ?? null)) continue;
    await prisma.contentVideo.update({ where: { id: videoId }, data }).catch(() => {});
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
  // Regrouping legacy cuts by file name (libraryCutKey) means a row that used
  // to hold one revision of a video now holds none — its cuts belong to the
  // chain the name identifies. Such a row is a duplicate of a video the client
  // already has, and leaving it made the month count it again. It is ARCHIVED,
  // never deleted: every count and list already excludes ARCHIVED, the row and
  // its history stay on file, and flipping the status back restores it.
  // Deliberately narrow: only rows on a project THIS RUN rebuilt, that hold no
  // source row and no cut of their own.
  //
  // CP-09: a row that carries a topic or a photographer's filming confirmation
  // is a person's statement about what was filmed, not a leftover — it holds
  // no cut yet precisely because the edit has not landed. It always survives.
  const rebuilt = new Set(projectIds);
  const survivors = new Set<string>(cutOwner.values());
  for (const list of videosByProject.values()) for (const x of list) survivors.add(x.videoId);
  for (const v of existingVideos) if (v.topicId || v.filmedConfirmedAt) survivors.add(v.id);
  const emptied = existingVideos.filter((v) => v.status !== "ARCHIVED" && v.projectId && rebuilt.has(v.projectId) && !survivors.has(v.id));
  let archived = 0;
  if (emptied.length) {
    const ids = emptied.map((v) => v.id);
    const [srcRows, cutRows] = await Promise.all([
      prisma.contentVideoSource.findMany({ where: { videoId: { in: ids } }, select: { videoId: true } }),
      prisma.reviewSubmission.findMany({ where: { videoId: { in: ids } }, select: { videoId: true } }),
    ]);
    const held = new Set([...srcRows.map((r) => r.videoId), ...cutRows.map((r) => r.videoId)]);
    for (const v of emptied) {
      if (held.has(v.id)) continue;
      await prisma.contentVideo.update({ where: { id: v.id }, data: { status: "ARCHIVED" } }).catch(() => {});
      archived++;
    }
  }
  const videos = await prisma.contentVideo.count({ where: { enrollmentId: enrollment.id, status: { not: "ARCHIVED" } } });
  return { videos, created, archived };
}

async function linkPortalVideo(
  r: { id: string; externalKey: string; videoId: string | null; submissionId: string | null; title: string | null },
  videoId: string, sourceVideo: Map<string, string>, isFinal: boolean, live: Set<string>,
  // CP-12: how this link was made (cut | own | name | index). Written with a
  // new or re-pointed link, and onto a link that predates the column; an
  // existing value is kept, and a staff link is never relabelled.
  basis: string, meta: Map<string, { matchBasis: string | null; confirmedAt: Date | null }>,
): Promise<void> {
  const ref = `PORTAL_VIDEO:${r.externalKey}`;
  const linked = sourceVideo.get(ref);
  const was = meta.get(ref);
  if (!(linked && live.has(linked) && linked === videoId)) {
    // A new or re-pointed link is a new pairing: whatever a person confirmed
    // was about the video it pointed at before. (A staff link to a LIVE video
    // never reaches here — the caller resolves it as `known`.)
    await prisma.contentVideoSource.upsert({
      where: { kind_ref: { kind: "PORTAL_VIDEO", ref: r.externalKey } },
      update: { videoId, isFinal, label: r.title, matchBasis: basis, confirmedAt: null, confirmedBy: null },
      create: { videoId, kind: "PORTAL_VIDEO", ref: r.externalKey, portalVideoId: r.id, submissionId: r.submissionId, isFinal, label: r.title, matchBasis: basis },
    }).catch(() => {});
    sourceVideo.set(ref, videoId);
    meta.set(ref, { matchBasis: basis, confirmedAt: null });
  } else if (was && !was.matchBasis) {
    await prisma.contentVideoSource.updateMany({ where: { kind: "PORTAL_VIDEO", ref: r.externalKey, matchBasis: null }, data: { matchBasis: basis } }).catch(() => {});
    meta.set(ref, { ...was, matchBasis: basis });
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
  /** Same as `downloadable` (kept for older readers). */
  hasFinalFile: boolean;
  /** The release rule's answer as the sync cached it: the client may download
   *  this video's final file right now (cutEntitlement). */
  downloadable: boolean;
  /** CP-12: RECENT rows are grouped under the month they fulfil; PREVIOUS
   *  rows are older backfill whose month we cannot vouch for (librarySection). */
  section: LibrarySection;
};

export type VideoListPage = {
  rows: VideoListRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  /** Years of the RECENT rows only — a backfilled month is not a year we vouch for. */
  years: number[];
  year: number | null;
  /** CP-12: how many rows sit in "Previous content", whatever page this is. */
  previousTotal: number;
  /** The Previous-content filter was applied. */
  section: "previous" | null;
};

export type LibrarySection = "RECENT" | "PREVIOUS";

/**
 * WHERE A VIDEO BELONGS IN THE CLIENT'S LIBRARY (CP-12, Sep 24 2026).
 *
 * Backfilled months are keyed by the SHOOT month and flagged historical /
 * IMPORTED — the program never ran them, and the month a row sits under there
 * is a guess about which month's allowance it fulfilled. Grouping those rows
 * by that month asserted production months we do not know. So they go in one
 * flat "Previous content" section, dated by delivery, until a person confirms
 * the row (identityConfirmedAt) — then it is shown under its month like any
 * other. A row with no month at all can only ever be Previous: there is no
 * month to put it under.
 */
export function librarySection(v: { monthKey: string | null; identityConfirmedAt: Date | null }, monthHistorical: boolean): LibrarySection {
  if (!v.monthKey) return "PREVIOUS";
  return monthHistorical && !v.identityConfirmedAt ? "PREVIOUS" : "RECENT";
}

/** Month ids and keys of this enrollment that are backfill (historical or IMPORTED). */
async function historicalMonths(enrollmentId: string): Promise<{ ids: Set<string>; keys: Set<string> }> {
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true, historical: true, status: true } });
  const old = months.filter((m) => m.historical || m.status === "IMPORTED");
  return { ids: new Set(old.map((m) => m.id)), keys: new Set(old.map((m) => m.monthKey)) };
}

/** One video's section, for the detail page (the list computes it in bulk). */
export async function videoLibrarySection(v: { enrollmentId: string; monthId: string | null; monthKey: string | null; identityConfirmedAt: Date | null }): Promise<LibrarySection> {
  const h = await historicalMonths(v.enrollmentId);
  return librarySection(v, v.monthId ? h.ids.has(v.monthId) : !!v.monthKey && h.keys.has(v.monthKey));
}

export const VIDEOS_PER_PAGE = 24;

/** The KIND of the client's latest live decision on the current cut, or null. */
export type CurrentDecision = "APPROVE" | "REQUEST_CHANGES" | null;

/**
 * The client-facing state. It reads the decision's KIND: it used to ask only
 * "was the current cut decided", so a client's own change request on a
 * finished cut counted as decided and the row read DELIVERED — with "Download
 * and post" on Home, serving the cut they had just rejected. DELIVERED is now
 * written by the sync only when the release rule says the decisive round was
 * delivered, so it no longer has to be second-guessed here.
 */
function stateOf(v: { status: string; approvedSubmissionId: string | null; currentSubmissionId: string | null }, decision: CurrentDecision): ClientVideoState {
  if (v.currentSubmissionId && decision === "REQUEST_CHANGES") return "CHANGES_IN_PROGRESS";
  if (v.status === "DELIVERED") return "DELIVERED";
  if (v.currentSubmissionId && decision === "APPROVE") return "APPROVED";
  if (v.approvedSubmissionId && v.approvedSubmissionId === v.currentSubmissionId) return "APPROVED";
  if (v.status === "EDITING" && v.currentSubmissionId) return "CHANGES_IN_PROGRESS";
  if (v.currentSubmissionId) return "FOR_REVIEW";
  return "IN_PRODUCTION";
}

/** Latest live decision kind per submission, for one enrollment. */
async function currentDecisions(enrollmentId: string, submissionIds: string[]): Promise<Map<string, CurrentDecision>> {
  const out = new Map<string, CurrentDecision>();
  if (submissionIds.length === 0) return out;
  const rows = await prisma.clientDecision.findMany({
    where: { enrollmentId, submissionId: { in: submissionIds }, supersededById: null },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    select: { submissionId: true, decision: true },
  });
  for (const r of rows) if (r.decision === "APPROVE" || r.decision === "REQUEST_CHANGES") out.set(r.submissionId, r.decision);
  return out;
}

/** Downloadable, from the caches the sync wrote from the release rule: a cut
 *  it entitled (finalSubmissionId), or a delivered Aryeo file on a row it
 *  marked DELIVERED. */
const cachedDownloadable = (v: { status: string; finalSubmissionId: string | null }, hasFinalPortalFile: boolean): boolean =>
  !!v.finalSubmissionId || (v.status === "DELIVERED" && hasFinalPortalFile);

/** Thumbnail for a video: the Mux poster of its delivered file when there is one; hub cuts have none (a placeholder renders). */
function thumbFor(sources: { kind: string; portalThumb: string | null }[]): string | null {
  return sources.find((s) => s.portalThumb)?.portalThumb ?? null;
}

/**
 * The library, newest obligation month first, with year navigation and
 * pagination — no 18-month or 200-row ceiling: every video the client was
 * ever given is reachable.
 *
 * CP-12: the months are the RECENT rows; older backfill (librarySection)
 * follows them as one flat "Previous content" run, newest delivery first. It
 * used to be grouped by its shoot month, and Postgres sorts NULLS FIRST on a
 * descending key, so the "Undated" group led page one. The order is computed
 * here over ids that are already loaded, so pagination runs over the two
 * sections as one list. `year` narrows to that year's RECENT rows; `section:
 * "previous"` shows only the Previous rows.
 */
export async function portalVideoList(enrollment: { id: string; clientId: string }, opts: { year?: number | null; page?: number; perPage?: number; section?: "previous" | null } = {}): Promise<VideoListPage> {
  const perPage = Math.min(Math.max(opts.perPage ?? VIDEOS_PER_PAGE, 6), 60);
  const [all, hist] = await Promise.all([
    prisma.contentVideo.findMany({
      where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, status: { not: "ARCHIVED" } },
      select: { id: true, monthId: true, monthKey: true, identityConfirmedAt: true, filmedAt: true, deliveredAt: true, createdAt: true },
    }),
    historicalMonths(enrollment.id),
  ]);
  const t = (d: Date | null) => d?.getTime() ?? null;
  // Descending with nulls LAST — where the database put them first, which is
  // how the month-less group led page one.
  const desc = (a: number | string | null, b: number | string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1);
  // Within a month the order is the one the query always had (Postgres DESC is
  // NULLS FIRST): a video not filmed yet sits above the filmed ones.
  const descNullsFirst = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? 1 : -1);
  const tagged = all.map((v) => ({ ...v, section: librarySection(v, v.monthId ? hist.ids.has(v.monthId) : !!v.monthKey && hist.keys.has(v.monthKey)) }));
  const recent = tagged.filter((v) => v.section === "RECENT")
    .sort((a, b) => desc(a.monthKey, b.monthKey) || descNullsFirst(t(a.filmedAt), t(b.filmedAt)) || desc(t(a.createdAt), t(b.createdAt)));
  const previous = tagged.filter((v) => v.section === "PREVIOUS")
    .sort((a, b) => desc(t(a.deliveredAt), t(b.deliveredAt)) || desc(t(a.createdAt), t(b.createdAt)));
  const years = [...new Set(recent.map((v) => v.monthKey?.slice(0, 4)).filter((y): y is string => !!y))].map(Number).sort((a, b) => b - a);
  const section = opts.section === "previous" ? "previous" : null;
  const year = !section && opts.year && years.includes(opts.year) ? opts.year : null;
  const inScope = section ? previous : year ? recent.filter((v) => v.monthKey?.startsWith(String(year))) : [...recent, ...previous];
  const total = inScope.length;
  const previousTotal = previous.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
  const pageRows = inScope.slice((page - 1) * perPage, page * perPage);
  const ids = pageRows.map((v) => v.id);
  const sectionOf = new Map(pageRows.map((v) => [v.id, v.section]));
  if (ids.length === 0) return { rows: [], total, page, pages, perPage, years, year, previousTotal, section };

  const [videos, sources, pillars] = await Promise.all([
    prisma.contentVideo.findMany({ where: { id: { in: ids } } }),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, kind: true, ref: true, submissionId: true, portalVideoId: true, isFinal: true } }),
    prisma.contentPillar.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, name: true } }),
  ]);
  const decided = await currentDecisions(enrollment.id, videos.map((v) => v.currentSubmissionId).filter((x): x is string => !!x));
  const portalIds = sources.map((s) => s.portalVideoId).filter((x): x is string => !!x);
  const portalRows = portalIds.length ? await prisma.portalVideo.findMany({ where: { id: { in: portalIds } }, select: { id: true, thumb: true, download: true, playback: true } }) : [];
  const thumbOf = new Map(portalRows.map((r) => [r.id, r.thumb]));
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = videos
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((v): VideoListRow => {
      const vs = sources.filter((s) => s.videoId === v.id);
      const state = stateOf(v, v.currentSubmissionId ? decided.get(v.currentSubmissionId) ?? null : null);
      const downloadable = cachedDownloadable(v, vs.some((s) => s.kind === "PORTAL_VIDEO" && s.isFinal));
      return {
        id: v.id, title: v.title ?? "Video", monthKey: v.monthKey, kind: (v.kind as VideoKind) ?? "PROGRAM", countsTowardAllowance: v.countsTowardAllowance,
        state, filmedAtISO: v.filmedAt?.toISOString() ?? null, deliveredAtISO: v.deliveredAt?.toISOString() ?? null,
        thumb: thumbFor(vs.map((s) => ({ kind: s.kind, portalThumb: s.portalVideoId ? thumbOf.get(s.portalVideoId) ?? null : null }))),
        format: v.format, pillarName: pillars.find((p) => p.id === v.pillarId)?.name ?? null,
        currentSubmissionId: v.currentSubmissionId, needsDecision: state === "FOR_REVIEW", approved: !!v.approvedSubmissionId,
        hasFinalFile: downloadable, downloadable, section: sectionOf.get(v.id) ?? "RECENT",
      };
    });
  return { rows, total, page, pages, perPage, years, year, previousTotal, section };
}

/**
 * The client-facing state of ONE video, derived by the SAME rule the list
 * uses — so a video can never read one way in My Videos and another on its own
 * page (it used to be re-derived from the cut history when the row fell
 * outside the page that was fetched to find it).
 */
export async function videoState(enrollmentId: string, v: { id: string; status: string; approvedSubmissionId: string | null; currentSubmissionId: string | null; deliveredAt: Date | null }): Promise<ClientVideoState> {
  const decided = v.currentSubmissionId ? await currentDecisions(enrollmentId, [v.currentSubmissionId]) : new Map<string, CurrentDecision>();
  return stateOf(v, v.currentSubmissionId ? decided.get(v.currentSubmissionId) ?? null : null);
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
  const [decided, finals] = await Promise.all([
    currentDecisions(enrollment.id, videos.map((v) => v.currentSubmissionId).filter((x): x is string => !!x)),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids }, kind: "PORTAL_VIDEO", isFinal: true }, select: { videoId: true } }),
  ]);
  const withFile = new Set(finals.map((f) => f.videoId));
  const out: LibraryAttention = { needReview: 0, readyToUse: 0, readyWithFile: 0 };
  for (const v of videos) {
    const st = stateOf(v, v.currentSubmissionId ? decided.get(v.currentSubmissionId) ?? null : null);
    if (st === "FOR_REVIEW") out.needReview++;
    // "Ready to use" means the client can have the file NOW (CP-01): an
    // approved row whose file is being re-issued, or whose bytes drifted from
    // the approval, is not ready — it would send them to a refused download.
    else if ((st === "APPROVED" || st === "DELIVERED") && cachedDownloadable(v, withFile.has(v.id))) {
      out.readyToUse++;
      out.readyWithFile++;
    }
  }
  return out;
}

/**
 * "This video is DELIVERED." The single definition — exported because the
 * portfolio overview reads every client's library in one query and cannot call
 * the per-enrollment counter below, and a second hand-written copy of this rule
 * drifted within a day (APPROVED stopped counting, finalSubmissionId started).
 * Two copies mean Jordan and the client can be shown different numbers.
 *
 * An APPROVED video is NOT delivered — it is approved, and belongs in the
 * in-production reading; only a real delivery row counts.
 */
const LIBRARY_CURSOR = "content-video-sweep-cursor";

/**
 * Keep the staff overview's production counts current.
 *
 * syncEnrollmentVideos is otherwise called from exactly one place — a CLIENT
 * opening their portal — and no client has ever opened one. So on Sep 17 the
 * library held 14 rows while 55 delivered videos sat in the pipeline, and the
 * monthly overview read zero delivered for every client. Counting production
 * from the library is right; a library nobody fills is not.
 *
 * A few enrollments an hour on a rotating cursor, each one deriving that
 * client's videos from that client's own work. It creates rows and never
 * deletes, a second pass over the same client creates nothing, and it contacts
 * nobody — which is why it is not behind a switch.
 */
export async function sweepContentVideoLibraries(limit = 8): Promise<{ enrollments: number; created: number; archived: number; failed: number }> {
  // ENDED enrollments are in the rotation too. Leaving them out meant Jamie
  // Achberger (5 delivered projects) and Sam Walls (1) had — and would always
  // have — zero rows in their library, while the overview flagged Sam's row as
  // behind and could never catch up (review, Sep 17). An ended program's
  // delivered work is still the client's, and this derives it from their own
  // rows; it contacts nobody either way.
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "ENDED"] } },
    select: { id: true, clientId: true },
    orderBy: { id: "asc" },
  });
  if (enrollments.length === 0) return { enrollments: 0, created: 0, archived: 0, failed: 0 };
  const stored = await getSetting<{ cursor: string | null }>(LIBRARY_CURSOR, { cursor: null });
  const at = stored.cursor ? enrollments.findIndex((e) => e.id === stored.cursor) : -1;
  const start = at >= 0 ? at + 1 : 0;
  let created = 0;
  let archived = 0;
  let failed = 0;
  let done = 0;
  let last = stored.cursor;
  for (let i = 0; i < enrollments.length && done < limit; i++) {
    const e = enrollments[(start + i) % enrollments.length];
    try {
      const r = await syncEnrollmentVideos(e);
      created += r.created;
      archived += r.archived;
    } catch {
      failed++; // one client's bad row must not stop the rotation
    }
    last = e.id;
    done++;
  }
  await putSetting(LIBRARY_CURSOR, { cursor: last }, "cron:contentLibrary").catch(() => {});
  return { enrollments: done, created, archived, failed };
}

export const isDeliveredProgramVideo = (v: { status: string; deliveredAt: Date | null; finalSubmissionId: string | null }): boolean =>
  v.status === "DELIVERED" || !!v.deliveredAt || !!v.finalSubmissionId;

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
    if (isDeliveredProgramVideo(r)) c.delivered++;
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

// ---------------------------------------------------------------------------
// CP-12 — THE STAFF IDENTITY TOOL (Sep 24 2026). "Correct video under the
// correct title after reorder/replacement" had no tool behind it: no action
// anywhere edited a video's title, topic or file mapping, so a delivered file
// paired to the wrong cut by list position, a legacy row on a positional
// Aryeo key, or a photographer-confirmed topic row that never met its cut all
// stayed wrong for good, invisibly.
//
// Every function below is fenced to ONE enrollment, never deletes anything,
// and writes a ContentVideoCorrection row per changed field before (in the
// same transaction as) the change itself — the field's history is that
// ledger. The sync never writes title, topicId or scriptId, and it keeps a
// staff-pinned file link (matchBasis "staff" / confirmedAt), so a correction
// made here stays made. Each one re-runs the library sync afterwards so the
// cached state (status, final file, delivered) follows at once.
// ---------------------------------------------------------------------------

export type IdentityResult = { ok: boolean; message: string; changed?: number };

const IDENT_ID_RE = /^[a-z0-9]{10,40}$/i;
/** The kinds staff may map a video to here; the allowance follows the kind. */
const MAPPABLE_KINDS = new Set<VideoKind>(["PROGRAM", "LISTING", "EXTRA"]);

type CorrectionData = { videoId: string; enrollmentId: string; field: string; fromValue: string | null; toValue: string | null; by: string; reason: string | null };
const corr = (videoId: string, enrollmentId: string, field: string, from: unknown, to: unknown, by: string, reason: string | null): CorrectionData => ({
  videoId, enrollmentId, field, by, reason,
  fromValue: from == null ? null : String(from instanceof Date ? from.toISOString() : from).slice(0, 500),
  toValue: to == null ? null : String(to instanceof Date ? to.toISOString() : to).slice(0, 500),
});

async function resyncAfterCorrection(enrollmentId: string): Promise<void> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true } });
  if (e) await syncEnrollmentVideos(e).catch(() => {});
}

/**
 * Correct a video's title, topic, script or kind, and/or confirm its month.
 * Topic and script must be this enrollment's own. On a backfilled month the
 * row stays under "Previous content" until confirmMonth — a title fix is not
 * a statement about which month's allowance it fulfilled; elsewhere any
 * correction is a person having checked the row, and is stamped as such.
 */
export async function correctVideoIdentity(
  enrollmentId: string,
  videoId: string,
  patch: { title?: string | null; topicId?: string | null; scriptId?: string | null; kind?: string | null; confirmMonth?: boolean },
  by: string,
  reason?: string | null,
): Promise<IdentityResult> {
  if (!IDENT_ID_RE.test(videoId)) return { ok: false, message: "No such video." };
  const v = await prisma.contentVideo.findUnique({ where: { id: videoId } });
  if (!v || v.enrollmentId !== enrollmentId) return { ok: false, message: "That video isn't on this client's program." };
  const why = reason?.trim() ? reason.trim().slice(0, 500) : null;
  const rows: CorrectionData[] = [];
  const data: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    const title = (patch.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) return { ok: false, message: "A title can't be blank." };
    if (title !== (v.title ?? "")) { data.title = title; rows.push(corr(v.id, enrollmentId, "title", v.title, title, by, why)); }
  }
  if (patch.topicId !== undefined && (patch.topicId || null) !== v.topicId) {
    const topicId = patch.topicId || null;
    if (topicId) {
      const t = IDENT_ID_RE.test(topicId) ? await prisma.contentTopic.findFirst({ where: { id: topicId, enrollmentId }, select: { id: true } }) : null;
      if (!t) return { ok: false, message: "That topic isn't on this client's program." };
    }
    data.topicId = topicId;
    rows.push(corr(v.id, enrollmentId, "topicId", v.topicId, topicId, by, why));
  }
  if (patch.scriptId !== undefined && (patch.scriptId || null) !== v.scriptId) {
    const scriptId = patch.scriptId || null;
    if (scriptId) {
      const s = IDENT_ID_RE.test(scriptId) ? await prisma.contentScript.findFirst({ where: { id: scriptId, enrollmentId }, select: { id: true } }) : null;
      if (!s) return { ok: false, message: "That script isn't on this client's program." };
    }
    data.scriptId = scriptId;
    rows.push(corr(v.id, enrollmentId, "scriptId", v.scriptId, scriptId, by, why));
    // The filmed version named a version of the OLD script; which version of
    // the new one was filmed is not known, and the portal reads the released
    // version when this is empty.
    if (v.scriptVersionId) { data.scriptVersionId = null; rows.push(corr(v.id, enrollmentId, "scriptVersionId", v.scriptVersionId, null, by, why)); }
  }
  if (patch.kind != null && patch.kind !== v.kind) {
    if (!MAPPABLE_KINDS.has(patch.kind as VideoKind)) return { ok: false, message: "A video can be mapped as a program video, a listing video or an extra." };
    const counts = patch.kind === "PROGRAM";
    data.kind = patch.kind;
    data.mappedBy = by;
    rows.push(corr(v.id, enrollmentId, "kind", v.kind, patch.kind, by, why));
    if (counts !== v.countsTowardAllowance) { data.countsTowardAllowance = counts; rows.push(corr(v.id, enrollmentId, "countsTowardAllowance", v.countsTowardAllowance, counts, by, why)); }
  }
  const month = v.monthId ? await prisma.contentMonth.findUnique({ where: { id: v.monthId }, select: { historical: true, status: true } }) : null;
  const backfilled = !!month && (month.historical || month.status === "IMPORTED");
  const confirm = patch.confirmMonth === true || (!backfilled && rows.length > 0);
  if (patch.confirmMonth === false && v.identityConfirmedAt) {
    data.identityConfirmedAt = null;
    data.identityConfirmedBy = null;
    rows.push(corr(v.id, enrollmentId, "identityConfirmed", v.identityConfirmedAt, null, by, why));
  } else if (confirm && !v.identityConfirmedAt) {
    const at = new Date();
    data.identityConfirmedAt = at;
    data.identityConfirmedBy = by;
    rows.push(corr(v.id, enrollmentId, patch.confirmMonth ? "monthConfirmed" : "identityConfirmed", null, v.monthKey ?? at, by, why));
  }
  if (rows.length === 0) return { ok: true, message: "Nothing changed — that is already what's on file.", changed: 0 };
  await prisma.$transaction([
    prisma.contentVideoCorrection.createMany({ data: rows }),
    prisma.contentVideo.update({ where: { id: v.id }, data: data as Prisma.ContentVideoUncheckedUpdateInput }),
  ]);
  await resyncAfterCorrection(enrollmentId);
  return { ok: true, message: `Saved — ${rows.length} change${rows.length === 1 ? "" : "s"} recorded in this video's history.`, changed: rows.length };
}

/** A PORTAL_VIDEO source of this enrollment, with the file row behind it. */
async function deliveredSourceOf(enrollmentId: string, sourceId: string) {
  if (!IDENT_ID_RE.test(sourceId)) return null;
  const s = await prisma.contentVideoSource.findUnique({ where: { id: sourceId } });
  if (!s || s.kind !== "PORTAL_VIDEO" || !s.portalVideoId) return null;
  const [owner, pv] = await Promise.all([
    prisma.contentVideo.findUnique({ where: { id: s.videoId }, select: { id: true, enrollmentId: true, title: true, projectId: true } }),
    prisma.portalVideo.findUnique({ where: { id: s.portalVideoId }, select: { id: true, enrollmentId: true, projectId: true, externalKey: true, title: true } }),
  ]);
  if (!pv || pv.enrollmentId !== enrollmentId || (owner && owner.enrollmentId !== enrollmentId)) return null;
  return { s, owner, pv };
}

/**
 * Move a delivered file to the video it really belongs to. This changes which
 * file a client downloads, so it is staff-only and fully ledgered; the link is
 * stamped matchBasis "staff" and confirmed, which the sync keeps from then on.
 */
export async function relinkDeliveredFile(enrollmentId: string, sourceId: string, targetVideoId: string, by: string, reason?: string | null): Promise<IdentityResult> {
  const found = await deliveredSourceOf(enrollmentId, sourceId);
  if (!found) return { ok: false, message: "That delivered file isn't on this client's program." };
  const { s, owner, pv } = found;
  const target = IDENT_ID_RE.test(targetVideoId) ? await prisma.contentVideo.findUnique({ where: { id: targetVideoId }, select: { id: true, enrollmentId: true, status: true, title: true, projectId: true } }) : null;
  if (!target || target.enrollmentId !== enrollmentId) return { ok: false, message: "That video isn't on this client's program." };
  if (target.status === "ARCHIVED") return { ok: false, message: "That video is archived — pick a live one." };
  // Across shoots the sync would weigh this file against a chain it has not
  // built yet on that pass; a file belongs to the shoot it was delivered on.
  if (pv.projectId && target.projectId && pv.projectId !== target.projectId) return { ok: false, message: "That file was delivered on a different shoot than this video — it can only move to a video of the same shoot." };
  const why = reason?.trim() ? reason.trim().slice(0, 500) : null;
  const at = new Date();
  const moved = s.videoId !== target.id;
  await prisma.$transaction([
    prisma.contentVideoCorrection.createMany({
      data: moved
        ? [
            corr(target.id, enrollmentId, "file", owner?.title ?? s.videoId, pv.externalKey, by, why),
            ...(owner ? [corr(owner.id, enrollmentId, "file", pv.externalKey, `moved to ${target.title ?? target.id}`, by, why)] : []),
          ]
        : [corr(target.id, enrollmentId, "pairing", s.matchBasis, "staff", by, why)],
    }),
    prisma.contentVideoSource.update({ where: { id: s.id }, data: { videoId: target.id, matchBasis: "staff", confirmedAt: at, confirmedBy: by } }),
    prisma.portalVideo.update({ where: { id: pv.id }, data: { videoId: target.id } }),
    prisma.contentVideo.update({ where: { id: target.id }, data: { identityConfirmedAt: at, identityConfirmedBy: by } }),
  ]);
  await resyncAfterCorrection(enrollmentId);
  return { ok: true, message: moved ? `Moved — "${pv.title ?? "that file"}" is now delivered as "${target.title ?? "this video"}", and the change is in both videos' history.` : "Confirmed where it is." };
}

/** "This pairing is right": the file stays where it is and is no longer flagged. */
export async function confirmPairing(enrollmentId: string, sourceId: string, by: string): Promise<IdentityResult> {
  const found = await deliveredSourceOf(enrollmentId, sourceId);
  if (!found) return { ok: false, message: "That delivered file isn't on this client's program." };
  const { s } = found;
  if (s.confirmedAt) return { ok: true, message: "Already confirmed.", changed: 0 };
  const at = new Date();
  await prisma.$transaction([
    prisma.contentVideoCorrection.create({ data: corr(s.videoId, enrollmentId, "pairing", s.matchBasis, `confirmed (${s.matchBasis ?? "unrecorded"})`, by, null) }),
    prisma.contentVideoSource.update({ where: { id: s.id }, data: { confirmedAt: at, confirmedBy: by } }),
  ]);
  await resyncAfterCorrection(enrollmentId);
  return { ok: true, message: "Confirmed — this file is this video's delivery.", changed: 1 };
}

/**
 * A photographer-confirmed topic row and the cut chain of the same video are
 * two rows today (CP-09 owns why): the chain was minted under the editor's
 * file name and never got the topic. Adopting copies the topic, script,
 * selection, the topic's title and the filming confirmation onto the chain's
 * video, then ARCHIVES the topic row with a note — never deletes it. The topic
 * row must hold no file of its own; one that does is a real video, not a stub.
 */
export async function adoptTopicVideo(enrollmentId: string, chainVideoId: string, topicVideoId: string, by: string): Promise<IdentityResult> {
  if (!IDENT_ID_RE.test(chainVideoId) || !IDENT_ID_RE.test(topicVideoId) || chainVideoId === topicVideoId) return { ok: false, message: "Pick two different videos." };
  const [chain, topic] = await Promise.all([
    prisma.contentVideo.findUnique({ where: { id: chainVideoId } }),
    prisma.contentVideo.findUnique({ where: { id: topicVideoId } }),
  ]);
  if (!chain || !topic || chain.enrollmentId !== enrollmentId || topic.enrollmentId !== enrollmentId) return { ok: false, message: "Those videos aren't both on this client's program." };
  if (!chain.projectId || chain.projectId !== topic.projectId) return { ok: false, message: "Only two rows of the same shoot can be joined." };
  if (chain.status === "ARCHIVED") return { ok: false, message: "The video with the cuts is archived — restore it first." };
  if (!topic.topicId && !topic.filmedConfirmedAt) return { ok: false, message: "The second row carries no topic or filming confirmation to bring across." };
  if (chain.topicId && topic.topicId && chain.topicId !== topic.topicId) return { ok: false, message: "The video with the cuts is already tied to a different topic — correct its topic first." };
  const [srcCount, cutCount] = await Promise.all([
    prisma.contentVideoSource.count({ where: { videoId: topic.id } }),
    prisma.reviewSubmission.count({ where: { videoId: topic.id } }),
  ]);
  if (srcCount + cutCount > 0) return { ok: false, message: "The topic row holds a file of its own — move that file with Relink instead." };

  const rows: CorrectionData[] = [];
  const data: Record<string, unknown> = {};
  const take = (field: "topicId" | "selectionId" | "scriptId" | "scriptVersionId" | "pillarId" | "filmedAt" | "filmedConfirmedAt" | "filmedConfirmedBy" | "filmedSource") => {
    const to = topic[field];
    if (to == null) return;
    const from = chain[field];
    if (from instanceof Date && to instanceof Date ? from.getTime() === to.getTime() : from === to) return;
    data[field] = to;
    rows.push(corr(chain.id, enrollmentId, field, from, to, by, `adopted from ${topic.id}`));
  };
  for (const f of ["topicId", "selectionId", "scriptId", "scriptVersionId", "pillarId"] as const) take(f);
  // A person's filming statement wins over a derived date — the same rule the sync keeps (F12).
  if (topic.filmedConfirmedAt) for (const f of ["filmedAt", "filmedConfirmedAt", "filmedConfirmedBy", "filmedSource"] as const) take(f);
  const topicTitle = topic.topicId ? (await prisma.contentTopic.findUnique({ where: { id: topic.topicId }, select: { title: true } }))?.title ?? topic.title : topic.title;
  if (topicTitle && topicTitle !== chain.title) { data.title = topicTitle; rows.push(corr(chain.id, enrollmentId, "title", chain.title, topicTitle, by, `adopted from ${topic.id}`)); }
  const at = new Date();
  data.identityConfirmedAt = chain.identityConfirmedAt ?? at;
  data.identityConfirmedBy = chain.identityConfirmedBy ?? by;
  rows.push(corr(topic.id, enrollmentId, "status", topic.status, "ARCHIVED", by, `merged into ${chain.id}`));
  await prisma.$transaction([
    prisma.contentVideoCorrection.createMany({ data: rows }),
    prisma.contentVideo.update({ where: { id: chain.id }, data: data as Prisma.ContentVideoUncheckedUpdateInput }),
    prisma.contentVideo.update({ where: { id: topic.id }, data: { status: "ARCHIVED", notes: `${topic.notes ? `${topic.notes}\n` : ""}merged into ${chain.id} by ${by} ${at.toISOString().slice(0, 10)}`.slice(0, 2000) } }),
  ]);
  await resyncAfterCorrection(enrollmentId);
  return { ok: true, message: `Joined — "${topicTitle ?? "the topic"}" is now this video's title and topic, and the separate topic row is archived (kept, with a note).`, changed: rows.length };
}

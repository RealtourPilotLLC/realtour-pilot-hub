import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { etDateYear } from "@/lib/datetime";
import {
  addressKey, cleanVideoTitle, cutDone, fileStem, finishedFileOf, latestPerSlot, orientationOf, placeVideo, programPackageOf, streetOf,
  type MediaPlacement, type Orientation,
} from "@/lib/mediaLibraryCore";
import { aryeoMediaUrl, classifyListingVideo, normTitle, sameDuration } from "@/lib/listingMediaCore";

// ---------------------------------------------------------------------------
// THE MEDIA LIBRARY'S READS (Oct 23 2026; /media, /listings). Database only:
// nothing here calls Aryeo or Dropbox, so a page of tiles costs a handful of
// queries however many videos there are. The finished files themselves are
// fetched per press by /api/media/video/<cut id> (a fresh Dropbox link each
// time, never cached, never in the page), and the photos of one listing are
// read from Aryeo by that listing's page (lib/mediaListing.ts), once.
//
// A LISTING VIDEO is an approved cut that went to the client (mediaLibraryCore
// cutDone), the newest such round of each owed video, played and downloaded
// as its finished file (the checked Topaz file when there is one).
// A MONTHLY VIDEO is what the client's portal library holds (PortalVideo): a
// row that plays a hub cut is that cut; a row delivered through the session's
// Aryeo listing plays Aryeo's own file and poster. One logical video
// (ContentVideo) shows once.
// Test clients are left out (syntheticClientIds), money never appears.
//
// AN OLDER LISTING VIDEO (Oct 24 2026; Jordan: "we should have a lot more
// premium videos and monthly social content in the gallery") is a video on a
// delivered job's Aryeo listing, read from the hub's index of the listings
// (ListingMediaItem, lib/listingMediaIndex), never from Aryeo per tile. It is
// placed by the job's own video rows (its Style Guide type, the same tab
// rules), titled as Aryeo titles it, posted with Aryeo's poster, and played
// and downloaded through /api/media/aryeo/<row>. It shows only when it is not
// a video the hub or the portal already shows: by Aryeo's id (the hub's
// upload receipts, the portal's keys), else by job + title + length, else
// when the hub already holds a finished file for every video of that type
// the job owed (the listing's copies, revisions included, are those videos).
// ---------------------------------------------------------------------------

export type MediaVideo = {
  key: string;
  placement: MediaPlacement;
  title: string;
  /** Small line above the title: the product sold, or the program month. */
  eyebrow: string | null;
  /** The address (or the session's place), in full. */
  place: string | null;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  dateISO: string | null;
  /** "Delivered Oct 20, 2026": formatted on the server (one engine, no hydration drift). */
  dateText: string | null;
  orientation: Orientation;
  poster: string | null;
  /** Same-origin route for a hub file; Aryeo's own file URL for a video delivered there. */
  playSrc: string;
  downloadHref: string;
  durationSec: number | null;
  origin: "hub" | "aryeo";
  /** The logical program video, when there is one (dedupe key). */
  contentVideoId: string | null;
  /** Oct 24 2026 (lib/videoAnalysis): the chosen Instagram cover's download, when one was made. */
  coverHref?: string | null;
};

const VIDEOISH = ["VIDEO", "SOCIAL_REEL"] as const;
const MONTH_FMT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthWords = (key: string | null | undefined) => (key && /^\d{4}-\d{2}$/.test(key) ? MONTH_FMT.format(new Date(`${key}-15T12:00:00Z`)) : null);

const CUT_SELECT = {
  id: true, projectId: true, deliverableId: true, slot: true, outputId: true, round: true, fileName: true,
  blobUrl: true, assetPath: true, finalPath: true, sourceWidth: true, sourceHeight: true, decidedAt: true, sentToClientAt: true, videoId: true,
  deliverable: { select: { type: true, videoStyle: true, productTitle: true, label: true, quantity: true } },
  topazJob: { select: { state: true, finalPath: true, savedAt: true, outputCheck: true, outputWidth: true, outputHeight: true, sourceWidth: true, sourceHeight: true, deliveredAt: true, sourceDurationSec: true } },
  project: { select: { id: true, title: true, status: true, deliveredAt: true, contentMonthId: true, clientId: true, client: { select: { id: true, name: true } } } },
} satisfies Prisma.ReviewSubmissionSelect;
type CutRow = Prisma.ReviewSubmissionGetPayload<{ select: typeof CUT_SELECT }>;

/** The cut a hub library row plays (`/api/review/cut/<id>/stream`). */
export function portalCutId(row: { submissionId: string | null; playback: string | null; download?: string | null }): string | null {
  if (row.submissionId) return row.submissionId;
  for (const u of [row.playback, row.download]) {
    const m = /^\/api\/review\/cut\/([a-z0-9]{10,40})\/stream(?:\?|$)/i.exec(u ?? "");
    if (m) return m[1];
  }
  return null;
}

async function excludedClients(): Promise<string[]> {
  return import("@/lib/queries").then((m) => m.syntheticClientIds()).catch(() => [] as string[]);
}

/** When each cut reached a client's portal library (the earliest row that plays it). */
async function portalPublications(cutIds?: string[]): Promise<Map<string, Date>> {
  const rows = await prisma.portalVideo.findMany({
    where: { source: "review", ...(cutIds ? { OR: [{ submissionId: { in: cutIds } }, ...cutIds.map((id) => ({ playback: { startsWith: `/api/review/cut/${id}/` } }))] } : {}) },
    select: { submissionId: true, playback: true, download: true, deliveredAt: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) {
    const id = portalCutId(r);
    if (!id) continue;
    const prev = out.get(id);
    if (!prev || r.deliveredAt < prev) out.set(id, r.deliveredAt);
  }
  return out;
}

/** The facts one cut is judged done by (shared with the download route). */
async function outputsFor(cuts: { deliverableId: string | null }[]) {
  const ids = [...new Set(cuts.map((c) => c.deliverableId).filter((x): x is string => !!x))];
  const rows = ids.length
    ? await prisma.deliverableOutput.findMany({ where: { deliverableId: { in: ids } }, select: { id: true, deliverableId: true, slot: true, title: true, deliveredAt: true, sentSubmissionId: true } })
    : [];
  return new Map(rows.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
}

function factsOf(c: CutRow, output: { deliveredAt: Date | null; sentSubmissionId: string | null } | undefined, publishedAt: Date | null) {
  return {
    status: "APPROVED",
    sentToClientAt: c.sentToClientAt,
    decidedAt: c.decidedAt,
    topazDeliveredAt: c.topazJob?.deliveredAt ?? null,
    outputDeliveredAt: output && (!output.sentSubmissionId || output.sentSubmissionId === c.id) ? output.deliveredAt : null,
    projectStatus: c.project.status,
    projectDeliveredAt: c.project.deliveredAt,
    portalPublishedAt: publishedAt,
  };
}

/**
 * Every finished video, placed on its tab. `projectIds` narrows the read to
 * those jobs (a listing page); otherwise the whole library.
 */
export async function loadFinishedVideos(opts: { projectIds?: string[] } = {}): Promise<MediaVideo[]> {
  const excl = await excludedClients();
  const scope = opts.projectIds;
  const { resolveVideoStyle } = await import("@/lib/integrations/aryeo");

  const [cuts, portalRows] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: {
        status: "APPROVED", kind: "video",
        ...(scope ? { projectId: { in: scope } } : {}),
        project: { status: { not: "CANCELLED" }, ...(excl.length ? { clientId: { notIn: excl } } : {}) },
      },
      select: CUT_SELECT,
    }),
    prisma.portalVideo.findMany({
      where: { ...(scope ? { projectId: { in: scope } } : {}) },
      select: { id: true, enrollmentId: true, monthId: true, projectId: true, title: true, thumb: true, playback: true, download: true, source: true, deliveredAt: true, videoId: true, submissionId: true, label: true, externalKey: true },
    }),
  ]);

  const published = new Map<string, Date>();
  for (const r of portalRows) {
    if (r.source !== "review") continue;
    const id = portalCutId(r);
    if (!id) continue;
    const prev = published.get(id);
    if (!prev || r.deliveredAt < prev) published.set(id, r.deliveredAt);
  }
  const outputs = await outputsFor(cuts);

  // The rest of what the tiles need, one read each.
  const enrollmentIds = [...new Set(portalRows.map((r) => r.enrollmentId))];
  const aryeoRows = portalRows.filter((r) => r.source === "aryeo" && r.label !== "LISTING");
  const projectIds = [...new Set(aryeoRows.map((r) => r.projectId).filter((x): x is string => !!x))];
  const contentVideoIds = [...new Set([...portalRows.map((r) => r.videoId), ...cuts.map((c) => c.videoId)].filter((x): x is string => !!x))];
  const monthIds = [...new Set([...cuts.map((c) => c.project.contentMonthId), ...portalRows.map((r) => r.monthId)].filter((x): x is string => !!x))];
  const [enrollments, portalProjects, contentVideos, months] = await Promise.all([
    prisma.contentEnrollment.findMany({
      where: { OR: [{ id: { in: enrollmentIds } }, { clientId: { in: [...new Set(cuts.filter((c) => c.project.contentMonthId).map((c) => c.project.clientId))] } }] },
      select: { id: true, clientId: true, package: true, programKind: true },
    }),
    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: {
            id: true, title: true, status: true, contentMonthId: true, clientId: true, client: { select: { id: true, name: true } },
            deliverables: { where: { type: { in: [...VIDEOISH] }, removedFromOrderAt: null }, select: { id: true, type: true, videoStyle: true, productTitle: true, label: true } },
          },
        })
      : Promise.resolve([]),
    contentVideoIds.length ? prisma.contentVideo.findMany({ where: { id: { in: contentVideoIds } }, select: { id: true, title: true, topicId: true, monthKey: true, deliverableId: true } }) : Promise.resolve([]),
    monthIds.length ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, monthKey: true } }) : Promise.resolve([]),
  ]);
  const topicIds = [...new Set(contentVideos.map((v) => v.topicId).filter((x): x is string => !!x))];
  const cvDeliverableIds = [...new Set(contentVideos.map((v) => v.deliverableId).filter((x): x is string => !!x))];
  const [topics, cvDeliverables] = await Promise.all([
    topicIds.length ? prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    cvDeliverableIds.length ? prisma.deliverable.findMany({ where: { id: { in: cvDeliverableIds } }, select: { id: true, type: true, videoStyle: true, productTitle: true, label: true } }) : Promise.resolve([]),
  ]);
  const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));
  const enrollmentByClient = new Map(enrollments.map((e) => [e.clientId, e]));
  const projectById = new Map(portalProjects.map((p) => [p.id, p]));
  const cvById = new Map(contentVideos.map((v) => [v.id, v]));
  const topicById = new Map(topics.map((t) => [t.id, t.title]));
  const cvDeliverableById = new Map(cvDeliverables.map((d) => [d.id, d]));
  const monthKeyById = new Map(months.map((m) => [m.id, m.monthKey]));
  const titleOfCv = (id: string | null | undefined) => {
    const cv = id ? cvById.get(id) : undefined;
    if (!cv) return null;
    return cleanVideoTitle(cv.topicId ? topicById.get(cv.topicId) : null) ?? cleanVideoTitle(cv.title);
  };
  const styleOf = (d: { type: string; videoStyle: string | null; productTitle: string | null; label: string | null } | null | undefined): string | null =>
    d ? d.videoStyle ?? resolveVideoStyle(d.type, { title: d.productTitle ?? d.label }) : null;

  const items: MediaVideo[] = [];
  // What the index dedupe needs from the hub's tiles and the portal's.
  const hubTiles: HubTile[] = [];
  const pvByKey = new Map<string, MediaVideo>();
  const pvByDownload = new Map<string, MediaVideo>();

  // ---- the hub's own finished cuts ----
  const done = cuts
    .map((c) => {
      const output = c.deliverableId ? outputs.get(`${c.deliverableId}:${c.slot}`) : undefined;
      const d = cutDone(factsOf(c, output, published.get(c.id) ?? null));
      return { c, output, d };
    })
    .filter((x) => x.d.done && finishedFileOf({ ...x.c, topaz: x.c.topazJob }));
  const latest = latestPerSlot(done, (x) => (x.c.deliverableId ? `${x.c.deliverableId}:${x.c.slot}` : `sub:${x.c.id}`), (x) => x.c.round * 1e13 + (x.c.decidedAt?.getTime() ?? 0) / 1e3);
  for (const { c, output, d } of latest) {
    const p = c.project;
    const monthly = !!p.contentMonthId;
    const style = styleOf(c.deliverable);
    const enrollment = enrollmentByClient.get(p.clientId);
    const placement = placeVideo({ style, monthly, pkg: monthly ? programPackageOf(c.deliverable?.productTitle, enrollment?.package, enrollment?.programKind) : null });
    // A program video is named by its topic and dated by its month; a listing
    // video (a premium reel on a monthly client's job included) by its address
    // and the product sold.
    const program = monthly && placement.tab === "monthly";
    const street = streetOf(p.title) || null;
    const qty = c.deliverable?.quantity ?? 1;
    const named = cleanVideoTitle(output?.title) ?? titleOfCv(c.videoId);
    const title = named ?? (program ? cleanVideoTitle(c.fileName) : null) ?? (qty > 1 ? `${street ?? "Video"} · video ${c.slot} of ${qty}` : street) ?? "Video";
    const monthLine = monthWords(p.contentMonthId ? monthKeyById.get(p.contentMonthId) : null);
    const productLine = c.deliverable?.productTitle ?? c.deliverable?.label ?? null;
    const durationSec = c.topazJob?.sourceDurationSec ?? null;
    const item: MediaVideo = {
      key: `cut:${c.id}`,
      placement,
      title,
      eyebrow: program ? monthLine ?? productLine : productLine,
      place: p.title,
      clientId: p.client?.id ?? p.clientId,
      clientName: p.client?.name ?? null,
      projectId: p.id,
      dateISO: d.at?.toISOString() ?? null,
      dateText: d.at ? `${d.word} ${etDateYear(d.at)}` : null,
      orientation: orientationOf(c.topazJob?.outputWidth, c.topazJob?.outputHeight) ?? orientationOf(c.sourceWidth, c.sourceHeight) ?? orientationOf(c.topazJob?.sourceWidth, c.topazJob?.sourceHeight),
      poster: null,
      playSrc: `/api/media/video/${c.id}`,
      downloadHref: `/api/media/video/${c.id}?dl=1`,
      durationSec,
      origin: "hub",
      contentVideoId: c.videoId,
    };
    items.push(item);
    hubTiles.push({
      item, cutId: c.id, projectId: p.id, slotKey: c.deliverableId ? `${c.deliverableId}:${c.slot}` : `sub:${c.id}`, style, durationSec,
      names: new Set([output?.title, titleOfCv(c.videoId), c.fileName, c.deliverable?.productTitle, c.deliverable?.label].map(normTitle).filter(Boolean)),
    });
  }

  // ---- program videos delivered through the session's Aryeo listing ----
  for (const r of aryeoRows) {
    const p = r.projectId ? projectById.get(r.projectId) : undefined;
    if (!p || p.status === "CANCELLED" || !r.download) continue;
    if (excl.includes(p.clientId)) continue;
    const enrollment = enrollmentById.get(r.enrollmentId);
    const cv = r.videoId ? cvById.get(r.videoId) : undefined;
    const own = cv?.deliverableId ? cvDeliverableById.get(cv.deliverableId) : undefined;
    const branding = p.deliverables.find((d) => styleOf(d) === "personal_branding");
    const style = styleOf(own) ?? (branding ? "personal_branding" : p.deliverables.length === 1 ? styleOf(p.deliverables[0]) : null);
    const placement = placeVideo({ style, monthly: true, pkg: programPackageOf(branding?.productTitle ?? null, enrollment?.package, enrollment?.programKind) });
    const title = titleOfCv(r.videoId) ?? cleanVideoTitle(r.title) ?? "Video";
    const name = `${fileStem(title, "video")}.${(/\.([a-z0-9]{2,4})(?:\?|$)/i.exec(r.download)?.[1] ?? "mp4").toLowerCase()}`;
    const pv: MediaVideo = {
      key: `pv:${r.id}`,
      placement,
      title,
      eyebrow: monthWords(cv?.monthKey ?? (r.monthId ? monthKeyById.get(r.monthId) : null)) ?? (placement.tab === "monthly" ? null : own?.productTitle ?? null),
      place: p.title,
      clientId: p.client?.id ?? p.clientId,
      clientName: p.client?.name ?? null,
      projectId: p.id,
      dateISO: r.deliveredAt.toISOString(),
      dateText: `Delivered ${etDateYear(r.deliveredAt)}`,
      orientation: null,
      poster: r.thumb,
      playSrc: r.download,
      downloadHref: `/api/media/download?url=${encodeURIComponent(r.download)}&name=${encodeURIComponent(name)}`,
      durationSec: null,
      origin: "aryeo",
      contentVideoId: r.videoId,
    };
    items.push(pv);
    const key = /^aryeo:([^:]+):(.+)$/.exec(r.externalKey);
    if (key) pvByKey.set(`${key[1]}:${key[2]}`, pv);
    pvByDownload.set(r.download, pv);
  }

  // ---- older videos, from the index of the Aryeo listings ----
  items.push(...(await indexedListingVideos({
    scope, excl, hubTiles, pvByKey, pvByDownload,
    cuts: cuts.map((c) => ({ id: c.id, projectId: c.projectId, slotKey: c.deliverableId ? `${c.deliverableId}:${c.slot}` : `sub:${c.id}` })),
    styleOf,
  })));

  // ---- one logical video once: the newest; a tie goes to the hub's file ----
  const byVideo = new Map<string, MediaVideo>();
  const rest: MediaVideo[] = [];
  for (const it of items) {
    if (!it.contentVideoId) { rest.push(it); continue; }
    const cur = byVideo.get(it.contentVideoId);
    if (!cur) { byVideo.set(it.contentVideoId, it); continue; }
    const a = Date.parse(it.dateISO ?? "") || 0;
    const b = Date.parse(cur.dateISO ?? "") || 0;
    const keep = a > b || (a === b && it.origin === "hub" && cur.origin !== "hub") ? it : cur;
    const drop = keep === it ? cur : it;
    byVideo.set(it.contentVideoId, { ...keep, poster: keep.poster ?? drop.poster });
  }
  const list = [...rest, ...byVideo.values()];
  // INSTAGRAM COVERS (Oct 24 2026, lib/videoAnalysis): a hub video's chosen
  // cover is offered beside its download, and is the tile's poster when the
  // video is vertical (a 9:16 cover over a wide tile would be cropped). A failed
  // read leaves the tiles exactly as they were.
  const chips = await import("@/lib/videoAnalysis")
    .then((m) => m.staffCoverChips(list.filter((v) => v.origin === "hub" && v.key.startsWith("cut:")).map((v) => v.key.slice(4))))
    .catch(() => null);
  if (chips) {
    for (const v of list) {
      const c = v.key.startsWith("cut:") ? chips.get(v.key.slice(4)) : undefined;
      if (!c) continue;
      v.coverHref = c.downloadHref;
      if (v.orientation !== "horizontal") v.poster = c.src;
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// THE INDEXED ARYEO VIDEOS (Oct 24 2026), deduped against the tiles above.
// ---------------------------------------------------------------------------

type HubTile = { item: MediaVideo; cutId: string; projectId: string; slotKey: string; style: string | null; durationSec: number | null; names: Set<string> };
type StyleRow = { type: string; videoStyle: string | null; productTitle: string | null; label: string | null };

/** Delivered: the one rule the Photos tab and /listings use too. */
const DELIVERED_JOB = { OR: [{ status: "DELIVERED" as const }, { status: "REVISION" as const, deliveredAt: { not: null } }] } satisfies Prisma.ProjectWhereInput;

const missingIndex = (e: unknown) => import("@/lib/listingMediaIndex").then((m) => m.indexTableMissing(e));

async function indexedListingVideos(ctx: {
  scope?: string[]; excl: string[]; hubTiles: HubTile[];
  pvByKey: Map<string, MediaVideo>; pvByDownload: Map<string, MediaVideo>;
  cuts: { id: string; projectId: string; slotKey: string }[];
  styleOf: (d: StyleRow | null | undefined) => string | null;
}): Promise<MediaVideo[]> {
  const rows = await prisma.listingMediaItem
    .findMany({
      where: { kind: "VIDEO", removedAt: null, ...(ctx.scope ? { projectId: { in: ctx.scope } } : {}) },
      select: { id: true, projectId: true, aryeoListingId: true, aryeoMediaId: true, title: true, durationSec: true, orientation: true, thumbnailUrl: true, downloadUrl: true, position: true, deliveredAt: true },
      orderBy: [{ projectId: "asc" }, { position: "asc" }],
    })
    .catch(async (e) => { if (await missingIndex(e)) return []; throw e; });
  if (!rows.length) return [];

  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, ...DELIVERED_JOB, ...(ctx.excl.length ? { clientId: { notIn: ctx.excl } } : {}) },
    select: {
      id: true, title: true, deliveredAt: true, contentMonthId: true, clientId: true,
      client: { select: { id: true, name: true, socialClient: true, socialPlan: true } },
      deliverables: { where: { type: { in: [...VIDEOISH] }, removedFromOrderAt: null }, select: { type: true, videoStyle: true, productTitle: true, label: true, quantity: true } },
    },
  });
  if (!projects.length) return [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const clientIds = [...new Set(projects.map((p) => p.clientId))];
  const cutIds = ctx.cuts.filter((c) => projectById.has(c.projectId)).map((c) => c.id);
  const monthIds = [...new Set(projects.map((p) => p.contentMonthId).filter((x): x is string => !!x))];
  const [enrollments, months, receipts] = await Promise.all([
    prisma.contentEnrollment.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, package: true, programKind: true } }),
    monthIds.length ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, monthKey: true } }) : Promise.resolve([]),
    cutIds.length
      ? prisma.auditLog.findMany({ where: { target: { in: cutIds }, action: { in: ["video_uploaded", "video_upload_corrected"] } }, select: { id: true, target: true, action: true, detail: true } })
      : Promise.resolve([]),
  ]);
  const enrollmentByClient = new Map(enrollments.map((e) => [e.clientId, e]));
  const monthKeyById = new Map(months.map((m) => [m.id, m.monthKey]));

  // ARYEO'S ID → THE HUB'S CUT: an upload receipt names the listing videos it
  // went up as (the hub's own push, or the listing check). A receipt a person
  // corrected names nothing.
  const corrected = new Set<string>();
  const uploads: { id: string; target: string; mediaIds: string[] }[] = [];
  for (const r of receipts) {
    try {
      const d = JSON.parse(r.detail) as { receiptId?: unknown; mediaIds?: unknown };
      if (r.action === "video_upload_corrected") { if (typeof d.receiptId === "string") corrected.add(d.receiptId); continue; }
      if (Array.isArray(d.mediaIds)) uploads.push({ id: r.id, target: r.target, mediaIds: d.mediaIds.filter((m): m is string => typeof m === "string") });
    } catch { /* an unreadable receipt proves nothing */ }
  }
  const cutOfMedia = new Map<string, string>();
  for (const u of uploads) if (!corrected.has(u.id)) for (const m of u.mediaIds) cutOfMedia.set(m, u.target);
  const slotOfCut = new Map(ctx.cuts.map((c) => [c.id, c.slotKey]));
  const hubBySlot = new Map(ctx.hubTiles.map((h) => [h.slotKey, h]));
  const hubsByProject = new Map<string, HubTile[]>();
  for (const h of ctx.hubTiles) hubsByProject.set(h.projectId, [...(hubsByProject.get(h.projectId) ?? []), h]);

  // A LISTING SHARED BY TWO JOBS (12 live): its video shows once, under the
  // job it was delivered for (the first delivered after it went up), else the newest.
  const ownerOf = new Map<string, string>();
  const byMedia = new Map<string, typeof rows>();
  for (const r of rows) if (projectById.has(r.projectId)) byMedia.set(r.aryeoMediaId, [...(byMedia.get(r.aryeoMediaId) ?? []), r]);
  for (const [mediaId, list] of byMedia) {
    const jobs = list.map((r) => projectById.get(r.projectId)!).sort((a, b) => (a.deliveredAt?.getTime() ?? 0) - (b.deliveredAt?.getTime() ?? 0));
    const up = list[0].deliveredAt?.getTime() ?? null;
    const after = up != null ? jobs.find((j) => (j.deliveredAt?.getTime() ?? 0) >= up - 86_400_000) : undefined;
    ownerOf.set(mediaId, (after ?? jobs[jobs.length - 1]).id);
  }

  const fill = (to: MediaVideo, r: (typeof rows)[number], poster: boolean) => {
    if (to.durationSec == null && r.durationSec != null) to.durationSec = r.durationSec;
    if (poster && !to.poster && r.thumbnailUrl) to.poster = r.thumbnailUrl;
  };

  const out: MediaVideo[] = [];
  for (const r of rows) {
    const p = projectById.get(r.projectId);
    if (!p || ownerOf.get(r.aryeoMediaId) !== p.id) continue;
    // 1 · the portal already shows it (its key is Aryeo's id; an older row matches by the file's address).
    const pv = ctx.pvByKey.get(`${r.aryeoListingId}:${r.aryeoMediaId}`) ?? (r.downloadUrl ? ctx.pvByDownload.get(r.downloadUrl) : undefined);
    if (pv) { fill(pv, r, false); continue; }
    // 2 · the hub put it there (an upload receipt names this Aryeo id): the hub's file wins.
    const cutId = cutOfMedia.get(r.aryeoMediaId);
    const viaReceipt = cutId ? hubBySlot.get(slotOfCut.get(cutId) ?? "") : undefined;
    if (viaReceipt) { fill(viaReceipt.item, r, viaReceipt.cutId === cutId); continue; }
    // 3 · the same job, the same title, the same length (when both are known).
    const hubs = hubsByProject.get(p.id) ?? [];
    const t = normTitle(r.title);
    const named = t ? hubs.filter((h) => h.names.has(t) && sameDuration(h.durationSec, r.durationSec) !== false) : [];
    if (named.length) { if (named.length === 1) fill(named[0].item, r, sameDuration(named[0].durationSec, r.durationSec) === true); continue; }
    // 4 · the hub already holds a finished file for every video of this type the job owed.
    const styles = p.deliverables.map((d) => ({ style: ctx.styleOf(d), d }));
    const style = classifyListingVideo(r.title, styles.map((x) => x.style));
    const owed = styles.filter((x) => x.style === style).reduce((n, x) => n + Math.max(1, x.d.quantity ?? 1), 0);
    if (style && owed > 0 && hubs.filter((h) => h.style === style).length >= owed) continue;

    const enrollment = enrollmentByClient.get(p.clientId);
    const onPlan = !!enrollment || !!p.client?.socialClient || !!p.client?.socialPlan;
    const monthly = !!p.contentMonthId || onPlan;
    const own = styles.find((x) => x.style === style)?.d;
    const branding = styles.find((x) => x.style === "personal_branding")?.d;
    const placement = placeVideo({ style, monthly, pkg: monthly ? programPackageOf(branding?.productTitle ?? own?.productTitle ?? null, enrollment?.package ?? p.client?.socialPlan ?? null, enrollment?.programKind) : null });
    const program = placement.tab === "monthly" && !!p.contentMonthId;
    const up = r.deliveredAt;
    const at = up && p.deliveredAt ? (up > p.deliveredAt ? up : p.deliveredAt) : up ?? p.deliveredAt;
    out.push({
      key: `aryeo:${r.id}`,
      placement,
      title: cleanVideoTitle(r.title) ?? (streetOf(p.title) || "Video"),
      eyebrow: program ? monthWords(monthKeyById.get(p.contentMonthId!)) : own?.productTitle ?? own?.label ?? null,
      place: p.title,
      clientId: p.client?.id ?? p.clientId,
      clientName: p.client?.name ?? null,
      projectId: p.id,
      dateISO: at?.toISOString() ?? null,
      dateText: at ? `Delivered ${etDateYear(at)}` : null,
      orientation: r.orientation === "vertical" || r.orientation === "horizontal" ? r.orientation : null,
      poster: r.thumbnailUrl,
      playSrc: `/api/media/aryeo/${r.id}`,
      downloadHref: `/api/media/aryeo/${r.id}?dl=1`,
      durationSec: r.durationSec,
      origin: "aryeo",
      contentVideoId: null,
    });
  }
  return out;
}

/** The file behind an indexed Aryeo video, for /api/media/aryeo/<row>: still on its listing, on a delivered job, on Aryeo's own host. */
export async function indexedVideoFile(id: string): Promise<{ ok: true; url: string; title: string; ext: string } | { ok: false; status: 404; error: string }> {
  const row = await prisma.listingMediaItem
    .findUnique({ where: { id }, select: { kind: true, removedAt: true, downloadUrl: true, title: true, projectId: true } })
    .catch(async (e) => { if (await missingIndex(e)) return null; throw e; });
  if (!row || row.kind !== "VIDEO") return { ok: false, status: 404, error: "Not found" };
  if (row.removedAt) return { ok: false, status: 404, error: "That video is no longer on its Aryeo listing, so it isn't in the media library." };
  const p = await prisma.project.findFirst({ where: { id: row.projectId, ...DELIVERED_JOB }, select: { title: true } });
  if (!p) return { ok: false, status: 404, error: "That video's job isn't a delivered listing, so it isn't in the media library." };
  const u = aryeoMediaUrl(row.downloadUrl);
  if (!u) return { ok: false, status: 404, error: "No file of Aryeo's is on record for that video." };
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(u.pathname)?.[1] ?? "mp4").toLowerCase();
  return { ok: true, url: u.toString(), title: cleanVideoTitle(row.title) ?? (streetOf(p.title) || "video"), ext };
}

// ---------------------------------------------------------------------------
// ONE FILE, FOR THE ROUTE: is this cut in the library, and which file is it.
// ---------------------------------------------------------------------------

export type MediaFileAnswer =
  | { ok: true; file: import("@/lib/mediaLibraryCore").FinishedFile }
  | { ok: false; status: 404 | 409; error: string };

export async function mediaFileForCut(id: string): Promise<MediaFileAnswer> {
  const c = await prisma.reviewSubmission.findUnique({ where: { id }, select: { ...CUT_SELECT, status: true, kind: true } });
  if (!c || c.kind !== "video") return { ok: false, status: 404, error: "Not found" };
  if (c.status !== "APPROVED") return { ok: false, status: 404, error: "That version isn't in the media library: only approved videos that went to the client are." };
  const outputs = await outputsFor([c]);
  const published = await portalPublications([c.id]);
  const d = cutDone(factsOf(c, c.deliverableId ? outputs.get(`${c.deliverableId}:${c.slot}`) : undefined, published.get(c.id) ?? null));
  if (!d.done) return { ok: false, status: 409, error: "That video hasn't gone to the client yet, so it isn't in the media library." };
  const file = finishedFileOf({ ...c, topaz: c.topazJob });
  if (!file) return { ok: false, status: 404, error: "No file is attached to that video." };
  return { ok: true, file };
}

// ---------------------------------------------------------------------------
// PHOTOS AND LISTINGS: delivered jobs with an Aryeo listing, read from what
// the status engine stored (the listing's photo count and cover). A job the
// engine looked at and found no photos on is left out; a job it never looked
// at (older history) counts when it ordered photos.
// ---------------------------------------------------------------------------

export type ListingCard = {
  projectId: string;
  title: string;
  street: string;
  town: string | null;
  clientId: string;
  clientName: string | null;
  dateISO: string | null;
  dateText: string | null;
  cover: string | null;
  photoCount: number | null;
  /** What was delivered, in words ("Photos", "Video", "Floor plan", "3D tour"). */
  delivered: string[];
  hasPhotos: boolean;
  /** Other delivered shoots at the same address (photos tab), newest first. */
  earlier: { projectId: string; dateText: string | null }[];
};

const KIND_WORD: Partial<Record<string, string>> = {
  PHOTOS: "Photos", TWILIGHT: "Photos", DRONE: "Photos", VIRTUAL_STAGING: "Photos", HEADSHOT: "Photos",
  VIDEO: "Video", SOCIAL_REEL: "Video", FLOORPLAN: "Floor plan", ZILLOW_3D: "3D tour", MATTERPORT_3D: "3D tour",
};
const KIND_ORDER = ["Photos", "Video", "Floor plan", "3D tour"];

/** Every delivered listing, newest first (the evidence read is one small query, regex-extracted so a stray row can't break it). */
export async function loadDeliveredListings(): Promise<ListingCard[]> {
  const excl = await excludedClients();
  const { indexedCovers } = await import("@/lib/listingMediaIndex");
  const [rows, evidence, indexCovers] = await Promise.all([
    prisma.project.findMany({
      where: {
        aryeoListingId: { not: null },
        OR: [{ status: "DELIVERED" }, { status: "REVISION", deliveredAt: { not: null } }],
        ...(excl.length ? { clientId: { notIn: excl } } : {}),
      },
      select: {
        id: true, title: true, deliveredAt: true, coverImageUrl: true, clientId: true, client: { select: { name: true } },
        deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true } },
      },
      orderBy: [{ deliveredAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    }),
    prisma.$queryRaw<{ id: string; photos: string | null; cover: string | null }[]>`
      select id,
        substring("statusEvidence" from '"aryeo":\\{"photos":([0-9]+)') as photos,
        substring("statusEvidence" from '"cover":"(https://[^"]+)"') as cover
      from "Project"
      where "statusEvidence" is not null and status in ('DELIVERED', 'REVISION')`,
    // Oct 24 2026: the listing's own cover from the index of the Aryeo
    // listings, for the ~1,000 older jobs that never stored one.
    indexedCovers(),
  ]);
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const out: ListingCard[] = [];
  for (const p of rows) {
    const e = ev.get(p.id);
    const ix = indexCovers.get(p.id);
    const evCount = e?.photos != null && /^\d+$/.test(e.photos) ? Number(e.photos) : null;
    const count = ix?.photoCount != null && ix.photoCount > 0 && !evCount ? ix.photoCount : evCount;
    const cover = p.coverImageUrl ?? e?.cover ?? ix?.url ?? null;
    const orderedPhotos = p.deliverables.some((d) => KIND_WORD[d.type] === "Photos");
    const hasPhotos = !!cover || (count != null ? count > 0 : orderedPhotos);
    const words = [...new Set(p.deliverables.map((d) => KIND_WORD[d.type]).filter((w): w is string => !!w))];
    if (hasPhotos && !words.includes("Photos")) words.push("Photos");
    if (!hasPhotos && count === 0) {
      const i = words.indexOf("Photos");
      if (i >= 0) words.splice(i, 1);
    }
    const [street, ...rest] = p.title.split(",");
    out.push({
      projectId: p.id,
      title: p.title,
      street: street.trim() || p.title,
      town: rest.join(",").trim() || null,
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
      dateISO: p.deliveredAt?.toISOString() ?? null,
      dateText: p.deliveredAt ? etDateYear(p.deliveredAt) : null,
      cover,
      photoCount: count != null && count > 0 ? count : null,
      delivered: words.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)),
      hasPhotos,
      earlier: [],
    });
  }
  return out;
}

/** The Photos tab: one tile per address (its newest delivered shoot), earlier shoots there listed on it. */
export function photosByAddress(listings: ListingCard[]): ListingCard[] {
  const byAddress = new Map<string, ListingCard>();
  for (const l of listings) {
    if (!l.hasPhotos) continue;
    const k = addressKey(l.title) || l.projectId;
    const cur = byAddress.get(k);
    if (!cur) { byAddress.set(k, { ...l, earlier: [] }); continue; }
    const newer = (Date.parse(l.dateISO ?? "") || 0) > (Date.parse(cur.dateISO ?? "") || 0);
    if (newer) byAddress.set(k, { ...l, cover: l.cover ?? cur.cover, earlier: [{ projectId: cur.projectId, dateText: cur.dateText }, ...cur.earlier] });
    else cur.earlier.push({ projectId: l.projectId, dateText: l.dateText });
  }
  return [...byAddress.values()];
}

/** One listing's header facts and the other delivered shoots at its address. */
export async function loadListingHeader(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true, deliveredAt: true, shootDate: true, coverImageUrl: true, aryeoListingId: true, aryeoOrderId: true, contentMonthId: true,
      clientId: true, client: { select: { id: true, name: true, company: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, productTitle: true, label: true } },
    },
  });
  if (!p) return null;
  const street = streetOf(p.title);
  const siblings = street
    ? await prisma.project.findMany({
        where: { id: { not: p.id }, title: { startsWith: street, mode: "insensitive" }, OR: [{ status: "DELIVERED" }, { status: "REVISION", deliveredAt: { not: null } }] },
        select: { id: true, title: true, deliveredAt: true },
        orderBy: { deliveredAt: { sort: "desc", nulls: "last" } },
        take: 10,
      })
    : [];
  const key = addressKey(p.title);
  // Oct 24 2026: the indexed cover, for a job that never stored one (the page prefers Aryeo's live cover).
  const indexCover = p.coverImageUrl ? null : await import("@/lib/listingMediaIndex").then((m) => m.indexedCovers([p.id])).then((m) => m.get(p.id)?.url ?? null).catch(() => null);
  return {
    project: p,
    indexCover,
    otherShoots: siblings.filter((s) => addressKey(s.title) === key).map((s) => ({ projectId: s.id, dateText: s.deliveredAt ? etDateYear(s.deliveredAt) : null })),
  };
}

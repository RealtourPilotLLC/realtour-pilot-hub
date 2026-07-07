import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@prisma/client";
import { Aryeo } from "@/lib/integrations/aryeo";
import { dropboxConfigured, dropboxListFolder } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { projectFolderPaths } from "@/lib/dropboxFolders";
import { standardDeliveryDue, deliveryDueFrom } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// Smart project-status engine.
//
// Aryeo flips an order to FULFILLED the moment ANY media is delivered — so when
// we send photos early and the video later, the order looks "done" while work
// remains. Kyle forgets to un-toggle it. This engine ignores that single flag
// and instead figures out the TRUE stage by cross-checking, per ordered item:
//   • what was ordered  (parsed from the order's line items)            EXPECTED
//   • what's live on the Aryeo listing (photos/videos/floor-plans/3D)   PRESENT
//   • what's sitting in the Dropbox raw/final folders                   IN-FLIGHT
// A job is only DELIVERED when every expected category is actually present.
// "Fulfilled on Aryeo but a category missing" → REVIEW, flagged as a partial.
// ---------------------------------------------------------------------------

export type MediaCategory = "PHOTOS" | "VIDEO" | "FLOORPLAN" | "THREED";

const CATEGORY_LABEL: Record<MediaCategory, string> = {
  PHOTOS: "Photos",
  VIDEO: "Video",
  FLOORPLAN: "Floor plan",
  THREED: "3D tour",
};

// Keyword → category. A single line item can imply several categories
// (e.g. "Gold Package + Video + Floor Plan"), so we scan for ALL matches.
const CATEGORY_KEYWORDS: [RegExp, MediaCategory][] = [
  [/floor\s?plan|2d plan|iguide/i, "FLOORPLAN"],
  [/matterport|3d tour|3-d|zillow 3d|virtual tour|interactive tour/i, "THREED"],
  [/reel|video|cinematic|walkthrough|walk-through|motion|social media|teaser|vertical/i, "VIDEO"],
  // Photos last + broad: packages/bundles/tiers, plus photo add-ons that are
  // delivered as listing images (twilight, drone, headshots, virtual staging).
  [/photo|hdr|image|gallery|package|bundle|bronze|silver|gold|platinum|diamond|essential|twilight|dusk|drone|aerial|headshot|portrait|virtual stag/i, "PHOTOS"],
];

export function categoriesForLabel(label: string): MediaCategory[] {
  const out: MediaCategory[] = [];
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(label) && !out.includes(cat)) out.push(cat);
  return out;
}

// Content goes out staged: photos next day, then the video/reel. A pending
// reel isn't "missing" until its turnaround window passes — and that window is
// the SINGLE source of truth in tasks.ts (`deliveryDueFrom`: standard 48h,
// premium 72h, monthly content 7-10 business days). computeStatus calls it so
// the status card, delivery-due, and QA task never disagree.
export type VideoTier = "standard" | "premium";
// Premium = the higher-end reel products (longer edit). Tune these keywords.
const PREMIUM_VIDEO_RE = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;

// Classify a project's video deliverable as standard vs premium (or null if no
// video was ordered) — by the order item's product name.
export function videoTier(deliverables: { type: string; label: string | null }[]): VideoTier | null {
  let hasVideo = false;
  let premium = false;
  for (const d of deliverables) {
    if (!expectedCategories([d]).has("VIDEO")) continue;
    hasVideo = true;
    if (PREMIUM_VIDEO_RE.test(d.label ?? "")) premium = true;
  }
  if (!hasVideo) return null;
  return premium ? "premium" : "standard";
}

// Derive the set of media categories an order is expected to deliver from its
// line items (the Deliverable rows mirror the Aryeo order items).
export function expectedCategories(
  deliverables: { type: string; label: string | null }[],
): Set<MediaCategory> {
  const set = new Set<MediaCategory>();
  for (const d of deliverables) {
    // Trust the parsed type first, then keyword-scan the label for extras.
    switch (d.type) {
      case "PHOTOS":
      case "TWILIGHT":
      case "DRONE":
      case "HEADSHOT":
      case "VIRTUAL_STAGING":
        set.add("PHOTOS");
        break;
      case "VIDEO":
      case "SOCIAL_REEL":
        set.add("VIDEO");
        break;
      case "FLOORPLAN":
        set.add("FLOORPLAN");
        break;
      case "MATTERPORT_3D":
      case "ZILLOW_3D":
        set.add("THREED");
        break;
    }
    for (const c of categoriesForLabel(d.label ?? "")) set.add(c);
  }
  return set;
}

// ---- signals + decision ----------------------------------------------------

export type AryeoMediaSignal = {
  photos: number;
  videos: number;
  floorPlans: number;
  interactive: number;
  delivery: string | null; // listing delivery_status: DELIVERED | UNDELIVERED
};

export type DropboxSignal = {
  rawPhotos: number;
  rawVideo: number;
  finalPhotos: number;
  finalVideo: number;
};

export type StatusSignals = {
  expected: Set<MediaCategory>;
  aryeo: AryeoMediaSignal | null;
  dropbox: DropboxSignal | null;
  fulfilled: boolean; // Aryeo order fulfilled_at present
  scheduled: boolean; // a SCHEDULED (non-cancelled) appointment exists
  anyAppt: boolean;
  shootDate: Date | null;
  revisionOpen: boolean; // client requested changes after delivery (comms)
  revisionNote?: string | null;
  videoTier: VideoTier | null; // standard | premium (null = no video ordered)
  videoType?: string | null; // the reel/video deliverable type (SOCIAL_REEL | VIDEO)
  monthlyContent: boolean; // recurring social-plan content (longer turnaround)
};

export type StatusEvidence = {
  expected: string[];
  present: string[];
  missing: string[];
  partial: boolean; // looked delivered on Aryeo but content is missing
  aryeo: AryeoMediaSignal | null;
  dropbox: DropboxSignal | null;
  fulfilledOnAryeo: boolean;
  reason: string;
  checkedAt: string;
  // Video SLA: when a pending video is due, and whether it's past that window.
  videoTier: VideoTier | null;
  videoDue: string | null; // ISO date the video is expected by
  videoOverdue: boolean; // past the window with no video delivered yet
};

export type StatusResult = { status: ProjectStatus; evidence: StatusEvidence };

export function computeStatus(sig: StatusSignals): StatusResult {
  const a = sig.aryeo;
  const d = sig.dropbox;

  const present = new Set<MediaCategory>();
  if ((a?.photos ?? 0) > 0 || (d?.finalPhotos ?? 0) > 0) present.add("PHOTOS");
  if ((a?.videos ?? 0) > 0 || (d?.finalVideo ?? 0) > 0) present.add("VIDEO");
  if ((a?.floorPlans ?? 0) > 0) present.add("FLOORPLAN");
  if ((a?.interactive ?? 0) > 0) present.add("THREED");

  const anyAryeoMedia = a ? a.photos + a.videos + a.floorPlans + a.interactive > 0 : false;
  const anyFinalDropbox = d ? d.finalPhotos + d.finalVideo > 0 : false;
  const anyRaw = d ? d.rawPhotos + d.rawVideo > 0 : false;
  const deliveredOnAryeo = a?.delivery === "DELIVERED";
  const fulfilled = sig.fulfilled || deliveredOnAryeo;

  const expected = [...sig.expected];
  const verifiable = expected.length > 0;
  const missing = verifiable ? expected.filter((c) => !present.has(c)) : [];
  // Satisfied = everything ordered is present. When we can't parse what was
  // ordered, fall back to "Aryeo says fulfilled AND some media exists".
  const satisfied = verifiable ? missing.length === 0 : fulfilled && anyAryeoMedia;

  // Video SLA: a missing video is only a problem once its production window
  // (shoot date + standard/premium SLA) has passed. Before that, it's on-track.
  const fmtDate = (dt: Date) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let videoDue: Date | null = null;
  let videoOverdue = false;
  // Only when content has actually started going out (photos/other media present)
  // AND the video specifically is still missing — i.e. a real staged/partial
  // delivery. Not for shoots that haven't happened yet (present is empty there).
  if (missing.includes("VIDEO") && present.size > 0 && sig.videoTier && sig.shootDate) {
    // Use the SAME turnaround the task engine uses, so the status card, the
    // project's delivery-due, and the QA task all agree on one date.
    videoDue = deliveryDueFrom(sig.shootDate, sig.videoType ?? "SOCIAL_REEL", {
      premium: sig.videoTier === "premium",
      monthlyContent: sig.monthlyContent,
    });
    videoOverdue = Date.now() > videoDue.getTime();
  }

  let status: ProjectStatus;
  let reason: string;

  // Comms override: a client asked for changes after delivery. The media may
  // all be present, but the job is NOT done until the revision is handled.
  if (sig.revisionOpen) {
    return {
      status: "REVISION",
      evidence: {
        expected: expected.map((c) => CATEGORY_LABEL[c]),
        present: [...present].map((c) => CATEGORY_LABEL[c]),
        missing: missing.map((c) => CATEGORY_LABEL[c as MediaCategory]),
        partial: false,
        aryeo: a,
        dropbox: d,
        fulfilledOnAryeo: fulfilled,
        reason: sig.revisionNote
          ? `Client requested changes after delivery: "${sig.revisionNote.slice(0, 160)}"`
          : "Client requested changes after delivery — revision in progress.",
        checkedAt: new Date().toISOString(),
        videoTier: sig.videoTier,
        videoDue: null,
        videoOverdue: false,
      },
    };
  }

  if (satisfied && fulfilled) {
    status = "DELIVERED";
    reason = verifiable
      ? "All ordered deliverables confirmed live on Aryeo."
      : "Order fulfilled and media is live on Aryeo.";
  } else if (satisfied && !fulfilled) {
    status = "REVIEW";
    reason = "All media is present but the order isn't marked delivered on Aryeo yet — ready to deliver.";
  } else if ((fulfilled || anyFinalDropbox || anyAryeoMedia) && verifiable && missing.length > 0) {
    status = "REVIEW";
    const others = missing.filter((c) => c !== "VIDEO").map((c) => CATEGORY_LABEL[c]);
    if (missing.includes("VIDEO") && videoDue) {
      const tier = sig.videoTier === "premium" ? "Premium" : "Standard";
      reason = videoOverdue
        ? `Video overdue — was due ${fmtDate(videoDue)}. Confirm it was delivered to the client, or upload it.`
        : `Photos delivered. ${tier} video in production — due ${fmtDate(videoDue)}.`;
      if (others.length) reason += ` Also missing ${others.join(", ")}.`;
    } else {
      reason = `Partial delivery — still missing ${missing.map((m) => CATEGORY_LABEL[m as MediaCategory]).join(", ")}.`;
    }
  } else if (anyRaw) {
    status = "SHOT";
    reason = "Raw files uploaded to Dropbox — awaiting editing.";
  } else if (sig.scheduled || (sig.shootDate && sig.shootDate.getTime() > Date.now())) {
    status = "SCHEDULED";
    reason = "Shoot scheduled.";
  } else if (sig.anyAppt || sig.shootDate) {
    status = "SCHEDULED";
    reason = "Appointment on file.";
  } else {
    status = "BOOKED";
    reason = "No shoot scheduled yet.";
  }

  const partial = fulfilled && verifiable && missing.length > 0;

  return {
    status,
    evidence: {
      expected: expected.map((c) => CATEGORY_LABEL[c]),
      present: [...present].map((c) => CATEGORY_LABEL[c]),
      missing: missing.map((c) => CATEGORY_LABEL[c as MediaCategory]),
      partial,
      aryeo: a,
      dropbox: d,
      fulfilledOnAryeo: fulfilled,
      reason,
      checkedAt: new Date().toISOString(),
      videoTier: sig.videoTier,
      videoDue: videoDue ? videoDue.toISOString() : null,
      videoOverdue,
    },
  };
}

// ---- data gathering --------------------------------------------------------

async function aryeoMedia(listingId: string): Promise<AryeoMediaSignal | null> {
  try {
    const l = await Aryeo.listing(listingId);
    return {
      photos: l.images?.length ?? 0,
      videos: l.videos?.length ?? 0,
      floorPlans: l.floor_plans?.length ?? 0,
      interactive: l.interactive_content?.length ?? 0,
      delivery: l.delivery_status ?? null,
    };
  } catch {
    return null;
  }
}

async function folderCount(path: string): Promise<number> {
  try {
    return (await dropboxListFolder(path)).filter((e) => e.tag === "file").length;
  } catch {
    return 0;
  }
}

type StatusProject = {
  id: string;
  title: string;
  status: ProjectStatus;
  aryeoListingId: string | null;
  deliveredAt: Date | null;
  shootDate: Date | null;
  addressLine: string | null;
  createdAt: Date;
  revisionRequestedAt: Date | null;
  revisionNote: string | null;
  client: { name: string; socialClient: boolean };
  deliverables: { id: string; type: string; label: string | null }[];
  appointments: { status: string | null }[];
};

async function gatherSignals(p: StatusProject, useDropbox: boolean): Promise<StatusSignals> {
  const expected = expectedCategories(p.deliverables);
  const aryeo = p.aryeoListingId ? await aryeoMedia(p.aryeoListingId) : null;

  // Only spend Dropbox calls when Aryeo doesn't already account for everything
  // ordered — Aryeo is the delivery source of truth; Dropbox explains the
  // in-flight stage (raw shot / final awaiting upload) when Aryeo is short.
  const aryeoSatisfies =
    expected.size > 0 &&
    [...expected].every((c) => {
      if (c === "PHOTOS") return (aryeo?.photos ?? 0) > 0;
      if (c === "VIDEO") return (aryeo?.videos ?? 0) > 0;
      if (c === "FLOORPLAN") return (aryeo?.floorPlans ?? 0) > 0;
      return (aryeo?.interactive ?? 0) > 0;
    });

  let dropbox: DropboxSignal | null = null;
  if (useDropbox && !aryeoSatisfies) {
    const f = projectFolderPaths(p);
    const [rawPhotos, rawVideo, finalPhotos, finalVideo] = await Promise.all([
      folderCount(f.rawPhotos),
      folderCount(f.rawVideo),
      folderCount(f.finalPhotos),
      folderCount(f.finalVideo),
    ]);
    dropbox = { rawPhotos, rawVideo, finalPhotos, finalVideo };
  }

  return {
    expected,
    aryeo,
    dropbox,
    fulfilled: !!p.deliveredAt,
    scheduled: p.appointments.some((a) => (a.status || "").toUpperCase() === "SCHEDULED"),
    anyAppt: p.appointments.length > 0,
    shootDate: p.shootDate,
    revisionOpen: !!p.revisionRequestedAt,
    revisionNote: p.revisionNote,
    videoTier: videoTier(p.deliverables),
    videoType: p.deliverables.find((d) => expectedCategories([d]).has("VIDEO"))?.type ?? null,
    monthlyContent: p.client?.socialClient ?? false,
  };
}

// Simple bounded-concurrency map so a full backfill doesn't hammer the APIs.
async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Recompute status for projects by cross-checking Aryeo media + Dropbox.
//   opts.full   → every Aryeo project (one-time backfill; run locally)
//   default     → active + recently-changed only (serverless-safe, capped)
// Never touches ON_HOLD (manual) or CANCELLED projects, and won't demote an
// EDITING project back to SHOT (EDITING is a manual "editor working" superset).
// ---------------------------------------------------------------------------
export async function syncProjectStatuses(
  opts: { full?: boolean; limit?: number; projectId?: string } = {},
): Promise<{
  checked: number;
  changed: number;
  partials: number;
  byStatus: Record<string, number>;
}> {
  const useDropbox = dropboxConfigured() && !!(await getSecret("dropbox"));

  // On a full backfill, first sweep delivered jobs' comms for any revision
  // request we may have missed, so they reopen to REVISION before we compute.
  if (opts.full) {
    const { scanProjectCommsForRevision } = await import("@/lib/comms");
    const delivered = await prisma.project.findMany({
      where: { source: "ARYEO", status: "DELIVERED", revisionRequestedAt: null },
      select: { id: true },
    });
    for (const p of delivered) await scanProjectCommsForRevision(p.id);
  }

  const where = opts.projectId
    ? { id: opts.projectId } // single project (e.g. an Aryeo media-delivered webhook)
    : opts.full
    ? { source: "ARYEO" as const, status: { notIn: ["ON_HOLD", "CANCELLED"] as ProjectStatus[] } }
    : {
        source: "ARYEO" as const,
        status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] as ProjectStatus[] },
      };

  const projects = (await prisma.project.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    ...(opts.full || opts.projectId ? {} : { take: opts.limit ?? 80 }),
    select: {
      id: true,
      title: true,
      status: true,
      aryeoListingId: true,
      deliveredAt: true,
      shootDate: true,
      addressLine: true,
      createdAt: true,
      revisionRequestedAt: true,
      revisionNote: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { id: true, type: true, label: true } },
      appointments: { select: { status: true } },
    },
  })) as StatusProject[];

  let changed = 0;
  let partials = 0;
  const byStatus: Record<string, number> = {};

  const results = await pMap(projects, 5, async (p) => {
    const sig = await gatherSignals(p, useDropbox);
    return { p, ...computeStatus(sig) };
  });

  for (const { p, status, evidence } of results) {
    // Don't demote a manually-advanced EDITING project back to SHOT.
    let final = status;
    if (p.status === "EDITING" && status === "SHOT") final = "EDITING";
    // A job whose shoot already happened can NEVER go back to Scheduled/Booked.
    // Zero detected media there means either a transient Aryeo/Dropbox failure or
    // raws not uploaded yet — un-shooting the job is always wrong, and the demotion
    // cascades: the task reconciler auto-completes its QC/delivery tasks and never
    // re-mints them (audit crack #2 — live jobs went invisible after API blips).
    if (
      ["SHOT", "EDITING", "REVIEW", "REVISION"].includes(p.status) &&
      (final === "SCHEDULED" || final === "BOOKED") &&
      p.shootDate && p.shootDate.getTime() < Date.now()
    ) {
      final = p.status;
    }

    if (evidence.partial) partials++;
    byStatus[final] = (byStatus[final] ?? 0) + 1;

    const statusChanged = final !== p.status;
    // Standard delivery due = shoot date + longest turnaround of what was ordered.
    const deliveryDue = p.shootDate
      ? standardDeliveryDue(p.shootDate, p.deliverables, p.client?.socialClient ?? false)
      : null;
    await prisma.project.update({
      where: { id: p.id },
      data: {
        status: final,
        statusEvidence: JSON.stringify(evidence),
        statusCheckedAt: new Date(),
        ...(deliveryDue ? { deliveryDue } : {}),
        ...(final === "DELIVERED" && !p.deliveredAt ? { deliveredAt: new Date() } : {}),
      },
    });

    // Reflect category presence onto the deliverable rows for the portal/detail.
    await syncDeliverableStatuses(p, evidence);

    if (statusChanged) {
      changed++;
      // Delivered/cancelled jobs shouldn't keep open production tasks.
      if (final === "DELIVERED" || final === "CANCELLED") {
        const { closeObsoleteTasks } = await import("@/lib/tasks");
        await closeObsoleteTasks(p.id, final);
      }
      await prisma.activity.create({
        data: {
          projectId: p.id,
          type: "SYSTEM",
          body: `Status re-evaluated: ${p.status} → ${final}. ${evidence.reason}`,
        },
      });
    }
  }

  return { checked: projects.length, changed, partials, byStatus };
}

// Mark each deliverable DONE/PENDING based on whether its category is present.
async function syncDeliverableStatuses(p: StatusProject, evidence: StatusEvidence) {
  const presentSet = new Set(evidence.present);
  for (const d of p.deliverables) {
    const cats = expectedCategories([d]);
    if (cats.size === 0) continue;
    const done = [...cats].every((c) => presentSet.has(CATEGORY_LABEL[c]));
    await prisma.deliverable.update({
      where: { id: d.id },
      data: { status: done ? "DONE" : "PENDING" },
    });
  }
}

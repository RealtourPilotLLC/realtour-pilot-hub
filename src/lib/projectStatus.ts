import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@prisma/client";
import { Aryeo } from "@/lib/integrations/aryeo";
import { dropboxConfigured, dropboxListFolder, DropboxError } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { projectFolderPaths } from "@/lib/dropboxFolders";
import { standardDeliveryDue, deliveryDueFrom } from "@/lib/tasks";
import type { NotifyTarget } from "@/lib/notify";
import { photoTargetFor, RAW_OVERAGE_FACTOR, BRACKET_RATIO } from "@/lib/culling";

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

// One place to ask "is this video job's SLA blown, and by how much?" — the
// /editing countdown, the /edit header line, and any later dashboard read all
// agree by calling this instead of recomputing the window. Returns null when
// there's no video ordered or no shoot date to anchor the SLA. `due` is the
// VIDEO delivery-due (shootDate + standard/premium/monthly window); `overdue`
// is past-due with the cut not yet delivered; `msRemaining` is negative when
// overdue (drives the red "OVERDUE 2d" chip). Pure — safe on client via a prop.
export function getVideoSlaStatus(p: {
  shootDate: Date | null;
  status?: string | null;
  deliverables: { type: string; label: string | null }[];
  client?: { socialClient?: boolean | null } | null;
}): { tier: VideoTier; due: Date; overdue: boolean; msRemaining: number } | null {
  const tier = videoTier(p.deliverables);
  if (!tier || !p.shootDate) return null;
  const v = p.deliverables.find((d) => expectedCategories([d]).has("VIDEO"));
  const monthly = !!p.client?.socialClient;
  const due = deliveryDueFrom(p.shootDate, v?.type ?? "SOCIAL_REEL", {
    premium: tier === "premium",
    monthlyContent: monthly,
  });
  const msRemaining = due.getTime() - Date.now();
  // A video already delivered isn't "overdue" even past its window.
  const delivered = (p.status ?? "").toUpperCase() === "DELIVERED";
  return { tier, due, overdue: !delivered && msRemaining < 0, msRemaining };
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
  // Dropbox was needed but couldn't be read (not connected, or a listing call
  // FAILED — distinct from "no folders", which is a real zero). Signals here are
  // absent, not empty; don't conclude "no media" from them.
  dropboxUnavailable: boolean;
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
  // Cull-at-source (Jul 2026): stamped when the raw pile blew past the photo
  // budget × the overage factor, so the project page / Kyle can see WHY the
  // cull task fired. Absent when raws are within budget or unknown.
  cull?: { rawPhotos: number; photoTarget: number; overBy: number };
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

// A missing folder is a trustworthy ZERO (nothing was uploaded there). Any OTHER
// failure — auth, rate limit, network, a 5xx — is UNKNOWN, not zero: treating it
// as zero made a one-second Dropbox blip read as "no media", which demoted shot
// jobs and destroyed their QC/delivery tasks (audit crack #2). null = "couldn't look".
async function folderCount(path: string): Promise<number | null> {
  try {
    return (await dropboxListFolder(path)).filter((e) => e.tag === "file").length;
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return 0;
    return null;
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
  photographerId: string | null;
  // Culling budget inputs: squareFeet sizes the 50-vs-80 default, photoTarget is
  // the owner override. The photographer name keys the cull task's assignedKey.
  squareFeet: number | null;
  photoTarget: number | null;
  photographer: { name: string } | null;
  client: { name: string; socialClient: boolean };
  deliverables: { id: string; type: string; label: string | null }[];
  appointments: { status: string | null; startAt: Date | null }[];
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
  let dropboxUnavailable = !useDropbox;
  if (useDropbox && !aryeoSatisfies) {
    const f = projectFolderPaths(p);
    const [rawPhotos, rawVideo, finalPhotos, finalVideo] = await Promise.all([
      folderCount(f.rawPhotos),
      folderCount(f.rawVideo),
      folderCount(f.finalPhotos),
      folderCount(f.finalVideo),
    ]);
    // Any FAILED folder read (null ≠ a real "not found" zero) poisons the whole
    // signal — partial counts would read as "media vanished". Unknown beats wrong.
    if ([rawPhotos, rawVideo, finalPhotos, finalVideo].some((c) => c === null)) {
      dropboxUnavailable = true;
    } else {
      dropbox = {
        rawPhotos: rawPhotos as number,
        rawVideo: rawVideo as number,
        finalPhotos: finalPhotos as number,
        finalVideo: finalVideo as number,
      };
    }
  }

  return {
    expected,
    aryeo,
    dropbox,
    dropboxUnavailable,
    fulfilled: !!p.deliveredAt,
    scheduled: p.appointments.some((a) => (a.status || "").toUpperCase() === "SCHEDULED"),
    // Canceled appointments are not "an appointment on file" — a job whose only
    // appointments were canceled must not read as scheduled (audit crack #14).
    anyAppt: p.appointments.some((a) => (a.status || "").toUpperCase() !== "CANCELED"),
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
      photographerId: true,
      squareFeet: true,
      photoTarget: true,
      photographer: { select: { name: true } },
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { id: true, type: true, label: true } },
      appointments: { select: { status: true, startAt: true } },
    },
  })) as StatusProject[];

  let changed = 0;
  let partials = 0;
  const byStatus: Record<string, number> = {};

  const results = await pMap(projects, 5, async (p) => {
    const sig = await gatherSignals(p, useDropbox);
    return { p, sig, ...computeStatus(sig) };
  });

  for (const { p, sig, status, evidence } of results) {
    // "The shoot already happened" — the arming condition for both anti-demotion
    // guards below. shootDate alone is NOT enough: it's movable. When an
    // already-shot job gets a return visit or a forward reschedule, the
    // appointment sync points shootDate at the FUTURE leg, and a guard keyed
    // only on `shootDate < now` silently disarms — re-opening the exact
    // demotion cascade it was built to stop (audit crack #2 / 2075 Flint Hill).
    // So we also accept any non-canceled appointment leg that started in the
    // past as proof a shoot happened. The shootDate test still matters on its
    // own: manual/unsynced projects have no appointment rows at all.
    const now = Date.now();
    const shootHappened =
      (p.shootDate !== null && p.shootDate.getTime() < now) ||
      p.appointments.some(
        (a) =>
          (a.status || "").toUpperCase() !== "CANCELED" &&
          a.startAt !== null &&
          a.startAt.getTime() < now,
      );
    // Signal-fetch FAILURE is unknown, not zero. When Aryeo couldn't be read AND
    // Dropbox is unavailable for a past-shoot production job, we have no evidence
    // at all — keep the prior status/evidence untouched instead of recomputing
    // from nothing (which erased "present" evidence, flipped deliverables back to
    // PENDING, and cascaded into destroyed QC tasks — audit crack #2).
    if (
      !sig.aryeo &&
      !sig.dropbox &&
      sig.dropboxUnavailable &&
      ["SHOT", "EDITING", "REVIEW", "REVISION"].includes(p.status) &&
      shootHappened
    ) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      await prisma.project.update({ where: { id: p.id }, data: { statusCheckedAt: new Date() } });
      continue;
    }
    // Don't demote a manually-advanced EDITING project back to SHOT.
    let final = status;
    if (p.status === "EDITING" && status === "SHOT") final = "EDITING";
    // A job whose shoot already happened can NEVER go back to Scheduled/Booked.
    // Zero detected media there means either a transient Aryeo/Dropbox failure or
    // raws not uploaded yet — un-shooting the job is always wrong, and the demotion
    // cascades: the task reconciler auto-completes its QC/delivery tasks and never
    // re-mints them (audit crack #2 — live jobs went invisible after API blips).
    // `shootHappened` (not `shootDate < now`) because a rescheduled/return-visit
    // job carries a FUTURE shootDate while its original leg is already in the can.
    if (
      ["SHOT", "EDITING", "REVIEW", "REVISION"].includes(p.status) &&
      (final === "SCHEDULED" || final === "BOOKED") &&
      shootHappened
    ) {
      final = p.status;
    }

    if (evidence.partial) partials++;
    byStatus[final] = (byStatus[final] ?? 0) + 1;

    const statusChanged = final !== p.status;

    // Cull-at-the-source (Jul 2026 audit). Raws in but not yet delivered is the
    // only window where over-shooting can still be fixed cheaply. When the live
    // raw count blows past the home's photo budget × the overage factor, stamp
    // the evidence (so the project page shows WHY) and mint ONE cull task + text
    // the photographer below. SHOT/EDITING only — never nag a delivered job.
    let cullOver = false;
    if (["SHOT", "EDITING"].includes(final) && sig.dropbox && sig.dropbox.rawPhotos > 0) {
      const photoTarget = photoTargetFor(p);
      const rawPhotos = sig.dropbox.rawPhotos;
      if (rawPhotos > photoTarget * RAW_OVERAGE_FACTOR) {
        cullOver = true;
        evidence.cull = { rawPhotos, photoTarget, overBy: rawPhotos - photoTarget * BRACKET_RATIO };
      }
    }

    // First arrival at DELIVERED — the same condition that stamps deliveredAt
    // below; drives the one-time "Delivered" bell inside the statusChanged block.
    const justDelivered = final === "DELIVERED" && !p.deliveredAt;
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

    // Over-shot the budget → mint ONE cull task + text the photographer, so the
    // pile gets thinned BEFORE it costs editing money. Deduped per project inside
    // mintCullTask. Best-effort; never breaks the sweep.
    if (cullOver && evidence.cull) {
      try {
        const { mintCullTask } = await import("@/lib/tasks");
        await mintCullTask({
          projectId: p.id,
          title: p.title,
          rawPhotos: evidence.cull.rawPhotos,
          target: evidence.cull.photoTarget,
          photographerId: p.photographerId,
          photographerName: p.photographer?.name ?? null,
        });
      } catch { /* cull nudge is best-effort */ }
    }

    // Vendor round-trip chase (audit crack #16): a floor plan (CubiCasa) or the
    // photo edits (AutoHDR) still missing days after the shoot means the vendor
    // handoff dropped — mint ONE deduped chase task per project+category.
    // Non-delivered production stages only; best-effort, never breaks the sync.
    if (["SHOT", "EDITING", "REVIEW"].includes(final) && evidence.missing.length > 0) {
      try {
        const { chaseVendorsForMissing } = await import("@/lib/tasks");
        await chaseVendorsForMissing(p.id, {
          title: p.title,
          shootDate: p.shootDate,
          missing: evidence.missing,
        });
      } catch { /* chase is best-effort */ }
    }

    if (statusChanged) {
      changed++;
      // Delivered/cancelled jobs shouldn't keep open production tasks.
      if (final === "DELIVERED" || final === "CANCELLED") {
        const { closeObsoleteTasks } = await import("@/lib/tasks");
        await closeObsoleteTasks(p.id, final);
      }
      // RAWS LANDED — the real handoff. This IS the status path (the only place
      // that TruthfulLY detects a job entering SHOT); notifyRawsLanded had never
      // fired in prod because it was only wired to the unused upload-portal +
      // legacy Dropbox sweep. On (anything)→SHOT: ping the editor bench, mint the
      // routed editor's edit_video work item, and persist Project.editorId when
      // the route maps to an in-house TeamMember (Kim/Remar) so /editing shows a
      // name and one-click reassign has something to update. All best-effort and
      // idempotent (activity-marker + dedupeKeys) — a throw here must NEVER break
      // the sweep, and re-entering SHOT must not re-announce.
      if (final === "SHOT") {
        try {
          const { notifyRawsLanded, mintEditTask } = await import("@/lib/tasks");
          await notifyRawsLanded(p.id);
          await mintEditTask(p.id);
          // Persist the editor for the tracker + reassign, only for a video job
          // whose route maps to a linkable person (externals/vendors stay null).
          const hasVideo = p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
          if (hasVideo) {
            const { editorForDeliverable, editorTeamMemberId } = await import("@/lib/editors");
            const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
            const key = editorForDeliverable(v?.type, v?.label, p.client?.socialClient ?? false);
            const tmId = await editorTeamMemberId(key);
            if (tmId) {
              await prisma.project.update({ where: { id: p.id }, data: { editorId: tmId } });
            }
          }
        } catch { /* raws-landed handoff is best-effort */ }
      }
      await prisma.activity.create({
        data: {
          projectId: p.id,
          type: "SYSTEM",
          body: `Status re-evaluated: ${p.status} → ${final}. ${evidence.reason}`,
        },
      });
      // Bell: the job just shipped — ops broadcast + the photographer who shot
      // it (per-editor rows are skipped in v1; they see /editing clear). The
      // delivery_text task above is untouched — this is the announcement, not
      // the work item. Best-effort.
      if (justDelivered) {
        try {
          const { notifyInApp } = await import("@/lib/notify");
          const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
          if (p.photographerId) targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${p.photographerId}` });
          await notifyInApp({
            kind: "delivery_out",
            title: `Delivered — ${(p.title || "this job").split(",")[0].trim()}`,
            href: `/projects/${p.id}`,
            targets,
            dedupeKey: `delivered-${p.id}`,
          });
        } catch { /* bell is best-effort */ }
      }
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

import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@prisma/client";
import { Aryeo } from "@/lib/integrations/aryeo";
import { dropboxConfigured, dropboxListFolder } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { projectFolderPaths } from "@/lib/dropboxFolders";

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
    reason = `Partial delivery — still missing ${missing.map((m) => CATEGORY_LABEL[m as MediaCategory]).join(", ")}.`;
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
  client: { name: string };
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
  opts: { full?: boolean; limit?: number } = {},
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

  const where = opts.full
    ? { source: "ARYEO" as const, status: { notIn: ["ON_HOLD", "CANCELLED"] as ProjectStatus[] } }
    : {
        source: "ARYEO" as const,
        status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] as ProjectStatus[] },
      };

  const projects = (await prisma.project.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    ...(opts.full ? {} : { take: opts.limit ?? 80 }),
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
      client: { select: { name: true } },
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

    if (evidence.partial) partials++;
    byStatus[final] = (byStatus[final] ?? 0) + 1;

    const statusChanged = final !== p.status;
    await prisma.project.update({
      where: { id: p.id },
      data: {
        status: final,
        statusEvidence: JSON.stringify(evidence),
        statusCheckedAt: new Date(),
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

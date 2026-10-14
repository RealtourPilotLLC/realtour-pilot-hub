import "server-only";

import { prisma } from "@/lib/prisma";
import { aryeoRequest } from "@/lib/integrations/aryeo";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";
import { appBase } from "@/lib/appUrl";

// ---------------------------------------------------------------------------
// THE DELIVER PANEL (docs/photo-delivery/01 §9.6), Aryeo-assisted.
//
// Aryeo's public API cannot upload listing images or press Deliver, so the
// last mile stays two clicks for Kyle in Aryeo. The hub's job is everything
// around those clicks:
//   · the GATE: a live checklist that says whether this gallery may go out;
//   · the STEPS: open the listing, upload from Dropbox (the folder, in the
//     right order), check the order against the thumbnails, deliver with the
//     pre-written message;
//   · VERIFICATION: when Aryeo says the listing was delivered, compare the
//     listing's images with what QC approved, and raise DELIVERY_MISMATCH if
//     a photo is missing or extra.
//
// Shadow mode (the first two weeks): the gate is ADVISORY. It is computed and
// shown, but a failed check never stops Kyle, because QC is still being
// calibrated against his manual review.
//
// Staging sequenced copies (01-Front-Exterior.jpg …) is OFF until a staging
// folder is set in settings: the job folders live under /AutoHDR, which
// AutoHDR's watcher reads, and a copied image in the wrong place there could
// be edited (and charged) a second time. Until then the steps point at
// 04-Final-Photos and show the order to drag them in.
// ---------------------------------------------------------------------------

export type GateCheck = { key: string; label: string; ok: boolean; detail?: string };
export type GateResult = { checks: GateCheck[]; passed: boolean; advisory: boolean; canDeliver: boolean; overrideAllowed: boolean; blockedForOverride: string | null };

export async function deliveryGate(jobId: string): Promise<GateResult> {
  const [job, settings] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, stage: true, lastQcRunId: true, finalsCount: true, qcShadow: true } }),
    photoDeliverySettings(),
  ]);
  if (!job) throw new Error("Photo job not found.");
  const [open, photos, lastRun] = await Promise.all([
    prisma.photoQcFinding.findMany({
      where: { jobId, status: { in: ["OPEN", "APPROVED_FIX", "FIXING"] } },
      select: { id: true, severity: true, confidence: true, arbitration: true, pass: true, ruleId: true, privacySensitive: true },
    }),
    prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, select: { id: true, contentHash: true, inspectedHash: true, width: true, height: true, format: true } }),
    job.lastQcRunId ? prisma.photoQcRun.findUnique({ where: { id: job.lastQcRunId }, select: { status: true, passesJson: true } }) : Promise.resolve(null),
  ]);
  const floor = settings.displayConfidenceFloor;
  const shown = open.filter((f) => f.confidence >= floor);
  const critical = shown.filter((f) => f.severity === "CRITICAL" && f.arbitration !== "OVERTURNED");
  const major = shown.filter((f) => f.severity === "MAJOR");
  const coverage = shown.filter((f) => f.pass === "P4_ORDER" && f.severity !== "MINOR");
  const notInspected = photos.filter((p) => !p.contentHash || p.inspectedHash !== p.contentHash);
  const badFiles = photos.filter((p) => (p.width != null && p.height != null && Math.max(p.width, p.height) < settings.minLongEdgePx) || (p.format != null && !/jpe?g/i.test(p.format)));
  const passes: string[] = (() => {
    try {
      return lastRun?.passesJson ? (JSON.parse(lastRun.passesJson) as string[]) : [];
    } catch {
      return [];
    }
  })();
  const checks: GateCheck[] = [
    { key: "critical", label: "No unresolved critical issue", ok: critical.length === 0, detail: critical.length ? `${critical.length} open` : undefined },
    { key: "major", label: "Every major issue fixed, ignored with a reason, or overridden", ok: major.length === 0, detail: major.length ? `${major.length} open` : undefined },
    { key: "coverage", label: "Everything ordered is covered (or accepted with a reason)", ok: coverage.length === 0, detail: coverage.length ? `${coverage.length} open` : undefined },
    { key: "files", label: "Every photo is a full-size JPEG", ok: badFiles.length === 0 && photos.length > 0, detail: photos.length === 0 ? "no photos" : badFiles.length ? `${badFiles.length} file${badFiles.length === 1 ? "" : "s"} too small or not JPEG` : undefined },
    { key: "qc", label: "The latest QC run covers every photo's current version", ok: !!lastRun && lastRun.status !== "RUNNING" && notInspected.length === 0, detail: !lastRun ? "QC has not run" : notInspected.length ? `${notInspected.length} photo${notInspected.length === 1 ? "" : "s"} not inspected` : undefined },
    { key: "gallery", label: "Gallery and order checks completed", ok: passes.includes("P4") || passes.includes("P4_ORDER"), detail: passes.length ? undefined : "not run yet" },
  ];
  const passed = checks.every((c) => c.ok);
  const advisory = settings.qcShadow || job.qcShadow;
  const privacyOrWrong = critical.find((f) => f.privacySensitive || /FILE_NO_MIXED_PROPERTIES|FILE_PROJECT_ASSOCIATION|FILE_CORRECT_PROPERTY_UPLOAD/.test(f.ruleId));
  return {
    checks,
    passed,
    advisory,
    canDeliver: passed || advisory,
    overrideAllowed: !privacyOrWrong,
    blockedForOverride: privacyOrWrong ? "A privacy or wrong-property issue is open. That one has to be resolved, not overridden." : null,
  };
}

export type DeliverySteps = {
  /** Photos fixed through AutoHDR since they went on the listing: swap these in Aryeo. */
  replacements: { photoId: string; photoName: string; versionId: string; downloadUrl: string; label: string; at: string }[];
  listingUrl: string | null;
  orderUrl: string | null;
  folderPath: string | null;
  folderLabel: string;
  order: { photoId: string; name: string; deliveryName: string }[];
  message: string;
  revisionLink: string | null;
  /** Oct 14 2026: the finished photos, numbered, in 06-Ready-for-Aryeo (handoff.ts). */
  ready: { folderUrl: string; files: number; expected: number; ready: boolean; stagedAt: string | null; preparing?: boolean; failed?: number; note?: string | null } | null;
};

const ROOM_WORDS: Record<string, string> = {
  FRONT_EXTERIOR: "Front-Exterior", ENTRY: "Entry", MAIN_LIVING: "Living", KITCHEN: "Kitchen", PRIMARY_SUITE: "Primary-Suite", BEDROOMS: "Bedroom",
  BATHROOMS: "Bathroom", FLEX: "Bonus-Room", LOWER_LEVEL: "Lower-Level", UTILITY: "Utility", OUTDOOR_LIVING: "Outdoor", REAR_EXTERIOR: "Rear-Exterior",
  AERIAL: "Aerial", COMMUNITY: "Community", DETAIL: "Detail",
};

// Plan §7.6: hero first (twilight if any, else the best front exterior by
// hero score), then the sequence groups in this order; AutoHDR's walkthrough
// order within a group; excluded photos drop out.
const GROUP_ORDER = ["FRONT_EXTERIOR", "ENTRY", "MAIN_LIVING", "KITCHEN", "PRIMARY_SUITE", "BEDROOMS", "BATHROOMS", "FLEX", "LOWER_LEVEL", "UTILITY", "OUTDOOR_LIVING", "REAR_EXTERIOR", "AERIAL", "COMMUNITY", "DETAIL"];

type OrderablePhoto = { id: string; name: string; sequence: number; sequenceGroup: string | null; heroScore: number | null; isTwilight: boolean; roomType: string | null };

export function suggestedOrder(photos: OrderablePhoto[], heroId: string | null): OrderablePhoto[] {
  if (!photos.some((p) => p.sequenceGroup)) return [...photos].sort((a, b) => a.sequence - b.sequence); // not classified yet
  const rank = (g: string | null) => (g && GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  const sorted = [...photos].sort((a, b) => rank(a.sequenceGroup) - rank(b.sequenceGroup) || a.sequence - b.sequence);
  let hero = heroId ? sorted.find((p) => p.id === heroId) : undefined;
  if (!hero) {
    const exteriors = sorted.filter((p) => p.sequenceGroup === "FRONT_EXTERIOR" || p.roomType === "TWILIGHT_EXTERIOR" || p.roomType === "AERIAL");
    hero = exteriors.filter((p) => p.isTwilight).sort((a, b) => (b.heroScore ?? 0) - (a.heroScore ?? 0))[0] ?? exteriors.sort((a, b) => (b.heroScore ?? 0) - (a.heroScore ?? 0))[0];
  }
  return hero ? [hero, ...sorted.filter((p) => p.id !== hero!.id)] : sorted;
}

/** The delivery order: a person's saved order, else the suggested one. */
export async function deliveryOrderFor(jobId: string): Promise<{ photoId: string; name: string; deliveryName: string }[]> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { orderJson: true, heroPhotoId: true } });
  const photos = await prisma.photoAsset.findMany({
    where: { jobId, status: "ACTIVE" },
    orderBy: { sequence: "asc" },
    select: { id: true, name: true, sequence: true, sequenceGroup: true, heroScore: true, isTwilight: true, roomType: true },
  });
  let ordered: OrderablePhoto[];
  const saved = (() => {
    try {
      return job?.orderJson ? (JSON.parse(job.orderJson) as string[]) : null;
    } catch {
      return null;
    }
  })();
  if (saved?.length) {
    const rank = new Map(saved.map((id, i) => [id, i]));
    ordered = [...photos].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) || a.sequence - b.sequence);
    if (job?.heroPhotoId) {
      const i = ordered.findIndex((p) => p.id === job.heroPhotoId);
      if (i > 0) ordered = [ordered[i], ...ordered.slice(0, i), ...ordered.slice(i + 1)];
    }
  } else {
    ordered = suggestedOrder(photos, job?.heroPhotoId ?? null);
  }
  const width = Math.max(2, String(ordered.length).length);
  return ordered.map((p, i) => {
    const ext = (/\.[a-z0-9]+$/i.exec(p.name)?.[0] ?? ".jpg").toLowerCase();
    const word = (p.sequenceGroup && ROOM_WORDS[p.sequenceGroup]) || "Photo";
    // AutoHDR's QC checklist: twilight frames carry a twilight suffix and go
    // out with the main set.
    const suffix = p.isTwilight || p.roomType === "TWILIGHT_EXTERIOR" ? "-Twilight" : "";
    return { photoId: p.id, name: p.name, deliveryName: `${String(i + 1).padStart(width, "0")}-${word}${suffix}${ext}` };
  });
}

export async function deliverySteps(jobId: string): Promise<DeliverySteps> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, finalsPath: true, deliveryPath: true } });
  if (!job) throw new Error("Photo job not found.");
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true, aryeoOrderId: true, title: true, clientId: true } });
  const profile = project?.clientId ? await prisma.clientQcProfile.findUnique({ where: { clientId: project.clientId }, select: { deliveryMessage: true } }).catch(() => null) : null;
  const street = (project?.title ?? "your listing").split(",")[0];
  const message =
    profile?.deliveryMessage?.trim() ||
    `Your photos for ${street} are ready. Thank you for trusting us with this listing. If anything needs a second look, reply here and we will take care of it. Realtour Pilot Team`;
  // The newest stored fix per photo is what Kyle uploads in place of the
  // listing's copy (the hub cannot upload to Aryeo).
  // Once the listing's copy is replaced, the sync records a newer "Replaced"
  // version, and the photo drops off this list by itself.
  const versions = await prisma.photoVersion.findMany({
    where: { photo: { jobId, status: "ACTIVE" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, label: true, createdAt: true, derivJson: true, photoId: true, photo: { select: { name: true } } },
  });
  const seenPhoto = new Set<string>();
  const replacements: DeliverySteps["replacements"] = [];
  for (const f of versions) {
    if (seenPhoto.has(f.photoId)) continue;
    seenPhoto.add(f.photoId); // the newest version of each photo decides
    if (f.source !== "FIX" || !f.derivJson?.includes('"file"')) continue;
    replacements.push({ photoId: f.photoId, photoName: f.photo.name, versionId: f.id, downloadUrl: `/api/photo-fixes/${f.id}`, label: f.label, at: f.createdAt.toISOString() });
  }
  const order = await deliveryOrderFor(jobId);
  const { readyFolderState } = await import("./handoff");
  const { dropboxWebUrl } = await import("@/lib/dropboxFolders");
  const rs = await readyFolderState(jobId, order.length).catch(() => null);
  return {
    replacements,
    ready: rs ? { folderUrl: dropboxWebUrl(rs.folder), files: rs.files, expected: rs.preparing ? rs.total : order.length, ready: rs.ready, stagedAt: rs.stagedAt, preparing: rs.preparing, failed: rs.failed, note: rs.note } : null,
    listingUrl: project?.aryeoListingId ? aryeoListingUrl(project.aryeoListingId) : null,
    orderUrl: project?.aryeoOrderId ? aryeoOrderUrl(project.aryeoOrderId) : null,
    folderPath: job.deliveryPath ?? job.finalsPath,
    folderLabel: job.deliveryPath ? "Delivery folder (files already numbered in order)" : "04-Final-Photos (drag them in the order below)",
    order,
    message: message.replace(/\s*[–—]\s*/g, ", "),
    revisionLink: null,
  };
}

/** Kyle pressed Deliver in the hub: the gate is re-checked and the job waits for Aryeo. */
export async function startDelivery(jobId: string, by: string, opts: { override?: { reason: string; role: string } } = {}): Promise<{ ok: boolean; message: string }> {
  const gate = await deliveryGate(jobId);
  if (!gate.canDeliver) {
    if (!opts.override) return { ok: false, message: "The delivery checklist has open items. Resolve them, or (owner) override with a reason." };
    if (opts.override.role !== "OWNER") return { ok: false, message: "Only Jordan can override the delivery checklist." };
    if (!gate.overrideAllowed) return { ok: false, message: gate.blockedForOverride ?? "This gallery cannot be overridden." };
    if ((opts.override.reason ?? "").trim().length < 5) return { ok: false, message: "Write the reason for the override." };
  }
  const moved = await setStage(jobId, ["READY", "QC_REVIEW", "EDITED", "DELIVERY_MISMATCH", "REVISION_REQUESTED"], "DELIVERING", by, {
    why: opts.override ? `owner override: ${opts.override.reason.trim()}` : gate.passed ? "checklist passed" : "advisory checklist (shadow mode)",
    extra: { deliveryStartedAt: new Date() },
  });
  if (!moved) return { ok: false, message: "This job moved on in the meantime. Reload the page." };
  if (opts.override) {
    await alertOwnerAndKyle({
      kind: "photo_delivery_override",
      title: "Delivery checklist overridden",
      body: opts.override.reason.trim().slice(0, 140),
      href: `/ops/photo-delivery/${jobId}`,
      dedupeKey: `pd-override-${jobId}-${Date.now()}`,
      text: `Delivery checklist overridden by ${by}: ${opts.override.reason.trim()}. ${appBase()}/ops/photo-delivery/${jobId}`,
      to: "kyle",
    });
  }
  return { ok: true, message: "Marked as delivering. Finish the steps in Aryeo; the hub confirms when Aryeo says it was delivered." };
}

type ListingRead = { data?: { images?: { id?: string; original_url?: string; caption?: string | null; display_in_gallery?: boolean }[]; floor_plans?: unknown[]; delivery_status?: string } };

export type VerifyResult = { ok: boolean; waiting?: boolean; message: string; aryeoCount: number | null; approved: number };

/**
 * Compare the delivered Aryeo listing with the approved set. Called by the
 * sync when the hub learns the listing was delivered, by the 5-minute sweep
 * for jobs marked DELIVERING, and on demand. Read-only toward Aryeo.
 *   · every ACTIVE photo must be on the listing (matched by Aryeo image id
 *     when the photo came from the listing, else by count);
 *   · no EXCLUDED photo may still be shown;
 *   · a floor plan must be there when one was ordered.
 * Extra media on the listing (an agent's own upload) is reported, never a
 * mismatch.
 */
export async function verifyDelivery(jobId: string, by = "verify"): Promise<VerifyResult> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, stage: true } });
  if (!job) return { ok: false, message: "Photo job not found.", aryeoCount: null, approved: 0 };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true, title: true, deliveredAt: true, deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: "FLOORPLAN" }, select: { id: true } } } });
  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", "EXCLUDED"] } }, select: { id: true, name: true, status: true, sourceKind: true, sourceRef: true } });
  const active = photos.filter((p) => p.status === "ACTIVE");
  const approved = active.length;
  if (!project?.aryeoListingId) return { ok: false, message: "This job has no Aryeo listing linked yet.", aryeoCount: null, approved };
  let listing: ListingRead;
  try {
    listing = await aryeoRequest<ListingRead>(`/listings/${project.aryeoListingId}`, { query: { include: "images,floor_plans" } });
  } catch (e) {
    return { ok: false, message: `Couldn't read the Aryeo listing (${(e as Error).message}).`, aryeoCount: null, approved };
  }
  const delivered = listing.data?.delivery_status === "DELIVERED" || !!project.deliveredAt;
  if (!delivered) return { ok: false, waiting: true, message: "Aryeo has not marked the listing delivered yet.", aryeoCount: null, approved };
  const shown = (listing.data?.images ?? []).filter((i) => i.display_in_gallery !== false);
  const shownIds = new Set(shown.map((i) => i.id).filter(Boolean) as string[]);
  const aryeoCount = shown.length;
  const fromListing = active.filter((p) => p.sourceKind === "ARYEO" && p.sourceRef);
  const missing = fromListing.filter((p) => !shownIds.has(p.sourceRef!)).map((p) => p.name);
  const excludedShown = photos.filter((p) => p.status === "EXCLUDED" && p.sourceKind === "ARYEO" && p.sourceRef && shownIds.has(p.sourceRef)).map((p) => p.name);
  const short = fromListing.length === 0 && aryeoCount < approved; // Dropbox-sourced galleries: count only
  const floorMissing = (project.deliverables?.length ?? 0) > 0 && (listing.data?.floor_plans?.length ?? 0) === 0;
  const extra = Math.max(0, aryeoCount - approved);
  const diff = { approved, aryeoCount, missing, excludedShown, floorPlanMissing: floorMissing, extra, checkedAt: new Date().toISOString() };
  const problems: string[] = [];
  if (missing.length) problems.push(`${missing.length} approved photo${missing.length === 1 ? " is" : "s are"} not on the listing`);
  if (short) problems.push(`Aryeo shows ${aryeoCount} photos but ${approved} were approved`);
  if (excludedShown.length) problems.push(`${excludedShown.length} excluded photo${excludedShown.length === 1 ? " is" : "s are"} still shown`);
  if (floorMissing) problems.push("a floor plan was ordered but is not on the listing");
  if (problems.length) {
    const line = problems.join("; ");
    await setStage(jobId, ["DELIVERING", "DELIVERED", "READY", "QC_REVIEW", "EDITED"], "DELIVERY_MISMATCH", by, { why: line, extra: { deliveryDiffJson: JSON.stringify(diff) } });
    const street = (project.title ?? "").split(",")[0];
    // Shadow mode (the first two weeks): the mismatch is recorded on the job
    // page, nobody is pinged, while the checks are calibrated.
    const { qcShadow } = await photoDeliverySettings();
    if (!qcShadow) await alertOwnerAndKyle({
      kind: "photo_delivery_mismatch",
      title: `Delivery check: ${street}`.slice(0, 90),
      body: line.slice(0, 140),
      href: `/ops/photo-delivery/${jobId}`,
      dedupeKey: `pd-mismatch-${jobId}-${missing.length}-${excludedShown.length}-${aryeoCount}-${approved}-${floorMissing ? 1 : 0}`,
      text: `${street}: ${line}. Check: ${appBase()}/ops/photo-delivery/${jobId}`,
      to: "kyle",
    });
    return { ok: false, message: `${line[0].toUpperCase()}${line.slice(1)}.`, aryeoCount, approved };
  }
  await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryDiffJson: JSON.stringify(diff) } });
  if (job.stage !== "DELIVERED") {
    await setStage(jobId, "any", "DELIVERED", by, { why: `verified: ${aryeoCount} photos on the listing`, extra: { deliveredAt: project.deliveredAt ?? new Date(), deliveredBy: by } });
  }
  await logJobEvent(jobId, by, `delivery verified: ${aryeoCount} on the listing, ${approved} approved${extra ? `, ${extra} extra` : ""}`);
  return { ok: true, message: `Verified: ${aryeoCount} photos on the Aryeo listing (${approved} approved${extra ? `, ${extra} extra` : ""}).`, aryeoCount, approved };
}

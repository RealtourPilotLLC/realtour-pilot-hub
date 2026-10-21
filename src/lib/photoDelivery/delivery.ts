import "server-only";

import { prisma } from "@/lib/prisma";
import { aryeoRequest } from "@/lib/integrations/aryeo";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";
import { appBase } from "@/lib/appUrl";

// ---------------------------------------------------------------------------
// THE DELIVER PANEL (docs/photo-delivery/01 §9.6).
//
// The hub uploads the finished photos to the Aryeo listing and presses
// Deliver itself (aryeoPush.ts, through Aryeo's own web app: the public API
// cannot). This file is everything around that:
//   · the GATE: a live checklist that says whether this gallery may go out
//     (the hub delivers by itself only when it really passes);
//   · the STEPS: the numbered photos in 06-Ready-for-Aryeo (handoff.ts), the
//     delivery order, the listing and the pre-written message, for when a
//     person does it by hand;
//   · VERIFICATION: when Aryeo says the listing was delivered, compare the
//     listing's images with what QC approved, and raise DELIVERY_MISMATCH if
//     a photo is missing or extra.
//
// Shadow mode (the first two weeks): the gate is ADVISORY for a person. It is
// computed and shown, but a failed check never stops Kyle, because QC is
// still being calibrated against his manual review.
// ---------------------------------------------------------------------------

/** `advisory`: shown on the checklist, never counted in `passed` and never
 *  holding a person's delivery (open photo flags, Oct 21 2026). `href`: where
 *  the line's own work is. */
export type GateCheck = { key: string; label: string; ok: boolean; detail?: string; advisory?: boolean; href?: string };
export type GateResult = { checks: GateCheck[]; passed: boolean; advisory: boolean; canDeliver: boolean; overrideAllowed: boolean; blockedForOverride: string | null };

export async function deliveryGate(jobId: string): Promise<GateResult> {
  const [job, settings] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, stage: true, lastQcRunId: true, finalsCount: true, coverageJson: true } }),
    photoDeliverySettings(),
  ]);
  if (!job) throw new Error("Photo job not found.");
  const [open, photos, lastRun] = await Promise.all([
    prisma.photoQcFinding.findMany({
      where: { jobId, status: { in: ["OPEN", "APPROVED_FIX", "FIXING"] } },
      select: { id: true, severity: true, confidence: true, arbitration: true, pass: true, ruleId: true, privacySensitive: true },
    }),
    prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, select: { id: true, contentHash: true, inspectedHash: true, width: true, height: true, format: true } }),
    job.lastQcRunId ? prisma.photoQcRun.findUnique({ where: { id: job.lastQcRunId }, select: { status: true, passesJson: true, trigger: true, checksJson: true } }) : Promise.resolve(null),
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
    { key: "major", label: "Every major issue fixed or marked not worth fixing", ok: major.length === 0, detail: major.length ? `${major.length} open` : undefined },
    { key: "coverage", label: "Everything ordered is covered (or accepted with a reason)", ok: coverage.length === 0, detail: coverage.length ? `${coverage.length} open` : undefined },
    { key: "files", label: "Every photo is a full-size JPEG", ok: badFiles.length === 0 && photos.length > 0, detail: photos.length === 0 ? "no photos" : badFiles.length ? `${badFiles.length} file${badFiles.length === 1 ? "" : "s"} too small or not JPEG` : undefined },
    { key: "qc", label: "The latest QC run covers every photo's current version", ok: !!lastRun && lastRun.status !== "RUNNING" && notInspected.length === 0, detail: !lastRun ? "QC has not run" : notInspected.length ? `${notInspected.length} photo${notInspected.length === 1 ? "" : "s"} not inspected` : undefined },
    // The free check looks at each photo, not the gallery as a whole: after
    // it, this paid-QC-only line is left out (backend audit #11).
    ...(lastRun?.trigger === "AUTOHDR_CHECK" ? [] : [{ key: "gallery", label: "Gallery and order checks completed", ok: passes.includes("P4") || passes.includes("P4_ORDER"), detail: passes.length ? undefined : "not run yet" }]),
    // Oct 15 2026: after a v3 free check, the free room coverage check must
    // have looked at THIS set of photos (coverage.ts), so the same-day
    // automatic delivery never goes out before it.
    ...(await roomsCheck(settings.freeCoverage && settings.freeCheck, lastRun, job.coverageJson, photos.map((p) => p.id))),
    // Oct 19 2026 (lib/uploadGaps): the shoot's upload is missing part of the
    // order, e.g. only drone photos came in. Delivering the edits of half a
    // shoot is the one thing this gate must not wave through.
    ...(await uploadCheck(job.projectId)),
    // Oct 21 2026 (Jordan; audit C10): open photo flags, as a line Kyle sees.
    // They already hold the hub's own same-day delivery (aryeoPush
    // openPhotoFlags); here they are information only, never a hold on his
    // Approve and deliver.
    ...(await flagsCheck(job.projectId)),
  ];
  const passed = checks.every((c) => c.ok || c.advisory);
  // The house setting decides (audit, Oct 15): a job's own qcShadow only records
  // how its last check ran, and kept a job advisory after shadow mode was off.
  const advisory = settings.qcShadow;
  const privacyOrWrong = critical.find((f) => f.privacySensitive || /FILE_NO_MIXED_PROPERTIES|FILE_PROJECT_ASSOCIATION|FILE_CORRECT_PROPERTY_UPLOAD/.test(f.ruleId));
  return {
    checks,
    passed,
    advisory,
    // Oct 20 2026 (audit C7): shadow mode makes the checklist advisory for a
    // person, never for a privacy or wrong-property critical. Those are the
    // ones Jordan's override refuses, so the routine path refuses them too.
    canDeliver: (passed || advisory) && !privacyOrWrong,
    overrideAllowed: !privacyOrWrong,
    blockedForOverride: privacyOrWrong ? "A privacy or wrong-property issue is open. That one has to be resolved, not overridden." : null,
  };
}

async function uploadCheck(projectId: string | null): Promise<GateCheck[]> {
  if (!projectId) return [];
  const { openPhotoGaps } = await import("@/lib/uploadGaps");
  // Oct 20 2026 (audit C1): a read that fails is an open line, not a pass,
  // so the same-day automatic delivery never goes out on a check it couldn't make.
  let gaps: Awaited<ReturnType<typeof openPhotoGaps>>;
  try {
    gaps = await openPhotoGaps(projectId);
  } catch {
    return [{ key: "upload", label: "Everything ordered was uploaded", ok: false, detail: "the upload check could not be read, it runs again on the next pass" }];
  }
  return gaps ? [{ key: "upload", label: "Everything ordered was uploaded", ok: false, detail: gaps.words }] : [];
}

async function flagsCheck(projectId: string | null): Promise<GateCheck[]> {
  if (!projectId) return [];
  const href = `/projects/${projectId}#flags`;
  const n = await prisma.imageFlag.count({ where: { projectId, status: "OPEN" } }).catch(() => null);
  if (n === null) return [{ key: "flags", label: "Photo flags", ok: false, advisory: true, href, detail: "the photo flags could not be read just now" }];
  return n ? [{ key: "flags", label: "Photo flags", ok: false, advisory: true, href, detail: `${n} photo flag${n === 1 ? "" : "s"} still open` }] : [];
}

async function roomsCheck(on: boolean, run: { trigger: string; checksJson: string | null } | null, coverageJson: string | null, activeIds: string[]): Promise<GateCheck[]> {
  if (!on || run?.trigger !== "AUTOHDR_CHECK" || !/"v":\s*[3-9]/.test(run.checksJson ?? "")) return [];
  const { parseCoverage, photoSetKey } = await import("./coverage");
  const c = parseCoverage(coverageJson);
  const ok = !!c?.done && c.photoSet === photoSetKey(activeIds);
  return [{ key: "rooms", label: "Rooms checked against the listing", ok, detail: ok ? undefined : c ? "the photos changed since the last room check" : "not checked yet" }];
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
  const [job, photos] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { orderJson: true, heroPhotoId: true } }),
    prisma.photoAsset.findMany({
      where: { jobId, status: "ACTIVE" },
      orderBy: { sequence: "asc" },
      select: { id: true, name: true, sequence: true, sequenceGroup: true, heroScore: true, isTwilight: true, roomType: true },
    }),
  ]);
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
  // Independent reads side by side (perf audit #3): the job, every photo's
  // versions and the delivery order; then the project and the ready folder.
  const [job, versions, order] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, finalsPath: true, deliveryPath: true } }),
    prisma.photoVersion.findMany({
      where: { photo: { jobId, status: "ACTIVE" } },
      orderBy: { createdAt: "desc" },
      select: { id: true, source: true, label: true, createdAt: true, derivJson: true, photoId: true, photo: { select: { name: true } } },
    }),
    deliveryOrderFor(jobId),
  ]);
  if (!job) throw new Error("Photo job not found.");
  const { readyFolderState } = await import("./handoff");
  const { dropboxWebUrl } = await import("@/lib/dropboxFolders");
  const [project, rs] = await Promise.all([
    prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true, aryeoOrderId: true, title: true, clientId: true } }),
    readyFolderState(jobId, order.length).catch(() => null),
  ]);
  const profile = project?.clientId ? await prisma.clientQcProfile.findUnique({ where: { clientId: project.clientId }, select: { deliveryMessage: true } }).catch(() => null) : null;
  const street = (project?.title ?? "your listing").split(",")[0];
  const message =
    profile?.deliveryMessage?.trim() ||
    `Your photos for ${street} are ready. Thank you for trusting us with this listing. If anything needs a second look, reply here and we will take care of it. Realtour Pilot Team`;
  // The newest stored fix per photo, for a person replacing the listing's
  // copy by hand. Once the listing's copy is replaced, the sync records a
  // newer "Replaced" version, and the photo drops off this list by itself.
  const seenPhoto = new Set<string>();
  const replacements: DeliverySteps["replacements"] = [];
  for (const f of versions) {
    if (seenPhoto.has(f.photoId)) continue;
    seenPhoto.add(f.photoId); // the newest version of each photo decides
    if (f.source !== "FIX" || !f.derivJson?.includes('"file"')) continue;
    replacements.push({ photoId: f.photoId, photoName: f.photo.name, versionId: f.id, downloadUrl: `/api/photo-fixes/${f.id}`, label: f.label, at: f.createdAt.toISOString() });
  }
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
    if (!gate.overrideAllowed) return { ok: false, message: gate.blockedForOverride ?? "This gallery cannot be delivered yet." };
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
  await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryCheckedAt: null, deliveryCheckNote: null } }).catch(() => {});
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

export type VerifyResult = { ok: boolean; waiting?: boolean; error?: boolean; message: string; aryeoCount: number | null; approved: number };

/** Every check is written down (Oct 14 2026, huddle finding 12): when, and what Aryeo said, errors included. */
async function noteCheck(jobId: string, r: VerifyResult): Promise<VerifyResult> {
  await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryCheckedAt: new Date(), deliveryCheckNote: r.message.slice(0, 300) } }).catch(() => {});
  return r;
}

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
  let r: VerifyResult;
  try {
    r = await verifyDeliveryOnce(jobId, by);
  } catch (e) {
    r = { ok: false, error: true, message: `The check could not finish (${(e as Error).message.slice(0, 140)}). It runs again on the next pass.`, aryeoCount: null, approved: 0 };
  }
  return noteCheck(jobId, r);
}

async function verifyDeliveryOnce(jobId: string, by: string): Promise<VerifyResult> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, stage: true } });
  if (!job) return { ok: false, message: "Photo job not found.", aryeoCount: null, approved: 0 };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true, title: true, deliveredAt: true, deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: "FLOORPLAN" }, select: { id: true } } } });
  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", "EXCLUDED"] } }, select: { id: true, name: true, status: true, sourceKind: true, sourceRef: true } });
  const active = photos.filter((p) => p.status === "ACTIVE");
  const approved = active.length;
  if (!project?.aryeoListingId) return { ok: false, error: true, message: "This job has no Aryeo listing linked yet, so the hub cannot check it.", aryeoCount: null, approved };
  let listing: ListingRead;
  try {
    listing = await aryeoRequest<ListingRead>(`/listings/${project.aryeoListingId}`, { query: { include: "images,floor_plans" } });
  } catch (e) {
    return { ok: false, error: true, message: `Couldn't read the Aryeo listing (${(e as Error).message.slice(0, 140)}).`, aryeoCount: null, approved };
  }
  // Only the listing's own delivery_status says so (backend audit #14):
  // Project.deliveredAt can be the hub's guess from the status sweep (it is
  // still the best time to record once Aryeo agrees).
  const delivered = String(listing.data?.delivery_status ?? "").toUpperCase() === "DELIVERED";
  if (!delivered) return { ok: false, waiting: true, message: `Aryeo still has the listing as ${(listing.data?.delivery_status ?? "not delivered").toLowerCase().replace(/_/g, " ")}.`, aryeoCount: null, approved };
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
    // A delivery nobody approved in the hub (Mark as delivering, Deliver in
    // Aryeo by hand) still settles the shoot's media check (Oct 21 2026).
    const { closeMediaCheckForPhotos } = await import("./mediaCheck");
    await closeMediaCheckForPhotos(jobId, { by, reason: "Photos delivered through Photo Delivery", human: false });
  }
  await logJobEvent(jobId, by, `delivery verified: ${aryeoCount} on the listing, ${approved} approved${extra ? `, ${extra} extra` : ""}`);
  return { ok: true, message: `Verified: ${aryeoCount} photos on the Aryeo listing (${approved} approved${extra ? `, ${extra} extra` : ""}).`, aryeoCount, approved };
}

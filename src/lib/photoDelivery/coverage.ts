import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { autohdr, autohdrConfigured } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { describePhoto, jsonFrom, refreshVerdict } from "./fixPolicy";
import { CHECK_FEATURES, readProgress, roomTypeFrom } from "./autohdrCheck";
import { DRONE_RE, expectedPhotosFor, type IntakeFile } from "./intake";
import { RULES_REGISTRY_VERSION, type RoomType, type Severity } from "./registry";
import { ON_LISTING } from "./listingMatch";

// ---------------------------------------------------------------------------
// ROOM COVERAGE, FREE (Oct 15 2026).
//
// 2236 Gregory Dr: the client got no photo of the primary bathroom's shower,
// and nothing in the hub noticed. The paid QC's coverage pass runs only when
// someone asks; the free check never looked at the gallery as a whole. This
// does, with no AI cost:
//   EXPECTED   from the listing (its bedrooms and bathrooms, from Aryeo) and
//              the property type: front exterior, rear exterior, kitchen,
//              living area, primary bedroom, primary bathroom with a shower
//              or tub view, and a view per bathroom.
//   DELIVERED  the job's active photos, with the rooms and features the free
//              check saw in them.
//   CAPTURED   AutoHDR's photos of the shoot (the hub's own intake, or the
//              linked shoot's photo list: a free read) and the photos left out
//              of the delivery. A captured photo the check never saw gets one
//              free describe for its room.
// For each room the listing needs and the delivery lacks:
//   · in the captured set → COVERAGE_ROOM_NOT_DELIVERED (the office: put it back);
//   · not in it → COVERAGE_ROOM_NOT_CAPTURED (the photographer: never shot);
//   · cannot tell (photos not matched to AutoHDR) → "not in the delivery".
// Plus COVERAGE_PHOTOS_LOST_IN_EDIT when AutoHDR returned fewer photos than
// the uploaded 5-shot bracket sets should make.
// A shower that only shows in the background of the primary bathroom photo is
// MINOR (advisory): "the primary shower has no photo of its own". Essential
// rooms are MAJOR and feed the delivery checklist's coverage line, so the
// same-day automatic delivery cannot go out without them (or a person's
// "Accept with reason").
// ---------------------------------------------------------------------------

export type LabeledPhoto = { id: string; name: string; room: RoomType | null; features: string[] };
export type CapturedPhoto = LabeledPhoto & { where: string };
export type RoomStatus = "DELIVERED" | "NOT_DELIVERED" | "NOT_CAPTURED" | "UNKNOWN" | "ADVISORY";
/** `issue` / `action`: the finding's own words, when a row needs other words than its status gives (Oct 22 2026). */
export type RoomRow = { key: string; label: string; status: RoomStatus; severity: Severity | null; photos: string[]; note: string; issue?: string; action?: string };
export type EditLoss = { batchNo: number; expected: number; returned: number };

export type CoverageInput = {
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  delivered: LabeledPhoto[];
  /** Shot but not in the delivery (left out of it, or only in AutoHDR), with the rooms seen. */
  notDelivered: CapturedPhoto[];
  /** notDelivered holds everything AutoHDR has that is not delivered (the delivered photos are matched to AutoHDR's). */
  capturedComplete: boolean;
  /** Some captured photos have no room yet: "never shot" cannot be said. */
  unlabeledCaptured: number;
  /**
   * Oct 22 2026 (615 Cliff Ln): photos already delivered on the listing (a
   * split job's earlier visit) that no check ever labeled. A room the new
   * visit lacks may well be one of them, so it is never "never photographed":
   * an advisory line asks to check the listing.
   */
  unlabeledOnListing?: number;
  /** The check saw features (v3): the shower view can be judged. */
  featuresKnown: boolean;
  lostInEdit: EditLoss[];
};

const BATHS: RoomType[] = ["PRIMARY_BATHROOM", "BATHROOM", "POWDER_ROOM"];
const has = (p: LabeledPhoto, ...f: string[]) => f.some((x) => p.features.includes(x));

/** The rooms a listing needs against what was delivered and shot. Pure. */
export function assessCoverage(input: CoverageInput): RoomRow[] {
  const condo = /condo|apartment|co-?op|\bunit\b|\bflat\b/i.test(input.propertyType ?? "");
  const land = /\bland\b|\blot\b/i.test(input.propertyType ?? "");
  const rows: RoomRow[] = [];
  const names = (ps: LabeledPhoto[]) => ps.map((p) => p.name).slice(0, 6);
  const missing = (key: string, label: string, severity: Severity, matches: (p: LabeledPhoto) => boolean): RoomRow => {
    const shot = input.notDelivered.filter(matches);
    if (shot.length) return { key, label, status: "NOT_DELIVERED", severity, photos: names(shot), note: `It was shot but is not in the delivery: ${shot.slice(0, 3).map((p) => `${p.name} (${p.where})`).join(", ")}.` };
    const listed = input.unlabeledOnListing ?? 0;
    if (listed > 0) {
      return {
        key, label, status: "ADVISORY", severity: "MINOR", photos: [],
        note: `Not in this visit's photos. ${listed} photo${listed === 1 ? " is" : "s are"} already delivered on the listing from an earlier visit and the hub has no room label for ${listed === 1 ? "it" : "them"}, so check the listing has it.`,
        issue: `${label}: not in this visit's photos (check the listing)`,
        action: "Check the Aryeo listing has it from the earlier visit. Fine to deliver.",
      };
    }
    if (!input.capturedComplete) return { key, label, status: "UNKNOWN", severity, photos: [], note: "Not in the delivery. The hub cannot see all of AutoHDR's photos of the shoot (or match them to the delivered ones), so it cannot tell whether it was shot." };
    if (input.unlabeledCaptured > 0) return { key, label, status: "UNKNOWN", severity, photos: [], note: `Not in the delivery. ${input.unlabeledCaptured} of AutoHDR's photos have not been looked at yet, so the hub cannot say it was never shot.` };
    const lost = input.lostInEdit.length ? " AutoHDR returned fewer photos than were shot, so it may have been lost in editing." : "";
    return { key, label, status: "NOT_CAPTURED", severity, photos: [], note: `Not in AutoHDR's photos of the shoot: it looks like it was never photographed.${lost}` };
  };
  const room = (key: string, label: string, severity: Severity, rooms: RoomType[], note?: (hit: LabeledPhoto[]) => string) => {
    const match = (p: LabeledPhoto) => !!p.room && rooms.includes(p.room);
    const hit = input.delivered.filter(match);
    rows.push(hit.length ? { key, label, status: "DELIVERED", severity: null, photos: names(hit), note: note?.(hit) ?? "" } : missing(key, label, severity, match));
  };
  room("front-exterior", "Front exterior", condo ? "MINOR" : "MAJOR", ["EXTERIOR_FRONT", "TWILIGHT_EXTERIOR"]);
  if (!condo) room("rear-exterior", "Rear exterior", "MINOR", ["EXTERIOR_REAR", "PATIO_DECK", "YARD", "POOL_SPA"]);
  if (land) return rows;
  room("kitchen", "Kitchen", "MAJOR", ["KITCHEN"]);
  room("living", "Living area", "MAJOR", ["LIVING", "FAMILY"]);
  if (input.bedrooms !== 0) room("primary-bedroom", "Primary bedroom", "MAJOR", ["PRIMARY_BEDROOM", "BEDROOM"], (hit) => (hit.some((p) => p.room === "PRIMARY_BEDROOM") ? "" : "No photo was labeled the primary bedroom; a bedroom is in."));
  if (input.bathrooms === 0) return rows;
  room("primary-bathroom", "Primary bathroom", "MAJOR", ["PRIMARY_BATHROOM", "BATHROOM"], (hit) => (hit.some((p) => p.room === "PRIMARY_BATHROOM") ? "" : "No photo was labeled the primary bathroom; a bathroom is in."));

  // The shower or tub view of the primary bathroom (Gregory Dr).
  const primary = input.delivered.filter((p) => p.room === "PRIMARY_BATHROOM");
  const pool = primary.length ? primary : input.delivered.filter((p) => p.room === "BATHROOM");
  if (input.featuresKnown && pool.length) {
    const label = primary.length ? "Primary shower or tub" : "A shower or tub view";
    const own = pool.filter((p) => has(p, "shower", "tub"));
    if (own.length) rows.push({ key: "primary-shower", label, status: "DELIVERED", severity: null, photos: names(own), note: "" });
    else {
      const rooms: RoomType[] = primary.length ? ["PRIMARY_BATHROOM"] : ["PRIMARY_BATHROOM", "BATHROOM"];
      const shot = input.notDelivered.filter((p) => !!p.room && rooms.includes(p.room) && has(p, "shower", "tub"));
      const bg = pool.find((p) => has(p, "shower_in_background", "tub_in_background"));
      if (shot.length) rows.push({ key: "primary-shower", label, status: "NOT_DELIVERED", severity: "MINOR", photos: names(shot), note: `A photo of the shower was shot but is not in the delivery: ${shot.slice(0, 3).map((p) => `${p.name} (${p.where})`).join(", ")}.` });
      else if (bg) rows.push({ key: "primary-shower", label, status: "ADVISORY", severity: "MINOR", photos: [bg.name], note: `The ${primary.length ? "primary " : ""}shower has no photo of its own: it only shows in the background of ${bg.name}.` });
      else rows.push({ key: "primary-shower", label, status: "ADVISORY", severity: "MINOR", photos: [], note: `No photo shows the ${primary.length ? "primary " : ""}shower or tub.` });
    }
  }

  // A view per bathroom (photos, not rooms: two angles of one bathroom count twice, so this only ever under-reports).
  if (input.bathrooms != null && input.bathrooms >= 2) {
    const need = Math.ceil(input.bathrooms);
    const got = input.delivered.filter((p) => !!p.room && BATHS.includes(p.room));
    if (got.length >= need) rows.push({ key: "bathrooms", label: "A view of each bathroom", status: "DELIVERED", severity: null, photos: names(got), note: `${got.length} bathroom photos for ${input.bathrooms} bathrooms.` });
    else {
      const m = missing("bathrooms", "A view of each bathroom", "MINOR", (p) => !!p.room && BATHS.includes(p.room));
      rows.push({ ...m, note: `${input.bathrooms} bathrooms on the listing, ${got.length} bathroom photo${got.length === 1 ? "" : "s"} in the delivery. ${m.note}` });
    }
  }
  return rows;
}

/** AutoHDR returned fewer photos than the 5-shot bracket sets make. Pure. Only when every non-drone file is part of a full set (no single test frames). */
export function editLoss(batches: { batchNo: number; files: IntakeFile[]; returned: number | null }[]): EditLoss[] {
  const out: EditLoss[] = [];
  for (const b of batches) {
    if (b.returned == null || !b.files.length) continue;
    const ground = b.files.filter((f) => !DRONE_RE.test(f.name)).length;
    if (ground % 5 !== 0) continue;
    const expected = expectedPhotosFor(b.files);
    if (b.returned < expected) out.push({ batchNo: b.batchNo, expected, returned: b.returned });
  }
  return out;
}

export type FindingPlan = { groupKey: string; ruleId: string; severity: Severity; responsibility: string; fixStrategy: string; specificIssue: string; explanation: string; recommendedAction: string; rawStatus: "NOT_MET" | "UNKNOWN"; confidence: number };

/** The coverage findings the rows call for. Pure. */
export function findingsFor(rows: RoomRow[], loss: EditLoss[]): FindingPlan[] {
  const out: FindingPlan[] = [];
  for (const r of rows) {
    if (r.status === "DELIVERED" || !r.severity) continue;
    const g = `coverage-${r.key}`;
    if (r.status === "NOT_DELIVERED") out.push({ groupKey: g, ruleId: "COVERAGE_ROOM_NOT_DELIVERED", severity: r.severity, responsibility: "ADMIN", fixStrategy: "ADMIN_ACTION", specificIssue: `${r.label}: shot but not in the delivery`, explanation: r.note, recommendedAction: `Put ${r.photos[0] ?? "the photo"} back in the delivery, or accept with a reason.`, rawStatus: "NOT_MET", confidence: 0.8 });
    else if (r.status === "NOT_CAPTURED") out.push({ groupKey: g, ruleId: "COVERAGE_ROOM_NOT_CAPTURED", severity: r.severity, responsibility: "PHOTOGRAPHER", fixStrategy: "RESHOOT", specificIssue: `${r.label}: never photographed`, explanation: r.note, recommendedAction: "Ask the photographer; a reshoot or a note to the client may be needed, or accept with a reason.", rawStatus: "NOT_MET", confidence: 0.8 });
    else if (r.status === "UNKNOWN") out.push({ groupKey: g, ruleId: "COVERAGE_ROOM_NOT_DELIVERED", severity: r.severity, responsibility: "HUMAN_REVIEW", fixStrategy: "HUMAN_REVIEW", specificIssue: `${r.label}: no photo in the delivery`, explanation: r.note, recommendedAction: "Look for it in AutoHDR's photos of the shoot, then add it, accept with a reason, or ask for a reshoot.", rawStatus: "UNKNOWN", confidence: 0.7 });
    else out.push({ groupKey: g, ruleId: "COVERAGE_ROOM_NOT_CAPTURED", severity: "MINOR", responsibility: r.action ? "HUMAN_REVIEW" : "PHOTOGRAPHER", fixStrategy: "NONE", specificIssue: r.issue ?? (r.key === "primary-shower" && r.photos.length ? `${r.label.replace(/ or tub$/, "")} has no photo of its own` : `${r.label}: no photo shows it`), explanation: r.note, recommendedAction: r.action ?? "Fine to deliver. Next time: a photo of the shower on its own.", rawStatus: "NOT_MET", confidence: 0.7 });
  }
  if (loss.length) {
    const exp = loss.reduce((s, l) => s + l.expected, 0), got = loss.reduce((s, l) => s + l.returned, 0);
    out.push({ groupKey: "coverage-lost-in-edit", ruleId: "COVERAGE_PHOTOS_LOST_IN_EDIT", severity: "MAJOR", responsibility: "EDITOR", fixStrategy: "EDITOR_MANUAL", specificIssue: `AutoHDR returned ${got} photos for ${exp} bracket sets`, explanation: `The upload${loss.length > 1 ? "s" : ""} should make ${exp} photos (5-shot brackets, drone shots single) and AutoHDR returned ${got}: ${exp - got} may have been lost in editing.`, recommendedAction: "Check the shoot in AutoHDR for the missing photos (a bracket set may not have merged), or accept with a reason.", rawStatus: "NOT_MET", confidence: 0.8 });
  }
  return out;
}

/** coverageJson. */
export type CoverageState = {
  v: 1;
  /** The delivered photo set this was worked out for (sorted active ids, hashed). */
  photoSet: string;
  done: boolean;
  at: string;
  expected: { bedrooms: number | null; bathrooms: number | null; propertyType: string | null };
  counts: { raw: number | null; expectedPhotos: number | null; autohdr: number | null; delivered: number; leftOut: number };
  capturedKnown: boolean;
  capturedNote: string | null;
  /** AutoHDR photos not in the delivery, with the room seen (kept between passes). */
  captured: Record<string, { name: string; room: string | null; features: string[]; tries?: number }>;
  rooms: RoomRow[];
  lostInEdit: EditLoss[];
};

export const photoSetKey = (ids: string[]) => createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);

export function parseCoverage(json: string | null | undefined): CoverageState | null {
  try {
    const c = JSON.parse(json ?? "") as CoverageState;
    return c && c.v === 1 ? c : null;
  } catch {
    return null;
  }
}

const OPEN_STAGES = ["QC_REVIEW", "READY", "FIXING", "ON_HOLD", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED"];
const MAX_DESCRIBES = 40;
const ROOM_PROMPT = [
  "Look at this real estate photo.",
  'Answer ONLY with JSON: {"room":"<room type>","features":["<from the feature list>"]}.',
  'room: the space shown, for example "front exterior", "rear exterior", "kitchen", "living room", "primary bedroom", "bedroom", "primary bathroom", "bathroom", "powder room". Say primary only for the main suite.',
  `features: only these, when this photo shows them: ${CHECK_FEATURES.join(", ")}. shower or tub = it is a main subject of the photo; shower_in_background or tub_in_background = it only shows in the background, partly, or through a doorway.`,
].join("\n");

/** One bounded slice over the jobs whose delivered set changed since their last coverage check. */
export async function driveCoverage(opts: { deadline: number }): Promise<{ jobs: number; findings: number; pending: number }> {
  const out = { jobs: 0, findings: 0, pending: 0 };
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.freeCheck || !settings.freeCoverage) return out;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const jobs = await prisma.photoJob.findMany({
    where: {
      OR: [{ stage: { in: OPEN_STAGES } }, { stage: "DELIVERED", stageChangedAt: { gte: weekAgo } }],
      // A v3 free check (it records "v"): rooms and features to work from.
      qcRuns: { some: { trigger: "AUTOHDR_CHECK", status: "DONE", checksJson: { contains: '"v":' } } },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, coverageJson: true, photos: { where: { status: { in: ["ACTIVE", ON_LISTING] } }, select: { id: true } } },
    take: 40,
  });
  for (const j of jobs) {
    if (opts.deadline - Date.now() < 10_000) break;
    const c = parseCoverage(j.coverageJson);
    if (c?.done && c.photoSet === photoSetKey(j.photos.map((p) => p.id))) continue;
    const r = await coverageJob(j.id, opts.deadline).catch((e) => {
      console.warn("photo delivery: coverage failed", j.id, (e as Error).message);
      return null;
    });
    if (!r) continue;
    out.jobs++;
    out.findings += r.findings;
    if (!r.done) out.pending++;
  }
  return out;
}

type Expected = { bedrooms?: number; bathrooms?: number; propertyType?: string };

export async function coverageJob(jobId: string, deadline: number): Promise<{ done: boolean; findings: number }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, stage: true, expectedJson: true, coverageJson: true, autohdrPhotoshootId: true, lastQcRunId: true } });
  if (!job) return { done: false, findings: 0 };
  const run = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { id: true, checksJson: true } });
  if (!run) return { done: false, findings: 0 };
  const progress = readProgress(run.checksJson);
  let expected: Expected = {};
  try { expected = JSON.parse(job.expectedJson ?? "{}") as Expected; } catch { expected = {}; }
  const photos = await prisma.photoAsset.findMany({ where: { jobId }, orderBy: { sequence: "asc" }, select: { id: true, name: true, status: true, roomType: true, featuresJson: true, autohdrImageUuid: true } });
  // Oct 22 2026 (615 Cliff Ln, "front exterior never photographed" while the
  // exteriors were on the listing): coverage reads the WHOLE listing, the
  // photos delivered now and the ones already delivered on it (ON_LISTING).
  // What AutoHDR shot is still matched against this visit's photos only.
  const thisVisit = photos.filter((p) => p.status === "ACTIVE");
  const listed = photos.filter((p) => p.status === ON_LISTING);
  const active = [...listed, ...thisVisit];
  const featuresOf = (p: (typeof photos)[number]): string[] => {
    const f = progress.features?.[p.id];
    if (Array.isArray(f)) return f;
    try { const a = JSON.parse(p.featuresJson ?? "[]") as unknown[]; return a.filter((x): x is string => typeof x === "string"); } catch { return []; }
  };
  const asLabeled = (p: (typeof photos)[number]): LabeledPhoto => ({ id: p.id, name: p.name, room: (p.roomType as RoomType | null) ?? null, features: featuresOf(p) });
  const prev = parseCoverage(job.coverageJson);
  const state: CoverageState = {
    v: 1, photoSet: photoSetKey(active.map((p) => p.id)), done: false, at: new Date().toISOString(),
    expected: { bedrooms: typeof expected.bedrooms === "number" ? expected.bedrooms : null, bathrooms: typeof expected.bathrooms === "number" ? expected.bathrooms : null, propertyType: typeof expected.propertyType === "string" ? expected.propertyType : null },
    counts: { raw: null, expectedPhotos: null, autohdr: null, delivered: active.length, leftOut: photos.filter((p) => p.status === "EXCLUDED").length },
    capturedKnown: false, capturedNote: null, captured: prev?.captured ?? {}, rooms: [], lostInEdit: [],
  };

  // CAPTURED: AutoHDR's photos of the shoot (free reads).
  const batches = await prisma.photoIntakeBatch.findMany({ where: { projectId: job.projectId }, orderBy: { batchNo: "asc" }, select: { batchNo: true, state: true, filesJson: true, fileCount: true, expectedPhotos: true, imageCount: true, photoshootId: true, photosJson: true } });
  const remote: { shootId: number; uuid: string; name: string }[] = [];
  for (const b of batches) {
    if (b.state !== "DONE" || !b.photoshootId) continue;
    try { for (const e of JSON.parse(b.photosJson ?? "[]") as { image_uuid: string; name?: string | null }[]) remote.push({ shootId: b.photoshootId, uuid: e.image_uuid, name: e.name || e.image_uuid }); } catch { /* unreadable */ }
  }
  let linkedCount: number | null = null;
  const intakeShoots = new Set(batches.filter((b) => b.state === "DONE").map((b) => b.photoshootId));
  if (job.autohdrPhotoshootId && !intakeShoots.has(job.autohdrPhotoshootId) && (await autohdrConfigured())) {
    try {
      const list = await autohdr.listPhotos(job.autohdrPhotoshootId);
      linkedCount = list.length;
      for (const e of list) remote.push({ shootId: job.autohdrPhotoshootId, uuid: e.image_uuid, name: e.name || e.image_uuid });
    } catch (e) {
      state.capturedNote = `AutoHDR's photo list could not be read (${(e as Error).message.slice(0, 80)}): shoots close after 7 days.`;
    }
  }
  const unlinked = thisVisit.filter((p) => !p.autohdrImageUuid).length;
  const leftOut: CapturedPhoto[] = photos.filter((p) => p.status === "EXCLUDED").map((p) => ({ ...asLabeled(p), where: "left out of the delivery" }));
  state.counts.autohdr = remote.length || null;
  state.capturedKnown = remote.length > 0 && unlinked === 0;
  if (!remote.length && !state.capturedNote) state.capturedNote = "No AutoHDR shoot is linked to this job, so the hub cannot see what was shot.";
  else if (remote.length && unlinked) state.capturedNote = `${unlinked} delivered photo${unlinked === 1 ? " is" : "s are"} not matched to AutoHDR's, so "shot but not delivered" cannot be told apart.`;

  // Label the AutoHDR photos not in the delivery (free describe), kept between passes.
  let unlabeled = 0;
  if (state.capturedKnown) {
    const deliveredUuids = new Set(active.map((p) => p.autohdrImageUuid));
    const byUuid = new Map(photos.filter((p) => p.autohdrImageUuid && p.roomType).map((p) => [p.autohdrImageUuid!, p]));
    const extra = remote.filter((r) => !deliveredUuids.has(r.uuid) && !photos.some((p) => p.status === "EXCLUDED" && p.autohdrImageUuid === r.uuid));
    let asked = Object.values(state.captured).reduce((s, c) => s + (c.tries ?? 0), 0);
    for (const r of extra) {
      const known = state.captured[r.uuid];
      if (known?.room) continue;
      const row = byUuid.get(r.uuid);
      if (row) {
        state.captured[r.uuid] = { name: r.name, room: row.roomType, features: featuresOf(row) };
        continue;
      }
      if ((known?.tries ?? 0) >= 2 || asked >= MAX_DESCRIBES || deadline - Date.now() < 12_000) {
        unlabeled++;
        continue;
      }
      asked++;
      let j: { room?: unknown; features?: unknown } | null = null;
      try { j = jsonFrom(await describePhoto(r.shootId, r.uuid, ROOM_PROMPT)); } catch { j = null; }
      const room = typeof j?.room === "string" ? roomTypeFrom(j.room) : null;
      const features = (Array.isArray(j?.features) ? j!.features : []).filter((x): x is string => typeof x === "string" && (CHECK_FEATURES as readonly string[]).includes(x));
      state.captured[r.uuid] = { name: r.name, room, features, tries: (known?.tries ?? 0) + 1 };
      if (!room) unlabeled++;
    }
    if (unlabeled && deadline - Date.now() < 12_000) {
      // Out of time: keep what was learned, finish next pass.
      await prisma.photoJob.update({ where: { id: jobId }, data: { coverageJson: JSON.stringify(state) } });
      return { done: false, findings: 0 };
    }
    for (const r of extra) {
      const c = state.captured[r.uuid];
      if (c?.room) leftOut.push({ id: r.uuid, name: c.name, room: c.room as RoomType, features: c.features, where: "in AutoHDR, not in the delivery" });
    }
  }

  // Bracket sets in, photos out.
  const files = (json: string | null) => { try { return JSON.parse(json ?? "[]") as IntakeFile[]; } catch { return []; } };
  const lossInput = batches
    .filter((b) => b.state === "DONE" || (b.state === "LINKED" && b.photoshootId === job.autohdrPhotoshootId && batches.filter((x) => x.state === "LINKED").length === 1))
    .map((b) => ({ batchNo: b.batchNo, files: files(b.filesJson), returned: b.state === "DONE" ? b.imageCount : linkedCount }));
  state.lostInEdit = editLoss(lossInput);
  state.counts.raw = batches.reduce((s, b) => s + (b.fileCount ?? 0), 0) || null;
  state.counts.expectedPhotos = batches.reduce((s, b) => s + (b.expectedPhotos ?? 0), 0) || null;

  state.rooms = assessCoverage({
    bedrooms: state.expected.bedrooms, bathrooms: state.expected.bathrooms, propertyType: state.expected.propertyType,
    delivered: active.map(asLabeled),
    notDelivered: leftOut,
    unlabeledOnListing: listed.filter((p) => !p.roomType).length,
    capturedComplete: state.capturedKnown,
    unlabeledCaptured: unlabeled,
    featuresKnown: (progress.v ?? 0) >= 3,
    lostInEdit: state.lostInEdit,
  });
  state.done = true;
  const plans = findingsFor(state.rooms, state.lostInEdit);

  // Findings: keep what is unchanged, set aside what no longer applies, never re-raise what a person decided.
  const existing = await prisma.photoQcFinding.findMany({ where: { jobId, source: "COVERAGE", status: { not: "SUPERSEDED" } }, select: { id: true, groupKey: true, status: true, specificIssue: true, severity: true } });
  const keep = new Set<string>();
  const create: FindingPlan[] = [];
  for (const p of plans) {
    const same = existing.find((e) => e.groupKey === p.groupKey && (e.status !== "OPEN" || (e.specificIssue === p.specificIssue && e.severity === p.severity)));
    if (same) keep.add(same.id);
    else create.push(p);
  }
  const stale = existing.filter((e) => e.status === "OPEN" && !keep.has(e.id)).map((e) => e.id);
  await prisma.$transaction([
    ...(stale.length ? [prisma.photoQcFinding.updateMany({ where: { id: { in: stale } }, data: { status: "SUPERSEDED", statusReason: "coverage checked again" } })] : []),
    ...(create.length
      ? [prisma.photoQcFinding.createMany({
          data: create.map((p) => ({
            qcRunId: run.id, jobId, photoId: null, ruleId: p.ruleId, groupKey: p.groupKey, pass: "P4_ORDER", source: "COVERAGE",
            specificIssue: p.specificIssue.slice(0, 300), explanation: p.explanation.slice(0, 1000), recommendedAction: p.recommendedAction.slice(0, 300),
            severity: p.severity, confidence: p.confidence, responsibility: p.responsibility, fixStrategy: p.fixStrategy, arbitration: "CONFIRMED",
            model: "coverage", rulesVersion: RULES_REGISTRY_VERSION, rawJson: JSON.stringify({ status: p.rawStatus, item: p.groupKey }),
          })),
        })]
      : []),
    prisma.photoJob.update({ where: { id: jobId }, data: { coverageJson: JSON.stringify(state), coverageCheckedAt: new Date() } }),
  ]);
  const gaps = state.rooms.filter((r) => r.status !== "DELIVERED");
  if (create.length || stale.length || !prev) {
    await logJobEvent(jobId, "coverage", `room coverage checked: ${state.rooms.length - gaps.length} of ${state.rooms.length} covered${gaps.length ? `; ${gaps.map((g) => `${g.label.toLowerCase()} ${g.status === "NOT_DELIVERED" ? "shot but not delivered" : g.status === "NOT_CAPTURED" ? "never photographed" : g.status === "ADVISORY" ? "(advisory)" : "not in the delivery"}`).join(", ")}` : ""}${state.lostInEdit.length ? "; photos may have been lost in editing" : ""}`, { photoSet: state.photoSet, findings: create.length, setAside: stale.length });
  }
  await refreshVerdict(jobId, "coverage").catch(() => {});
  return { done: true, findings: create.length };
}

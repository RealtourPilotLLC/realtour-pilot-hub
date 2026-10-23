import "server-only";

import { prisma } from "@/lib/prisma";
import { aryeoRequest } from "@/lib/integrations/aryeo";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";
import { appBase } from "@/lib/appUrl";
import { BY_HAND_LABEL, ON_LISTING, duplicateWords, listingDuplicates, listingImageHash } from "./listingMatch";

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
// still being calibrated against his manual review. Except the HOLD lines
// (Oct 21 2026, 859 N Lawrence St; clientAsked.ts): the photographer's
// wrap-up, and each thing the client asked about the photos, stop him too
// until they are settled (a typed reason for the wrap-up; Done or an answer
// for a request).
// ---------------------------------------------------------------------------

/** `advisory`: shown on the checklist, never counted in `passed` and never
 *  holding a person's delivery (open photo flags, Oct 21 2026). `href`: where
 *  the line's own work is.
 *  Oct 21 2026 (859 N Lawrence St, clientAsked.ts): `hold` lines hold a
 *  person's delivery even while the checklist is advisory (shadow mode): the
 *  photographer's wrap-up and each thing the client asked about the photos.
 *  `overridden` (the wrap-up only, `overridable`): a person typed why the
 *  photos may go out without it; the line is satisfied for a person, never
 *  for the hub's own delivery (`passed` stays false). `askId`: the ClientAsk
 *  the line is (Done / Answer on the job page).
 *  Oct 22 2026 (addOns.ts): `addOn` is add-on work on the order that must be
 *  confirmed before delivery (Lot Lines needed, Virtual Staging needed), with
 *  the agent's words; `personOnly`: the line never counts for the hub's own
 *  same-day delivery, even once it is cleared (Kyle approves those jobs). */
export type GateCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  advisory?: boolean;
  href?: string;
  hrefLabel?: string;
  hold?: boolean;
  overridable?: boolean;
  overridden?: string | null;
  askId?: string;
  addOn?: GateAddOn;
  /** Oct 22 2026: the photos the line is about (Update on Aryeo of photos edited in the hub). */
  photoIds?: string[];
  personOnly?: boolean;
  /** Oct 22 2026 (a client-asked line): who answers it, the settle button's words, and the client's full words. */
  waitingOn?: string;
  doneLabel?: string;
  said?: { from: string; text: string } | null;
  /**
   * Oct 23 2026 (huddle item 9): never holds a person (it is `advisory` for
   * Kyle), but the hub's own same-day delivery still waits for it: the
   * photographer's wrap-up. `askNotes`: the line offers "Ask the photographer
   * for notes" (askNotes.ts).
   */
  hubHold?: boolean;
  askNotes?: boolean;
};
/** The add-on behind a gate line: its key (the confirm button), the order line, the agent's words, and how it was cleared. */
export type GateAddOn = {
  key: string;
  need: string;
  done: string;
  ordered: string;
  quotes: { from: string; text: string }[];
  /** Oct 22 2026 (photo audit M2): "listing", the work already on the Aryeo listing (photoName: those images). */
  cleared: { how: "version" | "confirmed" | "listing"; by: string | null; atISO: string; note: string | null; photoName: string | null } | null;
};
/** `ignored`: the approve summary of the careful set-asides (clientAsked.ignoredCarefulSummary), shown before delivering, never a block. `holdsOpen`: hold lines still open. */
export type GateResult = { checks: GateCheck[]; passed: boolean; advisory: boolean; canDeliver: boolean; overrideAllowed: boolean; blockedForOverride: string | null; holdsOpen: number; ignored: string | null };

/**
 * `sync: false` (the board's one-line summary, Oct 22 2026): read the job as
 * it is, without filing the wrap-up's and the order's photo notes as items
 * first, and without the approve summary.
 */
export async function deliveryGate(jobId: string, opts: { sync?: boolean } = {}): Promise<GateResult> {
  const sync = opts.sync !== false;
  const [job, settings] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, stage: true, lastQcRunId: true, finalsCount: true, coverageJson: true } }),
    photoDeliverySettings(),
  ]);
  if (!job) throw new Error("Photo job not found.");
  const [open, all, lastRun] = await Promise.all([
    prisma.photoQcFinding.findMany({
      where: { jobId, status: { in: ["OPEN", "APPROVED_FIX", "FIXING"] } },
      select: { id: true, severity: true, confidence: true, arbitration: true, pass: true, ruleId: true, privacySensitive: true },
    }),
    prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", ON_LISTING] } }, select: { id: true, status: true, contentHash: true, inspectedHash: true, width: true, height: true, format: true } }),
    job.lastQcRunId ? prisma.photoQcRun.findUnique({ where: { id: job.lastQcRunId }, select: { status: true, passesJson: true, trigger: true, checksJson: true } }) : Promise.resolve(null),
  ]);
  // Oct 22 2026: the photos already delivered on the listing (a split job's
  // earlier visit) were checked when they went out; the checklist is about
  // the ones to deliver now. Room coverage reads them all (coverage.ts).
  const photos = all.filter((p) => p.status === "ACTIVE");
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
    ...(await roomsCheck(settings.freeCoverage && settings.freeCheck, lastRun, job.coverageJson, all.map((p) => p.id))),
    // Oct 19 2026 (lib/uploadGaps): the shoot's upload is missing part of the
    // order, e.g. only drone photos came in. Delivering the edits of half a
    // shoot is the one thing this gate must not wave through.
    ...(await uploadCheck(job.projectId)),
    // Oct 21 2026 (Jordan; audit C10): open photo flags, as a line Kyle sees.
    // They already hold the hub's own same-day delivery (aryeoPush
    // openPhotoFlags); here they are information only, never a hold on his
    // Approve and deliver.
    ...(await flagsCheck(job.projectId)),
    // Oct 22 2026: a photo edited in the hub (Lot lines, Straighten, an upload)
    // whose old file is still on the Aryeo listing: Update on Aryeo first.
    ...(await listingUpdateCheck(job.id, job.stage)),
    // Oct 21 2026 (Jordan, 859 N Lawrence St): the photographer's wrap-up and
    // what the client asked, each a line that holds delivery (clientAsked.ts).
    // Oct 22 2026 (Jordan, 58 Recreation Dr): lot lines, virtual staging: add-on
    // work on the order holds delivery until it is confirmed added (addOns.ts),
    // listed between the two (the order of holding.ts HOLDING_ORDER).
    ...(await askedChecks(job, sync).then(async (asked) => [...asked.filter((c) => c.key === "wrapup"), ...(await addOnChecks(job)), ...asked.filter((c) => c.key !== "wrapup")])),
  ];
  // An overridden line is a person's call, and a person-only line is Kyle's to
  // approve: neither ever counts for the hub's own delivery. Nor does a line
  // that only informs Kyle but holds the hub (hubHold: the wrap-up, Oct 23 2026).
  const passed = checks.every((c) => (c.ok && !c.overridden && !c.personOnly) || (c.advisory && !c.hubHold));
  // The house setting decides (audit, Oct 15): a job's own qcShadow only records
  // how its last check ran, and kept a job advisory after shadow mode was off.
  const advisory = settings.qcShadow;
  const privacyOrWrong = critical.find((f) => f.privacySensitive || /FILE_NO_MIXED_PROPERTIES|FILE_PROJECT_ASSOCIATION|FILE_CORRECT_PROPERTY_UPLOAD/.test(f.ruleId));
  const holdsOpen = checks.filter((c) => c.hold && !c.ok).length;
  const restPassed = checks.filter((c) => !c.hold).every((c) => c.ok || c.advisory);
  return {
    checks,
    passed,
    advisory,
    // Oct 20 2026 (audit C7): shadow mode makes the checklist advisory for a
    // person, never for a privacy or wrong-property critical. Those are the
    // ones Jordan's override refuses, so the routine path refuses them too.
    // Oct 21 2026: nor for a hold line (the wrap-up, what the client asked).
    canDeliver: (restPassed || advisory) && holdsOpen === 0 && !privacyOrWrong,
    overrideAllowed: !privacyOrWrong,
    blockedForOverride: privacyOrWrong ? "A privacy or wrong-property issue is open. That one has to be resolved, not overridden." : null,
    holdsOpen,
    ignored: sync ? await import("./clientAsked").then((m) => m.ignoredCarefulSummary(jobId)).catch(() => null) : null,
  };
}

/**
 * One HOLD line per add-on on the order (addOns.ts): "Lot Lines needed" with
 * the agent's words, until a photo carries the work or Kyle confirms it by
 * hand. Person-only: the hub's own same-day delivery never passes a job that
 * has one. A read that fails is an open hold (the same rule as the others).
 */
async function addOnChecks(job: { id: string; projectId: string | null }): Promise<GateCheck[]> {
  if (!job.projectId) return [];
  try {
    const { addOnStates } = await import("./addOns");
    return (await addOnStates(job.projectId, job.id)).map((a) => ({
      key: `addon:${a.key}`,
      label: a.cleared ? a.done : a.need,
      ok: !!a.cleared,
      hold: true,
      personOnly: true,
      detail: a.cleared
        ? a.cleared.how === "version"
          ? `on ${a.cleared.photoName ?? "a photo"}${a.cleared.by ? `, by ${a.cleared.by}` : ""}`
          : a.cleared.how === "listing"
            ? `already on the Aryeo listing: ${a.cleared.photoName ?? "the images"}`
            : `confirmed by ${a.cleared.by ?? "staff"}${a.cleared.note ? `: ${a.cleared.note}` : ""}`
        : `Ordered: ${a.ordered}`,
      addOn: { key: a.key, need: a.need, done: a.done, ordered: a.ordered, quotes: a.quotes, cleared: a.cleared },
    }));
  } catch {
    return [{ key: "addons", label: "Add-on work on the order (lot lines, virtual staging)", ok: false, hold: true, personOnly: true, detail: "could not be read just now, it is read again on the next pass" }];
  }
}

/**
 * The wrap-up line and one line per open photo request (clientAsked.ts). A
 * read that fails is an open hold, never a pass: the hub's own delivery must
 * not go out on a check it couldn't make (the same rule as uploadCheck).
 */
async function askedChecks(job: { id: string; projectId: string | null; stage: string }, sync = true): Promise<GateCheck[]> {
  if (!job.projectId) return [];
  const projectId = job.projectId;
  const m = await import("./clientAsked");
  const lines: GateCheck[] = [];
  try {
    const w = await m.wrapUpState(projectId, job.id);
    if (w?.owed) {
      const who = w.firstName ?? "The photographer";
      if (!w.missing) lines.push({ key: "wrapup", label: `${who}'s wrap-up is in`, ok: true, hold: true });
      else {
        // Oct 23 2026 (Jordan and Kyle's huddle, item 9): missing notes NEVER
        // hold Kyle ("continue without the photographer's wrap-up" every day:
        // Harrison doesn't add notes). The line tells him and offers "Ask the
        // photographer for notes" (askNotes.ts); only the hub's own same-day
        // delivery still waits for it (hubHold), as it did.
        const parts = [!w.removal ? "removal notes not answered" : null, !w.cull ? "cull not confirmed" : null].filter(Boolean).join(", ");
        lines.push({
          key: "wrapup",
          label: `${who} hasn't sent the wrap-up yet (any notes for the photos are unknown).`,
          ok: !!w.override,
          advisory: true,
          hubHold: true,
          askNotes: true,
          overridden: w.override ? `${w.override.by}: ${w.override.reason}` : null,
          detail: parts || "not sent",
          href: w.href,
          hrefLabel: `Open ${w.firstName ? `${w.firstName}'s` : "the"} wrap-up`,
        });
      }
    }
  } catch {
    // A read that fails never passes the hub's own delivery, and never holds Kyle.
    lines.push({ key: "wrapup", label: "The photographer's wrap-up", ok: false, advisory: true, hubHold: true, detail: "could not be read just now, it is read again on the next pass" });
  }
  try {
    // The wrap-up's removal notes and the order's photo notes become items to
    // tick off, before the photos go out (never after).
    if (sync && !["DELIVERED", "DELIVERING"].includes(job.stage)) await m.syncPhotoAsks(projectId);
    for (const it of await m.clientAskedItems(projectId)) {
      lines.push({ key: `ask:${it.id}`, label: it.label, ok: false, hold: it.holds, advisory: !it.holds, askId: it.id, detail: it.detail, waitingOn: it.waitingOn, doneLabel: it.doneLabel, said: it.said });
    }
  } catch {
    lines.push({ key: "asks", label: "What the client asked", ok: false, hold: true, detail: "could not be read just now, it is read again on the next pass" });
  }
  return lines;
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

/**
 * Photos edited in the hub whose old file is still on the Aryeo listing
 * (holding.needsListingUpdate: read from the listing, or a split job's
 * delivered photo): a HOLD line until Update on Aryeo replaces them, so the
 * listing never goes out (or out again) with the file before the edit. The
 * delivery itself only sends the photos it puts on the listing.
 */
async function listingUpdateCheck(jobId: string, stage: string): Promise<GateCheck[]> {
  const { needsListingUpdate } = await import("./holding");
  const rows = await prisma.photoAsset
    .findMany({ where: { jobId, status: { in: ["ACTIVE", ON_LISTING] }, contentHash: { startsWith: "hub-" } }, orderBy: { sequence: "asc" }, select: { id: true, name: true, status: true, sourceKind: true, contentHash: true } })
    .catch(() => null);
  if (rows === null) return [{ key: "listing-update", label: "Photos edited in the hub, on the Aryeo listing", ok: false, hold: true, detail: "could not be read just now, it is read again on the next pass" }];
  const due = rows.filter((p) => needsListingUpdate(p, stage));
  if (!due.length) return [];
  const n = due.length;
  return [{
    key: "listing-update",
    label: `${n} photo${n === 1 ? "" : "s"} edited in the hub still ${n === 1 ? "has its" : "have their"} old file on the Aryeo listing: Update on Aryeo first`,
    ok: false,
    hold: true,
    detail: due.slice(0, 4).map((p) => p.name).join(", ") + (n > 4 ? ", …" : ""),
    photoIds: due.map((p) => p.id),
  }];
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

// THE HUB'S OWN ORDER (plan §7.6; Oct 23 2026, Jordan and Kyle's huddle: the
// hero was a front door close-up). The way Kyle set 1316 Blair Cir by hand:
//   1. the hero: the best, clearest WIDE shot of the front of the house (a
//      twilight one first when there is one), never a close-up (a door, a
//      fixture: the free check's view, autohdrCheck.heroScoreFrom);
//   2. the other front exteriors (wide before close-ups), then aerials;
//   3. the inside in walkthrough order: entry, living and dining, kitchen,
//      the primary suite, bedrooms, bathrooms, the rest, the lower level,
//      laundry and garage; AutoHDR's (the photographer's) order within each;
//   4. the backyard and the rear of the house LAST (patio, pool, yard, rear).
// Room labels come from the free check (autohdrCheck.labelRoom). A person's
// order (PhotoJob.orderJson) or hero (heroPhotoId) always wins: the hub
// never re-sorts what Kyle set by hand (deliveryOrderFor).
export const GROUP_ORDER = ["FRONT_EXTERIOR", "AERIAL", "ENTRY", "MAIN_LIVING", "KITCHEN", "PRIMARY_SUITE", "BEDROOMS", "BATHROOMS", "FLEX", "LOWER_LEVEL", "UTILITY", "DETAIL", "COMMUNITY", "OUTDOOR_LIVING", "REAR_EXTERIOR"];
/** At or under this hero score a front photo is a close-up (a door, a fixture): never the hero. */
export const CLOSE_UP_SCORE = 30;

type OrderablePhoto = { id: string; name: string; sequence: number; sequenceGroup: string | null; heroScore: number | null; isTwilight: boolean; roomType: string | null };

const isFront = (p: OrderablePhoto) => p.sequenceGroup === "FRONT_EXTERIOR" || p.roomType === "EXTERIOR_FRONT" || p.roomType === "TWILIGHT_EXTERIOR";
const isCloseUp = (p: OrderablePhoto) => p.heroScore != null && p.heroScore <= CLOSE_UP_SCORE;

/** The hero the hub picks: the best wide front exterior (twilight first), never a close-up. Pure. */
export function suggestedHeroOf(photos: OrderablePhoto[]): OrderablePhoto | null {
  const best = (list: OrderablePhoto[]) => [...list].sort((a, b) => Number(b.isTwilight || b.roomType === "TWILIGHT_EXTERIOR") - Number(a.isTwilight || a.roomType === "TWILIGHT_EXTERIOR") || (b.heroScore ?? 0) - (a.heroScore ?? 0) || a.sequence - b.sequence)[0] ?? null;
  const front = photos.filter((p) => isFront(p) && !isCloseUp(p));
  if (front.length) return best(front);
  // No wide front shot: an aerial, then any other wide outside shot, never a close-up.
  const aerial = photos.filter((p) => (p.sequenceGroup === "AERIAL" || p.roomType === "AERIAL") && !isCloseUp(p));
  return aerial.length ? best(aerial) : null;
}

export function suggestedOrder(photos: OrderablePhoto[], heroId: string | null): OrderablePhoto[] {
  if (!photos.some((p) => p.sequenceGroup)) return [...photos].sort((a, b) => a.sequence - b.sequence); // not classified yet
  const rank = (g: string | null) => (g && GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  // Inside the front group, the wide shots before the close-ups.
  const sorted = [...photos].sort((a, b) => rank(a.sequenceGroup) - rank(b.sequenceGroup) || (isFront(a) && isFront(b) ? Number(isCloseUp(a)) - Number(isCloseUp(b)) : 0) || a.sequence - b.sequence);
  const hero = (heroId ? sorted.find((p) => p.id === heroId) : undefined) ?? suggestedHeroOf(sorted) ?? undefined;
  return hero ? [hero, ...sorted.filter((p) => p.id !== hero.id)] : sorted;
}

/** Where a split job's new photos start: after every photo already on the listing, and after any number the hub already gave one there. Pure. 0 on a single visit. */
export function listingOffset(listedNames: string[]): number {
  if (!listedNames.length) return 0;
  return Math.max(listedNames.length, ...listedNames.map((n) => Number(/^(\d{1,3})-/.exec(n)?.[1] ?? 0)));
}

/** The delivery order: a person's saved order, else the suggested one. */
export async function deliveryOrderFor(jobId: string): Promise<{ photoId: string; name: string; deliveryName: string }[]> {
  const [job, photos, listed] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { orderJson: true, heroPhotoId: true } }),
    prisma.photoAsset.findMany({
      where: { jobId, status: "ACTIVE" },
      orderBy: { sequence: "asc" },
      select: { id: true, name: true, sequence: true, sequenceGroup: true, heroScore: true, isTwilight: true, roomType: true },
    }),
    prisma.photoAsset.findMany({ where: { jobId, status: ON_LISTING }, select: { name: true } }),
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
  // Oct 22 2026 (615 Cliff Ln): a split job's new photos follow the ones
  // already on the listing, so they are numbered after them ("25-Kitchen.jpg"
  // after 24 delivered), and never share a name with one already there.
  const offset = listingOffset(listed.map((p) => p.name));
  const width = Math.max(2, String(offset + ordered.length).length);
  return ordered.map((p, i) => {
    const ext = (/\.[a-z0-9]+$/i.exec(p.name)?.[0] ?? ".jpg").toLowerCase();
    const word = (p.sequenceGroup && ROOM_WORDS[p.sequenceGroup]) || "Photo";
    // AutoHDR's QC checklist: twilight frames carry a twilight suffix and go
    // out with the main set.
    const suffix = p.isTwilight || p.roomType === "TWILIGHT_EXTERIOR" ? "-Twilight" : "";
    return { photoId: p.id, name: p.name, deliveryName: `${String(offset + i + 1).padStart(width, "0")}-${word}${suffix}${ext}` };
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
  const overridden = gate.checks.find((c) => c.overridden)?.overridden ?? null;
  // Every line passes for a person (a person-only line, such as lot lines confirmed, included).
  const allOk = gate.checks.every((c) => (c.ok && !c.overridden) || c.advisory);
  const moved = await setStage(jobId, ["READY", "QC_REVIEW", "EDITED", "DELIVERY_MISMATCH", "REVISION_REQUESTED"], "DELIVERING", by, {
    why: opts.override ? `owner override: ${opts.override.reason.trim()}` : gate.passed || allOk ? "checklist passed" : overridden ? `without the photographer's wrap-up (${overridden})` : "advisory checklist (shadow mode)",
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

type ListingRead = { data?: { images?: { id?: string; filename?: string | null; original_url?: string; large_url?: string; caption?: string | null; display_in_gallery?: boolean }[]; floor_plans?: unknown[]; delivery_status?: string } };

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

/** The job event a re-delivery writes (photo audit H3): the first delivery stays in PhotoJob.deliveredAt, each one after it is one of these (data: { at, source }). */
export const REDELIVERED_ACTION = "re-delivered";
/** The stages a verified delivery moves on from (Oct 22 2026, photo audit C1): a person's or the hub's delivery, or a delivery problem. */
const VERIFY_MOVES_FROM = ["DELIVERING", "DELIVERY_MISMATCH"] as const;

/**
 * Where this job's current round began (photo audit H3): the latest move of a
 * delivered job back to Editing (a split job's new visit), else when the job
 * was opened. Deliveries before it were another round's.
 */
export async function roundStartOf(jobId: string, createdAt: Date): Promise<Date> {
  const back = await prisma.photoJobEvent.findFirst({
    where: { jobId, OR: [{ action: { startsWith: "DELIVERED → EDITING" } }, { action: { startsWith: "DELIVERING → EDITING" } }, { action: { startsWith: "DELIVERY_MISMATCH → EDITING" } }] },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  return back?.at ?? createdAt;
}

/** Aryeo's LISTING_DELIVERED webhooks for a listing since `since`, by when Aryeo says it happened (oldest first). Each one's occurred_at is kept only within 10 minutes of when it reached the hub (a stale or odd body proves nothing). */
export async function listingDeliveredHooks(listingId: string, since: Date, until: Date): Promise<Date[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: { provider: "aryeo", eventType: "LISTING_DELIVERED", createdAt: { gte: new Date(since.getTime() - 10 * 60_000), lte: new Date(until.getTime() + 10 * 60_000) }, payload: { contains: listingId } },
    orderBy: { createdAt: "asc" },
    select: { payload: true, createdAt: true },
    take: 50,
  });
  const out: Date[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { occurred_at?: unknown; resource?: { id?: unknown } };
      if (p.resource?.id !== listingId || typeof p.occurred_at !== "string") continue;
      const at = Date.parse(p.occurred_at);
      if (!Number.isFinite(at) || Math.abs(at - r.createdAt.getTime()) > 10 * 60_000) continue;
      if (at >= since.getTime() && at <= until.getTime()) out.push(new Date(at));
    } catch { /* an unreadable body proves nothing */ }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * WHEN THE PHOTOS REALLY WENT OUT (Oct 22 2026, photo audit H3). deliveredAt
 * used to be the project's delivery date or "now": when the hub noticed, a day
 * late for 859 N Lawrence St (out Oct 21 1:45 PM, recorded Oct 22 7:58 AM)
 * and hours late for 615 Cliff Ln (out 11:38 AM, recorded 5:48 PM). In order:
 *   1. the hub's own Deliver in Aryeo (the push run's deliveredAt);
 *   2. Aryeo's LISTING_DELIVERED webhook (the earliest since `since`);
 *   3. when the sync first saw Aryeo say "delivered" (its move to Delivering);
 *   4. now.
 * The earliest of 1 and 2 wins. Read-only.
 */
export async function deliveryTimeFor(jobId: string, listingId: string | null, since: Date, now: Date = new Date()): Promise<{ at: Date; source: "push" | "aryeo-webhook" | "sync" | "verify" }> {
  const found: { at: Date; source: "push" | "aryeo-webhook" }[] = [];
  const run = await prisma.appSetting.findUnique({ where: { key: `photo_aryeo_push:${jobId}` }, select: { value: true } }).catch(() => null);
  try {
    const d = run ? (JSON.parse(run.value) as { deliveredAt?: string | null }).deliveredAt : null;
    const at = d ? Date.parse(d) : NaN;
    if (Number.isFinite(at) && at >= since.getTime() && at <= now.getTime()) found.push({ at: new Date(at), source: "push" });
  } catch { /* no run record */ }
  if (listingId) {
    const hooks = await listingDeliveredHooks(listingId, since, now).catch(() => [] as Date[]);
    if (hooks[0]) found.push({ at: hooks[0], source: "aryeo-webhook" });
  }
  if (found.length) return found.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  const seen = await prisma.photoJobEvent.findFirst({ where: { jobId, actor: "sync", action: { contains: "→ DELIVERING: delivered in Aryeo" }, at: { gte: since, lte: now } }, orderBy: { at: "asc" }, select: { at: true } });
  return seen ? { at: seen.at, source: "sync" } : { at: now, source: "verify" };
}

async function verifyDeliveryOnce(jobId: string, by: string): Promise<VerifyResult> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, stage: true, deliveredAt: true, createdAt: true, deliveryStartedAt: true } });
  if (!job) return { ok: false, message: "Photo job not found.", aryeoCount: null, approved: 0 };
  // Oct 22 2026 (photo audit C1): Aryeo's "delivered" is sticky (it says so
  // for ever after the first delivery), so it is never read as a client's
  // revision being delivered again. A revision leaves only through Approve and
  // deliver again or Mark as delivering (both move the job to Delivering
  // first), or Settled with the client.
  if (!["DELIVERED", ...VERIFY_MOVES_FROM].includes(job.stage)) {
    const approved = await prisma.photoAsset.count({ where: { jobId, status: { in: ["ACTIVE", ON_LISTING] } } });
    return {
      ok: false,
      message: job.stage === "REVISION_REQUESTED"
        ? "The client asked for changes after delivery. Aryeo still shows the earlier delivery, so nothing is checked: send the photos again (Approve and deliver again, or Mark as delivering), or press Settled with the client."
        : "This job is not marked as delivering yet, so there is no delivery to check.",
      aryeoCount: null,
      approved,
    };
  }
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true, title: true, deliveredAt: true, deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: "FLOORPLAN" }, select: { id: true } } } });
  const photos = await prisma.photoAsset.findMany({
    where: { jobId, status: { in: ["ACTIVE", "EXCLUDED", ON_LISTING] } },
    select: { id: true, name: true, status: true, sourceKind: true, sourceRef: true, versions: { where: { source: "EDITOR", label: { startsWith: BY_HAND_LABEL } }, select: { contentHash: true } } },
  });
  // Oct 22 2026 (615 Cliff Ln): the target is the WHOLE listing: the photos
  // delivered now and the ones already on it (a split job's earlier visit, a
  // photo added by hand), so 23 + 1 + 35 verify as 59.
  const active = photos.filter((p) => p.status === "ACTIVE" || p.status === ON_LISTING);
  const approved = active.length;
  if (!project?.aryeoListingId) return { ok: false, error: true, message: "This job has no Aryeo listing linked yet, so the hub cannot check it.", aryeoCount: null, approved };
  let listing: ListingRead;
  try {
    listing = await aryeoRequest<ListingRead>(`/listings/${project.aryeoListingId}`, { query: { include: "images,floor_plans" } });
  } catch (e) {
    return { ok: false, error: true, message: `Couldn't read the Aryeo listing (${(e as Error).message.slice(0, 140)}).`, aryeoCount: null, approved };
  }
  // Only the listing's own delivery_status says so (backend audit #14):
  // Project.deliveredAt can be the hub's guess from the status sweep. The time
  // recorded is deliveryTimeFor's (photo audit H3), never the project's date.
  const delivered = String(listing.data?.delivery_status ?? "").toUpperCase() === "DELIVERED";
  if (!delivered) return { ok: false, waiting: true, message: `Aryeo still has the listing as ${(listing.data?.delivery_status ?? "not delivered").toLowerCase().replace(/_/g, " ")}.`, aryeoCount: null, approved };
  const shown = (listing.data?.images ?? []).filter((i) => i.display_in_gallery !== false);
  const shownIds = new Set(shown.map((i) => i.id).filter(Boolean) as string[]);
  const aryeoCount = shown.length;
  const images = shown.map((i, n) => ({ name: i.filename || `Photo ${n + 1}.jpg`, sourceRef: i.id ?? null, contentHash: listingImageHash(i.id, i.original_url ?? i.large_url ?? "") }));
  const shownHashes = new Set(images.map((i) => i.contentHash));
  const fromListing = active.filter((p) => p.sourceKind === "ARYEO" && p.sourceRef);
  // A photo of the new visit on the listing by hand: found by the listing image recorded for it.
  const byHand = active.filter((p) => p.status === ON_LISTING && p.sourceKind !== "ARYEO" && p.versions.length > 0);
  const missing = [...fromListing.filter((p) => !shownIds.has(p.sourceRef!)), ...byHand.filter((p) => !p.versions.some((v) => !!v.contentHash && shownHashes.has(v.contentHash)))].map((p) => p.name);
  const excludedShown = photos.filter((p) => p.status === "EXCLUDED" && p.sourceKind === "ARYEO" && p.sourceRef && shownIds.has(p.sourceRef)).map((p) => p.name);
  // Photos the hub cannot find by id are counted (Dropbox galleries; a split
  // job's new visit before the sync carries its rows over to the listing).
  const split = active.some((p) => p.status === ON_LISTING);
  const unplaced = active.length - fromListing.length - byHand.length;
  const short = (fromListing.length === 0 || (split && unplaced > 0)) && aryeoCount < approved;
  const floorMissing = (project.deliverables?.length ?? 0) > 0 && (listing.data?.floor_plans?.length ?? 0) === 0;
  const extra = Math.max(0, aryeoCount - approved);
  // NO PHOTO TWICE (Oct 22 2026, Jordan: "make sure there are no duplicates in
  // Aryeo"): two images that are the same photo of the hub, or two with the
  // same file name. Flagged for Kyle on the job, never deleted by the hub.
  const ownerByRef = new Map(photos.filter((p) => p.sourceKind === "ARYEO" && p.sourceRef).map((p) => [p.sourceRef!, p.id]));
  const ownerByHash = new Map(photos.flatMap((p) => p.versions.filter((v) => !!v.contentHash).map((v) => [v.contentHash!, p.id] as const)));
  const duplicates = listingDuplicates(images, (img) => (img.sourceRef ? ownerByRef.get(img.sourceRef) : undefined) ?? ownerByHash.get(img.contentHash) ?? null);
  const diff = { approved, aryeoCount, missing, excludedShown, floorPlanMissing: floorMissing, extra, duplicates: duplicates.map((d) => d.names), checkedAt: new Date().toISOString() };
  const problems: string[] = [];
  if (missing.length) problems.push(`${missing.length} approved photo${missing.length === 1 ? " is" : "s are"} not on the listing`);
  if (short) problems.push(`Aryeo shows ${aryeoCount} photos but ${approved} were approved`);
  if (excludedShown.length) problems.push(`${excludedShown.length} excluded photo${excludedShown.length === 1 ? " is" : "s are"} still shown`);
  // A FLOOR PLAN IS ITS OWN DELIVERABLE (Oct 23 2026, Jordan, about 30 Caedman
  // Dr and 850 Springbank Ln: "these are saying this but they're sent"). The
  // CubiCasa plan reaches the listing on its own schedule, so it never holds
  // the photos' delivery or reads as a mismatch. It stays on the diff
  // (floorPlanMissing), where the job page and Kyle's desk show it as still
  // to come.
  if (duplicates.length) problems.push(`${duplicates.length === 1 ? "a photo is" : `${duplicates.length} photos are`} on the listing twice (${duplicateWords(duplicates)}): take the extra copy off in Aryeo, the hub never deletes there`);
  if (problems.length) {
    const line = problems.join("; ");
    // Oct 22 2026 (859 N Lawrence St): a job already in mismatch keeps its
    // stage but always gets the fresh diff; the board showed "8 approved
    // photos are not on the listing" from a check the listing had moved past.
    if (job.stage === "DELIVERY_MISMATCH") await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryDiffJson: JSON.stringify(diff) } });
    else await setStage(jobId, ["DELIVERING", "DELIVERED", "READY", "QC_REVIEW", "EDITED"], "DELIVERY_MISMATCH", by, { why: line, extra: { deliveryDiffJson: JSON.stringify(diff) } });
    const street = (project.title ?? "").split(",")[0];
    // Shadow mode (the first two weeks): the mismatch is recorded on the job
    // page, nobody is pinged, while the checks are calibrated.
    const { qcShadow } = await photoDeliverySettings();
    if (!qcShadow) await alertOwnerAndKyle({
      kind: "photo_delivery_mismatch",
      title: `Delivery check: ${street}`.slice(0, 90),
      body: line.slice(0, 140),
      href: `/ops/photo-delivery/${jobId}`,
      dedupeKey: `pd-mismatch-${jobId}-${missing.length}-${excludedShown.length}-${aryeoCount}-${approved}-${floorMissing ? 1 : 0}${duplicates.length ? `-d${duplicates.length}` : ""}`,
      text: `${street}: ${line}. Check: ${appBase()}/ops/photo-delivery/${jobId}`,
      to: "kyle",
    });
    return { ok: false, message: `${line[0].toUpperCase()}${line.slice(1)}.`, aryeoCount, approved };
  }
  await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryDiffJson: JSON.stringify(diff) } });
  if (job.stage !== "DELIVERED") {
    const now = new Date();
    if (job.deliveredAt) {
      // A RE-DELIVERY (photo audit H3): the first delivery stays the job's
      // deliveredAt (the on-time record); this one is written on its own.
      const since = await import("./clientAsked").then((m) => m.revisionStartOf(jobId)).catch(() => null);
      const from = job.deliveryStartedAt && (!since || job.deliveryStartedAt > since) ? job.deliveryStartedAt : since ?? job.deliveredAt;
      const t = await deliveryTimeFor(jobId, project.aryeoListingId, from, now);
      const moved = await setStage(jobId, [...VERIFY_MOVES_FROM], "DELIVERED", by, { why: `verified: ${aryeoCount} photos on the listing (delivered again; first delivered ${job.deliveredAt.toISOString()})` });
      if (moved) {
        await logJobEvent(jobId, by, `${REDELIVERED_ACTION}: ${t.at.toISOString()} (${t.source})`, { at: t.at.toISOString(), source: t.source, firstDeliveredAt: job.deliveredAt.toISOString() });
        // The revision round is over: the photo revision's to-do closes from the photo side (photo audit H1).
        await import("./clientAsked").then((m) => m.closePhotoRevisionTask(job.projectId, `the photos were delivered again (${by})`)).catch(() => null);
      }
    } else {
      const t = await deliveryTimeFor(jobId, project.aryeoListingId, await roundStartOf(jobId, job.createdAt), now);
      await setStage(jobId, [...VERIFY_MOVES_FROM], "DELIVERED", by, { why: `verified: ${aryeoCount} photos on the listing (delivered ${t.at.toISOString()}, from ${t.source === "push" ? "the hub's own delivery" : t.source === "aryeo-webhook" ? "Aryeo's delivery notice" : t.source === "sync" ? "when the hub first saw it delivered" : "this check"})`, extra: { deliveredAt: t.at, deliveredBy: by } });
    }
    // A delivery nobody approved in the hub (Mark as delivering, Deliver in
    // Aryeo by hand) still settles the shoot's media check (Oct 21 2026).
    const { closeMediaCheckForPhotos } = await import("./mediaCheck");
    await closeMediaCheckForPhotos(jobId, { by, reason: "Photos delivered through Photo Delivery", human: false });
  }
  await logJobEvent(jobId, by, `delivery verified: ${aryeoCount} on the listing, ${approved} approved${extra ? `, ${extra} extra` : ""}, no photo twice`);
  return { ok: true, message: `Verified: ${aryeoCount} photos on the Aryeo listing (${approved} approved${extra ? `, ${extra} extra` : ""}), no photo on it twice.`, aryeoCount, approved };
}

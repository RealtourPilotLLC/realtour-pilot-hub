import "server-only";

import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import { etDateTime } from "@/lib/datetime";
import { logJobEvent, setStage } from "./jobState";
import { ignoredSummaryLine, photoNumbers, type IgnoredGroup } from "./careRules";
import { PHOTO_OFFICE_KEY_PREFIX } from "@/lib/itemMedium";

// ---------------------------------------------------------------------------
// WHAT WAS PROMISED, BEFORE THE PHOTOS GO OUT (Oct 21 2026, 859 N Lawrence St).
//
// Jordan: "Kyle should not have missed this on Joe's photos ... make sure
// things like this do not get missed again." James and Harrison told the
// client the wooden sidewalk forms would be cropped out; nothing recorded it
// (Harrison never sent the wrap-up), the photos went out, and the client's
// text afterwards landed on an unrelated to-do assigned to nobody. So:
//
//   1. THE WRAP-UP: a job whose photographer has not sent the upload page's
//      photos wrap-up (the removal notes answered, or "nothing needs
//      removal", and the cull confirmed: upload/actions.ts finalizeUpload)
//      gets a BLOCKING line on the delivery checklist naming them, with their
//      wrap-up page. A person (Kyle) can deliver without it only with a typed
//      reason, kept on the job's activity (WRAPUP_OVERRIDE_ACTION); the hub's
//      own same-day delivery never goes past it (delivery.ts: an overridden
//      line never counts as passed). The photographer is nudged by the 10 PM
//      upload chaser (uploadDigest) and, from 10 AM the morning after the
//      shoot, by the missing-instructions text (lib/missingInstructions).
//   2. CLIENT ASKED: the photo requests on the job are ClientAsks (one state
//      machine for all of them): the client's own texts, emails and calls,
//      what staff typed for them, the order's customer notes about the photos
//      (re-filed here as photo asks, source "order_note") and the wrap-up's
//      removal notes (source "wrapup"); both stay off the boards, and the
//      "Before you send" box, which already shows them as notes, is as it
//      was. Each one that holds delivery is a blocking line until it is Done
//      (fixed) or answered with a note, with the photo numbers the client
//      named. A QC finding that shares words with one is linked to it ("Client
//      asked for this to be removed (order note)") and can't be set aside
//      until the request is answered.
//   3. AFTER DELIVERY: a new photo request reopens the photo job (DELIVERED →
//      REVISION_REQUESTED, "Client asked for changes after delivery") and
//      puts it on the delivery owner's list (kyleNotice.kyleDesk: the program's
//      DELIVERY duty owner, never a name search), on the same task the
//      revision machinery keys a photo revision under (photoRevisionTaskKey).
// ---------------------------------------------------------------------------

/** The action prefix of the override's PhotoJobEvent (the record the checklist reads). */
export const WRAPUP_OVERRIDE_ACTION = "wrap-up overridden";
/** The ClientAsk source the wrap-up's removal notes are filed under. */
export const WRAPUP_ASK_SOURCE = "wrapup";
/** How long the typed reason for delivering without the wrap-up must be. */
export const WRAPUP_OVERRIDE_MIN = 10;
const PHOTO_TYPES = ["PHOTOS", "DRONE", "TWILIGHT"];

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 24);
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || null;
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "the job";

// ---- 1. the photographer's wrap-up ---------------------------------------------------------

export type WrapUpFacts = {
  hasPhotographer: boolean;
  removalNotes: string | null;
  cullingConfirmedAt: Date | null;
  /** The order has photo lines the photographer owes (not removed, waived or marked couldn't complete). */
  photosOwed: boolean;
  /** The upload page was submitted (the whole page, or its photos half). */
  submitted: boolean;
  /** The shoot is from before the wrap-up existed (Sep 2 2026): nothing to wait for. */
  legacy: boolean;
};

/**
 * Is the photos wrap-up missing? (pure) The removal notes answered (a list, or
 * "nothing needs removal") AND the cull confirmed: the two answers the upload
 * page demands before the photos half goes in. A job with no photo lines on
 * the order waits only for the page itself.
 */
export function wrapUpMissing(f: WrapUpFacts): { missing: boolean; removal: boolean; cull: boolean } {
  const removal = !!f.removalNotes?.trim();
  const cull = !!f.cullingConfirmedAt;
  if (!f.hasPhotographer || f.legacy) return { missing: false, removal, cull };
  return { missing: f.photosOwed ? !(removal && cull) : !f.submitted, removal, cull };
}

export type WrapUpOverride = { by: string; atISO: string; reason: string };
export type WrapUpState = {
  /** The shoot has a photographer who owes a wrap-up (not a pre-Sep 2 shoot). */
  owed: boolean;
  missing: boolean;
  photographer: string | null;
  firstName: string | null;
  /** Their wrap-up page (the one the 10 PM chaser links to). */
  href: string;
  removal: boolean;
  cull: boolean;
  override: WrapUpOverride | null;
};

export async function wrapUpState(projectId: string, jobId?: string | null): Promise<WrapUpState | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      photographerId: true, removalNotes: true, cullingConfirmedAt: true, debriefSubmittedAt: true, photosHandoffAt: true, shootDate: true, createdAt: true,
      photographer: { select: { name: true } },
      deliverables: { select: { type: true, removedFromOrderAt: true, waivedAt: true, notCompletedReason: true } },
    },
  });
  if (!p) return null;
  const { DEBRIEF_PAY_GATE_FROM } = await import("@/lib/payroll");
  const facts: WrapUpFacts = {
    hasPhotographer: !!p.photographerId,
    removalNotes: p.removalNotes,
    cullingConfirmedAt: p.cullingConfirmedAt,
    photosOwed: p.deliverables.some((d) => PHOTO_TYPES.includes(d.type) && !d.removedFromOrderAt && !d.waivedAt && !d.notCompletedReason),
    submitted: !!(p.debriefSubmittedAt || p.photosHandoffAt),
    legacy: (p.shootDate ?? p.createdAt).getTime() < DEBRIEF_PAY_GATE_FROM,
  };
  const w = wrapUpMissing(facts);
  const owed = facts.hasPhotographer && !facts.legacy;
  return {
    owed,
    missing: w.missing,
    photographer: p.photographer?.name ?? null,
    firstName: firstName(p.photographer?.name),
    href: `/upload/${projectId}`,
    removal: w.removal,
    cull: w.cull,
    override: w.missing && jobId ? await wrapUpOverrideOf(jobId) : null,
  };
}

/** The newest "deliver without the wrap-up" on this job, or null. */
export async function wrapUpOverrideOf(jobId: string): Promise<WrapUpOverride | null> {
  const e = await prisma.photoJobEvent.findFirst({
    where: { jobId, action: { startsWith: WRAPUP_OVERRIDE_ACTION } },
    orderBy: { at: "desc" },
    select: { actor: true, at: true, action: true, dataJson: true },
  });
  if (!e) return null;
  let reason = e.action.slice(WRAPUP_OVERRIDE_ACTION.length).replace(/^[:\s]+/, "");
  try {
    const d = JSON.parse(e.dataJson ?? "{}") as { reason?: unknown };
    if (typeof d.reason === "string" && d.reason.trim()) reason = d.reason.trim();
  } catch { /* the action line carries it */ }
  return { by: e.actor, atISO: e.at.toISOString(), reason };
}

/**
 * A person delivers without the photographer's wrap-up: only with a typed
 * reason, which goes on the job's activity (the record the checklist reads)
 * and the project's timeline. Changes nothing else.
 */
export async function overrideWrapUp(jobId: string, reason: string, by: string): Promise<{ ok: boolean; message: string }> {
  const why = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (why.length < WRAPUP_OVERRIDE_MIN) return { ok: false, message: `Write why the photos can go out without the wrap-up (at least ${WRAPUP_OVERRIDE_MIN} characters): what you checked, and with whom.` };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true } });
  if (!job) return { ok: false, message: "That photo job no longer exists." };
  const w = await wrapUpState(job.projectId, jobId);
  if (!w?.missing) return { ok: true, message: "The wrap-up is in. Nothing to override." };
  const who = by.trim().slice(0, 120) || "staff";
  await logJobEvent(jobId, who, `${WRAPUP_OVERRIDE_ACTION}: ${why}`, { wrapUpOverride: true, reason: why, photographer: w.photographer });
  await prisma.activity
    .create({ data: { projectId: job.projectId, type: "SYSTEM", body: clip(`Photos cleared to go out without ${w.photographer ?? "the photographer"}'s wrap-up, by ${who}: ${why}`, 600) } })
    .catch(() => {});
  return { ok: true, message: `Saved. The photos no longer wait for ${w.firstName ?? "the photographer"}'s wrap-up; your reason is on the job's activity.` };
}

// ---- 2. client asked -------------------------------------------------------------------------

/**
 * The wrap-up's removal notes as ONE ask on the job (source "wrapup"), so they
 * are ticked off like a client's request. Idempotent: the same words file
 * once; new words close the old ask ("the photographer changed the removal
 * notes") and file the new ones; "nothing needs removal" files nothing. Never
 * on photos already out. Returns the open ask's id, or null.
 */
export async function syncWrapUpRemovalAsk(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clientId: true, removalNotes: true, photosHandoffAt: true, debriefSubmittedAt: true, photographer: { select: { name: true } } },
  });
  if (!p?.clientId) return null;
  const { NOTHING_TO_REMOVE_SENTINEL } = await import("@/lib/debrief");
  const notes = (p.removalNotes ?? "").trim();
  // "none", "n/a", "nothing": the same answer as ticking "Nothing needs removal".
  const wanted = notes && notes !== NOTHING_TO_REMOVE_SENTINEL && !/^(none|n\/?a|nothing|no|nope|-+)\.?$/i.test(notes) ? notes : "";
  const key = wanted ? `wrapup-removal:${projectId}:${sha(norm(wanted))}` : null;
  const { createAsk, closeAskWithReason } = await import("@/lib/clientAsks");
  const stale = await prisma.clientAsk.findMany({ where: { projectId, source: WRAPUP_ASK_SOURCE, state: "OPEN", ...(key ? { dedupeKey: { not: key } } : {}) }, select: { id: true } });
  for (const s of stale) await closeAskWithReason(s.id, "Hub", "the photographer changed the removal notes");
  if (!key) return null;
  const r = await createAsk({
    clientId: p.clientId,
    projectId,
    kind: "SPECIAL_REQUEST",
    medium: "photo",
    text: clip(wanted, 4000),
    summary: clip(`Remove: ${wanted.replace(/\s+/g, " ")}`, 200),
    source: WRAPUP_ASK_SOURCE,
    askedBy: p.photographer?.name ?? null,
    askedAt: p.photosHandoffAt ?? p.debriefSubmittedAt ?? undefined,
    holdsDelivery: true,
    dedupeKey: key,
    by: "hub (wrap-up)",
  });
  return r?.id ?? null;
}

/** The order-note asks Photo Delivery files (never the rows the Oct 19 clean-up closed: those were keyed "order-note:"). */
export const ORDER_NOTE_KEY_PREFIX = "photo-order-note:";

/**
 * THE ORDER'S NOTES (Oct 21 2026, orchestrator evidence for 859 N Lawrence
 * St): the client wrote "There are Wooden Side walk forms ... that needed to
 * be avoided in video and photoshopped in photos" in the Aryeo order notes,
 * before the shoot. Since Oct 19 order notes are not asks, and the photo job
 * never put them in front of Kyle as something to do. Each customer note on
 * the order (Order Notes, the photographer's Special Instructions; access and
 * logistics lines dropped) that concerns the photos (askMedium photo, or
 * unclear) is filed here as ONE photo ask (source "order_note", key
 * ORDER_NOTE_KEY_PREFIX + the reader's own key): an item that holds the
 * photos until Done or answered. Read with clientAsks.orderNotesOf, the
 * reader the "Before you send" box uses. A note that changed closes its old
 * item. Returns how many are open.
 */
export async function syncOrderNoteAsks(projectId: string): Promise<number> {
  const { orderNotesOf, createAsk, closeAskWithReason } = await import("@/lib/clientAsks");
  // About the photos: read photo or unclear, or a sentence that names the photos
  // ("avoided in video and photoshopped in photos" next to a video instruction
  // can read "video" as a whole).
  const PHOTO_SENTENCE = /\b(photos?|pictures?|pics?|images?|stills?|photoshop\w*)\b/i;
  const notes = (await orderNotesOf(projectId)).filter((c) => c.dedupeKey.startsWith("order-note:") && (c.medium !== "video" || PHOTO_SENTENCE.test(c.text)));
  const keys = new Set(notes.map((c) => `${ORDER_NOTE_KEY_PREFIX}${c.dedupeKey}`));
  const stale = await prisma.clientAsk.findMany({ where: { projectId, source: "order_note", state: "OPEN", dedupeKey: { startsWith: ORDER_NOTE_KEY_PREFIX } }, select: { id: true, dedupeKey: true } });
  for (const s of stale) if (!keys.has(s.dedupeKey ?? "")) await closeAskWithReason(s.id, "Hub", "the order note changed");
  let open = 0;
  for (const c of notes) {
    // The line says what it asks of the photos: the sentences that name them, else the reader's own lead.
    const aboutPhotos = c.text.split(/(?<=[.!?])\s+/).filter((s) => PHOTO_SENTENCE.test(s)).join(" ");
    const r = await createAsk({
      clientId: c.clientId,
      projectId,
      kind: "SPECIAL_REQUEST",
      medium: "photo",
      text: c.text,
      summary: aboutPhotos ? clip(`Order note: ${aboutPhotos}`, 240) : c.summary ?? null,
      source: "order_note",
      sourceRef: c.sourceRef ?? null,
      askedBy: c.askedBy ?? null,
      askedAt: c.askedAt,
      holdsDelivery: true,
      dedupeKey: `${ORDER_NOTE_KEY_PREFIX}${c.dedupeKey}`,
      by: "hub (order note)",
    });
    if (r) open++;
  }
  return open;
}

/** Everything the photo job files as items before the photos go out: the wrap-up's removal notes and the order's photo notes. */
export async function syncPhotoAsks(projectId: string): Promise<void> {
  await syncWrapUpRemovalAsk(projectId);
  await syncOrderNoteAsks(projectId);
}

export type ClientAskedItem = {
  id: string;
  /** "text" | "email" | "call" | "staff" | "order_note" | "wrapup" */
  source: string;
  /** "Client asked: crop out the wooden sidewalk forms (photos 1-5, 38-40)" / "Remove (Harrison's wrap-up): the bins" */
  label: string;
  /** Who and when, one line. */
  detail: string;
  /** The client's words, in full (money scrubbed). */
  words: string;
  numbers: string | null;
  fromWrapUp: boolean;
  holds: boolean;
  askedAtISO: string;
  /** Oct 22 2026 (lib/briefPhotoAsks): new work that was not ordered, a scope or price question for Jordan or Kyle, not a fix. */
  office: boolean;
  /** "photo" | "both" | "unclear": both / unclear asks are labelled (they show on the video side too). */
  medium: string | null;
  /** Who answers it: "Waiting on Kyle", or "Waiting on Jordan or Kyle" for an office question. */
  waitingOn: string;
  /** The settle button's words. */
  doneLabel: string;
  /** The client's full words, when the line is a summary of them ("Everything they said"). */
  said: { from: string; text: string } | null;
};

/**
 * The job's open photo requests (oldest first): what holds the photos'
 * delivery until each is Done or answered. Both / unclear asks count for the
 * photos too (the same rule as clientAsks.openAsksHolding). Money scrubbed:
 * these lines are Kyle's.
 */
export async function clientAskedItems(projectId: string): Promise<ClientAskedItem[]> {
  if (!projectId) return [];
  const { ASK_SOURCES, closesOnDelivery, mediumMatches, sourceWords } = await import("@/lib/clientAsks");
  const [rows, project] = await Promise.all([
    prisma.clientAsk.findMany({
      where: { projectId, state: "OPEN", kind: "SPECIAL_REQUEST", source: { in: [...ASK_SOURCES, WRAPUP_ASK_SOURCE, "order_note"] } },
      orderBy: { askedAt: "asc" },
      take: 40,
      select: { id: true, kind: true, text: true, summary: true, source: true, askedBy: true, askedAt: true, medium: true, holdsDelivery: true, dedupeKey: true },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { status: true, deliveredAt: true } }),
  ]);
  return rows
    // Order notes: only the ones Photo Delivery filed (an older row is the Oct 19 clean-up's business).
    // Oct 22 2026 (photo audit H2): an ask that holds delivery stays a line
    // while it is open, the job's delivery notwithstanding (the hub no longer
    // closes those by itself: a person settles them); a cancelled job's never.
    .filter((r) => mediumMatches(r.medium, "photo") && (r.holdsDelivery ? project?.status !== "CANCELLED" : !closesOnDelivery(r, project)) && (r.source !== "order_note" || (r.dedupeKey ?? "").startsWith(ORDER_NOTE_KEY_PREFIX)))
    .map((r) => {
      const fromWrapUp = r.source === WRAPUP_ASK_SOURCE;
      // Oct 22 2026 (lib/briefPhotoAsks): the photo part of a client's message,
      // split out of a video work order. New work not on the order is a scope
      // or price question for the office, not a fix; both / unclear say so.
      const office = (r.dedupeKey ?? "").startsWith(PHOTO_OFFICE_KEY_PREFIX);
      const words = scrubMoney(r.text.replace(/\s+/g, " ").trim());
      const numbers = photoNumbers(r.text);
      const what = scrubMoney((r.summary?.trim() || clip(words, 160)).replace(/^(Remove|Order note):\s*/i, ""));
      const which = numbers && !what.includes(numbers) ? ` (photos ${numbers})` : "";
      const label = fromWrapUp
        ? `Remove (${firstName(r.askedBy) ?? "the photographer"}'s wrap-up): ${clip(what, 200)}${which}`
        : r.source === "order_note"
          ? `Client asked (order note): ${clip(what, 200)}${which}`
          : office
            ? `Question for Jordan or Kyle: ${clip(what, 220)}`
            : r.medium === "both"
              ? `Client asked, for the photos and the video: ${clip(what, 200)}${which}`
              : r.medium === "unclear"
                ? `Client asked (not clear if photos or video): ${clip(what, 200)}${which}`
                : `Client asked: ${clip(what, 200)}${which}`;
      const detail = fromWrapUp
        ? `From the wrap-up, ${etDateTime(r.askedAt)}`
        : r.source === "order_note"
          ? `${r.askedBy ?? "The client"}, on the Aryeo order`
          : `${r.askedBy ?? "The client"}, ${sourceWords(r.source).toLowerCase()}, ${etDateTime(r.askedAt)}`;
      // The client's own words in full, when the line is a summary of them.
      const said = !fromWrapUp && r.summary?.trim() && !norm(what).includes(norm(words)) ? { from: detail, text: words } : null;
      return {
        id: r.id, source: r.source, label, detail, words, numbers, fromWrapUp, holds: r.holdsDelivery, askedAtISO: r.askedAt.toISOString(),
        office, medium: r.medium, waitingOn: office ? "Waiting on Jordan or Kyle" : "Waiting on Kyle", doneLabel: office ? "Settled with the client" : "Done (fixed)", said,
      };
    });
}

/**
 * Done (fixed on the photos) or answered with a note, from the photo job.
 * Only an ask on this job's project. Done is Confirmed (checked on the
 * finished work); an answer is Not needed with the note (what the client was
 * told). Both release the hold and go on the job's activity.
 */
export async function settleClientAsked(input: { jobId: string; askId: string; how: "done" | "answered"; note?: string | null; by: string }): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.photoJob.findUnique({ where: { id: input.jobId }, select: { id: true, projectId: true } });
  if (!job) return { ok: false, message: "That photo job no longer exists." };
  const ask = await prisma.clientAsk.findUnique({ where: { id: input.askId }, select: { id: true, projectId: true, summary: true, text: true } });
  if (!ask || ask.projectId !== job.projectId) return { ok: false, message: "That request is not on this job. Reload the page." };
  const who = input.by.trim().slice(0, 120) || "staff";
  const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const { markConfirmed, markNotNeeded } = await import("@/lib/clientAsks");
  let r: { ok: boolean; message: string };
  if (input.how === "done") r = await markConfirmed(ask.id, who, note || "Fixed on the photos (Photo Delivery)");
  else {
    if (note.length < 5) return { ok: false, message: "Write the answer: what you told the client, or why it stays as it is." };
    r = await markNotNeeded(ask.id, who, note);
  }
  if (r.ok) await logJobEvent(job.id, who, `${input.how === "done" ? "request done" : "request answered"}: ${clip(ask.summary || ask.text, 160)}${note ? ` (${note})` : ""}`);
  return { ok: r.ok, message: r.ok ? (input.how === "done" ? "Marked done." : "Answered and set aside.") : r.message };
}

// ---- a finding the client asked about (Oct 21 2026, careRules.sharedLinkWords) ---------------

const TRASH_WORDS = "trash garbage bins cans trashcan recycling";
const CAR_WORDS = "cars truck trucks vehicle vehicles";
/** A few plain words per check: the words a client or a photographer would use for it. */
const RULE_WORDS: Record<string, string> = {
  EXT_CONSTRUCTION_MATERIALS: "construction forms wooden wood boards plywood lumber pallets dumpster debris sidewalk concrete building materials",
  EXT_LOOSE_GARBAGE_DEBRIS: `debris ${TRASH_WORDS}`,
  EXT_TRASH_CANS_PRIMARY: TRASH_WORDS,
  PREP_TRASH_CANS: TRASH_WORDS,
  KIT_GARBAGE_CANS: TRASH_WORDS,
  BATH_TRASH_CANS: TRASH_WORDS,
  UTIL_GARAGE_TRASH_CANS: TRASH_WORDS,
  LIV_OFFICE_TRASH_CANS: TRASH_WORDS,
  PREP_GARBAGE_BAGS_LOOSE_TRASH: TRASH_WORDS,
  EXT_PARKED_CARS_DRIVEWAY: CAR_WORDS,
  EXT_VEHICLES_BLOCKING_HOME: CAR_WORDS,
  EXT_VEHICLES_THROUGH_WINDOWS: CAR_WORDS,
  EXT_GARDEN_HOSES: "hose hoses",
};

export type AskLink = { askId: string; label: string; what: string };
const LINK_SOURCE: Record<string, string> = { order_note: "order note", text: "text", email: "email", call: "call", staff: "added by staff" };

/**
 * The open client-asked item each finding is about, by a plain word overlap
 * (the finding's check, what it saw and where, against the request's words):
 * "Client asked for this to be removed (order note)". Setting such a finding
 * aside needs the request answered first (decisions.decideFindings). `items`:
 * when the caller already read them.
 */
export async function findingAskLinks(
  projectId: string,
  findings: { id: string; ruleId: string; specificIssue: string; locationText?: string | null }[],
  items?: ClientAskedItem[],
): Promise<Map<string, AskLink>> {
  const out = new Map<string, AskLink>();
  if (!findings.length) return out;
  const open = items ?? (await clientAskedItems(projectId));
  if (!open.length) return out;
  const { ruleById } = await import("./registry");
  const { sharedLinkWords } = await import("./careRules");
  for (const f of findings) {
    const rule = ruleById(f.ruleId);
    const text = [rule?.shortLabel, rule?.checklistText, RULE_WORDS[f.ruleId], f.specificIssue, f.locationText].filter(Boolean).join(" ");
    const hit = open.find((it) => sharedLinkWords(it.words, text).length > 0);
    if (!hit) continue;
    out.set(f.id, {
      askId: hit.id,
      label: hit.fromWrapUp ? "The photographer's wrap-up asks for this to be removed" : `Client asked for this to be removed (${LINK_SOURCE[hit.source] ?? "client request"})`,
      what: clip(hit.words, 160),
    });
  }
  return out;
}

// ---- 3. after delivery -----------------------------------------------------------------------

/** The task the revision machinery keys a photo revision under (comms.runRevisionDetailed's photo lane: sha1 of "<projectId>|revision|photo"). */
export function photoRevisionTaskKey(projectId: string): string {
  return sha([projectId, "revision", "photo"].join("|"));
}

/** When the photos went out (the photo job's own delivery), or null. Pure. */
export function photosDeliveredAt(job: { stage: string; deliveredAt: Date | null; stageChangedAt?: Date | null } | null | undefined): Date | null {
  if (!job) return null;
  if (job.stage === "DELIVERED") return job.deliveredAt ?? job.stageChangedAt ?? null;
  if (["REVISION_REQUESTED", "DELIVERY_MISMATCH"].includes(job.stage)) return job.deliveredAt ?? null;
  return null;
}

/**
 * A photo request that came in AFTER the photos went out (the photo job's own
 * delivery, whatever the project's status says): the photo job reopens as
 * "Client asked for changes after delivery", and the work goes on the
 * delivery owner's list, assigned. The ask itself is filed by the caller
 * (comms, clientAsks.addAskByHand). Never throws.
 *
 * ONLY A PHOTO FIX REOPENS (Jordan, Oct 27 2026: "if it's in regard to
 * something other than photos, then it should not be reopened here. it should
 * be made a task on Kyle's dashboard"). The words are read first
 * (afterDeliveryAsk.judgeAfterDeliveryAsk: plain words, then the AI, unsure =
 * Kyle's task); office work goes on Kyle's list and the photo job stays
 * delivered. `trusted`: a person said it is about the photos (Add a request
 * by hand). `judged`: the caller already read it (comms).
 */
export async function photoAskAfterDelivery(input: {
  projectId: string; words: string; by: string; askedBy?: string | null; clientId?: string | null;
  trusted?: boolean; judged?: import("./afterDeliveryAsk").AfterDeliveryJudgement | null; askKey?: string | null;
}): Promise<{ jobId: string | null; reopened: boolean; taskId: string | null; routed?: "office" | "video" }> {
  const out: { jobId: string | null; reopened: boolean; taskId: string | null; routed?: "office" | "video" } = { jobId: null, reopened: false, taskId: null };
  try {
    const job = await prisma.photoJob.findUnique({ where: { projectId: input.projectId }, select: { id: true, stage: true, deliveredAt: true, stageChangedAt: true } });
    if (!job || !photosDeliveredAt(job)) return out;
    out.jobId = job.id;
    if (!input.trusted) {
      const A = await import("./afterDeliveryAsk");
      const judged = input.judged ?? (await A.judgeAfterDeliveryAsk(input.words));
      if (judged.kind !== "photo") {
        const r = await A.routeOfficeAsk({ projectId: input.projectId, jobId: job.id, words: input.words, kind: judged.kind, why: judged.why, askedBy: input.askedBy ?? null, clientId: input.clientId ?? null, askKey: input.askKey ?? null, by: "hub (request after delivery)" });
        out.taskId = r.taskId;
        out.routed = judged.kind;
        return out;
      }
    }
    const words = clip(scrubMoney(input.words.replace(/\s+/g, " ").trim()), 240);
    if (job.stage === "DELIVERED" || job.stage === "DELIVERY_MISMATCH") {
      // Oct 22 2026 (photo audit C1): looked at again now, on the open job's
      // pace, not at the delivered job's 6-hour check.
      out.reopened = await setStage(job.id, ["DELIVERED", "DELIVERY_MISMATCH"], "REVISION_REQUESTED", input.by.slice(0, 120) || "client", { why: `Client asked for changes after delivery: ${words}`, extra: { nextCheckAt: new Date() } });
    }
    out.taskId = await photoChangesTask({ projectId: input.projectId, jobId: job.id, words, askedBy: input.askedBy ?? null, clientId: input.clientId ?? null });
    return out;
  } catch (e) {
    console.error("[photo-delivery] reopening the photos for a client ask failed", input.projectId, e);
    return out;
  }
}

/**
 * The delivery owner's to-do for photos the client wants changed after they
 * went out: the photo revision task (one per job, photoRevisionTaskKey), open
 * and assigned to the delivery owner. A task someone reassigned by hand keeps
 * its person; the request is added to it, never written over it.
 */
async function photoChangesTask(input: { projectId: string; jobId: string; words: string; askedBy: string | null; clientId: string | null }): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { title: true, clientId: true } });
  if (!project) return null;
  const { kyleDesk } = await import("@/lib/kyleNotice");
  const desk = await kyleDesk();
  const key = photoRevisionTaskKey(input.projectId);
  const street = streetOf(project.title);
  const title = `Client asked for changes after delivery: ${street}`.slice(0, 120);
  const href = `/ops/photo-delivery/${input.jobId}`;
  const line = `${input.askedBy ?? "The client"}: "${input.words}"`;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true, status: true, description: true, assignedManually: true, ownerId: true, assignedKey: true } });
  const open = !!existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED";
  const assign = existing?.assignedManually && existing.assignedKey ? {} : { ownerId: desk?.id ?? existing?.ownerId ?? null, assignedKey: desk?.key ?? existing?.assignedKey ?? null };
  const summary = `The client asked for changes to photos already delivered: ${clip(input.words, 200)}. Open the photo job (${href}), fix them, mark each request Done, then deliver again.`.slice(0, 500);
  if (existing) {
    let description = existing.description ?? "";
    if (!open) description = line;
    else if (!description.includes(input.words.slice(0, 60))) description = `${description}\n\nNew request: ${line}`.trim();
    if (description.length > 4000) description = "…" + description.slice(-4000);
    await prisma.smartTask.update({ where: { id: existing.id }, data: { title, summary, description, status: "OPEN", completedAt: null, ...assign } });
    return existing.id;
  }
  const made = await prisma.smartTask
    .create({
      data: {
        taskType: "revision",
        title,
        summary,
        description: line,
        reasonCreated: "Client asked for changes to delivered photos",
        checklist: JSON.stringify(["Read the client's request", "Fix the photos on the photo job", "Mark each request Done (or answer it)", "Deliver again from Photo Delivery"]),
        source: "system",
        sourceDetail: href,
        priority: "HIGH",
        clientId: input.clientId ?? project.clientId,
        projectId: input.projectId,
        propertyAddress: project.title,
        dedupeKey: key,
        ownerId: desk?.id ?? null,
        assignedKey: desk?.key ?? null,
      },
      select: { id: true },
    })
    .catch(async () => (await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } })) ?? null);
  if (made) {
    await prisma.activity
      .create({ data: { projectId: input.projectId, type: "SYSTEM", body: clip(`Photos reopened: the client asked for changes after delivery. On ${desk?.name ?? "the delivery owner"}'s list.`, 300) } })
      .catch(() => {});
  }
  return made?.id ?? null;
}

// ---- the end of a revision (Oct 22 2026, photo audit C1 / H1) -------------------------------------

const HOW: Record<string, string> = { text: "by text", email: "by email", call: "on a call", portal: "on the portal", staff: "added by staff", order_note: "order note", aryeo: "on Aryeo" };

/**
 * WHAT THE CLIENT ASKED (Oct 27 2026, Jordan on 913 Lakeview: "what is the
 * request? Where is it? I don't see what the request is"): a reopened job's
 * open photo requests asked since the photos went out, in the client's words,
 * with who, how and when. When none is on file, the reopen's own words (the
 * stage move). Money scrubbed. [] when the job is not reopened.
 */
export async function revisionRequestsOf(job: { id: string; projectId: string; stage: string; deliveredAt: Date | null }): Promise<{ text: string; from: string; askId?: string }[]> {
  if (job.stage !== "REVISION_REQUESTED") return [];
  const since = job.deliveredAt ?? (await revisionStartOf(job.id));
  const rows = await prisma.clientAsk.findMany({
    where: { projectId: job.projectId, kind: "SPECIAL_REQUEST", state: "OPEN", OR: [{ medium: { in: ["photo", "both", "unclear"] } }, { medium: null }], ...(since ? { askedAt: { gte: new Date(since.getTime() - 60_000) } } : {}) },
    orderBy: { askedAt: "asc" },
    take: 10,
    select: { id: true, text: true, source: true, askedBy: true, askedAt: true },
  });
  const words = (s: string) => clip(scrubMoney(s.replace(/\s+/g, " ").trim()), 400);
  if (rows.length) return rows.map((r) => ({ text: words(r.text), from: [r.askedBy ?? "The client", HOW[r.source] ?? r.source, etDateTime(r.askedAt)].filter(Boolean).join(", "), askId: r.id }));
  const e = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: { contains: "→ REVISION_REQUESTED" } }, orderBy: { at: "desc" }, select: { action: true, actor: true, at: true } });
  const said = e?.action.match(/Client asked for changes after delivery: (.+)$/)?.[1];
  return said && e ? [{ text: words(said), from: `${e.actor}, ${etDateTime(e.at)}` }] : [];
}

/** When the client's latest revision of the photos began (the job's last move into REVISION_REQUESTED), or null. */
export async function revisionStartOf(jobId: string): Promise<Date | null> {
  const e = await prisma.photoJobEvent.findFirst({ where: { jobId, action: { contains: "→ REVISION_REQUESTED" } }, orderBy: { at: "desc" }, select: { at: true } });
  return e?.at ?? null;
}

/**
 * The photo revision's to-do (photoRevisionTaskKey) closes from the PHOTO
 * side only (photo audit H1): when the photos are delivered again, or a
 * person settles the revision with the client. comms.resolveRevision (the
 * video side) leaves it alone. When it was the job's last open revision, the
 * job lands where it stands (comms.resolveRevisionForTask). Never throws.
 */
export async function closePhotoRevisionTask(projectId: string, why: string): Promise<boolean> {
  try {
    const t = await prisma.smartTask.findUnique({ where: { dedupeKey: photoRevisionTaskKey(projectId) }, select: { id: true, status: true, summary: true } });
    if (!t || t.status === "COMPLETED" || t.status === "CANCELLED") return false;
    const r = await prisma.smartTask.updateMany({ where: { id: t.id, status: t.status }, data: { status: "COMPLETED", completedAt: new Date(), summary: clip(`Done: ${why}. ${t.summary ?? ""}`.trim(), 500) } });
    if (!r.count) return false;
    const { resolveRevisionForTask } = await import("@/lib/comms");
    await resolveRevisionForTask(t.id, projectId, "resolved").catch((e) => console.warn("[photo-delivery] landing the job after the photo revision failed", projectId, (e as Error).message));
    return true;
  } catch (e) {
    console.error("[photo-delivery] closing the photo revision to-do failed", projectId, e);
    return false;
  }
}

/** The job event "Settled with the client: nothing to resend" writes (and the stage move's reason). */
export const SETTLED_ACTION = "settled with the client: nothing to resend";

/**
 * SETTLED WITH THE CLIENT: NOTHING TO RESEND (Oct 22 2026, photo audit C1).
 * The third way out of a client's photo revision, beside Approve and deliver
 * again and Mark as delivering: the office talked it through with the client
 * and nothing goes out again (the client withdrew it, it was answered, the
 * photos stay as they are). Only with a typed reason. The photo requests the
 * client made in this revision (photo only, asked since the photos first went
 * out) are answered with that reason (Not needed, each with its note); the job
 * goes back to Delivered with its first delivery date; the photo revision's
 * to-do closes. A request about the video too is left as it is.
 */
export async function settleRevisionNoResend(input: { jobId: string; reason: string; by: string }): Promise<{ ok: boolean; message: string }> {
  const { SETTLED_REASON_MIN } = await import("./holding");
  const why = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (why.length < SETTLED_REASON_MIN) return { ok: false, message: `Write what was settled with the client, and why nothing goes out again (at least ${SETTLED_REASON_MIN} characters).` };
  const job = await prisma.photoJob.findUnique({ where: { id: input.jobId }, select: { id: true, projectId: true, stage: true, deliveredAt: true } });
  if (!job) return { ok: false, message: "That photo job no longer exists." };
  const inRevision = job.stage === "REVISION_REQUESTED" || (!!job.deliveredAt && ["QC_REVIEW", "READY"].includes(job.stage));
  if (!inRevision) return { ok: false, message: "Only photos reopened for the client's changes can be settled this way. Reload the page." };
  const who = input.by.trim().slice(0, 120) || "staff";
  // Asked since the photos first went out (the request is filed a moment before it reopens the job).
  const since = job.deliveredAt ?? (await revisionStartOf(job.id));
  const asks = await prisma.clientAsk.findMany({
    where: { projectId: job.projectId, state: "OPEN", kind: "SPECIAL_REQUEST", medium: "photo", ...(since ? { askedAt: { gte: since } } : {}) },
    select: { id: true },
  });
  const moved = await setStage(job.id, ["REVISION_REQUESTED", "QC_REVIEW", "READY"], "DELIVERED", who, { why: `${SETTLED_ACTION}: ${why}`, extra: { nextCheckAt: new Date(Date.now() + 6 * 3_600_000) } });
  if (!moved) return { ok: false, message: "This job moved on in the meantime. Reload the page." };
  const { markNotNeeded } = await import("@/lib/clientAsks");
  let answered = 0;
  for (const a of asks) if ((await markNotNeeded(a.id, who, `Settled with the client, nothing to resend: ${why}`)).ok) answered++;
  await logJobEvent(job.id, who, `${SETTLED_ACTION}: ${why}`, { settled: true, reason: why, answered });
  await closePhotoRevisionTask(job.projectId, `settled with the client by ${who}: ${why}`);
  await prisma.activity
    .create({ data: { projectId: job.projectId, type: "SYSTEM", body: clip(`Photo revision settled with the client by ${who}, nothing to resend: ${why}${answered ? ` (${answered} photo request${answered === 1 ? "" : "s"} answered with this)` : ""}`, 600) } })
    .catch(() => {});
  return { ok: true, message: `Settled. The photos stay as delivered${answered ? `, and ${answered} request${answered === 1 ? " is" : "s are"} answered with your note` : ""}.` };
}

// ---- the approve summary ---------------------------------------------------------------------

/**
 * "You're delivering with 6 exterior issues ignored (construction materials
 * ×4, trash cans ×2)": what a PERSON set aside (ignored or overridden) that
 * needs their own words (careRules.needsOwnWords), on photos going out.
 * Never the hub's own set-asides (the prep gate, the second look), a check
 * Jordan switched off for every shoot, or a photo left out. Null when none.
 */
export async function ignoredCarefulSummary(jobId: string): Promise<string | null> {
  const [rows, photos] = await Promise.all([
    prisma.photoQcFinding.findMany({
      where: { jobId, status: { in: ["IGNORED", "OVERRIDDEN"] }, source: { not: "ADDON" } },
      select: { id: true, ruleId: true, severity: true, photoId: true, decidedBy: true, statusReason: true },
    }),
    prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, select: { id: true } }),
  ]);
  if (!rows.length) return null;
  const active = new Set(photos.map((p) => p.id));
  const { gatedBy } = await import("./prep");
  const { EXCLUDED_REASON_PREFIX, needingOwnWords } = await import("./decisions");
  const byPerson = rows.filter(
    (f) =>
      (!f.photoId || active.has(f.photoId)) &&
      !gatedBy(f.decidedBy) &&
      !/^(hub\b|auto-|free second look)/i.test(f.decidedBy ?? "") &&
      !(f.statusReason ?? "").startsWith(EXCLUDED_REASON_PREFIX) &&
      !(f.statusReason ?? "").startsWith("Not checked any more"),
  );
  const careful = await needingOwnWords(byPerson);
  if (!careful.length) return null;
  const [{ alwaysKind }, { ruleById, isExteriorFinding }] = await Promise.all([import("./fixPolicy"), import("./registry")]);
  const roomRows = await prisma.photoAsset.findMany({ where: { id: { in: careful.map((f) => f.photoId).filter((x): x is string => !!x) } }, select: { id: true, roomType: true } });
  const roomOf = new Map(roomRows.map((p) => [p.id, p.roomType]));
  const groups = new Map<string, IgnoredGroup>();
  for (const f of careful) {
    const label = alwaysKind(f.ruleId) ?? (ruleById(f.ruleId)?.shortLabel ?? f.ruleId).toLowerCase();
    const outside = isExteriorFinding(f.ruleId, f.photoId ? roomOf.get(f.photoId) : null);
    const g = groups.get(label) ?? { label, n: 0, exterior: true };
    g.n++;
    g.exterior = g.exterior && outside;
    groups.set(label, g);
  }
  return ignoredSummaryLine([...groups.values()]);
}

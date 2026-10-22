// ---------------------------------------------------------------------------
// WAITING ON A SECOND SHOOT (Oct 22 2026). Jordan, about Sharra Mercer's
// 34 Oakland Rd (3 Premium Social Media Reels plus the Social Influencer
// package's reel, so 4 videos): "there are 4 videos, but one of the videos is
// only half shot and will need a second appointment for it. So what do we do
// in that case?"
//
// The answer: that ONE video is set up like the others, and marked "Waiting on
// a second shoot". While it waits it is nobody's work yet:
//   · it is in no editor's queue, and no auto-assign or "Ready for editing"
//     ping is raised for it;
//   · it has no due date, so it is never late, never at risk and never in the
//     behind alert;
//   · it does not hold up the job: the other videos are edited, approved,
//     sent and the job delivered without it;
//   · the KPI's late-upload and thin-instructions checks leave it alone;
//   · it still counts as set up ("4 videos ordered, 4 set up").
// It is released when a LATER appointment on the job uploads video footage
// (the photo split-job rule, Oct 21-22: "split jobs should be treated as a
// normal SLA for each appointment and depend on what was uploaded to Dropbox /
// submitted in the upload portal"), or by the office's "Release to the
// editor". Either way its own clock starts from that shoot, on its own tier's
// turnaround, and it goes to the editor like any other video.
//
// WHERE IT LIVES (additive, no new column). The per-video row
// (DeliverableOutput) already carries one JSON field, `briefJson`, the video's
// own brief. The hold rides in it under its own top-level key, `secondShoot`,
// beside the brief's `version`/`sections` (which readOutputBrief reads and
// saveOutputBrief now carries the key across). Released holds stay as history
// with `releasedAt` set; only an unreleased one is "waiting".
//
// This file is pure and safe in the browser. The reads and writes are in
// lib/secondShoot.ts.
// ---------------------------------------------------------------------------

export const SECOND_SHOOT_KEY = "secondShoot";
/** Cheap pre-filter for a findMany: rows whose JSON mentions the key at all. */
export const SECOND_SHOOT_MARK = `"${SECOND_SHOOT_KEY}"`;
/** The promiseSource a released video's own clock is stamped with. */
export const SECOND_SHOOT_PROMISE_SOURCE = "second-shoot";
export const WAITING_WORDS = "Waiting on a second shoot";
export const NOTE_CAP = 300;

export type SecondShootHold = {
  /** who marked it waiting */
  by: string;
  /** when (ISO) */
  at: string;
  /** "Half shot; needs a second appointment (Jordan, Oct 22)" */
  note: string | null;
  /** the second appointment, once known (ISO) */
  expectedAt: string | null;
  /** the visit that was half shot (ISO): only a visit on a later ET day releases it */
  afterVisitAt: string | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
  /** "upload": a later appointment's footage came in; "office": the office's button */
  releasedHow?: "upload" | "office" | null;
  /** the shoot its own clock runs from (ISO) */
  clockFrom?: string | null;
};

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The hold stored on a video's row, or null (unreadable JSON is no hold). */
export function readSecondShoot(json: string | null | undefined): SecondShootHold | null {
  if (!json || !json.includes(SECOND_SHOOT_MARK)) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const h = o?.[SECOND_SHOOT_KEY] as Record<string, unknown> | undefined;
    if (!h || typeof h !== "object") return null;
    const at = iso(h.at);
    if (!at) return null;
    const how = h.releasedHow === "upload" || h.releasedHow === "office" ? h.releasedHow : null;
    return {
      by: typeof h.by === "string" && h.by.trim() ? h.by.trim() : "the office",
      at,
      note: typeof h.note === "string" && h.note.trim() ? h.note.trim().slice(0, NOTE_CAP) : null,
      expectedAt: iso(h.expectedAt),
      afterVisitAt: iso(h.afterVisitAt),
      releasedAt: iso(h.releasedAt),
      releasedBy: typeof h.releasedBy === "string" && h.releasedBy.trim() ? h.releasedBy.trim() : null,
      releasedHow: how,
      clockFrom: iso(h.clockFrom),
    };
  } catch {
    return null;
  }
}

/** Is this video waiting on a second shoot right now? */
export function isWaitingHold(h: SecondShootHold | null | undefined): h is SecondShootHold {
  return !!h && !h.releasedAt;
}

/** Straight from the stored JSON. */
export function isWaitingJson(json: string | null | undefined): boolean {
  return isWaitingHold(readSecondShoot(json));
}

/**
 * The row's JSON with the hold set (or removed with null), every other key
 * (the video's brief) kept exactly as it was. Null when nothing is left.
 */
export function withSecondShoot(json: string | null | undefined, hold: SecondShootHold | null): string | null {
  let o: Record<string, unknown> = {};
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) o = parsed as Record<string, unknown>;
    } catch { /* an unreadable brief is not ours to keep: readOutputBrief already reads it as none */ }
  }
  if (hold) o[SECOND_SHOOT_KEY] = hold;
  else delete o[SECOND_SHOOT_KEY];
  return Object.keys(o).length ? JSON.stringify(o) : null;
}

/** The plain words everywhere a waiting video appears (no em dashes). */
export function waitingLine(h: Pick<SecondShootHold, "note" | "expectedAt">, opts: { expectedWords?: (iso: string) => string } = {}): string {
  const note = h.note ? `: ${h.note.replace(/[.\s]+$/, "")}` : "";
  const exp = h.expectedAt && opts.expectedWords ? ` (second appointment ${opts.expectedWords(h.expectedAt)})` : "";
  return `${WAITING_WORDS}${note}${exp}`;
}

const EM_DASH = new RegExp(`\\s*${String.fromCharCode(0x2014)}\\s*`, "g");
const EN_DASH = new RegExp(String.fromCharCode(0x2013), "g");

/** A slot's name without the em dash the slot list puts in it ("Premium Social Reel, Video 3 of 3"). */
export function plainLabel(label: string): string {
  return label.replace(EM_DASH, ", ").replace(EN_DASH, "-");
}

/** The ET calendar day a moment falls on, as its midnight, from the caller's helper. */
type DayStart = (d: Date) => Date;

/** A live visit that has happened, by the photo split-job code's rule (cancelled ones never count). */
export function startedVisits(appointments: { startAt: Date | null; status: string | null }[], now: Date): Date[] {
  return appointments
    .filter((a) => a.startAt && a.startAt.getTime() <= now.getTime() && !/cancel/i.test(a.status ?? ""))
    .map((a) => a.startAt!)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The visits that came AFTER the half-shot one: a started visit on a later ET
 * day than `afterVisitAt` (any started visit when the hold has none). Pure.
 */
export function laterVisits(input: { appointments: { startAt: Date | null; status: string | null }[]; afterVisitAt: Date | null; now: Date; dayStart: DayStart }): Date[] {
  const after = input.afterVisitAt ? input.dayStart(input.afterVisitAt).getTime() : null;
  return startedVisits(input.appointments, input.now).filter((v) => after == null || input.dayStart(v).getTime() > after);
}

/**
 * THE SHOOT A WAITING VIDEO'S CLOCK STARTS FROM, by the photo split-job rule
 * (photoDelivery/jobs.photoVisitFor): the latest LATER visit that has started
 * AND has video footage uploaded on or after its ET day (its upload floor,
 * intake.uploadFloorFor). A later visit that uploaded no video (a photo-only
 * return) leaves the video waiting. Null when no later visit qualifies. Pure.
 */
export function secondShootVisitFor(input: {
  appointments: { startAt: Date | null; status: string | null }[];
  afterVisitAt: Date | null;
  /** when video footage reached the hub: upload-page submits and ticks, Dropbox files */
  uploads: Date[];
  now: Date;
  dayStart: DayStart;
}): Date | null {
  const later = laterVisits(input);
  for (let i = later.length - 1; i >= 0; i--) {
    const floor = input.dayStart(later[i]).getTime();
    if (input.uploads.some((u) => u.getTime() >= floor && u.getTime() <= input.now.getTime())) return later[i];
  }
  return null;
}

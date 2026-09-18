// ---------------------------------------------------------------------------
// WHAT A SECOND SHOOT DAY IS WORTH (Jordan, Sep 18 2026) — written down here
// because the next person to read this file will wonder why nothing pays.
//
// His rule: "photographer does not get paid for a second shoot day unless
// explicitly stated" — either by Aryeo, an appointment, or an order.
//
// Which collapses to one sentence: PAY FOLLOWS ARYEO. An appointment or an
// order, both of which arrive from there. Nothing the hub records on its own
// side is a reason to pay anybody for a day.
//
// The engine already keeps it, and keeps it without knowing this feature
// exists. Payroll is APPOINTMENT-centric (lib/payroll.ts): the earliest
// appointment is the primary shoot and pays a percentage of the invoice; a
// later one on a DIFFERENT ET day pays a return trip at that person's flat
// rate, and payroll.ts is explicit that this covers "the same shooter on
// another day", not only a second shooter. 29 jobs in production already have
// one person shooting on two days. A second ORDER is its own Project with its
// own appointment, so it pays as an ordinary job.
//
// Filing an extra shoot HERE is neither. It creates a Deliverable and a cut
// slot — work owed — and no Appointment and no order, so it pays nothing. That
// is the rule, and it is said to the photographer before they file (see
// AdditionalShoot.tsx) and to the office on Kyle's card.
//
// ONE THING TO KNOW BEFORE ANYBODY "FIXES" THIS. Primary pay is a LIVE
// percentage of Project.payableInvoice, re-read on every payroll render, and
// per-shoot pay has no frozen snapshot (PayrollEntry covers monthly and hourly
// staff only). So a line added to an EXISTING order after the shoot raises the
// FIRST shooter's pay for the FIRST day, by 30-40% of the line depending on the
// person. That is why Kyle's card asks for the extra reel as its own line and
// not a quantity bump. It is a question for Jordan, not something this file
// should decide.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "HE SHOT IT AGAIN" — a second video on a job that already delivered.
//
// Jordan, Sep 18 2026: "204 Spring Ln for Mike Flatley, he ended up doing a
// second reel for that listing and it was shot on a separate day. So the
// photographer should be able to go back into the upload portal and re open the
// upload portal for that job and be able to add another project."
//
// WHY THIS IS A ROW ON THE SAME JOB AND NOT A NEW JOB. Measured Sep 18 on the
// live database: 82 times a shoot has happened at an address after that
// address's earlier job was already delivered, and all 82 of them are a second
// Aryeo order and a second Project — because Kyle wrote the order first. That
// is the office's path and it still is: every one of those was billed.
//
// What has never existed is the path the PHOTOGRAPHER is standing in, which is
// the one to three days between filming the extra reel and Kyle writing the
// order. In that window there is no order, so there is no project, so the
// portal has nowhere to put the footage — and `prisma.project.create` lives in
// exactly one place in this codebase (the Aryeo import, keyed on
// aryeoOrderId). A second row minted here with no order id would be adopted by
// nothing: the moment Kyle wrote the real order the import would create its OWN
// third row for the same listing and the raws would sit on the orphan.
//
// So the extra video is an extra DELIVERABLE on the job that already exists:
//   · `manual: true` — the Aryeo reconcile skips manual rows outright
//     (integrations/aryeo.ts: `if (r.manual || …) continue`), so nothing the
//     order says can retire, relabel or re-quantity it;
//   · `capturedAt` — the schema's own words for "the photographer ticked this
//     off on site", holding the day the extra footage was actually shot. The
//     job's own shootDate is NOT touched: it anchors the promise, the on-time
//     dial and the payroll day for the FIRST shoot, and rewriting it would
//     rewrite all three;
//   · its own DeliverableOutput slot, its own requiredFrom, its own place in
//     the Editing Room — a thing with an owner, not a note.
//
// AND THE FIRST DELIVERY IS NOT TOUCHED. Note what this deliberately does NOT
// do: it never raises the existing video row's `quantity`. cutSlots labels a
// multi-slot row "— Video 1 of 2", so a quantity bump would rename the video
// the client already has and make a finished job read half-done. A new row
// leaves every existing slot, label, verdict and sent stamp exactly as it was.
// ---------------------------------------------------------------------------

/** The two video shapes a photographer can come back and add. Both are types
 *  `reviewCuts.cutSlots` already counts, so an extra shoot of either mints a
 *  real cut slot; anything else (photos, a floor plan) is an order change with
 *  no footage to upload and belongs in "Added at the shoot". */
export const ADDITIONAL_VIDEO_TYPES = ["SOCIAL_REEL", "VIDEO"] as const;
export type AdditionalVideoType = (typeof ADDITIONAL_VIDEO_TYPES)[number];

export const ADDITIONAL_VIDEO_WORD: Record<AdditionalVideoType, string> = {
  SOCIAL_REEL: "Reel",
  VIDEO: "Video",
};

/** What the photographer picks between, in their words rather than ours. */
export const ADDITIONAL_VIDEO_CHOICE: Record<AdditionalVideoType, string> = {
  SOCIAL_REEL: "Reel (vertical)",
  VIDEO: "Video (horizontal)",
};

export const isAdditionalVideoType = (s: string): s is AdditionalVideoType =>
  (ADDITIONAL_VIDEO_TYPES as readonly string[]).includes(s);

/**
 * The in-memory twin of `uploadHistory.ADDITIONAL_SHOOT_WHERE` — the same four
 * facts, for a row already loaded rather than a Prisma filter. Kept here, beside
 * the words that mint the row, so the readers that hold rows (the /shoot
 * checklist, the capture toggle's guard) and the readers that hold queries can
 * never disagree about what an extra shoot IS.
 *
 * `capturedAt` is the whole identity, which is why it has a guard of its own:
 * see setDeliverableCaptured in app/shoot/actions.ts.
 */
export const isAdditionalShootRow = (d: {
  type: string;
  manual: boolean;
  capturedAt: Date | null;
  removedFromOrderAt?: Date | null;
}): boolean => d.manual && d.capturedAt != null && !d.removedFromOrderAt && isAdditionalVideoType(d.type);

/** "2026-09-18" → "Sep 18". Plain string arithmetic on the ET calendar day the
 *  photographer typed — never `new Date(dayKey)`, which parses as UTC and
 *  reads back as the day before for anyone east of Greenwich. */
export function shootDayWords(dayKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/**
 * The deliverable's label. It has to survive three readers that all parse
 * labels: `videoTier` (PREMIUM_VIDEO_RE — "premium|influencer|cinematic|…"),
 * `videoStepSpec` and `videoStyleFor`. None of these words trips any of them,
 * so an extra shoot cannot silently promote a standard job to premium and
 * start demanding a premium script on the portal.
 */
export const additionalShootLabel = (type: AdditionalVideoType, dayKey: string) =>
  `${ADDITIONAL_VIDEO_WORD[type]} — extra shoot ${shootDayWords(dayKey)}`;

/**
 * The item name Kyle's "Add to the order" card carries, which is also what
 * `shootAddOns.shootAddonKey()` slugifies into that card's dedupe key. Two
 * things depend on the exact words:
 *   · the DATE keeps the key unique, so a third shoot on the same listing is a
 *     third card and not a silent overwrite of the second;
 *   · "reel" / "video" are the words `addonSlugNamesType` matches for
 *     SOCIAL_REEL / VIDEO, so the card closes ITSELF the moment the line
 *     appears on the Aryeo order — the same auto-close every other add-on gets.
 */
export const additionalShootItem = (type: AdditionalVideoType, dayKey: string) =>
  `Extra ${ADDITIONAL_VIDEO_WORD[type].toLowerCase()} shot ${shootDayWords(dayKey)}`;

/** One extra shoot as the portal card reads it back. */
export type AdditionalShoot = {
  /** the Deliverable row id — what the withdraw action takes */
  id: string;
  type: AdditionalVideoType;
  label: string;
  /** the day it was shot (UTC instant landing at noon on that ET day) */
  shotOnISO: string;
  /** the photographer ticked the raws in on the checklist */
  uploadedISO: string | null;
  addedBy: string | null;
  addedAtISO: string;
  /** any cut, upload or note already hangs off this row — it can no longer be
   *  withdrawn from here, because withdrawing it would orphan real work. */
  hasWork: boolean;
};

/** The one sentence the timeline, the task and the card all say, so the three
 *  can never drift into describing different work. */
export const additionalShootSentence = (
  type: AdditionalVideoType,
  dayKey: string,
  who: string,
  street: string,
) =>
  `${who} shot an extra ${ADDITIONAL_VIDEO_WORD[type].toLowerCase()} for ${street} on ${shootDayWords(dayKey)}, on a separate day from the original shoot.`;

// Shared (client-safe) helpers for reading the smart-status evidence blob that
// the status engine writes to Project.statusEvidence. Keep this free of any
// server-only imports so cards/components can use it directly.

export type ParsedEvidence = {
  expected: string[];
  present: string[];
  missing: string[];
  partial: boolean;
  aryeo: {
    photos: number;
    videos: number;
    floorPlans: number;
    interactive: number;
    delivery: string | null;
    /** ISO time of the listing read these counts came from */
    at?: string;
    /** last-known-good counts carried forward because this pass couldn't read Aryeo */
    stale?: boolean;
    /** why the latest listing read failed, when stale */
    readError?: string;
  } | null;
  dropbox: {
    rawPhotos: number;
    rawVideo: number;
    finalPhotos: number;
    finalVideo: number;
    /** ISO time of the read these counts came from */
    at?: string;
    /** last-known-good counts carried forward because this pass couldn't read Dropbox */
    stale?: boolean;
    /** why the latest read failed, when stale (e.g. too_many_requests) */
    readError?: string;
  } | null;
  fulfilledOnAryeo: boolean;
  reason: string;
  checkedAt: string;
  videoTier: "standard" | "premium" | null;
  videoDue: string | null;
  videoOverdue: boolean;
};

export function parseEvidence(raw: string | null | undefined): ParsedEvidence | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<ParsedEvidence>;
    return {
      expected: e.expected ?? [],
      present: e.present ?? [],
      missing: e.missing ?? [],
      partial: e.partial ?? false,
      aryeo: e.aryeo ?? null,
      dropbox: e.dropbox ?? null,
      fulfilledOnAryeo: e.fulfilledOnAryeo ?? false,
      reason: e.reason ?? "",
      checkedAt: e.checkedAt ?? "",
      videoTier: e.videoTier ?? null,
      videoDue: e.videoDue ?? null,
      videoOverdue: e.videoOverdue ?? false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HOW FRESH IS THE EVIDENCE? (RTP-06/RTP-16, Sep 16 audit)
//
// "We could not look" and "we looked and saw nothing" are different facts, and
// a card that renders them the same way turns a Dropbox 429 into a confident
// red "nothing yet". Project.evidenceAttemptedAt / evidenceSucceededAt /
// evidenceError are the authority once the status engine writes them; until
// then this falls back to what the blob itself already carries (the per-source
// `stale` flags and `checkedAt`). Read every input defensively — on a job the
// new columns have never been written to they are all null, and that must mean
// "use the blob", never "the read failed".
// ---------------------------------------------------------------------------

/** Past this, a "last good read" is history, not a current fact. The sweep is
 *  hourly, so a full day of silence means nobody has looked (an ON_HOLD job is
 *  skipped by the sweep entirely — 56 Hillview's last check was Aug 17). */
export const EVIDENCE_STALE_HOURS = 24;
/** Inside this much of the promise a job is "at risk", not yet late. */
export const AT_RISK_HOURS = 24;

const ET = "America/New_York";
const HOUR = 3_600_000;

function asDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** ET, always (UI convention): "Sep 18" / "Sep 18, 5:00 PM". */
export function etStamp(d: Date, withTime = false): string {
  return d.toLocaleString("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export type EvidenceFreshness = {
  /** false = an empty count here proves nothing. */
  known: boolean;
  reason: "ok" | "failed" | "stale" | "never";
  /** the most recent read we know actually succeeded */
  at: Date | null;
  /** why the latest read failed, when we know */
  error: string | null;
  /** which source went dark, when we know ("Dropbox" / "Aryeo") */
  source: string | null;
};

export function evidenceFreshness(input: {
  evidence?: ParsedEvidence | null;
  /** Project.evidenceAttemptedAt — may be null (the columns are new). */
  attemptedAt?: Date | string | null;
  /** Project.evidenceSucceededAt */
  succeededAt?: Date | string | null;
  /** Project.evidenceError */
  error?: string | null;
  /** Project.statusCheckedAt — stamped even when the read failed, so it is the
   *  weakest witness of the three and is only used as a last resort. */
  checkedAt?: Date | string | null;
  now?: Date;
}): EvidenceFreshness {
  const now = input.now ?? new Date();
  const e = input.evidence ?? null;
  const attempted = asDate(input.attemptedAt);
  const succeeded = asDate(input.succeededAt);
  const blobAt = asDate(e?.checkedAt);
  const lastGood = succeeded ?? blobAt ?? asDate(input.checkedAt);

  if (input.error) {
    return { known: false, reason: "failed", at: succeeded ?? blobAt, error: input.error, source: null };
  }
  // A pass that started and never succeeded: the blob you are reading is the
  // one from before it. 60s of slack so a write ordering quirk isn't an alarm.
  if (attempted && (!succeeded || attempted.getTime() > succeeded.getTime() + 60_000)) {
    return { known: false, reason: "failed", at: succeeded ?? blobAt, error: null, source: null };
  }
  if (e?.dropbox?.stale) {
    return { known: false, reason: "stale", at: asDate(e.dropbox.at) ?? lastGood, error: e.dropbox.readError ?? null, source: "Dropbox" };
  }
  if (e?.aryeo?.stale) {
    return { known: false, reason: "stale", at: asDate(e.aryeo.at) ?? lastGood, error: e.aryeo.readError ?? null, source: "Aryeo" };
  }
  if (!e) {
    return { known: false, reason: "never", at: lastGood, error: null, source: null };
  }
  if (!lastGood) return { known: false, reason: "never", at: null, error: null, source: null };
  if (now.getTime() - lastGood.getTime() > EVIDENCE_STALE_HOURS * HOUR) {
    return { known: false, reason: "stale", at: lastGood, error: null, source: null };
  }
  return { known: true, reason: "ok", at: lastGood, error: null, source: null };
}

// ---------------------------------------------------------------------------
// THE FOUR TONES (RTP-16, Sep 16 audit). Colour follows the PROMISE, not the
// mere existence of an unfinished item:
//
//   awaiting    neutral — owed, nothing late (27 of the 35 red cards were
//               BOOKED/SCHEDULED jobs that had not been shot yet)
//   at_risk     amber   — due inside the buffer, or Aryeo says fulfilled while
//               the cross-check still can't see a piece
//   overdue     red     — past the promise
//   unknown     grey    — the read failed or is stale; a stale zero is NOT
//               "nothing delivered" and a stale count is NOT a new delivery
//
// plus the two settled ends: `clear` (nothing outstanding) and `unconfirmed`
// (the office delivered it and the hub simply can't see a piece — Sep 16).
//
// ONE rule, in one place: the card, the chips and statusFlag() all read this,
// so the project page and the queue can never disagree about what is late.
// The promise itself comes from the evidence blob's videoDue (which already
// carries the office's override — projectStatus.ts rewrites it) or from a
// caller that knows a better one. When RTP-05 lands its single promise engine,
// pass its answer in as `dueAt` and every tone moves with it.
// ---------------------------------------------------------------------------

export type EvidenceToneKind = "clear" | "awaiting" | "at_risk" | "overdue" | "unknown" | "unconfirmed";

export type EvidenceTone = {
  kind: EvidenceToneKind;
  /** the one line a reader should take away */
  headline: string;
  /** the supporting sentence, same voice */
  detail: string | null;
  /** the promise this verdict is keyed on; null = nothing has a clock yet */
  promiseAt: Date | null;
  /** WHAT that promise is for. Without it a caller can only guess, and
   *  statusFlag() guessed `missing[0]` — so a job missing Photos and Video got
   *  "Photos due <the video's date>" (review, Sep 16). */
  promiseFor: string | null;
  /** what is still owed, in the engine's own category words */
  missing: string[];
  freshness: EvidenceFreshness;
};

const listWords = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function evidenceTone(input: {
  status: string;
  evidence: ParsedEvidence | null;
  shootDate?: Date | null;
  /** a promise the caller trusts more than the blob's videoDue */
  dueAt?: Date | null;
  /** what that promise is for ("Photos", "Premium Social Media Reel") */
  dueFor?: string | null;
  /** The caller ran the promise engine and `dueAt` is its whole answer — a
   *  null here means "this job genuinely has no clock", not "I didn't look".
   *  Without it the blob's videoDue would sneak back in and re-date a reopened
   *  job against the promise it already kept (review, Sep 16). */
  promiseResolved?: boolean;
  attemptedAt?: Date | string | null;
  succeededAt?: Date | string | null;
  error?: string | null;
  checkedAt?: Date | string | null;
  now?: Date;
}): EvidenceTone {
  const now = input.now ?? new Date();
  const e = input.evidence;
  const freshness = evidenceFreshness({
    evidence: e,
    attemptedAt: input.attemptedAt,
    succeededAt: input.succeededAt,
    error: input.error,
    checkedAt: input.checkedAt,
    now,
  });
  const missing = e?.missing ?? [];
  const owed = listWords(missing);
  const base = { promiseAt: null as Date | null, promiseFor: null as string | null, missing, freshness };

  // WHY it isn't known, said accurately (review, Sep 16). "The last check
  // failed" and "nothing has looked since Sep 1" are different facts, and the
  // copy asserted the first for both — on 56 Hillview, a held job the hourly
  // sweep skips entirely, no check had failed; none had been attempted.
  const whyNotKnown = () => {
    if (freshness.error) return `${freshness.source ?? "The cross-check"} couldn't be read (${freshness.error})`;
    if (freshness.source) return `${freshness.source} couldn't be read on the latest check`;
    if (freshness.reason === "failed") return "The last cross-check didn't complete";
    if (freshness.reason === "never") return "No cross-check has completed on this job";
    return "Nothing has re-checked this job since then";
  };
  const notCheckedLine = () =>
    `${whyNotKnown()} — the counts below are the last good read, so an empty one is not proof the work is missing.`;

  if (!e) {
    return {
      ...base,
      kind: "unknown",
      headline: freshness.at ? `Not checked since ${etStamp(freshness.at, true)} ET` : "Never cross-checked",
      detail: notCheckedLine(),
    };
  }

  if (missing.length === 0) {
    return {
      ...base,
      kind: "clear",
      headline: "Everything ordered is confirmed.",
      // A stale POSITIVE is still not today's fact — say so rather than let a
      // carried-forward count read as a fresh delivery.
      detail: freshness.known
        ? null
        : `Last confirmed ${freshness.at ? `${etStamp(freshness.at, true)} ET` : "an unknown time ago"}. ${whyNotKnown()}, so this is the last good read.`,
    };
  }

  // The office has told the client the work is out (Sep 16, Kyle call): the
  // missing list is "the hub can't confirm this piece", never an accusation.
  if (input.status === "DELIVERED") {
    return {
      ...base,
      kind: "unconfirmed",
      headline: `Delivered — ${missing.length === 1 ? "one item is" : `${missing.length} items are`} unconfirmed by the hub`,
      detail: `${owed}: usually a listing the hub isn't linked to, or a vendor piece that never synced to Aryeo. Nothing here changes the delivery.`,
    };
  }

  // Not shot yet: nothing is late, whatever the list says.
  const shoot = input.shootDate ?? null;
  const preShoot = input.status === "BOOKED" || input.status === "SCHEDULED" || (!!shoot && shoot > now);
  if (preShoot) {
    return {
      ...base,
      kind: "awaiting",
      headline: "Awaiting production",
      detail: `${owed} still to come${shoot ? ` — the shoot is ${etStamp(shoot, true)} ET` : " — no shoot date yet"}. Nothing is late.`,
    };
  }

  // "We could not look" outranks every verdict below: a stale zero must never
  // be reported as an overdue delivery, nor as a calm one.
  if (!freshness.known) {
    return {
      ...base,
      kind: "unknown",
      headline: freshness.at ? `Not checked since ${etStamp(freshness.at, true)} ET` : "Never cross-checked",
      detail: `${owed} unconfirmed. ${notCheckedLine()}`,
    };
  }

  // THE PROMISE. A caller that ran the promise engine (deliveryBoard's
  // outstandingPromise) is the authority — it knows about the office's
  // override, the per-category SLAs and the multi-leg video anchor, none of
  // which the blob's videoDue carries. Only when nobody passed one do we fall
  // back to videoDue, and then the promise is the VIDEO's and must be labelled
  // as such (review, Sep 16).
  const videoDue = missing.includes("Video") ? asDate(e.videoDue) : null;
  const fellBack = input.dueAt == null && !input.promiseResolved;
  const promiseAt = input.dueAt ?? (input.promiseResolved ? null : videoDue);
  const promiseFor = promiseAt ? (fellBack ? "Video" : input.dueFor ?? null) : null;
  const promised = promiseAt ? { ...base, promiseAt, promiseFor } : base;

  if ((promiseAt && now > promiseAt) || (fellBack && e.videoOverdue && missing.includes("Video"))) {
    const when = promiseAt ?? videoDue;
    return {
      ...promised,
      kind: "overdue",
      headline: "Overdue",
      detail: when
        ? `${owed} ${missing.length === 1 ? "was" : "were"} promised by ${etStamp(when, true)} ET and ${missing.length === 1 ? "is" : "are"} still not confirmed.`
        : `${owed} ${missing.length === 1 ? "is" : "are"} past the promise and still not confirmed.`,
    };
  }

  if (promiseAt && promiseAt.getTime() - now.getTime() <= AT_RISK_HOURS * HOUR) {
    return {
      ...promised,
      kind: "at_risk",
      headline: `At risk — due ${etStamp(promiseAt, true)} ET`,
      detail: `${owed} still to come, with under a day left.`,
    };
  }

  // Aryeo says the order is fulfilled while the cross-check still can't see a
  // piece: a real discrepancy, worth amber even with no clock on it.
  if (e.partial) {
    return {
      ...promised,
      kind: "at_risk",
      headline: "Marked fulfilled, not fully confirmed",
      detail: `Aryeo has this order down as delivered, but the hub can't see ${owed}${promiseAt ? ` (due ${etStamp(promiseAt, true)} ET)` : ""}.`,
    };
  }

  return {
    ...promised,
    kind: "awaiting",
    headline: "Awaiting production",
    // "No promise has been set for it yet" was false on any job whose promise
    // this helper simply couldn't see — 2358 Buck Mountain said it while the
    // board had it due that same afternoon (review, Sep 16). Only a caller that
    // actually ran the promise engine may say a job has no date.
    detail: promiseAt
      ? `${owed} still to come — due ${etStamp(promiseAt, true)} ET.`
      : input.promiseResolved
        ? `${owed} still to come. No delivery date is set for it yet.`
        : `${owed} still to come.`,
  };
}

// A short, human flag for a card: what (if anything) is wrong/notable.
// "pending" = on-track, not a problem (e.g. a video still within its window).
// Sep 16 (RTP-16): the gate is evidenceTone() — this used to carry its own
// copy of the "is it meaningful yet" rule, and the project card carried a
// third. One rule, three readers.
export type StatusFlag = { kind: "missing" | "ready" | "stalled" | "revision" | "pending" | "unknown"; label: string };

export function statusFlag(
  status: string,
  raw: string | null | undefined,
  freshness?: { attemptedAt?: Date | string | null; succeededAt?: Date | string | null; error?: string | null; checkedAt?: Date | string | null },
): StatusFlag | null {
  // A revision request is the loudest signal — show it regardless of media.
  if (status === "REVISION") return { kind: "revision", label: "Revision requested" };
  const e = parseEvidence(raw);
  if (!e) return null;
  const tone = evidenceTone({ status, evidence: e, ...freshness });
  const missing = e.missing;
  switch (tone.kind) {
    case "overdue":
      return {
        kind: "missing",
        label: missing.length === 1 ? `${missing[0]} overdue` : `Overdue: ${missing.join(", ")}`,
      };
    case "at_risk":
      return {
        kind: "missing",
        label: e.partial ? `Aryeo "done" · missing ${missing.join(", ")}` : `Due soon · ${missing.join(", ")}`,
      };
    case "awaiting":
      // Date only what the promise is actually FOR. This used to label
      // missing[0] with whatever date came back, so a job missing Photos and
      // Video read "Photos due <the video's date>" (review, Sep 16).
      return {
        kind: "pending",
        label:
          tone.promiseAt && tone.promiseFor
            ? `${tone.promiseFor} due ${etStamp(tone.promiseAt)}`
            : `${missing.join(", ")} to come`,
      };
    case "unknown":
      return { kind: "unknown", label: tone.freshness.at ? `Not checked since ${etStamp(tone.freshness.at)}` : "Never cross-checked" };
    case "unconfirmed":
      return { kind: "pending", label: `Delivered · ${missing.join(", ")} unconfirmed` };
    default:
      if (status === "REVIEW" && e.present.length > 0 && !e.fulfilledOnAryeo) {
        return { kind: "ready", label: "Ready to deliver" };
      }
      return null;
  }
}

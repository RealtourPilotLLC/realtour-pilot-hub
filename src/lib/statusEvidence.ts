// Shared (client-safe) helpers for reading the smart-status evidence blob that
// the status engine writes to Project.statusEvidence. Keep this free of any
// server-only imports so cards/components can use it directly.

/**
 * THE PER-VIDEO TALLY, AS IT TRAVELS (audit R02, Sep 18; reopened Sep 18 pm).
 *
 * The status engine counts individual owed videos and writes the result into
 * the evidence blob — and until now this parser DROPPED the field on the floor,
 * so every reader downstream of it (the project card, the chips, statusFlag)
 * was still answering the category question the engine had stopped asking. A
 * job with four videos made, one on the listing and three still to send read
 * "Everything ordered is confirmed."
 *
 * TWO KINDS OF EVIDENCE, KEPT APART. `named` is a delivery with an identity on
 * it — a DeliverableOutput row carrying deliveredAt, so the hub can say WHICH
 * video went. `onListing` is Aryeo's count, which is real (that many videos are
 * openable) and anonymous (it names none of them). Their maximum is the honest
 * "at least this many", and it is what `withClient` carries; but where the
 * anonymous count is doing the work, `unmatched` says so, because four exports
 * of one cut and four separate videos look identical from here.
 *
 * Absent on older blobs, and absent must mean exactly the old behaviour.
 */
export type UnitTallyView = {
  category: string;
  /** individual outputs owed */
  owed: number;
  /** the honest "at least this many are with the client" — max(named, listing) */
  withClient: number;
  /** how many exist as finished work on our side */
  finished: number;
  /** owed − withClient */
  outstanding: number;
  /** 'outputs' = per-video rows; 'quantity' = the order row's count */
  source: string;
  /** deliveries with an identity: DeliverableOutput.deliveredAt stamps */
  named?: number;
  /** what Aryeo's listing carries for this category — anonymous but real */
  onListing?: number;
  /** listing media that no named delivery accounts for. > 0 means the count
   *  adds up and nothing ties it to the individual videos. */
  unmatched?: number;
  /** outputs with no delivery stamp, by `<deliverableId>:<slot>`. NOT trimmed
   *  against the anonymous count: spending a listing total across slots in
   *  array order assigns certainty to specific videos on no evidence at all
   *  (review, Sep 18). Every unstamped output is listed; `unmatched` says how
   *  much anonymous cover exists for them. */
  unresolvedKeys?: string[];
  /** @deprecated the positionally-trimmed list. Kept so old blobs still parse. */
  outstandingKeys?: string[];
};

export type ParsedEvidence = {
  expected: string[];
  present: string[];
  missing: string[];
  /**
   * Ordered, finished, and still only in our Dropbox — a send somebody owes
   * (audit WF-01, Sep 17). Older blobs predate the field and parse to [], which
   * reads as "nothing known to be owed" — right for history, and the next sweep
   * fills it in.
   */
  awaitingSend: string[];
  /** the per-category counts (R02). [] on every blob written before Sep 18. */
  units: UnitTallyView[];
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
      awaitingSend: e.awaitingSend ?? [],
      units: Array.isArray(e.units) ? e.units : [],
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
// ONE DEFINITION OF "STILL OWED" (audit F03, Sep 20).
//
// This used to live inside evidenceTone, which meant the CARD knew the right
// answer and every GATE read the raw blob field. `missing` alone is "never
// made anywhere we can see"; a video that is cut, approved and sitting in our
// 05-Final-Video folder is `present` by the engine's own definition
// (projectStatus.ts: present = clientHas UNION weHave), so finishing the work
// EMPTIES the one list the delivery gate was reading. On Sep 20 three live
// jobs sat in exactly that shape — 5 Raymond Cir, 453 Cardigan Terrace and
// 5642 Limeport Rd, the last with four videos cut, none on the client's
// listing — and the Editing Room's Completed pill returned no blockers on all
// three while the same blob's own reason string read "3 of 4 videos still
// outstanding".
//
// So the definition lives here, once, and the card and the gates both call it.
// Two ways a job still owes somebody something, and both count:
//   · neverMade    — ordered, live nowhere (the old `missing`)
//   · awaitingSend — finished, in our Dropbox, on no listing (WF-01, Sep 17)
//
// WHY A UNIT SHORTFALL IS A COUNT AND NOT A THIRD REASON (review, Sep 20).
// The first cut of this helper added any category with `outstanding > 0` to
// the list as an obligation in its own right. It cannot be one: `outstanding
// > 0` means withClient < owed, so the category is not in clientHas; if it is
// finished it is in weHave and therefore in awaitingSend, and if it is not it
// is not present at all and therefore in missing. The one shape that escapes
// that is the shape the ENGINE deliberately silences — `awaitingSend = a &&
// !sig.officeConfirmed ? … : []` (projectStatus.ts). So a standalone
// shortfall category never says anything new; it only overrules the engine on
// the two cases it means to suppress: a listing read that FAILED, and a
// delivery a person is on record for (the Sep 16 Kyle call). Measured over
// all 568 live blobs on Sep 20: zero carry a shortfall category that missing
// and awaitingSend do not already carry, and dropping it changed zero gate
// outcomes. The blob carries no officeConfirmed flag, so a consumer could not
// honour that suppression by itself even if it wanted to — which is the
// second reason this must not be a reason of its own.
//
// The counts stay, because "3 of 4 videos" is the sentence Kyle needs.
// ---------------------------------------------------------------------------

/** One category's unit count, for the sentence a refusal builds. */
export type OwedShortfall = {
  category: string;
  /** individual outputs owed */
  owed: number;
  /** owed minus what is with the client */
  outstanding: number;
};

export type OwedNow = {
  /** ordered and live nowhere we can see */
  neverMade: string[];
  /** finished on our side and not on the client's listing */
  awaitingSend: string[];
  /** every category still owed, however it is owed. Never-made first, each
   *  category once, in the engine's own words. */
  categories: string[];
  /** per-category unit counts for the phrase. [] on every blob written before
   *  Sep 18, and [] when the listing read did not happen: the engine will not
   *  print "1 of 16 confirmed" off a read it never got (`countsKnown`,
   *  projectStatus.ts), and neither will a refusal quoting the same blob. */
  shortfall: OwedShortfall[];
  /** individual outputs owed across every counted category */
  outstandingUnits: number;
  /** listing media no named delivery accounts for */
  unmatchedUnits: number;
};

/** Category identity, in one place. The blob carries the engine's own labels
 *  ("Photos", "Video", "Floor plan", "3D tour") and every consumer compares
 *  them; three copies of this line was how the card and the gate drifted
 *  apart in the first place. */
export const sameCategory = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function owedNow(ev: ParsedEvidence | null | undefined): OwedNow {
  const neverMade = ev?.missing ?? [];
  // A category can be in both lists on a partly-sent order. It is one
  // obligation, so it is named once, and it is named as the harder of the two.
  const awaitingSend = (ev?.awaitingSend ?? []).filter((c) => !neverMade.some((m) => sameCategory(m, c)));
  const units = ev?.units ?? [];
  // Counts only where the listing was actually read — the same witness the
  // engine requires before it will print a number (`countsKnown = !!a`). With
  // no read, `onListing` is 0 for every category and `outstanding` reads as
  // the whole order, which is "we did not look", not "nobody has it".
  const shortfall: OwedShortfall[] = ev?.aryeo
    ? units
        .filter((u) => Math.max(0, u.outstanding ?? 0) > 0)
        .map((u) => ({ category: u.category, owed: Math.max(0, u.owed ?? 0), outstanding: Math.max(0, u.outstanding ?? 0) }))
    : [];
  return {
    neverMade,
    awaitingSend,
    categories: [...neverMade, ...awaitingSend],
    shortfall,
    // The card has counted these off the raw tally since R02 and keeps doing
    // so: its sentence is about what the per-video rows say, not about what a
    // refusal is entitled to assert.
    outstandingUnits: units.reduce((n, u) => n + Math.max(0, u.outstanding ?? 0), 0),
    unmatchedUnits: units.reduce((n, u) => n + Math.max(0, u.unmatched ?? 0), 0),
  };
}

/** The plural of a category, for the one sentence that counts. The engine
 *  keeps the same map (CATEGORY_PLURAL, projectStatus.ts) against its own
 *  enum; the blob only carries labels, so this one is keyed on those. Sep 20:
 *  the first cut appended an "s" to the label, which turns "Photos" into
 *  "photoss" the day a photo tally is added. */
const CATEGORY_PLURAL_BY_LABEL: Record<string, string> = {
  "photos": "photo sets",
  "video": "videos",
  "floor plan": "floor plans",
  "3d tour": "3D tours",
};
function pluralOf(label: string): string {
  const word = label.trim().toLowerCase();
  return CATEGORY_PLURAL_BY_LABEL[word] ?? (/s$/.test(word) ? word : `${word}s`);
}

/** "the video" / "3 of 4 videos" / "the photos and 3 of 4 videos" — the phrase
 *  a refusal, a hold note and a timeline row all build their sentence around.
 *  The count is the point: before Sep 20 a monthly job with three of four
 *  reels still to send read exactly like a job with one video outstanding,
 *  and both of them read as nothing at all. */
export function owedPhrase(owed: Pick<OwedNow, "categories" | "shortfall">): string {
  const parts = owed.categories.map((c) => {
    const u = owed.shortfall.find((s) => sameCategory(s.category, c));
    // Only worth the long form when it says something the category does not:
    // "3 of 4 videos" is news, "1 of 1 video" is just "the video".
    return u && u.owed > 1 && u.outstanding > 0
      ? `${u.outstanding} of ${u.owed} ${pluralOf(c)}`
      : `the ${c.trim().toLowerCase()}`;
  });
  if (parts.length === 0) return "";
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0];
}

/** "is" / "are" for the phrase above. */
export function owedVerb(owed: Pick<OwedNow, "categories" | "shortfall">): string {
  if (owed.categories.length !== 1) return "are";
  const c = owed.categories[0];
  const u = owed.shortfall.find((s) => sameCategory(s.category, c));
  if (u && u.owed > 1 && u.outstanding > 0) return u.outstanding === 1 ? "is" : "are";
  return /s$/i.test(c.trim()) ? "are" : "is";
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

export type EvidenceToneKind =
  | "clear"
  | "awaiting"
  | "at_risk"
  | "overdue"
  | "unknown"
  | "unconfirmed"
  /** the counts add up and nothing ties them to the individual videos (R02) */
  | "unmatched";

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
  /** EVERYTHING still owed, in the engine's own category words — the ones
   *  never made AND the ones made and never sent. Both are obligations and a
   *  reader who is told only about the first is being reassured wrongly. */
  missing: string[];
  /** the subset of `missing` that exists in our Dropbox and has not gone out */
  awaitingSend: string[];
  /** individual outputs owed and not confirmed with the client, across every
   *  counted category (R02). 0 on a job with no per-video rows. */
  outstandingUnits: number;
  /** listing media that no named delivery accounts for (R02). > 0 means the
   *  totals agree and nothing identifies WHICH videos are up there. */
  unmatchedUnits: number;
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
  // ---- WHAT IS STILL OWED (R02 reopened, Sep 18) ---------------------------
  //
  // `missing` alone is "never made", and this function used to treat an empty
  // one as proof that a job was finished. It is not. A video can be made,
  // approved, sitting in our Dropbox Final folder and owed to a client who has
  // never seen it — that is `awaitingSend`, the engine has computed it since
  // WF-01, and the headline ignored it. Four videos finished with one on the
  // listing therefore read "Everything ordered is confirmed." while the same
  // engine's own numbers said three were outstanding.
  //
  // One list now: everything somebody still owes, whichever way it is owed.
  //
  // Sep 20 (F03): the list itself moved out to owedNow() so the delivery gates
  // read the same definition and the card and the gate can never again give a
  // job two different answers. `missing` here is owed.categories; it is spelt
  // out so the count sentence below reads against the same two lists it
  // always has.
  const { neverMade, awaitingSend, categories: missing, outstandingUnits, unmatchedUnits } = owedNow(e);
  const units = e?.units ?? [];
  const owed = listWords(missing);
  const base = {
    promiseAt: null as Date | null,
    promiseFor: null as string | null,
    missing,
    awaitingSend,
    outstandingUnits,
    unmatchedUnits,
    freshness,
  };

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

  const staleNote = () =>
    freshness.known
      ? null
      : `Last confirmed ${freshness.at ? `${etStamp(freshness.at, true)} ET` : "an unknown time ago"}. ${whyNotKnown()}, so this is the last good read.`;

  if (missing.length === 0 && outstandingUnits === 0) {
    // CONFIRMED BY COUNT IS NOT CONFIRMED BY NAME (R02, Sep 18). Aryeo's
    // listing count is real — that many videos are openable — and anonymous:
    // it names none of them. Where it is the thing carrying the total, four
    // exports of one cut are indistinguishable from four separate videos, and
    // saying "everything is confirmed" claims an identification nobody made.
    // Measured on production the same day: 922 per-video rows exist and SIX
    // carry a delivery stamp, so the anonymous count is doing the work on 234
    // jobs. Refusing to count it would invent 234 false obligations; pretending
    // it identifies anything is the error the reviewer reproduced. Both numbers
    // are reported and the sentence says which one it is leaning on.
    if (unmatchedUnits > 0) {
      const u = units.find((x) => (x.unmatched ?? 0) > 0);
      const named = u?.named ?? 0;
      const listed = u?.onListing ?? 0;
      const word = (u?.category ?? "item").toLowerCase();
      // THE CLOCK DOES NOT STOP BECAUSE THE TOTALS TALLY. 204 Spring Ln reads
      // this way today: one video owed, one anonymous video on the listing,
      // nothing made on our side, and six days past the date the client was
      // given. "Confirmed by count, not by name" is the right verdict and it is
      // not the whole sentence — a promise that has passed belongs in it.
      const due = input.dueAt ?? (input.promiseResolved ? null : asDate(e.videoDue));
      const late = due && now > due;
      const lateNote = late ? ` It is also past the ${etStamp(due, true)} ET date the client was given.` : "";
      return {
        ...base,
        promiseAt: due ?? null,
        promiseFor: due ? input.dueFor ?? null : null,
        // Quiet on a job the office has already delivered. The hub not being
        // able to name the videos on a listing from three months ago is not an
        // accusation, and 234 amber cards would say nothing. Amber is for the
        // live job, where somebody can still go and look before it goes out.
        kind: input.status === "DELIVERED" ? "unconfirmed" : "unmatched",
        headline: "Confirmed by count, not by name",
        detail:
          `Aryeo's listing carries ${listed} ${word}${listed === 1 ? "" : "s"} against ${u?.owed ?? listed} ordered, ` +
          `and ${named === 0 ? "none of them is" : `only ${named} of them is`} tied to a ${word} the hub tracks. ` +
          `Repeat versions of one cut look the same from here, so open the listing before telling a client it is all there.` +
          lateNote +
          (staleNote() ? ` ${staleNote()}` : ""),
      };
    }
    return {
      ...base,
      kind: "clear",
      headline: "Everything ordered is confirmed.",
      // A stale POSITIVE is still not today's fact — say so rather than let a
      // carried-forward count read as a fresh delivery.
      detail: staleNote(),
    };
  }

  // Nothing is MISSING but individual outputs are still outstanding: the job
  // owes specific videos even though every category has at least one. Say the
  // count, not the category.
  if (missing.length === 0) {
    const short = units
      .filter((u) => (u.outstanding ?? 0) > 0)
      .map((u) => `${u.outstanding} of ${u.owed} ${u.category.toLowerCase()}${u.owed === 1 ? "" : "s"}`);
    return {
      ...base,
      kind: input.status === "DELIVERED" ? "unconfirmed" : "at_risk",
      headline: `${short.join("; ") || `${outstandingUnits} still outstanding`} still outstanding`,
      detail:
        input.status === "DELIVERED"
          ? "The office has this job down as delivered, but the hub cannot account for every video that was ordered."
          : "Every category has something, but not every video that was ordered is with the client.",
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

  // MADE IS NOT SENT, AND "AWAITING PRODUCTION" SAYS THE OPPOSITE. When every
  // outstanding thing is finished and merely unsent, the production is DONE and
  // the word for it is not "awaiting production" — 893 S Matlack reads exactly
  // that way today, with a v2 cut approved and the card claiming the work had
  // not started.
  if (neverMade.length === 0 && awaitingSend.length > 0) {
    return {
      ...promised,
      kind: "awaiting",
      headline: "Finished, not sent",
      detail: `${owed} ${awaitingSend.length === 1 ? "is" : "are"} in our Dropbox and not on the client's listing${promiseAt ? ` — due ${etStamp(promiseAt, true)} ET` : ""}.`,
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
  // The TONE's list, not the blob's: it is the union of "never made" and "made
  // and never sent", and a label built from the blob's `missing` alone told a
  // reader nothing was outstanding on a job with three videos waiting to go.
  const missing = tone.missing;
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
      return {
        kind: "pending",
        label: missing.length
          ? `Delivered · ${missing.join(", ")} unconfirmed`
          : tone.unmatchedUnits > 0
            ? "Delivered · not matched to the videos ordered"
            : `Delivered · ${tone.outstandingUnits} still outstanding`,
      };
    case "unmatched":
      // The counts agree and nothing identifies WHICH. Worth a look, not an
      // alarm — the label says exactly what the reader has to do.
      return { kind: "missing", label: "On the listing, not matched to what was ordered" };
    default:
      if (status === "REVIEW" && e.present.length > 0 && !e.fulfilledOnAryeo) {
        return { kind: "ready", label: "Ready to deliver" };
      }
      return null;
  }
}

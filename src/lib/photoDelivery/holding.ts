// ---------------------------------------------------------------------------
// WHAT'S HOLDING THIS PHOTO JOB (Oct 22 2026).
//
// Jordan: "Sending a job should be clearer on what's holding it; it needs a
// decision. Kyle currently has to dig for what's holding it up." Before this,
// the reasons lived in six places, several of them a click or two deep: the
// stage stepper, the hold banner, the Before you send box, the Deliver bar's
// first line (one reason, "+2 more"), the checklist inside the closed Deliver
// panel, and the Aryeo push's own note. One pure function now turns the job's
// facts into ONE ordered list: each blocker a plain sentence, who it waits
// on, and the one button that settles it (or jumps straight to it). When
// nothing holds the job, it says "Ready to send" with the button.
//
// The SAME function feeds the job page's panel (HoldingPanel), the Deliver
// bar's first line and the board card's one-line summary (the first item), so
// the order and the words are the same everywhere. Pure: no database, safe in
// the browser. HOLDING_ORDER is the order.
// ---------------------------------------------------------------------------

/**
 * Oct 22 2026 (photo audit H2): "Approve and upload to Aryeo" checks the same
 * holds as Approve and deliver (aryeoPush.approveJob). Its refusal starts with
 * this, and the page then asks Kyle for a reason (at least
 * UPLOAD_OVERRIDE_MIN characters) to put the photos up anyway.
 */
export const UPLOAD_HELD_PREFIX = "Held:";
export const UPLOAD_OVERRIDE_MIN = 10;
/** Oct 22 2026 (photo audit C1): the typed reason for "Settled with the client: nothing to resend". */
export const SETTLED_REASON_MIN = 10;

/** The kinds of blocker, in the order they are shown (and the order they are usually settled in). */
export const HOLDING_ORDER = [
  "hold", // the job is on hold
  "edits", // AutoHDR's edits, a split job's later visit, the photo check
  "fixing", // approved fixes running
  "upload", // part of the order never uploaded
  "wrapup", // the photographer's wrap-up
  // Oct 28 2026 (Kyle: "it should be in one category/task for the job (Client Requests)"):
  // every client request (add-ons on the order, order notes, texts, emails, calls) in ONE item.
  "requests",
  "addon", // Lot Lines needed, Virtual Staging needed (an older reader; now inside "requests")
  "ask", // the photographer's wrap-up removal notes (the client's requests are inside "requests")
  // Oct 27 2026 (Jordan on the Needs decision column: "I don't know why these are in here"):
  // a reopened job says why first (the client's request), before the checks; it is still sent last.
  "revision", // the client asked for changes after delivery: send again once the rest is settled
  "decisions", // QC issues to fix or set aside
  "privacy", // a privacy or wrong-property issue
  "coverage", // something ordered not covered
  "checks", // the checklist's own checks (files, the QC covering every photo, rooms)
  "update", // photos edited in the hub whose old file is still on the Aryeo listing (Update on Aryeo)
  "listing", // no Aryeo listing linked
  "aryeo", // the push into Aryeo: running, stopped, a photo twice, the order, changed
  "confirming", // waiting for Aryeo to confirm the delivery
  "mismatch", // the delivery check found a problem
] as const;
/** Oct 22 2026 (photo audit H2): "delivered" heads a delivered job's list when it went out with holds still open (ranked first). */
export type HoldingKind = (typeof HOLDING_ORDER)[number] | "flags" | "redeliver" | "delivered";

export type HoldingAction =
  | { kind: "release"; label: string }
  | { kind: "link"; label: string; href: string; external?: boolean }
  | { kind: "tab"; label: string; tab: "issues" | "cart" | "coverage" | "activity" }
  | { kind: "wrapup"; label: string; href: string }
  /** Oct 28 2026: `askIds`, the client's requests that only asked for this add-on again, settled with it. */
  | { kind: "addon"; label: string; addOn: string; askIds?: string[] }
  /** Oct 28 2026: `askIds`, the same request from several places, settled together (askId is the first). */
  | { kind: "ask"; label: string; askId: string; askIds?: string[] }
  /** upload (Oct 27 2026): "Approve and upload" beside it, the photos put on the listing without the delivery. */
  | { kind: "approve"; label: string; upload?: boolean }
  | { kind: "deliver"; label: string }
  | { kind: "mark"; label: string }
  | { kind: "verify"; label: string }
  | { kind: "rerun"; label: string }
  | { kind: "update"; label: string; photoIds: string[] }
  /** Oct 22 2026 (photo audit C1): "Settled with the client: nothing to resend", with a typed reason. */
  | { kind: "settle"; label: string }
  /** Oct 23 2026 (huddle item 9): text the photographer asking for notes (askNotes.ts); the photos never wait for them. */
  | { kind: "asknotes"; label: string };

export type HoldingItem = {
  key: string;
  kind: HoldingKind;
  /** The plain sentence. */
  text: string;
  /** A few words for the board card ("Lot Lines needed", "Wrap-up missing"). */
  short: string;
  /** "Waiting on Kyle", "Waiting on AutoHDR", "Waiting on Harrison (photographer)". */
  waitingOn: string;
  detail: string | null;
  /** The agent's own words (Lot Lines needed, Virtual Staging needed). */
  quotes: { from: string; text: string }[];
  /** Oct 22 2026: the client's full message behind a summarised request ("Everything they said"). */
  said?: { from: string; text: string } | null;
  action: HoldingAction | null;
  /** Oct 22 2026: a second button beside the action (the revision's "Settled with the client: nothing to resend"). */
  alt?: HoldingAction | null;
  /** A second way in (the listing to look at before Deliver). */
  link: { label: string; href: string; external?: boolean } | null;
  /** Oct 28 2026: the "Client requests" item's lines, each with its own button (clientRequestLines). */
  requests?: RequestLine[];
};

/**
 * One line of the job's Client requests (Oct 28 2026). The same request from
 * several places is ONE line that lists them (`sources`); settling it settles
 * every place at once (`askIds`, and the add-on when it is one).
 */
export type RequestLine = {
  key: string;
  /** "Virtual Staging needed", "Client asked: crop out the sidewalk forms (photos 1-5)". */
  text: string;
  /** Where it was asked: "On the order: Virtual Staging (3 staged photos)", "Special instructions", "Text from Ashley, Oct 26". */
  sources: string[];
  /** The client's own words about it, each with where it came from. */
  quotes: { from: string; text: string }[];
  said: { from: string; text: string } | null;
  detail: string | null;
  waitingOn: string;
  /** It holds Kyle's approval (else it only informs him). */
  holds: boolean;
  /** The add-on it is (its steps and confirm button), when it is one. */
  addOn: string | null;
  askIds: string[];
  action: HoldingAction | null;
};

export type HoldingView = {
  /** What stops Kyle's Approve and deliver now, in HOLDING_ORDER. */
  items: HoldingItem[];
  /** Open, but not holding Kyle's approval (photo flags, shadow-mode checks): the hub's own same-day delivery still waits for them. */
  also: HoldingItem[];
  /** Nothing holds it: the button to press. */
  ready: { text: string; detail: string | null; action: HoldingAction | null } | null;
  /** The board card's one line: the first item, or "Ready to send", or "Delivered". */
  line: string;
  tone: "held" | "waiting" | "ready" | "done";
};

/** A delivery checklist line (delivery.ts GateCheck), as the panel reads it. */
export type HoldingGateLine = {
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
  personOnly?: boolean;
  addOn?: { key: string; need: string; done: string; ordered: string; quotes: { from: string; text: string }[]; cleared: unknown };
  photoIds?: string[];
  waitingOn?: string;
  doneLabel?: string;
  said?: { from: string; text: string } | null;
  /** Oct 23 2026: informs Kyle, holds only the hub's own delivery (the wrap-up); offer "Ask the photographer for notes". */
  hubHold?: boolean;
  askNotes?: boolean;
  /** Oct 28 2026 (delivery.ts): a photo-only check on a job with no photos yet: it waits for them, never a thing to do. */
  waiting?: boolean;
  /** Oct 28 2026 (delivery.ts): a client's request, for the one Client requests item. */
  request?: { what: string; from: string; sameAs?: string | null };
};

export type HoldingPush = {
  mode: string;
  connected: boolean;
  sameDayAuto: boolean;
  progress: {
    state: string;
    active: boolean;
    total: number;
    sent: number;
    already: number;
    note: string | null;
    changed?: boolean;
    deliveredAt: string | null;
    update?: boolean;
    kept?: number;
    duplicates?: string[][];
    redeliver?: { pending: number; state: string | null; at: string | null; photos: number; note: string | null } | null;
  } | null;
};

/** The job's own facts (data.ts holdingBaseOf), without the checklist and the push. */
export type HoldingBase = {
  jobId: string;
  projectId: string;
  stage: string;
  holdReason: string | null;
  holdNote: string | null;
  lastError: string | null;
  /** "Tue, Oct 21": a split job waiting for a later visit's photos (the sync's own words). */
  waitingForVisit: string | null;
  photographer: string | null;
  /** Open QC issues, as tickets (one per check and place), by severity. */
  decisions: { critical: number; major: number; minor: number };
  listingUrl: string | null;
  orderUrl: string | null;
  deliveryCheckNote: string | null;
  /** Photos edited in the hub whose old file is still on the Aryeo listing (needsListingUpdate): their ids and names. */
  listingUpdates: { photoIds: string[]; names: string[] };
  /**
   * Oct 22 2026 (photo audit M3): how many raw uploads the hub has seen for
   * the job (intake batches). 0 on a job in Editing with no photos: the raws
   * never came, so it is the photographer's, not AutoHDR's. Null: not read.
   */
  rawBatches?: number | null;
  /** How many edited photos the job has read (finalsCount); with 0 raws and 0 photos the job is not uploaded yet. */
  photosRead?: number | null;
  /**
   * Oct 27 2026 (Jordan: "what is the request? Where is it? I don't see what
   * the request is"): on a reopened job, what the client asked after delivery,
   * in their words, with who, how and when ("Mike Flatley, by text, Tue Oct 27,
   * 3:04 PM"). Null: not read (the board). One already listed as its own request (askId) is not quoted twice.
   */
  revisionRequests?: { text: string; from: string; askId?: string | null }[] | null;
};

/**
 * A photo edited in the hub (Straighten, Lot lines, an upload) whose file is
 * on the Aryeo listing: the listing keeps the OLD file until Update on Aryeo
 * (aryeoPush.requestListingUpdate) replaces it. Its file is on the listing
 * when the photo was read from the listing, is a split job's delivered photo
 * (ON_LISTING), or the job is delivered. Before that the delivery itself
 * sends the edit. Pure (the "hub-" prefix is photoEdit's hub hash). Oct 22 2026.
 */
export function needsListingUpdate(p: { contentHash: string | null; sourceKind: string; status: string }, stage: string): boolean {
  if (!p.contentHash?.startsWith("hub-")) return false;
  return p.status === "ON_LISTING" || (p.sourceKind !== "AUTOHDR" && p.sourceKind !== "UPLOAD") || stage === "DELIVERED" || stage === "DELIVERY_MISMATCH";
}

export type HoldingInput = HoldingBase & {
  gate: { checks: HoldingGateLine[]; canDeliver: boolean; advisory: boolean; blockedForOverride: string | null } | null;
  /** Null: the checklist was not read (the board reads it only where it can matter). */
  gateError?: string | null;
  push: HoldingPush;
};

const HOLD_WORDS: Record<string, string> = { CRITICAL: "a critical issue", CREDITS: "out of AutoHDR credits", RESHOOT: "a reshoot", MANUAL: "held by hand" };
const ACTIVE_PUSH = new Set(["PREPARING", "SENDING", "ADDING", "CHECKING", "ORDERING", "DELIVERING", "CONFIRMING"]);
/** The stages Kyle's approval is taken from (aryeoPush APPROVE_FROM) and Mark as delivering starts from (DeliverPanel). */
const APPROVE_STAGES = new Set(["READY", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const first = (name: string | null) => (name ?? "").trim().split(/\s+/)[0] || null;

function item(kind: HoldingKind, key: string, text: string, short: string, waitingOn: string, action: HoldingAction | null, extra: Partial<Pick<HoldingItem, "detail" | "quotes" | "link" | "said" | "alt" | "requests">> = {}): HoldingItem {
  return { key, kind, text, short, waitingOn, detail: extra.detail ?? null, quotes: extra.quotes ?? [], said: extra.said ?? null, action, ...(extra.alt ? { alt: extra.alt } : {}), link: extra.link ?? null, ...(extra.requests ? { requests: extra.requests } : {}) };
}

const normWords = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The same words: equal, or one holds the other (long enough to mean it). */
const sameWords = (a: string, b: string) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))));

/**
 * THE JOB'S CLIENT REQUESTS, ONE ITEM (Oct 28 2026). Kyle on 40 N Perry St:
 * "Virtual staging is also showing twice, as it was in the order instructions
 * and texted to us. If it's the same request, then it should be combined into
 * one and if it's multiple requests then it should be in one category/task
 * for the job (Client Requests)". From the checklist's request lines
 * (delivery.ts `request`): each add-on on the order is one line, carrying the
 * client's words about it and every request that only asked for it again
 * (`sameAs`: the text "please virtually stage the living room" is the staging
 * line, not a second one). Every other request is a line of its own; the same
 * words from two places (an email and a text saying the same) are one line.
 * Each line lists where it was asked and has its own button; settling it
 * settles every place at once. Open lines only: a done add-on whose request
 * is still open reads as that request (check it, then Done). `holds`: the
 * line holds Kyle's approval. Pure.
 */
export function clientRequestLines(checks: HoldingGateLine[], holds: (c: HoldingGateLine) => boolean = (c) => !!c.hold && !c.ok && !c.advisory): RequestLine[] {
  const reqs = checks.filter((c) => !!c.request);
  const lines: RequestLine[] = [];
  const used = new Set<string>();
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  // The requests that are lines of their own (not only the add-on asked again).
  const ownLines = reqs.filter((r) => !!r.askId && !r.ok && !(r.request?.sameAs && reqs.some((x) => x.key === r.request!.sameAs)));
  const ownLine = (t: string) => ownLines.some((r) => [r.request!.what, r.said?.text ?? ""].some((w) => sameWords(normWords(t), normWords(w))));
  // The add-ons on the order, each with the requests that only ask for it again.
  for (const c of reqs) {
    if (!c.addOn && c.key !== "addons") continue;
    used.add(c.key);
    const again = reqs.filter((r) => !!r.askId && !r.ok && r.request?.sameAs === c.key);
    for (const r of again) used.add(r.key);
    if (c.ok && !again.length) continue;
    const a = c.addOn ?? null;
    // A request listed as its own line ("Could you also stage the dining room?", a question
    // for the office) is not quoted under the add-on too, nor counted as a place it was asked.
    const own = (a?.quotes ?? []).filter((q) => !ownLine(q.text));
    const quotes = [...own];
    // A request whose words the add-on already quotes is that place, under its own name
    // (the order note filed as a request is the "Order notes" quote): never listed twice.
    const againFrom: string[] = [];
    for (const r of again) {
      const w = r.request!.what;
      const q = quotes.find((x) => sameWords(normWords(x.text), normWords(w)));
      if (q) againFrom.push(q.from);
      else {
        quotes.push({ from: r.request!.from, text: w });
        againFrom.push(r.request!.from);
      }
    }
    const askIds = again.map((r) => r.askId!);
    const open = !c.ok;
    lines.push({
      key: c.key,
      text: open ? (a?.need ?? c.label) : `${a?.done ?? c.label}. Check it against the client's request, then press Done.`,
      sources: uniq([c.request!.from, ...own.map((q) => q.from), ...againFrom]),
      quotes,
      said: null,
      detail: c.detail ?? null,
      waitingOn: "Waiting on Kyle",
      holds: (open && holds(c)) || again.some((r) => holds(r)),
      addOn: open && a ? a.key : null,
      askIds,
      action: open ? (a ? { kind: "addon", label: a.done, addOn: a.key, ...(askIds.length ? { askIds } : {}) } : null) : { kind: "ask", label: "Done (fixed)", askId: askIds[0], askIds },
    });
  }
  // Every other request: the same words from several places are one line.
  for (const c of reqs) {
    if (used.has(c.key) || c.ok) continue;
    used.add(c.key);
    if (!c.askId) {
      // "What the client asked" could not be read just now: a line with no button.
      lines.push({ key: c.key, text: c.label, sources: [], quotes: [], said: null, detail: c.detail ?? null, waitingOn: c.waitingOn ?? "Waiting on Kyle", holds: holds(c), addOn: null, askIds: [], action: null });
      continue;
    }
    const k = normWords(c.request!.what);
    // (A question for the office is settled differently: never one line with a fix.)
    const same = reqs.filter((r) => !used.has(r.key) && !!r.askId && !r.ok && (r.doneLabel ?? "") === (c.doneLabel ?? "") && sameWords(k, normWords(r.request!.what)));
    for (const r of same) used.add(r.key);
    const all = [c, ...same];
    const askIds = all.map((r) => r.askId!);
    lines.push({
      key: c.key,
      text: c.label,
      sources: uniq(all.map((r) => r.request!.from)),
      quotes: [],
      said: c.said ?? null,
      detail: null,
      waitingOn: c.waitingOn ?? "Waiting on Kyle",
      holds: all.some((r) => holds(r)),
      addOn: null,
      askIds,
      action: { kind: "ask", label: c.doneLabel ?? "Done (fixed)", askId: askIds[0], ...(askIds.length > 1 ? { askIds } : {}) },
    });
  }
  return lines;
}

/**
 * What a photo-only check waits for on a job with no photos yet (Oct 28 2026,
 * delivery.ts `waiting`): "the upload", "the next visit's photos", "AutoHDR's
 * edits". Pure.
 */
export function photoChecksWaitFor(base: { stage: string; rawBatches?: number | null; photosRead?: number | null; waitingForVisit?: string | null }): string {
  if (base.stage === "EDITING" && base.waitingForVisit) return "the next visit's photos";
  if (notUploadedYet(base.stage, base.rawBatches, base.photosRead)) return "the upload";
  if (base.stage === "EDITING") return "AutoHDR's edits";
  return "the photos";
}

/** "3 photo checks wait for the upload. They run once the photos are in." (null: none waits). Pure. */
export function photoChecksWaitWords(checks: { waiting?: boolean }[] | null | undefined, base: Parameters<typeof photoChecksWaitFor>[0]): string | null {
  const n = (checks ?? []).filter((c) => c.waiting).length;
  if (!n) return null;
  return `${n === 1 ? "1 photo check waits" : `${n} photo checks wait`} for ${photoChecksWaitFor(base)}. ${n === 1 ? "It runs" : "They run"} once the photos are in.`;
}

/**
 * Oct 22 2026 (photo audit M3): a job in Editing that never had raws (no upload
 * seen, no photos): the photographer's, not AutoHDR's. Pure. Oct 23 2026
 * (Jordan and Kyle's huddle, item 12: today's jobs read "Editing" before the
 * photos were uploaded): `rawBatches` counts the uploads that went on to
 * AutoHDR (an intake batch past WAITING, or an AutoHDR shoot linked by hand);
 * files still arriving are not "in" yet. Such a job reads WAITING_FOR_UPLOAD
 * everywhere: this panel, the Photo Delivery board, the job's stage stepper,
 * the Shoots board and Kyle's desk.
 */
export function notUploadedYet(stage: string, rawBatches: number | null | undefined, photosRead: number | null | undefined): boolean {
  return stage === "EDITING" && rawBatches === 0 && !photosRead;
}
/** The words for a photo job before its raws arrive (Oct 23 2026). */
export const WAITING_FOR_UPLOAD = "Waiting for upload";

/** The upload is on and the hub has its Aryeo login (AryeoPushControls.aryeoPushOn). */
const pushOn = (p: HoldingPush) => p.mode !== "off" && p.connected;

/** What the push needs next (AryeoPushControls.aryeoPushNext): Kyle's approval, a delivery of photos already up, or nothing. */
function pushNext(p: HoldingPush): "approve" | "deliver" | null {
  const pr = p.progress;
  if (!pushOn(p)) return null;
  if (!pr) return "approve";
  if (pr.active || pr.deliveredAt) return null;
  if (pr.state === "FAILED") return "approve";
  if (pr.state === "WAITING" || pr.state === "DONE") return pr.changed ? "approve" : "deliver";
  return null;
}

/**
 * The job's blockers in HOLDING_ORDER, what is open but does not hold Kyle,
 * and the button when nothing holds it. Pure.
 */
export function holdingFor(input: HoldingInput): HoldingView {
  const out: HoldingItem[] = [];
  const also: HoldingItem[] = [];
  const { stage, gate, push } = input;
  const pr = push.progress;
  const who = first(input.photographer);
  const photographer = who ? `Waiting on ${who} (photographer)` : "Waiting on the photographer";
  const delivered = stage === "DELIVERED";
  const add = (holds: boolean, it: HoldingItem) => (holds ? out : also).push(it);
  // A checklist line holds Kyle when it is a hold line, or when the checklist is not advisory (shadow mode off).
  const holdsKyle = (c: HoldingGateLine) => !c.ok && !c.advisory && (!!c.hold || !gate?.advisory);

  // ---- the job's own state ----
  if (stage === "ON_HOLD") {
    const why = HOLD_WORDS[input.holdReason ?? ""] ?? "held by hand";
    const waiting = input.holdReason === "CREDITS" ? "Waiting on Jordan (AutoHDR credits)" : input.holdReason === "RESHOOT" ? photographer : "Waiting on Kyle";
    add(true, item("hold", "hold", `On hold: ${why}.${input.holdNote ? ` ${input.holdNote}` : ""}`, `On hold: ${why}`, waiting, { kind: "release", label: "Release the hold" }));
  }
  if (stage === "EDITING" && input.waitingForVisit) {
    add(true, item("edits", "edits", `Waiting for the photos from the ${input.waitingForVisit} visit. The earlier visit's photos are already on the listing.`, "Waiting for the next visit's photos", photographer, { kind: "link", label: "Open the upload page", href: `/upload/${input.projectId}` }));
  } else if (notUploadedYet(stage, input.rawBatches, input.photosRead)) {
    // Oct 22 2026 (photo audit M3, 913 Lakeview and 1316 Blair): no raws ever reached the hub, so nothing went to AutoHDR.
    add(true, item("edits", "edits", `${WAITING_FOR_UPLOAD}: the raw photos have not reached the hub yet, so nothing has gone to AutoHDR.`, WAITING_FOR_UPLOAD, photographer, { kind: "link", label: "Open the upload page", href: `/upload/${input.projectId}` }));
  } else if (stage === "EDITING") {
    // Nothing to press: the hub looks at AutoHDR every few minutes by itself.
    add(true, item("edits", "edits", "AutoHDR is still editing the photos. The hub looks again every few minutes.", "Waiting for AutoHDR's edits", "Waiting on AutoHDR", null));
  } else if (stage === "EDIT_FAILED") {
    add(true, item("edits", "edits", `The AutoHDR edit failed${input.lastError ? `: ${input.lastError}` : "."}`, "The edit failed", "Waiting on Kyle", { kind: "tab", label: "See the history", tab: "activity" }));
  } else if (stage === "EDITED" || stage === "QC_RUNNING") {
    add(true, item("edits", "edits", "The photo check is running on the new edits.", "Being checked", "Waiting on the hub", null));
  } else if (stage === "FIXING") {
    add(true, item("fixing", "fixing", "Approved fixes are running in AutoHDR.", "Fixes running", "Waiting on AutoHDR", { kind: "tab", label: "See the fixes", tab: "cart" }));
  } else if (stage === "REVISION_REQUESTED") {
    const again: HoldingAction = pushOn(push) && input.listingUrl ? { kind: "approve", label: "Approve and deliver again", upload: true } : { kind: "mark", label: "Mark as delivering" };
    // Oct 22 2026 (photo audit C1): the revision leaves only by sending again, or by this, with a reason (never by Aryeo's old "delivered").
    // Oct 27 2026 (Jordan: "I don't know what the client requested ... There's too much going on here"): the request itself, in the client's words, and one short line.
    // A request already listed above as its own item (the checklist's "Client asked", with Done) is not quoted again.
    const listed = new Set((gate?.checks ?? []).map((c) => c.askId).filter(Boolean));
    const all = input.revisionRequests ?? [];
    const asks = all.filter((a) => !a.askId || !listed.has(a.askId)).map((a) => ({ text: a.text, from: a.from }));
    const text = asks.length > 1 ? `The client asked for ${asks.length} changes after delivery.` : asks.length ? "The client asked for a change after delivery." : all.length ? "The client asked for changes after delivery (listed above)." : "The client asked for changes after delivery.";
    // The board card's line says it too (Jordan on the Needs decision column: "I don't know why these are in here").
    add(true, item("revision", "revision", text, asks.length ? `Client asked: "${clipTo(asks[0].text, 48)}"` : "Client asked for changes", "Waiting on Kyle", again, {
      detail: "Fix the photos, then send them again. Or, if it was settled with the client, say so.",
      quotes: asks,
      alt: { kind: "settle", label: "Settled with the client: nothing to resend" },
    }));
  }

  // ---- the delivery checklist ----
  if (!gate && !delivered && APPROVE_STAGES.has(stage)) {
    add(true, item("checks", "gate", `The delivery checklist could not be read${input.gateError ? ` (${input.gateError})` : ""}.`, "Checklist unreadable", "Waiting on the hub", { kind: "rerun", label: "Read it again" }));
  }
  // Oct 22 2026 (photo audit H2): photos delivered (in Aryeo, past the hub)
  // while a hold line was open: those lines stay on the job, each settled by a
  // person; the hub no longer closes them by itself.
  // (What the client asked and the add-on work; the wrap-up only informs a delivery, and its removal notes are an ask.)
  const openAfter = delivered ? (gate?.checks ?? []).filter((c) => c.hold && !c.ok && !c.advisory && (c.key.startsWith("ask") || c.key.startsWith("addon"))) : [];
  // Oct 28 2026: counted as they are listed (the same request from two places is one).
  const openAfterN = openAfter.filter((c) => !c.request).length + clientRequestLines(openAfter.filter((c) => !!c.request)).length;
  if (openAfterN) {
    add(true, item("delivered", "delivered-open", `The photos went out with ${plural(openAfterN, "thing")} still open. Settle each one below.`, `Delivered with ${plural(openAfterN, "thing")} open`, "Waiting on Kyle", null));
  }
  for (const c of delivered ? openAfter : gate?.checks ?? []) {
    // The checklist's Update on Aryeo line is the job's own fact here (listingUpdates, below), delivered or not.
    // Oct 28 2026: a photo-only check before there are photos is not a thing to do (the edits line says it waits);
    // the client's requests are one item (below).
    if (c.ok || c.key === "listing-update" || c.waiting || c.request) continue;
    const holds = holdsKyle(c);
    if (c.key === "upload") {
      add(holds, item("upload", c.key, `Part of the order was not uploaded${c.detail ? `: ${c.detail}` : "."}`, "Part of the order not uploaded", photographer, { kind: "link", label: "Open the upload page", href: `/upload/${input.projectId}` }));
    } else if (c.key === "wrapup") {
      // Oct 23 2026 (huddle item 9): the photographer's notes never hold Kyle;
      // the line informs and offers a text asking for them (the old line with
      // "Deliver without it" for a hold that still is one: an older reader).
      if (c.askNotes || c.hubHold) {
        also.push(item("wrapup", c.key, c.label, "No photographer notes yet", photographer, c.askNotes ? { kind: "asknotes", label: "Ask the photographer for notes" } : null, { detail: c.detail ?? null, link: c.href ? { label: c.hrefLabel ?? "Open the wrap-up", href: c.href } : null }));
      } else {
        add(holds, item("wrapup", c.key, c.label, "Wrap-up missing", photographer, c.href ? { kind: "wrapup", label: c.hrefLabel ?? "Open the wrap-up", href: c.href } : null, { detail: c.detail ?? null }));
      }
    } else if (c.key.startsWith("addon")) {
      const a = c.addOn;
      add(holds, item("addon", c.key, a ? `${a.need}.` : `${c.label}.`, a?.need ?? c.label, "Waiting on Kyle", a ? { kind: "addon", label: a.done, addOn: a.key } : null, { detail: c.detail ?? null, quotes: a?.quotes ?? [] }));
    } else if (c.key.startsWith("ask")) {
      const holdsAsk = holds && (!!c.hold || !c.askId);
      add(holdsAsk, item("ask", c.key, c.label, clipTo(c.label, 60), c.waitingOn ?? "Waiting on Kyle", c.askId ? { kind: "ask", label: c.doneLabel ?? "Done (fixed)", askId: c.askId } : null, { detail: c.detail ?? null, said: c.said ?? null }));
    } else if (c.key === "critical" || c.key === "major") {
      // One decisions line for both (below), from the tickets.
      continue;
    } else if (c.key === "coverage") {
      add(holds, item("coverage", c.key, `Something ordered is not covered${c.detail ? ` (${c.detail})` : ""}.`, "Ordered item not covered", "Waiting on Kyle", { kind: "tab", label: "Open Coverage", tab: "coverage" }));
    } else if (c.key === "flags") {
      also.push(item("flags", c.key, `${cap(c.detail ?? "Photo flags are open")}.`, "Photo flags open", "Waiting on Kyle", c.href ? { kind: "link", label: "Open the flags", href: c.href } : null));
    } else if (c.key === "files") {
      add(holds, item("checks", c.key, `${c.label}${c.detail ? `: ${c.detail}` : ""}.`, "Photo files to fix", "Waiting on Kyle", { kind: "tab", label: "Open Issues", tab: "issues" }));
    } else {
      // The QC covering every photo, the gallery checks, the room check, a line that could not be read.
      add(holds, item("checks", c.key, `${c.label}${c.detail ? `: ${c.detail}` : ""}.`, clipTo(c.label, 50), "Waiting on the hub", c.key === "qc" || c.key === "gallery" || c.key === "rooms" ? { kind: "rerun", label: "Check again" } : null));
    }
  }
  // Oct 28 2026 (Kyle: "it should be in one category/task for the job (Client Requests)"):
  // every client request in ONE item, the same request from several places one line.
  const requests = clientRequestLines((delivered ? openAfter : gate?.checks ?? []).filter((c) => !!c.request), holdsKyle);
  if (requests.length) {
    const n = requests.length;
    const one = requests[0];
    const waitingOn = requests.every((l) => l.waitingOn === one.waitingOn) ? one.waitingOn : "Waiting on Kyle";
    add(requests.some((l) => l.holds), item(
      "requests", "requests",
      // One request says itself ("Lot Lines needed.", "Client asked: ..."); the panel heads it "Client requests".
      n === 1 ? `${one.text.replace(/\.$/, "")}.` : `Client requests: ${n} to settle.`,
      n === 1 ? (one.addOn ? one.text : clipTo(one.text, 60)) : `${n} client requests`,
      waitingOn, null, { requests },
    ));
  }
  // Oct 28 2026: the photo-only checks waiting for the photos, said once, on the line about the photos.
  const waitWords = photoChecksWaitWords(gate?.checks, input);
  const photosLine = out.find((i) => i.kind === "edits") ?? out.find((i) => i.kind === "hold");
  if (waitWords && photosLine && !photosLine.detail) photosLine.detail = waitWords;
  if (!delivered) {
    const tickets = input.decisions.critical + input.decisions.major;
    const failing = (gate?.checks ?? []).filter((c) => (c.key === "critical" || c.key === "major") && !c.ok);
    const decide = stage === "QC_REVIEW" || failing.length > 0;
    if (decide && (tickets > 0 || stage === "QC_REVIEW")) {
      const n = tickets || input.decisions.minor;
      const words = n ? `${plural(n, "issue")} to decide: fix each one, or set it aside with a reason.` : "Issues to decide on the Issues tab.";
      const holds = stage === "QC_REVIEW" || failing.some((c) => holdsKyle(c));
      add(holds, item("decisions", "decisions", cap(words), n ? `${plural(n, "issue")} to decide` : "Issues to decide", "Waiting on Kyle", { kind: "link", label: "Decide them", href: `/ops/photo-delivery/${input.jobId}/review` }));
    }
    if (gate?.blockedForOverride) add(true, item("privacy", "privacy", gate.blockedForOverride, "Privacy or wrong-property issue", "Waiting on Kyle", { kind: "tab", label: "Open Issues", tab: "issues" }));
  }

  // ---- Aryeo ----
  const on = pushOn(push);
  if (on && !input.listingUrl && !delivered && APPROVE_STAGES.has(stage)) {
    add(true, item("listing", "listing", "No Aryeo listing is linked to this job yet, so there is nowhere to send the photos.", "No Aryeo listing yet", "Waiting on Kyle", input.orderUrl ? { kind: "link", label: "Open the order", href: input.orderUrl, external: true } : null));
  }
  const listingLink = input.listingUrl ? { label: "Open the listing", href: input.listingUrl, external: true } : null;
  if (on && pr && (!pr.update || ACTIVE_PUSH.has(pr.state))) {
    const kept = pr.kept ? ` The ${pr.kept} already on the listing stay first.` : "";
    const waitingRun = (pr.state === "WAITING" || pr.state === "DONE") && !pr.deliveredAt;
    if (ACTIVE_PUSH.has(pr.state)) {
      const words =
        pr.update ? `Updating ${plural(pr.total, "edited photo")} on the Aryeo listing.`
        : pr.state === "PREPARING" ? pr.note ?? "Getting the photos ready in 06-Ready-for-Aryeo first."
        : pr.state === "SENDING" ? `Sending the photos to Aryeo: ${pr.sent} of ${pr.total}.${kept}`
        : pr.state === "DELIVERING" || pr.state === "CONFIRMING" ? "Delivering in Aryeo now."
        : pr.note ?? "Putting the photos on the Aryeo listing.";
      add(true, item("aryeo", "aryeo", words, "Sending to Aryeo", "Waiting on the hub and Aryeo", null));
    } else if (delivered) {
      // A split job's new photos uploaded onto the delivered listing: the agent has not had the email for them (aryeoPush re-delivery).
      const n = pr.redeliver?.pending ?? 0;
      if (waitingRun && n > 0) add(true, item("redeliver", "redeliver", `${plural(n, "new photo")} ${n === 1 ? "is" : "are"} on the delivered listing, but the agent has not been sent the email for ${n === 1 ? "it" : "them"} yet.`, "Re-deliver for the new photos", "Waiting on Kyle", { kind: "deliver", label: "Re-deliver in Aryeo" }, { link: listingLink }));
    } else if (!APPROVE_STAGES.has(stage)) {
      // An earlier run's record while the job is back in editing or checks: the next approval starts a new one.
    } else if (pr.state === "FAILED") {
      add(true, item("aryeo", "aryeo", `Sending to Aryeo stopped: ${pr.note ?? "no reason recorded"}`, "Aryeo upload stopped", "Waiting on Kyle", { kind: "approve", label: /Send anyway/.test(pr.note ?? "") ? "Look at it, then approve again" : "Approve again" }, { link: listingLink }));
    } else if (waitingRun) {
      if (pr.changed) {
        add(true, item("aryeo", "aryeo", "The photos changed after they went on the listing (a fix, a restore or a new order). Approve again to update the listing.", "Photos changed since upload", "Waiting on Kyle", { kind: "approve", label: "Approve again" }));
      } else if (pr.duplicates?.length) {
        add(true, item("aryeo", "aryeo", pr.note ?? "A photo is on the listing twice. Take the extra copy off in Aryeo, then deliver.", "A photo is on the listing twice", "Waiting on Kyle", { kind: "deliver", label: "Removed it: Deliver in Aryeo" }, { link: listingLink }));
      } else if (/different order/i.test(pr.note ?? "")) {
        add(true, item("aryeo", "aryeo", "Aryeo kept a different order for the photos. Check the order on the listing, then deliver.", "Check the order in Aryeo", "Waiting on Kyle", { kind: "deliver", label: "Checked: Deliver in Aryeo" }, { link: listingLink }));
      } else if (pr.state === "WAITING" && pr.note) {
        add(true, item("aryeo", "aryeo", pr.note, clipTo(pr.note, 50), "Waiting on Kyle", { kind: "deliver", label: "Deliver in Aryeo" }, { link: listingLink }));
      }
    }
  }
  // Photos edited in the hub whose old file is still on the listing: Update on Aryeo replaces them
  // (the hub's own upload that changed is "Approve again" above instead; an Update already running is "Sending").
  const toUpdate = input.listingUpdates?.photoIds ?? [];
  if (toUpdate.length && !(pr && ACTIVE_PUSH.has(pr.state)) && !out.some((i) => i.kind === "aryeo" && i.action?.kind === "approve")) {
    const n = toUpdate.length;
    const names = input.listingUpdates.names;
    add(true, item(
      "update", "update",
      `${plural(n, "photo")} edited in the hub (${clipTo(names.slice(0, 3).join(", "), 80)}${names.length > 3 ? ", …" : ""}) still ${n === 1 ? "has its" : "have their"} old file on the Aryeo listing.`,
      `${plural(n, "photo")} to update on Aryeo`,
      "Waiting on Kyle",
      on ? { kind: "update", label: "Update on Aryeo", photoIds: toUpdate } : null,
      { detail: on ? "Nothing is delivered again and no email goes out." : "The hub's upload is off: download each edit from the photo and replace it on the listing by hand.", link: listingLink },
    ));
  }
  if (!delivered && stage === "DELIVERING" && !(pr && ACTIVE_PUSH.has(pr.state))) {
    add(true, item("confirming", "confirming", "Waiting for Aryeo to confirm the delivery.", "Waiting for Aryeo to confirm", "Waiting on Aryeo", { kind: "verify", label: "Check now" }, { detail: input.deliveryCheckNote }));
  }
  if (stage === "DELIVERY_MISMATCH") {
    add(true, item("mismatch", "mismatch", `The delivery check found a problem: ${(input.deliveryCheckNote ?? "the listing does not match the approved photos").replace(/\.$/, "")}.`, "Delivery check found a problem", "Waiting on Kyle", { kind: "verify", label: "Check again" }, { link: listingLink }));
  }

  const rank = (k: HoldingKind) => {
    if (k === "delivered") return -1;
    const i = (HOLDING_ORDER as readonly string[]).indexOf(k === "redeliver" ? "aryeo" : k);
    return i < 0 ? HOLDING_ORDER.length : i;
  };
  const inOrder = (list: HoldingItem[]) => list.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.kind) - rank(b.x.kind) || a.i - b.i).map((y) => y.x);
  const items = inOrder(out);
  also.splice(0, also.length, ...inOrder(also));

  // ---- nothing holds it ----
  let ready: HoldingView["ready"] = null;
  if (!items.length && !delivered) {
    const next = on ? (APPROVE_STAGES.has(stage) && input.listingUrl ? pushNext(push) : null) : APPROVE_STAGES.has(stage) && stage !== "DELIVERING" ? "mark" : null;
    const personal = (gate?.checks ?? []).some((c) => c.personOnly);
    const sameDay = on && push.sameDayAuto && !personal && stage === "READY" ? "Same-day order: the hub sends it by itself once every check passes, or approve it now." : null;
    if (next === "approve") ready = { text: "Ready to send.", detail: sameDay, action: { kind: "approve", label: "Approve and deliver", upload: true } };
    else if (next === "deliver") ready = { text: "Ready to send. The photos are on the listing.", detail: sameDay, action: { kind: "deliver", label: "Deliver in Aryeo" } };
    else if (next === "mark") ready = { text: "Ready to send.", detail: "The hub's upload is off: deliver in Aryeo, then mark it here.", action: { kind: "mark", label: "Mark as delivering" } };
  }
  const line = items.length ? `${items[0].short}${items.length > 1 ? ` (+${items.length - 1} more)` : ""}` : ready ? "Ready to send" : delivered ? "Delivered" : "";
  const tone: HoldingView["tone"] = items.length ? (items[0].waitingOn === "Waiting on Kyle" || items[0].waitingOn.startsWith("Waiting on Jordan") ? "held" : "waiting") : ready ? "ready" : delivered ? "done" : "waiting";
  return { items, also, ready, line, tone };
}

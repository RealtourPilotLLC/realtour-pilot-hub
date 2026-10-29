import { createHash } from "node:crypto";
import { etAt, etDate, etDayKey, etTime } from "@/lib/datetime";
import { clip, noDashes, scrubMoney } from "@/lib/text";
import { cleanBrief, parseShootBrief } from "@/lib/shoot";
import { isAccessNote, ACCESS_NOTE_LABEL } from "@/lib/specialRequests";
import { HUB_SMS_PREFIX } from "@/lib/hubSms";

// ---------------------------------------------------------------------------
// THE PHOTOGRAPHER BRIEF, THE PURE HALF (Oct 23 2026, Jordan's Kyle dashboard
// spec, "Photographer briefing" and acceptance check 8). Everything here is a
// function of what it is handed: the calendar (which day a run covers, when a
// day's brief is due), the facts of ONE visit (services, access, contact and
// the requests made for it), the words of the text, the material snapshot,
// what changed between two snapshots and the state a brief is in. The reads,
// the sends and the records live in lib/photographerBrief.ts.
//
// No em dashes anywhere in what this file writes.
// ---------------------------------------------------------------------------

// ---- settings -------------------------------------------------------------------

/** The AppSetting row (JSON): the switch and the send time. A missing row is OFF. */
export const BRIEF_SETTING_KEY = "photographer_brief";

export type BriefSettings = {
  /** OFF by default: nothing sends, every status reads "off". */
  enabled: boolean;
  /** Minutes after midnight ET, on the business day before the shoot day. */
  sendMinute: number;
};

export const DEFAULT_BRIEF_SETTINGS: BriefSettings = { enabled: false, sendMinute: 18 * 60 };

/** The times Settings offers: 3 PM to 9 PM ET, every half hour (the cron runs every 5 minutes). */
export const SEND_TIME_CHOICES: readonly number[] = Array.from({ length: 13 }, (_, i) => 15 * 60 + i * 30);

/** A stored row, read defensively: anything unreadable is the default (off, 6 PM). */
export function readBriefSettings(raw: string | null | undefined): BriefSettings {
  let o: Record<string, unknown> = {};
  try {
    const j = JSON.parse(raw ?? "null");
    if (j && typeof j === "object" && !Array.isArray(j)) o = j as Record<string, unknown>;
  } catch { /* the default */ }
  const m = o.sendMinute;
  return {
    enabled: o.enabled === true,
    sendMinute: typeof m === "number" && SEND_TIME_CHOICES.includes(m) ? m : DEFAULT_BRIEF_SETTINGS.sendMinute,
  };
}

/** "6:00 PM", "6:30 PM" */
export function sendTimeWords(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---- the calendar ----------------------------------------------------------------
// Weekdays are business days; holidays are not modelled (lib/datetime says why:
// the business keeps no holiday calendar, and inventing one would move real
// deadlines). A shoot day's brief is due on the business day BEFORE it, so the
// Friday run covers Saturday, Sunday and Monday ("Monday's shoots on Friday").

const dayShift = (dayKey: string, n: number): string => {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
};
const isBusinessDayKey = (dayKey: string): boolean => {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

/** The last business day strictly before `dayKey`. */
export function prevBusinessDayKey(dayKey: string): string {
  let k = dayShift(dayKey, -1);
  while (!isBusinessDayKey(k)) k = dayShift(k, -1);
  return k;
}

/** The first business day strictly after `dayKey`. */
export function nextBusinessDayKey(dayKey: string): string {
  let k = dayShift(dayKey, 1);
  while (!isBusinessDayKey(k)) k = dayShift(k, 1);
  return k;
}

/** When a shoot day's first brief goes out: the send time on the business day before it. */
export function briefDueAt(dayKey: string, s: BriefSettings): Date {
  return etAt(prevBusinessDayKey(dayKey), Math.floor(s.sendMinute / 60), s.sendMinute % 60);
}

/** The shoot days one business day's run covers: every day after it up to and
 *  including the next business day (Friday: Saturday, Sunday, Monday). */
export function daysCoveredBy(runDayKey: string): string[] {
  const out: string[] = [];
  const end = nextBusinessDayKey(runDayKey);
  for (let k = dayShift(runDayKey, 1); k <= end; k = dayShift(k, 1)) out.push(k);
  return out;
}

/** The days the sweep looks at right now: today (late bookings and changes on
 *  the day) through the next business day. */
export function daysInScope(now: Date): string[] {
  const today = etDayKey(now);
  return [today, ...daysCoveredBy(today)];
}

/** "Mon Oct 26" */
export const dayWords = (dayKey: string): string => etDate(etAt(dayKey, 12)).replace(/,/g, "");

// ---- one visit's facts ------------------------------------------------------------

/** The order lines that are not a shoot service. */
const FEE_RE = /\b(fee|fees|tip|tax|discount|coupon|surcharge|travel|rush|same day|deposit|credit)\b/i;
/** A size band ("0-1,999 Sq. Ft.") says nothing to a photographer. */
const SIZE_BAND = /sq\.?\s*f(?:ee)?t|square\s*f/i;

type AryeoItem = { title?: unknown; sub_title?: unknown; subtitle?: unknown; quantity?: unknown; is_canceled?: unknown };

/** "Agent on Camera: Intro Only", "2 x Twilight" (a size band left off). */
function itemWords(title: string, sub: string | null, qty: number): string {
  const t = title.replace(/\s+/g, " ").trim();
  const s = sub && !SIZE_BAND.test(sub) ? sub.replace(/\s+/g, " ").trim() : "";
  return `${qty > 1 ? `${qty} x ` : ""}${t}${s ? `: ${s}` : ""}`;
}

/**
 * The services THIS appointment covers, as Aryeo lists them on it ("Order Items
 * Serviced By This Appointment"): the appointment's own items in its stored
 * payload, else the same block of its brief. Empty when Aryeo lists none. Pure.
 */
export function visitServices(rawJson: string | null | undefined, description: string | null | undefined): string[] {
  const out: string[] = [];
  try {
    const j = JSON.parse(rawJson ?? "null") as { items?: AryeoItem[] } | null;
    for (const it of Array.isArray(j?.items) ? j!.items : []) {
      if (it?.is_canceled === true || typeof it?.title !== "string" || !it.title.trim()) continue;
      if (FEE_RE.test(it.title)) continue;
      const sub = typeof it.sub_title === "string" ? it.sub_title : typeof it.subtitle === "string" ? it.subtitle : null;
      out.push(itemWords(it.title, sub, typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1));
    }
  } catch { /* fall back to the brief's own block */ }
  if (out.length) return [...new Set(out)];
  const block = cleanBrief(description).split(/Order Items Serviced By This Appointment:/i)[1]?.split(/\n\s*\n|Order Notes:|Order Questions:/i)[0] ?? "";
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*[-•]\s*\((\d+)x\)\s*(.+?)\s*$/i);
    if (!m) continue;
    const [title, ...rest] = m[2].split(":");
    if (!title?.trim() || FEE_RE.test(title)) continue;
    out.push(itemWords(title, rest.join(":").trim() || null, Number(m[1]) || 1));
  }
  return [...new Set(out)];
}

/** The whole order's services (a single-visit job whose appointment lists none). */
export function orderServices(items: { title: string; quantity: number; isCanceled?: boolean }[]): string[] {
  return [...new Set(items.filter((i) => !i.isCanceled && i.title.trim() && !FEE_RE.test(i.title)).map((i) => itemWords(i.title, null, i.quantity)))];
}

const BLANK = /^(?:n\/?a|none|no|nothing|-+)\.?$/i;
const flat = (s: string | null | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
/** One sentence as a phone shows it: no dashes, no amounts, one stop at the end, clipped. */
export function tidy(s: string, max = 220): string {
  let t = noDashes(scrubMoney(flat(s))).replace(/\s+-\s+/g, ", ").trim();
  t = clip(t, max);
  return /[.!?…]$/.test(t) || /https?:\/\/\S+$/.test(t) ? t : `${t}.`;
}
/** The words a sentence is compared by (case, punctuation and spacing ignored). */
export const sentenceKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Who will be there, or that nobody will (shootDayText's rule, kept in step). */
const PRESENCE =
  /\b(?:vacant|occupied)\b|\b(?:i|we|seller|sellers|owner|owners|homeowner|homeowners|tenant|tenants|agent|buyer|buyers|someone|nobody|no one)\b[^.!?\n]{0,40}?\b(?:be (?:there|home|present|on ?site)|present at|let (?:you|him|her|them) in|meet (?:you|him|her|them))\b/i;
const isAccessSentence = (s: string) => isAccessNote(s) || PRESENCE.test(s);

/** A note split into sentences (a blank or "n/a" note is none). */
export function sentencesOf(text: string | null | undefined): string[] {
  const f = flat(text);
  if (!f || BLANK.test(f)) return [];
  return f.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !BLANK.test(s));
}

// ---- the request kinds -------------------------------------------------------------

export type RequestKind = "must" | "leave" | "request";
const MUST_FIRST = /\b(?:don'?t|do not|dont)\s+(?:forget|miss)\b|\bmake sure not to miss\b/i;
const LEAVE = /\b(?:don'?t|do not|dont|never)\s+(?:shoot|photograph|film|capture|include|show|get|fly|use|need)\b|\bno need\b|\bavoid\b|\bskip\b|\bleave out\b|\bexclude\b|\bwithout\b|\bnot (?:needed|necessary|required)\b|\bno (?:drone|aerials?|video|photos?|interiors?|exteriors?|twilight|people|faces|cars?)\b/i;
const MUST = /\bmake sure\b|\bbe sure\b|\bmust\b|\bneeds? (?:to )?(?:get|shoot|capture|include|have)\b|\bplease (?:get|shoot|capture|include|grab|photograph|film)\b|\bcapture\b|\bget (?:a |an |some |the )?(?:shots?|photos?|pictures?|footage|video|clips?) of\b|\bhighlight\b|\bfocus on\b|\binclude\b/i;

/** Must get, leave out, or a plain request, by its own words. A label, never a rule. Pure. */
export function requestKind(s: string): RequestKind {
  if (MUST_FIRST.test(s)) return "must";
  if (LEAVE.test(s)) return "leave";
  if (MUST.test(s)) return "must";
  return "request";
}

// ---- the visit -----------------------------------------------------------------------

export type VisitFactsInput = {
  appointmentId: string;
  startAt: Date;
  description: string | null;
  rawJson: string | null;
  /** This job's live (not cancelled) visits, any order: numbering and the previous visit. */
  liveVisits: { id: string; startAt: Date | null }[];
  project: {
    id: string;
    title: string;
    addressLine: string | null;
    city: string | null;
    orderItems: { title: string; quantity: number; isCanceled?: boolean }[];
    /** When the whole job was delivered: anything asked after it is a revision. */
    deliveredAt: Date | null;
    /** When its photos were delivered: a PHOTO request after it is a photo revision (it is what
     *  reopens the photo job, photoDelivery/clientAsked). Other requests made between visits are
     *  the next visit's. */
    photosDeliveredAt: Date | null;
  };
  /** SPECIAL_REQUEST rows on the job (staff-typed, client access notes, "Client request (…)" copies). */
  jobLines: { body: string; createdAt: Date }[];
  /** The client's special requests on the job (text, email, call, staff), any state but withdrawn. */
  asks: { summary: string | null; text: string; askedAt: Date; medium?: string | null }[];
  /** When each sentence of the Aryeo order's notes was first seen (lib/photographerBrief's
   *  registry): an ISO time, or null for "there at the booking". Absent = never seen before now. */
  firstSeen: Record<string, string | null> | null;
  now: Date;
};

export type VisitFacts = {
  appointmentId: string;
  projectId: string;
  startISO: string;
  time: string;
  street: string;
  /** "266 Richard Dr, Allentown", or "Address not set yet" */
  address: string;
  /** visit n of N on this job (null on a single-visit job) */
  visit: { n: number; of: number } | null;
  services: string[];
  /** Said instead of services when the visit lists none ("None listed on this visit in Aryeo, ask Kyle"). */
  servicesNote: string | null;
  access: string[];
  contact: string | null;
  must: string[];
  leave: string[];
  requests: string[];
  /** Older notes on the job (an earlier visit's, the booking's on a later visit). The page shows them folded; the text never carries them. */
  earlier: string[];
  /** The Aryeo order note sentences this build saw (the registry records them). */
  orderSentences: string[];
};

const addressOf = (p: VisitFactsInput["project"]): { street: string; address: string } => {
  const line = p.addressLine?.trim() && !/^\[No address/i.test(p.addressLine) ? p.addressLine.trim() : null;
  const titleStreet = p.title.split(",")[0].trim();
  if (!line && /^\[No address/i.test(titleStreet)) return { street: "Address not set yet", address: "Address not set yet" };
  const street = line ?? titleStreet;
  const city = p.city?.trim() || (p.title.split(",")[1]?.trim() ?? "");
  return { street, address: city && !street.toLowerCase().includes(city.toLowerCase()) ? `${street}, ${city}` : street };
};

const MAX_ITEM = 220;

/** Aryeo's "Will you or the seller be present?" answer as a sentence: "Agent will be there", "Vacant". */
export function presenceWords(v: string): string {
  const t = flat(v);
  if (/^(?:vacant|empty|no one|nobody)\b/i.test(t)) return "Vacant, nobody will be there";
  if (t.split(/\s+/).length <= 4 && !/\b(?:will|be|is|are|present|there|home)\b/i.test(t)) return `${t} will be there`;
  return `Who's there: ${t}`;
}

/**
 * One visit, as its photographer needs it. Pure.
 *
 * THIS VISIT'S, NOT THE ORDER'S. Services are the appointment's own items. On
 * a job with more than one visit, a request belongs to the visit it was made
 * for: one made (or an order note first seen) after the previous visit started
 * is this visit's; anything older was the earlier visit's and goes to
 * `earlier` (615 Cliff Ln: "Exteriors only" was visit 1's, never visit 3's).
 * On a later visit an order note the hub has no first-seen time for counts as
 * the booking's. Revisions never appear: anything asked after the job was
 * delivered, or a photo request after the photos were (the ask that reopens
 * the photo job); nor does anything made after this visit started.
 */
export function visitFacts(i: VisitFactsInput): VisitFacts {
  const { street, address } = addressOf(i.project);
  const visits = i.liveVisits.filter((v) => v.startAt).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());
  const idx = visits.findIndex((v) => v.id === i.appointmentId);
  const prevStart = idx > 0 ? visits[idx - 1].startAt! : null;
  const start = i.startAt;
  // After the job was delivered nothing is a shoot request any more; after the photos went, a photo request is a revision.
  const jobDone = i.project.deliveredAt;
  const photosDone = i.project.photosDeliveredAt;

  // Services: the visit's own; the order's only when it is the job's one visit.
  let services = visitServices(i.rawJson, i.description);
  let servicesNote: string | null = null;
  if (!services.length) {
    if (visits.length <= 1) services = orderServices(i.project.orderItems);
    if (!services.length) servicesNote = visits.length > 1 ? "None listed on this visit in Aryeo. Ask Kyle." : "Nothing on the order yet. Ask Kyle.";
  }

  const parsed = parseShootBrief(cleanBrief(i.description));
  const access: string[] = [];
  const pushAccess = (s: string) => { const t = tidy(s, MAX_ITEM); if (!access.some((a) => sentenceKey(a) === sentenceKey(t))) access.push(t); };
  if (parsed?.lockbox) pushAccess(`Lockbox or door code: ${parsed.lockbox}`);
  if (parsed?.access) pushAccess(parsed.access);
  if (parsed?.presence) pushAccess(presenceWords(parsed.presence));

  const must: string[] = [];
  const leave: string[] = [];
  const requests: string[] = [];
  const earlier: string[] = [];
  const seen = new Set<string>();
  const place = (raw: string, mine: boolean, prefix = "") => {
    const t = tidy(`${prefix}${raw}`, MAX_ITEM);
    const k = sentenceKey(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (!mine) { earlier.push(t); return; }
    const kind = requestKind(raw);
    (kind === "must" ? must : kind === "leave" ? leave : requests).push(t);
  };

  // The Aryeo order's words (special instructions, then the order notes): access
  // sentences go to access; the rest are this visit's on a first or only visit,
  // and on a later visit only when first seen after the previous visit started.
  const orderSentences: string[] = [];
  for (const block of [parsed?.special ?? null, parsed?.orderNotes ?? null]) {
    for (const s of sentencesOf(block)) {
      if (isAccessSentence(s)) { pushAccess(s); continue; }
      orderSentences.push(s);
      let mine = true;
      if (prevStart) {
        const fs = i.firstSeen?.[sentenceKey(s)];
        // undefined: never seen before this build (new now); null: the booking's.
        const at = fs === undefined ? (i.firstSeen ? i.now : null) : fs ? new Date(fs) : null;
        mine = !!at && at.getTime() > prevStart.getTime();
      }
      place(s, mine);
    }
  }
  // The client's standing note on the booking (the customer's own "Notes:"
  // line, never the "Order Notes:" block), every visit.
  const customerNote = (() => {
    const m = cleanBrief(i.description).match(/(?:^|\n)[ \t]*Notes:[ \t]*([\s\S]*?)(?:\n\s*\n|\n[ \t]*Order Items|$)/i);
    const v = flat(m?.[1]);
    return v && !BLANK.test(v) ? v : null;
  })();
  if (customerNote) place(customerNote, true, "Client note: ");

  // What the office typed on the job, and the client's access notes, by when.
  const lines = [...i.jobLines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const l of lines) {
    if (l.createdAt >= start) continue; // made after this visit started
    const body = l.body.trim();
    if (body.startsWith(`${ACCESS_NOTE_LABEL} (`)) {
      // How to get in is the property's, whichever visit it was sent for.
      pushAccess(body.replace(/^Client access note \([^)]*\):\s*/i, ""));
      continue;
    }
    // A client's own words arrive as their asks below (a "Client request (…)" copy is not the live one).
    if (/^Client request \(/i.test(body)) continue;
    if (jobDone && l.createdAt >= jobDone) continue; // after the job was delivered: a revision
    for (const s of sentencesOf(body)) {
      if (isAccessSentence(s)) { pushAccess(s); continue; }
      place(s, !prevStart || l.createdAt > prevStart);
    }
  }
  // The client's requests, by when they asked.
  for (const a of [...i.asks].sort((x, y) => x.askedAt.getTime() - y.askedAt.getTime())) {
    if (a.askedAt >= start) continue; // made after this visit started
    if (jobDone && a.askedAt >= jobDone) continue; // a revision of the delivered job
    if (a.medium === "photo" && photosDone && a.askedAt >= photosDone) continue; // a revision of the delivered photos
    const words = (a.summary?.trim() || a.text).trim();
    if (!words) continue;
    if (isAccessSentence(words)) { pushAccess(words); continue; }
    place(words, !prevStart || a.askedAt > prevStart, "Client: ");
  }

  // The on-site contact: the customer on the booking (the agent), by name and number.
  const name = cleanBrief(i.description).match(/Name:\s*(.+)/i)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const phone = cleanBrief(i.description).match(/Phone:\s*([()\d\s+.-]{7,20})/i)?.[1]?.trim() || null;
  const contact = name || phone ? noDashes([name, phone].filter(Boolean).join(" ")) : null;

  return {
    appointmentId: i.appointmentId,
    projectId: i.project.id,
    startISO: start.toISOString(),
    time: etTime(start),
    street,
    address,
    visit: visits.length > 1 && idx >= 0 ? { n: idx + 1, of: visits.length } : null,
    services,
    servicesNote,
    access,
    contact,
    must,
    leave,
    requests,
    earlier,
    orderSentences,
  };
}

// ---- the day ---------------------------------------------------------------------------

export type BriefDay = {
  teamMemberId: string;
  name: string;
  day: string;
  shoots: VisitFacts[];
};

/** The facts that, changed, need an updated brief and a new Got it. Weather, the
 *  folded earlier notes and anything else on the page are not among them. */
export type MaterialShoot = { a: string; p: string; t: string; addr: string; svc: string[]; acc: string[]; con: string | null; req: string[] };
export type MaterialSnapshot = MaterialShoot[];

export function materialOf(shoots: VisitFacts[]): MaterialSnapshot {
  return [...shoots]
    .sort((x, y) => x.startISO.localeCompare(y.startISO) || x.appointmentId.localeCompare(y.appointmentId))
    .map((s) => ({
      a: s.appointmentId,
      p: s.projectId,
      t: s.startISO,
      addr: s.address,
      svc: s.servicesNote ? [s.servicesNote] : s.services,
      acc: s.access,
      con: s.contact,
      req: [...s.must.map((x) => `must:${x}`), ...s.leave.map((x) => `leave:${x}`), ...s.requests.map((x) => `req:${x}`)],
    }));
}

export function digestOf(m: MaterialSnapshot): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 32);
}

export function parseMaterial(v: unknown): MaterialSnapshot | null {
  return Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as MaterialShoot).a === "string" && typeof (x as MaterialShoot).t === "string") ? (v as MaterialSnapshot) : null;
}

export type BriefChange = { appointmentId: string; street: string; words: string; startedBefore: boolean };

const streetOfAddr = (addr: string) => addr.split(",")[0].trim() || addr;

/** A quoted line inside a change, at most this long (the page has the whole of it). */
const CHANGE_QUOTE_CHARS = 100;
const quoted = (x: string) => `"${clip(x, CHANGE_QUOTE_CHARS).replace(/\.$/, "")}"`;
const REQ_KIND: Record<string, string> = { must: "must-get", leave: "leave-out", req: "request" };

/**
 * One list's change in words: what was added and what was removed, each quoted
 * (Oct 28 2026: James got "825 State St requests changed" and could not see
 * what). `kindOf` names an item ("request", "must-get"); null when nothing was
 * added or removed (only the order moved).
 */
function listChanges(street: string, before: string[], after: string[], kindOf: (x: string) => { kind: string; text: string }): string[] | null {
  const added = after.filter((x) => !before.includes(x)).map(kindOf);
  const removed = before.filter((x) => !after.includes(x)).map(kindOf);
  if (!added.length && !removed.length) return null;
  // One line of a kind reworded (the Smart Brain merging a client's message
  // into the request it already had): before and after, in one line (James's
  // call, Oct 29 2026: "Show the actual changed information").
  if (added.length === 1 && removed.length === 1 && added[0].kind === removed[0].kind) {
    return [`${street}: ${removed[0].kind} changed from ${quoted(removed[0].text)} to ${quoted(added[0].text)}`];
  }
  return [
    ...added.map((x) => `${street}: new ${x.kind} ${quoted(x.text)}`),
    ...removed.map((x) => `${street}: ${x.kind} removed ${quoted(x.text)}`),
  ];
}

const reqKind = (x: string) => {
  const i = x.indexOf(":");
  const kind = i > 0 ? REQ_KIND[x.slice(0, i)] : undefined;
  return kind ? { kind, text: x.slice(i + 1) } : { kind: "request", text: x };
};

/**
 * What changed between the brief that went (or was acknowledged) and now, in
 * plain words, one line per change: the new request itself, the new time, the
 * new contact, never just "requests changed". A change to a shoot that had
 * already started (before and after) is listed with startedBefore so callers
 * can leave it out: nobody needs a new brief for a visit already under way. Pure.
 */
export function changesBetween(before: MaterialSnapshot, after: MaterialSnapshot, now: Date): BriefChange[] {
  const out: BriefChange[] = [];
  const old = new Map(before.map((s) => [s.a, s]));
  const cur = new Map(after.map((s) => [s.a, s]));
  const started = (iso: string | undefined) => !!iso && Date.parse(iso) <= now.getTime();
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  // "10:00 AM", or "Tue Oct 27 10:00 AM" when the shoot moved to another day.
  const whenWords = (iso: string, from: string) => {
    const d = new Date(iso);
    return etDayKey(d) === etDayKey(new Date(from)) ? etTime(d) : `${etDate(d).replace(/,/g, "")} ${etTime(d)}`;
  };
  for (const s of after) {
    const o = old.get(s.a);
    const street = streetOfAddr(s.addr);
    if (!o) {
      out.push({ appointmentId: s.a, street, words: `New shoot: ${street} at ${etTime(new Date(s.t))}`, startedBefore: started(s.t) });
      continue;
    }
    const past = started(s.t) && started(o.t);
    if (o.t !== s.t) out.push({ appointmentId: s.a, street, words: `${street} is now at ${whenWords(s.t, o.t)} (was ${etTime(new Date(o.t))})`, startedBefore: past });
    if (o.addr !== s.addr) out.push({ appointmentId: s.a, street, words: `${streetOfAddr(o.addr)} address is now ${s.addr}`, startedBefore: past });
    const push = (words: string) => out.push({ appointmentId: s.a, street, words, startedBefore: past });
    if (!same(o.svc, s.svc)) (listChanges(street, o.svc, s.svc, (x) => ({ kind: "service", text: x })) ?? [`${street} services changed`]).forEach(push);
    if (!same(o.acc, s.acc)) (listChanges(street, o.acc, s.acc, (x) => ({ kind: "access note", text: x })) ?? [`${street} access changed`]).forEach(push);
    if (o.con !== s.con) push(s.con ? `${street}: on-site contact is now ${s.con}${o.con ? ` (was ${o.con})` : ""}` : `${street}: no on-site contact now (was ${o.con})`);
    if (!same(o.req, s.req)) (listChanges(street, o.req, s.req, reqKind) ?? [`${street} requests changed`]).forEach(push);
  }
  for (const o of before) {
    if (cur.has(o.a)) continue;
    const street = streetOfAddr(o.addr);
    out.push({ appointmentId: o.a, street, words: `${street} is off your schedule`, startedBefore: started(o.t) });
  }
  return out;
}

/** The changes that matter now (the shoot has not started). */
export const liveChanges = (before: MaterialSnapshot, after: MaterialSnapshot, now: Date): BriefChange[] =>
  changesBetween(before, after, now).filter((c) => !c.startedBefore);

// ---- the words ----------------------------------------------------------------------------

/** The hub marker every team text carries (lib/hubSms): how the OpenPhone webhook knows the hub wrote it. */
export const BRIEF_PREFIX = HUB_SMS_PREFIX;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
/** In the text, at most this many request lines per shoot; the rest are on the page. */
export const TEXT_ITEMS_PER_SHOOT = 4;

/** In the text, each line at most this long; the page has the whole of it. */
const TEXT_ITEM_CHARS = 140;

/** "Label: a; b; c." with no stop after a link and no "!." */
function listLine(label: string, items: string[]): string {
  const body = items.map((x) => clip(x, TEXT_ITEM_CHARS).replace(/\.$/, "")).join("; ");
  return /[.!?…]$/.test(body) || /https?:\/\/\S+$/.test(body) ? `${label}: ${body}` : `${label}: ${body}.`;
}

/** One shoot, as the text carries it, one fact a line (Jordan, Oct 28 2026:
 *  "make sure text messages are formatted nicer for larger team text message
 *  notifications"; the brief used to run as one block per shoot):
 *  "1) 9:00 AM, 266 Richard Dr, Allentown\nServices: …\nAccess: …\nContact: …"
 *  Compact (a long day) leaves the contact and the earlier-visit line to the page. */
export function shootLine(s: VisitFacts, n: number, items: number = TEXT_ITEMS_PER_SHOOT, compact = false): string {
  const parts: string[] = [`${n}) ${s.time}, ${s.address}${s.visit ? ` (visit ${s.visit.n} of ${s.visit.of})` : ""}`];
  parts.push(s.servicesNote ? `Services: ${s.servicesNote}` : listLine("Services", s.services));
  if (s.access.length) parts.push(listLine("Access", s.access));
  if (s.contact && !compact) parts.push(`Contact: ${s.contact}.`);
  let left = items;
  let more = 0;
  for (const [label, list] of [["Must get", s.must], ["Leave out", s.leave], ["Requests", s.requests]] as const) {
    if (!list.length) continue;
    const take = list.slice(0, Math.max(0, left));
    more += list.length - take.length;
    left -= take.length;
    if (take.length) parts.push(listLine(label, take));
  }
  if (more > 0) parts.push(`(${more} more on the brief page.)`);
  if (s.earlier.length && !compact) parts.push("Notes from the earlier visit are on the brief page, not repeated here.");
  return noDashes(parts.join("\n"));
}

/**
 * THE LONGEST BRIEF TEXT (Oct 29 2026). James never got his Wed Oct 28 brief
 * or its update: at 907 and 1,040 characters OpenPhone took both and no phone
 * ever confirmed them, while every brief under 800 characters was confirmed
 * within seconds (October: every hub text under 700 characters confirmed, 5 of
 * the 6 over 900 never). The hub marker's emoji makes a text 67 characters a
 * part, so this keeps a brief to about ten parts; the page has everything.
 */
export const BRIEF_TEXT_MAX = 640;

/** One line per shoot, nothing else: the last resort for a long day. */
const bareShoot = (s: VisitFacts, n: number) => `${n}) ${s.time}, ${s.street}${s.visit ? ` (visit ${s.visit.n} of ${s.visit.of})` : ""}`;

/** The first brief of the day. Plain, no dashes: the heading, each shoot as its
 *  own block with a blank line between, and the page link alone at the end.
 *  Kept under BRIEF_TEXT_MAX: fewer request lines, then no contact lines (the
 *  client's must-gets and leave-outs outrank a phone number the page has), then
 *  the shoots one line each (the page has the rest). Pure. */
export function composeBriefText(d: BriefDay, link: string): string {
  const head = `${BRIEF_PREFIX}: ${firstName(d.name)}, your shoot${d.shoots.length === 1 ? "" : "s"} for ${dayWords(d.day)}`;
  const tail = `Full brief, then tap Got it:\n${link}`;
  const build = (body: string[]) => noDashes([head, ...body, tail].join("\n\n"));
  let text = "";
  for (const [items, compact] of [[TEXT_ITEMS_PER_SHOOT, false], [2, false], [2, true], [1, true], [0, true]] as const) {
    text = build(d.shoots.map((s, i) => shootLine(s, i + 1, items, compact)));
    if (text.length <= BRIEF_TEXT_MAX) return text;
  }
  return build([d.shoots.map((s, i) => bareShoot(s, i + 1)).join("\n"), "Services, access, contacts and requests are on the brief page."]);
}

/** In an update, at most this many change lines; the page lists them all. */
const UPDATE_LINES = 5;

/** An updated brief: what changed (one line each) and the link, nothing else
 *  (Oct 29 2026: the whole day again made James's 1,040-character update one
 *  that never arrived, and buried the one line that mattered). Pure. */
export function composeUpdateText(d: BriefDay, changes: string[], link: string): string {
  const head = `${BRIEF_PREFIX}: ${firstName(d.name)}, your ${dayWords(d.day)} brief changed`;
  const tail = !d.shoots.length ? `You have no shoots that day now:\n${link}` : `Please open it and tap Got it again:\n${link}`;
  const whatOf = (lines: string[], more: number) =>
    !lines.length ? "Details changed."
    : lines.length === 1 && !more ? `What changed: ${lines[0]}.`
    : `What changed:\n${lines.map((c) => `• ${c}`).join("\n")}${more ? `\n(${more} more on the brief page.)` : ""}`;
  let text = "";
  for (let n = Math.min(UPDATE_LINES, changes.length); n >= 1 || !changes.length; n--) {
    text = noDashes([head, whatOf(changes.slice(0, n), changes.length - n), tail].join("\n\n"));
    if (text.length <= BRIEF_TEXT_MAX || n <= 1) return text;
  }
  return text;
}

// ---- the record and the state ------------------------------------------------------------

export type BriefState = "off" | "pending" | "sent" | "failed" | "acknowledged" | "changed";

export type BriefSend = {
  n: number;
  at: string;
  kind: "first" | "update" | "resend";
  /** the person who pressed Send brief now; null = the hub */
  by: string | null;
  outcome: "sent" | "unconfirmed" | "failed";
  error?: string;
  changes?: string[];
  digest: string;
};

/** One photographer's brief for one day (AppSetting `photographer_brief:day:<member>:<day>`). */
export type BriefRecord = {
  v: 1;
  teamMemberId: string;
  day: string;
  /** a send in flight (the atomic claim) */
  claim: { id: string; at: string; n: number } | null;
  sends: BriefSend[];
  /** what the last good send carried (sent, or unconfirmed: it may have gone) */
  sent: { n: number; at: string; digest: string; snapshot: MaterialSnapshot; outcome: "sent" | "unconfirmed" } | null;
  firstSentAt: string | null;
  /** the photographer's latest Got it, with what they acknowledged */
  ack: { at: string; by: string; userId: string | null; digest: string; snapshot: MaterialSnapshot } | null;
  acks: { at: string; by: string; digest: string }[];
  /** the last failure since the last good send */
  failed: { at: string; why: string; attempts: number } | null;
};

export const emptyRecord = (teamMemberId: string, day: string): BriefRecord => ({ v: 1, teamMemberId, day, claim: null, sends: [], sent: null, firstSentAt: null, ack: null, acks: [], failed: null });

export function parseRecord(v: string | null | undefined, teamMemberId: string, day: string): BriefRecord | null {
  try {
    const j = JSON.parse(v ?? "null") as Partial<BriefRecord> | null;
    if (!j || typeof j !== "object" || j.v !== 1) return null;
    const sentSnap = j.sent ? parseMaterial(j.sent.snapshot) : null;
    const ackSnap = j.ack ? parseMaterial(j.ack.snapshot) : null;
    return {
      ...emptyRecord(teamMemberId, day),
      ...j,
      sends: Array.isArray(j.sends) ? j.sends : [],
      acks: Array.isArray(j.acks) ? j.acks : [],
      sent: j.sent && sentSnap ? { ...j.sent, snapshot: sentSnap } : null,
      ack: j.ack && ackSnap ? { ...j.ack, snapshot: ackSnap } : null,
    } as BriefRecord;
  } catch {
    return null;
  }
}

/** The acknowledgment still holds: nothing that matters changed since the Got it. */
export function ackHolds(r: BriefRecord | null, current: MaterialSnapshot, now: Date): boolean {
  return !!r?.ack && liveChanges(r.ack.snapshot, current, now).length === 0;
}

export type ChangeLine = { at: string | null; words: string; appointmentId: string | null };

/**
 * WHAT CHANGED, for whoever is asked for a Got it (Oct 28 2026, and James's
 * call: "Show the actual changed information before asking James to
 * acknowledge it"). Before any Got it: every update texted since the first
 * brief, plus what changed since the last text. After a Got it that no longer
 * holds: exactly what changed since he confirmed. An update kept only its
 * words, so its shoot is the one whose street the words name. The brief page,
 * the creative's desk row and the shoot screen all read this. Pure.
 */
export function briefChangeLines(
  record: BriefRecord | null,
  current: MaterialSnapshot | null,
  shoots: { appointmentId: string; street: string }[],
  now: Date,
): { holds: boolean; changed: ChangeLine[]; confirmedUpdates: ChangeLine[] } {
  if (!current) return { holds: false, changed: [], confirmedUpdates: [] };
  const holds = ackHolds(record, current, now);
  const shootOf = (words: string) => shoots.find((s) => words.includes(s.street))?.appointmentId ?? null;
  const updates: ChangeLine[] = (record?.sends ?? [])
    .filter((s) => s.kind === "update" && s.outcome !== "failed")
    .flatMap((s) => (s.changes ?? []).map((words) => ({ at: s.at as string | null, words, appointmentId: shootOf(words) })));
  const live = (from: MaterialSnapshot | undefined): ChangeLine[] =>
    from ? liveChanges(from, current, now).map((c) => ({ at: null, words: c.words, appointmentId: c.appointmentId })) : [];
  const changed = holds ? [] : record?.ack ? live(record.ack.snapshot) : [...updates, ...live(record?.sent?.snapshot)];
  return { holds, changed, confirmedUpdates: holds ? updates : [] };
}

/** The lines for one shoot's row: its own changes, else (a change elsewhere on
 *  the day it shares a Got it with) the day's. Pure. */
export function changesForShoot(changed: ChangeLine[], appointmentId: string): string[] {
  const own = changed.filter((c) => c.appointmentId === appointmentId);
  return (own.length ? own : changed).map((c) => c.words);
}

export type BriefStatus = { state: BriefState; sentAt: string | null; ackAt: string | null; why: string | null };

/** How long before the day's first shoot an unacknowledged brief needs a person. */
export const ACK_WARN_MS = 2 * 60 * 60_000;

/**
 * The state of one photographer's brief for one day. Pure.
 *   off           the switch is off (nothing sends)
 *   pending       not sent yet (why: when it goes, or what is stopping it)
 *   sent          sent, no Got it yet (why only when the first shoot is within 2 hours)
 *   failed        the send failed (why: the reason)
 *   acknowledged  Got it, and nothing material changed since
 *   changed       an update went (or is going) out; a new Got it is needed
 */
export function briefStateOf(o: {
  enabled: boolean;
  record: BriefRecord | null;
  current: MaterialSnapshot;
  firstShootAt: Date | null;
  dueAt: Date;
  now: Date;
  /** a reason nothing can be sent (no photographer, no phone), from the reads */
  blocker: string | null;
  name: string;
}): BriefStatus {
  const r = o.record;
  const sentAt = r?.firstSentAt ?? null;
  const ackAt = r?.ack?.at ?? null;
  if (!o.enabled) return { state: "off", sentAt, ackAt, why: "The photographer brief is switched off (Settings, Internal alerts)." };
  const first = firstName(o.name);
  const soon = !!o.firstShootAt && o.now.getTime() >= o.firstShootAt.getTime() - ACK_WARN_MS;
  const urgent = soon && o.firstShootAt ? ` First shoot ${etTime(o.firstShootAt)}.` : "";
  if (!r?.sent) {
    if (r?.failed) return { state: "failed", sentAt, ackAt, why: noDashes(`Not sent: ${r.failed.why}`) };
    if (o.blocker) return { state: o.now >= o.dueAt ? "failed" : "pending", sentAt, ackAt, why: noDashes(`${o.now >= o.dueAt ? "Not sent" : "Will not send"}: ${o.blocker}`) };
    if (o.now < o.dueAt) return { state: "pending", sentAt, ackAt, why: `Goes out ${dayWords(etDayKey(o.dueAt))} at ${etTime(o.dueAt)}.` };
    if (o.firstShootAt && o.now >= o.firstShootAt) return { state: "pending", sentAt, ackAt, why: "Not sent before the day's first shoot." };
    return { state: "pending", sentAt, ackAt, why: "Going out now." };
  }
  if (r.sent.outcome === "unconfirmed") {
    // It may have gone, so the hub never sends it again by itself (no duplicate texts); a person decides.
    return { state: "failed", sentAt, ackAt, why: "OpenPhone did not confirm the text; it may have gone. Check Connections, then Send brief now." };
  }
  if (ackHolds(r, o.current, o.now)) return { state: "acknowledged", sentAt, ackAt, why: null };
  const pending = liveChanges(r.sent.snapshot, o.current, o.now);
  if (r.failed && Date.parse(r.failed.at) > Date.parse(r.sent.at)) {
    return { state: "failed", sentAt, ackAt, why: noDashes(`Update not sent: ${r.failed.why}`) };
  }
  if (pending.length) {
    return { state: "changed", sentAt, ackAt, why: noDashes(`Changed: ${pending.map((c) => c.words).join("; ")}. The update is going out.${urgent}`) };
  }
  const updated = !!r.ack || r.sends.some((s) => s.kind === "update" && s.outcome !== "failed");
  if (updated) {
    const lastUpdate = [...r.sends].reverse().find((s) => s.kind === "update" && s.outcome !== "failed");
    const what = lastUpdate?.changes?.length ? `Changed: ${lastUpdate.changes.join("; ")}. ` : "";
    return { state: "changed", sentAt, ackAt, why: noDashes(`${what}Waiting for ${first}'s new Got it.${urgent}`) };
  }
  return { state: "sent", sentAt, ackAt, why: soon ? noDashes(`Not acknowledged yet.${urgent}`) : null };
}

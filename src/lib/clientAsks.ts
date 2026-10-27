import "server-only";
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { EMPTY_COUNTS, type JobCounts } from "@/lib/opsCounts";
import { clip, scrubMoney } from "@/lib/text";
import { etAt, etDateTime, etDayKey } from "@/lib/datetime";
import { isSyntheticClientRow } from "@/lib/testClients";
import { getCurrentUser } from "@/lib/auth/user";
// Not lib/auth/guards: that pulls in more than this file needs (and breaks the live scripts that read it).
import { authEnforcedNow } from "@/lib/auth/enforced";

// ---------------------------------------------------------------------------
// OPEN CLIENT ASKS (Oct 19 2026). Jordan: "In the review room, before it's
// approved, any open issues with the client via text message or email should
// be shown ... Heather needs lot lines that are correct ... I don't want it to
// deliver before Kyle was able to confirm that the lot lines look correct."
// And Kyle's main screen: "special requests that we have from clients, make
// sure that these are correct" and "scheduling requests or rescheduling
// requests, follow up with that".
//
// Until now an ask lived only in a reply task, and a reply task closes the
// moment we send ANY reply (tasks.closeReplyForOutbound): Heather's "It needs
// to have all 4 lots overlayed" closed one second after Kyle's "Got it, we'll
// start working on those now." A ClientAsk is the ask itself:
//
//   · SPECIAL_REQUEST: what a client wants on, or done to, work we have not
//     delivered yet ("all 4 lots overlaid like the Pennfield output"). From a
//     text, email or call it HOLDS that job's delivery for its medium until a
//     person presses Confirmed (checked on the finished work) or Not needed.
//     An Aryeo order note or an add-on that needs checking (Lot Lines,
//     Virtual Twilight, Virtual Staging) is shown to the reviewer and Kyle but
//     never holds anything.
//   · SCHEDULING: the client wants a shoot or session booked, moved or
//     cancelled; a move or cancel seen in Aryeo; a portal session request.
//     Never holds delivery.
//
// THE RULE: OUR REPLY NEVER CLOSES AN ASK. Nothing in the reply machinery
// touches this table. An ask closes when a person marks it (Done, Confirmed,
// Not needed), when the client withdraws it in the conversation
// (revisionNotNeeded.reviewAsksAgainstConversation), or, for a portal session
// request, when Aryeo confirms or cancels the session (sessionRequests).
//
// Asks on a job we already delivered are NOT filed here: those become revision
// briefs (comms.raiseRevision) and the revision machinery owns them. One
// exception (Oct 21 2026, 859 N Lawrence St): a request about photos the photo
// job already delivered is filed too (comms, photoDelivery/clientAsked), so it
// sits on the reopened photo job until it is done; asked after the delivery,
// it does not close with it (closesOnDelivery).
//
// SIMPLIFIED (Oct 19 2026, evening audit). Only a client's own words (a text,
// an email, a call) or an ask staff typed for them is an ask:
//   · an Aryeo order note or an add-on is no longer filed: it shows on the
//     job's "Before you send" box as a note (lib/jobChecks);
//   · a portal session request or a move/cancel seen in Aryeo is no longer
//     filed: the portal desk task and the appointment bell already cover them
//     (scheduling asks from texts and emails stay);
//   · every open ask on a job closes when that job is delivered (DONE, "the
//     job was delivered"; closeAsksOnDeliveredJobs, swept every five minutes),
//     and Kyle's boards leave delivered jobs out at once;
//   · a job's open requests are checked with ONE press (confirmAsks), not one
//     per message: Barry Rd had six rows.
// Rows filed before this change stay readable; the boards hide the kinds that
// are no longer asks (scripts/_fix/oct19/asks-simplify.ts closes them).
// ---------------------------------------------------------------------------

export type AskKind = "SPECIAL_REQUEST" | "SCHEDULING";
export type AskState = "OPEN" | "DONE" | "CONFIRMED" | "NOT_NEEDED";
export type AskMediumValue = "video" | "photo" | "both" | "unclear";
/** "wrapup" (Oct 21 2026): the photographer's removal notes, filed by Photo Delivery (photoDelivery/clientAsked) so they are ticked off like a request; never on the boards.
 *  Photo Delivery also files the order's photo notes again under "order_note" (dedupe key "photo-order-note:…"), for the photo job only. */
export type AskSource = "text" | "email" | "call" | "order_note" | "portal" | "staff" | "aryeo" | "wrapup";

export const ASK_KINDS: readonly AskKind[] = ["SPECIAL_REQUEST", "SCHEDULING"];
const MEDIA: readonly AskMediumValue[] = ["video", "photo", "both", "unclear"];
/** Where a client's own words came from: these hold a special request's job. */
const HOLDING_SOURCES = new Set<string>(["text", "email", "call"]);
/** What is an ask since Oct 19 2026: the client's own words, or what staff typed for them. */
export const ASK_SOURCES: readonly string[] = ["text", "email", "call", "staff"];
const ASK_SOURCE_SET = new Set<string>(ASK_SOURCES);
/** A row of a kind no longer filed (order notes, add-ons, portal, Aryeo): hidden from the boards. */
export function isLiveAskSource(source: string | null | undefined): boolean {
  return ASK_SOURCE_SET.has(String(source ?? ""));
}
const HOUR = 3_600_000;
/** A special request still open this long is behind, whatever the job's promise says. */
export const SPECIAL_BEHIND_HOURS = 48;
/** A scheduling ask still open this long is behind. */
export const SCHEDULING_BEHIND_HOURS = 24;
/** A move or cancel seen in Aryeo is a follow-up for this long, then it drops off by itself. */
export const ARYEO_CHANGE_WINDOW_HOURS = 48;

export type HoldingAsk = {
  id: string;
  /** One line, in plain words: what the client wants checked. */
  summary: string;
  askedBy: string | null;
  askedAtISO: string;
  /** "video" | "photo" | "both" | "unclear" */
  medium: string | null;
};

// ---- small pure helpers ---------------------------------------------------------------------

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 24);
const streetOf = (title?: string | null) => (title ?? "").split(",")[0].trim() || null;

export function asMedium(v: unknown): AskMediumValue {
  const s = String(v ?? "").toLowerCase().trim();
  return (MEDIA as readonly string[]).includes(s) ? (s as AskMediumValue) : "unclear";
}

/** Does an ask about `askMedium` concern delivering `want`? both / unclear / unset concern either. */
export function mediumMatches(askMedium: string | null | undefined, want: "video" | "photo"): boolean {
  const m = asMedium(askMedium);
  return m === want || m === "both" || m === "unclear";
}

/** Text, email and call asks hold their job's delivery; order notes, the portal, Aryeo and scheduling never do. */
export function defaultHolds(kind: AskKind, source: string): boolean {
  return kind === "SPECIAL_REQUEST" && HOLDING_SOURCES.has(source);
}

/** A job we have not finished delivering: its asks are ClientAsks, not revision briefs. */
export function jobInFlight(p: { status: string; deliveredAt: Date | null } | null | undefined): boolean {
  if (!p) return false;
  return p.deliveredAt == null && p.status !== "DELIVERED" && p.status !== "CANCELLED";
}

/**
 * Does this ask close because its job was delivered? A special request on a
 * delivered or cancelled job always does (after delivery a change is a
 * revision, which the revision machinery owns). A scheduling ask only when it
 * was asked before the delivery: "book my next shoot", filed on the job the
 * message landed on after it went out, is still wanted.
 */
export function closesOnDelivery(
  a: { kind: string; askedAt: Date },
  p: { status: string; deliveredAt: Date | null } | null | undefined,
): boolean {
  if (!p || jobInFlight(p)) return false;
  // Oct 21 2026 (859 N Lawrence St): a special request asked AFTER the job
  // went out is about the delivered work (Photo Delivery files one when the
  // client asks for changes to photos already delivered); delivery cannot
  // have answered it. One asked before, or on a cancelled job, still closes.
  if (a.kind !== "SCHEDULING") return p.status === "CANCELLED" || !p.deliveredAt || a.askedAt.getTime() < p.deliveredAt.getTime();
  return !!p.deliveredAt && a.askedAt.getTime() < p.deliveredAt.getTime();
}

/** The job's delivery promise: a person's override, else the promise it was sold under, else Aryeo's due date. */
export function jobPromise(p: { dueOverrideAt?: Date | null; promisedDueAt?: Date | null; deliveryDue?: Date | null } | null | undefined): Date | null {
  if (!p) return null;
  return p.dueOverrideAt ?? p.promisedDueAt ?? p.deliveryDue ?? null;
}

export type AskClock = { dueAt: Date | null; behind: boolean; dueToday: boolean };

/**
 * When an open ask is due, and whether it is behind. Plain rules:
 *   · a special request is due by its job's delivery promise; it is behind
 *     once that passes, or once it has been open 48 hours. An order note or
 *     add-on cannot be checked before the work exists, so only the promise
 *     makes it behind (no promise: no date). A text/email ask on no job, or a
 *     job with no promise, is due 48 hours after it arrived.
 *   · a scheduling ask is due the day it arrives and behind after 24 hours
 *     open; until then it counts as due today.
 * dueToday = not behind, and due by the end of today (Eastern).
 */
export function askClock(a: { kind: string; source: string; askedAt: Date }, jobDue: Date | null, now: Date): AskClock {
  const age = now.getTime() - a.askedAt.getTime();
  const todayKey = etDayKey(now);
  if (a.kind === "SCHEDULING") {
    const dueAt = etAt(etDayKey(a.askedAt), 23, 59);
    const behind = age > SCHEDULING_BEHIND_HOURS * HOUR;
    return { dueAt, behind, dueToday: !behind };
  }
  if (a.source === "order_note") {
    const behind = !!jobDue && now.getTime() > jobDue.getTime();
    return { dueAt: jobDue, behind, dueToday: !behind && !!jobDue && etDayKey(jobDue) <= todayKey };
  }
  const dueAt = jobDue ?? new Date(a.askedAt.getTime() + SPECIAL_BEHIND_HOURS * HOUR);
  const behind = now.getTime() > dueAt.getTime() || age > SPECIAL_BEHIND_HOURS * HOUR;
  return { dueAt, behind, dueToday: !behind && etDayKey(dueAt) <= todayKey };
}

/** The four tile numbers for a list of open items. */
export function countsOf(items: { askedAt: Date; behind: boolean; dueToday: boolean }[], now: Date): JobCounts {
  if (!items.length) return { ...EMPTY_COUNTS };
  const oldest = Math.min(...items.map((i) => i.askedAt.getTime()));
  return {
    open: items.length,
    dueToday: items.filter((i) => i.dueToday).length,
    behind: items.filter((i) => i.behind).length,
    oldestHours: Math.max(0, Math.floor((now.getTime() - oldest) / HOUR)),
  };
}

/** The dedupe key a client message's asks are filed under: the same message read twice (two inboxes, a rescan) files once. */
export function messageAskKey(clientId: string, projectId: string | null, kind: AskKind, message: string): string {
  return `msg:${sha([clientId, projectId ?? "-", kind, norm(message)].join("|"))}`;
}

type HistoryLine = { at: string; by: string; what: string };
function pushHistory(json: string | null | undefined, line: HistoryLine): string {
  let arr: HistoryLine[] = [];
  try { arr = json ? (JSON.parse(json) as HistoryLine[]) : []; } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.push(line);
  return JSON.stringify(arr.slice(-30));
}

// ---- the two exports other lanes import (exact signatures) ----------------------------------

/** Open asks on this job that must be confirmed before this medium is delivered. */
export async function openAsksHolding(projectId: string, medium: "video" | "photo"): Promise<HoldingAsk[]> {
  if (!projectId) return [];
  const rows = await prisma.clientAsk.findMany({
    where: { projectId, state: "OPEN", holdsDelivery: true, kind: "SPECIAL_REQUEST" },
    orderBy: { askedAt: "asc" },
    select: { id: true, summary: true, text: true, askedBy: true, askedAt: true, medium: true },
  });
  return rows
    .filter((r) => mediumMatches(r.medium, medium))
    // Money-free whoever reads it (Oct 19 2026): this line lands on Kyle's screens and in alerts.
    .map((r) => ({ id: r.id, summary: scrubMoney(r.summary?.trim() || clip(r.text, 140)), askedBy: r.askedBy, askedAtISO: r.askedAt.toISOString(), medium: r.medium }));
}

/** Counts for Kyle's Special requests and Scheduling tiles (test clients excluded). */
export async function askBoardCounts(now: Date = new Date()): Promise<{ special: JobCounts; scheduling: JobCounts }> {
  // Taken from the functions that build the two screens, so a tile can never
  // disagree with the page it opens (lib/opsCounts).
  const [special, scheduling] = await Promise.all([specialRequestsBoard(now, { countsOnly: true }), schedulingBoard(now, { countsOnly: true })]);
  return { special: special.counts, scheduling: scheduling.counts };
}

// ---- writing --------------------------------------------------------------------------------

export type NewAsk = {
  clientId: string;
  projectId?: string | null;
  outputId?: string | null;
  kind: AskKind;
  medium?: string | null;
  text: string;
  summary?: string | null;
  source: AskSource | string;
  sourceRef?: string | null;
  askedBy?: string | null;
  askedAt?: Date;
  /** Default: text, email and call special requests hold (defaultHolds). */
  holdsDelivery?: boolean;
  taskId?: string | null;
  revisionIssueId?: string | null;
  /** Default: client + job + kind + the words. */
  dedupeKey?: string | null;
  /** Who filed it, for the history ("hub" when the hub did). */
  by?: string | null;
};

// ---- the same ask twice (Oct 22 2026, comms audit M3) ----------------------------------------
//
// One ask per message was not enough: Nehemiah Lindo booked ONE shoot over
// seven texts ("Hey I have another listing", "And a video", "Let's do it",
// "can we do sooner" twice...) and Kyle's Scheduling screen showed seven open
// asks; Joe Sutow's photo 38 staging was filed twice eleven seconds apart (the
// photo part of his work order, and the same words from the message). Before
// a new row is made, an OPEN ask for the same client, kind and job (or both
// with no job) asked within the window is looked for:
//   · the same words (normalized), or one's words inside the other's: the
//     same ask. The open one stays and takes the longer words;
//   · a SCHEDULING ask with no job yet in the same conversation (the window
//     below): the same booking being arranged. The open one stays and the new
//     words are added to it, so Kyle reads the whole exchange on one card;
//   · never across a job's delivery (the one asked before it closes with it);
//   · a keyed photo-part ask (photo-office: / photo-shared:, lib/briefPhotoAsks)
//     arriving after a plain message ask with the same words replaces it: the
//     keyed one carries the office question and is what briefPhotoAsks reads
//     back by its key, so the plain one is set aside as filed again.
// ---------------------------------------------------------------------------------------------
/** How far back an open ask counts as the same one. */
export const ASK_DUPLICATE_WINDOW_MS = 48 * 3_600_000;
/** How far back an open scheduling ask counts as the same booking conversation. */
export const SCHEDULING_CONVERSATION_MS = 24 * 3_600_000;
const KEYED_PHOTO_PREFIXES = ["photo-office:", "photo-shared:"];
const isKeyedPhotoAsk = (key: string | null | undefined) => KEYED_PHOTO_PREFIXES.some((p) => (key ?? "").startsWith(p));
/** Asks filed from a client's message (or its work order's photo part): the only ones this check merges.
 *  A staff note, an order note, a wrap-up line keep their own keys and their own closing rules. */
const fromAMessage = (key: string) => key.startsWith("msg:") || key.startsWith("ask:") || isKeyedPhotoAsk(key);

/** Pure: do these two asks' words say the same thing? Equal once normalized, or one inside the other (12+ characters). */
export function sameAskWords(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

/**
 * Pure: is `incoming` the same ask as the open `existing` one? `same-words`
 * (any kind), `same-booking` (a scheduling ask in the same conversation), or
 * null. Both must be the same client, kind and job (null = no job).
 */
export function duplicateAskReason(
  existing: { clientId: string; kind: string; projectId: string | null; text: string; askedAt: Date; source?: string | null },
  incoming: { clientId: string; kind: string; projectId: string | null; text: string; askedAt: Date; source?: string | null },
): "same-words" | "same-booking" | null {
  if (existing.clientId !== incoming.clientId || existing.kind !== incoming.kind || (existing.projectId ?? null) !== (incoming.projectId ?? null)) return null;
  const gap = Math.abs(incoming.askedAt.getTime() - existing.askedAt.getTime());
  if (gap <= ASK_DUPLICATE_WINDOW_MS && sameAskWords(existing.text, incoming.text)) return "same-words";
  // The same booking: both from the client's own texts, emails or calls.
  // A booking still being arranged has no job yet (Nehemiah's "I have another
  // listing ... can we do sooner"). An ask on a job keeps its own row: the
  // job's delivery closes the ones asked before it (closeAsksOnDeliveredJobs),
  // never one asked after.
  const theirs = (src: string | null | undefined) => src === "text" || src === "email" || src === "call";
  if (incoming.kind === "SCHEDULING" && !incoming.projectId && !existing.projectId && gap <= SCHEDULING_CONVERSATION_MS && theirs(existing.source) && theirs(incoming.source)) return "same-booking";
  return null;
}

/** File an ask once. A second filing under the same key returns the first (whatever its state: a replay never reopens a closed ask). */
export async function createAsk(a: NewAsk): Promise<{ id: string; created: boolean } | null> {
  const text = (a.text ?? "").trim();
  if (!a.clientId || !text) return null;
  const kind: AskKind = a.kind === "SCHEDULING" ? "SCHEDULING" : "SPECIAL_REQUEST";
  const projectId = a.projectId ?? null;
  const dedupeKey = a.dedupeKey ?? `ask:${sha([a.clientId, projectId ?? "-", kind, norm(text)].join("|"))}`;
  const prior = await prisma.clientAsk.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (prior) return { id: prior.id, created: false };
  const now = new Date();
  // THE SAME ASK, FILED AGAIN (comms audit M3, above).
  const askedAt = a.askedAt ?? now;
  const open = !fromAMessage(dedupeKey) ? [] : await prisma.clientAsk.findMany({
    where: { clientId: a.clientId, kind, projectId, state: "OPEN", askedAt: { gte: new Date(askedAt.getTime() - ASK_DUPLICATE_WINDOW_MS), lte: new Date(askedAt.getTime() + ASK_DUPLICATE_WINDOW_MS) } },
    orderBy: { askedAt: "asc" },
    select: { id: true, clientId: true, kind: true, projectId: true, text: true, summary: true, askedAt: true, dedupeKey: true, historyJson: true, source: true },
  });
  const incoming = { clientId: a.clientId, kind, projectId, text, askedAt, source: String(a.source ?? "") };
  let twin = open.map((o) => ({ o, why: duplicateAskReason(o, incoming) })).find((x) => x.why);
  if (twin && projectId) {
    // Never across the job's delivery: the one asked before it closes with it.
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { deliveredAt: true } });
    const lo = Math.min(twin.o.askedAt.getTime(), askedAt.getTime());
    const hi = Math.max(twin.o.askedAt.getTime(), askedAt.getTime());
    if (p?.deliveredAt && p.deliveredAt.getTime() > lo && p.deliveredAt.getTime() <= hi) twin = undefined;
  }
  const replacing = twin && isKeyedPhotoAsk(dedupeKey) && !isKeyedPhotoAsk(twin.o.dedupeKey) && twin.why === "same-words" ? twin.o : null;
  if (twin && !replacing) {
    const o = twin.o;
    const by = a.by?.trim() || "hub";
    const longer = twin.why === "same-words" && norm(text).length > norm(o.text).length ? text : null;
    const added = twin.why === "same-booking" && !norm(o.text).includes(norm(text)) ? `${o.text}\n${text}` : null;
    if (longer || added) {
      await prisma.clientAsk.update({
        where: { id: o.id },
        data: {
          text: clip(longer ?? added ?? o.text, 4000),
          ...(a.summary?.trim() && twin.why === "same-booking" ? { summary: clip(a.summary.trim(), 240) } : {}),
          historyJson: pushHistory(o.historyJson, { at: now.toISOString(), by, what: twin.why === "same-booking" ? `the next message about the same booking, from ${a.source}` : `the same ask again, from ${a.source}` }),
        },
      }).catch(() => null);
    }
    return { id: o.id, created: false };
  }
  const holds = kind === "SCHEDULING" ? false : a.holdsDelivery ?? defaultHolds(kind, a.source);
  try {
    const row = await prisma.clientAsk.create({
      data: {
        clientId: a.clientId,
        projectId,
        outputId: a.outputId ?? null,
        kind,
        medium: kind === "SCHEDULING" ? null : asMedium(a.medium),
        text: clip(text, 4000),
        summary: a.summary?.trim() ? clip(a.summary.trim(), 240) : null,
        source: a.source,
        sourceRef: a.sourceRef ?? null,
        askedBy: a.askedBy?.trim() ? a.askedBy.trim().slice(0, 120) : null,
        askedAt,
        holdsDelivery: holds,
        taskId: a.taskId ?? null,
        revisionIssueId: a.revisionIssueId ?? null,
        dedupeKey,
        historyJson: pushHistory(null, { at: now.toISOString(), by: a.by?.trim() || "hub", what: `filed from ${a.source}` }),
      },
      select: { id: true },
    });
    if (replacing) {
      await markNotNeeded(replacing.id, a.by?.trim() || "hub", "Filed again as the question for Jordan or Kyle on this job (the same words).").catch(() => null);
    }
    return { id: row.id, created: true };
  } catch (e) {
    // Two readers of the same message at once: the unique key settles it.
    if ((e as { code?: string })?.code === "P2002") {
      const again = await prisma.clientAsk.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (again) return { id: again.id, created: false };
    }
    throw e;
  }
}

export type AskResult = { ok: boolean; message: string };

async function move(
  id: string,
  from: AskState[],
  to: AskState,
  by: string,
  data: Record<string, unknown>,
  what: string,
): Promise<AskResult & { row?: { projectId: string | null; summary: string | null; text: string } }> {
  const row = await prisma.clientAsk.findUnique({ where: { id }, select: { id: true, state: true, historyJson: true, projectId: true, summary: true, text: true } });
  if (!row) return { ok: false, message: "That ask is no longer here. Reload the page." };
  if (!from.includes(row.state as AskState)) return { ok: true, message: "Already done. Nothing changed." };
  const r = await prisma.clientAsk.updateMany({
    where: { id, state: row.state },
    data: { ...data, state: to, historyJson: pushHistory(row.historyJson, { at: new Date().toISOString(), by, what }) },
  });
  if (!r.count) return { ok: false, message: "Someone changed that ask a moment ago. Reload the page." };
  return { ok: true, message: "Saved.", row };
}

async function timeline(projectId: string | null | undefined, body: string) {
  if (!projectId) return;
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: clip(body, 600) } }).catch(() => {});
}

/** Handled. Refused on an ask that holds delivery: that one is closed by Confirmed (checked on the finished work) or Not needed. */
export async function markDone(id: string, by: string): Promise<AskResult> {
  const row = await prisma.clientAsk.findUnique({ where: { id }, select: { holdsDelivery: true, kind: true, state: true } });
  if (!row) return { ok: false, message: "That ask is no longer here. Reload the page." };
  if (row.state === "OPEN" && row.holdsDelivery && row.kind === "SPECIAL_REQUEST") {
    return { ok: false, message: "This ask holds delivery. Press Confirmed once the finished work is checked, or Not needed." };
  }
  const r = await move(id, ["OPEN"], "DONE", by, { doneAt: new Date(), doneBy: by }, "marked done");
  if (r.ok && r.row) await timeline(r.row.projectId, `Client ask done (${by}): ${clip(r.row.summary || r.row.text, 200)}`);
  return r.ok ? { ok: true, message: r.message === "Saved." ? "Marked done." : r.message } : r;
}

/** Checked on the finished work: who, when and an optional note. Releases a delivery hold. */
export async function markConfirmed(id: string, by: string, note?: string | null): Promise<AskResult> {
  const n = note?.trim() ? clip(note.trim(), 500) : null;
  const r = await move(id, ["OPEN", "DONE"], "CONFIRMED", by, { confirmedAt: new Date(), confirmedBy: by, confirmNote: n }, `confirmed${n ? `: ${n}` : ""}`);
  if (r.ok && r.row) await timeline(r.row.projectId, `Client ask confirmed by ${by}: ${clip(r.row.summary || r.row.text, 200)}${n ? ` (${n})` : ""}`);
  return r.ok ? { ok: true, message: r.message === "Saved." ? "Confirmed." : r.message } : r;
}

/**
 * ONE "Checked" for a job's open requests (Oct 19 2026: one press per job, not
 * one per message). Each ask is Confirmed with who, when and `what` as its
 * note; the job's timeline gets one line for the lot. Asks already closed are
 * left alone. Returns how many this press confirmed.
 */
export async function confirmAsks(ids: string[], by: string, what: string): Promise<{ confirmed: number; projectIds: string[] }> {
  const note = clip(what.trim(), 500) || null;
  let confirmed = 0;
  const touched = new Map<string, string[]>();
  for (const id of [...new Set(ids)]) {
    const r = await move(id, ["OPEN"], "CONFIRMED", by, { confirmedAt: new Date(), confirmedBy: by, confirmNote: note }, `confirmed${note ? `: ${note}` : ""}`);
    if (!r.ok || !r.row) continue;
    confirmed++;
    if (r.row.projectId) touched.set(r.row.projectId, [...(touched.get(r.row.projectId) ?? []), clip(r.row.summary || r.row.text, 80)]);
  }
  for (const [projectId, lines] of touched) {
    // "3 client requests checked on the photos by Kyle Smith: ..."
    await timeline(projectId, `${lines.length === 1 ? "Client request" : `${lines.length} client requests`} ${note ?? "checked"} by ${by}: ${lines.join("; ")}`);
  }
  return { confirmed, projectIds: [...touched.keys()] };
}

/** Not needed after all (a person's call, or the client's own words). Releases a delivery hold. */
export async function markNotNeeded(id: string, by: string, reason?: string | null): Promise<AskResult> {
  const why = reason?.trim() ? clip(reason.trim(), 500) : null;
  const r = await move(id, ["OPEN", "DONE"], "NOT_NEEDED", by, { doneAt: new Date(), doneBy: by, confirmNote: why }, `not needed${why ? `: ${why}` : ""}`);
  if (r.ok && r.row) await timeline(r.row.projectId, `Client ask not needed (${by}): ${clip(r.row.summary || r.row.text, 200)}${why ? `. ${why}` : ""}`);
  return r.ok ? { ok: true, message: r.message === "Saved." ? "Set aside as not needed." : r.message } : r;
}

/** Back on the list (a mistaken press). */
export async function reopenAsk(id: string, by: string): Promise<AskResult> {
  const r = await move(id, ["DONE", "CONFIRMED", "NOT_NEEDED"], "OPEN", by, { doneAt: null, doneBy: null, confirmedAt: null, confirmedBy: null, confirmNote: null }, "reopened");
  return r.ok ? { ok: true, message: r.message === "Saved." ? "Back on the list." : r.message } : r;
}

/** Put a job-less ask on one of its client's jobs. */
export async function assignAskProject(id: string, projectId: string, by: string): Promise<AskResult> {
  const ask = await prisma.clientAsk.findUnique({ where: { id }, select: { clientId: true, historyJson: true, state: true } });
  if (!ask) return { ok: false, message: "That ask is no longer here. Reload the page." };
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true, title: true } });
  if (!p) return { ok: false, message: "That job is not in the hub." };
  if (p.clientId !== ask.clientId) {
    // An assistant's account folds onto the agent's: either side of the fold is the same client.
    const fold = await prisma.client.findMany({ where: { id: { in: [p.clientId, ask.clientId] } }, select: { id: true, parentClientId: true } });
    const root = (cid: string) => fold.find((f) => f.id === cid)?.parentClientId ?? cid;
    if (root(p.clientId) !== root(ask.clientId)) return { ok: false, message: "That job belongs to a different client." };
  }
  await prisma.clientAsk.update({ where: { id }, data: { projectId, historyJson: pushHistory(ask.historyJson, { at: new Date().toISOString(), by, what: `put on ${streetOf(p.title) ?? "a job"}` }) } });
  return { ok: true, message: `Put on ${streetOf(p.title) ?? "the job"}.` };
}

/**
 * An ask filed under the WRONG client moves to another client's job: client
 * and job together (Oct 23 2026: Olivia Vecere, Sharra Mercer's assistant,
 * emailed Sharra's Sussex video changes; her client row folds onto Mike
 * Flatley, so the ask was filed on Mike Flatley with no job).
 * assignAskProject keeps an ask on its own client (the assistant fold aside)
 * and refuses another client's job; this is the office's correction of a
 * misfiled message, with the reason on the ask's history and the job's
 * timeline. Open asks only.
 */
export async function refileAskToClientJob(id: string, projectId: string, by: string, why: string): Promise<AskResult> {
  const reason = clip((why ?? "").replace(/\s+/g, " ").trim(), 300);
  if (reason.length < 5) return { ok: false, message: "Say why the ask belongs to that client (a few words)." };
  const ask = await prisma.clientAsk.findUnique({ where: { id }, select: { clientId: true, projectId: true, historyJson: true, state: true, summary: true, text: true } });
  if (!ask) return { ok: false, message: "That ask is no longer here. Reload the page." };
  if (ask.state !== "OPEN") return { ok: false, message: "Only an open ask moves to another client's job." };
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true, title: true, client: { select: { name: true } } } });
  if (!p?.clientId) return { ok: false, message: "That job is not in the hub." };
  const street = streetOf(p.title) ?? "the job";
  if (p.clientId === ask.clientId && ask.projectId === projectId) return { ok: true, message: `Already on ${street}.` };
  const from = await prisma.client.findUnique({ where: { id: ask.clientId }, select: { name: true } });
  const fromName = from?.name ?? "another client";
  const toName = p.client?.name ?? "the job's client";
  const r = await prisma.clientAsk.updateMany({
    where: { id, state: "OPEN", clientId: ask.clientId, projectId: ask.projectId },
    data: { clientId: p.clientId, projectId, historyJson: pushHistory(ask.historyJson, { at: new Date().toISOString(), by, what: `moved from ${fromName} to ${toName}, ${street}: ${reason}` }) },
  });
  if (!r.count) return { ok: false, message: "Someone changed that ask a moment ago. Reload the page." };
  await timeline(projectId, `Client ask moved here from ${fromName} (${by}): ${clip(ask.summary || ask.text, 200)}. ${reason}`);
  return { ok: true, message: `Moved to ${toName}, ${street}.` };
}

/** Added by hand from Kyle's Special requests screen. */
export async function addAskByHand(input: { projectId: string; text: string; medium?: string | null; holdsDelivery?: boolean; by: string }): Promise<AskResult> {
  const text = (input.text ?? "").trim();
  if (text.length < 3) return { ok: false, message: "Write what the client asked for." };
  const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { clientId: true, title: true } });
  if (!p) return { ok: false, message: "Pick the job it is for." };
  const r = await createAsk({
    clientId: p.clientId,
    projectId: input.projectId,
    kind: "SPECIAL_REQUEST",
    medium: input.medium ?? "unclear",
    text,
    summary: clip(text.replace(/\s+/g, " "), 140),
    source: "staff",
    askedBy: null,
    holdsDelivery: input.holdsDelivery !== false,
    by: input.by,
    dedupeKey: `staff:${sha([input.projectId, norm(text), new Date().toISOString().slice(0, 16)].join("|"))}`,
  });
  if (!r) return { ok: false, message: "Write what the client asked for." };
  await timeline(input.projectId, `Client ask added by ${input.by}: ${clip(text, 200)}`);
  // Oct 21 2026: a photo request on photos already delivered reopens the photo
  // job and goes on the delivery owner's list (photoDelivery/clientAsked).
  const m = asMedium(input.medium);
  if (r.created && (m === "photo" || m === "both")) {
    const { photoAskAfterDelivery } = await import("@/lib/photoDelivery/clientAsked");
    const after = await photoAskAfterDelivery({ projectId: input.projectId, words: text, by: input.by, clientId: p.clientId });
    if (after.reopened) return { ok: true, message: `Added to ${streetOf(p.title) ?? "the job"}. The photos were already delivered, so the photo job is reopened for it.` };
  }
  return { ok: true, message: `Added to ${streetOf(p.title) ?? "the job"}.` };
}

// ---- who owns a request (Oct 19 2026, the Shoots build) --------------------------------------
//
// Jordan approved one owner per request: at the shoot → the creative (texted
// at the appointment start); photo editing → Kyle; video editing → the job's
// editor; scheduling or the office → Kyle; anything unclear shows as "needs
// an owner" until someone picks photos or video (setAskMedium). Before the
// shoot is over every request is the creative's, whatever it is about: they
// are the one who can get it right at the house.

/** The shoot is over: a stage past the shoot, or the appointment's end (start + 2 hours when no end is known) has passed. */
export function shootIsOver(p: { status: string; shootDate: Date | null; endAt?: Date | null }, now: Date = new Date()): boolean {
  if (["SHOT", "EDITING", "REVIEW", "REVISION", "DELIVERED"].includes(p.status)) return true;
  const end = p.endAt ?? (p.shootDate ? new Date(p.shootDate.getTime() + 2 * HOUR) : null);
  return !!end && end.getTime() <= now.getTime();
}

const firstWord = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || null;

export type RequestOwner = {
  /** "Harrison · at the shoot", "Kyle · photo editing", "John · video editing", "Needs an owner". */
  label: string;
  role: "creative" | "photo" | "video" | "office" | "none";
  /** Nobody has it yet: the medium is unclear after the shoot (pick photos or video). */
  needsOwner: boolean;
};

/**
 * Who owns one request (pure). `card` is the medium being looked at: a request
 * about both is Kyle's on the photos and the editor's on the video. `creative`
 * and `editor` are names (first names are used); a missing one says so.
 */
export function requestOwner(
  a: { kind?: string | null; medium: string | null | undefined },
  ctx: { shootOver: boolean; creative: string | null; editor: string | null; card?: "photo" | "video" | null },
): RequestOwner {
  if (a.kind === "SCHEDULING") return { label: "Kyle · scheduling", role: "office", needsOwner: false };
  if (!ctx.shootOver) {
    const who = firstWord(ctx.creative);
    return { label: who ? `${who} · at the shoot` : "Creative not assigned · at the shoot", role: "creative", needsOwner: false };
  }
  const m = asMedium(a.medium);
  const on: "photo" | "video" | null = m === "photo" || m === "video" ? m : m === "both" ? ctx.card ?? "photo" : null;
  if (on === "photo") return { label: "Kyle · photo editing", role: "photo", needsOwner: false };
  if (on === "video") {
    const who = firstWord(ctx.editor);
    return { label: who ? `${who} · video editing` : "Video editor not assigned", role: "video", needsOwner: false };
  }
  return { label: "Needs an owner", role: "none", needsOwner: true };
}

const MEDIUM_SET_WORDS: Record<AskMediumValue, string> = { photo: "the photos", video: "the video", both: "the photos and the video", unclear: "unclear" };

/** Say what an open request is about (the "needs an owner" picker): photos, video or both. Who and when go on its history and the job's timeline. */
export async function setAskMedium(id: string, medium: string, by: string): Promise<AskResult> {
  const m = asMedium(medium);
  if (m === "unclear") return { ok: false, message: "Pick photos, video or both." };
  const row = await prisma.clientAsk.findUnique({ where: { id }, select: { id: true, state: true, kind: true, medium: true, historyJson: true, projectId: true, summary: true, text: true } });
  if (!row || row.kind !== "SPECIAL_REQUEST") return { ok: false, message: "That request is no longer here. Reload the page." };
  if (row.state !== "OPEN") return { ok: true, message: "That request is already closed. Nothing changed." };
  if (row.medium != null && asMedium(row.medium) === m) return { ok: true, message: `Already on ${MEDIUM_SET_WORDS[m]}. Nothing changed.` };
  const r = await prisma.clientAsk.updateMany({
    where: { id, state: "OPEN", medium: row.medium },
    data: { medium: m, historyJson: pushHistory(row.historyJson, { at: new Date().toISOString(), by, what: `set to ${MEDIUM_SET_WORDS[m]}` }) },
  });
  if (!r.count) return { ok: false, message: "Someone changed that request a moment ago. Reload the page." };
  await timeline(row.projectId, `Client request put on ${MEDIUM_SET_WORDS[m]} by ${by}: ${clip(row.summary || row.text, 200)}`);
  return { ok: true, message: `Saved: it is about ${MEDIUM_SET_WORDS[m]}.` };
}

// ---- filing from a client's message (comms.recordClientCommunication) ------------------------

/** One ask the Smart Brain read out of a message (ai.decideCommTask). */
export type RoutedAsk = { kind: AskKind; text: string; summary: string; medium: AskMediumValue; projectHint: string | null };

/**
 * The brain's asks for one message, filed. Grouped per job and kind (one row
 * per message per job per kind, its asks' words joined), keyed on the whole
 * message so a replay files nothing new. Never throws.
 *   · a door code / lockbox / how-to-get-in note is never an ask;
 *   · a special request on a job we already delivered is left to the
 *     revision machinery (it became a revision brief, or is about future work);
 *   · when a revision was raised for this message, a special request is filed
 *     only where the brain named a different job in flight for it: with no
 *     job named it is the revision's (audit #6, Oct 19 2026);
 *   · a special request with no clear job goes on the client's one job in
 *     flight; with several in flight it is filed with no job (Kyle picks it),
 *     and with none it is not filed;
 *   · scheduling asks are filed whatever the job's state;
 *   · the same message read again files nothing, even when the brain puts it
 *     on a different job the second time (Oct 19 2026): any ask of that kind
 *     already filed from these words, on any of the client's jobs or none,
 *     means this message was filed.
 */
export async function fileAsksFromMessage(input: {
  clientId: string;
  clientName?: string | null;
  contactName?: string | null;
  message: string;
  channel: "text" | "email" | "call";
  sourceRef?: string | null;
  asks: RoutedAsk[];
  /** The job the message landed on (the brain's pick, checked); null when in doubt. */
  defaultProjectId: string | null;
  /** The job a revision was raised on for this message, if any: its asks are the revision's. */
  revisionProjectId?: string | null;
  /** The sender's OWN client row, before the assistant → agent fold (lib/teamRouting). */
  senderClientId?: string | null;
  now?: Date;
}): Promise<{ filed: string[]; skipped: string[] }> {
  const out = { filed: [] as string[], skipped: [] as string[] };
  try {
    if (!input.clientId || !input.asks?.length) return out;
    const { isAccessNote } = await import("@/lib/specialRequests");
    // AN ASK GOES ON THE TEAM AGENT WHOSE JOB IT NAMES (Oct 23 2026,
    // lib/teamRouting). Olivia Vecere's one email can carry an ask for Sharra
    // Mercer's 1337 Carolannes Way and another for Mike Flatley's 2 Quail Run
    // Ln; the message is filed on one of them, and each ask whose own words
    // name a team agent's job (house number and street, or its listing link)
    // is filed on THAT agent's job, by the same rule as the message. Asks that
    // name no job stay with the message. Only for a folded assistant or a
    // team member; everyone else is unchanged.
    const teamJobOf = await (async () => {
      if (!input.senderClientId) return null;
      const T = await import("@/lib/teamRouting");
      if (!(await T.isTeamSender(input.senderClientId))) return null;
      const dir = await T.loadTeamDirectory();
      const senderId = input.senderClientId;
      return (words: string): { clientId: string; projectId: string } | null => {
        const d = T.decideTeamRoute(dir, senderId, { body: words });
        if (d.action === "move") return { clientId: d.route.clientId, projectId: d.route.project.id };
        if (d.action === "stay" && d.job) return { clientId: d.job.root, projectId: d.job.id };
        return null;
      };
    })().catch(() => null);
    const elsewhere = new Map<string, { clientId: string; projectId: string; kind: AskKind; texts: string[]; summaries: string[]; media: Set<AskMediumValue> }>();
    const projects = await prisma.project.findMany({
      where: { clientId: input.clientId },
      select: { id: true, status: true, deliveredAt: true },
    });
    const byId = new Map(projects.map((p) => [p.id, p]));
    const inFlight = projects.filter((p) => jobInFlight(p));
    const anyInFlight = inFlight.length > 0;
    // Filed before, on whichever job (or none): every key these words could have had.
    const kindsFiled = new Set<string>();
    {
      const kinds = [...new Set(input.asks.map((a) => (a.kind === "SCHEDULING" ? "SCHEDULING" : "SPECIAL_REQUEST") as AskKind))];
      const keys = kinds.flatMap((k) => [null, ...projects.map((p) => p.id)].map((pid) => ({ k, key: messageAskKey(input.clientId, pid, k, input.message) })));
      const found = keys.length ? await prisma.clientAsk.findMany({ where: { dedupeKey: { in: keys.map((x) => x.key) } }, select: { dedupeKey: true } }) : [];
      const hit = new Set(found.map((f) => f.dedupeKey));
      for (const x of keys) if (hit.has(x.key)) kindsFiled.add(x.k);
    }
    const groups = new Map<string, { projectId: string | null; kind: AskKind; texts: string[]; summaries: string[]; media: Set<AskMediumValue> }>();
    for (const a of input.asks) {
      const words = (a.text || "").trim() || clip(input.message, 600);
      if (isAccessNote(words) || isAccessNote(a.summary)) { out.skipped.push(`access note: ${clip(words, 60)}`); continue; }
      if (kindsFiled.has(a.kind)) { out.skipped.push(`already filed from this message: ${clip(words, 60)}`); continue; }
      const team = teamJobOf ? teamJobOf(`${words}\n${a.summary ?? ""}`) : null;
      if (team && team.clientId !== input.clientId) {
        // Another team agent's job: the same rules, on that job.
        const p = await prisma.project.findUnique({ where: { id: team.projectId }, select: { status: true, deliveredAt: true } });
        if (a.kind === "SPECIAL_REQUEST" && !jobInFlight(p)) { out.skipped.push(`delivered job of another team agent: ${clip(words, 60)}`); continue; }
        const key = `${team.clientId}|${team.projectId}|${a.kind}`;
        const g = elsewhere.get(key) ?? { clientId: team.clientId, projectId: team.projectId, kind: a.kind, texts: [], summaries: [], media: new Set<AskMediumValue>() };
        if (!g.texts.includes(words)) g.texts.push(words);
        if (a.summary?.trim() && !g.summaries.includes(a.summary.trim())) g.summaries.push(a.summary.trim());
        g.media.add(asMedium(a.medium));
        elsewhere.set(key, g);
        continue;
      }
      const hinted = a.projectHint && byId.has(a.projectHint) ? a.projectHint : null;
      let projectId = hinted ?? (input.defaultProjectId && byId.has(input.defaultProjectId) ? input.defaultProjectId : null);
      if (a.kind === "SPECIAL_REQUEST") {
        if (projectId && input.revisionProjectId && projectId === input.revisionProjectId) { out.skipped.push(`revision brief: ${clip(words, 60)}`); continue; }
        // A revision was raised for this message: with no job named for this ask, it is the revision's.
        if (input.revisionProjectId && !hinted) { out.skipped.push(`revision brief (no job named): ${clip(words, 60)}`); continue; }
        if (projectId && !jobInFlight(byId.get(projectId))) {
          // The brain's job is delivered; a hint it did not give may still mean
          // the one job in flight. Only an explicit hint on a delivered job is
          // left to the revision machinery outright.
          if (hinted) { out.skipped.push(`delivered job: ${clip(words, 60)}`); continue; }
          projectId = null;
        }
        if (!projectId && !anyInFlight) { out.skipped.push(`no job in flight: ${clip(words, 60)}`); continue; }
        // No clear job, and the client has exactly one in flight: that one.
        if (!projectId && inFlight.length === 1) projectId = inFlight[0].id;
      }
      const key = `${projectId ?? "-"}|${a.kind}`;
      const g = groups.get(key) ?? { projectId, kind: a.kind, texts: [], summaries: [], media: new Set<AskMediumValue>() };
      if (!g.texts.includes(words)) g.texts.push(words);
      if (a.summary?.trim() && !g.summaries.includes(a.summary.trim())) g.summaries.push(a.summary.trim());
      g.media.add(asMedium(a.medium));
      groups.set(key, g);
    }
    const toFile = [
      ...[...groups.values()].map((g) => ({ ...g, clientId: input.clientId, askedBy: input.contactName?.trim() || input.clientName?.trim() || null })),
      // On another team agent's job: asked by the person who wrote, never the account it folded to.
      ...[...elsewhere.values()].map((g) => ({ ...g, askedBy: input.contactName?.trim() || null })),
    ];
    for (const g of toFile) {
      const media = [...g.media].filter((m) => m !== "unclear");
      const medium: AskMediumValue = media.length === 0 ? "unclear" : media.length === 1 ? media[0] : "both";
      const r = await createAsk({
        clientId: g.clientId,
        projectId: g.projectId,
        kind: g.kind,
        medium,
        text: g.texts.join("\n"),
        summary: g.summaries.join("; ") || null,
        source: input.channel,
        sourceRef: input.sourceRef ?? null,
        askedBy: g.askedBy,
        askedAt: input.now ?? new Date(),
        dedupeKey: messageAskKey(g.clientId, g.projectId, g.kind, input.message),
      });
      if (r?.created) out.filed.push(r.id);
    }
  } catch (e) {
    console.error("[client-asks] filing a message's asks failed", input.clientId, e);
  }
  return out;
}

// The brain unavailable: a plain "we have to cancel / can we move it" still
// reaches Kyle's Scheduling screen. Narrow on purpose (the brain does the rest).
const RESCHEDULE_ASK_RE = /\b(re-?schedul\w*|cancel\w*|postpone\w*|push (it|the shoot|the appointment|back)|move (the|our|my|it to) ?(shoot|appointment|session|time|date)?|different (day|date|time)|change the (time|date|day))\b/i;

/** Scheduling ask from a message when the Smart Brain could not read it. Never throws. */
export async function fileSchedulingFallback(input: { clientId: string; clientName?: string | null; contactName?: string | null; message: string; channel: "text" | "email" | "call"; projectId: string | null; sourceRef?: string | null }): Promise<string | null> {
  try {
    const t = (input.message ?? "").trim();
    if (!t || !RESCHEDULE_ASK_RE.test(t)) return null;
    const { isSchedulingTalk } = await import("@/lib/comms");
    if (!isSchedulingTalk(t) && !/\bcancel\w*\b/i.test(t)) return null;
    const r = await createAsk({
      clientId: input.clientId,
      projectId: input.projectId,
      kind: "SCHEDULING",
      text: clip(t, 1200),
      summary: "Client asked to change a shoot time",
      source: input.channel,
      sourceRef: input.sourceRef ?? null,
      askedBy: input.contactName?.trim() || input.clientName?.trim() || null,
      dedupeKey: messageAskKey(input.clientId, input.projectId, "SCHEDULING", t),
    });
    return r?.created ? r.id : null;
  } catch (e) {
    console.error("[client-asks] scheduling fallback failed", input.clientId, e);
    return null;
  }
}

// ---- what the Aryeo order asks to check (order notes and add-ons): read, no longer filed -----

/** Add-ons a person has to check on the finished work. */
const ADDON_CHECKS: { re: RegExp; label: string; medium: AskMediumValue }[] = [
  { re: /\blot ?lines?\b|\bproperty lines?\b|\bplot (?:plan|lines?)\b|\bboundary lines?\b/i, label: "Lot lines", medium: "both" },
  { re: /\b(?:virtual|digital)(?:ly)? twilight\b|\btwilight (?:edit|conversion)\b/i, label: "Virtual twilight", medium: "photo" },
  { re: /\bvirtual(?:ly)? stag\w*|\bdigital stag\w*/i, label: "Virtual staging", medium: "photo" },
  { re: /\b(?:item|object|furniture) removal\b|\bdeclutter\w*/i, label: "Item removal", medium: "photo" },
  { re: /\b(?:sky|grass|lawn) (?:replacement|enhancement|swap)\b/i, label: "Sky or lawn replacement", medium: "photo" },
];

export type OrderAskCandidate = Omit<NewAsk, "by"> & { dedupeKey: string };

// Who meets whom and where: a photographer's logistics, not something to
// check on the finished work ("John will meet you", "Agent will be there",
// "Content Session #2 (Catch Up Session)"). The shoot brief still carries it.
const LOGISTICS_RE =
  /\b(?:will meet|meet(?:ing)? (?:you|him|her|them|me|at|on)|(?:agent|owner|seller|tenant|homeowner|client|buyer|i|we|he|she|they)(?: will|'ll| will not|'ll not)? be (?:there|present|on ?site|home|available)|see you (?:there|then|soon)|be present|split appointment|content session|catch[- ]?up session|train station|call (?:me|him|her) when|text (?:me|him|her) when)\b/i;
// The sentence of a note that says what to do, for the one-line summary.
const INSTRUCTION_RE =
  /\b(?:please|pls|want|need|use|make|create|highlight|include|add|avoid|don'?t|do not|no |can you|could you|shoot|take|capture|get (?:a|some|the)|modify|remove|stage|focus|show|feature|vertical|horizontal|only)\b/i;

/**
 * What an order asks a person to check, read from the job's Aryeo appointment
 * notes (the customer's Special Instructions and Order Notes) and its order
 * lines. Pure. Since Oct 19 2026 these are not filed: the job box
 * (lib/jobChecks) shows them as notes, and the clean-up script names the rows
 * filed before. An access line (a code, a lockbox, a key) is dropped from the
 * note; a note that is only access is nothing at all.
 */
export function orderAskCandidates(
  p: {
    id: string;
    clientId: string;
    clientName?: string | null;
    /** When the job was ordered: an add-on was asked for then. */
    createdAt?: Date | null;
    appointments: { aryeoId?: string | null; description: string | null; createdAt?: Date | null }[];
    orderItems: { title: string; isCanceled?: boolean | null }[];
    deliverables: { productTitle: string | null; removedFromOrderAt?: Date | null }[];
  },
  helpers: { customerNote: (d: string | null) => string | null; isAccessNote: (s: string) => boolean; askMedium: (s: string) => "video" | "photo" | "unclear" },
): OrderAskCandidate[] {
  const out: OrderAskCandidate[] = [];
  const seenNotes = new Set<string>();
  for (const a of p.appointments) {
    const note = helpers.customerNote(a.description);
    if (!note) continue;
    const sentences = note
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s && !helpers.isAccessNote(s) && !LOGISTICS_RE.test(s));
    const kept = sentences.join(" ").trim();
    if (kept.length < 8) continue;
    const k = norm(kept);
    if (seenNotes.has(k)) continue;
    seenNotes.add(k);
    const lead = sentences.find((s) => INSTRUCTION_RE.test(s)) ?? sentences[0] ?? kept;
    out.push({
      clientId: p.clientId,
      projectId: p.id,
      kind: "SPECIAL_REQUEST",
      medium: helpers.askMedium(kept),
      text: kept,
      summary: `Order note: ${clip(lead, 130)}`,
      source: "order_note",
      sourceRef: a.aryeoId ?? null,
      askedBy: p.clientName ?? null,
      askedAt: a.createdAt ?? undefined,
      holdsDelivery: false,
      dedupeKey: `order-note:${p.id}:${sha(k)}`,
    });
  }
  const titles = [
    ...p.orderItems.filter((i) => !i.isCanceled).map((i) => i.title),
    ...p.deliverables.filter((d) => !d.removedFromOrderAt).map((d) => d.productTitle ?? ""),
  ].filter(Boolean);
  const seen = new Set<string>();
  for (const check of ADDON_CHECKS) {
    const title = titles.find((t) => check.re.test(t));
    if (!title || seen.has(check.label)) continue;
    seen.add(check.label);
    out.push({
      clientId: p.clientId,
      projectId: p.id,
      kind: "SPECIAL_REQUEST",
      medium: check.medium,
      text: `Ordered: ${title}`,
      summary: `${check.label} ordered: check it is on the finished work and correct`,
      source: "order_note",
      sourceRef: null,
      askedBy: p.clientName ?? null,
      askedAt: p.createdAt ?? p.appointments.map((a) => a.createdAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? undefined,
      holdsDelivery: false,
      dedupeKey: `addon:${p.id}:${norm(check.label).replace(/\s+/g, "-")}`,
    });
  }
  return out;
}

/**
 * One job's order notes and add-ons, read off the order exactly as the
 * "Before you send" box reads them (lib/jobChecks: orderAskCandidates over the
 * Aryeo appointments' customer notes, access and logistics lines dropped).
 * Oct 21 2026 (859 N Lawrence St): Photo Delivery reads the same thing, so the
 * customer's "Wooden side walk forms ... photoshopped in photos" order note is
 * an item on the photo job (photoDelivery/clientAsked). One reader for both;
 * jobChecks can call this instead of its own select. Pure apart from the read.
 */
export async function orderNotesOf(projectId: string): Promise<OrderAskCandidate[]> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, clientId: true, createdAt: true,
      client: { select: { name: true } },
      appointments: { orderBy: { startAt: "asc" }, select: { aryeoId: true, description: true, createdAt: true } },
      orderItems: { select: { title: true, isCanceled: true } },
      deliverables: { select: { productTitle: true, removedFromOrderAt: true } },
    },
  });
  if (!p) return [];
  const [{ aryeoCustomerNote }, { isAccessNote }, { askMedium }] = await Promise.all([import("@/lib/shoot"), import("@/lib/specialRequests"), import("@/lib/comms")]);
  return orderAskCandidates(
    { id: p.id, clientId: p.clientId, clientName: p.client?.name ?? null, createdAt: p.createdAt, appointments: p.appointments, orderItems: p.orderItems, deliverables: p.deliverables },
    { customerNote: aryeoCustomerNote, isAccessNote, askMedium },
  );
}

/**
 * RETIRED (Oct 19 2026): an order's notes and add-ons are no longer filed as
 * asks. They show on the job's "Before you send" box as notes (lib/jobChecks
 * reads them straight off the order). Kept so an older caller files nothing.
 */
export async function fileOrderAsks(projectId: string): Promise<number> {
  void projectId;
  return 0;
}

// ---- scheduling follow-ups (Aryeo changes, portal session requests): RETIRED ----------------
// Oct 19 2026: a move or cancel seen in Aryeo already rings the appointment
// bell, and a portal session request already has its desk task on Kyle's list.
// Neither is filed as an ask any more; scheduling asks come from the client's
// own texts and emails. The two functions stay, filing nothing, so an older
// caller is harmless; closeSessionRequestAsks still closes rows filed before.

/** RETIRED (Oct 19 2026): files nothing. */
export async function fileAryeoChangeAsk(input: {
  aryeoAppointmentId: string;
  projectId: string;
  change: "canceled" | "postponed" | "rebooked" | "moved";
  startAt: Date | null;
  previousStartAt: Date | null;
  keyPart: string;
}): Promise<string | null> {
  void input;
  return null;
}

/** RETIRED (Oct 19 2026): files nothing. */
export async function fileSessionRequestAsk(input: {
  requestId: string;
  clientId: string;
  projectId: string | null;
  mode: "BOOK" | "CANCEL" | "RESCHEDULE";
  when: string;
  notes?: string | null;
  taskId?: string | null;
  askedBy?: string | null;
}): Promise<string | null> {
  void input;
  return null;
}

/** Aryeo confirmed or cancelled the session: its portal asks are done. Never throws. */
export async function closeSessionRequestAsks(requestId: string, outcome: "COMPLETED" | "CANCELLED"): Promise<number> {
  try {
    const rows = await prisma.clientAsk.findMany({ where: { source: "portal", sourceRef: requestId, state: "OPEN" }, select: { id: true } });
    let n = 0;
    for (const r of rows) {
      const m = await move(r.id, ["OPEN"], "DONE", "Hub (Aryeo matched the session)", { doneAt: new Date(), doneBy: "Hub" }, outcome === "COMPLETED" ? "the session was confirmed in Aryeo" : "the request was closed");
      if (m.ok) n++;
    }
    return n;
  } catch (e) {
    console.error("[client-asks] closing session asks failed", requestId, e);
    return 0;
  }
}

/** Closed by the hub with a reason (DONE; the reason is kept as the note). For a clean-up: no timeline line, no hold check. */
export async function closeAskWithReason(id: string, by: string, why: string): Promise<AskResult> {
  const r = await move(id, ["OPEN"], "DONE", by, { doneAt: new Date(), doneBy: by, confirmNote: clip(why, 500) }, why);
  return r.ok ? { ok: true, message: r.message } : r;
}

// ---- closing on delivery (Oct 19 2026) ------------------------------------------------------

/** Why an open ask closes now that its work went out, or null (pure). */
export function deliveryCloseReason(
  a: { kind: string; medium: string | null; askedAt: Date },
  p: { status: string; deliveredAt: Date | null } | null | undefined,
  photosOutAt: Date | null,
): string | null {
  if (closesOnDelivery(a, p)) return p?.status === "CANCELLED" ? "the job was cancelled" : "the job was delivered";
  if (a.kind === "SPECIAL_REQUEST" && asMedium(a.medium) === "photo" && photosOutAt && photosOutAt.getTime() > a.askedAt.getTime()) return "the photos were delivered";
  return null;
}

/**
 * Every open ask on a job that was delivered (or cancelled) is done: DONE,
 * "the job was delivered" (closesOnDelivery says which). A photo-only request
 * also closes once the job's photos went out. Run every five minutes from the
 * comms cron; cheap (open asks only). Never throws.
 * Oct 22 2026 (photo audit H2): only asks that do NOT hold delivery.
 */
export async function closeAsksOnDeliveredJobs(now: Date = new Date()): Promise<{ closed: number; ids: string[] }> {
  const out = { closed: 0, ids: [] as string[] };
  try {
    const open = await prisma.clientAsk.findMany({
      // PHOTO AUDIT H2 (Oct 22 2026, photo delivery builder): an ask that HOLDS
      // delivery is never closed by this sweep. A delivery done in Aryeo past
      // the hub's checklist (or Aryeo's sticky "delivered" read as a revision's)
      // closed 11 of 23 holding asks in two weeks with nobody looking. Those
      // stay OPEN until a person settles them (photoDelivery/jobs.ts alerts
      // Jordan and Kyle once when the photos go out with holds open).
      where: { state: "OPEN", projectId: { not: null }, holdsDelivery: false },
      select: { id: true, kind: true, medium: true, askedAt: true, projectId: true },
      take: 1000,
    });
    if (!open.length) return out;
    const pids = [...new Set(open.map((a) => a.projectId!))];
    const [projects, photoJobs] = await Promise.all([
      prisma.project.findMany({ where: { id: { in: pids } }, select: { id: true, status: true, deliveredAt: true } }),
      prisma.photoJob.findMany({ where: { projectId: { in: pids }, stage: "DELIVERED" }, select: { projectId: true, deliveredAt: true, stageChangedAt: true } }),
    ]);
    const pById = new Map(projects.map((p) => [p.id, p]));
    // PHOTO AUDIT H3 (Oct 22 2026): PhotoJob.deliveredAt now keeps the FIRST
    // delivery; a photo ask from a later revision closes on the latest one
    // (the job's move back to Delivered).
    const photosOut = new Map(photoJobs.map((j) => [j.projectId, j.deliveredAt && j.deliveredAt > j.stageChangedAt ? j.deliveredAt : j.stageChangedAt]));
    for (const a of open) {
      const why = deliveryCloseReason(a, pById.get(a.projectId!), photosOut.get(a.projectId!) ?? null);
      if (!why) continue;
      const r = await move(a.id, ["OPEN"], "DONE", "Hub", { doneAt: now, doneBy: "Hub", confirmNote: why }, why);
      if (r.ok && r.row) {
        out.closed++;
        out.ids.push(a.id);
      }
    }
  } catch (e) {
    console.error("[client-asks] closing asks on delivered jobs failed", e);
  }
  return out;
}

// ---- closing on the booking (audit Oct 25 2026) ----------------------------------------------
//
// A client's "can we schedule a shoot at 265 Mill Road for Tuesday" is filed
// with no job (there is none yet), and nothing ever closed it once the office
// booked it in Aryeo: a job-less scheduling ask has no delivery to close on.
// Hala Bonner's (booked 4 hours later, under her husband's record) and Stephen
// Kennedy's 3828 Percy St (booked the same day) sat on Kyle's Scheduling
// screen and Messages for days, read as "still waiting". The booking is the
// answer, the same way Aryeo's confirmation closes a portal session request:
// a job created AFTER the ask whose house number and street the client named
// in the ask's own words. It closes DONE ("booked in Aryeo: <street>") and
// files on that job. No address in the words, nothing closes: a person does.

/** Pure: the job (newest first) this job-less scheduling ask booked, or null. */
export function bookedJobFor(
  a: { text: string; askedAt: Date },
  jobs: { id: string; title: string; addressLine: string | null; createdAt: Date; status: string }[],
  addressKey: (j: { title: string; addressLine: string | null }) => { re: RegExp } | null,
): { id: string; title: string } | null {
  const after = a.askedAt.getTime() - 10 * 60_000; // the ask is filed a moment after the text lands
  for (const j of [...jobs].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())) {
    if (j.status === "CANCELLED" || j.createdAt.getTime() < after) continue;
    const k = addressKey(j);
    if (k && k.re.test(a.text)) return { id: j.id, title: j.title };
  }
  return null;
}

/** Close every open job-less scheduling ask whose named address was booked since (see above). Never throws. */
export async function closeBookedSchedulingAsks(now: Date = new Date()): Promise<{ closed: number; ids: string[] }> {
  const out = { closed: 0, ids: [] as string[] };
  try {
    const since = new Date(now.getTime() - 21 * 86_400_000);
    const open = await prisma.clientAsk.findMany({
      where: { state: "OPEN", kind: "SCHEDULING", projectId: null, source: { in: ["text", "email", "call"] }, askedAt: { gte: since } },
      select: { id: true, clientId: true, text: true, askedAt: true },
      take: 200,
    });
    // AN ASK THAT NAMES NO ADDRESS (Jordan, Oct 27 2026 Loom, 36:30: Mike
    // Ciunci's "Can we schedule ahead of time for November?" after he had
    // booked November): any session or job booked for that client after a
    // plain booking question answers it (lib/bookingQuestion; a reschedule, a
    // cancel, or a second question about the work stays for a person).
    const { namesStreetAddress, isBookingQuestion } = await import("@/lib/bookingQuestion");
    const plain = open.filter((a) => !namesStreetAddress(a.text) && isBookingQuestion(a.text));
    if (plain.length) {
      const { bookingsByClient, answeredByBooking } = await import("@/lib/replyQueue");
      const booked = await bookingsByClient(
        plain.map((a) => a.clientId),
        new Date(Math.min(...plain.map((a) => a.askedAt.getTime())) - 10 * 60_000),
      );
      for (const a of plain) {
        const hit = answeredByBooking({ clientId: a.clientId, text: a.text, at: a.askedAt }, booked);
        if (!hit) continue;
        const why = `booked: ${hit.words}`;
        const r = await move(a.id, ["OPEN"], "DONE", "Hub", { doneAt: now, doneBy: "Hub", confirmNote: why }, why);
        if (r.ok && r.row) {
          out.closed++;
          out.ids.push(a.id);
        }
      }
    }
    // Only asks that name a house number can ever match: skip the read otherwise.
    const named = open.filter((a) => /\b\d+[a-z]?\s+[a-z]/i.test(a.text) && !out.ids.includes(a.id));
    if (!named.length) return out;
    const earliest = new Date(Math.min(...named.map((a) => a.askedAt.getTime())) - 10 * 60_000);
    const jobs = await prisma.project.findMany({
      where: { createdAt: { gte: earliest }, status: { not: "CANCELLED" } },
      select: { id: true, title: true, addressLine: true, createdAt: true, status: true },
      take: 500,
    });
    if (!jobs.length) return out;
    const { jobAddressKey } = await import("@/lib/teamRouting");
    for (const a of named) {
      const job = bookedJobFor(a, jobs, jobAddressKey);
      if (!job) continue;
      const street = job.title.split(",")[0];
      const why = `booked in Aryeo: ${street}`;
      const r = await move(a.id, ["OPEN"], "DONE", "Hub", { projectId: job.id, doneAt: now, doneBy: "Hub", confirmNote: why }, why);
      if (r.ok && r.row) {
        out.closed++;
        out.ids.push(a.id);
        await timeline(job.id, `Client's scheduling ask closed: ${why} (${clip(r.row.summary || r.row.text, 160)})`);
      }
    }
  } catch (e) {
    console.error("[client-asks] closing booked scheduling asks failed", e);
  }
  return out;
}

// ---- the job box (lib/jobChecks) -------------------------------------------------------------

export type JobRequestRow = { id: string; summary: string; text: string; askedBy: string | null; askedAt: Date; medium: string | null; source: string };

/**
 * A job's open special requests that the "Before you send" box shows for one
 * medium: the client's own words (text, email, call) or an ask staff typed
 * for them; both / unclear count for either medium. Oldest first. Nothing on
 * a job already delivered.
 */
export async function jobRequests(projectId: string, medium: "video" | "photo"): Promise<JobRequestRow[]> {
  if (!projectId) return [];
  return (await jobRequestsFor([projectId], medium)).get(projectId) ?? [];
}

/** jobRequests for several jobs in two reads (Oct 21 2026, audit B9): the
 *  Review Room's board reads them once for every Ready to send job and hands
 *  each job's list to its box. Every id asked for is in the map. */
export async function jobRequestsFor(projectIds: string[], medium: "video" | "photo"): Promise<Map<string, JobRequestRow[]>> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const out = new Map<string, JobRequestRow[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [rows, projects] = await Promise.all([
    prisma.clientAsk.findMany({
      where: { projectId: { in: ids }, state: "OPEN", kind: "SPECIAL_REQUEST", source: { in: [...ASK_SOURCES] } },
      orderBy: { askedAt: "asc" },
      select: { id: true, projectId: true, summary: true, text: true, askedBy: true, askedAt: true, medium: true, source: true, kind: true },
    }),
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, deliveredAt: true } }),
  ]);
  const pById = new Map(projects.map((p) => [p.id, p]));
  for (const r of rows) {
    if (!r.projectId || !mediumMatches(r.medium, medium) || closesOnDelivery(r, pById.get(r.projectId) ?? null)) continue;
    out.get(r.projectId)?.push({ id: r.id, summary: r.summary?.trim() || clip(r.text.replace(/\s+/g, " "), 140), text: r.text, askedBy: r.askedBy, askedAt: r.askedAt, medium: r.medium, source: r.source });
  }
  return out;
}

// ---- money (Oct 19 2026) ----------------------------------------------------------------------

/** Does the person looking see money? The owner only (never while previewing someone else). With no login in a local, open hub, yes. */
export async function viewerSeesMoney(): Promise<boolean> {
  try {
    const u = await getCurrentUser();
    if (u) return u.role === "OWNER";
    return !authEnforcedNow();
  } catch {
    return false;
  }
}

/** An ask as a non-owner sees it: no amounts in the line or the client's words ("under $350k" reads "under [amount]"). */
export function moneyFree<T extends { summary: string; text: string }>(a: T): T {
  return { ...a, summary: scrubMoney(a.summary), text: scrubMoney(a.text) };
}

// ---- reading: the views the screens draw ----------------------------------------------------

export type AskView = {
  id: string;
  kind: AskKind;
  clientId: string;
  clientName: string | null;
  projectId: string | null;
  street: string | null;
  medium: AskMediumValue;
  text: string;
  summary: string;
  source: string;
  sourceWords: string;
  askedBy: string | null;
  askedAtISO: string;
  whenWords: string;
  state: AskState;
  holdsDelivery: boolean;
  dueAtISO: string | null;
  dueWords: string | null;
  behind: boolean;
  dueToday: boolean;
  /** "Confirmed by Kyle Smith, Sun, Oct 19, 3:02 PM: the lot lines match the plat", when closed. */
  closedWords: string | null;
};

const SOURCE_WORDS: Record<string, string> = {
  text: "Text", email: "Email", call: "Call", order_note: "Order note", portal: "Portal", staff: "Added by staff", aryeo: "Aryeo", wrapup: "Wrap-up",
};
export const sourceWords = (s: string) => SOURCE_WORDS[s] ?? s;

type AskRow = Awaited<ReturnType<typeof readAsks>>[number];
async function readAsks(where: Prisma.ClientAskWhereInput, take = 500) {
  return prisma.clientAsk.findMany({
    where,
    orderBy: { askedAt: "asc" },
    take,
    select: {
      id: true, kind: true, clientId: true, projectId: true, medium: true, text: true, summary: true, source: true,
      askedBy: true, askedAt: true, state: true, holdsDelivery: true, doneAt: true, doneBy: true, confirmedAt: true, confirmedBy: true, confirmNote: true,
    },
  });
}

type ProjectBits = { id: string; title: string; clientId: string; status: string; deliveredAt: Date | null; dueOverrideAt: Date | null; promisedDueAt: Date | null; deliveryDue: Date | null };

function viewOf(r: AskRow, now: Date, projects: Map<string, ProjectBits>, clientNames: Map<string, string | null>): AskView {
  const p = r.projectId ? projects.get(r.projectId) ?? null : null;
  const clock = askClock({ kind: r.kind, source: r.source, askedAt: r.askedAt }, jobPromise(p), now);
  const closedWords =
    r.state === "CONFIRMED"
      ? `Confirmed by ${r.confirmedBy ?? "someone"}${r.confirmedAt ? `, ${etDateTime(r.confirmedAt)}` : ""}${r.confirmNote ? `: ${r.confirmNote}` : ""}`
      : r.state === "NOT_NEEDED"
        ? `Not needed (${r.doneBy ?? "someone"}${r.doneAt ? `, ${etDateTime(r.doneAt)}` : ""})${r.confirmNote ? `: ${r.confirmNote}` : ""}`
        : r.state === "DONE"
          ? `Done by ${r.doneBy ?? "someone"}${r.doneAt ? `, ${etDateTime(r.doneAt)}` : ""}`
          : null;
  const open = r.state === "OPEN";
  return {
    id: r.id,
    kind: r.kind === "SCHEDULING" ? "SCHEDULING" : "SPECIAL_REQUEST",
    clientId: r.clientId,
    clientName: clientNames.get(r.clientId) ?? null,
    projectId: r.projectId,
    street: streetOf(p?.title),
    medium: asMedium(r.medium),
    text: r.text,
    summary: r.summary?.trim() || clip(r.text.replace(/\s+/g, " "), 140),
    source: r.source,
    sourceWords: sourceWords(r.source),
    askedBy: r.askedBy,
    askedAtISO: r.askedAt.toISOString(),
    whenWords: etDateTime(r.askedAt),
    state: (r.state as AskState) ?? "OPEN",
    holdsDelivery: r.holdsDelivery,
    dueAtISO: clock.dueAt ? clock.dueAt.toISOString() : null,
    dueWords: clock.dueAt ? etDateTime(clock.dueAt) : null,
    behind: open && clock.behind,
    dueToday: open && clock.dueToday,
    closedWords,
  };
}

async function contextFor(rows: AskRow[]): Promise<{ projects: Map<string, ProjectBits>; clientNames: Map<string, string | null>; testClients: Set<string> }> {
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const [projects, clients] = await Promise.all([
    projectIds.length
      ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true, clientId: true, status: true, deliveredAt: true, dueOverrideAt: true, promisedDueAt: true, deliveryDue: true } })
      : Promise.resolve([] as ProjectBits[]),
    clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  return {
    projects: new Map(projects.map((p) => [p.id, p as ProjectBits])),
    clientNames: new Map(clients.map((c) => [c.id, c.name])),
    testClients: new Set(clients.filter((c) => isSyntheticClientRow(c)).map((c) => c.id)),
  };
}

/** One job's asks for the Review Room and the photo job page: open first (oldest first), then the last week's closed ones. */
export async function asksForProject(projectId: string, opts: { kind?: AskKind; now?: Date; closedDays?: number } = {}): Promise<{ open: AskView[]; closed: AskView[] }> {
  const now = opts.now ?? new Date();
  // Oct 19 2026: only the kinds still filed (the client's words, or staff's),
  // and nothing open on a job already delivered (the sweep closes those).
  const rows = (await readAsks({ projectId, kind: opts.kind ?? "SPECIAL_REQUEST" }, 100)).filter((r) => isLiveAskSource(r.source));
  const ctx = await contextFor(rows);
  const views = rows.map((r) => viewOf(r, now, ctx.projects, ctx.clientNames));
  const since = now.getTime() - (opts.closedDays ?? 7) * 86_400_000;
  const closedAt = (r: AskRow) => (r.confirmedAt ?? r.doneAt ?? r.askedAt).getTime();
  const shown = (await viewerSeesMoney()) ? views : views.map(moneyFree);
  return {
    open: shown.filter((v, i) => v.state === "OPEN" && !closesOnDelivery(rows[i], ctx.projects.get(rows[i].projectId ?? ""))),
    closed: shown.filter((v, i) => v.state !== "OPEN" && closedAt(rows[i]) >= since).reverse(),
  };
}

export type RequestGroup = {
  key: string;
  projectId: string | null;
  clientId: string;
  clientName: string | null;
  street: string | null;
  dueWords: string | null;
  media: AskMediumValue[];
  behind: boolean;
  asks: AskView[];
};

export type JobChoice = { id: string; clientId: string; label: string };

/** Kyle's Special requests screen: open special requests grouped by job, oldest first (test clients left out). */
export async function specialRequestsBoard(now: Date = new Date(), opts: { countsOnly?: boolean } = {}): Promise<{ groups: RequestGroup[]; counts: JobCounts; closed: AskView[]; jobs: JobChoice[] }> {
  const rows = await readAsks({ kind: "SPECIAL_REQUEST", state: "OPEN" });
  const ctx = await contextFor(rows);
  // Test clients, the kinds no longer filed (order notes, add-ons) and jobs already delivered are left out.
  const live = rows.filter((r) => !ctx.testClients.has(r.clientId) && isLiveAskSource(r.source) && !closesOnDelivery(r, ctx.projects.get(r.projectId ?? "")));
  const seesMoney = opts.countsOnly ? true : await viewerSeesMoney();
  const scrub = (v: AskView) => (seesMoney ? v : moneyFree(v));
  const views = live.map((r) => scrub(viewOf(r, now, ctx.projects, ctx.clientNames)));
  const groups = new Map<string, RequestGroup>();
  for (const v of views) {
    const key = v.projectId ?? `none:${v.clientId}`;
    const p = v.projectId ? ctx.projects.get(v.projectId) : null;
    const promise = jobPromise(p);
    const g = groups.get(key) ?? { key, projectId: v.projectId, clientId: v.clientId, clientName: v.clientName, street: v.street, dueWords: promise ? etDateTime(promise) : null, media: [], behind: false, asks: [] };
    g.asks.push(v);
    if (!g.media.includes(v.medium)) g.media.push(v.medium);
    g.behind = g.behind || v.behind;
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => a.asks[0].askedAtISO.localeCompare(b.asks[0].askedAtISO));
  const counts = countsOf(views.map((v) => ({ askedAt: new Date(v.askedAtISO), behind: v.behind, dueToday: v.dueToday })), now);
  if (opts.countsOnly) return { groups: ordered, counts, closed: [], jobs: [] };

  // The last week's closed ones, newest first, for an undo.
  const closedRows = await readAsks({ kind: "SPECIAL_REQUEST", state: { in: ["DONE", "CONFIRMED", "NOT_NEEDED"] }, updatedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, 60);
  const cctx = await contextFor(closedRows);
  const closed = closedRows.filter((r) => !cctx.testClients.has(r.clientId) && isLiveAskSource(r.source)).map((r) => scrub(viewOf(r, now, cctx.projects, cctx.clientNames))).reverse();

  // Jobs a hand-added or job-less ask can go on: work in flight from the last 60 days.
  const jobRows = await prisma.project.findMany({
    where: { status: { notIn: ["DELIVERED", "CANCELLED"] }, deliveredAt: null, OR: [{ shootDate: { gte: new Date(now.getTime() - 60 * 86_400_000) } }, { createdAt: { gte: new Date(now.getTime() - 60 * 86_400_000) } }] },
    orderBy: [{ shootDate: { sort: "desc", nulls: "last" } }],
    take: 150,
    select: { id: true, title: true, clientId: true, client: { select: { id: true, name: true } } },
  });
  const jobs = jobRows
    .filter((j) => !isSyntheticClientRow({ id: j.client?.id, name: j.client?.name }))
    .map((j) => ({ id: j.id, clientId: j.clientId, label: `${streetOf(j.title) ?? "A job"}${j.client?.name ? ` · ${j.client.name}` : ""}` }));
  return { groups: ordered, counts, closed, jobs };
}

/** Kyle's Scheduling screen: the clients' scheduling asks, and moves or cancels seen in Aryeo in the last 48 hours (test clients left out). */
export async function schedulingBoard(now: Date = new Date(), opts: { countsOnly?: boolean } = {}): Promise<{ asks: AskView[]; aryeo: AskView[]; counts: JobCounts; closed: AskView[] }> {
  const rows = await readAsks({ kind: "SCHEDULING", state: "OPEN" });
  const ctx = await contextFor(rows);
  // Oct 19 2026: the client's own scheduling asks only. A move or cancel seen
  // in Aryeo (the appointment bell covers it) and a portal session request
  // (its desk task covers it) are no longer asks; `aryeo` stays in the shape,
  // empty. A job delivered after the ask was made is left out too.
  const live = rows.filter((r) => !ctx.testClients.has(r.clientId) && isLiveAskSource(r.source) && !closesOnDelivery(r, ctx.projects.get(r.projectId ?? "")));
  const seesMoney = opts.countsOnly ? true : await viewerSeesMoney();
  const scrub = (v: AskView) => (seesMoney ? v : moneyFree(v));
  const views = live.map((r) => scrub(viewOf(r, now, ctx.projects, ctx.clientNames)));
  const asks = views.filter((v) => v.source !== "aryeo");
  const aryeo = views.filter((v) => v.source === "aryeo");
  const counts = countsOf(views.map((v) => ({ askedAt: new Date(v.askedAtISO), behind: v.behind, dueToday: v.dueToday })), now);
  if (opts.countsOnly) return { asks, aryeo, counts, closed: [] };
  const closedRows = await readAsks({ kind: "SCHEDULING", state: { in: ["DONE", "CONFIRMED", "NOT_NEEDED"] }, updatedAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } }, 40);
  const cctx = await contextFor(closedRows);
  const closed = closedRows.filter((r) => !cctx.testClients.has(r.clientId) && isLiveAskSource(r.source)).map((r) => scrub(viewOf(r, now, cctx.projects, cctx.clientNames))).reverse();
  return { asks, aryeo, counts, closed };
}

/** A client's open asks from the last `days`, for the "never mind" re-read (revisionNotNeeded). */
export async function openAsksForClient(clientId: string, days: number, now: Date = new Date()) {
  return prisma.clientAsk.findMany({
    // The client's own asks only (Oct 19 2026): an order note or a portal or Aryeo row was never said in the conversation.
    where: { clientId, state: "OPEN", source: { in: [...ASK_SOURCES] }, askedAt: { gte: new Date(now.getTime() - days * 86_400_000) } },
    orderBy: { askedAt: "asc" },
    select: { id: true, kind: true, text: true, summary: true, askedAt: true, askedBy: true, projectId: true },
  });
}

import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE OUTBOX (RTP-08, Sep 16 2026). One durable record per message the hub
// sends a human, and one place where the provider is actually called.
//
// WHAT WAS WRONG. Every send path in this hub wrote its claim — the SmartTask
// flipped to COMPLETED, or the `auto-*` AppSetting marker created — BEFORE
// OpenPhone answered. Two failures fall out of that and neither is visible on
// screen:
//   · kill the process between the claim and the send and the message is gone
//     for good. The task reads COMPLETED, the Done ledger counts it, and
//     nothing re-reads a closed row (tasks.ts closeStaleDeliveryTexts only
//     looks at rows NOT in COMPLETED/CANCELLED). 55 of 96 COMPLETED
//     delivery-text rows in 60 days carried no proof the hub's own rule could
//     confirm.
//   · a provider that accepts and then times out looked identical to a refusal,
//     so the manual path rolled the claim back and invited a second text to a
//     client who was already reading the first.
//
// WHAT THIS IS. A row per message, moving pending → attempting → accepted |
// failed | unknown, and never backwards except through a named recovery:
//   pending     queued, nothing has touched a provider. Safe to send.
//   attempting  a worker holds a lease (leaseUntil/leaseBy). `attempts` counts
//               the times this row was handed to a provider — it is bumped in
//               its own write immediately BEFORE the call, and that write is
//               the fence the whole design turns on.
//   accepted    the provider took it and gave us its own id (providerId).
//   failed      NOTHING WAS SENT — the provider refused it, or the worker
//               stopped before it ever reached one. The dedupeKey is released
//               so the owning sweep can offer the message again under freshly
//               evaluated gates.
//   unknown     the provider MAY have sent it (a timeout, a 5xx, a worker that
//               died mid-call). The dedupeKey is HELD for ever, so nothing
//               retries it blindly; a person settles it in OpenPhone and
//               presses Retry (unknownSends / retryUnknownSend below).
//
// DUPLICATE MEANS UNIQUE VIOLATION, NOTHING ELSE. `dedupeKey` is the identity
// of a message — one delivery text per job, one welcome per client, one
// confirmation per shoot TIME. `enqueue` treats a P2002 on that key as "someone
// else owns this message" and rethrows every other database error, because a
// Neon blip read as a duplicate claim is exactly how a text goes missing
// silently (the four untyped `catch {}` blocks this replaces).
//
// THE MARKERS STILL EXIST, AND THEY MOVED. The `auto-confirm-*`,
// `auto-delivery-*`, `auto-welcome-*` and `auto-afterhours-*` AppSetting rows
// are still written, still mean "this message went out (or may have)", and are
// still what tasks.ts reads — but they are now written AFTER the provider
// accepts (or after an unknown), not before the send. The outbox row, not the
// marker, is what two overlapping crons race on.
//
// NOTHING IN HERE WRITES A TASK, A MARKER OR A COMM LOG. The outbox owns the
// message and the provider's id; the callers own their own bookkeeping, and do
// it only once this file tells them the provider took the message.
// ---------------------------------------------------------------------------

export type OutboxChannel = "sms" | "email";
export type OutboxState = "pending" | "attempting" | "accepted" | "failed" | "unknown";

/** The kinds of message the hub sends. The kind is the first segment of the
 *  dedupeKey, so a row always says what it is without another column. The four
 *  client kinds are subject to Jordan's quiet hours; `staff` never is (a
 *  Saturday shoot reminder has to go out on a Saturday).
 *
 *  `portal_login` and `portal_invite` (Sep 16, D14) are TRANSACTIONAL: a
 *  person asked for a sign-in link at 7:30 pm and expects it in the next
 *  minute, so they are deliberately NOT in CLIENT_KINDS and the drain never
 *  holds them for the Mon–Fri-before-4:30 window. They are gated instead by the
 *  ProgramAutomation switches `portal_login_email` / `portal_invites`, which
 *  stay OFF until launch is authorised — nothing of these kinds is even
 *  enqueued while a switch is off (src/lib/portalAccess.ts). */
export type OutboxKind =
  | "confirmation" | "delivery" | "welcome" | "afterhours" | "staff" | "portal_login" | "portal_invite"
  | "program_reminder" | "script_share" | "strategy_ready"
  /** R4: a text a PERSON typed and pressed send on, from the comms surface. */
  | "manual";
const CLIENT_KINDS: readonly OutboxKind[] = ["confirmation", "delivery", "welcome", "afterhours"];
/** CONTENT-PROGRAM kinds (W2-F, Sep 17 2026). Client-facing EMAILS from the
 *  program: a §24 reminder, a §22 "your scripts are ready" notice, a §21
 *  "your strategy is ready" notice. They are NOT in CLIENT_KINDS (those four
 *  are the existing automatic texts with their AppSetting markers and their
 *  `auto-*` CommLog sources, which this build never touches) — but they ARE
 *  subject to the same Mon–Fri-before-4:30 window: `isClientKind` answers true
 *  for them so the recovery drain holds them exactly like a delivery text,
 *  and recordDrainedSend, which recognises only the four marker kinds, simply
 *  writes nothing for them (their ledger is ProgramReminder, reconciled from
 *  the outbox row by src/lib/programReminders.ts). Nothing of these kinds is
 *  enqueued unless its ProgramAutomation switch (`reminders`,
 *  `script_share_email`) is on — a missing row is off. */
const PROGRAM_KINDS: readonly OutboxKind[] = ["program_reminder", "script_share", "strategy_ready"];
const ALL_KINDS: readonly OutboxKind[] = [...CLIENT_KINDS, "staff", "portal_login", "portal_invite", ...PROGRAM_KINDS];
export const isClientKind = (k: OutboxKind | null): boolean => !!k && (CLIENT_KINDS.includes(k) || PROGRAM_KINDS.includes(k));
export const isProgramKind = (k: OutboxKind | null): boolean => !!k && PROGRAM_KINDS.includes(k);

export type OutboxRow = {
  id: string;
  channel: string;
  toRef: string;
  body: string;
  state: string;
  attempts: number;
  leaseUntil: Date | null;
  leaseBy: string | null;
  providerId: string | null;
  providerError: string | null;
  dedupeKey: string | null;
  requestedBy: string | null;
  clientId: string | null;
  projectId: string | null;
  taskId: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
  resolvedAt: Date | null;
  /** R4: a group text's other recipients, and any attachments. JSON, as stored. */
  extraToRefsJson: string | null;
  mediaUrlsJson: string | null;
};

export type OutboxMessageInput = {
  channel: OutboxChannel;
  /** A 10-digit phone key for sms, an email address for email. Never rendered
   *  raw to anyone but the owner — see maskToRef. */
  toRef: string;
  body: string;
  /** REQUIRED. Every message in this system has a natural identity; see the
   *  key builders at the bottom of the file. */
  dedupeKey: string;
  clientId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  /** The person, or the sweep, that queued it. */
  requestedBy?: string | null;
  /**
   * R4 (Sep 22 2026) — THE TWO REASONS MANUAL SENDS BYPASSED THIS RAIL.
   *
   * A text Kyle types can go to a GROUP and can carry an attachment, and this
   * input carried neither — so communications/threadActions called OpenPhone
   * directly, with no durable intent, no honest "unknown", and (as the
   * follow-up audit found) outside the TEST-client floor that
   * refuseTestClientSend installs on this very function.
   *
   * `toRef` stays THE recipient, so masking, the indexes and every existing
   * reader keep working unchanged. These carry the rest.
   */
  extraToRefs?: string[] | null;
  mediaUrls?: string[] | null;
};

export type OutboxSendResult =
  /** The provider took it and named it. Do your bookkeeping now, not before. */
  | { outcome: "accepted"; id: string; providerId: string | null }
  /** Nothing was sent, and the identity is free again — offer it next tick. */
  | { outcome: "failed"; id: string; error: string }
  /** It may have gone. Held for ever; never resend without a person. */
  | { outcome: "unknown"; id: string; error: string }
  /** Someone else owns this message (another cron, a human, an earlier send). */
  | { outcome: "duplicate"; id: string; state: OutboxState }
  /** A live lease holds it right now — the other worker is mid-send. */
  | { outcome: "busy"; id: string };

/** How long a worker may hold a row before the recovery pass may touch it.
 *  Comfortably longer than the slowest provider call (the OpenPhone send now
 *  aborts at 30s) so a healthy send is never recovered out from under itself. */
const LEASE_MS = 5 * 60_000;
/** A pending row older than this was queued by a worker that never came back.
 *  It is released rather than sent: the sweep that queued it re-evaluates every
 *  gate (the client's switch, quiet hours, the monthly batch) before offering
 *  it again, and those gates are the ones Jordan wrote. */
const STALE_PENDING_MS = 15 * 60_000;

// ---- the provider seam ------------------------------------------------------

/** A send that failed. `ambiguous` is the only thing that matters: false means
 *  the provider REFUSED it and nothing left the building; true means we cannot
 *  tell, so the message is held. Anything we can't classify is ambiguous — the
 *  safe direction is a stuck message, never a duplicate text. */
export class OutboxSendError extends Error {
  constructor(message: string, readonly ambiguous: boolean, readonly status?: number) {
    super(message);
    this.name = "OutboxSendError";
  }
}

export type OutboxProvider = {
  /** Hand the message over. Resolve with the provider's own id (null when it
   *  gives none), or throw OutboxSendError. */
  send(row: Pick<OutboxRow, "channel" | "toRef" | "body" | "dedupeKey" | "extraToRefsJson" | "mediaUrlsJson">): Promise<{ providerId: string | null }>;
};

// ---- the store seam ---------------------------------------------------------
// Narrow on purpose: the whole state machine is exercised by the kill-and-
// timeout tests against an in-memory store, so proving this file's behaviour
// never needs a write to the live database.

export type OutboxListFilter = {
  state?: OutboxState | OutboxState[];
  leaseUntilBefore?: Date;
  createdBefore?: Date;
  createdAfter?: Date;
  limit?: number;
  order?: "asc" | "desc";
};
export type OutboxPatchWhere = { state?: OutboxState | OutboxState[]; leaseBy?: string };
export type OutboxPatchData = {
  state?: OutboxState;
  leaseUntil?: Date | null;
  leaseBy?: string | null;
  providerId?: string | null;
  providerError?: string | null;
  acceptedAt?: Date | null;
  resolvedAt?: Date | null;
  dedupeKey?: string | null;
  bumpAttempts?: boolean;
};
export type OutboxStore = {
  /** Throws OutboxDuplicateError — and ONLY that — on a dedupeKey clash. */
  insert(row: OutboxMessageInput): Promise<OutboxRow>;
  byId(id: string): Promise<OutboxRow | null>;
  byDedupeKey(key: string): Promise<OutboxRow | null>;
  patch(id: string, where: OutboxPatchWhere, data: OutboxPatchData): Promise<number>;
  list(filter: OutboxListFilter): Promise<OutboxRow[]>;
  count(filter: OutboxListFilter): Promise<number>;
};

export class OutboxDuplicateError extends Error {
  constructor(readonly dedupeKey: string) {
    super(`A message is already claimed under ${dedupeKey}`);
    this.name = "OutboxDuplicateError";
  }
}

/** A unique-key violation on `dedupeKey`, and nothing else. A P2002 naming a
 *  different constraint, or any other Prisma error, is a real failure and must
 *  reach the caller — reading "the database blinked" as "already sent" is the
 *  bug this whole ticket exists to remove. */
function isDedupeConflict(e: unknown): boolean {
  const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : (e as { code?: string } | null)?.code;
  if (code !== "P2002") return false;
  const target = (e as { meta?: { target?: unknown } })?.meta?.target;
  if (target === undefined || target === null) return true; // driver gave no field list
  const named = Array.isArray(target) ? target.join(",") : String(target);
  return named.includes("dedupeKey");
}

const ROW_SELECT = {
  id: true, channel: true, toRef: true, body: true, state: true, attempts: true,
  leaseUntil: true, leaseBy: true, providerId: true, providerError: true,
  dedupeKey: true, requestedBy: true, clientId: true, projectId: true, taskId: true,
  createdAt: true, acceptedAt: true, resolvedAt: true,
  extraToRefsJson: true, mediaUrlsJson: true,
} as const;

/** A stored JSON string[] column, read defensively — a malformed blob is an empty list, never a throw mid-send. */
export function parseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  } catch {
    return [];
  }
}

function stateWhere(state: OutboxState | OutboxState[] | undefined) {
  if (!state) return {};
  return { state: Array.isArray(state) ? { in: state } : state };
}

export function prismaOutboxStore(): OutboxStore {
  const filterWhere = (f: OutboxListFilter) => ({
    ...stateWhere(f.state),
    ...(f.leaseUntilBefore ? { leaseUntil: { lt: f.leaseUntilBefore } } : {}),
    ...(f.createdBefore || f.createdAfter
      ? { createdAt: { ...(f.createdBefore ? { lt: f.createdBefore } : {}), ...(f.createdAfter ? { gt: f.createdAfter } : {}) } }
      : {}),
  });
  return {
    async insert(row) {
      try {
        return (await prisma.outboxMessage.create({
          data: {
            channel: row.channel,
            toRef: row.toRef,
            body: row.body,
            dedupeKey: row.dedupeKey,
            clientId: row.clientId ?? null,
            projectId: row.projectId ?? null,
            taskId: row.taskId ?? null,
            requestedBy: row.requestedBy ?? null,
            extraToRefsJson: row.extraToRefs?.length ? JSON.stringify(row.extraToRefs) : null,
            mediaUrlsJson: row.mediaUrls?.length ? JSON.stringify(row.mediaUrls) : null,
            state: "pending",
          },
          select: ROW_SELECT,
        })) as OutboxRow;
      } catch (e) {
        if (isDedupeConflict(e)) throw new OutboxDuplicateError(row.dedupeKey);
        throw e;
      }
    },
    async byId(id) {
      return (await prisma.outboxMessage.findUnique({ where: { id }, select: ROW_SELECT })) as OutboxRow | null;
    },
    async byDedupeKey(dedupeKey) {
      return (await prisma.outboxMessage.findUnique({ where: { dedupeKey }, select: ROW_SELECT })) as OutboxRow | null;
    },
    async patch(id, where, data) {
      const { bumpAttempts, ...rest } = data;
      const r = await prisma.outboxMessage.updateMany({
        where: { id, ...stateWhere(where.state), ...(where.leaseBy ? { leaseBy: where.leaseBy } : {}) },
        data: { ...rest, ...(bumpAttempts ? { attempts: { increment: 1 } } : {}) },
      });
      return r.count;
    },
    async list(f) {
      return (await prisma.outboxMessage.findMany({
        where: filterWhere(f),
        select: ROW_SELECT,
        orderBy: { createdAt: f.order ?? "asc" },
        take: f.limit ?? 50,
      })) as OutboxRow[];
    },
    async count(f) {
      return prisma.outboxMessage.count({ where: filterWhere(f) });
    },
  };
}

// ---- the real providers -----------------------------------------------------

// Our sending number, briefly cached. Without this every single text costs an
// extra OpenPhone round trip (the sweeps used to resolve it once per sweep).
let fromCache: { at: number; number: string | null } | null = null;
async function sendingNumber(): Promise<string | null> {
  if (fromCache && Date.now() - fromCache.at < 60_000) return fromCache.number;
  const { defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const number = await defaultOpenPhoneNumber();
  fromCache = { at: Date.now(), number };
  return number;
}

export function realOutboxProvider(): OutboxProvider {
  return {
    async send(row) {
      if (row.channel === "email") {
        const { sendGmailNew } = await import("@/lib/integrations/google");
        const res = await sendGmailNew({
          mailbox: "info@realtourpilot.com",
          to: row.toRef,
          subject: subjectFor(outboxKind(row.dedupeKey), row.dedupeKey),
          body: row.body,
        });
        if (res.ok) return { providerId: res.id ?? null };
        // Gmail answers in words, not exceptions. A refusal we understand (no
        // account, a token that can read but not send, a malformed address) is
        // a clean rejection; a 5xx or a transport failure is not.
        const ambiguous = !(res.needsReconnect || (res.status !== undefined && res.status >= 400 && res.status < 500));
        throw new OutboxSendError(res.error, ambiguous, res.status);
      }
      const { OpenPhone, OpenPhoneError } = await import("@/lib/integrations/openphone");
      const from = await sendingNumber();
      if (!from) throw new OutboxSendError("OpenPhone isn't connected.", false, 401);
      try {
        // R4: one recipient stays a string (every existing caller), a group
        // becomes the array OpenPhone's own API takes. Attachments ride along.
        const extra = parseJsonArray(row.extraToRefsJson);
        const media = parseJsonArray(row.mediaUrlsJson);
        const to = extra.length ? [row.toRef, ...extra].map((k) => `+1${k}`) : `+1${row.toRef}`;
        const res = await OpenPhone.sendMessage(from, to, row.body, media.length ? media : undefined);
        return { providerId: res?.data?.id ?? null };
      } catch (e) {
        // A 4xx (except 408) means OpenPhone REJECTED it — nothing was sent.
        // A timeout, a 408 or a 5xx may have landed after acceptance, and an
        // error we can't read at all is ambiguous by default.
        const provablyNotSent =
          e instanceof OpenPhoneError && typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408;
        throw new OutboxSendError(
          e instanceof Error ? e.message : "OpenPhone send failed",
          !provablyNotSent,
          e instanceof OpenPhoneError ? e.status : undefined,
        );
      }
    },
  };
}

/** The subject an emailed message goes out under. The outbox carries no
 *  subject column — email is the fallback rail for the welcome (a client with
 *  no phone), so the kind names it. */
export function subjectFor(kind: OutboxKind | null, dedupeKey?: string | null): string {
  switch (kind) {
    case "welcome": return "Welcome to RealTour Pilot";
    case "portal_login": return "Your RealTour Pilot sign-in link";
    case "portal_invite": return "You've been added to your RealTour Pilot content portal";
    case "program_reminder": return programReminderSubject(dedupeKey ?? null);
    case "script_share": return "Your scripts are ready in your RealTour Pilot portal";
    case "strategy_ready": return "Your content strategy is ready in your RealTour Pilot portal";
    default: return "RealTour Pilot";
  }
}

/** The subject of a §24 reminder lives in its identity — `program_reminder:
 *  <ACTION>:<reminderId>:<monthKey>` — because the outbox carries no subject
 *  column and a reminder about October must not go out under a generic line. */
function programReminderSubject(dedupeKey: string | null): string {
  const [, action, , monthKey] = (dedupeKey ?? "").split(":");
  const month = monthKey && /^\d{4}-\d{2}$/.test(monthKey)
    ? new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 15)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })
    : null;
  const forMonth = month ? ` your ${month} content` : " your content";
  switch (action) {
    case "BOOK_SESSION": return `Let's book${forMonth} session`;
    case "REVIEW_WORK": return "Your videos are ready to review";
    case "SESSION_REQUEST_FOLLOWUP": return `About${forMonth} session request`;
    default: return `Let's plan${forMonth}`;
  }
}

// ---- the machine ------------------------------------------------------------

export type Outbox = ReturnType<typeof createOutbox>;

export function createOutbox(deps: { store: OutboxStore; provider: OutboxProvider; now?: () => Date }) {
  const { store, provider } = deps;
  const now = deps.now ?? (() => new Date());

  /** Put a message in the outbox. A P2002 on the dedupeKey — and ONLY that —
   *  means somebody already owns this message; every other database error is
   *  rethrown so the caller can fail loudly instead of quietly dropping a text. */
  async function enqueue(
    msg: OutboxMessageInput,
  ): Promise<{ id: string; duplicate: boolean; state: OutboxState; row: OutboxRow | null }> {
    try {
      const row = await store.insert(msg);
      return { id: row.id, duplicate: false, state: "pending", row };
    } catch (e) {
      if (!(e instanceof OutboxDuplicateError)) throw e;
      const held = await store.byDedupeKey(msg.dedupeKey);
      // The holder can vanish between the conflict and this read (a concurrent
      // markFailed releases the key). Say so honestly rather than inventing a
      // state: the caller's next tick will re-enqueue.
      if (!held) return { id: "", duplicate: true, state: "failed", row: null };
      return { id: held.id, duplicate: true, state: held.state as OutboxState, row: held };
    }
  }

  /** Take a lease on `n` pending rows. The lease is conditional (pending →
   *  attempting on the row's own id), so two workers can never hold the same
   *  message. `attempts` is untouched here — nothing has met a provider yet. */
  async function claim(workerId: string, n = 5, opts: { maxAgeMs?: number } = {}): Promise<OutboxRow[]> {
    const at = now();
    const candidates = await store.list({
      state: "pending",
      limit: Math.max(1, n) * 2,
      order: "asc",
      ...(opts.maxAgeMs ? { createdAfter: new Date(at.getTime() - opts.maxAgeMs) } : {}),
    });
    const won: OutboxRow[] = [];
    for (const c of candidates) {
      if (won.length >= n) break;
      const leased = await claimById(c.id, workerId);
      if (leased) won.push(leased);
    }
    return won;
  }

  /** Lease one known row. Returns the leased row, or null when someone else
   *  got there first (the same conditional update `claim` uses). */
  async function claimById(id: string, workerId: string): Promise<OutboxRow | null> {
    const at = now();
    const count = await store.patch(id, { state: "pending" }, { state: "attempting", leaseBy: workerId, leaseUntil: new Date(at.getTime() + LEASE_MS) });
    if (count === 0) return null;
    return store.byId(id);
  }

  /** WHO IS ALLOWED TO CLOSE THIS ROW (review, Sep 16). Every mark below takes
   *  an optional `leaseBy`, and `deliver` always passes its own worker id: a
   *  closing write then lands only on the row THIS worker still holds. Without
   *  it a mark can settle a row another worker has since taken over — which is
   *  how the watchdog's release came to flip a row a second worker was already
   *  mid-send on, freeing its identity for a duplicate text. */
  type MarkOpts = { leaseBy?: string };

  async function markAccepted(id: string, providerId: string | null, opts: MarkOpts = {}): Promise<boolean> {
    const at = now();
    const n = await store.patch(
      id,
      { state: "attempting", ...(opts.leaseBy ? { leaseBy: opts.leaseBy } : {}) },
      { state: "accepted", providerId, acceptedAt: at, resolvedAt: at, leaseUntil: null, leaseBy: null, providerError: null },
    );
    return n > 0;
  }

  /** NOTHING WAS SENT. The identity is released (dedupeKey → null) so the sweep
   *  that owns this message offers it again on its next tick, with every gate
   *  re-evaluated — the same behaviour the old code got by deleting its
   *  AppSetting marker on a provable rejection.
   *
   *  Releasing an identity is the most dangerous write in this file: it is the
   *  one that lets a second text go out. So callers that hold a lease pass it —
   *  see MarkOpts — and the watchdog never uses this to release a PENDING row
   *  (it patches pending → failed conditionally on the row still being pending;
   *  see recoverExpiredLeases). */
  async function markFailed(id: string, error: string, opts: MarkOpts = {}): Promise<boolean> {
    const at = now();
    const n = await store.patch(
      id,
      { state: ["pending", "attempting"], ...(opts.leaseBy ? { leaseBy: opts.leaseBy } : {}) },
      { state: "failed", providerError: error.slice(0, 500), resolvedAt: at, leaseUntil: null, leaseBy: null, dedupeKey: null },
    );
    return n > 0;
  }

  /** IT MAY HAVE GONE. The dedupeKey is kept for ever, so no sweep, no panel
   *  and no recovery pass can send this message again — only a person can, from
   *  the Connections health card, after checking the provider's own thread. */
  async function markUnknown(id: string, reason: string, opts: MarkOpts = {}): Promise<boolean> {
    const at = now();
    const n = await store.patch(
      id,
      { state: ["pending", "attempting"], ...(opts.leaseBy ? { leaseBy: opts.leaseBy } : {}) },
      { state: "unknown", providerError: reason.slice(0, 500), resolvedAt: at, leaseUntil: null, leaseBy: null },
    );
    return n > 0;
  }

  /** THE ONE FUNCTION THAT TALKS TO A PROVIDER. Everything else in this hub
   *  queues; only this sends, and only this records the provider's id.
   *
   *  The order matters and is the whole point of the ticket:
   *    1. bump `attempts` — a single write that says "this row is about to be
   *       handed over". A crash before it leaves the row recoverable to
   *       pending (nothing was sent); a crash after it leaves it recoverable
   *       only to unknown (it may have been).
   *    2. call the provider.
   *    3. record what it said.
   */
  async function deliver(id: string, workerId: string): Promise<OutboxSendResult> {
    const fenced = await store.patch(id, { state: "attempting", leaseBy: workerId }, { bumpAttempts: true });
    if (fenced === 0) return { outcome: "busy", id };
    const row = await store.byId(id);
    if (!row) return { outcome: "busy", id };
    try {
      const { providerId } = await provider.send(row);
      // The mark can MISS: the watchdog may have recovered this row to `unknown`
      // while the provider was answering. Saying "accepted" then would have the
      // caller stamp its marker and complete its task against a row that reads
      // unknown and sits on the unconfirmed list for ever (review, Sep 16). Tell
      // the truth instead — it went out, but the ledger needs a person.
      const recorded = await markAccepted(id, providerId, { leaseBy: workerId });
      if (!recorded) {
        const held = await store.byId(id);
        return {
          outcome: "unknown",
          id,
          error: `the provider accepted this (${providerId ?? "no id"}) but the row had already been recovered to ${held?.state ?? "an unknown state"} — settle it by hand`,
        };
      }
      return { outcome: "accepted", id, providerId };
    } catch (e) {
      // An OutboxSendError knows whether the provider refused. Anything else
      // reached us from somewhere we can't reason about, so it is ambiguous —
      // a stuck message a person can see beats a second text to a client.
      const ambiguous = e instanceof OutboxSendError ? e.ambiguous : true;
      const message = e instanceof Error ? e.message : "send failed";
      if (ambiguous) {
        await markUnknown(id, message, { leaseBy: workerId });
        return { outcome: "unknown", id, error: message };
      }
      const recorded = await markFailed(id, message, { leaseBy: workerId });
      if (!recorded) {
        // Refused — but somebody else closed this row while we were waiting, so
        // the identity is NOT ours to release. Report the safe outcome: the row
        // stays held and a person settles it, rather than this worker freeing an
        // identity a second worker may be sending under.
        const held = await store.byId(id);
        return {
          outcome: "unknown",
          id,
          error: `${message} — the row had already been recovered to ${held?.state ?? "an unknown state"}, so it is held rather than released`,
        };
      }
      return { outcome: "failed", id, error: message };
    }
  }

  /** Queue it, lease it, send it — what both the Send-all panel and every
   *  automatic sweep call. The only path to a provider in this codebase. */
  async function sendThroughOutbox(msg: OutboxMessageInput, opts: { workerId?: string } = {}): Promise<OutboxSendResult> {
    const workerId = opts.workerId ?? `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const q = await enqueue(msg);
    if (q.duplicate) return { outcome: "duplicate", id: q.id, state: q.state };
    const leased = await claimById(q.id, workerId);
    if (!leased) return { outcome: "busy", id: q.id };
    return deliver(q.id, workerId);
  }

  /** The watchdog. An expired lease is a worker that stopped; what happens next
   *  depends entirely on whether it had reached the provider:
   *    · attempts === 0 → back to pending. Nothing was sent.
   *    · attempts  >  0 → unknown. It may have been, so it is never retried
   *      blindly; it surfaces on Connections for a person instead.
   *  Stale pending rows (a worker that died between queueing and leasing, or
   *  one just returned above) are released rather than sent here: their sweep
   *  re-checks the client's switch, the quiet hours and the batch rule before
   *  offering them again, and those gates are not this file's to re-implement. */
  async function recoverExpiredLeases(): Promise<{ returned: number; unknown: number; released: number; ids: string[] }> {
    const at = now();
    let returned = 0;
    let unknownCount = 0;
    let released = 0;
    const ids: string[] = [];
    const expired = await store.list({ state: "attempting", leaseUntilBefore: at, limit: 100, order: "asc" });
    for (const row of expired) {
      if (row.attempts > 0) {
        const ok = await markUnknown(
          row.id,
          `the worker stopped after handing this to the provider (attempt ${row.attempts}) — it may already have been sent, so nothing was retried`,
        );
        if (ok) { unknownCount++; ids.push(row.id); }
        continue;
      }
      const n = await store.patch(row.id, { state: "attempting" }, { state: "pending", leaseBy: null, leaseUntil: null });
      if (n > 0) returned++;
    }
    const stale = await store.list({ state: "pending", createdBefore: new Date(at.getTime() - STALE_PENDING_MS), limit: 100, order: "asc" });
    for (const row of stale) {
      // PENDING-ONLY, deliberately not markFailed (review, Sep 16). markFailed
      // also accepts an `attempting` row, so between this list and this write
      // another worker could have leased the row and handed it to the provider —
      // and this release would then free its identity while the text was in the
      // air, inviting a second one on the next tick. The conditional patch can
      // only land while the row is still untouched.
      const n = await store.patch(
        row.id,
        { state: "pending" },
        {
          state: "failed",
          providerError: "never reached a provider — the worker stopped before the send, so this was released for its sweep to offer again",
          resolvedAt: at,
          leaseUntil: null,
          leaseBy: null,
          dedupeKey: null,
        },
      );
      if (n > 0) released++;
    }
    return { returned, unknown: unknownCount, released, ids };
  }

  /** Send what a stopped worker queued but never handed over. Only rows young
   *  enough that their gates cannot have gone stale, and only when `canSend`
   *  agrees — the cron passes the client-text window here, so the 4:30pm rule
   *  holds even on the recovery path. Anything it refuses simply ages out and
   *  is released to its sweep by recoverExpiredLeases.
   *
   *  `onAccepted` IS NOT OPTIONAL IN PRACTICE (review, Sep 16). A drained row is
   *  a message whose caller is gone, so nobody writes that caller's bookkeeping:
   *  no AppSetting marker, no Client.welcomeTextAt, no task completion. Without
   *  it a drained welcome leaves welcomeTextAt null and the client stays a
   *  candidate for ever (every tick enqueues, hits its own accepted row, notes a
   *  duplicate and resolves nothing), and a drained confirmation leaves its task
   *  open for ever. The cron passes a hook that does the absent caller's work —
   *  see clientTextSweeps.recordDrainedSend. A failure in it must never lose the
   *  send, so it is caught here: the outbox row is still the record. */
  async function drainPending(opts: {
    workerId: string;
    limit?: number;
    maxAgeMs?: number;
    canSend?: (row: OutboxRow) => boolean | Promise<boolean>;
    onAccepted?: (row: OutboxRow, providerId: string | null) => Promise<void>;
  }): Promise<{ sent: number; failed: number; unknown: number; held: number }> {
    const rows = await claim(opts.workerId, opts.limit ?? 5, { maxAgeMs: opts.maxAgeMs ?? STALE_PENDING_MS });
    let sent = 0, failed = 0, unknownCount = 0, held = 0;
    for (const row of rows) {
      if (opts.canSend && !(await opts.canSend(row))) {
        // Put the lease back; the row stays pending and either its window
        // reopens on a later tick or it ages out to its sweep.
        await store.patch(row.id, { state: "attempting", leaseBy: opts.workerId }, { state: "pending", leaseBy: null, leaseUntil: null });
        held++;
        continue;
      }
      const r = await deliver(row.id, opts.workerId);
      if (r.outcome === "accepted") {
        sent++;
        if (opts.onAccepted) {
          try {
            await opts.onAccepted(row, r.providerId);
          } catch (e) {
            console.error(`[outbox] drained ${row.dedupeKey ?? row.id} but its bookkeeping failed`, e);
          }
        }
      } else if (r.outcome === "failed") failed++;
      else if (r.outcome === "unknown") unknownCount++;
      else held++;
    }
    return { sent, failed, unknown: unknownCount, held };
  }

  /** A PERSON says an unconfirmed message never landed. This is the ONLY way an
   *  `unknown` is ever sent again, and it is deliberately a two-step: the held
   *  row is settled (its history kept, its identity released) and a fresh row
   *  carries the retry, so the ledger shows both the doubt and the decision. */
  async function retryHeld(id: string, by: string): Promise<{ ok: boolean; message: string; result?: OutboxSendResult }> {
    const row = await store.byId(id);
    if (!row) return { ok: false, message: "That send is no longer on file." };
    if (row.state !== "unknown") return { ok: false, message: `Nothing to retry — this send reads ${row.state}.` };
    const key = row.dedupeKey;
    if (!key) return { ok: false, message: "That send has already been settled by someone." };
    const settled = await store.patch(
      id,
      { state: "unknown" },
      { providerError: `${(row.providerError ?? "unconfirmed").slice(0, 380)} — ${by} checked and re-sent it`, dedupeKey: null },
    );
    if (settled === 0) return { ok: false, message: "Someone else just handled this one." };
    const result = await sendThroughOutbox({
      channel: row.channel === "email" ? "email" : "sms",
      toRef: row.toRef,
      body: row.body,
      dedupeKey: key,
      clientId: row.clientId,
      projectId: row.projectId,
      taskId: row.taskId,
      requestedBy: `retry:${by}`,
    });
    if (result.outcome === "accepted") return { ok: true, message: "Sent.", result };
    if (result.outcome === "unknown") return { ok: false, message: `Still unconfirmed — ${result.error}`, result };
    if (result.outcome === "failed") return { ok: false, message: `The provider refused it — ${result.error}`, result };
    return { ok: false, message: "Another send for this message is already in flight.", result };
  }

  return {
    enqueue, claim, claimById, deliver, sendThroughOutbox,
    markAccepted, markFailed, markUnknown, recoverExpiredLeases, drainPending, retryHeld,
    store,
  };
}

// The hub's outbox: the real table, the real providers.
const hubOutbox = createOutbox({ store: prismaOutboxStore(), provider: realOutboxProvider() });

// ---------------------------------------------------------------------------
// THE TEST-CLIENT FLOOR (§16, Sep 22 2026).
//
// Phase 0 found nothing standing between a synthetic client and a real
// outbound message. Every protection was a per-feature check — create-test-client
// writes autoConfirmationText/autoDeliveryText OFF and re-asserts them on every
// run, which is good and is not a floor: clientTextSweeps decides in its own
// query on those two columns, is not one of the ProgramAutomation switches, and
// a new send path only has to forget to look. A TEST client with a phone number
// is then one shoot confirmation away from a real text.
//
// So the check moves under every send path instead of beside each one. It is
// deliberately NARROW — this is not the pre-launch gate and must not become it:
//
//   · it applies ONLY when the message names a client whose name is synthetic;
//   · a real client's message is untouched, because the existing approved
//     client texts run today and stopping them would break the business;
//   · a synthetic client's message is allowed when it lands on one of the two
//     destinations Jordan verified on Sep 21, and refused otherwise.
//
// A refusal is loud: the row is never enqueued and the caller gets a thrown
// error naming what it tried to do. A silent drop would be a second way to
// believe a message went out.
// ---------------------------------------------------------------------------
export class TestClientSendRefusedError extends Error {
  constructor(clientName: string, toRef: string) {
    super(
      `Refusing to send to "${toRef}" for TEST client "${clientName}". A synthetic client may only be messaged at one of Jordan's verified test destinations. ` +
        `If this is a real client, the name carries the word TEST and should be corrected.`,
    );
    this.name = "TestClientSendRefusedError";
  }
}

async function refuseTestClientSend(msg: OutboxMessageInput): Promise<void> {
  if (!msg.clientId) return;
  let client: { name: string | null } | null = null;
  try {
    client = await prisma.client.findUnique({ where: { id: msg.clientId }, select: { name: true } });
  } catch {
    // A failed lookup must not block a real client's message. The per-feature
    // gates above this are still in place; this floor simply cannot assert.
    return;
  }
  if (!client) return;
  const { isTestClientName, isVerifiedTestDestinationEmail, isVerifiedTestDestinationPhone } = await import("@/lib/testClients");
  if (!isTestClientName(client.name)) return;
  const ok = msg.channel === "email" ? isVerifiedTestDestinationEmail(msg.toRef) : isVerifiedTestDestinationPhone(msg.toRef);
  if (!ok) throw new TestClientSendRefusedError(client.name ?? "(unnamed)", msg.toRef);
}

export const enqueue: Outbox["enqueue"] = async (msg) => {
  await refuseTestClientSend(msg);
  return hubOutbox.enqueue(msg);
};
export const claim: Outbox["claim"] = (workerId, n, opts) => hubOutbox.claim(workerId, n, opts);
export const claimById: Outbox["claimById"] = (id, workerId) => hubOutbox.claimById(id, workerId);
export const deliver: Outbox["deliver"] = (id, workerId) => hubOutbox.deliver(id, workerId);
export const markAccepted: Outbox["markAccepted"] = (id, providerId) => hubOutbox.markAccepted(id, providerId);
export const markFailed: Outbox["markFailed"] = (id, error) => hubOutbox.markFailed(id, error);
export const markUnknown: Outbox["markUnknown"] = (id, reason) => hubOutbox.markUnknown(id, reason);
export const recoverExpiredLeases: Outbox["recoverExpiredLeases"] = () => hubOutbox.recoverExpiredLeases();
export const drainPending: Outbox["drainPending"] = (opts) => hubOutbox.drainPending(opts);
export const sendThroughOutbox: Outbox["sendThroughOutbox"] = async (msg, opts) => {
  await refuseTestClientSend(msg);
  return hubOutbox.sendThroughOutbox(msg, opts);
};

// ---- identities -------------------------------------------------------------
// The dedupeKey IS the message's identity, and it is deliberately the same
// string whether a sweep or a human sends it: one delivery text per job, sent
// by whoever gets there first. The kind is the segment before the first colon.

export const deliveryKey = (projectId: string) => `delivery:${projectId}`;
/** Keyed on the shoot's ET day AND start time, exactly like the AppSetting
 *  marker it replaces: a shoot moved by an hour earns a fresh confirmation, a
 *  15-minute tweak does not re-text. */
export const confirmationKey = (projectId: string, shootDate: Date | null) => {
  if (!shootDate) return `confirmation:${projectId}:none`;
  const day = shootDate.toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
  const at = shootDate.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).replace(":", "");
  return `confirmation:${projectId}:${day}-${at}`;
};
export const welcomeKey = (clientId: string) => `welcome:${clientId}`;
export const afterHoursKey = (clientId: string, periodKey: string) => `afterhours:${clientId}:${periodKey}`;
export const staffKey = (teamMemberId: string, claimStamp: Date) => `staff:${teamMemberId}:${claimStamp.toISOString()}`;
/**
 * R4 — THE IDENTITY OF A MESSAGE SOMEBODY TYPED.
 *
 * Every other key in this file is derived from the thing being messaged about
 * (a delivery, a job, a reminder), because those sends are the system's. A
 * manual text has no such anchor: the same person may legitimately send the
 * same words to the same number twice in a row, and must be able to.
 *
 * So the identity comes from the COMPOSE, not the content: the browser mints an
 * id when the person presses Send and sends it with the request. A double
 * submit of one press carries the same id and collides; a second, deliberate
 * message is a new press and a new id. The server never invents one — a
 * request that arrives without it is refused rather than given a fresh id,
 * because inventing an id is exactly what turns a retry into a second text.
 */
export const manualKey = (intentId: string) => `manual:${intentId}`;
/** One sign-in link per person per MINT — the stamp is the moment the token
 *  was minted, so a second request a minute later is its own message (the
 *  first one's token is void by then) while a double-submit collides. */
export const portalLoginKey = (clientUserId: string, mintStamp: Date) => `portal_login:${clientUserId}:${mintStamp.toISOString()}`;
/** One invitation per seat per send. */
export const portalInviteKey = (membershipId: string, sendStamp: Date) => `portal_invite:${membershipId}:${sendStamp.toISOString()}`;
/** CONTENT PROGRAM (W2-F). One email per ProgramReminder ATTEMPT row: the
 *  reminder row is written first (its own dedupeKey `enrollment:month:action:
 *  attempt` is where duplicate evaluator runs collide), then this key names the
 *  message. A failed send releases it and the same reminder row retries under
 *  the same key; an unknown holds it for ever. The action and month ride along
 *  so the email rail can pick the subject (programReminderSubject). */
export const programReminderKey = (action: string, reminderId: string, monthKey: string | null) => `program_reminder:${action}:${reminderId}:${monthKey ?? "none"}`;
/** One "your scripts are ready" email per SCRIPTS_READY notice row — the notice
 *  batches every script released to that client inside the batch window. */
export const scriptShareKey = (reminderId: string) => `script_share:${reminderId}`;
export const strategyReadyKey = (reminderId: string) => `strategy_ready:${reminderId}`;

export function outboxKind(dedupeKey: string | null | undefined): OutboxKind | null {
  const head = (dedupeKey ?? "").split(":")[0];
  return ALL_KINDS.find((k) => k === head) ?? null;
}

/** Never render a recipient in full outside the owner's own screens (the
 *  schema says as much). A phone shows its last four; an email shows its
 *  domain. */
export function maskToRef(channel: string, toRef: string): string {
  if (channel === "email") {
    const [user, domain] = toRef.split("@");
    return domain ? `${(user ?? "").slice(0, 2)}…@${domain}` : "an email address";
  }
  return `•••${toRef.slice(-4)}`;
}

// ---- the health surface -----------------------------------------------------

export type UnknownSend = {
  id: string;
  kind: OutboxKind | null;
  channel: string;
  to: string;
  ageMs: number;
  queuedAt: Date;
  attempts: number;
  reason: string | null;
  requestedBy: string | null;
  projectId: string | null;
  clientId: string | null;
  taskId: string | null;
  preview: string;
};

/** Every send the hub could not confirm, oldest first. These are the rows a
 *  person has to settle: look the thread up in OpenPhone (or the Sent folder),
 *  then either leave it alone or press Retry. Nothing here ever retries itself.
 *
 *  Scoped to unknown rows that still HOLD their identity. A row whose dedupeKey
 *  has been released is one a person already settled with a Retry — it keeps
 *  its honest `unknown` state as history (we still don't know whether the first
 *  attempt landed) but it is no longer an outstanding question. */
const UNSETTLED_UNKNOWN = { state: "unknown", dedupeKey: { not: null } } as const;

export async function unknownSends(limit = 25): Promise<UnknownSend[]> {
  const rows = (await prisma.outboxMessage
    .findMany({ where: UNSETTLED_UNKNOWN, select: ROW_SELECT, orderBy: { createdAt: "asc" }, take: limit })
    .catch(() => [])) as OutboxRow[];
  const at = Date.now();
  return rows.map((r) => ({
    id: r.id,
    kind: outboxKind(r.dedupeKey),
    channel: r.channel,
    to: maskToRef(r.channel, r.toRef),
    ageMs: at - r.createdAt.getTime(),
    queuedAt: r.createdAt,
    attempts: r.attempts,
    reason: r.providerError,
    requestedBy: r.requestedBy,
    projectId: r.projectId,
    clientId: r.clientId,
    taskId: r.taskId,
    preview: r.body.slice(0, 120),
  }));
}

export async function unknownSendCount(): Promise<number> {
  return prisma.outboxMessage.count({ where: UNSETTLED_UNKNOWN }).catch(() => 0);
}

/** "It never landed — send it now", pressed by a person on Connections. Never
 *  called by a sweep, a cron or a retry loop: see retryHeld above. */
export const retryUnknownSend: Outbox["retryHeld"] = (id, by) => hubOutbox.retryHeld(id, by);

/** What the outbox knows about one message identity — the state a task should
 *  read instead of standing in for the send itself (RTP-08 item 3). Null means
 *  the outbox has never seen this message: either it predates the outbox, or
 *  it went out down a path that has not been routed through here yet. */
export async function outboxStateOf(dedupeKey: string): Promise<{ state: OutboxState; providerId: string | null; at: Date | null; error: string | null } | null> {
  const row = await hubOutbox.store.byDedupeKey(dedupeKey).catch(() => null);
  if (!row) return null;
  return {
    state: row.state as OutboxState,
    providerId: row.providerId,
    at: row.acceptedAt ?? row.resolvedAt ?? row.createdAt,
    error: row.providerError,
  };
}

/** Proof a message with this identity reached the provider. The only "yes" the
 *  outbox gives is an accepted row carrying the provider's own id — an unknown
 *  is explicitly not proof, which is the distinction the Done ledger has been
 *  missing. */
export async function outboxAccepted(dedupeKey: string): Promise<{ at: Date; providerId: string | null } | null> {
  const s = await outboxStateOf(dedupeKey);
  return s && s.state === "accepted" ? { at: s.at ?? new Date(), providerId: s.providerId } : null;
}

/** The same question for a whole screenful of messages, in one query — what the
 *  Send-all panel reads so a row the outbox is holding is never offered for a
 *  second send. Identities the outbox has never seen are simply absent. */
export async function outboxStatesFor(dedupeKeys: string[]): Promise<Map<string, OutboxState>> {
  const out = new Map<string, OutboxState>();
  const keys = dedupeKeys.filter(Boolean);
  if (keys.length === 0) return out;
  const rows = await prisma.outboxMessage
    .findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true, state: true } })
    .catch(() => [] as { dedupeKey: string | null; state: string }[]);
  for (const r of rows) if (r.dedupeKey) out.set(r.dedupeKey, r.state as OutboxState);
  return out;
}

// ---------------------------------------------------------------------------
// R4 — WHAT THE COMMS SURFACE NEEDS TO SHOW A SEND IT CANNOT CONFIRM.
//
// A manual text now leaves a durable row before it is handed to OpenPhone, so
// "we don't know whether this went" is a fact on disk rather than a sentence in
// a toast that a refresh erases. These two functions are how a thread reads it.
// ---------------------------------------------------------------------------

export type PendingManualSend = {
  id: string;
  /** pending · attempting · unknown — the three that mean "not settled". */
  state: string;
  body: string;
  /** Every recipient, 10-digit keys. One entry for an ordinary text. */
  toRefs: string[];
  mediaUrls: string[];
  queuedAt: Date;
  requestedBy: string | null;
  /** Set only on `unknown`: why the provider's answer was not usable. */
  reason: string | null;
};

/**
 * Manual sends on this conversation that are not settled — so the thread can
 * show the words with an honest "sending, not confirmed" mark instead of
 * dropping them and inviting a second press.
 *
 * Scoped by RECIPIENT, not by client: a thread can be a group, and a number
 * with no Client row still has a conversation.
 */
export async function pendingManualSends(toRefs: string[], opts: { withinMs?: number } = {}): Promise<PendingManualSend[]> {
  const keys = toRefs.map((t) => t.replace(/\D/g, "").slice(-10)).filter((k) => k.length === 10);
  if (!keys.length) return [];
  const since = new Date(Date.now() - (opts.withinMs ?? 24 * 3600_000));
  const rows = (await prisma.outboxMessage
    .findMany({
      where: { channel: "sms", state: { in: ["pending", "attempting", "unknown"] }, createdAt: { gte: since }, dedupeKey: { startsWith: "manual:" }, toRef: { in: keys } },
      select: ROW_SELECT,
      orderBy: { createdAt: "asc" },
      take: 20,
    })
    .catch(() => [])) as OutboxRow[];
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    body: r.body,
    toRefs: [r.toRef, ...parseJsonArray(r.extraToRefsJson)],
    mediaUrls: parseJsonArray(r.mediaUrlsJson),
    queuedAt: r.createdAt,
    requestedBy: r.requestedBy,
    reason: r.state === "unknown" ? r.providerError : null,
  }));
}

/**
 * LATER EVIDENCE SETTLES AN UNKNOWN — without sending anything again.
 *
 * This is the half R4 asks for that nothing in the codebase had: there was no
 * path from `unknown` back to settled except retryHeld, which settles by
 * TEXTING AGAIN. The OpenPhone webhook writes a CommLog for every outbound
 * message it hears about and never touched OutboxMessage, so an unknown row
 * would have sat in the thread as a permanent "not confirmed" ghost beside the
 * message that actually arrived — this codebase has shipped permanent phantom
 * rows before and they cost real trust.
 *
 * The echo IS the proof: OpenPhone is telling us it has this message. Matched
 * on recipient + body within a short window, which is the same identity the
 * comms log already dedupes on, and only ever in the accepting direction —
 * nothing here can mark a message failed or send one.
 */
export async function settleUnknownFromEcho(echo: { toRef: string; body: string; providerId: string | null; at?: Date }): Promise<boolean> {
  const key = echo.toRef.replace(/\D/g, "").slice(-10);
  const body = (echo.body ?? "").trim();
  if (key.length !== 10 || !body) return false;
  const at = echo.at ?? new Date();
  const row = await prisma.outboxMessage
    .findFirst({
      where: {
        channel: "sms",
        state: { in: ["unknown", "attempting", "pending"] },
        dedupeKey: { startsWith: "manual:" },
        toRef: key,
        body,
        createdAt: { gte: new Date(at.getTime() - 6 * 3600_000), lte: new Date(at.getTime() + 5 * 60_000) },
      },
      select: { id: true, state: true },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => null);
  if (!row) return false;
  // NOT markAccepted: that is the DELIVERY path's transition and it is
  // conditional on `attempting`, so it does nothing to an `unknown` row — which
  // is the state this function exists to clear. (My first cut called it and the
  // drill caught the no-op.) The transition here is its own, conditional on the
  // three unsettled states so two echoes cannot both claim it, and the identity
  // is deliberately KEPT: a settled row's dedupeKey is what stops a later drain
  // offering the same words again.
  const settledAt = new Date();
  const n = await prisma.outboxMessage
    .updateMany({
      where: { id: row.id, state: { in: ["unknown", "attempting", "pending"] } },
      data: { state: "accepted", providerId: echo.providerId ?? undefined, acceptedAt: settledAt, resolvedAt: settledAt, leaseUntil: null, leaseBy: null, providerError: null },
    })
    .catch(() => ({ count: 0 }));
  if (n.count > 0) console.info(`[outbox] a manual send we could not confirm was settled by OpenPhone's own echo (${row.state} -> accepted).`);
  return n.count > 0;
}

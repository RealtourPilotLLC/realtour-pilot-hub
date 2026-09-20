import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence, owedNow, owedPhrase, sameCategory, type ParsedEvidence } from "@/lib/statusEvidence";
import { logComm } from "@/lib/commLog";
import { MONTHLY_BATCH_INCOMPLETE, DELIVERED_LONG_AGO, SEND_UNVERIFIED } from "@/lib/tasks";
import { etAt, etDateTime } from "@/lib/datetime";
import {
  sendThroughOutbox,
  confirmationKey,
  deliveryKey,
  welcomeKey,
  afterHoursKey,
  type OutboxSendResult,
} from "@/lib/outbox";

// Auto-send client texts (Jordan, Sep 1 2026): confirmation texts go out on
// their own 2 days before the shoot, and delivery texts go out on their own
// once every ordered deliverable has shipped through Aryeo. Both were manual
// send-button tasks before; the tasks still exist (history + reconciler) but
// complete themselves the moment the sweep sends.
//
// Safety model (review-hardened; re-cut Sep 16 for RTP-08):
// - THE OUTBOX IS THE CLAIM. Every text below goes out through
//   lib/outbox.sendThroughOutbox: one durable row per message, claimed on a
//   unique dedupeKey, leased while it is in flight, and closed with the
//   provider's own message id. Two overlapping crons, a human on /tasks and
//   this sweep all race on that one key, and a process killed between the
//   claim and the send leaves a row a person can see instead of a text that
//   silently never happened.
// - THE TASK IS COMPLETED AFTER THE PROVIDER ANSWERS, not before. Until Sep 16
//   the SmartTask was flipped to COMPLETED first and rolled back in a catch
//   block — which a kill -9 never runs. The task is still the human's ledger;
//   it just no longer stands in for the send.
// - THE AppSetting MARKER MOVED WITH IT. `auto-confirm-*`, `auto-delivery-*`,
//   `auto-welcome-*` and `auto-afterhours-*` still exist, still mean "this went
//   out (or may have)", and are still what tasks.ts reads — but they are now
//   written AFTER acceptance rather than claimed before the send. They are read
//   first as the settled record of an earlier send (including every send that
//   predates the outbox); the outbox key is what two live workers contend on.
// - A client with an OPEN question (client_reply task) is never auto-texted —
//   the webhook would read our text as "we answered them".
// - One auto-text per client per tick (the shared `texted` set) — a
//   multi-listing client gets one text an hour, not four in a minute.
// - Nothing sends outside the client-text window; it waits for the next
//   WORKING morning (see QUIET HOURS below).
// - A client whose own switch is off (Client.autoConfirmationText /
//   autoDeliveryText) is skipped WITHOUT claiming the task, so the reminder
//   stays on /tasks for a human to send by hand. Off means "a person sends it",
//   never silence.
//
// QUIET HOURS (Jordan, Sep 2 2026, verbatim): "All client texts Mon-Fri…
// Never send texts after 4:30 PM to clients. Team texts can still go out on
// weekends." So every automated CLIENT text in this file is gated to Monday-
// Friday, 9:00am-4:30pm ET. Anything that comes due outside that queues to the
// next working morning — nothing is dropped, because the hourly cron simply
// re-evaluates it on the next in-window tick.
//
// TEAM texts are NOT governed by any of this: shoot reminders, upload nudges
// and payday go through lib/notify (TeamMember phones) and still fire evenings
// and weekends, which is exactly right — Saturday is a shoot day.
//
// The one client text that IGNORES the window is the after-hours auto-reply at
// the bottom: it answers a client who just texted US while we were shut, so it
// only ever fires outside office hours and by definition can't wait.
//
// PROOF OF SEND (Jordan, Sep 2 2026 — "every number on screen is true"): a
// completed client-text task must mean a text happened. Every accepted send
// below leaves THREE traces — the outbox row carrying OpenPhone's own message
// id, the AppSetting marker, and an outbound CommLog row — and the first of
// those is now the authority. tasks.ts deliveryTextSendProof still reads the
// other two when the 7-day sweeper decides whether a lingering task closes as
// done (COMPLETED) or as never-sent (CANCELLED); it should ask the outbox
// first, because only the outbox can tell an accepted send from an unconfirmed
// one (handover, Sep 16).
//
// AN UNCONFIRMED SEND NO LONGER PASSES AS A CLEAN ONE. A timeout or 5xx after
// OpenPhone may already have taken the message leaves the outbox row `unknown`:
// the identity is held for ever so nothing retries it blindly, the task is
// stamped SEND_UNVERIFIED with the doubt in plain words and LEFT OPEN (it used
// to be held COMPLETED, which read as a clean send on every screen including
// the Done ledger), and the row surfaces on Connections with its age and a
// Retry only a person can press.

const HOUR = 3_600_000;
// How close a shoot has to be before a confirmation stops waiting for a human.
// Under this, "the client is waiting on us" no longer holds the text: not being
// told the time at all is a worse outcome than a confirmation arriving while a
// separate thread is open.
const CONFIRM_FORCE_H = 24;
// Sources the OpenPhone webhook must recognise as "the hub sent this itself".
// An automated send answers nobody's question and closes nobody's task but its
// own — see the `autoSent` guard in api/webhooks/openphone/route.ts, which
// reads exactly these strings.
const AUTO_SOURCES = ["auto-confirmation", "auto-delivery", "auto-afterhours", "auto-welcome"];

// ---- ET clock ---------------------------------------------------------------
// One Intl formatter, reused: the window helpers below evaluate up to ~200
// candidate ticks when they walk across a weekend.
const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short", hour: "numeric", minute: "2-digit", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
type EtMoment = { dow: number; minutes: number; dayKey: string };
function etMoment(at: Date): EtMoment {
  const o: Record<string, string> = {};
  for (const part of ET_PARTS.formatToParts(at)) o[part.type] = part.value;
  // Node's ICU renders midnight as "24" with hour12:false — fold it back to 0
  // or every 12am-1am tick reads as an hour past the end of the day.
  const hour = Number(o.hour) % 24;
  return { dow: DOW[o.weekday] ?? 0, minutes: hour * 60 + Number(o.minute), dayKey: `${o.year}-${o.month}-${o.day}` };
}
const isWeekdayEt = (at: Date) => { const d = etMoment(at).dow; return d >= 1 && d <= 5; };

// ---- The client-text send window -------------------------------------------
// DEFAULTS live in lib/settings (autoTextRules), so Jordan can move the window
// or switch an automation off without a deploy. This type is just the shape the
// helpers need.
type SendWindow = { fromHour: number; untilHour: number; untilMinute: number; weekdaysOnly: boolean };
function windowOf(r: { sendFromHour: number; sendUntilHour: number; sendUntilMinute: number; weekdaysOnly: boolean }): SendWindow {
  return { fromHour: r.sendFromHour, untilHour: r.sendUntilHour, untilMinute: r.sendUntilMinute, weekdaysOnly: r.weekdaysOnly };
}
export function windowLabel(w: SendWindow): string {
  const t = (h: number, m = 0) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  return `${w.weekdaysOnly ? "Mon-Fri " : ""}${t(w.fromHour)}-${t(w.untilHour, w.untilMinute)} ET`;
}

/** Is `at` inside the window a client text may be sent in? Minute-precise,
 *  because Jordan's cutoff is 4:30, not 4:00 — the hourly cron's 4pm tick is
 *  the last one that sends and the 5pm tick is already too late. */
function inSendWindow(w: SendWindow, at: Date = new Date()): boolean {
  const m = etMoment(at);
  if (w.weekdaysOnly && (m.dow === 0 || m.dow === 6)) return false;
  return m.minutes >= w.fromHour * 60 && m.minutes < w.untilHour * 60 + w.untilMinute;
}

/** The next hourly cron tick that WILL be allowed to send — i.e. the next real
 *  chance this text has. On the Friday 4pm tick that is Monday 9am, which is
 *  what lets the confirmation sweep reach across the weekend instead of
 *  confirming a Saturday shoot after it has already happened. */
export function nextSendOpportunity(w: SendWindow, at: Date = new Date()): Date {
  // ET is a whole-hour offset from UTC, so a UTC :00 boundary IS an ET :00
  // boundary — the cron's own tick times.
  const t = new Date(at);
  t.setUTCMinutes(0, 0, 0);
  let next = new Date(t.getTime() + HOUR);
  for (let i = 0; i < 24 * 9; i++) {
    if (inSendWindow(w, next)) return next;
    next = new Date(next.getTime() + HOUR);
  }
  return next; // unreachable window (settings are clamped) — don't loop forever
}

/** The previous tick that was allowed to send. The missed-confirmation scan
 *  reaches back to it, so the Monday 9am run covers everything since Friday
 *  4pm — the whole closed weekend, not a fixed number of hours. */
function previousSendOpportunity(w: SendWindow, at: Date = new Date()): Date {
  const t = new Date(at);
  t.setUTCMinutes(0, 0, 0);
  let prev = new Date(t.getTime() - HOUR);
  for (let i = 0; i < 24 * 9; i++) {
    if (inSendWindow(w, prev)) return prev;
    prev = new Date(prev.getTime() - HOUR);
  }
  return prev;
}

/** The honest deadline for a client text minted at `from`: the moment the first
 *  window it may be sent in shuts. A text minted Friday at 7pm is not late on
 *  Saturday — it could not have been sent — it is late once Monday's window
 *  closes. tasks.ts deliveryTextDueAt() does the same job on the HOUR alone and
 *  therefore reads a weekend task as overdue for two days; it should call this
 *  instead (dynamic import — tasks.ts is imported at the top of this file). */
export function clientTextDueAt(
  from: Date,
  rules: { sendFromHour: number; sendUntilHour: number; sendUntilMinute: number; weekdaysOnly: boolean },
): Date {
  const w = windowOf(rules);
  const firstChance = inSendWindow(w, from) ? from : nextSendOpportunity(w, from);
  return etAt(etMoment(firstChance).dayKey, w.untilHour, w.untilMinute);
}

// The sweeps still resolve the sending number up front — not to send with, but
// as a gate: "OpenPhone not connected" is a reason worth reporting once per
// sweep rather than once per client. The send itself goes through the outbox.
async function openPhone() {
  const { phoneKey, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const from = await defaultOpenPhoneNumber();
  return { phoneKey, from };
}

// ---- the dedupe markers, after the fact (RTP-08, Sep 16) --------------------
// These AppSetting rows used to BE the claim: created before the send, deleted
// again on a provable rejection. The outbox holds the claim now, so a marker
// means only one thing — a message with this identity has been handed to a
// provider and either accepted or left unconfirmed. Their KEYS and their
// meaning are unchanged, which is what keeps tasks.ts and the missed-shoot scan
// reading exactly as they did.

/** Has this exact message already gone out (or been held)? Read BEFORE
 *  queueing, so a send that predates the outbox — every marker on file today —
 *  still silences the sweep. Not a claim: two live workers are separated by the
 *  outbox's unique key, not by this. */
async function alreadyMarked(key: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { key: true } }).catch(() => null);
  return !!row;
}

/** Write the marker once the provider has answered. Best-effort on purpose: a
 *  P2002 here says the marker is already on file, which is what we were about
 *  to write, and a marker that fails to write must never turn an accepted send
 *  into a cron failure — the outbox row is the record that matters. */
async function stampMarker(key: string): Promise<void> {
  await prisma.appSetting.create({ data: { key, value: new Date().toISOString() } }).catch(() => {});
}

/** THE BOOKKEEPING FOR A MESSAGE WHOSE CALLER IS GONE (review, Sep 16).
 *
 *  The recovery drain (api/cron/gmail → outbox.drainPending) sends rows a
 *  stopped worker queued but never handed over. The SEND is durable — that is
 *  the whole point of the outbox — but the caller's own records are not: the
 *  AppSetting marker, Client.welcomeTextAt, the task's completion and the comm
 *  log are all written by code that died with the worker. Left unwritten they
 *  do real damage: a drained welcome leaves welcomeTextAt null, so the client
 *  stays a candidate on every single tick for ever (each one enqueues, meets its
 *  own accepted row, notes a duplicate and resolves nothing), and a drained
 *  confirmation leaves its task open for ever.
 *
 *  Everything below is derived from the message's own identity, so it needs
 *  nothing the dead worker was holding. Best-effort throughout: the text has
 *  already gone out, and a marker that fails to write must never read as a
 *  failed send. Returns a line for the cron log, or null for a kind it does not
 *  own (staff digests are reconciled in lib/notify). */
export async function recordDrainedSend(
  row: {
    dedupeKey: string | null;
    channel: string;
    toRef: string;
    body: string;
    clientId: string | null;
    projectId: string | null;
    taskId: string | null;
  },
  providerId: string | null,
): Promise<string | null> {
  const [kind, head, ...rest] = (row.dedupeKey ?? "").split(":");
  const tail = rest.join(":");
  if (!head) return null;
  // The marker keys are the identity, spelled the way the sweeps spell them —
  // `confirmation:<project>:<day>-<hhmm>` is `auto-confirm-<project>-<day>-<hhmm>`.
  const marker =
    kind === "delivery" ? `auto-delivery-${head}`
    : kind === "confirmation" ? `auto-confirm-${head}-${tail}`
    : kind === "welcome" ? `auto-welcome-${head}`
    : kind === "afterhours" ? `${AFTER_HOURS_MARKER}${head}-${tail}`
    : null;
  if (!marker) return null;
  await stampMarker(marker);

  const projectId = row.projectId;
  const clientId = row.clientId ?? (kind === "welcome" || kind === "afterhours" ? head : null);
  const client = clientId
    ? await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, welcomeTextAt: true } }).catch(() => null)
    : null;
  const who = client?.name ?? "the client";

  if (kind === "welcome" && clientId && !client?.welcomeTextAt) {
    // The card on the dashboard reads this field as "Welcome text sent", and now
    // it has been.
    await prisma.client.update({ where: { id: clientId }, data: { welcomeTextAt: new Date() } }).catch(() => {});
  }
  if ((kind === "confirmation" || kind === "delivery") && projectId) {
    // Every open reminder of this kind on the job, not just the row the dead
    // worker happened to be holding: one text per job means one text, and a
    // second open row would simply be sent by hand tomorrow.
    const taskType = kind === "confirmation" ? "confirmation_text" : "delivery_text";
    await prisma.smartTask
      .updateMany({
        where: { projectId, taskType, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          summary: `${kind === "confirmation" ? "Confirmation" : "Feedback ask"} sent to ${who} on ${etDateTime(new Date())} ET (recovered and sent by the hub after an interrupted run).`,
        },
      })
      .catch(() => {});
    await prisma.activity
      .create({
        data: {
          projectId,
          type: "SYSTEM",
          body: `${kind === "confirmation" ? "Confirmation" : "Delivery"} text sent to ${who} by the hub's recovery pass (it was queued but never handed over before): ${row.body.slice(0, 160)}`,
        },
      })
      .catch(() => {});
  }
  await logComm({
    channel: row.channel === "email" ? "email" : "text",
    direction: "out",
    minRole: "ADMIN",
    clientId,
    clientName: client?.name ?? null,
    ...(projectId ? { projectId } : {}),
    ...(row.channel === "email" ? {} : { contactName: client?.name ?? "RealTour Pilot", fromPhone: row.toRef }),
    body: row.body,
    source:
      kind === "confirmation" ? "auto-confirmation"
      : kind === "delivery" ? "auto-delivery"
      : kind === "welcome" ? "auto-welcome"
      : "auto-afterhours",
    externalId: row.channel === "email" ? undefined : providerId ? `op-${providerId}` : marker,
  }).catch(() => {});
  return `recovered and sent the ${kind} text to ${who}`;
}

/** Is the client-text window open right now? Exported for the recovery cron:
 *  a message a stopped worker left queued must not be drained out at 4:39pm
 *  just because a retry happened to land there (Jordan: never after 4:30). */
export async function clientTextWindowOpen(at: Date = new Date()): Promise<boolean> {
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  if (!rules.enabled) return false;
  return inSendWindow(windowOf(rules), at);
}

/** sendThroughOutbox with the DATABASE failure caught. A Neon blip while
 *  queueing must not abort the whole sweep and leave the rest of the clients
 *  untried — and it must never be read as "already sent" (the untyped catches
 *  this file used to carry). If a row was written before the blip, the
 *  five-minute watchdog settles it; nothing here guesses. */
async function trySend(what: string, msg: Parameters<typeof sendThroughOutbox>[0], notes: string[]): Promise<OutboxSendResult> {
  try {
    return await sendThroughOutbox(msg);
  } catch (e) {
    notes.push(`${what}: the hub could not queue this text — ${e instanceof Error ? e.message : "database error"}. Nothing was sent; the next tick tries again.`);
    return { outcome: "busy", id: "" };
  }
}

/** One sentence for a send that did not go out, in the vocabulary /tasks and
 *  the cron notes already use. Empty for a plain lease race — another worker
 *  holding the row for a few hundred milliseconds is not news (and trySend has
 *  already said its piece when the cause was a database blip). */
function outcomeNote(what: string, r: OutboxSendResult): string {
  switch (r.outcome) {
    case "failed":
      return `${what}: send failed — ${r.error}`;
    case "unknown":
      return `${what}: send unconfirmed (held — verify in OpenPhone before sending by hand) — ${r.error}`;
    case "duplicate":
      if (r.state === "unknown") return `${what}: an earlier send could not be confirmed and is being held — nothing re-sent`;
      if (r.state === "failed") return `${what}: another worker released this one — the next tick picks it up`;
      return `${what}: already claimed by another send (${r.state})`;
    default:
      return "";
  }
}

// An ambiguous failure HOLDS the message's identity in the outbox — re-sending
// an SMS the client may already be reading is worse than a stuck message. Until
// Sep 16 it also held the TASK's claim, so the row read COMPLETED and the Done
// ledger counted it: a clean send on every screen. Now the task is simply never
// completed — it stays open, stamped SEND_UNVERIFIED, carrying the doubt in
// plain words, and the same doubt goes on the project timeline so a human can
// settle it in OpenPhone. Best-effort: the honesty note must never turn a send
// failure into a cron failure.
//
// SAY IT ONCE (review, Sep 16). The delivery sweep re-enters the held branch on
// EVERY tick while a send is unconfirmed — the task is open by design now, so it
// stays in the sweep's query — and an unconditional write here put a fresh
// SYSTEM row on the job's timeline and churned SmartTask.updatedAt eight times a
// business day for the seven days before the stale-closer retires the task. So
// this diffs before it writes, exactly like `hold` below: nothing to change
// means nothing is written and nothing is said again.
async function markSendUnverified(taskIds: string[], opts: { projectId: string; label: string; clientName: string }): Promise<void> {
  const doubt = `${opts.label} text to ${opts.clientName} could not be confirmed — OpenPhone may or may not have sent it. Nothing was re-sent (a duplicate text is worse); check the OpenPhone thread and text by hand if it never landed.`;
  const summary = doubt.slice(0, 500);
  if (taskIds.length > 0) {
    const rows = await prisma.smartTask
      .findMany({ where: { id: { in: taskIds } }, select: { id: true, sourceDetail: true, summary: true } })
      .catch(() => [] as { id: string; sourceDetail: string | null; summary: string | null }[]);
    const stale = rows.filter((t) => t.sourceDetail !== SEND_UNVERIFIED || t.summary !== summary).map((t) => t.id);
    // Every task already carries the doubt (or the rows are gone): this tick has
    // nothing new to say, on the task OR on the timeline.
    if (stale.length === 0) return;
    await prisma.smartTask
      .updateMany({ where: { id: { in: stale } }, data: { sourceDetail: SEND_UNVERIFIED, summary } })
      .catch(() => {});
  }
  await prisma.activity.create({ data: { projectId: opts.projectId, type: "SYSTEM", body: doubt } }).catch(() => {});
}

// The client has an unanswered question in the queue — an automated text now
// would read as our reply (the outbound webhook closes their reply task) while
// answering nothing. Leave the whole client to a human; later ticks retry.
//
// An OPEN client_reply row is not enough on its own. The Smart Brain mints
// client_reply tasks for its own to-dos ("Note builder relationship context and
// brief team for shoot" on Erica Walker, Sep 1), and those never close — so one
// internal note silently held every automated text for that client. Erica's
// $1,475 shoot went unconfirmed for six ticks with nothing on screen saying why.
//
// So the task only holds the client while they are ACTUALLY waiting: their last
// inbound message is newer than our last outbound one. Once we have answered,
// the note may stay open for Kyle without gagging the robot.
async function clientHasOpenQuestion(clientId: string): Promise<boolean> {
  const open = await prisma.smartTask.findFirst({
    where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (!open) return false;
  const [lastIn, lastOut] = await Promise.all([
    prisma.commLog.findFirst({ where: { clientId, direction: "in" }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
    prisma.commLog.findFirst({ where: { clientId, direction: "out" }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
  ]);
  if (!lastIn) return false; // nothing inbound at all — the row is an internal note
  return !lastOut || lastIn.occurredAt > lastOut.occurredAt;
}

/** Confirmation texts: any BOOKED/SCHEDULED shoot inside the next 48 hours
 *  whose client hasn't been confirmed yet. Marker carries the ET shoot DAY so
 *  a rescheduled shoot gets a fresh confirmation, but a same-day time tweak
 *  doesn't re-text. `texted` is shared with the delivery sweep — one auto-text
 *  per client per cron tick. */
export async function sweepConfirmationTexts(texted: Set<string> = new Set()): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  if (!rules.enabled || !rules.confirmation.enabled) {
    return { sent: 0, skipped: 0, notes: ["confirmation texts are switched OFF in Settings → Automated texts"] };
  }
  const w = windowOf(rules);
  const now = new Date();
  if (!inSendWindow(w, now)) {
    return { sent: 0, skipped: 0, notes: [`outside the ${windowLabel(w)} client-text window — queued for ${nextSendOpportunity(w, now).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" })} ET`] };
  }
  // THE LAST CHANCE RULE. A 48h lead time assumes the office is open 48 hours
  // from now, and Mon-Fri it isn't: on the Friday 4pm tick the next tick that
  // may send is Monday 9am, so a Saturday shoot (16 of the last 268) and a
  // Monday-morning shoot (17 of 48 Monday shoots start before noon) would both
  // be confirmed AFTER they happened. So the horizon is whichever is further
  // out: the normal lead time, or everything that starts before our next real
  // opportunity to send. Nothing is dropped and nothing arrives late; a shoot
  // simply gets confirmed early when the weekend sits in the way.
  const nextChance = nextSendOpportunity(w, now);
  const leadHorizon = new Date(now.getTime() + rules.confirmation.hoursBefore * HOUR);
  const horizon = nextChance.getTime() > leadHorizon.getTime() ? nextChance : leadHorizon;
  const projects = await prisma.project.findMany({
    where: {
      // The spec now emits a confirmation for any ACTIVE job whose shoot is still
      // ahead (a return visit on a job already SHOT — 1946 Rowan #2). The send
      // must match, or the row is minted but only Kyle's Outbox can send it.
      status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] },
      shootDate: { gt: now, lte: horizon },
      aryeoMissingAt: null, // order gone from Aryeo → never text the client about it
    },
    select: {
      id: true, title: true, city: true, shootDate: true,
      // autoConfirmationText = this client's own switch (/clients → Notifications).
      client: { select: { id: true, name: true, phone: true, autoConfirmationText: true } },
      photographer: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, waivedAt: true } }, // waived items are not read out to the client (Sep 16)
    },
  });

  // Surface misses: a shoot that started while we were shut, before any
  // compliant tick could confirm it. Noted exactly once (marker-claimed) so the
  // gap is visible instead of silently swallowed. The scan reaches back to the
  // PREVIOUS sending tick — Monday 9am therefore covers the whole closed
  // weekend, which a fixed hour count never could.
  const missed = await prisma.project.findMany({
    where: {
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      shootDate: { gt: previousSendOpportunity(w, now), lte: now },
      smartTasks: { none: { taskType: "confirmation_text", status: "COMPLETED" } },
    },
    select: { id: true, title: true },
  });
  for (const m of missed) {
    const sentMarker = await prisma.appSetting.findFirst({ where: { key: { startsWith: `auto-confirm-${m.id}-` } }, select: { key: true } });
    if (sentMarker) continue; // the sweep did confirm it on an earlier day-window
    try {
      await prisma.appSetting.create({ data: { key: `auto-confirm-missed-${m.id}`, value: now.toISOString() } });
    } catch { continue; } // already noted
    // Neutral wording: the CAUSE varies (quiet-hours booking, pre-automation
    // shoot on day one, a held ambiguous send) — the fact is simply "no
    // confirmation went out before this shoot."
    notes.push(`${m.title}: shoot passed without a confirmation text being sent`);
    await prisma.activity.create({
      data: { projectId: m.id, type: "SYSTEM", body: "No confirmation text was sent before this shoot." },
    }).catch(() => {});
  }

  if (projects.length === 0) return { sent: 0, skipped: 0, notes };
  const { phoneKey, from } = await openPhone();
  if (!from) return { sent: 0, skipped: projects.length, notes: ["OpenPhone not connected"] };
  const { confirmationMessage } = await import("@/lib/delivery");
  const { textTemplates } = await import("@/lib/settings");
  const tpl = await textTemplates();

  let sent = 0, skipped = 0;
  for (const p of projects) {
    const k = phoneKey(p.client.phone ?? "");
    if (k.length !== 10) { skipped++; notes.push(`${p.title}: no valid client phone`); continue; }
    // This client's own switch is off. Skip BEFORE any claim: the task must
    // stay OPEN on /tasks with its drafted message so a human still sends it.
    // Off means "a person sends this one", never "nobody does".
    if (!p.client.autoConfirmationText) {
      skipped++; notes.push(`${p.title}: ${p.client.name} has automatic confirmation texts off — left for a human`); continue;
    }
    if (rules.onePerClientPerRun && texted.has(p.client.id)) { skipped++; continue; } // next tick sends this one
    // Read the open confirmation task up front: the hold below writes its reason
    // onto it, and the claim further down reuses the same rows.
    const taskIdsForHold = (await prisma.smartTask.findMany({
      where: { projectId: p.id, taskType: "confirmation_text", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    })).map((t) => t.id);
    // The "client is waiting on us" hold, with a floor. Leaving a confirmation
    // to a human is right while there is still time; it is NOT right when the
    // shoot is hours away, because the failure mode is the client never being
    // told at all — 439 Lake George (a $1,475 shoot) sat unconfirmed through six
    // ticks with nothing on screen saying why. Inside CONFIRM_FORCE_H the text
    // goes regardless: it states a time, it does not pretend to answer anything.
    // Either way the reason is written onto the task so it is visible on /tasks
    // instead of living only in a cron note.
    if (rules.skipWhenClientWaiting && await clientHasOpenQuestion(p.client.id)) {
      const hoursOut = (p.shootDate!.getTime() - Date.now()) / HOUR;
      if (hoursOut > CONFIRM_FORCE_H) {
        if (taskIdsForHold.length > 0) {
          await prisma.smartTask.updateMany({
            where: { id: { in: taskIdsForHold } },
            data: { summary: `On hold: ${p.client.name} has a message we have not answered, so the hub is leaving this confirmation to a person. It sends automatically if the shoot comes within ${CONFIRM_FORCE_H} hours.` },
          }).catch(() => {});
        }
        skipped++; notes.push(`${p.title}: client has an open question — left for a human`); continue;
      }
      notes.push(`${p.title}: client has an open question, but the shoot is in ${Math.round(hoursOut)}h — confirming anyway`);
    }
    // Someone already sent it by hand (the old send button / a hand-typed text
    // the webhook recognized) → nothing owed.
    const already = await prisma.smartTask.findFirst({
      where: { projectId: p.id, taskType: "confirmation_text", status: "COMPLETED" },
      select: { id: true },
    });
    if (already) { skipped++; continue; }
    // The open confirmation task(s) for this job. They are no longer CLAIMED
    // before the send (RTP-08): a claim written before OpenPhone answers is a
    // COMPLETED row for a text that a killed process never sent. They are
    // completed below, once the provider has taken the message.
    const openTasks = await prisma.smartTask.findMany({
      where: { projectId: p.id, taskType: "confirmation_text", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    const taskIds = openTasks.map((t) => t.id);
    // The identity carries the shoot's ET day AND its start time. Keyed on the
    // day alone, a shoot that moved 1:30 PM → 12:45 PM hit an existing marker
    // and the sweep skipped — while the task it had already claimed stayed
    // COMPLETED, so Kyle's board said the new time was confirmed while the
    // client still had the old one (1946 Rowan St, Sep 3). Only a move of an
    // hour or more reopens the task at all (tasks.ts), so this cannot re-text
    // on a trivial tweak.
    const day = p.shootDate!.toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
    const at = p.shootDate!.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).replace(":", "");
    const marker = `auto-confirm-${p.id}-${day}-${at}`;
    // A marker on file means this exact shoot time was already texted (or held
    // after an unconfirmed send) — including by the pre-outbox code, whose
    // markers are all we have for the back catalogue.
    if (await alreadyMarked(marker)) { skipped++; continue; }
    const body = confirmationMessage({
      title: p.title, city: p.city, shootDate: p.shootDate,
      client: { name: p.client.name }, photographer: p.photographer, deliverables: p.deliverables,
    }, tpl.confirmation);
    // LAST LOOK BEFORE THE SEND (review, Sep 16). The atomic task claim that used
    // to sit on this line is gone — the outbox holds the claim now, and it holds
    // it against the /tasks panel and every other cron. What it does NOT yet
    // cover is the per-card Send button (app/actions.ts sendConfirmationText),
    // which still calls OpenPhone directly with no claim at all; HANDOVER says
    // to route it through the same identity. Until it does, a person pressing
    // Send in the seconds after the query above would be a SECOND text to the
    // client, so the task's status is re-read as late as possible. One indexed
    // query; it narrows the window to milliseconds.
    const handledSince = await prisma.smartTask.findFirst({
      where: { projectId: p.id, taskType: "confirmation_text", status: { in: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    if (handledSince) { skipped++; continue; }
    const res = await trySend(p.title, {
      channel: "sms",
      toRef: k,
      body,
      dedupeKey: confirmationKey(p.id, p.shootDate),
      clientId: p.client.id,
      projectId: p.id,
      taskId: taskIds[0] ?? null,
      requestedBy: "sweep:confirmation",
    }, notes);
    if (res.outcome === "accepted") {
      sent++;
      texted.add(p.client.id);
      await stampMarker(marker); // AFTER acceptance now — see the header
      if (taskIds.length > 0) {
        await prisma.smartTask
          .updateMany({ where: { id: { in: taskIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } })
          .catch(() => {});
      }
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: `Confirmation text auto-sent to ${p.client.name}: ${body.slice(0, 160)}` },
      }).catch(() => {});
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        clientId: p.client.id, clientName: p.client.name, projectId: p.id,
        contactName: p.client.name, fromPhone: k, body,
        source: "auto-confirmation",
        // The provider message id — the webhook echo dedupes into THIS row
        // instead of adding a second outbound that would clear the comms board.
        externalId: res.providerId ? `op-${res.providerId}` : marker,
      }).catch(() => {});
      continue;
    }
    skipped++;
    if (res.outcome === "unknown") {
      // It may be in the client's hands. Hold the identity (the outbox already
      // does), stamp the marker so nothing here or in tasks.ts treats the shoot
      // as unconfirmed-and-untried, and leave the TASK OPEN with the doubt on
      // it — a held claim that reads COMPLETED is the lie this ticket removes.
      texted.add(p.client.id);
      await stampMarker(marker);
      await markSendUnverified(taskIds, { projectId: p.id, label: "Confirmation", clientName: p.client.name });
    } else if (res.outcome === "duplicate" && res.state === "accepted") {
      // A confirmation for this exact shoot time HAS gone out under somebody
      // else's row — the recovery drain, the panel, another cron — and this
      // sweep's own bookkeeping never ran. The outbox is the authority, so the
      // marker and the task are made to read it rather than the sweep meeting
      // the same accepted row again on every tick (review, Sep 16).
      await stampMarker(marker);
      if (taskIds.length > 0) {
        await prisma.smartTask
          .updateMany({
            where: { id: { in: taskIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
            data: { status: "COMPLETED", completedAt: new Date(), summary: `Confirmation text already sent to ${p.client.name} for this shoot time — nothing was re-sent.` },
          })
          .catch(() => {});
      }
    } else if (res.outcome === "duplicate" && res.state === "unknown") {
      await stampMarker(marker);
      await markSendUnverified(taskIds, { projectId: p.id, label: "Confirmation", clientName: p.client.name });
    }
    const note = outcomeNote(p.title, res);
    if (note) notes.push(note);
  }
  return { sent, skipped, notes };
}

// ---------------------------------------------------------------------------
// THE WELCOME TEXT (Jordan, Sep 7 2026): "I want to send a welcome text to
// every new client who books an appointment… 'Hey, first name, welcome to
// Realtour Pilot. We're excited to work with you and get to know you… you can
// always call and text us here. You can also schedule a free strategy call here
// anytime: [Strategy call link].'"
//
// WHEN. Not when the contact appears in Aryeo — when they BOOK. A contact card
// created by a coordinator who never orders anything is not a client yet, and
// "welcome to RealTour Pilot" to someone who has not hired us reads as a cold
// sales text. So the trigger is: a client the hub itself first saw (firstSeenAt,
// i.e. one the Aryeo webhook minted) who now has a shoot on the books.
//
// ONCE, EVER. Client.welcomeTextAt is the visible proof and the pre-filter. The
// authoritative gate is the OUTBOX row on `welcome:<clientId>` (RTP-08, Sep 16):
// its unique dedupeKey is what two overlapping crons contend on, and it is taken
// before the provider is called. The unique `auto-welcome-<clientId>` AppSetting
// marker still exists and still means "a welcome for this client has been handed
// to a provider", but it is now written AFTER the provider answers rather than
// claimed before the send — it is read first as the settled record of an earlier
// welcome (including every one sent before the outbox existed), not as a claim.
// There is no SmartTask for this text (nothing for a human to send by hand), so
// between them the outbox row and that marker are the whole ledger.
//
// WHO IT NEVER GOES TO:
//  · a client folded under an agent (parentClientId) — an assistant is not a
//    new client, they are the same relationship reached from a second address;
//  · anyone from before this shipped — every one of the 364 rows already on
//    file has firstSeenAt NULL, so the back catalogue is excluded by
//    construction rather than by a cutoff date somebody has to maintain;
//  · a client who has turned BOTH of their automated texts off. There is no
//    switch named for this one, so the two we have are read honestly: someone
//    with both off has said "do not have the robot text me", and that covers
//    this too (the same rule the after-hours reply uses);
//  · anyone waiting on an answer from us, under the shared skipWhenClientWaiting
//    rule — greeting somebody whose question we have ignored is worse than
//    saying nothing.
//
// A client who books more than WELCOME_MAX_AGE_DAYS after we first saw them
// never gets one: "welcome" a month late is not a welcome, and by then Kyle has
// spoken to them anyway.
// ---------------------------------------------------------------------------
const WELCOME_MAX_AGE_DAYS = 30;

export async function sweepWelcomeTexts(texted: Set<string> = new Set()): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { autoTextRules, PUBLIC_WEBSITE } = await import("@/lib/settings");
  const rules = await autoTextRules();
  if (!rules.enabled || !rules.welcome.enabled) {
    return { sent: 0, skipped: 0, notes: ["welcome texts are switched OFF in Settings → Automated texts"] };
  }
  const w = windowOf(rules);
  const now = new Date();
  if (!inSendWindow(w, now)) {
    return {
      sent: 0, skipped: 0,
      notes: [`outside the ${windowLabel(w)} client-text window — queued for ${nextSendOpportunity(w, now).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" })} ET`],
    };
  }

  const clients = await prisma.client.findMany({
    where: {
      firstSeenAt: { gt: new Date(now.getTime() - WELCOME_MAX_AGE_DAYS * 24 * HOUR) },
      welcomeTextAt: null,
      parentClientId: null,
      // Their first appointment is on the books. `aryeoMissingAt` excludes a
      // job whose order has vanished from Aryeo — the same limbo guard the
      // other two sweeps use before saying anything to a client.
      projects: { some: { status: { notIn: ["CANCELLED"] }, shootDate: { not: null }, aryeoMissingAt: null } },
    },
    orderBy: { firstSeenAt: "asc" }, // oldest arrival first: their shoot is soonest
    take: 25,
    select: { id: true, name: true, phone: true, email: true, autoConfirmationText: true, autoDeliveryText: true },
  });
  if (clients.length === 0) return { sent: 0, skipped: 0, notes };

  const { phoneKey, from } = await openPhone();
  if (!from) return { sent: 0, skipped: clients.length, notes: ["OpenPhone not connected"] };
  const { applyTemplate } = await import("@/lib/delivery");

  let sent = 0, skipped = 0;
  for (const c of clients) {
    const k = phoneKey(c.phone ?? "");
    // No phone → the welcome goes by EMAIL instead (Jordan, Sep 7: "Email them
    // if no phone number"). Only a client with neither is truly stuck, and that
    // is said out loud — the dashboard card carries the same warning.
    const noPhone = k.length !== 10;
    const email = (c.email ?? "").trim();
    if (noPhone && !email) {
      skipped++; notes.push(`${c.name}: no phone number or email on file, so no welcome can send`); continue;
    }
    if (!c.autoConfirmationText && !c.autoDeliveryText) {
      skipped++; notes.push(`${c.name}: all automatic texts off — no welcome sent`); continue;
    }
    if (rules.onePerClientPerRun && texted.has(c.id)) { skipped++; continue; } // next tick sends this one
    if (rules.skipWhenClientWaiting && await clientHasOpenQuestion(c.id)) {
      skipped++; notes.push(`${c.name}: waiting on an answer from us — the welcome waits for a person`); continue;
    }
    // ONCE, EVER. The outbox row on `welcome:<clientId>` is what two workers
    // race on now; the marker is read first as the settled record (every
    // welcome sent before the outbox existed left one, and nothing else gates
    // this text) and written again once the provider has answered.
    const marker = `auto-welcome-${c.id}`;
    if (await alreadyMarked(marker)) { skipped++; continue; } // sent, or held after an unconfirmed send
    const body = applyTemplate(rules.welcome.message, {
      first: (c.name || "there").trim().split(/\s+/)[0] || "there",
      strategyCallLink: rules.welcome.strategyCallUrl,
      website: PUBLIC_WEBSITE,
      portal: rules.afterHours.portalUrl,
    });
    // Same wording, same one-shot identity, whichever rail it goes down: a
    // client with no phone is welcomed by email (Jordan, Sep 7) and the outbox
    // holds `welcome:<clientId>` either way, so the two can never both fire.
    const res = await trySend(`${c.name}: welcome`, {
      channel: noPhone ? "email" : "sms",
      toRef: noPhone ? email : k,
      body,
      dedupeKey: welcomeKey(c.id),
      clientId: c.id,
      requestedBy: "sweep:welcome",
    }, notes);
    if (res.outcome === "accepted") {
      sent++;
      texted.add(c.id);
      await stampMarker(marker);
      // Stamped only AFTER the provider took it: welcomeTextAt is shown on the
      // dashboard card as "Welcome text sent", so it has to mean that. A failed
      // stamp means the text went out but the card would say forever that it
      // hadn't — retry once, then say so where a person will see it.
      await prisma.client.update({ where: { id: c.id }, data: { welcomeTextAt: new Date() } }).catch(async () => {
        await prisma.client.update({ where: { id: c.id }, data: { welcomeTextAt: new Date() } }).catch((e) =>
          console.error(`[welcome] sent to ${c.name} but could not stamp welcomeTextAt`, e));
      });
      await logComm({
        channel: noPhone ? "email" : "text", direction: "out", minRole: "ADMIN",
        clientId: c.id, clientName: c.name,
        ...(noPhone ? {} : { contactName: c.name, fromPhone: k }),
        body,
        source: "auto-welcome",
        // Texts dedupe against the OpenPhone webhook echo on the provider's own
        // id. The EMAIL rail carries none: Gmail's id would have to match the
        // `gmail-<account>:<id>` key the inbox sync mints, and a near-miss makes
        // a duplicate rather than preventing one. Gmail's id is on the outbox
        // row, which is where the proof belongs.
        externalId: noPhone ? undefined : res.providerId ? `op-${res.providerId}` : marker,
      }).catch(() => {});
      if (noPhone) notes.push(`${c.name}: no phone on file — welcomed by email (${email})`);
      continue;
    }
    skipped++;
    if (res.outcome === "unknown") {
      // HOLD it — a second "welcome to RealTour Pilot" is worse than none — but
      // leave welcomeTextAt null, because nothing proved it landed and that
      // field is read on screen as proof. The marker stops any later tick from
      // trying, and the row waits on Connections for a person.
      texted.add(c.id);
      await stampMarker(marker);
    } else if (res.outcome === "duplicate" && res.state === "accepted") {
      // A welcome for this client HAS gone out under somebody else's row (the
      // recovery drain, or an overlapping cron) and this sweep's bookkeeping
      // never ran. Without writing it, `welcomeTextAt` stays null, this client
      // stays a candidate, and every tick from here to eternity re-enqueues and
      // re-notes the same duplicate (review, Sep 16).
      await stampMarker(marker);
      await prisma.client.update({ where: { id: c.id }, data: { welcomeTextAt: new Date() } }).catch(() => {});
    } else if (res.outcome === "duplicate" && res.state === "unknown") {
      // Held, not proven: the marker keeps later ticks off it, welcomeTextAt
      // stays null because nothing proved the welcome landed.
      await stampMarker(marker);
    }
    const note = outcomeNote(`${c.name}: welcome`, res);
    if (note) notes.push(note);
  }
  return { sent, skipped, notes };
}

// Is anything this job OWES still outstanding, beyond what the hourly status
// evidence already knows? Returns the reason to wait, or null when the whole
// job really is in the client's hands.
//
// Two blind spots in the evidence blob, both about video:
//  · a FILE COUNT is not an APPROVAL. The Review Room is where a cut becomes
//    the client's (approval copies it into the job's Final folder), so a cut
//    whose latest round is still PENDING / UPLOADING / CHANGES_REQUESTED means
//    the video is not delivered, whatever a folder says. Rounds are separate
//    rows: only the newest round of each cut (deliverable × slot) is live —
//    an old CHANGES_REQUESTED round superseded by an approved v2 is history.
//  · the evidence is a SNAPSHOT. A video line item added to the order after the
//    last status pass isn't in `expected` yet, so `missing` can't see it. The
//    deliverable rows here are read fresh, so an ordered video always demands
//    positive proof that a video shipped.
// Rounds that are not work in progress: an upload that never finished is not a
// cut (reviewCuts retires it after 24h), and a SUPERSEDED round has already
// been replaced. Neither may hold a client's feedback ask hostage forever.
const DEAD_CUT_STATUSES = new Set(["UPLOAD_FAILED", "SUPERSEDED"]);

function wholeJobOutstanding(
  p: {
    deliverables: { type: string; label: string | null }[];
    reviewSubmissions: { deliverableId: string | null; assetPath: string | null; slot: number; round: number; status: string; completedAt: Date | null }[];
  },
  ev: ParsedEvidence,
): string | null {
  const latest = new Map<string, { round: number; status: string; completedAt: Date | null }>();
  for (const r of p.reviewSubmissions) {
    if (DEAD_CUT_STATUSES.has(r.status)) continue;
    // Same identity reviewCuts uses (cutKeyOf): the deliverable+slot for an
    // uploaded cut, the file path for a legacy folder-discovered one. Keying
    // legacy rows on "-" alone would collide two different files into one cut.
    const key = `${r.deliverableId ?? r.assetPath ?? "-"}:${r.slot}`;
    const held = latest.get(key);
    if (!held || r.round > held.round) latest.set(key, { round: r.round, status: r.status, completedAt: r.completedAt });
  }
  const openCut = [...latest.values()].find((c) => c.status !== "APPROVED");
  if (openCut) return `a video cut is still in the Review Room (round ${openCut.round}, ${openCut.status.toLowerCase().replace(/_/g, " ")})`;

  const videoOrdered = p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (videoOrdered) {
    // "Completed and DELIVERED" (Jordan's words), and delivered means the
    // client can open it. This used to accept `dropbox.finalVideo > 0` and an
    // approved+copied cut as proof a video had shipped — both of which are
    // facts about OUR Dropbox folder, and both of which are true the instant
    // an editor finishes a cut nobody has published. Clients are not on the
    // portal, so the Aryeo listing is their only access: a job with four cuts
    // in 05-Final-Video and zero on the listing passed this and texted the
    // agent that everything had been delivered. That is 626 Greycliffe Ln on
    // Sep 4 and Gary asking for the social media video the same afternoon.
    // Positive listing evidence only now, either Aryeo's own count or a named
    // DeliverableOutput delivery stamp.
    const unit = ev.units.find((u) => sameCategory(u.category, "Video"));
    const proved = (ev.aryeo?.videos ?? 0) > 0 || (unit?.withClient ?? 0) > 0;
    if (!proved) return "video was ordered and nothing on the client's listing proves a video has shipped yet";
  }
  return null;
}

/** THE FEEDBACK ASK (Jordan, Sep 2 2026, verbatim): "I want to make sure the
 *  delivery text doesn't go out until it's fully delivered. So if it's waiting
 *  on video, wait for that video to be completed and delivered. Then send the
 *  text. Also I want it to be less of a delivery text and more of a text just
 *  asking for feedback."
 *
 *  So the send waits for the WHOLE job, proved three ways — any one of them
 *  unsatisfied and the task simply stays open for the next tick (or for Kyle):
 *    1. the status evidence says NOTHING is still owed, and there IS evidence
 *       (a hand-drag to Delivered with no evidence proves nothing). Sep 20
 *       (F03): "nothing owed" is owedNow(), the same definition the delivery
 *       gate and the status card read — never made, and finished but never
 *       sent. The old test read `missing` alone, which a finished video
 *       empties, and it carried no count, so one reel of four held the same
 *       as four of four. That count lives on gate 1 now: a category the
 *       client has only part of is in one of those two lists by construction,
 *       so it never reaches the checks below;
 *    2. every video CUT in the Review Room has been approved — an editor's
 *       version 2 sitting in review means the client hasn't got the video, no
 *       matter what a file count says;
 *    3. a job that ordered video has positive proof a video reached the
 *       CLIENT — Aryeo's listing count or a named DeliverableOutput delivery
 *       stamp. Our own Dropbox Final folder is not proof and no longer counts
 *       (F03, Sep 20). Live data, Sep 2: 8 of 156 delivered jobs with video
 *       ordered had no such proof.
 *    4. and, where MORE THAN ONE of a thing was ordered, the hub can NAME what
 *       shipped. Aryeo's listing count is real and anonymous: where it carries
 *       the total and the per-video rows hold no delivery stamps, the blob says
 *       `unmatched` and the card says "open the listing before telling a client
 *       it is all there". A sweep cannot open a listing, so it holds and a
 *       person finishes the job (Sep 20 journey drill, 38 E Gay St). One cut
 *       ordered and one video on the listing is NOT that case and still sends
 *       itself: nothing there can be mistaken for anything else (review,
 *       Sep 20). The human paths are untouched — this is the one sender that
 *       cannot go and look.
 *  Post-delivery revisions and the two human-decision flags stay manual.
 *
 *  EVERY reason this sweep does not send is written onto the task (Sep 8
 *  audit). It used to go to the cron log only — which is clipped to 297 chars
 *  and rendered on no screen — so "Send delivery text — 1033 Preserve Ln" and
 *  "208 N Adams St" (both minted Sep 3, both waiting on a cut still pending in
 *  review) sat on the Outbox as plain "overdue" with a Send button and no word
 *  that the hub was holding them on purpose. The confirmation sweep already
 *  writes "On hold: …" onto its task; this one now does the same, for every
 *  gate.
 *
 *  There is no longer a 72-hour cut-off on the task's age. Jordan's rule is
 *  "if it's waiting on video, wait for that video to be completed and
 *  delivered. Then send the text" — and a cut approved on day four is exactly
 *  the case the cut-off defeated: the task silently fell out of this query, and
 *  the 7-day sweeper then cancelled it "closed unsent" (8 such closes in 60
 *  days). The bound is now that honest 7-day close (tasks.ts
 *  closeStaleDeliveryTexts). Be clear about what that means: a task that AGED
 *  in the queue (held for a cut, or for a client's open question) can still
 *  send on day six — the mint-time DELIVERED_LONG_AGO guard only stops rows
 *  from being created for old jobs, it does not bound one already minted.
 *
 *  A BETTER MOMENT EXISTS, AND IS NOT WIRED IN YET (Sep 16 2026). Aryeo fires
 *  LISTING_CONTENT_DOWNLOADED when the agent actually downloads the files, and
 *  lib/aryeoDelivery now records it on Project.contentDownloadedAt — the first
 *  hard evidence the hub has ever had that a client PICKED THE WORK UP, rather
 *  than that we sent it. Asking "how did we do?" after that is plainly better
 *  than asking before it. It is deliberately not wired into this sweep: Aryeo
 *  publishes no read that can confirm a download, the receiver is accepting
 *  unsigned posts while the lane is in WATCHING mode, and an unconfirmable body
 *  must not get to decide when a real client gets a real text. The staged plan
 *  (hold for N hours OR the download, whichever comes first — so a job that
 *  never fires the event keeps exactly today's timing) is written out in full
 *  in lib/aryeoDelivery, above onContentDownloaded. Do it only once that lane
 *  is signed and armed. */
export async function sweepDeliveryTexts(texted: Set<string> = new Set()): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  if (!rules.enabled || !rules.delivery.enabled) {
    return { sent: 0, skipped: 0, notes: ["delivery texts are switched OFF in Settings → Automated texts"] };
  }
  const w = windowOf(rules);
  if (!inSendWindow(w)) {
    return { sent: 0, skipped: 0, notes: [`outside the ${windowLabel(w)} client-text window — queued for ${nextSendOpportunity(w).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" })} ET`] };
  }
  const tasks = await prisma.smartTask.findMany({
    where: {
      taskType: "delivery_text",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      projectId: { not: null },
      // Order gone from Aryeo → the job is in limbo; never text the client.
      project: { is: { aryeoMissingAt: null } },
    },
    select: { id: true, projectId: true, sourceDetail: true, summary: true },
    // Oldest first: a deferred (one-per-client-per-tick) task keeps its place
    // in line instead of newer ones sending ahead of it every tick.
    orderBy: { createdAt: "asc" },
  });
  if (tasks.length === 0) return { sent: 0, skipped: 0, notes };
  const { phoneKey, from } = await openPhone();
  if (!from) return { sent: 0, skipped: tasks.length, notes: ["OpenPhone not connected"] };
  const { deliveryMessage } = await import("@/lib/delivery");
  const { textTemplates, DEFAULT_DELIVERY_FEEDBACK_TEXT } = await import("@/lib/settings");
  const tpl = await textTemplates();

  // The hold reason, onto the task. Diff-before-write so an unchanged hold does
  // not churn updatedAt every hour (the CANCELLED path reads updatedAt as "when
  // it closed"). Rows carrying a mint-time decision already say why and are the
  // human's call — their own wording stands.
  const hold = async (t: { id: string; summary: string | null; sourceDetail: string | null }, why: string): Promise<void> => {
    if (t.sourceDetail === MONTHLY_BATCH_INCOMPLETE || t.sourceDetail === DELIVERED_LONG_AGO) return;
    // A task carrying an unconfirmed send keeps the doubt on it (review, Sep 16):
    // "On hold: the job no longer reads Delivered" over the top of "OpenPhone may
    // or may not have sent it" loses the only line that tells a person to go and
    // look at the thread.
    if (t.sourceDetail === SEND_UNVERIFIED) return;
    const summary = why.slice(0, 500);
    if (t.summary === summary) return;
    await prisma.smartTask
      .updateMany({ where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { summary } })
      .catch(() => {});
  };

  let sent = 0, skipped = 0;
  for (const t of tasks) {
    const project = await prisma.project.findUnique({
      where: { id: t.projectId! },
      select: {
        id: true, title: true, status: true, statusEvidence: true, packageName: true,
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
        // autoDeliveryText = this client's own switch (/clients → Notifications).
        client: { select: { id: true, name: true, phone: true, autoDeliveryText: true } },
        // Every cut ever submitted for this job. Rounds are separate rows, so a
        // superseded "changes requested" round is NOT evidence of open work —
        // only the LATEST round of each cut counts (see wholeJobOutstanding).
        reviewSubmissions: { select: { deliverableId: true, assetPath: true, slot: true, round: true, status: true, completedAt: true } },
      },
    });
    if (!project) { skipped++; continue; }
    // The job must still READ delivered — a revision request (or a manual
    // status move) means "how did we do?" is the wrong text to send.
    if (project.status !== "DELIVERED") {
      skipped++;
      await hold(t, `On hold: the job no longer reads Delivered in the hub (it is ${project.status.toLowerCase().replace(/_/g, " ")}) — "how did we do?" waits until it does.`);
      continue;
    }
    // Positive evidence only: no evidence at all (manual drag to DELIVERED,
    // stale blob) or an unverifiable order (nothing expected, no Aryeo
    // fulfilled signal) is NOT the same as "everything shipped" — stays manual.
    const ev = parseEvidence(project.statusEvidence);
    // STILL OWED, NOT JUST NEVER MADE (F03, Sep 20). This gate read
    // `ev.missing`, which the engine empties the moment a video is cut into
    // our Dropbox Final folder — so the one blob field standing between a
    // half-delivered job and a "how did we do?" text was the field that goes
    // blank when the editor finishes, not when the client receives. owedNow()
    // is the same definition the Editing Room's Completed gate and the status
    // card use, so the three can never disagree about what is out.
    const owed = owedNow(ev);
    if (!ev || owed.categories.length > 0 || (ev.expected.length === 0 && !ev.fulfilledOnAryeo)) {
      skipped++;
      await hold(
        t,
        ev && owed.categories.length > 0
          ? `On hold: nothing yet proves every deliverable shipped — still owed: ${owedPhrase(owed)}. The feedback ask waits until the whole job is out.`
          : "On hold: the hub has no delivery evidence for this order (a manual move to Delivered proves nothing), so it will not send the feedback ask on its own — send it by hand once you know everything is out.",
      );
      continue;
    }
    // "Fully delivered" means the WHOLE job, video included (Jordan's rule).
    const outstanding = wholeJobOutstanding(project, ev);
    if (outstanding) {
      skipped++;
      await hold(t, `On hold: ${outstanding} — the feedback ask waits until the whole job is delivered, then goes out on its own.`);
      notes.push(`${project.title}: ${outstanding} — the feedback ask waits`);
      continue;
    }
    // CONFIRMED BY COUNT IS NOT CONFIRMED BY NAME, AND A SWEEP CANNOT GO AND
    // LOOK (journey drill, Sep 20). Where the Aryeo listing count carries the
    // total and few or none of the per-video rows hold a delivery stamp, the
    // engine records `unmatched` and the status card says so in as many words:
    // "Confirmed by count, not by name … repeat versions of one cut look the
    // same from here, so open the listing before telling a client it is all
    // there." owedNow() returns that number and, until now, only the CARD
    // spent it: this gate read `owed.categories` off the same object, saw an
    // empty list and texted the client the wrap-up ask — the exact thing the
    // card had just said not to do. Driven end to end on 38 E Gay St: four
    // videos owed, four approved, four on the listing, ONE named delivery.
    //
    // It holds the AUTOMATED send only. The Editing Room pill and the Send
    // button are people who can open the listing in ten seconds, and the card
    // already tells them to. And it is deliberately NOT folded into
    // owed.categories: an anonymous count legitimately covers a great many
    // jobs (922 per-video rows on Sep 18 and six delivery stamps), so treating
    // it as an obligation would invent one on every job that is genuinely out.
    //
    // ONE ORDERED AND ONE ON THE LISTING CANNOT BE CONFUSED WITH ANYTHING
    // (review, Sep 20). The first cut of this gate fired on `unmatchedUnits`
    // alone, and `unmatched` is min(owed, listed) − named where `named` counts
    // the per-video delivery stamps the hub writes on NINE of 924 rows. So a
    // one-video job with one video on the listing scored unmatched = 1 and was
    // held, on a job where the hazard cannot arise: with a single cut ordered
    // there is no second video for an export of the first to be mistaken for.
    // Measured on the live book that day: 617 Westbourne Rd and 207 S 5 Points
    // Rd both read owed=1 / listed=1 / named=0, and both had their feedback ask
    // sent automatically and correctly (Sep 14 and Sep 16). Under the first cut
    // both would have been held and then closed unsent at seven days, forever,
    // because nothing but a stamp we almost never write lowers `unmatched`.
    // The hold now needs a second unit in play, which is the whole of the R02
    // hazard and nothing else: 38 E Gay St (4 ordered against a listing of 5)
    // and 1337 Carolannes Way (2 and 2) still wait for a person.
    const unnamed = ev.units.find((x) => (x.unmatched ?? 0) > 0 && x.owed > 1);
    if (unnamed) {
      skipped++;
      const word = unnamed.category.toLowerCase();
      const listed = unnamed.onListing ?? 0;
      const named = unnamed.named ?? 0;
      await hold(
        t,
        `On hold: ${unnamed.owed} ${word}${unnamed.owed === 1 ? "" : "s"} were ordered, the listing carries ${listed}, and ` +
          `${named === 0 ? "none of them is" : `only ${named} of them is`} tied to a ${word} the hub tracks. ` +
          `Repeat versions of one cut look the same from here, so open the listing and confirm it is all there, ` +
          `then send the feedback ask by hand.`,
      );
      notes.push(`${project.title}: ${unnamed.owed} ${word}${unnamed.owed === 1 ? "" : "s"} ordered, ${listed} on the listing, ${named} tied to anything — left for a human`);
      continue;
    }
    // A delivery text minted only because a monthly batch ran out of time is a
    // HUMAN decision (see MONTHLY_BATCH_INCOMPLETE) — never auto-send it. The
    // batch rule itself now lives on the task's CREATION, so any task that
    // exists here is already owed.
    if (t.sourceDetail === MONTHLY_BATCH_INCOMPLETE) {
      skipped++;
      notes.push(`${project.title}: monthly batch incomplete past turnaround — left for a human`);
      continue;
    }
    if (t.sourceDetail === DELIVERED_LONG_AGO) {
      skipped++;
      notes.push(`${project.title}: delivered days before the hub caught up — left for a human`);
      continue;
    }
    const k = phoneKey(project.client.phone ?? "");
    if (k.length !== 10) {
      skipped++;
      await hold(t, `The hub cannot send this: ${project.client.name} has no valid mobile number on file — send it by hand.`);
      notes.push(`${project.title}: no valid client phone`);
      continue;
    }
    // This client's own switch is off — skip before any claim so the task stays
    // OPEN for a human to send by hand (see the Client schema comment).
    if (!project.client.autoDeliveryText) {
      skipped++;
      await hold(t, `On hold: ${project.client.name} has automatic delivery texts switched off (Clients → Notifications) — a person sends this one.`);
      notes.push(`${project.title}: ${project.client.name} has automatic delivery texts off — left for a human`);
      continue;
    }
    // One auto-text per client per tick: a second job for the same client
    // simply goes next tick, so nothing is written — the wait is minutes.
    if (rules.onePerClientPerRun && texted.has(project.client.id)) { skipped++; continue; }
    if (rules.skipWhenClientWaiting && await clientHasOpenQuestion(project.client.id)) {
      skipped++;
      await hold(t, `On hold: ${project.client.name} has a message we have not answered, so the hub is leaving this feedback ask to a person. It goes out on its own once we have replied.`);
      notes.push(`${project.title}: client has an open question — left for a human`);
      continue;
    }
    // ONE feedback ask per job, whoever sends it. The identity is the job, so
    // the manual /texts send, the batch panel and this sweep all contend on the
    // same outbox row — and the task is completed only once OpenPhone has taken
    // the message. It used to be claimed COMPLETED here, four lines before the
    // send, and a non-conflict database error on the marker below left it
    // COMPLETED, unsent and un-stamped (audit RTP-08(3)).
    const marker = `auto-delivery-${project.id}`;
    if (await alreadyMarked(marker)) {
      // A text with this identity has already gone out — or is being held after
      // one nobody could confirm. WHICH it is, only the outbox can say, and
      // that is exactly the difference between a task that is genuinely done
      // and one standing in for a send nothing proves (RTP-08 item 3).
      skipped++;
      const { outboxStateOf } = await import("@/lib/outbox");
      const ob = await outboxStateOf(deliveryKey(project.id));
      if (ob?.state === "unknown") {
        await markSendUnverified([t.id], { projectId: project.id, label: "Delivery", clientName: project.client.name });
        notes.push(`${project.title}: an earlier feedback ask could not be confirmed — held for a person`);
        continue;
      }
      // Sent (or sent before the outbox existed, which is every marker on file
      // today): the reminder is moot, so close it saying so.
      await prisma.smartTask
        .updateMany({
          where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            summary: `Feedback ask already sent to ${project.client.name} for this job — nothing was re-sent.`,
          },
        })
        .catch(() => {});
      continue;
    }
    // The wording: whatever Jordan typed into Settings → Text templates →
    // "Delivery text" wins; a blank box falls back to the built-in feedback ask
    // (lib/settings DEFAULT_DELIVERY_FEEDBACK_TEXT) rather than to the older
    // "everything has been delivered" announcement. The partial variant is
    // never reached from here — the gate above guarantees nothing is missing.
    const body = deliveryMessage(project, { ...tpl, deliveryAll: tpl.deliveryAll.trim() || DEFAULT_DELIVERY_FEEDBACK_TEXT });
    // LAST LOOK BEFORE THE SEND (review, Sep 16) — same reason as the
    // confirmation sweep: the per-card Send button (app/actions.ts
    // sendDeliveryText) still texts OpenPhone directly and then completes this
    // task, so until that is routed through the outbox (HANDOVER) the only thing
    // standing between a hand-send and this sweep is how fresh the status is.
    const status = (await prisma.smartTask.findUnique({ where: { id: t.id }, select: { status: true } }))?.status;
    if (status === "COMPLETED" || status === "CANCELLED") { skipped++; continue; }
    const res = await trySend(project.title, {
      channel: "sms",
      toRef: k,
      body,
      dedupeKey: deliveryKey(project.id),
      clientId: project.client.id,
      projectId: project.id,
      taskId: t.id,
      requestedBy: "sweep:delivery",
    }, notes);
    if (res.outcome === "accepted") {
      sent++;
      texted.add(project.client.id);
      await stampMarker(marker); // AFTER acceptance now — see the header
      await prisma.smartTask
        .updateMany({
          where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            // Say what happened in place of the last hold: an "On hold: …" line
            // on a COMPLETED row would be exactly the untrue screen this file
            // exists to prevent.
            summary: `Feedback ask sent automatically to ${project.client.name} on ${etDateTime(new Date())} ET.`,
          },
        })
        .catch(() => {});
      await prisma.activity.create({
        data: { projectId: project.id, type: "SYSTEM", body: `Delivery text auto-sent to ${project.client.name}: ${body.slice(0, 160)}` },
      }).catch(() => {});
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        clientId: project.client.id, clientName: project.client.name, projectId: project.id,
        contactName: project.client.name, fromPhone: k, body,
        source: "auto-delivery",
        externalId: res.providerId ? `op-${res.providerId}` : marker,
      }).catch(() => {});
      continue;
    }
    skipped++;
    if (res.outcome === "unknown") {
      // Held, unproven, and NOT counted as done: the task stays open with the
      // doubt on it (see markSendUnverified) instead of reading COMPLETED.
      texted.add(project.client.id);
      await stampMarker(marker);
      await markSendUnverified([t.id], { projectId: project.id, label: "Delivery", clientName: project.client.name });
    } else if (res.outcome === "failed") {
      // Nothing was sent and the identity is free again — the next tick tries.
      await hold(t, `The hub tried to send this and OpenPhone refused it (${res.error}). Nothing went out; it will try again on the next pass.`);
    } else if (res.outcome === "duplicate" && res.state === "accepted") {
      // The outbox says a feedback ask for this job HAS gone out and the task
      // simply never heard (a marker or a task write that failed after the
      // send). The outbox is the authority, so let the task read it.
      await prisma.smartTask
        .updateMany({
          where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            summary: `Feedback ask already sent to ${project.client.name} for this job — nothing was re-sent.`,
          },
        })
        .catch(() => {});
      await stampMarker(marker);
    } else if (res.outcome === "duplicate" && res.state === "unknown") {
      await markSendUnverified([t.id], { projectId: project.id, label: "Delivery", clientName: project.client.name });
      await stampMarker(marker);
    }
    const note = outcomeNote(project.title, res);
    if (note) notes.push(note);
  }
  return { sent, skipped, notes };
}

// ---------------------------------------------------------------------------
// WEEKEND / AFTER-HOURS AUTO-REPLY (Jordan, Sep 2 2026)
//
// "When a client texts outside working hours: reply with the office hours
// (Mon-Fri 9-6), that we will come back to them first thing on the next working
// day, and that they can log in at media.realtourpilot.com to place orders,
// reschedule appointments, and get their content and invoices."
//
// Live data behind the rule (60 days to Sep 2): 264 of 997 inbound client texts
// arrived while we were shut — 111 of them on a Saturday or Sunday — and only
// about a quarter got an answer inside 12 hours. Deduped to one reply per
// client per closed period that is 60 replies in 60 days: about one a day.
//
// NEVER A LOOP:
//  · one message identity per (client, closed period) — `afterhours:<clientId>:
//    <period>` in the outbox, taken before the provider is called, so two
//    overlapping crons and two texts from the same person get ONE reply (Friday
//    6pm to Monday 9am is a single period). The matching `auto-afterhours-*`
//    AppSetting marker is written after the provider answers (RTP-08, Sep 16)
//    and read first as the settled record of an earlier reply;
//  · we never answer our own words — the row must be an INBOUND text, and any
//    number belonging to our line or a teammate's handset is excluded outright
//    (the OpenPhone webhook logs a teammate's own handset as inbound on
//    internal threads);
//  · if anyone has already texted this client back since we shut — a human on a
//    Saturday, or our own earlier auto-reply — nothing is sent;
//  · a text older than afterHours.maxAgeHours is never answered, so a cron
//    catch-up after an outage can't reply to Friday's message on Monday night.
//
// ⚠️ CROSS-FILE: api/webhooks/openphone/route.ts recognises the hub's own
// automated sends by `source: { in: ["auto-confirmation", "auto-delivery"] }`
// and skips the human-send heuristics for them. "auto-afterhours" MUST be added
// to that list (AUTO_SOURCES above is the canonical list) — otherwise the echo
// of this reply closes the client's own client_reply task, blanket-completes
// their queued delivery_text, and completes a confirmation_text for any shoot
// inside 48h, all without a word being sent. Until it is, the repair pass below
// undoes that damage on the next tick.
// ---------------------------------------------------------------------------

const AFTER_HOURS_MARKER = "auto-afterhours-";

/** The closed period we are inside right now, or null when the office is open.
 *  Keyed on the CLOSING moment that started it, so Friday 6pm through Monday
 *  9am is one period and a client who texts on Saturday and again on Sunday
 *  hears from the robot once. */
function closedPeriod(openHour: number, closeHour: number, at: Date): { key: string; startedAt: Date } | null {
  const m = etMoment(at);
  const weekday = m.dow >= 1 && m.dow <= 5;
  if (weekday && m.minutes >= openHour * 60 && m.minutes < closeHour * 60) return null;
  // Whose closing time started this? Today's if it is a working day we are past
  // the end of; otherwise the last working day before now.
  let day = new Date(at);
  if (!(weekday && m.minutes >= closeHour * 60)) {
    for (let i = 0; i < 10; i++) {
      day = new Date(day.getTime() - 24 * HOUR);
      if (isWeekdayEt(day)) break;
    }
  }
  const dayKey = etMoment(day).dayKey;
  return { key: `${dayKey}-${closeHour}`, startedAt: etAt(dayKey, closeHour) };
}

/** "this morning" / "tomorrow morning" / "Monday morning" — what we promise. */
function nextWorkingMorning(at: Date, openHour: number): string {
  const m = etMoment(at);
  let day = new Date(at);
  const beforeOpenToday = m.dow >= 1 && m.dow <= 5 && m.minutes < openHour * 60;
  if (!beforeOpenToday) {
    for (let i = 0; i < 10; i++) {
      day = new Date(day.getTime() + 24 * HOUR);
      if (isWeekdayEt(day)) break;
    }
  }
  const key = etMoment(day).dayKey;
  if (key === m.dayKey) return "this morning";
  if (key === etMoment(new Date(at.getTime() + 24 * HOUR)).dayKey) return "tomorrow morning";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(day)} morning`;
}

function officeHoursLabel(openHour: number, closeHour: number): string {
  const t = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
  return `Monday to Friday, ${t(openHour)} to ${t(closeHour)}`;
}

/** Undo the damage an unpatched OpenPhone webhook does with our auto-reply (see
 *  the CROSS-FILE warning above): it reads the outbound echo as "we answered
 *  them" and closes the client's real tasks. Anything of theirs that completed
 *  in the minutes around our robot's text, with nobody having sent anything, is
 *  reopened. The window is deliberately tiny (-1 to +8 minutes of a text sent
 *  while the office is shut) — a human closing a task inside it is not a thing
 *  that happens at 10pm on a Saturday, and losing a client's question is far
 *  worse than reopening one task too many. A no-op once the webhook is fixed. */
async function repairAfterHoursCollateral(): Promise<string[]> {
  const notes: string[] = [];
  const sends = await prisma.commLog
    .findMany({
      where: { channel: "text", direction: "out", source: "auto-afterhours", occurredAt: { gte: new Date(Date.now() - 3 * HOUR) } },
      select: { clientId: true, clientName: true, occurredAt: true },
    })
    .catch(() => [] as { clientId: string | null; clientName: string | null; occurredAt: Date }[]);
  for (const s of sends) {
    if (!s.clientId) continue;
    const reopened = await prisma.smartTask
      .updateMany({
        where: {
          clientId: s.clientId,
          taskType: { in: ["client_reply", "delivery_text", "confirmation_text"] },
          status: "COMPLETED",
          completedAt: { gte: new Date(s.occurredAt.getTime() - 60_000), lte: new Date(s.occurredAt.getTime() + 8 * 60_000) },
        },
        data: { status: "OPEN", completedAt: null },
      })
      .catch(() => ({ count: 0 }));
    if (reopened.count > 0) {
      notes.push(`reopened ${reopened.count} task(s) that the echo of our own after-hours reply to ${s.clientName ?? "a client"} had closed`);
    }
  }
  return notes;
}

/** One reply per client per closed period, to whoever texted us while we were
 *  shut. Deliberately NOT gated on the 9am-4:30pm send window: this is an
 *  answer to a message that just arrived, and by definition it only ever runs
 *  outside office hours. */
export async function sweepAfterHoursReplies(texted: Set<string> = new Set()): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  // The repair runs on EVERY tick, office hours included: a 10pm reply's echo
  // has to be undone before Kyle opens the queue at 9am, and by then the
  // closed-period gate below has shut.
  notes.push(...(await repairAfterHoursCollateral()));
  if (!rules.enabled || !rules.afterHours.enabled) {
    notes.push("after-hours auto-reply is switched OFF in Settings → Automated texts");
    return { sent: 0, skipped: 0, notes };
  }
  const now = new Date();
  const period = closedPeriod(rules.afterHours.openHour, rules.afterHours.closeHour, now);
  if (!period) return { sent: 0, skipped: 0, notes };

  // Only messages from THIS closed period, and never one older than the age cap
  // (an outage must not make us answer a two-day-old text as if it just landed).
  const since = new Date(Math.max(period.startedAt.getTime(), now.getTime() - rules.afterHours.maxAgeHours * HOUR));
  const inbound = await prisma.commLog.findMany({
    where: { channel: "text", direction: "in", clientId: { not: null }, occurredAt: { gte: since } },
    // contactName is the REAL sender (an agent's assistant writes in under her
    // own name while the row files to the agent's client record) — greet who
    // actually texted, not the account holder.
    select: { clientId: true, clientName: true, contactName: true, fromPhone: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });
  if (inbound.length === 0) return { sent: 0, skipped: 0, notes };

  const { phoneKey, from } = await openPhone();
  if (!from) return { sent: 0, skipped: inbound.length, notes: [...notes, "OpenPhone not connected"] };
  const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const ourKeys = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  // A teammate's own handset is logged inbound on internal threads — texting
  // Kyle our office hours would be absurd, and it is the shape of a loop.
  const team = await prisma.teamMember.findMany({ where: { phone: { not: null } }, select: { phone: true } });
  const excluded = new Set<string>([...ourKeys, ...team.map((t) => phoneKey(t.phone ?? "")).filter((k) => k.length === 10)]);
  const { applyTemplate } = await import("@/lib/delivery");

  // One reply per CLIENT, to their latest number (they may have written from a
  // second line mid-period).
  const latest = new Map<string, { name: string | null; phone: string }>();
  for (const r of inbound) {
    const k = phoneKey(r.fromPhone ?? "");
    if (k.length !== 10 || excluded.has(k)) continue;
    // The webhook falls back to a formatted PHONE NUMBER when it can't name the
    // sender — "Hi (610)" is worse than no name at all, so only take a
    // contactName that reads like a person.
    const person = r.contactName && !/\d/.test(r.contactName) ? r.contactName : null;
    latest.set(r.clientId!, { name: person ?? r.clientName, phone: k });
  }

  let sent = 0, skipped = 0;
  for (const [clientId, msg] of latest) {
    if (texted.has(clientId)) { skipped++; continue; } // shared with the other sweeps: one automated text per client per tick
    // Anyone already texted them back since we shut — a human on the weekend,
    // or our own earlier reply. Either way the robot has nothing to add.
    const answered = await prisma.commLog.findFirst({
      where: {
        channel: "text", direction: "out", occurredAt: { gte: period.startedAt },
        OR: [{ clientId }, { fromPhone: msg.phone }],
      },
      select: { id: true },
    });
    if (answered) { skipped++; continue; }
    // Saturday is a shoot day and the office is shut: a client texting while
    // our photographer is standing in their kitchen must not be told we are
    // closed. The crew is with them; they are already being looked after.
    const dayKey = etMoment(now).dayKey;
    const shootingToday = await prisma.project.findFirst({
      where: { clientId, status: { notIn: ["CANCELLED", "ON_HOLD"] }, shootDate: { gte: etAt(dayKey, 0), lt: etAt(dayKey, 24) } },
      select: { id: true },
    });
    if (shootingToday) {
      skipped++;
      notes.push(`${msg.name ?? "a client"}: has a shoot today — the crew is with them, no robot reply`);
      continue;
    }
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, autoConfirmationText: true, autoDeliveryText: true },
    });
    // No switch names this reply, so read the two we have honestly: a client
    // with BOTH automated texts turned off has said "don't have the robot text
    // me", and that covers this too. Their message still sits in the queue.
    if (client && !client.autoConfirmationText && !client.autoDeliveryText) {
      skipped++;
      notes.push(`${client.name}: all automatic texts off — their message is waiting for a human`);
      continue;
    }
    // ONE reply per (client, closed period). The outbox row on that identity is
    // what two overlapping crons race on; the marker is read first as the
    // settled record (including every reply sent before the outbox) and written
    // once the provider has answered.
    const marker = `${AFTER_HOURS_MARKER}${clientId}-${period.key}`;
    if (await alreadyMarked(marker)) { skipped++; continue; }
    // Greet the human who wrote in (msg.name), falling back to the account.
    const name = (msg.name || client?.name || "").trim();
    const body = applyTemplate(rules.afterHours.message, {
      first: name.split(/\s+/)[0] || "there",
      hours: officeHoursLabel(rules.afterHours.openHour, rules.afterHours.closeHour),
      nextDay: nextWorkingMorning(now, rules.afterHours.openHour),
      portal: rules.afterHours.portalUrl,
    });
    const res = await trySend(`after-hours reply to ${client?.name ?? "client"}`, {
      channel: "sms",
      toRef: msg.phone,
      body,
      dedupeKey: afterHoursKey(clientId, period.key),
      clientId,
      requestedBy: "sweep:afterhours",
    }, notes);
    if (res.outcome === "accepted") {
      sent++;
      texted.add(clientId);
      await stampMarker(marker);
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        clientId, clientName: client?.name ?? msg.name ?? null,
        contactName: "RealTour Pilot", fromPhone: msg.phone, body,
        source: "auto-afterhours",
        externalId: res.providerId ? `op-${res.providerId}` : marker,
      }).catch(() => {});
      continue;
    }
    skipped++;
    if (res.outcome === "unknown") {
      // Hold it. A duplicate auto-reply is worse than none, and the row waits
      // on Connections for a person to settle in OpenPhone.
      texted.add(clientId);
      await stampMarker(marker);
    } else if (res.outcome === "duplicate" && (res.state === "accepted" || res.state === "unknown")) {
      // Somebody else's row owns this (client, closed period) — the recovery
      // drain or an overlapping cron. Write the marker this sweep would have
      // written, so the next tick stops at the gate instead of re-enqueueing
      // against an answered identity (review, Sep 16).
      await stampMarker(marker);
    }
    const note = outcomeNote(`after-hours reply to ${client?.name ?? "client"}`, res);
    if (note) notes.push(note);
  }
  return { sent, skipped, notes };
}

export { AUTO_SOURCES };

/**
 * IS THIS QUEUED MESSAGE STILL TRUE? (audit, Sep 17.)
 *
 * The Gmail cron's recovery drain sends rows a stopped worker left behind. Its
 * only gate was the client-text window — which stops a text going out after
 * 4:30pm, and says nothing at all about whether the text is still correct. A
 * confirmation queued on Monday for a Wednesday shoot that has since been moved
 * or cancelled would have gone out on Tuesday saying the old time; a feedback
 * ask for a job the client has since bounced back into revisions would have
 * gone out congratulating them on the delivery.
 *
 * So the facts the sweep checked when it queued the row are checked again here,
 * from the row's own identity. A row that is no longer true is not sent and not
 * retried — it is superseded, and the sweep that owns it will queue a fresh one
 * if one is still owed.
 */
export async function recoveredTextStillTrue(row: {
  dedupeKey: string | null;
  projectId: string | null;
  clientId: string | null;
}): Promise<{ ok: true } | { ok: false; why: string }> {
  const [kind, head, ...rest] = (row.dedupeKey ?? "").split(":");
  const tail = rest.join(":");
  if (!kind || !head) return { ok: true }; // not one of ours to judge

  if (kind === "confirmation") {
    const p = await prisma.project.findUnique({ where: { id: head }, select: { shootDate: true, status: true } });
    if (!p) return { ok: false, why: "the job no longer exists" };
    if (p.status === "CANCELLED") return { ok: false, why: "the shoot was cancelled" };
    // The key carries the ET day and start time the text was written about.
    // Rebuilding it from the CURRENT shoot date is the whole check: a move of
    // any size changes the key, and the message quotes the old time.
    if (confirmationKey(head, p.shootDate) !== `confirmation:${head}:${tail}`) {
      return { ok: false, why: "the shoot time changed after this text was written" };
    }
    const handled = await prisma.smartTask.findFirst({
      where: { projectId: head, taskType: "confirmation_text", status: { in: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    if (handled) return { ok: false, why: "somebody has already confirmed this shoot" };
    return { ok: true };
  }

  if (kind === "delivery") {
    const p = await prisma.project.findUnique({ where: { id: head }, select: { deliveredAt: true, status: true, revisionRequestedAt: true } });
    if (!p) return { ok: false, why: "the job no longer exists" };
    if (!p.deliveredAt) return { ok: false, why: "the job is no longer marked delivered" };
    if (p.status === "REVISION" || p.revisionRequestedAt) return { ok: false, why: "the client has asked for changes since this was written" };
    return { ok: true };
  }

  if (kind === "welcome") {
    const c = await prisma.client.findUnique({ where: { id: head }, select: { welcomeTextAt: true } });
    if (!c) return { ok: false, why: "the client record no longer exists" };
    if (c.welcomeTextAt) return { ok: false, why: "this client has already been welcomed" };
    return { ok: true };
  }

  // afterhours is bounded by its own period key, and the program kinds carry
  // their eligibility on the notice the sender drains. The window gate stands.
  return { ok: true };
}

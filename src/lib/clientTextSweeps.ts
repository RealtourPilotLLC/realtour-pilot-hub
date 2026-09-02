import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { logComm } from "@/lib/commLog";
import { OpenPhoneError } from "@/lib/integrations/openphone";
import { MONTHLY_BATCH_INCOMPLETE, DELIVERED_LONG_AGO, SEND_UNVERIFIED } from "@/lib/tasks";
import { etAt } from "@/lib/datetime";

// Auto-send client texts (Jordan, Sep 1 2026): confirmation texts go out on
// their own 2 days before the shoot, and delivery texts go out on their own
// once every ordered deliverable has shipped through Aryeo. Both were manual
// send-button tasks before; the tasks still exist (history + reconciler) but
// complete themselves the moment the sweep sends.
//
// Safety model (review-hardened):
// - The TASK row is claimed atomically first — the same row the manual /texts
//   send button and the OpenPhone webhook contend on, so a human send racing
//   the sweep can never double-text.
// - An AppSetting marker is then CLAIMED before the send (unique create — two
//   overlapping crons can't double-text, and a re-minted task for an
//   already-texted project stays silent).
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
// completed client-text task must mean a text happened. Every successful send
// below leaves TWO project-scoped traces — the AppSetting marker and an
// outbound CommLog row — which is exactly what tasks.ts deliveryTextSendProof
// reads when the 7-day sweeper decides whether a lingering task closes as done
// (COMPLETED) or as never-sent (CANCELLED). The one case that claims a task
// without proving a send is an AMBIGUOUS provider failure; it is stamped
// SEND_UNVERIFIED and written onto the project timeline rather than left to
// look like a clean send.

const HOUR = 3_600_000;
// Sources the OpenPhone webhook must recognise as "the hub sent this itself".
// An automated send answers nobody's question and closes nobody's task but its
// own — see the `autoSent` guard in api/webhooks/openphone/route.ts, which
// reads exactly these strings.
const AUTO_SOURCES = ["auto-confirmation", "auto-delivery", "auto-afterhours"];

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

async function openPhone() {
  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const from = await defaultOpenPhoneNumber();
  return { phoneKey, OpenPhone, from };
}

// A 4xx (except 408) means OpenPhone REJECTED the send — safe to retry next
// tick. A timeout / 5xx after the API may have accepted it is AMBIGUOUS: the
// text may already be in the client's hands, so hold the claim and flag for a
// human instead of auto-resending an SMS.
function provablyNotSent(e: unknown): boolean {
  return e instanceof OpenPhoneError && typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408;
}

// An ambiguous failure HOLDS the task's claim — re-sending an SMS the client may
// already be reading is worse than a stuck task. But a held claim reads exactly
// like a clean send on every screen (Done ledger included), which is the lie
// this hub is buying out. Stamp the row SEND_UNVERIFIED and put the doubt on the
// project timeline so a human can settle it in OpenPhone. Best-effort: the
// honesty note must never turn a send failure into a cron failure.
async function markSendUnverified(taskIds: string[], opts: { projectId: string; label: string; clientName: string }): Promise<void> {
  const doubt = `${opts.label} text to ${opts.clientName} could not be confirmed — OpenPhone may or may not have sent it. Nothing was re-sent (a duplicate text is worse); check the OpenPhone thread and text by hand if it never landed.`;
  if (taskIds.length > 0) {
    await prisma.smartTask
      .updateMany({ where: { id: { in: taskIds } }, data: { sourceDetail: SEND_UNVERIFIED, summary: doubt.slice(0, 500) } })
      .catch(() => {});
  }
  await prisma.activity.create({ data: { projectId: opts.projectId, type: "SYSTEM", body: doubt } }).catch(() => {});
}

// The client has an unanswered question in the queue — an automated text now
// would read as our reply (the outbound webhook closes their reply task) while
// answering nothing. Leave the whole client to a human; later ticks retry.
async function clientHasOpenQuestion(clientId: string): Promise<boolean> {
  const open = await prisma.smartTask.findFirst({
    where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  return !!open;
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
      status: { in: ["BOOKED", "SCHEDULED"] },
      shootDate: { gt: now, lte: horizon },
      aryeoMissingAt: null, // order gone from Aryeo → never text the client about it
    },
    select: {
      id: true, title: true, shootDate: true,
      // autoConfirmationText = this client's own switch (/clients → Notifications).
      client: { select: { id: true, name: true, phone: true, autoConfirmationText: true } },
      photographer: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true } },
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
  const { phoneKey, OpenPhone, from } = await openPhone();
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
    if (rules.skipWhenClientWaiting && await clientHasOpenQuestion(p.client.id)) {
      skipped++; notes.push(`${p.title}: client has an open question — left for a human`); continue;
    }
    // Someone already sent it by hand (the old send button / a hand-typed text
    // the webhook recognized) → nothing owed.
    const already = await prisma.smartTask.findFirst({
      where: { projectId: p.id, taskType: "confirmation_text", status: "COMPLETED" },
      select: { id: true },
    });
    if (already) { skipped++; continue; }
    // Atomically claim any open confirmation_text task — the same row a manual
    // send claims, so racing a human send loses cleanly (no double-text).
    const openTasks = await prisma.smartTask.findMany({
      where: { projectId: p.id, taskType: "confirmation_text", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    const taskIds = openTasks.map((t) => t.id);
    if (taskIds.length > 0) {
      const claimed = await prisma.smartTask.updateMany({
        where: { id: { in: taskIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      if (claimed.count === 0) { skipped++; continue; } // a human just sent it
    }
    const day = p.shootDate!.toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
    const marker = `auto-confirm-${p.id}-${day}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch { skipped++; continue; } // claimed by an earlier tick — task completion above stands (already texted)
    const body = confirmationMessage({
      title: p.title, shootDate: p.shootDate,
      client: { name: p.client.name }, photographer: p.photographer, deliverables: p.deliverables,
    }, tpl.confirmation);
    try {
      const res = await OpenPhone.sendMessage(from, `+1${k}`, body);
      sent++;
      texted.add(p.client.id);
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
        externalId: res?.data?.id ? `op-${res.data.id}` : marker,
      }).catch(() => {});
    } catch (e) {
      skipped++;
      if (provablyNotSent(e)) {
        // Clean rejection: release everything so the next tick retries.
        await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
        if (taskIds.length > 0) {
          await prisma.smartTask.updateMany({ where: { id: { in: taskIds } }, data: { status: "OPEN", completedAt: null } }).catch(() => {});
        }
        notes.push(`${p.title}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
      } else {
        // Ambiguous (timeout/5xx after possible acceptance): hold the claim so
        // the sweep can't double-text; a human verifies in OpenPhone. The hold
        // leaves the task COMPLETED with no proof of a send, so say so on the
        // row and on the job instead of letting it pass as sent.
        await markSendUnverified(taskIds, { projectId: p.id, label: "Confirmation", clientName: p.client.name });
        notes.push(`${p.title}: send failed (ambiguous — held, verify in OpenPhone before resending) — ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
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
  ev: { aryeo: { videos: number } | null; dropbox: { finalVideo: number } | null },
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
    // "Completed and delivered" (Jordan's words): live on Aryeo, in the job's
    // Final folder, or an approved cut whose copy into Dropbox has finished.
    const proved =
      (ev.aryeo?.videos ?? 0) > 0 ||
      (ev.dropbox?.finalVideo ?? 0) > 0 ||
      [...latest.values()].some((c) => c.status === "APPROVED" && c.completedAt);
    if (!proved) return "video was ordered and nothing proves a video has shipped yet";
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
 *    1. the status evidence lists nothing missing, and there IS evidence
 *       (a hand-drag to Delivered with no evidence proves nothing);
 *    2. every video CUT in the Review Room has been approved — an editor's
 *       version 2 sitting in review means the client hasn't got the video, no
 *       matter what a file count says;
 *    3. a job that ordered video has positive proof a video shipped (Aryeo, the
 *       Dropbox Final folder, or an approved+copied cut). Live data, Sep 2:
 *       8 of 156 delivered jobs with video ordered had no such proof.
 *  Post-delivery revisions and the two human-decision flags stay manual, and
 *  only fresh tasks (≤72h) auto-send so a day-one deploy can't text about last
 *  week's job. */
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
      createdAt: { gte: new Date(Date.now() - rules.delivery.maxTaskAgeHours * HOUR) },
      projectId: { not: null },
      // Order gone from Aryeo → the job is in limbo; never text the client.
      project: { is: { aryeoMissingAt: null } },
    },
    select: { id: true, projectId: true, sourceDetail: true },
    // Oldest first, so a deferred (one-per-client-per-tick) task can't age out
    // of the 72h window while newer ones keep sending.
    orderBy: { createdAt: "asc" },
  });
  if (tasks.length === 0) return { sent: 0, skipped: 0, notes };
  const { phoneKey, OpenPhone, from } = await openPhone();
  if (!from) return { sent: 0, skipped: tasks.length, notes: ["OpenPhone not connected"] };
  const { deliveryMessage } = await import("@/lib/delivery");
  const { textTemplates, DEFAULT_DELIVERY_FEEDBACK_TEXT } = await import("@/lib/settings");
  const tpl = await textTemplates();

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
    if (project.status !== "DELIVERED") { skipped++; continue; }
    // Positive evidence only: no evidence at all (manual drag to DELIVERED,
    // stale blob) or an unverifiable order (nothing expected, no Aryeo
    // fulfilled signal) is NOT the same as "everything shipped" — stays manual.
    const ev = parseEvidence(project.statusEvidence);
    if (!ev || ev.missing.length > 0 || (ev.expected.length === 0 && !ev.fulfilledOnAryeo)) { skipped++; continue; }
    // "Fully delivered" means the WHOLE job, video included (Jordan's rule).
    const outstanding = wholeJobOutstanding(project, ev);
    if (outstanding) {
      skipped++;
      notes.push(`${project.title}: ${outstanding} — the feedback ask waits`);
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
    if (k.length !== 10) { skipped++; notes.push(`${project.title}: no valid client phone`); continue; }
    // This client's own switch is off — skip before any claim so the task stays
    // OPEN for a human to send by hand (see the Client schema comment).
    if (!project.client.autoDeliveryText) {
      skipped++; notes.push(`${project.title}: ${project.client.name} has automatic delivery texts off — left for a human`); continue;
    }
    if (rules.onePerClientPerRun && texted.has(project.client.id)) { skipped++; continue; }
    if (rules.skipWhenClientWaiting && await clientHasOpenQuestion(project.client.id)) {
      skipped++; notes.push(`${project.title}: client has an open question — left for a human`); continue;
    }
    // Atomically claim the task — the manual /texts send and the OpenPhone
    // webhook complete this same row, so whoever claims first wins alone.
    const claimed = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (claimed.count === 0) { skipped++; continue; } // a human just handled it
    const marker = `auto-delivery-${project.id}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch { skipped++; continue; } // already auto-texted for this project — task completion stands
    // The wording: whatever Jordan typed into Settings → Text templates →
    // "Delivery text" wins; a blank box falls back to the built-in feedback ask
    // (lib/settings DEFAULT_DELIVERY_FEEDBACK_TEXT) rather than to the older
    // "everything has been delivered" announcement. The partial variant is
    // never reached from here — the gate above guarantees nothing is missing.
    const body = deliveryMessage(project, { ...tpl, deliveryAll: tpl.deliveryAll.trim() || DEFAULT_DELIVERY_FEEDBACK_TEXT });
    try {
      const res = await OpenPhone.sendMessage(from, `+1${k}`, body);
      sent++;
      texted.add(project.client.id);
      await prisma.activity.create({
        data: { projectId: project.id, type: "SYSTEM", body: `Delivery text auto-sent to ${project.client.name}: ${body.slice(0, 160)}` },
      }).catch(() => {});
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        clientId: project.client.id, clientName: project.client.name, projectId: project.id,
        contactName: project.client.name, fromPhone: k, body,
        source: "auto-delivery",
        externalId: res?.data?.id ? `op-${res.data.id}` : marker,
      }).catch(() => {});
    } catch (e) {
      skipped++;
      if (provablyNotSent(e)) {
        await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
        await prisma.smartTask.updateMany({ where: { id: t.id }, data: { status: "OPEN", completedAt: null } }).catch(() => {});
        notes.push(`${project.title}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
      } else {
        // Held claim, no proof of a send — mark the doubt (see markSendUnverified).
        await markSendUnverified([t.id], { projectId: project.id, label: "Delivery", clientName: project.client.name });
        notes.push(`${project.title}: send failed (ambiguous — held, verify in OpenPhone before resending) — ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
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
//  · one AppSetting marker per (client, closed period), created before the send,
//    so two overlapping crons and two texts from the same person get ONE reply
//    (Friday 6pm to Monday 9am is a single period);
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

  const { phoneKey, OpenPhone, from } = await openPhone();
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
    // CLAIM FIRST: unique key per (client, closed period). Two overlapping
    // crons, or a second text from them at 11pm, can never earn a second reply.
    const marker = `${AFTER_HOURS_MARKER}${clientId}-${period.key}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: now.toISOString() } });
    } catch { skipped++; continue; }
    // Greet the human who wrote in (msg.name), falling back to the account.
    const name = (msg.name || client?.name || "").trim();
    const body = applyTemplate(rules.afterHours.message, {
      first: name.split(/\s+/)[0] || "there",
      hours: officeHoursLabel(rules.afterHours.openHour, rules.afterHours.closeHour),
      nextDay: nextWorkingMorning(now, rules.afterHours.openHour),
      portal: rules.afterHours.portalUrl,
    });
    try {
      const res = await OpenPhone.sendMessage(from, `+1${msg.phone}`, body);
      sent++;
      texted.add(clientId);
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        clientId, clientName: client?.name ?? msg.name ?? null,
        contactName: "RealTour Pilot", fromPhone: msg.phone, body,
        source: "auto-afterhours",
        externalId: res?.data?.id ? `op-${res.data.id}` : marker,
      }).catch(() => {});
    } catch (e) {
      skipped++;
      if (provablyNotSent(e)) {
        // Cleanly rejected: release the claim so the next tick tries again.
        await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
        notes.push(`after-hours reply to ${client?.name ?? "client"} failed — ${e instanceof Error ? e.message : "unknown"}`);
      } else {
        // Ambiguous: hold the claim. A duplicate auto-reply is worse than none.
        notes.push(`after-hours reply to ${client?.name ?? "client"} unconfirmed (held, check OpenPhone) — ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  }
  return { sent, skipped, notes };
}

export { AUTO_SOURCES };

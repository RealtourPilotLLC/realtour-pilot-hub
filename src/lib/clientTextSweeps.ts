import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { logComm } from "@/lib/commLog";
import { OpenPhoneError } from "@/lib/integrations/openphone";
import { MONTHLY_BATCH_INCOMPLETE, DELIVERED_LONG_AGO, SEND_UNVERIFIED } from "@/lib/tasks";

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
// - Nothing sends after 4pm ET; it waits for the next morning.
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
const AUTO_SOURCES = ["auto-confirmation", "auto-delivery"];

function etHourNow(): number {
  return Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
}

// Client texts go out in the BUSINESS morning/afternoon only — never in the
// evening (Jordan, Sep 1: "they should never go out past 4PM. If 4PM passes,
// they should go out the next morning"). The hourly cron simply skips every
// tick outside 9am-4pm ET and catches up on the next morning's first tick.
// (Node's ICU renders midnight as "24" with hour12:false — safely outside.)
// DEFAULTS only — the live values come from Settings → Automated texts
// (lib/settings autoTextRules), so Jordan can move the window or switch an
// automation off without a deploy.
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 16; // exclusive — the 4:00pm tick is already too late
// The missed-confirmation scan runs only on in-window ticks, so it must reach
// from the FIRST tick of the day back past the LAST tick of the previous one.
// Derived, because the old hard-coded 14h was tuned to the 8pm window and left
// 3pm-7pm shoots (twilights) invisible when the cutoff moved to 4pm (review).
const MISSED_LOOKBACK_HOURS = 24 - (SEND_UNTIL_HOUR - 1) + SEND_FROM_HOUR + 1;
function inSendWindow(from = SEND_FROM_HOUR, until = SEND_UNTIL_HOUR): boolean {
  const h = etHourNow();
  return h >= from && h < until;
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
  if (!inSendWindow(rules.sendFromHour, rules.sendUntilHour)) {
    return { sent: 0, skipped: 0, notes: [`outside the ${rules.sendFromHour}:00-${rules.sendUntilHour}:00 ET send window — waiting for the next morning`] };
  }
  const now = new Date();
  const projects = await prisma.project.findMany({
    where: {
      status: { in: ["BOOKED", "SCHEDULED"] },
      shootDate: { gt: now, lte: new Date(now.getTime() + rules.confirmation.hoursBefore * HOUR) },
      aryeoMissingAt: null, // order gone from Aryeo → never text the client about it
    },
    select: {
      id: true, title: true, shootDate: true,
      client: { select: { id: true, name: true, phone: true } },
      photographer: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true } },
    },
  });

  // Surface overnight misses: a shoot that started during quiet hours before
  // any compliant tick could confirm it. Noted exactly once (marker-claimed)
  // so the gap is visible instead of silently swallowed.
  const missed = await prisma.project.findMany({
    where: {
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      shootDate: { gt: new Date(now.getTime() - MISSED_LOOKBACK_HOURS * HOUR), lte: now },
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

/** Delivery texts: an open delivery_text task whose project reads DELIVERED
 *  with positive evidence that NOTHING is missing — send the feedback-first
 *  message and complete the task. Unknown/partial evidence and post-delivery
 *  revisions stay manual (Kyle decides what helps). Only fresh tasks (≤72h)
 *  auto-send, so day-one deploy can't text about last week's job. */
export async function sweepDeliveryTexts(texted: Set<string> = new Set()): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  if (!rules.enabled || !rules.delivery.enabled) {
    return { sent: 0, skipped: 0, notes: ["delivery texts are switched OFF in Settings → Automated texts"] };
  }
  if (!inSendWindow(rules.sendFromHour, rules.sendUntilHour)) {
    return { sent: 0, skipped: 0, notes: [`outside the ${rules.sendFromHour}:00-${rules.sendUntilHour}:00 ET send window — waiting for the next morning`] };
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
  const { textTemplates } = await import("@/lib/settings");
  const tpl = await textTemplates();

  let sent = 0, skipped = 0;
  for (const t of tasks) {
    const project = await prisma.project.findUnique({
      where: { id: t.projectId! },
      select: {
        id: true, title: true, status: true, statusEvidence: true, packageName: true,
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
        client: { select: { id: true, name: true, phone: true } },
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
    const body = deliveryMessage(project, tpl);
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

export { AUTO_SOURCES };

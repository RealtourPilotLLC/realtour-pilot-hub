"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { clientTextWhere } from "@/lib/clientTexts";

// ---------------------------------------------------------------------------
// "Send all" for the drafted client texts (confirmation + delivery). This is
// the HUMAN rail: the panel lists each freshly-rendered draft, Jordan/Kyle can
// edit any of them or untick ones to skip, and "Send all" fires the ticked ones
// one by one. Each send logs to the project and completes its task, same as the
// per-card Send button.
//
// (It is not the only rail. Since Sep 1 2026, on Jordan's explicit order, the
// confirmation, delivery, welcome and after-hours texts also send themselves
// from the hourly cron — see lib/clientTextSweeps. Both rails now go through
// the same durable outbox and race on the same message identity, so a text the
// sweep has sent can never be sent again from here, and vice versa.)
// ---------------------------------------------------------------------------

export type DraftedText = {
  taskId: string;
  taskType: "confirmation_text" | "delivery_text";
  projectId: string;
  clientName: string;
  street: string;
  /** Freshly rendered message (shoot time / photographer current as of now). */
  body: string;
  /** Why this row can't send (no phone / invalid) — shown, excluded from batch. */
  blocked: string | null;
  /** Confirmation for a shoot that already started (or has no date yet) — loads UNTICKED with a warning. */
  warnStale: boolean;
  dueAt: string | null;
  overdue: boolean;
};

export async function listDraftedTexts(): Promise<{ ok: boolean; message?: string; rows?: DraftedText[] }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Not allowed." };
  }

  // ONE membership rule for every client-text surface (panel, badge, /today
  // rollup, this batch) — see clientTextWhere for why each clause exists.
  const tasks = await prisma.smartTask.findMany({
    where: clientTextWhere(),
    select: { id: true, taskType: true, projectId: true, dueAt: true },
    orderBy: [{ taskType: "asc" }, { dueAt: "asc" }],
  });
  if (tasks.length === 0) return { ok: true, rows: [] };

  const projects = await prisma.project.findMany({
    where: { id: { in: tasks.map((t) => t.projectId!) } },
    select: {
      id: true, title: true, shootDate: true, statusEvidence: true,
      client: { select: { name: true, phone: true } },
      photographer: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, waivedAt: true } }, // waived items are not read out to the client (Sep 16)
    },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  const { phoneKey } = await import("@/lib/integrations/openphone");
  const { deliveryMessage, confirmationMessage } = await import("@/lib/delivery");
  // WHERE A ROW READS ITS TRUTH (RTP-08, Sep 16): the task says a text is owed;
  // the OUTBOX says whether one has already gone out under this message's
  // identity. A row the outbox is holding — a send it could not confirm — must
  // never be offered for a second send, no matter what the task says.
  const { outboxStatesFor, confirmationKey, deliveryKey } = await import("@/lib/outbox");
  const keyFor = (t: { taskType: string; projectId: string | null }, shootDate: Date | null) =>
    t.taskType === "delivery_text" ? deliveryKey(t.projectId!) : confirmationKey(t.projectId!, shootDate);
  const outboxState = await outboxStatesFor(
    tasks.map((t) => (byId.has(t.projectId!) ? keyFor(t, byId.get(t.projectId!)!.shootDate) : "")),
  );

  const rows: DraftedText[] = [];
  for (const t of tasks) {
    const p = byId.get(t.projectId!);
    if (!p) continue;
    const held = outboxState.get(keyFor(t, p.shootDate));
    const body =
      t.taskType === "delivery_text"
        ? deliveryMessage(p)
        : confirmationMessage({
            title: p.title,
            shootDate: p.shootDate,
            client: { name: p.client.name },
            photographer: p.photographer,
            deliverables: p.deliverables,
          });
    const blocked = !p.client.phone
      ? "No phone on file"
      : phoneKey(p.client.phone).length !== 10
        ? "Phone number looks invalid"
        : held === "unknown"
          ? "Held — an earlier send couldn't be confirmed. Check OpenPhone."
          : held === "accepted"
            ? "Already sent"
            : held === "pending" || held === "attempting"
              ? "A send is in flight"
              : null;
    rows.push({
      taskId: t.id,
      taskType: t.taskType as DraftedText["taskType"],
      projectId: p.id,
      clientName: p.client.name,
      street: p.title.split(",")[0].trim(),
      body,
      blocked,
      // "Confirming your shoot at 10 AM" sent at 2pm reads insane — the
      // per-card surface warns about this; the BATCH (one tap, many texts)
      // must too, and load these unticked. NO shoot date is just as unsendable:
      // the draft has no time to confirm, so it warns + loads unticked too.
      // A null dueAt is unsendable-by-default too: the task minted before the
      // shoot was scheduled, and the reconciler may not have caught up with a
      // freshly-set shootDate yet — one tap on "Send all" must never fire a
      // confirmation days early. (The Outbox panel warns on the same signal.)
      warnStale:
        t.taskType === "confirmation_text" && (!t.dueAt || !p.shootDate || p.shootDate.getTime() < Date.now()),
      dueAt: t.dueAt?.toISOString() ?? null,
      overdue: !!t.dueAt && t.dueAt.getTime() < Date.now(),
    });
  }
  return { ok: true, rows };
}

/**
 * Send ONE drafted text — with the (possibly human-edited) body the panel
 * showed. Logs to the project and completes the task, exactly like the
 * per-card send.
 *
 * RTP-08 (Sep 16): this used to CLAIM the task (status → COMPLETED) before
 * OpenPhone answered and roll it back inside a catch block. Two things fell out
 * of that and both were invisible on screen: a process killed between the claim
 * and the send left a COMPLETED task for a text nobody sent, and a send that
 * OpenPhone ACCEPTED and then timed out on was rolled back — offering the same
 * text to the next person to look at the panel. The send now goes through the
 * durable outbox (lib/outbox.ts), which holds the message's identity across a
 * restart, records OpenPhone's own message id, and answers "unknown" rather
 * than pretending a timeout was a refusal. The task is completed AFTER the
 * provider takes the message, not before.
 *
 * The identity is the JOB, not this task, so this panel, the per-card Send and
 * the automatic sweep all contend on one row: whoever gets there first sends,
 * and the other two are told so.
 */
export async function sendDraftText(taskId: string, body: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Message is empty." };
  if (text.length > 1200) return { ok: false, message: "Message is too long for a text." };

  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, taskType: true, projectId: true, status: true },
  });
  if (!task || !["confirmation_text", "delivery_text"].includes(task.taskType)) {
    return { ok: false, message: "Not a drafted-text task." };
  }
  if (!task.projectId) return { ok: false, message: "No project linked." };
  if (task.status === "COMPLETED" || task.status === "CANCELLED") return { ok: false, message: "Already handled." };

  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { id: true, clientId: true, shootDate: true, client: { select: { name: true, phone: true } } },
  });
  if (!project?.client.phone) return { ok: false, message: "No phone number on file." };

  const { phoneKey, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  // A gate, not the send: the outbox resolves the sending number itself.
  if (!(await defaultOpenPhoneNumber())) return { ok: false, message: "OpenPhone isn't connected." };

  const isDelivery = task.taskType === "delivery_text";
  const label = isDelivery ? "Delivery text" : "Confirmation text";
  const { sendThroughOutbox, confirmationKey, deliveryKey } = await import("@/lib/outbox");
  const { getCurrentUser } = await import("@/lib/auth/user");
  const actor = await getCurrentUser().catch(() => null);
  const who = actor?.email ?? "an admin";
  // WHO PRESSED SEND is deliberately NOT recorded on this rail (Sep 21 2026).
  // It is the outbox that owns that fact — `requestedBy` above — because the
  // words that go out here are the hub's own confirmation/delivery template.
  // See the stamp below the send for why naming the presser on a template is
  // worse than naming nobody. The other rails, where a person writes the
  // sentence, do record the session: replyActions, threadActions, shoot and
  // billing all call stampCommActor with `wrote: "the person"`.

  // The database failure is caught here so a Neon blip answers the person
  // instead of throwing mid-batch — and, critically, is never read as "already
  // sent". Anything the outbox did manage to write is settled by the watchdog.
  let res;
  try {
    res = await sendThroughOutbox({
      channel: "sms",
      toRef: k,
      body: text,
      dedupeKey: isDelivery ? deliveryKey(project.id) : confirmationKey(project.id, project.shootDate),
      clientId: project.clientId,
      projectId: project.id,
      taskId: task.id,
      requestedBy: who,
    });
  } catch (e) {
    return { ok: false, message: `The hub could not queue this text — ${e instanceof Error ? e.message : "database error"}. Nothing was sent; try again.` };
  }

  if (res.outcome === "duplicate") {
    // Someone — the sweep, another tab, the per-card button — owns this text.
    // An `unknown` holder is the one that matters: it may already be in the
    // client's hands, so nothing here re-sends it. A person settles it in
    // OpenPhone and uses Retry on Connections.
    if (res.state === "unknown") {
      return {
        ok: false,
        message: `Held: an earlier send of this ${label.toLowerCase()} could not be confirmed, so nothing was re-sent. Check the OpenPhone thread — Connections has a Retry if it never landed.`,
      };
    }
    if (res.state === "accepted") return { ok: false, message: `Already sent — this ${label.toLowerCase()} is on file.` };
    if (res.state === "failed") return { ok: false, message: "That send was just released by another worker — try again." };
    return { ok: false, message: "A send for this text is already in flight." };
  }
  if (res.outcome === "busy") return { ok: false, message: "Another send for this text is in flight — give it a moment." };
  if (res.outcome === "failed") return { ok: false, message: `${res.error} Nothing was sent; the task is still open.` };
  if (res.outcome === "unknown") {
    // NOT rolled back and NOT completed: OpenPhone may have taken it. The task
    // stays open so a person can see it, and the outbox holds the identity so
    // nothing — panel, sweep or cron — sends it again on its own.
    return {
      ok: false,
      message: `OpenPhone did not confirm this one (${res.error}). Nothing was re-sent — check the thread before sending by hand.`,
    };
  }

  // Accepted. Now, and only now, the bookkeeping.
  await prisma.smartTask
    .updateMany({ where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } })
    .catch(() => {});
  // Self-record in comms memory — don't depend on the delivery webhook (audit;
  // same externalId the webhook uses, so its event dedupes).
  const externalId = res.providerId ? `op-${res.providerId}` : undefined;
  await import("@/lib/commLog").then(({ logComm }) =>
    logComm({
      channel: "text",
      direction: "out",
      clientId: project.clientId,
      clientName: project.client.name,
      projectId: project.id,
      contactName: "Us",
      fromPhone: `+1${k}`,
      body: text,
      source: "openphone",
      externalId,
    }),
  ).catch(() => {});
  // …and mark it THE HUB'S WORDS, not the presser's.
  //
  // Corrected Sep 21 2026, hours after the first version, because the review was
  // right: `text` here is the confirmation/delivery TEMPLATE. It is factually
  // true that Kyle pressed the button, and the first version recorded him — but
  // the row is then byte-identical, to the end-of-day audit, to a sentence he
  // typed himself, and he gets coached on the hub's wording. Being told to write
  // our own template more warmly is exactly the manufactured criticism that gets
  // a coaching feature switched off after one night.
  //
  // So the row carries the hub-sent sentinel and NO person. That does two jobs
  // at once: the audit never sees an author on it (null means unknown, and an
  // unknown row is never coached), and the delivery echo — which comes back
  // under the API key, i.e. Jordan — can no longer stamp a name on it either.
  // The panel is not losing anything a surface reads today: before this feature
  // the row said "Us" and claimed nothing, which is what it says again.
  if (externalId) {
    await import("@/lib/commSenders")
      .then(({ stampCommActor }) => stampCommActor({ externalId, wrote: "the hub" }))
      .catch(() => {});
  }
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `${label} sent to ${project.client.name}: ${text.slice(0, 160)}` },
  });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: `${label} sent.` };
}

/**
 * "It never landed — send it now." The ONE way an unconfirmed send is ever
 * repeated, and deliberately a person's decision: the hub never retries an
 * `unknown` on its own, because the message may already be in the client's
 * hands. Lives here with the other send action; the Connections health card
 * calls it (see lib/outbox unknownSends for what that card lists).
 */
export async function retryUnknownSend(id: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const who = (await getCurrentUser().catch(() => null))?.email ?? "an admin";
  const { retryUnknownSend: retry } = await import("@/lib/outbox");
  const r = await retry(id, who);
  revalidatePath("/connections");
  revalidatePath("/tasks");
  return { ok: r.ok, message: r.message };
}

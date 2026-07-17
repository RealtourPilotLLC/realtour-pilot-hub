import "server-only";
import { prisma } from "@/lib/prisma";
import { notifyInApp } from "@/lib/notify";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Gmail-SEND health (audit finding #41). The token can read mail but lack the
// send scope (Google drops it if the reconnect consent skipped it), and only
// Jordan can fix that — /connections is owner-only. Before this, a failed send
// surfaced only as an inline "reconnect Google" error to whoever pressed Send,
// which an ADMIN literally cannot act on. These helpers route the failure to
// the one person who can: an owner bell + a reopenable owner task, and the
// task self-closes when the SAME mailbox sends successfully.
//
// PER-MAILBOX on purpose: info@ and hello@ hold separate tokens, so info@
// working must not close a task about hello@ being broken — that flip-flopped
// the durable item every time an unrelated send succeeded.
//
// Both are BEST-EFFORT and never throw — send-health reporting must never
// break the send path (or a cron) that calls it. Callers should AWAIT them
// (they're cheap): fire-and-forget writes get killed by the serverless freeze
// right after the response, which silently loses the one ping this exists for.
// ---------------------------------------------------------------------------

// One reopenable owner task per mailbox ("unknown" when the failing mailbox
// couldn't be determined — still routed, just less specific).
const taskKey = (mailbox: string) => `gmail-reconnect-${mailbox.toLowerCase()}`;

export async function reportGmailSendBroken(context: string, mailbox = "unknown"): Promise<void> {
  const mb = mailbox.toLowerCase();
  // Owner bell — day-bucketed dedupe so a burst of failed sends rings once,
  // not once per attempt. kind "system" is not in SMS_KINDS: bell only.
  await notifyInApp({
    kind: "system",
    title: `Gmail can't send${mb !== "unknown" ? ` (${mb})` : ""} — reconnect Google`,
    body: `A hub email failed (${context}).`.slice(0, 140),
    href: "/connections",
    targets: [{ roles: ["OWNER"] }],
    dedupeKey: `gmail-reconnect-${mb}-${etDayKey(new Date())}`,
  });

  // Owner task: mint once per mailbox, reopen if a past failure's task was
  // closed without the scope actually being granted (a later send failed again).
  try {
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey(mb) } });
    if (existing) {
      if (existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return; // already open
      await prisma.smartTask.update({
        where: { id: existing.id },
        data: { status: "OPEN", completedAt: null, reasonCreated: `Gmail send failed (${context})` },
      });
      return;
    }
    // Engine-minted — never set assignedManually (that flag is the humans'
    // "hands off" signal to every automatic engine, this task included).
    await prisma.smartTask.create({
      data: {
        taskType: "connection_fix",
        title: `Reconnect Google so hub emails send${mb !== "unknown" ? ` — ${mb}` : ""}`.slice(0, 120),
        summary:
          `Hub email replies are failing${mb !== "unknown" ? ` from ${mb}` : ""} — Gmail can read but not send. ` +
          "Open Connections → Google → Reconnect and approve BOTH mailboxes (info@ + hello@). " +
          "This task closes itself when this mailbox sends successfully.",
        reasonCreated: `Gmail send failed (${context})`,
        source: "system",
        sourceDetail: "/connections",
        priority: "URGENT",
        assignedKey: "jordan",
        dedupeKey: taskKey(mb),
      },
    });
  } catch {
    /* best-effort — the failed send already reported its own error to the user */
  }
}

// A send went through on THIS mailbox → its scope is granted; retire that
// mailbox's reconnect task (plus any legacy/unknown-keyed one — a working
// send is the strongest signal the generic task is stale too).
// updateMany (not update) so "no task exists" is a no-op, not an error.
export async function reportGmailSendWorking(mailbox = "unknown"): Promise<void> {
  await prisma.smartTask
    .updateMany({
      where: {
        dedupeKey: { in: [taskKey(mailbox), taskKey("unknown"), "gmail-reconnect"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    })
    .catch(() => {});
}

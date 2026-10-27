"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// SEND THE BOOKING REMINDER NOW (Oct 27 2026, Jordan: "I'd like a button to be
// able to send, like, reminders when they're not scheduled to be able to
// manually send reminders").
//
// The SAME reminder the daily booking lane sends, through the same path
// (programReminders.sendReminderNow): the reminders switch must be on, the
// policy valid, the client inside the rollout, the month not snoozed or
// suppressed, and it is recorded in the reminder history like any other send.
// It only skips the wait between reminders, because a person decided to send.
//
// Two steps on purpose: `checkBookingReminder` reads what WOULD go (writes
// nothing), the button shows it in a confirm, and only then
// `sendBookingReminderNow` sends. Both refuse unless the month's planning ask
// is the content-session booking, so this button can never send a different
// message than its label says. Client email is the office's (OWNER and
// ADMIN: isOffice, the same people who own client comms).
// ---------------------------------------------------------------------------

type Check = { ok: boolean; message: string; to?: string | null; clientName?: string; monthKey?: string };

async function who(): Promise<{ email: string; appUserId: string | null }> {
  await requireAdmin();
  const u = await getCurrentUser().catch(() => null);
  return { email: u?.email ?? "staff", appUserId: u?.id ?? null };
}

const sentence = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.").split("\n")[0].slice(0, 300);

/** What the button would send, or why it would not. Writes nothing. */
export async function checkBookingReminder(monthId: string): Promise<Check> {
  try {
    await who();
    const { previewReminders, actionLabel } = await import("@/lib/programReminders");
    const p = await previewReminders(monthId);
    const lane = p.lanes.find((l) => l.lane === "PRIMARY");
    const c = lane?.candidate;
    if (!c || c.action !== "BOOK_SESSION") {
      return { ok: false, message: c?.action ? `This month's reminder asks for ${actionLabel(c.action)}, not the session booking.` : `No booking reminder to send: ${c?.reason ?? "nothing is asked of the client"}.`, clientName: p.clientName, monthKey: p.monthKey };
    }
    if (c.decision === "suppressed") return { ok: false, message: `Not sendable: ${c.reason}.`, clientName: p.clientName, monthKey: p.monthKey };
    return { ok: true, message: "Ready to send.", to: c.to, clientName: p.clientName, monthKey: p.monthKey };
  } catch (e) {
    return { ok: false, message: sentence(e) };
  }
}

/** Send it now, through the reminder engine. */
export async function sendBookingReminderNow(monthId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const by = await who();
    const { previewReminders, reminderRowId, sendReminderNow } = await import("@/lib/programReminders");
    const p = await previewReminders(monthId);
    if (p.lanes.find((l) => l.lane === "PRIMARY")?.candidate.action !== "BOOK_SESSION") return { ok: false, message: "Not sent: this month no longer needs a session booked." };
    const r = await sendReminderNow(reminderRowId(monthId, "PRIMARY"), by);
    revalidatePath("/content");
    revalidatePath("/content/monitoring");
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return { ok: false, message: sentence(e) };
  }
}

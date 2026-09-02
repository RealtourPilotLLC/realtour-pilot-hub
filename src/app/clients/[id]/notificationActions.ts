"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// Per-client notification preferences (Jordan, Sep 2 2026: "I'd like to be able
// to manually adjust notification preferences for each client").
//
// Two switches, both defaulting ON (Client.autoConfirmationText /
// Client.autoDeliveryText):
//   · the shoot confirmation text (~48h before the shoot)
//   · the feedback ask that goes out once everything is delivered
//
// OFF does not silence the client — it takes the ROBOT off the send. The
// confirmation_text / delivery_text SmartTask is still minted and still sits on
// /tasks with its pre-drafted message, so a human reads the room and sends (or
// doesn't). That distinction is the whole point of the feature, so it is also
// the sentence printed under the switches on the client page.
//
// Guarded like every other client action (saveAgentProfile, saveCustomerNotes):
// requireAdmin() = owner + admin, and never while an owner is previewing as
// somebody else — "view as" is read-only.
// ---------------------------------------------------------------------------

export type NotificationPrefsResult = { ok: boolean; message: string };

export async function saveClientNotificationPrefs(
  clientId: string,
  prefs: { autoConfirmationText: boolean; autoDeliveryText: boolean },
): Promise<NotificationPrefsResult> {
  await requireAdmin();

  // Coerce hard: a switch that arrives as anything but a boolean must not be
  // able to write `undefined` (Prisma would silently leave the old value) or a
  // truthy string. These columns decide whether a real client gets a real text.
  const next = {
    autoConfirmationText: prefs?.autoConfirmationText === true,
    autoDeliveryText: prefs?.autoDeliveryText === true,
  };

  const before = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, autoConfirmationText: true, autoDeliveryText: true },
  });
  if (!before) return { ok: false, message: "Client not found." };

  await prisma.client.update({ where: { id: clientId }, data: next });

  // Leave a trace of WHO changed it. There is no client-level activity table —
  // the client timeline is built from the activities of that client's projects
  // (see getClientDetail) — so the note is written against their most recent
  // project. Best-effort: a client with no projects yet simply gets no note,
  // and a failed note must never look like a failed save.
  const changes: string[] = [];
  if (before.autoConfirmationText !== next.autoConfirmationText) {
    changes.push(`shoot confirmation texts ${next.autoConfirmationText ? "ON" : "OFF"}`);
  }
  if (before.autoDeliveryText !== next.autoDeliveryText) {
    changes.push(`the feedback ask after delivery ${next.autoDeliveryText ? "ON" : "OFF"}`);
  }
  if (changes.length > 0) {
    const me = await getCurrentUser().catch(() => null);
    const who = me?.realName || me?.name || me?.email || "Someone";
    const project = await prisma.project.findFirst({
      where: { clientId },
      orderBy: [
        { orderedAt: { sort: "desc", nulls: "last" } },
        { shootDate: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: { id: true },
    });
    if (project) {
      await prisma.activity
        .create({
          data: {
            projectId: project.id,
            type: "SYSTEM",
            body: `${who} turned ${changes.join(" and ")} for ${before.name}. Anything switched off is not sent automatically — the reminder stays on Tasks for a person to send by hand.`,
          },
        })
        .catch(() => {});
    }
  }

  revalidatePath(`/clients/${clientId}`);

  if (changes.length === 0) return { ok: true, message: "No change." };
  const both = next.autoConfirmationText && next.autoDeliveryText;
  return {
    ok: true,
    message: both ? "Saved — both texts send automatically." : "Saved. The hub will remind a person instead of texting.",
  };
}

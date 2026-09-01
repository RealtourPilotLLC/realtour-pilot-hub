"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";
import { ActivityType } from "@prisma/client";

// AR follow-up actions for /billing (audit crack #17): $25k of real receivables
// had no in-app way to chase. Draft-then-send, same contract as the rest of the
// hub: the AI produces a TEXT DRAFT, a human reviews it and taps Send — nothing
// here ever auto-sends. /billing is owner/admin (ADMIN has the billing page in
// the access matrix), so these guard with requireAdmin.

export type NudgeDraft = { ok: boolean; text?: string; error?: string };

// The deterministic fallback (and the AI's raw material): every fact — amount,
// street, delivery date, payment link — comes from the order row, never invented.
function nudgeTemplate(p: {
  title: string;
  clientName: string | null;
  balanceAmount: number | null;
  deliveredAt: Date | null;
  paymentUrl: string | null;
  invoiceUrl: string | null;
}): string {
  const first = (p.clientName || "").trim().split(/\s+/)[0] || "there";
  const street = (p.title || "your shoot").split(",")[0].trim();
  const amount = p.balanceAmount != null ? `$${(p.balanceAmount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "a balance";
  const delivered = p.deliveredAt ? ` delivered ${etDate(p.deliveredAt)}` : "";
  const link = p.paymentUrl || p.invoiceUrl;
  return [
    `Hi ${first}! Quick friendly note from RealTour Pilot — the media for ${street}${delivered} still shows ${amount} outstanding on the invoice.`,
    link ? `You can settle it here whenever convenient: ${link}` : `Let us know if you need the invoice re-sent.`,
    `Thanks so much — and shout if anything looks off on our end!`,
  ].join(" ");
}

// Draft a friendly payment-reminder text for one unpaid delivered job.
// DRAFT ONLY — returned for review; the human sends (or copies) it.
export async function draftPaymentNudge(projectId: string): Promise<NudgeDraft> {
  await requireAdmin();
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, balanceAmount: true, deliveredAt: true, paymentUrl: true, invoiceUrl: true,
      client: { select: { name: true } },
    },
  });
  if (!p) return { ok: false, error: "Job not found." };
  if (!p.balanceAmount || p.balanceAmount <= 0) return { ok: false, error: "Nothing outstanding on this job." };

  const template = nudgeTemplate({ ...p, clientName: p.client?.name ?? null });

  // Warm the wording up with the AI when it's connected (same voice as every
  // other draft in the hub); the template already carries the facts, so a polish
  // failure just falls back to it.
  try {
    const { getSecret } = await import("@/lib/integrations/connections");
    if (await getSecret("ai")) {
      const { polishOutbound } = await import("@/lib/integrations/ai");
      const text = await polishOutbound({
        rough: `${template}\n\n(Keep the exact dollar amount and the payment link unchanged — this is a friendly payment reminder, not a dunning letter.)`,
        clientName: p.client?.name ?? null,
        propertyAddress: p.title,
      });
      if (text?.trim()) return { ok: true, text: text.trim() };
    }
  } catch { /* fall back to the template */ }
  return { ok: true, text: template };
}

// Send the reviewed reminder via OpenPhone (human-initiated), log it to the
// timeline + comms memory, and stamp lastNudgedAt so the row shows the chase.
export async function sendPaymentNudge(
  projectId: string,
  body: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = (body || "").trim();
  if (!text) return { ok: false, message: "Nothing to send." };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, clientId: true, client: { select: { name: true, phone: true } } },
  });
  if (!project) return { ok: false, message: "Job not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  let sentId: string | undefined;
  try {
    const res = await OpenPhone.sendMessage(from, `+1${k}`, text);
    sentId = res?.data?.id;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }

  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Payment reminder texted to ${project.client.name}: ${text.slice(0, 200)}` },
  });
  await prisma.commLog
    .create({
      data: {
        channel: "text",
        direction: "out",
        minRole: "ADMIN",
        clientId: project.clientId,
        clientName: project.client.name,
        projectId: project.id,
        contactName: "Us",
        body: text,
        occurredAt: new Date(),
        source: "openphone",
        // Match the OpenPhone webhook's "op-<id>" format so its later echo of
        // this same outbound text dedupes instead of double-logging.
        externalId: sentId ? `op-${sentId}` : null,
      },
    })
    .catch(() => {}); // never let a log write fail the send result

  // Stamp the chase (best-effort until the lastNudgedAt migration lands).
  await prisma.project.update({ where: { id: projectId }, data: { lastNudgedAt: new Date() } }).catch(() => {});

  revalidatePath("/sales");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Reminder sent." };
}

// "Followed up" marker — Kyle chased this one outside the hub (a call, an email,
// in person). Just stamps the row so the list shows when it was last worked.
export async function markBillingNudged(projectId: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  try {
    await prisma.project.update({ where: { id: projectId }, data: { lastNudgedAt: new Date() } });
  } catch {
    return { ok: false, message: "Couldn't save — the follow-up column isn't migrated yet." };
  }
  await prisma.activity
    .create({ data: { projectId, type: "NOTE", body: "Marked as followed up on the outstanding balance (billing)." } })
    .catch(() => {});
  revalidatePath("/sales");
  return { ok: true, message: "Marked followed up." };
}

/**
 * Take a row off the AR list (Jordan, Sep 1: "some are canceled appointments
 * we never completed or were tests"). Deliberately a FLAG, not a delete: the
 * Aryeo sync would re-import a deleted project on the next pass, and the order
 * history still matters for the books. Owner/admin only; reversible.
 */
export async function removeFromAr(projectId: string, note: string): Promise<{ ok: boolean; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, balanceAmount: true } });
  if (!p) return { ok: false, message: "That job no longer exists." };
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  const reason = note.trim().slice(0, 300) || "No reason given";
  await prisma.project.update({
    where: { id: projectId },
    data: { arRemovedAt: new Date(), arRemovedNote: who ? `${reason} — ${who}` : reason },
  });
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.SYSTEM,
      body: `Removed from the unpaid (AR) list${who ? ` by ${who}` : ""}: ${reason}. The outstanding balance on file was $${((p.balanceAmount ?? 0) / 100).toFixed(2)}.`,
    },
  }).catch(() => {});
  revalidatePath("/sales");
  revalidatePath("/billing");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Removed from AR." };
}

/** Undo — put a removed job back on the AR list. */
export async function restoreToAr(projectId: string): Promise<{ ok: boolean; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  await prisma.project.update({ where: { id: projectId }, data: { arRemovedAt: null, arRemovedNote: null } });
  await prisma.activity.create({
    data: { projectId, type: ActivityType.SYSTEM, body: "Put back on the unpaid (AR) list." },
  }).catch(() => {});
  revalidatePath("/sales");
  revalidatePath("/billing");
  return { ok: true, message: "Back on the AR list." };
}

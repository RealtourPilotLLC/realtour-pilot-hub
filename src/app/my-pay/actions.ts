"use server";

import { requireRole } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";

export type FlagResult = { ok: boolean; message: string };

// A photographer flags a pay line (or asks a general period question). Files a
// to-do on Jordan's plate + an owner-only bell notification. One open flag per
// (member, job, period) — a second comment on the same thing appends instead of
// piling up duplicates. Never exposes anyone else's pay: the flag is about the
// CALLER's own line, resolved from their session (not a parameter).
export async function flagPay(input: {
  projectId?: string | null;
  street?: string | null;
  periodStartKey: string;
  comment: string;
}): Promise<FlagResult> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]); // blocks "view as"
  const comment = (input.comment ?? "").trim();
  if (!comment) return { ok: false, message: "Write a quick note first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStartKey)) return { ok: false, message: "Bad period." };

  const me = await getCurrentUser().catch(() => null);
  const memberId = me?.teamMemberId ?? null;
  if (!memberId) return { ok: false, message: "Your account isn't linked to a team member yet — ask Jordan." };
  const member = await prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true } });
  const first = (member?.name ?? "A photographer").split(" ")[0];
  const about = input.street?.trim() || `the ${input.periodStartKey} pay period`;

  const dedupeKey = `payflag-${memberId}-${input.projectId ?? "period"}-${input.periodStartKey}`;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey } });
  if (existing) {
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        completedAt: null,
        description: [existing.description, `Update: ${comment}`].filter(Boolean).join("\n\n").slice(0, 2000),
      },
    });
  } else {
    await prisma.smartTask.create({
      data: {
        taskType: "todo",
        title: `Pay question — ${first} · ${about.split(",")[0]}`.slice(0, 120),
        summary: `${first} flagged their pay for ${about.split(",")[0]}: “${comment.slice(0, 220)}”. Review it on Payouts and reply to them.`.slice(0, 500),
        description: comment.slice(0, 2000),
        reasonCreated: "Photographer flagged a pay line on My Pay",
        source: "team",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 24 * 3600_000),
        assignedKey: "jordan", // pay is the owner's domain
        projectId: input.projectId ?? null,
        dedupeKey,
      },
    });
  }

  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "system",
      title: `Pay question — ${first} · ${about.split(",")[0]}`,
      body: comment,
      href: "/payouts",
      targets: [{ roles: ["OWNER"] }],
    });
  } catch { /* bell is best-effort */ }

  revalidatePath("/my-pay");
  return { ok: true, message: "Sent to Jordan — he'll take a look." };
}

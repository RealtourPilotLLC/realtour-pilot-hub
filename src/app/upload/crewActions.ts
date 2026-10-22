"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { requireCreativeLead } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// SECOND SHOOTER (Oct 21 2026). The owner, the office and the creative
// manager add a photographer to a shoot they worked on with someone else, so
// that person can open the job's upload page too. Upload access only: see
// lib/shoot (crew never counts for pay, KPIs, scorecards or notifications).
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };

const ID = /^[a-z0-9]{10,40}$/i;

export async function addShootCrew(projectId: string, memberId: string): Promise<Result> {
  try {
    await requireCreativeLead();
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Only the office can add someone to a shoot." };
  }
  if (!ID.test(projectId ?? "") || !ID.test(memberId ?? "")) return { ok: false, message: "Pick a photographer first." };
  const [project, member] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, photographerId: true } }),
    prisma.teamMember.findUnique({ where: { id: memberId }, select: { id: true, name: true, active: true, role: true } }),
  ]);
  if (!project) return { ok: false, message: "That shoot no longer exists." };
  if (!member || !member.active) return { ok: false, message: "That photographer isn't on the active team." };
  if (project.photographerId === member.id) return { ok: false, message: `${member.name} is already this shoot's photographer.` };
  const me = await getCurrentUser().catch(() => null);
  await prisma.projectCrew.upsert({
    where: { projectId_memberId: { projectId, memberId } },
    create: { projectId, memberId, addedBy: me?.email ?? null },
    update: {},
  });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath("/upload");
  return { ok: true, message: `${member.name} can now open this upload page.` };
}

export async function removeShootCrew(projectId: string, memberId: string): Promise<Result> {
  try {
    await requireCreativeLead();
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Only the office can change a shoot's crew." };
  }
  if (!ID.test(projectId ?? "") || !ID.test(memberId ?? "")) return { ok: false, message: "That crew member could not be found." };
  await prisma.projectCrew.deleteMany({ where: { projectId, memberId } });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath("/upload");
  return { ok: true, message: "Removed from this shoot." };
}

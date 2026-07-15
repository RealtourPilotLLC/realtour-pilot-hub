"use server";

import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";

// The @mention roster for note/comment composers — names only, no contact
// info. Any signed-in staff member may tag any active teammate.
export type MentionPerson = { id: string; name: string };

export async function listMentionablePeople(): Promise<MentionPerson[]> {
  try {
    await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  } catch {
    return [];
  }
  return prisma.teamMember.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

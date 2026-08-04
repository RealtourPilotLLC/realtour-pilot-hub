"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// Owner toggles a savings-plan item DONE / PENDING / SKIPPED on the Overview.
export async function setSavingsStatusAction(id: string, status: "PENDING" | "DONE" | "SKIPPED") {
  await requireOwner();
  await prisma.savingsItem.update({
    where: { id },
    data: { status, doneAt: status === "DONE" ? new Date() : null },
  });
  revalidatePath("/sales");
}

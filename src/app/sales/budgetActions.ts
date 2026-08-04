"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// Owner-only budget target edits (the Advisor writes via its set_budget tool;
// these are for the inline inputs on the Budget tab).

export async function saveBudgetTargetAction(category: string, monthlyTarget: number) {
  await requireOwner();
  const cat = category.trim().slice(0, 60);
  if (!cat || !Number.isFinite(monthlyTarget) || monthlyTarget < 0 || monthlyTarget > 100000) throw new Error("Bad target");
  await prisma.budgetTarget.upsert({
    where: { category: cat },
    create: { category: cat, monthlyTarget },
    update: { monthlyTarget },
  });
  revalidatePath("/sales");
}

export async function removeBudgetTargetAction(category: string) {
  await requireOwner();
  await prisma.budgetTarget.deleteMany({ where: { category: category.trim().slice(0, 60) } });
  revalidatePath("/sales");
}

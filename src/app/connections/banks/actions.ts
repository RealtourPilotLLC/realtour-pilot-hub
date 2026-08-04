"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import {
  savePlaidCreds,
  createLinkToken,
  exchangePublicToken,
  syncAllPlaid,
  backfillAllPlaid,
  removePlaidItem,
  type PlaidEnv,
} from "@/lib/integrations/plaid";
import { prisma } from "@/lib/prisma";

// Owner-only server actions behind the Plaid connect screen. The bank login is
// entered inside Plaid Link (never here); these only move the tokens Plaid hands
// back, server-side. requireOwner() fails closed in production.

export async function savePlaidCredsAction(clientId: string, secret: string, env: PlaidEnv) {
  await requireOwner();
  const id = clientId.trim();
  const sec = secret.trim();
  if (!id || !sec) throw new Error("Both the client ID and secret are required.");
  await savePlaidCreds(id, sec, env === "sandbox" ? "sandbox" : "production");
  revalidatePath("/connections/banks");
}

export async function getPlaidLinkToken(): Promise<string> {
  await requireOwner();
  const u = await getCurrentUser();
  return createLinkToken(u?.id ?? "owner");
}

export async function exchangePlaidPublicToken(publicToken: string) {
  await requireOwner();
  await exchangePublicToken(publicToken);
  revalidatePath("/connections/banks");
}

export async function syncPlaidNow() {
  await requireOwner();
  const r = await syncAllPlaid();
  revalidatePath("/connections/banks");
  return r;
}

export async function backfillPlaidNow() {
  await requireOwner();
  const r = await backfillAllPlaid();
  revalidatePath("/connections/banks");
  return r;
}

export async function disconnectPlaidBank(itemDbId: string) {
  await requireOwner();
  await removePlaidItem(itemDbId);
  revalidatePath("/connections/banks");
}

// Owner tags each connected account as BUSINESS or PERSONAL so the finance
// engine can separate true business cost from owner draws.
export async function tagPlaidAccount(accountDbId: string, isBusiness: boolean | null) {
  await requireOwner();
  await prisma.plaidAccount.update({ where: { id: accountDbId }, data: { isBusiness } });
  revalidatePath("/connections/banks");
}

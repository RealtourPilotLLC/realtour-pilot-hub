"use server";

import { revalidatePath } from "next/cache";
import { authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { cancelCapacityException, recordCapacityException, type CapacityActor, type CapacityInput } from "@/lib/capacity";

// ---------------------------------------------------------------------------
// §10 capacity (Sep 26 2026): record and cancel a CapacityException. The
// permission rule lives in lib/capacity.mayRecordCapacity — owner and office
// for anyone; an editor only their own "offline" or "blocked" — and is checked
// against the REAL login (never "view as"). Nothing here reassigns work, moves
// a date or touches pay; it writes one row and says so.
// ---------------------------------------------------------------------------

async function actor(): Promise<CapacityActor> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return null;
  return { name: me.realName ?? me.name ?? me.email, realRole: me.realRole, teamMemberId: me.teamMemberId, impersonating: me.impersonating };
}

function refresh() {
  for (const path of ["/people/capacity", "/editing"]) revalidatePath(path);
}

export async function recordCapacityExceptionAction(input: CapacityInput): Promise<{ ok: boolean; message: string }> {
  const r = await recordCapacityException(input, await actor(), { authEnforced: authEnforced() });
  if (r.ok) refresh();
  return { ok: r.ok, message: r.message };
}

export async function cancelCapacityExceptionAction(id: string): Promise<{ ok: boolean; message: string }> {
  const r = await cancelCapacityException(id, await actor(), { authEnforced: authEnforced() });
  if (r.ok) refresh();
  return r;
}

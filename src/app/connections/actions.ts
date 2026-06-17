"use server";

import { revalidatePath } from "next/cache";
import { saveSecret, disconnect as disconnectConn } from "@/lib/integrations/connections";
import {
  testAryeoKey,
  syncAryeoOrders,
  syncAryeoProducts,
  syncAryeoTeam,
  syncAryeoAppointments,
} from "@/lib/integrations/aryeo";

export type ActionResult = { ok: boolean; message: string };

export async function connectAryeo(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const key = String(formData.get("key") || "").trim();
  if (!key) return { ok: false, message: "Please paste your Aryeo API key." };

  const test = await testAryeoKey(key);
  if (!test.ok) {
    return { ok: false, message: `Couldn't connect: ${test.error}` };
  }

  await saveSecret("aryeo", key, { accountLabel: test.label });
  revalidatePath("/connections");
  return { ok: true, message: "Aryeo connected. Run a sync to import your orders." };
}

export async function syncAryeoNow(): Promise<ActionResult> {
  try {
    await syncAryeoTeam();
    const r = await syncAryeoOrders();
    const appt = await syncAryeoAppointments();
    revalidatePath("/connections");
    revalidatePath("/pipeline");
    revalidatePath("/schedule");
    revalidatePath("/");
    return {
      ok: true,
      message:
        r.imported === 0
          ? `Up to date — ${appt.photographerAssigned} shoots assigned from ${appt.appointments} appointments.`
          : `Synced — ${r.imported} new project${r.imported === 1 ? "" : "s"}, ${r.clients} client${r.clients === 1 ? "" : "s"}, ${appt.photographerAssigned} photographers assigned.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Sync failed." };
  }
}

export async function syncAryeoProductsNow(): Promise<ActionResult> {
  try {
    const r = await syncAryeoProducts();
    revalidatePath("/connections");
    revalidatePath("/catalog");
    return { ok: true, message: `Synced ${r.products} products from Aryeo.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Product sync failed." };
  }
}

export async function disconnectProvider(provider: string): Promise<ActionResult> {
  await disconnectConn(provider);
  revalidatePath("/connections");
  return { ok: true, message: "Disconnected." };
}

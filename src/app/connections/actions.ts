"use server";

import { revalidatePath } from "next/cache";
import { saveSecret, disconnect as disconnectConn } from "@/lib/integrations/connections";
import { testAryeoKey, syncAryeoOrders } from "@/lib/integrations/aryeo";

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
    const r = await syncAryeoOrders();
    revalidatePath("/connections");
    revalidatePath("/pipeline");
    revalidatePath("/");
    return {
      ok: true,
      message:
        r.imported === 0
          ? "Already up to date — no new orders from Aryeo."
          : `Synced — ${r.imported} new project${r.imported === 1 ? "" : "s"} and ${r.clients} new client${r.clients === 1 ? "" : "s"} imported.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Sync failed." };
  }
}

export async function disconnectProvider(provider: string): Promise<ActionResult> {
  await disconnectConn(provider);
  revalidatePath("/connections");
  return { ok: true, message: "Disconnected." };
}

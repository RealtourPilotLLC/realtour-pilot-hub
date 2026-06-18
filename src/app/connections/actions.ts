"use server";

import { revalidatePath } from "next/cache";
import { saveSecret, disconnect as disconnectConn } from "@/lib/integrations/connections";
import { testOpenPhoneKey, registerOpenPhoneWebhooks } from "@/lib/integrations/openphone";
import { exchangeDropboxCode, testDropboxRefreshToken } from "@/lib/integrations/dropbox";
import { testSlackKey } from "@/lib/integrations/slack";
import { generateTasksForActiveProjects } from "@/lib/tasks";
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
    await generateTasksForActiveProjects();
    revalidatePath("/connections");
    revalidatePath("/pipeline");
    revalidatePath("/schedule");
    revalidatePath("/queue");
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

// Generic API-key connect for any provider with a tester. Reads `provider`
// + `key` from the form so it can back a useActionState form directly.
const TESTERS: Record<string, (key: string) => Promise<{ ok: true; label: string } | { ok: false; error: string }>> = {
  aryeo: testAryeoKey,
  openphone: testOpenPhoneKey,
  slack: testSlackKey,
};

// Dropbox: exchange the one-time authorization code for a refresh token, verify,
// and store it encrypted.
export async function connectDropbox(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const code = String(formData.get("code") || "").trim();
  if (!code) return { ok: false, message: "Paste the authorization code from Dropbox." };
  try {
    const { refreshToken } = await exchangeDropboxCode(code);
    const test = await testDropboxRefreshToken(refreshToken);
    if (!test.ok) return { ok: false, message: `Couldn't verify: ${test.error}` };
    await saveSecret("dropbox", refreshToken, { accountLabel: test.label });
    revalidatePath("/connections");
    return { ok: true, message: `Connected — ${test.label}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Dropbox connection failed." };
  }
}

export async function connectApiKey(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const provider = String(formData.get("provider") || "");
  const key = String(formData.get("key") || "").trim();
  if (!provider) return { ok: false, message: "Missing provider." };
  if (!key) return { ok: false, message: "Please paste your API key." };

  const tester = TESTERS[provider];
  if (tester) {
    const test = await tester(key);
    if (!test.ok) return { ok: false, message: `Couldn't connect: ${test.error}` };
    await saveSecret(provider, key, { accountLabel: test.label });
  } else {
    await saveSecret(provider, key);
  }
  revalidatePath("/connections");
  return { ok: true, message: "Connected." };
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

export async function syncDropboxFoldersNow(): Promise<ActionResult> {
  try {
    const { syncDropboxFolderStatus } = await import("@/lib/dropboxFolders");
    const r = await syncDropboxFolderStatus();
    revalidatePath("/pipeline");
    revalidatePath("/queue");
    return {
      ok: true,
      message: `Checked ${r.checked} projects — ${r.movedToShot} → Shot, ${r.movedToReview} → Review.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Folder check failed." };
  }
}

export async function enableOpenPhoneRealtime(): Promise<ActionResult> {
  const base = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!base) return { ok: false, message: "Deploy the app first — webhooks need a public URL." };
  try {
    await registerOpenPhoneWebhooks(`${base}/api/webhooks/openphone`);
    return { ok: true, message: "Real-time enabled — new texts & calls will log automatically." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not register webhooks." };
  }
}

export async function disconnectProvider(provider: string): Promise<ActionResult> {
  await disconnectConn(provider);
  revalidatePath("/connections");
  return { ok: true, message: "Disconnected." };
}

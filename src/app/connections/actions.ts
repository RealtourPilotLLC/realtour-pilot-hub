"use server";

import { requireOwner } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { saveSecret, disconnect as disconnectConn } from "@/lib/integrations/connections";
import { testOpenPhoneKey, registerOpenPhoneWebhooks } from "@/lib/integrations/openphone";
import { exchangeDropboxCode, testDropboxRefreshToken } from "@/lib/integrations/dropbox";
import { testSlackKey, testSlackUserKey } from "@/lib/integrations/slack";
import { testAiKey } from "@/lib/integrations/ai";
import { syncGmail } from "@/lib/integrations/google";
import { generateTasksForActiveProjects } from "@/lib/tasks";
import { syncProjectStatuses } from "@/lib/projectStatus";
import {
  testAryeoKey,
  syncAryeoOrders,
  syncAryeoProducts,
  syncAryeoTeam,
  syncAryeoAppointments,
  syncAryeoCustomers,
} from "@/lib/integrations/aryeo";

export type ActionResult = { ok: boolean; message: string };

export async function connectAryeo(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireOwner();
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
  await requireOwner();
  try {
    await syncAryeoTeam();
    const r = await syncAryeoOrders();
    const appt = await syncAryeoAppointments();
    // Backfill client license #, brokerage, notes from /customer-users.
    await syncAryeoCustomers();
    // Re-evaluate true status by cross-checking Aryeo media (+ Dropbox).
    await syncProjectStatuses();
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
  slack_user: testSlackUserKey,
  ai: testAiKey,
};

export async function syncGmailNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const r = await syncGmail();
    revalidatePath("/");
    revalidatePath("/queue");
    revalidatePath("/communications");
    return { ok: true, message: `Scanned ${r.scanned} recent emails — ${r.tasks} new task${r.tasks === 1 ? "" : "s"}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Gmail sync failed." };
  }
}

// Dropbox: exchange the one-time authorization code for a refresh token, verify,
// and store it encrypted.
export async function connectDropbox(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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

export async function recheckStatusesNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const r = await syncProjectStatuses();
    await generateTasksForActiveProjects();
    revalidatePath("/pipeline");
    revalidatePath("/queue");
    revalidatePath("/");
    const partials = r.partials > 0 ? ` ${r.partials} partial deliver${r.partials === 1 ? "y" : "ies"} flagged.` : "";
    return {
      ok: true,
      message: `Re-checked ${r.checked} projects — ${r.changed} status${r.changed === 1 ? "" : "es"} updated.${partials}`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Status re-check failed." };
  }
}

export async function enableOpenPhoneRealtime(): Promise<ActionResult> {
  await requireOwner();
  const base = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!base) return { ok: false, message: "Deploy the app first — webhooks need a public URL." };
  try {
    const r = await registerOpenPhoneWebhooks(`${base}/api/webhooks/openphone`);
    return {
      ok: true,
      message: r.transcripts
        ? "Real-time enabled — texts, calls & call transcripts will log automatically."
        : "Real-time enabled for texts & calls (transcripts not available on this plan).",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not register webhooks." };
  }
}

export async function syncOpenPhoneContactsNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const { syncOpenPhoneContacts } = await import("@/lib/contacts");
    const r = await syncOpenPhoneContacts();
    revalidatePath("/communications");
    revalidatePath("/clients");
    return {
      ok: true,
      message: `Synced ${r.contacts} contacts — ${r.matchedToClients} matched, reaching ${r.clientsReached} clients.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Contact sync failed." };
  }
}

export async function disconnectProvider(provider: string): Promise<ActionResult> {
  await requireOwner();
  await disconnectConn(provider);
  revalidatePath("/connections");
  return { ok: true, message: "Disconnected." };
}

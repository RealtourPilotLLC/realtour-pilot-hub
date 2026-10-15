"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { saveSecret, disconnect as disconnectConn, markError } from "@/lib/integrations/connections";
import { ARYEO_WEB_PROVIDER, aryeoWebCredentials, forgetAryeoWebSession, testAryeoWebLogin } from "@/lib/integrations/aryeoWeb";

// ---------------------------------------------------------------------------
// Connections → Aryeo hub login (Oct 14 2026). The hub's own Aryeo team
// member, used to put the 06-Ready-for-Aryeo photos on a listing and deliver
// it (photoDelivery/aryeoPush.ts). Owner only. The login is TESTED first (sign
// in + open one listing page, which changes nothing); a login Aryeo refuses is
// not saved. The password is encrypted and never shown again; the email is
// kept in the connection's metadata.
// ---------------------------------------------------------------------------

export type AryeoWebActionResult = { ok: boolean; message: string };

export async function saveAryeoWebLogin(_prev: AryeoWebActionResult | null, formData: FormData): Promise<AryeoWebActionResult> {
  await requireOwner();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  if (!email.includes("@") || !password) return { ok: false, message: "Both the email and the password of the hub's Aryeo login are needed." };
  if (email.length > 200 || password.length > 300) return { ok: false, message: "That doesn't look like an Aryeo login. Check both values." };
  await forgetAryeoWebSession();
  const test = await testAryeoWebLogin({ email, password });
  if (!test.ok) return { ok: false, message: `Not saved. ${test.error}` };
  const me = await getCurrentUser().catch(() => null);
  await saveSecret(ARYEO_WEB_PROVIDER, password, { accountLabel: email, metadata: { email, connectedBy: me?.email ?? null, connectedAt: new Date().toISOString() } });
  revalidatePath("/connections");
  revalidatePath("/ops/photo-delivery/settings");
  return { ok: true, message: `${test.label}. Saved. Choose how far the hub goes in Photo Delivery → Settings (it starts Off).` };
}

export async function retestAryeoWebLogin(): Promise<AryeoWebActionResult> {
  await requireOwner();
  const creds = await aryeoWebCredentials();
  if (!creds) return { ok: false, message: "No Aryeo hub login is saved." };
  await forgetAryeoWebSession();
  const test = await testAryeoWebLogin(creds);
  if (!test.ok) {
    await markError(ARYEO_WEB_PROVIDER, test.error).catch(() => {});
    revalidatePath("/connections");
    return { ok: false, message: test.error };
  }
  revalidatePath("/connections");
  return { ok: true, message: `${test.label}. Checking changes nothing in Aryeo.` };
}

export async function disconnectAryeoWebLogin(): Promise<AryeoWebActionResult> {
  await requireOwner();
  await forgetAryeoWebSession();
  await disconnectConn(ARYEO_WEB_PROVIDER);
  revalidatePath("/connections");
  return { ok: true, message: "The hub's Aryeo login is removed. The hub stops uploading and delivering; Kyle does it by hand." };
}

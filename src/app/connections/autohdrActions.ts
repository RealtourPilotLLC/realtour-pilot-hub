"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { saveSecret, disconnect as disconnectConn, markError } from "@/lib/integrations/connections";
import { AUTOHDR_PROVIDER, autohdrCredentials, testAutohdrCredentials } from "@/lib/integrations/autohdr";

// ---------------------------------------------------------------------------
// Connections → AutoHDR (Jordan, Oct 13 2026: "Set up the API on AutoHDR for
// me"). The API client is created in AutoHDR (Account settings → Developer)
// and pasted here by the owner. The pair is tested FIRST (sign in + read the
// credit balance, which spends nothing); a pair AutoHDR rejects is not saved.
// The secret is encrypted and never echoed back; the client id is kept in the
// connection's metadata because it is not a secret and the card shows a hint.
// ---------------------------------------------------------------------------

export type AutohdrActionResult = { ok: boolean; message: string };

export async function saveAutohdrCredentials(_prev: AutohdrActionResult | null, formData: FormData): Promise<AutohdrActionResult> {
  await requireOwner();
  const clientId = String(formData.get("clientId") || "").trim();
  const clientSecret = String(formData.get("clientSecret") || "").trim();
  if (!clientId || !clientSecret) return { ok: false, message: "Both the Client ID and the Client Secret are needed." };
  if (clientId.length > 200 || clientSecret.length > 500) return { ok: false, message: "That doesn't look like an AutoHDR API client. Copy both values again." };
  const test = await testAutohdrCredentials({ clientId, clientSecret });
  if (!test.ok) return { ok: false, message: `Not saved. ${test.error}` };
  const me = await getCurrentUser().catch(() => null);
  await saveSecret(AUTOHDR_PROVIDER, clientSecret, {
    accountLabel: test.label,
    metadata: { clientId, connectedBy: me?.email ?? null, connectedAt: new Date().toISOString() },
  });
  // First balance reading straight away, so the chip and the alerts have a number.
  try {
    const { recordCreditSnapshot } = await import("@/lib/photoDelivery/credits");
    await recordCreditSnapshot({ trigger: "connect" });
  } catch (e) {
    console.warn("autohdr: first snapshot failed", (e as Error).message);
  }
  revalidatePath("/connections");
  revalidatePath("/ops/photo-delivery/credits");
  revalidatePath("/ops/photo-delivery");
  return {
    ok: true,
    message: `${test.label}. Connected: the hub now reads the credit balance every 15 minutes and alerts you and Kyle below 250 and below 100. Nothing spends credits without a click.`,
  };
}

export async function retestAutohdr(): Promise<AutohdrActionResult> {
  await requireOwner();
  const creds = await autohdrCredentials();
  if (!creds) return { ok: false, message: "AutoHDR has no API client saved." };
  const test = await testAutohdrCredentials(creds);
  if (!test.ok) {
    if (creds.source === "connection") await markError(AUTOHDR_PROVIDER, test.error).catch(() => {});
    revalidatePath("/connections");
    return { ok: false, message: test.error };
  }
  try {
    const { recordCreditSnapshot } = await import("@/lib/photoDelivery/credits");
    await recordCreditSnapshot({ trigger: "manual" });
  } catch (e) {
    console.warn("autohdr: snapshot failed", (e as Error).message);
  }
  revalidatePath("/connections");
  revalidatePath("/ops/photo-delivery/credits");
  return { ok: true, message: `${test.label}. Checking costs nothing.` };
}

export async function disconnectAutohdr(): Promise<AutohdrActionResult> {
  await requireOwner();
  await disconnectConn(AUTOHDR_PROVIDER);
  revalidatePath("/connections");
  revalidatePath("/ops/photo-delivery/credits");
  const still = await autohdrCredentials().catch(() => null);
  if (still?.source === "env") {
    return { ok: true, message: "Removed from this card, but AUTOHDR_CLIENT_ID and AUTOHDR_CLIENT_SECRET are still set in the deployment's environment, so the hub stays connected until those are removed in Vercel." };
  }
  return { ok: true, message: "AutoHDR API client removed. The hub stops reading the balance; editing through the Dropbox folders is not affected." };
}

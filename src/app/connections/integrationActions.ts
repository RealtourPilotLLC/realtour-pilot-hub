"use server";

import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { appBase } from "@/lib/appUrl";
import { saveSecret, getSecret, disconnect as disconnectConn, markError } from "@/lib/integrations/connections";
import {
  isTranscriptionProviderId,
  testTranscriptionKey,
  TRANSCRIPTION_CONNECTION_KEY,
  TRANSCRIPTION_LABEL,
  type TranscriptionProviderId,
} from "@/lib/integrations/transcription";
import * as ig from "@/lib/integrations/instagram";
import { connectPublishingAccounts, disconnectPublishingAccount } from "@/lib/publishing";

// ---------------------------------------------------------------------------
// Server actions for the two Connections cards added on Sep 16 2026:
// TranscriptionCard (speech-to-text keys, spec §9) and InstagramCard (Meta app
// credentials + the account connect flow, spec §12). Owner-only, like every
// other credential action on this page. Keys go through saveSecret (encrypted)
// and are never echoed back — the result messages below carry a label, never
// the value.
// ---------------------------------------------------------------------------

export type IntegrationActionResult = { ok: boolean; message: string };

// ---- Speech-to-text --------------------------------------------------------------

/**
 * Paste-a-key for one provider. The key is tested against the provider's
 * cheapest authenticated call first; a key that fails is NOT stored. Saving a
 * key is allowed tonight: it only makes configured() true. The cut_transcripts
 * switch stays OFF (no ProgramAutomation row exists), so nothing transcribes.
 */
export async function saveTranscriptionKey(_prev: IntegrationActionResult | null, formData: FormData): Promise<IntegrationActionResult> {
  await requireOwner();
  const provider = String(formData.get("provider") || "");
  const key = String(formData.get("key") || "").trim();
  if (!isTranscriptionProviderId(provider)) return { ok: false, message: "Pick a provider first." };
  if (!key) return { ok: false, message: `Paste the ${TRANSCRIPTION_LABEL[provider]} API key.` };
  const test = await testTranscriptionKey(provider, key);
  if (!test.ok) return { ok: false, message: `Not saved — ${test.error}` };
  await saveSecret(TRANSCRIPTION_CONNECTION_KEY[provider], key, { accountLabel: test.label });
  revalidatePath("/connections");
  return {
    ok: true,
    message: `${TRANSCRIPTION_LABEL[provider]} key saved (encrypted). Cut transcripts are still switched OFF — nothing transcribes until the switch is turned on.`,
  };
}

/** Re-test the STORED key. Same cheap call; transcribes nothing. */
export async function testTranscriptionNow(provider: TranscriptionProviderId): Promise<IntegrationActionResult> {
  await requireOwner();
  if (!isTranscriptionProviderId(provider)) return { ok: false, message: "Unknown provider." };
  const key = await getSecret(TRANSCRIPTION_CONNECTION_KEY[provider]);
  if (!key) return { ok: false, message: `${TRANSCRIPTION_LABEL[provider]} has no key saved.` };
  const test = await testTranscriptionKey(provider, key);
  if (!test.ok) {
    await markError(TRANSCRIPTION_CONNECTION_KEY[provider], test.error).catch(() => {});
    revalidatePath("/connections");
    return { ok: false, message: test.error };
  }
  await saveSecret(TRANSCRIPTION_CONNECTION_KEY[provider], key, { accountLabel: test.label });
  revalidatePath("/connections");
  return { ok: true, message: `${test.label}. Checking costs nothing and transcribes nothing.` };
}

export async function disconnectTranscription(provider: TranscriptionProviderId): Promise<IntegrationActionResult> {
  await requireOwner();
  if (!isTranscriptionProviderId(provider)) return { ok: false, message: "Unknown provider." };
  await disconnectConn(TRANSCRIPTION_CONNECTION_KEY[provider]);
  revalidatePath("/connections");
  return { ok: true, message: `${TRANSCRIPTION_LABEL[provider]} key removed.` };
}

// ---- Meta app credentials ---------------------------------------------------------

/**
 * App ID + App Secret from developers.facebook.com. Verified by minting an app
 * token (client_credentials) — the cheapest call a Meta app can make, touching
 * no user or account — and stored only if that succeeds. This is the ONLY thing
 * that makes instagram.configured() true.
 */
export async function saveMetaApp(_prev: IntegrationActionResult | null, formData: FormData): Promise<IntegrationActionResult> {
  await requireOwner();
  const appId = String(formData.get("appId") || "").trim();
  const appSecret = String(formData.get("appSecret") || "").trim();
  if (!appId || !appSecret) return { ok: false, message: "Both the App ID and the App Secret are needed." };
  const test = await ig.testMetaAppCredentials(appId, appSecret);
  if (!test.ok) return { ok: false, message: `Not saved — ${test.error}` };
  await saveSecret(ig.META_CONNECTION, appSecret, { accountLabel: test.label, metadata: { appId } });
  revalidatePath("/connections");
  return { ok: true, message: `${test.label} saved (secret encrypted). Accounts can now be connected; publishing itself stays switched OFF until you turn it on.` };
}

export async function clearMetaApp(): Promise<IntegrationActionResult> {
  await requireOwner();
  await disconnectConn(ig.META_CONNECTION);
  revalidatePath("/connections");
  // The Connection row is one of two sources: META_APP_ID/META_APP_SECRET in
  // the deployment's env is the other, and clearing the row does not touch it.
  // Say so, or "removed" would be a lie while configured() stays true.
  const remaining = await ig.metaAppCredentials();
  if (remaining?.source === "env") {
    return { ok: true, message: `Credentials saved on this card removed — but META_APP_ID/META_APP_SECRET are still set in the deployment's environment (app ${remaining.appId}), so Instagram stays configured until those are removed from Vercel.` };
  }
  return { ok: true, message: "Meta app credentials removed. Connected accounts keep their rows but cannot publish until credentials are back." };
}

// ---- Instagram account connect (OAuth) ----------------------------------------------

const META_STATE_COOKIE = "rtp_meta_state";

/**
 * Step 1 of the real connect flow, only reachable once configured(): plant the
 * one-shot anti-forgery cookie (carrying which client the account is for) and
 * hand back the Facebook Login URL. The redirect lands back on /connections
 * with ?code&state, which the card turns into completeInstagramConnect().
 */
export async function beginInstagramConnect(enrollmentId: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await requireOwner();
  if (!enrollmentId) return { ok: false, message: "Choose which client this Instagram account belongs to." };
  if (!(await ig.configured())) return { ok: false, message: "Instagram is not configured — save the Meta App ID and Secret first." };
  const state = randomUUID();
  const jar = await cookies();
  jar.set(META_STATE_COOKIE, `${state}.${enrollmentId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 1800, // 30 min, the same window the Gmail round trip needed
  });
  const url = await ig.authorizeUrl({ state, redirectUri: instagramRedirectUri() });
  if (!url.ok) return { ok: false, message: url.message };
  return { ok: true, url: url.value };
}

/** The registered redirect URI — must match what is entered on the Meta app's "Valid OAuth Redirect URIs". */
function instagramRedirectUri(): string {
  return `${appBase()}/connections`;
}

export async function completeInstagramConnect(code: string, state: string): Promise<IntegrationActionResult> {
  await requireOwner();
  const jar = await cookies();
  const raw = jar.get(META_STATE_COOKIE)?.value ?? "";
  jar.delete(META_STATE_COOKIE); // one-shot, on every outcome
  const dot = raw.indexOf(".");
  const expected = dot > 0 ? raw.slice(0, dot) : "";
  const enrollmentId = dot > 0 ? raw.slice(dot + 1) : "";
  if (!code || !state || !expected || state !== expected || !enrollmentId) {
    return { ok: false, message: "That connect attempt expired or didn't start here — press Connect again." };
  }
  const token = await ig.exchangeCode({ code, redirectUri: instagramRedirectUri() });
  if (!token.ok) return { ok: false, message: token.message };
  const accounts = await ig.listInstagramAccounts(token.value.accessToken);
  if (!accounts.ok) return { ok: false, message: accounts.message };
  const me = await getCurrentUser().catch(() => null);
  const saved = await connectPublishingAccounts({ enrollmentId, token: token.value, accounts: accounts.value, by: { staffUserId: me?.id ?? null } });
  if (!saved.ok) return { ok: false, message: saved.message };
  revalidatePath("/connections");
  const handles = accounts.value.map((a) => (a.username ? `@${a.username}` : a.igUserId)).join(", ");
  return { ok: true, message: `Connected ${handles}. Publishing stays switched OFF until you turn it on.` };
}

export async function disconnectInstagramAccount(accountId: string, revoke: boolean): Promise<IntegrationActionResult> {
  await requireOwner();
  const me = await getCurrentUser().catch(() => null);
  try {
    const r = await disconnectPublishingAccount(accountId, me?.email ?? null, { revoke });
    revalidatePath("/connections");
    const stopped = r.cancelled ? ` ${r.cancelled} queued post${r.cancelled === 1 ? "" : "s"} cancelled.` : "";
    const rv = revoke ? (r.revoked ? " Access revoked at Meta." : " Meta could not be reached to revoke; the token is gone here either way.") : "";
    return { ok: true, message: `Disconnected.${stopped}${rv}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't disconnect." };
  }
}

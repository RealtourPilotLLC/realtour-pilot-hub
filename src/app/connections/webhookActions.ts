"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import {
  setWebhookEnforced,
  testSecretAgainstLastRejection,
  dismissWebhookEvent,
  retryWebhookEventNow,
  ENFORCE_TOGGLEABLE,
  laneName,
} from "@/lib/webhookRetry";

// ---------------------------------------------------------------------------
// RTP-28 (Sep 16 2026). The office half of the webhook health strip. Kept in
// its own file rather than piled into connections/actions.ts: these four are
// the incident controls, and they should be findable as a set.
//
// Every one of them is owner-gated, and NONE of them calls a provider's API.
// "Test a secret" in particular proves a candidate against a payload we already
// hold — the Sep 8 cutover failed because a secret was saved and then believed.
// ---------------------------------------------------------------------------

export type ActionResult = { ok: boolean; message: string };

/** What it actually costs if turning verification on bounces real events — per
 *  provider, because the safety nets are NOT the same. Aryeo's hourly reconcile
 *  backfills the orders it missed; OpenPhone has no backfill at all, so a text
 *  refused while the token is wrong is simply gone. Reassuring the office with
 *  Aryeo's net while they flip OpenPhone would be the Sep 8 mistake wearing a
 *  different hat (RTP-28 review, Sep 16). */
const IF_IT_BOUNCES: Record<string, string> = {
  aryeo: "If real events start bouncing, switch it back — the hourly sync still covers Aryeo.",
  openphone:
    "If real events start bouncing, switch it back fast: nothing backfills texts and calls, so anything OpenPhone sends while it is refusing is lost for good.",
  scripting:
    "If real events start bouncing, switch it back — until you do, script and hook changes will only appear when someone opens the job.",
};

/** Flip one receiver between "accept posts it can't verify" (its behaviour to
 *  date) and "refuse them". Deliberately per-provider: a single global switch is
 *  how one misconfigured lane takes the others down with it. */
export async function setWebhookVerification(provider: string, enforce: boolean): Promise<ActionResult> {
  await requireOwner();
  if (!ENFORCE_TOGGLEABLE.includes(provider)) {
    return { ok: false, message: `${laneName(provider)} has no switch here — it already refuses anything it can't verify.` };
  }
  const who = await getCurrentUser().catch(() => null);
  await setWebhookEnforced(provider, enforce, who?.email ?? null);
  revalidatePath("/connections");
  return {
    ok: true,
    message: enforce
      ? `${laneName(provider)} will now refuse any post it can't verify, and record each refusal here. Takes effect within a minute. ${IF_IT_BOUNCES[provider] ?? "If real events start bouncing, switch it back."}`
      : `${laneName(provider)} is back to accepting posts it can't verify, and every one of those is stamped “unsigned” on its row. Takes effect within a minute.`,
  };
}

/** Does this candidate secret match the signature on a post we already refused?
 *  No request to the provider, nothing saved, and the candidate is never echoed
 *  back — it exists only for the length of this call. */
export async function testWebhookSecret(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireOwner();
  const provider = String(formData.get("provider") || "").trim();
  const candidate = String(formData.get("secret") || "").trim();
  if (!provider) return { ok: false, message: "No provider given." };
  if (!candidate) return { ok: false, message: "Paste the secret you want to test." };

  const result = await testSecretAgainstLastRejection(provider, candidate);
  if (result.ok) {
    return {
      ok: true,
      message: `This secret matches. The post ${laneName(provider)} sent at ${new Date(result.when).toLocaleString("en-US", { timeZone: "America/New_York" })} ET signs to exactly the digest it presented${result.matched === "base64" ? " (base64, not hex — worth noting)" : ""}${result.header ? `, on the “${result.header}” header` : ""}. Safe to save.`,
    };
  }
  if (result.kind === "nothing-to-test") return { ok: false, message: result.note };
  return {
    ok: false,
    message: `This secret does NOT match. The post ${laneName(provider)} sent at ${new Date(result.when).toLocaleString("en-US", { timeZone: "America/New_York" })} ET signs to something different${result.header ? ` (its digest arrived on the “${result.header}” header)` : ""}. Don't save it — copy the value from the provider again, and check you copied the whole thing.`,
  };
}

/** Replay one stored event through the same processor its receiver used. */
export async function retryWebhookFailure(id: string): Promise<ActionResult> {
  await requireOwner();
  const r = await retryWebhookEventNow(id);
  revalidatePath("/connections");
  return r;
}

/** Stop an unresolved event counting, without deleting it. The only other way
 *  off the list is processing cleanly — nothing ages out on its own any more. */
export async function dismissWebhookFailure(id: string): Promise<ActionResult> {
  await requireOwner();
  const who = await getCurrentUser().catch(() => null);
  const r = await dismissWebhookEvent(id, who?.email ?? null);
  revalidatePath("/connections");
  return r;
}

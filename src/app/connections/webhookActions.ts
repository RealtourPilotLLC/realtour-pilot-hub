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

/**
 * What a receiver does WHEN IT HAS NO SECRET: accept and stamp the row (its
 * behaviour to date), or refuse. Deliberately per-provider — a single global
 * switch is how one misconfigured lane takes the others down with it.
 *
 * READ THAT FIRST SENTENCE AGAIN, because the messages below used to get it
 * wrong and the review caught it. This setting is consulted by exactly one
 * branch in each of the three receivers — the one reached when there is no
 * usable secret (aryeo route: `else if (!secret)`; openphone
 * openPhoneRequestAuthorized: `if (!expected)`; scripting: `if (secret) {…}`
 * with no else). With a secret stored, every one of them verifies regardless
 * and this row is never read. Saying "will now refuse any post it can't
 * verify" in that state described a door that had not moved — and worse, it
 * armed a trap: turn it on with a secret stored (no effect, looks done), then
 * remove the secret, and suddenly every post is refused. That is Sep 8 again,
 * through two buttons an inch apart. The strip now hides this control while a
 * secret is stored, and these words say what it really governs.
 */
export async function setWebhookVerification(provider: string, enforce: boolean): Promise<ActionResult> {
  await requireOwner();
  if (!ENFORCE_TOGGLEABLE.includes(provider)) {
    return { ok: false, message: `${laneName(provider)} has no switch here — it already refuses anything it can't verify.` };
  }
  const who = await getCurrentUser().catch(() => null);
  await setWebhookEnforced(provider, enforce, who?.email ?? null);
  revalidatePath("/connections");
  const name = laneName(provider);
  return {
    ok: true,
    message: enforce
      ? `Set. While no secret is saved for ${name}, every post it sends will be refused and recorded here. Takes effect within a minute. ${IF_IT_BOUNCES[provider] ?? "If real events start bouncing, switch it back."}`
      : `Set. While no secret is saved for ${name}, its posts are accepted and each one is stamped “unsigned” on its row. Takes effect within a minute.`,
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

// ---------------------------------------------------------------------------
// THE ARYEO CUTOVER (Sep 16 2026)
//
// Jordan: "Aryeo doesnt give signing secrets only API keys so we can make up a
// secret." He is right — Aryeo's docs say any arbitrary string can be used as
// the signing secret. So the hub makes one, and these four actions are the
// whole of the owner's side of the changeover.
//
// The one rule they all serve: SAVING A SECRET NEVER STARTS REFUSING POSTS.
// That is what happened on 8 September and it cost eight days of live data.
// See lib/webhookArming for the state machine underneath.
// ---------------------------------------------------------------------------

export type GeneratedSecret = ActionResult & { secret?: string };

/**
 * "Make me a secret." Generates 32 bytes of real randomness, stores it
 * encrypted as the Aryeo webhook secret, and hands it back EXACTLY ONCE so it
 * can be pasted into Aryeo. It is never readable again from any screen.
 *
 * Crucially, it puts the receiver in WATCHING, not enforcing: Aryeo cannot
 * possibly have this string yet, and refusing its posts in that window is the
 * entire Sep 8 failure.
 */
export async function generateAryeoWebhookSecret(): Promise<GeneratedSecret> {
  await requireOwner();
  const { generateWebhookSecret, beginWatching } = await import("@/lib/webhookArming");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const secret = generateWebhookSecret();
  await saveSecret("aryeo_webhook", secret);
  // Order matters: the secret is live the instant it is stored, so the watching
  // record has to exist before anything can read the two together and conclude
  // the lane is armed. (readArmState defaults an unknown record to watching, so
  // even a crash between these two lines lands on the safe side.)
  await beginWatching("aryeo", secret);
  // Any decision recorded about the PREVIOUS secret is now meaningless — the
  // fingerprint check in readArmState disregards it automatically, but the
  // message has to be honest that checking is off again until Aryeo proves it.
  revalidatePath("/connections");
  return {
    ok: true,
    secret,
    message:
      "Here is your new secret. Copy it now — this is the only time it is shown. Aryeo webhooks keep working exactly as they do today: nothing is being refused, and nothing will be, until a post arrives from Aryeo that is actually signed with this.",
  };
}

/**
 * "Arm it now." The owner asserts Aryeo has the secret rather than waiting for
 * a post to prove it. Offered because the proof can be slow to arrive — and
 * refused outright when the hub has no readable secret, which would turn every
 * post into a refusal for no reason at all.
 */
export async function armAryeoChecking(): Promise<ActionResult> {
  await requireOwner();
  const { getSecret } = await import("@/lib/integrations/connections");
  const secret = await getSecret("aryeo_webhook").catch(() => null);
  if (!secret) {
    return {
      ok: false,
      message:
        "There is no secret saved that the hub can read, so there is nothing to check posts against. Generate one first.",
    };
  }
  const { armNow } = await import("@/lib/webhookArming");
  const who = await getCurrentUser().catch(() => null);
  await armNow("aryeo", secret, who?.email ?? null);
  revalidatePath("/connections");
  return {
    ok: true,
    message:
      "On. From now the hub refuses any Aryeo post that isn't signed with your secret. If real Aryeo events start bouncing in the first day after Aryeo starts posting again, it will switch itself back off within about two minutes and tell you — and you can press “Stop checking” here at any time.",
  };
}

/**
 * "Stop checking." The escape hatch, and the button that would have saved eight
 * days had it existed on Sep 8. Note it does NOT go back to watching: see the
 * note at the top of lib/webhookArming for why a good post must not be allowed
 * to silently re-arm the thing that just broke.
 */
export async function stopAryeoChecking(): Promise<ActionResult> {
  await requireOwner();
  const { getSecret } = await import("@/lib/integrations/connections");
  const secret = await getSecret("aryeo_webhook").catch(() => null);
  if (!secret) return { ok: false, message: "There is no saved secret, so nothing is being refused." };
  const { holdEnforcement } = await import("@/lib/webhookArming");
  const who = await getCurrentUser().catch(() => null);
  await holdEnforcement("aryeo", secret, who?.email ?? null, "Switched off by hand on Connections.");
  revalidatePath("/connections");
  return {
    ok: true,
    message:
      // "Start checking now" — word for word what the button says. Jordan
      // follows these literally, and a message naming a control that isn't on
      // screen under that name is a message that sends him looking.
      "Off. Aryeo posts are being accepted again, and each one is marked as unchecked. The secret is still saved — nothing will switch checking back on by itself; press “Start checking now” when you're ready.",
  };
}

/**
 * Retire the secret entirely (the 8 Sep one, or any other). Hands the receiver
 * back to its pre-cutover behaviour — accepting anything posted to the URL —
 * which is a real loosening, so the message says so plainly rather than
 * reporting a tidy success.
 */
export async function retireAryeoWebhookSecret(): Promise<ActionResult> {
  await requireOwner();
  const { clearAryeoWebhookSecret } = await import("@/app/connections/actions");
  const r = await clearAryeoWebhookSecret();
  revalidatePath("/connections");
  return r;
}

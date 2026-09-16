"use server";

import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

import { revalidatePath } from "next/cache";
import { appBase } from "@/lib/appUrl";
import { saveSecret, disconnect as disconnectConn } from "@/lib/integrations/connections";
import { testOpenPhoneKey, registerOpenPhoneWebhooks } from "@/lib/integrations/openphone";
import { testStripeKey, syncStripe } from "@/lib/integrations/stripe";
import { exchangeDropboxCode, testDropboxRefreshToken } from "@/lib/integrations/dropbox";
import { testSlackKey, testSlackUserKey } from "@/lib/integrations/slack";
import { testAiKey } from "@/lib/integrations/ai";
import { testCalendlyKey } from "@/lib/integrations/calendly";
import { epidemicSoundReach, testEpidemicSoundKey } from "@/lib/integrations/epidemicSound";
import { testTopazKey, topazBalance } from "@/lib/integrations/topaz";
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
    // Bounded: the unbounded pass is ~190s of API and can't fit a request;
    // the hourly reconcile slices cover all of history.
    const appt = await syncAryeoAppointments({ recentOnlyDays: 120 });
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
  stripe: testStripeKey,
  calendly: testCalendlyKey,
  epidemic_sound: testEpidemicSoundKey,
  // Topaz's tester calls the FREE credit-balance endpoint and nothing else —
  // no estimate, no render, nothing that could reserve or spend a credit.
  topaz: testTopazKey,
};

// Epidemic Sound "Test connection" (Sep 15): re-runs the same probe the
// connect step ran — the key still works, and what the partner agreement
// reaches (moods, collections, full-catalogue search or curated only) — so
// Jordan can see at a glance why an editor's search came back empty.
export async function testEpidemicSoundNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const r = await epidemicSoundReach();
    revalidatePath("/connections");
    return { ok: true, message: r.note };
  } catch (e) {
    const { esFriendlyMessage } = await import("@/lib/integrations/epidemicSoundCore");
    const f = esFriendlyMessage(e);
    return {
      ok: false,
      message:
        f.kind === "unauthorized" || f.kind === "forbidden"
          ? "Epidemic Sound rejected the key — paste a fresh one."
          : f.kind === "rate_limited"
            ? "Epidemic Sound is rate limiting us — try again in a minute."
            : f.message,
    };
  }
}

// Topaz "Test connection" (Sep 16): re-reads the credit balance with the stored
// key. THAT IS THE ONLY CALL IT MAKES. Balance is free — it starts nothing,
// reserves nothing and costs nothing — which matters because auto top-up is on:
// a "test" button that kicked off a render would spend real money every time
// somebody pressed it to see if the key still worked.
export async function testTopazNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const b = await topazBalance();
    revalidatePath("/connections");
    const held = b.reserved_credits > 0 ? `, ${Math.round(b.reserved_credits)} held for videos running now` : "";
    return {
      ok: true,
      message: `Topaz answered — ${Math.round(b.available_credits)} credits available${held}. Checking costs nothing.`,
    };
  } catch (e) {
    // The key itself never travels in an error message: everything thrown by
    // the Topaz client has already been scrubbed of anything key-shaped.
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't reach Topaz." };
  }
}

// Pull the real books from QuickBooks on demand. This is the number that has
// been missing everywhere else: revenue processed outside Stripe, plus the
// expense ledger the Hub has never seen.
export async function syncQuickBooksNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const { syncQuickBooks } = await import("@/lib/integrations/quickbooks");
    const r = await syncQuickBooks();
    revalidatePath("/connections");
    revalidatePath("/sales");
    return {
      ok: true,
      message: `Synced — ${r.invoices} invoices, ${r.payments} payments, ${r.salesReceipts} sales receipts, ${r.deposits} deposits, ${r.purchases} expenses.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "QuickBooks sync failed." };
  }
}

// Pull the latest Stripe money-in (balance transactions) on demand — the "Sync
// payments" button on the Stripe card. Daily cron does this automatically too.
export async function syncStripeNow(): Promise<ActionResult> {
  await requireOwner();
  try {
    const r = await syncStripe();
    revalidatePath("/connections");
    revalidatePath("/sales");
    return { ok: true, message: `Synced — ${r.imported} Stripe transaction${r.imported === 1 ? "" : "s"} pulled in.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Stripe sync failed." };
  }
}

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
  // One origin helper for the whole app (src/lib/appUrl) — this used to read
  // NEXT_PUBLIC_APP_URL/VERCEL_URL by hand, so with the env var unset it would
  // have registered OpenPhone against the ephemeral per-deploy vercel.app host
  // instead of hub.realtourpilot.com. https-only: appBase() falls back to
  // localhost in dev, which OpenPhone can't reach.
  const base = appBase();
  if (!/^https:\/\//.test(base)) return { ok: false, message: "Deploy the app first — webhooks need a public URL." };
  try {
    const r = await registerOpenPhoneWebhooks(`${base}/api/webhooks/openphone`);
    const host = base.replace(/^https:\/\//, "");
    return {
      ok: true,
      message:
        (r.transcripts
          ? "Real-time enabled — texts, calls & call transcripts will log automatically."
          : "Real-time enabled for texts & calls (transcripts not available on this plan).") +
        ` Signing token stored — the receiver at ${host} now rejects anything unsigned.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not register webhooks." };
  }
}

// Aryeo's inbound-webhook signing secret. Stored through the SAME encrypted
// plumbing as every API key (saveSecret → encryptSecret), under its own
// "aryeo_webhook" provider row — mirroring how the OpenPhone token is kept.
// The receiver (api/webhooks/aryeo) HMAC-SHA256s the raw body with it and
// rejects anything that doesn't match, so until this is saved the endpoint
// accepts posts from anyone who knows the URL. The value is never read back to
// the browser and never appears in a message.
export async function saveAryeoWebhookSecret(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireOwner();
  const secret = String(formData.get("secret") || "").trim();
  if (!secret) return { ok: false, message: "Paste the signing secret from Aryeo." };
  // Guard against a pasted placeholder/truncation: a 3-character "secret" would
  // look protected on this page while being trivially guessable.
  if (secret.length < 12) return { ok: false, message: "That looks too short to be a signing secret — copy the whole value." };
  await saveSecret("aryeo_webhook", secret);
  // SAVING IS NOT ENFORCING (Sep 16). This action used to switch the receiver
  // to rejecting the instant it returned — which is precisely what it did on
  // 8 September, to a secret Aryeo had never been given: 36 real events bounced
  // and the feed went dead for eight days. Now the same save opens a WATCHING
  // period, and the receiver only starts refusing once a post actually verifies
  // against this value. See lib/webhookArming.
  const { beginWatching } = await import("@/lib/webhookArming");
  await beginWatching("aryeo", secret);
  revalidatePath("/connections");
  return {
    ok: true,
    message:
      "Saved. Nothing changes for Aryeo right now — its posts keep being accepted exactly as they were. The hub starts checking them, and refusing anything that doesn't match, the first time Aryeo sends a post actually signed with this. You'll get a notification when that happens.",
  };
}

// Escape hatch: a WRONG secret bounces every real Aryeo event at the door, so
// the owner must be able to turn verification back off without waiting for a
// deploy. Clears only the "aryeo_webhook" row — the Aryeo API key is untouched.
export async function clearAryeoWebhookSecret(): Promise<ActionResult> {
  await requireOwner();
  await disconnectConn("aryeo_webhook");
  // The receiver ALSO falls back to the legacy plaintext Connection.webhookSecret
  // column on the "aryeo" row (api/webhooks/aryeo → aryeoWebhookSecret), so
  // clearing the encrypted row alone left a hand-pasted secret still verifying:
  // "Remove" would report success while every real event kept bouncing at the
  // door — exactly the wedge this escape hatch exists to undo. updateMany, not
  // update, because the "aryeo" row may not exist.
  await prisma.connection.updateMany({ where: { provider: "aryeo" }, data: { webhookSecret: null } });
  // And forget every decision recorded ABOUT that secret. The fingerprint check
  // in readArmState already disregards a record belonging to a retired secret,
  // so this is not load-bearing — but leaving a stale "armed, proved on the 8th"
  // row behind to be read by some future query is how a safety light ends up
  // describing a credential that no longer exists.
  const { forgetArmState } = await import("@/lib/webhookArming");
  await forgetArmState("aryeo");

  // AND THE OTHER SWITCH, or this action is a trap (review, Sep 16).
  //
  // With a secret stored, `webhook-enforce:aryeo` is never consulted — the
  // receiver verifies and that is that. With NO secret it becomes the whole
  // rule: set to refuse, the receiver 401s every Aryeo post. So removing the
  // secret while that setting is on does not do what this button says; it does
  // the exact opposite, and it is the Sep 8 configuration exactly — Aryeo
  // bounces twice, gives up, and the feed is dead again.
  //
  // It is turned off rather than refusing the removal, because the removal is
  // the thing the owner asked for and the setting is a leftover from a control
  // that used to be shown alongside it. Saying so out loud is the price.
  let alsoAcceptedAgain = false;
  try {
    const { webhookEnforced, setWebhookEnforced } = await import("@/lib/webhookRetry");
    if (await webhookEnforced("aryeo")) {
      const { getCurrentUser } = await import("@/lib/auth/user");
      const who = await getCurrentUser().catch(() => null);
      await setWebhookEnforced("aryeo", false, who?.email ?? null);
      alsoAcceptedAgain = true;
    }
  } catch {
    /* if this can't be read, the message below simply doesn't mention it */
  }

  revalidatePath("/connections");
  return {
    ok: true,
    message:
      "Removed. Nothing is stored for Aryeo to sign with any more, so the hub is back to accepting any post sent to its webhook address — including from anyone who knows it. Generate a new secret when you're ready to close that." +
      (alsoAcceptedAgain
        ? " One other thing was switched off with it: this page also had “with no secret saved, refuse every post” turned on for Aryeo. Left on, removing the secret would have made the hub refuse everything Aryeo sends — which is what took the feed down on 8 September — so it is now set back to accepting."
        : ""),
  };
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

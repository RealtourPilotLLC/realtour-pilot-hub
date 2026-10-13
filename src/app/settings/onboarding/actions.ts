"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// SETTINGS → CLIENT ONBOARDING, the owner's actions (Oct 5 2026).
//
// Every change and every send on the page is Jordan's: requireOwner refuses an
// admin, and it refuses the owner too while he is previewing as someone else
// ("view as") — a preview is read-only. The work itself is in
// lib/clientOnboarding.ts; nothing here sends anything except
// sendOnboardingMessageAction, and that only for the one message, the one
// recipient and the one press it is given.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

/** The owner, signed in as himself (not previewing). Throws otherwise. */
async function owner(): Promise<{ email: string; id: string | null }> {
  await requireOwner();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return { email: me?.email ?? "dev@local", id: me?.id ?? null };
}

function done<T extends Result>(r: T): T {
  if (r.ok) revalidatePath("/settings/onboarding");
  return r;
}

/**
 * Step 3 / step 6: allow or stop one feature for one client. Sends nothing.
 * `onlyThisClient`: the owner's "Turn on for <client> only" after a refusal
 * that named other clients with choices on file — they are set to nothing.
 */
export async function setOnboardingToggleAction(input: { clientId: string; toggle: string; on: boolean; onlyThisClient?: boolean }): Promise<Result & { othersOnFile?: string[] }> {
  let me: { email: string };
  try { me = await owner(); } catch (e) { return fail(e); }
  try {
    const { setOnboardingToggle } = await import("@/lib/clientOnboarding");
    const r = await setOnboardingToggle({ clientId: input.clientId, toggle: input.toggle, on: input.on === true, by: me.email, onlyThisClient: input.onlyThisClient === true });
    if (r.ok) revalidatePath("/settings");
    return done(r);
  } catch (e) { return fail(e); }
}

/** Step 4: create the owner seat without emailing anybody. */
export async function createOnboardingSeatAction(input: { clientId: string; email: string; name?: string | null }): Promise<Result> {
  let me: { email: string; id: string | null };
  try { me = await owner(); } catch (e) { return fail(e); }
  try {
    const { createOnboardingSeat } = await import("@/lib/clientOnboarding");
    return done(await createOnboardingSeat({ clientId: input.clientId, email: input.email, name: input.name ?? null, by: me.email, byAppUserId: me.id }));
  } catch (e) { return fail(e); }
}

/** Step 5: send ONE message, as edited, to ONE address on file. Only the owner's press. */
export async function sendOnboardingMessageAction(input: { clientId: string; message: string; channel: string; toRef: string; body: string; intentId: string }): Promise<Result & { outcome?: string }> {
  let me: { email: string };
  try { me = await owner(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  try {
    const { sendOnboardingMessage } = await import("@/lib/clientOnboarding");
    const r = await sendOnboardingMessage({ ...input, by: me.email });
    // Logged even when not sent (a refusal at the gate, an unknown): refresh either way.
    revalidatePath("/settings/onboarding");
    return r;
  } catch (e) { return fail(e); }
}

/** Step 5: "Mark as sent by me" — records it, sends nothing. */
export async function markOnboardingSentAction(input: { clientId: string; message: string; channel: string; toRef?: string | null }): Promise<Result> {
  let me: { email: string };
  try { me = await owner(); } catch (e) { return fail(e); }
  try {
    const { markOnboardingSent } = await import("@/lib/clientOnboarding");
    return done(await markOnboardingSent({ ...input, by: me.email }));
  } catch (e) { return fail(e); }
}

// ---- "Do everything" (Oct 14 2026) -------------------------------------------
// Jordan, Oct 13: "Can you just automate this ... I just want everything done
// for me at this point." Both run lib/autoOnboarding, which goes through the
// same functions as the buttons above (and their checks). The welcome is sent
// at most once per client, ever.

export type AutoOnboardResult = Result & { lines: string[] };

/** Every step for ONE client, the welcome email included. Owner only. */
export async function autoOnboardClientAction(input: { clientId: string }): Promise<AutoOnboardResult> {
  let me: { email: string; id: string | null };
  try { me = await owner(); } catch (e) { return { ...fail(e), lines: [] }; }
  try {
    const { autoOnboardClient } = await import("@/lib/autoOnboarding");
    const r = await autoOnboardClient(input.clientId, me.email, { sendWelcome: true, allowTest: true, byAppUserId: me.id });
    revalidatePath("/settings/onboarding");
    revalidatePath("/settings");
    if (r.outcome === "skipped") return { ok: false, message: `${r.name} was skipped: ${r.reason}.`, lines: [] };
    return {
      ok: r.outcome === "onboarded",
      message: r.outcome === "onboarded" ? `${r.name} is onboarded.` : `${r.name}: done as far as it can go. Something below needs you.`,
      lines: r.steps.map((s) => `${s.key}: ${s.status}. ${s.detail}`),
    };
  } catch (e) { return { ...fail(e), lines: [] }; }
}

/** Every ACTIVE, non-TEST program client, one after another. Owner only. */
export async function autoOnboardAllAction(): Promise<AutoOnboardResult> {
  let me: { email: string; id: string | null };
  try { me = await owner(); } catch (e) { return { ...fail(e), lines: [] }; }
  try {
    const { autoOnboardAll, reportLine } = await import("@/lib/autoOnboarding");
    const all = await autoOnboardAll(me.email, { sendWelcome: true, byAppUserId: me.id });
    revalidatePath("/settings/onboarding");
    revalidatePath("/settings");
    const done = all.filter((r) => r.outcome === "onboarded").length;
    return { ok: done === all.length, message: `${done} of ${all.length} active clients are onboarded.${done < all.length ? " The rest need you (below)." : ""}`, lines: all.map(reportLine) };
  } catch (e) { return { ...fail(e), lines: [] }; }
}

/** Step 7: the Onboarded checkbox. */
export async function setOnboardedAction(input: { clientId: string; done: boolean }): Promise<Result> {
  let me: { email: string };
  try { me = await owner(); } catch (e) { return fail(e); }
  try {
    const { setOnboarded } = await import("@/lib/clientOnboarding");
    return done(await setOnboarded({ clientId: input.clientId, done: input.done === true, by: me.email }));
  } catch (e) { return fail(e); }
}

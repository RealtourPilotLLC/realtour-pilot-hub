"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { TopazSettings } from "@/lib/settings";
import type { TopazTestView } from "@/lib/topazTests";

// ---------------------------------------------------------------------------
// "TRY THESE SETTINGS" — the Settings page's Topaz test (Jordan, Oct 22 2026).
//
// OWNER ONLY, every one of them: a test spends real credits, and only the
// owner sees money (Kyle never sees a credit or dollar amount). requireRole
// fails closed in production and blocks "view as". The engine is
// lib/topazTests; nothing here files anything to Dropbox, Aryeo or a portal.
// ---------------------------------------------------------------------------

async function owner(): Promise<string | null> {
  await requireRole(["OWNER"]);
  const me = await getCurrentUser().catch(() => null);
  const { displayNameFor } = await import("@/lib/actorName");
  return displayNameFor(me);
}

const ID_RE = /^[a-z0-9]{10,40}$/i;

/** The free price check, with the settings ON SCREEN (saved or not). */
export async function estimateTopazTestAction(submissionId: string, draft: TopazSettings): Promise<{ ok: boolean; message: string; test?: TopazTestView }> {
  let by: string | null;
  try {
    by = await owner();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (typeof submissionId !== "string" || !ID_RE.test(submissionId)) return { ok: false, message: "Pick a video first." };
  const { estimateTopazTest } = await import("@/lib/topazTests");
  const r = await estimateTopazTest(submissionId, draft && typeof draft === "object" ? draft : null, by).catch((e: unknown) => ({
    ok: false,
    message: `Couldn't price the test just now (${(e as Error).message.slice(0, 160)}). Nothing was spent.`,
  }));
  revalidatePath("/settings");
  return r;
}

/** The press that spends: "Run the test (about N credits)". */
export async function runTopazTestAction(testId: string): Promise<{ ok: boolean; message: string; test?: TopazTestView }> {
  let by: string | null;
  try {
    by = await owner();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (typeof testId !== "string" || !/^[a-f0-9]{16}$/.test(testId)) return { ok: false, message: "Which test?" };
  const { runTopazTest } = await import("@/lib/topazTests");
  const r = await runTopazTest(testId, by).catch((e: unknown) => ({ ok: false, message: `Couldn't start the test (${(e as Error).message.slice(0, 160)}).` }));
  revalidatePath("/settings");
  return r;
}

/**
 * The price check and the run in ONE call (Oct 22 2026, "set it and forget
 * it"): for a script or a console, a submission id and a settings draft.
 * `maxCredits` refuses to run a test priced above it (nothing spent). Owner
 * only, like the rest. See lib/topazTests.startTopazTest.
 */
export async function startTopazTestAction(
  submissionId: string,
  settings: Partial<TopazSettings> | null,
  opts: { maxCredits?: number } = {},
): Promise<{ ok: boolean; message: string; test?: TopazTestView; compareHref?: string }> {
  let by: string | null;
  try {
    by = await owner();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (typeof submissionId !== "string" || !ID_RE.test(submissionId)) return { ok: false, message: "Which video?" };
  const maxCredits = typeof opts?.maxCredits === "number" && Number.isFinite(opts.maxCredits) && opts.maxCredits > 0 ? opts.maxCredits : undefined;
  const { startTopazTest } = await import("@/lib/topazTests");
  const r = await startTopazTest(submissionId, settings && typeof settings === "object" ? settings : null, by, { maxCredits }).catch((e: unknown) => ({
    ok: false,
    message: `Couldn't start the test (${(e as Error).message.slice(0, 160)}). Nothing was spent unless it says it started.`,
  }));
  revalidatePath("/settings");
  return r;
}

/** The recent tests, for the panel's "Check progress" (owner only). */
export async function listTopazTestsAction(): Promise<{ ok: boolean; message: string; tests?: TopazTestView[] }> {
  try {
    await owner();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { topazTestRows } = await import("@/lib/topazTests");
  const tests = await topazTestRows(12).catch(() => null);
  return tests ? { ok: true, message: "", tests } : { ok: false, message: "Couldn't read the tests just now. Try again." };
}

/** "Use these settings for every video": the test's exact settings, saved. */
export async function applyTopazTestSettingsAction(testId: string): Promise<{ ok: boolean; message: string; settings?: TopazSettings }> {
  let by: string | null;
  try {
    by = await owner();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (typeof testId !== "string" || !/^[a-f0-9]{16}$/.test(testId)) return { ok: false, message: "Which test?" };
  const { applyTopazTestSettings } = await import("@/lib/topazTests");
  const me = await getCurrentUser().catch(() => null);
  const r = await applyTopazTestSettings(testId, me?.email ?? by).catch(() => ({ ok: false, message: "Couldn't save just now. Try again." }));
  revalidatePath("/settings");
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { allAutomations, setAutomation, isAutomationKey, type AutomationState } from "@/lib/programAutomation";
import { AUTOMATION_EFFECTS } from "@/lib/programAutomationCopy";

// ---------------------------------------------------------------------------
// The content program's automation switches (spec §13). OWNER only, both
// directions: turning one OFF is as consequential as turning it on, and
// neither is something an admin should be able to do on their own.
//
// What each key will do when it is on, in plain words, lives in
// programAutomationCopy — the confirm dialog quotes it, and the same sentence
// goes in the audit note. Nothing in this file switches anything on by itself.
//
// THIS FILE NEVER WRITES A CONFIG. The reminder policy — the only automation
// config a person edits — belongs to the reminder evaluator that reads it
// (src/lib/programReminders.ts) and is written on Settings → Program
// reminders. A second editor here wrote a differently-shaped JSON to the same
// key, which made the switch impossible to turn on once a real policy existed
// and silently replaced the rules governing when a client is emailed. Turning
// reminders ON now VALIDATES the stored policy with the evaluator's own
// validator and refuses if it would not run.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

export async function loadAutomations(): Promise<AutomationState[]> {
  return allAutomations();
}

/** The policy the evaluator would run on, checked with the evaluator's validator. */
async function reminderPolicyBlocker(): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const { REMINDER_DEFAULTS, validateReminderPolicy } = await import("@/lib/programReminders");
  const row = await prisma.programAutomation.findUnique({ where: { key: "reminders" }, select: { configJson: true } });
  let stored: unknown = null;
  if (row?.configJson) {
    try { stored = JSON.parse(row.configJson); } catch { return "The stored reminder policy is not valid JSON. Rewrite it in Settings → Program reminders before turning this on."; }
  }
  // Exactly how programReminders.reminderPolicy() reads it: the stored values
  // over the code defaults. Nothing stored = the defaults, which are valid, so
  // a first-time switch-on does not demand a policy be typed out first.
  const policy = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...REMINDER_DEFAULTS, ...(stored as Record<string, unknown>) } : REMINDER_DEFAULTS;
  const v = validateReminderPolicy(policy);
  return v.ok ? null : `The reminder policy would not run: ${v.errors.join(" · ")} Fix it in Settings → Program reminders, then turn this on.`;
}

/**
 * Flip a switch. The component shows the confirm; this checks the role and, for
 * reminders, refuses to start an automation whose policy the evaluator cannot
 * read. The stored config is never touched here.
 */
export async function setAutomationAction(key: string, enabled: boolean): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  if (!isAutomationKey(key)) return { ok: false, message: "Unknown automation." };
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    if (key === "reminders" && enabled) {
      const blocker = await reminderPolicyBlocker();
      if (blocker) return { ok: false, message: blocker };
    }
    const s = await setAutomation(key, enabled, me?.email ?? "dev@local", null);
    revalidatePath("/settings");
    revalidatePath("/content");
    revalidatePath("/content/monitoring");
    const effect = AUTOMATION_EFFECTS[key];
    return {
      ok: true,
      message: enabled
        ? `"${effect.title}" is ON. ${effect.blocked ?? effect.onEffect}`
        : `"${effect.title}" is off${s.lastRunAt ? ` — it last ran ${s.lastRunAt.toISOString().slice(0, 10)}` : ""}. Nothing it drives will run again until somebody turns it back on.`,
    };
  } catch (e) { return fail(e); }
}

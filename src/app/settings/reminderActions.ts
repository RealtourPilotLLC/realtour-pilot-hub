"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { getAutomation } from "@/lib/programAutomation";
import {
  REMINDER_DEFAULTS, REMINDERS_KEY, validateReminderPolicy, evaluateReminders, reminderLedger, sendReminderNow, copyReminderLink,
  snoozeMonthReminders, unsnoozeMonthReminders, type ReminderLedgerRow,
} from "@/lib/programReminders";
import { REMINDER_TEMPLATES } from "@/lib/reminderTemplates";
import type { ReachRefusalCode, ReachTier } from "@/lib/programRolloutCore";

// ---------------------------------------------------------------------------
// Settings → Program reminders (spec §24). Reads: owner or admin. Writes that
// change the POLICY or SEND a message: OWNER ONLY — the policy decides what a
// client hears and when. This file never flips the `reminders` switch: the
// automation switch lives on W2-E's ProgramAutomationPanel with its confirm.
// ---------------------------------------------------------------------------

type R = { ok: boolean; message: string };
const fail = (e: unknown): R => ({ ok: false, message: e instanceof Error ? e.message : "Failed." });
async function owner(): Promise<{ email: string; appUserId: string | null }> {
  await requireOwner();
  const u = await getCurrentUser().catch(() => null);
  return { email: u?.email ?? "owner", appUserId: u?.id ?? null };
}
async function admin(): Promise<{ email: string; appUserId: string | null }> {
  await requireAdmin();
  const u = await getCurrentUser().catch(() => null);
  return { email: u?.email ?? "staff", appUserId: u?.id ?? null };
}

export type DryRunRow = {
  enrollmentId: string; monthId: string; clientName: string; isTest: boolean; monthKey: string; action: string | null; decision: string; reason: string;
  suppressionReason: string | null; attempt: number; to: string | null; nextEligibleAt: string | null; deadlineAt: string | null; escalation: string | null; templateKey: string | null;
  /**
   * Which of the four lanes (R03, Sep 28 2026 — the address lane used to be
   * dropped here). The per-row buttons act only on PLANNING and REVIEW.
   */
  lane: "PLANNING" | "REVIEW" | "ADDRESS" | "APPROVE_SCRIPTS";
  /** The rollout's verdict for this client (op "reminders", with the policy's own lock): the tier, or the refusal. */
  tier: ReachTier | null;
  code: ReachRefusalCode | null;
};

export type RemindersPanelState = {
  switch: { enabled: boolean; missing: boolean; enabledBy: string | null; enabledAt: Date | null; lastRunAt: Date | null; lastError: string | null };
  policyJson: string;
  policySource: "stored" | "defaults";
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  templates: { id: string; action: string; version: string; purpose: string }[];
  ledger: ReminderLedgerRow[];
  counts: { total: number; sent: number; suppressed: number; failed: number; unknown: number };
};

export async function loadRemindersPanelState(): Promise<RemindersPanelState> {
  await requireAdmin();
  const s = await getAutomation(REMINDERS_KEY);
  const row = s.missing ? null : await prisma.programAutomation.findUnique({ where: { key: REMINDERS_KEY }, select: { configJson: true } });
  let stored: unknown = null;
  if (row?.configJson) { try { stored = JSON.parse(row.configJson); } catch { stored = null; } }
  const policyObj = stored && typeof stored === "object" ? { ...REMINDER_DEFAULTS, ...(stored as Record<string, unknown>) } : REMINDER_DEFAULTS;
  const v = validateReminderPolicy(policyObj);
  const [ledger, total, sent, suppressed, failed, unknown] = await Promise.all([
    reminderLedger({ take: 60 }),
    prisma.programReminder.count(),
    prisma.programReminder.count({ where: { state: "SENT" } }),
    prisma.programReminder.count({ where: { state: "SUPPRESSED" } }),
    prisma.programReminder.count({ where: { state: { in: ["FAILED", "BOUNCED"] } } }),
    prisma.programReminder.count({ where: { state: "UNKNOWN" } }),
  ]);
  return {
    switch: { enabled: s.enabled, missing: s.missing, enabledBy: s.enabledBy, enabledAt: s.enabledAt, lastRunAt: s.lastRunAt, lastError: s.lastError },
    policyJson: JSON.stringify(policyObj, null, 2),
    policySource: stored ? "stored" : "defaults",
    validation: v.ok ? { ok: true, errors: [], warnings: v.warnings } : { ok: false, errors: v.errors, warnings: [] },
    templates: Object.values(REMINDER_TEMPLATES).map((t) => ({ id: t.id, action: t.action, version: t.version, purpose: t.purpose })),
    ledger,
    counts: { total, sent, suppressed, failed, unknown },
  };
}

/** Validate without saving — what the panel calls as you type. */
export async function validateReminderPolicyAction(json: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  await requireAdmin();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { return { ok: false, errors: [`Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`], warnings: [] }; }
  const v = validateReminderPolicy(parsed);
  return v.ok ? { ok: true, errors: [], warnings: v.warnings } : { ok: false, errors: v.errors, warnings: [] };
}

/** Save the policy. Keeps the switch exactly as it is (off stays off). */
export async function saveReminderPolicy(json: string): Promise<R> {
  try {
    await owner();
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch (e) { return { ok: false, message: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}` }; }
    const v = validateReminderPolicy(parsed);
    if (!v.ok) return { ok: false, message: v.errors.join(" · ") };
    // Saving policy must not replay a stale switch snapshot or rewrite the
    // activation receipt. A concurrent disable remains disabled.
    const current = await prisma.programAutomation.upsert({
      where: { key: REMINDERS_KEY },
      create: { key: REMINDERS_KEY, enabled: false, configJson: JSON.stringify(v.policy) },
      update: { configJson: JSON.stringify(v.policy) },
      select: { enabled: true },
    });
    revalidatePath("/settings");
    return { ok: true, message: `Policy saved. The switch is ${current.enabled ? "ON" : "OFF"} — unchanged.${v.warnings.length ? ` Warnings: ${v.warnings.join(" · ")}` : ""}` };
  } catch (e) { return fail(e); }
}

/**
 * "What would go out now?" — reads everything, writes nothing. The SAME
 * evaluator the hourly run and dispatch run (evaluateReminders), so its
 * "send" rows are what would go out (R03, Sep 28 2026):
 *   · all four lanes — the address lane was dropped here, so an exact-address
 *     reminder could go out that the dry run never showed;
 *   · the recipient on every row, masked, computed BEFORE the scope check, so
 *     a client the rollout does not reach still shows who it would have gone
 *     to (the script-approval lane used to show nobody, and every real client
 *     nobody);
 *   · the rollout's verdict per row, and the one line saying whom the
 *     reminders reach (programRollout.programAudience — readiness's line).
 */
export async function runReminderDryRun(): Promise<{ ok: boolean; message: string; rows: DryRunRow[]; enabled: boolean; policySource: string; scopeLine: string }> {
  try {
    await admin();
    const { programAudience } = await import("@/lib/programRollout");
    const [r, scope] = await Promise.all([evaluateReminders({ dryRun: true, requestedBy: "dry-run" }), programAudience("reminders")]);
    const isTest = (a: { tier: ReachTier | null }) => a.tier === "TEST";
    const rows: DryRunRow[] = r.candidates.map((c) => ({
      enrollmentId: c.enrollmentId, monthId: c.monthId, clientName: c.clientName, isTest: c.isTest, monthKey: c.monthKey, action: c.action, decision: c.decision, reason: c.reason,
      suppressionReason: c.suppressionReason, attempt: c.attempt, to: c.to, nextEligibleAt: c.nextEligibleAt?.toISOString() ?? null, deadlineAt: c.deadlineAt?.toISOString() ?? null,
      escalation: c.escalation?.due ? c.escalation.reason : null, templateKey: c.templateKey,
      lane: c.lane === "REVIEW" ? "REVIEW" : "PLANNING", tier: c.audience.tier, code: c.audience.code,
    }));
    // §8's exact-address lane (CP-05): one row per session that has only a
    // general area. Read-only here, like the script lane below.
    for (const a of r.addressLane) {
      rows.push({
        enrollmentId: a.enrollmentId, monthId: a.monthId, clientName: a.clientName, isTest: isTest(a.audience), monthKey: a.monthKey, action: "CONFIRM_ADDRESS", decision: a.decision,
        reason: `${a.reason}${a.addressLine ? ` (on file: ${a.addressLine})` : ""}`, suppressionReason: a.suppressionReason, attempt: 1, to: a.to, nextEligibleAt: a.nextEligibleAt?.toISOString() ?? a.remindAt.toISOString(),
        deadlineAt: a.shootAt.toISOString(), escalation: a.urgent ? "less than a day before the session: Kyle is told too" : null, templateKey: null,
        lane: "ADDRESS", tier: a.audience.tier, code: a.audience.code,
      });
    }
    // 6.5: the scripts-not-approved lane, one row per session (read-only here:
    // its per-row buttons would act on the planning lane, so the panel hides them).
    for (const a of r.scriptApprovalLane) {
      rows.push({
        enrollmentId: a.enrollmentId, monthId: a.monthId, clientName: a.clientName, isTest: isTest(a.audience), monthKey: a.monthKey, action: "APPROVE_SCRIPTS", decision: a.decision,
        reason: `${a.reason}${a.titles.length ? ` (${a.titles.join(", ")})` : ""}`, suppressionReason: a.suppressionReason, attempt: 1, to: a.to, nextEligibleAt: a.nextEligibleAt?.toISOString() ?? a.remindAt.toISOString(),
        deadlineAt: a.deadlineAt.toISOString(), escalation: null, templateKey: "reminder.approve_scripts.v1",
        lane: "APPROVE_SCRIPTS", tier: a.audience.tier, code: a.audience.code,
      });
    }
    return { ok: true, message: r.note, rows, enabled: r.enabled, policySource: r.policySource, scopeLine: scope.line };
  } catch (e) { return { ...fail(e), rows: [], enabled: false, policySource: "off", scopeLine: "" }; }
}

/** Owner-only, and still blocked by the switch inside sendReminderNow. */
export async function sendReminderNowAction(monthId: string): Promise<R> {
  try {
    const me = await owner();
    const r = await sendReminderNow(monthId, me);
    revalidatePath("/settings");
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

export async function copyReminderLinkAction(monthId: string): Promise<R & { link?: string; body?: string }> {
  try {
    const me = await admin();
    const r = await copyReminderLink(monthId, me);
    revalidatePath("/settings");
    return { ok: r.ok, message: r.message, link: r.link, body: r.body };
  } catch (e) { return fail(e); }
}

export async function snoozeRemindersAction(monthId: string, days: number, reason: string): Promise<R> {
  try {
    const me = await admin();
    const d = Math.max(1, Math.min(60, Math.round(days)));
    await snoozeMonthReminders(monthId, new Date(Date.now() + d * 864e5), reason, me.email);
    revalidatePath("/settings");
    return { ok: true, message: `Snoozed for ${d} day${d === 1 ? "" : "s"}.` };
  } catch (e) { return fail(e); }
}

export async function unsnoozeRemindersAction(monthId: string): Promise<R> {
  try {
    await admin();
    await unsnoozeMonthReminders(monthId);
    revalidatePath("/settings");
    return { ok: true, message: "Reminders resume on the next evaluation." };
  } catch (e) { return fail(e); }
}

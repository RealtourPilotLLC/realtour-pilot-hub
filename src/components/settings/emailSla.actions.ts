"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { EmailSlaRules } from "@/lib/commsSla";

// The email reply-SLA card on Settings → Internal alerts (O06, Sep 26 2026).
// Owner or admin, the same house guard every other Settings write uses. Its own
// AppSetting key (`email_sla`), so saving the internal-alerts card beside it can
// never put an old copy of this one back.

export async function loadEmailSla(): Promise<{ rules: EmailSlaRules; since: string | null }> {
  await requireAdmin();
  const { emailSlaRules, EMAIL_SLA_SINCE_KEY } = await import("@/lib/commsSla");
  const { prisma } = await import("@/lib/prisma");
  const rules = await emailSlaRules();
  const row = await prisma.appSetting.findUnique({ where: { key: EMAIL_SLA_SINCE_KEY }, select: { value: true } }).catch(() => null);
  let since: string | null = null;
  try {
    since = row ? ((JSON.parse(row.value) as { since?: string }).since ?? null) : null;
  } catch {
    since = null;
  }
  return { rules, since };
}

export async function saveEmailSla(input: Partial<EmailSlaRules>): Promise<{ ok: boolean; message: string; rules?: EmailSlaRules }> {
  try {
    await requireAdmin();
    const me = await getCurrentUser().catch(() => null);
    const { saveEmailSlaRules } = await import("@/lib/commsSla");
    const rules = await saveEmailSlaRules(input, me?.email ?? null);
    revalidatePath("/settings");
    return {
      ok: true,
      rules,
      message: rules.enabled
        ? `Saved. Kyle's bell at ${rules.kyleCoveredHours} covered hours, yours at ${rules.ownerCoveredHours} (${rules.unhappyCoveredHours} for an unhappy client).`
        : "Saved. Email is listed on Tasks → Comms → Email and rings nobody.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn’t save — try again." };
  }
}

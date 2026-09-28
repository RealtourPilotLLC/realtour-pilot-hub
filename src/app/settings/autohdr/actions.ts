"use server";

import { revalidatePath } from "next/cache";
import { requireOwner, requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// Settings → AutoHDR balance (§10 AU-20, Sep 26). Kyle records his Monday
// reading here (owner or admin); only the owner changes who checks, the
// threshold or the credits-per-photo rate. Nothing here can buy credits.

export type AutohdrActionResult = { ok: boolean; message: string };

async function actor(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "local-dev";
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

export async function recordAutohdrReading(input: { credits?: string | number | null; dollars?: string | number | null; note?: string | null }): Promise<AutohdrActionResult> {
  await requireRole(["OWNER", "ADMIN"]);
  const credits = num(input.credits);
  const dollars = num(input.dollars);
  if (Number.isNaN(credits) || Number.isNaN(dollars)) return { ok: false, message: "That balance doesn't look like a number." };
  const { recordBalanceReading } = await import("@/lib/vendorBalance");
  const r = await recordBalanceReading({ credits, dollars, note: input.note ?? null, recordedBy: await actor() });
  revalidatePath("/settings/autohdr");
  revalidatePath("/connections");
  return { ok: r.ok, message: r.message };
}

export async function saveAutohdrSettings(input: {
  checkOwnerKey: string | null;
  checkWeekday: number;
  thresholdCredits?: string | number | null;
  thresholdDollars?: string | number | null;
  creditsPerPhoto?: string | number | null;
}): Promise<AutohdrActionResult> {
  await requireOwner();
  const tc = num(input.thresholdCredits);
  const td = num(input.thresholdDollars);
  const cpp = num(input.creditsPerPhoto);
  if ([tc, td, cpp].some((x) => Number.isNaN(x) || (x !== null && x <= 0))) return { ok: false, message: "Leave a box empty, or enter a number above zero." };
  const key = input.checkOwnerKey && /^[a-z0-9_]{2,40}$/.test(input.checkOwnerKey) ? input.checkOwnerKey : null;
  const { saveVendorBalanceSettings } = await import("@/lib/vendorBalance");
  await saveVendorBalanceSettings(
    {
      checkOwnerKey: key,
      checkWeekday: Number.isInteger(input.checkWeekday) && input.checkWeekday >= 0 && input.checkWeekday <= 6 ? input.checkWeekday : 1,
      thresholdCredits: tc,
      thresholdDollars: td,
      creditsPerPhoto: cpp,
    },
    await actor(),
  );
  revalidatePath("/settings/autohdr");
  revalidatePath("/connections");
  return { ok: true, message: "Saved." };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { assignStrategyCall, unassignStrategyCall, ignoreStrategyCall, syncCallRecordsFromCalendly } from "@/lib/contentCallRecords";
import { DESK_LOOK_AHEAD_DAYS, DESK_LOOK_BACK_DAYS } from "@/lib/strategyCallDesk";

// ---------------------------------------------------------------------------
// Content → Strategy calls (Oct 6 2026). Owner or admin. Each action is one
// explicit staff decision on one call; nothing here messages a client, writes
// to Calendly or touches a booking. The page updates optimistically and only
// reads these results to confirm (or roll back) what it already shows.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string; monthStatus?: string | null };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function who(): Promise<string> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}
function touch() {
  revalidatePath("/content/calls");
  revalidatePath("/content");
}

export async function assignStrategyCallAction(recordId: string, clientId: string, monthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!clientId) return { ok: false, message: "Pick a client." };
  try {
    const r = await assignStrategyCall(recordId, { clientId, monthKey }, await who());
    touch();
    return { ok: true, message: `Filed on ${monthKey}.`, monthStatus: r.strategyCallStatus };
  } catch (e) { return fail(e); }
}

export async function unassignStrategyCallAction(recordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await unassignStrategyCall(recordId, await who()); touch(); return { ok: true, message: "Unassigned — the month is back as it was." }; }
  catch (e) { return fail(e); }
}

export async function ignoreStrategyCallAction(recordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await ignoreStrategyCall(recordId, await who()); touch(); return { ok: true, message: "Set aside as not a program call." }; }
  catch (e) { return fail(e); }
}

/**
 * Re-read Calendly for the page's window (30 days back, 14 ahead) through the
 * hourly sync's own path: upserts call records, files verified clients, never
 * messages anyone. The one-off backfill for calls booked before the generic
 * type was mapped.
 */
export async function refreshStrategyCallsAction(): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const r = await syncCallRecordsFromCalendly({ lookBackDays: DESK_LOOK_BACK_DAYS, lookAheadDays: DESK_LOOK_AHEAD_DAYS });
    touch();
    if ("skipped" in r) return { ok: false, message: r.skipped };
    return { ok: r.errors === 0, message: `Read ${r.scanned} bookings: ${r.created} new, ${r.updated} updated, ${r.matched} on a client${r.errors ? `, ${r.errors} failed (${r.lastError})` : ""}.` };
  } catch (e) { return fail(e); }
}

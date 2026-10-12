"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import type { CallTranscriptUi } from "@/lib/callAnalysis";

// ---------------------------------------------------------------------------
// "Analyze the call" (Oct 12 2026). Owner or admin. The click answers at once
// — the claim is one database write — and the analysis itself (a minute or so
// of AI) runs in after(), once the response is out; the page polls
// callAnalysisStatusAction until the call reads analyzed (or failed) and then
// refreshes, so the proposals appear without a reload. Attended: it runs
// whatever the automation switches say, exactly like the month's legacy
// Analyze button. Nothing here messages a client or shows them anything.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string; call?: CallTranscriptUi | null };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function who(): Promise<string> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}

/** after(), or — outside a request (a script, a drill) where nobody waits on a response — now. */
function inBackground(work: () => Promise<unknown>): Promise<void> {
  try {
    after(async () => { await work(); });
    return Promise.resolve();
  } catch {
    return work().then(() => undefined);
  }
}

export async function analyzeCallAction(callRecordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const by = await who();
    const { startCallAnalysis, runClaimedCallAnalysis } = await import("@/lib/callAnalysis");
    const claim = await startCallAnalysis(callRecordId, by);
    if (!claim.ok) return { ok: false, message: claim.message };
    await inBackground(() => runClaimedCallAnalysis({ jobId: claim.jobId, callRecordId, by, prior: claim.prior }));
    revalidatePath("/content");
    revalidatePath("/content/calls");
    return { ok: true, message: claim.reanalyze ? "Re-analyzing the call…" : "Analyzing the call…" };
  } catch (e) { return fail(e); }
}

/** The call's transcript state now — what the button polls while a run is going. */
export async function callAnalysisStatusAction(callRecordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { loadCallTranscripts } = await import("@/lib/callAnalysis");
    const [call] = await loadCallTranscripts({ callRecordIds: [callRecordId] });
    return call ? { ok: true, message: call.state, call } : { ok: false, message: "That call is not on file any more." };
  } catch (e) { return fail(e); }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// THE JOB PAGE'S PROGRESS POLLS (Oct 15 2026).
//
//   GET /api/photo-delivery/progress/<jobId>?what=push   the hub's send to Aryeo
//   GET /api/photo-delivery/progress/<jobId>?what=ready  the 06-Ready-for-Aryeo copy
//
// These used to be server actions. The browser runs server actions one at a
// time, so Kyle's clicks waited behind every poll; a route is not queued like
// that. Each ask still moves the work on a small step when it is running
// (exactly what aryeoPushProgressAction and readyProgressAction did), so the
// guard is the same as theirs: owner or Kyle, never a "view as" preview.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const NO_STORE = { "cache-control": "no-store" };
const answer = (body: { ok: boolean; progress: unknown }, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  try {
    await requireAdmin();
  } catch {
    return answer({ ok: false, progress: null }, 403);
  }
  const what = req.nextUrl.searchParams.get("what");
  if (!ID.test(String(jobId)) || (what !== "push" && what !== "ready")) return answer({ ok: false, progress: null }, 400);
  try {
    if (what === "push") {
      const { pushProgress, advancePush } = await import("@/lib/photoDelivery/aryeoPush");
      const p = await pushProgress(jobId);
      if (!p?.active) return answer({ ok: true, progress: p });
      return answer({ ok: true, progress: (await advancePush(jobId, { budgetMs: 5_000 })) ?? p });
    }
    const { readyProgress, advanceReady } = await import("@/lib/photoDelivery/handoff");
    const p = await readyProgress(jobId);
    if (!p?.active) return answer({ ok: true, progress: p });
    return answer({ ok: true, progress: (await advanceReady(jobId, { budgetMs: 4_000 })) ?? p });
  } catch {
    return answer({ ok: false, progress: null });
  }
}

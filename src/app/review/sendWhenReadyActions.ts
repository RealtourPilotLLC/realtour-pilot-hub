"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// "APPROVE AND SEND" AND ITS OFF SWITCH (Jordan, Oct 23 2026: "an approve and
// send button or re-run and send button"; lib/sendWhenReady).
//
//   · Approve and send (the review workspace, beside Approve): the approval
//     exactly as Approve gives it (review/actions.approveCut, unchanged), then
//     one "send when ready" intent for this cut. When the Topaz file is back
//     and checked, the hub uploads it to Aryeo and sends it in this person's
//     name, through every gate "Upload to Aryeo and send" has. When the job
//     has open client requests the press first shows them and asks
//     "Checked, approve and send"; that is recorded as the job box's own
//     Checked (clientAsks.confirmAsksForSend), after the approval lands.
//   · Don't send it automatically (the With Topaz row): the waiting intent
//     ends; the video waits for a person's press on Ready to send.
// The OWNER and the OFFICE only: requireAdmin (the REAL role; "view as"
// refused), the same guard as Upload to Aryeo and send. The creative manager
// and the review seats keep plain Approve, which sends nothing. Every answer
// is { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string; canApproveAnyway?: boolean };
const ID = /^[A-Za-z0-9_-]{6,64}$/;

async function denied(): Promise<Result | null> {
  try {
    await requireAdmin();
    return null;
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
  }
}

/** The name a press is signed with: the same as Upload to Aryeo and send's. */
async function actor(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? "staff" : "local dev";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

function refresh(projectId?: string) {
  for (const p of ["/review", "/", "/ops", ...(projectId ? [`/review/${projectId}`, `/projects/${projectId}`] : [])]) {
    try { revalidatePath(p); } catch { /* outside a request */ }
  }
}

/**
 * Approve this cut, then upload it to Aryeo and send it once its file is
 * ready. `verifyIssueIds` / `approveUncheckedFixes` are Approve's own;
 * `checkedRequests`: the person confirmed the job's open client requests are
 * right in the video.
 */
export async function approveAndSendAction(
  submissionId: string,
  opts: { verifyIssueIds?: string[] | null; approveUncheckedFixes?: boolean; checkedRequests?: boolean } = {},
): Promise<Result> {
  const no = await denied();
  if (no) return no;
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  if (opts?.checkedRequests !== undefined && typeof opts.checkedRequests !== "boolean") return { ok: false, message: "That choice is not valid." };
  if (opts?.approveUncheckedFixes !== undefined && typeof opts.approveUncheckedFixes !== "boolean") return { ok: false, message: "That choice is not valid." };
  if (opts?.verifyIssueIds != null && (!Array.isArray(opts.verifyIssueIds) || opts.verifyIssueIds.length > 200 || !opts.verifyIssueIds.every((x) => typeof x === "string" && ID.test(x)))) {
    return { ok: false, message: "That choice is not valid." };
  }
  try {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true, status: true } });
    if (!sub) return { ok: false, message: "That video no longer exists." };
    // An Aryeo listing video only: a portal video publishes by itself.
    const { loadCut } = await import("@/lib/finalRendition");
    const { usesAryeoDelivery } = await import("@/lib/videoDeliveryDestination");
    const cut = await loadCut(submissionId);
    if (!cut || !(await usesAryeoDelivery(cut))) return { ok: false, message: "This video goes to the client's portal by itself, so there is nothing to send to Aryeo. Use Approve." };
    const swr = await import("@/lib/sendWhenReady");
    // A double press, or a tab drawn before someone else approved it: the
    // press that approved it decides what happens next, never this one.
    const alreadyApproved = async (): Promise<Result> => {
      const { intent } = await swr.readSendIntent(submissionId);
      if (intent && (intent.state === "waiting" || intent.state === "starting" || intent.state === "started")) return { ok: true, message: "Already approved, and it is set to upload to Aryeo and send once it is ready." };
      return { ok: false, message: "Someone approved this a moment ago, so nothing was set to send. Send it from Ready to send." };
    };
    if (sub.status === "APPROVED") return await alreadyApproved();

    const { approveCut } = await import("@/app/review/actions");
    const a = await approveCut(submissionId, { verifyIssueIds: opts?.verifyIssueIds ?? null, approveUncheckedFixes: opts?.approveUncheckedFixes === true });
    if (!a.ok) return a;
    if (a.message === "Already approved.") return await alreadyApproved();
    const now = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { status: true, topazJob: { select: { id: true } } } });
    if (now?.status !== "APPROVED") return { ok: false, message: "Approved, then changed again a moment ago. Reload the page." };

    const by = await actor();
    // Every request the press showed, the ones the send is held on included
    // (clientAsks.confirmAsksForSend, Oct 30 2026: 265 Mill Rd stuck).
    if (opts?.checkedRequests === true) {
      const { confirmAsksForSend } = await import("@/lib/clientAsks");
      const c = await confirmAsksForSend(sub.projectId, "video", by).then(() => null, (e: unknown) => (e as Error)?.message || "the save failed");
      if (c) {
        refresh(sub.projectId);
        return { ok: true, message: `Approved, but not set to send: the client's requests could not be marked checked (${c}). Send it from Ready to send once they are.` };
      }
    }

    await swr.putSendIntent(prisma, { submissionId, projectId: sub.projectId, by, at: new Date().toISOString(), source: "approve", topazJobId: now.topazJob?.id ?? null });
    // No Topaz pass to wait for (or one already finished): it goes now.
    const outcome = await swr.settleSendWhenReady(submissionId);
    const { intent } = await swr.readSendIntent(submissionId);
    refresh(sub.projectId);
    if (outcome === "started") return { ok: true, message: "Approved, and on its way: uploading it to the Aryeo listing, then sending the listing to the client." };
    if (outcome === "not-sent" || intent?.state === "not-sent") return { ok: true, message: `Approved, but not sent: ${intent?.note ?? "the hub could not start it"} Send it from Ready to send.` };
    return { ok: true, message: `Approved. Once the Topaz file is back and checked, the hub uploads it to Aryeo and sends it. ${swr.SEND_WHEN_READY_SAYS.waitsForYou}` };
  } catch (e) {
    console.error("[send-when-ready] approve and send failed", submissionId, e);
    return { ok: false, message: "That didn't go through. Reload the page to see what is saved, then try again." };
  }
}

/** Don't send it automatically: the waiting send ends; it waits for a person's press. */
export async function cancelSendWhenReadyAction(submissionId: string): Promise<Result> {
  const no = await denied();
  if (no) return no;
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { cancelSendWhenReady } = await import("@/lib/sendWhenReady");
    const r = await cancelSendWhenReady(submissionId, await actor());
    refresh();
    return r;
  } catch (e) {
    console.error("[send-when-ready] cancel failed", submissionId, e);
    return { ok: false, message: "That didn't go through. Reload the page to see what is saved, then try again." };
  }
}

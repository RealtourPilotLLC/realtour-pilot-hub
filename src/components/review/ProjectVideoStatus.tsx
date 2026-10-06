import { videoNavigationFor } from "@/lib/videoNavigation";
import Link from "next/link";
import { CorrectSent } from "@/components/ops/CorrectSent";
import { prisma } from "@/lib/prisma";
import { cutSlots, owedSlotKeyOf } from "@/lib/reviewCuts";
import { uploadedForDelivery } from "@/lib/deliveryUploads";
import { monthlyPortalHandoffsFor } from "@/lib/cutEntitlement";
import { etDateTime } from "@/lib/datetime";
import { usesAryeoDelivery } from "@/lib/videoDeliveryDestination";
import { laneStillOwesWork } from "@/lib/readyToSend";

async function readStatus(projectId: string) {
  try {
    const [slots, cuts, navigation] = await Promise.all([
      cutSlots(projectId),
      prisma.reviewSubmission.findMany({ where: { projectId, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } }, orderBy: [{ round: "desc" }, { createdAt: "desc" }], include: { topazJob: true, project: { select: { contentMonthId: true, aryeoListingId: true, status: true } }, deliverable: { select: { type: true, label: true, productTitle: true, videoStyle: true } } } }),
      videoNavigationFor(projectId),
    ]);
    const [portal, windows, reviewers] = await Promise.all([
      monthlyPortalHandoffsFor(cuts.map((cut) => cut.id)),
      prisma.contentReviewWindow.findMany({ where: { submissionId: { in: cuts.map((cut) => cut.id) } }, select: { submissionId: true, state: true } }),
      prisma.teamMember.findMany({ where: { id: { in: cuts.map((cut) => cut.reviewerTeamMemberId).filter((id): id is string => !!id) } }, select: { id: true, name: true } }),
    ]);
    return await Promise.all(slots.map(async (slot, index) => {
      const cut = cuts.find((cut) => owedSlotKeyOf(cut, slots.map((slot) => `${slot.deliverableId}:${slot.slot}`)) === `${slot.deliverableId}:${slot.slot}`);
      const aryeo = cut ? await usesAryeoDelivery(cut) : false;
      const uploaded = cut && !cut.sentToClientAt && aryeo ? (await uploadedForDelivery(cut.id)).ok : false;
      const reviewer = reviewers.find((member) => member.id === cut?.reviewerTeamMemberId)?.name ?? "Reviewer";
      const clientState = windows.find((window) => window.submissionId === cut?.id)?.state;
      // Oct 5: an approved cut still in the 1080p pass is not something to
      // upload or publish yet — say what it is waiting on, not the next step.
      const rendering = !!cut?.topazJob && laneStillOwesWork(cut.topazJob.state) && !cut.sentToClientAt;
      // A HELD file is finished and waiting on a person, not a pass running
      // (review, Oct 5 night) — said as what it is.
      const heldRender = rendering && cut?.topazJob?.state === "held";
      const renderWords = heldRender ? "1080p on hold — Kyle has the next step" : "1080p pass running";
      const state = !cut ? "Awaiting edit · Editor" : cut.status === "CHANGES_REQUESTED" ? "Changes requested · Editor" : cut.status !== "APPROVED" ? `Needs review · ${reviewer}` : aryeo && cut.sentToClientAt ? `Sent · ${cut.sentToClientBy ?? "Office"} · ${etDateTime(cut.sentToClientAt)}` : aryeo && rendering ? `Approved · ${renderWords} · then Kyle uploads to Aryeo` : aryeo ? uploaded ? "Uploaded, not sent · Kyle: send listing" : "Approved · Kyle: upload to Aryeo" : portal.has(cut.id) ? `In client portal · ${cut.clientReleasedAt ? etDateTime(cut.clientReleasedAt) : "Publication recorded"} · ${clientState === "APPROVED" || clientState === "AUTO_APPROVED" ? "Client approved" : clientState === "CHANGES_REQUESTED" ? "Client changes requested" : "Awaiting client review"}` : rendering ? `Approved · ${renderWords} · then the client's portal` : "Approved · Portal publication pending";
      return { key: `${slot.deliverableId}:${slot.slot}`, label: `Video ${navigation.get(`${slot.deliverableId}:${slot.slot}`)?.number ?? index + 1} of ${navigation.get(`${slot.deliverableId}:${slot.slot}`)?.total ?? slots.length} · ${cut ? `V${cut.round}` : "Awaiting edit"}`, state, approval: cut?.status === "APPROVED" && cut.decidedAt ? `Approved by ${cut.decidedBy ?? "Reviewer"} · ${etDateTime(cut.decidedAt)}` : null, correction: cut?.sentToClientAt && aryeo ? { id: cut.id, at: cut.sentToClientAt.toISOString() } : null, href: cut ? `/review/${projectId}?cut=${cut.id}` : `/review/${projectId}?output=${slot.deliverableId}:${slot.slot}` };
    }));
  } catch { return null; }
}

/** Office summary; a failed read is never an all-clear or a second queue.
 *  Folded to one line (Oct 5 — the Room keeps the cut, the player, the notes
 *  and the verdict up front): this video's state in the summary, every video's
 *  state and next action one tap away. A failed read is never folded away. */
export async function ProjectVideoStatus({ projectId, selectedKey }: { projectId: string; selectedKey?: string | null }) {
  const rows = await readStatus(projectId);
  const selected = rows?.find((row) => row.key === selectedKey);
  if (!rows) return <section className="rounded-xl border border-border p-4"><h2 className="font-semibold">Project status</h2><p role="alert" className="text-sm">Status unavailable. Refresh before acting on delivery or remaining work.</p></section>;
  return <details className="rounded-xl border border-border px-4 py-1">
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><span className="font-semibold">Project status</span><span className="min-w-0 truncate text-muted">{selected ? selected.state : `${rows.length} video${rows.length === 1 ? "" : "s"}`}</span></summary>
    {selected?.approval && <p className="pb-1 text-sm text-muted">{selected.approval}</p>}
    <ul className="divide-y divide-border border-t border-border">{rows.map((row) => <li key={row.key} className="space-y-1 py-2 text-sm"><Link className="font-medium text-brand" href={row.href}>{row.label}</Link><p>{row.state}</p>{row.approval && <p className="text-muted">{row.approval}</p>}{row.correction && <CorrectSent submissionId={row.correction.id} sentAt={row.correction.at} />}</li>)}</ul>
  </details>;
}

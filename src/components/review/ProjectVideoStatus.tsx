import Link from "next/link";
import { CorrectSent } from "@/components/ops/CorrectSent";
import { prisma } from "@/lib/prisma";
import { cutSlots, owedSlotKeyOf } from "@/lib/reviewCuts";
import { uploadedForDelivery } from "@/lib/deliveryUploads";
import { monthlyPortalHandoffsFor } from "@/lib/cutEntitlement";
import { etDateTime } from "@/lib/datetime";

async function readStatus(projectId: string) {
  try {
    const [slots, cuts] = await Promise.all([
      cutSlots(projectId),
      prisma.reviewSubmission.findMany({ where: { projectId, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } }, orderBy: [{ round: "desc" }, { createdAt: "desc" }], include: { topazJob: true, project: { select: { contentMonthId: true } } } }),
    ]);
    const [portal, windows, reviewers] = await Promise.all([
      monthlyPortalHandoffsFor(cuts.map((cut) => cut.id)),
      prisma.contentReviewWindow.findMany({ where: { submissionId: { in: cuts.map((cut) => cut.id) } }, select: { submissionId: true, state: true } }),
      prisma.teamMember.findMany({ where: { id: { in: cuts.map((cut) => cut.reviewerTeamMemberId).filter((id): id is string => !!id) } }, select: { id: true, name: true } }),
    ]);
    return await Promise.all(slots.map(async (slot, index) => {
      const cut = cuts.find((cut) => owedSlotKeyOf(cut, slots.map((slot) => `${slot.deliverableId}:${slot.slot}`)) === `${slot.deliverableId}:${slot.slot}`);
      const uploaded = cut && !cut.sentToClientAt && !cut.project.contentMonthId ? (await uploadedForDelivery(cut.id)).ok : false;
      const reviewer = reviewers.find((member) => member.id === cut?.reviewerTeamMemberId)?.name ?? "Reviewer";
      const clientState = windows.find((window) => window.submissionId === cut?.id)?.state;
      const state = !cut ? "Awaiting edit · Editor" : cut.status === "CHANGES_REQUESTED" ? "Changes requested · Editor" : cut.status !== "APPROVED" ? `Needs review · ${reviewer}` : portal.has(cut.id) ? `In client portal · ${cut.clientReleasedAt ? etDateTime(cut.clientReleasedAt) : "Publication recorded"} · ${clientState === "APPROVED" || clientState === "AUTO_APPROVED" ? "Client approved" : clientState === "CHANGES_REQUESTED" ? "Client changes requested" : "Awaiting client review"}` : cut.sentToClientAt ? `Sent · ${cut.sentToClientBy ?? "Office"} · ${etDateTime(cut.sentToClientAt)}` : cut.project.contentMonthId ? "Approved · Portal publication pending" : uploaded ? "Uploaded, not sent · Kyle: send listing" : "Approved · Kyle: upload to Aryeo";
      return { key: `${slot.deliverableId}:${slot.slot}`, label: `Video ${index + 1} of ${slots.length} · ${cut ? `V${cut.round}` : "Awaiting edit"}`, state, approval: cut?.status === "APPROVED" && cut.decidedAt ? `Approved by ${cut.decidedBy ?? "Reviewer"} · ${etDateTime(cut.decidedAt)}` : null, correction: cut?.sentToClientAt && !cut.project.contentMonthId ? { id: cut.id, at: cut.sentToClientAt.toISOString() } : null, href: cut ? `/review/${projectId}?cut=${cut.id}` : `/review/${projectId}?output=${slot.deliverableId}:${slot.slot}` };
    }));
  } catch { return null; }
}

/** Office summary; a failed read is never an all-clear or a second queue. */
export async function ProjectVideoStatus({ projectId, selectedKey }: { projectId: string; selectedKey?: string | null }) {
  const rows = await readStatus(projectId);
  const selected = rows?.find((row) => row.key === selectedKey);
  return <section className="rounded-xl border border-border p-4"><h2 className="font-semibold">Project status</h2>{rows ? <>
    {selected && <div className="mt-2 text-sm"><p className="font-medium">{selected.label} · {selected.state}</p>{selected.approval && <p className="text-muted">{selected.approval}</p>}</div>}
    <details className="mt-2"><summary className="flex min-h-11 cursor-pointer items-center text-sm">All {rows.length} videos · status and next actions</summary><ul className="divide-y divide-border">{rows.map((row) => <li key={row.key} className="space-y-1 py-2 text-sm"><Link className="font-medium text-brand" href={row.href}>{row.label}</Link><p>{row.state}</p>{row.approval && <p className="text-muted">{row.approval}</p>}{row.correction && <CorrectSent submissionId={row.correction.id} sentAt={row.correction.at} />}</li>)}</ul></details>
  </> : <p role="alert" className="text-sm">Status unavailable. Refresh before acting on delivery or remaining work.</p>}</section>;
}

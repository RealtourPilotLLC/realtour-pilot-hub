import type { QueueTask } from "@/components/queue/TaskCard";
import { scrubMoney } from "@/lib/text";

// No money on an ADMIN screen (Jordan's standing rule). A Slack to-do's title
// ("… with $750 credit applied"), a client's ask in a summary, a customer note
// ("always haggles on the reel price") all render on a task card, so for a
// non-owner every figure is redacted before the card sees it — the sentence
// stays, the number goes (audit5 kyle-home §5, Sep 8). Idempotent.
//
// One rule for every screen that draws a TaskCard: the Tasks board and the job
// page's Open tasks (Oct 20 2026, audit A1: the job page passed them raw).
const sm = (v: string | null | undefined) => (v == null ? v : scrubMoney(v));

export function scrubTaskMoney<T extends QueueTask>(v: T): T {
  return {
    ...v,
    title: scrubMoney(v.title),
    summary: sm(v.summary) ?? null,
    description: sm(v.description) ?? null,
    reasonCreated: sm(v.reasonCreated) ?? null,
    deliverables: v.deliverables.map((d) => ({ ...d, label: scrubMoney(d.label) })),
    qcClient: v.qcClient
      ? {
          ...v.qcClient,
          customerNote: sm(v.qcClient.customerNote) ?? null,
          usuallyAsks: v.qcClient.usuallyAsks.map(scrubMoney),
          dos: v.qcClient.dos.map(scrubMoney),
          donts: v.qcClient.donts.map(scrubMoney),
        }
      : v.qcClient,
    siblings: v.siblings?.map((s) => ({ ...s, title: scrubMoney(s.title) })),
  };
}

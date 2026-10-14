import "server-only";

import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { verifyDelivery } from "./delivery";
import { alertOwnerAndKyle } from "./notifyOps";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// Jobs marked DELIVERING in the hub wait for Aryeo to say the listing was
// delivered (plan §9.6 step 5). Every 5 minutes: check up to `max` of them.
// Two hours without Aryeo's confirmation → one reminder to Kyle (Slack/bell);
// the job stays DELIVERING. Read-only toward Aryeo.
// ---------------------------------------------------------------------------
export async function verifyDeliveringJobs(opts: { max?: number; now?: Date } = {}): Promise<{ checked: number; verified: number; mismatched: number; reminded: number }> {
  const now = opts.now ?? new Date();
  const jobs = await prisma.photoJob.findMany({
    where: { stage: "DELIVERING" },
    orderBy: { deliveryStartedAt: "asc" },
    select: { id: true, projectId: true, deliveryStartedAt: true },
    take: opts.max ?? 5,
  });
  let verified = 0, mismatched = 0, reminded = 0;
  for (const j of jobs) {
    const r = await verifyDelivery(j.id, "verify-sweep");
    if (r.ok) verified++;
    else if (!r.waiting) mismatched++;
    else if (j.deliveryStartedAt && now.getTime() - j.deliveryStartedAt.getTime() > 2 * 3_600_000) {
      const p = await prisma.project.findUnique({ where: { id: j.projectId }, select: { title: true } });
      const street = (p?.title ?? "this listing").split(",")[0];
      const sent = await alertOwnerAndKyle({
        kind: "photo_delivery_waiting",
        title: `Not delivered in Aryeo yet: ${street}`.slice(0, 90),
        body: "Marked as delivering in the hub 2 hours ago, but Aryeo has not delivered the listing.",
        href: `/ops/photo-delivery/${j.id}`,
        dedupeKey: `pd-waiting-${j.id}`,
        text: `${street} was marked as delivering 2 hours ago, but Aryeo still shows it undelivered. Finish it in Aryeo: ${appBase()}/ops/photo-delivery/${j.id}`,
        to: "kyle",
      });
      if (sent.announced) {
        reminded++;
        await logJobEvent(j.id, "verify-sweep", "reminded Kyle: Aryeo has not delivered the listing after 2 hours");
      }
    }
  }
  return { checked: jobs.length, verified, mismatched, reminded };
}

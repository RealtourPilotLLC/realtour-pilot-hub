import "server-only";

import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { verifyDelivery } from "./delivery";
import { alertOwnerAndKyle } from "./notifyOps";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// Jobs marked DELIVERING in the hub wait for Aryeo to say the listing was
// delivered (plan §9.6 step 5). Read-only toward Aryeo.
//
// Oct 14 2026 (huddle finding 12: "why delivery status sometimes needed
// manual verification"): the sweep used to take the 5 OLDEST jobs every pass,
// so a sixth job never got its turn while older ones sat waiting, and it ran
// near the end of the cron where a slow pass skipped it. Now:
//   · it runs early in the cron, and takes the jobs checked LONGEST AGO first
//     (round robin), so every job gets its turn;
//   · a job is checked every pass for its first hour, then every 15 minutes,
//     then hourly after a day (no job is ever dropped);
//   · Aryeo's "listing delivered" webhook checks the job at once
//     (verifyForListing), and so does Mark as delivering;
//   · every check writes when it ran and what Aryeo said (errors too), and
//     the Deliver panel shows it with the next check.
// Two hours without Aryeo's confirmation → one reminder to Kyle (Slack/bell);
// the job stays DELIVERING.
// ---------------------------------------------------------------------------

/** A job in DELIVERY_MISMATCH: checked again hourly. */
export const MISMATCH_RECHECK_MS = 60 * 60_000;

/** How long to wait between checks of one job, by how long it has been waiting. */
export function checkEveryMs(waitingMs: number): number {
  if (waitingMs < 3_600_000) return 4 * 60_000;
  if (waitingMs < 24 * 3_600_000) return 15 * 60_000;
  return 60 * 60_000;
}

export async function verifyDeliveringJobs(opts: { max?: number; now?: Date } = {}): Promise<{ checked: number; verified: number; mismatched: number; reminded: number; errors: number; notDue: number }> {
  const now = opts.now ?? new Date();
  // Oct 22 2026: a job in DELIVERY_MISMATCH is looked at again hourly, so a
  // fixed listing (a floor plan added, a photo put back) clears by itself and
  // the board never shows a mismatch Aryeo has moved past.
  const all = await prisma.photoJob.findMany({
    where: { stage: { in: ["DELIVERING", "DELIVERY_MISMATCH"] } },
    orderBy: [{ deliveryCheckedAt: { sort: "asc", nulls: "first" } }, { deliveryStartedAt: "asc" }],
    select: { id: true, projectId: true, stage: true, deliveryStartedAt: true, deliveryCheckedAt: true },
    take: 50,
  });
  const due = all.filter((j) => !j.deliveryCheckedAt || now.getTime() - j.deliveryCheckedAt.getTime() >= (j.stage === "DELIVERY_MISMATCH" ? MISMATCH_RECHECK_MS : checkEveryMs(now.getTime() - (j.deliveryStartedAt ?? now).getTime())));
  const jobs = due.slice(0, opts.max ?? 8);
  let verified = 0, mismatched = 0, reminded = 0, errors = 0;
  for (const j of jobs) {
    const r = await verifyDelivery(j.id, "verify-sweep");
    if (r.ok) verified++;
    else if (r.error) errors++;
    else if (!r.waiting) mismatched++;
    else if (j.stage === "DELIVERING" && j.deliveryStartedAt && now.getTime() - j.deliveryStartedAt.getTime() > 2 * 3_600_000) {
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
  return { checked: jobs.length, verified, mismatched, reminded, errors, notDue: all.length - due.length };
}

/** Aryeo said a listing was delivered (its webhook): check the photo jobs on it now. */
export async function verifyForListing(listingId: string): Promise<{ checked: number; verified: number }> {
  const projects = await prisma.project.findMany({ where: { aryeoListingId: listingId }, select: { id: true }, take: 5 });
  if (!projects.length) return { checked: 0, verified: 0 };
  const jobs = await prisma.photoJob.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, stage: { in: ["DELIVERING", "DELIVERY_MISMATCH", "READY", "QC_REVIEW"] } }, select: { id: true, stage: true, deliveryCheckedAt: true }, take: 5 });
  let checked = 0, verified = 0;
  for (const j of jobs) {
    // Only a job someone marked as delivering, or one that already failed a check, is compared now.
    if (!["DELIVERING", "DELIVERY_MISMATCH"].includes(j.stage)) continue;
    if (j.deliveryCheckedAt && Date.now() - j.deliveryCheckedAt.getTime() < 20_000) continue;
    checked++;
    if ((await verifyDelivery(j.id, "aryeo-webhook")).ok) verified++;
  }
  return { checked, verified };
}

/** Right after Mark as delivering: Kyle often delivered in Aryeo first, so look now and again shortly. */
export async function verifySoonAfterStart(jobId: string): Promise<void> {
  for (const waitMs of [0, 45_000, 90_000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
    if (job?.stage !== "DELIVERING") return;
    const r = await verifyDelivery(jobId, "verify-after-start");
    if (r.ok || !r.waiting) return;
  }
}

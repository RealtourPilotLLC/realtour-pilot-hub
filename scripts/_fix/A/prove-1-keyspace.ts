// SERIOUS 1 — PROOF, READ-ONLY, against the production rows the reviewer named.
//
// Replays the two key spaces over every job that carries a round with no
// deliverableId, and runs the REAL pure rule (revisionBrief.outstandingItems)
// with each, so the difference is the rule's own answer rather than a claim
// about it. No writes.
import { prisma } from "@/lib/prisma";
import { cutSlots, slotKeyOf, cutKeyOf, approvedSlotKeys } from "@/lib/reviewCuts";
import { outstandingItems, type ScopedItem } from "@/lib/revisionBrief";

// One item at scope "all" — what a one-line client ask on a one-video job
// analyses to (analyzeRevisionText: `cuts.length === 1 → "all"`).
const ONE_ASK: ScopedItem[] = [{ id: "i1", ask: "Trim the ending", cuts: null, scope: "all" }];

async function main() {
  const keyless = await prisma.reviewSubmission.findMany({
    where: { deliverableId: null },
    select: { id: true, projectId: true, slot: true, status: true, assetPath: true, deliverableId: true, project: { select: { title: true } } },
  });
  const projectIds = [...new Set(keyless.map((r) => r.projectId))];
  let fixed = 0;
  let stillHeld = 0;

  for (const pid of projectIds) {
    const owedKeys = (await cutSlots(pid).catch(() => [])).map((s) => slotKeyOf(s.deliverableId, s.slot));
    const rounds = await prisma.reviewSubmission.findMany({
      where: { projectId: pid, kind: "video", status: { notIn: ["WITHDRAWN", "UPLOAD_FAILED"] } },
      select: { id: true, deliverableId: true, slot: true, assetPath: true, status: true },
    });
    const title = keyless.find((r) => r.projectId === pid)?.project?.title ?? pid;

    // OLD: approvals keyed by cutKeyOf, compared against slot keys.
    const before = new Set(rounds.filter((r) => r.status === "APPROVED").map((r) => cutKeyOf(r)));
    // NEW: approvals re-keyed into the slot space the items are scoped in.
    const after = approvedSlotKeys(rounds, owedKeys);

    const openBefore = outstandingItems({ items: ONE_ASK, done: [], approvedKeys: before, owedKeys }).length;
    const openAfter = outstandingItems({ items: ONE_ASK, done: [], approvedKeys: after, owedKeys }).length;
    const approvals = rounds.filter((r) => r.status === "APPROVED").length;

    console.log(`\n${title}`);
    console.log(`  owed slots (${owedKeys.length}): ${owedKeys.join(", ") || "(none)"}`);
    console.log(`  approved rounds: ${approvals}   keyless rounds: ${rounds.filter((r) => !r.deliverableId).length}`);
    console.log(`  OLD approvedKeys (cutKeyOf) ∩ owed = ${[...before].filter((k) => owedKeys.includes(k)).length} of ${before.size}`);
    console.log(`  NEW approvedKeys (owedSlotKeyOf) ∩ owed = ${[...after].filter((k) => owedKeys.includes(k)).length} of ${after.size}`);
    console.log(`  a one-item "all" ask on this job:  BEFORE ${openBefore > 0 ? "STAYS OPEN FOR EVER" : "closes"}  →  AFTER ${openAfter > 0 ? "stays open" : "CLOSES"}`);
    if (openBefore > 0 && openAfter === 0) fixed++;
    if (openAfter > 0) stillHeld++;
  }

  console.log(`\n${projectIds.length} jobs carry a round with no deliverableId.`);
  console.log(`  ${fixed} that could never close now close on the approval they already have.`);
  console.log(`  ${stillHeld} still hold — the multi-slot jobs, where a Dropbox path cannot honestly be`);
  console.log(`  named as one of several videos (owedSlotKeyOf's header). The task's Complete button is the override.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

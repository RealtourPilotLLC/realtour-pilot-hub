// READ-ONLY pre-flight for the new hourly `outputUnits` step. It runs the
// sweep's OWN selection (every job that owes video, the bare ones first, then
// the rotation window) and, for each job it would touch, compares
// planOutputsForProject — the plan ensureOutputsForProject writes — against the
// rows that exist. Nothing is written: this is what the first production tick
// would DO, printed instead of done.
//
//   PATH=<node20>:$PATH NODE_OPTIONS=--conditions=react-server \
//     npx tsx scripts/_fix/R03/sweep-dryrun.ts [howMany]
import { prisma } from "@/lib/prisma";
import { planOutputsForProject } from "@/lib/deliverableOutputs";
import { slotKeyOf } from "@/lib/reviewCuts";

async function main() {
  const max = Number(process.argv[2] ?? 80);
  const owing = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      deliverables: { some: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
    },
    select: { id: true, title: true },
    orderBy: { id: "asc" },
  });
  const withRows = new Set((await prisma.deliverableOutput.groupBy({ by: ["projectId"] })).map((g) => g.projectId));
  const bare = owing.filter((p) => !withRows.has(p.id));
  console.log(`jobs owing video: ${owing.length} · with no rows at all: ${bare.length} · dry-running ${Math.min(max, owing.length)}\n`);

  const queue = [...bare, ...owing].slice(0, max);
  let wouldCreate = 0;
  let wouldRetire = 0;
  let wouldWaive = 0;
  let wouldUnwaive = 0;
  let wouldUnretire = 0;
  for (const p of queue) {
    const plan = await planOutputsForProject(p.id).catch(() => null);
    if (!plan) {
      console.log(`  ?? ${p.title} — plan could not be computed`);
      continue;
    }
    const rows = await prisma.deliverableOutput.findMany({
      where: { projectId: p.id },
      select: { deliverableId: true, slot: true, waivedAt: true, removedFromOrderAt: true },
    });
    const have = new Map(rows.map((r) => [slotKeyOf(r.deliverableId, r.slot), r]));
    const liveKeys = new Set(plan.slots.map((s) => slotKeyOf(s.deliverableId, s.slot)));
    const waivedKeys = new Set(plan.waived.map((s) => slotKeyOf(s.deliverableId, s.slot)));
    const bits: string[] = [];
    for (const k of [...liveKeys, ...waivedKeys]) {
      const row = have.get(k);
      if (!row) { wouldCreate++; bits.push(`create ${k}`); continue; }
      if (row.removedFromOrderAt) { wouldUnretire++; bits.push(`un-retire ${k}`); }
      if (waivedKeys.has(k) && !row.waivedAt) { wouldWaive++; bits.push(`waive ${k}`); }
      if (liveKeys.has(k) && row.waivedAt) { wouldUnwaive++; bits.push(`un-waive ${k}`); }
    }
    for (const [k, row] of have) {
      if (liveKeys.has(k) || waivedKeys.has(k) || row.removedFromOrderAt) continue;
      wouldRetire++;
      bits.push(`retire ${k}`);
    }
    if (bits.length > 0) console.log(`  ${p.title}: ${bits.join(", ")}`);
  }
  console.log(
    `\nthe first tick would: create ${wouldCreate} · retire ${wouldRetire} · un-retire ${wouldUnretire} · waive ${wouldWaive} · un-waive ${wouldUnwaive}`,
  );
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

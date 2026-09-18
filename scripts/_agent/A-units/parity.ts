// READ-ONLY PARITY TEST (audit WF-02 acceptance 1).
//
// scripts/_recon/slot-baseline.json holds the cut-slot key set of every live
// project as it stood BEFORE any of this work (645 projects, 922 slots). This
// compares that FILE against what the code produces now — never against a
// freshly computed cutSlots, which could be satisfied by changing both sides.
//
// `--outputs` compares the baseline against ensureOutputsForProject's PLAN
// (dry run, writes nothing) instead of against cutSlots directly.
import { readFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { cutSlots } from "@/lib/reviewCuts";

type Baseline = { takenAt: string; projects: number; slots: number; keys: Record<string, string[]> };

async function main() {
  const viaOutputs = process.argv.includes("--outputs");
  const planOutputsForProject = viaOutputs
    ? (await import("@/lib/deliverableOutputs")).planOutputsForProject
    : null;
  const path = process.argv.find((a) => a.endsWith(".json")) ?? "scripts/_agent/A-units/slot-baseline.json";
  const base: Baseline = JSON.parse(readFileSync(path, "utf8"));
  console.log(`baseline taken ${base.takenAt}: ${base.projects} projects, ${base.slots} slots`);
  console.log(`comparing against: ${viaOutputs ? "ensureOutputsForProject (dry run)" : "cutSlots()"}`);

  const ps = await prisma.project.findMany({
    where: { status: { notIn: ["CANCELLED"] } },
    select: { id: true, title: true },
    orderBy: { createdAt: "asc" },
  });

  // Every waived slot, by name — the only legitimate difference.
  const waivedKeys = new Map<string, string>();
  for (const d of await prisma.deliverable.findMany({
    where: { waivedAt: { not: null }, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
    select: { id: true, label: true, quantity: true, project: { select: { title: true } } },
  })) {
    waivedKeys.set(d.id, `${d.project?.title ?? "?"} — ${d.label ?? d.id} (x${d.quantity ?? 1})`);
  }

  let missing = 0, extra = 0, changed = 0, waivedDrop = 0, newProjects = 0, slots = 0;
  const notes: string[] = [];
  for (const p of ps) {
    const want = base.keys[p.id] ?? null;
    const got = planOutputsForProject
      ? (await planOutputsForProject(p.id).catch(() => null))?.slots.map((s) => `${s.deliverableId}:${s.slot}`) ?? []
      : (await cutSlots(p.id).catch(() => [])).map((s) => `${s.deliverableId ?? "-"}:${s.slot}`);
    slots += got.length;
    if (!want) {
      if (got.length) { newProjects++; notes.push(`NEW (not in baseline) ${p.title}: ${got.length} slots`); }
      continue;
    }
    const wantSet = new Set(want);
    const gotSet = new Set(got);
    const lost = want.filter((k) => !gotSet.has(k));
    const gained = got.filter((k) => !wantSet.has(k));
    if (!lost.length && !gained.length) continue;
    // A lost key whose deliverable is waived is the fix doing its job.
    const lostWaived = lost.filter((k) => waivedKeys.has(k.split(":")[0]));
    const lostReal = lost.filter((k) => !waivedKeys.has(k.split(":")[0]));
    waivedDrop += lostWaived.length;
    missing += lostReal.length;
    extra += gained.length;
    if (lostReal.length || gained.length) {
      changed++;
      notes.push(`MISMATCH ${p.title} (${p.id}) — lost ${JSON.stringify(lostReal)} gained ${JSON.stringify(gained)}`);
    } else {
      notes.push(`waived-only drop ${p.title}: ${lostWaived.map((k) => waivedKeys.get(k.split(":")[0])).join(", ")}`);
    }
  }
  for (const n of notes) console.log("  " + n);
  console.log(
    `\nprojects compared: ${ps.length} · slots now: ${slots}\n` +
      `MISMATCHED PROJECTS (illegitimate): ${changed}  [lost ${missing}, gained ${extra}]\n` +
      `waived slots legitimately dropped: ${waivedDrop}\n` +
      `projects not in the baseline (created since it was taken): ${newProjects}\n` +
      `waived VIDEO/SOCIAL_REEL rows in the database: ${waivedKeys.size}` +
      (waivedKeys.size ? `\n  ${[...waivedKeys.values()].join("\n  ")}` : ""),
  );
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

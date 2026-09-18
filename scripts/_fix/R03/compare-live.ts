// READ-ONLY. Runs the BASELINE outputsForProject and the CHANGED one side by
// side over the production jobs where the two could possibly disagree — every
// job that has ever had a video sent, plus the most recent jobs — and prints
// every row whose state or sentence moved. Nothing is written.
//
//   PATH=<node20>:$PATH NODE_OPTIONS=--conditions=react-server \
//     npx tsx scripts/_fix/R03/compare-live.ts
//
// BASELINE_REF defaults to HEAD; pass the commit before the change once it is
// committed. The temporary baseline module is deleted on the way out.
import { writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/prisma";
import { outputsForProject } from "@/lib/deliverableOutputs";

const exec = promisify(execFile);
const BASELINE_REF = process.env.BASELINE_REF ?? "HEAD";
// Beside this script, never in src/ — a process killed mid-run must not leave a
// stray module inside the application tree.
const BASELINE_PATH = join(process.cwd(), "scripts", "_fix", "R03", "_baseline-deliverableOutputs.ts");

async function main() {
  const { stdout } = await exec("git", ["show", `${BASELINE_REF}:src/lib/deliverableOutputs.ts`], { maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(BASELINE_PATH, stdout);
  const baseline = (await import(BASELINE_PATH)) as typeof import("@/lib/deliverableOutputs");

  const sentSlots = await prisma.reviewSubmission.findMany({
    where: { sentToClientAt: { not: null } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const stamped = await prisma.deliverableOutput.findMany({
    where: { deliveredAt: { not: null } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const recent = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true },
  });
  const ids = [
    ...new Set([
      ...sentSlots.map((r) => r.projectId),
      ...stamped.map((r) => r.projectId),
      ...recent.map((r) => r.id),
    ]),
  ];
  console.log(`comparing ${ids.length} jobs (baseline ${BASELINE_REF})\n`);

  let rows = 0;
  let moved = 0;
  let gainedOwner = 0;
  let gainedDue = 0;
  for (const id of ids) {
    const [now, then] = await Promise.all([outputsForProject(id), baseline.outputsForProject(id)]);
    const thenByKey = new Map(then.map((r) => [r.key, r]));
    for (const n of now) {
      rows++;
      const t = thenByKey.get(n.key);
      if (!t) continue;
      if (n.ownerName && !t.ownerName) gainedOwner++;
      if (n.promisedAt && !t.promisedAt) gainedDue++;
      if (n.state !== t.state || n.detail !== t.detail) {
        moved++;
        const p = await prisma.project.findUnique({ where: { id }, select: { title: true, status: true } });
        console.log(`  ${p?.title} [${p?.status}] · ${n.label}`);
        console.log(`      was: ${t.state} / ${t.detail}`);
        console.log(`      now: ${n.state} / ${n.detail}`);
      }
    }
  }
  console.log(`\n${rows} rows read · ${moved} changed state or sentence · ${gainedOwner} gained an owner · ${gainedDue} gained a deadline`);
}

main()
  .then(() => {
    if (existsSync(BASELINE_PATH)) rmSync(BASELINE_PATH);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    if (existsSync(BASELINE_PATH)) rmSync(BASELINE_PATH);
    process.exit(1);
  });

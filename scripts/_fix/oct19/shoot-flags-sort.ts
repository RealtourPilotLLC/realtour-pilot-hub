// ---------------------------------------------------------------------------
// SHOOT FLAGS SORTED (Oct 19 2026; lib/shootIssues, lib/fieldIssues). Jordan:
// a creative's flag "that doesn't relate to photo editing or video editing or
// delivery ... should just go to me". New flags are sorted as they come in;
// this sorts the shoot-issue loops already open on Kyle's list:
//   · every flag on the loop is about the shoot itself (late, access, the
//     house not ready, equipment, scheduling, the client's behaviour) → the
//     loop moves to Jordan (assigned "jordan", his key shoot-owner-<job>);
//   · any flag about the photos, the video or delivery, or unsure → it stays
//     with Kyle (Jordan's Home still counts the shoot-side ones by client).
// Each flag is read with the same word rule the hub now uses (sortShootFlag),
// from the job's FLAG rows written since the loop opened (else the loop's own
// words).
//
//   DRY RUN (default, on a read-only connection, proved) · --apply
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct19/shoot-flags-sort.ts
// ---------------------------------------------------------------------------
export {};
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "../../_lib/dbGuard";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!APPLY) pinReadOnlyDatabaseUrl();
  const { prisma } = await import("@/lib/prisma");
  if (!APPLY) {
    await proveReadOnly(prisma);
    console.log("DRY RUN on a read-only connection (proved, 25006). Nothing is written.\n");
  }
  const { sortShootFlag, ownerShootLoopKey } = await import("@/lib/shootIssues");
  const { isFieldFlag } = await import("@/lib/debrief");
  const loops = await prisma.smartTask.findMany({
    where: {
      taskType: "internal_instruction",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      projectId: { not: null },
      OR: [
        { dedupeKey: { startsWith: "field-flag-" } },
        { dedupeKey: { startsWith: "shoot-issue-" } },
        { source: "manual", OR: [{ sourceDetail: { startsWith: "/upload/" } }, { sourceDetail: { startsWith: "/shoot/" } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, projectId: true, assignedKey: true, createdAt: true, description: true, title: true, sourceDetail: true, project: { select: { title: true, client: { select: { name: true } } } } },
  });
  const jordan = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Jordan", mode: "insensitive" }, active: true }, select: { id: true } });
  console.log(`Open shoot-issue loops: ${loops.length} (by assignee: ${JSON.stringify(loops.reduce<Record<string, number>>((a, l) => ((a[l.assignedKey ?? "none"] = (a[l.assignedKey ?? "none"] ?? 0) + 1), a), {}))}).\n`);

  let toJordan = 0;
  for (const l of loops) {
    const flags = await prisma.activity.findMany({
      where: { projectId: l.projectId!, type: "FLAG", createdAt: { gte: new Date(l.createdAt.getTime() - 10 * 60_000) } },
      orderBy: { createdAt: "asc" },
      select: { body: true },
    });
    const words = flags.map((f) => f.body).filter(isFieldFlag);
    const read = (words.length ? words : [l.description ?? l.title]).map((w) => ({ w, s: sortShootFlag(w) }));
    const allOwner = read.length > 0 && read.every((x) => x.s.route === "owner");
    const someOwner = read.some((x) => x.s.route === "owner" || x.s.route === "both");
    const where = allOwner ? "MOVE TO JORDAN" : someOwner ? "stays with Kyle (some shoot-side words: counted on Jordan's list)" : "stays with Kyle";
    const street = (l.project?.title ?? "a job").split(",")[0].trim();
    console.log(`${where} | ${l.project?.client?.name ?? "?"} | ${street} | assigned ${l.assignedKey ?? "nobody"}`);
    for (const x of read) console.log(`    · [${x.s.route}/${x.s.about}] ${x.w.replace(/\s+/g, " ").slice(0, 140)}`);
    if (!allOwner) continue;
    toJordan++;
    if (APPLY) {
      const key = ownerShootLoopKey(l.projectId!);
      const taken = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } });
      await prisma.smartTask.update({
        where: { id: l.id },
        data: {
          assignedKey: "jordan",
          ownerId: jordan?.id ?? null,
          title: `Shoot issue: ${street}`.slice(0, 120),
          sourceDetail: `owner ${l.sourceDetail ?? ""}`.trim().slice(0, 200),
          ...(taken ? {} : { dedupeKey: key }),
        },
      });
      console.log(`    moved to Jordan${taken ? " (his loop for this job already existed; this one keeps its own key)" : ""}`);
    }
  }
  console.log(`\n${loops.length} open loops: ${toJordan} ${APPLY ? "moved" : "would move"} to Jordan, ${loops.length - toJordan} stay with Kyle.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

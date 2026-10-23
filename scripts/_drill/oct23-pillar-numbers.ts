// ---------------------------------------------------------------------------
// DRILL: A NUMBERED PILLAR LABEL IS THE PILLAR (Oct 23 2026). Bernadette
// Rabel's skit-only topic refresh came back with "Pillar 3: Personal Brand &
// Trust Builder" and was refused as an unknown pillar (NEEDS_INPUT), so her
// bank never got its skit ideas.
//   · the validator accepts "Pillar 3: X" for the strategy pillar "X" (and a
//     strategy that numbers its own pillars against an unnumbered label);
//   · a truly unknown pillar is still refused;
//   · resolvePillarByLabel finds the pillar from the numbered label, and an
//     exact match still wins.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

async function main(): Promise<void> {
  installNextStubs();
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7161) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { pillarKey, validateTopicBank } = await import("@/lib/contentPolicy");
    c.head("1 · the key");
    c.ok("'Pillar 3: Personal Brand & Trust Builder' keys as the pillar", pillarKey("Pillar 3: Personal Brand & Trust Builder") === pillarKey("Personal Brand & Trust Builder"));
    c.ok("'pillar 4 - Lehigh Valley…' too", pillarKey("pillar 4 - Lehigh Valley Lifestyle") === pillarKey("Lehigh Valley Lifestyle"));
    c.ok("a name that merely contains the word is untouched", pillarKey("The Pillar of the Community") !== pillarKey("of the Community"));

    c.head("2 · the validator");
    const bank = (name: string) => ({ clientId: "c", clientName: "Drill", intro: [], strategyVersion: "v1", stamp: "s", pillars: [{ pillarId: null, name, purpose: null, topics: [] }] });
    const unknown = (name: string, strategy: string[]) => validateTopicBank(bank(name) as never, { topicsPerPillar: 10, mode: "generated", strategyPillarNames: strategy }).findings.some((f: { code: string }) => f.code === "pillar.unknown");
    c.ok("a numbered label is the strategy's pillar", !unknown("Pillar 3: Personal Brand & Trust Builder", ["Personal Brand & Trust Builder"]));
    c.ok("an unnumbered label against a numbered strategy pillar", !unknown("Personal Brand & Trust Builder", ["Pillar 3: Personal Brand & Trust Builder"]));
    c.ok("a pillar the strategy does not have is still refused", unknown("Pillar 9: Crypto Tips", ["Personal Brand & Trust Builder"]));

    c.head("3 · the resolver");
    const { prisma } = await import("@/lib/prisma");
    const { resolvePillarByLabel, createPillar } = await import("@/lib/contentPillars");
    const f = await buildContentMonth(prisma as never, { name: "Pillar Drill TEST", package: "Starter" });
    const enr = { id: f.enrollmentId }, client = { id: f.clientId };
    const brand = await createPillar({ enrollmentId: enr.id, clientId: client.id, name: "Personal Brand & Trust Builder", createdBy: "drill" });
    const exact = await createPillar({ enrollmentId: enr.id, clientId: client.id, name: "Pillar 4: Local Life", createdBy: "drill" });
    c.ok("the numbered label resolves to the pillar", (await resolvePillarByLabel(enr.id, "Pillar 3: Personal Brand & Trust Builder")) === brand);
    c.ok("an exact (numbered) name still resolves to itself", (await resolvePillarByLabel(enr.id, "Pillar 4: Local Life")) === exact);
    c.ok("an unknown label resolves to nothing", (await resolvePillarByLabel(enr.id, "Pillar 7: Crypto")) === null);
    c.summary();
  } finally {
    quiet.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

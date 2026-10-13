// Oct 13 2026 (Jordan: "this should never happen where v2 supersedes v3" /
// "Check all the other strategies too").
//
// Accepting a call's strategy proposal pasted the call analysis's "replacement
// text" over the WHOLE section, and that text was a fragment or an instruction
// (the analysis sees section headings, not their text). Each accepted proposal
// also made its own draft from the version in force, so the second one lacked
// the first's change. A scan of every client's versions found two damaged:
//
//   · Arielle Roemer: v2 (in force) Brand Overview = "Update all instances of
//     'Lita' to 'Lyda'…"; v3 (pushed aside) Brand Overview = the core values
//     line only.
//   · Kristin Ciarmella: v3 (in force, released) Content Goals = one sentence
//     (6 goals gone); v2 (pushed aside) Content Pillars = Pillar 3 only. v2's
//     approval also minted a duplicate pillar "Malvern and Media Lifestyle and
//     Local Connection" beside the original.
//
// Each gets ONE new version: the last complete text (the imported v1) with
// BOTH approved changes applied by hand, exactly as Jordan approved them, made
// on the version in force and approved (the older versions read "replaced by a
// later version"). Kristin's is released, as her damaged v3 was; Arielle's
// never-released v2 stays unreleased (her portal shows v1 until Jordan
// releases). Kristin's duplicate pillar is folded into the original, which
// takes the new name (topics keep their pillar). Nothing is sent to anyone.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct13/repair-strategy-sections.ts [--apply]
import { prisma } from "@/lib/prisma";

type Sec = { id: string; heading: string; text: string };
const BY = "info@realtourpilot.com";

function swap(text: string, from: string, to: string, label: string): string {
  if (!text.includes(from)) throw new Error(`${label}: expected text not found: ${JSON.stringify(from.slice(0, 80))}`);
  return text.replace(from, to);
}

async function repair(o: { client: string; enrollmentId: string; goodVersionId: string; build: (s: Sec[]) => Sec[]; summary: string; release: boolean; apply: boolean }) {
  const { newestWorkingVersion, deriveStrategyVersion, approveStrategyVersion, releaseStrategyVersion, parseStoredSections } = await import("@/lib/contentStrategy");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: o.enrollmentId }, select: { clientId: true } });
  const c = e ? await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }) : null;
  if (c?.name !== o.client) throw new Error(`Not ${o.client}'s program — stopping.`);
  const good = await prisma.contentStrategyVersion.findUnique({ where: { id: o.goodVersionId }, select: { enrollmentId: true, sectionsJson: true, versionNo: true } });
  if (good?.enrollmentId !== o.enrollmentId) throw new Error("Wrong source version.");
  const sections = o.build(parseStoredSections(good.sectionsJson)!.sections as Sec[]);
  const base = await newestWorkingVersion(o.enrollmentId);
  if (!base || base.status !== "APPROVED") throw new Error(`${o.client}: expected the version in force to be the newest, found ${JSON.stringify(base)}`);
  const cur = parseStoredSections((await prisma.contentStrategyVersion.findUnique({ where: { id: base.id }, select: { sectionsJson: true } }))!.sectionsJson)!.sections;
  console.log(`\n## ${o.client}: v${base.versionNo} in force → new version from v${good.versionNo} + the approved changes`);
  for (const s of sections) {
    const now = cur.find((x) => x.id === s.id)?.text ?? "";
    if (now.trim() !== s.text.trim()) console.log(`--- ${s.heading}: ${now.length} → ${s.text.length} chars\n${s.text}\n`);
  }
  if (!o.apply) return;
  const r = await deriveStrategyVersion({ baseId: base.id, replace: new Map(sections.map((s) => [s.id, s.text])), by: BY, sourceKind: "manual", changeSummary: o.summary });
  console.log(`   created v${r.versionNo} (${r.changedSectionIds.join(", ")})`);
  const a = await approveStrategyVersion(r.versionId, BY);
  console.log(`   approved (pillars created: ${a.pillarsCreated})`);
  if (o.release) { await releaseStrategyVersion(r.versionId, BY); console.log("   released to the portal (the damaged version it replaces was released)"); }
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY" : "DRY RUN");

  // ---- Arielle Roemer ---------------------------------------------------------
  await repair({
    client: "Arielle Roemer", enrollmentId: "cmt7msany000c9kg1ospdeoza", goodVersionId: "cmuvdodul00019kl8sf1yh6my", release: false, apply,
    summary: "Repair (Oct 13 2026): Brand Overview restored from v1, which v2 and v3 had cut to a single line. Carries BOTH changes from the Sep 11 call: Lita → Lyda throughout, and 'results-driven' and 'proven track record' added to the core values.",
    build: (s) => s.map((x) => {
      let text = x.text.replace(/\bLita\b/g, "Lyda");
      if (x.id === "brand-overview") text = swap(text, "client advocacy,\nclear communication, and lasting relationships.", "client advocacy,\nclear communication, lasting relationships, results-driven, and proven track record.", "Arielle core values");
      return { ...x, text };
    }),
  });

  // ---- Kristin Ciarmella --------------------------------------------------------
  const KRISTIN = "cmt7n3fy1006x9kg1wl2rz5z9";
  const ORIGINAL = "cmv5hsh9g0004ju06fhirjo9x", DUPLICATE = "cmv72nk0r000bl906nh40n7xy";
  const NEW_NAME = "Malvern and Media Lifestyle and Local Connection";
  const v2 = await prisma.contentStrategyVersion.findUnique({ where: { id: "cmv72n5l90009l906f7ctf876" }, select: { sectionsJson: true } });
  const pillar3 = (JSON.parse(v2!.sectionsJson).sections as Sec[]).find((x) => x.id === "content-pillars")!.text
    .replace(/'/g, "’")
    .replace("Include West Chester, and broader geographic experience", "Include West Chester and broader geographic experience");
  if (!pillar3.startsWith("Pillar 3 Malvern and Media")) throw new Error("Kristin v2 pillar 3 text not as expected.");
  // The duplicate pillar folds into the original BEFORE approval, so the
  // approval finds the original by its new name and mints nothing.
  const dupUse = await Promise.all([
    prisma.contentTopic.count({ where: { pillarId: DUPLICATE } }), prisma.contentScript.count({ where: { pillarId: DUPLICATE } }),
  ]);
  console.log(`\nKristin's duplicate pillar "${NEW_NAME}": ${dupUse[0]} topic(s), ${dupUse[1]} script(s) → moved to the original, which is renamed to it; the duplicate is retired into it`);
  if (apply) {
    const { renamePillar, retirePillar } = await import("@/lib/contentPillars");
    await prisma.contentTopic.updateMany({ where: { pillarId: DUPLICATE }, data: { pillarId: ORIGINAL } });
    await prisma.contentScript.updateMany({ where: { pillarId: DUPLICATE }, data: { pillarId: ORIGINAL } });
    await prisma.contentPillarAlias.updateMany({ where: { pillarId: DUPLICATE }, data: { kind: "PREVIOUS", validTo: new Date() } });
    await prisma.contentPillar.update({ where: { id: DUPLICATE }, data: { name: `${NEW_NAME} (duplicate, merged)` } });
    await retirePillar(DUPLICATE, ORIGINAL);
    await renamePillar(ORIGINAL, NEW_NAME, BY);
  }
  await repair({
    client: "Kristin Ciarmella", enrollmentId: KRISTIN, goodVersionId: "cmuvdoew6000a9kl848lmlxns", release: true, apply,
    summary: "Repair (Oct 13 2026): Content Goals restored from v1 (v3 had cut them to one sentence) and Content Pillars restored (v2 had cut them to Pillar 3 only). Carries BOTH changes from the call: Pillar 3 now covers Malvern and Media, and the long-term positioning goal names Malvern and Media homeowners.",
    build: (s) => s.map((x) => {
      if (x.id === "brand-overview") return { ...x, text: swap(x.text, "moving guidance, particularly among Malvern homeowners.", "moving guidance, particularly among Malvern and Media homeowners.", "Kristin positioning goal") };
      if (x.id === "content-pillars") {
        const at = x.text.indexOf("Pillar 3 Malvern Lifestyle and Local Connection"), end = x.text.indexOf("Pillar 4 Planning the Next Move");
        if (at < 0 || end < at) throw new Error("Kristin pillar 3 block not found.");
        return { ...x, text: `${x.text.slice(0, at)}${pillar3.trim()}\n${x.text.slice(end)}` };
      }
      return x;
    }),
  });
  if (apply) {
    const ps = await prisma.contentPillar.findMany({ where: { enrollmentId: KRISTIN }, select: { name: true, status: true } });
    console.log("Kristin's pillars now:", ps.map((p) => `${p.name} (${p.status})`).join(" · "));
  }
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });

// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026): link the old free-text pillar labels to each
// client's CONFIRMED pillars, by the app's own rule. Never creates a pillar.
//
// Jordan: "I'm not sure why we have Pillar labels to map. We should just
// stick to their confirmed pillars that are in their content strategy, unless
// we discuss adding a new one on a strategy call or I add a new one in the
// hub." The Strategy tab's "Pillar labels to map" section is gone; this is
// the one pass over what it used to list:
//
//   · the rows: every topic with a free-text pillar label and no pillarId (the
//     section's rows), and every script whose current version carries a
//     Category label with neither the script nor the version linked to a
//     pillar (contentPillars.unlinkedPillarLabels);
//   · THE RULE (contentPillars.matchConfirmedPillar → contentPolicy/pillarMatch):
//     the label's name or alias, else the same name spelled differently
//     ("Pillar 3: X", "&" for "and"), else the first part of "A / B" that
//     matches, else the CLOSEST current pillar by words when it is close
//     (score ≥ 0.5), clearly closer than the next (by 0.1), shares a telling
//     word, and is not the other side of the deal (seller vs buyer);
//   · LINK through the app's own function (contentPillars.linkPillarLabel):
//     each topic gets the pillar and a RECONCILED event on its history saying
//     why, each script gets the pillar on its row (words, versions, approvals,
//     sharing and updatedAt untouched) and an audit-log row; the label is not
//     made an alias (the pillar's names stay its own);
//   · LEAVE: a label close to no confirmed pillar (or a quality dimension, or
//     a client with no confirmed pillars) keeps no pillar, as text; a label
//     Jordan answered "Not a pillar" to on the old section is left as he left
//     it. Nothing is queued for anyone, and no pillar is ever created (the
//     apply counts the client's pillars before and after and stops if they
//     differ).
//
// Dry run (default; read-only database connection):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-pillar-labels-auto-map.ts
// Write it:
//   ... scripts/_live/oct23-pillar-labels-auto-map.ts --apply
// One client only: --client "<name or enrollment id>"
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
const BY = "pillar label auto-map (Oct 23 2026)";
const only = (() => { const i = process.argv.indexOf("--client"); return i > 0 ? (process.argv[i + 1] ?? "").trim().toLowerCase() : ""; })();
const HOW: Record<string, string> = { name: "name", alias: "alias", spelling: "spelling", part: "part", closest: "closest" };

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { unlinkedPillarLabels, linkPillarLabel, listPillars } = await import("@/lib/contentPillars");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: old free-text pillar labels → each client's confirmed pillars (never a new pillar)\n`);

  const enrollments = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true }, orderBy: { createdAt: "asc" } });
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name?.replace(/\s+/g, " ").trim() || c.id]));
  const pillarCountBefore = await prisma.contentPillar.count();

  const totals = { clients: 0, labels: 0, linkedLabels: 0, linkedTopics: 0, linkedScripts: 0, leftLabels: 0, leftTopics: 0, leftScripts: 0, dismissedLabels: 0, dismissedTopics: 0, byHow: {} as Record<string, number> };
  const summary: string[] = [];
  for (const e of enrollments) {
    const name = clients.get(e.clientId) ?? e.clientId;
    if (only && !name.toLowerCase().includes(only) && e.id.toLowerCase() !== only) continue;
    const rows = await unlinkedPillarLabels(e.id);
    if (!rows.length) continue;
    totals.clients++;
    const pillars = await listPillars(e.id);
    const linked = rows.filter((r) => r.match && !r.dismissed);
    const left = rows.filter((r) => !r.match && !r.dismissed);
    const dismissed = rows.filter((r) => r.dismissed);
    const n = (rs: typeof rows) => ({ topics: rs.reduce((s, r) => s + r.topicCount, 0), scripts: rs.reduce((s, r) => s + r.scriptCount, 0) });
    const L = n(linked), R = n(left), D = n(dismissed);
    console.log(`== ${name} (${e.id}) · ${pillars.length} confirmed pillar${pillars.length === 1 ? "" : "s"}${pillars.length ? `: ${pillars.map((p) => p.name).join(" | ")}` : ""}`);
    console.log(`   ${rows.length} label${rows.length === 1 ? "" : "s"}: ${linked.length} → a pillar (${L.topics} topics, ${L.scripts} scripts) · ${left.length} left with no pillar (${R.topics} topics, ${R.scripts} scripts)${dismissed.length ? ` · ${dismissed.length} dismissed by Jordan, left (${D.topics} topics, ${D.scripts} scripts)` : ""}`);
    for (const r of linked) {
      const m = r.match!;
      console.log(`   → “${r.label}” [${r.topicCount}t/${r.scriptCount}s] → “${m.pillarName}”  (${HOW[m.how] ?? m.how}: ${m.why})`);
      totals.byHow[m.how] = (totals.byHow[m.how] ?? 0) + r.topicCount + r.scriptCount;
      if (APPLY) {
        const w = await linkPillarLabel(e.id, r.label, m.pillarId, BY, { why: `${m.how}: ${m.why}`, actorKind: "SYSTEM" });
        console.log(`       linked ${w.topics} topic(s), ${w.scripts} script(s)`);
        totals.linkedTopics += w.topics; totals.linkedScripts += w.scripts;
      } else { totals.linkedTopics += r.topicCount; totals.linkedScripts += r.scriptCount; }
    }
    for (const r of left) console.log(`   · “${r.label}” [${r.topicCount}t/${r.scriptCount}s] → no pillar (${r.reason ?? "no match"})${r.sample.length ? `  e.g. ${r.sample.slice(0, 2).join(" · ")}` : ""}`);
    for (const r of dismissed) console.log(`   · “${r.label}” [${r.topicCount}t/${r.scriptCount}s] → left as Jordan left it ("Not a pillar")${r.match ? `; the rule would say “${r.match.pillarName}”` : ""}`);
    console.log("");
    totals.labels += rows.length; totals.linkedLabels += linked.length; totals.leftLabels += left.length; totals.leftTopics += R.topics; totals.leftScripts += R.scripts;
    totals.dismissedLabels += dismissed.length; totals.dismissedTopics += D.topics;
    summary.push(`${name.padEnd(28)} ${String(linked.length).padStart(3)} labels → pillar (${String(L.topics).padStart(3)}t ${String(L.scripts).padStart(3)}s)   ${String(left.length).padStart(3)} left (${String(R.topics).padStart(3)}t ${String(R.scripts).padStart(3)}s)${dismissed.length ? `   ${dismissed.length} dismissed` : ""}${pillars.length ? "" : "   [no confirmed pillars]"}`);
  }

  const pillarCountAfter = await prisma.contentPillar.count();
  console.log("---- per client ----");
  for (const s of summary) console.log(s);
  console.log("\n---- totals ----");
  console.log(`${totals.clients} clients · ${totals.labels} labels · ${totals.linkedLabels} → a confirmed pillar (${totals.linkedTopics} topics, ${totals.linkedScripts} scripts${APPLY ? "" : ", would be linked"}) · ${totals.leftLabels} left with no pillar (${totals.leftTopics} topics, ${totals.leftScripts} scripts) · ${totals.dismissedLabels} dismissed by Jordan (${totals.dismissedTopics} topics)`);
  console.log(`items by how they matched: ${Object.entries(totals.byHow).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  console.log(`pillars: ${pillarCountBefore} before, ${pillarCountAfter} after${pillarCountBefore === pillarCountAfter ? " (none created)" : " — CHANGED, which this script never does: stop and look"}`);
  if (!APPLY) console.log("\nNothing was written (read-only connection). Run with --apply to link them.");
  await prisma.$disconnect();
  if (pillarCountBefore !== pillarCountAfter) process.exit(1);
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});

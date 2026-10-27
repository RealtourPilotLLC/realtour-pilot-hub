import { APPLY, db } from "./_oct22-guard";
// ---------------------------------------------------------------------------
// Oct 27 2026, the knowledge pile (Jordan: "I don't want to have to come in
// here and review everybody's information for their calls. AI should handle
// it. And if it can't figure it out, then get rid of it.").
//
// The 15-minute topics cron now curates two clients a pass on its own
// (lib/knowledgeCurator.ts). This clears what is already waiting, once, for
// every client: each undecided fact goes to where it is used (creative
// identity, one-line strategy notes, the editor's technical preferences, the
// shoot, the skit cast, the script writer, the team) or is dropped with the
// reason on it; dated one-offs are kept until a day after their date; a
// complaint on a call opens a client issue. Then each client whose knowledge
// changed gets its working profile refilled (contentPipeline
// .buildAgentProfileFromHistory, non-destructive), so "N filled" is filled.
//
// Dry run (default): reads only, on a connection proven read-only, and never
// calls a model. It lists who has how many facts waiting and what would be
// sent. --apply asks the model (labelled claude:, one call per 40 facts).
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-knowledge.ts [--apply] [--client <clientId>] [--no-profile]
// ---------------------------------------------------------------------------

const BY = "claude:oct27-loom-knowledge";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] ?? null : null; };
const ONLY = arg("--client");
const PROFILE = !process.argv.includes("--no-profile");
const MAX_PASSES = 6;

async function main() {
  const prisma = await db();
  const now = new Date();
  const kc = await import("../../src/lib/knowledgeCurator");
  const counts = (await kc.undecidedCounts()).filter((c) => !ONLY || c.clientId === ONLY);
  const names = new Map((await prisma.client.findMany({ where: { id: { in: counts.map((c) => c.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const total = counts.reduce((s, c) => s + c.n, 0);
  console.log(`\n${total} undecided fact(s) on ${counts.length} client(s):`);
  for (const c of counts) console.log(`  ${String(c.n).padStart(4)}  ${names.get(c.clientId) ?? c.clientId}  (${c.clientId})`);

  const oneOffs = await prisma.clientFact.count({ where: { status: "ACCEPTED", fieldKey: { startsWith: "oneoff." }, factDate: { lt: new Date(now.getTime() - 24 * 3600_000) } } });
  console.log(`\nkept one-offs already past (would expire): ${oneOffs}`);

  if (!APPLY) {
    // What the first batch per client would be (no model call).
    for (const c of counts.slice(0, 12)) {
      const facts = await kc.undecidedFacts(c.clientId, 6);
      console.log(`\n${names.get(c.clientId) ?? c.clientId}, first of ${c.n}:`);
      for (const f of facts) console.log(`  [${f.status} ${f.source}${f.fieldKey ? ` ${f.fieldKey}` : ""}${f.confidential ? " CONFIDENTIAL" : ""}] ${f.body.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    const calls = Math.ceil(counts.reduce((s, c) => s + Math.ceil(c.n / 40), 0));
    console.log(`\nDry run: nothing written, no model called. --apply would make about ${calls} curator call(s)${PROFILE ? " plus one profile fill per changed client" : ""}.`);
    return;
  }

  console.log("\nAPPLYING…");
  const exp = await kc.expireOneOffFacts(now);
  console.log(`one-offs expired: ${exp.expired}`);
  const changedClients = new Set<string>();
  const tally: Record<string, number> = {};
  let issues = 0, profileChanges = 0, failures = 0;
  for (const c of counts) {
    const who = names.get(c.clientId) ?? c.clientId;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const r = await kc.curateClientKnowledge(c.clientId, { requestedBy: BY, unattended: false, now: new Date() });
      if (!r.ok) { failures++; console.log(`  ${who}: stopped, nothing changed on this batch (${r.reason})`); break; }
      const changed = Object.values(r.applied).reduce((s, n) => s + n, 0);
      for (const [k, n] of Object.entries(r.applied)) tally[k] = (tally[k] ?? 0) + n;
      issues += r.issues; profileChanges += r.profileChanges;
      console.log(`  ${who}: pass ${pass + 1}, ${r.seen} seen, ${JSON.stringify(r.applied)}${r.issues ? `, ${r.issues} complaint(s) recorded` : ""}${r.skippedChanged.length ? `, ${r.skippedChanged.length} skipped (changed meanwhile)` : ""}${r.plan?.untouched.length ? `, ${r.plan.untouched.length} left for next time` : ""}`);
      if (changed) changedClients.add(c.clientId);
      if (r.seen < 40 || !changed) break;
    }
  }
  console.log(`\ncurated: ${JSON.stringify(tally)}; complaints recorded ${issues}; profile slots filled ${profileChanges}; failed batches ${failures}`);

  if (PROFILE && changedClients.size) {
    const { buildAgentProfileFromHistory } = await import("../../src/lib/contentPipeline");
    for (const id of changedClients) {
      const r = await buildAgentProfileFromHistory(id, { requestedBy: BY, unattended: false }).then((x) => JSON.stringify(x).slice(0, 200)).catch((e) => `failed: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`  profile ${names.get(id) ?? id}: ${r}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

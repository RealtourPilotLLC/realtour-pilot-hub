// ---------------------------------------------------------------------------
// LIVE, READ-ONLY EXCEPT AI RUN ROWS (Oct 22 2026). Jordan: "Erica's scripts
// are bad. Really weak hooks, and re-hooks, too long, and the close is not very
// memorable. It's like all the creative scripting rules for how we structure
// these was thrown out the window." Her five October drafts came from the old
// live writer (Oct 20), before the Oct 21-22 rules and the listening fix. This
// drafts each topic again with the new writer (scriptWriter draftOffline, as of
// now) for a side by side. No script, version, portal row or message is
// written: only the AI run records (scope offline). None of the five is shared.
// Jordan, same evening: "Fix Johns scripts too." John Collins's eight October
// scripts were all approved and shared Oct 13-15, so they are drafted here the
// same way for the side by side and NOTHING on his portal changes (the
// standing rule: a script already pushed is never edited or re-shared).
//   ... oct22-erica-redraft.ts <client name substring>   (default: Erica)
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_live/oct22-erica-redraft.ts
// ---------------------------------------------------------------------------
import fs from "node:fs";

const WHO = process.argv[2] ?? "Erica";
const OUT = `/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/8965ab24-8365-44d5-af17-c1b185a8a42d/scratchpad/erica/redraft-${WHO.toLowerCase().replace(/\W+/g, "-")}.json`;

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { draftOffline, partsOfVersion } = await import("../../src/lib/scriptWriter/pipeline");
  const { spokenTextOf } = await import("../../src/lib/scriptWriter/rules");
  const words = (t: string) => t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const clients = await prisma.client.findMany({ where: { name: { contains: WHO, mode: "insensitive" } }, select: { id: true, name: true } });
  const scripts = await prisma.contentScript.findMany({ where: { clientId: { in: clients.map((c) => c.id) }, createdAt: { gte: new Date("2026-10-01") } }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, topicId: true, monthId: true, callRecordId: true, currentVersionId: true, sharedAt: true, clientId: true } });
  console.log(`${scripts.length} scripts for ${clients.map((c) => c.name).join(", ")}`);
  const out: unknown[] = [];
  for (const s of scripts) {
    if (!s.topicId) continue;
    const cur = s.currentVersionId ? await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId }, select: { versionNo: true, hook: true, pointsJson: true, close: true } }) : null;
    console.log(`${s.title}: drafting...`);
    try {
      const r = await draftOffline({ topicId: s.topicId, monthId: s.monthId, asOf: null, requestedBy: "claude:erica-redraft-oct22", callRecordId: s.callRecordId });
      const curText = cur ? spokenTextOf(partsOfVersion(cur)) : "";
      out.push({ scriptId: s.id, title: s.title, shared: !!s.sharedAt, client: clients.find((c) => c.id === s.clientId)?.name, current: cur ? { versionNo: cur.versionNo, parts: partsOfVersion(cur), words: words(curText) } : null, newDraft: { parts: r.final.parts, words: r.final.words, seconds: r.final.seconds, closeType: r.final.closeType, state: r.state, attempts: r.attempts.map((a) => ({ label: a.label, words: a.words, mustFails: a.review?.mustFails ?? [] })), review: r.final.review }, brief: r.record.brief, hooks: (r.prepared as unknown as { hooks?: unknown }).hooks ?? null });
      console.log(`  ${r.state}, ${r.final.words} words (was ${words(curText)})`);
    } catch (e) {
      console.log(`  FAILED: ${String(e).slice(0, 300)}`);
      out.push({ scriptId: s.id, title: s.title, error: String(e).slice(0, 500) });
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  }
  console.log("wrote", OUT);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

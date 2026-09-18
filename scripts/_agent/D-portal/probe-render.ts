// READ-ONLY probe. Group D. 140 of the 142 topic-linked visible scripts are
// imports with no ContentScriptVersion row, so their words come from
// ContentScript.body. postingKit's fallback returns that body RAW rather than
// re-rendering it. Is that a real difference, or could we normalise safely?
// Measured here before deciding what 9 live client portals will show.
import { PrismaClient } from "@prisma/client";
import { canonicalFromParts, partsFromBody } from "../../../src/lib/contentScripts";
import { renderScript } from "../../../src/lib/contentPolicy";

const prisma = new PrismaClient();
const OLD = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];
function vis(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return OLD.includes(s.status) ? "released" : null;
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

async function main() {
  const rows = await prisma.contentScript.findMany({
    select: { id: true, title: true, body: true, clientId: true, topicId: true, status: true, releaseState: true, historical: true, sharedVersionId: true, approvedVersionId: true },
  });
  const fallback = rows.filter((r) => vis(r) !== null && r.topicId && !(r.sharedVersionId ?? r.approvedVersionId));
  console.log(`visible topic-linked scripts with no version row: ${fallback.length}`);
  let lost = 0, same = 0, grew = 0, worst = { id: "", raw: 0, out: 0 };
  for (const r of fallback) {
    let out = "";
    try { out = renderScript(canonicalFromParts(partsFromBody(r.title, r.body), r.clientId)); }
    catch { out = ""; }
    const a = words(r.body), b = words(out);
    if (b < a * 0.95) { lost++; if (a - b > worst.raw - worst.out) worst = { id: r.id, raw: a, out: b }; }
    else if (b > a * 1.05) grew++;
    else same++;
  }
  console.log(`  re-render keeps the words (±5%): ${same}`);
  console.log(`  re-render LOSES >5% of the words: ${lost}   worst: ${worst.id} ${worst.raw} -> ${worst.out} words`);
  console.log(`  re-render adds >5% (section labels): ${grew}`);

  // Payload: the worst enrollment's total body bytes, since all of it ships in one page.
  const byEnroll = new Map<string, number>();
  const all = await prisma.contentScript.findMany({ select: { enrollmentId: true, body: true, topicId: true, status: true, releaseState: true, historical: true } });
  for (const r of all) if (vis(r) !== null && r.topicId) byEnroll.set(r.enrollmentId, (byEnroll.get(r.enrollmentId) ?? 0) + Buffer.byteLength(r.body ?? ""));
  const top = [...byEnroll].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`\nworst-case extra page payload (script bodies per enrollment):`);
  for (const [id, bytes] of top) console.log(`  ${id}  ${(bytes / 1024).toFixed(1)} KB`);
}
main().finally(() => prisma.$disconnect());

// READ-ONLY probe. The legacy-body branch: when postingKit.scriptForVideo
// cannot resolve a released version row it used to serve ContentScript.body.
// contentScripts.syncLegacyPointer mirrors `shared ?? approved ?? the NEWEST
// DRAFT` into that column and exempts historical rows. Question: for how many
// client-visible scripts is that body a RECORD, and how many would the new
// fail-closed rule withhold?
import { prisma } from "../../../src/lib/prisma";

const CLIENT_VISIBLE_SCRIPT = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];
function visible(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return CLIENT_VISIBLE_SCRIPT.includes(s.status) ? "released" : null;
}

async function main() {
  const scripts = await prisma.contentScript.findMany({
    select: { id: true, title: true, body: true, status: true, releaseState: true, historical: true, enrollmentId: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true },
  });
  const versions = await prisma.contentScriptVersion.findMany({ select: { id: true, scriptId: true, enrollmentId: true, status: true, body: true, versionNo: true } });
  const byId = new Map(versions.map((v) => [v.id, v]));

  const vis = scripts.filter((s) => visible(s) !== null);
  const b = { resolves: 0, dangles: 0, historicalBody: 0, noVersionAtAll: 0, withheldByNewRule: 0 };
  const notes: string[] = [];
  for (const s of vis) {
    const rid = s.sharedVersionId ?? s.approvedVersionId ?? null;
    const v = rid ? byId.get(rid) : null;
    const fenced = v && v.scriptId === s.id && v.enrollmentId === s.enrollmentId;
    if (fenced) { b.resolves++; continue; }
    if (rid) b.dangles++;
    // The new rule: serve the body only when it is a record.
    const historical = visible(s) === "historical";
    const bodyIsRecord = historical || !s.currentVersionId;
    if (bodyIsRecord) { if (historical) b.historicalBody++; else b.noVersionAtAll++; continue; }
    b.withheldByNewRule++;
    const cur = s.currentVersionId ? byId.get(s.currentVersionId) : null;
    if (notes.length < 8) notes.push(`  · ${s.id} "${s.title}" status=${s.status} releasedPointer=${rid ?? "none"} current=v${cur?.versionNo}/${cur?.status} bodyMatchesCurrent=${cur ? cur.body.trim() === s.body.trim() : "-"}`);
  }
  console.log(`CLIENT-VISIBLE SCRIPTS: ${vis.length}`);
  console.log(`  released version resolves under (scriptId + enrollmentId): ${b.resolves}`);
  console.log(`  released pointer that does NOT resolve under the fence: ${b.dangles}`);
  console.log(`  body served as a record — historical import: ${b.historicalBody}; no version rows at all: ${b.noVersionAtAll}`);
  console.log(`  WITHHELD by the new fail-closed rule (body mirrors unreleased work): ${b.withheldByNewRule}`);
  console.log(notes.join("\n"));
}
main().then(() => prisma.$disconnect());

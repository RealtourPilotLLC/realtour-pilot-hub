// READ-ONLY probe. Two questions:
//  1) Does the released-version pointer on a client-visible script always
//     resolve to a version row that belongs to that script + enrollment?
//     (If it does not, postingKit.scriptForVideo falls through to the raw
//     ContentScript.body — the "legacy copy of whatever version is CURRENT".)
//  2) What does the builder's claim ("0 ContentScript rows have a clientId
//     that differs from their enrollment's clientId") actually cover? Check
//     ContentScript AND ContentScriptVersion, and whether body == the released
//     version's body (i.e. whether the legacy fallback is even the same text).
import { prisma } from "../../../src/lib/prisma";

const CLIENT_VISIBLE_SCRIPT = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];
function visible(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return CLIENT_VISIBLE_SCRIPT.includes(s.status) ? "released" : null;
}

async function main() {
  const enrollments = new Map((await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } })).map((e) => [e.id, e.clientId]));
  const scripts = await prisma.contentScript.findMany({
    select: { id: true, title: true, body: true, status: true, releaseState: true, historical: true, clientId: true, enrollmentId: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true },
  });
  const versions = await prisma.contentScriptVersion.findMany({ select: { id: true, scriptId: true, enrollmentId: true, clientId: true, versionNo: true, body: true, status: true } });
  const byId = new Map(versions.map((v) => [v.id, v]));

  // (2) clientId drift, both tables.
  const scriptDrift = scripts.filter((s) => enrollments.has(s.enrollmentId) && enrollments.get(s.enrollmentId) !== s.clientId);
  const versionDrift = versions.filter((v) => enrollments.has(v.enrollmentId) && enrollments.get(v.enrollmentId) !== v.clientId);
  const versionVsScript = versions.filter((v) => { const s = scripts.find((x) => x.id === v.scriptId); return s && s.clientId !== v.clientId; });
  console.log(`ContentScript rows: ${scripts.length}; clientId != enrollment.clientId: ${scriptDrift.length}`);
  console.log(`ContentScriptVersion rows: ${versions.length}; clientId != enrollment.clientId: ${versionDrift.length}; clientId != its script's clientId: ${versionVsScript.length}`);
  console.log(`Enrollments: ${enrollments.size}; ContentScript rows whose enrollmentId is not an enrollment: ${scripts.filter((s) => !enrollments.has(s.enrollmentId)).length}`);

  // Merges are what move clientId; the hub folds a customer team onto its agent.
  const folded = await prisma.client.count({ where: { parentClientId: { not: null } } });
  console.log(`Clients folded onto a parent (parentClientId set): ${folded}`);

  // (1) pointer resolution on the scripts a client can read.
  const vis = scripts.filter((s) => visible(s) !== null);
  let noPointer = 0, resolved = 0, missing = 0, wrongScript = 0, wrongEnrollment = 0, bodyDiffers = 0;
  const notes: string[] = [];
  for (const s of vis) {
    const rid = s.sharedVersionId ?? s.approvedVersionId ?? null;
    if (!rid) { noPointer++; if (s.currentVersionId) notes.push(`  · ${s.id} "${s.title}" has NO shared/approved pointer but currentVersionId=${s.currentVersionId} (${byId.get(s.currentVersionId) ? "exists" : "MISSING"})`); continue; }
    const v = byId.get(rid);
    if (!v) { missing++; notes.push(`  · ${s.id} "${s.title}" released pointer ${rid} -> NO SUCH VERSION ROW (would serve ContentScript.body)`); continue; }
    resolved++;
    if (v.scriptId !== s.id) { wrongScript++; notes.push(`  · ${s.id} released version ${rid} belongs to script ${v.scriptId}`); }
    if (v.enrollmentId !== s.enrollmentId) { wrongEnrollment++; notes.push(`  · ${s.id} released version ${rid} carries enrollment ${v.enrollmentId}, script has ${s.enrollmentId}`); }
    if (v.body.trim() !== s.body.trim()) bodyDiffers++;
  }
  console.log(`\nCLIENT-VISIBLE SCRIPTS: ${vis.length}`);
  console.log(`  no shared/approved version pointer (legacy body is the only copy): ${noPointer}`);
  console.log(`  pointer resolves: ${resolved} (of those, version.scriptId mismatch ${wrongScript}, enrollment mismatch ${wrongEnrollment})`);
  console.log(`  pointer DANGLES -> today falls through to ContentScript.body: ${missing}`);
  console.log(`  released version body DIFFERS from ContentScript.body: ${bodyDiffers} of ${resolved}`);
  console.log(notes.slice(0, 10).join("\n"));

  // How often does ContentScript.body track an UNRELEASED current version?
  const versioned = scripts.filter((s) => s.currentVersionId && s.sharedVersionId && s.currentVersionId !== s.sharedVersionId);
  let bodyIsUnreleased = 0;
  for (const s of versioned) {
    const cur = byId.get(s.currentVersionId!);
    if (cur && cur.body.trim() === s.body.trim()) bodyIsUnreleased++;
  }
  console.log(`\nScripts whose currentVersionId != sharedVersionId: ${versioned.length}; whose .body equals the CURRENT (unreleased) version's body: ${bodyIsUnreleased}`);
}
main().then(() => prisma.$disconnect());

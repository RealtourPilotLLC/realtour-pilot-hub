// W02: assignment receipt belongs to the exact video, editor and brief digest.
// All writes use an isolated PGlite database; provider traffic is fenced.
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request, parent, isMain) {
  return request === "server-only" ? {} : realLoad.call(this, request, parent, isMain);
};
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5792), env: { AUTH_ENFORCE: "true", APP_SECRET: "w02-isolated-session-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { outputBriefsFor } = await import("@/lib/deliverableOutputs");
    const { assignmentReceiptStates } = await import("@/lib/editorBriefReceipt");
    const { acknowledgeEditorBrief } = await import("@/app/edit/[id]/receipt.actions");
    const client = await prisma.client.create({ data: { name: "W02 Receipt TEST" } });
    const kimTeam = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-team-w02@example.test", role: "EDITOR" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "W02 receipt TEST", status: "SHOT", editorId: kimTeam.id, videoInstructions: "Warm and human." } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Personal Branding Reel", quantity: 1 } });
    const output = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO", title: "The neighborhood story", briefJson: JSON.stringify({ version: 1, sections: { purpose: "Help buyers picture daily life" }, brandAssetVersionId: null }) } });
    const kim = await prisma.appUser.create({ data: { email: "kim-w02@example.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const john = await prisma.appUser.create({ data: { email: "john-w02@example.test", name: "John", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-w02@example.test", name: "Owner", role: "OWNER", status: "ACTIVE" } });
    const view = async () => {
      const brief = (await outputBriefsFor(project.id, { scrub: true })).find((b) => b.outputId === output.id);
      if (!brief) throw new Error("fixture output not rendered");
      return (await assignmentReceiptStates(project.id, [brief], { editorBrief: null, videoInstructions: "Warm and human.", reelScript: null })).get(output.id)!;
    };
    await setSession({ uid: kim.id, email: kim.email, role: kim.role });
    const first = await view();
    c.ok("Kim sees her exact video as assigned and unreceived", first.editorKey === "kim" && !first.acceptedAtISO && !!first.digest);
    c.ok("stale digest cannot record acceptance", !(await acknowledgeEditorBrief(project.id, output.id, "stale")).ok && (await prisma.editorBriefReceipt.count()) === 0);
    const accepted = await acknowledgeEditorBrief(project.id, output.id, first.digest);
    c.ok("Kim receives the current assignment", accepted.ok && (await prisma.editorBriefReceipt.count()) === 1, accepted.message);
    c.ok("the receipt stores an exact snapshot and no editing Start", !!(await prisma.editorBriefReceipt.findFirst())?.snapshotJson.includes("Help buyers picture daily life") && (await prisma.editorWorkItem.count()) === 0);
    c.ok("repeat receipt is idempotent", (await acknowledgeEditorBrief(project.id, output.id, first.digest)).ok && (await prisma.editorBriefReceipt.count()) === 1);
    await prisma.deliverableOutput.update({ where: { id: output.id }, data: { briefJson: JSON.stringify({ version: 2, sections: { purpose: "Show the local cafe and walkability" }, brandAssetVersionId: null }) } });
    const changed = await view();
    c.ok("a changed brief invalidates the old receipt", changed.changedSinceReceipt && changed.digest !== first.digest);
    c.ok("the old page cannot receive changed instructions", !(await acknowledgeEditorBrief(project.id, output.id, first.digest)).ok && (await prisma.editorBriefReceipt.count()) === 1);
    c.ok("Kim can receive the new version without overwriting history", (await acknowledgeEditorBrief(project.id, output.id, changed.digest)).ok && (await prisma.editorBriefReceipt.count()) === 2);
    await prisma.deliverableOutput.update({ where: { id: output.id }, data: { ownerKey: "john", ownerName: "John Mark" } });
    const reassigned = await view();
    c.ok("reassignment asks the new editor for their own receipt", reassigned.editorKey === "john" && !reassigned.acceptedAtISO);
    c.ok("Kim cannot receive John's assignment", !(await acknowledgeEditorBrief(project.id, output.id, reassigned.digest)).ok && (await prisma.editorBriefReceipt.count()) === 2);
    await setSession({ uid: john.id, email: john.email, role: john.role });
    const johnReceipt = await acknowledgeEditorBrief(project.id, output.id, reassigned.digest);
    c.ok("John can receive his own current video", johnReceipt.ok && (await prisma.editorBriefReceipt.count()) === 3, johnReceipt.message);
    const foreign = await prisma.project.create({ data: { clientId: client.id, title: "Other W02 job" } });
    c.ok("a video id cannot be borrowed across jobs", !(await acknowledgeEditorBrief(foreign.id, output.id, reassigned.digest)).ok && (await prisma.editorBriefReceipt.count()) === 3);
    await prisma.deliverableOutput.update({ where: { id: output.id }, data: { removedFromOrderAt: new Date() } });
    c.ok("a retired output revokes the per-video project door", !(await acknowledgeEditorBrief(project.id, output.id, reassigned.digest)).ok && (await prisma.editorBriefReceipt.count()) === 3);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: john.id });
    const previewReceipt = await acknowledgeEditorBrief(project.id, output.id, reassigned.digest);
    c.ok("owner preview cannot impersonate John's receipt", !previewReceipt.ok && (await prisma.editorBriefReceipt.count()) === 3, previewReceipt.message);
    c.ok("no provider call escaped the isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

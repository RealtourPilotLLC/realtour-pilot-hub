// W06: a photographer's last read is scoped to this job and actual user, and
// a later released script/asset/direction change has an explicit delta.
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import Module from "node:module";

// Next replaces this marker at bundle time; the isolated Node drill has no
// server-component resolver, so stub only the marker before app imports.
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  return request === "server-only" ? {} : realLoad.call(this, request, parent, isMain);
};
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5783), env: { AUTH_ENFORCE: "true", APP_SECRET: "w06-isolated-session-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { shootBriefLines, briefSnapshot, briefDigest, briefChanges, parseBriefSnapshot } = await import("@/lib/shootBriefRead");
    const client = await prisma.client.create({ data: { name: "W06 Brief TEST" } });
    const project = await prisma.project.create({ data: { title: "W06 shoot TEST", clientId: client.id } });
    const view = {
      project: { editorBrief: "Warm, confident game plan", reelHook: null, reelScript: null, reelShotList: null, reelSong: null },
      appointment: { parsed: { special: "Must get lobby entrance" } },
      specialRequests: [], editRequests: [],
      client: { theirStyle: "Conversational", theirPreferences: null },
      session: { topics: [{ topicId: "topic-1", title: "Local market", overflow: false, filmedElsewhere: false,
        script: { title: "Local market", versionNo: 2, text: "Welcome to the market", standing: "approved by the client", direction: { filmingNotes: "Film outdoors", creativeDirection: null, productionNotes: null } }, noScript: null }],
        brand: { fontNames: null, music: null, productionDefaults: [], acceptedPreferences: [], files: [] } },
      outputBriefs: [{ outputId: "output-1", label: "Social reel", format: "Vertical", versionLabel: "Brief v1", brandAsset: null,
        sections: [{ label: "Must show", text: "Neighborhood cafe" }, { label: "Avoid", text: "Traffic" }] }],
    };
    const before = shootBriefLines(view as never, []);
    const snapshot = briefSnapshot(before);
    const digest = briefDigest(snapshot);
    const read = await prisma.shootBriefRead.create({ data: { projectId: project.id, readerUserId: "photographer-1", snapshotJson: snapshot, digest } });
    c.ok("read receipt stores exact snapshot and digest", read.snapshotJson === snapshot && read.digest === digest);
    c.ok("another photographer has no read receipt on this job", (await prisma.shootBriefRead.findFirst({ where: { projectId: project.id, readerUserId: "photographer-2" } })) === null);
    view.session.topics[0].script.versionNo = 3;
    view.session.topics[0].script.text = "Welcome to this changing market";
    view.outputBriefs[0].sections[0].text = "Neighborhood park";
    const after = shootBriefLines(view as never, []);
    const changes = briefChanges(parseBriefSnapshot(read.snapshotJson), after);
    c.ok("changed approved script and must-show appear as two precise deltas", changes.length === 2 && changes.some((x) => x.label.includes("script to film") && x.before?.includes("v2") && x.after?.includes("v3")) && changes.some((x) => x.label.includes("Must show") && x.after === "Neighborhood park"));
    c.ok("unchanged brief has no delta", briefChanges(after, after).length === 0);
    c.ok("changed digest refuses stale page version", briefDigest(briefSnapshot(after)) !== digest);
    const second = await prisma.shootBriefRead.create({ data: { projectId: project.id, readerUserId: "photographer-1", snapshotJson: briefSnapshot(after), digest: briefDigest(briefSnapshot(after)) } });
    c.ok("later read leaves prior version intact", (await prisma.shootBriefRead.count({ where: { projectId: project.id, readerUserId: "photographer-1" } })) === 2 && second.id !== read.id);
    const assigned = await prisma.teamMember.create({ data: { name: "Assigned shooter", email: "shooter-w06@example.test", role: "PHOTOGRAPHER" } });
    await prisma.project.update({ where: { id: project.id }, data: { photographerId: assigned.id } });
    const shooter = await prisma.appUser.create({ data: { email: assigned.email!, name: assigned.name, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: assigned.id } });
    const { setSession } = await import("@/lib/auth/session");
    await setSession({ uid: shooter.id, email: shooter.email, role: shooter.role });
    const { getShoot } = await import("@/lib/shoot");
    const liveView = await getShoot(project.id);
    c.ok("isolated assigned shoot is readable", !!liveView);
    const liveDigest = briefDigest(briefSnapshot(shootBriefLines(liveView!, [])));
    const { acknowledgeShootBrief } = await import("@/app/shoot/actions");
    const countBeforeAction = await prisma.shootBriefRead.count();
    c.ok("stale page digest cannot mark a new version read", !(await acknowledgeShootBrief(project.id, digest)).ok && await prisma.shootBriefRead.count() === countBeforeAction);
    const acknowledged = await acknowledgeShootBrief(project.id, liveDigest);
    c.ok("assigned photographer can acknowledge exact current brief", acknowledged.ok && await prisma.shootBriefRead.count() === countBeforeAction + 1, acknowledged.message);
    const repeated = await acknowledgeShootBrief(project.id, liveDigest);
    c.ok("repeat acknowledgment is idempotent", repeated.ok && await prisma.shootBriefRead.count() === countBeforeAction + 1, repeated.message);
    const other = await prisma.appUser.create({ data: { email: "other@example.test", name: "Other", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    await setSession({ uid: other.id, email: other.email, role: other.role });
    let refused = false;
    try { await acknowledgeShootBrief(project.id, liveDigest); } catch { refused = true; }
    c.ok("unassigned photographer cannot mark it read", refused && await prisma.shootBriefRead.count() === countBeforeAction + 1);
    const owner = await prisma.appUser.create({ data: { email: "owner@example.test", name: "Owner", role: "OWNER", status: "ACTIVE" } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: shooter.id });
    refused = false;
    try { await acknowledgeShootBrief(project.id, liveDigest); } catch { refused = true; }
    c.ok("owner preview cannot mark photographer brief read", refused && await prisma.shootBriefRead.count() === countBeforeAction + 1);
    c.ok("no network call escaped isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

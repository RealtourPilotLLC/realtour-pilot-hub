// READ-ONLY probe. Group D. How much NEW client-visible surface does rendering
// the topic's script under its topic actually create, per enrollment, and is
// the enrollment one a client can reach at all?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const OLD = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];
function vis(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return OLD.includes(s.status) ? "released" : null;
}

async function main() {
  const enrolls = await prisma.contentEnrollment.findMany({
    select: { id: true, clientId: true, status: true, portalToken: true, accessRevokedAt: true },
  });
  const rows = await prisma.contentScript.findMany({
    select: { id: true, enrollmentId: true, clientId: true, topicId: true, status: true, releaseState: true, historical: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true, updatedAt: true },
  });
  const names = new Map((await prisma.client.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const topics = await prisma.contentTopic.findMany({ select: { id: true, enrollmentId: true, status: true, approvalState: true } });
  const liveTopic = new Set(topics.filter((t) => !["REJECTED", "ARCHIVED"].includes(t.status) && !["REJECTED", "ARCHIVED"].includes(t.approvalState ?? "")).map((t) => t.id));

  console.log("enrollment                         client                    status  portal?  topics w/ released  topics w/ historical");
  for (const e of enrolls) {
    const mine = rows.filter((r) => r.enrollmentId === e.id && r.clientId === e.clientId && r.topicId && liveTopic.has(r.topicId));
    const rel = new Set(mine.filter((r) => vis(r) === "released").map((r) => r.topicId));
    const his = new Set(mine.filter((r) => vis(r) === "historical").map((r) => r.topicId!).filter((t) => !rel.has(t)));
    if (!rel.size && !his.size) continue;
    const portal = e.accessRevokedAt ? "revoked" : e.portalToken ? "yes" : "no";
    console.log(`${e.id}  ${(names.get(e.clientId) ?? "?").padEnd(24).slice(0, 24)}  ${e.status.padEnd(6)}  ${portal.padEnd(7)}  ${String(rel.size).padStart(18)}  ${String(his.size).padStart(20)}`);
  }

  // Which version row would actually be rendered for each visible script?
  const visible = rows.filter((r) => vis(r) !== null && r.topicId && liveTopic.has(r.topicId));
  const ids = visible.map((r) => r.sharedVersionId ?? r.approvedVersionId ?? null).filter((x): x is string => !!x);
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: ids } }, select: { id: true, versionNo: true, hook: true, close: true, pointsJson: true } });
  console.log(`\nvisible topic-linked scripts: ${visible.length}`);
  console.log(`  with a shared/approved version row: ${ids.length}  (resolved: ${versions.length})`);
  console.log(`  falling back to ContentScript.body: ${visible.length - ids.length}`);

  const bodies = await prisma.contentScript.findMany({ where: { id: { in: visible.filter((r) => !(r.sharedVersionId ?? r.approvedVersionId)).map((r) => r.id) } }, select: { id: true, body: true } });
  const empty = bodies.filter((b) => !b.body || b.body.trim().length < 20);
  console.log(`  of those, with an empty/short body: ${empty.length}`);
}
main().finally(() => prisma.$disconnect());

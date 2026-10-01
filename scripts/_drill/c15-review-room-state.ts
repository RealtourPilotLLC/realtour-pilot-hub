// C15: actual signed Review Room render with no first-cut queue and other work.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5822), env: { AUTH_ENFORCE: "true", APP_SECRET: "c15-isolated-render" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { putSetting } = await import("@/lib/settings");
    const { default: page } = await import("@/app/review/page");
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "c15-kyle@example.test", role: "ADMIN", status: "ACTIVE" } });
    const team = await prisma.teamMember.create({ data: { name: "James", email: "c15-james@example.test", role: "PHOTOGRAPHER" } });
    const james = await prisma.appUser.create({ data: { name: team.name, email: team.email!, teamMemberId: team.id, role: "PHOTOGRAPHER", status: "ACTIVE" } });
    await putSetting("review_room", { creativeApproverTeamMemberId: team.id }, "isolated-owner@example.test");
    const job = await prisma.project.create({ data: { clientId: real.id, title: "Real video-only job", status: "REVISION", deliverables: { create: { type: "VIDEO", label: "Property video" } } } });
    const testJob = await prisma.project.create({ data: { clientId: fixture.id, title: "Hidden fixture media job", status: "REVIEW" } });
    for (const p of [job, testJob]) await prisma.smartTask.create({ data: { projectId: p.id, taskType: "media_qa", title: `Check ${p.title}`, assignedKey: "kyle" } });
    const revision = await prisma.reviewSubmission.create({ data: { projectId: job.id, status: "CHANGES_REQUESTED", kind: "video", source: "upload", fileName: "exact-version-two.mp4", round: 2, decidedAt: new Date(), decidedBy: "James", submittedByKey: "kim" } });
    const notice = await prisma.outboxMessage.create({ data: { projectId: job.id, channel: "sms", toRef: "2025550190", body: "Isolated receipt", dedupeKey: `delivery:${job.id}`, state: "unknown" } });
    const before = await prisma.smartTask.findMany({ orderBy: { id: "asc" } });
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    for (const [label, user] of [["Kyle", kyle], ["James", james]] as const) {
      await as(user);
      const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({}) }));
      c.ok(`${label}: no-cut headline still directs attention to revisions and delivery`, html.includes("No cuts awaiting your verdict") && html.includes("check revisions and delivery below"));
      c.ok(`${label}: exact revision remains visible with no first-cut approval pending`, html.includes("In revisions") && html.includes(`cut=${revision.id}`) && html.includes("exact-version-two.mp4"));
      c.ok(`${label}: video-only QC is a media/delivery check, never a photo set`, html.includes("Delivery checks") && html.includes("Media checks to finish") && !html.includes("Photo sets") && !html.includes("Hidden fixture media job"));
      c.ok(`${label}: unknown delivery outcome stays actionable with its actual thread`, html.includes("Delivery text outcome unconfirmed") && html.includes(`incident=${notice.id}`) && !html.includes("No delivery action is currently waiting"));
    }
    await as(kyle);
    const testHtml = renderToStaticMarkup(await page({ searchParams: Promise.resolve({ test: "1" }) }));
    c.ok("explicit test view retains synthetic media work", testHtml.includes("Hidden fixture media job") && testHtml.includes("Hide test records"));
    await clearSession();
    let refused = false;
    try { await page({ searchParams: Promise.resolve({}) }); } catch (e) { refused = /NEXT_REDIRECT|redirect|login/i.test(String(e)); }
    c.ok("signed-out viewer cannot read the room", refused);
    c.ok("renders do not complete work, alter exact versions or retry unknown sends", JSON.stringify(before) === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: revision.id } })).status === "CHANGES_REQUESTED" && (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: notice.id } })).state === "unknown" && await prisma.editorWorkEvent.count() === 0);
    c.ok("all provider traffic stayed fenced", fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

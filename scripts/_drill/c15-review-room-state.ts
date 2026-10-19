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
      // Oct 19 2026 (Jordan): the section is "In revision" in the Video Review Room.
      c.ok(`${label}: exact revision remains visible with no first-cut approval pending`, html.includes(">In revision<") && html.includes(`cut=${revision.id}`) && html.includes("exact-version-two.mp4"));
      // Oct 19 2026 (Jordan): the room is video only; the media checks moved to
      // Photo Delivery (oct19-video-review-room.ts checks them there).
      c.ok(`${label}: the media checks are not in the Video Review Room, never a photo set`, !html.includes("Delivery checks") && !html.includes("Media checks to finish") && !html.includes("Photo sets") && !html.includes("Hidden fixture media job"));
      // Oct 19 2026: Home no longer shows the delivery card, so its follow-up
      // lanes live in the Video Review Room ("Needs a follow-up"), for the
      // office (Kyle); a seated reviewer on another login does not get them.
      if (label === "Kyle") c.ok(`${label}: the unknown delivery text is in the room's Needs a follow-up, once`, html.includes(">Needs a follow-up<") && (html.match(/Delivery texts needing a check/g) ?? []).length === 1 && html.includes(`incident=${encodeURIComponent(notice.id)}`) && !html.includes("No delivery action is currently waiting"));
      else c.ok(`${label}: no delivery follow-up for a reviewer-only login`, !html.includes(">Needs a follow-up<") && !html.includes("Delivery text outcome unconfirmed"));
      if (label === "Kyle") {
        // Oct 19 2026 (evening): the ten checklist blocks (and the Video
        // Review block that rendered this incident) are gone from /ops and
        // Home. The operating day still reads it, exact conversation and all.
        const { buildOpsDay } = await import("../../src/lib/opsDay");
        const board = (await buildOpsDay()).readySend;
        c.ok("unknown delivery outcome remains in the operating day's data with its exact conversation", !!board.noticeIncidents?.some((incident) => incident.outboxId === notice.id && incident.state === "unknown"));
      }
    }
    await as(kyle);
    const testHtml = renderToStaticMarkup(await page({ searchParams: Promise.resolve({ test: "1" }) }));
    c.ok("explicit test view keeps its toggle (the synthetic media check moved to Photo Delivery with the rest)", testHtml.includes("Hide test records") && !testHtml.includes("Media checks to finish"));
    const { photoQcCards } = await import("@/lib/reviewRoom");
    c.ok("the media checks reader still keeps synthetic work for an explicit test view", (await photoQcCards({ includeTest: true })).some((t) => t.street === "Hidden fixture media job") && !(await photoQcCards({ includeTest: false })).some((t) => t.street === "Hidden fixture media job"));
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

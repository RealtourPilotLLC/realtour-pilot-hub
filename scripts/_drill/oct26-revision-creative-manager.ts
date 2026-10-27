// ---------------------------------------------------------------------------
// DRILL: a client's revision pings the editor AND the creative manager
// (Oct 26 2026).
//
//   DRILL_PORT=5611 node scripts/_drill/run-all.cjs scripts/_drill/oct26-revision-creative-manager.ts
//
// Jordan, on Mike Flatley's portal notes: "I think James should be pinged as
// well as Kim" and "Or whoever is editing the project in the future but
// creative manager should know too." Kim's row was already addressed to her
// (Slack or text by her own switch); James only ever got the CREATIVE_MANAGER
// role broadcast, and a broadcast rings the bell and nothing else. More notes
// on an open ask (revision_addendum) reached nobody's Slack or phone at all.
//
// What it proves:
//   1. A portal ask on one video: the editor's row, a row addressed to the
//      creative manager by name (no second copy through the broadcast), and
//      his text, saying who asked, which video, who has it, and the ask.
//   2. More notes on that open ask reach both of them, by their switches.
//   3. Money never reaches the creative manager, in the bell or the text.
//   4. No creative manager login: the role stays on the broadcast.
//
// ISOLATION: PGlite via the shared harness; production is never opened, every
// outbound call is fenced.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5611);

installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const cd = await import("@/lib/clientDecisions");
  const rr = await import("@/app/review/actions");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { eventForKind } = await import("@/lib/notifyPrefs");

  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "kim", personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  // Kim on the roster with her production switch (Job pings on text here, so
  // the drill can read her queued line without a Slack call).
  const kim = await prisma.teamMember.create({ data: { name: "Kim Drill", email: "kim-drill@example.com", role: "MANAGER", phone: "+12155550143" }, select: { id: true } });
  await prisma.appSetting.create({ data: { key: `notify-prefs:${kim.id}`, value: JSON.stringify({ job_ping: { slack: false, sms: true } }) } });
  // The creative manager: a roster row (he shoots too) behind a CREATIVE_MANAGER
  // login, his "Job pings" switch on text — James's saved choice in production.
  const james = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-drill@example.com", role: "PHOTOGRAPHER", phone: "+12155550142" }, select: { id: true } });
  const jamesLogin = await prisma.appUser.create({ data: { email: "james-drill@example.com", name: "James Drill", role: "CREATIVE_MANAGER", status: "ACTIVE", teamMemberId: james.id }, select: { id: true } });
  await prisma.appSetting.create({ data: { key: `notify-prefs:${james.id}`, value: JSON.stringify({ job_ping: { slack: false, sms: true } }) } });
  let seq = 0;

  type World = { f: ContentMonthFixture; viewer: import("@/lib/portal").PortalViewer; videos: string[] };
  const world = async (name: string): Promise<World> => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: `${slug}@example.com`, name },
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 4; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return { f, videos, viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@example.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as World["viewer"] };
  };
  const mkCut = async (w: World, slot: number, round: number) => {
    const row = await prisma.reviewSubmission.create({
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", videoId: w.videos[slot - 1], createdAt: new Date(Date.now() + seq++) },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };
  const release = async (id: string) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
    await prisma.reviewSubmission.update({ where: { id }, data: { clientReleasedAt: new Date(), clientReleasedBy: "Portal publication" } });
    const { openReviewWindow } = await import("@/lib/reviewWindows");
    await openReviewWindow(id, { by: "Portal publication" });
  };
  const note = (w: World, sub: string, body: string) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: 7, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });
  const rows = (prefix: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: prefix } }, orderBy: { dedupeKey: "asc" } });
  const texts = () => prisma.pendingSms.findMany({ where: { teamMemberId: james.id }, orderBy: { createdAt: "asc" } });

  // =========================================================================
  c.head("1 · a portal ask on one video: the editor and the creative manager, each by name");
  // =========================================================================
  const M = await world("Mike Drill");
  const cut2 = await mkCut(M, 2, 1);
  await release(cut2);
  await note(M, cut2, "1. Can we see what part two is about?\n2. Are the kids in part two?");
  const r = await cd.requestChangesOnCut(M.viewer, cut2, "");
  c.ok("the request goes", r.ok, r.message);
  const decision = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: cut2, decision: "REQUEST_CHANGES" } });
  const round = await prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: cut2 } });
  const ring = await rows(`portal-round-${round.id}`);
  const broadcast = ring.find((n) => !n.userKey);
  const kimRow = ring.find((n) => n.userKey === "editor:kim");
  const jamesRow = ring.find((n) => n.userKey === `tm:${james.id}`);
  c.ok("Kim's row, addressed to her, links to her edit page", !!kimRow && kimRow.href === `/edit/${M.f.projectId}`, kimRow?.href ?? "none");
  c.ok("James's row, addressed to him by name, links to the job", !!jamesRow && jamesRow.href === `/projects/${M.f.projectId}`, jamesRow?.href ?? "none");
  c.ok("  …titled with the street and the video", /Video 2 of 4/.test(jamesRow?.title ?? ""), jamesRow?.title ?? "");
  // Oct 27 2026 (Jordan: "Kyle handles comms, delegation, review, delivery,
  // and coordination ... I am CEO."): a client's revision ask is the office's
  // and the creative manager's, so notifyRoles.ts drops OWNER from it.
  c.ok("the broadcast no longer carries CREATIVE_MANAGER (one row in his bell, not two)", !!broadcast && !JSON.parse(broadcast.audience).includes("CREATIVE_MANAGER") && JSON.parse(broadcast.audience).includes("ADMIN"), broadcast?.audience ?? "none");
  c.ok("  …nor OWNER: a routine revision ask is not the CEO's (Oct 27 2026)", !!broadcast && !JSON.parse(broadcast.audience).includes("OWNER"), broadcast?.audience ?? "none");
  c.ok("  …and the editor's row stays where it was (suffix -1)", kimRow?.dedupeKey === `portal-round-${round.id}-1`, kimRow?.dedupeKey ?? "none");
  const t1 = await texts();
  c.ok("James is texted once (his Job pings switch says text)", t1.length === 1, String(t1.length));
  c.ok("  …saying who asked, which video, and that Kim has it", /^Mike Drill asked for changes on .+ · Video 2 of 4\. Kim has it\./.test(t1[0]?.line ?? "") || /^Mike Drill asked for changes on .+Video 2.*\. Kim has it\./.test(t1[0]?.line ?? ""), t1[0]?.line ?? "none");
  c.ok("  …with the client's notes quoted (not the receipt line) and the link", /“• \[0:07\] 1\. Can we see what part two is about\? 2\. Are the kids in part two\?”/.test(t1[0]?.line ?? "") && !/requested from the client portal/.test(t1[0]?.line ?? "") && (t1[0]?.line ?? "").includes(`/projects/${M.f.projectId}`), t1[0]?.line ?? "");
  c.ok("revision_raised rides the Job pings switch", eventForKind("revision_raised") === "job_ping");

  // =========================================================================
  c.head("2 · more notes on the open ask reach both of them");
  // =========================================================================
  await note(M, cut2, "Also the caption says 'recieve'");
  const r2 = await cd.requestChangesOnCut(M.viewer, cut2, "");
  c.ok("the notes go on the same request", r2.ok && r2.duplicate === true, r2.message);
  const add = await rows(`portal-addendum-${decision.id}-1`);
  c.ok("Kim's row for the added notes", add.some((n) => n.userKey === "editor:kim"));
  c.ok("James's row for the added notes", add.some((n) => n.userKey === `tm:${james.id}` && n.kind === "revision_addendum"));
  c.ok("revision_addendum now rides the Job pings switch (it was bell-only)", eventForKind("revision_addendum") === "job_ping", String(eventForKind("revision_addendum")));
  const t2 = await texts();
  c.ok("James is texted about the added notes", t2.length === 2 && /^Mike Drill added notes on /.test(t2[1]?.line ?? "") && /recieve/.test(t2[1]?.line ?? ""), t2[1]?.line ?? "none");
  // (Her other lines are the "Cut approved" pings from releasing the cut.)
  const kimTexts = (await prisma.pendingSms.findMany({ where: { teamMemberId: kim.id }, orderBy: { createdAt: "asc" } })).filter((t) => /^(Revision|More notes) — /.test(t.line));
  c.ok("Kim was texted for the ask AND the added notes (added notes used to be bell-only)", kimTexts.length === 2 && /^More notes/.test(kimTexts[1].line), kimTexts.map((t) => t.line.slice(0, 50)).join(" | "));

  // =========================================================================
  c.head("3 · money never reaches the creative manager");
  // =========================================================================
  const cut3 = await mkCut(M, 3, 1);
  await release(cut3);
  await note(M, cut3, "Happy to pay the $150 rush fee, just swap the song");
  const r3 = await cd.requestChangesOnCut(M.viewer, cut3, "");
  c.ok("the request goes", r3.ok, r3.message);
  const round3 = await prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: cut3 } });
  const jr3 = (await rows(`portal-round-${round3.id}`)).find((n) => n.userKey === `tm:${james.id}`);
  const t3 = (await texts()).at(-1);
  c.ok("James's bell row carries no dollar figure", !!jr3 && !/\$150|150/.test(jr3.body ?? ""), jr3?.body ?? "none");
  c.ok("James's text keeps the ask, the figure scrubbed", /swap the song/.test(t3?.line ?? "") && /\[amount\]/.test(t3?.line ?? "") && !/150/.test(t3?.line ?? ""), t3?.line ?? "none");

  // =========================================================================
  c.head("4 · no creative manager login: the role stays on the broadcast");
  // =========================================================================
  {
    await prisma.appUser.update({ where: { id: jamesLogin.id }, data: { status: "DISABLED" } });
    // The login lookup is cached ten minutes per lambda; step past it.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const { creativeManagerTargets } = await import("@/lib/notify");
      const none = await creativeManagerTargets({ head: "x", ask: "y", href: "/projects/x" });
      c.ok("creativeManagerTargets is empty", none.length === 0, String(none.length));
      const P = await world("Pat Drill");
      const cp = await mkCut(P, 1, 1);
      await release(cp);
      await note(P, cp, "Brighter end card");
      const rp = await cd.requestChangesOnCut(P.viewer, cp, "");
      const roundP = await prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: cp } });
      const ringP = await rows(`portal-round-${roundP.id}`);
      const bc = ringP.find((n) => !n.userKey);
      c.ok("the ask still goes", rp.ok, rp.message);
      c.ok("the broadcast keeps CREATIVE_MANAGER, so the bell never goes dark", !!bc && JSON.parse(bc.audience).includes("CREATIVE_MANAGER"), bc?.audience ?? "none");
      c.ok("no row addressed to a creative manager", !ringP.some((n) => n.userKey?.startsWith("tm:")));
    } finally {
      Date.now = realNow;
    }
  }

  c.head("isolation");
  c.ok("nothing left the machine", fence.faked.length === 0, `blocked ${fence.blocked.length}`);

  c.summary();
  quiet.restore();
  await stop();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});

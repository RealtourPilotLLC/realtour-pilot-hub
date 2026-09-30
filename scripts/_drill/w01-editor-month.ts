// W01: exact linked-session scope, output evidence, permissions and explicit repair.
// Isolated PGlite; no production connection or provider calls.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

type Viewer = {
  id: string; email: string; name: string; role: string; permissions: null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: null;
  impersonating: boolean; realRole: string; realName: string;
};
let viewer: Viewer | null = null;
const as = (role: "ADMIN" | "EDITOR") => ({
  id: role, email: `${role.toLowerCase()}@example.com`, name: role === "ADMIN" ? "Kyle" : "Kim", role,
  permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: role === "EDITOR" ? "kim" : null,
  notificationsSeenAt: null, impersonating: false, realRole: role, realName: role === "ADMIN" ? "Kyle" : "Kim",
});
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => viewer : t[k]; } }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5761), env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { editorMonthFor } = await import("@/lib/editorMonth");
  const { attachUnlinkedSessionToMonth } = await import("@/app/content/actions");
  const f = await buildContentMonth(prisma as never, {
    name: "W01 Pro TEST", package: "Pro", videosPerMonth: 5,
    appointments: [{ startAt: new Date("2026-09-12T14:00:00Z") }],
    monthKey: "2026-09", owner: false,
  });
  const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-w01@example.com", role: "EDITOR" } });
  await prisma.project.update({ where: { id: f.projectId! }, data: { editorId: kim.id } });
  for (let slot = 1; slot <= 5; slot++) await prisma.deliverableOutput.create({ data: {
    projectId: f.projectId!, deliverableId: f.deliverableId!, slot, category: "SOCIAL_REEL",
    ...(slot <= 2 ? { currentSubmissionId: `cut-${slot}`, approvedSubmissionId: `cut-${slot}`, deliveredAt: new Date("2026-09-20T14:00:00Z") } : {}),
  } });
  await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 3, round: 1, status: "APPROVED", assetPath: "/fixture/cut-3.mp4" } });
  await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 4, round: 1, status: "PENDING", assetPath: "/fixture/cut-4.mp4" } });
  await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, slot: 1, round: 1, status: "PENDING", assetPath: "/fixture/unpaired.mp4" } });
  const second = await prisma.project.create({ data: { clientId: f.clientId, contentMonthId: f.monthId, title: "Second Pro appointment", status: "SHOT", shootDate: new Date("2026-09-19T14:00:00Z"), editorId: kim.id, dropboxFolder: "/AutoHDR/TEST/second-session" } });
  const d2 = await prisma.deliverable.create({ data: { projectId: second.id, type: "SOCIAL_REEL", quantity: 2, label: "Video Pro" } });
  for (let slot = 1; slot <= 2; slot++) await prisma.deliverableOutput.create({ data: { projectId: second.id, deliverableId: d2.id, slot, category: "SOCIAL_REEL" } });
  await prisma.appointment.create({ data: { projectId: second.id, aryeoId: "w01-second", startAt: new Date("2026-09-19T14:00:00Z"), endAt: new Date("2026-09-19T18:00:00Z"), status: "SCHEDULED" } });
  await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, projectId: second.id, status: "FILMED", filmedConfirmedAt: new Date("2026-09-19T19:00:00Z"), title: "Second session topic" } });

  viewer = as("ADMIN");
  const full = await editorMonthFor(f.projectId!, viewer);
  c.ok("Pro shows two exact linked sessions, with each job's own raw folder", full?.sessions.length === 2 && full.sessions[1].rawUrl.includes("second-session") && full.sessions[0].id === f.projectId);
  c.ok("allowance stays five while seven job slots are reported as a conflict", full?.allowance === 5 && full.counts?.slotsOnJobs === 7);
  c.ok("filmed is explicit; legacy cuts count by exact slot even without output pointers", full?.counts?.filmedConfirmed === 1 && full.counts?.submitted === 4 && full.counts?.approved === 3 && full.counts?.delivered === 2 && full.counts?.unpairedCuts === 1);
  c.ok("unlinked client jobs are not guessed into the month", full?.sessions.length === 2);

  const other = await prisma.project.create({ data: { clientId: f.clientId, title: "Unlinked appointment", status: "SHOT", shootDate: new Date("2026-09-26T14:00:00Z") } });
  await prisma.deliverable.create({ data: { projectId: other.id, type: "VIDEO", quantity: 1 } });
  const before = await editorMonthFor(f.projectId!, viewer);
  c.ok("unlinked candidate is called out but its folder and counts are not included", before?.unlinkedClientJobs === 1 && before.sessions.length === 2 && before.counts?.slotsOnJobs === 7);

  viewer = as("EDITOR");
  await prisma.project.update({ where: { id: second.id }, data: { editorId: null } });
  const scoped = await editorMonthFor(f.projectId!, viewer);
  c.ok("editor sees only assigned sessions and no all-month counts", scoped?.sessions.length === 1 && scoped.allSessionsVisible === false && scoped.counts === null);
  c.ok("unassigned editor cannot open sibling month from that job", (await editorMonthFor(second.id, viewer)) === null);
  await prisma.project.update({ where: { id: second.id }, data: { editorId: kim.id } });
  const both = await editorMonthFor(f.projectId!, viewer);
  c.ok("when assigned to both, editor sees both distinct sessions", both?.sessions.length === 2 && both.allSessionsVisible);

  viewer = as("ADMIN");
  const badReason = await attachUnlinkedSessionToMonth(other.id, f.monthId, "short");
  c.ok("repair requires recorded appointment/package reason", !badReason.ok && (await prisma.project.findUnique({ where: { id: other.id } }))?.contentMonthId === null);
  const foreign = await buildContentMonth(prisma as never, { name: "Other W01 TEST", project: false, owner: false });
  const cross = await attachUnlinkedSessionToMonth(other.id, foreign.monthId, "This appointment is hers");
  c.ok("cross-client month link is refused", !cross.ok && (await prisma.project.findUnique({ where: { id: other.id } }))?.contentMonthId === null);
  const nextMonth = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-10", videosOwed: 5 } });
  const conflicting = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, projectId: other.id, monthId: nextMonth.id, title: "Already assigned elsewhere" } });
  c.ok("an existing video identity in another month blocks repair", !(await attachUnlinkedSessionToMonth(other.id, f.monthId, "September appointment evidence")).ok && (await prisma.project.findUnique({ where: { id: other.id } }))?.contentMonthId === null);
  await prisma.contentVideo.delete({ where: { id: conflicting.id } });
  const oneOrder = await buildContentMonth(prisma as never, {
    name: "One Order Two Appointments TEST", package: "Pro", monthKey: "2026-09", owner: false,
    appointments: [{ startAt: new Date("2026-09-04T14:00:00Z") }, { startAt: new Date("2026-09-18T14:00:00Z") }],
  });
  const twoLegs = await editorMonthFor(oneOrder.projectId!, viewer);
  c.ok("one Pro job with two appointments shows two legs without duplicating its outputs", twoLegs?.sessions.length === 2 && twoLegs.sessions[0].id === twoLegs.sessions[1].id && twoLegs.sessions[0].key !== twoLegs.sessions[1].key && twoLegs.sessions[0].appointmentIndex === 1 && twoLegs.sessions[1].appointmentIndex === 2);
  const linked = await attachUnlinkedSessionToMonth(other.id, f.monthId, "Second appointment for September package");
  const after = await prisma.project.findUnique({ where: { id: other.id }, select: { contentMonthId: true, activities: { select: { body: true } } } });
  c.ok("staff repair links only the selected job and records an audit trail", linked.ok && after?.contentMonthId === f.monthId && after.activities.some((a) => a.body.includes("Second appointment")));
  c.ok("repeat repair cannot silently move an already-linked session", !(await attachUnlinkedSessionToMonth(other.id, f.monthId, "Second appointment for September package")).ok);
  c.ok("no network call escaped the fixture", fence.blocked.length === 0, fence.blocked.join(", "));
  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

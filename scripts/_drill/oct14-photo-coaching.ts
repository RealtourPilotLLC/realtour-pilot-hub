// ---------------------------------------------------------------------------
// DRILL: PHOTOGRAPHER COACHING NOTES (Oct 14 2026, prompt pack 10, plan §12.3).
// The paid QC engine drafted these from its findings; paid photo QC is off for
// good (Jordan, Oct 23 2026) and the engine and its Claude drafting were
// deleted (audit Oct 25 2026, D7). The drafts already stored still work:
//   · a stored draft reads as a draft, with its three reminders
//   · approve sends it to the photographer (staff channel) and is logged; a
//     sent note cannot be discarded or re-sent
//   · discard closes a draft; a discarded one cannot be sent
//   · nothing drafts a new note any more (no drafting export, no Claude call)
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5999) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const coaching = await import("@/lib/photoDelivery/coaching");
    const { logJobEvent } = await import("@/lib/photoDelivery/jobState");

    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-coach@example.test", slackId: "UOWNER" } });
    await prisma.appUser.create({ data: { email: "owner-coach@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    const shooter = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-coach@example.test" } });
    const client = await prisma.client.create({ data: { name: "Coach Client TEST" } });
    const job = async (title: string) => {
      const project = await prisma.project.create({ data: { title, clientId: client.id, photographerId: shooter.id, shootDate: new Date(Date.now() - 86_400_000) } });
      return prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    };
    // The shape the deleted drafting step stored (coaching:draft on the job's activity log).
    const draftOn = (jobId: string) => logJobEvent(jobId, "coaching", "coaching:draft", {
      qcRunId: "run-1", photographerId: shooter.id, photographerName: shooter.name,
      note: "Hi Harrison, thanks for the Maple Street shoot. Your verticals were straight in every room. Next time, give each bathroom a ten-second sweep so the lids are down. Nice work out there!",
      preShootReminders: ["Bathrooms: lids down before each frame", "Check mirrors from the camera position", "Walk the front yard for hoses and bins"],
      focusRuleIds: ["BATH_TOILET_SEAT_OPEN"], model: "claude-sonnet",
    });
    const j1 = await job("14 Maple St, Testville, PA");
    const j2 = await job("16 Maple St, Testville, PA");
    await draftOn(j1.id);
    await draftOn(j2.id);

    c.ok("nothing drafts a new note any more", !("draftCoachingNote" in coaching) && !("draftPendingCoaching" in coaching) && !("COACHING_NOTE_V1" in coaching));
    const draft = await coaching.coachingFor(j1.id);
    c.ok("a stored draft reads as a draft with three reminders", draft?.status === "draft" && draft.preShootReminders.length === 3 && /Harrison/.test(draft.note));
    c.ok("a job with no note has none", (await coaching.coachingFor((await job("18 Maple St")).id)) === null);

    const sent = await coaching.sendCoachingNote(j1.id, "drill-owner");
    c.ok("approve sends it to the photographer", sent.ok, sent.message);
    c.ok("…and logs coaching:sent", (await coaching.coachingFor(j1.id))?.status === "sent");
    const again = await coaching.sendCoachingNote(j1.id, "drill-owner");
    const discardSent = await coaching.discardCoachingNote(j1.id, "drill-owner");
    c.ok("a sent note cannot be re-sent or discarded", !again.ok && !discardSent.ok);

    const discarded = await coaching.discardCoachingNote(j2.id, "drill-owner");
    c.ok("discard closes a draft", discarded.ok && (await coaching.coachingFor(j2.id))?.status === "discarded");
    c.ok("…and a discarded one cannot be sent", !(await coaching.sendCoachingNote(j2.id, "drill-owner")).ok);
    c.ok("no model call; the fence stayed closed (Slack/OpenPhone are the staff send)", fence.blocked.filter((b) => !/slack|openphone/i.test(b)).length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

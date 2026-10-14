// ---------------------------------------------------------------------------
// DRILL: PHOTOGRAPHER COACHING NOTE (Oct 14 2026, prompt pack 10, plan §12.3).
//   · only on-site findings staff did not overrule feed the note, grouped by
//     rule with photo positions; the 30-day trend counts shoots, not findings
//   · the prompt is the pack's, and no image is sent (text only)
//   · blame language is refused once and retried; the draft is stored on the
//     job, Jordan gets ONE bell, the same QC run is never drafted twice
//   · approve sends to the photographer (staff channel) and is logged; a sent
//     note cannot be discarded or re-sent
// The Messages API is stubbed through the QC caller's test transport.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5999) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const claude = await import("@/lib/photoDelivery/qc/claude");
    const coaching = await import("@/lib/photoDelivery/coaching");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    await savePhotoDeliverySettings({ qcEnabled: true }, "drill");
    claude.__setQcSleepForTests(async () => {});

    const bodies: Record<string, unknown>[] = [];
    const answers = [
      { note: "Hi Harrison, you forgot the toilet lids again.", preShootReminders: ["Lids down", "Check mirrors", "Walk the yard"], focusRuleIds: ["BATH_TOILET_SEAT_OPEN"] },
      { note: "Hi Harrison, thanks for the Maple Street shoot. Your verticals were straight in every room. Next time, give each bathroom a ten-second sweep so the lids are down, and check the mirrors from the camera position. Nice work out there!", preShootReminders: ["Bathrooms: lids down before each frame", "Check mirrors from the camera position", "Walk the front yard for hoses and bins"], focusRuleIds: ["BATH_TOILET_SEAT_OPEN", "REFL_CAMERA_TRIPOD_IN_MIRROR", "NOT_A_RULE"] },
    ];
    claude.__setQcTransportForTests(async (body) => {
      bodies.push(body);
      const a = answers.shift() ?? answers[answers.length - 1];
      return { status: 200, requestId: "req", retryAfterMs: null, json: { model: String(body.model), stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(a) }], usage: { input_tokens: 1700, output_tokens: 250 } } };
    });

    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-coach@example.test", slackId: "UOWNER" } });
    await prisma.appUser.create({ data: { email: "owner-coach@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    const shooter = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-coach@example.test" } });
    const client = await prisma.client.create({ data: { name: "Coach Client TEST" } });
    const project = await prisma.project.create({ data: { title: "14 Maple St, Testville, PA", clientId: client.id, photographerId: shooter.id, shootDate: new Date(Date.now() - 86_400_000) } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    const photos = await Promise.all([0, 1, 2].map((i) => prisma.photoAsset.create({ data: { jobId: job.id, name: `p${i}.jpg`, sequence: i, status: "ACTIVE", sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/${i}.jpg` } })));
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1.1", finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    const f = (photoId: string, ruleId: string, status = "OPEN", responsibility = "PHOTOGRAPHER") =>
      prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "P1", specificIssue: "x", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility, fixStrategy: "HUMAN_REVIEW", status } });
    await f(photos[0].id, "BATH_TOILET_SEAT_OPEN");
    await f(photos[2].id, "BATH_TOILET_SEAT_OPEN");
    await f(photos[1].id, "REFL_CAMERA_TRIPOD_IN_MIRROR");
    await f(photos[1].id, "PREP_TRASH_CANS", "FALSE_POSITIVE"); // staff overruled: never in the note
    await f(photos[1].id, "EXPO_HDR_HALOS", "OPEN", "EDITOR"); // not on-site: never in the note

    const d1 = await coaching.draftCoachingNote(job.id);
    c.ok("a draft is made", d1.drafted, d1.reason);
    c.ok("blame language was refused once and retried (two calls)", bodies.length === 2);
    const user = JSON.stringify(bodies[0].messages);
    c.ok("the findings table groups by rule with positions (toilet: 2, photos 1 and 3)", /BATH_TOILET_SEAT_OPEN \| [^|]+ \| 2 \| 1, 3 \| MAJOR/.test(user));
    c.ok("an overruled finding and an editor's finding are left out", !/PREP_TRASH_CANS/.test(user) && !/EXPO_HDR_HALOS/.test(user));
    c.ok("text only: no image block", !/"type":"image"/.test(user));
    c.ok("the system prompt is the pack's", /You write a short coaching note to a Realtour Pilot photographer/.test(JSON.stringify(bodies[0].system)));
    const draft = await coaching.coachingFor(job.id);
    c.ok("the draft is stored with three reminders and status draft", draft?.status === "draft" && draft.preShootReminders.length === 3 && /Harrison/.test(draft.note));
    c.ok("one bell for Jordan to approve it", (await prisma.notification.count({ where: { kind: "photo_coaching_draft" } })) === 1);
    const d2 = await coaching.draftCoachingNote(job.id);
    c.ok("the same QC run is not drafted twice", !d2.drafted && bodies.length === 2);

    const sent = await coaching.sendCoachingNote(job.id, "drill-owner");
    c.ok("approve sends it to the photographer", sent.ok, sent.message);
    c.ok("…and logs coaching:sent", (await coaching.coachingFor(job.id))?.status === "sent");
    const again = await coaching.sendCoachingNote(job.id, "drill-owner");
    const discard = await coaching.discardCoachingNote(job.id, "drill-owner");
    c.ok("a sent note cannot be re-sent or discarded", !again.ok && !discard.ok);
    c.ok("provider fence stayed closed", fence.blocked.filter((b) => !/slack|openphone/i.test(b)).length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

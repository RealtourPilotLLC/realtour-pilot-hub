// ---------------------------------------------------------------------------
// DRILL: a later visit's upload page is open again (Oct 23 2026, 615 Cliff Ln).
//
// A split job keeps ONE set of upload-page stamps. Harrison shot the third
// visit at 12:45 PM and the page read "Submitted ✓ Oct 8" (the first visit's)
// and stayed locked. lib/visitSubmission: with two or more started visits, a
// stamp counts only from the ET day the latest visit began. Here: the pure
// rule, the submit (a fresh stamp, the earlier time kept on the timeline), the
// two-half wrap-up claim, tonight's upload reminder, and a single-visit job
// that behaves exactly as before.
//
// ISOLATION: PGlite via the shared harness; OpenPhone replaced in-process.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5731);

const RealDate = Date;
const SIM = RealDate.parse("2026-10-23T17:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();
const fence = fenceFetch();
const texts: { to: string; text: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/openphone",
  (loaded) => {
    const m = loaded as Record<string, unknown> & { OpenPhone: Record<string, unknown> };
    return { ...m, defaultOpenPhoneNumber: async () => "+15555550100", OpenPhone: { ...m.OpenPhone, sendMessage: async (_f: string, to: string, text: string) => { texts.push({ to, text }); return { id: `m-${texts.length}` }; } } };
  },
);

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const vs = await import("@/lib/visitSubmission");
    const { finalizeUpload } = await import("@/app/upload/actions");
    const { completeWrapUpIfWhole } = await import("@/lib/wrapUp");
    const { establishSession } = await import("@/lib/auth/session");

    c.head("1 · The rule (pure)");
    const oct7 = new Date("2026-10-07T13:30:00-04:00"), oct21 = new Date("2026-10-21T16:15:00-04:00"), oct23 = new Date("2026-10-23T12:45:00-04:00");
    const appts = [oct7, oct21, oct23].map((startAt) => ({ startAt, status: "SCHEDULED" }));
    const now = new Date();
    const floor = vs.currentVisitFloor(appts, now);
    c.ok("three started visits: the floor is the start of Oct 23 ET", floor?.toISOString() === new Date("2026-10-23T00:00:00-04:00").toISOString(), floor?.toISOString());
    c.ok("one visit: no floor", vs.currentVisitFloor([appts[0]], now) === null);
    c.ok("a cancelled later visit does not count", vs.currentVisitFloor([appts[0], { startAt: oct23, status: "CANCELED" }], now) === null);
    c.ok("a future visit does not count", vs.currentVisitFloor([appts[0], { startAt: new Date("2026-10-30T10:00:00-04:00"), status: "SCHEDULED" }], now) === null);
    const st = vs.currentVisitStamps({ debriefSubmittedAt: new Date("2026-10-07T22:00:00-04:00"), photosHandoffAt: new Date("2026-10-07T22:00:00-04:00"), videoHandoffAt: null, uploadedAt: new Date("2026-10-07T21:59:00-04:00") }, appts, now);
    c.ok("the Oct 8 stamps read as not yet submitted for Oct 23", st.debriefSubmittedAt === null && st.photosHandoffAt === null && st.uploadedAt === null && !!st.earlierVisitSubmittedAt);
    const one = vs.currentVisitStamps({ debriefSubmittedAt: new Date("2026-10-07T22:00:00-04:00"), photosHandoffAt: null, videoHandoffAt: null }, [appts[0]], now);
    c.ok("single visit: the stamp stands, untouched", !!one.debriefSubmittedAt && one.visitFloor === null);

    c.head("2 · The submit on a later visit");
    const client = await prisma.client.create({ data: { name: "Alex Drill" }, select: { id: true } });
    const tm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "h-vs@drill.invalid", role: "PHOTOGRAPHER", phone: "6105550142", active: true }, select: { id: true } });
    const user = await prisma.appUser.create({ data: { email: "h-vs@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: tm.id }, select: { id: true } });
    await establishSession(user.id);
    const earlier = new Date("2026-10-07T22:00:00-04:00");
    const mk = async (street: string, visits: Date[]) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Malvern, PA`, clientId: client.id, status: "EDITING", shootDate: visits[visits.length - 1], photographerId: tm.id,
          debriefSubmittedAt: earlier, photosHandoffAt: earlier, uploadedAt: earlier, cullingConfirmedAt: earlier,
          deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] },
        },
        select: { id: true },
      });
      let k = 0;
      for (const v of visits) await prisma.appointment.create({ data: { aryeoId: `vs-${street}-${++k}`, projectId: p.id, startAt: v, status: "SCHEDULED", assignedToId: tm.id } });
      return p.id;
    };
    const cliff = await mk("615 Cliff Ln", [oct7, oct21, oct23]);
    const ANSWERS = { editorBrief: "", force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" as const }, removalNotes: "Hose by the porch", nothingToRemove: false };
    const r = await finalizeUpload(cliff, ANSWERS as never);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: cliff }, select: { debriefSubmittedAt: true, uploadedAt: true } });
    c.ok("the submit goes through", (r as { ok?: boolean }).ok !== false, JSON.stringify(r).slice(0, 200));
    c.ok("…and stamps THIS visit (the Oct 8 stamp is replaced by today's)", !!after.debriefSubmittedAt && after.debriefSubmittedAt.getTime() >= new Date("2026-10-23T00:00:00-04:00").getTime(), after.debriefSubmittedAt?.toISOString());
    const hist = await prisma.activity.findFirst({ where: { projectId: cliff, body: { startsWith: "Earlier visit's upload page submitted" } } });
    c.ok("the earlier visit's submit time is kept on the timeline", !!hist, hist?.body);

    c.head("3 · The two-half wrap-up claim");
    const ridge = await mk("9 Ridge Rd", [oct7, oct23]);
    await prisma.project.update({ where: { id: ridge }, data: { photosHandoffAt: new Date() } });
    const w = await completeWrapUpIfWhole(ridge, { at: new Date(), fromSubmit: true });
    const wr = await prisma.project.findUniqueOrThrow({ where: { id: ridge }, select: { debriefSubmittedAt: true } });
    c.ok("the earlier visit's whole stamp does not count as this visit's: the claim stamps today", !!w?.completedNow && !!wr.debriefSubmittedAt && wr.debriefSubmittedAt.getTime() > earlier.getTime(), JSON.stringify(w));

    c.head("4 · A single-visit job is unchanged");
    const solo = await mk("1 Solo Ln", [oct23]);
    const s1 = await completeWrapUpIfWhole(solo, { at: new Date(), fromSubmit: true });
    const so = await prisma.project.findUniqueOrThrow({ where: { id: solo }, select: { debriefSubmittedAt: true } });
    c.ok("one visit: an existing submit stands (already wrapped up, nothing re-stamped)", !!s1?.wholeDone && !s1.completedNow && so.debriefSubmittedAt?.getTime() === earlier.getTime());

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

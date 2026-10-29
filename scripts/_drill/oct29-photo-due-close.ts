// ---------------------------------------------------------------------------
// DRILL: A PHOTO PROMISE CLOSES AT THE END OF A DAY (Oct 29 2026, Kyle on the
// photo board: "Why are these showing late if they're from yesterday?").
// 40 N Perry St (shot Wed Oct 28, 9 AM), 512 Firethorn Rd (2 PM) and 825
// State St (3 PM) read "Late" on Thursday morning: the board dated photos at
// the shoot plus the built-in 20 hours (5 AM, 10 AM, 11 AM) while Settings
// said 24 and the promise is the next DAY (the delivery board's next_day tier
// closes at 5 PM). Now:
//   1  a deadline whose hours land before the close of their day is that
//      close; past it, the hours stand; never earlier than the hour quote
//      (swept hour by hour across the Nov 1 clock change); video untouched
//   2  the photo board's deadline uses Settings → Turnaround promises
//   3  the three jobs open due Thu 5 PM ET and read "left", not "Late", at
//      1:15 PM; an evening shoot keeps its 24 hours
//   4  the jobs board's "Photos" due agrees with the photo board
//   5  the guide says so
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6994). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const PORT = Number(process.env.DRILL_PORT ?? 6994);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const T = (s: string) => new Date(s);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
const HOUR = 3_600_000;

// Thu Oct 29 2026, 1:15 PM ET: when Kyle asked.
const NOW = T("2026-10-29T17:15:00Z");
const THU_5PM = "2026-10-29T21:00:00.000Z";

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const tasks = await import("@/lib/tasks");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const { DEFAULT_TURNAROUNDS } = await import("@/lib/settings");
    const { slaState } = await import("@/components/photoDelivery/format");
    const { etDayKey, etAt } = await import("@/lib/datetime");
    const live = { ...DEFAULT_TURNAROUNDS, photos: 24, drone: 24, twilight: 24, headshot: 24 }; // what production's Settings say

    c.head("1 · the rule");
    const wed9 = T("2026-10-28T13:00:00Z"); // Wed 9 AM ET
    c.ok("a 9 AM shoot is due 5 PM the next day under Settings (24 hours)", iso(jobs.photoDueFor(wed9, false, live)) === THU_5PM, iso(jobs.photoDueFor(wed9, false, live)));
    c.ok("and under the built-in 20 hours too (it was 5 AM)", iso(jobs.photoDueFor(wed9, false)) === THU_5PM, iso(jobs.photoDueFor(wed9, false)));
    c.ok("2 PM and 3 PM shoots: the same 5 PM", iso(jobs.photoDueFor(T("2026-10-28T18:00:00Z"), false, live)) === THU_5PM && iso(jobs.photoDueFor(T("2026-10-28T19:00:00Z"), false, live)) === THU_5PM);
    c.ok("a 6 PM shoot keeps its 24 hours (6 PM the next day, never cut short)", iso(jobs.photoDueFor(T("2026-10-28T22:00:00Z"), false, live)) === "2026-10-29T22:00:00.000Z", iso(jobs.photoDueFor(T("2026-10-28T22:00:00Z"), false, live)));
    c.ok("same-day photos still close at 5 PM the shoot day", iso(jobs.photoDueFor(wed9, true, live)) === "2026-10-28T21:00:00.000Z", iso(jobs.photoDueFor(wed9, true, live)));
    c.ok("floor plans (36 hours) from 9 AM land at 9 PM, past the close: unchanged", iso(tasks.deliveryDueFrom(wed9, "FLOORPLAN", { rules: live })) === "2026-10-30T01:00:00.000Z", iso(tasks.deliveryDueFrom(wed9, "FLOORPLAN", { rules: live })));
    c.ok("virtual staging (48 hours) from 9 AM: 5 PM two days on, not 9 AM", iso(tasks.deliveryDueFrom(wed9, "VIRTUAL_STAGING", { rules: live })) === "2026-10-30T21:00:00.000Z", iso(tasks.deliveryDueFrom(wed9, "VIRTUAL_STAGING", { rules: live })));
    c.ok("a standard video keeps its exact 48 hours (the video board's clock)", iso(tasks.deliveryDueFrom(wed9, "SOCIAL_REEL", { rules: live })) === "2026-10-30T13:00:00.000Z", iso(tasks.deliveryDueFrom(wed9, "SOCIAL_REEL", { rules: live })));
    c.ok("the close hour is the office's when Settings carries one", iso(jobs.photoDueFor(wed9, false, { ...live, businessDayEndHour: 18 } as never)) === "2026-10-29T22:00:00.000Z");

    // Every hour for four days across the Nov 1 clock change, every hour-quoted type.
    const types = ["PHOTOS", "DRONE", "TWILIGHT", "FLOORPLAN", "MATTERPORT_3D", "ZILLOW_3D", "HEADSHOT", "VIRTUAL_STAGING", "OTHER"];
    const hoursOf: Record<string, number> = { PHOTOS: live.photos, DRONE: live.drone, TWILIGHT: live.twilight, FLOORPLAN: live.floorPlan, MATTERPORT_3D: live.tour3d, ZILLOW_3D: live.tour3d, HEADSHOT: live.headshot, VIRTUAL_STAGING: live.virtualStaging, OTHER: live.otherHours };
    let checked = 0, earlier = 0, oddTime = 0, videoMoved = 0;
    for (let a = T("2026-10-30T04:00:00Z").getTime(); a < T("2026-11-03T04:00:00Z").getTime(); a += HOUR) {
      const anchor = new Date(a);
      for (const t of types) {
        const due = tasks.deliveryDueFrom(anchor, t, { rules: live });
        const byHours = a + hoursOf[t] * HOUR;
        const close = etAt(etDayKey(new Date(byHours)), 17).getTime();
        checked++;
        if (due.getTime() < byHours) earlier++;
        if (due.getTime() !== byHours && due.getTime() !== close) oddTime++;
      }
      if (tasks.deliveryDueFrom(anchor, "VIDEO", { rules: live }).getTime() !== a + live.standardVideoHours * HOUR) videoMoved++;
    }
    c.ok(`never earlier than the hour quote (${checked} anchor × type pairs)`, earlier === 0, `${earlier} earlier`);
    c.ok("always either the hour quote or 5 PM ET that day", oddTime === 0, `${oddTime} other`);
    c.ok("standard video untouched at every anchor", videoMoved === 0, `${videoMoved} moved`);

    c.head("2 · the photo board reads Settings");
    const src = read("src/lib/photoDelivery/jobs.ts");
    c.ok("both deadline writers pass the Settings turnarounds", src.includes("await sameDayPhotos(p.id), rules)") && src.includes("await sameDayPhotos(job.projectId), await turnaroundRules())") && (src.match(/photoDueFor\(/g) ?? []).length === 3);

    c.head("3 · Kyle's three jobs");
    await prisma.appSetting.upsert({ where: { key: "turnarounds" }, create: { key: "turnarounds", value: JSON.stringify(live) }, update: { value: JSON.stringify(live) } });
    const client = await prisma.client.create({ data: { name: "Drill Agent" } });
    const shoots: [string, string][] = [["40 N Perry St", "2026-10-28T13:00:00Z"], ["512 Firethorn Rd", "2026-10-28T18:00:00Z"], ["825 State St", "2026-10-28T19:00:00Z"], ["9 Dusk Ln", "2026-10-28T22:00:00Z"]];
    const ids: Record<string, string> = {};
    let n = 0;
    for (const [street, at] of shoots) {
      n++;
      const p = await prisma.project.create({ data: { title: `${street}, Lancaster, PA 17603`, clientId: client.id, status: "SHOT", shootDate: T(at), aryeoOrderId: `O-k7-${n}`, aryeoListingId: `L-k7-${n}` } });
      await prisma.appointment.create({ data: { projectId: p.id, aryeoId: `A-k7-${n}`, startAt: T(at), endAt: new Date(T(at).getTime() + 2 * HOUR), status: "SCHEDULED" } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS", label: "Photos", status: "PENDING" } as never });
      ids[street] = p.id;
    }
    const opened = await jobs.openNewJobs(NOW);
    c.ok("four photo jobs opened", opened === 4, String(opened));
    for (const [street] of shoots.slice(0, 3)) {
      const j = await prisma.photoJob.findUnique({ where: { projectId: ids[street] }, select: { slaDueAt: true } });
      const s = slaState(iso(j?.slaDueAt), NOW.getTime());
      c.ok(`${street}: due Thu 5 PM ET, "${s.label}" at 1:15 PM`, iso(j?.slaDueAt) === THU_5PM && !/^Late/.test(s.label), `${iso(j?.slaDueAt)} ${s.label}`);
    }
    const dusk = await prisma.photoJob.findUnique({ where: { projectId: ids["9 Dusk Ln"] }, select: { slaDueAt: true } });
    c.ok("the 6 PM shoot is due Thu 6 PM ET", iso(dusk?.slaDueAt) === "2026-10-29T22:00:00.000Z", iso(dusk?.slaDueAt));
    const lateNow = await prisma.photoJob.count({ where: { stage: { not: "DELIVERED" }, slaDueAt: { lt: NOW } } });
    c.ok("the behind alert's query finds none of them late at 1:15 PM", lateNow === 0, String(lateNow));
    const after = slaState(THU_5PM, T("2026-10-29T21:30:00Z").getTime());
    c.ok("still undelivered at 5:30 PM: late, as it should be", /^Late by/.test(after.label), after.label);

    c.head("4 · the jobs board agrees");
    const dues = tasks.pendingDuesByCategory({ shootDate: wed9, deliverables: [{ type: "PHOTOS", label: "Photos" }], turnarounds: live });
    const photos = dues.find((d) => /photo/i.test(d.category));
    c.ok("the Photos category is due Thu 5 PM ET", iso(photos?.at) === THU_5PM, JSON.stringify(dues));

    c.head("5 · the guide");
    c.ok("the guide says photos shot yesterday are due by 5 PM today", /photos shot yesterday are due by 5 PM today/.test(read("src/app/resources/guide/content.ts")));

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

// ---------------------------------------------------------------------------
// DRILL: VIDEO AUDIT FOLLOW-UPS (Oct 22 2026): C1 system part, M2, M9, L4.
//
//   DRILL_PORT=6995 node scripts/_drill/run-all.cjs scripts/_drill/oct22-video-audit-followups.ts
//
//   1. C1: "Mark as uploaded" checks the Aryeo listing has THIS file (time
//      and byte size); 859 N Lawrence St's shape is refused in words; the
//      hourly listing check leaves a different-size file for a person.
//   2. M2: the behind alert counts a late monthly program video (99 Bridge
//      St's shape), dated by its own promise; one waiting on a second shoot
//      and a delivered one stay out.
//   3. M9: KPI "Video late" judges the photographer's own handoff (538 Onward
//      Ave's shape: the office submitted at noon, the raws were in the night
//      before), and the job as it stood then.
//   4. L4: the date labels that broke hydration print the same words
//      everywhere (two calls, plain spaces, the zone named).
// Isolated PGlite; the listing video's HEAD is answered in-process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6995);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// ---- the clock: Fri Oct 23 2026, 12:00 PM ET ---------------------------------------
const RealDate = Date;
const SIM = RealDate.parse("2026-10-23T16:00:00.000Z");
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
const at = (iso: string) => new RealDate(iso);

installNextStubs();
// The listing videos' download links, answered here: HEAD → their size.
const sizes = new Map<string, number>();
const heads: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://cdn.aryeo.drill.invalid/")) return null;
  heads.push(`${init?.method ?? "GET"} ${url}`);
  const n = sizes.get(url);
  return n ? new Response(null, { status: 200, headers: { "content-length": String(n) } }) : new Response(null, { status: 404 });
});
/** An Aryeo media id carrying `iso` as its upload time (UUIDv7, readyToSend.aryeoIdTime). */
const mediaId = (iso: string, tail: string) => {
  const h = RealDate.parse(iso).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${tail.padStart(12, "0")}`;
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const warn = console.warn;
  try {
    const { prisma } = await import("@/lib/prisma");
    const dout = await import("@/lib/deliverableOutputs");
    const client = await prisma.client.create({ data: { name: "Joseph Drill" } });

    // =====================================================================
    c.head("1 · C1: the listing must carry this exact file");
    // =====================================================================
    const lfm = await import("@/lib/listingFileMatch");
    const RENDER = { readyAt: at("2026-10-22T21:52:00Z"), sizeBytes: 122_532_068, kind: "1080p" as const };
    const v859 = { id: mediaId("2026-10-22T21:41:00Z", "1"), at: at("2026-10-22T21:41:00Z"), sizeBytes: 114_597_798 };
    const timeWrong = lfm.judgeListingFile(RENDER, [v859]);
    c.ok("859's shape: the listing video went up before the render was saved → a different file", timeWrong.verdict === "mismatch" && /went up Thu, Oct 22, 5:41 PM ET, before this Topaz file was saved \(Thu, Oct 22, 5:52 PM ET\)/.test(timeWrong.message) && /for example the editor's original instead of the Topaz file/.test(timeWrong.message) && !/—/.test(timeWrong.message), timeWrong.message);
    const later = { id: mediaId("2026-10-22T22:05:00Z", "2"), at: at("2026-10-22T22:05:00Z"), sizeBytes: 114_597_798 };
    const sizeWrong = lfm.judgeListingFile(RENDER, [v859, later]);
    c.ok("a later video of the wrong size → a different file, both sizes named", sizeWrong.verdict === "mismatch" && /114\.6 MB \(114,597,798 bytes\); the Topaz file is 122\.5 MB \(122,532,068 bytes\)/.test(sizeWrong.message), sizeWrong.message);
    c.ok("the right size after the save → this file", lfm.judgeListingFile(RENDER, [v859, { ...later, sizeBytes: 122_532_068 }]).verdict === "match");
    c.ok("the exact bytes under an older id (Aryeo replaced the file in place) → still this file", lfm.judgeListingFile(RENDER, [{ ...v859, sizeBytes: 122_532_068 }]).verdict === "match");
    c.ok("a size that could not be read → nothing concluded", lfm.judgeListingFile(RENDER, [{ ...later, sizeBytes: null }]).verdict === "unknown" && lfm.judgeListingFile({ ...RENDER, sizeBytes: null }, [later]).verdict === "unknown");
    c.ok("no video on the listing → refused, with what to do", lfm.judgeListingFile(RENDER, []).verdict === "mismatch" && /shows no video yet/.test(lfm.judgeListingFile(RENDER, []).message));

    // The receipt itself, on real rows.
    const d = await import("@/lib/deliveryUploads");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    const fp = async (id: string) => sourceFingerprint((await loadCut(id))!)!;
    const listingJob = async (street: string, listingId: string) => {
      const p = await prisma.project.create({
        data: { title: `${street}, Philadelphia, PA`, clientId: client.id, status: "REVIEW", aryeoListingId: listingId, deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", status: "UPLOADED" }] } },
        select: { id: true, deliverables: { select: { id: true } } },
      });
      await dout.ensureOutputsForProject(p.id);
      return p;
    };
    const actor = { id: null, name: "Jordan Drill" };
    // (a) a 1080p render saved at 5:52 PM; the listing's only video went up at 5:41 PM.
    const L = await listingJob("859 N Lawrence St", "L-859");
    const v2 = await prisma.reviewSubmission.create({ data: { projectId: L.id, deliverableId: L.deliverables[0].id, slot: 1, round: 2, status: "APPROVED", source: "upload", fileName: "Revised.mov", sizeBytes: 114_597_798, blobUrl: "https://blob.drill.invalid/rev.mov", decidedAt: at("2026-10-22T21:30:00Z") } });
    await prisma.topazJob.create({ data: { submissionId: v2.id, projectId: L.id, state: "done", finalPath: "/Final/Revised_1080p.mp4", savedAt: RENDER.readyAt } });
    const refused = await d.recordUploaded(v2.id, actor, await fp(v2.id), undefined, { listing: { id: "L-859", videos: [{ id: v859.id, download_url: "https://cdn.aryeo.drill.invalid/859.mov" }] } });
    c.ok("Mark as uploaded is refused, saying the listing has a different file", !refused.ok && refused.listingMismatch === true && /The listing has a different file/.test(refused.message), refused.message);
    c.ok("…and no receipt was written", (await d.uploadsFor([v2.id])).size === 0);
    // (b) the editor's own file (already 1080p): the listing video matches its size → recorded, the match on the receipt.
    const M = await listingJob("12 Match St", "L-12");
    const own = await prisma.reviewSubmission.create({ data: { projectId: M.id, deliverableId: M.deliverables[0].id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "final.mp4", sizeBytes: 98_765_432, blobUrl: "https://blob.drill.invalid/final.mp4", createdAt: at("2026-10-23T13:00:00Z"), decidedAt: at("2026-10-23T14:00:00Z") } });
    const goodId = mediaId("2026-10-23T15:00:00Z", "3");
    sizes.set("https://cdn.aryeo.drill.invalid/good.mp4", 98_765_432);
    const ok = await d.recordUploaded(own.id, actor, await fp(own.id), undefined, { listing: { id: "L-12", videos: [{ id: goodId, download_url: "https://cdn.aryeo.drill.invalid/good.mp4" }] } });
    const rec = (await d.uploadsFor([own.id])).get(own.id) as (Awaited<ReturnType<typeof d.uploadsFor>> extends Map<string, infer R> ? R : never) & { listingCheck?: { verdict: string; mediaId: string | null } };
    c.ok("the right file on the listing: recorded, the match carried on the receipt", ok.ok && rec?.listingCheck?.verdict === "match" && rec.listingCheck.mediaId === goodId, JSON.stringify({ ok, check: rec?.listingCheck }));
    c.ok("one HEAD on the listing video's download link", heads.includes("HEAD https://cdn.aryeo.drill.invalid/good.mp4"), heads.join(", "));
    // (c) the wrong size after the file existed → refused.
    const W = await listingJob("14 Wrong Size St", "L-14");
    const ws = await prisma.reviewSubmission.create({ data: { projectId: W.id, deliverableId: W.deliverables[0].id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "final.mp4", sizeBytes: 50_000_000, blobUrl: "https://blob.drill.invalid/w.mp4", createdAt: at("2026-10-23T13:00:00Z"), decidedAt: at("2026-10-23T14:00:00Z") } });
    sizes.set("https://cdn.aryeo.drill.invalid/wrong.mp4", 49_000_000);
    const wrong = await d.recordUploaded(ws.id, actor, await fp(ws.id), undefined, { listing: { id: "L-14", videos: [{ id: mediaId("2026-10-23T15:00:00Z", "4"), download_url: "https://cdn.aryeo.drill.invalid/wrong.mp4" }] } });
    c.ok("the wrong size: refused", !wrong.ok && wrong.listingMismatch === true, wrong.message);
    // (d) Aryeo cannot be read (no key in the drill): nothing is refused.
    const U = await listingJob("16 Unread St", "L-16");
    const un = await prisma.reviewSubmission.create({ data: { projectId: U.id, deliverableId: U.deliverables[0].id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "u.mp4", sizeBytes: 1000, blobUrl: "https://blob.drill.invalid/u.mp4", decidedAt: at("2026-10-23T14:00:00Z") } });
    const unread = await d.recordUploaded(un.id, actor, await fp(un.id));
    const urec = (await d.uploadsFor([un.id])).get(un.id) as { listingCheck?: { verdict: string } } | undefined;
    c.ok("Aryeo unreadable: the receipt is recorded as before, its check 'unknown'", unread.ok && urec?.listingCheck?.verdict === "unknown", JSON.stringify({ unread, check: urec?.listingCheck }));
    const luc = read("src/lib/listingUploadCheck.ts");
    c.ok("the hourly listing check compares the new videos' sizes with the finished files' too", /listingVideoFacts\(listing, floor, newer\.length\)/.test(luc) && /its size differs\) — left for a person/.test(luc));

    // =====================================================================
    c.head("2 · M2: a late monthly program video reaches the behind alert");
    // =====================================================================
    const { behindReport, behindMessage } = await import("@/lib/behindAlert");
    const prog = await prisma.project.create({
      data: {
        title: "99 Bridge St, Phoenixville, PA", clientId: client.id, status: "EDITING", contentMonthId: "month-drill-erica", shootDate: at("2026-10-01T14:00:00Z"),
        deliverables: { create: [{ type: "VIDEO", label: "Personal Branding Reel", quantity: 3, status: "UPLOADED", uploadedAt: at("2026-10-01T20:00:00Z") }] },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(prog.id);
    const outs = await prisma.deliverableOutput.findMany({ where: { projectId: prog.id }, orderBy: { slot: "asc" } });
    const marked = await import("@/lib/secondShoot").then((m) => m.markVideoWaitingOnShoot({ projectId: prog.id, outputId: outs[2].id, note: "Half shot", actor: "Jordan", kick: false }));
    // (after the mark: its refresh re-derives the delivery stamps from the rounds)
    await prisma.deliverableOutput.updateMany({ where: { projectId: prog.id }, data: { promisedAt: at("2026-10-12T21:00:00Z") } });
    await prisma.deliverableOutput.update({ where: { id: outs[1].id }, data: { deliveredAt: at("2026-10-12T15:00:00Z") } });
    c.ok("video 3 marked waiting on a second shoot", marked.ok, marked.message);
    console.warn = () => {};
    const report = await behindReport(new Date(), { fresh: true });
    console.warn = warn;
    const mine = report.items.filter((i) => i.projectId === prog.id);

    // The plan's quota makes it a 4-video month: video 2 delivered, video 3 waiting, 1 and 4 late.
    c.ok("the month's late videos count; the delivered one and the one waiting on a second shoot stay out", outs.length === 4 && mine.length === 2 && mine.every((i) => i.program === true && i.kind === "video"), JSON.stringify({ outs: outs.length, mine }));
    c.ok("dated by its own promise (Oct 12, 5 PM ET): 10 days late", Math.round(mine[0]?.lateHours ?? 0) === Math.round((SIM - RealDate.parse("2026-10-12T21:00:00Z")) / 3_600_000), String(mine[0]?.lateHours));
    c.ok("the row says what it is and where it stands", /^Monthly video: no footage confirmed yet|^Monthly video: footage in, editing not started|^Monthly video: editing, no cut yet/.test(mine[0]?.who ?? ""), mine[0]?.who);
    const msg = behindMessage("raise", report.state, report.items.filter((i) => i.kind === "video"), "https://hub.drill.invalid");
    c.ok("the post counts them and says \"videos\", not \"listing videos\"", /2 videos are past the promise/.test(msg) && /• 99 Bridge St \(video\): 11 days late\. Monthly video/.test(msg) && !/listing video/.test(msg), msg.split("\n").slice(0, 2).join(" | "));

    // =====================================================================
    c.head("3 · M9: the photographer's own handoff, the job as it stood then");
    // =====================================================================
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-va@drill.invalid", role: "PHOTOGRAPHER", active: true } });
    await prisma.appUser.create({ data: { email: "harrison-va@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
    await prisma.appUser.create({ data: { email: "jordan-va@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const SHOT = at("2026-10-21T12:00:00Z"); // Wed 8:00 AM ET; video due Thu 9:00 AM ET
    let k = 0;
    const kpiJob = async (street: string, o: { by: string | null; at: Date | null; rawIn?: Date | null; extraReelAt?: Date }) => {
      k++;
      const p = await prisma.project.create({
        data: {
          title: `${street}, Phoenixville, PA`, clientId: client.id, status: "REVIEW", shootDate: SHOT, photographerId: harrisonTm.id, createdAt: at("2026-10-14T19:41:00Z"),
          videoInstructions: "STYLE: Fast-Paced\n\nCOLOR PROFILE: S-Log3\n\nVISION FOR THE EDIT\nFollow the script.",
          videoHandoffAt: o.at, videoHandoffBy: o.by, photosHandoffAt: at("2026-10-21T20:00:00Z"), photosHandoffBy: "Harrison Drill", debriefSubmittedAt: o.at, uploadedAt: at("2026-10-22T03:01:20Z"),
          appointments: { create: [{ aryeoId: `appt-va-${k}`, startAt: SHOT, status: "SCHEDULED", title: street }] },
          deliverables: {
            create: [
              { type: "PHOTOS", label: "Photos", status: "DONE", createdAt: at("2026-10-14T19:41:00Z") },
              ...(o.extraReelAt ? [] : [{ type: "SOCIAL_REEL" as const, label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", status: "UPLOADED" as const, createdAt: at("2026-10-14T19:41:00Z") }]),
              ...(o.extraReelAt ? [{ type: "SOCIAL_REEL" as const, label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", status: "PENDING" as const, createdAt: o.extraReelAt }] : []),
            ],
          },
        },
        select: { id: true },
      });
      await dout.ensureOutputsForProject(p.id);
      if (o.rawIn) await prisma.deliverableOutput.updateMany({ where: { projectId: p.id }, data: { rawInAt: o.rawIn } });
      return p.id;
    };
    const NOON = at("2026-10-22T16:06:31Z"); // Thu 12:06 PM ET, after the 9 AM deadline
    const office = await kpiJob("538 Onward Ave", { by: "Jordan Drill", at: NOON, rawIn: at("2026-10-22T03:01:09Z") });
    const theirs = await kpiJob("540 Onward Ave", { by: "Harrison Drill", at: NOON, rawIn: at("2026-10-22T03:01:09Z") });
    const blind = await kpiJob("542 Onward Ave", { by: "Jordan Drill", at: NOON, rawIn: null });
    const added = await kpiJob("544 Onward Ave", { by: null, at: null, extraReelAt: at("2026-10-22T22:28:42Z") });
    const { loadEvidence } = await import("@/lib/kpiEvidence");
    const ev = await loadEvidence(harrisonTm.id, { startKey: "2026-10-21", endKey: "2026-10-21", start: at("2026-10-21T04:00:00Z"), windowEnd: new Date() }, new Date());
    const late = (id: string) => ev.entries.find((e) => e.kind === "late_video" && e.projectId === id);
    c.ok("538's shape: the office submitted at 12:06 PM, the raws were in the night before → not late", !late(office), JSON.stringify(late(office)?.title));
    c.ok("…and the office's words are not scored as his instructions", !ev.entries.some((e) => e.kind === "instructions" && e.projectId === office));
    c.ok("his own submit at 12:06 PM still counts (files were in on time, notes late)", late(theirs)?.title === "Video notes late (files were in on time): 540 Onward Ave", late(theirs)?.title);
    c.ok("an office submit with no Dropbox stamp of his raws: not judged at all", !late(blind) && (ev.shoots.find((s) => s.projectId === blind)?.halvesJudged ?? 0) === 1, JSON.stringify(ev.shoots.find((s) => s.projectId === blind)));
    c.ok("a video the order added after the deadline is no \"Video not in yet\"", !ev.entries.some((e) => e.kind === "late_video" && e.projectId === added), JSON.stringify(ev.entries.filter((e) => e.projectId === added).map((e) => e.title)));
    const kpiSrc = read("src/lib/kpiEvidence.ts");
    c.ok("the second-shoot skips are kept", /const allVideoWaiting = held > 0 && held >= owedVideos;/.test(kpiSrc) && /\.filter\(\(v\) => !v\.waiting && v\.shape === "full"/.test(kpiSrc));

    // =====================================================================
    c.head("4 · L4: the same words on the server and in the browser");
    // =====================================================================
    const dt = await import("@/lib/datetime");
    const manila = dt.zonedDateTime("2026-10-24T18:07:00Z", "Asia/Manila");
    c.ok("an editor's own zone, two calls, plain spaces: \"Sun, Oct 25, 2:07 AM\"", manila === "Sun, Oct 25, 2:07 AM" && !/[   ]/.test(manila), JSON.stringify(manila));
    c.ok("a client's zone, long words: \"Thursday, October 29, 8:30 AM\"", dt.zonedDateTime("2026-10-29T12:30:00Z", "America/New_York", { weekday: "long", month: "long", day: "numeric" }) === "Thursday, October 29, 8:30 AM" && dt.zonedTime("2026-10-29T12:30:00Z", "America/Chicago") === "7:30 AM");
    const files = ["src/components/editing/BriefGotIt.tsx", "src/components/editing/BrandUpdatesBanner.tsx", "src/components/editing/RevisionIssuesPanel.tsx", "src/components/editing/EditorDesk.tsx", "src/components/editing/RemoveFromQueue.tsx", "src/components/portal/PortalScheduler.tsx", "src/components/portal/ScriptThread.tsx", "src/components/portal/PostingKitPanel.tsx"];
    const oneCall = files.filter((f) => /toLocale(?:String|TimeString)\([^)]*hour:/.test(read(f)));
    c.ok("no client component on /edit, /editing or /portal/me formats a time in one Intl call any more", oneCall.length === 0, oneCall.join(", "));
    const sla = read("src/components/editing/SlaCountdown.tsx");
    c.ok("SlaCountdown reads the clock only after mount", /useState<number \| null>\(null\)/.test(sla) && /if \(now === null\)/.test(sla));

    c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    console.warn = warn;
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

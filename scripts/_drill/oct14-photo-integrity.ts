// ---------------------------------------------------------------------------
// DRILL: CUT-OFF PHOTOS ON THE LISTING (Oct 14 2026). The first live QC run
// found two delivered photos that stop at exactly 2 MB / 6 MB with no JPEG end
// marker (half-gray for every viewer). The integrity check reads only the last
// 64 bytes of each listing photo (a 206 range answer) and:
//   · passes a complete JPEG (FF D9 at the end, even with trailing bytes)
//   · flags a cut-off file and says when it stops on an exact MB boundary
//   · does not guess when the host ignores the range (unknown, not broken)
//   · runs once per gallery version, alerts Jordan and Kyle once, and says
//     "the client can see them" for a delivered gallery
//   · is wired into the sync only for a gallery that has stopped changing
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6001) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const I = await import("@/lib/photoDelivery/integrity");
    const files: Record<string, { tail: number[]; total: number; ignoreRange?: boolean }> = {
      "good.jpeg": { tail: [0x12, 0x34, 0xff, 0xd9], total: 3_456_789 },
      "trailing.jpeg": { tail: [0xff, 0xd9, 0x00, 0x00, 0x00], total: 2_000_123 },
      "cut.jpeg": { tail: [0x53, 0x64], total: 2_097_152 },
      "cut6.jpeg": { tail: [0x04, 0x56], total: 6_291_456 },
      "norange.jpeg": { tail: [], total: 10, ignoreRange: true },
    };
    const asked: string[] = [];
    I.__setIntegrityFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const name = url.split("/").pop()!;
      asked.push(`${name} ${new Headers(init?.headers).get("range")}`);
      const f = files[name];
      if (f.ignoreRange) return new Response(new Uint8Array(f.total), { status: 200 });
      return new Response(new Uint8Array(f.tail), { status: 206, headers: { "content-range": `bytes ${f.total - f.tail.length}-${f.total - 1}/${f.total}` } });
    }) as typeof fetch);

    const t = (n: string) => I.jpegTail(`https://cdn.aryeo.com/x/${n}`);
    c.ok("a complete JPEG passes", (await t("good.jpeg")).ok === true);
    c.ok("a JPEG with bytes after the end marker passes", (await t("trailing.jpeg")).ok === true);
    const cut = await t("cut.jpeg");
    c.ok("a file cut off at exactly 2 MB is flagged, and the reason says so", cut.ok === false && /exactly 2 MB/.test(cut.reason ?? ""), cut.reason ?? "");
    c.ok("a host that ignores the range is 'unknown', never 'broken'", (await t("norange.jpeg")).ok === null);
    c.ok("only the last 64 bytes are asked for", asked.every((a) => a.endsWith("bytes=-64")));

    const client = await prisma.client.create({ data: { name: "Integrity TEST" } });
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-int@example.test", slackId: "UO" } });
    await prisma.appUser.create({ data: { email: "owner-int@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    const p = await prisma.project.create({ data: { title: "2236 Test Dr, Allentown, PA", clientId: client.id } });
    const job = await prisma.photoJob.create({ data: { projectId: p.id, stage: "DELIVERED" } });
    for (const [i, n] of ["good.jpeg", "cut.jpeg", "cut6.jpeg", "norange.jpeg"].entries())
      await prisma.photoAsset.create({ data: { jobId: job.id, name: `2236 Test Dr (${i + 1} of 4).jpg`, sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/x/${n}`, sequence: i, status: "ACTIVE" } });
    const r1 = await I.checkGalleryIntegrity(job.id, "fp1", { delivered: true });
    c.ok("the gallery check finds both cut-off photos by name", r1.broken.length === 2 && r1.broken.includes("2236 Test Dr (2 of 4).jpg") && r1.broken.includes("2236 Test Dr (3 of 4).jpg"), JSON.stringify(r1));
    const bells = await prisma.notification.findMany({ where: { kind: "photo_listing_corrupt" } });
    c.ok("one alert (owner on this roster), naming the photos", bells.length === 1 && /2 of 4/.test(bells[0].body ?? ""));
    c.ok("the alert has no em or en dash", bells.every((b) => !/[–—]/.test(`${b.title} ${b.body}`)));
    const r2 = await I.checkGalleryIntegrity(job.id, "fp1", { delivered: true });
    c.ok("the same gallery version is not checked or alerted twice", r2.skipped && (await prisma.notification.count({ where: { kind: "photo_listing_corrupt" } })) === 1);
    c.ok("the check is recorded on the job's activity log", (await prisma.photoJobEvent.count({ where: { jobId: job.id, action: "integrity:fp1" } })) === 1);

    const sync = fs.readFileSync(path.join(REPO, "src/lib/photoDelivery/jobs.ts"), "utf8");
    c.ok("the sync runs it only for a listing gallery that did not change in this pass", /source === "aryeo" && entries\.length > 0 && !changed\)[\s\S]{0,200}checkGalleryIntegrity\(jobId, fp/.test(sync));
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

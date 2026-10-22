// ---------------------------------------------------------------------------
// DRILL: THE VIDEO REVIEW ROOM DATES A VIDEO BY ITS VIDEO (Oct 22 2026, audit
// H1). The board (and the behind alert that reads it) dated a listing video by
// the order line whose NAME had a video word, so "Social Influencer",
// "Standard Package" and "Agent on Camera" fell back to the job's earliest
// item (the next-day Zillow tour, the photos). Replayed at Thu Oct 23 2026
// 5:01 PM ET, 850 Springbank Ln, 913 Lakeview Ct and 1316 Blair Cir all read
// late, and the alert would have posted "very behind" for videos due Oct 24-28.
//   1  the three live shapes (rows copied from production, read only) plus
//      an "Agent on Camera" job and an unpinned Social Influencer: none late at
//      Oct 23 5:01 PM; each dated by THE video due (the pin, else the SLA off
//      the video row), the same instant the editor's ping (editDueFor) reads
//   2  the behind alert's read at that minute: nothing late, level ok
//   3  controls: a standard video shot Oct 20 IS late; the office's own date
//      still wins on the board (a Social Influencer the office dated Oct 23
//      11 AM reads late); both are what the alert would list
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6991). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const PORT = Number(process.env.DRILL_PORT ?? 6991);

// Thu Oct 23 2026, 5:01 PM ET (EDT, UTC-4): the minute the false alarm fired.
const NOW = new Date("2026-10-23T21:01:00Z");
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { videoDeliveryBoard, VIDEO_LANES } = await import("@/lib/videoDelivery");
    const { behindReport } = await import("@/lib/behindAlert");
    const { editDueFor, videoDueOf } = await import("@/lib/editorDue");
    const { categoryLabelsForLabel } = await import("@/lib/qcCategories");

    let n = 0;
    type Del = { type: string; label: string; productTitle: string };
    const mk = async (o: { street: string; client: string; status: string; shoot: Date; pin?: Date | null; due?: Date | null; items: string[]; dels: Del[] }) => {
      const client = (await prisma.client.findFirst({ where: { name: o.client } })) ?? (await prisma.client.create({ data: { name: o.client } }));
      n++;
      const p = await prisma.project.create({
        data: {
          title: `${o.street}, Wayne, PA 19087`, clientId: client.id, status: o.status as never, shootDate: o.shoot,
          promisedDueAt: o.pin ?? null, dueOverrideAt: o.due ?? null, aryeoListingId: `L-h1-${n}`, aryeoOrderId: `O-h1-${n}`,
        },
      });
      await prisma.appointment.create({ data: { projectId: p.id, aryeoId: `A-h1-${n}`, startAt: o.shoot, endAt: new Date(o.shoot.getTime() + 4 * 3_600_000), status: "SCHEDULED" } });
      for (const t of o.items) await prisma.orderItem.create({ data: { projectId: p.id, title: t, amount: 100 } });
      for (const d of o.dels) {
        const row = await prisma.deliverable.create({ data: { projectId: p.id, type: d.type as never, label: d.label, productTitle: d.productTitle, quantity: 1 } });
        if (d.type === "VIDEO" || d.type === "SOCIAL_REEL") await prisma.deliverableOutput.create({ data: { deliverableId: row.id, projectId: p.id, slot: 1, category: "VIDEO" } });
      }
      return p;
    };
    const standardPackage = (): Del[] => [
      { type: "PHOTOS", label: "Photos", productTitle: "Standard Package" },
      { type: "DRONE", label: "Drone Photos", productTitle: "Standard Package" },
      { type: "VIDEO", label: "Standard Package", productTitle: "Standard Package" },
      { type: "FLOORPLAN", label: "Floor Plan", productTitle: "Standard Package" },
      { type: "ZILLOW_3D", label: "Zillow 3D Tour", productTitle: "Zillow Showcase 3D Tour Add-on" },
    ];
    const influencer = (): Del[] => [
      { type: "ZILLOW_3D", label: "Zillow 3D Tour", productTitle: "Zillow Showcase 3D Tour Add-on" },
      { type: "PHOTOS", label: "Photos", productTitle: "Social Influencer" },
      { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer" },
      { type: "DRONE", label: "Drone Photos", productTitle: "Social Influencer" },
      { type: "FLOORPLAN", label: "Floor Plan", productTitle: "Social Influencer" },
    ];

    c.head("0 · the shape that broke: these product names carry no video word");
    for (const name of ["Social Influencer", "Standard Package", "Agent on Camera"]) {
      c.ok(`"${name}" is not read as a video by name`, !categoryLabelsForLabel(name).includes("Video"), JSON.stringify(categoryLabelsForLabel(name)));
    }

    // ---- the three live shapes (production rows, Oct 22 2026) ----
    const springbank = await mk({
      street: "850 Springbank Ln", client: "John Collins", status: "SHOT",
      shoot: new Date("2026-10-22T17:00:00Z"), pin: new Date("2026-10-24T17:00:00Z"),
      items: ["Standard Package", "Zillow Showcase 3D Tour Add-on"], dels: standardPackage(),
    });
    const lakeview = await mk({
      street: "913 Lakeview Ct", client: "Mike Flatley", status: "SCHEDULED",
      shoot: new Date("2026-10-22T13:00:00Z"), pin: new Date("2026-10-28T21:00:00Z"),
      items: ["Zillow Showcase 3D Tour Add-on", "Social Influencer"], dels: influencer(),
    });
    const blair = await mk({
      street: "1316 Blair Cir", client: "Mike Flatley", status: "SCHEDULED",
      shoot: new Date("2026-10-22T17:00:00Z"), pin: new Date("2026-10-25T21:00:00Z"),
      items: ["Zillow Showcase 3D Tour Add-on", "Social Influencer"], dels: influencer(),
    });
    // Two more of the same family, unpinned, so the SLA engine (not a pin) dates them.
    const greenleaf = await mk({
      street: "2865 Greenleaf Ct", client: "Georgiana Torrella", status: "SCHEDULED",
      shoot: new Date("2026-10-23T18:30:00Z"), pin: null,
      items: ["Agent on Camera", "Standard Package", "Zillow Showcase 3D Tour Add-on"], dels: standardPackage(),
    });
    const unpinned = await mk({
      street: "5 Unpinned Influencer Way", client: "Mike Flatley", status: "SHOT",
      shoot: new Date("2026-10-22T13:00:00Z"), pin: null,
      items: ["Zillow Showcase 3D Tour Add-on", "Social Influencer"], dels: influencer(),
    });

    const rowsOf = (b: Awaited<ReturnType<typeof videoDeliveryBoard>>, pid: string) =>
      VIDEO_LANES.flatMap((l) => b.lanes[l]).filter((r) => r.projectId === pid);

    c.head("1 · the board at Thu Oct 23, 5:01 PM ET: none of them late, each dated by its video");
    const board = await videoDeliveryBoard({ now: NOW });
    const expect: [string, { id: string }, string][] = [
      ["850 Springbank Ln (Standard Package, pinned Sat Oct 24 1 PM)", springbank, "2026-10-24T17:00:00.000Z"],
      ["913 Lakeview Ct (Social Influencer, pinned Wed Oct 28 5 PM)", lakeview, "2026-10-28T21:00:00.000Z"],
      ["1316 Blair Cir (Social Influencer, pinned Sun Oct 25 5 PM)", blair, "2026-10-25T21:00:00.000Z"],
      ["2865 Greenleaf Ct (Agent on Camera + Standard Package, unpinned: 48 h from the shoot)", greenleaf, "2026-10-25T18:30:00.000Z"],
      // Today's premium rule (Oct 22 2026): three calendar days, 5 PM ET. The
      // pinned 913 Lakeview above keeps the later promise it was sold under.
      ["an unpinned Social Influencer (premium: three days, 5 PM)", unpinned, "2026-10-25T21:00:00.000Z"],
    ];
    for (const [label, p, want] of expect) {
      const rows = rowsOf(board, p.id);
      c.ok(`${label}: on the board`, rows.length === 1, `${rows.length} rows`);
      c.ok(`${label}: not late`, rows.every((r) => !r.late && r.lane !== "late"), rows.map((r) => `${r.lane} ${r.promiseWords}`).join("; "));
      c.ok(`${label}: dated ${want}`, rows.every((r) => r.promiseISO === want), rows.map((r) => r.promiseISO).join(", "));
      const ping = await editDueFor(p.id);
      c.ok(`${label}: the editor's ping reads the same instant`, iso(ping) === want, iso(ping) ?? "null");
    }
    c.ok("nothing on the board is late", board.counts.lateListing === 0, `lateListing=${board.counts.lateListing}`);
    c.ok("the late lane is empty", board.lanes.late.length === 0, board.lanes.late.map((r) => r.street).join(", "));

    c.head("2 · the behind alert's read at that minute");
    const before = await behindReport(NOW);
    const videosLate = before.items.filter((i) => i.kind === "video");
    c.ok("no video is late", videosLate.length === 0, videosLate.map((i) => i.street).join(", "));
    c.ok("the level is ok (no 'very behind' post)", before.state.level === "ok", before.state.level);

    c.head("3 · controls: a really late video is still late, and the office's date still wins");
    const late = await mk({
      street: "7 Really Late Rd", client: "Control Agent", status: "SHOT",
      shoot: new Date("2026-10-20T14:00:00Z"), pin: null,
      items: ["Listing Video"], dels: [{ type: "VIDEO", label: "Listing Video", productTitle: "Listing Video" }],
    });
    const office = await mk({
      street: "8 Office Date Ct", client: "Control Agent", status: "SHOT",
      shoot: new Date("2026-10-22T13:00:00Z"), pin: new Date("2026-10-28T21:00:00Z"), due: new Date("2026-10-23T15:00:00Z"),
      items: ["Zillow Showcase 3D Tour Add-on", "Social Influencer"], dels: influencer(),
    });
    const after = await videoDeliveryBoard({ now: NOW });
    const lr = rowsOf(after, late.id);
    c.ok("a standard video shot Mon Oct 20 10 AM is late (due Wed Oct 22 10 AM)", lr.length === 1 && lr[0].late && lr[0].promiseISO === "2026-10-22T14:00:00.000Z", lr.map((r) => `${r.lane} ${r.promiseISO}`).join("; "));
    const or = rowsOf(after, office.id);
    c.ok("the office's date (Fri Oct 23 11 AM) wins over the Oct 28 pin and reads late", or.length === 1 && or[0].late && or[0].promiseISO === "2026-10-23T15:00:00.000Z", or.map((r) => `${r.lane} ${r.promiseISO}`).join("; "));
    c.ok("the office's date is also the ping's", iso(await editDueFor(office.id)) === "2026-10-23T15:00:00.000Z");
    for (const [label, p] of expect) c.ok(`${label}: still not late beside them`, rowsOf(after, p.id).every((r) => !r.late));
    const report = await behindReport(NOW);
    const streets = report.items.filter((i) => i.kind === "video").map((i) => i.street).sort();
    c.ok("the alert lists exactly the two controls", JSON.stringify(streets) === JSON.stringify(["7 Really Late Rd", "8 Office Date Ct"]), streets.join(", "));
    c.ok("two late, neither 48 h late: 'behind', not 'very behind'", report.state.level === "behind", report.state.level);

    c.head("4 · videoDueOf: a job that owes no video has no date; the aim is words, not the due");
    const photosOnly = videoDueOf({ shootDate: new Date("2026-10-22T13:00:00Z"), dueOverrideAt: null, promisedDueAt: new Date("2026-10-23T13:00:00Z"), deliverables: [{ type: "PHOTOS", label: "Photos" }] });
    c.ok("photos only: no video due (the photos are not the edit's clock)", photosOnly.at === null, iso(photosOnly.at) ?? "null");
    const sla = videoDueOf({ shootDate: new Date("2026-10-22T13:00:00Z"), dueOverrideAt: null, deliverables: [{ type: "VIDEO", label: "Listing Video" }] }, { now: NOW });
    c.ok("aim is 12 hours before the due, and the due is the SLA", iso(sla.at) === "2026-10-24T13:00:00.000Z" && iso(sla.aimAt) === "2026-10-24T01:00:00.000Z" && sla.source === "sla", `${iso(sla.at)} aim ${iso(sla.aimAt)}`);

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

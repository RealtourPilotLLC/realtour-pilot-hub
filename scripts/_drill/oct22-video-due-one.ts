// ---------------------------------------------------------------------------
// DRILL: ONE VIDEO DUE IN EVERY PLACE (Oct 22 2026, audits H2 and L1). The same
// edit showed up to four dates: the ping (the SLA engine), the editor's desk
// (Project.deliveryDue under the office's date or the pin), the edit card (the
// SLA minus a 12-hour buffer, from the shoot date, capped by the pin) and the
// Video Review Room (the order's earliest item). editorDue.videoDueOf now
// feeds all four (and the brief), and the buffer is an "aim" in words.
//   1  850 Springbank Ln (listing, Standard Package, pinned Sat Oct 24 1 PM):
//      ping, desk, edit card and board all say Oct 24 1 PM ET; the card's
//      words carry the aim (Oct 24 1 AM), never as its due
//   2  893 S Matlack St and 13 Lancaster Ave (monthly program jobs, pinned
//      Oct 27 / Oct 28 5 PM under the business-day rule, a stale
//      Project.deliveryDue of Oct 23 / Oct 24): ping, desk and card agree on
//      the pin (the card used to say Oct 23 5 AM / Oct 24 5 AM); the board
//      leaves program videos to the portal, as before
//   3  the office's date still wins in all four; a round sent back keeps it
//   4  L1: the editor's own time survives the bell's 90-character cut
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6992). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1" }), { status: 200, headers: { "content-type": "application/json" } }) : null));
const PORT = Number(process.env.DRILL_PORT ?? 6992);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// Thu Oct 22 2026, 9 PM ET: the evening the audit ran.
const NOW = new Date("2026-10-23T01:00:00Z");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const tasks = await import("@/lib/tasks");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const { videoDeliveryBoard, VIDEO_LANES } = await import("@/lib/videoDelivery");
    const ed = await import("@/lib/editorDue");

    let n = 0;
    type Del = { type: string; label: string; productTitle: string };
    const mk = async (o: { street: string; client: string; status: string; shoot: Date; pin?: Date | null; due?: Date | null; deliveryDue?: Date | null; items: string[]; dels: Del[]; monthId?: string | null }) => {
      const client = (await prisma.client.findFirst({ where: { name: o.client } })) ?? (await prisma.client.create({ data: { name: o.client } }));
      n++;
      const p = await prisma.project.create({
        data: {
          title: `${o.street}, West Chester, PA 19382`, clientId: client.id, status: o.status as never, shootDate: o.shoot,
          promisedDueAt: o.pin ?? null, dueOverrideAt: o.due ?? null, deliveryDue: o.deliveryDue ?? null, contentMonthId: o.monthId ?? null,
          aryeoListingId: `L-h2-${n}`, aryeoOrderId: `O-h2-${n}`,
        },
      });
      await prisma.appointment.create({ data: { projectId: p.id, aryeoId: `A-h2-${n}`, startAt: o.shoot, endAt: new Date(o.shoot.getTime() + 4 * 3_600_000), status: "SCHEDULED" } });
      for (const t of o.items) await prisma.orderItem.create({ data: { projectId: p.id, title: t, amount: 100 } });
      for (const d of o.dels) {
        const row = await prisma.deliverable.create({ data: { projectId: p.id, type: d.type as never, label: d.label, productTitle: d.productTitle, quantity: 1, status: "UPLOADED" as never } });
        if (d.type === "VIDEO" || d.type === "SOCIAL_REEL") await prisma.deliverableOutput.create({ data: { deliverableId: row.id, projectId: p.id, slot: 1, category: "VIDEO" } });
      }
      return { id: p.id, clientId: client.id };
    };
    const program = async (clientId: string) => {
      const e = await prisma.contentEnrollment.create({ data: { clientId, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, callMode: "OPTIONAL_WRITTEN", startedAt: new Date("2026-08-01T12:00:00Z") }, select: { id: true } });
      return (await prisma.contentMonth.create({ data: { enrollmentId: e.id, clientId, monthKey: "2026-10", videosOwed: 4, status: "OPEN" } })).id;
    };

    // ---- the jobs (production rows, Oct 22 2026, read only) ----
    const springbank = await mk({
      street: "850 Springbank Ln", client: "John Collins", status: "SHOT",
      shoot: new Date("2026-10-22T17:00:00Z"), pin: new Date("2026-10-24T17:00:00Z"), deliveryDue: new Date("2026-10-24T17:00:00Z"),
      items: ["Standard Package", "Zillow Showcase 3D Tour Add-on"],
      dels: [
        { type: "PHOTOS", label: "Photos", productTitle: "Standard Package" },
        { type: "VIDEO", label: "Standard Package", productTitle: "Standard Package" },
        { type: "ZILLOW_3D", label: "Zillow 3D Tour", productTitle: "Zillow Showcase 3D Tour Add-on" },
      ],
    });
    const accel: Del[] = [{ type: "VIDEO", label: "Video Accelerator - 4HR Session", productTitle: "Video Accelerator - 4HR Session" }];
    const sutow = await prisma.client.create({ data: { name: "Joseph Sutow" } });
    const matlack = await mk({
      street: "893 S Matlack St Gary Mercer Team Office", client: "Joseph Sutow", status: "REVIEW",
      shoot: new Date("2026-10-13T15:00:00Z"), pin: new Date("2026-10-27T21:00:00Z"), deliveryDue: new Date("2026-10-23T21:00:00Z"),
      items: ["Video Accelerator - 4HR Session"], dels: accel, monthId: await program(sutow.id),
    });
    const collinsId = (await prisma.client.findFirst({ where: { name: "John Collins" } }))!.id;
    const lancaster = await mk({
      street: "13 Lancaster Ave", client: "John Collins", status: "SHOT",
      shoot: new Date("2026-10-14T18:00:00Z"), pin: new Date("2026-10-28T21:00:00Z"), deliveryDue: new Date("2026-10-24T21:00:00Z"),
      items: ["Video Accelerator - 4HR Session"], dels: accel, monthId: await program(collinsId),
    });
    const office = await mk({
      street: "538 Onward Ave", client: "Joseph Sutow", status: "SHOT",
      shoot: new Date("2026-10-21T14:00:00Z"), pin: new Date("2026-10-27T21:00:00Z"), due: new Date("2026-10-24T18:07:00Z"),
      items: ["Standard Video Highlight Reel"], dels: [{ type: "VIDEO", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel" }],
    });

    // The four places, read the way each screen reads them.
    for (const j of [springbank, matlack, lancaster, office]) await tasks.mintEditTask(j.id);
    const queue = await buildEditorQueue();
    const deskRow = (id: string) => [...queue.notDone, ...queue.upcoming, ...queue.done].find((r) => r.id === id);
    const card = (id: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${id}` }, select: { dueAt: true, summary: true } });
    const board = await videoDeliveryBoard({ now: NOW });
    const boardRows = (id: string) => VIDEO_LANES.flatMap((l) => board.lanes[l]).filter((r) => r.projectId === id);
    const four = async (id: string) => ({
      ping: iso(await ed.editDueFor(id)),
      desk: deskRow(id)?.dueISO ?? null,
      card: iso((await card(id))?.dueAt),
      board: boardRows(id).map((r) => r.promiseISO),
    });

    c.head("1 · 850 Springbank Ln: the same instant in all four places");
    const s1 = await four(springbank.id);
    const want1 = "2026-10-24T17:00:00.000Z";
    c.ok("ping: Sat Oct 24 1 PM ET", s1.ping === want1, JSON.stringify(s1));
    c.ok("desk: the same", s1.desk === want1, s1.desk ?? "null");
    c.ok("edit card: the same (it said Oct 24 1 AM, the 12-hour buffer)", s1.card === want1, s1.card ?? "null");
    c.ok("board: the same (it said Fri Oct 23 5 PM, the next-day Zillow tour)", s1.board.length === 1 && s1.board[0] === want1, s1.board.join(", "));
    const sum1 = (await card(springbank.id))?.summary ?? "";
    c.ok("the card's words: the due, then the aim (never a second due)", /Due Sat, Oct 24, 1 PM ET\. Aim to hand it in by Sat, Oct 24, 1 AM ET so review has time\./.test(sum1), sum1.slice(0, 200));
    c.ok("the old 'edit due 12h earlier' wording is gone", !/12h earlier/.test(sum1));

    c.head("2 · 893 S Matlack St and 13 Lancaster Ave: ping, desk and card agree on the promise they were sold under");
    for (const [label, j, want] of [["893 S Matlack St", matlack, "2026-10-27T21:00:00.000Z"], ["13 Lancaster Ave", lancaster, "2026-10-28T21:00:00.000Z"]] as const) {
      const s = await four(j.id);
      c.ok(`${label}: ping ${want}`, s.ping === want, JSON.stringify(s));
      c.ok(`${label}: desk the same (not the stale deliveryDue)`, s.desk === want, s.desk ?? "null");
      c.ok(`${label}: edit card the same (not the calendar-day SLA minus 12 hours)`, s.card === want, s.card ?? "null");
      c.ok(`${label}: not on the board (program videos publish to the portal)`, s.board.length === 0, s.board.join(", "));
    }

    c.head("3 · the office's date still wins everywhere");
    const s3 = await four(office.id);
    const want3 = "2026-10-24T18:07:00.000Z";
    c.ok("ping, desk, card and board all say Sat Oct 24 2:07 PM ET", s3.ping === want3 && s3.desk === want3 && s3.card === want3 && s3.board.length === 1 && s3.board[0] === want3, JSON.stringify(s3));
    const sum3 = (await card(office.id))?.summary ?? "";
    c.ok("the card says it was set by the office, with no aim", /Due Sat, Oct 24, 2:07 PM ET \(set by the office\)\./.test(sum3) && !/Aim to/.test(sum3), sum3.slice(0, 160));
    await tasks.addRoundToEditCard(office.id, { round: 2, notes: ["Trim the intro"], reason: "sent back from the Review Room", by: null });
    c.ok("a round sent back keeps the office's date", iso((await card(office.id))?.dueAt) === want3, iso((await card(office.id))?.dueAt) ?? "null");
    // The desk's override dialog: what the hub says on its own is the pin, not the stale column.
    const row3 = deskRow(office.id);
    c.ok("the override dialog's hub value is the pin (Oct 27 5 PM)", iso(row3?.computed?.dueAt as Date | string | null | undefined) === "2026-10-27T21:00:00.000Z", JSON.stringify(row3?.computed?.dueAt));

    c.head("4 · L1: the editor's own time survives the bell's 90-character cut");
    const due = new Date("2026-10-24T18:07:00Z");
    const t1 = ed.titleWithDue("Ready for editing — 538 Onward Ave", due, "Asia/Manila");
    c.ok("fits in 90", t1.length <= 90, `${t1.length}: ${t1}`);
    c.ok("ends with the editor's own time, whole", /\(Oct 25, 2:07 AM Manila\)$/.test(t1), t1);
    c.ok("the Eastern time is there too", /due Oct 24, 2:07 PM ET/.test(t1), t1);
    const short = ed.titleWithDue("New edit — 850 Springbank Ln", new Date(want1), "Asia/Manila");
    c.ok("a short title keeps the full words with weekdays", short === "New edit — 850 Springbank Ln, due Sat, Oct 24, 1 PM ET (Sun, Oct 25, 1 AM Manila)", short);
    const long = ed.titleWithDue("Task for you — Edit — 1234 Extraordinarily Long Countryside Estate Boulevard Unit 5", due, "Asia/Manila");
    c.ok("a long head is shortened, never the time", long.length <= 90 && /…, due Oct 24, 2:07 PM ET \(Oct 25, 2:07 AM Manila\)$/.test(long), `${long.length}: ${long}`);
    const pingTitle = await ed.editDueTitle("Ready for editing — 538 Onward Ave", office.id, "kim");
    c.ok("the ping's title for Kim (Manila) carries her whole time", pingTitle.length <= 90 && /Manila\)$/.test(pingTitle), `${pingTitle.length}: ${pingTitle}`);
    c.ok("all four ping sites build their title through editDueTitle",
      /editDueTitle\(head, projectId, routedKey\)/.test(read("src/lib/tasks.ts")) &&
      /editDueTitle\(`Reassigned to you — \$\{street\}`, projectId, key\)/.test(read("src/app/editing/actions.ts")) &&
      /editDueTitle\(`New edit — \$\{street\}`, projectId, key\)/.test(read("src/app/editing/actions.ts")) &&
      /editDueTitle\(head, t\.projectId, assignedKey\)/.test(read("src/app/actions.ts")));

    c.head("5 · one function: no second date rule left behind");
    c.ok("the edit card's buffered rule is gone", !/function editDueRule/.test(read("src/lib/tasks.ts")));
    c.ok("the board reads THE video due", /editorDue\.videoDuesFor\(videoJobIds/.test(read("src/lib/videoDelivery.ts")));
    c.ok("the desk reads THE video due", /videoDuesFor\(\[\.\.\.inflight, \.\.\.deliveredRaw\]/.test(read("src/lib/editorQueue.ts")));

    c.head("isolation");
    c.ok("nothing left the hub but the faked Slack", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();

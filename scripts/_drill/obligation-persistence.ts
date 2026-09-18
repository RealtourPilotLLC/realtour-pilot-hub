// AN UNRESOLVED OBLIGATION DOES NOT AGE OUT — against the shipped
// unansweredComms / openObligations / unansweredCommsBoard, in an isolated
// PostgreSQL. Nothing here touches production.
//
// The four acceptance conditions from the R07 review, each run BEFORE and AFTER
// the ledger so the difference is the evidence:
//   1. a request older than OWED_LOOKBACK_DAYS (45)
//   2. a busy account whose question sits under more rows than the scan caps
//   3. an unmatched but legitimate inquiry (a stranger, no client record)
//   4. an automated acknowledgement is not a substantive answer
// …plus the two things that must NOT change: the noise the seven-day window
// exists to keep out stays out, and the SLA pager's scope is untouched.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
const exec = promisify(execFile);

const PORT = 5473;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;

const DAY = 86_400_000;
const NOW = new Date("2026-09-17T15:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  // Import AFTER the URL is pinned, so the client connects to the drill db.
  const { unansweredComms, openObligations } = await import("@/lib/replyQueue");
  const { unansweredCommsBoard } = await import("@/lib/commsBoard");
  const { prisma } = await import("@/lib/prisma");

  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const mkClient = (name: string, phone: string) =>
    prisma.client.create({ data: { name, phone }, select: { id: true, name: true } });

  const inbound = (o: { clientId?: string | null; clientName?: string | null; phone?: string | null; body: string; at: Date; channel?: string; subject?: string | null; contactName?: string | null; source?: string }) =>
    prisma.commLog.create({
      data: {
        channel: o.channel ?? "text",
        direction: "in",
        clientId: o.clientId ?? null,
        clientName: o.clientName ?? null,
        contactName: o.contactName ?? o.clientName ?? null,
        fromPhone: o.phone ?? null,
        subject: o.subject ?? null,
        body: o.body,
        occurredAt: o.at,
        source: o.source ?? "openphone",
      },
    });

  const outbound = (o: { clientId?: string | null; phone?: string | null; body: string; at: Date; source: string }) =>
    prisma.commLog.create({
      data: {
        channel: "text",
        direction: "out",
        clientId: o.clientId ?? null,
        contactName: "Us",
        fromPhone: o.phone ?? null,
        body: o.body,
        occurredAt: o.at,
        source: o.source,
      },
    });

  const replyTask = (o: { clientId: string; clientName: string; message: string; at: Date }) =>
    prisma.smartTask.create({
      data: {
        taskType: "client_reply",
        title: "Reply to the latest message",
        summary: `${o.clientName} wrote in: “${o.message.slice(0, 120)}”`,
        description: o.message,
        source: "openphone",
        priority: "HIGH",
        clientId: o.clientId,
        dedupeKey: `${o.clientId}|noproject|client_reply`,
        createdAt: o.at,
        dueAt: new Date(o.at.getTime() + 4 * 3600_000),
      },
      select: { id: true },
    });

  const find = <T extends { key: string }>(rows: T[], key: string): T | undefined => rows.find((r) => r.key === key);

  // ---------------------------------------------------------------------------
  // The cast
  // ---------------------------------------------------------------------------
  const A = await mkClient("Nadia Osborne", "(215) 555-0101");
  const B = await mkClient("Marisol Greaves", "(215) 555-0202");
  const D = await mkClient("Curtis Ayodele", "(215) 555-0505");
  const E = await mkClient("Natalie Curry", "(215) 555-0606");
  const LEAD_PHONE = "2155550303";
  const LIVE_LEAD_PHONE = "2155550404";

  const A_ASK = "Can we move Thursday's shoot to Friday morning? I need to tell the seller today.";
  const B_ASK = "Are the twilight photos included in the package we booked, or is that an add-on?";
  const LEAD_ASK = "Hi — I'm listing 44 Chestnut Grove next month and need photos plus a walkthrough video. Do you shoot Tuesdays?";

  // 1. Sixty days old, unanswered, with an open reply to-do.
  await inbound({ clientId: A.id, clientName: A.name, phone: "2155550101", body: A_ASK, at: ago(60) });
  const aTask = await replyTask({ clientId: A.id, clientName: A.name, message: A_ASK, at: ago(60) });

  // 2. Twenty days old — inside the 45-day lookback, but buried under 620 newer
  //    tapbacks, which is more than OWED_SCAN_CAP (600) will fetch.
  await inbound({ clientId: B.id, clientName: B.name, phone: "2155550202", body: B_ASK, at: ago(20) });
  const bTask = await replyTask({ clientId: B.id, clientName: B.name, message: B_ASK, at: ago(20) });
  await prisma.commLog.createMany({
    data: Array.from({ length: 620 }, (_, i) => ({
      channel: "text",
      direction: "in",
      clientId: B.id,
      clientName: B.name,
      contactName: B.name,
      fromPhone: "2155550202",
      body: `Loved “a photo”`,
      occurredAt: new Date(ago(19).getTime() + i * 60_000),
      source: "openphone",
    })),
  });

  // 3. A stranger with a real inquiry, and the lead to-do the receiver files.
  await inbound({ phone: LEAD_PHONE, contactName: "Priya Raman", body: LEAD_ASK, at: ago(60) });
  const leadTask = await prisma.smartTask.create({
    data: {
      taskType: "lead",
      title: "New texter — reply to Priya Raman (215) 555-0303",
      summary: `Priya Raman texted us — not a client we recognize, so treat it as a lead. They said: “${LEAD_ASK}”`,
      description: LEAD_ASK,
      source: "openphone",
      priority: "HIGH",
      dedupeKey: `lead-${LEAD_PHONE}`,
    },
    select: { id: true },
  });

  // 3b. A stranger who wrote in TWO DAYS ago — inside the window, so the walk
  //     already produces the row. What was missing was the to-do behind it.
  await inbound({ phone: LIVE_LEAD_PHONE, contactName: "Owen Brathwaite", body: "Do you do drone? Need it for a farm listing on Route 9.", at: ago(2) });
  const liveLead = await prisma.smartTask.create({
    data: {
      taskType: "lead",
      title: "New texter — reply to Owen Brathwaite (215) 555-0404",
      summary: "Owen Brathwaite texted us — not a client we recognize, so treat it as a lead.",
      source: "openphone",
      priority: "HIGH",
      dedupeKey: `lead-${LIVE_LEAD_PHONE}`,
    },
    select: { id: true },
  });

  // 3c. THE SHAPE FOUND ON LIVE DATA (2026-09-18). The receiver logs an
  //     unmatched inbound CALL with the number only in `contactName` and
  //     `fromPhone` NULL, so the thread keyed on the LABEL: unreplyable, and
  //     impossible to join to the OPEN lead to-do the same webhook had filed.
  const CALL_PHONE = "2679008794";
  await prisma.commLog.create({
    data: {
      channel: "call", direction: "in", clientId: null, fromPhone: null,
      contactName: "(267) 900-8794",
      body: "Inbound missed call from (267) 900-8794 — no matching client.",
      occurredAt: ago(60), source: "openphone",
    },
  });
  await prisma.commLog.create({
    data: {
      channel: "call", direction: "in", clientId: null, fromPhone: null,
      contactName: "(267) 900-8794",
      body: "Inbound missed call from (267) 900-8794 — no matching client.",
      occurredAt: ago(3), source: "openphone",
    },
  });
  const callLead = await prisma.smartTask.create({
    data: {
      taskType: "lead",
      title: "New caller — call back (267) 900-8794",
      summary: "(267) 900-8794 called us (missed) — not a client we recognize, so treat it as a lead.",
      source: "openphone", priority: "HIGH", dedupeKey: `lead-${CALL_PHONE}`,
    },
    select: { id: true },
  });

  // 3d. The same shape with NOTHING recent: only a 60-day-old label-keyed
  //     missed call. The ledger has to find it by the number in `contactName`
  //     too, or the obligation has no message and is dropped.
  const OLD_CALL_PHONE = "2679007777";
  await prisma.commLog.create({
    data: {
      channel: "call", direction: "in", clientId: null, fromPhone: null,
      contactName: "(267) 900-7777",
      body: "Inbound missed call from (267) 900-7777 — no matching client.",
      occurredAt: ago(70), source: "openphone",
    },
  });
  const oldCallLead = await prisma.smartTask.create({
    data: {
      taskType: "lead",
      title: "New caller — call back (267) 900-7777",
      summary: "(267) 900-7777 called us (missed) — not a client we recognize, so treat it as a lead.",
      source: "openphone", priority: "HIGH", dedupeKey: `lead-${OLD_CALL_PHONE}`,
    },
    select: { id: true },
  });

  // 4b. Same 60-day shape as A, but a HUMAN answered afterwards and the task was
  //     simply never closed. That is a stale task, not an unanswered client.
  await inbound({ clientId: D.id, clientName: D.name, phone: "2155550505", body: "Any chance of a re-shoot on the kitchen?", at: ago(60) });
  await replyTask({ clientId: D.id, clientName: D.name, message: "Any chance of a re-shoot on the kitchen?", at: ago(60) });
  await outbound({ clientId: D.id, phone: "2155550505", body: "Yes — Kyle can do Tuesday at 10. Booked you in.", at: ago(59), source: "openphone" });

  // 4c. Asked, answered, and thanked — with the to-do never closed. The
  //     thank-you is newer than our reply, so keying the ledger on "the newest
  //     inbound" would hold this settled conversation open forever.
  const F = await mkClient("Gwen Achebe", "(215) 555-0707");
  await inbound({ clientId: F.id, clientName: F.name, phone: "2155550707", body: "Can you send the floor plan as a PDF too?", at: ago(30) });
  await replyTask({ clientId: F.id, clientName: F.name, message: "Can you send the floor plan as a PDF too?", at: ago(30) });
  await outbound({ clientId: F.id, phone: "2155550707", body: "Sent — it's in the gallery under Floor Plans.", at: ago(29), source: "openphone" });
  await inbound({ clientId: F.id, clientName: F.name, phone: "2155550707", body: "Thanks so much!!", at: ago(28) });

  // 6. The noise the seven-day window exists to keep out: an out-of-office
  //    auto-reply three weeks old, with no to-do behind it. Nobody chose it.
  await inbound({
    clientId: E.id, clientName: E.name, channel: "email", source: "gmail",
    subject: "Automatic reply: Your listing content is ready!",
    body: "I am out of the office until the 29th with limited access to email.",
    at: ago(21),
  });

  // ---------------------------------------------------------------------------
  console.log("\n1. AN UNANSWERED REQUEST OLDER THAN THE 45-DAY LOOKBACK");
  const before1 = await unansweredComms({ now: NOW });
  check("BEFORE (window only): the 60-day-old request is gone", !find(before1, `c:${A.id}`), `${before1.length} thread(s): [${before1.map((t) => t.key).join(", ")}]`);
  const after1 = await unansweredComms({ now: NOW, includeOwed: true });
  const a1 = find(after1, `c:${A.id}`);
  check("AFTER (ledger): it is back, and actionable", !!a1);
  check("  …carrying the message that raised it", a1?.pending[0]?.body === A_ASK, JSON.stringify(a1?.pending[0]?.body?.slice(0, 60)));
  check("  …and the to-do it belongs to", a1?.openTaskId === aTask.id, `openTaskId=${a1?.openTaskId}`);
  check("  …flagged as a ledger row (no scrollback to show)", a1?.fromLedger === true);
  check("  …with the TRUE wait, not the task's age", a1?.hoursWaiting === 1440, `hoursWaiting=${a1?.hoursWaiting}`);
  const board1 = await unansweredCommsBoard("phone", NOW);
  check("  …and it is on the Comms board Kyle works", board1.some((g) => g.clientId === A.id), `board: [${board1.map((g) => g.clientName).join(", ")}]`);

  console.log("\n2. A BUSY ACCOUNT WHOSE QUESTION IS BURIED UNDER THE SCAN CAP");
  check("BEFORE (window only): 620 newer rows hid the question", !find(before1, `c:${B.id}`));
  const b1 = find(after1, `c:${B.id}`);
  check("AFTER (ledger): the question is back", !!b1);
  check("  …and it is the QUESTION, not the tapbacks on top of it", b1?.pending[0]?.body === B_ASK, JSON.stringify(b1?.pending[0]?.body?.slice(0, 60)));
  check("  …with the to-do behind it", b1?.openTaskId === bTask.id);

  console.log("\n3. AN UNMATCHED BUT LEGITIMATE INQUIRY");
  check("BEFORE (window only): the stranger's 60-day-old text is gone", !find(before1, `p:${LEAD_PHONE}`));
  const l1 = find(after1, `p:${LEAD_PHONE}`);
  check("AFTER (ledger): still actionable", !!l1);
  check("  …routed to the lead to-do the receiver already filed", l1?.openTaskId === leadTask.id, `openTaskId=${l1?.openTaskId}`);
  check("  …and it is NOT claimed as a client", l1?.isClient === false && l1?.clientId === null);
  const live = find(before1, `p:${LIVE_LEAD_PHONE}`);
  check("a LIVE unmatched row now carries its lead to-do too", live?.openTaskId === liveLead.id, `openTaskId=${live?.openTaskId ?? "null"}`);

  const call = find(before1, `p:${CALL_PHONE}`);
  check("a missed call logged with the number in the LABEL keys on the number", !!call, `key=${call?.key ?? "(none)"}`);
  check("  …so it can be called back at all", call?.phone === CALL_PHONE, `phone=${call?.phone ?? "null"}`);
  check("  …and it reaches its lead to-do", call?.openTaskId === callLead.id, `openTaskId=${call?.openTaskId ?? "null"}`);

  check("BEFORE: a 70-day-old label-keyed missed call is gone", !find(before1, `p:${OLD_CALL_PHONE}`));
  const oldCall = find(after1, `p:${OLD_CALL_PHONE}`);
  check("AFTER: the ledger finds it by the number in the LABEL column", !!oldCall, `key=${oldCall?.key ?? "(none)"}`);
  check("  …with its lead to-do and a callable number", oldCall?.openTaskId === oldCallLead.id && oldCall?.phone === OLD_CALL_PHONE, `task=${oldCall?.openTaskId ?? "null"} phone=${oldCall?.phone ?? "null"}`);

  console.log("\n4. AN AUTOMATED ACKNOWLEDGEMENT IS NOT A SUBSTANTIVE ANSWER");
  check("a client a HUMAN answered is not resurrected (stale task, not a waiting client)", !find(after1, `c:${D.id}`));
  await outbound({ clientId: A.id, phone: "2155550101", body: "Thanks for reaching out! We're closed right now and will reply first thing.", at: ago(59), source: "auto-afterhours" });
  await outbound({ clientId: A.id, phone: "2155550101", body: "⚙️ RealTour Hub: nightly upload digest", at: ago(58), source: "upload-digest" });
  const after4 = await unansweredComms({ now: NOW, includeOwed: true });
  check("our robot's after-hours reply did not close the obligation", !!find(after4, `c:${A.id}`));
  const obl4 = await openObligations({ now: NOW });
  check("the ledger still lists it, beyond the window, with a follow-up date field", obl4.some((o) => o.clientId === A.id && o.beyondWindow), obl4.filter((o) => o.clientId === A.id).map((o) => `${o.daysWaiting}d beyondWindow=${o.beyondWindow}`).join(""));

  check("a thank-you AFTER our answer does not hold a settled thread open", !find(after4, `c:${F.id}`));

  console.log("\n5. THE SEVEN-DAY WINDOW STILL KEEPS THE NOISE OUT");
  const email1 = await unansweredComms({ now: NOW, families: ["email"], includeOwed: true });
  check("a 21-day-old out-of-office with no to-do behind it stays off the board", !email1.some((t) => t.clientId === E.id), `${email1.length} email thread(s)`);

  console.log("\n6. THE 5-MINUTE SLA PAGER'S SCOPE IS UNCHANGED");
  // The exact call shape commsSla.sweepReplySla makes — no includeOwed.
  const pager = await unansweredComms({ now: NOW, families: ["phone"], windowDays: 7, includeUnmatched: false, includeTeam: false });
  check("nothing months old reaches the pager", !pager.some((t) => [`c:${A.id}`, `c:${B.id}`, `p:${LEAD_PHONE}`].includes(t.key)), `pager: [${pager.map((t) => t.key).join(", ")}]`);

  console.log("\n7. THE BOUNDED LEDGER SCAN COSTS DETAIL, NEVER THE OBLIGATION");
  // 2,100 fresh noise rows on a third number push A and B out of the ledger's
  // 2,000-row message read entirely.
  await prisma.commLog.createMany({
    data: Array.from({ length: 2100 }, (_, i) => ({
      channel: "text",
      direction: "in",
      clientId: null,
      contactName: "Loud Number",
      fromPhone: "2155559999",
      body: `Loved “a photo”`,
      occurredAt: new Date(ago(5).getTime() + i * 60_000),
      source: "openphone",
    })),
  });
  const after7 = await unansweredComms({ now: NOW, includeOwed: true });
  const a7 = find(after7, `c:${A.id}`);
  check("the obligation survives a scan that cannot reach its message", !!a7);
  check("  …falling back to the copy the to-do itself carries", a7?.pending[0]?.body === A_ASK, JSON.stringify(a7?.pending[0]?.body?.slice(0, 60)));
  check("  …with the age still exact (the groupBy, not the scan)", a7?.hoursWaiting === 1440, `hoursWaiting=${a7?.hoursWaiting}`);

  console.log("\n8. IT ENDS ONLY WHEN SOMEBODY RESOLVES IT");
  await prisma.smartTask.update({ where: { id: aTask.id }, data: { status: "COMPLETED", completedAt: NOW } });
  const after8 = await unansweredComms({ now: NOW, includeOwed: true });
  check("completing the to-do clears the row", !find(after8, `c:${A.id}`));
  const { threadAckKey, ackValue } = await import("@/lib/replyQueue");
  await prisma.appSetting.create({ data: { key: threadAckKey("phone", `p:${LEAD_PHONE}`), value: ackValue(NOW, "answered elsewhere") } });
  const after8b = await unansweredComms({ now: NOW, includeOwed: true });
  check("ticking the stranger's thread handled clears it", !find(after8b, `p:${LEAD_PHONE}`));
  check("but the to-do's own record is untouched — retired, not deleted", (await prisma.smartTask.findUnique({ where: { id: leadTask.id }, select: { status: true } }))?.status === "OPEN");
  const muted = await unansweredComms({ now: NOW, includeOwed: true });
  check("and B, which nobody resolved, is still there", !!find(muted, `c:${B.id}`));

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} FAILED`} (${pass} passed)`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

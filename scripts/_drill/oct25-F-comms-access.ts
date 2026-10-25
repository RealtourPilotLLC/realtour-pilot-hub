// ---------------------------------------------------------------------------
// DRILL oct25-F-comms-access: THE OCT 25 AUDIT, AREA F (comms, clients, access).
//
//   DRILL_PORT=6400 node scripts/_drill/run-all.cjs scripts/_drill/oct25-F-comms-access.ts
//
//   §1 an internal note is not our answer: a forward to Kyle, or a reply only
//      to teammates, in a client's Gmail thread (lib/mailMatch isInternalNote,
//      read by integrations/google threadTail + lastFromUs)
//   §2 a numbered address beats a bare street that is also a town: "Re: 1316
//      Blair" over 1244 West Chester Pike named by a signature's "West Chester
//      PA"; the first numbered address wins; the team office's "893 S.
//      Matlack" is not loosened (lib/contacts streetMatchScore)
//   §3 a job-less scheduling ask closes when the address it names is booked
//      after it (lib/clientAsks bookedJobFor + closeBookedSchedulingAsks)
//   §4 the hourly OpenPhone backstop reads the number that asked and only a
//      reply after the question (integrations/openphone sweepRepliedOpenPhoneTasks)
//   §5 Ask the Hub's task tools act for the office only; a creative lead
//      completes only their own tasks there (lib/hubTools)
// ISOLATION: PGlite via the shared harness; OpenPhone answered by a fake at
// the fence; nothing else leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const OP_LINE = "+12156454889";
const opMessages = new Map<string, { id: string; direction: string; text: string; createdAt: string }[]>();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => {
  const u = new URL(url);
  if (!/openphone|quo/i.test(u.hostname)) return null;
  if (u.pathname === "/v1/phone-numbers") return json({ data: [{ id: "PN-DRILL", number: OP_LINE }] });
  if (u.pathname === "/v1/messages") return json({ data: opMessages.get(u.searchParams.get("participants") ?? "") ?? [] });
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6400), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-F" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const HOUR = 3_600_000;
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * HOUR);

    c.head("§1 · our internal note in a client's thread is not our answer");
    const { isInternalNote } = await import("@/lib/mailMatch");
    const D = "realtourpilot.com";
    c.ok("Jordan forwarding the client's mail to Kyle is a note", isInternalNote({ from: "Jordan Spackman <info@realtourpilot.com>", to: "hello@realtourpilot.com", subject: "Fwd: Tomorrow Session" }, D));
    c.ok("a forward to anyone (an editor, a vendor) is a note too", isInternalNote({ from: "info@realtourpilot.com", to: "edits@vendor.example", subject: "FW: 2236 Gregory" }, D));
    c.ok("a reply only to teammates is a note", isInternalNote({ from: "info@realtourpilot.com", to: "hello@realtourpilot.com, kyle@realtourpilot.com", subject: "Re: 2236 Gregory" }, D));
    c.ok("our reply to the client is an answer", !isInternalNote({ from: "Kyle <hello@realtourpilot.com>", to: "Mike <mike@kw.example>", cc: "info@realtourpilot.com", subject: "Re: Tomorrow Session" }, D));
    c.ok("the client's own mail is never our note", !isInternalNote({ from: "Mike <mike@kw.example>", to: "hello@realtourpilot.com", subject: "Fwd: listing" }, D));

    c.head("§2 · a numbered address beats a bare street that is also a town");
    const { streetMatchScore } = await import("@/lib/contacts");
    const marcee = { title: "1244 West Chester Pike, West Chester, PA 19382", addressLine: "1244 West Chester Pike" };
    const blair = { title: "1316 Blair Cir, Downingtown, PA 19335", addressLine: "1316 Blair Cir" };
    const office = { title: "893 S Matlack St Gary Mercer Team Office, West Chester, PA 19382", addressLine: "893 S Matlack St" };
    const kim = "re: 1316 blair updates/showcase thank you so much! kimberly mazzenga director of operations, gary mercer team 893 s. matlack st suite 200 west chester pa 19382";
    c.ok("Kimberly's '1316 Blair' (subject) beats the signature's 'West Chester'", streetMatchScore(blair, kim) > streetMatchScore(marcee, kim), `${streetMatchScore(blair, kim)} vs ${streetMatchScore(marcee, kim)}`);
    c.ok("the bare town still counts as a bare street (unchanged when nothing better is named)", streetMatchScore(marcee, "photos for west chester please") === "west chester".length);
    c.ok("'893 S. Matlack' in a signature is not the office job (the rule is not loosened)", streetMatchScore(office, kim) === 0);
    const two = "about 204 spring ln (not 115 spring ln)";
    const s204 = { title: "204 Spring Ln, Royersford, PA 19468", addressLine: "204 Spring Ln" };
    const s115 = { title: "115 Spring Ln, West Chester, PA 19382", addressLine: "115 Spring Ln" };
    c.ok("two jobs on one street: the house number named first wins", streetMatchScore(s204, two) > streetMatchScore(s115, two) && streetMatchScore(s115, two) > 1000);
    c.ok("no mention scores 0", streetMatchScore(blair, "hello there") === 0);

    c.head("§3 · a job-less scheduling ask closes on the booking it named");
    const { bookedJobFor, closeBookedSchedulingAsks } = await import("@/lib/clientAsks");
    const { jobAddressKey } = await import("@/lib/teamRouting");
    const ask = { text: "Hi Jordan, Can we schedule a photo shoot for Tuesday, 2pm? Full Zillow spotlight. 265 Mill Road Lehighton, PA 18235", askedAt: ago(48) };
    const mill = { id: "j1", title: "265 Mill Rd, Lehighton, PA 18235", addressLine: "265 Mill Rd", createdAt: ago(44), status: "BOOKED" };
    c.ok("booked 4 hours later under another record: it's the booking", bookedJobFor(ask, [mill], jobAddressKey)?.id === "j1");
    c.ok("a job that existed before the ask is not its booking", bookedJobFor(ask, [{ ...mill, createdAt: ago(60) }], jobAddressKey) === null);
    c.ok("a cancelled job is not a booking", bookedJobFor(ask, [{ ...mill, status: "CANCELLED" }], jobAddressKey) === null);
    c.ok("'3828 Percy st' is 3828 N Percy St", bookedJobFor({ text: "3828 Percy st Philadelphia pa ready 10/28", askedAt: ago(48) }, [{ id: "j2", title: "3828 N Percy St, Philadelphia, PA 19140", addressLine: "3828 N Percy St", createdAt: ago(40), status: "BOOKED" }], jobAddressKey)?.id === "j2");
    c.ok("an ask naming no address never closes on a booking", bookedJobFor({ text: "Can we schedule ahead of time for Nov.", askedAt: ago(48) }, [mill], jobAddressKey) === null);

    const hala = await prisma.client.create({ data: { name: "Hala Drill", phone: "(610) 555-0708" }, select: { id: true } });
    const tim = await prisma.client.create({ data: { name: "Tim Drill", phone: "(610) 555-1197" }, select: { id: true } });
    const askRow = await prisma.clientAsk.create({ data: { clientId: hala.id, kind: "SCHEDULING", text: ask.text, source: "text", askedAt: ago(48), dedupeKey: "drill-sched-1" }, select: { id: true } });
    const nov = await prisma.clientAsk.create({ data: { clientId: hala.id, kind: "SCHEDULING", text: "Can we schedule ahead of time for Nov.", source: "email", askedAt: ago(48), dedupeKey: "drill-sched-2" }, select: { id: true } });
    const job = await prisma.project.create({ data: { title: "265 Mill Rd, Lehighton, PA 18235", addressLine: "265 Mill Rd", clientId: tim.id, status: "BOOKED", createdAt: ago(44) }, select: { id: true } });
    const run1 = await closeBookedSchedulingAsks(now);
    const after1 = await prisma.clientAsk.findUnique({ where: { id: askRow.id }, select: { state: true, projectId: true, doneBy: true, confirmNote: true } });
    c.ok("the sweep closes it DONE, by the Hub, filed on the booked job", run1.closed === 1 && after1?.state === "DONE" && after1.projectId === job.id && after1.doneBy === "Hub", JSON.stringify(after1));
    c.ok("…and says why in words", /booked in Aryeo: 265 Mill Rd/.test(after1?.confirmNote ?? ""));
    c.ok("the ask that names no address stays open", (await prisma.clientAsk.findUnique({ where: { id: nov.id }, select: { state: true } }))?.state === "OPEN");
    c.ok("a second sweep changes nothing", (await closeBookedSchedulingAsks(now)).closed === 0);
    c.ok("the job's timeline says it", (await prisma.activity.count({ where: { projectId: job.id, body: { contains: "scheduling ask closed" } } })) === 1);

    c.head("§4 · the hourly backstop: the number that asked, and only a reply after");
    const { sweepRepliedOpenPhoneTasks } = await import("@/lib/integrations/openphone");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("openphone", ["op", "drill", "key"].join("-"));
    const ASKED = ago(2);
    // Tim texts for Hala's account from his own phone; the record's number is Hala's.
    await prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: hala.id, clientName: "Hala Drill", contactName: "Tim Drill", fromPhone: "6105551197", body: "Can we schedule a shoot for Tuesday?", occurredAt: ASKED, source: "openphone", externalId: "op-DRILL-IN-1" } });
    const task = await prisma.smartTask.create({ data: { title: "Schedule the shoot", taskType: "client_reply", status: "OPEN", source: "openphone", clientId: hala.id, assignedKey: "kyle", createdAt: new Date(ASKED.getTime() + 2000) }, select: { id: true } });
    // Hala's own thread: our last word to her was days ago (a person's text, on record).
    const OLD = ago(72);
    await prisma.commLog.create({ data: { channel: "text", direction: "out", clientId: hala.id, contactName: "Us", fromPhone: "6105550708", body: "See you Thursday!", occurredAt: OLD, source: "openphone", externalId: "op-DRILL-OUT-OLD" } });
    opMessages.set("+16105550708", [{ id: "DRILL-OUT-OLD", direction: "outgoing", text: "See you Thursday!", createdAt: OLD.toISOString() }]);
    opMessages.set("+16105551197", [{ id: "DRILL-IN-1", direction: "incoming", text: "Can we schedule a shoot for Tuesday?", createdAt: ASKED.toISOString() }]);
    await sweepRepliedOpenPhoneTasks();
    const st = async () => (await prisma.smartTask.findUnique({ where: { id: task.id }, select: { status: true } }))?.status;
    c.ok("Tim's question stays open: the old text to Hala's number answered nothing (Oct 23: closed in 49 minutes)", (await st()) === "OPEN");
    // Kyle answers Tim on Tim's number: the backstop closes it.
    const REPLY = ago(1);
    await prisma.commLog.create({ data: { channel: "text", direction: "out", clientId: hala.id, contactName: "Us", fromPhone: "6105551197", body: "Tuesday at 2 works!", occurredAt: REPLY, source: "openphone", externalId: "op-DRILL-OUT-1" } });
    opMessages.set("+16105551197", [
      { id: "DRILL-OUT-1", direction: "outgoing", text: "Tuesday at 2 works!", createdAt: REPLY.toISOString() },
      { id: "DRILL-IN-1", direction: "incoming", text: "Can we schedule a shoot for Tuesday?", createdAt: ASKED.toISOString() },
    ]);
    await sweepRepliedOpenPhoneTasks();
    c.ok("a person's reply on the asking number, after the question, closes it", (await st()) === "COMPLETED");

    c.head("§5 · Ask the Hub's task tools are the office's");
    const { execHubTool } = await import("@/lib/hubTools");
    const kyleTask = await prisma.smartTask.create({ data: { title: "Call Logan back about the Zillow showcase", taskType: "client_reply", status: "OPEN", source: "openphone", assignedKey: "kyle" }, select: { id: true } });
    const jamesTask = await prisma.smartTask.create({ data: { title: "Review the Wassergass creative brief", taskType: "todo", status: "OPEN", source: "manual", assignedKey: "james" }, select: { id: true } });
    const lead = { role: "ADMIN", who: "James Livingston", office: false, ownKeys: ["james"] };
    const r1 = await execHubTool("complete_task", { task: "Logan Zillow showcase" }, lead) as { error?: string; done?: boolean };
    c.ok("the creative lead cannot complete Kyle's client reply from chat", !r1.done && (await prisma.smartTask.findUnique({ where: { id: kyleTask.id }, select: { status: true } }))?.status === "OPEN", JSON.stringify(r1));
    const r2 = await execHubTool("complete_task", { task: "Wassergass creative brief" }, lead) as { done?: boolean };
    c.ok("…and can complete their own", !!r2.done && (await prisma.smartTask.findUnique({ where: { id: jamesTask.id }, select: { status: true } }))?.status === "COMPLETED");
    const r3 = await execHubTool("assign_task", { task: "Logan Zillow showcase", person: "james" }, lead) as { error?: string };
    c.ok("…cannot reassign anything from chat", !!r3.error && /office/i.test(r3.error));
    const r4 = await execHubTool("send_drafted_texts", { confirm: true }, lead) as { error?: string };
    c.ok("…and has no Outbox in chat", !!r4.error);
    const r5 = await execHubTool("complete_task", { task: "Logan Zillow showcase" }, { role: "ADMIN", who: "Kyle Smith", office: true }) as { done?: boolean };
    c.ok("the office still completes any task from chat", !!r5.done);
    const r6 = await execHubTool("complete_task", { task: "Logan Zillow showcase", reopen: true }, { role: "ADMIN", who: "Kyle" }) as { done?: boolean };
    c.ok("a caller that passes no office flag keeps the old tier rule", !!r6.done);

    c.ok("nothing left the machine but the fake OpenPhone", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

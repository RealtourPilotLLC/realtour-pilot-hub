// ANSWERING ABOUT ONE PROPERTY DOES NOT ERASE THE QUESTION ABOUT ANOTHER (F10)
// — against the shipped openObligations / unansweredComms / unansweredCommsBoard
// and the real markCommsHandled server action, in an isolated PostgreSQL.
// Nothing here touches production.
//
// The shape it reproduces is Renee Ryan's, Sep 18 2026: one client, one phone
// conversation, two live orders, two open reply requests. We answered about one
// of them, and the other question left the Replies tab, the Comms board, the
// Dashboard chip and the ledger — it survived only as a bare title on the Open
// Loops card, on a screen Kyle does not work replies from.
//
// What must be true after the fix:
//   1. the CONVERSATION still clears on our reply (one card per contact, which
//      is right for a phone thread and is not what was broken);
//   2. the REQUEST we did not answer stays owed, comes back as its own row,
//      and that row names its own property and carries its own words;
//   3. the request we DID answer, on its own order, goes;
//   4. two rows for one client never share a key;
//   5. a client with ONE open request behaves exactly as before — no new
//      "still waiting" rows invented out of a street-less reply;
//   6. the Handled tick resolves the request it is pointed at and leaves the
//      other standing, instead of completing every request on the record;
//   7. OpenPhone's own missed-call greeting is not us answering;
//   8. the SLA pager's scope is untouched (it never reads the ledger).
//
// And four the Sep 20 review put here, each of which was a real hole:
//   9. the row comes back BESIDE a live card, not only for a client who has
//      gone silent — the case the first pass never tested and never handled
//      (§6a). For Stephen Kennedy, answered a dozen times a day, that was the
//      difference between a fix and no fix at all;
//  10. a reply that came back inside the hour answered the question, whatever
//      order the router filed it against — otherwise the only row this change
//      added in production was an aerial credit applied 71 seconds after it was
//      asked for (§5a);
//  11. a tick on one property's row does not silence the conversation, and a
//      tick on a row somebody else already closed closes nothing at all (§6c);
//  12. two requests that resolve to the same conversation key are two rows, not
//      one row and a silently dropped obligation (§5b).
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
// The server action drags Next's request-scoped modules in at load; nothing
// under test touches them, so they are stubbed in front of the import (same
// harness trick as scripts/_drill/obligation-persistence.ts).
import Module from "module";
const __M = Module as unknown as { prototype: { require: (id: string) => unknown } };
const __realRequire = __M.prototype.require;
__M.prototype.require = function (this: unknown, id: string) {
  if (id === "next/navigation" || id === "next/headers") return {};
  if (id === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  return __realRequire.call(this, id);
} as never;
const exec = promisify(execFile);

const PORT = 5479;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
// The guards are no-ops in local dev and fail closed in prod; this drill is
// local dev, and must stay local dev even if the shell sourced .env.
process.env.AUTH_ENFORCE = "false";
delete process.env.VERCEL;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-20T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const CHURCH = "358 N Church St, West Chester, PA 19380";
const CARDIGAN = "453 Cardigan Terrace, West Chester, PA 19380";
const CHURCH_ASK = "Any word from the editor on when the Church St video will be ready?";
const CARDIGAN_ASK = "We skipped the aerials at Cardigan because of the rain. Can that be credited?";

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  // Import AFTER the URL is pinned, so the client connects to the drill db.
  const { unansweredComms, openObligations, requestsOffThread } = await import("@/lib/replyQueue");
  const { unansweredCommsBoard } = await import("@/lib/commsBoard");
  const { findUnansweredInbound } = await import("@/lib/commsSla");
  const { markCommsHandled } = await import("@/app/actions");
  const { closeReplyForOutbound } = await import("@/lib/tasks");
  const { prisma } = await import("@/lib/prisma");

  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const mkClient = (name: string, phone: string) =>
    prisma.client.create({ data: { name, phone }, select: { id: true, name: true } });
  const mkProject = (title: string, clientId: string) =>
    prisma.project.create({ data: { title, clientId, addressLine: title.split(",")[0] }, select: { id: true } });

  const inbound = (o: { clientId: string; clientName: string; phone: string; projectId?: string | null; body: string; at: Date }) =>
    prisma.commLog.create({
      data: {
        channel: "text", direction: "in", clientId: o.clientId, clientName: o.clientName,
        contactName: o.clientName, fromPhone: o.phone, projectId: o.projectId ?? null,
        body: o.body, occurredAt: o.at, source: "openphone",
      },
    });

  const outbound = (o: { clientId: string; phone: string; projectId?: string | null; body: string; at: Date; source?: string }) =>
    prisma.commLog.create({
      data: {
        channel: "text", direction: "out", clientId: o.clientId, contactName: "Us",
        fromPhone: o.phone, projectId: o.projectId ?? null, body: o.body,
        occurredAt: o.at, source: o.source ?? "openphone",
      },
    });

  const request = (o: { clientId: string; projectId?: string | null; address?: string | null; title: string; message: string; at: Date; source?: string; dedupe?: string }) =>
    prisma.smartTask.create({
      data: {
        taskType: "client_reply", title: o.title, summary: o.message, description: o.message,
        source: o.source ?? "openphone", priority: "HIGH", clientId: o.clientId,
        projectId: o.projectId ?? null, propertyAddress: o.address ?? null,
        dedupeKey: o.dedupe ?? `${o.clientId}|${o.projectId ?? "noproject"}|client_reply`,
        createdAt: o.at, dueAt: new Date(o.at.getTime() + 4 * HOUR),
      },
      select: { id: true },
    });

  // ---------------------------------------------------------------------------
  // The cast
  // ---------------------------------------------------------------------------
  const R = await mkClient("Renee Ryan", "(610) 555-0144");
  const R_PHONE = "6105550144";
  const church = await mkProject(CHURCH, R.id);
  const cardigan = await mkProject(CARDIGAN, R.id);

  // Two asks, two days apart, on two properties.
  await inbound({ clientId: R.id, clientName: R.name, phone: R_PHONE, projectId: church.id, body: CHURCH_ASK, at: ago(3 * DAY) });
  const churchTask = await request({ clientId: R.id, projectId: church.id, address: CHURCH, title: "Check with editor on Church St ETA and update Renee", message: CHURCH_ASK, at: ago(3 * DAY) });
  await inbound({ clientId: R.id, clientName: R.name, phone: R_PHONE, projectId: cardigan.id, body: CARDIGAN_ASK, at: ago(2 * DAY) });
  const cardiganTask = await request({ clientId: R.id, projectId: cardigan.id, address: CARDIGAN, title: "Apply credit for skipped aerial shots at Cardigan", message: CARDIGAN_ASK, at: ago(2 * DAY) });

  // ONE reply, about Church St only, filed against Church St — sent through the
  // real close path the webhook and the Replies tab both use, so the task layer
  // gets its say exactly as it does in production.
  const CHURCH_REPLY = "The editor has 358 N Church St back to us tomorrow morning, I'll send it over the second it lands.";
  await outbound({ clientId: R.id, phone: R_PHONE, projectId: church.id, body: CHURCH_REPLY, at: ago(1 * DAY) });
  await closeReplyForOutbound(R.id, CHURCH_REPLY);

  // A second client with ONE open request and a street-less reply — the shape
  // that must NOT change (85% of our texts name no property).
  const S = await mkClient("Stephen Kennedy", "(215) 555-0190");
  const S_PHONE = "2155550190";
  const etting = await mkProject("1631 S Etting St", S.id);
  await inbound({ clientId: S.id, clientName: S.name, phone: S_PHONE, projectId: etting.id, body: "Can we push the Etting shoot to Thursday?", at: ago(2 * DAY) });
  await request({ clientId: S.id, projectId: etting.id, address: "1631 S Etting St", title: "Confirm the Etting reschedule", message: "Can we push the Etting shoot to Thursday?", at: ago(2 * DAY) });
  await outbound({ clientId: S.id, phone: S_PHONE, body: "Sounds good!", at: ago(1 * DAY) });
  await closeReplyForOutbound(S.id, "Sounds good!");

  // A third client whose only "reply" is OpenPhone's own missed-call greeting.
  const M = await mkClient("Mike Flatley", "(484) 555-0177");
  const M_PHONE = "4845550177";
  await prisma.commLog.create({
    data: {
      channel: "call", direction: "in", clientId: M.id, clientName: M.name, contactName: M.name,
      fromPhone: M_PHONE, body: "Inbound missed call from Mike Flatley.", occurredAt: ago(6 * HOUR), source: "openphone",
    },
  });
  await request({ clientId: M.id, title: "Return the missed call", message: "Missed call — call them back", at: ago(6 * HOUR) });
  await outbound({
    clientId: M.id, phone: M_PHONE, at: ago(6 * HOUR - 4000),
    body: "Hey! Thanks for calling Realtour Pilot. We’re sorry we missed your call.\n\nWe may be on another line or our office admin may be away from the phone at the moment. We’ve received your call and will get back to you shortly.",
  });

  // A fourth client, who is the reason the burst rule exists. Renee's real
  // Sep 18: she asked about the Cardigan aerials at 20:07:05, Kyle credited her
  // $50 at 20:08:16 and she said "Thank you!!" at 20:09:02 — and the router
  // filed his answer against 1022 Chiswell. Per-order books say Cardigan was
  // never answered; seventy-one seconds says otherwise, and no future text will
  // ever be filed against a finished shoot, so a row minted here would sit on
  // Kyle's board forever.
  const G = await mkClient("Gina Spaziano", "(484) 555-0122");
  const G_PHONE = "4845550122";
  const gAerial = await mkProject("18 Ridge Rd", G.id);
  const gOther = await mkProject("77 Valley Ln", G.id);
  const G_ASK = "We skipped the drone at Ridge Rd because of the wind. Can we get that credited?";
  await inbound({ clientId: G.id, clientName: G.name, phone: G_PHONE, projectId: gAerial.id, body: G_ASK, at: ago(2 * DAY) });
  const ginaTask = await request({ clientId: G.id, projectId: gAerial.id, address: "18 Ridge Rd", title: "Apply credit for the skipped Ridge Rd drone", message: G_ASK, at: ago(2 * DAY) });
  // 71 seconds later, and misfiled to the other order — exactly Renee's row.
  await outbound({ clientId: G.id, phone: G_PHONE, projectId: gOther.id, body: "Took the drone off that shoot and credited your account back for the difference ($50).", at: ago(2 * DAY - 71_000) });
  // …then a whole day of unrelated conversation on the other order, so the
  // newest outbound is nowhere near the question. The rule has to look at the
  // FIRST reply after the question, not the last reply overall.
  await inbound({ clientId: G.id, clientName: G.name, phone: G_PHONE, projectId: gOther.id, body: "Also, can we get the Valley Ln twilight shots moved to Friday?", at: ago(1 * DAY) });
  await outbound({ clientId: G.id, phone: G_PHONE, projectId: gOther.id, body: "Friday works, I've moved it.", at: ago(1 * DAY - 5 * 60_000) });

  // A fifth, holding TWO requests that name no order at all. They key on the
  // conversation, so before Sep 20 the second one was silently dropped by the
  // ledger's own dedupe and left every comms surface.
  const B = await mkClient("Bety Pena", "(267) 555-0166");
  const B_PHONE = "2675550166";
  // Past OWED_LOOKBACK_DAYS, so even the owed-client back-read cannot reach the
  // conversation and the ledger is genuinely the only thing that can show these
  // — which is where the second one was being eaten.
  await inbound({ clientId: B.id, clientName: B.name, phone: B_PHONE, body: "Do you do twilight shoots in the winter?", at: ago(60 * DAY) });
  const betyA = await request({ clientId: B.id, title: "Answer the winter twilight question", message: "Do you do twilight shoots in the winter?", at: ago(60 * DAY), dedupe: `${B.id}|noproject|client_reply` });
  const betyB = await request({ clientId: B.id, title: "Send the 2027 rate card", message: "Do you do twilight shoots in the winter?", at: ago(59 * DAY), dedupe: `${B.id}|noproject|client_reply|2` });

  console.log("\n1. The conversation clears on our reply; the unanswered REQUEST does not");
  const live = await unansweredComms({ now: NOW, families: ["phone"] });
  const liveRenee = live.filter((t) => t.clientId === R.id);
  check("Renee's live card is cleared by our reply (one contact, one conversation)", liveRenee.length === 0, `${liveRenee.length} live rows`);

  const owed = await openObligations({ now: NOW, families: ["phone"] });
  const owedRenee = owed.filter((o) => o.clientId === R.id);
  check("the Cardigan request is still owed", owedRenee.some((o) => o.taskId === cardiganTask.id));
  check("the Church St request is settled by the reply filed against Church St", !owedRenee.some((o) => o.taskId === churchTask.id), `${owedRenee.map((o) => o.propertyAddress).join(" | ")}`);
  const cardiganOwed = owedRenee.find((o) => o.taskId === cardiganTask.id);
  check("it is flagged as replied-around, not replied-to", !!cardiganOwed?.repliedElsewhere);
  check("it carries its own property", cardiganOwed?.propertyAddress === CARDIGAN, cardiganOwed?.propertyAddress ?? "none");
  check("it carries its OWN words, not the other property's", cardiganOwed?.lastInboundText === CARDIGAN_ASK, (cardiganOwed?.lastInboundText ?? "").slice(0, 40));

  console.log("\n2. The question comes back to the surfaces Kyle actually works");
  const withOwed = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  const reneeRows = withOwed.filter((t) => t.clientId === R.id);
  check("Renee has a row again", reneeRows.length === 1, `${reneeRows.length} rows`);
  check("keyed to the request, not just the contact", reneeRows[0]?.key === `c:${R.id}#${cardiganTask.id}`, reneeRows[0]?.key ?? "none");
  check("the card names the property", reneeRows[0]?.propertyAddress === CARDIGAN, reneeRows[0]?.propertyAddress ?? "none");
  check("the card shows the Cardigan question", reneeRows[0]?.pending[0]?.body === CARDIGAN_ASK);
  const board = await unansweredCommsBoard("phone", NOW);
  check("it is on the /tasks Comms board", board.some((g) => g.clientId === R.id && g.openTaskId === cardiganTask.id));
  check("no two rows share a key", new Set(withOwed.map((t) => t.key)).size === withOwed.length);

  console.log("\n3. The pager's scope is untouched");
  const paged = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("the re-surfaced request does not wake anybody", !paged.some((p) => p.clientId === R.id), `${paged.length} pageable`);

  console.log("\n4. One request on the record still settles on a street-less reply");
  // This is what keeps the per-order rule off the ordinary conversation:
  // closeReplyScoped closes a client's ONE open request on any reply, so it
  // never reaches the ledger. It refuses for a multi-order client, which is
  // exactly the case the rule above exists for.
  const stephenOpen = await prisma.smartTask.count({ where: { clientId: S.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  check("the task layer closed his only request on \"Sounds good!\"", stephenOpen === 0, `${stephenOpen} open`);
  check("so nothing is owed", !owed.some((o) => o.clientId === S.id), `${owed.filter((o) => o.clientId === S.id).length} owed`);
  check("and he has no row on any comms surface", !withOwed.some((t) => t.clientId === S.id));
  const reneeOpen = await prisma.smartTask.count({ where: { clientId: R.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  check("Renee's two requests are NOT both closed by one reply (tasks.ts refuses to guess)", reneeOpen >= 1, `${reneeOpen} open`);

  console.log("\n5. A robot is not us answering");
  check("the missed-call greeting leaves the callback owed", owed.some((o) => o.clientId === M.id), `${owed.filter((o) => o.clientId === M.id).length} owed`);

  console.log("\n5a. An answer in the same breath is the answer, whatever the router filed it against");
  check("Gina's credit question is NOT re-surfaced", !owed.some((o) => o.taskId === ginaTask.id), `${owed.filter((o) => o.clientId === G.id).length} owed`);
  check("and she is on no comms surface", !withOwed.some((t) => t.clientId === G.id));
  check("nor on the /tasks Comms board", !board.some((g) => g.clientId === G.id));

  console.log("\n5b. Two requests naming no order are two rows, not one");
  const betyOwed = owed.filter((o) => o.clientId === B.id);
  check("both of Bety's requests are owed", betyOwed.length === 2, `${betyOwed.length} owed`);
  check("and they do not share a key", new Set(betyOwed.map((o) => o.rowKey)).size === 2, betyOwed.map((o) => o.rowKey).join(" | "));
  const betyRows = withOwed.filter((t) => t.clientId === B.id);
  check("both reach the Replies tab", betyRows.length === 2, `${betyRows.length} rows`);
  check("both reach the Comms board", board.filter((g) => g.clientId === B.id).length === 2, `${board.filter((g) => g.clientId === B.id).length} rows`);
  check("each row still carries the client's own words, not a bare title", betyRows.length > 0 && betyRows.every((t) => /twilight shoots in the winter/.test(t.pending[0]?.body ?? "")), betyRows.map((t) => (t.pending[0]?.body ?? "").slice(0, 30)).join(" | "));
  check("nothing was dropped between the ledger and the board", new Set([betyA.id, betyB.id]).size === new Set(betyRows.map((t) => t.openTaskId)).size);

  console.log("\n6. The Handled tick resolves what it is pointed at");
  const offThread = await requestsOffThread(R.id, NOW);
  check("the ledger can say which request the live card cannot be about", offThread.length === 1 && offThread[0].taskId === cardiganTask.id);

  // (a) the tick on the CONVERSATION, with a second request already off it.
  const churchOpen = await request({ clientId: R.id, projectId: church.id, address: CHURCH, title: "Send Church St gallery link", message: "Did the gallery link go out?", at: ago(2 * HOUR), dedupe: `${R.id}|${church.id}|client_reply|2` });
  await inbound({ clientId: R.id, clientName: R.name, phone: R_PHONE, projectId: church.id, body: "Did the gallery link go out?", at: ago(2 * HOUR) });

  // …and FIRST, the shape the fix was written for and the drill used to skip:
  // she is talking to us again, so she HAS a live card. The Cardigan question
  // still has to be visible beside it. A phone card's key is `c:<clientId>` and
  // so is the obligation's thread key, so a `!shownKeys.has(threadKey)` test in
  // front of the exception made the whole re-surfacing branch dead code —
  // it worked only while the client stayed silent, which for Stephen Kennedy
  // (a dozen texts a day, five live orders) is never.
  console.log("\n6a. A live conversation does not re-hide the other property's question");
  const liveNow = await unansweredComms({ now: NOW, families: ["phone"] });
  check("Renee has a live card again once she texts", liveNow.some((t) => t.key === `c:${R.id}`), `${liveNow.filter((t) => t.clientId === R.id).length} live rows`);
  const bothNow = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("the live card is there", bothNow.some((t) => t.key === `c:${R.id}`));
  check("AND the Cardigan request is beside it", bothNow.some((t) => t.key === `c:${R.id}#${cardiganTask.id}`), bothNow.filter((t) => t.clientId === R.id).map((t) => t.key).join(" | "));
  check("no two rows share a key", new Set(bothNow.map((t) => t.key)).size === bothNow.length);
  const boardNow = await unansweredCommsBoard("phone", NOW);
  check("both are on the /tasks Comms board", boardNow.filter((g) => g.clientId === R.id).length === 2, `${boardNow.filter((g) => g.clientId === R.id).length} rows`);
  const pagedNow = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("the pager sees the live message and not the ledger row", pagedNow.filter((p) => p.clientId === R.id).length === 1, `${pagedNow.filter((p) => p.clientId === R.id).length} pageable`);

  console.log("\n6b. The Handled tick resolves what it is pointed at");
  const tick = await markCommsHandled(R.id, "phone");
  check("the tick reports ok", tick.ok);
  const afterTick = await prisma.smartTask.findMany({ where: { clientId: R.id }, select: { id: true, status: true } });
  const statusOf = (id: string) => afterTick.find((t) => t.id === id)?.status;
  check("it closes the request the conversation was about", statusOf(churchOpen.id) === "COMPLETED", statusOf(churchOpen.id) ?? "?");
  check("it LEAVES the other property's request open", statusOf(cardiganTask.id) !== "COMPLETED", statusOf(cardiganTask.id) ?? "?");
  check("and it says so", /Cardigan/.test(tick.message ?? ""), tick.message ?? "no message");
  const stillOwed = await openObligations({ now: NOW, families: ["phone"] });
  check("the Cardigan request survives the conversation tick in the ledger", stillOwed.some((o) => o.taskId === cardiganTask.id));

  // (b) the tick on the REQUEST'S OWN row — the key the ledger emitted.
  //
  // She writes again first. Closing a request stamps completedAt, and the live
  // walk read ANY completed request as "this whole conversation was dealt with
  // at that instant" — so a tick on the Cardigan ledger row at 10:04 used to
  // wipe a Church St question that arrived at 10:02, off the Replies tab, the
  // board, the /ops pill and the pager, with nobody having read it.
  const tick2 = await markCommsHandled(R.id, "phone", `${R.id}#${cardiganTask.id}`);
  check("the per-request tick reports ok", tick2.ok);
  const cardiganAfter = await prisma.smartTask.findUnique({ where: { id: cardiganTask.id }, select: { status: true } });
  check("it closes exactly that request", cardiganAfter?.status === "COMPLETED", cardiganAfter?.status ?? "?");
  const endOwed = await openObligations({ now: NOW, families: ["phone"] });
  check("Renee owes nothing once both are answered", !endOwed.some((o) => o.clientId === R.id), `${endOwed.filter((o) => o.clientId === R.id).length} owed`);

  // (c) the Replies tab's Dismiss, which clears by THREAD KEY rather than by
  //     group — same row, same scope, and it must not take a sibling with it.
  const church2 = await request({ clientId: R.id, projectId: church.id, address: CHURCH, title: "Send the Church St floor plan", message: "Where are the floor plans for Church St?", at: ago(1 * HOUR), dedupe: `${R.id}|${church.id}|client_reply|3` });
  const cardigan2 = await request({ clientId: R.id, projectId: cardigan.id, address: CARDIGAN, title: "Confirm the Cardigan credit landed", message: "Did the credit go through?", at: ago(1 * HOUR), dedupe: `${R.id}|${cardigan.id}|client_reply|2` });
  const dismissed = await markCommsHandled(R.id, "phone", undefined, { threadKey: `c:${R.id}#${cardigan2.id}`, reason: "no reply needed" });
  check("the Dismiss reports ok", dismissed.ok);
  const after2 = await prisma.smartTask.findMany({ where: { id: { in: [church2.id, cardigan2.id] } }, select: { id: true, status: true } });
  check("Dismiss clears the request it was on", after2.find((t) => t.id === cardigan2.id)?.status === "COMPLETED");
  check("and leaves the other property's request alone", after2.find((t) => t.id === church2.id)?.status !== "COMPLETED", after2.find((t) => t.id === church2.id)?.status ?? "?");

  console.log("\n6c. A tick on one property's row does not silence a live conversation");
  // Closing a request stamps completedAt, and the live walk read ANY completed
  // request as "this whole conversation was dealt with at that instant" — so a
  // tick on one property's ledger row at 10:04 wiped a question that arrived at
  // 10:02 about another property, off the Replies tab, the board, the /ops pill
  // and the 5-minute pager, with nobody having read it.
  const A = await mkClient("Ashley Brunner", "(610) 555-0188");
  const A_PHONE = "6105550188";
  const montrose = await mkProject("5841 Montrose Ave", A.id);
  const venango = await mkProject("1507 W Venango St", A.id);
  const MONTROSE_ASK = "Are the Montrose twilight shots part of the package or an add-on?";
  const VENANGO_ASK = "Quick one — did the Venango gallery go out to my seller?";
  await inbound({ clientId: A.id, clientName: A.name, phone: A_PHONE, projectId: montrose.id, body: MONTROSE_ASK, at: ago(3 * DAY) });
  const montroseTask = await request({ clientId: A.id, projectId: montrose.id, address: "5841 Montrose Ave", title: "Answer the Montrose twilight pricing question", message: MONTROSE_ASK, at: ago(3 * DAY) });
  // Answered around, on the other order, a day later — so Montrose is owed and
  // its question is off the live card.
  await outbound({ clientId: A.id, phone: A_PHONE, projectId: venango.id, body: "All set on your end, nothing else needed from you.", at: ago(2 * DAY) });
  // …and then she writes again, twenty minutes ago, about Venango.
  await inbound({ clientId: A.id, clientName: A.name, phone: A_PHONE, projectId: venango.id, body: VENANGO_ASK, at: ago(20 * 60_000) });
  const venangoTask = await request({ clientId: A.id, projectId: venango.id, address: "1507 W Venango St", title: "Confirm the Venango gallery went out", message: VENANGO_ASK, at: ago(20 * 60_000) });

  const aOwed = await openObligations({ now: NOW, families: ["phone"] });
  check("the Montrose request is owed and off the card", aOwed.some((o) => o.taskId === montroseTask.id && o.repliedElsewhere));
  const aBefore = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("she has a live card and a Montrose row", aBefore.filter((t) => t.clientId === A.id).length === 2, aBefore.filter((t) => t.clientId === A.id).map((t) => t.key).join(" | "));

  const tickMontrose = await markCommsHandled(A.id, "phone", `${A.id}#${montroseTask.id}`);
  check("the per-request tick reports ok", tickMontrose.ok);
  const aAfter = await unansweredComms({ now: NOW, families: ["phone"] });
  const aLive = aAfter.find((t) => t.key === `c:${A.id}`);
  check("her twenty-minute-old question survives it", !!aLive, "her live card is gone");
  check("and the card still carries her actual words", aLive?.pending.some((m) => m.body === VENANGO_ASK) ?? false, aLive?.pending.map((m) => m.body.slice(0, 24)).join(" | ") ?? "none");
  const aPaged = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("the 5-minute pager can still see it", aPaged.some((p) => p.clientId === A.id), `${aPaged.length} pageable`);
  check("and the Montrose row is gone", !(await openObligations({ now: NOW, families: ["phone"] })).some((o) => o.taskId === montroseTask.id));

  // A row pressed after somebody else already closed it closes NOTHING. Falling
  // through to the client-wide rule would complete a DIFFERENT property's
  // request on a click aimed at this one — the defect wearing a stale page as a
  // disguise.
  const stale = await markCommsHandled(A.id, "phone", `${A.id}#${montroseTask.id}`);
  check("a stale per-request tick says so", stale.ok && /already handled/i.test(stale.message ?? ""), stale.message ?? "no message");
  const venangoStatus = (await prisma.smartTask.findUnique({ where: { id: venangoTask.id }, select: { status: true } }))?.status;
  check("and it does not close the request that is still open", venangoStatus !== "COMPLETED", venangoStatus ?? "?");

  console.log("\n7. Nothing was deleted");
  const all = await prisma.smartTask.count({ where: { clientId: R.id } });
  check("every request Renee ever raised still exists as history", all === 5, `${all} rows`);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

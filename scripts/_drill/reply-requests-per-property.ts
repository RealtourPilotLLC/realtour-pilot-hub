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
//
// And two the Sep 20 RE-review put here, which are the repair's own regression,
// in both directions (§6d, §6e):
//  13. the tick on one property's row does not silence the conversation EVEN
//      WHEN IT IS THE LAST REQUEST OPEN. The first repair stood the cut down
//      only while a sibling happened to be open, so §6c passed on a condition
//      that has nothing to do with what was clicked — and with the sibling
//      gone the same click hid an unread message from the Replies tab, the
//      comms board, the /ops pill and the 5-minute pager;
//  14. every OTHER close still settles the conversation. Standing the cut down
//      threw away 29 of the 130 completed phone requests on the books, 13 of
//      them with no outbound within five minutes — conversations somebody
//      settled by hand, still on the board and still paging. A visibility
//      change must never become an alerting one;
//  15. a client holding exactly ONE request we replied around keeps it through
//      a tick on the conversation card (§6f). The off-thread protection was
//      gated on the client holding more than one, and the count was taken after
//      gmail had been filtered out — so one text request plus one email request
//      read as "one" and the gate opened.
//
// And one the wave-3 VERIFICATION put here, which is the same blocking failure
// through the only other door these rows render on (§6g):
//  16. Ops Day's Handled button is not a client-wide cut either. `client_reply`
//      is in BOARD_HIDDEN_TYPES, so the Open Loops card is the only surface
//      left, and `markLoopHandled` wrote a bare COMPLETED — so Kyle pressing
//      Handled on Renee's Cardigan row took her two-minute-old Church St
//      question off the Replies tab, the comms board, the /ops pill and the
//      pager. Both directions are pinned: a loop row that names an ORDER is one
//      property's row and does not cut (§6g), and a reply request filed against
//      no order is the conversation and still does (§6g-bis).
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
  const { unansweredComms, openObligations, requestsOffThread, requestTickKey, ackValue } = await import("@/lib/replyQueue");
  const { unansweredCommsBoard } = await import("@/lib/commsBoard");
  const { findUnansweredInbound } = await import("@/lib/commsSla");
  const { markCommsHandled, setSmartTaskStatus } = await import("@/app/actions");
  const { markLoopHandled } = await import("@/app/ops/actions");
  const { openLoopsList } = await import("@/lib/opsDay");
  const { closeReplyForOutbound } = await import("@/lib/tasks");
  const { prisma } = await import("@/lib/prisma");

  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // THE HARNESS CLOCK (Sep 20 2026). Every message here is written on a fixed
  // fake NOW, but the shipped close paths stamp `completedAt: new Date()` — the
  // real wall clock. A reply that the drill says went out a day ago therefore
  // lands in the database stamped today, and a completed request is a CUT POINT
  // on the conversation, so every fake-past message after it would read as
  // older than the close and drop off the card. Re-stamp a close at the moment
  // the drill says it happened. Ticks the drill performs "now" keep the real
  // clock, because that is exactly what a click is.
  const stampClose = (taskIds: string[], at: Date) =>
    prisma.smartTask.updateMany({ where: { id: { in: taskIds } }, data: { completedAt: at } });

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
  await stampClose([churchTask.id], ago(1 * DAY));

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

  console.log("\n6d. …and it still does not, when it is the LAST request open");
  // THE SHAPE 6c EXCLUDED, AND THE REGRESSION IT HID (re-review, Sep 20 2026).
  //
  // The first repair stood the completed-request cut down while the client
  // still had another phone request open. Ashley above has one, so 6c passed
  // on a condition that has nothing to do with what was clicked. Take the
  // sibling away and the same click cuts the whole conversation again: the set
  // is empty on the next render, the completion lands as a client-wide cut, and
  // every message older than the click drops off the Replies tab, the comms
  // board, the /ops pill AND findUnansweredInbound, which is what the 5-minute
  // pager reads. Jamie Achberger is one of the five real clients this would
  // have hit.
  const J = await mkClient("Jamie Achberger", "(610) 555-0133");
  const J_PHONE = "6105550133";
  const lincoln = await mkProject("8 Lincoln Pl, Whitehall, PA 18052", J.id);
  const scheidy = await mkProject("41 Scheidys Rd, Allentown, PA 18104", J.id);
  const livingston = await mkProject("2726 W Livingston St, Allentown, PA 18104", J.id);
  const LINCOLN_ASK = "Is the Lincoln Place order set up for the twilight add-on?";
  const SCHEIDY_ASK = "Does Jamie have a credit we can put toward Scheidys Rd?";
  const LIVINGSTON_ASK = "Sorry, one more — did anyone lock the back door at Livingston when you left?";

  await inbound({ clientId: J.id, clientName: J.name, phone: J_PHONE, projectId: lincoln.id, body: LINCOLN_ASK, at: ago(6 * DAY) });
  const lincolnTask = await request({ clientId: J.id, projectId: lincoln.id, address: "8 Lincoln Pl", title: "Set up the Lincoln Place twilight add-on", message: LINCOLN_ASK, at: ago(6 * DAY) });
  await inbound({ clientId: J.id, clientName: J.name, phone: J_PHONE, projectId: scheidy.id, body: SCHEIDY_ASK, at: ago(5 * DAY) });
  const scheidyTask = await request({ clientId: J.id, projectId: scheidy.id, address: "41 Scheidys Rd", title: "Check the credit and apply it to Scheidys", message: SCHEIDY_ASK, at: ago(5 * DAY) });
  // A street-less reply four days ago. `findClientProjectByText` finds no street
  // in it (85% of our texts name none), so tasks.ts falls back to the order the
  // most recent inbound was filed against — Scheidys — and closes THAT request.
  // A real close, about the conversation, and the shape 15 of the 29 discarded
  // cuts actually are. Lincoln Place is left open and now sits BEFORE our last
  // reply, so its question is off the live card.
  await outbound({ clientId: J.id, phone: J_PHONE, projectId: livingston.id, body: "All set on your end, nothing else needed from you.", at: ago(4 * DAY) });
  await closeReplyForOutbound(J.id, "All set on your end, nothing else needed from you.");
  await stampClose([scheidyTask.id], ago(4 * DAY));
  const jamieOpenNow = await prisma.smartTask.findMany({ where: { clientId: J.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } });
  check("Lincoln Place is the ONLY request she has open", jamieOpenNow.length === 1 && jamieOpenNow[0].id === lincolnTask.id, `${jamieOpenNow.length} open`);

  // …and NOW she texts about something else entirely, two minutes ago. The
  // receiver mints her reply task off the webhook; the message is on the card
  // from the instant it lands, which is what the pager reads.
  await inbound({ clientId: J.id, clientName: J.name, phone: J_PHONE, projectId: livingston.id, body: LIVINGSTON_ASK, at: ago(2 * 60_000) });
  const jBefore = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("her two-minute-old question is on the card", jBefore.some((t) => t.key === `c:${J.id}` && t.pending.some((m) => m.body === LIVINGSTON_ASK)), jBefore.filter((t) => t.clientId === J.id).map((t) => t.key).join(" | "));
  check("and the Lincoln Place request is beside it", jBefore.some((t) => t.key === `c:${J.id}#${lincolnTask.id}`));
  const jPagedBefore = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("the pager can see her", jPagedBefore.some((p) => p.clientId === J.id), `${jPagedBefore.filter((p) => p.clientId === J.id).length} pageable`);

  const tickLincoln = await markCommsHandled(J.id, "phone", `${J.id}#${lincolnTask.id}`);
  check("the tick on the last open request reports ok", tickLincoln.ok, tickLincoln.message ?? "");
  const lincolnAfter = (await prisma.smartTask.findUnique({ where: { id: lincolnTask.id }, select: { status: true } }))?.status;
  check("it closes exactly that request", lincolnAfter === "COMPLETED", lincolnAfter ?? "?");
  const jAfter = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  const jLive = jAfter.find((t) => t.key === `c:${J.id}`);
  check("HER TWO-MINUTE-OLD QUESTION SURVIVES IT", !!jLive, "her live card is gone — the tick cut the conversation");
  check("word for word", jLive?.pending.some((m) => m.body === LIVINGSTON_ASK) ?? false, jLive?.pending.map((m) => m.body.slice(0, 28)).join(" | ") ?? "none");
  const jBoard = await unansweredCommsBoard("phone", NOW);
  check("it is still on the /tasks comms board", jBoard.some((g) => g.clientId === J.id), `${jBoard.filter((g) => g.clientId === J.id).length} rows`);
  const jPaged = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("and the 5-minute pager can still see it", jPaged.some((p) => p.clientId === J.id), `${jPaged.filter((p) => p.clientId === J.id).length} pageable`);
  check("the Lincoln Place row itself is gone", !(await openObligations({ now: NOW, families: ["phone"] })).some((o) => o.taskId === lincolnTask.id));

  console.log("\n6d-bis. A marker outlives its click but not its close");
  // A `client_reply` can be REOPENED — `mergeIntoExistingTask` does it when a
  // client asks the same thing again — and the marker from the tick that closed
  // it the first time is still sitting in AppSetting. If it went on suppressing
  // the cut, the SECOND close would be silent too and the conversation would
  // page forever about something we settled. The marker only speaks for the
  // close it was written beside (REQUEST_TICK_WINDOW_MS).
  await prisma.appSetting.update({ where: { key: requestTickKey(lincolnTask.id) }, data: { value: ackValue(ago(1 * DAY), "handled on the request's own row") } });
  await prisma.smartTask.update({ where: { id: lincolnTask.id }, data: { status: "OPEN", completedAt: null } });
  await inbound({ clientId: J.id, clientName: J.name, phone: J_PHONE, projectId: lincoln.id, body: "Following up on the Lincoln Place twilight add-on.", at: ago(60_000) });
  check("her conversation is back on the board", (await unansweredComms({ now: NOW, families: ["phone"] })).some((t) => t.key === `c:${J.id}`));
  // Kyle rings her and closes the row from the task side — no ack, no outbound.
  await setSmartTaskStatus(lincolnTask.id, "COMPLETED");
  check("the stale marker does not silence the SECOND close", !(await unansweredComms({ now: NOW, families: ["phone"] })).some((t) => t.key === `c:${J.id}`), "the conversation is still on the board");
  check("and the pager lets go with it", !(await findUnansweredInbound(NOW, { families: ["phone"] })).some((p) => p.clientId === J.id));

  console.log("\n6e. A close that IS about the conversation still settles it");
  // THE OTHER DIRECTION, AND THE OTHER HALF OF THE REGRESSION. Standing the cut
  // down whenever a sibling was open threw away 29 of the 130 completed phone
  // requests on the books — 13 of them with no outbound within five minutes of
  // the close, so the cut was the only thing that had ever cleared those cards.
  // Brenna Barkasi is one of them: somebody rang her, sorted it, closed the row
  // from the task side, and the conversation stayed on the board and stayed
  // pageable because another property's request was open somewhere else.
  //
  // A close made ON ONE PROPERTY'S ROW is the only one that is not a statement
  // about the conversation. Every other one — a reply, a tick on the card, a
  // status set to Complete — is.
  //
  // Sep 20, wave-3 follow-up: "a loop marked handled" used to be on that list
  // and has come off it, for the per-request shape only. The Open Loops card is
  // the one surface a `client_reply` renders on outside the comms card, and a
  // row there carries a title and a street and no messages, so pressing Handled
  // on it is the same act as ticking it on the comms card (§6g). A loop that
  // names no order is still the conversation and still cuts (§6g-bis).
  // `setSmartTaskStatus`, exercised here and in §6d-bis, is deliberately NOT in
  // the exception — see the note in src/app/actions.ts.
  const BB = await mkClient("Brenna Barkasi", "(484) 555-0111");
  const BB_PHONE = "4845550111";
  const skyline = await mkProject("14 Skyline Dr, Reading, PA 19606", BB.id);
  const shells = await mkProject("903 Shells Church Rd, Reading, PA 19606", BB.id);
  const penn = await mkProject("2200 Penn Ave, Reading, PA 19609", BB.id);
  const SKYLINE_ASK = "Can the Skyline Dr card charge be refunded and put on as a credit instead?";
  const SHELLS_ASK = "Where do I find the revised Shells Church Rd video?";
  const SHELLS_CHASE = "Sorry to chase — still can't find that revised Shells Church video anywhere.";

  await inbound({ clientId: BB.id, clientName: BB.name, phone: BB_PHONE, projectId: skyline.id, body: SKYLINE_ASK, at: ago(6 * DAY) });
  const skylineTask = await request({ clientId: BB.id, projectId: skyline.id, address: "14 Skyline Dr", title: "Refund the Skyline Dr charge and apply the credit", message: SKYLINE_ASK, at: ago(6 * DAY) });
  await inbound({ clientId: BB.id, clientName: BB.name, phone: BB_PHONE, projectId: shells.id, body: SHELLS_ASK, at: ago(5 * DAY) });
  const shellsTask = await request({ clientId: BB.id, projectId: shells.id, address: "903 Shells Church Rd", title: "Find the revised Shells Church Rd video and send it", message: SHELLS_ASK, at: ago(5 * DAY) });
  // A note about a THIRD order, which owes no reply, is the newest thing she
  // sent before our text — so tasks.ts infers Penn Ave, finds no request on it,
  // sees two open and refuses to guess. Both stay open, which is the multi-order
  // doctrine working and the state 107 historical overlaps were in.
  await inbound({ clientId: BB.id, clientName: BB.name, phone: BB_PHONE, projectId: penn.id, body: "Penn Ave went great by the way, thank you!", at: ago(4 * DAY + 2 * HOUR) });
  await outbound({ clientId: BB.id, phone: BB_PHONE, projectId: penn.id, body: "On it, I'll come back to you shortly.", at: ago(4 * DAY) });
  await closeReplyForOutbound(BB.id, "On it, I'll come back to you shortly.");
  const bbOpen = await prisma.smartTask.count({ where: { clientId: BB.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  check("the street-less reply closes neither of her two requests", bbOpen === 2, `${bbOpen} open`);
  // She chases three hours ago, about Shells Church — so THAT question is on
  // the card and the Skyline one, answered around four days back, is not.
  await inbound({ clientId: BB.id, clientName: BB.name, phone: BB_PHONE, projectId: shells.id, body: SHELLS_CHASE, at: ago(3 * HOUR) });

  const bbOwed = await openObligations({ now: NOW, families: ["phone"] });
  check("the Skyline request is owed and off the card", bbOwed.some((o) => o.taskId === skylineTask.id && o.repliedElsewhere));
  check("the Shells Church request is owed and ON the card", bbOwed.some((o) => o.taskId === shellsTask.id && !o.repliedElsewhere));
  const bbBefore = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("her chase is on the live card", bbBefore.some((t) => t.key === `c:${BB.id}` && t.pending.some((m) => m.body === SHELLS_CHASE)));
  const bbPagedBefore = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("and the pager is watching it", bbPagedBefore.some((p) => p.clientId === BB.id));

  // Kyle rings her, finds the video, sends it, and closes the row from the task
  // side — the path the Open Loops card and the task board both use. No ack, no
  // outbound text: the completed request is the whole record of the decision.
  await setSmartTaskStatus(shellsTask.id, "COMPLETED");
  const bbAfter = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("the conversation clears", !bbAfter.some((t) => t.key === `c:${BB.id}`), bbAfter.filter((t) => t.clientId === BB.id).map((t) => t.key).join(" | "));
  const bbPaged = await findUnansweredInbound(NOW, { families: ["phone"] });
  check("THE PAGER STOPS PAGING ABOUT A CONVERSATION SOMEBODY SETTLED", !bbPaged.some((p) => p.clientId === BB.id), `${bbPaged.filter((p) => p.clientId === BB.id).length} pageable`);
  const bbBoard = await unansweredCommsBoard("phone", NOW);
  check("the /tasks comms board loses the conversation row", !bbBoard.some((g) => g.clientId === BB.id && g.openTaskId === shellsTask.id), `${bbBoard.filter((g) => g.clientId === BB.id).length} rows`);
  check("and keeps the Skyline request's own row", bbBoard.some((g) => g.clientId === BB.id && g.openTaskId === skylineTask.id));
  check("and the OTHER property's request is still standing", bbAfter.some((t) => t.key === `c:${BB.id}#${skylineTask.id}`), bbAfter.filter((t) => t.clientId === BB.id).map((t) => t.key).join(" | ") || "none");
  check("named after its own property", bbAfter.find((t) => t.key === `c:${BB.id}#${skylineTask.id}`)?.propertyAddress === "14 Skyline Dr");

  console.log("\n6f. One request off the card is still a request off the card");
  // THE OTHER HALF OF THE SAME REGRESSION (re-review, Sep 20 2026). The
  // off-thread protection used to be consulted only when the client held MORE
  // THAN ONE open request, so a client holding exactly ONE that we replied
  // around still had it closed by a tick on the conversation card — the exact
  // behaviour the branch's own comment condemns. And that single request is
  // precisely the one the ledger renders as its own row, so Kyle sees two rows
  // and ticking the live one closes the other.
  //
  // The count was wrong twice over: `openRows` filters gmail out before it is
  // taken, so a client with one text request and one email request read as
  // "one" and the gate opened. Jeff Scott holds both here.
  const JS = await mkClient("Jeff Scott", "(267) 555-0155");
  const JS_PHONE = "2675550155";
  const ettingProj = await mkProject("1631 S Etting St, Philadelphia, PA 19148", JS.id);
  const chelten = await mkProject("428 E Chelten Ave, Philadelphia, PA 19144", JS.id);
  const kingsessing = await mkProject("6305 Kingsessing Ave, Philadelphia, PA 19142", JS.id);
  const ETTING_ASK = "Is the Etting St shoot still down for the full package or did we drop the video?";
  const CHELTEN_ASK = "Is the issue at the back of Chelten the railing or the door?";
  const KINGSESSING_ASK = "Last thing — is the tenant at Kingsessing expecting you on Thursday?";

  await inbound({ clientId: JS.id, clientName: JS.name, phone: JS_PHONE, projectId: ettingProj.id, body: ETTING_ASK, at: ago(6 * DAY) });
  const ettingTask = await request({ clientId: JS.id, projectId: ettingProj.id, address: "1631 S Etting St", title: "Confirm the Etting St package still includes video", message: ETTING_ASK, at: ago(6 * DAY) });
  await inbound({ clientId: JS.id, clientName: JS.name, phone: JS_PHONE, projectId: chelten.id, body: CHELTEN_ASK, at: ago(5 * DAY) });
  const cheltenTask = await request({ clientId: JS.id, projectId: chelten.id, address: "428 E Chelten Ave", title: "Clarify whether the Chelten rear issue is railing or door", message: CHELTEN_ASK, at: ago(5 * DAY) });
  // An email request too. A phone tick answers texts, not email — and the count
  // that used to gate this branch never saw it.
  // On its OWN order, because `closeClientReplyTask` filters on client + order
  // and has no lane scope of its own (a separate F10 note) — parking it on the
  // order the reply below infers would close it for reasons this section is not
  // about.
  const wyoming = await mkProject("119 Wyoming St, Philadelphia, PA 19140", JS.id);
  const mailTask = await request({ clientId: JS.id, projectId: wyoming.id, address: "119 Wyoming St", title: "Reply to Jeff's email about the Wyoming St invoice", message: "Can you resend the Wyoming St invoice?", at: ago(5 * DAY), source: "gmail", dedupe: `${JS.id}|${wyoming.id}|client_reply|mail` });
  // A note about a third order is the newest thing he sent before our text, so
  // the close infers Kingsessing, finds no request on it, sees two open on the
  // phone lane and refuses. Both stay open and both are now off the card.
  await inbound({ clientId: JS.id, clientName: JS.name, phone: JS_PHONE, projectId: kingsessing.id, body: "Kingsessing looked great, thanks.", at: ago(4 * DAY + 2 * HOUR) });
  await outbound({ clientId: JS.id, phone: JS_PHONE, projectId: kingsessing.id, body: "All good, nothing needed from you.", at: ago(4 * DAY) });
  await closeReplyForOutbound(JS.id, "All good, nothing needed from you.");
  // Kyle deals with Chelten and ticks ITS row, so Etting is the only phone
  // request left — and it is one nobody has answered.
  const tickChelten = await markCommsHandled(JS.id, "phone", `${JS.id}#${cheltenTask.id}`);
  check("the Chelten row ticks off on its own", tickChelten.ok, tickChelten.message ?? "");
  const jsOpen = await prisma.smartTask.findMany({ where: { clientId: JS.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true, source: true } });
  check("he holds exactly one phone request and one email request", jsOpen.filter((t) => t.source !== "gmail").length === 1 && jsOpen.some((t) => t.id === mailTask.id), jsOpen.map((t) => t.source).join(" | "));
  const jsOwed = await openObligations({ now: NOW, families: ["phone"] });
  check("the Etting request is owed and off the card", jsOwed.some((o) => o.taskId === ettingTask.id && o.repliedElsewhere));

  // …and now he texts about something else, and Kyle ticks the CONVERSATION.
  await inbound({ clientId: JS.id, clientName: JS.name, phone: JS_PHONE, projectId: kingsessing.id, body: KINGSESSING_ASK, at: ago(2 * HOUR) });
  const jsBefore = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("he has a live card and an Etting row", jsBefore.filter((t) => t.clientId === JS.id).length === 2, jsBefore.filter((t) => t.clientId === JS.id).map((t) => t.key).join(" | "));
  const convTick = await markCommsHandled(JS.id, "phone");
  check("the conversation tick reports ok", convTick.ok, convTick.message ?? "");
  const ettingAfter = (await prisma.smartTask.findUnique({ where: { id: ettingTask.id }, select: { status: true } }))?.status;
  check("THE ETTING REQUEST IS STILL OPEN — nobody decided about a question that was not on screen", ettingAfter !== "COMPLETED", ettingAfter ?? "?");
  check("and the tick says which one it left standing", /Etting/.test(convTick.message ?? ""), convTick.message ?? "no message");
  const mailAfter = (await prisma.smartTask.findUnique({ where: { id: mailTask.id }, select: { status: true } }))?.status;
  check("the email request is untouched — a phone tick answers texts, not email", mailAfter !== "COMPLETED", mailAfter ?? "?");
  const jsAfter = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("the conversation itself clears", !jsAfter.some((t) => t.key === `c:${JS.id}`), jsAfter.filter((t) => t.clientId === JS.id).map((t) => t.key).join(" | "));
  check("and the Etting row is still there, named after its own property", jsAfter.some((t) => t.key === `c:${JS.id}#${ettingTask.id}` && t.propertyAddress === "1631 S Etting St"));
  const trace = await prisma.smartTask.count({ where: { clientId: JS.id, source: "manual", status: "COMPLETED" } });
  check("a tick that closed nothing still left a trace", trace === 1, `${trace} trace rows`);

  console.log("\n6g. The OTHER door onto a request's own row — Ops Day's Handled button");
  // THE SAME BLOCKING FAILURE, THROUGH THE ONLY OTHER SURFACE THESE ROWS
  // RENDER ON (wave-3 verification, Sep 20 2026). `client_reply` is in
  // BOARD_HIDDEN_TYPES, so after the comms card the /ops Open Loops list is
  // the only place Kyle ever sees one — and `markLoopHandled` wrote a bare
  // COMPLETED. The walk read that as a client-wide cut, so pressing Handled on
  // 453 Cardigan took a 358 N Church St question that arrived two minutes
  // earlier off the Replies tab, the comms board, the /ops pill and
  // findUnansweredInbound. Renee Ryan holds exactly those two rows in
  // production today, both with orders, both rendering as loop rows.
  //
  // Same client, same two properties as §1, rebuilt on a second record so the
  // history above is untouched.
  const R2 = await mkClient("Renee Ryan (second record)", "(610) 555-0166");
  const R2_PHONE = "6105550166";
  const churchB = await mkProject(CHURCH, R2.id);
  const cardiganB = await mkProject(CARDIGAN, R2.id);
  await inbound({ clientId: R2.id, clientName: R2.name, phone: R2_PHONE, projectId: cardiganB.id, body: CARDIGAN_ASK, at: ago(2 * DAY) });
  const cardiganLoop = await request({ clientId: R2.id, projectId: cardiganB.id, address: CARDIGAN, title: "Apply credit for skipped aerial shots at Cardigan", message: CARDIGAN_ASK, at: ago(2 * DAY) });
  // …and the Church St question lands two minutes ago, unread by anybody.
  await inbound({ clientId: R2.id, clientName: R2.name, phone: R2_PHONE, projectId: churchB.id, body: CHURCH_ASK, at: ago(2 * 60_000) });
  const churchLoop = await request({ clientId: R2.id, projectId: churchB.id, address: CHURCH, title: "Check with editor on Church St ETA and update Renee", message: CHURCH_ASK, at: ago(2 * 60_000) });

  const loopsBefore = await openLoopsList(NOW, null);
  check("both requests render on the Open Loops card", [cardiganLoop.id, churchLoop.id].every((id) => loopsBefore.some((l) => l.taskId === id && l.kind === "client_reply")), `${loopsBefore.filter((l) => l.kind === "client_reply").length} client_reply loops`);
  const r2Before = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  check("her two-minute-old Church St question is on the live card", r2Before.some((t) => t.key === `c:${R2.id}` && t.pending.some((m) => m.body === CHURCH_ASK)), r2Before.filter((t) => t.clientId === R2.id).map((t) => t.key).join(" | "));
  check("the pager is watching it", (await findUnansweredInbound(NOW, { families: ["phone"] })).some((p) => p.clientId === R2.id));

  // Kyle presses Handled on the CARDIGAN row, from Ops Day. He has a title and
  // a street in front of him and no messages at all.
  const loopTick = await markLoopHandled(cardiganLoop.id);
  check("the Handled button reports ok", loopTick.ok, loopTick.message ?? "");
  const cardiganLoopAfter = (await prisma.smartTask.findUnique({ where: { id: cardiganLoop.id }, select: { status: true } }))?.status;
  check("it closes exactly that request", cardiganLoopAfter === "COMPLETED", cardiganLoopAfter ?? "?");
  const churchLoopAfter = (await prisma.smartTask.findUnique({ where: { id: churchLoop.id }, select: { status: true } }))?.status;
  check("and leaves the other one standing", churchLoopAfter !== "COMPLETED", churchLoopAfter ?? "?");
  const r2After = await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true });
  const r2Live = r2After.find((t) => t.key === `c:${R2.id}`);
  check("HER TWO-MINUTE-OLD QUESTION SURVIVES THE OPS DAY CLOSE", !!r2Live, "her live card is gone — Handled cut the whole conversation");
  check("word for word", r2Live?.pending.some((m) => m.body === CHURCH_ASK) ?? false, r2Live?.pending.map((m) => m.body.slice(0, 28)).join(" | ") ?? "none");
  check("it is still on the /tasks comms board", (await unansweredCommsBoard("phone", NOW)).some((g) => g.clientId === R2.id));
  check("and the 5-minute pager can still see it", (await findUnansweredInbound(NOW, { families: ["phone"] })).some((p) => p.clientId === R2.id));
  check("the Cardigan row itself is gone from the ledger", !(await openObligations({ now: NOW, families: ["phone"] })).some((o) => o.taskId === cardiganLoop.id));

  console.log("\n6g-bis. …and a loop that is NOT one property's row still cuts");
  // THE OTHER DIRECTION, which is what made the first F10 repair worse than the
  // bug. The marker is scoped to `isPerRequestReply` — a phone-lane client_reply
  // that NAMES AN ORDER — and nothing else. A reply request filed against no
  // order has no property to be "about": it is the conversation, and a person
  // marking it handled has settled the conversation. That close must go on
  // cutting, or a client somebody dealt with by hand keeps paging, which is the
  // 29-discarded-cuts failure all over again.
  const NL = await mkClient("Nehemiah Lindo", "(717) 555-0122");
  const NL_PHONE = "7175550122";
  await inbound({ clientId: NL.id, clientName: NL.name, phone: NL_PHONE, body: "Are you free to shoot 2358 Buck Mountain Rd tomorrow at 10?", at: ago(3 * HOUR) });
  const nlLoop = await request({ clientId: NL.id, projectId: null, address: null, title: "Schedule shoot at 2358 Buck Mountain Rd for tomorrow at 10 AM", message: "Are you free to shoot 2358 Buck Mountain Rd tomorrow at 10?", at: ago(3 * HOUR) });
  check("his conversation is on the card", (await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true })).some((t) => t.key === `c:${NL.id}`));
  check("and the pager is watching it", (await findUnansweredInbound(NOW, { families: ["phone"] })).some((p) => p.clientId === NL.id));
  // Kyle rings him, books it, and presses Handled. No ack, no outbound text.
  const nlTick = await markLoopHandled(nlLoop.id);
  check("the Handled button reports ok", nlTick.ok, nlTick.message ?? "");
  check("no per-request marker was written for a request with no order", !(await prisma.appSetting.findUnique({ where: { key: requestTickKey(nlLoop.id) }, select: { key: true } })));
  check("THE CONVERSATION CLEARS", !(await unansweredComms({ now: NOW, families: ["phone"], includeOwed: true })).some((t) => t.key === `c:${NL.id}`), "still on the board after somebody settled it");
  check("and the pager stops paging about it", !(await findUnansweredInbound(NOW, { families: ["phone"] })).some((p) => p.clientId === NL.id));

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

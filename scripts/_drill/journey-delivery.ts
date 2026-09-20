/**
 * FIVE DELIVERY JOURNEYS, DRIVEN END TO END — AND THEN SWEPT.
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server \
 *      npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-delivery.ts
 *
 * The twelve Sep 20 fixes are committed. This asks the only question that
 * matters afterwards: do they still hold when a real scenario is driven through
 * the SHIPPED actions and THEN the background sweeps run over the top? The merge
 * fault the audit found did not show up at the click — it showed up an hour
 * later, in the sync. So every journey here is transition, then sweep, then
 * assert.
 *
 * The journeys:
 *   1. Four videos approved, one delivered — three named outputs still to send.
 *      The Completed pill must refuse and NAME the count; the delivery-text
 *      sweep must not release the "how did we do?" text the gate just refused;
 *      the status engine must not write DELIVERED behind both of them.
 *   2. A delivered job takes a second shoot — the original delivery history
 *      stands and the new obligation carries its OWN deadline, off its own day.
 *   3. Photo and video revisions open at once — closing the video lane leaves
 *      the photo lane, the job's Revisions stage and the image flags alone, and
 *      the status engine afterwards agrees.
 *   4. The historical first-delivery stamp survives a revision resolved, a
 *      board move back to Delivered, a queue Completed and two sweeps.
 *   5. Unreadable / absent evidence produces a VERIFICATION state (the text is
 *      held for a person, the card says "never cross-checked") rather than a
 *      confident automated completion — while a legitimate manual job keeps an
 *      explicit completion route.
 *
 * ONE CHECK FAILS, ON PURPOSE. Journey 5's third shape — a listing whose video
 * count is real but anonymous, so the hub can name only one of the four
 * deliveries it is claiming — is where the card and the automated send still
 * disagree. See 5b'.
 *
 * ISOLATION AND SAFETY
 *   · PGlite in-process Postgres, its own DATABASE_URL, pinned before any app
 *     module loads. Production Neon is never opened.
 *   · Aryeo's listing read and OpenPhone's number read are replaced with fixed
 *     answers — they are the two external reads the delivery lane depends on,
 *     and stubbing them is what lets the REAL status engine and the REAL
 *     delivery sweep run with no network at all.
 *   · global fetch is fenced to loopback and COUNTED. If a gate ever leaked and
 *     a sweep tried to hand a client text to a provider, nothing would leave the
 *     machine and the attempt is reported as a failure in its own right.
 *   · PGlite Socket multiplexes onto one connection, so nothing here claims to
 *     prove isolation or concurrency. Every journey is sequential.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5487;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;
// Slack/AI read their tokens out of the (empty) Connection table; the alert
// channel is an env var, so it goes too. No ping leaves this drill.
delete process.env.SLACK_ALERT_CHANNEL;

// ---- THE FENCE -------------------------------------------------------------
// Every outbound HTTP call in this process is refused and counted. The drill
// stubs the two reads it needs; anything else reaching for the network is a
// send that a gate should have stopped, and it is reported as one.
const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return realFetch(input as string, init as RequestInit);
  outbound.push(url);
  throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
}) as typeof fetch;

const DAY = 86_400_000;
let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const say = (label: string, value: unknown) => console.log(`  ·    ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");

  // ---- the two external reads, answered locally ---------------------------
  // Aryeo's listing: what the CLIENT can open. Per project id, so each journey
  // sets its own listing truth.
  type Listing = { images: unknown[]; videos: { id: string }[]; floor_plans: unknown[]; interactive_content: unknown[]; delivery_status: string | null };
  const listings = new Map<string, Listing>();
  const listing = (photos: number, videos: number, delivery: string | null = null): Listing => ({
    images: Array.from({ length: photos }, (_, i) => ({ id: `img-${i}` })),
    videos: Array.from({ length: videos }, (_, i) => ({ id: `vid-${i}`, title: `Video ${i + 1}`, duration: 60 })),
    floor_plans: [], interactive_content: [], delivery_status: delivery,
  });
  const aryeoMod = await import("@/lib/integrations/aryeo");
  let listingReads = 0;
  (aryeoMod.Aryeo as unknown as { listing: (id: string) => Promise<unknown> }).listing = async (id: string) => {
    listingReads++;
    const l = listings.get(id);
    if (!l) throw new Error(`no such listing ${id}`);
    return l;
  };
  // OpenPhone's number. Present so the delivery sweep gets PAST "not connected"
  // and actually reaches its gates — which is the whole point of journey 1.
  const opMod = await import("@/lib/integrations/openphone");
  (opMod.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [
    { id: "PN-drill", number: "+16105550100" },
  ];

  const { syncProjectStatuses } = await import("@/lib/projectStatus");
  const { sweepDeliveryTexts } = await import("@/lib/clientTextSweeps");
  const { setQueueStatus } = await import("@/app/editing/actions");
  const { moveProjectStatus, setSmartTaskStatus } = await import("@/app/actions");
  const { raiseRevision } = await import("@/lib/comms");
  const { reopenForAdditionalShoot } = await import("@/app/upload/actions");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { parseEvidence, owedNow, owedPhrase, statusFlag } = await import("@/lib/statusEvidence");
  const { outstandingForDelivery, outstandingMessage } = await import("@/lib/delivery");
  const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");

  // The send window is Mon-Fri 9:00-4:30pm ET by default, and a drill must not
  // be a different test on a Saturday. Open it wide in the drill database only.
  await prisma.appSetting.create({
    data: {
      key: "auto_texts",
      value: JSON.stringify({ enabled: true, sendFromHour: 0, sendUntilHour: 23, sendUntilMinute: 59, weekdaysOnly: false }),
    },
  });

  const client = await prisma.client.create({ data: { name: "Gary Smith", phone: "+16105550143", autoDeliveryText: true }, select: { id: true } });
  const shooter = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });
  await prisma.teamMember.create({ data: { name: "Kyle Pierce", email: "kyle@drill.invalid", role: "ADMIN" } });

  let seq = 0;
  const mkJob = async (title: string, over: Record<string, unknown> = {}) => {
    const listingId = `lst-${++seq}`;
    const p = await prisma.project.create({
      data: {
        title, clientId: client.id, source: "ARYEO", status: "EDITING",
        aryeoOrderId: `ord-${seq}`, aryeoListingId: listingId,
        price: 650, payableInvoice: 650,
        shootDate: new Date(Date.now() - 6 * DAY), photographerId: shooter.id,
        ...over,
      },
      select: { id: true },
    });
    return { id: p.id, listingId };
  };
  const proj = (id: string) =>
    prisma.project.findUniqueOrThrow({
      where: { id },
      select: { status: true, deliveredAt: true, deliveredBy: true, deliveredVia: true, statusEvidence: true, revisionRequestedAt: true },
    });
  const deliveryTask = (projectId: string, street: string) =>
    prisma.smartTask.create({
      data: {
        projectId, clientId: client.id, taskType: "delivery_text", title: `Send delivery text — ${street}`,
        dedupeKey: `delivery-text-${projectId}`, status: "OPEN", source: "hub",
      },
      select: { id: true },
    });
  const deliveryTask2 = (projectId: string, street: string, clientId: string) =>
    prisma.smartTask.create({
      data: {
        projectId, clientId, taskType: "delivery_text", title: `Send delivery text — ${street}`,
        dedupeKey: `delivery-text-${projectId}`, status: "OPEN", source: "hub",
      },
      select: { id: true },
    });
  const stubbedSends: number[] = [];
  const taskOf = (id: string) => prisma.smartTask.findUniqueOrThrow({ where: { id }, select: { status: true, summary: true, sourceDetail: true } });
  const sends = () => prisma.outboxMessage.count();
  const sendsFor = (projectId: string) => prisma.outboxMessage.count({ where: { projectId } });
  const accepted = () => prisma.outboxMessage.count({ where: { state: "accepted" } });
  const commsOut = () => prisma.commLog.count({ where: { direction: "out" } });

  console.log("=".repeat(78));
  console.log("DELIVERY JOURNEYS — the shipped actions, then the background sweeps");
  console.log("=".repeat(78));

  // =======================================================================
  // JOURNEY 1 — four videos approved, one delivered.
  // =======================================================================
  console.log("\nJOURNEY 1 — four videos approved, one delivered; three still to send");
  const j1 = await mkJob("5642 Limeport Rd, Emmaus, PA");
  listings.set(j1.listingId, listing(40, 1)); // 40 photos out, ONE video on the listing
  const reel1 = await prisma.deliverable.create({
    data: { projectId: j1.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 4 },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: j1.id, type: "PHOTOS", label: "Professional Photography", quantity: 40 } });
  // The four per-video rows: all four APPROVED (the editor finished them all),
  // exactly one carrying a delivery stamp.
  for (let slot = 1; slot <= 4; slot++) {
    await prisma.deliverableOutput.create({
      data: {
        deliverableId: reel1.id, projectId: j1.id, slot, category: "VIDEO", title: `Reel ${slot}`,
        approvedAt: new Date(Date.now() - 1 * DAY),
        ...(slot === 1 ? { deliveredAt: new Date(Date.now() - 1 * DAY), deliveredVia: "aryeo-listing" } : {}),
      },
    });
  }

  console.log("\n  1a. THE ENGINE READS THE JOB (the real hourly pass, one project)");
  await syncProjectStatuses({ projectId: j1.id });
  const p1a = await proj(j1.id);
  const ev1 = parseEvidence(p1a.statusEvidence);
  say("engine status", p1a.status);
  say("evidence.missing (never made)", ev1?.missing ?? null);
  say("evidence.awaitingSend (made, not sent)", ev1?.awaitingSend ?? null);
  say("unit tally", ev1?.units ?? null);
  ok("the engine did read the listing", listingReads > 0, `${listingReads} read(s)`);
  ok("nothing reads as never-made — the editor finished all four", (ev1?.missing.length ?? -1) === 0, JSON.stringify(ev1?.missing));
  ok("the video lane is owed as a SEND, not as unmade work", (ev1?.awaitingSend ?? []).some((c) => /video/i.test(c)), JSON.stringify(ev1?.awaitingSend));
  const tally1 = (ev1?.units ?? []).find((u) => /video/i.test(u.category));
  ok("four owed, one with the client, four finished", tally1?.owed === 4 && tally1?.withClient === 1 && tally1?.finished === 4, JSON.stringify(tally1));
  ok("THREE named outputs are still to send", (tally1?.unresolvedKeys ?? []).length === 3, JSON.stringify(tally1?.unresolvedKeys));
  ok(
    "…and they are slots 2, 3 and 4 by name",
    ["2", "3", "4"].every((s) => (tally1?.unresolvedKeys ?? []).includes(`${reel1.id}:${s}`)),
    JSON.stringify(tally1?.unresolvedKeys),
  );
  ok("the engine did not call this delivered", p1a.status !== "DELIVERED", p1a.status);
  ok("…and stamped no delivery date", p1a.deliveredAt === null, String(p1a.deliveredAt));

  console.log("\n  1b. THE REAL ACTION — the Editing Room 'Completed' pill");
  const click1 = await setQueueStatus(j1.id, "Completed");
  say("pill answer", `${click1.ok ? "ACCEPTED" : "REFUSED"} — ${click1.message}`);
  ok("the pill is refused", !click1.ok, click1.message);
  ok("the refusal NAMES the count, not just 'the video'", /3 of 4 videos/.test(click1.message), click1.message);
  ok("…and says it is finished, not missing", /finished in our Dropbox/.test(click1.message), click1.message);
  ok("…and names the way forward", /Refresh from Aryeo/.test(click1.message), click1.message);
  const p1b = await proj(j1.id);
  ok("the job was NOT written DELIVERED", p1b.status !== "DELIVERED", p1b.status);
  ok("and no delivery date was stamped", p1b.deliveredAt === null, String(p1b.deliveredAt));

  console.log("\n  1c. NOW THE SWEEP — the real risk: does it release the text the gate refused?");
  const t1 = await deliveryTask(j1.id, "5642 Limeport Rd");
  const sweep1 = await sweepDeliveryTexts();
  const t1after = await taskOf(t1.id);
  say("sweep result", sweep1);
  say("what it wrote on the task", t1after.summary ?? "(nothing)");
  ok("NOTHING was sent", sweep1.sent === 0, JSON.stringify(sweep1));
  ok("the feedback ask is held, not completed", t1after.status !== "COMPLETED" && t1after.status !== "CANCELLED", t1after.status);
  ok("the hold names a reason, in words a person can act on", !!t1after.summary, t1after.summary ?? "");
  ok("no message was queued to any provider", (await sendsFor(j1.id)) === 0, `${await sendsFor(j1.id)} outbox rows`);
  ok("no outbound text was logged", (await commsOut()) === 0);
  ok("no network call was attempted", outbound.length === 0, outbound.join(", "));

  console.log("\n  1c'. THE DANGEROUS SHAPE — the job is written DELIVERED anyway");
  // The pill refuses, but the OWNER's documented board override does not (it is
  // deliberately the way past a wrong blob). That produces exactly the state the
  // audit found on live data: status DELIVERED, three videos finished and not on
  // the client's listing. This is where the sweep is the last gate standing.
  const j1o = await mkJob("453 Cardigan Terrace, Downingtown, PA");
  listings.set(j1o.listingId, listing(40, 1));
  const reelO = await prisma.deliverable.create({
    data: { projectId: j1o.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 4 }, select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: j1o.id, type: "PHOTOS", label: "Professional Photography", quantity: 40 } });
  for (let slot = 1; slot <= 4; slot++) {
    await prisma.deliverableOutput.create({
      data: {
        deliverableId: reelO.id, projectId: j1o.id, slot, category: "VIDEO", approvedAt: new Date(Date.now() - DAY),
        ...(slot === 1 ? { deliveredAt: new Date(Date.now() - DAY), deliveredVia: "aryeo-listing" } : {}),
      },
    });
  }
  await syncProjectStatuses({ projectId: j1o.id });
  const owedO = owedNow(parseEvidence((await proj(j1o.id)).statusEvidence));
  ok("three of four videos are owed on this one too", /3 of 4 videos/.test(owedPhrase(owedO)), owedPhrase(owedO));
  await moveProjectStatus(j1o.id, "DELIVERED");
  const p1o = await proj(j1o.id);
  const boardLine = (await prisma.activity.findMany({ where: { projectId: j1o.id }, select: { body: true } })).map((a) => a.body).join("\n");
  say("status after the board override", p1o.status);
  say("timeline", boardLine.split("\n").filter((l) => /Moved from/.test(l)).join(" | "));
  ok("the override goes through (it is meant to)", p1o.status === "DELIVERED", p1o.status);
  ok("…but the TIMELINE records what was still owed, with the count", /3 of 4 videos still missing on Aryeo/.test(boardLine), boardLine.slice(0, 200));
  const tO = await prisma.smartTask.findFirst({ where: { projectId: j1o.id, taskType: "delivery_text" }, select: { id: true } });
  ok("the delivered close-out minted the feedback ask", !!tO, "delivery_text");
  const sweepO = await sweepDeliveryTexts();
  const tOafter = await taskOf(tO!.id);
  say("sweep result", sweepO);
  say("hold", tOafter.summary ?? "(nothing)");
  ok("THE SWEEP REFUSES TO RELEASE THE TEXT", sweepO.sent === 0, JSON.stringify(sweepO));
  ok("…and holds on what is still owed, with the count", /still owed: 3 of 4 videos/.test(tOafter.summary ?? ""), tOafter.summary ?? "");
  ok("the feedback ask stays open for a person", !["COMPLETED", "CANCELLED"].includes(tOafter.status), tOafter.status);
  ok("nothing was handed to a provider for this job", (await sendsFor(j1o.id)) === 0, `${await sendsFor(j1o.id)} outbox rows`);
  await syncProjectStatuses({ projectId: j1o.id });
  const p1o2 = await proj(j1o.id);
  ok("the hourly engine leaves the owner's override alone", p1o2.status === "DELIVERED", p1o2.status);
  ok("…and does not re-stamp the date it just set", p1o2.deliveredAt?.getTime() === p1o.deliveredAt?.getTime(), String(p1o2.deliveredAt));
  const sweepO2 = await sweepDeliveryTexts();
  ok("a second sweep an hour later still refuses", sweepO2.sent === 0 && (await sendsFor(j1o.id)) === 0, JSON.stringify(sweepO2));

  console.log("\n  1c''. THE OTHER SEND PATH — the human 'Send' button on the same task");
  // app/actions.sendDeliveryText does NOT go through the outbox and carries no
  // owed gate of its own (its own file says so). It is a person's deliberate
  // send, so it is allowed to go — but the WORDING it renders is the thing the
  // audit's contract is actually about, and it must not read as a batch
  // completion to a client holding one of four reels.
  const sentBodies: string[] = [];
  const realSend = (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage;
  (opMod.OpenPhone as unknown as { sendMessage: (f: string, t: string, b: string) => Promise<unknown> }).sendMessage =
    async (_f: string, _t: string, b: string) => { sentBodies.push(b); return { data: { id: "drill-msg" } }; };
  const { sendDeliveryText } = await import("@/app/actions");
  const handSend = await sendDeliveryText(tO!.id);
  (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = realSend;
  say("button answer", `${handSend.ok ? "SENT" : "REFUSED"} — ${handSend.message}`);
  say("the words the client would read", sentBodies[0] ?? "(nothing sent)");
  const body1o = sentBodies[0] ?? "";
  ok("it does not tell the client everything has been delivered", !/Everything[\s\S]{0,40}has been delivered/i.test(body1o), body1o.slice(0, 120));
  ok("…it names the count still coming", /3 of 4 videos/.test(body1o), body1o);
  ok("…and it does not call a finished video 'in production'", !/in production/i.test(body1o), body1o);
  ok("…no em dash, no emoji, in Jordan's voice", !body1o.includes("—"), body1o);
  ok("still no network call", outbound.length === 0, outbound.join(", "));

  console.log("\n  1d. AND THE STATUS ENGINE AGAIN, AFTER THE REFUSAL");
  await syncProjectStatuses({ projectId: j1.id });
  const p1d = await proj(j1.id);
  say("status after the sweep", p1d.status);
  ok("the sweep did not promote the job to Delivered", p1d.status !== "DELIVERED", p1d.status);
  ok("deliveredAt is still unset", p1d.deliveredAt === null, String(p1d.deliveredAt));
  ok("the refusal still stands on a second click", !(await setQueueStatus(j1.id, "Completed")).ok);

  console.log("\n  1e. THE FOURTH VIDEO GOES OUT — the gate must then open");
  await prisma.deliverableOutput.updateMany({
    where: { projectId: j1.id, deliveredAt: null },
    data: { deliveredAt: new Date(), deliveredVia: "aryeo-listing" },
  });
  listings.set(j1.listingId, listing(40, 4, "DELIVERED"));
  await syncProjectStatuses({ projectId: j1.id });
  const p1e = await proj(j1.id);
  const gate1e = outstandingForDelivery(p1e.statusEvidence);
  say("status once everything is on the listing", p1e.status);
  say("gate", gate1e.categories);
  ok("nothing is owed any more", gate1e.categories.length === 0, JSON.stringify(gate1e.categories));
  ok("the job reads Delivered", p1e.status === "DELIVERED", p1e.status);
  ok("…and now carries a first delivery stamp", !!p1e.deliveredAt, String(p1e.deliveredAt));
  const FIRST_DELIVERY = p1e.deliveredAt!;

  console.log("\n  1f. THE SWEEP ON THE SAME JOB, NOW THAT IT REALLY IS OUT");
  const sweep1f = await sweepDeliveryTexts();
  const t1f = await taskOf(t1.id);
  say("sweep result", sweep1f);
  say("task", `${t1f.status} — ${t1f.summary ?? ""}`);
  // The provider is not connected in here, so the send can only be refused at
  // the provider seam. What this proves is that the GATE stopped holding it.
  ok("the sweep no longer holds it on 'still owed'", !/still owed/.test(t1f.summary ?? ""), t1f.summary ?? "");
  ok("still nothing left the machine", outbound.length === 0, outbound.join(", "));

  // =======================================================================
  // JOURNEY 2 — a delivered job takes a second shoot.
  // =======================================================================
  console.log("\nJOURNEY 2 — a delivered job takes an add-on (a second shoot)");
  say("the job's first delivery", FIRST_DELIVERY.toISOString());
  const outputsBefore = await prisma.deliverableOutput.findMany({
    where: { projectId: j1.id }, select: { id: true, slot: true, deliveredAt: true }, orderBy: { slot: "asc" },
  });
  const shotOn = new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
  const addon = await reopenForAdditionalShoot(j1.id, { type: "SOCIAL_REEL", shotOn, note: "Agent asked for a twilight reel" });
  say("portal answer", `${addon.ok ? "ACCEPTED" : "REFUSED"} — ${addon.message}`);
  ok("the extra shoot is accepted on a delivered job", addon.ok, addon.message);
  const p2 = await proj(j1.id);
  ok("THE ORIGINAL DELIVERY DATE IS UNTOUCHED", p2.deliveredAt?.getTime() === FIRST_DELIVERY.getTime(), String(p2.deliveredAt));
  ok("the job is not dragged back out of Delivered", p2.status === "DELIVERED", p2.status);
  const outputsAfter = await prisma.deliverableOutput.findMany({
    where: { id: { in: outputsBefore.map((o) => o.id) } }, select: { id: true, deliveredAt: true },
  });
  ok(
    "every original video keeps its own delivery stamp",
    outputsBefore.every((b) => outputsAfter.find((a) => a.id === b.id)?.deliveredAt?.getTime() === b.deliveredAt?.getTime()),
  );
  const extraRow = await prisma.deliverable.findFirstOrThrow({
    where: { projectId: j1.id, manual: true, capturedAt: { not: null } },
    select: { id: true, label: true, capturedAt: true },
  });
  const extraSlots = await prisma.deliverableOutput.findMany({
    where: { deliverableId: extraRow.id }, select: { slot: true, promisedAt: true, promiseSource: true, promiseAnchorAt: true },
  });
  say("the new row", `${extraRow.label} (captured ${extraRow.capturedAt?.toISOString()})`);
  say("its slots", extraSlots);
  ok("the new obligation exists as its own row", !!extraRow.id);
  ok("…and as its own owed video slot", extraSlots.length === 1, JSON.stringify(extraSlots));
  ok("IT CARRIES ITS OWN DEADLINE", !!extraSlots[0]?.promisedAt, String(extraSlots[0]?.promisedAt));
  ok("…dated from the day it was shot, not the job's old shoot", extraSlots[0]?.promiseSource === "additional-shoot", extraSlots[0]?.promiseSource ?? "");
  ok(
    "…and that deadline is in the FUTURE — a video shot today is not born late",
    (extraSlots[0]?.promisedAt?.getTime() ?? 0) > Date.now(),
    String(extraSlots[0]?.promisedAt),
  );
  const q2 = await buildEditorQueue();
  ok(
    "the delivered job is BACK in front of an editor (not buried in Done)",
    q2.notDone.some((r) => r.id === j1.id),
    `notDone=${q2.notDone.length} done=${q2.done.length}`,
  );

  console.log("\n  2b. …AND THE SWEEPS RUN OVER IT");
  await syncProjectStatuses({ projectId: j1.id });
  const sweep2 = await sweepDeliveryTexts();
  const p2b = await proj(j1.id);
  say("sweep result", sweep2);
  say("status / delivered", `${p2b.status} / ${p2b.deliveredAt?.toISOString()}`);
  ok("THE FIRST DELIVERY STAMP STILL STANDS", p2b.deliveredAt?.getTime() === FIRST_DELIVERY.getTime(), String(p2b.deliveredAt));
  const extraAfter = await prisma.deliverableOutput.findFirstOrThrow({ where: { deliverableId: extraRow.id }, select: { promisedAt: true } });
  ok(
    "the extra video's own deadline survives the sweep",
    extraAfter.promisedAt?.getTime() === extraSlots[0]?.promisedAt?.getTime(),
    String(extraAfter.promisedAt),
  );
  const q2b = await buildEditorQueue();
  ok("it is still on the editor's board an hour later", q2b.notDone.some((r) => r.id === j1.id));
  ok("nothing left the machine", outbound.length === 0, outbound.join(", "));
  // What the add-on does to the FIRST delivery's outstanding feedback ask.
  const ev2b = parseEvidence(p2b.statusEvidence);
  const t1b = await taskOf(t1.id);
  say("the job's owed list after the add-on", owedNow(ev2b).categories);
  say("the first delivery's feedback ask", `${t1b.status} — ${t1b.summary ?? ""}`);
  ok("the add-on re-opens an obligation the whole-job gate can see", owedNow(ev2b).categories.length > 0, JSON.stringify(owedNow(ev2b).categories));
  ok("…so the feedback ask is held rather than sent mid-add-on", sweep2.sent === 0, JSON.stringify(sweep2));

  // =======================================================================
  // JOURNEY 3 — photo and video revisions open at once.
  // =======================================================================
  console.log("\nJOURNEY 3 — a photo revision and a video revision on one job");
  const j3 = await mkJob("1337 Carolannes Way, West Chester, PA", {
    status: "DELIVERED", deliveredAt: new Date(Date.now() - 9 * DAY), deliveredBy: "Kyle Pierce", deliveredVia: "office-hand",
  });
  const J3_FIRST = (await proj(j3.id)).deliveredAt!;
  listings.set(j3.listingId, listing(35, 1, "DELIVERED"));
  await prisma.deliverable.create({ data: { projectId: j3.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 } });
  await prisma.deliverable.create({ data: { projectId: j3.id, type: "PHOTOS", label: "Professional Photography", quantity: 35 } });
  await ensureOutputsSafely(j3.id, "drill-journey-3");
  await prisma.deliverableOutput.updateMany({
    where: { projectId: j3.id }, data: { approvedAt: new Date(Date.now() - 9 * DAY), deliveredAt: new Date(Date.now() - 9 * DAY), deliveredVia: "aryeo-listing" },
  });
  const flag3 = await prisma.imageFlag.create({
    data: { projectId: j3.id, imageUrl: "https://example.invalid/front-lawn.jpg", tags: "[]", note: "front lawn too dark", status: "OPEN" },
    select: { id: true },
  });
  await prisma.smartTask.create({
    data: { projectId: j3.id, taskType: "media_qa", title: "Re-QC — 1337 Carolannes Way", dedupeKey: `media-qa-${j3.id}`, status: "OPEN", source: "hub", assignedKey: "kyle" },
  });
  await raiseRevision({
    projectId: j3.id, clientId: client.id, propertyAddress: "1337 Carolannes Way",
    note: "Can you please remove the walk-out basement clip from the video and re-edit the reel? The music is also too loud.",
    source: "gmail",
  });
  await raiseRevision({
    projectId: j3.id, clientId: client.id, propertyAddress: "1337 Carolannes Way",
    note: "The front lawn photo is way too dark and the kitchen photos need retouching. Please re-edit those pictures.",
    source: "gmail",
  });
  const lanes = await prisma.smartTask.findMany({
    where: { projectId: j3.id, taskType: "revision" }, select: { id: true, title: true, status: true, assignedKey: true },
  });
  say("lanes raised", lanes.map((l) => `${l.title.split("—")[0].trim()} → ${l.assignedKey}`));
  const videoLane = lanes.find((l) => /video/i.test(l.title));
  const photoLane = lanes.find((l) => /photo/i.test(l.title));
  ok("both lanes exist as separate asks", !!videoLane && !!photoLane && videoLane.id !== photoLane.id, `${lanes.length} rows`);
  ok("the job is in Revisions", (await proj(j3.id)).status === "REVISION");

  console.log("\n  3b. THE REAL ACTION — the editor completes the VIDEO ask only");
  await setSmartTaskStatus(videoLane!.id, "COMPLETED");
  const after3 = await prisma.smartTask.findMany({ where: { projectId: j3.id, taskType: "revision" }, select: { id: true, status: true, title: true } });
  say("lanes after", after3.map((l) => `${/photo/i.test(l.title) ? "photo" : "video"}=${l.status}`));
  ok("the video ask is closed", after3.find((l) => l.id === videoLane!.id)?.status === "COMPLETED");
  ok("THE PHOTO LANE IS STILL OPEN", !["COMPLETED", "CANCELLED"].includes(after3.find((l) => l.id === photoLane!.id)?.status ?? ""), after3.find((l) => l.id === photoLane!.id)?.status ?? "");
  const p3b = await proj(j3.id);
  ok("the job stays in Revisions", p3b.status === "REVISION", p3b.status);
  ok("the revision stamp is not cleared", !!p3b.revisionRequestedAt);
  ok("the open image flag was not swept FIXED", (await prisma.imageFlag.findUniqueOrThrow({ where: { id: flag3.id }, select: { status: true } })).status === "OPEN");
  ok("the re-QC card is still open", (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `media-qa-${j3.id}` }, select: { status: true } })).status === "OPEN");
  ok("the ORIGINAL delivery date is untouched", p3b.deliveredAt?.getTime() === J3_FIRST.getTime(), String(p3b.deliveredAt));

  console.log("\n  3c. THE SWEEPS RUN — the lane must not close itself an hour later");
  await syncProjectStatuses({ projectId: j3.id });
  const sweep3 = await sweepDeliveryTexts();
  const p3c = await proj(j3.id);
  say("sweep notes", sweep3.notes);
  ok("the photo lane is STILL open after the sweep", !["COMPLETED", "CANCELLED"].includes((await prisma.smartTask.findUniqueOrThrow({ where: { id: photoLane!.id }, select: { status: true } })).status));
  ok("the job is still in Revisions after the sweep", p3c.status === "REVISION", p3c.status);
  ok("the sweep did not re-stamp the delivery", p3c.deliveredAt?.getTime() === J3_FIRST.getTime(), String(p3c.deliveredAt));
  ok("nothing was sent to a client mid-revision", sweep3.sent === 0);

  console.log("\n  3d. THE LAST LANE CLOSES — the whole resolve runs, and the stamp still stands");
  await setSmartTaskStatus(photoLane!.id, "COMPLETED");
  const p3d = await proj(j3.id);
  say("status / delivered", `${p3d.status} / ${p3d.deliveredAt?.toISOString()}`);
  ok("the revision stamp is cleared", !p3d.revisionRequestedAt, String(p3d.revisionRequestedAt));
  ok("the job lands back on Delivered", p3d.status === "DELIVERED", p3d.status);
  ok("AND KEEPS ITS ORIGINAL DELIVERY DATE", p3d.deliveredAt?.getTime() === J3_FIRST.getTime(), String(p3d.deliveredAt));

  // =======================================================================
  // JOURNEY 4 — the historical stamp, through every re-delivery path.
  // =======================================================================
  console.log("\nJOURNEY 4 — a first-delivery stamp survives every later 'done'");
  const j4 = await mkJob("1023 Sycamore Mills Rd, Media, PA", {
    status: "DELIVERED", deliveredAt: new Date(Date.now() - 41 * DAY), deliveredBy: "Kyle Pierce", deliveredVia: "office-hand",
  });
  const J4_FIRST = (await proj(j4.id)).deliveredAt!;
  listings.set(j4.listingId, listing(30, 1, "DELIVERED"));
  await prisma.deliverable.create({ data: { projectId: j4.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 } });
  await prisma.deliverable.create({ data: { projectId: j4.id, type: "PHOTOS", label: "Professional Photography", quantity: 30 } });
  await ensureOutputsSafely(j4.id, "drill-journey-4");
  await prisma.deliverableOutput.updateMany({
    where: { projectId: j4.id }, data: { approvedAt: new Date(Date.now() - 41 * DAY), deliveredAt: new Date(Date.now() - 41 * DAY), deliveredVia: "aryeo-listing" },
  });
  say("delivered on", J4_FIRST.toISOString());

  // (a) a revision arrives and is resolved from the project page's whole-job button
  await raiseRevision({
    projectId: j4.id, clientId: client.id, propertyAddress: "1023 Sycamore Mills Rd",
    note: "Could you re-edit the reel? The intro is too long.", source: "openphone",
  });
  ok("the ask reopens the job", (await proj(j4.id)).status === "REVISION");
  ok("…without moving the delivery date", (await proj(j4.id)).deliveredAt?.getTime() === J4_FIRST.getTime());
  const { resolveRevision } = await import("@/lib/comms");
  await resolveRevision(j4.id);
  const p4a = await proj(j4.id);
  say("after resolveRevision", `${p4a.status} / ${p4a.deliveredAt?.toISOString()}`);
  ok("a resolved revision does not re-stamp the delivery", p4a.deliveredAt?.getTime() === J4_FIRST.getTime(), String(p4a.deliveredAt));

  // (b) the board override — moveProjectStatus, the path delivery.ts flagged as
  //     "STILL TO ADOPT" until Sep 20.
  await prisma.project.update({ where: { id: j4.id }, data: { status: "REVIEW" } });
  await moveProjectStatus(j4.id, "DELIVERED");
  const p4b = await proj(j4.id);
  say("after the board move to Delivered", `${p4b.status} / ${p4b.deliveredAt?.toISOString()}`);
  ok("the BOARD move keeps the original date", p4b.deliveredAt?.getTime() === J4_FIRST.getTime(), String(p4b.deliveredAt));

  // (c) the queue pill's Completed on an already-delivered job
  await prisma.project.update({ where: { id: j4.id }, data: { status: "REVIEW" } });
  const click4 = await setQueueStatus(j4.id, "Completed");
  const p4c = await proj(j4.id);
  say("after the queue pill", `${click4.ok ? "ACCEPTED" : "REFUSED"} — ${p4c.status} / ${p4c.deliveredAt?.toISOString()}`);
  ok("the pill is accepted (nothing is owed)", click4.ok, click4.message);
  ok("the QUEUE PILL keeps the original date", p4c.deliveredAt?.getTime() === J4_FIRST.getTime(), String(p4c.deliveredAt));

  // (d) and the background engines on top of all three
  await syncProjectStatuses({ projectId: j4.id });
  await sweepDeliveryTexts();
  const p4d = await proj(j4.id);
  say("after both sweeps", `${p4d.status} / ${p4d.deliveredAt?.toISOString()}`);
  ok("THE STAMP IS STILL THE ORIGINAL, 41 DAYS OLD", p4d.deliveredAt?.getTime() === J4_FIRST.getTime(), String(p4d.deliveredAt));
  ok("…and the actor on it was not overwritten by the machine", p4d.deliveredBy === "Kyle Pierce", `${p4d.deliveredBy} / ${p4d.deliveredVia}`);

  // =======================================================================
  // JOURNEY 5 — unreadable evidence vs a legitimate manual job.
  // =======================================================================
  console.log("\nJOURNEY 5 — unreadable evidence is a question, not a conclusion");
  const j5 = await mkJob("9 Unknowable Way, Malvern, PA", { status: "DELIVERED", deliveredAt: new Date(Date.now() - 2 * DAY) });
  listings.set(j5.listingId, listing(0, 0));
  await prisma.deliverable.create({ data: { projectId: j5.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 } });
  await prisma.project.update({ where: { id: j5.id }, data: { statusEvidence: "{not json" } });
  const p5 = await proj(j5.id);
  const gate5 = outstandingForDelivery(p5.statusEvidence);
  say("gate on unreadable evidence", gate5.categories);
  say("the card's flag", statusFlag(p5.status, p5.statusEvidence));
  ok("the gate refuses NOTHING off ignorance", gate5.categories.length === 0, JSON.stringify(gate5.categories));
  ok("…and the refusal sentence would not be built out of 'undefined'", outstandingMessage(gate5) === "Everything ordered has landed.", outstandingMessage(gate5));
  ok("the card does not claim a delivery it cannot see", statusFlag(p5.status, p5.statusEvidence) === null || statusFlag(p5.status, p5.statusEvidence)!.kind === "unknown", JSON.stringify(statusFlag(p5.status, p5.statusEvidence)));

  console.log("\n  5b. THE AUTOMATED SEND MUST NOT CONCLUDE FROM IT");
  const t5 = await deliveryTask(j5.id, "9 Unknowable Way");
  const sweep5 = await sweepDeliveryTexts();
  const t5after = await taskOf(t5.id);
  say("sweep result", sweep5);
  say("hold", t5after.summary ?? "(nothing)");
  ok("nothing was auto-sent on unreadable evidence", sweep5.sent === 0, JSON.stringify(sweep5));
  ok("the task is HELD for a person, not completed", !["COMPLETED", "CANCELLED"].includes(t5after.status), t5after.status);
  ok("…and the hold says it is a verification job for a human", /no delivery evidence[\s\S]*by hand/.test(t5after.summary ?? ""), t5after.summary ?? "");
  ok("still nothing left the machine", outbound.length === 0, outbound.join(", "));

  console.log("\n  5b'. EVIDENCE THE HUB ITSELF CANNOT ACCOUNT FOR");
  // The anonymous-count case the blob has a word for. Four videos owed, four
  // finished, and the LISTING says four are up — but only ONE carries a named
  // delivery stamp, so three of the four on that listing are not matched to
  // anything ordered (four exports of one cut look identical from here). The
  // blob records that as `unmatched`. The question this asks is whether the
  // card and the automated send agree about what it means.
  // Its own client: the sweep sends at most one text per client per tick, so a
  // job sharing Gary would simply queue behind another journey's row and prove
  // nothing about this gate.
  const gayClient = await prisma.client.create({ data: { name: "Dana Reese", phone: "+16105550177", autoDeliveryText: true }, select: { id: true } });
  const j5u = await mkJob("38 E Gay St, West Chester, PA", { clientId: gayClient.id });
  listings.set(j5u.listingId, listing(40, 4, "DELIVERED"));
  const reelU = await prisma.deliverable.create({
    data: { projectId: j5u.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 4 }, select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: j5u.id, type: "PHOTOS", label: "Professional Photography", quantity: 40 } });
  for (let slot = 1; slot <= 4; slot++) {
    await prisma.deliverableOutput.create({
      data: {
        deliverableId: reelU.id, projectId: j5u.id, slot, category: "VIDEO", approvedAt: new Date(Date.now() - DAY),
        ...(slot === 1 ? { deliveredAt: new Date(Date.now() - DAY), deliveredVia: "aryeo-listing" } : {}),
      },
    });
  }
  await syncProjectStatuses({ projectId: j5u.id });
  const p5u = await proj(j5u.id);
  const ev5u = parseEvidence(p5u.statusEvidence);
  const tally5u = (ev5u?.units ?? []).find((u) => /video/i.test(u.category));
  const flag5u = statusFlag(p5u.status, p5u.statusEvidence);
  const gate5u = outstandingForDelivery(p5u.statusEvidence);
  say("unit tally", tally5u);
  say("the card's flag", flag5u);
  say("the delivery gate", gate5u.categories);
  ok("the blob records that three deliveries are unaccounted for", (tally5u?.unmatched ?? 0) === 3, JSON.stringify(tally5u?.unmatched));
  ok("THE CARD treats it as something to verify", !!flag5u && /not matched/i.test(flag5u.label), JSON.stringify(flag5u));
  const t5u = (await prisma.smartTask.findFirst({ where: { projectId: j5u.id, taskType: "delivery_text" }, select: { id: true } }))
    ?? (await deliveryTask2(j5u.id, "38 E Gay St", gayClient.id));
  const bodies5u: string[] = [];
  const realSend2 = (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage;
  (opMod.OpenPhone as unknown as { sendMessage: (f: string, t: string, b: string) => Promise<unknown> }).sendMessage =
    async (_f: string, _t: string, b: string) => { bodies5u.push(b); return { data: { id: `drill-msg-${bodies5u.length}` } }; };
  stubbedSends.push(0);
  const sweep5u = await sweepDeliveryTexts();
  (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = realSend2;
  const t5uAfter = await taskOf(t5u.id);
  const body5u = bodies5u.find((b) => /Gay St/.test(b));
  say("sweep result", sweep5u);
  say("this job's feedback ask", `${t5uAfter.status} — ${t5uAfter.summary ?? ""}`);
  say("what THIS client was told", body5u ?? "(this job sent nothing)");
  ok("the sweep did reach this job", !!body5u || !!t5uAfter.summary, `${bodies5u.length} body(ies)`);
  // FAILS TODAY, AND IT IS THE FINDING. owedNow() computes `unmatchedUnits` and
  // the card spends it — "Confirmed by count, not by name … open the listing
  // before telling a client it is all there". The auto-send gate
  // (clientTextSweeps.ts:1035) reads only `owed.categories` off the same
  // object, so it does the one thing the card just said not to do: it texts
  // the wrap-up feedback ask on a job where three of four deliveries are
  // tied to nothing. Live on Sep 20: 5 jobs carry an unmatched tally, the gate
  // passes on 4 of them, 3 already read DELIVERED (617 Westbourne Rd,
  // 207 S 5 Points Rd, 38 E Gay St — the last with 4 of 4 unmatched).
  ok(
    "THE AUTOMATED SEND must not conclude what the card says to go and check",
    !body5u || !/wrapped up|has been delivered/i.test(body5u),
    body5u ?? "",
  );
  // Held, not silently dropped: the row stays a person's job and the hold says
  // the same thing the card says, in the numbers this job actually has.
  ok(
    "…the ask is HELD for a person, in the card's own words",
    !["COMPLETED", "CANCELLED"].includes(t5uAfter.status)
      && /4 videos/.test(t5uAfter.summary ?? "")
      && /only 1 of them is tied to a video the hub tracks/.test(t5uAfter.summary ?? "")
      && /by hand/.test(t5uAfter.summary ?? ""),
    `${t5uAfter.status} — ${t5uAfter.summary ?? ""}`,
  );
  ok("…and nothing was queued to any provider for this job", (await sendsFor(j5u.id)) === 0, String(await sendsFor(j5u.id)));

  console.log("\n  5b''. AND THE OTHER SIDE OF THAT GATE — ONE ORDERED, ONE ON THE LISTING");
  // THE BOUNDARY, NOT THE HAPPY CASE (review, Sep 20). 5b' only ever built the
  // ambiguous shape. The shape production actually has is this one: a single
  // cut ordered, a single video on the listing, and no per-video delivery stamp
  // — because the hub writes that stamp on nine of 924 output rows, so
  // `unmatched` = min(owed, listed) − named = 1 on a job where nothing can be
  // confused with anything. 617 Westbourne Rd and 207 S 5 Points Rd read
  // exactly this on Sep 20 and both had their feedback ask sent automatically
  // and correctly (Sep 14, Sep 16). A gate that held them would have closed
  // both unsent at seven days. This fixture pins that boundary, so the next
  // person to widen the hold has to break a check to do it.
  const soloClient = await prisma.client.create({ data: { name: "Gary Mercer Sr", phone: "+16105550188", autoDeliveryText: true }, select: { id: true } });
  const j5s = await mkJob("617 Westbourne Rd, West Chester, PA", { clientId: soloClient.id });
  listings.set(j5s.listingId, listing(40, 1, "DELIVERED"));
  const reelS = await prisma.deliverable.create({
    data: { projectId: j5s.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 }, select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: j5s.id, type: "PHOTOS", label: "Professional Photography", quantity: 40 } });
  // Approved, never stamped — the ordinary case, not a broken one.
  await prisma.deliverableOutput.create({
    data: { deliverableId: reelS.id, projectId: j5s.id, slot: 1, category: "VIDEO", approvedAt: new Date(Date.now() - DAY) },
  });
  await syncProjectStatuses({ projectId: j5s.id });
  const p5s = await proj(j5s.id);
  const ev5s = parseEvidence(p5s.statusEvidence);
  const tally5s = (ev5s?.units ?? []).find((u) => /video/i.test(u.category));
  say("unit tally", tally5s);
  say("engine status", p5s.status);
  ok("the blob scores it unmatched, exactly as production does", (tally5s?.unmatched ?? 0) === 1, JSON.stringify(tally5s));
  ok("…off ONE ordered and ONE on the listing, with no stamp", tally5s?.owed === 1 && tally5s?.onListing === 1 && (tally5s?.named ?? 0) === 0, JSON.stringify(tally5s));
  ok("the job reads delivered", p5s.status === "DELIVERED", p5s.status);
  const t5s = (await prisma.smartTask.findFirst({ where: { projectId: j5s.id, taskType: "delivery_text" }, select: { id: true } }))
    ?? (await deliveryTask2(j5s.id, "617 Westbourne Rd", soloClient.id));
  const bodies5s: string[] = [];
  const realSend3 = (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage;
  (opMod.OpenPhone as unknown as { sendMessage: (f: string, t: string, b: string) => Promise<unknown> }).sendMessage =
    async (_f: string, _t: string, b: string) => { bodies5s.push(b); return { data: { id: `drill-solo-${bodies5s.length}` } }; };
  const sweep5s = await sweepDeliveryTexts();
  (opMod.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = realSend3;
  const t5sAfter = await taskOf(t5s.id);
  const body5s = bodies5s.find((b) => /Westbourne/.test(b));
  say("sweep result", sweep5s);
  say("this job's feedback ask", `${t5sAfter.status} — ${t5sAfter.summary ?? ""}`);
  say("what THIS client was told", body5s ?? "(this job sent nothing)");
  ok("THE FEEDBACK ASK STILL GOES OUT — there is no second video to confuse it with", !!body5s, `${bodies5s.length} body(ies): ${bodies5s.join(" | ")}`);
  ok("…and the row closes as sent, not held", t5sAfter.status === "COMPLETED", `${t5sAfter.status} — ${t5sAfter.summary ?? ""}`);
  ok("…and the unmatched hold sentence was never written onto it", !/tied to a video the hub tracks/.test(t5sAfter.summary ?? ""), t5sAfter.summary ?? "");
  ok("the AMBIGUOUS job next door is still held by the same pass", !["COMPLETED", "CANCELLED"].includes((await taskOf(t5u.id)).status), (await taskOf(t5u.id)).status);

  console.log("\n  5c. AND A LEGITIMATE MANUAL JOB KEEPS AN EXPLICIT COMPLETION ROUTE");
  const j5m = await prisma.project.create({
    data: {
      title: "12 Handshake Ln, Paoli, PA", clientId: client.id, source: "MANUAL", status: "EDITING",
      shootDate: new Date(Date.now() - 3 * DAY), photographerId: shooter.id, price: 400, payableInvoice: 400,
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: j5m.id, type: "SOCIAL_REEL", label: "Video — added manually", quantity: 1, manual: true } });
  const manualGate = outstandingForDelivery((await proj(j5m.id)).statusEvidence);
  say("evidence on a manual job", (await proj(j5m.id)).statusEvidence);
  ok("a manual job carries no evidence at all", (await proj(j5m.id)).statusEvidence === null);
  ok("…so the gate blocks nothing", manualGate.categories.length === 0);
  const click5 = await setQueueStatus(j5m.id, "Completed");
  const p5m = await proj(j5m.id);
  say("pill on the manual job", `${click5.ok ? "ACCEPTED" : "REFUSED"} — ${click5.message}`);
  ok("the office CAN still complete it by hand", click5.ok, click5.message);
  ok("and it lands on Delivered with a first stamp", p5m.status === "DELIVERED" && !!p5m.deliveredAt, `${p5m.status} / ${p5m.deliveredAt}`);
  const MANUAL_FIRST = p5m.deliveredAt!;
  await setQueueStatus(j5m.id, "Completed");
  ok("a second click does not move the stamp", (await proj(j5m.id)).deliveredAt?.getTime() === MANUAL_FIRST.getTime());
  await moveProjectStatus(j5m.id, "DELIVERED");
  ok("nor does the board override", (await proj(j5m.id)).deliveredAt?.getTime() === MANUAL_FIRST.getTime());

  // -----------------------------------------------------------------------
  console.log("\nTHE FENCE");
  // Outbox rows DO exist here: the jobs that genuinely finished (journeys 1f, 3d
  // and 4) reached the send and were refused at the provider seam, because no
  // OpenPhone secret exists in this database. What must be zero is anything
  // ACCEPTED, and any row at all on a job a gate was supposed to hold.
  say("outbox rows in total", await sends());
  ok("no outbound HTTP call was attempted in the whole run", outbound.length === 0, outbound.join(", "));
  // The only accepted rows are the ones this drill's own recording stub took,
  // in the two places it deliberately captured the WORDS a client would read.
  say("accepted rows (all captured by the drill's recording stub)", await accepted());
  // Three, since Sep 20: the boundary fixture at 5b'' is a send that MUST
  // happen, and its stub takes the third row.
  ok("nothing reached a real provider", (await accepted()) <= 3, `${await accepted()} accepted, stub captured ${sentBodies.length + bodies5u.length + bodies5s.length}`);
  ok("no row was ever queued for a job the gate was holding", (await sendsFor(j1o.id)) === 0 && (await sendsFor(j5.id)) === 0);

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

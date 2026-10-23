// Oct 23 2026: KYLE'S DESK, the office dashboard rebuilt to Jordan's spec of
// that day (lib/officeDesk). Held here against the spec's acceptance checks
// that belong to the dashboard (#8, renewed acknowledgment of a changed brief,
// is the briefing build's):
//   1  a new photo set enters QC; a failed check becomes a tracked correction
//   2  a new asset version goes back to review (the right reviewer), not done
//   3  an approved video is Kyle's to send, never his to approve
//   4  a failed notification is never a successful delivery
//   5  a partial delivery leaves the remaining assets open
//   6  replying to a revision request keeps the revision open
//   7  waiting items come back when their follow-up is due
//   9  Friday's preparation includes Monday (and the next business day past a holiday)
//  10  every count is the length of the list it opens
//  11  routine actions happen on the page (the server actions round-trip; the
//      owner's preview stays read-only)
// plus the spec's named complaints (Alex's delivered-photo change, the Cliff
// Ln split order, figures, the semantics words). Disposable PGlite; the video
// board is driven through its contract; Slack is faked; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { DeskItem, OfficeDesk } from "../../src/lib/officeDesk";

installNextStubs();

const slack: { channel: string; text: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "chat.postMessage") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.open") return json({ ok: true, channel: { id: "D-DRILL" } });
  return json({ ok: true });
});

type Lanes = { late: VideoRow[]; today: VideoRow[]; review: VideoRow[]; upcoming: VideoRow[]; sending: VideoRow[]; held: VideoRow[]; finishing: VideoRow[]; delivered: VideoRow[] };
let videoLanes: Lanes | null = null;
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return {
    ...m,
    videoDeliveryBoard: (o?: Parameters<typeof m.videoDeliveryBoard>[0]) => (videoLanes ? Promise.resolve({ asOf: new Date().toISOString(), lanes: videoLanes, counts: {}, mode: "live", connected: true } as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>>) : m.videoDeliveryBoard(o)),
  };
});
let queueFails = false;
interceptModule((r) => r === "@/app/ops/photo-delivery/data" || /src[\\/]app[\\/]ops[\\/]photo-delivery[\\/]data(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/app/ops/photo-delivery/data");
  return { ...m, loadQueue: (o?: Parameters<typeof m.loadQueue>[0]) => (queueFails ? Promise.reject(new Error("drill: photo queue down")) : m.loadQueue(o)) };
});

const H = 3_600_000;
const D = 24 * H;
const EM_DASH = /—/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5931), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-kyle-desk" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const desk = await import("@/lib/officeDesk");
    const actions = await import("@/app/deskActions");
    const { listAssignees } = await import("@/lib/assignees");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    const { companyHolidayName } = await import("@/lib/paySavings");
    const { isValidElement } = await import("react");
    void isValidElement;

    const real = new Date();
    const todayKey = etDayKey(real);
    // Every fixture hangs off 11 AM ET today, so the drill reads the same at
    // 7 AM and at 11 PM (the Oct 19 drill's late-evening failure was a
    // fixture "an hour from now" running past midnight).
    const T = etAt(todayKey, 11);
    const at = (ms: number) => new Date(T.getTime() + ms);
    const keyPlus = (k: string, n: number) => new Date(Date.parse(`${k}T12:00:00Z`) + n * D).toISOString().slice(0, 10);

    // =====================================================================
    c.head("§0 · the pure rules");
    // =====================================================================
    const dow = (k: string) => new Date(`${k}T12:00:00Z`).getUTCDay();
    let fridayKey = todayKey;
    while (dow(fridayKey) !== 5) fridayKey = keyPlus(fridayKey, -1);
    const mondayKey = keyPlus(fridayKey, 3);
    const thursdayKey = keyPlus(fridayKey, -1);
    c.ok("#9 Friday's prep runs through Monday (Saturday and Sunday on the way)", JSON.stringify(desk.prepDayKeys(etAt(fridayKey, 11))) === JSON.stringify([fridayKey, keyPlus(fridayKey, 1), keyPlus(fridayKey, 2), mondayKey]), JSON.stringify(desk.prepDayKeys(etAt(fridayKey, 11))));
    c.ok("…Thursday's is Thursday and Friday; Monday's next business day is Tuesday", JSON.stringify(desk.prepDayKeys(etAt(thursdayKey, 11))) === JSON.stringify([thursdayKey, fridayKey]) && desk.nextBusinessDayKey(etAt(mondayKey, 11)) === keyPlus(mondayKey, 1));
    const xmasHoliday = !!companyHolidayName("2026-12-25");
    c.ok("…and a company holiday is skipped (Thu Dec 24 2026 prepares through Mon Dec 28 when Dec 25 is a holiday)", !xmasHoliday || desk.nextBusinessDayKey(etAt("2026-12-24", 11), (k) => !!companyHolidayName(k)) === "2026-12-28", String(xmasHoliday));
    c.ok("conflicts: a split order's scope note, drone vs no drone, two codes", desk.visitConflicts({ services: [], requests: [], orderNotes: ["Split appointment! Exteriors only."], lockbox: null, liveVisits: 3 }).length === 1
      && desk.visitConflicts({ services: ["Drone Photos"], requests: ["Please no drone, HOA rules"], orderNotes: [], lockbox: null, liveVisits: 1 })[0]?.startsWith("Drone is on this visit") === true
      && desk.visitConflicts({ services: [], requests: ["New lockbox code 5678"], orderNotes: [], lockbox: "1234", liveVisits: 1 })[0]?.includes("1234") === true
      && desk.visitConflicts({ services: ["Photos"], requests: ["Lockbox code 1234"], orderNotes: ["Exteriors only"], lockbox: "1234", liveVisits: 1 }).length === 0);
    c.ok("freshness says stale and failed in words, never zero", desk.freshnessOf({ lastRunAt: at(-3 * H).toISOString(), lastOk: true, stale: true, neverRecorded: false }, "Email", "gmail", T).state === "stale"
      && desk.freshnessOf({ lastRunAt: at(-4 * 60_000).toISOString(), lastOk: false, stale: false, neverRecorded: false }, "Photos", "photo-delivery", T).words === "last sync failed 4 min ago"
      && desk.freshnessOf(null, "Aryeo", "aryeo", T).state === "unknown");

    // =====================================================================
    c.head("§1 · the world");
    // =====================================================================
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const client = (name: string, phone?: string) => prisma.client.create({ data: { name, phone } });
    const realC = await client("Real Agent", "2155550101");
    const alex = await client("Alex Agent", "2155550102");
    const green = await client("Greenridge Client", "2155550103");
    const fixture = await client("Avery TEST");
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@oct23.invalid`, slackId: `U-${name.split(" ")[0].toUpperCase()}`, ...extra } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    const harrison = await tm("Harrison Shoots", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId?: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    await user("James Livingston", jamesTm.email!, "ADMIN", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const roster = await listAssignees();
    const person = { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" };
    const build = (now: Date = T, ex: string[] = [fixture.id]) => desk.buildOfficeDesk({ now, excludeClientIds: ex, person, roster });

    const project = (title: string, status: string, extra: Record<string, unknown> = {}, clientId = realC.id) =>
      prisma.project.create({ data: { clientId, title, status: status as never, addressLine: title.split(",")[0], ...extra } });
    const photoJob = (projectId: string, stage: string, extra: Record<string, unknown> = {}) => prisma.photoJob.create({ data: { projectId, stage, ...extra } });

    // Photos
    const pReady = await project("11 Ready Rd, Town", "SHOT", { shootDate: at(-D) });
    const jReady = await photoJob(pReady.id, "READY", { slaDueAt: at(3 * H) });
    const pLate = await project("12 Late Ln, Town", "SHOT", { shootDate: at(-2 * D) });
    await photoJob(pLate.id, "EDITING", { slaDueAt: at(-2 * H) });
    const pCheck = await project("13 Check St, Town", "SHOT", { shootDate: at(-D) });
    const jCheck = await photoJob(pCheck.id, "EDITED", { slaDueAt: at(5 * H) });
    const pPartial = await project("14 Partial Pl, Town", "DELIVERED", { shootDate: at(-2 * D), deliverables: { create: [{ type: "PHOTOS", label: "Photos", status: "DONE" }, { type: "FLOORPLAN", label: "Floor Plan", status: "PENDING" }, { type: "ZILLOW_3D", label: "Zillow 3D Tour", status: "DONE" }] } });
    await photoJob(pPartial.id, "DELIVERED", { slaDueAt: at(-2 * H), deliveredAt: at(-H) });
    const pMismatch = await project("15 Mismatch Ct, Town", "SHOT", { shootDate: at(-D) });
    await photoJob(pMismatch.id, "DELIVERY_MISMATCH", { slaDueAt: at(2 * H), deliveryCheckNote: "Aryeo shows 31 photos, we sent 33" });
    const pDone = await project("16 Done Dr, Town", "DELIVERED", { shootDate: at(-2 * D) });
    await photoJob(pDone.id, "DELIVERED", { slaDueAt: at(-2 * H), deliveredAt: at(-H) });
    const pDelivering = await project("17 Delivering Way, Town", "SHOT", { shootDate: at(-D) });
    await photoJob(pDelivering.id, "DELIVERING", { slaDueAt: at(4 * H) });
    const pRedo = await project("41 Redo Rd, Town", "REVISION", { shootDate: at(-4 * D) });
    await photoJob(pRedo.id, "REVISION_REQUESTED", { slaDueAt: at(6 * H), deliveredAt: at(-2 * D) });
    const pTestPhotos = await project("18 Synthetic St, Town", "SHOT", { shootDate: at(-D) }, fixture.id);
    await photoJob(pTestPhotos.id, "READY", { slaDueAt: at(H) });

    // Videos (the board, driven) and the sent-but-not-told cut
    const pVideo = await project("20 Video Ave, Town", "REVIEW", { shootDate: at(-3 * D) });
    const pEditLate = await project("21 Edit St, Town", "EDITING", { shootDate: at(-4 * D) });
    const pInReview = await project("22 Review Rd, Town", "REVIEW", { shootDate: at(-2 * D) });
    const vrow = (key: string, projectId: string, street: string, lane: VideoRow["lane"], over: Partial<VideoRow> = {}): VideoRow => ({
      key, submissionId: `sub-${key}`, projectId, street, clientName: "Real Agent", label: "Listing video", round: 1, lane, stage: "Editing", cutStatus: null, sinceISO: null, send: null, heldRender: null,
      promiseISO: at(5 * H).toISOString(), promiseWords: "Due today", late: false, dueToday: true, lateHours: null, approvedAtISO: null, deliveredAtISO: null,
      deliveredBy: null, push: null, heldWhy: null, reviewHref: `/review/${projectId}?cut=${key}`, aryeoUrl: "https://app.aryeo.com/listings/x", waitingSinceISO: null, ...over,
    } as VideoRow);
    const push = { mode: "live", state: null, says: "Not started", tone: "info", handledByHub: false, waitingForKyle: false, canStart: true, progress: null, canRetry: false, canDeliverNow: false, canRelease: false, canHold: false, updatedAtISO: null };
    const send = (approvedBy: string) => ({ approvedBy, fileSource: "cut", fileName: "v1.mp4", fileSays: "the approved cut", downloadHref: "/x", watchHref: "/x", uploadFingerprint: null, uploaded: null, listingMissing: false, listingWarning: null, openAsks: [], asksUnknown: false, byHandWhy: null, pushUnknown: false });
    videoLanes = {
      late: [vrow("v-late", pEditLate.id, "21 Edit St", "late", { cutStatus: "CHANGES_REQUESTED", stage: "Changes asked, version 2", late: true, lateHours: 30, promiseISO: at(-30 * H).toISOString() })],
      today: [vrow("v-review", pInReview.id, "22 Review Rd", "today", { cutStatus: "PENDING", stage: "In review, version 1" })],
      review: [], upcoming: [],
      sending: [vrow("v-send", pVideo.id, "20 Video Ave", "sending", { cutStatus: "APPROVED", stage: "Approved, ready to send", approvedAtISO: at(-H).toISOString(), send: send("James Livingston") as unknown as VideoRow["send"], push: push as unknown as VideoRow["push"], dueToday: false, promiseISO: at(D).toISOString() })],
      held: [], finishing: [], delivered: [],
    };
    const pNotice = await project("30 Notice Ln, Town", "DELIVERED", { shootDate: at(-3 * D) });
    const dvN = await prisma.deliverable.create({ data: { projectId: pNotice.id, type: "VIDEO", label: "Listing video" } });
    const cutN = await prisma.reviewSubmission.create({ data: { projectId: pNotice.id, deliverableId: dvN.id, slot: 1, source: "folder", kind: "video", status: "APPROVED", decidedBy: "James Livingston", decidedAt: at(-3 * H), submittedByKey: "kim", assetPath: "/isolated/n.mp4", sentToClientAt: at(-H), sentToClientBy: "Kyle Smith", clientNoticeVia: "not-yet" } });
    const pOther = await project("33 Jordan Sent St, Town", "DELIVERED", { shootDate: at(-3 * D) });
    await prisma.reviewSubmission.create({ data: { projectId: pOther.id, slot: 1, source: "folder", kind: "video", status: "APPROVED", submittedByKey: "kim", assetPath: "/isolated/o.mp4", sentToClientAt: at(-2 * H), sentToClientBy: "Jordan Spackman", clientNoticeAt: at(-2 * H), clientNoticeVia: "aryeo-email", clientNoticeBy: "Jordan Spackman" } });
    const pText = await project("31 Text Ter, Town", "DELIVERED", { shootDate: at(-3 * D) });
    await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "2155550101", clientId: realC.id, projectId: pText.id, body: "Your photos are ready", state: "failed", providerError: "drill: carrier refused", dedupeKey: `delivery:${pText.id}` } });

    // Revisions: 632 Greenridge (client asked, replied, follows up, confirms)
    const pGreen = await project("632 Greenridge Rd, Town", "REVISION", { shootDate: at(-6 * D), promisedDueAt: at(D) }, green.id);
    const rev1 = await prisma.smartTask.create({ data: { taskType: "revision", source: "openphone", status: "OPEN", title: "Revise the opening for 632 Greenridge Rd", assignedKey: "kyle", projectId: pGreen.id, clientId: green.id, createdAt: at(-5 * H) } });
    await prisma.commLog.create({ data: { clientId: green.id, clientName: green.name, contactName: green.name, channel: "text", source: "openphone", direction: "in", body: "The revised opening doesn't make sense, can you fix it?", occurredAt: at(-2 * H), fromPhone: "2155550103" } });
    const pKim = await project("40 Kim Ct, Town", "REVISION", { shootDate: at(-6 * D) });
    const rev2 = await prisma.smartTask.create({ data: { taskType: "revision", source: "manual", status: "OPEN", title: "Shorter intro for 40 Kim Ct", assignedKey: "kim", projectId: pKim.id, clientId: realC.id, followUpAt: at(D), createdAt: at(-D) } });

    // Cliff Ln: a split order, three visits; Alex's lamp change after delivery
    // Aryeo's appointment brief, line for line (the parser reads its lines).
    const aryeoBrief = (o: { name: string; phone?: string; code?: string; access?: string; presence?: string; special?: string; orderNotes?: string }) => [
      "Customer:", `Name: ${o.name}`, `Email: ${o.name.split(" ")[0].toLowerCase()}@oct23.invalid`, ...(o.phone ? [`Phone: ${o.phone}`] : []), "Notes: n/a", "",
      "Order Items Serviced By This Appointment:", "- (1x) Listing Photos", "",
      ...(o.orderNotes ? ["Order Notes:", o.orderNotes, ""] : []),
      "Order Questions:",
      `- Will you or the seller be present at the appointment?: ${o.presence ?? ""}`,
      `- Lock Box / Door Code: ${o.code ?? ""}`,
      `- Additional information to access the property: ${o.access ?? ""}`,
      `- Special Instructions for the photographer (for this property only): ${o.special ?? ""}`,
    ].join("\n");
    const brief = (code: string) => aryeoBrief({ name: "Alex Agent", phone: "(215) 555-0102", code, access: "Side door", presence: "Seller", special: "Split appointment! Exteriors only. Photo, Video, and Drone.", orderNotes: "Appointment 1 Harrison got all exteriors." });
    const pCliff = await project("615 Cliff Ln, Malvern", "EDITING", { shootDate: at(2 * H), photographerId: harrison.id }, alex.id);
    await photoJob(pCliff.id, "DELIVERED", { deliveredAt: at(-D), slaDueAt: at(-D - H) });
    const raw = (items: string[]) => JSON.stringify({ items: items.map((title) => ({ object: "ORDER_ITEM", title, is_canceled: false })) });
    await prisma.appointment.create({ data: { aryeoId: "cliff-1", projectId: pCliff.id, startAt: at(-16 * D), endAt: at(-16 * D + 2 * H), status: "SCHEDULED", description: brief("4321"), rawJson: raw(["Social Influencer"]), assignedToId: harrison.id } });
    await prisma.appointment.create({ data: { aryeoId: "cliff-2", projectId: pCliff.id, startAt: at(-2 * D), endAt: at(-2 * D + 2 * H), status: "SCHEDULED", description: brief("4321"), rawJson: raw(["Zillow Showcase 3D Tour Add-on"]), assignedToId: harrison.id } });
    const cliff3 = await prisma.appointment.create({ data: { aryeoId: "cliff-3", projectId: pCliff.id, startAt: at(2 * H), endAt: at(4 * H), status: "SCHEDULED", description: brief("4321"), rawJson: raw([]), assignedToId: harrison.id } });
    const ask = (data: Record<string, unknown>) => prisma.clientAsk.create({ data: { clientId: alex.id, kind: "SPECIAL_REQUEST", medium: "photo", source: "text", ...data } as never });
    await ask({ projectId: pCliff.id, text: "Exteriors only on the first visit", summary: "Exteriors only", state: "CONFIRMED", askedAt: at(-20 * D) });
    const lamp = await ask({ projectId: pCliff.id, text: "Can you please adjust this photo so the lamp is still in it?", summary: "Keep the lamp in the living room photo", state: "OPEN", holdsDelivery: true, askedAt: at(-20 * H), source: "email" });
    await prisma.activity.create({ data: { projectId: pCliff.id, type: "SPECIAL_REQUEST", body: "Client request (gmail): adjust this photo so the lamp is still in it", createdAt: at(-20 * H) } });

    // Shoot prep: one ready today, one next business day unconfirmed with no access, one drone conflict
    const nextKey = desk.nextBusinessDayKey(T, (k) => !!companyHolidayName(k));
    const okBrief = aryeoBrief({ name: "Sam Seller", phone: "(215) 555-0109", code: "1111", presence: "Vacant", special: "Photos only" });
    const pToday = await project("50 Today St, Town", "SCHEDULED", { shootDate: at(3 * H), photographerId: harrison.id });
    const apToday = await prisma.appointment.create({ data: { aryeoId: "today-1", projectId: pToday.id, startAt: at(3 * H), endAt: at(5 * H), status: "SCHEDULED", description: okBrief, rawJson: raw(["Listing Photos"]), assignedToId: harrison.id } });
    await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "COMPLETED", completedAt: at(-D), dueAt: at(3 * H - D), title: "Confirm 50 Today St", projectId: pToday.id, clientId: realC.id } });
    const pNext = await project("51 Next Day Rd, Town", "SCHEDULED", { shootDate: etAt(nextKey, 10), photographerId: harrison.id });
    const apNext = await prisma.appointment.create({ data: { aryeoId: "next-1", projectId: pNext.id, startAt: etAt(nextKey, 10), endAt: etAt(nextKey, 12), status: "SCHEDULED", description: aryeoBrief({ name: "Pat Doe" }), rawJson: raw(["Listing Photos"]), assignedToId: harrison.id } });
    const confNext = await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "OPEN", dueAt: new Date(etAt(nextKey, 10).getTime() - D), title: "Confirm 51 Next Day Rd", projectId: pNext.id, clientId: realC.id } });
    const pDrone = await project("52 Drone Dr, Town", "SCHEDULED", { shootDate: at(4 * H), photographerId: harrison.id });
    const apDrone = await prisma.appointment.create({ data: { aryeoId: "drone-1", projectId: pDrone.id, startAt: at(4 * H), endAt: at(6 * H), status: "SCHEDULED", description: okBrief.replace("1111", "2222"), rawJson: raw(["Listing Photos", "Drone Photos"]), assignedToId: harrison.id } });
    await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "COMPLETED", completedAt: at(-D), dueAt: at(4 * H - D), title: "Confirm 52 Drone Dr", projectId: pDrone.id, clientId: realC.id } });
    await prisma.clientAsk.create({ data: { clientId: realC.id, projectId: pDrone.id, kind: "SPECIAL_REQUEST", medium: "photo", source: "text", text: "Please no drone, the HOA does not allow it", summary: "No drone, HOA rules", askedAt: at(-D), state: "OPEN" } });
    // #9 with the build itself: a Monday visit seen from Friday, not from Thursday
    const pMonday = await project("60 Monday Mews, Town", "SCHEDULED", { shootDate: etAt(mondayKey, 10), photographerId: harrison.id });
    const apMonday = await prisma.appointment.create({ data: { aryeoId: "monday-1", projectId: pMonday.id, startAt: etAt(mondayKey, 10), endAt: etAt(mondayKey, 12), status: "SCHEDULED", description: okBrief, rawJson: raw(["Listing Photos"]), assignedToId: harrison.id } });

    // Kyle's tasks and a lead
    const task = (data: Record<string, unknown>) => prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", ...data } as never });
    const k1 = await task({ title: "Apply $750 credit for 12 Oak St", dueAt: at(-10 * D) });
    const k2 = await task({ title: "Order lockbox keys", dueAt: at(H) });
    const k3 = await task({ taskType: "internal_instruction", source: "slack", title: "Check the drone batteries" });
    const k4 = await task({ title: "Ask about the twilight add-on for 9 Elm", dueAt: at(-2 * D) });
    const k5 = await task({ title: "Call the stager back", dueAt: at(-D), followUpAt: at(2 * D) });
    await task({ title: "Called the stager", dueAt: at(-D), status: "COMPLETED", completedAt: at(-H) });
    const lead = await prisma.smartTask.create({ data: { taskType: "lead", source: "website", status: "OPEN", title: "New lead: Pat Doe wants a listing shoot", createdAt: at(-3 * H), dueAt: at(H) } });

    // Sync health: Aryeo fresh, email late, photo delivery failed
    await prisma.cronRun.create({ data: { job: "aryeo", startedAt: at(-5 * 60_000), finishedAt: at(-4 * 60_000), ok: true, summary: JSON.stringify({ ms: { orders: 100 } }) } });
    await prisma.cronRun.create({ data: { job: "gmail", startedAt: at(-3 * H), finishedAt: at(-3 * H + 60_000), ok: true, summary: JSON.stringify({ ms: { gmail: 100 } }) } });
    await prisma.cronRun.create({ data: { job: "photo-delivery", startedAt: at(-4 * 60_000), finishedAt: at(-3 * 60_000), ok: false, error: "drill: boom", summary: JSON.stringify({ ms: { ready: 100 } }) } });
    c.ok("the world is built", true);

    // =====================================================================
    c.head("§2 · the desk, read");
    // =====================================================================
    const before = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    let d = await build();
    c.ok("building the desk writes nothing", before === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.appSetting.count({ where: { key: { startsWith: "office_" } } }) === 0);
    const tab = (x: OfficeDesk, k: string) => x.tabs.find((t) => t.key === k)!;
    const find = (x: OfficeDesk, id: string): DeskItem | undefined => x.tabs.flatMap((t) => [...t.now, ...t.waiting, ...t.ok]).find((i) => i.id === id);
    const job = (x: OfficeDesk, projectId: string) => find(x, `job:${projectId}`);
    const asset = (i: DeskItem | undefined, prefix: string) => (i?.panel.kind === "job" ? i.panel.assets.find((a) => a.id.startsWith(prefix)) : undefined);
    c.ok("five tabs in the spec's order", d.tabs.map((t) => t.label).join(" | ") === "QC & Delivery | Client Replies | Shoot Prep | Follow-Ups | Closeout");

    // ---- #1 ----
    let i = job(d, pCheck.id);
    c.ok("#1 a new photo set enters QC: listed under In progress, the hub's check running, not yet Kyle's", i?.state === "waiting" && asset(i, "photo:")?.status === "Edited photos received, free check running" && asset(i, "photo:")?.who === "the hub", JSON.stringify(asset(i, "photo:")));
    await prisma.photoJob.update({ where: { id: jCheck.id }, data: { stage: "QC_REVIEW" } });
    const run = await prisma.photoQcRun.create({ data: { jobId: jCheck.id, trigger: "INITIAL", status: "DONE", rulesVersion: "drill" } });
    await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: jCheck.id, ruleId: "R1", groupKey: "g1", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Window blown out in the kitchen", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT" } });
    d = await build();
    i = job(d, pCheck.id);
    c.ok("#1 …the free check fails: it needs Kyle's decision, with what the check found as context (no checklist)", i?.state === "now" && i.title === "Decide the photo check for 13 Check St" && i.panel.kind === "job" && i.panel.findings.some((f) => f.includes("Window blown out")) && i.primary?.action.kind === "link", i?.title);
    await prisma.photoJob.update({ where: { id: jCheck.id }, data: { stage: "FIXING" } });
    d = await build();
    i = job(d, pCheck.id);
    c.ok("#1 …the correction is tracked: waiting on AutoHDR with its promise, not gone", i?.state === "waiting" && asset(i, "photo:")?.status === "Corrections running in AutoHDR" && asset(i, "photo:")?.who === "AutoHDR" && i.dueISO === at(5 * H).toISOString());
    const dLate = await build(at(6 * H));
    c.ok("#1 …and once its promise passes it comes back to Kyle as late", job(dLate, pCheck.id)?.state === "now" && job(dLate, pCheck.id)?.late === true && asset(job(dLate, pCheck.id), "photo:")?.status === "Corrections are late in AutoHDR");

    // ---- QC & Delivery basics ----
    i = job(d, pReady.id);
    c.ok("ready photos: 'Review and deliver photos for 11 Ready Rd', due today, with Kyle's own Approve and deliver", i?.state === "now" && i.title === "Review and deliver photos for 11 Ready Rd" && i.primary?.action.kind === "photo-approve" && i.dueWords?.startsWith("Due ") === true);
    c.ok("late edits come back to Kyle to chase", job(d, pLate.id)?.state === "now" && job(d, pLate.id)?.late === true && job(d, pLate.id)?.title === "Chase the late photos for 12 Late Ln");
    c.ok("approved is not delivered: photos waiting on Aryeo read 'Approved, not delivered yet'", job(d, pDelivering.id)?.state === "waiting" && asset(job(d, pDelivering.id), "photo:")?.status.startsWith("Approved, not delivered yet") === true);
    c.ok("a delivered job with nothing else open is not listed; a test client's job never is", !job(d, pDone.id) && !job(d, pTestPhotos.id));

    // ---- #2 ----
    i = job(d, pRedo.id);
    c.ok("#2 photos the client asked to change after delivery go back to review (Kyle's decision), not done", i?.state === "now" && i.title === "Decide the photo changes for 41 Redo Rd" && asset(i, "photo:")?.tone === "now");

    // ---- #3 ----
    i = job(d, pVideo.id);
    const vAsset = asset(i, "video:");
    c.ok("#3 an approved video is Kyle's to SEND: 'Approved by James Livingston, ready to send', primary Send video", i?.state === "now" && vAsset?.status === "Approved by James Livingston, ready to send" && i.primary?.action.kind === "video-send" && i.title === "Send the approved video for 20 Video Ave");
    c.ok("#3 …and never his to approve: no approve or send-back control anywhere on his desk", d.tabs.flatMap((t) => [...t.now, ...t.waiting]).every((x) => x.actions.every((a) => !/approve-cut|send-back|request-changes/.test(a.kind))) && vAsset?.note?.includes("You send it") === true);
    c.ok("#3 a cut still in review is the creative manager's, a late edit the editor's: both in Follow-Ups, neither in delivery", !job(d, pInReview.id) && !job(d, pEditLate.id) && find(d, "edit:v-review")?.state === "waiting" && find(d, "edit:v-review")?.who === "James" && find(d, "edit:v-late")?.state === "now");

    // ---- #4 ----
    i = job(d, pNotice.id);
    c.ok("#4 published but the client never told: open, 'client not notified yet', never 'Delivered'", i?.state === "now" && asset(i, "notice:")?.status.includes("client not notified yet") === true && !/Delivered/.test(asset(i, "notice:")?.status ?? "") && i.primary?.action.kind === "video-notice");
    i = job(d, pText.id);
    c.ok("#4 a failed delivery text is a failure at the top of the order, not a delivery", i?.state === "now" && asset(i, "text:")?.tone === "failed" && asset(i, "text:")?.status === "The client's delivery text failed" && i.rank === desk.RANK.blocker);
    i = job(d, pMismatch.id);
    c.ok("#4 photos Aryeo shows differently are 'Not confirmed', a failure", asset(i, "photo:")?.tone === "failed" && asset(i, "photo:")?.status.startsWith("Not confirmed") === true);

    // ---- #5 ----
    i = job(d, pPartial.id);
    c.ok("#5 partial delivery: photos delivered, the floor plan still open (past the photos' promise, so Kyle chases CubiCasa), the job stays listed", i?.state === "now" && i.title === "Chase the floor plan for 14 Partial Pl" && asset(i, "photo:")?.tone === "done" && asset(i, "floorplan:")?.status === "Not in yet" && asset(i, "floorplan:")?.late === true && asset(i, "floorplan:")?.who === "CubiCasa" && asset(i, "tour:")?.status === "Done", JSON.stringify(i?.panel));
    await prisma.project.update({ where: { id: pPartial.id }, data: { promisedDueAt: at(D) } });
    i = job(await build(), pPartial.id);
    c.ok("#5 …before its promise the open floor plan waits on CubiCasa, with that time", i?.state === "waiting" && asset(i, "floorplan:")?.dueISO === at(D).toISOString() && i.who === "CubiCasa");
    await prisma.deliverable.updateMany({ where: { projectId: pPartial.id, type: "FLOORPLAN" }, data: { status: "DONE" } });
    c.ok("#5 …and leaves the list once the last asset is done", !job(await build(), pPartial.id));
    await prisma.deliverable.updateMany({ where: { projectId: pPartial.id, type: "FLOORPLAN" }, data: { status: "PENDING" } });

    // ---- #6 ----
    d = await build();
    const greenReply = tab(d, "replies").now.find((x) => x.title === "Reply to Greenridge Client");
    c.ok("#6 the client's follow-up is a reply owed, and the panel says replying won't close the change", !!greenReply && greenReply.panel.kind === "thread" && greenReply.panel.revisionNote?.includes("Replying does not close it") === true);
    c.ok("#6 …the change itself is in Follow-Ups, nobody holding it yet", find(d, `rev:${rev1.id}`)?.state === "now" && find(d, `rev:${rev1.id}`)?.title === "Route the client's change for 632 Greenridge Rd");
    await prisma.commLog.create({ data: { clientId: green.id, clientName: green.name, contactName: "Kyle Smith", channel: "text", source: "openphone", direction: "out", body: "Got it, we are fixing the opening now.", occurredAt: at(-H), senderTeamMemberId: kyleTm.id } });
    d = await build();
    c.ok("#6 after Kyle replies the reply leaves Client Replies…", !tab(d, "replies").now.some((x) => x.title === "Reply to Greenridge Client"));
    c.ok("#6 …and the revision stays open, in Follow-Ups and in the database", find(d, `rev:${rev1.id}`)?.state === "now" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: rev1.id } })).status === "OPEN");

    // ---- #2, the video side: the corrected version returns to review, not done ----
    const dvG = await prisma.deliverable.create({ data: { projectId: pGreen.id, type: "VIDEO", label: "Listing video" } });
    await prisma.reviewSubmission.create({ data: { projectId: pGreen.id, deliverableId: dvG.id, slot: 1, source: "folder", kind: "video", status: "PENDING", submittedByKey: "kim", assetPath: "/isolated/g2.mp4", createdAt: at(-30 * 60_000) } });
    d = await build();
    i = find(d, `rev:${rev1.id}`);
    c.ok("#2 a corrected video version goes back to review with James (waiting, with the job's promise), not done", i?.state === "waiting" && i.who === "James" && i.reason.includes("returns to review, not done") && i.dueISO === at(D).toISOString());
    c.ok("assigned is not completed: a change with Kim reads 'Assigned to Kim, not done yet'", find(d, `rev:${rev2.id}`)?.state === "waiting" && find(d, `rev:${rev2.id}`)?.reason.startsWith("Assigned to") === true && find(d, `rev:${rev2.id}`)?.reason.includes("not done yet") === true);

    // ---- #7 ----
    await signIn(kyle);
    const realNow = new Date();
    const waitRes = await actions.deskWaitAction({ taskId: k4.id, who: "creative", when: "2h", note: "Is twilight in the package?" });
    c.ok("#7 'Waiting on James' saves a named person and a follow-up time (the task's own chase date)", waitRes.ok && waitRes.message.startsWith("Waiting on James") && Math.abs(((await prisma.smartTask.findUniqueOrThrow({ where: { id: k4.id } })).followUpAt?.getTime() ?? 0) - (realNow.getTime() + 2 * H)) < 60_000, waitRes.message);
    c.ok("#7 …a creative question goes to James (one bell), on the record", await prisma.notification.count({ where: { kind: "office_question", userKey: `tm:${jamesTm.id}` } }) === 1 && await prisma.auditLog.count({ where: { action: "office_waiting_on", target: k4.id } }) === 1);
    const dWait = await desk.buildOfficeDesk({ now: realNow, excludeClientIds: [fixture.id], person, roster });
    const w = find(dWait, `task:${k4.id}`);
    c.ok("#7 while it waits: under Waiting on others, named, with when it comes back; not counted, not in Do next", w?.state === "waiting" && w.who === "James" && !!w.dueISO && w.reason.startsWith("Waiting on James (creative question)") && !dWait.doNext.some((x) => x.id === w.id) && !tab(dWait, "followups").now.some((x) => x.id === w.id), JSON.stringify(w));
    const dBack = await desk.buildOfficeDesk({ now: new Date(realNow.getTime() + 3 * H), excludeClientIds: [fixture.id], person, roster });
    const back = find(dBack, `task:${k4.id}`);
    const backRank = (x: DeskItem) => [x.rank, -Number(x.late)];
    c.ok("#7 when the follow-up is due it comes back: counted, 'Follow up with James', ranked overdue", back?.state === "now" && back.title.startsWith("Follow up with James") && back.rank === desk.RANK.overdue && tab(dBack, "followups").now.some((x) => x.id === back.id), JSON.stringify(back && { s: back.state, t: back.title }));
    c.ok("#7 …and into Do next whenever it ranks among the top five", dBack.doNext.some((x) => x.id === back?.id) || (dBack.doNext.length === desk.DO_NEXT_MAX && dBack.doNext.every((x) => JSON.stringify(backRank(x)) <= JSON.stringify(backRank(back!)))));
    c.ok("waiting is not forgotten: every waiting item names a person and a time", d.tabs.every((t) => t.waiting.every((x) => !!x.who && !!x.dueISO)), d.tabs.flatMap((t) => t.waiting).filter((x) => !x.who || !x.dueISO).map((x) => x.id).join());
    c.ok("a task with no date at all is Kyle's to give a time (counted, at the bottom of the order)", find(d, `task:${k3.id}`)?.state === "now" && find(d, `task:${k3.id}`)?.needsFollowUp === true && find(d, `task:${k3.id}`)?.rank === desk.RANK.housekeeping);
    c.ok("a task Kyle dated for later waits until then", find(d, `task:${k5.id}`)?.state === "waiting" && find(d, `task:${k5.id}`)?.dueISO === at(2 * D).toISOString());

    // ---- Shoot Prep, #9 by build ----
    d = await build();
    const visit = (x: OfficeDesk, apptId: string) => find(x, `visit:${apptId}`);
    const vv = (x: DeskItem | undefined) => (x?.panel.kind === "visit" ? x.panel.visit : null);
    c.ok("a shoot all set today is Ready (counted nowhere)", visit(d, apToday.id)?.state === "ok" && vv(visit(d, apToday.id))?.confirmation.state === "sent" && vv(visit(d, apToday.id))?.access.lockbox === "1111", visit(d, apToday.id)?.reason);
    const nx = visit(d, apNext.id);
    c.ok("the next business day's shoot is prepared today: unconfirmed and missing access, first in the list, with Confirm", nx?.state === "now" && nx.title.startsWith("Confirm 51 Next Day Rd") && vv(nx)?.gaps.some((g) => g.startsWith("No access answer")) === true && nx.primary?.action.kind === "confirm" && (nx.primary.action as { taskId: string }).taskId === confNext.id && tab(d, "prep").now[0]?.id !== apToday.id);
    c.ok("conflicting instructions are flagged (drone on the visit, the client said no drone)", visit(d, apDrone.id)?.state === "now" && vv(visit(d, apDrone.id))?.conflicts.some((x) => x.startsWith("Drone is on this visit")) === true);
    c.ok("the photographer's brief state comes from the briefing build (the stub: off for now)", vv(visit(d, apToday.id))?.brief.state === "off" && vv(visit(d, apToday.id))?.brief.words === "Brief not set up yet");
    const fri = await build(etAt(fridayKey, 11));
    const thu = await build(etAt(thursdayKey, 11));
    c.ok("#9 seen from Friday, Monday's visit is on Shoot Prep; seen from Thursday, it is not yet", !!visit(fri, apMonday.id) && !visit(thu, apMonday.id));

    // ---- Cliff Ln and Alex's lamp ----
    const cliff = vv(visit(d, cliff3.id));
    c.ok("Cliff Ln: this visit only. Its services are its own (none listed: flagged), the earlier visits fold away", !!cliff && cliff.services.length === 0 && cliff.gaps.includes("No services listed for this visit (a split order)") && cliff.otherVisits.length === 2 && cliff.requests.length === 0 && cliff.instructions.length === 0, JSON.stringify(cliff && { r: cliff.requests, i: cliff.instructions, g: cliff.gaps }));
    c.ok("…'Exteriors only' is an older note (folded), and the split order is flagged so Kyle confirms what this visit covers", !!cliff && cliff.earlier.some((e) => e.text.includes("Exteriors only")) && cliff.conflicts.some((x) => x.includes("cover all 3 visits")));
    c.ok("Alex's change to a delivered photo is a revision: not this visit's request, in Follow-Ups with a link to the job", !!cliff && cliff.revisionsAfterDelivery.length >= 1 && !cliff.requests.some((r) => /lamp/i.test(r.text)) && find(d, `ask:${lamp.id}`)?.tab === "followups" && find(d, `ask:${lamp.id}`)?.title === "Route the photo change for 615 Cliff Ln" && find(d, `ask:${lamp.id}`)?.href === `/projects/${pCliff.id}`);

    // ---- Client Replies ----
    c.ok("a new lead waiting on a call back is in Client Replies", tab(d, "replies").now.some((x) => x.id === `lead:${lead.id}`));
    c.ok("Kyle never sees a figure: the $750 task reads without it", !JSON.stringify(d).includes("$750") && find(d, `task:${k1.id}`)?.title.startsWith("Apply [amount] credit") === true, (() => { const j = JSON.stringify(d); const k = j.indexOf("$750"); return k < 0 ? `title: ${find(d, `task:${k1.id}`)?.title}` : j.slice(Math.max(0, k - 160), k + 40); })());

    // ---- #10: every count is the length of its list ----
    for (const x of [d, dWait, dBack, fri]) {
      const counted = x.tabs.filter((t) => t.key !== "closeout");
      const allNow = counted.flatMap((t) => t.now);
      const ids = x.tabs.flatMap((t) => [...t.now, ...t.waiting, ...t.ok]).map((y) => y.id);
      c.ok(`#10 (${x === d ? "now" : x === dWait ? "waiting" : x === dBack ? "back" : "Friday"}) each tab's count = its list; Closeout's = its open lines; one item per id; Do next is ≤5 of those same items, in order; the status line adds up`,
        counted.every((t) => t.count === t.now.length)
        && tab(x, "closeout").count === x.closeout.lines.filter((l) => !l.done).length
        && new Set(ids).size === ids.length
        && x.doNext.length <= desk.DO_NEXT_MAX && x.doNext.every((y) => allNow.includes(y)) && JSON.stringify(x.doNext.map((y) => y.id)) === JSON.stringify(desk.rankDoNext(allNow).map((y) => y.id))
        && x.status.now === allNow.length && x.status.late === allNow.filter((y) => y.late).length && x.status.waiting === counted.reduce((n, t) => n + t.waiting.length, 0),
        JSON.stringify(x.tabs.map((t) => [t.key, t.count, t.now.length])));
    }
    c.ok("#10 every counted item has one primary action (no number without an action)", d.tabs.flatMap((t) => t.now).every((x) => !!x.primary && x.actions.length > 0), d.tabs.flatMap((t) => t.now).filter((x) => !x.primary).map((x) => x.id).join());
    c.ok("#10 'N late' is said once, from the items themselves (no banner beside a card)", d.status.line.includes(`${d.status.late} late`) && d.status.late === d.tabs.flatMap((t) => t.now).filter((x) => x.late).length);
    c.ok("Do next leads with shoot blockers and urgent client issues", d.doNext[0]?.rank === desk.RANK.blocker && d.doNext.every((x, n, a) => n === 0 || a[n - 1].rank <= x.rank));

    // ---- freshness: stale and failed said, never zero ----
    const fresh = (k: string) => d.freshness.find((f) => f.key === k);
    c.ok("freshness: Aryeo synced, email late, photo delivery failed (each said)", fresh("aryeo")?.state === "ok" && fresh("gmail")?.state === "stale" && fresh("photo-delivery")?.state === "failed" && fresh("photo-delivery")?.words.startsWith("last sync failed") === true, JSON.stringify(d.freshness));
    queueFails = true;
    const dDown = await build();
    queueFails = false;
    c.ok("a source that can't be read is never zero: QC & Delivery says '?' and why, the status line names it", tab(dDown, "delivery").unavailable.includes("photo delivery") && dDown.freshness.some((f) => f.key === "read:photo delivery" && f.state === "failed") && dDown.status.line.includes("Couldn't read photo delivery"));

    // ---- #11 and Closeout: actions on the page, the preview read-only ----
    const today = d.dayKey;
    const tick = await actions.closeoutTickAction(today, "blockers", true);
    d = await build();
    const blockers = d.closeout.lines.find((l) => l.key === "blockers");
    c.ok("#11 a closeout tick is a real save with who and when (AppSetting for the ET day), and the list recomputes", tick.ok && blockers?.tick?.by === "Kyle Smith" && blockers.done && !!(await prisma.appSetting.findUnique({ where: { key: desk.closeoutSettingKey(today) } })) && await prisma.auditLog.count({ where: { action: "office_closeout_tick" } }) === 1);
    c.ok("closeout lines come from the system where they can (communications reviewed is not done while clients wait)", d.closeout.lines.find((l) => l.key === "comms")?.auto === false && d.closeout.lines.find((l) => l.key === "comms")?.done === false);
    const finishEarly = await actions.finishDayAction(today);
    c.ok("the day can't be finished with lines open", !finishEarly.ok && finishEarly.message.startsWith("Still open"));
    c.ok("the summary is Kyle's own: his video sent (not Jordan's), his reply, his closed task; no 'done by the office'", d.closeout.summary.completed.find((x) => x.what === "Videos sent")?.count === 1 && d.closeout.summary.completed.find((x) => x.what === "Client messages sent")?.count === 1 && d.closeout.summary.completed.some((x) => x.what === "Tasks closed") && !JSON.stringify(d.closeout).includes("by the office"), JSON.stringify(d.closeout.summary.completed));
    c.ok("…with what is pending, the blockers and the next business day", d.closeout.summary.pending.length === 4 && d.closeout.summary.blockers.length > 0 && d.closeout.summary.tomorrow.lines[0].includes("visit"));
    // Finishing the day never hides new work.
    await prisma.appSetting.update({ where: { key: desk.closeoutSettingKey(today) }, data: { value: JSON.stringify({ ticks: { blockers: { at: at(-2 * H).toISOString(), by: "Kyle Smith" } }, finished: { at: at(-H).toISOString(), by: "Kyle Smith" } }) } });
    await prisma.commLog.create({ data: { clientId: realC.id, clientName: realC.name, contactName: realC.name, channel: "text", source: "openphone", direction: "in", body: "Is the shoot still on for tomorrow?", occurredAt: at(-10 * 60_000), fromPhone: "2155550101" } });
    d = await build();
    c.ok("finishing the day does not hide new urgent work: the new message is still listed and counted", !!d.closeout.finished && d.closeout.newSinceFinish >= 1 && tab(d, "replies").now.some((x) => x.title === "Reply to Real Agent"));
    // The owner's preview stays read-only.
    await signIn(owner, kyle.id);
    const asOwner = await actions.closeoutTickAction(today, "comms", true);
    const waitAsOwner = await actions.deskWaitAction({ taskId: k2.id, who: "owner", when: "tomorrow" });
    c.ok("#11 the owner's 'view as Kyle' is read-only: the desk's writes refuse it", !asOwner.ok && !waitAsOwner.ok && /preview/i.test(asOwner.message), asOwner.message);
    const viewAs = await desk.officeDeskFor({ name: "Kyle Smith", email: kyle.email, teamMemberId: kyleTm.id, impersonating: true }, {});
    c.ok("#11 …and the desk itself is marked read-only in the preview", viewAs.readOnly === true && viewAs.person === "Kyle");

    // ---- semantics and house rules ----
    const words = JSON.stringify(d.tabs.flatMap((t) => [...t.now, ...t.waiting, ...t.ok]).map((x) => [x.title, x.reason, x.panel.kind === "job" ? x.panel.assets.map((a) => a.status) : []]));
    c.ok("no em dashes in the desk's words", !EM_DASH.test(words) && !EM_DASH.test(d.status.line) && !EM_DASH.test(JSON.stringify(d.closeout)));
    c.ok("product setup is Jordan's: nothing on Kyle's desk is about mapping a product", !/map(ping)? (the |a |an )?(unknown )?product|order line nobody defined/i.test(words));
    c.ok("nothing left the box but faked Slack posts; no client message queued by the desk", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://slack.com/api/")) && await prisma.outboxMessage.count() === 1, fence.blocked.join(", "));
    void cutN; void createRequire;
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

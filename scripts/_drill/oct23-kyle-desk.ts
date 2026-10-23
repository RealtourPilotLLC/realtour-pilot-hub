// Oct 23 2026: KYLE'S DESK (lib/officeDesk), revision 2 (Jordan's mockup:
// four sections all visible, the Daily checks above them). Held here against the spec's acceptance checks
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
let videoLanes: Lanes = { late: [], today: [], review: [], upcoming: [], sending: [], held: [], finishing: [], delivered: [] };
let useLanes = false;
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return {
    ...m,
    videoDeliveryBoard: (o?: Parameters<typeof m.videoDeliveryBoard>[0]) => (useLanes ? Promise.resolve({ asOf: new Date().toISOString(), lanes: videoLanes, counts: {}, mode: "live", connected: true } as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>>) : m.videoDeliveryBoard(o)),
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
    useLanes = true;
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
    // Its 48-hour confirmation is past due and still not sent (deterministic whatever the weekday).
    const confNext = await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "OPEN", dueAt: at(-H), title: "Confirm 51 Next Day Rd", projectId: pNext.id, clientId: realC.id } });
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

    // ---- revision 2's additions (Jordan's mockup and the lead's list) ----
    // A photo set ready but held by a client request that holds delivery.
    const pHeld = await project("19 Held Ct, Town", "SHOT", { shootDate: at(-D) });
    await photoJob(pHeld.id, "READY", { slaDueAt: at(6 * H) });
    const heldAsk = await prisma.clientAsk.create({ data: { clientId: realC.id, projectId: pHeld.id, kind: "SPECIAL_REQUEST", medium: "photo", source: "text", text: "Please take the trash cans out of the front shot", summary: "Trash cans out of the front shot", askedAt: at(-2 * D), state: "OPEN", holdsDelivery: true } });
    // A 3D tour uploaded and ready to verify; a floor plan the photo check saw missing from the listing.
    const pTour = await project("23 Tour Ter, Town", "DELIVERED", { shootDate: at(-2 * D), deliverables: { create: [{ type: "PHOTOS", label: "Photos", status: "DONE" }, { type: "ZILLOW_3D", label: "Zillow 3D Tour", status: "UPLOADED" }] } });
    await photoJob(pTour.id, "DELIVERED", { slaDueAt: at(-2 * H), deliveredAt: at(-H) });
    const pPlanDiff = await project("24 Plan Diff Dr, Town", "DELIVERED", { shootDate: at(-2 * D), deliverables: { create: [{ type: "PHOTOS", label: "Photos", status: "DONE" }, { type: "FLOORPLAN", label: "Floor Plan", status: "DONE" }] } });
    await photoJob(pPlanDiff.id, "DELIVERED", { slaDueAt: at(-2 * H), deliveredAt: at(-H), deliveryDiffJson: JSON.stringify({ approved: 30, aryeoCount: 30, missing: [], excludedShown: [], floorPlanMissing: true, extra: 0, duplicates: [] }) });
    // Upload to Aryeo only: on the listing, not sent; and a video in the 1080p pass.
    const pOnly = await project("25 Only Ln, Town", "REVIEW", { shootDate: at(-3 * D) });
    const pFin = await project("28 Finishing Way, Town", "REVIEW", { shootDate: at(-3 * D) });
    videoLanes.sending.push(vrow("v-only", pOnly.id, "25 Only Ln", "sending", { cutStatus: "APPROVED", stage: "On Aryeo, not sent yet", send: send("James Livingston") as unknown as VideoRow["send"], push: { ...push, mode: "upload", uploadedOnly: true, state: "WAITING", tone: "waiting", says: "On Aryeo, not sent yet", waitingForKyle: true, canStart: false, canDeliverNow: true } as unknown as VideoRow["push"], dueToday: false, promiseISO: at(D).toISOString() }));
    videoLanes.finishing.push(vrow("v-fin", pFin.id, "28 Finishing Way", "finishing", { cutStatus: "APPROVED", stage: "In the 1080p pass" }));
    // A Content Program message that is Kyle's; a booking request; a task from Jordan; a special request on a job going out today.
    const erica = await client("Erica Walker", "2155550111");
    const program = await prisma.smartTask.create({ data: { taskType: "program_message", source: "content_program", status: "OPEN", title: "Reply to Erica Walker's message", description: "A message is waiting on the program conversation.\n\n• Erica Walker: Can we swap the November topic?\n\nReply on Content Program → Messages.", dedupeKey: "program-message:enr-erica", assignedKey: "kyle", clientId: erica.id, dueAt: at(5 * H) } });
    const nehemiah = await client("Nehemiah Agent", "2155550112");
    const booking = await prisma.clientAsk.create({ data: { clientId: nehemiah.id, kind: "SCHEDULING", source: "text", text: "Can you book a shoot ASAP for 70 Fast Ave?", summary: "Book a shoot ASAP", askedAt: at(-2 * H), state: "OPEN" } });
    const fromJordanTask = await task({ taskType: "internal_instruction", source: "assistant", reasonCreated: "Asked for by Jordan on My Day", title: "Call the Malvern stager about Saturday", dueAt: at(2 * H) });
    const pSoon = await project("26 Soon St, Town", "EDITING", { shootDate: at(-D), promisedDueAt: at(4 * H) });
    const soonAsk = await prisma.clientAsk.create({ data: { clientId: realC.id, projectId: pSoon.id, kind: "SPECIAL_REQUEST", medium: "video", source: "text", text: "Use the upbeat song please", summary: "Upbeat song on the video", askedAt: at(-D), state: "OPEN" } });
    // A shoot within two hours with no access instructions; one already under way.
    const pUrgent = await project("27 Urgent Ave, Town", "SCHEDULED", { shootDate: at(H), photographerId: harrison.id });
    const apUrgent = await prisma.appointment.create({ data: { aryeoId: "urgent-1", projectId: pUrgent.id, startAt: at(H), endAt: at(3 * H), status: "SCHEDULED", description: aryeoBrief({ name: "Ura Gent", phone: "(215) 555-0120" }), rawJson: raw(["Listing Photos"]), assignedToId: harrison.id } });
    await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "COMPLETED", completedAt: at(-D), dueAt: at(H - D), title: "Confirm 27 Urgent Ave", projectId: pUrgent.id, clientId: realC.id } });
    const pStarted = await project("29 Started St, Town", "SCHEDULED", { shootDate: at(-H), photographerId: harrison.id });
    const apStarted = await prisma.appointment.create({ data: { aryeoId: "started-1", projectId: pStarted.id, startAt: at(-H), endAt: at(H), status: "SCHEDULED", description: okBrief, rawJson: raw(["Listing Photos"]), assignedToId: harrison.id } });

    // =====================================================================
    c.head("§2 · the desk, read (four sections, all visible)");
    // =====================================================================
    const before = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    let d = await build();
    c.ok("building the desk writes nothing", before === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.appSetting.count({ where: { key: { startsWith: "office_" } } }) === 0);
    const sec = (x: OfficeDesk, k: string) => x.sections.find((t) => t.key === k)!;
    const everyItem = (x: OfficeDesk) => x.sections.flatMap((t) => [...t.now, ...t.waiting, ...t.ok]);
    const find = (x: OfficeDesk, id: string): DeskItem | undefined => everyItem(x).find((i) => i.id === id);
    const media = (x: OfficeDesk, projectId: string) => find(x, `media:${projectId}`);
    const video = (x: OfficeDesk, projectId: string) => find(x, `video:${projectId}`);
    const asset = (i: DeskItem | undefined, prefix: string) => (i?.panel.kind === "job" ? i.panel.assets.find((a) => a.id.startsWith(prefix)) : undefined);
    c.ok("four sections in the mockup's order, no tabs, no Do next", d.sections.map((t) => t.title).join(" | ") === "Review & Deliver | Client Communications | Today's Shoots | Requests & Follow-Ups" && !("tabs" in d) && !("doNext" in d) && !("status" in d));
    const sectionOf = new Map<string, string[]>();
    for (const s of d.sections) for (const i of [...s.now, ...s.waiting, ...s.ok]) sectionOf.set(i.id, [...(sectionOf.get(i.id) ?? []), s.key]);
    c.ok("each item appears once, in one section", [...sectionOf.values()].every((v) => v.length === 1), [...sectionOf.entries()].filter(([, v]) => v.length > 1).map(([k]) => k).join());

    // ---- #1 ----
    c.ok("#1 a new photo set in the free check is not a row yet: a quiet line says it is in progress", !media(d, pCheck.id) && sec(d, "deliver").quiet.some((q) => q.text.includes("in editing, checks or delivery")));
    await prisma.photoJob.update({ where: { id: jCheck.id }, data: { stage: "QC_REVIEW" } });
    const run = await prisma.photoQcRun.create({ data: { jobId: jCheck.id, trigger: "INITIAL", status: "DONE", rulesVersion: "drill" } });
    await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: jCheck.id, ruleId: "R1", groupKey: "g1", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Window blown out in the kitchen", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT" } });
    d = await build();
    let i = media(d, pCheck.id);
    c.ok("#1 …the free check fails: a Review & Deliver row with what it found as context (no checklist), button Decide", i?.state === "now" && i.line === "Free check found issues to decide" && i.panel.kind === "job" && i.panel.findings.some((f) => f.includes("Window blown out")) && i.primary?.label === "Decide", i?.line);
    await prisma.photoJob.update({ where: { id: jCheck.id }, data: { stage: "FIXING" } });
    d = await build();
    c.ok("#1 …the correction is tracked: running in AutoHDR (quiet), not a row, not gone", !media(d, pCheck.id) && !find(d, `photos-late:${jCheck.id}`) && sec(d, "deliver").quiet.length > 0);
    const dLate = await build(at(6 * H));
    c.ok("#1 …once its promise passes it comes back as a production follow-up", find(dLate, `photos-late:${jCheck.id}`)?.state === "now" && find(dLate, `photos-late:${jCheck.id}`)?.tag === "production" && find(dLate, `photos-late:${jCheck.id}`)?.line === "Late from AutoHDR · Follow up");

    // ---- Review & Deliver ----
    i = media(d, pReady.id);
    c.ok("ready photos: '11 Ready Rd · Photos ready', the client, due today, Review (Kyle's own Approve and deliver in the panel)", i?.state === "now" && i.group === "media" && i.title === "11 Ready Rd" && i.line === "Photos ready" && i.client === "Real Agent" && i.primary?.label === "Review" && i.primary.action.kind === "photo-approve" && i.dueWords?.startsWith("Due ") === true);
    c.ok("late edits are a production follow-up, never a delivery row", !media(d, pLate.id) && find(d, `photos-late:${(await prisma.photoJob.findFirstOrThrow({ where: { projectId: pLate.id } })).id}`)?.section === "followups");
    c.ok("approved is not delivered: photos waiting on Aryeo are a quiet in-progress line, not 'done'", !media(d, pDelivering.id));
    c.ok("a delivered job with nothing else open is not listed; a test client's job never is", !media(d, pDone.id) && !media(d, pTestPhotos.id));
    i = media(d, pHeld.id);
    c.ok("photos held by a client request say which request, with its check beside the approval", i?.line.startsWith('Ready, held by the client\'s request: "Trash cans out of the front shot"') === true && i.actions.some((a) => a.kind === "ask" && a.askId === heldAsk.id) && i.actions.some((a) => a.kind === "photo-approve"), i?.line);
    i = media(d, pTour.id);
    c.ok("a 3D tour is its own item: '3D tour ready to verify', Check tour (Zillow), the photos already out", i?.line === "3D tour ready to verify" && i.primary?.label === "Check tour" && asset(i, "photo:")?.tone === "done", JSON.stringify(i?.line));
    i = media(d, pPlanDiff.id);
    c.ok("a floor plan the photo check saw missing (floorPlanMissing) is its own item, never holding the delivered photos", asset(i, "floorplan:")?.tone === "now" && asset(i, "floorplan:")?.status.includes("not on the Aryeo listing yet (CubiCasa)") === true && asset(i, "photo:")?.tone === "done", JSON.stringify(i?.panel.kind === "job" ? i.panel.assets : null));

    // ---- #2 ----
    i = media(d, pRedo.id);
    c.ok("#2 photos the client asked to change after delivery go back to review (Kyle's decision), not done", i?.state === "now" && i.line.startsWith("Client asked for changes") && asset(i, "photo:")?.tone === "now");

    // ---- #3 ----
    i = video(d, pVideo.id);
    c.ok("#3 an approved video is Kyle's to SEND: 'Approved by James, ready to send', Deliver, with Upload to Aryeo only beside it", i?.state === "now" && i.group === "video" && i.line === "Approved by James, ready to send" && i.primary?.label === "Deliver" && i.primary.action.kind === "video-send" && (i.primary.action as { uploadOnly: boolean }).uploadOnly === true);
    c.ok("#3 …and never his to approve: no approve or send-back control anywhere on his desk", everyItem(d).every((x) => x.actions.every((a) => !/approve-cut|send-back|request-changes/.test(a.kind))) && asset(i, "video:")?.note?.includes("You send it") === true);
    c.ok("an upload-only video reads 'On Aryeo, not sent yet' with Send now", video(d, pOnly.id)?.line.startsWith("On Aryeo, not sent yet") === true && video(d, pOnly.id)?.primary?.label === "Send now");
    c.ok("a video still in the 1080p pass is not an action: a quiet line only", !video(d, pFin.id) && sec(d, "deliver").quiet.some((q) => q.text === "1 video finishing the 1080p pass"));
    c.ok("#3 a cut still in review is the creative manager's, a late edit the editor's: both in Requests & Follow-Ups, neither a delivery", !video(d, pInReview.id) && !video(d, pEditLate.id) && find(d, "edit:v-review")?.state === "waiting" && find(d, "edit:v-review")?.who === "James" && find(d, "edit:v-late")?.state === "now");

    // ---- #4 ----
    i = video(d, pNotice.id);
    c.ok("#4 sent but the client never told: a row, 'the client was not told yet', never 'Delivered'", i?.state === "now" && asset(i, "notice:")?.status.includes("the client was not told yet") === true && !/Delivered/.test(asset(i, "notice:")?.status ?? "") && i.primary?.action.kind === "video-notice");
    i = media(d, pText.id);
    c.ok("#4 a failed delivery text is a failure at the top of the order, said as what it is", i?.state === "now" && asset(i, "text:")?.tone === "failed" && asset(i, "text:")?.status === "The client's delivery text failed" && i.primary?.label === "Resend the text" && i.rank === desk.RANK.blocker);
    i = media(d, pMismatch.id);
    c.ok("#4 a delivery Aryeo shows differently says the known problem (never a vague 'Check delivery')", asset(i, "photo:")?.tone === "failed" && asset(i, "photo:")?.status === "Delivery not confirmed: Aryeo shows 31 photos, we sent 33" && i?.primary?.label === "Fix delivery");

    // ---- #5 ----
    i = media(d, pPartial.id);
    c.ok("#5 partial delivery: photos delivered, the floor plan still open past the promise, its own item", i?.state === "now" && asset(i, "photo:")?.tone === "done" && asset(i, "floorplan:")?.late === true && asset(i, "floorplan:")?.who === "CubiCasa" && i.primary?.label === "Chase CubiCasa" && asset(i, "tour:")?.status === "Done", JSON.stringify(i?.panel));
    await prisma.project.update({ where: { id: pPartial.id }, data: { promisedDueAt: at(D) } });
    const dPartial = await build();
    c.ok("#5 …before its promise the open floor plan is on the way (quiet), not forgotten", !media(dPartial, pPartial.id) && sec(dPartial, "deliver").quiet.some((q) => q.text.includes("floor plan")));
    await prisma.deliverable.updateMany({ where: { projectId: pPartial.id, type: "FLOORPLAN" }, data: { status: "DONE" } });
    c.ok("#5 …and leaves once the last asset is done", !media(await build(), pPartial.id));
    await prisma.deliverable.updateMany({ where: { projectId: pPartial.id, type: "FLOORPLAN" }, data: { status: "PENDING" } });
    await prisma.project.update({ where: { id: pPartial.id }, data: { promisedDueAt: null } });

    // ---- Client Communications ----
    d = await build();
    const greenReply = sec(d, "comms").now.find((x) => x.title === "Greenridge Client");
    c.ok("a client waiting: initials, channel and business time, a one-line summary, Reply", greenReply?.initials === "GC" && greenReply.channel === "Text" && /min|business/.test(greenReply.elapsed ?? "") && greenReply.line.startsWith("The revised opening") && greenReply.primary?.label === "Reply", JSON.stringify(greenReply && [greenReply.initials, greenReply.channel, greenReply.elapsed, greenReply.line]));
    c.ok("…with Create follow-up beside the reply", greenReply?.actions.some((a) => a.kind === "follow-up") === true);
    c.ok("a Content Program message that is Kyle's is in Client Communications, opening the program's Messages", find(d, `program:${program.id}`)?.section === "comms" && find(d, `program:${program.id}`)?.line === "Erica Walker: Can we swap the November topic?" && (find(d, `program:${program.id}`)?.primary?.action as { href?: string })?.href === "/content/enr-erica?tab=messages");
    const bookingRows = sec(d, "comms").now.filter((x) => x.title === "Nehemiah Agent");
    c.ok("a booking request needing an answer is in Client Communications, once (the comms scan's own row for it, said as a booking)", bookingRows.length === 1 && bookingRows[0].tag === "booking" && bookingRows[0].line === "Booking request: Book a shoot ASAP" && !find(d, `booking:${booking.id}`), JSON.stringify(bookingRows.map((x) => [x.id, x.line])));
    c.ok("a new lead waiting on a call back is in Client Communications", sec(d, "comms").now.some((x) => x.id === `lead:${lead.id}`));

    // ---- #6 ----
    c.ok("#6 the client's follow-up is a reply owed, and the panel says replying won't close the change", !!greenReply && greenReply.panel.kind === "thread" && greenReply.panel.revisionNote?.includes("Replying does not close it") === true);
    c.ok("#6 …the change itself is a client revision in Requests & Follow-Ups, nobody holding it yet", find(d, `rev:${rev1.id}`)?.state === "now" && find(d, `rev:${rev1.id}`)?.tag === "revision" && find(d, `rev:${rev1.id}`)?.title === "632 Greenridge Rd · Video revision");
    await prisma.commLog.create({ data: { clientId: green.id, clientName: green.name, contactName: "Kyle Smith", channel: "text", source: "openphone", direction: "out", body: "Got it, we are fixing the opening now.", occurredAt: at(-H), senderTeamMemberId: kyleTm.id } });
    d = await build();
    c.ok("#6 after Kyle replies the conversation leaves Client Communications…", !sec(d, "comms").now.some((x) => x.title === "Greenridge Client"));
    c.ok("#6 …and the revision stays open, in Requests & Follow-Ups and in the database", find(d, `rev:${rev1.id}`)?.state === "now" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: rev1.id } })).status === "OPEN");

    // ---- #2, the video side ----
    const dvG = await prisma.deliverable.create({ data: { projectId: pGreen.id, type: "VIDEO", label: "Listing video" } });
    await prisma.reviewSubmission.create({ data: { projectId: pGreen.id, deliverableId: dvG.id, slot: 1, source: "folder", kind: "video", status: "PENDING", submittedByKey: "kim", assetPath: "/isolated/g2.mp4", createdAt: at(-30 * 60_000) } });
    d = await build();
    i = find(d, `rev:${rev1.id}`);
    c.ok("#2 a corrected video version goes back to review with James (waiting, with the job's promise), not done", i?.state === "waiting" && i.who === "James" && i.line.startsWith("Returned · In review with James") && i.reason.includes("returns to review, not done") && i.dueISO === at(D).toISOString(), i?.line);
    c.ok("assigned is not completed: a change with Kim reads 'Waiting on Kim', not done", find(d, `rev:${rev2.id}`)?.state === "waiting" && find(d, `rev:${rev2.id}`)?.line.startsWith("Waiting on") === true && find(d, `rev:${rev2.id}`)?.reason.includes("not done yet") === true);

    // ---- Requests & Follow-Ups ----
    c.ok("a task Jordan created for Kyle reads 'From Jordan'", find(d, `task:${fromJordanTask.id}`)?.tag === "jordan" && find(d, `task:${fromJordanTask.id}`)?.line.startsWith("From Jordan") === true);
    c.ok("a special request on a job going out today is in Requests & Follow-Ups, with Check request", find(d, `ask:${soonAsk.id}`)?.tag === "request" && find(d, `ask:${soonAsk.id}`)?.primary?.label === "Check request");
    c.ok("Alex's change to a delivered photo is a client revision (a photo correction), linked to the job", find(d, `ask:${lamp.id}`)?.tag === "revision" && find(d, `ask:${lamp.id}`)?.title === "615 Cliff Ln · Photo correction" && find(d, `ask:${lamp.id}`)?.href === `/projects/${pCliff.id}`);
    c.ok("client revisions look different from production follow-ups (their own tag)", sec(d, "followups").now.some((x) => x.tag === "revision") && sec(d, "followups").now.some((x) => x.tag === "production"));

    // ---- #7 ----
    await signIn(kyle);
    const realNow = new Date();
    const waitRes = await actions.deskWaitAction({ taskId: k4.id, who: "creative", when: "2h", note: "Is twilight in the package?" });
    c.ok("#7 'Waiting on James' saves a named person and a follow-up time (the task's own chase date)", waitRes.ok && waitRes.message.startsWith("Waiting on James") && Math.abs(((await prisma.smartTask.findUniqueOrThrow({ where: { id: k4.id } })).followUpAt?.getTime() ?? 0) - (realNow.getTime() + 2 * H)) < 60_000, waitRes.message);
    c.ok("#7 …a creative question goes to James (one bell), on the record", await prisma.notification.count({ where: { kind: "office_question", userKey: `tm:${jamesTm.id}` } }) === 1 && await prisma.auditLog.count({ where: { action: "office_waiting_on", target: k4.id } }) === 1);
    const dWait = await desk.buildOfficeDesk({ now: realNow, excludeClientIds: [fixture.id], person, roster });
    const w = find(dWait, `task:${k4.id}`);
    c.ok("#7 while it waits: collapsed under 'waiting on others', named, with when it comes back; not counted", w?.state === "waiting" && w.who === "James" && w.line.startsWith("Waiting on James · Follow up ") && !sec(dWait, "followups").now.some((x) => x.id === w.id), JSON.stringify(w && [w.state, w.line]));
    const dBack = await desk.buildOfficeDesk({ now: new Date(realNow.getTime() + 3 * H), excludeClientIds: [fixture.id], person, roster });
    const back = find(dBack, `task:${k4.id}`);
    c.ok("#7 when the follow-up is due it comes back: counted, 'Waiting on James · Follow up now', Follow up", back?.state === "now" && back.line === "Waiting on James · Follow up now" && back.primary?.label === "Follow up" && sec(dBack, "followups").now.some((x) => x.id === back.id), JSON.stringify(back && [back.state, back.line]));
    c.ok("waiting is not forgotten: every waiting item names a person and a time", d.sections.every((t) => t.waiting.every((x) => !!x.who && !!x.dueISO)), d.sections.flatMap((t) => t.waiting).filter((x) => !x.who || !x.dueISO).map((x) => x.id).join());
    c.ok("a recent task with no date at all is Kyle's to give a time", find(d, `task:${k3.id}`)?.state === "now" && find(d, `task:${k3.id}`)?.needsFollowUp === true);
    c.ok("a task Kyle dated for later waits until then", find(d, `task:${k5.id}`)?.state === "waiting" && find(d, `task:${k5.id}`)?.dueISO === at(2 * D).toISOString());
    const k1Row = await prisma.smartTask.findUniqueOrThrow({ where: { id: k1.id } });
    c.ok("old tasks are not re-dated or closed to shrink a count: the 10-day-old task is off the overview behind one backlog link, untouched", !find(d, `task:${k1.id}`) && d.backlog.count >= 1 && d.backlog.href === "/ops/checklist#earlier" && k1Row.status === "OPEN" && k1Row.dueAt?.getTime() === at(-10 * D).getTime() && k1Row.followUpAt === null);

    // ---- Today's Shoots, #9 by build, the brief rules ----
    const visit = (x: OfficeDesk, apptId: string) => find(x, `visit:${apptId}`);
    const vv = (x: DeskItem | undefined) => (x?.panel.kind === "visit" ? x.panel.visit : null);
    c.ok("a shoot all set today is Ready: 'Confirmed', chip Ready, no button", visit(d, apToday.id)?.state === "ok" && visit(d, apToday.id)?.day === "today" && visit(d, apToday.id)?.chip?.label === "Ready" && !visit(d, apToday.id)?.primary && vv(visit(d, apToday.id))?.access.lockbox === "1111", visit(d, apToday.id)?.reason);
    const nx = visit(d, apNext.id);
    c.ok("the next business day's shoot: unconfirmed and missing access, Needs confirmation, Confirm (the template text)", nx?.state === "now" && nx.day === "next" && nx.chip?.label === "Needs confirmation" && vv(nx)?.gaps.some((g) => g.startsWith("No access")) === true && nx.primary?.label === "Confirm" && (nx.primary.action as { taskId: string }).taskId === confNext.id);
    c.ok("conflicting instructions are flagged (drone on the visit, the client said no drone)", visit(d, apDrone.id)?.state === "now" && vv(visit(d, apDrone.id))?.conflicts.some((x) => x.startsWith("Drone is on this visit")) === true);
    c.ok("the photographer's brief state comes from the briefing build (switched off by default: said, not a problem)", vv(visit(d, apToday.id))?.brief.state === "off" && vv(visit(d, apToday.id))?.brief.words === "Brief switched off");
    c.ok("a shoot already under way is collapsed with the past, with no brief offered", vv(visit(d, apStarted.id))?.over === true && visit(d, apStarted.id)?.state === "ok" && visit(d, apStarted.id)?.chip?.label === "On site" && !visit(d, apStarted.id)?.actions.some((a) => a.kind === "brief-send"));
    c.ok("the brief rules: never after the appointment's time; Send when none went, Resend only when one did; unknown asks Kyle to verify",
      desk.briefOffer({ state: "failed", sent: false, started: true, why: "Not sent: no phone" }).send === null
      && desk.briefOffer({ state: "failed", sent: false, started: false, why: "Not sent: no phone number on file for Harrison" }).send === "send"
      && desk.briefOffer({ state: "failed", sent: true, started: false, why: "Update not sent: refused" }).send === "resend"
      && desk.briefOffer({ state: "sent", sent: true, started: false, why: "Not acknowledged yet. First shoot 2:00 PM." }).send === "resend"
      && desk.briefOffer({ state: "sent", sent: true, started: false, why: null }).waiting === true
      && desk.briefOffer({ state: "unknown", sent: false, started: false, why: null }).problem?.startsWith("Brief status unknown") === true
      && desk.briefOffer({ state: "unknown", sent: false, started: false, why: null }).send === null);
    await prisma.appSetting.create({ data: { key: "photographer_brief", value: JSON.stringify({ enabled: true, sendMinute: 1080 }) } });
    const dBrief = await build();
    await prisma.appSetting.delete({ where: { key: "photographer_brief" } });
    const failedBrief = visit(dBrief, apToday.id);
    c.ok("switched on, a brief that never went (no phone on file) is 'Brief failed' with Send brief (never Resend), and the full brief's link", failedBrief?.state === "now" && failedBrief.chip?.label === "Brief failed" && failedBrief.primary?.label === "Send brief" && (failedBrief.primary.action as { resend: boolean; teamMemberId: string }).resend === false && (failedBrief.primary.action as { teamMemberId: string }).teamMemberId === harrison.id && vv(failedBrief)?.brief.href === `/shoot/brief/${todayKey}?as=${harrison.id}`, JSON.stringify(vv(failedBrief)?.brief));
    c.ok("…and the shoot under way still offers no brief", !visit(dBrief, apStarted.id)?.actions.some((a) => a.kind === "brief-send"));
    const fri = await build(etAt(fridayKey, 11));
    const thu = await build(etAt(thursdayKey, 11));
    c.ok("#9 seen from Friday, Monday's visit is under Next business day; seen from Thursday, it is not yet", visit(fri, apMonday.id)?.day === "next" && !visit(thu, apMonday.id));
    const cliff = vv(visit(d, cliff3.id));
    c.ok("Cliff Ln: this visit only. Its services are its own (none listed: flagged), the earlier visits fold away", !!cliff && cliff.services.length === 0 && cliff.gaps.includes("No services listed for this visit (a split order)") && cliff.otherVisits.length === 2 && cliff.requests.length === 0 && cliff.instructions.length === 0, JSON.stringify(cliff && { r: cliff.requests, i: cliff.instructions, g: cliff.gaps }));
    c.ok("…'Exteriors only' is an older note (folded), and the split order is flagged so Kyle confirms what this visit covers", !!cliff && cliff.earlier.some((e) => e.text.includes("Exteriors only")) && cliff.conflicts.some((x) => x.includes("cover all 3 visits")));
    c.ok("…and Alex's lamp change is not this visit's request", !!cliff && cliff.revisionsAfterDelivery.length >= 1 && !cliff.requests.some((r) => /lamp/i.test(r.text)));

    // ---- only a verified, time-sensitive issue interrupts the day ----
    c.ok("a shoot within two hours with no access instructions is the one interruption above the sections (pointing at its row)", d.urgent.some((u) => u.id === `visit:${apUrgent.id}` && u.text.startsWith("Shoot at") && u.text.includes("no access instructions")) && d.urgent.every((u) => !!find(d, u.id)), JSON.stringify(d.urgent));

    c.ok("Kyle never sees a figure: the $750 task never reaches the desk's words", !JSON.stringify(d).includes("$750"));

    // ---- #10: every count is the length of the rows it labels ----
    for (const x of [d, dWait, dBack, fri]) {
      const ids = everyItem(x).map((y) => y.id);
      c.ok(`#10 (${x === d ? "now" : x === dWait ? "waiting" : x === dBack ? "back" : "Friday"}) each section's count = its rows; one item per id; every interruption points at a row`,
        x.sections.every((t) => t.count === t.now.length) && new Set(ids).size === ids.length && x.urgent.every((u) => ids.includes(u.id)),
        JSON.stringify(x.sections.map((t) => [t.key, t.count, t.now.length])));
    }
    c.ok("#10 every counted row has one primary action", d.sections.flatMap((t) => t.now).every((x) => !!x.primary && x.actions.length > 0), d.sections.flatMap((t) => t.now).filter((x) => !x.primary).map((x) => x.id).join());

    // ---- freshness: stale and failed said, never zero ----
    const fresh = (k: string) => d.freshness.find((f) => f.key === k);
    c.ok("freshness: Aryeo synced, email late, photo delivery failed (each said)", fresh("aryeo")?.state === "ok" && fresh("gmail")?.state === "stale" && fresh("photo-delivery")?.state === "failed" && fresh("photo-delivery")?.words.startsWith("last sync failed") === true, JSON.stringify(d.freshness));
    queueFails = true;
    const dDown = await build();
    queueFails = false;
    c.ok("a source that can't be read is never zero: Review & Deliver says why, freshness names it", sec(dDown, "deliver").unavailable.includes("photo delivery") && dDown.freshness.some((f) => f.key === "read:photo delivery" && f.state === "failed"));

    // ---- #11 and the Daily checks: actions on the page, the preview read-only ----
    const today = d.dayKey;
    const tick = await actions.closeoutTickAction(today, "am_messages", true);
    d = await build();
    const amMessages = d.checks.groups.find((g) => g.key === "morning")!.lines.find((l) => l.key === "am_messages");
    c.ok("#11 a manual review tick is a real save with who and when (AppSetting for the ET day), and the checks recompute", tick.ok && amMessages?.tick?.by === "Kyle Smith" && amMessages.done && await prisma.auditLog.count({ where: { action: "office_closeout_tick" } }) === 1);
    c.ok("…the tick records the review; the conversations it covers are still on the desk", sec(d, "comms").now.length > 0);
    const evidenceOnly = await actions.closeoutTickAction(today, "eod_owners", true);
    c.ok("an evidence-only check can't be ticked by hand", !evidenceOnly.ok && evidenceOnly.message.includes("ticked by the system"));
    c.ok("the Daily checks are the three reviews with their checks", d.checks.groups.map((g) => `${g.key}:${g.lines.length}`).join() === "morning:3,midday:2,eod:3");
    c.ok("system evidence ticks what it can: 'next business day prepared' is open while a visit is not ready", d.checks.groups.find((g) => g.key === "eod")!.lines.find((l) => l.key === "eod_nextday")?.auto === false);
    const finishEarly = await actions.finishDayAction(today);
    c.ok("the day can't be finished while the end-of-day review is open", !finishEarly.ok && finishEarly.message.startsWith("Still open"));
    c.ok("the summary is Kyle's own: his video sent (not Jordan's), his reply, his closed task; no 'done by the office'", d.checks.summary.completed.find((x) => x.what === "Videos sent")?.count === 1 && d.checks.summary.completed.find((x) => x.what === "Client messages sent")?.count === 1 && d.checks.summary.completed.some((x) => x.what === "Tasks closed") && !JSON.stringify(d.checks).includes("by the office"), JSON.stringify(d.checks.summary.completed));
    const follow = await actions.deskFollowUpAction({ clientId: green.id, projectId: pGreen.id, title: "Check the new opening landed with Greenridge", when: "tomorrow" });
    const created = await prisma.smartTask.findFirst({ where: { taskType: "comms_followup", clientId: green.id } });
    c.ok("Create follow-up makes a task linked to the client and job, back the next business day (the request stays open)", follow.ok && !!created && created.projectId === pGreen.id && created.assignedKey === "kyle" && !!created.followUpAt && (await prisma.smartTask.findUniqueOrThrow({ where: { id: rev1.id } })).status === "OPEN");
    // Finishing the day never hides new work.
    await prisma.appSetting.update({ where: { key: desk.closeoutSettingKey(today) }, data: { value: JSON.stringify({ ticks: { am_messages: { at: at(-2 * H).toISOString(), by: "Kyle Smith" } }, finished: { at: at(-H).toISOString(), by: "Kyle Smith" } }) } });
    await prisma.commLog.create({ data: { clientId: realC.id, clientName: realC.name, contactName: realC.name, channel: "text", source: "openphone", direction: "in", body: "Is the shoot still on for tomorrow?", occurredAt: at(-10 * 60_000), fromPhone: "2155550101" } });
    d = await build();
    c.ok("finishing the day does not hide new urgent work: the new message is still listed and counted", !!d.checks.finished && d.checks.newSinceFinish >= 1 && sec(d, "comms").now.some((x) => x.title === "Real Agent"));
    // The owner's preview stays read-only.
    await signIn(owner, kyle.id);
    const asOwner = await actions.closeoutTickAction(today, "am_shoots", true);
    const waitAsOwner = await actions.deskWaitAction({ taskId: k2.id, who: "owner", when: "tomorrow" });
    const followAsOwner = await actions.deskFollowUpAction({ clientId: realC.id, title: "Preview follow-up", when: "2h" });
    c.ok("#11 the owner's 'view as Kyle' is read-only: the desk's writes refuse it", !asOwner.ok && !waitAsOwner.ok && !followAsOwner.ok && /preview/i.test(asOwner.message), asOwner.message);
    const viewAs = await desk.officeDeskFor({ name: "Kyle Smith", email: kyle.email, teamMemberId: kyleTm.id, impersonating: true }, {});
    c.ok("#11 …and the desk itself is marked read-only in the preview", viewAs.readOnly === true && viewAs.person === "Kyle");

    // ---- semantics and house rules ----
    const words = JSON.stringify(everyItem(d).map((x) => [x.title, x.line, x.reason, x.panel.kind === "job" ? x.panel.assets.map((a) => a.status) : []]));
    c.ok("no em dashes in the desk's own words", !EM_DASH.test(words) && !EM_DASH.test(JSON.stringify(d.checks)) && !EM_DASH.test(JSON.stringify(d.urgent)));
    c.ok("product setup is Jordan's: nothing on Kyle's desk is about mapping a product", !/map(ping)? (the |a |an )?(unknown )?product|order line nobody defined/i.test(words));
    c.ok("nothing left the box but faked Slack posts; no client message queued by the desk", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://slack.com/api/")) && await prisma.outboxMessage.count() === 1, fence.blocked.join(", "));
    void cutN; void createRequire;
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });

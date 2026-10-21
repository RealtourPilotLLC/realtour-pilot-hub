// ---------------------------------------------------------------------------
// DRILL: the "Before you send" job box, client requests simplified, shoot
// flags sorted, and the team's "we're behind" alert (Oct 19 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct19-job-box.ts
//
// Jordan: "Flagged by 'Creative' should be on each photo or video job so that
// no matter where we are, we see what was flagged at that shoot before sending
// it out." "If the creative flags something that doesn't relate to photo
// editing or video editing or delivery, then it should just go to me." "If we
// start getting behind the team needs to know (me, Kyle, James, and editors)."
//
//   1. Client requests simplified: order notes, add-ons, portal requests and
//      Aryeo moves are no longer filed; the boards hide the rows filed before;
//      a revision raised for the message keeps its asks unless the brain named
//      another job; the same message read again files nothing even on another
//      job; asks close when the job is delivered (and photo-only ones when the
//      photos go out); money is scrubbed for anyone but the owner; the "never
//      mind" re-read runs on the client's inbound texts only.
//   2. The job box: flags by medium (an owner-only flag nowhere), requests by
//      medium (both / unclear on either), notes from the order (no lockbox),
//      add-ons by medium, the office and edit notes; ONE Checked confirms all
//      with who and one timeline line; view-as refused; money scrubbed for
//      Kyle. (The box rendered: oct19-job-box-render.ts.)
//   3. Shoot flags sorted: the word rule; an owner-only flag goes to Jordan's
//      loop and his bell only (no Kyle loop, no ops ping); a work flag to Kyle
//      as before; both to both; who flagged it stamped; Jordan's list counts by
//      client.
//   4. We're behind: thresholds and the headline; the alert posts once on the
//      way up, again on escalation, once each morning, "Back on track" once;
//      a failed read changes nothing; no flapping; the real Slack path posts in
//      #video-editing (faked) and falls back to the ops line; the real read
//      counts a late photo job.
//
// ISOLATION: PGlite via the shared harness; Slack faked at the fence.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7197);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DASH = /[—–]|&mdash;|&ndash;/;

type Me = { id: string; email: string; name: string | null; role: string; permissions: null; status: string; teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: null; impersonating: boolean; realRole: string; realName: string | null } | null;
let me: Me = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

// Slack, faked at the fence: what was posted where.
const slackPosts: { channel: string; text: string }[] = [];
let videoEditingRefuses = false;
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://slack.com/api/")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    if (url.endsWith("conversations.list")) return json({ ok: true, channels: [{ id: "C0VIDEO", name: "video-editing", is_member: true }, { id: "C0OTHER", name: "random", is_member: true }] });
    if (url.endsWith("chat.postMessage")) {
      if (videoEditingRefuses && body.channel === "C09SL8A1E1X") return json({ ok: false, error: "not_in_channel" });
      slackPosts.push({ channel: String(body.channel), text: String(body.text) });
      return json({ ok: true, channel: body.channel, ts: "1.1" });
    }
    return json({ ok: true });
  }
  return null;
});

const user = (role: string, extra: Partial<NonNullable<Me>> = {}): NonNullable<Me> => ({ id: `u-${role}`, email: `${role.toLowerCase()}@x.test`, name: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", ...extra });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("slack", "xoxb-drill-not-real");
  const ca = await import("@/lib/clientAsks");

  const jordan = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@drill.test", role: "ADMIN", slackId: "U0JORDAN" } as never, select: { id: true } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN", slackId: "U0KYLE" } as never, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Lee", email: "harrison@drill.test", role: "ADMIN" } as never, select: { id: true } });
  const heather = await prisma.client.create({ data: { name: "Heather Barritt", phone: "(724) 555-0193" }, select: { id: true, name: true } });
  const barry = await prisma.project.create({ data: { title: "Barry Rd, New Britain Township, PA 18914", clientId: heather.id, status: "EDITING", promisedDueAt: new Date(Date.now() + 2 * DAY), photographerId: harrison.id } as never, select: { id: true } });
  const pine = await prisma.project.create({ data: { title: "12 Pine St, Malvern, PA", clientId: heather.id, status: "EDITING" }, select: { id: true } });
  const done = await prisma.project.create({ data: { title: "671 Northbrook Rd, Kennett Square, PA", clientId: heather.id, status: "DELIVERED", deliveredAt: new Date(Date.now() - 6 * DAY) }, select: { id: true } });

  // =========================================================================
  c.head("1 · Client requests simplified");
  // =========================================================================
  const orderJob = await prisma.project.create({
    data: {
      title: "1680 Bridle Path Dr, Malvern, PA", clientId: heather.id, status: "SCHEDULED",
      orderItems: { create: [{ title: "Lot Lines", amount: 5000 }, { title: "Virtual Staging", amount: 3000 }] },
      appointments: { create: [{ aryeoId: "appt-bridle", description: "Customer:\nName: Heather\n\nOrder Notes:\nn/a\n\nOrder Questions:\n - Lock Box / Door Code: 4417\n - Special Instructions for the photographer (for this property only): Agent will be there. The lockbox is on the back door. Let's use vertical for the video. Drone to highlight the lot size.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
    } as never,
    select: { id: true },
  });
  c.ok("an order's notes and add-ons are no longer filed as asks", (await ca.fileOrderAsks(orderJob.id)) === 0 && (await prisma.clientAsk.count({ where: { projectId: orderJob.id } })) === 0);
  c.ok("…nor a portal session request, nor a move seen in Aryeo",
    (await ca.fileSessionRequestAsk({ requestId: "req-1", clientId: heather.id, projectId: null, mode: "RESCHEDULE", when: "Thu" })) === null &&
    (await ca.fileAryeoChangeAsk({ aryeoAppointmentId: "appt-bridle", projectId: orderJob.id, change: "moved", startAt: new Date(), previousStartAt: null, keyPart: "x" })) === null &&
    (await prisma.clientAsk.count()) === 0);
  c.ok("the Aryeo sync and the portal desk no longer call the filers", !/fileOrderAsks|fileAryeoChangeAsk/.test(fs.readFileSync("src/lib/integrations/aryeo.ts", "utf8")) && !/fileSessionRequestAsk/.test(fs.readFileSync("src/lib/sessionRequests.ts", "utf8")));

  // Rows filed before the change: hidden from the boards and the counts.
  const now = new Date();
  await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SPECIAL_REQUEST", source: "order_note", medium: "both", text: "Ordered: Lot Lines", holdsDelivery: false, askedAt: new Date(now.getTime() - 9 * DAY) });
  await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SCHEDULING", source: "portal", text: "Asked on the portal to move the session", dedupeKey: "portal-session:r:RESCHEDULE" });
  await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SCHEDULING", source: "aryeo", text: "Moved in Aryeo", dedupeKey: "aryeo-change:a:1" });
  const lots = await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: "It needs to have all 4 lots overlayed, priced under $350k", summary: "Overlay all 4 lots (listing under $350k)", askedBy: "Heather Barritt", askedAt: new Date(now.getTime() - 2 * HOUR) });
  const sched = await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SCHEDULING", source: "text", text: "Can we move Thursday's shoot?", askedAt: new Date(now.getTime() - 1 * HOUR) });
  const board = await ca.specialRequestsBoard(now);
  c.ok("the Special requests board: the client's text only (the old order note hidden)", board.counts.open === 1 && board.groups.length === 1 && board.groups[0].asks[0].id === lots!.id, JSON.stringify(board.counts));
  const sb = await ca.schedulingBoard(now);
  c.ok("the Scheduling board: the client's text only (portal and Aryeo rows hidden; aryeo list empty)", sb.asks.length === 1 && sb.asks[0].id === sched!.id && sb.aryeo.length === 0 && sb.counts.open === 1, JSON.stringify(sb.counts));
  const counts = await ca.askBoardCounts(now);
  c.ok("…and Kyle's tiles count the same", counts.special.open === 1 && counts.scheduling.open === 1);
  c.ok("the never-mind re-read reads the client's own asks only", (await ca.openAsksForClient(heather.id, 30, now)).every((a) => a.id === lots!.id || a.id === sched!.id) && (await ca.openAsksForClient(heather.id, 30, now)).length === 2);

  me = user("ADMIN");
  const kyleBoard = await ca.specialRequestsBoard(now);
  c.ok("Kyle's board shows no amount: 'under $350k' reads 'under [amount]'", /under \[amount\]/.test(kyleBoard.groups[0].asks[0].summary) && !/\$/.test(`${kyleBoard.groups[0].asks[0].summary} ${kyleBoard.groups[0].asks[0].text}`), kyleBoard.groups[0].asks[0].summary);
  me = user("OWNER");
  c.ok("…the owner sees the words as written", /\$350k/.test((await ca.specialRequestsBoard(now)).groups[0].asks[0].summary));
  me = user("OWNER", { impersonating: true, role: "ADMIN" });
  c.ok("…and the owner viewing as Kyle sees what Kyle sees", !/\$/.test((await ca.specialRequestsBoard(now)).groups[0].asks[0].summary));
  me = null;
  c.ok("the hold line other screens read is money-free for everyone", !/\$/.test((await ca.openAsksHolding(barry.id, "photo"))[0]?.summary ?? "$"));

  // A revision raised for the message, the brain naming no job for the ask: the revision's.
  const route = (kind: "SPECIAL_REQUEST" | "SCHEDULING", words: string, hint: string | null, medium: "photo" | "video" | "both" | "unclear" = "photo") => ({ kind, text: words, summary: words, medium, projectHint: hint });
  const r1 = await ca.fileAsksFromMessage({ clientId: heather.id, message: "The Northbrook photos need the lot lines, and the sky is too dark", channel: "text", asks: [route("SPECIAL_REQUEST", "the sky is too dark", null)], defaultProjectId: pine.id, revisionProjectId: done.id });
  c.ok("a revision raised for the message, no job named: not filed on the job in flight (audit #6)", r1.filed.length === 0 && r1.skipped.some((s) => s.startsWith("revision brief")), JSON.stringify(r1));
  const r2 = await ca.fileAsksFromMessage({ clientId: heather.id, message: "Fix Northbrook, and for Pine St please get the pool", channel: "text", asks: [route("SPECIAL_REQUEST", "for Pine St please get the pool", pine.id)], defaultProjectId: done.id, revisionProjectId: done.id });
  c.ok("…the brain named another job in flight for it: filed there", r2.filed.length === 1 && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: r2.filed[0] } })).projectId === pine.id);
  const msg = "Please make the twilight sky warmer";
  const r3 = await ca.fileAsksFromMessage({ clientId: heather.id, message: msg, channel: "email", asks: [route("SPECIAL_REQUEST", msg, null)], defaultProjectId: barry.id });
  const r4 = await ca.fileAsksFromMessage({ clientId: heather.id, message: msg, channel: "text", asks: [route("SPECIAL_REQUEST", msg, pine.id)], defaultProjectId: pine.id });
  c.ok("the same message read again files nothing, even when the brain puts it on another job", r3.filed.length === 1 && r4.filed.length === 0 && (await prisma.clientAsk.count({ where: { text: msg } })) === 1, JSON.stringify([r3, r4]));
  const r5 = await ca.fileAsksFromMessage({ clientId: heather.id, message: "Two things: warmer sky on Barry, and the pool on Pine", channel: "text", asks: [route("SPECIAL_REQUEST", "warmer sky on Barry", barry.id), route("SPECIAL_REQUEST", "the pool on Pine", pine.id)], defaultProjectId: barry.id });
  c.ok("…one message naming two jobs still files on both", r5.filed.length === 2);

  // Closing on delivery.
  const onPine = await ca.createAsk({ clientId: heather.id, projectId: pine.id, kind: "SPECIAL_REQUEST", source: "text", medium: "video", text: "Use the upbeat song", askedAt: new Date(now.getTime() - 3 * HOUR) });
  const schedBefore = await ca.createAsk({ clientId: heather.id, projectId: pine.id, kind: "SCHEDULING", source: "text", text: "Can we push the Pine shoot?", askedAt: new Date(now.getTime() - 3 * HOUR) });
  // Oct 21 2026 (oct21-photo-misses, CHANGED): a special request asked AFTER
  // the delivery is about the delivered work and stays open, so the requests
  // filed above (stamped "now") are put before this back-dated delivery, as
  // they were in the story.
  await prisma.clientAsk.updateMany({ where: { projectId: pine.id, kind: "SPECIAL_REQUEST" }, data: { askedAt: new Date(now.getTime() - 2 * HOUR) } });
  await prisma.project.update({ where: { id: pine.id }, data: { status: "DELIVERED", deliveredAt: new Date(now.getTime() - 1 * HOUR) } });
  const schedAfter = await ca.createAsk({ clientId: heather.id, projectId: pine.id, kind: "SCHEDULING", source: "text", text: "Book my next shoot please", askedAt: new Date(now.getTime() - 10 * 60_000) });
  c.ok("the boards leave a delivered job out at once", !(await ca.specialRequestsBoard(now)).groups.some((g) => g.projectId === pine.id) && !(await ca.schedulingBoard(now)).asks.some((a) => a.id === schedBefore!.id) && (await ca.schedulingBoard(now)).asks.some((a) => a.id === schedAfter!.id));
  const swept = await ca.closeAsksOnDeliveredJobs(now);
  const pineRow = await prisma.clientAsk.findUniqueOrThrow({ where: { id: onPine!.id } });
  c.ok("the sweep closes them: DONE, 'the job was delivered', by the Hub", swept.ids.includes(onPine!.id) && pineRow.state === "DONE" && pineRow.confirmNote === "the job was delivered" && pineRow.doneBy === "Hub");
  c.ok("…a scheduling ask asked before the delivery closes; one asked after (book the next shoot) stays", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: schedBefore!.id } })).state === "DONE" && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: schedAfter!.id } })).state === "OPEN");
  const pj = await prisma.photoJob.create({ data: { projectId: barry.id, stage: "DELIVERED", deliveredAt: new Date(now.getTime() - 30 * 60_000) } });
  const vidAsk = await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SPECIAL_REQUEST", source: "text", medium: "video", text: "Vertical please", askedAt: new Date(now.getTime() - 2 * HOUR) });
  const swept2 = await ca.closeAsksOnDeliveredJobs(now);
  c.ok("a photo-only request closes when the photos went out; the video one stays", swept2.ids.includes(lots!.id) && !swept2.ids.includes(vidAsk!.id) && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: lots!.id } })).confirmNote === "the photos were delivered");
  c.ok("…a second sweep finds nothing", (await ca.closeAsksOnDeliveredJobs(now)).closed === 0);
  await prisma.photoJob.delete({ where: { id: pj.id } });
  const op = fs.readFileSync("src/lib/webhooks/openphone.ts", "utf8");
  c.ok("the never-mind re-read starts on the client's inbound texts only", /if \(!isCall && text\.trim\(\) && isInboundText\) \{\s*const \{ reviewAsksAgainstConversation \}/.test(op));
  c.ok("the comms cron closes delivered jobs' asks and runs the alert in one step", /step\("behindAlert"[\s\S]*closeAsksOnDeliveredJobs\(\)[\s\S]*runBehindAlert\(\)/.test(fs.readFileSync("src/app/api/cron/gmail/route.ts", "utf8")));

  // =========================================================================
  c.head("2 · The job box");
  // =========================================================================
  await prisma.clientAsk.deleteMany({});
  const job = await prisma.project.create({
    data: {
      title: "88 Oak Ave, Malvern, PA", clientId: heather.id, status: "EDITING", photographerId: harrison.id,
      notes: "Agent wants the sign in every exterior. Invoice total $350.",
      editorBrief: "Shot front to back.",
      videoInstructions: "Keep it under a minute.",
      removalNotes: "Hose on the side yard.",
      orderItems: { create: [{ title: "Lot Lines", amount: 5000 }, { title: "Virtual Twilight", amount: 3000 }] },
      appointments: { create: [{ aryeoId: "appt-oak", description: "Order Questions:\n - Special Instructions for the photographer (for this property only): The gate code is 4417. Please feature the new kitchen.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
    } as never,
    select: { id: true },
  });
  const flag = (body: string, minsAgo: number, authorId?: string) => prisma.activity.create({ data: { projectId: job.id, type: "FLAG", body, authorId: authorId ?? null, createdAt: new Date(Date.now() - minsAgo * 60_000) } });
  const fPhoto = await flag("The kitchen photos are a bit dark, window pull needed", 50, harrison.id);
  const fVideo = await flag("Drone footage is shaky on the second pass", 40);
  const fLate = await flag("Shoot debrief — had issues: Client was 30 minutes late and the lockbox code was wrong", 30);
  const fUpload = await flag("Upload stalled, the files may be missing a few", 20);
  await flag("Revision requested (text): please redo", 10); // a machine row, never a field flag
  const mk = (medium: string, words: string, summary: string, minsAgo: number) => ca.createAsk({ clientId: heather.id, projectId: job.id, kind: "SPECIAL_REQUEST", source: "text", medium, text: words, summary, askedBy: "Heather Barritt", askedAt: new Date(Date.now() - minsAgo * 60_000) });
  const aPhoto = await mk("photo", "Please brighten the kitchen", "Brighten the kitchen photos", 90);
  const aVideo = await mk("video", "Use the upbeat song", "Use the upbeat song", 80);
  const aBoth = await mk("both", "Lot lines on everything, it is listed at $1.2M", "Lot lines on photos and video ($1.2M listing)", 70);
  const aUnclear = await mk("unclear", "Make it pop", "Make it pop", 60);
  await ca.createAsk({ clientId: heather.id, projectId: job.id, kind: "SPECIAL_REQUEST", source: "order_note", medium: "both", text: "Ordered: Lot Lines", holdsDelivery: false });
  await ca.createAsk({ clientId: heather.id, projectId: job.id, kind: "SCHEDULING", source: "text", text: "Move it to Friday" });

  const { jobChecks } = await import("@/lib/jobChecks");
  me = user("OWNER");
  const photo = await jobChecks(job.id, "photo");
  const video = await jobChecks(job.id, "video");
  c.ok("flags: the photo box has the photo flag and the upload one; the video box the drone flag and the upload one",
    photo.flags.map((f) => f.id).join() === [fPhoto.id, fUpload.id].join() && video.flags.map((f) => f.id).join() === [fVideo.id, fUpload.id].join(), JSON.stringify([photo.flags.map((f) => f.text), video.flags.map((f) => f.text)]));
  c.ok("…the shoot-side flag (late client, wrong code) is on neither box", !photo.flags.some((f) => f.id === fLate.id) && !video.flags.some((f) => f.id === fLate.id));
  c.ok("…who and when: the author, else the job's photographer", photo.flags[0].by === "Harrison Lee" && video.flags[0].by === "Harrison Lee" && !!Date.parse(photo.flags[0].atISO));
  c.ok("requests: photo + both + unclear on the photos, video + both + unclear on the video, oldest first",
    photo.requests.map((r) => r.id).join() === [aPhoto!.id, aBoth!.id, aUnclear!.id].join() && video.requests.map((r) => r.id).join() === [aVideo!.id, aBoth!.id, aUnclear!.id].join() && photo.openRequests === 3 && video.openRequests === 3);
  c.ok("…an order note or a scheduling ask is not a request here", !photo.requests.some((r) => /Ordered|Friday/.test(r.text)));
  const noteText = (d: typeof photo) => d.notes.map((n) => `${n.label}: ${n.text}`).join(" | ");
  c.ok("notes: the order note without the gate code", /On the order: Please feature the new kitchen\./.test(noteText(photo)) && !/4417|gate code/i.test(noteText(photo)), noteText(photo));
  c.ok("…add-ons by medium: lot lines on both, virtual twilight on the photos only", /Add-on ordered: Lot Lines: check it/.test(noteText(photo)) && /Add-on ordered: Virtual Twilight/.test(noteText(photo)) && /Add-on ordered: Lot Lines/.test(noteText(video)) && !/Virtual Twilight/.test(noteText(video)));
  c.ok("…the office note, the photographer's notes, video notes on the video, removals on the photos",
    /From the office: Agent wants the sign/.test(noteText(photo)) && /Photographer's notes: Shot front to back/.test(noteText(video)) && /Video notes: Keep it under a minute/.test(noteText(video)) && /Remove: Hose on the side yard/.test(noteText(photo)) && !/Video notes/.test(noteText(photo)) && !/Remove:/.test(noteText(video)));
  c.ok("the owner sees the amounts", /\$1\.2M/.test(photo.requests[1].summary) && /\$350/.test(noteText(photo)));
  me = user("ADMIN");
  const kylePhoto = await jobChecks(job.id, "photo");
  c.ok("Kyle sees no amount anywhere in the box", !/\$/.test(JSON.stringify(kylePhoto)) && /\[amount\]/.test(kylePhoto.requests[1].summary) && !/Invoice/.test(noteText(kylePhoto)), JSON.stringify(kylePhoto.requests[1]));
  c.ok("an unknown job is an empty box", (await jobChecks("nope-nope-nope", "photo")).flags.length === 0 && (await jobChecks("", "video")).openRequests === 0);

  // One Checked.
  const { confirmJobRequests } = await import("@/app/jobs/actions");
  process.env.AUTH_ENFORCE = "true";
  me = user("OWNER", { impersonating: true, role: "ADMIN" });
  const refused = await confirmJobRequests(job.id, "photo");
  c.ok("view as: refused, nothing changed", !refused.ok && /previewing/i.test(refused.message) && (await prisma.clientAsk.count({ where: { projectId: job.id, state: "CONFIRMED" } })) === 0, refused.message);
  me = user("PHOTOGRAPHER", { name: "Harrison Lee", realName: "Harrison Lee" });
  c.ok("a photographer with no review seat: refused", !(await confirmJobRequests(job.id, "photo")).ok);
  me = user("ADMIN");
  c.ok("a bad job id or medium is refused in plain words", !(await confirmJobRequests("x", "photo")).ok && !(await confirmJobRequests(job.id, "audio" as never)).ok);
  const pressed = await confirmJobRequests(job.id, "photo");
  const after = await prisma.clientAsk.findMany({ where: { projectId: job.id, kind: "SPECIAL_REQUEST", source: "text" } });
  const confirmed = after.filter((a) => a.state === "CONFIRMED");
  c.ok("ONE press confirms every request on the photos, with who", pressed.ok && confirmed.length === 3 && confirmed.every((a) => a.confirmedBy === "Kyle Smith" && a.confirmNote === "checked on the photos") && /Checked 3 requests, saved as checked by Kyle Smith/.test(pressed.message), pressed.message);
  c.ok("…the video's own request stays open", after.find((a) => a.id === aVideo!.id)?.state === "OPEN");
  c.ok("…one line on the job's timeline, not one per message", (await prisma.activity.count({ where: { projectId: job.id, body: { startsWith: "3 client requests checked on the photos by Kyle Smith: " } } })) === 1);
  c.ok("…pressed again: nothing left", /Nothing left to check/.test((await confirmJobRequests(job.id, "photo")).message));
  const photoAfter = await jobChecks(job.id, "photo");
  c.ok("the box now shows no requests and says who checked them", photoAfter.openRequests === 0 && photoAfter.checked?.by === "Kyle Smith" && photoAfter.checked.count === 3);
  c.ok("…the hold on the photos is released", (await ca.openAsksHolding(job.id, "photo")).length === 0 && (await ca.openAsksHolding(job.id, "video")).length === 1);
  delete process.env.AUTH_ENFORCE;

  c.ok("the photo job page and the editor brief carry the box (the photo asks card replaced)",
    /loadBeforeYouSend\(h\.projectId, "photo"\)/.test(fs.readFileSync("src/app/ops/photo-delivery/[jobId]/page.tsx", "utf8")) && /<BeforeYouSendView data=\{box\.data\} medium="photo"/.test(fs.readFileSync("src/app/ops/photo-delivery/[jobId]/page.tsx", "utf8")) && !/OpenClientAsksCard/.test(fs.readFileSync("src/app/ops/photo-delivery/[jobId]/page.tsx", "utf8")) &&
    /loadBeforeYouSend\(project\.id, "video"\)/.test(fs.readFileSync("src/app/edit/[id]/page.tsx", "utf8")) && /medium="video" canCheck=\{beforeYouSend\.canCheck\} hideNotes \/>/.test(fs.readFileSync("src/app/edit/[id]/page.tsx", "utf8")));

  // Oct 20 2026 (audit A2): a Request typed in the job page's composer is the
  // job's client ask too, so the request lists and "Checked" see it.
  const { addProjectNote } = await import("@/app/projects/noteActions");
  me = user("ADMIN", { teamMemberId: kyle.id });
  const reqJob = await prisma.project.create({ data: { title: "9 Request Ln, Malvern, PA", clientId: heather.id, status: "EDITING" }, select: { id: true } });
  const posted = await addProjectNote(reqJob.id, "Client wants the pool cover off in every exterior", "SPECIAL_REQUEST", "photo");
  const filed = await prisma.clientAsk.findMany({ where: { projectId: reqJob.id } });
  c.ok("a Request on a job in flight files the job's client ask (staff, the medium picked, holds delivery until checked)", posted.ok && filed.length === 1 && filed[0].source === "staff" && filed[0].medium === "photo" && filed[0].holdsDelivery && filed[0].state === "OPEN" && /until someone checks it/.test(posted.message) && (await prisma.activity.count({ where: { projectId: reqJob.id, type: "SPECIAL_REQUEST" } })) === 1, JSON.stringify({ posted, filed }));
  c.ok("…it is on the photo card's requests and holds the photos", (await jobChecks(reqJob.id, "photo")).requests.some((r) => r.id === filed[0].id) && (await ca.openAsksHolding(reqJob.id, "photo")).length === 1 && (await ca.openAsksHolding(reqJob.id, "video")).length === 0);
  const officeNote = await addProjectNote(reqJob.id, "Office note only", "NOTE");
  const deliveredReq = await addProjectNote(done.id, "Late thought on a delivered job", "SPECIAL_REQUEST", "video");
  c.ok("…a Note files nothing, and neither does a Request on a delivered job", officeNote.ok && deliveredReq.ok && (await prisma.clientAsk.count({ where: { projectId: { in: [reqJob.id, done.id] } } })) === 1);
  me = user("ADMIN");

  // =========================================================================
  c.head("3 · Shoot flags sorted");
  // =========================================================================
  const { sortShootFlag, ownerShootIssues } = await import("@/lib/shootIssues");
  const cases: [string, string, string][] = [
    ["The kitchen photos are blurry", "job", "photo"],
    ["Drone footage is shaky", "job", "video"],
    ["Upload stalled at 40%", "job", "delivery"],
    ["Client was 45 minutes late", "owner", "both"],
    ["Lockbox code didn’t work, waited 20 min", "owner", "both"],
    ["House wasn’t ready at all", "owner", "both"],
    ["Seller was rude and the dog kept barking", "owner", "both"],
    ["Basement was locked, couldn't get photos of it", "both", "photo"],
    ["Missed shot: the backyard", "job", "both"],
    ["Everything went fine", "job", "both"],
  ];
  const wrong = cases.filter(([w, route, about]) => { const s = sortShootFlag(w); return s.route !== route || s.about !== about; });
  c.ok("the word rule: work → Kyle and the job, the shoot itself → Jordan, both → both, unsure → Kyle", wrong.length === 0, JSON.stringify(wrong.map(([w]) => [w, sortShootFlag(w)])));

  const { fileFieldIssue } = await import("@/lib/fieldIssues");
  const fj = await prisma.project.create({ data: { title: "5 Elm Ct, Malvern, PA", clientId: heather.id, status: "SHOT", photographerId: harrison.id } as never, select: { id: true } });
  me = user("PHOTOGRAPHER", { name: "Harrison Lee", realName: "Harrison Lee", teamMemberId: harrison.id });
  slackPosts.length = 0;
  await prisma.activity.create({ data: { projectId: fj.id, type: "FLAG", body: "The agent was 40 minutes late and the gate was locked" } });
  await fileFieldIssue({ projectId: fj.id, note: "The agent was 40 minutes late and the gate was locked", page: `/shoot/${fj.id}`, label: "Shoot issue", priority: "URGENT" });
  const kyleLoop = () => prisma.smartTask.findFirst({ where: { dedupeKey: `field-flag-${fj.id}` } });
  const jordanLoop = () => prisma.smartTask.findFirst({ where: { dedupeKey: `shoot-owner-${fj.id}` } });
  const jl = await jordanLoop();
  c.ok("a flag about the shoot itself: no loop for Kyle", !(await kyleLoop()));
  c.ok("…Jordan's own loop, assigned to him, flagged by the creative, in their words", !!jl && jl.assignedKey === "jordan" && jl.ownerId === jordan.id && jl.flaggedBy === "Harrison Lee" && /40 minutes late/.test(jl.description ?? "") && jl.title === "Shoot issue: 5 Elm Ct" && /^owner \/shoot\//.test(jl.sourceDetail ?? ""));
  c.ok("…the owner's bell only, and no ops ping to Kyle", (await prisma.notification.count({ where: { title: "Shoot issue for you: 5 Elm Ct", audience: '["OWNER"]' } })) === 1 && slackPosts.length === 0 && (await prisma.notification.count({ where: { title: { startsWith: "Shoot issue —" } } })) === 0);
  c.ok("…who flagged it stamped on the FLAG row", (await prisma.activity.findFirstOrThrow({ where: { projectId: fj.id, type: "FLAG" } })).authorId === harrison.id);
  await prisma.activity.create({ data: { projectId: fj.id, type: "FLAG", body: "Twilight photos came out too dark" } });
  await fileFieldIssue({ projectId: fj.id, note: "Twilight photos came out too dark", page: `/upload/${fj.id}`, label: "Shoot issue" });
  const kl = await kyleLoop();
  c.ok("a flag about the photos: Kyle's loop as before, the ops ping and the office bell", !!kl && kl.assignedKey === "kyle" && kl.ownerId === kyle.id && slackPosts.length === 1 && /Twilight photos/.test(slackPosts[0].text) && (await prisma.notification.count({ where: { title: "Shoot issue — 5 Elm Ct", audience: '["OWNER","ADMIN"]' } })) === 1);
  c.ok("…and nothing added to Jordan's loop", !/Twilight/.test((await jordanLoop())?.description ?? ""));
  await prisma.activity.create({ data: { projectId: fj.id, type: "FLAG", body: "Shoot debrief — had issues: Homeowner wouldn't let me shoot the basement photos" } });
  await fileFieldIssue({ projectId: fj.id, note: "Homeowner wouldn't let me shoot the basement photos", page: `/upload/${fj.id}`, label: "Shoot debrief", priority: "HIGH" });
  c.ok("both kinds of words: on Kyle's loop and Jordan's", /basement/.test((await kyleLoop())?.description ?? "") && /basement/.test((await jordanLoop())?.description ?? ""));
  c.ok("Kyle's loop lookup never takes Jordan's loop for one of its own", (await prisma.smartTask.count({ where: { projectId: fj.id, taskType: "internal_instruction" } })) === 2);
  const owner = await ownerShootIssues(new Date());
  c.ok("Jordan's list: the open loop with the newest words, and the count by client", owner.open.length === 1 && owner.open[0].street === "5 Elm Ct" && /basement/.test(owner.open[0].text) && owner.open[0].href === `/projects/${fj.id}` && owner.byClient.some((b) => b.client === "Heather Barritt" && b.count >= 3), JSON.stringify(owner));
  const box = await jobChecks(fj.id, "photo");
  c.ok("the job box shows the photo flags, never the shoot-only one", box.flags.some((f) => /Twilight/.test(f.text)) && box.flags.some((f) => /basement/.test(f.text)) && !box.flags.some((f) => /40 minutes late/.test(f.text)));
  me = null;

  // =========================================================================
  c.head("4 · We're behind");
  // =========================================================================
  const ba = await import("@/lib/behindAlert");
  c.ok("levels: none ok; 1-2 behind; 3+ or one 48 h late very behind", ba.levelFor(0, null) === "ok" && ba.levelFor(1, 5) === "behind" && ba.levelFor(2, 47) === "behind" && ba.levelFor(3, 1) === "very_behind" && ba.levelFor(1, 48) === "very_behind");
  const item = (kind: "video" | "photo", street: string, lateHours: number, who: string) => ({ kind, projectId: `p-${street}`, street, lateHours, who, href: "/x" });
  const s1 = ba.stateOf([item("video", "9 Elm Ct", 5, "With Kim (editing)")]);
  c.ok("one video 5 h late: behind, 'is late by 5 h.'", s1.level === "behind" && s1.videosLate === 1 && s1.headline === "1 video is late by 5 h.", s1.headline ?? "");
  const s2 = ba.stateOf([item("video", "A St", 80, "x"), item("photo", "B St", 3, "y"), item("photo", "C St", 1, "z")]);
  c.ok("the worse kind wins (a video 80 h late), and the headline names both", s2.level === "very_behind" && s2.headline === "1 video and 2 photo jobs are late, the oldest by 3 days." && s2.oldestLateHours === 80, s2.headline ?? "");
  c.ok("photos use the same thresholds", ba.stateOf([item("photo", "a", 1, ""), item("photo", "b", 1, ""), item("photo", "c", 1, "")]).level === "very_behind" && ba.stateOf([item("photo", "a", 50, "")]).level === "very_behind");
  const m = ba.behindMessage("raise", s2, [item("video", "A St", 80, "With Kim (editing)"), item("photo", "B St", 3, "Ready for Kyle to review and send")], "https://hub.example");
  c.ok("the message: what, how late, who has it, and the plain ask", /^We're very behind: 1 listing video and 2 photo jobs are past the promise\./.test(m) && m.includes("• A St (video): 3 days late. With Kim (editing).") && m.includes("• B St (photos): 3 h late. Ready for Kyle to review and send.") && m.includes("Reply here with your plan for each one."), m);
  c.ok("…no em dash, no money", !DASH.test(m) && !/\$/.test(m));

  const pm = ba.behindMessage("raise", ba.stateOf([item("photo", "B St", 3, "Ready for Kyle to review and send")]), [item("photo", "B St", 3, "Ready for Kyle to review and send")], "https://hub.example");
  c.ok("a photo-only message: no thread ask (it is a DM), the Photo delivery link", /^We're behind: 1 photo job is past the promise\./.test(pm) && !pm.includes("Reply here") && pm.includes("|Photo delivery>") && !pm.includes("Video Review Room"), pm);

  // Oct 21 2026 (Jordan: "Photo delivery behind notifications should not go to
  // the video editing chat. Just me and Kyle."): each kind runs on its own.
  let items: ReturnType<typeof item>[] = [];
  let failRead = false;
  ba.__setBehindSourceForTests(async () => { if (failRead) throw new Error("board down"); return items; });
  const posts: { kind: string; text: string }[] = [];
  const deps = { post: async (text: string, kind: "video" | "photo") => { posts.push({ kind, text }); return { ok: true, where: kind === "video" ? "#video-editing" : "a DM" }; } };
  const vp = () => posts.filter((p) => p.kind === "video");
  const pp = () => posts.filter((p) => p.kind === "photo");
  const at = (iso: string) => new Date(iso);
  const bells = (key: string) => prisma.notification.count({ where: { dedupeKey: { startsWith: key } } });
  // The switch-over: the old combined state said very behind and posted.
  await prisma.appSetting.create({ data: { key: "behindAlert.state", value: JSON.stringify({ level: "very_behind", since: "2026-10-19T20:00:00.000Z", posted: true, lastPostAt: "2026-10-19T20:00:00.000Z" }), updatedBy: "drill" } });
  items = [item("photo", "615 Cliff Ln", 190, "The delivery needs a look")];
  const t0 = await ba.runBehindAlert(at("2026-10-19T20:30:00Z"), deps);
  c.ok("the switch-over: the photo job already announced is not announced again, and no false 'back on track' for videos", t0.photo.posted === null && t0.video.posted === null && posts.length === 0, JSON.stringify(t0));
  items = [];
  const t0b = await ba.runBehindAlert(at("2026-10-19T21:00:00Z"), deps);
  c.ok("…it clears: 'Photos are back on track' goes to the photo people only", t0b.photo.posted === "clear" && t0b.video.posted === null && posts.length === 1 && posts[0].kind === "photo" && posts[0].text === "Photos are back on track: no photo job is past its promise now.", JSON.stringify(posts));
  posts.length = 0;

  items = [item("video", "9 Elm Ct", 5, "With Kim (editing)")];
  const t1 = await ba.runBehindAlert(at("2026-10-20T18:00:00Z"), deps);
  c.ok("videos behind for the first time: ONE video post, and bells for the owner and office and the editors", t1.video.posted === "raise" && t1.photo.posted === null && posts.length === 1 && posts[0].kind === "video" && /We're behind: 1 listing video is past the promise/.test(posts[0].text) && (await bells("behind-video-raise-2026-10-20-behind")) === 2 && (await prisma.notification.count({ where: { dedupeKey: "behind-video-raise-2026-10-20-behind-1", audience: '["EDITOR"]' } })) === 1, JSON.stringify(t1));
  const t2 = await ba.runBehindAlert(at("2026-10-20T18:05:00Z"), deps);
  c.ok("…the next tick, still behind: nothing", t2.video.posted === null && posts.length === 1);
  items = [item("video", "9 Elm Ct", 5, "a"), item("video", "10 Elm Ct", 4, "b"), item("photo", "11 Elm Ct", 2, "c"), item("video", "12 Elm Ct", 1, "d")];
  const t3 = await ba.runBehindAlert(at("2026-10-20T18:10:00Z"), deps);
  c.ok("it gets worse (3 videos late): one more video post, 'very behind', listing only the videos", t3.video.posted === "raise" && vp().length === 2 && /^We're very behind: 3 listing videos/.test(vp()[1].text) && !vp()[1].text.includes("11 Elm Ct"), JSON.stringify(vp()));
  c.ok("…and the late photo job is its own message, to the photo people, not #video-editing", t3.photo.posted === "raise" && pp().length === 1 && pp()[0].text.includes("11 Elm Ct (photos)") && !pp()[0].text.includes("Elm Ct (video)") && (await bells("behind-photo-raise-2026-10-20-behind")) >= 1 && (await prisma.notification.count({ where: { dedupeKey: { startsWith: "behind-photo-" }, audience: { contains: "EDITOR" } } })) === 0, JSON.stringify(pp()));
  c.ok("…and again nothing on the next tick", (await ba.runBehindAlert(at("2026-10-20T18:15:00Z"), deps)).video.posted === null && posts.length === 3);
  c.ok("a morning tick outside 8 to 10 AM ET: nothing", (await ba.runBehindAlert(at("2026-10-21T11:30:00Z"), deps)).video.posted === null && posts.length === 3);
  const t5 = await ba.runBehindAlert(at("2026-10-21T12:30:00Z"), deps);
  c.ok("still behind next morning (8:30 AM ET): one morning message per kind", t5.video.posted === "morning" && t5.photo.posted === "morning" && posts.length === 5 && /^Good morning\. We're still behind/.test(vp()[2].text) && /^Good morning\. We're still behind: 1 photo job/.test(pp()[1].text));
  c.ok("…once: the 8:35 tick posts nothing", (await ba.runBehindAlert(at("2026-10-21T12:35:00Z"), deps)).video.posted === null && posts.length === 5);
  failRead = true;
  const tf = await ba.runBehindAlert(at("2026-10-21T13:00:00Z"), deps);
  c.ok("a read that fails: skipped, nothing posted, nothing changed (never a false back on track)", tf.video.level === null && !!tf.video.skipped && tf.photo.level === null && posts.length === 5);
  failRead = false;
  items = [item("photo", "11 Elm Ct", 3, "c")];
  const t7 = await ba.runBehindAlert(at("2026-10-21T13:30:00Z"), deps);
  c.ok("the videos clear while the photo job is still late: 'Videos are back on track' in #video-editing, nothing for photos", t7.video.posted === "clear" && t7.photo.posted === null && posts.length === 6 && vp()[3].text === "Videos are back on track: no listing video is past its promise now. Thanks, team.", JSON.stringify(t7));
  c.ok("…once", (await ba.runBehindAlert(at("2026-10-21T13:35:00Z"), deps)).video.posted === null && posts.length === 6);
  items = [];
  const t8 = await ba.runBehindAlert(at("2026-10-21T14:00:00Z"), deps);
  c.ok("…then the photo job clears: 'Photos are back on track' to the photo people", t8.photo.posted === "clear" && posts.length === 7 && pp()[2].text === ba.backOnTrackMessage("photo"));
  items = [item("video", "7 Pine Rd", 2, "With Kim (editing)")];
  c.ok("videos behind again later that day (a new level for the day): posts", (await ba.runBehindAlert(at("2026-10-21T17:00:00Z"), deps)).video.posted === "raise" && posts.length === 8);
  items = [];
  c.ok("…clears: back on track", (await ba.runBehindAlert(at("2026-10-21T17:30:00Z"), deps)).video.posted === "clear" && posts.length === 9);
  items = [item("video", "7 Pine Rd", 2, "x")];
  await ba.runBehindAlert(at("2026-10-21T18:00:00Z"), deps);
  items = [];
  await ba.runBehindAlert(at("2026-10-21T18:30:00Z"), deps);
  c.ok("a flap the same day posts nothing more (no raise, so no back on track either)", posts.length === 9);
  items = [item("video", "3 Oak", 2, "x")];
  await ba.runBehindAlert(at("2026-10-22T11:00:00Z"), deps); // 7 AM ET: the day's first post
  const tm = await ba.runBehindAlert(at("2026-10-22T12:30:00Z"), deps);
  c.ok("posted at 7 AM: the 8:30 morning post is skipped", tm.video.posted === null && posts.length === 10);
  items = [];
  await ba.runBehindAlert(at("2026-10-22T13:00:00Z"), deps);

  // The real Slack path (faked at the fence).
  slackPosts.length = 0;
  items = [item("video", "4 Real St", 6, "Waiting on review (version 2)")];
  const tr = await ba.runBehindAlert(at("2026-10-23T18:00:00Z"));
  c.ok("the real path posts videos in #video-editing (its known channel id)", tr.video.posted === "raise" && tr.video.where === "#video-editing" && slackPosts.length === 1 && slackPosts[0].channel === ba.VIDEO_EDITING_CHANNEL_ID && slackPosts[0].text.includes("4 Real St (video): 6 h late. Waiting on review (version 2).") && slackPosts[0].text.includes("Reply here with your plan for each one."), JSON.stringify(slackPosts));
  items = [];
  await ba.runBehindAlert(at("2026-10-23T18:30:00Z"));
  videoEditingRefuses = true;
  slackPosts.length = 0;
  items = [item("video", "4 Real St", 6, "x")];
  const tfb = await ba.runBehindAlert(at("2026-10-24T18:00:00Z"));
  c.ok("the bot not in #video-editing: the same text goes to the ops alert line, saying so", tfb.video.where === "the ops alert line" && slackPosts.length === 1 && slackPosts[0].channel !== ba.VIDEO_EDITING_CHANNEL_ID && /^\(For #video-editing, the hub could not post there\.\)/.test(slackPosts[0].text), JSON.stringify(slackPosts));
  videoEditingRefuses = false;
  items = [];
  await ba.runBehindAlert(at("2026-10-24T18:30:00Z"));

  // Photos: a DM to Jordan and Kyle (the ops alert people), never #video-editing.
  await prisma.teamMember.updateMany({ where: { id: { in: [jordan.id, kyle.id] } }, data: { opsAlerts: true } });
  await prisma.appUser.create({ data: { email: "owner@drill.test", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } as never });
  slackPosts.length = 0;
  items = [item("photo", "615 Cliff Ln", 30, "The delivery needs a look")];
  const tp = await ba.runBehindAlert(at("2026-10-27T18:00:00Z"));
  const chans = slackPosts.map((x) => x.channel).sort();
  c.ok("the real photo path: one DM each to Jordan and Kyle, nothing in #video-editing", tp.photo.posted === "raise" && tp.photo.where === "a DM to Jordan and Kyle" && JSON.stringify(chans) === JSON.stringify(["U0JORDAN", "U0KYLE"]) && slackPosts.every((x) => x.text.includes("615 Cliff Ln (photos): 30 h late.")), JSON.stringify({ tp, slackPosts }));
  const pb = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: "behind-photo-raise-2026-10-27" } }, select: { audience: true, userKey: true, href: true } });
  c.ok("…bells: the owner's logins and Kyle by name; not the office role (James), not the editors, Jordan not twice", pb.length === 2 && pb.some((r) => r.audience === '["OWNER"]' && !r.userKey) && pb.some((r) => r.userKey === `tm:${kyle.id}`) && pb.every((r) => r.href === "/ops/photo-delivery" && !r.audience.includes("EDITOR")), JSON.stringify(pb));
  items = [];
  await ba.runBehindAlert(at("2026-10-27T18:30:00Z"));
  videoEditingRefuses = false;
  ba.__setBehindSourceForTests(null);

  // The real read: a late photo job counts; a cancelled one and a test client's do not.
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "behindAlert.state" } } });
  const late = await prisma.project.create({ data: { title: "77 Late Ln, Malvern, PA", clientId: heather.id, status: "EDITING" }, select: { id: true } });
  await prisma.photoJob.create({ data: { projectId: late.id, stage: "READY", slaDueAt: new Date(Date.now() - 5 * HOUR) } });
  const cancelled = await prisma.project.create({ data: { title: "1 Gone Rd", clientId: heather.id, status: "CANCELLED" }, select: { id: true } });
  await prisma.photoJob.create({ data: { projectId: cancelled.id, stage: "EDITING", slaDueAt: new Date(Date.now() - 50 * HOUR) } });
  const testClient = await prisma.client.create({ data: { name: "Bobby TEST" }, select: { id: true } });
  const testJob = await prisma.project.create({ data: { title: "1 Test Way", clientId: testClient.id, status: "EDITING" }, select: { id: true } });
  await prisma.photoJob.create({ data: { projectId: testJob.id, stage: "EDITING", slaDueAt: new Date(Date.now() - 50 * HOUR) } });
  let real: Awaited<ReturnType<typeof ba.behindReport>> | null = null;
  let realErr = "";
  try { real = await ba.behindReport(new Date(), { fresh: true }); } catch (e) { realErr = String((e as Error)?.message ?? e); }
  c.ok("the real read: one late photo job (77 Late Ln, ready for Kyle), behind", !!real && real.state.photosLate === 1 && real.items.some((i) => i.street === "77 Late Ln" && /Ready for Kyle/.test(i.who)) && real.state.level === "behind", realErr || JSON.stringify(real?.state));
  const home = await ba.behindState(new Date());
  c.ok("behindState (Home's red line) says the same in one sentence", home.level === "behind" && home.headline === "1 photo job is late by 5 h.", JSON.stringify(home));

  c.head("5 · A shoot's flags clear once the job is delivered (Oct 19 2026)");
  {
    const si = await import("@/lib/shootIssues");
    const delivered = await prisma.project.create({ data: { title: "9 Done Way, Malvern, PA", clientId: heather.id, status: "DELIVERED", deliveredAt: new Date() }, select: { id: true } });
    const revising = await prisma.project.create({ data: { title: "8 Again Rd, Malvern, PA", clientId: heather.id, status: "REVISION" }, select: { id: true } });
    const loop = (projectId: string, key: string) => prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Shoot issue: x", dedupeKey: key, projectId, flaggedAt: new Date() } as never, select: { id: true } });
    const k1 = await loop(delivered.id, `shoot-issue-${delivered.id}`);
    const j1 = await loop(delivered.id, si.ownerShootLoopKey(delivered.id));
    const k2 = await loop(revising.id, `shoot-issue-${revising.id}`);
    const r = await si.closeShootFlagsOnDeliveredJobs();
    const after = await prisma.smartTask.findMany({ where: { id: { in: [k1.id, j1.id, k2.id] } }, select: { id: true, status: true, summary: true } });
    const st = (id: string) => after.find((x) => x.id === id);
    c.ok("Kyle's and Jordan's flag loops on the delivered job are completed, saying why", st(k1.id)?.status === "COMPLETED" && st(j1.id)?.status === "COMPLETED" && (st(k1.id)?.summary ?? "").startsWith("Closed by the hub: the job was delivered."), JSON.stringify(after));
    c.ok("a job back in revisions keeps its flag", st(k2.id)?.status === "OPEN");
    c.ok("it counts what it closed, and a second pass closes nothing", r.closed >= 2 && (await si.closeShootFlagsOnDeliveredJobs()).closed === 0);
  }

  c.head("Nothing left the hub");
  c.ok("the fence held (Slack answered by the fake only)", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

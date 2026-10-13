// ---------------------------------------------------------------------------
// DRILL: Oct 13 2026 — listing delivery records itself (Jordan: "There should
// be a webhook that checks when something was delivered or uploaded").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct13-listing-autodeliver.ts
//
//   1  the listing check records the UPLOAD itself when the job's Aryeo listing
//      gains exactly the videos owed after the file was ready — as "Aryeo
//      listing check", dated when the video went up, never as a person;
//   2  …and leaves the row for a person when it cannot tell: more new videos
//      than owed, a client complaint since the file was ready, a person who
//      undid the upload, nothing new on the listing;
//   3  Aryeo's signed LISTING_DELIVERED closes the row AT ONCE on the webhook
//      (upload recorded and send settled by the same event);
//   4  the one manual fallback, "Mark as delivered", records the upload and the
//      send in one press, and only for a current Aryeo version.
//
// ISOLATION: PGlite on 127.0.0.1:6913 via the shared harness. Aryeo's listing
// read is the one scripted provider answer; every other call is fenced.
// Nothing reaches a client or a provider.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, portFree } from "./_harness";

const PORT = 6913;
installNextStubs();

type Listing = { delivery_status: string; videos: { id: string; duration: number; title: string }[] };
const LISTINGS = new Map<string, Listing>();
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapOnce = <T extends object>(make: (m: T) => T) => {
  const cache = new WeakMap<object, T>();
  return (loaded: unknown) => {
    const m = loaded as T;
    if (!cache.has(m)) cache.set(m, make(m));
    return cache.get(m);
  };
};
interceptModule(
  (r) => isMod(r, "integrations/aryeo"),
  wrapOnce<Record<string | symbol, unknown>>((m) => {
    const real = m.Aryeo as Record<string | symbol, unknown>;
    const Aryeo = new Proxy(real, {
      get: (t, k) => k === "listing"
        ? async (id: string) => { const l = LISTINGS.get(id); if (!l) throw new Error(`404 no such listing ${id}`); return { ...l, id }; }
        : t[k],
    });
    return new Proxy(m, { get: (t, k) => (k === "Aryeo" ? Aryeo : t[k]) });
  }),
);
const fence = fenceFetch((url) => (url === "https://slack.com/api/chat.postMessage"
  ? new Response(JSON.stringify({ ok: true, ts: "1.1" }), { headers: { "content-type": "application/json" } })
  : null));

/** A UUIDv7 whose first 48 bits are `ms` — how the hub dates an Aryeo video. */
const v7 = (ms: number, tail = "0123456789ab") => { const t = Math.floor(ms).toString(16).padStart(12, "0"); return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-${tail}`; };
const HOUR = 3_600_000;

async function main() {
  if (!(await portFree(PORT))) throw new Error(`Fixture port ${PORT} is busy; existing process left untouched`);
  const db = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct13-listing-autodeliver-isolated" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const rts = await import("@/lib/readyToSend");
    const du = await import("@/lib/deliveryUploads");
    const ad = await import("@/lib/aryeoDelivery");
    const luc = await import("@/lib/listingUploadCheck");
    const pd = await import("@/lib/projectDelivery");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");

    const fp = async (id: string) => sourceFingerprint((await loadCut(id))!)!;
    const cooled = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-" } } });
    const cut = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id }, select: { sentToClientAt: true, sentToClientBy: true } });
    const rowOf = async (id: string) => (await rts.readyToSend()).ready.find((r) => r.submissionId === id) ?? null;
    const client = await prisma.client.create({ data: { name: "Listing Check Agent" }, select: { id: true } });
    const T0 = Date.now() - 48 * HOUR;
    let orders = 0;
    const mkJob = (street: string, listingId: string | null) => prisma.project.create({
      data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", aryeoListingId: listingId, aryeoOrderId: listingId ? `ord-o13-${++orders}` : null },
      select: { id: true },
    });
    const mkRendered = async (projectId: string, name: string, slot = 1, lengthSec = 59) => {
      const d = await prisma.deliverable.create({ data: { projectId, type: "VIDEO", quantity: 1, productTitle: name }, select: { id: true } });
      await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId, slot, category: "VIDEO" } });
      const s = await prisma.reviewSubmission.create({
        data: { projectId, deliverableId: d.id, slot, round: 1, status: "APPROVED", fileName: `${name}.mov`, blobUrl: `https://drill.invalid/${encodeURIComponent(name)}.mov`, sizeBytes: 1000, decidedAt: new Date(T0), decidedBy: "James" },
        select: { id: true },
      });
      const task = await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: `Upload the 1080p video to Aryeo — ${name}`, projectId, dedupeKey: `topaz-deliver-${s.id}`, status: "OPEN" }, select: { id: true } });
      await prisma.topazJob.create({
        data: { submissionId: s.id, projectId, state: "done", fileName: `${name}.mov`, sourceDurationSec: lengthSec, savedAt: new Date(T0 + 30 * 60_000), finishedAt: new Date(T0 + 30 * 60_000), finalPath: `/Final/${name} - FINAL (Topaz).mp4`, outputCheck: "verified", taskId: task.id },
      });
      return s.id;
    };
    const signedEvent = (listingId: string, eventId: string) => ({ object: "ACTIVITY", id: eventId, name: "LISTING_DELIVERED", occurred_at: new Date().toISOString(), resource: { object: "LISTING", id: listingId } });

    // =======================================================================
    c.head("1 · a new video on the listing, exactly what is owed → the upload records itself");
    // =======================================================================
    const LA = "01a0c0c0-2222-7222-8333-444455550001";
    const A = await mkJob("1 Upload Seen Way", LA);
    const a = await mkRendered(A.id, "Upload Seen reel");
    const upAt = T0 + 3 * HOUR;
    LISTINGS.set(LA, { delivery_status: "PROCESSING", videos: [{ id: v7(upAt), duration: 59, title: "Cinematic Video" }] });
    c.ok("before: the row is in Ready for upload with no receipt", !!(await rowOf(a)) && !(await rowOf(a))!.uploaded);
    const swept = await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    const receipt = (await du.uploadsFor([a])).get(a);
    c.ok("the scheduled check recorded the upload", swept.uploaded === 1 && !!receipt, JSON.stringify(swept.jobs.map((j) => j.note)));
    c.ok("…as the Aryeo listing check, never as a person", receipt?.actor === du.LISTING_CHECK_ACTOR && receipt.actorId === null);
    c.ok("…dated when the video went up, for the exact current version", receipt?.uploadedAt === new Date(upAt).toISOString() && receipt.sourceFingerprint === await fp(a) && receipt.finalContentHash == null);
    c.ok("…the row now waits on Aryeo's delivery, not on a press", (await rowOf(a))?.uploaded?.by === du.LISTING_CHECK_ACTOR && !(await cut(a)).sentToClientAt);
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    c.ok("a second pass writes nothing more", (await prisma.auditLog.count({ where: { target: a, action: "video_uploaded" } })) === 1);

    // =======================================================================
    c.head("2 · when the listing can't tell, the row is left for a person");
    // =======================================================================
    const LB = "01a0c0c0-2222-7222-8333-444455550002";
    const B = await mkJob("2 Two Videos Ct", LB);
    const b = await mkRendered(B.id, "Two Videos reel");
    const lb = { delivery_status: "PROCESSING", videos: [{ id: v7(T0 + 3 * HOUR, "00000000000b"), duration: 59, title: "Video" }, { id: v7(T0 + 4 * HOUR, "00000000000c"), duration: 59, title: "Video 2" }] };
    const rb = await luc.recordUploadsSeenOnListing(LB, { id: LB, ...lb });
    c.ok("two new videos for one owed: nothing recorded", rb.recorded.length === 0 && !(await du.uploadsFor([b])).has(b), rb.note);

    const LC = "01a0c0c0-2222-7222-8333-444455550003";
    const C = await mkJob("3 Complaint Rd", LC);
    const cc = await mkRendered(C.id, "Complaint reel");
    await prisma.revisionBrief.create({ data: { projectId: C.id, source: "openphone", originalText: "The video has no sound", createdAt: new Date(T0 + 2 * HOUR) } });
    const rc = await luc.recordUploadsSeenOnListing(LC, { id: LC, delivery_status: "PROCESSING", videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Video" }] });
    c.ok("a client complaint since the file was ready: nothing recorded (play it first)", rc.recorded.length === 0 && !(await du.uploadsFor([cc])).has(cc), rc.note);

    const LD = "01a0c0c0-2222-7222-8333-444455550004";
    const D = await mkJob("4 Undone Ave", LD);
    const d = await mkRendered(D.id, "Undone reel");
    const ld = { id: LD, delivery_status: "PROCESSING", videos: [{ id: v7(Date.now() - 60_000), duration: 59, title: "Video" }] };
    const first = await luc.recordUploadsSeenOnListing(LD, ld);
    c.ok("recorded once", first.recorded.length === 1);
    const undo = await du.undoUpload(d, await fp(d), { id: null, name: "Kyle" });
    c.ok("Kyle undoes it as a mistake", undo.ok, undo.message);
    const again = await luc.recordUploadsSeenOnListing(LD, ld);
    c.ok("…and the check never writes it back over his word", again.recorded.length === 0 && !(await du.uploadsFor([d])).has(d), again.note);

    const LE = "01a0c0c0-2222-7222-8333-444455550005";
    const E = await mkJob("5 Old Video Ln", LE);
    const e = await mkRendered(E.id, "Old Video reel");
    const re = await luc.recordUploadsSeenOnListing(LE, { id: LE, delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 10 * 60_000), duration: 59, title: "Old" }] });
    c.ok("only a video from before the file was ready: nothing recorded", re.recorded.length === 0 && !(await du.uploadsFor([e])).has(e), re.note);

    // =======================================================================
    c.head("3 · Aryeo's signed LISTING_DELIVERED closes the row at once");
    // =======================================================================
    const LF = "01a0c0c0-2222-7222-8333-444455550006";
    const F = await mkJob("6 Webhook Way", LF);
    const f = await mkRendered(F.id, "Webhook reel");
    LISTINGS.set(LF, { delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 5 * HOUR), duration: 59, title: "Webhook Video" }] });
    await cooled();
    const ev = await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LF, "evt-o13-f"), { authenticated: true });
    const fRow = await cut(f);
    c.ok("one signed event: the row is closed, no hourly wait", !!fRow.sentToClientAt && !(await rowOf(f)), ev.note);
    c.ok("…recorded as Aryeo's confirmation", (fRow.sentToClientBy ?? "").startsWith("Aryeo (delivery confirmed)"), fRow.sentToClientBy ?? "");
    c.ok("…with the upload recorded by the listing check, not a person", (await du.uploadsFor([f])).get(f)?.actor === du.LISTING_CHECK_ACTOR);
    // Row 1 above: its upload was recorded; the listing is delivered later.
    LISTINGS.set(LA, { delivery_status: "DELIVERED", videos: [{ id: v7(upAt), duration: 59, title: "Cinematic Video" }] });
    await cooled();
    await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LA, "evt-o13-a"), { authenticated: true });
    c.ok("an upload the check recorded earlier is settled by the delivery event", !!(await cut(a)).sentToClientAt && !(await rowOf(a)));

    // =======================================================================
    c.head("4 · the one manual fallback: Mark as delivered");
    // =======================================================================
    const LG = "01a0c0c0-2222-7222-8333-444455550007";
    const G = await mkJob("7 By Hand Blvd", LG);
    const g = await mkRendered(G.id, "By Hand reel");
    const stale = await pd.markDeliveredByHand(g, "not-the-current-file", { id: null, name: "Kyle" });
    c.ok("a stale file is refused and nothing is written", !stale.ok && !(await du.uploadsFor([g])).has(g) && !(await cut(g)).sentToClientAt, stale.message);
    const byHand = await pd.markDeliveredByHand(g, await fp(g), { id: null, name: "Kyle" });
    const gRow = await cut(g);
    c.ok("one press records the upload AND the send", byHand.ok && byHand.sent === true && (await du.uploadsFor([g])).get(g)?.actor === "Kyle" && !!gRow.sentToClientAt && gRow.sentToClientBy === "Kyle", byHand.message);
    c.ok("…and the row leaves the card", !(await rowOf(g)));
    const twice = await pd.markDeliveredByHand(g, await fp(g), { id: null, name: "Kyle" });
    c.ok("a second press says it is already done", twice.ok && /already/i.test(twice.message));
    const H = await mkJob("8 No Listing St", null);
    const h = await mkRendered(H.id, "No Listing reel");
    const noListing = await pd.markDeliveredByHand(h, await fp(h), { id: null, name: "Kyle" });
    c.ok("a job with no Aryeo listing is refused (link it first)", !noListing.ok && !(await cut(h)).sentToClientAt, noListing.message);

    c.ok("nothing reached a provider or a client", fence.blocked.every((u) => !/aryeo|openphone|quo|dropbox|topaz/i.test(u)), fence.blocked.join(", "));
    c.summary();
  } finally {
    await db.stop();
    fence.restore();
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });

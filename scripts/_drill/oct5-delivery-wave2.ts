// ---------------------------------------------------------------------------
// DRILL: Oct 5 2026, wave 2 — video delivery, simple and true.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-delivery-wave2.ts
//
//   1  Aryeo's own SIGNED delivery event, or the hub's delivery text that the
//      provider ACCEPTED, closes a listing row by itself — with no upload
//      receipt from Kyle — and is recorded as "Aryeo (delivery confirmed)",
//      never as Kyle's upload. Unsigned posts, failed texts and a delivery that
//      predates the video close nothing. Kyle's two buttons still work by hand.
//   2  a job with no linked Aryeo listing is not offered an upload the server
//      would refuse: its row says "Link the Aryeo listing first"
//   3  an owner/admin can undo a mistaken "Mark as Uploaded" the same ET day;
//      it is audited, keeps the original receipt in history, and is refused
//      for another day, a changed file, a sent video or a non-office user
//   4  Kyle's delivery alerts go to the DELIVERY duty owner, not to "the one
//      active name containing Kyle" (which broke on a second Kyle)
//   5  the hourly publication repair waits silently while a monthly video's
//      1080p pass is still pending, instead of writing a library failure
//   6  the edit page hides "send from the Final folder" on monthly jobs and
//      hands the selected video to the Start bar
//
// ISOLATION: PGlite on 127.0.0.1:6647 (this builder's range 6640-6659) via the
// shared harness. Aryeo's listing read is the one provider answer that is
// scripted; every other outbound call is fenced, Slack is a recording fake.
// Nothing reaches a client or a provider.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = 6647;
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const atHead = (p: string) => execFileSync("git", ["show", `HEAD:${p}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

installNextStubs();

// ---- Aryeo's listing read: the one scripted provider answer ----------------
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

// ---- the office gate, switchable: a non-office caller must be refused -------
let notOffice = false;
interceptModule(
  (r) => isMod(r, "auth/guards"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get: (t, k) => k === "requireAdmin"
      ? async () => { if (notOffice) throw new Error("Only the office can do that."); return (t.requireAdmin as () => Promise<void>)(); }
      : t[k],
  })),
);

const slackPosts: { channel: string; text: string }[] = [];
const fence = fenceFetch((url, init) => {
  if (url !== "https://slack.com/api/chat.postMessage") return null;
  const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
  slackPosts.push({ channel: body.channel ?? "", text: body.text ?? "" });
  return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { headers: { "content-type": "application/json" } });
});

/** A UUIDv7 whose first 48 bits are `ms` — how the hub dates an Aryeo video. */
const v7 = (ms: number) => { const t = Math.floor(ms).toString(16).padStart(12, "0"); return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-0123456789ab`; };
const HOUR = 3_600_000;

async function main() {
  if (!(await portFree(PORT))) throw new Error(`Fixture port ${PORT} is busy; existing process left untouched`);
  const db = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct5-delivery-wave2-isolated" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const rts = await import("@/lib/readyToSend");
    const du = await import("@/lib/deliveryUploads");
    const ad = await import("@/lib/aryeoDelivery");
    const ops = await import("@/app/ops/actions");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    const { deliveryReadyMessage } = await import("@/lib/deliveryReadyMessage");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("slack", "xoxb-drill-not-a-real-token");

    const fp = async (id: string) => sourceFingerprint((await loadCut(id))!)!;
    const cooled = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-" } } });
    const cut = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id }, select: { sentToClientAt: true, sentToClientBy: true } });
    const rowOf = async (id: string) => (await rts.readyToSend()).ready.find((r) => r.submissionId === id) ?? null;
    const client = await prisma.client.create({ data: { name: "Wave Two Agent" }, select: { id: true } });
    const T0 = Date.now() - 48 * HOUR;
    let orders = 0;

    const mkJob = (street: string, listingId: string | null) => prisma.project.create({
      data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", aryeoListingId: listingId, aryeoOrderId: listingId ? `ord-w2-${++orders}` : null },
      select: { id: true },
    });
    /** The real listing shape: an approved cut whose 1080p pass filed a file,
     *  with Kyle's "upload this" card open, and its per-video row. */
    const mkRendered = async (projectId: string, name: string, lengthSec = 59) => {
      const d = await prisma.deliverable.create({ data: { projectId, type: "VIDEO", quantity: 1, productTitle: name }, select: { id: true } });
      const out = await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId, slot: 1, category: "VIDEO" }, select: { id: true } });
      const s = await prisma.reviewSubmission.create({
        data: { projectId, deliverableId: d.id, slot: 1, round: 1, status: "APPROVED", fileName: `${name}.mov`, blobUrl: `https://drill.invalid/${encodeURIComponent(name)}.mov`, sizeBytes: 1000, decidedAt: new Date(T0), decidedBy: "James" },
        select: { id: true },
      });
      const task = await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: `Upload the 1080p video to Aryeo — ${name}`, projectId, dedupeKey: `topaz-deliver-${s.id}`, status: "OPEN" }, select: { id: true } });
      const job = await prisma.topazJob.create({
        data: { submissionId: s.id, projectId, state: "done", fileName: `${name}.mov`, sourceDurationSec: lengthSec, savedAt: new Date(T0 + 30 * 60_000), finishedAt: new Date(T0 + 30 * 60_000), finalPath: `/Final/${name} - FINAL (Topaz).mp4`, outputCheck: "verified", taskId: task.id },
        select: { id: true },
      });
      return { id: s.id, jobId: job.id, taskId: task.id, outputId: out.id };
    };
    const signedEvent = (listingId: string, eventId: string) => ({ object: "ACTIVITY", id: eventId, name: "LISTING_DELIVERED", occurred_at: new Date().toISOString(), resource: { object: "LISTING", id: listingId } });
    /** One delivery text per job (its dedupe key): a retry moves the same row. */
    const deliveryText = (projectId: string, state: "accepted" | "failed", acceptedAt: Date | null) => prisma.outboxMessage.upsert({
      where: { dedupeKey: `delivery:${projectId}` },
      create: { channel: "sms", toRef: "6105550100", projectId, body: "Your listing is all wrapped up!", state, acceptedAt, dedupeKey: `delivery:${projectId}` },
      update: { state, acceptedAt },
      select: { id: true },
    });

    // =======================================================================
    c.head("1a · a SIGNED Aryeo delivery closes the row by itself — no upload receipt");
    // =======================================================================
    const LA = "01a0c0c0-1111-7222-8333-444455550001";
    const A = await mkJob("11 Signed Way", LA);
    const a = await mkRendered(A.id, "Signed Way reel");
    LISTINGS.set(LA, { delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Cinematic Video" }] });
    c.ok("the row is on Kyle's card, with no upload recorded", !!(await rowOf(a.id)) && !(await du.uploadsFor([a.id])).has(a.id));
    const oldDoor = await du.claimListingDelivery(a.id, "Aryeo (delivery confirmed) — drill");
    c.ok("OLD (Oct 2–5): the only door to 'sent' demanded Kyle's upload receipt — still true for a person's press", !oldDoor.ok && /uploaded/i.test(oldDoor.ok ? "" : oldDoor.message));
    const flagOnly = await du.claimListingDelivery(a.id, "drill", undefined, { providerConfirmed: true });
    c.ok("the proof flag alone buys nothing: no signed delivery on record, refused", !flagOnly.ok);
    const hourly = await ad.proveListingNow(LA, "drill: hourly read, nothing signed");
    c.ok("an authenticated read alone (no signed delivery) closes nothing", hourly.closed === 0 && hourly.stamped === 0 && !(await cut(a.id)).sentToClientAt, hourly.note);
    await cooled();
    const unsigned = await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LA, "evt-unsigned"));
    c.ok("an UNSIGNED delivery post closes nothing and is not stored as an occurrence", !(await cut(a.id)).sentToClientAt && (await prisma.auditLog.count({ where: { target: LA, action: "aryeo_listing_delivery_event" } })) === 0, unsigned.note);
    await cooled();
    const t0 = Date.now();
    const signed = await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LA, "evt-signed"), { authenticated: true });
    const aRow = await cut(a.id);
    c.ok("NEW: Aryeo's signed delivery closes the row by itself", !!aRow.sentToClientAt && !(await rowOf(a.id)), `${signed.note} (${Date.now() - t0}ms)`);
    c.ok("…recorded as 'Aryeo (delivery confirmed)', naming the video that proved it", (aRow.sentToClientBy ?? "").startsWith("Aryeo (delivery confirmed)") && (aRow.sentToClientBy ?? "").includes("Cinematic Video"), aRow.sentToClientBy ?? "");
    c.ok("…and never as Kyle's upload: no upload receipt was invented", !(await du.uploadsFor([a.id])).has(a.id) && (await prisma.auditLog.count({ where: { target: a.id, action: "video_uploaded" } })) === 0 && !/kyle|upload/i.test(aRow.sentToClientBy ?? ""));
    const aLine = await prisma.activity.findFirst({ where: { projectId: A.id, body: { startsWith: "Video delivered" } }, select: { body: true } });
    c.ok("the timeline says 'Video delivered (Aryeo confirmed)'", (aLine?.body ?? "").startsWith("Video delivered (Aryeo confirmed)"), aLine?.body ?? "none");
    const aOut = await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: a.outputId } });
    const aTask = await prisma.smartTask.findUniqueOrThrow({ where: { id: a.taskId } });
    c.ok("Kyle's upload card closes and the per-video row names the Aryeo listing", aTask.status === "COMPLETED" && aOut.sentSubmissionId === a.id && aOut.deliveredVia === "aryeo-listing");
    await cooled();
    await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LA, "evt-signed"), { authenticated: true });
    c.ok("a replay of the same signed event changes nothing", (await cut(a.id)).sentToClientAt?.getTime() === aRow.sentToClientAt?.getTime() && (await prisma.activity.count({ where: { projectId: A.id, body: { startsWith: "Video delivered" } } })) === 1);
    const corr = await du.correctSent(a.id, aRow.sentToClientAt!.toISOString(), "That was the old video on the listing", { id: null, name: "Jordan" });
    c.ok("a person can still correct an Aryeo-confirmed send", corr.ok && !(await cut(a.id)).sentToClientAt, corr.message);
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    c.ok("…and the proof already on record does not quietly close it again", !(await cut(a.id)).sentToClientAt && !!(await rowOf(a.id)));
    await new Promise((r) => setTimeout(r, 5));
    await cooled();
    await ad.handleAryeoActivity("LISTING_DELIVERED", signedEvent(LA, "evt-after-correction"), { authenticated: true });
    c.ok("…only a NEW signed delivery after the correction closes it", !!(await cut(a.id)).sentToClientAt && !(await rowOf(a.id)));

    // =======================================================================
    c.head("1b · the hub's delivery text, ACCEPTED by the provider, is the same proof");
    // =======================================================================
    const LB = "01a0c0c0-1111-7222-8333-444455550002";
    const B = await mkJob("22 Texted Terrace", LB);
    const b = await mkRendered(B.id, "Texted Terrace reel");
    LISTINGS.set(LB, { delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Listing Video" }] });
    await deliveryText(B.id, "failed", null);
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    c.ok("a FAILED delivery text proves nothing — the row stays", !(await cut(b.id)).sentToClientAt && !!(await rowOf(b.id)));
    await deliveryText(B.id, "accepted", new Date());
    await cooled();
    const sweptB = await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    const bRow = await cut(b.id);
    c.ok("NEW: an accepted delivery text closes the row on the hourly check", !!bRow.sentToClientAt && !(await rowOf(b.id)), JSON.stringify(sweptB.jobs.find((j) => j.projectId === B.id)?.note));
    c.ok("…as Aryeo's confirmation, with no upload receipt", (bRow.sentToClientBy ?? "").startsWith("Aryeo (delivery confirmed)") && !(await du.uploadsFor([b.id])).has(b.id), bRow.sentToClientBy ?? "");

    const LC = "01a0c0c0-1111-7222-8333-444455550003";
    const C = await mkJob("33 Early Text Ct", LC);
    const cc = await mkRendered(C.id, "Early Text reel");
    LISTINGS.set(LC, { delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Listing Video" }] });
    await deliveryText(C.id, "accepted", new Date(T0 + 2 * HOUR)); // accepted BEFORE the video went up
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    c.ok("a text accepted BEFORE the video went up does not cover it", !(await cut(cc.id)).sentToClientAt && !!(await rowOf(cc.id)));
    const LU = "01a0c0c0-1111-7222-8333-444455550004";
    const U = await mkJob("44 Undelivered Ln", LU);
    const u = await mkRendered(U.id, "Undelivered reel");
    LISTINGS.set(LU, { delivery_status: "PROCESSING", videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Listing Video" }] });
    await deliveryText(U.id, "accepted", new Date());
    await prisma.auditLog.create({ data: { target: LU, actor: "Aryeo authenticated webhook", action: "aryeo_listing_delivery_event", detail: JSON.stringify({ listingId: LU, occurredAt: new Date().toISOString() }) } });
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    c.ok("a listing Aryeo itself does not call DELIVERED closes nothing, even with both proofs on record", !(await cut(u.id)).sentToClientAt);

    // =======================================================================
    c.head("1c · Kyle's 'Uploaded, not sent' row closes on Aryeo's word too");
    // =======================================================================
    const LD = "01a0c0c0-1111-7222-8333-444455550005";
    const D = await mkJob("55 Uploaded Ave", LD);
    const d = await mkRendered(D.id, "Uploaded Ave reel");
    // The only video up there predates this file, so the matcher can prove
    // nothing — Kyle's own receipt is what names the version.
    LISTINGS.set(LD, { delivery_status: "DELIVERED", videos: [{ id: v7(T0 + 10 * 60_000), duration: 59, title: "Old Video" }] });
    const up = await ops.markVideoUploadedAction(d.id, await fp(d.id));
    c.ok("Kyle presses Mark as Uploaded", up.ok, up.message);
    await new Promise((r) => setTimeout(r, 5));
    await deliveryText(D.id, "accepted", new Date());
    await cooled();
    await ad.sweepReadyToSendAgainstAryeo({ max: 12 });
    const dRow = await cut(d.id);
    c.ok("the accepted delivery text after his upload closes the row — no Mark as sent needed", !!dRow.sentToClientAt && (dRow.sentToClientBy ?? "").startsWith("Aryeo (delivery confirmed) — after the upload was recorded"), dRow.sentToClientBy ?? "");
    c.ok("…and his upload receipt is kept as his", (await du.uploadsFor([d.id])).get(d.id)?.sourceFingerprint === await fp(d.id));

    // =======================================================================
    c.head("1d · Kyle's two buttons still work by hand");
    // =======================================================================
    const LE = "01a0c0c0-1111-7222-8333-444455550006";
    const E = await mkJob("66 By Hand Rd", LE);
    const e = await mkRendered(E.id, "By Hand reel");
    const early = await ops.markVideoSentAction(e.id, null, await fp(e.id));
    c.ok("Mark as sent before Mark as Uploaded is refused", !early.ok && /uploaded/i.test(early.message), early.message);
    c.ok("Mark as Uploaded", (await ops.markVideoUploadedAction(e.id, await fp(e.id))).ok);
    const sentE = await ops.markVideoSentAction(e.id, null, await fp(e.id));
    c.ok("…then Mark as sent records the send", sentE.ok && !!(await cut(e.id)).sentToClientAt && !(await rowOf(e.id)), sentE.message);

    // =======================================================================
    c.head("2 · no linked Aryeo listing: one plain next step, no upload the server would refuse");
    // =======================================================================
    const F = await mkJob("77 Unlinked St", null);
    const f = await mkRendered(F.id, "Unlinked reel");
    const fRow = await rowOf(f.id);
    const refused = await du.recordUploaded(f.id, { id: null, name: "Kyle" }, await fp(f.id));
    c.ok("OLD: the card offered Mark as Uploaded here and the server refused it", !refused.ok && atHead("src/components/ops/ReadyToSendCard.tsx").includes("{!usesPortal(v) && !v.uploaded && v.uploadFingerprint && <MarkUploaded"), refused.message);
    c.ok("NEW: the row knows its listing is missing", fRow?.listingMissing === true && fRow.deliveryDestination === "aryeo-listing");
    c.ok("…and the card hides the button for it", src("src/components/ops/ReadyToSendCard.tsx").includes("!v.listingMissing && v.uploadFingerprint && <MarkUploaded") && src("src/components/ops/ReadyToSendCard.tsx").includes("Link the Aryeo listing first"));
    const fMsg = fRow ? deliveryReadyMessage(fRow, "https://hub.invalid") : null;
    c.ok("Kyle's Slack says the same one step, linked to the job", !!fMsg && fMsg.title.startsWith("Link the Aryeo listing") && /Refresh from Aryeo/.test(fMsg.slackDm) && fMsg.href === `/projects/${F.id}` && !/Mark as Uploaded/.test(fMsg.slackDm), fMsg?.title);
    c.ok("a linked job is unchanged", (await rowOf(cc.id))?.listingMissing === false);

    // =======================================================================
    c.head("3 · undo a mistaken 'Mark as Uploaded' — owner/admin, same ET day, audited");
    // =======================================================================
    const LG = "01a0c0c0-1111-7222-8333-444455550007";
    const G = await mkJob("88 Oops Ln", LG);
    const g = await mkRendered(G.id, "Oops reel");
    const gfp = await fp(g.id);
    await ops.markVideoUploadedAction(g.id, gfp);
    c.ok("today's upload is undoable on its row", (await rowOf(g.id))?.uploaded?.undoable === true);
    notOffice = true;
    const blocked = await ops.undoVideoUploadAction(g.id, gfp);
    notOffice = false;
    c.ok("a non-office user is refused, nothing changes", !blocked.ok && (await du.uploadsFor([g.id])).has(g.id), blocked.message);
    const wrongFile = await ops.undoVideoUploadAction(g.id, "another-file");
    c.ok("a changed file is refused", !wrongFile.ok && (await du.uploadsFor([g.id])).has(g.id), wrongFile.message);
    const t1 = Date.now();
    const undone = await ops.undoVideoUploadAction(g.id, gfp);
    const undoMs = Date.now() - t1;
    c.ok("the owner/admin undo lands at once", undone.ok && undoMs < 2000, `${undone.message} (${undoMs}ms)`);
    c.ok("…the video is back in Ready for upload", !(await du.uploadsFor([g.id])).has(g.id) && (await rowOf(g.id))?.uploaded === null);
    const trail = await prisma.auditLog.findMany({ where: { target: g.id }, orderBy: { createdAt: "asc" }, select: { action: true, detail: true } });
    const undoRow = trail.find((r) => r.action === "video_upload_corrected");
    c.ok("…audited: the original receipt stays in history and the undo names who and why", trail.some((r) => r.action === "video_uploaded") && !!undoRow && JSON.parse(undoRow.detail).undo === true && /mistake/.test(JSON.parse(undoRow.detail).reason));
    c.ok("a second undo is a calm no-op", (await ops.undoVideoUploadAction(g.id, gfp)).ok);
    // Yesterday's press: rewrite the fixture receipt's own date, then ask again.
    await ops.markVideoUploadedAction(g.id, gfp);
    const receipt = (await du.uploadsFor([g.id])).get(g.id)!;
    await prisma.auditLog.update({ where: { id: receipt.id }, data: { detail: JSON.stringify({ ...receipt, uploadedAt: new Date(Date.now() - 30 * HOUR).toISOString() }) } });
    c.ok("an upload marked on an earlier day offers no undo", (await rowOf(g.id))?.uploaded?.undoable === false);
    const late = await ops.undoVideoUploadAction(g.id, gfp);
    c.ok("…and the server refuses it", !late.ok && /day it was marked/.test(late.message) && (await du.uploadsFor([g.id])).has(g.id), late.message);
    await prisma.auditLog.update({ where: { id: receipt.id }, data: { detail: JSON.stringify(receipt) } });
    await ops.markVideoSentAction(g.id, null, gfp);
    const afterSend = await ops.undoVideoUploadAction(g.id, gfp);
    c.ok("a video already recorded as sent can't be undone here", !afterSend.ok && /sent/.test(afterSend.message) && !!(await cut(g.id)).sentToClientAt, afterSend.message);

    // =======================================================================
    c.head("4 · Kyle's alerts go to the DELIVERY owner, not to a name containing 'Kyle'");
    // =======================================================================
    const { deliveryOwnerTeamMemberId, notifyKyleDeliveryReady } = await import("@/lib/deliveryReadyNotify");
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, slackId: "U-KYLE", payPercent: 0, payFloor: 0 }, select: { id: true } });
    const newKyle = await prisma.teamMember.create({ data: { name: "Kyle Newhire", email: "kyle.n@drill.invalid", role: "PHOTOGRAPHER", active: true, slackId: "U-KYLE-2", payPercent: 0, payFloor: 0 }, select: { id: true } });
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@drill.invalid", role: "MANAGER", active: true, slackId: "U-JORDAN", payPercent: 0, payFloor: 0 }, select: { id: true } });
    await prisma.appUser.create({ data: { email: "kyle@drill.invalid", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id } });
    const jordanUser = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    const loose = await prisma.appUser.create({ data: { email: "nobody@drill.invalid", name: "Temp Office", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
    const oldMatches = await prisma.teamMember.count({ where: { active: true, name: { contains: "Kyle", mode: "insensitive" } } });
    c.ok("OLD: a second active 'Kyle' made the old lookup throw (it required exactly one)", oldMatches === 2 && atHead("src/lib/deliveryReadyNotify.ts").includes("Delivery alerts require exactly one active Kyle"));
    const owner = await deliveryOwnerTeamMemberId();
    c.ok("NEW: the DELIVERY duty owner (minted as Kyle Smith's login) resolves to his roster row", owner === kyle.id);
    const r4 = await notifyKyleDeliveryReady();
    const legs = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: "delivery-ready-" } }, select: { userKey: true } });
    c.ok("the delivery sweep addresses Kyle Smith only — never the new hire", r4.ready > 0 && legs.length > 0 && legs.every((l) => l.userKey === `tm:${kyle.id}`) && !legs.some((l) => l.userKey === `tm:${newKyle.id}`), `${legs.length} rows`);
    await prisma.programOwnerAssignment.updateMany({ where: { scope: "DEFAULT", duty: "DELIVERY" }, data: { appUserId: jordanUser.id, label: "Jordan Spackman" } });
    c.ok("hand DELIVERY to Jordan in Settings and the alerts follow him (login linked by email)", (await deliveryOwnerTeamMemberId()) === jordanTm.id);
    await prisma.programOwnerAssignment.updateMany({ where: { scope: "DEFAULT", duty: "DELIVERY" }, data: { appUserId: loose.id, label: "Temp Office" } });
    let why = "";
    try { await deliveryOwnerTeamMemberId(); } catch (err) { why = (err as Error).message; }
    c.ok("an owner with no roster entry is a clear error, never a guess", /not linked to one active team member/.test(why), why);

    // =======================================================================
    c.head("5 · the publication repair waits silently while the 1080p pass is pending");
    // =======================================================================
    const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
    const cv = await import("@/lib/contentVideos");
    const { repairMonthlyPublications } = await import("@/lib/monthlyFinal");
    const M = await buildContentMonth(prisma, { name: "Wave Two Portal TEST", package: "Accelerator", owner: { email: "owner@drill.invalid", name: "Pat Owner" } });
    await ensureOutputsForProject(M.projectId!);
    const mCut = await prisma.reviewSubmission.create({
      data: { projectId: M.projectId!, deliverableId: M.deliverableId, slot: 1, round: 1, source: "upload", status: "APPROVED", fileName: "video1-v1.mp4", blobUrl: "https://drill.invalid/m1.mp4", sizeBytes: 5, decidedAt: new Date(), decidedBy: "James", portalPublicationRequiredAt: new Date() },
      select: { id: true },
    });
    const mJob = await prisma.topazJob.create({ data: { projectId: M.projectId!, submissionId: mCut.id, state: "processing" }, select: { id: true } });
    const failureKey = cv.publicationFailureKey(mCut.id);
    const old = await cv.publishApprovedCutToLibrary(mCut.id); // what the repair used to do, every hour
    const oldFailure = await prisma.appSetting.findUnique({ where: { key: failureKey } });
    c.ok("OLD: publishing mid-pass fails and writes a failure Kyle reads as 'needs attention'", !old.published && !!oldFailure, old.why);
    await prisma.appSetting.deleteMany({ where: { key: failureKey } });
    await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { librarySyncFailedAt: null, librarySyncError: null } });
    const rep = await repairMonthlyPublications(100);
    c.ok("NEW: the repair skips it — counted as waiting, not as an exception", rep.waiting >= 1 && !rep.exceptions.some((x) => x.id === mCut.id), JSON.stringify({ waiting: rep.waiting, exceptions: rep.exceptions.length }));
    c.ok("…and writes nothing: no publication failure, no library failure", !(await prisma.appSetting.findUnique({ where: { key: failureKey } })) && !(await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: M.enrollmentId } })).librarySyncFailedAt);
    await prisma.topazJob.update({ where: { id: mJob.id }, data: { state: "held" } });
    c.ok("a finished file held for a listen waits silently too", !(await repairMonthlyPublications(100)).exceptions.some((x) => x.id === mCut.id) && !(await prisma.appSetting.findUnique({ where: { key: failureKey } })));
    await prisma.topazJob.update({ where: { id: mJob.id }, data: { state: "failed", error: "Topaz refused the file" } });
    const ended = await repairMonthlyPublications(100);
    c.ok("a pass that has ENDED without a file is still tried, so the real failure is still recorded", ended.exceptions.some((x) => x.id === mCut.id), JSON.stringify(ended.exceptions.find((x) => x.id === mCut.id)));

    // =======================================================================
    c.head("6 · the edit page: no Final-folder send for monthly videos; the Start bar knows the video");
    // =======================================================================
    const page = src("src/app/edit/[id]/page.tsx");
    const oldPage = atHead("src/app/edit/[id]/page.tsx");
    const folderAt = page.indexOf("<FolderSendForReview");
    const monthlyGate = page.lastIndexOf("{project.contentMonthId ? (", folderAt);
    c.ok("OLD: the Final-folder send was offered on every job", oldPage.includes("<FolderSendForReview") && !/contentMonthId \? \(\s*<p[^>]*>Monthly videos are sent from here only/.test(oldPage));
    c.ok("NEW: on a monthly job it is replaced by 'upload the file above'", monthlyGate > 0 && folderAt - monthlyGate < 900 && page.slice(monthlyGate, folderAt).includes("Monthly videos are sent from here only: upload the file above") && (page.match(/<FolderSendForReview/g) ?? []).length === 1);
    c.ok("OLD: the Start bar was not told which video is on screen", /<WorkStateBar bar=\{workBar\} tz=\{deskTz\} \/>/.test(oldPage));
    c.ok("NEW: the page passes its selected video to the Start bar", page.includes("<WorkStateBar bar={workBar} tz={deskTz} selectedOutputId={selectedBrief?.outputId ?? null} />"));
    c.ok("…and the Start bar uses it before the URL", src("src/components/editing/WorkStateBar.tsx").includes("selectedOutputId ?? params?.get(\"output\")"));

    // =======================================================================
    c.head("Z · isolation");
    // =======================================================================
    c.ok("nothing was sent to a client: only the drill's own delivery-text rows exist", (await prisma.outboxMessage.count()) === (await prisma.outboxMessage.count({ where: { body: "Your listing is all wrapped up!" } })));
    c.ok("no provider was reached (Slack answered by the recording fake only)", fence.blocked.every((u) => !/aryeo|openphone|quo|dropbox|topaz/i.test(u)), fence.blocked.join(", "));
    c.summary();
  } finally {
    await db.stop();
    fence.restore();
  }
}

// Exit explicitly once the database is down: PGlite's socket otherwise fires a
// late close callback into the stopped engine (the harness convention).
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });

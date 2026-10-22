// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the Oct 22 2026 photo review and delivery audit, one section a fix.
//
//   DRILL_PORT=6991 node scripts/_drill/run-all.cjs scripts/_drill/oct22-photo-audit-fixes.ts
//
//   C1  Aryeo's sticky "delivered" never closes a client's photo revision;
//       it leaves by Mark as delivering / Approve and deliver again, or
//       "Settled with the client: nothing to resend"; reopening resets the
//       next check
//   H1  the video side never closes the photo revision's to-do
//   H2  Approve and upload checks the holds (a reason to go past); a delivery
//       in Aryeo with holds open alerts once and leaves them OPEN; the sweep
//       auto-closes only asks that do not hold
//   H3  deliveredAt is the push run's / Aryeo's webhook time, the FIRST one;
//       a re-delivery is its own event
//   H4  a free-check hold resumes in QC review; the review rule lifts a
//       critical hold once no critical issue is left
//   H5  "Check again" asks for the free check, on a revision too
//   H6  a Lot lines version counts only while it is the photo's picture
//   H7  Update on Aryeo attaches first, deletes the old image only after the
//       new one is read back
//   M1  a revision's own clock; the office's due date respected
//   M2  the staging hold clears on the fix runner's staging and on staged
//       images already on the listing
//   M3  "Not uploaded yet" (the photographer's) on a job with no raws
//   M4  a video-only return never pulls a delivered job back
//   M5  "Fixes done" points at the hub's own push and Update on Aryeo
//   M6  a floating object needs a confident second look; owner-only switch
//   M7  no dollars for Kyle (event details, finding reasons)
//   M10 an earlier visit's never-sent raws are warned about, not dropped
//   M11 "more than the 3 staged photos ordered"
//   LOW the billing alert ignores the hub's own spending; a gone shoot stops
//
// ISOLATION: PGlite via the shared harness; Aryeo (API and web app),
// Uploadcare, Dropbox, AutoHDR and Slack answered in-process. Nothing leaves.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();

const DAY = 86_400_000;
const MIN = 60_000;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

// ---- Aryeo: the public API (listings) and the web app (Update on Aryeo) --------------------------
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
type Img = { id: string; filename: string; index: number; hiddenReads?: number };
type Listing = { id: string; delivery: "NOT_DELIVERED" | "DELIVERED"; images: Img[] };
const listings = new Map<string, Listing>();
const ucFiles = new Map<string, string>();
const ucGroups = new Map<string, string[]>();
const calls: { kind: string; listing?: string; at: number; body?: unknown; images?: string[] }[] = [];
const validSessions = new Set<string>();
const pendingSessions = new Set<string>();
let seq = 0;
const nid = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;
const sorted = (l: Listing) => [...l.images].sort((a, b) => a.index - b.index);
const stem = (f: string) => f.replace(/\.jpg$/i, "");
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
function aryeoWeb(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const h = new Headers(init?.headers);
  const ck = cookiesOf(init);
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/login") {
    if (method === "GET") {
      if (h.get("x-inertia") === "true") return json({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: { errors: {} } });
      const page = JSON.stringify({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: {} }).replace(/"/g, "&quot;");
      return withCookies(new Response(`<html><script>window.UPLOADCARE_PUBLIC_KEY = "c0ffee0123456789abcd";</script><div id="app" data-page="${page}"></div></html>`, { status: 200, headers: { "content-type": "text/html" } }), ["XSRF-TOKEN=tok%3D%3D; path=/; domain=.aryeo.com", "aryeo_session=anon; path=/; domain=.aryeo.com; httponly"]);
    }
    if (h.get("x-xsrf-token") !== "tok==" || ck.aryeo_session !== "anon") return new Response("CSRF token mismatch", { status: 419 });
    const b = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (b.email !== LOGIN.email || b.password !== LOGIN.password) return withCookies(redirect("https://app.aryeo.com/login"), ["aryeo_session=refused; path=/; domain=.aryeo.com"]);
    const s = nid("auth");
    pendingSessions.add(s);
    return withCookies(new Response(null, { status: 409, headers: { "x-inertia-location": "https://app.aryeo.com/companies" } }), [`aryeo_session=${s}; path=/; domain=.aryeo.com; httponly`, "XSRF-TOKEN=tok2%3D%3D; path=/; domain=.aryeo.com"]);
  }
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/companies") {
    const sess = ck.aryeo_session ?? "";
    if (!pendingSessions.has(sess) && !validSessions.has(sess)) return redirect("https://app.aryeo.com/login");
    pendingSessions.delete(sess);
    validSessions.add(sess);
    return redirect("https://realtourpilot.aryeo.com/admin/dashboard");
  }
  if (u.origin !== "https://realtourpilot.aryeo.com") return null;
  if (!validSessions.has(ck.aryeo_session ?? "")) return redirect("https://app.aryeo.com/login");
  if (method !== "GET" && h.get("x-xsrf-token") !== "tok2==") return new Response("CSRF", { status: 419 });
  if (u.pathname === "/admin/dashboard" && method === "GET") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    if (!l) return new Response("nope", { status: 404 });
    return json({
      component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`,
      props: {
        errors: {},
        listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered", customer_team_memberships: [] },
        images: sorted(l).map((i) => ({ id: i.id, title: null, is_live: true, filename: stem(i.filename), filename_extension: "jpg" })),
        company: { default_enable_mark_orders_fulfilled: false, default_timezone: "America/New_York" },
        image_uploads_require_media_license: false,
      },
    });
  }
  m = /^\/admin\/listing\/([^/]+)\/image-uploads$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { form_uuid_field: string };
    calls.push({ kind: "attach", listing: l.id, at: Date.now(), images: l.images.map((i) => i.id) });
    for (const uuid of ucGroups.get(b.form_uuid_field) ?? []) l.images.push({ id: nid("img"), filename: ucFiles.get(uuid)!, index: l.images.length, hiddenReads: 2 });
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/listing\/([^/]+)\/images$/.exec(u.pathname);
  if (m && method === "PUT") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: { id: string }[] };
    calls.push({ kind: "reorder", listing: l.id, at: Date.now() });
    b.images.forEach((x, k) => {
      const i = l.images.find((y) => y.id === x.id);
      if (i) i.index = k;
    });
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  if (m && method === "DELETE") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: string[] };
    calls.push({ kind: "delete", listing: l.id, at: Date.now(), body: b.images });
    l.images = l.images.filter((i) => !b.images.includes(i.id));
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  return new Response("not faked", { status: 404 });
}
function aryeoApi(url: string): Response | null {
  if (!url.startsWith("https://api.aryeo.com/v1/listings/")) return null;
  const l = listings.get(new URL(url).pathname.split("/")[3]);
  if (!l) return json({ message: "Not found" }, 404);
  // A new upload shows on the public API only after Aryeo processes it (a couple of reads).
  const shown = sorted(l).filter((i) => {
    if (!i.hiddenReads) return true;
    i.hiddenReads--;
    return false;
  });
  calls.push({ kind: "api-read", listing: l.id, at: Date.now(), images: shown.map((i) => i.id) });
  return json({ data: { id: l.id, delivery_status: l.delivery, images: shown.map((i, k) => ({ id: i.id, filename: i.filename, original_url: `https://cdn.aryeo.com/${i.id}.jpg`, display_in_gallery: true, index: k })), floor_plans: [] } });
}

// ---- Dropbox: the raws folders (M10) -------------------------------------------------------------
type DbxFile = { name: string; path: string; id: string; size: number; hash: string; at: string };
const dbxFolders = new Map<string, DbxFile[]>();
function dropbox(url: string, init?: RequestInit): Response | null {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as { path?: string }) : {};
    if (ep === "files/list_folder") {
      const files = dbxFolders.get((arg.path ?? "").toLowerCase());
      if (!files) return json({ error_summary: "path/not_found/.." }, 409);
      return json({ entries: files.map((f) => ({ ".tag": "file", name: f.name, path_display: f.path, id: f.id, size: f.size, content_hash: f.hash, server_modified: f.at })), has_more: false });
    }
    return json({ error_summary: "not_found/" }, 409);
  }
  if (url.startsWith("https://content.dropboxapi.com/")) return json({ error_summary: "not_found/" }, 409);
  return null;
}

const fake = createFakeAutohdr({ transforms: [], balance: 300, clientId: "cid", clientSecret: "drill-secret-1234567890" });
const fence = fenceFetch(async (url, init) => (await fake.handle(url, init)) ?? aryeoWeb(url, init) ?? aryeoApi(url) ?? dropbox(url, init) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));
const LONG_DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6991), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const asked = await import("@/lib/photoDelivery/clientAsked");
    const H = await import("@/lib/photoDelivery/holding");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const A = await import("@/lib/photoDelivery/addOns");
    const state = await import("@/lib/photoDelivery/jobState");
    const integrity = await import("@/lib/photoDelivery/integrity");
    const CA = await import("@/lib/clientAsks");
    const data = await import("@/app/ops/photo-delivery/data");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("aryeo_web", LOGIN.password, { metadata: { email: LOGIN.email } });
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await savePhotoDeliverySettings({ enabled: true, qcShadow: true, aryeoPush: "on", freeCheck: true, qcEnabled: false, autoSubmit: true, autoSubmitFrom: new Date(Date.now() - 30 * DAY).toISOString() } as never, "drill");
    // Every listing photo ends like a complete JPEG (the integrity check's byte range).
    integrity.__setIntegrityFetchForTests((async () => new Response(new Uint8Array([0, 0, 0xff, 0xd9]), { status: 206, headers: { "content-range": "bytes 4-7/8" } })) as typeof fetch);
    const jordan = await prisma.teamMember.create({ data: { name: "Jordan Drill", email: "jordan@drill.test", role: "ADMIN", active: true } as never });
    const client = await prisma.client.create({ data: { name: "Joe Drill" } });
    const kyleView = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false, readOnly: false };
    const ownerView = { role: "OWNER", name: "Jordan", isOwner: true, canSeeMoney: true, readOnly: false };
    const now0 = new Date();
    let listingSeq = 0;

    /** A delivered photo job on a delivered listing (the listing reads DELIVERED for ever). */
    const deliveredJob = async (street: string, o: { stage?: string; photos?: number; deliveredAt?: Date | null } = {}) => {
      const listingId = `L${++listingSeq}`;
      const shot = new Date(now0.getTime() - 3 * DAY);
      const p = await prisma.project.create({ data: { title: `${street}, Philadelphia, PA`, addressLine: street, clientId: client.id, status: "DELIVERED", shootDate: shot, aryeoListingId: listingId, deliverables: { create: [{ type: "PHOTOS", productTitle: "Photos" }] } } as never });
      const imgs: Img[] = [];
      const j = await prisma.photoJob.create({ data: { projectId: p.id, stage: o.stage ?? "DELIVERED", deliveredAt: o.deliveredAt === undefined ? new Date(now0.getTime() - 2 * DAY) : o.deliveredAt, stageChangedAt: new Date(now0.getTime() - 2 * DAY), createdAt: new Date(now0.getTime() - 3 * DAY), nextCheckAt: new Date(now0.getTime() + 6 * 60 * MIN) } });
      for (let k = 0; k < (o.photos ?? 3); k++) {
        const id = `${listingId}-i${k + 1}`;
        imgs.push({ id, filename: `${String(k + 1).padStart(2, "0")}-Room.jpg`, index: k });
        await prisma.photoAsset.create({ data: { jobId: j.id, name: `${String(k + 1).padStart(2, "0")}-Room.jpg`, sourceKind: "ARYEO", sourceRef: id, contentHash: `${listingId}-h${k}`, inspectedHash: `${listingId}-h${k}`, sequence: k, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } });
      }
      listings.set(listingId, { id: listingId, delivery: "DELIVERED", images: imgs });
      // The sync's fingerprint: what it read last (so a pass with the same listing is "no change").
      const entries = (await jobs.listingGallery(listingId))!.entries;
      await prisma.photoJob.update({ where: { id: j.id }, data: { finalsFingerprint: jobs.galleryFingerprint(entries), finalsCount: entries.length, finalsChangedAt: new Date(now0.getTime() - 3 * DAY) } });
      return { project: p, job: j, listingId };
    };
    const jobOf = (id: string) => prisma.photoJob.findUniqueOrThrow({ where: { id } });

    // ======================================================================
    c.head("C1 · Aryeo's sticky 'delivered' never closes a client's photo revision");
    // ======================================================================
    const L = await deliveredJob("859 N Lawrence St");
    const firstOut = (await jobOf(L.job.id)).deliveredAt!;
    const lampText = "Can you put the lamp back in photo 3? It is missing.";
    const lamp = (await CA.createAsk({ clientId: client.id, projectId: L.project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: lampText, summary: "Put the lamp back in photo 3", source: "email", askedBy: "Joe Drill", by: "drill" }))!;
    const reopen = await asked.photoAskAfterDelivery({ projectId: L.project.id, words: lampText, by: "Joe Drill", askedBy: "Joe Drill", clientId: client.id });
    let lj = await jobOf(L.job.id);
    c.ok("the client's request after delivery reopens the photos (Revision), on Kyle's photo revision to-do", reopen.reopened && lj.stage === "REVISION_REQUESTED" && !!reopen.taskId, JSON.stringify(reopen));
    c.ok("…and the job is looked at again NOW, not at the delivered job's 6-hour check (nextCheckAt reset)", !!lj.nextCheckAt && lj.nextCheckAt.getTime() <= Date.now() + 1000, lj.nextCheckAt?.toISOString());
    const s1 = await jobs.syncJobFinals(L.job.id, new Date());
    lj = await jobOf(L.job.id);
    c.ok("the sync reads the listing (still 'DELIVERED' from the first delivery) and leaves the revision open", s1.stage === "REVISION_REQUESTED" && lj.stage === "REVISION_REQUESTED", `${s1.stage} ${lj.stage}`);
    c.ok("…the first delivery date is untouched", lj.deliveredAt?.getTime() === firstOut.getTime());
    await CA.closeAsksOnDeliveredJobs(new Date());
    c.ok("…and the five-minute sweep leaves the client's request OPEN (it holds delivery)", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: lamp.id } })).state === "OPEN");
    const v1 = await delivery.verifyDelivery(L.job.id, "Kyle");
    c.ok("a Check of the delivery on a revision moves nothing and says why", !v1.ok && /client asked for changes after delivery/i.test(v1.message) && (await jobOf(L.job.id)).stage === "REVISION_REQUESTED", v1.message);
    // A revision further along (fixed, back in QC review) is still not "delivered" by the sticky flag.
    await prisma.photoJob.update({ where: { id: L.job.id }, data: { stage: "QC_REVIEW", nextCheckAt: new Date() } });
    await jobs.syncJobFinals(L.job.id, new Date());
    c.ok("…nor once it moved on to QC review in the same revision (the job keeps its first delivery date)", (await jobOf(L.job.id)).stage === "QC_REVIEW");
    await prisma.photoJob.update({ where: { id: L.job.id }, data: { stage: "REVISION_REQUESTED" } });
    const hv = H.holdingFor({ jobId: L.job.id, projectId: L.project.id, stage: "REVISION_REQUESTED", holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: null, decisions: { critical: 0, major: 0, minor: 0 }, listingUrl: "https://x", orderUrl: null, deliveryCheckNote: null, listingUpdates: { photoIds: [], names: [] }, gate: { checks: [], canDeliver: true, advisory: true, blockedForOverride: null }, push: { mode: "on", connected: true, sameDayAuto: false, progress: null } });
    const rev = hv.items.find((i) => i.kind === "revision");
    c.ok("'What's holding this': the revision's two ways out, Approve and deliver again, and 'Settled with the client: nothing to resend'", rev?.action?.label === "Approve and deliver again" && rev.alt?.kind === "settle" && rev.alt.label === "Settled with the client: nothing to resend" && !LONG_DASH.test(rev.text), JSON.stringify(rev));

    // Way out 1: settled with the client.
    const short = await asked.settleRevisionNoResend({ jobId: L.job.id, reason: "ok", by: "Kyle" });
    c.ok("Settled needs a typed reason", !short.ok && /at least 10 characters/.test(short.message), short.message);
    const settled = await asked.settleRevisionNoResend({ jobId: L.job.id, reason: "Joe agreed photo 3 stays as delivered, the lamp was moved out on purpose", by: "Kyle" });
    lj = await jobOf(L.job.id);
    const lampAfter = await prisma.clientAsk.findUniqueOrThrow({ where: { id: lamp.id } });
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(L.project.id) } });
    c.ok("…with one: back to Delivered with its FIRST delivery date, the reason on the job", settled.ok && lj.stage === "DELIVERED" && lj.deliveredAt?.getTime() === firstOut.getTime() && (await prisma.photoJobEvent.count({ where: { jobId: L.job.id, action: { startsWith: asked.SETTLED_ACTION } } })) >= 1, `${settled.message} ${lj.stage}`);
    c.ok("…the client's photo request answered with that reason (Not needed), and the photo revision to-do closed", lampAfter.state === "NOT_NEEDED" && /Settled with the client/.test(lampAfter.confirmNote ?? "") && task?.status === "COMPLETED", `${lampAfter.state} ${task?.status}`);

    // Way out 2: Mark as delivering, then Aryeo confirms: a RE-delivery.
    const M2j = await deliveredJob("615 Cliff Ln");
    const m2First = (await jobOf(M2j.job.id)).deliveredAt!;
    const ask2 = (await CA.createAsk({ clientId: client.id, projectId: M2j.project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Please keep the lamp in photo 2", source: "email", askedBy: "Alex Drill", by: "drill" }))!;
    await asked.photoAskAfterDelivery({ projectId: M2j.project.id, words: "Please keep the lamp in photo 2", by: "Alex Drill", clientId: client.id });
    const held = await delivery.startDelivery(M2j.job.id, "Kyle");
    c.ok("Mark as delivering waits while the client's request is open", !held.ok && (await jobOf(M2j.job.id)).stage === "REVISION_REQUESTED", held.message);
    await asked.settleClientAsked({ jobId: M2j.job.id, askId: ask2.id, how: "done", by: "Kyle" });
    const go = await delivery.startDelivery(M2j.job.id, "Kyle");
    const v2 = await delivery.verifyDelivery(M2j.job.id, "verify-sweep");
    const m2 = await jobOf(M2j.job.id);
    c.ok("…once it is Done: Mark as delivering, then the check: Delivered", go.ok && v2.ok && m2.stage === "DELIVERED", `${go.message} / ${v2.message}`);
    c.ok("…the FIRST delivery stays the job's date; the re-delivery is its own line", m2.deliveredAt?.getTime() === m2First.getTime() && (await prisma.photoJobEvent.count({ where: { jobId: M2j.job.id, action: { startsWith: `${delivery.REDELIVERED_ACTION}:` } } })) === 1);
    c.ok("…and the photo revision's to-do closes from the photo side", (await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(M2j.project.id) } }))?.status === "COMPLETED");

    // ======================================================================
    c.head("H1 · the video side never closes the photo revision's to-do");
    // ======================================================================
    const V = await deliveredJob("1 Video Way");
    const { resolveRevision, otherOpenRevisionAsks } = await import("@/lib/comms");
    await prisma.project.update({ where: { id: V.project.id }, data: { status: "REVISION", revisionRequestedAt: new Date() } });
    const videoTask = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision: 1 Video Way", status: "OPEN", projectId: V.project.id, clientId: client.id, dedupeKey: `drill-video-${V.project.id}`, assignedKey: "john", source: "system" } as never });
    await asked.photoAskAfterDelivery({ projectId: V.project.id, words: "Stage pic 38 please", by: "Joe Drill", clientId: client.id });
    const photoTask = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: asked.photoRevisionTaskKey(V.project.id) } });
    c.ok("two lanes open: the video's and the photo job's", photoTask.status === "OPEN" && (await otherOpenRevisionAsks(V.project.id)) === 2);
    await resolveRevision(V.project.id); // the video side: the corrected cut approved, the job moved to Completed
    c.ok("resolving the revision from the video side closes the video's to-do only", (await prisma.smartTask.findUniqueOrThrow({ where: { id: videoTask.id } })).status === "COMPLETED" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: photoTask.id } })).status === "OPEN");
    const whole = await (await import("@/lib/comms")).resolveRevisionWholeJob(V.project.id, "Jordan");
    c.ok("…only the job page's whole-job 'Mark resolved' (a person on the job, every ask) still takes it, by design", whole.closed === 1 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: photoTask.id } })).status === "COMPLETED");

    // ======================================================================
    c.head("H2 · holds: Approve and upload checks them; a delivery in Aryeo past them alerts once and leaves them open");
    // ======================================================================
    const shot = new Date(now0.getTime() - DAY);
    const R = await prisma.project.create({ data: { title: "58 Recreation Dr, Jim Thorpe, PA", addressLine: "58 Recreation Dr", clientId: client.id, status: "EDITING", shootDate: shot, aryeoListingId: "LREC", orderItems: { create: [{ title: "Lot Lines", amount: 75 }] }, deliverables: { create: [{ type: "DRONE", productTitle: "Drone" }, { type: "OTHER", label: "Item", productTitle: "Lot Lines" }] } } as never });
    const rj = await prisma.photoJob.create({ data: { projectId: R.id, stage: "READY", deliveryPath: "/x/06-Ready-for-Aryeo", deliveryStagedAt: new Date(), createdAt: new Date(now0.getTime() - DAY) } });
    const rrun = await prisma.photoQcRun.create({ data: { jobId: rj.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: JSON.stringify({ v: 2 }), startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: rj.id }, data: { lastQcRunId: rrun.id } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: rj.id, name: `DJI_0${k}.jpg`, sourceKind: "ARYEO", sourceRef: `LREC-${k}`, contentHash: `rec-${k}`, inspectedHash: `rec-${k}`, sequence: k, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } });
    listings.set("LREC", { id: "LREC", delivery: "NOT_DELIVERED", images: [{ id: "LREC-0", filename: "DJI_00.jpg", index: 0 }, { id: "LREC-1", filename: "DJI_01.jpg", index: 1 }] });
    const recEntries = (await jobs.listingGallery("LREC"))!.entries;
    await prisma.photoJob.update({ where: { id: rj.id }, data: { finalsFingerprint: jobs.galleryFingerprint(recEntries), finalsCount: 2, finalsChangedAt: new Date(now0.getTime() - DAY) } });
    const holdAsk = (await CA.createAsk({ clientId: client.id, projectId: R.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Make sure the lot lines include the back pasture", source: "text", askedBy: "Brandon Drill", askedAt: new Date(now0.getTime() - 20 * 60 * MIN), by: "drill" }))!;
    const looseAsk = (await CA.createAsk({ clientId: client.id, projectId: R.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Portal note about the photos", source: "portal", askedBy: "Brandon Drill", askedAt: new Date(now0.getTime() - 20 * 60 * MIN), holdsDelivery: false, by: "drill" }))!;
    const up1 = await P.approveJob(rj.id, "Kyle", { deliver: false });
    c.ok("Approve and upload to Aryeo checks the same holds as Approve and deliver: refused, naming them", !up1.ok && !up1.started && up1.message.startsWith(H.UPLOAD_HELD_PREFIX) && /lot lines needed/.test(up1.message) && /back pasture/.test(up1.message), up1.message);
    const up2 = await P.approveJob(rj.id, "Kyle", { deliver: false, holdReason: "soon" });
    c.ok("…a reason too short is refused", !up2.ok && up2.message.startsWith(H.UPLOAD_HELD_PREFIX));
    const pushRun = await prisma.appSetting.findUnique({ where: { key: `photo_aryeo_push:${rj.id}` } });
    c.ok("…and nothing went to Aryeo (no run started)", !pushRun && !calls.some((x) => x.listing === "LREC" && x.kind !== "api-read"));
    // Kyle delivers in Aryeo itself, past the hub's checklist.
    listings.get("LREC")!.delivery = "DELIVERED";
    await prisma.photoJob.update({ where: { id: rj.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(rj.id, new Date());
    const notes1 = await prisma.notification.count({ where: { kind: "photo_delivered_with_holds" } });
    const ev1 = await prisma.photoJobEvent.findMany({ where: { jobId: rj.id, action: { startsWith: jobs.DELIVERED_WITH_HOLDS_ACTION } } });
    c.ok("the sync sees Aryeo delivered with holds open: Jordan and Kyle hear it (the bell), and the job says so", notes1 >= 1 && ev1.length === 1 && /Lot Lines needed/.test(ev1[0].action) && /back pasture/.test(ev1[0].action), `${notes1} ${ev1.map((e) => e.action).join(" | ")}`);
    await prisma.photoJob.update({ where: { id: rj.id }, data: { stage: "READY", deliveredAt: null, nextCheckAt: new Date() } });
    await jobs.syncJobFinals(rj.id, new Date());
    c.ok("…once: the same holds seen again raise nothing new", (await prisma.notification.count({ where: { kind: "photo_delivered_with_holds" } })) === notes1 && (await prisma.photoJobEvent.count({ where: { jobId: rj.id, action: { startsWith: jobs.DELIVERED_WITH_HOLDS_ACTION } } })) === 1);
    await prisma.project.update({ where: { id: R.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const swept = await CA.closeAsksOnDeliveredJobs(new Date());
    c.ok("the sweep leaves the holding request OPEN and closes only the one that does not hold", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: holdAsk.id } })).state === "OPEN" && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: looseAsk.id } })).state === "DONE" && swept.ids.includes(looseAsk.id) && !swept.ids.includes(holdAsk.id));
    const rd = (await data.loadJobDetail(rj.id, { viewer: kyleView as never }))!;
    const rv = H.holdingFor({ ...rd.holdingBase, stage: rd.header.stage, gate: rd.gate, gateError: rd.gateError, push: rd.aryeoPush });
    c.ok("the delivered job's page: 'The photos went out with 2 things still open', then each one with its button", rd.header.stage === "DELIVERED" && rv.items[0]?.kind === "delivered" && /went out with 2 things still open/.test(rv.items[0].text) && rv.items.some((i) => i.kind === "addon" && i.action?.kind === "addon") && rv.items.some((i) => i.kind === "ask" && /back pasture/.test(i.text)), JSON.stringify(rv.items.map((i) => [i.kind, i.text])));
    // Kyle's reason to put the photos up anyway (a fresh job, still Ready).
    const R2 = await prisma.project.create({ data: { title: "60 Recreation Dr, Jim Thorpe, PA", addressLine: "60 Recreation Dr", clientId: client.id, status: "EDITING", shootDate: shot, aryeoListingId: "LREC2", orderItems: { create: [{ title: "Lot Lines", amount: 75 }] } } as never });
    const rj2 = await prisma.photoJob.create({ data: { projectId: R2.id, stage: "READY", deliveryPath: "/x2/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    await prisma.photoAsset.create({ data: { jobId: rj2.id, name: "DJI_9.jpg", sourceKind: "AUTOHDR", contentHash: "r2-0", inspectedHash: "r2-0", sequence: 0, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } });
    listings.set("LREC2", { id: "LREC2", delivery: "NOT_DELIVERED", images: [] });
    const up3 = await P.approveJob(rj2.id, "Kyle", { deliver: false, holdReason: "Brandon wants to see the drone shots on the listing before the lines go on" });
    c.ok("…with a reason: the upload starts, the reason and the holds on the job's activity", up3.started && (await prisma.photoJobEvent.count({ where: { jobId: rj2.id, action: { startsWith: "approved: upload to Aryeo past open holds (lot lines needed" } } })) === 1, up3.message);

    // ======================================================================
    c.head("H3 · deliveredAt is when the photos went out (the push run, Aryeo's webhook), the first one");
    // ======================================================================
    const W = await deliveredJob("2 Webhook Ct", { stage: "READY", deliveredAt: null });
    const wOut = new Date(Date.now() - 70 * MIN);
    await prisma.webhookEvent.create({ data: { provider: "aryeo", eventType: "LISTING_DELIVERED", payload: JSON.stringify({ object: "ACTIVITY", id: "a1", name: "LISTING_DELIVERED", occurred_at: wOut.toISOString(), resource: { object: "LISTING", id: W.listingId } }), createdAt: new Date(wOut.getTime() + 11_000) } });
    // An odd one: occurred_at a day before it arrived (ignored).
    await prisma.webhookEvent.create({ data: { provider: "aryeo", eventType: "LISTING_DELIVERED", payload: JSON.stringify({ name: "LISTING_DELIVERED", occurred_at: new Date(Date.now() - 2 * DAY).toISOString(), resource: { id: W.listingId } }), createdAt: new Date(Date.now() - 60 * MIN) } });
    await prisma.photoJob.update({ where: { id: W.job.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(W.job.id, new Date());
    const wj = await jobOf(W.job.id);
    c.ok("the sync notices an hour later: Delivered, dated by Aryeo's own notice (not 'now')", wj.stage === "DELIVERED" && wj.deliveredAt?.getTime() === wOut.getTime(), `${wj.stage} ${wj.deliveredAt?.toISOString()} vs ${wOut.toISOString()}`);
    const t2 = await delivery.deliveryTimeFor(W.job.id, W.listingId, new Date(Date.now() - 3 * DAY));
    c.ok("…a stale or odd notice (a day off from when it arrived) proves nothing", t2.source === "aryeo-webhook" && t2.at.getTime() === wj.deliveredAt!.getTime());
    const pushAt = new Date(Date.now() - 90 * MIN);
    await prisma.appSetting.create({ data: { key: `photo_aryeo_push:${W.job.id}`, updatedBy: "drill", value: JSON.stringify({ id: "r", state: "DONE", deliveredAt: pushAt.toISOString() }) } });
    const t3 = await delivery.deliveryTimeFor(W.job.id, W.listingId, new Date(Date.now() - 3 * DAY));
    c.ok("…the hub's own delivery (the push run) counts too: the earliest of the two wins", t3.source === "push" && t3.at.getTime() === pushAt.getTime());
    const none = await deliveredJob("3 Nothing Ln", { stage: "READY", deliveredAt: null });
    const t4 = await delivery.deliveryTimeFor(none.job.id, none.listingId, new Date(Date.now() - 3 * DAY));
    c.ok("…with neither: 'now' (this check), never the project's date", t4.source === "verify");

    // ======================================================================
    c.head("H4 · a free-check hold resumes in QC review; the review rule lifts a critical hold");
    // ======================================================================
    const F = await deliveredJob("30 Caedman Dr", { stage: "EDITED", deliveredAt: null });
    const frun = await prisma.photoQcRun.create({ data: { jobId: F.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(), finishedAt: new Date() } });
    const fph = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: F.job.id } });
    const crit = await prisma.photoQcFinding.create({ data: { qcRunId: frun.id, jobId: F.job.id, photoId: fph.id, ruleId: "OTHER_DEFECT", groupKey: "x-crit", pass: "P1_PHOTO", source: "AHDR", specificIssue: "A person in the mirror", explanation: "x", severity: "CRITICAL", confidence: 0.95, responsibility: "ADMIN", fixStrategy: "HUMAN_REVIEW", contentHash: fph.contentHash, arbitration: "CONFIRMED", status: "OPEN", model: "drill", rulesVersion: "v", promptId: "x", promptVersion: 1 } as never });
    await state.setStage(F.job.id, ["EDITED"], "ON_HOLD", "autohdr-check", { holdReason: "CRITICAL", extra: { lastQcRunId: frun.id } });
    c.ok("the free check held it straight from EDITED (it remembers EDITED)", (await jobOf(F.job.id)).holdResumeStage === "EDITED");
    c.ok("resumeStageFor: a checked job never goes back to EDITED; an unchecked one does", state.resumeStageFor("EDITED", true) === "QC_REVIEW" && state.resumeStageFor("EDITED", false) === "EDITED" && state.resumeStageFor("READY", true) === "READY");
    const { refreshVerdict } = await import("@/lib/photoDelivery/fixPolicy");
    await refreshVerdict(F.job.id, "second-look");
    c.ok("with the critical issue still open, the hold stays", (await jobOf(F.job.id)).stage === "ON_HOLD");
    await prisma.photoQcFinding.update({ where: { id: crit.id }, data: { status: "FALSE_POSITIVE", decidedBy: "Kyle", decidedAt: new Date() } });
    await refreshVerdict(F.job.id, "second-look");
    c.ok("once no critical issue is left, the review rule lifts it, into QC review and on by the rule (Ready: nothing left to decide)", (await jobOf(F.job.id)).stage === "READY" && (await prisma.photoJobEvent.count({ where: { jobId: F.job.id, action: { contains: "the hold lifts by itself" } } })) === 1, (await jobOf(F.job.id)).stage);
    await state.setStage(F.job.id, ["READY"], "ON_HOLD", "Kyle", { holdReason: "MANUAL", holdNote: "waiting on the agent" });
    await prisma.photoJob.update({ where: { id: F.job.id }, data: { holdResumeStage: "EDITED" } });
    const { releaseJobHold } = await import("@/lib/photoDelivery/decisions");
    const rel = await releaseJobHold(F.job.id, "Kyle");
    c.ok("a hold released by hand on a checked job lands in QC review (then the review rule), never EDITED", rel.ok && ["QC_REVIEW", "READY"].includes((await jobOf(F.job.id)).stage), `${rel.message} ${(await jobOf(F.job.id)).stage}`);

    // ======================================================================
    c.head("H5 · 'Check again' asks for the free check, on a revision too");
    // ======================================================================
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const K = await deliveredJob("5 Check Rd", { stage: "REVISION_REQUESTED" });
    await prisma.photoJob.update({ where: { id: K.job.id }, data: { autohdrPhotoshootId: 777 } });
    const kph = await prisma.photoAsset.findMany({ where: { jobId: K.job.id } });
    for (const [k, p] of kph.entries()) await prisma.photoAsset.update({ where: { id: p.id }, data: { autohdrImageUuid: `img-${k}` } });
    const kOld = await prisma.photoQcRun.create({ data: { jobId: K.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(Date.now() - DAY), finishedAt: new Date(Date.now() - DAY) } });
    const actions = await import("@/app/ops/photo-delivery/actions");
    const ra = await actions.requestQcAction(K.job.id);
    c.ok("with the paid QC off, Check again no longer refuses: it asks for the free check", ra.ok && /free photo check runs again/i.test(ra.message), ra.message);
    c.ok("…the photos only the free check had looked at are looked at again", (await prisma.photoAsset.count({ where: { jobId: K.job.id, inspectedHash: { not: null } } })) === 0);
    const described: string[] = [];
    check.__setDescribeForTests(async (shootId, uuid) => {
      described.push(`${shootId}/${uuid}`);
      return '{"room":"living room","light":"day","issues":[]}';
    });
    await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
    const kRun = await prisma.photoQcRun.findFirst({ where: { jobId: K.job.id, trigger: "AUTOHDR_CHECK", id: { not: kOld.id } }, orderBy: { startedAt: "desc" } });
    c.ok("…the free check picks the job up in Revision and looks at every photo (AutoHDR describe, no credits)", kRun?.status === "DONE" && described.filter((d) => d.startsWith("777/")).length === 3 && (await jobOf(K.job.id)).stage === "REVISION_REQUESTED", `${kRun?.status} ${described.join(",")}`);
    c.ok("…the run says a person asked for it (never 'the listing changed after delivery')", /"asked":true/.test(kRun?.checksJson ?? "") && (await prisma.notification.count({ where: { kind: "photo_after_delivery" } })) === 0);
    const kEdit = await deliveredJob("6 Editing St", { stage: "EDITING", deliveredAt: null });
    c.ok("…still editing: nothing to check yet", !(await check.requestFreeRecheck(kEdit.job.id, "Kyle")).ok);

    // ======================================================================
    c.head("H6 · a Lot lines version counts only while it is the photo's picture");
    // ======================================================================
    const LL = await prisma.project.create({ data: { title: "7 Lot Ln, Reading, PA", addressLine: "7 Lot Ln", clientId: client.id, status: "EDITING", shootDate: shot, orderItems: { create: [{ title: "Lot Lines", amount: 75 }] } } as never });
    const llj = await prisma.photoJob.create({ data: { projectId: LL.id, stage: "READY" } });
    const llp = await prisma.photoAsset.create({ data: { jobId: llj.id, name: "DJI_1.jpg", sourceKind: "ARYEO", sourceRef: "ll-1", contentHash: "hub-lines-1", sequence: 0, status: "ACTIVE" } });
    await prisma.photoVersion.create({ data: { photoId: llp.id, label: "Lot lines by Kyle", source: "HUB_EDIT", contentHash: "hub-lines-1", createdBy: "Kyle" } });
    const ll1 = (await A.addOnStates(LL.id, llj.id))[0];
    c.ok("the lines drawn and still the photo: 'Lot lines added'", ll1?.cleared?.how === "version");
    // The listing was replaced afterwards (the sync's "Replaced" version): the lines are gone.
    await prisma.photoAsset.update({ where: { id: llp.id }, data: { contentHash: "aryeo-replaced-1" } });
    await prisma.photoVersion.create({ data: { photoId: llp.id, label: "Replaced", source: "EDITOR", contentHash: "aryeo-replaced-1" } });
    const ll2 = (await A.addOnStates(LL.id, llj.id))[0];
    c.ok("…the picture replaced after it: Lot Lines needed again (the hold is back)", !ll2?.cleared, JSON.stringify(ll2?.cleared));
    c.ok("isCurrentVersion: by content hash, or (an AutoHDR fix) by its AutoHDR version", A.isCurrentVersion({ contentHash: "a" }, { contentHash: "a" }) && !A.isCurrentVersion({ contentHash: "a" }, { contentHash: "b" }) && A.isCurrentVersion({ contentHash: null, autohdrVersionUuid: "v2" }, { contentHash: "autohdr:x", autohdrVersionUuid: "v2" }));

    // ======================================================================
    c.head("H7 · Update on Aryeo: attach first, take the old image off only after the new one is read back");
    // ======================================================================
    const U = await deliveredJob("8 Update Ave", { photos: 2 });
    const oldId = `${U.listingId}-i1`;
    const keepId = `${U.listingId}-i2`;
    const uph = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: U.job.id, sourceRef: oldId } });
    ucFiles.set("uc-new-1", "01-Room.jpg");
    ucGroups.set("grp-new~1", ["uc-new-1"]);
    const t0 = new Date().toISOString();
    await prisma.appSetting.create({
      data: {
        key: `photo_aryeo_push:${U.job.id}`, updatedBy: "drill",
        value: JSON.stringify({ id: "upd1", listingId: U.listingId, state: "ADDING", then: "stop", items: [{ photoId: uph.id, name: "01-Room.jpg", path: "", uuid: "uc-new-1", tries: 0, error: null, already: false, rev: "hub-edit-1" }], groupId: "grp-new~1", addedAt: null, ordered: false, deliveredAt: null, by: "Kyle", startedAt: t0, updatedAt: t0, finishedAt: null, note: null, lease: null, anyway: true, fingerprint: null, listed: [], remove: [], removedAt: null, approvedBy: "Kyle", mode: "update", replaceIds: [oldId], keepOrder: ["01-room.jpg", "02-room.jpg"], prev: null }),
      },
    });
    const seen: string[][] = [];
    for (let i = 0; i < 12; i++) {
      const pr = await P.advancePush(U.job.id, { budgetMs: 20_000 });
      seen.push(listings.get(U.listingId)!.images.map((x) => x.id));
      if (!pr || !pr.active) break;
    }
    const attachAt = calls.findIndex((x) => x.kind === "attach" && x.listing === U.listingId);
    const deleteAt = calls.findIndex((x) => x.kind === "delete" && x.listing === U.listingId);
    const readsBetween = calls.slice(attachAt, deleteAt).filter((x) => x.kind === "api-read" && x.listing === U.listingId);
    c.ok("the new file is attached FIRST (the old image still on the listing at that moment)", attachAt >= 0 && (calls[attachAt].images ?? []).includes(oldId) && (deleteAt < 0 || attachAt < deleteAt), JSON.stringify(calls.filter((x) => x.listing === U.listingId).map((x) => x.kind)));
    c.ok("…while Aryeo is still processing the new file (not on the public listing yet), the old one is NOT taken off", readsBetween.some((r) => !(r.images ?? []).some((id) => !id.startsWith(U.listingId))) && readsBetween.every((r) => (r.images ?? []).includes(oldId)), JSON.stringify(readsBetween.map((r) => r.images)));
    const finalImgs = sorted(listings.get(U.listingId)!);
    c.ok("…then, read back: the old image comes off (by its id), the other photo untouched, the order kept", deleteAt > attachAt && JSON.stringify(calls[deleteAt].body) === JSON.stringify([oldId]) && finalImgs.length === 2 && !finalImgs.some((x) => x.id === oldId) && finalImgs.some((x) => x.id === keepId) && finalImgs[0].filename === "01-Room.jpg" && finalImgs[1].id === keepId, JSON.stringify(finalImgs));

    // ======================================================================
    c.head("M1 · a revision has its own clock; the office's due date is respected");
    // ======================================================================
    const C = await deliveredJob("9 Clock St");
    await prisma.photoJob.update({ where: { id: C.job.id }, data: { slaDueAt: new Date(now0.getTime() - 2 * DAY) } });
    await asked.photoAskAfterDelivery({ projectId: C.project.id, words: "Brighten photo 2", by: "Joe Drill", clientId: client.id });
    const revAt = (await asked.revisionStartOf(C.job.id))!;
    await jobs.syncJobFinals(C.job.id, new Date());
    const { clientRoundClock } = await import("@/lib/deliveryBoard");
    const cj = await jobOf(C.job.id);
    c.ok("the revision is due on the standard revision turnaround from the client's request (not the visit's, two days late)", cj.slaDueAt?.getTime() === clientRoundClock(revAt).dueAt.getTime() && cj.slaDueAt!.getTime() > Date.now(), `${cj.slaDueAt?.toISOString()} vs ${clientRoundClock(revAt).dueAt.toISOString()}`);
    c.ok("…said on the job", (await prisma.photoJobEvent.count({ where: { jobId: C.job.id, action: { contains: "the revision turnaround from the client's request" } } })) === 1);
    const O = await deliveredJob("10 Override Rd", { stage: "QC_REVIEW", deliveredAt: null });
    listings.get(O.listingId)!.delivery = "NOT_DELIVERED";
    const officeDue = new Date(now0.getTime() + 3 * DAY);
    await prisma.project.update({ where: { id: O.project.id }, data: { dueOverrideAt: officeDue } });
    await jobs.syncJobFinals(O.job.id, new Date());
    c.ok("the office's due date for the job (dueOverrideAt) is the photo deadline", (await jobOf(O.job.id)).slaDueAt?.getTime() === officeDue.getTime());

    // ======================================================================
    c.head("M2 · Virtual Staging clears by itself: the fix runner's staging, or staged images on the listing");
    // ======================================================================
    const S = await prisma.project.create({ data: { title: "12 Stage Ln, Malvern, PA", addressLine: "12 Stage Ln", clientId: client.id, status: "EDITING", shootDate: shot, orderItems: { create: [{ title: "Virtual Staging", amount: 90 }] }, deliverables: { create: [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging" }] } } as never });
    const sj = await prisma.photoJob.create({ data: { projectId: S.id, stage: "READY" } });
    const sp = await prisma.photoAsset.create({ data: { jobId: sj.id, name: "IMG_1.jpg", sourceKind: "AUTOHDR", contentHash: "autohdr:v1", autohdrVersionUuid: "v1", sequence: 0, status: "ACTIVE" } });
    c.ok("ordered staging, nothing on the photos: Virtual Staging needed", !(await A.addOnStates(S.id, sj.id))[0]?.cleared);
    await prisma.photoVersion.create({ data: { photoId: sp.id, label: "AutoHDR single_angle_staging", source: "FIX", autohdrVersionUuid: "v2", createdBy: "fix-runner" } });
    await prisma.photoAsset.update({ where: { id: sp.id }, data: { contentHash: "autohdr:v2", autohdrVersionUuid: "v2" } });
    const st1 = (await A.addOnStates(S.id, sj.id))[0];
    c.ok("the fix runner's 'AutoHDR single_angle_staging' (the photo's current version) clears it", st1?.cleared?.how === "version" && st1.cleared.photoName === "IMG_1.jpg", JSON.stringify(st1?.cleared));
    const S2 = await prisma.project.create({ data: { title: "14 Stage Ln, Malvern, PA", addressLine: "14 Stage Ln", clientId: client.id, status: "EDITING", shootDate: shot, orderItems: { create: [{ title: "Virtual Staging", amount: 90 }] } } as never });
    const sj2 = await prisma.photoJob.create({ data: { projectId: S2.id, stage: "READY" } });
    await prisma.photoAsset.create({ data: { jobId: sj2.id, name: "Virtually Staged Living Room.jpg", sourceKind: "ARYEO", sourceRef: "vs-1", contentHash: "vs-1", sequence: 0, status: "ON_LISTING" } });
    const st2 = (await A.addOnStates(S2.id, sj2.id))[0];
    c.ok("a staged image already delivered on the listing clears it ('already on the Aryeo listing')", st2?.cleared?.how === "listing" && /Virtually Staged Living Room/.test(st2.cleared.photoName ?? ""), JSON.stringify(st2?.cleared));
    const g2 = await delivery.deliveryGate(sj2.id);
    c.ok("…and the checklist says so", /already on the Aryeo listing: Virtually Staged Living Room\.jpg/.test(g2.checks.find((x) => x.key === "addon:virtual_staging")?.detail ?? ""));
    c.ok("…the boards agree (nothing open on either)", (await A.openAddOnsByProject([S.id, S2.id])).size === 0);
    c.ok("…the order line's DONE status is not read (the sweep marks it DONE once any photo is on the listing)", A.addOnsOrdered([], [{ type: "VIRTUAL_STAGING", label: null, productTitle: null, status: "DONE" }]).length === 1);

    // ======================================================================
    c.head("M3 · a job in Editing with no raws is the photographer's: 'Not uploaded yet'");
    // ======================================================================
    const N = await prisma.project.create({ data: { title: "913 Lakeview Dr, Reading, PA", addressLine: "913 Lakeview Dr", clientId: client.id, status: "SHOT", shootDate: new Date(now0.getTime() - 2 * DAY), deliverables: { create: [{ type: "PHOTOS", productTitle: "Photos" }] } } as never });
    const nj = await prisma.photoJob.create({ data: { projectId: N.id, stage: "EDITING", slaDueAt: new Date(now0.getTime() - DAY) } });
    const nd = (await data.loadJobDetail(nj.id, { viewer: kyleView as never }))!;
    const nv = H.holdingFor({ ...nd.holdingBase, stage: nd.header.stage, gate: nd.gate, gateError: nd.gateError, push: nd.aryeoPush });
    c.ok("the job page: 'Not uploaded yet', waiting on the photographer, the upload page (not AutoHDR's)", nd.holdingBase.rawBatches === 0 && nv.items[0]?.short === "Not uploaded yet" && /Waiting on the photographer/.test(nv.items[0].waitingOn) && (nv.items[0].action as { href?: string })?.href === `/upload/${N.id}`, JSON.stringify(nv.items[0]));
    c.ok("…with a raw upload seen it is AutoHDR's again", H.holdingFor({ ...nd.holdingBase, rawBatches: 1, stage: "EDITING", gate: null, push: nd.aryeoPush }).items[0]?.waitingOn === "Waiting on AutoHDR");
    const card = (await data.loadQueue({ holding: true })).columns.flatMap((col) => col.cards).find((x) => x.id === nj.id);
    c.ok("…the board card says 'Not uploaded yet'", card?.holding?.line === "Not uploaded yet", JSON.stringify(card?.holding));
    const { photoStageOf } = await import("@/lib/jobsBoard");
    c.ok("the Shoots board's photo chip: 'Not uploaded', not 'Editing'", photoStageOf({ jobStage: "EDITING", shootOver: true, rawsIn: true, liveOnAryeo: false, late: false, noRawsSeen: true }).label === "Not uploaded" && photoStageOf({ jobStage: "EDITING", shootOver: true, rawsIn: true, liveOnAryeo: false, late: false }).label === "Editing");
    const behind = await import("@/lib/behindAlert");
    const report = await behind.behindReport(new Date()).catch((e: unknown) => ({ items: [] as { projectId: string; who: string }[], err: String(e) }));
    const late = report.items.find((i) => i.projectId === N.id);
    c.ok("the photos-late alert names it 'Not uploaded yet (the photographer's)'", late?.who === behind.NOT_UPLOADED_WHO, `${late?.who ?? "(not listed)"} ${"err" in report ? report.err : ""}`);

    // ======================================================================
    c.head("M4 · a video-only return never pulls delivered photos back into Editing");
    // ======================================================================
    const VR = await deliveredJob("1316 Blair Ave");
    const vrFirst = (await jobOf(VR.job.id)).deliveredAt;
    await prisma.appointment.createMany({ data: [
      { projectId: VR.project.id, aryeoId: "vr-1", startAt: new Date(now0.getTime() - 3 * DAY), status: "CONFIRMED" },
      { projectId: VR.project.id, aryeoId: "vr-2", startAt: new Date(now0.getTime() - 3 * 60 * MIN), status: "CONFIRMED" },
    ] as never });
    await prisma.photoJob.update({ where: { id: VR.job.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(VR.job.id, new Date());
    const vr = await jobOf(VR.job.id);
    c.ok("a second visit 3 hours ago with no raws: the photos stay Delivered, their delivery date kept", vr.stage === "DELIVERED" && vr.deliveredAt?.getTime() === vrFirst?.getTime(), `${vr.stage} ${vr.deliveredAt?.toISOString()}`);

    // ======================================================================
    c.head("M5 · 'Fixes done' points at the hub's own push and Update on Aryeo");
    // ======================================================================
    const runner = readFileSync("src/lib/photoDelivery/fixRunner.ts", "utf8");
    c.ok("never 'push the shoot to Aryeo as usual' or a bare 'Replace the fixed photos on the Aryeo listing.'", !/push the shoot to Aryeo as usual/.test(runner) && !/"Replace the fixed photos on the Aryeo listing\."/.test(runner) && /the hub puts them on the Aryeo listing/.test(runner) && /Update on Aryeo, or the hub's own upload/.test(runner));

    // ======================================================================
    c.head("M6 · a floating object needs a confident second look; only Jordan switches it off");
    // ======================================================================
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    c.ok("a plain 'not there' still dismisses an ordinary check", policy.secondLookDismisses("EXT_TRASH_CANS_PRIMARY", { present: false }));
    c.ok("a floating object: a 'not there' without confidence, or below 0.85, keeps it", !policy.secondLookDismisses("AIEDIT_FLOATING_OBJECT", { present: false }) && !policy.secondLookDismisses("AIEDIT_FLOATING_OBJECT", { present: false, confidence: 0.6 }) && policy.secondLookDismisses("AIEDIT_FLOATING_OBJECT", { present: false, confidence: 0.9 }) && !policy.secondLookDismisses("AIEDIT_FLOATING_OBJECT", { present: true, confidence: 0.99 }));
    c.ok("…the second look asks for a confidence", /"confidence":0\.9/.test(policy.secondLookPrompt([{ label: "Floating object", where: null }])));
    const house = await import("@/lib/photoDelivery/houseRules");
    const kyleStop = await house.stopRule("AIEDIT_FLOATING_OBJECT", "too many", "Kyle", { role: "ADMIN" });
    const noRole = await house.stopRule("AIEDIT_FLOATING_OBJECT", "too many", "someone");
    c.ok("switching it off for every shoot is refused for anyone but the owner", !kyleStop.ok && !noRole.ok && /Only Jordan/.test(kyleStop.message) && !(await house.houseRules()).some((r) => r.ruleId === "AIEDIT_FLOATING_OBJECT"), kyleStop.message);
    const ownerStop = await house.stopRule("AIEDIT_FLOATING_OBJECT", "Jordan's call for the drill", "Jordan", { role: "OWNER" });
    c.ok("…the owner can", ownerStop.ok && (await house.houseRules()).some((r) => r.ruleId === "AIEDIT_FLOATING_OBJECT"));
    await house.resumeRule("AIEDIT_FLOATING_OBJECT", "Jordan");

    // ======================================================================
    c.head("M7 · no dollars for Kyle (credits are fine)");
    // ======================================================================
    c.ok("event details lose their dollar fields at any depth, credits kept", JSON.stringify(data.moneyFreeData({ costUsd: 1.2, credits: 3, ops: [{ priceUsd: 2, estimatedCredits: 4 }] })) === '{"credits":3,"ops":[{"estimatedCredits":4}]}');
    const mj = await deliveredJob("11 Money Ct", { stage: "QC_REVIEW", deliveredAt: null });
    const mph = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: mj.job.id } });
    const mrun = await prisma.photoQcRun.create({ data: { jobId: mj.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoQcFinding.create({ data: { qcRunId: mrun.id, jobId: mj.job.id, photoId: mph.id, ruleId: "EXT_TRASH_CANS_PRIMARY", groupKey: "trash", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Trash cans", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "PHOTOGRAPHER", fixStrategy: "AUTOREMOVE_MASK", contentHash: mph.contentHash, status: "OPEN", statusReason: "Fix not run: this shoot has reached its automatic fix maximum ($10)", model: "drill", rulesVersion: "v", promptId: "x", promptVersion: 1 } as never });
    await state.logJobEvent(mj.job.id, "fix-runner", "fix batch priced", { costUsd: 0.42, credits: 2 });
    const kd = (await data.loadJobDetail(mj.job.id, { viewer: kyleView as never }))!;
    const od = (await data.loadJobDetail(mj.job.id, { viewer: ownerView as never }))!;
    const kEvent = kd.events.find((e) => e.action === "fix batch priced");
    c.ok("Kyle: the event's details carry the credits, never costUsd", !!kEvent && !/costUsd|0\.42/.test(kEvent.detail ?? "") && /credits/.test(kEvent.detail ?? ""), kEvent?.detail ?? "");
    c.ok("…the finding's reason without the dollars; Jordan still sees them", !kd.findings.some((f) => /\$/.test(f.statusReason ?? "")) && od.findings.some((f) => /\$10/.test(f.statusReason ?? "")) && /costUsd/.test(od.events.find((e) => e.action === "fix batch priced")?.detail ?? ""));
    c.ok("…and the fix runner now writes that reason in credits", !/fix maximum \(\$\$\{settings\.fixMaxUsd\}\)/.test(runner) && /automatic fix maximum \(\$\{b\.maxCredits\} credit/.test(runner));

    // ======================================================================
    c.head("M10 · an earlier visit's never-sent raws are warned about, never dropped silently");
    // ======================================================================
    const intake = await import("@/lib/photoDelivery/intake");
    const ff = (name: string, at: string | null) => ({ id: name, name, path: `/x/${name}`, size: 9_000_000, hash: name, uploadedAt: at });
    const fs1 = intake.filesSince([ff("old.JPG", "2026-10-09T01:00:00Z"), ff("new.JPG", "2026-10-14T01:30:00Z")], new Date("2026-10-13T04:00:00Z"));
    c.ok("filesSince names the files it leaves out", fs1.older === 1 && fs1.olderFiles[0]?.name === "old.JPG" && fs1.kept.map((f) => f.name).join() === "new.JPG");
    const visit1 = new Date(now0.getTime() - 5 * DAY);
    const visit2 = new Date(now0.getTime() - 4 * 60 * MIN);
    const IP = await prisma.project.create({ data: { title: "21 Split Rd, Reading, PA", addressLine: "21 Split Rd", clientId: client.id, status: "SHOT", shootDate: visit2, debriefSubmittedAt: visit2, deliverables: { create: [{ type: "PHOTOS", productTitle: "Photos" }] } } as never });
    await prisma.appointment.createMany({ data: [{ projectId: IP.id, aryeoId: "ip-1", startAt: visit1, status: "CONFIRMED" }, { projectId: IP.id, aryeoId: "ip-2", startAt: visit2, status: "CONFIRMED" }] as never });
    const ipj = await prisma.photoJob.create({ data: { projectId: IP.id, stage: "EDITING" } });
    const { actualFolderPaths } = await import("@/lib/dropboxFolders");
    const rawPath = actualFolderPaths({ ...(await prisma.project.findUniqueOrThrow({ where: { id: IP.id }, select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true } })), client: { name: client.name } }).rawPhotos;
    const raw = (name: string, at: Date): DbxFile => ({ name, path: `${rawPath}/${name}`, id: `id:${name}`, size: 9_000_000, hash: `h-${name}`, at: at.toISOString() });
    dbxFolders.set(rawPath.toLowerCase(), [raw("DSC_0001.ARW", new Date(visit1.getTime() + 3 * 60 * MIN)), raw("DSC_0002.ARW", new Date(visit1.getTime() + 3 * 60 * MIN)), raw("DSC_0500.ARW", new Date(visit2.getTime() + 2 * 60 * MIN))]);
    await intake.driveIntake({ budgetMs: 90_000, now: new Date(), listShoots: async () => [] });
    await intake.driveIntake({ budgetMs: 90_000, now: new Date(Date.now() + 2 * MIN), listShoots: async () => [] });
    const warn = await prisma.photoJobEvent.findMany({ where: { jobId: ipj.id, action: { startsWith: intake.OLDER_NEVER_SENT_ACTION } } });
    const ipBatch = await prisma.photoIntakeBatch.findFirst({ where: { projectId: IP.id } });
    c.ok("the earlier visit's 2 raws (never sent by the hub) are said on the job, once", warn.length === 1 && /2 files in 01-RAW-Photos uploaded before/.test(warn[0].action), warn.map((w) => w.action).join(" | "));
    c.ok("…and Kyle hears it once (the bell)", (await prisma.notification.count({ where: { kind: "photo_autohdr_older_raws" } })) === 1);
    c.ok("…this visit's batch holds only this visit's raw", ipBatch?.fileCount === 1 && /DSC_0500/.test(ipBatch.filesJson), ipBatch?.filesJson);

    // ======================================================================
    c.head("M11 · staging asked beyond the order: 'more than the 3 staged photos ordered'");
    // ======================================================================
    const { officeWhy } = await import("@/lib/briefPhotoAsks");
    c.ok("staging on an order with staging: 'More than the 3 staged photos ordered'", officeWhy(["Virtually stage the upper patio (photo 38)"], 3) === "More than the 3 staged photos ordered: confirm the scope or price with the client first.");
    c.ok("…no staging on the order, or other new work: 'Not on the order'", officeWhy(["Virtually stage photo 12"], 0) === "Not on the order: confirm the scope or price with the client first." && /^Not on the order/.test(officeWhy(["Add a twilight edit"], 3)));

    // ======================================================================
    c.head("LOW · the billing alert ignores the hub's own spending; a shoot AutoHDR lost stops");
    // ======================================================================
    const sentAt = new Date(Date.now() - 60 * MIN);
    const bb = await prisma.photoIntakeBatch.create({ data: { projectId: IP.id, batchNo: 9, rawPath: "/x", filesJson: "[]", fileCount: 50, fingerprint: "b9", state: "DONE", sentAt, balanceAtSend: 300, address: "21 Split Rd" } });
    await prisma.autohdrCreditEntry.create({ data: { kind: "DOWNLOAD", credits: -50, at: new Date(Date.now() - 30 * MIN), note: "the hub's own download for display" } });
    fake.state.balance = 250;
    await intake.checkCreatorBilling(bb, 50);
    c.ok("credits fell by 50 while editing, all of it the hub's own download: no alert", (await prisma.notification.count({ where: { kind: "photo_autohdr_billing" } })) === 0);
    fake.state.balance = 200;
    await intake.checkCreatorBilling({ ...bb, id: "b9-2" }, 50);
    c.ok("…50 more that the hub did not spend: the alert", (await prisma.notification.count({ where: { kind: "photo_autohdr_billing" } })) >= 1);
    c.ok("intakeTries reads the count off the error", intake.intakeTries("[try 2] boom") === 2 && intake.intakeTries("slow: x") === 0 && intake.intakeTries(null) === 0);
    const lost = await prisma.photoIntakeBatch.create({ data: { projectId: IP.id, batchNo: 10, rawPath: "/x", filesJson: "[]", fileCount: 5, fingerprint: "b10", state: "PROCESSING", photoshootId: 987654, address: "21 Split Rd (more photos 10)", sentAt, committedAt: sentAt, nextCheckAt: new Date(Date.now() - MIN) } });
    for (let i = 0; i < intake.GONE_TRIES + 1; i++) await intake.driveIntake({ budgetMs: 60_000, now: new Date(Date.now() + i * 6 * MIN), listShoots: async () => [] });
    const lostAfter = await prisma.photoIntakeBatch.findUniqueOrThrow({ where: { id: lost.id } });
    c.ok(`a shoot AutoHDR no longer has (404): after ${intake.GONE_TRIES} tries the batch stops (FAILED), said why`, lostAfter.state === "FAILED" && /no longer has this shoot/.test(lostAfter.lastError ?? ""), `${lostAfter.state} ${lostAfter.lastError}`);
    c.ok("…with ONE alert", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `pd-intake-failed-${lost.id}` } } })) === 1);

    c.head("plain words");
    const words = [H.holdingFor({ jobId: "j", projectId: "p", stage: "REVISION_REQUESTED", holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: null, decisions: { critical: 0, major: 0, minor: 0 }, listingUrl: "x", orderUrl: null, deliveryCheckNote: null, listingUpdates: { photoIds: [], names: [] }, gate: null, push: { mode: "on", connected: true, sameDayAuto: false, progress: null } }), up1.message, ev1[0]?.action, warn[0]?.action, officeWhy(["stage"], 3)];
    c.ok("no em dashes in what Kyle reads", !LONG_DASH.test(JSON.stringify(words)));

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    void jordan;
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

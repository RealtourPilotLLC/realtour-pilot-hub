// ---------------------------------------------------------------------------
// DRILL: the hub uploads and delivers in Aryeo (Oct 14 2026, aryeoPush.ts +
// integrations/aryeoWeb.ts).
//
// Jordan: "Is there any way to automate the file upload and delivery on
// Aryeo? There has to be." / "Ok cool let's do that."
//
// Fakes, answered in-process, shaped like what Aryeo's web app does (read from
// its code on Oct 14): the sign-in (Laravel session + XSRF + Inertia), the
// listing editor page, image-uploads, image order, Deliver Listing; Aryeo's
// Uploadcare (base upload + group); Aryeo's public API (the listing as the
// hub reads it back); Dropbox (the 06-Ready-for-Aryeo folder).
//   1. The login: tested before it is saved; a wrong password says so in
//      Aryeo's words and nothing is saved; the session is kept encrypted and
//      reused (one sign-in for a whole push); an expired session signs in again.
//   2. Off by default: nothing is sent until the stage allows it.
//   3. Upload: every ready photo to Uploadcare under Aryeo's key, one group in
//      delivery order, put on the listing, checked through the public API
//      (Aryeo processes in the background), the order set when Aryeo's differs.
//   4. Never doubled: a photo already on the listing is not sent again; a
//      listing holding other photos waits for "Send anyway".
//   5. Approve: Kyle's Deliver in Aryeo presses Deliver Listing with the form's
//      own defaults (no added recipients), the hub confirms DELIVERED and the
//      job is verified. Auto: the same, by itself, from the cron.
//   6. A refusal stops the run with Aryeo's words; nothing is guessed.
// ISOLATION: PGlite via the shared harness; nothing leaves the fakes.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
const UC_KEY = "c0ffee0123456789abcd";
type Img = { id: string; filename: string; index: number; live: boolean; visibleAfter: number };
type Listing = { id: string; delivery: "UNDELIVERED" | "DELIVERED"; images: Img[]; reads: number };
const listings = new Map<string, Listing>();
const ucFiles = new Map<string, string>(); // uuid -> filename
const ucGroups = new Map<string, string[]>();
const calls: { kind: string; body?: unknown }[] = [];
let sessionSeq = 0;
const validSessions = new Set<string>();
const processingPasses = 1; // Aryeo shows new photos only after this many API reads
let refuseAttach = false;
const dropboxFolder = new Map<string, number>(); // path -> size
let n = 0;
const id = (p: string) => `${p}-${String(++n).padStart(4, "0")}`;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

function editPage(l: Listing) {
  return {
    component: "Company/Listings/EditListing",
    version: "v1",
    url: `/admin/listings/${l.id}/edit`,
    props: {
      errors: {},
      listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered" },
      images: [...l.images].sort((a, b) => a.index - b.index).map((i) => ({ id: i.id, title: null, is_live: i.live, filename: i.filename.replace(/\.jpg$/i, ""), filename_extension: "jpg" })),
      company: { default_enable_mark_orders_fulfilled: true, default_timezone: "America/New_York" },
      image_uploads_require_media_license: true,
    },
  };
}

async function aryeoWeb(url: string, init?: RequestInit): Promise<Response | null> {
  const u = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const h = new Headers(init?.headers);
  const ck = cookiesOf(init);
  const inertiaReq = h.get("x-inertia") === "true";
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/login") {
    if (method === "GET") {
      if (inertiaReq) return json({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: { errors: ck.aryeo_session === "refused" ? { email: "These credentials do not match our records." } : {} } });
      const page = JSON.stringify({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: {} }).replace(/"/g, "&quot;");
      return withCookies(new Response(`<html><script>window.UPLOADCARE_PUBLIC_KEY = "${UC_KEY}";</script><div id="app" data-page="${page}"></div></html>`, { status: 200, headers: { "content-type": "text/html" } }), ["XSRF-TOKEN=tok%3D%3D; path=/; domain=.aryeo.com", "aryeo_session=anon; path=/; domain=.aryeo.com; httponly"]);
    }
    calls.push({ kind: "login" });
    if (h.get("x-xsrf-token") !== "tok==" || ck.aryeo_session !== "anon") return new Response("CSRF token mismatch", { status: 419 });
    const b = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (b.email !== LOGIN.email || b.password !== LOGIN.password) return withCookies(redirect("https://app.aryeo.com/login"), ["aryeo_session=refused; path=/; domain=.aryeo.com"]);
    const s = `auth-${++sessionSeq}`;
    validSessions.add(s);
    return withCookies(redirect("https://realtourpilot.aryeo.com/admin"), [`aryeo_session=${s}; path=/; domain=.aryeo.com; httponly`, "XSRF-TOKEN=tok2%3D%3D; path=/; domain=.aryeo.com"]);
  }
  if (u.origin !== "https://realtourpilot.aryeo.com") return null;
  if (!validSessions.has(ck.aryeo_session ?? "")) return redirect("https://app.aryeo.com/login");
  if (method !== "GET" && h.get("x-xsrf-token") !== "tok2==") return new Response("CSRF", { status: 419 });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    return l ? json(editPage(l)) : new Response("nope", { status: 404 });
  }
  m = /^\/admin\/listing\/([^/]+)\/image-uploads$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { form_uuid_field: string; set_captions: boolean; agrees_to_zillow_media_license: boolean };
    calls.push({ kind: "attach", body: b });
    if (refuseAttach) return redirect(`/admin/listings/${l.id}/edit?err=1`);
    for (const uuid of ucGroups.get(b.form_uuid_field) ?? []) {
      // Aryeo files new photos at the FRONT in reverse (so the hub has to set the order).
      l.images.forEach((i) => i.index++);
      l.images.push({ id: id("img"), filename: ucFiles.get(uuid)!, index: 0, live: true, visibleAfter: l.reads + processingPasses });
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/listing\/([^/]+)\/images$/.exec(u.pathname);
  if (m && method === "PUT") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: { id: string; filename: string }[] };
    calls.push({ kind: "reorder", body: b });
    b.images.forEach((x, k) => { const i = l.images.find((y) => y.id === x.id); if (i) i.index = k; });
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    calls.push({ kind: "deliver", body: JSON.parse(String(init?.body)) });
    l.delivery = "DELIVERED";
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  return new Response("not faked", { status: 404 });
}

// After a redirect back the page props carry the outcome: a refused attach shows errors.
async function aryeoWebWithErrors(url: string, init?: RequestInit): Promise<Response | null> {
  const u = new URL(url);
  if (u.origin === "https://realtourpilot.aryeo.com" && u.searchParams.get("err") === "1") {
    const l = listings.get(u.pathname.split("/")[3])!;
    const p = editPage(l);
    return json({ ...p, props: { ...p.props, errors: { form_uuid_field: "You must agree to the Zillow media license." } } });
  }
  return aryeoWeb(url, init);
}

async function uploadcare(url: string, init?: RequestInit): Promise<Response | null> {
  if (!url.startsWith("https://upload.uploadcare.com/")) return null;
  const form = init?.body as FormData;
  if (url.endsWith("/base/")) {
    if (form.get("UPLOADCARE_PUB_KEY") !== UC_KEY) return json({ error: "pub_key is invalid" }, 403);
    const file = form.get("file") as File;
    const uuid = id("uc");
    ucFiles.set(uuid, file.name);
    calls.push({ kind: "upload", body: file.name });
    return json({ file: uuid });
  }
  if (url.endsWith("/group/")) {
    const files: string[] = [];
    for (let i = 0; form.get(`files[${i}]`); i++) files.push(String(form.get(`files[${i}]`)));
    const gid = `${id("grp")}~${files.length}`;
    ucGroups.set(gid, files);
    calls.push({ kind: "group", body: files.length });
    return json({ id: gid, files_count: files.length });
  }
  return null;
}

function aryeoApi(url: string): Response | null {
  if (!url.startsWith("https://api.aryeo.com/v1/listings/")) return null;
  const l = listings.get(new URL(url).pathname.split("/")[3]);
  if (!l) return json({ message: "Not found" }, 404);
  l.reads++;
  const shown = l.images.filter((i) => l.reads >= i.visibleAfter).sort((a, b) => a.index - b.index);
  return json({ data: { id: l.id, delivery_status: l.delivery, images: shown.map((i, k) => ({ id: i.id, filename: i.filename, original_url: `https://cdn.aryeo.com/${i.id}.jpg`, display_in_gallery: true, index: k })), floor_plans: [] } });
}

function dropbox(url: string, init?: RequestInit): Response | null {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://api.dropboxapi.com/2/files/list_folder") {
    const a = JSON.parse(String(init?.body)) as { path: string };
    const entries = [...dropboxFolder.entries()].filter(([p]) => p.startsWith(`${a.path}/`)).map(([p, size]) => ({ ".tag": "file", name: p.slice(a.path.length + 1), path_display: p, id: `id:${p}`, size }));
    return json({ entries, has_more: false });
  }
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  return null;
}

const fence = fenceFetch(async (url, init) => (await aryeoWebWithErrors(url, init)) ?? (await uploadcare(url, init)) ?? aryeoApi(url) ?? dropbox(url, init) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6991), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret, getConnection } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const W = await import("@/lib/integrations/aryeoWeb");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const { deliveryOrderFor } = await import("@/lib/photoDelivery/delivery");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await savePhotoDeliverySettings({ enabled: true, qcShadow: true }, "drill");
    P.__setPushDownloaderForTests(async (path) => {
      if (!dropboxFolder.has(path)) throw new Error("not in the folder");
      return Buffer.alloc(dropboxFolder.get(path)!, 7);
    });

    const mkJob = async (street: string, listingId: string, photos: number) => {
      const client = await prisma.client.create({ data: { name: `${street} Client` } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id, aryeoListingId: listingId } });
      const folder = `/AutoHDR/x/${street}/06-Ready-for-Aryeo`;
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY", deliveryPath: folder, deliveryStagedAt: new Date() } });
      for (let i = 0; i < photos; i++) await prisma.photoAsset.create({ data: { jobId: job.id, name: `p${i + 1}.jpg`, sourceKind: "AUTOHDR", contentHash: `${street}-${i}`, inspectedHash: `${street}-${i}`, sequence: i, status: "ACTIVE", roomType: i === 0 ? "EXTERIOR_FRONT" : "BEDROOM", sequenceGroup: i === 0 ? "FRONT_EXTERIOR" : "BEDROOMS" } });
      const order = await deliveryOrderFor(job.id);
      for (const o of order) dropboxFolder.set(`${folder}/${o.deliveryName}`, 50_000 + o.deliveryName.length);
      listings.set(listingId, { id: listingId, delivery: "UNDELIVERED", images: [], reads: 0 });
      return { job, project, order, folder };
    };

    // ======================================================================
    c.head("1 · the hub's Aryeo login");
    const bad = await W.testAryeoWebLogin({ email: LOGIN.email, password: "wrong" });
    c.ok("a wrong password is refused in Aryeo's own words", !bad.ok && /These credentials do not match our records/.test(bad.ok ? "" : bad.error), bad.ok ? "" : bad.error);
    const actions = await import("@/app/connections/aryeoWebActions");
    const fd = new FormData();
    fd.set("email", LOGIN.email);
    fd.set("password", "wrong");
    const notSaved = await actions.saveAryeoWebLogin(null, fd);
    c.ok("…and nothing is saved", !notSaved.ok && !(await getConnection(W.ARYEO_WEB_PROVIDER)), notSaved.message);
    fd.set("password", LOGIN.password);
    const saved = await actions.saveAryeoWebLogin(null, fd);
    const conn = await getConnection(W.ARYEO_WEB_PROVIDER);
    c.ok("the right login is tested, then saved: password encrypted, email in the metadata", saved.ok && !!conn?.secretEncrypted && !conn.secretEncrypted.includes(LOGIN.password) && JSON.parse(conn.metadata ?? "{}").email === LOGIN.email, saved.message);
    const sess = await prisma.appSetting.findUnique({ where: { key: "aryeo_web:session" } });
    c.ok("the session is stored encrypted (no cookie in the clear)", !!sess && !sess.value.includes("auth-") && !sess.value.includes("aryeo_session"));

    // ======================================================================
    c.head("2 · off by default");
    const A = await mkJob("10 Push Pl", "L-A", 4);
    const off = await P.requestPush(A.job.id, { by: "Kyle" });
    c.ok("nothing is sent while the stage is Off", !off.ok && /switched off/.test(off.message) && !calls.some((x) => x.kind === "upload"), off.message);

    // ======================================================================
    c.head("3 · Send to Aryeo (stage: upload)");
    await savePhotoDeliverySettings({ aryeoPush: "upload" }, "drill");
    const loginsBefore = calls.filter((x) => x.kind === "login").length;
    const r = await P.requestPush(A.job.id, { by: "Kyle" });
    c.ok("started", r.ok && r.started, r.message);
    for (let i = 0; i < 8; i++) await P.advancePush(A.job.id, { budgetMs: 30_000 });
    const prog = await P.pushProgress(A.job.id);
    const uploads = calls.filter((x) => x.kind === "upload").map((x) => x.body);
    c.ok("every ready photo went to Aryeo's upload service under Aryeo's key", uploads.length === 4 && A.order.every((o) => uploads.includes(o.deliveryName)), JSON.stringify(uploads));
    const attach = calls.find((x) => x.kind === "attach")?.body as { form_uuid_field: string; set_captions: boolean; agrees_to_zillow_media_license: boolean };
    c.ok("one group, in delivery order, put on the listing (with the media licence when Aryeo requires it)", calls.filter((x) => x.kind === "group").length === 1 && /~4$/.test(attach.form_uuid_field) && attach.agrees_to_zillow_media_license === true && attach.set_captions === false && ucGroups.get(attach.form_uuid_field)!.map((u) => ucFiles.get(u)).join() === A.order.map((o) => o.deliveryName).join());
    c.ok("checked through Aryeo's API, waiting while Aryeo processes them", (listings.get("L-A")!.reads ?? 0) >= 2);
    const l = listings.get("L-A")!;
    const onListing = [...l.images].sort((a, b) => a.index - b.index).map((i) => i.filename);
    c.ok("Aryeo filed them backwards; the hub set the delivery order", calls.some((x) => x.kind === "reorder") && onListing.join() === A.order.map((o) => o.deliveryName).join(), onListing.join());
    c.ok("upload stage: done, Kyle delivers (nothing delivered)", prog?.state === "DONE" && !prog.deliveredAt && l.delivery === "UNDELIVERED" && !calls.some((x) => x.kind === "deliver"), JSON.stringify(prog));
    c.ok("one sign-in for the whole push (the session is reused)", calls.filter((x) => x.kind === "login").length - loginsBefore <= 1);
    const again = await P.requestPush(A.job.id, { by: "Kyle" });
    for (let i = 0; i < 4; i++) await P.advancePush(A.job.id, { budgetMs: 30_000 });
    c.ok("sending again never doubles a photo (all already there)", again.ok && /already on the listing/.test(again.message) && l.images.length === 4 && calls.filter((x) => x.kind === "upload").length === 4, again.message);

    // ======================================================================
    c.head("4 · a listing that already holds other photos");
    const B = await mkJob("20 Other Ave", "L-B", 3);
    listings.get("L-B")!.images.push({ id: "old-1", filename: "Old (1 of 1).jpg", index: 0, live: true, visibleAfter: 0 });
    const held = await P.requestPush(B.job.id, { by: "Kyle" });
    c.ok("waits for a person, naming what is there", !held.ok && /already has 1 photo that is not from 06-Ready-for-Aryeo \(Old \(1 of 1\)\.jpg\)/.test(held.message) && /Send anyway/.test(held.message), held.message);
    const anyway = await P.requestPush(B.job.id, { by: "Kyle", anyway: true });
    for (let i = 0; i < 8; i++) await P.advancePush(B.job.id, { budgetMs: 30_000 });
    const lb = listings.get("L-B")!;
    c.ok("Send anyway adds them next to it, ours first in order", anyway.ok && lb.images.length === 4 && [...lb.images].sort((a, b) => a.index - b.index)[3].filename === "Old (1 of 1).jpg", JSON.stringify([...lb.images].sort((a, b) => a.index - b.index).map((i) => i.filename)));

    // ======================================================================
    c.head("5 · approve: Kyle presses Deliver in Aryeo");
    await savePhotoDeliverySettings({ aryeoPush: "approve" }, "drill");
    const C = await mkJob("30 Approve Ct", "L-C", 3);
    const drive1 = await P.drivePushes({ budgetMs: 60_000 });
    c.ok("approve stage: the cron sends a ready job by itself", drive1.started.includes(C.job.id), JSON.stringify(drive1));
    for (let i = 0; i < 6; i++) await P.advancePush(C.job.id, { budgetMs: 30_000 });
    const waiting = await P.pushProgress(C.job.id);
    c.ok("…and waits for Kyle (nothing delivered)", waiting?.state === "WAITING" && waiting.waitingForApproval && listings.get("L-C")!.delivery === "UNDELIVERED", JSON.stringify(waiting));
    const ok = await P.approvePushDelivery(C.job.id, "Kyle");
    for (let i = 0; i < 4; i++) await P.advancePush(C.job.id, { budgetMs: 30_000 });
    const del = calls.filter((x) => x.kind === "deliver").pop()?.body as Record<string, unknown>;
    c.ok("Deliver in Aryeo presses Deliver Listing with the form's own defaults (no added recipients, the listing's customers emailed)", ok.ok && listings.get("L-C")!.delivery === "DELIVERED" && Array.isArray(del.added_customer_ids) && (del.added_customer_ids as unknown[]).length === 0 && (del.added_emails as unknown[]).length === 0 && del.notify_via_email === true && del.fulfill_orders === true && del.schedule_date === null, JSON.stringify(del));
    const jc = await prisma.photoJob.findUniqueOrThrow({ where: { id: C.job.id } });
    const pc = await P.pushProgress(C.job.id);
    c.ok("the hub confirms DELIVERED through the API and the job is verified", jc.stage === "DELIVERED" && pc?.state === "DONE" && !!pc.deliveredAt, `${jc.stage} ${pc?.state}`);

    // ======================================================================
    c.head("5b · auto: uploads and delivers by itself, and an expired session signs in again");
    await savePhotoDeliverySettings({ aryeoPush: "auto" }, "drill");
    const D = await mkJob("40 Auto Ln", "L-D", 2);
    validSessions.clear();
    const logins0 = calls.filter((x) => x.kind === "login").length;
    await P.drivePushes({ budgetMs: 60_000 });
    for (let i = 0; i < 8; i++) await P.advancePush(D.job.id, { budgetMs: 30_000 });
    const jd = await prisma.photoJob.findUniqueOrThrow({ where: { id: D.job.id } });
    c.ok("delivered and verified with nobody pressing anything", listings.get("L-D")!.delivery === "DELIVERED" && jd.stage === "DELIVERED", jd.stage);
    c.ok("…after signing in again once when Aryeo dropped the session", calls.filter((x) => x.kind === "login").length - logins0 === 1);

    // ======================================================================
    c.head("5c · the checklist still decides");
    const E = await mkJob("50 Held Rd", "L-E", 2);
    await prisma.photoJob.update({ where: { id: E.job.id }, data: { stage: "ON_HOLD", holdReason: "MANUAL" } });
    await P.requestPush(E.job.id, { by: "Kyle", then: "deliver" });
    for (let i = 0; i < 8; i++) await P.advancePush(E.job.id, { budgetMs: 30_000 });
    const pe = await P.pushProgress(E.job.id);
    c.ok("a job on hold is never delivered by the hub: it waits with why", listings.get("L-E")!.delivery === "UNDELIVERED" && pe?.state === "WAITING" && /on hold/.test(pe.note ?? ""), JSON.stringify(pe));

    // ======================================================================
    c.head("6 · a refusal stops the run in Aryeo's words");
    await savePhotoDeliverySettings({ aryeoPush: "upload" }, "drill");
    const F = await mkJob("60 Refuse St", "L-F", 2);
    refuseAttach = true;
    await P.requestPush(F.job.id, { by: "Kyle" });
    for (let i = 0; i < 6; i++) await P.advancePush(F.job.id, { budgetMs: 30_000 });
    refuseAttach = false;
    const pf = await P.pushProgress(F.job.id);
    c.ok("FAILED with Aryeo's reason, nothing on the listing", pf?.state === "FAILED" && /You must agree to the Zillow media license/.test(pf.note ?? "") && listings.get("L-F")!.images.length === 0, pf?.note ?? "");
    const ev = await prisma.photoJobEvent.findFirst({ where: { jobId: F.job.id, action: { contains: "stopped" } } });
    c.ok("…and the job's activity says so", !!ev);
    const view = await (await import("@/app/ops/photo-delivery/data")).loadJobDetail(F.job.id, { viewer: { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false } });
    c.ok("the job page carries the stage, the login and the push", view?.aryeoPush.mode === "upload" && view.aryeoPush.connected && view.aryeoPush.progress?.state === "FAILED");

    c.head("isolation");
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

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
//  12. A dropped connection waits and carries on (Oct 29 2026, 825 State St):
//      delivered once, never twice.
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
const pendingSessions = new Set<string>(); // signed in, company not picked yet
const processingPasses = 1; // Aryeo shows new photos only after this many API reads
let refuseAttach = false;
let refuseLogin = false;
let bounceAfterAttach = false;
// The connection drops on Deliver (Oct 29 2026, 825 State St): before Aryeo hears it, or after it delivered.
let dropDeliver: "before" | "after" | null = null;
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
      listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Bob Kelley" } }] },
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
    if (refuseLogin || b.email !== LOGIN.email || b.password !== LOGIN.password) return withCookies(redirect("https://app.aryeo.com/login"), ["aryeo_session=refused; path=/; domain=.aryeo.com"]);
    // Like the real Aryeo (seen live Oct 14): 409 + X-Inertia-Location to the
    // company picker; the session is only good once /companies picked the company.
    const s = `auth-${++sessionSeq}`;
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
  // Like the real Aryeo (seen live Oct 14): a change that doesn't say where it
  // comes from (Origin + Referer) is sent to the login page.
  if (method !== "GET" && (h.get("origin") !== "https://realtourpilot.aryeo.com" || !(h.get("referer") ?? "").startsWith("https://realtourpilot.aryeo.com/admin/listings/"))) {
    calls.push({ kind: "no-origin" });
    return redirect("https://app.aryeo.com/login");
  }
  if (u.pathname === "/admin/dashboard" && method === "GET") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    if (!l) return new Response("nope", { status: 404 });
    // The Deliver Listing window's partial reload: only the delivery email comes back.
    if (h.get("x-inertia-partial-component") === "Company/Listings/EditListing" && (h.get("x-inertia-partial-data") ?? "").split(",").includes("delivery_email")) {
      calls.push({ kind: "delivery-email" });
      return json({ component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`, props: { delivery_email: { email_subject: "Your listing media is ready!", email_body: "<p>Your media for 902 Valley Rd is ready.</p>", email_cc_list: "", email_bcc_list: "office@realtourpilot.com" } } });
    }
    return json(editPage(l));
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
    if (bounceAfterAttach) { bounceAfterAttach = false; validSessions.clear(); }
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
  if (m && method === "DELETE") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: string[] };
    calls.push({ kind: "delete", body: b });
    l.images = l.images.filter((i) => !b.images.includes(i.id));
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { email_subject?: string | null };
    calls.push({ kind: "deliver", body: b });
    if (!b.email_subject) return redirect(`/admin/listings/${l.id}/edit?err=subject`);
    if (dropDeliver === "before") { dropDeliver = null; throw new TypeError("fetch failed"); }
    l.delivery = "DELIVERED";
    if (dropDeliver === "after") { dropDeliver = null; throw new TypeError("fetch failed"); }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  return new Response("not faked", { status: 404 });
}

// After a redirect back the page props carry the outcome: a refused attach shows errors.
async function aryeoWebWithErrors(url: string, init?: RequestInit): Promise<Response | null> {
  const u = new URL(url);
  if (u.origin === "https://realtourpilot.aryeo.com" && (u.searchParams.get("err") === "1" || u.searchParams.get("err") === "subject")) {
    const l = listings.get(u.pathname.split("/")[3])!;
    const p = editPage(l);
    return json({ ...p, props: { ...p.props, errors: u.searchParams.get("err") === "subject" ? { email_subject: "The email subject field is required." } : { form_uuid_field: "You must agree to the Zillow media license." } } });
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
  // Enough of Dropbox for the real Ready copy (handoff.ts) to run: folders, copies, deletes, the swap.
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
  const under = (dir: string) => [...dropboxFolder.keys()].filter((k) => k.toLowerCase().startsWith(`${dir.toLowerCase()}/`));
  if (url === "https://api.dropboxapi.com/2/files/create_folder_v2") return json({ metadata: { id: id("fld"), path_display: body.path } });
  if (url === "https://api.dropboxapi.com/2/files/delete_v2") {
    for (const k of [...under(body.path), body.path]) dropboxFolder.delete(k);
    return json({ metadata: { path_display: body.path } });
  }
  if (url === "https://api.dropboxapi.com/2/files/copy_v2") {
    const size = dropboxFolder.get(body.from_path);
    if (size == null) return json({ error_summary: "from_lookup/not_found/" }, 409);
    dropboxFolder.set(body.to_path, size);
    return json({ metadata: { path_display: body.to_path } });
  }
  if (url === "https://api.dropboxapi.com/2/files/move_v2") {
    for (const k of under(body.from_path)) {
      dropboxFolder.set(body.to_path + k.slice(body.from_path.length), dropboxFolder.get(k)!);
      dropboxFolder.delete(k);
    }
    return json({ metadata: { path_display: body.to_path } });
  }
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

    const sameDayOrder = async (projectId: string) => prisma.orderItem.create({ data: { projectId, title: "Same Day Photo Delivery", amount: 50 } });
    const mkJob = async (street: string, listingId: string, photos: number) => {
      const client = await prisma.client.create({ data: { name: `${street} Client` } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id, aryeoListingId: listingId } });
      const folder = `/AutoHDR/x/${street}/06-Ready-for-Aryeo`;
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY", deliveryPath: folder, deliveryStagedAt: new Date() } });
      const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1", "P4"]), startedAt: new Date(), finishedAt: new Date() } });
      await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
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
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
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
    c.head("5 · Ready to review: nothing reaches Aryeo before Kyle approves (Jordan, Oct 15)");
    const { photoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    await prisma.appSetting.update({ where: { key: "photo_delivery:settings" }, data: { value: JSON.stringify({ ...JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: "photo_delivery:settings" } })).value), aryeoPush: "auto" }) } });
    c.ok("the old stages (upload, approve, auto) read as on: Kyle approves", (await photoDeliverySettings()).aryeoPush === "on");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const C = await mkJob("30 Approve Ct", "L-C", 3);
    const drive1 = await P.drivePushes({ budgetMs: 60_000 });
    c.ok("a job Ready to review waits for Kyle: the cron sends nothing", !drive1.started.includes(C.job.id) && !(await P.pushProgress(C.job.id)) && listings.get("L-C")!.images.length === 0, JSON.stringify(drive1));
    // Oct 21 2026 (Jordan's decisions 6 and 7): an open photo flag is a line
    // on Kyle's checklist that never holds his approval, and his approval
    // closes the shoot's media check (the media_qa card) with the reason.
    await prisma.imageFlag.create({ data: { projectId: C.project.id, imageUrl: "https://example.test/30-approve.jpg", tags: JSON.stringify(["Sign in the yard"]) } });
    const qcCard = await prisma.smartTask.create({ data: { projectId: C.project.id, taskType: "media_qa", title: "QC & deliver 30 Approve Ct", assignedKey: "kyle", checklist: JSON.stringify([{ label: "QC Photos", done: false }]) } });
    const { deliveryGate } = await import("@/lib/photoDelivery/delivery");
    const gateC = await deliveryGate(C.job.id);
    const flagLine = gateC.checks.find((x) => x.key === "flags");
    c.ok("an open photo flag is a line on Kyle's checklist, linking to the flags, never counted against the checklist", !!flagLine && flagLine.advisory === true && flagLine.detail === "1 photo flag still open" && flagLine.href === `/projects/${C.project.id}#flags` && gateC.passed === gateC.checks.filter((x) => !x.advisory).every((x) => x.ok), JSON.stringify(gateC.checks));
    const ok = await P.approveJob(C.job.id, "Kyle", { deliver: true });
    const cStage = (await prisma.photoJob.findUniqueOrThrow({ where: { id: C.job.id } })).stage;
    c.ok("Approve and deliver: the photos go up first (nothing marked as delivering before they are on the listing)", ok.ok && ok.started && cStage === "READY", `${ok.message} ${cStage}`);
    const mediaCheckClosed = () => prisma.activity.count({ where: { projectId: C.project.id, body: { startsWith: "Media check closed" } } });
    const card = await prisma.smartTask.findUniqueOrThrow({ where: { id: qcCard.id } });
    c.ok("…the open flag did not hold it, and the approval closed the shoot's media check with the reason", ok.ok && card.status === "COMPLETED" && card.sourceDetail === "closed-by-hand" && /Photos approved in Photo Delivery by Kyle/.test(card.summary ?? "") && (await mediaCheckClosed()) === 1, JSON.stringify({ status: card.status, summary: card.summary }));
    for (let i = 0; i < 10; i++) await P.advancePush(C.job.id, { budgetMs: 30_000 });
    const del = calls.filter((x) => x.kind === "deliver").pop()?.body as Record<string, unknown>;
    c.ok("Deliver in Aryeo sends what Aryeo's Deliver window sends: its own email (subject, body, bcc) to the listing's customers", ok.ok && listings.get("L-C")!.delivery === "DELIVERED" && JSON.stringify(del.added_customer_ids) === JSON.stringify(["ctm-L-C"]) && (del.added_emails as unknown[]).length === 0 && del.email_subject === "Your listing media is ready!" && /902 Valley Rd/.test(String(del.email_body)) && del.email_bcc_list === "office@realtourpilot.com" && del.notify_via_email === true && del.fulfill_orders === true && del.schedule_date === null, JSON.stringify(del));
    c.ok("every change says where it comes from (Aryeo bounces one that doesn't)", !calls.some((x) => x.kind === "no-origin") && calls.some((x) => x.kind === "delivery-email"));
    const jc = await prisma.photoJob.findUniqueOrThrow({ where: { id: C.job.id } });
    const pc = await P.pushProgress(C.job.id);
    c.ok("the hub confirms DELIVERED through the API and the job is verified", jc.stage === "DELIVERED" && pc?.state === "DONE" && !!pc.deliveredAt, `${jc.stage} ${pc?.state}`);
    c.ok("…the media check closed once: the verified delivery found nothing left to close and reopened nothing", (await mediaCheckClosed()) === 1 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: qcCard.id } })).status === "COMPLETED");
    c.ok("…and the job's activity says Kyle approved it", (await prisma.photoJobEvent.count({ where: { jobId: C.job.id, actor: "Kyle", action: "approved: deliver" } })) === 1);

    // ======================================================================
    c.head("5b · a same-day order approves and delivers itself once every check passes, and an expired session signs in again");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const D = await mkJob("40 Auto Ln", "L-D", 2);
    await sameDayOrder(D.project.id);
    validSessions.clear();
    const logins0 = calls.filter((x) => x.kind === "login").length;
    await P.drivePushes({ budgetMs: 60_000 });
    for (let i = 0; i < 8; i++) await P.advancePush(D.job.id, { budgetMs: 30_000 });
    const jd = await prisma.photoJob.findUniqueOrThrow({ where: { id: D.job.id } });
    c.ok("delivered and verified with nobody pressing anything", listings.get("L-D")!.delivery === "DELIVERED" && jd.stage === "DELIVERED", jd.stage);
    c.ok("…the activity says the hub approved it as a same-day order", (await prisma.photoJobEvent.count({ where: { jobId: D.job.id, action: { startsWith: "same-day order, every check passes" } } })) === 1);
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
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
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
    c.ok("the job page carries the stage, the login and the push", view?.aryeoPush.mode === "on" && view.aryeoPush.connected && view.aryeoPush.progress?.state === "FAILED");

    // ======================================================================
    c.head("7 · marked as delivering before the folder existed (Bob's same-day override)");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const G = await mkJob("70 Same Day Rd", "L-G", 3);
    // Bob's job: no 06-Ready-for-Aryeo yet; its photos sit in Dropbox (the real Ready copy makes the folder).
    for (const k of [...dropboxFolder.keys()].filter((k) => k.startsWith(`${G.folder}/`))) dropboxFolder.delete(k);
    const gPhotos = await prisma.photoAsset.findMany({ where: { jobId: G.job.id } });
    for (const ph of gPhotos) {
      const src = `/AutoHDR/x/70 Same Day Rd/04-Final-Photos/${ph.name}`;
      dropboxFolder.set(src, 60_000);
      await prisma.photoAsset.update({ where: { id: ph.id }, data: { sourceKind: "DROPBOX", dropboxPath: src } });
    }
    await prisma.photoJob.update({ where: { id: G.job.id }, data: { stage: "DELIVERING", deliveryPath: null, deliveryStagedAt: null } });
    const pre = await P.requestPush(G.job.id, { by: "Jordan" });
    const pg0 = await P.pushProgress(G.job.id);
    c.ok("Send to Aryeo with no folder: it makes 06-Ready-for-Aryeo first", pre.ok && pre.started && pg0?.state === "PREPARING" && /ready/i.test(pre.message), `${pre.message} ${JSON.stringify(pg0)}`);
    for (let i = 0; i < 12; i++) await P.advancePush(G.job.id, { budgetMs: 30_000 });
    const jg = await prisma.photoJob.findUniqueOrThrow({ where: { id: G.job.id } });
    const folderFiles = jg.deliveryPath ? [...dropboxFolder.keys()].filter((k) => k.startsWith(`${jg.deliveryPath}/`)) : [];
    c.ok("…the folder is filled for real (the Ready copy ran)", folderFiles.length === 3 && /06-Ready-for-Aryeo$/.test(jg.deliveryPath ?? ""), `${jg.deliveryPath} ${JSON.stringify(folderFiles)}`);
    c.ok("then it sends, delivers in Aryeo and verifies (already marked as delivering: no second checklist press)", listings.get("L-G")!.images.length === 3 && listings.get("L-G")!.delivery === "DELIVERED" && jg.stage === "DELIVERED", `${jg.stage} ${listings.get("L-G")!.images.length} ${JSON.stringify(await P.pushProgress(G.job.id))}`);
    const drive2 = await P.drivePushes({ budgetMs: 30_000 });
    c.ok("a delivered job is never sent again", !drive2.started.includes(G.job.id) && (await P.requestPush(G.job.id, { by: "Kyle" })).message === "This job is already delivered.");
    // And from the cron: a job marked as delivering with no folder is picked up by itself (auto).
    const H2 = await mkJob("80 Cron Pick Ln", "L-H", 2);
    for (const k of [...dropboxFolder.keys()].filter((k) => k.startsWith(`${H2.folder}/`))) dropboxFolder.delete(k);
    for (const ph of await prisma.photoAsset.findMany({ where: { jobId: H2.job.id } })) {
      const src = `/AutoHDR/x/80 Cron Pick Ln/04-Final-Photos/${ph.name}`;
      dropboxFolder.set(src, 60_000);
      await prisma.photoAsset.update({ where: { id: ph.id }, data: { sourceKind: "AUTOHDR", sourceRef: null } });
    }
    await prisma.photoJob.update({ where: { id: H2.job.id }, data: { stage: "DELIVERING", deliveryPath: null, deliveryStagedAt: null } });
    const d3 = await P.drivePushes({ budgetMs: 30_000 });
    c.ok("auto: the cron picks up a job marked as delivering without a folder", d3.started.includes(H2.job.id), JSON.stringify(d3));

    // ======================================================================
    c.head("8 · never added twice, and never delivered past open issues by itself");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const I = await mkJob("90 Bounce Blvd", "L-I", 3);
    bounceAfterAttach = true;
    await P.requestPush(I.job.id, { by: "Kyle" });
    for (let i = 0; i < 10; i++) await P.advancePush(I.job.id, { budgetMs: 30_000 });
    const attachesI = calls.filter((x) => x.kind === "attach" && (x.body as { form_uuid_field: string }).form_uuid_field && ucGroups.get((x.body as { form_uuid_field: string }).form_uuid_field)?.every((u) => /^03|^02|^01/.test(ucFiles.get(u) ?? "") || true)).length;
    const pi = await P.pushProgress(I.job.id);
    c.ok("Aryeo signs the hub out right after it added the photos: the add is not sent again, the check finds them", listings.get("L-I")!.images.length === 3 && pi?.state === "DONE", `${listings.get("L-I")!.images.length} ${JSON.stringify(pi)} attaches=${attachesI}`);
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const K = await mkJob("95 Open Issue Way", "L-K", 2);
    const kRun = await prisma.photoJob.findUniqueOrThrow({ where: { id: K.job.id }, select: { lastQcRunId: true } });
    await prisma.photoQcFinding.create({ data: { qcRunId: kRun.lastQcRunId!, jobId: K.job.id, photoId: (await prisma.photoAsset.findFirstOrThrow({ where: { jobId: K.job.id } })).id, ruleId: "PREP_PERSONAL_DOCUMENTS", groupKey: "PREP_PERSONAL_DOCUMENTS", pass: "P1_PHOTO", source: "AHDR", specificIssue: "papers on the fridge", explanation: "x", severity: "CRITICAL", confidence: 0.95, responsibility: "ADMIN", fixStrategy: "HUMAN_REVIEW", privacySensitive: true, status: "OPEN" } });
    await P.requestPush(K.job.id, { by: "aryeo-push", then: "deliver" });
    for (let i = 0; i < 8; i++) await P.advancePush(K.job.id, { budgetMs: 30_000 });
    const pk = await P.pushProgress(K.job.id);
    c.ok("auto, shadow mode on, an open privacy issue: uploaded, NOT delivered, waits with why", listings.get("L-K")!.delivery === "UNDELIVERED" && pk?.state === "WAITING" && /open items/.test(pk.note ?? ""), JSON.stringify(pk));
    // Oct 20 2026 (audit C7): shadow mode advises on everything EXCEPT a privacy
    // or wrong-property critical, which a person's press can't wave through either.
    const pkNo = await P.approvePushDelivery(K.job.id, "Kyle");
    c.ok("…a person's Deliver in Aryeo is refused while the privacy issue is open, and says why", !pkNo.ok && /privacy or wrong-property/.test(pkNo.message) && listings.get("L-K")!.delivery === "UNDELIVERED", pkNo.message);
    await prisma.photoQcFinding.updateMany({ where: { jobId: K.job.id, ruleId: "PREP_PERSONAL_DOCUMENTS" }, data: { status: "IGNORED", decidedBy: "Kyle", decidedAt: new Date() } });
    const pkOk = await P.approvePushDelivery(K.job.id, "Kyle");
    c.ok("…once it is decided, a person's Deliver in Aryeo goes through the usual gate (shadow mode advises)", pkOk.ok, pkOk.message);

    // ======================================================================
    c.head("9 · a photo fixed after it went on the listing (audit, Oct 15)");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const M = await mkJob("100 Changed Ct", "L-M", 3);
    const dm = await P.approveJob(M.job.id, "Kyle", { deliver: false });
    for (let i = 0; i < 8; i++) await P.advancePush(M.job.id, { budgetMs: 30_000 });
    c.ok("Approve and upload: on the listing, Kyle delivers", dm.started && (await P.pushProgress(M.job.id))?.state === "DONE" && listings.get("L-M")!.images.length === 3 && listings.get("L-M")!.delivery === "UNDELIVERED", JSON.stringify(await P.pushProgress(M.job.id)));
    // A fix lands on photo 2 (a new version, same name in the folder).
    const second = M.order[1];
    await prisma.photoAsset.update({ where: { id: second.photoId }, data: { contentHash: "100 Changed Ct-1-fixed", inspectedHash: "100 Changed Ct-1-fixed" } });
    const uploads0 = calls.filter((x) => x.kind === "upload").length;
    const oldImg = listings.get("L-M")!.images.find((i) => i.filename === second.deliveryName)!.id;
    // Oct 23 2026 (615 Cliff Ln): Deliver on a changed set IS the approval to
    // send the changes, then it delivers by itself.
    const stale = await P.approvePushDelivery(M.job.id, "Kyle");
    c.ok("Deliver in Aryeo on a changed set sends the change first and says so", stale.ok && /changed since they went up/.test(stale.message) && listings.get("L-M")!.delivery === "UNDELIVERED", stale.message);
    for (let i = 0; i < 14; i++) await P.advancePush(M.job.id, { budgetMs: 30_000 });
    const lm = listings.get("L-M")!;
    const del0 = calls.filter((x) => x.kind === "delete").pop()?.body as { images: string[] } | undefined;
    c.ok("only the changed photo is replaced: the old one taken off, the new one sent, nothing doubled", JSON.stringify(del0?.images) === JSON.stringify([oldImg]) && calls.filter((x) => x.kind === "upload").length - uploads0 === 1 && lm.images.length === 3 && !lm.images.some((i) => i.id === oldImg), `${JSON.stringify(del0)} uploads=${calls.filter((x) => x.kind === "upload").length - uploads0} ${lm.images.length}`);
    c.ok("…back in delivery order, then delivered with the one press", [...lm.images].sort((a, b) => a.index - b.index).map((i) => i.filename).join() === M.order.map((o) => o.deliveryName).join() && lm.delivery === "DELIVERED", `${lm.delivery} ${JSON.stringify(await P.pushProgress(M.job.id))}`);

    // ======================================================================
    c.head("10 · the cron does not retry a refusal every five minutes");
    await savePhotoDeliverySettings({ aryeoPush: "on" }, "drill");
    const N = await mkJob("110 Others Rd", "L-N", 2);
    await sameDayOrder(N.project.id);
    listings.get("L-N")!.images.push({ id: "theirs-1", filename: "Theirs.jpg", index: 0, live: true, visibleAfter: 0 });
    await P.drivePushes({ budgetMs: 30_000 });
    const pn = await P.pushProgress(N.job.id);
    const reads1 = listings.get("L-N")!.reads;
    await P.drivePushes({ budgetMs: 30_000 });
    c.ok("the reason shows on the job and the next pass leaves the listing alone", pn?.state === "FAILED" && /not from 06-Ready-for-Aryeo/.test(pn.note ?? "") && listings.get("L-N")!.reads === reads1 && listings.get("L-N")!.images.length === 1, `${JSON.stringify(pn)} reads ${reads1}→${listings.get("L-N")!.reads}`);
    const rowN = await prisma.appSetting.findUniqueOrThrow({ where: { key: `photo_aryeo_push:${N.job.id}` } });
    await prisma.appSetting.update({ where: { key: rowN.key }, data: { value: JSON.stringify({ ...JSON.parse(rowN.value), retryAfter: new Date(Date.now() - 1000).toISOString() }) } });
    await P.drivePushes({ budgetMs: 30_000 });
    c.ok("…an hour later it looks again", listings.get("L-N")!.reads > reads1);
    c.ok("the reason is written in the job's activity once", (await prisma.photoJobEvent.count({ where: { jobId: N.job.id, action: { startsWith: "not sent to Aryeo" } } })) === 1);

    // ======================================================================
    c.head("11 · Kyle's approval that stopped on the hub's Aryeo login goes again once the login works (Godfrey, Oct 15)");
    const Q = await mkJob("120 Retry Rd", "L-Q", 2);
    validSessions.clear();
    refuseLogin = true;
    const aq = await P.approveJob(Q.job.id, "Kyle", { deliver: true });
    for (let i = 0; i < 6; i++) await P.advancePush(Q.job.id, { budgetMs: 30_000 });
    const pq = await P.pushProgress(Q.job.id);
    const connBad = await getConnection(W.ARYEO_WEB_PROVIDER);
    c.ok("the sign-in fails: stopped, nothing delivered, Connections says so", aq.started && pq?.state === "FAILED" && listings.get("L-Q")!.delivery === "UNDELIVERED" && !!connBad?.lastError, `${JSON.stringify(pq)} ${connBad?.lastError}`);
    const q0 = await P.drivePushes({ budgetMs: 30_000 });
    c.ok("…not retried every five minutes", !q0.started.includes(Q.job.id));
    refuseLogin = false;
    const rowQ = await prisma.appSetting.findUniqueOrThrow({ where: { key: `photo_aryeo_push:${Q.job.id}` } });
    await prisma.appSetting.update({ where: { key: rowQ.key }, data: { value: JSON.stringify({ ...JSON.parse(rowQ.value), retryAfter: new Date(Date.now() - 1000).toISOString() }) } });
    const q1 = await P.drivePushes({ budgetMs: 60_000 });
    for (let i = 0; i < 10; i++) await P.advancePush(Q.job.id, { budgetMs: 30_000 });
    const jq = await prisma.photoJob.findUniqueOrThrow({ where: { id: Q.job.id } });
    c.ok("half an hour later, the login working, the cron sends Kyle's approval again and it is delivered", q1.started.includes(Q.job.id) && listings.get("L-Q")!.delivery === "DELIVERED" && jq.stage === "DELIVERED", `${JSON.stringify(q1)} ${jq.stage}`);
    c.ok("…and Connections no longer says the sign-in is failing", !(await getConnection(W.ARYEO_WEB_PROVIDER))?.lastError);

    // ======================================================================
    c.head("12 · the connection drops on Deliver: the run waits and carries on, delivered once (825 State St, Oct 29)");
    for (const [street, listingId, when] of [["130 Drop Rd", "L-R", "before"], ["140 Drop Rd", "L-S", "after"]] as const) {
      const R = await mkJob(street, listingId, 2);
      const ar = await P.approveJob(R.job.id, "Kyle", { deliver: true });
      dropDeliver = when;
      const delivers0 = calls.filter((x) => x.kind === "deliver").length;
      let saw: string | null = null;
      for (let i = 0; i < 12; i++) {
        await P.advancePush(R.job.id, { budgetMs: 30_000 });
        const pr = await P.pushProgress(R.job.id);
        if (pr?.state === "FAILED") { saw = `FAILED: ${pr.note}`; break; }
        if (!saw && /could not be reached/.test(pr?.note ?? "")) saw = pr!.note;
      }
      const pr = await P.pushProgress(R.job.id);
      const jr = await prisma.photoJob.findUniqueOrThrow({ where: { id: R.job.id } });
      const pressed = calls.filter((x) => x.kind === "deliver").length - delivers0;
      c.ok(`dropped ${when} Aryeo delivered: never stopped, said so while it waited, then delivered and verified`, ar.started && dropDeliver === null && !!saw && !saw.startsWith("FAILED") && /fetch failed\)\. The hub tries again in a few minutes\./.test(saw) && pr?.state === "DONE" && listings.get(listingId)!.delivery === "DELIVERED" && jr.stage === "DELIVERED", `${saw} · ${pr?.state} · ${jr.stage}`);
      c.ok(`…Deliver pressed ${when === "before" ? "twice (the first never reached Aryeo)" : "once (the listing read as delivered, so never again)"}`, pressed === (when === "before" ? 2 : 1), String(pressed));
    }

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

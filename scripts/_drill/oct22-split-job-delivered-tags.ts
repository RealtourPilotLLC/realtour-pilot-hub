// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: a split job's delivered tags, one gallery, no duplicates (Oct 22 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-split-job-delivered-tags.ts
//
// Jordan on 615 Cliff Ln: "Since we already delivered Alex's exteriors, can we
// make sure that we know which photo is delivered and which one needs to not
// be delivered again and make sure there are no duplicates in Aryeo but also
// show all the pics together in the hub and let us know which ones are
// already delivered and which ones are not?"
//
// The Cliff Ln shape: the Oct 7 visit's 23 exteriors are delivered on the
// listing; the Oct 21 visit's 36 interiors are back from AutoHDR; Kyle left
// DSC07999 out in the hub and put it on the listing by hand.
//   1 · the matchers (pure): file names, duplicates, the numbering offset,
//       room coverage reads the whole listing
//   2 · ONE gallery: 59 photos, 24 "Delivered" (with the day first seen),
//       35 "Not delivered yet"; the listing's order first, its cover first
//   3 · the checks stay on the new visit (the free check's line, a finding
//       on a delivered photo set aside)
//   4 · Approve and deliver: exactly the 35 go to Aryeo, none of the 24, the
//       cover stays first, nothing asks for Send anyway, the listing verifies
//       as 59 with no photo twice; the sync carries everything over after
//   5 · a duplicate on the listing is flagged for Kyle, never deleted
//       (the delivery check and the push, which holds its own delivery)
//   6 · a single-visit job is unchanged (names, order, fingerprint)
//   7 · the view-only Photos desk: the same tags and counts, no controls
//
// ISOLATION: PGlite via the shared harness; Aryeo's web app, its API,
// Uploadcare, Dropbox and Slack are answered in-process. Nothing leaves.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery";
  nav.useSearchParams = () => new URLSearchParams();
}

// ---- the fakes (shaped like oct14-aryeo-push.ts) ----------------------------------------------
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
const UC_KEY = "c0ffee0123456789abcd";
type Img = { id: string; filename: string; index: number };
type Listing = { id: string; delivery: "UNDELIVERED" | "DELIVERED"; images: Img[] };
const listings = new Map<string, Listing>();
const ucFiles = new Map<string, string>();
const ucGroups = new Map<string, string[]>();
const calls: { kind: string; listing?: string; body?: unknown }[] = [];
const validSessions = new Set<string>();
const pendingSessions = new Set<string>();
const dropboxFolder = new Map<string, number>();
let seq = 0;
const nid = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const sorted = (l: Listing) => [...l.images].sort((a, b) => a.index - b.index);
const stem = (f: string) => f.replace(/\.jpg$/i, "");

function editPage(l: Listing) {
  return {
    component: "Company/Listings/EditListing",
    version: "v1",
    url: `/admin/listings/${l.id}/edit`,
    props: {
      errors: {},
      listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Alex Drill" } }] },
      images: sorted(l).map((i) => ({ id: i.id, title: null, is_live: true, filename: stem(i.filename), filename_extension: "jpg" })),
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
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/login") {
    if (method === "GET") {
      if (h.get("x-inertia") === "true") return json({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: { errors: {} } });
      const page = JSON.stringify({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: {} }).replace(/"/g, "&quot;");
      return withCookies(new Response(`<html><script>window.UPLOADCARE_PUBLIC_KEY = "${UC_KEY}";</script><div id="app" data-page="${page}"></div></html>`, { status: 200, headers: { "content-type": "text/html" } }), ["XSRF-TOKEN=tok%3D%3D; path=/; domain=.aryeo.com", "aryeo_session=anon; path=/; domain=.aryeo.com; httponly"]);
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
  if (method !== "GET" && (h.get("origin") !== "https://realtourpilot.aryeo.com" || !(h.get("referer") ?? "").startsWith("https://realtourpilot.aryeo.com/admin/listings/"))) return redirect("https://app.aryeo.com/login");
  if (u.pathname === "/admin/dashboard" && method === "GET") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    if (!l) return new Response("nope", { status: 404 });
    if (h.get("x-inertia-partial-component") === "Company/Listings/EditListing" && (h.get("x-inertia-partial-data") ?? "").split(",").includes("delivery_email")) {
      return json({ component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`, props: { delivery_email: { email_subject: "Your listing media is ready!", email_body: "<p>Ready.</p>", email_cc_list: "", email_bcc_list: "" } } });
    }
    return json(editPage(l));
  }
  m = /^\/admin\/listing\/([^/]+)\/image-uploads$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { form_uuid_field: string };
    calls.push({ kind: "attach", listing: l.id, body: b });
    for (const uuid of ucGroups.get(b.form_uuid_field) ?? []) {
      // Like the real Aryeo: new photos are filed at the FRONT, in reverse (the hub must put the cover back first).
      l.images.forEach((i) => i.index++);
      l.images.push({ id: nid("img"), filename: ucFiles.get(uuid)!, index: 0 });
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/listing\/([^/]+)\/images$/.exec(u.pathname);
  if (m && method === "PUT") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: { id: string }[] };
    calls.push({ kind: "reorder", listing: l.id, body: b });
    b.images.forEach((x, k) => {
      const i = l.images.find((y) => y.id === x.id);
      if (i) i.index = k;
    });
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  if (m && method === "DELETE") {
    const l = listings.get(m[1])!;
    calls.push({ kind: "delete", listing: l.id, body: JSON.parse(String(init?.body)) });
    const b = JSON.parse(String(init?.body)) as { images: string[] };
    l.images = l.images.filter((i) => !b.images.includes(i.id));
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    calls.push({ kind: "deliver", listing: l.id });
    l.delivery = "DELIVERED";
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  return new Response("not faked", { status: 404 });
}

async function uploadcare(url: string, init?: RequestInit): Promise<Response | null> {
  if (!url.startsWith("https://upload.uploadcare.com/")) return null;
  const form = init?.body as FormData;
  if (url.endsWith("/base/")) {
    if (form.get("UPLOADCARE_PUB_KEY") !== UC_KEY) return json({ error: "pub_key is invalid" }, 403);
    const file = form.get("file") as File;
    const uuid = nid("uc");
    ucFiles.set(uuid, file.name);
    calls.push({ kind: "upload", body: file.name });
    return json({ file: uuid });
  }
  if (url.endsWith("/group/")) {
    const files: string[] = [];
    for (let i = 0; form.get(`files[${i}]`); i++) files.push(String(form.get(`files[${i}]`)));
    const gid = `${nid("grp")}~${files.length}`;
    ucGroups.set(gid, files);
    return json({ id: gid, files_count: files.length });
  }
  return null;
}

function aryeoApi(url: string): Response | null {
  if (!url.startsWith("https://api.aryeo.com/v1/listings/")) return null;
  const l = listings.get(new URL(url).pathname.split("/")[3]);
  if (!l) return json({ message: "Not found" }, 404);
  return json({ data: { id: l.id, delivery_status: l.delivery, images: sorted(l).map((i, k) => ({ id: i.id, filename: i.filename, original_url: `https://cdn.aryeo.com/${i.id}.jpg`, display_in_gallery: true, index: k })), floor_plans: [] } });
}

function dropbox(url: string, init?: RequestInit): Response | null {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  if (url === "https://api.dropboxapi.com/2/files/list_folder") {
    const a = JSON.parse(String(init?.body)) as { path: string };
    const entries = [...dropboxFolder.entries()].filter(([p]) => p.startsWith(`${a.path}/`)).map(([p, size]) => ({ ".tag": "file", name: p.slice(a.path.length + 1), path_display: p, id: `id:${p}`, size }));
    return json({ entries, has_more: false });
  }
  if (url.startsWith("https://api.dropboxapi.com/") || url.startsWith("https://content.dropboxapi.com/")) return json({ error_summary: "not_found/" }, 409);
  return null;
}

const fence = fenceFetch(async (url, init) => (await aryeoWeb(url, init)) ?? (await uploadcare(url, init)) ?? aryeoApi(url) ?? dropbox(url, init) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/\s+/g, " ");
const LONG_DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6131), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const M = await import("@/lib/photoDelivery/listingMatch");
    const coverage = await import("@/lib/photoDelivery/coverage");
    const handoff = await import("@/lib/photoDelivery/handoff");
    const { setPhotoExcluded } = await import("@/lib/photoDelivery/decisions");
    const data = await import("@/app/ops/photo-delivery/data");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("aryeo_web", LOGIN.password, { metadata: { email: LOGIN.email } });
    await savePhotoDeliverySettings({ enabled: true, qcShadow: true, aryeoPush: "on" }, "drill");
    P.__setPushDownloaderForTests(async (path) => {
      if (!dropboxFolder.has(path)) throw new Error(`not in the folder: ${path}`);
      return Buffer.alloc(dropboxFolder.get(path)!, 7);
    });
    const T = (iso: string) => new Date(iso);
    const kyleView = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };
    const jamesView = { role: "CREATIVE_MANAGER", name: "James", isOwner: false, canSeeMoney: false, readOnly: true };

    // ======================================================================
    c.head("1 · the matchers (pure)");
    // ======================================================================
    c.ok("a hand-added copy is its photo by file name (DSC07999.jpg, DSC07999-2.jpg, dsc07999 copy.jpeg)", M.sameFile("DSC07999.jpg", "DSC07999.jpg") && M.sameFile("DSC07999-2.jpg", "DSC07999.jpg") && M.sameFile("dsc07999 copy.jpeg", "DSC07999.jpg"));
    c.ok("…never a name the hub or AutoHDR gave, a different number, or a short word", !M.sameFile("615 Cliff Ln (7 of 23).jpg", "DSC07999.jpg") && !M.sameFile("25-Kitchen.jpg", "DSC07999.jpg") && !M.sameFile("DSC07998.jpg", "DSC07999.jpg") && !M.sameFile("DSC07999.jpg", "DSC079990.jpg") && !M.sameFile("Kitchen.jpg", "Kitchen.jpg"));
    const dups = M.listingDuplicates(
      [{ name: "A.jpg", sourceRef: "1", contentHash: "a" }, { name: "B.jpg", sourceRef: "2", contentHash: "b" }, { name: "a.jpg", sourceRef: "3", contentHash: "c" }, { name: "C.jpg", sourceRef: "4", contentHash: "d" }, { name: "D.jpg", sourceRef: "5", contentHash: "e" }],
      (i) => (i.sourceRef === "4" || i.sourceRef === "5" ? "photo-x" : null),
    );
    c.ok("duplicates: the same file name twice, and two images of one photo; each said once", dups.length === 2 && M.duplicateWords(dups) === "A.jpg twice; C.jpg and D.jpg (the same photo)", M.duplicateWords(dups));
    c.ok("the new visit is numbered after what is on the listing (24 there: from 25; after an earlier '30-' name: from 31); 0 on a single visit", delivery.listingOffset(Array.from({ length: 24 }, (_, k) => `615 Cliff Ln (${k + 1} of 23).jpg`)) === 24 && delivery.listingOffset(["30-Rear.jpg", "x.jpg"]) === 30 && delivery.listingOffset([]) === 0);
    const room = (name: string, r: string | null) => ({ id: name, name, room: r as never, features: [] });
    const base = { bedrooms: 3, bathrooms: 2, propertyType: "single family", notDelivered: [], capturedComplete: true, unlabeledCaptured: 0, featuresKnown: false, lostInEdit: [] };
    const inside = [room("k", "KITCHEN"), room("l", "LIVING"), room("b", "PRIMARY_BEDROOM"), room("pb", "PRIMARY_BATHROOM"), room("b2", "BATHROOM")];
    const before = coverage.assessCoverage({ ...base, delivered: inside });
    const unlabeled = coverage.assessCoverage({ ...base, delivered: inside, unlabeledOnListing: 24 });
    const labeled = coverage.assessCoverage({ ...base, delivered: [...inside, room("fx", "EXTERIOR_FRONT"), room("rx", "EXTERIOR_REAR")] });
    const front = (rows: typeof before) => rows.find((r) => r.key === "front-exterior")!;
    c.ok("coverage on the new visit alone (the old way): front exterior 'never photographed' (MAJOR)", front(before).status === "NOT_CAPTURED" && front(before).severity === "MAJOR");
    c.ok("coverage reads the whole listing: the earlier visit's exteriors count when labeled", front(labeled).status === "DELIVERED" && labeled.find((r) => r.key === "rear-exterior")!.status === "DELIVERED");
    c.ok("…and 24 delivered photos with no room label never read as 'never photographed': a minor line to check the listing", front(unlabeled).status === "ADVISORY" && front(unlabeled).severity === "MINOR" && /already delivered on the listing/.test(front(unlabeled).note) && coverage.findingsFor(unlabeled, []).every((f) => f.severity === "MINOR" && !/never photographed/.test(f.specificIssue)), JSON.stringify(front(unlabeled)));

    // ======================================================================
    c.head("2 · 615 Cliff Ln: one gallery, every photo, a tag on each");
    // ======================================================================
    const client = await prisma.client.create({ data: { name: "Alex Drill" } });
    const oct21 = T("2026-10-21T20:15:00Z");
    const project = await prisma.project.create({ data: { title: "615 Cliff Ln, Phoenixville, PA", addressLine: "615 Cliff Ln", clientId: client.id, aryeoListingId: "LC", shootDate: oct21, status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-c1", projectId: project.id, startAt: T("2026-10-07T17:30:00Z"), status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-c2", projectId: project.id, startAt: oct21, status: "SCHEDULED" } });
    listings.set("LC", { id: "LC", delivery: "DELIVERED", images: Array.from({ length: 23 }, (_, k) => ({ id: `old${k + 1}`, filename: `615 Cliff Ln (${k + 1} of 23).jpg`, index: k })) });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "EDITING", nextCheckAt: oct21 } });
    await jobs.syncJobFinals(job.id, T("2026-10-21T20:18:30Z"));
    c.ok("waiting for the new visit: the earlier visit's 23 are on the job as delivered", (await prisma.photoAsset.count({ where: { jobId: job.id, status: "ON_LISTING" } })) === 23 && (await prisma.photoAsset.count({ where: { jobId: job.id, status: "ACTIVE" } })) === 0);

    const N = 36;
    const names = Array.from({ length: N }, (_, k) => `DSC0${7964 + k}.jpg`); // DSC07964 … DSC07999
    const photos = names.map((name, k) => ({ image_uuid: `u${k + 1}`, image_version_uuid: `v${k + 1}`, name }));
    await prisma.photoIntakeBatch.create({ data: { projectId: project.id, batchNo: 2, rawPath: "/raw", filesJson: "[]", fileCount: 180, fingerprint: "f2", seenAt: T("2026-10-22T11:13:29Z"), state: "DONE", photoshootId: 2320001, address: "615 Cliff Ln (more photos 2)", sentAt: T("2026-10-22T11:45:00Z"), doneAt: T("2026-10-22T12:20:00Z"), photosJson: JSON.stringify(photos) } });
    await jobs.syncJobFinals(job.id, T("2026-10-22T12:30:00Z"));
    await jobs.syncJobFinals(job.id, T("2026-10-22T12:40:00Z"));
    let j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("the new visit's 36 back from AutoHDR are the delivery; the 23 stay delivered beside them", (await prisma.photoAsset.count({ where: { jobId: job.id, status: "ACTIVE", sourceKind: "AUTOHDR" } })) === N && (await prisma.photoAsset.count({ where: { jobId: job.id, status: "ON_LISTING", sourceKind: "ARYEO" } })) === 23 && j.stage === "EDITED", j.stage);

    // Kyle leaves DSC07999 out in the hub and puts his own edit of it on the listing (Oct 22, 1:04 PM).
    const u36 = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: job.id, autohdrImageUuid: "u36" } });
    c.ok("(DSC07999 is the hub's 36th photo)", u36.name === "DSC07999.jpg", u36.name);
    await setPhotoExcluded(u36.id, true, "Adding this one manually", "Kyle", job.id);
    listings.get("LC")!.images.push({ id: "manual1", filename: "DSC07999.jpg", index: 23 });
    await jobs.syncJobFinals(job.id, T("2026-10-22T13:04:03Z"));
    const u36b = await prisma.photoAsset.findUniqueOrThrow({ where: { id: u36.id } });
    c.ok("the hand-added DSC07999 on the listing is found as the hub's DSC07999: delivered, not a 60th photo", u36b.status === "ON_LISTING" && (await prisma.photoAsset.count({ where: { jobId: job.id, status: { not: "GONE" } } })) === 59 && !(await prisma.photoAsset.findFirst({ where: { jobId: job.id, sourceRef: "manual1" } })), u36b.status);
    c.ok("…and the job's history says so", (await prisma.photoJobEvent.count({ where: { jobId: job.id, action: { contains: "already on the Aryeo listing as DSC07999.jpg (added by hand)" } } })) === 1);

    const kyleDetail = (await data.loadJobDetail(job.id, { viewer: kyleView }))!;
    const listed = kyleDetail.photos.filter((p) => p.status === "ON_LISTING");
    const toSend = kyleDetail.photos.filter((p) => p.status === "ACTIVE");
    c.ok("the job page: 59 photos together, 24 delivered and 35 not delivered yet", listed.length === 24 && toSend.length === 35 && kyleDetail.listing?.delivered === 24 && kyleDetail.listing?.notDelivered === 35, JSON.stringify(kyleDetail.listing));
    c.ok("the listing's order first: its cover is photo 01, the hand-added one after the 23, then the new ones from 25", listed[0].name === "615 Cliff Ln (1 of 23).jpg" && listed[0].position === 1 && listed[22].name === "615 Cliff Ln (23 of 23).jpg" && listed[23].id === u36.id && listed[23].position === 24 && toSend[0].position === 25 && toSend[34].position === 59);
    c.ok("each delivered photo carries the day it was first seen on the listing; DSC07999 its listing file name", listed.every((p) => !!p.delivered?.since) && listed[23].delivered?.asName === "DSC07999.jpg" && toSend.every((p) => !p.delivered));
    const order = await delivery.deliveryOrderFor(job.id);
    c.ok("the new photos are named after the listing's (25-… to 59-…), so none shares a name with one already there", order.length === 35 && /^25-/.test(order[0].deliveryName) && /^59-/.test(order[34].deliveryName) && order.every((o) => o.photoId !== u36.id), `${order[0]?.deliveryName} … ${order[34]?.deliveryName}`);
    const queue = await data.loadQueue({ viewer: { readOnly: false } });
    const card = queue.columns.flatMap((col) => col.cards).find((x) => x.id === job.id);
    c.ok("the board's card counts all 59 and shows the listing's cover", card?.photoCount === 59 && card?.hero?.photoId === listed[0].id, `${card?.photoCount} ${card?.hero?.photoId === listed[0].id}`);
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const kyleHtml = html(createElement(JobWorkspace, { data: kyleDetail, viewer: kyleView, history: null }));
    const galleryOf = (h: string) => text(h.split('id="pd-gallery-h"')[1] ?? "").split("Deliver")[0];
    const kg = galleryOf(kyleHtml);
    c.ok("Kyle's gallery heading: 59 photos · 24 delivered · 35 not delivered yet", /59 photos · 24 delivered · 35 not delivered yet/.test(kg), kg.slice(0, 200));
    c.ok("…24 Delivered tags (with the day) and 35 Not delivered yet tags", (kyleHtml.match(/>\s*Delivered Oct \d+</g) ?? []).length === 24 && (kyleHtml.match(/Not delivered yet\s*</g) ?? []).length === 35, `${(kyleHtml.match(/>\s*Delivered Oct \d+</g) ?? []).length} ${(kyleHtml.match(/Not delivered yet\s*</g) ?? []).length}`);
    c.ok("…the delivered photos have no hero or leave-out control; the new ones keep theirs", !/Make Photo 0?\d\b the hero|Leave Photo (0\d|1\d|2[0-4]) out/.test(kyleHtml) && /Leave Photo 25 out of the delivery/.test(kyleHtml) && /Make Photo 25 the hero/.test(kyleHtml));
    c.ok("…in plain words, no em dashes", !LONG_DASH.test(kg));

    // ======================================================================
    c.head("3 · the checks stay on the new visit");
    // ======================================================================
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1"]), checksJson: JSON.stringify({ v: 2 }), startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id, stage: "READY" } });
    for (const p of await prisma.photoAsset.findMany({ where: { jobId: job.id, status: "ACTIVE" } })) await prisma.photoAsset.update({ where: { id: p.id }, data: { inspectedHash: p.contentHash, width: 6000, height: 4000, format: "jpeg" } });
    const gate = await delivery.deliveryGate(job.id);
    c.ok("the checklist's 'QC covers every photo' reads the 35 only (the 24 delivered were checked when they went out)", gate.checks.find((x) => x.key === "qc")?.ok === true && gate.checks.find((x) => x.key === "files")?.ok === true, JSON.stringify(gate.checks.filter((x) => !x.ok)));
    const old1 = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: job.id, sourceRef: "old1" } });
    await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: old1.id, pass: "P1_PHOTO", source: "AHDR", ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", severity: "MAJOR", confidence: 0.9, specificIssue: "Bin by the garage", explanation: "x", responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK" } });
    await jobs.syncJobFinals(job.id, T("2026-10-22T13:10:00Z"));
    const set = await prisma.photoQcFinding.findFirstOrThrow({ where: { jobId: job.id, photoId: old1.id } });
    c.ok("an open finding on a delivered photo is set aside, never holding the new visit", set.status === "SUPERSEDED" && set.statusReason === M.ON_LISTING_REASON, `${set.status} ${set.statusReason}`);
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("…and the job is still Kyle's to approve (Ready to review)", j.stage === "READY", j.stage);

    // ======================================================================
    c.head("4 · Approve and deliver: only the 35, the cover stays first, 59 verified");
    // ======================================================================
    const folder = "/AutoHDR/x/615 Cliff Ln/06-Ready-for-Aryeo";
    await prisma.photoJob.update({ where: { id: job.id }, data: { deliveryPath: folder, deliveryStagedAt: new Date() } });
    const fill = async (jobId: string, dir: string) => {
      const ord = await delivery.deliveryOrderFor(jobId);
      for (const o of ord) dropboxFolder.set(`${dir}/${o.deliveryName}`, 60_000 + o.deliveryName.length);
      const fp = await handoff.readyFingerprintFor(jobId);
      const at = new Date().toISOString();
      await prisma.appSetting.create({ data: { key: `photo_ready_run:${jobId}`, updatedBy: "drill", value: JSON.stringify({ id: "r1", state: "DONE", folder: dir, staging: dir, fingerprint: fp, by: "drill", startedAt: at, updatedAt: at, finishedAt: at, note: null, lease: null, items: ord.map((o) => ({ photoId: o.photoId, name: o.deliveryName, state: "DONE", tries: 1, bytes: 60_000, error: null })) }) } });
      return ord;
    };
    const ord = await fill(job.id, folder);
    const coverBefore = sorted(listings.get("LC")!)[0].filename;
    const appr = await P.approveJob(job.id, "Kyle", { deliver: true });
    c.ok("Kyle's Approve and deliver starts, with no Send anyway (the 24 are expected there)", appr.ok && appr.started && !/Send anyway/.test(appr.message), appr.message);
    for (let i = 0; i < 20; i++) {
      const pr = await P.advancePush(job.id, { budgetMs: 30_000 });
      if (!pr?.active) break;
    }
    const prog = await P.pushProgress(job.id);
    const uploads = calls.filter((x) => x.kind === "upload").map((x) => String(x.body));
    c.ok("the push sent exactly the 35, by their delivery names", uploads.length === 35 && ord.every((o) => uploads.includes(o.deliveryName)) && new Set(uploads).size === 35, `${uploads.length}: ${uploads.slice(0, 3).join(", ")}`);
    c.ok("…none of the 24 already there (no earlier visit's photo, no DSC07999)", !uploads.some((u) => /Cliff Ln|DSC07999/.test(u)));
    c.ok("…and took nothing off the listing", !calls.some((x) => x.kind === "delete"));
    const after = sorted(listings.get("LC")!).map((i) => i.filename);
    c.ok("the listing: the earlier visit's 23 first in their order (the cover still the cover), DSC07999, then the 35 in Kyle's order", after.length === 59 && after[0] === coverBefore && after.slice(0, 23).every((f, k) => f === `615 Cliff Ln (${k + 1} of 23).jpg`) && after[23] === "DSC07999.jpg" && after.slice(24).join() === ord.map((o) => o.deliveryName).join(), after.slice(0, 2).concat(after.slice(22, 26)).join(" | "));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    const diff = JSON.parse(j.deliveryDiffJson ?? "{}") as { approved?: number; aryeoCount?: number; duplicates?: unknown[]; missing?: unknown[] };
    c.ok("the delivery check counts the whole listing: 59 approved, 59 on it, nothing missing", j.stage === "DELIVERED" && prog?.state === "DONE" && diff.approved === 59 && diff.aryeoCount === 59 && diff.missing?.length === 0, `${j.stage} ${prog?.state} ${j.deliveryDiffJson}`);
    c.ok("…and reports no photo twice, on the job", diff.duplicates?.length === 0 && /no photo on it twice/.test(j.deliveryCheckNote ?? "") && (await prisma.photoJobEvent.count({ where: { jobId: job.id, action: "checked the listing: 59 photos on it, no photo twice" } })) === 1, j.deliveryCheckNote ?? "");
    await jobs.syncJobFinals(job.id, T("2026-10-22T14:00:00Z"));
    const rows = await prisma.photoAsset.findMany({ where: { jobId: job.id, status: { not: "GONE" } } });
    c.ok("the next sync carries the 35 over in place and every photo is simply on the listing: 59 rows, all ACTIVE, no new ones", rows.length === 59 && rows.every((r) => r.status === "ACTIVE" && r.sourceKind === "ARYEO") && rows.filter((r) => r.autohdrImageUuid).length === 36 && (await prisma.photoAsset.count({ where: { jobId: job.id } })) === 59, `${rows.length} ${rows.filter((r) => r.status !== "ACTIVE").map((r) => `${r.name}:${r.status}`).join(",")}`);
    c.ok("…DSC07999 follows its listing image (the hand-added one), keeping its AutoHDR link", rows.find((r) => r.id === u36.id)?.sourceRef === "manual1");
    const reverify = await delivery.verifyDelivery(job.id, "drill");
    c.ok("verified again after the carry-over: 59 of 59", reverify.ok && reverify.approved === 59 && reverify.aryeoCount === 59, reverify.message);

    // ======================================================================
    c.head("4b · the push's own guard: a copy added by hand since the last sync is not sent again");
    // ======================================================================
    const p5 = await prisma.project.create({ data: { title: "3 Hand Pl, Reading, PA", addressLine: "3 Hand Pl", clientId: client.id, aryeoListingId: "LH", shootDate: oct21 } });
    const j5 = await prisma.photoJob.create({ data: { projectId: p5.id, stage: "READY", deliveryPath: "/AutoHDR/x/3 Hand Pl/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: j5.id, name: `3 Hand Pl (${k + 1} of 2).jpg`, sourceKind: "ARYEO", sourceRef: `h${k + 1}`, contentHash: M.listingImageHash(`h${k + 1}`, `https://cdn.aryeo.com/h${k + 1}.jpg`), sequence: k, status: "ON_LISTING" } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: j5.id, name: `IMG_${7001 + k}.jpg`, sourceKind: "AUTOHDR", contentHash: `hp-${k}`, inspectedHash: `hp-${k}`, sequence: 2 + k, status: "ACTIVE" } });
    listings.set("LH", { id: "LH", delivery: "DELIVERED", images: [{ id: "h1", filename: "3 Hand Pl (1 of 2).jpg", index: 0 }, { id: "h2", filename: "3 Hand Pl (2 of 2).jpg", index: 1 }, { id: "hand", filename: "IMG_7002.jpg", index: 2 }] });
    const ord5 = await fill(j5.id, "/AutoHDR/x/3 Hand Pl/06-Ready-for-Aryeo");
    const up5 = calls.filter((x) => x.kind === "upload").length;
    const r5 = await P.requestPush(j5.id, { by: "Kyle", approvedBy: "Kyle" });
    for (let i = 0; i < 20; i++) {
      const pr = await P.advancePush(j5.id, { budgetMs: 30_000 });
      if (!pr?.active) break;
    }
    const sent5 = calls.filter((x) => x.kind === "upload").slice(up5).map((x) => String(x.body));
    const l5 = sorted(listings.get("LH")!).map((i) => i.filename);
    c.ok("IMG_7002 is found on the listing by its file name and not sent; only IMG_7001 goes (as 03-…)", r5.started && sent5.length === 1 && sent5[0] === ord5[0].deliveryName && /^03-/.test(sent5[0]) && /1 found on the listing already \(IMG_7002\.jpg, by file name\) is not sent again/.test(r5.message), `${sent5.join()} · ${r5.message}`);
    c.ok("…the listing keeps its own first, the hand-added copy where it was, the new photo after", l5.join() === `3 Hand Pl (1 of 2).jpg,3 Hand Pl (2 of 2).jpg,IMG_7002.jpg,${ord5[0].deliveryName}`, l5.join(" | "));
    c.ok("…and the hub never lists that copy as its own (so it can never take it off)", !(await P.pushedNames(j5.id)).has("img_7002.jpg") && (await P.pushProgress(j5.id))?.matched === 1);

    // ======================================================================
    c.head("5 · a photo on the listing twice is flagged for Kyle, never deleted");
    // ======================================================================
    const deletesBefore = calls.filter((x) => x.kind === "delete").length;
    listings.get("LC")!.images.push({ id: "dup1", filename: ord[3].deliveryName, index: 59 });
    const dv = await delivery.verifyDelivery(job.id, "drill");
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("the delivery check finds it, names it, and puts the job in Delivery mismatch", !dv.ok && /on the listing twice \(.*twice\)/.test(dv.message) && j.stage === "DELIVERY_MISMATCH" && (JSON.parse(j.deliveryDiffJson ?? "{}").duplicates ?? []).length === 1, dv.message);
    c.ok("…the hub deleted nothing in Aryeo", calls.filter((x) => x.kind === "delete").length === deletesBefore && listings.get("LC")!.images.some((i) => i.id === "dup1"));
    c.ok("…in plain words, no em dashes", !LONG_DASH.test(dv.message));

    // The push's own check: a split job whose listing already holds a copy the hub can't place (Kyle sends anyway).
    const p2 = await prisma.project.create({ data: { title: "9 Twin Ct, Reading, PA", addressLine: "9 Twin Ct", clientId: client.id, aryeoListingId: "LT", shootDate: oct21 } });
    const j2 = await prisma.photoJob.create({ data: { projectId: p2.id, stage: "READY", deliveryPath: "/AutoHDR/x/9 Twin Ct/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    for (let k = 0; k < 3; k++) await prisma.photoAsset.create({ data: { jobId: j2.id, name: `9 Twin Ct (${k + 1} of 3).jpg`, sourceKind: "ARYEO", sourceRef: `t${k + 1}`, contentHash: M.listingImageHash(`t${k + 1}`, `https://cdn.aryeo.com/t${k + 1}.jpg`), sequence: k, status: "ON_LISTING" } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: j2.id, name: `IMG_${5101 + k}.jpg`, sourceKind: "AUTOHDR", contentHash: `tw-${k}`, inspectedHash: `tw-${k}`, sequence: 3 + k, status: "ACTIVE", roomType: "KITCHEN", sequenceGroup: "KITCHEN" } });
    listings.set("LT", { id: "LT", delivery: "UNDELIVERED", images: [...[1, 2, 3].map((k) => ({ id: `t${k}`, filename: `9 Twin Ct (${k} of 3).jpg`, index: k - 1 })), { id: "t2b", filename: "9 Twin Ct (2 of 3).jpg", index: 3 }] });
    await fill(j2.id, "/AutoHDR/x/9 Twin Ct/06-Ready-for-Aryeo");
    const held = await P.requestPush(j2.id, { by: "Kyle", then: "deliver", approvedBy: "Kyle" });
    const anyway = await P.requestPush(j2.id, { by: "Kyle", then: "deliver", approvedBy: "Kyle", anyway: true });
    for (let i = 0; i < 20; i++) {
      const pr = await P.advancePush(j2.id, { budgetMs: 30_000 });
      if (!pr?.active) break;
    }
    const tp = await P.pushProgress(j2.id);
    c.ok("(the copy the hub can't place still asks for Send anyway first)", !held.ok && /Send anyway/.test(held.message) && anyway.started, held.message);
    c.ok("after the push the listing is checked as a whole: the copy is named, the run holds its own delivery for Kyle", tp?.state === "WAITING" && (tp.duplicates ?? []).length === 1 && /on the listing twice/.test(tp.note ?? "") && /press Deliver in Aryeo/.test(tp.note ?? "") && !calls.some((x) => x.kind === "deliver" && x.listing === "LT"), JSON.stringify(tp));
    c.ok("…Kyle is told (one alert), the job's history says it, nothing was deleted", (await prisma.photoJobEvent.count({ where: { jobId: j2.id, action: { contains: "on it twice" } } })) === 1 && !calls.some((x) => x.kind === "delete" && x.listing === "LT") && listings.get("LT")!.images.length === 6);
    const t2 = sorted(listings.get("LT")!).map((i) => i.filename);
    const t2ids = sorted(listings.get("LT")!).map((i) => i.id);
    c.ok("…and the new photos went after the listing's own (numbered after its 3), which kept their exact places", t2ids.slice(0, 4).join() === "t1,t2,t3,t2b" && /^04-/.test(t2[4]) && /^05-/.test(t2[5]), t2.join(" | "));

    // ======================================================================
    c.head("6 · a single-visit job is unchanged");
    // ======================================================================
    const p3 = await prisma.project.create({ data: { title: "12 Plain St, Reading, PA", addressLine: "12 Plain St", clientId: client.id, aryeoListingId: "LP", shootDate: oct21 } });
    const j3 = await prisma.photoJob.create({ data: { projectId: p3.id, stage: "READY", deliveryPath: "/AutoHDR/x/12 Plain St/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    const qr3 = await prisma.photoQcRun.create({ data: { jobId: j3.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1"]), startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: j3.id }, data: { lastQcRunId: qr3.id } });
    for (let k = 0; k < 4; k++) await prisma.photoAsset.create({ data: { jobId: j3.id, name: `p${k + 1}.jpg`, sourceKind: "AUTOHDR", contentHash: `pl-${k}`, inspectedHash: `pl-${k}`, sequence: k, status: "ACTIVE", roomType: k === 0 ? "EXTERIOR_FRONT" : "BEDROOM", sequenceGroup: k === 0 ? "FRONT_EXTERIOR" : "BEDROOMS" } });
    listings.set("LP", { id: "LP", delivery: "UNDELIVERED", images: [] });
    const ord3 = await fill(j3.id, "/AutoHDR/x/12 Plain St/06-Ready-for-Aryeo");
    c.ok("names start at 01 as before", ord3.map((o) => o.deliveryName).join() === "01-Front-Exterior.jpg,02-Bedroom.jpg,03-Bedroom.jpg,04-Bedroom.jpg", ord3.map((o) => o.deliveryName).join());
    const up3 = calls.filter((x) => x.kind === "upload").length;
    const a3 = await P.approveJob(j3.id, "Kyle", { deliver: false });
    for (let i = 0; i < 20; i++) {
      const pr = await P.advancePush(j3.id, { budgetMs: 30_000 });
      if (!pr?.active) break;
    }
    const pr3 = await P.pushProgress(j3.id);
    const lp = sorted(listings.get("LP")!).map((i) => i.filename);
    c.ok("the push sends the 4 and puts them in delivery order, exactly as before", a3.started && calls.filter((x) => x.kind === "upload").length - up3 === 4 && lp.join() === ord3.map((o) => o.deliveryName).join() && pr3?.state === "DONE" && !pr3.kept && !pr3.matched, `${lp.join()} ${pr3?.state}`);
    const sample = [{ name: "a.jpg", sourceKind: "ARYEO" as const, sourceUrl: null, sourceRef: "x", dropboxPath: null, dropboxId: null, contentHash: "h1", bytes: null, index: 0 }];
    const oldWay = createHash("sha256").update("ARYEO\u0000a.jpg\u0000h1\n").digest("hex").slice(0, 32);
    c.ok("a gallery with nothing on the listing beside it keeps its fingerprint (no job reads as changed)", jobs.galleryFingerprint(sample) === oldWay);
    const d3 = (await data.loadJobDetail(j3.id, { viewer: kyleView }))!;
    const h3 = html(createElement(JobWorkspace, { data: d3, viewer: kyleView, history: null }));
    c.ok("its gallery reads as before: '4 in the delivery', no delivered tags", !d3.listing && /4 in the delivery/.test(galleryOf(h3)) && !/Not delivered yet|Delivered Oct/.test(h3));

    // ======================================================================
    c.head("7 · the view-only Photos desk (James): the same tags, no controls");
    // ======================================================================
    // Back to the moment before delivery: a second Cliff Ln shape, read as James.
    const p4 = await prisma.project.create({ data: { title: "7 Split Way, Malvern, PA", addressLine: "7 Split Way", clientId: client.id, aryeoListingId: "LS", shootDate: oct21 } });
    const j4 = await prisma.photoJob.create({ data: { projectId: p4.id, stage: "QC_REVIEW" } });
    for (let k = 0; k < 3; k++) await prisma.photoAsset.create({ data: { jobId: j4.id, name: `7 Split Way (${k + 1} of 3).jpg`, sourceKind: "ARYEO", sourceRef: `s${k + 1}`, contentHash: `s${k}`, sequence: k, status: "ON_LISTING" } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: j4.id, name: `DSC0${1000 + k}.jpg`, sourceKind: "AUTOHDR", contentHash: `sn${k}`, sequence: 3 + k, status: "ACTIVE" } });
    const jd = (await data.loadJobDetail(j4.id, { viewer: jamesView }))!;
    const jh = html(createElement(JobWorkspace, { data: jd, viewer: jamesView, history: null }));
    c.ok("James reads 5 photos · 3 delivered · 2 not delivered yet, with each tag", /5 photos · 3 delivered · 2 not delivered yet/.test(galleryOf(jh)) && (jh.match(/>\s*Delivered Oct \d+</g) ?? []).length === 3 && (jh.match(/Not delivered yet\s*</g) ?? []).length === 2, galleryOf(jh).slice(0, 160));
    const jamesControls = [...jh.matchAll(/<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => `${m[0].match(/aria-label="([^"]*)"/)?.[1] ?? ""} ${text(m[2])}`.trim());
    const forbidden = jamesControls.filter((t) => /Make Photo|Leave Photo|back in the delivery|Reorder|Approve|Deliver in Aryeo/.test(t));
    c.ok("…and no control on any photo (no hero, no leave out, no reorder, no approve)", forbidden.length === 0, forbidden.slice(0, 3).join(" | "));

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
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

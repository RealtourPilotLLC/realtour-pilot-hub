// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: what holds a photo delivery (Oct 22 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-delivery-holds.ts
//
// Jordan's four asks of Oct 22:
//   · 58 Recreation Dr (Brandon: "Lot Lines" + "Drone Aerial Photography"):
//     "it should say Lot Lines needed, and then add any wording underneath
//     from the agent", and hold the delivery until lot lines are confirmed
//     added. Then: "Should do the same thing for virtual staging."
//   · "Sending a job should be clearer on what's holding it ... Kyle
//     currently has to dig for what's holding it up."
//   · "Yes, it should be re-delivered if we are sending new photos."
//   · 615 Cliff Ln: QC missed "the bedroom lamp floating in the one bedroom
//     with a crib".
//
//   1 · pure: which orders owe add-on work, the agent's words
//   2 · 58 Recreation Dr: "Lot Lines needed" with the agent's words, holding
//       Approve and deliver; on the header chips, the board card and the
//       Shoots row; cleared by a "Lot lines" version, or by Kyle with a note;
//       the hub's same-day approval never passes it
//   3 · Virtual Staging needed, the same way (and both on one order, in order)
//   4 · "What's holding this": every blocker kind in order, with its button,
//       "Ready to send" when clear; the board card's line matches the panel
//   5 · re-delivery: a split job's new photos re-deliver the listing once; a
//       push with nothing new never does; a claim left by a stopped pass is
//       never sent again
//   6 · the floating-object check: MAJOR, in the free check's question and
//       its second look, in the paid QC's prompt, switched off with the house
//       list, never clutter
//
// ISOLATION: PGlite via the shared harness; Aryeo's web app, its API,
// Uploadcare, Dropbox and Slack are answered in-process. Nothing leaves.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery";
  nav.useSearchParams = () => new URLSearchParams();
}

// ---- the fakes (shaped like oct22-split-job-delivered-tags.ts) ---------------------------------
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
      listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Brandon Drill" } }] },
      images: sorted(l).map((i) => ({ id: i.id, title: null, is_live: true, filename: stem(i.filename), filename_extension: "jpg" })),
      company: { default_enable_mark_orders_fulfilled: false, default_timezone: "America/New_York" },
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
      l.images.forEach((i) => i.index++);
      l.images.push({ id: nid("img"), filename: ucFiles.get(uuid)!, index: 0 });
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/listing\/([^/]+)\/images$/.exec(u.pathname);
  if (m && method === "PUT") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: { id: string }[] };
    calls.push({ kind: "reorder", listing: l.id });
    b.images.forEach((x, k) => {
      const i = l.images.find((y) => y.id === x.id);
      if (i) i.index = k;
    });
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  if (m && method === "DELETE") {
    const l = listings.get(m[1])!;
    calls.push({ kind: "delete", listing: l.id });
    const b = JSON.parse(String(init?.body)) as { images: string[] };
    l.images = l.images.filter((i) => !b.images.includes(i.id));
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    calls.push({ kind: "deliver", listing: l.id, body: JSON.parse(String(init?.body ?? "{}")) });
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
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
const LONG_DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6137), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const A = await import("@/lib/photoDelivery/addOns");
    const H = await import("@/lib/photoDelivery/holding");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const M = await import("@/lib/photoDelivery/listingMatch");
    const handoff = await import("@/lib/photoDelivery/handoff");
    const asked = await import("@/lib/photoDelivery/clientAsked");
    const data = await import("@/app/ops/photo-delivery/data");
    const { createAsk } = await import("@/lib/clientAsks");
    const { NOTHING_TO_REMOVE_SENTINEL } = await import("@/lib/debrief");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("aryeo_web", LOGIN.password, { metadata: { email: LOGIN.email } });
    await savePhotoDeliverySettings({ enabled: true, qcShadow: true, aryeoPush: "on" }, "drill");
    P.__setPushDownloaderForTests(async (path) => {
      if (!dropboxFolder.has(path)) throw new Error(`not in the folder: ${path}`);
      return Buffer.alloc(dropboxFolder.get(path)!, 7);
    });
    const kyleView = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };
    const jamesView = { role: "CREATIVE_MANAGER", name: "James", isOwner: false, canSeeMoney: false, readOnly: true };
    const DAY = 86_400_000;

    // ======================================================================
    c.head("1 · pure: which orders owe add-on work, and the agent's words");
    // ======================================================================
    const lot = A.ADD_ON_BY_KEY.get("lot_lines")!;
    const stage = A.ADD_ON_BY_KEY.get("virtual_staging")!;
    c.ok("one list of add-on work: lot lines and virtual staging (another is one more line)", A.ADD_ON_WORK.map((w) => w.key).join() === "lot_lines,virtual_staging" && lot.need === "Lot Lines needed" && stage.need === "Virtual Staging needed");
    const brandon = A.addOnsOrdered([{ title: "Lot Lines" }, { title: "Drone Aerial Photography" }], [{ type: "DRONE", label: null, productTitle: "Drone Aerial Photography" }, { type: "OTHER", label: "Item", productTitle: "Lot Lines" }]);
    c.ok("Brandon's order (Lot Lines + Drone Aerial Photography): lot lines owed, read off the order line", brandon.length === 1 && brandon[0].work.key === "lot_lines" && brandon[0].line === "Lot Lines", JSON.stringify(brandon.map((b) => b.line)));
    c.ok("…the order item alone is enough (no deliverable mapped yet)", A.addOnsOrdered([{ title: "Lot Lines" }], []).length === 1);
    c.ok("drone only: nothing owed; a canceled Lot Lines line: nothing owed", A.addOnsOrdered([{ title: "Drone Aerial Photography" }], [{ type: "DRONE", label: null, productTitle: "Drone Aerial Photography" }]).length === 0 && A.addOnsOrdered([{ title: "Lot Lines", isCanceled: true }], []).length === 0);
    c.ok("a Lot Lines deliverable waived or pulled from the order: not owed, even with the order line", A.addOnsOrdered([{ title: "Lot Lines" }], [{ type: "OTHER", label: null, productTitle: "Lot Lines", waivedAt: new Date() }]).length === 0);
    c.ok("virtual staging: by the order line, or a VIRTUAL_STAGING deliverable with no title of its own", A.addOnsOrdered([{ title: "Virtual Staging" }], [])[0]?.work.key === "virtual_staging" && A.addOnsOrdered([], [{ type: "VIRTUAL_STAGING", label: null, productTitle: null }])[0]?.work.key === "virtual_staging");
    c.ok("…but Virtual Decluttering (also mapped to VIRTUAL_STAGING) is not staging", A.addOnsOrdered([{ title: "Virtual Decluttering" }], [{ type: "VIRTUAL_STAGING", label: null, productTitle: "Virtual Decluttering" }]).length === 0);
    const q = A.addOnQuotes(lot, [
      { from: "Order notes", text: "Lockbox is on the back door. Please show the lot lines for both parcels from the plat I sent. Thanks!" },
      { from: "Order question: Lot line details", text: "Front and back pasture", whole: true },
      { from: "Text from Brandon, Oct 21", text: "Also the lot lines need to show the back pasture, it's 2.3 acres. Call me $500 budget." },
      { from: "Order notes", text: "Please show the lot lines for both parcels from the plat I sent." },
    ]);
    c.ok("the agent's words: only the sentences about it (no lockbox, no thanks), a question named for it taken whole", q.length === 3 && q[0].text === "Please show the lot lines for both parcels from the plat I sent." && q[1].text === "Front and back pasture" && /back pasture, it's 2\.3 acres/.test(q[2].text), JSON.stringify(q));
    c.ok("…money scrubbed (Kyle's screen), and the same words once", !/\$500/.test(JSON.stringify(q)) && q.filter((x) => /plat I sent/.test(x.text)).length === 1);

    // ======================================================================
    c.head("2 · 58 Recreation Dr: Lot Lines needed, with the agent's words, holds the delivery");
    // ======================================================================
    const client = await prisma.client.create({ data: { name: "Brandon Drill" } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.test", role: "PHOTOGRAPHER" } as never });
    const shot = new Date(Date.now() - 2 * DAY);
    const project = await prisma.project.create({
      data: {
        title: "58 Recreation Dr, Jim Thorpe, PA", addressLine: "58 Recreation Dr", clientId: client.id, status: "EDITING", shootDate: shot, aryeoListingId: "LR58",
        photographerId: harrison.id, removalNotes: NOTHING_TO_REMOVE_SENTINEL, cullingConfirmedAt: shot, debriefSubmittedAt: shot,
        editorBrief: "Shot the drone from all four corners so the lot lines can be drawn. Nothing else special.",
        orderItems: { create: [{ title: "Lot Lines", amount: 75 }, { title: "Drone Aerial Photography", amount: 150 }, { title: "Same-Day Photo Delivery", amount: 50 }] },
        deliverables: { create: [{ type: "DRONE", productTitle: "Drone Aerial Photography" }, { type: "OTHER", label: "Item", productTitle: "Lot Lines" }] },
        appointments: { create: [{ aryeoId: "ap-58", startAt: shot, status: "CONFIRMED", description: "Order Notes:\nLockbox is on the back door. Please show the lot lines for both parcels, the plat is attached to the listing.\n\nOrder Questions:\n - Lock Box / Door Code: 4417\n - Lot line details: Front parcel and the back pasture\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
      } as never,
    });
    await createAsk({ clientId: client.id, projectId: project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Hey, make sure the lot lines include the back pasture too, it's about 2.3 acres.", source: "text", askedBy: "Brandon Drill", askedAt: new Date(Date.now() - DAY), by: "drill" });
    listings.set("LR58", { id: "LR58", delivery: "UNDELIVERED", images: [] });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY", deliveryPath: "/AutoHDR/x/58 Recreation Dr/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1"]), checksJson: JSON.stringify({ v: 2 }), startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    const photos = [];
    for (let k = 0; k < 3; k++) photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: `DJI_0${100 + k}.jpg`, sourceKind: "AUTOHDR", contentHash: `rd-${k}`, inspectedHash: `rd-${k}`, sequence: k, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg", roomType: "AERIAL", sequenceGroup: "AERIAL" } }));

    let gate = await delivery.deliveryGate(job.id);
    const line = gate.checks.find((x) => x.key === "addon:lot_lines");
    c.ok("the checklist has a HOLD line 'Lot Lines needed' (person-only), from the order line", !!line && line.label === "Lot Lines needed" && line.hold === true && line.personOnly === true && line.ok === false && /Ordered: Lot Lines/.test(line.detail ?? ""), JSON.stringify(line));
    const quotes = line?.addOn?.quotes ?? [];
    const from = quotes.map((x) => x.from);
    c.ok("…with the agent's words underneath: the order notes, the order question, the client's text, the photographer's wrap-up", from.includes("Order notes") && from.includes("Order question: Lot line details") && from.some((f) => /^Text from Brandon, /.test(f)) && from.includes("Harrison's wrap-up"), JSON.stringify(quotes));
    c.ok("…only the sentences about the lot lines (no lockbox, no door code)", quotes.every((x) => !/Lockbox|4417/.test(x.text)) && quotes.some((x) => /both parcels, the plat is attached/.test(x.text)) && quotes.some((x) => /four corners so the lot lines/.test(x.text)), JSON.stringify(quotes.map((x) => x.text)));
    c.ok("it holds Kyle's delivery even in shadow mode", gate.advisory === true && gate.canDeliver === false && gate.holdsOpen >= 1);
    const refused = await P.approveJob(job.id, "Kyle", { deliver: true });
    c.ok("Approve and deliver is refused, naming it", !refused.ok && !refused.started && /lot lines needed/.test(refused.message), refused.message);
    c.ok("…and nothing reached Aryeo", !calls.some((x) => x.listing === "LR58"));
    const sd = await P.sameDayBlocker(job.id);
    c.ok("the same-day order does not approve itself (the client's open asks come first here)", sd !== null, String(sd));

    // The job page: the header chip, the holding panel (first), the Deliver bar's first line.
    const detail = (await data.loadJobDetail(job.id, { viewer: kyleView }))!;
    const view = H.holdingFor({ ...detail.holdingBase, gate: detail.gate, gateError: detail.gateError, push: detail.aryeoPush });
    c.ok("'What's holding this' lists Lot Lines needed first, waiting on Kyle, with the agent's words and its button", view.items[0]?.kind === "addon" && view.items[0].text === "Lot Lines needed." && view.items[0].waitingOn === "Waiting on Kyle" && view.items[0].quotes.length >= 3 && view.items[0].action?.kind === "addon" && view.items[0].action.label === "Lot lines added", JSON.stringify(view.items.map((i) => [i.kind, i.text])));
    c.ok("…then the client's own requests (the order note, the text), each with Done or Answer", view.items.slice(1).every((i) => i.kind === "ask" && i.action?.kind === "ask") && view.items.slice(1).some((i) => /back pasture/.test(i.text)), JSON.stringify(view.items.slice(1).map((i) => i.text)));
    c.ok("the header's chip reads from the same line (Lot Lines needed)", (detail.gate?.checks ?? []).filter((x) => x.addOn && !x.ok).map((x) => x.addOn!.need).join() === "Lot Lines needed");
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const kh = html(createElement(JobWorkspace, { data: detail, viewer: kyleView, history: null }));
    const panel = text(kh.split('aria-labelledby="pd-holding-h"')[1]?.split("</section>")[0] ?? "");
    c.ok("the page: the panel comes first and reads 'What's holding this', Lot Lines needed, the agent's words, Lot lines added", kh.indexOf("pd-holding-h") < kh.indexOf("pd-gallery-h") && /What's holding this/.test(panel) && /1 Lot Lines needed\./.test(panel) && /both parcels, the plat is attached/.test(panel) && /Lot lines added/.test(panel) && /Waiting on Kyle/.test(panel), panel.slice(0, 300));
    const bar = text((kh.split('aria-label="Deliver"')[1] ?? "").split('id="pd-deliver-body"')[0]);
    c.ok("the Deliver bar's first line is the panel's first item", /Lot Lines needed\. \(\+\d+ more, listed at the top\)/.test(bar), bar.slice(0, 200));
    c.ok("…the Deliver panel's checklist carries it too, with Lot lines added", /Before the photos go out[\s\S]*Lot Lines needed[\s\S]*Lot lines added/.test(text(kh.split('id="pd-deliver-body"')[1] ?? "")));
    const jd = (await data.loadJobDetail(job.id, { viewer: jamesView }))!;
    const jh = html(createElement(JobWorkspace, { data: jd, viewer: jamesView, history: null }));
    const jamesButtons = [...(jh.split('aria-labelledby="pd-holding-h"')[1]?.split("</section>")[0] ?? "").matchAll(/<button\b[\s\S]*?<\/button>/g)].map((x) => text(x[0]));
    c.ok("view only (James): the same list, no buttons", /Lot Lines needed/.test(text(jh)) && jamesButtons.length === 0, jamesButtons.join(" | "));
    c.ok("plain words, no em dashes", !LONG_DASH.test(panel) && !LONG_DASH.test(view.items.map((i) => `${i.text} ${i.short}`).join(" ")));

    // The board card and the Shoots row.
    const queue = await data.loadQueue({ holding: true, viewer: { readOnly: false } });
    const card = queue.columns.flatMap((col) => col.cards).find((x) => x.id === job.id);
    c.ok("the board card's line is the panel's first line ('Lot Lines needed (+N more)')", card?.holding?.line === view.line && /^Lot Lines needed \(\+\d+ more\)$/.test(view.line) && card?.holding?.tone === "held", `${card?.holding?.line} | ${view.line}`);
    c.ok("…and the card carries the add-on: Lot Lines needed", JSON.stringify(card?.addOns) === '["Lot Lines needed"]');
    c.ok("Home's QC counts read the board without the holding lines (no extra reads there)", (await data.loadQueue({})).columns.flatMap((col) => col.cards).find((x) => x.id === job.id)?.holding === undefined);
    const { shootsBoard } = await import("@/lib/jobsBoard");
    const shoots = await shootsBoard(new Date()).catch((e: unknown) => ({ rows: [], err: String(e) }));
    const srow = shoots.rows.find((r) => r.projectId === project.id);
    c.ok("the Shoots board row says Lot Lines needed under the street", !!srow && /Lot Lines needed/.test(srow.holding ?? ""), `${srow?.holding ?? "(row not found)"} ${"err" in shoots ? shoots.err : ""}`);

    // The client's own requests are settled (Done): what is left is the lot lines.
    for (const x of (await delivery.deliveryGate(job.id)).checks.filter((y) => y.askId)) await asked.settleClientAsked({ jobId: job.id, askId: x.askId!, how: "done", by: "Kyle" });
    gate = await delivery.deliveryGate(job.id);
    c.ok("with the client's requests Done, Lot Lines needed alone still holds Kyle's delivery", gate.canDeliver === false && gate.holdsOpen === 1 && gate.checks.filter((x) => x.hold && !x.ok).map((x) => x.key).join() === "addon:lot_lines", JSON.stringify(gate.checks.filter((x) => !x.ok).map((x) => x.key)));
    c.ok("…and the same-day order still never approves itself: 'lot lines on the order: Kyle approves it'", (await P.sameDayBlocker(job.id)) === "lot lines on the order: Kyle approves it");

    // (a) a "Lot lines" version on a photo in the delivery clears it.
    const fixV = await prisma.photoVersion.create({ data: { photoId: photos[0].id, label: "Lot lines (from AutoHDR)", source: "FIX", createdBy: "fix-runner" } });
    c.ok("a 'Lot lines' version from another source does not count (the contract is the drawing tool's EDITOR version)", (await delivery.deliveryGate(job.id)).checks.find((x) => x.key === "addon:lot_lines")?.ok === false);
    await prisma.photoVersion.delete({ where: { id: fixV.id } });
    const drawn = await prisma.photoVersion.create({ data: { photoId: photos[0].id, label: "Lot lines drawn from the plat", source: "EDITOR", createdBy: "Kyle" } });
    gate = await delivery.deliveryGate(job.id);
    const cleared = gate.checks.find((x) => x.key === "addon:lot_lines");
    c.ok("(a) an EDITOR version labelled 'Lot lines …' on a photo in the delivery clears it: 'Lot lines added', on DJI_0100.jpg", cleared?.ok === true && cleared.label === "Lot lines added" && /on DJI_0100\.jpg, by Kyle/.test(cleared.detail ?? "") && cleared.addOn?.cleared?.how === "version" && gate.canDeliver === true, JSON.stringify(cleared));
    c.ok("…the hub's same-day approval still never passes it (Kyle approves a lot lines job)", (await P.sameDayBlocker(job.id)) === "lot lines on the order: Kyle approves it" && gate.passed === false);
    await prisma.photoAsset.update({ where: { id: photos[0].id }, data: { status: "EXCLUDED" } });
    c.ok("…a photo left out of the delivery does not count", (await delivery.deliveryGate(job.id)).checks.find((x) => x.key === "addon:lot_lines")?.ok === false);
    await prisma.photoAsset.update({ where: { id: photos[0].id }, data: { status: "ACTIVE" } });
    await prisma.photoVersion.delete({ where: { id: drawn.id } });

    // (b) Kyle confirms by hand, with a note.
    const short = await A.confirmAddOn(job.id, "lot_lines", "ok", "Kyle");
    c.ok("(b) Kyle's 'Lot lines added' needs a note", !short.ok && /short note/.test(short.message), short.message);
    const ok = await A.confirmAddOn(job.id, "lot_lines", "Drawn in Lightroom from the plat on photos 1 to 3", "Kyle");
    gate = await delivery.deliveryGate(job.id);
    const byHand = gate.checks.find((x) => x.key === "addon:lot_lines");
    c.ok("…with one, it clears: confirmed by Kyle, the note on the line and the job's activity", ok.ok && byHand?.ok === true && /confirmed by Kyle: Drawn in Lightroom/.test(byHand.detail ?? "") && (await prisma.photoJobEvent.count({ where: { jobId: job.id, action: { startsWith: "add-on confirmed: Lot lines added" } } })) === 1 && (await prisma.activity.count({ where: { projectId: project.id, body: { contains: "Lot lines added (confirmed by Kyle)" } } })) === 1, JSON.stringify(byHand));
    c.ok("…an add-on the order does not have is refused", !(await A.confirmAddOn(job.id, "virtual_staging", "Staged the living room", "Kyle")).ok);
    c.ok("…the hub's same-day approval still never passes it", (await P.sameDayBlocker(job.id)) === "lot lines on the order: Kyle approves it" && gate.passed === false);
    c.ok("…and Kyle can deliver now", gate.canDeliver === true && gate.holdsOpen === 0, JSON.stringify(gate.checks.filter((x) => !x.ok)));
    const after = (await data.loadQueue({ holding: true })).columns.flatMap((col) => col.cards).find((x) => x.id === job.id);
    c.ok("…the board card now says Ready to send, with no add-on chip", after?.holding?.line === "Ready to send" && after.holding.tone === "ready" && (after.addOns ?? []).length === 0, JSON.stringify(after?.holding));
    const shoots2 = await shootsBoard(new Date()).catch(() => ({ rows: [] as { projectId: string; holding: string | null }[] }));
    c.ok("…and the Shoots row no longer says it", !/Lot Lines needed/.test(shoots2.rows.find((r) => r.projectId === project.id)?.holding ?? ""));

    // ======================================================================
    c.head("3 · Virtual Staging needed, the same way");
    // ======================================================================
    const p2 = await prisma.project.create({
      data: {
        title: "12 Stage Ln, Malvern, PA", addressLine: "12 Stage Ln", clientId: client.id, status: "EDITING", shootDate: shot,
        orderItems: { create: [{ title: "Virtual Staging", amount: 90 }, { title: "Lot Lines", amount: 75 }] },
        deliverables: { create: [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging" }, { type: "PHOTOS", productTitle: "BRONZE PACKAGE - Simple Solutions for Straightforward Listings" }] },
        appointments: { create: [{ aryeoId: "ap-12", startAt: shot, status: "CONFIRMED", description: "Order Notes:\nPlease virtually stage the living room and the primary bedroom, modern farmhouse. The gate code is 1234.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
      } as never,
    });
    const j2 = await prisma.photoJob.create({ data: { projectId: p2.id, stage: "READY" } });
    const s1 = await prisma.photoAsset.create({ data: { jobId: j2.id, name: "IMG_2001.jpg", sourceKind: "AUTOHDR", contentHash: "st-1", inspectedHash: "st-1", sequence: 0, status: "ACTIVE" } });
    let g2 = await delivery.deliveryGate(j2.id);
    const both = g2.checks.filter((x) => x.addOn);
    c.ok("both add-ons on one order: two hold lines, lot lines first, then Virtual Staging needed", both.map((x) => x.label).join(" | ") === "Lot Lines needed | Virtual Staging needed" && both.every((x) => x.hold && !x.ok), both.map((x) => x.label).join(" | "));
    const sq = both[1]?.addOn?.quotes ?? [];
    c.ok("…the agent's words for the staging: which rooms (no gate code)", sq.length === 1 && /virtually stage the living room and the primary bedroom/.test(sq[0].text) && !/1234/.test(sq[0].text), JSON.stringify(sq));
    c.ok("…it holds Kyle's delivery (both lines open)", g2.canDeliver === false && g2.holdsOpen >= 2);
    await prisma.photoVersion.create({ data: { photoId: s1.id, label: "Virtual staging: living room, modern farmhouse", source: "FIX", createdBy: "fix-runner" } });
    g2 = await delivery.deliveryGate(j2.id);
    c.ok("a 'Virtual staging' version (any source) clears the staging line: 'Virtual staging added'; lot lines still held", g2.checks.find((x) => x.key === "addon:virtual_staging")?.label === "Virtual staging added" && g2.checks.find((x) => x.key === "addon:virtual_staging")?.ok === true && g2.checks.find((x) => x.key === "addon:lot_lines")?.ok === false);
    const st = await A.confirmAddOn(j2.id, "lot_lines", "Kyle drew them outside the hub on IMG_2001", "Kyle");
    g2 = await delivery.deliveryGate(j2.id);
    c.ok("…Kyle confirms the lot lines by hand: nothing of the add-ons holds it", st.ok && g2.checks.filter((x) => x.addOn).every((x) => x.ok));
    const byProject = await A.openAddOnsByProject([p2.id, project.id]);
    c.ok("the boards' batch read agrees: nothing open on either job", byProject.size === 0, JSON.stringify([...byProject]));

    // ======================================================================
    c.head("4 · 'What's holding this': every kind in order, its button, 'Ready to send' when clear");
    // ======================================================================
    type Line = import("@/lib/photoDelivery/holding").HoldingGateLine;
    const base = { jobId: "job-x", projectId: "proj-x", stage: "READY", holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: "Harrison Wells", decisions: { critical: 1, major: 2, minor: 0 }, listingUrl: "https://realtourpilot.aryeo.com/admin/listings/LX/edit", orderUrl: null, deliveryCheckNote: null };
    const hubOn = { mode: "on", connected: true, sameDayAuto: false };
    const all: Line[] = [
      { key: "flags", label: "Photo flags", ok: false, advisory: true, href: "/projects/proj-x#flags", detail: "2 photo flags still open" },
      { key: "qc", label: "The latest QC run covers every photo's current version", ok: false, detail: "1 photo not inspected" },
      { key: "coverage", label: "Everything ordered is covered (or accepted with a reason)", ok: false, detail: "1 open" },
      { key: "critical", label: "No unresolved critical issue", ok: false, detail: "1 open" },
      { key: "ask:a1", label: "Client asked: crop out the bins (photos 3)", ok: false, hold: true, askId: "a1", detail: "Brandon, text" },
      { key: "addon:lot_lines", label: "Lot Lines needed", ok: false, hold: true, personOnly: true, addOn: { key: "lot_lines", need: "Lot Lines needed", done: "Lot lines added", ordered: "Lot Lines", quotes: [{ from: "Order notes", text: "Both parcels." }], cleared: null } },
      { key: "wrapup", label: "Harrison hasn't sent the wrap-up yet: what was promised to the client or must be removed is unknown.", ok: false, hold: true, overridable: true, href: "/upload/proj-x", hrefLabel: "Open Harrison's wrap-up" },
      { key: "upload", label: "Everything ordered was uploaded", ok: false, detail: "missing drone photos" },
      { key: "files", label: "Every photo is a full-size JPEG", ok: true },
    ];
    const full = H.holdingFor({ ...base, gate: { checks: all, canDeliver: false, advisory: false, blockedForOverride: "A privacy or wrong-property issue is open. That one has to be resolved, not overridden." }, push: { ...hubOn, progress: { state: "FAILED", active: false, total: 3, sent: 0, already: 0, note: "Aryeo said no.", deliveredAt: null } } });
    const kinds = full.items.map((i) => i.kind);
    c.ok("every blocker in one fixed order: upload, wrap-up, add-on, client asked, decisions, privacy, coverage, checks, Aryeo", kinds.join(",") === "upload,wrapup,addon,ask,decisions,privacy,coverage,checks,aryeo", kinds.join(","));
    c.ok("…the order is HOLDING_ORDER", kinds.every((k, i) => i === 0 || H.HOLDING_ORDER.indexOf(k as never) >= H.HOLDING_ORDER.indexOf(kinds[i - 1] as never)));
    const act = (k: string) => full.items.find((i) => i.kind === k)?.action;
    c.ok("each with its one button: the upload page, the wrap-up (and Deliver without it), Lot lines added, Done, Decide them, Issues, Coverage, Check again, Approve again", act("upload")?.kind === "link" && (act("upload") as { href: string }).href === "/upload/proj-x" && act("wrapup")?.kind === "wrapup" && act("addon")?.kind === "addon" && act("ask")?.kind === "ask" && act("decisions")?.kind === "link" && (act("decisions") as { href: string }).href === "/ops/photo-delivery/job-x/review" && act("privacy")?.kind === "tab" && act("coverage")?.kind === "tab" && act("checks")?.kind === "rerun" && act("aryeo")?.kind === "approve", JSON.stringify(full.items.map((i) => [i.kind, i.action?.kind, i.action?.label])));
    c.ok("…who each waits on: the photographer by name, Kyle, the hub", full.items[0].waitingOn === "Waiting on Harrison (photographer)" && full.items[1].waitingOn === "Waiting on Harrison (photographer)" && full.items[2].waitingOn === "Waiting on Kyle" && full.items.find((i) => i.kind === "checks")?.waitingOn === "Waiting on the hub");
    c.ok("…photo flags are open but never hold Kyle (folded under the list)", full.also.length === 1 && full.also[0].kind === "flags" && !full.ready);
    c.ok("…'3 issues to decide' counts the critical and major tickets", full.items.find((i) => i.kind === "decisions")?.short === "3 issues to decide");
    c.ok("the board line is the first item's few words, with how many more", full.line === "Part of the order not uploaded (+8 more)", full.line);
    const shadow = H.holdingFor({ ...base, decisions: { critical: 0, major: 1, minor: 0 }, gate: { checks: all.filter((x) => !x.hold && x.key !== "flags"), canDeliver: true, advisory: true, blockedForOverride: null }, push: { ...hubOn, progress: null } });
    c.ok("shadow mode: the checklist's own checks don't hold Kyle (listed as also open); the button is Approve and deliver", shadow.items.length === 0 && shadow.also.map((i) => i.kind).join(",") === "upload,decisions,coverage,checks" && shadow.ready?.action?.kind === "approve" && shadow.line === "Ready to send", JSON.stringify([shadow.items.map((i) => i.kind), shadow.also.map((i) => i.kind)]));
    const clear = (over: Partial<Parameters<typeof H.holdingFor>[0]>) => H.holdingFor({ ...base, decisions: { critical: 0, major: 0, minor: 0 }, gate: { checks: [], canDeliver: true, advisory: true, blockedForOverride: null }, push: { ...hubOn, progress: null }, ...over });
    const s = {
      hold: clear({ stage: "ON_HOLD", holdReason: "CREDITS" }),
      wait: clear({ stage: "EDITING", waitingForVisit: "Tue, Oct 21" }),
      editing: clear({ stage: "EDITING" }),
      decide: clear({ stage: "QC_REVIEW", decisions: { critical: 0, major: 2, minor: 1 } }),
      dupes: clear({ push: { ...hubOn, progress: { state: "WAITING", active: false, total: 3, sent: 3, already: 0, note: "A photo is on the listing twice (01-Front.jpg twice). Take the extra copy off in Aryeo (the hub never deletes there), then press Deliver in Aryeo.", deliveredAt: null, duplicates: [["01-Front.jpg", "01-Front.jpg"]] } } }),
      order: clear({ push: { ...hubOn, progress: { state: "DONE", active: false, total: 3, sent: 3, already: 0, note: "The photos are on the listing, but Aryeo kept a different order. Check the order in Aryeo before delivering.", deliveredAt: null } } }),
      changed: clear({ push: { ...hubOn, progress: { state: "DONE", active: false, total: 3, sent: 3, already: 0, note: "x", changed: true, deliveredAt: null } } }),
      sending: clear({ push: { ...hubOn, progress: { state: "SENDING", active: true, total: 3, sent: 1, already: 0, note: null, deliveredAt: null } } }),
      confirming: clear({ stage: "DELIVERING", deliveryCheckNote: "Aryeo still has the listing as undelivered." }),
      mismatch: clear({ stage: "DELIVERY_MISMATCH", deliveryCheckNote: "1 approved photo is not on the listing." }),
      redeliver: clear({ stage: "DELIVERED", push: { ...hubOn, progress: { state: "DONE", active: false, total: 2, sent: 2, already: 0, note: null, deliveredAt: null, redeliver: { pending: 2, state: null, at: null, photos: 0, note: null } } } }),
      ready: clear({}),
      up: clear({ push: { ...hubOn, progress: { state: "WAITING", active: false, total: 3, sent: 3, already: 0, note: null, deliveredAt: null } } }),
      off: clear({ push: { mode: "off", connected: false, sameDayAuto: false, progress: null } }),
      delivered: clear({ stage: "DELIVERED" }),
      noListing: clear({ listingUrl: null, orderUrl: "https://realtourpilot.aryeo.com/admin/orders/o1" }),
    };
    c.ok("on hold (out of credits): first, waiting on Jordan, Release the hold", s.hold.items[0]?.kind === "hold" && s.hold.items[0].waitingOn === "Waiting on Jordan (AutoHDR credits)" && s.hold.items[0].action?.kind === "release");
    c.ok("a split job waiting for the next visit's photos says which visit, waiting on the photographer", /from the Tue, Oct 21 visit/.test(s.wait.items[0]?.text ?? "") && s.wait.items[0].waitingOn === "Waiting on Harrison (photographer)" && s.wait.line === "Waiting for the next visit's photos");
    c.ok("still editing: waiting on AutoHDR, nothing to press", s.editing.items[0]?.kind === "edits" && s.editing.items[0].waitingOn === "Waiting on AutoHDR" && !s.editing.items[0].action);
    c.ok("needs a decision: '2 issues to decide', Decide them (review mode)", s.decide.items[0]?.kind === "decisions" && s.decide.items[0].short === "2 issues to decide" && (s.decide.items[0].action as { href?: string })?.href === "/ops/photo-delivery/job-x/review");
    c.ok("a photo on the listing twice: Kyle takes it off, the listing link and 'Removed it: Deliver in Aryeo'", s.dupes.items[0]?.short === "A photo is on the listing twice" && s.dupes.items[0].link?.href === base.listingUrl && s.dupes.items[0].action?.label === "Removed it: Deliver in Aryeo");
    c.ok("Aryeo kept a different order: check the order, then 'Checked: Deliver in Aryeo'", s.order.items[0]?.short === "Check the order in Aryeo" && s.order.items[0].action?.label === "Checked: Deliver in Aryeo" && !!s.order.items[0].link);
    c.ok("photos changed after upload: Approve again; sending: waiting on the hub and Aryeo, no button", s.changed.items[0]?.action?.label === "Approve again" && s.sending.items[0]?.waitingOn === "Waiting on the hub and Aryeo" && !s.sending.items[0].action && /1 of 3/.test(s.sending.items[0].text));
    c.ok("delivering: waiting on Aryeo, Check now; a mismatch: what the check found, Check again", s.confirming.items[0]?.kind === "confirming" && s.confirming.items[0].action?.kind === "verify" && s.mismatch.items[0]?.kind === "mismatch" && /1 approved photo is not on the listing/.test(s.mismatch.items[0].text));
    c.ok("a delivered split job with new photos not re-delivered: 'Re-deliver in Aryeo'", s.redeliver.items[0]?.kind === "redeliver" && s.redeliver.items[0].action?.label === "Re-deliver in Aryeo" && /2 new photos are on the delivered listing/.test(s.redeliver.items[0].text));
    c.ok("nothing holds it: 'Ready to send' with Approve and deliver; photos already up: Deliver in Aryeo; upload off: Mark as delivering", !s.ready.items.length && s.ready.ready?.text === "Ready to send." && s.ready.ready.action?.label === "Approve and deliver" && s.up.ready?.action?.label === "Deliver in Aryeo" && s.off.ready?.action?.label === "Mark as delivering");
    c.ok("delivered: nothing listed, the line says Delivered; no listing linked: Open the order", !s.delivered.items.length && s.delivered.line === "Delivered" && s.noListing.items[0]?.kind === "listing" && (s.noListing.items[0].action as { href?: string })?.href === "https://realtourpilot.aryeo.com/admin/orders/o1");
    c.ok("every sentence in plain words, no em dashes", !LONG_DASH.test(JSON.stringify([full, ...Object.values(s)])));

    // ======================================================================
    c.head("5 · re-delivery: new photos on a delivered listing re-deliver it once");
    // ======================================================================
    const fill = async (jobId: string, dir: string) => {
      const ord = await delivery.deliveryOrderFor(jobId);
      for (const o of ord) dropboxFolder.set(`${dir}/${o.deliveryName}`, 60_000 + o.deliveryName.length);
      const fp = await handoff.readyFingerprintFor(jobId);
      const at = new Date().toISOString();
      await prisma.appSetting.create({ data: { key: `photo_ready_run:${jobId}`, updatedBy: "drill", value: JSON.stringify({ id: "r1", state: "DONE", folder: dir, staging: dir, fingerprint: fp, by: "drill", startedAt: at, updatedAt: at, finishedAt: at, note: null, lease: null, items: ord.map((o) => ({ photoId: o.photoId, name: o.deliveryName, state: "DONE", tries: 1, bytes: 60_000, error: null })) }) } });
      return ord;
    };
    const drive = async (jobId: string) => {
      for (let i = 0; i < 25; i++) {
        const pr = await P.advancePush(jobId, { budgetMs: 30_000 });
        if (!pr?.active) break;
      }
    };
    const splitJob = async (street: string, listingId: string, earlier: number, fresh: string[], handAdded: string[] = []) => {
      const p = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id, aryeoListingId: listingId, shootDate: shot } });
      const jj = await prisma.photoJob.create({ data: { projectId: p.id, stage: "READY", deliveryPath: `/AutoHDR/x/${street}/06-Ready-for-Aryeo`, deliveryStagedAt: new Date() } });
      const qr = await prisma.photoQcRun.create({ data: { jobId: jj.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1"]), checksJson: JSON.stringify({ v: 2 }), startedAt: new Date(), finishedAt: new Date() } });
      await prisma.photoJob.update({ where: { id: jj.id }, data: { lastQcRunId: qr.id } });
      const imgs: Img[] = [];
      for (let k = 0; k < earlier; k++) {
        const id = `${listingId}-e${k + 1}`;
        imgs.push({ id, filename: `${street} (${k + 1} of ${earlier}).jpg`, index: k });
        await prisma.photoAsset.create({ data: { jobId: jj.id, name: `${street} (${k + 1} of ${earlier}).jpg`, sourceKind: "ARYEO", sourceRef: id, contentHash: M.listingImageHash(id, `https://cdn.aryeo.com/${id}.jpg`), sequence: k, status: "ON_LISTING" } });
      }
      for (const [k, name] of handAdded.entries()) imgs.push({ id: `${listingId}-h${k + 1}`, filename: name, index: earlier + k });
      for (const [k, name] of fresh.entries()) await prisma.photoAsset.create({ data: { jobId: jj.id, name, sourceKind: "AUTOHDR", contentHash: `${listingId}-n${k}`, inspectedHash: `${listingId}-n${k}`, sequence: earlier + k, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg", roomType: "KITCHEN", sequenceGroup: "KITCHEN" } });
      listings.set(listingId, { id: listingId, delivery: "DELIVERED", images: imgs });
      await fill(jj.id, `/AutoHDR/x/${street}/06-Ready-for-Aryeo`);
      return jj;
    };
    const delivers = (listingId: string) => calls.filter((x) => x.kind === "deliver" && x.listing === listingId);

    const jr = await splitJob("615 Cliff Ln", "LCL", 3, ["DSC07964.jpg", "DSC07965.jpg"]);
    const a1 = await P.approveJob(jr.id, "Kyle", { deliver: true });
    await drive(jr.id);
    const pr1 = await P.pushProgress(jr.id);
    const jr1 = await prisma.photoJob.findUniqueOrThrow({ where: { id: jr.id } });
    c.ok("Kyle's Approve and deliver on a split job: the 2 new photos go on beside the 3 delivered", a1.started && calls.filter((x) => x.kind === "upload" && /^0[45]-/.test(String(x.body))).length === 2 && listings.get("LCL")!.images.length === 5, a1.message);
    c.ok("…and the listing is delivered AGAIN, once (Aryeo's Re-deliver, delivery email, fulfill_orders on)", delivers("LCL").length === 1 && (delivers("LCL")[0].body as { notify_via_email?: boolean; fulfill_orders?: boolean; email_subject?: string }).fulfill_orders === true && (delivers("LCL")[0].body as { notify_via_email?: boolean }).notify_via_email === true && (delivers("LCL")[0].body as { email_subject?: string }).email_subject === "Your listing media is ready!", JSON.stringify(delivers("LCL").map((x) => x.body)));
    c.ok("…recorded on the job: 're-delivered in Aryeo: 2 new photos', the run says sent, nothing pending", (await prisma.photoJobEvent.count({ where: { jobId: jr.id, action: { startsWith: "re-delivered in Aryeo: 2 new photos on the listing" } } })) === 1 && pr1?.redeliver?.state === "sent" && pr1.redeliver.pending === 0 && pr1.redeliver.photos === 2, JSON.stringify(pr1?.redeliver));
    c.ok("…then verified as usual (5 on the listing) and Delivered", jr1.stage === "DELIVERED" && pr1?.state === "DONE", `${jr1.stage} ${pr1?.state} ${jr1.deliveryCheckNote}`);
    await drive(jr.id);
    await P.advancePush(jr.id, { budgetMs: 10_000 });
    c.ok("…moving the push on again never re-delivers twice", delivers("LCL").length === 1);
    const again = await P.approvePushDelivery(jr.id, "Kyle");
    c.ok("…and Deliver in Aryeo after it answers 'Already delivered'", /Already delivered/.test(again.message) && delivers("LCL").length === 1, again.message);

    // A claim left by a pass that stopped: never sent again.
    const raw = (await prisma.appSetting.findUniqueOrThrow({ where: { key: `photo_aryeo_push:${jr.id}` } })).value;
    const dead = { ...JSON.parse(raw), id: "deadpass", state: "DELIVERING", deliveredAt: null, finishedAt: null, lease: null, addedSinceDelivery: ["x1"], redelivery: null };
    await prisma.appSetting.update({ where: { key: `photo_aryeo_push:${jr.id}` }, data: { value: JSON.stringify(dead) } });
    await prisma.appSetting.create({ data: { key: `photo_redeliver:${jr.id}:deadpass`, updatedBy: "drill", value: JSON.stringify({ state: "sending", at: new Date().toISOString(), photos: 1 }) } });
    await drive(jr.id);
    const pr2 = await P.pushProgress(jr.id);
    c.ok("a re-delivery claimed by a pass that stopped is 'uncertain' and never sent again", delivers("LCL").length === 1 && pr2?.redeliver?.state === "uncertain" && pr2.redeliver.pending === 0 && (await prisma.photoJobEvent.count({ where: { jobId: jr.id, action: { contains: "did not finish cleanly" } } })) === 1, JSON.stringify(pr2?.redeliver));

    // A push with nothing new: never a re-delivery.
    const jn = await splitJob("9 Same Ct", "LSC", 2, ["IMG_8001.jpg"], ["IMG_8001.jpg"]);
    const a2 = await P.approveJob(jn.id, "Kyle", { deliver: true });
    await drive(jn.id);
    const prn = await P.pushProgress(jn.id);
    c.ok("a push whose only photo is already on the listing (by file name): nothing sent, no re-delivery", a2.started && !calls.some((x) => x.kind === "upload" && /9 Same Ct|IMG_8001/.test(String(x.body))) && delivers("LSC").length === 0 && !prn?.redeliver && prn?.matched === 1, `${a2.message} · ${JSON.stringify(prn)}`);
    c.ok("…the job still verifies and is Delivered", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jn.id } })).stage === "DELIVERED");

    // A first delivery is unchanged: delivered once, never as a re-delivery.
    const pf = await prisma.project.create({ data: { title: "3 First St, Reading, PA", addressLine: "3 First St", clientId: client.id, aryeoListingId: "LFS", shootDate: shot } });
    const jf = await prisma.photoJob.create({ data: { projectId: pf.id, stage: "READY", deliveryPath: "/AutoHDR/x/3 First St/06-Ready-for-Aryeo", deliveryStagedAt: new Date() } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: jf.id, name: `F${k}.jpg`, sourceKind: "AUTOHDR", contentHash: `ff-${k}`, inspectedHash: `ff-${k}`, sequence: k, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } });
    listings.set("LFS", { id: "LFS", delivery: "UNDELIVERED", images: [] });
    await fill(jf.id, "/AutoHDR/x/3 First St/06-Ready-for-Aryeo");
    await P.approveJob(jf.id, "Kyle", { deliver: true });
    await drive(jf.id);
    const prf = await P.pushProgress(jf.id);
    c.ok("a first delivery: Deliver pressed once, no re-delivery recorded", delivers("LFS").length === 1 && !prf?.redeliver && (delivers("LFS")[0].body as { fulfill_orders?: boolean }).fulfill_orders === false, JSON.stringify(prf?.redeliver));

    // ======================================================================
    c.head("6 · the floating-object check (615 Cliff Ln's floating lamp)");
    // ======================================================================
    const reg = await import("@/lib/photoDelivery/registry");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const prep = await import("@/lib/photoDelivery/prep");
    const house = await import("@/lib/photoDelivery/houseRules");
    const { P1_BLOCK } = await import("@/lib/photoDelivery/qc/prompts/p1-photo.v1");
    const rule = reg.ruleById("AIEDIT_FLOATING_OBJECT");
    c.ok("a registry rule: MAJOR, per photo, any room, the editor's (an AutoHDR artifact), in the rule format", rule?.defaultSeverity === "MAJOR" && rule.pass === "P1_PHOTO" && rule.detector === "VISION_PHOTO" && rule.rooms.join() === "ANY" && rule.responsibility === "EDITOR" && rule.groupKey === "FLOATING_OBJECT" && /lamp/.test(rule.visionHint ?? "") && !rule.escalateTo && reg.RULES_REGISTRY_VERSION === "v1.3-2026-10-22", JSON.stringify(rule));
    const bedroomRules = reg.visionRulesForPhoto({ roomType: "BEDROOM", roomConfidence: 0.9, alternateRoomType: null, maxBuildPhase: 1 });
    c.ok("…in the paid QC's rules block for a bedroom photo", bedroomRules.some((r) => r.id === "AIEDIT_FLOATING_OBJECT") && /AIEDIT_FLOATING_OBJECT/.test(reg.renderRulesBlock(bedroomRules, "BEDROOM")));
    c.ok("…and switched off by a house override there too", !reg.visionRulesForPhoto({ roomType: "BEDROOM", roomConfidence: 0.9, alternateRoomType: null, maxBuildPhase: 1, overrides: [{ ruleId: "AIEDIT_FLOATING_OBJECT", disabled: true, reason: "x" }] }).some((r) => r.id === "AIEDIT_FLOATING_OBJECT"));
    c.ok("…the paid QC's photo prompt names floating or unsupported objects", /floating or unsupported objects \(a lamp, furniture or decor hovering with nothing under it/.test(P1_BLOCK));
    const off = new Set(["GAL_RESOLUTION_CONSISTENCY", "KIT_CABINET_COLOR_ACROSS_PHOTOS", "PERSP_STRETCHED_EDGE_FURNITURE", "PERSP_EXCESSIVE_FISHEYE", "COMP_MOTION_BLUR"]);
    const fq = check.checkPrompt(off);
    c.ok("the free check's question asks it (v4), in plain words, furniture and decor included", check.CHECK_PROMPT_VERSION === 4 && /AIEDIT_FLOATING_OBJECT: a lamp, piece of furniture or decor floating with nothing under it/.test(fq) && /Editing mistakes: .* is AIEDIT_FLOATING_OBJECT, furniture and decor included/.test(fq), fq.split("\n").filter((l) => /FLOATING|Editing/.test(l)).join(" | "));
    c.ok("…the five checks Jordan switched off stay out", [...off].every((id) => !fq.includes(id)));
    const parsedAns = check.parseCheckAnswer('{"room":"bedroom","issues":[{"id":"AIEDIT_FLOATING_OBJECT","where":"lamp beside the crib, no nightstand under it","confidence":0.82}]}', off);
    c.ok("…an answer naming it becomes a finding of that rule (the free check files it as MAJOR)", parsedAns?.issues[0]?.ruleId === "AIEDIT_FLOATING_OBJECT" && reg.ruleById(parsedAns.issues[0].ruleId)?.defaultSeverity === "MAJOR", JSON.stringify(parsedAns?.issues));
    const sl = policy.secondLookPrompt([{ label: rule!.shortLabel, where: "lamp beside the crib" }]);
    c.ok("…its second look asks 'Floating object (nothing under it): lamp beside the crib'", /1\. Floating object \(nothing under it\): lamp beside the crib/.test(sl), sl);
    const offFloat = check.checkPrompt(new Set([...off, "AIEDIT_FLOATING_OBJECT"]));
    c.ok("switched off with the house list (the house-overrides mechanism): left out of the question, explanation included", !/AIEDIT_FLOATING_OBJECT|Editing mistakes/.test(offFloat) && house.disabledIn([{ ruleId: "AIEDIT_FLOATING_OBJECT", disabled: true, reason: "x" }]).has("AIEDIT_FLOATING_OBJECT"));
    c.ok("never clutter: not fixed automatically, never set aside by the prep gate in an as-is home", policy.fixClass("AIEDIT_FLOATING_OBJECT") === "never" && !prep.isClutterRule("AIEDIT_FLOATING_OBJECT") && prep.gateFor({ ruleId: "AIEDIT_FLOATING_OBJECT", confidence: 0.9 }, "AS_IS", "cluttered") === null);

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

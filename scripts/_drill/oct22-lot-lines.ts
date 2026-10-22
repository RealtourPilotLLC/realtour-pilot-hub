// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: LOT LINES, DOWNLOAD, REPLACE WITH AN UPLOAD, ADD PHOTOS BY HAND
// (Oct 22 2026, lib/photoDelivery/lotLines.ts + hubFiles.ts).
//
// Jordan: "Let's add a lot lines adder tool to the photos section so we can
// add lot lines." Then: "we should be able to download photos, and then
// replace them with an upload, or add photos to the gallery manually."
//   1. The drawing, pure: a closed boundary lands on the right pixels (a
//      vertex, an edge, inside and outside), solid and dashed, the soft
//      shadow, the fill, the label's letters; image-relative points scale to
//      the full size; the drawing is cleaned (no long dashes, in range).
//   2. Save, as Kyle: the server paints the full-size photo; a HUB_EDIT
//      version labelled "Lot lines by Kyle" with the drawing in derivJson;
//      the photo is it; a job event; Update on Aryeo offered; a stale editor
//      refused.
//   3. The original stays restorable (both ways); the tool reopens on the
//      drawing; a second save draws on the picture under, never over the old
//      lines; lot lines over a straighten keep its settings.
//   4. Who: owner and Kyle; the creative manager and a photographer refused,
//      nothing changes; the view-only lightbox has no Lot lines button (and
//      Download only).
//   5. Download: current and original, full size, as attachments; the
//      creative manager may; a photographer may not; an AutoHDR photo never
//      bought is refused without asking AutoHDR anything.
//   6. Replace with an upload: a PNG becomes the JPEG current version
//      ("Replaced by upload by Kyle"), findings carried, the one before
//      restorable, Straighten then starts from the upload; strays refused.
//   7. Add photos by hand: new ACTIVE photos at the end of the order, marked
//      UPLOAD, their file the hub's; a gallery sync never sets them aside.
//   8. Delivery: Update on Aryeo replaces the lot-lines photo on the listing
//      (the label contract survives it); 06-Ready-for-Aryeo and the push
//      send the hand-added photo, once; the sync carries it over in place.
//   9. The upload route: a token for one path, owner or Kyle only.
// ISOLATION: PGlite via the shared harness; Aryeo (web, Uploadcare, API,
// CDN), Dropbox and the private store answered in-process; nothing else.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import type { LotDrawing } from "@/lib/photoDelivery/lotLines";

const next = installNextStubs();
// The job page's client components read the router; a drill renders them once, statically.
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery";
  nav.useSearchParams = () => new URLSearchParams();
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const lower = (s: string) => s.toLowerCase();
let n = 0;
const nid = (p: string) => `${p}-${String(++n).padStart(4, "0")}`;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const controls = (h: string) => [...h.matchAll(/<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]).trim()).filter(Boolean);

// ---- Dropbox (06-Ready-for-Aryeo), keeping the bytes ------------------------------------------
const dbx = new Map<string, { path: string; bytes: Buffer }>();
const dbxFolders = new Set<string>();
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
function dropbox(url: string, init?: RequestInit): Response | null {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  if (url === "https://content.dropboxapi.com/2/files/upload") {
    const a = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") ?? "{}") as { path: string };
    const bytes = Buffer.from(init?.body as Uint8Array);
    dbx.set(lower(a.path), { path: a.path, bytes });
    dbxFolders.add(lower(parentOf(a.path)));
    return json({ name: a.path.split("/").pop(), path_display: a.path, size: bytes.length });
  }
  if (!url.startsWith("https://api.dropboxapi.com/2/files/")) return null;
  const ep = url.slice("https://api.dropboxapi.com/2/files/".length);
  const a = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
  if (ep === "create_folder_v2") { dbxFolders.add(lower(a.path)); return json({ metadata: { path_display: a.path, id: "id:f" } }); }
  if (ep === "delete_v2") {
    const pre = lower(a.path);
    let hit = dbxFolders.delete(pre) || dbx.delete(pre);
    for (const k of [...dbx.keys()]) if (k.startsWith(`${pre}/`)) { dbx.delete(k); hit = true; }
    for (const k of [...dbxFolders]) if (k.startsWith(`${pre}/`)) { dbxFolders.delete(k); hit = true; }
    return hit ? json({ metadata: {} }) : json({ error_summary: "path_lookup/not_found/" }, 409);
  }
  if (ep === "move_v2") {
    const from = lower(a.from_path), to = a.to_path;
    if (!dbxFolders.has(from)) return json({ error_summary: "from_lookup/not_found/" }, 409);
    dbxFolders.delete(from);
    dbxFolders.add(lower(to));
    for (const [k, f] of [...dbx]) if (k.startsWith(`${from}/`)) { dbx.delete(k); const np = to + f.path.slice(from.length); dbx.set(lower(np), { path: np, bytes: f.bytes }); }
    return json({ metadata: { path_display: to } });
  }
  if (ep === "list_folder") {
    const pre = lower(a.path);
    if (!dbxFolders.has(pre) && ![...dbx.keys()].some((k) => k.startsWith(`${pre}/`))) return json({ error_summary: "path/not_found/" }, 409);
    const entries = [
      ...[...dbx.values()].filter((f) => lower(parentOf(f.path)) === pre).map((f) => ({ ".tag": "file", name: f.path.split("/").pop(), path_display: f.path, id: `id:${f.path}`, size: f.bytes.length })),
      ...[...dbxFolders].filter((k) => parentOf(k) === pre).map((k) => ({ ".tag": "folder", name: k.split("/").pop(), path_display: k, id: `id:${k}` })),
    ];
    return json({ entries, has_more: false });
  }
  return json({ error_summary: `unstubbed ${ep}` }, 400);
}

// ---- Aryeo: the web app (sign-in, listing editor), Uploadcare, the public API, the CDN --------
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
const UC_KEY = "c0ffee0123456789abcd";
type Img = { id: string; filename: string; index: number; bytes: Buffer };
type Listing = { id: string; delivery: "UNDELIVERED" | "DELIVERED"; images: Img[] };
const listings = new Map<string, Listing>();
const ucFiles = new Map<string, { name: string; bytes: Buffer }>();
const ucGroups = new Map<string, string[]>();
const calls: { kind: string; body?: unknown }[] = [];
const sessions = new Set<string>();
const pending = new Set<string>();
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const sorted = (l: Listing) => [...l.images].sort((a, b) => a.index - b.index);
function editPage(l: Listing) {
  return {
    component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`,
    props: {
      errors: {},
      listing: { id: l.id, delivery_status: l.delivery === "DELIVERED" ? "delivered" : "undelivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Drill Agent" } }] },
      images: sorted(l).map((i) => ({ id: i.id, title: null, is_live: true, filename: i.filename.replace(/\.jpg$/i, ""), filename_extension: "jpg" })),
      company: { default_enable_mark_orders_fulfilled: true, default_timezone: "America/New_York" },
      image_uploads_require_media_license: true,
    },
  };
}
async function aryeo(url: string, init?: RequestInit): Promise<Response | null> {
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
    calls.push({ kind: "login" });
    const b = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (h.get("x-xsrf-token") !== "tok==" || b.email !== LOGIN.email || b.password !== LOGIN.password) return withCookies(redirect("https://app.aryeo.com/login"), ["aryeo_session=refused; path=/; domain=.aryeo.com"]);
    const s = nid("auth");
    pending.add(s);
    return withCookies(new Response(null, { status: 409, headers: { "x-inertia-location": "https://app.aryeo.com/companies" } }), [`aryeo_session=${s}; path=/; domain=.aryeo.com; httponly`, "XSRF-TOKEN=tok2%3D%3D; path=/; domain=.aryeo.com"]);
  }
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/companies") {
    const s = ck.aryeo_session ?? "";
    if (!pending.has(s) && !sessions.has(s)) return redirect("https://app.aryeo.com/login");
    pending.delete(s);
    sessions.add(s);
    return redirect("https://realtourpilot.aryeo.com/admin/dashboard");
  }
  if (u.origin === "https://cdn.aryeo.com") {
    const id = u.pathname.slice(1).replace(/\.jpg$/, "");
    for (const l of listings.values()) {
      const img = l.images.find((i) => i.id === id);
      if (img) return new Response(new Uint8Array(img.bytes), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("gone", { status: 404 });
  }
  if (u.origin === "https://api.aryeo.com" && u.pathname.startsWith("/v1/listings/")) {
    const l = listings.get(u.pathname.split("/")[3]);
    if (!l) return json({ message: "Not found" }, 404);
    return json({ data: { id: l.id, delivery_status: l.delivery, images: sorted(l).map((i, k) => ({ id: i.id, filename: i.filename, original_url: `https://cdn.aryeo.com/${i.id}.jpg`, display_in_gallery: true, index: k })), floor_plans: [] } });
  }
  if (u.origin !== "https://realtourpilot.aryeo.com") return null;
  if (!sessions.has(ck.aryeo_session ?? "")) return redirect("https://app.aryeo.com/login");
  if (method !== "GET" && h.get("x-xsrf-token") !== "tok2==") return new Response("CSRF", { status: 419 });
  if (u.pathname === "/admin/dashboard") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    return l ? json(editPage(l)) : new Response("nope", { status: 404 });
  }
  m = /^\/admin\/listing\/([^/]+)\/image-uploads$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { form_uuid_field: string };
    calls.push({ kind: "attach", body: b });
    for (const uuid of ucGroups.get(b.form_uuid_field) ?? []) {
      l.images.forEach((i) => i.index++);
      const f = ucFiles.get(uuid)!;
      l.images.push({ id: nid("img"), filename: f.name, index: 0, bytes: f.bytes });
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/listing\/([^/]+)\/images$/.exec(u.pathname);
  if (m && method === "PUT") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: { id: string }[] };
    calls.push({ kind: "reorder" });
    b.images.forEach((x, k) => { const i = l.images.find((y) => y.id === x.id); if (i) i.index = k; });
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  if (m && method === "DELETE") {
    const l = listings.get(m[1])!;
    const b = JSON.parse(String(init?.body)) as { images: string[] };
    calls.push({ kind: "delete", body: b.images });
    l.images = l.images.filter((i) => !b.images.includes(i.id));
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    calls.push({ kind: "deliver" });
    listings.get(m[1])!.delivery = "DELIVERED";
    return redirect(`/admin/listings/${m[1]}/edit`);
  }
  return new Response("not faked", { status: 404 });
}
async function uploadcare(url: string, init?: RequestInit): Promise<Response | null> {
  if (!url.startsWith("https://upload.uploadcare.com/")) return null;
  const form = init?.body as FormData;
  if (url.endsWith("/base/")) {
    const file = form.get("file") as File;
    const uuid = nid("uc");
    ucFiles.set(uuid, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
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

const fence = fenceFetch(async (url, init) => dropbox(url, init) ?? (await aryeo(url, init)) ?? (await uploadcare(url, init)) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

/** A W × H grass-green aerial with a lighter "roof", as a JPEG. */
async function aerial(W: number, H: number): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const roof = x > W * 0.4 && x < W * 0.6 && y > H * 0.4 && y < H * 0.6;
    raw[i] = roof ? 150 : 70;
    raw[i + 1] = roof ? 140 : 125;
    raw[i + 2] = roof ? 130 : 60;
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
const px = async (jpeg: Buffer, x: number, y: number) => {
  const r = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * r.info.width + Math.round(x)) * r.info.channels;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
};
const isRed = (c: number[]) => c[0] > 200 && c[1] < 70 && c[2] < 70;
const isYellow = (c: number[]) => c[0] > 200 && c[1] > 180 && c[2] < 90;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7357), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s", AUTH_ENFORCE: "true", APP_SECRET: "isolated-lot-lines" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const L = await import("@/lib/photoDelivery/lotLines");

    // ======================================================================
    c.head("1 · the drawing, pure");
    const gray = (W: number, H: number) => ({ data: new Uint8Array(W * H * 3).fill(128), width: W, height: H, channels: 3 as const });
    const at = (r: { data: Uint8Array; width: number; channels: number }, x: number, y: number) => {
      const i = (Math.floor(y) * r.width + Math.floor(x)) * r.channels;
      return [r.data[i], r.data[i + 1], r.data[i + 2]];
    };
    const square = (over: Partial<LotDrawing["style"]> = {}, label: Partial<LotDrawing["label"]> = {}) =>
      L.cleanDrawing({ points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }], closed: true, style: { color: "#ff0000", width: 20, dashed: false, glow: false, fill: false, ...over }, label: { show: false, ...label } });
    const r1 = gray(400, 300);
    L.renderLotLines(r1, square());
    c.ok("a closed boundary: red at a corner (100, 75) and along an edge (200, 75), (300, 150)", isRed(at(r1, 100, 75)) && isRed(at(r1, 200, 75)) && isRed(at(r1, 300, 150)) && isRed(at(r1, 200, 225)) && isRed(at(r1, 100, 150)), `${at(r1, 100, 75)} ${at(r1, 200, 75)}`);
    c.ok("…untouched inside (200, 150) and outside (20, 20), (200, 40)", at(r1, 200, 150).join() === "128,128,128" && at(r1, 20, 20).join() === "128,128,128" && at(r1, 200, 40).join() === "128,128,128");
    // Width 20 = 2% of the 400 px long edge = 8 px: 4 each side of the line.
    c.ok("…the line is its width wide (8 px at width 20 on a 400 px photo): red at 3 px off the line, gray at 6", isRed(at(r1, 200, 75 + 3)) && isRed(at(r1, 200, 75 - 3)) && at(r1, 200, 75 + 6).join() === "128,128,128");
    const r2 = gray(400, 300);
    L.renderLotLines(r2, square({ dashed: true }));
    const along = (r: typeof r1) => Array.from({ length: 180 }, (_, i) => isRed(at(r, 110 + i, 75)));
    const solidRun = along(r1), dashRun = along(r2);
    const switches = dashRun.filter((v, i) => i > 0 && v !== dashRun[i - 1]).length;
    c.ok("solid: every pixel along the top edge is the line", solidRun.every(Boolean));
    c.ok("dashed: dashes and gaps along the same edge (round ends: 3 widths on, 2 off)", dashRun.some(Boolean) && dashRun.some((v) => !v) && switches >= 6, `${dashRun.filter(Boolean).length} of 180 red, ${switches} switches`);
    const r3 = gray(400, 300);
    L.renderLotLines(r3, square({ glow: true }));
    const shadowAt = at(r3, 200, 75 - 6);
    c.ok("the soft shadow darkens just past the line, nothing far from it", shadowAt[0] < 120 && shadowAt[1] < 120 && at(r3, 200, 20).join() === "128,128,128" && isRed(at(r3, 200, 75)), `${shadowAt}`);
    const r4 = gray(400, 300);
    L.renderLotLines(r4, square({ fill: true, fillOpacity: 0.5 }));
    const inside = at(r4, 200, 150);
    c.ok("the light fill: inside half way to the colour, outside untouched", Math.abs(inside[0] - 192) <= 2 && Math.abs(inside[1] - 64) <= 2 && at(r4, 20, 20).join() === "128,128,128", `${inside}`);
    const r5 = { data: new Uint8Array(400 * 300 * 3), width: 400, height: 300, channels: 3 as const };
    const lab = L.cleanDrawing({ points: [], closed: false, style: { color: "#ffffff", glow: false }, label: { show: true, text: "LOT", x: 0.5, y: 0.5, size: 8 } });
    L.renderLotLines(r5, lab);
    const place = L.labelPlacement(lab.label, 400, 300)!;
    let whiteIn = 0, whiteOut = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const v = r5.data[(y * 400 + x) * 3];
      const inBox = x >= place.box.x0 - 1 && x <= place.box.x1 + 1 && y >= place.box.y0 - 1 && y <= place.box.y1 + 1;
      if (v > 200) { if (inBox) whiteIn++; else whiteOut++; }
    }
    c.ok("the label's letters are drawn inside their box, nothing outside it", whiteIn > 150 && whiteOut === 0, `${whiteIn} in, ${whiteOut} out, box ${JSON.stringify(place.box)}`);
    const big = gray(1600, 1200);
    L.renderLotLines(big, square());
    c.ok("image-relative points scale to the full size: the same corner at (400, 300) on a 4× photo, the line 4× as wide", isRed(at(big, 400, 300)) && isRed(at(big, 800, 300 + 12)) && at(big, 800, 300 + 24).join() === "128,128,128" && at(big, 800, 600).join() === "128,128,128");
    const p4 = L.labelPlacement(L.cleanDrawing({ label: { show: true, text: "Approximate property lines", x: 0.5, y: 0.9, size: 3 } }).label, 1600, 1200)!;
    const p1 = L.labelPlacement(L.cleanDrawing({ label: { show: true, text: "Approximate property lines", x: 0.5, y: 0.9, size: 3 } }).label, 400, 300)!;
    c.ok("…and so does the label (its box 4× on a 4× photo)", Math.abs(p4.box.x0 - 4 * p1.box.x0) < 0.5 && Math.abs(p4.box.y1 - 4 * p1.box.y1) < 0.5, `${JSON.stringify(p1.box)} ${JSON.stringify(p4.box)}`);
    const dirty = L.cleanDrawing({ points: [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }], closed: false, style: { color: "red", width: 999 }, label: { text: "Approx \u2014 lines \u2019ok\u2019 \u{1F600}" } });
    c.ok("cleaned: points kept in the photo, width capped, a bad colour is white, the label without long dashes or emoji", dirty.points[0].x === 0 && dirty.points[0].y === 1 && dirty.style.width === L.WIDTH_MAX && dirty.style.color === "#ffffff" && dirty.label.text === "Approx - lines 'ok'", JSON.stringify(dirty.label.text));
    c.ok("a boundary needs 3 points, an open line 2", /at least 3/.test(L.drawingProblem(L.cleanDrawing({ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] })) ?? "") && L.drawingProblem(L.cleanDrawing({ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], closed: false })) === null);
    c.ok("the version name is the contract's prefix, then who", L.lotLinesVersionLabel("Kyle") === "Lot lines by Kyle" && L.lotLinesVersionLabel("Kyle").startsWith(L.LOT_LINES_LABEL) && L.LOT_LINES_LABEL === "Lot lines");
    c.ok("the preview's label path is the same letters (an SVG path in the photo's pixels)", /^M[\d.]+ [\d.]+/.test(L.labelSvgPath(L.DEFAULT_LABEL, 2048, 1365)) && L.labelSvgPath({ ...L.DEFAULT_LABEL, show: false }, 2048, 1365) === "");

    // ======================================================================
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const { setSession } = await import("@/lib/auth/session");
    const B = await import("@/lib/photoDelivery/blob");
    const V = await import("@/lib/photoDelivery/versions");
    const PE = await import("@/lib/photoDelivery/photoEdit");
    const HF = await import("@/lib/photoDelivery/hubFiles");
    const S = await import("@/lib/photoDelivery/straighten");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const handoff = await import("@/lib/photoDelivery/handoff");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const F = await import("@/app/ops/photo-delivery/fileActions");
    const E = await import("@/app/ops/photo-delivery/editActions");
    const data = await import("@/app/ops/photo-delivery/data");
    const { NextRequest } = await import("next/server");
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    const W2 = await import("@/lib/integrations/aryeoWeb");
    await saveSecret(W2.ARYEO_WEB_PROVIDER, LOGIN.password, { accountLabel: LOGIN.email, metadata: { email: LOGIN.email } });
    await savePhotoDeliverySettings({ enabled: true, aryeoPush: "on", qcShadow: true }, "drill");
    const store = new Map<string, Buffer>();
    B.__setDerivativeStoreForTests({
      async put(pathname, bytes) { store.set(pathname, Buffer.from(bytes)); return { pathname, url: `https://drill-store.private.blob.vercel-storage.invalid/${pathname}` }; },
      async read(ref) { const b = store.get(ref.pathname); return b ? { stream: new Blob([new Uint8Array(b)]).stream(), size: b.length, contentType: "image/jpeg" } : null; },
    });
    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@lot.invalid` } });
    const login = async (name: string, role: string, tmRole: string) => {
      const t = await tm(name, tmRole);
      return prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@lot.invalid`, role, teamMemberId: t.id, status: "ACTIVE" } });
    };
    const kyle = await login("Kyle", "ADMIN", "MANAGER");
    const owner = await login("Jordan Spackman", "OWNER", "PHOTOGRAPHER");
    const james = await login("James Livingston", "CREATIVE_MANAGER", "PHOTOGRAPHER");
    const harrison = await login("Harrison Reed", "PHOTOGRAPHER", "PHOTOGRAPHER");
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await signIn(kyle);

    // 58 Recreation Dr, Jim Thorpe: Lot Lines + Drone Aerial Photography. Three listing photos (Aryeo).
    const W = 1200, H = 800;
    const BASE = await aerial(W, H);
    const client = await prisma.client.create({ data: { name: "Brandon Dunbar TEST" } });
    const project = await prisma.project.create({ data: { title: "58 Recreation Dr, Jim Thorpe, PA", addressLine: "58 Recreation Dr", city: "Jim Thorpe", state: "PA", clientId: client.id, aryeoListingId: "L-LOT" } });
    listings.set("L-LOT", { id: "L-LOT", delivery: "UNDELIVERED", images: [1, 2, 3].map((k, i) => ({ id: `lot-${k}`, filename: `58 Recreation Dr (${k} of 3).jpg`, index: i, bytes: BASE })) });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    await jobs.syncJobFinals(job.id);
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    const rows = await prisma.photoAsset.findMany({ where: { jobId: job.id }, orderBy: { sequence: "asc" } });
    for (const r of rows) await prisma.photoAsset.update({ where: { id: r.id }, data: { inspectedHash: r.contentHash, width: W, height: H, format: "jpeg", isAerial: true } });
    if (!c.ok("the job's three listing photos are in the hub", rows.length === 3 && rows.every((r) => r.sourceKind === "ARYEO"), rows.map((r) => r.name).join(", "))) throw new Error("stop");
    const [A, Bp, Cp] = rows;
    const finding = await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: Cp.id, ruleId: "REFL_SENSOR_DUST", groupKey: "DUST", pass: "P1_PHOTO", source: "AHDR", specificIssue: "A dust spot", explanation: "x", severity: "MINOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", status: "OPEN", arbitration: "CONFIRMED", contentHash: Cp.contentHash } });

    // ======================================================================
    c.head("2 · Save: the lines painted into the full-size photo, a new version");
    const opened = await F.loadLotLinesAction(job.id, A.id);
    c.ok("the tool opens on the photo as it is (2048 px, staff route), no drawing yet", opened.ok && opened.drawing === null && opened.baseHash === A.contentHash && opened.previewUrl === `/api/photo-delivery/img/${A.id}/qc2048?v=${encodeURIComponent(A.contentHash ?? "")}`, JSON.stringify(opened));
    const drawing: LotDrawing = L.cleanDrawing({ points: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.28 }, { x: 0.72, y: 0.7 }, { x: 0.28, y: 0.72 }], closed: true, style: { color: "#ff0000", width: 6, glow: true }, label: { show: true, text: "Approximate property lines", x: 0.5, y: 0.92, size: 3 } });
    const stale = await F.saveLotLinesAction({ jobId: job.id, photoId: A.id, baseHash: "an-older-version", drawing });
    c.ok("a tool opened on an older version is refused (nothing overwritten)", !stale.ok && /changed while it was open/.test(stale.message), stale.message);
    const tooFew = await F.saveLotLinesAction({ jobId: job.id, photoId: A.id, baseHash: A.contentHash, drawing: { ...drawing, points: drawing.points.slice(0, 2) } });
    c.ok("two points do not make a boundary", !tooFew.ok && /at least 3/.test(tooFew.message), tooFew.message);
    const saved = await F.saveLotLinesAction({ jobId: job.id, photoId: A.id, baseHash: A.contentHash, drawing });
    c.ok("Save: done, and Update on Aryeo is offered (the listing has the old file)", saved.ok && /Lot lines by Kyle/.test(saved.message) && /Update on Aryeo/.test(saved.message), saved.message);
    const a1 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } });
    const v1 = await prisma.photoVersion.findFirstOrThrow({ where: { photoId: A.id, label: { startsWith: "Lot lines" } } });
    const m1 = JSON.parse(v1.derivJson ?? "{}") as { file?: { pathname: string }; hub?: { kind?: string; base: { sourceHash: string | null } }; lotLines?: { drawing: LotDrawing; under: { hash: string } } };
    c.ok("a new version: source HUB_EDIT (the hub's own file, read by every reader), label \"Lot lines by Kyle\"", v1.source === "HUB_EDIT" && v1.label === "Lot lines by Kyle" && v1.createdBy === "Kyle", `${v1.source} ${v1.label}`);
    c.ok("…the drawing kept in derivJson (image-relative points, style, label) with the picture it was drawn on", m1.hub?.kind === "lotLines" && JSON.stringify(m1.lotLines?.drawing.points) === JSON.stringify(drawing.points) && m1.lotLines?.drawing.style.color === "#ff0000" && m1.lotLines?.drawing.label.text === "Approximate property lines" && m1.lotLines?.under.hash === A.contentHash && m1.hub?.base.sourceHash === A.contentHash);
    c.ok("the photo IS that version now (its hash, full size, every page size kept, still counted as checked)", a1.contentHash === v1.contentHash && PE.isHubEditHash(a1.contentHash) && a1.width === W && a1.height === H && a1.derivHash === a1.contentHash && Object.keys(JSON.parse(a1.derivJson ?? "{}")).length === 4 && a1.inspectedHash === a1.contentHash);
    const file1 = store.get(m1.file?.pathname ?? "")!;
    const meta1 = await sharp(file1).metadata();
    const cornerPx = await px(file1, 0.3 * W, 0.3 * H);
    const insidePx = await px(file1, 0.5 * W, 0.62 * H);
    c.ok("the saved file is the FULL-SIZE photo with the lines: red at a corner, the photo untouched inside", meta1.width === W && meta1.height === H && meta1.format === "jpeg" && isRed(cornerPx) && Math.abs(insidePx[1] - 125) < 12, `${meta1.width}x${meta1.height} corner ${cornerPx} inside ${insidePx}`);
    const ev = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: `lot lines added to ${A.name}` } });
    c.ok("a job event: \"lot lines added to <photo name>\"", !!ev && ev.actor === "Kyle", ev?.action ?? "none");
    const { loadPhotoBytes } = await import("@/lib/photoDelivery/qc/source");
    c.ok("every reader of the photo's file gets the lot lines (QC, the image route's renders, 06-Ready-for-Aryeo)", sha(await loadPhotoBytes(a1)) === sha(file1));
    const credits = await prisma.autohdrCreditEntry.count();
    c.ok("free: nothing in the AutoHDR credit ledger, no AutoHDR call", credits === 0 && !fence.blocked.some((u) => /autohdr|realestatephotoediting/.test(u)));
    const kyleViewer = (await data.loadViewer())!;
    const view1 = (await data.loadJobDetail(job.id, { viewer: kyleViewer }))!.photos.find((p) => p.id === A.id)!;
    c.ok("the page: lot lines are the current version, with Update on Aryeo (kind lotLines)", view1.hubEdit?.kind === "lotLines" && view1.hubEdit.label === "Lot lines by Kyle" && view1.hubEdit.needsListingUpdate === true && view1.versions.find((v) => v.current)?.id === v1.id, JSON.stringify(view1.hubEdit));

    // ======================================================================
    c.head("3 · the original stays restorable; the tool reopens on the drawing");
    const own = view1.versions.find((v) => v.source === "AUTOHDR_INITIAL")!;
    c.ok("the listing's own file is restorable from the versions strip", own.restorable === true && !own.current);
    const back = await V.restoreVersion(A.id, own.id, "Kyle");
    const a2 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } });
    c.ok("Restore the original: the photo is its own file again (the lot lines kept under Versions)", back.ok && a2.contentHash === A.contentHash && (await prisma.photoVersion.count({ where: { photoId: A.id, label: { startsWith: "Lot lines" } } })) === 1, back.message);
    const reopened0 = await F.loadLotLinesAction(job.id, A.id);
    c.ok("the tool, opened now, offers the earlier drawing to put back", reopened0.ok && reopened0.current === false && JSON.stringify(reopened0.drawing?.points) === JSON.stringify(drawing.points));
    const again = await V.restoreVersion(A.id, v1.id, "Kyle");
    c.ok("…and Restore puts the lot lines back as the current version", again.ok && (await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } })).contentHash === v1.contentHash, again.message);
    const reopened = await F.loadLotLinesAction(job.id, A.id);
    c.ok("reopened on the current lot lines: the same drawing, drawn on the photo under them (its own file)", reopened.ok && reopened.current && JSON.stringify(reopened.drawing) === JSON.stringify(drawing) && reopened.previewUrl === `/api/photo-delivery/edit-source/${A.id}?size=preview&v=${encodeURIComponent(A.contentHash ?? "")}`, reopened.previewUrl ?? "");
    const moved = L.cleanDrawing({ ...drawing, points: drawing.points.map((p) => ({ x: p.x + 0.1, y: p.y })), style: { ...drawing.style, color: "#ffd400" } });
    const second = await F.saveLotLinesAction({ jobId: job.id, photoId: A.id, baseHash: reopened.baseHash, drawing: moved });
    const v2 = await prisma.photoVersion.findFirstOrThrow({ where: { photoId: A.id, label: { startsWith: "Lot lines" } }, orderBy: { createdAt: "desc" } });
    const file2 = store.get((JSON.parse(v2.derivJson ?? "{}") as { file: { pathname: string } }).file.pathname)!;
    const oldCorner = await px(file2, 0.3 * W, 0.3 * H), newCorner = await px(file2, 0.4 * W, 0.3 * H);
    c.ok("a second save replaces the lines (drawn on the picture under, never over the old red ones)", second.ok && v2.id !== v1.id && !isRed(oldCorner) && isYellow(newCorner) && (JSON.parse(v2.derivJson ?? "{}") as { lotLines: { under: { hash: string } } }).lotLines.under.hash === A.contentHash, `${second.message} old ${oldCorner} new ${newCorner}`);

    // Lot lines over a straighten: drawn on the straightened picture, its settings kept.
    const sp = S.cleanParams({ rotate: 2, keystone: 0, crop: S.autoCrop(2, 0, W, H, "original"), aspect: "original" });
    const st = await E.renderStraightenOnServerAction({ jobId: job.id, photoId: Bp.id, baseHash: Bp.contentHash, params: sp, fixFindingIds: [] });
    const b1 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: Bp.id } });
    const sv = await PE.currentHubEdit(b1);
    const onStraight = await F.loadLotLinesAction(job.id, Bp.id);
    const lb = await F.saveLotLinesAction({ jobId: job.id, photoId: Bp.id, baseHash: b1.contentHash, drawing });
    const b2 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: Bp.id } });
    const lv = await PE.currentHubEdit(b2);
    const ll = HF.lotLinesOf(lv?.meta ?? null);
    c.ok("on a straightened photo: drawn on the straightened picture, the straighten's settings kept (Straighten reopens on them)", st.ok && lb.ok && !!sv && ll?.under.versionId === sv.id && ll.under.hash === b1.contentHash && JSON.stringify(lv?.meta.hub?.params) === JSON.stringify(sp) && lv?.meta.hub?.base.sourceHash === Bp.contentHash, `${st.message} | ${lb.message}`);
    const reB = await F.loadLotLinesAction(job.id, Bp.id);
    c.ok("…reopened, it shows the straightened picture (its kept copy) to draw on", onStraight.previewUrl?.includes(`v=${encodeURIComponent(b1.contentHash ?? "")}`) === true && reB.previewUrl === `/api/photo-delivery/img/${Bp.id}/qc2048?v=${encodeURIComponent(b1.contentHash ?? "")}&version=${sv!.id}`, reB.previewUrl ?? "");

    // ======================================================================
    c.head("4 · who: the owner and Kyle; never the creative manager or a photographer");
    const before = { a: (await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } })).contentHash, versions: await prisma.photoVersion.count({ where: { photo: { jobId: job.id } } }) };
    const refusedBy = async (u: typeof james) => {
      await signIn(u);
      const r1x = await F.saveLotLinesAction({ jobId: job.id, photoId: A.id, baseHash: before.a, drawing });
      const r2x = await F.loadLotLinesAction(job.id, A.id);
      const r3x = await F.replaceWithUploadAction({ jobId: job.id, photoId: A.id, baseHash: before.a, stored: { pathname: `${HF.uploadPathPrefix(job.id, A.id)}x.jpg` }, fileName: "x.jpg" });
      const r4x = await F.addPhotosAction({ jobId: job.id, files: [{ pathname: `${HF.uploadPathPrefix(job.id, "new")}x.jpg`, fileName: "x.jpg" }] });
      return [r1x, r2x, r3x, r4x].every((r) => !r.ok && /access|sign in/i.test(r.message));
    };
    c.ok("the creative manager is refused every one (save, open, replace, add)", await refusedBy(james));
    c.ok("a photographer is refused every one", await refusedBy(harrison));
    c.ok("…and nothing changed", (await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } })).contentHash === before.a && (await prisma.photoVersion.count({ where: { photo: { jobId: job.id } } })) === before.versions);
    await signIn(owner);
    const ownerOpen = await F.loadLotLinesAction(job.id, A.id);
    c.ok("the owner may", ownerOpen.ok, ownerOpen.message);
    // The lightbox, as Kyle and as the creative manager's view-only desk.
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    await signIn(kyle);
    const kv = (await data.loadViewer())!;
    const kFrame = html(createElement(JobWorkspace, { data: (await data.loadJobDetail(job.id, { viewer: kv }))!, viewer: kv, initialPhoto: A.id, history: null }));
    await signIn(james);
    const jv = (await data.loadViewer())!;
    const jFrame = html(createElement(JobWorkspace, { data: (await data.loadJobDetail(job.id, { viewer: jv }))!, viewer: jv, initialPhoto: A.id, history: null }));
    const kc = controls(kFrame), jc = controls(jFrame);
    c.ok("Kyle's lightbox: Lot lines next to Straighten and crop, Download (and the original), Replace with an upload; Add photos on the gallery", kc.includes("Lot lines") && kc.includes("Straighten and crop") && kc.includes("Download") && kc.includes("Download original") && kc.includes("Replace with an upload") && kc.includes("Add photos"), kc.filter((t) => /Lot|Download|Replace|Add/.test(t)).join(" | "));
    c.ok("the view-only lightbox: no Lot lines button (nor Replace, Add photos or Straighten), Download only", jv.readOnly === true && !jc.includes("Lot lines") && !jc.some((t) => /Replace with an upload|Add photos|Straighten/.test(t)) && jc.includes("Download") && /\/api\/photo-delivery\/download\//.test(jFrame), jc.filter((t) => /Lot|Download|Replace|Add|Straighten/.test(t)).join(" | "));
    const fs = await import("node:fs");
    const ours = ["src/components/photoDelivery/LotLinesEditor.tsx", "src/components/photoDelivery/PhotoFiles.tsx", "src/lib/photoDelivery/hubFiles.ts", "src/lib/photoDelivery/lotLines.ts", "src/app/ops/photo-delivery/fileActions.ts"].map((f) => fs.readFileSync(f, "utf8"));
    c.ok("no long dashes anywhere in the new tools' words", ours.every((src) => !/[\u2013\u2014]/.test(src)));

    // ======================================================================
    c.head("5 · Download: full size, never a paid download");
    const dl = await import("@/app/api/photo-delivery/download/[photoId]/route");
    const get = (photoId: string, which: string) => dl.GET(new NextRequest(`http://drill.local/api/photo-delivery/download/${photoId}?which=${which}`), { params: Promise.resolve({ photoId }) });
    await signIn(kyle);
    const curNow = await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } });
    const d1 = await get(A.id, "current");
    const d1b = Buffer.from(await d1.arrayBuffer());
    c.ok("Download: the current version (the lot lines) at full size, as an attachment named after the photo", d1.status === 200 && sha(d1b) === sha(file2) && /attachment; filename="58 Recreation Dr \(1 of 3\)\.jpg"/.test(d1.headers.get("content-disposition") ?? "") && d1.headers.get("cache-control") === "private, no-store" && PE.isHubEditHash(curNow.contentHash), d1.headers.get("content-disposition") ?? "");
    const d2 = await get(A.id, "original");
    const d2b = Buffer.from(await d2.arrayBuffer());
    c.ok("Download original: the listing's own file, before the lot lines", d2.status === 200 && sha(d2b) === sha(BASE) && /-original\.jpg/.test(d2.headers.get("content-disposition") ?? ""), d2.headers.get("content-disposition") ?? "");
    await signIn(james);
    c.ok("the creative manager's view-only desk may download", (await get(A.id, "current")).status === 200);
    await signIn(harrison);
    c.ok("a photographer may not", (await get(A.id, "current")).status === 403);
    await signIn(kyle);
    // An AutoHDR photo the hub never bought (another job): refused before AutoHDR is asked anything.
    const jobZ = await prisma.photoJob.create({ data: { projectId: (await prisma.project.create({ data: { title: "1 Unbought Way", clientId: client.id } })).id, stage: "QC_REVIEW", autohdrPhotoshootId: 9101 } });
    await prisma.photoIntakeBatch.create({ data: { projectId: jobZ.projectId, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: "[]", fileCount: 1, fingerprint: "z", photoshootId: 9101, photosJson: JSON.stringify([{ image_uuid: "uuid-unbought", image_version_uuid: "ver-1", name: "z.jpg", downloaded: false, url: null }]) } as never });
    const Z = await prisma.photoAsset.create({ data: { jobId: jobZ.id, name: "z.jpg", sourceKind: "AUTOHDR", sourceRef: "9101/uuid-unbought", autohdrImageUuid: "uuid-unbought", autohdrVersionUuid: "ver-1", contentHash: V.hashOfVersion("ver-1"), status: "ACTIVE" } });
    const blocked0 = fence.blocked.length;
    const dz = await get(Z.id, "current");
    c.ok("an AutoHDR photo never bought: refused in plain words, AutoHDR never asked", dz.status === 409 && /not been bought from AutoHDR/.test(await dz.text()) && fence.blocked.length === blocked0);

    // ======================================================================
    c.head("6 · Replace with an upload");
    const pngRaw = Buffer.alloc(W * H * 3);
    for (let i = 0; i < pngRaw.length; i += 3) pngRaw.set([30, 60, 200], i);
    const png = await sharp(pngRaw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const upPath = `${HF.uploadPathPrefix(job.id, Cp.id)}fixed-in-photoshop-a1b2.png`;
    store.set(upPath, png);
    const c0 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: Cp.id } });
    const stray = `${HF.uploadPathPrefix(job.id, A.id)}other.png`;
    store.set(stray, png);
    const strayR = await F.replaceWithUploadAction({ jobId: job.id, photoId: Cp.id, baseHash: c0.contentHash, stored: { pathname: stray }, fileName: "other.png" });
    store.set(`${HF.uploadPathPrefix(job.id, Cp.id)}notes.png`, Buffer.from("this is not a photo at all, just some words"));
    const junk = await F.replaceWithUploadAction({ jobId: job.id, photoId: Cp.id, baseHash: c0.contentHash, stored: { pathname: `${HF.uploadPathPrefix(job.id, Cp.id)}notes.png` }, fileName: "notes.png" });
    const tiny = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    store.set(`${HF.uploadPathPrefix(job.id, Cp.id)}tiny.jpg`, tiny);
    const small = await F.replaceWithUploadAction({ jobId: job.id, photoId: Cp.id, baseHash: c0.contentHash, stored: { pathname: `${HF.uploadPathPrefix(job.id, Cp.id)}tiny.jpg` }, fileName: "tiny.jpg" });
    c.ok("refused: another photo's upload, a file that is not a photo, a thumbnail", !strayR.ok && /not this photo's/.test(strayR.message) && !junk.ok && /can't be read/.test(junk.message) && !small.ok && /too small/.test(small.message), `${strayR.message} | ${junk.message} | ${small.message}`);
    const rep = await F.replaceWithUploadAction({ jobId: job.id, photoId: Cp.id, baseHash: c0.contentHash, stored: { pathname: upPath }, fileName: "fixed in photoshop.png" });
    const c1 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: Cp.id } });
    const rv = await PE.currentHubEdit(c1);
    const rfile = rv?.meta.file ? store.get(rv.meta.file.pathname) : null;
    const rmeta = rfile ? await sharp(rfile).metadata() : null;
    c.ok("the PNG becomes the photo's current version, as a full-size JPEG: \"Replaced by upload by Kyle\"", rep.ok && rv?.label === "Replaced by upload by Kyle" && rv.meta.hub?.kind === "upload" && rmeta?.format === "jpeg" && rmeta.width === W && c1.contentHash === rv.meta.hub?.hash && /Update on Aryeo/.test(rep.message), rep.message);
    const fd = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: finding.id } });
    c.ok("its findings carried to the new file (open, to check against it), still counted as checked", fd.status === "OPEN" && fd.contentHash === c1.contentHash && c1.inspectedHash === c1.contentHash);
    c.ok("a job event names the file", !!(await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: { startsWith: `${Cp.name} replaced by an upload (fixed in photoshop.png)` } } })));
    const es = await import("@/app/api/photo-delivery/edit-source/[photoId]/route");
    const full = await es.GET(new NextRequest(`http://drill.local/api/photo-delivery/edit-source/${Cp.id}?size=full`), { params: Promise.resolve({ photoId: Cp.id }) });
    c.ok("Straighten now starts from the uploaded file, not the one it replaced", full.status === 200 && sha(Buffer.from(await full.arrayBuffer())) === sha(rfile!));
    const cView = (await data.loadJobDetail(job.id, { viewer: kyleViewer }))!.photos.find((p) => p.id === Cp.id)!;
    const cOwn = cView.versions.find((v) => v.source === "AUTOHDR_INITIAL")!;
    const rb = await V.restoreVersion(Cp.id, cOwn.id, "Kyle");
    c.ok("the one before stays restorable: Restore puts the listing's file back", cOwn.restorable === true && rb.ok && (await prisma.photoAsset.findUniqueOrThrow({ where: { id: Cp.id } })).contentHash === c0.contentHash, rb.message);
    const rf = await V.restoreVersion(Cp.id, rv!.id, "Kyle");
    c.ok("…and the upload can be made current again", rf.ok && (await prisma.photoAsset.findUniqueOrThrow({ where: { id: Cp.id } })).contentHash === c1.contentHash, rf.message);

    // ======================================================================
    c.head("7 · Add photos to the gallery by hand");
    const order0 = (await (await import("@/lib/photoDelivery/delivery")).deliveryOrderFor(job.id)).map((o) => o.photoId);
    await prisma.photoJob.update({ where: { id: job.id }, data: { orderJson: JSON.stringify(order0) } });
    const later = await aerial(1600, 1067);
    const tiff = await sharp(await sharp(later).raw().toBuffer(), { raw: { width: 1600, height: 1067, channels: 3 } }).tiff().toBuffer();
    const newA = `${HF.uploadPathPrefix(job.id, "new")}DJI_0042-x1.jpg`, newB = `${HF.uploadPathPrefix(job.id, "new")}Twilight-y2.tif`;
    store.set(newA, later);
    store.set(newB, tiff);
    const add = await F.addPhotosAction({ jobId: job.id, files: [{ pathname: newA, fileName: "DJI_0042.jpg" }, { pathname: newB, fileName: "Twilight.tif" }, { pathname: `${HF.uploadPathPrefix(job.id, Cp.id)}fixed-in-photoshop-a1b2.png`, fileName: "wrong place.png" }] });
    const addedRows = await prisma.photoAsset.findMany({ where: { jobId: job.id, sourceKind: "UPLOAD" }, orderBy: { sequence: "asc" } });
    c.ok("two photos added (a file meant for another photo is not), each ACTIVE, marked UPLOAD, a JPEG", add.ok && /2 photos added/.test(add.message) && /Not added: wrong place\.png/.test(add.message) && addedRows.length === 2 && addedRows.every((r) => r.status === "ACTIVE" && r.format === "jpeg" && PE.isHubEditHash(r.contentHash) && r.inspectedHash === r.contentHash) && addedRows.map((r) => r.name).join() === "DJI_0042.jpg,Twilight.jpg", `${add.message} ${addedRows.map((r) => r.name).join()}`);
    const addedV = await prisma.photoVersion.findMany({ where: { photoId: { in: addedRows.map((r) => r.id) } } });
    c.ok("…each with its file as a hub version \"Added by hand by Kyle\" (all sizes kept)", addedV.length === 2 && addedV.every((v) => v.source === "HUB_EDIT" && v.label === "Added by hand by Kyle" && !!(JSON.parse(v.derivJson ?? "{}") as { sizes?: object }).sizes));
    c.ok("…the hub reads the added file (the TIFF as a JPEG of the same size)", sha(await loadPhotoBytes(addedRows[0])) === sha(later) && (await sharp(await loadPhotoBytes(addedRows[1])).metadata()).format === "jpeg");
    const order1 = (await (await import("@/lib/photoDelivery/delivery")).deliveryOrderFor(job.id)).map((o) => o.photoId);
    c.ok("…at the end of the delivery order (and in it)", order1.length === 5 && order1.slice(0, 3).join() === order0.join() && order1.slice(3).join() === addedRows.map((r) => r.id).join(), order1.join());
    c.ok("…a job event", !!(await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: { startsWith: "2 photos added to the gallery by hand" } } })));
    const viewAdded = (await data.loadJobDetail(job.id, { viewer: kyleViewer }))!.photos.find((p) => p.id === addedRows[0].id)!;
    c.ok("…the page: in the delivery, numbered after the others, no Update on Aryeo asked for", viewAdded.status === "ACTIVE" && viewAdded.position === 4 && viewAdded.sourceKind === "UPLOAD" && viewAdded.hubEdit?.kind === "added" && viewAdded.hubEdit.needsListingUpdate === false, JSON.stringify({ pos: viewAdded.position, hub: viewAdded.hubEdit }));
    // A gallery change on the listing (another image appears): the hand-added photos stay.
    listings.get("L-LOT")!.images.push({ id: "lot-extra", filename: "58 Recreation Dr extra.jpg", index: 9, bytes: BASE });
    await prisma.photoJob.update({ where: { id: job.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(job.id);
    const still = await prisma.photoAsset.findMany({ where: { id: { in: addedRows.map((r) => r.id) } } });
    c.ok("a gallery sync never sets a hand-added photo aside (it is in no source until the hub sends it)", still.every((r) => r.status === "ACTIVE" && r.sourceKind === "UPLOAD"), still.map((r) => r.status).join());
    listings.get("L-LOT")!.images = listings.get("L-LOT")!.images.filter((i) => i.id !== "lot-extra");
    await jobs.syncJobFinals(job.id);
    await prisma.photoAsset.update({ where: { id: addedRows[1].id }, data: { status: "EXCLUDED", excludeReason: "Not this time" } });

    // ======================================================================
    c.head("8 · delivery: Update on Aryeo for the lot lines; the push sends the added photo");
    const settle = async (jobId: string) => {
      for (let i = 0; i < 150; i++) {
        const pr = await P.advancePush(jobId, { budgetMs: 30_000 });
        if (!pr || !pr.active) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const la = listings.get("L-LOT")!;
    const oldImg = la.images.find((i) => i.id === "lot-1")!;
    const aBefore = await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } });
    const upd = await E.updateOnAryeoAction(job.id, [A.id]);
    await settle(job.id);
    const replaced = sorted(la).find((i) => i.filename === oldImg.filename);
    const aAfter = await prisma.photoAsset.findUniqueOrThrow({ where: { id: A.id } });
    const listedV = await prisma.photoVersion.findFirst({ where: { photoId: A.id, source: "HUB_EDIT_LISTED" } });
    c.ok("Update on Aryeo: the lot-lines file replaces the drone photo on the listing, same name, nothing delivered", upd.ok && !!replaced && replaced.id !== "lot-1" && sha(replaced.bytes) === sha(file2) && !calls.some((x) => x.kind === "deliver") && PE.isHubEditHash(aBefore.contentHash), `${upd.message} ${la.images.map((i) => `${i.id}:${i.filename}`).join(", ")}`);
    c.ok("…the photo carried over to its new listing image, and its version still says \"Lot lines\" (the delivery hold's contract)", aAfter.sourceKind === "ARYEO" && aAfter.sourceRef === replaced?.id && listedV?.label === "Lot lines (on the Aryeo listing)", listedV?.label ?? "none");
    // The other two listing photos the hub changed (lot lines on a straighten, an upload) go the same way first:
    // a listing photo edited in the hub is replaced with Update on Aryeo, never sent as a second copy.
    const upd2 = await E.updateOnAryeoAction(job.id, [Bp.id, Cp.id]);
    await settle(job.id);
    const listedB = await prisma.photoVersion.findFirst({ where: { photoId: Bp.id, source: "HUB_EDIT_LISTED" } });
    const listedC = await prisma.photoVersion.findFirst({ where: { photoId: Cp.id, source: "HUB_EDIT_LISTED" } });
    c.ok("…and the upload's listing version reads \"Replaced by upload (on the Aryeo listing)\" (only the trailing name is dropped)", upd2.ok && listedB?.label === "Lot lines (on the Aryeo listing)" && listedC?.label === "Replaced by upload (on the Aryeo listing)" && la.images.length === 3, `${upd2.message} ${listedB?.label} | ${listedC?.label}`);
    // 06-Ready-for-Aryeo and the push.
    const staged = await handoff.stageForAryeo(job.id, { force: true, by: "Kyle", budgetMs: 60_000 });
    const folder = (await handoff.readyFolderFor(job.id))!;
    const inFolder = [...dbx.values()].filter((f) => lower(parentOf(f.path)) === lower(folder));
    const order2 = await (await import("@/lib/photoDelivery/delivery")).deliveryOrderFor(job.id);
    const addedName = order2.find((o) => o.photoId === addedRows[0].id)?.deliveryName ?? "";
    const addedFile = inFolder.find((f) => f.path.endsWith(`/${addedName}`));
    c.ok("06-Ready-for-Aryeo holds the hand-added photo's own file (the left-out one is not there)", staged.ok && !!addedFile && sha(addedFile.bytes) === sha(later) && order2.length === 4 && !order2.some((o) => o.photoId === addedRows[1].id), `${staged.message} ${inFolder.map((f) => f.path.split("/").pop()).join(", ")}`);
    P.__setPushDownloaderForTests(async (path) => {
      const f = dbx.get(lower(path));
      if (!f) throw new Error("not in the folder");
      return f.bytes;
    });
    const uploads0 = calls.filter((x) => x.kind === "upload").length;
    const imgs0 = la.images.length;
    const approved = await P.approveJob(job.id, "Kyle", { deliver: false });
    await settle(job.id);
    const sent = calls.filter((x) => x.kind === "upload").slice(uploads0).map((x) => String(x.body));
    const onListing = la.images.find((i) => i.filename === addedName);
    c.ok("Kyle's approval sends the hand-added photo, once, and nothing already on the listing", approved.ok && sent.length === 1 && sent[0] === addedName && !!onListing && sha(onListing.bytes) === sha(later) && la.images.length === imgs0 + 1, `${approved.message} sent ${sent.join(", ")}`);
    await prisma.photoJob.update({ where: { id: job.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(job.id);
    const carried = await prisma.photoAsset.findUniqueOrThrow({ where: { id: addedRows[0].id } });
    const total = await prisma.photoAsset.count({ where: { jobId: job.id, status: { in: ["ACTIVE", "EXCLUDED"] } } });
    const goneNames = (await prisma.photoAsset.findMany({ where: { jobId: job.id, status: "GONE" }, select: { name: true } })).map((r) => r.name);
    c.ok("the listing sync carries the added photo over to its listing image in place (no second row, still checked)", carried.status === "ACTIVE" && carried.sourceKind === "ARYEO" && carried.sourceRef === onListing?.id && carried.inspectedHash === carried.contentHash && total === 5 && goneNames.join() === "58 Recreation Dr extra.jpg", `${carried.sourceKind} ${carried.sourceRef} total ${total} gone ${goneNames.join()}`);

    // ======================================================================
    c.head("9 · the upload route: a token for one path, owner or Kyle only");
    const upRoute = await import("@/app/api/photo-delivery/photo-upload/route");
    const ask = (pathname: string, payload: Record<string, string>) => upRoute.POST(new NextRequest("http://drill.local/api/photo-delivery/photo-upload", { method: "POST", body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }) }));
    await signIn(kyle);
    const noStore = await ask(`${HF.uploadPathPrefix(job.id, "new")}a.jpg`, { jobId: job.id, target: "new" });
    c.ok("no private store: refused, never the public one", noStore.status === 400 && /private photo storage/.test(((await noStore.json()) as { error: string }).error));
    process.env.PHOTO_QC_BLOB_TOKEN = "vercel_blob_rw_drillstore_drillsecretdrillsecret";
    const okNew = await ask(`${HF.uploadPathPrefix(job.id, "new")}a.heic`, { jobId: job.id, target: "new" });
    const okPhoto = await ask(`${HF.uploadPathPrefix(job.id, Bp.id)}fix.tif`, { jobId: job.id, target: Bp.id });
    const wrongPath = await ask(`${HF.uploadPathPrefix(job.id, A.id)}fix.jpg`, { jobId: job.id, target: Bp.id });
    const badType = await ask(`${HF.uploadPathPrefix(job.id, "new")}a.gif`, { jobId: job.id, target: "new" });
    const otherJob = await ask(`${HF.uploadPathPrefix(job.id, Z.id)}a.jpg`, { jobId: job.id, target: Z.id });
    c.ok("a new photo's path and this photo's path get a token; another photo's path, a GIF, a photo of another job do not", okNew.status === 200 && okPhoto.status === 200 && wrongPath.status === 400 && badType.status === 400 && otherJob.status === 400, `${okNew.status} ${okPhoto.status} ${wrongPath.status} ${badType.status} ${otherJob.status}`);
    await signIn(james);
    c.ok("the creative manager: refused", (await ask(`${HF.uploadPathPrefix(job.id, "new")}a.jpg`, { jobId: job.id, target: "new" })).status === 400);
    const { SESSION_COOKIE } = await import("@/lib/auth/jwt");
    next.cookies.delete(SESSION_COOKIE);
    c.ok("signed out: refused", (await ask(`${HF.uploadPathPrefix(job.id, "new")}a.jpg`, { jobId: job.id, target: "new" })).status === 400);
    delete process.env.PHOTO_QC_BLOB_TOKEN;

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
main().catch((e) => { console.error(e); process.exit(1); });

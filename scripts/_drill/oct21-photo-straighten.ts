// ---------------------------------------------------------------------------
// DRILL: the hub's own photo fixer (Oct 21 2026): straighten, keystone, crop.
//
// Jordan: "Kyle needs a quick and easy way to fix image perspective, and
// cropping, etc." AutoHDR's API has no exact geometry tool, so the hub does it
// (lib/photoDelivery/straighten.ts + photoEdit.ts + the editor).
//   1. The math, pure: identity is an exact copy; positive turns clockwise; a
//      keystone makes lines through the vanishing point vertical; the auto
//      crop leaves no empty corner and is the largest that does; the saved
//      file keeps the original's long edge; finding boxes follow the picture;
//      on a synthetic photo the measured lines say crooked, Auto recovers the
//      turn and keystone, and the corrected render measures straight; the
//      server's render keeps EXIF orientation right.
//   2. Saving: what the browser renders and uploads (the upload stubbed in
//      the fake private store) becomes the photo's current version (a
//      HUB_EDIT row, the photo's hash, its sizes kept, the image route and
//      every reader take it); a stale editor, a stray upload and a file that
//      is not what the settings make are refused; the geometry finding Kyle
//      ticked is FIXED with the line check run again; boxes move; the job
//      goes Ready; AutoHDR showing the same version changes nothing.
//   3. Restore: back to the photo's own file (no AutoHDR call), the finding
//      open again and its box back; the hub edit restored, fixed again.
//   4. Before delivery: 06-Ready-for-Aryeo and the hub's upload carry the
//      EDITED file.
//   5. After delivery: the server's render (a phone that cannot hold the
//      photo) saves the same way; nothing goes to Aryeo by itself; Kyle's
//      press of Update on Aryeo replaces just that image, same name and
//      place, nothing delivered again; the job's run comes back as it was;
//      the photo carries over to its new listing image.
//   6. A photo that lives on the listing (AutoHDR's Aryeo link): the sync
//      keeps the hub edit while the listing still has the file it came from;
//      Update on Aryeo finds the image by its own id.
//   7. An AI re-edit in Kyle's words: the price he saw or nothing, a one-line
//      fix batch through the usual approval, nothing sent to AutoHDR here.
//   8. AutoHDR's own change (its editor) wins over the hub's edit.
//   9. The upload route: a token for one path, owner or Kyle only.
// ISOLATION: PGlite via the shared harness; AutoHDR, Aryeo (web, Uploadcare,
// API, CDN), Dropbox and the private store answered in-process.
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { createHash } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

const next = installNextStubs();
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const lower = (s: string) => s.toLowerCase();
let n = 0;
const nid = (p: string) => `${p}-${String(++n).padStart(4, "0")}`;

// The photo every fake serves: a synthetic room whose verticals lean (built in main).
let BASE: Buffer = Buffer.alloc(0);
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }], balance: 100, clientId: "cid", clientSecret: "drill-secret-1234567890", imageBytes: () => new Uint8Array(BASE) });

// ---- Dropbox (the 06-Ready-for-Aryeo copy), keeping the bytes ------------------------------------
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

// ---- Aryeo: the web app (sign-in, listing editor), Uploadcare, the public API and the CDN -------
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
      // Aryeo files new photos at the FRONT (the hub has to put them back in order).
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

const fence = fenceFetch(async (url, init) => (await fake.handle(url, init)) ?? dropbox(url, init) ?? (await aryeo(url, init)) ?? (await uploadcare(url, init)) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

/** A W × H white room with dark vertical edges where the CORRECTED frame has them, drawn through the inverse of `p` (so `p` straightens it). */
async function leaningRoom(W: number, H: number, p: { rotate: number; keystone: number }): Promise<{ raw: Buffer; jpeg: Buffer }> {
  const S = await import("@/lib/photoDelivery/straighten");
  // Drawn at twice the size and scaled down, so the edges are smooth like a lens makes them (a hard pixel staircase is not a wall).
  const W2 = W * 2, H2 = H * 2;
  const fwd = S.forwardMatrix(p.rotate, p.keystone, W2, H2);
  const big = Buffer.alloc(W2 * H2 * 3, 235);
  const bars = Array.from({ length: 14 }, (_, i) => W2 * (0.06 + (0.88 * i) / 13));
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const f = S.apply3(fwd, x + 0.5, y + 0.5);
      if (f.y < H2 * 0.08 || f.y > H2 * 0.92) continue;
      if (bars.some((b) => Math.abs(f.x - b) < 6)) big.fill(30, (y * W2 + x) * 3, (y * W2 + x) * 3 + 3);
    }
  }
  const raw = await sharp(big, { raw: { width: W2, height: H2, channels: 3 } }).resize(W, H).raw().toBuffer();
  return { raw, jpeg: await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer() };
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7131), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s", AUTH_ENFORCE: "true", APP_SECRET: "isolated-straighten" } });
  const c = makeChecker();
  try {
    const S = await import("@/lib/photoDelivery/straighten");
    const cv = await import("@/lib/photoDelivery/qc/cv");
    const PE = await import("@/lib/photoDelivery/photoEdit");

    // ======================================================================
    c.head("1 · the math");
    const W = 1200, H = 800;
    const id = S.forwardMatrix(0, 0, W, H);
    c.ok("no turn, no keystone: the identity", id.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-12));
    const tiny = { data: new Uint8Array(Array.from({ length: 6 * 4 * 3 }, (_, i) => (i * 37) % 256)), width: 6, height: 4, channels: 3 as const };
    const same = S.renderStraightened(tiny, S.cleanParams({}));
    c.ok("…and its render is an exact copy, same size", same.width === 6 && same.height === 4 && Buffer.from(same.data).equals(Buffer.from(tiny.data)));
    const turned = S.apply3(S.forwardMatrix(5, 0, W, H), W, H / 2);
    c.ok("a positive turn is clockwise (the right edge's middle goes down)", turned.y > H / 2 + 50 && turned.x < W, JSON.stringify(turned));
    const m = S.forwardMatrix(-3.7, 42, W, H);
    const back = S.apply3(S.invert3(m), ...(Object.values(S.apply3(m, 123.4, 567.8)) as [number, number]));
    c.ok("forward then inverse is where it started", Math.hypot(back.x - 123.4, back.y - 567.8) < 1e-6, JSON.stringify(back));
    // Lines through the keystone's vanishing point become vertical.
    const K = 40, p = S.keystoneP(K, W);
    const Yv = -1 / p;
    const kc = S.forwardCentered(0, K, W);
    const vertical = [-500, -200, 150, 480].every((X0) => {
      const at = (Y: number) => S.apply3(kc, (X0 * (Y - Yv)) / -Yv, Y);
      return Math.abs(at(-380).x - at(380).x) < 1e-6;
    });
    c.ok("a keystone makes lines that meet above the photo vertical", vertical);
    const edge = (Math.atan(p * (W / 2)) * 180) / Math.PI;
    c.ok("keystone 40 takes out 4.0° of lean at the frame's edge", Math.abs(edge - 4) < 1e-9, edge.toFixed(6));

    // The automatic crop: no empty corner, the largest that has none, centred, the shape kept.
    const noEmpty = (rot: number, ks: number, crop: { x: number; y: number; w: number; h: number }) => {
      const inv = S.invert3(S.forwardMatrix(rot, ks, W, H));
      return [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x + crop.w, crop.y + crop.h], [crop.x, crop.y + crop.h]].every(([fx, fy]) => {
        const s = S.apply3(inv, fx * W, fy * H);
        return s.x >= -0.01 && s.y >= -0.01 && s.x <= W + 0.01 && s.y <= H + 0.01;
      });
    };
    const cases: [number, number][] = [[5, 0], [-7.3, 0], [0, 60], [0, -45], [2.5, 35], [-10, 100]];
    c.ok("every automatic crop has no empty corner (its corners map back inside the photo)", cases.every(([r, k]) => noEmpty(r, k, S.autoCrop(r, k, W, H, "original"))));
    const ac = S.autoCrop(5, 0, W, H, "original");
    const grown = { x: ac.x - ac.w * 0.005, y: ac.y - ac.h * 0.005, w: ac.w * 1.01, h: ac.h * 1.01 };
    c.ok("…and is the largest: 1% bigger shows an empty corner", !S.cropFits(5, 0, W, H, grown) && S.cropFits(5, 0, W, H, ac));
    c.ok("…a pure turn crops about the centre, the photo's own shape", Math.abs(ac.x + ac.w / 2 - 0.5) < 0.005 && Math.abs(ac.y + ac.h / 2 - 0.5) < 0.005 && Math.abs((ac.w * W) / (ac.h * H) - W / H) < 1e-3, JSON.stringify(ac));
    const portrait = S.autoCrop(0, 0, 800, 1200, "3:2");
    c.ok("3:2 on a portrait photo is 2:3", Math.abs((portrait.w * 800) / (portrait.h * 1200) - 2 / 3) < 1e-3, JSON.stringify(portrait));
    const size5 = S.outputSize(W, H, ac);
    c.ok("the saved file keeps the original's size for a 5° turn (gallery stays one size)", size5.width === W && Math.abs(size5.height - H) <= 1, JSON.stringify(size5));
    const tight = S.outputSize(W, H, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    c.ok("…a very tight crop is enlarged at most 1.35×", tight.width === Math.round(600 * 1.35) && Math.abs(tight.scale - 1.35) < 1e-9, JSON.stringify(tight));
    const P0 = S.cleanParams({ rotate: 2.5, keystone: 35, crop: S.autoCrop(2.5, 35, W, H, "original"), aspect: "original" });
    const box: [number, number, number, number] = [500, 300, 640, 420];
    const moved = S.boxToEdited(box, P0, W, H)!;
    const home = S.boxToSource(moved, P0, W, H)!;
    c.ok("a finding's box follows the picture and comes back", !!moved && moved.join() !== box.join() && home.every((v, i) => Math.abs(v - box[i]) <= 12), `${moved} → ${home}`);
    c.ok("the version is named for what was done", S.editLabel(S.cleanParams({ rotate: -2.34, keystone: 12, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, aspect: "3:2" }), "Kyle") === "Straightened 2.3°, keystone 12, cropped 3:2 by Kyle");

    // A synthetic room whose verticals lean: measured crooked; Auto recovers the turn and keystone; corrected, it measures straight.
    const room = await leaningRoom(W, H, P0);
    BASE = room.jpeg;
    const lumaOfRaw = (raw: Uint8Array | Uint8ClampedArray, w: number, h: number) => cv.lumaOf(raw as Uint8Array, w * h);
    const g0 = cv.lineGeometry(lumaOfRaw(room.raw, W, H), W, H);
    c.ok("the leaning room measures crooked", g0.crooked && (g0.tiltDeg ?? 0) > 1.5, cv.geometryWords(g0));
    const fits = cv.verticalLineFits(lumaOfRaw(room.raw, W, H), W, H);
    const solved = S.solveLean(fits.map((f) => S.leanLineOf(f, H)), W);
    c.ok("Auto: the measured lines give back the turn and the keystone", Math.abs(solved.rotate - 2.5) <= 0.3 && Math.abs(solved.keystone - 35) <= 4, JSON.stringify(solved));
    const fixed = S.renderStraightened({ data: room.raw, width: W, height: H, channels: 3 }, S.cleanParams({ rotate: solved.rotate, keystone: solved.keystone, crop: S.autoCrop(solved.rotate, solved.keystone, W, H, "original"), aspect: "original" }));
    const g1 = cv.lineGeometry(lumaOfRaw(fixed.data, fixed.width, fixed.height), fixed.width, fixed.height);
    c.ok("…and the corrected render measures straight", !g1.crooked && (g1.tiltDeg ?? 9) < 0.6 && g1.verticalLines >= 8, cv.geometryWords(g1));

    // EXIF orientation: the server's render works on the picture as it is shown.
    const ow = 300, oh = 200;
    const oraw = Buffer.alloc(ow * oh * 3, 255);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) oraw.set([220, 20, 20], (y * ow + x) * 3);
    const oriented = await sharp(oraw, { raw: { width: ow, height: oh, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    const rendered = await PE.renderBytes(oriented, S.cleanParams({}));
    const rmeta = await sharp(rendered.bytes).metadata();
    const rpx = await sharp(rendered.bytes).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => rpx.data[(y * rpx.info.width + x) * rpx.info.channels];
    c.ok("an EXIF-turned photo comes out upright: shown size, the red corner where it is shown, no orientation tag left", rendered.width === 200 && rendered.height === 300 && rendered.baseWidth === 200 && (rmeta.orientation ?? 1) === 1 && at(180, 20) > 180 && at(20, 20) > 200 && rpx.data[(20 * rpx.info.width + 20) * 3 + 1] > 200, `${rendered.width}x${rendered.height} o=${rmeta.orientation} tr=${at(180, 20)}`);

    // ======================================================================
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const { setSession } = await import("@/lib/auth/session");
    const B = await import("@/lib/photoDelivery/blob");
    const V = await import("@/lib/photoDelivery/versions");
    const P = await import("@/lib/photoDelivery/aryeoPush");
    const handoff = await import("@/lib/photoDelivery/handoff");
    const actions = await import("@/app/ops/photo-delivery/editActions");
    const data = await import("@/app/ops/photo-delivery/data");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    const W2 = await import("@/lib/integrations/aryeoWeb");
    await saveSecret(W2.ARYEO_WEB_PROVIDER, LOGIN.password, { accountLabel: LOGIN.email, metadata: { email: LOGIN.email } });
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, showAutohdrPhotos: true, fixRunnerEnabled: true, aryeoPush: "on", qcShadow: true }, "drill");
    const store = new Map<string, Buffer>();
    B.__setDerivativeStoreForTests({
      async put(pathname, bytes) { store.set(pathname, Buffer.from(bytes)); return { pathname, url: `https://drill-store.private.blob.vercel-storage.invalid/${pathname}` }; },
      async read(ref) { const b = store.get(ref.pathname); return b ? { stream: new Blob([new Uint8Array(b)]).stream(), size: b.length, contentType: "image/jpeg" } : null; },
    });
    // A press answers at once and moves the run on after its answer (in a drill: alongside). Wait for that pass, moving it on too.
    const settle = async (jobId: string) => {
      for (let i = 0; i < 150; i++) {
        const pr = await P.advancePush(jobId, { budgetMs: 30_000 });
        if (!pr || !pr.active) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const kyle = await prisma.appUser.create({ data: { email: "kyle@straighten.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });
    const viewer = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };

    // A hub shoot in review: 3 AutoHDR photos (bought), one with leaning verticals and a dust spot.
    const client = await prisma.client.create({ data: { name: "Straighten Drill Client" } });
    const project = await prisma.project.create({ data: { title: "21 Plumb Line Rd, Reading, PA", addressLine: "21 Plumb Line Rd", clientId: client.id, aryeoListingId: "L-A", shootDate: new Date("2026-10-20T14:00:00Z") } });
    const shoot = fake.seedShoot({ address: "21 Plumb Line Rd", photos: ["front.jpg", "living.jpg", "kitchen.jpg"].map((name) => ({ name, downloaded: true })) });
    await prisma.photoIntakeBatch.create({ data: { projectId: project.id, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: "[]", fileCount: 3, fingerprint: "f", photoshootId: shoot.photoshoot_id, photosJson: JSON.stringify(shoot.photos.map((ph) => ({ image_uuid: ph.image_uuid, image_version_uuid: ph.head, name: ph.name, downloaded: true, url: null }))) } as never });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date() } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    const groups = [["EXTERIOR_FRONT", "FRONT_EXTERIOR"], ["LIVING", "MAIN_LIVING"], ["KITCHEN", "KITCHEN"]];
    const photos = [];
    for (let i = 0; i < 3; i++) {
      const ph = shoot.photos[i];
      const hash = V.hashOfVersion(ph.head);
      const row = await prisma.photoAsset.create({ data: { jobId: job.id, name: ph.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph.image_uuid}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: hash, inspectedHash: hash, classifiedHash: hash, width: W, height: H, sequence: i, status: "ACTIVE", roomType: groups[i][0], sequenceGroup: groups[i][1] } });
      await prisma.photoVersion.create({ data: { photoId: row.id, label: "AutoHDR edit", source: "AUTOHDR_INITIAL", autohdrVersionUuid: ph.head, contentHash: hash } });
      photos.push(row);
    }
    const ph0 = photos[0];
    const crooked = await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: ph0.id, ruleId: "PERSP_CROOKED_VERTICALS", groupKey: "VERTICALS", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Measured: verticals lean 7.0°", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "EDITOR_MANUAL", status: "OPEN", arbitration: "CONFIRMED", contentHash: ph0.contentHash } });
    const dust = await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: ph0.id, ruleId: "REFL_SENSOR_DUST", groupKey: "DUST", pass: "P1_PHOTO", source: "AHDR", specificIssue: "A dust spot", explanation: "x", severity: "MINOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", status: "OPEN", arbitration: "CONFIRMED", contentHash: ph0.contentHash, bboxJson: JSON.stringify(box) } });

    // ======================================================================
    c.head("2 · Save makes the edit the photo's current version");
    const measured = await actions.measureStraightenAction(job.id, ph0.id);
    c.ok("Auto measures the photo's own file (free) and suggests the turn and keystone", measured.ok && Math.abs(measured.rotate - 2.5) <= 0.4 && Math.abs(measured.keystone - 35) <= 5, JSON.stringify(measured));
    const srcRoute = await import("@/app/api/photo-delivery/edit-source/[photoId]/route");
    const { NextRequest } = await import("next/server");
    const get = (photoId: string, size: string) => srcRoute.GET(new NextRequest(`http://drill.local/api/photo-delivery/edit-source/${photoId}?size=${size}`), { params: Promise.resolve({ photoId }) });
    const prev = await get(ph0.id, "preview");
    const prevMeta = prev.status === 200 ? await sharp(Buffer.from(await prev.arrayBuffer())).metadata() : null;
    c.ok("the editor's preview: the photo's own file, at most 2048 px, never cached by a shared cache", prev.status === 200 && (prevMeta?.width ?? 0) === W && /private/.test(prev.headers.get("cache-control") ?? ""), `${prev.status} ${prevMeta?.width}`);
    const full = await get(ph0.id, "full");
    const fullBytes = Buffer.from(await full.arrayBuffer());
    c.ok("…and for Save the full-size file, exactly as it is", full.status === 200 && sha(fullBytes) === sha(BASE) && full.headers.get("cache-control") === "private, no-store", `${full.status}`);

    // What the browser does: render the full file at full size (RGBA canvas), encode, upload to the private store (stubbed here).
    const params = S.cleanParams({ rotate: measured.rotate, keystone: measured.keystone, crop: S.autoCrop(measured.rotate, measured.keystone, W, H, "original"), aspect: "original" });
    const rgba = await sharp(fullBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = S.renderStraightened({ data: rgba.data, width: rgba.info.width, height: rgba.info.height, channels: 4 }, params);
    const edited = await sharp(Buffer.from(out.data), { raw: { width: out.width, height: out.height, channels: 4 } }).removeAlpha().jpeg({ quality: 93 }).toBuffer();
    const upPath = `${PE.editUploadPrefix(job.id, ph0.id)}edit-a1b2c3.jpg`;
    store.set(upPath, edited);
    const baseHash = ph0.contentHash;
    const save = (over: Partial<Parameters<typeof actions.saveStraightenAction>[0]> = {}) =>
      actions.saveStraightenAction({ jobId: job.id, photoId: ph0.id, baseHash, baseSize: { width: W, height: H }, params, fixFindingIds: [crooked.id, dust.id], stored: { pathname: upPath }, ...over });
    const stale = await save({ baseHash: "an-older-version" });
    c.ok("an editor opened on an older version is refused (nothing overwritten)", !stale.ok && /changed while it was open/.test(stale.message), stale.message);
    const other = `${PE.editUploadPrefix(job.id, photos[1].id)}edit.jpg`;
    store.set(other, edited);
    const stray = await save({ stored: { pathname: other } });
    c.ok("an upload under another photo's path is refused", !stray.ok && /not this photo's/.test(stray.message), stray.message);
    const wrongSize = await save({ params: S.cleanParams({ ...params, crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } }) });
    c.ok("a file that is not what these settings make is refused", !wrongSize.ok && /not the/.test(wrongSize.message), wrongSize.message);
    const saved = await save();
    c.ok("Save: the edit is saved", saved.ok && /current version/.test(saved.message), saved.message);
    const p1 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph0.id } });
    const hubRow = await prisma.photoVersion.findFirstOrThrow({ where: { photoId: ph0.id, source: "HUB_EDIT" } });
    const hm = PE.hubMeta(hubRow.derivJson);
    c.ok("a HUB_EDIT version: named for the edit and the person, the file and its 2048 copy kept privately, the settings and what it came from", /^Straightened 2\.\d°, keystone \d+, cropped by Kyle$/.test(hubRow.label) && !!hm.file && store.has(hm.file.pathname) && !!hm.preview && hm.hub?.base.sourceHash === baseHash && hm.hub.base.autohdrVersionUuid === shoot.photos[0].head && hm.hub.params.keystone === params.keystone, `${hubRow.label} ${JSON.stringify(hm.hub?.base)}`);
    c.ok("the photo IS the edit: its hash (the image's key), no AutoHDR version, the new size, every page size kept", p1.contentHash === hubRow.contentHash && PE.isHubEditHash(p1.contentHash) && p1.autohdrVersionUuid === null && p1.width === out.width && p1.height === out.height && p1.derivHash === p1.contentHash && Object.keys(JSON.parse(p1.derivJson ?? "{}")).length === 4, `${p1.contentHash} ${p1.width}x${p1.height}`);
    c.ok("…and stays inspected (delivery is not held for a re-check of its own edit)", p1.inspectedHash === p1.contentHash && p1.classifiedHash === p1.contentHash);
    const fc = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: crooked.id } });
    c.ok("the geometry finding Kyle ticked is FIXED, with the line check run again on the saved file", fc.status === "FIXED" && fc.decidedBy === "Kyle" && /^Straightened in the hub by Kyle/.test(fc.statusReason ?? "") && /Measured after: .*leaning 0\.\d° on average/.test(fc.statusReason ?? "") && hm.hub?.measured?.crooked === false, fc.statusReason ?? "");
    const fd = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: dust.id } });
    const expectBox = S.boxToEdited(box, params, W, H)!;
    c.ok("a finding the edit cannot settle stays open (a dust spot), its box moved onto the new picture", fd.status === "OPEN" && fd.bboxJson === JSON.stringify(expectBox) && fd.contentHash === p1.contentHash, `${fd.status} ${fd.bboxJson}`);
    const jobAfter = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("nothing major left: the job moves to Ready", jobAfter.stage === "READY", jobAfter.stage);
    const { loadPhotoBytes } = await import("@/lib/photoDelivery/qc/source");
    c.ok("every reader of the photo's file gets the edit (the QC, the image route's renders)", sha(await loadPhotoBytes(p1)) === sha(edited));
    const imgRoute = await import("@/app/api/photo-delivery/img/[photoId]/[size]/route");
    const shown = await imgRoute.GET(new NextRequest(`http://drill.local/api/photo-delivery/img/${ph0.id}/qc2048?v=${p1.contentHash}`), { params: Promise.resolve({ photoId: ph0.id, size: "qc2048" }) });
    const shownMeta = shown.status === 200 ? await sharp(Buffer.from(await shown.arrayBuffer())).metadata() : null;
    c.ok("the lightbox shows the edit straight from the kept sizes", shown.status === 200 && shownMeta?.width === out.width && shown.headers.get("cache-control") === "private, max-age=3600", `${shown.status} ${shownMeta?.width} ${shown.headers.get("cache-control")}`);
    const view1 = (await data.loadJobDetail(job.id, { viewer }))!.photos.find((x) => x.id === ph0.id)!;
    c.ok("the page: the edit is the one current version, the AutoHDR edit restorable, no listing update needed before delivery", view1.versions.filter((v) => v.current).length === 1 && view1.versions.find((v) => v.current)?.id === hubRow.id && view1.versions.find((v) => v.source === "AUTOHDR_INITIAL")?.restorable === true && view1.hubEdit?.versionId === hubRow.id && view1.hubEdit.needsListingUpdate === false, JSON.stringify(view1.versions.map((v) => [v.label, v.current, v.restorable])));
    const sync0 = await V.syncHeads(job.id, { by: "drill" });
    c.ok("AutoHDR still shows the version the edit came from: the head check changes nothing", sync0.changed.length === 0 && (await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph0.id } })).contentHash === p1.contentHash, JSON.stringify(sync0));

    // ======================================================================
    c.head("3 · Restore, both ways");
    const baseRow = await prisma.photoVersion.findFirstOrThrow({ where: { photoId: ph0.id, source: "AUTOHDR_INITIAL" } });
    const setVersionCalls = () => fake.state.calls.filter((x) => x.method === "POST" && /\/version$/.test(x.path)).length;
    const sv0 = setVersionCalls();
    const r1 = await V.restoreVersion(ph0.id, baseRow.id, "Kyle");
    const p2 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph0.id } });
    c.ok("Restore the AutoHDR edit: the photo's own file again, nothing asked of AutoHDR (it still has it)", r1.ok && p2.contentHash === baseHash && p2.autohdrVersionUuid === shoot.photos[0].head && p2.width === W && setVersionCalls() === sv0, `${r1.message} ${p2.contentHash}`);
    const fc2 = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: crooked.id } });
    const fd2 = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: dust.id } });
    c.ok("…the finding the edit fixed is open again, the box is back where it was", fc2.status === "OPEN" && (JSON.parse(fd2.bboxJson!) as number[]).every((v, i) => Math.abs(v - box[i]) <= 12) && fd2.contentHash === baseHash, `${fc2.status} ${fd2.bboxJson}`);
    c.ok("…and the job is back in review (a major issue is open again)", (await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } })).stage === "QC_REVIEW");
    const r2 = await V.restoreVersion(ph0.id, hubRow.id, "Kyle");
    const p3 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph0.id } });
    c.ok("Restore the hub edit: current again, the finding fixed again, the job Ready", r2.ok && p3.contentHash === hubRow.contentHash && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: crooked.id } })).status === "FIXED" && (await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } })).stage === "READY", r2.message);

    // ======================================================================
    c.head("4 · before delivery: the edited file is what goes out");
    const staged = await handoff.stageForAryeo(job.id, { force: true, by: "Kyle", budgetMs: 60_000 });
    const folder = (await handoff.readyFolderFor(job.id))!;
    const inFolder = [...dbx.values()].filter((f) => lower(parentOf(f.path)) === lower(folder));
    const order = await (await import("@/lib/photoDelivery/delivery")).deliveryOrderFor(job.id);
    const nameOf = (photoId: string) => order.find((o) => o.photoId === photoId)!.deliveryName;
    const fileOf = (name: string) => inFolder.find((f) => f.path.endsWith(`/${name}`));
    c.ok("06-Ready-for-Aryeo holds the edited file for the straightened photo, AutoHDR's for the others", staged.ok && inFolder.length === 3 && sha(fileOf(nameOf(ph0.id))!.bytes) === sha(edited) && sha(fileOf(nameOf(photos[1].id))!.bytes) === sha(BASE), `${staged.message} ${inFolder.map((f) => f.path.split("/").pop()).join(", ")}`);
    P.__setPushDownloaderForTests(async (path) => {
      const f = dbx.get(lower(path));
      if (!f) throw new Error("not in the folder");
      return f.bytes;
    });
    listings.set("L-A", { id: "L-A", delivery: "UNDELIVERED", images: [] });
    const approved = await P.approveJob(job.id, "Kyle", { deliver: false });
    for (let i = 0; i < 10; i++) await P.advancePush(job.id, { budgetMs: 30_000 });
    const la = listings.get("L-A")!;
    const onListing = la.images.find((i) => i.filename === nameOf(ph0.id));
    c.ok("Kyle's approval puts the EDITED file on the Aryeo listing", approved.ok && la.images.length === 3 && !!onListing && sha(onListing.bytes) === sha(edited), approved.message);

    // ======================================================================
    c.head("5 · after delivery: Update on Aryeo, a person's press");
    const KEY = `photo_aryeo_push:${job.id}`;
    const runRow = await prisma.appSetting.findUniqueOrThrow({ where: { key: KEY } });
    const delivered = { ...JSON.parse(runRow.value), state: "DONE", then: "deliver", deliveredAt: new Date().toISOString(), finishedAt: new Date().toISOString(), lease: null };
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(delivered) } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "DELIVERED", deliveredAt: new Date() } });
    la.delivery = "DELIVERED";
    const ph1 = photos[1];
    // The phone path: this device cannot hold the photo, so the server renders it with the same math.
    const crop43 = S.cleanParams({ rotate: 0, keystone: 0, crop: S.autoCrop(0, 0, W, H, "4:3"), aspect: "4:3" });
    const srv = await actions.renderStraightenOnServerAction({ jobId: job.id, photoId: ph1.id, baseHash: ph1.contentHash, params: crop43, fixFindingIds: [] });
    const ph1a = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph1.id } });
    const hub1 = await PE.currentHubEdit(ph1a);
    const hub1Bytes = await PE.hubEditBytes(ph1a);
    const hub1Meta = hub1Bytes ? await sharp(hub1Bytes).metadata() : null;
    c.ok("the server's render saves the same way: a 4:3 crop at the original's long edge", srv.ok && /Update on Aryeo/.test(srv.message) && !!hub1 && hub1Meta?.width === W && Math.abs(W / (hub1Meta?.height ?? 1) - 4 / 3) < 0.01, `${srv.message} ${hub1Meta?.width}x${hub1Meta?.height}`);
    const view2 = (await data.loadJobDetail(job.id, { viewer }))!.photos.find((x) => x.id === ph1.id)!;
    c.ok("the page offers Update on Aryeo (delivered: the listing has the old file), with a download", view2.hubEdit?.needsListingUpdate === true && view2.hubEdit.downloadUrl === `/api/photo-fixes/${hub1!.id}`);
    const uploads0 = calls.filter((x) => x.kind === "upload").length;
    await P.drivePushes({ budgetMs: 30_000 });
    c.ok("nothing goes to Aryeo by itself: the cron sends nothing", calls.filter((x) => x.kind === "upload").length === uploads0 && (await P.pushProgress(job.id))?.state === "DONE");
    const before = sorted(la).map((i) => `${i.id}:${i.filename}`);
    const oldImg = la.images.find((i) => i.filename === nameOf(ph1.id));
    if (!c.ok("the photo is on the delivered listing under its delivery name", !!oldImg, `${nameOf(ph1.id)} in ${la.images.map((i) => i.filename).join(", ")}`)) throw new Error("stop");
    const oldId = oldImg!.id;
    const press = await actions.updateOnAryeoAction(job.id, [ph1.id]);
    await settle(job.id);
    const after = sorted(la);
    const replaced = after.find((i) => i.filename === nameOf(ph1.id))!;
    c.ok("Kyle presses Update on Aryeo: the edited file goes up under the same name", press.ok && /Nothing is delivered again/.test(press.message) && replaced.id !== oldId && sha(replaced.bytes) === sha(hub1Bytes!) && calls.filter((x) => x.kind === "upload").length === uploads0 + 1, press.message);
    c.ok("…the old one is gone, the listing keeps its order and its other photos", !after.some((i) => i.id === oldId) && after.map((i) => i.filename).join() === before.map((s) => s.split(":")[1]).join() && after.filter((i) => i.id !== replaced.id).map((i) => `${i.id}:${i.filename}`).join() === before.filter((s) => !s.startsWith(`${oldId}:`)).join(), after.map((i) => `${i.id}:${i.filename}`).join(", "));
    c.ok("…nothing delivered again", !calls.some((x) => x.kind === "deliver"));
    const restoredRun = await P.pushProgress(job.id);
    c.ok("…and the job's run is back exactly as it was (the Deliver panel unchanged)", restoredRun?.state === "DONE" && restoredRun.deliveredAt === delivered.deliveredAt && !restoredRun.update, JSON.stringify(restoredRun));
    const lastUp = await P.lastListingUpdate(job.id);
    const ph1b = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph1.id } });
    c.ok("the update is on record; the photo carried over to its new listing image (no button left)", !!lastUp?.ok && lastUp.photoIds.includes(ph1.id) && ph1b.sourceKind === "ARYEO" && ph1b.sourceRef === replaced.id && !PE.isHubEditHash(ph1b.contentHash), JSON.stringify(lastUp));
    const view3 = (await data.loadJobDetail(job.id, { viewer }))!.photos.find((x) => x.id === ph1.id)!;
    c.ok("…the page shows the edit on the listing as the current version", !view3.hubEdit && view3.versions.find((v) => v.current)?.source === "HUB_EDIT_LISTED", JSON.stringify(view3.versions.map((v) => [v.label, v.current])));
    const sync1 = await V.syncHeads(job.id, { by: "drill" });
    c.ok("…and AutoHDR's unchanged version is not taken for a change", !sync1.changed.some((x) => x.photoId === ph1.id), JSON.stringify(sync1));

    // ======================================================================
    c.head("6 · a photo that lives on the listing (AutoHDR's Aryeo link)");
    const projB = await prisma.project.create({ data: { title: "6 Listing Ln, Reading, PA", addressLine: "6 Listing Ln", clientId: client.id, aryeoListingId: "L-B" } });
    listings.set("L-B", { id: "L-B", delivery: "UNDELIVERED", images: [{ id: "lb-1", filename: "6 Listing Ln (1 of 2).jpg", index: 0, bytes: BASE }, { id: "lb-2", filename: "6 Listing Ln (2 of 2).jpg", index: 1, bytes: BASE }] });
    const jobB = await prisma.photoJob.create({ data: { projectId: projB.id, stage: "READY" } });
    const jobs = await import("@/lib/photoDelivery/jobs");
    await jobs.syncJobFinals(jobB.id);
    const bPhotos = await prisma.photoAsset.findMany({ where: { jobId: jobB.id }, orderBy: { sequence: "asc" } });
    const b0 = bPhotos[0];
    const bOut = await PE.renderBytes(BASE, S.cleanParams({ rotate: -1.5, keystone: 0, crop: S.autoCrop(-1.5, 0, W, H, "original"), aspect: "original" }));
    const bSave = await PE.saveHubEdit({ jobId: jobB.id, photoId: b0.id, baseHash: b0.contentHash, baseSize: { width: bOut.baseWidth, height: bOut.baseHeight }, params: { rotate: -1.5, keystone: 0, crop: S.autoCrop(-1.5, 0, W, H, "original"), aspect: "original" }, by: "Kyle", bytes: bOut.bytes });
    c.ok("an Aryeo photo saves the same way, and asks for Update on Aryeo", bSave.ok && /Update on Aryeo/.test(bSave.message), bSave.message);
    listings.get("L-B")!.images.push({ id: "lb-3", filename: "6 Listing Ln (extra).jpg", index: 2, bytes: BASE });
    await prisma.photoJob.update({ where: { id: jobB.id }, data: { nextCheckAt: new Date() } });
    await jobs.syncJobFinals(jobB.id);
    const b0a = await prisma.photoAsset.findUniqueOrThrow({ where: { id: b0.id } });
    c.ok("the listing sync keeps the edit while the listing still has the file it came from (no 'Replaced' version)", PE.isHubEditHash(b0a.contentHash) && (await prisma.photoVersion.count({ where: { photoId: b0.id, label: "Replaced" } })) === 0, b0a.contentHash ?? "");
    const pressB = await actions.updateOnAryeoAction(jobB.id, [b0.id]);
    await settle(jobB.id);
    const lb = sorted(listings.get("L-B")!);
    c.ok("Update on Aryeo finds the photo by its own listing image: replaced in place, the others untouched", pressB.ok && lb.length === 3 && lb[0].filename === "6 Listing Ln (1 of 2).jpg" && lb[0].id !== "lb-1" && sha(lb[0].bytes) === sha(bOut.bytes) && lb[1].id === "lb-2" && lb[2].id === "lb-3" && !(await P.pushProgress(jobB.id)), `${pressB.message} ${lb.map((i) => `${i.id}:${i.filename}`).join(", ")}`);

    // ======================================================================
    c.head("7 · an AI re-edit in Kyle's own words");
    const ph2 = photos[2];
    const quote = await actions.reeditQuoteAction(job.id);
    c.ok("the price is read from AutoHDR's catalogue, in credits", quote.ok && quote.credits === 1, JSON.stringify(quote));
    const short = await actions.customReeditAction({ jobId: job.id, photoId: ph2.id, prompt: "fix", expectCredits: 1 });
    const pricey = await actions.customReeditAction({ jobId: job.id, photoId: ph2.id, prompt: "Remove the wooden sidewalk forms in front of the house", expectCredits: 2 });
    c.ok("a few words are needed, and a price other than the one shown is refused (nothing written)", !short.ok && !pricey.ok && /price changed/.test(pricey.message) && (await prisma.photoQcFinding.count({ where: { jobId: job.id, source: "STAFF" } })) === 0, pricey.message);
    const transforms0 = fake.posts("/v1/transforms").length;
    const asked = await actions.customReeditAction({ jobId: job.id, photoId: ph2.id, prompt: "Remove the wooden sidewalk forms in front of the house", expectCredits: 1 });
    const staff = await prisma.photoQcFinding.findFirst({ where: { jobId: job.id, source: "STAFF" } });
    const op = await prisma.photoFixOperation.findFirst({ where: { jobId: job.id, photoId: ph2.id } });
    c.ok("Kyle's press: his words as an approved re-edit (1 credit), queued for the fix runner, nothing sent from here", asked.ok && staff?.status === "APPROVED_FIX" && staff.reeditPrompt === "Remove the wooden sidewalk forms in front of the house" && op?.status === "QUEUED" && op.strategy === "REEDIT_PROMPT" && op.estimatedCredits === 1 && fake.posts("/v1/transforms").length === transforms0, asked.message);

    // ======================================================================
    c.head("8 · a change made in AutoHDR wins over the hub's edit");
    const fp = shoot.photos[0];
    const newer = `ver-editor-${fp.image_uuid.slice(0, 6)}`;
    fp.versions.push({ uuid: newer, parent: fp.head, label: "Crop & Tilt", description: null });
    fp.head = newer;
    const sync2 = await V.syncHeads(job.id, { by: "drill" });
    const p4 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: ph0.id } });
    c.ok("AutoHDR's newer version is taken; the hub edit stays under Versions; what it fixed is open again", sync2.changed.some((x) => x.photoId === ph0.id) && p4.autohdrVersionUuid === newer && p4.contentHash === V.hashOfVersion(newer) && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: crooked.id } })).status === "OPEN" && (await prisma.photoVersion.count({ where: { photoId: ph0.id, source: "HUB_EDIT" } })) === 1, JSON.stringify(sync2.changed));

    // ======================================================================
    c.head("9 · the upload route: a token for one path, owner or Kyle only");
    const upRoute = await import("@/app/api/photo-delivery/edit-upload/route");
    const ask = (pathname: string, payload: Record<string, string>) => upRoute.POST(new NextRequest("http://drill.local/api/photo-delivery/edit-upload", { method: "POST", body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }) }));
    const noStore = await ask(`${PE.editUploadPrefix(job.id, ph0.id)}edit.jpg`, { jobId: job.id, photoId: ph0.id });
    c.ok("no private store: refused, it never falls back to the public one", noStore.status === 400 && /private photo storage/.test(((await noStore.json()) as { error: string }).error));
    process.env.PHOTO_QC_BLOB_TOKEN = "vercel_blob_rw_drillstore_drillsecretdrillsecret";
    const wrongPath = await ask(`${PE.editUploadPrefix(job.id, photos[1].id)}edit.jpg`, { jobId: job.id, photoId: ph0.id });
    const goodPath = await ask(`${PE.editUploadPrefix(job.id, ph0.id)}edit.jpg`, { jobId: job.id, photoId: ph0.id });
    const good = (await goodPath.json()) as { clientToken?: string; type?: string };
    c.ok("a path that is not this photo's is refused; this photo's gets a token", wrongPath.status === 400 && goodPath.status === 200 && typeof good.clientToken === "string" && good.clientToken.length > 20, JSON.stringify(good).slice(0, 120));
    const { SESSION_COOKIE } = await import("@/lib/auth/jwt");
    next.cookies.delete(SESSION_COOKIE);
    const anon = await ask(`${PE.editUploadPrefix(job.id, ph0.id)}edit.jpg`, { jobId: job.id, photoId: ph0.id });
    c.ok("signed out: refused", anon.status === 400);
    delete process.env.PHOTO_QC_BLOB_TOKEN;

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

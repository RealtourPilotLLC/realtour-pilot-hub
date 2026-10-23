// ---------------------------------------------------------------------------
// DRILL: listing videos into Aryeo by the hub, BUTTON ONLY (Oct 19 2026,
// lib/videoAryeoPush + integrations/aryeoWeb video calls + lib/videoDelivery).
//
// Jordan: "We should be able to send the videos just like we send the photos
// to Aryeo", then (Oct 19): a "ready to send" list with "a button that says
// 'upload to aryeo and send'"; upload to Aryeo happens ONLY when someone
// presses it (no automatic mode).
//
// Fakes, answered in-process, shaped like Aryeo's web app (read from its code
// on Oct 19: the Add Video window, Uploadcare under the video key through
// upload.aryeo.com, the listing page's videos, Delete, Deliver Listing),
// Uploadcare's from_url and multipart APIs, Aryeo's public API (the listing as
// the hub reads it back, the new video processing for a while), and Dropbox
// (a temporary link, range reads of the 1080p file).
//    1  button only: no stored switch value starts anything; the row says what
//       the button does, never "the hub sends it"
//    2  a press that cannot start (no Aryeo login) writes a FAILED run that says why
//    3  the press: from_url, the Add Video call's exact body, the check waits
//       for the new video (processing), Re-deliver once, then the receipts:
//       the hub's upload, the send, the 1080p job, Kyle's task, the notice
//    4  multipart fallback when from_url is refused, resumed across passes
//    5  Aryeo signs the hub out in the middle of the add: never sent again
//    6  an ambiguous add (500 after Aryeo made it; a request that never got
//       there): never sent again by the hub; a person's Try again checks first;
//       a sign-out during Deliver waits for a person
//    7  a revision (V2): only the hub's own V1 comes off; Kyle's video stays;
//       the listing's cooldown
//    8  a job owing two videos, both pressed: one run at a time between the
//       add and the check, ONE delivery
//    9  pressed with an open client request: held (never uploaded) until it is
//       checked, then it carries on by itself
//   10  held by the sound check, and by a held 1080p file
//   11  a photo push sending on the same listing defers; its delivery covers
//   12  monthly videos are never touched
//   13  an earlier version up by hand: waits for Deliver now; Hold / Release
//   14  the board and the counts (each video once per number; monthly apart)
// The Oct 19 audit fixes, each on its own:
//   15  the add's intent is never saved without time for the add in the same pass
//   16  a video another run already claimed is never "the new one"
//   17  a "not yet" gate in ADDING / DELIVERING ends the pass (no busy loop)
//   18  a row with a person's upload receipt and no run: the hand path, and a
//       press delivers without a second upload
//   19  another run's delivery claim is never taken over while it lives; an
//       orphaned one counts as "may have gone", never re-sent
//   20  Aryeo refusing the login in the middle of Deliver: "may have gone",
//       never re-sent by the cron; a person's Deliver now sends it
//   21  a sign-in failure of a started run is tried again (3 times at most);
//       an older FAILED record is never picked up
//   22  Try again after the file changed takes the earlier try's video off
// Upload to Aryeo only (Oct 23 2026; the rest in oct23-video-upload-only.ts):
//   23  the cron's login retry repeats "upload only"; a sibling video's full
//       send never waits for an upload-only one
// ISOLATION: PGlite via the shared harness; nothing leaves the fakes.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";

installNextStubs();
const PORT = Number(process.env.DRILL_PORT ?? 7319);
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
const UC_KEY = "c0ffee0123456789abcd";
const UC_VIDEO_KEY = "fa1dbeef0123456789ab";
const MIB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;

type Vid = { id: string; title: string; duration: number | null; visibleAfter: number; playableAfter: number; ucUuid: string | null };
type Listing = { id: string; videos: Vid[]; reads: number; deliveries: number };
const listings = new Map<string, Listing>();
const calls: { kind: string; listing?: string; body?: unknown }[] = [];
const ucFiles = new Map<string, { name: string; size: number; bytes: Buffer | null; parts: (Buffer | null)[]; duration: number | null }>();
const tokens = new Map<string, { path: string; polls: number }>();
const dropbox = new Map<string, { bytes: Buffer; duration: number }>();
const partPuts: string[] = [];
let sessionSeq = 0;
let seq = 0;
const validSessions = new Set<string>();
const pendingSessions = new Set<string>();
let refuseFromUrl = false;
let bounceAfterAdd = false;
let bounceAfterDeliver = false;
/** Aryeo refuses the hub's password (a changed login). */
let loginRefused = false;
/** Deliver goes through, then Aryeo signs the hub out AND will not take it back (a sign-in error in the middle of Deliver). */
let lockOutAfterDeliver = false;
const add500 = new Set<string>();
const neverReaches = new Set<string>();
let addAttempts = 0;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
/** A UUIDv7 dated `ms` (how the hub dates an Aryeo video), unique by a counter. */
const v7 = (ms: number) => {
  const t = Math.floor(ms).toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-${(++seq).toString(16).padStart(12, "0")}`;
};
const lname = (id: string) => listings.get(id)!;

function editPage(l: Listing) {
  return {
    component: "Company/Listings/EditListing",
    version: "v1",
    url: `/admin/listings/${l.id}/edit`,
    props: {
      errors: {},
      listing: { id: l.id, delivery_status: "delivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Agent" } }] },
      images: [],
      videos: { data: l.videos.map((v) => ({ uuid: v.id, id: v.id, title: v.title, duration: v.duration, created_at: new Date().toISOString() })) },
      company: { default_enable_mark_orders_fulfilled: false, default_timezone: "America/New_York" },
      image_uploads_require_media_license: false,
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
      calls.push({ kind: "login-page" });
      const page = JSON.stringify({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: {} }).replace(/"/g, "&quot;");
      return withCookies(new Response(`<html><script>window.UPLOADCARE_PUBLIC_KEY = "${UC_KEY}"; window.ARYEO_UPLOADCARE_VIDEO_PUBLIC_KEY = "${UC_VIDEO_KEY}";</script><div id="app" data-page="${page}"></div></html>`, { status: 200, headers: { "content-type": "text/html" } }), ["XSRF-TOKEN=tok%3D%3D; path=/; domain=.aryeo.com", "aryeo_session=anon; path=/; domain=.aryeo.com; httponly"]);
    }
    calls.push({ kind: "login" });
    if (h.get("x-xsrf-token") !== "tok==" || ck.aryeo_session !== "anon") return new Response("CSRF token mismatch", { status: 419 });
    const b = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (loginRefused || b.email !== LOGIN.email || b.password !== LOGIN.password) return redirect("https://app.aryeo.com/login");
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
  if (method !== "GET" && (h.get("origin") !== "https://realtourpilot.aryeo.com" || !(h.get("referer") ?? "").startsWith("https://realtourpilot.aryeo.com/admin/listings/"))) {
    calls.push({ kind: "no-origin" });
    return redirect("https://app.aryeo.com/login");
  }
  if (u.pathname === "/admin/dashboard") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    if (!l) return new Response("nope", { status: 404 });
    if (u.searchParams.get("err") === "video") return json({ ...editPage(l), props: { ...editPage(l).props, errors: { "videos.0.url": "The video could not be read." } } });
    // Aryeo's live answer to the short shape (Oct 19 2026, the first two real presses).
    if (u.searchParams.get("err") === "fields") return json({ ...editPage(l), props: { ...editPage(l).props, errors: { "videos.0.titleValue": "Video title is required for each video.", "videos.0.displayType": "Display type is required for each video.", "videos.0.size": "File size is required for each video." } } });
    if ((h.get("x-inertia-partial-data") ?? "").split(",").includes("delivery_email")) {
      return json({ component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`, props: { delivery_email: { email_subject: "Your listing media is ready!", email_body: "<p>Your video is ready.</p>", email_cc_list: "", email_bcc_list: "office@realtourpilot.com" } } });
    }
    return json(editPage(l));
  }
  m = /^\/admin\/listing\/([^/]+)\/videos$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = lname(m[1]);
    addAttempts++;
    if (neverReaches.has(l.id)) {
      neverReaches.delete(l.id);
      throw new TypeError("fetch failed (the connection dropped before Aryeo answered)");
    }
    const b = JSON.parse(String(init?.body)) as { video_title: unknown; display_type: string; video_url: unknown; videos: { url: string; video_title: string; display_type: string; titleValue?: string; displayType?: string; size?: number }[] };
    calls.push({ kind: "add", listing: l.id, body: b });
    // Aryeo checks the window's raw file record (titleValue, displayType, size), not the mapped one.
    if (!b.videos?.every((v) => !!v.titleValue && !!v.displayType && typeof v.size === "number" && v.size > 0)) return redirect(`/admin/listings/${l.id}/edit?err=fields`);
    const uuid = /^https:\/\/aryeo\.ucarecd\.net\/([^/]+)\/$/.exec(b.videos?.[0]?.url ?? "")?.[1];
    const f = uuid ? ucFiles.get(uuid) : null;
    if (!f || !f.bytes) return redirect(`/admin/listings/${l.id}/edit?err=video`);
    l.videos.push({ id: v7(Date.now()), title: b.videos[0].video_title, duration: f.duration, visibleAfter: l.reads + 1, playableAfter: l.reads + 3, ucUuid: uuid! });
    if (add500.has(l.id)) {
      add500.delete(l.id);
      return new Response("Server Error", { status: 500 });
    }
    if (bounceAfterAdd) {
      bounceAfterAdd = false;
      validSessions.clear();
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/videos\/([^/]+)$/.exec(u.pathname);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    const l = [...listings.values()].find((x) => x.videos.some((v) => v.id === id));
    calls.push({ kind: "delete", listing: l?.id, body: id });
    if (!l) return new Response("nope", { status: 404 });
    l.videos = l.videos.filter((v) => v.id !== id);
    return redirect(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = lname(m[1]);
    calls.push({ kind: "deliver", listing: l.id, body: JSON.parse(String(init?.body)) });
    l.deliveries++;
    if (bounceAfterDeliver) {
      bounceAfterDeliver = false;
      validSessions.clear();
    }
    if (lockOutAfterDeliver) {
      lockOutAfterDeliver = false;
      validSessions.clear();
      loginRefused = true;
    }
    return redirect(`/admin/listings/${l.id}/edit`);
  }
  return new Response("not faked", { status: 404 });
}

async function uploadcare(url: string, init?: RequestInit): Promise<Response | null> {
  const u = new URL(url);
  if (u.origin === "https://s3.drill.invalid") {
    const [, , uuid, i] = u.pathname.split("/");
    const f = ucFiles.get(uuid);
    if (!f || init?.method !== "PUT") return new Response("no", { status: 404 });
    f.parts[Number(i)] = Buffer.from(init.body as Uint8Array);
    partPuts.push(`${uuid}/${i}`);
    calls.push({ kind: "part", body: `${uuid}/${i}` });
    return new Response(null, { status: 200 });
  }
  if (u.origin !== "https://upload.aryeo.com") return null;
  const form = init?.body instanceof FormData ? init.body : null;
  if (u.pathname === "/from_url/") {
    calls.push({ kind: "from_url", body: form?.get("source_url") });
    if (form?.get("pub_key") !== UC_VIDEO_KEY) return json({ detail: "pub_key is invalid" }, 403);
    if (refuseFromUrl) return json({ detail: "Uploading from URLs is not allowed for this project." }, 403);
    const src = String(form.get("source_url") ?? "");
    if (!src.startsWith("https://dl.drill.invalid/")) return json({ detail: "bad url" }, 400);
    const token = `tok-${++seq}`;
    tokens.set(token, { path: decodeURIComponent(src.slice("https://dl.drill.invalid/".length)), polls: 0 });
    return json({ type: "token", token });
  }
  if (u.pathname === "/from_url/status/") {
    const t = tokens.get(u.searchParams.get("token") ?? "");
    if (!t) return json({ status: "unknown" });
    t.polls++;
    const d = dropbox.get(t.path)!;
    if (t.polls < 2) return json({ status: "progress", done: Math.floor(d.bytes.length / 2), total: d.bytes.length });
    const uuid = `uc-${++seq}`;
    ucFiles.set(uuid, { name: t.path.split("/").pop()!, size: d.bytes.length, bytes: Buffer.from(d.bytes), parts: [], duration: d.duration });
    return json({ status: "success", uuid, file_id: uuid, is_ready: true });
  }
  if (u.pathname === "/multipart/start/") {
    calls.push({ kind: "mp-start", body: form?.get("filename") });
    if (form?.get("UPLOADCARE_PUB_KEY") !== UC_VIDEO_KEY) return json({ detail: "pub_key is invalid" }, 403);
    const size = Number(form.get("size"));
    const name = String(form.get("filename"));
    const n = Math.ceil(size / (5 * MIB));
    const uuid = `uc-${++seq}`;
    const src = [...dropbox.entries()].find(([p]) => p.endsWith(`/${name}`));
    ucFiles.set(uuid, { name, size, bytes: null, parts: Array(n).fill(null), duration: src?.[1].duration ?? null });
    return json({ uuid, parts: Array.from({ length: n }, (_, i) => `https://s3.drill.invalid/mp/${uuid}/${i}?X-Amz-Signature=drill`) });
  }
  if (u.pathname === "/multipart/complete/") {
    const f = ucFiles.get(String(form?.get("uuid")));
    calls.push({ kind: "mp-complete" });
    if (!f || f.parts.some((p) => !p)) return json({ detail: "parts missing" }, 400);
    f.bytes = Buffer.concat(f.parts as Buffer[]);
    return json({ uuid: form?.get("uuid"), is_ready: true, size: f.bytes.length });
  }
  if (u.pathname === "/info/") {
    const f = ucFiles.get(u.searchParams.get("file_id") ?? "");
    return f ? json({ is_ready: !!f.bytes, size: f.size, mime_type: "video/mp4" }) : json({ detail: "no" }, 404);
  }
  return null;
}

function aryeoApi(url: string): Response | null {
  if (!url.startsWith("https://api.aryeo.com/v1/listings/")) return null;
  const l = listings.get(new URL(url).pathname.split("/")[3]);
  if (!l) return json({ message: "Not found" }, 404);
  l.reads++;
  calls.push({ kind: "api-read", listing: l.id });
  const shown = l.videos.filter((v) => l.reads >= v.visibleAfter);
  return json({ data: { id: l.id, delivery_status: "DELIVERED", images: [], floor_plans: [], videos: shown.map((v) => ({ id: v.id, title: v.title, duration: l.reads >= v.playableAfter ? v.duration : null, playback_url: l.reads >= v.playableAfter ? `https://stream.mux.com/${v.id}.m3u8` : null, download_url: null })) } });
}

function dropboxFake(url: string, init?: RequestInit): Response | null {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  if (url === "https://api.dropboxapi.com/2/files/get_temporary_link") {
    const { path } = JSON.parse(String(init?.body)) as { path: string };
    calls.push({ kind: "dropbox-link", body: path });
    const f = dropbox.get(path);
    if (!f) return json({ error_summary: "path/not_found/" }, 409);
    return json({ link: `https://dl.drill.invalid/${encodeURIComponent(path)}`, metadata: { size: f.bytes.length } });
  }
  if (url.startsWith("https://dl.drill.invalid/")) {
    const f = dropbox.get(decodeURIComponent(url.slice("https://dl.drill.invalid/".length)));
    if (!f) return new Response("no", { status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
    calls.push({ kind: "dropbox-read" });
    if (!range) return new Response(new Uint8Array(f.bytes), { status: 200 });
    return new Response(new Uint8Array(f.bytes.subarray(Number(range[1]), Number(range[2]) + 1)), { status: 206 });
  }
  return null;
}

const fence = fenceFetch(async (url, init) =>
  (await aryeoWeb(url, init)) ?? (await uploadcare(url, init)) ?? aryeoApi(url) ?? dropboxFake(url, init) ??
  (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

const outbound = () => calls.filter((x) => ["login", "login-page", "add", "delete", "deliver", "from_url", "mp-start", "part", "dropbox-link", "dropbox-read", "api-read"].includes(x.kind)).length;


async function main() {
  if (!(await portFree(PORT))) throw new Error(`Fixture port ${PORT} is busy; existing process left untouched`);
  const db = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct19-video-aryeo-push-isolated", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret, disconnect } = await import("@/lib/integrations/connections");
    const S = await import("@/lib/videoDeliverySettings");
    const V = await import("@/lib/videoAryeoPush");
    const { readyToSend } = await import("@/lib/readyToSend");
    const { deliveryReadyMessage, hubIsSending } = await import("@/lib/deliveryReadyMessage");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    const saveLogin = () => saveSecret("aryeo_web", LOGIN.password, { accountLabel: LOGIN.email, metadata: { email: LOGIN.email } });
    await saveLogin();

    // The client's open requests and the sound check, per job/cut (the real ones read other lanes' tables and the file's header).
    const asksFor = new Map<string, { id: string; summary: string; askedBy: string | null; askedAtISO: string; medium: string | null }[]>();
    const soundFor = new Map<string, { verdict: "hold"; reason: string; message: string; av: null }>();
    const baseHooks = {
      openAsks: async (pid: string) => asksFor.get(pid) ?? [],
      soundCheck: async (sid: string) => soundFor.get(sid) ?? { verdict: "ok" as const, message: "The finished file has sound, and it lines up with the picture.", av: null },
      sleep: async () => {},
    };
    V.__setVideoPushHooksForTests(baseHooks);
    const setMode = async (m: "off" | "shadow" | "upload" | "deliver", cooldownMin = 0) => {
      await S.saveVideoDeliverySettings({ aryeoPush: m, cooldownMin }, "drill");
    };

    const agent = await prisma.client.create({ data: { name: "Drill Agent Realty" } });
    const T = Date.now();
    let orders = 0;
    const mkCut = async (projectId: string, deliverableId: string, street: string, opts: { slot?: number; round?: number; size?: number; duration?: number; topaz?: { state?: string; outputCheck?: string | null } } = {}) => {
      const slot = opts.slot ?? 1;
      const round = opts.round ?? 1;
      const path = `/Listings/${street}/05-Final-Video/${street} v${round} s${slot} - FINAL (Topaz).mp4`;
      const size = opts.size ?? 300_000;
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + round * 7 + slot) & 0xff;
      dropbox.set(path, { bytes, duration: opts.duration ?? 59.6 });
      const sub = await prisma.reviewSubmission.create({
        data: { projectId, deliverableId, slot, round, status: "APPROVED", fileName: `${street} v${round}.mp4`, blobUrl: `https://drill.invalid/${encodeURIComponent(street)}-${round}-${slot}.mp4`, sizeBytes: size, decidedAt: new Date(T - 40 * MIN), decidedBy: "Jordan" },
      });
      const task = await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: `Upload the 1080p video to Aryeo: ${street}`, projectId, dedupeKey: `topaz-deliver-${sub.id}`, status: "OPEN", assignedKey: "kyle" } });
      const job = await prisma.topazJob.create({
        data: { submissionId: sub.id, projectId, state: opts.topaz?.state ?? "done", fileName: sub.fileName, sourceDurationSec: opts.duration ?? 59.6, sourceSizeBytes: size, savedAt: new Date(T - 10 * MIN), finishedAt: new Date(T - 10 * MIN), finalPath: path, outputCheck: opts.topaz?.outputCheck === undefined ? "verified" : opts.topaz.outputCheck, taskId: task.id, ...(opts.topaz?.state === "held" ? { heldPath: path, heldAt: new Date(), outputCheckJson: JSON.stringify({ verdict: "sound", reason: "it has no sound at all, and neither has the editor's export" }) } : {}) },
      });
      return { sub: sub.id, job: job.id, task: task.id, path };
    };
    const mkJob = async (street: string, listingId: string, opts: { videos?: number; size?: number; clientId?: string; monthly?: boolean; status?: string; shootDate?: Date; pin?: Date; cut?: boolean; topaz?: { state?: string; outputCheck?: string | null } } = {}) => {
      let contentMonthId: string | null = null;
      if (opts.monthly) {
        const enr = await prisma.contentEnrollment.create({ data: { clientId: opts.clientId!, package: "Starter", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } });
        const month = await prisma.contentMonth.create({ data: { enrollmentId: enr.id, clientId: opts.clientId!, monthKey: "2026-10", videosOwed: 4 } });
        contentMonthId = month.id;
      }
      const project = await prisma.project.create({
        data: { title: `${street}, Media, PA`, clientId: opts.clientId ?? agent.id, status: (opts.status ?? "REVIEW") as never, aryeoListingId: listingId, aryeoOrderId: `ord-${++orders}`, contentMonthId, shootDate: opts.shootDate ?? new Date(T - 2 * 24 * HOUR), promisedDueAt: opts.pin ?? null },
      });
      await prisma.orderItem.create({ data: { projectId: project.id, title: "Cinematic Video", amount: 150 } });
      listings.set(listingId, listings.get(listingId) ?? { id: listingId, videos: [], reads: 0, deliveries: 0 });
      const cuts: Awaited<ReturnType<typeof mkCut>>[] = [];
      for (let i = 0; i < (opts.videos ?? 1); i++) {
        const d = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 1, productTitle: i ? `Social Reel ${i + 1}` : "Cinematic Video" } });
        await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: project.id, slot: 1, category: "VIDEO" } });
        if (opts.cut !== false) cuts.push(await mkCut(project.id, d.id, street, { size: opts.size, slot: 1, round: 1, topaz: opts.topaz }));
      }
      return { project, cuts };
    };
    /** One cron pass (moves the runs people started; starts nothing). */
    const tick = async (n = 1) => {
      for (let i = 0; i < n; i++) await V.driveVideoPushes({ budgetMs: 60_000 });
    };
    /** Kyle's press: Upload to Aryeo and send. */
    const press = (sid: string, by = "Kyle Smith") => V.requestVideoPush(sid, { by });
    const runOf = (sid: string) => V.videoPushRun(sid);
    const forceRecheck = async (sid: string) => {
      const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: `video_aryeo_push:${sid}` } });
      await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ ...JSON.parse(row.value), recheckAt: new Date(Date.now() - 1000).toISOString(), pauseUntil: null }) } });
    };
    const patchRun = async (sid: string, patch: Record<string, unknown>) => {
      const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: `video_aryeo_push:${sid}` } });
      await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ ...JSON.parse(row.value), ...patch }) } });
    };
    const kinds = (kind: string, listing?: string) => calls.filter((x) => x.kind === kind && (!listing || x.listing === listing));

    // ======================================================================
    c.head("1 · button only: nothing starts by itself");
    const A = await mkJob("10 First Ave", "L-A");
    c.ok("the stored switch is Off (the default)", (await S.videoDeliverySettings()).aryeoPush === "off");
    for (const m of ["off", "shadow", "upload", "deliver"] as const) {
      await setMode(m);
      await tick();
    }
    c.ok("a cron pass under every stored value (off, practice, upload, deliver): no run, nothing called", outbound() === 0 && !(await runOf(A.cuts[0].sub)), `${outbound()} calls`);
    await setMode("off");
    const rowA0 = (await readyToSend({ projectId: A.project.id })).ready[0];
    c.ok("the row says what the button does, never that the hub sends it", rowA0?.push?.canStart === true && rowA0.push.state === null && rowA0.push.handledByHub === false && /Press Upload to Aryeo and send/.test(rowA0.push.says) && !/hub sends|next pass|by itself/i.test(rowA0.push.says) && !hubIsSending(rowA0), rowA0?.push?.says);
    const msgA0 = deliveryReadyMessage(rowA0, "https://hub.test");
    c.ok("the alert points at the button in the Video Review Room", /^Ready to send · 10 First Ave$/.test(msgA0.title) && /Press Upload to Aryeo and send in the Video Review Room/.test(msgA0.body) && msgA0.href === "/review" && /hub\.test\/review/.test(msgA0.slackDm), `${msgA0.title} · ${msgA0.body}`);

    // ======================================================================
    c.head("2 · a press that cannot start says why");
    await disconnect("aryeo_web");
    const noLogin = await press(A.cuts[0].sub);
    const a0 = await runOf(A.cuts[0].sub);
    c.ok("no Aryeo login: a FAILED run with the reason, nothing called", !noLogin.ok && !noLogin.started && a0?.state === "FAILED" && /Aryeo login is not set up/.test(a0.note ?? "") && a0.by === "Kyle Smith" && outbound() === 0, `${a0?.state} ${a0?.note}`);
    const rowAf = (await readyToSend({ projectId: A.project.id })).ready[0];
    c.ok("…the row shows it and offers Try again (never 'the hub sends it')", rowAf?.push?.tone === "failed" && rowAf.push.canRetry && rowAf.push.canStart && !hubIsSending(rowAf));
    await saveLogin();

    // ======================================================================
    c.head("3 · the press: upload and deliver, from_url, the add, the check, one Re-deliver, the receipts");
    const pA = await press(A.cuts[0].sub);
    c.ok("the press starts it (it says what it does)", pA.ok && pA.started && /Uploading it to the Aryeo listing, then sending the listing/.test(pA.message), pA.message);
    await tick();
    const a1 = await runOf(A.cuts[0].sub);
    const fromUrl = kinds("from_url")[0];
    c.ok("the 1080p file went to Aryeo's VIDEO upload key by a temporary Dropbox link (no bytes through the hub)", !!fromUrl && String(fromUrl.body).startsWith("https://dl.drill.invalid/") && kinds("mp-start").length === 0 && kinds("dropbox-read").length === 0);
    const add = kinds("add", "L-A")[0]?.body as { video_title: unknown; display_type: string; video_url: unknown; videos: { url: string; video_title: string; display_type: string }[] } | undefined;
    c.ok("Add Video was called the way the listing editor calls it", !!add && add.video_title === null && add.display_type === "both" && add.video_url === null && add.videos.length === 1 && /^https:\/\/aryeo\.ucarecd\.net\/uc-\d+\/$/.test(add.videos[0].url) && add.videos[0].display_type === "both" && add.videos[0].video_title === "Cinematic Video", JSON.stringify(add));
    c.ok("every change said where it came from (Aryeo bounces one that doesn't)", kinds("no-origin").length === 0);
    c.ok("the check waits while Aryeo processes the new video", a1?.state === "CHECKING" && /processing/.test(a1.note ?? "") && kinds("deliver", "L-A").length === 0, `${a1?.state} ${a1?.note}`);
    const rowA1 = (await readyToSend({ projectId: A.project.id })).ready[0];
    c.ok("the row shows the run's progress: Uploading (the hub has it, no alert)", rowA1?.push?.progress === "uploading" && rowA1.push.handledByHub && hubIsSending(rowA1));
    await tick(2);
    const a2 = await runOf(A.cuts[0].sub);
    const del = kinds("deliver", "L-A");
    c.ok("then ONE Re-deliver, as the browser sends it (fulfill orders, Aryeo's own email to the listing's customers)", del.length === 1 && (del[0].body as Record<string, unknown>).fulfill_orders === true && (del[0].body as Record<string, unknown>).notify_via_email === true && (del[0].body as Record<string, unknown>).email_subject === "Your listing media is ready!", JSON.stringify(del[0]?.body));
    const subA = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A.cuts[0].sub } });
    const { uploadsFor } = await import("@/lib/deliveryUploads");
    const receipt = (await uploadsFor([A.cuts[0].sub])).get(A.cuts[0].sub) as { actor: string; mediaIds?: string[] } | undefined;
    const jobA = await prisma.topazJob.findUniqueOrThrow({ where: { id: A.cuts[0].job } });
    const taskA = await prisma.smartTask.findUniqueOrThrow({ where: { id: A.cuts[0].task } });
    c.ok("DONE, in plain words", a2?.state === "DONE" && /^Uploaded and delivered by the hub at /.test(a2.note ?? ""), `${a2?.state} ${a2?.note}`);
    c.ok("the upload receipt names the hub and the video's id on the listing", receipt?.actor === "the hub" && receipt.mediaIds?.[0] === a2?.mediaId && lname("L-A").videos.some((v) => v.id === a2?.mediaId));
    c.ok("the send is stamped through markVideoSent (Aryeo, by the hub)", !!subA.sentToClientAt && subA.sentToClientBy === "Aryeo (delivered by the hub)" && subA.clientNoticeVia === "aryeo-email");
    c.ok("…which closes the 1080p job and Kyle's upload task", !!jobA.deliveredAt && taskA.status === "COMPLETED");
    const outA = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: A.project.id } });
    c.ok("…and the video's own delivery row says the listing", outA.deliveredVia === "aryeo-listing" && outA.sentSubmissionId === A.cuts[0].sub);
    c.ok("the job's timeline carries who pressed it and the hub's lines", (await prisma.activity.count({ where: { projectId: A.project.id, body: { startsWith: "Video to Aryeo:" } } })) >= 2 && (await prisma.activity.count({ where: { projectId: A.project.id, body: { contains: "Kyle Smith pressed Upload to Aryeo and send" } } })) === 1);
    c.ok("the row has left the delivery card", (await readyToSend({ projectId: A.project.id })).ready.length === 0);
    c.ok("the listing's add lock was let go", (await prisma.appSetting.count({ where: { key: { startsWith: "video_aryeo_adding:" } } })) === 0);

    // ======================================================================
    c.head("4 · from_url refused: the multipart upload, resumed across passes");
    refuseFromUrl = true;
    V.__setVideoPushHooksForTests({ ...baseHooks, partsPerPass: 2 });
    const B = await mkJob("20 Parts Pl", "L-B", { size: 2 * 5 * MIB + 1234 });
    await press(B.cuts[0].sub);
    await tick();
    const b1 = await runOf(B.cuts[0].sub);
    c.ok("from_url refused (the project does not allow it): the hub sends it in parts instead", b1?.upload.method === "multipart" && /not allowed/.test(b1.upload.fromUrlRefused ?? ""), JSON.stringify(b1?.upload.fromUrlRefused));
    c.ok("a pass sends what it has time for and stops: 2 of 3 parts", b1?.state === "SENDING" && b1.upload.partsDone === 2 && /^Sending the 1080p file to Aryeo: 2 of 3 parts/.test(b1.note ?? ""), `${b1?.state} ${b1?.upload.partsDone} ${b1?.note}`);
    await tick(3);
    const b2 = await runOf(B.cuts[0].sub);
    const ucB = [...ucFiles.values()].find((f) => f.size === 2 * 5 * MIB + 1234);
    c.ok("the next pass carries on from part 3: every part sent exactly once", partPuts.length === 3 && new Set(partPuts).size === 3, partPuts.join(", "));
    c.ok("Aryeo's upload service holds exactly the 1080p file's bytes", !!ucB?.bytes && ucB.bytes.equals(dropbox.get(B.cuts[0].path)!.bytes));
    c.ok("…then added, checked and delivered", b2?.state === "DONE" && kinds("add", "L-B").length === 1 && kinds("deliver", "L-B").length === 1, `${b2?.state} ${b2?.note}`);
    refuseFromUrl = false;
    V.__setVideoPushHooksForTests(baseHooks);

    // ======================================================================
    c.head("5 · Aryeo signs the hub out in the middle of the add");
    const C = await mkJob("30 Bounce Ct", "L-C");
    const logins0 = kinds("login").length;
    bounceAfterAdd = true;
    await press(C.cuts[0].sub);
    await tick(3);
    const cRun = await runOf(C.cuts[0].sub);
    c.ok("signed back in once, the add NOT sent again, the check found it, delivered", kinds("add", "L-C").length === 1 && lname("L-C").videos.length === 1 && kinds("login").length - logins0 === 1 && cRun?.state === "DONE", `adds=${kinds("add", "L-C").length} logins=${kinds("login").length - logins0} ${cRun?.state} ${cRun?.note}`);

    // ======================================================================
    c.head("6 · an ambiguous add is never sent again by the hub");
    const D = await mkJob("40 Five Hundred Rd", "L-D");
    add500.add("L-D");
    await press(D.cuts[0].sub);
    await tick(3);
    const dRun = await runOf(D.cuts[0].sub);
    c.ok("Aryeo made the video, then answered 500: one add, one video, delivered", kinds("add", "L-D").length === 1 && lname("L-D").videos.length === 1 && dRun?.state === "DONE", `${dRun?.state} ${dRun?.note}`);
    const E = await mkJob("50 Dropped Ln", "L-E");
    neverReaches.add("L-E");
    const attempts0 = addAttempts;
    await press(E.cuts[0].sub);
    await tick();
    const e1 = await runOf(E.cuts[0].sub);
    c.ok("the connection dropped during the add: the hub checks instead of adding again", e1?.state === "CHECKING" && addAttempts - attempts0 === 1 && lname("L-E").videos.length === 0, `${e1?.state} ${e1?.note}`);
    await tick(2);
    await patchRun(E.cuts[0].sub, { addSentAt: new Date(Date.now() - 61 * MIN).toISOString(), addedAt: new Date(Date.now() - 61 * MIN).toISOString() });
    await tick();
    const e2 = await runOf(E.cuts[0].sub);
    c.ok("nothing appeared within the hour: stopped for a person, still one attempt", e2?.state === "FAILED" && /Retry checks the listing again before it sends anything/.test(e2.note ?? "") && addAttempts - attempts0 === 1 && lname("L-E").videos.length === 0, `${e2?.state} ${e2?.note}`);
    await tick(2);
    c.ok("…and the cron does not try it again by itself", addAttempts - attempts0 === 1 && (await runOf(E.cuts[0].sub))?.state === "FAILED");
    // A press in between that could not start (the login was down) keeps what the earlier try did.
    await disconnect("aryeo_web");
    const eNoLogin = await press(E.cuts[0].sub);
    const eMid = await runOf(E.cuts[0].sub);
    c.ok("a press that cannot start keeps the earlier try's unconfirmed add on the record", !eNoLogin.ok && eMid?.state === "FAILED" && !!eMid.addSentAt && /login is not set up/.test(eMid.note ?? ""), `${eMid?.state} ${eMid?.addSentAt}`);
    await saveLogin();
    const retryE = await V.retryVideoPush(E.cuts[0].sub, "Kyle Smith");
    await tick(3);
    const e3 = await runOf(E.cuts[0].sub);
    c.ok("Try again looked at the listing first, found nothing, and sent it once", retryE.ok && e3?.state === "DONE" && kinds("add", "L-E").length === 1 && lname("L-E").videos.length === 1, `${retryE.message} · ${e3?.state} ${e3?.note}`);

    const F = await mkJob("55 Unsure Deliver Way", "L-F");
    bounceAfterDeliver = true;
    await press(F.cuts[0].sub);
    await tick(3);
    const f1 = await runOf(F.cuts[0].sub);
    c.ok("signed out in the middle of Deliver: not sent again, the hub waits for Aryeo's word", f1?.state === "CONFIRMING" && f1.deliverUncertain === true && kinds("deliver", "L-F").length === 1, `${f1?.state} ${f1?.note}`);
    await patchRun(F.cuts[0].sub, { deliveredAt: new Date(Date.now() - 16 * MIN).toISOString() });
    await tick();
    const f2 = await runOf(F.cuts[0].sub);
    c.ok("no word from Aryeo in 15 minutes: a person looks (still one Deliver)", f2?.state === "WAITING" && f2.wait?.gate === "kyle" && /cannot tell whether the email went/.test(f2.note ?? "") && kinds("deliver", "L-F").length === 1 && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: F.cuts[0].sub } })).sentToClientAt, `${f2?.state} ${f2?.note}`);
    const fNow = await V.deliverVideoNow(F.cuts[0].sub, "Kyle Smith");
    const f3 = await runOf(F.cuts[0].sub);
    c.ok("Deliver now sends it (a person's word, not a hub retry)", fNow.ok && f3?.state === "DONE" && kinds("deliver", "L-F").length === 2, `${fNow.message} ${f3?.state}`);

    // ======================================================================
    c.head("7 · a revision: only the hub's own earlier video comes off; the cooldown");
    const kyleVideo: Vid = { id: v7(Date.now() - 2 * HOUR), title: "Kyle's walkthrough", duration: 75, visibleAfter: 0, playableAfter: 0, ucUuid: null };
    lname("L-A").videos.unshift(kyleVideo);
    const v1Media = a2!.mediaId!;
    const dA = await prisma.deliverable.findFirstOrThrow({ where: { projectId: A.project.id } });
    const A2 = await mkCut(A.project.id, dA.id, "10 First Ave", { round: 2, duration: 61.2 });
    await setMode("off", 20);
    await press(A2.sub);
    await tick(4);
    const a2r = await runOf(A2.sub);
    c.ok("V2 went up; the listing was delivered minutes ago, so it waits for the cooldown", a2r?.state === "WAITING" && a2r.wait?.gate === "cooldown" && /re-delivering at/.test(a2r.note ?? "") && kinds("deliver", "L-A").length === 1, `${a2r?.state} ${a2r?.note}`);
    const deletes = kinds("delete", "L-A").map((x) => x.body);
    const la = lname("L-A");
    c.ok("only the hub's own V1 came off; Kyle's video stays", JSON.stringify(deletes) === JSON.stringify([v1Media]) && la.videos.some((v) => v.id === kyleVideo.id) && !la.videos.some((v) => v.id === v1Media) && la.videos.some((v) => v.id === a2r?.mediaId), `${JSON.stringify(deletes)} · ${la.videos.map((v) => v.title).join(" | ")}`);
    await setMode("off", 0);
    await forceRecheck(A2.sub);
    await tick(2);
    const a2d = await runOf(A2.sub);
    c.ok("after the cooldown: re-delivered once more, V2 recorded sent (the stored switch is Off: a started run still delivers)", a2d?.state === "DONE" && kinds("deliver", "L-A").length === 2 && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A2.sub } })).sentToClientAt, `${a2d?.state} ${a2d?.note}`);

    // ======================================================================
    c.head("8 · a job owing two videos, both pressed: one add at a time, ONE delivery");
    const G = await mkJob("60 Pair Dr", "L-G", { videos: 2 });
    await press(G.cuts[0].sub);
    await press(G.cuts[1].sub);
    await tick();
    const g1a = await runOf(G.cuts[0].sub);
    const g2a = await runOf(G.cuts[1].sub);
    const between = [g1a, g2a].filter((r) => !!r && ((r.state === "ADDING" && !!r.addSentAt) || (r.state === "CHECKING" && !r.mediaId)));
    c.ok("only one run on the listing is between its add and its check; the other waits, saying why", between.length === 1 && [g1a, g2a].some((r) => r?.state === "ADDING" && !r.addSentAt && /another video to finish going up on this listing/.test(r.note ?? "")) && kinds("add", "L-G").length === 1, `${g1a?.state}/${g1a?.note} · ${g2a?.state}/${g2a?.note}`);
    await tick(4);
    c.ok("both on the listing, each with its own video", lname("L-G").videos.length === 2 && kinds("add", "L-G").length === 2 && kinds("deliver", "L-G").length <= 1);
    for (const sid of [G.cuts[0].sub, G.cuts[1].sub]) if ((await runOf(sid))?.state === "WAITING") await forceRecheck(sid);
    await tick(2);
    const g1b = await runOf(G.cuts[0].sub);
    const g2b = await runOf(G.cuts[1].sub);
    c.ok("one Re-deliver for the listing, both videos recorded sent", kinds("deliver", "L-G").length === 1 && g1b?.state === "DONE" && g2b?.state === "DONE" && [g1b, g2b].some((r) => r?.deliveredBy === "earlier") && g1b.mediaId !== g2b.mediaId, `${kinds("deliver", "L-G").length} ${g1b?.state}/${g1b?.deliveredBy} ${g2b?.state}/${g2b?.deliveredBy}`);

    // ======================================================================
    c.head("9 · pressed with an open client request (Heather's lot lines)");
    const H = await mkJob("70 Lot Lines Way", "L-H", { cut: false });
    asksFor.set(H.project.id, [{ id: "ask-1", summary: "All 4 lots overlaid like the Pennfield output", askedBy: "Heather", askedAtISO: new Date().toISOString(), medium: "video" }]);
    const dH = await prisma.deliverable.findFirstOrThrow({ where: { projectId: H.project.id } });
    const H1 = await mkCut(H.project.id, dH.id, "70 Lot Lines Way");
    const linksBefore = kinds("dropbox-link").length;
    const pH = await press(H1.sub);
    await tick();
    const h1 = await runOf(H1.sub);
    c.ok("HELD, in plain words, before anything is uploaded (the listing is already delivered, so a video there is visible)", !pH.ok && h1?.state === "HELD" && h1.hold?.gate === "asks" && /^Waiting for 1 open client request to be checked \("All 4 lots overlaid like the Pennfield output"\)\.$/.test(h1.note ?? "") && kinds("dropbox-link").length === linksBefore && lname("L-H").videos.length === 0, `${h1?.state} ${h1?.note}`);
    const rowH = (await readyToSend({ projectId: H.project.id })).ready[0];
    const msgH = deliveryReadyMessage(rowH, "https://hub.test");
    c.ok("the alert says it is held and why (not 'upload now'), and never names Kyle", !hubIsSending(rowH) && /^Held · 70 Lot Lines Way$/.test(msgH.title) && /Waiting for 1 open client request to be checked/.test(msgH.body) && !/Kyle/.test(msgH.body), `${msgH.title} · ${msgH.body}`);
    asksFor.delete(H.project.id);
    await forceRecheck(H1.sub);
    await tick(3);
    const h2 = await runOf(H1.sub);
    c.ok("checked: the started run carries on by itself and delivers", h2?.state === "DONE" && kinds("deliver", "L-H").length === 1, `${h2?.state} ${h2?.note}`);

    // ======================================================================
    c.head("10 · held by the sound check");
    const I = await mkJob("80 Silent St", "L-I", { cut: false });
    const dI = await prisma.deliverable.findFirstOrThrow({ where: { projectId: I.project.id } });
    const I1 = await mkCut(I.project.id, dI.id, "80 Silent St");
    soundFor.set(I1.sub, { verdict: "hold", reason: "this video has no sound", message: "Held: this video has no sound.", av: null });
    await press(I1.sub);
    await tick();
    const i1 = await runOf(I1.sub);
    c.ok("the final file has no sound: HELD with the reason, nothing sent", i1?.state === "HELD" && i1.hold?.gate === "sound" && /^Sound check held this file: this video has no sound\./.test(i1.note ?? "") && lname("L-I").videos.length === 0 && kinds("from_url").every((x) => !String(x.body).includes("Silent")), `${i1?.state} ${i1?.note}`);
    const I2job = await mkJob("85 Held Render Rd", "L-I2", { cut: false });
    const dI2 = await prisma.deliverable.findFirstOrThrow({ where: { projectId: I2job.project.id } });
    const I2 = await mkCut(I2job.project.id, dI2.id, "85 Held Render Rd", { topaz: { state: "held", outputCheck: "unverified" } });
    const i2 = await press(I2.sub);
    c.ok("a 1080p file the Topaz check held is never sent (a press holds it)", !(await runOf(I2.sub))?.mediaId && !i2.started && /Sound check held this file: it has no sound at all/.test(i2.message), i2.message);
    const rowsI2 = (await readyToSend({ projectId: I2job.project.id })).rendering;
    c.ok("the held row on the card says what is wrong with the sound", rowsI2[0]?.held?.lastCheck === "Last check: it has no sound at all, and neither has the editor's export." && /its sound is wrong/.test(rowsI2[0]?.says ?? ""), `${rowsI2[0]?.says} · ${rowsI2[0]?.held?.lastCheck}`);

    // ======================================================================
    c.head("11 · a photo push on the same listing");
    const J = await mkJob("90 Photos Too Blvd", "L-J");
    await prisma.appSetting.create({ data: { key: "photo_aryeo_push:job-j", value: JSON.stringify({ id: "p1", listingId: "L-J", state: "SENDING", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    await press(J.cuts[0].sub);
    await tick(3);
    const j1 = await runOf(J.cuts[0].sub);
    c.ok("photos going up on the listing: the video waits, nothing delivered", j1?.state === "WAITING" && j1.wait?.gate === "photos" && kinds("deliver", "L-J").length === 0, `${j1?.state} ${j1?.note}`);
    await prisma.appSetting.update({ where: { key: "photo_aryeo_push:job-j" }, data: { value: JSON.stringify({ id: "p1", listingId: "L-J", state: "DONE", updatedAt: new Date().toISOString(), deliveredAt: new Date().toISOString() }) } });
    await forceRecheck(J.cuts[0].sub);
    await tick(2);
    const j2 = await runOf(J.cuts[0].sub);
    c.ok("the photos' delivery came after the video went up: it covered it, no second email", j2?.state === "DONE" && j2.deliveredBy === "earlier" && kinds("deliver", "L-J").length === 0 && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: J.cuts[0].sub } })).sentToClientAt, `${j2?.state} ${j2?.note}`);

    // ======================================================================
    c.head("12 · monthly videos are never touched");
    const monthlyClient = await prisma.client.create({ data: { name: "Monthly Drill Agent" } });
    const M = await mkJob("Monthly Agent Content", "L-M", { monthly: true, clientId: monthlyClient.id });
    const monthly = !!M.project.contentMonthId;
    await tick();
    const mDirect = await press(M.cuts[0].sub);
    c.ok("a program video: no run, no record, no call", monthly && !(await runOf(M.cuts[0].sub)) && !mDirect.ok && /client's portal/.test(mDirect.message) && kinds("from_url").every((x) => !String(x.body).includes("Monthly")) && lname("L-M").videos.length === 0, `${monthly} ${mDirect.message}`);

    // ======================================================================
    c.head("13 · an earlier version up by hand: Deliver now; Hold and Release");
    const K = await mkJob("100 Hand Before Pkwy", "L-K", { cut: false });
    const dK = await prisma.deliverable.findFirstOrThrow({ where: { projectId: K.project.id } });
    const K1 = await mkCut(K.project.id, dK.id, "100 Hand Before Pkwy");
    await prisma.reviewSubmission.update({ where: { id: K1.sub }, data: { status: "SUPERSEDED", sentToClientAt: new Date(T - 3 * HOUR), sentToClientBy: "Kyle Smith" } });
    lname("L-K").videos.push({ id: v7(T - 3 * HOUR), title: "Cinematic Video", duration: 59.6, visibleAfter: 0, playableAfter: 0, ucUuid: null });
    const K2 = await mkCut(K.project.id, dK.id, "100 Hand Before Pkwy", { round: 2, duration: 62 });
    await press(K2.sub);
    await tick(3);
    const k1 = await runOf(K2.sub);
    const rowK = (await readyToSend({ projectId: K.project.id })).ready[0];
    c.ok("on the listing, waiting for a person (the hand-uploaded V1 is not the hub's to remove); nothing delivered", k1?.state === "WAITING" && k1.wait?.gate === "kyle" && /went up by hand/.test(k1.note ?? "") && kinds("deliver", "L-K").length === 0 && kinds("delete", "L-K").length === 0 && rowK?.push?.canDeliverNow === true && rowK.push.waitingForKyle === true, `${k1?.state} ${k1?.note}`);
    c.ok("the alert says to press Deliver now in the Video Review Room", /^On Aryeo, send it now · 100 Hand Before Pkwy$/.test(deliveryReadyMessage(rowK, "https://hub.test").title) && deliveryReadyMessage(rowK, "https://hub.test").href === "/review");
    const dn = await V.deliverVideoNow(K2.sub, "Kyle Smith");
    const k2 = await runOf(K2.sub);
    c.ok("Deliver now: one Re-deliver, recorded sent", dn.ok && k2?.state === "DONE" && kinds("deliver", "L-K").length === 1, `${dn.message} ${k2?.state}`);
    const Q = await mkJob("110 Hold Me Ct", "L-Q");
    await press(Q.cuts[0].sub);
    const hold = await V.holdVideoPush(Q.cuts[0].sub, "Kyle Smith", "client asked to wait");
    await tick(2);
    const q1 = await runOf(Q.cuts[0].sub);
    c.ok("Hold: the hub does nothing more with it", hold.ok && q1?.state === "HELD" && q1.hold?.gate === "manual" && /^Held by Kyle Smith: client asked to wait\.$/.test(q1.note ?? "") && lname("L-Q").videos.length === 0, `${hold.message} ${q1?.state} ${q1?.note}`);
    const rel = await V.releaseVideoPush(Q.cuts[0].sub, "Kyle Smith");
    await tick(3);
    const q2 = await runOf(Q.cuts[0].sub);
    c.ok("Release: it carries on, uploads AND delivers", rel.ok && q2?.state === "DONE" && lname("L-Q").videos.length === 1 && kinds("deliver", "L-Q").length === 1, `${q2?.state} ${q2?.note}`);

    // ======================================================================
    c.head("13b · runs waiting on a person (Oct 20 2026, audit B4)");
    {
      // Waiting for Deliver now, then the version is reopened for revisions.
      const R = await mkJob("102 Reopened Wait Ln", "L-R", { cut: false });
      const dR = await prisma.deliverable.findFirstOrThrow({ where: { projectId: R.project.id } });
      const R1 = await mkCut(R.project.id, dR.id, "102 Reopened Wait Ln");
      await prisma.reviewSubmission.update({ where: { id: R1.sub }, data: { status: "SUPERSEDED", sentToClientAt: new Date(T - 3 * HOUR), sentToClientBy: "Kyle Smith" } });
      lname("L-R").videos.push({ id: v7(T - 3 * HOUR), title: "Cinematic Video", duration: 59.6, visibleAfter: 0, playableAfter: 0, ucUuid: null });
      const R2 = await mkCut(R.project.id, dR.id, "102 Reopened Wait Ln", { round: 2, duration: 62 });
      await press(R2.sub);
      await tick(3);
      c.ok("set-up: on the listing, waiting for Deliver now", (await runOf(R2.sub))?.wait?.gate === "kyle");
      await prisma.reviewSubmission.update({ where: { id: R2.sub }, data: { status: "CHANGES_REQUESTED" } });
      await tick(1);
      const r2 = await runOf(R2.sub);
      c.ok("a waiting run whose version was reopened stops, and nothing is delivered", r2?.state === "FAILED" && /no longer approved/.test(r2.note ?? "") && kinds("deliver", "L-R").length === 0, `${r2?.state} ${r2?.note}`);
      // Forty runs parked on a person, older than a new press: the new one still moves.
      for (let i = 0; i < 40; i++) {
        await prisma.appSetting.create({ data: { key: `video_aryeo_push:parked-${i}`, value: JSON.stringify({ submissionId: `parked-${i}`, projectId: R.project.id, state: "WAITING", wait: { gate: "kyle", why: "fixture", since: new Date(T - 9 * HOUR).toISOString() }, recheckAt: null, pauseUntil: null }) } });
      }
      const S = await mkJob("103 Behind The Queue Rd", "L-S");
      await press(S.cuts[0].sub);
      await tick(1);
      const s1 = await runOf(S.cuts[0].sub);
      c.ok("forty runs waiting on a person never crowd a newly pressed upload out of the cron", !!s1 && s1.state !== "PREPARING", `${s1?.state} ${s1?.note}`);
      await prisma.appSetting.deleteMany({ where: { key: { startsWith: "video_aryeo_push:parked-" } } });
    }

    // ======================================================================
    c.head("14 · the board and the counts (each video once per number; monthly apart)");
    const now = new Date();
    await mkJob("120 Late Lane", "L-late", { cut: false, status: "EDITING", shootDate: new Date(T - 5 * 24 * HOUR), pin: new Date(T - 3 * HOUR) });
    const testClient = await prisma.client.create({ data: { name: "Jordan Spackman TEST" } });
    await mkJob("130 Test Client Rd", "L-test", { cut: false, status: "EDITING", clientId: testClient.id, shootDate: new Date(T - 5 * 24 * HOUR), pin: new Date(T - 3 * HOUR) });
    const { etDayKey, etAt } = await import("@/lib/datetime");
    const tonight = etAt(etDayKey(now), 23, 0);
    const canTestToday = tonight.getTime() - now.getTime() > 30 * MIN;
    if (canTestToday) await mkJob("140 Today Terrace", "L-today", { cut: false, status: "EDITING", shootDate: new Date(T - 30 * HOUR), pin: new Date(T + 20 * MIN) });
    await mkJob("150 Ready Rd", "L-ready", { pin: new Date(T - 2 * HOUR) });
    await mkJob("160 Rendering Rd", "L-rend", { topaz: { state: "processing", outputCheck: null } });
    const { videoDeliveryBoard, videoSummary, dueTodayRows } = await import("@/lib/videoDelivery");
    const board = await videoDeliveryBoard({ now });
    const all = Object.values(board.lanes).flat();
    const streetsIn = (lane: keyof typeof board.lanes) => board.lanes[lane].map((r) => r.street);
    c.ok("a video past its promise is in Late, with how late", streetsIn("late").includes("120 Late Lane") && /^Late by \d+ (h|days)/.test(board.lanes.late.find((r) => r.street === "120 Late Lane")!.promiseWords), board.lanes.late.map((r) => `${r.street}: ${r.promiseWords}`).join(" | "));
    if (canTestToday) c.ok("a video due tonight is in Due today", streetsIn("today").includes("140 Today Terrace"), streetsIn("today").join(", "));
    c.ok("test clients are left out", !all.some((r) => r.street === "130 Test Client Rd"));
    c.ok("held rows say why (the sound check)", board.lanes.held.some((r) => r.street === "80 Silent St" && /no sound/.test(r.heldWhy ?? "")) && board.lanes.held.some((r) => r.street === "85 Held Render Rd" && !!r.heldRender), board.lanes.held.map((r) => `${r.street}: ${r.heldWhy}`).join(" | "));
    const ready150 = board.lanes.sending.find((r) => r.street === "150 Ready Rd");
    c.ok("an approved video nobody pressed is Ready to send, with the button's facts (and late, marked)", !!ready150?.send && ready150.send.byHandWhy === null && ready150.push?.canStart === true && !ready150.push.state && ready150.late && ready150.send.openAsks.length === 0, JSON.stringify(ready150?.send));
    c.ok("a video still in the 1080p pass is Finishing, not Ready to send", streetsIn("finishing").includes("160 Rendering Rd") && !streetsIn("sending").includes("160 Rendering Rd"));
    c.ok("delivered this week lists what the hub delivered", ["10 First Ave", "20 Parts Pl", "60 Pair Dr"].every((s) => streetsIn("delivered").includes(s)), streetsIn("delivered").join(", "));
    c.ok("monthly videos are not listing rows", !all.some((r) => r.street === "Monthly Agent Content"));
    c.ok("every video sits in one lane", new Set(all.map((r) => r.key)).size === all.length);
    // Oct 20 2026 (audit B6): videoDeliveryCounts had no reader; the board's own counts.
    const counts = board.counts;
    const owed = all.filter((r) => r.lane !== "delivered");
    const lateN = owed.filter((r) => r.late).length;
    const dueN = owed.filter((r) => r.dueToday).length;
    c.ok("late = listing videos past their promise, once each (approved ones too)", counts.lateListing === lateN && counts.behind === lateN && lateN >= 2 && (counts.oldestLateHours ?? 0) >= 2, JSON.stringify(counts));
    c.ok("due today = due by tonight, the late ones included, once each (Jordan's rule)", counts.dueToday === dueN && counts.dueToday === dueTodayRows(board).length && counts.dueToday >= counts.lateListing, `${counts.dueToday} vs ${dueN}`);
    c.ok("monthly never in the listing numbers", counts.behind === counts.lateListing && !owed.some((r) => r.street === "Monthly Agent Content"));
    c.ok("ready to send = the Ready to send section", counts.readyToSend === board.lanes.sending.length && counts.open === new Set([...board.lanes.sending, ...board.lanes.held, ...dueTodayRows(board)].map((r) => r.key)).size);
    const summary = await videoSummary(now);
    c.ok("Home's summary box reads the same numbers", summary.readyToSend === counts.readyToSend && summary.late === counts.lateListing && summary.dueToday === counts.dueToday, JSON.stringify(summary));

    // ======================================================================
    c.head("15 · the add's intent and the add in one pass");
    const N = await mkJob("170 One Pass Rd", "L-N");
    await press(N.cuts[0].sub);
    // Stop it just before the add: the 1080p file is at Aryeo's upload service.
    await V.advanceVideoPush(N.cuts[0].sub, { budgetMs: 60_000 });
    const nAfter = await runOf(N.cuts[0].sub);
    c.ok("(set-up) one press, one pass: through to the check", nAfter?.state === "CHECKING" && !!nAfter.addSentAt && kinds("add", "L-N").length === 1, nAfter?.state);
    {
      // Oct 19 2026: Aryeo refused the short shape on the first two real presses.
      const sent = (calls.filter((x) => x.kind === "add" && x.listing === "L-N").pop()?.body ?? null) as { videos?: { uuid?: string; url?: string; filename?: string; size?: number; titleValue?: string; displayType?: string; uploadProgress?: number; video_title?: string; display_type?: string }[] } | null;
      const v0 = sent?.videos?.[0];
      c.ok("the add sends the Add Video window's whole file record (title, display type, file size, name, id) as well as the short one",
        !!v0 && v0.size === nAfter?.file.size && !!v0.titleValue && v0.titleValue === v0.video_title && v0.displayType === "both" && v0.display_type === "both" && !!v0.uuid && v0.url?.includes(v0.uuid) === true && v0.filename === nAfter?.file.name && v0.uploadProgress === 100,
        JSON.stringify(v0));
    }
    const N2 = await mkJob("175 Short Pass Rd", "L-N2");
    await press(N2.cuts[0].sub);
    // Walk it to ADDING without an intent: PREPARING then SENDING in a long pass, but stopped before the add.
    await patchRun(N2.cuts[0].sub, { state: "ADDING", addSentAt: null, upload: { ...(await runOf(N2.cuts[0].sub))!.upload, fileUuid: "uc-short" }, fingerprint: null });
    const fpN2 = (await import("@/lib/finalRendition")).sourceFingerprint((await (await import("@/lib/finalRendition")).loadCut(N2.cuts[0].sub))!);
    ucFiles.set("uc-short", { name: "x.mp4", size: 300_000, bytes: Buffer.alloc(300_000), parts: [], duration: 59.6 });
    await patchRun(N2.cuts[0].sub, { fingerprint: fpN2, listingId: "L-N2", projectId: N2.project.id, title: "Cinematic Video" });
    const addsBefore = kinds("add", "L-N2").length;
    await V.advanceVideoPush(N2.cuts[0].sub, { budgetMs: 20_000 });
    const n2a = await runOf(N2.cuts[0].sub);
    c.ok("with less than 30 s of the pass left, the intent is not saved (nothing sent)", n2a?.state === "ADDING" && !n2a.addSentAt && kinds("add", "L-N2").length === addsBefore, `${n2a?.state} ${n2a?.addSentAt}`);
    await V.advanceVideoPush(N2.cuts[0].sub, { budgetMs: 60_000 });
    const n2b = await runOf(N2.cuts[0].sub);
    c.ok("the next pass saves the intent AND makes the add (never split across passes)", n2b?.state === "CHECKING" && !!n2b.addSentAt && !!n2b.addedAt && Date.parse(n2b.addedAt) - Date.parse(n2b.addSentAt) < 60_000 && kinds("add", "L-N2").length === addsBefore + 1, `${n2b?.state}`);

    // ======================================================================
    c.head("16 · a video another run claimed is never 'the new one'");
    const P = await mkJob("180 Claimed Ct", "L-P", { videos: 2 });
    await press(P.cuts[0].sub);
    await tick(3);
    const p1 = await runOf(P.cuts[0].sub);
    // The second video's run, checking, with the first one's video looking "new" to it by time and length.
    await press(P.cuts[1].sub);
    await patchRun(P.cuts[1].sub, { state: "CHECKING", before: [], addSentAt: new Date(Date.now() - 20 * MIN).toISOString(), addedAt: new Date(Date.now() - 20 * MIN).toISOString(), mediaId: null, listingId: "L-P", projectId: P.project.id, file: { path: P.cuts[1].path, name: "x.mp4", size: 300_000, durationSec: 59.6, contentType: "video/mp4" } });
    await V.advanceVideoPush(P.cuts[1].sub, { budgetMs: 30_000 });
    const p2 = await runOf(P.cuts[1].sub);
    c.ok("the first run's video is not taken by the second run's check", !!p1?.mediaId && p2?.state === "CHECKING" && p2.mediaId !== p1.mediaId && !p2.mediaId, `${p1?.mediaId} vs ${p2?.mediaId} (${p2?.state} ${p2?.note})`);

    // ======================================================================
    c.head("17 · a 'not yet' gate ends the pass (no busy loop)");
    const R = await mkJob("190 Not Yet Way", "L-R");
    await press(R.cuts[0].sub);
    await patchRun(R.cuts[0].sub, { state: "ADDING", addSentAt: null, listingId: "L-R", projectId: R.project.id });
    await prisma.topazJob.update({ where: { id: R.cuts[0].job }, data: { state: "saving" } });
    const t0 = Date.now();
    const writes0 = (await runOf(R.cuts[0].sub))!.updatedAt;
    await V.advanceVideoPush(R.cuts[0].sub, { budgetMs: 60_000 });
    const took = Date.now() - t0;
    const r1 = await runOf(R.cuts[0].sub);
    c.ok("the pass ends at once with the reason (it used to spin until its time ran out)", took < 8_000 && r1?.state === "ADDING" && /has not finished yet/.test(r1.note ?? ""), `${took} ms · ${r1?.state} ${r1?.note}`);
    await V.advanceVideoPush(R.cuts[0].sub, { budgetMs: 60_000 });
    const r2 = await runOf(R.cuts[0].sub);
    c.ok("a second pass with nothing new writes nothing but the lease", r2?.note === r1?.note && r2?.state === "ADDING" && writes0 !== r1?.updatedAt);
    await prisma.topazJob.update({ where: { id: R.cuts[0].job }, data: { state: "done" } });

    // ======================================================================
    c.head("18 · a row with a person's upload receipt and no run");
    const U = await mkJob("200 Hand Upload Ln", "L-U");
    const { recordUploaded } = await import("@/lib/deliveryUploads");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    const fpU = sourceFingerprint((await loadCut(U.cuts[0].sub))!)!;
    lname("L-U").videos.push({ id: v7(Date.now() - MIN), title: "Cinematic Video", duration: 59.6, visibleAfter: 0, playableAfter: 0, ucUuid: null });
    const recU = await recordUploaded(U.cuts[0].sub, { id: null, name: "Kyle Smith" }, fpU);
    const rowU = (await readyToSend({ projectId: U.project.id })).ready[0];
    c.ok("(set-up) Kyle's Mark as Uploaded is recorded", recU.ok && !!rowU?.uploaded, recU.message);
    c.ok("the line is the hand path (who uploaded it, send it in Aryeo, Mark as sent), never 'the hub sends it'", !!rowU?.push && rowU.push.state === null && /On the Aryeo listing already \(uploaded by Kyle Smith\)/.test(rowU.push.says) && /Mark as sent/.test(rowU.push.says) && !hubIsSending(rowU) && rowU.push.handledByHub === false, rowU?.push?.says);
    const addsU = kinds("add", "L-U").length;
    await press(U.cuts[0].sub);
    await tick(2);
    const u1 = await runOf(U.cuts[0].sub);
    c.ok("a press on it (Send) delivers without a second upload", u1?.state === "DONE" && kinds("add", "L-U").length === addsU && kinds("from_url").every((x) => !String(x.body).includes("Hand%20Upload")) && kinds("deliver", "L-U").length === 1, `${u1?.state} ${u1?.note}`);

    // ======================================================================
    c.head("19 · another run's delivery claim is never taken over while it lives");
    const W = await mkJob("210 Claim Way", "L-W", { videos: 2 });
    // Photos going up on the listing hold both videos on the listing, undelivered.
    await prisma.appSetting.create({ data: { key: "photo_aryeo_push:job-w", value: JSON.stringify({ id: "pw", listingId: "L-W", state: "SENDING", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    await press(W.cuts[0].sub);
    await press(W.cuts[1].sub);
    await tick(6);
    const w0 = await runOf(W.cuts[0].sub);
    const w1 = await runOf(W.cuts[1].sub);
    c.ok("(set-up) both on the listing, waiting behind the photos", !!w0?.mediaId && !!w1?.mediaId && w0.state === "WAITING" && w1.state === "WAITING", `${w0?.state} ${w1?.state}`);
    await prisma.appSetting.update({ where: { key: "photo_aryeo_push:job-w" }, data: { value: JSON.stringify({ id: "pw", listingId: "L-W", state: "DONE", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    // Set the stage: run 0 holds a "sending" claim and is still delivering (a slow Deliver); run 1 is ready to deliver.
    const claimAt = new Date(Date.now() - 10 * MIN).toISOString();
    await prisma.appSetting.upsert({ where: { key: "video_aryeo_deliver:L-W" }, create: { key: "video_aryeo_deliver:L-W", value: JSON.stringify({ state: "sending", at: claimAt, submissionId: W.cuts[0].sub, runId: w0!.id }) }, update: { value: JSON.stringify({ state: "sending", at: claimAt, submissionId: W.cuts[0].sub, runId: w0!.id }) } });
    await patchRun(W.cuts[0].sub, { state: "DELIVERING", lease: { token: "someone-else", until: Date.now() + 10 * MIN }, deliverNow: true, wait: null });
    await patchRun(W.cuts[1].sub, { state: "DELIVERING", deliverNow: false, wait: null, mediaAt: new Date(Date.now() - 20 * MIN).toISOString(), addedAt: new Date(Date.now() - 20 * MIN).toISOString() });
    const delW = kinds("deliver", "L-W").length;
    await V.advanceVideoPush(W.cuts[1].sub, { budgetMs: 30_000 });
    const w1a = await runOf(W.cuts[1].sub);
    c.ok("a claim older than 3 minutes is NOT taken over from a live run (it used to be)", w1a?.state === "DELIVERING" && /being delivered right now/.test(w1a.note ?? "") && kinds("deliver", "L-W").length === delW, `${w1a?.state} ${w1a?.note} · ${w1?.state}`);
    await patchRun(W.cuts[0].sub, { state: "FAILED", lease: null, note: "stopped" });
    await V.advanceVideoPush(W.cuts[1].sub, { budgetMs: 30_000 });
    const w1b = await runOf(W.cuts[1].sub);
    const claimW = JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: "video_aryeo_deliver:L-W" } })).value) as { state: string };
    c.ok("its run moved on without settling it: 'may have gone', never re-sent by the hub", kinds("deliver", "L-W").length === delW && claimW.state === "uncertain" && w1b?.state === "CONFIRMING" && w1b.deliverUncertain === true, `${w1b?.state} ${w1b?.note} · claim ${claimW.state}`);

    // ======================================================================
    c.head("20 · Aryeo refuses the login in the middle of Deliver");
    const X = await mkJob("220 Locked Out Rd", "L-X");
    lockOutAfterDeliver = true;
    await press(X.cuts[0].sub);
    await tick(3);
    const x1 = await runOf(X.cuts[0].sub);
    c.ok("'may have gone': CONFIRMING, one Deliver, never a FAILED run waiting to try again", x1?.state === "CONFIRMING" && x1.deliverUncertain === true && kinds("deliver", "L-X").length === 1 && !x1.retryAfter, `${x1?.state} ${x1?.note}`);
    loginRefused = false;
    await patchRun(X.cuts[0].sub, { deliveredAt: new Date(Date.now() - 16 * MIN).toISOString() });
    await tick(3);
    const x2 = await runOf(X.cuts[0].sub);
    c.ok("the cron never sends it again; a person is asked to look", x2?.state === "WAITING" && x2.wait?.gate === "kyle" && kinds("deliver", "L-X").length === 1, `${x2?.state} ${x2?.note}`);
    const xNow = await V.deliverVideoNow(X.cuts[0].sub, "Kyle Smith");
    c.ok("Deliver now (a person) sends it", xNow.ok && (await runOf(X.cuts[0].sub))?.state === "DONE" && kinds("deliver", "L-X").length === 2, xNow.message);

    // ======================================================================
    c.head("21 · a sign-in failure of a started run is tried again; an older FAILED record never is");
    const Y = await mkJob("230 Login Retry Rd", "L-Y");
    await prisma.appSetting.create({ data: { key: "photo_aryeo_push:job-y", value: JSON.stringify({ id: "py", listingId: "L-Y", state: "SENDING", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    await press(Y.cuts[0].sub);
    await tick(3);
    c.ok("(set-up) on the listing, waiting behind the photos", (await runOf(Y.cuts[0].sub))?.state === "WAITING");
    await prisma.appSetting.update({ where: { key: "photo_aryeo_push:job-y" }, data: { value: JSON.stringify({ id: "py", listingId: "L-Y", state: "DONE", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    validSessions.clear();
    loginRefused = true;
    await forceRecheck(Y.cuts[0].sub);
    await tick();
    const y1 = await runOf(Y.cuts[0].sub);
    c.ok("stopped on Aryeo's login before Deliver (nothing sent), saying it tries again in 30 minutes", y1?.state === "FAILED" && /did not accept the hub's login/.test(y1.note ?? "") && /tries again in 30 minutes/.test(y1.note ?? "") && !!y1.retryAfter && y1.loginRetries === 0 && kinds("deliver", "L-Y").length === 0, `${y1?.state} ${y1?.note}`);
    await tick();
    c.ok("…and not before its 30 minutes", (await runOf(Y.cuts[0].sub))?.state === "FAILED");
    loginRefused = false;
    await patchRun(Y.cuts[0].sub, { retryAfter: new Date(Date.now() - 1000).toISOString() });
    // An older FAILED record (no loginRetries field), due: never picked up.
    const Z = await mkJob("240 Old Record Rd", "L-Z");
    await prisma.appSetting.create({ data: { key: `video_aryeo_push:${Z.cuts[0].sub}`, value: JSON.stringify({ id: "old1", submissionId: Z.cuts[0].sub, projectId: Z.project.id, listingId: "L-Z", state: "FAILED", note: "The 1080p file was never checked.", retryAfter: new Date(Date.now() - HOUR).toISOString(), by: "hub", mode: "shadow", upload: { parts: [] }, replace: [], updatedAt: new Date().toISOString() }) } });
    const drove = await V.driveVideoPushes({ budgetMs: 60_000 });
    await tick(3);
    const y2 = await runOf(Y.cuts[0].sub);
    c.ok("the started run was tried again once the login worked, and delivered (no second upload)", drove.started.includes(Y.cuts[0].sub) && y2?.state === "DONE" && kinds("deliver", "L-Y").length === 1 && kinds("add", "L-Y").length === 1 && (y2.loginRetries ?? 0) === 1, `${JSON.stringify(drove.started)} ${y2?.state} ${y2?.note}`);
    c.ok("the older FAILED record was left alone (nothing for 240 Old Record Rd)", !drove.started.includes(Z.cuts[0].sub) && (await runOf(Z.cuts[0].sub))?.id === "old1" && kinds("add", "L-Z").length === 0);

    // ======================================================================
    c.head("22 · Try again after the file changed takes the earlier try's video off");
    const AA = await mkJob("250 New Export Ave", "L-AA");
    await prisma.appSetting.create({ data: { key: "photo_aryeo_push:job-aa", value: JSON.stringify({ id: "pa", listingId: "L-AA", state: "SENDING", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    await press(AA.cuts[0].sub);
    await tick(3);
    const aa1 = await runOf(AA.cuts[0].sub);
    c.ok("(set-up) on the listing, waiting behind the photos", aa1?.state === "WAITING" && !!aa1.mediaId, `${aa1?.state}`);
    // A new export of the same version: a new 1080p file.
    const newPath = AA.cuts[0].path.replace("FINAL", "FINAL v2");
    dropbox.set(newPath, { bytes: Buffer.alloc(320_000, 7), duration: 58.1 });
    await prisma.topazJob.update({ where: { id: AA.cuts[0].job }, data: { finalPath: newPath, savedAt: new Date(), sourceDurationSec: 58.1 } });
    await prisma.appSetting.update({ where: { key: "photo_aryeo_push:job-aa" }, data: { value: JSON.stringify({ id: "pa", listingId: "L-AA", state: "DONE", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
    await forceRecheck(AA.cuts[0].sub);
    await tick();
    const aa2 = await runOf(AA.cuts[0].sub);
    c.ok("the file changed after it went up: stopped before delivering, saying to press Try again", aa2?.state === "FAILED" && /press Try again/.test(aa2.note ?? "") && kinds("deliver", "L-AA").length === 0, `${aa2?.state} ${aa2?.note}`);
    const retryAA = await V.retryVideoPush(AA.cuts[0].sub, "Kyle Smith");
    await tick(4);
    const aa3 = await runOf(AA.cuts[0].sub);
    const la2 = lname("L-AA");
    c.ok("Try again remembered the earlier video, took it off, and sent the new one once", retryAA.ok && aa3?.state === "DONE" && kinds("delete", "L-AA").map((x) => x.body).includes(aa1!.mediaId) && !la2.videos.some((v) => v.id === aa1!.mediaId) && la2.videos.length === 1 && kinds("deliver", "L-AA").length === 1, `${aa3?.state} ${aa3?.note} · ${la2.videos.length} on listing`);

    // ======================================================================
    // Oct 23 2026 (Jordan: "give an option to upload to Aryeo without
    // sending"). The press itself, the row, Send now, Send all, the gates and
    // the roles are drilled end to end in oct23-video-upload-only.ts; here,
    // the two cron paths that drill does not reach.
    c.head("23 · Upload to Aryeo only: the cron's login retry keeps it; a sibling video never waits for it");
    const UO = await mkJob("260 Upload Only Rd", "L-UO");
    await disconnect("aryeo_web");
    const uo0 = await V.requestVideoPush(UO.cuts[0].sub, { by: "Kyle Smith", uploadOnly: true });
    await saveLogin();
    // Stamped the way a sign-in failure of a started run is (retryAfter, loginRetries).
    await patchRun(UO.cuts[0].sub, { retryAfter: new Date(Date.now() - 1000).toISOString(), loginRetries: 0 });
    c.ok("(set-up) an upload-only press stopped on the login, due for the cron's retry", !uo0.started && (await runOf(UO.cuts[0].sub))?.mode === "upload");
    const droveUO = await V.driveVideoPushes({ budgetMs: 60_000 });
    await tick(4);
    const uo1 = await runOf(UO.cuts[0].sub);
    c.ok("the cron's retry repeats 'upload only': on the listing, never delivered", droveUO.started.includes(UO.cuts[0].sub) && uo1?.mode === "upload" && V.isUploadedOnly(uo1) && !!uo1.mediaId && lname("L-UO").videos.length === 1 && kinds("deliver", "L-UO").length === 0, `${uo1?.state} ${uo1?.note}`);
    const rowUO = (await readyToSend({ projectId: UO.project.id })).ready[0];
    c.ok("…its row: On Aryeo, not sent yet, Send now (no upload press), and no 'send it now' alert while it waits", !!rowUO?.push?.uploadedOnly && rowUO.push.canDeliverNow && !rowUO.push.canStart && /^On Aryeo, not sent yet/.test(rowUO.push.says) && /^On Aryeo, not sent yet · 260 Upload Only Rd$/.test(deliveryReadyMessage(rowUO, "https://hub.test").title), rowUO?.push?.says);
    const SIB = await mkJob("270 Sibling Way", "L-SIB", { videos: 2 });
    await V.requestVideoPush(SIB.cuts[1].sub, { by: "Kyle Smith", uploadOnly: true });
    // The upload-only one is still on its way (sending, paused): before Oct 23 the other one waited up to two hours for it.
    await patchRun(SIB.cuts[1].sub, { state: "SENDING", pauseUntil: new Date(Date.now() + HOUR).toISOString(), listingId: "L-SIB", projectId: SIB.project.id });
    await press(SIB.cuts[0].sub);
    await tick(4);
    const sib0 = await runOf(SIB.cuts[0].sub);
    c.ok("a sibling's full send does not wait for the upload-only video (it is not going to the client with it)", sib0?.state === "DONE" && kinds("deliver", "L-SIB").length === 1 && (await runOf(SIB.cuts[1].sub))?.state === "SENDING", `${sib0?.state} ${sib0?.note}`);

    c.head("isolation");
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

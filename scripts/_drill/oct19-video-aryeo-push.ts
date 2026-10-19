// ---------------------------------------------------------------------------
// DRILL: listing videos into Aryeo by the hub (Oct 19 2026, lib/videoAryeoPush
// + integrations/aryeoWeb video calls + lib/videoDelivery).
//
// Jordan: "Any videos that get approved should be uploaded and delivered once
// approved and back from Topaz ... with the login retries and things like that."
//
// Fakes, answered in-process, shaped like Aryeo's web app (read from its code
// on Oct 19: the Add Video window, Uploadcare under the video key through
// upload.aryeo.com, the listing page's videos, Delete, Deliver Listing),
// Uploadcare's from_url and multipart APIs, Aryeo's public API (the listing as
// the hub reads it back, the new video processing for a while), and Dropbox
// (a temporary link, range reads of the 1080p file).
//    1  off by default: nothing runs
//    2  practice run (shadow): one line per video, nothing called
//    3  upload and deliver: from_url, the Add Video call's exact body, the
//       check waits for the new video (processing), Re-deliver once, then the
//       receipts: the hub's upload, the send, the 1080p job, Kyle's task, the
//       client notice
//    4  multipart fallback when from_url is refused, resumed across passes
//    5  Aryeo signs the hub out in the middle of the add: never sent again
//    6  an ambiguous add (500 after Aryeo made it; a request that never got
//       there): never sent again by the hub; a person's Retry checks first
//    7  a revision (V2): only the hub's own V1 comes off; Kyle's video stays;
//       the listing's cooldown
//    8  a job owing two videos: ONE delivery
//    9  held by an open client ask (never uploaded), then released
//   10  held by the sound check, and by a held 1080p file
//   11  a photo push sending on the same listing defers; its delivery covers
//   12  monthly videos are never touched
//   13  upload only: waits for Kyle's Deliver now; Hold / Release
//   14  the board and the counts (test clients left out)
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
    if (b.email !== LOGIN.email || b.password !== LOGIN.password) return redirect("https://app.aryeo.com/login");
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
    const b = JSON.parse(String(init?.body)) as { video_title: unknown; display_type: string; video_url: unknown; videos: { url: string; video_title: string; display_type: string }[] };
    calls.push({ kind: "add", listing: l.id, body: b });
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
    const { saveSecret } = await import("@/lib/integrations/connections");
    const S = await import("@/lib/videoDeliverySettings");
    const V = await import("@/lib/videoAryeoPush");
    const { readyToSend } = await import("@/lib/readyToSend");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await saveSecret("aryeo_web", LOGIN.password, { accountLabel: LOGIN.email, metadata: { email: LOGIN.email } });

    // The client's open asks and the sound check, per job/cut (the real ones read other lanes' tables and the file's header).
    const asksFor = new Map<string, { id: string; summary: string; askedBy: string | null; askedAtISO: string; medium: string | null }[]>();
    const soundFor = new Map<string, { verdict: "hold"; reason: string; message: string; av: null }>();
    V.__setVideoPushHooksForTests({
      openAsks: async (pid) => asksFor.get(pid) ?? [],
      soundCheck: async (sid) => soundFor.get(sid) ?? { verdict: "ok", message: "The finished file has sound, and it lines up with the picture.", av: null },
      sleep: async () => {},
    });
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
    const mkJob = async (street: string, listingId: string, opts: { videos?: number; size?: number; clientId?: string; monthly?: boolean; status?: string; shootDate?: Date; pin?: Date; cut?: boolean } = {}) => {
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
        if (opts.cut !== false) cuts.push(await mkCut(project.id, d.id, street, { size: opts.size, slot: 1, round: 1 }));
      }
      return { project, cuts };
    };
    const tick = async (n = 1) => {
      for (let i = 0; i < n; i++) await V.driveVideoPushes({ budgetMs: 60_000 });
    };
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
    c.head("1 · off by default");
    const A = await mkJob("10 First Ave", "L-A");
    c.ok("the switch is Off until Jordan turns it on", (await S.videoDeliverySettings()).aryeoPush === "off");
    const d0 = await V.driveVideoPushes({ budgetMs: 30_000 });
    const r0 = await V.requestVideoPush(A.cuts[0].sub);
    c.ok("nothing runs and nothing is called", !!d0.skipped && !r0.ok && /switched off/.test(r0.message) && outbound() === 0 && !(await runOf(A.cuts[0].sub)), `${d0.skipped} · ${r0.message}`);

    // ======================================================================
    c.head("2 · practice run (shadow): one line, nothing called");
    await setMode("shadow");
    const before2 = outbound();
    await tick();
    const shadow = await runOf(A.cuts[0].sub);
    c.ok("a practice line for the approved video", shadow?.state === "SHADOW" && /^Practice run: would upload about 1 MB \(.*FINAL \(Topaz\)\.mp4\) to the Aryeo listing for 10 First Ave, then re-deliver the listing/.test(shadow.note ?? "") && /Nothing was sent\.$/.test(shadow.note ?? ""), shadow?.note ?? "");
    c.ok("…and nothing reached Aryeo, Uploadcare or Dropbox", outbound() === before2, `${outbound() - before2} calls`);
    const rowA = (await readyToSend({ projectId: A.project.id })).ready[0];
    c.ok("the delivery card row says so instead of 'upload by hand'", rowA?.push?.mode === "shadow" && /Practice run/.test(rowA.push.says) && rowA.push.handledByHub === false, rowA?.push?.says);
    await tick();
    c.ok("written once per file (a second pass changes nothing)", (await runOf(A.cuts[0].sub))?.updatedAt === shadow?.updatedAt && outbound() === before2);

    // ======================================================================
    c.head("3 · upload and deliver: from_url, the add, the check, one Re-deliver, the receipts");
    await setMode("deliver");
    await tick();
    const a1 = await runOf(A.cuts[0].sub);
    const fromUrl = kinds("from_url")[0];
    c.ok("the 1080p file went to Aryeo's VIDEO upload key by a temporary Dropbox link (no bytes through the hub)", !!fromUrl && String(fromUrl.body).startsWith("https://dl.drill.invalid/") && kinds("mp-start").length === 0 && kinds("dropbox-read").length === 0);
    const add = kinds("add", "L-A")[0]?.body as { video_title: unknown; display_type: string; video_url: unknown; videos: { url: string; video_title: string; display_type: string }[] } | undefined;
    c.ok("Add Video was called the way the listing editor calls it", !!add && add.video_title === null && add.display_type === "both" && add.video_url === null && add.videos.length === 1 && /^https:\/\/aryeo\.ucarecd\.net\/uc-\d+\/$/.test(add.videos[0].url) && add.videos[0].display_type === "both" && add.videos[0].video_title === "Cinematic Video", JSON.stringify(add));
    c.ok("every change said where it came from (Aryeo bounces one that doesn't)", kinds("no-origin").length === 0);
    c.ok("the check waits while Aryeo processes the new video", a1?.state === "CHECKING" && /processing/.test(a1.note ?? "") && kinds("deliver", "L-A").length === 0, `${a1?.state} ${a1?.note}`);
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
    c.ok("the job's timeline carries the hub's lines", (await prisma.activity.count({ where: { projectId: A.project.id, body: { startsWith: "Video to Aryeo:" } } })) >= 2);
    c.ok("the row has left the delivery card", (await readyToSend({ projectId: A.project.id })).ready.length === 0);

    // ======================================================================
    c.head("4 · from_url refused: the multipart upload, resumed across passes");
    refuseFromUrl = true;
    V.__setVideoPushHooksForTests({ openAsks: async (pid) => asksFor.get(pid) ?? [], soundCheck: async (sid) => soundFor.get(sid) ?? { verdict: "ok", message: "ok", av: null }, sleep: async () => {}, partsPerPass: 2 });
    const B = await mkJob("20 Parts Pl", "L-B", { size: 2 * 5 * MIB + 1234 });
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
    V.__setVideoPushHooksForTests({ openAsks: async (pid) => asksFor.get(pid) ?? [], soundCheck: async (sid) => soundFor.get(sid) ?? { verdict: "ok", message: "ok", av: null }, sleep: async () => {} });

    // ======================================================================
    c.head("5 · Aryeo signs the hub out in the middle of the add");
    const C = await mkJob("30 Bounce Ct", "L-C");
    const logins0 = kinds("login").length;
    bounceAfterAdd = true;
    await tick(3);
    const cRun = await runOf(C.cuts[0].sub);
    c.ok("signed back in once, the add NOT sent again, the check found it, delivered", kinds("add", "L-C").length === 1 && lname("L-C").videos.length === 1 && kinds("login").length - logins0 === 1 && cRun?.state === "DONE", `adds=${kinds("add", "L-C").length} logins=${kinds("login").length - logins0} ${cRun?.state} ${cRun?.note}`);

    // ======================================================================
    c.head("6 · an ambiguous add is never sent again by the hub");
    const D = await mkJob("40 Five Hundred Rd", "L-D");
    add500.add("L-D");
    await tick(3);
    const dRun = await runOf(D.cuts[0].sub);
    c.ok("Aryeo made the video, then answered 500: one add, one video, delivered", kinds("add", "L-D").length === 1 && lname("L-D").videos.length === 1 && dRun?.state === "DONE", `${dRun?.state} ${dRun?.note}`);
    const E = await mkJob("50 Dropped Ln", "L-E");
    neverReaches.add("L-E");
    const attempts0 = addAttempts;
    await tick();
    const e1 = await runOf(E.cuts[0].sub);
    c.ok("the connection dropped during the add: the hub checks instead of adding again", e1?.state === "CHECKING" && addAttempts - attempts0 === 1 && lname("L-E").videos.length === 0, `${e1?.state} ${e1?.note}`);
    await tick(2);
    await patchRun(E.cuts[0].sub, { addSentAt: new Date(Date.now() - 61 * MIN).toISOString(), addedAt: new Date(Date.now() - 61 * MIN).toISOString() });
    await tick();
    const e2 = await runOf(E.cuts[0].sub);
    c.ok("nothing appeared within the hour: stopped for a person, still one attempt", e2?.state === "FAILED" && /Retry checks the listing again before it sends anything/.test(e2.note ?? "") && addAttempts - attempts0 === 1 && lname("L-E").videos.length === 0, `${e2?.state} ${e2?.note}`);
    const retryE = await V.retryVideoPush(E.cuts[0].sub, "Kyle");
    await tick(3);
    const e3 = await runOf(E.cuts[0].sub);
    c.ok("Kyle's Retry looked at the listing first, found nothing, and sent it once", retryE.ok && e3?.state === "DONE" && kinds("add", "L-E").length === 1 && lname("L-E").videos.length === 1, `${retryE.message} · ${e3?.state} ${e3?.note}`);

    const F = await mkJob("55 Unsure Deliver Way", "L-F");
    bounceAfterDeliver = true;
    await tick(3);
    const f1 = await runOf(F.cuts[0].sub);
    c.ok("signed out in the middle of Deliver: not sent again, the hub waits for Aryeo's word", f1?.state === "CONFIRMING" && f1.deliverUncertain === true && kinds("deliver", "L-F").length === 1, `${f1?.state} ${f1?.note}`);
    await patchRun(F.cuts[0].sub, { deliveredAt: new Date(Date.now() - 16 * MIN).toISOString() });
    await tick();
    const f2 = await runOf(F.cuts[0].sub);
    c.ok("no word from Aryeo in 15 minutes: Kyle looks (still one Deliver)", f2?.state === "WAITING" && f2.wait?.gate === "kyle" && /cannot tell whether the email went/.test(f2.note ?? "") && kinds("deliver", "L-F").length === 1 && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: F.cuts[0].sub } })).sentToClientAt, `${f2?.state} ${f2?.note}`);
    const fNow = await V.deliverVideoNow(F.cuts[0].sub, "Kyle");
    const f3 = await runOf(F.cuts[0].sub);
    c.ok("Kyle's Deliver now sends it (his word, not a hub retry)", fNow.ok && f3?.state === "DONE" && kinds("deliver", "L-F").length === 2, `${fNow.message} ${f3?.state}`);

    // ======================================================================
    c.head("7 · a revision: only the hub's own earlier video comes off; the cooldown");
    const kyleVideo: Vid = { id: v7(Date.now() - 2 * HOUR), title: "Kyle's walkthrough", duration: 75, visibleAfter: 0, playableAfter: 0, ucUuid: null };
    lname("L-A").videos.unshift(kyleVideo);
    const v1Media = a2!.mediaId!;
    const dA = await prisma.deliverable.findFirstOrThrow({ where: { projectId: A.project.id } });
    const A2 = await mkCut(A.project.id, dA.id, "10 First Ave", { round: 2, duration: 61.2 });
    await setMode("deliver", 20);
    await tick(4);
    const a2r = await runOf(A2.sub);
    c.ok("V2 went up; the listing was delivered minutes ago, so it waits for the cooldown", a2r?.state === "WAITING" && a2r.wait?.gate === "cooldown" && /re-delivering at/.test(a2r.note ?? "") && kinds("deliver", "L-A").length === 1, `${a2r?.state} ${a2r?.note}`);
    const deletes = kinds("delete", "L-A").map((x) => x.body);
    const la = lname("L-A");
    c.ok("only the hub's own V1 came off; Kyle's video stays", JSON.stringify(deletes) === JSON.stringify([v1Media]) && la.videos.some((v) => v.id === kyleVideo.id) && !la.videos.some((v) => v.id === v1Media) && la.videos.some((v) => v.id === a2r?.mediaId), `${JSON.stringify(deletes)} · ${la.videos.map((v) => v.title).join(" | ")}`);
    await setMode("deliver", 0);
    await forceRecheck(A2.sub);
    await tick(2);
    const a2d = await runOf(A2.sub);
    c.ok("after the cooldown: re-delivered once more, V2 recorded sent", a2d?.state === "DONE" && kinds("deliver", "L-A").length === 2 && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A2.sub } })).sentToClientAt, `${a2d?.state} ${a2d?.note}`);

    // ======================================================================
    c.head("8 · a job owing two videos is delivered ONCE");
    const G = await mkJob("60 Pair Dr", "L-G", { videos: 2 });
    await tick(3);
    const g1 = await runOf(G.cuts[0].sub);
    const g2 = await runOf(G.cuts[1].sub);
    c.ok("both on the listing; the first waited for the second (one email)", lname("L-G").videos.length === 2 && kinds("deliver", "L-G").length <= 1, `${g1?.state}/${g1?.wait?.gate} ${g2?.state}/${g2?.wait?.gate}`);
    for (const s of [G.cuts[0].sub, G.cuts[1].sub]) if ((await runOf(s))?.state === "WAITING") await forceRecheck(s);
    await tick(2);
    const g1b = await runOf(G.cuts[0].sub);
    const g2b = await runOf(G.cuts[1].sub);
    c.ok("one Re-deliver for the listing, both videos recorded sent", kinds("deliver", "L-G").length === 1 && g1b?.state === "DONE" && g2b?.state === "DONE" && [g1b, g2b].some((r) => r?.deliveredBy === "earlier"), `${kinds("deliver", "L-G").length} ${g1b?.state}/${g1b?.deliveredBy} ${g2b?.state}/${g2b?.deliveredBy}`);

    // ======================================================================
    c.head("9 · held by an open client ask (Heather's lot lines)");
    const H = await mkJob("70 Lot Lines Way", "L-H", { cut: false });
    asksFor.set(H.project.id, [{ id: "ask-1", summary: "All 4 lots overlaid like the Pennfield output", askedBy: "Heather", askedAtISO: new Date().toISOString(), medium: "video" }]);
    const dH = await prisma.deliverable.findFirstOrThrow({ where: { projectId: H.project.id } });
    const H1 = await mkCut(H.project.id, dH.id, "70 Lot Lines Way");
    const linksBefore = kinds("dropbox-link").length;
    await tick();
    const h1 = await runOf(H1.sub);
    c.ok("HELD, in plain words, before anything is uploaded (the listing is already delivered, so a video there is visible)", h1?.state === "HELD" && h1.hold?.gate === "asks" && /^Waiting on Kyle to confirm 1 client ask \("All 4 lots overlaid like the Pennfield output"\)\.$/.test(h1.note ?? "") && kinds("from_url").every((x) => !String(x.body).includes("Lot%20Lines")) && kinds("dropbox-link").length === linksBefore && lname("L-H").videos.length === 0, `${h1?.state} ${h1?.note}`);
    const { deliveryReadyMessage, hubIsSending } = await import("@/lib/deliveryReadyMessage");
    const rowH = (await readyToSend({ projectId: H.project.id })).ready[0];
    const msgH = deliveryReadyMessage(rowH, "https://hub.test");
    c.ok("Kyle's alert says it is held and why (not 'upload now')", !hubIsSending(rowH) && /^Held · 70 Lot Lines Way$/.test(msgH.title) && /Waiting on Kyle to confirm 1 client ask/.test(msgH.body), `${msgH.title} · ${msgH.body}`);
    asksFor.delete(H.project.id);
    await forceRecheck(H1.sub);
    await tick(3);
    const h2 = await runOf(H1.sub);
    c.ok("Kyle confirmed it: the hub carries on by itself and delivers", h2?.state === "DONE" && kinds("deliver", "L-H").length === 1, `${h2?.state} ${h2?.note}`);

    // ======================================================================
    c.head("10 · held by the sound check");
    const I = await mkJob("80 Silent St", "L-I", { cut: false });
    const dI = await prisma.deliverable.findFirstOrThrow({ where: { projectId: I.project.id } });
    const I1 = await mkCut(I.project.id, dI.id, "80 Silent St");
    soundFor.set(I1.sub, { verdict: "hold", reason: "this video has no sound", message: "Held: this video has no sound.", av: null });
    await tick();
    const i1 = await runOf(I1.sub);
    c.ok("the final file has no sound: HELD with the reason, nothing sent", i1?.state === "HELD" && i1.hold?.gate === "sound" && /^Sound check held this file: this video has no sound\./.test(i1.note ?? "") && lname("L-I").videos.length === 0 && kinds("from_url").length === kinds("from_url").filter((x) => !String(x.body).includes("Silent")).length, `${i1?.state} ${i1?.note}`);
    const I2job = await mkJob("85 Held Render Rd", "L-I2", { cut: false });
    const dI2 = await prisma.deliverable.findFirstOrThrow({ where: { projectId: I2job.project.id } });
    const I2 = await mkCut(I2job.project.id, dI2.id, "85 Held Render Rd", { topaz: { state: "held", outputCheck: "unverified" } });
    await tick();
    const i2 = await V.requestVideoPush(I2.sub);
    c.ok("a 1080p file the Topaz check held is never sent (the cron does not pick it; asked directly it holds)", !(await runOf(I2.sub))?.mediaId && !i2.started && /Sound check held this file: it has no sound at all/.test(i2.message), i2.message);
    const rowsI2 = (await readyToSend({ projectId: I2job.project.id })).rendering;
    c.ok("the held row on the card says what is wrong with the sound", rowsI2[0]?.held?.lastCheck === "Last check: it has no sound at all, and neither has the editor's export." && /its sound is wrong/.test(rowsI2[0]?.says ?? ""), `${rowsI2[0]?.says} · ${rowsI2[0]?.held?.lastCheck}`);

    // ======================================================================
    c.head("11 · a photo push on the same listing");
    const J = await mkJob("90 Photos Too Blvd", "L-J");
    await prisma.appSetting.create({ data: { key: "photo_aryeo_push:job-j", value: JSON.stringify({ id: "p1", listingId: "L-J", state: "SENDING", updatedAt: new Date().toISOString(), deliveredAt: null }) } });
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
    const outM = outbound();
    await tick();
    const mDirect = await V.requestVideoPush(M.cuts[0].sub);
    c.ok("a program video: no run, no record, no call", monthly && !(await runOf(M.cuts[0].sub)) && !mDirect.ok && /client's portal/.test(mDirect.message) && kinds("from_url").every((x) => !String(x.body).includes("Monthly")) && lname("L-M").videos.length === 0, `${monthly} ${mDirect.message} (${outbound() - outM} other calls)`);

    // ======================================================================
    c.head("13 · upload only: Kyle presses Deliver now; Hold and Release");
    await setMode("upload");
    const K = await mkJob("100 Upload Only Pkwy", "L-K");
    await tick(3);
    const k1 = await runOf(K.cuts[0].sub);
    const rowK = (await readyToSend({ projectId: K.project.id })).ready[0];
    c.ok("on the listing, waiting for Kyle; nothing delivered", k1?.state === "WAITING" && k1.wait?.gate === "kyle" && kinds("deliver", "L-K").length === 0 && rowK?.push?.canDeliverNow === true && rowK.push.waitingForKyle === true, `${k1?.state} ${k1?.note}`);
    c.ok("his alert says to press Deliver now", /^On Aryeo, deliver now · 100 Upload Only Pkwy$/.test(deliveryReadyMessage(rowK, "https://hub.test").title));
    const dn = await V.deliverVideoNow(K.cuts[0].sub, "Kyle");
    const k2 = await runOf(K.cuts[0].sub);
    c.ok("Deliver now: one Re-deliver, recorded sent", dn.ok && k2?.state === "DONE" && kinds("deliver", "L-K").length === 1, `${dn.message} ${k2?.state}`);
    const Q = await mkJob("110 Hold Me Ct", "L-Q");
    const hold = await V.holdVideoPush(Q.cuts[0].sub, "Kyle", "client asked to wait");
    await tick(2);
    const q1 = await runOf(Q.cuts[0].sub);
    c.ok("Kyle's Hold: the hub does nothing more with it", hold.ok && q1?.state === "HELD" && q1.hold?.gate === "manual" && /^Held by Kyle: client asked to wait\.$/.test(q1.note ?? "") && lname("L-Q").videos.length === 0, `${hold.message} ${q1?.state} ${q1?.note}`);
    const rel = await V.releaseVideoPush(Q.cuts[0].sub, "Kyle");
    await tick(3);
    const q2 = await runOf(Q.cuts[0].sub);
    c.ok("Release: it carries on (upload only: to the listing, then waits for Deliver now)", rel.ok && q2?.state === "WAITING" && q2.wait?.gate === "kyle" && lname("L-Q").videos.length === 1, `${q2?.state} ${q2?.note}`);

    // ======================================================================
    c.head("14 · the board and the counts (test clients left out)");
    await setMode("deliver");
    const now = new Date();
    await mkJob("120 Late Lane", "L-late", { cut: false, status: "EDITING", shootDate: new Date(T - 5 * 24 * HOUR), pin: new Date(T - 3 * HOUR) });
    const testClient = await prisma.client.create({ data: { name: "Jordan Spackman TEST" } });
    await mkJob("130 Test Client Rd", "L-test", { cut: false, status: "EDITING", clientId: testClient.id, shootDate: new Date(T - 5 * 24 * HOUR), pin: new Date(T - 3 * HOUR) });
    const { etDayKey, etAt } = await import("@/lib/datetime");
    const tonight = etAt(etDayKey(now), 23, 0);
    const canTestToday = tonight.getTime() - now.getTime() > 30 * MIN;
    if (canTestToday) await mkJob("140 Today Terrace", "L-today", { cut: false, status: "EDITING", shootDate: new Date(T - 30 * HOUR), pin: new Date(T + 20 * MIN) });
    const { videoDeliveryBoard, videoDeliveryCounts } = await import("@/lib/videoDelivery");
    const board = await videoDeliveryBoard({ now });
    const all = Object.values(board.lanes).flat();
    const streetsIn = (lane: keyof typeof board.lanes) => board.lanes[lane].map((r) => r.street);
    c.ok("a video past its promise is in Late, with how late", streetsIn("late").includes("120 Late Lane") && /^Late by \d+ (h|days)/.test(board.lanes.late.find((r) => r.street === "120 Late Lane")!.promiseWords), board.lanes.late.map((r) => `${r.street}: ${r.promiseWords}`).join(" | "));
    if (canTestToday) c.ok("a video due tonight is in Due today", streetsIn("today").includes("140 Today Terrace"), streetsIn("today").join(", "));
    c.ok("test clients are left out", !all.some((r) => r.street === "130 Test Client Rd"));
    c.ok("held rows say why (the sound check)", board.lanes.held.some((r) => r.street === "80 Silent St" && /no sound/.test(r.heldWhy ?? "")) && board.lanes.held.some((r) => r.street === "85 Held Render Rd"), board.lanes.held.map((r) => `${r.street}: ${r.heldWhy}`).join(" | "));
    c.ok("approved and going out shows the hub's progress (Kyle's Deliver now on the upload-only one)", board.lanes.sending.some((r) => r.street === "110 Hold Me Ct" && r.push?.canDeliverNow === true));
    c.ok("delivered this week lists what the hub delivered", ["10 First Ave", "20 Parts Pl", "60 Pair Dr"].every((s) => streetsIn("delivered").includes(s)), streetsIn("delivered").join(", "));
    c.ok("monthly videos are not listing rows", !all.some((r) => r.street === "Monthly Agent Content"));
    const counts = await videoDeliveryCounts(now);
    const late = all.filter((r) => r.late && r.lane !== "delivered").length;
    c.ok("the counts come from the same board: late, behind, due today", counts.lateListing === late && counts.behind === counts.lateListing + counts.lateMonthly && counts.dueToday >= counts.lateListing && counts.lateListing >= 1 && (counts.oldestLateHours ?? 0) >= 3, JSON.stringify(counts));
    c.ok("the program section read cleanly", board.program.unavailable === false);

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

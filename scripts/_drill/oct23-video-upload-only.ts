// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: "UPLOAD TO ARYEO ONLY" (Jordan, Oct 23 2026, looking at a Ready to
// send row: "give an option to upload to Aryeo without sending").
//
// lib/videoAryeoPush (mode "upload": the same run, stopped on the listing in
// WAITING until a person's Send now), review/videoSendActions (the press and
// Send now, requireAdmin), the Video Review Room's row and the job page's
// Video card (lib/jobsBoard + JobDeliverables), rendered to HTML. Every press
// goes through the REAL server action as a signed-in person.
//    1  Upload to Aryeo only: the 1080p file goes on the faked listing, the
//       check, the hub's upload receipt, and Aryeo's Deliver is NEVER called;
//       the cron never sends it; a later "Upload to Aryeo and send" press
//       does not send it either
//    2  the row: "On Aryeo, not sent yet" with Send now (no upload button),
//       on the room and on the job page; a fresh row offers both presses; the
//       creative manager sees neither; nobody is alerted to send it
//    3  Send all skips the uploaded-only row (even when its id is handed in)
//    4  Send now delivers ONCE: the receipts (sent stamp, 1080p job, Kyle's
//       task, the notice), never a second upload; a second press sends nothing
//    5  the gates still refuse: an open client request (before the upload,
//       and again at Send now), the sound check, the 1080p file never checked,
//       no Aryeo login (Try again repeats "upload only"), a program video
//    6  a newer version replaces the earlier uploaded-only video the same way
//       the full push does (only the hub's own video comes off); Hold and
//       Release never send it
//    7  the roles: Jordan and Kyle press both; James (creative manager) and an
//       editor are refused both; view-as is refused
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7333). Aryeo's web app, Uploadcare, Aryeo's public API and Dropbox are
// answered in-process at the fence; nothing leaves.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree, quietPrismaErrors } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
class Redirect extends Error {
  constructor(readonly href: string) {
    super(`redirect ${href}`);
  }
}
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.redirect = (href: string) => {
    throw new Redirect(href);
  };
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/review";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 7333);
const LOGIN = { email: "hub@realtourpilot.com", password: "drill-hub-password" };
const UC_KEY = "c0ffee0123456789abcd";
const UC_VIDEO_KEY = "fa1dbeef0123456789ab";
const MIN = 60_000;
const HOUR = 60 * MIN;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");

// ---- the fakes (the shapes oct19-video-aryeo-push.ts reads from Aryeo's web app) ----------
type Vid = { id: string; title: string; duration: number | null; visibleAfter: number; playableAfter: number };
type Listing = { id: string; videos: Vid[]; reads: number; deliveries: number };
const listings = new Map<string, Listing>();
const calls: { kind: string; listing?: string; body?: unknown }[] = [];
const ucFiles = new Map<string, { size: number; duration: number | null }>();
const tokens = new Map<string, { path: string; polls: number }>();
const dropbox = new Map<string, { size: number; duration: number }>();
let sessionSeq = 0;
let seq = 0;
const validSessions = new Set<string>();
const pendingSessions = new Set<string>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}
const cookiesOf = (init?: RequestInit) => Object.fromEntries((new Headers(init?.headers).get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const redirectTo = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const v7 = (ms: number) => {
  const t = Math.floor(ms).toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-${(++seq).toString(16).padStart(12, "0")}`;
};
const lname = (id: string) => listings.get(id)!;
const editPage = (l: Listing) => ({
  component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`,
  props: {
    errors: {},
    listing: { id: l.id, delivery_status: "delivered", customer_team_memberships: [{ id: `ctm-${l.id}`, customer_user: { full_name: "Agent" } }] },
    images: [],
    videos: { data: l.videos.map((v) => ({ uuid: v.id, id: v.id, title: v.title, duration: v.duration, created_at: new Date().toISOString() })) },
    company: { default_enable_mark_orders_fulfilled: false, default_timezone: "America/New_York" },
    image_uploads_require_media_license: false,
  },
});

async function aryeoWeb(url: string, init?: RequestInit): Promise<Response | null> {
  const u = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const h = new Headers(init?.headers);
  const ck = cookiesOf(init);
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/login") {
    if (method === "GET") {
      if (h.get("x-inertia") === "true") return json({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: { errors: {} } });
      const page = JSON.stringify({ component: "Company/Core/Login/ShowLogin", version: "v1", url: "/login", props: {} }).replace(/"/g, "&quot;");
      return withCookies(new Response(`<html><script>window.UPLOADCARE_PUBLIC_KEY = "${UC_KEY}"; window.ARYEO_UPLOADCARE_VIDEO_PUBLIC_KEY = "${UC_VIDEO_KEY}";</script><div id="app" data-page="${page}"></div></html>`, { status: 200, headers: { "content-type": "text/html" } }), ["XSRF-TOKEN=tok%3D%3D; path=/; domain=.aryeo.com", "aryeo_session=anon; path=/; domain=.aryeo.com; httponly"]);
    }
    calls.push({ kind: "login" });
    if (h.get("x-xsrf-token") !== "tok==" || ck.aryeo_session !== "anon") return new Response("CSRF token mismatch", { status: 419 });
    const b = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (b.email !== LOGIN.email || b.password !== LOGIN.password) return redirectTo("https://app.aryeo.com/login");
    const s = `auth-${++sessionSeq}`;
    pendingSessions.add(s);
    return withCookies(new Response(null, { status: 409, headers: { "x-inertia-location": "https://app.aryeo.com/companies" } }), [`aryeo_session=${s}; path=/; domain=.aryeo.com; httponly`, "XSRF-TOKEN=tok2%3D%3D; path=/; domain=.aryeo.com"]);
  }
  if (u.origin === "https://app.aryeo.com" && u.pathname === "/companies") {
    const sess = ck.aryeo_session ?? "";
    if (!pendingSessions.has(sess) && !validSessions.has(sess)) return redirectTo("https://app.aryeo.com/login");
    pendingSessions.delete(sess);
    validSessions.add(sess);
    return redirectTo("https://realtourpilot.aryeo.com/admin/dashboard");
  }
  if (u.origin !== "https://realtourpilot.aryeo.com") return null;
  if (!validSessions.has(ck.aryeo_session ?? "")) return redirectTo("https://app.aryeo.com/login");
  if (method !== "GET" && h.get("x-xsrf-token") !== "tok2==") return new Response("CSRF", { status: 419 });
  if (u.pathname === "/admin/dashboard") return json({ component: "Company/Core/Dashboard/ShowDashboard", version: "v1", url: "/admin/dashboard", props: { errors: {} } });
  let m = /^\/admin\/listings\/([^/]+)\/edit$/.exec(u.pathname);
  if (m && method === "GET") {
    const l = listings.get(m[1]);
    if (!l) return new Response("nope", { status: 404 });
    if ((h.get("x-inertia-partial-data") ?? "").split(",").includes("delivery_email")) {
      return json({ component: "Company/Listings/EditListing", version: "v1", url: `/admin/listings/${l.id}/edit`, props: { delivery_email: { email_subject: "Your listing media is ready!", email_body: "<p>Your video is ready.</p>", email_cc_list: "", email_bcc_list: "office@realtourpilot.com" } } });
    }
    return json(editPage(l));
  }
  m = /^\/admin\/listing\/([^/]+)\/videos$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = lname(m[1]);
    const b = JSON.parse(String(init?.body)) as { videos: { url: string; video_title: string; titleValue?: string; displayType?: string; size?: number }[] };
    calls.push({ kind: "add", listing: l.id, body: b });
    if (!b.videos?.every((v) => !!v.titleValue && !!v.displayType && typeof v.size === "number" && v.size > 0)) return redirectTo(`/admin/listings/${l.id}/edit`);
    const uuid = /^https:\/\/aryeo\.ucarecd\.net\/([^/]+)\/$/.exec(b.videos?.[0]?.url ?? "")?.[1];
    const f = uuid ? ucFiles.get(uuid) : null;
    if (!f) return redirectTo(`/admin/listings/${l.id}/edit`);
    l.videos.push({ id: v7(Date.now()), title: b.videos[0].video_title, duration: f.duration, visibleAfter: l.reads + 1, playableAfter: l.reads + 2 });
    return redirectTo(`/admin/listings/${l.id}/edit`);
  }
  m = /^\/admin\/videos\/([^/]+)$/.exec(u.pathname);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    const l = [...listings.values()].find((x) => x.videos.some((v) => v.id === id));
    calls.push({ kind: "delete", listing: l?.id, body: id });
    if (!l) return new Response("nope", { status: 404 });
    l.videos = l.videos.filter((v) => v.id !== id);
    return redirectTo(`/admin/listings/${l.id}/edit`, 303);
  }
  m = /^\/admin\/listings\/([^/]+)\/deliver$/.exec(u.pathname);
  if (m && method === "POST") {
    const l = lname(m[1]);
    calls.push({ kind: "deliver", listing: l.id, body: JSON.parse(String(init?.body)) });
    l.deliveries++;
    return redirectTo(`/admin/listings/${l.id}/edit`);
  }
  return new Response("not faked", { status: 404 });
}

function uploadcare(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  if (u.origin !== "https://upload.aryeo.com") return null;
  const form = init?.body instanceof FormData ? init.body : null;
  if (u.pathname === "/from_url/") {
    calls.push({ kind: "from_url", body: form?.get("source_url") });
    if (form?.get("pub_key") !== UC_VIDEO_KEY) return json({ detail: "pub_key is invalid" }, 403);
    const src = String(form.get("source_url") ?? "");
    const token = `tok-${++seq}`;
    tokens.set(token, { path: decodeURIComponent(src.slice("https://dl.drill.invalid/".length)), polls: 0 });
    return json({ type: "token", token });
  }
  if (u.pathname === "/from_url/status/") {
    const t = tokens.get(u.searchParams.get("token") ?? "");
    if (!t) return json({ status: "unknown" });
    if (++t.polls < 2) return json({ status: "progress", done: 1, total: 2 });
    const d = dropbox.get(t.path)!;
    const uuid = `uc-${++seq}`;
    ucFiles.set(uuid, { size: d.size, duration: d.duration });
    return json({ status: "success", uuid, file_id: uuid, is_ready: true });
  }
  if (u.pathname === "/info/") {
    const f = ucFiles.get(u.searchParams.get("file_id") ?? "");
    return f ? json({ is_ready: true, size: f.size, mime_type: "video/mp4" }) : json({ detail: "no" }, 404);
  }
  return null;
}

function aryeoApi(url: string): Response | null {
  if (!url.startsWith("https://api.aryeo.com/v1/listings/")) return null;
  const l = listings.get(new URL(url).pathname.split("/")[3]);
  if (!l) return json({ message: "Not found" }, 404);
  l.reads++;
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
    return json({ link: `https://dl.drill.invalid/${encodeURIComponent(path)}`, metadata: { size: f.size } });
  }
  return null;
}

const fence = fenceFetch(async (url, init) =>
  (await aryeoWeb(url, init)) ?? uploadcare(url, init) ?? aryeoApi(url) ?? dropboxFake(url, init) ??
  (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

const kinds = (kind: string, listing?: string) => calls.filter((x) => x.kind === kind && (!listing || x.listing === listing));

async function main() {
  if (!(await portFree(PORT))) throw new Error(`Fixture port ${PORT} is busy; existing process left untouched`);
  const db = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "oct23-video-upload-only", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret, disconnect } = await import("@/lib/integrations/connections");
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    const saveLogin = () => saveSecret("aryeo_web", LOGIN.password, { accountLabel: LOGIN.email, metadata: { email: LOGIN.email } });
    await saveLogin();
    const V = await import("@/lib/videoAryeoPush");
    const A = await import("@/app/review/videoSendActions");
    const { readyToSend } = await import("@/lib/readyToSend");
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    const { deliveryReadyMessage } = await import("@/lib/deliveryReadyMessage");

    // The client's open requests and the sound check, per job / cut.
    const asksFor = new Map<string, { id: string; summary: string; askedBy: string | null; askedAtISO: string; medium: string | null }[]>();
    const soundFor = new Map<string, { verdict: "hold"; reason: string; message: string; av: null }>();
    V.__setVideoPushHooksForTests({
      openAsks: async (pid: string) => asksFor.get(pid) ?? [],
      soundCheck: async (sid: string) => soundFor.get(sid) ?? { verdict: "ok" as const, message: "The finished file has sound.", av: null },
      sleep: async () => {},
    });

    // ---- the people ----
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const jordan = await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "jordan@drill.test", role: "OWNER", status: "ACTIVE" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", email: "james@drill.test", role: "PHOTOGRAPHER", creativeManager: true } });
    const james = await prisma.appUser.create({ data: { name: "James Livingston", email: "james@drill.test", role: "CREATIVE_MANAGER", status: "ACTIVE", teamMemberId: jamesTm.id } });
    const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.test", role: "EDITOR" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim Miguel", email: "kim@drill.test", role: "EDITOR", status: "ACTIVE", teamMemberId: kimTm.id } });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyleTm.id, appUserId: kyle.id } });
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    await as(kyle);

    // ---- the jobs ----
    const agent = await prisma.client.create({ data: { name: "Upload Only Realty" } });
    const T = Date.now();
    let orders = 0;
    const mkCut = async (projectId: string, deliverableId: string, street: string, opts: { round?: number; duration?: number; outputCheck?: string | null } = {}) => {
      const round = opts.round ?? 1;
      const path = `/Listings/${street}/05-Final-Video/${street} v${round} - FINAL (Topaz).mp4`;
      dropbox.set(path, { size: 300_000 + round, duration: opts.duration ?? 59.6 });
      const sub = await prisma.reviewSubmission.create({
        data: { projectId, deliverableId, slot: 1, round, status: "APPROVED", fileName: `${street} v${round}.mp4`, blobUrl: `https://drill.invalid/${encodeURIComponent(street)}-${round}.mp4`, sizeBytes: 300_000, decidedAt: new Date(T - 40 * MIN), decidedBy: "Jordan" },
      });
      const task = await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: `Upload the 1080p video to Aryeo: ${street}`, projectId, dedupeKey: `topaz-deliver-${sub.id}`, status: "OPEN", assignedKey: "kyle" } });
      const job = await prisma.topazJob.create({
        data: { submissionId: sub.id, projectId, state: "done", fileName: sub.fileName, sourceDurationSec: opts.duration ?? 59.6, sourceSizeBytes: 300_000, savedAt: new Date(T - 10 * MIN), finishedAt: new Date(T - 10 * MIN), finalPath: path, outputCheck: opts.outputCheck === undefined ? "verified" : opts.outputCheck, taskId: task.id },
      });
      return { sub: sub.id, job: job.id, task: task.id, path };
    };
    const mkJob = async (street: string, listingId: string, opts: { monthly?: boolean; outputCheck?: string | null } = {}) => {
      let contentMonthId: string | null = null;
      // A program video belongs to a client of its own (the listing agent stays a listing client).
      const clientId = opts.monthly ? (await prisma.client.create({ data: { name: "Monthly Program Agent" } })).id : agent.id;
      if (opts.monthly) {
        const enr = await prisma.contentEnrollment.create({ data: { clientId, package: "Starter", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } });
        contentMonthId = (await prisma.contentMonth.create({ data: { enrollmentId: enr.id, clientId, monthKey: "2026-10", videosOwed: 4 } })).id;
      }
      const project = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId, status: "REVIEW", aryeoListingId: listingId, aryeoOrderId: `ord-${++orders}`, contentMonthId, shootDate: new Date(T - 2 * 24 * HOUR) } });
      await prisma.orderItem.create({ data: { projectId: project.id, title: "Cinematic Video", amount: 150 } });
      listings.set(listingId, listings.get(listingId) ?? { id: listingId, videos: [], reads: 0, deliveries: 0 });
      const d = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 1, productTitle: "Cinematic Video" } });
      await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: project.id, slot: 1, category: "VIDEO" } });
      const cut = await mkCut(project.id, d.id, street, { outputCheck: opts.outputCheck });
      return { project, d, ...cut };
    };
    const tick = async (n = 1) => {
      for (let i = 0; i < n; i++) await V.driveVideoPushes({ budgetMs: 60_000 });
    };
    const runOf = (sid: string) => V.videoPushRun(sid);
    const forceRecheck = async (sid: string) => {
      const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: `video_aryeo_push:${sid}` } });
      await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ ...JSON.parse(row.value), recheckAt: new Date(Date.now() - 1000).toISOString(), pauseUntil: null }) } });
    };
    const activity = (projectId: string, contains: string) => prisma.activity.count({ where: { projectId, body: { contains } } });

    // ======================================================================
    c.head("1 · Upload to Aryeo only: on the listing, never delivered");
    const U = await mkJob("300 Only Ln", "L-U");
    const pU = await A.sendVideoToAryeoAction(U.sub, { uploadOnly: true });
    const u0 = await runOf(U.sub);
    c.ok("Kyle's press starts it, saying nothing goes to the client until Send now", pU.ok && pU.started === true && /Uploading it to the Aryeo listing only\. Nothing goes to the client until you press Send now\./.test(pU.message), pU.message);
    c.ok("…an upload-only run (mode upload), pressed by Kyle", u0?.mode === "upload" && u0.by === "Kyle Smith", `${u0?.mode} ${u0?.by}`);
    await tick(4);
    const u1 = await runOf(U.sub);
    c.ok("the 1080p file went up: from_url, ONE Add Video, the video is on the faked listing", kinds("from_url").some((x) => String(x.body).includes("300%20Only%20Ln")) && kinds("add", "L-U").length === 1 && !!u1?.mediaId && lname("L-U").videos.some((v) => v.id === u1.mediaId), `${u1?.state} adds=${kinds("add", "L-U").length}`);
    c.ok("it stops on the listing: WAITING for a person, 'On Aryeo, not sent yet'", u1?.state === "WAITING" && u1.wait?.gate === "kyle" && V.isUploadedOnly(u1) && /^On Aryeo, not sent yet\. Aryeo has not emailed the client: press Send now to send it\.$/.test(u1.note ?? ""), `${u1?.state} ${u1?.note}`);
    c.ok("Aryeo's Deliver was NEVER called", kinds("deliver", "L-U").length === 0 && lname("L-U").deliveries === 0);
    const { uploadsFor } = await import("@/lib/deliveryUploads");
    const recU = (await uploadsFor([U.sub])).get(U.sub) as { actor: string; mediaIds?: string[] } | undefined;
    c.ok("the same upload receipt as the full send: the hub, with the video's id", recU?.actor === "the hub" && recU.mediaIds?.[0] === u1?.mediaId, JSON.stringify(recU));
    const subU0 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: U.sub } });
    const jobU0 = await prisma.topazJob.findUniqueOrThrow({ where: { id: U.job } });
    const taskU0 = await prisma.smartTask.findUniqueOrThrow({ where: { id: U.task } });
    c.ok("not recorded sent: no sent stamp, the 1080p job and Kyle's upload task stay open, no client notice", !subU0.sentToClientAt && !subU0.clientNoticeVia && !jobU0.deliveredAt && taskU0.status === "OPEN");
    c.ok("the job's timeline: who pressed it and that it is not sent", (await activity(U.project.id, "Kyle Smith pressed Upload to Aryeo only")) === 1 && (await activity(U.project.id, "On Aryeo, not sent yet")) === 1);
    await tick(3);
    c.ok("the cron never sends it (three more passes: still waiting, no Deliver)", (await runOf(U.sub))?.state === "WAITING" && kinds("deliver", "L-U").length === 0);
    const pUsend = await A.sendVideoToAryeoAction(U.sub);
    c.ok("an 'Upload to Aryeo and send' press on it sends nothing either: it points at Send now", !pUsend.started && /on the Aryeo listing, not sent yet\. Press Send now/.test(pUsend.message) && kinds("deliver", "L-U").length === 0 && kinds("add", "L-U").length === 1, pUsend.message);

    // ======================================================================
    c.head("2 · the row: On Aryeo, not sent yet, with Send now");
    const S = await mkJob("310 Send All Way", "L-S");
    const S2 = await mkJob("320 Second Fresh Ct", "L-S2");
    const rowU = (await readyToSend({ projectId: U.project.id })).ready[0];
    c.ok("the push line: uploaded only, Send now (Deliver now's press), no upload button, on the listing", !!rowU?.push && rowU.push.uploadedOnly && rowU.push.canDeliverNow && !rowU.push.canStart && !rowU.push.canRetry && rowU.push.progress === "on-listing" && rowU.push.mode === "upload" && /^On Aryeo, not sent yet/.test(rowU.push.says), JSON.stringify(rowU?.push));
    const board = await videoDeliveryBoard({ fresh: true });
    const bU = board.lanes.sending.find((r) => r.submissionId === U.sub);
    c.ok("the board keeps it under Ready to send, stage 'On Aryeo, not sent yet'", bU?.stage === "On Aryeo, not sent yet", `${bU?.lane} ${bU?.stage}`);
    const { default: Page } = await import("@/app/review/page");
    let h = "";
    try {
      h = html(await Page({ searchParams: Promise.resolve({}) }));
    } catch (e) {
      h = `ERROR ${String((e as Error)?.stack ?? e).slice(0, 800)}`;
    }
    /** The words on every button in a piece of the page. */
    const buttons = (frag: string) => [...frag.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim());
    const readyHtml = (() => {
      const a = h.indexOf(">Ready to send</h2>");
      // Oct 27 2026 (Jordan's Loom): With the editors is gone; Ready to send is followed by Sent this week (when
      // anything was sent) or the history link.
      const sent = h.indexOf(">Sent this week</h2>", a + 1);
      const b = sent > a ? sent : h.indexOf("History: approved and sent videos", a + 1);
      return a >= 0 && b > a ? h.slice(a, b) : "";
    })();
    const streets = ["300 Only Ln", "310 Send All Way", "320 Second Fresh Ct"];
    /** One Ready to send row: from its street's link to the next row's. */
    const rowHtml = (street: string) => {
      const a = readyHtml.indexOf(`>${street}</a>`);
      if (a < 0) return "";
      const ends = streets.filter((s) => s !== street).map((s) => readyHtml.indexOf(`>${s}</a>`, a + 1)).filter((i) => i > a);
      return readyHtml.slice(a, ends.length ? Math.min(...ends) : readyHtml.length);
    };
    const rU = rowHtml("300 Only Ln");
    c.ok("the room renders for Kyle", h.length > 2000 && !h.startsWith("ERROR") && readyHtml.length > 0, h.slice(0, 300));
    c.ok("the uploaded-only row says 'On Aryeo, not sent yet', and its one button is Send now", /On Aryeo, not sent yet\. Aryeo has not emailed the client/.test(text(rU)) && JSON.stringify(buttons(rU).filter((b) => !/^Watch it$|^Mark as sent$/.test(b))) === JSON.stringify(["Send now"]), `${JSON.stringify(buttons(rU))} · ${text(rU).slice(0, 300)}`);
    c.ok("…no upload button, no 'Deliver now', no Try again on it", !buttons(rU).some((b) => /Upload to Aryeo|Deliver now|Try again/.test(b)), JSON.stringify(buttons(rU)));
    const rS = rowHtml("310 Send All Way");
    c.ok("a fresh row offers the choice: Upload to Aryeo and send, and Upload to Aryeo only", buttons(rS).includes("Upload to Aryeo and send") && buttons(rS).includes("Upload to Aryeo only"), JSON.stringify(buttons(rS)));
    c.ok("Send all counts the two fresh rows, never the uploaded-only one", buttons(readyHtml).includes("Send all (2)"), JSON.stringify(buttons(readyHtml).filter((b) => /^Send all/.test(b))));
    // The job page's Video card (lib/jobsBoard + JobDeliverables), the office's view.
    await videoDeliveryBoard({ fresh: true });
    const { loadJobDeliverables, JobDeliverablesView, JobDeliverablesSection } = await import("@/components/jobs/JobDeliverables");
    const dU = (await loadJobDeliverables(U.project.id))!;
    const itemU = dU.data.video.items[0];
    c.ok("the job page's video row: 'Version 1 on Aryeo, not sent yet', Send now", itemU?.words === "Version 1 on Aryeo, not sent yet" && itemU.send?.sendNow === true && itemU.send.canPress === false, `${itemU?.words} ${JSON.stringify(itemU?.send)}`);
    const hU = html(createElement(JobDeliverablesView, dU));
    c.ok("…rendered: a Send now button on the job page, not the link to the room", /Version 1 on Aryeo, not sent yet/.test(text(hU)) && buttons(hU).includes("Send now") && !buttons(hU).some((b) => /Upload to Aryeo/.test(b)) && !/Send it in the Video Review Room/.test(text(hU)), `${JSON.stringify(buttons(hU))} · ${text(hU).slice(0, 300)}`);
    const dS = (await loadJobDeliverables(S.project.id))!;
    const hS = html(createElement(JobDeliverablesView, dS));
    c.ok("a fresh video on the job page offers the same choice", dS.data.video.items[0]?.send?.uploadOnly === true && buttons(hS).includes("Upload to Aryeo and send") && buttons(hS).includes("Upload to Aryeo only"), JSON.stringify(buttons(hS)));
    await as(james);
    const jamesU = html(await JobDeliverablesSection({ projectId: U.project.id }));
    const jamesS = html(await JobDeliverablesSection({ projectId: S.project.id }));
    c.ok("the creative manager's job page: no Send now, no upload press, the link to the room instead", !buttons(jamesU + jamesS).some((b) => /Send now|Upload to Aryeo/.test(b)) && /Send it in the Video Review Room/.test(text(jamesU)) && /Send it in the Video Review Room/.test(text(jamesS)), `${JSON.stringify(buttons(jamesU + jamesS))} · ${text(jamesU).slice(0, 200)}`);
    await as(kyle);
    const msgU = deliveryReadyMessage(rowU, "https://hub.test");
    c.ok("the alert wording, should anything read it: 'On Aryeo, not sent yet', never 'send it now'", /^On Aryeo, not sent yet · 300 Only Ln$/.test(msgU.title) && /Send now/.test(msgU.body) && !/Deliver now/.test(msgU.body), `${msgU.title} · ${msgU.body}`);
    const { notifyKyleDeliveryReady } = await import("@/lib/deliveryReadyNotify");
    const swept = await notifyKyleDeliveryReady().then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e }));
    const notes = await prisma.notification.findMany({ select: { title: true } });
    c.ok("the delivery alerts sweep tells nobody to send the uploaded-only video (the fresh one is announced)", swept.ok && !notes.some((n) => n.title.includes("300 Only Ln")) && notes.some((n) => n.title.includes("310 Send All Way")), swept.ok ? notes.map((n) => n.title).join(" | ") : String(swept.e?.message));

    // ======================================================================
    c.head("3 · Send all skips the uploaded-only row");
    const all = await A.sendAllVideosAction([U.sub, S.sub]);
    await tick(4);
    const s1 = await runOf(S.sub);
    c.ok("Send all (handed both ids) starts only the fresh one", all.ok && /^Sending 1 video to Aryeo\.$/.test(all.message), all.message);
    c.ok("…which uploads AND delivers", s1?.state === "DONE" && s1.mode === "deliver" && kinds("deliver", "L-S").length === 1, `${s1?.state} ${s1?.note}`);
    c.ok("the uploaded-only video is still waiting, never delivered", (await runOf(U.sub))?.state === "WAITING" && kinds("deliver", "L-U").length === 0);

    // ======================================================================
    c.head("4 · Send now delivers once");
    const now1 = await A.deliverVideoNowAction(U.sub);
    const u2 = await runOf(U.sub);
    const subU = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: U.sub } });
    const jobU = await prisma.topazJob.findUniqueOrThrow({ where: { id: U.job } });
    const taskU = await prisma.smartTask.findUniqueOrThrow({ where: { id: U.task } });
    c.ok("Send now: ONE Re-deliver of the listing, done", now1.ok && u2?.state === "DONE" && u2.deliveredBy === "hub" && kinds("deliver", "L-U").length === 1 && /^Uploaded and delivered by the hub at /.test(u2.note ?? ""), `${now1.message} · ${u2?.state} ${u2?.note}`);
    c.ok("…as the browser sends it (fulfil the orders, Aryeo's own email)", (kinds("deliver", "L-U")[0]?.body as Record<string, unknown> | undefined)?.notify_via_email === true && (kinds("deliver", "L-U")[0]?.body as Record<string, unknown>).fulfill_orders === true);
    c.ok("never a second upload", kinds("add", "L-U").length === 1 && lname("L-U").videos.length === 1);
    c.ok("the same receipts as the full send: sent stamp, the notice, the 1080p job and Kyle's task closed", subU.sentToClientBy === "Aryeo (delivered by the hub)" && !!subU.sentToClientAt && subU.clientNoticeVia === "aryeo-email" && !!jobU.deliveredAt && taskU.status === "COMPLETED");
    c.ok("the timeline says who pressed Send now", (await activity(U.project.id, "Kyle Smith pressed Send now")) === 1);
    const now2 = await A.deliverVideoNowAction(U.sub);
    await tick(2);
    c.ok("a second Send now sends nothing (still one Deliver)", now2.ok && kinds("deliver", "L-U").length === 1, now2.message);
    c.ok("the row has left Ready to send", (await readyToSend({ projectId: U.project.id })).ready.length === 0);

    // ======================================================================
    c.head("5 · the gates still refuse");
    // (a) an open client request: held BEFORE the upload (the listing is delivered, so a video there is visible).
    const G = await mkJob("330 Request Rd", "L-G");
    asksFor.set(G.project.id, [{ id: "ask-1", summary: "Show the new deck first", askedBy: "Agent", askedAtISO: new Date().toISOString(), medium: "video" }]);
    const linksBefore = kinds("dropbox-link").length;
    const pG = await A.sendVideoToAryeoAction(G.sub, { uploadOnly: true });
    const g0 = await runOf(G.sub);
    c.ok("an open client request holds 'upload only' too, before anything is uploaded", !pG.started && g0?.state === "HELD" && g0.hold?.gate === "asks" && g0.mode === "upload" && lname("L-G").videos.length === 0 && kinds("dropbox-link").length === linksBefore && /not sent to the client/.test(pG.message), `${pG.message} · ${g0?.state}`);
    asksFor.delete(G.project.id);
    await forceRecheck(G.sub);
    await tick(4);
    const g1 = await runOf(G.sub);
    c.ok("checked: it goes up by itself and stops there (still not sent)", g1?.state === "WAITING" && V.isUploadedOnly(g1) && lname("L-G").videos.length === 1 && kinds("deliver", "L-G").length === 0, `${g1?.state} ${g1?.note}`);
    // (a') a request that arrives after the upload: Send now re-checks it.
    asksFor.set(G.project.id, [{ id: "ask-2", summary: "Swap the music", askedBy: "Agent", askedAtISO: new Date().toISOString(), medium: "video" }]);
    const nowG = await A.deliverVideoNowAction(G.sub);
    const g2 = await runOf(G.sub);
    c.ok("Send now re-checks the gates: a new open request holds it, nothing delivered", g2?.state === "HELD" && g2.hold?.gate === "asks" && /Swap the music/.test(nowG.message) && kinds("deliver", "L-G").length === 0, `${nowG.message} · ${g2?.state}`);
    asksFor.delete(G.project.id);
    await forceRecheck(G.sub);
    await tick(2);
    c.ok("…once it is checked, the Send now a person pressed goes through, once", (await runOf(G.sub))?.state === "DONE" && kinds("deliver", "L-G").length === 1 && kinds("add", "L-G").length === 1);
    // (b) the sound check.
    const N = await mkJob("340 Silent St", "L-N");
    soundFor.set(N.sub, { verdict: "hold", reason: "this video has no sound", message: "Held: this video has no sound.", av: null });
    await A.sendVideoToAryeoAction(N.sub, { uploadOnly: true });
    await tick();
    const n1 = await runOf(N.sub);
    c.ok("the sound check holds it: nothing on the listing", n1?.state === "HELD" && n1.hold?.gate === "sound" && /no sound/.test(n1.note ?? "") && lname("L-N").videos.length === 0, `${n1?.state} ${n1?.note}`);
    // (c) the 1080p file rules.
    const X = await mkJob("350 Unchecked Ave", "L-X", { outputCheck: null });
    const pX = await A.sendVideoToAryeoAction(X.sub, { uploadOnly: true });
    c.ok("a 1080p file that was never checked is refused, saying why (nothing uploaded)", !pX.ok && !pX.started && /never checked/.test(pX.message) && lname("L-X").videos.length === 0 && !kinds("from_url").some((x) => String(x.body).includes("Unchecked")), pX.message);
    // (d) no Aryeo login; then Try again repeats "upload only".
    const L = await mkJob("360 Login Ln", "L-L");
    await disconnect("aryeo_web");
    const pL = await A.sendVideoToAryeoAction(L.sub, { uploadOnly: true });
    const l0 = await runOf(L.sub);
    c.ok("no Aryeo login: a stopped run that says why, still marked upload only", !pL.ok && l0?.state === "FAILED" && l0.mode === "upload" && /Aryeo login is not set up/.test(l0.note ?? ""), `${pL.message} · ${l0?.mode}`);
    c.ok("…the row offers Try again", !!(await readyToSend({ projectId: L.project.id })).ready[0]?.push?.canRetry);
    await saveLogin();
    const retryL = await A.sendVideoToAryeoAction(L.sub);
    await tick(4);
    const l1 = await runOf(L.sub);
    c.ok("Try again (no choice passed) repeats 'upload only': on the listing, not delivered", retryL.started === true && l1?.mode === "upload" && V.isUploadedOnly(l1) && lname("L-L").videos.length === 1 && kinds("deliver", "L-L").length === 0, `${retryL.message} · ${l1?.state} ${l1?.mode}`);
    // (e) a program video never goes to Aryeo by the hub.
    const M = await mkJob("370 Monthly Agent Content", "L-M", { monthly: true });
    const pM = await A.sendVideoToAryeoAction(M.sub, { uploadOnly: true });
    c.ok("a program video: refused, no run, nothing uploaded", !pM.started && /client's portal/.test(pM.message) && !(await runOf(M.sub)) && lname("L-M").videos.length === 0, pM.message);
    // (f) a choice that is not a yes or no.
    const bad = await A.sendVideoToAryeoAction(S2.sub, { uploadOnly: "yes" as never });
    c.ok("a forged choice is refused before anything starts", !bad.ok && /not valid/.test(bad.message) && !(await runOf(S2.sub)), bad.message);

    // ======================================================================
    c.head("6 · a newer version replaces it; Hold and Release never send it");
    const R = await mkJob("380 Revision Rd", "L-R");
    const kyleVideo: Vid = { id: v7(Date.now() - 2 * HOUR), title: "Kyle's walkthrough", duration: 75, visibleAfter: 0, playableAfter: 0 };
    lname("L-R").videos.push(kyleVideo);
    await A.sendVideoToAryeoAction(R.sub, { uploadOnly: true });
    await tick(4);
    const r1 = await runOf(R.sub);
    c.ok("(set-up) version 1 uploaded only", V.isUploadedOnly(r1) && !!r1?.mediaId, `${r1?.state}`);
    // Not ready after all: reopened for revisions (the room's Send back / Reopen).
    await prisma.reviewSubmission.update({ where: { id: R.sub }, data: { status: "CHANGES_REQUESTED" } });
    await tick();
    const r1b = await runOf(R.sub);
    c.ok("reopened: the waiting run stops, nothing delivered", r1b?.state === "FAILED" && /no longer approved/.test(r1b.note ?? "") && kinds("deliver", "L-R").length === 0, `${r1b?.state} ${r1b?.note}`);
    const R2 = await mkCut(R.project.id, R.d.id, "380 Revision Rd", { round: 2, duration: 61.2 });
    const pR2 = await A.sendVideoToAryeoAction(R2.sub, { uploadOnly: true });
    await tick(5);
    const r2 = await runOf(R2.sub);
    const lr = lname("L-R");
    c.ok("version 2 goes up uploaded only", pR2.started === true && V.isUploadedOnly(r2) && !!r2?.mediaId && lr.videos.some((v) => v.id === r2.mediaId), `${r2?.state} ${r2?.note}`);
    c.ok("…the hub's own version 1 came off the listing (as the full push does); Kyle's video stays", JSON.stringify(kinds("delete", "L-R").map((x) => x.body)) === JSON.stringify([r1!.mediaId]) && !lr.videos.some((v) => v.id === r1!.mediaId) && lr.videos.some((v) => v.id === kyleVideo.id) && lr.videos.length === 2, lr.videos.map((v) => v.title).join(" | "));
    c.ok("…and still nothing delivered", kinds("deliver", "L-R").length === 0);
    const held = await V.holdVideoPush(R2.sub, "Kyle Smith", "checking it on the listing");
    const r2h = await runOf(R2.sub);
    c.ok("Hold on it: held by a person, back to waiting on release", held.ok && r2h?.state === "HELD" && r2h.hold?.gate === "manual" && r2h.hold.resume === "WAITING", `${r2h?.state} ${r2h?.hold?.resume}`);
    const rel = await V.releaseVideoPush(R2.sub, "Kyle Smith");
    await tick(2);
    const r2r = await runOf(R2.sub);
    c.ok("Release puts it back to 'On Aryeo, not sent yet' and sends nothing", rel.ok && V.isUploadedOnly(r2r) && /^On Aryeo, not sent yet/.test(r2r?.note ?? "") && kinds("deliver", "L-R").length === 0, `${r2r?.state} ${r2r?.note}`);
    const nowR = await A.deliverVideoNowAction(R2.sub);
    c.ok("Send now on version 2: one Deliver, version 2 recorded sent", nowR.ok && (await runOf(R2.sub))?.state === "DONE" && kinds("deliver", "L-R").length === 1 && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: R2.sub } })).sentToClientAt, nowR.message);

    // ======================================================================
    c.head("7 · the roles: Jordan and Kyle; never James or an editor");
    for (const [who, u] of [["James (creative manager)", james], ["an editor", kim]] as const) {
      await as(u);
      const press = await A.sendVideoToAryeoAction(S2.sub, { uploadOnly: true });
      c.ok(`${who}: Upload to Aryeo only is refused, nothing written`, !press.ok && /access/i.test(press.message) && !(await runOf(S2.sub)), press.message);
    }
    await as(jordan, kyle.id);
    const viewAs = await A.sendVideoToAryeoAction(S2.sub, { uploadOnly: true });
    c.ok("Jordan viewing as Kyle: refused", !viewAs.ok && /previewing another user/.test(viewAs.message) && !(await runOf(S2.sub)), viewAs.message);
    await as(jordan);
    const pJ = await A.sendVideoToAryeoAction(S2.sub, { uploadOnly: true });
    await tick(4);
    const j1 = await runOf(S2.sub);
    c.ok("Jordan (owner): Upload to Aryeo only goes up, not sent", pJ.started === true && j1?.by === "Jordan Spackman" && V.isUploadedOnly(j1) && kinds("deliver", "L-S2").length === 0, `${pJ.message} · ${j1?.state}`);
    for (const [who, u] of [["James (creative manager)", james], ["an editor", kim]] as const) {
      await as(u);
      const sn = await A.deliverVideoNowAction(S2.sub);
      c.ok(`${who}: Send now is refused, nothing delivered`, !sn.ok && /access/i.test(sn.message) && kinds("deliver", "L-S2").length === 0 && V.isUploadedOnly(await runOf(S2.sub)), sn.message);
    }
    await as(jordan, kyle.id);
    const snView = await A.deliverVideoNowAction(S2.sub);
    c.ok("Send now while viewing as someone: refused", !snView.ok && kinds("deliver", "L-S2").length === 0, snView.message);
    await as(jordan);
    const snJ = await A.deliverVideoNowAction(S2.sub);
    c.ok("Jordan's Send now delivers it, once", snJ.ok && (await runOf(S2.sub))?.state === "DONE" && kinds("deliver", "L-S2").length === 1 && (await activity(S2.project.id, "Jordan Spackman pressed Send now")) === 1, snJ.message);
    const src = (await import("node:fs")).readFileSync("src/app/review/videoSendActions.ts", "utf8");
    const guardOf = (fn: string) => src.slice(src.indexOf(`export async function ${fn}(`)).match(/require(Admin|CreativeLead|Owner)\(\)/)?.[1] ?? "?";
    c.ok("both presses sit behind requireAdmin, as the full send does", guardOf("sendVideoToAryeoAction") === "Admin" && guardOf("deliverVideoNowAction") === "Admin" && guardOf("sendAllVideosAction") === "Admin");

    c.head("isolation");
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
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

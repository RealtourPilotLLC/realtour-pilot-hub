// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE CREATIVE MANAGER'S VIEW-ONLY PHOTOS DESK (Jordan, Oct 22 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-photos-view-only.ts
//
// Jordan: "yes, give James a VIEW-ONLY Photos desk so he can check photo
// quality across all jobs in one place."
//
//   §1 access: the `photos` page key (the creative manager yes, Kyle's list
//      still no), legacy `ops` overrides, the proxy, the menu door
//   §2 the pages, as James: the queue, a job, review mode render with the
//      view-only note and without a single control, credit or dollar amount;
//      Credits and Settings send him back to the queue
//   §3 the payload: no Fix Cart, no credits, no payment status, no file links,
//      the history lines without amounts
//   §4 the server refuses him every office action (each one, through the
//      real action) and nothing changes; flagging a photo for Kyle still works
//   §5 Kyle and Jordan keep every control
//   §6 viewing costs nothing: the image route serves him a listing photo and
//      a photo the hub already bought, and never buys one (AutoHDR faked
//      inside the fence, every call counted)
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced (a fake AutoHDR and a fake Aryeo CDN answer
// inside the fence). Nothing leaves the box.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
let jpeg: Uint8Array = new Uint8Array();
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }], balance: 200, clientId: "cid", clientSecret: "drill-secret-1234567890", imageBytes: () => jpeg });
// Every outbound URL, in order: the AutoHDR ones are counted in §6.
const outbound: string[] = [];
const fence = fenceFetch(async (url, init) => {
  outbound.push(url);
  // The Aryeo listing CDN, and a stored AutoHDR link that has run out.
  if (url.startsWith("https://cdn.aryeo.com/")) return new Response(jpeg as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
  if (url.startsWith("https://expired-link.s3.amazonaws.com/")) return new Response("expired", { status: 403 });
  return fake.handle(url, init);
});
const AUTOHDR_HOSTS = /realestatephotoediting\.com|autohdr\.com\//;

const load = createRequire(__filename);
class Redirect extends Error {
  constructor(readonly href: string) {
    super(`redirect ${href}`);
  }
}
class NotFound extends Error {}
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.redirect = (href: string) => {
    throw new Redirect(href);
  };
  nav.notFound = () => {
    throw new NotFound("not found");
  };
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 7342);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LONG_DASH = /[–—]/;
const DOLLARS = /\$\s?\d/;
const CREDIT_AMOUNT = /\b\d[\d,]*\s+(?:AutoHDR\s+)?credits?\b/i;
// What a view-only page must never offer (button, link or menu text).
const FORBIDDEN = /Approve|Deliver in Aryeo|Mark as delivering|Update on Aryeo|Upload again|\bFix\b|In cart|Run selected|Re-edit|re-edit|Not worth fixing|Not there|Send to editor|Reshoot|Override|Stop flagging|Undo|Skip all|Accept with reason|It is in the gallery|Recommend a reshoot|Deliver without it|Done \(fixed\)|Answer with a note|Verify now|Put on hold|Release hold|Check again|Sync from AutoHDR|Straighten|Make hero|Leave out|Put back|Reorder|Restore|Load every version|Download|Get them ready again|\bCart\b|Credits|Settings|Select all|Critical \+ Major|^\s*More\b/;

const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) =>
  h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
/** The text of every button, link and menu summary on a page. */
const controls = (h: string) => [...h.matchAll(/<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]).trim()).filter(Boolean);
const forbiddenIn = (h: string) => controls(h).filter((t) => FORBIDDEN.test(t));

async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof Redirect) return e.href;
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? "";
    throw e;
  }
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-photos-view-only" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    jpeg = new Uint8Array(await sharp({ create: { width: 640, height: 427, channels: 3, background: { r: 120, g: 150, b: 180 } } }).jpeg({ quality: 85 }).toBuffer());
    const { prisma } = await import("@/lib/prisma");
    const access = await import("@/lib/auth/access");
    const { setSession } = await import("@/lib/auth/session");
    const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const data = await import("@/app/ops/photo-delivery/data");
    const { NextRequest } = await import("next/server");
    const { VIEW_ONLY_NOTE } = await import("@/components/photoDelivery/types");
    const now = new Date();

    // ---- people -------------------------------------------------------------------------
    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@pv.invalid` } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER");
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER");
    const harrisonTm = await tm("Harrison Reed", "PHOTOGRAPHER");
    const login = (name: string, role: string, teamMemberId: string | null, permissions: string | null = null) =>
      prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@pv.invalid`, role, teamMemberId, status: "ACTIVE", permissions } });
    const owner = await login("Jordan Spackman", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await login("Harrison Reed", "PHOTOGRAPHER", harrisonTm.id);
    const kim = await login("Kim Editor", "EDITOR", null);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // ---- one photo job in QC_REVIEW (Aryeo listing photos) --------------------------------
    const client = await prisma.client.create({ data: { name: "View Only Client TEST" } });
    const project = await prisma.project.create({ data: { title: "22 Quiet Lane, Testville, PA", addressLine: "22 Quiet Lane", city: "Testville", state: "PA", clientId: client.id, photographerId: harrisonTm.id, shootDate: new Date(now.getTime() - DAY), aryeoListingId: "lst-view", aryeoOrderId: "ord-view", paymentStatus: "UNPAID" } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW", slaDueAt: new Date(now.getTime() + 3 * HOUR), qcShadow: true, creditsSpent: 7, expectedJson: JSON.stringify({ minPhotos: 25, droneCount: 5 }) } });
    const mk = (name: string, seq: number, roomType: string, extra: Record<string, unknown> = {}) =>
      prisma.photoAsset.create({ data: { jobId: job.id, name, sequence: seq, roomType, status: "ACTIVE", sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/view/${name}`, contentHash: `h-${name}`, width: 640, height: 427, description: `A ${roomType.toLowerCase()} photo.`, ...extra } });
    const A = await mk("A.jpg", 0, "EXTERIOR_FRONT");
    const B = await mk("B.jpg", 1, "KITCHEN");
    const C = await mk("C.jpg", 2, "LIVING", { status: "EXCLUDED", excludeReason: "Duplicate" });
    await prisma.photoVersion.createMany({ data: [{ photoId: A.id, label: "On the Aryeo listing", source: "AUTOHDR_INITIAL", contentHash: "h-A.jpg" }, { photoId: B.id, label: "On the Aryeo listing", source: "AUTOHDR_INITIAL", contentHash: "h-B.jpg" }] });
    const bFix = await prisma.photoVersion.create({ data: { photoId: B.id, label: "AutoHDR fix: bin removed", source: "FIX", contentHash: "h-B-fix", derivJson: JSON.stringify({ file: "photo-fixes/view/B.jpg" }), createdAt: new Date(now.getTime() + 1000) } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1", passesJson: JSON.stringify(["CV", "P1", "P4"]), modelsJson: JSON.stringify({ P1: "claude" }), costUsd: 2.37, photoCount: 3, verdict: "NEEDS_DECISION", finishedAt: now } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id, qcVerdict: "NEEDS_DECISION", heroPhotoId: A.id } });
    const f = (o: Record<string, unknown>) =>
      prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, pass: "P1_PHOTO", source: "P1", explanation: "Seeded.", responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK", confidence: 0.9, severity: "MAJOR", specificIssue: "issue", ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", ...o } as never });
    const bin = await f({ photoId: A.id, bboxJson: JSON.stringify([100, 200, 300, 400]), specificIssue: "Blue bin by the garage" });
    await f({ photoId: B.id, ruleId: "PREP_PERSONAL_PHOTOS", groupKey: "PERSONAL_PHOTOS", severity: "CRITICAL", privacySensitive: true, fixStrategy: "HUMAN_REVIEW", specificIssue: "Family photos on the fridge" });
    const shoes = await f({ photoId: B.id, ruleId: "PREP_SHOES_FOOTWEAR", groupKey: "SHOES", severity: "MINOR", specificIssue: "Shoes by the door" });
    await f({ photoId: null, pass: "P4_ORDER", source: "P4", ruleId: "ORD_DRONE_INCLUDED", groupKey: "count:aerial", fixStrategy: "ADMIN_ACTION", specificIssue: "Drone photos: 0 of 5 delivered", rawJson: JSON.stringify({ status: "NOT_MET" }) });
    const batch = await prisma.photoFixBatch.create({ data: { jobId: job.id, mode: "SELECTED", estimatedCredits: 3, estimatedUsdCents: 150, approvedBy: "Kyle", status: "DONE" } });
    await prisma.photoFixOperation.create({ data: { batchId: batch.id, jobId: job.id, photoId: B.id, findingIdsJson: "[]", strategy: "REEDIT_PROMPT", status: "VERIFIED", estimatedCredits: 3, chargedCredits: 3 } });
    await prisma.photoJobEvent.create({ data: { jobId: job.id, actor: "auto-fix", action: "automatic fixes planned: 2 photos, 2 credits ($1.00; target $5.00, max $8.00).", dataJson: JSON.stringify({ credits: 2, usd: 1 }), at: new Date(now.getTime() - 3 * 60_000) } });
    await prisma.photoJobEvent.create({ data: { jobId: job.id, actor: "fix-runner", action: "submitted reedit on B.jpg (1 credit)", dataJson: JSON.stringify({ operationId: "op1" }), at: new Date(now.getTime() - 2 * 60_000) } });
    await prisma.photoJobEvent.create({ data: { jobId: job.id, actor: "sync", action: "gallery changed (aryeo): 3 photos", at: new Date(now.getTime() - 60_000) } });

    // =====================================================================
    c.head("§1 · access: the photos desk opens for the creative manager, Kyle's list does not");
    // =====================================================================
    const CM = { role: "CREATIVE_MANAGER", permissions: null };
    c.ok("canAccess(creative manager, photos) is true", access.canAccess(CM, "photos"));
    c.ok("…and Your list (ops) stays closed to them", !access.canAccess(CM, "ops"));
    c.ok("Kyle (ADMIN) and Jordan keep the desk; editors and photographers do not get it", access.canAccess({ role: "ADMIN", permissions: null }, "photos") && access.canAccess({ role: "OWNER", permissions: null }, "photos") && !access.canAccess({ role: "EDITOR", permissions: null }, "photos") && !access.canAccess({ role: "PHOTOGRAPHER", permissions: null }, "photos"));
    c.ok("a stored ops override still decides the desk until a photos one is set (an admin with ops off stays off)", !access.canAccess({ role: "ADMIN", permissions: JSON.stringify({ ops: false }) }, "photos") && access.canAccess({ role: "ADMIN", permissions: JSON.stringify({ ops: false, photos: true }) }, "photos"));
    c.ok("a photos override closes it for the creative manager", !access.canAccess({ role: "CREATIVE_MANAGER", permissions: JSON.stringify({ photos: false }) }, "photos"));
    const keyOf = (path: string) => access.PAGES.find((p) => p.href !== "/" && (path === p.href || path.startsWith(`${p.href}/`)))?.key ?? null;
    c.ok("the desk's paths resolve to photos (ahead of ops), the checklist to ops", keyOf("/ops/photo-delivery") === "photos" && keyOf(`/ops/photo-delivery/${job.id}`) === "photos" && keyOf(`/ops/photo-delivery/${job.id}/review`) === "photos" && keyOf("/ops/checklist") === "ops", `${keyOf("/ops/photo-delivery")} ${keyOf("/ops/checklist")}`);
    const { pageLabel } = await import("@/lib/usage");
    c.ok("the People → Activity tab names it Photos", pageLabel(`/ops/photo-delivery/${job.id}`) === "Photos");

    const { proxy } = await import("@/proxy");
    const viaProxy = async (pathname: string, u: { id: string; email: string; role: string }) => {
      const token = await signSession({ uid: u.id, email: u.email, role: u.role });
      const res = await proxy(new NextRequest(`http://localhost${pathname}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
      return res.headers.get("location");
    };
    c.ok("the proxy lets James through to the queue, a job and review mode", (await viaProxy("/ops/photo-delivery", james)) === null && (await viaProxy(`/ops/photo-delivery/${job.id}`, james)) === null && (await viaProxy(`/ops/photo-delivery/${job.id}/review`, james)) === null);
    c.ok("…and still turns him away from Kyle's list", new URL((await viaProxy("/ops/checklist", james)) ?? "http://x/none").pathname === "/");
    c.ok("a photographer is still turned away from the desk", (await viaProxy("/ops/photo-delivery", harrison)) !== null);
    c.ok("Kyle passes as before", (await viaProxy("/ops/photo-delivery", kyle)) === null && (await viaProxy("/ops/checklist", kyle)) === null);

    const { Sidebar } = await import("@/components/Sidebar");
    const menu = (u: { name: string; email: string; role: string; permissions?: string | null }) =>
      renderToStaticMarkup(createElement(Sidebar, { user: { name: u.name, email: u.email, role: u.role, permissions: u.permissions ?? null, payHidden: u.role !== "OWNER" } }));
    const hrefs = (h: string) => [...h.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
    const labels = (h: string) => [...h.matchAll(/<a\b[^>]*>[\s\S]*?<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]);
    const section = (h: string, id: string) => h.match(new RegExp(`<section[^>]*data-sidebar-group="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
    const jamesMenu = menu({ name: "James", email: james.email, role: "CREATIVE_MANAGER" });
    c.ok("James's doors: Photos after Monthly Content, where the owner's menu has it", hrefs(section(jamesMenu, "work")).join() === "/,/review,/editing,/content,/ops/photo-delivery,/upload,/jobs,/my-pay" && labels(section(jamesMenu, "work")).join() === "Dashboard,Videos,Editing Room,Monthly Content,Photos,Uploads,Shoots,My Performance", `${hrefs(section(jamesMenu, "work")).join()} / ${labels(section(jamesMenu, "work")).join()}`);
    c.ok("…and still no Your list, no Messages", !hrefs(jamesMenu).includes("/ops/checklist") && !hrefs(jamesMenu).includes("/communications"));
    c.ok("a photos override takes the door away", !hrefs(menu({ name: "J", email: "j@x", role: "CREATIVE_MANAGER", permissions: JSON.stringify({ photos: false }) })).includes("/ops/photo-delivery"));
    c.ok("a photographer with a photos override gets no door (the pages would bounce them)", !hrefs(menu({ name: "H", email: "h@x", role: "PHOTOGRAPHER", permissions: JSON.stringify({ photos: true }) })).includes("/ops/photo-delivery"));
    c.ok("Kyle's doors did not move", hrefs(section(menu({ name: "Kyle", email: kyle.email, role: "ADMIN" }), "work")).join() === "/,/ops/checklist,/communications,/ops/photo-delivery,/review#ready-to-send,/editing,/jobs");

    // =====================================================================
    c.head("§2 · the pages, as James: view only, no controls, no amounts");
    // =====================================================================
    const { default: QueuePage } = await import("@/app/ops/photo-delivery/page");
    const { default: JobPage } = await import("@/app/ops/photo-delivery/[jobId]/page");
    const { default: ReviewPage } = await import("@/app/ops/photo-delivery/[jobId]/review/page");
    const { default: CreditsPage } = await import("@/app/ops/photo-delivery/credits/page");
    const { default: SettingsPage } = await import("@/app/ops/photo-delivery/settings/page");
    const pages = async () => {
      const out: Record<string, string> = {};
      out.queue = html(await QueuePage({ searchParams: Promise.resolve({}) }));
      out.table = html(await QueuePage({ searchParams: Promise.resolve({ view: "table" }) }));
      out.job = html(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({}) }));
      out.lightbox = html(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ photo: B.id }) }));
      out.cartLink = html(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "cart" }) }));
      out.coverage = html(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "coverage" }) }));
      out.history = html(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "history" }) }));
      out.review = html(await ReviewPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ photo: B.id }) }));
      return out;
    };
    await signIn(james);
    const jamesViewer = await data.loadViewer();
    c.ok("loadViewer: James is readOnly, never a money viewer", jamesViewer?.readOnly === true && jamesViewer.canSeeMoney === false, JSON.stringify(jamesViewer));
    const jp = await pages();
    c.ok("every page renders for him (queue, table, job, lightbox, tabs, review mode)", Object.values(jp).every((h) => h.length > 500), Object.entries(jp).map(([k, h]) => `${k}:${h.length}`).join(" "));
    c.ok("the view-only note sits at the top of the queue, the job and review mode", [jp.queue, jp.job, jp.review].every((h) => text(h).includes(VIEW_ONLY_NOTE)) && VIEW_ONLY_NOTE === "View only: Kyle approves and delivers photos.");
    c.ok("…and it comes before the board and the gallery", text(jp.queue).indexOf(VIEW_ONLY_NOTE) < text(jp.queue).indexOf("Needs decision") && text(jp.job).indexOf(VIEW_ONLY_NOTE) < text(jp.job).indexOf("Gallery"));
    const leaks = Object.fromEntries(Object.entries(jp).map(([k, h]) => [k, forbiddenIn(h)]).filter(([, v]) => (v as string[]).length));
    c.ok("no approve, deliver, Aryeo, AutoHDR, fix, cart, re-edit, decision, override, hold, straighten, hero, leave-out, restore, download, credits or settings control on any page", Object.keys(leaks).length === 0, JSON.stringify(leaks).slice(0, 600));
    const amounts = Object.entries(jp).flatMap(([k, h]) => [CREDIT_AMOUNT.test(text(h)) ? `${k}: ${(text(h).match(new RegExp(`.{0,40}${CREDIT_AMOUNT.source}.{0,20}`, "i")) ?? [""])[0]}` : null, DOLLARS.test(text(h)) ? `${k}: $` : null]).filter(Boolean);
    c.ok("no credit amount and no dollar figure anywhere", amounts.length === 0, amounts.join(" | "));
    c.ok("no payment status (the Unpaid chip, Payment:)", Object.values(jp).every((h) => !/Unpaid|Payment:/.test(text(h))));
    c.ok("no credits chip, banner or Credits/Settings tab; no Credits link at all", Object.values(jp).every((h) => !/AutoHDR: |AutoHDR credits|\/ops\/photo-delivery\/credits|\/ops\/photo-delivery\/settings/.test(h)));
    c.ok("what he does see: the board's columns, the cards, the late state", ["Editing", "Checking", "Needs decision", "Ready to review", "Delivered"].every((w) => text(jp.queue).includes(w)) && /22 Quiet Lane/.test(text(jp.queue)) && /left/.test(text(jp.queue)) && /1 critical/.test(text(jp.queue)));
    c.ok("…the job: stage, due, gallery, findings with their status, history", /Gallery/.test(text(jp.job)) && /Blue bin by the garage|Trash or recycling bin/.test(text(jp.job)) && /Privacy/.test(text(jp.job)) && /Delivery checklist: \d+ of \d+ pass/.test(text(jp.job)) && /gallery changed \(aryeo\): 3 photos/.test(text(jp.history)));
    c.ok("…the tabs are Issues, Coverage, History (no Fix Cart); an old ?tab=cart link opens Issues", (() => {
      const tabs = (h: string) => [...h.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim().replace(/\s*\d+$/, "")).join("|");
      return tabs(jp.job) === "Issues|Coverage|History" && /aria-selected="true"[^>]*>\s*Issues|id="pd-tab-issues"[^>]*aria-selected="true"/.test(jp.cartLink);
    })());
    c.ok("…the lightbox: the photo large, its findings, its versions to compare, the AI description", /Findings on this photo/.test(text(jp.lightbox)) && /Versions/.test(text(jp.lightbox)) && /AutoHDR fix: bin removed/.test(text(jp.lightbox)) && /AI description/.test(text(jp.lightbox)) && /\/api\/photo-delivery\/img\/[a-z0-9]+\/qc2048/.test(jp.lightbox));
    c.ok("…the coverage tab: the ordered drone photos, not met, without Accept", /Drone photos/.test(text(jp.coverage)) && /Not met/.test(text(jp.coverage)) && !/Accept with reason/.test(text(jp.coverage)));
    c.ok("…the history: what ran (fix batches, QC runs) without a credit count", /Fix batches/.test(text(jp.history)) && /Reedit|REEDIT|re-edit|Verified/i.test(text(jp.history)) && !CREDIT_AMOUNT.test(text(jp.history)) && !/charged|est\. \d/.test(text(jp.history)));
    c.ok("…review mode: one photo at a time, J and K, no Hero, Leave out or Cart", /2 of 3/.test(text(jp.review)) && /Next/.test(text(jp.review)) && /Previous/.test(text(jp.review)) && !/Hero \(H\)|Make hero|Leave out|Fix Cart/.test(jp.review));
    c.ok("the header offers Review mode and nothing else", (() => {
      const head = (jp.job.split('aria-label="Job summary"')[0] ?? "");
      const ctl = controls(head).filter((t) => !/Photo Delivery/.test(t));
      return ctl.includes("Review mode") && !ctl.some((t) => /More|hold|Check again|Sync/.test(t));
    })());
    c.ok("no em or en dash on his pages", Object.values(jp).every((h) => !LONG_DASH.test(text(h))));
    c.ok("the Credits page sends him back to the queue", (await redirectOf(() => CreditsPage({ searchParams: Promise.resolve({}) }))) === "/ops/photo-delivery");
    c.ok("the Settings page sends him back to the queue", (await redirectOf(() => SettingsPage())) === "/ops/photo-delivery");

    // =====================================================================
    c.head("§3 · the payload carries nothing he may not see");
    // =====================================================================
    const jd = (await data.loadJobDetail(job.id, { viewer: jamesViewer!, now }))!;
    c.ok("no Fix Cart (not even built), no credits spent, no payment status", jd.cart === null && jd.cartError === null && jd.header.creditsSpent === null && jd.header.paymentStatus === null);
    c.ok("no 06-Ready-for-Aryeo folder or Dropbox path, no download link on a fixed photo or a hub edit", jd.steps?.ready === null && jd.steps?.folderPath === null && (jd.steps?.replacements ?? []).every((r) => r.downloadUrl === null) && jd.photos.every((p) => !p.hubEdit || p.hubEdit.downloadUrl === null));
    const line = (d: typeof jd, start: string) => d.events.find((e) => e.action.startsWith(start))?.action ?? "";
    c.ok("history lines lose their amounts: 'automatic fixes planned: 2 photos.'", line(jd, "automatic fixes planned") === "automatic fixes planned: 2 photos.", line(jd, "automatic fixes planned"));
    c.ok("…'submitted reedit on B.jpg' (no credit), and no raw details", line(jd, "submitted reedit") === "submitted reedit on B.jpg" && jd.events.every((e) => e.detail === null), line(jd, "submitted reedit"));
    const strip = await data.loadStrip(jamesViewer!);
    c.ok("the strip: no credit view at all, readOnly", strip.credit === null && strip.readOnly === true);
    const q = await data.loadQueue({ viewer: jamesViewer! });
    const card = q.columns.flatMap((col) => col.cards).find((x) => x.id === job.id);
    c.ok("the queue's cards carry no payment status for him", !!card && card.paymentStatus === null);

    // =====================================================================
    c.head("§4 · every office action refuses him, nothing changes");
    // =====================================================================
    const A1 = await import("@/app/ops/photo-delivery/actions");
    const E1 = await import("@/app/ops/photo-delivery/editActions");
    type R = { ok: boolean; message?: string };
    const refused = (r: R) => !r.ok && /access|sign in|previewing/i.test(r.message ?? "access");
    const attempts: [string, () => Promise<R>][] = [
      ["Approve and deliver", () => A1.approveAryeoAction(job.id, { deliver: true })],
      ["Approve and upload to Aryeo", () => A1.approveAryeoAction(job.id, { deliver: false })],
      ["Deliver in Aryeo", () => A1.deliverInAryeoAction(job.id)],
      ["Update on Aryeo", () => E1.updateOnAryeoAction(job.id, [A.id])],
      ["Mark as delivering", () => A1.startDeliveryAction(job.id)],
      ["Override and deliver", () => A1.overrideDeliverAction(job.id, "drill override reason")],
      ["Deliver without the wrap-up", () => A1.overrideWrapUpAction(job.id, "drill wrap-up reason")],
      ["Verify now", () => A1.verifyDeliveryAction(job.id)],
      ["Get them ready again (06-Ready-for-Aryeo)", () => A1.restageForAryeoAction(job.id)],
      ["the ready-copy progress (moves the copy on)", () => A1.readyProgressAction(job.id)],
      ["Run selected (the Fix Cart)", () => A1.approveFixesAction({ jobId: job.id, findingIds: [bin.id], mode: "SELECTED" })],
      ["Re-edit with AI", () => E1.customReeditAction({ jobId: job.id, photoId: A.id, prompt: "remove the blue bin please", expectCredits: 1 })],
      ["the re-edit price", () => E1.reeditQuoteAction(job.id)],
      ["Not worth fixing (a finding decision)", () => A1.decideFindingsAction({ jobId: job.id, findingIds: [bin.id], status: "IGNORED", reason: "drill" })],
      ["Not there (a finding decision)", () => A1.decideFindingsAction({ jobId: job.id, findingIds: [bin.id], status: "FALSE_POSITIVE", reason: "drill" })],
      ["Skip all", () => A1.skipAllFindingsAction(job.id)],
      ["Stop flagging this", () => A1.stopFlaggingAction({ jobId: job.id, ruleId: "PREP_TRASH_CANS", reason: "drill" })],
      ["Done (a client request)", () => A1.clientAskedDoneAction(job.id, "abcdefghijkl")],
      ["Answer with a note", () => A1.clientAskedAnswerAction(job.id, "abcdefghijkl", "drill answer")],
      ["Straighten and crop: save", () => E1.saveStraightenAction({ jobId: job.id, photoId: A.id, baseHash: "h-A.jpg", baseSize: { width: 640, height: 427 }, params: { rotate: 1 }, fixFindingIds: [], stored: { pathname: `photo-edits/${job.id}/${A.id}/x.jpg` } })],
      ["Straighten and crop: render on the server", () => E1.renderStraightenOnServerAction({ jobId: job.id, photoId: A.id, baseHash: "h-A.jpg", params: { rotate: 1 }, fixFindingIds: [] })],
      ["Straighten: measure", () => E1.measureStraightenAction(job.id, A.id)],
      ["Make hero", () => A1.setHeroAction(job.id, B.id)],
      ["Leave out / put back", () => A1.setPhotoExcludedAction({ jobId: job.id, photoId: C.id, excluded: false })],
      ["Reorder", () => A1.saveDeliveryOrderAction(job.id, [B.id, A.id])],
      ["Restore a version", () => A1.restoreVersionAction(job.id, B.id, "abcdefghijkl")],
      ["Load every version from AutoHDR", () => A1.loadVersionsAction(job.id, A.id)],
      ["Sync from AutoHDR", () => A1.syncFromAutohdrAction(job.id)],
      ["Put on hold", () => A1.holdJobAction(job.id, "drill hold")],
      ["Release hold", () => A1.releaseHoldAction(job.id)],
      ["Check again (paid QC)", () => A1.requestQcAction(job.id)],
      ["the home's prep mode", () => A1.setPrepModeAction({ jobId: job.id, mode: "VACANT" })],
      ["Check the AutoHDR balance", () => A1.checkBalanceAction()],
      ["the credit thresholds", () => A1.saveThresholdsAction({ warn: 300, critical: 100, resetBuffer: 50, usdPerCredit: 0.5 })],
      ["the desk's settings", () => A1.saveSettingsAction({ qcEnabled: false })],
      ["a client QC profile", () => A1.saveClientProfileAction({ clientId: client.id, notes: "drill", deliveryMessage: "", ruleOverrides: [] })],
      ["the coaching note", () => A1.sendCoachingAction({ jobId: job.id, note: "drill", reminders: [] })],
    ];
    const notRefused: string[] = [];
    for (const [label, fn] of attempts) {
      const r = await fn().catch((e: Error) => ({ ok: false, message: e.message }));
      if (!refused(r as R)) notRefused.push(`${label}: ${JSON.stringify(r).slice(0, 120)}`);
    }
    c.ok(`each of the ${attempts.length} office actions refuses James (requireAdmin / requireOwner)`, notRefused.length === 0, notRefused.join(" | "));
    const after = await prisma.photoJob.findUnique({ where: { id: job.id }, select: { stage: true, heroPhotoId: true, holdReason: true, orderJson: true, prepMode: true, qcRequestedAt: true } });
    const fAfter = await prisma.photoQcFinding.findMany({ where: { jobId: job.id }, select: { status: true } });
    c.ok("…and nothing changed: stage, hero, hold, order, prep, findings, the left-out photo, no fix batch, no edit", after?.stage === "QC_REVIEW" && after.heroPhotoId === A.id && !after.holdReason && !after.orderJson && !after.prepMode && !after.qcRequestedAt && fAfter.every((x) => x.status === "OPEN") && (await prisma.photoAsset.findUnique({ where: { id: C.id }, select: { status: true } }))?.status === "EXCLUDED" && (await prisma.photoFixBatch.count({ where: { jobId: job.id } })) === 1 && (await prisma.photoVersion.count({ where: { photoId: A.id } })) === 1, JSON.stringify(after));
    const { GET: progressGET } = await import("@/app/api/photo-delivery/progress/[jobId]/route");
    const { GET: editSourceGET } = await import("@/app/api/photo-delivery/edit-source/[photoId]/route");
    const { GET: fixFileGET } = await import("@/app/api/photo-fixes/[versionId]/route");
    const pr = await progressGET(new NextRequest(`http://127.0.0.1/api/photo-delivery/progress/${job.id}?what=push`), { params: Promise.resolve({ jobId: job.id }) });
    const es = await editSourceGET(new NextRequest(`http://127.0.0.1/api/photo-delivery/edit-source/${A.id}?size=full`), { params: Promise.resolve({ photoId: A.id }) });
    const ff = await fixFileGET(new NextRequest("http://127.0.0.1/api/photo-fixes/abcdefghijkl"), { params: Promise.resolve({ versionId: "abcdefghijkl" }) });
    c.ok("the office routes refuse him too: the Aryeo push progress, the Straighten editor's full file, a fixed photo's download", pr.status === 403 && es.status === 403 && ff.status >= 400 && ff.status !== 200, `${pr.status} ${es.status} ${ff.status}`);
    c.ok("the Straighten upload token is the office's (requireAdmin in edit-upload)", /onBeforeGenerateToken: async[\s\S]{0,80}await requireAdmin\(\)/.test(load("node:fs").readFileSync(load("node:path").resolve(__dirname, "../../src/app/api/photo-delivery/edit-upload/route.ts"), "utf8")));

    // The creative action he has elsewhere: flagging a photo for Kyle (requireStaff admits the creative manager).
    const { flagImages } = await import("@/app/projects/flagActions");
    const flag = await flagImages(project.id, [{ url: "https://cdn.aryeo.com/view/A.jpg", caption: "A.jpg" }], "Blue bin still by the garage", []);
    c.ok("an allowed creative action still works for him: Flag for Kyle on a photo", flag.ok && (await prisma.imageFlag.count({ where: { projectId: project.id } })) === 1, flag.message);

    // =====================================================================
    c.head("§5 · Kyle and Jordan keep every control");
    // =====================================================================
    await signIn(kyle);
    const kyleViewer = await data.loadViewer();
    c.ok("loadViewer: Kyle acts (not readOnly), no money", kyleViewer?.readOnly === false && kyleViewer.canSeeMoney === false);
    const kp = await pages();
    const kc = (h: string) => controls(h).join(" | ");
    c.ok("Kyle's job page: the decisions, Skip all, Reorder, the Fix Cart tab, credits spent, Put on hold", /Not worth fixing/.test(kc(kp.job)) && /Skip all/.test(kc(kp.job)) && /Reorder/.test(kc(kp.job)) && /Fix Cart/.test(kp.job) && /7 AutoHDR credits spent/.test(text(kp.job)) && /Put on hold/.test(kc(kp.job)), kc(kp.job).slice(0, 300));
    c.ok("…his lightbox: Make hero, Leave out, Straighten and crop, AI re-edit", /Make hero|Hero/.test(kc(kp.lightbox)) && /Leave out/.test(kc(kp.lightbox)) && /Straighten and crop/.test(kc(kp.lightbox)) && /AI re-edit/.test(kc(kp.lightbox)));
    c.ok("…his Coverage tab: Accept with reason; his review mode: Hero, Leave out, Cart", /Accept with reason/.test(kc(kp.coverage)) && /Hero/.test(kc(kp.review)) && /Leave out/.test(kc(kp.review)) && /Cart/.test(kc(kp.review)));
    c.ok("…the credits chip and the Credits tab; no view-only note anywhere", /AutoHDR/.test(text(kp.queue)) && /href="\/ops\/photo-delivery\/credits"/.test(kp.queue) && Object.values(kp).every((h) => !text(h).includes(VIEW_ONLY_NOTE)));
    c.ok("…the Unpaid chip on the board, as before", /Unpaid/.test(text(kp.queue)));
    c.ok("…his Credits page renders; Settings still sends him to the queue (owner only)", (await redirectOf(() => CreditsPage({ searchParams: Promise.resolve({}) }))) === null && (await redirectOf(() => SettingsPage())) === "/ops/photo-delivery");
    const kd = (await data.loadJobDetail(job.id, { viewer: kyleViewer!, now }))!;
    c.ok("…his payload: the Fix Cart, credits spent, payment status, as before", !!kd.cart && kd.header.creditsSpent === 7 && kd.header.paymentStatus === "UNPAID");
    c.ok("…his history keeps credit counts but never a dollar (the owner's)", line(kd, "automatic fixes planned") === "automatic fixes planned: 2 photos, 2 credits." && line(kd, "submitted reedit") === "submitted reedit on B.jpg (1 credit)" && kd.events.every((e) => !DOLLARS.test(e.action) && !DOLLARS.test(e.detail ?? "")), line(kd, "automatic fixes planned"));
    // The press Kyle owns still goes through the guard (a real decision on the minor finding).
    const kyleDecides = await A1.decideFindingsAction({ jobId: job.id, findingIds: [shoes.id], status: "IGNORED", reason: "Not worth fixing here" });
    c.ok("…and his own decision goes through (the guard admits the office)", kyleDecides.ok && (await prisma.photoQcFinding.findUnique({ where: { id: shoes.id }, select: { status: true } }))?.status === "IGNORED", kyleDecides.message);

    // The approve bar and Update on Aryeo, on a frame where they apply (Ready to review, the hub's upload on).
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    type Push = typeof kd.aryeoPush;
    const hubOn: Push = { mode: "on", connected: true, progress: null, sameDayAuto: false };
    // A frame where every press applies: Ready to review, the hub's upload on, a hub edit the listing lacks.
    const ready = (d: typeof kd, downloadUrl: string | null): typeof kd => ({
      ...d,
      gate: d.gate ? { ...d.gate, canDeliver: true, overrideAllowed: true, blockedForOverride: null } : d.gate,
      header: { ...d.header, stage: "READY" },
      steps: d.steps ? { ...d.steps, listingUrl: d.steps.listingUrl ?? "https://realtourpilot.aryeo.com/admin/listings/lst-view/edit" } : d.steps,
      aryeoPush: hubOn,
      photos: d.photos.map((p) => (p.id === A.id ? { ...p, hubEdit: { versionId: "v1", label: "Straightened in the hub", params: { rotate: 1, keystone: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: "original" as const }, needsListingUpdate: true, downloadUrl } } : p)),
    });
    const kyleFrame = html(createElement(JobWorkspace, { data: ready(kd, "/api/photo-fixes/v1"), viewer: kyleViewer!, initialPhoto: A.id, history: null }));
    c.ok("Kyle's Ready to review frame: Approve and deliver, Approve and upload to Aryeo, Update on Aryeo, the download", /Approve and deliver/.test(kc(kyleFrame)) && /Approve and upload to Aryeo/.test(kc(kyleFrame)) && /Update on Aryeo/.test(kc(kyleFrame)) && /Download/.test(kc(kyleFrame)));
    // Even handed a download link (the loader never sends him one), his frame offers none of it.
    const jamesFrame = html(createElement(JobWorkspace, { data: ready(jd, "/api/photo-fixes/v1"), viewer: jamesViewer!, initialPhoto: A.id, history: null }));
    c.ok("…the same frame as James: none of them, the hub edit read only", forbiddenIn(jamesFrame).length === 0 && /Edited in the hub/.test(text(jamesFrame)) && /The Aryeo listing still has the old file/.test(text(jamesFrame)), forbiddenIn(jamesFrame).join(" | "));

    await signIn(owner);
    const ownerViewer = await data.loadViewer();
    const op = await pages();
    c.ok("Jordan: every control, the run cost in dollars, Settings opens", ownerViewer?.readOnly === false && /Not worth fixing/.test(kc(op.job)) && /Stop flagging this/.test(op.job) && /\$2\.37/.test(text(op.history)) && (await redirectOf(() => SettingsPage())) === null && (await redirectOf(() => CreditsPage({ searchParams: Promise.resolve({}) }))) === null);
    const od = (await data.loadJobDetail(job.id, { viewer: ownerViewer!, now }))!;
    c.ok("…and his history lines keep their dollars", line(od, "automatic fixes planned") === "automatic fixes planned: 2 photos, 2 credits ($1.00; target $5.00, max $8.00).");

    // =====================================================================
    c.head("§6 · viewing costs nothing: the image route never buys a photo");
    // =====================================================================
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    const shoot = fake.seedShoot({ address: "40 Bought Ave", photos: [{ name: "d.jpg", downloaded: true }, { name: "e.jpg", downloaded: false }, { name: "f.jpg", downloaded: true }] });
    const [pd, pe, pf] = shoot.photos;
    const project2 = await prisma.project.create({ data: { title: "40 Bought Ave, Testville, PA", addressLine: "40 Bought Ave", clientId: client.id, photographerId: harrisonTm.id, shootDate: new Date(now.getTime() - DAY) } });
    const job2 = await prisma.photoJob.create({ data: { projectId: project2.id, stage: "EDITED", slaDueAt: new Date(now.getTime() + 6 * HOUR), autohdrPhotoshootId: shoot.photoshoot_id } });
    // The hub's own record of what it bought (display.ts): d and f downloaded, e never.
    await prisma.photoIntakeBatch.create({
      data: {
        projectId: project2.id, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: "[]", fileCount: 3, fingerprint: "fp-view", photoshootId: shoot.photoshoot_id, doneAt: now,
        photosJson: JSON.stringify([
          { image_uuid: pd.image_uuid, image_version_uuid: pd.head, name: pd.name, downloaded: true, url: null },
          { image_uuid: pe.image_uuid, image_version_uuid: pe.head, name: pe.name, downloaded: false },
          { image_uuid: pf.image_uuid, image_version_uuid: pf.head, name: pf.name, downloaded: true, url: null },
        ]),
      },
    });
    const ahdr = (p: typeof pd, seq: number, sourceUrl: string | null) =>
      prisma.photoAsset.create({ data: { jobId: job2.id, name: p.name, sequence: seq, roomType: "LIVING", status: "ACTIVE", sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${p.image_uuid}`, sourceUrl, contentHash: `v-${p.head}`, autohdrImageUuid: p.image_uuid, autohdrVersionUuid: p.head } });
    const D = await ahdr(pd, 0, `https://autohdr-fake.s3.amazonaws.com/download/${pd.head}`);
    const Eph = await ahdr(pe, 1, null);
    const F = await ahdr(pf, 2, "https://expired-link.s3.amazonaws.com/f.jpg");

    const route = await import("@/app/api/photo-delivery/img/[photoId]/[size]/route");
    const D1 = await import("@/lib/photoDelivery/qc/derivatives");
    const img = (id: string, hash: string | null, size = "thumb768") => route.GET(new NextRequest(`http://127.0.0.1/api/photo-delivery/img/${id}/${size}${hash ? `?v=${hash}` : ""}`), { params: Promise.resolve({ photoId: id, size }) });
    const autohdrCalls = () => outbound.filter((u) => AUTOHDR_HOSTS.test(u)).length;
    const downloads = () => fake.state.calls.filter((x) => x.method === "POST" && x.path.endsWith("/photos/download")).length;
    const balance0 = fake.state.balance;
    const ledger0 = await prisma.autohdrCreditEntry.count();

    await signIn(james);
    D1.derivCache.clear();
    let mark = autohdrCalls();
    const rA = await img(A.id, "h-A.jpg");
    c.ok("James opens a listing photo: 200, a JPEG, private; AutoHDR never asked", rA.status === 200 && rA.headers.get("content-type") === "image/jpeg" && /private/.test(rA.headers.get("cache-control") ?? "") && (await rA.arrayBuffer()).byteLength > 500 && autohdrCalls() === mark, `${rA.status} ${autohdrCalls() - mark}`);
    mark = autohdrCalls();
    const rD = await img(D.id, D.contentHash);
    c.ok("…a photo the hub already bought (its stored link): 200, and the AutoHDR download endpoint is never called", rD.status === 200 && (await rD.arrayBuffer()).byteLength > 500 && autohdrCalls() === mark && downloads() === 0, `${rD.status} calls ${autohdrCalls() - mark} downloads ${downloads()}`);
    mark = autohdrCalls();
    const rE = await img(Eph.id, Eph.contentHash);
    c.ok("…a photo the hub never bought: refused (503, still being brought over), AutoHDR not asked at all", rE.status === 503 && autohdrCalls() === mark && downloads() === 0 && fake.state.shoots[0].photos[1].downloaded === false, `${rE.status} ${await rE.text().catch(() => "")}`);
    const rF = await img(F.id, F.contentHash);
    const charged = fake.state.balance !== balance0;
    c.ok("…a bought photo whose link ran out: a free re-download of that photo only, nothing charged", rF.status === 200 && downloads() === 1 && !charged && fake.state.calls.filter((x) => x.path.endsWith("/photos/download")).every((x) => JSON.stringify(x.body).includes(pf.image_uuid)), `${rF.status} downloads ${downloads()} balance ${fake.state.balance}`);
    c.ok("the AutoHDR balance and the hub's credit ledger did not move; the unbought photo is still unbought", fake.state.balance === balance0 && (await prisma.autohdrCreditEntry.count()) === ledger0 && fake.state.shoots[0].photos[1].downloaded === false);
    mark = autohdrCalls();
    const rV = await route.GET(new NextRequest(`http://127.0.0.1/api/photo-delivery/img/${B.id}/qc1024?version=${bFix.id}`), { params: Promise.resolve({ photoId: B.id, size: "qc1024" }) });
    c.ok("an earlier version with no kept copy is a 404 that says so, never a fetch from AutoHDR", rV.status === 404 && autohdrCalls() === mark && downloads() === 1, `${rV.status}`);

    await prisma.appUser.update({ where: { id: james.id }, data: { permissions: JSON.stringify({ photos: false }) } });
    c.ok("with the desk taken away (photos override), his image requests are refused", (await img(A.id, "h-A.jpg")).status === 403);
    await prisma.appUser.update({ where: { id: james.id }, data: { permissions: null } });
    await signIn(harrison);
    c.ok("a photographer gets 403 from the image route", (await img(A.id, "h-A.jpg")).status === 403);
    await signIn(kim);
    c.ok("an editor gets 403 from the image route", (await img(A.id, "h-A.jpg")).status === 403);
    await signIn(kyle);
    c.ok("Kyle still gets the photo", (await img(A.id, "h-A.jpg")).status === 200);
    void getCurrentUser;

    c.ok("nothing left the box", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

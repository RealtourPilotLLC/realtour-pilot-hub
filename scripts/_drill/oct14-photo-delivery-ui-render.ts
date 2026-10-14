// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE PHOTO DELIVERY PAGES, RENDERED (Oct 14 2026). The companion of
// oct14-photo-delivery-ui.ts (which drills the writes and loaders): here the
// REAL pages and components are rendered to HTML against a seeded job, so a
// render-time crash, a missing state or a leaked number shows up without a
// browser and without the production database.
//
//   1. The queue page (board and table, filters, empty state), the job page
//      (header, gallery, tabs, deliver panel), review mode, the credits page
//      and the owner settings page all render.
//   2. What they say: the columns, "Replace these on the Aryeo listing", the
//      fix runner switch, the plain blockers, the shadow-mode note.
//   3. Money: an ADMIN's job page and credits page carry no dollar figure;
//      the owner's do.
//   4. Copy: no em or en dash anywhere in the rendered HTML.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6948). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
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

const PORT = Number(process.env.DRILL_PORT ?? 6948);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LONG_DASH = /[\u2013\u2014]/;
const DOLLARS = /\$\s?\d/;

const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const data = await import("@/app/ops/photo-delivery/data");
    const now = new Date();

    // ---- seed: one job in QC_REVIEW with photos, findings, a run, a fix, a batch ----------
    const client = await prisma.client.create({ data: { name: "Render Client TEST" } });
    const pg = await prisma.teamMember.create({ data: { name: "Render Photographer", email: "render-photo-ui@example.com" } });
    const project = await prisma.project.create({ data: { title: "9 Render Row, Testville, PA", addressLine: "9 Render Row", city: "Testville", state: "PA", clientId: client.id, photographerId: pg.id, shootDate: new Date(now.getTime() - DAY), aryeoListingId: "lst-render", aryeoOrderId: "ord-render", paymentStatus: "UNPAID" } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW", slaDueAt: new Date(now.getTime() + 3 * HOUR), qcShadow: true, expectedJson: JSON.stringify({ minPhotos: 25, droneCount: 5, floorPlan: true, requestedFeatures: ["new deck"], specialInstructions: "Shot order: front first", source: { droneCount: "deliverable: Drone Photos" } }) } });
    const mk = (name: string, seq: number, roomType: string, extra: Record<string, unknown> = {}) =>
      prisma.photoAsset.create({ data: { jobId: job.id, name, sequence: seq, roomType, status: "ACTIVE", sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/render/${name}`, contentHash: `h-${name}`, width: 6000, height: 4000, description: `A ${roomType.toLowerCase()} photo.`, ...extra } });
    const A = await mk("A.jpg", 0, "EXTERIOR_FRONT", { cvJson: JSON.stringify({ v: 1, metrics: { fullW: 6000, fullH: 4000, format: "jpeg", blurScore: 182.4, meanLuma: 121, clipHighPct: 1.2, clipLowPct: 0.4, grayWorldCast: [1.1, -2.3], dustCandidates: [], flags: ["HIGHLIGHT_CLIP"] }, unavailable: null, p1b: null }) });
    const B = await mk("B.jpg", 1, "KITCHEN");
    await mk("C.jpg", 2, "LIVING", { status: "EXCLUDED", excludeReason: "Duplicate" });
    await prisma.photoVersion.createMany({ data: [{ photoId: A.id, label: "On the Aryeo listing", source: "AUTOHDR_INITIAL", contentHash: "h-A.jpg" }, { photoId: B.id, label: "On the Aryeo listing", source: "AUTOHDR_INITIAL", contentHash: "h-B.jpg" }] });
    await prisma.photoVersion.create({ data: { photoId: B.id, label: "AutoHDR fix: towel straightened", source: "FIX", contentHash: "h-B-fix", derivJson: JSON.stringify({ file: "photo-fixes/render/B.jpg" }), createdAt: new Date(now.getTime() + 1000) } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1", passesJson: JSON.stringify(["CV", "P0", "P1", "P4"]), modelsJson: JSON.stringify({ P1: "claude-sonnet-5-5" }), costUsd: 2.37, photoCount: 3, verdict: "NEEDS_DECISION", finishedAt: now } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id, qcVerdict: "NEEDS_DECISION", heroPhotoId: A.id, creditsSpent: 3 } });
    const f = (o: Record<string, unknown>) =>
      prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, pass: "P1_PHOTO", source: "P1", explanation: "Seeded.", responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK", confidence: 0.9, severity: "MAJOR", specificIssue: "issue", ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", ...o } as never });
    await f({ photoId: A.id, bboxJson: JSON.stringify([100, 200, 900, 1200]), specificIssue: "Blue bin by the garage" });
    await f({ photoId: B.id, specificIssue: "Bin beside the island" });
    await f({ photoId: B.id, ruleId: "PREP_PERSONAL_PHOTOS", groupKey: "PERSONAL_PHOTOS", severity: "CRITICAL", privacySensitive: true, fixStrategy: "HUMAN_REVIEW", specificIssue: "Family photos on the fridge" });
    await f({ photoId: A.id, ruleId: "PREP_SHOES_FOOTWEAR", groupKey: "SHOES", severity: "MINOR", confidence: 0.3, specificIssue: "Shoes by the door" });
    await f({ photoId: null, pass: "P4_ORDER", source: "P4", ruleId: "ORD_DRONE_INCLUDED", groupKey: "count:aerial", fixStrategy: "ADMIN_ACTION", specificIssue: "Drone photos: 0 of 5 delivered", rawJson: JSON.stringify({ status: "NOT_MET" }) });
    await f({ photoId: B.id, ruleId: "PREP_LOOSE_CORDS_CABLES", groupKey: "CORDS", severity: "MINOR", status: "IGNORED", statusReason: "Client preference", decidedBy: "Kyle", decidedAt: now });
    const batch = await prisma.photoFixBatch.create({ data: { jobId: job.id, mode: "SELECTED", estimatedCredits: 1, estimatedUsdCents: 50, approvedBy: "Kyle", status: "DONE" } });
    await prisma.photoFixOperation.create({ data: { batchId: batch.id, jobId: job.id, photoId: B.id, findingIdsJson: "[]", strategy: "REEDIT_PROMPT", status: "VERIFIED", estimatedCredits: 1, chargedCredits: 1 } });
    await prisma.photoJobEvent.create({ data: { jobId: job.id, actor: "sync", action: "gallery changed (aryeo): 3 photos", dataJson: JSON.stringify({ added: 3 }) } });
    await prisma.autohdrCreditEntry.createMany({
      data: [
        { kind: "BALANCE_SNAPSHOT", credits: 0, balanceAfter: 420, at: new Date(now.getTime() - 5 * DAY) },
        { kind: "TRANSFORM", credits: -1, jobId: job.id, at: new Date(now.getTime() - 4 * DAY), note: "reedit" },
        { kind: "ADJUSTMENT", credits: -30, at: new Date(now.getTime() - 3 * DAY), note: "used outside the pipeline" },
        { kind: "BALANCE_SNAPSHOT", credits: 0, balanceAfter: 389, at: new Date(now.getTime() - 2 * DAY) },
      ],
    });
    await prisma.clientQcProfile.create({ data: { clientId: client.id, slaHours: 12, ruleOverridesJson: JSON.stringify([{ ruleId: "PREP_SHOES_FOOTWEAR", disabled: true, reason: "Staged on purpose" }]) } });

    const admin = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };
    const all: Record<string, string> = {};
    const render = async (label: string, fn: () => unknown | Promise<unknown>) => {
      try {
        const out = html(await fn());
        all[label] = out;
        c.ok(`${label} renders`, out.length > 200, `${out.length} chars`);
        return out;
      } catch (e) {
        c.ok(`${label} renders`, false, String((e as Error)?.stack ?? e).slice(0, 500));
        return "";
      }
    };

    // =======================================================================
    c.head("1 · pages render");
    // =======================================================================
    const { default: QueuePage } = await import("@/app/ops/photo-delivery/page");
    const { default: JobPage } = await import("@/app/ops/photo-delivery/[jobId]/page");
    const { default: ReviewPage } = await import("@/app/ops/photo-delivery/[jobId]/review/page");
    const { default: CreditsPage } = await import("@/app/ops/photo-delivery/credits/page");
    const { default: SettingsPage } = await import("@/app/ops/photo-delivery/settings/page");
    const board = await render("the queue (board)", () => QueuePage({ searchParams: Promise.resolve({}) }));
    const table = await render("the queue (table, at-risk filter)", () => QueuePage({ searchParams: Promise.resolve({ view: "table", risk: "1" }) }));
    const jobHtml = await render("the job page", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({}) }));
    const cartHtml = await render("the job page on the Fix Cart tab with the lightbox open", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "cart", photo: A.id }) }));
    const coverageHtml = await render("the job page on the Coverage tab", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "coverage" }) }));
    const filesHtml = await render("the job page on the Files tab", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "files" }) }));
    const reviewHtml = await render("review mode", () => ReviewPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ photo: B.id }) }));
    const creditsHtml = await render("the credits page", () => CreditsPage({ searchParams: Promise.resolve({}) }));
    const settingsHtml = await render("the settings page (owner)", () => SettingsPage());
    let missing = "";
    try {
      await JobPage({ params: Promise.resolve({ jobId: "no-such-job-12345" }), searchParams: Promise.resolve({}) });
    } catch (e) {
      missing = e instanceof NotFound ? "404" : String(e);
    }
    c.ok("an unknown job answers 404", missing === "404", missing);

    // =======================================================================
    c.head("2 · what the pages say");
    // =======================================================================
    const tb = text(board);
    c.ok("board: every column, in order", ["Editing", "QC running", "Needs decision", "Fixing", "On hold", "Ready", "Delivering", "Delivered"].every((w) => tb.includes(w)) && tb.indexOf("Editing") < tb.indexOf("Needs decision") && tb.indexOf("Needs decision") < tb.indexOf("Delivered"));
    c.ok("board: the card shows the street, client, photographer, SLA, ticket counts (privacy critical; bins + coverage major) and shadow badge", /9 Render Row/.test(tb) && /Render Client TEST/.test(tb) && /Render Photographer/.test(tb) && /left/.test(tb) && /1 critical/.test(tb) && /2 major/.test(tb) && /Shadow/.test(tb), tb.slice(tb.indexOf("9 Render Row"), tb.indexOf("9 Render Row") + 300));
    c.ok("board: the shadow-mode note", /QC is in shadow mode: results are advisory while Kyle keeps his manual check/.test(tb));
    c.ok("board: AutoHDR not connected, said plainly", /AutoHDR API not connected/.test(tb));
    c.ok("table view renders rows with a caption", /Photo jobs, sorted by when they are due/.test(table) && /9 Render Row/.test(text(table)));
    const tj = text(jobHtml);
    c.ok("job: header facts (stage stepper, Aryeo links, verdict, credits spent)", /Decision/.test(tj) && /realtourpilot\.aryeo\.com\/admin\/listings\/lst-render\/edit/.test(jobHtml) && /Needs a decision/.test(tj) && /3 AutoHDR credits spent/.test(tj));
    c.ok("job: groups first, with the privacy chip and the low-confidence drawer", /Trash or recycling bin/.test(tj) && /Privacy/.test(tj) && /Low confidence/.test(tj));
    c.ok("job: the deliver panel with the advisory badge and the steps", /Delivery checklist: \d+ of \d+ pass/.test(tj) && /Advisory/.test(tj) && /Mark as delivering/.test(tj) && /Copy message/.test(tj));
    c.ok("job: Replace these on the Aryeo listing, with the download", /Replace these on the Aryeo listing/.test(tj) && /href="\/api\/photo-fixes\/[a-z0-9]+"/.test(jobHtml));
    c.ok("job: images use the staff route with the content hash", /\/api\/photo-delivery\/img\/[a-z0-9]+\/thumb768\?v=h-A\.jpg/.test(jobHtml));
    const tc = text(cartHtml);
    c.ok("fix cart: blockers said plainly (switched off, not connected)", /Fixes can.t run right now/.test(tc) && /switched off until Jordan approves/.test(tc) && /not connected/.test(tc), tc.slice(tc.indexOf("Fixes can"), tc.indexOf("Fixes can") + 300));
    c.ok("fix cart: the three ways to decide and Run selected", /Fix all/.test(tc) && /Fix Critical \+ Major only/.test(tc) && /Ignore all Minor/.test(tc) && /Run selected/.test(tc));
    c.ok("fix cart: human calls say why", /Needs your call/.test(tc));
    c.ok("lightbox: findings, boxes, versions, CV numbers", /Findings on this photo/.test(tc) && /Sharpness score/.test(tc) && /Versions/.test(tc) && /left:[\d.]+%/.test(cartHtml));
    const tcov = text(coverageHtml);
    c.ok("coverage: ordered vs the gallery, and Accept with reason", /What was ordered/.test(tcov) && /Drone photos/.test(tcov) && /Accept with reason/.test(tcov) && /Not met/.test(tcov));
    c.ok("files: sources, versions, QC runs, batches", /Aryeo listing/.test(text(filesHtml)) && /QC runs/.test(text(filesHtml)) && /Fix batches/.test(text(filesHtml)));
    const tr = text(reviewHtml);
    c.ok("review mode: starts on the asked photo, with its findings and the keys", /2 of 3/.test(tr) && /Family photos on the fridge/.test(tr) && /Next/.test(tr) && /Previous/.test(tr), tr.slice(0, 300));
    const tcr = text(creditsHtml);
    c.ok("credits: balance, sparkline, spend by kind, alerts, ledger, top-up line", /389/.test(tcr) && /Lowest 389/.test(tcr) && /Used outside the pipeline/.test(tcr) && /Warning below/.test(tcr) && /Top up in AutoHDR: the hub never buys credits/.test(tcr) && /Ledger/.test(tcr));
    const ts = text(settingsHtml);
    c.ok("settings: the fix runner switch with its explanation", /Run approved AutoHDR fixes/.test(ts) && /nothing is sent to AutoHDR/.test(ts));
    c.ok("settings: every setting is on the page", ["Track photo jobs", "Run QC", "Shadow mode", "Build phase", "Auto-run fixes that cost no credits", "Kyle&rsquo;s approval limit", "Daily automatic credit limit", "Mirror status into Aryeo", "Confidence floor", "Minimum long edge", "QC start date", "Monthly QC budget", "Mask padding", "Compare every photo with its original"].every((w) => ts.includes(w.replace("&rsquo;", "\u2019")) || ts.includes(w.replace("&rsquo;", "'"))), ts.slice(0, 200));
    c.ok("settings: the client profile is listed with its override", /Render Client TEST/.test(ts) && /1 override/.test(ts) && /12 h SLA/.test(ts));

    // =======================================================================
    c.head("3 · money stays with the owner");
    // =======================================================================
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const { FilesPanel, ActivityPanel } = await import("@/components/photoDelivery/JobPanels");
    const asAdmin = (await data.loadJobDetail(job.id, { viewer: admin, now }))!;
    const adminJob = html(createElement(JobWorkspace, { data: asAdmin, viewer: admin, initialTab: "files", activity: createElement(ActivityPanel, { events: asAdmin.events }), files: createElement(FilesPanel, { header: asAdmin.header, photos: asAdmin.photos, runs: asAdmin.runs, batches: asAdmin.batches, canSeeMoney: false }) }));
    c.ok("an admin's job page (Files tab, with run costs) carries no dollar figure", adminJob.length > 1000 && !DOLLARS.test(text(adminJob)), (text(adminJob).match(/.{40}\$\s?\d.{20}/) ?? [""])[0]);
    const adminCart = html(createElement(JobWorkspace, { data: asAdmin, viewer: admin, initialTab: "cart", activity: null, files: null }));
    c.ok("... nor its Fix Cart, which shows the approval limit instead", !DOLLARS.test(text(adminCart)) && /Your approval limit is 25 credits per batch/.test(text(adminCart)));
    c.ok("... and the admin's page payload has no dollar fields filled", asAdmin.header.lastRunCostUsd === null && asAdmin.cart?.usdPerCredit === null && asAdmin.batches.every((b) => b.estimatedUsd === null));
    c.ok("the owner's job page shows the run cost", /\$2\.37/.test(text(jobHtml)) || /\$2\.37/.test(text(filesHtml)));
    const adminCredits = await data.loadCreditsPage(admin, { now });
    c.ok("an admin's credits data has no dollar rate", adminCredits.credit.usdPerCredit === null);
    c.ok("the owner's credits page shows dollars", DOLLARS.test(tcr));

    // =======================================================================
    c.head("4 · copy");
    // =======================================================================
    const dashed = Object.entries(all).filter(([, h]) => LONG_DASH.test(text(h))).map(([k, h]) => `${k}: ${(text(h).match(/.{30}[\u2013\u2014].{30}/) ?? [""])[0]}`);
    c.ok("no em or en dash in any rendered page", dashed.length === 0, dashed.join(" | "));
    c.ok("nothing rendered says undefined, null or NaN", Object.values(all).every((h) => !/\b(undefined|NaN)\b|>null</.test(text(h))), Object.entries(all).filter(([, h]) => /\b(undefined|NaN)\b/.test(text(h))).map(([k]) => k).join(", "));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
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

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
    const filesHtml = await render("the job page on the History tab (an old ?tab=files link)", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "files" }) }));
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
    c.ok("board: every column, in order", ["Editing", "Checking", "Needs decision", "Fixing", "On hold", "Ready to review", "Delivering", "Delivered"].every((w) => tb.includes(w)) && tb.indexOf("Editing") < tb.indexOf("Needs decision") && tb.indexOf("Needs decision") < tb.indexOf("Delivered"));
    c.ok("board: the card shows the street, client, photographer, SLA and ticket counts (privacy critical; bins + coverage major)", /9 Render Row/.test(tb) && /Render Client TEST/.test(tb) && /Render Photographer/.test(tb) && /left/.test(tb) && /1 critical/.test(tb) && /2 major/.test(tb), tb.slice(tb.indexOf("9 Render Row"), tb.indexOf("9 Render Row") + 300));
    // Oct 15 2026 (settings audit #10): shadow mode shows once, on Settings; no banner, chip or table line on the queue.
    c.ok("board: no shadow banner, chip or line", !/shadow/i.test(tb) && !/shadow/i.test(text(table)));
    c.ok("board: AutoHDR not connected, said plainly", /AutoHDR API not connected/.test(tb));
    c.ok("table view renders rows with a caption", /Photo jobs, sorted by when they are due/.test(table) && /9 Render Row/.test(text(table)));
    const tj = text(jobHtml);
    c.ok("job: header facts (stage stepper, Aryeo links, verdict, credits spent)", /Review/.test(tj) && /realtourpilot\.aryeo\.com\/admin\/listings\/lst-render\/edit/.test(jobHtml) && /Needs a decision/.test(tj) && /3 AutoHDR credits spent/.test(tj));
    c.ok("job: groups first, with the privacy chip and the low-confidence drawer", /Trash or recycling bin/.test(tj) && /Privacy/.test(tj) && /Low confidence/.test(tj));
    c.ok("job: the deliver panel with the advisory badge and the steps", /Delivery checklist: \d+ of \d+ pass/.test(tj) && /Advisory/.test(tj) && /Mark as delivering/.test(tj) && /Copy message/.test(tj));
    c.ok("job: Replace these on the Aryeo listing, with the download", /Replace these on the Aryeo listing/.test(tj) && /href="\/api\/photo-fixes\/[a-z0-9]+"/.test(jobHtml));
    c.ok("job: images use the staff route with the content hash", /\/api\/photo-delivery\/img\/[a-z0-9]+\/thumb768\?v=h-A\.jpg/.test(jobHtml));
    const tc = text(cartHtml);
    c.ok("fix cart: blockers said plainly (switched off, not connected)", /Fixes can.t run right now/.test(tc) && /AutoHDR fixes are switched off \(Photo Delivery settings, Fixes\)/.test(tc) && /not connected/.test(tc), tc.slice(tc.indexOf("Fixes can"), tc.indexOf("Fixes can") + 300));
    c.ok("fix cart: one Run selected, no Fix all (the ticks pick what runs)", /Run selected/.test(tc) && !/Fix all|Fix Critical \+ Major only|Ignore all Minor/.test(tc));
    // Oct 15 2026 (job page UI audit, item 4): at most three decision buttons on an issue, the rest under "More".
    const DECIDE = /\bFix\b|In cart|Not worth fixing|Not there|Send to editor|Reshoot|Override|Stop flagging this/;
    const decideRows = (h: string) => h.split('aria-label="Decide"').slice(1).map((seg) => seg.split("</li>")[0]);
    const outside = (seg: string) => (seg.replace(/<details[\s\S]*?<\/details>/g, "").match(/<button[\s\S]*?<\/button>/g) ?? []).map((b) => text(b).trim()).filter((b) => DECIDE.test(b) && !/Undo/.test(b));
    const rows = [...decideRows(jobHtml), ...decideRows(cartHtml)];
    c.ok("an issue shows at most three decision buttons; Send to editor, Reshoot and Override wait under More", rows.length >= 2 && rows.every((seg) => outside(seg).length <= 3 && /<summary[^>]*>\s*More/.test(seg) && !outside(seg).some((b) => /Send to editor|Reshoot|Override/.test(b)) && /Send to editor/.test(text(seg))), rows.map((seg) => outside(seg).join("/")).join(" | "));
    c.ok("Fix is hidden, not greyed out, when there is nothing to fix, and the reason has no 'No Fix button' prefix", rows.some((seg) => /Privacy: choose blur/.test(text(seg)) && !outside(seg).some((b) => /\bFix\b/.test(b))) && !/No Fix button/.test(tj + tc));
    c.ok("fix cart: human calls say why", /Needs your call/.test(tc));
    c.ok("lightbox: findings, boxes, versions, CV numbers", /Findings on this photo/.test(tc) && /Sharpness score/.test(tc) && /Versions/.test(tc) && /left:[\d.]+%/.test(cartHtml));
    const tcov = text(coverageHtml);
    c.ok("coverage: ordered vs the gallery, and Accept with reason", /What was ordered/.test(tcov) && /Drone photos/.test(tcov) && /Accept with reason/.test(tcov) && /Not met/.test(tcov));
    c.ok("history: sources, versions, QC runs, batches", /Aryeo listing/.test(text(filesHtml)) && /QC runs/.test(text(filesHtml)) && /Fix batches/.test(text(filesHtml)));
    const tr = text(reviewHtml);
    c.ok("review mode: starts on the asked photo, with its findings and the keys", /2 of 3/.test(tr) && /Family photos on the fridge/.test(tr) && /Next/.test(tr) && /Previous/.test(tr), tr.slice(0, 300));
    const tcr = text(creditsHtml);
    c.ok("credits: balance, sparkline, spend by kind, alerts, ledger, top-up line", /389/.test(tcr) && /Lowest 389/.test(tcr) && /Used outside the pipeline/.test(tcr) && /Warning below/.test(tcr) && /Top up in AutoHDR: the hub never buys credits/.test(tcr) && /Ledger/.test(tcr));
    const ts = text(settingsHtml);
    // Oct 15 2026 (settings audit): fixes and paid QC are one choice each; the dead switches and the mask padding are gone.
    c.ok("settings: fixes are one three-way choice", /Fixes/.test(ts) && /Only when someone approves/.test(ts) && /Automatic/.test(ts) && /not even one approved in the Fix Cart/.test(ts));
    c.ok("settings: every setting is on the page", ["Photo Delivery on", "Send shoots to AutoHDR", "Bring the edits back into the hub", "Free photo check", "Daily limit on automatic fixes", "Kyle approves each job", "Advanced", "Paid QC (Claude)", "Only when someone presses Run QC", "Every gallery", "shadow mode", "Which checks the paid QC runs", "Kyle&rsquo;s approval limit", "Confidence floor", "Smallest photo allowed", "Track shoots from", "Monthly QC budget"].every((w) => ts.includes(w.replace("&rsquo;", "\u2019")) || ts.includes(w.replace("&rsquo;", "'"))), ts.slice(0, 200));
    c.ok("settings: the dead switches are gone", !/Auto-run fixes that cost no credits|Mirror status into Aryeo|Compare every photo with its original|Daily automatic credit limit|Mask padding/.test(ts));
    c.ok("settings: the client profile is listed with its override, without the SLA", /Render Client TEST/.test(ts) && /1 override/.test(ts) && !/h SLA|SLA hours/.test(ts));

    // =======================================================================
    c.head("3 · money stays with the owner");
    // =======================================================================
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const { HistoryPanel } = await import("@/components/photoDelivery/JobPanels");
    const asAdmin = (await data.loadJobDetail(job.id, { viewer: admin, now }))!;
    const adminJob = html(createElement(JobWorkspace, { data: asAdmin, viewer: admin, initialTab: "activity", history: createElement(HistoryPanel, { events: asAdmin.events, header: asAdmin.header, photos: asAdmin.photos, runs: asAdmin.runs, batches: asAdmin.batches, canSeeMoney: false }) }));
    c.ok("an admin's job page (History tab, with run costs) carries no dollar figure", adminJob.length > 1000 && !DOLLARS.test(text(adminJob)), (text(adminJob).match(/.{40}\$\s?\d.{20}/) ?? [""])[0]);
    const adminCart = html(createElement(JobWorkspace, { data: asAdmin, viewer: admin, initialTab: "cart", history: null }));
    c.ok("... nor its Fix Cart, which shows the approval limit instead", !DOLLARS.test(text(adminCart)) && /Your approval limit is 25 credits per batch/.test(text(adminCart)));
    c.ok("... and the admin's page payload has no dollar fields filled", asAdmin.header.lastRunCostUsd === null && asAdmin.cart?.usdPerCredit === null && asAdmin.batches.every((b) => b.estimatedUsd === null));
    // The seeded shoot is not linked to AutoHDR, so its real cart has nothing AutoHDR can run: the same lines as runnable ones.
    const runnable = { ...asAdmin, cart: { ...asAdmin.cart!, lines: asAdmin.cart!.lines.map((l) => (l.ruleId === "PREP_TRASH_CANS" ? { ...l, humanCall: null, credits: 1 } : l)) } };
    const tRun = text(html(createElement(JobWorkspace, { data: runnable, viewer: admin, initialTab: "cart", history: null })));
    c.ok("fix cart: Select all · Critical + Major · Clear tick fixes, Run selected is the one button that runs, prices in credits", /AutoHDR can fix/.test(tRun) && /Select all · Critical \+ Major · Clear/.test(tRun) && /Run selected/.test(tRun) && /· 1 credit\b/.test(tRun) && !/\b1 cr\b/.test(tRun) && !/Fix all|Ignore all Minor/.test(tRun), tRun.slice(Math.max(0, tRun.indexOf("AutoHDR can fix")), tRun.indexOf("AutoHDR can fix") + 160));
    const adminBox = text(html(createElement(JobWorkspace, { data: asAdmin, viewer: admin, initialTab: "issues", initialPhoto: A.id, history: null })));
    c.ok("an admin's lightbox leaves out the measurements (CV numbers, hero score); the owner's keeps them", /Findings on this photo/.test(adminBox) && !/Measured \(CV\)|Sharpness score|hero score/.test(adminBox) && /Measured \(CV\)/.test(tc));
    c.ok("the owner's job page shows the run cost", /\$2\.37/.test(text(jobHtml)) || /\$2\.37/.test(text(filesHtml)));
    const adminCredits = await data.loadCreditsPage(admin, { now });
    c.ok("an admin's credits data has no dollar rate", adminCredits.credit.usdPerCredit === null);
    c.ok("the owner's credits page shows dollars", DOLLARS.test(tcr));

    // =======================================================================
    c.head("3b · the job frame: one main button, one download, four tabs");
    // =======================================================================
    // Oct 15 2026 (job page UI audit, items 1-3, 6-9, 12; perf audit 4-5).
    const deliverOf = (h: string) => (h.split('aria-label="Deliver"')[1] ?? "").replace(/^[^>]*>/, "").split("</section>")[0];
    const barOf = (h: string) => deliverOf(h).split('id="pd-deliver-body"')[0];
    const mains = (h: string) => (deliverOf(h).match(/<(?:button|a)\b[^>]*bg-brand-action[^>]*>[\s\S]*?<\/(?:button|a)>/g) ?? []).map((b) => text(b).trim());
    const folderUrl = "https://www.dropbox.com/home/render/06-Ready-for-Aryeo";
    type Push = typeof asAdmin.aryeoPush;
    const withStage = (stage: string, aryeoPush: Push, extra: Partial<typeof asAdmin.header> = {}) => ({
      ...asAdmin,
      header: { ...asAdmin.header, stage, ...extra },
      steps: { ...asAdmin.steps!, listingUrl: asAdmin.steps!.listingUrl ?? "https://realtourpilot.aryeo.com/admin/listings/lst-render/edit", ready: { folderUrl, files: 3, expected: 3, ready: true, stagedAt: null } },
      aryeoPush,
    });
    const hubOff: Push = { mode: "off", connected: false, progress: null, sameDayAuto: false };
    const hubOn: Push = { mode: "on", connected: true, progress: null, sameDayAuto: false };
    const prog = (o: Partial<NonNullable<Push["progress"]>>): Push => ({ ...hubOn, progress: { state: "WAITING", active: false, total: 3, sent: 3, already: 0, note: null, startedAt: now.toISOString(), finishedAt: null, deliveredAt: null, waitingForApproval: true, ...o } });
    const frame = (label: string, d: typeof asAdmin) => {
      const h = html(createElement(JobWorkspace, { data: d, viewer: admin, history: null }));
      all[`deliver bar: ${label}`] = h;
      return h;
    };
    c.ok("the seeded checklist lets Kyle deliver (shadow mode advises)", asAdmin.gate?.canDeliver === true, JSON.stringify(asAdmin.gate?.checks.map((x) => x.ok)));
    const readyOn = frame("READY, hub on", withStage("READY", hubOn));
    c.ok("Ready to review with the hub's upload on: Approve and deliver is the main button, Approve and upload to Aryeo beside it, no Mark as delivering (Jordan, Oct 15)", JSON.stringify(mains(readyOn)) === '["Approve and deliver"]' && /Approve and upload to Aryeo/.test(text(barOf(readyOn))) && !/Mark as delivering|Send to Aryeo/.test(text(deliverOf(readyOn))), mains(readyOn).join(" | "));
    c.ok("... the steps by hand wait behind Do it by hand instead, and the copy no longer says the hub can't upload", /<summary[^>]*>\s*Do it by hand instead/.test(deliverOf(readyOn)) && /Copy message/.test(text(deliverOf(readyOn).split("Do it by hand instead")[1] ?? "")) && !/can.t upload/.test(text(deliverOf(readyOn))));
    const waitingOn = frame("waiting for Deliver in Aryeo", withStage("READY", prog({})));
    c.ok("photos up and waiting: Deliver in Aryeo is the one main button; Upload again waits inside", JSON.stringify(mains(waitingOn)) === '["Deliver in Aryeo"]' && !/Upload again/.test(text(barOf(waitingOn))) && /Upload again/.test(text(deliverOf(waitingOn))), mains(waitingOn).join(" | "));
    const changedOn = frame("changed after upload", withStage("READY", prog({ state: "DONE", waitingForApproval: false, changed: true, note: "The photos changed after they went on the listing (a fix, a restore or a new order). Approve again to update the listing." })));
    c.ok("photos changed after they went up: Kyle approves again (no Deliver in Aryeo of the old set)", JSON.stringify(mains(changedOn)) === '["Approve and deliver"]' && !/Deliver in Aryeo/.test(text(barOf(changedOn))), mains(changedOn).join(" | "));
    const decideOn = frame("QC_REVIEW, hub on", withStage("QC_REVIEW", hubOn));
    c.ok("Needs decision: no approve yet, the bar says to decide the open issues first", mains(decideOn).length === 0 && !/Approve/.test(text(barOf(decideOn))) && /Decide the open issues first/.test(text(barOf(decideOn))));
    const sameDayOn = frame("same-day order", withStage("READY", { ...hubOn, sameDayAuto: true }));
    c.ok("a same-day order says the hub approves and delivers it by itself once every check passes", /Same-day order: the hub approves and delivers it by itself once every check passes/.test(text(barOf(sameDayOn))));
    const sendingOn = frame("sending", withStage("READY", prog({ state: "SENDING", active: true, sent: 1, waitingForApproval: false })));
    c.ok("while the hub sends: no main button, the bar says how far", mains(sendingOn).length === 0 && /Sending to Aryeo: 1 of 3/.test(text(barOf(sendingOn))), text(barOf(sendingOn)).slice(0, 200));
    const failedOn = frame("send failed", withStage("READY", prog({ state: "FAILED", note: "Aryeo said no.", waitingForApproval: false })));
    c.ok("after a failed send: Kyle approves again", JSON.stringify(mains(failedOn)) === '["Approve and deliver"]', mains(failedOn).join(" | "));
    const readyOff = frame("READY, hub off", withStage("READY", hubOff));
    c.ok("hub upload off: Mark as delivering is the one main button, no approve", JSON.stringify(mains(readyOff)) === '["Mark as delivering"]' && !/Approve and/.test(text(deliverOf(readyOff))), mains(readyOff).join(" | "));
    const editing = frame("EDITING", withStage("EDITING", hubOn));
    c.ok("a stage that can't deliver yet: no main button (not a greyed one), the reason instead", mains(editing).length === 0 && !/Mark as delivering|Approve and|Deliver in Aryeo/.test(text(barOf(editing))) && /AutoHDR.s edits are not in yet/.test(text(barOf(editing))));
    const delivering = frame("DELIVERING", withStage("DELIVERING", hubOff, { deliveryNextCheckAt: new Date(now.getTime() + 5 * 60_000).toISOString() }));
    c.ok("Verify now sits inside the panel, not on the bar", !/Verify now/.test(text(barOf(delivering))) && /Verify now/.test(text(deliverOf(delivering))));
    const links = (h: string) => (deliverOf(h).match(/href="https:\/\/www\.dropbox\.com\/home\/render\/06-Ready-for-Aryeo"/g) ?? []).length;
    c.ok("one download: Download photos on the bar, none in the steps", links(readyOff) === 1 && links(readyOn) === 1 && /Download photos/.test(text(barOf(readyOff))) && !/Download all/.test(text(deliverOf(readyOff))));
    c.ok("main buttons share one look (brand action, brand text, brightness hover)", [readyOn, waitingOn, readyOff].every((h) => !/bg-brand-action text-white|hover:opacity-90/.test(deliverOf(h)) && /bg-brand-action text-brand-fg hover:brightness-95/.test(deliverOf(h))));
    const tabNames = [...adminJob.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim().replace(/\s*\d+$/, ""));
    c.ok("four tabs: Issues, Fix Cart, Coverage, History", tabNames.join("|") === "Issues|Fix Cart|Coverage|History", tabNames.join("|"));
    c.ok("history keeps the files behind one line and leaves out the debug (passes and models, Aryeo's CDN link)", /Photos, versions, QC runs and fixes/.test(text(adminJob)) && /Fix batches/.test(text(adminJob)) && !/Passes and models|Aryeo.s CDN/.test(text(adminJob)));
    const stepper = (jobHtml.match(/aria-label="Pipeline stage"[\s\S]*?<\/ol>/) ?? [""])[0];
    c.ok("stepper: Edited, Checking, Decide, Ready to review; on a phone only the current step is named", ["Edited", "Checking", "Decide", "Ready to review"].every((w) => text(stepper).includes(w)) && !/Landed|Decision|>QC</.test(stepper) && /sr-only sm:not-sr-only">Edited/.test(stepper) && /font-semibold text-foreground">Decide/.test(stepper), text(stepper));
    const summary = (jobHtml.split('aria-label="Job summary"')[1] ?? "").replace(/^[^>]*>/, "").split("</section>")[0];
    c.ok("shadow mode shows once on the job page: the Deliver bar's Advisory badge", /Advisory/.test(text(barOf(jobHtml))) && !/shadow/i.test(text(summary)) && !/advisory in shadow mode/i.test(tj), (text(summary).match(/.{0,60}shadow.{0,60}/i) ?? [""])[0]);
    const { JobHeaderActions } = await import("@/components/photoDelivery/JobHeaderActions");
    const head = html(createElement(JobHeaderActions, { jobId: job.id, stage: "QC_REVIEW", qcEnabled: true, autohdr: true }));
    const [inView, menu = ""] = head.split("<details");
    c.ok("header: Review mode in view; Put on hold, Check again and Sync from AutoHDR under More", /Review mode/.test(text(inView)) && /<summary[^>]*>\s*More/.test(menu) && ["Put on hold", "Check again", "Sync from AutoHDR"].every((w) => text(menu).includes(w)) && /title="Runs the photo check again\."/.test(head) && !/Re-run QC|Check AutoHDR for changes|Anthropic/.test(head));
    const held = html(createElement(JobHeaderActions, { jobId: job.id, stage: "ON_HOLD", qcEnabled: true }));
    c.ok("on hold: Release hold in view, Review mode under More", /Release hold/.test(text(held.split("<details")[0])) && /Review mode/.test(text(held.split("<details")[1] ?? "")));
    const find = (node: unknown, type: unknown): { props: Record<string, unknown> } | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const f = find(n, type);
          if (f) return f;
        }
        return null;
      }
      const el = node as { type?: unknown; props?: { children?: unknown } };
      return el.type === type ? (el as { props: Record<string, unknown> }) : find(el.props?.children, type);
    };
    const ws = find(await JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({}) }), JobWorkspace);
    const wsData = ws?.props.data as { events: unknown[]; batches: unknown[] } | undefined;
    const histEvents = ((ws?.props.history as { props?: { events?: unknown[] } } | undefined)?.props?.events ?? []).length;
    c.ok("the page hands the browser no events or batches; History renders them on the server", !!wsData && wsData.events.length === 0 && wsData.batches.length === 0 && histEvents > 0, `${wsData?.events.length}/${wsData?.batches.length}/${histEvents}`);
    const fsMod = await import("node:fs");
    const src = (f: string) => fsMod.readFileSync(f, "utf8");
    const pollers = ["src/components/photoDelivery/AryeoPushControls.tsx", "src/components/photoDelivery/ReadyProgressBar.tsx", "src/components/photoDelivery/DeliverPanel.tsx"].map(src).join("\n");
    c.ok("the polls go through the GET route (not a server action), pause while hidden, and the 45 s refresh is gone", !/aryeoPushProgressAction|readyProgressAction|45_000/.test(pollers) && (pollers.match(/\/api\/photo-delivery\/progress\//g) ?? []).length === 2 && (pollers.match(/document\.hidden/g) ?? []).length >= 3);
    const route = await import("@/app/api/photo-delivery/progress/[jobId]/route");
    const ask = async (what: string) => {
      const res = await route.GET({ nextUrl: new URL(`http://hub.test/api/photo-delivery/progress/${job.id}?what=${what}`) } as never, { params: Promise.resolve({ jobId: job.id }) });
      return { status: res.status, body: (await res.json()) as { ok: boolean; progress: unknown } };
    };
    const [rPush, rReady, rBad] = [await ask("push"), await ask("ready"), await ask("nope")];
    c.ok("the progress route answers (nothing running here) and refuses a bad ask", rPush.status === 200 && rPush.body.ok && rPush.body.progress === null && rReady.status === 200 && rReady.body.ok && rBad.status === 400 && /await requireAdmin\(\)/.test(src("src/app/api/photo-delivery/progress/[jobId]/route.ts")), JSON.stringify([rPush, rReady, rBad]));

    // =======================================================================
    c.head("3c · Oct 15: the home type, the rooms, the as-is clients");
    // =======================================================================
    {
      const { photoSetKey } = await import("@/lib/photoDelivery/coverage");
      const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
      const active = await prisma.photoAsset.findMany({ where: { jobId: job.id, status: "ACTIVE" }, select: { id: true } });
      await prisma.photoJob.update({
        where: { id: job.id },
        data: {
          prepMode: "AS_IS", prepModeBy: "auto", prepModeAt: now,
          prepStatsJson: JSON.stringify({ rated: 4, reason: "3 of 4 rooms lived in or cluttered" }),
          coverageCheckedAt: now,
          coverageJson: JSON.stringify({
            v: 1, photoSet: photoSetKey(active.map((p) => p.id)), done: true, at: now.toISOString(),
            expected: { bedrooms: 3, bathrooms: 2, propertyType: "single family" },
            counts: { raw: 80, expectedPhotos: 16, autohdr: 16, delivered: 2, leftOut: 1 },
            capturedKnown: true, capturedNote: null, captured: {}, lostInEdit: [],
            rooms: [
              { key: "front-exterior", label: "Front exterior", status: "DELIVERED", severity: null, photos: ["A.jpg"], note: "" },
              { key: "kitchen", label: "Kitchen", status: "DELIVERED", severity: null, photos: ["B.jpg"], note: "" },
              { key: "living", label: "Living area", status: "NOT_DELIVERED", severity: "MAJOR", photos: ["C.jpg"], note: "It was shot but is not in the delivery: C.jpg (left out of the delivery)." },
              { key: "primary-shower", label: "Primary shower or tub", status: "ADVISORY", severity: "MINOR", photos: ["B.jpg"], note: "The primary shower has no photo of its own: it only shows in the background of B.jpg." },
              { key: "primary-bedroom", label: "Primary bedroom", status: "NOT_CAPTURED", severity: "MAJOR", photos: [], note: "Not in AutoHDR's photos of the shoot: it looks like it was never photographed." },
            ],
          }),
        },
      });
      await f({ photoId: A.id, ruleId: "EXT_GARDEN_HOSES", groupKey: "GARDEN_HOSE", status: "IGNORED", statusReason: "As-is home: clutter not checked", decidedBy: "hub: as-is home", decidedAt: now, specificIssue: "Hose on the lawn (hidden)" });
      const freeBefore = (await (await import("@/lib/photoDelivery/settings")).photoDeliverySettings()).freeCheck;
      await savePhotoDeliverySettings({ asIsClientIds: [client.id], freeCheck: true }, "drill");
      const prepHtml = await render("the job page with an as-is home", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({}) }));
      const t = text(prepHtml);
      c.ok("the Home fact: as-is, what it means, why, and how much clutter is not shown", /As-is home/.test(t) && /Clutter is not checked\./.test(t) && /Read from the photos: 3 of 4 rooms lived in or cluttered\./.test(t) && /1 clutter item not shown/.test(t), (t.match(/Home .{0,240}/) ?? [""])[0]);
      c.ok("the owner can set it for this job (Automatic, Prepared, As-is, Vacant)", /Set for this job/.test(t) && ["Automatic", "Prepared", "As-is", "Vacant"].every((w) => prepHtml.includes(`>${w}</option>`)));
      c.ok("the hidden clutter is not listed on the job page", !/Hose on the lawn \(hidden\)/.test(t) && /As-is home: 1 clutter item not shown/.test(t));
      const kyle = await data.loadJobDetail(job.id, { viewer: admin, now });
      const { PrepModeControl } = await import("@/components/photoDelivery/PrepModeControl");
      const kyleChip = text(html(createElement(PrepModeControl, { jobId: job.id, prep: kyle!.prep, canSet: false })));
      c.ok("Kyle sees the home type, never the setting", /As-is home/.test(kyleChip) && !/Set for this job/.test(kyleChip));
      const covHtml = await render("the Coverage tab with the room check", () => JobPage({ params: Promise.resolve({ jobId: job.id }), searchParams: Promise.resolve({ tab: "coverage" }) }));
      const ct = text(covHtml);
      c.ok("the Coverage tab lists the rooms the listing needs, room by room", /Rooms the listing needs/.test(ct) && /From the listing: 3 bedrooms, 2 bathrooms, single family\./.test(ct) && /Living area : Shot, not in the delivery/.test(ct) && /Primary bedroom : Never photographed/.test(ct) && /Primary shower or tub : Worth a look/.test(ct) && /only shows in the background of B\.jpg/.test(ct) && /Uploaded: 80 raw files \(about 16 photos\) · AutoHDR: 16 photos · Delivered: 2 · Left out: 1/.test(ct), (ct.match(/Rooms the listing needs.{0,400}/) ?? [""])[0]);
      const setHtml = await render("the settings page with the free checks and the as-is clients", () => SettingsPage());
      const stt = text(setHtml);
      c.ok("settings: the four free checks and the as-is clients picker, with the client on the list", ["Measure the lines", "Compare cut-off roofs and warps with AutoHDR's original", "Room coverage", "Check listing photos that change after delivery", "As-is clients"].every((w) => stt.includes(w)) && /Remove Render Client TEST/.test(setHtml), "");
      await savePhotoDeliverySettings({ asIsClientIds: [], freeCheck: freeBefore }, "drill");
    }

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

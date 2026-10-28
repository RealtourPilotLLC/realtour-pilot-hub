// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Fixed in AutoHDR, and the job's ONE Client requests item (Oct 28 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct28-photo-fixed-requests.ts
//
// Kyle, on the feedback board:
//   A · "For "Not there" option in photo editing, can you add an option to
//       mark it as fixed with autohdr?"
//   B · 40 N Perry St (Ashley Brunner): "We don't need those notifications
//       when the photos are not uploaded yet (Points 4,5 and 6). Virtual
//       staging is also showing twice, as it was in the order instructions
//       and texted to us. If it's the same request, then it should be
//       combined into one and if it's multiple requests then it should be in
//       one category/task for the job (Client Requests)".
//
//   1 · pure: Fixed in AutoHDR's words, Undo, the decided line
//   2 · one tap: FIXED (never "not there"), who and when; the checklist and
//       the review stage read it as fixed; Undo reopens it; a "Not there"
//       turns into it; the hub's own paid fix is never undone this way
//   3 · pure: a request that only asks for the add-on again is the add-on
//   4 · pure: the Client requests lines (one per request, its places listed),
//       the photo checks that wait for the upload, the holding list
//   5 · 40 N Perry St in the database: before the upload the photo checks wait
//       (not to-dos, not counted as failing, said plainly); staging once, with
//       the order note and Ashley's text; the other requests their own lines;
//       the job page, the Deliver panel, the board's chip; one button settles
//       the staging and the requests that only asked for it
//   6 · plain words, no em dashes
//
// ISOLATION: PGlite via the shared harness; nothing leaves (Slack answered here).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
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
const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
const DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7428) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const FA = await import("@/lib/photoDelivery/fixedInAutohdr");
    const fmt = await import("@/components/photoDelivery/format");
    const decisions = await import("@/lib/photoDelivery/decisions");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const A = await import("@/lib/photoDelivery/addOns");
    const H = await import("@/lib/photoDelivery/holding");
    const data = await import("@/app/ops/photo-delivery/data");
    const { createAsk } = await import("@/lib/clientAsks");
    const { PHOTO_OFFICE_KEY_PREFIX } = await import("@/lib/itemMedium");
    const { NOTHING_TO_REMOVE_SENTINEL } = await import("@/lib/debrief");
    await savePhotoDeliverySettings({ enabled: true, qcShadow: false, aryeoPush: "off" }, "drill");
    const kyleView = { role: "ADMIN", name: "Kyle Smith", isOwner: false, canSeeMoney: false };
    const DAY = 86_400_000;
    type Line = Parameters<typeof H.clientRequestLines>[0][number];

    // ======================================================================
    c.head("1 · pure: Fixed in AutoHDR's words, Undo, the decided line");
    // ======================================================================
    const mine = { status: "FIXED", statusReason: "Fixed in AutoHDR", decidedBy: "Kyle Smith", decidedAt: "2026-10-28T19:04:00.000Z" };
    const paid = { status: "FIXED", statusReason: null, decidedBy: null, decidedAt: null };
    const when = () => "Oct 28, 3:04 PM";
    c.ok("a person's tap is FIXED with the reason 'Fixed in AutoHDR'; the hub's own paid fix (FIXED, no such reason) is not", FA.isFixedInAutohdr(mine) && FA.isFixedInAutohdr({ ...mine, statusReason: "Fixed in AutoHDR: the car in the driveway" }) && !FA.isFixedInAutohdr(paid) && !FA.isFixedInAutohdr({ status: "FALSE_POSITIVE", statusReason: "Fixed in AutoHDR" }));
    c.ok("its outcome reads 'Fixed in AutoHDR'; a paid fix still reads Fixed; Not there stays Not there", fmt.findingStatusLabel(mine) === "Fixed in AutoHDR" && fmt.findingStatusLabel(paid) === (fmt.FINDING_STATUS_LABEL.FIXED ?? "FIXED") && fmt.findingStatusLabel({ status: "FALSE_POSITIVE" }) === fmt.FINDING_STATUS_LABEL.FALSE_POSITIVE, `${fmt.findingStatusLabel(paid)} | ${fmt.FINDING_STATUS_LABEL.FALSE_POSITIVE}`);
    c.ok("Undo is offered on it (a person's call), never on the paid fix (undone by restoring the photo)", fmt.isUndoable(mine) && !fmt.isUndoable(paid) && fmt.isUndoable({ status: "FALSE_POSITIVE" }) && !fmt.isUndoable({ status: "OPEN" }));
    c.ok("the decided line: who and when, the reason not repeated, a note after it", fmt.decidedLine(mine, when) === "Fixed in AutoHDR by Kyle Smith, Oct 28, 3:04 PM" && fmt.decidedLine({ ...mine, statusReason: "Fixed in AutoHDR: the car in the driveway" }, when) === "Fixed in AutoHDR by Kyle Smith, Oct 28, 3:04 PM: the car in the driveway" && fmt.decidedLine({ status: "OPEN" }, when) === null, String(fmt.decidedLine(mine, when)));
    c.ok("Fixed in AutoHDR is one of the decisions the hub knows", decisions.DECISION_STATUSES.includes("FIXED_IN_AUTOHDR"));

    // ======================================================================
    c.head("2 · one tap: recorded FIXED, who and when; read as fixed; Undo; from Not there");
    // ======================================================================
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@oct28.invalid", role: "ADMIN" } as never });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@oct28.invalid", role: "PHOTOGRAPHER" } as never });
    const shot = new Date(Date.now() - 2 * DAY);
    const qClient = await prisma.client.create({ data: { name: "Quinn Drill" } });
    const qProject = await prisma.project.create({ data: { title: "12 Fix Ln, Media, PA", addressLine: "12 Fix Ln", clientId: qClient.id, shootDate: shot, photographerId: harrison.id, removalNotes: NOTHING_TO_REMOVE_SENTINEL, cullingConfirmedAt: shot, debriefSubmittedAt: shot } as never });
    const qJob = await prisma.photoJob.create({ data: { projectId: qProject.id, stage: "QC_REVIEW" } });
    const qRun = await prisma.photoQcRun.create({ data: { jobId: qJob.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: JSON.stringify(["P1"]), checksJson: JSON.stringify({ v: 2 }), startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: qJob.id }, data: { lastQcRunId: qRun.id } });
    const qPhoto = await prisma.photoAsset.create({ data: { jobId: qJob.id, name: "12-1.jpg", sourceKind: "AUTOHDR", contentHash: "q1", inspectedHash: "q1", sequence: 0, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } });
    const mkFinding = (ruleId: string, extra: Record<string, unknown> = {}) => prisma.photoQcFinding.create({ data: { qcRunId: qRun.id, jobId: qJob.id, photoId: qPhoto.id, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: `${ruleId}: front`, explanation: "x", locationText: "front", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", status: "OPEN", arbitration: "CONFIRMED", ...extra } as never });
    const car = await mkFinding("EXT_PARKED_CARS_DRIVEWAY");
    const majorOk = async () => (await delivery.deliveryGate(qJob.id, { sync: false })).checks.find((x) => x.key === "major")?.ok;
    const stageOf = async (id: string) => (await prisma.photoJob.findUniqueOrThrow({ where: { id } })).stage;
    c.ok("before: the major issue holds the checklist, the job is in QC review", (await majorOk()) === false && (await stageOf(qJob.id)) === "QC_REVIEW");
    const t0 = Date.now();
    const r1 = await decisions.decideFindings({ findingIds: [car.id], status: "FIXED_IN_AUTOHDR", by: "Kyle Smith", jobId: qJob.id });
    let f = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: car.id } });
    c.ok("one tap, no reason needed: FIXED (the paid fix's own status), never FALSE_POSITIVE", r1.ok && f.status === "FIXED" && f.statusReason === "Fixed in AutoHDR", `${JSON.stringify(r1)} ${f.status} ${f.statusReason}`);
    c.ok("…with who and when", f.decidedBy === "Kyle Smith" && !!f.decidedAt && f.decidedAt.getTime() >= t0 - 1000);
    c.ok("…the message says so, and that the hub reads AutoHDR again for the fixed version", r1.ok && /1 issue marked fixed in AutoHDR\./.test(r1.message) && /reads AutoHDR again/.test(r1.message), r1.ok ? r1.message : "");
    c.ok("every count reads it as fixed: the checklist's major line passes, and the job moves to Ready", (await majorOk()) === true && (await stageOf(qJob.id)) === "READY" && r1.ok && r1.stage === "READY", `${await stageOf(qJob.id)}`);
    const learned = src("src/lib/photoDelivery/fixPolicy.ts");
    c.ok("…what the hub learns from people's calls counts FIXED as the check being right", /status: \{ in: \["IGNORED", "FALSE_POSITIVE", "APPROVED_FIX", "FIXING", "FIXED"\] \}/.test(learned));
    const r2 = await decisions.decideFindings({ findingIds: [car.id], status: "OPEN", by: "Kyle Smith", jobId: qJob.id });
    f = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: car.id } });
    c.ok("Undo reopens it (who and when cleared); the major line holds again; back to QC review", r2.ok && f.status === "OPEN" && f.statusReason === null && f.decidedBy === null && (await majorOk()) === false && (await stageOf(qJob.id)) === "QC_REVIEW", `${JSON.stringify(r2)} ${f.status}`);
    const r3 = await decisions.decideFindings({ findingIds: [car.id], status: "FALSE_POSITIVE", reason: "Fixed with autohdr", by: "Kyle Smith", jobId: qJob.id });
    const r4 = await decisions.decideFindings({ findingIds: [car.id], status: "FIXED_IN_AUTOHDR", by: "Kyle Smith", jobId: qJob.id });
    f = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: car.id } });
    c.ok("an issue already marked Not there ('Fixed with autohdr', Kyle's old way) turns into Fixed in AutoHDR in one tap", r3.ok && r4.ok && f.status === "FIXED" && f.statusReason === "Fixed in AutoHDR", `${JSON.stringify(r4)} ${f.status} ${f.statusReason}`);
    const paidFix = await mkFinding("EXT_GARDEN_HOSES", { status: "FIXED", statusReason: null, decidedBy: "hub", decidedAt: new Date() });
    const r5 = await decisions.decideFindings({ findingIds: [paidFix.id], status: "OPEN", by: "Kyle Smith", jobId: qJob.id });
    c.ok("the hub's own paid AutoHDR fix is never reopened by Undo (restore the photo's earlier version instead)", !r5.ok && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: paidFix.id } })).status === "FIXED", JSON.stringify(r5));
    const r6 = await decisions.decideFindings({ findingIds: [paidFix.id], status: "FIXED_IN_AUTOHDR", by: "Kyle Smith", jobId: qJob.id });
    c.ok("…nor relabelled as a person's fix", !r6.ok && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: paidFix.id } })).statusReason === null);
    const ui = src("src/components/photoDelivery/FindingActions.tsx") + src("src/components/photoDelivery/JobContext.tsx") + src("src/components/photoDelivery/FixCartPanel.tsx");
    c.ok("the buttons: 'Fixed in AutoHDR' beside Not there, 'It was fixed in AutoHDR' on a Not there; never a paid QC run", /Fixed in AutoHDR/.test(ui) && /It was fixed in AutoHDR/.test(ui) && /FIXED_IN_AUTOHDR/.test(ui) && !/paidQc|runPaidQc/i.test(ui));

    // ======================================================================
    c.head("3 · pure: a request that only asks for the add-on again is the add-on");
    // ======================================================================
    const same = (t: string) => A.sameRequestAsAddOn("virtual_staging", t);
    c.ok("'Hi Kyle! Can you virtually stage the living room and the primary bedroom? Thanks': the staging", same("Hi Kyle! Can you virtually stage the living room and the primary bedroom? Thanks"));
    c.ok("…'Please stage the living room and the den' too, and 'Virtual Staging needed' itself", same("Please stage the living room and the den.") && same("Virtual Staging needed"));
    c.ok("'Remove the furniture in photo 3' is not the staging (furniture words alone never are)", !same("Remove the furniture in photo 3."));
    c.ok("'Stage the den. And remove the trash cans' is not: the trash cans would vanish under the staging line", !same("Stage the den. And remove the trash cans out front."));
    c.ok("lot lines: 'show the lot lines from the plat' is the lot lines; an unknown add-on never matches", A.sameRequestAsAddOn("lot_lines", "Please show the lot lines from the plat I sent.") && !A.sameRequestAsAddOn("lot_lines", "Brighten photo 4.") && !A.sameRequestAsAddOn("drone", "Virtual staging please"));

    // ======================================================================
    c.head("4 · pure: the Client requests lines, and the photo checks that wait");
    // ======================================================================
    const stg = A.ADD_ON_BY_KEY.get("virtual_staging")!;
    const addonLine = (ok = false): Line => ({ key: "addon:virtual_staging", label: stg.need, ok, hold: true, personOnly: true, detail: "Ordered: Virtual Staging (2 staged photos)", addOn: { key: stg.key, need: stg.need, done: stg.done, ordered: "Virtual Staging (2 staged photos)", quotes: [{ from: "Order notes", text: "Please virtually stage the living room and the primary bedroom." }], cleared: ok ? { by: "Kyle" } : null }, request: { what: stg.need, from: "On the order: Virtual Staging (2 staged photos)" } });
    const ask = (id: string, what: string, from: string, o: Partial<Line> = {}): Line => ({ key: `ask:${id}`, label: `Client asked: ${what}`, ok: false, hold: true, askId: id, doneLabel: "Done (fixed)", waitingOn: "Waiting on Kyle", ...o, request: { what, from, ...(o.request ?? {}) } });
    const lines = H.clientRequestLines([
      addonLine(),
      ask("t1", "Can you virtually stage the living room and the bedroom?", "Text from Ashley, Oct 27", { request: { what: "Can you virtually stage the living room and the bedroom?", from: "Text from Ashley, Oct 27", sameAs: "addon:virtual_staging" } }),
      ask("n1", "Please virtually stage the living room and the primary bedroom.", "Order note", { request: { what: "Please virtually stage the living room and the primary bedroom.", from: "Order note", sameAs: "addon:virtual_staging" } }),
      ask("e1", "Take the trash cans out of the front photo", "Email from Ashley, Oct 27"),
      ask("x1", "Take the trash cans out of the front photo", "Text from Ashley, Oct 27"),
      ask("o1", "Take the trash cans out of the front photo", "Text from Ashley, Oct 27", { doneLabel: "Settled with the client", waitingOn: "Waiting on Jordan or Kyle" }),
    ]);
    const sLine = lines.find((l) => l.addOn === "virtual_staging");
    c.ok("the staging on the order, the order note and Ashley's text: ONE line, 'Virtual Staging needed'", lines.filter((l) => /stag/i.test(l.text)).length === 1 && sLine?.text === "Virtual Staging needed", JSON.stringify(lines.map((l) => l.text)));
    c.ok("…listing every place it was asked, each once (the order note is the 'Order notes' quote, not a second place)", !!sLine && sLine.sources.join(" | ") === "On the order: Virtual Staging (2 staged photos) | Order notes | Text from Ashley, Oct 27", JSON.stringify(sLine?.sources));
    c.ok("…the text's words under it; its button confirms the staging and settles both requests", !!sLine && sLine.quotes.some((q) => /living room and the bedroom/.test(q.text)) && sLine.action?.kind === "addon" && sLine.action.label === stg.done && JSON.stringify((sLine.action as { askIds?: string[] }).askIds) === '["t1","n1"]' && sLine.holds);
    const tLine = lines.find((l) => l.askIds.includes("e1"));
    c.ok("a different request (the trash cans) is its own line; asked by email and by text it is still one line, two places", !!tLine && tLine.askIds.join() === "e1,x1" && tLine.sources.join(" | ") === "Email from Ashley, Oct 27 | Text from Ashley, Oct 27" && tLine.action?.kind === "ask" && JSON.stringify((tLine.action as { askIds?: string[] }).askIds) === '["e1","x1"]', JSON.stringify(tLine));
    const oLine = lines.find((l) => l.askIds.includes("o1"));
    c.ok("a question for the office with the same words is never folded into the fix: its own line, 'Settled with the client'", lines.length === 3 && !!oLine && oLine.askIds.join() === "o1" && oLine.action?.label === "Settled with the client" && oLine.waitingOn === "Waiting on Jordan or Kyle", JSON.stringify(lines.map((l) => l.askIds)));
    const base0 = addonLine();
    const withOffice = H.clientRequestLines([
      { ...base0, addOn: { ...base0.addOn!, quotes: [...base0.addOn!.quotes, { from: "Text from Ashley, Oct 28", text: "Could you also stage the dining room?" }] } },
      ask("o2", "Could you also stage the dining room? I know it was not on the order.", "Text from Ashley, Oct 28", { doneLabel: "Settled with the client", waitingOn: "Waiting on Jordan or Kyle" }),
    ]);
    c.ok("a request on its own line (the dining room question) is not quoted under the staging too, nor counted as a place the staging was asked", withOffice.length === 2 && !withOffice[0].quotes.some((q) => /dining room/.test(q.text)) && !withOffice[0].sources.includes("Text from Ashley, Oct 28") && withOffice[0].quotes.some((q) => /primary bedroom/.test(q.text)), JSON.stringify(withOffice.map((l) => [l.text, l.sources])));
    const doneButAsked = H.clientRequestLines([addonLine(true), ask("t1", "Can you virtually stage the living room?", "Text from Ashley, Oct 27", { request: { what: "Can you virtually stage the living room?", from: "Text from Ashley, Oct 27", sameAs: "addon:virtual_staging" } })]);
    c.ok("staging added but the text still open: one line to check it against the request, then Done", doneButAsked.length === 1 && doneButAsked[0].text === `${stg.done}. Check it against the client's request, then press Done.` && doneButAsked[0].action?.kind === "ask" && doneButAsked[0].addOn === null, JSON.stringify(doneButAsked));
    c.ok("staging added and nothing else open: no line at all", H.clientRequestLines([addonLine(true)]).length === 0);
    c.ok("a request that does not hold (advisory) does not make its line hold", H.clientRequestLines([ask("p1", "Brighten photo 4", "Portal, Oct 27", { hold: false, advisory: true })])[0]?.holds === false);

    const waitingChecks: Line[] = [
      { key: "files", label: "Every photo is a full-size JPEG", ok: false, detail: "no photos", waiting: true },
      { key: "qc", label: "The latest QC run covers every photo's current version", ok: false, detail: "QC has not run", waiting: true },
      { key: "gallery", label: "Gallery and order checks completed", ok: false, detail: "not run yet", waiting: true },
    ];
    const base = { jobId: "j1", projectId: "p1", stage: "EDITING", holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: "Harrison Wells", decisions: { critical: 0, major: 0, minor: 0 }, listingUrl: null, orderUrl: null, deliveryCheckNote: null, listingUpdates: { photoIds: [], names: [] }, rawBatches: 0, photosRead: 0 };
    const push = { mode: "off", connected: false, sameDayAuto: false, progress: null };
    const pv = H.holdingFor({ ...base, gate: { checks: [...waitingChecks, addonLine(), ask("t1", "Can you virtually stage the living room?", "Text from Ashley, Oct 27", { request: { what: "Can you virtually stage the living room?", from: "Text from Ashley, Oct 27", sameAs: "addon:virtual_staging" } }), ask("e1", "Take the trash cans out of the front photo", "Email from Ashley, Oct 27")], canDeliver: false, advisory: false, blockedForOverride: null }, push });
    c.ok("before the upload: the photo checks are not things to do (not in the list, not in 'also')", ![...pv.items, ...pv.also].some((i) => ["files", "qc", "gallery", "rooms"].includes(i.key)), JSON.stringify(pv.items.map((i) => i.key)));
    c.ok("…the upload line says plainly that they wait: '3 photo checks wait for the upload. They run once the photos are in.'", pv.items[0]?.kind === "edits" && pv.items[0].short === H.WAITING_FOR_UPLOAD && pv.items[0].detail === "3 photo checks wait for the upload. They run once the photos are in.", JSON.stringify(pv.items[0]));
    c.ok("the client's requests: ONE item, 'Client requests: 2 to settle', its two lines inside", pv.items.filter((i) => i.kind === "requests").length === 1 && pv.items[1]?.kind === "requests" && pv.items[1].text === "Client requests: 2 to settle." && pv.items[1].short === "2 client requests" && pv.items[1].requests?.length === 2 && !pv.items.some((i) => i.kind === "addon" || i.kind === "ask"), JSON.stringify(pv.items.map((i) => [i.kind, i.text])));
    c.ok("the board's line: 'Waiting for upload (+1 more)'", pv.line === "Waiting for upload (+1 more)", pv.line);
    c.ok("what they wait for, by the job: the next visit's photos, AutoHDR's edits, the photos; one check says 'waits'", H.photoChecksWaitFor({ ...base, waitingForVisit: "Tue, Oct 21" }) === "the next visit's photos" && H.photoChecksWaitFor({ ...base, rawBatches: 2 }) === "AutoHDR's edits" && H.photoChecksWaitFor({ ...base, stage: "ON_HOLD" }) === "the photos" && H.photoChecksWaitWords([{ waiting: true }], base) === "1 photo check waits for the upload. It runs once the photos are in." && H.photoChecksWaitWords([{}], base) === null);

    // ======================================================================
    c.head("5 · 40 N Perry St (Ashley Brunner): in the database and on the page");
    // ======================================================================
    const ashley = await prisma.client.create({ data: { name: "Ashley Brunner" } });
    const project = await prisma.project.create({
      data: {
        title: "40 N Perry St, Doylestown, PA", addressLine: "40 N Perry St", clientId: ashley.id, status: "EDITING", shootDate: shot,
        photographerId: harrison.id, removalNotes: NOTHING_TO_REMOVE_SENTINEL, cullingConfirmedAt: shot, debriefSubmittedAt: shot,
        orderItems: { create: [{ title: "Virtual Staging", amount: 50, quantity: 2 }, { title: "HDR Photos", amount: 200 }] },
        deliverables: { create: [{ type: "PHOTOS", productTitle: "HDR Photos" }, { type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", quantity: 2 }] },
        appointments: { create: [{ aryeoId: "ap-40", startAt: shot, status: "CONFIRMED", description: "Order Notes:\nPlease virtually stage the living room and the primary bedroom.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
      } as never,
    });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "EDITING" } });
    const textAsk = (await createAsk({ clientId: ashley.id, projectId: project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Hi Kyle! Can you virtually stage the living room and the primary bedroom? Thanks", source: "text", askedBy: "Ashley Brunner", askedAt: new Date(Date.now() - DAY), by: "drill" }))!;
    const trash = await prisma.clientAsk.create({ data: { clientId: ashley.id, projectId: project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Please take the neighbor's trash cans out of the front photo.", source: "email", askedBy: "Ashley Brunner", askedAt: new Date(Date.now() - 20 * 3_600_000), holdsDelivery: true, dedupeKey: "drill:40-trash" } });
    const office = await prisma.clientAsk.create({ data: { clientId: ashley.id, projectId: project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Could you also stage the dining room? I know it was not on the order.", source: "text", askedBy: "Ashley Brunner", askedAt: new Date(Date.now() - 18 * 3_600_000), holdsDelivery: true, dedupeKey: `${PHOTO_OFFICE_KEY_PREFIX}drill-40-dining` } });

    const gate = await delivery.deliveryGate(job.id);
    const waiting = gate.checks.filter((x) => x.waiting).map((x) => x.key);
    c.ok("no photos yet: the photo-only checks (full-size files, the photo check, the gallery) wait", ["files", "qc", "gallery"].every((k) => waiting.includes(k)) && waiting.every((k) => ["files", "qc", "gallery", "rooms"].includes(k)), JSON.stringify(gate.checks.map((x) => [x.key, x.ok, !!x.waiting])));
    c.ok("…still open, so the hub's own delivery never goes out on them (Kyle's approval is held too)", gate.checks.filter((x) => x.waiting).every((x) => !x.ok) && gate.passed === false && gate.canDeliver === false);
    const sCheck = gate.checks.find((x) => x.key === "addon:virtual_staging");
    const tCheck = gate.checks.find((x) => x.askId === textAsk.id);
    const noteCheck = gate.checks.find((x) => x.request?.from === "Order note");
    const oCheck = gate.checks.find((x) => x.askId === office.id);
    const trCheck = gate.checks.find((x) => x.askId === trash.id);
    c.ok("the staging on the order is a request line ('On the order: Virtual Staging ...')", !!sCheck && /^On the order: Virtual Staging/.test(sCheck.request?.from ?? ""), JSON.stringify(sCheck?.request));
    c.ok("Ashley's text and the order note only ask for it again: both point at the staging line", tCheck?.request?.sameAs === "addon:virtual_staging" && noteCheck?.request?.sameAs === "addon:virtual_staging", JSON.stringify([tCheck?.request, noteCheck?.request]));
    c.ok("the trash cans and the dining room question are their own (the office question is never the staging)", !!trCheck && !trCheck.request?.sameAs && !!oCheck && !oCheck.request?.sameAs && oCheck.doneLabel === "Settled with the client", JSON.stringify([trCheck?.request, oCheck?.request]));

    const detail = (await data.loadJobDetail(job.id, { viewer: kyleView as never }))!;
    const view = H.holdingFor({ ...detail.holdingBase, gate: detail.gate, gateError: detail.gateError, push: detail.aryeoPush });
    c.ok("'What's holding this': Waiting for upload, then ONE Client requests item; no photo checks listed", view.items.map((i) => i.kind).join() === "edits,requests" && view.items[0].short === H.WAITING_FOR_UPLOAD && ![...view.items, ...view.also].some((i) => ["files", "qc", "gallery", "rooms"].includes(i.key)), JSON.stringify(view.items.map((i) => [i.kind, i.key, i.text])));
    c.ok("…the upload line says the checks wait for it", view.items[0].detail === `${waiting.length} photo checks wait for the upload. They run once the photos are in.`, String(view.items[0].detail));
    const reqs = view.items[1]?.requests ?? [];
    const stLine = reqs.find((l) => l.addOn === "virtual_staging");
    c.ok("three requests, three lines: the staging (once), the trash cans, the dining room question", reqs.length === 3 && view.items[1].text === "Client requests: 3 to settle." && reqs.filter((l) => /stag/i.test(l.text) && l.addOn).length === 1, JSON.stringify(reqs.map((l) => l.text)));
    c.ok("…the staging line lists the order, the order notes and Ashley's text, each once, and settles both requests", !!stLine && /^On the order: Virtual Staging/.test(stLine.sources[0]) && stLine.sources.some((s) => /^Text from Ashley, /.test(s)) && stLine.sources.some((s) => /^Order note/.test(s)) && new Set(stLine.sources).size === stLine.sources.length && stLine.askIds.length === 2 && stLine.askIds.includes(textAsk.id), JSON.stringify(stLine?.sources));

    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const kh = html(createElement(JobWorkspace, { data: detail, viewer: kyleView as never, history: null }));
    const panel = kh.split('aria-labelledby="pd-holding-h"')[1]?.split("</section>")[0] ?? "";
    c.ok("the page: one Client requests item, no separate Special requests card", (kh.match(/data-client-requests/g) ?? []).length === 1 && !/pd-special-h/.test(kh) && (kh.match(/id="pd-special-requests"/g) ?? []).length === 1, String((kh.match(/data-client-requests/g) ?? []).length));
    c.ok("…'Virtual Staging needed' once in the panel, 'Asked in 3 places', its own button; the other two lines with theirs", (text(panel).match(/Virtual Staging needed/g) ?? []).length === 1 && /Asked in 3 places/.test(text(panel)) && /Virtual staging added/.test(text(panel)) && /trash cans/.test(text(panel)) && /Settled with the client/.test(text(panel)) && (panel.match(/data-request-line=/g) ?? []).length === 3, text(panel).slice(0, 600));
    c.ok("…no 'Every photo is a full-size JPEG' or 'QC has not run' to do in the panel", !/full-size JPEG|QC has not run|Gallery and order checks/.test(text(panel)));
    const bar = text((kh.split('aria-label="Deliver"')[1] ?? "").split('id="pd-deliver-body"')[0]);
    const g = detail.gate!;
    const expectTotal = g.checks.filter((x) => !x.advisory && !x.waiting && !x.request).length + 1;
    const m = /Delivery checklist: (\d+) of (\d+) pass/.exec(bar);
    c.ok("the bottom bar counts without the waiting checks (the client's requests count once)", !!m && Number(m[2]) === expectTotal && Number(m[2]) <= g.checks.length - waiting.length, `${m?.[0]} expected total ${expectTotal}`);
    c.ok("…and says plainly that they wait for the upload", new RegExp(`${waiting.length} photo checks wait for the upload\\. They run once the photos are in\\.`).test(bar), bar.slice(0, 400));
    const body = kh.split('id="pd-deliver-body"')[1] ?? "";
    c.ok("the Deliver panel's checklist shows them waiting (a clock, '(waits for the upload)'), not failing", waiting.every((k) => new RegExp(`data-check-waiting="${k}"`).test(body)) && /\(waits for the upload\)/.test(text(body)));
    c.ok("…and the client's requests as one line there, settled at the top", /Client requests: 3 to settle/.test(text(body)) && /Settle them at the top/.test(text(body)) && (body.match(/data-deliver-client-requests/g) ?? []).length === 1);

    // The board card, before the upload: the add-on reads "ordered" in grey.
    const queue = await data.loadQueue({ holding: true, viewer: { readOnly: false } } as never);
    const card = queue.columns.flatMap((col) => col.cards).find((x) => x.id === job.id);
    const { QueueBoard } = await import("@/components/photoDelivery/QueueBoard");
    const bh = html(createElement(QueueBoard, { data: queue }));
    const cardHtml = bh.split(job.id).slice(1).join(job.id).split("<article")[0] ?? bh;
    c.ok("the board card: waiting for upload; staging reads 'Virtual Staging ordered' (grey), never an amber 'needed'", !!card?.waitingForUpload && /data-addon-chip="ordered"[^>]*>Virtual Staging ordered</.test(bh) && !/data-addon-chip=""[^>]*>Virtual Staging needed</.test(cardHtml), `${JSON.stringify(card?.addOns)} ${card?.holding?.line}`);

    // One button settles the staging and the requests that only asked for it.
    const { settleClientRequestAction } = await import("@/app/ops/photo-delivery/actions");
    const bad = await settleClientRequestAction(job.id, { askIds: ["../x"], how: "done" });
    c.ok("a bad request is refused", !bad.ok && /not valid/.test(bad.message));
    const done = await settleClientRequestAction(job.id, { askIds: stLine?.askIds ?? [], how: "done", note: "Staged the living room and the primary bedroom on photos 3 and 7.", addOn: "virtual_staging" });
    const after = await delivery.deliveryGate(job.id, { sync: false });
    const stateOf = async (id: string) => (await prisma.clientAsk.findUniqueOrThrow({ where: { id } })).state;
    c.ok("Virtual staging added: the staging line clears, and Ashley's text and the order note are settled with it", done.ok && after.checks.find((x) => x.key === "addon:virtual_staging")?.ok === true && (await stateOf(textAsk.id)) !== "OPEN" && (await Promise.all((stLine?.askIds ?? []).map(stateOf))).every((s) => s !== "OPEN"), `${JSON.stringify(done)} ${await stateOf(textAsk.id)}`);
    c.ok("…the message says the request is marked done too", done.ok && /request for it is marked done too/.test(done.message), done.message);
    c.ok("…the trash cans and the dining room question stay open, two lines", (await stateOf(trash.id)) === "OPEN" && (await stateOf(office.id)) === "OPEN" && H.clientRequestLines(after.checks).length === 2, JSON.stringify(H.clientRequestLines(after.checks).map((l) => l.text)));
    const ans = await settleClientRequestAction(job.id, { askIds: [office.id], how: "answered", note: "Told Ashley the dining room is a third staged photo, $25 more." });
    c.ok("the dining room question, answered with a note: settled; the trash cans still to do", ans.ok && (await stateOf(office.id)) !== "OPEN" && (await stateOf(trash.id)) === "OPEN", JSON.stringify(ans));

    // ======================================================================
    c.head("6 · plain words, no em dashes");
    // ======================================================================
    const words = [view.items.map((i) => `${i.text} ${i.short} ${i.detail ?? ""}`).join(" "), reqs.map((l) => `${l.text} ${l.sources.join(" ")}`).join(" "), text(panel), bar, text(body), done.ok ? done.message : "", r1.ok ? r1.message : ""].join(" ");
    c.ok("the panel, the bar, the Deliver panel and the messages", !DASH.test(words));
    c.ok("the new and changed files", ["src/lib/photoDelivery/fixedInAutohdr.ts", "src/components/photoDelivery/AddOnSteps.tsx", "src/lib/photoDelivery/holding.ts", "src/components/photoDelivery/HoldingPanel.tsx", "src/components/photoDelivery/DeliverPanel.tsx", "src/components/photoDelivery/format.ts", "src/components/photoDelivery/FindingActions.tsx", "src/components/photoDelivery/QueueBoard.tsx"].every((p) => !DASH.test(src(p))));
    void kyle;

    c.head("isolation");
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
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

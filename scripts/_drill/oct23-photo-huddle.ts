// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Jordan and Kyle's huddle on the Photo Delivery page (Oct 23 2026),
// items 1 to 12.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-photo-huddle.ts
//
//   1 · the queue page drops "Media checks to finish" (credits, queue, settings stay)
//   2 · the AutoHDR plan size is known (2,000 a month), credits only for Kyle;
//       the live script is a dry run by default
//   3 · the free check's never and always lists: the question, the code screen,
//       ALWAYS_FLAG (the floating lamp shade can't be switched off)
//   4 · one finding per real issue per photo; a decided issue is not raised again
//   5 · learning from "not worth fixing": repeated reasons become house lessons
//       (the question, the screen, the house overrides), listing-specific
//       reasons never; always-flagged checks never learned away; Undo
//   6 · Fix queues in place and the group folds away (no jump to the cart)
//   7 · special requests at the top; the send confirmation lists staging and
//       lot lines; not done: select, download, upload as NEW photos next to
//       the originals (the hold clears, the originals stay)
//   8 · the hub's own order: a wide front hero (never the door close-up), the
//       other fronts, the inside in walkthrough order, the back last; a
//       manual order is never overridden
//   9 · missing photographer notes never hold Kyle; "Ask the photographer for
//       notes" texts through the staff path (not twice in two hours)
//  11 · Kyle's photo bells: nothing he can't act on, one per job per state
//  12 · "Waiting for upload" before the raws arrive, then Editing
//
// ISOLATION: PGlite; AutoHDR (the free check's describe), OpenPhone and Slack
// are fakes; anything else is refused and counted. Nothing paid runs.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

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
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }], balance: 500, clientId: "cid", clientSecret: "drill-secret-1234567890" });
const fence = fenceFetch(async (url, init) => (await fake.handle(url, init)) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
const DASH = /[–—]/;

// The free check's answers, by AutoHDR photo name.
type Answer = { room: string; view?: string; prep?: string; issues?: { id: string; where: string; confidence: number }[] };
const answers = new Map<string, Answer>();
const prompts: string[] = [];
fake.state.describe = (name, prompt) => {
  if (/\nIds:\n/.test(prompt)) {
    prompts.push(prompt);
    const a = answers.get(name);
    return a ? JSON.stringify({ light: "day", furnished: "furnished", prep: "tidy", features: [], issues: [], ...a }) : '{"room":"other","issues":[]}';
  }
  return "A room.";
};

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7361) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const house = await import("@/lib/photoDelivery/houseRules");
    const decisions = await import("@/lib/photoDelivery/decisions");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const H = await import("@/lib/photoDelivery/holding");
    const steps = await import("@/lib/photoDelivery/addOnSteps");
    const credits = await import("@/lib/photoDelivery/credits");
    const ops = await import("@/lib/photoDelivery/notifyOps");
    const data = await import("@/app/ops/photo-delivery/data");
    const fmt = await import("@/components/photoDelivery/format");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, qcShadow: false, aryeoPush: "on", autoFix: false, fixRunnerEnabled: true }, "drill");
    const kyleView = { role: "ADMIN", name: "Kyle Smith", isOwner: false, canSeeMoney: false };
    const DAY = 86_400_000;

    // People: Jordan (owner), Kyle (the delivery owner), Harrison (photographer).
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@huddle.invalid" } });
    await prisma.appUser.create({ data: { email: "jordan@huddle.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@huddle.invalid" } });
    const kyleUser = await prisma.appUser.create({ data: { email: "kyle@huddle.invalid", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: kyleUser.id, teamMemberId: kyleTm.id, label: "Kyle Smith", setBy: "drill" } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@huddle.invalid", phone: "(610) 555-0123", role: "PHOTOGRAPHER" } as never });

    let seq = 0;
    const mkJob = async (street: string, rooms: string[], opts: { stage?: string; project?: Record<string, unknown> } = {}) => {
      const client = await prisma.client.create({ data: { name: `Client ${street}` } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id, shootDate: new Date(Date.now() - 2 * DAY), ...(opts.project ?? {}) } as never });
      const key = street.split(" ")[0];
      const shoot = fake.seedShoot({ address: street, photos: rooms.map((_, i) => ({ name: `${key}-${i + 1}.jpg` })) });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: opts.stage ?? "EDITED", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date(), expectedJson: JSON.stringify({ requestedFeatures: [], source: {} }) } });
      const photos = [];
      for (let i = 0; i < rooms.length; i++) {
        const ph = shoot.photos[i];
        photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: ph.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph.image_uuid}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: `h${seq++}`, sequence: i, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } }));
      }
      return { job, photos, project, client };
    };
    const runCheck = async (jobId: string) => {
      for (let i = 0; i < 5; i++) {
        const r = await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
        if (r.jobs.some((j) => j.jobId === jobId && j.finished)) return true;
      }
      return false;
    };
    const openOf = (jobId: string) => prisma.photoQcFinding.findMany({ where: { jobId, status: "OPEN" }, orderBy: { createdAt: "asc" } });

    // ======================================================================
    c.head("1 · the queue page: no 'Media checks to finish'; credits, queue and settings stay");
    // ======================================================================
    const pageSrc = src("src/app/ops/photo-delivery/page.tsx");
    c.ok("the page no longer reads or draws the media checks block", !/photoQcCards|MediaChecks|Media checks to finish"\s*count/.test(pageSrc) && /GlobalStrip strip=\{strip\} current="queue"/.test(pageSrc) && /<QueueBoard|QueueTable/.test(pageSrc));
    const { default: QueuePage } = await import("@/app/ops/photo-delivery/page");
    let qh = "";
    try {
      qh = html(await QueuePage({ searchParams: Promise.resolve({}) }));
    } catch (e) {
      qh = `ERROR ${String((e as Error)?.stack ?? e).slice(0, 300)}`;
    }
    c.ok("it renders: the credits chip and the queue, and no Media checks block", !qh.startsWith("ERROR") && /AutoHDR/.test(text(qh)) && /Queue/.test(text(qh)) && !/Media checks to finish/.test(qh), qh.slice(0, 200));

    // ======================================================================
    c.head("2 · the AutoHDR plan: 2,000 credits a month, shown as credits");
    // ======================================================================
    c.ok("not recorded until it is set (the hub never knew the plan)", (await credits.creditThresholds()).planCreditsPerMonth === null);
    await credits.saveCreditThresholds({ planCreditsPerMonth: 2000 }, "drill");
    const t = await credits.creditThresholds();
    c.ok("saved with the alert levels (owner settings), the other levels untouched", t.planCreditsPerMonth === 2000 && t.warn === 250 && t.critical === 100);
    const kyleCredits = await data.loadCreditsPage(kyleView as never);
    c.ok("Kyle's Credits page reads the plan in credits, never a dollar rate", kyleCredits.credit.planCreditsPerMonth === 2000 && kyleCredits.credit.usdPerCredit === null);
    const creditsPage = src("src/app/ops/photo-delivery/credits/page.tsx");
    c.ok("the Credits page shows it ('2,000 credits a month'); the owner's form can change it", /credits a month/.test(creditsPage) && /planCreditsPerMonth: page\.credit\.planCreditsPerMonth/.test(creditsPage));
    const script = src("scripts/_live/oct23-autohdr-plan-2000.ts");
    c.ok("the live script is a dry run unless --apply, proves read-only first, raises the three fix limits by the plan's ratio, leaves Kyle's approval limit and the AutoHDR account alone",
      /const APPLY = process\.argv\.includes\("--apply"\)/.test(script) && /default_transaction_read_only=on/.test(script) && /read-only guard is NOT proven/.test(script) &&
      /fixTargetUsd: money\(s\.fixTargetUsd \* ratio\)/.test(script) && /fixMaxUsd: money\(s\.fixMaxUsd \* ratio\)/.test(script) && /autoFixDailyMaxCredits: Math\.round\(s\.autoFixDailyMaxCredits \* ratio\)/.test(script) &&
      !/adminCreditCap:\s/.test(script.split("const after")[1]?.split("};")[0] ?? "x") && !/updateSettings|autohdr\.\w+\(/.test(script));

    // ======================================================================
    c.head("3 · what the free check never and always raises");
    // ======================================================================
    const q = check.checkPrompt(new Set());
    c.ok("the question is v5 or later (Oct 27 2026: v6 names the house being shot) and says the never-list: a neighbor's property, cords that belong to the house, unfinished spaces (Oct 29 2026: cords only when they really stick out)",
      check.CHECK_PROMPT_VERSION >= 5 && /Never anything on a neighbor's property: a neighbor's car, a car in another home's driveway/.test(q) && /Cords: report only cords that really stick out/.test(q) && /Never a single cord from a TV, lamp or appliance to an outlet, a cord under or behind furniture, a cord barely visible, or wiring that is part of the house/.test(q) && /Unfinished spaces \(a garage, an unfinished basement or room/.test(q) && /Trash cans still count/.test(q));
    c.ok("…and the always-list (Oct 29 2026: cars only in this home's own driveway or carport): bins, a car in this home's own driveway, what the photographer could have moved, random clutter in a finished room, the floating lamp shade",
      /Always report, wherever they are on this property: trash or recycling bins; a car in this home's own driveway or carport; anything the photographer could have moved before the shot \(a crooked door mat, a broom or mop leaning against a door\); random clutter in an otherwise clean, finished room/.test(q) &&
      /a lamp shade with no lamp stand or base/.test(q) && /EXT_PARKED_CARS_DRIVEWAY: a car parked in the driveway or carport of the home being photographed \(never a car in any other driveway/.test(q));
    c.ok("it asks for the shot's view (wide, partial, close_up) and names unfinished rooms", /"view":"wide\|partial\|close_up"/.test(q) && /"unfinished basement"/.test(q));
    c.ok("plain words, no long dashes", !DASH.test(q));
    const scr = check.screenIssues({
      room: "front exterior",
      issues: [
        { ruleId: "EXT_PARKED_CARS_DRIVEWAY", where: "neighbor's driveway on the left", confidence: 0.9 },
        { ruleId: "EXT_PARKED_CARS_DRIVEWAY", where: "this home's driveway", confidence: 0.9 },
        { ruleId: "EXT_TRASH_CANS_PRIMARY", where: "next door's curb", confidence: 0.8 },
        { ruleId: "PREP_LOOSE_CORDS_CABLES", where: "TV plugged into the wall", confidence: 0.9 },
        { ruleId: "AIEDIT_FLOATING_OBJECT", where: "lamp shade floating, no stand", confidence: 0.85 },
      ],
    }, { alwaysFlag: policy.ALWAYS_FLAG });
    c.ok("the screen drops the neighbor's car, the neighbor's bins and the TV's cord; keeps this home's car and the floating lamp shade",
      scr.kept.map((i) => `${i.ruleId}:${i.where}`).join("|") === "EXT_PARKED_CARS_DRIVEWAY:this home's driveway|AIEDIT_FLOATING_OBJECT:lamp shade floating, no stand" && scr.dropped.filter((d) => d.why === "on a neighbor's property").length === 2 && scr.dropped.some((d) => d.why === "a cord that belongs to the house"), JSON.stringify(scr));
    const garage = check.screenIssues({ room: "garage", issues: [{ ruleId: "PREP_CLEANING_SUPPLIES", where: "shelves", confidence: 0.9 }, { ruleId: "PREP_CONSTRUCTION_PAINTING_MATERIALS", where: "floor", confidence: 0.9 }, { ruleId: "UTIL_GARAGE_TRASH_CANS", where: "by the door", confidence: 0.9 }] }, { alwaysFlag: policy.ALWAYS_FLAG });
    c.ok("in a garage: cleaning supplies and paint cans are dropped, the trash can is kept (always wanted)", garage.kept.map((i) => i.ruleId).join() === "UTIL_GARAGE_TRASH_CANS" && garage.dropped.every((d) => d.why === "in an unfinished space"), JSON.stringify(garage));
    const finished = check.screenIssues({ room: "living room", issues: [{ ruleId: "PREP_CLEANING_SUPPLIES", where: "broom against the front door", confidence: 0.9 }] }, { alwaysFlag: policy.ALWAYS_FLAG });
    c.ok("in a finished room the broom against the door is kept", finished.kept.length === 1);
    c.ok("ALWAYS_FLAG: lines, a cut-off roof, trash cans, cars, camera mistakes, the floating object, the crooked door mat",
      ["PERSP_CROOKED_VERTICALS", "PERSP_EDIT_WARP", "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", "EXT_TRASH_CANS_PRIMARY", "BATH_TRASH_CANS", "EXT_PARKED_CARS_DRIVEWAY", "REFL_PHOTOGRAPHER_IN_MIRROR", "AIEDIT_FLOATING_OBJECT", "PREP_DOOR_MAT_CROOKED"].every((id) => policy.ALWAYS_FLAG.has(id)) && !policy.ALWAYS_FLAG.has("PREP_LOOSE_CORDS_CABLES"));
    const ownerStop = await house.stopRule("AIEDIT_FLOATING_OBJECT", "too many", "Jordan Spackman", { role: "OWNER" });
    const doormat = await house.stopRule("PREP_DOOR_MAT_CROOKED", "too many", "Jordan Spackman", { role: "OWNER" });
    c.ok("the floating lamp shade can't be switched off any more, the owner included; nor the door mat", !ownerStop.ok && /always wants it flagged/.test(ownerStop.message) && !doormat.ok && !(await house.houseRules()).length, ownerStop.message);

    // End to end: one free check of a home with the never-list and the always-list in it.
    const A = await mkJob("12 Huddle Ln", ["front", "garage", "living", "bedroom"]);
    answers.set("12-1.jpg", { room: "front exterior", view: "wide", issues: [
      { id: "EXT_PARKED_CARS_DRIVEWAY", where: "neighbor's car across the street", confidence: 0.9 },
      { id: "EXT_PARKED_CARS_DRIVEWAY", where: "silver SUV in this home's driveway", confidence: 0.9 },
      { id: "EXT_TRASH_CANS_PRIMARY", where: "two bins at the curb", confidence: 0.9 },
      { id: "PREP_TRASH_CANS", where: "recycling bin by the garage", confidence: 0.7 },
      { id: "KIT_GARBAGE_CANS", where: "bin at the curb", confidence: 0.6 },
    ] });
    answers.set("12-2.jpg", { room: "garage", issues: [{ id: "PREP_CLEANING_SUPPLIES", where: "shelf of sprays", confidence: 0.9 }, { id: "UTIL_GARAGE_TRASH_CANS", where: "by the door", confidence: 0.9 }] });
    answers.set("12-3.jpg", { room: "living room", issues: [
      { id: "PREP_CLEANING_SUPPLIES", where: "broom by the door", confidence: 0.8 },
      { id: "PREP_CLEANING_SUPPLIES", where: "spray bottle on the table", confidence: 0.7 },
      { id: "BATH_CLEANING_SUPPLIES", where: "bucket under the window", confidence: 0.6 },
      { id: "PREP_VACUUM_CLEANING_EQUIPMENT", where: "vacuum in the corner", confidence: 0.6 },
      { id: "PREP_LOOSE_CORDS_CABLES", where: "TV cord to the outlet", confidence: 0.9 },
    ] });
    answers.set("12-4.jpg", { room: "bedroom", issues: [{ id: "AIEDIT_FLOATING_OBJECT", where: "lamp shade floating beside the crib, no stand", confidence: 0.85 }] });
    c.ok("the free check runs", await runCheck(A.job.id));
    const fa = await openOf(A.job.id);
    const by = (photoId: string) => fa.filter((f) => f.photoId === photoId).map((f) => f.ruleId).sort();
    c.ok("front: this home's car and ONE trash finding (three bin rules were one bin); the neighbor's car never filed", by(A.photos[0].id).join() === "EXT_PARKED_CARS_DRIVEWAY,EXT_TRASH_CANS_PRIMARY" && fa.filter((f) => f.photoId === A.photos[0].id && f.ruleId === "EXT_TRASH_CANS_PRIMARY")[0]?.locationText?.includes("two bins at the curb") === true && !fa.some((f) => /neighbor/.test(f.locationText ?? "")), JSON.stringify(fa.map((f) => [f.ruleId, f.locationText])));
    c.ok("garage: the trash can only (clutter in an unfinished space is never raised)", by(A.photos[1].id).join() === "UTIL_GARAGE_TRASH_CANS");
    c.ok("living room: ONE cleaning-supplies finding for the broom, the spray, the bucket and the vacuum; the TV's cord never filed", by(A.photos[2].id).join() === "PREP_CLEANING_SUPPLIES" && /broom by the door; spray bottle on the table; bucket under the window; vacuum in the corner/.test(fa.find((f) => f.photoId === A.photos[2].id)?.locationText ?? ""), JSON.stringify(fa.filter((f) => f.photoId === A.photos[2].id).map((f) => f.locationText)));
    c.ok("bedroom: the floating lamp shade is raised (MAJOR)", by(A.photos[3].id).join() === "AIEDIT_FLOATING_OBJECT" && fa.find((f) => f.photoId === A.photos[3].id)?.severity === "MAJOR");
    const runA = await prisma.photoQcRun.findFirst({ where: { jobId: A.job.id, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" } });
    const prA = check.readProgress(runA?.checksJson);
    c.ok("what the screen dropped is kept on the run (the neighbor's car, the garage's sprays, the TV cord)", JSON.stringify(prA.screened ?? {}).includes("on a neighbor's property") && JSON.stringify(prA.screened ?? {}).includes("in an unfinished space") && JSON.stringify(prA.screened ?? {}).includes("a cord that belongs to the house"));

    // ======================================================================
    c.head("4 · one finding per real issue per photo, and a decided issue is not raised again");
    // ======================================================================
    const dd = check.dedupeIssues([{ ruleId: "PREP_TRASH_CANS", where: "by the garage", confidence: 0.6 }, { ruleId: "EXT_TRASH_CANS_PRIMARY", where: "curb", confidence: 0.9 }, { ruleId: "EXT_TRASH_CANS_PRIMARY", where: "Curb", confidence: 0.5 }, { ruleId: "EXT_GARDEN_HOSES", where: "lawn", confidence: 0.7 }]);
    c.ok("pure: one bin (the most serious rule, both places, the highest confidence), the hose apart", dd.length === 2 && dd[0].ruleId === "EXT_TRASH_CANS_PRIMARY" && dd[0].where === "by the garage; curb" && dd[0].confidence === 0.9 && dd[1].ruleId === "EXT_GARDEN_HOSES", JSON.stringify(dd));
    const parsed = check.parseCheckAnswer('{"room":"kitchen","issues":[{"id":"KIT_DIRTY_DISHES_SINK","where":"sink","confidence":0.8},{"id":"KIT_DISHES_ON_COUNTERS","where":"island","confidence":0.7}]}');
    c.ok("the screen merges them after dropping what is never raised (dishes in the sink and on the island are one)", parsed?.issues.length === 2 && check.screenIssues(parsed!).kept.length === 1);
    const supplies = fa.find((f) => f.photoId === A.photos[2].id)!;
    const ign = await decisions.decideFindings({ findingIds: [supplies.id], status: "IGNORED", reason: "Intentional staging", by: "Kyle Smith" });
    c.ok("Kyle sets the cleaning supplies aside", ign.ok, ign.message);
    const again = await check.requestFreeRecheck(A.job.id, "Kyle Smith");
    c.ok("…then asks for the check again", again.ok, again.message);
    c.ok("the check runs again", await runCheck(A.job.id));
    const fa2 = await openOf(A.job.id);
    c.ok("the cleaning supplies are not raised again on that photo; the rest come back once each", !fa2.some((f) => f.photoId === A.photos[2].id) && fa2.filter((f) => f.photoId === A.photos[0].id && f.ruleId === "EXT_TRASH_CANS_PRIMARY").length === 1, JSON.stringify(fa2.map((f) => [f.photoId === A.photos[2].id ? "living" : "x", f.ruleId])));
    const run2 = await prisma.photoQcRun.findFirst({ where: { jobId: A.job.id, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" } });
    c.ok("…and the run says why ('already decided on this photo')", JSON.stringify(check.readProgress(run2?.checksJson).screened?.[A.photos[2].id] ?? []).includes("already decided on this photo"));

    // ======================================================================
    c.head("5 · learning from 'not worth fixing'");
    // ======================================================================
    c.ok("what a reason teaches (pure)",
      house.lessonOf("Neighbors car")?.scope === "neighbor" && house.lessonOf("it's in the garage")?.scope === "unfinished" && house.lessonOf("Part of the house")?.scope === "attached" &&
      house.lessonOf("Barely viislbe in drone")?.scope === "faint" && house.lessonOf("Intentional staging")?.scope === "staged" && house.lessonOf("We never fix paper towels")?.scope === "rule" &&
      house.lessonOf("Not worth a fix on this listing") === null && house.lessonOf("Client preference") === null && house.lessonOf("the agent wants it shown") === null && house.lessonOf("Skipped all findings on this shoot") === null);
    const seedDecided = async (street: string, ruleId: string, n: number, reason: string) => {
      const J = await mkJob(street, Array.from({ length: n }, () => "room"), { stage: "QC_REVIEW" });
      const run = await prisma.photoQcRun.create({ data: { jobId: J.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(), finishedAt: new Date() } });
      const ids: string[] = [];
      for (const p of J.photos) ids.push((await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: J.job.id, photoId: p.id, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: ruleId, explanation: "x", severity: "MINOR", confidence: 0.8, responsibility: "PHOTOGRAPHER", fixStrategy: "AUTOREMOVE_MASK", contentHash: p.contentHash, status: "OPEN", model: "drill", rulesVersion: "v", promptId: "autohdr-check", promptVersion: 5 } as never })).id);
      const r = await decisions.decideFindings({ findingIds: ids, status: "IGNORED", reason, by: "Kyle Smith" });
      return { J, r };
    };
    // Paper towels: "We never fix paper towels" twice on one job: not yet (one job).
    const p1 = await seedDecided("20 Towel St", "KIT_PAPER_TOWEL_ROLLS", 2, "We never fix paper towels");
    c.ok("decided with the reason kept on each finding (check, photo, words)", p1.r.ok && (await prisma.photoQcFinding.count({ where: { jobId: p1.J.job.id, status: "IGNORED", statusReason: "We never fix paper towels" } })) === 2);
    let lessons = await house.learnedChecks();
    c.ok("two calls on one job teach nothing yet (needs 3 calls on 2 jobs)", !lessons.some((l) => l.ruleId === "KIT_PAPER_TOWEL_ROLLS" && l.active));
    await seedDecided("21 Towel St", "KIT_PAPER_TOWEL_ROLLS", 1, "we never fix paper towels!");
    lessons = await house.learnedChecks();
    const towels = lessons.find((l) => l.ruleId === "KIT_PAPER_TOWEL_ROLLS");
    c.ok("the same words a third time on another job: a house lesson ('No longer flagged on any shoot')", !!towels?.active && towels.scope === "rule" && towels.count === 3 && towels.jobs === 2 && house.lessonWords(towels) === "No longer flagged on any shoot" && towels.examples.every((e) => !!e.photoId), JSON.stringify(towels));
    const offNow = house.disabledIn(await house.houseOverrides());
    c.ok("…the free check stops asking about it (the house overrides), the engines' verdicts too", offNow.has("KIT_PAPER_TOWEL_ROLLS") && !check.checkPrompt(offNow).includes("KIT_PAPER_TOWEL_ROLLS") && !(await house.houseRules()).some((r) => r.ruleId === "KIT_PAPER_TOWEL_ROLLS"));
    // "Intentional staging" on vacuums: a conditional lesson, said in the question.
    await seedDecided("30 Vac Rd", "PREP_VACUUM_CLEANING_EQUIPMENT", 2, "Intentional staging");
    await seedDecided("31 Vac Rd", "PREP_VACUUM_CLEANING_EQUIPMENT", 1, "intentional staging, it's decor");
    lessons = await house.learnedChecks();
    const vac = lessons.find((l) => l.ruleId === "PREP_VACUUM_CLEANING_EQUIPMENT" && l.scope === "staged");
    c.ok("'Intentional staging' 3 times on 2 jobs: 'Not flagged when it is intentional staging or decor', in the question, the check kept", !!vac?.active && check.checkPrompt(house.disabledIn(await house.houseOverrides()), house.lessonPromptLines(lessons)).includes("PREP_VACUUM_CLEANING_EQUIPMENT: never intentional staging or decor") && !house.disabledIn(await house.houseOverrides()).has("PREP_VACUUM_CLEANING_EQUIPMENT"), JSON.stringify(vac));
    // "Barely visible" on a trash can: Oct 29 2026 (Jordan: "tighten them up so we don't flag things we dont need to fix"), an always-flagged check is narrowed to what is clearly visible, never switched off.
    await seedDecided("40 Bin Ct", "EXT_TRASH_CANS_PRIMARY", 2, "Barely visible from the street");
    await seedDecided("41 Bin Ct", "EXT_TRASH_CANS_PRIMARY", 2, "Barely visible from the street");
    lessons = await house.learnedChecks();
    const bins = lessons.find((l) => l.ruleId === "EXT_TRASH_CANS_PRIMARY");
    const binScreen = check.screenIssues({ room: "front exterior", issues: [{ ruleId: "EXT_TRASH_CANS_PRIMARY", where: "far curb", confidence: 0.5 }, { ruleId: "EXT_TRASH_CANS_PRIMARY", where: "driveway, by the garage", confidence: 0.9 }] }, { lessons, alwaysFlag: policy.ALWAYS_FLAG });
    c.ok("a trash can 'barely visible' 4 times: applied as 'Flagged only when it is clearly visible'; a faint one is dropped, a clear one still flagged", !!bins && bins.active && bins.alwaysFlagged && house.lessonWords(bins) === "Flagged only when it is clearly visible" && binScreen.kept.length === 1 && binScreen.kept[0].where === "driveway, by the garage" && binScreen.dropped[0]?.why === "learned: barely visible", JSON.stringify({ bins, binScreen }));
    c.ok("…in the question too, and the check is still on", house.lessonPromptLines(lessons).some((l) => l.startsWith("EXT_TRASH_CANS_PRIMARY: only when it is clearly visible")) && !house.disabledIn(await house.houseOverrides()).has("EXT_TRASH_CANS_PRIMARY"));
    // Lines and the AI edit's own mistakes are never narrowed; no other kind of lesson narrows an always-flagged check.
    const rowsA = (ruleId: string, reason: string) => ["j1", "j2", "j3"].map((jobId, i) => ({ id: `${ruleId}-${i}`, jobId, photoId: `p${i}`, ruleId, statusReason: reason, decidedBy: "Kyle Smith", decidedAt: new Date(Date.now() - i * 1000), status: "IGNORED" }));
    const pureA = house.lessonsFrom([...rowsA("PERSP_EXTERIOR_WALLS_LEANING", "Barely visible in the photo"), ...rowsA("AIEDIT_FLOATING_OBJECT", "barely visible"), ...rowsA("EXT_TRASH_CANS_PRIMARY", "It is part of the house"), ...rowsA("EXT_PARKED_CARS_DRIVEWAY", "Drone shot"), ...rowsA("EXT_VEHICLES_THROUGH_WINDOWS", "Car is far from property")], [], policy.ALWAYS_FLAG);
    const act = (ruleId: string) => pureA.find((l) => l.ruleId === ruleId)?.active;
    c.ok("lines, edit mistakes and 'part of the house' on a bin are not applied; 'Drone shot' and 'far from property' read as barely visible and are", act("PERSP_EXTERIOR_WALLS_LEANING") === false && act("AIEDIT_FLOATING_OBJECT") === false && act("EXT_TRASH_CANS_PRIMARY") === false && act("EXT_PARKED_CARS_DRIVEWAY") === true && act("EXT_VEHICLES_THROUGH_WINDOWS") === true && pureA.find((l) => l.ruleId === "EXT_PARKED_CARS_DRIVEWAY")?.scope === "faint", JSON.stringify(pureA.map((l) => [l.ruleId, l.scope, l.active])));
    // The listing-specific preset never teaches.
    await seedDecided("50 Mat Way", "PREP_SHOES_FOOTWEAR", 3, "Not worth a fix on this listing");
    await seedDecided("51 Mat Way", "PREP_SHOES_FOOTWEAR", 3, "Not worth a fix on this listing");
    c.ok("'Not worth a fix on this listing' six times on two jobs teaches nothing (a call on one listing)", !(await house.learnedChecks()).some((l) => l.ruleId === "PREP_SHOES_FOOTWEAR"));
    // Pure: a "Not there" in other words never switches a check off; a neighbor's car is learned even on an always-flagged check.
    const rowsP = (ruleId: string, reason: string, status: string, jobs: string[]) => jobs.map((jobId, i) => ({ id: `${ruleId}-${i}-${jobId}`, jobId, photoId: `p${i}`, ruleId, statusReason: reason, decidedBy: "Kyle Smith", decidedAt: new Date(Date.now() - i * 1000), status }));
    const pureL = house.lessonsFrom([...rowsP("EXT_GARDEN_HOSES", "Not there in the photo", "FALSE_POSITIVE", ["j1", "j2", "j3"]), ...rowsP("EXT_PARKED_CARS_DRIVEWAY", "Neighbor's car", "IGNORED", ["j1", "j2", "j3"]), ...rowsP("PREP_LEFTOVER_ITEM_VACANT", "It is part of the house", "FALSE_POSITIVE", ["j1", "j2", "j3"])], [], policy.ALWAYS_FLAG);
    c.ok("'Not there in the photo' three times never switches the hose check off (strictness is the fix plan's job); 'It is part of the house' does teach; a neighbor's car is learned on the car check too",
      !pureL.some((l) => l.ruleId === "EXT_GARDEN_HOSES") && !!pureL.find((l) => l.ruleId === "PREP_LEFTOVER_ITEM_VACANT" && l.scope === "attached")?.active && !!pureL.find((l) => l.ruleId === "EXT_PARKED_CARS_DRIVEWAY" && l.scope === "neighbor")?.active && house.lessonWords(pureL.find((l) => l.scope === "neighbor")!) === "Not flagged on a neighbor's property", JSON.stringify(pureL.map((l) => [l.ruleId, l.scope, l.active])));
    // A "faint" lesson screens low-confidence findings.
    const faint = check.screenIssues({ room: "front exterior", issues: [{ ruleId: "EXT_GARDEN_HOSES", where: "far lawn", confidence: 0.6 }, { ruleId: "EXT_GARDEN_HOSES", where: "walkway", confidence: 0.9 }] }, { lessons: [{ ruleId: "EXT_GARDEN_HOSES", scope: "faint", active: true }], alwaysFlag: policy.ALWAYS_FLAG });
    c.ok("a 'barely visible' lesson on a hose drops one the check was under 75% sure of, keeps a clear one", faint.kept.length === 1 && faint.kept[0].where === "walkway" && faint.dropped[0]?.why === "learned: barely visible");
    // Oct 23 2026 (the live lesson on items left in an empty room): "wall", "under" and "outlet" are places, not proof.
    // Different photos' answers, one at a time (one finding per issue per photo would merge them on one photo).
    const attachedLesson = { lessons: [{ ruleId: "PREP_LEFTOVER_ITEM_VACANT", scope: "attached", active: true }], alwaysFlag: policy.ALWAYS_FLAG };
    const leftAt = (where: string) => check.screenIssues({ room: "bedroom", issues: [{ ruleId: "PREP_LEFTOVER_ITEM_VACANT", where, confidence: 0.9 }] }, attachedLesson);
    const keptPlaces = ["on the floor near the outlet on the right", "on the floor near the corner under the window", "blue tape on the back wall"].filter((w) => leftAt(w).kept.length === 1);
    c.ok("an 'It is part of the house' lesson keeps real leftovers whose place names a wall, an outlet or a window", keptPlaces.length === 3, keptPlaces.join(" | "));
    c.ok("…and drops one whose place says it belongs to the house", leftAt("built-in shelf on the left").dropped[0]?.why === "learned: part of the house" && leftAt("wall-mounted thermostat").kept.length === 0);
    c.ok("…a cord lesson still reads the cord words", check.screenIssues({ room: "living room", issues: [{ ruleId: "PREP_LOOSE_CORDS_CABLES", where: "under the console", confidence: 0.9 }] }, { lessons: [{ ruleId: "PREP_LOOSE_CORDS_CABLES", scope: "attached", active: true }], alwaysFlag: policy.ALWAYS_FLAG }).kept.length === 0);
    // Jordan's list, and Undo.
    const { LearnedChecks } = await import("@/components/photoDelivery/LearnedChecks");
    const lh = html(createElement(LearnedChecks, { lessons: lessons.filter((l) => l.count >= 3).map((l) => ({ key: l.key, label: l.ruleId, reason: l.reason, count: l.count, jobs: l.jobs, changes: house.lessonWords(l), active: l.active, alwaysFlagged: l.alwaysFlagged, undone: null, examples: [] })) }));
    c.ok("the settings list: each lesson, its words and counts, what changes, Undo on the active ones only", /We never fix paper towels|we never fix paper towels/i.test(text(lh)) && /3 times on 2 jobs/.test(text(lh)) && /No longer flagged on any shoot/.test(text(lh)) && (lh.match(/Undo/g) ?? []).length === lessons.filter((l) => l.count >= 3 && l.active).length && /Flagged only when it is clearly visible/.test(text(lh)));
    const settingsSrc = src("src/app/ops/photo-delivery/settings/page.tsx");
    c.ok("…on Photo Delivery settings (owner only), worked out fresh on each visit", /What the check has learned/.test(settingsSrc) && /refreshLessons\(/.test(settingsSrc) && /<LearnedChecks lessons=\{lessonViews\}/.test(settingsSrc) && /if \(!viewer\.isOwner\) redirect/.test(settingsSrc));
    const undo = await house.undoLesson(towels!.key, "Jordan Spackman");
    lessons = await house.learnedChecks();
    c.ok("Undo: the paper towels are flagged again; only calls from now on can teach it again", undo.ok && !lessons.find((l) => l.key === towels!.key)?.active && !house.disabledIn(await house.houseOverrides()).has("KIT_PAPER_TOWEL_ROLLS") && lessons.find((l) => l.key === towels!.key)?.undone?.by === "Jordan Spackman", undo.message);
    c.ok("the prompt for 'Not worth fixing' always asks (optional for a minor one), with presets for Jordan's never-list", /status === "IGNORED"\) \{/.test(src("src/components/photoDelivery/JobContext.tsx")) && ["Neighbor's property", "Barely visible", "Unfinished space (garage, basement)", "Part of the house"].every((p) => (fmt.IGNORE_PRESETS as readonly string[]).includes(p)));

    // ======================================================================
    c.head("6 · Fix queues in place and moves on (like Not worth fixing)");
    // ======================================================================
    const g = { findings: [{ id: "f1", status: "OPEN" }, { id: "f2", status: "OPEN" }, { id: "f3", status: "IGNORED" }] } as never;
    const fixable = (id: string) => id !== "fx";
    c.ok("a group folds into 'Queued to fix' once every open finding in it is queued; not before", fmt.isQueuedGroup(g, new Set(["f1", "f2"]), fixable) && !fmt.isQueuedGroup(g, new Set(["f1"]), fixable) && !fmt.isQueuedGroup({ findings: [{ id: "fx", status: "OPEN" }] } as never, new Set(["fx"]), fixable));
    const fa3 = src("src/components/photoDelivery/FindingActions.tsx");
    const jc = src("src/components/photoDelivery/JobContext.tsx");
    const stayBranch = jc.split("if (opts.stay) {")[1]?.split("return true;")[0] ?? "";
    c.ok("Fix calls addToCart with stay: no tab switch, no drawer, the lightbox stays; focus goes to the next issue", /addToCart\(fixable\.map\(\(f\) => f\.id\), \{ stay: true \}\)/.test(fa3) && /next\.focus\(/.test(fa3) && !!stayBranch && !/setTab|setCartOpen|setLightbox/.test(stayBranch) && /setQueued/.test(stayBranch));
    const issues = src("src/components/photoDelivery/IssuesPanel.tsx");
    c.ok("the Issues tab: queued groups leave the list under 'Queued to fix', with 'Back to the list' and 'Open the Fix Cart'", /Queued to fix \(\{queuedGroups\.length\}\)/.test(issues) && /Back to the list/.test(issues) && /data-issue-group=\{g\.key\}/.test(issues));

    // ======================================================================
    c.head("7 · special requests at the top; the send confirmation; finished versions next to the originals");
    // ======================================================================
    const lines = steps.addOnConfirmLines([
      { ok: false, addOn: { key: "virtual_staging", need: "Virtual Staging needed", done: "Virtual staging added", ordered: "Virtual Staging (2 staged photos)", cleared: null } },
      { ok: true, addOn: { key: "lot_lines", need: "Lot Lines needed", done: "Lot lines added", ordered: "Lot Lines", cleared: { how: "version", photoName: "DJI_0101.jpg", by: "Kyle", note: null } } },
      { ok: true },
    ]);
    c.ok("the confirmation's lines: 'Virtual Staging (2 staged photos): not done yet', 'Lot lines added, on DJI_0101.jpg'", lines.length === 2 && lines[0].words === "Virtual Staging (2 staged photos): not done yet" && !lines[0].done && lines[1].words === "Lot lines added, on DJI_0101.jpg" && lines[1].done, JSON.stringify(lines));
    c.ok("the plain next step names the three steps and that the originals stay", /Virtual Staging isn't done yet\. Next: select the photos for it, download them, and upload the finished versions\. They are added as new photos next to the originals; the originals stay\./.test(steps.addOnNextStep(["Virtual Staging"])));
    const pair = steps.pairFinished(["DJI_0102-staged.jpg", "living-final.jpg"], [{ id: "a", name: "DJI_0101.jpg" }, { id: "b", name: "DJI_0102.jpg" }]);
    c.ok("finished files pair with their originals by name, else by place", pair.join() === "b,b" && steps.pairFinished(["x.jpg", "y.jpg"], [{ id: "a", name: "DJI_0101.jpg" }, { id: "b", name: "DJI_0102.jpg" }]).join() === "a,b");
    const push = src("src/components/photoDelivery/AryeoPushControls.tsx");
    c.ok("Approve and deliver, Approve and upload and Deliver in Aryeo all confirm the add-ons first; one not done stops the send and opens its steps", (push.match(/await addOnsReady\(\)/g) ?? []).length === 2 && /Show me the steps/.test(push) && /OPEN_ADDON_STEPS/.test(push) && /title: "Approve and upload to Aryeo\?"/.test(push));
    // A job with 2 staged photos ordered and a lot-lines line: the card, the steps, the upload.
    const B = await import("@/lib/photoDelivery/blob");
    const HF = await import("@/lib/photoDelivery/hubFiles");
    const store = new Map<string, Buffer>();
    B.__setDerivativeStoreForTests({
      async put(pathname, bytes) { store.set(pathname, Buffer.from(bytes)); return { pathname, url: `https://drill-store.private.blob.vercel-storage.invalid/${pathname}` }; },
      async read(ref) { const b = store.get(ref.pathname); return b ? { stream: new Blob([new Uint8Array(b)]).stream(), size: b.length, contentType: "image/jpeg" } : null; },
    });
    const S7 = await mkJob("70 Stage Ct", ["front", "living", "kitchen"], { stage: "READY", project: { orderItems: { create: [{ title: "Virtual Staging", amount: 50, quantity: 2 }] }, deliverables: { create: [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", quantity: 2 }] } } });
    await prisma.photoAsset.update({ where: { id: S7.photos[1].id }, data: { roomType: "LIVING", sequenceGroup: "MAIN_LIVING" } });
    const run7 = await prisma.photoQcRun.create({ data: { jobId: S7.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: S7.job.id }, data: { lastQcRunId: run7.id } });
    for (const p of S7.photos) await prisma.photoAsset.update({ where: { id: p.id }, data: { inspectedHash: p.contentHash } });
    let d7 = (await data.loadJobDetail(S7.job.id, { viewer: kyleView as never }))!;
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    let h7 = html(createElement(JobWorkspace, { data: d7, viewer: kyleView as never, history: null }));
    // Oct 28 2026 (Kyle: "Virtual staging is also showing twice"): the Special requests card is gone; the special
    // requests are the ONE Client requests item at the top of the job, in What's holding this, before the gallery.
    c.ok("the job page opens with What's holding this and its Client requests item (no separate Special requests card), before the gallery", h7.indexOf("pd-special-h") < 0 && h7.indexOf("pd-holding-h") >= 0 && h7.indexOf('id="pd-special-requests"') > h7.indexOf("pd-holding-h") && h7.indexOf('id="pd-special-requests"') < h7.indexOf("pd-gallery-h"));
    const card7 = text(h7.split('id="pd-special-requests"')[1]?.split("</section>")[0] ?? "");
    c.ok("…'Virtual Staging needed', from the order (2 staged photos), with the three steps", /Client requests 1 request/.test(card7) && /Virtual Staging needed/.test(card7) && /From: On the order: Virtual Staging \(2 staged photos\)/.test(card7) && /1 · Select photos for it/.test(card7) && /2 · Download/.test(card7) && /3 · Upload the finished versions/.test(card7) && /added as new photos next to the originals; the originals stay/.test(card7), card7.slice(0, 300));
    c.ok("…it holds the delivery (the photo audit's hold), so Approve and deliver is refused", !(d7.gate?.canDeliver ?? true) && d7.gate!.checks.some((x) => x.key === "addon:virtual_staging" && !x.ok && x.hold));
    const jpg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 180, g: 170, b: 160 } } }).jpeg({ quality: 80 }).toBuffer();
    const upA = `${HF.uploadPathPrefix(S7.job.id, "new")}70-2-staged.jpg`;
    store.set(upA, jpg);
    const before7 = await delivery.deliveryOrderFor(S7.job.id);
    const added = await HF.addPhotosByHand({ jobId: S7.job.id, files: [{ pathname: upA, fileName: "70-2-staged.jpg" }], by: "Kyle Smith", addOn: "virtual_staging", nextTo: [S7.photos[1].id] });
    c.ok("the finished version goes in as a NEW photo; the original stays as it was", added.ok && added.added.length === 1 && (await prisma.photoAsset.count({ where: { jobId: S7.job.id, status: "ACTIVE" } })) === 4 && (await prisma.photoAsset.findUnique({ where: { id: S7.photos[1].id } }))?.contentHash === S7.photos[1].contentHash && /next to its original/.test(added.message), added.message);
    const after7 = await delivery.deliveryOrderFor(S7.job.id);
    const at = after7.findIndex((o) => o.photoId === S7.photos[1].id);
    c.ok("…right after its original in the delivery order (everything else in its place)", after7[at + 1]?.photoId === added.added[0] && after7.filter((o) => o.photoId !== added.added[0]).map((o) => o.photoId).join() === before7.map((o) => o.photoId).join(), JSON.stringify(after7.map((o) => o.name)));
    const v7 = await prisma.photoVersion.findFirst({ where: { photoId: added.added[0] } });
    c.ok("…labelled as the staging ('Virtual staging by Kyle Smith (next to 70-2.jpg)')", v7?.label === "Virtual staging by Kyle Smith (next to 70-2.jpg)", v7?.label ?? "");
    d7 = (await data.loadJobDetail(S7.job.id, { viewer: kyleView as never }))!;
    h7 = html(createElement(JobWorkspace, { data: d7, viewer: kyleView as never, history: null }));
    // Oct 28 2026: nothing open, so no Client requests item; the Deliver panel says they are settled, and how.
    const card7b = text(h7.split('id="pd-deliver-body"')[1] ?? "");
    c.ok("the hold clears by itself; Client requests read settled, 'Virtual staging added (on <the new photo>)', no steps", d7.gate!.checks.find((x) => x.key === "addon:virtual_staging")?.ok === true && !h7.includes("data-client-requests") && /Client requests settled[\s\S]*Virtual staging added \(on 70-2-staged\.jpg/.test(card7b) && !/Select photos for it/.test(text(h7)), card7b.slice(0, 300));
    c.ok("…and the confirmation will list it as done", steps.addOnConfirmLines(d7.gate!.checks)[0]?.done === true);

    // ======================================================================
    c.head("8 · the hub's own order: a wide front hero, the fronts, the inside, the back last");
    // ======================================================================
    c.ok("the free check's words: 'front door' is the front of the house; its hero score follows the view", check.roomTypeFrom("front door") === "EXTERIOR_FRONT" && check.heroScoreFrom("EXTERIOR_FRONT", "front exterior", "wide") === 90 && check.heroScoreFrom("EXTERIOR_FRONT", "front exterior", "close_up") === 10 && check.heroScoreFrom("EXTERIOR_FRONT", "front door", null) === 20 && check.heroScoreFrom("KITCHEN", "kitchen", "wide") === null);
    const O = (id: string, sequence: number, roomType: string, sequenceGroup: string, heroScore: number | null = null, isTwilight = false) => ({ id, name: `${id}.jpg`, sequence, roomType, sequenceGroup, heroScore, isTwilight });
    const gallery = [
      O("door", 0, "EXTERIOR_FRONT", "FRONT_EXTERIOR", 10), O("rear1", 1, "EXTERIOR_REAR", "REAR_EXTERIOR"), O("partial", 2, "EXTERIOR_FRONT", "FRONT_EXTERIOR", 50),
      O("kitchen", 3, "KITCHEN", "KITCHEN"), O("wide", 4, "EXTERIOR_FRONT", "FRONT_EXTERIOR", 90), O("living", 5, "LIVING", "MAIN_LIVING"), O("yard", 6, "YARD", "OUTDOOR_LIVING"),
      O("bed", 7, "BEDROOM", "BEDROOMS"), O("bath", 8, "BATHROOM", "BATHROOMS"), O("drone", 9, "AERIAL", "AERIAL"), O("foyer", 10, "ENTRY_FOYER", "ENTRY"), O("garage", 11, "GARAGE", "UTILITY"),
    ];
    const ord = delivery.suggestedOrder(gallery, null).map((p) => p.id).join();
    c.ok("hero = the wide front shot (never the door close-up), then the other fronts (the close-up last of them), aerial, the inside in walkthrough order, the backyard and the rear last",
      ord === "wide,partial,door,drone,foyer,living,kitchen,bed,bath,garage,yard,rear1", ord);
    c.ok("a twilight front shot leads when there is one; with no wide front shot, never a close-up", delivery.suggestedOrder([...gallery, O("dusk", 12, "TWILIGHT_EXTERIOR", "FRONT_EXTERIOR", 90, true)], null)[0].id === "dusk" && delivery.suggestedOrder([O("door", 0, "EXTERIOR_FRONT", "FRONT_EXTERIOR", 10), O("drone", 1, "AERIAL", "AERIAL"), O("living", 2, "LIVING", "MAIN_LIVING")], null)[0].id === "drone");
    c.ok("a hero Kyle picked by hand wins", delivery.suggestedOrder(gallery, "kitchen")[0].id === "kitchen");
    // End to end: the free check's view labels the photos, and the delivery order follows.
    const E8 = await mkJob("80 Order Ave", ["door", "wide", "kitchen", "rear"]);
    answers.set("80-1.jpg", { room: "front door", view: "close_up" });
    answers.set("80-2.jpg", { room: "front exterior", view: "wide" });
    answers.set("80-3.jpg", { room: "kitchen", view: "wide" });
    answers.set("80-4.jpg", { room: "rear exterior", view: "wide" });
    c.ok("the free check runs", await runCheck(E8.job.id));
    const o8 = (await delivery.deliveryOrderFor(E8.job.id)).map((o) => o.name).join();
    c.ok("after AutoHDR returns, the hub's order leads with the wide front, the door close-up after it, the rear last", o8 === "80-2.jpg,80-1.jpg,80-3.jpg,80-4.jpg", o8);
    await decisions.setDeliveryOrder(E8.job.id, [E8.photos[3].id, E8.photos[0].id, E8.photos[1].id, E8.photos[2].id], "Kyle Smith");
    c.ok("a manual order Kyle set by hand is never overridden", (await delivery.deliveryOrderFor(E8.job.id)).map((o) => o.name).join() === "80-4.jpg,80-1.jpg,80-2.jpg,80-3.jpg");

    // ======================================================================
    c.head("9 · missing photographer notes never hold Kyle; Ask the photographer for notes");
    // ======================================================================
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body });
      return { data: { id: `op-${texts.length}` } };
    };
    const W9 = await mkJob("90 Notes Rd", ["front", "living"], { stage: "READY", project: { photographerId: harrison.id, shootDate: new Date(Date.now() - DAY) } });
    const run9 = await prisma.photoQcRun.create({ data: { jobId: W9.job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", passesJson: "[]", checksJson: "{}", startedAt: new Date(), finishedAt: new Date() } });
    await prisma.photoJob.update({ where: { id: W9.job.id }, data: { lastQcRunId: run9.id } });
    for (const p of W9.photos) await prisma.photoAsset.update({ where: { id: p.id }, data: { inspectedHash: p.contentHash } });
    const gate9 = await delivery.deliveryGate(W9.job.id);
    const wrap = gate9.checks.find((x) => x.key === "wrapup");
    c.ok("the wrap-up line informs (advisory), never holds Kyle, offers the ask; the hub's own same-day delivery still waits", !!wrap && !wrap.ok && wrap.advisory === true && !wrap.hold && wrap.askNotes === true && wrap.hubHold === true && gate9.holdsOpen === 0 && gate9.canDeliver && !gate9.passed, JSON.stringify(wrap));
    const d9 = (await data.loadJobDetail(W9.job.id, { viewer: kyleView as never }))!;
    const v9 = H.holdingFor({ ...d9.holdingBase, stage: d9.header.stage, gate: d9.gate, gateError: d9.gateError, push: d9.aryeoPush });
    c.ok("'What's holding this' does not list it; it sits under 'Also open' with 'Ask the photographer for notes'", !v9.items.some((i) => i.kind === "wrapup") && v9.also.some((i) => i.kind === "wrapup" && i.action?.kind === "asknotes" && i.action.label === "Ask the photographer for notes"), JSON.stringify(v9.items.map((i) => i.kind)));
    const h9 = html(createElement(JobWorkspace, { data: d9, viewer: kyleView as never, history: null }));
    c.ok("the page shows the ask button, never 'Deliver without it'", /Ask the photographer for notes/.test(h9) && !/Deliver without it/.test(h9));
    const N = await import("@/lib/photoDelivery/askNotes");
    const ask1 = await N.askPhotographerForNotes(W9.job.id, { name: "Kyle Smith" });
    c.ok("one press: a text to Harrison through the office line, his first name, the street, the wrap-up link, no dashes", ask1.ok && texts.length === 1 && texts[0].to.endsWith("6105550123") && /^⚙️ Realtour Hub: Hi Harrison, any notes on 90 Notes Rd for the photos\?/.test(texts[0].body) && /\/upload\//.test(texts[0].body) && !DASH.test(texts[0].body), JSON.stringify({ ask1, texts }));
    const ask2 = await N.askPhotographerForNotes(W9.job.id, { name: "Kyle Smith" });
    c.ok("a second press inside two hours sends nothing and says who asked when", !ask2.ok && texts.length === 1 && /Give it two hours/.test(ask2.message), ask2.message);
    c.ok("…it is on the job's activity", (await prisma.photoJobEvent.count({ where: { jobId: W9.job.id, action: { startsWith: N.NOTES_ASK_ACTION } } })) === 1);
    await prisma.project.update({ where: { id: W9.project.id }, data: { debriefSubmittedAt: new Date(), removalNotes: "none", cullingConfirmedAt: new Date() } as never });
    await prisma.appSetting.deleteMany({ where: { key: N.notesAskKey(W9.job.id) } });
    const ask3 = await N.askPhotographerForNotes(W9.job.id, { name: "Kyle Smith" });
    c.ok("once the wrap-up is in, there is nothing to ask", !ask3.ok && /wrap-up is in/.test(ask3.message) && texts.length === 1, ask3.message);
    const TT = await import("@/lib/textTemplates");
    c.ok("the words are a template Jordan can reword (Settings, Text messages)", TT.TEXT_TEMPLATES.photo_notes_ask_photographer.audience === "team" && TT.checkTemplateBody("photo_notes_ask_photographer", TT.TEXT_TEMPLATES.photo_notes_ask_photographer.body).ok);

    // ======================================================================
    c.head("11 · Kyle's photo bells: nothing he can't act on, one per job per state");
    // ======================================================================
    const kyleRows = (kind?: string) => prisma.notification.count({ where: { userKey: `tm:${kyleTm.id}`, ...(kind ? { kind } : {}) } });
    const ownerRows = (kind: string) => prisma.notification.count({ where: { userKey: `tm:${jordanTm.id}`, kind } });
    await prisma.notification.deleteMany({});
    const J11 = await mkJob("110 Bell St", ["front"], { stage: "QC_REVIEW" });
    const href = `/ops/photo-delivery/${J11.job.id}`;
    await ops.alertOwnerAndKyle({ kind: "photo_autohdr_sent", title: "Sent to AutoHDR: 110 Bell St", href: "/ops/photo-delivery", dedupeKey: "pd-intake-sent-b1", text: "sent", to: "both" });
    // Oct 27 2026 (Jordan: "make sure we are not overloading Kyle, James, and
    // me with notifications that are not needed ... I am CEO."): the photo
    // pipeline is Kyle's lane, so Jordan's copy goes too (notifyRoles.ts,
    // notifyOps.ownerSkips). The board shows the hand-off.
    c.ok("'Sent to AutoHDR' (the hub did it by itself): nobody's bell (Kyle's gone Oct 23, Jordan's Oct 27 2026)", (await kyleRows("photo_autohdr_sent")) === 0 && (await ownerRows("photo_autohdr_sent")) === 0);
    await ops.alertOwnerAndKyle({ kind: "autohdr_credits_low", title: "Credits low", href: "/ops/photo-delivery/credits", dedupeKey: "autohdr-credits-250-e1", text: "low", to: "both" });
    c.ok("credits running low (Jordan tops them up): Jordan's only", (await kyleRows("autohdr_credits_low")) === 0 && (await ownerRows("autohdr_credits_low")) === 1);
    const { bellOnly } = await import("@/lib/photoDelivery/notifyOps");
    await bellOnly({ kind: "photo_free_check", title: "110 Bell St: photo check done, 2 things to look at", href, dedupeKey: "photo-free-check-run1", to: "both" });
    await bellOnly({ kind: "photo_free_check", title: "110 Bell St: photo check done, 1 thing to look at", href, dedupeKey: "photo-free-check-run2", to: "both" });
    c.ok("two free checks of the same job in the same state: one bell for Kyle, none for Jordan (Oct 27 2026)", (await kyleRows("photo_free_check")) === 1 && (await ownerRows("photo_free_check")) === 0);
    await prisma.photoJob.update({ where: { id: J11.job.id }, data: { stage: "READY", stageChangedAt: new Date(Date.now() + 1000) } });
    await bellOnly({ kind: "photo_free_check", title: "110 Bell St: photo check done, nothing found", href, dedupeKey: "photo-free-check-run3", to: "both" });
    c.ok("…a real state change (ready to review) is a new one", (await kyleRows("photo_free_check")) === 2);
    await prisma.photoJob.update({ where: { id: J11.job.id }, data: { stage: "DELIVERY_MISMATCH", stageChangedAt: new Date(Date.now() + 2000) } });
    for (const n of [1, 2, 3]) await ops.alertOwnerAndKyle({ kind: "photo_delivery_mismatch", title: "Delivery check: 110 Bell St", href, dedupeKey: `pd-mismatch-${J11.job.id}-${n}`, text: `diff ${n}`, to: "kyle" });
    c.ok("three delivery-check diffs on one mismatch: one bell for Kyle", (await kyleRows("photo_delivery_mismatch")) === 1);
    for (const b of ["batch1", "batch2"]) await ops.alertOwnerAndKyle({ kind: "photo_fixes_done", title: "Fixes done: 110 Bell St", href, dedupeKey: `pd-fixes-${b}`, text: "done", to: "kyle" });
    c.ok("fixes done stays one per fix batch (Kyle asked for it)", (await kyleRows("photo_fixes_done")) === 2);
    c.ok("the rule in one place (KYLE_SKIPS, KYLE_BUCKET), pure", ops.kyleBellKey({ kind: "photo_autohdr_slow", dedupeKey: "x", href }, null) === null && ops.kyleBellKey({ kind: "photo_free_check", dedupeKey: "x", href }, { stage: "READY", stageChangedAt: new Date(5) }) === `pd-kyle-${J11.job.id}-review-READY-5` && ops.kyleBellKey({ kind: "photo_autohdr_failed", dedupeKey: "pd-intake-failed-b", href: "/ops/photo-delivery" }, null) === "pd-intake-failed-b" && ops.jobIdOfHref(`${href}?tab=cart`) === J11.job.id);

    // ======================================================================
    c.head("12 · 'Waiting for upload' before the raws arrive, then Editing");
    // ======================================================================
    const U = await mkJob("120 Upload Way", [], { stage: "EDITING" });
    await prisma.photoJob.update({ where: { id: U.job.id }, data: { autohdrPhotoshootId: null } });
    const up = await import("@/lib/photoDelivery/uploadState");
    let du = (await data.loadJobDetail(U.job.id, { viewer: kyleView as never }))!;
    c.ok("no upload yet: the job's stage reads 'Waiting for upload' (header, stepper flag)", du.header.stageLabel === "Waiting for upload" && du.header.waitingForUpload === true);
    const { StageStepper } = await import("@/components/photoDelivery/StageStepper");
    c.ok("…the stage stepper names its first step so", /Waiting for upload/.test(html(createElement(StageStepper, { stage: "EDITING", holdResumeStage: null, waitingForUpload: true }))) && !/Waiting for upload/.test(html(createElement(StageStepper, { stage: "EDITING", holdResumeStage: null }))));
    const qu = (await data.loadQueue({ holding: true })).columns.flatMap((col) => col.cards).find((x) => x.id === U.job.id);
    c.ok("…the Photo Delivery board card reads 'Waiting for upload'", qu?.stageLabel === "Waiting for upload" && qu.waitingForUpload === true && qu.holding?.line === "Waiting for upload", JSON.stringify({ l: qu?.stageLabel, h: qu?.holding }));
    const { photoStageOf } = await import("@/lib/jobsBoard");
    c.ok("…the Shoots board's chip: 'Waiting for upload', never 'Editing'", photoStageOf({ jobStage: "EDITING", shootOver: true, rawsIn: false, liveOnAryeo: false, late: false, noRawsSeen: true }).label === "Waiting for upload" && photoStageOf({ jobStage: null, shootOver: true, rawsIn: false, liveOnAryeo: false, late: false }).label === "Waiting for upload");
    await prisma.photoIntakeBatch.create({ data: { projectId: U.project.id, batchNo: 1, state: "WAITING", rawPath: "/raw", fingerprint: "f1", filesJson: "[]", fileCount: 30, seenAt: new Date() } });
    c.ok("files still arriving (a batch waiting to settle): still waiting", (await up.waitingForUploadOf([{ projectId: U.project.id, stage: "EDITING", finalsCount: 0 }])).has(U.project.id));
    await prisma.photoIntakeBatch.updateMany({ where: { projectId: U.project.id }, data: { state: "PROCESSING" } });
    du = (await data.loadJobDetail(U.job.id, { viewer: kyleView as never }))!;
    const qu2 = (await data.loadQueue({ holding: true })).columns.flatMap((col) => col.cards).find((x) => x.id === U.job.id);
    c.ok("once the upload went on to AutoHDR: Editing everywhere", du.header.stageLabel === "Editing" && !du.header.waitingForUpload && qu2?.stageLabel === "Editing" && !qu2.waitingForUpload && !(await up.waitingForUploadOf([{ projectId: U.project.id, stage: "EDITING", finalsCount: 0 }])).has(U.project.id), JSON.stringify({ h: du.header.stageLabel, q: qu2?.stageLabel }));
    c.ok("…an AutoHDR shoot linked by hand counts as in too", !(await up.waitingForUploadOf([{ projectId: "nope", stage: "EDITING", finalsCount: 0, autohdrPhotoshootId: 7 }])).has("nope"));
    const desk = src("src/lib/officeDesk.ts");
    c.ok("Kyle's desk reads the same flag ('Waiting for upload', the photographer's; late: 'Ask the photographer', never 'Late from AutoHDR')", /c\.waitingForUpload \? \{ tone: "waiting", status: "Waiting for upload", who: "the photographer" \}/.test(desk) && /notUp \? "Waiting for upload · Ask the photographer"/.test(desk));

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

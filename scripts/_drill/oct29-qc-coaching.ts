// ---------------------------------------------------------------------------
// DRILL: PHOTO CHECK FINDINGS AS COACHING, AND COACHING THAT REACHES THE
// PERSON (Oct 29 2026, Jordan's call table: "No 'not an issue' outcome",
// "Photo QC flags lack context", "Coaching does not clearly reach the
// employee").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct29-qc-coaching.ts
//
//   §1 the rules, pure: which checks are about what is at the property (a car,
//      a bin, a cord, staging) and which are capture skill; the photo desk's
//      own words ("neighbor's truck") settle a finding; a capture check people
//      keep calling not an issue needs a look too; the sentence and the
//      "how it reached them" words
//   §2 James's coaching rows: a car in the driveway on three of Harrison's
//      shoots is a row "to confirm", never evidence (no coaching item can be
//      made from it, Process Improvements never counts it); blurry photos
//      count as before; Kyle's "neighbor's truck" takes a finding out
//   §3 the calls: Photographer's to fix (it counts, even on one shoot), Not an
//      issue (outside their control, or the check was wrong), Undo; the tally;
//      "the check was wrong" teaches the photo desk (learnedRules); the owner's
//      dashboard drops a not-an-issue finding; Kyle, Harrison and a preview
//      are refused; a finding the editor answers for is refused
//   §4 the notice: feedback recorded for Harrison rings his bell and texts him
//      the link to /shoot/feedback#coaching, money-scrubbed, laid out for a
//      phone; the coaching entry says "Harrison was texted at ..."; Kim (an
//      editor) gets a Slack DM to /my-coaching; a switch that is off says
//      "bell only"; quiet time says when the text will go
//   §5 the person's own page: Harrison's coaching on My quality notes, Kim's
//      on /my-coaching, nobody else's; a photographer is sent to
//      /shoot/feedback#coaching; no money, no em dashes
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced (Slack answered by a fake and counted),
// OpenPhone's two calls replaced in-process. Nothing is sent anywhere.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();

// ---- after(): run eagerly, awaited before the checks that need it -------------
const pending: Promise<unknown>[] = [];
interceptModule((r) => r === "next/server", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "after" ? (fn: () => unknown) => { pending.push(Promise.resolve().then(fn).catch(() => undefined)); } : t[k]),
}));
const settleAfter = async () => { while (pending.length) await pending.shift(); };

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
navigation.redirect = (href) => { throw new Redirect(href); };

// ---- Slack, faked at fetch and counted --------------------------------------
const slack: { channel: string; text: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length), channel: body.channel });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});

const H = 3_600_000;
const D = 24 * H;
const DASH = /[—–]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7393), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-qc-coaching", NEXT_PUBLIC_APP_URL: "https://hub.drill.invalid" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { putSetting } = await import("@/lib/settings");
    const qc = await import("@/lib/qcCoaching");
    const notice = await import("@/lib/coachingNotice");
    const { readDevelopment } = await import("@/lib/teamDevelopment");
    const { frictionsFrom } = await import("@/lib/creativeDesk");
    const actions = await import("@/app/creativeDeskActions");
    const { learnedRules } = await import("@/lib/photoDelivery/fixPolicy");
    const { readMyCoaching } = await import("@/lib/myCoaching");
    const { MyCoachingList } = await import("@/components/coaching/MyCoachingList");
    const { default: myCoachingPage } = await import("@/app/my-coaching/page");
    const { etDayKey } = await import("@/lib/datetime");

    // OpenPhone: the number lookup and the send, answered in-process.
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body });
      return { data: { id: `op-${texts.length}` } };
    };
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);

    // =====================================================================
    c.head("§1 · the rules, pure");
    // =====================================================================
    c.ok("at the property: a car in the driveway, a vehicle blocking the home, a bin, a cord, belongings, an unmade bed, the catch-all", ["EXT_PARKED_CARS_DRIVEWAY", "EXT_VEHICLES_BLOCKING_HOME", "EXT_TRASH_CANS_PRIMARY", "PREP_LOOSE_CORDS_CABLES", "PREP_OTHER_PERSONAL_BELONGINGS", "BED_UNMADE", "PREP_LEFTOVER_ITEM_VACANT", "OTHER_DEFECT", "REFL_OBJECTS_THROUGH_WINDOWS"].every(qc.atTheProperty));
    c.ok("capture skill: focus, composition, framing, coverage, the photographer's own car, a toilet emphasized", ["COMP_BLURRY", "COMP_AWKWARD", "PERSP_OVERLY_WIDE", "ORD_KITCHEN", "COVERAGE_ROOM_NOT_CAPTURED", "EXT_PHOTOGRAPHER_VEHICLE", "BATH_TOILET_EMPHASIZED", "EXT_INCOMPLETE_HOME_VIEW", "REFL_PHOTOGRAPHER_IN_MIRROR"].every((r) => !qc.atTheProperty(r)));
    const none = new Map<string, import("../../src/lib/qcCoaching").RuleTally>();
    const f0 = (ruleId: string, extra: Partial<{ status: string; decidedBy: string | null; statusReason: string | null }> = {}) => ({ ruleId, status: "OPEN", decidedBy: null, statusReason: null, ...extra });
    c.ok("an open car in the driveway needs a look; blurry counts", qc.coachState(f0("EXT_PARKED_CARS_DRIVEWAY"), null, none).state === "needs_look" && qc.coachState(f0("COMP_BLURRY"), null, none).state === "counts");
    c.ok("Kyle's 'Not worth fixing: neighbor's truck' settles it (out)", qc.coachState(f0("EXT_VEHICLES_BLOCKING_HOME", { status: "IGNORED", decidedBy: "Kyle Smith", statusReason: "Neighbor's truck, can't be moved" }), null, none).state === "dismissed");
    c.ok("…the same words from the hub itself settle nothing (a person's words only)", qc.coachState(f0("EXT_VEHICLES_BLOCKING_HOME", { status: "IGNORED", decidedBy: "hub: as-is home", statusReason: "neighbor" }), null, none).state === "needs_look");
    c.ok("…an Ignore with other words ('client wants it') still needs a look", qc.coachState(f0("EXT_PARKED_CARS_DRIVEWAY", { status: "IGNORED", decidedBy: "Kyle Smith", statusReason: "Client wants it as is" }), null, none).state === "needs_look");
    c.ok("a reshoot a person asked for confirms it", qc.coachState(f0("BED_UNMADE", { status: "RESHOOT_REQUESTED", decidedBy: "Jordan Spackman", statusReason: "Bed unmade" }), null, none).state === "counts");
    const callOf = (verdict: "coach" | "not_theirs" | "wrong") => ({ verdict, reason: null, by: "James Livingston", at: T.toISOString(), ruleId: "X", jobId: "j" });
    c.ok("a call wins: coach counts, not_theirs and wrong are out, whatever the check", qc.coachState(f0("EXT_PARKED_CARS_DRIVEWAY"), callOf("coach"), none).state === "counts" && qc.coachState(f0("COMP_BLURRY"), callOf("not_theirs"), none).state === "dismissed" && qc.coachState(f0("COMP_BLURRY"), callOf("wrong"), none).state === "dismissed");
    const learned = new Map([["COMP_AWKWARD", { ruleId: "COMP_AWKWARD", coach: 1, notTheirs: 2, wrong: 1 }], ["COMP_BLURRY", { ruleId: "COMP_BLURRY", coach: 2, notTheirs: 2, wrong: 0 }]]);
    c.ok("a capture check called not an issue 3 of 4 times needs a look; 2 of 4 does not", qc.coachState(f0("COMP_AWKWARD"), null, learned).state === "needs_look" && qc.coachState(f0("COMP_BLURRY"), null, learned).state === "counts");
    c.ok("the tally in words", qc.tallyWords(learned.get("COMP_AWKWARD")) === "Called not an issue 3 of 4 times in 90 days (2 outside the photographer's control, 1 the check was wrong)", String(qc.tallyWords(learned.get("COMP_AWKWARD"))));
    const w = notice.noticeWords({ personName: "Harrison Wells", group: "FIELD", skill: "Photo check: Blurry photo", what: "created", by: "James Livingston", note: "Your $450 bonus depends on it — use the tripod <always>" });
    c.ok("the sentence: who, what, the note (money out, dashes out), the link to his own page", /^James left you coaching feedback: Photo check, Blurry photo\n>/.test(w.slackDm) && w.slackDm.endsWith("Read it in the hub: https://hub.drill.invalid/shoot/feedback#coaching") && !/\$|450/.test(w.slackDm) && !DASH.test(w.slackDm) && w.slackDm.includes("&lt;always&gt;"), w.slackDm);
    c.ok("an editor's link is /my-coaching", notice.noticeWords({ personName: "Kim Miguel", group: "EDITOR", skill: "Captions", what: "follow_up", by: "Jordan Spackman", note: null }).href === "/my-coaching");
    const now = new Date();
    const told = (legs: { channel: string; status: string; detail?: string | null; createdAt?: Date }[], pend = new Map()) => notice.toldWords("Harrison Wells", legs.map((l) => ({ detail: null, createdAt: now, ...l })), pend, now);
    c.ok("words: texted / Slack DM / bell only / not yet", /^Harrison was texted at \d/.test(told([{ channel: "bell", status: "sent" }, { channel: "sms", status: "queued", detail: "p1" }, { channel: "sms", status: "sent", detail: "p1" }])) && /^Harrison got a Slack DM at /.test(told([{ channel: "bell", status: "sent" }, { channel: "slack", status: "sent" }])) && /hub bell only/.test(told([{ channel: "bell", status: "sent" }])) && told([]) === "Harrison has not been told yet");
    c.ok("words: a text held for quiet time says when", /^Harrison gets the text after their quiet time, /.test(told([{ channel: "sms", status: "queued", detail: "p2" }], new Map([["p2", { sentAt: null, deferUntil: new Date(now.getTime() + 5 * H), skippedAt: null, skipReason: null }]]))));

    // =====================================================================
    c.head("§2 · James's coaching rows: at the property needs a look");
    // =====================================================================
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@qcc.invalid`, active: true, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER", { phone: "(610) 555-0111", slackId: "U0JORDAN01" });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true, slackId: "U0KYLE0001" });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true, phone: "(610) 555-0133", slackId: "U0JAMES001" });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER", { phone: "(610) 555-0144", slackId: "U0HARRIS01" });
    const patTm = await tm("Pat Field", "PHOTOGRAPHER", { phone: "(610) 555-0155" });
    const quinnTm = await tm("Quinn Night", "PHOTOGRAPHER", { phone: "(610) 555-0166" });
    const kimTm = await tm("Kim Miguel", "MANAGER", { phone: "+63 917 555 0101", slackId: "U0KIMMIG01" });
    const login = (name: string, email: string, role: string, teamMemberId: string | null, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", ...extra } });
    const owner = await login("Jordan Spackman", "jordan@qcc.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@qcc.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@qcc.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await login("Harrison Wells", "harrison@qcc.invalid", "PHOTOGRAPHER", harrisonTm.id);
    await login("Pat Field", "pat@qcc.invalid", "PHOTOGRAPHER", patTm.id);
    await login("Quinn Night", "quinn@qcc.invalid", "PHOTOGRAPHER", quinnTm.id);
    const kim = await login("Kim Miguel", "kim@qcc.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    const client = await prisma.client.create({ data: { name: "Real Agent" } });
    const job = async (street: string, daysAgo: number, photographerId = harrisonTm.id) => {
      const p = await prisma.project.create({ data: { clientId: client.id, title: `${street}, Town`, addressLine: street, status: "DELIVERED", photographerId, shootDate: at(-daysAgo * D) } });
      const j = await prisma.photoJob.create({ data: { projectId: p.id } });
      const photo = await prisma.photoAsset.create({ data: { jobId: j.id, name: `${street}.jpg` } });
      return { projectId: p.id, jobId: j.id, photoId: photo.id, street };
    };
    const finding = (j: { jobId: string; photoId: string }, ruleId: string, issue: string, extra: Record<string, unknown> = {}) =>
      prisma.photoQcFinding.create({ data: { qcRunId: "run-drill", jobId: j.jobId, photoId: j.photoId, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: issue, explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "PHOTOGRAPHER", fixStrategy: "REEDIT_PROMPT", status: "OPEN", ...extra } });
    const j1 = await job("11 Elm St", 2);
    const j2 = await job("22 Oak Ave", 3);
    const j3 = await job("33 Pine Rd", 4);
    const j4 = await job("44 Birch Ln", 5);
    const car1 = await finding(j1, "EXT_PARKED_CARS_DRIVEWAY", "A silver sedan in the driveway");
    const car2 = await finding(j2, "EXT_PARKED_CARS_DRIVEWAY", "A pickup in the driveway");
    const car3 = await finding(j3, "EXT_PARKED_CARS_DRIVEWAY", "Two cars at the curb");
    await finding(j1, "COMP_BLURRY", "The kitchen is soft");
    await finding(j2, "COMP_BLURRY", "The living room is soft");
    await finding(j3, "EXT_VEHICLES_BLOCKING_HOME", "A truck across the front", { status: "IGNORED", decidedBy: "Kyle Smith", decidedAt: at(-H), statusReason: "Neighbor's truck, can't be moved" });
    const truck4 = await finding(j4, "EXT_VEHICLES_BLOCKING_HOME", "A van in front of the garage");
    const editorOwned = await finding(j4, "EXPO_HDR_HALOS", "Halos on the roof", { responsibility: "EDITOR" });

    const sigs = async () => (await readDevelopment({ excludeClientIds: [] })).signals.filter((s) => s.personId === harrisonTm.id);
    let s = await sigs();
    const look = () => s.find((x) => x.key === `field:${harrisonTm.id}:photoqc-look:EXT_PARKED_CARS_DRIVEWAY`);
    const carCounted = () => s.find((x) => x.key === `field:${harrisonTm.id}:photoqc:EXT_PARKED_CARS_DRIVEWAY`);
    const blurry = () => s.find((x) => x.key === `field:${harrisonTm.id}:photoqc:COMP_BLURRY`);
    c.ok("the car in the driveway on 3 shoots is a row TO CONFIRM, never a counted photo check", !!look() && look()!.needsLook === true && look()!.skill === "Photo check to confirm: Car in driveway" && look()!.findings?.length === 3 && !carCounted(), JSON.stringify(s.map((x) => x.key)));
    c.ok("…its words say none counts until someone confirms it", /None counts until someone says it was the photographer's to fix/.test(look()!.detail));
    c.ok("…each finding carries its photo and job for the panel", look()!.findings!.every((f) => f.photoId && f.jobId && f.state === "needs_look" && !f.call));
    c.ok("blurry photos on 2 shoots count, as before", !!blurry() && !blurry()!.needsLook && blurry()!.count === 2 && blurry()!.findings?.every((f) => f.state === "counts") === true);
    c.ok("a vehicle blocking the home: Kyle's 'neighbor's truck' takes that one out, one left is no row", !s.some((x) => x.key.endsWith(":EXT_VEHICLES_BLOCKING_HOME")));
    const fr = frictionsFrom(s, []);
    c.ok("Process Improvements count the blurry photos and never the unconfirmed cars", fr.some((f) => f.key === "friction:photoqc:COMP_BLURRY") && !fr.some((f) => /EXT_PARKED_CARS_DRIVEWAY|Car in driveway/.test(f.key + f.title)), JSON.stringify(fr.map((f) => f.key)));
    const { loadOwnerTopics } = await import("@/lib/ownerTopics");
    const desks = { office: { key: "kyle", name: "Kyle Smith" }, cm: { key: "james", name: "James Livingston" }, owner: { key: "jordan", name: "Jordan Spackman" } };
    const ownerTopicTitles = async () => (await loadOwnerTopics({ now: new Date(), bottlenecks: [], excludeClientIds: [], desks })).topics.map((t) => t.title);
    const topicsBefore = await ownerTopicTitles();
    c.ok("(before any call) the owner's dashboard shows the cars on 3 shoots as a recurring photo issue", topicsBefore.some((t) => /Car in driveway/.test(t)), JSON.stringify(topicsBefore));
    await signIn(james);
    const { buildCreativeDesk } = await import("@/lib/creativeDesk");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { PanelBody } = await import("@/components/creativeDesk/CreativePanels");
    const panelHtml = async (panel: import("../../src/components/creativeDesk/CreativePanels").Panel) => {
      const desk = await buildCreativeDesk((await getCurrentUser())!, { only: "development" });
      return renderToStaticMarkup(createElement(PanelBody, { panel, desk, href: (h: string) => h, onClose: () => {} }));
    };
    const lookHtml = await panelHtml({ kind: "signal", key: look()!.key });
    c.ok("James's panel for the row to confirm: each photo, Photographer's to fix and Not an issue on each, one for all, no Record feedback", lookHtml.includes("Look at each one") && (lookHtml.match(/Photographer&#x27;s to fix|Photographer’s to fix/g) ?? []).length === 3 && /Not an issue: all (<!-- -->)?3/.test(lookHtml) && lookHtml.includes(`/api/photo-delivery/img/${car1.photoId}/thumb256`) && lookHtml.includes(`/ops/photo-delivery/${j1.jobId}?photo=${j1.photoId}`) && !lookHtml.includes('data-control="new-item"'), JSON.stringify({ to: (lookHtml.match(/Photographer&#x27;s to fix|Photographer’s to fix/g) ?? []).length, all: /Not an issue: all (<!-- -->)?3/.test(lookHtml), img: (lookHtml.match(/<img[^>]*>/g) ?? []).slice(0, 1), link: lookHtml.includes(`/ops/photo-delivery/${j1.jobId}?photo=${j1.photoId}`), form: lookHtml.includes('data-control="new-item"') }));
    c.ok("…it says the row is not evidence yet, and offers both reasons", /Not evidence yet/.test(lookHtml) && lookHtml.includes("The check was wrong (it is not in the photo)") && !DASH.test(lookHtml.replace(/<[^>]+>/g, "")));
    const refused = await actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, signalKey: look()!.key, note: "Move the cars before shooting" });
    c.ok("no coaching item can be made from the row to confirm", !refused.ok && /Confirm first/.test(refused.message) && (await prisma.developmentItem.count()) === 0, refused.message);

    // =====================================================================
    c.head("§3 · the calls: Photographer's to fix, Not an issue, Undo");
    // =====================================================================
    let r = await actions.qcCoachCallAction([car1.id], "coach");
    s = await sigs();
    c.ok("James: the sedan was Harrison's to fix. It counts, even on one shoot, said as confirmed", r.ok && !!carCounted() && carCounted()!.count === 1 && /1 confirmed by a person/.test(carCounted()!.detail) && carCounted()!.findings?.[0]?.call?.verdict === "coach", r.message);
    c.ok("…the other two still wait on a look", look()?.findings?.length === 2);
    r = await actions.qcCoachCallAction([car2.id, car3.id], "not_theirs", "Neighbor's cars — not ours");
    s = await sigs();
    c.ok("Not an issue (outside their control) on the other two: out of the coaching rows", r.ok && !look() && /2 marked not an issue \(outside the photographer's control\)/.test(r.message), r.message);
    const row = await prisma.appSetting.findUnique({ where: { key: qc.coachKey(car2.id) } });
    const saved = JSON.parse(row?.value ?? "{}") as { verdict?: string; reason?: string; by?: string; ruleId?: string };
    c.ok("…kept as one row per finding, with who, why (no dashes) and the check", saved.verdict === "not_theirs" && saved.by === "James Livingston" && saved.reason === "Neighbor's cars, not ours" && saved.ruleId === "EXT_PARKED_CARS_DRIVEWAY", row?.value);
    c.ok("…the finding itself is untouched (the photo desk's decision stands)", (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: car2.id } })).status === "OPEN");
    c.ok("…the tally on the row says it", carCounted()?.tally === "Called not an issue 2 of 3 times in 90 days (2 outside the photographer's control)", String(carCounted()?.tally));
    r = await actions.qcCoachCallAction([car3.id], "undo");
    s = await sigs();
    c.ok("Undo puts it back to waiting on a look", r.ok && look()?.findings?.length === 1 && look()!.findings![0].id === car3.id && !(await prisma.appSetting.findUnique({ where: { key: qc.coachKey(car3.id) } })));
    r = await actions.qcCoachCallAction([car3.id], "wrong", "No car in the photo");
    const learnedNow = await learnedRules();
    c.ok("'the check was wrong' teaches the photo desk: a Not there on that check (fixed automatically only when very sure)", r.ok && (learnedNow.get("EXT_PARKED_CARS_DRIVEWAY")?.notThere ?? 0) === 1, JSON.stringify(learnedNow.get("EXT_PARKED_CARS_DRIVEWAY")));
    // The owner's dashboard: "Recurring photo issue" needs 3 shoots in 7 days; the cars were 3, two are now not an issue.
    const topics = await ownerTopicTitles();
    c.ok("the owner's dashboard drops what was called not an issue: no 'Recurring photo issue: Car in driveway' now", !topics.some((t) => /Car in driveway/.test(t)), JSON.stringify(topics));
    const editorRefused = await actions.qcCoachCallAction([editorOwned.id], "not_theirs");
    c.ok("a finding the editor answers for is refused", !editorRefused.ok, editorRefused.message);
    await signIn(kyle);
    const kyleR = await actions.qcCoachCallAction([truck4.id], "not_theirs");
    await signIn(harrison);
    const harrisonR = await actions.qcCoachCallAction([truck4.id], "not_theirs");
    await signIn(owner, james.id);
    const previewR = await actions.qcCoachCallAction([truck4.id], "not_theirs");
    c.ok("Kyle (no coaching seat), Harrison and the owner's preview are refused; nothing written", !kyleR.ok && !harrisonR.ok && !previewR.ok && /previewing/.test(previewR.message) && !(await prisma.appSetting.findUnique({ where: { key: qc.coachKey(truck4.id) } })), `${kyleR.message} | ${harrisonR.message} | ${previewR.message}`);
    await signIn(owner);
    r = await actions.qcCoachCallAction([truck4.id], "not_theirs");
    c.ok("Jordan can call one too", r.ok);

    // =====================================================================
    c.head("§4 · the notice: in his hub, a text with the link, and the entry says so");
    // =====================================================================
    await signIn(james);
    s = await sigs();
    const textsBefore = texts.length;
    const made = await actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, signalKey: blurry()!.key, note: "Use the tripod in every interior. Your $450 bonus is not the point — sharp photos are.", standard: "Every interior sharp at 100%", nextAction: "Tripod on every interior" });
    await settleAfter();
    const item = await prisma.developmentItem.findFirstOrThrow({ where: { personId: harrisonTm.id } });
    const log0 = JSON.parse(item.logJson)[0] as { notice?: string };
    c.ok("feedback recorded from the counted row; the message says he sees it", made.ok && /They see it in the hub and get a link/.test(made.message) && log0.notice === `coaching:${item.id}:0`, made.message);
    const bell = await prisma.notification.findFirst({ where: { dedupeKey: `coaching:${item.id}:0-0` } });
    c.ok("his bell: his own row, the coaching kind, the link to his quality notes", bell?.userKey === `tm:${harrisonTm.id}` && bell.kind === "coaching_feedback" && bell.href === "/shoot/feedback#coaching" && !/\$/.test(bell.title), JSON.stringify(bell));
    const toHarrison = texts.slice(textsBefore).filter((t) => t.to.replace(/\D/g, "").endsWith("5550144"));
    c.ok("he is texted once, with the direct link", toHarrison.length === 1 && toHarrison[0].body.includes("https://hub.drill.invalid/shoot/feedback#coaching") && /James left you coaching feedback/.test(toHarrison[0].body), JSON.stringify(texts.slice(textsBefore)));
    c.ok("…money-scrubbed and without em dashes", !!toHarrison[0] && !/\$|450/.test(toHarrison[0].body) && !DASH.test(toHarrison[0].body.replace(/^[^:]*:/, "")), toHarrison[0]?.body);
    let dev = await readDevelopment({ excludeClientIds: [] });
    let view = dev.items.find((i) => i.id === item.id)!;
    c.ok("the coaching entry says how it reached him: 'Harrison was texted at ...'", /^Harrison was texted at \d{1,2}:\d{2}\s?[AP]M$/.test(view.log[0].told ?? ""), view.log[0].told ?? "(none)");
    const itemHtml = await panelHtml({ kind: "dev-item", id: item.id });
    c.ok("…on James's coaching entry, under the note, with the line saying he sees it", /data-told[^>]*>Harrison was texted at /.test(itemHtml) && itemHtml.includes("They see this on their own page in the hub"), itemHtml.slice(itemHtml.indexOf("History"), itemHtml.indexOf("History") + 400));
    const fu = await actions.recordFollowUpAction(item.id, { note: "Two of three interiors sharp", result: "not_yet" });
    await settleAfter();
    dev = await readDevelopment({ excludeClientIds: [] });
    view = dev.items.find((i) => i.id === item.id)!;
    const fuLine = view.log.find((l) => l.kind === "follow_up");
    c.ok("a follow-up tells him too, and its entry says how", fu.ok && fuLine?.notice === `coaching:${item.id}:1` && !!fuLine.told && !/not been told/.test(fuLine.told), fuLine?.told ?? "(none)");
    // Kim, an editor: Slack by default, to /my-coaching.
    const slackBefore = slack.length;
    const kimMade = await actions.recordFeedbackAction({ group: "EDITOR", personId: kimTm.id, skill: "Caption accuracy", note: "Two captions misspelled the street" });
    await settleAfter();
    const kimItem = await prisma.developmentItem.findFirstOrThrow({ where: { personId: kimTm.id } });
    const kimDm = slack.slice(slackBefore).filter((m) => m.channel === "U0KIMMIG01");
    c.ok("Kim (an editor) gets a Slack DM with the link to /my-coaching, on the editor kind", kimMade.ok && kimDm.length === 1 && kimDm[0].text.includes("https://hub.drill.invalid/my-coaching") && (await prisma.notification.findFirst({ where: { dedupeKey: `coaching:${kimItem.id}:0-0` } }))?.kind === "coaching_feedback_editor", JSON.stringify(slack.slice(slackBefore)));
    dev = await readDevelopment({ excludeClientIds: [] });
    c.ok("…and the entry says 'Kim got a Slack DM at ...'", /^Kim got a Slack DM at /.test(dev.items.find((i) => i.id === kimItem.id)?.log[0].told ?? ""), dev.items.find((i) => i.id === kimItem.id)?.log[0].told ?? "(none)");
    // Pat: the switch for this is off.
    const off = { mention: { slack: false, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: false, sms: false }, shoot_change: { slack: false, sms: false } };
    await putSetting(`notify-prefs:${patTm.id}`, off);
    await actions.recordFeedbackAction({ group: "FIELD", personId: patTm.id, skill: "Shot list", note: "Missed the back yard" });
    await settleAfter();
    // Quinn: quiet all of today.
    const dow = new Date(`${etDayKey(new Date())}T12:00:00Z`).getUTCDay();
    await putSetting(`notify-schedule:${quinnTm.id}`, { windows: [{ day: dow, from: 0, to: 1440 }], setBy: "drill", setAt: new Date().toISOString() });
    const quinnTexts = texts.length;
    await actions.recordFeedbackAction({ group: "FIELD", personId: quinnTm.id, skill: "Shot list", note: "Missed the garage" });
    await settleAfter();
    dev = await readDevelopment({ excludeClientIds: [] });
    const patWords = dev.items.find((i) => i.personId === patTm.id)?.log[0].told ?? "";
    const quinnWords = dev.items.find((i) => i.personId === quinnTm.id)?.log[0].told ?? "";
    c.ok("Pat's switch is off: 'in the hub bell only', no text", /^Pat has it in the hub bell only/.test(patWords) && !texts.some((t) => t.to.endsWith("5550155")), patWords);
    c.ok("Quinn's quiet time: the text waits, and the entry says until when", /^Quinn gets the text after their quiet time, /.test(quinnWords) && texts.length === quinnTexts, quinnWords);

    // =====================================================================
    c.head("§5 · the person's own page");
    // =====================================================================
    const mine = await readMyCoaching([harrisonTm.id]);
    c.ok("Harrison's own list: his item, the standard, the next step, the notes newest first", mine.length === 1 && mine[0].standard === "Every interior sharp at 100%" && mine[0].notes[0]?.what === "Follow-up (not there yet)" && mine[0].notes[1]?.what === "Feedback", JSON.stringify(mine));
    c.ok("…nobody else's (Kim's, Pat's, Quinn's are not in it)", !JSON.stringify(mine).includes("Caption accuracy") && !JSON.stringify(mine).includes("Missed the"));
    c.ok("…no money, no em dashes, no links into office pages", !/\$|\b450\b/.test(JSON.stringify(mine)) && !DASH.test(JSON.stringify(mine)) && !JSON.stringify(mine).includes("/ops/photo-delivery"));
    const html = renderToStaticMarkup(createElement(MyCoachingList, { items: mine, whose: "your" }));
    c.ok("the list renders with the #coaching anchor the text links to", html.includes('id="coaching"') && html.includes("Use the tripod in every interior") && html.includes("Every interior sharp at 100%"));
    await signIn(kim);
    const kimHtml = renderToStaticMarkup((await myCoachingPage()) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("/my-coaching for Kim: her own coaching, nobody else's", kimHtml.includes("Caption accuracy") && kimHtml.includes("Two captions misspelled the street") && !kimHtml.includes("tripod") && !kimHtml.includes("Team development"));
    await signIn(harrison);
    let sent: string | null = null;
    try { await myCoachingPage(); } catch (e) { if (e instanceof Redirect) sent = e.href; else throw e; }
    c.ok("a photographer opening /my-coaching is sent to My quality notes (#coaching)", sent === "/shoot/feedback#coaching", String(sent));
    await signIn(james);
    const jamesHtml = renderToStaticMarkup((await myCoachingPage()) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("James (a coach) sees an empty list of his own and the way to the team's", jamesHtml.includes("No coaching recorded for you") && jamesHtml.includes("/development"));

    c.ok("fence: nothing left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked));
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

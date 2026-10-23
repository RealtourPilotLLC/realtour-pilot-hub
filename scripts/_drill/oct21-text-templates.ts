// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: EVERY AUTOMATIC TEXT IS A TEMPLATE (Oct 21 2026). Jordan: "add
// settings to customize all text templates."
//
//   cd "<repo>" && PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     node scripts/_drill/run-all.cjs scripts/_drill/oct21-text-templates.ts
//
// What it proves:
//   1. NOTHING CHANGES UNTIL JORDAN EDITS ONE. Every registered template, at
//      its default, renders byte-for-byte what the code sent before
//      (BASE = 673595c): the old modules are loaded from git and their public
//      builders called (digestText, nagText, composeNudgeText,
//      composeManagerLine, composeShootDayText, composeGapText,
//      confirmationMessage, deliveryMessage, applyTemplate), and the inline
//      senders' old template literals are copied here verbatim, for the same
//      inputs (several shapes each: one item or many, the optional parts on and
//      off). The four client texts that already had boxes send the old box's
//      wording exactly as before. Every key is covered, every default fills
//      every placeholder with its sample, the lib/settings names still read
//      the same words.
//   2. A saved wording is used: the store, the set, and a real sender (the
//      7 PM upload list, OpenPhone replaced at the module boundary).
//   3. Refused at save, and ignored at send: a required placeholder taken out,
//      an unknown placeholder, a stray brace; a client text with a long dash
//      or a Dropbox link (a team text keeps its dash).
//   4. Reset restores the default and empties an old box (and only that field);
//      the default word for word is a reset; the Automated texts rules save no
//      longer writes the wording.
//   5. The Settings actions refuse anyone but the owner (Kyle included), and
//      the card renders: grouped, chips, preview, count, read-only for Kyle,
//      and the payday text (pay) listed for the owner only.
//
// ISOLATION: PGlite on 127.0.0.1:7341 (DRILL_PORT overrides) through the shared
// harness; production is never opened; every non-loopback call is fenced;
// OpenPhone is replaced at the module boundary and every text is recorded,
// never sent. AUTH_ENFORCE is on: real sessions, real guards.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7341);
const BASE = "673595c"; // the commit this build starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");
const APP = "https://hub.drill.invalid";

installNextStubs();
const fence = fenceFetch();

// ---- OpenPhone, replaced at the module boundary ---------------------------
const texts: { to: string; text: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/openphone",
  (loaded) => {
    const m = loaded as Record<string, unknown> & { OpenPhone: Record<string, unknown> };
    return {
      ...m,
      defaultOpenPhoneNumber: async () => "+15555550100",
      OpenPhone: { ...m.OpenPhone, sendMessage: async (_from: string, to: string, text: string) => { texts.push({ to, text }); return { id: `msg-${texts.length}` }; } },
    };
  },
);

/** The old modules, from git, with "@/" pointed at today's src (their own imports did not change). */
function writeBaseCopies(): Record<"digest" | "missing" | "shootDay" | "gaps" | "delivery", string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oct21-tt-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = {} as Record<"digest" | "missing" | "shootDay" | "gaps" | "delivery", string>;
  for (const [k, f] of [["digest", "uploadDigest"], ["missing", "missingInstructions"], ["shootDay", "shootDayText"], ["gaps", "uploadGaps"], ["delivery", "delivery"]] as const) {
    out[k] = path.join(dir, `${f}.base.ts`);
    fs.writeFileSync(out[k], point(show(`src/lib/${f}.ts`)));
  }
  return out;
}

const c = makeChecker();

async function main() {
  process.env.NEXT_PUBLIC_APP_URL = APP;
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-text-templates", NEXT_PUBLIC_APP_URL: APP } });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const TT = await import("@/lib/textTemplates");
    const store = await import("@/lib/textTemplateStore");
    const S = await import("@/lib/settings");
    const { setSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/settings/textTemplateActions");
    const digest = await import("@/lib/uploadDigest");
    const missing = await import("@/lib/missingInstructions");
    const shootDay = await import("@/lib/shootDayText");
    const gaps = await import("@/lib/uploadGaps");
    const delivery = await import("@/lib/delivery");
    const { paydayText } = await import("@/lib/payroll");
    const { portalMessageLine } = await import("@/lib/programMessages");
    const { shootNoteText } = await import("@/lib/shootNotes");
    const { chaseOwnerText, CHASE_WINDOW_DAYS } = await import("@/lib/chaseCounter");
    const { photosUndeliveredText } = await import("@/lib/deliveryWatch");
    const { deskTaskPingText } = await import("@/lib/programDeskTasks");
    const { reviewEscalationText } = await import("@/lib/reviewerAssignment");
    const { onCallPageText } = await import("@/lib/commsSla");
    const { clip, noDashes, scrubMoney } = await import("@/lib/text");
    const { etDateTime } = await import("@/lib/datetime");
    const base = writeBaseCopies();
    type Missing = { video: string[]; photos: string[] };
    const OLD = {
      digest: (await import(base.digest)) as { digestText: (f: string, s: string[]) => string; nagText: (f: string, s: string[], split?: { street: string; url: string }[]) => string },
      missing: (await import(base.missing)) as {
        composeNudgeText: (o: { firstName: string; street: string; shotOn: Date; missing: Missing; link: string; again?: boolean }) => string;
        composeManagerLine: (o: { photographerFirst: string; street: string; shotOn: Date; missing: Missing; unreachable?: string | null; again?: boolean }) => string;
      },
      shootDay: (await import(base.shootDay)) as { composeShootDayText: (o: { street: string; startAt: Date; requests: string[]; link: string }) => string },
      gaps: (await import(base.gaps)) as { composeGapText: (o: Parameters<typeof gaps.composeGapText>[0]) => string },
      delivery: (await import(base.delivery)) as {
        confirmationMessage: (p: Parameters<typeof delivery.confirmationMessage>[0], template?: string) => string;
        deliveryMessage: (p: Parameters<typeof delivery.deliveryMessage>[0], templates?: { deliveryAll?: string; deliveryPartial?: string }) => string;
        applyTemplate: (tpl: string, vars: Record<string, string>) => string;
      },
    };
    const covered = new Set<string>();
    const same = (key: string, label: string, before: string, after: string) => {
      covered.add(key);
      c.ok(`${key}: ${label}`, before === after, before === after ? "" : `\n      before: ${JSON.stringify(before)}\n      after:  ${JSON.stringify(after)}`);
    };
    const D = TT.DEFAULT_TEXTS;

    // =========================================================================
    c.head("1 · every default renders exactly what the code sent before");
    // =========================================================================
    {
      // ---- the registry itself ---------------------------------------------
      const keys = TT.TEXT_TEMPLATE_KEYS;
      c.ok(`${keys.length} templates, every key unique, every one with a label, a 'when' sentence and a sender`, keys.length >= 25 && keys.every((k) => TT.TEXT_TEMPLATES[k].label && TT.TEXT_TEMPLATES[k].when.endsWith(".") && TT.TEXT_TEMPLATES[k].sender));
      const unfilled = keys.filter((k) => /\{[A-Za-z0-9_]+\}/.test(TT.previewTemplate(k, TT.TEXT_TEMPLATES[k].body)));
      c.ok("every default fills every placeholder it has with the sample values", unfilled.length === 0, unfilled.join(","));
      const badDefaults = keys.filter((k) => !TT.checkTemplateBody(k, TT.TEXT_TEMPLATES[k].body).ok);
      c.ok("every default passes its own checks (required kept, nothing unknown, no long dash or Dropbox to a client)", badDefaults.length === 0, badDefaults.join(","));
      // Oct 22 2026: the part-delivered text keeps the old box's {delivered}/{remaining}/{street} too.
      const declared = keys.filter((k) => TT.TEXT_TEMPLATES[k].placeholders.some((p) => !TT.TEXT_TEMPLATES[k].body.includes(`{${p.name}}`)) && !["client_confirmation", "client_delivery_partial"].includes(k));
      c.ok("every declared placeholder is used by its default (the confirmation's and the part-delivered text's old-box placeholders excepted)", declared.length === 0, declared.join(","));
      c.ok("lib/settings' default names are the registry's words", S.DEFAULT_WELCOME_TEXT === TT.TEXT_TEMPLATES.client_welcome.body && S.DEFAULT_AFTER_HOURS_REPLY === TT.TEXT_TEMPLATES.client_after_hours.body && S.DEFAULT_DELIVERY_FEEDBACK_TEXT === TT.TEXT_TEMPLATES.client_delivery_feedback.body && S.DEFAULT_WELCOME.message === S.DEFAULT_WELCOME_TEXT && S.DEFAULT_AUTO_TEXTS.afterHours.message === S.DEFAULT_AFTER_HOURS_REPLY);
      // Oct 22 2026: + the two part-delivered shapes a Send button sends.
      c.ok("the six client texts are the only client audience; all others are team", keys.filter((k) => TT.TEXT_TEMPLATES[k].audience === "client").join() === "client_welcome,client_confirmation,client_delivery_feedback,client_delivery_partial,client_delivery_update,client_after_hours");

      // ---- uploads ------------------------------------------------------------
      for (const streets of [["123 Main St"], ["123 Main St", "45 Oak Ave", "9 Elm Rd"]]) {
        same("upload_digest", `${streets.length} shoot(s)`, OLD.digest.digestText("Harrison", streets), digest.digestText("Harrison", streets));
      }
      const one = [{ street: "123 Main St", url: `${APP}/upload/p1` }];
      const two = [...one, { street: "45 Oak Ave", url: `${APP}/upload/p2` }];
      for (const [label, s, split] of [
        ["one page", ["123 Main St"], []], ["two pages", ["123 Main St", "45 Oak Ave"], []], ["one video only", [], one],
        ["several videos only", [], two], ["a page and a video", ["9 Elm Rd"], one], ["pages and videos", ["9 Elm Rd", "1 Pine Ct"], two],
      ] as const) {
        // Oct 22 2026 (comms audit, LOW): the one sentence changed on purpose:
        // pay is fixed and hidden from the team, so no payroll words.
        const before = OLD.digest.nagText("Harrison", [...s], [...split]).replace(
          "Finish tonight — files in Dropbox + the page submitted. The shoot is added to your payroll when you submit:",
          "Please finish tonight: files in Dropbox, then submit the page here:",
        );
        const after = digest.nagText("Harrison", [...s], [...split]);
        for (const k of ["upload_chaser_greeting", ...(s.length ? ["upload_chaser_shoots"] : []), ...(split.length === 1 ? ["upload_chaser_video_one"] : split.length > 1 ? ["upload_chaser_video_many"] : [])]) covered.add(k);
        same("upload_chaser", label, before, after);
      }
      const day = new Date("2026-10-20T14:00:00Z");
      const asks: { missing: Missing; again: boolean; unreachable: string | null }[] = [
        { missing: { video: ["the shot order"], photos: [] }, again: false, unreachable: null },
        { missing: { video: [], photos: ["the cull confirmation", "the removal notes"] }, again: true, unreachable: "no phone on file" },
        { missing: { video: ["the agent's intro script, as delivered on camera", "the music pick"], photos: ["the cull confirmation"] }, again: true, unreachable: null },
      ];
      for (const a of asks) {
        const o = { firstName: "Harrison", street: "123 Main St", shotOn: day, missing: a.missing, link: `${APP}/upload/p1`, again: a.again };
        same("instructions_missing_photographer", `again=${a.again}, ${a.missing.video.length ? "video" : "photos"}`, OLD.missing.composeNudgeText(o), missing.composeNudgeText(o));
        const m = { photographerFirst: "Harrison", street: "123 Main St", shotOn: day, missing: a.missing, unreachable: a.unreachable, again: a.again };
        same("instructions_missing_manager", `again=${a.again}, unreachable=${!!a.unreachable}`, OLD.missing.composeManagerLine(m), missing.composeManagerLine(m));
      }
      for (const requests of [["Shoot the backyard at golden hour."], ["Skip the basement.", "Client: Get the new deck — it is finished.", "Seller present: yes."]]) {
        const o = { street: "104 Carlton Ct", startAt: new Date("2026-10-21T18:30:00Z"), requests, link: `${APP}/shoot/p1` };
        same("shoot_day_requests", `${requests.length} request(s)`, OLD.shootDay.composeShootDayText(o), shootDay.composeShootDayText(o));
      }
      {
        // Oct 23 2026: new with its template (no older code to compare), so it is held to the words Jordan approved.
        const sst = await import("@/lib/sessionScriptsText");
        const o = { name: "Harrison Wells", client: "John Collins", startAt: new Date("2026-10-23T17:30:00Z"), street: "80 W Lancaster Ave", link: `${APP}/shoot/p1` };
        same("session_scripts", "John's session", `⚙️ Realtour Hub: Hi Harrison, John's content session is today at 1:30 PM at 80 W Lancaster Ave. The scripts are on your shoot page: ${APP}/shoot/p1`, sst.composeSessionScriptsText(o));
      }
      const counts = { groundPhotos: 0, dronePhotos: 45, droneClips: 4, footage: 0, newestAt: null };
      for (const [sure, alsoEmpty] of [[["ground_photos"], []], [["ground_photos", "drone"], ["footage"]], [["footage"], ["ground_photos", "drone"]]] as const) {
        const o = { firstName: "Harrison", street: "123 Main St", shotWhen: "yesterday", counts, sure: [...sure], alsoEmpty: [...alsoEmpty], link: `${APP}/upload/p1` };
        same("upload_gap", `missing ${sure.length}, also ${alsoEmpty.length}`, OLD.gaps.composeGapText(o), gaps.composeGapText(o));
      }

      // ---- the client texts (delivery.ts) ------------------------------------
      const deliverables = (types: string[]) => types.map((type) => ({ type, waivedAt: null }));
      const confirmJobs = [
        { label: "street, three items", p: { title: "123 Main St, Emmaus, PA", city: "Emmaus", shootDate: new Date("2026-10-23T14:00:00Z"), client: { name: "Sarah Agent" }, deliverables: deliverables(["PHOTOS", "DRONE", "FLOORPLAN"]) } },
        { label: "pin-only with a town, one item", p: { title: "[No address provided], 39.95,-75.60", city: "West Chester", shootDate: new Date("2026-10-23T14:00:00Z"), client: { name: "" }, deliverables: deliverables(["PHOTOS"]) } },
        { label: "nothing at all, two items, one waived", p: { title: "", city: null, shootDate: new Date("2026-10-24T17:30:00Z"), client: { name: "Sam" }, deliverables: [...deliverables(["VIDEO", "SOCIAL_REEL"]), { type: "DRONE", waivedAt: new Date() }] } },
        { label: "no items", p: { title: "9 Elm Rd, X", shootDate: new Date("2026-10-24T17:30:00Z"), client: { name: "Sam B" }, deliverables: [] } },
        { label: "no date (the per-card draft)", p: { title: "9 Elm Rd, X", shootDate: null, client: { name: "Sam B" }, deliverables: deliverables(["PHOTOS"]) } },
      ];
      for (const j of confirmJobs) {
        same("client_confirmation", `${j.label}: default (the sweep, and the per-card Send)`, OLD.delivery.confirmationMessage(j.p), delivery.confirmationMessage(j.p, D));
        same("client_confirmation", `${j.label}: no set at all`, OLD.delivery.confirmationMessage(j.p), delivery.confirmationMessage(j.p));
      }
      const oldBoxConfirm = "Hi {first}, see you {when} at {street} for {items}. Typo stays: {frist}";
      for (const j of confirmJobs) {
        same("client_confirmation", `${j.label}: the old Text wording box's words`, OLD.delivery.confirmationMessage(j.p, oldBoxConfirm), delivery.confirmationMessage(j.p, TT.templateSet({ client_confirmation: { body: oldBoxConfirm, legacy: true } })));
      }
      const ev = (present: string[], missingCats: string[] = []) => JSON.stringify({ expected: [...present, ...missingCats], present, missing: missingCats, awaitingSend: [] });
      const deliveryJobs = [
        { label: "a street", p: { id: "p1", title: "123 Main St, Emmaus, PA", city: "Emmaus", statusEvidence: ev(["Photos", "Video"]), client: { name: "Sarah Agent" } } },
        { label: "a town only", p: { id: "p2", title: "[No address provided]", city: "West Chester", statusEvidence: ev(["Photos"]), client: { name: "Sarah" } } },
        { label: "nothing", p: { id: "p3", title: "", city: null, statusEvidence: ev(["Photos"]), client: { name: "" } } },
      ];
      const DEF_FEEDBACK = S.DEFAULT_DELIVERY_FEEDBACK_TEXT;
      for (const j of deliveryJobs) {
        // The sweep before: deliveryMessage(project, { ...tpl, deliveryAll: tpl.deliveryAll.trim() || DEFAULT_DELIVERY_FEEDBACK_TEXT }).
        same("client_delivery_feedback", `${j.label}: default (the sweep)`, OLD.delivery.deliveryMessage(j.p, { deliveryAll: DEF_FEEDBACK, deliveryPartial: "" }), delivery.deliveryMessage(j.p, { deliveryPartial: "" }, D));
        const box = "Thanks {first}! {street} is done. Tell us: {feedbackUrl}";
        same("client_delivery_feedback", `${j.label}: the old Text wording box's words`, OLD.delivery.deliveryMessage(j.p, { deliveryAll: box, deliveryPartial: "" }), delivery.deliveryMessage(j.p, { deliveryPartial: "" }, TT.templateSet({ client_delivery_feedback: { body: box, legacy: true } })));
        // Oct 22 2026 (on purpose): with no set (the per-card Send's old call) the
        // everything-delivered text is the feedback ask, not the older
        // "Everything … has been delivered" announcement.
        same("client_delivery_feedback", `${j.label}: no set at all is the feedback ask (the old announcement retired)`, OLD.delivery.deliveryMessage(j.p, { deliveryAll: DEF_FEEDBACK, deliveryPartial: "" }), delivery.deliveryMessage(j.p));
        c.ok(`${j.label}: …and never the announcement`, !/has been delivered\. How did we do\?/.test(delivery.deliveryMessage(j.p)));
      }
      // The part-delivered shapes (Oct 22 2026: templates, defaults = the old words).
      const evOwed = (present: string[], owedCats: string[], awaitingSend: string[] = []) =>
        JSON.stringify({ expected: [...present, ...owedCats], present: [...present, ...awaitingSend], missing: owedCats.filter((x) => !awaitingSend.includes(x)), awaitingSend });
      const partials = [
        { label: "photos out, video never made, a street", p: { id: "p4", title: "5 Oak Ave, X", city: null, statusEvidence: evOwed(["Photos"], ["Video"]), client: { name: "Gary" } } },
        { label: "photos + drone out, video finished not sent, a town", p: { id: "p5", title: "[No address provided]", city: "West Chester", statusEvidence: evOwed(["Photos", "Drone"], ["Video"], ["Video"]), client: { name: "Gary Smith" } } },
        { label: "photos out, floor plan owed, nothing at all", p: { id: "p6", title: "", city: null, statusEvidence: evOwed(["Photos"], ["Floor Plan"]), client: { name: "" } } },
        { label: "photos out, 3 of 4 videos finished not sent (counted)", p: { id: "p10", title: "626 Greycliffe Ln, X", city: null, statusEvidence: JSON.stringify({ ...JSON.parse(evOwed(["Photos"], ["Video"], ["Video"])), aryeo: { videos: 1 }, units: [{ category: "Video", owed: 4, outstanding: 3, onListing: 1 }] }), client: { name: "Gary" } } },
      ];
      const updates = [
        { label: "nothing out, video never made", p: { id: "p7", title: "9 Elm Rd, X", city: null, statusEvidence: evOwed([], ["Video"]), client: { name: "Sam" } } },
        { label: "nothing out, video finished not sent, a town", p: { id: "p8", title: "", city: "Emmaus", statusEvidence: evOwed([], ["Video"], ["Video"]), client: { name: "Sam B" } } },
        { label: "nothing out, nothing at all", p: { id: "p9", title: "", city: null, statusEvidence: evOwed([], ["Photos", "Video"]), client: { name: "" } } },
      ];
      const partBox = "Hi {first}, {delivered} out, {remaining} coming for {street}: {feedbackUrl}";
      for (const j of partials) {
        same("client_delivery_partial", `${j.label}: default`, OLD.delivery.deliveryMessage(j.p), delivery.deliveryMessage(j.p, undefined, D));
        same("client_delivery_partial", `${j.label}: no set at all`, OLD.delivery.deliveryMessage(j.p), delivery.deliveryMessage(j.p));
        same("client_delivery_partial", `${j.label}: the old box's words through the store (legacy)`, OLD.delivery.deliveryMessage(j.p, { deliveryPartial: partBox }), delivery.deliveryMessage(j.p, undefined, TT.templateSet({ client_delivery_partial: { body: partBox, legacy: true } })));
        same("client_delivery_partial", `${j.label}: the old box handed in without a set`, OLD.delivery.deliveryMessage(j.p, { deliveryPartial: partBox }), delivery.deliveryMessage(j.p, { deliveryPartial: partBox }));
        c.ok(`${j.label}: the sweep's own call (box + set) is the set's words, not applied twice`, delivery.deliveryMessage(j.p, { deliveryPartial: partBox }, TT.templateSet({ client_delivery_partial: { body: partBox, legacy: true } })) === OLD.delivery.deliveryMessage(j.p, { deliveryPartial: partBox }));
      }
      for (const j of updates) {
        same("client_delivery_update", `${j.label}: default`, OLD.delivery.deliveryMessage(j.p), delivery.deliveryMessage(j.p, undefined, D));
        same("client_delivery_update", `${j.label}: the old partial box never reaches it`, OLD.delivery.deliveryMessage(j.p, { deliveryPartial: partBox }), delivery.deliveryMessage(j.p, undefined, TT.templateSet({ client_delivery_partial: { body: partBox, legacy: true } })));
      }
      const welcomeVars = { first: "Morgan", strategyCallLink: S.GENERAL_STRATEGY_CALL_BOOKING_URL, website: S.PUBLIC_WEBSITE, portal: "media.realtourpilot.com" };
      same("client_welcome", "default", OLD.delivery.applyTemplate(S.DEFAULT_WELCOME_TEXT, welcomeVars), D.render("client_welcome", welcomeVars));
      const welcomeBox = "Hello {first}!\nCall: {strategyCallLink}\nPortal: {portal} {unknown}";
      same("client_welcome", "the old Automated texts box's words", OLD.delivery.applyTemplate(welcomeBox, welcomeVars), TT.templateSet({ client_welcome: { body: welcomeBox, legacy: true } }).render("client_welcome", welcomeVars));
      const ahVars = { first: "there", hours: "Monday to Friday, 9am to 6pm", nextDay: "Monday morning", portal: "media.realtourpilot.com" };
      same("client_after_hours", "default", OLD.delivery.applyTemplate(S.DEFAULT_AFTER_HOURS_REPLY, ahVars), D.render("client_after_hours", ahVars));
      // The capture feedback text (src/app/projects/reviewActions.ts shareShootFeedback, Oct 22 2026): the old literal, verbatim.
      for (const [name, author, title] of [["Harrison Wells", "Jordan", "238 Hudson Dr, Malvern, PA"], ["", "James", ""], [null, "Jordan", "9 Elm Rd"]] as const) {
        const member = { name }, projectId = "p1", base = APP;
        const street = title.split(",")[0].trim();
        const before = `Hey ${member.name?.split(/\s+/)[0] ?? "there"} — ${author} left some feedback on your shoot for ${street}. Check it out here: ${base}/shoot/${projectId}`;
        same("shoot_feedback_shared", `name=${JSON.stringify(name)}, street=${JSON.stringify(street)}`, before, D.render("shoot_feedback_shared", { firstName: member.name?.split(/\s+/)[0] ?? "there", author, street, link: `${base}/shoot/${projectId}` }));
      }

      // ---- the inline senders, their old literals copied verbatim ---------------
      for (const [total, jobs] of [[1234.5, 12], [95, 1]] as const) {
        const period = { startKey: "2026-10-01", endKey: "2026-10-15" };
        const before = `💰 Payday: $${total.toFixed(2)} lands today (${jobs} shoot${jobs === 1 ? "" : "s"} + mileage, ${period.startKey.slice(5)}–${period.endKey.slice(5)}). Details: ${APP}/my-pay`;
        same("payday", `${jobs} shoot(s)`, before, paydayText({ total, jobs, ...period, link: `${APP}/my-pay` }));
      }
      for (const [name, body] of [["Sarah Agent", "Can we   swap\nThursday to Friday?"], ["", "x".repeat(400)]] as const) {
        const link = `${APP}/content/e1?tab=messages`;
        const before = `New portal message from ${name || "a program client"}: “${clip(body.replace(/\s+/g, " "), 160)}” Reply here: ${link}`;
        same("portal_message_team", name ? "named client" : "no name, long message", before, portalMessageLine({ clientName: name, body, link }));
      }
      for (const note of ["The dog is out back — keep the gate shut. Paid $250 for staging.", "Short."]) {
        const shoot = new Date("2026-10-22T13:00:00Z");
        const before = noDashes(scrubMoney(`Note from the client for 123 Main St (${etDateTime(shoot)}): "${clip(note, 300)}". It is on your shoot screen: ${APP}/shoot/p1`));
        same("shoot_note", note.length > 10 ? "dash and amount cleaned" : "short", before, shootNoteText({ street: "123 Main St", when: etDateTime(shoot), note: clip(note, 300), link: `${APP}/shoot/p1` }));
      }
      for (const [count, what, promise] of [[3, "123 Main St", "Promised photos by Wed — $400 job."], [4, "their videos", "No job matched these messages: find the job and its promise before replying."]] as const) {
        const before = noDashes(scrubMoney(`Sarah Agent has asked for an update ${count} times in ${CHASE_WINDOW_DAYS} days (${what}). ${promise} Kyle has a HIGH task for it: ${APP}/tasks?task=t1`));
        same("chase_owner", `${count} chases`, before, chaseOwnerText({ clientName: "Sarah Agent", count, what, promise, link: `${APP}/tasks?task=t1` }));
      }
      for (const n of [1, 4, 6]) {
        const fresh = Array.from({ length: n }, (_, i) => ({ street: `${i + 1} Main St`, who: `Client ${i}`, hoursLate: 30 + i * 24 }));
        const lines = fresh.slice(0, 4).map((l) => `${l.street} (${l.who}) — shot ${Math.round(l.hoursLate / 24)}d ago`);
        const more = fresh.length > 4 ? ` +${fresh.length - 4} more` : "";
        const before = `${fresh.length} job${fresh.length === 1 ? "" : "s"} shot and photos still not delivered on Aryeo:\n${lines.join("\n")}${more}`;
        same("photos_undelivered", `${n} job(s)`, before, photosUndeliveredText(fresh));
      }
      for (const [how, dueAt] of [["New on", new Date("2026-10-23T14:00:00Z")], ["Back on", null]] as const) {
        const due = dueAt ? ` · due ${etDateTime(dueAt)} ET` : "";
        // The old literal's `input.priority === "URGENT" ? " (URGENT)" : ""`: only an URGENT task ever reached it.
        const before = `📋 ${how} your list (URGENT): Scripts not approved: Sarah${due}. ${APP}/tasks?tab=other&task=t9`;
        same("desk_task_ping", `${how}, due ${dueAt ? "set" : "none"}`, before, deskTaskPingText({ how, title: "Scripts not approved: Sarah", dueAt, link: `${APP}/tasks?tab=other&task=t9` }));
      }
      const crossed = [{ street: "123 Main St", round: 2, href: "/review/p1?cut=c1", hours: 18 }, { street: "45 Oak Ave", round: 1, href: "/review/p2?cut=c2", hours: 20 }];
      for (const list of [crossed.slice(0, 1), crossed]) {
        const [first] = list;
        const before = list.length === 1
          ? `Video still waiting on review past the backup window: ${first.street} (v${first.round}), ${first.hours} covered hours. ${APP}${first.href}`
          : `${list.length} videos still waiting on review past the backup window, oldest ${first.street} (v${first.round}). ${APP}/review`;
        covered.add(list.length === 1 ? "review_escalation_one" : "review_escalation_many");
        same(list.length === 1 ? "review_escalation_one" : "review_escalation_many", `${list.length} cut(s)`, before, reviewEscalationText(list, APP));
      }
      {
        const w = { clientName: "Sarah Agent" }, subject = "A very long subject line that goes on and on past the seventy character cap for sure";
        const before = `📧 Still no reply: ${w.clientName}'s email "${subject.slice(0, 70)}" has waited 6h 30m of business hours. ${APP}/tasks?tab=other&task=t3`;
        same("email_followup", "the escalation", before, D.render("email_followup", { clientName: w.clientName, subject: subject.slice(0, 70), age: "6h 30m", link: `${APP}/tasks?tab=other&task=t3` }));
      }
      for (const isVip of [true, false]) {
        const vipTag = isVip ? " (VIP)" : "";
        const w = { clientName: "Sarah Agent", snippet: "Where are my photos?" }, age = "2h 15m";
        same("on_call_unhappy", `vip=${isVip}`, `Unhappy client unanswered${vipTag} — ${w.clientName}, ${age}: "${w.snippet}"`, onCallPageText("on_call_unhappy", { isVip, ...w, age }));
        same("on_call_still", `vip=${isVip}`, `Client still unanswered${vipTag} — ${w.clientName}, ${age}: "${w.snippet}"`, onCallPageText("on_call_still", { isVip, ...w, age }));
      }
      for (const [author, notes] of [["James", 3], [null, 1]] as const) {
        const s = notes === 1 ? "" : "s", round = 2, editHref = "/edit/p1";
        const before = `↩︎ Relay to Luma Visuals: ${author ?? "The review desk"} sent back 123 Main St (version ${round}) with ${notes} note${s}. They're on the edit card as round ${round + 1} — ${APP}${editHref}`;
        same("review_relay", `${notes} note(s)`, before, D.render("review_relay", { editor: "Luma Visuals", reviewer: author ?? "The review desk", street: "123 Main St", round: String(round), notes: `${notes} note${s}`, nextRound: String(round + 1), link: `${APP}${editHref}` }));
      }
      const uncovered = TT.TEXT_TEMPLATE_KEYS.filter((k) => !covered.has(k));
      c.ok("every registered template was compared with the old code", uncovered.length === 0, uncovered.join(","));
    }

    // =========================================================================
    c.head("2 · a saved wording is used (store, set, and a real sender)");
    // =========================================================================
    const owner = await prisma.appUser.create({ data: { email: "jordan@tt.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "kyle@tt.invalid", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await signIn(owner);
    {
      const fresh = await store.loadTextTemplates();
      c.ok("with nothing saved, every template sends its default", TT.TEXT_TEMPLATE_KEYS.every((k) => fresh.sourceOf(k) === "default"));
      const mine = "Hey {firstName}! Tonight:\n{shootList}\nWrap up here: {uploadLink}";
      const r = await actions.saveTextTemplateAction("upload_digest", mine);
      c.ok("the owner saves a wording", r.ok && r.row?.source === "saved" && r.row.saved?.body === mine && r.row.saved?.by === "Jordan Spackman", JSON.stringify(r));
      const row = await prisma.appSetting.findUnique({ where: { key: "text_template:upload_digest" } });
      c.ok("…stored as one AppSetting row, text_template:<key>, with who", !!row && JSON.parse(row.value).body === mine && row.updatedBy === "jordan@tt.invalid");
      const set = await store.loadTextTemplates();
      c.ok("…and the set renders it (the cache was cleared by the save)", set.sourceOf("upload_digest") === "saved" && digest.digestText("Harrison", ["123 Main St"], set) === `Hey Harrison! Tonight:\n1. 123 Main St\nWrap up here: ${APP}/upload`);
      c.ok("…while every other template stays on its default", TT.TEXT_TEMPLATE_KEYS.filter((k) => k !== "upload_digest").every((k) => set.sourceOf(k) === "default"));

      // The real sender: the 7 PM upload list, OpenPhone recorded.
      const client = await prisma.client.create({ data: { name: "TT Client" } });
      const harrison = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison@tt.invalid", role: "PHOTOGRAPHER", phone: "6105550142", active: true } });
      await prisma.project.create({ data: { title: "123 Main St, Emmaus, PA", clientId: client.id, status: "SCHEDULED", shootDate: new Date(), photographerId: harrison.id } });
      texts.length = 0;
      const sent = await digest.sendEveningUploadDigests();
      c.ok("sendEveningUploadDigests sends the saved wording, to the same number", sent.sent === 1 && texts.length === 1 && texts[0].to === "+16105550142" && texts[0].text === `Hey Harrison! Tonight:\n1. 123 Main St\nWrap up here: ${APP}/upload`, JSON.stringify({ sent, texts }));
      const logged = await prisma.commLog.findFirst({ where: { source: "upload-digest" }, select: { body: true } });
      c.ok("…and logs the same body it sent, under the same source", logged?.body === texts[0]?.text);
    }

    // =========================================================================
    c.head("3 · refused at save, ignored at send");
    // =========================================================================
    {
      const noLink = await actions.saveTextTemplateAction("upload_digest", "Hey {firstName}! Tonight:\n{shootList}");
      c.ok("a wording without a required placeholder ({uploadLink}) is refused, with the reason", !noLink.ok && !!noLink.problems?.some((p) => p.includes("{uploadLink}")), JSON.stringify(noLink));
      const unknown = await actions.saveTextTemplateAction("payday", "Payday {amount} for {nickname}! {link}");
      c.ok("an unknown placeholder is refused, by name", !unknown.ok && !!unknown.problems?.some((p) => p.includes("{nickname}")), JSON.stringify(unknown));
      const brace = await actions.saveTextTemplateAction("payday", "Payday {amount} {link} {oops");
      c.ok("a stray brace is refused", !brace.ok && !!brace.problems?.some((p) => p.includes("{ or }")));
      const dash = await actions.saveTextTemplateAction("client_welcome", "Hey {first} — welcome! Portal: {portal}");
      c.ok("a client text with a long dash is refused", !dash.ok && !!dash.problems?.some((p) => p.includes("long dash")));
      const enDash = TT.checkTemplateBody("client_after_hours", "Hours 9–6, back {nextDay}");
      c.ok("…an en dash too", !enDash.ok);
      const box = await actions.saveTextTemplateAction("client_delivery_feedback", "Hi {first}! Grab them at https://www.dropbox.com/s/x and tell us: {feedbackUrl}");
      c.ok("a client text with a Dropbox link is refused", !box.ok && !!box.problems?.some((p) => p.includes("Dropbox")));
      const teamDash = await actions.saveTextTemplateAction("upload_chaser_shoots", "Still waiting on today's upload {pages} — please:\n{shootList}\n{uploadLink}");
      c.ok("a team text keeps its long dash", teamDash.ok, JSON.stringify(teamDash));
      const kept = await prisma.appSetting.findUnique({ where: { key: "text_template:upload_digest" } });
      c.ok("the refusals wrote nothing (the earlier upload_digest wording still stands, payday and the client texts have no row)", JSON.parse(kept!.value).body.startsWith("Hey {firstName}! Tonight:\n{shootList}\nWrap") && (await prisma.appSetting.count({ where: { key: { in: ["text_template:payday", "text_template:client_welcome", "text_template:client_delivery_feedback"] } } })) === 0);

      // A row that fails the checks (written behind the card's back, or by a
      // rule that tightened since): never sent, the default goes, and it says so.
      await prisma.appSetting.create({ data: { key: "text_template:shoot_day_requests", value: JSON.stringify({ body: "{street} at {time}: {requestList}", by: "someone" }), updatedBy: "x@tt.invalid" } });
      await prisma.appSetting.create({ data: { key: "text_template:payday", value: JSON.stringify({ body: "Payday {amount} {bogus}", by: "someone" }), updatedBy: "x@tt.invalid" } });
      store.forgetTextTemplateCache();
      const warns: string[] = [];
      const realWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      const set = await store.loadTextTemplates();
      console.warn = realWarn;
      const o = { street: "104 Carlton Ct", startAt: new Date("2026-10-21T18:30:00Z"), requests: ["Skip the basement."], link: `${APP}/shoot/p1` };
      c.ok("a saved wording missing a required placeholder ({link}) is ignored at send: the default goes", set.sourceOf("shoot_day_requests") === "default" && shootDay.composeShootDayText(o, set) === OLD.shootDay.composeShootDayText(o));
      c.ok("…and one with an unknown placeholder too", set.sourceOf("payday") === "default" && paydayText({ total: 10, jobs: 1, startKey: "2026-10-01", endKey: "2026-10-15", link: "L" }, set) === paydayText({ total: 10, jobs: 1, startKey: "2026-10-01", endKey: "2026-10-15", link: "L" }));
      c.ok("…and each is logged", warns.some((w) => w.includes("shoot_day_requests") && w.includes("{link}")) && warns.some((w) => w.includes("payday") && w.includes("{bogus}")), warns.join(" | "));
      const rows = await store.textTemplateRows();
      const sd = rows.find((r) => r.key === "shoot_day_requests");
      c.ok("…and the card says why (its row: default in use, the problems listed)", sd?.source === "default" && !!sd.savedProblems?.some((p) => p.includes("{link}")) && sd.saved?.body === "{street} at {time}: {requestList}");
      await prisma.appSetting.deleteMany({ where: { key: { in: ["text_template:shoot_day_requests", "text_template:payday"] } } });
      store.forgetTextTemplateCache();
    }

    // =========================================================================
    c.head("4 · reset, the old boxes, and the rules save");
    // =========================================================================
    {
      const r = await actions.resetTextTemplateAction("upload_digest");
      c.ok("Reset removes the saved wording", r.ok && r.row?.source === "default" && !r.row.saved && (await prisma.appSetting.count({ where: { key: "text_template:upload_digest" } })) === 0);
      const set = await store.loadTextTemplates();
      c.ok("…and the default is back, word for word", set.sourceOf("upload_digest") === "default" && digest.digestText("Harrison", ["123 Main St"], set) === OLD.digest.digestText("Harrison", ["123 Main St"]));
      const asDefault = await actions.saveTextTemplateAction("payday", TT.TEXT_TEMPLATES.payday.body);
      c.ok("saving the default word for word is a reset (no row)", asDefault.ok && (await prisma.appSetting.count({ where: { key: "text_template:payday" } })) === 0);

      // The old boxes: what they hold keeps going out until saved or reset here.
      await S.putSetting("text_templates", { confirmation: "Hi {first}, see you {when} at {street}.", deliveryAll: "Thanks {first}: {feedbackUrl}", deliveryPartial: "keep me {delivered}" }, "old@tt.invalid");
      await S.putSetting("auto_texts", { enabled: true, sendFromHour: 9, sendUntilHour: 16, welcome: { enabled: true, strategyCallUrl: "https://example.test/call", message: "Welcome {first}! Portal: {portal}" }, afterHours: { ...S.DEFAULT_AUTO_TEXTS.afterHours, message: "Closed, {first}. Back {nextDay}." } }, "old@tt.invalid");
      let legacy = await store.loadTextTemplates();
      c.ok("the old boxes' wording is what goes out (confirmation, delivery feedback, welcome, after hours)", (["client_confirmation", "client_delivery_feedback", "client_welcome", "client_after_hours"] as const).every((k) => legacy.sourceOf(k) === "legacy"));
      const job = { title: "123 Main St, Emmaus", shootDate: new Date("2026-10-23T14:00:00Z"), client: { name: "Sarah Agent" }, deliverables: [] };
      c.ok("…exactly as the sweep sent it before", delivery.confirmationMessage(job, legacy) === OLD.delivery.confirmationMessage(job, "Hi {first}, see you {when} at {street}."));
      const rows = await store.textTemplateRows();
      c.ok("…and the card names where it came from", rows.find((x) => x.key === "client_welcome")?.legacy?.where === "the old box under Automated texts" && rows.find((x) => x.key === "client_confirmation")?.legacy?.where === "the old Text wording box");

      const saved = await actions.saveTextTemplateAction("client_confirmation", "Hi {first}! See you {when} {atPlace}. Reply with anything we should know.");
      const tt = JSON.parse((await prisma.appSetting.findUnique({ where: { key: "text_templates" } }))!.value);
      legacy = await store.loadTextTemplates();
      c.ok("saving here wins over the old box and empties only that field", saved.ok && legacy.sourceOf("client_confirmation") === "saved" && tt.confirmation === "" && tt.deliveryAll === "Thanks {first}: {feedbackUrl}" && tt.deliveryPartial === "keep me {delivered}", JSON.stringify(tt));
      c.ok("…and the sweep's text is the new wording", delivery.confirmationMessage(job, legacy) === "Hi Sarah! See you Friday, Oct 23, 10:00 AM at 123 Main St. Reply with anything we should know.", delivery.confirmationMessage(job, legacy));

      const reset = await actions.resetTextTemplateAction("client_welcome");
      const at = JSON.parse((await prisma.appSetting.findUnique({ where: { key: "auto_texts" } }))!.value);
      legacy = await store.loadTextTemplates();
      c.ok("Reset on an old-box text empties that box and keeps the rest of the rules (the booking link, the after-hours words)", reset.ok && at.welcome.message === "" && at.welcome.strategyCallUrl === "https://example.test/call" && at.welcome.enabled === true && at.afterHours.message === "Closed, {first}. Back {nextDay}." && legacy.sourceOf("client_welcome") === "default", JSON.stringify(at));
      c.ok("…and autoTextRules reads the default welcome again", (await S.autoTextRules()).welcome.message === S.DEFAULT_WELCOME_TEXT);

      // The Automated texts rules save no longer writes the wording (a page
      // loaded before the reset must not put the old words back).
      await signIn(admin);
      const { saveAutoTextRules } = await import("@/app/settings/actions");
      const rules = await S.autoTextRules();
      const res = await saveAutoTextRules({ ...rules, welcome: { ...rules.welcome, message: "STALE welcome from an old page" }, afterHours: { ...rules.afterHours, message: "STALE after hours" } });
      const after = JSON.parse((await prisma.appSetting.findUnique({ where: { key: "auto_texts" } }))!.value);
      c.ok("the Automated texts save carries the stored wording through untouched", res.ok && after.welcome.message === "" && after.afterHours.message === "Closed, {first}. Back {nextDay}." && after.welcome.strategyCallUrl === "https://example.test/call", JSON.stringify(after));
      await signIn(owner);
    }

    // =========================================================================
    c.head("5 · owner only, and the card");
    // =========================================================================
    {
      await signIn(admin);
      const before = await prisma.appSetting.count({ where: { key: { startsWith: "text_template:" } } });
      const save = await actions.saveTextTemplateAction("payday", "Paid {amount}!");
      const reset = await actions.resetTextTemplateAction("client_confirmation");
      c.ok("Kyle (ADMIN) is refused both Save and Reset, and nothing is written", !save.ok && !reset.ok && save.message === "You don't have access to do that." && (await prisma.appSetting.count({ where: { key: { startsWith: "text_template:" } } })) === before && (await store.loadTextTemplates()).sourceOf("client_confirmation") === "saved");
      await signIn(owner);
      const notOurs = await actions.saveTextTemplateAction("not_a_text", "hi");
      c.ok("a key the hub does not send is refused", !notOurs.ok);

      const { createElement } = await import("react");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { TextMessagesSettings } = await import("@/components/settings/TextMessagesSettings");
      const rows = await store.textTemplateRows();
      // What the page hands each viewer (page.tsx: templatesVisibleTo).
      const html = renderToStaticMarkup(createElement(TextMessagesSettings, { rows: TT.templatesVisibleTo(rows, true), isOwner: true }));
      const kyleHtml = renderToStaticMarkup(createElement(TextMessagesSettings, { rows: TT.templatesVisibleTo(rows, false), isOwner: false }));
      c.ok("the payday text (pay) is the owner's alone: listed for Jordan, never on Kyle's page, and no dollar figure in Kyle's card", html.includes('data-text-template="payday"') && !kyleHtml.includes('data-text-template="payday"') && !/\$\s?\d/.test(kyleHtml));
      const pageSrc = fs.readFileSync(path.join(REPO, "src/app/settings/page.tsx"), "utf8");
      c.ok("…and the settings page passes the card only templatesVisibleTo(rows, isOwner)", /templatesVisibleTo\(textRows, isOwner\)/.test(pageSrc) && /<TextMessagesSettings rows=\{textShown\}/.test(pageSrc));
      c.ok("the card groups To clients and To the team, one row per template", html.includes(">To clients") && html.includes(">To the team") && (html.match(/data-text-template="/g) ?? []).length === TT.TEXT_TEMPLATE_KEYS.length && (kyleHtml.match(/data-text-template="/g) ?? []).length === TT.TEXT_TEMPLATE_KEYS.length - 1);
      c.ok("each row: label, when, wording box, a chip per placeholder, a preview with sample values, a character count", html.includes("7 PM upload list") && html.includes(TT.TEXT_TEMPLATES.upload_digest.when.replace(/'/g, "&#x27;")) && html.includes('aria-label="Insert {uploadLink}: The upload page"') && html.includes("Preview with sample values") && /\d+ characters/.test(html));
      c.ok("past 160 characters the count says it goes as more than one text", html.includes("it goes as more than one text"));
      c.ok("an edited one says who and when; an old-box one says where from", html.includes("Last edited by Jordan Spackman on") && html.includes("saved earlier in the old Text wording box"));
      c.ok("the owner gets Save and Reset to default", html.includes(" Reset to default</button>") && html.includes("> Save</button>"));
      c.ok("Kyle reads it: no Save, no Reset, the boxes read-only, the chips disabled, and it says only Jordan changes them", !kyleHtml.includes("Reset to default") && !kyleHtml.includes("> Save<") && /<textarea[^>]*readOnly=""/.test(kyleHtml) && kyleHtml.includes("Only Jordan can change these"));
      const words = html.replace(/<[^>]+>/g, " ");
      c.ok("plain, gender-neutral copy on the card (no he/she/his/her)", !/\b(he|she|his|her|him)\b/i.test(words.replace(/the (?:office|team)/gi, "")));
    }

    c.ok("no call left the machine (OpenPhone recorded at the boundary)", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    fence.restore();
    c.summary();
    await stop();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

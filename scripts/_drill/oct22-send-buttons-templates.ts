// ---------------------------------------------------------------------------
// DRILL: THE SEND BUTTONS SEND THE TEMPLATES (Oct 22 2026). Jordan, on the
// Oct 21 builder's note that the per-card Send and "Send all" still used the
// built-in words: "yes I think, use your best judgement there."
//
//   cd "<repo>" && PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     node scripts/_drill/run-all.cjs scripts/_drill/oct22-send-buttons-templates.ts
//
// What it proves, through the REAL senders (the hourly sweeps, the per-card
// Send in app/actions.ts, Send all's list + send in app/tasks/sendAllActions.ts,
// the capture feedback button in app/projects/reviewActions.ts), with
// OpenPhone replaced on its module object and every text recorded:
//   1. NOTHING SAVED: for the same job, the per-card Send and Send all send
//      exactly the words the sweep sends (the confirmation with the town and
//      without a waived item, the delivery text as the feedback ask, never the
//      old "Everything … has been delivered" announcement). The part-delivered
//      and nothing-out-yet texts a button sends are byte-for-byte the old words.
//   2. A SAVED WORDING: the buttons send the edited words, and the sweep does
//      too. A draft box sends exactly what a person typed.
//   3. AN INVALID SAVED WORDING (a required placeholder gone, an unknown one):
//      the default goes from the buttons.
//   4. ONE IDENTITY: a hand send stops the sweep's duplicate (even with the
//      task reopened behind it), and the sweep's send stops both buttons'.
//   5. The capture feedback text is a template: default = the old literal,
//      a saved wording is used. Only the office can press the client buttons.
//
// ISOLATION: PGlite on 127.0.0.1:7342 (DRILL_PORT overrides) through the shared
// harness; production is never opened; every non-loopback call is fenced;
// OpenPhone's number read and send are replaced on the module object. AUTH_ENFORCE is on: real
// sessions, real guards.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DeliverableType } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7342);
const BASE = "10a1af3"; // the commit this change starts from: the buttons' old words
const REPO = path.resolve(__dirname, "../..");
const APP = "https://hub.drill.invalid";
const HOUR = 3_600_000;

installNextStubs();
const fence = fenceFetch();

const texts: { to: string; text: string }[] = [];

/** The old delivery.ts, from git, with "@/" pointed at today's src. */
function oldDelivery(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oct22-sb-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/delivery.ts`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, "delivery.base.ts");
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return file;
}

const c = makeChecker();

async function main() {
  process.env.NEXT_PUBLIC_APP_URL = APP;
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-send-buttons", NEXT_PUBLIC_APP_URL: APP } });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    // ---- OpenPhone, replaced on the shared module object (the senders reach it
    // through dynamic imports, which a loader hook does not see) -------------
    const OP = (await import("@/lib/integrations/openphone")).OpenPhone as unknown as Record<string, unknown>;
    OP.phoneNumbers = async () => [{ id: "PN-drill", number: "+15555550100" }];
    OP.sendMessage = async (_from: string, to: string | string[], text: string) => {
      texts.push({ to: String(to), text });
      const id = `msg-${texts.length}`;
      return { id, data: { id } };
    };
    const TT = await import("@/lib/textTemplates");
    const store = await import("@/lib/textTemplateStore");
    const delivery = await import("@/lib/delivery");
    const { setSession } = await import("@/lib/auth/session");
    const { sendConfirmationText, sendDeliveryText } = await import("@/app/actions");
    const { listDraftedTexts, sendDraftText } = await import("@/app/tasks/sendAllActions");
    const { sweepConfirmationTexts, sweepDeliveryTexts } = await import("@/lib/clientTextSweeps");
    const { shareShootFeedback } = await import("@/app/projects/reviewActions");
    const { confirmationKey, deliveryKey } = await import("@/lib/outbox");
    type OldDelivery = {
      confirmationMessage: (p: Parameters<typeof delivery.confirmationMessage>[0]) => string;
      deliveryMessage: (p: Parameters<typeof delivery.deliveryMessage>[0]) => string;
    };
    const OLD = (await import(oldDelivery())) as OldDelivery;
    const D = TT.DEFAULT_TEXTS;
    const say = (label: string, v: string) => console.log(`  ·    ${label}: ${v}`);

    // ---- people, rules ---------------------------------------------------------
    const owner = await prisma.appUser.create({ data: { email: "jordan@sb.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle@sb.invalid", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE" } });
    const shooter = await prisma.appUser.create({ data: { email: "harrison@sb.invalid", name: "Harrison Wells", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await signIn(kyle);
    // The send window wide open in the drill database only, so the drill is the same test at 9 PM or on a Sunday.
    await prisma.appSetting.create({ data: { key: "auto_texts", value: JSON.stringify({ enabled: true, sendFromHour: 0, sendUntilHour: 23, sendUntilMinute: 59, weekdaysOnly: false, onePerClientPerRun: false, skipWhenClientWaiting: true, confirmation: { enabled: true, hoursBefore: 48 }, delivery: { enabled: true, maxTaskAgeHours: 72, requireMonthlyBatch: true } }) } });

    // ---- fixtures ----------------------------------------------------------------
    let phone = 6105550100;
    const mkClient = async (name: string) => prisma.client.create({ data: { name, phone: String(++phone) } });
    const toOf = (cl: { phone: string | null }) => `+1${cl.phone}`;
    const sentTo = (cl: { phone: string | null }) => texts.filter((t) => t.to === toOf(cl)).map((t) => t.text);
    const shoot = new Date(Date.now() + 24 * HOUR);
    const confirmJob = async (name: string, title: string, city: string | null, types: DeliverableType[], waived: DeliverableType[] = []) => {
      const cl = await mkClient(name);
      const p = await prisma.project.create({ data: { title, city, clientId: cl.id, status: "SCHEDULED", shootDate: shoot } });
      for (const type of types) await prisma.deliverable.create({ data: { projectId: p.id, type } });
      for (const type of waived) await prisma.deliverable.create({ data: { projectId: p.id, type, waivedAt: new Date() } });
      const t = await prisma.smartTask.create({ data: { projectId: p.id, clientId: cl.id, taskType: "confirmation_text", title: `Send confirmation text — ${title}`, dueAt: new Date() } });
      return { cl, p, t };
    };
    const ev = (present: string[], missing: string[] = []) => JSON.stringify({ expected: [...present, ...missing], present, missing, awaitingSend: [], fulfilledOnAryeo: true });
    const deliveryJob = async (name: string, title: string, evidence: string, types: DeliverableType[] = ["PHOTOS"]) => {
      const cl = await mkClient(name);
      const p = await prisma.project.create({ data: { title, clientId: cl.id, status: "DELIVERED", deliveredAt: new Date(), statusEvidence: evidence } });
      for (const type of types) await prisma.deliverable.create({ data: { projectId: p.id, type } });
      const t = await prisma.smartTask.create({ data: { projectId: p.id, clientId: cl.id, taskType: "delivery_text", title: `Send delivery text — ${title}`, dueAt: new Date() } });
      return { cl, p, t };
    };
    const jobFields = async (id: string) => prisma.project.findUniqueOrThrow({ where: { id }, select: delivery.CLIENT_TEXT_JOB_SELECT });
    /** Put a job back to "never texted": the outbox row, the sweep's marker, the task open. */
    const unsend = async (j: { p: { id: string }; t: { id: string } }, kind: "confirmation" | "delivery") => {
      const key = kind === "confirmation" ? confirmationKey(j.p.id, shoot) : deliveryKey(j.p.id);
      await prisma.outboxMessage.deleteMany({ where: { dedupeKey: key } });
      await prisma.appSetting.deleteMany({ where: { key: { startsWith: kind === "confirmation" ? `auto-confirm-${j.p.id}` : `auto-delivery-${j.p.id}` } } });
      await prisma.smartTask.update({ where: { id: j.t.id }, data: { status: "OPEN", completedAt: null } });
    };
    const reopen = (j: { t: { id: string } }) => prisma.smartTask.update({ where: { id: j.t.id }, data: { status: "OPEN", completedAt: null } });
    const taskStatus = async (j: { t: { id: string } }) => (await prisma.smartTask.findUniqueOrThrow({ where: { id: j.t.id }, select: { status: true } })).status;
    const rowFor = async (taskId: string) => (await listDraftedTexts()).rows?.find((r) => r.taskId === taskId);

    // =========================================================================
    c.head("1 · nothing saved: the buttons send exactly what the sweep sends");
    // =========================================================================
    const c1 = await confirmJob("Sarah Agent", "123 Main St, Emmaus, PA", "Emmaus", ["PHOTOS", "DRONE", "FLOORPLAN"], ["TWILIGHT"]);
    const c2 = await confirmJob("Pat Pinonly", "[No address provided], 39.95,-75.60", "West Chester", ["VIDEO"]);
    const d1 = await deliveryJob("Gary Smith", "626 Greycliffe Ln, Emmaus, PA", ev(["Photos"]));
    const d2 = await deliveryJob("Dana Partial", "5 Oak Ave, Allentown, PA", ev(["Photos"], ["Video"]), ["PHOTOS", "VIDEO"]);
    const d3 = await deliveryJob("Nina Nothing", "9 Elm Rd, Bethlehem, PA", ev([], ["Video"]), ["VIDEO"]);
    {
      texts.length = 0;
      const sweep = await sweepConfirmationTexts();
      const s1 = sentTo(c1.cl)[0] ?? "", s2 = sentTo(c2.cl)[0] ?? "";
      c.ok("the confirmation sweep sent both jobs one text each", sweep.sent === 2 && sentTo(c1.cl).length === 1 && sentTo(c2.cl).length === 1, JSON.stringify(sweep));
      c.ok("…the sweep's words: the template default, with the town and without the waived item", s1 === delivery.confirmationMessage({ ...(await jobFields(c1.p.id)), client: { name: "Sarah Agent" } }, D) && s2.includes("in West Chester") && !/twilight/i.test(s1), `${s1} | ${s2}`);
      const oldCard1 = OLD.confirmationMessage({ title: c1.p.title, shootDate: shoot, client: { name: "Sarah Agent" }, deliverables: [{ type: "PHOTOS" }, { type: "DRONE" }, { type: "FLOORPLAN" }, { type: "TWILIGHT" }] });
      const oldCard2 = OLD.confirmationMessage({ title: c2.p.title, shootDate: shoot, client: { name: "Pat Pinonly" }, deliverables: [{ type: "VIDEO" }] });
      say("per-card before (waived item read out)", oldCard1);
      say("per-card before (no town)", oldCard2);

      await unsend(c1, "confirmation");
      await unsend(c2, "confirmation");
      const listed1 = await rowFor(c1.t.id), listed2 = await rowFor(c2.t.id);
      c.ok("Send all lists the sweep's words for both jobs", listed1?.body === s1 && listed2?.body === s2, `${listed1?.body} | ${listed2?.body}`);
      texts.length = 0;
      const card = await sendConfirmationText(c1.t.id);
      c.ok("the per-card Send sends the sweep's words, byte for byte", card.ok && sentTo(c1.cl).length === 1 && sentTo(c1.cl)[0] === s1, `${card.message} | ${sentTo(c1.cl)[0]}`);
      say("per-card after", sentTo(c1.cl)[0] ?? "");
      c.ok("…which is not what the card sent before (the waived twilight is gone)", sentTo(c1.cl)[0] !== oldCard1 && /twilight/i.test(oldCard1));
      const all = await sendDraftText(c2.t.id, listed2!.body);
      c.ok("Send all sends the listed words: the sweep's, with the town the card used to drop", all.ok && sentTo(c2.cl)[0] === s2 && s2 !== oldCard2, `${all.message} | ${sentTo(c2.cl)[0]}`);
      c.ok("both buttons completed their tasks", (await taskStatus(c1)) === "COMPLETED" && (await taskStatus(c2)) === "COMPLETED");
      const act = await prisma.activity.findFirst({ where: { projectId: c1.p.id, body: { startsWith: "Confirmation text sent to Sarah Agent:" } }, select: { body: true } });
      c.ok("…and logged the send on the project, as before (\"Confirmation text sent to …\")", !!act && act.body.endsWith(s1.slice(0, 160)));
      const log = await prisma.commLog.findFirst({ where: { projectId: c1.p.id, direction: "out" }, orderBy: { occurredAt: "desc" }, select: { body: true } });
      c.ok("…and the outbound text is in the client's comms with the same body", log?.body === s1);

      texts.length = 0;
      const dsweep = await sweepDeliveryTexts();
      const sd1 = sentTo(d1.cl)[0] ?? "";
      c.ok("the delivery sweep sent the whole-job feedback ask and held the two jobs still owed", dsweep.sent === 1 && sentTo(d1.cl).length === 1 && sentTo(d2.cl).length === 0 && sentTo(d3.cl).length === 0, JSON.stringify(dsweep));
      c.ok("…its words are the client_delivery_feedback default", sd1 === TT.render("client_delivery_feedback", { first: "Gary", street: "626 Greycliffe Ln", feedbackUrl: `${APP}/feedback/${d1.p.id}` }), sd1);
      const oldCardD1 = OLD.deliveryMessage({ id: d1.p.id, title: d1.p.title, statusEvidence: ev(["Photos"]), client: { name: "Gary Smith" } });
      say("delivery per-card before", oldCardD1);
      await unsend(d1, "delivery");
      const listedD1 = await rowFor(d1.t.id);
      c.ok("Send all lists the feedback ask for the delivered job", listedD1?.body === sd1, listedD1?.body ?? "");
      texts.length = 0;
      const cardD1 = await sendDeliveryText(d1.t.id);
      c.ok("the per-card delivery Send sends the sweep's feedback ask, byte for byte", cardD1.ok && sentTo(d1.cl)[0] === sd1, `${cardD1.message} | ${sentTo(d1.cl)[0]}`);
      say("delivery per-card after", sentTo(d1.cl)[0] ?? "");
      c.ok("…not the old \"Everything … has been delivered\" announcement", /has been delivered\. How did we do\?/.test(oldCardD1) && !/has been delivered/.test(sentTo(d1.cl)[0] ?? ""));

      // The two shapes only a person reaches: a button on a job still owed.
      const oldD2 = OLD.deliveryMessage({ id: d2.p.id, title: d2.p.title, statusEvidence: ev(["Photos"], ["Video"]), client: { name: "Dana Partial" } });
      const oldD3 = OLD.deliveryMessage({ id: d3.p.id, title: d3.p.title, statusEvidence: ev([], ["Video"]), client: { name: "Nina Nothing" } });
      c.ok("Send all lists the part-delivered and nothing-out-yet texts in the old words", (await rowFor(d2.t.id))?.body === oldD2 && (await rowFor(d3.t.id))?.body === oldD3);
      const cardD2 = await sendDeliveryText(d2.t.id);
      const cardD3 = await sendDeliveryText(d3.t.id);
      c.ok("the per-card Send on a part-delivered job: client_delivery_partial's default, byte for byte the old words", cardD2.ok && sentTo(d2.cl)[0] === oldD2 && sentTo(d2.cl)[0] === delivery.deliveryMessage((await jobFields(d2.p.id)) as never, undefined, D), sentTo(d2.cl)[0]);
      c.ok("…and on a job with nothing out yet: client_delivery_update's default, byte for byte the old words", cardD3.ok && sentTo(d3.cl)[0] === oldD3, sentTo(d3.cl)[0]);
      c.ok("…neither carries a long dash or a Dropbox link", [sd1, oldD2, oldD3, s1, s2].every((b) => !/[—–]/.test(b) && !/dropbox/i.test(b)));
    }

    // =========================================================================
    c.head("2 · a saved wording: the buttons and the sweep send the edit");
    // =========================================================================
    {
      const by = { email: "jordan@sb.invalid", name: "Jordan Spackman" };
      const saves = await Promise.all([
        store.saveTextTemplate("client_confirmation", "Hi {first}! See you {when} {atPlace}. Reply with anything we should know.", by),
        store.saveTextTemplate("client_delivery_feedback", "Thanks {first}! {street} is wrapped. Tell us how we did: {feedbackUrl}", by),
        store.saveTextTemplate("client_delivery_partial", "Hi {first}, the {delivered} are out and {remaining} is on the way. Thoughts so far? {feedbackUrl}", by),
        store.saveTextTemplate("client_delivery_update", "Hi {first}, quick note {forPlace}: {remainingLine}. More soon.", by),
      ]);
      c.ok("Jordan's four wordings save", saves.every((r) => r.ok), JSON.stringify(saves));
      const c3 = await confirmJob("Morgan Lee", "45 Oak Ave, Macungie, PA", null, ["PHOTOS"]);
      const c4 = await confirmJob("Riley Fox", "77 Pine Ct, Emmaus, PA", null, ["PHOTOS"]);
      const when = shoot.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      texts.length = 0;
      const card = await sendConfirmationText(c3.t.id);
      c.ok("the per-card Send sends the edited confirmation", card.ok && sentTo(c3.cl)[0] === `Hi Morgan! See you ${when} at 45 Oak Ave. Reply with anything we should know.`, sentTo(c3.cl)[0]);
      const listed4 = await rowFor(c4.t.id);
      c.ok("Send all lists the edited confirmation", listed4?.body === `Hi Riley! See you ${when} at 77 Pine Ct. Reply with anything we should know.`, listed4?.body ?? "");
      await sweepConfirmationTexts();
      c.ok("…and the sweep sends the same edited words for that job", sentTo(c4.cl)[0] === listed4?.body, sentTo(c4.cl)[0]);

      const d4 = await deliveryJob("Avery Stone", "12 Birch Ln, Emmaus, PA", ev(["Photos"]));
      const d5 = await deliveryJob("Casey Part", "3 Cedar St, Emmaus, PA", ev(["Photos", "Drone"], ["Video"]), ["PHOTOS", "DRONE", "VIDEO"]);
      const d6 = await deliveryJob("Jamie None", "8 Ash Ct, Emmaus, PA", ev([], ["Video"]), ["VIDEO"]);
      const listedD4 = await rowFor(d4.t.id);
      c.ok("Send all lists the edited feedback ask", listedD4?.body === `Thanks Avery! 12 Birch Ln is wrapped. Tell us how we did: ${APP}/feedback/${d4.p.id}`, listedD4?.body ?? "");
      const allD4 = await sendDraftText(d4.t.id, listedD4!.body);
      c.ok("…and sends it", allD4.ok && sentTo(d4.cl)[0] === listedD4?.body);
      await sendDeliveryText(d5.t.id);
      c.ok("the per-card Send on a part-delivered job sends the edited part-delivered words", sentTo(d5.cl)[0] === `Hi Casey, the photos, drone are out and the video is on the way. Thoughts so far? ${APP}/feedback/${d5.p.id}`, sentTo(d5.cl)[0]);
      await sendDeliveryText(d6.t.id);
      c.ok("…and on a job with nothing out, the edited update", sentTo(d6.cl)[0] === "Hi Jamie, quick note for 8 Ash Ct: the video is still in production and coming shortly. More soon.", sentTo(d6.cl)[0]);

      // A draft box (Communications → Outbox): what a person types is what goes.
      const d7 = await deliveryJob("Quinn Typed", "4 Elm St, Emmaus, PA", ev(["Photos"]));
      const typed = "Hi Quinn, all set on 4 Elm St. Anything you want changed, just say.";
      const box = await sendDraftText(d7.t.id, typed);
      c.ok("a box edited by hand sends exactly what was typed", box.ok && sentTo(d7.cl)[0] === typed, sentTo(d7.cl)[0]);
    }

    // =========================================================================
    c.head("3 · an invalid saved wording falls back to the default");
    // =========================================================================
    {
      const bad = (key: string, body: string) => prisma.appSetting.upsert({ where: { key: `text_template:${key}` }, create: { key: `text_template:${key}`, value: JSON.stringify({ body, by: "someone" }) }, update: { value: JSON.stringify({ body, by: "someone" }) } });
      await bad("client_confirmation", "Hi {first}! See you soon {atPlace}."); // {when} gone
      await bad("client_delivery_feedback", "Thanks {first}! {street} is wrapped."); // {feedbackUrl} gone
      await bad("client_delivery_partial", "Hi {first}, {nickname}: {feedbackUrl}"); // unknown placeholder
      store.forgetTextTemplateCache();
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        const c5 = await confirmJob("Taylor Ray", "19 Maple Dr, Emmaus, PA", null, ["PHOTOS"]);
        const d8 = await deliveryJob("Jordan Pike", "21 Walnut St, Emmaus, PA", ev(["Photos"]));
        const d9 = await deliveryJob("Robin Half", "2 Spruce Ln, Emmaus, PA", ev(["Photos"], ["Video"]), ["PHOTOS", "VIDEO"]);
        await sendConfirmationText(c5.t.id);
        await sendDeliveryText(d8.t.id);
        const listedD9 = await rowFor(d9.t.id);
        c.ok("the confirmation without {when}: the per-card Send sends the default", sentTo(c5.cl)[0] === delivery.confirmationMessage({ ...(await jobFields(c5.p.id)), client: { name: "Taylor Ray" } }, D), sentTo(c5.cl)[0]);
        c.ok("the feedback ask without {feedbackUrl}: the default", sentTo(d8.cl)[0] === TT.render("client_delivery_feedback", { first: "Jordan", street: "21 Walnut St", feedbackUrl: `${APP}/feedback/${d8.p.id}` }), sentTo(d8.cl)[0]);
        c.ok("the part-delivered text with an unknown placeholder: Send all lists the default (the old words)", listedD9?.body === OLD.deliveryMessage({ id: d9.p.id, title: d9.p.title, statusEvidence: ev(["Photos"], ["Video"]), client: { name: "Robin Half" } }), listedD9?.body ?? "");
      } finally {
        console.warn = realWarn;
      }
      await prisma.appSetting.deleteMany({ where: { key: { startsWith: "text_template:" } } });
      store.forgetTextTemplateCache();
    }

    // =========================================================================
    c.head("4 · one identity: a hand send stops the sweep, the sweep stops the buttons");
    // =========================================================================
    {
      // Hand first.
      const c6 = await confirmJob("Hand First", "1 First St, Emmaus, PA", null, ["PHOTOS"]);
      const d10 = await deliveryJob("Hand Firstd", "2 First St, Emmaus, PA", ev(["Photos"]));
      texts.length = 0;
      await sendConfirmationText(c6.t.id);
      await sendDeliveryText(d10.t.id);
      c.ok("the per-card Sends went (one text each)", sentTo(c6.cl).length === 1 && sentTo(d10.cl).length === 1);
      await sweepConfirmationTexts();
      await sweepDeliveryTexts();
      c.ok("the sweeps then send neither job again", sentTo(c6.cl).length === 1 && sentTo(d10.cl).length === 1);
      await reopen(c6);
      await reopen(d10);
      await sweepConfirmationTexts();
      await sweepDeliveryTexts();
      c.ok("…not even with the tasks reopened behind them (the outbox holds the job's identity)", sentTo(c6.cl).length === 1 && sentTo(d10.cl).length === 1);
      c.ok("…and the sweeps close the reopened tasks, nothing re-sent", (await taskStatus(c6)) === "COMPLETED" && (await taskStatus(d10)) === "COMPLETED");

      // Sweep first.
      const c7 = await confirmJob("Sweep First", "3 First St, Emmaus, PA", null, ["PHOTOS"]);
      const d11 = await deliveryJob("Sweep Firstd", "4 First St, Emmaus, PA", ev(["Photos"]));
      await sweepConfirmationTexts();
      await sweepDeliveryTexts();
      c.ok("the sweeps sent each job once", sentTo(c7.cl).length === 1 && sentTo(d11.cl).length === 1);
      const late = [await sendConfirmationText(c7.t.id), await sendDeliveryText(d11.t.id)];
      c.ok("a per-card Send pressed afterwards (a stale card) is refused, nothing sent", late.every((r) => !r.ok) && sentTo(c7.cl).length === 1 && sentTo(d11.cl).length === 1, late.map((r) => r.message).join(" | "));
      await reopen(c7);
      await reopen(d11);
      const listedC7 = await rowFor(c7.t.id);
      c.ok("with the tasks reopened, Send all marks both rows Already sent", listedC7?.blocked === "Already sent" && (await rowFor(d11.t.id))?.blocked === "Already sent");
      const again = [await sendConfirmationText(c7.t.id), await sendDeliveryText(d11.t.id), await sendDraftText(c7.t.id, listedC7!.body)];
      c.ok("…and the per-card Send and Send all are refused by the outbox, nothing sent", again.every((r) => !r.ok && /Already sent/.test(r.message)) && sentTo(c7.cl).length === 1 && sentTo(d11.cl).length === 1, again.map((r) => r.message).join(" | "));
    }

    // =========================================================================
    c.head("5 · the capture feedback text, and who may press");
    // =========================================================================
    {
      const member = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@sb.invalid", role: "PHOTOGRAPHER", phone: "6105559999" } });
      const cl = await mkClient("Feedback Client");
      const p = await prisma.project.create({ data: { title: "238 Hudson Dr, Malvern, PA", clientId: cl.id, status: "DELIVERED", photographerId: member.id } });
      await prisma.mediaNote.create({ data: { projectId: p.id, assetUrl: "https://example.test/a.jpg", lane: "PHOTOGRAPHER", kind: "fix", body: "Level the horizon.", photographerId: member.id } });
      await signIn(owner);
      texts.length = 0;
      const r1 = await shareShootFeedback(p.id);
      const old = `Hey Harrison — Jordan left some feedback on your shoot for 238 Hudson Dr. Check it out here: ${APP}/shoot/${p.id}`;
      c.ok("the default is the old words, byte for byte", r1.ok && texts.length === 1 && texts[0].text === old && texts[0].to === "+16105559999", `${r1.message} | ${texts[0]?.text}`);
      const saved = await store.saveTextTemplate("shoot_feedback_shared", "Hi {firstName}, {author} added notes on {street}: {link}", { email: "jordan@sb.invalid", name: "Jordan Spackman" });
      const r2 = await shareShootFeedback(p.id);
      c.ok("a saved wording is what goes", saved.ok && r2.ok && texts[1]?.text === `Hi Harrison, Jordan added notes on 238 Hudson Dr: ${APP}/shoot/${p.id}`, texts[1]?.text);
      const refused = await store.saveTextTemplate("shoot_feedback_shared", "Hi {firstName}, notes are in.", { email: "jordan@sb.invalid", name: "Jordan Spackman" });
      c.ok("…and one without the link is refused at save", !refused.ok && refused.problems.some((x) => x.includes("{link}")));

      // Who may press the client buttons: the office (owner, admin), as before.
      const c8 = await confirmJob("Guard Check", "5 Guard St, Emmaus, PA", null, ["PHOTOS"]);
      await signIn(shooter);
      const before = texts.length;
      const tries = await Promise.allSettled([sendConfirmationText(c8.t.id), sendDraftText(c8.t.id, "hi"), listDraftedTexts()]);
      const refusedAll = tries.every((t) => t.status === "rejected" || (t.value as { ok: boolean }).ok === false);
      c.ok("a photographer is refused the per-card Send, Send all and its list; nothing sent", refusedAll && texts.length === before && (await taskStatus(c8)) === "OPEN");
      await signIn(kyle);
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

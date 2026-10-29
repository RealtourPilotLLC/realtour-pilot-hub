// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: "REMIND PHOTOGRAPHER" IN THE EDITING ROOM (Oct 23 2026,
// lib/remindPhotographer). Jordan: "a 'Remind Photographer' button on video
// projects in the editing room that are missing instructions would be great so
// we can send a text to the photographer to remind them that the instructions
// are missing and editor is waiting and then give them a link to go to the
// upload portal to add them."
//
//   DRILL_PORT=7121 node scripts/_drill/run-all.cjs scripts/_drill/oct23-remind-photographer.ts
//
// Isolated PGlite; fetch fenced; OpenPhone answered in-process (every text
// recorded). The clock is pinned to Fri Oct 23 2026 (EDT) and moved by hand.
//
//   1. The words (pure): one video, two videos, no dashes, the row's line.
//   2. The button shows only on rows missing instructions, by the morning
//      ask's rule (a submitted half, a plain reel, a waived video and a video
//      waiting on a second shoot ask nothing), for the office and the creative
//      manager only (never an editor's or a photographer's board).
//   3. Who may press: owner, admin, creative manager yes; editor, photographer
//      and "view as" no, and nothing is sent for a refusal.
//   4. The text's words and link (one video, two videos, an added video), the
//      outbox row, the timeline, the delivery log, the row's "Reminded" line.
//   5. Refused with the reason: nothing missing, no photographer, no phone,
//      OpenPhone off; a double press sends one text.
//   6. The 10 AM sweep: a job pressed this morning is not texted again; a
//      press counts among its three mornings ("still" the next day).
//   7. Two hours: a second press is refused, saying when the last went (a
//      press, or the hub's own morning text); after two hours it goes.
//   8. A job no longer missing: no button, no text.
//   9. Wired in, and the fence held.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import type { QueueRow } from "../../src/components/editing/SimpleQueue";

const PORT = Number(process.env.DRILL_PORT ?? 7121);
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ---------------------------------------------------------------
const RealDate = Date;
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new RealDate(RealDate.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}
let offset = et(2026, 10, 23, 8, 30).getTime() - RealDate.now();
const setNow = (d: Date) => { offset = d.getTime() - RealDate.now(); return d; };
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const THU = (h: number, mi = 0) => et(2026, 10, 22, h, mi);
const FRI = (h: number, mi = 0) => et(2026, 10, 23, h, mi);
const SAT = (h: number, mi = 0) => et(2026, 10, 24, h, mi);

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Error(`redirect ${href}`); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
}
const fence = fenceFetch(() => null); // nothing outbound at all
const DASH = /[–—]/;
/** the clock keeps ticking after setNow: a stamp within a minute of the wall time is it */
const near = (iso: string | undefined, d: Date) => !!iso && Math.abs(Date.parse(iso) - d.getTime()) < 60_000;

function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-remind-photographer" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    let connected = true;
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => {
      if (!connected) throw new Error("OpenPhone is not connected.");
      return [{ id: "PN-drill", number: OFFICE }];
    };
    const texts: { to: string; body: string; at: Date }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body, at: new Date() });
      return { data: { id: `op-${texts.length}` } };
    };
    const rp = await import("@/lib/remindPhotographer");
    const mi = await import("@/lib/missingInstructions");
    const { remindPhotographerAction } = await import("@/app/editing/remindActions");
    const { setSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/editing/page");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");
    const { appBase } = await import("@/lib/appUrl");
    const dout = await import("@/lib/deliverableOutputs");
    const { withSecondShoot } = await import("@/lib/secondShootCore");

    // =====================================================================
    c.head("1 · The words (pure)");
    // =====================================================================
    const one = rp.composeReminderText({ firstName: "Harrison", street: "859 N Lawrence St", missing: ["the flow and vision for the edit"], link: "https://hub.example/upload/p1" });
    console.log(`\n--- one video ---\n${one}\n---`);
    c.ok("Jordan's shape: the street, missing, the editor waiting, what is needed, the upload page",
      one === `${HUB_SMS_PREFIX}: Hi Harrison, quick reminder: the instructions for 859 N Lawrence St are missing and the editor is waiting on them. Still needed: the flow and vision for the edit.\n\nYou can add them here:\nhttps://hub.example/upload/p1`, one);
    c.ok("a list of three reads 'a, b and c'", rp.composeReminderText({ firstName: "H", street: "1 A St", missing: ["a", "b", "c"], link: "x" }).includes("Still needed: a, b and c."));
    c.ok("no dashes, even from a dashed street", !DASH.test(one) && !DASH.test(rp.composeReminderText({ firstName: "H", street: "12 Elm St — Unit 2", missing: ["a"], link: "x" })));
    c.ok("the row's line: today 'Reminded 9:00 AM by Jordan', the hub's own 'by the hub', another day dated",
      rp.reminderWords({ at: FRI(9), by: "Jordan Spackman" }, FRI(9, 30)) === "Reminded 9:00 AM by Jordan"
      && rp.reminderWords({ at: FRI(10), by: null }, FRI(11)) === "Reminded 10:00 AM by the hub"
      && rp.reminderWords({ at: THU(16, 5), by: "Kyle Smith" }, FRI(9)) === "Reminded Oct 22, 4:05 PM by Kyle",
      rp.reminderWords({ at: THU(16, 5), by: "Kyle Smith" }, FRI(9)));
    const TT = await import("@/lib/textTemplates");
    c.ok("its own template (Settings, Text messages), a team text that must keep the list and the link",
      TT.TEXT_TEMPLATES.instructions_reminder_photographer.audience === "team" && TT.TEXT_TEMPLATES.instructions_reminder_photographer.required.join() === "missingList,link" && TT.checkTemplateBody("instructions_reminder_photographer", TT.TEXT_TEMPLATES.instructions_reminder_photographer.body).ok);

    // =====================================================================
    c.head("2 · The world");
    // =====================================================================
    const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER" | "EDITOR", phone: string | null, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email, role, phone, active: true, ...extra }, select: { id: true, name: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144");
    const jamesTm = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", { creativeManager: true });
    const kyleTm = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE, { opsAlerts: true });
    const jordanTm = await member("Jordan Spackman", "info@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111");
    const kimTm = await member("Kim Miguel", "kim@drill.invalid", "EDITOR", null);
    const pat = await member("Pat Rivera", "pat@drill.invalid", "PHOTOGRAPHER", null);
    const login = (name: string, email: string, role: string, teamMemberId: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { name, email, role, status: "ACTIVE", teamMemberId, ...extra } });
    const owner = await login("Jordan Spackman", "info@drill.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@drill.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@drill.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const kim = await login("Kim Miguel", "kim@drill.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    const harrisonLogin = await login("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
    const signIn = (u: { id: string; email: string; role: string; name: string | null }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Joe Brennan", phone: "6105550301" } });

    const SHOT = THU(14);
    type D = { type: "PHOTOS" | "VIDEO" | "SOCIAL_REEL"; label?: string; videoStyle?: string; createdAt?: Date; waivedAt?: Date };
    const job = async (street: string, o: { who?: string | null; items: D[]; data?: Record<string, unknown> }) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Philadelphia, PA`, addressLine: street, clientId: client.id, status: "SHOT", shootDate: SHOT,
          photographerId: o.who === undefined ? harrison.id : o.who,
          deliverables: { create: o.items.map((d) => ({ type: d.type as never, label: d.label ?? d.type, productTitle: d.label ?? null, videoStyle: d.videoStyle ?? null, ...(d.createdAt ? { createdAt: d.createdAt } : {}), ...(d.waivedAt ? { waivedAt: d.waivedAt } : {}) })) },
          ...(o.data ?? {}),
        },
        select: { id: true, addressLine: true },
      });
      await dout.ensureOutputsForProject(p.id);
      return p;
    };
    // Photos handed in (cull and removals answered), the cinematic's half still owed.
    const PHOTOS_IN = { photosHandoffAt: THU(20), cullingConfirmedAt: THU(20), removalNotes: "Trash cans by the garage" };
    const WORDS = "VISION FOR THE EDIT\nOpen on the porch, slow push to the kitchen.\nCOLOR PROFILE: iPhone";
    const lawrence = await job("859 N Lawrence St", { items: [{ type: "PHOTOS" }, { type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }], data: PHOTOS_IN });
    // Two videos, no words for either yet (the premium script is in).
    const onward = await job("610 Onward Ave", {
      items: [{ type: "SOCIAL_REEL", label: "Social Influencer", videoStyle: "premium_social_reel" }, { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", videoStyle: "standard_reel" }],
      data: { reelScript: "Happy Gilmore: The First Drive", scriptConfirmedAt: SHOT },
    });
    // Handed in Thursday night; the order added a second reel Friday 8 AM.
    const added = await job("540 Onward Ave", {
      items: [{ type: "SOCIAL_REEL", label: "Social Influencer", videoStyle: "premium_social_reel", createdAt: THU(9) }, { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: FRI(8) }],
      data: { reelScript: "Script", scriptConfirmedAt: SHOT, videoInstructions: WORDS, videoHandoffAt: THU(19) },
    });
    // The same, but its added reel is waiting on a second shoot.
    const second = await job("620 Onward Ave", {
      items: [{ type: "SOCIAL_REEL", label: "Social Influencer", videoStyle: "premium_social_reel", createdAt: THU(9) }, { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: FRI(8) }],
      data: { reelScript: "Script", scriptConfirmedAt: SHOT, videoInstructions: WORDS, videoHandoffAt: THU(19) },
    });
    const secondOut = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: second.id, deliverable: { label: "Standard Video Highlight Reel" } } });
    await prisma.deliverableOutput.update({ where: { id: secondOut.id }, data: { briefJson: withSecondShoot(null, { by: "Jordan", at: THU(18).toISOString(), note: "Half shot; needs a second appointment", expectedAt: null, afterVisitAt: SHOT.toISOString() }) } });
    // The same, but its added reel was waived.
    const waived = await job("630 Onward Ave", {
      items: [{ type: "SOCIAL_REEL", label: "Social Influencer", videoStyle: "premium_social_reel", createdAt: THU(9) }, { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: FRI(8), waivedAt: FRI(8, 10) }],
      data: { reelScript: "Script", scriptConfirmedAt: SHOT, videoInstructions: WORDS, videoHandoffAt: THU(19) },
    });
    // Its video half is in.
    const done = await job("22 Done Way", { items: [{ type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }], data: { videoInstructions: WORDS, videoHandoffAt: THU(19), debriefSubmittedAt: THU(19) } });
    // A plain reel owes no words.
    const plain = await job("7 Plain Reel Rd", { items: [{ type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_reel" }] });
    const noPhone = await job("30 No Phone Pl", { who: pat.id, items: [{ type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }] });
    const nobody = await job("15 Nobody Ln", { who: null, items: [{ type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }] });
    const offline = await job("88 Offline Ct", { items: [{ type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }] });
    const officeLine = await job("5 Office Line Rd", { who: kyleTm.id, items: [{ type: "VIDEO", label: "Cinematic Video", videoStyle: "standard_cinematic" }] });
    const v1 = (await dout.videoInstructionsFor(onward.id)).find((r) => r.number === 1)!;
    const v2 = (await dout.videoInstructionsFor(onward.id)).find((r) => r.number === 2)!;
    c.ok("the world is built (610 Onward Ave owes two videos)", !!v1 && !!v2, `${v1?.label} / ${v2?.label}`);

    const about = (street: string) => texts.filter((t) => t.body.includes(street));
    const reminders = (street: string) => about(street).filter((t) => t.body.includes("quick reminder"));
    const nudges = (street: string) => about(street).filter((t) => t.body.includes("waiting on you"));
    const lines = async (projectId: string) => (await prisma.activity.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } })).map((a) => a.body);
    const lock = async (projectId: string) => { const r = await prisma.appSetting.findUnique({ where: { key: rp.remindLockKey(projectId) } }); return r ? JSON.parse(r.value) as { state: string; at: string; id: string; by: string; to: string } : null; };
    const claim = async (projectId: string, day: string) => { const r = await prisma.appSetting.findUnique({ where: { key: mi.claimKey(projectId, day) } }); return r ? JSON.parse(r.value) as { state: string; at: string; by?: string; morning?: number; missing?: string[] } : null; };
    const press = (projectId: string, at: Date) => { setNow(at); return remindPhotographerAction(projectId); };
    const officeRows = async (as: { id: string; email: string; role: string; name: string | null }, at: Date, actingAs?: string) => {
      setNow(at);
      await signIn(as, actingAs);
      const tree = await page({});
      const queue = elements(tree, "SimpleQueue")[0];
      return { html: renderToStaticMarkup(tree), rows: ((queue?.notDone ?? []) as QueueRow[]), tree };
    };

    // =====================================================================
    c.head("3 · The button: only on rows missing instructions, only for the office and the creative manager");
    // =====================================================================
    const ownerView = await officeRows(owner, FRI(8, 30));
    const shows = (id: string) => !!ownerView.rows.find((r) => r.id === id)?.remind;
    const onBoard = (id: string) => ownerView.rows.some((r) => r.id === id);
    c.ok("every job is on the Editing Room board", [lawrence, onward, added, second, waived, done, plain, noPhone, nobody, offline].every((p) => onBoard(p.id)), ownerView.rows.map((r) => r.street).join(", "));
    c.ok("shown: one video owed its words, two videos, a video added after the handoff, no phone, no photographer",
      [lawrence, onward, added, noPhone, nobody, offline].every((p) => shows(p.id)));
    c.ok("not shown: the video half handed in, a plain reel, an added video waiting on a second shoot, an added video waived",
      [done, plain, second, waived].every((p) => !shows(p.id)), [done, plain, second, waived].filter((p) => shows(p.id)).map((p) => p.addressLine).join(", "));
    c.ok("the button is drawn exactly on those rows",
      [lawrence, onward, added, noPhone, nobody, offline].every((p) => ownerView.html.includes(`aria-label="Remind photographer about ${p.addressLine}"`))
      && [done, plain, second, waived].every((p) => !ownerView.html.includes(`aria-label="Remind photographer about ${p.addressLine}"`)));
    const onwardView = ownerView.rows.find((r) => r.id === onward.id)!.remind!;
    c.ok("what a row says is missing is the morning ask's own list (video 2 named by perVideoInstructions)",
      JSON.stringify(onwardView.missing) === JSON.stringify(["the flow and vision for the edit", `the instructions for video 2 (${v2.label})`, "the wrap-up on the upload page"]) && onwardView.photographer === "Harrison Wells" && onwardView.last === null, JSON.stringify(onwardView));
    const addedView = ownerView.rows.find((r) => r.id === added.id)!;
    c.ok("a row with no handoff sentence of its own says what is missing beside the button", !addedView.blocker && ownerView.html.includes(`Instructions missing: the instructions for video 2 (${v2.label})`));
    c.ok("the morning ask agrees row for row", JSON.stringify((await mi.missingInstructionsFor(lawrence.id))?.video) === JSON.stringify(ownerView.rows.find((r) => r.id === lawrence.id)!.remind!.missing));
    const jamesView = await officeRows(james, FRI(8, 31));
    c.ok("the creative manager's Editing Room (the office board) has the button", !!jamesView.rows.find((r) => r.id === lawrence.id)?.remind && jamesView.html.includes('aria-label="Remind photographer about 859 N Lawrence St"'));
    const kyleView = await officeRows(kyle, FRI(8, 32));
    c.ok("…and the admin's", !!kyleView.rows.find((r) => r.id === onward.id)?.remind);
    await prisma.project.update({ where: { id: lawrence.id }, data: { editorId: kimTm.id } });
    const kimView = await officeRows(kim, FRI(8, 33));
    c.ok("an editor's board never draws it (even on a row of theirs missing instructions)", kimView.rows.some((r) => r.id === lawrence.id) && kimView.rows.every((r) => !r.remind) && !kimView.html.includes("Remind photographer"), kimView.rows.map((r) => r.street).join(","));
    setNow(FRI(8, 34));
    await signIn(harrisonLogin);
    const photoHtml = renderToStaticMarkup(await page({}));
    c.ok("a photographer's board never draws it", !photoHtml.includes("Remind photographer"));
    c.ok("drawing the board sent nothing", texts.length === 0 && (await prisma.outboxMessage.count()) === 0);

    // =====================================================================
    c.head("4 · Who may press");
    // =====================================================================
    await signIn(kim);
    const byKim = await press(lawrence.id, FRI(8, 50));
    c.ok("an editor: refused, plainly", !byKim.ok && byKim.message === "Only the office and the creative manager can remind a photographer.", byKim.message);
    await signIn(harrisonLogin);
    const byHarrison = await press(lawrence.id, FRI(8, 51));
    c.ok("a photographer: refused", !byHarrison.ok && byHarrison.message === "Only the office and the creative manager can remind a photographer.", byHarrison.message);
    await signIn(owner, kyle.id);
    const viewAs = await press(lawrence.id, FRI(8, 52));
    c.ok("the owner viewing as Kyle: refused (a preview is read-only)", !viewAs.ok && /viewing the hub as someone else/.test(viewAs.message), viewAs.message);
    await signIn(owner, james.id);
    const viewAsJames = await press(lawrence.id, FRI(8, 52));
    c.ok("…and viewing as James", !viewAsJames.ok && /viewing the hub as someone else/.test(viewAsJames.message));
    c.ok("no text, no outbox row, no claim, no timeline line for any refusal", texts.length === 0 && (await prisma.outboxMessage.count()) === 0 && !(await lock(lawrence.id)) && !(await claim(lawrence.id, "2026-10-23")) && (await lines(lawrence.id)).length === 0);

    await signIn(owner);
    const byOwner = await press(lawrence.id, FRI(9));
    c.ok("the owner: sent", byOwner.ok && byOwner.message === "Texted Harrison at 9:00 AM with the upload page link.", byOwner.message);
    await signIn(kyle);
    const byKyle = await press(onward.id, FRI(9, 5));
    c.ok("the admin (Kyle): sent", byKyle.ok, byKyle.message);
    await signIn(james);
    // A double click (or two people at once): one text.
    setNow(FRI(9, 10));
    const [j1, j2] = await Promise.all([remindPhotographerAction(added.id), remindPhotographerAction(added.id)]);
    c.ok("the creative manager (James): sent", j1.ok || j2.ok, `${j1.message} | ${j2.message}`);
    c.ok("…and a double press sends ONE text, the other told why", reminders("540 Onward Ave").length === 1 && [j1, j2].filter((r) => r.ok).length === 1 && [j1, j2].some((r) => !r.ok && /just reminded|was reminded at 9:10 AM/.test(r.message)), `${j1.message} | ${j2.message}`);

    // =====================================================================
    c.head("5 · The text: words, link, record");
    // =====================================================================
    const a = reminders("859 N Lawrence St");
    c.ok("one text to Harrison's phone", a.length === 1 && a[0].to.replace(/\D/g, "").endsWith("6105550144"), a.map((t) => t.to).join(","));
    console.log(`\n--- one video (859 N Lawrence St) ---\n${a[0]?.body}\n---`);
    c.ok("one video: what is missing and the upload page", a[0]?.body === `${HUB_SMS_PREFIX}: Hi Harrison, quick reminder: the instructions for 859 N Lawrence St are missing and the editor is waiting on them. Still needed: the flow and vision for the edit and the wrap-up on the upload page.\n\nYou can add them here:\n${appBase()}/upload/${lawrence.id}`, a[0]?.body);
    const b = reminders("610 Onward Ave");
    console.log(`\n--- two videos (610 Onward Ave) ---\n${b[0]?.body}\n---`);
    c.ok("two videos: each video named", b.length === 1 && b[0].body === `${HUB_SMS_PREFIX}: Hi Harrison, quick reminder: the instructions for 610 Onward Ave are missing and the editor is waiting on them. Still needed: the flow and vision for video 1 (${v1.label}), the instructions for video 2 (${v2.label}) and the wrap-up on the upload page.\n\nYou can add them here:\n${appBase()}/upload/${onward.id}`, b[0]?.body);
    const g = reminders("540 Onward Ave");
    console.log(`\n--- an added video (540 Onward Ave) ---\n${g[0]?.body}\n---`);
    c.ok("a video added after the handoff: just that video", g[0]?.body === `${HUB_SMS_PREFIX}: Hi Harrison, quick reminder: the instructions for 540 Onward Ave are missing and the editor is waiting on them. Still needed: the instructions for video 2 (${v2.label}).\n\nYou can add them here:\n${appBase()}/upload/${added.id}`, g[0]?.body);
    c.ok("no dashes in any of them", [...a, ...b, ...g].every((t) => !DASH.test(t.body)));
    const rows = await prisma.outboxMessage.findMany({ where: { projectId: lawrence.id } });
    c.ok("through the durable outbox: one accepted team text, no client on it, signed by the person", rows.length === 1 && rows[0].state === "accepted" && rows[0].clientId === null && rows[0].requestedBy === "Jordan Spackman" && /^instructions_missing:[^:]+:[^:]+:remind:/.test(rows[0].dedupeKey ?? ""), rows.map((r) => `${r.state} ${r.requestedBy} ${r.dedupeKey}`).join(" | "));
    const { outboxKind, isClientKind } = await import("@/lib/outbox");
    c.ok("…the morning ask's kind (a team text, never held to client hours)", outboxKind(rows[0]?.dedupeKey) === "instructions_missing" && !isClientKind("instructions_missing"));
    const la = await lines(lawrence.id);
    c.ok("the job's timeline says who reminded whom, when, and what is missing", la.length === 1 && la[0] === "Jordan Spackman reminded Harrison by text about the missing instructions at 9:00 AM (Remind photographer). Missing: the flow and vision for the edit and the wrap-up on the upload page.", la.join(" | "));
    c.ok("…signed by the person (their roster row)", (await prisma.activity.findFirstOrThrow({ where: { projectId: lawrence.id } })).authorId === jordanTm.id);
    c.ok("Harrison's delivery log has each text", (await prisma.notificationDelivery.count({ where: { kind: "instructions_missing_text", teamMemberId: harrison.id, channel: "sms", status: "sent" } })) === 3);
    const lk = await lock(lawrence.id);
    c.ok("the press is recorded: who, when, to whom", !!lk && lk.state === "sent" && near(lk.at, FRI(9)) && lk.by === "Jordan Spackman" && lk.to === "Harrison Wells" && !!lk.id, JSON.stringify(lk));
    c.ok("the press answers with the row's new line", byOwner.last?.words === "Reminded 9:00 AM by Jordan");
    const after = await officeRows(owner, FRI(9, 20));
    c.ok("the board now reads 'Reminded 9:00 AM by Jordan' on that row, 'by Kyle', 'by James' on the others",
      after.rows.find((r) => r.id === lawrence.id)?.remind?.last?.words === "Reminded 9:00 AM by Jordan" && after.html.includes("Reminded 9:00 AM by Jordan")
      && after.rows.find((r) => r.id === onward.id)?.remind?.last?.words === "Reminded 9:05 AM by Kyle"
      && after.rows.find((r) => r.id === added.id)?.remind?.last?.words === "Reminded 9:10 AM by James");

    // =====================================================================
    c.head("6 · Refused with the reason, and nothing sent");
    // =====================================================================
    const before5 = texts.length;
    await signIn(owner);
    const r1 = await press(done.id, FRI(9, 15));
    c.ok("nothing missing: refused", !r1.ok && r1.message === "Nothing is missing on 22 Done Way any more, so no text was sent.", r1.message);
    const r2 = await press(nobody.id, FRI(9, 15));
    c.ok("no photographer: refused", !r2.ok && r2.message === "15 Nobody Ln has no photographer on it, so there is nobody to text. Add one on the job first.", r2.message);
    const r3 = await press(noPhone.id, FRI(9, 15));
    c.ok("no phone: refused", !r3.ok && r3.message === "Pat has no phone number on file, so no text was sent.", r3.message);
    const r3b = await press(officeLine.id, FRI(9, 15));
    c.ok("their number is the office line: refused", !r3b.ok && /our own office line/.test(r3b.message), r3b.message);
    connected = false;
    const r4 = await press(offline.id, FRI(9, 20));
    connected = true;
    c.ok("OpenPhone not connected: refused", !r4.ok && r4.message === "OpenPhone isn't connected, so no text was sent.", r4.message);
    c.ok("…none of them texted, queued, claimed the morning or wrote a line", texts.length === before5
      && (await prisma.outboxMessage.count({ where: { projectId: { in: [done.id, nobody.id, noPhone.id, offline.id, officeLine.id] } } })) === 0
      && !(await lock(offline.id)) && !(await claim(offline.id, "2026-10-23")) && (await lines(offline.id)).length === 0);
    // OpenPhone answers but refuses the message (a 4xx): nothing left, so nothing is held against the job.
    const realSend = (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage;
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async () => { throw new op.OpenPhoneError("Invalid 'to' number", 400); };
    const r5 = await press(offline.id, FRI(9, 25));
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = realSend;
    c.ok("OpenPhone refuses the message: refused with its reason", !r5.ok && r5.message.startsWith("OpenPhone refused the text to Harrison, so nothing was sent:"), r5.message);
    c.ok("…the press and the morning are released (the button, and the 10 AM text, still work), no line written",
      texts.length === before5 && !(await lock(offline.id)) && !(await claim(offline.id, "2026-10-23")) && (await lines(offline.id)).length === 0
      && (await prisma.outboxMessage.findFirst({ where: { projectId: offline.id } }))?.state === "failed");

    // =====================================================================
    c.head("7 · The 10 AM sweep: a press is the day's ask");
    // =====================================================================
    c.ok("each press claimed today's morning (marked by the person)", (await claim(lawrence.id, "2026-10-23"))?.state === "sent" && (await claim(lawrence.id, "2026-10-23"))?.by === "Jordan Spackman" && (await claim(onward.id, "2026-10-23"))?.by === "Kyle Smith");
    c.ok("…a video added after the handoff on its own claim, as the sweep keys it", (await claim(added.id, "2026-10-23:added"))?.by === "James Livingston" && !(await claim(added.id, "2026-10-23")));
    const sweep = await mi.sweepMissingInstructions(setNow(new RealDate(FRI(10).getTime() + 20_000)));
    console.log(`\n--- the 10:00 sweep ---\n${JSON.stringify(sweep)}\n---`);
    c.ok("10:00: no second text to Harrison about a job pressed this morning", nudges("859 N Lawrence St").length === 0 && nudges("610 Onward Ave").length === 0 && nudges("540 Onward Ave").length === 0 && reminders("859 N Lawrence St").length === 1, JSON.stringify(sweep));
    c.ok("…while a job nobody pressed gets its morning text", nudges("88 Offline Ct").length === 1, about("88 Offline Ct").map((t) => t.body).join(" | "));
    c.ok("the KPI record of the asks reads the press like a morning ask", (await import("@/lib/kpiStore").then((m) => m.readInstructionsAsks([lawrence.id]))).some((x) => x.day === "2026-10-23" && x.missing.length === 2));

    // =====================================================================
    c.head("8 · Two hours between reminders");
    // =====================================================================
    await signIn(kyle);
    const again = await press(lawrence.id, FRI(10, 30));
    c.ok("10:30, Kyle presses 859 N Lawrence St again: refused, saying when the last went and when he can", !again.ok && again.message === "Harrison was reminded at 9:00 AM by Jordan. You can remind again after 11:00 AM.", again.message);
    const hub = await press(offline.id, FRI(10, 30));
    c.ok("…and on a job the hub texted at 10: 'reminded at 10:00 AM by the hub'", !hub.ok && hub.message === "Harrison was reminded at 10:00 AM by the hub. You can remind again after 12:00 PM.", hub.message);
    const hubRow = (await officeRows(kyle, FRI(10, 31))).rows.find((r) => r.id === offline.id);
    c.ok("the row says the hub's morning text too", hubRow?.remind?.last?.words === "Reminded 10:00 AM by the hub", hubRow?.remind?.last?.words);
    c.ok("neither sent anything", reminders("859 N Lawrence St").length === 1 && reminders("88 Offline Ct").length === 0);
    await signIn(james);
    const later = await press(lawrence.id, FRI(11, 5));
    c.ok("11:05 (two hours on): James's press goes", later.ok && reminders("859 N Lawrence St").length === 2, later.message);
    c.ok("…the morning claim stays the first press's (the day's ask was already spent)", (await claim(lawrence.id, "2026-10-23"))?.by === "Jordan Spackman" && near((await claim(lawrence.id, "2026-10-23"))?.at, FRI(9)));
    c.ok("…and the row reads 'by James' now", (await lock(lawrence.id))?.by === "James Livingston" && later.last?.words === "Reminded 11:05 AM by James");
    await signIn(kyle);
    const hubLater = await press(offline.id, FRI(12, 5));
    c.ok("12:05 on the hub's job: goes, and the hub's own morning claim is left as it was", hubLater.ok && reminders("88 Offline Ct").length === 1 && !(await claim(offline.id, "2026-10-23"))?.by, hubLater.message);

    // =====================================================================
    c.head("9 · A job no longer missing");
    // =====================================================================
    await prisma.project.update({ where: { id: lawrence.id }, data: { videoInstructions: WORDS, videoHandoffAt: FRI(12, 30), debriefSubmittedAt: FRI(12, 30) } });
    const t9 = texts.length;
    await signIn(owner);
    const gone = await press(lawrence.id, FRI(13, 10));
    c.ok("1:10 PM, the page went in at 12:30: refused, nothing sent", !gone.ok && gone.message === "Nothing is missing on 859 N Lawrence St any more, so no text was sent." && texts.length === t9, gone.message);
    const board = await officeRows(owner, FRI(13, 11));
    c.ok("…and its row has no button any more", !board.rows.find((r) => r.id === lawrence.id)?.remind && !board.html.includes('aria-label="Remind photographer about 859 N Lawrence St"'));

    // =====================================================================
    c.head("10 · The next morning");
    // =====================================================================
    await mi.sweepMissingInstructions(setNow(new RealDate(SAT(10).getTime() + 20_000)));
    const sat = nudges("610 Onward Ave");
    c.ok("Sat 10:00: 610 Onward Ave asked by the sweep, 'still waiting' (Friday's press counted as a morning)", sat.length === 1 && sat[0].body.includes("is still waiting on you"), sat.map((t) => t.body).join(" | "));
    c.ok("…its claim is morning 2", (await claim(onward.id, "2026-10-24"))?.morning === 2, JSON.stringify(await claim(onward.id, "2026-10-24")));
    c.ok("859 N Lawrence St (handed in): not asked", nudges("859 N Lawrence St").length === 0);

    // =====================================================================
    c.head("11 · Wired in, and the fence held");
    // =====================================================================
    const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    c.ok("the page reads the rows for the creative leads only, and hands them to the queue", /const canRemind = !me \|\| isCreativeLead\(me\.role\)/.test(src("src/app/editing/page.tsx")) && /remind: reminders\.get\(r\.id\) \?\? null/.test(src("src/app/editing/page.tsx")));
    c.ok("the queue draws it on the office's open rows only", /!hideEditor && view === "notdone" && r\.remind && \(/.test(src("src/components/editing/SimpleQueue.tsx")));
    c.ok("the action asks the real login's role, and refuses a preview", /me\?\.impersonating/.test(src("src/app/editing/remindActions.ts")) && /isCreativeLead\(me\.realRole\)/.test(src("src/app/editing/remindActions.ts")));
    c.ok("no outbound call at all (OpenPhone answered in-process)", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.join(" "));
    c.ok("only Harrison and James were ever texted; never a client, Pat, Kyle or the office line", texts.every((t) => /6105550144$|6105550133$/.test(t.to.replace(/\D/g, ""))), texts.map((t) => t.to).join(","));
    const ours = [...texts.filter((t) => t.body.includes("quick reminder")).map((t) => t.body), ...(await prisma.activity.findMany({ where: { body: { contains: "Remind photographer" } } })).map((x) => x.body)];
    c.ok("no dashes in any reminder or its timeline line", ours.length >= 8 && ours.every((x) => !DASH.test(x)), `${ours.length} checked`);
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

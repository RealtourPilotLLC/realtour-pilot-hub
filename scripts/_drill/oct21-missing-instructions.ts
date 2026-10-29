// ---------------------------------------------------------------------------
// DRILL: MISSING INSTRUCTIONS, THE MORNING AFTER (Oct 21 2026,
// lib/missingInstructions). Jordan: "Joe's shoot from yesterday is waiting on
// instructions from Harrison before editing starts. Can you please make sure
// that if instructions are not submitted by 10am the next morning after the
// appointment the creative gets a message asking for whatever is missing?
// James is now creative manager so he should get pinged too."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-missing-instructions.ts
//
// Isolated PGlite; fetch and raw sockets fenced; OpenPhone answered in-process
// (every text recorded). The clock is pinned to Tue Oct 20 2026 (EDT).
//
//   1. The words (pure): the list, the text, James's line, no dashes, when a
//      shoot counts as over.
//   2. The missing list IS the handoff engine's (video) and the delivery
//      checklist's wrap-up test (photos), never a second definition.
//   3. Before 10 AM nothing; at 10 AM one text to the photographer and one
//      ping to James (bell + his "Shoot changes" text), twin ticks included;
//      later ticks nothing; the timeline line.
//   4. Who never gets one: a cancelled visit, a cancelled job, a test client,
//      no photographer, a plain reel (nothing demanded), a shoot from before
//      it shipped, a visit still to come; photographer = creative manager
//      gets one message only.
//   5. The next morning asks again ("still waiting"), the switch off sends
//      nothing, a submitted half stops it, and after 3 mornings it stops.
//   6. Wired in: the cron step, the outbox kind and drain, the Settings card.
//   7. The fence held: only Harrison and James were texted, nothing else.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7633);
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
let offset = et(2026, 10, 20, 8).getTime() - RealDate.now();
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
const OCT = (d: number, h: number, mi = 0) => et(2026, 10, d, h, mi);
const TUE = (h: number, mi = 0) => OCT(20, h, mi);
const WED = (h: number, mi = 0) => OCT(21, h, mi);
const THU = (h: number, mi = 0) => OCT(22, h, mi);
const FRI = (h: number, mi = 0) => OCT(23, h, mi);
const SAT = (h: number, mi = 0) => OCT(24, h, mi);
/** a sweep a few seconds after a wall time (the proxied clock keeps ticking) */
const past = (d: Date) => new RealDate(d.getTime() + 20_000);

installNextStubs();
const fence = fenceFetch(() => null); // nothing outbound is allowed at all
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-missing-instructions" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { putSetting, internalAlertRules } = await import("@/lib/settings");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string; at: Date }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body, at: new Date() });
      return { data: { id: `op-${texts.length}` } };
    };
    const mi = await import("@/lib/missingInstructions");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");
    const { appBase } = await import("@/lib/appUrl");

    // =====================================================================
    c.head("1 · The words (pure)");
    // =====================================================================
    const joe = { video: ["the flow and vision for the edit", "the agent's intro script, as delivered on camera"], photos: [] as string[] };
    const sample = mi.composeNudgeText({ firstName: "Harrison", street: "859 N Lawrence St", shotOn: TUE(14), missing: joe, link: "https://hub.example/upload/p1" });
    console.log(`\n--- the shape ---\n${sample}\n---`);
    c.ok("Jordan's shape: who, the job, the shoot day, exactly what is missing, the upload page",
      sample === `${HUB_SMS_PREFIX}: Hi Harrison, 859 N Lawrence St (shot Tue Oct 20) is waiting on you before editing can start: the flow and vision for the edit and the agent's intro script as delivered on camera.\n\nFinish it here:\nhttps://hub.example/upload/p1`, sample);
    c.ok("the next morning says 'still waiting'", mi.composeNudgeText({ firstName: "Harrison", street: "859 N Lawrence St", shotOn: TUE(14), missing: joe, link: "x", again: true }).includes("is still waiting on you"));
    c.ok("photos only: 'before the photos can go out'", mi.composeNudgeText({ firstName: "Harrison", street: "1 A St", shotOn: TUE(9), missing: { video: [], photos: ["the cull confirmation"] }, link: "x" }).includes("waiting on you before the photos can go out: the cull confirmation."));
    const jamesLine = mi.composeManagerLine({ photographerFirst: "Harrison", street: "859 N Lawrence St", shotOn: TUE(14), missing: joe });
    c.ok("James's heads-up", jamesLine === "Heads up: Harrison hasn't sent the instructions for 859 N Lawrence St (shot Oct 20) yet: the flow and vision for the edit and the agent's intro script as delivered on camera. Editing is waiting.", jamesLine);
    c.ok("…and says when Harrison could not be texted", mi.composeManagerLine({ photographerFirst: "Harrison", street: "1 A St", shotOn: TUE(9), missing: joe, unreachable: "no phone on file" }).endsWith("Harrison could not be texted (no phone on file)."));
    c.ok("the list: one, two, three", mi.listWords(["a"]) === "a" && mi.listWords(["a", "b"]) === "a and b" && mi.listWords(["a", "b", "c"]) === "a, b and c");
    c.ok("no dashes in either, even from a dashed input", !DASH.test(sample) && !DASH.test(jamesLine) && !DASH.test(mi.composeNudgeText({ firstName: "H", street: "12 Elm St — Unit 2", shotOn: TUE(9), missing: joe, link: "x" })));
    c.ok("the photos wrap-up words come from its own test's answer", mi.photoWrapUpWords({ missing: true, removal: false, cull: false }).join("|") === "the cull confirmation|the removal notes" && mi.photoWrapUpWords({ missing: false, removal: true, cull: true }).length === 0);
    const { liveAppointment } = await import("@/lib/shootDayText");
    const ap = (status: string, at: Date) => ({ status, startAt: at });
    c.ok("when the shoot is over: the last live visit", mi.shootFinishedAt([ap("SCHEDULED", TUE(9)), ap("SCHEDULED", TUE(18))], null, WED(10), liveAppointment)?.getTime() === TUE(18).getTime());
    c.ok("…a cancelled or postponed visit is not one; all cancelled is never", mi.shootFinishedAt([ap("CANCELED", TUE(9))], TUE(9), WED(10), liveAppointment) === null && mi.shootFinishedAt([ap("UNSCHEDULED", TUE(9))], null, WED(10), liveAppointment) === null);
    c.ok("…a visit still to come holds it; no visits at all reads the shoot date", mi.shootFinishedAt([ap("SCHEDULED", TUE(9)), ap("SCHEDULED", THU(9))], null, WED(10), liveAppointment) === null && mi.shootFinishedAt([], TUE(9), WED(10), liveAppointment)?.getTime() === TUE(9).getTime());

    // =====================================================================
    c.head("2 · The world");
    // =====================================================================
    const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER" | "EDITOR", phone: string | null, extra: { creativeManager?: boolean; opsAlerts?: boolean } = {}) =>
      prisma.teamMember.create({ data: { name, email, role, phone, active: true, ...extra }, select: { id: true, name: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144");
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", { creativeManager: true });
    const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE, { opsAlerts: true });
    await prisma.appUser.create({ data: { email: "kyle@drill.invalid", name: null, role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id } });
    const pat = await member("Pat Rivera", "pat@drill.invalid", "PHOTOGRAPHER", null);
    // Jordan shoots too; the owner's Saturday is quiet until 7:30 PM (notifySchedule's preset).
    const jordan = await member("Jordan Spackman", "info@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111");
    await prisma.appUser.create({ data: { email: "info@drill.invalid", name: null, role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
    const real = await prisma.client.create({ data: { name: "Joe Brennan", phone: "6105550301" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", phone: "6105550302" } });
    let n = 0;
    type D = { type: "PHOTOS" | "VIDEO" | "SOCIAL_REEL" | "DRONE"; videoStyle?: string };
    const job = async (street: string, start: Date, o: { who?: string | null; items?: D[]; appts?: { at: Date; status?: string }[]; clientId?: string; status?: string; data?: Record<string, unknown> } = {}) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Philadelphia, PA`, addressLine: street, clientId: o.clientId ?? real.id, status: (o.status ?? "SHOT") as never, shootDate: start,
          photographerId: o.who === undefined ? harrison.id : o.who,
          deliverables: { create: (o.items ?? [{ type: "PHOTOS" }, { type: "SOCIAL_REEL", videoStyle: "standard_reel_agent_intro" }]).map((d) => ({ type: d.type as never, label: d.type, videoStyle: d.videoStyle ?? null })) },
          ...(o.data ?? {}),
        },
      });
      for (const a of o.appts ?? [{ at: start }]) {
        await prisma.appointment.create({ data: { aryeoId: `appt-${++n}`, projectId: p.id, startAt: a.at, endAt: new Date(a.at.getTime() + 90 * 60_000), status: a.status ?? "SCHEDULED", assignedToId: o.who === undefined ? harrison.id : o.who } });
      }
      return p;
    };
    // Joe's shoot: photos + an agent-intro reel, Harrison, Tue 2 PM, nothing sent.
    const lawrence = await job("859 N Lawrence St", TUE(14));
    // Photos handed in (cull + removals answered), the cinematic's half still owed.
    const halfIn = await job("22 Half In Way", TUE(10), {
      items: [{ type: "PHOTOS" }, { type: "VIDEO", videoStyle: "standard_cinematic" }],
      data: { photosHandoffAt: TUE(20), cullingConfirmedAt: TUE(20), removalNotes: "Trash cans by the garage", shotOrderNotes: "Shot front to back." },
    });
    // James shot this one himself.
    const jamesJob = await job("5 James Ct", TUE(11), { who: james.id });
    // Pat has no phone on file.
    const noPhone = await job("30 No Phone Pl", TUE(12), { who: pat.id });
    // Jordan's own Friday shoot: Saturday morning is his quiet time.
    const ownerJob = await job("40 Owner Shoot Ln", FRI(9), { who: jordan.id });
    // Never asked about:
    const cancelledVisit = await job("11 Cancel Ct", TUE(9), { appts: [{ at: TUE(9), status: "CANCELED" }] });
    const cancelledJob = await job("12 Dead End", TUE(9), { status: "CANCELLED" });
    const testJob = await job("14 Test Rd", TUE(9), { clientId: fixture.id });
    const nobody = await job("15 Nobody Ln", TUE(9), { who: null });
    const plainReel = await job("7 Plain Reel Rd", TUE(9), { items: [{ type: "SOCIAL_REEL", videoStyle: "standard_reel" }] });
    const history = await job("3 Old Shoot Rd", OCT(15, 9));
    const secondVisit = await job("9 Second Visit Rd", TUE(9), { appts: [{ at: TUE(9) }, { at: THU(9) }] });
    c.ok("the world is built", true);

    const textsTo = (digits: string) => texts.filter((t) => t.to.replace(/\D/g, "").endsWith(digits));
    const about = (street: string) => texts.filter((t) => t.body.includes(street));
    const nudgesAbout = (street: string) => about(street).filter((t) => t.body.startsWith(`${HUB_SMS_PREFIX}: Hi `));
    const sweep = (at: Date) => mi.sweepMissingInstructions(setNow(at));
    const lines = async (projectId: string) => (await prisma.activity.findMany({ where: { projectId, type: "SYSTEM" }, orderBy: { createdAt: "asc" } })).map((a) => a.body);

    // =====================================================================
    c.head("3 · The missing list is the handoff engine's");
    // =====================================================================
    const { handoffReadinessOf } = await import("@/lib/tasks");
    const engineInput = await prisma.project.findUniqueOrThrow({
      where: { id: lawrence.id },
      select: {
        orderItems: { where: { isCanceled: false }, select: { title: true } },
        deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, productTitle: true, videoStyle: true, notCompletedReason: true } },
        packageName: true, debriefSubmittedAt: true, videoHandoffAt: true, videoInstructions: true, editorBrief: true, reelScript: true, reelHook: true, scriptConfirmedAt: true, videosFilmed: true,
        photographer: { select: { name: true } },
      },
    });
    const engine = await handoffReadinessOf(engineInput);
    const mine = await mi.missingInstructionsFor(lawrence.id);
    console.log(`\n--- the engine says ---\n${engine.blockedReason}\n---`);
    c.ok("video: exactly the engine's gaps, in its order and words", JSON.stringify(mine?.video) === JSON.stringify(engine.gaps.map((g) => g.label)) && mine!.video.length === 3, JSON.stringify(mine?.video));
    c.ok("…the same words as the 'Raws in … waiting on …' blocker", engine.blockedReason === `Waiting on ${mine!.video.join(", ")} from Harrison Wells.`, engine.blockedReason ?? "");
    const { wrapUpState } = await import("@/lib/photoDelivery/clientAsked");
    const w = await wrapUpState(lawrence.id);
    c.ok("photos: the delivery checklist's wrap-up test (cull not confirmed, removal notes not answered)", !!w?.missing && !w.cull && !w.removal && JSON.stringify(mine?.photos) === JSON.stringify(["the cull confirmation", "the removal notes"]), JSON.stringify(mine?.photos));
    const half = await mi.missingInstructionsFor(halfIn.id);
    c.ok("a half already handed in owes nothing: only the cinematic's brief and its wrap-up", JSON.stringify(half) === JSON.stringify({ video: ["the flow and vision for the edit", "the wrap-up on the upload page"], photos: [] }), JSON.stringify(half));
    const reel = await mi.missingInstructionsFor(plainReel.id);
    c.ok("a plain social reel: nothing demanded, nothing missing (the engine's rule)", reel?.video.length === 0 && reel.photos.length === 0, JSON.stringify(reel));

    // =====================================================================
    c.head("4 · 10 AM the morning after, not before, once");
    // =====================================================================
    c.ok("the switch is ON by default (no settings row)", (await internalAlertRules()).missingInstructions.enabled === true);
    const tue = await sweep(TUE(22));
    c.ok("Tue 10 PM, the shoot day itself: nothing", texts.length === 0 && "considered" in tue && tue.considered === 0, JSON.stringify(tue));
    const early = await sweep(WED(9, 55));
    c.ok("Wed 9:55 AM: nothing, and the run says why", texts.length === 0 && "skipped" in early && /before 10 AM/.test(early.skipped), JSON.stringify(early));
    const [r1, r2] = await Promise.all([sweep(past(WED(10))), mi.sweepMissingInstructions(past(WED(10)))]);
    console.log(`\n--- the two 10:00 runs ---\n${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n---`);
    const h = nudgesAbout("859 N Lawrence St");
    c.ok("Wed 10:00 (two ticks at once): ONE text to Harrison for 859 N Lawrence St", h.length === 1 && h[0].to.endsWith("6105550144"), h.map((t) => t.to).join(","));
    const hb = h[0]?.body ?? "";
    console.log(`\n--- Harrison's text ---\n${hb}\n---`);
    c.ok("…naming exactly what is missing, the shoot day and the upload page",
      hb === `${HUB_SMS_PREFIX}: Hi Harrison, 859 N Lawrence St (shot Tue Oct 20) is waiting on you before editing can start: the flow and vision for the edit, the agent's intro script as delivered on camera, the wrap-up on the upload page, the cull confirmation and the removal notes.\n\nFinish it here:\n${appBase()}/upload/${lawrence.id}`, hb);
    // Which of his lines leads the first digest depends on which twin tick got
    // there first; the queue below holds every one of them either way.
    const jamesTexts = textsTo("6105550133").filter((t) => t.body.includes("Heads up: "));
    c.ok("…and James is pinged at the same time: a bell row per job (Harrison's two, Pat's one), then his text (his Shoot changes switch)", jamesTexts.length >= 1 && jamesTexts.length <= 2 && (await prisma.notification.count({ where: { kind: "instructions_missing", userKey: `tm:${james.id}` } })) === 3, jamesTexts.map((t) => t.body).join(" || "));
    const jb = jamesTexts[0]?.body ?? "";
    console.log(`\n--- James's text ---\n${jb}\n---`);
    const jamesQueue = await prisma.pendingSms.findMany({ where: { teamMemberId: james.id }, orderBy: { createdAt: "asc" } });
    c.ok("James gets one line per job (the later ones wait for his next digest, as every team ping does)", jamesQueue.length === 3 && jamesQueue.some((q) => q.line.includes("859 N Lawrence St (shot Oct 20) yet: the flow and vision for the edit, the agent's intro script as delivered on camera, the wrap-up on the upload page, the cull confirmation and the removal notes. Editing is waiting.")) && jamesQueue.some((q) => q.line.includes("22 Half In Way")), jamesQueue.map((q) => q.line).join(" || "));
    c.ok("…linking the job (a photographer lands on its shoot screen)", jamesQueue.every((q) => q.line.includes(`${appBase()}/projects/`)));
    c.ok("22 Half In Way: Harrison asked for the cinematic's brief only", nudgesAbout("22 Half In Way").length === 1 && nudgesAbout("22 Half In Way")[0].body.includes("before editing can start: the flow and vision for the edit and the wrap-up on the upload page.\n\nFinish it here:"), nudgesAbout("22 Half In Way").map((t) => t.body).join(""));
    const lw = await lines(lawrence.id);
    c.ok("the job's timeline: 'Asked Harrison for the missing instructions at 10:00 AM; James copied.' with the list", lw.length === 1 && lw[0].startsWith("Asked Harrison for the missing instructions at 10:00 AM; James copied. Missing: the flow and vision for the edit,") && !DASH.test(lw[0]), lw.join(" | "));
    const rows = await prisma.outboxMessage.findMany({ where: { projectId: lawrence.id } });
    c.ok("through the durable outbox: one accepted instructions_missing row keyed per job, person and morning, no client on it",
      rows.length === 1 && rows[0].state === "accepted" && rows[0].clientId === null && rows[0].dedupeKey === mi.instructionsNudgeKey(lawrence.id, harrison.id, "2026-10-21"), rows.map((r) => `${r.state} ${r.dedupeKey}`).join(" | "));
    c.ok("the morning is claimed and marked sent", JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: `instructions_missing:${lawrence.id}:2026-10-21` } })).value).state === "sent");
    c.ok("the People page's delivery log has Harrison's text", (await prisma.notificationDelivery.count({ where: { kind: "instructions_missing_text", teamMemberId: harrison.id, channel: "sms", status: "sent" } })) === 2);
    const before = texts.length;
    await sweep(WED(10, 5));
    await sweep(WED(14));
    await sweep(WED(23, 50));
    c.ok("10:05, 2 PM and 11:50 PM: nothing more (once per job per morning)", texts.length === before && (await lines(lawrence.id)).length === 1);

    // =====================================================================
    c.head("5 · Who never gets one, and one message when James shot it");
    // =====================================================================
    const j = nudgesAbout("5 James Ct");
    c.ok("5 James Ct (James shot it): ONE message, his own text, and no bell row to himself", j.length === 1 && j[0].to.endsWith("6105550133") && (await prisma.notification.count({ where: { kind: "instructions_missing", href: `/projects/${jamesJob.id}` } })) === 0 && texts.filter((t) => t.body.includes("5 James Ct")).length === 1);
    c.ok("…its timeline names nobody copied", (await lines(jamesJob.id))[0]?.startsWith("Asked James for the missing instructions at 10:00 AM. Missing:"), (await lines(jamesJob.id)).join(""));
    const patLine = (await prisma.pendingSms.findMany({ where: { teamMemberId: james.id } })).map((q) => q.line).find((l) => l.includes("30 No Phone Pl")) ?? "";
    c.ok("30 No Phone Pl (Pat has no phone): no text, but James hears it, told why", nudgesAbout("30 No Phone Pl").length === 0 && patLine.startsWith("Heads up: Pat hasn't sent the instructions for 30 No Phone Pl (shot Oct 20) yet:") && patLine.includes("Pat could not be texted (no phone on file)."), patLine);
    c.ok("…and its timeline says so", (await lines(noPhone.id))[0]?.startsWith("Could not text Pat for the missing instructions (no phone on file); James told at 10:00 AM. Missing:"), (await lines(noPhone.id)).join(""));
    for (const [what, p] of [["a cancelled visit", cancelledVisit], ["a cancelled job", cancelledJob], ["a test client", testJob], ["no photographer", nobody], ["a plain social reel", plainReel], ["a shoot from before it shipped (Oct 15)", history], ["a visit still to come (Thu)", secondVisit]] as const) {
      c.ok(`${what}: no text, no bell, no line`, about(p.addressLine!).length === 0 && (await prisma.notification.count({ where: { href: `/projects/${p.id}` } })) === 0 && (await lines(p.id)).length === 0);
    }

    // =====================================================================
    c.head("6 · The next morning, the switch, a submitted half, the third morning");
    // =====================================================================
    // 22 Half In Way's video half goes in on Wednesday evening.
    await prisma.project.update({ where: { id: halfIn.id }, data: { videoHandoffAt: WED(19), videoInstructions: "VISION FOR THE EDIT\nOpen on the porch, slow push to the kitchen.\nCOLOR PROFILE: iPhone" } });
    c.ok("22 Half In Way: once its video half is submitted, nothing is missing", JSON.stringify(await mi.missingInstructionsFor(halfIn.id)) === JSON.stringify({ video: [], photos: [] }));
    await putSetting("internal_alerts", { missingInstructions: { enabled: false } });
    c.ok("Settings can switch it off", (await internalAlertRules()).missingInstructions.enabled === false);
    const t0 = texts.length;
    const off = await sweep(past(THU(10)));
    c.ok("Thu 10:00, switched off: nothing at all, and the run says why", texts.length === t0 && "skipped" in off && /switched off/.test(off.skipped), JSON.stringify(off));
    await putSetting("internal_alerts", { missingInstructions: { enabled: true } });
    await sweep(THU(10, 20));
    const h2 = nudgesAbout("859 N Lawrence St");
    c.ok("back on at 10:20: 859 N Lawrence St asked again, 'still waiting'", h2.length === 2 && h2[1].body.includes("is still waiting on you before editing can start"), h2.map((t) => t.body).join(" || "));
    c.ok("…James copied again (a new morning is a new ping), 'still hasn't sent'", (await prisma.notification.count({ where: { kind: "instructions_missing", href: `/projects/${lawrence.id}` } })) === 2 &&
      (await prisma.pendingSms.findMany({ where: { teamMemberId: james.id } })).some((q) => q.line.startsWith("Heads up: Harrison still hasn't sent the instructions for 859 N Lawrence St")));
    c.ok("22 Half In Way: submitted, so no second ask", nudgesAbout("22 Half In Way").length === 1);
    c.ok("9 Second Visit Rd: still nothing on Thursday (its second visit is today)", about("9 Second Visit Rd").length === 0);
    await sweep(past(FRI(10)));
    const h3 = nudgesAbout("859 N Lawrence St");
    c.ok("Fri 10:00, the third morning: asked a third time", h3.length === 3);
    const l3 = await lines(lawrence.id);
    c.ok("…its timeline line says it was the last", l3.length === 3 && l3[2].endsWith("Last of 3 morning asks; the office alerts carry it from here."), l3[2] ?? "");
    c.ok("9 Second Visit Rd: asked on Friday, the morning after its last visit", nudgesAbout("9 Second Visit Rd").length === 1 && nudgesAbout("9 Second Visit Rd")[0].body.includes("(shot Thu Oct 22)"), nudgesAbout("9 Second Visit Rd").map((t) => t.body).join(""));
    // Harrison submits 9 Second Visit Rd's page early on Saturday.
    await prisma.project.update({ where: { id: secondVisit.id }, data: { debriefSubmittedAt: SAT(9), photosHandoffAt: SAT(9), videoHandoffAt: SAT(9), cullingConfirmedAt: SAT(9), removalNotes: "Nothing needs removal — confirmed by the photographer.", videoInstructions: "VISION FOR THE EDIT\nWarm and slow.", reelScript: "Hi, I'm Joe." } });
    const sat = await sweep(past(SAT(10)));
    c.ok("Sat 10:00: 859 N Lawrence St is not asked a fourth time; the run says the office carries it", nudgesAbout("859 N Lawrence St").length === 3 && "done" in sat && sat.done.some((s) => s.startsWith("859 N Lawrence St")), JSON.stringify(sat));
    c.ok("9 Second Visit Rd: its page went in at 9 AM, so Saturday asks nothing", nudgesAbout("9 Second Visit Rd").length === 1);
    c.ok("40 Owner Shoot Ln (Jordan's own Friday shoot): Saturday 10 AM is his quiet time, so nothing yet and the run says so", about("40 Owner Shoot Ln").length === 0 && "waiting" in sat && sat.waiting.some((s) => s.startsWith("40 Owner Shoot Ln to Jordan Spackman: their quiet time")), JSON.stringify(sat));
    await sweep(SAT(19, 35));
    c.ok("…7:35 PM, after it: one text to Jordan, James copied", nudgesAbout("40 Owner Shoot Ln").length === 1 && nudgesAbout("40 Owner Shoot Ln")[0].to.endsWith("6105550111") && (await prisma.notification.count({ where: { kind: "instructions_missing", href: `/projects/${ownerJob.id}` } })) === 1);

    // =====================================================================
    c.head("7 · Wired in");
    // =====================================================================
    const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    const route = src("src/app/api/cron/gmail/route.ts");
    c.ok("the 5-minute comms cron runs it", /step\("missingInstructions"[\s\S]{0,200}sweepMissingInstructions\(\)/.test(route));
    c.ok("…and the outbox drain answers its switch and records its text", route.includes(`kind === "instructions_missing"`) && route.includes("recordDrainedInstructionsText"));
    const { outboxKind, isClientKind } = await import("@/lib/outbox");
    c.ok("the kind is a team kind (never held to the client hours)", outboxKind(mi.instructionsNudgeKey("p", "t", "2026-10-21")) === "instructions_missing" && !isClientKind("instructions_missing"));
    const drained = await mi.recordDrainedInstructionsText({ dedupeKey: mi.instructionsNudgeKey(lawrence.id, harrison.id, "2026-10-22") }, "op-x");
    c.ok("a drained text gets its delivery log line", !!drained && (await prisma.notificationDelivery.count({ where: { kind: "instructions_missing_text", teamMemberId: harrison.id, detail: "op-op-x (recovered)" } })) === 1, drained ?? "");
    const card = src("src/components/settings/OperatingRules.tsx");
    c.ok("its own switch on the Internal alerts card, on by default", /missingInstructions: \{ enabled: true \}/.test(src("src/lib/settings.ts")) && card.includes(`label="Missing instructions, the morning after"`) && card.includes("r.missingInstructions.enabled"));
    const { eventForKind } = await import("@/lib/notifyPrefs");
    c.ok("James's row rides his 'Shoot changes' switch", eventForKind("instructions_missing") === "shoot_change");

    // =====================================================================
    c.head("8 · The fence held");
    // =====================================================================
    c.ok("no outbound call at all (OpenPhone answered in-process, no Slack)", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.join(" "));
    c.ok("only the photographers asked and James were texted; never a client, Kyle or the office line", texts.every((t) => /6105550144$|6105550133$|6105550111$/.test(t.to.replace(/\D/g, ""))), texts.map((t) => t.to).join(","));
    // Our words: every ask, every line queued for James, every timeline line.
    // (The team digest's own "⚙️ Realtour Hub — 2 updates:" header that wraps
    // James's lines when two land in one half hour is notify.ts's, not ours.)
    const ours = [
      ...texts.filter((t) => t.body.startsWith(`${HUB_SMS_PREFIX}: Hi `)).map((t) => t.body),
      ...(await prisma.pendingSms.findMany({ where: { teamMemberId: james.id } })).map((q) => q.line),
      ...(await prisma.activity.findMany({ where: { type: "SYSTEM" } })).map((a) => a.body),
    ];
    const dashed = ours.filter((b) => DASH.test(b));
    c.ok("no dashes in any ask, any line for James, any timeline line", ours.length >= 12 && dashed.length === 0, dashed.join(" || ") || `${ours.length} checked`);
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

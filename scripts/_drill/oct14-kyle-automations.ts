// ---------------------------------------------------------------------------
// DRILL: KYLE'S REMINDERS, AUTOMATED (Oct 14 2026 comms audit).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct14-kyle-automations.ts
//
// Isolated PGlite; fetch and raw sockets fenced; Slack and OpenPhone answered
// in-process; the Smart Brain stubbed at its one function (routeCommTask) so
// everything around it is the shipped code. The clock is pinned to a real week
// (Mon Oct 19 to Sun Oct 25 2026, EDT; coverage Mon to Fri 9 to 6).
//
//   1. Leads go to Kyle; 15 and 60 covered-minute pings, once each, never for
//      a touched lead or an old one, counted in covered time; spam cancelled.
//   2. A client's access note lands on the shoot brief (/shoot, Ops Day), its
//      to-do closes, the photographer inside 24h hears it once; a "when will
//      it be ready" reply task carries the promise and stage.
//   3. Jordan's 6 PM wrap: content, under 15 lines, no dashes, one per day,
//      Kyle's copy without money, Saturday held to 7:30 PM, Sunday none.
//   4. The night-before brief: content, one per shoot, the switch, the access
//      task for Kyle and its close.
//   5. The promise watch: 3 covered hours before, stage from the PhotoJob,
//      the evening before, once per promise, nothing sent. CHANGED Oct 27
//      2026 (Jordan's Loom, 40:34: "only at risk if they're late"): the
//      heads-up DM stays, but no client draft is written before the promise;
//      a watch draft written after it still closes on delivery and follows
//      what is still owed.
//   6. Slack asks close on evidence and NOT when ambiguous; Jordan's asks do
//      not expire; the morning digest lists them.
//   7. AutoHDR mail: newsletters ignored, the API mutes the mail task, stale
//      tasks closed.
//   8. The fence stayed closed and no client was sent anything.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6715);

// ---- the clock -------------------------------------------------------------
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
let offset = et(2026, 10, 19, 8).getTime() - RealDate.now();
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
const MON = (h: number, mi = 0) => et(2026, 10, 19, h, mi);
const TUE = (h: number, mi = 0) => et(2026, 10, 20, h, mi);
const WED = (h: number, mi = 0) => et(2026, 10, 21, h, mi);
const THU = (h: number, mi = 0) => et(2026, 10, 22, h, mi);
const FRI = (h: number, mi = 0) => et(2026, 10, 23, h, mi);
const SAT = (h: number, mi = 0) => et(2026, 10, 24, h, mi);
const SUN = (h: number, mi = 0) => et(2026, 10, 25, h, mi);
// The proxied clock keeps ticking in real milliseconds, so a sweep exactly on a
// boundary can land a few ms short of it; boundary sweeps run 30 s past.
const past = (d: Date) => new RealDate(d.getTime() + 30_000);

// ---- the brain, stubbed at its one function ---------------------------------
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo" };
let nextDecision: Decision | null = null;
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "routeCommTask") return async () => nextDecision;
      return t[k];
    },
  }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "getCurrentUser") return async () => null;
      return t[k];
    },
  }),
);
installNextStubs();

// ---- Slack, answered in-process -------------------------------------------
type SlackPost = { channel: string; text: string; at: Date };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "", at: new Date() });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001", james: "U0JAMES001" };
const DASH = /[\u2013\u2014]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const op = await import("@/lib/integrations/openphone");
  const OFFICE = "+16105550100";
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
  const texts: { to: string; body: string; at: Date }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    texts.push({ to: String(to), body, at: new Date() });
    return { data: { id: `op-${texts.length}` } };
  };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // ---- the cast, as production has it --------------------------------------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole, phone: string | null, slackId: string | null) =>
    prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true }, select: { id: true, name: true } });
  const jordan = await member("Jordan Spackman", "info@realtourpilot.com", "PHOTOGRAPHER", "(610) 555-0111", S.jordan);
  const kyle = await member("Kyle Smith", "hello@realtourpilot.com", "MANAGER", OFFICE, S.kyle);
  const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144", null);
  const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", S.james);
  const login = (email: string, role: string, tm: string) => prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm }, select: { id: true } });
  await login("info@realtourpilot.com", "OWNER", jordan.id);
  const uKyle = await login("hello@realtourpilot.com", "ADMIN", kyle.id);
  await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
  await login("james@drill.invalid", "ADMIN", james.id);
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });

  const dmsTo = (slackId: string, re?: RegExp) => slack.filter((m) => m.channel === slackId && (!re || re.test(m.text)));
  const textsTo = (digits: string) => texts.filter((t) => t.to.replace(/\D/g, "").endsWith(digits));
  const mkClient = (name: string, phone?: string) => prisma.client.create({ data: { name, phone: phone ?? null }, select: { id: true, name: true } });

  // =========================================================================
  c.head("1 · Leads go to Kyle, with a speed-to-lead ping");
  // =========================================================================
  const { upsertPhoneLeadTask } = await import("@/lib/webhooks/openphone");
  const desk = await import("@/lib/leadDesk");
  // A lead from before this shipped: open, no episode marker.
  const oldLead = await prisma.smartTask.create({ data: { taskType: "lead", title: "New caller: call back (610) 555-0001", source: "openphone", status: "OPEN", dedupeKey: "lead-6105550001", createdAt: MON(9, 0) } });
  setNow(MON(10, 0));
  await upsertPhoneLeadTask({ phone: "6105550199", kind: "text", senderName: null, snippet: "Hi, do you shoot listings in Malvern this week?" });
  const lead = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: "lead-6105550199" } });
  c.ok("the new texter is a lead on Kyle's list (assignedKey kyle, ownerId Kyle's roster row, from the delivery duty)", lead.assignedKey === "kyle" && lead.ownerId === kyle.id, `${lead.assignedKey} ${lead.ownerId === kyle.id}`);
  const leadPings = () => dmsTo(S.kyle, /New lead still waiting/);
  await desk.sweepLeadPings(setNow(MON(10, 10)));
  c.ok("10 minutes: no ping yet", leadPings().length === 0);
  await Promise.all([desk.sweepLeadPings(setNow(past(MON(10, 15)))), desk.sweepLeadPings(past(MON(10, 15)))]);
  c.ok("15 covered minutes: ONE Slack DM to Kyle, even with two sweeps at once", leadPings().length === 1, leadPings().map((m) => m.text).join(" | "));
  c.ok("…it names the lead and what they said, and links the task", /Malvern/.test(leadPings()[0]?.text ?? "") && leadPings()[0].text.includes(lead.id));
  c.ok("…a bell row addressed to Kyle too", (await prisma.notification.count({ where: { kind: "lead_waiting", userKey: `tm:${kyle.id}` } })) === 1);
  await desk.sweepLeadPings(setNow(MON(10, 40)));
  c.ok("40 minutes: still one", leadPings().length === 1);
  await desk.sweepLeadPings(setNow(past(MON(11, 0))));
  c.ok("60 covered minutes: the second ping", leadPings().length === 2 && /an hour/.test(leadPings()[1].text));
  await desk.sweepLeadPings(setNow(MON(11, 30)));
  await desk.sweepLeadPings(setNow(MON(14, 0)));
  c.ok("…and never a third", leadPings().length === 2);
  c.ok("the pre-existing lead (no episode) was never pinged", !leadPings().some((m) => m.text.includes(oldLead.id)));
  c.ok("no lead ping text carries a dash", leadPings().every((m) => !DASH.test(m.text)));

  // A touched lead (Kyle started it) is not pinged.
  setNow(MON(12, 0));
  await upsertPhoneLeadTask({ phone: "6105550188", kind: "call", senderName: "Dana Doe", snippet: "" });
  const touched = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: "lead-6105550188" } });
  await prisma.smartTask.update({ where: { id: touched.id }, data: { status: "IN_PROGRESS" } });
  await desk.sweepLeadPings(setNow(MON(13, 30)));
  c.ok("a lead Kyle already picked up is never pinged", !leadPings().some((m) => m.text.includes(touched.id)));

  // A lead at 5:55 PM: counted in covered time.
  setNow(MON(17, 55));
  await upsertPhoneLeadTask({ phone: "6105550177", kind: "voicemail", senderName: null, snippet: "Looking for a twilight shoot" });
  const late = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: "lead-6105550177" } });
  const latePings = () => leadPings().filter((m) => m.text.includes(late.id));
  await desk.sweepLeadPings(setNow(MON(18, 30)));
  await desk.sweepLeadPings(setNow(MON(23, 0)));
  c.ok("5:55 PM lead: nothing in the evening (outside covered hours)", latePings().length === 0);
  await desk.sweepLeadPings(setNow(TUE(9, 5)));
  c.ok("…nothing at 9:05 the next morning (10 covered minutes)", latePings().length === 0);
  await desk.sweepLeadPings(setNow(past(TUE(9, 10))));
  c.ok("…the 15-minute ping at 9:10 (5 + 10 covered minutes)", latePings().length === 1);

  // Home: Kyle's leads.
  const kyleLeads = await desk.openLeadsFor({ isOwner: false, key: "kyle", teamMemberId: kyle.id });
  c.ok("Kyle's Home lists his open leads (the Home needs card reads openLeadsFor)", kyleLeads.some((l) => l.id === lead.id) && kyleLeads.some((l) => l.id === late.id));

  // The switch.
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null }, leadPing: { enabled: false } });
  setNow(TUE(10, 0));
  await upsertPhoneLeadTask({ phone: "6105550166", kind: "text", senderName: null, snippet: "Price for drone?" });
  const off = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: "lead-6105550166" } });
  const offRun = await desk.sweepLeadPings(setNow(TUE(10, 30)));
  c.ok("switched off: still assigned to Kyle, no ping", off.assignedKey === "kyle" && !leadPings().some((m) => m.text.includes(off.id)) && /switched off/.test(offRun.skipped ?? ""));
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });

  // Delivery owner unresolved: the lead stays unassigned (no name guess).
  await prisma.programOwnerAssignment.updateMany({ where: { duty: "DELIVERY" }, data: { teamMemberId: null, appUserId: null } });
  setNow(TUE(10, 40));
  await upsertPhoneLeadTask({ phone: "6105550155", kind: "text", senderName: null, snippet: "Hello?" });
  const unres = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: "lead-6105550155" } });
  c.ok("no delivery owner → the lead is left unassigned, as before (never matched by name)", unres.assignedKey === null && unres.ownerId === null);
  await prisma.programOwnerAssignment.updateMany({ where: { duty: "DELIVERY" }, data: { teamMemberId: kyle.id, appUserId: uKyle.id } });

  // Spam: a muted number's lead, untouched 7 days, is cancelled (not deleted).
  const spam = await prisma.smartTask.create({ data: { taskType: "lead", title: "New texter: reply to (610) 555-0144x", source: "openphone", status: "OPEN", dedupeKey: "lead-6105550122", createdAt: et(2026, 10, 10, 10) } });
  const notSpam = await prisma.smartTask.create({ data: { taskType: "lead", title: "New texter: old", source: "openphone", status: "OPEN", dedupeKey: "lead-6105550133", createdAt: et(2026, 10, 10, 10) } });
  await prisma.appSetting.create({ data: { key: "comms-mute:6105550122", value: `${et(2026, 10, 11, 10).toISOString()}|spam` } });
  const sp = await desk.cancelSpamLeads(setNow(TUE(11, 0)));
  const spamAfter = await prisma.smartTask.findUnique({ where: { id: spam.id } });
  c.ok("a muted number's lead untouched 7+ days is CANCELLED with the reason (row kept)", sp.cancelled === 1 && spamAfter?.status === "CANCELLED" && /muted as spam/.test(spamAfter.summary ?? ""));
  c.ok("…an un-muted old lead is left alone", (await prisma.smartTask.findUnique({ where: { id: notSpam.id } }))?.status === "OPEN");

  // =========================================================================
  c.head("2 · A client's access note goes on the shoot brief");
  // =========================================================================
  const { recordClientCommunication } = await import("@/lib/comms");
  const { getShoot } = await import("@/lib/shoot");
  const { buildOpsDay } = await import("@/lib/opsDay");
  const jane = await mkClient("Jane Client", "6105550301");
  const oak = await prisma.project.create({ data: { title: "12 Oak St, Royersford, PA", addressLine: "12 Oak St", clientId: jane.id, status: "SCHEDULED", shootDate: WED(10), photographerId: harrison.id } });
  await prisma.deliverable.create({ data: { projectId: oak.id, type: "PHOTOS", label: "Photos", quantity: 1 } });
  setNow(TUE(14, 0)); // 20 hours before the shoot
  nextDecision = { actionable: true, projectId: oak.id, title: "Note gate code and parking for 12 Oak St shoot", detail: "Client sent the gate code and where to park.", priority: "MEDIUM", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "access info", taskType: "todo" };
  const msg = "The gate code is 4417, please park in the driveway.";
  await recordClientCommunication({ clientId: jane.id, clientName: jane.name, projectId: oak.id, text: msg, kind: "text", source: "openphone", commLogId: "cl-gate-1", contactName: "Jane Client" });
  const reqs = await prisma.activity.findMany({ where: { projectId: oak.id, type: "SPECIAL_REQUEST" } });
  // Oct 15 2026: labelled as an access note, so it never reaches an editor's brief (specialRequests.ts); /shoot strips it like the others.
  c.ok("the note is a SPECIAL_REQUEST on the job, labelled as an access note /shoot strips", reqs.length === 1 && reqs[0].body === `Client access note (openphone): ${msg}`, reqs.map((r) => r.body).join(" | "));
  const { requestsForEditors, stripRequestLabel } = await import("@/lib/specialRequests");
  c.ok("…and no editor's brief, packet or PDF ever lists it", requestsForEditors(reqs, { video: true }).length === 0 && requestsForEditors(reqs, { video: false }).length === 0 && stripRequestLabel(reqs[0].body) === msg);
  const todo = await prisma.smartTask.findFirst({ where: { clientId: jane.id, taskType: "todo" } });
  c.ok("the to-do the brain opened for it is COMPLETED, saying where the words went", todo?.status === "COMPLETED" && /Added to the shoot brief/.test(todo.summary ?? ""), `${todo?.status} ${todo?.summary}`);
  const shootView = await getShoot(oak.id);
  c.ok("/shoot lists it", !!shootView?.specialRequests.some((r) => r.includes("4417")));
  const opsTue = await buildOpsDay();
  c.ok("Ops Day's tomorrow card lists it", !!opsTue.tomorrowShoots.find((s) => s.id === oak.id)?.specialRequests.some((r) => r.includes("4417")));
  const harrisonNotes = () => textsTo("6105550144").filter((t) => /Note from the client/.test(t.body));
  c.ok("the photographer (shoot within 24h) got it once, by text", harrisonNotes().length === 1 && /4417/.test(harrisonNotes()[0].body) && !DASH.test(harrisonNotes()[0].body));
  await recordClientCommunication({ clientId: jane.id, clientName: jane.name, projectId: oak.id, text: msg, kind: "text", source: "openphone", commLogId: "cl-gate-1", contactName: "Jane Client" });
  c.ok("the same message replayed: still one brief line, one text", (await prisma.activity.count({ where: { projectId: oak.id, type: "SPECIAL_REQUEST" } })) === 1 && harrisonNotes().length === 1);
  // Not an access note.
  nextDecision = { ...nextDecision, title: "Confirm whether 2pm works for 12 Oak St", detail: "Client asks to move the time.", taskType: "client_reply" };
  await recordClientCommunication({ clientId: jane.id, clientName: jane.name, projectId: oak.id, text: "Can we move it to 2pm instead?", kind: "text", source: "openphone", commLogId: "cl-move-1", contactName: "Jane Client" });
  c.ok("a reschedule ask is not filed on the brief", (await prisma.activity.count({ where: { projectId: oak.id, type: "SPECIAL_REQUEST" } })) === 1);
  // A shoot three days out: filed, nobody texted.
  const elm = await prisma.project.create({ data: { title: "4 Elm Rd, Malvern, PA", addressLine: "4 Elm Rd", clientId: jane.id, status: "SCHEDULED", shootDate: FRI(11), photographerId: harrison.id } });
  nextDecision = { ...nextDecision, projectId: elm.id, title: "Note lockbox code for 4 Elm Rd shoot", detail: "Lockbox code.", taskType: "todo" };
  await recordClientCommunication({ clientId: jane.id, clientName: jane.name, projectId: elm.id, text: "Lockbox code for 4 Elm is 8812, key is in the lockbox on the side door.", kind: "text", source: "openphone", commLogId: "cl-lock-2", contactName: "Jane Client" });
  c.ok("a shoot 3 days out: on the brief, the photographer is not texted yet", (await prisma.activity.count({ where: { projectId: elm.id, type: "SPECIAL_REQUEST" } })) === 1 && harrisonNotes().length === 1);

  // "When will it be ready?" carries the promise and the stage.
  const sold = await prisma.project.create({ data: { title: "9 Pine Ln, Royersford, PA", clientId: jane.id, status: "EDITING", shootDate: MON(9), promisedDueAt: TUE(17), statusEvidence: JSON.stringify({ expected: ["Photos"], present: [], missing: ["Photos"], dropbox: { rawPhotos: 210, rawVideo: 0, finalPhotos: 0, finalVideo: 0 }, aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: "UNDELIVERED" } }) } });
  nextDecision = { ...nextDecision, projectId: sold.id, title: "Reply with when the 9 Pine Ln photos will be ready", detail: "Client asks for an ETA.", taskType: "client_reply" };
  await recordClientCommunication({ clientId: jane.id, clientName: jane.name, projectId: sold.id, text: "When will the photos for 9 Pine be ready?", kind: "text", source: "openphone", commLogId: "cl-eta-1", contactName: "Jane Client" });
  const replyTask = await prisma.smartTask.findFirst({ where: { clientId: jane.id, projectId: sold.id, taskType: "client_reply" } });
  c.ok("the reply task for \"when will it be ready\" carries the promise and where the job stands", /^Promise on file: Tue, Oct 20, 5:00 PM ET\. Now: raws in \(210\)/.test(replyTask?.summary ?? ""), replyTask?.summary ?? "none");
  nextDecision = null;

  // =========================================================================
  c.head("3 · Jordan's 6 PM wrap");
  // =========================================================================
  const eve = await import("@/lib/eveningPush");
  const ev = (o: Record<string, unknown>) => JSON.stringify({ expected: ["Photos"], present: [], missing: ["Photos"], dropbox: { rawPhotos: 150, rawVideo: 0, finalPhotos: 0, finalVideo: 0 }, aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: "UNDELIVERED" }, ...o });
  const rick = await mkClient("Rick Schultz", "6105550302");
  await prisma.project.create({ data: { title: "1 Done Ave, Royersford, PA", clientId: rick.id, status: "DELIVERED", shootDate: MON(10), deliveredAt: TUE(11), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1, status: "DONE", uploadedAt: MON(15) }] } } });
  await prisma.project.create({ data: { title: "22 Hill Rd, Malvern, PA", clientId: rick.id, status: "EDITING", shootDate: et(2026, 10, 16, 10), statusEvidence: ev({}), editorId: null, photographerId: harrison.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1, uploadedAt: et(2026, 10, 16, 15) }] } } });
  // Jordan's ask to Kyle, 4 days old, with a figure in it; Kyle's ask to Jordan.
  await prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "slack", title: "Send Andrea's updated order with $750 credit applied", contactName: "Jordan", assignedKey: "kyle", ownerId: kyle.id, status: "OPEN", dedupeKey: "slack-1000.1", createdAt: et(2026, 10, 16, 9) } });
  await prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "slack", title: "Approve the reshoot for 3 Bay St", contactName: "Kyle Smith", assignedKey: "jordan", ownerId: jordan.id, status: "OPEN", dedupeKey: "slack-1000.2", createdAt: MON(16) } });
  await prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: rick.id, clientName: rick.name, body: "Any chance you can shoot Friday?", occurredAt: TUE(15), source: "openphone", externalId: "op-rick-1" } });
  const wrapsTo = (id: string) => slack.filter((m) => m.channel === id && /6 PM wrap/.test(m.text));
  await eve.runEveningAutomations(setNow(TUE(17, 55)));
  c.ok("5:55 PM: no wrap yet", wrapsTo(S.jordan).length === 0);
  const r1 = await eve.runEveningAutomations(setNow(TUE(18, 5)));
  const jWrap = wrapsTo(S.jordan);
  const kWrap = wrapsTo(S.kyle);
  c.ok("6:05 PM Tuesday: ONE Slack DM to Jordan (the OWNER login's roster row)", jWrap.length === 1, JSON.stringify(r1.push));
  c.ok("…and ONE copy to Kyle", kWrap.length === 1 && /^Copy of Jordan's 6 PM wrap/.test(kWrap[0].text));
  const wrap = jWrap[0]?.text ?? "";
  console.log(`\n--- the wrap as Jordan reads it ---\n${wrap}\n---`);
  c.ok("under 15 lines", wrap.split("\n").length <= 15, String(wrap.split("\n").length));
  c.ok("no em or en dashes in either copy", !DASH.test(wrap) && !DASH.test(kWrap[0]?.text ?? ""));
  c.ok("delivered today names 1 Done Ave", /Delivered today \(1\): 1 Done Ave/.test(wrap));
  c.ok("late names 22 Hill Rd with its stage and owner", /Late \(\d+\): [^\n]*22 Hill Rd \([^)]*, (Harrison|Kyle)\)/.test(wrap));
  c.ok("due by 9 AM tomorrow line is there", /Due by 9 AM tomorrow, not out \(\d+\)/.test(wrap));
  c.ok("Kyle's ask to Jordan is listed", /Kyle's asks to you \(1\): Approve the reshoot for 3 Bay St/.test(wrap));
  c.ok("Jordan's 4-day-old ask to Kyle is listed (no longer expires silently)", /Your asks to Kyle open 3\+ days \(1\)/.test(wrap));
  c.ok("unanswered clients names Rick", /Unanswered clients \(\d+\): [^\n]*Rick Schultz/.test(wrap));
  c.ok("tomorrow's shoots and gaps", /Tomorrow: \d+ shoots?, \d+ gaps?/.test(wrap));
  c.ok("Kyle's copy carries no dollar figure (Jordan's own copy may)", /\$750/.test(wrap) && !/\$\s?\d/.test(kWrap[0]?.text ?? ""));
  await Promise.all([eve.runEveningAutomations(setNow(TUE(18, 10))), eve.runEveningAutomations(TUE(18, 10))]);
  await eve.runEveningAutomations(setNow(TUE(19, 30)));
  c.ok("the next ticks (two at once, and 7:30) send nothing more", wrapsTo(S.jordan).length === 1 && wrapsTo(S.kyle).length === 1);
  // Saturday: Jordan's quiet window holds it to 7:30 PM; Kyle's goes now.
  const sched = await import("@/lib/notifySchedule");
  await eve.runEveningAutomations(setNow(SAT(18, 5)));
  const held = (await prisma.appSetting.findMany({ where: { key: { startsWith: sched.HELD_DM_PREFIX } } })).map((r) => JSON.parse(r.value) as { teamMemberId: string; text: string; until: string });
  const jHeld = held.filter((h) => h.teamMemberId === jordan.id && /6 PM wrap/.test(h.text));
  c.ok("Saturday 6 PM: Jordan's wrap is HELD until 7:30 PM (his quiet time), not sent", jHeld.length === 1 && new Date(jHeld[0].until).getTime() === SAT(19, 30).getTime() && wrapsTo(S.jordan).length === 1);
  c.ok("…Kyle's Saturday copy goes now", wrapsTo(S.kyle).length === 2);
  await eve.runEveningAutomations(setNow(SUN(18, 5)));
  c.ok("Sunday: no wrap", wrapsTo(S.kyle).length === 2 && !(await prisma.appSetting.findUnique({ where: { key: "evening-push:2026-10-25" } })));
  const composed = eve.composeEveningWrap({
    now: TUE(18, 0), day: { ...opsTue, closeout: { ...opsTue.closeout } }, board: { today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0 },
    editorOf: new Map(), kyleFirst: "Kyle", kyleAsks: [], jordanAsksOld: [], cutsWaitingOnJordan: 2, photoDecisions: 1, link: "https://hub.invalid/",
  });
  c.ok("composition: cuts and photo decisions waiting on Jordan get their own line", composed.lines.some((l) => l === "Waiting on you: 2 cuts to review, 1 photo job needing a QC decision"));

  // =========================================================================
  c.head("4 · The night-before shoot brief");
  // =========================================================================
  // Tuesday's run already briefed Wednesday's 12 Oak St shoot; read what went.
  const oakBrief = textsTo("6105550144").filter((t) => /Shoot brief for tomorrow/.test(t.body));
  c.ok("Tuesday 6 PM: Harrison got ONE brief for Wednesday's 12 Oak St", oakBrief.length === 1, String(oakBrief.length));
  c.ok("…with the client's gate note from section 2", /4417/.test(oakBrief[0]?.body ?? ""));
  // Thursday's shoots, briefed Wednesday evening.
  const bay = await prisma.project.create({
    data: {
      title: "3 Bay St, Phoenixville, PA", addressLine: "3 Bay St", clientId: rick.id, status: "SCHEDULED", shootDate: THU(10), photographerId: harrison.id, squareFeet: 2000,
      orderItems: { create: [{ title: "35 Photos", quantity: 1 }, { title: "Drone Photos", quantity: 5 }, { title: "Zillow 3D Home Tour", quantity: 1 }, { title: "Travel Fee", quantity: 1, amount: 25 }] },
      deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }, { type: "DRONE", label: "Drone", quantity: 5 }, { type: "ZILLOW_3D", label: "Zillow 3D", quantity: 1 }] },
      appointments: { create: [{ aryeoId: "appt-bay", startAt: THU(10), endAt: THU(11, 30), status: "SCHEDULED", description: "Customer:\nName: Rick Schultz\nEmail: rick@clients.invalid\n\nOrder Questions:\n - Lock Box / Door Code: 1923\n - Will you or the seller be present at the appointment?: Vacant\n\nOr View Full Order Details" }] },
    },
  });
  const noAccess = await prisma.project.create({ data: { title: "8 Mill Rd, Phoenixville, PA", addressLine: "8 Mill Rd", clientId: rick.id, status: "SCHEDULED", shootDate: THU(13), photographerId: james.id, deliverables: { create: [{ type: "VIDEO", label: "Listing Reel", quantity: 1 }] } } });
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null }, photographerBrief: { enabled: false } });
  await eve.runEveningAutomations(setNow(WED(18, 5)));
  const bayBriefs = () => textsTo("6105550144").filter((t) => /Shoot brief for tomorrow/.test(t.body) && /3 Bay St/.test(t.body));
  c.ok("switched off: no brief goes", bayBriefs().length === 0);
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });
  await Promise.all([eve.runEveningAutomations(setNow(WED(18, 15))), eve.runEveningAutomations(WED(18, 15))]);
  await eve.runEveningAutomations(setNow(WED(19, 0)));
  const bb = bayBriefs();
  c.ok("switched back on: ONE brief to Harrison for 3 Bay St (twin ticks and a later tick add none)", bb.length === 1, String(bb.length));
  const b = bb[0]?.body ?? "";
  console.log(`\n--- Harrison's brief ---\n${b}\n---`);
  c.ok("…time and address", /Thu, Oct 22/.test(b) && /10:00 AM/.test(b) && /3 Bay St, Phoenixville, PA/.test(b));
  c.ok("…exactly what was ordered, fees left out", /35 Photos; 5 x Drone Photos; Zillow 3D Home Tour/.test(b) && !/Travel Fee/.test(b));
  c.ok("…access from the appointment", /Lockbox \/ door code: 1923/.test(b) && /Seller present: Vacant/.test(b));
  c.ok("…and the photo target", /Photo target: 35 to 45 finals, no more than 50/.test(b));
  c.ok("…no dashes, no money", !DASH.test(b) && !/\$\d/.test(b));
  const jamesBrief = dmsTo(S.james, /Shoot brief for tomorrow/);
  c.ok("James (Slack) got his brief for 8 Mill Rd, saying access is not on file", jamesBrief.length === 1 && /8 Mill Rd/.test(jamesBrief[0].text) && /nothing on file yet/.test(jamesBrief[0].text));
  const accessTasks = () => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: eve.ACCESS_TASK_PREFIX } } });
  let at1 = await accessTasks();
  c.ok("ONE access task for Kyle for 8 Mill Rd (and none for 3 Bay St)", at1.length === 1 && at1[0].projectId === noAccess.id && at1[0].assignedKey === "kyle" && at1[0].ownerId === kyle.id);
  await prisma.activity.create({ data: { projectId: noAccess.id, type: "SPECIAL_REQUEST", body: "Client request (openphone): code 5521 at the side door" } });
  await eve.closeResolvedAccessTasks(setNow(WED(19, 30)));
  at1 = await accessTasks();
  c.ok("access on file → the task closes itself", at1[0]?.status === "COMPLETED");
  void bay;

  // =========================================================================
  c.head("5 · The delivery watch before the promise");
  // =========================================================================
  const pw = await import("@/lib/promiseWatch");
  const nina = await mkClient("Nina Park", "6105550303");
  const watched = await prisma.project.create({ data: { title: "5 Watch St, Royersford, PA", clientId: nina.id, status: "EDITING", shootDate: WED(9), promisedDueAt: THU(15), statusEvidence: ev({ dropbox: { rawPhotos: 200, rawVideo: 0, finalPhotos: 0, finalVideo: 0 } }), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } } });
  await prisma.smartTask.create({ data: { taskType: "media_qa", title: "QC & deliver: 5 Watch St", projectId: watched.id, status: "OPEN", source: "system", dedupeKey: "qc-watch" } });
  await prisma.photoJob.create({ data: { projectId: watched.id, stage: "QC_REVIEW", finalsCount: 42 } });
  const watchDms = () => dmsTo(S.kyle, /Promise check: 5 Watch St/);
  await pw.sweepPromiseWatch(setNow(THU(11, 30)));
  c.ok("3.5 covered hours before: nothing", watchDms().length === 0);
  await Promise.all([pw.sweepPromiseWatch(setNow(THU(12, 0))), pw.sweepPromiseWatch(THU(12, 0))]);
  c.ok("3 covered hours before: ONE Slack DM to Kyle (two sweeps at once)", watchDms().length === 1);
  const wd = watchDms()[0]?.text ?? "";
  console.log(`\n--- the watch DM ---\n${wd}\n---`);
  c.ok("…with the stage: raws in, the PhotoJob's stage and finals, the listing, the QC card, not delivered", /raws in \(200\)/.test(wd) && /QC needs a decision, 42 finals/.test(wd) && /no edited photos on the listing yet/.test(wd) && /QC card open/.test(wd) && /not delivered/.test(wd));
  c.ok("…no dashes", !DASH.test(wd));
  c.ok("…and NO \"running behind\" client draft before the promise (Oct 27 2026: late only)", (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: watched.id } })) === 0);
  const { foreignDates, autoDraftAtRiskUpdate } = await import("@/lib/atRiskUpdates");
  await pw.sweepPromiseWatch(setNow(THU(13, 0)));
  c.ok("…once per job per promise", watchDms().length === 1 && (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: watched.id } })) === 0);
  await prisma.project.update({ where: { id: watched.id }, data: { promisedDueAt: THU(17, 30) } });
  await pw.sweepPromiseWatch(setNow(THU(14, 30)));
  c.ok("a moved promise is watched again", watchDms().length === 2);
  // Next-morning promise: the afternoon before (3 covered hours = 3:30 PM for 9:30 AM).
  const morning = await prisma.project.create({ data: { title: "7 Dawn Ct, Royersford, PA", clientId: nina.id, status: "EDITING", shootDate: THU(9), promisedDueAt: FRI(9, 30), statusEvidence: ev({}), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } } });
  await pw.sweepPromiseWatch(setNow(THU(15, 25)));
  c.ok("a 9:30 AM promise: nothing at 3:25 PM the day before", dmsTo(S.kyle, /7 Dawn Ct/).length === 0);
  await pw.sweepPromiseWatch(setNow(THU(15, 30)));
  c.ok("…the DM at 3:30 PM the day before (2.5 covered hours tonight + 0.5 tomorrow)", dmsTo(S.kyle, /Promise check: 7 Dawn Ct/).length === 1);
  // A promise set after hours with no covered time left before it: told at once.
  await prisma.project.create({ data: { title: "2 Night Rd, Royersford, PA", clientId: nina.id, status: "EDITING", shootDate: THU(8), promisedDueAt: FRI(9, 0), statusEvidence: ev({}), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } } });
  await pw.sweepPromiseWatch(setNow(THU(19, 0)));
  c.ok("a 9 AM promise first seen at 7 PM: told that evening", dmsTo(S.kyle, /Promise check: 2 Night Rd/).length === 1);
  // Past the moved promise (5:30 PM), still out: the draft may be written now.
  const draft = await autoDraftAtRiskUpdate({ projectId: watched.id, promisedAt: THU(17, 30), now: THU(19, 0) });
  const draftRow = draft.ok ? await prisma.smartTask.findUnique({ where: { id: draft.taskId } }) : null;
  c.ok("past the promise, a watch draft is written on Kyle's list (never sent)", !!draftRow && draftRow.status === "OPEN" && draftRow.assignedKey === "kyle" && /running behind the time we promised \(Thu, Oct 22, 5:30 PM ET\)/.test(draftRow.description ?? ""), draftRow?.description ?? (draft.ok ? "none" : draft.message));
  c.ok("…naming no date but the recorded promise", foreignDates(draftRow?.description ?? "", [THU(17, 30)]) === null);
  // Delivered: the draft closes itself.
  await prisma.project.update({ where: { id: watched.id }, data: { status: "DELIVERED", deliveredAt: THU(19, 2) } });
  await pw.sweepPromiseWatch(setNow(THU(19, 5)));
  c.ok("the job went out → its watch draft is closed, saying nothing was sent", (await prisma.smartTask.findFirst({ where: { id: draftRow?.id } }))?.status === "CANCELLED");
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null }, promiseWatch: { enabled: false } });
  await prisma.project.create({ data: { title: "6 Off St, Royersford, PA", clientId: nina.id, status: "EDITING", shootDate: THU(8), promisedDueAt: FRI(11, 0), statusEvidence: ev({}), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } } });
  await pw.sweepPromiseWatch(setNow(FRI(9, 0)));
  c.ok("switched off: no DM", dmsTo(S.kyle, /6 Off St/).length === 0);
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });
  void morning;
  // Oct 23 2026 (Jordan, 30 Caedman Dr: "Hub is saying photos aren't
  // delivered … It's just the floorplan that's missing"): a job that delivers
  // part of its order stays open as a whole; its watch draft names only what
  // is still owed, and a text a person rewrote keeps its words.
  const partEv = (present: string[], missing: string[]) => ev({ expected: ["Photos", "Floor plan"], present, missing });
  const part = await prisma.project.create({ data: { title: "30 Part St, Royersford, PA", clientId: nina.id, status: "EDITING", shootDate: THU(9), promisedDueAt: FRI(16, 0), statusEvidence: partEv([], ["Photos", "Floor plan"]), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }, { type: "FLOORPLAN", label: "Floor plan", quantity: 1 }] } } });
  await pw.sweepPromiseWatch(setNow(FRI(13, 0)));
  c.ok("partial order, 3 covered hours before: the heads-up, no draft yet", dmsTo(S.kyle, /Promise check: 30 Part St/).length === 1 && (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: part.id } })) === 0);
  await autoDraftAtRiskUpdate({ projectId: part.id, promisedAt: FRI(16, 0), now: setNow(FRI(16, 30)) });
  const partDraft = await prisma.smartTask.findFirst({ where: { taskType: "at_risk_update", projectId: part.id } });
  c.ok("partial order: the draft first names everything owed (the photos and the floor plan)", /the photos and the floor plan are running behind/.test(partDraft?.description ?? ""), partDraft?.description ?? "none");
  await prisma.project.update({ where: { id: part.id }, data: { statusEvidence: partEv(["Photos"], ["Floor plan"]) } });
  await pw.sweepPromiseWatch(setNow(FRI(16, 35)));
  const partNow = await prisma.smartTask.findFirst({ where: { id: partDraft?.id } });
  c.ok("the photos went out: the draft now names only the floor plan, and the summary says the photos are delivered", partNow?.status === "OPEN" && /the floor plan is running behind/.test(partNow.description ?? "") && !/photos/.test(partNow.description ?? "") && /^Still owed: the floor plan, promised by .+ Already delivered: the photos\./.test(partNow.summary ?? ""), `${partNow?.description} | ${partNow?.summary}`);
  await prisma.smartTask.update({ where: { id: partDraft!.id }, data: { description: "Hi Nina, the floor plan is coming tonight, I'll text you when it's on." } });
  await prisma.project.update({ where: { id: part.id }, data: { statusEvidence: partEv(["Photos"], ["Floor plan"]) } });
  await pw.sweepPromiseWatch(setNow(FRI(16, 40)));
  c.ok("…a text Kyle rewrote keeps his words", (await prisma.smartTask.findFirst({ where: { id: partDraft?.id } }))?.description === "Hi Nina, the floor plan is coming tonight, I'll text you when it's on.");
  // The stage line (the watch DM, a "when will it be ready?" reply task): photos out, the floor plan still owed.
  await prisma.photoJob.create({ data: { projectId: part.id, stage: "DELIVERED", finalsCount: 63 } });
  await prisma.project.update({ where: { id: part.id }, data: { statusEvidence: partEv(["Photos"], ["Floor plan"]).replace('"delivery":"UNDELIVERED"', '"delivery":"DELIVERED"').replace('"photos":0', '"photos":63') } });
  const partWords = (await pw.describeJobStages([part.id])).get(part.id);
  const { owedPhrase } = await import("@/lib/statusEvidence");
  c.ok("the delivered list reads like the owed one, '3D' kept (1316 Blair Cir's summary read 'the photos and the floor plan and the 3d tour')", owedPhrase({ categories: ["Photos", "Floor plan", "3D tour"], shortfall: [] }) === "the photos, the floor plan and the 3D tour");
  c.ok("the stage line of a part-delivered job: 'photos delivered … still owed: the floor plan', never 'delivered' or 'not delivered'", !!partWords && /photos delivered, 63 finals/.test(partWords.words) && /still owed: the floor plan$/.test(partWords.words) && !/(?:^|, )(?:not )?delivered$/.test(partWords.words), partWords?.words);

  // =========================================================================
  c.head("6 · Slack asks close on evidence, and not when ambiguous");
  // =========================================================================
  const ev6 = await import("@/lib/slackAskEvidence");
  const zed = await mkClient("Zed Quinn", "6105550304");
  const job = await prisma.project.create({ data: { title: "40 Ridge Rd, Malvern, PA", clientId: zed.id, status: "EDITING", shootDate: MON(9) } });
  const reel = await prisma.project.create({ data: { title: "41 Ridge Rd, Malvern, PA", clientId: zed.id, status: "EDITING", shootDate: MON(9), deliverables: { create: [{ type: "VIDEO", label: "Listing Reel", quantity: 1 }] } } });
  let seq = 0;
  const ask = (title: string, data: Record<string, unknown> = {}) =>
    prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "slack", title, contactName: "Jordan", assignedKey: "kyle", ownerId: kyle.id, status: "OPEN", sourceDetail: `channel D1 · 2000.${++seq}`, dedupeKey: `slack-2000.${seq}`, createdAt: FRI(10), ...data } });
  const A = await ask("Kyle can you deliver the photos for 40 Ridge Rd", { projectId: job.id });
  const B = await ask("Text her back about the reschedule", { clientId: zed.id });
  const C = await ask("Re-edit the reel for 41 Ridge Rd, the music is too loud", { projectId: reel.id });
  const D = await ask("Look into the thing with Zed", { projectId: job.id, clientId: zed.id });
  const E = await ask("Fix the kitchen photo on 40 Ridge Rd", { projectId: job.id });
  const F = await ask("Send them the invoice for 40 Ridge Rd photos", { projectId: job.id });
  const G = await ask("Call her back about the drone", { clientId: zed.id, createdAt: FRI(10, 30) });
  const H = await ask("Deliver 40 Ridge Rd (+2 more)", { projectId: job.id });
  setNow(FRI(10, 45));
  let sweep = await ev6.closeSlackAsksOnEvidence(FRI(10, 45));
  c.ok("before any evidence: nothing closes", sweep.closed.length === 0, JSON.stringify(sweep.leftOpen));
  await prisma.commLog.create({ data: { channel: "text", direction: "out", clientId: zed.id, body: "Thursday works, see you then.", occurredAt: FRI(10, 20), source: "openphone", externalId: "op-zed-out-1" } });
  await prisma.project.update({ where: { id: job.id }, data: { status: "DELIVERED", deliveredAt: FRI(11) } });
  await prisma.reviewSubmission.create({ data: { projectId: reel.id, round: 2, kind: "video", source: "upload", status: "PENDING", fileName: "reel-v2.mp4", createdAt: FRI(11) } });
  sweep = await ev6.closeSlackAsksOnEvidence(setNow(FRI(12, 0)));
  const st = async (t: { id: string }) => prisma.smartTask.findUniqueOrThrow({ where: { id: t.id } });
  const a = await st(A), bb6 = await st(B), cc = await st(C);
  c.ok("deliver ask + the job delivered after it → COMPLETED, evidence named", a.status === "COMPLETED" && /Closed on evidence: delivered/.test(a.summary ?? "") && /evidence:deliver$/.test(a.sourceDetail ?? "") && a.sourceDetail!.startsWith("channel D1"), `${a.status} ${a.sourceDetail}`);
  c.ok("message ask + a text to that client after it → COMPLETED", bb6.status === "COMPLETED" && /message: a text went to the client/.test(bb6.summary ?? ""));
  c.ok("video re-edit ask + a new cut after it → COMPLETED", cc.status === "COMPLETED" && /edit: cut v2 was uploaded/.test(cc.summary ?? ""));
  c.ok("no clear ask (\"look into the thing\") stays open though the job delivered", (await st(D)).status === "OPEN");
  c.ok("a PHOTO fix stays open (no reliable proof)", (await st(E)).status === "OPEN");
  c.ok("\"send them the invoice\" stays open though the job delivered", (await st(F)).status === "OPEN");
  c.ok("a message sent BEFORE the ask is not evidence", (await st(G)).status === "OPEN");
  c.ok("a card that rolled several asks together stays open", (await st(H)).status === "OPEN");

  // The 7-day timer and the morning digest.
  const { expireStaleSlackTasks } = await import("@/lib/tasks");
  const oldJordan = await ask("Update the tracker for Dana's listing", { createdAt: et(2026, 10, 15, 9) });
  const oldOther = await prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "slack", title: "Somebody check the drone batteries", contactName: "Kim", assignedKey: null, status: "OPEN", dedupeKey: "slack-3000.1", createdAt: et(2026, 10, 15, 9) } });
  setNow(SAT(9, 0));
  await expireStaleSlackTasks();
  c.ok("Jordan's 9-day-old ask to Kyle is NOT cancelled by the 7-day timer", (await st(oldJordan)).status === "OPEN");
  c.ok("…anyone else's still is", (await st(oldOther)).status === "CANCELLED");
  const { kyleMorningDigest } = await import("@/lib/notify");
  setNow(et(2026, 10, 26, 8, 30)); // Monday 8:30 AM
  const md = await kyleMorningDigest();
  const morningDm = dmsTo(S.kyle, /Jordan asked, still open/);
  c.ok("Kyle's morning digest lists \"Jordan asked, still open\" with ages", md.sent && morningDm.length === 1 && /Update the tracker for Dana's listing \(10d\)/.test(morningDm[0].text), morningDm[0]?.text.split("\n").filter((l) => /Jordan asked|\(\d+d\)/.test(l)).join(" | "));
  c.ok("…with the dollar figure scrubbed", !/\$750/.test(morningDm[0]?.text ?? "") && /\[amount\]/.test(morningDm[0]?.text ?? ""));

  // =========================================================================
  c.head("7 · AutoHDR mail");
  // =========================================================================
  const vb = await import("@/lib/vendorBalance");
  c.ok("a newsletter about credits (promo subject) is not a balance mail", !vb.isAutohdrBalanceMail({ subject: "Save 20% on credit packs this week", body: "Top up and save. Unsubscribe here.", listUnsubscribe: "" }));
  c.ok("credit words with no problem word are not one", !vb.isAutohdrBalanceMail({ subject: "Your monthly AutoHDR recap", body: "You used 400 credits in September.", listUnsubscribe: "" }));
  c.ok("\"credits are running low\" is one", vb.isAutohdrBalanceMail({ subject: "Your AutoHDR credits are running low", body: "You have 40 credits left.", listUnsubscribe: "" }));
  c.ok("…but not from a mailing list (List-Unsubscribe)", !vb.isAutohdrBalanceMail({ subject: "Your AutoHDR credits are running low", body: "You have 40 credits left.", listUnsubscribe: "<mailto:unsub@autohdr.com>" }));
  c.ok("a declined card is one even from a mailing list", vb.isAutohdrBalanceMail({ subject: "Payment failed", body: "Your credit card was declined; your balance was not topped up.", listUnsubscribe: "<mailto:unsub@autohdr.com>" }));
  setNow(et(2026, 10, 26, 10));
  const mailTasks = () => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: "autohdr-balance-mail-" } }, orderBy: { createdAt: "asc" } });
  await vb.handleAutohdrMail({ externalId: "gmail-ah-1", gmailId: "ah-1", subject: "New in AutoHDR: twilight credits, 20% off", body: "Top up today.", fromEmail: "news@autohdr.com", listUnsubscribe: "<https://autohdr.com/unsub>" });
  c.ok("the marketing email is logged, files no task", (await mailTasks()).length === 0 && (await prisma.commLog.count({ where: { externalId: "gmail-ah-1" } })) === 1);
  await vb.handleAutohdrMail({ externalId: "gmail-ah-2", gmailId: "ah-2", subject: "Insufficient credits", body: "Processing paused.", fromEmail: "billing@autohdr.com", listUnsubscribe: "" });
  c.ok("a real warning (API not connected) files ONE task for Jordan", (await mailTasks()).length === 1 && (await mailTasks())[0].ownerId === jordan.id);
  // Stale ones: an older mail task and a retired check task, both open.
  await prisma.smartTask.create({ data: { taskType: "vendor_balance", title: "AutoHDR emailed about credits or payment", source: "system", priority: "HIGH", status: "OPEN", dedupeKey: "autohdr-balance-mail-2026-10-02" } });
  await prisma.smartTask.create({ data: { taskType: "vendor_balance_check", title: "Check the AutoHDR credit balance", source: "system", priority: "MEDIUM", status: "OPEN", dedupeKey: "autohdr-balance-check-2026-10-05" } });
  const closedStale = await vb.closeStaleAutohdrBalanceTasks(new Date());
  const all = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: "autohdr-balance-" } } });
  c.ok("stale tasks closed with a note (older mail task and the retired check), today's real one kept", closedStale.closed === 2 && all.find((t) => t.dedupeKey === "autohdr-balance-mail-2026-10-02")?.status === "CANCELLED" && all.find((t) => t.dedupeKey === "autohdr-balance-check-2026-10-05")?.status === "CANCELLED" && all.find((t) => t.dedupeKey === "autohdr-balance-mail-2026-10-26")?.status === "OPEN" && /Closed \(Oct 14 2026\)/.test(all.find((t) => t.dedupeKey === "autohdr-balance-mail-2026-10-02")?.summary ?? ""));
  process.env.AUTOHDR_CLIENT_ID = "drill-client";
  process.env.AUTOHDR_CLIENT_SECRET = "drill-secret-not-real";
  setNow(et(2026, 10, 27, 10));
  await vb.handleAutohdrMail({ externalId: "gmail-ah-3", gmailId: "ah-3", subject: "Your AutoHDR credits are running low", body: "You have 20 credits left.", fromEmail: "billing@autohdr.com", listUnsubscribe: "" });
  c.ok("API connected: a real warning is logged and files NO task (the credit monitor alerts)", !(await prisma.smartTask.findUnique({ where: { dedupeKey: "autohdr-balance-mail-2026-10-27" } })) && (await prisma.commLog.count({ where: { externalId: "gmail-ah-3" } })) === 1);
  await vb.closeStaleAutohdrBalanceTasks(new Date());
  c.ok("…and every open mail task closes, saying the monitor has it", (await prisma.smartTask.findUnique({ where: { dedupeKey: "autohdr-balance-mail-2026-10-26" } }))?.status === "CANCELLED");
  delete process.env.AUTOHDR_CLIENT_ID;
  delete process.env.AUTOHDR_CLIENT_SECRET;

  // =========================================================================
  c.head("8 · The fence held, and no client was sent anything");
  // =========================================================================
  c.ok("no blocked outbound call (every provider call was answered in-process)", fence.blocked.length === 0, fence.blocked.join(" "));
  c.ok("every faked call was Slack", fence.faked.every((u) => u.startsWith("https://slack.com/api/")));
  const clientDigits = ["6105550301", "6105550302", "6105550303", "6105550304", "6105550199", "6105550188", "6105550177"];
  c.ok("no text went to a client or a lead (only Harrison, by staff text)", texts.every((t) => !clientDigits.some((d) => t.to.replace(/\D/g, "").endsWith(d))) && texts.every((t) => t.to.replace(/\D/g, "").endsWith("6105550144")), texts.map((t) => t.to).join(","));
  c.ok("every Slack post went to a staff member's DM", slack.every((m) => [S.jordan, S.kyle, S.james].includes(m.channel)), [...new Set(slack.map((m) => m.channel))].join(","));
  c.ok("no client outbox row", (await prisma.outboxMessage.count()) === 0);
  c.ok("no outbound comm row the hub wrote itself", (await prisma.commLog.count({ where: { direction: "out", NOT: { externalId: "op-zed-out-1" } } })) === 0);

  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// DRILL: the chase counter (Oct 15 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-chase-counter.ts
//
// "Clients should not have to chase updates ... repeated follow-ups trigger
// escalation." Every inbound "is it ready / any update" is counted per client
// and job over 14 days: the 2nd opens ONE HIGH task for Kyle with the promise
// line; the 3rd also rings the owner (bell + Slack). Once per message; tasks
// and bells only.
//
//   1. The question: the plain ways a client asks again, and what is not one.
//   2. Through comms (the Smart Brain stubbed at its one function): 1st ask,
//      replayed; 2nd ask → Kyle's HIGH task with the promise; replayed; 3rd →
//      the same task, the owner's bell and one Slack DM; replayed.
//   3. Per job, the 14-day window, a message with no CommLog id.
//   4. A program job's task names each video's promise and stage.
//   5. The switch.
//   6. Nothing reached the client.
//
// ISOLATION: PGlite via the shared harness; Slack answered in-process.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7162);

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
let offset = et(2026, 10, 12, 9).getTime() - RealDate.now();
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

// ---- the brain, stubbed at its one function ---------------------------------
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo" };
let nextDecision: Decision | null = null;
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "routeCommTask" ? async () => nextDecision : t[k]; } }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);
installNextStubs();

type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") { slack.push({ channel: body.channel ?? "?", text: body.text ?? "" }); return json({ ok: true, ts: String(slack.length) }); }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});
const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001" };
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const op = await import("@/lib/integrations/openphone");
  const texts: string[] = [];
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: "+16105550100" }];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: string, body: string) => { texts.push(`${to}: ${body}`); return { data: { id: `op-${texts.length}` } }; };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
  const { isReadyQuestion } = await import("@/lib/promiseWatch");
  const chase = await import("@/lib/chaseCounter");
  const { recordClientCommunication } = await import("@/lib/comms");

  // =========================================================================
  c.head("1 · The question");
  // =========================================================================
  const yes = ["Is it ready?", "Are my videos done yet?", "are they ready", "Just checking in on the reels", "Following up on the photos", "Any update?", "Any updates on my videos?", "When will the video be ready?", "still waiting on the photos"];
  const no = ["Thanks so much!", "Can we move it to 2pm instead?", "Looks great, love it", "The gate code is 4417", "Are you free Thursday?"];
  c.ok("the plain ways a client asks again are caught", yes.every(isReadyQuestion), yes.filter((t) => !isReadyQuestion(t)).join(" | "));
  c.ok("…and everyday messages are not", !no.some(isReadyQuestion), no.filter(isReadyQuestion).join(" | "));

  // =========================================================================
  c.head("2 · Through comms: 2nd ask → Kyle, 3rd → the owner");
  // =========================================================================
  const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER", slackId: string) => prisma.teamMember.create({ data: { name, email, role, slackId, active: true }, select: { id: true } });
  const jordan = await member("Jordan Spackman", "info@realtourpilot.com", "PHOTOGRAPHER", S.jordan);
  const kyle = await member("Kyle Smith", "hello@realtourpilot.com", "MANAGER", S.kyle);
  await prisma.appUser.create({ data: { email: "info@realtourpilot.com", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
  const uKyle = await prisma.appUser.create({ data: { email: "hello@realtourpilot.com", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id }, select: { id: true } });
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });
  const erin = await prisma.client.create({ data: { name: "Erin Walsh", phone: "(610) 555-0401" }, select: { id: true, name: true } });
  const birch = await prisma.project.create({ data: { title: "9 Birch Ln, Malvern, PA", clientId: erin.id, status: "EDITING", shootDate: OCT(9, 10), promisedDueAt: OCT(13, 17), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } }, select: { id: true } });
  const decide = (projectId: string): Decision => ({ actionable: true, projectId, title: `Reply to Erin about ${projectId === birch.id ? "9 Birch Ln" : "4 Oak Ct"}`, detail: "Client asks for an update.", priority: "MEDIUM", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "status question", taskType: "client_reply" });
  const ask = async (text: string, commLogId: string, when: Date, projectId = birch.id) => {
    setNow(when);
    nextDecision = decide(projectId);
    await recordClientCommunication({ clientId: erin.id, clientName: erin.name, projectId, text, kind: "text", source: "openphone", commLogId, contactName: erin.name });
  };
  const chaseTasks = () => prisma.smartTask.findMany({ where: { taskType: chase.CHASE_TASK_TYPE, clientId: erin.id } });
  const ledger = async (pid: string | null = birch.id) => prisma.appSetting.count({ where: { key: { startsWith: chase.chaseScope(erin.id, pid) } } });
  const ownerBells = () => prisma.notification.findMany({ where: { kind: chase.CHASE_TASK_TYPE } });
  const toJordan = () => slack.filter((s) => s.channel === S.jordan);

  await ask("Hi! Any update on the photos?", "cl-1", OCT(12, 9));
  c.ok("1st ask: counted, the normal reply task only", (await ledger()) === 1 && (await chaseTasks()).length === 0);
  await ask("Hi! Any update on the photos?", "cl-1", OCT(12, 9, 5));
  c.ok("…the same message replayed counts once", (await ledger()) === 1);

  await ask("Is it ready?", "cl-2", OCT(13, 10));
  let tasks = await chaseTasks();
  const t = tasks[0];
  console.log(`\n--- Kyle's task ---\n${t?.title}\n${t?.summary}\n${t?.description}\n---`);
  c.ok("2nd ask: ONE HIGH task for Kyle", tasks.length === 1 && t.priority === "HIGH" && t.status === "OPEN" && t.assignedKey === "kyle" && t.ownerId === kyle.id && t.projectId === birch.id, JSON.stringify(tasks.map((x) => [x.priority, x.assignedKey, x.status])));
  c.ok("…saying how often they asked, with the promise line and where it stands", /asked for an update 2 times/.test(t?.title ?? "") && /Promise on file: Tue, Oct 13, 5:00 PM ET/.test(t?.summary ?? "") && /Asked 2 times in 14 days/.test(t?.summary ?? "") && /Nothing has been sent to the client/.test(t?.summary ?? ""));
  c.ok("…the client's own words, timed", /"Hi! Any update on the photos\?"/.test(t?.description ?? "") && /"Is it ready\?"/.test(t?.description ?? ""));
  c.ok("…no dashes", !DASH.test(`${t?.title} ${t?.summary} ${t?.description}`));
  c.ok("…and the owner is not rung yet", (await ownerBells()).length === 0 && toJordan().length === 0);
  await ask("Is it ready?", "cl-2", OCT(13, 10, 2));
  c.ok("…replayed: nothing more", (await ledger()) === 2 && (await chaseTasks()).length === 1);

  await ask("Following up on the photos, any word?", "cl-3", OCT(13, 16));
  tasks = await chaseTasks();
  c.ok("3rd ask: the SAME task, now saying 3 times", tasks.length === 1 && /3 times/.test(tasks[0].title) && /Asked 3 times/.test(tasks[0].summary ?? ""));
  const bells = await ownerBells();
  c.ok("…the owner's bell rings once", bells.length === 1 && JSON.parse(bells[0].audience) .includes("OWNER") && /Erin Walsh has chased 3 times/.test(bells[0].title), bells.map((b) => b.title).join(" | "));
  c.ok("…and Jordan gets one Slack DM pointing at Kyle's task", toJordan().length === 1 && /asked for an update 3 times/.test(toJordan()[0].text) && new RegExp(`/tasks\\?task=${tasks[0].id}`).test(toJordan()[0].text) && !DASH.test(toJordan()[0].text), toJordan()[0]?.text);
  await ask("Following up on the photos, any word?", "cl-3", OCT(13, 16, 3));
  c.ok("…replayed: no second bell, no second DM", (await ownerBells()).length === 1 && toJordan().length === 1);

  // =========================================================================
  c.head("3 · Per job, the window, a message with no log id");
  // =========================================================================
  const oak = await prisma.project.create({ data: { title: "4 Oak Ct, Malvern, PA", clientId: erin.id, status: "EDITING", shootDate: OCT(12, 10), promisedDueAt: OCT(14, 17) }, select: { id: true } });
  await ask("Any update on 4 Oak Ct?", "cl-oak-1", OCT(14, 9), oak.id);
  c.ok("another job of the same client counts on its own", (await ledger(oak.id)) === 1 && (await chaseTasks()).filter((x) => x.projectId === oak.id).length === 0);
  setNow(OCT(30, 9));
  const late = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: birch.id, text: "Any update?", commLogId: "cl-4", at: OCT(30, 9) });
  c.ok("17 days after the first ask, only the asks inside 14 days count", late.recorded && late.count === 1 && late.escalated === "none", JSON.stringify(late));
  const h1 = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: oak.id, text: "Are they ready?", at: OCT(15, 9) });
  const h2 = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: oak.id, text: "Are they ready?", at: OCT(15, 9, 30) });
  const h3 = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: oak.id, text: "Are they ready?", at: OCT(16, 9) });
  c.ok("no CommLog id: the same words the same day count once, the next day again", h1.recorded && !h2.recorded && h3.recorded && h3.count === 3 && h3.escalated === "owner", JSON.stringify([h1, h2, h3].map((x) => [x.recorded, x.count, x.escalated])));
  const noJob = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: null, text: "any news?", commLogId: "cl-nj-1", at: OCT(16, 10) });
  const noJob2 = await chase.recordChase({ clientId: erin.id, clientName: erin.name, projectId: null, text: "any news??", commLogId: "cl-nj-2", at: OCT(16, 11) });
  const njTask = noJob2.taskId ? await prisma.smartTask.findUnique({ where: { id: noJob2.taskId } }) : null;
  c.ok("a message whose job is in doubt counts on the client, and the task says to find the job", noJob.count === 1 && noJob2.count === 2 && /No job matched these messages/.test(njTask?.summary ?? ""), njTask?.summary ?? "");

  // =========================================================================
  c.head("4 · A program job names each video");
  // =========================================================================
  const marcee = await prisma.client.create({ data: { name: "Mara Quinn", phone: "(610) 555-0402", socialClient: true }, select: { id: true, name: true } });
  const en = await prisma.contentEnrollment.create({ data: { clientId: marcee.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, startedAt: OCT(1, 9) }, select: { id: true } });
  const month = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: marcee.id, monthKey: "2026-10", videosOwed: 2 }, select: { id: true } });
  const pj = await prisma.project.create({ data: { clientId: marcee.id, title: "Mara Quinn October content", status: "EDITING", contentMonthId: month.id, packageName: "Video Starter", shootDate: OCT(5, 10), promisedDueAt: OCT(19, 17), deliveryDue: OCT(19, 17), uploadedAt: OCT(5, 15) }, select: { id: true } });
  const dv = await prisma.deliverable.create({ data: { projectId: pj.id, type: "SOCIAL_REEL", label: "Video Starter", quantity: 2 }, select: { id: true } });
  await prisma.deliverableOutput.create({ data: { deliverableId: dv.id, projectId: pj.id, slot: 1, category: "VIDEO", title: "Why I Love Bow Tree" } });
  await prisma.deliverableOutput.create({ data: { deliverableId: dv.id, projectId: pj.id, slot: 2, category: "VIDEO", title: "Market Minute" } });
  await chase.recordChase({ clientId: marcee.id, clientName: marcee.name, projectId: pj.id, text: "any update on my videos?", commLogId: "cl-m-1", at: OCT(14, 9) });
  setNow(OCT(14, 10));
  const m2 = await chase.recordChase({ clientId: marcee.id, clientName: marcee.name, projectId: pj.id, text: "Are my videos done?", commLogId: "cl-m-2", at: OCT(14, 10) });
  const mt = m2.taskId ? await prisma.smartTask.findUnique({ where: { id: m2.taskId } }) : null;
  console.log(`\n--- the program task ---\n${mt?.title}\n${mt?.summary}\n---`);
  c.ok("the task names each video, its promise and where it stands (and that it is behind)", /"Why I Love Bow Tree": due Mon, Oct 19, 5:00 PM ET AT RISK/.test(mt?.summary ?? "") && /"Market Minute"/.test(mt?.summary ?? "") && /has asked for an update 2 times: their videos/.test(mt?.title ?? ""), `${mt?.title} / ${mt?.summary}`);

  // =========================================================================
  c.head("5 · The switch");
  // =========================================================================
  const { saveProgramWatchRules } = await import("@/lib/programWatch");
  await saveProgramWatchRules({ chaseEscalation: false }, "drill");
  const sid = await prisma.client.create({ data: { name: "Sid Hart", phone: "(610) 555-0403" }, select: { id: true, name: true } });
  await chase.recordChase({ clientId: sid.id, clientName: sid.name, projectId: null, text: "any update", commLogId: "cl-s-1", at: OCT(16, 9) });
  const off = await chase.recordChase({ clientId: sid.id, clientName: sid.name, projectId: null, text: "any update?", commLogId: "cl-s-2", at: OCT(16, 10) });
  c.ok("escalation off: counted, no task", off.recorded && off.count === 2 && off.escalated === "none" && (await prisma.smartTask.count({ where: { taskType: chase.CHASE_TASK_TYPE, clientId: sid.id } })) === 0, JSON.stringify(off));
  await saveProgramWatchRules({ chaseEscalation: true }, "drill");

  // =========================================================================
  c.head("6 · Nothing reached the client");
  // =========================================================================
  c.ok("no text and no email went to a client", texts.length === 0, texts.join(" | "));
  c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

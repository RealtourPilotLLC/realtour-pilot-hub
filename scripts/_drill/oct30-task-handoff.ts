// ---------------------------------------------------------------------------
// DRILL · oct30-task-handoff: AN ASSIGNED TASK IS THEIRS, WITH ITS NOTES AND A
// LINK (Oct 30 2026).
//
// Jordan, from Kyle's text "Kyle assigned you: Book content session Joseph
// Sutow ... Accept it on your dashboard": "I don't even know where the notes
// are or how Kyle would even know what to schedule ... I should get a link when
// I get a text like that and it should take me to where I can take an action
// on it", then "this says waiting acceptance I don't even have a place to
// accept it", and "I don't want anything to wait for acceptance if I assign it
// to them it's assigned to them."
//
//   §1 no acceptance: an assignment (and a reassignment) is the assignee's at
//      once; an old unstamped one reads as assigned too; nothing resurfaces as
//      "not accepted"
//   §2 the text carries the link: the dashboard with the task open for the
//      office, the Tasks board for everyone else; the bell goes there too
//   §3 the notes: a hand-on carries the row's own words; a task the engine
//      wrote keeps its description and the panel shows it
//   §4 the screens: ?task= opens it on each dashboard; the owner's panel offers
//      Mark complete and Give back on his own task; an "Assigned to me" card
//   §5 the session task with no slot says nothing is booked yet
//
// ISOLATION: PGlite via the shared harness, Slack faked in-process, nothing
// leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const slack: { channel: string; text: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "chat.postMessage") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.open") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { users?: string };
    return json({ ok: true, channel: { id: `D-${body.users ?? "?"}` } });
  }
  return json({ ok: true });
});

const read = (p: string) => fs.readFileSync(p, "utf8");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5946), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct30-handoff" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const A = await import("@/app/delegation/actions");
    const lib = await import("@/lib/delegation");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    let n = 0;
    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@handoff.invalid`, slackId: `U${name.split(" ")[0].toUpperCase()}`, phone: `215555${String(++n).padStart(4, "0")}` } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER");
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@handoff.invalid", "ADMIN", kyleTm.id);
    await user("Harrison Wells", "harrison@handoff.invalid", "PHOTOGRAPHER", harrisonTm.id);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const client = await prisma.client.create({ data: { name: "Sharra Drill", phone: "2155550102" } });
    // The text each person is sent (the DM sentence, laid out as a text).
    const textsTo = async (tmId: string) => (await prisma.pendingSms.findMany({ where: { teamMemberId: tmId }, orderBy: { createdAt: "asc" }, select: { line: true } })).map((x) => x.line);
    const view = async (id: string) => (await lib.delegationFor([id])).get(id)!;

    // =====================================================================
    c.head("§1 · Assigned is theirs: nothing waits for acceptance");
    // =====================================================================
    await signIn(owner);
    const r1 = await A.assignTaskAction({ title: "Call the Mill Rd seller back", assigneeKey: "kyle", sourceHref: "/clients/x#calls", clientId: client.id, outcome: "A time for the reshoot" });
    const t1 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "deleg:/clients/x#calls" } });
    const v1 = await view(t1.id);
    c.ok("assigning stamps acceptedAt", r1.ok && !!t1.acceptedAt, r1.message);
    c.ok("the state is not 'awaiting acceptance'", v1.state !== "ASSIGNED" && lib.STATE_WORDS[v1.state] === "Assigned", `${v1.state} ${lib.STATE_WORDS[v1.state]}`);
    c.ok("the next step is doing it", v1.nextStep === "Kyle to do it" || /to do it$/.test(v1.nextStep ?? ""), String(v1.nextStep));
    c.ok("nothing resurfaces as not accepted", lib.resurfaceOf(v1, new Date(Date.now() + 3 * 86_400_000)) === null);
    await prisma.smartTask.update({ where: { id: t1.id }, data: { acceptedAt: null } });
    c.ok("an assignment from before today reads as assigned too", (await view(t1.id)).state !== "ASSIGNED");
    const rr = await A.reassignTaskAction(t1.id, "harrison");
    const t1b = await prisma.smartTask.findUniqueOrThrow({ where: { id: t1.id } });
    c.ok("a reassignment is the new person's at once", rr.ok && t1b.assignedKey === "harrison" && !!t1b.acceptedAt, rr.message);
    c.ok("no screen still says 'Awaiting acceptance'", !["src/components/owner/OwnerShell.tsx", "src/lib/delegation.ts", "src/components/owner/OwnerHome.tsx"].some((p) => read(p).includes("Awaiting acceptance")));

    // =====================================================================
    c.head("§2 · The text carries a link to where it can be done");
    // =====================================================================
    await signIn(kyle);
    const r2 = await A.assignTaskAction({ title: "Sharra Mercer: Book follow-up call with client next week", assigneeKey: "jordan", sourceHref: "/communications?thread=sharra" });
    const t2 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "deleg:/communications?thread=sharra" } });
    const toJordan = (await textsTo(jordanTm.id)).join("\n");
    c.ok("Jordan's message links to his dashboard with the task open", r2.ok && toJordan.includes(`/?task=${t2.id}`), toJordan.slice(-160));
    c.ok("and never says 'Accept it'", !/accept it/i.test(toJordan));
    const bell = await prisma.notification.findFirst({ where: { userKey: `tm:${jordanTm.id}`, kind: "task_assigned" }, orderBy: { createdAt: "desc" } });
    c.ok("the bell opens the same place", bell?.href === `/?task=${t2.id}`, String(bell?.href));
    await A.assignTaskAction({ title: "Bring the spare battery Friday", assigneeKey: "harrison", sourceHref: "/shoots/x" });
    const t3 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "deleg:/shoots/x" } });
    const toHarrison = (await textsTo(harrisonTm.id)).join("\n");
    c.ok("a photographer's link is the Tasks board with the task open", toHarrison.includes(`/tasks?task=${t3.id}`), toHarrison.slice(-160));
    c.ok("each role's place", lib.taskHrefFor("OWNER", "a") === "/?task=a" && lib.taskHrefFor("ADMIN", "a") === "/?task=a" && lib.taskHrefFor("CREATIVE_MANAGER", "a") === "/?task=a" && lib.taskHrefFor("EDITOR", "a") === "/tasks?task=a");

    // =====================================================================
    c.head("§3 · The task carries its notes");
    // =====================================================================
    const words = "Sharra Drill said:\n\"Can we do a quick call next week about the spring listings?\"";
    const r4 = await A.assignTaskAction({ title: "Sharra Drill: Booking request", assigneeKey: "jordan", sourceHref: "/communications?thread=sharra2", context: words });
    const t4 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "deleg:/communications?thread=sharra2" } });
    c.ok("a hand-on carries the row's own words", r4.ok && (await view(t4.id)).notes?.includes("spring listings") === true, String((await view(t4.id)).notes));
    const engine = await prisma.smartTask.create({ data: { taskType: "todo", title: "Book content session — Joe Drill", summary: "Not booked: agree a time with the client, then book it in Aryeo", description: "Time: the client did not pick one in the portal.\nClient's preference: M-W\nNothing is booked yet. Agree a day and time with the client.", source: "portal", priority: "HIGH", assignedKey: "kyle" } });
    await A.assignTaskAction({ title: engine.title, assigneeKey: "jordan", sourceTaskId: engine.id, outcome: "I believe this is already done, right?" });
    const ve = await view(engine.id);
    c.ok("a task the engine wrote shows its description as notes", ve.notes?.includes("Client's preference: M-W") === true && ve.notes.includes("Nothing is booked yet"), String(ve.notes));
    c.ok("and the outcome stays the outcome", ve.outcome === "I believe this is already done, right?");
    const bare = await prisma.smartTask.create({ data: { taskType: "todo", title: "Follow up with Pat", source: "desk", priority: "MEDIUM", assignedKey: "kyle" } });
    await A.assignTaskAction({ title: bare.title, assigneeKey: "jordan", sourceTaskId: bare.id, context: "Pat asked for the floor plan in feet, not meters." });
    c.ok("a hand-on fills an empty description with the row's words", (await prisma.smartTask.findUniqueOrThrow({ where: { id: bare.id } })).description === "Pat asked for the floor plan in feet, not meters.");
    await A.assignTaskAction({ title: engine.title, assigneeKey: "kyle", sourceTaskId: engine.id, context: "something else" });
    c.ok("and never overwrites one that has words", (await prisma.smartTask.findUniqueOrThrow({ where: { id: engine.id } })).description?.startsWith("Time: the client did not pick") === true);

    // =====================================================================
    c.head("§4 · The link opens it, and the owner can act on his own task");
    // =====================================================================
    const page = read("src/app/page.tsx"), home = read("src/components/owner/OwnerHome.tsx"), shell = read("src/components/owner/OwnerShell.tsx"), desk = read("src/components/desk/OfficeDesk.tsx");
    c.ok("the home page reads ?task= and hands it to every dashboard", /openTaskId=\{openTaskId\}/.test(page) && /initialOpen=\{linked\}/.test(page) && /initialPanel=\{openTaskId \? \{ kind: "task", id: openTaskId \}/.test(page));
    c.ok("the owner's dashboard opens the task's panel", /openTaskPanel\(openTaskId, now\)/.test(home) && /initial=\{initial\} meKey=\{meKey\}/.test(home));
    c.ok("Kyle's desk opens only a row it has", /i\.id === `task:\$\{openTaskId\}`/.test(page));
    c.ok("his own task: Mark complete first, Give back, no Request update", /mine && t\.state !== "READY_FOR_VERIFICATION" && <button[^\n]*className=\{PRIMARY\}>Mark complete/.test(shell) && /Give back to \{t\.assignedBy\}/.test(shell) && /\{!mine && <button[^\n]*requestUpdateAction/.test(shell));
    c.ok("the panel shows the notes", /data-task-notes/.test(shell) && /\{t\.notes\}/.test(shell));
    c.ok("an 'Assigned to me' card lists them", /title="Assigned to me"/.test(home) && /tasksAssignedTo\(meKey\)/.test(home));
    c.ok("Kyle's hand-on sends the row's words", /context=\{handOnContext\(item\)\}/.test(desk) && /context: context \|\| undefined/.test(read("src/components/desk/DeskControls.tsx")));

    // =====================================================================
    c.head("§5 · A session request with no slot says nothing is booked");
    // =====================================================================
    const sr = read("src/lib/sessionRequests.ts");
    c.ok("no slot: agree a time first, then book the four-hour session", /noSlot\s*\? "Nothing is booked yet\. Agree a day and time with the client/.test(sr));
    c.ok("the summary says not booked", /Not booked: agree a time with the client, then book it in Aryeo/.test(sr));

    c.ok("nothing left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

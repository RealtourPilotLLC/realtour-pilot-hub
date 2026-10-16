// ---------------------------------------------------------------------------
// DRILL: the client complaint record (Oct 15 2026).
//
//   1. A complaint about several months (Marcee's Oct 15 call): recorded on
//      the client, jobs optional; refusals in words.
//   2. OPEN → CORRECTED needs the correction in words and opens Kyle's
//      check-in task, due 10 AM two business days later, money taken out,
//      never sending anything; CONFIRMED_SATISFIED closes it; UNRESOLVED needs
//      what is still wrong; reopen works; steps out of order are refused.
//   3. Unhappy feedback opens a complaint, once; happy feedback does not; a
//      complaint text on a delivered job does too.
//   4. Not a complaint after all: dismissed, kept, out of every list.
//   5. Lists: money scrubbed for anyone but the owner; /quality lists the
//      open ones; the client file mounts the card.
//
// ISOLATION: PGlite; the login seam intercepted; nothing leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url) => (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1.1" }) : null));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7105), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct15-client-issues" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const { prisma } = await import("@/lib/prisma");
    const lib = await import("@/lib/clientIssues");
    const core = await import("@/lib/clientIssuesCore");
    const actions = await import("@/app/clients/clientCareActions");
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle@ci.invalid", role: "MANAGER", active: true } });
    const ku = await prisma.appUser.create({ data: { email: "kyle@ci.invalid", name: "Kyle Cabrera", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const kyle: Viewer = { id: ku.id, email: "kyle@ci.invalid", name: "Kyle Cabrera", role: "ADMIN", permissions: null, status: "ACTIVE", teamMemberId: kyleTm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: "ADMIN", realName: "Kyle Cabrera" };
    const client = await prisma.client.create({ data: { name: "Marcee McMullen TEST" }, select: { id: true } });
    const jobs = await Promise.all(["1244 W Chester Pike, Havertown, PA", "18 Malvern Ave, Malvern, PA"].map((title) => prisma.project.create({ data: { title, clientId: client.id, status: "DELIVERED" }, select: { id: true } })));

    // ======================================================================
    c.head("1 · a complaint about several months");
    viewer = kyle;
    const tooShort = await actions.createClientIssueAction({ clientId: client.id, title: "x", whatHappened: "" });
    c.ok("a title and what happened are required", !tooShort.ok);
    const made = await actions.createClientIssueAction({
      clientId: client.id, source: "call", title: "Unhappy with the videos and the wait",
      whatHappened: "Oct 15 call: the August videos took too long, two are missing from her portal, and the Fairy God Realtor videos weren't her. She asked about a $1,500 refund.",
      projectIds: jobs.map((j) => j.id),
    });
    c.ok("recorded on the client, with both jobs", made.ok, made.message);
    const issue = await prisma.clientIssue.findFirstOrThrow({ where: { clientId: client.id } });
    c.ok("…OPEN, from a call, both jobs linked, history started", issue.state === "OPEN" && issue.source === "call" && core.readIds(issue.projectIdsJson).length === 2 && core.readHistory(issue.historyJson)[0]?.what === "Opened (call)");
    const up = await actions.updateClientIssueAction({ id: issue.id, impact: "She is thinking of leaving after a long run with us.", cause: "CREATIVE_DIRECTION", processChange: "Vague feedback now goes to creative review before the editor.", ownerName: "Jordan", ownerKey: "jordan", dueISO: "2026-10-20" });
    const after = await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } });
    c.ok("impact, cause, process change, owner and due are saved", up.ok && after.cause === "CREATIVE_DIRECTION" && after.ownerKey === "jordan" && !!after.dueAt && /creative review/.test(after.processChange ?? ""));
    c.ok("the due date is 5 PM Eastern that day", after.dueAt?.toISOString() === "2026-10-20T21:00:00.000Z", after.dueAt?.toISOString());

    // ======================================================================
    c.head("2 · corrected, the check-in, the client's answer");
    const outOfOrder = await actions.moveClientIssueAction({ id: issue.id, to: "CONFIRMED_SATISFIED" });
    c.ok("satisfied before it was corrected is refused", !outOfOrder.ok);
    const noFix = await actions.moveClientIssueAction({ id: issue.id, to: "CORRECTED", correction: "" });
    c.ok("corrected needs the correction in words", !noFix.ok && /what was done/.test(noFix.message));
    const fixedAt = new Date("2026-10-15T19:00:00Z"); // a Thursday afternoon, Eastern
    const fixed = await lib.moveClientIssue(issue.id, "CORRECTED", { by: "Jordan", correction: "Re-cut the two August videos in the fully scripted format; both are in her portal now. Offered a $200 credit.", now: fixedAt });
    c.ok("marked corrected", fixed.ok, fixed.message);
    const corrected = await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } });
    const task = await prisma.smartTask.findUniqueOrThrow({ where: { id: corrected.checkInTaskId! } });
    c.ok("a check-in task for Kyle", task.assignedKey === "kyle" && task.taskType === "client_checkin" && task.status === "OPEN" && task.priority === "HIGH");
    c.ok("…due 10 AM Eastern two business days later (Thursday → Monday)", task.dueAt?.toISOString() === "2026-10-19T14:00:00.000Z", task.dueAt?.toISOString());
    c.ok("…with no dollar amounts in it", !/\$\s?\d/.test(`${task.title} ${task.summary} ${task.description}`), task.description ?? "");
    c.ok("…and it says it never sends anything by itself", /never sends anything/.test(task.description ?? ""));
    c.ok("no message to the client was queued", (await prisma.outboxMessage.count()) === 0);
    const unres = await actions.moveClientIssueAction({ id: issue.id, to: "UNRESOLVED", note: "" });
    c.ok("not resolved needs what is still wrong", !unres.ok);
    const sat = await actions.moveClientIssueAction({ id: issue.id, to: "CONFIRMED_SATISFIED", note: "She loves the new versions." });
    c.ok("the client says they're satisfied: recorded, the check-in closes", sat.ok && (await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } })).state === "CONFIRMED_SATISFIED" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } })).status === "COMPLETED");
    const re = await actions.moveClientIssueAction({ id: issue.id, to: "OPEN", note: "She called again." });
    c.ok("it can be reopened", re.ok && (await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } })).state === "OPEN");
    const hist = core.readHistory((await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } })).historyJson);
    c.ok("every step is on the history, with who", hist.length >= 5 && hist.some((h) => /Corrected/.test(h.what) && h.by === "Jordan") && hist.some((h) => /satisfied/.test(h.what) && h.by === "Kyle Cabrera"));

    // ======================================================================
    c.head("3 · unhappy feedback opens a complaint, once");
    const { recordFeedback } = await import("@/lib/feedback");
    await recordFeedback({ projectId: jobs[0].id, rating: 1, body: "The video was late and the music was wrong.", authorName: "Marcee" });
    const fb = await prisma.feedback.findFirstOrThrow({ where: { projectId: jobs[0].id, rating: 1 } });
    const opened = await prisma.clientIssue.findUnique({ where: { feedbackId: fb.id } });
    c.ok("a 1-star response opens a complaint on the client, linked to the job", !!opened && opened.clientId === client.id && opened.source === "feedback" && core.readIds(opened.projectIdsJson)[0] === jobs[0].id);
    const again = await lib.openIssueFromFeedback(fb.id);
    c.ok("asked again: the same complaint, not a second", again === opened?.id && (await prisma.clientIssue.count({ where: { feedbackId: fb.id } })) === 1);
    await recordFeedback({ projectId: jobs[1].id, rating: 5, body: "Loved it!" });
    c.ok("happy feedback opens nothing", (await prisma.clientIssue.count({ where: { source: "feedback" } })) === 1);
    const commsSrc = read("src/lib/comms.ts");
    c.ok("a complaint text on a delivered job opens one too", /if \(fb\) await import\("@\/lib\/clientIssues"\)\.then\(\(m\) => m\.openIssueFromFeedback\(fb\.id\)\)/.test(commsSrc));

    // ======================================================================
    c.head("4 · not a complaint after all");
    const dis = await actions.dismissClientIssueAction({ id: opened!.id, reason: "She was joking about the music." });
    c.ok("dismissed with the reason, kept on record", dis.ok && !!(await prisma.clientIssue.findUniqueOrThrow({ where: { id: opened!.id } })).dismissedAt);
    c.ok("…and out of the lists", !(await lib.listClientIssues({ clientId: client.id, scrubMoney: false })).some((i) => i.id === opened!.id));

    // ======================================================================
    c.head("5 · lists, money, screens");
    const forKyle = await lib.listClientIssues({ clientId: client.id, scrubMoney: true });
    const forOwner = await lib.listClientIssues({ clientId: client.id, scrubMoney: false });
    c.ok("Kyle never sees the dollar amounts", !forKyle.some((i) => /\$\s?\d/.test(`${i.whatHappened} ${i.correction ?? ""}`)), forKyle[0]?.whatHappened);
    c.ok("the owner does", forOwner.some((i) => /\$1,500/.test(i.whatHappened)));
    const open = await lib.listClientIssues({ states: ["OPEN", "CORRECTED", "UNRESOLVED"], scrubMoney: true });
    c.ok("the open list for /quality has the reopened complaint", open.length === 1 && open[0].clientName === "Marcee McMullen TEST");
    c.ok("/quality shows open complaints on the clients tab", /<OpenComplaintsList issues=\{openComplaints\} \/>/.test(read("src/app/quality/page.tsx")));
    c.ok("the client file mounts the card", /<ClientIssuesCard clientId=\{client\.id\} issues=\{complaints\}/.test(read("src/app/clients/[id]/page.tsx")));
    c.ok("no em dashes in the states", !/[—–]/.test(Object.values(core.STATE_WORDS).join(" ")));
    viewer = { ...kyle, role: "PHOTOGRAPHER", realRole: "PHOTOGRAPHER" };
    c.ok("a photographer cannot record one", !(await actions.createClientIssueAction({ clientId: client.id, title: "From a photographer", whatHappened: "Something happened here" })).ok);

    c.head("isolation");
    c.ok("nothing left the machine but fenced Slack", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Oct 29 2026: KYLE'S TWO REPORTS.
//   §1 "Remove button is not working": on Tim Bonner's complaint, the steps the
//      hub had set up for Jordan (assigned by info@) were refused to Kyle with
//      "Only the person who assigned it can cancel it." Any lead on a complaint
//      (owner, office, creative manager) may now take a step off its plan; the
//      task is cancelled with the reason and the plan's history keeps it. The
//      assigner-only rule stands for every task that is not a plan step.
//   §2 "Add an option to cc or bcc on email replies ... I think the email
//      replies to only the person who emailed us, disregarding the current
//      email chain (I noticed this when emailing Mike Flatley back)". The
//      reply went To Mike alone. It now goes to the whole chain by default
//      (Reply all, never us), in the same thread, with Cc / Bcc a person adds
//      and "Add me"; typed addresses are checked; a one-use sign-in link is
//      the client's alone; a test client's chain is held to the test inboxes.
// Disposable PGlite; Gmail, Google and Slack are fenced fakes. Nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();

type Sent = { head: string; threadId: string | null };
const sent: Sent[] = [];
let thread: { messages: { id: string; threadId: string; payload: { headers: { name: string; value: string }[] } }[] } = { messages: [] };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "slack.com") return json({ ok: true, channel: { id: "D" }, ts: "1.0" });
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const b = JSON.parse(String(init?.body ?? "{}")) as { raw: string; threadId?: string };
    const text = Buffer.from(b.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    sent.push({ head: text.split("\r\n\r\n")[0], threadId: b.threadId ?? null });
    return json({ id: `gm-${sent.length}` });
  }
  if (u.hostname === "gmail.googleapis.com" && u.pathname.includes("/threads/")) return json(thread);
  return null;
});

const hdr = (h: string, name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(h)?.[1] ?? null;
const msg = (id: string, headers: Record<string, string>) => ({ id, threadId: "1a17e895919e68b7", payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
// Mike Flatley's "913 Lakeview" thread as Gmail would give it: his first email
// to us, then his reply to Javier on his team with us and Kim copied.
const MIKE_THREAD = {
  messages: [
    msg("m1", { From: "Michael Flatley <mike@garymercerteam.com>", To: "info@realtourpilot.com", Subject: "913 Lakeview", "Message-ID": "<m1@mail.gmail.com>" }),
    msg("m2", {
      From: "Michael Flatley <mike@garymercerteam.com>",
      To: "\"Javier R.\" <javier@garymercerteam.com>, info@realtourpilot.com",
      Cc: "\"Mazzenga, Kimberly\" <kim@garymercerteam.com>, Hello <hello@realtourpilot.com>, mike@garymercerteam.com",
      Subject: "Re: 913 Lakeview",
      "Message-ID": "<m2@mail.gmail.com>",
      References: "<m1@mail.gmail.com>",
    }),
  ],
};

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5971), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-kyle-remove-cc" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const P = await import("@/app/clients/complaintPlanActions");
    const plan = await import("@/lib/clientIssuePlan");
    const deleg = await import("@/lib/delegation");
    const R = await import("@/lib/emailRecipients");
    const E = await import("@/app/emailActions");

    const tm = (name: string, email: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, email, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "jordan@team.invalid");
    const kyleTm = await tm("Kyle Smith", "kyle@realtourpilot.com");
    const jamesTm = await tm("James Lee", "james@team.invalid", { creativeManager: true });
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role: role as never, teamMemberId, status: "ACTIVE" } });
    const jordan = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@realtourpilot.com", "ADMIN", kyleTm.id);
    const james = await user("James Lee", "james@team.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role as never });
    const { getCurrentUser } = await import("@/lib/auth/user");
    const actorOf = async (u: { id: string; email: string; role: string }) => { await as(u); return deleg.actorFor((await getCurrentUser())!); };

    // =====================================================================
    c.head("§1 · Remove on a complaint plan (Kyle: \"Remove button is not working\")");
    // =====================================================================
    const tim = await prisma.client.create({ data: { name: "Tim Bonner" } });
    const issue = await prisma.clientIssue.create({ data: { clientId: tim.id, title: "Floor plan errors and photo composition", whatHappened: "Tim's call", source: "call", state: "OPEN" } });
    const jordanActor = await actorOf(jordan);
    const s1 = await plan.addStep(jordanActor, issue.id, { text: "Review the kitchen and bathroom photos and decide on retakes", ownerKey: "jordan", dueISO: null });
    const s2 = await plan.addStep(jordanActor, issue.id, { text: "Coach Harrison with notes pinned on the photos", ownerKey: "jordan", dueISO: null });
    const s3 = await plan.addStep(jordanActor, issue.id, { text: "Add Tim's preferences to his client notes", ownerKey: "kyle", dueISO: null });
    c.ok("set up as on Tim's complaint: steps assigned by Jordan (info@), two of them his own", s1.ok && s2.ok && s3.ok, `${s1.message} / ${s2.message} / ${s3.message}`);
    const step1 = await prisma.clientIssueStep.findUniqueOrThrow({ where: { id: s1.stepId! } });
    const t1before = await prisma.smartTask.findUniqueOrThrow({ where: { id: step1.taskId! } });
    c.ok("…its task was delegated by info@realtourpilot.com, as the live ones were", t1before.delegatedBy === "info@realtourpilot.com" && t1before.status !== "CANCELLED", `${t1before.delegatedBy} ${t1before.status}`);

    const kyleWhy = "Jordan said they're subjective, and Harrison's photos were good.";
    await as(kyle);
    const r1 = await P.removeComplaintStepAction(step1.id, kyleWhy);
    const t1 = await prisma.smartTask.findUniqueOrThrow({ where: { id: step1.taskId! } });
    const st1 = await prisma.clientIssueStep.findUniqueOrThrow({ where: { id: step1.id } });
    c.ok("Kyle (office) removes Jordan's step: it works", r1.ok, r1.message);
    c.ok("…its task is cancelled and leaves Jordan's list", t1.status === "CANCELLED", t1.status);
    c.ok("…the step is off the plan, by Kyle, with his reason", !!st1.removedAt && st1.removedBy === "Kyle" && st1.doneNote === kyleWhy, `${st1.removedBy} / ${st1.doneNote}`);
    const rec1 = JSON.parse(t1.delegation ?? "{}") as { events?: { kind: string; text?: string; by?: string }[] };
    const last1 = rec1.events?.[rec1.events.length - 1];
    c.ok("…the task's history says it left the complaint plan, and why", last1?.kind === "cancelled" && last1.text === `Taken off the complaint plan: ${kyleWhy}`, JSON.stringify(last1));
    const hist = JSON.parse((await prisma.clientIssue.findUniqueOrThrow({ where: { id: issue.id } })).historyJson ?? "[]") as { by: string; what: string }[];
    c.ok("…the complaint's history keeps it", hist.some((h) => h.by === "Kyle" && h.what === `Step removed (${kyleWhy}): ${step1.text}`), JSON.stringify(hist[hist.length - 1]));
    c.ok("…and the button's answer names whose list it left", r1.message === "Removed from the plan and from Jordan's list.", r1.message);

    await as(james);
    const r2 = await P.removeComplaintStepAction(s2.stepId!, "Jordan is coaching him in person");
    const t2 = await prisma.smartTask.findUniqueOrThrow({ where: { id: (await prisma.clientIssueStep.findUniqueOrThrow({ where: { id: s2.stepId! } })).taskId! } });
    c.ok("James (creative manager) may remove a step Jordan set up too", r2.ok && t2.status === "CANCELLED", `${r2.message} ${t2.status}`);
    const r2b = await P.removeComplaintStepAction(s2.stepId!, "again");
    c.ok("…a second press: the step is already gone, said plainly", !r2b.ok && r2b.message === "That step is gone.", r2b.message);
    const noWhy = await P.removeComplaintStepAction(s3.stepId!, "x");
    c.ok("…a reason is still needed", !noWhy.ok && noWhy.message === "Say why it isn't needed.", noWhy.message);

    // The assigner-only rule outside a complaint plan is unchanged.
    const plain = await deleg.assignTask(jordanActor, { title: "Call the stager about Tuesday", assigneeKey: "kyle" });
    const kyleActor = await actorOf(kyle);
    const jamesActor = await actorOf(james);
    const k1 = await deleg.cancelTask(kyleActor, plain.taskId!, "not needed");
    const k2 = await deleg.cancelTask(jamesActor, plain.taskId!, "not needed");
    c.ok("an ordinary delegated task: only its assigner (or the owner) may still cancel it", plain.ok && !k1.ok && !k2.ok && k1.message === "Only the person who assigned it can cancel it.", `${k1.message} / ${k2.message}`);
    const editorActor = { email: "kim@team.invalid", name: "Kim", role: "EDITOR", keys: new Set(["kim"]), teamMemberId: null };
    const ed = await deleg.cancelTask(editorActor, step1.taskId!, "x x x", { planStep: true });
    const s3row = await prisma.clientIssueStep.findUniqueOrThrow({ where: { id: s3.stepId! } });
    const ed2 = await deleg.cancelTask(editorActor, s3row.taskId!, "not mine", { planStep: true });
    c.ok("…and 'a plan step' never lets someone who isn't a lead cancel one", !ed2.ok && ed2.message === "Only the person who assigned it can cancel it." && ed.ok /* already closed */, `${ed.message} / ${ed2.message}`);
    const j1 = await deleg.cancelTask(jordanActor, plain.taskId!, "Kyle has it covered");
    c.ok("…Jordan still may", j1.ok, j1.message);

    // A step pointing at a hub to-do that was never delegated: only the step leaves.
    const loose = await prisma.smartTask.create({ data: { title: "Upload the floor plans", taskType: "floor_plans", status: "OPEN", assignedKey: "kyle", source: "system", priority: "MEDIUM" } as never });
    const looseStep = await prisma.clientIssueStep.create({ data: { issueId: issue.id, sort: 9, text: "Upload the floor plans", kind: "task", ownerKey: "kyle", ownerName: "Kyle", taskId: loose.id } });
    await as(kyle);
    const r3 = await P.removeComplaintStepAction(looseStep.id, "Done another way");
    const looseAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: loose.id } });
    c.ok("a step on a hub to-do that was never delegated: the step leaves, the to-do is left alone", r3.ok && r3.message === "Removed from the plan." && looseAfter.status === "OPEN", `${r3.message} ${looseAfter.status}`);

    // =====================================================================
    c.head("§2a · who a reply goes to (pure)");
    // =====================================================================
    c.ok("a To/Cc header splits into clean addresses: quoted commas, angle brackets, semicolons", JSON.stringify(R.splitAddressList("\"Doe, Jane\" <J@Y.com>, mike@x.com; <a@b.co>, Bad Name")) === JSON.stringify(["j@y.com", "mike@x.com", "a@b.co"]), JSON.stringify(R.splitAddressList("\"Doe, Jane\" <J@Y.com>, mike@x.com; <a@b.co>, Bad Name")));
    c.ok("a header break or a list is never one address", R.cleanAddress("a@b.com\r\nBcc: evil@x.com") === null && R.cleanAddress("a@b.com, c@d.com") === null && R.cleanAddress(" Kyle@RealTourPilot.com ") === "kyle@realtourpilot.com");
    const chain = R.replyAllRecipients({ to: "mike@garymercerteam.com", toHeader: MIKE_THREAD.messages[1].payload.headers.find((h) => h.name === "To")!.value, ccHeader: MIKE_THREAD.messages[1].payload.headers.find((h) => h.name === "Cc")!.value, ours: ["info@realtourpilot.com", "hello@realtourpilot.com"], ourDomain: "realtourpilot.com" });
    c.ok("Reply all on Mike's email: Javier stays on To, Kim on Cc; never us, never Mike twice", JSON.stringify(chain) === JSON.stringify({ alsoTo: ["javier@garymercerteam.com"], cc: ["kim@garymercerteam.com"] }), JSON.stringify(chain));
    const big = R.replyAllRecipients({ to: "a@x.com", toHeader: Array.from({ length: 14 }, (_, i) => `p${i}@x.com`).join(", "), ccHeader: "", ours: [], ourDomain: "realtourpilot.com" });
    c.ok("…at most ten each", big.alsoTo.length === R.MAX_EXTRA_RECIPIENTS);
    const typedOk = R.parseTypedRecipients("Kyle@realtourpilot.com, kim@x.com; kim@x.com", ["kim@x.com"]);
    const typedBad = R.parseTypedRecipients("kyle@realtourpilot.com, kyle");
    c.ok("typed Cc: commas or semicolons, duplicates and people already on it dropped", typedOk.ok && JSON.stringify(typedOk.list) === JSON.stringify(["kyle@realtourpilot.com"]), JSON.stringify(typedOk));
    c.ok("…a word that isn't an address is named, and nothing goes", !typedBad.ok && typedBad.message === "\"kyle\" isn't an email address. Nothing was sent.", typedBad.ok ? "" : typedBad.message);
    c.ok("the sent line names everyone", R.recipientWords({ to: "mike@x.com", alsoTo: ["javier@x.com"], cc: ["kim@x.com", "kyle@realtourpilot.com"] }) === "mike@x.com, javier@x.com, cc kim@x.com and kyle@realtourpilot.com");

    // =====================================================================
    c.head("§2b · the reply box, end to end (Mike Flatley's thread)");
    // =====================================================================
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token", "hello@realtourpilot.com": "drill-refresh-token-2" }));
    const mike = await prisma.client.create({ data: { name: "Mike Flatley", email: "mike@garymercerteam.com" } });
    const lakeview = await prisma.project.create({ data: { clientId: mike.id, title: "913 Lakeview Dr, Exton, PA 19341", status: "DELIVERED" } as never });
    thread = MIKE_THREAD;
    const target = { kind: "gmail" as const, clientId: mike.id, mailbox: "info@realtourpilot.com", threadId: "1a17e895919e68b7" };
    await as(kyle);
    const head = await E.prepareEmailReply(target);
    c.ok("opening the box: To Mike, Reply all lists Javier and Kim, and Add me is Kyle's own address", head.ok && head.to === "mike@garymercerteam.com" && JSON.stringify(head.alsoTo) === "[\"javier@garymercerteam.com\"]" && JSON.stringify(head.cc) === "[\"kim@garymercerteam.com\"]" && head.me === "kyle@realtourpilot.com", JSON.stringify(head));

    const body = "Hey Mike,\n\nOur editors are finalizing the 913 video, and we'll send it out today.";
    const a = await E.sendEmailThreadReply(target, body, "intent-reply-all-1", head.to, { replyAll: true, cc: "kyle@realtourpilot.com", bcc: "" });
    const m1 = sent[sent.length - 1];
    c.ok("Send: one email", a.ok && sent.length === 1, a.message);
    c.ok("…To Mike and Javier (everyone he wrote To, never us)", hdr(m1.head, "To") === "mike@garymercerteam.com, javier@garymercerteam.com", hdr(m1.head, "To") ?? "");
    c.ok("…Cc Kim (his copy) and Kyle (Add me)", hdr(m1.head, "Cc") === "kim@garymercerteam.com, kyle@realtourpilot.com", hdr(m1.head, "Cc") ?? "");
    c.ok("…Jordan's blind copy of a client reply is kept", hdr(m1.head, "Bcc") === "info@realtourpilot.com", hdr(m1.head, "Bcc") ?? "");
    c.ok("…in the same thread: threadId, In-Reply-To, References, Re: subject", m1.threadId === "1a17e895919e68b7" && hdr(m1.head, "In-Reply-To") === "<m2@mail.gmail.com>" && hdr(m1.head, "References") === "<m1@mail.gmail.com> <m2@mail.gmail.com>" && Buffer.from((hdr(m1.head, "Subject") ?? "").replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString("utf8") === "Re: 913 Lakeview", m1.head.replace(/\r\n/g, " | "));
    c.ok("…the answer names everyone it went to", a.message === "Sent to mike@garymercerteam.com, javier@garymercerteam.com, cc kim@garymercerteam.com and kyle@realtourpilot.com.", a.message);
    const claim = await prisma.webhookEvent.findFirst({ where: { provider: "hub-email-reply", externalId: "intent-reply-all-1" } });
    const claimed = JSON.parse(claim?.payload ?? "{}") as { to?: string[]; cc?: string[]; bcc?: string[] };
    c.ok("…who it went to is kept on the send's own record", claim?.status === "PROCESSED" && JSON.stringify(claimed.to) === "[\"mike@garymercerteam.com\",\"javier@garymercerteam.com\"]" && JSON.stringify(claimed.cc) === "[\"kim@garymercerteam.com\",\"kyle@realtourpilot.com\"]", claim?.payload ?? "");
    const act = await prisma.activity.findFirst({ where: { projectId: lakeview.id }, orderBy: { createdAt: "desc" } });
    c.ok("…and on the job's timeline", !!act && act.body.startsWith("Email reply sent to mike@garymercerteam.com, javier@garymercerteam.com, cc kim@garymercerteam.com and kyle@realtourpilot.com by Kyle"), act?.body.slice(0, 140) ?? "");
    const again = await E.sendEmailThreadReply(target, body, "intent-reply-all-1", head.to, { replyAll: true, cc: "kyle@realtourpilot.com" });
    c.ok("…a second press of the same reply doesn't send twice", again.ok && sent.length === 1, again.message);

    const one = await E.sendEmailThreadReply(target, "Just Mike this time.", "intent-just-mike-2", head.to, { replyAll: false });
    const m2 = sent[sent.length - 1];
    c.ok("Reply all unticked: To Mike alone, no Cc", one.ok && hdr(m2.head, "To") === "mike@garymercerteam.com" && hdr(m2.head, "Cc") === null, m2.head.replace(/\r\n/g, " | "));
    const bccd = await E.sendEmailThreadReply(target, "Copying the office quietly.", "intent-bcc-3", head.to, { replyAll: true, bcc: ["james@team.invalid"] });
    const m3 = sent[sent.length - 1];
    c.ok("a typed Bcc rides with Jordan's blind copy, never visible on To or Cc", bccd.ok && hdr(m3.head, "Bcc") === "info@realtourpilot.com, james@team.invalid" && !(hdr(m3.head, "Cc") ?? "").includes("james"), m3.head.replace(/\r\n/g, " | "));

    const before = sent.length;
    const bad = await E.sendEmailThreadReply(target, body, "intent-bad-4", head.to, { cc: "kyle" });
    const inj = await E.sendEmailThreadReply(target, body, "intent-inj-5", head.to, { cc: "a@b.com\r\nBcc: evil@x.com" });
    c.ok("a typed Cc that isn't an address (or smuggles a header) is refused; nothing goes", !bad.ok && !inj.ok && sent.length === before && bad.message === "\"kyle\" isn't an email address. Nothing was sent.", `${bad.message} / ${inj.message}`);

    const link = "Here's your link: https://hub.realtourpilot.com/portal/auth/abcdEFGH1234 to sign in.";
    const before6 = sent.length;
    const solo = await E.sendEmailThreadReply(target, link, "intent-link-6", head.to, { replyAll: true });
    const [m6, copy6] = sent.slice(before6);
    c.ok("a one-time sign-in link goes to Mike alone, and the answer says the 2 others were left off", solo.ok && hdr(m6.head, "To") === "mike@garymercerteam.com" && hdr(m6.head, "Cc") === null && hdr(m6.head, "Bcc") === null && /only \(it carries a one-time sign-in link, so the 2 others on the email were left off\)/.test(solo.message), `${solo.message} | ${m6?.head.replace(/\r\n/g, " | ")}`);
    c.ok("…Jordan's copy of it is the separate one with the link taken out, as before", sent.length === before6 + 2 && hdr(copy6.head, "To") === "info@realtourpilot.com", copy6?.head.replace(/\r\n/g, " | ") ?? "");
    const before7 = sent.length;
    const linkCc = await E.sendEmailThreadReply(target, link, "intent-link-cc-7", head.to, { replyAll: true, cc: "kyle@realtourpilot.com" });
    c.ok("…and with a Cc typed, it is refused rather than copied", !linkCc.ok && sent.length === before7 && linkCc.message.includes("one-time sign-in link"), linkCc.message);

    // A test client: everyone on the reply must be one of Jordan's test inboxes.
    const testC = await prisma.client.create({ data: { name: "Bobby TEST", email: "mike@garymercerteam.com" } });
    const before8 = sent.length;
    const tst = await E.sendEmailThreadReply({ ...target, clientId: testC.id }, "test", "intent-test-8", head.to, { replyAll: true });
    c.ok("a test client's reply is held to the test inboxes, naming who isn't one", !tst.ok && sent.length === before8 && /^Not sent: Bobby TEST is a test client, and mike@garymercerteam\.com isn't one of Jordan's test inboxes\.$/.test(tst.message), tst.message);

    // =====================================================================
    c.head("§2c · the task card's Send email (the same chain)");
    // =====================================================================
    const task = await prisma.smartTask.create({ data: { title: "Reply to Mike Flatley", taskType: "client_reply", status: "OPEN", source: "gmail", sourceDetail: "gmail-thread:info@realtourpilot.com:1a17e895919e68b7", clientId: mike.id, projectId: lakeview.id, priority: "MEDIUM" } as never });
    const who = await E.resolveEmailRecipient(task.id);
    c.ok("the task card reads the whole chain before Send", who.ok && who.to === "mike@garymercerteam.com" && JSON.stringify(who.alsoTo) === "[\"javier@garymercerteam.com\"]" && JSON.stringify(who.cc) === "[\"kim@garymercerteam.com\"]", JSON.stringify(who));
    const t = await E.sendEmailReply(task.id, "Thanks Mike, on it.", { expectedTo: who.to });
    const m9 = sent[sent.length - 1];
    c.ok("…and Send email goes to all of them in the thread, then closes the task", t.ok && hdr(m9.head, "To") === "mike@garymercerteam.com, javier@garymercerteam.com" && hdr(m9.head, "Cc") === "kim@garymercerteam.com" && m9.threadId === "1a17e895919e68b7" && t.message === "Sent to mike@garymercerteam.com, javier@garymercerteam.com, cc kim@garymercerteam.com — task closed.", t.message);

    c.ok("nothing left the drill: every send was the fenced fake", fence.blocked.length === 0, JSON.stringify(fence.blocked));
  } finally {
    quiet.restore?.();
    await db.stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

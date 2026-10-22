// ---------------------------------------------------------------------------
// DRILL: REPLIES ABOUT A SCRIPT LIVE UNDER THE SCRIPT (Oct 22 2026).
//
// Jordan, on Janice Pigga's Program conversation full of "About your script …"
// replies: "Can the replies to the script changes not go to the messages but
// under the scripts?"
//
//   1. An office reply on a change request shows under the script on the
//      portal (her request, then the reply, oldest first, with who and when)
//      and NOT in the Messages thread, on either side. The script's words are
//      never changed by a reply, and nothing is re-shared.
//   2. The client is still told: the same "the office replied" email, behind
//      the same switch, naming the script, with a link that opens the Scripts
//      view at the reply (sends faked at the fence). A script notice never
//      covers a Messages reply, or the other way round.
//   3. A client's reply under a script stays with that script, and reaches the
//      office the way a client message does: assigned to Kyle (the MESSAGES
//      owner), the desk task, the bell and the Slack post, each naming the
//      script; it also waits on the office's Messages tab (both places), and
//      on the script's request card.
//   4. A general message still goes to Messages, and a reply under the script
//      does not answer it.
//   5. Old "about a script" messages are untouched: still in Messages, also
//      shown under their script, read-only, matched by the id they carry.
//
// ISOLATION: PGlite via the shared harness. Gmail, Google's token endpoint and
// Slack are FAKES at the fence; OpenPhone is stubbed in-process. Nothing leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { plainTextOfMime } from "@/lib/emailHtml";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7141);
installNextStubs();

type Mail = { to: string; subject: string; body: string };
const mails: Mail[] = [];
const slackPosts: { channel: string; text: string }[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (url === "https://slack.com/api/chat.postMessage") {
    const b = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    slackPosts.push({ channel: String(b.channel ?? ""), text: String(b.text ?? "") });
    return json({ ok: true, ts: `${slackPosts.length}.0001` });
  }
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head] = text.split("\r\n\r\n");
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    mails.push({ to: /^To: (.+)$/m.exec(head)?.[1] ?? "", subject: Buffer.from(subj, "base64").toString("utf8"), body: plainTextOfMime(text) });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});
const EM = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-script-replies", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const pm = await import("@/lib/programMessages");
  const scripts = await import("@/lib/contentScripts");
  const portalActions = await import("@/app/portal/actions");
  const officeActions = await import("@/app/content/actions");
  const req = await import("@/lib/scriptRequests");
  const { threadAnchor } = await import("@/lib/scriptThread");
  const { portalTopics } = await import("@/lib/portal");
  const { setSession } = await import("@/lib/auth/session");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { etAt } = await import("@/lib/datetime");
  const { resolvePortalRoute } = await import("@/lib/portalNav");
  const { subjectFor } = await import("@/lib/outbox");
  const REPO = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  try {
    // ---- the office ------------------------------------------------------
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@realtourpilot.com" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const owner = await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "MESSAGES", appUserId: kyle.id, label: "Kyle Drill", setBy: "drill" } });
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await saveSecret("slack", "xoxb-drill-not-a-real-token");
    process.env.SLACK_ALERT_CHANNEL = "C0DRILLOPS";
    // OpenPhone in-process: no number to text from, nobody texted (Kyle's phone is the office line).
    const op = await import("@/lib/integrations/openphone");
    const texts: string[] = [];
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: string) => { texts.push(String(to)); return { data: { id: "op-1" } }; };
    await setSession({ uid: owner.id, email: owner.email, role: "OWNER" });

    // ---- the client: Janice, a TEST account first (the reply email's floor) --
    const F = await buildContentMonth(db, { name: "Janice Pigga TEST", package: "Accelerator", owner: { email: "info+janicetest@realtourpilot.com", name: "Janice Pigga" }, topics: [{ title: "Neighbor's Sale", selection: "SELECTED" }, { title: "Working With Me", selection: "SELECTED" }] });
    const auth = { token: F.portalToken! };
    const staff = { email: owner.email, appUserId: owner.id };
    const V1 = {
      hook: "Your neighbor's sale price is only part of the story.",
      points: [{ role: "re-hook" as const, text: "Buyers compare your home with everything else for sale that same weekend." }, { role: "build-up" as const, text: "Pricing, preparation and marketing all matter, and their timing may have been different." }, { role: "payoff" as const, text: "I study what is selling and what is sitting, and give honest advice on where your home fits." }],
      close: "Thinking about selling? Let's build a plan for today's market.",
    };
    const make = async (i: number, title: string) => {
      const v = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[i], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title, ...V1, captionCta: null } });
      await scripts.approveScriptVersion(v.versionId, staff, "drill: no pillar yet");
      await scripts.releaseScriptVersion(v.scriptId, staff);
      return v;
    };
    const A = await make(0, "Your Neighbor's Sale Price Is Only Part of the Story");
    const B = await make(1, "What It's Like Working With Me");
    const scriptState = async (id: string) => {
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id } });
      const v = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: s.sharedVersionId! } });
      return JSON.stringify({ shared: s.sharedVersionId, current: s.currentVersionId, release: s.releaseState, versions: await prisma.contentScriptVersion.count({ where: { scriptId: id } }), releases: await prisma.contentScriptRelease.count({ where: { scriptId: id } }), words: [v.title, v.hook, v.pointsJson, v.close, v.body] });
    };
    const before = { A: await scriptState(A.scriptId), B: await scriptState(B.scriptId) };
    const clientKey = "tok";
    const clientThread = () => pm.threadFor(F.enrollmentId, clientKey, { audience: "client" });
    const staffThread = () => pm.threadFor(F.enrollmentId, `au:${kyle.id}`, { audience: "staff" });
    const threadOf = async (scriptId: string) => (await portalTopics({ id: F.enrollmentId, clientId: F.clientId })).groups.flatMap((g) => g.topics).find((t) => t.script?.id === scriptId)?.script?.thread ?? [];

    // An "about a script" reply from before today, in her Messages (refKind SCRIPT), ten days old.
    const legacy = await prisma.programMessage.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, authorKind: "STAFF", staffUserId: owner.id, authorLabel: "Jordan Spackman", body: `About your script "${"What It's Like Working With Me"}":\n\nHi Janice, thank you for sharing that reference reel.`, refKind: "SCRIPT", refId: B.scriptId, createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    const legacySnap = JSON.stringify(legacy);

    // ======================================================================
    c.head("1 · an office reply on a change request lives under the script, not in Messages");
    const asked = await portalActions.portalRequestScriptChanges(auth, A.scriptId, "Can we open with the neighbor's price instead of a question?", A.versionId, ["hook"]);
    const sugg = await prisma.scriptSuggestion.findFirstOrThrow({ where: { scriptId: A.scriptId, status: "OPEN" } });
    c.ok("the client's change request is filed", asked.ok, asked.message);
    // What the script is once she has asked (her request writes its own ledger row); no reply may change any of it.
    before.A = await scriptState(A.scriptId);
    const unreadBefore = await pm.unreadForReader(F.enrollmentId, clientKey);
    const rep = await officeActions.replyToScriptRequestAction(sugg.id, "Yes we can do this!");
    const R1 = await prisma.programMessage.findFirstOrThrow({ where: { enrollmentId: F.enrollmentId, authorKind: "STAFF", refId: A.scriptId }, orderBy: { createdAt: "desc" } });
    c.ok("the office's reply is stored under that script (SCRIPT_THREAD), in plain words (no 'About your script' prefix)", rep.ok && R1.refKind === pm.SCRIPT_THREAD && R1.body === "Yes we can do this!" && R1.authorLabel === "Jordan Spackman", `${rep.message} · ${R1.refKind}`);
    c.ok("…the office is told where it went, with no em dash", /under the script on their page/.test(rep.message) && !/their Messages/.test(rep.message) && !EM.test(rep.message), rep.message);
    const ct = await clientThread();
    c.ok("NOT in the client's Messages thread", !ct.messages.some((m) => m.id === R1.id));
    c.ok("…and not counted on their Messages badge", (await pm.unreadForReader(F.enrollmentId, clientKey)) === unreadBefore, `${unreadBefore}`);
    c.ok("NOT in the office's Messages thread either (Jordan's ask was about this screen)", !(await staffThread()).messages.some((m) => m.id === R1.id));
    const tA = await threadOf(A.scriptId);
    c.ok("on the portal under the script: her request, then the reply, oldest first", tA.length === 2 && tA[0].kind === "request" && tA[0].from === "client" && tA[0].body.startsWith("Can we open with the neighbor's price") && tA[1].kind === "message" && tA[1].from === "office" && tA[1].body === "Yes we can do this!" && tA[0].atISO <= tA[1].atISO, JSON.stringify(tA.map((m) => [m.kind, m.from, m.by])));
    c.ok("…with who and when (first names, never an email)", tA[0].by === "Janice" && tA[1].by === "Jordan" && tA.every((m) => !!Date.parse(m.atISO) && !m.by.includes("@")));
    c.ok("…the reply carries the anchor the email links to", tA[1].anchor === threadAnchor(R1.id) && tA[1].anchor === `reply-${R1.id}`);
    const card = (await req.loadScriptRequestsForMonth(F.monthId)).find((g) => g.scriptId === A.scriptId)!;
    c.ok("in the office, on the script's change-request card, as before", card.requests[0].id === sugg.id && card.requests[0].replies.length === 1 && card.requests[0].replies[0].body === "Yes we can do this!" && card.requests[0].replies[0].from === "office");
    c.ok("Your Month counts it for her (the Messages badge does not)", (await pm.unreadScriptReplies(F.enrollmentId, clientKey)) === 1);
    await pm.markThreadRead(F.enrollmentId, pm.scriptsReaderKey(clientKey));
    c.ok("…and opening the Scripts view clears it", (await pm.unreadScriptReplies(F.enrollmentId, clientKey)) === 0);
    c.ok("the reply changed no words of the script and re-shared nothing", (await scriptState(A.scriptId)) === before.A, await scriptState(A.scriptId));

    // ======================================================================
    c.head("2 · the client is told: the same email, a link to the script");
    // A Tuesday at 11am ET at least a day ahead of the real clock (see cp13 §8).
    const nextTuesdayKey = (() => {
      const wk = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
      const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
      for (let d = new Date(Date.now() + 36 * 3_600_000); ; d = new Date(d.getTime() + 86_400_000)) if (wk.format(d) === "Tue") return ymd.format(d);
    })();
    const T = etAt(nextTuesdayKey, 11);
    await prisma.programMessage.update({ where: { id: R1.id }, data: { createdAt: new Date(T.getTime() - 5 * 60_000) } });
    const notices = () => prisma.outboxMessage.findMany({ where: { requestedBy: "program-message-notice" }, orderBy: { createdAt: "asc" } });
    c.ok("with the reply email switched off (as written above), nothing was sent", (await notices()).length === 0 && mails.length === 0);
    await prisma.programAutomation.create({ data: { key: pm.NOTICE_KEY, enabled: true, enabledBy: "drill", enabledAt: new Date() } });
    const swept = await pm.sweepProgramMessageNotices({ now: T, enrollmentId: F.enrollmentId });
    const rows = await notices();
    c.ok("on, a weekday: exactly one email, to her seat, through the same sweep and outbox", swept.sent === 1 && rows.length === 1 && rows[0].toRef === "info+janicetest@realtourpilot.com" && rows[0].state === "accepted", JSON.stringify({ sent: swept.sent, notes: swept.notes }));
    c.ok("…its key marks it a script reply (the outbox's kind is still program_message)", rows[0].dedupeKey === pm.programMessageNoticeKey(R1.id, F.clientUserId!, true) && rows[0].dedupeKey!.startsWith("program_message:") && rows[0].dedupeKey!.endsWith(":script"));
    const mail = mails.at(-1);
    const link = `https://hub.example.test/portal/me?e=${encodeURIComponent(F.enrollmentId)}&tab=plan&pv=scripts#reply-${R1.id}`;
    c.ok("…under its own subject, naming the script, with the reply", !!mail && mail.subject === "A reply about your script in your Realtour Pilot portal" && mail.body.includes("Jordan replied about your script \"Your Neighbor's Sale Price Is Only Part of the Story\"") && mail.body.includes("Yes we can do this!"), `${mail?.subject}`);
    c.ok("…its link opens the portal at that script, scrolled to the reply (not the Messages tab)", !!mail && mail.body.includes(link) && !mail.body.includes("tab=messages") && !mail.body.includes("/portal/login"), mail?.body);
    const r = resolvePortalRoute({ tab: "plan", pv: "scripts" });
    c.ok("…that address is the Scripts view, and the anchor is the reply's own", r.dest === "plan" && r.planView === "scripts" && link.endsWith(`#${tA[1].anchor}`));
    c.ok("…plain words, no em dash", !!mail && !EM.test(mail.body) && !EM.test(mail.subject));
    const again = await pm.sweepProgramMessageNotices({ now: new Date(T.getTime() + 3_600_000) });
    c.ok("the next hourly tick sends nothing more", again.sent === 0 && (await notices()).length === 1);
    // A Messages reply an hour later: its own email, not covered by the script one.
    const G1 = await pm.postStaffMessage(F.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "Your session is booked for Tuesday at 2.", null, { now: new Date(T.getTime() + 60 * 60_000) });
    const rows2 = await notices();
    const mail2 = mails.at(-1);
    c.ok("a general reply in Messages still gets the Messages email (a script notice never covers it)", G1.ok && rows2.length === 2 && !rows2[1].dedupeKey!.endsWith(":script") && mail2?.subject === "New reply in your Realtour Pilot portal" && mail2.body.includes("/portal/login") && mail2.body.includes("Your session is booked"), mail2?.subject);
    c.ok("…and that reply IS in her Messages thread", (await clientThread()).messages.some((m) => m.id === G1.id && m.authorKind === "STAFF"));
    const pure = pm.composeReplyNotice({ name: "Janice Pigga", staffName: "Jordan", body: "Yes — we can.", script: { title: "Pricing – Part Two", link } });
    c.ok("the script email keeps the no-em-dash rule even when the title or the reply has one", !EM.test(pure) && pure.includes("Pricing, Part Two") && pure.includes("Yes, we can."));
    c.ok("the outbox names the two subjects apart", subjectFor("program_message", "program_message:m:u:script") !== subjectFor("program_message", "program_message:m:u"));

    // ======================================================================
    c.head("3 · a client's reply under a script reaches the office, labelled with the script");
    // The desk task and the alerts skip a TEST account by name: from here Janice is a real client.
    await prisma.client.update({ where: { id: F.clientId }, data: { name: "Janice Pigga" } });
    const [s0, b0] = [slackPosts.length, await prisma.notification.count({ where: { kind: "program_message" } })];
    const cr = await portalActions.portalReplyUnderScript(auth, A.scriptId, "Great, and can we keep my line about the neighbors?");
    const CR = await prisma.programMessage.findFirstOrThrow({ where: { enrollmentId: F.enrollmentId, authorKind: "CLIENT", refId: A.scriptId } });
    c.ok("the portal accepts it, in plain words", cr.ok && cr.message === "Sent. We'll reply right here, under the script." && !EM.test(cr.message), cr.message);
    c.ok("stored as hers, under that script, assigned to Kyle (the MESSAGES owner)", CR.refKind === pm.SCRIPT_THREAD && CR.assignedAppUserId === kyle.id && CR.handledAt === null && CR.body === "Great, and can we keep my line about the neighbors?");
    c.ok("it stays with the script on her page", (await threadOf(A.scriptId)).some((m) => m.id === CR.id && m.from === "client" && m.by === "Janice" && m.anchor === `reply-${CR.id}`));
    c.ok("…and is not in her Messages thread", !(await clientThread()).messages.some((m) => m.id === CR.id));
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${F.enrollmentId}` } });
    c.ok("Kyle's desk task: open, his, naming the script and where to answer it", task?.status === "OPEN" && task.assignedKey === "kyle" && (task.description ?? "").includes(`(under the script "Your Neighbor's Sale Price Is Only Part of the Story")`) && /answered under that script/.test(task.description ?? ""), task?.description ?? "");
    c.ok("Kyle's unread threads list it", (await pm.unreadThreadsForStaff(kyle.id)).some((t) => t.enrollmentId === F.enrollmentId && t.unanswered === 1));
    const bell = await prisma.notification.findFirst({ where: { kind: "program_message" }, orderBy: { createdAt: "desc" } });
    c.ok("the bell rings, naming the script", (await prisma.notification.count({ where: { kind: "program_message" } })) > b0 && (bell?.body ?? "").includes("under the script"), bell?.body ?? "");
    const post = slackPosts.slice(s0);
    c.ok("the ops Slack post names the script", post.length === 1 && post[0].text.includes("Janice Pigga") && post[0].text.includes("under the script") && post[0].text.includes("keep my line about the neighbors"), JSON.stringify(post));
    const st = await staffThread();
    const inStaff = st.messages.find((m) => m.id === CR.id);
    c.ok("it ALSO waits on the office's Messages tab (both places), labelled with the script and a link to its card", !!inStaff && !inStaff.handled && inStaff.script?.title === "Your Neighbor's Sale Price Is Only Part of the Story" && inStaff.script.href.includes("tab=plan") && inStaff.script.href.includes("view=scripts") && inStaff.script.href.endsWith(`#script-requests-${A.scriptId}`), JSON.stringify(inStaff?.script));
    c.ok("…the office's reply under the script is still not on that tab", !st.messages.some((m) => m.id === R1.id));
    const tab = await pm.staffMessagesTab(F.enrollmentId, { id: kyle.id });
    c.ok("…and in the tab's waiting count", tab?.unanswered === 1);
    const card2 = (await req.loadScriptRequestsForMonth(F.monthId)).find((g) => g.scriptId === A.scriptId)!;
    const onCard = card2.requests[0].replies.find((m) => m.id === CR.id);
    c.ok("on the script's request card: her reply, marked waiting", !!onCard && onCard.from === "client" && onCard.waiting && onCard.by.startsWith("Janice Pigga"));
    c.ok("her reply changed no words of the script and re-shared nothing", (await scriptState(A.scriptId)) === before.A);

    // ======================================================================
    c.head("4 · a general message still goes to Messages; a reply under the script answers only the script");
    const gen = await portalActions.portalPostMessage(auth, { body: "I need later in the day for scheduling time to film." });
    const GEN = await prisma.programMessage.findUniqueOrThrow({ where: { id: gen.id! } });
    c.ok("a general message: in Messages (no script), on both sides", gen.ok && GEN.refKind === null && (await clientThread()).messages.some((m) => m.id === GEN.id) && (await staffThread()).messages.some((m) => m.id === GEN.id && !m.script));
    const task2 = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${F.enrollmentId}` } });
    c.ok("the desk task lists both, the script one labelled", /2 messages are waiting/.test(task2.description ?? "") && (task2.description ?? "").includes("later in the day"));
    const sugg2 = await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sugg.id } });
    const rep2 = await officeActions.replyToScriptRequestAction(sugg2.id, "Yes, your line about the neighbors stays.");
    c.ok("the office answers under the script", rep2.ok, rep2.message);
    c.ok("…her reply under the script is answered", (await prisma.programMessage.findUniqueOrThrow({ where: { id: CR.id } })).handledAt !== null);
    c.ok("…her general message is NOT (it is not about the script)", (await prisma.programMessage.findUniqueOrThrow({ where: { id: GEN.id } })).handledAt === null);
    const task3 = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${F.enrollmentId}` } });
    c.ok("…the desk task stays open, now listing only the general message", task3.status === "OPEN" && /A message is waiting/.test(task3.description ?? "") && !(task3.description ?? "").includes("under the script"), task3.description ?? "");
    const gr = await pm.postStaffMessage(F.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "Afternoons work. I'll book 2pm.", GEN.id);
    c.ok("a reply in Messages answers it and closes the task", gr.ok && (await prisma.programMessage.findUniqueOrThrow({ where: { id: GEN.id } })).handledAt !== null && (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${F.enrollmentId}` } })).status === "COMPLETED");
    c.ok("…and that reply is in her Messages", (await clientThread()).messages.some((m) => m.id === gr.id));

    // ======================================================================
    c.head("5 · old 'about a script' messages are untouched");
    const legacyNow = await prisma.programMessage.findUniqueOrThrow({ where: { id: legacy.id } });
    c.ok("the row is exactly as it was (not moved, not edited, not deleted)", JSON.stringify(legacyNow) === legacySnap);
    c.ok("still in her Messages thread, and the office's", (await clientThread()).messages.some((m) => m.id === legacy.id) && (await staffThread()).messages.some((m) => m.id === legacy.id));
    const tB = await threadOf(B.scriptId);
    c.ok("also shown under its script, read-only, matched by the script id it carries (prefix dropped)", tB.length === 1 && tB[0].id === legacy.id && tB[0].from === "office" && tB[0].body === "Hi Janice, thank you for sharing that reference reel.");
    c.ok("never matched by title: a message naming the script in words but carrying no id stays out", await (async () => {
      const loose = await prisma.programMessage.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, authorKind: "STAFF", authorLabel: "Jordan Spackman", body: `About your script "What It's Like Working With Me":\n\nOne more thought.` } });
      const t = await threadOf(B.scriptId);
      return !t.some((m) => m.id === loose.id);
    })());
    c.ok("script B was never touched", (await scriptState(B.scriptId)) === before.B);

    // ======================================================================
    c.head("6 · staff through the owner iframe write under the script as the office");
    const iframe = { enrollment: { id: F.enrollmentId, clientId: F.clientId, clientName: "Janice Pigga", status: "ACTIVE", videosPerMonth: 4, sessionsPerMonth: 1 }, actor: { kind: "STAFF", staffUserId: owner.id, staffName: "Jordan Spackman", staffRole: "OWNER" }, access: "FULL", via: "STAFF" } as unknown as import("@/lib/portal").PortalViewer;
    const sr = await pm.postClientMessage(iframe, { body: "Adding the neighbors line now.", ref: { kind: "SCRIPT", id: A.scriptId }, placement: "script" });
    const SR = sr.id ? await prisma.programMessage.findUnique({ where: { id: sr.id } }) : null;
    c.ok("stored as the office's, under the script, never as hers", sr.ok && SR?.authorKind === "STAFF" && SR.refKind === pm.SCRIPT_THREAD && SR.refId === A.scriptId, sr.message);
    const foreign = await buildContentMonth(db, { name: "Someone Else TEST", topics: [{ title: "Other", selection: "SELECTED" }] });
    const fv = await scripts.createScriptVersion({ enrollmentId: foreign.enrollmentId, monthId: foreign.monthId, topicId: foreign.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title: "Theirs", ...V1, captionCta: null } });
    const cross = await portalActions.portalReplyUnderScript(auth, fv.scriptId, "Not my script.");
    c.ok("a reply under another account's script is refused", !cross.ok && (await prisma.programMessage.count({ where: { refId: fv.scriptId } })) === 0, cross.message);

    // ======================================================================
    c.head("7 · the copy");
    const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const strings = (raw: string) => { const src = code(raw); return [...src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g), ...src.matchAll(/"([^"\n]{12,})"/g), ...src.matchAll(/`([^`\n]{12,})`/g)].map((m) => m[1]); };
    const threadUi = read("src/components/portal/ScriptThread.tsx");
    c.ok("the thread under the script prints no em dash", !strings(threadUi).some((s) => EM.test(s)));
    c.ok("…and has the reply box: Reply about this script, Send reply", /Reply about this script/.test(threadUi) && /Send reply/.test(threadUi) && /portalReplyUnderScript/.test(threadUi));
    const plan = read("src/components/portal/tabs/PlanTab.tsx");
    const cardUi = read("src/components/portal/ScriptApprovalCard.tsx");
    c.ok("the thread is under every script the Scripts view lists: the card, and each script she asked to change", /<ScriptThread scriptId=\{script\.id\} items=\{script\.thread/.test(cardUi) && /<ScriptThread scriptId=\{t\.script\.id\} items=\{t\.script\.thread/.test(plan) && /id=\{`script-\$\{t\.id\}`\}/.test(plan));
    const panel = read("src/components/content/ScriptRequestsPanel.tsx");
    c.ok("the office card says where the reply goes", /under this script on their page, not in their Messages/.test(panel) && /Reply to \{first\} under this script/.test(panel));

    c.ok("no call left the drill (Gmail, Google and Slack answered at the fence; nobody was texted)", fence.blocked.length === 0 && texts.length === 0 && fence.faked.every((u) => /slack\.com|googleapis\.com/.test(u)), fence.blocked.join(", "));
  } finally {
    delete process.env.SLACK_ALERT_CHANNEL;
    quiet.restore();
    c.summary();
    await stop();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

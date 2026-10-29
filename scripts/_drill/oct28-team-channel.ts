// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Oct 28 2026: THE TEAM CHANNEL (Jordan: "Please also add a team messages
// channel so all team members can message"), the Archived fold for finished
// work ("Also messages for any inactive work should be archived") and the
// ten-day fold on job pages ("any communications older than 10 days should be
// collapsed"). The real server actions, loaders and the unread route run on an
// isolated PGlite database with AUTH_ENFORCE on. Nothing leaves: no text,
// email or Slack (fenceFetch, and the roster has no phones or Slack ids).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5646), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct28-team-channel-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { postTeamChannelMessage, markTeamChannelRead } = await import("@/app/projects/teamChannelActions");
    const { postProjectMessage, markProjectMessagesRead } = await import("@/app/projects/messageActions");
    const { teamChannelUnread, loadTeamChannel } = await import("@/lib/teamChannel");
    const { canReadConversation } = await import("@/lib/hubLinkAccess");
    const { loadTeamChat, loadThread } = await import("@/components/comms/TeamMessagesPanel");
    const { teamChatConversations, finishedWork, threadIsArchived, ARCHIVE_RECENT_POST_MS } = await import("@/lib/editorQueue");
    const { messageExtras, messageFoldCutoff } = await import("@/lib/messageExtras");
    const unreadRoute = await import("@/app/api/messages/unread/route");
    const { ProjectMessages, TeamChannelMessages } = await import("@/components/project/ProjectMessages");

    // ---- the team -------------------------------------------------------
    const tm = (name: string, email: string, role: "ADMIN" | "EDITOR" | "PHOTOGRAPHER") => prisma.teamMember.create({ data: { name, email, role } });
    const jordanTm = await tm("Jordan Spackman", "jordan-tm-oct28@example.test", "ADMIN");
    const kyleTm = await tm("Kyle Smith", "kyle-tm-oct28@example.test", "ADMIN");
    const jamesTm = await tm("James Hart", "james-tm-oct28@example.test", "PHOTOGRAPHER");
    const kimTm = await tm("Kim Miguel", "kim-tm-oct28@example.test", "EDITOR");
    const johnTm = await tm("John Mark", "john-tm-oct28@example.test", "EDITOR");
    const harrisonTm = await tm("Harrison Lee", "harrison-tm-oct28@example.test", "PHOTOGRAPHER");
    const login = (email: string, name: string, role: string, extra: { teamMemberId?: string; editorKey?: string } = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra } });
    const jordan = await login("jordan-oct28@example.test", "Jordan Spackman", "OWNER", { teamMemberId: jordanTm.id });
    const kyle = await login("kyle-oct28@example.test", "Kyle Smith", "ADMIN", { teamMemberId: kyleTm.id });
    const james = await login("james-oct28@example.test", "James Hart", "CREATIVE_MANAGER", { teamMemberId: jamesTm.id });
    const kim = await login("kim-oct28@example.test", "Kim Miguel", "EDITOR", { teamMemberId: kimTm.id, editorKey: "kim" });
    const john = await login("john-oct28@example.test", "John Mark", "EDITOR", { teamMemberId: johnTm.id, editorKey: "john" });
    const harrison = await login("harrison-oct28@example.test", "Harrison Lee", "PHOTOGRAPHER", { teamMemberId: harrisonTm.id });
    // An editor login nobody has linked to an editor profile yet.
    const riley = await login("riley-oct28@example.test", "Riley New", "EDITOR");
    const everyone = [jordan, kyle, james, kim, john, harrison, riley];

    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, actingAs });
    const as = async (u: { id: string; email: string; role: string }) => { await signIn(u); return getCurrentUser(); };
    const newest = () => prisma.teamChannelMessage.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const rejects = async (action: () => Promise<unknown>, expected: RegExp) => {
      try { await action(); return false; } catch (e) { return e instanceof Error && expected.test(e.message); }
    };
    const pause = () => new Promise((r) => setTimeout(r, 5));

    c.head("1 · posting, and who it is unread for");
    await signIn(kyle);
    const p1 = await postTeamChannelMessage("Morning everyone. The office closes at 3 today.");
    const first = await newest();
    c.ok("Kyle's post saves on the team channel", p1.ok && first.channel === "team" && first.body.startsWith("Morning everyone"), p1.message);
    c.ok("it is posted as the login: his roster row and name", first.authorUserId === kyle.id && first.authorId === kyleTm.id && first.authorName === "Kyle Smith");
    c.ok("your own post is not unread to you", !(await teamChannelUnread(kyle.id)));
    const unreadFor = await Promise.all(everyone.filter((u) => u.id !== kyle.id).map((u) => teamChannelUnread(u.id)));
    c.ok("it is unread for every other login (owner, office, creative manager, editors, photographer)", unreadFor.length === 6 && unreadFor.every(Boolean));
    c.ok("a plain post rings nobody: no bell row, no text, no Slack", (await prisma.notification.count()) === 0 && (await prisma.pendingSms.count()) === 0 && fence.blocked.length === 0);
    c.ok("an empty post is refused in plain words", !(await postTeamChannelMessage("   ")).ok);

    c.head("2 · everyone on the team can read it");
    for (const u of everyone) {
      const v = await as(u);
      c.ok(`${u.name} (${u.role}) can read the channel`, await canReadConversation(v, { kind: "team" }));
    }
    c.ok("signed out, nobody can", !(await canReadConversation(null, { kind: "team" })));

    const kimMe = await as(kim);
    const kimChat = await loadTeamChat({ scope: { kind: "editor", editorKey: "kim" }, viewer: kimMe, selectedId: "team", user: kimMe });
    c.ok("Kim's message center: the channel row is unread and ?t=team opens it", kimChat.channel.selected && kimChat.channel.unread && kimChat.thread?.messages.at(-1)?.id === first.id);
    const hMe = await as(harrison);
    const hChat = await loadTeamChat({ scope: { kind: "photographer", memberId: harrisonTm.id }, viewer: hMe, selectedId: "team", user: hMe });
    c.ok("Harrison (photographer) reads it in his own center", hChat.channel.unread && !!hChat.thread?.messages.some((m) => m.id === first.id));
    const rMe = await as(riley);
    const rChat = await loadTeamChat({ scope: { kind: "channel" }, viewer: rMe, selectedId: "team", user: rMe });
    c.ok("an unlinked editor gets the channel and no job thread", rChat.open.length + rChat.closed.length + rChat.archived.length === 0 && !!rChat.thread?.messages.some((m) => m.id === first.id));
    const ownerChannel = await loadTeamChannel(await as(jordan));
    c.ok("the owner's load shows the same messages, oldest first", ownerChannel.length === 1 && ownerChannel[0].id === first.id);

    c.head("3 · reading it");
    await signIn(kim);
    const read = await markTeamChannelRead(first.id);
    c.ok("Kim marks it read: it stops counting for her only", read.ok && !(await teamChannelUnread(kim.id)) && (await teamChannelUnread(john.id)));
    await signIn(jordan, kim.id);
    c.ok("a 'view as' preview can't mark it read or post", (await rejects(() => markTeamChannelRead(first.id), /previewing/)) && (await rejects(() => postTeamChannelMessage("from a preview"), /previewing/)) && (await prisma.teamChannelMessage.count()) === 1);

    c.head("4 · @mentions and replies tell only who they name");
    await pause();
    await signIn(kyle);
    const tag = await postTeamChannelMessage("@Kim Miguel can you send me the Lakeview reel when it's ready", [kimTm.id]);
    const tagMsg = await newest();
    const kimRows = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: `channel-mention-${tagMsg.id}-` } } });
    c.ok("a tag reaches the tagged person", tag.ok && kimRows.length >= 1 && kimRows.every((r) => r.kind === "mention" && (r.userKey === `tm:${kimTm.id}` || r.userKey === "editor:kim")), kimRows.map((r) => r.userKey).join(","));
    c.ok("the bell says who and where, and opens the channel at the message", kimRows.some((r) => r.title === "Kyle mentioned you in the team channel" && r.href === `/editing/messages?t=team#msg-${tagMsg.id}`), kimRows.map((r) => `${r.title} ${r.href}`).join(" | "));
    // The one office row a tag may raise is notify's existing weekly setup
    // nudge ("Kim has no Slack ID on file"): the fixture's Kim has none. It is
    // about Kim's profile, not the post, and job-thread tags raise it too.
    const otherRows = await prisma.notification.findMany({
      where: { kind: { not: "slack_id_missing" }, OR: [{ userKey: null }, { userKey: { notIn: [`tm:${kimTm.id}`, "editor:kim"] } }] },
      select: { kind: true, userKey: true, title: true, dedupeKey: true },
    });
    c.ok("nobody else gets a row, and nothing is a broadcast", otherRows.length === 0, JSON.stringify(otherRows));
    c.ok("a tag is unread for everyone else too (it is still the channel)", (await teamChannelUnread(john.id)) && (await teamChannelUnread(kim.id)));

    await pause();
    const typed = await postTeamChannelMessage("@John Mark the horizontal export is on the drive");
    const typedMsg = await newest();
    c.ok("a hand-typed full name tags too (the roster matcher)", typed.ok && (await prisma.notification.count({ where: { dedupeKey: { startsWith: `channel-mention-${typedMsg.id}-${johnTm.id}` } } })) >= 1);

    await pause();
    await signIn(kim);
    const reply = await postTeamChannelMessage("Yes, tonight my time.", [], tagMsg.id);
    const replyMsg = await newest();
    const kyleRows = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: `channel-reply-${replyMsg.id}-` } } });
    c.ok("a reply keeps what it answers", reply.ok && replyMsg.replyToId === tagMsg.id);
    c.ok("the person answered (Kyle) is told, and only Kyle", kyleRows.length >= 1 && kyleRows.every((r) => r.kind === "note_reply" && r.userKey === `tm:${kyleTm.id}` && r.href.startsWith("/communications?tab=team&t=team#msg-")), kyleRows.map((r) => `${r.userKey} ${r.href}`).join(" | "));
    c.ok("now unread for Kyle, not for Kim who wrote it", (await teamChannelUnread(kyle.id)) && !(await teamChannelUnread(kim.id)));
    await pause();
    const selfTag = await postTeamChannelMessage("@Kim Miguel note to self: export at 1080p", [kimTm.id]);
    const selfMsg = await newest();
    c.ok("tagging yourself rings nobody", selfTag.ok && (await prisma.notification.count({ where: { dedupeKey: { contains: selfMsg.id } } })) === 0);

    c.head("5 · the messages icon counts the channel for every login");
    const client = await prisma.client.create({ data: { name: "Oct28 Channel Client TEST" } });
    const mine = await prisma.project.create({ data: { clientId: client.id, title: "12 Birch Ln, Media PA", addressLine: "12 Birch Ln", status: "EDITING", photographerId: harrisonTm.id, editorId: kimTm.id } });
    const notMine = await prisma.project.create({ data: { clientId: client.id, title: "9 Oak St, Media PA", addressLine: "9 Oak St", status: "EDITING", photographerId: jamesTm.id } });
    await prisma.projectMessage.create({ data: { projectId: notMine.id, body: "Not Harrison's job", authorName: "Kyle Smith", authorId: kyleTm.id } });
    const iconOf = async (u: { id: string; email: string; role: string }) => {
      await signIn(u);
      const res = await unreadRoute.GET();
      return (await res.json()) as { team: number; teamHref: string | null; clients: number };
    };
    const hIcon = await iconOf(harrison);
    c.ok("Harrison (photographer) has a Team count and a center to open", hIcon.team >= 1 && hIcon.teamHref === "/editing/messages", JSON.stringify(hIcon));
    const rIcon = await iconOf(riley);
    c.ok("an unlinked editor: exactly the channel", rIcon.team === 1 && rIcon.teamHref === "/editing/messages", JSON.stringify(rIcon));
    const kIcon = await iconOf(kyle);
    c.ok("Kyle (office): the channel counts beside the job threads, in Messages → Team", kIcon.team >= 1 && kIcon.teamHref === "/communications?tab=team", JSON.stringify(kIcon));
    const hRows = await teamChatConversations({ kind: "photographer", memberId: harrisonTm.id });
    c.ok("a photographer's center lists their own shoots only", hRows.some((r) => r.id === mine.id) && !hRows.some((r) => r.id === notMine.id));
    c.ok("the channel-only scope lists no job thread", (await teamChatConversations({ kind: "channel" })).length === 0);

    c.head("6 · finished work's threads fold under Archived");
    const DAY = 86_400_000;
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
    const job = async (street: string, status: "DELIVERED" | "CANCELLED" | "EDITING", deliveredDaysAgo: number | null) =>
      prisma.project.create({ data: { clientId: client.id, title: `${street}, Media PA`, addressLine: street, status, editorId: kimTm.id, deliveredAt: deliveredDaysAgo == null ? null : at(deliveredDaysAgo) } });
    const say = (projectId: string, body: string, daysAgo: number) =>
      prisma.projectMessage.create({ data: { projectId, body, authorName: "Kim Miguel", authorId: kimTm.id, createdAt: at(daysAgo) } });
    const kyleRead = (projectId: string, daysAgo = 0) => prisma.threadRead.upsert({
      where: { userKey_projectId: { userKey: kyle.id, projectId } },
      create: { userKey: kyle.id, projectId, seenAt: at(daysAgo) },
      update: { seenAt: at(daysAgo) },
    });
    const done = await job("1 Done Rd", "DELIVERED", 6); await say(done.id, "Final cut is uploaded.", 8); await kyleRead(done.id);
    const cancelled = await job("2 Cancel Ct", "CANCELLED", null); await say(cancelled.id, "Client cancelled.", 9); await kyleRead(cancelled.id);
    const unreadDone = await job("3 Unread Way", "DELIVERED", 6); await say(unreadDone.id, "Sent the last version.", 7);
    const taskDone = await job("4 Task Pl", "DELIVERED", 6); await say(taskDone.id, "Delivered.", 7); await kyleRead(taskDone.id);
    await prisma.smartTask.create({ data: { clientId: client.id, projectId: taskDone.id, taskType: "revision", title: "Client revision: shorter intro", status: "OPEN" } });
    const cutDone = await job("5 Cut Ave", "DELIVERED", 6); await say(cutDone.id, "Delivered.", 7); await kyleRead(cutDone.id);
    await prisma.reviewSubmission.create({ data: { projectId: cutDone.id, fileName: "recut.mp4", status: "PENDING" } });
    const askDone = await job("6 Question St", "DELIVERED", 6); await say(askDone.id, "Did the client get the horizontal version?", 5); await kyleRead(askDone.id);
    const lateDone = await job("7 Late Ln", "DELIVERED", 6); await say(lateDone.id, "Client says thanks, all good.", 1); await kyleRead(lateDone.id);
    const live = await job("8 Live Blvd", "EDITING", null); await say(live.id, "Starting the edit.", 2); await kyleRead(live.id);

    const finished = await finishedWork([done.id, cancelled.id, unreadDone.id, taskDone.id, cutDone.id, askDone.id, lateDone.id, live.id]);
    c.ok("finished work: delivered or cancelled, no open task, no cut waiting", finished.has(done.id) && finished.has(cancelled.id) && finished.has(unreadDone.id) && !finished.has(taskDone.id) && !finished.has(cutDone.id) && !finished.has(live.id));
    const kyleMe = await as(kyle);
    const chat = await loadTeamChat({ scope: { kind: "office" }, viewer: kyleMe, view: "all", user: kyleMe });
    const archivedIds = new Set(chat.archived.map((r) => r.id));
    const openIds = new Set(chat.open.map((r) => r.id));
    c.ok("a delivered job, read, nothing open: Archived, not in the list", archivedIds.has(done.id) && !openIds.has(done.id));
    c.ok("a cancelled job, read: Archived", archivedIds.has(cancelled.id));
    c.ok("unread for the viewer: stays in the list", openIds.has(unreadDone.id) && !archivedIds.has(unreadDone.id));
    c.ok("an open task or a cut waiting: stays in the list", openIds.has(taskDone.id) && openIds.has(cutDone.id) && !archivedIds.has(taskDone.id) && !archivedIds.has(cutDone.id));
    c.ok("waiting on an answer (last word a question): stays", openIds.has(askDone.id) && !archivedIds.has(askDone.id));
    c.ok("someone spoke after the work ended: stays for a few days", openIds.has(lateDone.id) && !archivedIds.has(lateDone.id));
    c.ok("active work: in the list", openIds.has(live.id) && !archivedIds.has(live.id));
    c.ok("archived threads never count as unread", chat.archived.every((r) => !r.unread) && chat.counts.unread === chat.open.filter((r) => r.unread).length);
    c.ok("the team channel is never archived: it keeps its own row", !archivedIds.has("team") && chat.channel.lastMsg !== null);

    await pause();
    await signIn(kim);
    const back = await postProjectMessage(done.id, null, "Client asked for the raw files, sending today.");
    const kyleMe2 = await as(kyle);
    const chat2 = await loadTeamChat({ scope: { kind: "office" }, viewer: kyleMe2, view: "all", user: kyleMe2 });
    c.ok("a new message brings it back (unread for Kyle)", back.ok && chat2.open.some((r) => r.id === done.id && r.unread) && !chat2.archived.some((r) => r.id === done.id));
    const backMsg = await prisma.projectMessage.findFirstOrThrow({ where: { projectId: done.id }, orderBy: { createdAt: "desc" } });
    await markProjectMessagesRead(done.id, backMsg.id);
    const chat3 = await loadTeamChat({ scope: { kind: "office" }, viewer: kyleMe2, view: "all", user: kyleMe2 });
    c.ok("read, it stays in the list for a few days", chat3.open.some((r) => r.id === done.id));
    const ended = (await finishedWork([done.id])).get(done.id);
    c.ok("and folds again once the grace runs out", threadIsArchived({ finished: ended, last: { createdAt: backMsg.createdAt, body: backMsg.body }, unread: false, now: new Date(backMsg.createdAt.getTime() + ARCHIVE_RECENT_POST_MS + 60_000) }));
    await prisma.project.update({ where: { id: cancelled.id }, data: { status: "REVISION" } });
    const chat4 = await loadTeamChat({ scope: { kind: "office" }, viewer: kyleMe2, view: "all", user: kyleMe2 });
    c.ok("work that becomes active again brings it back", chat4.open.some((r) => r.id === cancelled.id) && !chat4.archived.some((r) => r.id === cancelled.id));
    const kimMe2 = await as(kim);
    const kimCenter = await loadTeamChat({ scope: { kind: "editor", editorKey: "kim" }, viewer: kimMe2, view: "all", user: kimMe2 });
    c.ok("the editors' center archives by the same rule (Kim's own read state)", kimCenter.archived.every((r) => !r.unread) && !kimCenter.archived.some((r) => r.id === live.id));

    const T = new Date("2026-10-28T15:00:00Z");
    const END = { endedAt: new Date("2026-10-20T15:00:00Z") };
    c.ok("rule, unit: finished + read + statement = archived; no messages = archived",
      threadIsArchived({ finished: END, last: { createdAt: new Date("2026-10-19T15:00:00Z"), body: "Done." }, unread: false, now: T }) &&
      threadIsArchived({ finished: END, last: null, unread: false, now: T }));
    c.ok("rule, unit: unread, unfinished, a question, or a post 1 day after the end each keep it",
      !threadIsArchived({ finished: END, last: { createdAt: new Date("2026-10-19T15:00:00Z"), body: "Done." }, unread: true, now: T }) &&
      !threadIsArchived({ finished: undefined, last: { createdAt: new Date("2026-10-19T15:00:00Z"), body: "Done." }, unread: false, now: T }) &&
      !threadIsArchived({ finished: END, last: { createdAt: new Date("2026-10-19T15:00:00Z"), body: "Is the horizontal one coming? " }, unread: false, now: T }) &&
      !threadIsArchived({ finished: END, last: { createdAt: new Date("2026-10-27T15:00:00Z"), body: "Thanks!" }, unread: false, now: T }));

    c.head("7 · job pages fold messages older than ten days");
    const NOW = new Date("2026-10-28T16:00:00Z");
    c.ok("the line is Eastern midnight ten days back (Oct 18, 00:00 EDT)", messageFoldCutoff(NOW).toISOString() === "2026-10-18T04:00:00.000Z", messageFoldCutoff(NOW).toISOString());
    const extra = await messageExtras([
      { id: "a", createdAt: new Date("2026-10-17T23:30:00Z") }, // Oct 17, 7:30 PM ET
      { id: "b", createdAt: new Date("2026-10-18T04:30:00Z") }, // Oct 18, 12:30 AM ET
    ], null, { now: NOW });
    c.ok("Oct 17 evening (ET) folds; just after midnight Oct 18 stays open", extra("a").old && !extra("b").old);
    const foldJob = await job("9 Long Thread Rd", "EDITING", null);
    const oldMsgs = [];
    for (let i = 0; i < 3; i++) oldMsgs.push(await say(foldJob.id, `Old note ${i + 1}`, 30 - i));
    const recentReply = await prisma.projectMessage.create({ data: { projectId: foldJob.id, body: "Following up on this one", authorName: "Kyle Smith", authorId: kyleTm.id, replyToId: oldMsgs[0].id, createdAt: at(1) } });
    const thread = await loadThread(foldJob.id, kyleMe2);
    c.ok("the loader flags the three old ones; the recent reply is not old", thread.filter((m) => m.old).length === 3 && thread.find((m) => m.id === recentReply.id)?.old === false && thread.find((m) => m.id === recentReply.id)?.replyTo?.body === "Old note 1");
    const html = renderToStaticMarkup(createElement(ProjectMessages, { projectId: foldJob.id, messages: thread, team: [] }));
    c.ok("one closed line: Earlier messages (3), more than 10 days old", /<details[^>]*data-message-fold="3"/.test(html) && !/<details[^>]*\sopen/.test(html) && html.includes("Earlier messages (3), more than 10 days old"));
    const afterFold = html.slice(html.indexOf("</details>"));
    c.ok("the recent reply stays open below the fold, with its quote", afterFold.includes("Following up on this one") && afterFold.includes("Old note 1"));
    const allOld = thread.filter((m) => m.old);
    const htmlAllOld = renderToStaticMarkup(createElement(ProjectMessages, { projectId: foldJob.id, messages: allOld, team: [] }));
    c.ok("when every message is old, the newest still shows open", htmlAllOld.includes('data-message-fold="2"') && htmlAllOld.slice(htmlAllOld.indexOf("</details>")).includes("Old note 3"));
    const htmlNew = renderToStaticMarkup(createElement(ProjectMessages, { projectId: foldJob.id, messages: thread.filter((m) => !m.old), team: [] }));
    c.ok("nothing old, no fold line", !htmlNew.includes("data-message-fold") && !htmlNew.includes("Earlier messages"));
    const channelHtml = renderToStaticMarkup(createElement(TeamChannelMessages, { messages: await loadTeamChannel(kyleMe2), team: [] }));
    c.ok("the channel board: its own heading, says only tagged people are notified", channelHtml.includes("Team channel") && channelHtml.includes("only the people you tag are notified"));

    const REPO = path.resolve(__dirname, "..", "..");
    const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    c.ok("the job page, the editor brief and the shoot screen all carry the fold flag", ["src/app/projects/[id]/page.tsx", "src/app/edit/[id]/page.tsx", "src/app/shoot/[id]/page.tsx"].every((f) => src(f).includes("...msgExtra(m.id)")));
    c.ok("the board never reads the clock to fold (server decides)", !/new Date\(\)|Date\.now\(\)/.test(src("src/components/project/ProjectMessages.tsx")));

    c.ok("nothing left the drill: no text, email or Slack", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

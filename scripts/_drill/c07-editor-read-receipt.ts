// C07: signed editor read receipts, bounded to loaded messages, with failed
// create/update and retry against an isolated DB. Actual server actions and
// shared conversation readers run; no browser IntersectionObserver is tested.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5797), env: { AUTH_ENFORCE: "true", APP_SECRET: "c07-isolated-session-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { markProjectMessagesRead } = await import("@/app/projects/messageActions");
    const { loadTeamChat } = await import("@/components/comms/TeamMessagesPanel");
    const { unreadThreadCount } = await import("@/lib/editorQueue");
    const client = await prisma.client.create({ data: { name: "C07 reader TEST" } });
    const roster = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-roster-c07@example.test", role: "EDITOR" } });
    const kim = await prisma.appUser.create({ data: { email: "kim-c07@example.test", name: "Kim", role: "EDITOR", editorKey: "kim", teamMemberId: roster.id, status: "ACTIVE" } });
    const john = await prisma.appUser.create({ data: { email: "john-c07@example.test", name: "John", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-c07@example.test", name: "Owner", role: "OWNER", status: "ACTIVE" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "C07 assigned edit TEST", status: "SHOT", editorId: roster.id } });
    await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", quantity: 1 } });
    const task = await prisma.smartTask.create({ data: { clientId: client.id, projectId: project.id, taskType: "edit_video", title: "C07 edit assignment", assignedKey: "kim", status: "OPEN" } });
    const at = Date.now() - 15 * 60_000;
    const add = (projectId: string, text: string, offset: number) => prisma.projectMessage.create({ data: { projectId, body: text, authorName: "Kyle", createdAt: new Date(at + offset * 60_000) } });
    const first = await add(project.id, "First loaded message", 1);
    const lastLoaded = await add(project.id, "Last message loaded on open", 2);
    const signIn = (user: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: user.id, email: user.email, role: user.role, actingAs });
    const seen = (projectId = project.id, userKey = kim.id) => prisma.threadRead.findUnique({ where: { userKey_projectId: { userKey, projectId } } });
    const rejects = async (action: () => Promise<unknown>, expected: RegExp) => {
      try { await action(); return false; } catch (e) { return e instanceof Error && expected.test(e.message); }
    };

    await signIn(kim);
    const me = await getCurrentUser();
    const chat = await loadTeamChat({ scope: { kind: "editor", editorKey: me!.editorKey! }, viewer: me, selectedId: project.id });
    c.ok("signed editor's shared conversation read loads exact messages without a receipt", me?.id === kim.id && chat.selected?.id === project.id && chat.thread?.messages.at(-1)?.id === lastLoaded.id && await seen() === null && await unreadThreadCount(kim.id, [project.id]) === 1);
    const newer = await add(project.id, "Arrived after the conversation loaded", 3);
    const opened = await markProjectMessagesRead(project.id, lastLoaded.id);
    c.ok("actual action records only the signed editor and last loaded message", opened.ok && (await seen())?.seenAt.getTime() === lastLoaded.createdAt.getTime() && await prisma.threadRead.count() === 1);
    c.ok("message arriving after load remains unread", await unreadThreadCount(kim.id, [project.id]) === 1);
    await markProjectMessagesRead(project.id, first.id);
    c.ok("an older tab cannot rewind the editor's receipt", (await seen())?.seenAt.getTime() === lastLoaded.createdAt.getTime());

    const realUpdate = prisma.threadRead.updateMany;
    (prisma.threadRead as unknown as { updateMany: unknown }).updateMany = async () => { throw new Error("c07 injected receipt update failure"); };
    let updateFailed = false;
    try { updateFailed = await rejects(() => markProjectMessagesRead(project.id, newer.id), /c07 injected receipt update failure/); }
    finally { (prisma.threadRead as unknown as { updateMany: unknown }).updateMany = realUpdate; }
    c.ok("failed receipt save rejects without clearing unread or advancing the watermark", updateFailed && (await seen())?.seenAt.getTime() === lastLoaded.createdAt.getTime() && await unreadThreadCount(kim.id, [project.id]) === 1);
    const retried = await markProjectMessagesRead(project.id, newer.id);
    c.ok("retry saves the displayed target and clears only this read conversation", retried.ok && (await seen())?.seenAt.getTime() === newer.createdAt.getTime() && await unreadThreadCount(kim.id, [project.id]) === 0);

    const fresh = await prisma.project.create({ data: { clientId: client.id, title: "C07 first receipt TEST", status: "SHOT", editorId: roster.id } });
    const freshMessage = await add(fresh.id, "First receipt has never been saved", 4);
    const realCreate = prisma.threadRead.create;
    (prisma.threadRead as unknown as { create: unknown }).create = async () => { throw new Error("c07 injected receipt create failure"); };
    let createFailed = false;
    try { createFailed = await rejects(() => markProjectMessagesRead(fresh.id, freshMessage.id), /c07 injected receipt create failure/); }
    finally { (prisma.threadRead as unknown as { create: unknown }).create = realCreate; }
    c.ok("failed first receipt save leaves no row and conversation unread", createFailed && await seen(fresh.id) === null && await unreadThreadCount(kim.id, [fresh.id]) === 1);
    const freshRetry = await markProjectMessagesRead(fresh.id, freshMessage.id);
    await markProjectMessagesRead(fresh.id, freshMessage.id);
    c.ok("first-save retry records exactly one receipt", freshRetry.ok && await prisma.threadRead.count({ where: { projectId: fresh.id, userKey: kim.id } }) === 1 && (await seen(fresh.id))?.seenAt.getTime() === freshMessage.createdAt.getTime());
    c.ok("foreign message id cannot advance this conversation", !(await markProjectMessagesRead(project.id, freshMessage.id)).ok && (await seen())?.seenAt.getTime() === newer.createdAt.getTime());

    const unseen = await add(project.id, "Preview must leave this message unread", 5);
    await signIn(owner, kim.id);
    c.ok("owner preview cannot create an editor read receipt through the actual action", await rejects(() => markProjectMessagesRead(project.id, unseen.id), /previewing another user/) && (await seen())?.seenAt.getTime() === newer.createdAt.getTime() && await seen(project.id, owner.id) === null);
    await signIn(john);
    c.ok("unassigned editor cannot mark the thread read", await rejects(() => markProjectMessagesRead(project.id, unseen.id), /jobs assigned to you/) && await seen(project.id, john.id) === null);
    c.ok("refusals leave the unseen message unread and do not accept/finish editing work", await unreadThreadCount(kim.id, [project.id]) === 1 && (await prisma.smartTask.findUnique({ where: { id: task.id } }))?.status === "OPEN" && await prisma.editorWorkItem.count() === 0 && await prisma.editorBriefReceipt.count() === 0);
    c.ok("no provider request left the isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

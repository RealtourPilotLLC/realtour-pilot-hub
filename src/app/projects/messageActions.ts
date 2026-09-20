"use server";

import { requireRole } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type MsgResult = { ok: boolean; message: string };

// Editors post in the team thread from the editor queue, so allow all staff
// roles. Photographers too since Sep 16 (Kyle call) — on THEIR OWN shoots
// only: a tag used to send them to /shoot/<id>, which had no thread to read,
// let alone answer. requireRole is the role gate; the ownership check below
// is the same one /shoot/<id> and requireShootAccess make (fail closed).
const requireStaff = () => requireRole(["OWNER", "ADMIN", "EDITOR"]);

async function requireThreadAccess(projectId: string): Promise<void> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  const { authEnforced, canViewProject } = await import("@/lib/auth/guards");
  if (!authEnforced()) return;
  const { getCurrentUser } = await import("@/lib/auth/user");
  const u = await getCurrentUser();
  // Owner/admin anywhere; the photographer on their own shoot (Sep 16, Kyle
  // call); and — new with RTP-02, Sep 16 — the EDITOR on a job they hold.
  // The editor half had no assignment check at all, so any editor login could
  // post on any of 1,575 jobs, on threads whose contents they never see.
  // canViewProject is deliberately generous about "hold": the project's
  // pinned editor, a task delegated to them, or a cut they sent to review —
  // so an editor covering a job keeps the thread the moment work lands on
  // them, and a reassignment doesn't silence the person who did the edit.
  if (await canViewProject(projectId)) return;
  // …and once they have spoken on a job they keep the conversation, whatever
  // happened to the assignment afterwards (Jordan's call on scoping editors:
  // narrowing must not cut somebody out of a thread mid-exchange).
  if (u?.realRole === "EDITOR" && u.teamMemberId) {
    const prior = await prisma.projectMessage.findFirst({
      where: { projectId, authorId: u.teamMemberId },
      select: { id: true },
    });
    if (prior) return;
  }
  throw new Error(
    u?.realRole === "PHOTOGRAPHER"
      ? "You can only message on your own shoots."
      : "You can only message on jobs assigned to you.",
  );
}

// A reply has to answer a message ON THIS JOB (RTP-02, Sep 16).
// ProjectMessage.replyToId is a bare self-relation with no project constraint,
// and every surface that renders a thread includes the parent unconditionally
// — so a reply pointed at another job's message would quote that job's words
// into this one, on six screens, and notifyMessageReply would ring its author
// about a conversation they are not in. Returns the id to store: null drops a
// foreign or missing parent and keeps the message, which is the kind thing to
// do to a stale tab.
async function safeReplyTo(projectId: string, replyToId: string | null | undefined): Promise<string | null> {
  if (!replyToId) return null;
  const parent = await prisma.projectMessage
    .findUnique({ where: { id: replyToId }, select: { projectId: true } })
    .catch(() => null);
  return parent && parent.projectId === projectId ? replyToId : null;
}

// Any new message REOPENS the conversation for everyone (Sep 16): "Close
// conversation" is a per-viewer fold (ThreadRead.closedAt), and a thread
// someone writes into is, by definition, open again.
async function reopenThread(projectId: string): Promise<void> {
  await prisma.threadRead.updateMany({ where: { projectId, closedAt: { not: null } }, data: { closedAt: null } }).catch(() => {});
}

// Post a message to a project's team thread. The author is WHOEVER IS LOGGED
// IN — Jordan: "the project chat should not have the name selector and just be
// the name of the person who is logged in." The session name resolves to a
// TeamMember for the avatar/mention machinery; a session with no Team row
// still posts under their own name. The client-passed authorId only matters
// in sessionless local dev (auth off), where there's no identity to derive.
export async function postProjectMessage(
  projectId: string,
  clientAuthorId: string | null,
  body: string,
  mentionIds: string[] = [],
  replyToId?: string | null,
): Promise<MsgResult> {
  await requireThreadAccess(projectId);
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };
  const parentId = await safeReplyTo(projectId, replyToId);

  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  let authorId: string | null = null;
  let authorName: string | null = null;
  const myName = me?.name?.trim();
  if (me) {
    // The login's LINKED Team row first (reviewer, Sep 15: the self-tag and
    // self-reply rules below compare this id exactly, so it has to be the
    // writer's own row, not a name lookalike), then the exact display name,
    // then the roster email. A logged-in user with no row still posts as
    // THEMSELVES (name or email), never as a client-chosen TeamMember — the
    // passed authorId is a spoof vector once a session exists (adversarial
    // review).
    //
    // THREE RUNGS, NOT FOUR (review, Sep 16). There used to be a fourth:
    // `name: { contains: <first name> }`, which matched a substring anywhere
    // in anyone's roster name — so a login called "Kim" could be attributed to
    // "Kimberly Vance", and "Mark" to "John Mark". That id is not cosmetic: it
    // decides whose "you were tagged" task auto-closes, who counts as tagging
    // themselves, who a reply rings, and (since RTP-02) which editor keeps a
    // thread they have already spoken on. A GUESS must not open any of those.
    // When nothing matches exactly we now leave authorId null and post under
    // the person's own name — which is what every unmatched login already did.
    const select = { id: true, name: true };
    const tm =
      (me.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null) ??
      (myName ? await prisma.teamMember.findFirst({ where: { name: { equals: myName, mode: "insensitive" } }, select }) : null) ??
      (me.email
        ? await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" }, active: true }, select })
        : null);
    authorId = tm?.id ?? null;
    authorName = tm?.name ?? myName ?? me.email ?? "Team";
  } else if (!authEnforced() && clientAuthorId) {
    // Sessionless local dev only — no identity exists to derive.
    const m = await prisma.teamMember.findUnique({ where: { id: clientAuthorId }, select: { name: true } });
    authorId = m ? clientAuthorId : null;
    authorName = m?.name ?? null;
  }

  // The composer resolves only the full names it inserted itself ("@John
  // Mark"); a hand-typed "@John" posted without picking rang nobody. Jordan,
  // Sep 15: "if I type at John or at Kyle, a notification is sent to them" —
  // so the roster-aware matcher the note surfaces use runs here too (an
  // ambiguous first name still needs the full name; "info@kim…" is not Kim).
  const { matchMentions } = await import("@/lib/mentions");
  const roster = text.includes("@")
    ? await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const mentions = Array.from(new Set([...mentionIds.filter(Boolean), ...matchMentions(text, roster).map((p) => p.id)]));
  // The names the @tags have to be stripped by before this text is read for
  // what it ASKS or ANSWERS (mentions.ts withoutTags). Guessing the surname
  // off a capital letter ate the next real word of the sentence, which turned
  // "@Kyle What time do you need it" into an answer and closed the row — the
  // 358 N Church St shape again. Filled in from the tagged rows below too, in
  // case the roster read failed and the composer supplied the ids.
  const tagNames: string[] = roster.map((p) => p.name);
  const msg = await prisma.projectMessage.create({
    data: {
      projectId,
      authorId: authorId || null,
      authorName,
      body: text.slice(0, 2000),
      mentions: mentions.length ? JSON.stringify(mentions) : null,
      replyToId: parentId,
    },
  });
  await reopenThread(projectId);

  // Every link below lands ON the message (Sep 16): the board gives each
  // message id="msg-<id>", so a Slack DM, a text or a bell row opens the
  // page scrolled to the words that rang, not the top of the job file.
  const anchor = `#msg-${msg.id}`;

  // Notify each tagged teammate with a to-do so the mention isn't missed. One open
  // "you were tagged on this job" task per (project, member) — a later tag
  // refreshes it (and reopens if they'd closed it) instead of piling up dupes.
  if (mentions.length) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
    const tagged = await prisma.teamMember.findMany({ where: { id: { in: mentions } }, select: { id: true, name: true, role: true } });
    for (const t of tagged) if (!tagNames.includes(t.name)) tagNames.push(t.name);
    const street = project?.title?.split(",")[0] ?? "a project";
    // Editor resolution + role-aware routing — the SAME shape as the note-comment
    // mentions (src/lib/mentions.ts): an editor gets their tm: row plus the
    // editor:<key> row their login sees, with an href their role can actually
    // open. Roles are visibility only (Sep 15) — which channels a row goes out
    // on is the person's row on /settings → Team notifications (notify.ts).
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const { slugForName } = await import("@/lib/assignees");
    const editorTmIds = new Map<string, string>();
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }
    // The owner's roster row(s): a DM TO the owner keeps money in its quote
    // (Sep 15), so the loop needs to know who he is whoever is writing (read
    // every time, cached ten minutes). They also stand in for the writer on
    // a SESSIONLESS request (dev) that named nobody.
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    // A tag of himself in his own message rings the bell and nothing more
    // (reviewer, Sep 11) — decided by the writer's OWN row, exactly, now that
    // authorId comes off the login's linked row (reviewer, Sep 15: a second
    // owner login with no Team row tagging "@Jordan" is not Jordan tagging
    // himself, and must reach him). The owners inference only when nothing
    // identified the writer at all.
    const inferOwner = !me && !authorId;
    // What this tag is ASKING, and when it is owed (Sep 20). Until then every
    // tag was HIGH with a raw four-hour wall clock, so "here's the revised
    // version" paged two people as urgently as a client's revision request,
    // and a 5pm Friday tag was overdue before dinner. Both rules live in
    // mentions.ts so the five note surfaces get the identical treatment.
    const { mentionPriority, mentionDueAt, formatMentionAsks, appendMentionAsk, mergeMentionDetail, earlierDue } =
      await import("@/lib/mentions");
    const priority = mentionPriority(text, tagNames);
    const summary = `${authorName ?? "A teammate"} tagged you in the ${street} team thread: “${text.slice(0, 200)}”. Take any needed action and reply in the thread.`;
    // THIS message is the ask — one ask, however many people it tags. The row
    // remembers it by id so the reply that answers it can be recognised, and
    // so a reply here can never tick off an ask that a cut note raised on
    // another surface (632 Greenridge Rd).
    const ask = { kind: "msg" as const, id: msg.id, asker: authorId };
    for (const t of tagged) {
      const editorKey = editorTmIds.get(t.id) ?? null;
      const selfTag = t.id === authorId || (inferOwner && owners.includes(t.id));
      // A tagged photographer who doesn't own this shoot gets bounced off
      // /shoot/<id> to the bare list — send them to the list directly (their
      // tag task carries the context); the owning shooter still deep-links
      // to the thread on their shoot screen (Sep 16: it has one now).
      let photogHref = `/shoot/${projectId}${anchor}`;
      if (t.role === "PHOTOGRAPHER") {
        try {
          const { photographerOwnsShoot } = await import("@/lib/shoot");
          if (!(await photographerOwnsShoot(projectId, t.id))) photogHref = "/shoot";
        } catch { /* keep the deep link on lookup hiccups */ }
      }
      const href =
        t.role === "PHOTOGRAPHER" ? photogHref : editorKey ? `/edit/${projectId}${anchor}` : `/projects/${projectId}${anchor}`;
      const data = {
        taskType: "internal_instruction",
        title: `${authorName ?? "Team"} tagged you — ${street}`.slice(0, 120),
        summary: summary.slice(0, 500),
        description: text.slice(0, 400),
        reasonCreated: "You were tagged in a team message",
        source: "team",
        priority,
        dueAt: mentionDueAt(new Date(), priority),
        sourceDetail: formatMentionAsks([ask]),
        projectId,
        clientId: project?.clientId ?? null,
        ownerId: t.id,
        // On the tagged person's OWN board (editor boards filter by editor key;
        // everyone else by name slug) — ownerId alone is write-only and shows
        // on no surface (audit: invisible @mention tasks).
        assignedKey: editorKey ?? slugForName(t.name),
        dedupeKey: `mention-${projectId}-${t.id}`,
      };
      const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: data.dedupeKey } });
      if (existing) {
        const reopening = existing.status === "COMPLETED" || existing.status === "CANCELLED";
        await prisma.smartTask
          .update({
            where: { id: existing.id },
            data: {
              ...data,
              // A second tag ADDS an ask; it does not replace the first one.
              // The old `{ ...data }` spread overwrote summary, description and
              // dueAt, and that is how Kyle's "any concerns for the video?"
              // vanished off his board on Sep 14.
              //
              // The TITLE is the one field that still moves with the newest
              // tag, on purpose. Freezing it looked tidier and quietly broke a
              // bell: mentionDone.ts pulls the tagger's name out of this string
              // (`title.split(" tagged you")[0]`) to decide whose bell a
              // hand-tick rings, so a frozen headline rings the FIRST tagger
              // for ever and the second one is never told their tag was
              // handled. The earlier ask is kept where it belongs — the
              // summary, the description and the ask ledger.
              summary: reopening ? data.summary : mergeMentionDetail(existing.summary, summary, 500),
              description: reopening ? data.description : mergeMentionDetail(existing.description, text, 400),
              priority: !reopening && existing.priority === "HIGH" ? "HIGH" : priority,
              dueAt: reopening ? data.dueAt : earlierDue(existing.dueAt, data.dueAt),
              sourceDetail: appendMentionAsk(existing.sourceDetail, ask, { reopening }),
              status: "OPEN",
              completedAt: null,
            },
          })
          .catch(() => {});
      } else await prisma.smartTask.create({ data }).catch(() => {});
      // Bell mirror: the tagged person (whatever their role), keyed per message
      // so every new tag rings even when the task above just refreshed. The
      // money clamp strips the body for creative roles automatically.
      try {
        const { notifyInApp } = await import("@/lib/notify");
        const { slackMentionDm } = await import("@/lib/mentions");
        // The sentence (Jordan, Sep 15: "if I type at John or at Kyle, a
        // notification is sent to them directly in Slack with a link to the
        // message and a summary"): who, where, the first ~240 characters, and
        // the same link the bell row carries — the Slack DM, and the text in
        // plain-text form (James and Harrison's default; the owner's Sep 11
        // text rides it too). Off on a self-tag = bell only.
        const slackDm = selfTag
          ? null
          : slackMentionDm({
              author: authorName ?? "A teammate",
              street,
              context: "the job's team chat",
              text,
              href,
              ownerRecipient: owners.includes(t.id),
            });
        const targets: import("@/lib/notify").NotifyTarget[] = [
          {
            roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
            userKey: `tm:${t.id}`,
            href,
            ...(slackDm ? { slackDm } : {}),
          },
        ];
        // The row the EDITOR login sees carries the same sentence — notify.ts
        // delivers ONCE per person, whichever of the two rows is new first.
        if (editorKey) targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${projectId}${anchor}`, ...(slackDm ? { slackDm } : {}) });
        await notifyInApp({
          kind: "mention",
          title: `${authorName ?? "Team"} mentioned you — ${street}`,
          body: text.slice(0, 140),
          href,
          targets,
          dedupeKey: `mention-${msg.id}-${t.id}`,
        });
      } catch { /* bell is best-effort */ }
    }
  }

  // A reply answers a PERSON — reach them (Jordan, Sep 15). Until now the
  // reply arrow only quoted the parent; the author heard nothing unless the
  // reply also @-tagged them. The tagged people above already got their ping
  // (and DM), so they are excluded here. Best-effort: the message is saved.
  const reached = new Set(mentions);
  if (parentId) {
    try {
      const { notifyMessageReply } = await import("@/lib/mentions");
      for (const id of await notifyMessageReply({
        projectId,
        messageId: msg.id,
        replyToId: parentId,
        replierTmId: authorId,
        inferOwnerReplier: !me && !authorId,
        replierName: authorName,
        text,
        excludeTmIds: mentions,
      })) reached.add(id);
    } catch { /* the reply ping is best-effort */ }
  }

  // …and the job's EDITOR hears every message on their job (Jordan, Sep 15:
  // "a message was sent on their project"), once — unless they wrote it or
  // were already reached above. Their row on /settings decides the channel.
  try {
    const { notifyProjectMessage } = await import("@/lib/mentions");
    await notifyProjectMessage({
      projectId,
      messageId: msg.id,
      authorTmId: authorId,
      authorKey: me?.editorKey ? `editor:${me.editorKey}` : null,
      authorName,
      text,
      context: "the job's team chat",
      excludeTmIds: [...reached],
    });
  } catch { /* the job-message ping is best-effort */ }

  // Answering in the thread closes YOUR OWN "tagged you" task (Kyle call, Sep
  // 16): 6 of 6 mention-* tasks were sitting OPEN on the Tasks page with the
  // reply already posted, because only a hand-tick ever closed one. Narrow on
  // purpose — the poster's own companion key on this job, nobody else's — and
  // narrower still since Sep 20: it now has to be an ANSWER to an ask this
  // thread actually raised (see below).
  await completeOwnMentionTask(projectId, authorId, {
    messageId: msg.id,
    parentId,
    text,
    taggedTmIds: mentions,
    rosterNames: tagNames,
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/editing");
  revalidatePath("/editing/messages"); // the message center renders these threads too
  revalidatePath("/communications"); // …and Communications → Team (Sep 16)
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/shoot/${projectId}`); // the photographer's board (Sep 16)
  return { ok: true, message: mentions.length ? "Posted & tagged." : "Posted." };
}

/**
 * A post in the team chat ticks off the asks it ANSWERS on the poster's own
 * tag row, and closes the row when nothing is left on it.
 *
 * Sep 20, from 358 N Church St. This used to close the row on every successful
 * post, whatever the post said. Kyle asked John Mark for a cut with no
 * voiceover; John Mark replied "May I know where to upload the no V.O Version
 * I don't have a button for that in my Interface"; his task went COMPLETED 285
 * milliseconds later and Kyle's bell read "John finished your tag". Nothing had
 * been finished. Worse, because one row is shared by all six @mention
 * composers, a post here was also closing asks that a Review Room cut note had
 * raised — the surface where the answer actually had to go.
 *
 * So four gates, all of which have to pass:
 *   · the row carries an ask ledger (mentions.ts). No ledger = a row minted
 *     before today, or on a surface this thread cannot answer — a person ticks
 *     that one off by hand, the way it always worked;
 *   · the ask is a TEAM-CHAT ask. A cut note is answered on the cut note;
 *   · the post is a real answer: a reply to the message that asked, or a post
 *     that tags the person who asked and hands the ball back (their own row
 *     opens in the same request, so the loop never dies with no owner);
 *   · and it is not a bare "on it" or a question back — the exact shape that
 *     bit John Mark. Reading that off the text means taking the @tags off
 *     first, which is why the roster's names are passed in: guessing a surname
 *     off a capital letter ate "What" out of "@Kyle What time do you need it"
 *     and handed the question back as an answer.
 * Anything else leaves the row exactly as it is. A manually assigned row is
 * left alone outright: a human put that on someone's plate.
 *
 * The bell is deliberately gone from this path. "<name> finished your tag" is
 * a claim, and it is not this code's to make — the tagger already hears the
 * true sentence from notifyMessageReply ("↩︎ John replied to you on …") or
 * from their own mention ping. A hand-tick still rings it (actions.ts), which
 * is where a person really is saying the loop is done.
 */
async function completeOwnMentionTask(
  projectId: string,
  authorTmId: string | null,
  post: { messageId: string; parentId: string | null; text: string; taggedTmIds: string[]; rosterNames: string[] },
): Promise<void> {
  if (!authorTmId) return;
  try {
    const task = await prisma.smartTask.findUnique({
      where: { dedupeKey: `mention-${projectId}-${authorTmId}` },
      select: { id: true, status: true, sourceDetail: true, assignedManually: true },
    });
    if (!task || task.status === "COMPLETED" || task.status === "CANCELLED") return;
    if (task.assignedManually) return; // the invariant every engine here respects
    const { parseMentionAsks, formatMentionAsks, mentionAsksAnsweredBy } = await import("@/lib/mentions");
    const asks = parseMentionAsks(task.sourceDetail);
    if (asks.length === 0) return;
    const answered = mentionAsksAnsweredBy(asks, { ...post, posterTmId: authorTmId });
    if (answered.length === 0) return;
    const remaining = asks.filter((a) => !answered.some((x) => x.kind === a.kind && x.id === a.id));
    if (remaining.length > 0) {
      // Half answered is not answered. The row stays open carrying what is
      // left — the Greenridge shape, where two different asks lived on one row.
      //
      // Same compare-and-swap as the close below, and for the same reason: the
      // status was read several awaits ago, and a hand-tick or the 7-day
      // janitor (tasks.ts) can have closed the row since. Trimming the ledger
      // of a row somebody just finished would leave a settled task carrying a
      // half-list nothing will ever read.
      const trimmed = await prisma.smartTask
        .updateMany({
          where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: { sourceDetail: formatMentionAsks(remaining) },
        })
        .catch(() => ({ count: 0 }));
      if (trimmed.count === 0) return;
      revalidatePath("/tasks");
      revalidatePath("/queue");
      return;
    }
    const done = await prisma.smartTask.updateMany({
      where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (done.count === 0) return;
    revalidatePath("/tasks");
    revalidatePath("/queue");
  } catch { /* closing the tag is a courtesy — the reply is already posted */ }
}

// "Close conversation" (Kyle call, Sep 16): folds a job's thread under Closed
// on the message center and Communications → Team for THIS viewer — a
// finished conversation shouldn't sit in the active list forever. It is a
// read watermark with a lid, not a lock: any new message on the job clears
// closedAt for everyone (reopenThread above), and reading a closed thread
// leaves it closed. Never from a "view as" preview (requireRole blocks it).
export async function closeConversation(projectId: string): Promise<MsgResult> {
  await requireStaff();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { ok: false, message: "Sign in to close a conversation." };
  const now = new Date();
  await prisma.threadRead.upsert({
    where: { userKey_projectId: { userKey: me.id, projectId } },
    update: { seenAt: now, closedAt: now },
    create: { userKey: me.id, projectId, seenAt: now, closedAt: now },
  });
  revalidatePath("/editing/messages");
  revalidatePath("/communications");
  revalidatePath("/editing");
  return { ok: true, message: "Conversation closed — a new message reopens it." };
}

export async function reopenConversation(projectId: string): Promise<MsgResult> {
  await requireStaff();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { ok: false, message: "Sign in to reopen a conversation." };
  await prisma.threadRead.updateMany({ where: { userKey: me.id, projectId }, data: { closedAt: null } });
  revalidatePath("/editing/messages");
  revalidatePath("/communications");
  revalidatePath("/editing");
  return { ok: true, message: "Conversation reopened." };
}

// Leave a note from a task — it posts into that task's project team-message
// thread (so notes live with the job, visible to the crew).
export async function addTaskNote(taskId: string, note: string): Promise<MsgResult> {
  // The staff role AND the task's own guard (RTP-02, Sep 16): this writes into
  // a project thread chosen by the task id the caller sends, so "is this
  // person staff" was only half the question — an editor could name any task
  // and post on its job. requireTaskAccess adds "…and is it yours" (owner/admin,
  // or the person it is assigned to); requireStaff keeps photographers on their
  // own /shoot flow as before. The board only ever renders this button on rows
  // the viewer already holds, so nothing legitimate changes.
  await requireStaff();
  const { requireTaskAccess } = await import("@/lib/auth/guards");
  await requireTaskAccess(taskId);
  const text = note.trim();
  if (!text) return { ok: false, message: "Write a note first." };
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { projectId: true, title: true },
  });
  if (!task?.projectId) return { ok: false, message: "This task isn't tied to a project." };
  await prisma.projectMessage.create({
    data: {
      projectId: task.projectId,
      authorName: "Note",
      body: `📝 ${task.title}\n${text}`.slice(0, 2000),
    },
  });
  await reopenThread(task.projectId); // a note is a message: the thread is open again (Sep 16)
  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/queue");
  return { ok: true, message: "Note added to project messages." };
}

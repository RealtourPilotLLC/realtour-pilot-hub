import "server-only";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { clip, stripInvisible, scrubMoney, escapeSlack } from "@/lib/text";

// ---------------------------------------------------------------------------
// @mentions in note comments. The note/reply actions call notifyMentions with
// the saved text; anyone tagged gets the SAME treatment a team-message tag
// already gives (src/app/projects/messageActions.ts): one open "you were
// tagged on this job" task per (project, person) that refreshes on re-tags,
// plus a bell per comment. The bell's link lands on the surface that person
// can actually open (photographer → their shoot page, editor → their brief,
// everyone else → the project page), and editors ALSO get their channel row
// (editor:<key> → Slack DM/SMS via the notify bridge, "mention" is in both
// SMS_KINDS and EDITOR_CHANNEL_KINDS). Since Sep 15 every person-addressed
// row also carries the Slack DM sentence (slackDm, built by slackMentionDm
// below) — Jordan: "if I type at John or at Kyle, a notification is sent to
// them directly in Slack with a link to the message and a summary". Best-
// effort by contract — a mention hiccup must never fail the comment that
// carried it.
// ---------------------------------------------------------------------------

// Match "@Full Name" (as the composer inserts) plus hand-typed "@FirstName"
// when that first name is unambiguous on the roster. Exported so surfaces that
// gate on "was this person tagged?" (the note page guard) use EXACTLY the
// matching semantics that minted the ping.
export function matchMentions<T extends { id: string; name: string }>(text: string, people: T[]): T[] {
  const hit = new Set<string>();
  const out: T[] = [];
  // Longest names first so "@Kim Miguel" wins before a bare "@Kim" pass.
  const byLength = [...people].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    if (p.name && text.includes(`@${p.name}`) && !hit.has(p.id)) {
      hit.add(p.id);
      out.push(p);
    }
  }
  const firstCounts = new Map<string, number>();
  for (const p of people) {
    const first = p.name.split(/\s+/)[0]?.toLowerCase();
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  for (const p of people) {
    if (hit.has(p.id)) continue;
    const first = p.name.split(/\s+/)[0];
    if (!first || (firstCounts.get(first.toLowerCase()) ?? 0) !== 1) continue; // ambiguous first name → full name required
    // A REAL first-name tag stands alone: start-of-text/whitespace before the @,
    // and end/space/simple punctuation after. "@kim.creates" (an IG handle) and
    // "info@kim…" (an email) must NOT ring Kim — media notes contain both.
    const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)@${esc}(?=$|[\\s,!?;:])`, "im").test(text)) {
      hit.add(p.id);
      out.push(p);
    }
  }
  return out;
}

// Was this person @-tagged anywhere in these texts? Runs the same roster-aware
// matcher (ambiguous first names require the full name), so page guards agree
// with the pings. Best-effort false on any error.
export async function isMentionedIn(texts: string[], teamMemberId: string): Promise<boolean> {
  try {
    const joined = texts.filter(Boolean).join("\n");
    if (!joined.includes("@")) return false;
    const people = await prisma.teamMember.findMany({
      where: { active: true },
      select: { id: true, name: true },
    });
    return matchMentions(joined, people).some((p) => p.id === teamMemberId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Slack DM sentence (Jordan, Sep 15). One shape for every surface, so a
// DM reads the same whether the tag was on a review note, a cut note, or the
// Editing Room's job chat:
//   💬 Jordan Spackman mentioned you on 123 Main St — a cut note
//   > the message, first ~240 characters, one line
//   https://hub.realtourpilot.com/edit/<id>
// A reply opens "↩︎ <Author> replied to you on <street> — …" instead. The
// quote is scrubbed of money for anyone but the owner (creatives never see
// pricing, and a Slack DM is even leakier than the bell), invisible characters
// are stripped, and the cut lands on a word boundary. Slack markup is escaped
// so a client's "<3" or "photos & video" arrive as typed; the "> " prefix is
// Slack's own quote.
// ---------------------------------------------------------------------------
export function slackMentionDm(opts: {
  author: string;
  street: string;
  context: string;
  text: string;
  /** In-app href — the DM carries the absolute link (appBase()). */
  href: string;
  reply?: boolean;
  /** The recipient IS the owner → money stays in the quote. */
  ownerRecipient?: boolean;
}): string {
  const oneLine = stripInvisible(opts.text).replace(/\s+/g, " ").trim();
  const summary = clip(opts.ownerRecipient ? oneLine : scrubMoney(oneLine), 240);
  const head = opts.reply
    ? `↩︎ ${opts.author} replied to you on ${opts.street} — ${opts.context}`
    : `💬 ${opts.author} mentioned you on ${opts.street} — ${opts.context}`;
  return `${escapeSlack(head)}\n> ${escapeSlack(summary)}\n${appBase()}${opts.href}`;
}

// The writer's OWN roster row — what the self-tag rule compares against
// (reviewer, Sep 15). Until now the owner's session key was "owner" (not a
// tm:) so "did he tag himself?" was inferred from the owners list — which
// made a SECOND owner login with no Team row tagging "@Jordan" look like
// Jordan tagging himself: no text, and no Slack DM. So: the session's linked
// TeamMember; an editor login keyed only by editor key resolves through the
// roster; otherwise the active row carrying the login's email. null = a real
// login with no roster row at all, who therefore cannot tag THEMSELVES. A
// sessionless dev request passes nothing and the old inference stands.
export async function authorTeamMemberId(u: {
  teamMemberId: string | null;
  editorKey: string | null;
  email: string | null;
}): Promise<string | null> {
  try {
    if (u.teamMemberId) return u.teamMemberId;
    if (u.editorKey) {
      const { editorTeamMemberId } = await import("@/lib/editors");
      const id = await editorTeamMemberId(u.editorKey);
      if (id) return id;
    }
    if (u.email) {
      const row = await prisma.teamMember.findFirst({
        where: { email: { equals: u.email, mode: "insensitive" }, active: true },
        select: { id: true },
      });
      if (row) return row.id;
    }
  } catch { /* unknown → not a self-tag */ }
  return null;
}

// TeamMember id → editor key, for the in-house editors that have a roster row
// (kim/john/remar). Resolution is EXACT (editor key → its TeamMember id), never
// a name substring — a future "Kimberly" must not ring editor Kim's channel.
async function editorTmIdMap(): Promise<Map<string, string>> {
  const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
  const map = new Map<string, string>();
  for (const key of TEAM_MEMBER_EDITOR_KEYS) {
    const tmId = await editorTeamMemberId(key);
    if (tmId) map.set(tmId, key);
  }
  return map;
}

export async function notifyMentions(opts: {
  text: string;
  projectId: string;
  /** The writer's session key ("owner" | "tm:<id>" | "editor:<key>" | …) — a
   *  tag of THEMSELVES rings the bell and nothing more. */
  authorKey?: string | null;
  /** The writer's OWN roster row (authorTeamMemberId) — the self-tag rule
   *  compares ids exactly when this is given (null = a login with no row,
   *  who cannot self-tag). Leave it undefined only for a sessionless dev
   *  request, where the "owner" key still stands in for his row. */
  authorTmId?: string | null;
  authorName?: string | null;
  /** Short context for the ping, e.g. "a review note" | "a cut note". */
  context?: string;
  /** ROOT note id when the mention lives on a media-note thread — photographer
   *  pings then deep-link the note itself (readable even on a shoot they don't
   *  own) instead of a shoot page that bounces non-owners. */
  noteId?: string;
}): Promise<string[]> {
  try {
    if (!opts.text.includes("@")) return [];
    const people = await prisma.teamMember.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
    });
    const tagged = matchMentions(opts.text, people);
    if (tagged.length === 0) return [];

    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { title: true, clientId: true },
    });
    const street = project?.title?.split(",")[0]?.trim() || "a job";
    const author = opts.authorName ?? "A teammate";

    // kim/remar tags should reach Manila through the editor channel bridge.
    const { slugForName } = await import("@/lib/assignees");
    const editorTmIds = await editorTmIdMap(); // TeamMember id → editor key
    const editorKeyFor = (tmId: string): string | null => editorTmIds.get(tmId) ?? null;

    // The owner's roster row(s): a DM TO the owner keeps money in its quote
    // (Sep 15), so the list is read every time (cached ten minutes in
    // smsPrefs.ts). It also stands in for his identity on a SESSIONLESS
    // request (dev), where "@Jordan" under the "owner" key is a self-tag.
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);

    const { notifyInApp } = await import("@/lib/notify");
    for (const t of tagged) {
      const editorKey = editorKeyFor(t.id);
      // A self-tag rings the bell and nothing more — no text about what he
      // just wrote himself (reviewer, Sep 11), and no Slack DM (Sep 15).
      // Exact by roster id when the caller resolved the writer (reviewer,
      // Sep 15: a second owner login tagging "@Jordan" is NOT Jordan tagging
      // himself); the owners-list inference only when nothing identified them.
      const selfTag =
        t.id === opts.authorTmId ||
        opts.authorKey === `tm:${t.id}` ||
        (opts.authorTmId === undefined && opts.authorKey === "owner" && owners.includes(t.id));
      let href: string;
      if (t.role === "PHOTOGRAPHER") {
        // A tagged photographer may NOT own this shoot — /shoot/<id> bounces
        // non-owners to the bare list and the mention evaporates. The note page
        // admits anyone tagged on the thread; without a note, fall back to the
        // shoot page only when it will actually open for them.
        if (opts.noteId) href = `/shoot/note/${opts.noteId}`;
        else {
          const { photographerOwnsShoot } = await import("@/lib/shoot");
          href = (await photographerOwnsShoot(opts.projectId, t.id)) ? `/shoot/${opts.projectId}` : "/shoot";
        }
      } else if (editorKey) href = `/edit/${opts.projectId}`;
      else href = `/projects/${opts.projectId}`;

      const slackDm = selfTag
        ? null
        : slackMentionDm({ author, street, context: opts.context ?? "a note", text: opts.text, href, ownerRecipient: owners.includes(t.id) });

      // The companion task must carry the note link too — a photographer's
      // task board can't deep-link a note it doesn't know about.
      const noteLink = opts.noteId ? ` Open the note: /shoot/note/${opts.noteId}` : "";

      // Same open-tag task per (project, person) the team-message tags use —
      // deliberately the SAME dedupeKey so one person has ONE "you were
      // tagged on this job" item however they were tagged.
      const data = {
        taskType: "internal_instruction",
        title: `${author} tagged you — ${street}`.slice(0, 120),
        summary: `${author} tagged you in ${opts.context ?? "a note"} on ${street}: “${opts.text.slice(0, 200)}”. Take any needed action and reply on the note.${noteLink}`.slice(0, 500),
        description: opts.text.slice(0, 400),
        reasonCreated: `You were tagged in ${opts.context ?? "a note"}`,
        source: "team",
        priority: "HIGH" as const,
        dueAt: new Date(Date.now() + 4 * 3600_000),
        projectId: opts.projectId,
        clientId: project?.clientId ?? null,
        ownerId: t.id,
        // On the tagged person's OWN board — ownerId alone shows on no surface
        // (editor boards filter by editor key, everyone else by name slug).
        assignedKey: editorKey ?? slugForName(t.name),
        dedupeKey: `mention-${opts.projectId}-${t.id}`,
      };
      const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: data.dedupeKey } });
      if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } }).catch(() => {});
      else await prisma.smartTask.create({ data }).catch(() => {});

      // Visibility needs the person's APP role in the audience (the bell API
      // matches audience AND userKey), so the tm: row stays broad — EXCEPT for
      // editors: dropping PHOTOGRAPHER there disarms the SMS bridge (which keys
      // on tm: + PHOTOGRAPHER-in-roles and texts on ET quiet hours), so a Manila
      // editor is reached ONLY via their editor:<key> channel row below, in
      // their own timezone — no 3am texts, no double delivery. An editor's app
      // role is never PHOTOGRAPHER, so they lose no visibility.
      const targets: import("@/lib/notify").NotifyTarget[] = [
        {
          roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
          userKey: `tm:${t.id}`,
          href,
          // The owner's text (Sep 11), read only when this tm: row is his: who,
          // where, the first ~90 characters, and the note itself — the note
          // page opens for the owner and shows the whole thread. Off on a
          // self-tag (no sentence = no text, notify.ts).
          ...(selfTag ? {} : { ownerSms: `${author} mentioned you on ${street}: “${clip(opts.text, 90)}” ${appBase()}${href}` }),
          // The Slack DM (Sep 15): who, where, the first ~240 characters and
          // the same deep link the bell row carries. Off on a self-tag.
          ...(slackDm ? { slackDm } : {}),
        },
      ];
      if (editorKey) {
        // Channel row: the Slack/SMS bridge only fires for editor:<key> rows,
        // with quiet hours in the EDITOR's timezone. It carries the same DM
        // sentence — notify.ts sends ONE per person, whichever row is new.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${opts.projectId}`, ...(slackDm ? { slackDm } : {}) });
      }
      await notifyInApp({
        kind: "mention",
        title: `${author} mentioned you — ${street}`,
        body: opts.text.slice(0, 140),
        href,
        targets,
        // Random-free uniqueness: one ring per (project, note, person, comment
        // text hash) — re-saving identical text on the SAME note won't
        // re-ring, but "@Kim done" on a different thread must (a suppressed
        // ring here also lands the person in excludeTmIds downstream, which
        // would silence the thread-reply fallback ping too).
        dedupeKey: `mention-note-${opts.projectId}-${opts.noteId ?? "x"}-${t.id}-${simpleHash(opts.text)}`,
      });
    }
    return tagged.map((t) => t.id);
  } catch (e) {
    console.warn("notifyMentions failed (comment already saved)", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Thread-reply notifications. A reply on a note used to notify NOBODY unless
// it hand-typed an @mention — a photographer's "which bathroom do you mean?"
// rotted invisibly (audit #31). On every saved reply, ping the thread's OTHER
// participants (root author + prior repliers + the note's implicit addressee),
// minus the replier, minus anyone the reply already @-mentioned. Same contract
// as notifyMentions: best-effort, never fails the saved reply.
// ---------------------------------------------------------------------------
export async function notifyThreadReply(opts: {
  rootId: string;
  replyId: string;
  replierKey: string; // "owner" | "tm:<id>" | "editor:<key>"
  replierName?: string | null;
  text: string;
  projectId: string;
  surface: "gallery" | "cut";
  excludeTmIds: string[]; // already pinged via @mention on this reply
}): Promise<void> {
  try {
    const [thread, project] = await Promise.all([
      prisma.mediaNote.findMany({
        where: { OR: [{ id: opts.rootId }, { parentId: opts.rootId }] },
        select: { id: true, authorKey: true, lane: true, photographerId: true, editorKey: true },
      }),
      prisma.project.findUnique({ where: { id: opts.projectId }, select: { title: true } }),
    ]);
    const root = thread.find((n) => n.id === opts.rootId);
    if (!root) return;
    const street = project?.title?.split(",")[0]?.trim() || "a job";
    const author = opts.replierName ?? "A teammate";
    const firstName = author.split(/\s+/)[0];
    // The Slack DM sentence for every person this reply reaches (Sep 15):
    // "↩︎ <Author> replied to you on <street> — a cut note". Money stays in
    // the quote only for the owner.
    const context = opts.surface === "cut" ? "a cut note" : "a review note";
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    const replyDm = (href: string, tmId: string | null) =>
      slackMentionDm({ author, street, context, text: opts.text, href, reply: true, ownerRecipient: !!tmId && owners.includes(tmId) });

    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const editorTmIds = await editorTmIdMap(); // TeamMember id → editor key

    // Participants: every distinct authorKey on the thread, plus the implicit
    // addressee of the root note (the photographer/editor it's addressed to).
    const keys = new Set<string>();
    for (const n of thread) if (n.authorKey) keys.add(n.authorKey);
    if (root.lane === "PHOTOGRAPHER" && root.photographerId) keys.add(`tm:${root.photographerId}`);
    if (root.lane === "EDITOR" && root.editorKey) keys.add(`editor:${root.editorKey}`);
    keys.delete(opts.replierKey);
    // A replier identified by tm: id that maps to an editor key (or vice versa)
    // is the same human — drop both spellings of them. The owner shoots too,
    // so his roster row can sit on a photographer-lane thread as tm:<id>
    // while his notes carry "owner" — same human, same rule.
    if (opts.replierKey.startsWith("tm:")) {
      const ek = editorTmIds.get(opts.replierKey.slice(3));
      if (ek) keys.delete(`editor:${ek}`);
      if (owners.includes(opts.replierKey.slice(3))) keys.delete("owner");
    } else if (opts.replierKey.startsWith("editor:")) {
      for (const [tmId, ek] of editorTmIds) if (`editor:${ek}` === opts.replierKey) keys.delete(`tm:${tmId}`);
    } else if (opts.replierKey === "owner") {
      for (const id of owners) keys.delete(`tm:${id}`);
    }

    const { notifyInApp } = await import("@/lib/notify");
    const excluded = new Set(opts.excludeTmIds);
    const targets: import("@/lib/notify").NotifyTarget[] = [];
    let ownerAdded = false;
    const seenHumans = new Set<string>(); // tm ids / editor keys already targeted
    for (const key of keys) {
      if (key === "owner") {
        // Jordan writes most review/cut notes, and until Sep 15 his
        // participant row was a bare OWNER broadcast — no userKey, so no
        // Slack DM ever reached him for a reply on his own note (reviewer).
        // Now: one tm: row per owner roster row carrying the reply DM (his
        // row holds his Slack ID); the bare broadcast stands only when no
        // owner row resolves. Excluded = he was @-tagged in this reply and
        // the mention ping already carried his DM.
        const ownerHref = opts.surface === "cut" ? `/review/${opts.projectId}` : `/projects/${opts.projectId}`;
        const ownerRows = owners.filter((id) => !excluded.has(id) && !seenHumans.has(`t:${id}`));
        for (const id of ownerRows) {
          seenHumans.add(`t:${id}`);
          targets.push({ roles: ["OWNER"], userKey: `tm:${id}`, href: ownerHref, slackDm: replyDm(ownerHref, id) });
        }
        if (owners.length === 0 && !ownerAdded) {
          targets.push({ roles: ["OWNER"], href: ownerHref });
          ownerAdded = true;
        }
        continue;
      }
      if (key.startsWith("editor:")) {
        const ek = key.slice(7);
        if (!(TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(ek)) continue; // vendors have no bell/channel
        if (seenHumans.has(`e:${ek}`)) continue;
        seenHumans.add(`e:${ek}`);
        const tmId = await editorTeamMemberId(ek);
        const editHref = `/edit/${opts.projectId}`;
        if (tmId) {
          if (excluded.has(tmId)) continue;
          seenHumans.add(`t:${tmId}`);
          // Visibility row (tm:, no PHOTOGRAPHER role → SMS bridge stays cold).
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: editHref, slackDm: replyDm(editHref, tmId) });
        }
        // Channel row → Slack DM/SMS in the editor's timezone.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: editHref, slackDm: replyDm(editHref, tmId) });
        continue;
      }
      if (key.startsWith("tm:")) {
        const tmId = key.slice(3);
        if (excluded.has(tmId) || seenHumans.has(`t:${tmId}`)) continue;
        const ek = editorTmIds.get(tmId);
        if (ek) {
          // This human is an editor — route through their editor channel instead.
          if (seenHumans.has(`e:${ek}`)) continue;
          seenHumans.add(`e:${ek}`);
          seenHumans.add(`t:${tmId}`);
          const editHref = `/edit/${opts.projectId}`;
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: editHref, slackDm: replyDm(editHref, tmId) });
          targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: editHref, slackDm: replyDm(editHref, tmId) });
          continue;
        }
        seenHumans.add(`t:${tmId}`);
        const member = await prisma.teamMember.findUnique({ where: { id: tmId }, select: { role: true } });
        if (member?.role === "PHOTOGRAPHER") {
          // PHOTOGRAPHER in roles arms the tm: SMS bridge (note_reply ∈ SMS_KINDS);
          // the note page admits the thread's participants, so link it directly.
          const noteHref = `/shoot/note/${opts.rootId}`;
          targets.push({
            roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"],
            userKey: `tm:${tmId}`,
            href: noteHref,
            slackDm: replyDm(noteHref, tmId),
          });
        } else {
          // Kyle/staff: bell (and, since Sep 15, the Slack DM) — never SMS.
          const projHref = `/projects/${opts.projectId}`;
          targets.push({ roles: ["OWNER", "ADMIN"], userKey: `tm:${tmId}`, href: projHref, slackDm: replyDm(projHref, tmId) });
        }
      }
    }
    if (targets.length === 0) return;
    await notifyInApp({
      kind: "note_reply",
      title: `${firstName} replied — ${street}`,
      body: opts.text.slice(0, 140), // auto-nulled by the money clamp on creative rows
      href: `/projects/${opts.projectId}`,
      targets,
      // One bell per person per reply; retries collapse on P2002.
      dedupeKey: `note-reply-${opts.replyId}`,
    });
  } catch (e) {
    console.warn("notifyThreadReply failed (reply already saved)", e);
  }
}

// ---------------------------------------------------------------------------
// A reply in a job's team chat — the Editing Room's "Project chat", the
// project page thread, the Messages centre — pinged NOBODY unless it also
// @-tagged them (the reply arrow only quoted the parent). Jordan, Sep 15: a
// reply has to reach the person it answers, on Slack, with the summary and
// the link. So: ping the parent message's author with one bell row (the same
// role-aware shape the tags use) carrying the reply DM sentence. Skipped when
// the reply is their own, or the reply already @-tagged them (the mention
// ping carried the DM). Best-effort; never fails the saved reply.
// ---------------------------------------------------------------------------
export async function notifyMessageReply(opts: {
  projectId: string;
  /** The reply just saved — the dedupe key. */
  messageId: string;
  replyToId: string;
  /** The replier's OWN roster row — exact, like the self-tag rule. */
  replierTmId: string | null;
  /** Nothing identified the replier (sessionless dev): treat the owner's
   *  roster rows as theirs. Never true for a real login — a second owner
   *  login answering Jordan's message must reach him (reviewer, Sep 15). */
  inferOwnerReplier: boolean;
  replierName: string | null;
  text: string;
  /** Already pinged via @mention on this reply. */
  excludeTmIds: string[];
}): Promise<void> {
  try {
    const parent = await prisma.projectMessage.findUnique({ where: { id: opts.replyToId }, select: { authorId: true } });
    const targetId = parent?.authorId;
    if (!targetId || targetId === opts.replierTmId || opts.excludeTmIds.includes(targetId)) return;
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    if (opts.inferOwnerReplier && owners.includes(targetId)) return; // the owner answering his own message
    const [member, project] = await Promise.all([
      prisma.teamMember.findUnique({ where: { id: targetId }, select: { id: true, name: true, role: true, active: true } }),
      prisma.project.findUnique({ where: { id: opts.projectId }, select: { title: true } }),
    ]);
    if (!member?.active) return;
    const street = project?.title?.split(",")[0]?.trim() || "a job";
    const author = opts.replierName ?? "A teammate";
    const editorKey = (await editorTmIdMap()).get(member.id) ?? null;
    const dm = (href: string) =>
      slackMentionDm({ author, street, context: "the job's team chat", text: opts.text, href, reply: true, ownerRecipient: owners.includes(member.id) });

    const targets: import("@/lib/notify").NotifyTarget[] = [];
    let href: string;
    if (editorKey) {
      // Same pair as a tag: visibility row (no PHOTOGRAPHER role → SMS bridge
      // stays cold) + the editor channel row; notify.ts sends ONE DM.
      href = `/edit/${opts.projectId}`;
      targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${member.id}`, href, slackDm: dm(href) });
      targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href, slackDm: dm(href) });
    } else if (member.role === "PHOTOGRAPHER" && !owners.includes(member.id)) {
      // A photographer who doesn't own this shoot bounces off /shoot/<id>.
      const { photographerOwnsShoot } = await import("@/lib/shoot");
      href = (await photographerOwnsShoot(opts.projectId, member.id).catch(() => false)) ? `/shoot/${opts.projectId}` : "/shoot";
      targets.push({ roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"], userKey: `tm:${member.id}`, href, slackDm: dm(href) });
    } else {
      // Kyle/staff — and the owner, whose roster role is PHOTOGRAPHER but who
      // reads the thread on the project page: bell + Slack, never SMS.
      href = `/projects/${opts.projectId}`;
      targets.push({ roles: ["OWNER", "ADMIN"], userKey: `tm:${member.id}`, href, slackDm: dm(href) });
    }
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "note_reply",
      title: `${author.split(/\s+/)[0]} replied — ${street}`,
      body: opts.text.slice(0, 140), // auto-nulled by the money clamp on creative rows
      href,
      targets,
      dedupeKey: `msg-reply-${opts.messageId}`,
    });
  } catch (e) {
    console.warn("notifyMessageReply failed (reply already saved)", e);
  }
}

// Tiny stable hash for dedupe keys (no crypto import needed).
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

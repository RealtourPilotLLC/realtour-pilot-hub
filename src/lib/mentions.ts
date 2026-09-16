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
// everyone else → the project page), and editors ALSO get their editor:<key>
// row (the one their EDITOR login sees). Since Sep 15 every person-addressed
// row carries the emitter's sentence (slackDm, built by slackMentionDm below)
// — Jordan: "if I type at John or at Kyle, a notification is sent to them
// directly in Slack with a link to the message and a summary" — and the
// bridge in notify.ts sends it as a Slack DM and/or a text by THAT PERSON's
// row on /settings → Team notifications (James and Harrison: a text with the
// link; the editors: Slack). A row's roles decide only who can see it in the
// bell. Best-effort by contract — a mention hiccup must never fail the
// comment that carried it.
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
// A reply opens "↩︎ <Author> replied to you on <street> — …" instead, and a
// message on a job the recipient is editing (Sep 15, notifyProjectMessage)
// "💬 <Author> posted on <street> — …". Since Sep 16 (Kyle call) the head
// carries the client too — "on 123 Main St (Compass) — a cut note" — a
// street alone is not how the office remembers a job. The quote is scrubbed
// of money for anyone but the owner (creatives never see pricing, and a
// Slack DM is even leakier than the bell), invisible characters are
// stripped, and the cut lands on a word boundary. Slack markup is escaped so
// a client's "<3" or "photos & video" arrive as typed; the "> " prefix is
// Slack's own quote. The same sentence is what a text carries, in plain-text
// form (notify.ts).
// ---------------------------------------------------------------------------
export function slackMentionDm(opts: {
  author: string;
  street: string;
  /** The client's name — "(Compass)" after the street. */
  client?: string | null;
  context: string;
  text: string;
  /** In-app href — the DM carries the absolute link (appBase()). */
  href: string;
  reply?: boolean;
  /** A message on a job the recipient edits, not a tag of them. */
  posted?: boolean;
  /** The recipient IS the owner → money stays in the quote. */
  ownerRecipient?: boolean;
}): string {
  const oneLine = stripInvisible(opts.text).replace(/\s+/g, " ").trim();
  const summary = clip(opts.ownerRecipient ? oneLine : scrubMoney(oneLine), 240);
  const client = (opts.client ?? "").trim();
  const where = client ? `${opts.street} (${clip(client, 60)})` : opts.street;
  const head = opts.reply
    ? `↩︎ ${opts.author} replied to you on ${where} — ${opts.context}`
    : opts.posted
      ? `💬 ${opts.author} posted on ${where} — ${opts.context}`
      : `💬 ${opts.author} mentioned you on ${where} — ${opts.context}`;
  return `${escapeSlack(head)}\n> ${escapeSlack(summary)}\n${appBase()}${opts.href}`;
}

// The street and client a DM head names, from the project row. "a job" when
// the project is gone; no client when the row has none.
async function projectWhere(projectId: string): Promise<{ street: string; client: string | null; clientId: string | null }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, clientId: true, client: { select: { name: true } } },
  });
  return {
    street: project?.title?.split(",")[0]?.trim() || "a job",
    client: project?.client?.name?.trim() || null,
    clientId: project?.clientId ?? null,
  };
}

// The in-app link that opens on the message itself (Sep 16): a page anchor
// "#msg-<id>" wherever a message or a reply is the subject, so the bell row
// and the DM land the reader on the line, not the top of a long thread.
const msgAnchor = (messageId: string | null | undefined) => (messageId ? `#msg-${messageId}` : "");

// The EDITOR's equivalent of the owner's Review-Room deep link (Sep 16). A
// tag or a reply on a CUT note must open the editor brief on that cut, not at
// the top of a page that can carry sixteen slots: ?cut=<id> makes it the cut
// the page opens on, #cut-<id> scrolls to its panel. Jordan's rule from the
// same day — "it should go directly to the cut that needs a revision". With
// no cut in hand the link is exactly what it always was.
const editCutHref = (projectId: string, cutId: string | null | undefined, messageId?: string | null) =>
  cutId ? `/edit/${projectId}?cut=${cutId}#cut-${cutId}` : `/edit/${projectId}${msgAnchor(messageId)}`;

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
  /** The Review Room submission the note sits on (a cut surface, Sep 16):
   *  the owner's link then opens the Review Room parked on that cut
   *  (/review/<projectId>?cut=<id>) instead of the shoot-note page his
   *  PHOTOGRAPHER roster role used to send him to. */
  cutId?: string;
  /** Which note surface this tag lives on, when it lives on one — "cut" =
   *  the Review Room (review/actions.ts), "gallery" = the photo/media notes.
   *  Only the owner's link reads it, and only to tell a cut whose submission
   *  we could not resolve (the Room's cut list) from a gallery note (the
   *  note page). Stated by the caller, never sniffed out of `context`. */
  surface?: "gallery" | "cut";
  /** The team-chat message the tag lives in, when the caller has one — the
   *  editor's, the owner's and the office's links then end in #msg-<id>. */
  messageId?: string;
}): Promise<string[]> {
  try {
    if (!opts.text.includes("@")) return [];
    const people = await prisma.teamMember.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
    });
    const tagged = matchMentions(opts.text, people);
    if (tagged.length === 0) return [];

    const { street, client, clientId } = await projectWhere(opts.projectId);
    const author = opts.authorName ?? "A teammate";

    // kim/john tags also need their editor:<key> row — the one their EDITOR
    // login sees on the bell.
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
      if (owners.includes(t.id)) {
        // The owner FIRST (Sep 16, Kyle call): his roster role is
        // PHOTOGRAPHER because he shoots, and the photographer rule below
        // sent his Sep 14 cut-note tag to /shoot/note/<id> instead of the
        // cut he reviews. A cut surface opens the Review Room on that cut
        // (the Room's cut list when the submission couldn't be resolved) —
        // but a GALLERY note still deep-links the note itself (review, Sep
        // 16: owner-first had been sending photo-note tags to a team-chat
        // thread that does not hold the note). Only a tag with no note at
        // all lands on the project page.
        href = opts.cutId
          ? `/review/${opts.projectId}?cut=${opts.cutId}`
          : opts.surface === "cut"
            ? `/review/${opts.projectId}`
            : opts.noteId
              ? `/shoot/note/${opts.noteId}`
              : `/projects/${opts.projectId}${opts.messageId ? msgAnchor(opts.messageId) : "#messages"}`;
      } else if (t.role === "PHOTOGRAPHER") {
        // A tagged photographer may NOT own this shoot — /shoot/<id> bounces
        // non-owners to the bare list and the mention evaporates. The note page
        // admits anyone tagged on the thread; without a note, fall back to the
        // shoot page only when it will actually open for them.
        if (opts.noteId) href = `/shoot/note/${opts.noteId}`;
        else {
          const { photographerOwnsShoot } = await import("@/lib/shoot");
          href = (await photographerOwnsShoot(opts.projectId, t.id)) ? `/shoot/${opts.projectId}${msgAnchor(opts.messageId)}` : "/shoot";
        }
      } else if (editorKey) href = editCutHref(opts.projectId, opts.cutId, opts.messageId);
      else href = `/projects/${opts.projectId}${msgAnchor(opts.messageId)}`;

      const slackDm = selfTag
        ? null
        : slackMentionDm({ author, street, client, context: opts.context ?? "a note", text: opts.text, href, ownerRecipient: owners.includes(t.id) });

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
        clientId,
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
      // matches audience AND userKey), so the tm: row stays broad. Roles are
      // visibility ONLY since Sep 15 — which channels the row goes out on is
      // the person's matrix row (notify.ts bridgePerson), so an editor's
      // tm: row simply drops the role they never hold.
      const targets: import("@/lib/notify").NotifyTarget[] = [
        {
          roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
          userKey: `tm:${t.id}`,
          href,
          // The sentence (Sep 15): who, where, the first ~240 characters and
          // the same deep link the bell row carries — the Slack DM, and the
          // text in plain-text form (the owner's Sep 11 text included: his
          // "tagged" row on /settings). Off on a self-tag = bell only.
          ...(slackDm ? { slackDm } : {}),
        },
      ];
      if (editorKey) {
        // The row the EDITOR login sees. It carries the same sentence —
        // notify.ts delivers ONCE per person, whichever row is new first.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: editCutHref(opts.projectId, opts.cutId, opts.messageId), ...(slackDm ? { slackDm } : {}) });
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
// as notifyMentions: best-effort, never fails the saved reply. Returns the
// roster ids it reached, so the job-message ping (notifyProjectMessage) can
// leave them alone — one ping per message.
// ---------------------------------------------------------------------------
export async function notifyThreadReply(opts: {
  rootId: string;
  replyId: string;
  replierKey: string; // "owner" | "tm:<id>" | "editor:<key>"
  replierName?: string | null;
  text: string;
  projectId: string;
  surface: "gallery" | "cut";
  /** The Review Room submission a cut thread sits on (Sep 16) — the owner's
   *  link opens the Room parked on that cut. */
  cutId?: string;
  excludeTmIds: string[]; // already pinged via @mention on this reply
}): Promise<string[]> {
  const reached: string[] = [];
  try {
    const [thread, { street, client }] = await Promise.all([
      prisma.mediaNote.findMany({
        where: { OR: [{ id: opts.rootId }, { parentId: opts.rootId }] },
        select: { id: true, authorKey: true, lane: true, photographerId: true, editorKey: true },
      }),
      projectWhere(opts.projectId),
    ]);
    const root = thread.find((n) => n.id === opts.rootId);
    if (!root) return reached;
    const author = opts.replierName ?? "A teammate";
    const firstName = author.split(/\s+/)[0];
    // The Slack DM sentence for every person this reply reaches (Sep 15):
    // "↩︎ <Author> replied to you on <street> (<client>) — a cut note". Money
    // stays in the quote only for the owner.
    const context = opts.surface === "cut" ? "a cut note" : "a review note";
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    const replyDm = (href: string, tmId: string | null) =>
      slackMentionDm({ author, street, client, context, text: opts.text, href, reply: true, ownerRecipient: !!tmId && owners.includes(tmId) });
    // Where the owner reads this thread: the Review Room on that cut, else
    // the project page (Sep 16 — decided before any roster-role rule).
    const ownerHref = opts.surface === "cut"
      ? `/review/${opts.projectId}${opts.cutId ? `?cut=${opts.cutId}` : ""}`
      : `/projects/${opts.projectId}`;

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
        const ownerRows = owners.filter((id) => !excluded.has(id) && !seenHumans.has(`t:${id}`));
        for (const id of ownerRows) {
          seenHumans.add(`t:${id}`);
          reached.push(id);
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
        const editHref = editCutHref(opts.projectId, opts.surface === "cut" ? opts.cutId : null);
        if (tmId) {
          if (excluded.has(tmId)) continue;
          seenHumans.add(`t:${tmId}`);
          reached.push(tmId);
          // Visibility row (tm:) — roles say who can see it, not where it goes.
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: editHref, slackDm: replyDm(editHref, tmId) });
        }
        // The row the EDITOR login sees; the bridge delivers once per person.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: editHref, slackDm: replyDm(editHref, tmId) });
        continue;
      }
      if (key.startsWith("tm:")) {
        const tmId = key.slice(3);
        if (excluded.has(tmId) || seenHumans.has(`t:${tmId}`)) continue;
        const ek = editorTmIds.get(tmId);
        if (ek) {
          // This human is an editor — the same pair of rows a tag gives them.
          if (seenHumans.has(`e:${ek}`)) continue;
          seenHumans.add(`e:${ek}`);
          seenHumans.add(`t:${tmId}`);
          reached.push(tmId);
          const editHref = editCutHref(opts.projectId, opts.surface === "cut" ? opts.cutId : null);
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: editHref, slackDm: replyDm(editHref, tmId) });
          targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: editHref, slackDm: replyDm(editHref, tmId) });
          continue;
        }
        seenHumans.add(`t:${tmId}`);
        reached.push(tmId);
        const member = await prisma.teamMember.findUnique({ where: { id: tmId }, select: { role: true } });
        if (owners.includes(tmId)) {
          // The owner sitting on a thread under his tm: key (he shoots, so a
          // photographer-lane note can carry his row): the Review Room / the
          // project page, never the shoot-note page (Sep 16).
          targets.push({ roles: ["OWNER"], userKey: `tm:${tmId}`, href: ownerHref, slackDm: replyDm(ownerHref, tmId) });
        } else if (member?.role === "PHOTOGRAPHER") {
          // The note page admits the thread's participants, so link it
          // directly. Their matrix row (text by default) carries the sentence.
          const noteHref = `/shoot/note/${opts.rootId}`;
          targets.push({
            roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"],
            userKey: `tm:${tmId}`,
            href: noteHref,
            slackDm: replyDm(noteHref, tmId),
          });
        } else {
          // Kyle/staff: the project page; Slack by their default row.
          const projHref = `/projects/${opts.projectId}`;
          targets.push({ roles: ["OWNER", "ADMIN"], userKey: `tm:${tmId}`, href: projHref, slackDm: replyDm(projHref, tmId) });
        }
      }
    }
    if (targets.length === 0) return reached;
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
  return reached;
}

// ---------------------------------------------------------------------------
// A reply in a job's team chat — the Editing Room's "Project chat", the
// project page thread, the Messages centre — pinged NOBODY unless it also
// @-tagged them (the reply arrow only quoted the parent). Jordan, Sep 15: a
// reply has to reach the person it answers, on Slack, with the summary and
// the link. So: ping the parent message's author with one bell row (the same
// role-aware shape the tags use) carrying the reply DM sentence. Skipped when
// the reply is their own, or the reply already @-tagged them (the mention
// ping carried the DM). Best-effort; never fails the saved reply. Returns the
// roster id it reached (if any) so the job-message ping leaves them alone.
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
}): Promise<string[]> {
  try {
    const parent = await prisma.projectMessage.findUnique({ where: { id: opts.replyToId }, select: { authorId: true } });
    const targetId = parent?.authorId;
    if (!targetId || targetId === opts.replierTmId || opts.excludeTmIds.includes(targetId)) return [];
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    if (opts.inferOwnerReplier && owners.includes(targetId)) return []; // the owner answering his own message
    const [member, { street, client }] = await Promise.all([
      prisma.teamMember.findUnique({ where: { id: targetId }, select: { id: true, name: true, role: true, active: true } }),
      projectWhere(opts.projectId),
    ]);
    if (!member?.active) return [];
    const author = opts.replierName ?? "A teammate";
    const editorKey = (await editorTmIdMap()).get(member.id) ?? null;
    const dm = (href: string) =>
      slackMentionDm({ author, street, client, context: "the job's team chat", text: opts.text, href, reply: true, ownerRecipient: owners.includes(member.id) });

    // Every link lands on the reply itself (#msg-<id>, Sep 16).
    const anchor = msgAnchor(opts.messageId);
    const targets: import("@/lib/notify").NotifyTarget[] = [];
    let href: string;
    if (editorKey) {
      // Same pair as a tag: the visibility row + the row the EDITOR login
      // sees; notify.ts delivers once per person.
      href = `/edit/${opts.projectId}${anchor}`;
      targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${member.id}`, href, slackDm: dm(href) });
      targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href, slackDm: dm(href) });
    } else if (member.role === "PHOTOGRAPHER" && !owners.includes(member.id)) {
      // A photographer who doesn't own this shoot bounces off /shoot/<id>.
      const { photographerOwnsShoot } = await import("@/lib/shoot");
      href = (await photographerOwnsShoot(opts.projectId, member.id).catch(() => false)) ? `/shoot/${opts.projectId}${anchor}` : "/shoot";
      targets.push({ roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"], userKey: `tm:${member.id}`, href, slackDm: dm(href) });
    } else {
      // Kyle/staff — and the owner, whose roster role is PHOTOGRAPHER but who
      // reads the thread on the project page. Their matrix row decides the
      // channels (the owner's "tagged" row: text + Slack by default).
      href = `/projects/${opts.projectId}${anchor}`;
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
    return [member.id];
  } catch (e) {
    console.warn("notifyMessageReply failed (reply already saved)", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// "A message was sent on their project" (Jordan, Sep 15). A tag reaches the
// person tagged; a reply reaches the person answered; but a plain post on a
// job — Kyle's "client wants the pool shot first" in the team chat, a reply
// on a cut note between Jordan and the photographer — reached the job's
// EDITOR only if they happened to be tagged. Now the job's current editor
// hears every message on their job, once: kind "project_message", their own
// row on /settings (Slack by default). Skipped when the editor wrote it, or
// was already reached by the tag / reply ping for the same message (one ping
// per message: mention wins).
//
// Sep 16 (Kyle call — "do I also have to message him?"): the same post also
// reaches the job's ASSIGNED PHOTOGRAPHER while the job is not delivered
// (their shoot page, #messages) and THE OFFICE (Kyle: the ADMIN logins'
// roster rows, smsPrefs.ts officeTeamMemberIds; the project page) — each as
// a bell row by default, because their "Job messages" row on /settings is
// OFF unless they flip it (the editors' stays ON). The owner is not an
// office row and, when he is the shooter, is not rung as one either: he
// writes most of these and hears the answers through tags and replies.
// Root review notes are NOT routed here on purpose: a cut note is bundled
// into the round the editor is rung for ("Changes requested —", job_ping),
// and a photo-review note is Kyle's or the photographer's. Best-effort;
// never fails the saved message.
// ---------------------------------------------------------------------------

// The job's current editor: whoever holds the open edit_video card, else the
// project's editor of record — and only when that person is an in-house
// editor with a roster row (a vendor key has nobody to DM).
export async function currentEditorForProject(projectId: string): Promise<{ tmId: string; editorKey: string } | null> {
  try {
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const card = await prisma.smartTask.findFirst({
      where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
      select: { assignedKey: true },
    });
    if (card?.assignedKey) {
      // An open card names the holder. In-house (kim/john/remar) → that
      // person; anyone else — Kyle's own edit, a vendor, the outside shop —
      // → nobody. Project.editorId may still name the editor of record from
      // before the hand-off (only the external_agency path clears it), and
      // pinging them about a job someone else now holds is the wrong ping
      // (review, Sep 15). Only a job with NO open card falls through to the
      // editor of record below.
      if (!(TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(card.assignedKey)) return null;
      const tmId = await editorTeamMemberId(card.assignedKey);
      return tmId ? { tmId, editorKey: card.assignedKey } : null;
    }
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { editorId: true } });
    if (!project?.editorId) return null;
    const editorKey = (await editorTmIdMap()).get(project.editorId);
    return editorKey ? { tmId: project.editorId, editorKey } : null;
  } catch {
    return null;
  }
}

export async function notifyProjectMessage(opts: {
  projectId: string;
  /** The message or reply just saved — the dedupe key, and the surface: a
   *  ProjectMessage id anchors the link at #msg-<id>, a MediaNote id links
   *  the note instead (resolved below, not passed). */
  messageId: string;
  /** The writer's OWN roster row (exact, like the self-tag rule). */
  authorTmId: string | null;
  /** The writer's session key — an editor login is keyed editor:<key>. */
  authorKey?: string | null;
  authorName: string | null;
  text: string;
  /** Where it was said: "the job's team chat" | "a cut-note comment" | … */
  context: string;
  /** Already pinged by the tag or reply notifier for this message. */
  excludeTmIds: string[];
}): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const { street, client } = await projectWhere(opts.projectId);
    const author = opts.authorName ?? "A teammate";
    const title = `${author} posted on ${street}`;
    // Which surface the id belongs to, asked rather than assumed (review, Sep
    // 16): two of the three callers hand us a MediaNote reply id, not a
    // ProjectMessage id, and #msg-<id> only ever matches a ProjectMessage row
    // (ProjectMessages.tsx). An unanchored note link also keeps the office off
    // the project-page team chat, which does not hold that note at all.
    const note = await prisma.mediaNote
      .findUnique({ where: { id: opts.messageId }, select: { id: true, parentId: true, photographerId: true } })
      .catch(() => null);
    const noteRootId = note ? note.parentId ?? note.id : null;
    const noteAddressee = note?.photographerId ?? null; // replies carry the root's
    const anchor = note ? "" : msgAnchor(opts.messageId);
    // Who wrote it, in every spelling a session can carry, and who was
    // already reached — nobody hears their own post, nobody hears it twice.
    const skip = new Set<string>(opts.excludeTmIds);
    if (opts.authorTmId) skip.add(opts.authorTmId);
    if (opts.authorKey?.startsWith("tm:")) skip.add(opts.authorKey.slice(3));
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    // Nobody here is the owner: money is scrubbed from every quote.
    const dm = (href: string) => slackMentionDm({ author, street, client, context: opts.context, text: opts.text, href, posted: true });
    const active = async (id: string) => !!(await prisma.teamMember.findUnique({ where: { id }, select: { active: true } }))?.active;

    // 1. The job's editor (Sep 15).
    const editor = await currentEditorForProject(opts.projectId);
    if (editor && !skip.has(editor.tmId) && opts.authorKey !== `editor:${editor.editorKey}` && (await active(editor.tmId))) {
      skip.add(editor.tmId);
      const href = `/edit/${opts.projectId}${anchor}`;
      const slackDm = dm(href);
      await notifyInApp({
        kind: "project_message",
        title,
        body: opts.text.slice(0, 140), // auto-nulled by the money clamp on the EDITOR rows
        href,
        targets: [
          { roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${editor.tmId}`, href, slackDm },
          { roles: ["EDITOR"], userKey: `editor:${editor.editorKey}`, href, slackDm },
        ],
        dedupeKey: `project-message-${opts.messageId}-${editor.tmId}`,
      });
    }

    // 2. The assigned photographer, while the job is still theirs to act on
    //    (Sep 16): the project's photographer of record, else the first
    //    assigned appointment — the same lookup the cut-note lane uses. A
    //    delivered or cancelled job is done for them.
    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { status: true, photographerId: true },
    });
    if (project && project.status !== "DELIVERED" && project.status !== "CANCELLED") {
      let photographerId = project.photographerId;
      if (!photographerId) {
        const appt = await prisma.appointment.findFirst({
          where: { projectId: opts.projectId, assignedToId: { not: null } },
          orderBy: { startAt: "asc" },
          select: { assignedToId: true },
        });
        photographerId = appt?.assignedToId ?? null;
      }
      if (photographerId && !skip.has(photographerId) && !owners.includes(photographerId) && (await active(photographerId))) {
        skip.add(photographerId);
        // A reply on THEIR OWN feedback note deep-links the note; any other
        // note (an editor-lane cut note, a note addressed to someone else)
        // would bounce them off /shoot/note back to the list, so it lands on
        // their shoot page instead — as does a team-chat post, at its message.
        const href = noteRootId && noteAddressee === photographerId ? `/shoot/note/${noteRootId}` : `/shoot/${opts.projectId}${anchor}`;
        await notifyInApp({
          kind: "project_message",
          title,
          body: opts.text.slice(0, 140), // auto-nulled by the money clamp (PHOTOGRAPHER in the audience)
          href,
          targets: [{ roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"], userKey: `tm:${photographerId}`, href, slackDm: dm(href) }],
          dedupeKey: `project-message-${opts.messageId}-${photographerId}`,
        });
      }
    }

    // 3. The office (Sep 16) — Kyle's project page: the job's team chat at
    //    that message, or the plain page when the post was a note comment
    //    (the note lives in the media/review sections, not the chat).
    const office = await (await import("@/lib/smsPrefs")).officeTeamMemberIds().catch(() => [] as string[]);
    for (const id of office) {
      if (skip.has(id) || !(await active(id))) continue;
      skip.add(id);
      const href = `/projects/${opts.projectId}${anchor}`;
      await notifyInApp({
        kind: "project_message",
        title,
        body: opts.text.slice(0, 140),
        href,
        targets: [{ roles: ["OWNER", "ADMIN"], userKey: `tm:${id}`, href, slackDm: dm(href) }],
        dedupeKey: `project-message-${opts.messageId}-${id}`,
      });
    }
  } catch (e) {
    console.warn("notifyProjectMessage failed (message already saved)", e);
  }
}

// Tiny stable hash for dedupe keys (no crypto import needed).
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

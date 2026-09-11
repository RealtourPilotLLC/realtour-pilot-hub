import "server-only";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// @mentions in note comments. The note/reply actions call notifyMentions with
// the saved text; anyone tagged gets the SAME treatment a team-message tag
// already gives (src/app/projects/messageActions.ts): one open "you were
// tagged on this job" task per (project, person) that refreshes on re-tags,
// plus a bell per comment. The bell's link lands on the surface that person
// can actually open (photographer → their shoot page, editor → their brief,
// everyone else → the project page), and editors ALSO get their channel row
// (editor:<key> → Slack DM/SMS via the notify bridge, "mention" is in both
// SMS_KINDS and EDITOR_CHANNEL_KINDS). Best-effort by contract — a mention
// hiccup must never fail the comment that carried it.
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

export async function notifyMentions(opts: {
  text: string;
  projectId: string;
  /** The writer's session key ("owner" | "tm:<id>" | "editor:<key>" | …) — a
   *  tag of THEMSELVES rings the bell and nothing more. */
  authorKey?: string | null;
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
    // Resolution is EXACT (editor key → its TeamMember id), never a name
    // substring — a future "Kimberly" must not ring editor Kim's channel.
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const { slugForName } = await import("@/lib/assignees");
    const editorTmIds = new Map<string, string>(); // TeamMember id → editor key
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }
    const editorKeyFor = (tmId: string): string | null => editorTmIds.get(tmId) ?? null;

    // The owner's roster row(s), so "@Jordan" in the owner's own note is
    // recognised as a self-tag (his session key is "owner", not tm:).
    const owners = opts.authorKey === "owner"
      ? await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[])
      : [];

    const { notifyInApp } = await import("@/lib/notify");
    for (const t of tagged) {
      const editorKey = editorKeyFor(t.id);
      // A self-tag rings the bell and nothing more — no text about what he
      // just wrote himself (reviewer, Sep 11).
      const selfTag = opts.authorKey === `tm:${t.id}` || owners.includes(t.id);
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
        },
      ];
      if (editorKey) {
        // Channel row: the Slack/SMS bridge only fires for editor:<key> rows,
        // with quiet hours in the EDITOR's timezone.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${opts.projectId}` });
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
    const firstName = (opts.replierName ?? "A teammate").split(/\s+/)[0];

    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const editorTmIds = new Map<string, string>(); // TeamMember id → editor key
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }

    // Participants: every distinct authorKey on the thread, plus the implicit
    // addressee of the root note (the photographer/editor it's addressed to).
    const keys = new Set<string>();
    for (const n of thread) if (n.authorKey) keys.add(n.authorKey);
    if (root.lane === "PHOTOGRAPHER" && root.photographerId) keys.add(`tm:${root.photographerId}`);
    if (root.lane === "EDITOR" && root.editorKey) keys.add(`editor:${root.editorKey}`);
    keys.delete(opts.replierKey);
    // A replier identified by tm: id that maps to an editor key (or vice versa)
    // is the same human — drop both spellings of them.
    if (opts.replierKey.startsWith("tm:")) {
      const ek = editorTmIds.get(opts.replierKey.slice(3));
      if (ek) keys.delete(`editor:${ek}`);
    } else if (opts.replierKey.startsWith("editor:")) {
      for (const [tmId, ek] of editorTmIds) if (`editor:${ek}` === opts.replierKey) keys.delete(`tm:${tmId}`);
    }

    const { notifyInApp } = await import("@/lib/notify");
    const excluded = new Set(opts.excludeTmIds);
    const targets: import("@/lib/notify").NotifyTarget[] = [];
    let ownerAdded = false;
    const seenHumans = new Set<string>(); // tm ids / editor keys already targeted
    for (const key of keys) {
      if (key === "owner") {
        if (!ownerAdded) {
          targets.push({
            roles: ["OWNER"],
            href: opts.surface === "cut" ? `/review/${opts.projectId}` : `/projects/${opts.projectId}`,
          });
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
        if (tmId) {
          if (excluded.has(tmId)) continue;
          seenHumans.add(`t:${tmId}`);
          // Visibility row (tm:, no PHOTOGRAPHER role → SMS bridge stays cold).
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: `/edit/${opts.projectId}` });
        }
        // Channel row → Slack DM/SMS in the editor's timezone.
        targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: `/edit/${opts.projectId}` });
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
          targets.push({ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${tmId}`, href: `/edit/${opts.projectId}` });
          targets.push({ roles: ["EDITOR"], userKey: `editor:${ek}`, href: `/edit/${opts.projectId}` });
          continue;
        }
        seenHumans.add(`t:${tmId}`);
        const member = await prisma.teamMember.findUnique({ where: { id: tmId }, select: { role: true } });
        if (member?.role === "PHOTOGRAPHER") {
          // PHOTOGRAPHER in roles arms the tm: SMS bridge (note_reply ∈ SMS_KINDS);
          // the note page admits the thread's participants, so link it directly.
          targets.push({
            roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"],
            userKey: `tm:${tmId}`,
            href: `/shoot/note/${opts.rootId}`,
          });
        } else {
          // Kyle/staff: bell only, never SMS.
          targets.push({ roles: ["OWNER", "ADMIN"], userKey: `tm:${tmId}`, href: `/projects/${opts.projectId}` });
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

// Tiny stable hash for dedupe keys (no crypto import needed).
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

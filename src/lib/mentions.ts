import "server-only";
import { prisma } from "@/lib/prisma";

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
// when that first name is unambiguous on the roster.
function matchMentions<T extends { id: string; name: string }>(text: string, people: T[]): T[] {
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

export async function notifyMentions(opts: {
  text: string;
  projectId: string;
  authorName?: string | null;
  /** Short context for the ping, e.g. "a review note" | "a cut note". */
  context?: string;
}): Promise<void> {
  try {
    if (!opts.text.includes("@")) return;
    const people = await prisma.teamMember.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
    });
    const tagged = matchMentions(opts.text, people);
    if (tagged.length === 0) return;

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
    const editorTmIds = new Map<string, string>(); // TeamMember id → editor key
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }
    const editorKeyFor = (tmId: string): string | null => editorTmIds.get(tmId) ?? null;

    const { notifyInApp } = await import("@/lib/notify");
    for (const t of tagged) {
      const editorKey = editorKeyFor(t.id);
      const href =
        t.role === "PHOTOGRAPHER"
          ? `/shoot/${opts.projectId}`
          : editorKey
            ? `/edit/${opts.projectId}`
            : `/projects/${opts.projectId}`;

      // Same open-tag task per (project, person) the team-message tags use —
      // deliberately the SAME dedupeKey so one person has ONE "you were
      // tagged on this job" item however they were tagged.
      const data = {
        taskType: "internal_instruction",
        title: `${author} tagged you — ${street}`.slice(0, 120),
        summary: `${author} tagged you in ${opts.context ?? "a note"} on ${street}: “${opts.text.slice(0, 200)}”. Take any needed action and reply on the note.`.slice(0, 500),
        description: opts.text.slice(0, 400),
        reasonCreated: `You were tagged in ${opts.context ?? "a note"}`,
        source: "team",
        priority: "HIGH" as const,
        dueAt: new Date(Date.now() + 4 * 3600_000),
        projectId: opts.projectId,
        clientId: project?.clientId ?? null,
        ownerId: t.id,
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
        // Random-free uniqueness: one ring per (project, person, comment text
        // hash) — re-saving identical text won't re-ring, new words will.
        dedupeKey: `mention-note-${opts.projectId}-${t.id}-${simpleHash(opts.text)}`,
      });
    }
  } catch (e) {
    console.warn("notifyMentions failed (comment already saved)", e);
  }
}

// Tiny stable hash for dedupe keys (no crypto import needed).
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

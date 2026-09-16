import "server-only";
import { prisma } from "@/lib/prisma";
import { notifyInApp, type NotifyTarget } from "@/lib/notify";

/**
 * Closing an @mention companion task rings the TAGGER's bell (bell-only —
 * "mention_done" is deliberately bell-only under eventForKind in
 * src/lib/notifyPrefs.ts): the loop that opened with
 * "@James check this" closes with "James finished your tag". Shared by every
 * human completion path — the task board (setSmartTaskStatus) and the Handled
 * button on Ops Day / the Dashboard (markLoopHandled) — so a tag never closes
 * silently from one surface and loudly from another (review, Sep 1).
 */
export async function notifyMentionDone(
  task: { id: string; title: string; projectId: string | null; propertyAddress: string | null; dedupeKey: string | null },
  completerName: string | null,
  /** Sep 16: a reply in the thread closes the tag — the bell then lands on
   *  THAT reply (`/projects/<id>#msg-<id>`), not the top of the page.
   *  `quiet` is for the AUTOMATIC path (a reply closed the tag by itself,
   *  postProjectMessage): it rings the tagger alone and drops the
   *  OWNER/ADMIN desk broadcast. That broadcast was tuned for a hand-tick —
   *  a rare, deliberate act — and would now land on Jordan, Kyle and every
   *  other desk login on EVERY reply to a tag (review, Sep 16). */
  opts: { href?: string; quiet?: boolean } = {},
): Promise<void> {
  if (!task.dedupeKey?.startsWith("mention-")) return;
  try {
    const completer = (completerName ?? "They").split(/\s+/)[0];
    const street = task.propertyAddress?.split(",")[0]?.trim() ?? task.title.split("—").pop()?.trim() ?? "a job";
    const targets: NotifyTarget[] = opts.quiet ? [] : [{ roles: ["OWNER", "ADMIN"] }];
    // The tagger's name is embedded in the title ("<author> tagged you — …");
    // an exact roster match adds their personal row on top of the desk row.
    const author = task.title.split(" tagged you")[0]?.trim();
    if (author) {
      const tagger = await prisma.teamMember.findFirst({ where: { name: author, active: true }, select: { id: true } });
      if (tagger) targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${tagger.id}` });
    }
    // Quiet + no roster row for the tagger = nobody to ring. The reply is
    // sitting in the thread they'll open anyway; a role broadcast here would
    // be exactly the desk spam this flag exists to stop.
    if (targets.length === 0) return;
    await notifyInApp({
      kind: "mention_done",
      title: `${completer} finished your tag — ${street}`,
      href: opts.href ?? (task.projectId ? `/projects/${task.projectId}#messages` : "/tasks"),
      targets,
      // Minute-bucketed: a re-tagged task completes again later and must
      // ring again (the companion task deliberately reopens under ONE
      // dedupeKey, so a taskId-only key would silence every round but the
      // first); double-submits within the same minute still collapse.
      dedupeKey: `mention-done-${task.id}-${new Date().toISOString().slice(0, 16)}`,
    });
  } catch { /* the close itself must never fail on a ping */ }
}

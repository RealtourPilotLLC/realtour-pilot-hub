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
): Promise<void> {
  if (!task.dedupeKey?.startsWith("mention-")) return;
  try {
    const completer = (completerName ?? "They").split(/\s+/)[0];
    const street = task.propertyAddress?.split(",")[0]?.trim() ?? task.title.split("—").pop()?.trim() ?? "a job";
    const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
    // The tagger's name is embedded in the title ("<author> tagged you — …");
    // an exact roster match adds their personal row on top of the desk row.
    const author = task.title.split(" tagged you")[0]?.trim();
    if (author) {
      const tagger = await prisma.teamMember.findFirst({ where: { name: author, active: true }, select: { id: true } });
      if (tagger) targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${tagger.id}` });
    }
    await notifyInApp({
      kind: "mention_done",
      title: `${completer} finished your tag — ${street}`,
      href: task.projectId ? `/projects/${task.projectId}` : "/tasks",
      targets,
      // Minute-bucketed: a re-tagged task completes again later and must
      // ring again (the companion task deliberately reopens under ONE
      // dedupeKey, so a taskId-only key would silence every round but the
      // first); double-submits within the same minute still collapse.
      dedupeKey: `mention-done-${task.id}-${new Date().toISOString().slice(0, 16)}`,
    });
  } catch { /* the close itself must never fail on a ping */ }
}

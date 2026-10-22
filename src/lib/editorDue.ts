import "server-only";
import { prisma } from "@/lib/prisma";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import { effectiveDue } from "@/lib/editOverrides";

// ---------------------------------------------------------------------------
// THE EDIT'S DUE DATE IN EVERY "YOU HAVE WORK" MESSAGE (Oct 22 2026). Jordan:
// "it would be helpful for the editors to know when a project is due." The
// brief's header already counted down, but the Slack DMs and texts that tell
// Kim and John Mark about work ("Ready for editing", "New edit", "Reassigned to
// you", "Task for you") never said when, and their desk list showed only the
// day. One reading of the date, the same as the brief's header (the video
// clock from the visit that shot it, the office's tier, then an office date
// override or a pinned promise: editOverrides.effectiveDue), worded in Eastern
// time with the editor's own time beside it.
// ---------------------------------------------------------------------------

const ET = "America/New_York";

/** When this job's edit is due, or null when it owes no video. */
export async function editDueFor(projectId: string): Promise<Date | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      shootDate: true, status: true, tierOverride: true, packageName: true, dueOverrideAt: true, promisedDueAt: true,
      appointments: { select: { status: true, startAt: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
      client: { select: { socialClient: true } },
    },
  }).catch(() => null);
  if (!p) return null;
  const sla = getVideoSlaStatus({ ...p, client: p.client });
  return effectiveDue(p, sla?.due ?? null);
}

const fmt = (d: Date, tz: string) =>
  d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(":00", "");

/** "due Thu, Oct 23, 4 PM ET (Fri, Oct 24, 4 AM Manila)". Pure. */
export function dueWordsFor(due: Date, editorTz?: string | null): string {
  const et = `due ${fmt(due, ET)} ET`;
  if (!editorTz || editorTz === ET) return et;
  const city = editorTz.split("/").pop()?.replace(/_/g, " ") ?? editorTz;
  return `${et} (${fmt(due, editorTz)} ${city})`;
}

/** The words for one job and one editor key, or "" when there is no date. */
export async function editDueWords(projectId: string | null | undefined, editorKey?: string | null): Promise<string> {
  if (!projectId) return "";
  const due = await editDueFor(projectId);
  if (!due) return "";
  const { editorMeta } = await import("@/lib/editors");
  return dueWordsFor(due, editorKey ? editorMeta(editorKey)?.tz ?? null : null);
}

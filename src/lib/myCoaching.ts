import "server-only";
import { prisma } from "@/lib/prisma";
import { itemView, type DevLogKind } from "@/lib/teamDevelopment";

// ---------------------------------------------------------------------------
// THE PERSON'S OWN COACHING (Oct 29 2026, Jordan's call table: "Put reviewed
// feedback in his Hub"). What James or Jordan recorded about them on a
// coaching item (DevelopmentItem), read for that person only: the skill, the
// standard, the next step, practice they were given, every note given to them,
// and where it stands. Field creatives read it on "My quality notes"
// (/shoot/feedback#coaching), everyone else on /my-coaching.
//
// Left out on purpose: readiness assessments (Jordan's decisions), practice
// James only RECOMMENDED to Jordan (editors and admin QC), plan edits, links
// into office pages (the photo desk is not theirs). Every word has passed the
// money scrubber (teamDevelopment.itemView) and has no em dashes.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
/** The notes said to the person; the plan and follow-up-date lines are the coach's own bookkeeping. */
const SAID: Partial<Record<DevLogKind, string>> = {
  created: "Feedback",
  feedback: "Feedback",
  follow_up: "Follow-up",
  practice: "Practice",
  verified: "Improvement seen",
};
const RESULT: Record<string, string> = { improved: "improved", not_yet: "not there yet" };

export type MyCoachingItem = {
  id: string;
  skill: string;
  status: "OPEN" | "VERIFIED" | "CLOSED";
  statusWords: string;
  standard: string | null;
  nextAction: string | null;
  practice: string | null;
  practiceDueISO: string | null;
  followUpISO: string | null;
  notes: { atISO: string; by: string; what: string; note: string }[];
  examples: { label: string; atISO: string | null }[];
  createdISO: string;
};

/**
 * Their coaching items: open ones, and those verified or closed in the last 90
 * days. `personIds`: their roster id and, for an editor without one, the
 * `editor:<key>` the coaching item was recorded under.
 */
export async function readMyCoaching(personIds: string[], now = new Date()): Promise<MyCoachingItem[]> {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!ids.length) return [];
  const rows = await prisma.developmentItem.findMany({
    where: { personId: { in: ids }, OR: [{ status: "OPEN" }, { updatedAt: { gte: new Date(now.getTime() - 90 * DAY) } }] },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 40,
  });
  return rows.map((r) => {
    const v = itemView(r, now);
    const field = v.group === "FIELD";
    return {
      id: v.id,
      skill: v.skill,
      status: v.status,
      statusWords: v.status === "VERIFIED" ? "Improvement seen" : v.status === "CLOSED" ? "Closed" : "Open",
      standard: v.standard,
      nextAction: v.nextAction,
      practice: field ? v.practice : null,
      practiceDueISO: field ? v.practiceDueISO : null,
      followUpISO: v.status === "OPEN" ? v.followUpISO : null,
      notes: v.log
        .filter((l) => SAID[l.kind] && l.note)
        .map((l) => ({ atISO: l.at, by: l.by, what: `${SAID[l.kind]}${l.result && RESULT[l.result] ? ` (${RESULT[l.result]})` : ""}`, note: l.note! }))
        .reverse(),
      examples: v.evidence.filter((e) => e.source !== "verified").map((e) => ({ label: e.label, atISO: e.at })).slice(0, 8),
      createdISO: v.createdISO,
    };
  });
}

/** Who this login is, as coaching records it: their roster row and their editor key. */
export function myCoachingIds(me: { teamMemberId: string | null; editorKey: string | null }): string[] {
  return [me.teamMemberId, me.editorKey ? `editor:${me.editorKey}` : null].filter((x): x is string => !!x);
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { contentHref } from "@/lib/contentNav";
import type { ScriptReadiness } from "@/lib/contentDrafting";

// ---------------------------------------------------------------------------
// SCRIPTS TO WRITE, ON THE DASHBOARD (Oct 20 2026). Jordan: "on my dashboard
// and the creative manager's dashboard, I need to make sure we are able to see
// the scripts that need scripting."
//
// Two lists, this month and later, real clients only:
//   · TO WRITE — a video the month owes with no script yet, from the month's
//     own work list (contentDrafting.scriptWorkForMonth), with why it has none:
//     the hub drafts it next (the answers or the call carry it), it needs a
//     person (nothing to draft from), it waits on the client's written
//     answers, or the month's plan is not settled. Extras beyond the month's
//     allowance and clients who write their own scripts are left out.
//   · TO REVIEW — a draft waiting on a person (contentScripts.scriptsAwaitingReview).
// Reads only; no model call.
// ---------------------------------------------------------------------------

export type ScriptRow = {
  key: string;
  clientName: string;
  monthKey: string;
  title: string;
  /** what stands between this video and a script, in words */
  state: string;
  tone: "warn" | "muted" | "brand";
  href: string;
};

export type ScriptsToWrite = { toWrite: ScriptRow[]; toReview: ScriptRow[] };

const STATE: Partial<Record<ScriptReadiness, { words: string; tone: ScriptRow["tone"] }>> = {
  THIN: { words: "Needs a script: nothing to draft from yet", tone: "warn" },
  THIN_ANSWERS: { words: "Needs a script: the answers are too thin", tone: "warn" },
  FROM_ANSWERS: { words: "The hub drafts it next (from the answers)", tone: "muted" },
  FROM_CALL: { words: "The hub drafts it next (from the call)", tone: "muted" },
  WAITING_ON_ANSWERS: { words: "Waiting on the client's written answers", tone: "muted" },
  WAITING_ON_PLANNING: { words: "Settle the month's plan first", tone: "warn" },
};

export async function scriptsToWrite(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<ScriptsToWrite> {
  const now = opts.now ?? new Date();
  const thisMonth = etMonthKey(now);
  const exclude = new Set(opts.excludeClientIds ?? []);
  const months = await prisma.contentMonth.findMany({
    where: { historical: false, monthKey: { gte: thisMonth }, ...(exclude.size ? { clientId: { notIn: [...exclude] } } : {}) },
    orderBy: { monthKey: "asc" },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true },
  });
  const enrollments = months.length
    ? await prisma.contentEnrollment.findMany({ where: { id: { in: [...new Set(months.map((m) => m.enrollmentId))] } }, select: { id: true, status: true, clientSuppliesTopics: true } })
    : [];
  // A client who plans their own content gets no scripts from us; a closed program owes none.
  const live = new Set(enrollments.filter((e) => !e.clientSuppliesTopics && e.status !== "ENDED").map((e) => e.id));

  const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
  const toWrite: ScriptRow[] = [];
  // Six months at a time: the dashboard should not wait on one month after another.
  const owed = months.filter((m) => live.has(m.enrollmentId));
  const works: { m: (typeof owed)[number]; work: Awaited<ReturnType<typeof scriptWorkForMonth>> }[] = [];
  for (let i = 0; i < owed.length; i += 6) {
    works.push(...(await Promise.all(owed.slice(i, i + 6).map(async (m) => ({ m, work: await scriptWorkForMonth(m.id).catch(() => []) })))));
  }
  for (const { m, work } of works) {
    for (const w of work) {
      const s = STATE[w.readiness];
      if (!s || w.scriptId) continue;
      toWrite.push({
        key: `w:${w.topicId}:${m.id}`, clientName: w.clientName ?? "A client", monthKey: m.monthKey, title: w.title, state: s.words, tone: s.tone,
        href: contentHref(m.enrollmentId, { tab: "plan", view: "scripts", month: m.monthKey, now }),
      });
    }
  }
  // Needs a person first, then what the hub drafts itself; oldest month first within each.
  const rank = (r: ScriptRow) => (r.tone === "warn" ? 0 : 1);
  toWrite.sort((a, b) => rank(a) - rank(b) || a.monthKey.localeCompare(b.monthKey) || a.clientName.localeCompare(b.clientName));

  const { scriptsAwaitingReview } = await import("@/lib/contentScripts");
  const review = await scriptsAwaitingReview().catch(() => []);
  const toReview: ScriptRow[] = review
    .filter((r) => !exclude.has(r.clientId) && live.has(r.enrollmentId) && !!r.monthKey && r.monthKey >= thisMonth)
    .map((r) => ({
      key: `r:${r.scriptId}`, clientName: r.clientName, monthKey: r.monthKey!, title: r.title,
      state: r.judgeFlagged ? "Draft to review: the automatic check flagged it" : r.gaps ? `Draft to review: ${r.gaps} gap${r.gaps === 1 ? "" : "s"} to fill` : "Draft to review",
      tone: "brand" as const,
      href: contentHref(r.enrollmentId, { tab: "plan", view: "scripts", month: r.monthKey!, now }),
    }));
  return { toWrite, toReview };
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { endOfBusinessDaysET } from "@/lib/datetime";
import type { AuditAction } from "@/lib/financeAuditCore";

// ---------------------------------------------------------------------------
// THE BOOKS AUDIT'S ACTION ITEMS AS TASKS (Oct 24 2026). Jordan: "give me
// action items in the hub to handle that now and in the future." Each action
// the audit finds (financeAudit.ts) becomes ONE task for the owner, keyed to
// the problem (`finance-audit:<key>`), and the daily run keeps them honest:
//   · a problem the audit still sees → its task stays open (re-opened if it
//     was marked done but the gap is still there; a CANCELLED one stays
//     cancelled: that was a decision);
//   · a problem that's gone → its open task completes itself, with a line
//     saying the audit no longer sees it.
// Monthly items ("Upload your October Venmo statement") arrive the same way
// each month, keyed by month. Task text never carries a dollar amount: the
// figures stay on the owner-only Finance → Audit page the task links to.
// ---------------------------------------------------------------------------

const PREFIX = "finance-audit:";
const CLOSED = ["COMPLETED", "CANCELLED"];

/** "Record $4,297 of QuickBooks payments" → "Record QuickBooks payments". */
export const moneyFree = (s: string) =>
  s.replace(/\$[\d,]+(?:\.\d+)?\s*(?:of\s+)?/g, "").replace(/\s{2,}/g, " ").replace(/\s+([:,.])/g, "$1").replace(/^./, (c) => c.toUpperCase()).trim();

export async function syncAuditTasks(actions: AuditAction[], now: Date = new Date()): Promise<{ opened: number; reopened: number; closed: number; open: number }> {
  const owner = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { teamMemberId: true } });
  const existing = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: PREFIX } }, select: { id: true, dedupeKey: true, status: true, completedAt: true } });
  const byKey = new Map(existing.map((t) => [t.dedupeKey!, t]));
  let opened = 0, reopened = 0, closed = 0;
  const live = new Set<string>();
  for (const a of actions) {
    const dedupeKey = `${PREFIX}${a.key}`.slice(0, 190);
    live.add(dedupeKey);
    const data = {
      taskType: "finance_audit",
      title: moneyFree(a.title).slice(0, 200),
      summary: "The books audit found this. The amounts and the details are on Finance → Audit.",
      description: [`What to do: ${a.how}`, "", "Open Finance → Audit (owner only) for the amounts. This task closes itself once the audit no longer sees the problem."].join("\n"),
      reasonCreated: a.when === "monthly" ? "Monthly books upkeep" : "The year-to-date books audit",
      source: "finance_audit",
      priority: a.when === "now" ? "HIGH" : "MEDIUM",
      assignedKey: "jordan",
      ownerId: owner?.teamMemberId ?? null,
    };
    const cur = byKey.get(dedupeKey);
    if (!cur) {
      await prisma.smartTask.create({ data: { ...data, dedupeKey, status: "OPEN", dueAt: endOfBusinessDaysET(now, Math.max(1, Math.round(a.dueDays * 5 / 7)), 17) } });
      opened++;
    } else if (cur.status === "COMPLETED" && cur.completedAt && now.getTime() - cur.completedAt.getTime() > 86_400_000) {
      // Marked done, but a day later the audit still sees it.
      await prisma.smartTask.update({ where: { id: cur.id }, data: { ...data, status: "OPEN", completedAt: null, dueAt: endOfBusinessDaysET(now, 2, 17), summary: "Marked done, but the books audit still sees this. The amounts and the details are on Finance → Audit." } });
      reopened++;
    } else if (!CLOSED.includes(cur.status)) {
      await prisma.smartTask.update({ where: { id: cur.id }, data: { title: data.title, description: data.description } });
    }
  }
  for (const t of existing) {
    if (live.has(t.dedupeKey!) || CLOSED.includes(t.status)) continue;
    await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: now, summary: "Closed by the books audit: it no longer sees this problem." } });
    closed++;
  }
  const open = await prisma.smartTask.count({ where: { dedupeKey: { startsWith: PREFIX }, status: { notIn: CLOSED } } });
  return { opened, reopened, closed, open };
}

/** The daily run: audit, then keep the tasks in step. */
export async function runBooksAudit(now: Date = new Date()) {
  const { financeAuditYtd } = await import("@/lib/financeAudit");
  const audit = await financeAuditYtd(now);
  const tasks = await syncAuditTasks(audit.actions, now);
  return { checks: audit.checks.length, gaps: audit.checks.filter((c) => c.status !== "ok").length, ...tasks };
}

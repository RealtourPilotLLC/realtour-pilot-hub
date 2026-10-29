import "server-only";
import { prisma } from "@/lib/prisma";
import { etDate, etDayKey, etDayStartUtc } from "@/lib/datetime";
import { getSetting } from "@/lib/settings";
import { DISMISSED_PREFIX } from "@/lib/triage";
import { PUSH_ACTION } from "@/lib/taskAging";
import {
  classifyPastShootTask, clearedReason, shootIsPast, streetKeys, streetMentions, streetOfTitle,
  type PastShootJob, type PastShootVerdict,
} from "@/lib/pastShootTasksCore";

// ---------------------------------------------------------------------------
// TO-DOS THAT OUTLIVED THEIR SHOOT: the reads, the close and the undo (Oct 29
// 2026, Jordan on 6344 Reedland St). The decision is lib/pastShootTasksCore;
// this file finds each open task's job (its projectId, else the street in its
// words, same client), what a person did to it, and the other streets it
// carries, then closes the ones the rule clears.
//
// OFF until Jordan says go: the daily cron runs it as a dry run and logs the
// count while `tasks:past_shoot_sweep` is { on: false } (the default). The
// list itself comes from scripts/_live/oct29-past-shoot-tasks.ts.
// ---------------------------------------------------------------------------

export const SWEEP_SWITCH_KEY = "tasks:past_shoot_sweep";
/** AuditLog actions this sweep writes. */
export const CLEAR_ACTION = "task_past_shoot_cleared";
export const CLEAR_UNDO_ACTION = "task_past_shoot_restored";
/** How a cleared row's summary begins (the dismissal vocabulary: Done files it under Dismissed). */
export const CLEARED_STAMP = `${DISMISSED_PREFIX}the hub — cleared:`;

const CLOSED = ["COMPLETED", "CANCELLED"];
const WAITING_PREFIX = "office_waiting:"; // lib/officeDesk: a person's "waiting on" note
/** Actors that are the hub itself, never a person's judgement. */
const SYSTEM_ACTOR = /^(system|cron|hub|claude|auto|webhook|listener|sweep)\b/i;

export type PastShootRow = {
  id: string;
  title: string;
  taskType: string;
  source: string;
  personKey: string | null;
  createdISO: string;
  link: "id" | "address";
  projectId: string;
  street: string;
  jobStatus: string;
  shootISO: string;
  deliveredISO: string | null;
  verdict: PastShootVerdict;
};

type Job = PastShootJob & { id: string; clientId: string | null };

/** Every open task whose job's shoot is past, each with the rule's verdict. Reads only. */
export async function findPastShootTasks(now: Date = new Date()): Promise<PastShootRow[]> {
  const todayKey = etDayKey(now);
  const tasks = await prisma.smartTask.findMany({
    where: { status: { notIn: CLOSED } },
    select: {
      id: true, title: true, summary: true, description: true, status: true, taskType: true, source: true, reasonCreated: true,
      createdAt: true, delegatedBy: true, flaggedBy: true, flaggedAt: true, assignedManually: true, assignedKey: true,
      projectId: true, clientId: true, propertyAddress: true,
    },
    take: 2000,
  });
  if (!tasks.length) return [];
  const jobs: Job[] = await prisma.project.findMany({ select: { id: true, title: true, status: true, shootDate: true, deliveredAt: true, clientId: true } });
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const byKey = new Map<string, Job[]>();
  for (const j of jobs) for (const k of streetKeys(streetOfTitle(j.title))) byKey.set(k, [...(byKey.get(k) ?? []), j]);
  const sameClient = (clientId: string | null) => (j: Job) => !clientId || !j.clientId || j.clientId === clientId;

  // The job a task is about: its own projectId, else the street in its words. Of
  // several jobs at that street, the one shot nearest after the task was written.
  const linked: { t: (typeof tasks)[number]; job: Job; link: "id" | "address" }[] = [];
  for (const t of tasks) {
    const own = t.projectId ? byId.get(t.projectId) ?? null : null;
    if (own) { linked.push({ t, job: own, link: "id" }); continue; }
    if (t.projectId) continue;
    const cands = streetKeys(`${t.title}\n${t.propertyAddress ?? ""}`).flatMap((k) => byKey.get(k) ?? []).filter(sameClient(t.clientId));
    if (!cands.length) continue;
    const from = t.createdAt.getTime() - 86_400_000;
    const after = cands.filter((j) => j.shootDate && j.shootDate.getTime() >= from).sort((a, b) => a.shootDate!.getTime() - b.shootDate!.getTime());
    const job = after[0] ?? cands.sort((a, b) => (b.shootDate?.getTime() ?? 0) - (a.shootDate?.getTime() ?? 0))[0];
    linked.push({ t, job, link: "address" });
  }
  const past = linked.filter((l) => shootIsPast(l.job, l.job.shootDate ? etDayKey(l.job.shootDate) : null, todayKey));
  if (!past.length) return [];

  const ids = past.map((p) => p.t.id);
  const [logs, waiting] = await Promise.all([
    prisma.auditLog.findMany({ where: { target: { in: ids } }, select: { target: true, actor: true, action: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
    prisma.appSetting.findMany({ where: { key: { in: ids.map((id) => `${WAITING_PREFIX}${id}`) } }, select: { key: true } }),
  ]);
  const waitingIds = new Set(waiting.map((w) => w.key.slice(WAITING_PREFIX.length)));

  return past.map(({ t, job, link }) => {
    const shootKey = etDayKey(job.shootDate!);
    const dayStart = etDayStartUtc(job.shootDate!);
    const person = logs.find((l) => l.target === t.id && l.createdAt >= dayStart && !SYSTEM_ACTOR.test(l.actor ?? ""));
    const touchedAfterShoot = waitingIds.has(t.id)
      ? "a person marked it waiting on someone"
      : person
        ? `${(person.actor ?? "a person").split("@")[0]} ${person.action === PUSH_ACTION ? "gave it a new date" : "updated it"} on ${etDate(person.createdAt)}`
        : null;
    const ownKeys = new Set(streetKeys(streetOfTitle(job.title)));
    const others = streetMentions(`${t.title}\n${t.summary ?? ""}\n${t.description ?? ""}`)
      .filter((m) => !ownKeys.has(m.key))
      .map((m) => {
        const js = (byKey.get(m.key) ?? []).filter(sameClient(t.clientId)).sort((a, b) => (b.shootDate?.getTime() ?? 0) - (a.shootDate?.getTime() ?? 0));
        const o = js[0] ?? null; // the latest shoot at that street: an upcoming one keeps the task
        return { street: o ? streetOfTitle(o.title) : m.text, job: o, shootKey: o?.shootDate ? etDayKey(o.shootDate) : null };
      });
    const verdict = classifyPastShootTask({
      task: t, job, touchedAfterShoot, others, todayKey, shootKey,
      createdKey: etDayKey(t.createdAt), deliveredKey: job.deliveredAt ? etDayKey(job.deliveredAt) : null,
    });
    return {
      id: t.id, title: t.title, taskType: t.taskType, source: t.source,
      personKey: t.assignedKey ?? null,
      createdISO: t.createdAt.toISOString(), link, projectId: job.id, street: streetOfTitle(job.title), jobStatus: job.status,
      shootISO: job.shootDate!.toISOString(), deliveredISO: job.deliveredAt?.toISOString() ?? null, verdict,
    };
  });
}

const dayWords = (iso: string) => etDate(iso).replace(/^\w+, /, "");

/** The stamp a cleared row carries. */
export function clearedStamp(r: Pick<PastShootRow, "street" | "shootISO" | "deliveredISO">): string {
  return `${DISMISSED_PREFIX}the hub — ${clearedReason(r.street, dayWords(r.shootISO), r.deliveredISO ? dayWords(r.deliveredISO) : null)}.`;
}

/** Close what the rule clears (apply), or only list it. */
export async function clearPastShootTasks(now: Date, opts: { apply: boolean; actor?: string }): Promise<{ rows: PastShootRow[]; clear: PastShootRow[]; closed: number }> {
  const rows = await findPastShootTasks(now);
  const clear = rows.filter((r) => r.verdict.clear);
  if (!opts.apply) return { rows, clear, closed: 0 };
  let closed = 0;
  for (const c of clear) {
    const before = await prisma.smartTask.findUnique({ where: { id: c.id }, select: { status: true, summary: true } });
    if (!before || before.status !== "OPEN") continue;
    const stamp = clearedStamp(c);
    const summary = (before.summary ? `${stamp}\n${before.summary}` : stamp).slice(0, 500);
    closed += await prisma.$transaction(async (tx) => {
      const u = await tx.smartTask.updateMany({ where: { id: c.id, status: "OPEN" }, data: { status: "CANCELLED", completedAt: null, summary } });
      if (u.count !== 1) return 0;
      await tx.auditLog.create({
        data: {
          actor: opts.actor ?? "system",
          action: CLEAR_ACTION,
          target: c.id,
          detail: JSON.stringify({ rule: c.verdict.clear ? c.verdict.rule : null, why: c.verdict.why, fromStatus: before.status, summaryBefore: before.summary, projectId: c.projectId, link: c.link, shootDate: c.shootISO, deliveredAt: c.deliveredISO, title: c.title }),
        },
      });
      return 1;
    });
  }
  return { rows, clear, closed };
}

/** Put cleared rows back exactly as they were: only rows still cancelled and still carrying the stamp. */
export async function undoPastShootTasks(opts: { since?: Date; ids?: string[]; apply: boolean; actor?: string }): Promise<{ eligible: { id: string; title: string }[]; reopened: number }> {
  const logs = await prisma.auditLog.findMany({
    where: { action: CLEAR_ACTION, ...(opts.since ? { createdAt: { gte: opts.since } } : {}), ...(opts.ids?.length ? { target: { in: opts.ids } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const seen = new Set<string>();
  const eligible: { id: string; title: string; fromStatus: string; summaryBefore: string | null }[] = [];
  for (const l of logs) {
    if (seen.has(l.target)) continue;
    seen.add(l.target);
    let d: { fromStatus?: string; summaryBefore?: string | null };
    try { d = JSON.parse(l.detail); } catch { continue; }
    const t = await prisma.smartTask.findUnique({ where: { id: l.target }, select: { status: true, summary: true, title: true } });
    if (!t || t.status !== "CANCELLED" || !(t.summary ?? "").startsWith(CLEARED_STAMP)) continue;
    eligible.push({ id: l.target, title: t.title, fromStatus: d.fromStatus ?? "OPEN", summaryBefore: d.summaryBefore ?? null });
  }
  if (!opts.apply) return { eligible: eligible.map(({ id, title }) => ({ id, title })), reopened: 0 };
  let reopened = 0;
  for (const e of eligible) {
    reopened += await prisma.$transaction(async (tx) => {
      const u = await tx.smartTask.updateMany({ where: { id: e.id, status: "CANCELLED" }, data: { status: e.fromStatus, summary: e.summaryBefore } });
      if (u.count !== 1) return 0;
      await tx.auditLog.create({ data: { actor: opts.actor ?? "system", action: CLEAR_UNDO_ACTION, target: e.id, detail: JSON.stringify({ restoredStatus: e.fromStatus }) } });
      return 1;
    });
  }
  return { eligible: eligible.map(({ id, title }) => ({ id, title })), reopened };
}

/** Is the sweep switched on? Off (the default) means the cron only counts. */
export async function pastShootSweepOn(): Promise<boolean> {
  return (await getSetting<{ on: boolean }>(SWEEP_SWITCH_KEY, { on: false })).on === true;
}

/** The daily cron's step: clears when switched on, else counts what it would clear. */
export async function runPastShootSweep(now: Date = new Date(), opts: { actor?: string } = {}): Promise<{ on: boolean; wouldClear: number; closed: number }> {
  const on = await pastShootSweepOn();
  const r = await clearPastShootTasks(now, { apply: on, actor: opts.actor ?? "cron:daily" });
  return { on, wouldClear: r.clear.length, closed: r.closed };
}

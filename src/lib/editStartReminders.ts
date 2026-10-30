import "server-only";
import { prisma } from "@/lib/prisma";
import { buildEditorQueue, STATUS_LABEL } from "@/lib/editorQueue";
import { toDeskJobs } from "@/lib/editorDesk";
import { editorMeta, DEFAULT_EDITOR_TZ, videoEditorKeys } from "@/lib/editors";
import { appBase } from "@/lib/appUrl";
import { etDayKey, etHour } from "@/lib/datetime";
import { dueWordsFor, titleWithDue } from "@/lib/editorDue";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { escapeSlack } from "@/lib/text";

// ---------------------------------------------------------------------------
// PRESS START, A REMINDER (Jordan, Oct 29 2026: "when Kim doesn't press start
// on a video, can we auto-remind him to press start?").
//
// WHICH JOBS: the editor's own desk list (editorDesk.toDeskJobs over the
// Editing Room's rows, so the desk, the queue and this agree): footage in,
// handed to them, not held by the office, a video still theirs to edit, and
// no Start of theirs open on it (active or paused). Revisions are left to the
// revision reminder (lib/revisionReminders), which already pings them daily.
// WHEN: the job is late, or due within REMIND_DUE_WITHIN_HOURS, or its
// footage has been ready REMIND_READY_FOR_HOURS with no Start. Thresholds from
// the live data on Oct 29 2026 (45 days): Jhon Mark's median from handoff to
// his first Start was 86 h and Kim's 222 h, and 41 of 167 versions were sent
// with no Start at all, so "ready four days" catches the forgotten ones
// without pinging the day a job lands.
// HOURS: weekdays, 9 AM to 6 PM Eastern: the hours Kim and Jhon Mark actually
// press Start and send (Manila nights). The staff bridge still holds anything
// inside a quiet time saved on their card.
// HOW OFTEN: once per job per Eastern day (the bell row's dedupeKey is the
// ledger), however many hourly runs there are.
// To the editor only (their bell and their "Job pings" Slack or text). Never
// a client. It changes nothing: Start is still theirs to press.
// ---------------------------------------------------------------------------

/** The editors reminded: every current in-house video editor (Kim, Jhon Mark
 *  and anyone onboarded on People since Oct 30 2026), read when the run starts. */
export const startRemindEditors = (): string[] => videoEditorKeys();
export const REMIND_DUE_WITHIN_HOURS = 48;
export const REMIND_READY_FOR_HOURS = 96;
export const REMIND_WINDOW_ET = { fromHour: 9, toHour: 18 } as const;

const HOUR = 3_600_000;

export type StartReminderJob = {
  editorKey: string;
  projectId: string;
  street: string;
  dueISO: string | null;
  late: boolean;
  /** when the footage and instructions were ready for the editor */
  readyISO: string | null;
  /** they have a Start open on it (active or paused) */
  working: boolean;
  startable: boolean;
};

export type StartReminderReason = "late" | "due_soon" | "waiting";

/** Why this job gets a reminder now, or null. Pure. */
export function startReminderReason(j: StartReminderJob, now: Date): StartReminderReason | null {
  if (j.working || !j.startable) return null;
  if (j.late) return "late";
  if (j.dueISO && Date.parse(j.dueISO) - now.getTime() <= REMIND_DUE_WITHIN_HOURS * HOUR) return "due_soon";
  if (j.readyISO && now.getTime() - Date.parse(j.readyISO) >= REMIND_READY_FOR_HOURS * HOUR) return "waiting";
  return null;
}

/** Weekdays, 9 AM to 6 PM Eastern. Pure. */
export function inStartReminderWindow(now: Date): boolean {
  const dow = new Date(`${etDayKey(now)}T12:00:00Z`).getUTCDay();
  const h = etHour(now);
  return dow >= 1 && dow <= 5 && h >= REMIND_WINDOW_ET.fromHour && h < REMIND_WINDOW_ET.toHour;
}

/** The line the editor reads. Pure. */
export function startReminderLine(j: Pick<StartReminderJob, "street" | "dueISO" | "late" | "readyISO">, reason: StartReminderReason, tz: string, now: Date): string {
  const due = j.dueISO ? dueWordsFor(new Date(j.dueISO), tz) : null;
  const days = j.readyISO ? Math.floor((now.getTime() - Date.parse(j.readyISO)) / (24 * HOUR)) : null;
  const why =
    reason === "late" ? `It is late${due ? ` (${due})` : ""}`
    : reason === "due_soon" ? `It is ${due ?? "due soon"}`
    : `The footage has been ready ${days} days`;
  return `Press Start on ${j.street} when you begin. ${why}, and nobody has pressed Start on it. The brief opens when you press Start.`;
}

/** Every job on Kim's and Jhon Mark's desks, with what the reminder needs. Read-only. */
export async function startReminderJobs(): Promise<StartReminderJob[]> {
  const excludeClientIds = await syntheticClientIds();
  const { notDone } = await buildEditorQueue({ excludeClientIds });
  const out: StartReminderJob[] = [];
  for (const key of startRemindEditors()) {
    const rows = notDone.filter((r) => r.editorKey === key && r.status !== STATUS_LABEL.REVISION);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const j of toDeskJobs(rows, key, [])) {
      const r = byId.get(j.projectId);
      if (!r) continue;
      const working = r.work.active.some((p) => p.key === key) || r.work.paused.some((p) => p.key === key);
      out.push({ editorKey: key, projectId: j.projectId, street: j.street, dueISO: j.dueISO, late: j.late, readyISO: null, working, startable: j.startable });
    }
  }
  if (out.length) {
    const ready = await prisma.project.findMany({
      where: { id: { in: [...new Set(out.map((j) => j.projectId))] } },
      select: { id: true, handoffReadyAt: true, videoHandoffAt: true },
    });
    const at = new Map(ready.map((p) => [p.id, (p.handoffReadyAt ?? p.videoHandoffAt)?.toISOString() ?? null]));
    for (const j of out) j.readyISO = at.get(j.projectId) ?? null;
  }
  return out;
}

export type StartReminderRun = { window: boolean; jobs: number; due: number; sent: number; already: number; failed: string[]; dryRun?: { editorKey: string; street: string; reason: StartReminderReason; line: string }[] };

/** The hourly step (cron/reconcile "startReminders"). `dryRun` sends nothing and lists what it would. */
export async function sweepStartReminders(opts: { now?: Date; dryRun?: boolean } = {}): Promise<StartReminderRun> {
  const now = opts.now ?? new Date();
  const window = inStartReminderWindow(now);
  const run: StartReminderRun = { window, jobs: 0, due: 0, sent: 0, already: 0, failed: [] };
  if (!window && !opts.dryRun) return run;
  const jobs = await startReminderJobs();
  run.jobs = jobs.length;
  const due = jobs.map((j) => ({ j, reason: startReminderReason(j, now) })).filter((x): x is { j: StartReminderJob; reason: StartReminderReason } => !!x.reason);
  run.due = due.length;
  if (opts.dryRun) {
    run.dryRun = due.map(({ j, reason }) => ({ editorKey: j.editorKey, street: j.street, reason, line: startReminderLine(j, reason, editorMeta(j.editorKey)?.tz ?? DEFAULT_EDITOR_TZ, now) }));
    return run;
  }
  const { notifyInApp } = await import("@/lib/notify");
  const base = appBase();
  const day = etDayKey(now);
  for (const { j, reason } of due) {
    const tz = editorMeta(j.editorKey)?.tz ?? DEFAULT_EDITOR_TZ;
    const href = `/edit/${j.projectId}`;
    const line = startReminderLine(j, reason, tz, now);
    try {
      const res = await notifyInApp({
        kind: "edit_start_reminder",
        title: titleWithDue(`Press Start: ${j.street}`, j.dueISO ? new Date(j.dueISO) : null, tz),
        body: line,
        href,
        targets: [{ roles: ["EDITOR"], userKey: `editor:${j.editorKey}`, href, slackDm: `${escapeSlack(line)} ${base}${href}` }],
        dedupeKey: `edit-start:${j.editorKey}:${j.projectId}:${day}`,
      });
      if (res.bridged.length) run.sent++;
      else run.already++;
    } catch (e) {
      run.failed.push(`${j.street}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  return run;
}

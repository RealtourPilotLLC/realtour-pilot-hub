// ---------------------------------------------------------------------------
// WHO GETS THE NEXT EDIT WHEN SEVERAL EDITORS ARE TICKED FOR A LANE (Jordan,
// Oct 30 2026: "edits get assigned based on current workload, turnaround
// times, etc.").
//
// The question is one number per editor: if this job went to them now, about
// how many working days until they would be through it? That is
//
//     (videos they already owe + this one) ÷ the videos a day they finish
//
// and the editor with the smallest answer gets it. Both inputs are measured,
// never typed in:
//
//   · owed — the unapproved videos on jobs whose open edit card is theirs
//     (a video waiting on a verdict in the Review Room is the office's move,
//     not theirs, and is left out), plus each open video revision of theirs on
//     a job they have no edit card for.
//   · pace — the videos of theirs approved over the last four weeks, per
//     weekday since their first one in that window. Fewer than MIN_SAMPLE
//     approvals (a new editor like Reychelle) and their pace is the team's
//     median instead, and the reason says so: never an invented speed.
//
// Someone marked out right now (Capacity: time off, training, blocked) is
// passed over while anyone ticked is in. Ties go to who owes fewer, then to
// the order they are listed. The pure fold (rankPool) is what a drill pins;
// balanceFacts is the read.
// ---------------------------------------------------------------------------

export type BalanceFacts = {
  key: string;
  name: string;
  /** videos owed right now */
  owed: number;
  /** approved videos in the sample window */
  approved: number;
  /** weekdays the approvals were counted over */
  weekdays: number;
  /** "Time off until Fri 5:00 PM" when marked out now; null = in */
  out: string | null;
};

export type BalanceRow = BalanceFacts & {
  /** videos a day used for the estimate */
  pace: number;
  /** true when `pace` is the team's, because they have too few of their own */
  paceAssumed: boolean;
  /** working days until they would be through this job too */
  daysToClear: number;
};

export const MIN_SAMPLE = 4;
/** Pace when nobody on the team has enough history either. */
export const FALLBACK_PACE = 1;
export const SAMPLE_DAYS = 28;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function paceWords(r: Pick<BalanceRow, "pace" | "paceAssumed">): string {
  return r.paceAssumed ? `the team's pace (${round1(r.pace)} a day; not enough of their own yet)` : `${round1(r.pace)} a day`;
}

/** Pure: rank the ticked editors and say why the first one won. */
export function rankPool(pool: string[], facts: Map<string, BalanceFacts>): { pick: string | null; rows: BalanceRow[]; why: string } {
  const own = (f: BalanceFacts) => (f.approved >= MIN_SAMPLE && f.weekdays > 0 ? f.approved / f.weekdays : null);
  const measured = pool.map((k) => facts.get(k)).filter((f): f is BalanceFacts => !!f).map(own).filter((p): p is number => p != null).sort((a, b) => a - b);
  const teamPace = measured.length ? measured[Math.floor(measured.length / 2)] : FALLBACK_PACE;
  const rows: BalanceRow[] = pool.map((key) => {
    const f = facts.get(key) ?? { key, name: key, owed: 0, approved: 0, weekdays: 0, out: null };
    const mine = own(f);
    const pace = Math.max(0.1, mine ?? teamPace);
    return { ...f, pace, paceAssumed: mine == null, daysToClear: (f.owed + 1) / pace };
  });
  const order = (a: BalanceRow, b: BalanceRow) =>
    a.daysToClear - b.daysToClear || a.owed - b.owed || pool.indexOf(a.key) - pool.indexOf(b.key);
  const inNow = rows.filter((r) => !r.out).sort(order);
  const ranked = inNow.length ? [...inNow, ...rows.filter((r) => r.out).sort(order)] : [...rows].sort(order);
  const first = ranked[0];
  if (!first) return { pick: null, rows: [], why: "Nobody is ticked for this lane, so new work waits in Needs assigning." };
  if (ranked.length === 1) return { pick: first.key, rows: ranked, why: `${first.name} is the only editor ticked for this lane.` };
  const line = (r: BalanceRow) =>
    `${r.name} owes ${r.owed} video${r.owed === 1 ? "" : "s"} at ${paceWords(r)}${r.out ? `, out: ${r.out}` : ""}, so about ${round1(r.daysToClear)} working day${round1(r.daysToClear) === 1 ? "" : "s"} to clear one more`;
  const why =
    `${first.name} gets it: ${line(first)}. ` +
    ranked.slice(1).map((r) => `${line(r)}.`).join(" ") +
    (!inNow.length ? " Everyone ticked is marked out, so it went by workload anyway." : "");
  return { pick: first.key, rows: ranked, why };
}

/** Weekdays (Mon to Fri) from `from` to `to`, at least 1. */
export function weekdaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.max(1, n);
}

const OPEN = { notIn: ["COMPLETED", "CANCELLED"] };

/** The read behind rankPool, for these editor keys. */
export async function balanceFacts(keys: string[], now: Date = new Date()): Promise<Map<string, BalanceFacts>> {
  const { prisma } = await import("@/lib/prisma");
  const { editorMeta, editorTeamMemberId } = await import("@/lib/editors");
  const out = new Map<string, BalanceFacts>();
  const ks = [...new Set(keys.filter(Boolean))];
  if (!ks.length) return out;
  for (const k of ks) out.set(k, { key: k, name: editorMeta(k)?.name ?? k, owed: 0, approved: 0, weekdays: 0, out: null });

  // OWED: their open edit cards' unapproved videos, minus what is in review.
  const [cards, revisions] = await Promise.all([
    prisma.smartTask.findMany({ where: { taskType: "edit_video", status: OPEN, assignedKey: { in: ks }, projectId: { not: null } }, select: { assignedKey: true, projectId: true } }),
    prisma.smartTask.findMany({ where: { taskType: "revision", status: OPEN, assignedKey: { in: ks }, projectId: { not: null } }, select: { assignedKey: true, projectId: true } }),
  ]);
  const projectIds = [...new Set(cards.map((c) => c.projectId as string))];
  const outputs = projectIds.length
    ? await prisma.deliverableOutput.findMany({
        where: {
          projectId: { in: projectIds },
          approvedSubmissionId: null, removedFromOrderAt: null, waivedAt: null, deliveredAt: null,
          deliverable: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null },
        },
        select: { projectId: true, currentSubmissionId: true },
      })
    : [];
  const currentIds = outputs.map((o) => o.currentSubmissionId).filter((id): id is string => !!id);
  const inReview = new Set(
    currentIds.length
      ? (await prisma.reviewSubmission.findMany({ where: { id: { in: currentIds }, status: "PENDING" }, select: { id: true } })).map((s) => s.id)
      : [],
  );
  const owedOn = new Map<string, number>();
  const anyOutput = new Set<string>();
  for (const o of outputs) {
    anyOutput.add(o.projectId);
    if (o.currentSubmissionId && inReview.has(o.currentSubmissionId)) continue;
    owedOn.set(o.projectId, (owedOn.get(o.projectId) ?? 0) + 1);
  }
  const carded = new Set<string>();
  for (const c of cards) {
    const f = out.get(c.assignedKey as string);
    if (!f) continue;
    const pid = c.projectId as string;
    carded.add(`${c.assignedKey}|${pid}`);
    // A job with no video rows on record still owes one video.
    f.owed += anyOutput.has(pid) ? owedOn.get(pid) ?? 0 : 1;
  }
  for (const r of revisions) {
    const f = out.get(r.assignedKey as string);
    if (f && !carded.has(`${r.assignedKey}|${r.projectId}`)) f.owed += 1;
  }

  // PACE: approved videos of theirs in the window, over the weekdays since
  // their first one in it.
  const since = new Date(now.getTime() - SAMPLE_DAYS * 86_400_000);
  const approved = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", decidedAt: { gte: since, lte: now }, submittedByKey: { in: ks } },
    select: { submittedByKey: true, decidedAt: true },
  });
  const firstAt = new Map<string, Date>();
  for (const a of approved) {
    const f = out.get(a.submittedByKey as string);
    if (!f || !a.decidedAt) continue;
    f.approved++;
    const was = firstAt.get(f.key);
    if (!was || a.decidedAt < was) firstAt.set(f.key, a.decidedAt);
  }
  for (const [k, at] of firstAt) {
    const f = out.get(k);
    if (f) f.weekdays = Math.max(5, weekdaysBetween(at, now));
  }

  // OUT NOW: a Capacity entry in force.
  try {
    const { capacityWindows } = await import("@/lib/capacity");
    const ids = await Promise.all(ks.map(async (k) => [k, await editorTeamMemberId(k)] as const));
    const windows = await capacityWindows(ids.map(([, id]) => id).filter((id): id is string => !!id), now);
    for (const [k, id] of ids) {
      const chip = id ? windows.get(id)?.now[0] : undefined;
      const f = out.get(k);
      if (f && chip) f.out = `${chip.label} ${chip.when}`;
    }
  } catch { /* capacity is advisory; nobody is treated as out when it can't be read */ }
  return out;
}

import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { pinnedPromise } from "@/lib/turnaround";
import { parseEvidence } from "@/lib/statusEvidence";
import { noDashes, scrubMoney } from "@/lib/text";
import { withSecondShoot } from "@/lib/secondShootCore";
import {
  MISS_CAUSE_WORDS,
  MILESTONE_WORDS,
  clientExpected,
  evaluateVideo,
  isMissCause,
  programMilestones,
  staffWhen,
  suggestMissCause,
  watchWhy,
  STAGE_STAFF_WORDS,
  type ClientExpected,
  type Evaluation,
  type Milestone,
  type MissCause,
  type VideoFacts,
} from "@/lib/programWatchCore";

// ---------------------------------------------------------------------------
// PROGRAM VIDEOS, WATCHED BEFORE THE PROMISE (Oct 15 2026). The server half of
// programWatchCore.ts (read that header for the milestones and why).
//
//   · programVideos       every owed program video with its promise, what the
//                         hub can prove about it, its milestones, where it
//                         stands, the cause the hub suggests and the one a
//                         person recorded. A database read; nothing here
//                         calls a provider.
//   · sweepProgramWatch   rides the promise watch (cron/gmail, every 5 min).
//                         A video that has just missed a milestone, or just
//                         passed its promise, is told to Kyle ONCE (bell + his
//                         Slack DM, one message per month's job) and a client
//                         update is DRAFTED on his list, never sent. A miss
//                         older than FRESH_HOURS when first seen (the backlog
//                         on the day this ships) is listed on the tracker, not
//                         pinged.
//   · recordMissCause     the office's call on why a late video was late.
//   · portalExpectedFor   what the client's portal says about a video in
//                         production: its stage and "expected by", or the moved
//                         date with a plain reason (switch, default OFF).
//
// THE SWITCHES (AppSetting "program_watch", owner/office on /pipeline):
//   alerts            Kyle's DM + the drafted update. Staff only, so ON, the
//                     house rule for staff messages (settings.ts
//                     InternalAlertRules). The promise watch's own switch
//                     (Delivery watch) must be on too.
//   chaseEscalation   lib/chaseCounter: tasks and bells only. ON.
//   portalExpectedBy  dates in front of clients. OFF until someone has looked.
//   libraryRepoint    lib/portalLibrary's nightly re-point of a library row to
//                     its re-edit. OFF = reported only.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A miss first seen later than this after it happened is listed, not pinged. */
export const FRESH_HOURS = 48;
/** How far back the watch looks at a program job's shoot. */
const SHOOT_LOOKBACK_DAYS = 75;
const NOT_A_ROUND = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];
const CLAIM_PREFIX = "program-watch:";
export const PROGRAM_WATCH_REASON = "Program watch: a video missed a milestone";

// ---- switches ---------------------------------------------------------------

export type ProgramWatchRules = {
  /** Kyle's DM + a drafted client update when a program video misses a milestone. */
  alerts: boolean;
  /** A HIGH task for Kyle on a client's 2nd "any update?" in 14 days; the owner's bell on the 3rd. */
  chaseEscalation: boolean;
  /** The client's portal shows each video's stage and "expected by". */
  portalExpectedBy: boolean;
  /** The nightly library check may re-point a library row to its re-edit (V2). Off = reported only. */
  libraryRepoint: boolean;
};
export const PROGRAM_WATCH_KEY = "program_watch";
export const DEFAULT_PROGRAM_WATCH: ProgramWatchRules = { alerts: true, chaseEscalation: true, portalExpectedBy: false, libraryRepoint: false };

export async function programWatchRules(): Promise<ProgramWatchRules> {
  const r = await getSetting<Partial<ProgramWatchRules>>(PROGRAM_WATCH_KEY, DEFAULT_PROGRAM_WATCH);
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    alerts: b(r.alerts, DEFAULT_PROGRAM_WATCH.alerts),
    chaseEscalation: b(r.chaseEscalation, DEFAULT_PROGRAM_WATCH.chaseEscalation),
    portalExpectedBy: b(r.portalExpectedBy, DEFAULT_PROGRAM_WATCH.portalExpectedBy),
    libraryRepoint: b(r.libraryRepoint, DEFAULT_PROGRAM_WATCH.libraryRepoint),
  };
}

export async function saveProgramWatchRules(next: Partial<ProgramWatchRules>, by: string | null): Promise<ProgramWatchRules> {
  const cur = await programWatchRules();
  const merged: ProgramWatchRules = { ...cur };
  for (const k of Object.keys(DEFAULT_PROGRAM_WATCH) as (keyof ProgramWatchRules)[]) {
    if (typeof next[k] === "boolean") merged[k] = next[k] as boolean;
  }
  await putSetting(PROGRAM_WATCH_KEY, merged, by);
  return merged;
}

// ---- the recorded cause (raw SQL until the client is regenerated) --------------
//
// DeliverableOutput.missCause/missNote/missBy/missAt are new columns. They are
// read and written with raw SQL so this file works the moment `db push` adds
// them, whatever Prisma client is deployed, and a database WITHOUT them yet
// reads as "nothing recorded" instead of failing the screen.

export type RecordedCause = { cause: MissCause | null; note: string | null; by: string | null; at: Date | null };

export async function readMissCauses(outputIds: string[]): Promise<{ available: boolean; map: Map<string, RecordedCause> }> {
  const map = new Map<string, RecordedCause>();
  const ids = [...new Set(outputIds.filter(Boolean))];
  if (ids.length === 0) return { available: true, map };
  try {
    const rows = await prisma.$queryRaw<{ id: string; missCause: string | null; missNote: string | null; missBy: string | null; missAt: Date | null }[]>(
      Prisma.sql`SELECT "id", "missCause", "missNote", "missBy", "missAt" FROM "DeliverableOutput" WHERE "id" IN (${Prisma.join(ids)})`,
    );
    for (const r of rows) {
      if (!r.missCause && !r.missNote) continue;
      map.set(r.id, { cause: isMissCause(r.missCause) ? r.missCause : null, note: r.missNote, by: r.missBy, at: r.missAt ? new Date(r.missAt) : null });
    }
    return { available: true, map };
  } catch {
    return { available: false, map };
  }
}

export type RecordCauseResult = { ok: true; message: string } | { ok: false; message: string };

/** The office's call on why a late video was late. `cause: null` clears it. */
export async function recordMissCause(input: { outputId: string; cause: string | null; note?: string | null; by: string }): Promise<RecordCauseResult> {
  const cause = input.cause === null || input.cause === "" ? null : input.cause;
  if (cause !== null && !isMissCause(cause)) return { ok: false, message: "Pick one of the causes on the list." };
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  const by = input.by.trim().slice(0, 120) || "the office";
  const out = await prisma.deliverableOutput.findUnique({ where: { id: input.outputId }, select: { id: true, projectId: true, slot: true, title: true } });
  if (!out) return { ok: false, message: "That video is no longer on the job." };
  try {
    const at = cause || note ? new Date() : null;
    await prisma.$executeRaw(
      Prisma.sql`UPDATE "DeliverableOutput" SET "missCause" = ${cause}, "missNote" = ${note}, "missBy" = ${cause || note ? by : null}, "missAt" = ${at} WHERE "id" = ${out.id}`,
    );
  } catch {
    return { ok: false, message: "The cause can't be saved until tonight's database update lands. Nothing was changed." };
  }
  const label = out.title?.trim() || `video ${out.slot}`;
  await prisma.activity
    .create({
      data: {
        projectId: out.projectId,
        type: "SYSTEM",
        body: (cause ? `${by} recorded why "${label}" was late: ${MISS_CAUSE_WORDS[cause].label}${note ? `. ${note}` : ""}` : `${by} cleared the late cause on "${label}"`).slice(0, 300),
      },
    })
    .catch(() => {});
  return { ok: true, message: cause ? `Saved: ${MISS_CAUSE_WORDS[cause].label}.` : "Cleared." };
}

// ---- the read ----------------------------------------------------------------

export type ProgramVideoRow = {
  outputId: string;
  projectId: string;
  deliverableId: string;
  slot: number;
  clientId: string;
  clientName: string;
  enrollmentId: string | null;
  monthId: string;
  monthKey: string | null;
  /** "October 2026" */
  monthWords: string;
  /** the client's library row for this video, when one exists */
  videoId: string | null;
  title: string;
  /** effective promise: the video's own, else the job's (office date, pin, computed) */
  promisedAt: Date | null;
  /** the promise before the office moved it, when it was moved */
  originalPromiseAt: Date | null;
  milestones: Milestone[];
  facts: VideoFacts;
  /** null when there is no promise yet or the video has not been filmed */
  evaluation: Evaluation | null;
  suggestion: { cause: MissCause; why: string } | null;
  recorded: RecordedCause | null;
  /** the client asked for changes on the released cut: that round's due date */
  changes: { dueAt: Date | null } | null;
  /** one line for the office */
  why: string;
};

const monthWordsOf = (key: string | null) => {
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return "this month";
  return new Date(`${key}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

const minDate = (...ds: (Date | null | undefined)[]): Date | null => {
  let best: Date | null = null;
  for (const d of ds) if (d && !isNaN(d.getTime()) && (!best || d < best)) best = d;
  return best;
};

type Scope = { projectIds?: string[]; outputIds?: string[]; clientId?: string };

/**
 * Every owed program video in scope, read in a fixed set of queries. With no
 * scope: every live program job (not cancelled, not on hold, not lost by
 * Aryeo) shot in the last SHOOT_LOOKBACK_DAYS or not dated yet.
 */
export async function programVideos(opts: Scope & { now?: Date } = {}): Promise<ProgramVideoRow[]> {
  const now = opts.now ?? new Date();
  let projectIds = opts.projectIds;
  if (opts.outputIds?.length) {
    const outs = await prisma.deliverableOutput.findMany({ where: { id: { in: opts.outputIds } }, select: { projectId: true } });
    projectIds = [...new Set([...(projectIds ?? []), ...outs.map((o) => o.projectId)])];
    if (projectIds.length === 0) return [];
  }
  const scoped = !!projectIds;
  const projects = await prisma.project.findMany({
    where: scoped
      ? { id: { in: projectIds }, contentMonthId: { not: null } }
      : {
          contentMonthId: { not: null },
          status: { notIn: ["CANCELLED", "ON_HOLD"] },
          aryeoMissingAt: null,
          ...(opts.clientId ? { clientId: opts.clientId } : {}),
          OR: [{ shootDate: null }, { shootDate: { gte: new Date(now.getTime() - SHOOT_LOOKBACK_DAYS * DAY) } }],
        },
    select: {
      id: true, title: true, clientId: true, contentMonthId: true, status: true, shootDate: true,
      deliveryDue: true, dueOverrideAt: true, promisedDueAt: true, deliveredAt: true, uploadedAt: true, statusEvidence: true,
      editorId: true, editorVendorKey: true, reelScript: true,
      client: { select: { name: true } },
      deliverables: { where: { type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { id: true, uploadedAt: true } },
    },
    take: 400,
  });
  if (projects.length === 0) return [];
  const pIds = projects.map((p) => p.id);
  const [months, outputs, rounds, work] = await Promise.all([
    prisma.contentMonth.findMany({ where: { id: { in: [...new Set(projects.map((p) => p.contentMonthId!))] } }, select: { id: true, monthKey: true, enrollmentId: true } }),
    prisma.deliverableOutput.findMany({
      where: {
        projectId: { in: pIds },
        ...(opts.outputIds?.length ? { id: { in: opts.outputIds } } : {}),
        waivedAt: null,
        removedFromOrderAt: null,
        deliverable: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
      },
      select: {
        id: true, projectId: true, deliverableId: true, slot: true, title: true, ownerKey: true,
        promisedAt: true, promiseAnchorAt: true, rawInAt: true, reviewReadyAt: true, approvedAt: true, deliveredAt: true,
        topicId: true, briefJson: true,
      },
      orderBy: [{ projectId: "asc" }, { slot: "asc" }],
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId: { in: pIds }, deliverableId: { not: null }, withdrawnAt: null, status: { notIn: NOT_A_ROUND } },
      select: { id: true, deliverableId: true, slot: true, status: true, round: true, createdAt: true, decidedAt: true, clientReleasedAt: true, clientRequestedAt: true, sentToClientAt: true },
      orderBy: { round: "asc" },
    }),
    prisma.editorWorkItem
      .findMany({ where: { projectId: { in: pIds }, firstStartedAt: { not: null } }, select: { projectId: true, outputId: true, firstStartedAt: true } })
      .catch(() => [] as { projectId: string; outputId: string | null; firstStartedAt: Date | null }[]),
  ]);
  if (outputs.length === 0) return [];
  const oIds = outputs.map((o) => o.id);
  const [videos, briefs, causes] = await Promise.all([
    prisma.contentVideo.findMany({
      where: { outputId: { in: oIds } },
      select: { id: true, outputId: true, title: true, scriptId: true, filmedConfirmedAt: true, deliveredAt: true, releasedToClientAt: true },
    }),
    prisma.revisionBrief
      .findMany({ where: { outputId: { in: oIds }, dueAt: { not: null } }, select: { outputId: true, dueAt: true, createdAt: true }, orderBy: { createdAt: "desc" } })
      .catch(() => [] as { outputId: string | null; dueAt: Date | null; createdAt: Date }[]),
    readMissCauses(oIds),
  ]);
  const pById = new Map(projects.map((p) => [p.id, p]));
  const mById = new Map(months.map((m) => [m.id, m]));
  const vByOutput = new Map(videos.map((v) => [v.outputId!, v]));
  const briefByOutput = new Map<string, { dueAt: Date | null; createdAt: Date }>();
  for (const b of briefs) if (b.outputId && !briefByOutput.has(b.outputId)) briefByOutput.set(b.outputId, b);
  const roundsBySlot = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const k = `${r.deliverableId}:${r.slot}`;
    roundsBySlot.set(k, [...(roundsBySlot.get(k) ?? []), r]);
  }
  const { effectiveDue } = await import("@/lib/editOverrides");

  const rows: ProgramVideoRow[] = [];
  for (const o of outputs) {
    const p = pById.get(o.projectId);
    if (!p) continue;
    const month = mById.get(p.contentMonthId!) ?? null;
    const cv = vByOutput.get(o.id) ?? null;
    const rs = roundsBySlot.get(`${o.deliverableId}:${o.slot}`) ?? [];
    const approved = [...rs].reverse().find((r) => r.status === "APPROVED") ?? null;
    const ev = parseEvidence(p.statusEvidence);
    const deliverable = p.deliverables.find((d) => d.id === o.deliverableId) ?? null;
    const evidenceRaws = ev?.dropbox && !ev.dropbox.stale && ev.dropbox.rawVideo > 0 ? p.shootDate ?? (ev.dropbox.at ? new Date(ev.dropbox.at) : null) : null;
    const inReviewAt = o.reviewReadyAt ?? rs[0]?.createdAt ?? null;
    const facts: VideoFacts = {
      footageAt: minDate(o.rawInAt, p.uploadedAt, deliverable?.uploadedAt, cv?.filmedConfirmedAt) ?? evidenceRaws,
      editStartedAt: minDate(...work.filter((w) => w.projectId === p.id && (!w.outputId || w.outputId === o.id)).map((w) => w.firstStartedAt), inReviewAt),
      inReviewAt,
      finalAt: o.approvedAt ?? (approved ? approved.decidedAt ?? approved.createdAt : null),
      deliveredAt: minDate(
        o.deliveredAt,
        ...rs.map((r) => r.clientReleasedAt),
        ...rs.map((r) => r.sentToClientAt),
        cv?.releasedToClientAt,
        cv?.deliveredAt,
        p.status === "DELIVERED" ? p.deliveredAt : null,
      ),
    };
    const promisedAt = o.promisedAt ?? effectiveDue(p, p.deliveryDue);
    const before = o.promisedAt ?? pinnedPromise(p) ?? p.deliveryDue ?? null;
    const originalPromiseAt = before && promisedAt && before.getTime() !== promisedAt.getTime() ? before : null;
    const anchor = o.promiseAnchorAt ?? p.shootDate ?? null;
    const filmed = !anchor || anchor <= now || !!facts.footageAt;
    const milestones = promisedAt ? programMilestones(promisedAt, { anchorAt: anchor }) : [];
    const evaluation = promisedAt && filmed ? evaluateVideo(milestones, facts, now) : null;
    const latest = rs[rs.length - 1] ?? null;
    const slippedKey = evaluation?.slipped?.key ?? null;
    const approvedIdx = approved ? rs.indexOf(approved) : -1;
    const suggestion = evaluation && slippedKey
      ? suggestMissCause({
          slipped: slippedKey,
          facts,
          milestones,
          // A second-shoot hold rides in briefJson (Oct 22 2026) and is not a brief.
          briefReady: !!(o.topicId || (o.briefJson && withSecondShoot(o.briefJson, null)) || cv?.scriptId || p.reelScript),
          editorAssigned: !!(o.ownerKey || p.editorId || p.editorVendorKey),
          internalRounds: approvedIdx >= 0 ? approvedIdx + 1 : rs.length,
          waitingOnVerdictHours: latest && latest.status === "PENDING" ? (now.getTime() - latest.createdAt.getTime()) / HOUR : null,
          approvedUnreleasedHours: facts.finalAt && !facts.deliveredAt ? (now.getTime() - facts.finalAt.getTime()) / HOUR : null,
          clientWaiting: rs.some((r) => !!r.clientRequestedAt),
        })
      : null;
    const changesOpen = !!latest && latest.status === "CHANGES_REQUESTED" && !!latest.clientRequestedAt;
    const brief = briefByOutput.get(o.id) ?? null;
    rows.push({
      outputId: o.id,
      projectId: p.id,
      deliverableId: o.deliverableId,
      slot: o.slot,
      clientId: p.clientId,
      clientName: p.client.name,
      enrollmentId: month?.enrollmentId ?? null,
      monthId: p.contentMonthId!,
      monthKey: month?.monthKey ?? null,
      monthWords: monthWordsOf(month?.monthKey ?? null),
      videoId: cv?.id ?? null,
      title: o.title?.trim() || cv?.title?.trim() || `Video ${o.slot}`,
      promisedAt,
      originalPromiseAt,
      milestones,
      facts,
      evaluation,
      suggestion,
      recorded: causes.map.get(o.id) ?? null,
      changes: changesOpen ? { dueAt: brief && latest && brief.createdAt >= latest.createdAt ? brief.dueAt : null } : null,
      why: evaluation && promisedAt ? watchWhy(evaluation, promisedAt) : promisedAt ? "not filmed yet" : "no promise on file",
    });
  }
  return rows;
}

// ---- the office's list ---------------------------------------------------------

export type WatchBoardRow = ProgramVideoRow & { level: "late" | "risk" | "delivered-late" };

/** The tracker's list: at risk and late, never a delivered video (Oct 27 2026). "delivered-late" is no longer listed. */
export async function programWatchBoard(opts: { now?: Date; includeTest?: boolean } = {}): Promise<{ rows: WatchBoardRow[]; causesAvailable: boolean; rules: ProgramWatchRules }> {
  const now = opts.now ?? new Date();
  const [all, rules] = await Promise.all([programVideos({ now }), programWatchRules()]);
  let excluded = new Set<string>();
  if (opts.includeTest === false) {
    const { isSyntheticClientRow } = await import("@/lib/testClients");
    const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(all.map((r) => r.clientId))] } }, select: { id: true, name: true } });
    excluded = new Set(clients.filter(isSyntheticClientRow).map((c) => c.id));
  }
  const rows: WatchBoardRow[] = [];
  for (const r of all) {
    if (excluded.has(r.clientId) || !r.evaluation) continue;
    const e = r.evaluation;
    if (e.status === "LATE") rows.push({ ...r, level: "late" });
    else if (e.status === "AT_RISK") rows.push({ ...r, level: "risk" });
    // A DELIVERED VIDEO LEAVES THE LIST (Jordan, Oct 27 2026 Loom: "if
    // they've been delivered, I don't really want them in here anymore, so
    // this needs to auto-clean up after they're delivered"). Late deliveries
    // used to stay 21 days for a cause to be recorded; a cause already
    // recorded stays in its store (readMissCauses), it is only off the list.
  }
  const rank = { late: 0, risk: 1, "delivered-late": 2 } as const;
  rows.sort((a, b) => rank[a.level] - rank[b.level] || (a.promisedAt?.getTime() ?? 0) - (b.promisedAt?.getTime() ?? 0));
  const causesAvailable = (await readMissCauses(rows.slice(0, 1).map((r) => r.outputId))).available;
  return { rows, causesAvailable, rules };
}

// ---- the sweep -----------------------------------------------------------------

export type ProgramWatchResult = { checked: number; atRisk: number; late: number; alerted: number; drafted: number; listedOnly: number; closedDrafts: number; skipped?: string };

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** Every 5 minutes, from the promise watch. Staff only: nothing reaches a client. */
export async function sweepProgramWatch(now: Date = new Date()): Promise<ProgramWatchResult> {
  const out: ProgramWatchResult = { checked: 0, atRisk: 0, late: 0, alerted: 0, drafted: 0, listedOnly: 0, closedDrafts: 0 };
  const rows = await programVideos({ now });
  out.checked = rows.length;
  out.closedDrafts = await closeProgramWatchDrafts(rows).catch(() => 0);
  const rules = await programWatchRules();
  if (!rules.alerts) return { ...out, skipped: "switched off (Project Tracker, Program video watch)" };
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  type Hit = { row: ProgramVideoRow; level: "late" | "risk" };
  const hits: Hit[] = [];
  for (const r of rows) {
    const e = r.evaluation;
    if (!e || !r.promisedAt) continue;
    if (e.status === "LATE") out.late++;
    else if (e.status === "AT_RISK") out.atRisk++;
    else continue;
    // LATE ONLY (Jordan, Oct 27 2026 Loom, 40:34: "They should only be at
    // risk if they're late, not if you think they're going to be late,
    // because you don't know how much our team can get done"). A missed
    // milestone ahead of the promise is still counted and still on the
    // Project Tracker's program watch list; it no longer pings Kyle or
    // drafts a client update. Only a passed promise does.
    if (e.status !== "LATE" || r.promisedAt.getTime() > now.getTime()) continue;
    const level = "late" as const;
    const since = r.promisedAt;
    if (now.getTime() - since.getTime() > FRESH_HOURS * HOUR) { out.listedOnly++; continue; }
    hits.push({ row: r, level });
  }
  if (hits.length === 0) return out;
  // Synthetic clients never ping anybody.
  const names = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(hits.map((h) => h.row.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c]));
  const claimed: Hit[] = [];
  for (const h of hits) {
    const c = names.get(h.row.clientId);
    if (c && isSyntheticClientRow(c)) continue;
    const key = `${CLAIM_PREFIX}${h.row.outputId}:${h.row.promisedAt!.toISOString()}:${h.level}`;
    const won = await prisma.appSetting
      .create({ data: { key, value: JSON.stringify({ at: now.toISOString(), why: h.row.why }), updatedBy: "program-watch" } })
      .then(() => true)
      .catch(() => false);
    if (won) claimed.push(h);
  }
  if (claimed.length === 0) return out;

  // One message per month's job and promise.
  const groups = new Map<string, Hit[]>();
  for (const h of claimed) {
    const k = `${h.row.projectId}|${h.row.promisedAt!.toISOString()}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const { autoDraftAtRiskUpdate, foreignDates } = await import("@/lib/atRiskUpdates");
  const { appBase } = await import("@/lib/appUrl");
  for (const [, g] of groups) {
    const first = g[0].row;
    const promise = first.promisedAt!;
    const titles = g.map((h) => h.row.title);
    const named = titles.length === 1 ? `your video ${quote(titles[0])}` : titles.length <= 3 ? `your videos ${titles.map(quote).join(" and ")}` : `${titles.length} of your videos`;
    // A title that reads like a date ("Tuesday Tips") would make the draft
    // name a day nobody promised; such a draft says how many instead.
    const owed = foreignDates(named, [promise]) ? (titles.length === 1 ? "one of your videos" : `${titles.length} of your videos`) : named;
    const draft = await autoDraftAtRiskUpdate({
      projectId: first.projectId,
      promisedAt: promise,
      now,
      stage: g.map((h) => `${quote(h.row.title)}: ${h.row.evaluation ? STAGE_STAFF_WORDS[h.row.evaluation.stage] : "unknown"}`).join("; "),
      about: `your ${first.monthWords.split(" ")[0]} videos`,
      owed,
      verb: titles.length === 1 ? "is" : "are",
      reason: PROGRAM_WATCH_REASON,
    }).catch(() => null);
    if (draft?.ok && draft.created) out.drafted++;
    const late = g.some((h) => h.level === "late");
    const lines = g.map((h) => {
      const s = h.row.suggestion;
      return `${quote(h.row.title)}: ${h.row.why}.${s ? ` Likely cause: ${MISS_CAUSE_WORDS[s.cause].label} (${s.why}).` : ""}`;
    });
    const draftLine = draft?.ok ? `\nA client update is drafted on your list, not sent: ${appBase()}/tasks?tab=other&task=${draft.taskId}` : "";
    const text = noDashes(scrubMoney(
      `${late ? "Program video past its promise" : "Program video behind schedule"}: ${first.clientName}, ${first.monthWords}. Promise ${staffWhen(promise)}.\n${lines.join("\n")}\nRecord the cause on the tracker: ${appBase()}/pipeline#program-watch${draftLine}`,
    ));
    const idHash = createHash("sha1").update(g.map((h) => `${h.row.outputId}:${h.level}`).sort().join(",")).digest("hex").slice(0, 12);
    await noticeForKyle({
      kind: "promise_watch",
      title: noDashes(`${late ? "Past promise" : "Behind schedule"}: ${first.clientName}, ${titles.length === 1 ? titles[0] : `${titles.length} videos`}`).slice(0, 90),
      body: noDashes(scrubMoney(lines[0] ?? "")).slice(0, 140),
      href: "/pipeline#program-watch",
      dedupeKey: `program-watch-${first.projectId}-${promise.getTime()}-${idHash}`,
      slack: text,
    });
    out.alerted += g.length;
  }
  return out;
}

/** A program-watch draft whose videos are no longer behind is noise on Kyle's list: closed, with the reason. */
async function closeProgramWatchDrafts(rows: ProgramVideoRow[]): Promise<number> {
  const open = await prisma.smartTask.findMany({
    where: { taskType: "at_risk_update", reasonCreated: PROGRAM_WATCH_REASON, status: { notIn: ["COMPLETED", "CANCELLED"] }, projectId: { not: null } },
    select: { id: true, projectId: true },
    take: 100,
  });
  if (open.length === 0) return 0;
  // Read the jobs the open drafts are about even when the live scan did not
  // (a job that just went DELIVERED drops out of nothing, but be exact).
  const missing = [...new Set(open.map((t) => t.projectId as string))].filter((id) => !rows.some((r) => r.projectId === id));
  const extra = missing.length ? await programVideos({ projectIds: missing }) : [];
  const all = [...rows, ...extra];
  const behind = new Set(all.filter((r) => r.evaluation && (r.evaluation.status === "AT_RISK" || r.evaluation.status === "LATE")).map((r) => r.projectId));
  const ids = open.filter((t) => !behind.has(t.projectId as string)).map((t) => t.id);
  if (ids.length === 0) return 0;
  const r = await prisma.smartTask.updateMany({
    where: { id: { in: ids }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED", summary: "Closed by the program watch: the videos it named are back on schedule or on the portal, so no update was needed. Nothing was sent." },
  });
  return r.count;
}

// ---- for the at-risk list and the exceptions board -----------------------------

/** Program videos past their promise and not delivered (promise within the
 *  last `lookbackDays`). LATE only since Oct 27 2026 (Jordan: "only at risk if
 *  they're late"): a missed milestone ahead of the promise is the tracker's
 *  business, not a late promise for Messages or the exceptions board. */
export async function programAtRiskRows(opts: { now?: Date; lookbackDays?: number; excludeClientIds?: string[] } = {}): Promise<ProgramVideoRow[]> {
  const now = opts.now ?? new Date();
  const floor = now.getTime() - (opts.lookbackDays ?? 7) * DAY;
  const excluded = new Set(opts.excludeClientIds ?? []);
  return (await programVideos({ now })).filter(
    (r) => !excluded.has(r.clientId) && r.promisedAt && r.promisedAt.getTime() >= floor && r.promisedAt.getTime() < now.getTime() && r.evaluation?.status === "LATE",
  );
}

// ---- the chase task's promise lines ---------------------------------------------

/** Staff words for a program job's videos: promise and where each stands. Empty for any other job. */
export async function programPromiseLines(projectId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await programVideos({ projectIds: [projectId], now }).catch(() => [] as ProgramVideoRow[]);
  return rows
    .filter((r) => !r.evaluation || r.evaluation.status !== "DONE")
    .slice(0, 8)
    .map((r) => {
      const when = r.promisedAt ? staffWhen(r.promisedAt) : "no promise on file";
      const flag = r.evaluation?.status === "LATE" ? " LATE" : r.evaluation?.status === "AT_RISK" ? " AT RISK" : "";
      return noDashes(`${quote(r.title)}: due ${when}${flag}, ${r.why}`);
    });
}

// ---- the client's portal -----------------------------------------------------------

/**
 * Stage and "expected by" for the client's videos in production, by library
 * video id. Empty while the portalExpectedBy switch is off. Database only.
 */
export async function portalExpectedFor(
  videos: { id: string; outputId: string | null; state: string }[],
  opts: { now?: Date; force?: boolean } = {},
): Promise<Map<string, ClientExpected>> {
  const out = new Map<string, ClientExpected>();
  const want = videos.filter((v) => v.outputId && (v.state === "IN_PRODUCTION" || v.state === "CHANGES_IN_PROGRESS"));
  if (want.length === 0) return out;
  if (!opts.force && !(await programWatchRules()).portalExpectedBy) return out;
  const now = opts.now ?? new Date();
  const rows = await programVideos({ outputIds: want.map((v) => v.outputId!), now });
  const byOutput = new Map(rows.map((r) => [r.outputId, r]));
  for (const v of want) {
    const r = byOutput.get(v.outputId!);
    if (!r) continue;
    const e = v.state === "CHANGES_IN_PROGRESS"
      ? clientExpected({ stage: "CHANGES", promisedAt: r.changes?.dueAt ?? null, originalAt: null, cause: null, now })
      : r.evaluation
        ? clientExpected({ stage: r.evaluation.stage, promisedAt: r.promisedAt, originalAt: r.originalPromiseAt, cause: r.recorded?.cause ?? null, now })
        : null;
    if (e) out.set(v.id, e);
  }
  return out;
}

/** The milestone the office reads on a row: "First cut in review by Tue, Oct 20, 5:00 PM ET". */
export const milestoneLine = (m: Milestone) => `${MILESTONE_WORDS[m.key].label} by ${staffWhen(m.by)}`;

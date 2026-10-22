import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { etDateTime, etDayStartUtc, etMonthDay } from "@/lib/datetime";
import {
  SECOND_SHOOT_MARK,
  SECOND_SHOOT_PROMISE_SOURCE,
  NOTE_CAP,
  isWaitingHold,
  laterVisits,
  plainLabel,
  readSecondShoot,
  secondShootVisitFor,
  startedVisits,
  waitingLine,
  withSecondShoot,
  type SecondShootHold,
} from "@/lib/secondShootCore";

// ---------------------------------------------------------------------------
// WAITING ON A SECOND SHOOT: the reads and the two writes (Oct 22 2026). The
// rule and where the state lives are in lib/secondShootCore.ts.
//
//   markVideoWaitingOnShoot  the office's "Waiting on a second shoot" on one video
//   releaseWaitingVideo      the office's "Release to the editor", and the
//                            automatic release, which both start the video's
//                            own clock from the shoot its footage came from
//   releaseFromUploads       the automatic one: called by the upload page (a
//                            submit, a tick) and by the hourly sweep below
// ---------------------------------------------------------------------------

export type WaitingVideo = { outputId: string; projectId: string; deliverableId: string; slot: number; key: string; hold: SecondShootHold };

type Db = Pick<Prisma.TransactionClient, "deliverableOutput">;

/** Every video WAITING on a second shoot on these jobs, by job, then by slot key. One query; a failed read throws. */
export async function waitingVideosFor(projectIds: string[], db: Db = prisma): Promise<Map<string, Map<string, WaitingVideo>>> {
  const out = new Map<string, Map<string, WaitingVideo>>();
  const ids = [...new Set(projectIds)].filter(Boolean);
  if (!ids.length) return out;
  const rows = await db.deliverableOutput.findMany({
    where: { projectId: { in: ids }, briefJson: { contains: SECOND_SHOOT_MARK }, waivedAt: null, removedFromOrderAt: null },
    select: { id: true, projectId: true, deliverableId: true, slot: true, briefJson: true },
  });
  for (const r of rows) {
    const hold = readSecondShoot(r.briefJson);
    if (!isWaitingHold(hold)) continue;
    const key = `${r.deliverableId}:${r.slot}`;
    const m = out.get(r.projectId) ?? new Map<string, WaitingVideo>();
    m.set(key, { outputId: r.id, projectId: r.projectId, deliverableId: r.deliverableId, slot: r.slot, key, hold });
    out.set(r.projectId, m);
  }
  return out;
}

/** One job's waiting videos by slot key (empty when none, or when the read fails: a failed read is no hold). */
export async function waitingKeysFor(projectId: string): Promise<Map<string, WaitingVideo>> {
  return (await waitingVideosFor([projectId]).catch(() => new Map<string, Map<string, WaitingVideo>>())).get(projectId) ?? new Map();
}

/**
 * A DELIVERED job that owes a video released from a second shoot: live work
 * again, the way an extra shoot is (uploadHistory.OWES_AN_ADDITIONAL_SHOOT).
 * The editor queue admits the job through this, and the first delivery is
 * left exactly as it is. Ends when the video's cut is approved, it is sent,
 * waived or taken off the order.
 */
export const OWES_A_RELEASED_SECOND_SHOOT: Prisma.ProjectWhereInput = {
  deliverables: {
    some: {
      removedFromOrderAt: null,
      waivedAt: null,
      outputs: { some: { promiseSource: SECOND_SHOOT_PROMISE_SOURCE, promisedAt: { not: null }, approvedAt: null, deliveredAt: null, waivedAt: null, removedFromOrderAt: null } },
    },
  },
};

/** "video 4 (Premium Social Reel)" — the number and name the brief and the Review Room use. */
async function videoName(projectId: string, deliverableId: string, slot: number): Promise<string> {
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(projectId, { includeWaiting: true }).catch(() => []);
  const i = slots.findIndex((s) => s.deliverableId === deliverableId && s.slot === slot);
  return i >= 0 ? `Video ${i + 1} (${plainLabel(slots[i].label)})` : `Video ${slot}`;
}

async function activity(projectId: string, body: string): Promise<void> {
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: body.slice(0, 1000) } }).catch(() => {});
}

/** The edit card and its blocker follow the change (best-effort: the hourly pass repairs a miss). */
async function kickHandoff(projectId: string): Promise<void> {
  try {
    const { ensureEditorHandoff } = await import("@/lib/tasks");
    await ensureEditorHandoff(projectId);
  } catch (e) {
    console.warn("[second-shoot] the edit card was not refreshed", projectId, (e as Error)?.message);
  }
}

export type SecondShootResult = { ok: boolean; message: string; outputId?: string; dueAt?: Date | null };

/**
 * The office's "Waiting on a second shoot" on ONE video. The video stays set
 * up (its row, its slot, its instructions box); it leaves every queue and
 * every clock until it is released. Marking a waiting video again only updates
 * its note or its expected appointment. Refused for a video that already has
 * an approved cut or reached the client. The caller owns the permission check.
 */
export async function markVideoWaitingOnShoot(input: {
  projectId: string;
  /** the video's row; or `key` ("<deliverableId>:<slot>") */
  outputId?: string | null;
  key?: string | null;
  note?: string | null;
  expectedAt?: Date | null;
  actor: string;
  now?: Date;
  /** false: do not refresh the edit card (drills) */
  kick?: boolean;
}): Promise<SecondShootResult> {
  const now = input.now ?? new Date();
  const actor = (input.actor || "the office").trim().slice(0, 120);
  const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
  await ensureOutputsSafely(input.projectId, "second-shoot");
  const [deliverableId, slotRaw] = (input.key ?? "").split(":");
  const row = input.outputId
    ? await prisma.deliverableOutput.findUnique({ where: { id: input.outputId }, select: ROW })
    : deliverableId && Number(slotRaw) > 0
      ? await prisma.deliverableOutput.findUnique({ where: { deliverableId_slot: { deliverableId, slot: Number(slotRaw) } }, select: ROW })
      : null;
  if (!row || row.projectId !== input.projectId) return { ok: false, message: "That video is not on this job." };
  if (row.waivedAt || row.removedFromOrderAt) return { ok: false, message: "That video is no longer owed on this job." };
  if (!["VIDEO", "SOCIAL_REEL"].includes(row.deliverable.type)) return { ok: false, message: "Only a video can wait on a second shoot." };
  const name = await videoName(row.projectId, row.deliverableId, row.slot);
  if (row.deliveredAt) return { ok: false, message: `${name} already reached the client, so it is not waiting on a shoot.` };
  if (row.approvedAt) return { ok: false, message: `${name} already has an approved cut, so it is not waiting on a shoot.` };

  const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { shootDate: true, appointments: { select: { startAt: true, status: true } } } });
  const visits = startedVisits(project?.appointments ?? [], now);
  const current = readSecondShoot(row.briefJson);
  const note = input.note?.replace(/\s+/g, " ").trim().slice(0, NOTE_CAP) || null;
  const expectedAt = input.expectedAt && Number.isFinite(input.expectedAt.getTime()) ? input.expectedAt.toISOString() : null;
  const already = isWaitingHold(current);
  const hold: SecondShootHold = already
    ? { ...current, note: note ?? current.note, expectedAt: expectedAt ?? current.expectedAt }
    : {
        by: actor,
        at: now.toISOString(),
        note,
        expectedAt,
        // The visit that was half shot: the latest one that has happened, else
        // the booked one. Only a visit on a later ET day releases the video.
        afterVisitAt: (visits[visits.length - 1] ?? project?.shootDate ?? null)?.toISOString() ?? null,
        releasedAt: null, releasedBy: null, releasedHow: null, clockFrom: null,
      };
  const next = withSecondShoot(row.briefJson, hold);
  // Compare-and-set on what was read: a brief saved at the same moment wins and this is refused.
  const res = await prisma.deliverableOutput.updateMany({ where: { id: row.id, briefJson: row.briefJson }, data: { briefJson: next } });
  if (res.count === 0) return { ok: false, message: "That video changed while you were saving. Reload and try again." };
  await activity(
    row.projectId,
    already
      ? `${name}: waiting on a second shoot, note updated by ${actor}${hold.note ? `: ${hold.note}` : ""}.`
      : `${name} marked waiting on a second shoot by ${actor}${hold.note ? `: ${hold.note}` : ""}. It is off the editors' queue, with no due date, until footage from a later appointment is in or the office releases it.`,
  );
  if (input.kick !== false) await kickHandoff(row.projectId);
  return { ok: true, outputId: row.id, message: already ? `${name}: note saved.` : `${name} is waiting on a second shoot. The other videos carry on.` };
}

const ROW = {
  id: true, projectId: true, deliverableId: true, slot: true, briefJson: true,
  waivedAt: true, removedFromOrderAt: true, approvedAt: true, deliveredAt: true, promisedAt: true,
  deliverable: { select: { type: true, label: true, productTitle: true, videoStyle: true } },
} as const;

/**
 * Release a waiting video: the office's "Release to the editor" (how "office")
 * or footage from a later appointment (how "upload"). Its OWN clock starts from
 * that shoot (a later appointment that has happened; with none, the moment the
 * office released it) on its own tier's turnaround (the office's tier for the
 * job still wins), stamped on its row as promiseSource "second-shoot" — the
 * date every per-video reader already takes over the job's. Then the edit card
 * and the job's editor hear about it.
 */
export async function releaseWaitingVideo(input: {
  projectId: string;
  outputId: string;
  actor: string;
  how: "office" | "upload";
  /** the shoot the clock runs from (the automatic release passes the visit it found) */
  visit?: Date | null;
  now?: Date;
  kick?: boolean;
}): Promise<SecondShootResult> {
  const now = input.now ?? new Date();
  const actor = (input.actor || "the office").trim().slice(0, 120);
  const row = await prisma.deliverableOutput.findUnique({ where: { id: input.outputId }, select: ROW });
  if (!row || row.projectId !== input.projectId) return { ok: false, message: "That video is not on this job." };
  const hold = readSecondShoot(row.briefJson);
  const name = await videoName(row.projectId, row.deliverableId, row.slot);
  if (!isWaitingHold(hold)) return { ok: false, message: `${name} is not waiting on a second shoot.` };
  const project = await prisma.project.findUnique({
    where: { id: row.projectId },
    select: {
      title: true, tierOverride: true, packageName: true, shootDate: true, editorVendorKey: true,
      editor: { select: { name: true } },
      appointments: { select: { startAt: true, status: true } },
    },
  });
  if (!project) return { ok: false, message: "That job is gone." };
  const later = laterVisits({ appointments: project.appointments, afterVisitAt: hold.afterVisitAt ? new Date(hold.afterVisitAt) : null, now, dayStart: etDayStartUtc });
  const anchor = input.visit ?? later[later.length - 1] ?? now;
  const { deliveryPromiseFor, slaTierOf } = await import("@/lib/tasks");
  const { isMonthlyContentJob } = await import("@/lib/pipeline");
  const own = [{ type: row.deliverable.type, label: row.deliverable.label ?? row.deliverable.productTitle, productTitle: row.deliverable.productTitle }];
  // Its OWN tier (a standard reel on a premium job is due on the standard
  // turnaround); the office's tier for the job, when set, wins as it does for
  // every video.
  // The row's Style Guide type says its tier when it has one (the order
  // mapping resolved it); its label otherwise, the way the engine reads it.
  const style = row.deliverable.videoStyle ?? "";
  const styleTier = !style ? null : style.startsWith("premium") ? "premium" as const : style === "personal_branding" ? "branding" as const : "standard" as const;
  const tier = project.tierOverride
    ? slaTierOf({ tierOverride: project.tierOverride, packageName: project.packageName, deliverables: own })
    : styleTier ?? slaTierOf({ tierOverride: null, packageName: project.packageName, deliverables: own });
  const promise = deliveryPromiseFor(anchor, own, isMonthlyContentJob(own, project.packageName), null, { tier });
  const released: SecondShootHold = { ...hold, releasedAt: now.toISOString(), releasedBy: actor, releasedHow: input.how, clockFrom: anchor.toISOString() };
  const res = await prisma.deliverableOutput.updateMany({
    where: { id: row.id, briefJson: row.briefJson },
    data: {
      briefJson: withSecondShoot(row.briefJson, released),
      promisedAt: promise.at,
      targetAt: promise.targetAt,
      promiseSource: SECOND_SHOOT_PROMISE_SOURCE,
      promiseAnchorAt: anchor,
    },
  });
  if (res.count === 0) return { ok: false, message: "That video changed while you were saving. Reload and try again." };
  const tierWord = tier === "premium" ? "premium" : tier === "branding" ? "monthly content" : "standard";
  const from = input.how === "upload"
    ? `: footage from the ${etMonthDay(anchor)} shoot is in`
    : ` by ${actor}`;
  await activity(
    row.projectId,
    `${name} released to the editor${from}. Its own clock runs from the ${etDateTime(anchor)} ET ${later.length || input.visit ? "shoot" : "release"}: due ${etDateTime(promise.at)} ET (${tierWord} turnaround).${row.promisedAt ? ` It had carried ${etDateTime(row.promisedAt)} ET before it waited.` : ""}`,
  );
  if (input.kick !== false) {
    await kickHandoff(row.projectId);
    // The job's editor hears about the video, the way a new edit does.
    try {
      const { editorKeyForTeamName } = await import("@/lib/editors");
      const task = await prisma.smartTask.findFirst({ where: { projectId: row.projectId, taskType: "edit_video", assignedKey: { not: null } }, orderBy: { createdAt: "desc" }, select: { assignedKey: true } });
      const key = task?.assignedKey ?? editorKeyForTeamName(project.editor?.name) ?? null;
      if (key) {
        const street = (project.title || "the job").split(",")[0].trim();
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: "second_shoot_released",
          title: `${street}: ${name} is ready for editing`,
          body: `The second shoot's footage is in. Due ${etDateTime(promise.at)} ET.`,
          href: `/edit/${row.projectId}?output=${row.id}`,
          targets: [{ roles: ["EDITOR"], userKey: `editor:${key}` }],
          dedupeKey: `second-shoot-released:${row.id}:${released.releasedAt}`,
        });
      }
    } catch (e) {
      console.warn("[second-shoot] the editor was not told", row.projectId, (e as Error)?.message);
    }
  }
  return { ok: true, outputId: row.id, dueAt: promise.at, message: `${name} is with the editor. Due ${etDateTime(promise.at)} ET.` };
}

const VIDEO_FILE = /\.(mp4|mov|m4v|mxf|mts|m2ts|avi|insv|braw|r3d|crm|mkv|lrv|wav|mp3)$/i;

/**
 * When video footage reached the hub for this job (pure inputs gathered here):
 * the photographer's "uploaded" tick on a video row, the upload page's video
 * submit stamps, `extra` (a submit happening now), and, with `dropbox`, every
 * file Dropbox received into the job's raw-video folder.
 */
async function footageTimes(projectId: string, opts: { extra?: Date[]; dropbox?: boolean }): Promise<Date[]> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      videoHandoffAt: true, debriefSubmittedAt: true,
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { uploadedAt: true } },
      title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } },
    },
  });
  if (!p) return opts.extra ?? [];
  const times = [
    ...(opts.extra ?? []),
    ...p.deliverables.map((d) => d.uploadedAt).filter((x): x is Date => !!x),
    ...[p.videoHandoffAt, p.debriefSubmittedAt].filter((x): x is Date => !!x),
  ];
  if (opts.dropbox) {
    try {
      const { actualFolderPaths } = await import("@/lib/dropboxFolders");
      const { dropboxListFolder } = await import("@/lib/integrations/dropbox");
      const folder = actualFolderPaths(p).rawVideo;
      const files = await dropboxListFolder(folder, { recursive: true });
      for (const f of files) {
        if (f.tag !== "file" || !VIDEO_FILE.test(f.name) || !f.serverModified) continue;
        const t = Date.parse(f.serverModified);
        if (Number.isFinite(t)) times.push(new Date(t));
      }
    } catch (e) {
      // A folder that cannot be read is no evidence either way; the next pass looks again.
      console.warn("[second-shoot] raw video folder not read", projectId, (e as Error)?.message);
    }
  }
  return times;
}

/**
 * THE AUTOMATIC RELEASE. For every video on this job still waiting: has a
 * LATER appointment happened and uploaded video footage since its own ET day
 * (secondShootVisitFor, the photo split-job rule)? Then it is released with its
 * clock from that visit. Cheap when nothing waits (one indexed read), and no
 * Dropbox call unless a later visit has actually started. Never throws.
 */
export async function releaseFromUploads(projectId: string, opts: { now?: Date; extra?: Date[]; dropbox?: boolean; actor?: string; kick?: boolean } = {}): Promise<{ released: string[] }> {
  const now = opts.now ?? new Date();
  const out: string[] = [];
  try {
    const waiting = [...(await waitingKeysFor(projectId)).values()];
    if (!waiting.length) return { released: out };
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { shootDate: true, appointments: { select: { startAt: true, status: true } } } });
    if (!project) return { released: out };
    // The photo split-job floor: the ET day of the latest visit that has
    // started. When it is not after every hold's half-shot visit, no later
    // visit has happened and there is nothing to look for.
    const { uploadFloorFor } = await import("@/lib/photoDelivery/intake");
    const floor = uploadFloorFor(project.appointments, project.shootDate, now);
    const anyLater = !!floor && waiting.some((w) => !w.hold.afterVisitAt || floor.getTime() > etDayStartUtc(new Date(w.hold.afterVisitAt)).getTime());
    if (!anyLater) return { released: out };
    const uploads = await footageTimes(projectId, { extra: opts.extra, dropbox: opts.dropbox });
    for (const w of waiting) {
      const visit = secondShootVisitFor({
        appointments: project.appointments,
        afterVisitAt: w.hold.afterVisitAt ? new Date(w.hold.afterVisitAt) : null,
        uploads,
        now,
        dayStart: etDayStartUtc,
      });
      if (!visit) continue;
      const r = await releaseWaitingVideo({ projectId, outputId: w.outputId, actor: opts.actor ?? "the upload page", how: "upload", visit, now, kick: opts.kick });
      if (r.ok) out.push(w.outputId);
    }
  } catch (e) {
    console.warn("[second-shoot] release check failed", projectId, (e as Error)?.message);
  }
  return { released: out };
}

/** The hourly pass: every job with a waiting video, Dropbox included. Small by nature. */
export async function sweepSecondShoots(opts: { now?: Date; max?: number } = {}): Promise<{ jobs: number; released: number }> {
  const rows = await prisma.deliverableOutput.findMany({
    where: { briefJson: { contains: SECOND_SHOOT_MARK }, waivedAt: null, removedFromOrderAt: null },
    select: { projectId: true, briefJson: true },
    take: 500,
  });
  const jobs = [...new Set(rows.filter((r) => isWaitingHold(readSecondShoot(r.briefJson))).map((r) => r.projectId))].slice(0, opts.max ?? 40);
  let released = 0;
  for (const id of jobs) released += (await releaseFromUploads(id, { now: opts.now, dropbox: true, actor: "the hourly check" })).released.length;
  return { jobs: jobs.length, released };
}

/** What the office's control lists: every owed video on the job with its state. */
export type SecondShootControlRow = {
  outputId: string;
  key: string;
  number: number;
  label: string;
  waiting: SecondShootHold | null;
  /** released from a second shoot earlier: when, how, and the clock it got */
  released: SecondShootHold | null;
  /** an approved cut or a send: it cannot wait any more */
  finished: boolean;
};

export async function secondShootControlRows(projectId: string): Promise<SecondShootControlRow[]> {
  const { cutSlots } = await import("@/lib/reviewCuts");
  const [slots, outputs] = await Promise.all([
    cutSlots(projectId, { includeWaiting: true }).catch(() => []),
    prisma.deliverableOutput.findMany({ where: { projectId, waivedAt: null, removedFromOrderAt: null }, select: { id: true, deliverableId: true, slot: true, briefJson: true, approvedAt: true, deliveredAt: true } }),
  ]);
  const byKey = new Map(outputs.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
  return slots.flatMap((s, i) => {
    const o = byKey.get(`${s.deliverableId}:${s.slot}`);
    if (!o) return [];
    const h = readSecondShoot(o.briefJson);
    return [{
      outputId: o.id,
      key: `${s.deliverableId}:${s.slot}`,
      number: i + 1,
      label: plainLabel(s.label),
      waiting: isWaitingHold(h) ? h : null,
      released: h && h.releasedAt ? h : null,
      finished: !!o.approvedAt || !!o.deliveredAt,
    }];
  });
}

/** The same rows in the words the office's control prints (SecondShootControl), serialisable. */
export async function secondShootViewRows(projectId: string): Promise<import("@/components/jobs/SecondShootControl").SecondShootRowView[]> {
  const { etDayKey } = await import("@/lib/datetime");
  const rows = await secondShootControlRows(projectId);
  const promised = new Map(
    (await prisma.deliverableOutput.findMany({ where: { id: { in: rows.filter((r) => r.released).map((r) => r.outputId) } }, select: { id: true, promisedAt: true } }).catch(() => []))
      .map((o) => [o.id, o.promisedAt]),
  );
  return rows.map((r) => {
    const rel = r.released;
    const due = promised.get(r.outputId) ?? null;
    return {
      outputId: r.outputId,
      number: r.number,
      label: r.label,
      waiting: r.waiting ? waitingLine(r.waiting, { expectedWords: (iso) => etMonthDay(iso) }) : null,
      note: r.waiting?.note ?? null,
      expectedDay: r.waiting?.expectedAt ? etDayKey(new Date(r.waiting.expectedAt)) : null,
      released: rel?.releasedAt
        ? `Released ${etMonthDay(rel.releasedAt)} ${rel.releasedHow === "upload" ? `(footage from the ${etMonthDay(rel.clockFrom ?? rel.releasedAt)} shoot)` : `by ${rel.releasedBy ?? "the office"}`}${due ? `, due ${etDateTime(due)} ET` : ""}`
        : null,
      finished: r.finished,
    };
  });
}

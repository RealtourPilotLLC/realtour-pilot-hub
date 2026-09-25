import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { EDITORS, TEAM_MEMBER_EDITOR_KEYS, editorMeta } from "@/lib/editors";
import { etDayKey, etMonthDay, etTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// WHAT EACH EDITOR IS ACTUALLY WORKING ON (§7.1, Sep 25 2026).
//
// Jordan: a job must not become "In editing" because files arrived, it was
// assigned, a sync ran or a page was opened. The editor presses Start; when
// they start another project, the one they were on becomes Paused on its own.
//
// TWO AXES, NOT ONE PILL. Project.status keeps its lifecycle meaning (EDITING =
// "editing has begun on this job, nothing handed in"), because payroll
// (payroll.ts SHOOT_HAPPENED_STATUSES), the hourly sweep and every Ops count
// read it. Which job a PERSON is on right now lives here, per editor:
//
//   EditorWorkItem   one row per (editor, project). ACTIVE | PAUSED | CLOSED.
//                    `activeFor` = the editorKey while ACTIVE, else null, and it
//                    is @unique — so "one active project per editor" is a
//                    database guarantee, not a hope. (A nullable unique column
//                    rather than a partial index: the schema is managed by
//                    `db push`, which would drop an index it does not know.)
//   EditorWorkEvent  the declared log: who pressed what, when, for whom.
//                    Not keyboard time, not payroll time, never summed into
//                    hours anywhere.
//
// WHO MAY MOVE IT. Only startEditing and confirmCurrentWork ever write ACTIVE,
// and both need a person: the assigned editor for their own work, or the office
// correcting it — recorded as the office, on behalf of the editor, never as the
// editor (the old pill wrote "Kim started editing." when Jordan clicked it).
// Every automatic path — raws landing, assignment, the sweeps, webhooks, a
// withdrawn cut, a restore — may only CLOSE work (closeActiveWork /
// closeGhostWork). Nothing here reads browser presence or inactivity; there is
// no timeout that pauses anybody.
//
// THE SWITCH IS ONE TRANSACTION, behind a per-editor advisory lock
// (dbLocks.lockAdvisory, the ::int4 pair): pause A, activate B, log both, move
// the lifecycle. If B fails for any reason — a refusal, a racing tab's start
// landing first (P2002 on activeFor), a crash — the whole thing rolls back and
// A is still ACTIVE with its original activeSince. A retried click carries the
// same requestId (EditorWorkEvent.requestId @unique) and replays instead of
// logging twice.
// ---------------------------------------------------------------------------

export const WORK_ACTIVE = "ACTIVE";
export const WORK_PAUSED = "PAUSED";
export const WORK_CLOSED = "CLOSED";
export type WorkState = typeof WORK_ACTIVE | typeof WORK_PAUSED | typeof WORK_CLOSED;

export type WorkEventKind = "START" | "RESUME" | "PAUSE" | "AUTO_PAUSE" | "SUBMIT" | "CLOSE" | "CONFIRM" | "CONFIRM_PAUSED";

export type CloseReason =
  | "SUBMITTED"
  | "REASSIGNED"
  | "UNASSIGNED"
  | "REMOVED"
  | "PUT_BACK"
  | "PROJECT_DELIVERED"
  | "PROJECT_CANCELLED"
  | "MERGED";

export type WorkActor = {
  userId: string | null;
  name: string;
  role: "EDITOR" | "OWNER" | "ADMIN" | "SYSTEM";
};

/** The hub itself — the only actor allowed to call closeActiveWork without a
 *  person behind it. It can never start or resume anything. */
export const SYSTEM_ACTOR: WorkActor = { userId: null, name: "The hub", role: "SYSTEM" };

/** People who can hold editing work: the in-house editors with a login. The
 *  outside shop and the retired vendor have no login, so their rows read "With
 *  the external agency" and are never "active". */
export const WORK_EDITOR_KEYS: readonly string[] = TEAM_MEMBER_EDITOR_KEYS;
/** The editors the office panel lists even when they are on nothing. */
export const DESK_EDITOR_KEYS: readonly string[] = TEAM_MEMBER_EDITOR_KEYS.filter((k) => !EDITORS[k].departed);

export type WorkResult = { ok: boolean; message: string; replay?: boolean };

const nameOf = (key: string) => editorMeta(key)?.name ?? key;
const streetOf = (title: string | null | undefined) => (title || "this job").split(",")[0].trim();
const OPEN_TASK = { notIn: ["COMPLETED", "CANCELLED"] };
const REFRESH_MSG = "Another start just landed for you in a different tab — refresh and try again.";

// ---- who is asking -----------------------------------------------------------

type Caller =
  | { ok: true; actor: WorkActor; ownKey: string | null; office: boolean }
  | { ok: false; message: string };

/** The person pressing the button, in the terms this layer needs. View-as is
 *  refused (a preview is read-only everywhere); an EDITOR is their ASSIGNED key
 *  only (editorScopeOf's rule — a login name is free text and never an
 *  identity); a photographer has no editing desk. */
async function resolveCaller(): Promise<Caller> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforced()) return { ok: false, message: "Please sign in to do that." };
    // Local dev with auth off: the office, exactly as every other action here.
    return { ok: true, actor: { userId: null, name: "The office", role: "OWNER" }, ownKey: null, office: true };
  }
  if (me.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  if (me.realRole === "OWNER" || me.realRole === "ADMIN") {
    return { ok: true, actor: { userId: me.id, name: me.name ?? me.email, role: me.realRole }, ownKey: null, office: true };
  }
  if (me.realRole === "EDITOR") {
    const key = me.editorKey;
    if (!key || !WORK_EDITOR_KEYS.includes(key)) {
      return { ok: false, message: "Your login isn't linked to an editor profile yet — ask Jordan or Kyle to finish it." };
    }
    return { ok: true, actor: { userId: me.id, name: me.name ?? nameOf(key), role: "EDITOR" }, ownKey: key, office: false };
  }
  return { ok: false, message: "Only the editor on the job, or the office, can start or pause editing." };
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Every editor who legitimately holds video work on these projects: the live
 *  edit card's assignee, an open video-lane revision's assignee, and the owner
 *  of a live DeliverableOutput (which is how two editors share one job). Only
 *  people with a desk (WORK_EDITOR_KEYS) are counted. Sequential on purpose — it
 *  runs inside the switch transaction too. */
async function holdersFor(projectIds: string[], db: Db = prisma): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (projectIds.length === 0) return out;
  const add = (pid: string | null, key: string | null) => {
    if (!pid || !key || !WORK_EDITOR_KEYS.includes(key)) return;
    const s = out.get(pid) ?? new Set<string>();
    s.add(key);
    out.set(pid, s);
  };
  const tasks = await db.smartTask.findMany({
    where: { projectId: { in: projectIds }, taskType: { in: ["edit_video", "revision"] }, status: OPEN_TASK, assignedKey: { in: [...WORK_EDITOR_KEYS] } },
    select: { projectId: true, assignedKey: true },
  });
  for (const t of tasks) add(t.projectId, t.assignedKey);
  const outs = await db.deliverableOutput.findMany({
    where: { projectId: { in: projectIds }, ownerKey: { in: [...WORK_EDITOR_KEYS] }, removedFromOrderAt: null, waivedAt: null, approvedSubmissionId: null },
    select: { projectId: true, ownerKey: true },
  });
  for (const o of outs) add(o.projectId, o.ownerKey);
  return out;
}

/** The live edit card on a job, and whose it is. */
async function editCardOf(projectId: string, db: Db = prisma) {
  return db.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", status: OPEN_TASK },
    select: { id: true, assignedKey: true, status: true, assignedManually: true },
  });
}

const isP2002 = (e: unknown, field?: string) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  e.code === "P2002" &&
  (!field || JSON.stringify(e.meta?.target ?? "").includes(field));

// ---- the switch ---------------------------------------------------------------

export type StartInput = {
  projectId: string;
  /** Which video of a multi-video job, when the editor picked one. */
  outputId?: string | null;
  /** Office corrections only: whose work this is. An EDITOR's own key always wins. */
  forEditorKey?: string | null;
  /** One per click, reused on retry. A replay writes nothing. */
  requestId?: string | null;
};

/**
 * Start (or resume) editing a job. Pauses whatever this editor was on, in the
 * same transaction. See the header for the guarantees.
 */
export async function startEditing(input: StartInput): Promise<WorkResult> {
  const caller = await resolveCaller();
  if (!caller.ok) return { ok: false, message: caller.message };
  const requestId = cleanRequestId(input.requestId);
  const { projectId } = input;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, status: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };
  if (project.status === "CANCELLED") return { ok: false, message: "That job is cancelled — there is nothing to edit." };
  const street = streetOf(project.title);

  const card = await editCardOf(projectId);
  const holders = (await holdersFor([projectId])).get(projectId) ?? new Set<string>();

  // WHOSE WORK. An editor starts their own and nobody else's; the office names
  // the editor (defaulting to the card's), and the log says it was the office.
  let editorKey: string | null;
  if (caller.office) {
    editorKey = input.forEditorKey || card?.assignedKey || (holders.size === 1 ? [...holders][0] : null);
    if (!editorKey) return { ok: false, message: `Nobody is assigned to edit ${street} — pick the editor first.` };
  } else {
    editorKey = caller.ownKey;
  }
  if (!editorKey || !WORK_EDITOR_KEYS.includes(editorKey)) {
    // The agency and the retired vendor have no login and no desk: their jobs
    // read "With the external agency", never "active".
    return { ok: false, message: `${editorMeta(editorKey)?.name ?? "That editor"} has no hub login, so their work can't be marked active — it shows as with them until the cut comes back.` };
  }
  if (!holders.has(editorKey)) {
    return caller.office
      ? { ok: false, message: `${nameOf(editorKey)} isn't assigned to ${street} — reassign it to them first.` }
      : { ok: false, message: `${street} isn't assigned to you, so you can't start it. Ask the office to hand it over.` };
  }
  if (input.outputId) {
    const out = await prisma.deliverableOutput.findFirst({ where: { id: input.outputId, projectId }, select: { id: true } });
    if (!out) return { ok: false, message: "That video isn't on this job any more — refresh the page." };
  }

  // A job the office is holding in Waiting is the office's to move on (Sep 11).
  // The editor is refused; the office's start is its "move it on", which ends
  // the hold, the same as its forward click on the pill always has.
  const onWaiting = project.status === "BOOKED" || project.status === "SCHEDULED";
  let releaseHoldKey: string | null = null;
  if (onWaiting) {
    const { loadWaitingHolds, waitingHoldKey } = await import("@/lib/queueWaiting");
    const held = (await loadWaitingHolds([projectId])).has(projectId);
    if (held && !caller.office) {
      return { ok: false, message: `${street} is held in Waiting by the office — it can't be started until the footage is in.` };
    }
    // Released INSIDE the switch transaction below, not here (review fix, Sep
    // 25): deleted up front, a start that then failed ("nothing changed") had
    // already dropped the hold, and the next hourly pass was free to move the
    // job off Waiting on the raws — the very thing the hold exists to stop.
    if (held) releaseHoldKey = waitingHoldKey(projectId);
  }

  const onBehalf = caller.office;
  const who = nameOf(editorKey);
  let outcome:
    | { kind: "replay" }
    | { kind: "noop" }
    | { kind: "started"; event: "START" | "RESUME"; switchedFrom: { projectId: string; street: string } | null; quietStart: boolean };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, `editor-desk:${editorKey}`);
      if (requestId && (await tx.editorWorkEvent.findUnique({ where: { requestId }, select: { id: true } }))) {
        return { kind: "replay" as const };
      }
      const now = new Date();
      const cur = await tx.editorWorkItem.findUnique({ where: { activeFor: editorKey } });
      if (cur && cur.projectId === projectId) {
        // Already on it: a second click, a second tab. Only the video pick may
        // change, and that is not an event.
        if (input.outputId !== undefined && (input.outputId ?? null) !== cur.outputId) {
          await tx.editorWorkItem.update({ where: { id: cur.id }, data: { outputId: input.outputId ?? null } });
        }
        return { kind: "noop" as const };
      }

      let switchedFrom: { projectId: string; street: string } | null = null;
      if (cur) {
        const from = await tx.project.findUnique({ where: { id: cur.projectId }, select: { title: true } });
        const fromStreet = streetOf(from?.title);
        const stillTheirs = (await holdersFor([cur.projectId], tx)).get(cur.projectId)?.has(editorKey) ?? false;
        if (stillTheirs) {
          await tx.editorWorkItem.update({
            where: { id: cur.id },
            data: { state: WORK_PAUSED, activeFor: null, pausedAt: now, lastEventAt: now },
          });
          await tx.editorWorkEvent.create({
            data: { itemId: cur.id, editorKey, projectId: cur.projectId, outputId: cur.outputId, kind: "AUTO_PAUSE", at: now, ...actorCols(caller.actor, onBehalf), switchedTo: projectId },
          });
          await tx.activity.create({
            data: { projectId: cur.projectId, type: "SYSTEM", body: `${who}'s editing paused — ${onBehalf ? `${caller.actor.name} switched them` : "switched"} to ${street}.` },
          });
          switchedFrom = { projectId: cur.projectId, street: fromStreet };
        } else {
          // A ghost: the job was reassigned away by a path that could not close
          // it (the task-card assignee, a merge). Close it now, truthfully.
          await closeItemsTx(tx, [cur], { reason: "REASSIGNED", actor: SYSTEM_ACTOR, detail: null, at: now });
        }
      }

      const existing = await tx.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey, projectId } } });
      const event: "START" | "RESUME" = existing?.state === WORK_PAUSED && existing.firstStartedAt ? "RESUME" : "START";
      // The next video on a job this editor already handed a cut in on: a fresh
      // stretch (START), but not news to the office — the job's first Start
      // rang once, and a four-video month must not ring four times (review
      // fix, Sep 25).
      const quietStart = existing?.state === WORK_CLOSED && existing.closeReason === "SUBMITTED" && !!existing.firstStartedAt;
      const outputId = input.outputId !== undefined ? input.outputId ?? null : existing?.outputId ?? null;
      const item = existing
        ? await tx.editorWorkItem.update({
            where: { id: existing.id },
            data: {
              state: WORK_ACTIVE, activeFor: editorKey, activeSince: now, firstStartedAt: existing.firstStartedAt ?? now,
              pausedAt: null, closedAt: null, closeReason: null, lastEventAt: now, outputId,
            },
          })
        : await tx.editorWorkItem.create({
            data: { editorKey, projectId, outputId, state: WORK_ACTIVE, activeFor: editorKey, activeSince: now, firstStartedAt: now, lastEventAt: now },
          });
      await tx.editorWorkEvent.create({
        data: {
          itemId: item.id, editorKey, projectId, outputId, kind: event, at: now, ...actorCols(caller.actor, onBehalf), requestId,
          reason: switchedFrom ? `paused ${switchedFrom.street}` : null,
        },
      });

      // THE LIFECYCLE, in the same transaction. Ready for editing (SHOT) — or a
      // Waiting row the office just moved on — becomes EDITING, and the human
      // write ends the office's status pin as the pill always did. REVIEW and
      // REVISION keep their words: a revision can be active without the job
      // stopping being a revision (the old pill wrote EDITING over REVISION and
      // the sweep put it straight back).
      if (project.status === "SHOT" || onWaiting) {
        await tx.project.update({ where: { id: projectId }, data: { status: "EDITING", statusPinnedAt: null } });
      }
      if (releaseHoldKey) await tx.appSetting.deleteMany({ where: { key: releaseHoldKey } });
      // The card follows the editor's start (OPEN → IN_PROGRESS, as the old
      // pill did) — and NOTHING ELSE. It used to set assignedManually too, to
      // stop mintEditTask's hourly re-route moving started work; but to every
      // other engine that flag means "a human hand-picked this editor", and it
      // took every started job out of Aryeo's cancel-when-the-video-is-removed,
      // the evidence close, the Review Room close and the orphan stand-down
      // (review fix, Sep 25). The re-route now skips a card whose editor holds
      // open work on the job (tasks.mintEditTask) — the pin that was meant.
      const liveCard = await editCardOf(projectId, tx);
      if (liveCard && liveCard.assignedKey === editorKey && liveCard.status === "OPEN") {
        await tx.smartTask.update({ where: { id: liveCard.id }, data: { status: "IN_PROGRESS" } });
      }
      const verb = event === "RESUME" ? "resumed" : "started";
      const tail = switchedFrom ? ` (paused ${switchedFrom.street})` : "";
      await tx.activity.create({
        data: {
          projectId, type: "SYSTEM",
          body: onBehalf ? `${caller.actor.name} ${verb} editing for ${who} (office correction)${tail}.` : `${who} ${verb} editing${tail}.`,
        },
      });
      return { kind: "started" as const, event, switchedFrom, quietStart };
    });
  } catch (e) {
    if (isP2002(e, "requestId") && requestId && (await prisma.editorWorkEvent.count({ where: { requestId } }))) {
      return { ok: true, message: "Already recorded.", replay: true };
    }
    if (isP2002(e)) return { ok: false, message: REFRESH_MSG };
    console.error("[editorWork] start failed", e);
    return { ok: false, message: "Couldn't start editing — nothing changed. Try again." };
  }

  if (outcome.kind === "replay") return { ok: true, message: "Already recorded.", replay: true };
  if (outcome.kind === "noop") return { ok: true, message: onBehalf ? `${who} is already on ${street}.` : `You're already on ${street}.` };

  // The office hears about a START, not a resume — the same dedupe intent the
  // pill's bell always had ("started editing" is news; picking it back up is not).
  if (outcome.event === "START" && !outcome.quietStart) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "edit_started",
        title: onBehalf ? `${caller.actor.name} started ${street} for ${who}` : `${who} started editing ${street}`,
        href: `/edit/${projectId}`,
        targets: [{ roles: ["OWNER", "ADMIN"] }],
      });
    } catch { /* bell is best-effort */ }
  }
  await revalidate(projectId, outcome.switchedFrom?.projectId);
  const paused = outcome.switchedFrom ? ` ${outcome.switchedFrom.street} is paused.` : "";
  return {
    ok: true,
    message: onBehalf
      ? `${who} is now editing ${street} (recorded as your correction).${paused}`
      : `${outcome.event === "RESUME" ? "Resumed" : "Started"} ${street}.${paused}`,
  };
}

/** Pause editing a job. Writes only the work layer and the timeline: the card,
 *  the assignment, the due date, the revision asks, the cuts and the outputs
 *  are exactly as they were (A62). Idempotent — pausing paused work writes
 *  nothing. */
export async function pauseEditing(input: { projectId: string; forEditorKey?: string | null; requestId?: string | null }): Promise<WorkResult> {
  const caller = await resolveCaller();
  if (!caller.ok) return { ok: false, message: caller.message };
  const requestId = cleanRequestId(input.requestId);
  const { projectId } = input;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };
  const street = streetOf(project.title);

  let editorKey: string | null = caller.ownKey;
  if (caller.office) {
    if (input.forEditorKey) editorKey = input.forEditorKey;
    else {
      const active = await prisma.editorWorkItem.findMany({ where: { projectId, state: WORK_ACTIVE }, select: { editorKey: true } });
      if (active.length > 1) return { ok: false, message: `More than one editor is on ${street} — pick whose work to pause.` };
      editorKey = active[0]?.editorKey ?? null;
      if (!editorKey) return { ok: true, message: `Nobody is actively editing ${street}.` };
    }
  }
  if (!editorKey) return { ok: false, message: "Only the editor on the job, or the office, can pause it." };
  const who = nameOf(editorKey);
  const onBehalf = caller.office;

  let changed = false;
  try {
    const r = await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, `editor-desk:${editorKey}`);
      if (requestId && (await tx.editorWorkEvent.findUnique({ where: { requestId }, select: { id: true } }))) return "replay" as const;
      const item = await tx.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey, projectId } } });
      if (!item || item.state !== WORK_ACTIVE) return "noop" as const;
      const now = new Date();
      await tx.editorWorkItem.update({ where: { id: item.id }, data: { state: WORK_PAUSED, activeFor: null, pausedAt: now, lastEventAt: now } });
      await tx.editorWorkEvent.create({
        data: { itemId: item.id, editorKey, projectId, outputId: item.outputId, kind: "PAUSE", at: now, ...actorCols(caller.actor, onBehalf), requestId },
      });
      await tx.activity.create({
        data: { projectId, type: "SYSTEM", body: onBehalf ? `${caller.actor.name} paused ${who}'s editing (office correction).` : `${who} paused editing.` },
      });
      return "paused" as const;
    });
    if (r === "replay") return { ok: true, message: "Already recorded.", replay: true };
    changed = r === "paused";
  } catch (e) {
    if (isP2002(e, "requestId")) return { ok: true, message: "Already recorded.", replay: true };
    console.error("[editorWork] pause failed", e);
    return { ok: false, message: "Couldn't pause — nothing changed. Try again." };
  }
  if (!changed) return { ok: true, message: onBehalf ? `${who} isn't actively on ${street}.` : `${street} isn't the job you're on — nothing to pause.` };
  await revalidate(projectId);
  return { ok: true, message: onBehalf ? `Paused ${who} on ${street} (recorded as your correction).` : `Paused ${street}. Everything on it stays as it was.` };
}

// ---- closing ------------------------------------------------------------------

type ItemRow = { id: string; editorKey: string; projectId: string; outputId: string | null; state: string };

const CLOSE_WORDS: Record<CloseReason, string> = {
  SUBMITTED: "cut submitted",
  REASSIGNED: "reassigned",
  UNASSIGNED: "unassigned",
  REMOVED: "taken off the Editing Room",
  PUT_BACK: "put back by the office",
  PROJECT_DELIVERED: "the job was delivered",
  PROJECT_CANCELLED: "the job was cancelled",
  MERGED: "the job's work was merged into another",
};

async function closeItemsTx(
  tx: Prisma.TransactionClient,
  items: ItemRow[],
  opts: { reason: CloseReason; actor: WorkActor; detail: string | null; at: Date },
): Promise<number> {
  let n = 0;
  for (const it of items) {
    if (it.state === WORK_CLOSED) continue;
    await tx.editorWorkItem.update({
      where: { id: it.id },
      data: { state: WORK_CLOSED, activeFor: null, closedAt: opts.at, closeReason: opts.reason, lastEventAt: opts.at },
    });
    await tx.editorWorkEvent.create({
      data: {
        itemId: it.id, editorKey: it.editorKey, projectId: it.projectId, outputId: it.outputId,
        kind: opts.reason === "SUBMITTED" ? "SUBMIT" : "CLOSE", at: opts.at,
        ...actorCols(opts.actor, opts.actor.role !== "SYSTEM" && opts.actor.role !== "EDITOR"),
        reason: opts.reason,
      },
    });
    await tx.activity.create({
      data: { projectId: it.projectId, type: "SYSTEM", body: `${nameOf(it.editorKey)}'s editing closed — ${opts.detail ?? CLOSE_WORDS[opts.reason]}.` },
    });
    n++;
  }
  return n;
}

/**
 * Close the open (ACTIVE or PAUSED) work on a job — every editor's, or one
 * editor's. The only thing an automatic path may do to this layer. Never
 * throws: every caller is a path whose own write has already landed, and a
 * failure here must not undo a delivery or a submit. History is kept (CLOSED
 * rows and their events stay).
 */
export async function closeActiveWork(
  projectId: string,
  opts: {
    editorKey?: string | null;
    reason: CloseReason;
    actor?: WorkActor;
    detail?: string | null;
    /** A hand-in of ONE video (review fix, Sep 25): an item the editor pointed
     *  at a DIFFERENT video stays open — Kim handing in a fix to video 1 is not
     *  the end of her stretch on video 3. An item with no video named, or a
     *  hand-in whose video is unknown (null/undefined), closes as before. */
    forOutputId?: string | null;
  },
): Promise<number> {
  try {
    const open = await prisma.editorWorkItem.findMany({
      where: {
        projectId, state: { not: WORK_CLOSED }, ...(opts.editorKey ? { editorKey: opts.editorKey } : {}),
        ...(opts.forOutputId ? { OR: [{ outputId: null }, { outputId: opts.forOutputId }] } : {}),
      },
      select: { editorKey: true },
    });
    if (open.length === 0) return 0;
    return await closeForEditors(projectId, [...new Set(open.map((o) => o.editorKey))], opts);
  } catch (e) {
    console.error("[editorWork] close failed", projectId, opts.reason, e);
    return 0;
  }
}

async function closeForEditors(
  projectId: string,
  keys: string[],
  opts: { reason: CloseReason; actor?: WorkActor; detail?: string | null; forOutputId?: string | null },
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Sorted, so two closers never take the same two locks in opposite orders.
    for (const k of [...keys].sort()) await lockAdvisory(tx, `editor-desk:${k}`);
    const items = await tx.editorWorkItem.findMany({
      where: {
        projectId, editorKey: { in: keys }, state: { not: WORK_CLOSED },
        ...(opts.forOutputId ? { OR: [{ outputId: null }, { outputId: opts.forOutputId }] } : {}),
      },
      select: { id: true, editorKey: true, projectId: true, outputId: true, state: true },
    });
    return closeItemsTx(tx, items, { reason: opts.reason, actor: opts.actor ?? SYSTEM_ACTOR, detail: opts.detail ?? null, at: new Date() });
  });
}

/**
 * Close work whose editor no longer holds the job — after a reassign, an
 * unassign, a merge, or a card the evidence closed. The hourly card refresh
 * calls this too (mintEditTask), so a path that moved work without knowing
 * about this layer is caught within the hour, and the readers below already
 * leave a ghost out of every "who is on it" answer in the meantime.
 */
export async function closeGhostWork(
  projectId: string,
  opts: { reason?: CloseReason; actor?: WorkActor; detail?: string | null } = {},
): Promise<number> {
  try {
    const open = await prisma.editorWorkItem.findMany({ where: { projectId, state: { not: WORK_CLOSED } }, select: { editorKey: true } });
    if (open.length === 0) return 0;
    const holders = (await holdersFor([projectId])).get(projectId) ?? new Set<string>();
    const ghosts = [...new Set(open.map((o) => o.editorKey))].filter((k) => !holders.has(k));
    if (ghosts.length === 0) return 0;
    return await closeForEditors(projectId, ghosts, { reason: opts.reason ?? "REASSIGNED", actor: opts.actor, detail: opts.detail });
  } catch (e) {
    console.error("[editorWork] ghost close failed", projectId, e);
    return 0;
  }
}

// ---- the one-time confirm (historical EDITING rows) ---------------------------

/**
 * Historical EDITING rows carry no editor identity or start time — only the
 * card's assignee and, since Sep 10, a "<name> started editing." line. Nothing
 * is backfilled and no start time is invented: those rows show as "claimed —
 * not confirmed" until the editor says, once, which one they are on.
 *
 * `projectId` null = "none of them". The pick becomes ACTIVE (firstStartedAt =
 * now, the moment they said so); every other unconfirmed claim of theirs
 * becomes PAUSED with firstStartedAt null (never started in this layer).
 * Project.status is never rewritten, so payroll and the sweep are unchanged.
 */
export async function confirmCurrentWork(input: { projectId: string | null; requestId?: string | null }): Promise<WorkResult> {
  const caller = await resolveCaller();
  if (!caller.ok) return { ok: false, message: caller.message };
  if (caller.office || !caller.ownKey) return { ok: false, message: "Only the editor can say which job they're on." };
  const editorKey = caller.ownKey;
  const requestId = cleanRequestId(input.requestId);
  const claims = await unconfirmedClaimsFor(editorKey);
  if (input.projectId && !claims.some((c) => c.projectId === input.projectId)) {
    // Not a legacy claim (any more): the ordinary Start is the right door.
    return startEditing({ projectId: input.projectId, requestId });
  }
  if (claims.length === 0) return { ok: true, message: "Nothing to confirm." };
  const who = nameOf(editorKey);
  try {
    const r = await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, `editor-desk:${editorKey}`);
      if (requestId && (await tx.editorWorkEvent.findUnique({ where: { requestId }, select: { id: true } }))) return "replay" as const;
      const now = new Date();
      // Re-derive inside the lock: a claim somebody confirmed in another tab is
      // no longer a claim (it has a row now).
      const withRows = new Set(
        (await tx.editorWorkItem.findMany({ where: { projectId: { in: claims.map((c) => c.projectId) } }, select: { projectId: true } })).map((x) => x.projectId),
      );
      const live = claims.filter((c) => !withRows.has(c.projectId));
      if (input.projectId && live.some((c) => c.projectId === input.projectId)) {
        const cur = await tx.editorWorkItem.findUnique({ where: { activeFor: editorKey } });
        if (cur) {
          await tx.editorWorkItem.update({ where: { id: cur.id }, data: { state: WORK_PAUSED, activeFor: null, pausedAt: now, lastEventAt: now } });
          await tx.editorWorkEvent.create({ data: { itemId: cur.id, editorKey, projectId: cur.projectId, outputId: cur.outputId, kind: "AUTO_PAUSE", at: now, ...actorCols(caller.actor, false), switchedTo: input.projectId } });
          await tx.activity.create({
            data: { projectId: cur.projectId, type: "SYSTEM", body: `${who}'s editing paused — confirmed ${live.find((c) => c.projectId === input.projectId)?.street ?? "another job"} as the one they're on.` },
          });
        }
      }
      let first = true;
      for (const c of live) {
        const picked = c.projectId === input.projectId;
        const item = await tx.editorWorkItem.create({
          data: {
            editorKey, projectId: c.projectId, state: picked ? WORK_ACTIVE : WORK_PAUSED, activeFor: picked ? editorKey : null,
            firstStartedAt: picked ? now : null, activeSince: picked ? now : null, pausedAt: picked ? null : now, lastEventAt: now,
          },
        });
        await tx.editorWorkEvent.create({
          data: {
            itemId: item.id, editorKey, projectId: c.projectId, kind: picked ? "CONFIRM" : "CONFIRM_PAUSED", at: now, ...actorCols(caller.actor, false),
            // One request, several events: the id rides the first only.
            requestId: first ? requestId : null,
          },
        });
        first = false;
        await tx.activity.create({
          data: { projectId: c.projectId, type: "SYSTEM", body: picked ? `${who} confirmed this is the job they're editing now.` : `${who} confirmed this job is paused — not the one they're on.` },
        });
      }
      return "done" as const;
    });
    if (r === "replay") return { ok: true, message: "Already recorded.", replay: true };
  } catch (e) {
    if (isP2002(e, "requestId")) return { ok: true, message: "Already recorded.", replay: true };
    if (isP2002(e)) return { ok: false, message: REFRESH_MSG };
    console.error("[editorWork] confirm failed", e);
    return { ok: false, message: "Couldn't save that — nothing changed. Try again." };
  }
  for (const c of claims) await revalidate(c.projectId);
  return { ok: true, message: input.projectId ? "Thanks — that's the one you're on; the others are paused." : "Thanks — they're all marked paused." };
}

export type UnconfirmedClaim = { projectId: string; street: string; claimedAt: string | null };

/** Derived, never stored: an EDITING job with no work row at all, whose live
 *  edit card is this editor's. The claim date is the Activity line's, when the
 *  old pill wrote one — never a guess. */
export async function unconfirmedClaimsFor(editorKey: string | null, db: Db = prisma): Promise<UnconfirmedClaim[]> {
  const all = await unconfirmedClaims(db);
  return editorKey ? all.filter((c) => c.editorKey === editorKey) : [];
}

/**
 * When the Start button began being used (§7.1): the first event this layer
 * ever logged. Measured, not a guessed deploy date — before it, every EDITING
 * row is history; after it, an office pin (saveEditOverrides stamps
 * statusPinnedAt) or a board move (moveProjectStatus writes a STATUS_CHANGE
 * line) is the office's word on the stage, not a claim from history. The
 * one-time "which one are you on?" prompt re-asked about every such move with
 * words saying it predated the button, which was untrue (review fix, Sep 25).
 * Those rows still read "In editing — not confirmed", and their own Start
 * answers them. Null = the layer has never been used: everything is history.
 */
async function startButtonSince(db: Db): Promise<Date | null> {
  const r = await db.editorWorkEvent.aggregate({ _min: { at: true } }).catch(() => null);
  return r?._min.at ?? null;
}

async function unconfirmedClaims(db: Db = prisma): Promise<(UnconfirmedClaim & { editorKey: string })[]> {
  const since = await startButtonSince(db);
  const cards = await db.smartTask.findMany({
    where: {
      taskType: "edit_video", status: OPEN_TASK, assignedKey: { in: [...WORK_EDITOR_KEYS] },
      project: { status: "EDITING", ...(since ? { OR: [{ statusPinnedAt: null }, { statusPinnedAt: { lt: since } }] } : {}) },
    },
    select: { projectId: true, assignedKey: true, project: { select: { title: true } } },
  });
  const ids = cards.map((c) => c.projectId).filter((x): x is string => !!x);
  if (ids.length === 0) return [];
  const withRows = new Set((await db.editorWorkItem.findMany({ where: { projectId: { in: ids } }, select: { projectId: true } })).map((r) => r.projectId));
  const movedSince = since
    ? new Set(
        (await db.activity.findMany({ where: { projectId: { in: ids }, type: "STATUS_CHANGE", createdAt: { gte: since } }, select: { projectId: true } }))
          .map((a) => a.projectId),
      )
    : new Set<string>();
  const open = cards.filter((c) => c.projectId && !withRows.has(c.projectId) && !movedSince.has(c.projectId));
  if (open.length === 0) return [];
  const lines = await db.activity.findMany({
    where: { projectId: { in: open.map((c) => c.projectId as string) }, body: { endsWith: "started editing." } },
    orderBy: { createdAt: "desc" },
    select: { projectId: true, createdAt: true },
  });
  const claimed = new Map<string, Date>();
  for (const l of lines) if (l.projectId && !claimed.has(l.projectId)) claimed.set(l.projectId, l.createdAt);
  return open.map((c) => ({
    projectId: c.projectId as string,
    editorKey: c.assignedKey as string,
    street: streetOf(c.project?.title),
    claimedAt: claimed.get(c.projectId as string)?.toISOString() ?? null,
  }));
}

// ---- reading it back ----------------------------------------------------------

export type WorkPerson = {
  editorKey: string;
  name: string;
  outputId: string | null;
  outputTitle: string | null;
  /** ACTIVE: when this stretch started; PAUSED: when it paused. */
  sinceISO: string | null;
  firstStartedISO: string | null;
  lastEventISO: string;
  lastEventKind: string | null;
  /** The office person who made the last move for them, when it was the office. */
  onBehalfBy: string | null;
};
export type ProjectWork = { active: WorkPerson[]; paused: WorkPerson[] };

/**
 * THE one reader of "is anyone editing this now", batched: the queue, the
 * video-state line Kyle's QC card and Ops Day print, the edit page's tracker and
 * the office's Working-now panel all ask here. A row whose editor no longer
 * holds the job (a reassign the closer has not caught yet) is left out rather
 * than shown as somebody's live work.
 */
export async function workStateFor(projectIds: string[]): Promise<Map<string, ProjectWork>> {
  const out = new Map<string, ProjectWork>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return out;
  const items = await prisma.editorWorkItem.findMany({
    where: { projectId: { in: ids }, state: { in: [WORK_ACTIVE, WORK_PAUSED] } },
    orderBy: { lastEventAt: "desc" },
  });
  if (items.length === 0) return out;
  const touched = [...new Set(items.map((i) => i.projectId))];
  const [holders, events, outputs] = await Promise.all([
    holdersFor(touched),
    prisma.editorWorkEvent.findMany({
      where: { itemId: { in: items.map((i) => i.id) } },
      orderBy: { at: "desc" },
      distinct: ["itemId"],
      select: { itemId: true, kind: true, onBehalf: true, actorName: true },
    }),
    prisma.deliverableOutput.findMany({
      where: { id: { in: items.map((i) => i.outputId).filter((x): x is string => !!x) } },
      select: { id: true, title: true, slot: true },
    }),
  ]);
  const lastEvent = new Map(events.map((e) => [e.itemId, e]));
  const outTitle = new Map(outputs.map((o) => [o.id, o.title?.trim() || `Video ${o.slot}`]));
  for (const it of items) {
    if (!holders.get(it.projectId)?.has(it.editorKey)) continue; // a ghost — see closeGhostWork
    const ev = lastEvent.get(it.id);
    const p: WorkPerson = {
      editorKey: it.editorKey,
      name: nameOf(it.editorKey),
      outputId: it.outputId,
      outputTitle: it.outputId ? outTitle.get(it.outputId) ?? null : null,
      sinceISO: (it.state === WORK_ACTIVE ? it.activeSince : it.pausedAt)?.toISOString() ?? null,
      firstStartedISO: it.firstStartedAt?.toISOString() ?? null,
      lastEventISO: it.lastEventAt.toISOString(),
      lastEventKind: ev?.kind ?? null,
      onBehalfBy: ev?.onBehalf ? ev.actorName : null,
    };
    const w = out.get(it.projectId) ?? { active: [], paused: [] };
    (it.state === WORK_ACTIVE ? w.active : w.paused).push(p);
    out.set(it.projectId, w);
  }
  return out;
}

export type DeskItem = {
  projectId: string;
  street: string;
  outputTitle: string | null;
  sinceISO: string | null;
  firstStartedISO: string | null;
  lastEventISO: string;
  lastEventKind: string | null;
  onBehalfBy: string | null;
  dueISO: string | null;
  revisionOpen: boolean;
};
export type EditorDesk = {
  key: string;
  name: string;
  active: DeskItem | null;
  paused: DeskItem[];
  unconfirmed: UnconfirmedClaim[];
};
export type WorkingNow = { ok: true; readAt: string; editors: EditorDesk[] } | { ok: false; readAt: string; error: string };

/**
 * The office's "Working now": one line per editor with what they said they are
 * on, since when, and what they have paused. A failed read says it failed — it
 * never comes back as an empty board that reads "nobody is working". Reading it
 * writes nothing (the unconfirmed claims are derived).
 */
export async function workingNow(opts: { now?: Date } = {}): Promise<WorkingNow> {
  const readAt = (opts.now ?? new Date()).toISOString();
  try {
    const items = await prisma.editorWorkItem.findMany({ where: { state: { in: [WORK_ACTIVE, WORK_PAUSED] } }, select: { projectId: true } });
    const ids = [...new Set(items.map((i) => i.projectId))];
    const [work, claims, projects, revisions] = await Promise.all([
      workStateFor(ids),
      unconfirmedClaims(),
      prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, deliveryDue: true, dueOverrideAt: true } }),
      prisma.smartTask.findMany({ where: { projectId: { in: ids }, taskType: "revision", status: OPEN_TASK }, select: { projectId: true } }),
    ]);
    const proj = new Map(projects.map((p) => [p.id, p]));
    const revOpen = new Set(revisions.map((r) => r.projectId));
    const desks = new Map<string, EditorDesk>();
    const desk = (key: string) => {
      let d = desks.get(key);
      if (!d) desks.set(key, (d = { key, name: nameOf(key), active: null, paused: [], unconfirmed: [] }));
      return d;
    };
    for (const k of DESK_EDITOR_KEYS) desk(k);
    for (const [pid, w] of work) {
      const p = proj.get(pid);
      const base = { projectId: pid, street: streetOf(p?.title), dueISO: (p?.dueOverrideAt ?? p?.deliveryDue)?.toISOString() ?? null, revisionOpen: revOpen.has(pid) };
      const toItem = (x: WorkPerson): DeskItem => ({
        ...base, outputTitle: x.outputTitle, sinceISO: x.sinceISO, firstStartedISO: x.firstStartedISO,
        lastEventISO: x.lastEventISO, lastEventKind: x.lastEventKind, onBehalfBy: x.onBehalfBy,
      });
      for (const a of w.active) desk(a.editorKey).active = toItem(a);
      for (const x of w.paused) desk(x.editorKey).paused.push(toItem(x));
    }
    for (const c of claims) desk(c.editorKey).unconfirmed.push({ projectId: c.projectId, street: c.street, claimedAt: c.claimedAt });
    for (const d of desks.values()) d.paused.sort((a, b) => (b.sinceISO ?? "").localeCompare(a.sinceISO ?? ""));
    const order = (k: string) => (DESK_EDITOR_KEYS.includes(k) ? DESK_EDITOR_KEYS.indexOf(k) : 99);
    return { ok: true, readAt, editors: [...desks.values()].sort((a, b) => order(a.key) - order(b.key) || a.name.localeCompare(b.name)) };
  } catch (e) {
    console.error("[editorWork] workingNow read failed", e);
    return { ok: false, readAt, error: "Couldn't read who is working right now." };
  }
}

/** One editor's own desk, for their queue banner and the edit page. */
export async function myDesk(editorKey: string): Promise<{ active: { projectId: string; street: string; sinceISO: string | null; outputTitle: string | null } | null; unconfirmed: UnconfirmedClaim[] }> {
  const cur = await prisma.editorWorkItem.findUnique({ where: { activeFor: editorKey } });
  let active: { projectId: string; street: string; sinceISO: string | null; outputTitle: string | null } | null = null;
  if (cur) {
    const w = (await workStateFor([cur.projectId])).get(cur.projectId);
    const me = w?.active.find((a) => a.editorKey === editorKey);
    if (me) {
      const p = await prisma.project.findUnique({ where: { id: cur.projectId }, select: { title: true } });
      active = { projectId: cur.projectId, street: streetOf(p?.title), sinceISO: me.sinceISO, outputTitle: me.outputTitle };
    }
  }
  return { active, unconfirmed: await unconfirmedClaimsFor(editorKey) };
}

export type WorkBar = {
  projectId: string;
  street: string;
  /** editor = the assigned editor's own buttons; office = labelled corrections;
   *  view = read-only (a "view as" preview, a photographer, anyone else). */
  mode: "editor" | "office" | "view";
  /** The viewer's own work on this job (editor mode). */
  mine: { state: "ACTIVE" | "PAUSED" | null; sinceISO: string | null; outputId: string | null };
  /** The editor's active job somewhere else — Start here pauses it. */
  elsewhere: { projectId: string; street: string } | null;
  people: ProjectWork;
  /** Editor mode: may they start it at all, and if not, why in their words. */
  canStart: boolean;
  blocked: string | null;
  /** Office mode: whose work a correction would be (the card's editor). */
  assignee: { key: string; name: string } | null;
  /** The live videos of a multi-video job, for the optional picker. */
  outputs: { id: string; title: string }[];
  /** For the tracker's words (EditTracker.deriveEditStage). */
  stageWork: "active" | "paused" | null;
};

/** Everything the edit page's Start / Pause / Resume bar needs, in one read. */
export async function workBarFor(
  projectId: string,
  viewer: { role: string; realRole: string; editorKey: string | null; impersonating: boolean } | null,
): Promise<WorkBar | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, status: true } });
  if (!project || project.status === "CANCELLED") return null;
  const { authEnforced } = await import("@/lib/auth/guards");
  const mode: WorkBar["mode"] = !viewer
    ? authEnforced() ? "view" : "office"
    : viewer.impersonating ? "view"
    : viewer.realRole === "OWNER" || viewer.realRole === "ADMIN" ? "office"
    : viewer.realRole === "EDITOR" && viewer.editorKey && WORK_EDITOR_KEYS.includes(viewer.editorKey) ? "editor"
    : "view";
  const [work, holders, card, outs] = await Promise.all([
    workStateFor([projectId]),
    holdersFor([projectId]),
    editCardOf(projectId),
    prisma.deliverableOutput.findMany({
      where: { projectId, category: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null, approvedSubmissionId: null },
      orderBy: [{ deliverableId: "asc" }, { slot: "asc" }],
      select: { id: true, title: true, slot: true },
    }),
  ]);
  const people = work.get(projectId) ?? { active: [], paused: [] };
  const held = holders.get(projectId) ?? new Set<string>();
  const key = mode === "editor" ? viewer!.editorKey! : null;
  const mineRow = key ? await prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: key, projectId } } }) : null;
  const mineLive = mineRow && mineRow.state !== WORK_CLOSED && (people.active.concat(people.paused).some((p) => p.editorKey === key)) ? mineRow : null;
  let elsewhere: WorkBar["elsewhere"] = null;
  if (key) {
    const cur = await prisma.editorWorkItem.findUnique({ where: { activeFor: key }, select: { projectId: true } });
    if (cur && cur.projectId !== projectId) {
      const p = await prisma.project.findUnique({ where: { id: cur.projectId }, select: { title: true } });
      elsewhere = { projectId: cur.projectId, street: streetOf(p?.title) };
    }
  }
  let blocked: string | null = null;
  if (mode === "editor" && key && !held.has(key)) {
    const owner = card?.assignedKey ? nameOf(card.assignedKey) : null;
    blocked = owner ? `Assigned to ${owner} — not yours to start.` : "Not assigned to you yet — the office hands it over.";
  } else if (mode === "editor" && (project.status === "BOOKED" || project.status === "SCHEDULED")) {
    const { loadWaitingHolds } = await import("@/lib/queueWaiting");
    if ((await loadWaitingHolds([projectId])).has(projectId)) blocked = "Held in Waiting by the office — it can't be started until the footage is in.";
  }
  const assigneeKey = card?.assignedKey && WORK_EDITOR_KEYS.includes(card.assignedKey) ? card.assignedKey : held.size === 1 ? [...held][0] : null;
  return {
    projectId,
    street: streetOf(project.title),
    mode,
    mine: {
      state: mineLive ? (mineLive.state as "ACTIVE" | "PAUSED") : null,
      sinceISO: (mineLive?.state === WORK_ACTIVE ? mineLive.activeSince : mineLive?.pausedAt)?.toISOString() ?? null,
      outputId: mineLive?.outputId ?? null,
    },
    elsewhere,
    people,
    canStart: mode === "editor" ? !blocked : mode === "office" ? !!assigneeKey : false,
    blocked,
    assignee: assigneeKey ? { key: assigneeKey, name: nameOf(assigneeKey) } : null,
    outputs: outs.length > 1 ? outs.map((o) => ({ id: o.id, title: o.title?.trim() || `Video ${o.slot}` })) : [],
    stageWork: people.active.length ? "active" : people.paused.length ? "paused" : null,
  };
}

// ---- words --------------------------------------------------------------------

/** "10:02am" today, "Sep 24 3:10pm" otherwise — Eastern, like every clock here. */
export function workClock(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = etTime(d).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  return etDayKey(d) === etDayKey(now) ? t : `${etMonthDay(d)} ${t}`;
}

const names = (xs: WorkPerson[]) => xs.map((x) => x.name).join(", ");

/**
 * The row's words from the two axes. Pure, so a drill can walk every
 * combination. `lifecycle` is the queue ladder's status code (SHOT, EDITING,
 * REVIEW, REVISION, APPROVED, DELIVERED, BOOKED, SCHEDULED).
 *
 *   SHOT/EDITING + someone active  → "In editing"
 *   SHOT/EDITING + only paused     → "Paused"
 *   SHOT + nobody                  → "Ready for editing"
 *   EDITING + nobody               → "In editing — not confirmed" (a legacy
 *                                    claim, an office pin, a board move)
 *   anything else                  → its own word, plus a chip naming who is on
 *                                    it or who paused it
 *
 * "In editing" never appears without somebody ACTIVE, except in the explicit
 * "not confirmed" words.
 */
export function workLabel(
  lifecycle: string,
  work: ProjectWork | null | undefined,
  opts: { baseLabel?: string; now?: Date } = {},
): { label: string; chip: string | null } {
  const active = work?.active ?? [];
  const paused = work?.paused ?? [];
  const now = opts.now ?? new Date();
  const since = (xs: WorkPerson[]) => (xs.length === 1 && xs[0].sinceISO ? ` since ${workClock(xs[0].sinceISO, now)}` : "");
  const activeChip = active.length ? `Active — ${names(active)}${since(active)}` : null;
  const pausedChip = paused.length ? `Paused — ${names(paused)}${paused.length === 1 && paused[0].sinceISO ? ` ${workClock(paused[0].sinceISO, now)}` : ""}` : null;
  if (lifecycle === "SHOT" || lifecycle === "EDITING") {
    if (active.length) return { label: "In editing", chip: `${names(active)}${since(active)}` };
    if (paused.length) return { label: "Paused", chip: pausedChip };
    return lifecycle === "SHOT" ? { label: "Ready for editing", chip: null } : { label: "In editing — not confirmed", chip: null };
  }
  return { label: opts.baseLabel ?? lifecycle, chip: activeChip ?? pausedChip };
}

// ---- small things -------------------------------------------------------------

function actorCols(actor: WorkActor, onBehalf: boolean) {
  return { actorUserId: actor.userId, actorName: actor.name.slice(0, 120), actorRole: actor.role, onBehalf };
}

function cleanRequestId(id: string | null | undefined): string | null {
  const s = typeof id === "string" ? id.trim().slice(0, 128) : "";
  return s || null;
}

/** A fresh request id for a server-side caller that has none of its own. */
export const newWorkRequestId = (prefix = "srv") => `${prefix}:${randomUUID()}`;

async function revalidate(projectId: string, other?: string | null) {
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/editing");
    revalidatePath(`/edit/${projectId}`);
    if (other) revalidatePath(`/edit/${other}`);
  } catch { /* outside a request (a sweep, a drill) there is nothing to refresh */ }
}

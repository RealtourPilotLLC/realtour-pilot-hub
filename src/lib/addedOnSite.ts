import "server-only";
import { prisma } from "@/lib/prisma";
import { itemFromTaskTitle, shootAddonKeyPrefix, streetOf } from "@/app/upload/shootAddOns";
import { serviceOfAddonItem, type ServiceKey } from "@/lib/sharedShootCore";

// ---------------------------------------------------------------------------
// A SERVICE ADDED ON SITE (Oct 23 2026, Jordan via the upload-page build: "a
// photographer can add a service that wasn't ordered ... the added service
// then appears in 'What did you capture?' with its own fields. Another video
// means another instruction section for that video").
//
// THE PATH IS THE ONE THAT EXISTS. An addition is the "Added at the shoot"
// card (upload/actions addShootAddOn): one "Add to the order: <item>" task on
// Kyle's desk. Kyle adds the line in Aryeo, the order reconcile makes the
// deliverable row and closes the card (integrations/aryeo
// completeShootAddonTasksFor). Billing, the office's approval and pay are
// that path's, unchanged: nothing here makes a deliverable, a slot, a price
// or a pay line.
//
// SO AN ADDED VIDEO HAS NO ROW UNTIL THE OFFICE ADDS IT. Its instructions are
// still written now, on the page, and kept here until the row exists:
//   AuditLog action "upload_added_video", target = the job,
//   id "upl-addvid:<job>:<task>:v<version>", detail = { taskId, item, text,
//   knownVideoKeys (the job's video keys when it was written), attachedKey }.
// When the job's video list grows a video that was not there when the words
// were written, the words go onto it (video 1's field when it is the job's
// first video, else that video's own row: lib/perVideoInstructions), once,
// and the record says where (attachVideoInstructions). Nothing is lost and
// nothing is written over: a video that already has words of its own keeps
// them.
// ---------------------------------------------------------------------------

export type AddedService = {
  taskId: string;
  item: string;
  service: ServiceKey | null;
  note: string | null;
  addedBy: string | null;
  addedAtISO: string;
  /** the office closed the card (normally: the line is on the order now) */
  handled: boolean;
};

/** Everything logged as added at the shoot on this job (withdrawn ones left out). */
export async function addedServicesFor(projectId: string): Promise<AddedService[]> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
  const rows = await prisma.smartTask
    .findMany({
      where: { projectId, dedupeKey: { startsWith: shootAddonKeyPrefix(projectId) }, status: { not: "CANCELLED" } },
      select: { id: true, title: true, description: true, contactName: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);
  const street = streetOf(p?.title);
  return rows.map((t) => {
    const item = itemFromTaskTitle(t.title, street);
    return { taskId: t.id, item, service: serviceOfAddonItem(item), note: t.description, addedBy: t.contactName, addedAtISO: t.createdAt.toISOString(), handled: t.status === "COMPLETED" };
  });
}

export const ADDED_VIDEO_ACTION = "upload_added_video";
const rowId = (projectId: string, taskId: string, v: number) => `upl-addvid:${projectId}:${taskId}:v${v}`;

export type AddedVideoRecord = {
  taskId: string;
  item: string;
  text: string;
  version: number;
  byName: string;
  atISO: string;
  knownVideoKeys: string[];
  attachedKey: string | null;
  attachedAtISO: string | null;
};

function parse(detail: string): AddedVideoRecord | null {
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    if (typeof o.taskId !== "string" || typeof o.version !== "number") return null;
    return {
      taskId: o.taskId,
      item: typeof o.item === "string" ? o.item : "Video added on site",
      text: typeof o.text === "string" ? o.text : "",
      version: o.version,
      byName: typeof o.byName === "string" ? o.byName : "the photographer",
      atISO: typeof o.atISO === "string" ? o.atISO : new Date(0).toISOString(),
      knownVideoKeys: Array.isArray(o.knownVideoKeys) ? o.knownVideoKeys.filter((k): k is string => typeof k === "string") : [],
      attachedKey: typeof o.attachedKey === "string" ? o.attachedKey : null,
      attachedAtISO: typeof o.attachedAtISO === "string" ? o.attachedAtISO : null,
    };
  } catch {
    return null;
  }
}

/** The newest record for each added video on this job. */
export async function addedVideoRecords(projectId: string): Promise<Map<string, AddedVideoRecord>> {
  const rows = await prisma.auditLog.findMany({ where: { action: ADDED_VIDEO_ACTION, target: projectId }, select: { detail: true } }).catch(() => []);
  const out = new Map<string, AddedVideoRecord>();
  for (const r of rows) {
    const x = parse(r.detail);
    if (!x) continue;
    const cur = out.get(x.taskId);
    if (!cur || x.version > cur.version) out.set(x.taskId, x);
  }
  return out;
}

async function writeRecord(projectId: string, actor: string, next: AddedVideoRecord): Promise<boolean> {
  try {
    await prisma.auditLog.create({ data: { id: rowId(projectId, next.taskId, next.version), actor, action: ADDED_VIDEO_ACTION, target: projectId, detail: JSON.stringify(next) } });
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return false;
    throw e;
  }
}

/**
 * Save the instructions written for a video added on site. Once it has been
 * attached to its video row, the words are that video's like any other, and
 * this saves them there instead (the submit's later-video path).
 */
export async function saveAddedVideoInstructions(
  projectId: string,
  input: { taskId: string; text: string; byName: string; actor: string },
): Promise<{ ok: boolean; message: string; attachedKey?: string | null }> {
  const task = await prisma.smartTask.findUnique({ where: { id: input.taskId }, select: { projectId: true, dedupeKey: true, status: true, title: true } });
  if (!task || task.projectId !== projectId || !task.dedupeKey?.startsWith(shootAddonKeyPrefix(projectId))) return { ok: false, message: "That added video isn't on this job." };
  if (task.status === "CANCELLED") return { ok: false, message: "That added video was taken back off the job." };
  const text = (input.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 6000);
  const { videoInstructionsFor } = await import("@/lib/deliverableOutputs");
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = (await addedVideoRecords(projectId)).get(input.taskId) ?? null;
    if (cur && cur.text === text) return { ok: true, message: "Saved.", attachedKey: cur.attachedKey };
    if (cur?.attachedKey) {
      // Already the video's own words: save them where the video reads them.
      const rows = await videoInstructionsFor(projectId).catch(() => []);
      const row = rows.find((r) => r.key === cur.attachedKey);
      if (row && row.number > 1) {
        const { saveLaterVideoInstructions } = await import("@/lib/deliverableOutputs");
        await saveLaterVideoInstructions(projectId, { [row.key]: text }, input.byName);
      } else if (row && row.number === 1) {
        await prisma.project.update({ where: { id: projectId }, data: { videoInstructions: text || null } });
      }
    }
    const known = cur?.knownVideoKeys.length ? cur.knownVideoKeys : (await videoInstructionsFor(projectId).catch(() => [])).map((r) => r.key);
    const next: AddedVideoRecord = {
      taskId: input.taskId,
      item: cur?.item ?? itemFromTaskTitle(task.title, streetOf((await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } }))?.title)),
      text,
      version: (cur?.version ?? 0) + 1,
      byName: input.byName,
      atISO: new Date().toISOString(),
      knownVideoKeys: known,
      attachedKey: cur?.attachedKey ?? null,
      attachedAtISO: cur?.attachedAtISO ?? null,
    };
    if (await writeRecord(projectId, input.actor, next)) {
      if (!cur) {
        await prisma.activity
          .create({ data: { projectId, type: "NOTE", body: `Instructions written by ${input.byName} for a video added at the shoot (waiting for the office to add it to the order). They join that video when it is on the job.` } })
          .catch(() => {});
      }
      return { ok: true, message: "Saved.", attachedKey: next.attachedKey };
    }
  }
  return { ok: false, message: "Those instructions kept changing in another tab. Reload and try again." };
}

/**
 * Put the words written for videos added on site onto the job's videos that
 * appeared since (the office added them to the order). Idempotent and safe to
 * call from any reader: it does nothing when nothing is waiting. Returns the
 * video keys written.
 */
export async function attachAddedVideoInstructions(projectId: string, actor = "the hub"): Promise<string[]> {
  const records = [...(await addedVideoRecords(projectId)).values()].filter((r) => !r.attachedKey && r.text.trim());
  if (!records.length) return [];
  const tasks = await prisma.smartTask.findMany({ where: { id: { in: records.map((r) => r.taskId) } }, select: { id: true, status: true } });
  const live = new Map(tasks.map((t) => [t.id, t.status]));
  const waiting = records.filter((r) => live.has(r.taskId) && live.get(r.taskId) !== "CANCELLED").sort((a, b) => Date.parse(a.atISO) - Date.parse(b.atISO));
  if (!waiting.length) return [];
  const { videoInstructionsFor, saveLaterVideoInstructions, ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
  let rows = await videoInstructionsFor(projectId).catch(() => []);
  const all = await addedVideoRecords(projectId);
  const claimed = new Set([...all.values()].map((r) => r.attachedKey).filter((k): k is string => !!k));
  const written: string[] = [];
  for (const rec of waiting) {
    const known = new Set(rec.knownVideoKeys);
    let row = rows.find((r) => !known.has(r.key) && !claimed.has(r.key) && !r.own?.trim());
    if (!row) continue;
    if (row.number > 1 && !row.outputId) {
      await ensureOutputsSafely(projectId, "added-video-instructions");
      rows = await videoInstructionsFor(projectId).catch(() => rows);
      row = rows.find((r) => r.key === row!.key) ?? row;
    }
    if (row.number === 1) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { videoInstructions: true } });
      if (p?.videoInstructions?.trim()) { claimed.add(row.key); continue; }
      await prisma.project.update({ where: { id: projectId }, data: { videoInstructions: rec.text } });
    } else {
      const saved = await saveLaterVideoInstructions(projectId, { [row.key]: rec.text }, rec.byName);
      if (!saved.includes(row.key)) continue;
    }
    claimed.add(row.key);
    const next: AddedVideoRecord = { ...rec, version: rec.version + 1, attachedKey: row.key, attachedAtISO: new Date().toISOString() };
    if (await writeRecord(projectId, actor, next)) {
      written.push(row.key);
      await prisma.activity
        .create({ data: { projectId, type: "NOTE", body: `The instructions ${rec.byName} wrote on site for "${rec.item}" are now video ${row.number}'s (${row.label}).` } })
        .catch(() => {});
    }
  }
  return written;
}

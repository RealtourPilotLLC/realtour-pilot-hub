import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import {
  CONTRIBUTION_ACTION, SHARED_NOTE_ACTION, SHARED_NOTE_CAP, contributionRowId, sharedNoteRowId,
  foldSharedNotes, latestContributions, parseSharedNoteVersion, rosterOf, staleSaveMessage, isServiceKey,
  type Contribution, type ContributionSubmit, type RosterMember, type ServiceKey, type SharedNote, type SharedNoteVersion,
} from "@/lib/sharedShootCore";

// ---------------------------------------------------------------------------
// SHARED SHOOTS: THE DATABASE HALF (Oct 23 2026). The rules are in
// lib/sharedShootCore; this reads and writes them.
//
// NO NEW TABLE. Both records ride AuditLog, the hub's typed event store
// (the upload page's own attempt receipts, video delivery choices and Dropbox
// backups already live there, keyed by action + target):
//   · a person's contribution: action "upload_contribution", target = the job,
//     id "upl-contrib:<job>:<member>:<version>", detail = that version;
//   · a shared instruction: action "upload_shared_note", target = the job,
//     id "upl-note:<job>:<entry>:v<version>", detail = that version.
// Every change is a NEW row with the next version, so the history is the rows
// themselves, and the primary key is the concurrency check: two saves on the
// same version cannot both land (the second gets P2002 and is told whose
// words won). Nothing is ever updated in place or deleted.
//
// Nothing here touches Project, Deliverable, pay or the KPI stamps.
// ---------------------------------------------------------------------------

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** Who is on this shoot (lib/sharedShootCore rosterOf). A read that fails reads as the job's photographer alone. */
export async function shootRoster(projectId: string): Promise<{ members: RosterMember[]; shared: boolean; appointments: { assignedToId: string | null; status: string | null; startAt: Date | null }[] }> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      photographer: { select: { id: true, name: true } },
      appointments: { select: { assignedToId: true, status: true, startAt: true } },
    },
  });
  if (!p) return { members: [], shared: false, appointments: [] };
  const crewRows = await prisma.projectCrew.findMany({ where: { projectId }, orderBy: { addedAt: "asc" }, select: { memberId: true } }).catch(() => []);
  const ids = [...new Set([...p.appointments.map((a) => a.assignedToId), ...crewRows.map((c) => c.memberId)].filter((x): x is string => !!x))];
  const members = ids.length ? await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(members.map((m) => [m.id, m.name]));
  const r = rosterOf({
    photographer: p.photographer ? { id: p.photographer.id, name: p.photographer.name } : null,
    appointments: p.appointments,
    crew: crewRows.map((c) => ({ memberId: c.memberId, name: names.get(c.memberId) ?? "A photographer" })),
    names,
  });
  return { ...r, appointments: p.appointments };
}

/** Every person's newest contribution on this job (also people no longer on the roster: a reassignment never deletes a part). */
export async function readContributions(projectId: string): Promise<Map<string, Contribution>> {
  const rows = await prisma.auditLog.findMany({ where: { action: CONTRIBUTION_ACTION, target: projectId }, select: { detail: true } }).catch(() => []);
  return latestContributions(rows.map((r) => r.detail));
}

type ContributionPatch = Partial<Pick<Contribution, "captured" | "videoDrone" | "uploaded">> & { submit?: ContributionSubmit };

/**
 * Write the next version of ONE person's contribution. Only ever their own
 * (the caller passes the signed-in person's member id). Two tabs of the same
 * person racing: the loser re-reads and re-applies its change on top.
 */
export async function writeContribution(
  projectId: string,
  who: { memberId: string; name: string; actor: string },
  patch: ContributionPatch,
): Promise<Contribution> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = (await readContributions(projectId)).get(who.memberId) ?? null;
    const next: Contribution = {
      memberId: who.memberId,
      name: who.name || cur?.name || "A photographer",
      captured: patch.captured ? [...new Set(patch.captured.filter(isServiceKey))] : cur?.captured ?? [],
      videoDrone: patch.videoDrone ?? cur?.videoDrone ?? false,
      uploaded: patch.uploaded ? [...new Set(patch.uploaded.filter(isServiceKey))] : cur?.uploaded ?? [],
      submits: [...(cur?.submits ?? []), ...(patch.submit ? [patch.submit] : [])].slice(-20),
      version: (cur?.version ?? 0) + 1,
      updatedAtISO: new Date().toISOString(),
    };
    try {
      await prisma.auditLog.create({
        data: { id: contributionRowId(projectId, who.memberId, next.version), actor: who.actor, action: CONTRIBUTION_ACTION, target: projectId, detail: JSON.stringify(next) },
      });
      return next;
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  throw new Error("Your part kept changing in another tab. Reload and try again.");
}

/** A submit of this person's part, on their contribution (best-effort for the caller; it never blocks a handoff). */
export async function recordContributionSubmit(
  projectId: string,
  who: { memberId: string; name: string; actor: string },
  submit: { scope: ContributionSubmit["scope"]; services: ServiceKey[]; at?: Date },
): Promise<void> {
  await writeContribution(projectId, who, {
    submit: { scope: submit.scope, services: [...new Set(submit.services.filter(isServiceKey))], atISO: (submit.at ?? new Date()).toISOString() },
  });
}

// ---- shared instructions ------------------------------------------------------------

export async function readSharedNoteVersions(projectId: string): Promise<SharedNoteVersion[]> {
  const rows = await prisma.auditLog.findMany({ where: { action: SHARED_NOTE_ACTION, target: projectId }, select: { detail: true } }).catch(() => []);
  return rows.map((r) => parseSharedNoteVersion(r.detail)).filter((v): v is SharedNoteVersion => !!v);
}

export async function readSharedNotes(projectId: string): Promise<SharedNote[]> {
  return foldSharedNotes(await readSharedNoteVersions(projectId));
}

export type SharedNoteResult =
  | { ok: true; note: SharedNote; changed: boolean }
  | { ok: false; message: string; current: SharedNote | null };

const clean = (t: string) => (t ?? "").replace(/\r\n/g, "\n").trim();

async function timeline(projectId: string, body: string) {
  await prisma.activity.create({ data: { projectId, type: "NOTE", body: body.slice(0, 1000) } }).catch(() => {});
}

/** A new shared instruction (version 1). */
export async function addSharedNote(projectId: string, who: { key: string; name: string; actor: string }, text: string): Promise<SharedNoteResult> {
  const t = clean(text);
  if (!t) return { ok: false, message: "Write the instruction first.", current: null };
  if (t.length > SHARED_NOTE_CAP) return { ok: false, message: `That is over ${SHARED_NOTE_CAP} characters. Split it into two instructions.`, current: null };
  // The same words already on the job (a double tap, two people typing the same thing): one entry.
  const existing = (await readSharedNotes(projectId)).find((n) => !n.deleted && n.text.replace(/\s+/g, " ").toLowerCase() === t.replace(/\s+/g, " ").toLowerCase());
  if (existing) return { ok: true, note: existing, changed: false };
  const entryId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const v: SharedNoteVersion = { entryId, version: 1, text: t, byName: who.name, byKey: who.key, atISO: new Date().toISOString(), deleted: false };
  await prisma.auditLog.create({ data: { id: sharedNoteRowId(projectId, entryId, 1), actor: who.actor, action: SHARED_NOTE_ACTION, target: projectId, detail: JSON.stringify(v) } });
  await timeline(projectId, `Shared instruction for the editor added by ${who.name}: ${t}`);
  return { ok: true, note: foldSharedNotes([v])[0], changed: true };
}

/**
 * Change (or remove) one shared instruction. `expectedVersion` is the version
 * the person was looking at: if somebody saved over it since, nothing is
 * written and they get the current words and who wrote them.
 */
export async function editSharedNote(
  projectId: string,
  who: { key: string; name: string; actor: string },
  entryId: string,
  expectedVersion: number,
  text: string,
  opts: { remove?: boolean } = {},
): Promise<SharedNoteResult> {
  const t = clean(text);
  if (!opts.remove && !t) return { ok: false, message: "An instruction can't be empty. Use Remove to take it off.", current: null };
  if (t.length > SHARED_NOTE_CAP) return { ok: false, message: `That is over ${SHARED_NOTE_CAP} characters. Split it into two instructions.`, current: null };
  const versions = (await readSharedNoteVersions(projectId)).filter((v) => v.entryId === entryId);
  if (!versions.length) return { ok: false, message: "That instruction is not on this job any more. Reload the page.", current: null };
  const cur = foldSharedNotes(versions)[0];
  if (cur.version !== expectedVersion) return { ok: false, message: staleSaveMessage(cur, who.name), current: cur };
  if (!opts.remove && !cur.deleted && cur.text === t) return { ok: true, note: cur, changed: false };
  const v: SharedNoteVersion = { entryId, version: cur.version + 1, text: opts.remove ? cur.text : t, byName: who.name, byKey: who.key, atISO: new Date().toISOString(), deleted: !!opts.remove };
  try {
    await prisma.auditLog.create({ data: { id: sharedNoteRowId(projectId, entryId, v.version), actor: who.actor, action: SHARED_NOTE_ACTION, target: projectId, detail: JSON.stringify(v) } });
  } catch (e) {
    if (!isUnique(e)) throw e;
    // Somebody saved the same version a moment before: theirs stands.
    const now = foldSharedNotes((await readSharedNoteVersions(projectId)).filter((x) => x.entryId === entryId))[0] ?? cur;
    return { ok: false, message: staleSaveMessage(now, who.name), current: now };
  }
  await timeline(projectId, opts.remove ? `Shared instruction removed by ${who.name} (kept in its history): ${cur.text}` : `Shared instruction for the editor changed by ${who.name}: ${t}`);
  return { ok: true, note: foldSharedNotes([...versions, v])[0], changed: true };
}

// ---- the editor's combined brief ------------------------------------------------------

export type SharedBrief = {
  shared: boolean;
  /** each photographer: what they captured and where their part stands */
  people: { name: string; services: string[]; state: "not_started" | "in_progress" | "submitted"; submittedAtISO: string | null; former: boolean }[];
  /** the shared instructions, oldest first, each with who wrote and last changed it */
  notes: { text: string; author: string; lastBy: string; lastAtISO: string; edited: boolean; changedAfterHandoff: boolean }[];
  /** instructions (and the agent's requests) that point opposite ways: both shown, never resolved here */
  conflicts: { a: { who: string; text: string }; b: { who: string; text: string }; subject: string }[];
  /** videos added on site that are not on the order yet, with the words written for them */
  addedVideos: { item: string; text: string; byName: string; atISO: string; handled: boolean }[];
  /** the first handoff on this job (what "changed after the handoff" is measured from) */
  handoffISO: string | null;
};

/**
 * One organised read for the editor's brief, the printed brief and the packet:
 * the photographers' shared instructions with their authors, anything changed
 * after the first handoff, and where two instructions disagree (both shown,
 * flagged, never one picked). Null when there is nothing of the kind on the
 * job (a single-photographer job with no shared instructions and no video
 * added on site reads exactly as before).
 */
export async function sharedBriefFor(projectId: string, opts: { scrub?: boolean } = {}): Promise<SharedBrief | null> {
  const [roster, contribs, notes, project] = await Promise.all([
    shootRoster(projectId).catch(() => ({ members: [] as RosterMember[], shared: false, appointments: [] })),
    readContributions(projectId),
    readSharedNotes(projectId),
    prisma.project.findUnique({ where: { id: projectId }, select: { photosHandoffAt: true, videoHandoffAt: true, debriefSubmittedAt: true } }),
  ]);
  const { addedVideoRecords } = await import("@/lib/addedOnSite");
  const added = [...(await addedVideoRecords(projectId).catch(() => new Map<string, never>())).values()].filter((r) => !r.attachedKey && r.text.trim());
  const tasks = added.length ? await prisma.smartTask.findMany({ where: { id: { in: added.map((r) => r.taskId) } }, select: { id: true, status: true } }) : [];
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const pending = added.filter((r) => status.has(r.taskId) && status.get(r.taskId) !== "CANCELLED");
  const live = notes.filter((n) => !n.deleted);
  if (!roster.shared && !live.length && !pending.length) return null;
  const { stripMoneySentences } = await import("@/lib/text");
  const say = (t: string) => (opts.scrub ? stripMoneySentences(t).trim() : t);
  const stamps = [project?.photosHandoffAt, project?.videoHandoffAt, project?.debriefSubmittedAt].filter((d): d is Date => !!d).map((d) => d.getTime());
  const handoff = stamps.length ? new Date(Math.min(...stamps)) : null;
  const { contributionState, lastSubmit, findConflicts, SERVICE_LABEL } = await import("@/lib/sharedShootCore");
  // The agent's open requests are checked too: an instruction against what the agent asked for is the same question.
  let requests: { id: string; text: string; source: string }[] = [];
  try {
    const { agentRequestsFor } = await import("@/lib/agentRequests");
    requests = (await agentRequestsFor(projectId, { office: !opts.scrub })).filter((r) => r.group === "visit").map((r) => ({ id: r.id, text: r.original, source: r.source }));
  } catch { /* conflicts among the photographers' own words still show */ }
  const conflicts = findConflicts([
    ...live.map((n) => ({ id: n.entryId, who: n.lastByName, text: say(n.text), source: "instruction" })),
    ...requests.map((r) => ({ id: `req:${r.id}`, who: "the agent's request", text: r.text, source: r.source })),
  ])
    .filter((c) => c.a.source === "instruction" || c.b.source === "instruction")
    .map((c) => ({ a: { who: c.a.who, text: c.a.text }, b: { who: c.b.who, text: c.b.text }, subject: c.subject }));
  const memberIds = new Set(roster.members.map((m) => m.memberId));
  const people = [
    ...roster.members.map((m) => ({ id: m.memberId, name: m.name, former: false })),
    ...[...contribs.values()].filter((c) => !memberIds.has(c.memberId)).map((c) => ({ id: c.memberId, name: c.name, former: true })),
  ].map((m) => {
    const c = contribs.get(m.id) ?? null;
    return {
      name: m.name,
      // "Includes drone footage" reaches the editor with the video (audit, Oct 23 2026).
      services: (c?.captured ?? []).map((s) => (s === "video" && c?.videoDrone ? "Video (with drone footage)" : SERVICE_LABEL[s])),
      state: contributionState(c),
      submittedAtISO: lastSubmit(c)?.atISO ?? null,
      former: m.former,
    };
  });
  return {
    shared: roster.shared,
    people: roster.shared ? people : [],
    notes: live.map((n) => ({
      text: say(n.text),
      author: n.authorName,
      lastBy: n.lastByName,
      lastAtISO: n.lastAtISO,
      edited: n.version > 1,
      changedAfterHandoff: !!handoff && Date.parse(n.lastAtISO) > handoff.getTime(),
    })),
    conflicts,
    addedVideos: pending.map((r) => ({ item: r.item, text: say(r.text), byName: r.byName, atISO: r.atISO, handled: status.get(r.taskId) === "COMPLETED" })),
    handoffISO: handoff?.toISOString() ?? null,
  };
}

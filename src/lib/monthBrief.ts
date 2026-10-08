import "server-only";
import path from "path";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { STORAGE_PREFIX, withinStorage } from "@/lib/storage";
import { dropboxDownload, dropboxUpload } from "@/lib/integrations/dropbox";
import {
  BRIEF_DAILY_CAP, BRIEF_FILES_MAX, BRIEF_ID_RE, BRIEF_NOTES_MAX, briefFileHref, briefFileKey, briefFileRefusal, briefMimeFor, briefMonthPrefix, briefNotesKey,
  type BriefBy, type BriefFile, type BriefNotes, type MonthBrief, type MonthBriefView,
} from "@/lib/monthBriefCore";

// ---------------------------------------------------------------------------
// THE CLIENT'S CREATIVE BRIEF FOR A MONTH (Oct 8 2026) — the server half:
// store, list, remove, and who may read. The pure half (limits, keys, shapes)
// is monthBriefCore.ts; the doors are /api/portal/brief (upload) and
// /api/portal/brief/<monthId>/<fileId> (read).
//
// PRIVATE BY CONSTRUCTION. The bytes go to the company Dropbox under the
// app's own prefix (STORAGE_PREFIX/content-briefs/…), the same private store
// every job upload uses — never the public review-cuts blob store. Nothing
// here mints a shared link; the read door streams the bytes to an admitted
// viewer with no-store caching.
//
// A client adding a brief bells the office (owner/admin and the creative
// manager); nothing here ever messages the client.
// ---------------------------------------------------------------------------

type MonthRow = { id: string; enrollmentId: string; clientId: string; monthKey: string; historical: boolean };

async function monthRow(monthId: string): Promise<MonthRow | null> {
  if (!BRIEF_ID_RE.test(monthId)) return null;
  return prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, historical: true } });
}

function parseFile(key: string, value: string): BriefFile | null {
  try {
    const v = JSON.parse(value) as Partial<BriefFile>;
    if (!v || typeof v.name !== "string" || typeof v.path !== "string") return null;
    return {
      id: key.slice(key.lastIndexOf(":") + 1), name: v.name, size: Number(v.size) || 0, mime: String(v.mime ?? briefMimeFor(v.name)), path: v.path,
      by: { kind: v.by?.kind === "staff" ? "staff" : "client", label: String(v.by?.label ?? ""), id: v.by?.id ?? null }, atISO: String(v.atISO ?? ""),
    };
  } catch { return null; }
}

function parseNotes(value: string): BriefNotes | null {
  try {
    const v = JSON.parse(value) as Partial<BriefNotes>;
    if (!v || typeof v.text !== "string" || !v.text.trim()) return null;
    return { text: v.text, by: { kind: v.by?.kind === "staff" ? "staff" : "client", label: String(v.by?.label ?? ""), id: v.by?.id ?? null }, atISO: String(v.atISO ?? "") };
  } catch { return null; }
}

/** One month's brief (empty when nothing was added). Null when the month does not exist. */
export async function monthBrief(monthId: string): Promise<MonthBrief | null> {
  const m = await monthRow(monthId);
  if (!m) return null;
  return (await monthBriefsFor([m])).get(m.id) ?? null;
}

/** Briefs for several months in one read. */
export async function monthBriefsFor(months: { id: string; enrollmentId: string; monthKey: string }[]): Promise<Map<string, MonthBrief>> {
  const out = new Map<string, MonthBrief>();
  if (!months.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { OR: months.map((m) => ({ key: { startsWith: briefMonthPrefix(m.id) } })) }, select: { key: true, value: true } });
  for (const m of months) {
    const mine = rows.filter((r) => r.key.startsWith(briefMonthPrefix(m.id)));
    const files = mine.filter((r) => r.key.startsWith(`${briefMonthPrefix(m.id)}f:`)).map((r) => parseFile(r.key, r.value)).filter((f): f is BriefFile => !!f)
      .sort((a, b) => a.atISO.localeCompare(b.atISO));
    const notesRow = mine.find((r) => r.key === briefNotesKey(m.id));
    out.set(m.id, { monthId: m.id, enrollmentId: m.enrollmentId, monthKey: m.monthKey, files, notes: notesRow ? parseNotes(notesRow.value) : null });
  }
  return out;
}

/** Atomic per-enrollment daily counter (the portal upload's pattern). False = over the cap or unreadable (fail closed). */
async function underDailyCap(enrollmentId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const capKey = `content-brief-uploads-${enrollmentId}-${day}`;
  try {
    await prisma.appSetting.upsert({ where: { key: capKey }, update: {}, create: { key: capKey, value: "0" } });
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      UPDATE "AppSetting" SET "value" = (COALESCE(NULLIF("value", ''), '0')::int + 1)::text
      WHERE "key" = ${capKey} RETURNING "value"`;
    const used = parseInt(rows[0]?.value ?? "", 10);
    return Number.isFinite(used) && used <= BRIEF_DAILY_CAP;
  } catch { return false; }
}

const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
};

/** Bell the office — owner/admin and the creative manager (tasks.ts creativeAlertTargets' shape). Never the client. */
async function bellOffice(m: MonthRow, what: string): Promise<void> {
  try {
    const client = await prisma.client.findUnique({ where: { id: m.clientId }, select: { name: true } });
    const { isTestClientName } = await import("@/lib/testClients");
    if (isTestClientName(client?.name)) return;
    const href = `/content/${m.enrollmentId}?month=${m.monthKey}#brief`;
    const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
    const manager = await prisma.teamMember.findFirst({ where: { creativeManager: true, active: true }, select: { id: true } }).catch(() => null);
    if (manager) targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${manager.id}`, href });
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "content_brief",
      title: `Creative brief — ${client?.name ?? "a client"}`,
      body: `${monthName(m.monthKey)}: ${what}`,
      href, targets,
      dedupeKey: `content-brief-${m.id}-${new Date().toISOString().slice(0, 10)}`,
    });
  } catch { /* the bell is best-effort; the brief is on the client file either way */ }
}

export type BriefWriteResult = { ok: boolean; message: string; file?: BriefFile };

/**
 * Add one file to a month's brief. The caller has already decided WHO may
 * (the upload route: the client of this enrollment, or owner/admin).
 */
export async function addBriefFile(monthId: string, file: { name: string; size: number; bytes: Uint8Array }, by: BriefBy): Promise<BriefWriteResult> {
  const m = await monthRow(monthId);
  if (!m || m.historical) return { ok: false, message: "That month isn't open for a brief." };
  const refusal = briefFileRefusal(file.name, file.size);
  if (refusal) return { ok: false, message: refusal };
  if (file.bytes.byteLength !== file.size) return { ok: false, message: "That upload didn't arrive whole — try again." };
  const existing = await prisma.appSetting.count({ where: { key: { startsWith: `${briefMonthPrefix(m.id)}f:` } } });
  if (existing >= BRIEF_FILES_MAX) return { ok: false, message: `This month's brief already has ${BRIEF_FILES_MAX} files — remove one first, or paste the rest in the notes.` };
  if (!(await underDailyCap(m.enrollmentId))) return { ok: false, message: "That's the upload limit for today — try again tomorrow, or send it to us in Messages." };
  const id = randomBytes(12).toString("hex");
  const ext = path.extname(file.name).toLowerCase();
  const stored = `${STORAGE_PREFIX}/content-briefs/${m.enrollmentId}/${m.monthKey}/${id}${ext}`;
  try {
    await dropboxUpload(stored, file.bytes, { autorename: false });
  } catch {
    return { ok: false, message: "The upload didn't stick — try again in a minute." };
  }
  const row: BriefFile = { id, name: file.name, size: file.size, mime: briefMimeFor(file.name), path: stored, by, atISO: new Date().toISOString() };
  const { id: _omit, ...value } = row; void _omit;
  await prisma.appSetting.create({ data: { key: briefFileKey(m.id, id), value: JSON.stringify(value), updatedBy: by.label.slice(0, 120) } });
  if (by.kind === "client") await bellOffice(m, `added "${file.name}"`);
  return { ok: true, message: `Added ${file.name}.`, file: row };
}

/** Save (or clear, with blank text) the month's pasted notes. */
export async function saveBriefNotes(monthId: string, text: string, by: BriefBy): Promise<BriefWriteResult> {
  const m = await monthRow(monthId);
  if (!m || m.historical) return { ok: false, message: "That month isn't open for a brief." };
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length > BRIEF_NOTES_MAX) return { ok: false, message: `Notes can be up to ${BRIEF_NOTES_MAX.toLocaleString("en-US")} characters — attach a document for anything longer.` };
  const key = briefNotesKey(m.id);
  if (!clean) {
    await prisma.appSetting.deleteMany({ where: { key } });
    return { ok: true, message: "Notes cleared." };
  }
  const prev = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  const value: BriefNotes = { text: clean, by, atISO: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key }, update: { value: JSON.stringify(value), updatedBy: by.label.slice(0, 120) }, create: { key, value: JSON.stringify(value), updatedBy: by.label.slice(0, 120) } });
  if (by.kind === "client" && parseNotes(prev?.value ?? "")?.text !== clean) await bellOffice(m, prev ? "updated their brief notes" : "added brief notes");
  return { ok: true, message: "Notes saved." };
}

/**
 * Take a file off the brief. The record goes; the stored bytes are kept in
 * the private folder (nothing is permanently deleted from here).
 */
export async function removeBriefFile(monthId: string, fileId: string): Promise<BriefWriteResult> {
  const m = await monthRow(monthId);
  if (!m || !BRIEF_ID_RE.test(fileId)) return { ok: false, message: "That file isn't on this brief." };
  const r = await prisma.appSetting.deleteMany({ where: { key: briefFileKey(m.id, fileId) } });
  return r.count ? { ok: true, message: "Removed from the brief." } : { ok: false, message: "That file isn't on this brief." };
}

/** The stored bytes of one brief file — only from this month's own private folder. */
export async function readBriefBytes(month: { enrollmentId: string }, file: BriefFile): Promise<Buffer | null> {
  if (!withinStorage(file.path) || !file.path.startsWith(`${STORAGE_PREFIX}/content-briefs/${month.enrollmentId}/`)) return null;
  try { return await dropboxDownload(file.path); } catch { return null; }
}

/** One file's record, for the read door. */
export async function briefFileFor(monthId: string, fileId: string): Promise<{ month: MonthRow; file: BriefFile } | null> {
  const m = await monthRow(monthId);
  if (!m || !BRIEF_ID_RE.test(fileId)) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: briefFileKey(m.id, fileId) }, select: { key: true, value: true } });
  const file = row ? parseFile(row.key, row.value) : null;
  return file ? { month: m, file } : null;
}

/**
 * May this signed-in hub user read the month's brief? Owner/admin: yes. A
 * photographer or editor: only when they may open one of THAT month's jobs
 * (guards.canViewProject — the same test /api/file applies to a job's files).
 */
export async function hubUserMayReadBrief(monthId: string): Promise<boolean> {
  const { authEnforced, canViewProject } = await import("@/lib/auth/guards");
  if (!authEnforced()) return true;
  const { getCurrentUser } = await import("@/lib/auth/user");
  const u = await getCurrentUser().catch(() => null);
  if (!u) return false;
  if (u.role === "OWNER" || u.role === "ADMIN") return true;
  const jobs = await prisma.project.findMany({ where: { contentMonthId: monthId, status: { not: "CANCELLED" } }, select: { id: true }, take: 10 });
  for (const j of jobs) if (await canViewProject(j.id, u)) return true;
  return false;
}

/** The brief for a job's month (the shoot screen and the editor's brief), with whether the client plans their own content. */
export async function briefForProject(projectId: string): Promise<(MonthBrief & { clientPlanned: boolean }) | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { contentMonthId: true } });
  if (!p?.contentMonthId) return null;
  const m = await monthRow(p.contentMonthId);
  if (!m) return null;
  const [brief, e] = await Promise.all([
    monthBriefsFor([m]).then((x) => x.get(m.id) ?? null),
    prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { clientSuppliesTopics: true } }),
  ]);
  return brief ? { ...brief, clientPlanned: !!e?.clientSuppliesTopics } : null;
}

/**
 * What a page is handed: no storage paths. A portal page passes its viewer's
 * media scope so every link carries a token scoped to that seat or link;
 * a hub page passes null and its readers use their login.
 */
export async function briefView(brief: MonthBrief | null, scope: import("@/lib/portalMedia").MediaScope | null): Promise<MonthBriefView | null> {
  if (!brief) return null;
  const { mediaToken } = await import("@/lib/portalMedia");
  return {
    monthId: brief.monthId, monthKey: brief.monthKey,
    files: brief.files.map((f) => ({
      id: f.id, name: f.name, size: f.size, byKind: f.by.kind, byLabel: f.by.label, atISO: f.atISO,
      href: briefFileHref(brief.monthId, f.id) + (scope ? `?m=${encodeURIComponent(mediaToken(f.id, scope))}` : ""),
    })),
    notes: brief.notes ? { text: brief.notes.text, byLabel: brief.notes.by.label, atISO: brief.notes.atISO } : null,
  };
}

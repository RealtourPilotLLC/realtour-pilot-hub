import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// INSTRUCTIONS IN DROPBOX (Oct 22 2026). Jordan, after Joe Sutow's two jobs
// (538 Onward Ave, 859 N Lawrence St) were chased for "the flow and vision for
// the edit" while the photographers had put their instructions in the job's
// Dropbox folder: "add a section to the upload portal that says 'instructions
// added to Dropbox' so the editor knows and we know the instructions are
// added, just in Dropbox, then show that instructions file in the hub for the
// edit instructions section."
//
// One file per job (Project.instructionsDropboxPath + name/at/by). Set from the
// upload page by anyone who may upload to the job (photographer, second
// shooter, office); it answers the handoff's instruction gap (lib/handoff
// instructionsInDropbox), posts one line on the job's team thread (the job's
// editor is pinged by the existing project-message notifier) and shows on the
// editor brief with Open (/api/instructions/<projectId>, a Dropbox temporary
// link behind the brief's own access rule; never a share link).
// ---------------------------------------------------------------------------

/** Documents a photographer writes instructions in. */
const DOC_RE = /\.(docx?|pdf|txt|md|markdown|pages|rtf|rtfd|odt|gdoc|note|notes)$/i;
/** Pictures of notes (a phone photo of a written page, a screenshot). */
const IMAGE_RE = /\.(jpe?g|png|heic|webp)$/i;
/** Words that make a file or folder an instructions file. */
const WORDS_RE = /(instruction|notes?\b|brief|vision|edit[\s_-]*notes|shot[\s_-]*list|script|directions?)/i;
/** The bulk media folders: a picture in them is footage, never a note, unless it is named like one. */
const MEDIA_DIR_RE = /\/(0[1-5]-[^/]*|raw[^/]*|final[^/]*|backup[^/]*)\//i;

export type InstructionCandidate = { path: string; name: string; folder: string; modifiedISO: string | null; size: number | null };

/** Is this Dropbox file an instructions file? (pure) */
export function isInstructionCandidate(e: { path: string; name: string; tag: string }): boolean {
  if (e.tag !== "file") return false;
  const lower = e.path.toLowerCase();
  const inWordsFolder = lower.split("/").slice(0, -1).some((seg) => WORDS_RE.test(seg));
  if (DOC_RE.test(e.name)) return true;
  if (IMAGE_RE.test(e.name)) return WORDS_RE.test(e.name) || (inWordsFolder && !MEDIA_DIR_RE.test(lower));
  return WORDS_RE.test(e.name) && !/\.(mp4|mov|m4v|avi|mts|arw|cr2|cr3|nef|dng|raf|orf|rw2|braw)$/i.test(e.name);
}

/** Can the editor brief show this file's text inline? (pure) The same formats documentText reads. */
export const readableInline = (name: string): boolean => /\.(txt|md|docx|pdf)$/i.test(name);

type FolderRow = { id: string; title: string | null; addressLine: string | null; shootDate: Date | null; createdAt: Date; dropboxFolder: string | null; client: { name: string } | null };

async function jobFolder(projectId: string): Promise<string | null> {
  const p = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } },
  })) as FolderRow | null;
  if (!p?.client) return null;
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  return actualFolderPaths(p as never).listing;
}

/** The instruction-like files in the job's Dropbox folder, newest first (max 40). Null = the folder could not be read. */
export async function listInstructionCandidates(projectId: string): Promise<{ folder: string; files: InstructionCandidate[] } | null> {
  const folder = await jobFolder(projectId);
  if (!folder) return null;
  const { dropboxListFolder } = await import("@/lib/integrations/dropbox");
  const entries = await dropboxListFolder(folder, { recursive: true }).catch(() => null);
  if (!entries) return null;
  const files = entries
    .filter((e) => isInstructionCandidate(e))
    .map((e) => ({
      path: e.path,
      name: e.name,
      folder: e.path.slice(folder.length).split("/").slice(1, -1).join("/") || "(job folder)",
      modifiedISO: e.serverModified ?? null,
      size: e.size ?? null,
    }))
    .sort((a, b) => (b.modifiedISO ?? "").localeCompare(a.modifiedISO ?? ""))
    .slice(0, 40);
  return { folder, files };
}

/** A path the person typed or picked, kept inside this job's own folder (never anywhere else in Dropbox). */
export async function resolveInstructionPath(projectId: string, raw: string): Promise<{ path: string; name: string } | { error: string }> {
  const folder = await jobFolder(projectId);
  if (!folder) return { error: "This job has no Dropbox folder yet." };
  const typed = raw.trim().replace(/\\/g, "/");
  if (!typed) return { error: "Pick the file, or type where it is in the job's folder." };
  if (typed.includes("..")) return { error: "That path leaves the job's folder." };
  // A full Dropbox path (it starts with the job folder's own top folder, e.g.
  // "/AutoHDR/…") must be inside the job's folder; anything else is read as a
  // path inside it ("02-RAW-Video/edit notes.docx").
  const top = folder.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  const absolute = typed.startsWith("/") && typed.split("/").filter(Boolean)[0]?.toLowerCase() === top;
  const path = absolute ? typed : `${folder}/${typed.replace(/^\/+/, "")}`;
  if (!path.toLowerCase().startsWith(`${folder.toLowerCase()}/`)) return { error: "That file is not in this job's Dropbox folder." };
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return { path, name };
}

/** The file's text for the brief (txt, md, docx, pdf through lib/documentText). Null when it can't be read as text. */
export async function instructionText(path: string, name: string): Promise<string | null> {
  if (!readableInline(name)) return null;
  const { dropboxDownload } = await import("@/lib/integrations/dropbox");
  const buf = await dropboxDownload(path);
  const { extractDocumentText } = await import("@/lib/documentText");
  const r = await extractDocumentText(buf, name);
  return r.ok ? r.text.slice(0, 20_000) : null;
}

export type DropboxInstructions = { path: string; name: string; atISO: string | null; by: string | null } | null;

export function dropboxInstructionsOf(p: { instructionsDropboxPath: string | null; instructionsDropboxName: string | null; instructionsDropboxAt: Date | null; instructionsDropboxBy: string | null }): DropboxInstructions {
  if (!p.instructionsDropboxPath?.trim()) return null;
  return { path: p.instructionsDropboxPath, name: p.instructionsDropboxName ?? p.instructionsDropboxPath.split("/").pop() ?? "instructions", atISO: p.instructionsDropboxAt?.toISOString() ?? null, by: p.instructionsDropboxBy };
}

/**
 * Record it, tell the thread (and through it the job's editor), and let the
 * handoff engine re-read the job at once so "Waiting on instructions" clears
 * now rather than at the next hourly pass.
 */
export async function setDropboxInstructions(projectId: string, file: { path: string; name: string }, by: { name: string; tmId: string | null; key: string | null }): Promise<void> {
  const now = new Date();
  await prisma.project.update({
    where: { id: projectId },
    data: { instructionsDropboxPath: file.path, instructionsDropboxName: file.name.slice(0, 200), instructionsDropboxAt: now, instructionsDropboxBy: by.name.slice(0, 120) },
  });
  const body = `Instructions are in Dropbox: ${file.name}`;
  const msg = await prisma.projectMessage.create({ data: { projectId, authorId: by.tmId, authorName: by.name, body }, select: { id: true } });
  try {
    const { notifyProjectMessage } = await import("@/lib/mentions");
    await notifyProjectMessage({ projectId, messageId: msg.id, authorTmId: by.tmId, authorKey: by.key, authorName: by.name, text: body, context: "the job's team chat", excludeTmIds: [] });
  } catch (e) {
    console.warn("instructions-in-Dropbox ping failed (line saved)", e);
  }
  await rereadHandoff(projectId);
}

export async function clearDropboxInstructions(projectId: string): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { instructionsDropboxPath: null, instructionsDropboxName: null, instructionsDropboxAt: null, instructionsDropboxBy: null } });
  await rereadHandoff(projectId);
}

async function rereadHandoff(projectId: string): Promise<void> {
  try {
    const { ensureEditorHandoff } = await import("@/lib/tasks");
    await ensureEditorHandoff(projectId);
  } catch (e) {
    console.warn("handoff re-read after instructions change failed (hourly pass catches it)", e);
  }
}

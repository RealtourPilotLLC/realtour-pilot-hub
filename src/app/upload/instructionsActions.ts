"use server";

import { revalidatePath } from "next/cache";
import { requireUploadAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import {
  clearDropboxInstructions,
  listInstructionCandidates,
  resolveInstructionPath,
  setDropboxInstructions,
  type InstructionCandidate,
} from "@/lib/dropboxInstructions";

// ---------------------------------------------------------------------------
// "Instructions added to Dropbox" on the upload page (Oct 22 2026). Saved the
// moment it is pressed, not with the page's Submit: the instructions are
// already in Dropbox, and saying so should not wait on the rest of the
// wrap-up. Anyone who may upload to the job may set it (photographer, second
// shooter, office); see lib/dropboxInstructions.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;

export async function listDropboxInstructionFiles(projectId: string): Promise<{ ok: true; folder: string; files: InstructionCandidate[] } | { ok: false; message: string }> {
  if (!ID_RE.test(projectId)) return { ok: false, message: "Unknown job." };
  await requireUploadAccess(projectId);
  const r = await listInstructionCandidates(projectId);
  if (!r) return { ok: false, message: "Couldn't read the job's Dropbox folder right now. Type where the file is instead." };
  return { ok: true, folder: r.folder, files: r.files };
}

export async function markInstructionsInDropbox(projectId: string, rawPath: string): Promise<{ ok: boolean; message: string }> {
  if (!ID_RE.test(projectId)) return { ok: false, message: "Unknown job." };
  await requireUploadAccess(projectId);
  const file = await resolveInstructionPath(projectId, rawPath ?? "");
  if ("error" in file) return { ok: false, message: file.error };
  const me = await getCurrentUser().catch(() => null);
  const by = { name: me?.name || me?.email || "Someone", tmId: me?.teamMemberId ?? null, key: me?.editorKey ? `editor:${me.editorKey}` : null };
  await setDropboxInstructions(projectId, file, by);
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: `Saved. The editor sees "${file.name}" on the brief.` };
}

export async function clearInstructionsInDropbox(projectId: string): Promise<{ ok: boolean; message: string }> {
  if (!ID_RE.test(projectId)) return { ok: false, message: "Unknown job." };
  await requireUploadAccess(projectId);
  await clearDropboxInstructions(projectId);
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: "Removed." };
}

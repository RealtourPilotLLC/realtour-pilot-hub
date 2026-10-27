"use server";

import { revalidatePath } from "next/cache";
import { authEnforced, canViewProject, requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { OfficeBriefFields } from "@/lib/briefFields";
import type { QuestionTarget } from "@/lib/editorQuestionsCore";

type Result = { ok: boolean; message: string };
const ID = /^[a-z0-9_-]{6,64}$/i;

// ---------------------------------------------------------------------------
// ASK A QUESTION (Jordan, Oct 27 2026), from the editor's brief: on a revision
// note, on a client's request, or on What to make. Anyone who may read the
// brief may ask (the editor holding it, the office, the creative manager); a
// "view as" preview may not, since it would text people as someone else.
// lib/editorQuestions decides who is texted (never a client).
// ---------------------------------------------------------------------------
export async function askEditQuestionAction(projectId: string, target: QuestionTarget, words: string): Promise<Result> {
  try { await requireRole(["OWNER", "ADMIN", "CREATIVE_MANAGER", "EDITOR"]); }
  catch { return { ok: false, message: "Sign in to ask a question." }; }
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "A preview can't send questions." };
  if (!me && authEnforced()) return { ok: false, message: "Sign in to ask a question." };
  if (!ID.test(projectId) || !(await canViewProject(projectId, me))) return { ok: false, message: "This job is not on your list." };
  const kind = target?.kind;
  const t: QuestionTarget | null =
    kind === "make" ? { kind: "make" }
    : (kind === "issue" || kind === "ask") && typeof target.id === "string" && ID.test(target.id) ? { kind, id: target.id }
    : null;
  if (!t) return { ok: false, message: "That question has nothing to attach to. Reload the page." };
  const { displayNameFor } = await import("@/lib/actorName");
  const name = (await displayNameFor(me).catch(() => null)) || me?.name?.trim() || "The editor";
  const { askEditQuestion } = await import("@/lib/editorQuestions");
  const r = await askEditQuestion({ projectId, target: t, words: String(words ?? ""), asker: { name, teamMemberId: me?.teamMemberId ?? null, userId: me?.id ?? null } }).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
  if (r.ok) { try { revalidatePath(`/edit/${projectId}`); } catch { /* outside a request */ } }
  return r;
}

// ---------------------------------------------------------------------------
// THE OFFICE WRITES THE BRIEF ON THE BRIEF (Jordan, Oct 27 2026: "when we turn
// on office tools, we can write the brief ... it needs to be consistent with
// what they use on the upload page"). The same fields as the upload portal,
// written into the same text the portal composes: video 1 (and a one-video or
// monthly job) into Project.videoInstructions through the editing room's own
// save (saveShootBriefFields, which leaves the timeline line), video 2 and on
// into their own row (saveLaterVideoInstructions). Every other section the
// photographer wrote is kept (lib/briefFields). The office only, never a
// "view as" preview.
// ---------------------------------------------------------------------------
export async function saveOfficeBriefAction(projectId: string, videoKey: string | null, fields: OfficeBriefFields, expected: string): Promise<Result> {
  try { await requireRole(["OWNER", "ADMIN", "CREATIVE_MANAGER"]); }
  catch { return { ok: false, message: "Only the office can write the brief here." }; }
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "A preview can't change the brief." };
  if (!ID.test(projectId)) return { ok: false, message: "That job no longer exists." };
  const f: OfficeBriefFields = {
    style: String(fields?.style ?? "").slice(0, 80),
    colorProfile: String(fields?.colorProfile ?? "").slice(0, 80),
    vision: String(fields?.vision ?? "").slice(0, 3000),
    videoNotes: String(fields?.videoNotes ?? "").slice(0, 3000),
    songLink: String(fields?.songLink ?? "").slice(0, 500),
    songStart: String(fields?.songStart ?? "").slice(0, 120),
  };
  const { normalizeSongLink } = await import("@/lib/songRequest");
  if (f.songLink.trim() && normalizeSongLink(f.songLink) === null) return { ok: false, message: "The song link isn't a web address. Paste the Spotify, YouTube or Apple Music link." };
  f.songLink = f.songLink.trim() ? normalizeSongLink(f.songLink) ?? "" : "";
  const { writeOfficeBrief } = await import("@/lib/briefFields");
  const { prisma } = await import("@/lib/prisma");
  const { videoInstructionsFor, saveLaterVideoInstructions } = await import("@/lib/deliverableOutputs");
  const rows = videoKey ? await videoInstructionsFor(projectId).catch(() => []) : [];
  const row = videoKey ? rows.find((r) => r.key === videoKey) ?? null : null;
  const later = !!row && row.number > 1;
  const current = later
    ? row!.own ?? ""
    : (await prisma.project.findUnique({ where: { id: projectId }, select: { videoInstructions: true } }))?.videoInstructions ?? "";
  // Someone (the photographer, another office tab) saved since this form opened.
  if ((current ?? "").trim() !== (expected ?? "").trim()) {
    return { ok: false, message: "These instructions changed while you were writing, so yours were not saved. Reload to see the newest words." };
  }
  const next = writeOfficeBrief(current, f);
  if (next.trim() === (current ?? "").trim()) return { ok: true, message: "Nothing changed." };
  if (next.length > 6000) return { ok: false, message: "That is over 6,000 characters, so nothing was saved." };
  if (later) {
    const { displayNameFor } = await import("@/lib/actorName");
    const who = (await displayNameFor(me).catch(() => null)) || "the office";
    if (!next.trim()) return { ok: false, message: "Write something first: an empty brief is not saved for a later video." };
    const saved = await saveLaterVideoInstructions(projectId, { [videoKey!]: next }, who).catch(() => []);
    if (!saved.length) return { ok: false, message: "That brief could not be saved. Reload and try again." };
  } else {
    const { saveShootBriefFields } = await import("@/app/editing/actions");
    const r = await saveShootBriefFields(projectId, { videoInstructions: next });
    if (!r.ok) return r;
  }
  try { revalidatePath(`/edit/${projectId}`); } catch { /* outside a request */ }
  return { ok: true, message: "Saved. The editor sees it in Instructions now." };
}

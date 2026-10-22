"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCreativeLead } from "@/lib/auth/guards";
import { assertDutyOwner } from "@/lib/contentProgram";
import type { EditedWords, RequestDraft, RequestPreview, RequestReadView, SendHow } from "@/lib/scriptRequests";

// ---------------------------------------------------------------------------
// THE OFFICE'S REQUEST CARD (Oct 22 2026): read, rewrite, preview, send,
// dismiss. lib/scriptRequests holds the rules, lib/scriptRequestAi the two AI
// calls. Reading, drafting and previewing are the creative seats' (owner,
// admin, creative manager); Send and Dismiss answer the client, so they are
// the script owner's too (assertDutyOwner("SCRIPTS"), as on every approve path).
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function actor(): Promise<{ email: string; id: string | null; realRole: string | null; name: string | null }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return { email: me?.email ?? "dev@local", id: me?.id ?? null, realRole: me?.realRole ?? me?.role ?? null, name: me?.name ?? null };
}

async function assertOwnerOfRequest(suggestionId: string, me: Awaited<ReturnType<typeof actor>>): Promise<void> {
  const sugg = /^[a-z0-9]{10,40}$/i.test(suggestionId) ? await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId }, select: { scriptId: true } }) : null;
  const s = sugg ? await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { enrollmentId: true, monthId: true } }) : null;
  if (!s) throw new Error("That request is gone.");
  await assertDutyOwner("SCRIPTS", s.enrollmentId, s.monthId, me);
}

const done = () => { try { revalidatePath("/content"); } catch { /* outside a request */ } };

/** "What they're asking for": the AI read, before anything is rewritten. */
export async function readScriptRequestAction(suggestionId: string, opts: { again?: boolean } = {}): Promise<Result & { read?: RequestReadView }> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const me = await actor();
  const { readScriptRequest } = await import("@/lib/scriptRequestAi");
  const r = await readScriptRequest(suggestionId, { requestedBy: me.email, again: !!opts.again });
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Read.", read: r.read };
}

/** "Rewrite with AI" (and "Redo the draft"): a draft for the office to read; nothing is sent. */
export async function rewriteScriptRequestAction(suggestionId: string, opts: { steer?: string | null; redo?: string | null } = {}): Promise<Result & { draft?: RequestDraft }> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const me = await actor();
  const { rewriteScriptRequest } = await import("@/lib/scriptRequestAi");
  const r = await rewriteScriptRequest(suggestionId, { requestedBy: me.email, steer: opts.steer ?? null, redo: opts.redo ?? null });
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Draft ready. Nothing has gone to the client.", draft: r.draft };
}

/** The preview: the new version, its check and the message. Writes nothing. */
export async function previewScriptRequestAction(suggestionId: string, how: SendHow, input: { words?: EditedWords | null; title?: string | null; draftRunId?: string | null; message?: string | null } = {}): Promise<Result & { preview?: RequestPreview }> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const { previewRequestVersion } = await import("@/lib/scriptRequests");
  const p = await previewRequestVersion(suggestionId, how, input);
  if (!p.ok) return { ok: false, message: p.message };
  return { ok: true, message: "", preview: p };
}

/** Send: a new version, shared for their OK, with the message under the script and in their Messages. */
export async function sendScriptRequestAction(suggestionId: string, how: SendHow, input: { words?: EditedWords | null; title?: string | null; draftRunId?: string | null; message?: string | null; startedFrom?: "theirs" | "ours" | "draft" | null }): Promise<Result & { versionNo?: number }> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const me = await actor();
  try { await assertOwnerOfRequest(suggestionId, me); } catch (e) { return fail(e); }
  const { sendRequestVersion } = await import("@/lib/scriptRequests");
  const r = await sendRequestVersion(suggestionId, how, input, { email: me.email, appUserId: me.id, name: me.name });
  if (r.ok) done();
  return { ok: r.ok, message: r.message, versionNo: r.versionNo };
}

export async function dismissScriptRequestAction(suggestionId: string): Promise<Result> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const me = await actor();
  try { await assertOwnerOfRequest(suggestionId, me); } catch (e) { return fail(e); }
  const { dismissScriptRequest } = await import("@/lib/scriptRequests");
  const r = await dismissScriptRequest(suggestionId, { email: me.email, appUserId: me.id, name: me.name });
  if (r.ok) done();
  return r;
}

export async function discardScriptRequestDraftAction(suggestionId: string): Promise<Result> {
  try { await requireCreativeLead(); } catch (e) { return fail(e); }
  const me = await actor();
  const { discardRequestDraft } = await import("@/lib/scriptRequests");
  const r = await discardRequestDraft(suggestionId, { email: me.email, appUserId: me.id, name: me.name });
  if (r.ok) done();
  return r;
}

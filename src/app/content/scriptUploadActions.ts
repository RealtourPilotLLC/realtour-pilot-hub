"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import type { UploadItemInput, UploadPreview } from "@/lib/scriptUpload";
import type { UploadSource } from "@/lib/scriptUploadParse";

// ---------------------------------------------------------------------------
// "UPLOAD THIS MONTH'S SCRIPTS" (Jordan, Oct 12 2026) — the server actions.
// Owner and admin only (requireAdmin: the REAL role, never an owner's "view
// as"). The work lives in src/lib/scriptUpload.ts; these check who is asking,
// read the files, and keep the page's caches honest. The month's
// recalculation runs after the response where it can (Jordan: every action
// feels instant).
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
type PreviewResult = { ok: true; preview: UploadPreview; message: string } | { ok: false; message: string };

const MAX_FILES = 10;

async function actor(): Promise<{ email: string; appUserId: string | null; name: string | null; realRole: string | null }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return { email: me?.email ?? "dev@local", appUserId: me?.id ?? null, name: me?.name ?? null, realRole: me?.realRole ?? me?.role ?? null };
}

const fail = (e: unknown): { ok: false; message: string } => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

/** Run slow follow-up work after the response; outside a request (a drill), inline. */
async function later(fn: () => Promise<unknown>): Promise<void> {
  const safe = () => fn().then(() => undefined, () => undefined);
  try { after(safe); } catch { await safe(); }
}

function refresh(enrollmentId: string) {
  try { revalidatePath(`/content/${enrollmentId}`); revalidatePath("/content"); } catch { /* outside a request */ }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function previewMessage(p: UploadPreview): string {
  const n = p.drafts.filter((d) => d.isScript).length;
  if (!n) return p.parser === "ai" ? "The AI found no scripts in that either." : "No scripts found. Check the document has Hook / Talking point / Close labels — or let AI split it.";
  return `Found ${plural(n, "script")} for ${p.monthName}.`;
}

/** Upload → preview. Files (.docx, .pdf, .txt, .md) and/or pasted text. Writes nothing. */
export async function previewScriptUploadAction(enrollmentId: string, monthId: string, form: FormData): Promise<PreviewResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { extractDocumentText, MAX_DOCUMENT_BYTES } = await import("@/lib/documentText");
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_FILES) return { ok: false, message: `Up to ${MAX_FILES} files at a time.` };
    const sources: UploadSource[] = [];
    for (const f of files) {
      if (f.size > MAX_DOCUMENT_BYTES) return { ok: false, message: `${f.name} is too large (max 15 MB).` };
      const r = await extractDocumentText(Buffer.from(await f.arrayBuffer()), f.name);
      if (!r.ok) return { ok: false, message: `${f.name}: ${r.message}` };
      sources.push({ name: f.name, text: r.text });
    }
    const pasted = form.get("text");
    if (typeof pasted === "string" && pasted.trim()) sources.push({ name: "Pasted text", text: pasted.trim() });
    if (!sources.length) return { ok: false, message: "Choose a file or paste the scripts first." };
    const { buildUploadPreview } = await import("@/lib/scriptUpload");
    const preview = await buildUploadPreview({ enrollmentId, monthId, sources });
    return { ok: true, preview, message: previewMessage(preview) };
  } catch (e) { return fail(e); }
}

/** Re-read a list the staff shaped (a merge). Writes nothing. */
export async function rereadScriptUploadAction(enrollmentId: string, monthId: string, items: UploadItemInput[], sources: UploadSource[], parser: "house" | "ai" = "house", aiRunId: string | null = null): Promise<PreviewResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { buildUploadPreview } = await import("@/lib/scriptUpload");
    const preview = await buildUploadPreview({ enrollmentId, monthId, items: (items ?? []).slice(0, 40), keepSources: (sources ?? []).slice(0, MAX_FILES + 1), parser, aiRunId });
    return { ok: true, preview, message: previewMessage(preview) };
  } catch (e) { return fail(e); }
}

/** "Let AI split it" — attended (a person clicked), logged as a ProgramAiRun, words checked against the document. */
export async function aiSplitScriptUploadAction(enrollmentId: string, monthId: string, sources: UploadSource[]): Promise<PreviewResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { aiSplitUpload } = await import("@/lib/scriptUpload");
    const preview = await aiSplitUpload({ enrollmentId, monthId, sources: (sources ?? []).filter((s) => s && typeof s.text === "string").slice(0, MAX_FILES + 1), requestedBy: me.email });
    return { ok: true, preview, message: previewMessage(preview) };
  } catch (e) { return fail(e); }
}

/** Confirm: the month's topics + the scripts, as one upload Undo can take back. */
export async function confirmScriptUploadAction(input: {
  enrollmentId: string; monthId: string; fileNames: string[]; parser?: "house" | "ai"; aiRunId?: string | null;
  items: UploadItemInput[]; replaceTopicIds?: string[];
}): Promise<Result & { batchId?: string }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { applyScriptUpload } = await import("@/lib/scriptUpload");
    const r = await applyScriptUpload(input, me);
    // Choosing the route already recalculated the month; a month that kept its call recalculates here.
    if (!r.routeChosen) await later(async () => { const { recalcProgramMonth } = await import("@/lib/programMonths"); await recalcProgramMonth(input.monthId); });
    refresh(input.enrollmentId);
    return { ok: true, message: r.message, batchId: r.batchId };
  } catch (e) { return fail(e); }
}

/** "Send to the client for review": approve + release the upload's scripts (the one share); the portal shows them. */
export async function sendScriptUploadAction(batchId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { uploadScope, sendScriptUpload } = await import("@/lib/scriptUpload");
    const scope = await uploadScope(batchId);
    const { assertDutyOwner } = await import("@/lib/contentProgram");
    await assertDutyOwner("SCRIPTS", scope.enrollmentId, scope.monthId, { id: me.appUserId, email: me.email, realRole: me.realRole });
    const r = await sendScriptUpload(batchId, me);
    // Approvals move the month toward filming — persisted now, not at the next sweep.
    if (r.sent) await later(async () => { const { recalcProgramMonth } = await import("@/lib/programMonths"); await recalcProgramMonth(r.monthId); });
    refresh(r.enrollmentId);
    return { ok: r.sent > 0, message: r.message };
  } catch (e) { return fail(e); }
}

/** Take an upload back — only while nothing from it is with the client. */
export async function undoScriptUploadAction(batchId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { undoScriptUpload } = await import("@/lib/scriptUpload");
    const r = await undoScriptUpload(batchId, me);
    refresh(r.enrollmentId);
    return { ok: true, message: r.message };
  } catch (e) { return fail(e); }
}

import "server-only";
import { prisma } from "@/lib/prisma";
import type { TalkingPointRole } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// THE CLIENT'S SCRIPT CHANGE REQUESTS, WORKED BY THE OFFICE (Oct 20 2026).
//
// Jordan, on Marcee McMullen's requests: "I'd like to be able to take what
// she wrote and apply it, or take what she wrote and edit it and then apply
// it, and then add a message below to be able to respond. I don't want to hit
// Apply with AI and then lose her response. I also would like to be able to
// see my original version here to compare them ... I want these features for
// anyone asking for a script change."
//
// A request (ScriptSuggestion) is the client's words: a note, a pasted
// rewrite ("HOOK … TALKING POINT 1 … CLOSE / CTA"), or, since today, their own
// edit of the script in place (editedPartsJson). The office now:
//   · sees the version they read beside their words;
//   · USES THEIR VERSION: their parts laid over the version they read (a full
//     rewrite replaces every part; a note that changes one part, "Close/CTA:
//     …", changes only that part);
//   · EDITS AND USES: the same parts open in the editor first;
//   · or applies with AI as before (their words stay on the record);
// and either of the first two becomes the next version, approved by the
// person who pressed it and shared with the client for their OK (never a
// sign-off on their behalf). Their words are never deleted: a handled request
// stays on the card with how it was handled and the version it became.
// Replies go to their Messages, marked as about that script, and show under
// the script on their page.
// ---------------------------------------------------------------------------

export type RequestParts = { hook: string; points: { role: "re-hook" | "build-up" | "payoff" | null; text: string }[]; close: string; captionCta: string | null };
export type EditedWords = { hook: string; points: string[]; close: string; captionCta?: string | null };
export type RequestPart = "hook" | "point1" | "point2" | "point3" | "point4" | "close" | "caption";

const asRole = (r: string | null | undefined): RequestParts["points"][number]["role"] => (r === "re-hook" || r === "build-up" || r === "payoff" ? r : null);
const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();

export function editedWordsOf(json: string | null | undefined): EditedWords | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as EditedWords;
    return v && typeof v.hook === "string" && Array.isArray(v.points) && typeof v.close === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Which parts differ between two sets of parts. */
export function changedParts(a: RequestParts, b: RequestParts): RequestPart[] {
  const out: RequestPart[] = [];
  if (norm(a.hook) !== norm(b.hook)) out.push("hook");
  b.points.forEach((p, i) => { if (norm(a.points[i]?.text) !== norm(p.text)) out.push(`point${i + 1}` as RequestPart); });
  if (norm(a.close) !== norm(b.close)) out.push("close");
  if (norm(a.captionCta) !== norm(b.captionCta)) out.push("caption");
  return out;
}

/**
 * Their words laid over the version they read. Null when there is nothing in
 * them shaped like a script part (a plain note): then only "Edit and use"
 * (starting from the version they read) or "Apply with AI" can act on it.
 * `full` = they rewrote the hook, every talking point and the close.
 */
export async function mergeRequestParts(base: RequestParts, input: { body: string; editedPartsJson?: string | null; title?: string | null }): Promise<{ parts: RequestParts; full: boolean; changed: RequestPart[] } | null> {
  const edited = editedWordsOf(input.editedPartsJson);
  if (edited) {
    const parts: RequestParts = {
      hook: edited.hook,
      points: base.points.map((p, i) => ({ role: p.role, text: edited.points[i] ?? p.text })),
      close: edited.close,
      captionCta: edited.captionCta === undefined ? base.captionCta : edited.captionCta ?? null,
    };
    const changed = changedParts(base, parts);
    return changed.length ? { parts, full: true, changed } : null;
  }
  const { readUploadedScript, hasScriptParts } = await import("@/lib/scriptUploadParse");
  const r = readUploadedScript(input.body ?? "", { title: input.title ?? null });
  if (!hasScriptParts(r)) return null;
  const parts: RequestParts = { hook: base.hook, points: base.points.map((p) => ({ ...p })), close: base.close, captionCta: base.captionCta };
  const pts = r.points.filter((p) => p.text.trim());
  if (r.hook.trim()) parts.hook = r.hook.trim();
  if (pts.length === base.points.length) {
    pts.forEach((p, i) => { parts.points[i] = { role: base.points[i].role, text: p.text.trim() }; });
  } else {
    // A note on one or two points: each lands on the point with its role.
    for (const p of pts) {
      const i = p.role ? base.points.findIndex((b) => b.role === p.role) : -1;
      if (i >= 0) parts.points[i] = { role: base.points[i].role, text: p.text.trim() };
    }
  }
  if (r.close.trim()) parts.close = r.close.trim();
  if (r.caption?.trim()) parts.captionCta = r.caption.trim();
  const changed = changedParts(base, parts);
  if (!changed.length) return null;
  return { parts, full: !!r.hook.trim() && pts.length === base.points.length && !!r.close.trim(), changed };
}

type VersionRow = Parameters<typeof import("@/lib/contentScripts").partsFromVersionRow>[0] & { id: string; versionNo: number; scriptId: string };

function requestPartsOf(v: { hook: string; points: { role: TalkingPointRole | null; text: string }[]; close: string; captionCta?: string | null }): RequestParts {
  return { hook: v.hook, points: v.points.map((p) => ({ role: asRole(p.role), text: p.text })), close: v.close, captionCta: v.captionCta ?? null };
}

/** Script text in the house layout, for a client's in-place edit filed as a request. */
export function wordsAsText(base: RequestParts, w: EditedWords): string {
  const label = (i: number) => {
    const role = base.points[i]?.role;
    return `TALKING POINT ${i + 1}${role === "re-hook" ? ": RE-HOOK" : role === "build-up" ? ": BUILD-UP" : role === "payoff" ? ": PAYOFF" : ""}`;
  };
  return [
    "I edited the script:", "",
    "HOOK", w.hook.trim(), "",
    ...w.points.flatMap((t, i) => [label(i), t.trim(), ""]),
    "CLOSE", w.close.trim(),
    ...(w.captionCta?.trim() ? ["", "CAPTION", w.captionCta.trim()] : []),
  ].join("\n");
}

/** The version a request was made on (else the script's current one), and its parts. */
async function readVersionFor(sugg: { scriptId: string; scriptVersionId: string | null }): Promise<{ row: VersionRow; parts: RequestParts } | null> {
  const s = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { currentVersionId: true, sharedVersionId: true } });
  const id = sugg.scriptVersionId ?? s?.sharedVersionId ?? s?.currentVersionId ?? null;
  if (!id) return null;
  const row = await prisma.contentScriptVersion.findUnique({ where: { id } });
  if (!row || row.scriptId !== sugg.scriptId) return null;
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  return { row: row as unknown as VersionRow, parts: requestPartsOf(partsFromVersionRow(row)) };
}

/** Plain words for a shape rule the office's edit broke (the editor keeps the text). */
function plainShape(f: { code: string; path?: string | null }): string {
  const n = /points\[(\d+)\]/.exec(f.path ?? "")?.[1];
  const tp = n != null ? `Talking point ${Number(n) + 1}` : "A talking point";
  switch (f.code) {
    case "hook.missing": return "The hook can't be empty.";
    case "hook.banned-opener": return "The hook starts with a greeting or an introduction. Start with the point itself.";
    case "intro.greeting": return `${tp} has a greeting or an introduction in it.`;
    case "talking-points.empty": return `${tp} is empty.`;
    case "close.missing": return "The close can't be empty.";
    default: return "That breaks the script's shape (a hook, three talking points and a close).";
  }
}

export type ApplyOutcome = { ok: boolean; message: string; versionNo?: number };

/**
 * "Use their version" (HERS) or "Edit and use" (EDITED, with the editor's
 * words). A new version on top of the version they read, approved by the
 * person who pressed it and shared with the client for their OK.
 */
export async function applyRequestWords(suggestionId: string, how: "HERS" | "EDITED", words: EditedWords | null, actor: { email: string; appUserId: string | null }): Promise<ApplyOutcome> {
  const sugg = await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId } });
  if (!sugg || sugg.status !== "OPEN") return { ok: false, message: "That request was already handled." };
  const script = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { id: true, title: true, historical: true, clientId: true, enrollmentId: true } });
  if (!script) return { ok: false, message: "That script no longer exists." };
  if (script.historical) return { ok: false, message: "This is an imported historical script. It isn't rewritten; draft a new script for the topic instead." };
  const read = await readVersionFor(sugg);
  if (!read) return { ok: false, message: "The version they read isn't on file any more." };

  let w: EditedWords;
  if (how === "HERS") {
    const m = await mergeRequestParts(read.parts, { body: sugg.body, editedPartsJson: sugg.editedPartsJson, title: script.title });
    if (!m) return { ok: false, message: "Their note isn't laid out as a script (hook, talking points, close), so there's nothing to use as it is. Use Edit and use, or Apply with AI." };
    w = { hook: m.parts.hook, points: m.parts.points.map((p) => p.text), close: m.parts.close, captionCta: m.parts.captionCta };
  } else {
    if (!words) return { ok: false, message: "Nothing to save." };
    w = words;
  }
  if (!Array.isArray(w.points) || w.points.length !== read.parts.points.length) return { ok: false, message: "Something changed on the page. Reload it and try again." };

  const { partsFromVersionRow, canonicalFromParts, approvedPillarsFor, editScriptVersion, approveScriptVersion, releaseScriptVersion, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const kept = partsFromVersionRow(read.row);
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, 2000);
  const parts = {
    ...kept,
    hook: clean(w.hook),
    points: kept.points.map((p, i) => ({ role: p.role, text: clean(w.points[i]) })),
    close: clean(w.close),
    captionCta: w.captionCta === undefined ? kept.captionCta : clean(w.captionCta) || null,
  };
  if (!changedParts(read.parts, requestPartsOf(parts)).length) return { ok: false, message: "That's the same as the version they read. Change something, or Dismiss the request." };
  const check = validateNewScript(canonicalFromParts(parts, script.clientId), { approvedPillars: await approvedPillarsFor(script.enrollmentId), clientFormat: await clientScriptFormat(script.enrollmentId) });
  const shape = check.findings.find((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  if (shape) return { ok: false, message: plainShape(shape) };

  // One person at a time (a double click must not make two versions).
  const claimed = await prisma.scriptSuggestion.updateMany({ where: { id: sugg.id, status: "OPEN" }, data: { status: "APPLYING" } });
  if (claimed.count !== 1) return { ok: false, message: "That request is being applied already." };
  const when = sugg.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const summary = how === "HERS"
    ? `The client's version from their change request of ${when}, used as written (from v${read.row.versionNo})`
    : `The client's change request of ${when}, edited by ${actor.email} (from v${read.row.versionNo})`;
  try {
    const v = await editScriptVersion(script.id, parts, actor.email, summary);
    await approveScriptVersion(v.versionId, actor, `Applied the client's change request (${how === "HERS" ? "their version" : "edited"}).`);
    await releaseScriptVersion(script.id, actor, { note: summary });
    await prisma.scriptSuggestion.update({ where: { id: sugg.id }, data: { status: "APPLIED", appliedHow: how, appliedVersionId: v.versionId, resolvedAt: new Date(), resolvedBy: actor.email } });
    const client = await prisma.client.findUnique({ where: { id: script.clientId }, select: { name: true } }).catch(() => null);
    const first = (client?.name ?? "").split(" ")[0] || "the client";
    return { ok: true, versionNo: v.versionNo, message: `Saved as v${v.versionNo} and shared with ${first} for their OK.` };
  } catch (e) {
    await prisma.scriptSuggestion.updateMany({ where: { id: sugg.id, status: "APPLYING" }, data: { status: "OPEN" } }).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message : "That didn't save. Try again." };
  }
}

/**
 * The client edits the words of a script that is waiting on their OK (Oct 20
 * 2026, Jordan: "I also want them to be able to edit the scripts on their
 * side"). Their edit is a change request carrying the exact words, so the
 * office can use it as written, polish it, or answer it. (An APPROVED script
 * is theirs to edit directly: scriptEdits.adoptEditedScript.)
 */
export async function clientEditAsRequest(viewer: import("@/lib/portal").PortalViewer, scriptId: string, readVersionId: string, words: EditedWords): Promise<{ ok: boolean; message: string }> {
  if (!/^[a-z0-9]{10,40}$/i.test(scriptId) || !/^[a-z0-9]{10,40}$/i.test(readVersionId)) return { ok: false, message: "That script isn't on your page." };
  const row = await prisma.contentScriptVersion.findUnique({ where: { id: readVersionId } });
  if (!row || row.scriptId !== scriptId || row.enrollmentId !== viewer.enrollment.id) return { ok: false, message: "That script isn't on your page." };
  const { partsFromVersionRow, canonicalFromParts, approvedPillarsFor, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const kept = partsFromVersionRow(row);
  const base = requestPartsOf(kept);
  if (!Array.isArray(words.points) || words.points.length !== base.points.length) return { ok: false, message: "Something changed on the page. Reload it and try again." };
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 2000);
  const w: EditedWords = { hook: clean(words.hook), points: words.points.map(clean), close: clean(words.close), captionCta: words.captionCta === undefined ? undefined : clean(words.captionCta) || null };
  const next: RequestParts = { hook: w.hook, points: base.points.map((p, i) => ({ role: p.role, text: w.points[i] })), close: w.close, captionCta: w.captionCta === undefined ? base.captionCta : w.captionCta ?? null };
  if (!changedParts(base, next).length) return { ok: false, message: "No changes to send." };
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const check = validateNewScript(canonicalFromParts({ ...kept, hook: next.hook, points: next.points, close: next.close, captionCta: next.captionCta }, row.clientId), { approvedPillars: await approvedPillarsFor(row.enrollmentId), clientFormat: await clientScriptFormat(row.enrollmentId) });
  const shape = check.findings.find((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  if (shape) return { ok: false, message: plainShape(shape) };
  const { clientRequestScriptChanges } = await import("@/lib/scriptDecisions");
  const r = await clientRequestScriptChanges(viewer, scriptId, wordsAsText(base, w), readVersionId, { editedParts: w });
  return r.ok ? { ok: true, message: "Sent. We'll read your edit and share the final version here for your OK." } : { ok: false, message: r.message };
}

/** A reply to the client about their request: their Messages, marked as about that script. */
export async function replyToScriptRequest(suggestionId: string, bodyRaw: string, me: { id: string | null; name: string | null; email: string | null }): Promise<{ ok: boolean; message: string }> {
  const body = (bodyRaw ?? "").trim();
  if (body.length < 2) return { ok: false, message: "Write the reply first." };
  const sugg = await prisma.scriptSuggestion.findUnique({ where: { id: suggestionId }, select: { scriptId: true, enrollmentId: true } });
  if (!sugg) return { ok: false, message: "That request is gone." };
  const script = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { title: true } });
  const { postStaffMessage } = await import("@/lib/programMessages");
  const r = await postStaffMessage(sugg.enrollmentId, me, `About your script "${script?.title ?? "your script"}":\n\n${body}`, null, { ref: { kind: "SCRIPT", id: sugg.scriptId } });
  return r.ok ? { ok: true, message: `Sent to their Messages, and shown under the script on their page.` } : { ok: false, message: r.message };
}

/** "About your script "…":" off the front of a reply, for showing it under that script. */
export function replyText(body: string): string {
  return body.replace(/^About your script "[^"\n]*":\s*/, "").trim();
}

export type ScriptRequestView = {
  id: string; body: string; createdAtISO: string; status: string;
  appliedHow: string | null; appliedVersionNo: number | null; resolvedAtISO: string | null; resolvedBy: string | null;
  readVersionNo: number | null; readParts: RequestParts | null;
  merged: { parts: RequestParts; full: boolean; changed: RequestPart[] } | null;
  edited: boolean;
  replies: { body: string; atISO: string; by: string }[];
};
export type ScriptRequestGroupView = { scriptId: string; title: string; versionNo: number | null; clientFirst: string; requests: ScriptRequestView[] };

/** Every request on this month's scripts: open ones first, the handled ones kept (60 days) with how. */
export async function loadScriptRequestsForMonth(monthId: string): Promise<ScriptRequestGroupView[]> {
  const scripts = await prisma.contentScript.findMany({ where: { monthId }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, currentVersionId: true, clientId: true, enrollmentId: true } });
  if (!scripts.length) return [];
  const since = new Date(Date.now() - 60 * 86_400_000);
  const reqs = await prisma.scriptSuggestion.findMany({
    where: { scriptId: { in: scripts.map((s) => s.id) }, OR: [{ status: { in: ["OPEN", "APPLYING"] } }, { resolvedAt: { gte: since } }, { createdAt: { gte: since } }] },
    orderBy: { createdAt: "asc" },
  });
  if (!reqs.length) return [];
  const versionIds = [...new Set([...scripts.map((s) => s.currentVersionId), ...reqs.map((r) => r.scriptVersionId), ...reqs.map((r) => r.appliedVersionId)].filter((x): x is string => !!x))];
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } } });
  const vById = new Map(versions.map((v) => [v.id, v]));
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  const replies = await prisma.programMessage.findMany({ where: { refKind: "SCRIPT", refId: { in: scripts.map((s) => s.id) }, authorKind: "STAFF" }, orderBy: { createdAt: "asc" }, select: { refId: true, body: true, createdAt: true, authorLabel: true } });
  const client = await prisma.client.findUnique({ where: { id: scripts[0].clientId }, select: { name: true } }).catch(() => null);
  const clientFirst = (client?.name ?? "").split(" ")[0] || "the client";
  const out: ScriptRequestGroupView[] = [];
  for (const s of scripts) {
    const mine = reqs.filter((r) => r.scriptId === s.id);
    if (!mine.length) continue;
    const requests: ScriptRequestView[] = [];
    for (const [i, r] of mine.entries()) {
      const readRow = (r.scriptVersionId && vById.get(r.scriptVersionId)) || (s.currentVersionId && vById.get(s.currentVersionId)) || null;
      const readParts = readRow ? requestPartsOf(partsFromVersionRow(readRow)) : null;
      const merged = readParts ? await mergeRequestParts(readParts, { body: r.body, editedPartsJson: r.editedPartsJson, title: s.title }) : null;
      const next = mine[i + 1]?.createdAt ?? null;
      requests.push({
        id: r.id, body: r.body, createdAtISO: r.createdAt.toISOString(), status: r.status,
        appliedHow: r.appliedHow, appliedVersionNo: r.appliedVersionId ? vById.get(r.appliedVersionId)?.versionNo ?? null : null,
        resolvedAtISO: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy,
        readVersionNo: readRow?.versionNo ?? null, readParts, merged, edited: !!editedWordsOf(r.editedPartsJson),
        replies: replies.filter((m) => m.refId === s.id && m.createdAt >= r.createdAt && (!next || m.createdAt < next)).map((m) => ({ body: replyText(m.body), atISO: m.createdAt.toISOString(), by: m.authorLabel })),
      });
    }
    // Open first, then handled newest first.
    requests.sort((a, b) => Number(b.status === "OPEN" || b.status === "APPLYING") - Number(a.status === "OPEN" || a.status === "APPLYING") || (a.status === "OPEN" ? a.createdAtISO.localeCompare(b.createdAtISO) : b.createdAtISO.localeCompare(a.createdAtISO)));
    out.push({ scriptId: s.id, title: s.title, versionNo: s.currentVersionId ? vById.get(s.currentVersionId)?.versionNo ?? null : null, clientFirst, requests });
  }
  // Scripts with something open first.
  return out.sort((a, b) => Number(b.requests.some((r) => r.status === "OPEN")) - Number(a.requests.some((r) => r.status === "OPEN")));
}

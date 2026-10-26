import "server-only";

import { prisma } from "@/lib/prisma";
import type { PortalViewer } from "@/lib/portal";
import type { TalkingPointRole } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// EDITING AN APPROVED SCRIPT, OUTSIDE THE OFFICE (Oct 14 2026).
//
// Jordan: "the agents are able to ... edit the scripts themselves after they
// approve it" and the photographers "to edit each individual script on site".
// Both edit the WORDS of the script they are about to film (hook, the three
// talking points, the close, the caption line), never its shape, and the edit
// becomes the script everywhere at once: the agent's portal, the photographer's
// shoot screen, the editor's brief and the PDF.
//
// One path for both: a new version on top of the one they were looking at
// (nothing is overwritten; the trail keeps every version and the office can
// restore any of them), approved with a note saying who changed it and where,
// released when the script was already on the agent's page, and the agent's
// sign-off recorded on the new words:
//   · the agent's own edit IS their sign-off on what they wrote;
//   · an on-site edit carries the agent's sign-off on the version it started
//     from, with a note that it was changed at the shoot. No sign-off before,
//     none after: the photographer never approves for the agent.
// The office hears about every edit on the bell. Shape rules still hold (a
// hook, three talking points, a close, no greeting): an edit that breaks one
// is refused in plain words, with the text left in the box.
//
// OCT 26 2026 (Jordan: "Just give them an edit button and the ability to undo
// their edit or view the previous version"). The account owner may edit a
// script BEFORE approving it too: the edit becomes the shared version and
// still waits on their Approve (no sign-off is recorded for them). Every
// client edit is marked in its version's validation bag (`clientEdit`: the
// version it started from), and `undoClientEdit` puts the words before it back
// as one more version on top (marked `undo`), only while their edit is the
// version on their page. The portal reads the mark (clientEditInfo) to offer
// "Undo my edit" and "View previous version".
// ---------------------------------------------------------------------------

export type EditedWords = { hook: string; points: string[]; close: string; captionCta?: string | null };

export type EditBy =
  | { kind: "CLIENT"; viewer: PortalViewer }
  | { kind: "CREW"; email: string; appUserId: string | null; name: string; projectId: string };

export type EditOutcome = { ok: true; versionId: string; versionNo: number; message: string; unchanged?: boolean } | { ok: false; message: string; stale?: boolean };

/** The mark a client's own edit (or its undo) leaves in the version's validation bag. */
export type ClientEditMark = { from: string; fromNo: number; by: string; undo?: boolean };
export const CLIENT_EDIT_KEY = "clientEdit";
const LEGACY_CLIENT_EDIT = /^Edited by the client \(/;

/** The client-edit mark of a version, from its bag (or, for an edit saved before Oct 26 2026, its change note). */
export function clientEditMarkOf(v: { validationJson: string | null; changeSummary: string | null; basedOnVersionId: string | null }): ClientEditMark | null {
  try {
    const bag = v.validationJson ? JSON.parse(v.validationJson) as Record<string, unknown> : null;
    const m = bag?.[CLIENT_EDIT_KEY] as ClientEditMark | undefined;
    if (m && typeof m.from === "string") return m;
  } catch { /* an unreadable bag is no mark */ }
  if (v.basedOnVersionId && LEGACY_CLIENT_EDIT.test(v.changeSummary ?? "")) return { from: v.basedOnVersionId, fromNo: Number(/after approving v(\d+)/.exec(v.changeSummary ?? "")?.[1] ?? 0), by: "" };
  return null;
}

const ID_RE = /^[a-z0-9]{10,40}$/i;
const PART_CAP = 2000;

/** Plain words for the shape rules a client or photographer can trip. */
function plainRefusal(f: { code: string; message: string; path?: string | null }): string {
  const n = /points\[(\d+)\]/.exec(f.path ?? "")?.[1];
  const tp = n != null ? `Talking point ${Number(n) + 1}` : "A talking point";
  switch (f.code) {
    case "hook.missing": return "The hook can't be empty.";
    case "hook.banned-opener": return "Start the hook with the point itself, not a greeting or an introduction (like \"Hi, I'm...\").";
    case "intro.greeting": return `${tp} has a greeting or an introduction in it. Take that out and go straight to the point.`;
    case "talking-points.empty": return `${tp} can't be empty.`;
    case "close.missing": return "The close can't be empty.";
    default: return "That edit changes the shape of the script (a hook, three talking points and a close). Keep each part and try again.";
  }
}

/** The version a photographer's shoot screen shows for this script (the same rule as shoot.withOfficeApprovedScripts). */
export async function versionOnShootScreen(s: { approvedVersionId: string | null; sharedVersionId: string | null }): Promise<string | null> {
  if (s.approvedVersionId && s.approvedVersionId !== s.sharedVersionId) {
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.approvedVersionId }, select: { status: true } });
    if (v && (v.status === "APPROVED" || v.status === "SHARED")) return s.approvedVersionId;
  }
  return s.sharedVersionId;
}

export async function adoptEditedScript(scriptId: string, baseVersionId: string, words: EditedWords, by: EditBy, opts: { undoOf?: { versionNo: number } } = {}): Promise<EditOutcome> {
  if (!ID_RE.test(scriptId) || !ID_RE.test(baseVersionId)) return { ok: false, message: "That script isn't available." };
  const s = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, clientId: true, monthId: true, topicId: true, title: true, historical: true, releaseState: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true, clientApprovedVersionId: true },
  });
  if (!s || s.historical) return { ok: false, message: "That script isn't available." };

  // WHO MAY EDIT WHICH VERSION.
  const released = s.releaseState === "released" && !!s.sharedVersionId;
  // Oct 26 2026: the owner may edit before approving; their approval stays theirs to give.
  let clientApproved = false;
  if (by.kind === "CLIENT") {
    const v = by.viewer;
    if (s.enrollmentId !== v.enrollment.id || s.clientId !== v.enrollment.clientId || !released) return { ok: false, message: "That script isn't on your page." };
    if (v.access !== "FULL") return { ok: false, message: "Your access is read-only right now. Send us a message and we'll sort it." };
    if (s.sharedVersionId !== baseVersionId) return { ok: false, stale: true, message: "We've published a newer version of this script since this page loaded. Refresh to read it, then make your edit." };
    const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
    const d = (await scriptDecisionsFor(s.enrollmentId, [s.id])).get(s.id);
    clientApproved = d?.decision === "APPROVED";
  } else {
    const shown = await versionOnShootScreen(s);
    if (!shown) return { ok: false, message: "This script is still with the office, so it can't be edited here yet." };
    if (shown !== baseVersionId) return { ok: false, stale: true, message: "The office changed this script since the page loaded. Reload the page, then make your edit." };
  }

  const base = await prisma.contentScriptVersion.findUnique({ where: { id: baseVersionId } });
  if (!base || base.scriptId !== s.id) return { ok: false, message: "That script isn't available." };
  const { partsFromVersionRow, canonicalFromParts, approvedPillarsFor, createScriptVersion, approveScriptVersion, releaseScriptVersion, sanitizeScriptParts, STRUCTURAL_CODES } = await import("@/lib/contentScripts");
  const { validateNewScript } = await import("@/lib/contentPolicy");
  const kept = partsFromVersionRow(base);

  // THE WORDS. Same number of talking points as the version it started from,
  // each keeping its role; the title, pillar and every office note carry over.
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, PART_CAP);
  if (!Array.isArray(words.points) || words.points.length !== kept.points.length) return { ok: false, message: "Something changed on the page. Reload it and try again." };
  const parts = sanitizeScriptParts({
    ...kept,
    hook: clean(words.hook),
    points: kept.points.map((p, i) => ({ role: p.role as TalkingPointRole | null, text: clean(words.points[i]) })),
    close: clean(words.close),
    captionCta: words.captionCta === undefined ? kept.captionCta : clean(words.captionCta) || null,
  });
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();
  if (same(parts.hook, kept.hook) && same(parts.close, kept.close) && same(parts.captionCta, kept.captionCta) && parts.points.every((p, i) => same(p.text, kept.points[i]?.text))) {
    return { ok: true, unchanged: true, versionId: base.id, versionNo: base.versionNo, message: "No changes to save." };
  }
  const { clientScriptFormat } = await import("@/lib/bulkPlan");
  const check = validateNewScript(canonicalFromParts(parts, s.clientId), { approvedPillars: await approvedPillarsFor(s.enrollmentId), clientFormat: await clientScriptFormat(s.enrollmentId) });
  const shapeBreak = check.findings.find((f) => f.severity === "block" && STRUCTURAL_CODES.has(f.code));
  if (shapeBreak) return { ok: false, message: plainRefusal(shapeBreak) };

  // A DRAFT THE OFFICE WAS WORKING ON is left in the trail, not lost: the edit
  // goes on top and the bell says which draft it passed.
  const draftNo = s.currentVersionId && s.currentVersionId !== baseVersionId
    ? (await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId }, select: { versionNo: true } }))?.versionNo ?? null
    : null;

  const who = by.kind === "CLIENT" ? (await import("@/lib/portalAccess")).actorLabel(by.viewer) : `${by.name} (on site)`;
  const actor = by.kind === "CLIENT" ? { email: who, appUserId: null } : { email: by.email, appUserId: by.appUserId };
  const summary = by.kind === "CREW"
    ? `Edited on site at the shoot by ${by.name} (from v${base.versionNo})`
    : opts.undoOf
      ? `The client (${who}) undid their edit: back to the words of v${opts.undoOf.versionNo}`
      : clientApproved ? `Edited by the client (${who}) after approving v${base.versionNo}` : `Edited by the client (${who}) before approving, from v${base.versionNo}`;
  const mark: ClientEditMark | null = by.kind === "CLIENT" ? { from: base.id, fromNo: base.versionNo, by: who, ...(opts.undoOf ? { undo: true } : {}) } : null;
  const created = await createScriptVersion({
    scriptId: s.id, enrollmentId: s.enrollmentId, monthId: s.monthId, topicId: s.topicId, parts,
    source: by.kind === "CLIENT" ? "CLIENT_REQUEST" : "MANUAL", basedOnVersionId: base.id, createdBy: actor.email,
    changeSummary: summary, status: "INTERNAL_REVIEW", validation: { ok: check.ok, findings: check.findings, ...(mark ? { [CLIENT_EDIT_KEY]: mark } : {}) } as { ok: boolean; findings: typeof check.findings }, gaps: check.gaps,
  });
  // Approved with the note (a pillar-mapping finding is the office's to sort,
  // never a reason to refuse the agent's own words), released when it was live.
  await approveScriptVersion(created.versionId, actor, summary);
  if (released) await releaseScriptVersion(s.id, actor, { note: summary, quiet: by.kind === "CLIENT" ? "the client's own edit, nothing to announce." : "edited on site with the client, nothing to announce." });

  // THE AGENT'S SIGN-OFF ON THE NEW WORDS (only when they had approved: an
  // edit before approving still waits on their Approve).
  let signOff = false;
  if (released && by.kind === "CLIENT" && clientApproved) {
    const { clientApproveScript } = await import("@/lib/scriptDecisions");
    const r = await clientApproveScript(by.viewer, s.id, created.versionId).catch(() => null);
    signOff = !!r?.ok;
  } else if (released && by.kind === "CREW" && s.clientApprovedVersionId === base.id) {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.contentScriptRelease.create({
        data: {
          scriptId: s.id, scriptVersionId: created.versionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId,
          action: "CLIENT_APPROVED", actorClientUserId: null, actorEmail: `${by.name} (on site)`,
          note: `Edited on site at the shoot by ${by.name}; carries the client's sign-off on v${base.versionNo}.`,
        },
      });
      await tx.contentScript.updateMany({ where: { id: s.id, sharedVersionId: created.versionId }, data: { clientApprovedVersionId: created.versionId, clientApprovedAt: now, clientChangesAt: null } });
    });
    signOff = true;
  }

  // The office hears about it.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const c = await prisma.client.findUnique({ where: { id: s.clientId }, select: { name: true } }).catch(() => null);
    const clientName = c?.name ?? "a client";
    await notifyInApp({
      kind: "script_edited",
      title: by.kind === "CREW" ? `Script edited on site: ${clientName}` : opts.undoOf ? `Script edit undone by ${clientName}` : `Script edited by ${clientName}`,
      body: opts.undoOf
        ? `${who} undid their edit of "${base.title}": the words of v${opts.undoOf.versionNo} are back (v${base.versionNo} → v${created.versionNo}).${draftNo ? ` A newer office draft (v${draftNo}) was set aside under it.` : ""}`
        : `${who} changed the wording of "${base.title}" (v${base.versionNo} → v${created.versionNo})${by.kind === "CLIENT" && !clientApproved ? " before approving it" : ""}.${draftNo ? ` A newer office draft (v${draftNo}) was set aside under it.` : ""}`,
      href: by.kind === "CREW" ? `/shoot/${by.projectId}` : `/content/${s.enrollmentId}?tab=plan&view=scripts`,
      targets: [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }],
      dedupeKey: `script-edited-${created.versionId}`,
    });
  } catch { /* the bell is best-effort */ }

  return {
    ok: true,
    versionId: created.versionId,
    versionNo: created.versionNo,
    message: by.kind === "CLIENT"
      ? opts.undoOf
        ? "Done. The script is back to the wording before your edit."
        : clientApproved ? "Saved. This is the version we'll film, and the PDF has your new wording." : "Saved. Your wording is the script now. Approve it when you're happy with it."
      : signOff ? "Saved. The agent's page and the PDF have the new wording." : released ? "Saved. The agent's page and the PDF have the new wording; the agent hasn't approved this script yet." : "Saved. The PDF has the new wording.",
  };
}

/**
 * "UNDO MY EDIT" (Oct 26 2026). The version on the client's page is their own
 * edit: the words it started from go back on as one more version (nothing is
 * deleted; the office's trail keeps both), approved and released the same way,
 * and their sign-off follows the edit's (approved before, approved after).
 * Refused once anything newer has been shared, or when the page is stale.
 */
export async function undoClientEdit(viewer: PortalViewer, scriptId: string, readVersionId: string): Promise<EditOutcome> {
  if (!ID_RE.test(scriptId) || !ID_RE.test(readVersionId)) return { ok: false, message: "That script isn't available." };
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true, sharedVersionId: true } });
  if (!s || s.enrollmentId !== viewer.enrollment.id) return { ok: false, message: "That script isn't on your page." };
  if (s.sharedVersionId !== readVersionId) return { ok: false, stale: true, message: "We've shared a newer version of this script since your edit, so your edit can't be undone now. Refresh to read the latest one, and edit it again if you like." };
  const edit = await prisma.contentScriptVersion.findUnique({ where: { id: readVersionId }, select: { scriptId: true, validationJson: true, changeSummary: true, basedOnVersionId: true } });
  const mark = edit && edit.scriptId === scriptId ? clientEditMarkOf(edit) : null;
  if (!mark || mark.undo) return { ok: false, message: "There's no edit of yours to undo on this script." };
  const before = await prisma.contentScriptVersion.findUnique({ where: { id: mark.from } });
  if (!before || before.scriptId !== scriptId) return { ok: false, message: "The earlier wording isn't available, so this can't be undone here. Send us a message and we'll put it back." };
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  const was = partsFromVersionRow(before);
  return adoptEditedScript(scriptId, readVersionId, { hook: was.hook, points: was.points.map((p) => p.text), close: was.close, captionCta: was.captionCta ?? null }, { kind: "CLIENT", viewer }, { undoOf: { versionNo: before.versionNo } });
}

export type ClientEditInfo = {
  /** This version is their undo (it put the earlier words back). */
  undo: boolean;
  /** The version before it, read-only ("View previous version"). */
  previous: { versionNo: number; hook: string; points: { role: "re-hook" | "build-up" | "payoff" | null; text: string }[]; close: string; captionCta: string | null };
  /** "Undo my edit" is offered: their edit is the version on their page. */
  undoable: boolean;
};

/** For the portal: each shown version that is the client's own edit (or its undo), with the words before it. */
export async function clientEditInfo(rows: { id: string; scriptId: string; validationJson: string | null; changeSummary: string | null; basedOnVersionId: string | null; shared: boolean }[]): Promise<Map<string, ClientEditInfo>> {
  const out = new Map<string, ClientEditInfo>();
  const marked = rows.map((r) => ({ r, m: clientEditMarkOf(r) })).filter((x): x is { r: (typeof rows)[number]; m: ClientEditMark } => !!x.m);
  if (!marked.length) return out;
  const prev = await prisma.contentScriptVersion.findMany({ where: { id: { in: marked.map((x) => x.m.from) } } });
  const { partsFromVersionRow } = await import("@/lib/contentScripts");
  for (const { r, m } of marked) {
    const p = prev.find((x) => x.id === m.from && x.scriptId === r.scriptId);
    if (!p) continue;
    const parts = partsFromVersionRow(p);
    out.set(r.id, {
      undo: !!m.undo,
      previous: { versionNo: p.versionNo, hook: parts.hook, points: parts.points.map((x) => ({ role: (x.role as ClientEditInfo["previous"]["points"][number]["role"]) ?? null, text: x.text })), close: parts.close, captionCta: parts.captionCta ?? null },
      undoable: !m.undo && r.shared,
    });
  }
  return out;
}

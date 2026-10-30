import "server-only";
import { prisma } from "@/lib/prisma";
import { TASK_DONE_INCLUDING_LEGACY } from "@/lib/programDeskTasks";
import { isShootDetailChange } from "@/lib/brandProfile";
import { TEAM_MEMBER_EDITOR_KEYS, editorMeta } from "@/lib/editors";
import type { EvidenceVerdict } from "@/lib/taskEvidence";

// ---------------------------------------------------------------------------
// A BRAND-UPDATE CARD CLOSES WHEN THE EDITOR HAS WORKED FROM IT (Oct 29 2026,
// James's call: his desk showed 15 urgent tasks, 10 of them "Confirm Kim has
// <client>'s brand update", some two weeks old and long since edited from).
//
// The card (brandProfile.ensureAckTask) only ever closed on the editor's
// "Got it" on the brief. Nobody had ever pressed it: 80 editor receipts on
// Oct 29, none acknowledged, and not one card had ever closed. The creative
// manager's desk hides Done on these cards, so James could not clear them
// either. The update itself was never lost: it sits on the brief's banner and
// in its brand section for every editor until they answer.
//
// So the hourly evidence pass (taskEvidence.sweepTaskEvidence) reads the
// record, and a card closes when, for the changes still waiting on it:
//   · NOTHING LEFT FOR AN EDITOR: every one is a shoot detail (filming
//     location, days, wardrobe, teleprompter: never an editor's, see
//     brandProfile.SHOOT_DETAIL_FIELD_PREFIX) or already acknowledged; or
//   · AN EDITOR HAS WORKED FROM THE BRIEF SINCE THE LAST ONE: on one of this
//     client's jobs, after the newest change, a desk editor (Kim, Jhon Mark)
//     sent a version, pressed Start or Resume themselves, or accepted the
//     brief. The banner is at the top of that brief until they answer it, so
//     the work was done with the update in front of them.
// It never guesses: a card a person assigned, delegated or flagged is left for
// them, and a change newer than the last piece of work keeps the card open.
// The editor's own receipt is never written here (closing the card is not the
// editor saying "Got it"): the banner stays on their brief until they do.
// ---------------------------------------------------------------------------

export const BRAND_ACK_PREFIX = "brand-ack:";
const OPEN = { notIn: TASK_DONE_INCLUDING_LEGACY };
const NOT_A_CUT = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];

const etWhen = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "their job";
const nameOf = (key: string) => editorMeta(key)?.name ?? key;

export type BrandCardChange = { label: string; fieldKey: string; createdAt: Date; acked: boolean };
export type EditorWork = { editorKey: string; at: Date; what: "sent" | "start" | "brief"; street: string; round?: number | null };

/** The decision for one card. Pure. */
export function brandAckDecision(input: {
  client: string;
  changes: BrandCardChange[];
  work: EditorWork[];
  held: string | null;
}): { evidence: string | null; kept?: string; at: Date | null } {
  if (input.held) return { evidence: null, kept: input.held, at: null };
  if (!input.changes.length) return { evidence: null, kept: "no change is filed on it", at: null };
  const waiting = input.changes.filter((c) => !c.acked && !isShootDetailChange(c.fieldKey));
  if (!waiting.length) {
    const shoot = [...new Set(input.changes.filter((c) => isShootDetailChange(c.fieldKey)).map((c) => c.label))];
    return {
      evidence: shoot.length
        ? `nothing on it is for the editor: ${shoot.join(", ")} ${shoot.length === 1 ? "is a shoot detail" : "are shoot details"}, which the shoot brief carries${input.changes.some((c) => c.acked && !isShootDetailChange(c.fieldKey)) ? ", and the rest is acknowledged" : ""}`
        : "every change on it is acknowledged on the brief",
      at: null,
    };
  }
  const newest = waiting.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), waiting[0].createdAt);
  const after = input.work.filter((w) => w.at > newest).sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = after[0];
  if (!first) return { evidence: null, kept: `no editor has worked on ${input.client}'s jobs since the last change (${etWhen(newest)})`, at: null };
  const did =
    first.what === "sent" ? `sent ${first.round ? `version ${first.round} of ` : "a version of "}${first.street}`
    : first.what === "start" ? `pressed Start on ${first.street}`
    : `accepted the brief for ${first.street}`;
  return {
    evidence: `${nameOf(first.editorKey)} has worked from ${input.client}'s brief since the last change (${did} on ${etWhen(first.at)}), with the update on that brief`,
    at: first.at,
  };
}

/** Verdicts for the open brand-update cards (all, or `taskIds`). Pure read. */
export async function brandAckVerdicts(opts: { taskIds?: string[] } = {}): Promise<EvidenceVerdict[]> {
  const cards = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: BRAND_ACK_PREFIX }, status: OPEN, ...(opts.taskIds ? { id: { in: opts.taskIds } } : {}) },
    select: { id: true, title: true, clientId: true, assignedManually: true, delegatedAt: true, flaggedAt: true, client: { select: { name: true } } },
  });
  const out: EvidenceVerdict[] = [];
  for (const card of cards) {
    const held = card.assignedManually ? "a person put it on someone by hand" : card.delegatedAt ? "it was delegated" : card.flaggedAt ? "a person flagged it" : !card.clientId ? "it has no client" : null;
    const changes = held ? [] : await prisma.clientBrandChange.findMany({ where: { taskId: card.id }, select: { label: true, fieldKey: true, createdAt: true, ackAt: true } });
    let work: EditorWork[] = [];
    const waiting = changes.filter((c) => !c.ackAt && !isShootDetailChange(c.fieldKey));
    if (!held && waiting.length && card.clientId) {
      const since = waiting.reduce((a, c) => (c.createdAt < a ? c.createdAt : a), waiting[0].createdAt);
      const jobs = await prisma.project.findMany({ where: { clientId: card.clientId }, select: { id: true, title: true } });
      const street = new Map(jobs.map((j) => [j.id, streetOf(j.title)]));
      const ids = jobs.map((j) => j.id);
      const keys = TEAM_MEMBER_EDITOR_KEYS as readonly string[];
      if (ids.length) {
        const [sent, started, briefs] = await Promise.all([
          prisma.reviewSubmission.findMany({ where: { projectId: { in: ids }, createdAt: { gt: since }, submittedByKey: { in: [...keys] }, status: { notIn: NOT_A_CUT } }, select: { projectId: true, createdAt: true, submittedByKey: true, round: true } }),
          prisma.editorWorkEvent.findMany({ where: { projectId: { in: ids }, at: { gt: since }, editorKey: { in: [...keys] }, kind: { in: ["START", "RESUME"] }, actorRole: "EDITOR", onBehalf: false }, select: { projectId: true, at: true, editorKey: true } }),
          prisma.editorBriefReceipt.findMany({ where: { projectId: { in: ids }, acceptedAt: { gt: since }, editorKey: { in: [...keys] } }, select: { projectId: true, acceptedAt: true, editorKey: true } }),
        ]);
        work = [
          ...sent.map((s) => ({ editorKey: s.submittedByKey!, at: s.createdAt, what: "sent" as const, street: street.get(s.projectId) ?? "their job", round: s.round })),
          ...started.map((s) => ({ editorKey: s.editorKey, at: s.at, what: "start" as const, street: street.get(s.projectId) ?? "their job" })),
          ...briefs.map((b) => ({ editorKey: b.editorKey, at: b.acceptedAt, what: "brief" as const, street: street.get(b.projectId) ?? "their job" })),
        ];
      }
    }
    const v = brandAckDecision({
      client: card.client?.name ?? "the client",
      changes: changes.map((c) => ({ label: c.label, fieldKey: c.fieldKey, createdAt: c.createdAt, acked: !!c.ackAt })),
      work,
      held,
    });
    out.push({ taskId: card.id, title: card.title, kind: "brand", ...v });
  }
  return out;
}

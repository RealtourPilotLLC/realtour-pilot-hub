import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey } from "@/lib/datetime";
import { createClientIssue } from "@/lib/clientIssues";
import { cancelTask, completeTask, type Actor } from "@/lib/delegation";
import { asksForRetake, closeKeyFor, isRoundCause, roundCauseLabel, type SignalClosure, type SignalOutcome } from "@/lib/issueSignalsCore";

// ---------------------------------------------------------------------------
// CLOSING A CLIENT ISSUE SIGNAL, SERVER HALF (Oct 24 2026). The rules and the
// words are in issueSignalsCore.ts; this records a person's close.
//
//   revisions:<projectId>  HAPPY (with why it took this many rounds) or
//                          COMPLAINT (what's still wrong: opens a ClientIssue,
//                          whose own lifecycle takes over). Covers every round
//                          up to the latest; a later ask brings the row back.
//   cancel:<activityId>    DONE with what was decided
//   refund:<stripeTxId>    DONE with why it went out
//   pattern:<client name>  DONE with the cause; comes back if the count grows
//
// The check-in someone was assigned from the row is completed (or cancelled,
// when a complaint takes over) so nobody is left chasing a closed question.
// The evidence is re-read here, never taken from the screen. Nothing here
// messages a client.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string; clientId?: string | null };
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const street = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "the job";
const DAY = 86_400_000;

export async function closeIssueSignal(
  input: { rowId: string; outcome: SignalOutcome; cause?: string | null; note?: string | null },
  by: { name: string | null; email: string | null; actor: Actor | null },
  now: Date = new Date(),
): Promise<Result> {
  const rowId = clip(input.rowId, 180);
  const at = rowId.indexOf(":");
  const kind = at > 0 ? rowId.slice(0, at) : "";
  const ref = at > 0 ? rowId.slice(at + 1) : "";
  const note = clip(input.note, 1000) || null;
  if (!ref) return { ok: false, message: "That row can't be closed here." };

  let closure: SignalClosure;
  let projectId: string | null = null;
  let clientId: string | null = null;
  let words: string;

  if (kind === "revisions") {
    const p = await prisma.project.findUnique({ where: { id: ref }, select: { id: true, title: true, clientId: true } });
    if (!p) return { ok: false, message: "That job no longer exists." };
    const asks = await prisma.revisionBrief.findMany({
      where: { projectId: p.id, createdAt: { gte: new Date(now.getTime() - 30 * DAY) }, OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }] },
      select: { createdAt: true, originalText: true },
    });
    if (!asks.length) return { ok: false, message: "There are no client asks on this job in the last 30 days to close." };
    const n = new Set(asks.map((a) => etDayKey(a.createdAt))).size;
    // A lone retake ask (Oct 29 2026) reads as the retake, not "1 rounds".
    const lone = n === 1 ? (asks.some((a) => asksForRetake(a.originalText)) ? "retake" : "fix") : null;
    const latest = asks.reduce((m, a) => (a.createdAt > m ? a.createdAt : m), asks[0].createdAt);
    projectId = p.id;
    clientId = p.clientId;
    let complaintId: string | null = null;
    if (input.outcome === "HAPPY") {
      if (!isRoundCause(input.cause)) return { ok: false, message: lone ? `Pick why it needed ${lone === "retake" ? "a retake" : "the fix"}.` : `Pick why it took ${n} rounds.` };
      words = `client is happy. Why ${lone ? `a ${lone}` : `${n} rounds`}: ${roundCauseLabel(input.cause)}${note ? `. ${note}` : ""}`;
    } else if (input.outcome === "COMPLAINT") {
      if (!note || note.length < 3) return { ok: false, message: "Say what is still wrong for them." };
      const made = await createClientIssue({
        clientId: p.clientId, title: `Still unhappy after ${lone ? `the ${lone}` : `${n} revision rounds`}: ${street(p.title)}`, whatHappened: note,
        source: "staff", projectIds: [p.id], cause: isRoundCause(input.cause) ? input.cause : null, createdBy: by.name,
      });
      if (!made.ok || !made.id) return { ok: false, message: made.message };
      complaintId = made.id;
      words = `still unhappy, so a complaint was opened: ${note}`;
    } else {
      return { ok: false, message: "Say whether the client is happy." };
    }
    closure = { v: 1, at: now.toISOString(), by: by.name, outcome: input.outcome, cause: isRoundCause(input.cause) ? input.cause : null, note, upToISO: latest.toISOString(), upToCount: null, complaintId };
    await settleCheckIn(`deleg:/projects/${p.id}#revisions`, by.actor, input.outcome === "HAPPY" ? `Closed from the dashboard: ${words}` : "A complaint was opened instead; it has its own owner and check-in.", input.outcome, now);
    words = `${lone === "retake" ? "Retake request" : n === 1 ? "Revision request" : `${n} revision rounds`} closed by ${by.name ?? "the office"}: ${words}`;
  } else {
    if (!note || note.length < 3) return { ok: false, message: "Say in a line what was decided." };
    let upToISO: string | null = null;
    let upToCount: number | null = null;
    if (kind === "cancel") {
      const a = await prisma.activity.findUnique({ where: { id: ref }, select: { createdAt: true, projectId: true, project: { select: { clientId: true } } } });
      if (!a) return { ok: false, message: "That cancellation is no longer on record." };
      upToISO = a.createdAt.toISOString();
      projectId = a.projectId;
      clientId = a.project?.clientId ?? null;
      words = `Cancellation after delivery closed by ${by.name ?? "the office"}: ${note}`;
    } else if (kind === "refund") {
      const t = await prisma.stripeTransaction.findUnique({ where: { id: ref }, select: { createdAt: true, projectId: true } });
      if (!t) return { ok: false, message: "That refund is no longer on record." };
      upToISO = t.createdAt.toISOString();
      projectId = t.projectId;
      words = `Refund reason recorded by ${by.name ?? "the office"}: ${note}`;
    } else if (kind === "pattern") {
      const { ownerShootIssues } = await import("@/lib/shootIssues");
      const flags = await ownerShootIssues(now);
      const b = flags.byClient.find((x) => x.client === ref);
      if (!b) return { ok: false, message: "Those shoot issues are no longer on the list." };
      upToCount = b.count;
      words = `Shoot issues on ${ref} closed by ${by.name ?? "the office"}: ${note}`;
    } else {
      return { ok: false, message: "That row can't be closed here." };
    }
    closure = { v: 1, at: now.toISOString(), by: by.name, outcome: "DONE", cause: null, note, upToISO, upToCount };
  }

  const key = closeKeyFor(rowId);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(closure), updatedBy: by.email }, update: { value: JSON.stringify(closure), updatedBy: by.email } });
  if (projectId) await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: words.slice(0, 500) } }).catch(() => {});
  return { ok: true, message: input.outcome === "COMPLAINT" ? "Closed. A complaint was opened; it's on the card now with its own next step." : "Closed. It comes back on its own if there's anything new.", clientId };
}

/** The check-in assigned from the row: done when the client is happy, cancelled when a complaint takes over. */
async function settleCheckIn(dedupeKey: string, actor: Actor | null, words: string, outcome: SignalOutcome, now: Date): Promise<void> {
  if (!actor) return;
  const t = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true, delegatedAt: true } }).catch(() => null);
  if (!t || !t.delegatedAt || ["COMPLETED", "CANCELLED"].includes(t.status)) return;
  const r = outcome === "HAPPY" ? await completeTask(actor, t.id, words, { now }) : await cancelTask(actor, t.id, words, { now });
  if (!r.ok) console.warn("[issue signals] couldn't settle the check-in", t.id, r.message);
}

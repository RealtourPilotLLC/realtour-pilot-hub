"use server";

import { requireShootAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import {
  DRAFT_TOPIC_CHECK_FAILED,
  carryTopicAnswer,
  normalizeDraftPayload,
  type DraftPayload,
  type SaveDraftResult as DraftSaveAnswer,
} from "@/lib/uploadDraft";

// ---------------------------------------------------------------------------
// The database half of upload drafts (O04 / A30, Sep 25 2026) — see
// lib/uploadDraft.ts for what a draft is and is not.
//
// WHAT THESE TWO ACTIONS MAY TOUCH: the UploadDraft row keyed by (job, the
// signed-in person) and nothing else. No Project column, no Activity, no
// task, no notification, no filming report — so an autosave can never count
// as a submit, finalize the job, move it on, satisfy the pay gate or tell an
// editor anything. The upload-drafts drill asserts exactly that.
//
// CONFLICTS are a compare-and-swap on `revision`: a save carries the revision
// it last saw, and only lands if that is still the row's. Two tabs, or a phone
// and a laptop, each learn about the other instead of the later one silently
// winning; the page then asks the person which copy to keep.
// ---------------------------------------------------------------------------

// The answer's shape lives in lib/uploadDraft (a "use server" file may export
// only async functions, and the page's settleDraftSave reads the same type):
// saved, a conflict, or a message — `retryable` when nothing is wrong with the
// answers and the same save will land once the server can check them (R02).
export type SaveDraftResult = DraftSaveAnswer;

async function draftAuthor(): Promise<{ key: string; name: string } | { error: string }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (!me?.email) return { error: "Sign in to save a draft — your answers are kept on this device meanwhile." };
  // "View as" is read-only everywhere: an owner previewing a photographer's
  // page must not write that photographer's draft (same rule as
  // acknowledgeUploadProcess).
  if (me.impersonating) return { error: "You're previewing another user — drafts are not saved in a preview." };
  return { key: me.email.trim().toLowerCase(), name: (me.name?.trim() || me.email).slice(0, 80) };
}

type TopicGate = { ok: true; payload: DraftPayload } | { ok: false; error: string };

/**
 * Topic ids the draft may hold: the session's own topics, nothing invented.
 *
 * R02 (external review, Sep 28 2026): this read `topicsForSession(...)
 * .catch(() => null)`, so a topic list that FAILED to load looked exactly like
 * a job with no list — every tick and every topic note was filtered out, the
 * stripped draft was stored as a new revision, and the page heard "saved" and
 * deleted the device copy that still held them. Now a failed read is its own
 * answer and the caller writes NOTHING; only a read that succeeded may drop an
 * id (a listing shoot, a topic the office took off the month, an invented id).
 */
async function keepSessionTopics(projectId: string, p: DraftPayload): Promise<TopicGate> {
  // Nothing to check → no read, so an outage never blocks a draft with no topics in it.
  if (p.filmedTopicIds.length === 0 && Object.keys(p.topicNotes).length === 0) return { ok: true, payload: p };
  const { readSessionTopics } = await import("@/lib/filmedTopics");
  const read = await readSessionTopics(projectId);
  if (!read.ok) return { ok: false, error: read.error };
  const known = new Set((read.session?.topics ?? []).map((t) => t.topicId));
  return {
    ok: true,
    payload: {
      ...p,
      filmedTopicIds: p.filmedTopicIds.filter((id) => known.has(id)),
      topicNotes: Object.fromEntries(Object.entries(p.topicNotes).filter(([id]) => known.has(id))),
    },
  };
}

function conflictFrom(row: { revision: number; payloadJson: string; savedAt: Date; authorName: string | null; consumedAt: Date | null }): SaveDraftResult {
  let payload: DraftPayload;
  try {
    payload = normalizeDraftPayload(JSON.parse(row.payloadJson));
  } catch {
    payload = normalizeDraftPayload({});
  }
  return {
    ok: false,
    conflict: { revision: row.revision, payload, savedAtISO: row.savedAt.toISOString(), by: row.authorName, submitted: !!row.consumedAt },
  };
}

/**
 * Save the signed-in person's unsent answers for this job.
 * `revision` = the revision this page last saw (null = it has none).
 * `baseHash` = the submitted-fields fingerprint the page loaded with, kept on
 * the row so a restored draft can tell whether the job moved underneath it.
 */
export async function saveUploadDraft(
  projectId: string,
  input: { revision: number | null; baseHash?: string | null; payload: unknown },
): Promise<SaveDraftResult> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const who = await draftAuthor();
  if ("error" in who) return { ok: false, message: who.error };

  // After the access check and the author (a refusal still comes first),
  // before any write. ALL OR NOTHING: when the topic list could not be read the
  // row is left exactly as it is — revision, answers, savedAt, baseHash,
  // consumedAt — so the page's retry carries the same revision and the CAS
  // below still holds. Saving "everything but the topics" was rejected: it
  // would move the revision on while the newest ticks were unsaved, and the
  // page would say "saved" when they were not.
  const gate = await keepSessionTopics(projectId, normalizeDraftPayload(input.payload));
  if (!gate.ok) {
    console.warn(`[upload-draft] topic list unreadable for ${projectId}; draft not written: ${gate.error}`);
    return { ok: false, retryable: true, message: DRAFT_TOPIC_CHECK_FAILED };
  }
  let payload = gate.payload;
  const where = { projectId, authorKey: who.key };
  const onRevision = typeof input.revision === "number" && Number.isInteger(input.revision) && input.revision > 0;
  // R02 follow-up (Sep 28 2026): a page that could not read the topic list and
  // had no draft answer sends NO topic answer (topicsUnknown). It must not
  // replace the one the draft already holds — typically a report's ticks and
  // extras, restored by another tab — with its empty placeholders. The answer
  // is carried from the very row this save replaces: read at the revision the
  // page saw, and the compare-and-swap below only lands on that same revision,
  // so a row that moved in between is a conflict, never a mix. The read is not
  // caught: if it fails the action fails, the page keeps its device copy and
  // retries (a "no answer" write over an unread row is the loss this prevents).
  if (payload.topicsUnknown && onRevision) {
    const cur = await prisma.uploadDraft.findUnique({
      where: { projectId_authorKey: where },
      select: { revision: true, payloadJson: true, consumedAt: true },
    });
    if (cur && cur.revision === input.revision && !cur.consumedAt) {
      let stored: DraftPayload | null = null;
      try { stored = normalizeDraftPayload(JSON.parse(cur.payloadJson)); } catch { stored = null; }
      payload = carryTopicAnswer(payload, stored);
    }
  }
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 120_000) return { ok: false, message: "That draft is too large to save." };
  const baseHash = typeof input.baseHash === "string" ? input.baseHash.slice(0, 64) : null;
  const now = new Date();
  const data = { payloadJson, baseHash, authorName: who.name, savedAt: now };

  if (onRevision && typeof input.revision === "number") {
    // The ordinary save: only onto the revision this page last saw, and only
    // while the draft is still open (a submit from another tab consumed it).
    const r = await prisma.uploadDraft.updateMany({
      where: { ...where, revision: input.revision, consumedAt: null },
      data: { ...data, revision: input.revision + 1 },
    });
    if (r.count === 1) return { ok: true, revision: input.revision + 1, savedAtISO: now.toISOString() };
  } else {
    // No revision yet on this page. A draft left CONSUMED by an earlier submit
    // is reused (it was this person's, and it said nothing unsent) … A page
    // with no topic answer stores it as that (topicsUnknown): the consumed
    // draft's answer went in with the submit, and the job's report holds it.
    const reused = await prisma.uploadDraft.updateMany({
      where: { ...where, consumedAt: { not: null } },
      data: { ...data, consumedAt: null, revision: { increment: 1 } },
    });
    if (reused.count === 1) {
      const row = await prisma.uploadDraft.findUnique({ where: { projectId_authorKey: where }, select: { revision: true } });
      return { ok: true, revision: row?.revision ?? 1, savedAtISO: now.toISOString() };
    }
    // … otherwise a brand-new row. createMany + skipDuplicates: two first
    // saves racing make one row, and the loser hears a conflict, not a P2002.
    const made = await prisma.uploadDraft.createMany({
      data: [{ ...where, ...data, revision: 1 }],
      skipDuplicates: true,
    });
    if (made.count === 1) return { ok: true, revision: 1, savedAtISO: now.toISOString() };
  }

  // The swap missed: somebody (this person, elsewhere) saved first.
  const row = await prisma.uploadDraft.findUnique({
    where: { projectId_authorKey: where },
    select: { revision: true, payloadJson: true, savedAt: true, authorName: true, consumedAt: true },
  });
  if (!row) return { ok: false, message: "Unable to save — the draft could not be found. Try again." };
  // Consumed = submitted from another tab while this one was typing. What is
  // typed here is not lost (the page keeps it), but it is no longer a draft of
  // an unsent page — the conflict says so rather than reopening it silently.
  return conflictFrom(row);
}

/** Throw the unsent answers away. Retired, not deleted: the row is marked consumed. */
export async function discardUploadDraft(projectId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const who = await draftAuthor();
  if ("error" in who) return { ok: false, message: who.error };
  await prisma.uploadDraft.updateMany({
    where: { projectId, authorKey: who.key, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return { ok: true };
}

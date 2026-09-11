import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// "Put back to Waiting" — the office's hold on a job the hub thinks is shot.
//
// Jordan, Sep 11: "I should also be able to change projects back to waiting
// but its blocked off." Waiting (BOOKED/SCHEDULED past the shoot) was the one
// rung nobody could type: the raw folder set it, and the hourly recompute
// (projectStatus.syncProjectStatuses) would put a hand-set Waiting straight
// back to Ready for editing within the hour — off the same raws that flipped
// it in the first place. The Sep 8 case: 1946 Rowan St #2 read Ready for
// editing before its shoot because it inherited another job's raws, and the
// office had no way to say "not really".
//
// The hold is an AppSetting marker, `queue-waiting:<projectId>` → { by, at },
// the same shape as handled-by-hand:<taskId> and auto-delivery-<projectId>
// (no schema change). While it stands, both sweeps keep a BOOKED/SCHEDULED
// job where it is, whatever the folder says. Exactly two things release it:
//   · the photographer submitting the upload page — debriefSubmittedAt, the
//     one stamp only finalizeUpload writes (uploadedAt is also written by the
//     two sweeps, so it can't tell a human submit from a folder read);
//   · the office moving the job on from the queue pill (setQueueStatus).
// ---------------------------------------------------------------------------

export const WAITING_HOLD_PREFIX = "queue-waiting:";
export const waitingHoldKey = (projectId: string) => `${WAITING_HOLD_PREFIX}${projectId}`;

export type WaitingHold = { by: string | null; at: Date };

/** Every hold in a batch, one query — the sweeps load it once per pass, the
 *  way manualQueued is. */
export async function loadWaitingHolds(projectIds: string[]): Promise<Map<string, WaitingHold>> {
  const out = new Map<string, WaitingHold>();
  if (projectIds.length === 0) return out;
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: projectIds.map(waitingHoldKey) } },
    select: { key: true, value: true, updatedAt: true },
  });
  for (const r of rows) {
    let by: string | null = null;
    let at: Date = r.updatedAt;
    try {
      const v = JSON.parse(r.value) as { by?: string | null; at?: string };
      by = v.by ?? null;
      const parsed = v.at ? new Date(v.at) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) at = parsed;
    } catch { /* unreadable value → the row's own timestamp stands in */ }
    out.set(r.key.slice(WAITING_HOLD_PREFIX.length), { by, at });
  }
  return out;
}

/** Does the hold still stand? A photographer submit stamped AFTER it releases
 *  it; no submit at all leaves it standing (the stamp is null before the first
 *  upload-page submit, and that is exactly the held case). */
export function holdStands(hold: WaitingHold | null | undefined, debriefSubmittedAt: Date | null | undefined): boolean {
  if (!hold) return false;
  return !debriefSubmittedAt || debriefSubmittedAt.getTime() <= hold.at.getTime();
}

/** The office put the job back: write (or refresh) the marker. Throws on a
 *  failed write — the caller must not land a Waiting nobody is holding. */
export async function stampWaitingHold(projectId: string, by: string | null, email?: string | null): Promise<void> {
  const key = waitingHoldKey(projectId);
  const value = JSON.stringify({ by: by?.trim() || null, at: new Date().toISOString() });
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: email ?? null },
    update: { value, updatedBy: email ?? null },
  });
}

/** Drop the marker. True when one was there — callers log the release only then. */
export async function releaseWaitingHold(projectId: string): Promise<boolean> {
  const r = await prisma.appSetting.deleteMany({ where: { key: waitingHoldKey(projectId) } }).catch(() => ({ count: 0 }));
  return r.count > 0;
}

/** Why this job can't go back to Waiting, in the office's words — or null when
 *  it can: Ready for editing (SHOT) or In editing (EDITING) with nothing handed
 *  in. `cuts` = ReviewSubmission rows that are real cuts (not UPLOADING /
 *  UPLOAD_FAILED / SUPERSEDED — editorQueue's own definition). BOOKED/SCHEDULED
 *  is already Waiting and also returns null; the caller treats it as a no-op. */
export function whyNotWaiting(p: { status: string; street: string; cuts: number }): string | null {
  const { status, street, cuts } = p;
  if (status === "DELIVERED") return `${street} is delivered — it can't go back to Waiting.`;
  if (status === "REVISION") return `${street} has a client revision open — it can't go back to Waiting until the ask is answered.`;
  if (cuts > 0) return `A cut has already been handed in on ${street} — it can't go back to Waiting.`;
  if (status === "REVIEW") return `${street} is waiting on review — it can't go back to Waiting.`;
  if (["SHOT", "EDITING", "BOOKED", "SCHEDULED"].includes(status)) return null;
  return `${street} is ${status.toLowerCase().replace(/_/g, " ")} — only a job on Ready for editing or In editing can go back to Waiting.`;
}

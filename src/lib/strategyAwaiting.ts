// ---------------------------------------------------------------------------
// "A STRATEGY VERSION IS WAITING FOR APPROVAL": ONE RULE (Oct 20 2026, audit D4).
//
// Discovery drafts are saved DRAFT, imports, edits and revisions
// INTERNAL_REVIEW. The Dashboard counted only the first, the Plan badge, the
// Overview and the roster's "Needs my approval" only the second, so each
// screen missed the other half. And an older draft left behind when a newer
// version was approved (a discovery v1 beside an imported, approved v2) kept
// the Dashboard nagging for ever.
//
// Waiting = DRAFT or INTERNAL_REVIEW, and NEWER than the version in force.
// Pure (no database), so the Strategy panel reads the same rule as the counts.
// ---------------------------------------------------------------------------

export const AWAITING_STRATEGY_STATUSES = ["DRAFT", "INTERNAL_REVIEW"] as const;

/** The versionNo in force (0 when nothing is approved). */
export function strategyInForceNo(versions: { versionNo: number; status: string }[]): number {
  return Math.max(0, ...versions.filter((v) => v.status === "APPROVED").map((v) => v.versionNo));
}

/** True when this version waits for an approval: open, and newer than the version in force. */
export function strategyAwaits(v: { versionNo: number; status: string }, inForceNo: number): boolean {
  return (v.status === "DRAFT" || v.status === "INTERNAL_REVIEW") && v.versionNo > inForceNo;
}

/** An open draft OLDER than the version in force: history, never a thing to approve over it. */
export function strategyStaleDraft(v: { versionNo: number; status: string }, inForceNo: number): boolean {
  return (v.status === "DRAFT" || v.status === "INTERNAL_REVIEW") && inForceNo > 0 && v.versionNo < inForceNo;
}

/** Versions waiting for approval, per enrollment, from rows carrying enrollmentId, versionNo and status. */
export function strategyAwaitingByEnrollment(rows: { enrollmentId: string; versionNo: number; status: string }[]): Map<string, number> {
  const byEnrollment = new Map<string, { versionNo: number; status: string }[]>();
  for (const r of rows) {
    const list = byEnrollment.get(r.enrollmentId) ?? [];
    list.push(r);
    byEnrollment.set(r.enrollmentId, list);
  }
  const out = new Map<string, number>();
  for (const [id, list] of byEnrollment) {
    const inForce = strategyInForceNo(list);
    const n = list.filter((v) => strategyAwaits(v, inForce)).length;
    if (n) out.set(id, n);
  }
  return out;
}

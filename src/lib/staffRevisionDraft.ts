/** Browser recovery stores only receipt identity, never client words or files. */
export type StaffRevisionDraft = { version: 1; requestKey: string; submissionId: string };
export const staffRevisionDraftKey = (projectId: string) => `staff-revision-receipt:${projectId}`;
export function parseStaffRevisionDraft(raw: string | null): StaffRevisionDraft | null {
  try {
    const v = JSON.parse(raw ?? "null");
    return v?.version === 1 && typeof v.submissionId === "string" && v.submissionId.length > 0 && /^[a-f\d-]{36}$/i.test(v.requestKey ?? "") ? { version: 1, requestKey: v.requestKey, submissionId: v.submissionId } : null;
  } catch { return null; }
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function keepStaffRevisionDraft(storage: DraftStorage, projectId: string, candidate: StaffRevisionDraft): StaffRevisionDraft {
  const key = staffRevisionDraftKey(projectId);
  const prior = parseStaffRevisionDraft(storage.getItem(key));
  // A stale first submit may have been refused before any server receipt was
  // made. Allow another current target with the SAME request key. If the first
  // receipt arrived late, the server's key lock still preserves its old pin.
  const next = prior ? { ...prior, submissionId: candidate.submissionId || prior.submissionId } : candidate;
  storage.setItem(key, JSON.stringify(next));
  const kept = parseStaffRevisionDraft(storage.getItem(key));
  if (!kept) throw new Error("This browser could not save the retry receipt. Enable browser storage before recording the request.");
  return kept;
}
export function clearStaffRevisionDraft(storage: DraftStorage, projectId: string, requestKey: string) {
  const key = staffRevisionDraftKey(projectId);
  if (parseStaffRevisionDraft(storage.getItem(key))?.requestKey === requestKey) storage.removeItem(key);
}

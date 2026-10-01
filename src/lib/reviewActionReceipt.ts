export async function reviewActionReceipt(action: () => Promise<{ ok: boolean; message?: string }>): Promise<{ ok: boolean; message?: string; needsReload: boolean }> {
  try { return { ...await action(), needsReload: false }; }
  catch { return { ok: false, needsReload: true, message: "The action could not be confirmed. Your notes are still here. Reload this cut to check what was recorded before trying again." }; }
}

export type UnknownReviewRead = { stamp: string | undefined; requested: boolean };
export function reviewRetryBlocked(unknown: UnknownReviewRead | null, readStamp: string | undefined): boolean {
  return !!unknown && (!unknown.requested || unknown.stamp === readStamp);
}

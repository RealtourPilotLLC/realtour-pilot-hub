import "server-only";

// ---------------------------------------------------------------------------
// Single chokepoint for owner-only surfaces (e.g. the Ask the Hub chat history,
// which can contain owner-tier knowledge and private DMs). Until per-user
// accounts exist, the deployed hub is operated by Jordan (the owner), so this
// returns true. When real auth lands, implement the check HERE and every
// owner-only page is covered at once.
// ---------------------------------------------------------------------------
export async function isOwnerView(): Promise<boolean> {
  return true;
}

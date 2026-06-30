import "server-only";

// ---------------------------------------------------------------------------
// Single chokepoint for owner-only surfaces (e.g. the Ask the Hub chat history,
// which can contain owner-tier knowledge and private DMs). Once auth enforcement
// is on, this is the REAL signed-in owner. In open / pre-cutover mode (no
// enforcement, no session) the hub is operated solely by Jordan, so it stays open.
// ---------------------------------------------------------------------------
export async function isOwnerView(): Promise<boolean> {
  if (process.env.AUTH_ENFORCE !== "true") return true; // open / pre-cutover mode
  const { getCurrentUser } = await import("./auth/user");
  const u = await getCurrentUser();
  return !!u && u.realRole === "OWNER";
}

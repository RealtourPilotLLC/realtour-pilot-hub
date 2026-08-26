import "server-only";

// ---------------------------------------------------------------------------
// Single chokepoint for owner-only surfaces (e.g. the Ask the Hub chat history,
// which can contain owner-tier knowledge and private DMs). Once auth enforcement
// is on, this is the REAL signed-in owner. In open / pre-cutover mode (no
// enforcement, no session) the hub is operated solely by Jordan, so it stays open.
// ---------------------------------------------------------------------------
export async function isOwnerView(): Promise<boolean> {
  // Same fail-CLOSED rule as the middleware (audit crack #26): in production /
  // on Vercel the gate is ALWAYS on — losing the AUTH_ENFORCE env var must
  // never silently open the owner's chat history to every signed-in user.
  const enforced =
    process.env.AUTH_ENFORCE === "true" ||
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.VERCEL);
  if (!enforced) return true; // open local dev only
  const { getCurrentUser } = await import("./auth/user");
  const u = await getCurrentUser();
  return !!u && u.realRole === "OWNER";
}

// FAIL CLOSED IN PROD: enforcement is ALWAYS on when running in production or
// on Vercel, regardless of AUTH_ENFORCE — losing/typo-ing the env var on a
// redeploy or an unscoped preview deployment must never turn every permission
// check into a no-op against the shared prod database (audit crack #26). The
// AUTH_ENFORCE flag remains only as a way to turn enforcement ON locally.
// (Its own file since Oct 19 2026, so a lib can ask without loading guards.)
export const authEnforcedNow = (): boolean =>
  process.env.AUTH_ENFORCE === "true" ||
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.VERCEL);

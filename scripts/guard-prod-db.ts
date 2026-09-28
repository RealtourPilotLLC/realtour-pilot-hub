// Refuses to proceed when DATABASE_URL points at a hosted (production)
// database — ran ahead of `prisma db push --force-reset` in `npm run db:reset`
// so the schema of the LIVE Neon database can never be wiped by a routine
// command (audit Aug 25: .env points straight at production). tsx does NOT
// autoload .env (Prisma does), so the URL is read from the file directly.
//
// Sep 28 2026 (A02-restore-guard): the rule now lives in scripts/_lib/dbGuard.ts
// so the restore script refuses by the same test. It is also stricter: any
// host that is not this machine counts as hosted, not only the three provider
// names this file used to match.
import { hostOf, isHostedUrl, readDatabaseUrl } from "./_lib/dbGuard";

const dbUrl = readDatabaseUrl();
if (isHostedUrl(dbUrl) && process.env.I_UNDERSTAND_THIS_WIPES_PROD !== "yes") {
  console.error(`REFUSING TO RUN: DATABASE_URL points at a hosted (production) database${hostOf(dbUrl) ? ` (${hostOf(dbUrl)})` : ""} — db:reset would WIPE it.`);
  console.error("If you truly mean it, run with I_UNDERSTAND_THIS_WIPES_PROD=yes.");
  process.exit(1);
}

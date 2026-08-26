// Refuses to proceed when DATABASE_URL points at a hosted (production)
// database — ran ahead of `prisma db push --force-reset` in `npm run db:reset`
// so the schema of the LIVE Neon database can never be wiped by a routine
// command (audit Aug 25: .env points straight at production). tsx does NOT
// autoload .env (Prisma does), so read the file directly.
import { readFileSync } from "fs";

let dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl) {
  try { dbUrl = /^DATABASE_URL\s*=\s*"?([^"\n]+)/m.exec(readFileSync(".env", "utf8"))?.[1] ?? ""; } catch { /* no .env */ }
}
if (/neon\.tech|vercel|amazonaws/i.test(dbUrl) && process.env.I_UNDERSTAND_THIS_WIPES_PROD !== "yes") {
  console.error("REFUSING TO RUN: DATABASE_URL points at a hosted (production) database — db:reset would WIPE it.");
  console.error("If you truly mean it, run with I_UNDERSTAND_THIS_WIPES_PROD=yes.");
  process.exit(1);
}

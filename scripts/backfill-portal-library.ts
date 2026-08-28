/**
 * Backfill the client portal for EVERY enrollment (Jordan, Aug 28):
 *   1. Mint a portal token for each ACTIVE enrollment that lacks one
 *      (identical to the owner's "Client portal link" button — inert until
 *      the link is shared).
 *   2. Materialize the full video library from Aryeo for every enrollment
 *      (ACTIVE + PAUSED — history stays browsable if someone reactivates).
 *
 *   npx tsx scripts/backfill-portal-library.ts          # dry run
 *   npx tsx scripts/backfill-portal-library.ts --write
 */
import { randomBytes } from "crypto";
import { prisma } from "../src/lib/prisma";
import { syncEnrollmentLibrary } from "../src/lib/portalLibrary";

const WRITE = process.argv.includes("--write");

async function main() {
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, clientId: true, status: true, portalToken: true },
  });
  console.log(`${enrollments.length} enrollment(s)\n`);
  for (const e of enrollments) {
    const client = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
    let tokenNote = e.portalToken ? "token exists" : e.status === "ACTIVE" ? "MINT token" : "paused — no token";
    if (WRITE && !e.portalToken && e.status === "ACTIVE") {
      await prisma.contentEnrollment.update({
        where: { id: e.id },
        data: { portalToken: randomBytes(24).toString("base64url") },
      });
      tokenNote = "token minted";
    }
    if (!WRITE) {
      console.log(`DRY   ${client?.name} (${e.status}) — ${tokenNote}`);
      continue;
    }
    const r = await syncEnrollmentLibrary(e.id).catch((err) => {
      console.log(`  !! sync failed: ${(err as Error).message.slice(0, 120)}`);
      return { videos: 0, listings: 0 };
    });
    console.log(`WRITE ${client?.name} (${e.status}) — ${tokenNote} · ${r.listings} listing(s) → ${r.videos} video(s)`);
  }
  const total = await prisma.portalVideo.count();
  console.log(`\nLibrary total: ${total} video row(s)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

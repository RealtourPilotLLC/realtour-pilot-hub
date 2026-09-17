// ---------------------------------------------------------------------------
// Create (or top up) a SYNTHETIC content-program client for testing the
// portal's identity layer in production, where the only database is.
//
//   npx tsx scripts/create-test-client.ts                      → "Cara TEST"
//   npx tsx scripts/create-test-client.ts "Dave TEST" dave     → another one
//
// REFUSES any name without the word TEST (src/lib/testClients.ts) and any
// sign-in address outside the staff-controlled @realtourpilot.com domain.
// Idempotent: run it twice and nothing duplicates. Never deletes, never
// touches a non-test row. Prisma self-loads .env, so DATABASE_URL is the live
// Neon — that is the point, and the guards above are the safety.
//
// What it makes:
//   Client "<name>"            email info+<slug>@realtourpilot.com
//   ContentEnrollment          ACTIVE · Starter · 2 videos / 1 session / 2h · manual
//   ContentMonth 2026-09       OPEN
//   portalToken                issued (so the link path is testable)
//   ClientUser + Membership    OWNER seat for the same address
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { assertTestClient, isStaffControlledEmail } from "../src/lib/testClients";

const prisma = new PrismaClient();
const NAME = process.argv[2] ?? "Cara TEST";
const SLUG = (process.argv[3] ?? NAME.split(/\s+/)[0]).toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL = `info+${SLUG}test@realtourpilot.com`;
const MONTH_KEY = process.argv[4] ?? "2026-09";

async function main() {
  assertTestClient({ name: NAME });
  if (!isStaffControlledEmail(EMAIL)) throw new Error(`Refusing: ${EMAIL} is not a staff-controlled address.`);

  let client = await prisma.client.findFirst({ where: { name: NAME }, select: { id: true, name: true } });
  if (!client) {
    client = await prisma.client.create({ data: { name: NAME, email: EMAIL, generalNotes: "SYNTHETIC test client for the portal build (Sep 16 2026). Not a real person." }, select: { id: true, name: true } });
    console.log(`Client created      ${client.id}  ${NAME}`);
  } else console.log(`Client exists       ${client.id}  ${NAME}`);
  assertTestClient(client);

  let e = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
  if (!e) {
    e = await prisma.contentEnrollment.create({
      data: {
        clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2,
        status: "ACTIVE", statusManual: true, packageSource: "manual", startedAt: new Date(),
        notes: "SYNTHETIC — portal identity-layer testing.",
      },
    });
    console.log(`Enrollment created  ${e.id}`);
  } else console.log(`Enrollment exists   ${e.id}  ${e.status}`);

  if (!e.portalToken) {
    e = await prisma.contentEnrollment.update({ where: { id: e.id }, data: { portalToken: randomBytes(24).toString("base64url"), portalTokenIssuedAt: new Date() } });
    console.log("Portal link issued");
  }

  const month = await prisma.contentMonth.upsert({
    where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: MONTH_KEY } },
    create: { enrollmentId: e.id, clientId: client.id, monthKey: MONTH_KEY, videosOwed: e.videosPerMonth, status: "OPEN" },
    update: {},
  });
  console.log(`Month               ${month.id}  ${MONTH_KEY}`);

  const user = await prisma.clientUser.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, name: NAME },
    update: {},
  });
  const seat = await prisma.clientMembership.upsert({
    where: { clientUserId_enrollmentId: { clientUserId: user.id, enrollmentId: e.id } },
    create: { clientUserId: user.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", invitedByAppUserId: null },
    update: { revokedAt: null, revokedBy: null, role: "OWNER" },
  });
  console.log(`ClientUser          ${user.id}  ${EMAIL}`);
  console.log(`Membership          ${seat.id}  OWNER`);
  console.log(`\nPortal link: /portal/${e.portalToken}`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

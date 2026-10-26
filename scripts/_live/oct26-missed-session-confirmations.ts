// ---------------------------------------------------------------------------
// Oct 26 2026: the filming session confirmations the hub never sent, because
// the hub books Aryeo with the customer notice off and had no email of its own
// until today (lib/sessionConfirmation). Two portal bookings since Oct 24:
//   · Mike Ciunci   Thu Nov 12, 10:00 AM, 1033 Preserve Ln (booked Oct 26 9:10 AM)
//   · Janice Pigga  Mon Nov 2, 1:00 PM (booked Oct 24)
// CLIENT EMAILS: dry run by default (read-only, proven; shows who would get
// what); `--apply` sends, only on Jordan's go. Idempotent: the outbox key is
// the session's own, so the cron or a second run never sends it twice.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const REQUESTS = [
  "cmvp9xthd0000l007c0x471m2", // Mike Ciunci, Thu Nov 12 10:00 AM
  "cmvmd9v9v0003l908ukzvkz4t", // Janice Pigga, Mon Nov 2 1:00 PM
];
const SINCE = new Date("2026-10-24T00:00:00Z");

async function main() {
  const prisma = await db();
  const ids = REQUESTS;
  const { sendSessionConfirmation, composeSessionConfirmation } = await import("@/lib/sessionConfirmation");
  for (const id of ids) {
    const r = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id } });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: r.clientId }, select: { name: true } });
    const preview = await sendSessionConfirmation(id, { dryRun: true, since: SINCE });
    console.log(`\n=== ${client.name} · ${r.slotStart?.toISOString()} · ${r.locationText} · ${r.creativeName}`);
    console.log("would go to:", JSON.stringify(preview));
    if (!APPLY) {
      console.log(composeSessionConfirmation({ name: client.name, start: r.slotStart!, end: r.slotEnd, tz: "America/New_York", location: r.locationText, creativeName: r.creativeName, moved: false }));
      continue;
    }
    console.log("SENT:", JSON.stringify(await sendSessionConfirmation(id, { since: SINCE })));
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => (await db()).$disconnect().catch(() => {}));

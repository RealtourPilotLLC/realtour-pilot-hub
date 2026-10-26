// Oct 26 2026: dry runs (read-only, proven) of the session confirmation sweep
// and the unsent-notes sweep, plus Mike Ciunci's confirmation email as it would read.
import { writeFileSync } from "node:fs";
import { db } from "./_oct22-guard";
async function main() {
  const prisma = await db();
  const { sweepUnsentClientNotes } = await import("@/lib/unsentNotes");
  console.log("UNSENT NOTES", JSON.stringify(await sweepUnsentClientNotes({ dryRun: true }), null, 1));
  const { sweepSessionConfirmations, sendSessionConfirmation, composeSessionConfirmation } = await import("@/lib/sessionConfirmation");
  console.log("CONFIRMATIONS (from deploy)", JSON.stringify(await sweepSessionConfirmations({ dryRun: true })));
  for (const id of ["cmvp9xthd0000l007c0x471m2"]) console.log("MIKE (since Oct 24)", JSON.stringify(await sendSessionConfirmation(id, { dryRun: true, since: new Date("2026-10-24T00:00:00Z") })));
  const r = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: "cmvp9xthd0000l007c0x471m2" } });
  const { sessionConfirmationSubject, sessionConfirmationKey } = await import("@/lib/sessionConfirmationKey");
  const key = sessionConfirmationKey(r.id, r.slotStart!, "x");
  console.log("\nSUBJECT:", sessionConfirmationSubject(key), "\n");
  const body = composeSessionConfirmation({ name: "Mike Ciunci", start: r.slotStart!, end: r.slotEnd, tz: "America/New_York", location: r.locationText, creativeName: r.creativeName, moved: false });
  console.log(body);
  const { renderBrandedEmail } = await import("@/lib/emailHtml");
  const html = renderBrandedEmail({ subject: sessionConfirmationSubject(key), text: body });
  if (process.env.OUT_HTML) writeFileSync(process.env.OUT_HTML, html);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => (await db()).$disconnect().catch(() => {}));

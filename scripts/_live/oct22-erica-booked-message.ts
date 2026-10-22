// LIVE ONE-OFF (Oct 22 2026). Jordan: "send her a message in the hub that we were
// able to schedule her for 8:30am on Thursday, and if she needs another time to
// let us know!" Posted to Erica Walker's program conversation as Jordan through
// the office's own path (programMessages.postStaffMessage: portal Messages tab +
// the client email). Dry run by default; --apply sends.
const ENROLLMENT = "cmt7h6b0300059kcj990r34x7";
const BODY = "Hi Erica, good news: we were able to schedule your filming for this Thursday, October 29 at 8:30 AM. If you need another time, just let us know!";
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const booked = await prisma.programSessionRequest.findUnique({ where: { id: "cmvjvktdd0006jp07npqff1vu" }, select: { status: true, bookingState: true, slotStart: true } });
  console.log(`booking: ${JSON.stringify(booked)}`);
  if (booked?.status !== "CONFIRMED") throw new Error("not confirmed: nothing sent");
  const me = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, name: true, email: true } });
  console.log(`message: ${BODY}`);
  if (!process.argv.includes("--apply")) { console.log("dry run: nothing sent"); process.exit(0); }
  const { postStaffMessage } = await import("../../src/lib/programMessages");
  const r = await postStaffMessage(ENROLLMENT, { id: me.id, name: me.name, email: me.email }, BODY, null);
  console.log(`sent: ${JSON.stringify(r)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

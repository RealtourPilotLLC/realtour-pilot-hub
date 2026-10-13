// Oct 13 2026 (Jordan): "Let her choose" — offer Arielle Roemer the one 4-hour
// Video Accelerator session for September + October; she picks one 4-hour or two
// 2-hour sessions in her portal. Same write as the Overview's "Offer a 4-hour
// catch-up session" button (monthLateSession.setLateCombineOffer). Sends nothing.
import { prisma } from "@/lib/prisma";
async function main() {
  const { setLateCombineOffer, combineChoice } = await import("@/lib/monthLateSession");
  const { lateSessionOf } = await import("@/lib/lateSession");
  const r = await setLateCombineOffer("cmti54uo2004xic049w57b8ek", true, "Jordan Spackman");
  console.log(r.message);
  const e = await prisma.contentEnrollment.findUnique({ where: { id: "cmt7msany000c9kg1ospdeoza" }, select: { overridesJson: true } });
  const rec = lateSessionOf(e?.overridesJson, "2026-09");
  console.log(JSON.stringify(rec && await combineChoice(rec)));
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });

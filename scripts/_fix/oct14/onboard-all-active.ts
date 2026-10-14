// Oct 14 2026 (Jordan): "When you're done, deploy it and send out the sign-ups.
// Make sure that they are signing up for the portals we already have built for
// them." Runs autoOnboardClient for every ACTIVE, non-TEST program client: seat
// on their existing program, one welcome email each (idempotent: a re-run never
// sends a second), marked onboarded.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/onboard-all-active.ts [--apply]
import { prisma } from "@/lib/prisma";
async function main() {
  const apply = process.argv.includes("--apply");
  const { autoOnboardAll } = await import("@/lib/autoOnboarding");
  const rs = await autoOnboardAll("info@realtourpilot.com", { sendWelcome: true, dryRun: !apply });
  for (const r of rs) {
    console.log(`== ${r.name}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""} · ${r.seatEmail ?? "no email"}`);
    for (const s of r.steps) console.log(`   ${s.key}: ${s.status} · ${s.detail}`);
    if (r.duplicates?.length) console.log(`   DUPLICATES: ${JSON.stringify(r.duplicates)}`);
  }
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });

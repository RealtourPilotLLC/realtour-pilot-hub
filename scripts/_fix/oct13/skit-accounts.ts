// Oct 13 2026 (Jordan): "some clients, like her [Janice Pigga], Joe Sutow, and
// Mike Flatley, prefer more creative, skit-style videos ... Direct-to-camera or
// Skits." Sets those three accounts to Skits (programStyle.setVideoStyle);
// every other account stays Direct-to-camera. Nothing is sent to anyone.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct13/skit-accounts.ts [--apply]
import { prisma } from "@/lib/prisma";

const NAMES = ["Janice Pigga", "Joseph Sutow", "Mike Flatley"];

async function main() {
  const apply = process.argv.includes("--apply");
  const { setVideoStyle, videoStyleOf } = await import("@/lib/programStyle");
  for (const name of NAMES) {
    // A name can belong to two client records (an unmerged duplicate); the one with the live (active or paused) program is meant.
    const c = await prisma.client.findMany({ where: { name }, select: { id: true } });
    const es = await prisma.contentEnrollment.findMany({ where: { clientId: { in: c.map((x) => x.id) }, status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true } });
    if (es.length !== 1) throw new Error(`${name}: ${es.length} programs across ${c.length} client records — stopping.`);
    const e = es[0];
    console.log(`${name}: ${await videoStyleOf(e.id)} → SKITS`);
    if (apply) console.log("   ", JSON.stringify(await setVideoStyle(e.id, "SKITS", "info@realtourpilot.com")));
  }
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });

/**
 * DRONE ON A VIDEO-ONLY LINE IS FOOTAGE, NOT STILLS — every real product in
 * the catalogue put through the shipped parser, so the veto can be seen to
 * fire exactly where it should and nowhere else.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   set -a && source .env; set +a && \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/drone-footage.ts
 *
 * Read-only: it reads the product catalogue and calls the parser. No writes.
 */
import { prisma } from "@/lib/prisma";

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { loadManualProductMap, orderDeliverables } = await import("@/lib/integrations/aryeo");
  await loadManualProductMap(true);
  const parse = (title: string) =>
    orderDeliverables([{ id: title, title, amount: 25000, is_canceled: false } as never]).map((d) => d.type);

  console.log("=".repeat(74));
  console.log("Every catalogue product, through the shipped parser");
  console.log("=".repeat(74));

  const products = await prisma.product.findMany({
    where: { mediaTypes: { not: null } },
    select: { title: true, mediaTypes: true },
    orderBy: { title: "asc" },
  });
  const droneNow: string[] = [];
  for (const p of products) {
    const types = parse(p.title);
    if (types.includes("DRONE")) droneNow.push(p.title);
  }

  console.log("\n1. THE JOBS THAT COULD NEVER COMPLETE");
  // Brie's own order, whole.
  const brie = orderDeliverables(
    ["Drone Videography", "2D Floor Plan", "Standard Video Highlight Reel"].map(
      (t) => ({ id: t, title: t, amount: 25000, is_canceled: false } as never),
    ),
  );
  const brieTypes = brie.map((d) => d.type);
  console.log(`     5 Raymond Cir parses as: ${brieTypes.join(", ")}`);
  ok("her order no longer owes a drone-stills row", !brieTypes.includes("DRONE"));
  ok("…so nothing puts it in the PHOTOS lane", !brieTypes.includes("PHOTOS"));
  ok("…and it still owes the reel and the floor plan", brieTypes.includes("SOCIAL_REEL") && brieTypes.includes("FLOORPLAN"));
  ok("…and the drone line itself still owes nothing of its own", parse("Drone Videography").length === 0,
    `"Drone Videography" → ${parse("Drone Videography").join(", ") || "(nothing — it is footage)"}`);

  console.log("\n2. THE VETO FIRES ON VIDEO-ONLY LINES");
  for (const t of ["Standard Video Highlight Reel", "Premium Cinematic Video", "STR Luxury Cinematic Video Tour (with drone video)"]) {
    const types = parse(t);
    ok(`"${t.slice(0, 44)}" keeps its video, drops the stills`,
      !types.includes("DRONE") && (types.includes("VIDEO") || types.includes("SOCIAL_REEL")), types.join(", "));
  }

  console.log("\n3. AND NOWHERE ELSE");
  for (const t of ["STR Drone Aerial Photography", "Drone Photography", "Drone Aerial Photography"]) {
    ok(`"${t}" still owes drone stills`, parse(t).includes("DRONE"), parse(t).join(", ") || "(nothing)");
  }
  for (const t of ["Standard Package", "Premium Package", "Signature Package", "STR PRO BUNDLE", "Social Influencer"]) {
    const types = parse(t);
    ok(`"${t}" sells photography, so its drone stills stay`, types.includes("DRONE"), types.join(", "));
  }
  const deluxe = parse("Deluxe Land Only Package - Drone Photo and Video");
  ok("a line that NAMES drone photos keeps them even with video and no photography",
    deluxe.includes("DRONE"), deluxe.join(", "));

  console.log("\n4. THE WHOLE CATALOGUE, AFTER");
  console.log(`     products still minting a drone-stills row: ${droneNow.length}`);
  for (const t of droneNow) console.log(`       ${t}`);

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

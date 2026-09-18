// READ-ONLY. Which real order-item names change tier now that the board reads
// the same premium words as tasks.ts / projectStatus.ts. Every changed name is
// printed in full — a widened regex that quietly re-dates "Luxury Photo
// Package" would be worse than the divergence it fixes.
import { PrismaClient } from "@prisma/client";
import { tierFor } from "../../../src/lib/turnaround";

const prisma = new PrismaClient();

// The rules exactly as they were before Sep 18: only the word "premium", and
// only beside the word "reel".
const OLD_PREMIUM = [/\bpremium\b.*\breel\b/i, /\breel\b.*\bpremium\b/i];
const OLD_MONTHLY = [/\bvideo\s*(starter|accelerator|pro)\b/i, /\b(monthly|social)\s+(content|package|plan)\b/i, /\bmonthly\b.*\breel/i];
const OLD_SAME_DAY = /\bsame[-\s]?day\b/i;

function oldTier(t: string): string {
  if (OLD_SAME_DAY.test(t)) return "same_day";
  if (OLD_MONTHLY.some((r) => r.test(t))) return "monthly_social";
  if (OLD_PREMIUM.some((r) => r.test(t))) return "premium_reel";
  if (/\bstag(ing|e)\b/i.test(t)) return "next_day";
  if (/\b(drone|aerial|twilight|headshot|lot lines?)\b/i.test(t)) return "next_day";
  if (/\b(floor\s*plan|floorplan|cubicasa)\b/i.test(t)) return "next_day";
  if (/\b(zillow|showcase|3d tour|matterport)\b/i.test(t)) return "next_day";
  if (/\b(video|reel|walkthrough|tour video|listing video|agent intro)\b/i.test(t)) return "video_48h";
  if (/\b(photo|photos|photography|image|hdr)\b/i.test(t)) return "next_day";
  return "next_day";
}

async function main() {
  const items = await prisma.orderItem.groupBy({ by: ["title"], _count: { title: true } });
  const changed = items
    .map((i) => ({ title: i.title, n: i._count.title, from: oldTier(i.title), to: tierFor(i.title).key }))
    .filter((x) => x.from !== x.to)
    .sort((a, b) => b.n - a.n);
  console.log(`${items.length} distinct order-item names; ${changed.length} change tier:`);
  for (const c of changed) console.log(`  ${String(c.n).padStart(4)}×  ${c.from} -> ${c.to}   ${c.title}`);
  await prisma.$disconnect();
}
main();

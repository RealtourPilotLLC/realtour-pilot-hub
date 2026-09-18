// FREEZE THE PROMISE EVERY JOB WAS SOLD UNDER.
//
// Jordan, Sep 18 2026: "Preserve existing agreed promises when changing
// defaults." Until this ran, a job's deadline was a CALCULATION, not a record:
// Project.deliveryDue is recomputed by the status sweep on every pass from
// whatever the turnaround table says today. So the moment the premium reel
// moved from 72 elapsed hours to four business days, every premium job ever
// delivered would have been re-judged against a promise nobody ever made —
// measured on the live database before the move, 39 delivered premium jobs
// flip from late to on-time, which re-scores the owner's on-time dial AND the
// photographer $1,000-a-quarter bonus that reads the same two columns.
//
// WHAT IT WRITES, once per project, and never over a value already there:
//   promisedDueAt    ← Project.deliveryDue exactly as stored. That column IS
//                      the promise the job was sold under; recomputing it here
//                      would defeat the purpose of freezing it.
//   promisedTargetAt ← the INTERNAL aim for that job's tier, on the rules as
//                      they stood on Sep 18, never later than the deadline.
//   promisedTierKey  ← which promise it was (premium_reel, next_day, …).
//   promisedPinnedAt ← when it was frozen.
//
// THE TIER ARITHMETIC BELOW IS A DELIBERATE COPY, not an import of
// src/lib/turnaround.ts. A freeze that moves when the library moves is not a
// freeze: re-running this next year must reproduce the same numbers it wrote
// today. The one thing it does import is the ET day-key helper, because the
// alternative is a millisecond loop that drifts an hour across a clock change.
//
// Usage:
//   npx tsx scripts/pin-promises.ts              # dry run — counts and samples
//   npx tsx scripts/pin-promises.ts --apply      # write the pins
//   npx tsx scripts/pin-promises.ts --reclassify # repair tier/aim ONLY (see below)
import { PrismaClient } from "@prisma/client";
import { etAt, etDayKey, endOfBusinessDaysET } from "../src/lib/datetime";
// The hub's own monthly-plan reading. Imported, not copied: this is the same
// function the status engine consulted when it wrote the dates being frozen,
// and a weaker regex here read 893 S Matlack's 16-video branding batch as a
// 48-hour reel.
import { isMonthlyContentJob } from "../src/lib/pipeline";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
// --reclassify rewrites promisedTierKey and promisedTargetAt — never the
// deadline — on rows whose pin still equals Project.deliveryDue, i.e. rows
// this script wrote and that nothing has since moved. It exists because the
// first pass labelled a job by its premium row when a LONGER promise on the
// same order (the monthly batch) is what actually set the date.
const RECLASSIFY = process.argv.includes("--reclassify");

// ---- The promise table AS IT STOOD ON Sep 18 2026, before the premium move.
// Days are calendar days unless `business` says otherwise; every day-quoted
// promise closes at 5pm ET.
type TierKey = "same_day" | "next_day" | "video_48h" | "premium_reel" | "monthly_social";
const FROZEN_TARGET: Record<TierKey, { days: number; business: boolean }> = {
  same_day: { days: 0, business: false },
  next_day: { days: 1, business: false },
  video_48h: { days: 2, business: false },
  // The premium AIM was three days even when the deadline was 72 hours.
  premium_reel: { days: 3, business: false },
  monthly_social: { days: 7, business: true },
};
const END_HOUR = 17;

function frozenTarget(tier: TierKey, anchor: Date): Date {
  const { days, business } = FROZEN_TARGET[tier];
  if (business) return endOfBusinessDaysET(anchor, days, END_HOUR);
  return etAt(etDayKey(new Date(anchor.getTime() + days * 86_400_000)), END_HOUR);
}

// ---- WHICH PROMISE SET THE DATE.
//
// Project.deliveryDue is the LONGEST promise on the order (tasks.ts
// standardDeliveryDue takes the max). So the job's tier is the tier of the
// deliverable that WON that max — not simply "there is a premium row on this
// order". 893 S Matlack carries a premium reel and a 16-video branding batch;
// the batch is what dated it, and labelling the pin "premium_reel" would have
// recorded an aim three days after the shoot for a job promised two weeks out.
// The hour table below is the one that produced every stored deliveryDue.
const REEL = new Set(["VIDEO", "SOCIAL_REEL"]);
const PREMIUM_RE = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;
const SAME_DAY_PHOTOS_RE = /\bsame[-\s]?day\b[^,;|]*\bphoto/i;
const SAME_DAY_FLOORPLAN_RE = /\bsame[-\s]?day\b[^,;|]*\bfloor[-\s]?plan/i;
const MONTHLY_RE = /\b(video\s*(starter|accelerator|pro)|monthly|social\s+(content|package|plan))\b/i;

// The office's turnaround table as it stood when these dates were written
// (AppSetting "turnarounds" held exactly these values on Sep 18 2026).
const HOURS: Record<string, number> = {
  PHOTOS: 20, DRONE: 20, TWILIGHT: 20, FLOORPLAN: 36, MATTERPORT_3D: 36, ZILLOW_3D: 36,
  HEADSHOT: 24, VIRTUAL_STAGING: 48, SOCIAL_REEL: 48, VIDEO: 48, OTHER: 48,
};
const PREMIUM_HOURS = 72;
const MONTHLY_BUSINESS_DAYS = 10;

/**
 * The retired monthly walk, VERBATIM — tasks.ts addBusinessDays as it was
 * before Sep 18: UTC day arithmetic, carrying the anchor's clock time onto the
 * landing day. Copied rather than imported on purpose. This is forensics: it
 * has to reproduce the dates that are already in the database, not the dates
 * the hub would compute now (which skip to 5pm ET on an ET day key).
 */
function oldMonthlyDue(anchor: Date, days: number): Date {
  const d = new Date(anchor);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

type Row = {
  id: string;
  title: string;
  shootDate: Date | null;
  createdAt: Date;
  deliveryDue: Date | null;
  packageName: string | null;
  tierOverride: string | null;
  deliverables: { type: string; label: string | null; productTitle: string | null }[];
  orderItems: { title: string }[];
};

/** The tier of the deliverable whose promise WON the job's max, plus that
 *  reconstructed date — so the caller can see whether the reconstruction
 *  agrees with what is stored. */
function tierKeyFor(p: Row, anchor: Date): { tier: TierKey; reconstructed: Date } {
  const names = [
    p.packageName ?? "",
    ...p.deliverables.map((d) => `${d.label ?? ""} ${d.productTitle ?? ""}`),
    ...p.orderItems.map((o) => o.title),
  ];
  const monthly =
    p.tierOverride === "branding" ||
    isMonthlyContentJob(p.deliverables, p.packageName) ||
    names.some((n) => MONTHLY_RE.test(n));
  const rushPhotos = names.some((n) => SAME_DAY_PHOTOS_RE.test(n));
  const rushPlan = names.some((n) => SAME_DAY_FLOORPLAN_RE.test(n));

  let best: { tier: TierKey; at: Date } | null = null;
  for (const d of p.deliverables) {
    const video = REEL.has(d.type);
    const premium =
      p.tierOverride === "premium" ||
      (video && !!d.label && PREMIUM_RE.test(d.label) && !/\bstandard\b/i.test(d.label));
    const rushed = (rushPhotos && (d.type === "PHOTOS" || d.type === "DRONE")) || (rushPlan && d.type === "FLOORPLAN");
    let tier: TierKey;
    let at: Date;
    if (rushed) {
      tier = "same_day";
      // sameDayDue: 5pm ET on the shoot day, floored at shoot + 3h.
      const eob = etAt(etDayKey(anchor), END_HOUR);
      at = eob.getTime() < anchor.getTime() + 3 * 3_600_000 ? new Date(anchor.getTime() + 3 * 3_600_000) : eob;
    } else if (video && premium) {
      tier = "premium_reel";
      at = new Date(anchor.getTime() + PREMIUM_HOURS * 3_600_000);
    } else if (video && monthly) {
      tier = "monthly_social";
      at = oldMonthlyDue(anchor, MONTHLY_BUSINESS_DAYS);
    } else if (video) {
      tier = "video_48h";
      at = new Date(anchor.getTime() + HOURS[d.type] * 3_600_000);
    } else {
      tier = "next_day";
      at = new Date(anchor.getTime() + (HOURS[d.type] ?? HOURS.OTHER) * 3_600_000);
    }
    if (!best || at > best.at) best = { tier, at };
  }
  // An order with no deliverable rows left (everything waived or removed) —
  // 48h was the engine's answer for that too.
  if (!best) best = { tier: "next_day", at: new Date(anchor.getTime() + 48 * 3_600_000) };
  return { tier: best.tier, reconstructed: best.at };
}

async function main() {
  const rows = (await prisma.project.findMany({
    where: RECLASSIFY
      ? // Only rows whose pin still IS the stored column: a pin this script
        // made, that no office override or later promise has moved.
        { promisedDueAt: { not: null, equals: prisma.project.fields.deliveryDue } }
      : { deliveryDue: { not: null }, promisedDueAt: null },
    select: {
      id: true,
      title: true,
      shootDate: true,
      createdAt: true,
      deliveryDue: true,
      packageName: true,
      tierOverride: true,
      deliverables: { select: { type: true, label: true, productTitle: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
    },
  })) as Row[];

  const alreadyPinned = await prisma.project.count({ where: { promisedDueAt: { not: null } } });
  console.log(
    RECLASSIFY
      ? `${rows.length} pinned project(s) whose pin still equals deliveryDue. ${alreadyPinned} pinned in total.`
      : `${rows.length} project(s) carry a due date and no pin. ${alreadyPinned} already pinned.`,
  );

  const byTier = new Map<TierKey, number>();
  let written = 0;
  let skipped = 0;
  let reconstructionMatches = 0;
  const samples: string[] = [];

  for (const p of rows) {
    const due = p.deliveryDue;
    if (!due) { skipped++; continue; } // belt and braces: the WHERE already excludes these
    // The clock ran from the shoot; a monthly job without one ran from the
    // order. Same ladder the board's clockStart uses.
    const anchor = p.shootDate ?? p.createdAt;
    const { tier, reconstructed } = tierKeyFor(p, anchor);
    // Does the old arithmetic reproduce the stored date? A mismatch is not an
    // error — an office override, a re-shoot that moved shootDate after the
    // date was written, a product remap — but the count is worth printing, so
    // nobody reads the tier label as more certain than it is.
    if (Math.abs(reconstructed.getTime() - due.getTime()) < 60_000) reconstructionMatches++;
    const target = frozenTarget(tier, anchor);
    // A target after the deadline is not a target. Real data has jobs whose
    // stored deliveryDue predates the tier's own aim (an office edit, a
    // re-shoot); those pin target = deadline rather than an impossible aim.
    const promisedTargetAt = target > due ? due : target;
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    if (samples.length < 8) {
      samples.push(
        `  ${p.title.slice(0, 44).padEnd(46)} ${tier.padEnd(15)} due ${due.toISOString()}  aim ${promisedTargetAt.toISOString()}`,
      );
    }
    if (RECLASSIFY) {
      if (!APPLY) continue;
      // The deadline is NOT in this update. Only the label and the aim.
      const r = await prisma.project.updateMany({
        where: { id: p.id, promisedDueAt: due },
        data: { promisedTargetAt, promisedTierKey: tier },
      });
      written += r.count;
    } else if (APPLY) {
      // updateMany with the null guard: two runs racing, or a re-run after a
      // crash, can never overwrite a pin that is already there.
      const r = await prisma.project.updateMany({
        where: { id: p.id, promisedDueAt: null },
        data: {
          promisedDueAt: due,
          promisedTargetAt,
          promisedTierKey: tier,
          promisedPinnedAt: new Date(),
        },
      });
      written += r.count;
    }
  }

  console.log(`by tier: ${[...byTier.entries()].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  console.log(`the old arithmetic reproduces the stored date on ${reconstructionMatches}/${rows.length} row(s)`);
  console.log(samples.join("\n"));
  if (skipped) console.log(`skipped ${skipped} row(s) with no due date`);
  console.log(APPLY ? `WROTE ${written} pin(s).` : "DRY RUN — nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

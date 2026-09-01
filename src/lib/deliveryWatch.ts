import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// "PHOTOS STILL NOT OUT" WATCHDOG.
//
// Shot yesterday or earlier, photos still not released to the client on Aryeo →
// text Kyle and Jordan. Photos only: video legitimately runs days behind on an
// editor's clock, and staged delivery (photos next-day, reel later) is normal —
// including video would fire constantly on jobs that are not late.
//
// FIRES ONCE PER JOB, in a late-afternoon window, so the miss is caught while
// there is still a business day left to fix it.
//
// THREE RULES THIS MUST NEVER BREAK:
//  1. UNKNOWN IS NOT LATE. If we could not read Aryeo this pass, we do not
//     know the job is undelivered. Alerting on a blind read would page the
//     whole roster during an Aryeo outage — the same trap the status engine
//     already guards with `rawsKnownEmpty`.
//  2. NEVER TOUCH HISTORY. Only shoots inside a short recent window are ever
//     considered, so switching this on cannot text about hundreds of old jobs.
//  3. MONTHLY-SOCIAL SESSIONS ARE NOT LISTINGS. Video Starter/Accelerator/Pro
//     content days have no Aryeo listing to deliver to and run a 7-10 business
//     day clock; they would otherwise alert every single day forever.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
// The next day has had its chance once this many hours have passed since the
// shoot. TURNAROUND_HOURS.PHOTOS is 20 ("next morning"); this sits past it so a
// late-afternoon shoot is not chased before lunch the following day.
const PHOTOS_LATE_AFTER_MS_DEFAULT = 26 * HOUR; // overridden by Settings → Internal alerts
// Never look further back than this — the backfill guard.
const LOOKBACK_DAYS = 6;
// Late-afternoon ET window: enough of the day gone to call it a miss, early
// enough that someone can still act on it.
const ALERT_HOUR_FROM = 16;
const ALERT_HOUR_TO = 19;

const etHour = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));

export type DeliveryWatchResult = {
  checked: number;
  late: number;
  alerted: number;
  skippedOutsideWindow: boolean;
  texted: string[];
};

/** A monthly-social content session, not a listing with a delivery clock. */
function isContentSession(titles: string[]): boolean {
  return titles.some((t) => /video (starter|accelerator|pro)|content (session|day)/i.test(t));
}

export async function sweepUndeliveredPhotos(opts?: { dryRun?: boolean }): Promise<DeliveryWatchResult> {
  const dryRun = !!opts?.dryRun;
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = (await internalAlertRules()).photosUndelivered;
  if (!dryRun && !rules.enabled) {
    return { checked: 0, late: 0, alerted: 0, skippedOutsideWindow: true, texted: [] };
  }
  const PHOTOS_LATE_AFTER_MS = rules.lateAfterHours * HOUR;
  const ALERT_HOUR_FROM = rules.fromHour;
  const ALERT_HOUR_TO = rules.toHour;
  const hour = etHour();
  // Outside the window we do nothing at all — not even a bell — so the alert
  // lands at a predictable time rather than whenever a cron happened to run.
  if (!dryRun && (hour < ALERT_HOUR_FROM || hour >= ALERT_HOUR_TO)) {
    return { checked: 0, late: 0, alerted: 0, skippedOutsideWindow: true, texted: [] };
  }

  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 24 * HOUR);
  const candidates = await prisma.project.findMany({
    where: {
      shootDate: { gte: since, lte: new Date(now - PHOTOS_LATE_AFTER_MS) },
      // REVISION and ON_HOLD are excluded on purpose: a REVISION job was already
      // delivered once and is legitimately back in production.
      status: { in: ["SHOT", "EDITING", "REVIEW"] },
      aryeoListingId: { not: null },
      aryeoMissingAt: null, // order gone from Aryeo — nothing to watch
    },
    select: {
      id: true,
      title: true,
      shootDate: true,
      statusEvidence: true,
      statusCheckedAt: true,
      photographer: { select: { name: true } },
      client: { select: { name: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { label: true } },
    },
    orderBy: { shootDate: "desc" },
    take: 60,
  });

  const late: { id: string; street: string; who: string; hoursLate: number }[] = [];
  for (const p of candidates) {
    if (isContentSession([...p.orderItems.map((i) => i.title), ...p.deliverables.map((d) => d.label ?? "")])) continue;

    const ev = parseEvidence(p.statusEvidence);
    // RULE 1 — we must have actually read Aryeo, and read it recently.
    if (!ev || !ev.aryeo) continue;
    if (!p.statusCheckedAt || now - p.statusCheckedAt.getTime() > 6 * HOUR) continue;
    // Photos have to be something this job owes at all.
    const expected = ev.expected ?? [];
    if (!expected.some((c) => /photo/i.test(c))) continue;
    // Released to the client? That is the listing-level delivery flag — media
    // merely EXISTING on the listing is not the same as the client having it.
    if (ev.aryeo.delivery === "DELIVERED") continue;

    late.push({
      id: p.id,
      street: (p.title || "this job").split(",")[0].trim(),
      who: p.client?.name ?? "the client",
      hoursLate: Math.round((now - (p.shootDate?.getTime() ?? now)) / HOUR),
    });
  }

  if (dryRun) {
    return { checked: candidates.length, late: late.length, alerted: 0, skippedOutsideWindow: false, texted: [] };
  }

  // One alert per job, ever — the bell row's unique dedupeKey is the ledger, so
  // a job that stays undelivered does not re-text every afternoon. notifyInApp
  // suffixes the key with the target index, hence the `-0` probe.
  const { notifyInApp, notifyStaffSms } = await import("@/lib/notify");
  const fresh: typeof late = [];
  for (const l of late) {
    const key = `photos-undelivered-${l.id}`;
    const seen = await prisma.notification.findUnique({ where: { dedupeKey: `${key}-0` } }).catch(() => null);
    if (seen) continue;
    await notifyInApp({
      kind: "photos_undelivered",
      title: `Photos still not delivered — ${l.street}`,
      href: `/projects/${l.id}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: key,
    });
    fresh.push(l);
  }
  if (fresh.length === 0) {
    return { checked: candidates.length, late: late.length, alerted: 0, skippedOutsideWindow: false, texted: [] };
  }

  // Whoever is flagged for ops alerts — Kyle and Jordan today. Deliberately NOT
  // role-derived: Kyle is MANAGER and so is Kim (an editor in Manila), while
  // Jordan is PHOTOGRAPHER because he shoots. A role query here texted the wrong
  // people and missed Kyle entirely.
  const staff = await prisma.teamMember.findMany({
    where: { active: true, opsAlerts: true },
    select: { id: true, name: true },
  });
  const lines = fresh.slice(0, 4).map((l) => `${l.street} (${l.who}) — shot ${Math.round(l.hoursLate / 24)}d ago`);
  const more = fresh.length > 4 ? ` +${fresh.length - 4} more` : "";
  const results = await notifyStaffSms(
    staff.map((s) => s.id),
    `${fresh.length} job${fresh.length === 1 ? "" : "s"} shot and photos still not delivered on Aryeo:\n${lines.join("\n")}${more}`,
  );

  return {
    checked: candidates.length,
    late: late.length,
    alerted: fresh.length,
    skippedOutsideWindow: false,
    texted: results.filter((r) => r.outcome === "sent").map((r) => r.name),
  };
}

/** What the sweep WOULD alert on right now, without sending anything. */
export async function previewUndeliveredPhotos(): Promise<{ day: string; wouldAlert: number; checked: number }> {
  const r = await sweepUndeliveredPhotos({ dryRun: true });
  return { day: etDayKey(new Date()), wouldAlert: r.late, checked: r.checked };
}

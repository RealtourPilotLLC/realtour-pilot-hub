import "server-only";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { logComm } from "@/lib/commLog";

// ---------------------------------------------------------------------------
// The 7 PM shoot digest (Jordan, Sep 1 2026): every evening, each creative
// with shoots that day gets ONE text — the list of their shoots and the link
// to their upload portal, where each job must be wrapped up the same night.
// Idempotent per photographer per ET day (the cron fires on two UTC schedules
// to hit 7 PM across EDT/EST; the marker makes the second firing a no-op).
// ---------------------------------------------------------------------------

const APP_URL = "https://realtour-pilot-hub.vercel.app";

function etDayKey(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

/** ET midnight-to-midnight window for "today", expressed in UTC instants.
 *  Known 1h edge skew on the two DST transition days for shoots timestamped
 *  11 PM–1 AM ET — real shoots never are (reviewed and accepted). */
function etDayWindow(): { start: Date; end: Date } {
  const key = etDayKey();
  // Resolve the ET offset at noon ET today (DST-safe for a whole-day window).
  const noonUtc = new Date(`${key}T12:00:00Z`);
  const etHourAtNoonUtc = Number(
    noonUtc.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
  );
  const offsetHours = 12 - etHourAtNoonUtc; // 4 during EDT, 5 during EST
  const start = new Date(`${key}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + offsetHours);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

export function digestText(firstName: string, streets: string[]): string {
  const list = streets.map((s) => `• ${s}`).join("\n");
  return (
    `RealTour Pilot — heads up ${firstName}: NEW upload process for all uploads, starting now.\n` +
    `Your shoots today:\n${list}\n` +
    `Each one gets wrapped up on its upload page tonight — cull confirmed, notes in, everything uploaded:\n` +
    `${APP_URL}/upload\n` +
    `First time? The page walks you through it in 2 minutes.`
  );
}

export async function sendEveningUploadDigests(): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const { start, end } = etDayWindow();
  const dayKey = etDayKey();

  const shoots = await prisma.project.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      // ON_HOLD = the shoot may not have happened — never tell someone to
      // wrap up content that wasn't captured (review finding).
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      photographerId: { not: null },
    },
    select: {
      id: true,
      title: true,
      photographerId: true,
      photographer: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { shootDate: "asc" },
  });
  if (shoots.length === 0) return { sent: 0, skipped: 0, notes: ["no shoots today"] };

  const byMember = new Map<string, { name: string; phone: string | null; streets: string[] }>();
  for (const s of shoots) {
    if (!s.photographer) continue;
    const cur = byMember.get(s.photographer.id) ?? { name: s.photographer.name, phone: s.photographer.phone, streets: [] };
    cur.streets.push(s.title.split(",")[0]);
    byMember.set(s.photographer.id, cur);
  }

  const from = await defaultOpenPhoneNumber();
  if (!from) return { sent: 0, skipped: byMember.size, notes: ["OpenPhone not connected"] };

  let sent = 0, skipped = 0;
  for (const [memberId, m] of byMember) {
    const k = phoneKey(m.phone ?? "");
    if (k.length !== 10) { skipped++; notes.push(`${m.name}: no valid phone`); continue; }
    // ATOMIC claim FIRST (unique key insert) — two concurrent invocations can
    // never both text; the loser hits P2002 and skips. Send failure releases
    // the claim so the next firing retries (never-double-text > never-miss).
    const marker = `upload-digest-${dayKey}-${memberId}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch {
      skipped++; // already claimed (today's text went out or is in flight)
      continue;
    }
    const text = digestText(m.name.split(" ")[0], m.streets);
    try {
      await OpenPhone.sendMessage(from, `+1${k}`, text);
      sent++;
    } catch (e) {
      // Release the claim — this photographer was NOT texted.
      await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
      skipped++;
      notes.push(`${m.name}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
      continue;
    }
    try {
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        contactName: m.name, fromPhone: k, body: text,
        source: "upload-digest", externalId: `upload-digest-${dayKey}-${memberId}`,
      });
    } catch (e) {
      notes.push(`${m.name}: sent but comms log failed — ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  return { sent, skipped, notes };
}

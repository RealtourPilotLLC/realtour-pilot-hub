import { NextRequest, NextResponse } from "next/server";
import { sendEveningUploadDigests, sendNightlyUploadNags } from "@/lib/uploadDigest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// EVENING cron — the 7 PM digest and the 10 PM unsubmitted-page chaser.
// Vercel schedules run in UTC and can't follow DST, so each ET slot gets two
// UTC firings (23:00/00:00 for 7 PM, 02:00/03:00 for 10 PM) and the route
// only acts at the right Eastern hour; per-day markers make the extra firing
// a no-op either way.
export async function GET(req: NextRequest) {
  // FAIL CLOSED — same rule as every other cron.
  const secret = process.env.CRON_SECRET;
  const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  if (!secret && enforced) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const etHour = Number(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
  );
  const { internalAlertRules } = await import("@/lib/settings");
  const alerts = await internalAlertRules();
  if (alerts.uploadReminder.enabled && etHour === alerts.uploadReminder.hour) {
    const digests = await sendEveningUploadDigests().catch((e) => ({
      sent: 0, skipped: 0, notes: [e instanceof Error ? e.message : "digest failed"],
    }));
    // A quiet day is a 200; sending NOTHING while there was work (or the whole
    // run threw) must show RED on the cron dashboard, not green.
    const totalFailure = digests.sent === 0 && digests.notes.length > 0 && digests.notes[0] !== "no shoots today";
    return NextResponse.json({ digests }, { status: totalFailure ? 500 : 200 });
  }
  if (alerts.uploadChaser.enabled && etHour === alerts.uploadChaser.hour) {
    const nags = await sendNightlyUploadNags().catch((e) => ({
      sent: 0, skipped: 0, notes: [e instanceof Error ? e.message : "nag failed"],
    }));
    const totalFailure = nags.sent === 0 && nags.notes.length > 0 && nags.notes[0] !== "nothing unsubmitted today";
    return NextResponse.json({ nags }, { status: totalFailure ? 500 : 200 });
  }
  return NextResponse.json({ skipped: true, reason: `ET hour is ${etHour}; reminder at ${alerts.uploadReminder.hour}, chaser at ${alerts.uploadChaser.hour} (Settings → Internal alerts)` });
}

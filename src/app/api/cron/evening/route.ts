import { NextRequest, NextResponse } from "next/server";
import { sendEveningUploadDigests, sendNightlyUploadNags } from "@/lib/uploadDigest";
import { COMMS_COACHING_ET_HOUR } from "@/lib/commsCoaching";
import { cronBudget } from "@/lib/cron";

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

  // EVERY FIRING IS RECORDED (A01-cron-health, Sep 28 2026). This was the one
  // scheduled route that never passed a job name to cronBudget, so it wrote no
  // CronRun and Sync health could not tell "ran fine" from "never ran". Now
  // each firing is a row, including the DST twin that is not the Eastern hour:
  // that one finishes ok with an `idle` note, NOT a `skipped` entry, because
  // cron.ts reads `skipped` as a budget failure and would page about it twice
  // a day. The HTTP statuses are exactly what they were. The twin fires an
  // hour AFTER the acting firing all through EDT, so lib/cronHealth reads a
  // firing that did nothing as a dot, never as the job's last run — else a
  // failed 7 PM digest read green by 8 (review, Sep 28).
  const startedAt = Date.now();
  const { step, out, finish } = cronBudget(100_000, startedAt, "evening"); // ~20s headroom under maxDuration
  const etHour = Number(
    new Date(startedAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
  );
  const { internalAlertRules } = await import("@/lib/settings");
  const alerts = await internalAlertRules();

  // A quiet day is a 200; sending NOTHING while there was work (or the whole
  // run threw) must show RED on the cron dashboard, not green. The step throws
  // on that total failure so the CronRun row carries it too; the result is
  // kept aside so the body still says what the sender reported.
  type SendResult = { sent: number; skipped: number; notes: string[]; held?: string[] };
  const isTotalFailure = (r: SendResult, quiet: string) => r.sent === 0 && r.notes.length > 0 && r.notes[0] !== quiet;
  const runSend = async (name: "digests" | "nags", send: () => Promise<SendResult>, quiet: string, fallback: string) => {
    const box: { result?: SendResult } = {};
    await step(name, async () => {
      const result = (box.result = await send());
      if (isTotalFailure(result, quiet)) throw new Error(`sent nothing: ${result.notes[0]}`);
      return result;
    });
    const timedOut = Array.isArray(out.timedOut) && (out.timedOut as string[]).includes(name);
    const r = box.result ?? { sent: 0, skipped: 0, notes: [String(out[`${name}Error`] ?? (timedOut ? `${fallback}: timed out` : fallback))] };
    return { r, totalFailure: isTotalFailure(r, quiet) };
  };

  // THE DIGEST OR THE CHASER FIRST, THEN COACHING (review, Sep 28). Both are
  // steps of one 100-second budget, and coaching ran first: one slow model
  // call (it audits up to five people, one SMART call each, with retries)
  // could spend the budget, and the 7 PM digest was then SKIPPED outright or
  // squeezed to five seconds. Coaching is the best-effort one, so it takes
  // what is left; the digest never waits on it.
  let sent: { key: "digests" | "nags"; r: SendResult; totalFailure: boolean } | null = null;
  if (alerts.uploadReminder.enabled && etHour === alerts.uploadReminder.hour) {
    const { r, totalFailure } = await runSend("digests", sendEveningUploadDigests, "no shoots today", "digest failed");
    sent = { key: "digests", r, totalFailure };
  } else if (alerts.uploadChaser.enabled && etHour === alerts.uploadChaser.hour) {
    const { r, totalFailure } = await runSend("nags", sendNightlyUploadNags, "nothing unsubmitted today", "nag failed");
    sent = { key: "nags", r, totalFailure };
  }

  // END-OF-DAY COMMS COACHING (Jordan, Sep 21 2026: "I think we should do this
  // daily at the end of the day"). It runs at 7 PM ET on its OWN hour, not on
  // the upload-reminder switch: that switch is about photographers' raws and
  // Jordan can turn it off tomorrow without meaning to stop auditing the text
  // line.
  //
  // WHOLLY BEST-EFFORT. A coaching failure is reported in the body and never
  // in the status code, and it runs after the step that matters more. Its own
  // per-day AppSetting marker makes the DST-pair second firing a no-op. (As a
  // step, a throw also marks the run not-ok on Sync health, which is where it
  // should show.)
  if (etHour === COMMS_COACHING_ET_HOUR) {
    await step("coaching", async () => (await import("@/lib/commsCoaching")).runDailyCommsCoaching());
  }
  const coaching = out.coachingError ? { error: String(out.coachingError) } : out.coaching;

  if (sent) {
    await finish();
    return NextResponse.json({ [sent.key]: sent.r, coaching }, { status: sent.totalFailure ? 500 : 200 });
  }
  const reason = `ET hour is ${etHour}; reminder at ${alerts.uploadReminder.hour}, chaser at ${alerts.uploadChaser.hour} (Settings → Internal alerts)`;
  out.idle = reason;
  await finish();
  return NextResponse.json({ coaching, skipped: true, reason });
}

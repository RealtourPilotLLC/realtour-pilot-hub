import { NextRequest, NextResponse } from "next/server";
import { sendEveningUploadDigests } from "@/lib/uploadDigest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// EVENING cron — the 7 PM ET jobs. Vercel schedules run in UTC and can't
// follow DST, so this fires at BOTH 23:00 and 00:00 UTC and only acts when
// it's actually 7 PM Eastern; the digest's per-day markers make the second
// firing a no-op either way.
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
  if (etHour !== 19) {
    return NextResponse.json({ skipped: true, reason: `ET hour is ${etHour}, not 19` });
  }

  const digests = await sendEveningUploadDigests().catch((e) => ({
    sent: 0, skipped: 0, notes: [e instanceof Error ? e.message : "digest failed"],
  }));
  // A quiet day is a 200; sending NOTHING while there was work (or the whole
  // run threw) must show RED on the cron dashboard, not green.
  const totalFailure = digests.sent === 0 && digests.notes.length > 0 && digests.notes[0] !== "no shoots today";
  return NextResponse.json({ digests }, { status: totalFailure ? 500 : 200 });
}

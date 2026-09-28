import { NextRequest, NextResponse } from "next/server";
import { authorizeCron, deployStamp } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WHICH BUILD IS SERVING PAGES RIGHT NOW (A01, Sep 28 2026).
//
// The config probe could only read the build the last HOURLY cron stamped on
// its CronRun row, so a deploy made at :05 read as the old commit for up to an
// hour, and the page's own stamp was visible only in a browser on
// /content/monitoring. This answers the one question from the running build
// itself. It is not scheduled in vercel.json; nothing calls it but the probe.
//
// Same CRON_SECRET bearer as every cron (fail closed in production). It
// returns the 12-character commit stamp and nothing else: no environment, no
// secrets, no data. Read-only.
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  return NextResponse.json({ deploy: deployStamp() }, { headers: { "Cache-Control": "no-store" } });
}

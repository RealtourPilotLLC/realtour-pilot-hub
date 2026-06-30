import { NextRequest, NextResponse } from "next/server";
import { relabelPremiumDeliverables } from "@/lib/integrations/aryeo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Manual maintenance trigger (NOT scheduled): re-derive deliverable labels from
// the live order items so a change to the premium-product rules takes effect on
// existing projects. Secret-gated like the other cron routes.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await relabelPremiumDeliverables();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

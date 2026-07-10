import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Diagnostic: does the server's GOOGLE_MAPS_API_KEY actually work against the
// Street View Static API? Fetches one frame SERVER-SIDE and reports only the
// outcome — the key itself never appears in the response (safe to expose;
// added to the middleware PUBLIC list so it can be probed while debugging).
// Google failure modes this distinguishes: API not enabled, billing not
// enabled, key restricted to the wrong API/referrer, invalid key.
export async function GET() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json({ keyConfigured: false, ok: false, hint: "GOOGLE_MAPS_API_KEY is not set in this environment." });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview?size=100x100&location=${encodeURIComponent("1555 Mission Rd, Lancaster, PA")}&key=${key}`;
    const r = await fetch(url, { cache: "no-store" });
    const contentType = r.headers.get("content-type") ?? "";
    const isImage = contentType.startsWith("image/");
    // On errors Google returns text/plain or JSON explaining exactly why.
    const body = isImage ? null : (await r.text()).slice(0, 300);
    return NextResponse.json({
      keyConfigured: true,
      ok: r.ok && isImage,
      googleStatus: r.status,
      contentType,
      googleSays: body,
    });
  } catch (e) {
    return NextResponse.json({ keyConfigured: true, ok: false, error: (e as Error).message.slice(0, 200) });
  }
}

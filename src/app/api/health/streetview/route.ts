import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Diagnostic: does the server's GOOGLE_MAPS_API_KEY actually work against the
// Street View Static API, and what would the My Shoots cards render for the
// next few UPCOMING shoots? Everything is fetched SERVER-SIDE and the key
// never appears in the response (safe to expose; on the middleware PUBLIC
// list while debugging). The two referer variants distinguish a key with an
// HTTP-referrer ("Websites") restriction: the browser sends our domain as
// Referer, server-to-server sends none — if one works and the other 403s,
// the key's application restriction is the culprit.
export async function GET() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json({ keyConfigured: false, hint: "GOOGLE_MAPS_API_KEY is not set in this environment." });
  }

  const probe = async (referer?: string) => {
    try {
      const url = `https://maps.googleapis.com/maps/api/streetview?size=100x100&location=39.9731263,-75.2428753&fov=75&key=${key}`;
      const r = await fetch(url, { cache: "no-store", headers: referer ? { Referer: referer } : {} });
      const contentType = r.headers.get("content-type") ?? "";
      const isImage = contentType.startsWith("image/");
      return { status: r.status, contentType, ok: r.ok && isImage, googleSays: isImage ? null : (await r.text()).slice(0, 200) };
    } catch (e) {
      return { status: 0, contentType: "", ok: false, googleSays: (e as Error).message.slice(0, 150) };
    }
  };

  // What the My Shoots list would compute for upcoming, not-yet-photographed shoots.
  const upcoming = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: new Date() }, coverImageUrl: null },
    select: { title: true, lat: true, lng: true },
    orderBy: { shootDate: "asc" },
    take: 6,
  });

  const [noReferer, ourReferer] = await Promise.all([
    probe(),
    probe("https://realtour-pilot-hub.vercel.app/shoot"),
  ]);

  return NextResponse.json({
    keyConfigured: true,
    serverToServer: noReferer,
    browserStyleWithOurReferer: ourReferer,
    upcomingCards: upcoming.map((p) => ({
      street: p.title.split(",")[0],
      hasCoords: p.lat != null && p.lng != null,
      wouldRenderStreetView: p.lat != null && p.lng != null,
    })),
  });
}

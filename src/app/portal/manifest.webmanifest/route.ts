import { portalManifest } from "@/lib/portalApp";

// The client portal's web app manifest (Oct 22 2026), scoped to /portal and
// opening /portal/me. A route handler rather than app/manifest.ts because that
// file convention is root-only and would be linked from every hub page; see
// lib/portalApp for the whole story. Public like the rest of /portal
// (lib/publicRoutes). Nothing in it is per-person, so it is the same for all.
export function GET() {
  return new Response(JSON.stringify(portalManifest()), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

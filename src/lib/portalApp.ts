import type { Metadata, MetadataRoute, Viewport } from "next";

// ---------------------------------------------------------------------------
// THE PORTAL AS A HOME SCREEN APP (Oct 22 2026). Jordan: "Clients need an easy
// way to access the portal without having to log in every time or look for a
// link in their email."
//
// Next's manifest FILE convention (app/manifest.ts) lives at the root of app/
// only, and Next links it from every page: every hub screen would advertise
// itself as the client portal app. So the portal's manifest is a route handler
// under /portal (app/portal/manifest.webmanifest/route.ts, the documented
// non-UI route pattern) and only the signed-in portal pages link it, through
// the metadata below. Its scope is /portal/ and it opens /portal/me: the
// year-long client session (lib/auth/clientSession) is what makes the icon
// open signed in. The shared-link page (/portal/<token>) links no manifest, so
// a home screen icon made there keeps that page's own address.
//
// Colours are the portal's brand tokens (globals.css .portal-light: --brand
// #d95816, --background #f5f5f4). Icons are the brand mark on a white tile
// (public/brand/app-icon-192.png, -512.png, apple-touch-icon.png at 180),
// with the mark inside the maskable safe zone so Android may crop to a circle.
// ---------------------------------------------------------------------------

export const PORTAL_APP = {
  name: "Realtour Pilot",
  shortName: "Realtour Pilot",
  description: "Your content program with Realtour Pilot: videos to review, scripts, filming and messages.",
  manifestPath: "/portal/manifest.webmanifest",
  startUrl: "/portal/me",
  scope: "/portal/",
  themeColor: "#d95816",
  backgroundColor: "#f5f5f4",
  icons: [
    { src: "/brand/app-icon-192.png", sizes: "192x192" },
    { src: "/brand/app-icon-512.png", sizes: "512x512" },
  ],
  appleTouchIcon: { src: "/brand/apple-touch-icon.png", sizes: "180x180" },
} as const;

export function portalManifest(): MetadataRoute.Manifest {
  return {
    id: PORTAL_APP.startUrl,
    name: PORTAL_APP.name,
    short_name: PORTAL_APP.shortName,
    description: PORTAL_APP.description,
    start_url: PORTAL_APP.startUrl,
    scope: PORTAL_APP.scope,
    display: "standalone",
    orientation: "portrait",
    theme_color: PORTAL_APP.themeColor,
    background_color: PORTAL_APP.backgroundColor,
    icons: PORTAL_APP.icons.flatMap((i) => [
      { src: i.src, sizes: i.sizes, type: "image/png", purpose: "any" as const },
      { src: i.src, sizes: i.sizes, type: "image/png", purpose: "maskable" as const },
    ]),
  };
}

/** For the signed-in portal pages: the manifest link and the Apple web app tags
 *  (apple-mobile-web-app-capable / -title / -status-bar-style, the touch icon). */
export const portalAppMetadata = {
  manifest: PORTAL_APP.manifestPath,
  appleWebApp: { capable: true, title: PORTAL_APP.shortName, statusBarStyle: "default" },
  icons: { apple: [{ url: PORTAL_APP.appleTouchIcon.src, sizes: PORTAL_APP.appleTouchIcon.sizes, type: "image/png" }] },
  // Next 16 writes `capable` as the generic mobile-web-app-capable tag; older
  // iPhones read only the Apple-prefixed one, so it is written out as well.
  other: { "apple-mobile-web-app-capable": "yes" },
} satisfies Metadata;

export const portalAppViewport: Viewport = { themeColor: PORTAL_APP.themeColor };

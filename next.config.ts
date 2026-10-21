import type { NextConfig } from "next";
import path from "path";

// ---------------------------------------------------------------------------
// ONE ADDRESS. The hub lives at hub.realtourpilot.com (custom domain, Sep 1
// 2026), but the old Vercel alias is still in bookmarks, in delivered texts and
// in Slack links, and the team is being onboarded this week — two addresses
// means two sets of cookies, two "which one is the real one?" questions, and
// screenshots nobody can act on. Anything that lands on the old host is bounced
// to the real one.
//
// WHY next.config redirects and not the auth proxy (src/proxy.ts):
// Next's routing order is headers → next.config redirects → proxy → filesystem,
// so this fires BEFORE the login gate ever runs. It cannot be broken by the
// gate, it cannot break the gate, and it costs zero proxy invocations. Doing it
// in the proxy would put host rewriting inside the file that decides who may
// see what — the last place to add a second job.
//
// The host is matched EXACTLY (Next anchors a `has` value as ^…$), so it hits
// only the production alias. Preview deployments and the per-deploy URLs
// (realtour-pilot-hub-<hash>-<team>.vercel.app) are untouched — Vercel's own
// build/deployment checks talk to those, and a wildcard *.vercel.app rule would
// have redirected every one of them away from the deployment being checked.
//
// CARVE-OUTS — machine callers still pointed at the old host, which must keep
// answering there until each one is repointed by hand:
//   · /api/webhooks/*  OpenPhone (Quo), Aryeo, Slack, Script Studio. Their
//     payloads are signed and most senders grade a 3xx as a failed delivery
//     rather than following it — redirecting these silently drops real events.
//   · /api/cron/*      Vercel's scheduler invokes cron paths on the deployment's
//     own hostname and marks a non-2xx run failed.
// (/api/health was carved out too, for a probe route that never existed; it
// was dropped Oct 20 2026, audit H25, so nothing unbuilt stays on the old host.)
//
// 307, not 308: a permanent redirect is cached in every browser forever, and
// the old host still has a job to do (above) while providers are repointed.
// Flip `permanent: true` once nothing points at the old host any more.
// ---------------------------------------------------------------------------
const OLD_HOST = "realtour-pilot-hub\\.vercel\\.app"; // regex — Next anchors it ^…$
const NEW_ORIGIN = "https://hub.realtourpilot.com";
// Prefixes that stay on the old host. Written as a negative lookahead on the
// captured path, because `has`/`missing` can only test host/header/cookie/query
// — never the path.
const STAYS_ON_OLD_HOST = "api/webhooks|api/cron";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder so the bundler ignores the stray
  // package-lock.json that lives in the home directory.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Ask-the-Hub photo/file attachments ride through a server action as base64;
  // the 1MB default would reject a single phone photo.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
  // Old Vercel alias → the real host. See the note at the top of this file.
  // `/:path(…)` matches the bare "/" too (an empty capture), so a bookmarked
  // root lands on the new home page; the query string rides along automatically.
  async redirects() {
    // RETIRED ADDRESSES (Oct 20 2026, audit H18). Each was a page whose only
    // job was to redirect, so every old link cost a server render and the auth
    // gate's run before the hop. These answer before either. The incoming
    // query string rides along, and a key the destination sets (tab, view)
    // wins over the same key in the old link, exactly as the pages did. Only
    // the exact path matches (/team/<id>, /people/capacity and /ops/* pages are
    // untouched). The role-aware doors (/ops/requests, /ops/scheduling,
    // /ops/old) stay pages: where they send someone depends on who is asking.
    // 307, not 308, for the reason given above.
    const retired: [source: string, destination: string][] = [
      ["/today", "/tasks?tab=today"],
      ["/queue", "/tasks?tab=board"],
      ["/history", "/tasks?tab=done"],
      ["/team", "/users?tab=team"],
      ["/people", "/users?tab=team"],
      ["/map", "/schedule?view=map"],
      ["/billing", "/sales?tab=unpaid"],
      ["/payouts", "/sales?tab=payroll"],
      ["/texts", "/communications?tab=outbox"],
      ["/pipeline", "/jobs"],
      ["/ops", "/"],
      ["/ops/messages", "/communications"],
      ["/ops/video-delivery", "/review"],
    ];
    return [
      {
        source: `/:path((?!${STAYS_ON_OLD_HOST}).*)`,
        has: [{ type: "host", value: OLD_HOST }],
        destination: `${NEW_ORIGIN}/:path`,
        permanent: false, // 307 — see the note above before making this 308
      },
      ...retired.map(([source, destination]) => ({ source, destination, permanent: false })),
    ];
  },
  // Baseline security headers (the app sets auth cookies + proxies media).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;

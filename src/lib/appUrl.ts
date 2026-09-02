/**
 * The hub's public origin, for every absolute link the app hands out (client
 * portal links, payday + digest texts, Slack deep links, OAuth redirects).
 *
 * One place, one order: NEXT_PUBLIC_APP_URL (set per environment on Vercel)
 * → APP_URL → the deployment's own VERCEL_URL → localhost. Before Sep 1 2026
 * six call sites carried the literal "realtour-pilot-hub.vercel.app" as their
 * fallback and one had no env override at all — moving to hub.realtourpilot.com
 * would have left texts pointing at the old host.
 *
 * NEXT_PUBLIC_* is inlined at BUILD time on Vercel: changing it in the
 * dashboard takes effect on the next deploy, not immediately.
 */
export function appBase(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * For OAuth round-trips: prefer the origin the request actually arrived on
 * (https only), so the hub keeps working on BOTH hub.realtourpilot.com and the
 * vercel.app host while the Google console lists both redirect URIs — a fixed
 * env value would have bounced every login on the other host.
 */
export function originOrBase(origin: string | null | undefined): string {
  return origin && /^https:\/\//.test(origin) ? origin.replace(/\/+$/, "") : appBase();
}

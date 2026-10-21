// Where next.config.ts's redirects send a request (Oct 20 2026, audit H18:
// the retired doors, /today, /ops, /pipeline and the rest, left their pages
// for next.config, which answers before the auth gate and any page).
//
// Read from the real config, and merged the way Next merges a redirect's
// query (node_modules/next/dist/shared/lib/router/utils/prepare-destination):
// the incoming query first, then the destination's own keys, which win.
// Only host-free rules are considered (the old-host rule needs a `has`).
// Returns null when no rule matches the path.

export async function configRedirect(pathname: string, query: Record<string, string> = {}): Promise<string | null> {
  const config = (await import("../../next.config")).default;
  const rules = config.redirects ? await config.redirects() : [];
  const rule = rules.find((r) => r.source === pathname && !r.has && !r.missing);
  if (!rule) return null;
  const dest = new URL(rule.destination, "http://drill.invalid");
  const merged: Record<string, string> = { ...query };
  dest.searchParams.forEach((value, key) => {
    merged[key] = value;
  });
  const search = new URLSearchParams(merged).toString();
  return `${dest.pathname}${search ? `?${search}` : ""}`;
}

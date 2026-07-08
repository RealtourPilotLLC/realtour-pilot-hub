import { redirect } from "next/navigation";

// The Map is now the Schedule page's "Map" view (Jordan: "the toolbar has too
// many things" — one Schedule, List | Map toggle). This route survives only so
// old links/bookmarks keep working; every query param is forwarded so deep links
// behave identically. The route directory keeps its actions.ts — ProjectMap
// still imports the weather/drive-time server actions from @/app/map/actions.
export default async function MapRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ view: "map" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "view" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/schedule?${q.toString()}`);
}

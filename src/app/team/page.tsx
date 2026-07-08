import { redirect } from "next/navigation";

// The Team directory is now the People page's "Team" tab (Jordan: "the toolbar
// has too many things" — Team + Users merged into one People item). This route
// survives only so old links keep working: the comms "Team directory" link and
// each person's /team/[id] BackLink point at /team and hop through here. The
// /team/[id] detail pages are unaffected (this stub is only the bare index).
export default async function TeamRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "team" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/users?${q.toString()}`);
}

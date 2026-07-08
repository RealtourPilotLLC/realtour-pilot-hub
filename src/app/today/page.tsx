import { redirect } from "next/navigation";

// The Today feed is the Tasks hub's default tab now (Jordan: "today, daily
// tasks, and task history could all be combined"). This route survives only so
// old links keep working — every query param (?guided=1, ?focus=reply|check, …)
// is forwarded so deep links behave identically.
export default async function TodayRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "today" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/tasks?${q.toString()}`);
}

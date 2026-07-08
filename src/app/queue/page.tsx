import { redirect } from "next/navigation";

// Daily Tasks is the Tasks hub's Board tab now (Jordan: "today, daily tasks,
// and task history could all be combined"). This route survives only so old
// links keep working — every query param (?who=, ?task=<id> deep links from the
// morning brief / notifications, …) is forwarded so they behave identically.
export default async function QueueRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "board" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/tasks?${q.toString()}`);
}

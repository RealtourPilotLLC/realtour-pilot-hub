import { redirect } from "next/navigation";

// Task History is the Tasks hub's Done tab now (Jordan: "today, daily tasks,
// and task history could all be combined"). This route survives only so old
// links keep working — any query params are forwarded.
export default async function HistoryRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "done" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/tasks?${q.toString()}`);
}

import { redirect } from "next/navigation";
import { homeRecordHref } from "@/lib/homeRecordScope";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops ("Shoots and exceptions") MOVED ONTO THE DASHBOARD (Jordan, Oct 19
// 2026, night: "The home page should really be a dashboard to oversee
// everything going on"). Today's shoot cards are on "/" (#shoots), the jobs
// that are late are the dashboard's On time tile and Shoots in progress (and
// the Shoots page, /jobs), and the exceptions that matter now are its Needs
// attention now; the rest live on Photos and Videos. Old links, bookmarks and
// the test-records toggle land on the dashboard; the browser keeps an old
// link's #anchor across the hop, and the dashboard forwards the old checklist
// anchors ("#loops") to the list (lib/homeAnchors).
// ---------------------------------------------------------------------------

export default async function OpsMovedToDashboard(props: { searchParams?: Promise<{ test?: string | string[] }> }): Promise<never> {
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(homeRecordHref("/", sp?.test === "1"));
}

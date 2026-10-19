import { redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { checklistDoor } from "@/lib/opsHome";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/requests: a door, not a page, since Oct 19 2026 (evening). Jordan
// approved Special requests leaving the menu as its own screen: the open
// requests on jobs going out soon are a group on the daily checklist
// ("Special requests to check", Checked / Not needed on each line; its own
// page, /ops/checklist, since that night), and every open request is on its
// job's own page and counted on the dashboard. Old links, bells and Slack
// lines land on that group of the reader's list (Kyle's for the owner).
// The Checked / Done / Not needed actions stay in ./actions.ts.
// ---------------------------------------------------------------------------

export default async function SpecialRequestsDoor(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(homeRecordHref(checklistDoor("requests"), sp?.test === "1"));
}

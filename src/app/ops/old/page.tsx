import { redirect } from "next/navigation";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { checklistDoor, homeRoleOf } from "@/lib/opsHome";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/old: a door, not a page, since Oct 19 2026 (evening). The old items are
// "From earlier days, still open" on Kyle's daily checklist (oldest first,
// Done / Not needed / New date; the rules are lib/taskAging's). The morning
// bell and digest links, and the "pushed 3 times" bell (?who=all) land:
//   · Kyle (operations Home) on that group;
//   · Jordan on "What we're behind on" (each person's old items);
//   · the review seat on the task board.
// The New date action stays in ./actions.ts.
// ---------------------------------------------------------------------------

export default async function OldItemsDoor(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/old");
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(homeRecordHref(checklistDoor(await homeRoleOf(me), "earlier"), sp?.test === "1"));
}

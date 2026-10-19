import { redirect } from "next/navigation";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { checklistDoor } from "@/lib/opsHome";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/old: a door, not a page, since Oct 19 2026 (evening). The old items are
// "From earlier days, still open" on the daily checklist (oldest first,
// Done / Not needed / New date; the rules are lib/taskAging's), its own page
// since Oct 19 2026 (night): the morning bell and digest links land on that
// group of the reader's list (Kyle's for the owner); the "pushed 3 times"
// bell (?who=all) is about anyone's item and opens everyone's tasks.
// The New date action stays in ./actions.ts.
// ---------------------------------------------------------------------------

export default async function OldItemsDoor(props: { searchParams?: Promise<{ test?: string | string[]; who?: string | string[] }> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/old");
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(homeRecordHref(checklistDoor("earlier", { everyone: sp?.who === "all" }), sp?.test === "1"));
}

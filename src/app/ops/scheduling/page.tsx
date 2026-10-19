import { redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { checklistDoor } from "@/lib/opsHome";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/scheduling: a door, not a page, since Oct 19 2026 (evening). The
// clients' scheduling asks and tomorrow's shoots with no confirmation sent
// are the "Scheduling to handle" group on the daily checklist (Done / Not
// needed on each line; its own page, /ops/checklist, since that night). Old
// links land there (Kyle's list for the owner).
// ---------------------------------------------------------------------------

export default async function SchedulingDoor(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(homeRecordHref(checklistDoor("scheduling"), sp?.test === "1"));
}

import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { developmentSeat } from "@/lib/teamDevelopment";
import { buildCreativeDesk } from "@/lib/creativeDesk";
import { CreativeDesk } from "@/components/creativeDesk/CreativeDesk";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// PRODUCTION, IN FULL (Oct 27 2026, Jordan: "it should show only the first
// two, like the example, then have a button to open a full view"). The view
// behind the creative manager's Production card: every shoot of his for the
// week ahead, every handoff of his to finish, and the team's handoffs he
// supervises, each row with its actions. The owner and the creative manager
// only (no menu door; the page guards itself, like /development). A preview
// reads as the person previewed and writes nothing.
// ---------------------------------------------------------------------------

export default async function ProductionPage(props: { searchParams?: Promise<{ test?: string }> }) {
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), props?.searchParams ?? Promise.resolve(undefined)]);
  if (!me && authEnforced()) redirect("/login?next=%2Fproduction");
  if (me && !(await developmentSeat(me))) redirect("/");
  const viewer = me ?? { id: null, name: "Owner", email: null, role: "OWNER", realRole: "OWNER", teamMemberId: null, impersonating: false };
  const includeTest = sp?.test === "1";
  const desk = await buildCreativeDesk(viewer, { includeTest, only: "production" });
  return (
    <div>
      <PageHeader eyebrow="Production" title="Production" subtitle="Your shoots, the handoffs to finish, and the team's handoffs you supervise." />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <CreativeDesk desk={desk} mode="production" includeTest={includeTest} />
      </div>
    </div>
  );
}

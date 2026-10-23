import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { developmentSeat } from "@/lib/teamDevelopment";
import { buildCreativeDesk } from "@/lib/creativeDesk";
import { CreativeDesk } from "@/components/creativeDesk/CreativeDesk";
import type { Panel } from "@/components/creativeDesk/CreativePanels";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TEAM DEVELOPMENT, IN FULL (Oct 23 2026): the "View all" behind the creative
// manager's dashboard sections D, E and G, and where Jordan's decision task
// for a readiness recommendation points (?assessment=<id>). Personnel
// development: the owner and the creative manager only (no menu door; the
// page guards itself, like /coaching). A preview reads as the person
// previewed and writes nothing.
// ---------------------------------------------------------------------------

const ID = /^[a-z0-9]{10,40}$/i;

export default async function DevelopmentPage(props: { searchParams?: Promise<{ assessment?: string; item?: string; test?: string }> }) {
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), props?.searchParams ?? Promise.resolve(undefined)]);
  if (!me && authEnforced()) redirect("/login?next=%2Fdevelopment");
  if (me && !(await developmentSeat(me))) redirect("/");
  const viewer = me ?? { id: null, name: "Owner", email: null, role: "OWNER", realRole: "OWNER", teamMemberId: null, impersonating: false };
  const includeTest = sp?.test === "1";
  const desk = await buildCreativeDesk(viewer, { includeTest, only: "development" });
  const initialPanel: Panel | null = sp?.assessment && ID.test(sp.assessment) ? { kind: "readiness", id: sp.assessment } : sp?.item && ID.test(sp.item) ? { kind: "dev-item", id: sp.item } : null;
  return (
    <div>
      <PageHeader eyebrow="Team" title="Team development" subtitle="Coaching, readiness assessments and process improvements. The creative manager assesses and recommends; Jordan decides staffing and pay." />
      <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
        <CreativeDesk desk={desk} mode="development" includeTest={includeTest} initialPanel={initialPanel} />
      </div>
    </div>
  );
}

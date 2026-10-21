import { SettingsPanel } from "@/components/content/SettingsPanel";
import { PortalAccessCard } from "@/components/content/PortalAccessCard";
import { EnrollmentControls } from "@/components/content/Workspace";
import { ProgramStyleCard } from "@/components/content/ProgramStyleCard";
import { loadSettingsTab } from "../workspaceData";
import { videoStyleFromOverrides } from "@/lib/contentPolicy/prompts";
import type { TabCtx } from "./shared";
import { CreativeGuardEditor } from "@/components/clientCare/CreativeGuardEditor";
import { EntitlementsCard } from "@/components/clientCare/EntitlementsCard";
import { ClientIssuesCard } from "@/components/clientCare/ClientIssuesCard";

// ---------------------------------------------------------------------------
// SETTINGS (UI-02) — package and allowance, status, the call requirement, who
// owns what (the internal notification routing), overrides, billing read-only,
// and the client's account and team (the portal access card, self-gated to
// the owner). Mandatory reminder cadence is not a client setting and is not
// offered here (Jordan's rule).
//
// Kyle keeps pause / end / package change (Jordan, Sep 24): EnrollmentControls
// records them through the same ledgered setters the owner's panel uses, and
// every change lands in the history at the bottom of this tab.
// ---------------------------------------------------------------------------

export async function SettingsTab({ ctx }: { ctx: TabCtx }) {
  const d = await loadSettingsTab(ctx.id, ctx.ownerEyes);
  if (!d) return <p className="text-sm text-warning">Couldn&rsquo;t load the settings — refresh to try again.</p>;
  const s = d.settings;
  // Oct 15 2026 (Marcee McMullen's call): what this client is owed beyond the
  // package, their complaints, and their style guardrails — the same cards as
  // the client page, here where the program is run.
  const care = ctx.staffEyes
    ? await Promise.all([
        import("@/lib/entitlements").then((m) => m.entitlementSummary(ctx.id)).catch(() => null),
        import("@/lib/clientIssues").then((m) => m.listClientIssues({ clientId: ctx.client.id, scrubMoney: !ctx.ownerEyes })).catch(() => []),
        import("@/lib/prisma").then(({ prisma }) => prisma.contentEnrollment.findUnique({ where: { id: ctx.id }, select: { overridesJson: true } })).then(async (e) => (await import("@/lib/creativeGuardCore")).creativeGuardFromOverrides(e?.overridesJson ?? null)).catch(() => null),
        import("@/lib/prisma").then(({ prisma }) => prisma.project.findMany({ where: { clientId: ctx.client.id }, orderBy: { shootDate: "desc" }, take: 40, select: { id: true, title: true } })).catch(() => []),
      ])
    : null;
  return (
    <div className="space-y-5">
      {care && <ClientIssuesCard clientId={ctx.client.id} issues={care[1]} canEdit projects={care[3]} />}
      {care?.[0] && <EntitlementsCard summary={care[0]} canEdit />}
      {care?.[2] && <CreativeGuardEditor enrollmentId={ctx.id} guard={care[2]} canEdit />}
      {/* Oct 8 2026: strategy calls on/off and "we show up and shoot" — owner/admin. */}
      {/* Oct 13 2026: + video style, Direct-to-camera or Skits (overridesJson.videoStyle). */}
      {/* Oct 21 2026: the ONE call-mode control (Required · Optional · Off) is Program style's. */}
      <ProgramStyleCard enrollmentId={ctx.id} callMode={s.callMode} callModeExplicit={s.callModeExplicit} noCallEligible={s.noCallEligible} clientPlanned={s.clientSuppliesTopics} videoStyle={videoStyleFromOverrides(s.overrides)} canEdit={ctx.staffEyes} />
      {/* ONE package and status card for Jordan and Kyle alike (Oct 21 2026,
          audit D13), through the ledgered staff actions both already passed. */}
      {ctx.staffEyes && (
        <EnrollmentControls
          enrollmentId={ctx.id} pkg={s.pkg} status={s.status} videosPerMonth={s.videosPerMonth} sessionsPerMonth={s.sessionsPerMonth}
          nextTerms={s.nextTerms} packages={s.packages} currentMonthKey={s.currentMonthKey} currentMonthLabel={s.currentMonthLabel}
          nextMonthKey={s.nextMonthKey} nextMonthLabel={s.nextMonthLabel} currentMonthOwed={s.currentMonthOwed}
        />
      )}
      {/* The card above IS the package and status control; the panel shows
          them read-only only to a viewer who cannot change them. */}
      <SettingsPanel s={s} billing={d.billing} owners={d.owners} history={d.history} staff={d.staff} isOwner={ctx.ownerEyes}
        packageHandledAbove={ctx.staffEyes} />
      {/* W1-A: link status, seats and visits — self-guarded to OWNER. */}
      <PortalAccessCard enrollmentId={ctx.id} />
    </div>
  );
}

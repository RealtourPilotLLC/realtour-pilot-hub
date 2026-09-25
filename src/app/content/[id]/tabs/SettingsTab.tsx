import { SettingsPanel } from "@/components/content/SettingsPanel";
import { PortalAccessCard } from "@/components/content/PortalAccessCard";
import { EnrollmentControls } from "@/components/content/Workspace";
import { loadSettingsTab } from "../workspaceData";
import type { TabCtx } from "./shared";

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
  return (
    <div className="space-y-5">
      {ctx.staffEyes && (
        <EnrollmentControls
          enrollmentId={ctx.id} pkg={s.pkg} status={s.status} videosPerMonth={s.videosPerMonth} sessionsPerMonth={s.sessionsPerMonth}
          nextTerms={s.nextTerms} packages={s.packages} currentMonthKey={s.currentMonthKey} currentMonthLabel={s.currentMonthLabel}
          nextMonthKey={s.nextMonthKey} nextMonthLabel={s.nextMonthLabel} currentMonthOwed={s.currentMonthOwed}
          // The owner's SettingsPanel below already carries package and status.
          packageAndStatus={!ctx.ownerEyes}
        />
      )}
      {/* For Kyle the card above IS the package and status control — the panel
          must not repeat them below as "Only Jordan changes a package". */}
      <SettingsPanel s={s} billing={d.billing} owners={d.owners} history={d.history} staff={d.staff} isOwner={ctx.ownerEyes}
        packageHandledAbove={ctx.staffEyes && !ctx.ownerEyes} />
      {/* W1-A: link status, seats and visits — self-guarded to OWNER. */}
      <PortalAccessCard enrollmentId={ctx.id} />
    </div>
  );
}

import { SettingsPanel } from "@/components/content/SettingsPanel";
import { PortalAccessCard } from "@/components/content/PortalAccessCard";
import { EnrollmentControls } from "@/components/content/Workspace";
import { ProgramStyleCard } from "@/components/content/ProgramStyleCard";
import { loadSettingsTab } from "../workspaceData";
import { videoStyleFromOverrides, skitsPerMonthFromOverrides, skitCastFromOverrides } from "@/lib/contentPolicy/videoFormat";
import type { TabCtx } from "./shared";
import { CreativeGuardEditor } from "@/components/clientCare/CreativeGuardEditor";
import { EntitlementsCard } from "@/components/clientCare/EntitlementsCard";
import { ClientIssuesCard } from "@/components/clientCare/ClientIssuesCard";
import { ProgramEmailsCard } from "@/components/content/ProgramEmailsCard";
import { programEmailsState } from "@/lib/portalAccess";

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
  // Oct 27 2026 (Jordan: "Settings, I don't know why all of these are in
  // here. Doesn't make sense, but record a complaint, I think they should
  // automatically be recorded"): the same cards, in four groups with a line
  // each saying what the group is for. The program's own setup comes first
  // (he read Program style, package, owners and timing as right); what we
  // agreed with the client next; complaints after, with adding one by hand a
  // quiet secondary link; the portal last.
  const portalEmails = ctx.ownerEyes ? await programEmailsState(ctx.id).catch(() => null) : null;
  return (
    <div className="space-y-8">
      <SettingsGroup title="How we run their program" hint="Strategy calls, video style, the package, who on the team handles what, and timing.">
        {/* Oct 8 2026: strategy calls on/off and "we show up and shoot" — owner/admin. */}
        {/* Oct 13 2026: + video style, Direct-to-camera or Skits (overridesJson.videoStyle). Oct 22 2026: or Mix, and the skit cast. */}
        {/* Oct 21 2026: the ONE call-mode control (Required · Optional · Off) is Program style's. */}
        <ProgramStyleCard enrollmentId={ctx.id} callMode={s.callMode} callModeExplicit={s.callModeExplicit} noCallEligible={s.noCallEligible} clientPlanned={s.clientSuppliesTopics} videoStyle={videoStyleFromOverrides(s.overrides)} skitsPerMonth={skitsPerMonthFromOverrides(s.overrides)} cast={skitCastFromOverrides(s.overrides)} canEdit={ctx.staffEyes} />
        {/* ONE package and status card for Jordan and Kyle alike (Oct 21 2026,
            audit D13), through the ledgered staff actions both already passed. */}
        {ctx.officeEyes && (
          <EnrollmentControls
            enrollmentId={ctx.id} pkg={s.pkg} status={s.status} videosPerMonth={s.videosPerMonth} sessionsPerMonth={s.sessionsPerMonth}
            nextTerms={s.nextTerms} packages={s.packages} currentMonthKey={s.currentMonthKey} currentMonthLabel={s.currentMonthLabel}
            nextMonthKey={s.nextMonthKey} nextMonthLabel={s.nextMonthLabel} currentMonthOwed={s.currentMonthOwed}
          />
        )}
        {/* The card above IS the package and status control; the panel shows
            them read-only only to a viewer who cannot change them. */}
        <SettingsPanel s={s} billing={d.billing} owners={d.owners} history={d.history} staff={d.staff} isOwner={ctx.ownerEyes}
          packageHandledAbove={ctx.officeEyes} />
      </SettingsGroup>

      {/* The complaint record and the entitlement ledger are the office's to
          write (clientCareActions); the creative manager reads them (Oct 21 2026). */}
      {care && (care[0] || care[2]) && (
        <SettingsGroup title="What we agreed with them" hint="Their term, anything extra we owe them beyond the package, and what they asked us to stop doing.">
          {care[0] && <EntitlementsCard summary={care[0]} canEdit={ctx.officeEyes} />}
          {care[2] && <CreativeGuardEditor enrollmentId={ctx.id} guard={care[2]} canEdit />}
        </SettingsGroup>
      )}

      {care && (care[1].length > 0 || ctx.officeEyes) && (
        <SettingsGroup title="Complaints" hint="Anything the client was unhappy about, what we did and whether they are satisfied now.">
          <ClientIssuesCard clientId={ctx.client.id} issues={care[1]} canEdit={ctx.officeEyes} projects={care[3]} addManually />
        </SettingsGroup>
      )}

      {/* Both cards are the owner's (PortalAccessCard checks for itself), so the group is too. */}
      {ctx.ownerEyes && (
        <SettingsGroup title="Their portal" hint="Who can sign in to the client portal, and the emails the hub sends them.">
          {/* W1-A: link status, seats and visits — self-guarded to OWNER. */}
          <PortalAccessCard enrollmentId={ctx.id} />
          {/* Oct 21 2026: sign-in emails, "Also email" copies, resend the welcome. Owner only. */}
          <ProgramEmailsCard enrollmentId={ctx.id} initial={portalEmails} />
        </SettingsGroup>
      )}
    </div>
  );
}

/** Oct 27 2026: one heading and one plain line over each group of cards. */
function SettingsGroup({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="border-b border-border pb-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-ui-secondary text-muted">{hint}</p>
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

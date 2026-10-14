import { redirect } from "next/navigation";
import { SlidersHorizontal, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { etDayKey } from "@/lib/datetime";
import { photoDeliverySettings } from "@/lib/photoDelivery/settings";
import { GlobalStrip } from "@/components/photoDelivery/GlobalStrip";
import { SettingsForm } from "@/components/photoDelivery/SettingsForm";
import { ClientProfiles } from "@/components/photoDelivery/ClientProfiles";
import { loadClientProfiles, loadStrip, loadViewer, ruleOptions } from "../data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/settings: OWNER ONLY (docs/photo-delivery/01 sections
// 9.1 and 14). The Photo Delivery switches and thresholds, each explained in
// plain words, and the per-client QC profiles (SLA, notes for QC, delivery
// message, rule overrides). Kyle is sent back to the queue. Every save goes
// through an owner-only server action as well.
// ---------------------------------------------------------------------------

export default async function PhotoDeliverySettingsPage() {
  await requirePageAccess("ops");
  const viewer = await loadViewer();
  if (!viewer) redirect("/login?next=/ops/photo-delivery/settings");
  if (!viewer.isOwner) redirect(viewer.role === "ADMIN" ? "/ops/photo-delivery" : homeFor(viewer.role));

  const [strip, settings, profiles] = await Promise.all([
    loadStrip(viewer),
    photoDeliverySettings(),
    loadClientProfiles().catch((e) => {
      console.error("[photo-delivery] client profiles failed", e);
      return null;
    }),
  ]);
  const qcFrom = settings.qcFrom ? new Date(settings.qcFrom) : null;

  return (
    <div>
      <div className="border-b border-border px-4 py-2 sm:px-6">
        <BackLink href="/ops/photo-delivery" label="Photo Delivery" />
      </div>
      <PageHeader eyebrow="Photo Delivery" title="Settings" subtitle="Owner only. What runs, what it may spend, and each client's QC preferences." />
      <div className="mx-auto max-w-5xl space-y-5 p-4 pb-16 sm:p-6">
        <GlobalStrip strip={strip} current="settings" />
        <Section icon={SlidersHorizontal} title="Switches and limits">
          <SettingsForm
            initial={{
              enabled: settings.enabled,
              qcEnabled: settings.qcEnabled,
              qcShadow: settings.qcShadow,
              fixRunnerEnabled: settings.fixRunnerEnabled,
              maxBuildPhase: settings.maxBuildPhase,
              autoFixZeroCredit: settings.autoFixZeroCredit,
              adminCreditCap: settings.adminCreditCap,
              dailyAutoCreditCap: settings.dailyAutoCreditCap,
              aryeoTags: settings.aryeoTags,
              p3AllPhotos: settings.p3AllPhotos,
              displayConfidenceFloor: Math.round(settings.displayConfidenceFloor * 100),
              maskPaddingPct: settings.maskPaddingPct,
              maskPaddingMinPx: settings.maskPaddingMinPx,
              minLongEdgePx: settings.minLongEdgePx,
              qcFromDay: qcFrom && !Number.isNaN(qcFrom.getTime()) ? etDayKey(qcFrom) : "",
              monthlyQcBudgetUsd: settings.monthlyQcBudgetUsd,
            }}
          />
          <p className="mt-4 border-t border-border pt-3 text-[13px] text-muted">The credit alert levels live on the Credits page.</p>
        </Section>
        <Section icon={Users} title="Client QC profiles" count={profiles?.length ?? null}>
          {profiles ? <ClientProfiles profiles={profiles} rules={ruleOptions()} /> : <p role="alert" className="text-sm text-warning">The client profiles could not be read. Refresh to try again.</p>}
        </Section>
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";
import { Brain, EyeOff, ListChecks, SlidersHorizontal, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { etDayKey, etMonthDayTime } from "@/lib/datetime";
import { houseRules } from "@/lib/photoDelivery/houseRules";
import { ruleById } from "@/lib/photoDelivery/registry";
import { SwitchedOffChecks } from "@/components/photoDelivery/SwitchedOffChecks";
import { photoDeliverySettings } from "@/lib/photoDelivery/settings";
import { fixPolicySummary, learnedRules, LEARN_DAYS, STRICT_CONFIDENCE } from "@/lib/photoDelivery/fixPolicy";
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

  const [strip, settings, profiles, off, learned] = await Promise.all([
    loadStrip(viewer),
    photoDeliverySettings(),
    loadClientProfiles().catch((e) => {
      console.error("[photo-delivery] client profiles failed", e);
      return null;
    }),
    houseRules().catch(() => []),
    learnedRules().catch(() => null),
  ]);
  const policy = fixPolicySummary(settings);
  const lessons = learned ? [...learned.values()].filter((l) => l.notThere + l.notWorth + l.wanted >= 2).sort((a, b) => Number(b.skip || b.strict) - Number(a.skip || a.strict) || b.notThere + b.notWorth - (a.notThere + a.notWorth)) : null;
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
              autoSubmit: settings.autoSubmit,
              freeCheck: settings.freeCheck,
              paidQcAuto: settings.paidQcAuto,
              autoFix: settings.autoFix,
              showAutohdrPhotos: settings.showAutohdrPhotos,
              aryeoPush: settings.aryeoPush,
              fixTargetUsd: settings.fixTargetUsd,
              fixMaxUsd: settings.fixMaxUsd,
            }}
          />
          <p className="mt-4 border-t border-border pt-3 text-[13px] text-muted">The credit alert levels live on the Credits page.</p>
        </Section>
        <Section icon={ListChecks} title="How automatic fixes are chosen">
          <p className="mb-3 text-[13px] text-muted">What the hub fixes on its own, what it never does, and the free checks around every fix. Each finding on a job also says why it was or was not fixed.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {policy.map((g) => (
              <div key={g.title}>
                <h3 className="text-sm font-semibold">{g.title}</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-muted">
                  {g.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
        <Section icon={Brain} title="What the hub learned from your calls" count={lessons?.length ?? null}>
          <p className="mb-3 text-[13px] text-muted">
            The last {LEARN_DAYS} days of people&rsquo;s calls on each check. &ldquo;Not there&rdquo; means the check got it wrong; &ldquo;not worth fixing&rdquo; means it was right but nobody wanted it fixed. Skip all and the hub&rsquo;s own calls do not count.
          </p>
          {!lessons ? (
            <p role="alert" className="text-sm text-warning">This could not be read. Refresh to try again.</p>
          ) : lessons.length === 0 ? (
            <p className="text-sm text-muted">Not enough calls yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-[13px]">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Check</th>
                    <th className="py-1 pr-3 text-right font-medium">Not there</th>
                    <th className="py-1 pr-3 text-right font-medium">Not worth fixing</th>
                    <th className="py-1 pr-3 text-right font-medium">Fixed</th>
                    <th className="py-1 font-medium">What changes</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {lessons.map((l) => (
                    <tr key={l.ruleId} className="border-t border-border">
                      <td className="py-1.5 pr-3">{ruleById(l.ruleId)?.shortLabel ?? l.ruleId}</td>
                      <td className="py-1.5 pr-3 text-right">{l.notThere}</td>
                      <td className="py-1.5 pr-3 text-right">{l.notWorth}</td>
                      <td className="py-1.5 pr-3 text-right">{l.wanted}</td>
                      <td className="py-1.5 text-muted">
                        {[l.skip ? "No longer fixed on its own" : null, l.strict ? `Fixed on its own only when ${Math.round(STRICT_CONFIDENCE * 100)}% sure` : null].filter(Boolean).join("; ") || "Nothing yet"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section icon={EyeOff} title="Checks switched off" count={off.length}>
          <p className="mb-3 text-[13px] text-muted">Not checked on any shoot, by the paid QC or the free photo check, and not shown on jobs.</p>
          <SwitchedOffChecks rules={off.map((r) => ({ ruleId: r.ruleId, label: ruleById(r.ruleId)?.shortLabel ?? r.ruleId, reason: r.reason, by: r.by, when: etMonthDayTime(r.at) }))} />
        </Section>
        <Section icon={Users} title="Client QC profiles" count={profiles?.length ?? null}>
          {profiles ? <ClientProfiles profiles={profiles} rules={ruleOptions()} /> : <p role="alert" className="text-sm text-warning">The client profiles could not be read. Refresh to try again.</p>}
        </Section>
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";
import { Brain, ChevronDown, EyeOff, ListChecks, SlidersHorizontal, Users } from "lucide-react";
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
import { prisma } from "@/lib/prisma";
import { fixPolicySummary, learnedRules, LEARN_DAYS, STRICT_CONFIDENCE } from "@/lib/photoDelivery/fixPolicy";
import { GlobalStrip } from "@/components/photoDelivery/GlobalStrip";
import { SettingsForm } from "@/components/photoDelivery/SettingsForm";
import { ClientProfiles } from "@/components/photoDelivery/ClientProfiles";
import { loadClientProfiles, loadStrip, loadViewer, ruleOptions } from "../data";

export const dynamic = "force-dynamic";

const summary = "flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-5 py-3 text-base font-semibold [&::-webkit-details-marker]:hidden";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/settings: OWNER ONLY (docs/photo-delivery/01 sections
// 9.1 and 14). What the hub does by itself (Advanced closed), the checks
// switched off, the per-client profiles (notes for QC, delivery message, rule
// overrides), then the two explainers, closed. Kyle is sent back to the
// queue. Every save goes through an owner-only server action as well.
// ---------------------------------------------------------------------------

export default async function PhotoDeliverySettingsPage() {
  await requirePageAccess("ops");
  const viewer = await loadViewer();
  if (!viewer) redirect("/login?next=/ops/photo-delivery/settings");
  if (!viewer.isOwner) redirect(viewer.role === "ADMIN" ? "/ops/photo-delivery" : homeFor(viewer.role));

  const [strip, settings, profiles, off, learned, asIsClients] = await Promise.all([
    loadStrip(viewer),
    photoDeliverySettings(),
    loadClientProfiles().catch((e) => {
      console.error("[photo-delivery] client profiles failed", e);
      return null;
    }),
    houseRules().catch(() => []),
    learnedRules().catch(() => null),
    // Oct 15 2026: the as-is clients by name (prep.ts).
    photoDeliverySettings().then((s) => (s.asIsClientIds.length ? prisma.client.findMany({ where: { id: { in: s.asIsClientIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [])).catch(() => []),
  ]);
  const policy = fixPolicySummary(settings);
  const lessons = learned ? [...learned.values()].filter((l) => l.notThere + l.notWorth + l.wanted >= 2).sort((a, b) => Number(b.skip || b.strict) - Number(a.skip || a.strict) || b.notThere + b.notWorth - (a.notThere + a.notWorth)) : null;
  const qcFrom = settings.qcFrom ? new Date(settings.qcFrom) : null;

  return (
    <div>
      <div className="border-b border-border px-4 py-2 sm:px-6">
        <BackLink href="/ops/photo-delivery" label="Photo Delivery" />
      </div>
      <PageHeader eyebrow="Photo Delivery" title="Settings" subtitle="Owner only. What runs by itself, what it may spend, and each client's preferences. The credit alert levels are on the Credits page." />
      <div className="mx-auto max-w-5xl space-y-5 p-4 pb-16 sm:p-6">
        <GlobalStrip strip={strip} current="settings" />
        <Section icon={SlidersHorizontal} title="What the hub does by itself" className="overflow-visible">
          <SettingsForm
            initial={{
              enabled: settings.enabled,
              autoSubmit: settings.autoSubmit,
              showAutohdrPhotos: settings.showAutohdrPhotos,
              freeCheck: settings.freeCheck,
              fixes: !settings.fixRunnerEnabled ? "off" : settings.autoFix ? "auto" : "approve",
              fixTargetUsd: settings.fixTargetUsd,
              fixMaxUsd: settings.fixMaxUsd,
              autoFixDailyMaxCredits: settings.autoFixDailyMaxCredits,
              aryeoPush: settings.aryeoPush,
              sameDayAutoDeliver: settings.sameDayAutoDeliver,
              paidQc: !settings.qcEnabled ? "off" : settings.paidQcAuto ? "auto" : "press",
              monthlyQcBudgetUsd: settings.monthlyQcBudgetUsd,
              maxBuildPhase: settings.maxBuildPhase,
              qcShadow: settings.qcShadow,
              qcFromDay: qcFrom && !Number.isNaN(qcFrom.getTime()) ? etDayKey(qcFrom) : "",
              displayConfidenceFloor: Math.round(settings.displayConfidenceFloor * 100),
              minLongEdgePx: settings.minLongEdgePx,
              adminCreditCap: settings.adminCreditCap,
              warpCv: settings.warpCv,
              warpCompareOriginal: settings.warpCompareOriginal,
              freeCoverage: settings.freeCoverage,
              afterDeliveryCheck: settings.afterDeliveryCheck,
              asIsClients,
            }}
          />
        </Section>
        <Section icon={EyeOff} title="Checks switched off" count={off.length}>
          <p className="mb-3 text-ui-status text-muted">Not checked on any shoot, by the paid QC or the free photo check, and not shown on jobs.</p>
          <SwitchedOffChecks rules={off.map((r) => ({ ruleId: r.ruleId, label: ruleById(r.ruleId)?.shortLabel ?? r.ruleId, reason: r.reason, by: r.by, when: etMonthDayTime(r.at) }))} />
        </Section>
        <Section icon={Users} title="Clients" count={profiles?.length ?? null}>
          {profiles ? <ClientProfiles profiles={profiles} rules={ruleOptions()} /> : <p role="alert" className="text-sm text-warning">The client profiles could not be read. Refresh to try again.</p>}
        </Section>
        <details className="panel-shadow group rounded-2xl border border-border bg-surface">
          <summary className={summary}>
            <ListChecks aria-hidden className="size-4 text-muted" /> How automatic fixes are chosen
            <ChevronDown aria-hidden className="ml-auto size-4 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="border-t border-border px-5 py-4">
            <p className="mb-3 text-ui-status text-muted">What the hub fixes on its own, what it never does, and the free checks around every fix. Each finding on a job also says why it was or was not fixed.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {policy.map((g) => (
                <div key={g.title}>
                  <h3 className="text-sm font-semibold">{g.title}</h3>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ui-status text-muted">
                    {g.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </details>
        <details className="panel-shadow group rounded-2xl border border-border bg-surface">
          <summary className={summary}>
            <Brain aria-hidden className="size-4 text-muted" /> What the hub learned from your calls
            {lessons && <span className="rounded-full bg-surface-2 px-2 text-ui-status font-medium text-muted">{lessons.length}</span>}
            <ChevronDown aria-hidden className="ml-auto size-4 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="border-t border-border px-5 py-4">
            <p className="mb-3 text-ui-status text-muted">
              The last {LEARN_DAYS} days of people&rsquo;s calls on each check. &ldquo;Not there&rdquo; means the check got it wrong; &ldquo;not worth fixing&rdquo; means it was right but nobody wanted it fixed. Skip all and the hub&rsquo;s own calls do not count.
            </p>
            {!lessons ? (
              <p role="alert" className="text-sm text-warning">This could not be read. Refresh to try again.</p>
            ) : lessons.length === 0 ? (
              <p className="text-sm text-muted">Not enough calls yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-ui-status">
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
          </div>
        </details>
      </div>
    </div>
  );
}

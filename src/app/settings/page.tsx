import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SlidersHorizontal, Route, Package, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { RoutingRulesForm } from "@/components/settings/RoutingRulesForm";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { editorRouting } from "@/lib/settings";

export const dynamic = "force-dynamic";

// SETTINGS — the rules the business runs on, editable by Jordan and Kyle
// without a deploy. First resident: editor auto-routing (who gets standard /
// premium / personal-branding video work). New rule groups get their own
// Section here; storage is the generic AppSetting KV (src/lib/settings.ts).
export default async function SettingsPage() {
  await requirePageAccess("settings");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/settings");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/");

  const rules = await editorRouting();

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="The rules the platform runs on — changes apply to new work within a minute"
      />
      <div className="mx-auto max-w-3xl space-y-6 p-4 pb-16 sm:p-6">
        <Section icon={Route} title="Editor auto-assignment">
          <p className="mb-4 text-sm leading-relaxed text-muted">
            When raws land on a video job, the hub routes the edit automatically.
            &ldquo;Manual&rdquo; sends the job to the pinned <strong>Needs assigning</strong> pile
            on Tasks instead, for you or Kyle to hand off. Reassigning any single job on the
            Editor Queue always overrides these rules.
          </p>
          <RoutingRulesForm initial={rules} />
        </Section>

        <Section icon={Package} title="Product categories">
          <p className="mb-3 text-sm leading-relaxed text-muted">
            Every Aryeo product, mapped by hand to what it actually produces — photo, video
            or both, its tier, and whether it&rsquo;s shoot work or a post-shoot add-on. A mapped
            product overrides the automatic parser everywhere (the fix for phantom floor
            plans and ghost videos).
          </p>
          <Link href="/settings/products" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
            Open the product map <ArrowRight className="size-3.5" />
          </Link>
        </Section>

        <Section icon={SlidersHorizontal} title="More settings">
          <p className="text-sm text-muted">
            Turnaround promises, alert thresholds, and text templates are next to move in here.
            Ask and they&rsquo;ll be added — anything currently hard-coded can become a setting.
          </p>
        </Section>
      </div>
    </div>
  );
}

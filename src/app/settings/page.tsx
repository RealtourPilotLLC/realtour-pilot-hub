import { redirect } from "next/navigation";
import { SlidersHorizontal, Route } from "lucide-react";
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

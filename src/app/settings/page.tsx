import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SlidersHorizontal, Route, Package, ArrowRight, MessageSquareText, Clock, BellRing, Clapperboard, Users, Film } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { RoutingRulesForm } from "@/components/settings/RoutingRulesForm";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { editorRouting, autoTextRules, turnaroundRules, internalAlertRules, textTemplates, reviewRoomRules, topazSettings, DEFAULT_TOPAZ_PARAMS } from "@/lib/settings";
import { ARYEO_MANUAL_NOTE } from "@/lib/integrations/topaz";
import { topazDashboard } from "@/lib/topazJobs";
import { TopazSettingsPanel, type TopazUsage } from "@/components/settings/TopazSettingsPanel";
import { AutoTextSettings } from "@/components/settings/AutoTextSettings";
import { TurnaroundSettings, InternalAlertSettings, TextTemplateSettings, ReviewRoomSettings } from "@/components/settings/OperatingRules";
import { TeamNotifications } from "@/components/settings/TeamNotifications";
import { teamNotifyRows } from "@/lib/notifyPrefs";
import { CalendlyMappingsPanel } from "@/components/settings/CalendlyMappingsPanel";
import { loadCalendlyPanelState } from "@/app/settings/calendlyActions";
import { CalendarCheck } from "lucide-react";

export const dynamic = "force-dynamic";

// A read that leaves this machine gets a hard ceiling: null rather than a page
// that hangs on somebody else's API. Declared out here, not inline, because the
// timer handle is assigned inside a callback and a `let` written during render
// is exactly what the immutability lint (rightly) refuses.
function capped<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(
    () => clearTimeout(timer), // no stray timer once the real answer is in
  );
}


// SETTINGS — the rules the business runs on, editable by Jordan and Kyle
// without a deploy. First resident: editor auto-routing (who gets standard /
// premium / personal-branding video work). New rule groups get their own
// Section here; storage is the generic AppSetting KV (src/lib/settings.ts).
export default async function SettingsPage() {
  await requirePageAccess("settings");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/settings");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/");

  // Team notifications (Jordan, Sep 15) — every active person, the owner
  // included; the Sep 11 owner-only "Text me" card folded into this matrix. A
  // roster read that fails renders the card empty rather than taking the
  // page down with it.
  const [rules, textRules, turns, alerts, templates, reviewRoom, notifyRows, topaz, topazLane, calendly] = await Promise.all([
    editorRouting(), autoTextRules(), turnaroundRules(), internalAlertRules(), textTemplates(), reviewRoomRules(),
    teamNotifyRows().catch(() => []),
    topazSettings(),
    // Only for the "what this month has cost so far" line beside the spending
    // limits — a limit you can't see your position against is a number, not a
    // control. Reading it asks Topaz for the balance (free, starts nothing), so
    // it is capped and falls back to no strip rather than holding the page.
    capped(topazDashboard().catch(() => null), 6000),
    // Calendly & calls (content program, spec §26): lists the account's event
    // types live, so it is capped like Topaz and renders as "unreachable"
    // rather than holding the page.
    capped(loadCalendlyPanelState().catch(() => null), 8000),
  ]);

  const topazUsage: TopazUsage | null = topazLane
    ? {
        connected: topazLane.connected,
        // null, never 0: "we couldn't ask" and "you have none left" are
        // different problems with different answers.
        balance: topazLane.balance ? topazLane.balance.available : null,
        todayRenders: topazLane.today.renders,
        monthRenders: topazLane.month.renders,
        monthCredits: topazLane.month.credits,
      }
    : null;

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
            on Tasks instead, for you or Kyle to hand off. Reassigning any single job in the
            Editing Room always overrides these rules.
          </p>
          <RoutingRulesForm initial={rules} />
        </Section>

        <Section icon={MessageSquareText} title="Automated texts">
          <p className="mb-3 text-[13px] text-muted">
            Every text the hub sends to a client on its own — what it is, when it goes out, and the switches.
            Changes take effect on the next hourly run.
          </p>
          <AutoTextSettings initial={textRules} />
        </Section>

        <Section icon={MessageSquareText} title="Text wording">
          <TextTemplateSettings initial={templates} />
        </Section>

        <Section icon={Clock} title="Turnaround promises">
          <TurnaroundSettings initial={turns} />
        </Section>

        <Section icon={BellRing} title="Internal alerts">
          <InternalAlertSettings initial={alerts} />
        </Section>

        <Section icon={Users} title="Team notifications" count={notifyRows.length}>
          <TeamNotifications rows={notifyRows} />
        </Section>

        <Section icon={Clapperboard} title="Review Room">
          <ReviewRoomSettings initial={reviewRoom} />
        </Section>

        {/* The 1080p pass, straight after the Review Room because that is where
            it starts: approving a cut in there is what sets it off. The anchor
            is what the Connections page links to. */}
        <div id="topaz" className="scroll-mt-6">
          <Section icon={Film} title="1080p video pass">
            <TopazSettingsPanel
              initial={topaz}
              defaults={DEFAULT_TOPAZ_PARAMS}
              aryeoNote={ARYEO_MANUAL_NOTE}
              usage={topazUsage}
            />
          </Section>
        </div>

        <div id="calendly" className="scroll-mt-6">
          <Section icon={CalendarCheck} title="Calendly & content-program calls">
            {calendly ? <CalendlyMappingsPanel state={calendly} /> : <p className="text-sm text-muted">Calendly could not be reached just now — reload to try again.</p>}
          </Section>
        </div>

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

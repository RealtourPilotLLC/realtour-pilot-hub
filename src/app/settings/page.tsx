import { Suspense } from "react";
import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Route, Package, ArrowRight, MessageSquareText, Clock, BellRing, Clapperboard, Users, Film } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { RoutingRulesForm } from "@/components/settings/RoutingRulesForm";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { editorRouting, autoTextRules, turnaroundRules, internalAlertRules, textTemplates, reviewRoomRules, payVisibilityRules, topazSettings, DEFAULT_TOPAZ_PARAMS, type TopazSettings } from "@/lib/settings";
import { ARYEO_MANUAL_NOTE } from "@/lib/integrations/topaz";
import { topazDashboard } from "@/lib/topazJobs";
import { TopazSettingsPanel, type TopazUsage } from "@/components/settings/TopazSettingsPanel";
import { AutoTextSettings } from "@/components/settings/AutoTextSettings";
import { TurnaroundSettings, InternalAlertSettings, TextTemplateSettings, ReviewRoomSettings } from "@/components/settings/OperatingRules";
import { PayVisibilitySettings } from "@/components/settings/PayVisibility";
import { TeamNotifications } from "@/components/settings/TeamNotifications";
import { teamNotifyRows } from "@/lib/notifyPrefs";
import { CalendlyMappingsPanel } from "@/components/settings/CalendlyMappingsPanel";
import { loadCalendlyPanelState } from "@/app/settings/calendlyActions";
import { CalendarCheck, Zap, EyeOff, type LucideIcon } from "lucide-react";
import { ProgramAutomationPanel } from "@/components/settings/ProgramAutomationPanel";
import { loadAutomations } from "@/app/settings/programActions";
import { RemindersPanel } from "@/components/settings/RemindersPanel";
import { loadRemindersPanelState } from "@/app/settings/reminderActions";

export const dynamic = "force-dynamic";
// The two provider cards stream (see the <Suspense> boundaries below), so the
// response stays open until Topaz and Calendly answer or their caps fire. An
// explicit ceiling, because a stream that the platform kills half-sent leaves
// the browser holding a page that never finishes loading — the whole screen
// looks broken, not just the one card. /trends and /sales do the same.
export const maxDuration = 60;

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

// The shared fallback for both provider cards below: the real heading with four
// grey bars under it, so the column keeps its shape while a provider answers.
// Same pattern as the trends skeletons (src/components/trends/MarginByPackage.tsx).
function ProviderCardSkeleton({ icon, title, note }: { icon: LucideIcon; title: string; note: string }) {
  return (
    <Section icon={icon} title={title} action={<span className="text-[11px] text-muted-2">{note}</span>}>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 animate-pulse rounded bg-surface-2" />
        ))}
      </div>
    </Section>
  );
}

// THE SAVED RULES DO NOT WAIT ON SOMEBODY ELSE'S API (Sep 20). Until today the
// Topaz balance and the Calendly event-type list were members of the page's one
// Promise.all, and a Promise.all resolves on its SLOWEST member — so all
// fourteen cards sat behind whichever provider was slowest, and a Calendly
// connection that is accepted and then held open silently cost the whole page
// the full 8-second cap to fill in two cards out of fourteen. Jordan opening
// Settings to flip one editor-routing rule was paying Calendly's latency for
// it. The rules themselves are local reads; they now paint straight away and
// each provider card streams into its own <Suspense> when it arrives. The caps
// stay exactly where they were — they just hold up one card instead of all of
// them.
//
// ONE THING TRADED KNOWINGLY: the Topaz card streams whole, settings form and
// all, even though its saved rule was read with the other locals. The panel
// takes its usage strip as a plain value rather than a promise, so there is no
// seam to split it on from in here, and the form sits behind a skeleton for as
// long as the balance read takes (147-953ms across the Sep 20 measurements off
// this laptop; shorter from Vercel). Still strictly better than before, when that
// same form waited on the slowest of all fourteen reads. Closing it properly
// means making TopazSettingsPanel take `usage` as a promise and reading it with
// use() — a change to that component, not to this page.

// The 1080p pass. `initial` is the saved rule, already read with the rest of
// them; the only thing awaited in here is the live balance.
async function TopazCard({ initial }: { initial: TopazSettings }) {
  // Only for the "what this month has cost so far" line beside the spending
  // limits — a limit you can't see your position against is a number, not a
  // control. Reading it asks Topaz for the balance (free, starts nothing), so
  // it is capped and falls back to no strip rather than holding the card open.
  const topazLane = await capped(topazDashboard().catch(() => null), 6000);
  const usage: TopazUsage | null = topazLane
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
    <Section icon={Film} title="1080p video pass">
      <TopazSettingsPanel initial={initial} defaults={DEFAULT_TOPAZ_PARAMS} aryeoNote={ARYEO_MANUAL_NOTE} usage={usage} />
    </Section>
  );
}

// Calendly & calls (content program, spec §26): lists the account's event types
// live, so it is capped like Topaz and renders as "unreachable" rather than
// holding the card open.
async function CalendlyCard() {
  const calendly = await capped(loadCalendlyPanelState().catch(() => null), 8000);
  return (
    <Section icon={CalendarCheck} title="Calendly & content-program calls">
      {calendly
        ? <CalendlyMappingsPanel state={calendly} />
        : <p className="text-sm text-muted">Calendly could not be reached just now — reload to try again.</p>}
    </Section>
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

  // ONE WAIT, NOT THREE (Sep 20). These used to be three serial awaits —
  // automations, then reminders, then everything else — with no data dependency
  // between them, so the page paid two extra round trips to Neon for nothing.
  //
  // EVERY FALLBACK HERE IS null, NEVER AN EMPTY LIST. A read that fails still
  // must not take the page down with it, but "the list is empty" and "we could
  // not read the list" are different sentences and only one of them is true.
  // An empty array used to print "Nobody active on the roster yet" at a roster
  // of six real people, and "0 of 0" automations against thirteen keys; null
  // prints the same honest note the reminders card has always used, and the
  // Section badge is left off rather than asserting a number nobody read.
  const [rules, textRules, turns, alerts, templates, reviewRoom, payVisibility, notifyRows, topaz, automations, reminders] = await Promise.all([
    editorRouting(), autoTextRules(), turnaroundRules(), internalAlertRules(), textTemplates(), reviewRoomRules(),
    payVisibilityRules().then((r) => ({ paused: r.photographerPayPaused, pausedAtISO: r.pausedAt, pausedBy: r.pausedBy })),
    // Team notifications (Jordan, Sep 15) — every active person, the owner
    // included; the Sep 11 owner-only "Text me" card folded into this matrix.
    teamNotifyRows().catch(() => null),
    topazSettings(),
    loadAutomations().catch(() => null),
    // Program reminders (spec §24) — the policy, the dry run and the send
    // ledger. The switch itself is on the automations panel above; this is the
    // ONE place the policy is written, because this is the shape the reminder
    // evaluator reads.
    loadRemindersPanelState().catch(() => null),
  ]);

  return (
    <div>
      {/* "Within a minute" is true of the rules themselves (getSetting caches
          them for 60 seconds), but up here it read as a promise about all
          fourteen cards, and the automated texts are not one of them: flipping
          a text switch changes nothing until the hourly sweep runs, which the
          Automated texts card says in its own words. Say "most" up here and let
          that card be the specific one. */}
      <PageHeader
        title="Settings"
        subtitle="The rules the platform runs on — most changes apply within a minute; the automated texts wait for the next hourly run"
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

        <Section icon={Users} title="Team notifications" count={notifyRows ? notifyRows.length : undefined}>
          {notifyRows
            ? <TeamNotifications rows={notifyRows} />
            : <p className="text-sm text-muted">The roster could not be read just now — reload to try again. Nothing has changed about who gets notified.</p>}
        </Section>

        {/* Owner's own switch — read here so the card can say how long it has
            been on. Placed next to the Review Room because both are about what
            a creative sees rather than what the machinery does. */}
        <Section icon={EyeOff} title="Photographer pay view">
          <PayVisibilitySettings initial={payVisibility} isOwner={me ? me.role === "OWNER" : !authEnforced()} />
        </Section>

        <Section icon={Clapperboard} title="Review Room">
          <ReviewRoomSettings initial={reviewRoom} />
        </Section>

        {/* The 1080p pass, straight after the Review Room because that is where
            it starts: approving a cut in there is what sets it off. The anchor
            is what the Connections page links to. */}
        <div id="topaz" className="scroll-mt-6">
          <Suspense fallback={<ProviderCardSkeleton icon={Film} title="1080p video pass" note="asking Topaz where the month stands…" />}>
            <TopazCard initial={topaz} />
          </Suspense>
        </div>

        {/* CONTENT-PROGRAM AUTOMATIONS (spec §13) — every switch, including the
            ones that have never been configured. */}
        <div id="program-automations" className="scroll-mt-6">
          <Section
            icon={Zap}
            title="Content program automations"
            count={automations ? `${automations.filter((a) => a.enabled).length}/${automations.length} on` : undefined}
          >
            {automations
              ? <ProgramAutomationPanel
                  isOwner={me ? me.role === "OWNER" : !authEnforced()}
                  rows={automations.map((a) => ({
                    key: a.key, enabled: a.enabled, missing: a.missing, enabledBy: a.enabledBy,
                    enabledAtISO: a.enabledAt?.toISOString() ?? null, lastRunAtISO: a.lastRunAt?.toISOString() ?? null,
                    lastError: a.lastError, lastErrorAtISO: a.lastErrorAt?.toISOString() ?? null,
                  }))}
                />
              : <p className="text-sm text-muted">The automation switches could not be read just now — reload to try again. Nothing has been turned on or off.</p>}
          </Section>
        </div>

        <div id="program-reminders" className="scroll-mt-6">
          <Section
            icon={BellRing}
            title="Program reminders"
            count={reminders ? (reminders.switch.enabled ? "on" : reminders.switch.missing ? "never configured" : "off") : undefined}
          >
            {reminders
              ? <RemindersPanel state={reminders} />
              : <p className="text-sm text-muted">The reminder ledger could not be read just now — reload to try again.</p>}
          </Section>
        </div>

        <div id="calendly" className="scroll-mt-6">
          <Suspense fallback={<ProviderCardSkeleton icon={CalendarCheck} title="Calendly & content-program calls" note="asking Calendly for the event types…" />}>
            <CalendlyCard />
          </Suspense>
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
        {/* RETIRED Sep 20: the "More settings" card promised that turnaround
            promises, alert thresholds and text templates were "next to move in
            here". All three have shipped on this very page for months — they
            are the Turnaround promises, Internal alerts and Text wording cards
            above — so the card was telling the three people who use this screen
            that a finished tool was half-built. Anything hard-coded can still
            become a setting; that is a conversation, not a card. */}
      </div>
    </div>
  );
}

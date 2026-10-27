import { Suspense } from "react";
import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Route, Package, ArrowRight, MessageSquareText, Clock, BellRing, Clapperboard, Users, Film, Radar, KeyRound, Wallet, Gauge, Plug } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { RoutingRulesForm } from "@/components/settings/RoutingRulesForm";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess, canSeeMoney } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { editorRouting, autoTextRules, turnaroundRules, internalAlertRules, eveningHoursOffSchedule, reviewRoomRules, topazSettings, DEFAULT_TOPAZ_PARAMS, type TopazSettings } from "@/lib/settings";
import { textTemplateRows } from "@/lib/textTemplateStore";
import { templatesVisibleTo } from "@/lib/textTemplates";
import { TextMessagesSettings } from "@/components/settings/TextMessagesSettings";
import { commsCoachingSettings } from "@/lib/commsCoaching";
import { CoachingSettings } from "@/components/coaching/CoachingSettings";
import { ARYEO_MANUAL_NOTE } from "@/lib/integrations/topaz";
import { topazDashboard } from "@/lib/topazJobs";
import { TopazSettingsPanel, type TopazUsage } from "@/components/settings/TopazSettingsPanel";
import { AutoTextSettings } from "@/components/settings/AutoTextSettings";
import { TurnaroundSettings, InternalAlertSettings, ReviewRoomSettings } from "@/components/settings/OperatingRules";
import { SpellingFlagsSetting } from "@/components/settings/SpellingFlagsSetting";
import { PhotographerBriefSettings } from "@/components/settings/PhotographerBriefSettings";
import { photographerBriefSettings } from "@/lib/photographerBrief";
import { TeamNotifications } from "@/components/settings/TeamNotifications";
import { teamNotifyRows } from "@/lib/notifyPrefs";
import { CalendlyMappingsPanel } from "@/components/settings/CalendlyMappingsPanel";
import { loadCalendlyPanelState } from "@/app/settings/calendlyActions";
import { CalendarCheck, ChevronRight, Zap, Bug, Mail, type LucideIcon } from "lucide-react";
import { ClientEmailMonitorSettings } from "@/components/settings/ClientEmailMonitorSettings";
import { clientEmailMonitor } from "@/lib/clientEmailMonitor";
import { ProgramAutomationPanel } from "@/components/settings/ProgramAutomationPanel";
// Read straight from the lib during render (audit G21, Oct 20 2026).
// `loadAutomations` is a server action, i.e. a public POST endpoint, which had
// no guard; it is guarded now, and the page has no need to go through it.
import { allAutomations } from "@/lib/programAutomation";
import { RemindersPanel } from "@/components/settings/RemindersPanel";
import { loadRemindersPanelState } from "@/app/settings/reminderActions";
import { SettingsGroup, settingsGroupsFor, SETTINGS_LAYOUT, type SettingsGroupDef, type SettingsCardKey } from "@/components/settings/SettingsGroup";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsSearchCard, SettingsView } from "@/components/settings/SettingsGroupDisclosure";
import { SettingsFacts, type SettingsFact } from "@/components/settings/SettingsFacts";
import { SETTINGS_GROUP_ICONS } from "@/components/settings/settingsIcons";
import { ReadinessPanel, ReadinessSummary, ReadinessBadge, IntegrationsReadiness } from "@/components/settings/ReadinessPanel";
import { readinessReport } from "@/lib/readiness";
import type { ReadinessReport, SettingsGroupId } from "@/lib/readiness";
import { boundedWait } from "@/lib/boundedWait";

export const dynamic = "force-dynamic";
// The two provider cards stream (see the <Suspense> boundaries below), so the
// response stays open until Topaz and Calendly answer or their caps fire. An
// explicit ceiling, because a stream that the platform kills half-sent leaves
// the browser holding a page that never finishes loading — the whole screen
// looks broken, not just the one card. /trends and /sales do the same.
export const maxDuration = 60;

// A read that leaves this machine gets a hard ceiling: null rather than a page
// that hangs on somebody else's API. One shared helper (audit G17, Oct 20
// 2026): this page and Connections each kept a private copy of the race.
// boundedWait rejects at the ceiling (and clears its timer either way); null
// is the fallback here.
const capped = <T,>(p: Promise<T>, ms: number): Promise<T | null> => boundedWait(p, ms).catch(() => null);

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
async function TopazCard({ initial, isOwner }: { initial: TopazSettings; isOwner: boolean }) {
  // Only for the "what this month has cost so far" line beside the spending
  // limits — a limit you can't see your position against is a number, not a
  // control. Reading it asks Topaz for the balance (free, starts nothing), so
  // it is capped and falls back to no strip rather than holding the card open.
  const topazLane = await capped(topazDashboard().catch(() => null), 6000);
  // Credits are money (the plan tops itself up): the balance and the month's
  // spend reach the owner's browser only (canSeeMoney, audit L6 / P-L1, Oct 22
  // 2026). Kyle sees the render counts.
  const money = canSeeMoney(isOwner ? "OWNER" : null);
  const usage: TopazUsage | null = topazLane
    ? {
        connected: topazLane.connected,
        // null, never 0: "we couldn't ask" and "you have none left" are
        // different problems with different answers.
        balance: money && topazLane.balance ? topazLane.balance.available : null,
        todayRenders: topazLane.today.renders,
        monthRenders: topazLane.month.renders,
        monthCredits: money ? topazLane.month.credits : null,
        showsMoney: money,
      }
    : null;
  // "Try these settings" (Oct 22 2026) spends credits: its lists are read for
  // the owner only, and never reach anybody else's browser.
  const [testCuts, tests] = isOwner
    ? await Promise.all([
        capped(import("@/lib/topazTests").then((m) => m.recentCutsForTest(20)), 6000),
        capped(import("@/lib/topazTests").then((m) => m.topazTestRows(12)), 6000),
      ])
    : [null, null];
  return (
    <Section icon={Film} title="Topaz pass">
      <TopazSettingsPanel
        initial={initial}
        defaults={DEFAULT_TOPAZ_PARAMS}
        aryeoNote={ARYEO_MANUAL_NOTE}
        usage={usage}
        isOwner={isOwner}
        testCuts={testCuts ?? []}
        tests={tests ?? []}
      />
    </Section>
  );
}

// Calendly & calls (content program, spec §26): lists the account's event types
// live, so it is capped like Topaz and renders as "unreachable" rather than
// holding the card open.
async function CalendlyCard({ canOpenOperations }: { canOpenOperations: boolean }) {
  const calendly = await capped(loadCalendlyPanelState().catch(() => null), 8000);
  return (
    <Section icon={CalendarCheck} title="Calendly & content-program calls">
      {calendly
        ? <CalendlyMappingsPanel state={calendly} canOpenOperations={canOpenOperations} />
        : <p className="text-sm text-muted">Calendly could not be reached just now — reload to try again.</p>}
    </Section>
  );
}

async function IntegrationFacts({ report, layout }: { report: Promise<ReadinessReport | null>; layout: "rows" | "grid" }) {
  const current = await report;
  if (!current) return <SettingsFacts layout={layout} facts={[{ label: "Connections", value: "Couldn't read", tone: "warn" }]} />;
  const errors = current.providers.filter((provider) => provider.status === "error").length;
  const late = current.crons.filter((c) => c.stale).length;
  return (
    <SettingsFacts
      layout={layout}
      facts={[
        { label: "Services automations use", value: `${current.providers.filter((provider) => provider.connected).length} of ${current.providers.length} connected` },
        { label: "Refused on last check", value: errors ? String(errors) : "None", tone: errors ? "warn" : "ok" },
        { label: "Scheduled runs", value: late ? `${late} late` : "On time", tone: late ? "warn" : "ok" },
      ]}
    />
  );
}

/** "8 AM", "8:30 PM": the texts' sending window in words. */
const clock = (hour: number, minute: number) =>
  `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour % 24 < 12 ? "AM" : "PM"}`;

// SETTINGS — the rules the business runs on, editable by Jordan and Kyle
// without a deploy. First resident: editor auto-routing (who gets standard /
// premium / personal-branding video work). New rule groups get their own
// Section here; storage is the generic AppSetting KV (src/lib/settings.ts).
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ check?: string | string[] }> }) {
  await requirePageAccess("settings");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/settings");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/");
  const isOwner = me ? me.role === "OWNER" : !authEnforced();

  // READINESS (A56). Started here, awaited inside its own <Suspense> by the
  // panel at the top and by the Integrations group — one report, two readers,
  // and neither holds up the saved rules below. It is database reads only; the
  // one live question (can Gmail send?) is asked only when someone presses
  // "Check Gmail", which comes back as ?check=gmail.
  const check = (await searchParams).check;
  const readiness = readinessReport({ live: check === "gmail" }).catch(() => null);

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
  const [rules, textRules, turns, alerts, eveningOff, textRows, reviewRoom, notifyRows, topaz, automations, reminders, coaching, emailMonitor, briefSettings] = await Promise.all([
    editorRouting(), autoTextRules(), turnaroundRules(), internalAlertRules(),
    // A saved evening hour the cron can't fire at (Oct 21 2026): the card
    // shows the real time it goes out and says what was saved.
    eveningHoursOffSchedule(),
    // Every automatic text's wording (Oct 21 2026). Null, never the defaults,
    // on a failed read: a card that shows "default" for wording it could not
    // read would be a lie about what clients are getting.
    textTemplateRows().catch(() => null),
    reviewRoomRules(),
    // Team notifications (Jordan, Sep 15) — every active person, the owner
    // included; the Sep 11 owner-only "Text me" card folded into this matrix.
    teamNotifyRows().catch(() => null),
    topazSettings(),
    allAutomations().catch(() => null),
    // Program reminders (spec §24) — the policy, the dry run and the send
    // ledger. The switch itself is on the automations panel above; this is the
    // ONE place the policy is written, because this is the shape the reminder
    // evaluator reads.
    loadRemindersPanelState().catch(() => null),
    // End-of-day comms coaching (Jordan, Sep 21). A local read like the other
    // rules, so it paints with them; null rather than defaults on a failure,
    // because a card that shows "nobody is coached" when it simply could not
    // read the row is a lie about who is being audited. The shape is
    // commsCoaching.ts's — that module runs the audit and owns the contract.
    commsCoachingSettings().catch(() => null),
    // Client email copies (Jordan, Oct 12). Never throws: an unreadable row
    // reads as the default (on, to info@), and the card says so.
    clientEmailMonitor(),
    // The photographer brief (Oct 23 2026): its own row; unreadable reads as off.
    photographerBriefSettings(),
  ]);
  // "Show spelling flags to reviewers" (Oct 24 2026, lib/videoAnalysis): OFF
  // until Jordan says the trial is good enough. Unreadable reads as off.
  const spellingFlags = await import("@/lib/videoAnalysis")
    .then(async (m) => ({ on: await m.spellingReviewersOn(), words: isOwner ? (await m.spellingTrial()).summary.words : null }))
    .catch(() => ({ on: false, words: null }));
  // The payday text is about pay: the owner's alone, so Kyle's page never
  // carries it (he never sees dollar amounts).
  const textShown = textRows ? templatesVisibleTo(textRows, isOwner) : null;

  // THE CARDS, BY NAME (11-settings-grouping). Each is exactly the card it was
  // before the grouping, with its own id and anchor where it had one; the only
  // addition is a data-settings-card name so a drill can prove every card
  // renders once, inside one group. Where each card goes is decided below, in
  // one list, so a card cannot be dropped or shown twice by editing a group.
  const card = (key: SettingsCardKey, node: React.ReactNode, anchor?: string) => (
    <SettingsSearchCard key={key} settingKey={key} anchor={anchor}>{node}</SettingsSearchCard>
  );
  const cards = {
    "editor-routing": card("editor-routing",
      <Section icon={Route} title="Editor auto-assignment">
        <p className="mb-4 text-sm leading-relaxed text-muted">
          When raws land on a video job, the hub routes the edit automatically.
          &ldquo;Manual&rdquo; sends the job to the pinned <strong>Needs assigning</strong> pile
          on Tasks instead, for you or Kyle to hand off. Reassigning any single job in the
          Editing Room always overrides these rules.
        </p>
        <RoutingRulesForm initial={rules} />
      </Section>),

    "automated-texts": card("automated-texts",
      <Section icon={MessageSquareText} title="Automated texts">
        <p className="mb-3 text-[13px] text-muted">
          Every text the hub sends to a client on its own — what it is, when it goes out, and the switches.
          Changes take effect on the next hourly run.
        </p>
        <AutoTextSettings initial={textRules} />
      </Section>),

    // TEXT MESSAGES (Oct 21 2026: "add settings to customize all text
    // templates"). Every automatic text, client and team, in one card; it
    // replaced the three-box "Text wording" card (lib/textTemplates).
    // Jordan edits, Kyle reads.
    "text-wording": card("text-wording",
      <Section
        icon={MessageSquareText}
        title="Text messages"
        count={textShown ? (textShown.some((r) => r.source !== "default") ? `${textShown.filter((r) => r.source !== "default").length} edited` : "defaults") : undefined}
      >
        {textShown
          ? <TextMessagesSettings rows={textShown} isOwner={isOwner} />
          : <p className="text-sm text-muted">The text wording could not be read just now, so nothing can be edited. Reload to try again. Every text still goes out with its saved or default words.</p>}
      </Section>, "text-messages"),

    turnaround: card("turnaround",
      <Section icon={Clock} title="Turnaround promises">
        <TurnaroundSettings initial={turns} />
      </Section>),

    // The coverage hours (who is "here", and who is on call) live inside this
    // card; the Team group links to them through this anchor. Jordan's
    // Notification schedule is in here too (#notification-schedule).
    "internal-alerts": card("internal-alerts",
      <Section icon={BellRing} title="Internal alerts">
        <InternalAlertSettings initial={alerts} offSchedule={eveningOff} />
        <PhotographerBriefSettings initial={briefSettings} />
      </Section>, "internal-alerts"),

    "team-notifications": card("team-notifications",
      <Section icon={Users} title="Team notifications" count={notifyRows ? notifyRows.length : undefined}>
        {notifyRows
          ? <TeamNotifications rows={notifyRows} />
          : <p className="text-sm text-muted">The roster could not be read just now — reload to try again. Nothing has changed about who gets notified.</p>}
      </Section>),

    // END-OF-DAY COMMS COACHING (Jordan, Sep 21). In the Team group because it
    // is about what a PERSON is shown, not about what the machinery does. The
    // anchor is what the report at /coaching links back to.
    coaching: card("coaching",
      <Section
        icon={Radar}
        title="Comms coaching"
        count={coaching ? (coaching.teamMemberIds.length === 0 ? "nobody yet" : coaching.teamMemberIds.length) : undefined}
        action={
          <Link href="/coaching" className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
            Report <ArrowRight className="size-3" />
          </Link>
        }
      >
        {coaching
          ? <CoachingSettings initial={coaching} isOwner={isOwner} />
          : <p className="text-sm text-muted">The coaching rules could not be read just now — reload to try again. Nobody has been added or removed, and nothing has been sent.</p>}
      </Section>, "coaching"),

    // "Team pay view" (the pay_visibility switch) retired Oct 21 2026 and
    // stays retired: who sees pay is a rule with no switch (lib/settings
    // payViewFor; Oct 27 2026: each person sees their own, only the owner sees
    // anyone else's). The Financial group keeps its payroll and bank-feed links.

    "review-room": card("review-room",
      <Section icon={Clapperboard} title="Video Review Room">
        <ReviewRoomSettings initial={reviewRoom} />
        <SpellingFlagsSetting initial={spellingFlags.on} isOwner={isOwner} trialWords={spellingFlags.words} />
      </Section>),

    // The 1080p pass, straight after the Review Room because that is where it
    // starts: approving a cut in there is what sets it off. The anchor is what
    // the Connections page links to.
    topaz: card("topaz",
      <Suspense fallback={<ProviderCardSkeleton icon={Film} title="Topaz pass" note="asking Topaz where the month stands…" />}>
        <TopazCard initial={topaz} isOwner={isOwner} />
      </Suspense>, "topaz"),

    // CONTENT-PROGRAM AUTOMATIONS (spec §13) — every switch, including the ones
    // that have never been configured. /content, /content/monitoring and the
    // monitoring alerts link here.
    "program-automations": card("program-automations",
      <Section
        icon={Zap}
        title="Content program automations"
        count={automations ? `${automations.filter((a) => a.enabled).length}/${automations.length} on` : undefined}
      >
        {automations
          ? <ProgramAutomationPanel
              isOwner={isOwner}
              rows={automations.map((a) => ({
                key: a.key, enabled: a.enabled, missing: a.missing, enabledBy: a.enabledBy,
                enabledAtISO: a.enabledAt?.toISOString() ?? null, lastRunAtISO: a.lastRunAt?.toISOString() ?? null,
                lastError: a.lastError, lastErrorAtISO: a.lastErrorAt?.toISOString() ?? null,
              }))}
            />
          : <p className="text-sm text-muted">The automation switches could not be read just now — reload to try again. Nothing has been turned on or off.</p>}
      </Section>, "program-automations"),

    "program-reminders": card("program-reminders",
      <Section
        icon={BellRing}
        title="Program reminders"
        count={reminders ? (reminders.switch.enabled ? "on" : reminders.switch.missing ? "never configured" : "off") : undefined}
      >
        {reminders
          ? <RemindersPanel state={reminders} />
          : <p className="text-sm text-muted">The reminder ledger could not be read just now — reload to try again.</p>}
      </Section>, "program-reminders"),

    calendly: card("calendly",
      <Suspense fallback={<ProviderCardSkeleton icon={CalendarCheck} title="Calendly & content-program calls" note="asking Calendly for the event types…" />}>
        <CalendlyCard canOpenOperations={me ? canAccess(me, "content") : !authEnforced()} />
      </Suspense>, "calendly"),

    "product-categories": card("product-categories",
      <Section icon={Package} title="Product categories">
        <p className="mb-3 text-sm leading-relaxed text-muted">
          Every Aryeo product, mapped by hand to what it actually produces — photo, video
          or both, its tier, and whether it&rsquo;s shoot work or a post-shoot add-on. A mapped
          product overrides the automatic parser everywhere (the fix for phantom floor
          plans and ghost videos).
        </p>
        <Link href="/settings/products" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          Open the product map <ArrowRight className="size-3.5" />
        </Link>
      </Section>),
  } satisfies Record<SettingsCardKey, React.ReactNode>;

  // Links, not controls: where access and coverage are actually managed.
  const linkRow = "flex min-h-10 items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand";
  const extras: Partial<Record<SettingsGroupId, React.ReactNode>> = {
    // CLIENT EMAIL COPIES (Oct 12 2026): "Anytime a client gets an email, I
    // want to receive that email too." One address, one switch; owner edits.
    comms: (
      <Section key="client-email-copies" icon={Mail} title="Client email copies" count={emailMonitor.enabled ? "on" : "off"}>
        <ClientEmailMonitorSettings
          initial={{ enabled: emailMonitor.enabled, address: emailMonitor.address, unreadable: emailMonitor.source === "unreadable" }}
          isOwner={isOwner}
        />
      </Section>
    ),
    // CLIENT ONBOARDING (Oct 5 2026): one client at a time — what they get,
    // their portal account, and the messages Jordan sends them himself.
    program: (
      <Section key="client-onboarding" icon={Users} title="Client onboarding">
        <div className="-mx-2 space-y-0.5">
          <Link href="/settings/onboarding" className={linkRow}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">Onboard clients one by one</span>
              <span className="block text-[12px] text-muted">{isOwner ? "Choose what each client gets, create their portal account, and send their welcome yourself. Nothing is sent unless you press Send now." : "Each client's onboarding steps, read-only. Only Jordan changes or sends anything there."}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
          </Link>
        </div>
      </Section>
    ),
    team: (
      <Section key="people-access" icon={KeyRound} title="People & access">
        <div className="-mx-2 space-y-0.5">
          <Link href={isOwner ? "/users?tab=logins" : "/users?tab=team"} className={linkRow}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{isOwner ? "Logins & access" : "The team"}</span>
              <span className="block text-[12px] text-muted">{isOwner ? "Who can sign in, their role, and what each role can open." : "Who is on the team and how to reach them."}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
          </Link>
          <a href="#internal-alerts" className={linkRow}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">Coverage hours & on call</span>
              <span className="block text-[12px] text-muted">When somebody is here, and who answers urgent alerts outside it. In Communication, under Internal alerts.</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
          </a>
        </div>
      </Section>
    ),
    integrations: (
      <>
        <Suspense key="integrations-readiness" fallback={<ProviderCardSkeleton icon={Plug} title="Connections" note="reading the connections…" />}>
          <IntegrationsReadiness report={readiness} isOwner={isOwner} />
        </Suspense>
        {/* THE ERROR TRACKER (Oct 6 2026) — owner-only: stacks and routes are
            the inside of the system. */}
        {isOwner && (
          <Section key="error-reports" icon={Bug} title="Errors">
            <div className="-mx-2 space-y-0.5">
              <Link href="/settings/errors" className={linkRow}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">Error reports</span>
                  <span className="block text-[12px] text-muted">Every error the hub has hit, grouped with counts. Mark fixed, ignore, or copy a report for Claude.</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
              </Link>
            </div>
          </Section>
        )}
      </>
    ),
    financial: (
      <Section key="money-links" icon={Wallet} title="Payroll & bank feeds">
        <div className="-mx-2 space-y-0.5">
          <Link href="/sales?tab=payroll" className={linkRow}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">Payroll</span>
              <span className="block text-[12px] text-muted">Each creative&rsquo;s pay by period, mileage and adjustments.</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
          </Link>
          <Link href="/connections/banks" className={linkRow}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">Bank feeds</span>
              <span className="block text-[12px] text-muted">The read-only bank and card connections behind Finance.</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-2" aria-hidden />
          </Link>
        </div>
      </Section>
    ),
  };

  const groups = settingsGroupsFor(isOwner);
  const primaryReviewer = reviewRoom.creativeApproverTeamMemberId
    ? notifyRows?.find((person) => person.teamMemberId === reviewRoom.creativeApproverTeamMemberId)?.name ?? "Selected; name not on the roster"
    : "None selected";
  // THE KEY VALUES PER SECTION (Oct 26 2026: "an actual nice settings page
  // dashboard"), on the overview tile and under the section's heading. They
  // describe the same loaded values passed to the forms; a saved switch is not
  // proof of its effect, which is what Readiness is for.
  const unreadable = (label: string): SettingsFact => ({ label, value: "Couldn't read", tone: "warn" });
  const onOff = (label: string, on: boolean): SettingsFact => ({ label, value: on ? "On" : "Off", tone: on ? "ok" : "muted" });
  const edited = textShown ? textShown.filter((r) => r.source !== "default").length : 0;
  const facts: Record<SettingsGroupId, SettingsFact[]> = {
    team: [
      notifyRows ? { label: "Notification profiles", value: `${notifyRows.length} people` } : unreadable("Notification profiles"),
      coaching ? { label: "Comms coaching", value: `${coaching.teamMemberIds.length === 1 ? "1 person" : `${coaching.teamMemberIds.length} people`}, notes ${coaching.sendEnabled ? "sent" : "not sent"}` } : unreadable("Comms coaching"),
    ],
    scheduling: [
      { label: "Photos", value: `${turns.photos} hours` },
      { label: "Standard video", value: `${turns.standardVideoHours} hours` },
      { label: "Monthly content", value: `${turns.monthlyBusinessDays} business days` },
    ],
    production: [
      { label: "Primary reviewer", value: primaryReviewer, tone: reviewRoom.creativeApproverTeamMemberId ? undefined : "muted" },
      { label: "Backup offered after", value: `${reviewRoom.coverOfferHours} covered hours` },
      onOff("Topaz pass", topaz.enabled),
    ],
    program: [
      automations ? { label: "Automations", value: `${automations.filter((a) => a.enabled).length} of ${automations.length} on` } : unreadable("Automations"),
      reminders
        ? { label: "Reminders", value: reminders.switch.enabled ? "On" : reminders.switch.missing ? "Never configured" : "Off", tone: reminders.switch.enabled ? "ok" : "muted" }
        : unreadable("Reminders"),
    ],
    comms: [
      onOff("Automated texts", textRules.enabled),
      { label: "Sending window", value: `${clock(textRules.sendFromHour, 0)} to ${clock(textRules.sendUntilHour, textRules.sendUntilMinute)} ET${textRules.weekdaysOnly ? ", weekdays" : ""}` },
      textShown ? { label: "Text wording", value: edited ? `${edited} edited` : "All default" } : unreadable("Text wording"),
      { label: "Client email copies", value: emailMonitor.enabled ? emailMonitor.address : "Off", tone: emailMonitor.enabled ? undefined : "muted" },
    ],
    integrations: [],
    financial: [
      { label: "Who sees everyone's pay", value: "Only you" },
      { label: "Everyone else sees", value: "Their own pay, on My Pay" },
    ],
  };
  const factsFor = (id: SettingsGroupId, layout: "rows" | "grid") =>
    id === "integrations"
      ? <Suspense fallback={<SettingsFacts layout={layout} facts={[{ label: "Services automations use", value: "Reading…", tone: "muted" }]} />}><IntegrationFacts report={readiness} layout={layout} /></Suspense>
      : <SettingsFacts layout={layout} facts={facts[id]} />;

  const render = (g: SettingsGroupDef) => (
    <SettingsGroup key={g.id} group={g} snapshot={factsFor(g.id, "grid")}>
      {SETTINGS_LAYOUT[g.id].map((k) => cards[k])}
      {extras[g.id]}
    </SettingsGroup>
  );
  const tile = (g: SettingsGroupDef) => {
    const Icon = SETTINGS_GROUP_ICONS[g.id];
    return (
      <a key={g.id} href={`#${g.id}`} className="group flex flex-col rounded-2xl border border-border bg-surface p-4 transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        <span className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"><Icon aria-hidden className="size-[18px]" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold leading-snug">{g.title}</span>
            <span className="mt-0.5 block text-ui-status text-muted">{g.blurb}</span>
          </span>
          <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-2 transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-4 block border-t border-border pt-3">{factsFor(g.id, "rows")}</span>
      </a>
    );
  };

  return (
    <div>
      {/* "Most changes" on purpose: getSetting caches the rules for 60
          seconds, but the automated texts change nothing until the hourly
          sweep runs, which their own card says. */}
      <PageHeader
        title="Settings"
        subtitle="The rules the hub runs on. Most changes apply within a minute; automated texts wait for the next hourly run."
      />
      <div className="mx-auto min-w-0 max-w-6xl p-4 pb-16 [overflow-wrap:anywhere] sm:p-6">
        <SettingsNav groups={groups} badges={{ readiness: <Suspense fallback={null}><ReadinessBadge report={readiness} /></Suspense> }}>
          <SettingsView id="overview" className="space-y-4">
            <h2 className="sr-only">Overview</h2>
            <Suspense fallback={<ProviderCardSkeleton icon={Gauge} title="Readiness" note="reading every switch…" />}>
              <ReadinessSummary report={readiness} />
            </Suspense>
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{groups.map(tile)}</div>
          </SettingsView>
          <SettingsView id="readiness">
            <Suspense fallback={<ProviderCardSkeleton icon={Gauge} title="Readiness" note="reading every switch…" />}>
              <ReadinessPanel report={readiness} />
            </Suspense>
          </SettingsView>
          {groups.map(render)}
        </SettingsNav>
      </div>
    </div>
  );
}

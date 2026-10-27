import Link from "next/link";
import { cookies } from "next/headers";
import { AlertTriangle, CheckCircle2, Clapperboard, Film, Hand, Hourglass, PauseCircle, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess, isOffice } from "@/lib/auth/access";
import { cn, nameColor } from "@/lib/utils";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { signupsNeedingReview } from "@/lib/stripeSignups";
import { dismissSignupReview, setRosterView } from "@/app/content/actions";
import { SweepButton } from "@/components/content/SweepButton";
import { BookOpen, Activity, LayoutGrid, ListChecks, Phone, Rows3, Settings2 } from "lucide-react";
import { statusLine } from "@/lib/contentStatusLine";
import { programOverview, ALL_OPEN, OVERVIEW_FILTERS, type OverviewFilterKey, type OverviewRow as Row } from "@/lib/programOverview";
import { OverviewRow } from "@/components/content/OverviewRow";
import { ClientMonthCard, PkgChip } from "@/components/content/ClientMonthCard";
import { contentHref, resolveRosterView, ROSTER_VIEW_COOKIE } from "@/lib/contentNav";
import { allAutomations } from "@/lib/programAutomation";
import { AUTOMATION_EFFECTS } from "@/lib/programAutomationCopy";

export const dynamic = "force-dynamic";

// Content Creator Program — the internal command view (spec §42–43).
//
// Oct 27 2026 (Jordan: "this is really messy ... all of these little chips
// ... make it look much nicer and easy to identify where people are at and
// what they're waiting on"; "The table looks okay"): the TABLE is the default
// and the cards one click away (remembered). Each client is one row with ONE
// status line ("Waiting on Bernadette: answer 1 topic"), and the list is
// grouped by who the month waits on: us, the client, or nobody. Filters show
// only when they hold something.
//
// UI-02 (Sep 24 2026): both views draw the SAME programOverview rows through
// the same overviewFacts(), so switching the layout can never change a number.
export default async function ContentProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; view?: string; filter?: string; ended?: string; test?: string }>;
}) {
  const sp = await searchParams;
  // House auth pattern: strict in prod (enforced), open in local dev.
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  // (The page-open full sweep was removed Aug 25 — the hourly cron owns it and
  // the header's "Sync now" button covers on-demand; running it per view was
  // why the tab felt slow — audit.)
  const remembered = (await cookies()).get(ROSTER_VIEW_COOKIE)?.value ?? null;
  const view = resolveRosterView(sp.view, remembered);
  // A bookmarked ?view= keeps winning while you click around the page.
  const explicitView = sp.view ? view : null;
  const includeEnded = sp.ended === "1";
  const includeTest = sp.test === "1";
  const monthParam = sp.month === ALL_OPEN ? ALL_OPEN : sp.month;
  const filter = OVERVIEW_FILTERS.some((f) => f.key === sp.filter) ? (sp.filter as OverviewFilterKey) : null;

  const now = new Date();
  // Money is the OWNER's view alone — admins and creatives never see billing.
  // (Open local dev counts as the owner, same as the feedback board's rule.)
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  // Website signups the activation sweep couldn't finish cleanly (guessed
  // terms, package conflicts, transient failures). Owner-only — the notes name
  // billing terms.
  const reviewSignups = ownerEyes ? await signupsNeedingReview().catch(() => []) : [];

  // THE one read, for both views, plus the automation switches — for a banner
  // only when one needs a look (Oct 13 2026, below).
  const [overview, switches] = await Promise.all([
    programOverview({ monthKey: monthParam, includeEnded, includeTest, now }),
    allAutomations().catch(() => []),
  ]);
  // Oct 13 2026: the banner used to list EVERY switched-on automation by its
  // internal key, on every load — permanent wallpaper once nearly all of them
  // were on. It now appears only when one needs a look: an automation that is
  // on and whose last run FAILED, or one that is on but does nothing because a
  // switch it depends on is TURNED OFF (the Settings panel's "on, but
  // blocked"). Named by title, not key.
  const isOn = (k: string) => switches.some((s) => s.key === k && s.enabled);
  const automationProblems = switches
    .filter((s) => s.enabled)
    .flatMap((s) => {
      const e = AUTOMATION_EFFECTS[s.key];
      const offDeps = (e.requires?.switches ?? []).filter((d) => !isOn(d));
      if (s.lastError) return [`${e.title}: last run failed`];
      if (offDeps.length) return [`${e.title}: does nothing while ${offDeps.map((d) => AUTOMATION_EFFECTS[d].title).join(" and ")} ${offDeps.length > 1 ? "are" : "is"} off`];
      return [];
    });
  const rows = overview.rows;
  const shown = filter ? rows.filter((r) => r.flags.includes(filter)) : rows;
  // Enrollment facts, counted once per client (an "all open months" view can
  // hold two rows for one client).
  const clientsWhere = (pred: (r: Row) => boolean) => new Set(rows.filter(pred).map((r) => r.enrollmentId)).size;
  const activeCount = clientsWhere((r) => r.enrollmentStatus === "ACTIVE" && !r.trial);
  const trialCount = clientsWhere((r) => r.enrollmentStatus === "ACTIVE" && r.trial);
  const statDelivered = rows.reduce((n, r) => n + r.production.delivered, 0);
  const statOwed = rows.reduce((n, r) => n + r.production.owed, 0);
  const selectedMonth = overview.monthKey;
  const allOpenView = selectedMonth === ALL_OPEN;
  const hrefFor = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const base: Record<string, string | null> = {
      month: monthParam ?? null, view: explicitView, filter, ended: includeEnded ? "1" : null, test: includeTest ? "1" : null, ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v) q.set(k, v);
    const qs = q.toString();
    return `/content${qs ? `?${qs}` : ""}`;
  };
  const showMonthOf = (r: Row) => allOpenView || r.monthKey !== selectedMonth;
  // Groups by who the month waits on (contentStatusLine.statusLine), in the
  // overview's own priority order. A filter is one flat answer instead.
  const live = rows.filter((r) => r.enrollmentStatus === "ACTIVE");
  const dormant = rows.filter((r) => r.enrollmentStatus !== "ACTIVE");
  const sideOf = (r: Row) => statusLine(r).side;
  const groups = {
    us: live.filter((r) => sideOf(r) === "us"),
    them: live.filter((r) => sideOf(r) === "them"),
    none: live.filter((r) => sideOf(r) === "none" || sideOf(r) === "closed"),
  };
  // Oct 27 2026: "Send reminder now" is client email, so the office's (isOffice).
  const canRemind = me ? isOffice(me.role) : !authEnforced();

  return (
    <div>
      <PageHeader
        eyebrow="Monthly content clients"
        title="Monthly Content"
        subtitle={allOpenView ? "every open month" : monthLabel(selectedMonth)}
        actions={
          <div className="flex items-center gap-1.5">
            {/* The layout switch is a tiny form: the choice is remembered (a
                cookie, set by a server action) so Kyle's table stays his. */}
            <form action={setRosterView}>
              <input type="hidden" name="view" value={view === "cards" ? "table" : "cards"} />
              {monthParam && <input type="hidden" name="month" value={monthParam} />}
              {filter && <input type="hidden" name="filter" value={filter} />}
              {includeEnded && <input type="hidden" name="ended" value="1" />}
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
                title={view === "cards" ? "Switch to the dense table" : "Switch to the client cards"}
              >
                {view === "cards" ? <><Rows3 className="size-3.5" /> <span className="hidden sm:inline">Table</span></> : <><LayoutGrid className="size-3.5" /> <span className="hidden sm:inline">Cards</span></>}
              </button>
            </form>
            <Link href="/content/resources" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
              <BookOpen className="size-3.5" /> <span className="hidden sm:inline">Resources</span>
            </Link>
            <Link href="/content/calls" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
              <Phone className="size-3.5" /> <span className="hidden sm:inline">Strategy calls</span>
            </Link>
            <Link href="/content/monitoring" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
              <Activity className="size-3.5" /> <span className="hidden sm:inline">Monitoring</span>
            </Link>
            <SweepButton />
          </div>
        }
      />
      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
        {/* WEBSITE SIGNUPS NEEDING A LOOK — payments Stripe confirmed that the
            activation sweep parked for a human (it keeps retrying failures on
            its own; this strip is how a parked one gets seen). */}
        {reviewSignups.length > 0 && (
          <div className="rounded-2xl border border-warning/40 bg-warning/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warning">
              <AlertTriangle className="size-4" /> Website signups needing a look
            </div>
            <ul className="space-y-2">
              {reviewSignups.map((sg) => (
                <li key={sg.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{sg.name ?? sg.email ?? "Unknown buyer"}</span>
                  <span className="text-muted">· {sg.productName}</span>
                  <span className="text-xs text-muted-2">
                    paid {sg.paidAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
                  </span>
                  {sg.enrollmentId && (
                    <Link href={contentHref(sg.enrollmentId)} className="text-xs font-medium text-brand hover:underline">Open →</Link>
                  )}
                  <form action={dismissSignupReview}>
                    <input type="hidden" name="id" value={sg.id} />
                    <button className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                      Got it
                    </button>
                  </form>
                  {sg.note && <span className="basis-full text-xs text-muted">{sg.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* AUTOMATION BANNER — only when an automation needs a look: its last
            run failed, or it is on but a switch it needs is off (see above). */}
        {automationProblems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-warning/50 bg-warning-soft/40 px-4 py-2.5 text-[13px]">
            <Settings2 className="size-4 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="font-semibold">{automationProblems.length === 1 ? "An automation needs a look:" : `${automationProblems.length} automations need a look:`}</span>{" "}
              {automationProblems.join(" · ")}
            </span>
            <Link href="/settings#program-automations" className="ml-auto shrink-0 font-medium text-brand hover:underline">Settings →</Link>
          </div>
        )}

        {/* THE MONTH IN FOUR NUMBERS, from the SAME read as the list below.
            Oct 27 2026: "Need attention" counted every flag (so nearly every
            client); the tiles now say who the month waits on. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={Users} label="Active clients" value={String(activeCount)} sub={trialCount > 0 ? `+ ${trialCount} on trial` : undefined} />
          <Stat
            icon={Film}
            // Named only when it is NOT the current month — a two-up tile on a
            // phone should not wrap for the common case.
            label={allOpenView ? "Videos, open months" : selectedMonth !== etMonthKey() ? `Videos · ${monthLabel(selectedMonth)}` : "Videos this month"}
            value={`${statDelivered}/${statOwed}`}
            tone={statOwed > 0 && statDelivered >= statOwed ? "success" : undefined}
          />
          <Stat icon={Hand} label="Waiting on us" value={String(groups.us.length)} />
          <Stat icon={Hourglass} label="Waiting on clients" value={String(groups.them.length)} />
        </div>

        {/* MONTH SELECTOR — the card or row you open keeps the month you chose. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Month</span>
          {overview.monthKeys.slice(0, 6).map((k) => (
            <Link
              key={k}
              href={hrefFor({ month: k === etMonthKey() ? null : k })}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium",
                selectedMonth === k ? "bg-brand-action text-white" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {monthLabel(k)}
            </Link>
          ))}
          <Link
            href={hrefFor({ month: ALL_OPEN })}
            title="every month that still carries an obligation — an August shortfall does not vanish because September started"
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium",
              allOpenView ? "bg-brand-action text-white" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            All open months
          </Link>
          <Link
            href={hrefFor({ ended: includeEnded ? null : "1" })}
            className={cn(
              "ml-auto rounded-lg px-2.5 py-1 text-xs font-medium",
              includeEnded ? "bg-surface-2 text-foreground" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            {includeEnded ? "Hide ended clients" : "Show ended clients"}
          </Link>
          {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
        </div>

        {/* FILTERS (Oct 27 2026: fewer chips). Only a filter with something
            in it is offered; the one in use always shows so it can be cleared. */}
        {(filter || OVERVIEW_FILTERS.some((f) => overview.counts[f.key] > 0)) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Show</span>
            <Link
              href={hrefFor({ filter: null })}
              className={cn("rounded-full px-2.5 py-1 text-xs font-medium", !filter ? "bg-foreground text-background" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground")}
            >
              Everyone <span className="ml-1 opacity-70">{rows.length}</span>
            </Link>
            {OVERVIEW_FILTERS.filter((f) => filter === f.key || overview.counts[f.key] > 0).map((f) => (
              <Link
                key={f.key}
                href={hrefFor({ filter: filter === f.key ? null : f.key })}
                title={f.hint}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium",
                  filter === f.key ? "bg-foreground text-background" : "border border-border text-foreground/80 hover:bg-surface-2",
                )}
              >
                {f.label} <span className="ml-1 opacity-70">{overview.counts[f.key]}</span>
              </Link>
            ))}
          </div>
        )}

        {/* THE LIST, grouped by who the month waits on (Oct 27 2026, Jordan:
            "easy to identify where people are at and what they're waiting
            on"). Table (the default) or cards, the same rows either way. */}
        {(filter
          ? [{ key: "filter", title: OVERVIEW_FILTERS.find((f) => f.key === filter)!.label, icon: ListChecks, rows: shown, hint: null as string | null }]
          : [
              { key: "us", title: "Waiting on us", icon: Hand, rows: groups.us, hint: "work the team owes" },
              { key: "them", title: "Waiting on the client", icon: Hourglass, rows: groups.them, hint: "they have something to do; reminders chase it" },
              { key: "none", title: "Nothing pending", icon: CheckCircle2, rows: groups.none, hint: null },
            ]
        ).filter((g) => g.rows.length > 0 || g.key === "filter").map((g) => (
          view === "table" ? (
            <Section key={g.key} icon={g.icon} title={g.title} count={g.rows.length} flush action={g.hint ? <span className="hidden text-xs text-muted-2 sm:inline">{g.hint}</span> : undefined}>
              <div>
                {/* the month is named on the row whenever it is not the one selected */}
                {g.rows.map((r) => <OverviewRow key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} now={now} canRemind={canRemind} />)}
                {g.rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">Nothing matches that filter, which is the good answer.</p>}
              </div>
            </Section>
          ) : (
            <div key={g.key}>
              <SectionLabel icon={g.icon} text={g.title} count={g.rows.length} hint={g.hint ?? undefined} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {g.rows.map((r) => <ClientMonthCard key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} now={now} canRemind={canRemind} />)}
              </div>
              {g.rows.length === 0 && <p className="text-sm text-muted">Nothing matches that filter, which is the good answer.</p>}
            </div>
          )
        ))}
        {!filter && live.length === 0 && <p className="text-sm text-muted">No client-months in view.</p>}

        {/* PAUSED & ENDED — kept compact, never mixed into the live list. */}
        {!filter && dormant.length > 0 && (
          <Section icon={PauseCircle} title={includeEnded ? "Paused and ended clients" : "Paused clients"} count={dormant.length} flush
            action={<span className="text-xs text-muted-2">full history inside each</span>}>
            <div className="divide-y divide-border">
              {dormant.map((r) => (
                <Link key={`${r.enrollmentId}:${r.monthKey}`} href={contentHref(r.enrollmentId, { month: r.monthKey })} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2/60">
                  <Avatar name={r.clientName} color={nameColor(r.clientName)} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/75">{r.clientName}</span>
                  <PkgChip pkg={r.pkg} />
                  <span className="hidden w-32 shrink-0 text-right text-xs text-muted-2 sm:block">{r.monthStatus === "NONE" ? "no workspace" : r.monthName}</span>
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{r.enrollmentStatus === "ENDED" ? "Ended" : "Paused"}</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {overview.globalFailures.length > 0 && (
          <div className="rounded-2xl border border-warning/40 bg-warning/5 p-4 text-[13px]">
            <div className="mb-1 flex items-center gap-2 font-semibold text-warning"><AlertTriangle className="size-4" /> Failures not tied to one client</div>
            <ul className="space-y-0.5">
              {overview.globalFailures.slice(0, 5).map((f) => (
                <li key={f.ref}><Link href={f.href} className="hover:underline">{f.title}</Link> <span className="text-muted-2">— {f.error.slice(0, 100)}</span></li>
              ))}
            </ul>
          </div>
        )}

        {/* (The owner's "Revenue & billing" panel was HIDDEN Oct 13 2026: its
            "collected" column was every QuickBooks payment, and Jordan does not
            use QuickBooks, so it read $0 or stale for everyone. A client's
            terms are still on their Settings tab; lib/contentBilling.ts is kept.) */}

        <p className="text-xs text-muted-2">
          <Clapperboard className="mr-1 inline size-3.5" />
          Clients join automatically from the Aryeo &ldquo;Social Client&rdquo; flag. Sessions are confirmed appointments and videos are counted from the library, the same reading the client file, their portal and the reminders use.
        </p>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone, sub }: { icon: typeof Users; label: string; value: string; tone?: "warning" | "success" | "brand"; sub?: string }) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn("mt-1 text-xl font-semibold tracking-tight", tone === "warning" && "text-warning", tone === "success" && "text-success", tone === "brand" && "text-brand")}>
        {value}
        {sub && <span className="ml-1.5 text-xs font-normal text-muted">{sub}</span>}
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, text, count, hint }: { icon: typeof Users; text: string; count: number; hint?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="size-4 text-muted" />
      <h2 className="text-sm font-semibold">{text}</h2>
      <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{count}</span>
      {hint && <span className="ml-auto text-[11px] text-muted-2">{hint}</span>}
    </div>
  );
}

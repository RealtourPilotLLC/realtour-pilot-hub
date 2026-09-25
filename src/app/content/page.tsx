import Link from "next/link";
import { cookies } from "next/headers";
import { AlertTriangle, CheckCircle2, Clapperboard, Film, FlaskConical, PauseCircle, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { cn, nameColor } from "@/lib/utils";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { programRevenue, billingLabel, agreementValue, type RevenueRow } from "@/lib/contentBilling";
import { signupsNeedingReview } from "@/lib/stripeSignups";
import { dismissSignupReview, setRosterView } from "@/app/content/actions";
import { SweepButton } from "@/components/content/SweepButton";
import { BadgeDollarSign, BookOpen, ChevronDown, Activity, LayoutGrid, ListChecks, Rows3, Settings2 } from "lucide-react";
import { programOverview, ALL_OPEN, OVERVIEW_FILTERS, type OverviewFilterKey, type OverviewRow as Row } from "@/lib/programOverview";
import { OverviewRow } from "@/components/content/OverviewRow";
import { ClientMonthCard, PkgChip } from "@/components/content/ClientMonthCard";
import { contentHref, resolveRosterView, ROSTER_VIEW_COOKIE } from "@/lib/contentNav";
import { allAutomations } from "@/lib/programAutomation";

export const dynamic = "force-dynamic";

// Content Creator Program — the internal command view (spec §42–43).
//
// UI-02 (Sep 24 2026): CARDS are the default again — one per client-month,
// with the compact month tracker, the next action, who holds it, when it is
// due and the one exception worth a glance — and Kyle's dense TABLE is one
// click away (and remembered). Both views draw the SAME programOverview rows
// through the same overviewFacts(), so switching the layout can never change
// a number. The Aug-25 cards used to come from a second engine
// (getProgramRoster) and disagreed with the rows by construction; the month
// selector, the filters and the header numbers now serve both views.
export default async function ContentProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; view?: string; filter?: string; ended?: string }>;
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
  const monthParam = sp.month === ALL_OPEN ? ALL_OPEN : sp.month;
  const filter = OVERVIEW_FILTERS.some((f) => f.key === sp.filter) ? (sp.filter as OverviewFilterKey) : null;

  const now = new Date();
  // Money is the OWNER's view alone — admins and creatives never see billing.
  // (Open local dev counts as the owner, same as the feedback board's rule.)
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  const revenue = ownerEyes ? await programRevenue().catch(() => null) : null;
  // Website signups the activation sweep couldn't finish cleanly (guessed
  // terms, package conflicts, transient failures). Owner-only — the notes name
  // billing terms.
  const reviewSignups = ownerEyes ? await signupsNeedingReview().catch(() => []) : [];

  // THE one read, for both views, plus the automation switches (a banner when
  // ANY is on, so nobody is surprised that something is acting on its own).
  const [overview, switches] = await Promise.all([
    programOverview({ monthKey: monthParam, includeEnded, now }),
    allAutomations().catch(() => []),
  ]);
  const switchedOn = switches.filter((s) => s.enabled);
  const rows = overview.rows;
  const shown = filter ? rows.filter((r) => r.flags.includes(filter)) : rows;
  // Enrollment facts, counted once per client (an "all open months" view can
  // hold two rows for one client).
  const clientsWhere = (pred: (r: Row) => boolean) => new Set(rows.filter(pred).map((r) => r.enrollmentId)).size;
  const activeCount = clientsWhere((r) => r.enrollmentStatus === "ACTIVE" && !r.trial);
  const trialCount = clientsWhere((r) => r.enrollmentStatus === "ACTIVE" && r.trial);
  const statDelivered = rows.reduce((n, r) => n + r.production.delivered, 0);
  const statOwed = rows.reduce((n, r) => n + r.production.owed, 0);
  const statAttention = rows.filter((r) => r.flags.length > 0).length;
  const selectedMonth = overview.monthKey;
  const allOpenView = selectedMonth === ALL_OPEN;
  const hrefFor = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const base: Record<string, string | null> = {
      month: monthParam ?? null, view: explicitView, filter, ended: includeEnded ? "1" : null, ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v) q.set(k, v);
    const qs = q.toString();
    return `/content${qs ? `?${qs}` : ""}`;
  };
  const showMonthOf = (r: Row) => allOpenView || r.monthKey !== selectedMonth;
  // Card groups — only when no filter narrows the list (a filter is one flat answer).
  const liveActive = shown.filter((r) => r.enrollmentStatus === "ACTIVE" && !r.trial);
  const liveTrials = shown.filter((r) => r.enrollmentStatus === "ACTIVE" && r.trial);
  const dormant = shown.filter((r) => r.enrollmentStatus !== "ACTIVE");

  return (
    <div>
      <PageHeader
        eyebrow="Monthly content clients"
        title="Content Program"
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

        {/* AUTOMATION BANNER — nothing on this program runs by itself unless a
            person switched it on; when one IS on, everybody looking at this
            page can see it and where to turn it off. */}
        {switchedOn.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-brand/40 bg-brand-soft/40 px-4 py-2.5 text-[13px]">
            <Settings2 className="size-4 shrink-0 text-brand" />
            <span>
              <span className="font-semibold">{switchedOn.length} automation{switchedOn.length === 1 ? " is" : "s are"} switched on:</span>{" "}
              {switchedOn.map((s) => s.key.replace(/_/g, " ")).join(", ")}
            </span>
            <Link href="/settings#program-automations" className="ml-auto shrink-0 font-medium text-brand hover:underline">Settings →</Link>
          </div>
        )}

        {/* THE MONTH IN FOUR NUMBERS — from the SAME read as the list below,
            whichever layout is on screen. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={Users} label="Active clients" value={String(activeCount)} />
          <Stat icon={FlaskConical} label="On trial" value={String(trialCount)} tone={trialCount > 0 ? "brand" : undefined} />
          <Stat
            icon={Film}
            // Named only when it is NOT the current month — a two-up tile on a
            // phone should not wrap for the common case.
            label={allOpenView ? "Videos, open months" : selectedMonth !== etMonthKey() ? `Videos · ${monthLabel(selectedMonth)}` : "Videos this month"}
            value={`${statDelivered}/${statOwed}`}
            tone={statOwed > 0 && statDelivered >= statOwed ? "success" : undefined}
          />
          <Stat icon={AlertTriangle} label="Need attention" value={String(statAttention)} tone={statAttention > 0 ? "warning" : "success"} />
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
                selectedMonth === k ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
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
              allOpenView ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
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
        </div>

        {/* FILTERS — every one is a real count, so a zero is an answer. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={hrefFor({ filter: null })}
            className={cn("rounded-full px-2.5 py-1 text-xs font-medium", !filter ? "bg-foreground text-background" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground")}
          >
            Everything <span className="ml-1 opacity-70">{rows.length}</span>
          </Link>
          {OVERVIEW_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={hrefFor({ filter: filter === f.key ? null : f.key })}
              title={f.hint}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                filter === f.key ? "bg-foreground text-background" : overview.counts[f.key] > 0 ? "border border-border text-foreground/80 hover:bg-surface-2" : "border border-border text-muted-2 hover:bg-surface-2",
              )}
            >
              {f.label} <span className="ml-1 opacity-70">{overview.counts[f.key]}</span>
            </Link>
          ))}
        </div>

        {/* ---------- THE DENSE TABLE (Kyle's view) ---------- */}
        {view === "table" && (
          <Section
            icon={ListChecks}
            title={filter ? OVERVIEW_FILTERS.find((f) => f.key === filter)!.label : allOpenView ? "Every open month" : monthLabel(selectedMonth)}
            count={shown.length}
            flush
            action={<span className="hidden text-[11px] text-muted-2 sm:inline">highest-priority first · open a row for the whole month</span>}
          >
            <div>
              {/* the month is named on the row whenever it is not the one selected — an ended client is shown against their LAST month, not an empty September. */}
              {shown.map((r) => <OverviewRow key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} />)}
              {shown.length === 0 && (
                <p className="px-5 py-6 text-sm text-muted">
                  {filter ? "Nothing matches that filter — which is the good answer." : "No client-months in view."}
                </p>
              )}
            </div>
          </Section>
        )}

        {/* ---------- THE CARDS (the default) ---------- */}
        {view === "cards" && (filter ? (
          <div>
            <SectionLabel icon={ListChecks} text={OVERVIEW_FILTERS.find((f) => f.key === filter)!.label} count={shown.length} />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((r) => <ClientMonthCard key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} />)}
            </div>
            {shown.length === 0 && <p className="text-sm text-muted">Nothing matches that filter — which is the good answer.</p>}
          </div>
        ) : (
          <>
            {/* ACTIVE CLIENTS — highest priority first (the overview's own sort). */}
            <div>
              <SectionLabel icon={Users} text={`Active clients — ${allOpenView ? "every open month" : monthLabel(selectedMonth)}`} count={liveActive.length} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {liveActive.map((r) => <ClientMonthCard key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} />)}
              </div>
              {liveActive.length === 0 && <p className="text-sm text-muted">No active clients in view.</p>}
            </div>

            {/* TRIAL CLIENTS — their own row so trial QC gets its own focus */}
            {liveTrials.length > 0 && (
              <div>
                <SectionLabel icon={FlaskConical} text="Trial clients" count={liveTrials.length} hint="one-month trials — make these land" />
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {liveTrials.map((r) => <ClientMonthCard key={`${r.enrollmentId}:${r.monthKey}`} r={r} showMonth={showMonthOf(r)} />)}
                </div>
              </div>
            )}

            {liveActive.length + liveTrials.length > 0 && [...liveActive, ...liveTrials].every((r) => r.flags.length === 0) && (
              <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> Every enrolled client is on track this month.</p>
            )}

            {/* PAUSED & ENDED — the same rows (paused always, ended when asked for), kept compact. */}
            {dormant.length > 0 && (
              <Section icon={PauseCircle} title={includeEnded ? "Paused & ended clients" : "Paused clients"} count={dormant.length} flush
                action={<span className="text-[11px] text-muted-2">full history inside each</span>}>
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
          </>
        ))}

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

        {/* REVENUE & BILLING — owner-only, collapsed until asked for (Jordan
            Aug 25: "how much we are making off each person and if they paid in
            full, paid monthly, or monthly with a 1yr contract"). */}
        {revenue && revenue.length > 0 && <RevenuePanel rows={revenue} />}

        <p className="text-xs text-muted-2">
          <Clapperboard className="mr-1 inline size-3.5" />
          Enrollment follows the Aryeo &ldquo;Social Client&rdquo; flag automatically; sessions are distinct confirmed appointments and videos are counted from the library — the same month-progress reader the client file, their portal and the reminders use. Cards and table are one calculation.
        </p>
      </div>
    </div>
  );
}

// Owner-only money panel: one row per active client — the terms as signed,
// and what QuickBooks has actually collected from them this year (all
// services, deliberately: it answers "how much do we make off this person").
function RevenuePanel({ rows }: { rows: RevenueRow[] }) {
  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const collected = rows.reduce((s, r) => s + r.collectedThisYear, 0);
  const recurring = rows
    .filter((r) => r.billingType === "MONTHLY_CONTRACT" || r.billingType === "MONTH_TO_MONTH")
    .reduce((s, r) => s + (r.billingRate ?? 0), 0);
  const TYPE_CHIP: Record<string, string> = {
    PAID_IN_FULL: "bg-success/15 text-success",
    MONTHLY_CONTRACT: "bg-brand/15 text-brand",
    MONTH_TO_MONTH: "bg-[#8b93e6]/20 text-[#8b93e6]",
    TRIAL: "bg-warning/15 text-warning",
  };
  return (
    <details className="group panel-shadow overflow-hidden rounded-2xl border bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-3 hover:bg-surface-2">
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        <span className="flex size-7 items-center justify-center rounded-lg bg-success/15 text-success"><BadgeDollarSign className="size-4" /></span>
        <h2 className="text-sm font-semibold">Revenue &amp; billing</h2>
        <span className="ml-auto text-xs text-muted">
          <span className="font-semibold text-foreground">{money(collected)}</span> collected this year · {money(recurring)}/mo recurring
        </span>
      </summary>
      <div className="divide-y divide-border border-t border-border">
        {rows.map((r) => {
          const value = agreementValue(r.billingType, r.billingRate, r.billingMonths);
          return (
            <Link key={r.enrollmentId} href={contentHref(r.enrollmentId, { tab: "settings" })} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 hover:bg-surface-2/60">
              <Avatar name={r.clientName} color={nameColor(r.clientName)} size={24} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.clientName}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TYPE_CHIP[r.billingType ?? ""] ?? "bg-surface-2 text-muted-2")}>
                {billingLabel(r.billingType, r.billingRate, r.billingMonths)}
              </span>
              {value != null && <span className="hidden text-[11px] text-muted-2 sm:inline">agreement {money(value)}</span>}
              <span className={cn("w-28 shrink-0 text-right text-sm font-semibold tabular-nums", r.collectedThisYear === 0 && "text-warning")}>
                {money(r.collectedThisYear)}
                <span className="ml-1 text-[10px] font-normal text-muted-2">this yr</span>
              </span>
            </Link>
          );
        })}
      </div>
      <p className="border-t border-border px-5 py-2 text-[11px] text-muted-2">
        Collected = every QuickBooks payment from this person in {new Date().getFullYear()} (all services, not just content). $0 on a trial = not invoiced or not paid yet. Edit terms on the client&rsquo;s Settings tab.
      </p>
    </details>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Users; label: string; value: string; tone?: "warning" | "success" | "brand" }) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn("mt-1 text-xl font-semibold tracking-tight", tone === "warning" && "text-warning", tone === "success" && "text-success", tone === "brand" && "text-brand")}>
        {value}
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

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clapperboard, Film, FlaskConical, PauseCircle, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { cn, nameColor } from "@/lib/utils";
import { getProgramRoster, monthLabel, etMonthKey, type ProgramRow } from "@/lib/contentProgram";
import { programRevenue, billingLabel, agreementValue, type RevenueRow } from "@/lib/contentBilling";
import { signupsNeedingReview } from "@/lib/stripeSignups";
import { dismissSignupReview } from "@/app/content/actions";
import { MonthJourney, VideoMeter } from "@/components/content/MonthJourney";
import { SweepButton } from "@/components/content/SweepButton";
import { BadgeDollarSign, ChevronDown } from "lucide-react";

export const dynamic = "force-dynamic";

// Content Creator Program — the internal command view (spec §42–43), redesigned
// Aug 25 per Jordan: one visual CARD per client instead of a spreadsheet table.
// Each card is the client's month at a glance — the journey tracker (Call →
// Topics → Scripts → Shoot → Delivered), the delivered-videos meter, and any
// exceptions. Everything reads from the SAME pipeline data as the Editor Queue
// and Review Room, so this page can't disagree with them.
export default async function ContentProgramPage() {
  // House auth pattern: strict in prod (enforced), open in local dev.
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  // (The page-open full sweep was removed Aug 25 — the hourly cron owns it and
  // the header's "Sync now" button covers on-demand; running it per view was
  // why the tab felt slow — audit.)
  const rows = await getProgramRoster();
  const active = rows.filter((r) => r.status === "ACTIVE" && !r.trial);
  const trials = rows.filter((r) => r.status === "ACTIVE" && r.trial);
  const inactive = rows.filter((r) => r.status !== "ACTIVE");
  const live = [...active, ...trials];
  const attention = live.filter((r) => r.attention.length > 0);
  const delivered = live.reduce((s, r) => s + r.delivered, 0);
  const owed = live.reduce((s, r) => s + r.videosOwed, 0);
  // Money is the OWNER's view alone — admins and creatives never see billing.
  // (Open local dev counts as the owner, same as the feedback board's rule.)
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  const revenue = ownerEyes ? await programRevenue().catch(() => null) : null;
  // Website signups the activation sweep couldn't finish cleanly (guessed
  // terms, package conflicts, transient failures). Owner-only — the notes name
  // billing terms.
  const reviewSignups = ownerEyes ? await signupsNeedingReview().catch(() => []) : [];

  return (
    <div>
      <PageHeader
        eyebrow="Monthly content clients"
        title="Content Program"
        subtitle={monthLabel(etMonthKey())}
        actions={<SweepButton />}
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
                    <Link href={`/content/${sg.enrollmentId}`} className="text-xs font-medium text-brand hover:underline">Open →</Link>
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

        {/* THE MONTH IN FOUR NUMBERS */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={Users} label="Active clients" value={String(active.length)} />
          <Stat icon={FlaskConical} label="On trial" value={String(trials.length)} tone={trials.length > 0 ? "brand" : undefined} />
          <Stat icon={Film} label="Videos this month" value={`${delivered}/${owed}`} tone={owed > 0 && delivered >= owed ? "success" : undefined} />
          <Stat icon={AlertTriangle} label="Need attention" value={String(attention.length)} tone={attention.length > 0 ? "warning" : "success"} />
        </div>

        {/* ACTIVE CLIENTS — one card per client, problems sorted first */}
        <div>
          <SectionLabel icon={Users} text={`Active clients — ${monthLabel(etMonthKey())}`} count={active.length} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {active.map((r) => <ClientCard key={r.enrollmentId} r={r} />)}
          </div>
          {active.length === 0 && <p className="text-sm text-muted">No active clients this month.</p>}
        </div>

        {/* TRIAL CLIENTS — their own row so trial QC gets its own focus */}
        {trials.length > 0 && (
          <div>
            <SectionLabel icon={FlaskConical} text="Trial clients" count={trials.length} hint="one-month trials — make these land" />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {trials.map((r) => <ClientCard key={r.enrollmentId} r={r} />)}
            </div>
          </div>
        )}

        {live.length > 0 && attention.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> Every enrolled client is on track this month.</p>
        )}

        {/* REVENUE & BILLING — owner-only, collapsed until asked for (Jordan
            Aug 25: "how much we are making off each person and if they paid in
            full, paid monthly, or monthly with a 1yr contract"). */}
        {revenue && revenue.length > 0 && <RevenuePanel rows={revenue} />}

        {/* PAUSED & PAST — history stays one click away without cluttering the month */}
        {inactive.length > 0 && (
          <Section icon={PauseCircle} title="Paused & past clients" count={inactive.length} flush
            action={<span className="text-[11px] text-muted-2">full history inside each</span>}>
            <div className="divide-y divide-border">
              {inactive.map((r) => (
                <Link key={r.enrollmentId} href={`/content/${r.enrollmentId}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2/60">
                  <Avatar name={r.clientName} color={nameColor(r.clientName)} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/75">{r.clientName}</span>
                  <PkgChip pkg={r.pkg} />
                  <span className="hidden w-32 shrink-0 text-right text-xs text-muted-2 sm:block">
                    {r.lastMonthKey ? `last: ${monthLabel(r.lastMonthKey)}` : "no content yet"}
                  </span>
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">Paused</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        <p className="text-xs text-muted-2">
          <Clapperboard className="mr-1 inline size-3.5" />
          Enrollment follows the Aryeo &ldquo;Social Client&rdquo; flag automatically; sessions and videos read from the same pipeline as the Editor Queue and Review Room.
        </p>
      </div>
    </div>
  );
}

// One client's month, as a card: identity → journey → meter → exceptions.
function ClientCard({ r }: { r: ProgramRow }) {
  const worry = r.attention.length > 0;
  return (
    <Link
      href={`/content/${r.enrollmentId}`}
      className={cn(
        "panel-shadow group flex flex-col gap-3.5 rounded-2xl border bg-surface p-4 transition-colors hover:border-brand/40",
        worry && "border-warning/35",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={r.clientName} color={nameColor(r.clientName)} size={34} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold group-hover:text-brand">{r.clientName}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <PkgChip pkg={r.pkg} />
            {r.trial && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">Trial</span>}
          </div>
        </div>
      </div>

      <MonthJourney
        input={{
          callStatus: r.strategyCallStatus,
          topicsSelected: r.topicsSelected,
          scriptsReady: r.scriptsReady,
          videosOwed: r.videosOwed,
          sessionsScheduled: r.sessionsScheduled,
          sessionsRequired: r.sessionsRequired,
          shotCount: r.shotCount,
          delivered: r.delivered,
          inReview: r.inReview,
        }}
      />

      <VideoMeter delivered={r.delivered} owed={r.videosOwed} inReview={r.inReview} />

      {worry ? (
        <div className="space-y-0.5 border-t border-border pt-2.5">
          {r.attention.slice(0, 2).map((a, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{a}</span>
            </p>
          ))}
          {r.attention.length > 2 && <p className="pl-4.5 text-[11px] text-warning/80">+{r.attention.length - 2} more</p>}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 border-t border-border pt-2.5 text-[11px] text-success">
          <CheckCircle2 className="size-3" /> On track
        </p>
      )}
    </Link>
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
            <Link key={r.enrollmentId} href={`/content/${r.enrollmentId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 hover:bg-surface-2/60">
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
        Collected = every QuickBooks payment from this person in {new Date().getFullYear()} (all services, not just content). $0 on a trial = not invoiced or not paid yet. Edit terms inside the client&rsquo;s Notes &amp; settings tab.
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

function PkgChip({ pkg }: { pkg: string }) {
  const color = pkg === "Pro" ? "#a78bfa" : pkg === "Starter" ? "#38bdf8" : "#f59e0b";
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${color}26`, color }}>
      {pkg}
    </span>
  );
}

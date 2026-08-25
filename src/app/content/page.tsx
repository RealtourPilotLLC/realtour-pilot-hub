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
import { contentProgramSweep, getProgramRoster, monthLabel, etMonthKey, type ProgramRow } from "@/lib/contentProgram";
import { MonthJourney, VideoMeter } from "@/components/content/MonthJourney";
import { SweepButton } from "@/components/content/SweepButton";

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
  // Self-maintaining: opening the page runs the same sweep the nightly cron
  // does (enrollments ↔ Aryeo flag, current months, project attachment).
  await contentProgramSweep().catch(() => null);
  const rows = await getProgramRoster();
  const active = rows.filter((r) => r.status === "ACTIVE" && !r.trial);
  const trials = rows.filter((r) => r.status === "ACTIVE" && r.trial);
  const inactive = rows.filter((r) => r.status !== "ACTIVE");
  const live = [...active, ...trials];
  const attention = live.filter((r) => r.attention.length > 0);
  const delivered = live.reduce((s, r) => s + r.delivered, 0);
  const owed = live.reduce((s, r) => s + r.videosOwed, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Monthly content clients"
        title="Content Program"
        subtitle={monthLabel(etMonthKey())}
        actions={<SweepButton />}
      />
      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
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

import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, Clapperboard, Film, ListChecks, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { contentProgramSweep, getProgramRoster, monthLabel, etMonthKey } from "@/lib/contentProgram";
import { SweepButton } from "@/components/content/SweepButton";

export const dynamic = "force-dynamic";

// Content Creator Program — the internal command view (spec §42–43).
// One row per enrolled client; the month's live state is derived from the
// SAME pipeline data as everywhere else (attached Projects, ReviewSubmissions),
// so this page can't disagree with the Editor Queue or Review Room.
const CALL_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "muted" }> = {
  NOT_REQUIRED: { text: "No call needed", tone: "muted" },
  NOT_SCHEDULED: { text: "Call not scheduled", tone: "warn" },
  SCHEDULED: { text: "Call scheduled", tone: "ok" },
  COMPLETED: { text: "Call done", tone: "ok" },
  SKIPPED: { text: "Call skipped", tone: "muted" },
};

export default async function ContentProgramPage() {
  // House auth pattern: strict in prod (enforced), open in local dev.
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  // Self-maintaining: opening the page runs the same sweep the nightly cron
  // does (enrollments ↔ Aryeo flag, current months, project attachment).
  await contentProgramSweep().catch(() => null);
  const rows = await getProgramRoster();
  const attention = rows.filter((r) => r.attention.length > 0 && r.status === "ACTIVE");
  const paused = rows.filter((r) => r.status === "PAUSED");

  return (
    <div>
      <PageHeader
        eyebrow={monthLabel(etMonthKey())}
        title="Content Program"
        subtitle={`${rows.filter((r) => r.status === "ACTIVE").length} enrolled clients · ${attention.length} need attention`}
        actions={<SweepButton />}
      />
      <div className="mx-auto max-w-6xl space-y-5 p-4 pb-16 sm:p-6">
        {/* NEEDS ATTENTION — exceptions outrank healthy work (spec §43) */}
        {attention.length > 0 && (
          <Section icon={AlertTriangle} title="Needs attention" count={attention.length} tone="warning" flush>
            <div className="divide-y divide-border">
              {attention.map((r) => (
                <Link key={r.enrollmentId} href={`/content/${r.enrollmentId}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.clientName}</span>
                      <PkgChip pkg={r.pkg} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-warning">
                      {r.attention.map((a, i) => (<span key={i}>· {a}</span>))}
                    </div>
                  </div>
                  <MonthMeter r={r} />
                </Link>
              ))}
            </div>
          </Section>
        )}

        {/* FULL ROSTER */}
        <Section icon={Users} title="All clients" count={rows.length} flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                  <th className="px-5 py-2.5">Client</th>
                  <th className="px-3 py-2.5">Package</th>
                  <th className="px-3 py-2.5">Strategy call</th>
                  <th className="px-3 py-2.5">Sessions</th>
                  <th className="px-3 py-2.5">Topics</th>
                  <th className="px-3 py-2.5">Scripts</th>
                  <th className="px-3 py-2.5">Videos</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const call = CALL_LABEL[r.strategyCallStatus] ?? CALL_LABEL.NOT_SCHEDULED;
                  return (
                    <tr key={r.enrollmentId} className={r.status === "PAUSED" ? "opacity-50" : undefined}>
                      <td className="px-5 py-3">
                        <Link href={`/content/${r.enrollmentId}`} className="font-medium hover:text-brand">{r.clientName}</Link>
                        {r.status === "PAUSED" && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">Paused</span>}
                      </td>
                      <td className="px-3 py-3"><PkgChip pkg={r.pkg} /></td>
                      <td className="px-3 py-3">
                        <span className={call.tone === "warn" ? "text-warning" : call.tone === "ok" ? "text-success" : "text-muted-2"}>
                          <CalendarClock className="mr-1 inline size-3.5" />{call.text}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className={r.sessionsScheduled < r.sessionsRequired && r.status === "ACTIVE" ? "text-warning" : "text-foreground/85"}>
                          {r.sessionsScheduled}/{r.sessionsRequired}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className={r.topicsSelected === 0 && r.status === "ACTIVE" ? "text-warning" : "text-foreground/85"}>
                          <ListChecks className="mr-1 inline size-3.5 text-muted-2" />{r.topicsSelected}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-foreground/85">{r.scriptsReady}</td>
                      <td className="px-3 py-3">
                        <span className="text-foreground/85">
                          <Film className="mr-1 inline size-3.5 text-muted-2" />
                          {r.delivered}/{r.videosOwed}
                          {r.inReview > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">{r.inReview} in review</span>}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Link href={`/content/${r.enrollmentId}`} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        {paused.length === 0 && attention.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> Every enrolled client is on track this month.</p>
        )}
        <p className="text-xs text-muted-2">
          <Clapperboard className="mr-1 inline size-3.5" />
          Enrollment follows the Aryeo &ldquo;Social Client&rdquo; flag automatically; sessions and videos read from the same pipeline as the Editor Queue and Review Room.
        </p>
      </div>
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

function MonthMeter({ r }: { r: { delivered: number; videosOwed: number } }) {
  return (
    <span className="shrink-0 text-xs text-muted">
      {r.delivered}/{r.videosOwed} delivered
    </span>
  );
}

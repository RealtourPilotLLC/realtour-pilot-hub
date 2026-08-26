import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Camera, CalendarDays, Compass, FileText, Lightbulb, Settings2, User,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/ui/BackLink";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { etMonthKey, monthLabel } from "@/lib/contentProgram";
import { stageMeta } from "@/lib/pipeline";
import { Badge } from "@/components/ui/Badge";
import { MonthJourney } from "@/components/content/MonthJourney";
import {
  EnrollmentSettingsCard, StrategyCallCard, StrategyCard, TopicBank, ScriptBackfillCard, ProfileSections, NotesCard, ScriptReview, TopicSeedButton,
} from "@/components/content/Workspace";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";

export const dynamic = "force-dynamic";

// One Content Creator client's workspace — reorganized Aug 25 per Jordan into
// TABS so it stops being a wall of ten stacked cards. "This month" is the
// working view (journey hero + call + sessions + topics); Scripts is the
// approve / AI-revise / edit loop; the bank, strategy+profile, and
// notes+settings each get their own room. The month rail scopes This month and
// Scripts; production state still comes from attached Projects — the same
// pipeline rows the Editor Queue reads.
type Tab = "month" | "scripts" | "topics" | "profile" | "notes";
const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: "month", label: "This month", icon: CalendarDays },
  { key: "scripts", label: "Scripts", icon: FileText },
  { key: "topics", label: "Topic bank", icon: Lightbulb },
  { key: "profile", label: "Strategy & profile", icon: Compass },
  { key: "notes", label: "Notes & settings", icon: Settings2 },
];

export default async function ContentClientPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; tab?: string }>;
}) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  const { id } = await params;
  const { month: monthParam, tab: tabParam } = await searchParams;
  const tab: Tab = (TABS.some((t) => t.key === tabParam) ? tabParam : "month") as Tab;

  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id } });
  if (!enrollment) notFound();
  const client = await prisma.client.findUnique({
    where: { id: enrollment.clientId },
    select: { id: true, name: true, email: true, phone: true, company: true, editingPreferences: true },
  });
  if (!client) notFound();

  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: id },
    orderBy: { monthKey: "desc" },
  });
  const activeKey = monthParam && months.some((m) => m.monthKey === monthParam) ? monthParam : etMonthKey();
  const month = months.find((m) => m.monthKey === activeKey) ?? months[0] ?? null;

  const [projects, topics, bankTopics, scripts, profile, notes, strategy] = await Promise.all([
    month
      ? prisma.project.findMany({
          where: { contentMonthId: month.id },
          select: {
            id: true, title: true, status: true, shootDate: true,
            photographer: { select: { name: true } },
            reviewSubmissions: { select: { status: true } },
            deliverables: { select: { type: true, quantity: true } },
          },
          orderBy: { shootDate: "asc" },
        })
      : Promise.resolve([]),
    month ? prisma.contentTopic.findMany({ where: { monthId: month.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    prisma.contentTopic.findMany({ where: { enrollmentId: id, monthId: null, status: { notIn: ["REJECTED", "ARCHIVED"] } }, orderBy: { createdAt: "desc" }, take: 40 }),
    month ? prisma.contentScript.findMany({ where: { monthId: month.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    prisma.agentProfile.findUnique({ where: { clientId: client.id } }),
    prisma.contentNote.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.contentStrategy.findFirst({ where: { enrollmentId: id, status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
  ]);
  let strategySections: Record<string, string> = {};
  try { strategySections = strategy ? JSON.parse(strategy.sectionsJson) : {}; } catch { strategySections = {}; }

  // The journey hero's counts — the SAME status filters the dashboard roster
  // uses, so the tracker here always matches the client's card out front.
  const now = new Date();
  // Cancelled sessions don't count as booked; delivered counts VIDEO UNITS —
  // the same two rules as the dashboard roster (audit Aug 25).
  const liveProjects = projects.filter((p) => p.status !== "CANCELLED");
  const journey = month
    ? {
        callStatus: month.strategyCallStatus,
        topicsSelected: topics.filter((t) => ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status)).length,
        scriptsReady: scripts.filter((s) => ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"].includes(s.status)).length,
        videosOwed: month.videosOwed,
        sessionsScheduled: liveProjects.length,
        sessionsRequired: enrollment.sessionsPerMonth,
        shotCount: liveProjects.filter((p) => p.shootDate && p.shootDate < now).length,
        delivered: liveProjects
          .filter((p) => p.status === "DELIVERED")
          .reduce((s, p) => s + Math.max(1, p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0)), 0),
        inReview: liveProjects.reduce((s, p) => s + p.reviewSubmissions.filter((r) => r.status === "PENDING").length, 0),
        muted: month.historical,
      }
    : null;
  const scriptsAwaiting = scripts.filter((s) => s.status === "INTERNAL_REVIEW" || s.status === "DRAFT").length;

  // Tab + month links preserve each other, so switching one never resets the other.
  const hrefFor = (t: Tab, mKey?: string) => {
    const q = new URLSearchParams();
    const mk = mKey ?? (month?.monthKey ?? "");
    if (mk && mk !== etMonthKey()) q.set("month", mk);
    if (t !== "month") q.set("tab", t);
    const qs = q.toString();
    return `/content/${id}${qs ? `?${qs}` : ""}`;
  };

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader
        eyebrow={`${enrollment.package} · ${enrollment.videosPerMonth} videos / ${enrollment.sessionsPerMonth} session${enrollment.sessionsPerMonth === 1 ? "" : "s"} monthly`}
        title={client.name}
        subtitle={[client.company, client.email].filter(Boolean).join(" · ")}
        actions={<Link href={`/clients/${client.id}`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"><User className="mr-1 inline size-3.5" />Client page</Link>}
      />

      <div className="mx-auto max-w-6xl space-y-5 p-4 pb-16 sm:p-6">
        {/* TAB BAR + MONTH PICKER */}
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              className={
                tab === t.key
                  ? "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2"
              }
            >
              <t.icon className="mr-1.5 inline size-3.5" />
              {t.label}
              {t.key === "scripts" && scriptsAwaiting > 0 && (
                <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${tab === "scripts" ? "bg-white/20" : "bg-warning-soft text-warning"}`}>
                  {scriptsAwaiting}
                </span>
              )}
            </Link>
          ))}
        </div>

        {/* Month rail — scopes This month + Scripts; the other tabs are client-level. */}
        {(tab === "month" || tab === "scripts") && (
          <div className="flex flex-wrap items-center gap-1.5">
            {months.map((m) => (
              <Link
                key={m.id}
                href={hrefFor(tab, m.monthKey)}
                className={
                  m.monthKey === (month?.monthKey ?? "")
                    ? "rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-semibold text-foreground ring-1 ring-border"
                    : "rounded-lg px-2.5 py-1 text-xs font-medium text-muted-2 hover:bg-surface-2 hover:text-muted"
                }
              >
                {monthLabel(m.monthKey)}
                {m.historical && <span className="ml-1 opacity-70">· imported</span>}
              </Link>
            ))}
            {months.length === 0 && <span className="text-sm text-muted">No months yet — the sweep creates the current month automatically.</span>}
          </div>
        )}

        {/* ---------- THIS MONTH ---------- */}
        {tab === "month" && month && journey && (
          <>
            {/* The journey hero — where the month stands, in one glance. */}
            <div className="panel-shadow rounded-2xl border bg-surface p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{monthLabel(month.monthKey)}{month.historical ? " · imported history" : ""}</h2>
                <span className="text-[11px] text-muted-2">{month.videosOwed} videos owed this month</span>
              </div>
              <div className="mx-auto max-w-2xl">
                <MonthJourney input={journey} size="hero" />
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <StrategyCallCard
                monthId={month.id}
                status={month.strategyCallStatus}
                at={month.strategyCallAt?.toISOString() ?? null}
                hasTranscript={!!month.transcriptText}
                transcriptProcessed={!!month.transcriptProcessedAt}
                required={enrollment.strategyCallRequired}
                bookingUrl={STRATEGY_CALL_BOOKING_URL}
              />

              {/* SESSIONS — the attached shoots (the real pipeline rows) */}
              <Section icon={Camera} title="Content sessions" count={`${projects.length}/${enrollment.sessionsPerMonth}`} flush>
                <div className="divide-y divide-border">
                  {projects.map((p) => {
                    const s = stageMeta(p.status as never);
                    const pending = p.reviewSubmissions.filter((r) => r.status === "PENDING").length;
                    return (
                      <Link key={p.id} href={`/edit/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{p.title}</div>
                          <div className="text-xs text-muted">
                            {p.shootDate ? p.shootDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "unscheduled"}
                            {p.photographer?.name ? ` · ${p.photographer.name}` : ""}
                          </div>
                        </div>
                        {pending > 0 && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">{pending} in review</span>}
                        <Badge color={s.color} soft={s.soft} className="px-1.5 py-0 text-[10px]">{s.short}</Badge>
                      </Link>
                    );
                  })}
                  {projects.length === 0 && (
                    <p className="px-5 py-4 text-sm text-muted">
                      No session on the calendar for {monthLabel(month.monthKey)} — when the Aryeo booking lands it attaches here automatically.
                    </p>
                  )}
                </div>
              </Section>
            </div>

            {/* THIS MONTH'S PLAN */}
            <Section icon={Lightbulb} title="This month's topics" count={topics.length} flush
              action={
                <Link href={hrefFor("topics")} className="text-[11px] font-medium text-brand hover:underline">
                  Pull from the topic bank →
                </Link>
              }>
              <TopicBank enrollmentId={id} monthId={month.id} topics={topics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="month" />
            </Section>
          </>
        )}
        {tab === "month" && !month && (
          <p className="text-sm text-muted">No month workspace yet — the sweep creates the current month automatically.</p>
        )}

        {/* ---------- SCRIPTS ---------- */}
        {tab === "scripts" && (
          <>
            <Section icon={FileText} title={month ? `Scripts — ${monthLabel(month.monthKey)}` : "Scripts"} count={scripts.length} flush
              action={scriptsAwaiting > 0 ? <span className="text-[11px] font-medium text-warning">{scriptsAwaiting} awaiting your review</span> : undefined}>
              <ScriptReview scripts={scripts.map((s) => {
                let prod: string[] = [];
                try { prod = s.productionJson ? (JSON.parse(s.productionJson) as string[]) : []; } catch { prod = []; }
                return { id: s.id, title: s.title, body: s.body, status: s.status, source: s.source, sourceFile: s.sourceFile, productionIdeas: prod };
              })} />
            </Section>
            <ScriptBackfillCard enrollmentId={id} defaultMonth={month?.monthKey ?? etMonthKey()} />
          </>
        )}

        {/* ---------- TOPIC BANK ---------- */}
        {tab === "topics" && (
          <Section icon={Lightbulb} title="Topic bank" count={bankTopics.length} flush
            action={<TopicSeedButton enrollmentId={id} />}>
            <TopicBank enrollmentId={id} monthId={month?.id ?? null} topics={bankTopics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="bank" />
          </Section>
        )}

        {/* ---------- STRATEGY & PROFILE ---------- */}
        {tab === "profile" && (
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <StrategyCard
              enrollmentId={id}
              strategy={strategy ? { sections: strategySections, sourceFile: strategy.sourceFile, updatedAt: strategy.updatedAt.toISOString() } : null}
            />
            <ProfileSections
              clientId={client.id}
              profile={{
                brandJson: profile?.brandJson ?? null,
                voiceJson: profile?.voiceJson ?? null,
                contentPrefsJson: profile?.contentPrefsJson ?? null,
                productionJson: profile?.productionJson ?? null,
                editingJson: profile?.editingJson ?? null,
                storiesJson: profile?.storiesJson ?? null,
              }}
              editingPreferences={client.editingPreferences}
            />
          </div>
        )}

        {/* ---------- NOTES & SETTINGS ---------- */}
        {tab === "notes" && (
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <NotesCard clientId={client.id} notes={notes.map(n => ({ id: n.id, body: n.body, authorName: n.authorName, intelligence: n.intelligence, at: n.createdAt.toISOString() }))} />
            <EnrollmentSettingsCard
              enrollmentId={id}
              pkg={enrollment.package}
              status={enrollment.status}
              packageSource={enrollment.packageSource}
              strategyCallRequired={enrollment.strategyCallRequired}
              clientSuppliesTopics={enrollment.clientSuppliesTopics}
              notes={enrollment.notes}
              // Billing renders for the owner alone (open local dev counts);
              // the save action re-checks with requireOwner.
              billing={
                (me ? me.role === "OWNER" : !authEnforced())
                  ? { type: enrollment.billingType, rate: enrollment.billingRate, months: enrollment.billingMonths }
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

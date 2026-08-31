import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Camera, CalendarDays, CheckCircle2, FileText, FolderOpen, Lightbulb, User,
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
import { fmtDay } from "@/lib/contentStatus";
import { stageMeta } from "@/lib/pipeline";
import { Badge } from "@/components/ui/Badge";
import { MonthJourney } from "@/components/content/MonthJourney";
import { MonthPicker, SessionMonthMover, SkipMonthButton } from "@/components/content/MonthControls";
import { PortalLinkButton } from "@/components/content/PortalLinkButton";
import {
  EnrollmentSettingsCard, StrategyCallCard, StrategyCard, TopicBank, ScriptBackfillCard, ProfileSections, NotesCard, ScriptReview, TopicSeedButton,
} from "@/components/content/Workspace";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";

export const dynamic = "force-dynamic";

// One client's workspace — reorganized Aug 31 per Jordan: the pipeline
// tracker leads (the same visual language as his dashboard cards, hero size),
// with the ONE next step spelled out right under it, then clean sections:
// Strategy call · Filming sessions · Scripts · the month's video plan.
// Three tabs: THIS MONTH (the work), IDEAS (the topic bank in plain words),
// CLIENT FILE (strategy, profile, notes, settings, imports).
type Tab = "month" | "ideas" | "file";
const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: "month", label: "This month", icon: CalendarDays },
  { key: "ideas", label: "Ideas", icon: Lightbulb },
  { key: "file", label: "Client file", icon: FolderOpen },
];
// Old bookmarked URLs keep working.
const LEGACY_TABS: Record<string, Tab> = { scripts: "month", topics: "ideas", profile: "file", notes: "file" };

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
  const tab: Tab = TABS.some((t) => t.key === tabParam)
    ? (tabParam as Tab)
    : LEGACY_TABS[tabParam ?? ""] ?? "month";

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

  // The month's counts — same status filters as the dashboard roster, so the
  // tracker here always matches the client's card out front.
  const now = new Date();
  const liveProjects = projects.filter((p) => p.status !== "CANCELLED");
  const videoUnits = (p: { deliverables: { type: string; quantity: number | null }[] }) =>
    p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
  const owedRaw = month?.videosOwed ?? enrollment.videosPerMonth;
  const owed = Math.max(owedRaw, 1);
  const counts = {
    topicsSelected: topics.filter((t) => ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status)).length,
    scriptsReady: scripts.filter((s) => ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"].includes(s.status)).length,
    scriptsAwaiting: scripts.filter((s) => s.status === "INTERNAL_REVIEW" || s.status === "DRAFT").length,
    sessionsScheduled: liveProjects.length,
    shotCount: liveProjects.filter((p) => p.shootDate && p.shootDate < now).length,
    delivered: liveProjects.filter((p) => p.status === "DELIVERED").reduce((s, p) => s + Math.max(1, videoUnits(p)), 0),
    inReview: liveProjects.reduce((s, p) => s + p.reviewSubmissions.filter((r) => r.status === "PENDING").length, 0),
  };
  const nextShoot = liveProjects
    .filter((p) => p.shootDate && p.shootDate >= now)
    .sort((a, b) => a.shootDate!.getTime() - b.shootDate!.getTime())[0] ?? null;

  // The client's OPEN portal suggestions, keyed by script.
  const openSuggestions = scripts.length
    ? await prisma.scriptSuggestion.findMany({
        where: { scriptId: { in: scripts.map((s) => s.id) }, status: "OPEN" },
        orderBy: { createdAt: "asc" },
        select: { id: true, scriptId: true, body: true, createdAt: true },
      })
    : [];
  const suggByScript = new Map<string, { id: string; body: string; createdAtISO: string }[]>();
  for (const sg of openSuggestions) {
    const arr = suggByScript.get(sg.scriptId) ?? [];
    arr.push({ id: sg.id, body: sg.body, createdAtISO: sg.createdAt.toISOString() });
    suggByScript.set(sg.scriptId, arr);
  }
  const needsMe = counts.scriptsAwaiting + openSuggestions.length;

  // ---- The next step: walk the loop, first unfinished stage speaks. ----
  const muted = !!month?.historical || month?.status === "SKIPPED";
  const callDone = !enrollment.strategyCallRequired ||
    ["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(month?.strategyCallStatus ?? "");
  const topicsDone = enrollment.clientSuppliesTopics || counts.topicsSelected >= owed;
  const scriptsDone = counts.scriptsReady >= owed && counts.scriptsAwaiting === 0;
  const filmedDone = counts.shotCount > 0 && counts.sessionsScheduled >= enrollment.sessionsPerMonth;
  const deliveredDone = owedRaw > 0 && counts.delivered >= owedRaw;

  const monthName = month ? monthLabel(month.monthKey) : monthLabel(activeKey);
  const monthShort = monthName.split(" ")[0];

  const nextStep: { text: string; cta: string; href: string } | null = muted ? null
    : !callDone
      ? month?.strategyCallStatus === "SCHEDULED"
        ? { text: `Strategy call is booked${month.strategyCallAt ? ` for ${fmtDay(month.strategyCallAt.toISOString())}` : ""} — paste the transcript after`, cta: "Open the call", href: "#call" }
        : { text: "The strategy call isn't booked yet", cta: "Handle the call", href: "#call" }
    : !topicsDone
      ? { text: `Pick ${monthShort}'s topics`, cta: "Pick topics", href: "#topics" }
    : !scriptsDone
      ? counts.scriptsAwaiting > 0
        ? { text: `${counts.scriptsAwaiting} script${counts.scriptsAwaiting === 1 ? "" : "s"} waiting on your OK`, cta: "Review the scripts", href: "#scripts" }
        : { text: `${counts.scriptsReady} of ${owed} scripts ready — the rest are being drafted`, cta: "See the scripts", href: "#scripts" }
    : !filmedDone
      ? nextShoot?.shootDate
        ? { text: `Filming ${fmtDay(nextShoot.shootDate.toISOString())}${nextShoot.photographer?.name ? ` with ${nextShoot.photographer.name}` : ""}`, cta: "See the session", href: "#sessions" }
        : { text: "No filming session on the calendar yet", cta: "See the sessions", href: "#sessions" }
    : !deliveredDone
      ? counts.inReview > 0
        ? { text: `${counts.inReview} video${counts.inReview === 1 ? "" : "s"} waiting in the Review Room`, cta: "Open the Review Room", href: "/review" }
        : { text: `${counts.delivered} of ${owedRaw} videos delivered — the rest are in editing`, cta: "See the sessions", href: "#sessions" }
    : null;

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
        actions={
          <div className="flex items-center gap-2">
            {(me ? me.role === "OWNER" : !authEnforced()) && <PortalLinkButton enrollmentId={id} />}
            <Link href={`/clients/${client.id}`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"><User className="mr-1 inline size-3.5" />Client page</Link>
          </div>
        }
      />

      <div className="mx-auto max-w-5xl space-y-6 p-4 pb-16 sm:p-6">
        {/* TABS */}
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              className={
                tab === t.key
                  ? "rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white"
                  : "rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
              }
            >
              <t.icon className="mr-1.5 inline size-4 -translate-y-px" />
              {t.label}
              {t.key === "month" && needsMe > 0 && (
                <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${tab === "month" ? "bg-white/25" : "bg-brand-soft text-brand"}`}>
                  {needsMe}
                </span>
              )}
            </Link>
          ))}
        </div>

        {/* ---------- THIS MONTH ---------- */}
        {tab === "month" && month && (
          <>
            {/* Month title — history one dropdown away. */}
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {monthName}
                  {month.historical && <span className="ml-2 align-middle text-[13px] font-normal text-muted-2">imported history</span>}
                  {month.status === "SKIPPED" && <span className="ml-2 align-middle text-[13px] font-normal text-muted-2">skipped</span>}
                </h2>
                <p className="mt-1 text-sm text-muted">{owedRaw} video{owedRaw === 1 ? "" : "s"} this month</p>
              </div>
              <div className="flex items-center gap-2">
                <MonthPicker
                  months={months.map((m) => ({ key: m.monthKey, label: monthLabel(m.monthKey), historical: m.historical }))}
                  currentKey={month.monthKey}
                  makeHref={`/content/${id}?month=MONTH`}
                />
                <SkipMonthButton monthId={month.id} skipped={month.status === "SKIPPED"} />
              </div>
            </div>

            {/* THE TRACKER — where the month is in the pipeline, front and center. */}
            <div className="panel-shadow rounded-2xl border bg-surface p-6">
              <div className="mx-auto max-w-2xl">
                <MonthJourney
                  size="hero"
                  input={{
                    callStatus: month.strategyCallStatus,
                    topicsSelected: counts.topicsSelected,
                    scriptsReady: counts.scriptsReady,
                    scriptsAwaiting: counts.scriptsAwaiting,
                    videosOwed: month.videosOwed,
                    sessionsScheduled: counts.sessionsScheduled,
                    sessionsRequired: enrollment.sessionsPerMonth,
                    shotCount: counts.shotCount,
                    delivered: counts.delivered,
                    inReview: counts.inReview,
                    muted,
                  }}
                />
              </div>
              {/* The one next step, spelled out. */}
              {nextStep ? (
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <p className="text-[15px] font-medium">{nextStep.text}</p>
                  <a
                    href={nextStep.href}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    {nextStep.cta}
                  </a>
                </div>
              ) : !muted && deliveredDone ? (
                <p className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-[15px] font-medium text-success">
                  <CheckCircle2 className="size-4.5" /> All {owedRaw} videos delivered — {monthShort} is wrapped.
                </p>
              ) : null}
            </div>

            {/* CALL + SESSIONS side by side. */}
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <div id="call" className="scroll-mt-20">
                <StrategyCallCard
                  monthId={month.id}
                  status={month.strategyCallStatus}
                  at={month.strategyCallAt?.toISOString() ?? null}
                  hasTranscript={!!month.transcriptText}
                  transcriptProcessed={!!month.transcriptProcessedAt}
                  required={enrollment.strategyCallRequired}
                  bookingUrl={STRATEGY_CALL_BOOKING_URL}
                />
              </div>
              <div id="sessions" className="scroll-mt-20">
                <Section icon={Camera} title="Filming sessions" count={`${liveProjects.length}/${enrollment.sessionsPerMonth}`} flush>
                  <div className="divide-y divide-border">
                    {projects.map((p) => {
                      const s = stageMeta(p.status as never);
                      const pending = p.reviewSubmissions.filter((r) => r.status === "PENDING").length;
                      return (
                        <Link key={p.id} href={`/edit/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2/60">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[15px] font-medium">{p.title}</div>
                            <div className="mt-0.5 text-[13px] text-muted">
                              {p.shootDate ? fmtDay(p.shootDate.toISOString()) : "unscheduled"}
                              {p.photographer?.name ? ` · ${p.photographer.name}` : ""}
                              {pending > 0 ? ` · ${pending} in review` : ""}
                            </div>
                          </div>
                          <SessionMonthMover projectId={p.id} currentKey={month.monthKey} monthKeys={months.map((mm) => mm.monthKey)} />
                          <Badge color={s.color} soft={s.soft} className="px-2 py-0.5 text-xs">{s.short}</Badge>
                        </Link>
                      );
                    })}
                    {projects.length === 0 && (
                      <p className="px-5 py-4 text-sm text-muted">
                        Nothing on the calendar for {monthName} yet — when the Aryeo booking lands it attaches here on its own.
                      </p>
                    )}
                  </div>
                </Section>
              </div>
            </div>

            {/* SCRIPTS — the review loop, right on the month. */}
            <div id="scripts" className="scroll-mt-20">
              <Section
                icon={FileText}
                title={`Scripts — ${monthName}`}
                count={scripts.length}
                flush
                action={
                  counts.scriptsAwaiting > 0 || openSuggestions.length > 0 ? (
                    <span className="text-[13px] font-medium text-brand">
                      {[
                        counts.scriptsAwaiting > 0 ? `${counts.scriptsAwaiting} need your OK` : null,
                        openSuggestions.length > 0 ? `${openSuggestions.length} client note${openSuggestions.length === 1 ? "" : "s"}` : null,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  ) : scripts.length > 0 ? (
                    <span className="text-[13px] text-success">all approved ✓</span>
                  ) : undefined
                }
              >
                <ScriptReview scripts={scripts.map((s) => {
                  let prod: string[] = [];
                  try { prod = s.productionJson ? (JSON.parse(s.productionJson) as string[]) : []; } catch { prod = []; }
                  return { id: s.id, title: s.title, body: s.body, status: s.status, source: s.source, sourceFile: s.sourceFile, productionIdeas: prod, suggestions: suggByScript.get(s.id) ?? [] };
                })} />
              </Section>
            </div>

            {/* TOPICS — the month's video plan. */}
            <div id="topics" className="scroll-mt-20">
              <Section icon={Lightbulb} title={`${monthShort}'s video plan`} count={topics.length} flush
                action={
                  <Link href={hrefFor("ideas")} className="text-[13px] font-medium text-brand hover:underline">
                    Pick from Ideas →
                  </Link>
                }>
                <TopicBank enrollmentId={id} monthId={month.id} monthName={monthShort} topics={topics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="month" />
              </Section>
            </div>
          </>
        )}
        {tab === "month" && !month && (
          <p className="text-sm text-muted">No month workspace yet — the hourly sweep creates the current month automatically.</p>
        )}

        {/* ---------- IDEAS ---------- */}
        {tab === "ideas" && (
          <Section icon={Lightbulb} title="Ideas" count={bankTopics.length} flush
            action={<TopicSeedButton enrollmentId={id} />}>
            <p className="border-b border-border px-5 py-3 text-[13px] text-muted">
              Topics saved for future months. Pull one into a month when it&rsquo;s time to script it.
            </p>
            <TopicBank enrollmentId={id} monthId={month?.id ?? null} monthName={monthShort} topics={bankTopics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="bank" />
          </Section>
        )}

        {/* ---------- CLIENT FILE ---------- */}
        {tab === "file" && (
          <>
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
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <NotesCard clientId={client.id} notes={notes.map(n => ({ id: n.id, body: n.body, authorName: n.authorName, intelligence: n.intelligence, at: n.createdAt.toISOString() }))} />
              <div className="space-y-5">
                <EnrollmentSettingsCard
                  enrollmentId={id}
                  pkg={enrollment.package}
                  status={enrollment.status}
                  packageSource={enrollment.packageSource}
                  strategyCallRequired={enrollment.strategyCallRequired}
                  clientSuppliesTopics={enrollment.clientSuppliesTopics}
                  videosPerMonth={enrollment.videosPerMonth}
                  notes={enrollment.notes}
                  billing={
                    (me ? me.role === "OWNER" : !authEnforced())
                      ? { type: enrollment.billingType, rate: enrollment.billingRate, months: enrollment.billingMonths }
                      : undefined
                  }
                />
                <ScriptBackfillCard enrollmentId={id} defaultMonth={month?.monthKey ?? etMonthKey()} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

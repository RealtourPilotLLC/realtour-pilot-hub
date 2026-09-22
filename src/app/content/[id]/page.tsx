import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Camera, CalendarDays, CheckCircle2, Compass, ExternalLink, Eye, FileText, FileUp, Film, FolderOpen, Lightbulb, NotebookPen, Palette, Settings2, User,
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
import { parseStoredSections } from "@/lib/contentStrategy";
import { customerNote } from "@/lib/clientNotes";
import { fmtDay } from "@/lib/contentStatus";
import { stageMeta } from "@/lib/pipeline";
import { Badge } from "@/components/ui/Badge";
import { MonthJourney } from "@/components/content/MonthJourney";
import { MonthPicker, SessionMonthMover, SkipMonthButton } from "@/components/content/MonthControls";
import { PortalLinkButton } from "@/components/content/PortalLinkButton";
import {
  EnrollmentSettingsCard, StrategyCallCard, StrategyCard, TopicBank, ProfileSections, NotesCard, ScriptReview,
} from "@/components/content/Workspace";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { StrategyPanel } from "@/components/content/StrategyPanel";
import { TopicsPanel } from "@/components/content/TopicsPanel";
import { ScriptsPanel } from "@/components/content/ScriptsPanel";
import { FactsPanel } from "@/components/content/FactsPanel";
import { ImportPanel } from "@/components/content/ImportPanel";
import { loadStrategyTab, loadTopicsTab, loadScriptsTab, loadFactsTab, loadImportTab } from "./programData";
import { loadSettingsTab, loadBrandTab, loadContentTab } from "./workspaceData";
import { SettingsPanel } from "@/components/content/SettingsPanel";
import { BrandAssetsPanel } from "@/components/content/BrandAssetsPanel";
import { ContentLibraryPanel } from "@/components/content/ContentLibraryPanel";
import { PortalAccessCard } from "@/components/content/PortalAccessCard";

export const dynamic = "force-dynamic";
// The server actions this page calls run the model (a 16k-token topic refresh,
// a transcript analysis) — Next applies the page's maxDuration to them.
export const maxDuration = 300;

// One client's workspace — reorganized Aug 31 per Jordan: the pipeline
// tracker leads (the same visual language as his dashboard cards, hero size),
// with the ONE next step spelled out right under it, then clean sections:
// Strategy call · Filming sessions · Scripts · the month's video plan.
// Tabs (Sep 17, spec §17): THIS MONTH (the work) · VIDEO TOPICS (the bank by
// pillar, selections, refresh, recommendations — the tab formerly called
// "Ideas"; its key stays `ideas` so every old link resolves) · STRATEGY
// (versions, approve/release, proposals, pillars) · SCRIPTS (one review queue,
// versions, approve/release) · FACTS (the review strip) · IMPORT (preview →
// apply, review items) · CLIENT FILE (profile, notes, settings) · THEIR PORTAL.
type Tab = "month" | "strategy" | "ideas" | "scripts" | "content" | "brand" | "settings" | "facts" | "import" | "file" | "portal";
const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: "month", label: "Overview", icon: CalendarDays },
  { key: "strategy", label: "Strategy", icon: Compass },
  { key: "ideas", label: "Video Topics", icon: Lightbulb },
  { key: "scripts", label: "Scripts", icon: FileText },
  { key: "content", label: "Content", icon: Film },
  { key: "brand", label: "Brand & Assets", icon: Palette },
  { key: "settings", label: "Settings", icon: Settings2 },
  { key: "facts", label: "Facts", icon: NotebookPen },
  { key: "import", label: "Import", icon: FileUp },
  { key: "file", label: "Client file", icon: FolderOpen },
  { key: "portal", label: "Their portal", icon: Eye },
];
// Old bookmarked URLs keep working: ?tab=topics and ?tab=ideas both open Video
// Topics; the pre-§17 "profile"/"notes" links land on Brand & Assets, where
// that material now lives. ?tab=file still opens the old combined client file
// card set — nothing Jordan and Kyle use today was taken away.
const LEGACY_TABS: Record<string, Tab> = { topics: "ideas", "video-topics": "ideas", profile: "brand", notes: "brand", assets: "brand", videos: "content", overview: "month" };

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
  let tab: Tab = TABS.some((t) => t.key === tabParam)
    ? (tabParam as Tab)
    : LEGACY_TABS[tabParam ?? ""] ?? "month";

  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id } });
  if (!enrollment) notFound();
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  // The portal mirror is the owner's window — the link inside is client-facing.
  if (tab === "portal" && !ownerEyes) tab = "month";
  const client = await prisma.client.findUnique({
    where: { id: enrollment.clientId },
    // generalNotes is THE customer note; editingPreferences is the retired
    // column, still read as a fallback (src/lib/clientNotes.ts).
    select: { id: true, name: true, email: true, phone: true, company: true, generalNotes: true, editingPreferences: true },
  });
  if (!client) notFound();

  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: id },
    orderBy: { monthKey: "desc" },
  });
  const activeKey = monthParam && months.some((m) => m.monthKey === monthParam) ? monthParam : etMonthKey();
  const month = months.find((m) => m.monthKey === activeKey) ?? months[0] ?? null;

  const [projects, topics, scripts, profile, notes, strategy] = await Promise.all([
    month
      ? prisma.project.findMany({
          where: { contentMonthId: month.id },
          select: {
            id: true, title: true, status: true, shootDate: true,
            photographer: { select: { name: true } },
            reviewSubmissions: { select: { status: true } },
            deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } },
          },
          orderBy: { shootDate: "asc" },
        })
      : Promise.resolve([]),
    month ? prisma.contentTopic.findMany({ where: { monthId: month.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    month ? prisma.contentScript.findMany({ where: { monthId: month.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    prisma.agentProfile.findUnique({ where: { clientId: client.id } }),
    prisma.contentNote.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.contentStrategy.findFirst({ where: { enrollmentId: id, status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
  ]);
  // The legacy card renders {heading: text}; a row in the versioned shape (or
  // any non-string value) is flattened through the same reader — never handed
  // to React as an object child.
  const strategySections: Record<string, string> = {};
  if (strategy) {
    const stored = parseStoredSections(strategy.sectionsJson);
    for (const s of stored?.sections ?? []) strategySections[s.heading || `Section ${s.order}`] = typeof s.text === "string" ? s.text : String(s.text ?? "");
  }
  // Scripts on the month, version-aware: the text shown (and approved) is the
  // CURRENT version's, not the legacy mirror of the approved one — otherwise a
  // fresh edit looked lost and "Approve" signed text the tab never displayed.
  const currentVersions = scripts.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId).filter((x): x is string => !!x) } }, select: { id: true, body: true, status: true, versionNo: true } }) : [];
  const versionOf = (s: (typeof scripts)[number]) => currentVersions.find((v) => v.id === s.currentVersionId) ?? null;
  const scriptAwaiting = (s: (typeof scripts)[number]) => {
    if (s.historical) return false;
    const v = versionOf(s);
    return v ? v.status === "DRAFT" || v.status === "INTERNAL_REVIEW" : s.status === "INTERNAL_REVIEW" || s.status === "DRAFT";
  };
  const scriptReady = (s: (typeof scripts)[number]) => !s.historical && (s.approvedVersionId ? !scriptAwaiting(s) : ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"].includes(s.status));

  // Tab data — loaded only for the tab being shown.
  const [topicsData, strategyData, scriptsData, factsData, importData, settingsData, brandData, contentData] = await Promise.all([
    tab === "ideas" ? loadTopicsTab(id, month ? { id: month.id, monthKey: month.monthKey } : null) : Promise.resolve(null),
    tab === "strategy" ? loadStrategyTab(id, month ? { id: month.id, monthKey: month.monthKey, prioritiesJson: month.prioritiesJson, prioritiesSourceRef: month.prioritiesSourceRef } : null) : Promise.resolve(null),
    tab === "scripts" ? loadScriptsTab(id, month ? { id: month.id } : null) : Promise.resolve(null),
    tab === "facts" ? loadFactsTab(client.id, id) : Promise.resolve(null),
    tab === "import" ? loadImportTab(id) : Promise.resolve(null),
    tab === "settings" ? loadSettingsTab(id, ownerEyes) : Promise.resolve(null),
    tab === "brand" ? loadBrandTab(client.id) : Promise.resolve(null),
    tab === "content" ? loadContentTab(id, client.id, null) : Promise.resolve(null),
  ]);

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
    scriptsReady: scripts.filter(scriptReady).length,
    scriptsAwaiting: scripts.filter(scriptAwaiting).length,
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

  const nextStep: { text: string; cta: string; href: string } | null = muted || deliveredDone ? null
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
    : counts.inReview > 0
      ? { text: `${counts.inReview} video${counts.inReview === 1 ? "" : "s"} waiting in the Review Room`, cta: "Open the Review Room", href: "/review" }
      : { text: `${counts.delivered} of ${owedRaw} videos delivered — the rest are in editing`, cta: "See the sessions", href: "#sessions" };

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
            {ownerEyes && <PortalLinkButton enrollmentId={id} />}
            <Link href={`/clients/${client.id}`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"><User className="mr-1 inline size-3.5" />Client page</Link>
          </div>
        }
      />

      <div className="mx-auto max-w-5xl space-y-6 p-4 pb-16 sm:p-6">
        {/* TABS */}
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.filter((t) => t.key !== "portal" || ownerEyes).map((t) => (
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
                  const v = versionOf(s);
                  const awaiting = scriptAwaiting(s);
                  const status = s.historical ? "HISTORICAL" : awaiting ? (s.approvedVersionId ? "NEW_DRAFT" : "INTERNAL_REVIEW") : s.status;
                  return { id: s.id, title: s.title, body: v?.body ?? s.body, versionNo: v?.versionNo ?? null, status, historical: s.historical, needsApproval: awaiting, source: s.source, sourceFile: s.sourceFile, productionIdeas: prod, suggestions: suggByScript.get(s.id) ?? [] };
                })} />
              </Section>
            </div>

            {/* TOPICS — the month's video plan. */}
            <div id="topics" className="scroll-mt-20">
              <Section icon={Lightbulb} title={`${monthShort}'s video plan`} count={topics.length} flush
                action={
                  <Link href={hrefFor("ideas")} className="text-[13px] font-medium text-brand hover:underline">
                    Pick from Video Topics →
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

        {/* ---------- VIDEO TOPICS ---------- */}
        {tab === "ideas" && (() => {
          const d = topicsData!;
          return (
            <TopicsPanel enrollmentId={id} month={month ? { id: month.id, label: monthName, short: monthShort } : null} capacity={d.capacity} groups={d.groups} proposed={d.proposed} monthTopics={d.monthTopics}
              suggestions={d.suggestions} recommended={d.recommended} runs={d.runs} interviews={d.interviews} histories={d.histories} pillars={d.pillars} topicsPerPillar={d.topicsPerPillar} isOwner={ownerEyes} archivedCount={d.archivedCount} />
          );
        })()}

        {/* ---------- STRATEGY ---------- */}
        {tab === "strategy" && strategyData && (
          <StrategyPanel enrollmentId={id} versions={strategyData.versions} proposals={strategyData.proposals} pillars={strategyData.pillars} mapping={strategyData.mapping} owners={strategyData.owners} staff={strategyData.staff} isOwner={ownerEyes} month={strategyData.month} />
        )}

        {/* ---------- SCRIPTS ---------- */}
        {tab === "scripts" && scriptsData && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-xl font-semibold tracking-tight">Scripts — {monthName}</h2>
              <MonthPicker months={months.map((m) => ({ key: m.monthKey, label: monthLabel(m.monthKey), historical: m.historical }))} currentKey={month?.monthKey ?? activeKey} makeHref={`/content/${id}?tab=scripts&month=MONTH`} />
            </div>
            <ScriptsPanel scripts={scriptsData.scripts} queueCount={scriptsData.queueCount} scriptOwner={scriptsData.scriptOwner} owed={scriptsData.owed} />
          </>
        )}

        {/* ---------- FACTS ---------- */}
        {tab === "facts" && factsData && (
          <FactsPanel clientId={client.id} facts={factsData.facts} counts={factsData.counts} months={factsData.months} projects={factsData.projects} />
        )}

        {/* ---------- IMPORT ---------- */}
        {tab === "import" && importData && (
          <ImportPanel enrollmentId={id} batches={importData.batches} reviewItems={importData.reviewItems} pillars={importData.pillars} isOwner={ownerEyes} migrationDone={importData.migrationDone} />
        )}

        {/* ---------- CONTENT — the shared video library, staff permissions ---------- */}
        {tab === "content" && contentData && (
          <ContentLibraryPanel rows={contentData.rows} pipelineOnly={contentData.pipelineOnly} monthLabelText={null} />
        )}

        {/* ---------- BRAND & ASSETS ---------- */}
        {tab === "brand" && brandData && (
          <BrandAssetsPanel
            enrollmentId={id}
            clientId={client.id}
            assets={brandData.assets}
            types={brandData.types}
            sources={brandData.sources}
            provenance={brandData.provenance}
            canEdit
          />
        )}

        {/* ---------- SETTINGS ---------- */}
        {tab === "settings" && settingsData && (
          <SettingsPanel
            s={settingsData.settings}
            billing={settingsData.billing}
            owners={settingsData.owners}
            history={settingsData.history}
            staff={settingsData.staff}
            isOwner={ownerEyes}
          />
        )}

        {/* ---------- THEIR PORTAL — the live client portal, embedded. ---------- */}
        {tab === "portal" && ownerEyes && (
          enrollment.portalToken ? (
            <div className="space-y-3">
              {/* W1-A handover (b): the access card owns link status, seats and
                  visits; it is self-guarded to OWNER and needs no plumbing. */}
              <PortalAccessCard enrollmentId={id} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted">
                  This is {client.name.split(" ")[0]}&rsquo;s live portal — exactly what they see, videos and profile included.{" "}
                  <span className="text-warning">Careful: anything you submit in here (a revision request, a comment, a profile change) is recorded as you, on their behalf — it is stamped with your staff account and labelled &ldquo;{me?.name ?? "Jordan Spackman"} (on behalf of {client.name})&rdquo;.</span>
                </p>
                <a
                  href={`/portal/${enrollment.portalToken}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" /> Open in a new tab
                </a>
              </div>
              <iframe
                src={`/portal/${enrollment.portalToken}`}
                title={`${client.name}'s client portal`}
                className="h-[78vh] w-full rounded-2xl border border-border bg-white"
              />
            </div>
          ) : (
            <p className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm text-muted">
              No portal link exists for this client yet — click <span className="font-medium text-foreground">Client portal link</span> up top to create it, then come back to this tab.
            </p>
          )
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
                customerNote={customerNote(client)}
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
                    ownerEyes
                      ? { type: enrollment.billingType, rate: enrollment.billingRate, months: enrollment.billingMonths }
                      : undefined
                  }
                />
                <p className="rounded-2xl border border-border bg-surface px-5 py-3 text-[13px] text-muted">
                  Past scripts, topic banks and strategy documents are imported on the <Link href={hrefFor("import")} className="font-medium text-brand hover:underline">Import</Link> tab — preview first, per-client month confirmation, nothing approved by an import.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

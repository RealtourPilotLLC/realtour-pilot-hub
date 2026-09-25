import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  Activity, BookOpen, CalendarDays, ChevronDown, Clapperboard, Compass, Eye, FileUp, Info, MessageSquare, Palette, Settings2, User, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { etMonthKey } from "@/lib/contentProgram";
import { monthProgress, staffMonthView } from "@/lib/monthProgress";
import { STAFF_TABS, canPreviewPortal, contentHref, resolveStaffTab, type StaffTab } from "@/lib/contentNav";
import { PortalLinkButton } from "@/components/content/PortalLinkButton";
import type { TabCtx } from "./tabs/shared";
import { OverviewTab } from "./tabs/OverviewTab";
import { PlanTab } from "./tabs/PlanTab";
import { ProductionTab } from "./tabs/ProductionTab";
import { BrandTab } from "./tabs/BrandTab";
import { MessagesTab } from "./tabs/MessagesTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { ImportTab } from "./tabs/ImportTab";

export const dynamic = "force-dynamic";
// The server actions this page calls run the model (a 16k-token topic refresh,
// a transcript analysis) — Next applies the page's maxDuration to them.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// ONE CLIENT'S FILE (UI-02, Sep 24 2026) — a thin shell over six tabs:
//
//   Overview    the month at a glance: tracker, next action (who, by when),
//               appointments, missing work & approvals, communication
//   Plan        topics · scripts · strategy · calls · knowledge
//   Production  sessions · videos · revisions
//   Brand       structured profile, assets, music, the agent profile
//   Messages    the program thread, with texts and emails labelled by channel
//   Settings    package & allowance, status, call mode, owners, account/team
//
// It used to be eleven tabs, three of which did one job twice with weaker
// rules: the Client file's settings card changed package/status with no
// ledger row, the Overview's script list approved "whatever version is current
// at click time", and a third progress count lived on this page. Those are
// retired (see Workspace.tsx and content/actions.ts). Import is a tool (the
// Tools menu), the live portal is a separate owner-only Preview page, and the
// detailed AI run logs were already on /content/monitoring.
//
// Every URL ever used still lands: resolveStaffTab maps each old ?tab= key to
// its new home and the page redirects — outside any try, since redirect()
// throws — before it reads anything.
// ---------------------------------------------------------------------------

const TAB_ICON: Record<Exclude<StaffTab, "import">, LucideIcon> = {
  overview: CalendarDays, plan: Compass, production: Clapperboard, brand: Palette, messages: MessageSquare, settings: Settings2,
};

export default async function ContentClientPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; tab?: string; view?: string; moved?: string }>;
}) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  const { id } = await params;
  const sp = await searchParams;
  const ownerEyes = canPreviewPortal(me, authEnforced());
  const staffEyes = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();

  const nav = resolveStaffTab(sp.tab, sp.view, ownerEyes);
  if (nav.preview) redirect(`/content/${id}/preview`);
  if (nav.redirect) redirect(contentHref(id, { tab: nav.tab, view: nav.view, month: sp.month ?? null, moved: nav.moved }));

  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { id },
    select: { clientId: true, package: true, status: true, videosPerMonth: true, sessionsPerMonth: true, strategyCallRequired: true, portalToken: true },
  });
  if (!enrollment) notFound();
  const client = await prisma.client.findUnique({
    where: { id: enrollment.clientId },
    // generalNotes is THE customer note; editingPreferences is the retired
    // column, still read as a fallback (src/lib/clientNotes.ts).
    select: { id: true, name: true, email: true, phone: true, company: true, generalNotes: true, editingPreferences: true },
  });
  if (!client) notFound();

  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: id }, orderBy: { monthKey: "desc" } });
  const activeKey = sp.month && months.some((m) => m.monthKey === sp.month) ? sp.month : etMonthKey();
  const month = months.find((m) => m.monthKey === activeKey) ?? months[0] ?? null;

  // THE MONTH'S PROGRESS — the one reader (CP-10), read once here and handed
  // to whichever tab is open. The badges come from it too.
  const progress = month ? await monthProgress(id, month.id).catch(() => null) : null;
  const pview = progress ? staffMonthView(progress) : null;
  const [strategyReview, messagesWaiting] = await Promise.all([
    prisma.contentStrategyVersion.count({ where: { enrollmentId: id, status: "INTERNAL_REVIEW" } }).catch(() => 0),
    import("@/lib/programMessages").then((m) => m.unansweredCount(id)).catch(() => 0),
  ]);
  const scriptsNeedMe = pview?.needsMe ?? 0;
  const badge: Partial<Record<StaffTab, number>> = {
    plan: scriptsNeedMe + strategyReview,
    production: progress?.production.awaitingInternalReview ?? 0,
    messages: messagesWaiting,
  };

  const ctx: TabCtx = {
    id, client, enrollment: { package: enrollment.package, status: enrollment.status, videosPerMonth: enrollment.videosPerMonth, sessionsPerMonth: enrollment.sessionsPerMonth, strategyCallRequired: enrollment.strategyCallRequired, portalToken: enrollment.portalToken },
    months, month, activeKey, view: nav.view, progress,
    me: me ? { id: me.id, role: me.role, name: me.name } : null,
    ownerEyes, staffEyes,
  };
  const mk = month?.monthKey ?? null;
  // A badged tab opens the view that HOLDS what it counts (Sep 24): Plan's
  // badge is scripts needing approval + strategy versions in review, which
  // live on Plan › Scripts / Strategy, not the Topics default; Production's is
  // cuts awaiting internal review, which only Revisions lists. Unbadged, a tab
  // opens its default view as before.
  const badgeView = (t: StaffTab): string | null =>
    t === "plan" && badge.plan ? (scriptsNeedMe ? "scripts" : "strategy") : t === "production" && badge.production ? "revisions" : null;
  const tabHref = (t: StaffTab) => contentHref(id, { tab: t, view: badgeView(t), month: mk });

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader
        eyebrow={`${enrollment.package} · ${enrollment.videosPerMonth} videos / ${enrollment.sessionsPerMonth} session${enrollment.sessionsPerMonth === 1 ? "" : "s"} monthly${enrollment.status !== "ACTIVE" ? ` · ${enrollment.status.toLowerCase()}` : ""}`}
        title={client.name}
        subtitle={[client.company, client.email].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {ownerEyes && <PortalLinkButton enrollmentId={id} />}
            {ownerEyes && (
              <Link href={`/content/${id}/preview`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                <Eye className="mr-1 inline size-3.5" />Preview portal
              </Link>
            )}
            <Link href={`/clients/${client.id}`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"><User className="mr-1 inline size-3.5" />Client page</Link>
            {/* TOOLS — the things you reach for occasionally, off the tab bar. */}
            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                <Wrench className="size-3.5" /> Tools <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              </summary>
              {/* In flow on a phone (an absolute menu could open off-screen there), a dropdown from sm up. */}
              <div className="mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1 shadow-lg sm:absolute sm:right-0 sm:z-20">
                <Link href={contentHref(id, { tab: "import", month: mk })} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"><FileUp className="size-4 text-muted" /> Import history</Link>
                <Link href="/content/monitoring" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"><Activity className="size-4 text-muted" /> AI runs &amp; monitoring</Link>
                <Link href="/content/resources" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"><BookOpen className="size-4 text-muted" /> Portal resources</Link>
              </div>
            </details>
          </div>
        }
      />

      <div className="mx-auto max-w-5xl space-y-6 p-4 pb-16 sm:p-6">
        {/* THE SIX TABS — a 3×2 grid on a phone (no sideways scroll), one row from sm up. */}
        <nav aria-label="Client file" className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
          {STAFF_TABS.map((t) => {
            const Icon = TAB_ICON[t.key];
            const on = nav.tab === t.key;
            const n = badge[t.key] ?? 0;
            return (
              <Link
                key={t.key}
                href={tabHref(t.key)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-sm sm:justify-start sm:px-3.5",
                  on ? "bg-brand font-semibold text-white" : "border border-border font-medium text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{t.label}</span>
                {n > 0 && (
                  <span className={cn("rounded-full px-1.5 text-xs font-semibold", on ? "bg-white/25" : t.key === "messages" ? "bg-warning-soft text-warning" : "bg-brand-soft text-brand")}>{n}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* ?tab=file (the old Client file) lands here — say where each part went, once. */}
        {sp.moved === "1" && (
          <p className="flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-[13px] text-muted">
            <Info className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <span>
              The Client file was split up: the profile is here on Brand, notes are on{" "}
              <Link href={contentHref(id, { tab: "plan", view: "knowledge", month: mk })} className="font-medium text-brand hover:underline">Plan › Knowledge</Link>, package and status are on{" "}
              <Link href={contentHref(id, { tab: "settings", month: mk })} className="font-medium text-brand hover:underline">Settings</Link>, and a strategy upload is on{" "}
              <Link href={contentHref(id, { tab: "plan", view: "strategy", month: mk })} className="font-medium text-brand hover:underline">Plan › Strategy</Link>.
            </span>
          </p>
        )}

        {nav.tab === "overview" && <OverviewTab ctx={ctx} />}
        {nav.tab === "plan" && <PlanTab ctx={ctx} badges={{ scripts: scriptsNeedMe, strategy: strategyReview }} />}
        {nav.tab === "production" && <ProductionTab ctx={ctx} badges={{ revisions: badge.production ?? 0 }} />}
        {nav.tab === "brand" && <BrandTab ctx={ctx} />}
        {nav.tab === "messages" && <MessagesTab ctx={ctx} />}
        {nav.tab === "settings" && <SettingsTab ctx={ctx} />}
        {nav.tab === "import" && <ImportTab ctx={ctx} />}
      </div>
    </div>
  );
}

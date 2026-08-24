import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CalendarClock, Camera, FileText, Film, Lightbulb, NotebookPen, Settings2, User,
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
import {
  EnrollmentSettingsCard, StrategyCallCard, StrategyCard, TopicBank, ScriptBackfillCard, ProfileSections, NotesCard,
} from "@/components/content/Workspace";

export const dynamic = "force-dynamic";

// One Content Creator client's program workspace: months down the rail, the
// selected month's plan/production/scripts in the middle, the living Agent
// Profile + notes below. Production state comes from attached Projects — the
// same pipeline rows the Editor Queue reads.
export default async function ContentClientPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  const { id } = await params;
  const { month: monthParam } = await searchParams;

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
        {/* MONTH RAIL */}
        <div className="flex flex-wrap items-center gap-1.5">
          {months.map((m) => (
            <Link
              key={m.id}
              href={`/content/${id}?month=${m.monthKey}`}
              className={
                m.monthKey === (month?.monthKey ?? "")
                  ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                  : "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
              }
            >
              {monthLabel(m.monthKey)}
              {m.historical && <span className="ml-1 opacity-70">· imported</span>}
            </Link>
          ))}
          {months.length === 0 && <span className="text-sm text-muted">No months yet — the sweep creates the current month automatically.</span>}
        </div>

        {month && (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* STRATEGY CALL + TRANSCRIPT */}
            <StrategyCallCard
              monthId={month.id}
              status={month.strategyCallStatus}
              at={month.strategyCallAt?.toISOString() ?? null}
              hasTranscript={!!month.transcriptText}
              required={enrollment.strategyCallRequired}
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

            {/* THIS MONTH'S PLAN */}
            <Section icon={Lightbulb} title="This month's topics" count={topics.length} flush
              action={<span className="text-[11px] text-muted-2">{month.videosOwed} videos owed</span>}>
              <TopicBank enrollmentId={id} monthId={month.id} topics={topics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="month" />
            </Section>

            {/* SCRIPTS */}
            <Section icon={FileText} title="Scripts" count={scripts.length} flush>
              <div className="divide-y divide-border">
                {scripts.map((s) => (
                  <details key={s.id} className="group px-5 py-3">
                    <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium marker:content-none">
                      <FileText className="size-3.5 shrink-0 text-muted-2" />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{s.source === "import" ? "imported" : s.status.toLowerCase().replace(/_/g, " ")}</span>
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{s.body}</p>
                    {s.sourceFile && <p className="mt-1.5 text-[10px] text-muted-2">from {s.sourceFile}</p>}
                  </details>
                ))}
                {scripts.length === 0 && <p className="px-5 py-4 text-sm text-muted">No scripts for this month yet.</p>}
              </div>
            </Section>
          </div>
        )}

        {/* TOPIC BANK (unassigned ideas) */}
        <Section icon={Lightbulb} title="Topic bank" count={bankTopics.length} flush
          action={<span className="text-[11px] text-muted-2">ideas not yet planned into a month</span>}>
          <TopicBank enrollmentId={id} monthId={month?.id ?? null} topics={bankTopics.map(t => ({ id: t.id, title: t.title, concept: t.concept, pillar: t.pillar, status: t.status, source: t.source }))} mode="bank" />
        </Section>

        {/* CONTENT STRATEGY — active strategy + upload backfill */}
        <StrategyCard
          enrollmentId={id}
          strategy={strategy ? { sections: strategySections, sourceFile: strategy.sourceFile, updatedAt: strategy.updatedAt.toISOString() } : null}
        />

        {/* SCRIPT BACKFILL */}
        <ScriptBackfillCard enrollmentId={id} defaultMonth={month?.monthKey ?? etMonthKey()} />

        <div className="grid gap-5 lg:grid-cols-2">
          {/* AGENT PROFILE */}
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

          <div className="space-y-5">
            {/* NOTES */}
            <NotesCard clientId={client.id} notes={notes.map(n => ({ id: n.id, body: n.body, authorName: n.authorName, intelligence: n.intelligence, at: n.createdAt.toISOString() }))} />

            {/* ENROLLMENT SETTINGS */}
            <EnrollmentSettingsCard
              enrollmentId={id}
              pkg={enrollment.package}
              status={enrollment.status}
              packageSource={enrollment.packageSource}
              strategyCallRequired={enrollment.strategyCallRequired}
              clientSuppliesTopics={enrollment.clientSuppliesTopics}
              notes={enrollment.notes}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import {
  History, CheckCircle2, PackageCheck, MessageCircle, MessageSquareText, ClipboardCheck,
  RefreshCw, ImageIcon, Wrench, Users as UsersIcon, Camera, XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getTaskHistory, getDeliveryHistory, getShootHistory, type HistoryTask } from "@/lib/queries";
import { DayRecap } from "@/components/history/DayRecap";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc, etTime } from "@/lib/datetime";
import { taskTypeMeta } from "@/lib/taskSource";
import { getCurrentUser } from "@/lib/auth/user";
import { scrubMoney } from "@/lib/text";
import { isDismissedSummary, dismissedReason, dismissedBy } from "@/lib/triage";

// The day-by-day ledger of what got done — shoots, completed to-dos, deliveries.
// (Moved from /history — now the Tasks hub's Done tab.)

// The hub tab badge: how many tasks were completed today (ET) — one cheap count.
// Also the Other tab's "N done today" header badge, so the two never disagree.
export async function doneTodayCount(): Promise<number> {
  return prisma.smartTask.count({
    where: { status: "COMPLETED", completedAt: { gte: etDayStartUtc(new Date()) } },
  });
}

// Friendly label + grouping bucket per task type — the one shared map in
// src/lib/taskSource.ts (this ledger and the board chip used to keep separate
// copies that had already drifted: "delivery" here read "Delivery prep").
const meta = taskTypeMeta;

function friendlyDay(key: string): string {
  const today = etDayKey(new Date());
  const yest = etDayKey(new Date(Date.now() - 86_400_000));
  if (key === today) return "Today";
  if (key === yest) return "Yesterday";
  // key is YYYY-MM-DD (ET); render without TZ math (it's already an ET calendar day).
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// ---------------------------------------------------------------------------
// WHAT GOT CLEARED WITHOUT GETTING DONE (Kyle's call, Sep 16).
//
// This ledger listed status COMPLETED only, so a CANCELLED row — a dismissal,
// the 7-day Slack expiry, the delivery sweep — vanished from every list in the
// hub the moment it closed. "I dealt with it" and "the board quietly forgot"
// were indistinguishable afterwards, which is most of why Kyle stopped
// trusting the page. They show here now, under their own heading, each with
// the reason on it.
//
// They are NOT in the "N done" badge or the day's recap counts: a dismissal is
// a decision, not an output, and nothing may read "done" without the thing
// having happened (Jordan's standing rule).
// ---------------------------------------------------------------------------
type ClosedRow = {
  id: string;
  title: string;
  taskType: string;
  summary: string | null;
  at: Date;
  projectId: string | null;
  byHand: boolean;
  reason: string | null;
  who: string | null;
};

async function closedWithoutDoing(days: number): Promise<ClosedRow[]> {
  const rows = await prisma.smartTask.findMany({
    where: { status: "CANCELLED", updatedAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    // CANCELLED rows carry no completedAt on purpose (every "what got done"
    // count pairs it with COMPLETED), so the ledger dates them by the write.
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, title: true, taskType: true, summary: true, updatedAt: true, projectId: true },
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    summary: t.summary,
    at: t.updatedAt,
    projectId: t.projectId,
    byHand: isDismissedSummary(t.summary),
    reason: dismissedReason(t.summary),
    who: dismissedBy(t.summary),
  }));
}

export async function DoneView({ tabs }: { tabs: ReactNode }) {
  const [tasksRaw, deliveries, shoots, me, closedRaw] = await Promise.all([
    getTaskHistory(45),
    getDeliveryHistory(45),
    getShootHistory(45),
    getCurrentUser().catch(() => null),
    closedWithoutDoing(45).catch(() => [] as ClosedRow[]),
  ]);
  // No money on an ADMIN screen (Jordan's standing rule): a closed Slack to-do
  // keeps its title here, figure and all, so a non-owner's ledger is redacted
  // the way the board is (audit5 kyle-home §5, Sep 8). Sessionless = owner.
  const isOwner = !me || me.role === "OWNER";
  const tasks = isOwner ? tasksRaw : tasksRaw.map((t) => ({ ...t, title: scrubMoney(t.title) }));
  const closed = isOwner ? closedRaw : closedRaw.map((t) => ({ ...t, title: scrubMoney(t.title), summary: t.summary == null ? t.summary : scrubMoney(t.summary) }));

  // Group by ET calendar day.
  const dayKeys = new Set<string>();
  const tasksByDay = new Map<string, HistoryTask[]>();
  const closedByDay = new Map<string, ClosedRow[]>();
  const deliveriesByDay = new Map<string, typeof deliveries>();
  const shootsByDay = new Map<string, typeof shoots>();
  for (const t of tasks) {
    const k = etDayKey(new Date(t.completedAt));
    dayKeys.add(k);
    (tasksByDay.get(k) ?? tasksByDay.set(k, []).get(k)!).push(t);
  }
  for (const d of deliveries) {
    const k = etDayKey(new Date(d.deliveredAt));
    dayKeys.add(k);
    (deliveriesByDay.get(k) ?? deliveriesByDay.set(k, []).get(k)!).push(d);
  }
  for (const s of shoots) {
    const k = etDayKey(new Date(s.at));
    dayKeys.add(k);
    (shootsByDay.get(k) ?? shootsByDay.set(k, []).get(k)!).push(s);
  }
  for (const c of closed) {
    const k = etDayKey(c.at);
    dayKeys.add(k);
    (closedByDay.get(k) ?? closedByDay.set(k, []).get(k)!).push(c);
  }
  const orderedDays = [...dayKeys].sort((a, b) => (a < b ? 1 : -1)); // newest first

  return (
    <div>
      <PageHeader title="Tasks" subtitle="What happened, day by day — shoots, completed to-dos, and deliveries. Tap “Write a recap” for a plain-English summary." />
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        {tabs}
        {orderedDays.length === 0 && (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted">
            <History className="mx-auto mb-2 size-6 text-muted-2" />
            Nothing recorded in the last 45 days yet.
          </div>
        )}

        {orderedDays.map((key) => {
          const dayTasks = tasksByDay.get(key) ?? [];
          const dayDeliveries = deliveriesByDay.get(key) ?? [];
          const dayShoots = shootsByDay.get(key) ?? [];
          const dayClosed = closedByDay.get(key) ?? [];
          // Build the one-line recap: counts per bucket.
          const buckets = new Map<string, number>();
          for (const t of dayTasks) buckets.set(meta(t.taskType).bucket, (buckets.get(meta(t.taskType).bucket) ?? 0) + 1);
          const recap = [...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${n} ${b.toLowerCase()}`);

          return (
            <section key={key} className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/40 px-4 py-3">
                <h2 className="text-sm font-semibold">{friendlyDay(key)}</h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {dayShoots.length > 0 && (
                    <span className="inline-flex items-center gap-1"><Camera className="size-3.5 text-violet-400 light:text-violet-600" /> {dayShoots.length} {dayShoots.length === 1 ? "shoot" : "shoots"}</span>
                  )}
                  {dayTasks.length > 0 && (
                    <span className="inline-flex items-center gap-1"><CheckCircle2 className="size-3.5 text-success" /> {dayTasks.length} done</span>
                  )}
                  {dayDeliveries.length > 0 && (
                    <span className="inline-flex items-center gap-1"><PackageCheck className="size-3.5 text-brand" /> {dayDeliveries.length} delivered</span>
                  )}
                  {dayClosed.length > 0 && (
                    <span className="inline-flex items-center gap-1"><XCircle className="size-3.5 text-muted-2" /> {dayClosed.length} closed without doing</span>
                  )}
                </div>
              </div>

              {recap.length > 0 && (
                <div className="border-b border-border px-4 py-2 text-xs text-muted-2">{recap.join(" · ")}</div>
              )}

              {/* AI narrative recap of the day (on demand) */}
              <DayRecap dayKey={key} />

              <ul className="divide-y divide-border">
                {dayShoots.map((s) => (
                  <li key={`s-${s.id}`} className="flex items-start gap-2.5 px-4 py-2.5">
                    <Camera className="mt-0.5 size-4 shrink-0 text-violet-400 light:text-violet-600" />
                    <div className="min-w-0 flex-1">
                      <Link href={`/projects/${s.projectId}`} className="text-sm font-medium hover:text-brand">{s.title}</Link>
                      <div className="text-[11px] text-muted-2">Shoot · {s.time}{s.photographer ? ` · ${s.photographer}` : ""}{s.clientName ? ` · ${s.clientName}` : ""}</div>
                    </div>
                  </li>
                ))}
                {dayDeliveries.map((d) => (
                  <li key={`d-${d.id}`} className="flex items-start gap-2.5 px-4 py-2.5">
                    <PackageCheck className="mt-0.5 size-4 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <Link href={`/projects/${d.id}`} className="text-sm font-medium hover:text-brand">{d.title}</Link>
                      <div className="text-[11px] text-muted-2">Delivered · {d.clientName ?? ""} · {etTime(d.deliveredAt)}</div>
                    </div>
                  </li>
                ))}
                {dayTasks.map((t) => {
                  const m = meta(t.taskType);
                  const Icon = ICON[m.bucket] ?? CheckCircle2;
                  return (
                    <li key={t.id} className="flex items-start gap-2.5 px-4 py-2.5">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-2" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 text-sm">
                          {t.projectId ? (
                            <Link href={`/projects/${t.projectId}`} className="font-medium hover:text-brand">{t.title}</Link>
                          ) : (
                            <span className="font-medium">{t.title}</span>
                          )}
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-2">{m.label}</span>
                        </div>
                        <div className="text-[11px] text-muted-2">
                          {t.clientName ? `${t.clientName} · ` : ""}{etTime(t.completedAt)}
                        </div>
                      </div>
                    </li>
                  );
                })}
                {dayClosed.length > 0 && (
                  <li className="bg-surface-2/30 px-4 py-2.5">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                      Dismissed &amp; auto-closed
                    </p>
                    <ul className="space-y-1.5">
                      {dayClosed.map((c) => (
                        <li key={c.id} className="flex items-start gap-2.5">
                          <XCircle className="mt-0.5 size-4 shrink-0 text-muted-2" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 text-sm">
                              {c.projectId ? (
                                <Link href={`/projects/${c.projectId}`} className="font-medium text-foreground/80 hover:text-brand">{c.title}</Link>
                              ) : (
                                <span className="font-medium text-foreground/80">{c.title}</span>
                              )}
                              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-2">{meta(c.taskType).label}</span>
                            </div>
                            <div className="text-[11px] text-muted-2">
                              {c.byHand
                                ? `${c.who ?? "Someone"} — ${c.reason ?? "dismissed"}`
                                : (c.summary?.split("\n")[0] ?? "Closed by the hub")}
                              {" · "}
                              {etTime(c.at)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const ICON: Record<string, typeof CheckCircle2> = {
  Replies: MessageCircle,
  Confirmations: MessageSquareText,
  "QC & delivery": ClipboardCheck,
  Revisions: RefreshCw,
  Vendor: Wrench,
  Team: UsersIcon,
  Photos: ImageIcon,
};

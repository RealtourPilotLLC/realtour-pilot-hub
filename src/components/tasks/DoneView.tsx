import Link from "next/link";
import type { ReactNode } from "react";
import {
  History, CheckCircle2, PackageCheck, MessageCircle, MessageSquareText, ClipboardCheck,
  RefreshCw, ImageIcon, Wrench, Users as UsersIcon, Camera,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getTaskHistory, getDeliveryHistory, getShootHistory, type HistoryTask } from "@/lib/queries";
import { DayRecap } from "@/components/history/DayRecap";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc, etTime } from "@/lib/datetime";

// The day-by-day ledger of what got done — shoots, completed to-dos, deliveries.
// (Moved from /history — now the Tasks hub's Done tab.)

// The hub tab badge: how many tasks were completed today (ET) — one cheap count.
export async function doneTodayCount(): Promise<number> {
  return prisma.smartTask.count({
    where: { status: "COMPLETED", completedAt: { gte: etDayStartUtc(new Date()) } },
  });
}

// Friendly label + grouping bucket per task type.
const TYPE_META: Record<string, { label: string; bucket: string }> = {
  client_reply: { label: "Client reply", bucket: "Replies" },
  comms_followup: { label: "Job instruction", bucket: "Replies" },
  confirmation_text: { label: "Confirmation sent", bucket: "Confirmations" },
  media_qa: { label: "QC", bucket: "QC & delivery" },
  delivery: { label: "Delivery prep", bucket: "QC & delivery" },
  finish_delivery: { label: "Finish delivery", bucket: "QC & delivery" },
  delivery_text: { label: "Delivery text", bucket: "QC & delivery" },
  revision: { label: "Revision", bucket: "Revisions" },
  image_fixes: { label: "Photo fixes", bucket: "QC & delivery" },
  vendor_update: { label: "Vendor update", bucket: "Vendor" },
  internal_instruction: { label: "Team task", bucket: "Team" },
  appointment_prep: { label: "Prep", bucket: "Confirmations" },
};
const meta = (t: string) => TYPE_META[t] ?? { label: t.replace(/_/g, " "), bucket: "Other" };

function friendlyDay(key: string): string {
  const today = etDayKey(new Date());
  const yest = etDayKey(new Date(Date.now() - 86_400_000));
  if (key === today) return "Today";
  if (key === yest) return "Yesterday";
  // key is YYYY-MM-DD (ET); render without TZ math (it's already an ET calendar day).
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export async function DoneView({ tabs }: { tabs: ReactNode }) {
  const [tasks, deliveries, shoots] = await Promise.all([getTaskHistory(45), getDeliveryHistory(45), getShootHistory(45)]);

  // Group by ET calendar day.
  const dayKeys = new Set<string>();
  const tasksByDay = new Map<string, HistoryTask[]>();
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

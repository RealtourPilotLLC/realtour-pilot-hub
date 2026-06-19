import Link from "next/link";
import {
  Sun,
  MessageSquare,
  PackageCheck,
  PhoneCall,
  CircleAlert,
  CheckCircle2,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import type { BriefTask } from "@/lib/queries";

// The four buckets Kyle works each morning, mapped from task type + source.
type BucketKey = "messages" | "deliver" | "calls" | "other";

const BUCKETS: { key: BucketKey; label: string; hint: string; icon: LucideIcon; accent: string }[] = [
  { key: "messages", label: "Messages & follow-ups", hint: "Reply / call back", icon: MessageSquare, accent: "#38bdf8" },
  { key: "deliver", label: "Deliver content", hint: "Next-day turnaround", icon: PackageCheck, accent: "#34d399" },
  { key: "calls", label: "Confirmation & care calls", hint: "Day before / day after", icon: PhoneCall, accent: "#fbbf24" },
  { key: "other", label: "Other to-dos", hint: "", icon: ListChecks, accent: "#a78bfa" },
];

function bucketOf(t: BriefTask): BucketKey {
  switch (t.taskType) {
    case "client_reply":
    case "internal_instruction":
    case "revision":
      return "messages";
    case "delivery":
    case "finish_delivery":
    case "media_qa":
      return "deliver";
    case "appointment_prep":
    case "care_call":
      return "calls";
    default:
      return "other";
  }
}

const SOURCE_LABEL: Record<string, string> = {
  openphone: "OpenPhone",
  slack: "Slack",
  gmail: "Gmail",
  aryeo: "Aryeo",
  system: "Auto",
  manual: "Manual",
};

function dueLabel(iso: string | null, overdue: boolean): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return overdue ? "Overdue" : `by ${t}`;
}

export function MorningBrief({ tasks, firstName = "Kyle" }: { tasks: BriefTask[]; firstName?: string }) {
  const grouped = new Map<BucketKey, BriefTask[]>();
  for (const t of tasks) {
    const k = bucketOf(t);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(t);
  }
  const overdueCount = tasks.filter((t) => t.overdue).length;
  const total = tasks.length;

  return (
    <section className="overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/[0.08] via-surface to-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand">
            <Sun className="size-5" />
          </span>
          <div>
            <div className="eyebrow">Start here</div>
            <h2 className="text-lg font-semibold tracking-tight">Good morning, {firstName}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {total === 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-1.5 font-medium text-success">
              <CheckCircle2 className="size-4" /> All caught up
            </span>
          ) : (
            <>
              <span className="rounded-lg bg-surface-2 px-3 py-1.5 font-medium">
                {total} to-do{total === 1 ? "" : "s"} today
              </span>
              {overdueCount > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-1.5 font-medium text-danger">
                  <CircleAlert className="size-4" /> {overdueCount} overdue
                </span>
              )}
              <Link
                href="/queue"
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
              >
                Full list
              </Link>
            </>
          )}
        </div>
      </div>

      {total === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted">
          Nothing due today — you&apos;re in front of it. 🎉 New texts, calls, and Slack messages will show up here.
        </div>
      ) : (
        <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          {BUCKETS.map((b) => {
            const items = grouped.get(b.key) ?? [];
            return (
              <div key={b.key} className="bg-surface px-4 py-3.5">
                <div className="mb-2 flex items-center gap-2">
                  <b.icon className="size-4" style={{ color: b.accent }} />
                  <span className="text-sm font-semibold">{b.label}</span>
                  <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">
                    {items.length}
                  </span>
                </div>
                {items.length === 0 ? (
                  <p className="py-2 text-xs text-muted-2">Nothing here</p>
                ) : (
                  <ul className="space-y-1.5">
                    {items.slice(0, 6).map((t) => (
                      <li key={t.id}>
                        <Link
                          href={t.projectId ? `/projects/${t.projectId}` : "/queue"}
                          className="group block rounded-lg px-2 py-1.5 hover:bg-surface-2"
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm">{t.title}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                            {t.source && SOURCE_LABEL[t.source] && b.key === "messages" && (
                              <span className="rounded bg-surface-2 px-1 font-medium text-muted-2">
                                {SOURCE_LABEL[t.source]}
                              </span>
                            )}
                            <span className={t.overdue ? "font-medium text-danger" : ""}>
                              {dueLabel(t.dueAt, t.overdue)}
                            </span>
                          </div>
                        </Link>
                      </li>
                    ))}
                    {items.length > 6 && (
                      <li className="px-2 pt-0.5 text-[11px] text-muted-2">+{items.length - 6} more</li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

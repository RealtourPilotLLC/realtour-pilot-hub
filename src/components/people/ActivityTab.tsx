import { formatDistanceToNow } from "date-fns";
import { Activity, Eye, MousePointerClick, UserX } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { PeopleTabs, type PeopleTab } from "@/components/people/PeopleTabs";
import { getUsageOverview } from "@/lib/usage";
import { ROLE_LABEL } from "@/lib/auth/access";
import { etTime, etFullDate } from "@/lib/datetime";

// OWNER-ONLY: who's actually using the platform. Per-person usage cards
// (last seen, intensity, top pages) + the raw recent trail. The page gates
// access — this component just renders.

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

const ROLE_TINT: Record<string, string> = {
  OWNER: "bg-brand-soft text-brand",
  ADMIN: "bg-success/10 text-success",
  EDITOR: "bg-sky-400/10 text-sky-400 light:text-sky-600",
  PHOTOGRAPHER: "bg-warning/10 text-warning",
};

export async function ActivityTab({ show }: { show: PeopleTab[] }) {
  const usage = await getUsageOverview(14);
  const seen = usage.users.filter((u) => u.lastSeenAt);
  const never = usage.users.filter((u) => !u.lastSeenAt);

  return (
    <div>
      <PageHeader
        eyebrow="Owner only"
        title="Platform activity"
        subtitle={`Who's using the hub — last ${usage.windowDays} days · only you can see this`}
      />
      <div className="space-y-6 p-4 sm:p-6">
        <PeopleTabs tab="activity" show={show} />

        <Section icon={Activity} title="By person" count={usage.users.length}>
          <ul className="divide-y divide-border">
            {seen.map((u) => (
              <li key={u.userId} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{u.name ?? u.email}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ROLE_TINT[u.role] ?? "bg-surface-2 text-muted"}`}>
                      {ROLE_LABEL[u.role] ?? u.role}
                    </span>
                    {u.status !== "ACTIVE" && (
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                        {u.status.toLowerCase()}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Last seen {ago(u.lastSeenAt!)}
                    {u.lastPage ? <> · on <span className="text-foreground/80">{u.lastPage}</span></> : null}
                  </div>
                  {u.topPages.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {u.topPages.map((p) => (
                        <span key={p.label} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                          {p.label} <span className="tabular-nums text-muted-2">{p.count}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-4 text-right">
                  <div>
                    <div className="text-sm font-semibold tabular-nums">{u.eventsToday}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-2">today</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold tabular-nums">{u.eventsWindow}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-2">{usage.windowDays}d</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold tabular-nums">{u.activeDays}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-2">days in</div>
                  </div>
                </div>
              </li>
            ))}
            {never.map((u) => (
              <li key={u.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 opacity-75">
                <UserX className="size-4 shrink-0 text-muted-2" />
                <span className="text-sm font-medium">{u.name ?? u.email}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ROLE_TINT[u.role] ?? "bg-surface-2 text-muted"}`}>
                  {ROLE_LABEL[u.role] ?? u.role}
                </span>
                <span className="text-xs text-muted">
                  {u.lastLoginAt
                    ? `no visits in ${usage.windowDays}d — last login ${ago(u.lastLoginAt)}`
                    : u.status === "INVITED"
                      ? "invited — never logged in"
                      : "never logged in"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-2">
            <Eye className="size-3" /> Counts are page visits. Your &ldquo;view as&rdquo; previews are never recorded
            — not for you, not for them.
          </p>
        </Section>

        <Section icon={MousePointerClick} title="Recent trail" count={usage.feed.length || null}>
          {usage.feed.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet — visits start recording from the moment this shipped.</p>
          ) : (
            <ul className="divide-y divide-border">
              {usage.feed.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-sm">
                  <span className="font-medium">{e.name ?? e.email}</span>
                  <span className="text-muted">opened</span>
                  <span className="text-foreground/85">{e.label}</span>
                  <span
                    className="ml-auto shrink-0 text-xs tabular-nums text-muted-2"
                    title={`${etFullDate(e.createdAt)} ${etTime(e.createdAt)}`}
                  >
                    {ago(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Activity, Eye, FlaskConical, LogIn, Mail, MousePointerClick, Users, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/ui/BackLink";
import { ink } from "@/components/ui/Badge";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { isCreativeLead } from "@/lib/auth/access";
import { cn } from "@/lib/utils";
import { etDateTime, etDayKey, etDaysAgo, etFullDate, etMonthDay, etTime } from "@/lib/datetime";
import { contentHref } from "@/lib/contentNav";
import {
  clientActivityFeed, clientActivitySummary, sortRows, waitingPromises, HEALTH, HEALTH_ORDER, SORTS, isHealthKey, isSortKey,
  type ActivityRow, type FeedItem, type FeedKind, type HealthKey, type SortKey, type WaitingItem,
} from "@/lib/clientActivity";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// CLIENT ACTIVITY (Jordan, Oct 14 2026): "Make sure I have an activity screen
// so I can track and see all of our clients' activity." Owner and admin only.
//
// Top: one row per program client (ACTIVE or PAUSED; TEST clients folded
// away) with their portal account, the welcome email, when they were last
// seen, visits, actions, what is waiting on them and a health chip. Below: the
// merged timeline, every client or one (?client=<clientId>), newest first,
// 200 lines a page with "Load older" (?before=<iso>). Everything is read from
// lib/clientActivity.ts, which only reads ledgers the portal already writes.
// All times are Eastern.
//
// CLEANED UP (Jordan, Oct 27 2026: "this looks like s***. Active this week.
// The little pin is here. Formatting's weird"). The nine-column table, the
// plan pill, the health pill and the coloured dots on the filters are gone.
// One row per client, the same on a phone and a desk: the name and plan, then
// how they are doing in plain coloured words, then one status line (last seen,
// visits, actions), then what is waiting on them only when something is. The
// portal account and the welcome email fold under Details. The filters are
// plain words with a count, and the one picked says what it means.
// ---------------------------------------------------------------------------

type SP = { client?: string; health?: string; sort?: string; before?: string };
const ID_RE = /^[a-z0-9]{10,40}$/i;

export default async function ClientActivityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content/activity");
  // The creative manager reads it too (Oct 21 2026): the content program is theirs to oversee.
  if (me && !isCreativeLead(me.role)) redirect("/");

  const sp = await searchParams;
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
  const clientId = one(sp.client) && ID_RE.test(one(sp.client)!) ? one(sp.client)! : null;
  const health: HealthKey | null = isHealthKey(one(sp.health)) ? (one(sp.health) as HealthKey) : null;
  const sort: SortKey = isSortKey(one(sp.sort)) ? (one(sp.sort) as SortKey) : "seen";
  const beforeRaw = one(sp.before);
  const before = beforeRaw && Number.isFinite(Date.parse(beforeRaw)) ? beforeRaw : null;

  const now = new Date();
  const [summary, feed] = await Promise.all([
    // The waiting column streams in (below): the portal readers take a second or two a client.
    clientActivitySummary({ now, waiting: false }).catch((e) => { console.error("[client-activity] summary failed", e); return null; }),
    clientActivityFeed({ clientId, before, limit: 200, now }).catch((e) => { console.error("[client-activity] feed failed", e); return null; }),
  ]);

  const href = (over: Partial<SP>, hash = "") => {
    const p = new URLSearchParams();
    const merged: SP = { client: clientId ?? undefined, health: health ?? undefined, sort: sort === "seen" ? undefined : sort, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/content/activity${s ? `?${s}` : ""}${hash}`;
  };

  // Started now; each cell awaits its own client's promise inside a Suspense boundary.
  const rows = summary ? sortRows(summary.rows.filter((r) => !health || r.health === health), sort) : [];
  const testRows = summary ? sortRows(summary.test, sort) : [];
  // Only the rows on screen, in screen order (the real clients before the TEST ones).
  const waiting: Map<string, Promise<WaitingItem[] | null>> = waitingPromises([...rows, ...testRows].map((r) => ({ enrollmentId: r.enrollmentId, clientId: r.clientId, status: r.status })), now);
  const focus = clientId ? [...(summary?.rows ?? []), ...(summary?.test ?? [])].find((r) => r.clientId === clientId) ?? null : null;
  const focusName = focus?.name ?? feed?.items[0]?.clientName ?? null;

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader
        eyebrow="Content Program"
        title="Client activity"
        subtitle="Who has signed in to the portal, who is using it, and what is waiting on them. Times are Eastern."
      />

      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
        <Section icon={Users} title="Program clients" count={summary ? summary.rows.length : null}
          action={<SortLinks sort={sort} href={href} />}>
          {!summary ? (
            <p className="text-sm text-warning">The client summary could not be read. Refresh to try again.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <nav aria-label="Filter by health" className="flex flex-wrap gap-1.5">
                  <Chip active={!health} href={href({ health: undefined, before: undefined })} label="All" count={summary.rows.length} />
                  {HEALTH_ORDER.map((k) => (
                    <Chip key={k} active={health === k} href={href({ health: k, before: undefined })} label={HEALTH[k].label} count={summary.counts[k]} />
                  ))}
                </nav>
                {health && <p className="mt-2 text-xs text-muted" data-health-hint>{HEALTH[health].label}: {HEALTH[health].hint}.</p>}
              </div>
              {rows.length === 0 ? (
                <p className="text-sm text-muted">No clients {health ? `are “${HEALTH[health].label}”` : "on the program right now"}.</p>
              ) : (
                <ClientRows rows={rows} now={now} href={href} selected={clientId} waiting={waiting} />
              )}
              {testRows.length > 0 && (
                <details className="rounded-xl border border-border">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <FlaskConical className="size-4" aria-hidden /> Test clients ({testRows.length})
                    <span className="text-xs font-normal text-muted-2">not counted above</span>
                  </summary>
                  <div className="border-t border-border p-3">
                    <ClientRows rows={testRows} now={now} href={href} selected={clientId} waiting={waiting} />
                  </div>
                </details>
              )}
            </div>
          )}
        </Section>

        <div id="feed" className="scroll-mt-20">
          <Section icon={Activity} title={clientId ? `Activity: ${focusName ?? "this client"}` : "Activity, all clients"}
            action={clientId ? (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {focus && <Link href={contentHref(focus.enrollmentId)} className="font-medium text-brand hover:underline">Open workspace</Link>}
                <Link href={href({ client: undefined, before: undefined }, "#feed")} className="font-medium text-muted hover:text-foreground">Show all clients</Link>
              </div>
            ) : null}>
            {!feed ? (
              <p className="text-sm text-warning">The activity feed could not be read. Refresh to try again.</p>
            ) : (
              <Feed items={feed.items} showClient={!clientId} href={href} />
            )}
            {feed && (
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted">
                {before && <Link href={href({ before: undefined }, "#feed")} className="font-medium text-muted hover:text-foreground">Back to newest</Link>}
                {feed.nextBefore ? (
                  <Link href={href({ before: feed.nextBefore }, "#feed")} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 font-medium text-foreground hover:bg-surface-2">Load older</Link>
                ) : (
                  <span>{feed.items.length ? "That is everything on record." : ""}</span>
                )}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

// ---- pieces ---------------------------------------------------------------------

function Chip({ href, label, count, active }: { href: string; label: string; count: number; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
        active ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/20" : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}>
      {label}
      <span className="tabular-nums text-xs opacity-80">{count}</span>
    </Link>
  );
}

function SortLinks({ sort, href }: { sort: SortKey; href: (o: Partial<SP>, hash?: string) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs" aria-label="Sort clients">
      <span className="text-muted-2">Sort:</span>
      {SORTS.map((s) => (
        <Link key={s.key} href={href({ sort: s.key === "seen" ? undefined : s.key, before: undefined })} aria-current={sort === s.key ? "true" : undefined}
          className={cn("rounded-md px-2 py-1", sort === s.key ? "bg-surface-2 font-semibold text-foreground" : "text-muted hover:text-foreground")}>
          {s.label}
        </Link>
      ))}
    </div>
  );
}

function ago(d: Date, now: Date): string {
  const mins = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const days = etDaysAgo(d);
  if (days === 0) return `today ${etTime(d)}`;
  if (days === 1) return `yesterday ${etTime(d)}`;
  if (days < 30) return `${days} days ago`;
  return etMonthDay(d);
}

const ACCOUNT_WORD = { NONE: "No portal account", INVITED: "Invited to the portal", SIGNED_UP: "Signed up to the portal" } as const;

/** The portal account and the welcome email, in words (under Details). */
function AccountLine({ r }: { r: ActivityRow }) {
  const people = r.people.map((p) => `${p.name ?? "Unnamed"}${p.signedUp ? "" : " (not signed in)"}`).join(", ");
  return (
    <div className="space-y-0.5 text-xs text-muted">
      <p>
        {ACCOUNT_WORD[r.account]}
        {r.firstSignInAt ? `, first signed in ${etMonthDay(r.firstSignInAt)}` : ""}
        {people ? `. People: ${people}` : ""}.
      </p>
      <p>{r.welcomeSentAt ? `Welcome email sent ${etDateTime(r.welcomeSentAt)} ET.` : "Welcome email not sent yet."}</p>
    </div>
  );
}

async function WaitingList({ p }: { p: Promise<WaitingItem[] | null> | undefined }) {
  const items = p ? await p : null;
  if (items === null) return <p className="text-xs text-warning">What is waiting on them could not be read just now.</p>;
  // Nothing waiting: no line at all (Oct 27 2026, empty states stay quiet).
  if (items.length === 0) return null;
  return <p className="text-sm"><span className="font-medium">Waiting on them:</span> {items.map((w) => w.label).join(", ")}</p>;
}

function Waiting({ r, waiting }: { r: ActivityRow; waiting: Map<string, Promise<WaitingItem[] | null>> }) {
  if (r.status !== "ACTIVE") return null;
  return (
    <Suspense fallback={<p className="text-xs text-muted-2">Checking what is waiting on them…</p>}>
      <WaitingList p={waiting.get(r.enrollmentId)} />
    </Suspense>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ClientRows({ rows, now, href, selected, waiting }: { rows: ActivityRow[]; now: Date; href: (o: Partial<SP>, hash?: string) => string; selected: string | null; waiting: Map<string, Promise<WaitingItem[] | null>> }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" data-client-rows>
      {rows.map((r) => {
        const h = HEALTH[r.health];
        return (
          <li key={r.enrollmentId} data-client-row={r.clientId} className={cn("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between", selected === r.clientId && "bg-brand-soft/40")}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <Link href={contentHref(r.enrollmentId)} className="font-semibold text-foreground hover:text-brand hover:underline">{r.name}</Link>
                <span className="text-xs text-muted">{r.pkg} plan{r.status !== "ACTIVE" ? `, ${r.status.toLowerCase()}` : ""}</span>
              </p>
              <p className="text-sm">
                <span className="font-medium" style={{ color: ink(h.color) }} data-health={r.health}>{h.label}</span>
                <span className="text-muted">
                  {" · "}
                  {r.lastSeenAt ? `last seen ${ago(r.lastSeenAt, now)}` : "never seen on the portal"}
                  {" · "}
                  {plural(r.visits7, "visit")} this week, {r.visits30} this month
                  {" · "}
                  {plural(r.actions7, "action")} this week
                </span>
              </p>
              <Waiting r={r} waiting={waiting} />
              <details className="group text-xs">
                <summary className="inline-flex min-h-9 cursor-pointer list-none items-center font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">Details</summary>
                <AccountLine r={r} />
              </details>
            </div>
            <Link href={href({ client: r.clientId, before: undefined }, "#feed")} className="inline-flex min-h-11 shrink-0 items-center self-start rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-surface-2">
              Activity
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const KIND_ICON: Record<FeedKind, LucideIcon> = { visit: Eye, signin: LogIn, action: MousePointerClick, system: Mail };
const KIND_WORD: Record<FeedKind, string> = { visit: "Visit", signin: "Sign-in", action: "Client action", system: "Sent to the client" };

function Feed({ items, showClient, href }: { items: FeedItem[]; showClient: boolean; href: (o: Partial<SP>, hash?: string) => string }) {
  if (items.length === 0) return <p className="text-sm text-muted">Nothing on record yet.</p>;
  const days: { key: string; label: string; items: FeedItem[] }[] = [];
  for (const i of items) {
    const key = etDayKey(i.at);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(i);
    else days.push({ key, label: etFullDate(i.at), items: [i] });
  }
  return (
    <div className="space-y-5">
      {days.map((d) => (
        <section key={d.key} aria-label={d.label}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">{d.label}</h3>
          <ol className="space-y-1">
            {d.items.map((i) => {
              const Icon = KIND_ICON[i.kind];
              return (
                <li key={i.id} className="flex gap-3 rounded-lg px-1 py-1.5">
                  <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted-2" title={i.atLabel}>{etTime(i.at)}</span>
                  <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", i.kind === "system" ? "bg-surface-2 text-muted-2" : i.kind === "action" ? "bg-brand-soft text-brand" : "bg-surface-2 text-muted")} title={KIND_WORD[i.kind]}>
                    <Icon aria-hidden className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn("break-words text-sm", i.kind === "system" && "text-muted")}>{i.text}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-2">
                      {showClient && <Link href={href({ client: i.clientId, before: undefined }, "#feed")} className="font-medium text-muted hover:text-brand hover:underline">{i.clientName}</Link>}
                      {i.who && <span>{i.who}</span>}
                      {i.detail && <span>{i.detail}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

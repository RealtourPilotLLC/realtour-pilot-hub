import Link from "next/link";
import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { ShootsScheduleTabs } from "@/components/jobs/ShootsScheduleTabs";
import { canAccess } from "@/lib/auth/access";
import { ShootsList } from "@/components/jobs/ShootsList";
import { ProgramVideoWatch, type WatchViewRow } from "@/components/tracker/ProgramVideoWatch";
import { SHOOT_FILTERS, filterShootRows, shootsBoard, type ShootFilter } from "@/lib/jobsBoard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SHOOTS (Oct 19 2026; menu label "Shoots", route /jobs because /shoot is the
// photographers' screen). Jordan: "I need to be able to track each job and
// where they are at, and special requests for either photo or video." The
// home page oversees; this is the in-depth list: every shoot in progress with
// its due date, where the photos and the video stand, and the client's open
// requests, late first. Each row opens the job's own page (/projects/<id>),
// which has the Photos and Video cards.
//
// Filters: Open (the default: everything not delivered), Late, Due today
// (the late ones included, Jordan's rule), This week (due in the next 7 days,
// late included), Requests (an open client request on the shoot: the
// dashboard's Special requests tile lands here), Monthly, All (the last 10
// days' delivered too). The
// program videos' milestones (ProgramVideoWatch, which lived on the old
// Project Tracker) sit under the list on Open and Monthly. /pipeline (the old
// Project Tracker) redirects here, so the program alerts' link still lands.
// ---------------------------------------------------------------------------

const EMPTY: Record<ShootFilter, string> = {
  open: "Nothing in progress. Every shoot is delivered.",
  late: "Nothing is late.",
  today: "Nothing is due today, and nothing is late.",
  week: "Nothing is due in the next 7 days.",
  requests: "No open client requests on a shoot in progress.",
  monthly: "No monthly content in progress.",
  all: "No shoots in progress or delivered in the last 10 days.",
};

async function programWatch(now: Date, includeTest: boolean): Promise<{ rows: WatchViewRow[]; rules: Awaited<ReturnType<typeof import("@/lib/programWatch").programWatchBoard>>["rules"]; causesAvailable: boolean } | null> {
  try {
    const [{ programWatchBoard }, { MILESTONE_WORDS, metAt, staffWhen }] = await Promise.all([import("@/lib/programWatch"), import("@/lib/programWatchCore")]);
    const watch = await programWatchBoard({ now, includeTest });
    const rows: WatchViewRow[] = watch.rows.map((r) => ({
      outputId: r.outputId,
      projectId: r.projectId,
      enrollmentId: r.enrollmentId,
      clientName: r.clientName,
      monthWords: r.monthWords,
      title: r.title,
      level: r.level,
      why: r.why,
      promise: r.promisedAt ? staffWhen(r.promisedAt) : null,
      milestones: r.milestones.map((m) => {
        const met = metAt(m.key, r.facts);
        return { label: MILESTONE_WORDS[m.key].label, by: staffWhen(m.by), state: met ? (met > m.by ? "late" : "met") : m.by <= now ? "missed" : "ahead" };
      }),
      suggestion: r.suggestion,
      recorded: r.recorded ? { ...r.recorded, at: r.recorded.at?.toISOString() ?? null } : null,
    }));
    return { rows, rules: watch.rules, causesAvailable: watch.causesAvailable };
  } catch (e) {
    // A failed read hides the panel rather than the list.
    console.error("[shoots] program watch failed", e);
    return null;
  }
}

export default async function ShootsPage({ searchParams }: { searchParams: Promise<{ f?: string; test?: string }> }) {
  await requirePageAccess("pipeline");
  const sp = await searchParams;
  const f: ShootFilter = SHOOT_FILTERS.find((x) => x.key === sp.f)?.key ?? "open";
  const includeTest = sp.test === "1";
  const now = new Date();
  const [board, watch, me] = await Promise.all([
    shootsBoard(now, { includeTest, includeDelivered: f === "all" }).catch((e: unknown) => {
      console.error("[shoots] board failed", e);
      return null;
    }),
    // The program videos' milestones (they lived on the old Project Tracker): on Open and Monthly, where
    // the program alerts' "/pipeline#program-watch" link lands.
    f === "monthly" || f === "open" ? programWatch(now, includeTest) : Promise.resolve(null),
    getCurrentUser().catch(() => null),
  ]);
  const href = (key: ShootFilter, test = includeTest) => {
    const q = new URLSearchParams();
    if (key !== "open") q.set("f", key);
    if (test) q.set("test", "1");
    const s = q.toString();
    return s ? `/jobs?${s}` : "/jobs";
  };
  const rows = board?.rows ?? [];
  const shown = filterShootRows(rows, f);
  const counts = board?.counts;
  const tally = Object.fromEntries(SHOOT_FILTERS.map((x) => [x.key, filterShootRows(rows, x.key).length])) as Record<ShootFilter, number>;
  const subtitle = counts
    ? `${counts.late} late · ${counts.dueToday} due today · ${counts.dueTomorrow} due tomorrow · ${counts.total} in progress${includeTest ? " · test records shown" : ""}`
    : "The list could not be read just now.";
  const canEdit = !me || me.role === "OWNER" || me.role === "ADMIN";

  return (
    <div>
      <PageHeader
        title="Shoots"
        subtitle={subtitle}
        actions={
          <Link href={href(f, !includeTest)} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            {includeTest ? "Hide test records" : "Show test records"}
          </Link>
        }
      />
      <ShootsScheduleTabs current="shoots" includeTest={includeTest} show={!me || canAccess(me, "schedule")} />
      <div className="mx-auto max-w-6xl space-y-4 p-4 pb-16 sm:p-6">
        <nav aria-label="Filter shoots" className="flex flex-wrap gap-2">
          {SHOOT_FILTERS.map((x) => {
            const on = x.key === f;
            return (
              <Link
                key={x.key}
                href={href(x.key)}
                aria-current={on ? "page" : undefined}
                data-filter={x.key}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${on ? "border-brand bg-brand/15 text-brand" : "border-border text-muted hover:bg-surface-2 hover:text-foreground"}`}
              >
                {x.label}
                {board && x.key !== "all" && <span className="tabular-nums text-xs opacity-80">{tally[x.key]}</span>}
              </Link>
            );
          })}
        </nav>
        {f === "today" && <p className="text-xs text-muted">Due today, with the late ones first.</p>}
        {board ? (
          <ShootsList rows={shown} empty={EMPTY[f]} />
        ) : (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
            The shoots list could not be read just now, so nothing here is a count of zero. Reload in a minute.
          </p>
        )}
        {watch && <ProgramVideoWatch rows={watch.rows} rules={watch.rules} canEdit={canEdit} causesAvailable={watch.causesAvailable} />}
      </div>
    </div>
  );
}

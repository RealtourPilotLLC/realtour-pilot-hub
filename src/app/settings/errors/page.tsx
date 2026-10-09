import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { requirePageAccess, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { ErrorReports, type ErrorReportRow } from "@/components/settings/ErrorReports";
import { etDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SETTINGS → ERRORS (Oct 6 2026). Jordan: "I also want to make sure we are
// tracking any errors that arise so we can get the reports of them and fix
// them quickly." Every error the hub records (lib/errorTracker.ts), one row per
// bug with its count — newest or most frequent first, Open / Fixed / Ignored.
// Open one for its stack, routes and times, then Mark fixed / Ignore / Reopen,
// or "Copy for Claude" to paste a ready-made report into a Claude session.
// Owner-only: stacks and routes are the inside of the system.
// ---------------------------------------------------------------------------

const STATUSES = { open: "OPEN", fixed: "FIXED", ignored: "IGNORED", all: "ALL" } as const;

// A scheduled job's provider timeout is recorded but quiet until it persists
// (lib/cronNoise.ts) — say which of the two it is, so a row that sent no
// message does not look like one that was missed.
function watchNote(context: Record<string, unknown> | null): string | null {
  if (!context || context.transient !== true) return null;
  if (typeof context.persistentSince === "string") {
    return `Kept failing since ${etDateTime(context.persistentSince)} (${typeof context.rule === "string" ? context.rule : "it persisted"}) — counted as open.`;
  }
  const n = typeof context.failedRunsInARow === "number" ? context.failedRunsInARow : 1;
  return `Brief provider timeout — not messaged: the next run usually catches up. ${n} failed run${n === 1 ? "" : "s"} in a row so far; you're messaged at 3 in a row or 6 hours without a success.`;
}

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<{ status?: string; sort?: string; id?: string }> }) {
  await requirePageAccess("settings");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/settings/errors");
  if (me && me.role !== "OWNER") redirect("/settings");
  const canAct = me ? me.realRole === "OWNER" && !me.impersonating : !authEnforced();

  const sp = await searchParams;
  const statusKey = (sp.status && sp.status in STATUSES ? sp.status : "open") as keyof typeof STATUSES;
  const sort = sp.sort === "frequent" ? "frequent" : "recent";
  const { listErrors, claudeReport } = await import("@/lib/errorTracker");
  let readError: string | null = null;
  let data: Awaited<ReturnType<typeof listErrors>> = { rows: [], counts: { OPEN: 0, FIXED: 0, IGNORED: 0 }, missing: false };
  try {
    data = await listErrors(STATUSES[statusKey], sort);
  } catch (e) {
    readError = `The error list could not be read just now (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). Reload to try again.`;
  }
  const rows: ErrorReportRow[] = data.rows.map((r) => ({
    ...r,
    firstSeenLabel: etDateTime(r.firstSeenAt),
    lastSeenLabel: etDateTime(r.lastSeenAt),
    resolvedLabel: r.resolvedAt ? etDateTime(r.resolvedAt) : null,
    reopenedLabel: r.reopenedAt ? etDateTime(r.reopenedAt) : null,
    watchNote: watchNote(r.context),
    report: claudeReport(r),
  }));

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/settings#integrations" label="Settings" />
      </div>
      <PageHeader
        title="Errors"
        subtitle="Every error the hub has hit, one row per problem with how often it happened. New ones message you on Slack."
        sticky={false}
      />
      <div className="mx-auto min-w-0 max-w-4xl space-y-4 p-4 pb-16 [overflow-wrap:anywhere] sm:p-6">
        {data.missing && (
          <p className="rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-sm">
            Error tracking is installed but its table hasn&rsquo;t been added to the database yet, so nothing is being recorded.
            It starts the moment the schema is pushed.
          </p>
        )}
        {readError && <p className="rounded-xl border border-danger/30 px-4 py-3 text-sm text-danger">{readError}</p>}
        <ErrorReports
          rows={rows}
          counts={data.counts}
          status={statusKey}
          sort={sort}
          selectedId={typeof sp.id === "string" ? sp.id : null}
          canAct={canAct}
        />
      </div>
    </div>
  );
}

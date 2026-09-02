import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  Flag,
  Inbox,
  MessageSquareHeart,
  Package,
  Star,
  UserRound,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { PlatformFeedbackItem } from "@/components/feedback/PlatformFeedbackItem";
import { prisma } from "@/lib/prisma";
import { etDate, etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { QualityTabs, type QualityTab } from "./QualityTabs";
import { HandledToggle } from "./HandledToggle";
import {
  getClientFeedbackFeed,
  getPhotographerBoard,
  getTabCounts,
  type ClientFilter,
  type ClientFeedbackItem,
  type PhotographerBlock,
} from "./data";

// Moderating a field flag (approve / decline / mark sorted) is an OWNER
// decision in decidePlatformFeedback — don't render buttons that silently
// fail for Kyle, exactly as the /feedback board does.
type Moderation = { canModerate: boolean; pingTargets: { id: string; name: string }[] };

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /quality — FEEDBACK ABOUT THE WORK, in two tabs:
//   • Client feedback      — every response to the public form (/feedback/<id>,
//                            linked from the delivery text) plus the unhappy
//                            texts/emails the comms brain files as feedback.
//   • Photographer feedback — the capture-quality signals per shooter.
//
// It is deliberately NOT under /feedback: middleware treats every
// /feedback/<one-segment> path as PUBLIC (that's the client-facing form), so a
// page of client names and complaints at /feedback/clients would have shipped
// with no login gate at all. /quality has no PageKey either, which means
// middleware only checks that you're SIGNED IN — the owner/admin check below
// is the real gate and must stay. The sibling board at /feedback keeps its own
// key and stays what it is: feedback about the HUB.
// ---------------------------------------------------------------------------

export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  const me = await getCurrentUser().catch(() => null);
  // Fail CLOSED: a transient null under enforcement is unauthenticated (or a
  // disabled account still holding a live JWT) — never the owner view.
  if (!me && authEnforced()) redirect("/login?next=/quality");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));

  const sp = await searchParams;
  const tab: QualityTab = sp.tab === "photographers" ? "photographers" : "clients";
  const filter: ClientFilter =
    sp.filter === "unhappy" || sp.filter === "rated" || sp.filter === "open" ? sp.filter : "all";

  // Load ONLY the tab being viewed (the /users + /communications pattern) —
  // the photographer roll is four queries nobody asked for on a client view.
  const [tabCounts, feed, board] = await Promise.all([
    getTabCounts(),
    tab === "clients" ? getClientFeedbackFeed(filter) : null,
    tab === "photographers" ? getPhotographerBoard() : null,
  ]);

  // Sessionless local dev (gate off) reads as the owner, same as /feedback.
  const canModerate = !me || me.role === "OWNER";
  const mod: Moderation = {
    canModerate,
    pingTargets:
      board && canModerate
        ? await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
        : [],
  };

  return (
    <div>
      <PageHeader
        eyebrow="Quality desk"
        title="Client & team feedback"
        subtitle="What clients said about the work, and how each photographer is doing. Requests and bugs about the hub itself live on Feedback & requests."
      />
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-5 sm:px-6">
        <QualityTabs active={tab} counts={tabCounts} />
        {feed && <ClientTab feed={feed} />}
        {board && <PhotographerTab board={board} mod={mod} />}
      </div>
    </div>
  );
}

// ------------------------------- Client tab --------------------------------

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${n} out of 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} className={i < n ? "size-3.5 fill-current text-warning" : "size-3.5 text-muted-2/50"} />
      ))}
    </span>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "warning" }) {
  return (
    <div className={cn("rounded-2xl border bg-surface p-4", tone === "warning" && "border-warning/30 bg-warning-soft/40")}>
      <div className="text-[11px] uppercase tracking-wide text-muted-2">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "warning" && "text-warning")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  form: "Feedback form",
  text: "Text message",
  email: "Email",
};

const FILTERS: { key: ClientFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Not handled" },
  { key: "unhappy", label: "Unhappy" },
  { key: "rated", label: "With a rating" },
];

function ClientTab({ feed }: { feed: NonNullable<Awaited<ReturnType<typeof getClientFeedbackFeed>>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Responses"
          value={feed.total}
          sub={`${feed.last90} in the last 90 days`}
        />
        <Tile
          label="Average rating"
          value={
            feed.avgRating != null ? (
              <span className="inline-flex items-center gap-1.5">
                {feed.avgRating}
                <Star className="size-5 fill-current text-warning" />
              </span>
            ) : (
              "—"
            )
          }
          sub={feed.ratingCount > 0 ? `from ${feed.ratingCount} rating${feed.ratingCount === 1 ? "" : "s"}` : "nobody has rated a job yet"}
        />
        <Tile
          label="Unhappy, open"
          value={feed.openNegative}
          sub={feed.openNegative > 0 ? "waiting to be made right" : "nothing outstanding"}
          tone={feed.openNegative > 0 ? "warning" : undefined}
        />
        <Tile
          label="Delivered (90d)"
          value={feed.delivered90}
          sub={`${feed.last90} response${feed.last90 === 1 ? "" : "s"} in the same window`}
        />
      </div>

      {/* The honest health check on the ask itself. The form is the only place
          a star rating can come from, so zero form responses means the loop is
          not closing — say so out loud rather than showing an empty list. */}
      {feed.formResponses === 0 && (
        <Section icon={AlertTriangle} title="Nobody has filled in the feedback form yet" tone="warning">
          <p className="text-sm text-muted">
            Every delivery text ends with a link to <span className="font-medium text-foreground">/feedback/&lt;job&gt;</span> — the
            star-rating form clients fill in. <span className="font-medium text-foreground">{feed.total}</span> feedback{" "}
            {feed.total === 1 ? "row exists" : "rows exist"} in the system and{" "}
            <span className="font-medium text-foreground">none</span> came from that form, so no rating has ever been
            collected. Worth checking that the delivery texts are actually going out with the link before reading
            anything into an empty list here.
          </p>
        </Section>
      )}

      {/* Where these rows come from, stated once. Most clients answer the
          delivery text in words rather than opening the form, and a warm reply
          ("these look amazing") never becomes a row here — only complaints do,
          because the comms brain files on NEGATIVE sentiment only. Say that
          plainly so an empty list is never mistaken for a happy month. */}
      <p className="text-xs text-muted">
        Two things land here: responses to the star-rating form we link from the delivery text, and inbound texts or
        emails the comms brain reads as unhappy. Praise sent as a plain reply does not — read those in{" "}
        <Link href="/communications" className="text-brand hover:underline">
          Communications
        </Link>
        .
      </p>

      <Section
        icon={Inbox}
        title="Every client response"
        count={feed.counts[feed.filter]}
        flush
        action={
          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === "all" ? "/quality?tab=clients" : `/quality?tab=clients&filter=${f.key}`}
                className={cn(
                  "rounded-lg px-2 py-1 text-xs font-medium",
                  feed.filter === f.key ? "bg-brand-soft text-brand" : "text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                {f.label}
                <span className="ml-1 tabular-nums text-muted-2">{feed.counts[f.key]}</span>
              </Link>
            ))}
          </div>
        }
      >
        {feed.items.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            {feed.total === 0
              ? "No client feedback yet. Responses land here the moment a client fills in the form we link from the delivery text, and unhappy texts or emails are filed here automatically."
              : "Nothing matches this filter."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {feed.items.map((f) => (
              <ClientRow key={f.id} f={f} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ClientRow({ f }: { f: ClientFeedbackItem }) {
  const negative = f.sentiment === "NEGATIVE";
  return (
    <li className={cn("px-5 py-4", negative && !f.resolved && "bg-warning-soft/25")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {f.rating != null ? (
          <Stars n={f.rating} />
        ) : (
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              negative ? "bg-danger/10 text-danger" : f.sentiment === "POSITIVE" ? "bg-success/10 text-success" : "bg-surface-2 text-muted",
            )}
          >
            {negative ? "Unhappy" : f.sentiment === "POSITIVE" ? "Happy" : "Neutral"}
          </span>
        )}
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          {SOURCE_LABEL[f.source] ?? f.source}
        </span>
        {f.category && (
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{f.category}</span>
        )}
        {f.resolved && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
            <CheckCircle2 className="size-3.5" /> Handled
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-2">{etDateTime(f.createdAt)}</span>
      </div>

      <p className="mt-1.5 whitespace-pre-line text-sm">{f.body}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5 text-muted-2" />
          {f.clientId ? (
            <Link href={`/clients/${f.clientId}`} className="font-medium text-foreground hover:underline">
              {f.clientName ?? "Client"}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{f.clientName ?? "Client"}</span>
          )}
          {f.authorName && f.authorName !== f.clientName && <span className="text-muted-2">· signed “{f.authorName}”</span>}
        </span>
        <span className="text-muted-2">·</span>
        <span className="inline-flex items-center gap-1">
          <Package className="size-3.5 text-muted-2" />
          <Link href={`/projects/${f.projectId}`} className="hover:underline" title={f.projectTitle}>
            {f.street}
          </Link>
          {f.shootDate && <span className="text-muted-2">shot {etDate(f.shootDate)}</span>}
        </span>
        {f.photographerName && (
          <>
            <span className="text-muted-2">·</span>
            <span className="inline-flex items-center gap-1">
              <Camera className="size-3.5 text-muted-2" />
              {f.photographerName}
              {/* Only the public form stamps photographerId. Rows the comms
                  brain files (an unhappy text) carry none, so this name is the
                  job's CURRENT photographer — true today, but not a receipt. */}
              {f.photographerInferred && <span className="text-muted-2">(from the job)</span>}
            </span>
          </>
        )}
        <span className="ml-auto">
          <HandledToggle id={f.id} handled={f.resolved} />
        </span>
      </div>
    </li>
  );
}

// ---------------------------- Photographer tab ------------------------------

const NOTE_TONE: Record<string, string> = {
  OPEN: "bg-warning/10 text-warning",
  FIXED: "bg-success/10 text-success",
  RESOLVED: "bg-surface-2 text-muted",
};

function PhotographerTab({
  board,
  mod,
}: {
  board: NonNullable<Awaited<ReturnType<typeof getPhotographerBoard>>>;
  mod: Moderation;
}) {
  if (board.blocks.length === 0 && board.unmatchedFlags.length === 0) {
    return (
      <Section icon={Camera} title="Photographer feedback">
        <p className="text-sm text-muted">
          Nothing yet. Capture feedback appears the moment someone leaves a photographer-lane note in a project&rsquo;s
          media review or a cut review, and field flags appear when a photographer raises one from the shoot screen,
          the upload portal, or the debrief.
        </p>
      </Section>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">
        Everything said about each photographer&rsquo;s work: what clients wrote about their shoots, the capture notes
        from photo and video reviews, and the flags they raised in the field. Each of them sees only their own — and
        only the creative-safe version — on{" "}
        <Link href="/shoot/feedback" className="text-brand hover:underline">
          their quality hub
        </Link>
        .
      </p>
      {board.blocks.map((b) => (
        <PhotographerBlockCard key={b.memberId} b={b} mod={mod} />
      ))}
      {board.unmatchedFlags.length > 0 && (
        <Section icon={Flag} title="Field flags we couldn't match to a person" count={board.unmatchedFlags.length}>
          <p className="mb-2 text-xs text-muted">
            The name on these doesn&rsquo;t match anyone on the roster — usually a login spelled differently from the
            team record. Nothing is dropped; they just have no owner to file under.
          </p>
          <div className="space-y-2">
            {board.unmatchedFlags.map((f) => (
              <PlatformFeedbackItem key={f.id} row={f} canModerate={mod.canModerate} pingTargets={mod.pingTargets} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function PhotographerBlockCard({ b, mod }: { b: PhotographerBlock; mod: Moderation }) {
  const notes = b.notes.slice(0, 8);
  return (
    <Section
      icon={Camera}
      title={b.name}
      flush
      action={
        <Link
          href={`/shoot/feedback?as=${b.memberId}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          What they see <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2.5 text-[11px] text-muted">
        <span>
          <span className="font-semibold text-foreground tabular-nums">{b.shoots90}</span> shoot{b.shoots90 === 1 ? "" : "s"} in 90d
        </span>
        <span>
          <span className="font-semibold text-foreground tabular-nums">{b.totalNotes}</span> capture note
          {b.totalNotes === 1 ? "" : "s"} all-time
        </span>
        {b.openFixes > 0 && <span className="rounded-full bg-warning/10 px-2 py-0.5 font-medium text-warning">{b.openFixes} to fix</span>}
        {b.awaitingReReview > 0 && (
          <span className="rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">{b.awaitingReReview} fixed, needs a re-look</span>
        )}
        {b.openCoaching > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted">{b.openCoaching} coaching</span>}
        <span className="ml-auto inline-flex items-center gap-1">
          {b.avgRating != null ? (
            <>
              <span className="font-semibold text-foreground tabular-nums">{b.avgRating}</span>
              <Star className="size-3.5 fill-current text-warning" />
              <span className="text-muted-2">({b.ratingCount})</span>
            </>
          ) : (
            <span className="text-muted-2">no client ratings yet</span>
          )}
        </span>
      </div>

      {b.clientWords.length > 0 && (
        <div className="border-b border-border">
          <div className="flex items-center gap-1.5 px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
            <MessageSquareHeart className="size-3.5" /> What clients said about their shoots
          </div>
          <ul className="divide-y divide-border">
            {b.clientWords.slice(0, 5).map((c) => (
              <li key={c.id} className="px-5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {c.rating != null && <Stars n={c.rating} />}
                  {c.sentiment === "NEGATIVE" && (
                    <span className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Unhappy</span>
                  )}
                  <Link href={`/projects/${c.projectId}`} className="text-[11px] text-muted hover:underline">
                    {c.street}
                  </Link>
                  <span className="ml-auto text-[11px] text-muted-2">{etDate(c.createdAt)}</span>
                </div>
                {/* Owner view: verbatim, unscrubbed. The photographer's own copy
                    of this row is filtered + money-scrubbed on /shoot/feedback. */}
                <p className="mt-0.5 text-sm">{c.body}</p>
                {c.authorName && <p className="text-[11px] text-muted-2">— {c.authorName}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notes.length > 0 && (
        <div className="border-b border-border">
          <div className="flex items-center gap-1.5 px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
            <Star className="size-3.5" /> Capture notes from reviews
          </div>
          <ul className="divide-y divide-border">
            {notes.map((n) => (
              <li key={n.id} className="px-5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-medium", NOTE_TONE[n.status] ?? "bg-surface-2 text-muted")}>
                    {n.status === "OPEN" ? (n.kind === "coaching" ? "Coaching" : "To fix") : n.status === "FIXED" ? "Fixed" : "Resolved"}
                  </span>
                  <Link href={`/projects/${n.projectId}`} className="text-[11px] text-muted hover:underline">
                    {n.street}
                  </Link>
                  <span className="text-[11px] text-muted-2">{etDate(n.createdAt)}</span>
                  {/* Did the feedback actually land? A note nobody opened is a
                      note nobody acted on — the loop, not just the message. */}
                  {n.acknowledgedAt ? (
                    <span className="ml-auto text-[11px] text-success">Got it {etDate(n.acknowledgedAt)}</span>
                  ) : n.seenAt ? (
                    <span className="ml-auto text-[11px] text-muted-2">Seen {etDate(n.seenAt)}</span>
                  ) : (
                    <span className="ml-auto text-[11px] text-warning">Not opened yet</span>
                  )}
                </div>
                <p className="mt-0.5 text-sm">{n.body}</p>
              </li>
            ))}
          </ul>
          {b.notes.length > notes.length && (
            <Link
              href={`/shoot/feedback?as=${b.memberId}`}
              className="block px-5 py-2 text-xs font-medium text-brand hover:underline"
            >
              {b.notes.length - notes.length} more note{b.notes.length - notes.length === 1 ? "" : "s"} →
            </Link>
          )}
        </div>
      )}

      {b.flags.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
            <Flag className="size-3.5" /> Flags they raised from the field
          </div>
          <div className="space-y-2 px-5 pb-4 pt-1">
            {b.flags.map((f) => (
              <PlatformFeedbackItem key={f.id} row={f} canModerate={mod.canModerate} pingTargets={mod.pingTargets} />
            ))}
          </div>
        </div>
      )}

      {b.clientWords.length === 0 && notes.length === 0 && b.flags.length === 0 && (
        <p className="px-5 py-4 text-sm text-muted">
          No feedback on record — {b.shoots90} shoot{b.shoots90 === 1 ? "" : "s"} in the last 90 days with nothing raised.
        </p>
      )}
    </Section>
  );
}


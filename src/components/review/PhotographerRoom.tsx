import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Hourglass, MessageSquarePlus, PlayCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getPhotographerReviewQueue, type PhotographerCut } from "@/lib/reviewRoom";

// ---------------------------------------------------------------------------
// THE REVIEW ROOM, AS THE PERSON WHO SHOT IT SEES IT (Jordan, Sep 18: "I want
// to be able to share the review room with the photographer who shot the
// video … they should be notified just like I am, with access to the review
// room").
//
// The office's /review is every client's cut plus Kyle's photo-QC rail and the
// recurring-miss scoreboards, and a photographer was redirected off it. Sending
// them to /shoot instead was the Sep 17 answer and it was a dead end: the only
// way into a cut was the link in a tag, so a video from their own shoot they
// were never tagged on was unreachable. This is their index — the cuts that
// came out of their shoots and nothing else.
//
// NO MONEY, BY CONSTRUCTION: a PhotographerCut carries a street, a client name,
// a round and a verdict. There is no price, balance or payout on this type for
// a scrubber to have to catch.
// ---------------------------------------------------------------------------

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

function CutRow({ c, decided }: { c: PhotographerCut; decided?: boolean }) {
  return (
    <li>
      <Link
        href={`/review/${c.projectId}?cut=${c.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
      >
        <PlayCircle className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{c.street}</span>
            {c.fileName && (
              <span className="max-w-48 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{c.fileName}</span>
            )}
            {c.round > 1 && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Version {c.round}</span>}
            {!c.hasAsset && <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">No file found</span>}
            {c.myOpenNotes > 0 && (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
                {c.myOpenNotes} note{c.myOpenNotes === 1 ? "" : "s"} for you
              </span>
            )}
            {c.myOpenAsks > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
                <MessageSquarePlus className="size-3" /> {c.myOpenAsks} change{c.myOpenAsks === 1 ? "" : "s"} you asked for
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {c.clientName && <Avatar name={c.clientName} src={c.clientAvatarUrl} size={18} />}
            <span className="truncate">
              {c.clientName}
              {" · "}
              {decided && c.decidedAt ? `decided ${ago(c.decidedAt)}` : `handed in ${ago(c.createdAt)}`}
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}

export async function PhotographerRoom({ memberId, firstName }: { memberId: string; firstName: string }) {
  const q = await getPhotographerReviewQueue(memberId);
  const waiting = q.inReview.length;
  const total = waiting + q.inRevisions.length + q.decided.length;

  return (
    <div>
      <PageHeader
        eyebrow="Your shoots"
        title="Review Room"
        subtitle={
          waiting
            ? `${waiting} cut${waiting === 1 ? "" : "s"} from your shoots are being reviewed — watch them and say what you'd change`
            : total
              ? "Nothing waiting on a verdict right now"
              : "No cuts from your shoots yet"
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        <Section icon={PlayCircle} title="Being reviewed now" count={q.inReview.length || null}>
          {q.inReview.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing in review. When an editor hands in a cut from one of your shoots it lands here — and you get a
              ping — so you can watch it and ask for anything that isn&rsquo;t right.
            </p>
          ) : (
            <ul className="space-y-2.5">{q.inReview.map((c) => <CutRow key={c.id} c={c} />)}</ul>
          )}
        </Section>

        {q.inRevisions.length > 0 && (
          <Section icon={Hourglass} title="Back with the editor" count={q.inRevisions.length}>
            <p className="mb-3 text-xs text-muted">
              Changes were asked for on these — the editor is cutting the next version. Your notes are still on them.
            </p>
            <ul className="space-y-2.5">{q.inRevisions.map((c) => <CutRow key={c.id} c={c} decided />)}</ul>
          </Section>
        )}

        {q.decided.length > 0 && (
          <Section icon={CheckCircle2} title="Approved — last 14 days" count={q.decided.length}>
            <ul className="space-y-2.5">{q.decided.map((c) => <CutRow key={c.id} c={c} decided />)}</ul>
          </Section>
        )}

        {total === 0 && (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
            Nothing here yet, {firstName}. Cuts show up once an editor hands one in on a job you shot.
          </p>
        )}
      </div>
    </div>
  );
}

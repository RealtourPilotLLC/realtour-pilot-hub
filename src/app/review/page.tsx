import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Camera, CheckCircle2, Clapperboard, ClipboardCheck, Hourglass, MessageSquare, Pencil, PlayCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getReviewQueue, type QueueSubmission } from "@/lib/reviewRoom";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The REVIEW ROOM — the owner's quality desk, its own page. Everything that
// needs (or is waiting on) a quality verdict, across every project:
//   · cuts editors submitted for review   → /review/<id> workspace
//   · changes-requested cuts (on the editor)
//   · photo sets sitting in QC (Kyle's media_qa cards)
//   · open feedback follow-through by lane (who owes a fix / a re-review)
// Owner/admin only — creatives get their feedback on their own surfaces
// (/shoot for photographers, /edit for editors).
// ---------------------------------------------------------------------------

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

function CutRow({ s, decided }: { s: QueueSubmission; decided?: boolean }) {
  return (
    <li>
      <Link
        href={`/review/${s.projectId}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
      >
        <PlayCircle className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{s.street}</span>
            {s.premium && (
              <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: "#a78bfa1a", color: "#a78bfa" }}>
                Premium
              </span>
            )}
            {s.round > 1 && (
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Round {s.round}</span>
            )}
            {!s.hasAsset && (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">No file found</span>
            )}
            {s.openEditorNotes > 0 && (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
                {s.openEditorNotes} open note{s.openEditorNotes === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted">
            {s.clientName}
            {s.submittedByName ? ` · from ${s.submittedByName}` : ""}
            {" · "}
            {decided && s.decidedAt ? `decided ${ago(s.decidedAt)}` : `submitted ${ago(s.createdAt)}`}
          </div>
          {s.note && <div className="mt-1 truncate text-xs italic text-muted-2">“{s.note}”</div>}
        </div>
      </Link>
    </li>
  );
}

export default async function ReviewRoomPage() {
  const me = await getCurrentUser().catch(() => null);
  const ownerDesk = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  if (!ownerDesk) redirect(homeFor(me?.role));

  const q = await getReviewQueue();
  const laneMeta = {
    EDIT: { label: "Kyle — delivery fixes", icon: Pencil },
    PHOTOGRAPHER: { label: "Photographer — capture", icon: Camera },
    EDITOR: { label: "Editor — cut", icon: Clapperboard },
  } as const;

  return (
    <div>
      <PageHeader
        eyebrow="Quality desk"
        title="Review Room"
        subtitle={
          q.pending.length
            ? `${q.pending.length} cut${q.pending.length === 1 ? "" : "s"} waiting on your verdict`
            : "Nothing waiting on you — all clear"
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        <Section icon={PlayCircle} title="Cuts to review" count={q.pending.length || null}>
          {q.pending.length === 0 ? (
            <p className="text-sm text-muted">
              No cuts waiting. When an editor hits “Done — send to review,” their cut lands here with a player and
              timestamped notes.
            </p>
          ) : (
            <ul className="space-y-2.5">{q.pending.map((s) => <CutRow key={s.id} s={s} />)}</ul>
          )}
        </Section>

        {q.waitingOnEditor.length > 0 && (
          <Section icon={Hourglass} title="Waiting on editor changes" count={q.waitingOnEditor.length}>
            <ul className="space-y-2.5">{q.waitingOnEditor.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          </Section>
        )}

        {q.photoQc.length > 0 && (
          <Section icon={ClipboardCheck} title="Photo sets in QC" count={q.photoQc.length}>
            <ul className="divide-y divide-border">
              {q.photoQc.map((t) => (
                <li key={t.taskId}>
                  <Link
                    href={t.projectId ? `/projects/${t.projectId}` : "/tasks"}
                    className="flex items-center justify-between gap-3 py-2.5 hover:text-brand"
                  >
                    <div className="min-w-0">
                      <span className="truncate text-sm font-medium">{t.street}</span>
                      {t.clientName && <span className="ml-2 text-xs text-muted">{t.clientName}</span>}
                    </div>
                    <span className="shrink-0 text-xs text-muted">
                      {t.assignedKey ? `${t.assignedKey} · ` : ""}
                      {t.dueAt ? `due ${ago(t.dueAt)}` : "no due date"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {q.followUps.length > 0 && (
          <Section icon={MessageSquare} title="Feedback follow-through" count={q.followUps.length}>
            <p className="mb-3 text-xs text-muted">
              Review notes still moving: <span className="font-medium text-foreground/80">open</span> = someone owes a
              fix · <span className="font-medium text-foreground/80">fixed</span> = they say it&rsquo;s done, you owe a
              re-look.
            </p>
            <ul className="divide-y divide-border">
              {q.followUps.map((f) => {
                const m = laneMeta[f.lane];
                return (
                  <li key={`${f.projectId}-${f.lane}`}>
                    <Link
                      href={`/projects/${f.projectId}`}
                      className="flex items-center justify-between gap-3 py-2.5 hover:text-brand"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <m.icon className="size-4 shrink-0 text-muted-2" />
                        <span className="truncate text-sm font-medium">{f.street}</span>
                        <span className="text-xs text-muted">{m.label}</span>
                      </div>
                      <span className="shrink-0 text-xs">
                        {f.open > 0 && <span className="font-medium text-brand">{f.open} open</span>}
                        {f.open > 0 && f.awaitingReReview > 0 && <span className="text-muted-2"> · </span>}
                        {f.awaitingReReview > 0 && <span className="font-medium text-success">{f.awaitingReReview} fixed</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {q.recentlyApproved.length > 0 && (
          <Section icon={CheckCircle2} title="Approved — last 14 days" count={q.recentlyApproved.length}>
            <ul className="space-y-2.5">{q.recentlyApproved.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          </Section>
        )}
      </div>
    </div>
  );
}

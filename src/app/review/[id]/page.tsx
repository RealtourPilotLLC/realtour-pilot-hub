import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Clapperboard, ExternalLink, Film, History, Images, Music, PenLine, ScrollText } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCutWorkspace } from "@/lib/reviewRoom";
import { editorMeta } from "@/lib/editors";
import { CutReviewPanel } from "@/components/review/CutReviewPanel";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// One project's cut-review workspace: the submitted video with timestamped
// notes + the Approve / Request-changes verdict (CutReviewPanel), alongside
// everything needed to JUDGE the cut — what was ordered, the editing notes the
// photographer left, and the reel recipe. Photo review stays in the project
// gallery; the header links straight to it.
// ---------------------------------------------------------------------------

export default async function CutReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getCurrentUser().catch(() => null);
  const ownerDesk = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  if (!ownerDesk) redirect(homeFor(me?.role));

  const w = await getCutWorkspace(id);
  if (!w) notFound();

  const active = w.active;
  const editorLabel =
    active?.submittedByName ??
    (active?.submittedByKey ? (editorMeta(active.submittedByKey)?.name ?? active.submittedByKey) : "the editor");

  return (
    <div>
      <PageHeader
        eyebrow="Review Room"
        title={w.street}
        subtitle={w.clientName}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${w.projectId}`}
              className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
            >
              <Images className="size-3.5" /> Photo review & project <ExternalLink className="size-3.5" />
            </Link>
            {w.frameioViewUrl && (
              <a
                href={w.frameioViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              >
                <Clapperboard className="size-3.5" /> Frame.io <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        }
      />

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the cut */}
        <div className="space-y-4 lg:col-span-2">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span className="font-medium text-foreground/85">Round {active.round}</span>
                <span className="text-muted-2">·</span>
                <span>from {editorLabel}</span>
                <span className="text-muted-2">·</span>
                <span>{formatDistanceToNow(new Date(active.createdAt), { addSuffix: true })}</span>
                {active.fileName && (
                  <>
                    <span className="text-muted-2">·</span>
                    <span className="truncate text-xs text-muted-2">{active.fileName}</span>
                  </>
                )}
              </div>
              {active.note && (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm italic text-foreground/80">“{active.note}”</p>
              )}
              <CutReviewPanel projectId={w.projectId} submission={active} notes={w.notes} editorLabel={editorLabel} />
            </>
          ) : (
            <Section icon={Film} title="No cut submitted yet">
              <p className="text-sm text-muted">
                When the editor hits “Done — send to review,” the cut shows up here with a player and timestamped
                notes. This job is currently <span className="font-medium text-foreground/80">{w.status.toLowerCase()}</span>.
              </p>
            </Section>
          )}

          {w.submissions.length > 1 && (
            <Section icon={History} title="Earlier rounds">
              <ul className="divide-y divide-border">
                {w.submissions.slice(1).map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-medium">Round {s.round}</span>
                    <span className="text-xs text-muted">
                      {s.status === "APPROVED" ? "approved" : s.status === "CHANGES_REQUESTED" ? "changes requested" : "superseded"}
                      {s.decidedAt ? ` ${formatDistanceToNow(new Date(s.decidedAt), { addSuffix: true })}` : ""}
                    </span>
                    {s.assetUrl && (
                      <a href={s.assetUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                        Watch
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {/* RIGHT — what to judge it against */}
        <div className="space-y-4">
          <Section icon={Film} title="What was ordered">
            {w.deliverables.length ? (
              <div className="flex flex-wrap gap-1.5">
                {w.deliverables.map((d) => (
                  <span key={d} className="rounded-lg bg-surface-2 px-2 py-1 text-xs font-medium text-foreground/85">
                    {d}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No video deliverables listed.</p>
            )}
            {w.premium && (
              <p className="mt-2 text-xs font-medium" style={{ color: "#a78bfa" }}>
                Premium tier — hold it to the influencer standard.
              </p>
            )}
          </Section>

          {(w.reelHook || w.reelScript || w.reelSong) && (
            <Section icon={ScrollText} title="The plan (reel recipe)">
              <div className="space-y-2 text-sm">
                {w.reelHook && (
                  <p>
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-2">Hook</span>
                    <br />
                    {w.reelHook}
                  </p>
                )}
                {w.reelSong && (
                  <p className="flex items-center gap-1.5 text-foreground/85">
                    <Music className="size-3.5 text-muted-2" /> {w.reelSong}
                  </p>
                )}
                {w.reelScript && (
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-brand">Full script</summary>
                    <p className="mt-1 whitespace-pre-wrap text-foreground/85">{w.reelScript}</p>
                  </details>
                )}
              </div>
            </Section>
          )}

          {w.editorBrief && (
            <Section icon={PenLine} title="Photographer's editing notes">
              <p className="whitespace-pre-wrap text-sm text-foreground/85">{w.editorBrief}</p>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

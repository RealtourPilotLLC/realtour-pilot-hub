import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Film, History, Images, MessageSquareQuote, Music, PenLine, ScrollText } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
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

export default async function CutReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string }>;
}) {
  const { id } = await params;
  const { cut } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  const ownerDesk = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  if (!ownerDesk) redirect(homeFor(me?.role));

  const w = await getCutWorkspace(id, cut ?? null);
  // Portal notes across this job's cuts, newest last.
  // Newest 30, shown oldest-first (desc+take keeps the LATEST notes when a
  // chatty client passes thirty — asc+take silently dropped the new ones).
  const clientNotes = (await prisma.portalComment.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, timeSec: true, body: true, status: true },
  }).catch(() => [])).reverse();
  if (!w) notFound();

  const active = w.active;
  // The job's CURRENT cuts — latest round per video file. One video job = one
  // chip (hidden); a monthly package = a switcher so each video is reviewed
  // individually (Jordan: "review each one individually in a timely manner").
  // A cut = (deliverable × slot) for uploaded rows, the file for legacy
  // folder rows; the newest round of each is the current cut.
  const cutKeyOf = (s: (typeof w.submissions)[number]) => (s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id));
  const latestPerCut = new Map<string, (typeof w.submissions)[number]>();
  for (const s of [...w.submissions].sort((a, b) => a.round - b.round)) latestPerCut.set(cutKeyOf(s), s);
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(w.projectId).catch(() => []);
  const slotLabel = (s: (typeof w.submissions)[number]) =>
    slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot)?.label ?? null;
  const earlierRounds = w.submissions.filter((s) => s.id !== active?.id && (!active || cutKeyOf(s) === cutKeyOf(active)));
  const currentCuts = [...latestPerCut.values()].sort((a, b) => {
    const ia = slots.findIndex((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(a));
    const ib = slots.findIndex((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(b));
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.round - b.round;
  });
  const editorLabel =
    active?.submittedByName ??
    (active?.submittedByKey ? (editorMeta(active.submittedByKey)?.name ?? active.submittedByKey) : "the editor");

  return (
    <div>
      <PageHeader
        eyebrow="Review Room"
        title={w.street}
        // The agent's Aryeo headshot beside their name (Jordan, Sep 2). An
        // empty name stays hidden, exactly as the bare string used to.
        subtitle={
          w.clientName ? (
            <span className="inline-flex items-center gap-2">
              <Avatar name={w.clientName} src={w.clientAvatarUrl} size={20} /> {w.clientName}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${w.projectId}`}
              className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
            >
              <Images className="size-3.5" /> Photo review & project <ExternalLink className="size-3.5" />
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the cut */}
        <div className="space-y-4 lg:col-span-2">
          {currentCuts.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {currentCuts.map((c, i) => (
                <Link
                  key={c.id}
                  href={`/review/${w.projectId}?cut=${c.id}`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    active?.id === c.id ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: c.status === "APPROVED" ? "#34d399" : c.status === "CHANGES_REQUESTED" ? "#f87171" : "#f59e0b" }}
                  />
                  <span className="max-w-48 truncate">{slotLabel(c) ?? c.fileName ?? `Video ${i + 1}`}</span>
                  {c.round > 1 && <span className="text-[10px] text-muted-2">v{c.round}</span>}
                </Link>
              ))}
            </div>
          )}
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                {slotLabel(active) && <span className="font-semibold text-foreground">{slotLabel(active)}</span>}
                {slotLabel(active) && <span className="text-muted-2">·</span>}
                <span className="font-medium text-foreground/85">Version {active.round}</span>
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
            <Section icon={Film} title="No cut uploaded yet">
              <p className="text-sm text-muted">
                When the editor uploads a version from the editor portal, it shows up here with a player and
                timestamped notes. This job is currently <span className="font-medium text-foreground/80">{w.status.toLowerCase()}</span>.
              </p>
            </Section>
          )}

          {earlierRounds.length > 0 && (
            <Section icon={History} title="Earlier rounds">
              <ul className="divide-y divide-border">
                {earlierRounds.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-medium">Version {s.round}</span>
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

          {/* The client's own portal notes on this job's cuts (interactive
              layer, Aug 28) — read-only context while judging the next round;
              SENT ones already became the revision work order. */}
          {clientNotes.length > 0 && (
            <Section icon={MessageSquareQuote} title="Client's notes" count={clientNotes.length}>
              <ul className="space-y-1.5">
                {clientNotes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 text-sm">
                    {n.timeSec != null && (
                      <span className="mt-0.5 shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                        {Math.floor(n.timeSec / 60)}:{String(Math.floor(n.timeSec % 60)).padStart(2, "0")}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-foreground/85">{n.body}</span>
                    <span className="shrink-0 text-[10px] text-muted-2">{n.status === "SENT" ? "sent to editor" : "new"}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

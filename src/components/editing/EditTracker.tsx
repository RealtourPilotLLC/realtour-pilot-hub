import { CheckCircle2, ChevronDown, Clapperboard, History, RefreshCw } from "lucide-react";
import { SlaCountdown } from "@/components/editing/SlaCountdown";
import { etDate, etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// The per-edit TRACKER — the stage timeline + order facts + round history that
// tops the editor brief (/edit/<id>), modeled on the Luma Visuals portal Jordan
// wants to outdo. Everything here derives from REAL state (project status,
// ReviewSubmission rounds, the open revision task) — no hand-set stages.
// Server-rendered and creative-safe: no pricing, no client contact info.
// ---------------------------------------------------------------------------

export type EditStage = "booked" | "editing" | "revision" | "review" | "done";

export type RoundRow = {
  /** The submission's own id — a multi-video job sends FOUR "Round 1" cuts, so
      the round number is not unique and cannot key the list (React was dropping
      rows on the 4-video Accelerator jobs). */
  id: string;
  round: number;
  status: string; // PENDING | CHANGES_REQUESTED | APPROVED
  submittedByName: string | null;
  note: string | null;
  createdAtISO: string;
  decidedAtISO: string | null;
  /** Which cut this round belongs to — the cutSlots() label ("Personal
      Branding Reel — Video 2 of 4"). Four "Round 1" lines on an Accelerator
      job are unreadable without it; optional so a legacy folder row (no
      deliverable/slot) still lists. */
  cutLabel?: string | null;
};

// Where this VIDEO edit stands, from hard evidence. Priority order matters:
// an APPROVED latest round is done unless a NEW revision was raised after the
// approval (revisionAfterApproval — a stale project-level revision flag that
// submitCutForReview never clears must not resurrect "changes requested" on
// an approved cut); a PENDING round is with the reviewer even if the job row
// still says REVISION (the redo was just submitted); an open VIDEO-lane
// revision beats "editing". Callers must pass only video-lane revision state —
// a photo retouch flipping this tracker was a confirmed review bug.
export function deriveEditStage(input: {
  projectStatus: string;
  revisionOpen: boolean;
  revisionAfterApproval: boolean;
  latestRoundStatus: string | null;
  rawsLanded: boolean;
}): { stage: EditStage; label: string } {
  const { projectStatus, revisionOpen, revisionAfterApproval, latestRoundStatus, rawsLanded } = input;
  if (latestRoundStatus === "APPROVED" && !revisionAfterApproval)
    return { stage: "done", label: projectStatus === "DELIVERED" ? "Approved & delivered" : "Cut approved" };
  if (projectStatus === "DELIVERED" && !revisionOpen) return { stage: "done", label: "Approved & delivered" };
  if (latestRoundStatus === "PENDING") return { stage: "review", label: "Ready for review — with Jordan" };
  if (revisionOpen || latestRoundStatus === "CHANGES_REQUESTED")
    return { stage: "revision", label: "Changes requested — back with the editor" };
  if (rawsLanded) return { stage: "editing", label: "In the edit — footage is in" };
  if (["SHOT", "EDITING", "REVIEW"].includes(projectStatus))
    return { stage: "editing", label: "In the edit — footage on the way" };
  return { stage: "booked", label: "Edit booked — waiting on footage" };
}

const STAGE_LABELS: Record<EditStage, string> = {
  booked: "Edit booked",
  editing: "Editing",
  revision: "Revision",
  review: "Review",
  done: "Done",
};

function StageDots({ stage, hadRevision }: { stage: EditStage; hadRevision: boolean }) {
  // Revision only appears once a revision has actually happened — a clean
  // first-pass job shouldn't advertise a stage it never entered.
  const stages: EditStage[] = hadRevision
    ? ["booked", "editing", "revision", "review", "done"]
    : ["booked", "editing", "review", "done"];
  const idx = stages.indexOf(stage);
  return (
    <div className="flex items-start">
      {stages.map((s, i) => {
        const reached = i <= idx;
        const current = i === idx;
        return (
          <div key={s} className={`flex ${i < stages.length - 1 ? "flex-1" : ""} flex-col`}>
            <div className="flex items-center">
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  reached ? "border-success bg-success" : "border-border bg-surface"
                } ${current ? "ring-4 ring-success/20" : ""}`}
              >
                {reached && !current && <CheckCircle2 className="size-3 text-white" />}
              </span>
              {i < stages.length - 1 && (
                <span className={`h-0.5 flex-1 ${i < idx ? "bg-success" : "bg-border"}`} />
              )}
            </div>
            <span
              className={`mt-1.5 pr-2 text-[11px] font-medium leading-tight ${
                current ? "text-foreground" : reached ? "text-muted" : "text-muted-2"
              }`}
            >
              {STAGE_LABELS[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{children}</div>
    </div>
  );
}

const ROUND_CHIP: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "With Jordan", cls: "bg-warning/10 text-warning" },
  CHANGES_REQUESTED: { text: "Changes requested", cls: "bg-danger/10 text-danger" },
  APPROVED: { text: "Approved", cls: "bg-success/10 text-success" },
};

export function EditTracker({
  stage,
  statusLine,
  hadRevision,
  editType,
  dueISO,
  shootDateISO,
  photographerName,
  song,
  rounds,
  editProduct,
  revisionAsks,
  revisionAtISO,
  showSubmitAnchor,
}: {
  stage: EditStage;
  statusLine: string;
  hadRevision: boolean;
  /** The ACTUAL video type — videoTypeLabel() in lib/pipeline, which is the
      Style Guide name resolved by videoStyleFor() ("Standard Reel with Agent
      Intro", "Premium Cinematic Video", "Personal Branding Reel"; multi-type
      jobs joined with " · "). Never the bare word "Video" (Jordan, Sep 2, on
      208 N Adams St) and never the sync's category label ("Social Reel" —
      626 Greycliffe: "That should be shown as video type"). */
  editType: string;
  /** The ordered product's own name (Deliverable.productTitle — "Photography
      and Standard Reel w/ Agent intro", "Video Accelerator - 4HR Session"),
      shown small under the type when it says more than the type does. The
      session length / plan name is real information for the editor; it just
      isn't the TYPE. Omit or pass the type itself to hide it. */
  editProduct?: string | null;
  dueISO: string | null;
  shootDateISO: string | null;
  photographerName: string | null;
  song: string | null;
  rounds: RoundRow[];
  /** The client's revision asks, newest LAST (already money-scrubbed for creative viewers). */
  revisionAsks: string[];
  revisionAtISO: string | null;
  /** Editors get a jump link to the "Done — send to review" card further down. */
  showSubmitAnchor: boolean;
}) {
  const dotColor =
    stage === "done" ? "text-success" : stage === "revision" ? "text-danger" : stage === "review" ? "text-warning" : "text-brand";
  const songIsUrl = !!song && /^https?:\/\//i.test(song.trim());

  return (
    <div className="rounded-2xl border bg-surface p-4 sm:p-5">
      {/* Status line — the one-glance answer to "where is this edit?" */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className={`text-lg leading-none ${dotColor}`}>●</span> {statusLine}
        </div>
        {showSubmitAnchor && (stage === "editing" || stage === "revision") && (
          <a
            href="#submit-cut"
            className="inline-flex items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1.5 text-xs font-semibold text-success hover:bg-success/20"
          >
            <Clapperboard className="size-3.5" /> Done? Send to Review <ChevronDown className="size-3" />
          </a>
        )}
      </div>

      <StageDots stage={stage} hadRevision={hadRevision} />

      {/* Order facts — the Luma card, minus anything money-shaped. */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Edit type">
          {editType}
          {editProduct && editProduct.trim() && editProduct.trim() !== editType && (
            <span className="block truncate text-xs font-normal text-muted" title={editProduct}>
              {editProduct}
            </span>
          )}
        </Fact>
        <Fact label="Deadline">
          {dueISO ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {etDate(dueISO)}
              {/* The clock stops once the cut is approved — a delivered job
                  reading "OVERDUE" forever is noise, not urgency. */}
              {stage !== "done" && <SlaCountdown dueISO={dueISO} />}
            </span>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Shoot date">{shootDateISO ? etDate(shootDateISO) : "—"}</Fact>
        <Fact label="Shot by">{photographerName ?? "—"}</Fact>
        <Fact label="Music">
          {song ? (
            songIsUrl ? (
              <a href={song} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                Song link ↗
              </a>
            ) : (
              song
            )
          ) : (
            "—"
          )}
        </Fact>
      </div>

      {/* The client's revision asks — the amber card Luma renders in chat,
          here where the editor actually works. Newest ask last, all rounds
          kept (a second ask APPENDS — audit rule). */}
      {revisionAsks.length > 0 && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/5 p-3.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warning">
            <RefreshCw className="size-3.5" /> Revision request{revisionAsks.length > 1 ? "s" : ""}
            {revisionAtISO && <span className="font-normal normal-case text-muted-2">· {etDateTime(revisionAtISO)}</span>}
          </div>
          {/* Callers keep list positions stable when scrubbing (an emptied ask
              becomes a placeholder, never dropped) so these round labels can't
              drift onto the wrong ask. */}
          <div className="mt-1.5 space-y-2">
            {revisionAsks.map((ask, i) => (
              <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {revisionAsks.length > 1 && (
                  <span className="mr-1.5 rounded bg-warning/15 px-1 py-0.5 text-[10px] font-semibold text-warning">
                    {i === 0 ? "Round 1" : `New request ${i}`}
                  </span>
                )}
                {ask}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Round history — every cut sent through the Review Room. */}
      {rounds.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
            <History className="size-3.5" /> Cuts sent to review
          </div>
          <ul className="mt-1.5 space-y-1">
            {rounds.map((r) => {
              const chip = ROUND_CHIP[r.status] ?? { text: r.status, cls: "bg-surface-2 text-muted" };
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  {/* Multi-cut jobs: name the cut first, so four "Round 1"s read
                      as four different videos rather than a repeated line. */}
                  {r.cutLabel && <span className="max-w-64 truncate text-muted">{r.cutLabel} ·</span>}
                  <span className="font-medium">Round {r.round}</span>
                  <span className="text-xs text-muted-2">
                    {r.submittedByName ? `${r.submittedByName} · ` : ""}
                    {etDateTime(r.createdAtISO)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.cls}`}>{chip.text}</span>
                  {r.note && <span className="w-full pl-0.5 text-xs italic text-muted">“{r.note}”</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}


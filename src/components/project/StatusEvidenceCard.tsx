import { ShieldCheck, CircleAlert, CheckCircle2, Camera, Video, Ruler, Box, RefreshCcw, FolderOpen, ExternalLink, Clock, HelpCircle } from "lucide-react";
import { parseEvidence, evidenceTone, etStamp, type EvidenceToneKind } from "@/lib/statusEvidence";
import type { BoardPromise } from "@/lib/deliveryBoard";
import { stageMeta } from "@/lib/pipeline";
import { RevisionResolveButton } from "@/components/project/RevisionResolveButton";
import { RecheckStatusButton } from "@/components/project/RecheckStatusButton";
import { ink } from "@/components/ui/Badge";
import { formatDistanceToNow } from "date-fns";
import type { ProjectStatus } from "@prisma/client";

export type DropboxLink = { label: string; url: string };

// ---------------------------------------------------------------------------
// TONE, NOT ALARM (RTP-16, Sep 16 audit).
//
// This card used to paint ANY missing output red and tell the reader to upload
// the rest. 35 jobs rendered that alarm and 27 of them had not been shot yet:
// 2549 Crestline Dr [SCHEDULED] showed a red-bordered card whose red sentence
// was "No shoot scheduled yet." Nothing was wrong; nothing was late.
//
// The colour now follows the PROMISE, and the rule lives in ONE place
// (statusEvidence.evidenceTone) so this card, the chips and the queue can
// never disagree about what is late:
//   neutral  awaiting production — owed, not yet due
//   amber    at risk             — due inside a day, or fulfilled-but-unseen
//   red      overdue             — past the promise
//   grey     unknown             — the read failed or is stale; a stale zero
//                                  is never "nothing delivered", and a stale
//                                  count is never a new delivery
// ---------------------------------------------------------------------------
const TONE: Record<EvidenceToneKind, { border: string; icon: typeof ShieldCheck; iconCls: string; text: string; chip: string }> = {
  clear:       { border: "border-border",        icon: ShieldCheck, iconCls: "text-success",  text: "text-foreground/85",           chip: "bg-surface-2 text-muted" },
  awaiting:    { border: "border-border",        icon: Clock,       iconCls: "text-muted-2",  text: "text-foreground/85",           chip: "bg-surface-2 text-muted" },
  at_risk:     { border: "border-warning/40",    icon: CircleAlert, iconCls: "text-warning",  text: "font-medium text-warning",     chip: "bg-warning/10 text-warning" },
  overdue:     { border: "border-danger/40",     icon: CircleAlert, iconCls: "text-danger",   text: "font-medium text-danger",      chip: "bg-danger/10 text-danger" },
  unknown:     { border: "border-border",        icon: HelpCircle,  iconCls: "text-muted-2",  text: "text-muted",                   chip: "bg-surface-2 text-muted-2" },
  unconfirmed: { border: "border-border",        icon: ShieldCheck, iconCls: "text-muted-2",  text: "text-foreground/85",           chip: "bg-surface-2 text-muted" },
};

const CHIP_SUFFIX: Record<EvidenceToneKind, string> = {
  clear: "",
  awaiting: " — still to come",
  at_risk: " — still to come",
  overdue: " — overdue",
  unknown: " — not checked",
  unconfirmed: " — not confirmed by the hub",
};

// The engine's own sentence still carries an instruction this card must not
// give on a job nobody has proved is late ("Video overdue — was due Sep 14.
// Confirm it was delivered to the client, or upload it."). The two strings are
// fixed and live in projectStatus.ts; drop the imperative and keep the facts.
// HANDOVER (audit): the source strings should lose it too.
const IMPERATIVES = [
  " Confirm it was delivered to the client, or upload it.",
  "Confirm it was delivered to the client, or upload it.",
];
const justTheFacts = (reason: string) =>
  IMPERATIVES.reduce((acc, s) => acc.split(s).join("").trim(), reason).replace(/\s{2,}/g, " ");

// Older stored sentences open by naming the client ("Client requested changes
// after delivery: …" — 56 Hillview's blob still does). On a job where the hub
// does NOT know who raised the ask, that prefix flatly contradicts the line
// three rows above it, which says we have no record (review, Sep 16). Keep the
// words that were said; drop the claim about whose they were.
const ATTRIBUTED = /^\s*(?:the\s+)?client requested changes(?:\s+after delivery)?(?:\s+via\s+[^:]*?)?\s*(?::\s*)?/i;
const unattributed = (reason: string) => {
  const m = reason.match(ATTRIBUTED);
  if (!m || !m[0].trim()) return reason;
  const rest = reason.slice(m[0].length).trim();
  return rest ? `Changes requested: ${rest}` : "Changes requested.";
};

// WHO ASKED (RTP-16). The card called every revision "Client requested changes
// after delivery" — on 893 S Matlack, a job that was never delivered and whose
// revision came from the owner's own Review Room bounce. The requester is on
// the record in two places (ReviewSubmission.decidedBy for a bounce,
// RevisionBrief.source for a comms ask); this reads both and says "unknown"
// when neither matches, rather than blaming the client by default.
type RevisionWho = {
  label: string;
  /** false when the hub genuinely has no record of who raised it */
  known: boolean;
  /** …and false again when the lookup itself failed, which is a different
   *  thing to say (review, Sep 16): "we have no record" vs "we couldn't look". */
  lookupFailed: boolean;
  afterDelivery: boolean;
};

type StatusContext = {
  shootDate: Date | null;
  /** RTP-06's freshness split, read straight off the project. Null on every
   *  row until the status engine writes it — that means "no failure
   *  recorded", never "the read failed". */
  attemptedAt: Date | null;
  succeededAt: Date | null;
  error: string | null;
  /** The promise, from deliveryBoard's engine — the SAME function Kyle's board
   *  reads, so the two screens turn red on the same minute (review, Sep 16). */
  promise: BoardPromise | null;
  who: RevisionWho | null;
};

/** One lookup for the three things this card cannot get from its props: how
 *  fresh the evidence read is, when the job is actually promised, and who
 *  raised the outstanding revision. Everything here is optional — a failure
 *  leaves the card rendering as it would have without it, and SAYS so rather
 *  than quietly reverting to the anonymous "Changes requested".
 *
 *  HANDOVER (review, Sep 16): src/app/projects/[id]/page.tsx already loads the
 *  project; passing shootDate / evidenceAttemptedAt / evidenceSucceededAt /
 *  evidenceError (and, once it loads them, deliverables + orderItems +
 *  appointments) as props would let this whole query go. The props exist. */
async function statusContext(
  projectId: string,
  isRevision: boolean,
  askedAt: Date | null,
): Promise<StatusContext | null> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const { outstandingPromise } = await import("@/lib/deliveryBoard");
    const { turnaroundRules } = await import("@/lib/settings");
    const { OWED_DELIVERABLE_WHERE } = await import("@/lib/tasks");
    const [project, bounce, brief, turnarounds] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          status: true,
          deliveredAt: true,
          shootDate: true,
          revisionRequestedAt: true,
          dueOverrideAt: true,
          tierOverride: true,
          packageName: true,
          statusEvidence: true,
          evidenceAttemptedAt: true,
          evidenceSucceededAt: true,
          evidenceError: true,
          client: { select: { name: true } },
          orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
          deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, status: true, uploadedAt: true, label: true } },
          appointments: { select: { startAt: true, status: true }, orderBy: { startAt: "asc" } },
        },
      }),
      isRevision
        ? prisma.reviewSubmission.findFirst({
            // A WITHDRAWN bounce is a round somebody took back — it must never
            // put a name on a live ask (review, Sep 16).
            where: { projectId, status: "CHANGES_REQUESTED", withdrawnAt: null },
            orderBy: { decidedAt: "desc" },
            select: { decidedAt: true, decidedBy: true },
          })
        : null,
      isRevision
        ? prisma.revisionBrief.findFirst({
            where: { projectId },
            orderBy: { createdAt: "desc" },
            select: { source: true, createdAt: true },
          })
        : null,
      turnaroundRules().catch(() => undefined),
    ]);
    const base = {
      shootDate: project?.shootDate ?? null,
      attemptedAt: project?.evidenceAttemptedAt ?? null,
      succeededAt: project?.evidenceSucceededAt ?? null,
      error: project?.evidenceError ?? null,
      promise: project ? outstandingPromise(project, { turnarounds }) : null,
    };
    if (!isRevision) return { ...base, who: null };

    const deliveredAt = project?.deliveredAt ?? null;
    const afterDelivery = !!deliveredAt && (!askedAt || askedAt > deliveredAt);
    // Match the witness to THIS ask: a two-hour window either side of the
    // stamp, newest first. An older bounce on a job whose current revision came
    // from the client must not put the reviewer's name on the client's words.
    // With NO stamp there is nothing to match against, so nothing matches — an
    // ancient Review Room bounce on a status-only REVISION used to be printed
    // as today's requester (review, Sep 16).
    const near = (at: Date | null | undefined) =>
      !!at && !!askedAt && Math.abs(at.getTime() - askedAt.getTime()) < 2 * 3_600_000;
    const hit = [
      bounce?.decidedAt && near(bounce.decidedAt)
        ? { at: bounce.decidedAt, source: "review_room", by: bounce.decidedBy }
        : null,
      brief?.createdAt && near(brief.createdAt)
        ? { at: brief.createdAt, source: brief.source, by: null as string | null }
        : null,
    ]
      .filter((c): c is { at: Date; source: string; by: string | null } => c !== null)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];

    const client = project?.client?.name?.trim() || null;
    if (!hit) return { ...base, who: { label: "Changes requested", known: false, lookupFailed: false, afterDelivery } };
    if (hit.source === "review_room") {
      return { ...base, who: { label: `${hit.by?.trim() || "The office"} asked for changes in the Review Room`, known: true, lookupFailed: false, afterDelivery } };
    }
    if (hit.source === "openphone" || hit.source === "gmail") {
      return { ...base, who: { label: `${client || "The client"} asked for changes`, known: true, lookupFailed: false, afterDelivery } };
    }
    return { ...base, who: { label: "Changes requested in the hub", known: true, lookupFailed: false, afterDelivery } };
  } catch {
    // The card still renders — but a lost name is said out loud rather than
    // silently becoming the anonymous "Changes requested" (review, Sep 16).
    return {
      shootDate: null, attemptedAt: null, succeededAt: null, error: null, promise: null,
      who: isRevision ? { label: "Changes requested", known: false, lookupFailed: true, afterDelivery: false } : null,
    };
  }
}

// Renders the smart-status engine's reasoning: what was ordered, what's
// confirmed live on Aryeo / sitting in Dropbox, and what's still missing.
export async function StatusEvidenceCard({
  status,
  evidence,
  checkedAt,
  projectId,
  revisionNote,
  revisionRequestedAt,
  shootDate,
  evidenceAttemptedAt,
  evidenceSucceededAt,
  evidenceError,
  dropboxLinks,
  dropboxRootUrl,
}: {
  status: ProjectStatus;
  evidence: string | null;
  checkedAt: Date | null;
  projectId: string;
  revisionNote?: string | null;
  revisionRequestedAt?: Date | null;
  shootDate?: Date | null;
  /** RTP-06's freshness split. Null on every row until the engine writes it —
   *  read as "no failure recorded", never as "the read failed". */
  evidenceAttemptedAt?: Date | null;
  evidenceSucceededAt?: Date | null;
  evidenceError?: string | null;
  dropboxLinks?: DropboxLink[];
  dropboxRootUrl?: string;
}) {
  // A cancelled job is not in revisions, whatever stamp it still carries
  // (265 Koser Rd rendered the revision banner twice — audit).
  const isRevision = status !== "CANCELLED" && (status === "REVISION" || !!revisionRequestedAt);
  const e = parseEvidence(evidence);
  if (!e && !isRevision) return null;

  const stage = stageMeta(status);
  const ctx = await statusContext(projectId, isRevision, revisionRequestedAt ?? null);
  const tone = evidenceTone({
    status,
    evidence: e,
    shootDate: shootDate ?? ctx?.shootDate ?? null,
    // ONE promise for the whole hub. Without it this card only ever knew the
    // VIDEO's date, so a late Photos job read "No promise has been set for it
    // yet" while Kyle's board had it due that afternoon — and where both did
    // have a date they disagreed by hours (review, Sep 16).
    dueAt: ctx?.promise?.at ?? null,
    dueFor: ctx?.promise?.label ?? null,
    promiseResolved: !!ctx && ctx.promise !== null,
    checkedAt,
    attemptedAt: evidenceAttemptedAt ?? ctx?.attemptedAt,
    succeededAt: evidenceSucceededAt ?? ctx?.succeededAt,
    error: evidenceError ?? ctx?.error,
  });
  const t = TONE[tone.kind];
  const ToneIcon = t.icon;
  const missingCount = e?.missing.length ?? 0;
  const who = ctx?.who ?? null;
  const anonymous = !!who && !who.known;
  // Strip the older "Client requested changes…" opening when we have just told
  // the reader we don't know who asked (review, Sep 16).
  const reason = e?.reason ? justTheFacts(anonymous ? unattributed(e.reason) : e.reason) : "";

  return (
    <section className={"rounded-2xl border bg-surface " + t.border}>
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {isRevision ? (
            <RefreshCcw className="size-4 text-[#ea580c] light:text-[#c2410c]" />
          ) : (
            <ToneIcon className={"size-4 " + t.iconCls} />
          )}
          Status check
        </h2>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ backgroundColor: stage.soft, color: ink(stage.color) }}
        >
          {stage.label}
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        {/* Revision banner — named, and only "after delivery" when it was. */}
        {isRevision && (
          <div className="rounded-lg border border-[#ea580c]/30 bg-[#ea580c]/10 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#ea580c] light:text-[#c2410c]">
              <RefreshCcw className="size-3.5" />
              {(who?.label ?? "Changes requested") + (who?.afterDelivery ? " after delivery" : "")}
              {revisionRequestedAt ? ` · ${etStamp(revisionRequestedAt)}` : ""}
            </div>
            {revisionNote && (
              <p className="mt-1 text-sm text-foreground/85">&ldquo;{revisionNote}&rdquo;</p>
            )}
            {anonymous && (
              <p className="mt-1 text-[11px] text-muted">
                {who!.lookupFailed
                  ? "The hub couldn't check who raised this one just now — reload, or look at the job's notes and the Review Room, before telling the client it was theirs."
                  : "The hub has no record of who raised this one — check the job's notes or the Review Room before telling the client it was theirs."}
              </p>
            )}
            <div className="mt-2">
              <RevisionResolveButton projectId={projectId} />
            </div>
          </div>
        )}

        {/* The verdict, in the tone the promise justifies. */}
        <div>
          <p className={"text-sm " + t.text}>{tone.headline}</p>
          {tone.detail && <p className="mt-0.5 text-[13px] text-muted">{tone.detail}</p>}
          {/* The engine's own sentence, kept as supporting detail — it carries
              facts the tone line doesn't (which tier, what else is missing). */}
          {reason && reason !== tone.headline && (
            <p className="mt-1 text-[11px] text-muted-2">Cross-check: {reason}</p>
          )}
        </div>

        {/* Finished, and still ours. This is the one row on the card with a
            named next action, so it sits above the discrepancy notes: the file
            exists, the client cannot open it, and somebody has to send it
            (audit WF-01, Sep 17). */}
        {e?.awaitingSend && e.awaitingSend.length > 0 && (
          <div className="rounded-lg bg-brand-soft/60 px-3 py-2 text-xs font-medium text-brand">
            {e.awaitingSend.join(" and ")} {e.awaitingSend.length === 1 ? "is" : "are"} finished and in Dropbox,
            but not on the client&apos;s Aryeo listing. Until {e.awaitingSend.length === 1 ? "it goes" : "they go"} up,
            the client cannot open {e.awaitingSend.length === 1 ? "it" : "them"}.
          </div>
        )}

        {/* Aryeo says fulfilled, the hub can't see it all. A discrepancy worth
            a look — not an instruction to go and upload something (Sep 16). */}
        {e?.partial && tone.kind !== "unconfirmed" && (
          <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
            Aryeo has this order marked fulfilled, but the cross-check can&apos;t see{" "}
            {e.missing.join(", ")}. Worth confirming where {missingCount === 1 ? "it" : "they"} went before the
            client asks.
          </div>
        )}
        {tone.kind === "unconfirmed" && (
          <div className="rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-muted">
            The office delivered this job. {missingCount === 1 ? "One item is" : `${missingCount} items are`}{" "}
            still unconfirmed by the cross-check — usually a listing the hub isn&apos;t linked to, or a vendor piece
            that never synced to Aryeo. Recheck below once it lands; nothing here changes the delivery.
          </div>
        )}

        {/* ONE MANAGEABLE PROJECT VIEW (audit WF-02, Sep 18 — Jordan: "Every
            owed video needs its own identity, current version, owner,
            deadline, review state, and delivery evidence. Preserve one
            manageable project view."). Not a new screen: one line per owed
            video, under the card that already answers "where is this job".
            Until now a sixteen-video package was a single chip reading
            "Video" — and it went green the moment ONE file existed. */}
        <OwedVideos projectId={projectId} />

        {/* Expected deliverables, colour-coded by present / missing / tone */}
        {e && e.expected.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
              Ordered deliverables
            </div>
            <div className="flex flex-wrap gap-1.5">
              {e.expected.map((cat) => {
                const present = e.present.includes(cat);
                return (
                  <span
                    key={cat}
                    className={
                      "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium " +
                      (present ? "bg-success/10 text-success" : t.chip)
                    }
                  >
                    {present ? <CheckCircle2 className="size-3" /> : <CircleAlert className="size-3" />}
                    {cat}
                    {!present && CHIP_SUFFIX[tone.kind]}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Evidence counts from each source */}
        {e && (
        <div className="grid gap-3 sm:grid-cols-2">
          {e.aryeo && (
            <div className={`rounded-lg border bg-surface-2/50 px-3 py-2 ${e.aryeo.stale ? "border-warning/40" : ""}`}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                Live on Aryeo {e.aryeo.delivery ? `· ${e.aryeo.delivery.toLowerCase()}` : ""}
                {e.aryeo.stale ? " · last known" : ""}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/80">
                <Count icon={Camera} n={e.aryeo.photos} label="photos" />
                <Count icon={Video} n={e.aryeo.videos} label="videos" />
                <Count icon={Ruler} n={e.aryeo.floorPlans} label="floor plans" />
                <Count icon={Box} n={e.aryeo.interactive} label="3D" />
              </div>
              {/* Same rule as Dropbox below: a count we couldn't refresh is a
                  memory, not a measurement. */}
              {e.aryeo.stale && (
                <p className="mt-1 text-[11px] text-warning">
                  Aryeo couldn&apos;t be read on the latest check
                  {e.aryeo.readError ? ` (${e.aryeo.readError})` : ""} — showing the last good read
                  {e.aryeo.at ? ` from ${etStamp(new Date(e.aryeo.at), true)}` : ""}.
                </p>
              )}
            </div>
          )}
          {e.dropbox && (
            <div className={`rounded-lg border bg-surface-2/50 px-3 py-2 ${e.dropbox.stale ? "border-warning/40" : ""}`}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                In Dropbox{e.dropbox.stale ? " · last known" : ""}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/80">
                <Count icon={Camera} n={e.dropbox.rawPhotos} label="raw photos" />
                <Count icon={Video} n={e.dropbox.rawVideo} label="raw video" />
                <Count icon={Camera} n={e.dropbox.finalPhotos} label="final photos" />
                <Count icon={Video} n={e.dropbox.finalVideo} label="final video" />
              </div>
              {/* "Couldn't look" is not "empty" — say which one this is. */}
              {e.dropbox.stale && (
                <p className="mt-1 text-[11px] text-warning">
                  Dropbox couldn&apos;t be read on the latest check
                  {e.dropbox.readError ? ` (${e.dropbox.readError})` : ""} — showing the last good read
                  {e.dropbox.at ? ` from ${etStamp(new Date(e.dropbox.at), true)}` : ""}.
                </p>
              )}
            </div>
          )}
        </div>
        )}

        {/* Dropbox folders — jump straight to the raw/final upload folders */}
        {dropboxLinks && dropboxLinks.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Dropbox folders</span>
              {dropboxRootUrl && (
                <a
                  href={dropboxRootUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
                >
                  Open listing folder <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dropboxLinks.map((f) => (
                <a
                  key={f.label}
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border bg-surface-2/50 px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  <FolderOpen className="size-3" /> {f.label}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Last check + on-demand re-check, so a just-fixed flag clears now
            instead of on the next hourly cron (audit crack #41). A check that
            was ATTEMPTED and didn't finish is not freshness (RTP-06) — say
            when the last one that worked was. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {tone.freshness.at || checkedAt ? (
            <div className="text-[11px] text-muted-2">
              {tone.freshness.known ? "Cross-checked" : "Last complete cross-check"}{" "}
              {formatDistanceToNow(tone.freshness.at ?? checkedAt!, { addSuffix: true })} · Aryeo media + Dropbox folders
            </div>
          ) : (
            <span />
          )}
          <RecheckStatusButton projectId={projectId} />
        </div>
      </div>
    </section>
  );
}

/**
 * Every owed video on this job, one line each — the per-video rows WF-02
 * materialised (lib/deliverableOutputs), read-only.
 *
 * The state words are that module's, so this card, the Editing Room and the
 * Ready-to-send board cannot drift about the same video. The one it exists to
 * print is **Approved — not sent**: a cut the office has accepted and nobody
 * has handed to the client is still owed work, and until now the only surface
 * that said so was a card on Kyle's home screen (322 N 62nd St, Sep 17: the
 * corrected file sat finished while every screen read DELIVERED).
 *
 * Renders NOTHING when the job owes no video, or before the rows exist — a job
 * that has never been through the materialisation shows exactly what it showed
 * yesterday rather than an empty promise of a table.
 */
async function OwedVideos({ projectId }: { projectId: string }) {
  let rows: Awaited<ReturnType<typeof import("@/lib/deliverableOutputs").outputsForProject>> = [];
  try {
    const { outputsForProject } = await import("@/lib/deliverableOutputs");
    rows = await outputsForProject(projectId);
  } catch {
    return null; // the rest of the card is worth more than this strip
  }
  if (rows.length === 0) return null;
  const owed = rows.filter((r) => r.state !== "waived" && r.state !== "removed");
  const unsent = owed.filter((r) => r.awaitingSend);
  // A REPLACEMENT THE CLIENT HAS NOT GOT YET (audit R03, Sep 18). The client
  // holds v1, the job is working on v2, and the row used to read "Sent to the
  // client" because ONE historical stamp outranked every later fact. These are
  // the videos where this screen and Kyle's Ready-to-send card used to
  // disagree about the same file.
  const replacing = owed.filter((r) => r.priorDelivery && !r.awaitingSend);
  const TONE_FOR: Record<string, string> = {
    sent: "bg-success/10 text-success",
    approved: "bg-brand-soft/70 text-brand",
    in_revisions: "bg-[#ea580c]/10 text-[#ea580c] light:text-[#c2410c]",
    in_review: "bg-warning/10 text-warning",
    not_started: "bg-surface-2 text-muted-2",
    waived: "bg-surface-2 text-muted-2",
    removed: "bg-surface-2 text-muted-2",
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
          Videos on this job ({owed.length})
        </span>
        {unsent.length > 0 ? (
          <span className="text-[11px] font-medium text-brand">
            {unsent.length === 1 ? "1 approved, not sent" : `${unsent.length} approved, not sent`}
          </span>
        ) : replacing.length > 0 ? (
          <span className="text-[11px] font-medium text-warning">
            {replacing.length === 1 ? "1 replacement in progress" : `${replacing.length} replacements in progress`}
          </span>
        ) : null}
      </div>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-foreground/85">
              {owed.length > 1 && r.state !== "waived" && r.state !== "removed" ? `${r.index}. ` : ""}
              {r.label}
            </span>
            {/* WHO AND WHEN, and what KIND of answer each is (R06). An owner
                nobody has picked yet is where today's rules WOULD send it —
                printed as a destination, never as somebody's assignment. */}
            {r.ownerName && (
              <span className="text-[11px] text-muted-2" title={r.ownerFrom === "row" ? "Set on this video" : r.ownerFrom === "job" ? "The job's editor" : "Where the routing rules send this"}>
                {r.ownerFrom === "routing" ? `routes to ${r.ownerName}` : r.ownerName}
              </span>
            )}
            {r.promisedAt && (
              <span className="text-[11px] text-muted-2" title={r.promiseFromJob ? "The job's delivery promise" : "Set on this video"}>
                due {etStamp(r.promisedAt)}
              </span>
            )}
            <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium " + (TONE_FOR[r.state] ?? "bg-surface-2 text-muted-2")}>
              {r.detail}
            </span>
          </li>
        ))}
      </ul>
      {unsent.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">
          Approved is not delivered: {unsent.length === 1 ? "that video is" : "those videos are"} finished and waiting on
          somebody to send {unsent.length === 1 ? "it" : "them"} — the Ready to send card has the file.
        </p>
      )}
      {replacing.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">
          A replacement is in hand for {replacing.length === 1 ? "one video" : `${replacing.length} videos`} — the client
          still has the earlier version until the new one is sent.
        </p>
      )}
    </div>
  );
}

function Count({ icon: Icon, n, label }: { icon: typeof Camera; n: number; label: string }) {
  return (
    <span className={"inline-flex items-center gap-1 " + (n > 0 ? "" : "text-muted-2")}>
      <Icon className="size-3" />
      <span className="font-medium">{n}</span> {label}
    </span>
  );
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { TEAM_MEMBER_EDITOR_KEYS, editorMeta, DEFAULT_EDITOR_TZ } from "@/lib/editors";

// ---------------------------------------------------------------------------
// THE BRIEF OPENS ON START, FOR THE EDITORS (Jordan, Oct 29 2026: "maybe he
// can't see the project details until he presses start? I want everyone else
// to be able to see the details. Maybe for both Kim and John: they see a
// brief project summary, and to see all details and instructions, they press
// start").
//
// WHO: an editor login with a desk (Kim, John Mark). "View as" one of them
// shows the same summary, so the office can see what the editor sees. The
// owner, the office, the creative manager and everybody else see the whole
// brief exactly as before.
//
// WHEN IT IS OPEN: while that editor's work on the job is ACTIVE or PAUSED
// (lib/editorWork, the §7.1 layer). Start opens it; Pause keeps it open (the
// job is still theirs mid-break); sending a video for review ends that
// stretch, so the summary shows again until they press Start for the next
// video or the revision. Nothing here writes: opening the page never starts
// anything.
//
// ENFORCED ON THE SERVER: /edit/<id> returns the summary page before any
// detail is read (the brief, script, notes, links, files, messages and
// feedback are never loaded, so never sent), the brief PDF refuses
// (api/projects/<id>/editor-brief), the Editing Room drops the Raw/Final
// folder links from an editor's rows until Start, and the assistant's job
// details tool answers an editor with the summary only (hubTools).
// ---------------------------------------------------------------------------

type GateViewer = { role?: string | null; editorKey?: string | null } | null | undefined;

/** Whose brief waits behind Start: an editor login with a desk. Pure. */
export function briefGated(viewer: GateViewer): boolean {
  return viewer?.role === "EDITOR" && !!viewer.editorKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(viewer.editorKey);
}

/** Open from Start until the stretch ends at a hand-in (or the job leaves them). Pure. */
export function briefOpenForState(state: string | null | undefined): boolean {
  return state === "ACTIVE" || state === "PAUSED";
}

/** True when this viewer sees the whole brief on this job. */
export async function briefOpenFor(projectId: string, viewer: GateViewer): Promise<boolean> {
  if (!briefGated(viewer)) return true;
  const item = await prisma.editorWorkItem.findUnique({
    where: { editorKey_projectId: { editorKey: viewer!.editorKey!, projectId } },
    select: { state: true },
  });
  return briefOpenForState(item?.state);
}

/** The jobs (of those given) whose brief is open to this viewer. Everything for a viewer who is not gated. */
export async function briefOpenJobs(projectIds: string[], viewer: GateViewer): Promise<Set<string>> {
  if (!briefGated(viewer)) return new Set(projectIds);
  if (!projectIds.length) return new Set();
  const items = await prisma.editorWorkItem.findMany({
    where: { editorKey: viewer!.editorKey!, projectId: { in: projectIds }, state: { in: ["ACTIVE", "PAUSED"] } },
    select: { projectId: true },
  });
  return new Set(items.map((i) => i.projectId));
}

export type BriefSummaryVideo = {
  id: string;
  number: number;
  title: string;
  kind: string;
  dueWords: string | null;
  state: string;
};

export type BriefSummary = {
  projectId: string;
  client: string;
  street: string;
  address: string;
  tz: string;
  /** the job's video due, in the editor's words ("due Thu, Oct 30, 5 PM ET (Fri, Oct 31, 5 AM Manila)") */
  dueWords: string | null;
  videos: BriefSummaryVideo[];
  /** the kinds of video when the job has no per-video rows */
  kinds: string[];
};

/** What a video's newest version says, in the words the brief's own tiles use. Pure. */
export function videoStateWords(latest: { status: string; round: number } | null | undefined): string {
  if (!latest) return "Not started";
  if (latest.status === "APPROVED") return "Approved";
  if (latest.status === "CHANGES_REQUESTED") return `Changes requested on version ${latest.round}`;
  return `Version ${latest.round} in review`;
}

/**
 * The short summary an editor sees before Start: the client, the property,
 * each video (its number, topic, kind, due date and state) and the job's due
 * date. No instructions, script, notes, links, files or messages.
 */
export async function briefSummaryFor(projectId: string, editorKey: string | null): Promise<BriefSummary | null> {
  const { videoStyleFor } = await import("@/lib/videoStyles");
  const { videoDueFor, dueWordsFor } = await import("@/lib/editorDue");
  const { videoNavigationFor } = await import("@/lib/videoNavigation");
  const { NOT_A_CUT } = await import("@/lib/reviewCuts");
  const { outputsForProject } = await import("@/lib/deliverableOutputs");
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, contentMonthId: true,
      client: { select: { name: true } },
      deliverables: {
        where: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null },
        select: { id: true, type: true, label: true, videoStyle: true, productTitle: true },
      },
    },
  });
  if (!project) return null;
  const tz = (editorKey ? editorMeta(editorKey)?.tz : null) ?? DEFAULT_EDITOR_TZ;
  const [due, nav, outputs, subs, named] = await Promise.all([
    videoDueFor(projectId).catch(() => null),
    videoNavigationFor(projectId).catch(() => new Map<string, { number: number; total: number }>()),
    prisma.deliverableOutput.findMany({
      where: { projectId, category: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null },
      orderBy: [{ deliverableId: "asc" }, { slot: "asc" }],
      select: { id: true, deliverableId: true, slot: true, title: true, promisedAt: true },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId, status: { notIn: [...NOT_A_CUT] } },
      orderBy: { round: "asc" },
      select: { outputId: true, deliverableId: true, slot: true, round: true, status: true },
    }),
    // The video's name as the brief's own tiles read it (its topic for a
    // monthly video), without reading its brief.
    outputsForProject(projectId).then((rows) => new Map(rows.map((r) => [r.id, r.label]))).catch(() => new Map<string, string>()),
  ]);
  const monthly = !!project.contentMonthId;
  const deliverableOf = new Map(project.deliverables.map((d) => [d.id, d]));
  const latestOf = new Map<string, { status: string; round: number }>();
  for (const s of subs) {
    const out = s.outputId ? outputs.find((o) => o.id === s.outputId) : outputs.find((o) => o.deliverableId === s.deliverableId && o.slot === (s.slot ?? 1));
    if (out) latestOf.set(out.id, { status: s.status, round: s.round });
  }
  const videos: BriefSummaryVideo[] = outputs
    .map((o, i) => {
      const d = deliverableOf.get(o.deliverableId);
      return {
        id: o.id,
        number: nav.get(`${o.deliverableId}:${o.slot}`)?.number ?? i + 1,
        title: o.title?.trim() || named.get(o.id)?.trim() || `Video ${o.slot}`,
        kind: d ? videoStyleFor(d, { monthly }).name : "Video",
        dueWords: o.promisedAt ? dueWordsFor(o.promisedAt, tz) : null,
        state: videoStateWords(latestOf.get(o.id)),
      };
    })
    .sort((a, b) => a.number - b.number);
  return {
    projectId,
    client: project.client?.name ?? "",
    street: project.title?.split(",")[0]?.trim() || project.title || "Project",
    address: project.title ?? "",
    tz,
    dueWords: due?.at ? dueWordsFor(due.at, tz) : null,
    videos,
    kinds: [...new Set(project.deliverables.map((d) => videoStyleFor(d, { monthly }).name))],
  };
}

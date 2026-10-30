import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// A VIDEO ADDED TO A JOB ALREADY WITH THE EDITOR (audit H4a, Oct 22 2026).
//
// 538 Onward Ave: the order sync split Joe Sutow's Standard Video Highlight
// Reel into its own video row at 6:28 PM, six hours after the upload page was
// submitted and the edit card minted. Nothing else moved: the card still said
// "Premium reel…", John was never told there was a second video, and nobody
// asked Harrison for that video's instructions (the page was submitted before
// its box existed).
//
// When a video row is added mid-job (the order sync's create loop, which calls
// this with the new video keys), three things happen, once per new video:
//   1. the edit card's title and text are refreshed (tasks.mintEditTask names
//      every video on a two-or-more-video listing job);
//   2. the job's editor is pinged (their "job pings" bell, which bridges to
//      their DM or text), with the video's number and name; a job with no
//      in-house editor tells the office instead;
//   3. the photographer is asked for that video's instructions by the existing
//      morning-after nudge (lib/missingInstructions), which now also reads a
//      video set up after the video half was handed in. It goes at its next
//      tick from 10 AM ET, inside the photographer's own quiet time rules.
// A job not handed to editing yet needs none of this: the upload page and the
// handoff engine already show every video. `dryRun` reads and reports only.
// ---------------------------------------------------------------------------

export type VideoAddedReport = {
  projectId: string;
  street: string;
  /** the added videos as the job names them ("video 2 (Standard Video Highlight Reel)") */
  videos: string[];
  handedOff: boolean;
  card: "refreshed" | "would refresh" | "no card" | "unchanged";
  editor: { key: string | null; name: string | null; pinged: boolean | "would" };
  /** what the morning nudge asks the photographer for, in its words */
  ask: string[];
  skipped: string | null;
};


export async function announceVideosAddedMidJob(
  projectId: string,
  newKeys: string[],
  opts: { source?: string; dryRun?: boolean } = {},
): Promise<VideoAddedReport | null> {
  if (!newKeys.length) return null;
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, status: true, videoHandoffAt: true, debriefSubmittedAt: true, instructionsDropboxPath: true, photographer: { select: { name: true } } },
  });
  if (!p) return null;
  const street = (p.title || "this job").split(",")[0].trim();
  const card = await prisma.smartTask.findUnique({
    where: { dedupeKey: `edit-video-${projectId}` },
    select: { id: true, status: true, title: true, summary: true, assignedKey: true },
  });
  const liveCard = !!card && card.status !== "COMPLETED" && card.status !== "CANCELLED";
  const handedOff = liveCard || !!p.videoHandoffAt;
  const [{ videoInstructionsFor }, { laterVideoGap }] = await Promise.all([import("@/lib/deliverableOutputs"), import("@/lib/perVideoInstructions")]);
  const rows = (await videoInstructionsFor(projectId).catch(() => [])).filter((r) => newKeys.includes(r.key));
  const videos = rows.map((r) => `video ${r.number} (${r.label})`);
  const report: VideoAddedReport = {
    projectId, street, videos, handedOff,
    card: liveCard ? "unchanged" : "no card",
    editor: { key: card?.assignedKey ?? null, name: null, pinged: false },
    ask: rows.map((r) => laterVideoGap(r, { instructionsInDropbox: !!p.instructionsDropboxPath?.trim() })).filter((g): g is string => !!g),
    skipped: null,
  };
  if (p.status === "CANCELLED") return { ...report, skipped: "the job is cancelled" };
  if (!rows.length) return { ...report, skipped: "the new video is not one of the job's owed videos (waived, retired, or a monthly batch slot)" };
  if (!handedOff) return { ...report, skipped: "not handed to editing yet: the upload page and the handoff already show every video" };
  const { editorMeta, isVideoEditorKey } = await import("@/lib/editors");
  report.editor.name = card?.assignedKey ? editorMeta(card.assignedKey)?.name ?? card.assignedKey : null;
  if (opts.dryRun) return { ...report, card: liveCard ? "would refresh" : "no card", editor: { ...report.editor, pinged: "would" } };

  // 1. The card names every video now (mintEditTask's own refresh, never a
  //    completed card, never a bounce round's summary).
  if (liveCard) {
    try {
      const { mintEditTask } = await import("@/lib/tasks");
      await mintEditTask(projectId);
      const after = await prisma.smartTask.findUnique({ where: { id: card!.id }, select: { title: true, summary: true, assignedKey: true } });
      report.card = after && (after.title !== card!.title || after.summary !== card!.summary) ? "refreshed" : "unchanged";
      report.editor.key = after?.assignedKey ?? report.editor.key;
      report.editor.name = report.editor.key ? editorMeta(report.editor.key)?.name ?? report.editor.key : null;
    } catch (e) {
      console.warn("[video-added] edit card refresh failed", projectId, e);
    }
  }

  // 2. The editor hears it, by name, with the video. One ping per new video set.
  const what = videos.join(" and ");
  const key = [...newKeys].sort().join(",");
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const href = `/edit/${projectId}`;
    const editorKey = isVideoEditorKey(report.editor.key) ? report.editor.key : null;
    const due = editorKey ? await import("@/lib/editorDue").then((m) => m.editDueWords(projectId, editorKey)).catch(() => "") : "";
    if (editorKey) {
      await notifyInApp({
        kind: "raws_landed", // the editors' "job pings" switch, as the ready ping uses
        title: `Another video on ${street}: ${what}`,
        body: `${due ? `The job is ${due}. ` : ""}The order now sells it. It has its own slot on your brief; its instructions are on the way from the photographer.`,
        href,
        targets: [{ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href }],
        dedupeKey: `video-added-${projectId}-${key}`,
      });
      report.editor.pinged = true;
    } else {
      // Nobody in-house holds the job (the outside editor, or unrouted): the
      // office passes it on.
      await notifyInApp({
        kind: "video_added",
        title: `Another video on ${street}: ${what}`,
        body: report.editor.name ? `${report.editor.name} has this job: send them the updated packet.` : "No editor holds this job yet: pick one in the Editing Room.",
        href,
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        dedupeKey: `video-added-${projectId}-${key}`,
      });
      report.editor.pinged = true;
    }
  } catch (e) {
    console.warn("[video-added] editor ping failed", projectId, e);
  }

  // 3. The timeline says it, and what the photographer will be asked.
  const who = (p.photographer?.name ?? "the photographer").split(/\s+/)[0];
  const asked = report.ask.length ? ` ${who} is asked for ${report.ask.join(" and ")} by the morning instructions text (from 10 AM ET).` : "";
  await prisma.activity.create({
    data: {
      projectId, type: "SYSTEM",
      body: `Another video was added after the edit started: ${what}. The edit card now names every video; ${report.editor.name ? `${report.editor.name} was told` : "the office was told"}.${asked}`.slice(0, 1000),
    },
  }).catch(() => {});
  return report;
}

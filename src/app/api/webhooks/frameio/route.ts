import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import { frameioRequestAuthorized } from "@/lib/integrations/frameio";
import type { NotifyTarget } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Frame.io custom action + webhook receiver. The editor clicks "Send to RealTour
// for review" on their project in Frame.io → Frame.io POSTs here → we flip the
// job to Review and drop a high-priority task for Kyle to go watch + comment.
// (Public route so Frame.io can reach it. Raw payload is logged so we can refine
// the field mapping against a real trigger.)
export async function POST(req: NextRequest) {
  // Reject spoofed callbacks once the action has been (re)registered with a
  // shared token (backward compatible: allowed until a token is stored).
  if (!(await frameioRequestAuthorized(req.nextUrl.searchParams.get("t")))) {
    // A token IS configured and this POST failed it (no token stored = the check
    // passes) — log the rejection so it's countable/visible on /connections, and
    // spike-alert if it keeps happening. Best-effort; the 401 always goes out.
    try {
      await prisma.webhookEvent.create({
        data: { provider: "frameio", eventType: "signature.rejected", status: "REJECTED", error: "unsigned: token missing or mismatched", payload: "{}" },
      });
      const { alertWebhookRejections } = await import("@/lib/notify");
      await alertWebhookRejections("frameio");
    } catch { /* ignore */ }
    return NextResponse.json({ title: "Unauthorized", description: "Invalid action token." }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* non-JSON */ }

  const eventType = String((body.type as string) || (body.event as string) || "action");
  const evt = await prisma.webhookEvent
    .create({ data: { provider: "frameio", eventType, payload: JSON.stringify(body).slice(0, 12000) } })
    .catch(() => null);

  try {
    const result = await processFrameioEvent(eventType, body);
    if (evt) {
      await prisma.webhookEvent
        .update({ where: { id: evt.id }, data: { status: "PROCESSED", processedAt: new Date() } })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Surface the REAL failure instead of "Sent ✓": mark THIS event row ERROR so
    // retryFailedWebhooks re-runs it on the hourly cron, and tell the editor the
    // handoff didn't land (audit crack #21). 200 so Frame.io renders our message
    // (its own retries don't help — ours do).
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (evt) {
      await prisma.webhookEvent
        .update({ where: { id: evt.id }, data: { status: "ERROR", error: message.slice(0, 500) } })
        .catch(() => {});
    }
    return NextResponse.json(
      {
        ok: false,
        message,
        title: "RealTour Pilot — something went wrong",
        description: `The hub couldn't process this (${message.slice(0, 120)}). It will retry automatically — if the team doesn't respond, ping Kyle directly.`,
      },
      { status: 200 },
    );
  }
}

// Process one Frame.io event end-to-end. THROWS on a real failure (DB write,
// revision raise) so the caller marks the event row ERROR and surfaces the
// message — the old version wrapped every write in .catch(()=>{}), blanket-marked
// PROCESSED, and returned "Sent ✓" regardless. Returns the Frame.io-visible
// title/description for soft outcomes. Exported for the webhookRetry dispatcher.
export async function processFrameioEvent(
  eventType: string,
  body: Record<string, unknown>,
): Promise<{ title: string; description: string }> {
  // Dig out the Frame.io project id the action fired on (payload shape varies by
  // trigger — check the common spots).
  const g = (o: unknown, ...keys: string[]): unknown => {
    let cur = o;
    for (const k of keys) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    return cur;
  };
  const fioProjectId =
    (g(body, "project", "id") as string) ||
    (body.project_id as string) ||
    (g(body, "data", "project_id") as string) ||
    (g(body, "resource", "project_id") as string) ||
    (g(body, "resource", "project", "id") as string) ||
    null;

  if (!fioProjectId) {
    return { title: "RealTour Pilot", description: "Received — but couldn't identify the project." };
  }

  const project = await prisma.project.findFirst({
    where: { frameioProjectId: String(fioProjectId) },
    select: {
      id: true, title: true, clientId: true, status: true,
      // For the bell: which editor made the video (same routing /editing uses).
      deliverables: { select: { type: true, label: true } },
      client: { select: { socialClient: true } },
    },
  });
  if (!project) {
    return { title: "RealTour Pilot", description: "This Frame.io project isn't linked to a job yet." };
  }

  // A review COMMENT (not the "ready for review" action) → a revision for the
  // deliverable's editor to address, instead of flipping the stage. Best-effort
  // field extraction; the exact comment payload + author filtering are confirmed
  // against a live trigger, and this only fires once a comment webhook is
  // registered (the custom action alone doesn't send comment events).
  const isComment = /comment/i.test(eventType) || !!g(body, "comment") || !!g(body, "data", "comment");
  if (isComment) {
    const text =
      (g(body, "comment", "text") as string) ||
      (g(body, "data", "comment", "text") as string) ||
      (g(body, "comment", "body") as string) ||
      (body.text as string) ||
      "";
    if (text.trim()) {
      const { raiseRevision } = await import("@/lib/comms");
      await raiseRevision({
        projectId: project.id,
        clientId: project.clientId,
        propertyAddress: project.title,
        note: `Frame.io review note: ${text.trim()}`,
        source: "frameio",
      });
    }
    return { title: "RealTour Pilot", description: "Review note received — filed as a revision." };
  }

  // Flip to Review (only from an in-production stage, so we don't disturb
  // delivered/cancelled jobs) and notify Kyle.
  if (["SHOT", "EDITING", "REVISION"].includes(project.status)) {
    await prisma.project.update({ where: { id: project.id }, data: { status: ProjectStatus.REVIEW } });
  }
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
  const street = project.title?.split(",")[0] ?? "a job";
  await prisma.smartTask.upsert({
    where: { dedupeKey: `frameio-review-${project.id}` },
    create: {
      taskType: "media_qa",
      title: `Review finals in Frame.io — ${street}`.slice(0, 120),
      summary: "The editor marked the finished video ready for review in Frame.io. Open it, watch it, and leave any revision comments right on the video there.",
      reasonCreated: "Editor triggered “Send to RealTour for review” in Frame.io.",
      source: "system",
      priority: "HIGH",
      dueAt: new Date(Date.now() + 4 * 3600_000),
      ownerId: kyle?.id ?? null,
      projectId: project.id,
      clientId: project.clientId,
      dedupeKey: `frameio-review-${project.id}`,
    },
    update: { status: "OPEN", completedAt: null, priority: "HIGH" },
  });

  // Bell: tell the owner the edit is ready + confirm to the editor who cut it
  // that the handoff landed. Deduped per Frame.io event (or payload hash when
  // the payload carries no id) so the hourly webhook retry can't re-announce.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const { editorForDeliverable } = await import("@/lib/editors");
    const { createHash } = await import("crypto");
    const v = project.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ?? project.deliverables[0];
    const editorKey = editorForDeliverable(v?.type, v?.label, !!project.client?.socialClient);
    const eventId =
      (g(body, "resource", "id") as string) ||
      (body.id as string) ||
      createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12);
    const targets: NotifyTarget[] = [{ roles: ["OWNER"] }];
    // In-house editors only (luma is external — no channel/login), and the
    // href must be their brief: /projects bounces the EDITOR role.
    if (editorKey === "kim" || editorKey === "john" || editorKey === "remar") {
      targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${project.id}` });
    }
    await notifyInApp({
      kind: "edit_finished",
      title: `Edit ready for review — ${street}`,
      href: `/projects/${project.id}`,
      targets,
      dedupeKey: `editdone-${project.id}-${eventId}`,
    });
  } catch { /* bell is best-effort */ }

  return { title: "Sent to RealTour ✓", description: "The team has been notified to review your finals." };
}

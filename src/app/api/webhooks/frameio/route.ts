import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Frame.io custom action + webhook receiver. The editor clicks "Send to RealTour
// for review" on their project in Frame.io → Frame.io POSTs here → we flip the
// job to Review and drop a high-priority task for Kyle to go watch + comment.
// (Public route so Frame.io can reach it. Raw payload is logged so we can refine
// the field mapping against a real trigger.)
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* non-JSON */ }

  const eventType = String((body.type as string) || (body.event as string) || "action");
  await prisma.webhookEvent
    .create({ data: { provider: "frameio", eventType, payload: JSON.stringify(body).slice(0, 12000) } })
    .catch(() => {});

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
    return NextResponse.json({ title: "RealTour Pilot", description: "Received — but couldn't identify the project." });
  }

  const project = await prisma.project.findFirst({
    where: { frameioProjectId: String(fioProjectId) },
    select: { id: true, title: true, clientId: true, status: true },
  });
  if (!project) {
    return NextResponse.json({ title: "RealTour Pilot", description: "This Frame.io project isn't linked to a job yet." });
  }

  // Flip to Review (only from an in-production stage, so we don't disturb
  // delivered/cancelled jobs) and notify Kyle.
  if (["SHOT", "EDITING", "REVISION"].includes(project.status)) {
    await prisma.project.update({ where: { id: project.id }, data: { status: ProjectStatus.REVIEW } }).catch(() => {});
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
  }).catch(() => {});

  await prisma.webhookEvent
    .updateMany({ where: { provider: "frameio", eventType, processedAt: null }, data: { status: "PROCESSED", processedAt: new Date() } })
    .catch(() => {});

  return NextResponse.json({ title: "Sent to RealTour ✓", description: "The team has been notified to review your finals." });
}

"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ActivityType } from "@prisma/client";

export type FrameioResult = { ok: boolean; message: string; viewUrl?: string };

// Create (or reuse) a Frame.io review project for a RealTour job, titled
// "123 Main St — Client Name". Editors upload finals there; we review + comment.
export async function setupFrameioForProject(projectId: string): Promise<FrameioResult> {
  await requireAdmin();
  const { frameioConnected, createFrameioProject } = await import("@/lib/integrations/frameio");
  if (!(await frameioConnected())) {
    return { ok: false, message: "Connect Frame.io first on the Connections page." };
  }
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, frameioProjectId: true, frameioViewUrl: true, client: { select: { name: true } } },
  });
  if (!p) return { ok: false, message: "Project not found." };
  if (p.frameioProjectId && p.frameioViewUrl) {
    return { ok: true, message: "Already set up.", viewUrl: p.frameioViewUrl };
  }

  const street = (p.title || "").split(",")[0].trim() || p.title || "Project";
  const name = `${street} — ${p.client?.name ?? "Client"}`.slice(0, 250);
  try {
    const proj = await createFrameioProject(name);
    await prisma.project.update({
      where: { id: p.id },
      data: { frameioProjectId: proj.id, frameioViewUrl: proj.viewUrl },
    });
    await prisma.activity
      .create({ data: { projectId: p.id, type: ActivityType.FILE, body: `Frame.io review project created: ${name}` } })
      .catch(() => {});
    revalidatePath(`/projects/${p.id}`);
    revalidatePath("/editing");
    return { ok: true, message: "Frame.io project created.", viewUrl: proj.viewUrl };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't create the Frame.io project." };
  }
}

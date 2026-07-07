"use server";

import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";
import { revalidatePath } from "next/cache";

export type ReelRecipeInput = {
  hook?: string;
  script?: string;
  song?: string;
  shotList?: string;
  scriptUrl?: string;
};

// Save the "reel recipe" (hook / script / song / shot list + a link to the
// external script tool) for a video job. Any crew role can edit it — it's
// collaborative creative content, not sensitive; blocked while impersonating.
export async function saveReelRecipe(projectId: string, input: ReelRecipeInput): Promise<{ ok: boolean; message: string }> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  const clean = (s?: string) => {
    const t = (s ?? "").trim();
    return t ? t.slice(0, 8000) : null;
  };
  await prisma.project.update({
    where: { id: projectId },
    data: {
      reelHook: clean(input.hook),
      reelScript: clean(input.script),
      reelSong: clean(input.song),
      reelShotList: clean(input.shotList),
      reelScriptUrl: clean(input.scriptUrl),
      reelRecipeUpdatedAt: new Date(),
    },
  });
  // Saving the recipe IS the "review/lock the generated script" step — retire the
  // Script Studio nudge task (nothing else closed it; audit crack #35).
  await prisma.smartTask.updateMany({
    where: { dedupeKey: `scripting-script-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/shoot/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Reel recipe saved." };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { etAt } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// The office's two buttons for a video WAITING ON A SECOND SHOOT (Oct 22 2026,
// lib/secondShoot): "Waiting on a second shoot" on one video, and "Release to
// the editor". Jordan, Kyle and James (OWNER, ADMIN, CREATIVE_MANAGER); never
// from a "view as" preview (requireRole refuses it).
// ---------------------------------------------------------------------------

const OFFICE = ["OWNER", "ADMIN", "CREATIVE_MANAGER"] as ("OWNER" | "ADMIN" | "CREATIVE_MANAGER")[];
type Result = { ok: boolean; message: string };

async function actorName(): Promise<string> {
  const u = await getCurrentUser().catch(() => null);
  return (u?.name?.trim() || u?.email?.trim() || "the office").slice(0, 120);
}

function refresh(projectId: string) {
  for (const p of [`/projects/${projectId}`, `/edit/${projectId}`, `/upload/${projectId}`, "/jobs", "/editing"]) revalidatePath(p);
}

const ID = /^[a-z0-9]{10,40}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function markWaitingOnSecondShootAction(input: { projectId: string; outputId: string; note?: string | null; expectedDay?: string | null }): Promise<Result> {
  try {
    await requireRole(OFFICE);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!ID.test(input?.projectId ?? "") || !ID.test(input?.outputId ?? "")) return { ok: false, message: "That video could not be found. Reload the page." };
  const day = typeof input.expectedDay === "string" && DAY.test(input.expectedDay) ? input.expectedDay : null;
  try {
    const { markVideoWaitingOnShoot } = await import("@/lib/secondShoot");
    const r = await markVideoWaitingOnShoot({
      projectId: input.projectId,
      outputId: input.outputId,
      note: typeof input.note === "string" ? input.note : null,
      // A date the office typed is a day: noon ET on it, so no timezone moves it.
      expectedAt: day ? etAt(day, 12) : null,
      actor: await actorName(),
    });
    if (r.ok) refresh(input.projectId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    console.error("[second-shoot] mark failed", input.projectId, (e as Error)?.message);
    return { ok: false, message: "That did not save. Reload the page and try again." };
  }
}

export async function releaseSecondShootVideoAction(input: { projectId: string; outputId: string }): Promise<Result> {
  try {
    await requireRole(OFFICE);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!ID.test(input?.projectId ?? "") || !ID.test(input?.outputId ?? "")) return { ok: false, message: "That video could not be found. Reload the page." };
  try {
    const { releaseWaitingVideo } = await import("@/lib/secondShoot");
    const r = await releaseWaitingVideo({ projectId: input.projectId, outputId: input.outputId, actor: await actorName(), how: "office" });
    if (r.ok) refresh(input.projectId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    console.error("[second-shoot] release failed", input.projectId, (e as Error)?.message);
    return { ok: false, message: "That did not save. Reload the page and try again." };
  }
}

"use server";

import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";
import { revalidatePath } from "next/cache";
import {
  scriptingConfigured,
  scriptingCreateProject,
  scriptingGetByExternalId,
  scriptingListSince,
  studioToRecipe,
  studioBestLink,
  ScriptingError,
} from "@/lib/integrations/scripting";

type Result = { ok: boolean; message: string; url?: string };

// Read-only connectivity check — lists a few Studio projects (no writes, no
// emails). Confirms SCRIPTING_BASE_URL + SCRIPTING_API_KEY actually reach the
// Studio, so we can verify the link without triggering an agent intake email.
export async function testScriptingConnection(): Promise<Result> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  if (!scriptingConfigured()) return { ok: false, message: "Not connected — SCRIPTING_BASE_URL / SCRIPTING_API_KEY aren't set on the server." };
  try {
    const projects = await scriptingListSince("1970-01-01T00:00:00.000Z", 5);
    return { ok: true, message: `Connected ✓ — reached Script Studio (${projects.length} recent project${projects.length === 1 ? "" : "s"} visible).` };
  } catch (e) {
    return { ok: false, message: e instanceof ScriptingError ? `Couldn't reach Studio: ${e.message}` : "Couldn't reach Script Studio." };
  }
}

// Create (or re-link to) a Script Studio project for this job, seeded from what
// the hub already knows (client, address, city, appointment). Idempotent on the
// Studio side via external_id, so a second click just re-links. Any crew role;
// blocked while impersonating.
export async function createScriptProject(projectId: string): Promise<Result> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  if (!scriptingConfigured()) return { ok: false, message: "Script Studio isn't connected yet." };

  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, addressLine: true, city: true,
      client: { select: { name: true, email: true, backupEmail: true } },
      appointments: { orderBy: { startAt: "asc" }, take: 1, select: { startAt: true } },
    },
  });
  if (!p) return { ok: false, message: "Project not found." };

  const clientName = p.client?.name?.trim() || "Client";
  try {
    const studio = await scriptingCreateProject({
      externalId: p.id,
      clientName,
      clientFirstName: clientName.split(/\s+/)[0] || null,
      clientEmail: p.client?.email || p.client?.backupEmail || null,
      address: (p.title || p.addressLine || "").trim() || "Address TBD",
      city: p.city || null,
      appointmentDate: p.appointments[0]?.startAt ?? null,
      videoType: "listing",
    });
    const url = studioBestLink(studio) ?? undefined;
    await prisma.project.update({
      where: { id: p.id },
      data: {
        scriptingId: studio.id ? String(studio.id) : null,
        scriptingStatus: studio.status ? String(studio.status) : null,
        scriptingUrl: url ?? null,
        scriptingSyncedAt: new Date(),
      },
    });
    revalidatePath(`/edit/${p.id}`);
    revalidatePath(`/projects/${p.id}`);
    return {
      ok: true,
      message: studio.deduped ? "Re-linked the existing Script Studio project." : "Created in Script Studio — send the intake link to the agent.",
      url,
    };
  } catch (e) {
    return { ok: false, message: e instanceof ScriptingError ? e.message : "Couldn't reach Script Studio." };
  }
}

// Pull the latest hooks/script/song from Script Studio into this job's reel
// recipe (Studio is the source of truth for those fields).
export async function syncScriptFromStudio(projectId: string): Promise<Result> {
  await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  if (!scriptingConfigured()) return { ok: false, message: "Script Studio isn't connected yet." };
  try {
    const detail = await scriptingGetByExternalId(projectId);
    const r = studioToRecipe(detail);
    const data: Record<string, unknown> = { scriptingSyncedAt: new Date() };
    if (detail.id) data.scriptingId = String(detail.id);
    if (r.status) data.scriptingStatus = r.status;
    if (r.url) data.scriptingUrl = r.url;
    if (r.hook) data.reelHook = r.hook;
    if (r.script) data.reelScript = r.script;
    if (r.song) data.reelSong = r.song;
    if (r.url) data.reelScriptUrl = r.url;
    if (r.hook || r.script) data.reelRecipeUpdatedAt = new Date();
    await prisma.project.update({ where: { id: projectId }, data });
    revalidatePath(`/edit/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    const got = [r.hook && "hook", r.script && "script", r.song && "song"].filter(Boolean).join(" · ");
    return { ok: true, message: got ? `Synced ${got} from Script Studio.` : `Studio status: ${r.status ?? "unknown"} — nothing to pull yet.`, url: r.url };
  } catch (e) {
    return { ok: false, message: e instanceof ScriptingError ? e.message : "Couldn't reach Script Studio." };
  }
}

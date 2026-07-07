import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import {
  scriptingConfigured,
  scriptingGetByExternalId,
  studioToRecipe,
  studioBestLink,
  type StudioProject,
} from "@/lib/integrations/scripting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives Script Studio → hub webhooks (project.created, hooks_proposed,
// script_generated, sent_to_client, client_responded, done, updated, deleted).
// Verifies the HMAC signature when SCRIPTING_WEBHOOK_SECRET is set (must equal
// HUB_WEBHOOK_SECRET on the Studio server). The webhook is the fast-path; we
// re-fetch the authoritative project by external_id before mirroring anything.
export async function POST(req: NextRequest) {
  const raw = await req.text();

  const secret = process.env.SCRIPTING_WEBHOOK_SECRET || "";
  if (secret) {
    const provided = (req.headers.get("x-scripting-signature") || "").replace(/^sha256=/, "");
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const ok =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      await prisma.webhookEvent
        .create({ data: { provider: "scripting", eventType: "signature.rejected", status: "REJECTED", payload: (raw || "{}").slice(0, 2000) } })
        .catch(() => {});
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let body: { event?: string; data?: StudioProject & Record<string, unknown> } = {};
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }
  const event = String(body.event || "unknown");
  const data = (body.data || {}) as StudioProject & Record<string, unknown>;

  const evt = await prisma.webhookEvent
    .create({ data: { provider: "scripting", eventType: event, externalId: data.id ? String(data.id) : null, payload: raw.slice(0, 12000) } })
    .catch(() => null);

  try {
    await processScriptingEvent(event, data);
    if (evt) {
      await prisma.webhookEvent
        .update({ where: { id: evt.id }, data: { status: "PROCESSED", processedAt: new Date() } })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Surface the REAL failure: this event row goes ERROR so retryFailedWebhooks
    // re-runs it on the hourly cron (then FAILED → the /connections error badge),
    // instead of blanket-acking and letting a client revision request sit in an
    // unwatched pile (audit crack #21). Still 200 — our retry loop owns it.
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (evt) {
      await prisma.webhookEvent
        .update({ where: { id: evt.id }, data: { status: "ERROR", error: message.slice(0, 500) } })
        .catch(() => {});
    }
    return NextResponse.json({ ok: false, message }, { status: 200 });
  }
}

// Process one Studio event end-to-end. THROWS on failure — including "no linked
// hub project", so an event for a job that isn't linked YET gets a retry after
// the link lands instead of vanishing. Exported for the webhookRetry dispatcher.
export async function processScriptingEvent(
  event: string,
  data: StudioProject & Record<string, unknown>,
): Promise<void> {
  // Resolve the hub project. The Studio passes our id back as external_id; fall
  // back to a stored Studio id link.
  const hubId = data.external_id ? String(data.external_id) : null;
  const project =
    (hubId ? await prisma.project.findUnique({ where: { id: hubId }, select: { id: true, title: true, clientId: true } }) : null) ||
    (data.id ? await prisma.project.findFirst({ where: { scriptingId: String(data.id) }, select: { id: true, title: true, clientId: true } }) : null);

  if (!project) {
    throw new Error(`No linked hub project (external_id=${hubId ?? "none"}, studio id=${data.id ?? "none"}).`);
  }

  // Unlink on delete — never delete the hub job, just drop the Studio link.
  if (event === "project.deleted") {
    await prisma.project.update({
      where: { id: project.id },
      data: { scriptingId: null, scriptingStatus: null, scriptingUrl: null, scriptingSyncedAt: new Date() },
    });
    return;
  }

  // Baseline update from the summary payload (status + best link + link id).
  const base: Record<string, unknown> = {};
  if (data.id) base.scriptingId = String(data.id);
  if (data.status) base.scriptingStatus = String(data.status);
  const summaryLink = studioBestLink(data);
  if (summaryLink) base.scriptingUrl = summaryLink;

  // For script/state milestones, re-fetch the full project and mirror the
  // hooks/script/song into the reel recipe (source-of-truth reconcile).
  const enrich = ["project.hooks_proposed", "project.script_generated", "project.sent_to_client", "project.done", "project.updated", "project.client_responded"].includes(event);
  if (enrich && scriptingConfigured()) {
    const detail = await scriptingGetByExternalId(project.id).catch(() => null);
    if (detail) {
      const r = studioToRecipe(detail);
      if (r.hook) base.reelHook = r.hook;
      if (r.script) base.reelScript = r.script;
      if (r.song) base.reelSong = r.song;
      if (r.url) { base.reelScriptUrl = r.url; base.scriptingUrl = r.url; }
      if (r.status) base.scriptingStatus = r.status;
      if (r.hook || r.script) base.reelRecipeUpdatedAt = new Date();
    }
  }
  base.scriptingSyncedAt = new Date();
  await prisma.project.update({ where: { id: project.id }, data: base });

  // Nudge the team on the two moments that need a human: a fresh script to
  // review/lock, and a client reply on the script. And CLOSE those nudges when
  // the Studio status advances past them — each event used to only re-open the
  // same key, so nothing ever closed these tasks (audit crack #35).
  const street = project.title?.split(",")[0]?.trim() || "a job";
  if (event === "project.script_generated") {
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
    await prisma.smartTask.upsert({
      where: { dedupeKey: `scripting-script-${project.id}` },
      create: {
        taskType: "internal_instruction",
        title: `Script ready — ${street}`.slice(0, 120),
        summary: "Script Studio generated the hooks + script for this reel. Open it, pick/lock the recipe (hook · script · song), then it's ready to shoot.",
        reasonCreated: "Script Studio finished generating the script.",
        source: "system",
        priority: "MEDIUM",
        dueAt: new Date(Date.now() + 24 * 3600_000),
        ownerId: kyle?.id ?? null,
        projectId: project.id,
        clientId: project.clientId,
        dedupeKey: `scripting-script-${project.id}`,
      },
      update: { status: "OPEN", completedAt: null },
    });
    // A regenerated script means the client's response was handled — retire the
    // "client responded" nudge rather than leaving both open.
    await closeScriptingTasks(project.id, ["client"]);
  } else if (event === "project.client_responded") {
    const revision = String(data.status ?? "").includes("revision");
    await prisma.smartTask.upsert({
      where: { dedupeKey: `scripting-client-${project.id}` },
      create: {
        taskType: "internal_instruction",
        title: `${revision ? "Client wants script changes" : "Client responded on script"} — ${street}`.slice(0, 120),
        summary: revision
          ? "The agent requested changes to their script in Script Studio. Review their notes and revise."
          : "The agent responded to their script in Script Studio. Check whether it's approved or needs changes.",
        reasonCreated: "Client responded in Script Studio.",
        source: "system",
        priority: revision ? "HIGH" : "MEDIUM",
        dueAt: new Date(Date.now() + 8 * 3600_000),
        projectId: project.id,
        clientId: project.clientId,
        dedupeKey: `scripting-client-${project.id}`,
      },
      update: { status: "OPEN", completedAt: null },
    });
  } else if (event === "project.sent_to_client") {
    // The script was locked + sent — the "Script ready" review step is done.
    await closeScriptingTasks(project.id, ["script"]);
  } else if (event === "project.done") {
    // The scripting loop is finished — both nudges are moot.
    await closeScriptingTasks(project.id, ["script", "client"]);
  }
}

// Complete the hub's Studio-nudge tasks for a project ("script" = review/lock the
// generated script, "client" = handle the client's response).
async function closeScriptingTasks(projectId: string, kinds: ("script" | "client")[]): Promise<void> {
  await prisma.smartTask.updateMany({
    where: {
      dedupeKey: { in: kinds.map((k) => `scripting-${k}-${projectId}`) },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

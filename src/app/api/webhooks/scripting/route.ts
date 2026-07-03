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

  await prisma.webhookEvent
    .create({ data: { provider: "scripting", eventType: event, externalId: data.id ? String(data.id) : null, payload: raw.slice(0, 12000) } })
    .catch(() => {});

  // Resolve the hub project. The Studio passes our id back as external_id; fall
  // back to a stored Studio id link.
  const hubId = data.external_id ? String(data.external_id) : null;
  const project =
    (hubId ? await prisma.project.findUnique({ where: { id: hubId }, select: { id: true, title: true, clientId: true } }) : null) ||
    (data.id ? await prisma.project.findFirst({ where: { scriptingId: String(data.id) }, select: { id: true, title: true, clientId: true } }) : null);

  if (!project) {
    return NextResponse.json({ ok: true, note: "No linked hub project." });
  }

  const markProcessed = () =>
    prisma.webhookEvent
      .updateMany({ where: { provider: "scripting", eventType: event, processedAt: null }, data: { status: "PROCESSED", processedAt: new Date() } })
      .catch(() => {});

  try {
    // Unlink on delete — never delete the hub job, just drop the Studio link.
    if (event === "project.deleted") {
      await prisma.project.update({
        where: { id: project.id },
        data: { scriptingId: null, scriptingStatus: null, scriptingUrl: null, scriptingSyncedAt: new Date() },
      });
      await markProcessed();
      return NextResponse.json({ ok: true });
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
    // review/lock, and a client reply on the script.
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
      }).catch(() => {});
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
      }).catch(() => {});
    }

    await markProcessed();
    return NextResponse.json({ ok: true });
  } catch (e) {
    await prisma.webhookEvent
      .updateMany({ where: { provider: "scripting", eventType: event, processedAt: null }, data: { status: "ERROR", error: String(e).slice(0, 500) } })
      .catch(() => {});
    return NextResponse.json({ ok: false }, { status: 200 }); // ack anyway; reconcile via GET
  }
}

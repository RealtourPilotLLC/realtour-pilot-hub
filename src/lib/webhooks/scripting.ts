import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import {
  scriptingConfigured,
  scriptingGetDetail,
  studioSnapshot,
  studioSnapshotFromEvent,
  studioBestLink,
  type StudioProject,
} from "@/lib/integrations/scripting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives Script Studio → hub webhooks (project.created, intake_submitted,
// hooks_proposed, script_generated, sent_to_client, client_responded, updated,
// script_updated, done, deleted; any other event is recorded and mirrored the
// same way). Verifies the HMAC signature when SCRIPTING_WEBHOOK_SECRET is set
// (must equal HUB_WEBHOOK_SECRET on the Studio server). The webhook is the
// fast path (best-effort on their side: one try, 5 s); the 15-minute
// reconcile in lib/scriptSync is the safety net. Jobs are matched by Aryeo
// order, then external_id, then the stored scripting id (Oct 20 2026).

// Stamped on the WebhookEvent row of every event we let through WITHOUT
// verifying it, so an unsigned acceptance is self-describing forever instead of
// looking identical to a verified one (RTP-28, Sep 16: this receiver was the one
// of the three that left NO record either way, so its rows could not be told
// apart). /connections counts rows on this prefix — keep the three in step.
const UNSIGNED_MARKER = "UNSIGNED: accepted without verification — no webhook secret configured";

export async function POST(req: NextRequest) {
  // Editors onboarded on People join the roster before anything routes or pings one.
  await import("@/lib/editorRoster").then((m) => m.ensureEditorRoster()).catch(() => {});
  const raw = await req.text();

  const secret = process.env.SCRIPTING_WEBHOOK_SECRET || "";
  const unsigned = !secret;
  if (secret) {
    const headerName = "x-scripting-signature";
    const sig = req.headers.get(headerName) || "";
    // Compare BYTES, gated on BYTE length (Oct 20 2026, audit H19; the same
    // fix the Aryeo and OpenPhone receivers carry). timingSafeEqual throws on
    // buffers of different lengths, and a string's .length counts characters:
    // a header of 64 multi-byte characters passed the old character gate, threw
    // inside the compare, and turned an unauthenticated post into a 500, an
    // error-tracker row and an owner alert. Now it is a plain bad signature.
    const provided = Buffer.from(sig.replace(/^sha256=/, ""), "utf8");
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
    const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!ok) {
      const { refuseWebhook } = await import("@/lib/webhookRetry");
      await refuseWebhook("scripting", { code: "bad-signature", rawBody: raw, header: headerName, sig });
      // Reason to the stored row and the owner-only Connections strip, not to the
      // caller — a refused post is unauthenticated (RTP-28 review, Sep 16).
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // RTP-28 (Sep 16): SCRIPTING_WEBHOOK_SECRET is an env var, so what Vercel
    // actually holds is NOT readable from the hub — which means nobody can
    // prove this receiver is verifying in production. Until Jordan confirms it,
    // this lane stays on its CURRENT default (accept, and say so on the row);
    // the office can flip it to "verify every post" on /connections the moment
    // he does. Turning it on from here would silence Script Studio the way the
    // Sep 8 Aryeo cutover silenced order and media events.
    const { gateMissingSecret, refuseWebhook } = await import("@/lib/webhookRetry");
    const gate = await gateMissingSecret("scripting", "scripting_webhook");
    if (!gate.allow) {
      await refuseWebhook("scripting", { code: gate.code, rawBody: raw, header: null, sig: null });
      return NextResponse.json({ error: "Unverified" }, { status: 401 });
    }
    console.warn("[webhook] scripting: UNSIGNED event accepted — SCRIPTING_WEBHOOK_SECRET is not set on this deployment.");
  }

  let body: { event?: string; data?: StudioProject & Record<string, unknown> } = {};
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }
  const event = String(body.event || "unknown");
  const data = (body.data || {}) as StudioProject & Record<string, unknown>;

  const evt = await prisma.webhookEvent
    .create({
      data: {
        provider: "scripting",
        eventType: event,
        externalId: data.id ? String(data.id) : null,
        payload: raw.slice(0, 12000),
        // Marker only — status stays on its normal RECEIVED→PROCESSED path so
        // dedupe and the hourly retry sweep behave exactly as before.
        error: unsigned ? UNSIGNED_MARKER : null,
      },
    })
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
        .update({
          where: { id: evt.id },
          // Keep the UNSIGNED marker alongside the failure. Overwriting `error`
          // here stripped it, so an unsigned event that ALSO failed to process
          // stopped being self-describing — which is the one gap the marker was
          // added to close (RTP-28 review, Sep 16). readRetryState only strips
          // its own [[…]] tails, so the marker survives the retry bookkeeping.
          data: { status: "ERROR", error: (unsigned ? `${UNSIGNED_MARKER} · ${message}` : message).slice(0, 500) },
        })
        .catch(() => {});
    }
    return NextResponse.json({ ok: false, message }, { status: 200 });
  }
}

// Process one Studio event end-to-end. THROWS on failure — including "no linked
// hub project", so an event for a job that isn't linked YET gets a retry after
// the link lands instead of vanishing. Exported for the webhookRetry dispatcher.
/** Prisma's cuid(): "c" then lower-case letters and digits (25 in practice). */
const HUB_ID_SHAPE = /^c[a-z0-9]{20,32}$/;

export async function processScriptingEvent(
  event: string,
  data: StudioProject & Record<string, unknown>,
): Promise<void> {
  // Resolve the hub job: its Aryeo order (most platform projects come from
  // Aryeo bookings and carry nothing else, Oct 20 2026), then the hub id the
  // platform passes back as external_id, then a stored scripting id.
  const { hubJobFor, applyStudioSnapshot } = await import("@/lib/scriptSync");
  const hubId = data.external_id ? String(data.external_id) : null;
  const job = await hubJobFor(data);
  const project = job ? await prisma.project.findUnique({ where: { id: job.id }, select: { id: true, title: true, clientId: true } }) : null;

  if (!project) {
    // Studio-NATIVE projects (created inside Studio, external_id never set) can
    // never link to a hub job — skip them cleanly instead of erroring forever
    // into the /connections badge and the hourly retry loop. An Aryeo booking
    // the hub has not imported yet is picked up by the 15-minute reconcile
    // once the order arrives. Only an event that CARRIES a hub id is a real
    // linkage failure worth retrying.
    if (!hubId) return;
    // …and the same for an external_id that is not shaped like a hub id at
    // all. Studio's own test projects carry ids like "skit_test" or
    // "link_test" (13 of them in September): no hub row can ever have that
    // id, so retrying six times and then counting a failure on /connections
    // only buries the real linkage failures. A hub id is a cuid; anything that
    // could be one still throws and retries.
    if (!HUB_ID_SHAPE.test(hubId)) return;
    throw new Error(`No linked hub project (external_id=${hubId}, aryeo order=${data.aryeo_order_id ?? "none"}, studio id=${data.id ?? "none"}).`);
  }

  // Unlink on delete — never delete the hub job, just drop the Studio link.
  if (event === "project.deleted") {
    await prisma.project.update({
      where: { id: project.id },
      data: { scriptingId: null, scriptingStatus: null, scriptingUrl: null, scriptingDraftVersion: null, scriptingSyncedAt: new Date() },
    });
    return;
  }

  // What the event itself says about versions: a draft saved for Jordan's
  // review (status only, never its text) and the version the agent received.
  const sv = data.script_version && typeof data.script_version === "object" ? (data.script_version as Record<string, unknown>) : null;
  const version = typeof sv?.version_number === "number" ? sv.version_number : null;
  const draftVersion = event === "project.script_generated" ? version : null;
  const sentAt = typeof sv?.delivered_at === "string" ? new Date(sv.delivered_at) : null;
  const client = event === "project.sent_to_client" ? { version, sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : new Date() } : null;

  // The crew script: from the event when it carries it (script_updated, a
  // release), else read back from the platform, which is the source of truth.
  let snap = studioSnapshotFromEvent(event, data);
  if (!snap && scriptingConfigured()) {
    const detail = await scriptingGetDetail({ aryeoOrderId: data.aryeo_order_id ?? job!.aryeoOrderId, hubId: project.id, scriptingId: data.id ? String(data.id) : job!.scriptingId });
    if (detail) snap = studioSnapshot(detail);
  }
  if (!snap) {
    // Not configured for reads, or the platform did not answer: keep status + link.
    snap = { studioId: data.id ? String(data.id) : null, status: data.status ? String(data.status) : null, updatedAt: null, url: studioBestLink(data), hook: null, song: null, crew: null, client: null };
  }
  await applyStudioSnapshot(project.id, snap, { draftVersion, client });

  // Nudge the team on the two moments that need a human: a fresh script to
  // review/lock, and a client reply on the script. And CLOSE those nudges when
  // the Studio status advances past them — each event used to only re-open the
  // same key, so nothing ever closed these tasks (audit crack #35).
  const street = project.title?.split(",")[0]?.trim() || "a job";
  // LISTING SCRIPTS ARE THE CREATIVE MANAGER'S (Jordan's Loom, Oct 27 2026,
  // 3:51: "I don't need to approve the scripts, James can approve them";
  // earlier that day they were routed to Jordan, and before that to Kyle).
  // Both Studio nudges go to whoever owns listing scripts
  // (taskRouting.listingScriptsDesk: James, else the owner). A reopened task
  // moves over too, unless a person put it on someone on purpose.
  const { listingScriptsDesk, deskFields } = await import("@/lib/taskRouting");
  const scriptsDesk = deskFields(await listingScriptsDesk().catch(() => null));
  const reopen = async (key: string) => {
    const prior = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { assignedManually: true, delegatedAt: true } });
    return { status: "OPEN" as const, completedAt: null, ...(prior && !prior.assignedManually && !prior.delegatedAt && scriptsDesk.assignedKey ? scriptsDesk : {}) };
  };
  if (event === "project.script_generated") {
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
        ...scriptsDesk,
        projectId: project.id,
        clientId: project.clientId,
        dedupeKey: `scripting-script-${project.id}`,
      },
      update: await reopen(`scripting-script-${project.id}`),
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
        ...scriptsDesk,
        projectId: project.id,
        clientId: project.clientId,
        dedupeKey: `scripting-client-${project.id}`,
      },
      update: await reopen(`scripting-client-${project.id}`),
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

import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { approveScriptVersion, releaseScriptVersion } from "@/lib/contentScripts";
import { sendThroughOutbox, scriptShareKey, strategyReadyKey, maskToRef } from "@/lib/outbox";
import { isTestClientName, isStaffControlledEmail } from "@/lib/testClients";
import { clientTextWindowOpen } from "@/lib/clientTextSweeps";
import { reminderPolicy, inPolicyWindow, nextPolicyWindowOpen, resolvePortalLink, recordSendResult, REMINDER_DEFAULTS, type ReminderPolicy } from "@/lib/programReminders";
import { templateForAction, renderReminder, reminderTemplate, monthName, firstNameOf, type TemplateVars } from "@/lib/reminderTemplates";

// ---------------------------------------------------------------------------
// APPROVE & SHARE (spec §22) — W2-F, Sep 17 2026.
//
// One action for Jordan: approve the EXACT saved version, release it to the
// client's portal, and queue the "your scripts are ready" email. Three facts,
// three records, never confused:
//   1. approval      → ContentScriptVersion.approvedAt/By + a ContentScriptRelease
//                      APPROVE row (contentScripts.approveScriptVersion);
//   2. release       → ContentScript.sharedVersionId + a SHARE release row
//                      (contentScripts.releaseScriptVersion);
//   3. notification  → a ProgramReminder SCRIPTS_READY row (the notice), which
//                      the SHARE row points at through `reminderId`, and whose
//                      OutboxMessage carries the actual email.
// A failed email leaves 1 and 2 exactly as they are — the client sees the
// script in the portal, the SHARE row reads notificationState FAILED with the
// provider's words, and the notice retries through the outbox on the next
// hourly drain. Nothing is ever undone by a mail failure.
//
// BATCHING. Approvals inside `scriptShareBatchMinutes` (policy, default 15)
// attach to the SAME pending notice for that client, so approving five
// scripts one after another produces ONE email listing five titles. An
// explicit batchKey (the queue's "approve selected") pins every share to one
// notice regardless of timing. The notice is sent by drainShareNotices —
// hourly from the cron, or right away by a caller that asks — only while
// `script_share_email` is ON (missing row = off), only inside the send
// window, and (pre-launch) only to TEST clients at staff-controlled addresses.
//
// UPDATE POLICY (spec: "a deliberate update notification policy"). Sharing a
// NEWER version of a script the client already saw is an UPDATE: it is listed
// under "Updated since you last saw it" in the same batch email rather than
// sent as its own message, and the previously shared version stays exactly
// what the portal showed until this one replaces it. Re-sharing the SAME
// version is a no-op (no second release row, no email).
//
// With the switch OFF the release still happens: the SHARE row records
// notificationState SUPPRESSED with the reason, no notice row is written, no
// OutboxMessage exists, and the caller's message says so.
// ---------------------------------------------------------------------------

export const SHARE_KEY = "script_share_email" as const;

export type ShareActor = { email: string; appUserId?: string | null };

export type ShareResult = {
  scriptId: string;
  versionId: string;
  approved: "already" | "now";
  released: "already" | "now";
  update: boolean;
  email: "queued" | "suppressed";
  noticeId: string | null;
  emailNote: string;
  message: string;
};

async function latestShareRelease(scriptVersionId: string) {
  return prisma.contentScriptRelease.findFirst({ where: { scriptVersionId, action: "SHARE" }, orderBy: { createdAt: "desc" } });
}

/**
 * The one action. Idempotent: pressing it twice on the same version approves
 * once, releases once and queues once.
 */
export async function shareApprovedScript(scriptVersionId: string, by: ShareActor, opts: { batchKey?: string | null; note?: string | null; now?: Date } = {}): Promise<ShareResult> {
  const now = opts.now ?? new Date();
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: scriptVersionId }, select: { id: true, scriptId: true, enrollmentId: true, clientId: true, title: true, status: true } });
  if (!v) throw new Error("Script version not found.");
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { historical: true, approvedVersionId: true, sharedVersionId: true, monthId: true } });
  if (!s) throw new Error("Script not found.");
  if (s.historical) throw new Error("Imported scripts are history — they are not approved or shared from here.");
  const update = !!s.sharedVersionId && s.sharedVersionId !== scriptVersionId;

  // 1. Approve THIS version (the queue's saved draft), unless it already is.
  let approved: ShareResult["approved"] = "already";
  if (s.approvedVersionId !== scriptVersionId || (v.status !== "APPROVED" && v.status !== "SHARED")) {
    const r = await approveScriptVersion(scriptVersionId, by, opts.note ?? null);
    approved = r.alreadyApproved ? "already" : "now";
  }
  // 2. Release to the portal, unless this exact version is already the shared one.
  let released: ShareResult["released"] = "already";
  let notificationState = "NONE";
  if (s.sharedVersionId !== scriptVersionId) {
    const r = await releaseScriptVersion(v.scriptId, by, { batchKey: opts.batchKey ?? null, note: opts.note ?? null });
    released = "now";
    notificationState = r.notificationState;
  } else {
    const existing = await latestShareRelease(scriptVersionId);
    notificationState = existing?.notificationState ?? "NONE";
    if (existing && (existing.notificationState === "SENT" || existing.notificationState === "QUEUED")) {
      return { scriptId: v.scriptId, versionId: scriptVersionId, approved, released, update: false, email: "queued", noticeId: existing.reminderId, emailNote: `already ${existing.notificationState.toLowerCase()}`, message: `"${v.title}" was already shared — nothing changed.` };
    }
  }
  const release = await latestShareRelease(scriptVersionId);
  // 3. The email — only behind its switch. contentScripts already wrote
  //    SUPPRESSED when the switch was off; say so and stop.
  const emailOn = await isAutomationEnabled(SHARE_KEY);
  if (!emailOn || notificationState === "SUPPRESSED") {
    const note = "Email suppressed: script_share_email is off — launch is not authorised. The script is on the portal; no email was queued.";
    if (release) await prisma.contentScriptRelease.update({ where: { id: release.id }, data: { notificationState: "SUPPRESSED", note } });
    return { scriptId: v.scriptId, versionId: scriptVersionId, approved, released, update, email: "suppressed", noticeId: null, emailNote: note, message: `Approved and shared "${v.title}" to the portal. ${note}` };
  }
  const notice = await attachToNotice({ enrollmentId: v.enrollmentId, clientId: v.clientId, monthId: s.monthId, releaseId: release?.id ?? null, batchKey: opts.batchKey ?? null, by: by.email, now });
  return {
    scriptId: v.scriptId, versionId: scriptVersionId, approved, released, update, email: "queued", noticeId: notice.id,
    emailNote: notice.created ? `Email queued — one message for everything shared to this client in the next ${notice.batchMinutes} minutes.` : "Added to the email already queued for this client.",
    message: `Approved and shared "${v.title}"${update ? " (an update to a script the client already saw)" : ""}. ${notice.created ? `Email queued for ${notice.batchMinutes} minutes from now so a batch goes as one message.` : "Added to the pending email for this client."}`,
  };
}

/** The queue's "approve & share selected": one batch, one notice per client. */
export async function shareApprovedScripts(scriptVersionIds: string[], by: ShareActor, opts: { note?: string | null; now?: Date } = {}): Promise<{ results: ShareResult[]; errors: { versionId: string; error: string }[]; batchKey: string }> {
  const now = opts.now ?? new Date();
  const batchKey = `batch:${by.email}:${now.toISOString()}`;
  const results: ShareResult[] = [];
  const errors: { versionId: string; error: string }[] = [];
  for (const id of [...new Set(scriptVersionIds)]) {
    try { results.push(await shareApprovedScript(id, by, { batchKey, note: opts.note ?? null, now })); }
    catch (e) { errors.push({ versionId: id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { results, errors, batchKey };
}

// ---- notices (SCRIPTS_READY / STRATEGY_READY ProgramReminder rows) ------------------

async function batchMinutes(): Promise<number> {
  const { policy } = await reminderPolicy({ orDefaults: true });
  return (policy ?? REMINDER_DEFAULTS).scriptShareBatchMinutes;
}

async function attachToNotice(o: { enrollmentId: string; clientId: string; monthId: string | null; releaseId: string | null; batchKey: string | null; by: string; now: Date }): Promise<{ id: string; created: boolean; batchMinutes: number }> {
  const minutes = await batchMinutes();
  const month = o.monthId ? await prisma.contentMonth.findUnique({ where: { id: o.monthId }, select: { monthKey: true } }) : null;
  const { policy } = await reminderPolicy({ orDefaults: true });
  const templateKey = templateForAction("SCRIPTS_READY", (policy ?? REMINDER_DEFAULTS).templates).id;
  // A pending notice for this client (same batch key, or any still inside its window) takes the release.
  const pending = await prisma.programReminder.findFirst({
    where: { enrollmentId: o.enrollmentId, action: "SCRIPTS_READY", state: "PENDING", ...(o.batchKey ? { dedupeKey: `${o.enrollmentId}:SCRIPTS_READY:${o.batchKey}` } : {}) },
    orderBy: { createdAt: "desc" },
  });
  let id: string;
  let created = false;
  if (pending) id = pending.id;
  else {
    const dedupeKey = o.batchKey ? `${o.enrollmentId}:SCRIPTS_READY:${o.batchKey}` : `${o.enrollmentId}:SCRIPTS_READY:${o.now.toISOString()}`;
    try {
      const row = await prisma.programReminder.create({
        data: {
          enrollmentId: o.enrollmentId, clientId: o.clientId, monthId: o.monthId, monthKey: month?.monthKey ?? null, action: "SCRIPTS_READY", templateKey, templateVersion: reminderTemplate(templateKey).version,
          channel: "email", attempt: 1, state: "PENDING", nextEligibleAt: new Date(o.now.getTime() + minutes * 60_000), manual: false, requestedBy: o.by, dedupeKey,
        },
        select: { id: true },
      });
      id = row.id; created = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      const again = await prisma.programReminder.findFirst({ where: { dedupeKey: `${o.enrollmentId}:SCRIPTS_READY:${o.batchKey}` }, select: { id: true } });
      if (!again) throw e;
      id = again.id;
    }
  }
  if (o.releaseId) await prisma.contentScriptRelease.update({ where: { id: o.releaseId }, data: { reminderId: id, notificationState: "QUEUED", note: created ? `Email queued (notice ${id}) — sends as one message for this client.` : `Added to the pending email (notice ${id}).` } });
  return { id, created, batchMinutes: minutes };
}

/**
 * STRATEGY READY (spec §21): the approved strategy was released to the portal.
 * Same switch (`script_share_email` — shared work), same notice machinery.
 * Returns null when the switch is off; the caller says so.
 */
export async function queueStrategyReadyNotice(o: { enrollmentId: string; strategyVersionId: string; by: string; now?: Date }): Promise<{ id: string; created: boolean } | null> {
  if (!(await isAutomationEnabled(SHARE_KEY))) return null;
  const now = o.now ?? new Date();
  const e = await prisma.contentEnrollment.findUnique({ where: { id: o.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const { policy } = await reminderPolicy({ orDefaults: true });
  const templateKey = templateForAction("STRATEGY_READY", (policy ?? REMINDER_DEFAULTS).templates).id;
  const dedupeKey = `${o.enrollmentId}:strategy:${o.strategyVersionId}:STRATEGY_READY`;
  try {
    const row = await prisma.programReminder.create({
      data: { enrollmentId: o.enrollmentId, clientId: e.clientId, action: "STRATEGY_READY", templateKey, templateVersion: reminderTemplate(templateKey).version, channel: "email", attempt: 1, state: "PENDING", nextEligibleAt: now, manual: false, requestedBy: o.by, dedupeKey, evaluatedStateJson: JSON.stringify({ strategyVersionId: o.strategyVersionId }) },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await prisma.programReminder.findFirst({ where: { dedupeKey }, select: { id: true } });
      return again ? { id: again.id, created: false } : null;
    }
    throw err;
  }
}

export type DrainResult = { enabled: boolean; considered: number; sent: number; failed: number; unknown: number; held: number; suppressed: number; notes: string[] };

/**
 * Send the notices whose batch window has closed. Hourly from the cron; a
 * caller may pass `now` for a probe. Every gate re-checked per notice:
 * switch, enrollment status, the releases still shared, the lock, the window.
 */
export async function drainShareNotices(opts: { now?: Date; max?: number; requestedBy?: string; byAppUserId?: string | null } = {}): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const out: DrainResult = { enabled: false, considered: 0, sent: 0, failed: 0, unknown: 0, held: 0, suppressed: 0, notes: [] };
  if (!(await isAutomationEnabled(SHARE_KEY))) { out.notes.push("script_share_email is off — nothing sent"); return out; }
  out.enabled = true;
  const { policy: p0 } = await reminderPolicy({ orDefaults: true });
  const policy: ReminderPolicy = p0 ?? REMINDER_DEFAULTS;
  const windowOpen = inPolicyWindow(now, policy) && (await clientTextWindowOpen(now));
  const due = await prisma.programReminder.findMany({
    where: {
      action: { in: ["SCRIPTS_READY", "STRATEGY_READY"] },
      OR: [
        { state: "PENDING", nextEligibleAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { state: "FAILED", nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { nextEligibleAt: "asc" },
    take: opts.max ?? 10,
  });
  const leaseBy = `${opts.requestedBy ?? "share-drain"}:${process.pid}`;
  for (const n of due) {
    out.considered++;
    if (!windowOpen) {
      const next = nextPolicyWindowOpen(now, policy);
      await prisma.programReminder.update({ where: { id: n.id }, data: { nextEligibleAt: n.state === "PENDING" ? next : n.nextEligibleAt, nextAttemptAt: n.state === "FAILED" ? next : n.nextAttemptAt } });
      out.held++;
      continue;
    }
    // Claim.
    const won = await prisma.programReminder.updateMany({ where: { id: n.id, state: n.state }, data: { leaseUntil: new Date(now.getTime() + 5 * 60_000), leaseBy, state: "QUEUED" } });
    if (won.count === 0) continue;
    const suppress = async (reason: string, why: string) => {
      await prisma.programReminder.update({ where: { id: n.id }, data: { state: "SUPPRESSED", suppressionReason: reason, lastError: why, lastErrorAt: now, leaseUntil: null, leaseBy: null } });
      await prisma.contentScriptRelease.updateMany({ where: { reminderId: n.id }, data: { notificationState: "SUPPRESSED", note: `Email suppressed: ${why}` } });
      out.suppressed++;
      out.notes.push(`${n.id}: suppressed (${reason})`);
    };
    const e = await prisma.contentEnrollment.findUnique({ where: { id: n.enrollmentId }, select: { id: true, clientId: true, status: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } });
    const client = e ? await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true, email: true } }) : null;
    if (!e || !client) { await suppress("no_enrollment", "enrollment or client no longer exists"); continue; }
    if (e.status !== "ACTIVE") { await suppress(e.status === "PAUSED" ? "paused" : "ended", `enrollment is ${e.status}`); continue; }
    if (e.accessRevokedAt) { await suppress("access_revoked", "portal access was revoked"); continue; }
    const isTest = isTestClientName(client.name);
    if (policy.testClientsOnly && !isTest) { await suppress("launch_not_authorised", "policy.testClientsOnly is on — only TEST clients may receive until launch is authorised"); continue; }
    // What is still shared (a script pulled back to the queue drops out of the email).
    let titles: string[] = [];
    let updated: string[] = [];
    if (n.action === "SCRIPTS_READY") {
      const releases = await prisma.contentScriptRelease.findMany({ where: { reminderId: n.id, action: "SHARE" }, orderBy: { createdAt: "asc" } });
      for (const r of releases) {
        const s = await prisma.contentScript.findUnique({ where: { id: r.scriptId }, select: { sharedVersionId: true, releaseState: true } });
        if (!s || s.sharedVersionId !== r.scriptVersionId || s.releaseState !== "released") continue;
        const v = await prisma.contentScriptVersion.findUnique({ where: { id: r.scriptVersionId }, select: { title: true } });
        if (!v) continue;
        const earlier = await prisma.contentScriptRelease.count({ where: { scriptId: r.scriptId, action: "SHARE", notificationState: "SENT", scriptVersionId: { not: r.scriptVersionId }, createdAt: { lt: r.createdAt } } });
        if (earlier > 0) updated.push(v.title); else titles.push(v.title);
      }
      titles = [...new Set(titles)]; updated = [...new Set(updated)].filter((t) => !titles.includes(t));
      if (titles.length === 0 && updated.length === 0) {
        await prisma.programReminder.update({ where: { id: n.id }, data: { state: "CANCELLED", suppressionReason: "nothing_shared", lastError: "every script in this batch was pulled back before the email went out", leaseUntil: null, leaseBy: null } });
        out.notes.push(`${n.id}: cancelled (nothing left to share)`);
        continue;
      }
      if (titles.length === 0) { titles = updated; updated = []; }
    } else {
      const svId = readStrategyVersionId(n.evaluatedStateJson);
      const sv = svId ? await prisma.contentStrategyVersion.findUnique({ where: { id: svId }, select: { status: true, releasedAt: true } }) : null;
      if (!sv || sv.status !== "APPROVED" || !sv.releasedAt) { await suppress("not_released", "the strategy version is no longer approved and released"); continue; }
    }
    // Recipient + link.
    const seats = await prisma.clientMembership.findMany({ where: { enrollmentId: e.id, revokedAt: null }, select: { id: true, clientUserId: true, role: true }, orderBy: { invitedAt: "asc" } });
    const seat = seats.find((s) => s.role === "OWNER") ?? seats[0] ?? null;
    const seatUser = seat ? await prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { email: true, status: true } }) : null;
    const email = seatUser && seatUser.status !== "DISABLED" ? seatUser.email : (client.email ?? "").trim().toLowerCase();
    if (!email) { await suppress("no_recipient", "no email address on the portal seat or the client record"); continue; }
    if (isTest && !isStaffControlledEmail(email)) { await suppress("test_client_real_address", `TEST client's address ${maskToRef("email", email)} is not staff-controlled`); continue; }
    const link = await resolvePortalLink(e, seat ? { membershipId: seat.id, clientUserId: seat.clientUserId } : null, opts.byAppUserId ?? null, now);
    if (!link) { await suppress("no_portal_link", "no portal link could be produced (no seat, no token)"); continue; }
    const vars: TemplateVars = {
      firstName: firstNameOf(client.name), month: n.monthKey ? monthName(n.monthKey) : "this month", portalLink: link.url, bookCallLink: null, noCallEligible: false, answersStarted: false,
      sessionNote: null, earliestSession: null, itemCount: titles.length, titles, updatedTitles: updated, deadline: null,
    };
    const body = renderReminder(reminderTemplate(n.templateKey), vars);
    await prisma.programReminder.update({ where: { id: n.id }, data: { toRef: email, evaluatedStateJson: JSON.stringify({ ...(readJson(n.evaluatedStateJson)), titles, updated, portalLinkKind: link.kind }) } });
    const key = n.action === "SCRIPTS_READY" ? scriptShareKey(n.id) : strategyReadyKey(n.id);
    const r = await sendThroughOutbox({ channel: "email", toRef: email, body, dedupeKey: key, clientId: e.clientId, requestedBy: opts.requestedBy ?? "share-drain" }, { workerId: leaseBy });
    const rec = await recordSendResult(n.id, r, now);
    const relState = rec.outcome === "sent" ? "SENT" : rec.outcome === "failed" ? "FAILED" : "QUEUED";
    await prisma.contentScriptRelease.updateMany({ where: { reminderId: n.id }, data: { notificationState: relState, outboxMessageId: r.id || null, note: rec.outcome === "sent" ? `Emailed to ${maskToRef("email", email)} (${titles.length + updated.length} script(s) in one message).` : `Email ${rec.outcome}: ${rec.detail} — the approval and the portal release stand; the email retries on its own.` } });
    if (rec.outcome === "sent") out.sent++; else if (rec.outcome === "failed") out.failed++; else out.unknown++;
    out.notes.push(`${n.id}: ${rec.outcome} (${rec.detail})`);
  }
  return out;
}

function readJson(s: string | null | undefined): Record<string, unknown> { try { const v = JSON.parse(s ?? "{}"); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } }
function readStrategyVersionId(s: string | null | undefined): string | null { const v = readJson(s).strategyVersionId; return typeof v === "string" ? v : null; }

/** What the Scripts queue shows beside a script: the state of its share email, in words. */
export async function shareStateFor(scriptId: string): Promise<{ shared: boolean; email: string; detail: string | null }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { sharedVersionId: true } });
  if (!s?.sharedVersionId) return { shared: false, email: "none", detail: null };
  const rel = await latestShareRelease(s.sharedVersionId);
  if (!rel) return { shared: true, email: "none", detail: null };
  return { shared: true, email: rel.notificationState.toLowerCase(), detail: rel.note };
}

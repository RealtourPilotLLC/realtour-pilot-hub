"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { getSetting, putSetting } from "@/lib/settings";
import { listEventTypes, isCallPurpose, type CallPurpose, type CalendlyEventType } from "@/lib/integrations/calendly";
import { getAutomation, type AutomationKey } from "@/lib/programAutomation";
import {
  callRecordRules, CALL_RULES_KEY, DEFAULT_CALL_RULES, type CallRecordRules,
  syncCallRecordsFromCalendly, linkCalendarEvents, discoverTranscriptSources, sweepUnlinkedDriveTranscripts, reconcileCallReviewTasks,
  listCallRecords, callReviewQueue, type CallRecordView,
  confirmCallRecordClient, ignoreCallRecord, setCallRecordTargetMonth, confirmTranscriptSource, rejectTranscriptSource,
  verifyClientEmailAlias, dismissClientEmailAlias, attachPastedTranscript,
} from "@/lib/contentCallRecords";
import { transcriptJobsSnapshot, transcriptQueueBatch, transcriptJobHold, enqueueTranscriptJob, isTranscriptJobKind, BACKLOG_FIELD, FIRST_ON_FIELD, INCLUDE_BACKLOG, type TranscriptQueueBatch } from "@/lib/transcriptJobs";

// ---------------------------------------------------------------------------
// Settings → Calendly & calls (spec §26). Reads: owner or admin (the page's
// own gate). Writes: OWNER ONLY — a mapping decides which bookings become
// program work, and Jordan asked that nobody else flips that.
// ---------------------------------------------------------------------------

type R = { ok: boolean; message: string };
const fail = (e: unknown): R => ({ ok: false, message: e instanceof Error ? e.message : "Failed." });
async function owner(): Promise<string | null> {
  await requireOwner();
  return (await getCurrentUser().catch(() => null))?.email ?? null;
}

export type MappingRow = {
  id: string; eventTypeUri: string; eventName: string; publicUrl: string | null; purpose: string; enabled: boolean;
  validationStatus: string; validatedAt: Date | null; lastSyncedAt: Date | null; lastError: string | null;
};
export type CalendlyPanelState = {
  connected: boolean;
  connectionLabel: string | null;
  lastSyncedAt: Date | null;
  driveLastSyncedAt: Date | null;
  fetchError: string | null;
  eventTypes: (CalendlyEventType & { mapping: MappingRow | null })[];
  /** Mappings whose event type is no longer on the account (deleted / recreated → needs a verified update). */
  orphanMappings: MappingRow[];
  monthlyMapped: boolean;
  discoveryMapped: boolean;
  /** An event type that LOOKS like the brand-discovery one exists on the account (by name) — mapped or not. */
  discoveryTypeExists: boolean;
  switches: { key: AutomationKey; enabled: boolean; missing: boolean; lastRunAt: Date | null; lastError: string | null }[];
  rules: CallRecordRules;
  records: CallRecordView[];
  reviewRecords: CallRecordView[];
  queue: Awaited<ReturnType<typeof callReviewQueue>>;
  jobs: Awaited<ReturnType<typeof transcriptJobsSnapshot>>;
  /**
   * What the call processor would face now (R05, Sep 28 2026): by kind, by
   * requester, by client with its tier, the backlog it skips, what is
   * runnable. The driver's own hold rule, read-only. null if it could not be read.
   */
  batch: TranscriptQueueBatch | null;
  enrolledClients: { id: string; name: string }[];
};

export async function loadCalendlyPanelState(): Promise<CalendlyPanelState> {
  await requireAdmin();
  const [conn, gmail, mappings, switches, rules, records, reviewRecords, queue, jobs, batch, enrollments] = await Promise.all([
    prisma.connection.findUnique({ where: { provider: "calendly" } }),
    prisma.connection.findUnique({ where: { provider: "gmail" }, select: { lastSyncedAt: true } }),
    prisma.programCalendlyEventMapping.findMany({ orderBy: { createdAt: "asc" } }),
    Promise.all((["transcript_jobs", "session_booking", "strategy_generation"] as AutomationKey[]).map(getAutomation)),
    callRecordRules(),
    listCallRecords({ limit: 15 }),
    listCallRecords({ limit: 30, onlyReview: true }),
    callReviewQueue(),
    transcriptJobsSnapshot(),
    transcriptQueueBatch().catch(() => null),
    prisma.contentEnrollment.findMany({ select: { clientId: true } }),
  ]);
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const connected = conn?.status === "CONNECTED" && !!conn.secretEncrypted;
  let types: CalendlyEventType[] = [];
  let fetchError: string | null = null;
  if (connected) {
    try { types = await listEventTypes(); } catch (e) { fetchError = e instanceof Error ? e.message : "Could not list Calendly event types."; }
  }
  const byUri = new Map(mappings.map((m) => [m.eventTypeUri, m]));
  const rows = types.map((t) => ({ ...t, mapping: byUri.get(t.uri) ?? null }));
  const seen = new Set(types.map((t) => t.uri));
  const orphanMappings = fetchError ? [] : mappings.filter((m) => !seen.has(m.eventTypeUri));
  const enabled = mappings.filter((m) => m.enabled);
  return {
    connected, connectionLabel: conn?.accountLabel ?? null, lastSyncedAt: conn?.lastSyncedAt ?? null, driveLastSyncedAt: gmail?.lastSyncedAt ?? null, fetchError,
    eventTypes: rows, orphanMappings,
    monthlyMapped: enabled.some((m) => m.purpose === "MONTHLY_STRATEGY"),
    discoveryMapped: enabled.some((m) => m.purpose === "BRAND_DISCOVERY"),
    // Jordan's type does not exist yet; when he creates it ("Content Program:
    // Brand Discovery" or similar) the panel must say "map it", not "create it".
    // A name heuristic only decides which HINT shows — classification stays by URI.
    discoveryTypeExists: types.some((t) => /brand/i.test(`${t.name} ${t.slug ?? ""}`) && /discover/i.test(`${t.name} ${t.slug ?? ""}`)),
    switches: switches.map((s) => ({ key: s.key, enabled: s.enabled, missing: s.missing, lastRunAt: s.lastRunAt, lastError: s.lastError })),
    rules, records, reviewRecords, queue, jobs, batch, enrolledClients: clients,
  };
}

/** The call processor's batch on its own — the switch-on confirm reads it before the owner says yes. */
export async function loadTranscriptQueueBatch(): Promise<TranscriptQueueBatch | { error: string }> {
  try { await requireAdmin(); } catch (e) { return { error: fail(e).message }; }
  try { return await transcriptQueueBatch(); } catch (e) { return { error: `The transcript queue could not be read (${fail(e).message}).` }; }
}

/**
 * THE BACKLOG CHOICE (R05, Sep 28 2026 — business default: when the call
 * processor is first switched on it takes ONLY jobs queued after that moment).
 *   "include" — also process the jobs queued before it (spends AI credit on
 *               older calls; the count is shown before this is pressed);
 *   "skip"    — back to the default: jobs queued before the FIRST switch-on
 *               are skipped. The first switch-on is its own field
 *               (FIRST_ON_FIELD, written once by the processor), and "skip"
 *               restores the cutoff to it (review fix, Sep 28 2026: clearing
 *               the field fell back to the LATEST switch-on, which moves on
 *               every off/on, and quietly skipped the jobs queued between).
 * One config field, under the switch's own advisory lock and audited
 * (setAutomationConfigField); the switch's on/off is never touched here.
 */
export async function setTranscriptBacklogAction(choice: "include" | "skip"): Promise<R> {
  try {
    const by = await owner();
    if (choice !== "include" && choice !== "skip") return { ok: false, message: "Choose include or skip." };
    const before = await transcriptQueueBatch();
    const { setAutomationConfigField } = await import("@/lib/programAutomation");
    // Keep the first switch-on before "include" overwrites the pinned cutoff
    // (a value pinned before FIRST_ON_FIELD existed is that moment).
    const first = before.backlog.firstSwitchedOnAt ?? (before.backlog.source === "pinned" ? before.backlog.cutoff : null);
    if (!before.backlog.firstSwitchedOnAt && first) {
      await setAutomationConfigField("transcript_jobs", FIRST_ON_FIELD, first.toISOString(), by ?? "owner", "transcript_first_switch_on");
    }
    await setAutomationConfigField("transcript_jobs", BACKLOG_FIELD, choice === "include" ? INCLUDE_BACKLOG : first ? first.toISOString() : null, by ?? "owner", "transcript_backlog_choice");
    revalidatePath("/settings");
    const after = await transcriptQueueBatch();
    return {
      ok: true,
      message: choice === "include"
        ? `The call processor will also work through the ${before.heldBacklog} job${before.heldBacklog === 1 ? "" : "s"} queued before it was switched on (${after.runnableNow} runnable now, five per hourly run, each AI job spends credit${after.heldScope ? `; ${after.heldScope} for clients outside the rollout still wait` : ""}).`
        : `The call processor will skip jobs queued before it was first switched on${first ? ` (${first.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""}${after.heldBacklog ? ` — ${after.heldBacklog} skipped now` : ""}. Nothing already processed is undone.`,
    };
  } catch (e) { return fail(e); }
}

/**
 * Map one of the account's event types to a purpose. The URI is verified
 * against the live account at save time (name + slug + active recorded), so a
 * renamed type keeps working (classification is by URI) and a deleted one
 * shows MISSING until a person re-maps it — never a title match.
 */
export async function saveCalendlyMapping(input: { eventTypeUri: string; purpose: string; enabled: boolean }): Promise<R> {
  try {
    const by = await owner();
    if (!isCallPurpose(input.purpose)) throw new Error("Pick a purpose.");
    const purpose: CallPurpose = input.purpose;
    const types = await listEventTypes();
    const live = types.find((t) => t.uri === input.eventTypeUri);
    if (!live) throw new Error("That event type is not on the connected Calendly account.");
    // One enabled type per program purpose: two "monthly" types would make
    // the target-month rule and the panel ambiguous.
    if (input.enabled && purpose !== "IGNORED") {
      const clash = await prisma.programCalendlyEventMapping.findFirst({ where: { purpose, enabled: true, eventTypeUri: { not: input.eventTypeUri } }, select: { eventName: true } });
      if (clash) throw new Error(`"${clash.eventName}" is already the ${purpose === "MONTHLY_STRATEGY" ? "monthly strategy" : "brand discovery"} type — disable it first.`);
    }
    const now = new Date();
    await prisma.programCalendlyEventMapping.upsert({
      where: { eventTypeUri: input.eventTypeUri },
      create: {
        eventTypeUri: input.eventTypeUri, eventName: live.name, publicUrl: live.schedulingUrl, purpose, enabled: input.enabled,
        hostUri: live.ownerUri, validationStatus: live.active ? "VALID" : "MISSING", validatedAt: now, createdBy: by,
      },
      update: { eventName: live.name, publicUrl: live.schedulingUrl, purpose, enabled: input.enabled, hostUri: live.ownerUri, validationStatus: live.active ? "VALID" : "MISSING", validatedAt: now, lastError: live.active ? null : "event type is inactive in Calendly" },
    });
    revalidatePath("/settings");
    return { ok: true, message: input.enabled ? `Mapped "${live.name}" — bookings on it are classified by its URI from the next hourly run.` : `Saved "${live.name}" (disabled).` };
  } catch (e) { return fail(e); }
}

/**
 * "Not part of the program" on a row that HAS a mapping: the mapping row goes
 * away (it is configuration, not a record — the call records it classified
 * keep their mappingId as history). Bookings on that type are simply outside
 * the program again from the next run; with no enabled program mapping left,
 * the legacy sweeps resume as before.
 */
export async function removeCalendlyMapping(eventTypeUri: string): Promise<R> {
  try {
    await owner();
    const row = await prisma.programCalendlyEventMapping.findUnique({ where: { eventTypeUri }, select: { id: true, eventName: true } });
    if (!row) return { ok: true, message: "That type was not mapped." };
    await prisma.programCalendlyEventMapping.delete({ where: { id: row.id } });
    revalidatePath("/settings");
    return { ok: true, message: `"${row.eventName}" is no longer part of the program.` };
  } catch (e) { return fail(e); }
}

/** Re-check every mapping against the account: VALID / RENAMED (name updated) / MISSING. */
export async function revalidateCalendlyMappings(): Promise<R> {
  try {
    await owner();
    const [types, mappings] = await Promise.all([listEventTypes(), prisma.programCalendlyEventMapping.findMany()]);
    const byUri = new Map(types.map((t) => [t.uri, t]));
    const now = new Date();
    let renamed = 0, missing = 0;
    for (const m of mappings) {
      const live = byUri.get(m.eventTypeUri);
      if (!live) {
        missing++;
        await prisma.programCalendlyEventMapping.update({ where: { id: m.id }, data: { validationStatus: "MISSING", validatedAt: now, lastError: "event type no longer on the account — recreate it in Calendly and map the NEW one (URIs change)" } });
        continue;
      }
      const wasRenamed = live.name !== m.eventName;
      if (wasRenamed) renamed++;
      await prisma.programCalendlyEventMapping.update({
        where: { id: m.id },
        data: { eventName: live.name, publicUrl: live.schedulingUrl, validationStatus: live.active ? (wasRenamed ? "RENAMED" : "VALID") : "MISSING", validatedAt: now, lastError: live.active ? null : "event type is inactive in Calendly" },
      });
    }
    revalidatePath("/settings");
    return { ok: true, message: `Checked ${mappings.length} mapping(s): ${renamed} renamed (still classified by URI), ${missing} missing.` };
  } catch (e) { return fail(e); }
}

/** Run the whole chain now (read-only against Calendly / Google; writes only hub rows). */
export async function runCallSyncNow(): Promise<R & { detail?: Record<string, unknown> }> {
  try {
    await owner();
    const bookings = await syncCallRecordsFromCalendly();
    if ("skipped" in bookings) return { ok: false, message: bookings.skipped };
    const calendar = await linkCalendarEvents({ max: 30 });
    const transcripts = await discoverTranscriptSources({ max: 40 });
    const unlinked = await sweepUnlinkedDriveTranscripts({ sinceDays: 45, max: 10 });
    const review = await reconcileCallReviewTasks();
    revalidatePath("/settings");
    return {
      ok: true,
      message: `Bookings: ${bookings.created} new, ${bookings.updated} updated, ${bookings.matched} matched, ${bookings.review} for review. Calendar: ${calendar.linked} linked. Transcripts: ${"skipped" in transcripts ? transcripts.skipped : `${transcripts.confirmed} confirmed, ${transcripts.candidates} candidates, ${transcripts.exceptions} exceptions`}.`,
      detail: { bookings, calendar, transcripts, unlinked, review },
    };
  } catch (e) { return fail(e); }
}

export async function saveCallRules(input: Partial<CallRecordRules>): Promise<R> {
  try {
    const by = await owner();
    const cur = await getSetting<Partial<CallRecordRules>>(CALL_RULES_KEY, {});
    const next: Partial<CallRecordRules> = { ...cur };
    if (input.nextMonthFromDay != null) next.nextMonthFromDay = Math.min(31, Math.max(1, Math.round(input.nextMonthFromDay)));
    if (input.transcriptGraceHours != null) next.transcriptGraceHours = Math.min(240, Math.max(1, Math.round(input.transcriptGraceHours)));
    if (input.startToleranceMinutes != null) next.startToleranceMinutes = Math.min(120, Math.max(1, Math.round(input.startToleranceMinutes)));
    if (Array.isArray(input.planNextMonthEventTypeUris)) next.planNextMonthEventTypeUris = input.planNextMonthEventTypeUris.filter((x): x is string => typeof x === "string");
    await putSetting(CALL_RULES_KEY, { ...DEFAULT_CALL_RULES, ...next }, by);
    revalidatePath("/settings");
    return { ok: true, message: "Call rules saved — they apply on the next sync." };
  } catch (e) { return fail(e); }
}

// ---- Review-queue decisions (owner) ----------------------------------------
export async function confirmCallClient(recordId: string, clientId: string, verifyAlias: boolean): Promise<R> {
  try { const by = await owner(); await confirmCallRecordClient(recordId, clientId, by, { verifyInviteeEmailAsAlias: verifyAlias }); revalidatePath("/settings"); return { ok: true, message: "Client confirmed — the call is filed and its transcript will be looked for on the next run." }; }
  catch (e) { return fail(e); }
}
export async function ignoreCall(recordId: string, note?: string): Promise<R> {
  try { const by = await owner(); await ignoreCallRecord(recordId, by, note); revalidatePath("/settings"); return { ok: true, message: "Ignored — it stays on file as unrelated." }; }
  catch (e) { return fail(e); }
}
export async function retargetCall(recordId: string, monthKey: string): Promise<R> {
  try { const by = await owner(); await setCallRecordTargetMonth(recordId, monthKey, by); revalidatePath("/settings"); return { ok: true, message: `Call now plans ${monthKey}.` }; }
  catch (e) { return fail(e); }
}
export async function confirmTranscript(sourceId: string, recordId: string): Promise<R> {
  try { const by = await owner(); await confirmTranscriptSource(sourceId, recordId, by); revalidatePath("/settings"); return { ok: true, message: "Transcript attached — INGEST + ANALYZE queued (they run when transcript jobs are switched on)." }; }
  catch (e) { return fail(e); }
}
export async function rejectTranscript(sourceId: string): Promise<R> {
  try { const by = await owner(); await rejectTranscriptSource(sourceId, by); revalidatePath("/settings"); return { ok: true, message: "Rejected." }; }
  catch (e) { return fail(e); }
}
export async function pasteTranscript(recordId: string, text: string): Promise<R> {
  try { const by = await owner(); await attachPastedTranscript(recordId, text, by, "paste"); revalidatePath("/settings"); return { ok: true, message: "Transcript saved and queued." }; }
  catch (e) { return fail(e); }
}
export async function verifyAlias(aliasId: string): Promise<R> {
  try { const by = await owner(); await verifyClientEmailAlias(aliasId, by); revalidatePath("/settings"); return { ok: true, message: "Alias verified — bookings from that address now match this client." }; }
  catch (e) { return fail(e); }
}
export async function dismissAlias(aliasId: string): Promise<R> {
  try { await owner(); await dismissClientEmailAlias(aliasId); revalidatePath("/settings"); return { ok: true, message: "Dismissed." }; }
  catch (e) { return fail(e); }
}
/** What a Re-run will actually do, in the driver's own terms. */
function rerunWords(state: string, h: Awaited<ReturnType<typeof transcriptJobHold>>): string {
  if (state !== "QUEUED") return `Not re-queued: the job is ${state.toLowerCase()} (it is re-run only once it has finished, failed or been cancelled).`;
  if (!h) return "Re-queued. Whether it runs on the next hourly run could not be checked just now.";
  if (h.hold) {
    const why = h.hold.reason.replace(/^waiting: /, "");
    const fix = h.hold.kind === "scope" ? " (add the client to the pilot to run it)" : h.hold.kind === "owner" ? " (switch it on to run it)" : "";
    return `Re-queued, but it waits: ${why}${fix}.`;
  }
  if (!h.processorOn) return "Re-queued, but it waits: Transcript processing is off, so the call processor does not run. It runs on the first hourly run after you switch it on.";
  if (!h.aiRunsOn && h.kind !== "INGEST") return "Re-queued, but it waits: AI runs is off, and a queued job spends AI credit only while it is on.";
  return "Re-queued. It runs on the next hourly run of the call processor.";
}

export async function rerunTranscriptJob(jobId: string): Promise<R> {
  try {
    const by = await owner();
    const j = await prisma.programTranscriptJob.findUnique({ where: { id: jobId }, select: { kind: true, callRecordId: true, transcriptSourceId: true, enrollmentId: true } });
    if (!j || !isTranscriptJobKind(j.kind)) throw new Error("Job not found.");
    const q = await enqueueTranscriptJob({ callRecordId: j.callRecordId, kind: j.kind, transcriptSourceId: j.transcriptSourceId, enrollmentId: j.enrollmentId, requestedBy: by, rerun: true });
    revalidatePath("/settings");
    // R05: a queued run is unattended now, whoever asked for it, so the
    // re-run waits for AI runs like every other queued job. And ONLY a job
    // nothing holds is promised the next run (review fix, Sep 28 2026): the
    // same hold rule the driver uses decides the sentence.
    return { ok: true, message: rerunWords(q.state, await transcriptJobHold(q.id).catch(() => null)) };
  } catch (e) { return fail(e); }
}

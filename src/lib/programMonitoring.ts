import "server-only";
import { prisma } from "@/lib/prisma";
import { allAutomations, type AutomationState } from "@/lib/programAutomation";
import { getSetting, putSetting } from "@/lib/settings";
import { etAt, etDayKey } from "@/lib/datetime";
import { importReviewItems, type ReviewItem } from "@/lib/contentImport";

// ---------------------------------------------------------------------------
// MONITORING (spec §13 / §20 / §24). Read-only views over the durable job
// rows every automation leaves behind: the AI run ledger and quota use, and
// the ONE list of failed automations that both /content/monitoring and the
// overview's "Failed automation" filter read — so a failure a driver
// recorded can never be visible in one place and hidden in the other.
// Nothing here runs, retries or mutates; actions live beside the page.
// ---------------------------------------------------------------------------

export type AiRunRow = {
  id: string; kind: string; clientName: string | null; enrollmentId: string | null; promptKey: string; promptVersion: string | null; model: string | null;
  policyVersionNo: number | null; strategyVersionNo: number | null; status: string; disposition: string; dispositionBy: string | null; requestedBy: string | null;
  inputTokens: number | null; outputTokens: number | null; costCents: number | null; outputRef: string | null; error: string | null; attempts: number; createdAt: Date; finishedAt: Date | null;
};

export async function aiRunLedger(opts: { take?: number; enrollmentId?: string; status?: string } = {}): Promise<AiRunRow[]> {
  const rows = await prisma.programAiRun.findMany({
    where: { ...(opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" }, take: opts.take ?? 80,
  });
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const [clients, policies, strategies] = await Promise.all([
    clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    prisma.programGenerationPolicyVersion.findMany({ select: { id: true, versionNo: true } }),
    prisma.contentStrategyVersion.findMany({ where: { id: { in: rows.map((r) => r.strategyVersionId).filter((x): x is string => !!x) } }, select: { id: true, versionNo: true } }),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, clientName: r.clientId ? nameOf.get(r.clientId) ?? null : null, enrollmentId: r.enrollmentId, promptKey: r.promptKey, promptVersion: r.promptVersion, model: r.model,
    policyVersionNo: policies.find((p) => p.id === r.policyVersionId)?.versionNo ?? null, strategyVersionNo: strategies.find((s) => s.id === r.strategyVersionId)?.versionNo ?? null,
    status: r.status, disposition: r.disposition, dispositionBy: r.dispositionBy, requestedBy: r.requestedBy, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costCents: r.costCents,
    outputRef: r.outputRef, error: r.error, attempts: r.attempts, createdAt: r.createdAt, finishedAt: r.finishedAt,
  }));
}

export type QuotaUse = {
  quotas: { id: string; scope: string; scopeRef: string; period: string; maxRuns: number | null; maxCostCents: number | null; enabled: boolean }[];
  today: { runs: number; costCents: number };
  month: { runs: number; costCents: number };
  byKindMonth: { kind: string; runs: number; costCents: number }[];
};

/** What has been spent against the configured quotas (a limit you cannot see your position against is a number, not a control). */
export async function aiQuotaUse(): Promise<QuotaUse> {
  const now = new Date();
  // ET day/month boundaries: the quota period the ai.ts wrapper enforces is
  // ET-based like everything else. Via the house helpers, NOT a literal
  // "-04:00" — that offset is EDT only, so from November to March a hardcoded
  // day start lands four hours early and "today's" AI spend quietly includes
  // the tail of yesterday (and "this month" the tail of last month).
  // etAt for BOTH, so the two boundaries are built the same way and land on
  // an exact wall-clock midnight (etDayStartUtc carries the caller's
  // milliseconds, which would shave the first fraction of a second off "today").
  const today = etDayKey(now);
  const dayStart = etAt(today, 0);
  const monthStart = etAt(`${today.slice(0, 7)}-01`, 0);
  const [quotas, todayRows, monthRows] = await Promise.all([
    prisma.programAiQuota.findMany({ orderBy: [{ scope: "asc" }, { period: "asc" }] }),
    prisma.programAiRun.findMany({ where: { createdAt: { gte: dayStart } }, select: { costCents: true } }),
    prisma.programAiRun.findMany({ where: { createdAt: { gte: monthStart } }, select: { kind: true, costCents: true } }),
  ]);
  const sum = (rows: { costCents: number | null }[]) => rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
  const byKind = new Map<string, { runs: number; costCents: number }>();
  for (const r of monthRows) { const k = byKind.get(r.kind) ?? { runs: 0, costCents: 0 }; k.runs++; k.costCents += r.costCents ?? 0; byKind.set(r.kind, k); }
  return {
    quotas: quotas.map((q) => ({ id: q.id, scope: q.scope, scopeRef: q.scopeRef, period: q.period, maxRuns: q.maxRuns, maxCostCents: q.maxCostCents, enabled: q.enabled })),
    today: { runs: todayRows.length, costCents: sum(todayRows) }, month: { runs: monthRows.length, costCents: sum(monthRows) },
    byKindMonth: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.costCents - a.costCents),
  };
}

// ---- failed automations -------------------------------------------------------------------

export type FailedAutomation = {
  /** which subsystem */
  kind: "transcript_job" | "ai_run" | "reminder" | "session_booking" | "session_address" | "call_record" | "automation" | "publishing" | "cut_transcript";
  ref: string; enrollmentId: string | null; clientId: string | null; monthId: string | null;
  title: string; error: string; at: Date; retryable: boolean; href: string;
};

/**
 * Every automation that has recorded a failure or asked for a person, newest
 * first. Filtered by enrollment for the overview; global for the monitoring
 * page. "Failure" means the driver said so — a QUEUED job waiting for its
 * switch is not a failure and is not listed here.
 */
export async function failedAutomations(opts: { sinceDays?: number; take?: number } = {}): Promise<FailedAutomation[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 864e5);
  const [jobs, runs, reminders, sessions, calls, switches, pubs, cuts, addresses] = await Promise.all([
    prisma.programTranscriptJob.findMany({ where: { state: { in: ["FAILED", "NEEDS_REVIEW"] }, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.programAiRun.findMany({ where: { status: { in: ["FAILED", "QUOTA_BLOCKED"] }, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, kind: true, enrollmentId: true, clientId: true, error: true, errorAt: true, updatedAt: true, status: true, scopeJson: true } }),
    prisma.programReminder.findMany({ where: { state: { in: ["FAILED", "BOUNCED"] }, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, enrollmentId: true, clientId: true, monthId: true, action: true, lastError: true, outcome: true, updatedAt: true } }),
    // CP-04: every state in which the booking adapter stopped and handed the
    // request to a person — not only FAILED, which it never writes.
    prisma.programSessionRequest.findMany({ where: { status: { in: ["REQUESTED", "CONFIRMED", "CANCEL_REQUESTED"] }, bookingState: { in: [...BOOKING_NEEDS_PERSON] }, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, enrollmentId: true, clientId: true, monthId: true, lastError: true, updatedAt: true, bookingState: true } }),
    prisma.programCallRecord.findMany({ where: { OR: [{ lastError: { not: null } }, { transcriptState: { in: ["FAILED", "NEEDS_REVIEW"] } }], updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, enrollmentId: true, clientId: true, monthId: true, lastError: true, transcriptState: true, matchState: true, updatedAt: true, scheduledStart: true } }),
    allAutomations(),
    prisma.programPublishingJob.findMany({ where: { state: "FAILED", updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, enrollmentId: true, clientId: true, lastError: true, updatedAt: true } }).catch(() => []),
    prisma.contentCutTranscript.findMany({ where: { status: "FAILED", updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, submissionId: true, lastError: true, updatedAt: true } }).catch(() => []),
    // CP-05: an exact address that did not reach the booking is a failure a
    // person owns — never a quiet "saved".
    prisma.programSessionAddress.findMany({ where: { syncState: { in: ["FAILED", "CONFLICT", "UNKNOWN"] }, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, enrollmentId: true, clientId: true, monthId: true, syncState: true, lastError: true, updatedAt: true } }).catch(() => []),
  ]);
  const out: FailedAutomation[] = [];
  for (const j of jobs) out.push({ kind: "transcript_job", ref: j.id, enrollmentId: j.enrollmentId, clientId: null, monthId: null, title: `${j.kind} transcript job ${j.state === "NEEDS_REVIEW" ? "needs a person" : "failed"}`, error: j.reviewReason ?? j.lastError ?? "no detail recorded", at: j.lastErrorAt ?? j.updatedAt, retryable: j.state === "FAILED", href: "/content/monitoring#transcripts" });
  for (const r of runs) out.push({ kind: "ai_run", ref: r.id, enrollmentId: r.enrollmentId, clientId: r.clientId, monthId: monthIdOf(r.scopeJson), title: `AI run ${r.kind} ${r.status === "QUOTA_BLOCKED" ? "blocked by quota" : "failed"}`, error: r.error ?? "no detail recorded", at: r.errorAt ?? r.updatedAt, retryable: false, href: "/content/monitoring#ai-runs" });
  for (const r of reminders) out.push({ kind: "reminder", ref: r.id, enrollmentId: r.enrollmentId, clientId: r.clientId, monthId: r.monthId, title: `Reminder ${r.action} ${r.outcome ?? "failed"}`, error: r.lastError ?? r.outcome ?? "no detail recorded", at: r.updatedAt, retryable: true, href: "/content/monitoring#reminders" });
  for (const s of sessions) out.push({ kind: "session_booking", ref: s.id, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId, title: `Session booking needs a person (${s.bookingState.toLowerCase()})`, error: s.lastError ?? "no detail recorded", at: s.updatedAt, retryable: s.bookingState !== "MISMATCH", href: `/content/${s.enrollmentId}#sessions` });
  for (const a of addresses) out.push({ kind: "session_address", ref: a.id, enrollmentId: a.enrollmentId, clientId: a.clientId, monthId: a.monthId, title: a.syncState === "UNKNOWN" ? "Filming address update unconfirmed" : "Filming address not on the booking", error: a.lastError ?? a.syncState.toLowerCase(), at: a.updatedAt, retryable: false, href: `/content/${a.enrollmentId}#sessions` });
  for (const c of calls) out.push({ kind: "call_record", ref: c.id, enrollmentId: c.enrollmentId, clientId: c.clientId, monthId: c.monthId, title: c.transcriptState === "NEEDS_REVIEW" ? "Call transcript needs a person" : c.transcriptState === "FAILED" ? "Call transcript processing failed" : "Call record error", error: c.lastError ?? `transcript ${c.transcriptState.toLowerCase()}, match ${c.matchState.toLowerCase()}`, at: c.updatedAt, retryable: c.transcriptState === "FAILED", href: "/content/monitoring#calls" });
  for (const s of switches) if (s.lastError && s.lastErrorAt && s.lastErrorAt >= since) out.push({ kind: "automation", ref: s.key, enrollmentId: null, clientId: null, monthId: null, title: `Automation "${s.key}" last run failed`, error: s.lastError, at: s.lastErrorAt, retryable: false, href: "/settings#program-automations" });
  for (const p of pubs) out.push({ kind: "publishing", ref: p.id, enrollmentId: p.enrollmentId, clientId: p.clientId, monthId: null, title: "Publishing job failed", error: p.lastError ?? "no detail recorded", at: p.updatedAt, retryable: true, href: "/content/monitoring" });
  for (const c of cuts) out.push({ kind: "cut_transcript", ref: c.id, enrollmentId: null, clientId: null, monthId: null, title: `Cut transcript failed (cut ${c.submissionId.slice(0, 8)}…)`, error: c.lastError ?? "no detail recorded", at: c.updatedAt, retryable: true, href: "/content/monitoring" });
  out.sort((a, b) => b.at.getTime() - a.at.getTime());
  return out.slice(0, opts.take ?? 200);
}

function monthIdOf(scopeJson: string | null): string | null {
  try { const s = scopeJson ? (JSON.parse(scopeJson) as { monthId?: string }) : null; return s?.monthId ?? null; } catch { return null; }
}

/** Failures keyed by enrollment (and by month where known) — the overview's filter input. */
export async function failedAutomationIndex(): Promise<{ byEnrollment: Map<string, FailedAutomation[]>; global: FailedAutomation[] }> {
  const all = await failedAutomations({ sinceDays: 30 });
  const byEnrollment = new Map<string, FailedAutomation[]>();
  const global: FailedAutomation[] = [];
  for (const f of all) {
    if (f.enrollmentId) byEnrollment.set(f.enrollmentId, [...(byEnrollment.get(f.enrollmentId) ?? []), f]);
    else global.push(f);
  }
  return { byEnrollment, global };
}

/** The adapter's hand-over states (CP-04): each one means a person looks.
 *  UNKNOWN is not one of them — the adapter is still settling it by readback
 *  (and hands it over as RECONCILE if it cannot); it shows on the stuck card. */
const BOOKING_NEEDS_PERSON = ["FAILED", "RECONCILE", "REJECTED", "MISMATCH"] as const;

/** Session requests by status + the ones whose booking job is stuck, for the reconcile card. */
export async function sessionRequestState(): Promise<{ counts: { status: string; n: number }[]; stuck: { id: string; clientName: string; monthKey: string | null; status: string; bookingState: string; attempts: number; lastError: string | null; updatedAt: Date }[] }> {
  const [grouped, stuck] = await Promise.all([
    prisma.programSessionRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.programSessionRequest.findMany({ where: { OR: [{ bookingState: { in: [...BOOKING_NEEDS_PERSON, "UNKNOWN", "CONFLICT", "ORDER_CREATED", "APPT_PENDING"] } }, { status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"] } }] }, orderBy: { updatedAt: "desc" }, take: 40 }),
  ]);
  const clientIds = [...new Set(stuck.map((s) => s.clientId))];
  const monthIds = [...new Set(stuck.map((s) => s.monthId))];
  const [clients, months] = await Promise.all([
    clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    monthIds.length ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, monthKey: true } }) : [],
  ]);
  return {
    counts: grouped.map((g) => ({ status: g.status, n: g._count._all })),
    stuck: stuck.map((s) => ({ id: s.id, clientName: clients.find((c) => c.id === s.clientId)?.name ?? "?", monthKey: months.find((m) => m.id === s.monthId)?.monthKey ?? null, status: s.status, bookingState: s.bookingState, attempts: s.attempts, lastError: s.lastError, updatedAt: s.updatedAt })),
  };
}

export type { AutomationState };

// ---- the reminder ledger (§24) --------------------------------------------------------------

export type ReminderLedgerRow = {
  id: string; clientName: string; monthKey: string | null; action: string; templateKey: string; channel: string;
  attempt: number; state: string; outcome: string | null; suppressionReason: string | null; manual: boolean;
  nextEligibleAt: Date | null; sentAt: Date | null; lastError: string | null; escalatedTo: string | null; createdAt: Date;
};

/**
 * Every reminder the evaluator has ever written a row for. It is EMPTY today
 * and that is the correct reading: no client reminder has been sent by this
 * system, because the `reminders` switch has never been turned on. The page
 * says exactly that rather than rendering a hopeful placeholder.
 */
export async function reminderLedger(opts: { take?: number; enrollmentId?: string } = {}): Promise<ReminderLedgerRow[]> {
  const rows = await prisma.programReminder.findMany({
    where: opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {},
    orderBy: { createdAt: "desc" }, take: opts.take ?? 100,
  });
  if (rows.length === 0) return [];
  const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id, clientName: nameOf.get(r.clientId) ?? "?", monthKey: r.monthKey, action: r.action, templateKey: r.templateKey, channel: r.channel,
    attempt: r.attempt, state: r.state, outcome: r.outcome, suppressionReason: r.suppressionReason, manual: r.manual,
    nextEligibleAt: r.nextEligibleAt, sentAt: r.sentAt, lastError: r.lastError, escalatedTo: r.escalatedToAppUserId, createdAt: r.createdAt,
  }));
}

/** Import batches + the review items across EVERY client — the program-wide §14 view. */
export async function importOverview(): Promise<{
  batches: { id: string; kind: string; fileName: string | null; clientName: string; mode: string; proposedMonthKey: string | null; appliedAt: Date | null; appliedBy: string | null; items: number; createdAt: Date }[];
  unapplied: number;
}> {
  const batches = await prisma.contentImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 60 });
  if (batches.length === 0) return { batches: [], unapplied: 0 };
  const enrollmentIds = [...new Set(batches.map((b) => b.enrollmentId).filter((x): x is string => !!x))];
  const enrollments = enrollmentIds.length ? await prisma.contentEnrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, clientId: true } }) : [];
  const clients = enrollments.length ? await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } }) : [];
  const counts = await prisma.contentImportItem.groupBy({ by: ["batchId"], where: { batchId: { in: batches.map((b) => b.id) } }, _count: { _all: true } });
  const nameOf = (enrollmentId: string | null) => {
    const e = enrollmentId ? enrollments.find((x) => x.id === enrollmentId) : null;
    return e ? clients.find((c) => c.id === e.clientId)?.name ?? "?" : "—";
  };
  return {
    batches: batches.map((b) => ({
      id: b.id, kind: b.kind, fileName: b.fileName, clientName: nameOf(b.enrollmentId), mode: b.mode,
      proposedMonthKey: b.proposedMonthKey, appliedAt: b.appliedAt, appliedBy: b.appliedBy,
      items: counts.find((c) => c.batchId === b.id)?._count._all ?? 0, createdAt: b.createdAt,
    })),
    unapplied: batches.filter((b) => !b.appliedAt).length,
  };
}

// ---- the program-wide backfill / import review list (§14) -------------------------------------
//
// importReviewItems() answers "what looks mis-filed for THIS client". Jordan
// needs the same question answered across the whole book, with an explicit,
// logged action per item and no auto-fix anywhere. The handled set lives in
// the AppSetting KV rather than a new column (the schema is frozen for this
// wave) — HANDOVER: a ProgramReviewItem table would be the real home.

const HANDLED_KEY = "content_import_review_handled";
export type HandledMark = { by: string; at: string; note: string; action: string };
type HandledMap = Record<string, HandledMark>;

export const reviewItemKey = (enrollmentId: string, r: { kind: string; ref: string }) => `${enrollmentId}:${r.kind}:${r.ref}`;

export async function handledReviewItems(): Promise<HandledMap> {
  return getSetting<HandledMap>(HANDLED_KEY, {});
}

/** Record that a person dealt with a review item. The mark never changes data — it records a judgement. */
export async function markReviewItemHandled(key: string, mark: HandledMark): Promise<void> {
  const map = await handledReviewItems();
  await putSetting<HandledMap>(HANDLED_KEY, { ...map, [key]: mark }, mark.by);
}

export async function unmarkReviewItem(key: string, by: string): Promise<void> {
  const map = await handledReviewItems();
  if (!(key in map)) return;
  const next = { ...map };
  delete next[key];
  await putSetting<HandledMap>(HANDLED_KEY, next, by);
}

export type ProgramReviewItem = Omit<ReviewItem, "kind"> & {
  /** the contentImport kinds, plus the ones only a whole-book read can see */
  kind: ReviewItem["kind"] | "DUPLICATE_CLIENT";
  enrollmentId: string; clientId: string; clientName: string; key: string; handled: HandledMark | null;
};

/** Every client's review items in one list, with what a person already decided about each. */
export async function programReviewItems(): Promise<ProgramReviewItem[]> {
  const [enrollments, handled] = await Promise.all([
    // ENDED enrollments are included ON PURPOSE: a call filed against the
    // wrong client is most likely to sit unnoticed on somebody who stopped
    // (Gary Mercer Sr). Excluding them is how a mis-filed record becomes
    // permanent.
    prisma.contentEnrollment.findMany({ select: { id: true, clientId: true, status: true } }),
    handledReviewItems(),
  ]);
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  // In parallel: importReviewItems is several queries per client and the
  // serial loop made this page take 7 s across the book.
  const perClient = await Promise.all(
    enrollments.map(async (e) => ({ e, items: await importReviewItems(e.id).catch(() => [] as ReviewItem[]) })),
  );
  const out: ProgramReviewItem[] = [];
  for (const { e, items } of perClient) {
    for (const r of items) {
      const key = reviewItemKey(e.id, r);
      out.push({ ...r, enrollmentId: e.id, clientId: e.clientId, clientName: nameOf.get(e.clientId) ?? "?", key, handled: handled[key] ?? null });
    }
  }
  // DUPLICATE CLIENTS. Two enrolled people whose names normalise to the same
  // thing is almost always one person entered twice (the duplicate Rick) —
  // and merging them is never something a program screen should do on its
  // own, so it is raised here as a question for a person.
  // "Rick Schultz(don't use)" and "Rick Schultz" are the same person with a
  // warning taped to one of them — the parenthetical and the usual
  // do-not-use markers come off before the names are compared.
  const norm = (n: string) =>
    n.toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(do ?n.?t use|do not use|old|older|duplicate|dupe|inactive|archived|test account)\b/g, " ")
      .replace(/[^a-z]+/g, " ").trim().replace(/\s+/g, " ");
  // Compared against EVERY client, not only the enrolled ones: the duplicate
  // is usually the record that never got enrolled, which is exactly why work
  // lands on the wrong one (the duplicate Rick).
  const everyClient = await prisma.client.findMany({ select: { id: true, name: true, email: true, createdAt: true } });
  const twins = new Map<string, typeof everyClient>();
  for (const c of everyClient) {
    if (!c.name || c.name.trim().split(/\s+/).length < 2) continue; // a bare first name is not evidence
    const k = norm(c.name);
    twins.set(k, [...(twins.get(k) ?? []), c]);
  }
  for (const e of enrollments) {
    const name = nameOf.get(e.clientId);
    if (!name) continue;
    const group = twins.get(norm(name)) ?? [];
    if (group.length < 2) continue;
    const others = group.filter((g) => g.id !== e.clientId);
    if (others.length === 0) continue;
    const key = `${e.id}:DUPLICATE_CLIENT:${group.map((g) => g.id).sort().join("+")}`;
    out.push({
      kind: "DUPLICATE_CLIENT", monthId: null, monthKey: null, ref: key,
      title: `${group.length} client records share the name "${name}"`,
      detail: `The enrolled record is ${e.clientId}; also on file: ${others.map((o) => `${o.id}${o.email ? ` (${o.email})` : ""}`).join(", ")}. Work booked against the wrong one will never reach this program month. Merging them is a deliberate act on the client record — nothing here does it, and neither record is deleted.`,
      enrollmentId: e.id, clientId: e.clientId, clientName: name, key, handled: handled[key] ?? null,
    });
  }

  // Unhandled first — a decided one stays visible, because "we looked at this
  // and left it" is a different fact from "nobody has looked".
  return out.sort((a, b) => Number(!!a.handled) - Number(!!b.handled) || a.clientName.localeCompare(b.clientName));
}

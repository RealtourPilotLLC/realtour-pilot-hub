import "server-only";
import { prisma } from "@/lib/prisma";
import {
  ENTITLEMENT_LABEL, RECORD_ONLY, isEntitlementKind, isMonthKey, monthName, termOf,
  type EntitlementKind, type EntitlementState, type Term,
} from "@/lib/entitlementsCore";

// ---------------------------------------------------------------------------
// THE CLIENT ENTITLEMENT LEDGER, SERVER HALF (Oct 15 2026). The words and the
// term arithmetic are in entitlementsCore.ts.
//
//   addEntitlement / voidEntitlement / setEntitlementState   the ledger
//   setTerm                    the signed start and end ("YYYY-MM"), ledgered
//                              as a ProgramEnrollmentChange like every
//                              program setting
//   entitlementSummary         what the staff card shows: the term with
//                              extensions and carried months, sessions used /
//                              missed / postponed / still to film, and every
//                              extra still owed
// Nothing here charges, refunds, books or messages anybody.
// ---------------------------------------------------------------------------

type By = string | null;
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export type NewEntitlement = {
  enrollmentId: string;
  kind: string;
  qty?: number;
  monthKey?: string | null;
  targetMonthKey?: string | null;
  description: string;
  agreedBy?: string | null;
  agreedAt?: Date | null;
  source?: string | null;
  sourceRef?: string | null;
  createdBy: By;
};

export async function addEntitlement(e: NewEntitlement): Promise<{ ok: boolean; message: string; id?: string }> {
  if (!isEntitlementKind(e.kind)) return { ok: false, message: "Pick what was agreed." };
  const description = clip(e.description, 1000);
  if (description.length < 3) return { ok: false, message: "Say in a few words what was agreed." };
  const qty = e.qty == null ? 1 : Math.trunc(Number(e.qty));
  if (!Number.isFinite(qty) || qty < 1 || qty > 24) return { ok: false, message: "The number is from 1 to 24." };
  if (e.monthKey && !isMonthKey(e.monthKey)) return { ok: false, message: "Months are written like 2026-07." };
  if (e.targetMonthKey && !isMonthKey(e.targetMonthKey)) return { ok: false, message: "Months are written like 2026-07." };
  const enr = await prisma.contentEnrollment.findUnique({ where: { id: e.enrollmentId }, select: { id: true, clientId: true } });
  if (!enr) return { ok: false, message: "That program no longer exists." };
  const source = ["call", "text", "email", "portal", "staff"].includes(e.source ?? "") ? e.source! : "staff";
  const row = await prisma.programEntitlement.create({
    data: {
      enrollmentId: enr.id, clientId: enr.clientId, kind: e.kind, qty, monthKey: e.monthKey || null, targetMonthKey: e.targetMonthKey || null,
      description, agreedBy: clip(e.agreedBy, 120) || null, agreedAt: e.agreedAt ?? new Date(), source, sourceRef: clip(e.sourceRef, 300) || null,
      state: RECORD_ONLY.has(e.kind) ? "FULFILLED" : "OPEN", fulfilledAt: RECORD_ONLY.has(e.kind) ? new Date() : null,
      createdBy: e.createdBy,
    },
    select: { id: true },
  });
  return { ok: true, message: `Recorded: ${ENTITLEMENT_LABEL[e.kind as EntitlementKind].toLowerCase()}.`, id: row.id };
}

/** Undo: the row stays, marked VOID with who and why. */
export async function voidEntitlement(id: string, by: By, reason: string): Promise<{ ok: boolean; message: string }> {
  const why = clip(reason, 400);
  if (why.length < 3) return { ok: false, message: "Say why it is being undone." };
  const w = await prisma.programEntitlement.updateMany({ where: { id, state: { not: "VOID" } }, data: { state: "VOID", voidedAt: new Date(), voidedBy: by, voidReason: why } });
  return w.count ? { ok: true, message: "Undone. It stays on the record." } : { ok: false, message: "That one is already undone." };
}

/** Mark an owed item scheduled or done (with what fulfilled it), or back to owed. */
export async function setEntitlementState(id: string, state: EntitlementState, by: By, ref?: string | null): Promise<{ ok: boolean; message: string }> {
  if (state === "VOID") return { ok: false, message: "Use Undo for that." };
  const row = await prisma.programEntitlement.findUnique({ where: { id }, select: { state: true } });
  if (!row) return { ok: false, message: "That entry no longer exists." };
  if (row.state === "VOID") return { ok: false, message: "That entry was undone." };
  await prisma.programEntitlement.update({
    where: { id },
    data: state === "FULFILLED"
      ? { state, fulfilledAt: new Date(), fulfilledBy: by, fulfilledRef: clip(ref, 300) || null }
      : { state, fulfilledAt: null, fulfilledBy: null, fulfilledRef: null },
  });
  return { ok: true, message: state === "FULFILLED" ? "Marked done." : state === "SCHEDULED" ? "Marked scheduled." : "Back to owed." };
}

/** The signed term. Either may be cleared (null). Ledgered. */
export async function setTerm(enrollmentId: string, t: { termStartMonth: string | null; termEndMonth: string | null }, by: By): Promise<{ ok: boolean; message: string }> {
  for (const v of [t.termStartMonth, t.termEndMonth]) if (v && !isMonthKey(v)) return { ok: false, message: "Months are written like 2026-07." };
  if (t.termStartMonth && t.termEndMonth && t.termEndMonth < t.termStartMonth) return { ok: false, message: "The term can't end before it starts." };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, termStartMonth: true, termEndMonth: true } });
  if (!e) return { ok: false, message: "That program no longer exists." };
  if (e.termStartMonth === (t.termStartMonth || null) && e.termEndMonth === (t.termEndMonth || null)) return { ok: true, message: "No change." };
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { termStartMonth: t.termStartMonth || null, termEndMonth: t.termEndMonth || null } });
  const { recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const now = new Date();
  for (const [field, from, to] of [["termStartMonth", e.termStartMonth, t.termStartMonth || null], ["termEndMonth", e.termEndMonth, t.termEndMonth || null]] as const) {
    if (from === to) continue;
    // The ledger's field vocabulary is enrollmentChanges.ChangeField; the two
    // term columns are new (Oct 15 2026) and recorded under their own names.
    await recordEnrollmentChange({ enrollmentId, clientId: e.clientId, field: field as unknown as import("@/lib/enrollmentChanges").ChangeField, from, to, effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now, reason: "Agreement term set on the client file." });
  }
  return { ok: true, message: "Term saved." };
}

export type EntitlementRowView = {
  id: string; kind: EntitlementKind; label: string; qty: number; monthKey: string | null; targetMonthKey: string | null;
  description: string; agreedBy: string | null; agreedAtISO: string | null; source: string; state: EntitlementState;
  fulfilledRef: string | null; voidReason: string | null; createdAtISO: string;
};

export type SessionLedger = {
  /** sessions whose date has passed, on the client's live months */
  used: number;
  /** sessions owed by months that ended with nothing done (forfeited) or were skipped without a catch-up */
  missed: number;
  /** live SESSION_POSTPONED entries */
  postponed: number;
  /** sessions still to film: open months' remaining sessions, plus carried and extension months not yet done */
  available: number;
  perMonth: { monthKey: string; label: string; required: number; held: number; booked: number; state: string }[];
};

export type EntitlementSummary = {
  enrollmentId: string;
  term: Term;
  sessions: SessionLedger | null;
  owed: EntitlementRowView[];
  rows: EntitlementRowView[];
  sessionsPerMonth: number;
};

const view = (r: Awaited<ReturnType<typeof prisma.programEntitlement.findMany>>[number]): EntitlementRowView => ({
  id: r.id, kind: (isEntitlementKind(r.kind) ? r.kind : "CREDIT") as EntitlementKind, label: isEntitlementKind(r.kind) ? ENTITLEMENT_LABEL[r.kind] : r.kind,
  qty: r.qty, monthKey: r.monthKey, targetMonthKey: r.targetMonthKey, description: r.description, agreedBy: r.agreedBy,
  agreedAtISO: r.agreedAt?.toISOString() ?? null, source: r.source, state: r.state as EntitlementState, fulfilledRef: r.fulfilledRef,
  voidReason: r.voidReason, createdAtISO: r.createdAt.toISOString(),
});

/** Everything the staff card shows for one program. */
export async function entitlementSummary(enrollmentId: string, opts: { now?: Date; sessions?: boolean } = {}): Promise<EntitlementSummary | null> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, termStartMonth: true, termEndMonth: true, billingMonths: true, sessionsPerMonth: true } });
  if (!e) return null;
  const [rows, months] = await Promise.all([
    prisma.programEntitlement.findMany({ where: { enrollmentId }, orderBy: { createdAt: "asc" } }),
    prisma.contentMonth.findMany({ where: { enrollmentId, historical: false }, orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true, status: true } }),
  ]);
  const term = termOf({ termStartMonth: e.termStartMonth, termEndMonth: e.termEndMonth, billingMonths: e.billingMonths, firstMonthKey: months[0]?.monthKey ?? null }, rows);
  const views = rows.map(view);
  const live = views.filter((r) => r.state !== "VOID");
  const owed = live.filter((r) => (r.state === "OPEN" || r.state === "SCHEDULED") && !RECORD_ONLY.has(r.kind));

  let sessions: SessionLedger | null = null;
  if (opts.sessions !== false && months.length) {
    try {
      const { monthProgressMany, progressKey } = await import("@/lib/monthProgress");
      const map = await monthProgressMany(months.map((m) => ({ enrollmentId, monthId: m.id, monthKey: m.monthKey })), { now: opts.now, owners: false });
      let used = 0, missed = 0, available = 0;
      const perMonth: SessionLedger["perMonth"] = [];
      for (const m of months) {
        const p = map.get(progressKey(enrollmentId, m.id, m.monthKey));
        if (!p) continue;
        const required = p.sessions.required;
        const held = p.sessions.held;
        const caughtUpLater = !!p.catchUp.from;
        let state: string;
        if (p.forfeited) { missed += required; state = "missed (forfeited)"; }
        else if (m.status === "SKIPPED") { if (!caughtUpLater) missed += required; state = caughtUpLater ? `caught up in ${monthName(p.catchUp.from!.targetMonthKey)}` : "skipped"; }
        else {
          used += held;
          if (m.status === "OPEN") available += Math.max(0, required - held);
          state = m.status === "OPEN" ? (held >= required && required > 0 ? "filmed" : p.sessions.booked > held ? "booked" : "to book") : m.status.toLowerCase();
        }
        perMonth.push({ monthKey: m.monthKey, label: monthName(m.monthKey), required, held, booked: p.sessions.booked, state });
      }
      const pending = (k: EntitlementKind) => live.filter((r) => r.kind === k && r.state !== "FULFILLED").reduce((n, r) => n + r.qty, 0);
      // An extension month owes the package's sessions; a carried month owes the sessions it would have had.
      available += (pending("EXTENSION_MONTH") + pending("CARRY_TO_END")) * Math.max(1, e.sessionsPerMonth || 1);
      sessions = { used, missed, postponed: pending("SESSION_POSTPONED"), available, perMonth };
    } catch (err) {
      console.warn("[entitlements] session read failed", enrollmentId, err);
      sessions = null;
    }
  }
  return { enrollmentId, term, sessions, owed, rows: views, sessionsPerMonth: e.sessionsPerMonth };
}

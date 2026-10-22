"use server";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner, requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { usd2 } from "@/lib/money";
import { etAt, etDayKey } from "@/lib/datetime";

type Result = { ok: boolean; message: string };

// The ONLY money path out of the bonus engine (its own design rule: the engine
// computes, it never pays). Owner-only; idempotent per person and period;
// lands as a PayoutAdjustment on the next payout, visible on Payroll.
//
// THE SERVER DECIDES THE AMOUNT (audit G1, Oct 20 2026): the amount is worked
// out again here; `shownAmount` is only the figure the owner confirmed on
// screen, and a mismatch refuses rather than paying a number nobody looked at.
//
// ONE ENGINE (Jordan, Oct 21 2026), now the terms' scorecard (Oct 22 2026):
// lib/kpi scorePeriod for a contract period, with that person's cap ($1,000
// Harrison, $1,500 James) and bands, and the frozen
// old scorecard (lib/kpiLegacy) for a quarter that began before the terms.
// A contract period also waits for its open disputes and its check-in scores.
export async function payQuarterlyBonus(teamMemberId: string, quarter: string, shownAmount?: number): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (typeof teamMemberId !== "string" || !teamMemberId) return { ok: false, message: "Bad person." };
  if (typeof quarter !== "string" || !/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, message: "Bad quarter." };

  const kpi = await import("@/lib/kpi");
  const p = kpi.periodFromKey(quarter);
  if (!p) return { ok: false, message: "Bad quarter." };
  // The running period's score still moves; paying it now would cap this
  // person at a mid-period figure forever (per-period idempotency).
  if (p.end.getTime() >= Date.now()) return { ok: false, message: `${p.label} is still running. Pay it once the period closes.` };

  // Only someone the bonus covers: never the owner, never a former teammate.
  const member = (await kpi.bonusRoster()).find((m) => m.id === teamMemberId);
  if (!member) return { ok: false, message: "That person isn't covered by the quarterly bonus." };

  const label = `Quarterly bonus ${p.key}`;
  if (await isPaid(teamMemberId, p.key)) return { ok: false, message: "Already paid for this quarter." };

  let amount: number;
  let cap: number;
  if (p.legacy) {
    const card = await kpi.scoreLegacyQuarter(teamMemberId, p, member.name);
    amount = Math.round(card.bonus * 100) / 100;
    cap = kpi.MAX_QUARTERLY_BONUS;
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: `Nothing to pay this person for ${p.label}.` };
  } else {
    const card = await kpi.scorePeriod({ memberId: teamMemberId, name: member.name, period: p });
    const ready = kpi.payReadiness(card);
    if (!ready.ok) return { ok: false, message: ready.why ?? "Not payable." };
    amount = Math.round(card.bonus * 100) / 100;
    cap = card.possible;
  }
  // The bands top out at the person's cap, so anything above it is a fault, never a bonus.
  if (amount > cap) return { ok: false, message: `That bonus is over the ${usd2(cap)} maximum for the period. Check the scorecard.` };
  if (typeof shownAmount === "number" && Number.isFinite(shownAmount) && Math.abs(shownAmount - amount) >= 0.01) {
    return { ok: false, message: `The bonus is now ${usd2(amount)}, not the ${usd2(shownAmount)} on your screen (the scorecard moved). Reload and check it before paying.` };
  }

  await prisma.payoutAdjustment.create({
    data: { teamMemberId, label: p.legacy || p.label === quarterLabel(p.key) ? label : `${label} (${p.label})`, amount, date: new Date() },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Bonus of ${usd2(amount)} queued. It lands on their next payout.` };
}

const quarterLabel = (key: string) => `Q${key.slice(-1)} ${key.slice(0, 4)}`;

async function isPaid(memberId: string, periodKey: string): Promise<boolean> {
  return !!(await prisma.payoutAdjustment.findFirst({ where: { teamMemberId: memberId, label: { startsWith: `Quarterly bonus ${periodKey}` } }, select: { id: true } }));
}

/** The contract period a review change is about; refused once it is paid. */
async function openPeriod(memberId: string, periodKey: string) {
  const { periodFromKey } = await import("@/lib/kpi");
  const p = typeof periodKey === "string" ? periodFromKey(periodKey) : null;
  if (!p || p.legacy) return { error: "That isn't a bonus period under the terms." } as const;
  if (await isPaid(memberId, p.key)) return { error: `${p.label} is paid, so its scorecard is closed.` } as const;
  return { period: p } as const;
}

async function actorName(): Promise<string> {
  const u = await getCurrentUser().catch(() => null);
  return (u?.impersonating ? u.realName : u?.name)?.trim() || u?.email || "Jordan";
}

function done(message: string): Result {
  revalidatePath("/sales");
  revalidatePath("/my-pay");
  return { ok: true, message };
}

// ---- the creative's dispute ---------------------------------------------------

/**
 * The creative disputes one entry on their OWN card, with a note. Nothing
 * changes in the score until it is resolved. Never in a "view as" preview.
 */
export async function disputeKpiEntry(periodKey: string, entryId: string, note: string): Promise<Result> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { ok: false, message: "Please sign in to do that." };
  if (u.impersonating) return { ok: false, message: "You're previewing another user: exit the preview to make changes." };
  if (!u.teamMemberId) return { ok: false, message: "Your login isn't linked to a team member yet. Ask Jordan to connect it." };
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length < 3) return { ok: false, message: "Say what is wrong with it, in a sentence." };
  if (typeof entryId !== "string" || !entryId) return { ok: false, message: "Bad entry." };
  const open = await openPeriod(u.teamMemberId, periodKey);
  if ("error" in open) return { ok: false, message: open.error! };

  const { scorePeriod } = await import("@/lib/kpi");
  const card = await scorePeriod({ memberId: u.teamMemberId, period: open.period });
  const entry = card.entries.find((e) => e.id === entryId);
  if (!entry) return { ok: false, message: "That entry isn't on your scorecard any more." };
  if (entry.status === "not_counted") return { ok: false, message: "That one never counts, so there is nothing to dispute." };

  const { updateReview } = await import("@/lib/kpiStore");
  const r = await updateReview(u.teamMemberId, open.period.key, u.name ?? u.email, (rev) => {
    const cur = rev.reviews[entryId] ?? {};
    if (cur.resolution) return "Jordan has already decided this one. Ask Jordan to reopen it if something is still wrong.";
    if (cur.dispute) return "You have already disputed this one. Jordan will look at it.";
    rev.reviews[entryId] = { ...cur, dispute: { note: text.slice(0, 1000), by: u.name ?? u.email, byMemberId: u.teamMemberId, at: new Date().toISOString() } };
    return { next: rev, log: { entryId, what: `Disputed: ${text.slice(0, 200)}` } };
  });
  return r.ok ? done("Disputed. Jordan will review it; until then the entry still counts.") : { ok: false, message: r.message };
}

// ---- resolving: the owner, or the creative manager for a specialist's entry ----

export async function resolveKpiEntry(memberId: string, periodKey: string, entryId: string, outcome: "upheld" | "removed" | "reopen", reason: string): Promise<Result> {
  try { await requireRole(["OWNER", "CREATIVE_MANAGER"]); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (!["upheld", "removed", "reopen"].includes(outcome)) return { ok: false, message: "Pick upheld or removed." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (outcome !== "reopen" && why.length < 3) return { ok: false, message: "Give the reason: it is what the creative reads." };
  if (typeof memberId !== "string" || !memberId || typeof entryId !== "string" || !entryId) return { ok: false, message: "Bad entry." };
  const u = await getCurrentUser().catch(() => null);
  const open = await openPeriod(memberId, periodKey);
  if ("error" in open) return { ok: false, message: open.error! };

  const { scorePeriod } = await import("@/lib/kpi");
  const card = await scorePeriod({ memberId, period: open.period });
  // The creative manager reviews a creative specialist's entries only: never
  // their own and never another manager's.
  if (u && u.realRole !== "OWNER") {
    if (u.teamMemberId === memberId) return { ok: false, message: "Your own entries are Jordan's to decide." };
    if (card.terms.personKey === "james") return { ok: false, message: "Only Jordan decides these." };
  }
  const entry = card.entries.find((e) => e.id === entryId);
  if (!entry) return { ok: false, message: "That entry isn't on the scorecard any more." };
  if (entry.status === "not_counted") return { ok: false, message: "That one never counts." };

  const by = await actorName();
  const { updateReview } = await import("@/lib/kpiStore");
  const r = await updateReview(memberId, open.period.key, by, (rev) => {
    const cur = { ...(rev.reviews[entryId] ?? {}) };
    if (outcome === "reopen") {
      if (!cur.resolution) return "It isn't decided yet.";
      delete cur.resolution;
      rev.reviews[entryId] = cur;
      return { next: rev, log: { entryId, what: "Reopened" } };
    }
    rev.reviews[entryId] = { ...cur, resolution: { outcome, reason: why.slice(0, 1000), by, at: new Date().toISOString() } };
    return { next: rev, log: { entryId, what: `${outcome === "upheld" ? (entry.advisory ? "Counted" : "Upheld") : "Removed"}: ${why.slice(0, 200)}` } };
  });
  if (!r.ok) return { ok: false, message: r.message };
  return done(outcome === "reopen" ? "Reopened." : outcome === "removed" ? "Removed: it no longer counts." : entry.advisory ? "Counted." : "Upheld: it keeps counting.");
}

// ---- the owner's notes and monthly check-ins -------------------------------------

type ManualInput = { area: string; day: string; title: string; note: string; points: number; projectId?: string | null };

/** Check a hand-added entry against the person's card; the clean values or a refusal. */
async function checkManual(memberId: string, periodKey: string, input: ManualInput) {
  const open = await openPeriod(memberId, periodKey);
  if ("error" in open) return { error: open.error! } as const;
  const { scorePeriod, bonusRoster } = await import("@/lib/kpi");
  if (!(await bonusRoster()).some((m) => m.id === memberId)) return { error: "That person isn't covered by the KPI bonus." } as const;
  const card = await scorePeriod({ memberId, period: open.period });
  const areas = card.terms.categories.flatMap((c) => c.areas);
  if (!areas.includes(input?.area as never)) return { error: "Pick one of this person's categories." } as const;
  const title = (input.title ?? "").trim();
  if (title.length < 3) return { error: "Give it a short title." } as const;
  const points = Math.round(Number(input.points ?? 0));
  if (!Number.isFinite(points) || points < -25 || points > 25) return { error: "Points run from -25 to +25 (0 = a note that does not score)." } as const;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.day ?? "") ? input.day : etDayKey(new Date());
  if (day < open.period.startKey || day > open.period.endKey) return { error: `The day has to be inside ${open.period.label}. To move it to another period, delete it and add it there.` } as const;
  let projectId: string | null = null;
  let projectLabel: string | null = null;
  if (input.projectId) {
    const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, title: true, addressLine: true } });
    if (!p) return { error: "That job isn't there." } as const;
    projectId = p.id;
    projectLabel = (p.addressLine?.trim() && !/^\[No address/i.test(p.addressLine) ? p.addressLine.trim() : p.title.split(",")[0].trim()).slice(0, 160);
  }
  return { period: open.period, value: { area: input.area, day, title: title.slice(0, 160), note: (input.note ?? "").trim().slice(0, 1000), points, projectId, projectLabel } } as const;
}

/** The owner's own entry on a scorecard: shown like the hub's and disputable. Positive, negative or a note (0 points). */
export async function addKpiNote(memberId: string, periodKey: string, input: ManualInput): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const chk = await checkManual(memberId, periodKey, input);
  if ("error" in chk) return { ok: false, message: chk.error! };
  const by = await actorName();
  const { updateReview } = await import("@/lib/kpiStore");
  const r = await updateReview(memberId, chk.period.key, by, (rev) => {
    const id = crypto.randomUUID();
    rev.manual.push({ id, ...chk.value, by, at: new Date().toISOString() });
    return { next: rev, log: { entryId: `manual:${id}`, what: `Entry added (${chk.value.points > 0 ? "+" : ""}${chk.value.points}): ${chk.value.title.slice(0, 120)}` } };
  });
  return r.ok ? done("Added. It shows on their scorecard now.") : { ok: false, message: r.message };
}

/** Change a hand-added entry. A dispute on it stays, and is decided as before. */
export async function editKpiNote(memberId: string, periodKey: string, manualId: string, input: ManualInput): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const chk = await checkManual(memberId, periodKey, input);
  if ("error" in chk) return { ok: false, message: chk.error! };
  const id = String(manualId ?? "").replace(/^manual:/, "");
  const by = await actorName();
  const { updateReview } = await import("@/lib/kpiStore");
  const r = await updateReview(memberId, chk.period.key, by, (rev) => {
    const i = rev.manual.findIndex((m) => m.id === id);
    if (i < 0) return "That entry is gone.";
    rev.manual[i] = { ...rev.manual[i], ...chk.value, editedBy: by, editedAt: new Date().toISOString() };
    return { next: rev, log: { entryId: `manual:${id}`, what: `Entry changed (${chk.value.points > 0 ? "+" : ""}${chk.value.points}): ${chk.value.title.slice(0, 120)}` } };
  });
  return r.ok ? done("Saved.") : { ok: false, message: r.message };
}

export async function removeKpiNote(memberId: string, periodKey: string, manualId: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const open = await openPeriod(memberId, periodKey);
  if ("error" in open) return { ok: false, message: open.error! };
  const by = await actorName();
  const { updateReview } = await import("@/lib/kpiStore");
  const id = String(manualId ?? "").replace(/^manual:/, "");
  const r = await updateReview(memberId, open.period.key, by, (rev) => {
    const hit = rev.manual.find((m) => m.id === id);
    if (!hit) return "That note is already gone.";
    rev.manual = rev.manual.filter((m) => m.id !== id);
    delete rev.reviews[`manual:${id}`];
    return { next: rev, log: { entryId: `manual:${id}`, what: `Note removed: ${hit.title.slice(0, 120)}` } };
  });
  return r.ok ? done("Removed.") : { ok: false, message: r.message };
}

/** One month's check-in: a score (0 to 100) for each check-in category, and a note. Owner only for now. */
export async function saveKpiCheckIn(memberId: string, periodKey: string, monthKey: string, input: { scores: Record<string, number | null>; note: string }): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const open = await openPeriod(memberId, periodKey);
  if ("error" in open) return { ok: false, message: open.error! };
  const { periodMonths, scorePeriod } = await import("@/lib/kpi");
  const month = periodMonths(open.period).find((m) => m.key === monthKey);
  if (!month) return { ok: false, message: "That month isn't in this period." };
  if (month.startKey > etDayKey(new Date())) return { ok: false, message: "That month hasn't started yet." };
  const card = await scorePeriod({ memberId, period: open.period });
  const allowed = card.terms.categories.filter((c) => c.checkIn).map((c) => c.areas[0]);
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(input?.scores ?? {})) {
    if (v == null || (typeof v === "string" && v === "")) continue;
    if (!allowed.includes(k as never)) return { ok: false, message: "That isn't one of this person's check-in categories." };
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: "Scores run from 0 to 100." };
    scores[k] = n;
  }
  const note = (input?.note ?? "").trim().slice(0, 2000);
  if (!Object.keys(scores).length && !note) return { ok: false, message: "Enter a score or a note." };
  const by = await actorName();
  const { updateReview } = await import("@/lib/kpiStore");
  const r = await updateReview(memberId, open.period.key, by, (rev) => {
    rev.checkIns[monthKey] = { scores, note, by, at: new Date().toISOString() };
    return { next: rev, log: { entryId: null, what: `Check-in for ${month.label}: ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(", ") || "note only"}` } };
  });
  return r.ok ? done(`Saved the ${month.label} check-in.`) : { ok: false, message: r.message };
}

// ---- a deadline agreed for one shoot --------------------------------------------

/** `photos` / `video`: "YYYY-MM-DDTHH:mm", Eastern time. Both empty clears it. Owner only. */
export async function setKpiDeadline(projectId: string, input: { photos?: string | null; video?: string | null; note: string }): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (typeof projectId !== "string" || !projectId) return { ok: false, message: "Bad shoot." };
  const exists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!exists) return { ok: false, message: "That shoot isn't there." };
  const parse = (v: string | null | undefined): string | null | "bad" => {
    if (!v) return null;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v.trim());
    if (!m) return "bad";
    const at = etAt(m[1], Number(m[2]), Number(m[3]));
    return Number.isNaN(at.getTime()) ? "bad" : at.toISOString();
  };
  const photos = parse(input?.photos);
  const video = parse(input?.video);
  if (photos === "bad" || video === "bad") return { ok: false, message: "Pick a date and a time." };
  const note = (input?.note ?? "").trim();
  if ((photos || video) && note.length < 3) return { ok: false, message: "Say what was agreed, in a few words." };
  const by = await actorName();
  const { writeDeadlineOverride } = await import("@/lib/kpiStore");
  await writeDeadlineOverride(projectId, photos || video ? { photos, video, note: note.slice(0, 300), by, at: new Date().toISOString() } : null);
  return done(photos || video ? "Agreed deadline saved: the entry follows it." : "Agreed deadline cleared: the terms' deadline applies.");
}


// ---- a change to a person's weights or bands, prospectively ----------------------

/**
 * Change Harrison's or James's weights and score bands, applying from a bonus
 * period that has NOT started yet, onward (the terms: criteria are written
 * down before the period and never changed retroactively). A change saved
 * again for the same future period replaces the earlier draft. The weights are
 * over the five categories and add to 100; a band never pays more than that
 * person's maximum, and a higher score never pays less.
 */
export async function saveKpiTerms(personKey: string, input: { weights: Record<string, number>; bands: { min: number; amount: number }[]; fromPeriodKey: string; note?: string }): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const kpi = await import("@/lib/kpi");
  if (!kpi.KPI_TERMS_PEOPLE.includes(personKey as never)) return { ok: false, message: "Pick Harrison or James." };
  const base = kpi.agreedTerms(personKey as "harrison" | "james");
  const cap = base.cap;
  const weights: Record<string, number> = {};
  for (const c of base.categories) {
    const n = Math.round(Number(input?.weights?.[c.key] ?? 0));
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: "Each weight runs from 0 to 100." };
    weights[c.key] = n;
  }
  const sum = Object.values(weights).reduce((s, n) => s + n, 0);
  if (sum !== 100) return { ok: false, message: `The weights add to ${sum}; they must add to 100.` };
  const rows = (Array.isArray(input?.bands) ? input.bands : [])
    .map((b) => ({ min: Math.round(Number(b?.min)), amount: Math.round(Number(b?.amount) * 100) / 100 }))
    .filter((b) => Number.isFinite(b.min) && Number.isFinite(b.amount));
  if (!rows.length || rows.length > 6) return { ok: false, message: "Enter one to six bands." };
  if (rows.some((b) => b.min < 0 || b.min > 100)) return { ok: false, message: "A band starts at a score from 0 to 100." };
  if (rows.some((b) => b.amount < 0 || b.amount > cap)) return { ok: false, message: `A band pays from $0 to ${usd2(cap)}, the most this person's bonus can pay.` };
  if (new Set(rows.map((b) => b.min)).size !== rows.length) return { ok: false, message: "Two bands start at the same score." };
  const sorted = [...rows].sort((a, b) => b.min - a.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].amount > sorted[i - 1].amount) return { ok: false, message: "A higher score can never pay less than a lower one." };
  }

  const from = kpi.periodFromKey(String(input?.fromPeriodKey ?? ""));
  if (!from || from.legacy) return { ok: false, message: "Pick the period these apply from." };
  if (from.startKey <= etDayKey(new Date())) {
    return { ok: false, message: `${from.label} has already started: a change applies from a period that has not started yet, never to one already running.` };
  }
  const { readTermsVersions, writeTermsVersions } = await import("@/lib/kpiStore");
  const by = await actorName();
  const kept = (await readTermsVersions(personKey)).filter((v) => v.fromPeriodKey !== from.key);
  kept.push({ fromPeriodKey: from.key, weights, bands: sorted, note: (input.note ?? "").trim().slice(0, 500), savedBy: by, savedAt: new Date().toISOString() });
  await writeTermsVersions(personKey, kept, by);
  return done(`Saved: these weights and bands apply from ${from.label} onward.`);
}

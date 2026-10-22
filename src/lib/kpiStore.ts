import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHERE THE KPI REVIEW LIVES (Oct 22 2026). No schema change: three kinds of
// AppSetting row, each a small JSON document.
//
//   kpi_review:<teamMemberId>:<periodKey>
//       Everything a PERSON said or decided about one person's bonus period:
//       a dispute on an automatic entry (the creative's note), its resolution
//       (upheld or removed, with the reason and who decided), the owner's
//       manual entries, the monthly check-in scores and notes, and an
//       append-only log of every one of those changes. The automatic entries
//       themselves are NOT stored: lib/kpiEvidence works them out from the
//       hub's own records on every read, so they can never drift from them.
//       A review is keyed to the entry's stable id (late-video:<projectId>…).
//
//   kpi_deadline:<projectId>
//       A deadline agreed for one shoot (the terms: "a project-specific
//       deadline can override"). Owner only.
//
//   kpi_terms:<personKey>
//       A change Jordan saves to a person's weights or score bands (harrison,
//       james), as versions that each apply from a bonus period onward. Only
//       a period that has not started can be chosen: never retroactive (app/
//       sales/bonusActions saveKpiTerms). No row = the terms as agreed.
//
// Writes are compare-and-set on the stored text (updateMany WHERE value = the
// text that was read), retried a few times, so two tabs can never silently
// overwrite each other's dispute or check-in.
// ---------------------------------------------------------------------------

export type KpiDispute = { note: string; by: string; byMemberId: string | null; at: string };
export type KpiResolution = { outcome: "upheld" | "removed"; reason: string; by: string; at: string };
export type KpiManualEntry = {
  id: string;
  /** the evidence area it belongs to (lib/kpi KpiArea) */
  area: string;
  /** ET day it is about (decides the month) */
  day: string;
  title: string;
  note: string;
  /** signed points on the category's 100; 0 = a note that does not score */
  points: number;
  projectId: string | null;
  /** the job's street, for the card (kept so a renamed job still reads) */
  projectLabel?: string | null;
  by: string;
  at: string;
  editedBy?: string | null;
  editedAt?: string | null;
};
export type KpiCheckIn = {
  /** area → 0..100 */
  scores: Record<string, number>;
  note: string;
  by: string;
  at: string;
};
export type KpiLogLine = { at: string; by: string; entryId: string | null; what: string };
export type KpiReview = {
  v: 1;
  reviews: Record<string, { dispute?: KpiDispute; resolution?: KpiResolution }>;
  manual: KpiManualEntry[];
  checkIns: Record<string, KpiCheckIn>;
  log: KpiLogLine[];
};

const EMPTY = (): KpiReview => ({ v: 1, reviews: {}, manual: [], checkIns: {}, log: [] });
const LOG_CAP = 400;

export const reviewKey = (memberId: string, periodKey: string) => `kpi_review:${memberId}:${periodKey}`;
export const deadlineKey = (projectId: string) => `kpi_deadline:${projectId}`;
export const termsKey = (personKey: string) => `kpi_terms:${personKey}`;

function parseReview(raw: string | null | undefined): KpiReview {
  if (!raw) return EMPTY();
  try {
    const j = JSON.parse(raw) as Partial<KpiReview>;
    return {
      v: 1,
      reviews: j.reviews && typeof j.reviews === "object" ? j.reviews : {},
      manual: Array.isArray(j.manual) ? j.manual : [],
      checkIns: j.checkIns && typeof j.checkIns === "object" ? j.checkIns : {},
      log: Array.isArray(j.log) ? j.log : [],
    };
  } catch {
    return EMPTY();
  }
}

export async function readReview(memberId: string, periodKey: string): Promise<KpiReview> {
  const row = await prisma.appSetting.findUnique({ where: { key: reviewKey(memberId, periodKey) }, select: { value: true } });
  return parseReview(row?.value);
}

/**
 * Change one person-period's review. `change` gets a copy and returns the new
 * document plus a log line, or a refusal message. Compare-and-set, retried.
 */
export async function updateReview(
  memberId: string,
  periodKey: string,
  by: string,
  change: (r: KpiReview) => { next: KpiReview; log: Omit<KpiLogLine, "at" | "by"> } | string,
): Promise<{ ok: true; review: KpiReview } | { ok: false; message: string }> {
  const key = reviewKey(memberId, periodKey);
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const current = parseReview(row?.value);
    const out = change(structuredClone(current));
    if (typeof out === "string") return { ok: false, message: out };
    const next = { ...out.next, log: [...out.next.log, { at: new Date().toISOString(), by, ...out.log }].slice(-LOG_CAP) };
    const value = JSON.stringify(next);
    if (!row) {
      const made = await prisma.appSetting.create({ data: { key, value, updatedBy: by.slice(0, 120) } }).then(() => true, () => false);
      if (made) return { ok: true, review: next };
      continue; // another write created it first: read it and try again
    }
    const r = await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value, updatedBy: by.slice(0, 120) } });
    if (r.count === 1) return { ok: true, review: next };
  }
  return { ok: false, message: "Someone else changed this at the same moment. Reload and try again." };
}

// ---- agreed deadlines, per shoot -------------------------------------------

export type KpiDeadlineOverride = { photos?: string | null; video?: string | null; note: string; by: string; at: string };

export async function readDeadlineOverrides(projectIds: string[]): Promise<Map<string, KpiDeadlineOverride>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.appSetting.findMany({ where: { key: { in: projectIds.map(deadlineKey) } }, select: { key: true, value: true } });
  const out = new Map<string, KpiDeadlineOverride>();
  for (const r of rows) {
    try {
      out.set(r.key.slice("kpi_deadline:".length), JSON.parse(r.value) as KpiDeadlineOverride);
    } catch { /* an unreadable override is no override */ }
  }
  return out;
}

export async function writeDeadlineOverride(projectId: string, o: KpiDeadlineOverride | null): Promise<void> {
  const key = deadlineKey(projectId);
  if (!o || (!o.photos && !o.video)) {
    await prisma.appSetting.deleteMany({ where: { key } });
    return;
  }
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(o), updatedBy: o.by.slice(0, 120) }, update: { value: JSON.stringify(o), updatedBy: o.by.slice(0, 120) } });
}

// ---- terms Jordan writes down (James) ---------------------------------------

export type KpiTermsVersion = {
  /** the first bonus period these apply to (lib/kpi period key, "2027-Q1") */
  fromPeriodKey: string;
  /** category key → weight; adds to 100 */
  weights: Record<string, number>;
  /** score bands, high to low; the lowest is always min 0 */
  bands: { min: number; amount: number }[];
  note: string;
  savedBy: string;
  savedAt: string;
};

export async function readTermsVersions(personKey: string): Promise<KpiTermsVersion[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: termsKey(personKey) }, select: { value: true } });
  if (!row) return [];
  try {
    const j = JSON.parse(row.value) as { versions?: KpiTermsVersion[] };
    return Array.isArray(j.versions) ? j.versions : [];
  } catch {
    return [];
  }
}

/** Append a version (or replace one for a period that has not started). The caller validates. */
export async function writeTermsVersions(personKey: string, versions: KpiTermsVersion[], by: string): Promise<void> {
  const key = termsKey(personKey);
  const value = JSON.stringify({ versions });
  await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy: by.slice(0, 120) }, update: { value, updatedBy: by.slice(0, 120) } });
}

/** The missing-instructions nudge's own records (lib/missingInstructions claims): what was asked for, and when. */
export type InstructionsAsk = { projectId: string; day: string; at: string; missing: string[] };

export async function readInstructionsAsks(projectIds: string[]): Promise<InstructionsAsk[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.appSetting.findMany({
    where: { OR: projectIds.map((id) => ({ key: { startsWith: `instructions_missing:${id}:` } })) },
    select: { key: true, value: true },
  });
  const out: InstructionsAsk[] = [];
  for (const r of rows) {
    const [, projectId, day] = r.key.split(":");
    try {
      const j = JSON.parse(r.value) as { state?: string; at?: string; missing?: string[] };
      if (j.state !== "sent" || !projectId || !day) continue;
      out.push({ projectId, day, at: j.at ?? "", missing: Array.isArray(j.missing) ? j.missing : [] });
    } catch { /* not a record */ }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

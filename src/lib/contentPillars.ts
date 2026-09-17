import "server-only";
import { prisma } from "@/lib/prisma";
import { normalizeTitle, titleSimilarity } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Pillars as STABLE identities (spec §5/§18, manifest C-A6/C-C4). A client's
// pillar keeps its id through every rename; ContentPillarAlias holds every
// name it has had and every label an import used for it.
//
// The ~200 free-text ContentTopic.pillar strings in production are NEVER
// seeded into pillars automatically (Jordan's rule) — pillarMappingProposal()
// lists them with counts and a proposed pillar, and only confirmPillarMapping()
// writes pillarId onto topics, one label at a time, on his say-so.
// ---------------------------------------------------------------------------

export type PillarRow = { id: string; name: string; purpose: string | null; focusAreas: string | null; contentApproach: string | null; sortOrder: number; status: string; strategyVersionId: string | null; aliases: string[] };

export async function listPillars(enrollmentId: string, opts: { includeRetired?: boolean } = {}): Promise<PillarRow[]> {
  const rows = await prisma.contentPillar.findMany({
    where: { enrollmentId, ...(opts.includeRetired ? {} : { status: "ACTIVE" }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const aliases = rows.length ? await prisma.contentPillarAlias.findMany({ where: { pillarId: { in: rows.map((r) => r.id) } } }) : [];
  return rows.map((r) => ({
    id: r.id, name: r.name, purpose: r.purpose, focusAreas: r.focusAreas, contentApproach: r.contentApproach, sortOrder: r.sortOrder, status: r.status, strategyVersionId: r.strategyVersionId,
    aliases: aliases.filter((a) => a.pillarId === r.id && a.name !== r.name).map((a) => a.name),
  }));
}

/** Exact (case/punctuation-insensitive) match of a label against a client's pillar names and aliases. Null = no match; the caller queues a mapping. */
export async function resolvePillarByLabel(enrollmentId: string, label: string | null | undefined): Promise<string | null> {
  if (!label?.trim()) return null;
  const key = normalizeTitle(label);
  if (!key) return null;
  const pillars = await listPillars(enrollmentId, { includeRetired: true });
  for (const p of pillars) {
    if (normalizeTitle(p.name) === key) return p.id;
    if (p.aliases.some((a) => normalizeTitle(a) === key)) return p.id;
  }
  return null;
}

export async function createPillar(opts: { enrollmentId: string; clientId: string; name: string; purpose?: string | null; focusAreas?: string | null; contentApproach?: string | null; strategyVersionId?: string | null; sortOrder?: number; createdBy: string }): Promise<string> {
  const name = opts.name.trim().slice(0, 160);
  if (!name) throw new Error("A pillar needs a name.");
  const existing = await resolvePillarByLabel(opts.enrollmentId, name);
  if (existing) return existing;
  const row = await prisma.contentPillar.create({
    data: {
      enrollmentId: opts.enrollmentId, clientId: opts.clientId, name, purpose: opts.purpose ?? null, focusAreas: opts.focusAreas ?? null, contentApproach: opts.contentApproach ?? null,
      strategyVersionId: opts.strategyVersionId ?? null, sortOrder: opts.sortOrder ?? 0, createdBy: opts.createdBy,
    },
  });
  await prisma.contentPillarAlias.create({ data: { pillarId: row.id, name, kind: "CANONICAL", validFrom: new Date(), source: opts.strategyVersionId ?? "manual", approvedBy: opts.createdBy } }).catch(() => {});
  return row.id;
}

/** Rename keeps the id (C-C4: Jordan renames at every refresh). The old name becomes a PREVIOUS alias so old documents still resolve. */
export async function renamePillar(pillarId: string, newName: string, by: string): Promise<void> {
  const name = newName.trim().slice(0, 160);
  if (!name) throw new Error("A pillar needs a name.");
  const p = await prisma.contentPillar.findUnique({ where: { id: pillarId } });
  if (!p) throw new Error("Pillar not found.");
  if (p.name === name) return;
  await prisma.contentPillarAlias.updateMany({ where: { pillarId, name: p.name, kind: "CANONICAL" }, data: { kind: "PREVIOUS", validTo: new Date() } });
  await prisma.contentPillar.update({ where: { id: pillarId }, data: { name } });
  await prisma.contentPillarAlias.upsert({
    where: { pillarId_name: { pillarId, name } },
    create: { pillarId, name, kind: "CANONICAL", validFrom: new Date(), source: "manual", approvedBy: by },
    update: { kind: "CANONICAL", validTo: null, approvedBy: by },
  });
}

export async function updatePillarFields(pillarId: string, patch: { purpose?: string | null; focusAreas?: string | null; contentApproach?: string | null; sortOrder?: number }): Promise<void> {
  await prisma.contentPillar.update({ where: { id: pillarId }, data: patch });
}

/** Retire (never delete). Topics keep their pillarId; readers show the retired name. */
export async function retirePillar(pillarId: string, mergedIntoId?: string | null): Promise<void> {
  await prisma.contentPillar.update({ where: { id: pillarId }, data: { status: "RETIRED", retiredAt: new Date(), mergedIntoId: mergedIntoId ?? null } });
}

export type PillarMappingRow = {
  label: string;
  topicCount: number;
  sample: string[];
  proposedPillarId: string | null;
  proposedPillarName: string | null;
  /** 0..1 title similarity between the label and the proposed pillar's best name/alias. */
  confidence: number;
  /** A label that IS a quality dimension (Trust / Value / …) — never a pillar (spec §27). */
  isQualityDimension: boolean;
};

const DIMENSION_RE = /^(trust|value|credibility|entertainment)(\s*[\/&•·,+]\s*(trust|value|credibility|entertainment))*$/i;

/**
 * The PROPOSAL tool: every distinct free-text pillar string on this client's
 * topics that has no pillarId yet, with a proposed pillar from the approved
 * strategy's pillars (best similarity ≥ 0.45) for Jordan to confirm per row.
 * Reads only.
 */
export async function pillarMappingProposal(enrollmentId: string): Promise<PillarMappingRow[]> {
  const [groups, pillars] = await Promise.all([
    prisma.contentTopic.groupBy({ by: ["pillar"], where: { enrollmentId, pillarId: null, pillar: { not: null } }, _count: true }),
    listPillars(enrollmentId),
  ]);
  const rows: PillarMappingRow[] = [];
  for (const g of groups) {
    const label = (g.pillar ?? "").trim();
    if (!label) continue;
    const sample = (await prisma.contentTopic.findMany({ where: { enrollmentId, pillarId: null, pillar: g.pillar }, select: { title: true }, take: 3 })).map((t) => t.title);
    // "Pillar 2: Seller Strategy…" → compare on the name part only.
    const bare = label.replace(/^pillar\s*\d+\s*[:.\-–—]?\s*/i, "");
    let best: { id: string; name: string; score: number } | null = null;
    for (const p of pillars) {
      for (const candidate of [p.name, ...p.aliases]) {
        const s = titleSimilarity(bare, candidate);
        if (!best || s > best.score) best = { id: p.id, name: p.name, score: s };
      }
    }
    const isDim = DIMENSION_RE.test(bare);
    const propose = best && best.score >= 0.45 && !isDim ? best : null;
    rows.push({
      label, topicCount: g._count, sample,
      proposedPillarId: propose?.id ?? null, proposedPillarName: propose?.name ?? null,
      confidence: Math.round((best?.score ?? 0) * 100) / 100, isQualityDimension: isDim,
    });
  }
  rows.sort((a, b) => b.topicCount - a.topicCount || a.label.localeCompare(b.label));
  return rows;
}

/**
 * Jordan confirmed "label → pillar" for one client. Records the label as an
 * IMPORTED_LABEL alias and stamps pillarId on every topic of this enrollment
 * that carries the label and has no pillarId. Each topic gets a RECONCILED
 * event so the change is on its history. Nothing is renamed or deleted.
 */
export async function confirmPillarMapping(enrollmentId: string, label: string, pillarId: string, by: string): Promise<{ updated: number }> {
  const pillar = await prisma.contentPillar.findUnique({ where: { id: pillarId }, select: { id: true, enrollmentId: true, name: true } });
  if (!pillar || pillar.enrollmentId !== enrollmentId) throw new Error("That pillar belongs to another client.");
  await prisma.contentPillarAlias.upsert({
    where: { pillarId_name: { pillarId, name: label } },
    create: { pillarId, name: label, kind: "IMPORTED_LABEL", validFrom: new Date(), source: "mapping", approvedBy: by },
    update: { approvedBy: by },
  });
  const topics = await prisma.contentTopic.findMany({ where: { enrollmentId, pillarId: null, pillar: label }, select: { id: true } });
  if (!topics.length) return { updated: 0 };
  await prisma.contentTopic.updateMany({ where: { id: { in: topics.map((t) => t.id) } }, data: { pillarId, lastEventAt: new Date() } });
  await prisma.contentTopicEvent.createMany({
    data: topics.map((t) => ({ topicId: t.id, enrollmentId, kind: "RECONCILED", actorKind: "STAFF", staffUserId: by, note: `Pillar label “${label}” mapped to “${pillar.name}”`, sourceRef: `pillar:${pillarId}` })),
  });
  return { updated: topics.length };
}

/** Jordan says a label is NOT a pillar (a quality dimension, "TBD") — record the decision so the proposal stops asking. */
export async function dismissPillarLabel(enrollmentId: string, label: string, by: string): Promise<void> {
  // A dismissed label is remembered as an alias on a per-client "unmapped" marker
  // pillar would be a fake pillar; instead the topics keep their text label and
  // the proposal screen hides labels dismissed in this AppSetting list.
  const key = `pillar-dismissed-${enrollmentId}`;
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const list = new Set<string>(row ? (JSON.parse(row.value) as string[]) : []);
  list.add(label);
  const value = JSON.stringify([...list]);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  void by;
}

export async function dismissedPillarLabels(enrollmentId: string): Promise<Set<string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: `pillar-dismissed-${enrollmentId}` } });
  try { return new Set(row ? (JSON.parse(row.value) as string[]) : []); } catch { return new Set(); }
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { normalizeTitle, asPillarEmphasis, closestPillar, pillarLabelParts, pillarLooseKey, type PillarEmphasis, type PillarLabelMatch, type PillarMatchHow } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Pillars as STABLE identities (spec §5/§18, manifest C-A6/C-C4). A client's
// pillar keeps its id through every rename; ContentPillarAlias holds every
// name it has had and every label an import used for it.
//
// A CLIENT'S PILLARS ARE EXACTLY THE CONFIRMED ONES (Jordan, Oct 23 2026: "I'm
// not sure why we have Pillar labels to map. We should just stick to their
// confirmed pillars that are in their content strategy, unless we discuss
// adding a new one on a strategy call or I add a new one in the hub."). A
// pillar is created in three places only:
//   · approving a strategy version, for that version's own pillars
//     (contentStrategy.syncPillarsFromVersion; an approved strategy change
//     after a strategy call goes through the same approval);
//   · "Add pillar" on the Strategy tab (actions.addPillar);
//   · nothing else. createPillar below has no other caller.
// Every other label (a model's answer, an imported document's heading, a
// script's Category line, an old topic's free text) is matched to a confirmed
// pillar by matchConfirmedPillar (contentPolicy/pillarMatch.ts has the rule),
// or keeps no pillar. There is no mapping queue: the Strategy tab's "Pillar
// labels to map" section is gone, and the free-text labels from before are
// linked by scripts/_live/oct23-pillar-labels-auto-map.ts with the same rule.
// ---------------------------------------------------------------------------

export type PillarRow = { id: string; name: string; purpose: string | null; focusAreas: string | null; contentApproach: string | null; sortOrder: number; status: string; strategyVersionId: string | null; aliases: string[]; /** Oct 13 2026: LEAD | NORMAL | LIGHT (contentPolicy topicBank.ts, PILLAR EMPHASIS). */ emphasis: PillarEmphasis };

export async function listPillars(enrollmentId: string, opts: { includeRetired?: boolean } = {}): Promise<PillarRow[]> {
  const rows = await prisma.contentPillar.findMany({
    where: { enrollmentId, ...(opts.includeRetired ? {} : { status: "ACTIVE" }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const aliases = rows.length ? await prisma.contentPillarAlias.findMany({ where: { pillarId: { in: rows.map((r) => r.id) } } }) : [];
  return rows.map((r) => ({
    id: r.id, name: r.name, purpose: r.purpose, focusAreas: r.focusAreas, contentApproach: r.contentApproach, sortOrder: r.sortOrder, status: r.status, strategyVersionId: r.strategyVersionId, emphasis: asPillarEmphasis(r.emphasis),
    aliases: aliases.filter((a) => a.pillarId === r.id && a.name !== r.name).map((a) => a.name),
  }));
}

type Resolved = { id: string; how: Exclude<PillarMatchHow, "part" | "closest">; status: string };

/**
 * Steps 1–2 of the rule (pillarMatch.ts) against stored pillars: a label's
 * name or alias, else the same name spelled differently ("Pillar 3: X", "&"
 * for "and"). Whole label only (createPillar dedupes on this).
 */
async function resolveAmong(pillars: PillarRow[], label: string): Promise<Resolved | null> {
  const key = normalizeTitle(label);
  if (!key) return null;
  const exact = pillars.filter((p) => normalizeTitle(p.name) === key || p.aliases.some((a) => normalizeTitle(a) === key));
  // Oct 23 2026: "Pillar 3: Personal Brand & Trust Builder" is the pillar
  // "Personal Brand & Trust Builder" (pillarKey drops the number), when the
  // exact label matches nothing; so is "Personal Brand and Trust Builder".
  const lk = pillarLooseKey(label);
  const hits = exact.length ? exact : lk ? pillars.filter((p) => pillarLooseKey(p.name) === lk || p.aliases.some((a) => pillarLooseKey(a) === lk)) : [];
  if (!hits.length) return null;
  const howOf = (p: PillarRow): Resolved["how"] => (!exact.length ? "spelling" : normalizeTitle(p.name) === key ? "name" : "alias");
  // THE PILLAR IN USE WINS (Oct 20 2026). A retired duplicate keeps its old
  // name as an alias, and sorted first, it took all 20 of Kristin Ciarmella's
  // new Malvern topics out of her bank. An active match is returned; a retired
  // one is followed to the pillar it was merged into; only a retired pillar
  // with nowhere to go is returned as itself (old documents still resolve).
  const active = hits.find((p) => p.status !== "RETIRED" && normalizeTitle(p.name) === key) ?? hits.find((p) => p.status !== "RETIRED");
  if (active) return { id: active.id, how: howOf(active), status: active.status };
  for (const h of hits) {
    let at: string | null = h.id;
    for (let i = 0; at && i < 5; i++) {
      const row: { status: string; mergedIntoId: string | null } | null = await prisma.contentPillar.findUnique({ where: { id: at }, select: { status: true, mergedIntoId: true } });
      if (!row) break;
      if (row.status !== "RETIRED") return { id: at, how: "alias", status: row.status };
      at = row.mergedIntoId;
    }
  }
  return { id: hits[0].id, how: howOf(hits[0]), status: hits[0].status };
}

/** Exact (case/punctuation-insensitive, pillar number and "and" aside) match of a label against a client's pillar names and aliases. Null = no match. Pillar-making code (createPillar) uses this; everything that FILES a topic or script uses matchConfirmedPillar. */
export async function resolvePillarByLabel(enrollmentId: string, label: string | null | undefined): Promise<string | null> {
  if (!label?.trim()) return null;
  return (await resolveAmong(await listPillars(enrollmentId, { includeRetired: true }), label))?.id ?? null;
}

/**
 * THE ONE WAY A LABEL BECOMES A PILLAR ID (Oct 23 2026). Steps 1–2 against
 * the client's stored pillars (a retired one followed to the pillar it was
 * merged into), then 3, the first part of "A / B" that matches, then 4, the
 * closest ACTIVE pillar by words (pillarMatch.closestPillar). Null: no
 * confirmed pillar is close enough, and the caller keeps the item with no
 * pillar (or, for a generated idea, drops it). Never creates anything.
 *
 * `activeOnly`: a match on a retired pillar with nowhere to go counts as no
 * match (new ideas and links made today), instead of the retired pillar
 * (an old document filed under the pillar it named then).
 */
export async function matchConfirmedPillar(enrollmentId: string, label: string | null | undefined, opts: { pillars?: PillarRow[]; activeOnly?: boolean } = {}): Promise<PillarLabelMatch | null> {
  const l = label?.trim();
  if (!l) return null;
  const all = opts.pillars ?? (await listPillars(enrollmentId, { includeRetired: true }));
  if (!all.length) return null;
  const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? "";
  const ok = (r: Resolved | null): r is Resolved => !!r && (!opts.activeOnly || r.status !== "RETIRED");
  const whole = await resolveAmong(all, l);
  if (ok(whole)) return { pillarId: whole.id, pillarName: nameOf(whole.id), how: whole.how, score: 1, why: whole.how === "name" ? "same name" : whole.how === "alias" ? `an earlier name of “${nameOf(whole.id)}”` : "the same name (pillar number or “and” aside)" };
  const parts = pillarLabelParts(l);
  if (parts.length > 1) {
    for (const part of parts) {
      const r = await resolveAmong(all, part);
      if (ok(r)) return { pillarId: r.id, pillarName: nameOf(r.id), how: "part", score: 1, why: `the label's part “${part}” is ${r.how === "name" ? "its name" : r.how === "alias" ? "an earlier name" : "its name, spelled differently"}` };
    }
  }
  const active = all.filter((p) => p.status !== "RETIRED").map((p) => ({ id: p.id, name: p.name, aliases: p.aliases }));
  return closestPillar(l, active).match;
}

/** matchConfirmedPillar's id, or null. */
export async function confirmedPillarIdFor(enrollmentId: string, label: string | null | undefined, opts: { activeOnly?: boolean } = {}): Promise<string | null> {
  return (await matchConfirmedPillar(enrollmentId, label, opts))?.pillarId ?? null;
}

/**
 * Make a confirmed pillar (or return the one already called that). Callers,
 * and the only ones there may be (Oct 23 2026): approving a strategy version
 * (contentStrategy.syncPillarsFromVersion, its own pillars) and the Strategy
 * tab's "Add pillar". Imports, generation and uploads never create pillars.
 */
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

/**
 * Oct 13 2026: how much of the client's content this pillar carries (LEAD |
 * NORMAL | LIGHT). Read by the bank prompt and validator (per-pillar counts),
 * the weekly refill target, the recommendation ranking and the order of the
 * client's topic bank. Refuses a pillar that belongs to another enrollment.
 */
export async function setPillarEmphasis(enrollmentId: string, pillarId: string, emphasis: string): Promise<{ changed: boolean; emphasis: PillarEmphasis; name: string }> {
  const value = asPillarEmphasis(emphasis);
  if (value !== emphasis.trim().toUpperCase()) throw new Error("Emphasis must be Lead, Normal or Light.");
  const p = await prisma.contentPillar.findUnique({ where: { id: pillarId }, select: { enrollmentId: true, emphasis: true, name: true } });
  if (!p || p.enrollmentId !== enrollmentId) throw new Error("Pillar not found.");
  if (asPillarEmphasis(p.emphasis) === value) return { changed: false, emphasis: value, name: p.name };
  await prisma.contentPillar.update({ where: { id: pillarId }, data: { emphasis: value } });
  return { changed: true, emphasis: value, name: p.name };
}

/** Retire (never delete). Topics keep their pillarId; readers show the retired name. */
export async function retirePillar(pillarId: string, mergedIntoId?: string | null): Promise<void> {
  await prisma.contentPillar.update({ where: { id: pillarId }, data: { status: "RETIRED", retiredAt: new Date(), mergedIntoId: mergedIntoId ?? null } });
}


// ---------------------------------------------------------------------------
// The free-text labels from before (Oct 23 2026). ~700 older topics and ~150
// scripts carry a pillar label as text with no pillar linked (imports, call
// topics, scripts filed before pillars existed). The Strategy tab used to list
// them as "Pillar labels to map" for a person to confirm one by one; Jordan
// retired that. They are linked by the same rule as everything else
// (matchConfirmedPillar) in one pass, scripts/_live/oct23-pillar-labels-auto-map.ts,
// through linkPillarLabel below so each topic's history (and the audit log,
// for a script) says what happened and why. A label no confirmed pillar is
// close to stays as text, with no pillar; nothing queues it for anyone.
// ---------------------------------------------------------------------------

/** One free-text label still on this client's topics or scripts with no pillar linked, and what the rule makes of it. */
export type UnlinkedPillarLabel = {
  label: string;
  topicCount: number;
  scriptCount: number;
  sample: string[];
  match: PillarLabelMatch | null;
  /** Why there is no match (too far, ambiguous, a quality dimension…), when there is none. */
  reason: string | null;
  /** Jordan said "Not a pillar" to this label on the old mapping section: it is left as he left it. */
  dismissed: boolean;
};

const NO_PILLAR_LABEL = /^\(?\s*no\s+pillar/i;

/**
 * Every label the old "Pillar labels to map" section showed (a topic's free
 * text with no pillarId), plus a script whose current version carries a
 * Category label and neither the script nor the version a pillar, with the
 * pillar the rule gives it. Reads only.
 */
export async function unlinkedPillarLabels(enrollmentId: string): Promise<UnlinkedPillarLabel[]> {
  const [groups, pillars, dismissed, scripts] = await Promise.all([
    prisma.contentTopic.groupBy({ by: ["pillar"], where: { enrollmentId, pillarId: null, pillar: { not: null } }, _count: true }),
    listPillars(enrollmentId, { includeRetired: true }),
    dismissedPillarLabels(enrollmentId),
    prisma.contentScript.findMany({ where: { enrollmentId, pillarId: null, currentVersionId: { not: null } }, select: { id: true, title: true, currentVersionId: true } }),
  ]);
  const versions = scripts.length
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId!) }, pillarId: null, categoryLabel: { not: null } }, select: { id: true, categoryLabel: true } })
    : [];
  const labelOf = new Map(versions.map((v) => [v.id, (v.categoryLabel ?? "").trim()]));
  const by = new Map<string, { topicCount: number; scriptCount: number; sample: string[] }>();
  const at = (label: string) => { let r = by.get(label); if (!r) { r = { topicCount: 0, scriptCount: 0, sample: [] }; by.set(label, r); } return r; };
  for (const g of groups) {
    const label = g.pillar ?? "";
    if (!label.trim() || NO_PILLAR_LABEL.test(label.trim())) continue;
    at(label).topicCount += g._count;
  }
  for (const [label, r] of by) r.sample = (await prisma.contentTopic.findMany({ where: { enrollmentId, pillarId: null, pillar: label }, select: { title: true }, take: 3 })).map((t) => t.title);
  for (const s of scripts) {
    const label = labelOf.get(s.currentVersionId!);
    if (!label || NO_PILLAR_LABEL.test(label)) continue;
    const r = at(label);
    r.scriptCount++;
    if (r.sample.length < 3) r.sample.push(`script: ${s.title}`);
  }
  const active = pillars.filter((p) => p.status !== "RETIRED").map((p) => ({ id: p.id, name: p.name, aliases: p.aliases }));
  const rows: UnlinkedPillarLabel[] = [];
  for (const [label, r] of by) {
    const match = await matchConfirmedPillar(enrollmentId, label, { pillars, activeOnly: true });
    rows.push({ label, ...r, match, reason: match ? null : closestPillar(label, active).reason, dismissed: dismissed.has(label) });
  }
  rows.sort((a, b) => b.topicCount + b.scriptCount - (a.topicCount + a.scriptCount) || a.label.localeCompare(b.label));
  return rows;
}

/**
 * Link one free-text label to one of the client's confirmed pillars: every
 * topic of this enrollment carrying the label with no pillarId gets the
 * pillar and a RECONCILED event on its history (who, and why), and every
 * script whose current version carries it as its Category (and no pillar) is
 * filed under the pillar, with an audit-log row. A script's words, versions,
 * approvals and sharing are untouched, and its updatedAt is kept (the "latest
 * script of a topic" readers sort by it). Refuses another client's pillar and
 * a retired one. Creates no pillar, and adds no alias: the pillar's names stay
 * its own (a matched label is not a name, and as an alias "Seller Education /
 * Buyer Education" would pull "Buyer Education" onto the seller pillar next
 * time); the same rule gives the same answer for the same label anyway.
 */
export async function linkPillarLabel(enrollmentId: string, label: string, pillarId: string, by: string, opts: { why?: string | null; actorKind?: "STAFF" | "SYSTEM" } = {}): Promise<{ topics: number; scripts: number }> {
  const pillar = await prisma.contentPillar.findUnique({ where: { id: pillarId }, select: { id: true, enrollmentId: true, name: true, status: true } });
  if (!pillar || pillar.enrollmentId !== enrollmentId) throw new Error("That pillar belongs to another client.");
  if (pillar.status === "RETIRED") throw new Error(`“${pillar.name}” is retired; link the label to one of the client's current pillars.`);
  const why = opts.why?.trim() ? ` (${opts.why.trim()})` : "";
  const topics = await prisma.contentTopic.findMany({ where: { enrollmentId, pillarId: null, pillar: label }, select: { id: true } });
  if (topics.length) {
    await prisma.contentTopic.updateMany({ where: { id: { in: topics.map((t) => t.id) }, pillarId: null }, data: { pillarId, lastEventAt: new Date() } });
    await prisma.contentTopicEvent.createMany({
      data: topics.map((t) => ({ topicId: t.id, enrollmentId, kind: "RECONCILED", actorKind: opts.actorKind ?? "STAFF", staffUserId: by, note: `Pillar label “${label}” linked to the confirmed pillar “${pillar.name}”${why}`.slice(0, 2000), sourceRef: `pillar:${pillarId}` })),
    });
  }
  const candidates = await prisma.contentScript.findMany({ where: { enrollmentId, pillarId: null, currentVersionId: { not: null } }, select: { id: true, currentVersionId: true, updatedAt: true } });
  const labelled = candidates.length
    ? new Set((await prisma.contentScriptVersion.findMany({ where: { id: { in: candidates.map((s) => s.currentVersionId!) }, pillarId: null, categoryLabel: label }, select: { id: true } })).map((v) => v.id))
    : new Set<string>();
  let scripts = 0;
  for (const s of candidates.filter((x) => labelled.has(x.currentVersionId!))) {
    const w = await prisma.contentScript.updateMany({ where: { id: s.id, pillarId: null }, data: { pillarId, updatedAt: s.updatedAt } });
    if (!w.count) continue;
    scripts++;
    await prisma.auditLog.create({ data: { actor: by, action: "script_pillar_linked", target: s.id, detail: `Category “${label}” linked to the confirmed pillar “${pillar.name}” (${pillarId})${why}. Words, versions and sharing untouched.`.slice(0, 1000) } });
  }
  return { topics: topics.length, scripts };
}

/** Labels Jordan said "Not a pillar" to on the old mapping section (kept so the Oct 23 repair leaves them as he left them). */
export async function dismissedPillarLabels(enrollmentId: string): Promise<Set<string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: `pillar-dismissed-${enrollmentId}` } });
  try { return new Set(row ? (JSON.parse(row.value) as string[]) : []); } catch { return new Set(); }
}

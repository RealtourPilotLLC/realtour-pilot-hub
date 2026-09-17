import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { createScriptVersion, partsFromBody } from "@/lib/contentScripts";
import { createTopic, topicDedupeHash } from "@/lib/contentTopics";
import { importStrategyVersion } from "@/lib/contentStrategy";
import { resolvePillarByLabel } from "@/lib/contentPillars";
import { splitDeliveredScripts, parseDeliveredScript, parseTopicBankDocument, parseStrategyDocument, normalizeTitle } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Imports (spec §14): PREVIEW writes nothing; APPLY creates one
// ContentImportBatch per source file (unique on kind+contentHash, so a
// re-upload re-opens the same batch) and one ContentImportItem per parsed
// item (unique on batchId+sourceHash) with the verbatim source text kept
// whole. Per item the proposed mode is CREATE / LINK / UPDATE_PROPOSAL /
// CONFLICT / SKIP. Nothing an import creates is approved, filmed or released:
// scripts land historical, topics land PROPOSED, a strategy lands as a
// version for Jordan to approve.
//
// The planning-month rule (Jordan: "April doc = May content") is a PROPOSAL
// per client — document month → proposed month — that he confirms on the
// preview; there is no bulk move anywhere.
// ---------------------------------------------------------------------------

export type ImportKind = "SCRIPTS" | "TOPICS" | "STRATEGY";
export type ItemMode = "CREATE" | "LINK" | "UPDATE_PROPOSAL" | "CONFLICT" | "SKIP";

export type PreviewItem = {
  ordinal: number; kind: "SCRIPT" | "TOPIC" | "STRATEGY_SECTION"; sourceHash: string; sourceText: string; title: string;
  parsed: Record<string, unknown>; proposedMode: ItemMode; targetKind: string | null; targetId: string | null; targetTitle: string | null;
  pillarLabel: string | null; pillarId: string | null; importedMark: string | null; proposedState: string | null; conflictNote: string | null; warnings: string[];
};

export type ImportPreview = {
  kind: ImportKind; enrollmentId: string; fileName: string; contentHash: string; existingBatchId: string | null; existingBatchMode: string | null;
  documentMonthKey: string | null; proposedMonthKey: string | null; monthRule: string;
  items: PreviewItem[]; counts: Record<ItemMode, number>; unmappedPillarLabels: string[]; notes: string[];
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function monthFromText(name: string): string | null {
  const lower = name.toLowerCase();
  const iso = lower.match(/\b(20\d{2})[-_ ](0[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const idx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(lower));
  if (idx === -1) return null;
  const yr = lower.match(/\b(20\d{2})\b/);
  const year = yr ? yr[1] : String(new Date().getUTCFullYear());
  return `${year}-${String(idx + 1).padStart(2, "0")}`;
}
export function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const normText = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** Build the preview. Reads only. */
export async function previewImport(opts: { kind: ImportKind; enrollmentId: string; fileName: string; text: string }): Promise<ImportPreview> {
  const text = opts.text.replace(/\r\n?/g, "\n");
  const contentHash = sha256(text);
  const existing = await prisma.contentImportBatch.findUnique({ where: { kind_contentHash: { kind: opts.kind, contentHash } }, select: { id: true, mode: true } });
  const documentMonthKey = monthFromText(opts.fileName) ?? (opts.kind === "SCRIPTS" ? monthFromText(text.slice(0, 400)) : null);
  const proposedMonthKey = documentMonthKey ? nextMonthKey(documentMonthKey) : null;
  const notes: string[] = [];
  const items: PreviewItem[] = [];
  const unmapped = new Set<string>();

  if (opts.kind === "SCRIPTS") {
    const { preamble, scripts } = splitDeliveredScripts(text);
    if (preamble) notes.push(`Document preamble kept aside (${preamble.split("\n").length} lines).`);
    const existingScripts = await prisma.contentScript.findMany({ where: { enrollmentId: opts.enrollmentId }, select: { id: true, title: true, body: true, importItemId: true, historical: true } });
    // THIS client's earlier batches only — Arielle reuses script text across
    // agents, and a link across clients would hand client B client A's script id.
    const ownBatches = (await prisma.contentImportBatch.findMany({ where: { enrollmentId: opts.enrollmentId }, select: { id: true } })).map((b) => b.id);
    const priorItems = ownBatches.length ? await prisma.contentImportItem.findMany({ where: { batchId: { in: ownBatches }, kind: "SCRIPT", targetKind: "ContentScript", resultId: { not: null } }, select: { sourceHash: true, resultId: true } }) : [];
    for (const [i, src] of scripts.entries()) {
      const parsed = parseDeliveredScript(src);
      const title = parsed.title || `Script ${i + 1}`;
      const sourceHash = sha256(normText(src));
      const spokenHash = sha256(JSON.stringify({ h: parsed.hook?.text, p: parsed.points.map((p) => p.text), c: parsed.close?.text }));
      let mode: ItemMode = "CREATE", targetId: string | null = null, targetTitle: string | null = null, conflictNote: string | null = null;
      const byPrior = priorItems.find((p) => p.sourceHash === sourceHash);
      const same = existingScripts.find((s) => sha256(normText(s.body)) === sourceHash || sha256(JSON.stringify({ h: parseDeliveredScript(s.body).hook?.text, p: parseDeliveredScript(s.body).points.map((p) => p.text), c: parseDeliveredScript(s.body).close?.text })) === spokenHash);
      const sameTitle = existingScripts.find((s) => normalizeTitle(s.title) === normalizeTitle(title));
      if (byPrior?.resultId || same) { mode = "LINK"; targetId = byPrior?.resultId ?? same!.id; targetTitle = same?.title ?? title; }
      else if (sameTitle) { mode = "UPDATE_PROPOSAL"; targetId = sameTitle.id; targetTitle = sameTitle.title; conflictNote = sameTitle.historical ? "A historical script with this title exists with different text — proposing it as a further import version of that record (its filmed text stays as is)." : "A LIVE script with this title exists with different text — the import is kept on this item as a proposal for a person to apply by hand; it never becomes a draft of the live script."; }
      const pillarLabel = parsed.pillarRef?.pillarName ?? null;
      const pillarId = pillarLabel ? await resolvePillarByLabel(opts.enrollmentId, pillarLabel) : null;
      if (pillarLabel && !pillarId) unmapped.add(pillarLabel);
      if (!parsed.hook && !parsed.points.length && !parsed.close) { mode = "SKIP"; conflictNote = "No HOOK / TALKING POINT / CLOSE labels — not a scripted piece (a header or an unscripted plan)."; }
      items.push({ ordinal: i + 1, kind: "SCRIPT", sourceHash, sourceText: src, title, parsed: { number: parsed.number, points: parsed.points.length, category: parsed.pillarRef?.categoryAsDelivered ?? null, placeholders: parsed.internal.placeholders, warnings: parsed.parseWarnings }, proposedMode: mode, targetKind: targetId ? "ContentScript" : null, targetId, targetTitle, pillarLabel, pillarId, importedMark: null, proposedState: null, conflictNote, warnings: parsed.parseWarnings });
    }
  } else if (opts.kind === "TOPICS") {
    const bank = parseTopicBankDocument(text, { source: "IMPORTED", sourceRef: opts.fileName });
    if (bank.warnings.length) notes.push(...bank.warnings.slice(0, 5));
    const existingTopics = await prisma.contentTopic.findMany({ where: { enrollmentId: opts.enrollmentId }, select: { id: true, title: true, dedupeHash: true, concept: true } });
    let ordinal = 0;
    for (const p of bank.pillars) {
      const pillarId = await resolvePillarByLabel(opts.enrollmentId, p.name);
      if (!pillarId) unmapped.add(p.name);
      for (const t of p.topics) {
        ordinal++;
        const srcText = `${p.name}\n${t.title}${t.description ? `\n${t.description}` : ""}`;
        const sourceHash = sha256(normText(srcText));
        const hash = topicDedupeHash(t.title);
        const same = existingTopics.find((x) => x.dedupeHash === hash || normalizeTitle(x.title) === normalizeTitle(t.title));
        let mode: ItemMode = "CREATE", conflictNote: string | null = null;
        if (same) { mode = t.description && same.concept && normalizeTitle(same.concept) !== normalizeTitle(t.description) ? "UPDATE_PROPOSAL" : "LINK"; if (mode === "UPDATE_PROPOSAL") conflictNote = "Same title, different description — proposing the description as an edit for confirmation."; }
        const mark = t.importedMark ?? null;
        items.push({ ordinal, kind: "TOPIC", sourceHash, sourceText: srcText, title: t.title, parsed: { description: t.description, pillar: p.name }, proposedMode: mode, targetKind: same ? "ContentTopic" : null, targetId: same?.id ?? null, targetTitle: same?.title ?? null, pillarLabel: p.name, pillarId, importedMark: mark, proposedState: mark ? (/(red|bold-red)/i.test(mark) ? "SCRIPTED" : /green|bold/i.test(mark) ? "SELECTED" : /turquoise|cyan/i.test(mark) ? "PARKED" : null) : null, conflictNote, warnings: [] });
      }
    }
  } else {
    const parsed = parseStrategyDocument(text);
    const sourceHash = sha256(normText(text));
    const existingV = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: opts.enrollmentId, contentHash: sha256(JSON.stringify(parsed.sections.map((s) => s.heading))) }, select: { id: true, versionNo: true } });
    const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: opts.enrollmentId, status: "APPROVED" }, select: { id: true, versionNo: true } });
    items.push({ ordinal: 1, kind: "STRATEGY_SECTION", sourceHash, sourceText: text, title: parsed.title || opts.fileName, parsed: { structureVersion: parsed.structureVersion, sections: parsed.sections.map((s) => s.heading), pillars: parsed.contentPillars.pillars.map((p) => p.name), warnings: parsed.warnings }, proposedMode: existingV ? "LINK" : approved ? "UPDATE_PROPOSAL" : "CREATE", targetKind: "ContentStrategy", targetId: existingV?.id ?? approved?.id ?? null, targetTitle: approved ? `approved v${approved.versionNo}` : null, pillarLabel: null, pillarId: null, importedMark: null, proposedState: null, conflictNote: approved ? "An approved strategy exists — this becomes a NEW version for approval; nothing is overwritten." : null, warnings: parsed.warnings });
    for (const p of parsed.contentPillars.pillars) if (!(await resolvePillarByLabel(opts.enrollmentId, p.name))) unmapped.add(p.name);
  }
  const counts: Record<ItemMode, number> = { CREATE: 0, LINK: 0, UPDATE_PROPOSAL: 0, CONFLICT: 0, SKIP: 0 };
  for (const it of items) counts[it.proposedMode]++;
  return {
    kind: opts.kind, enrollmentId: opts.enrollmentId, fileName: opts.fileName, contentHash, existingBatchId: existing?.id ?? null, existingBatchMode: existing?.mode ?? null,
    documentMonthKey, proposedMonthKey, monthRule: documentMonthKey ? `The document names ${documentMonthKey}; Jordan's rule files that content under the following month (${proposedMonthKey}). Confirm or change per client — nothing moves in bulk.` : "No month named in the document — pick the month the content belongs to.",
    items, counts, unmappedPillarLabels: [...unmapped], notes,
  };
}

/**
 * Apply a previewed import with per-item decisions. Idempotent: the batch is
 * keyed by (kind, contentHash), each item by (batchId, sourceHash); an item
 * already applied is not applied twice.
 */
export async function applyImport(preview: ImportPreview, decisions: { monthKey: string | null; modes: Record<number, ItemMode>; pillarMap?: Record<string, string | null> }, by: string): Promise<{ batchId: string; created: number; linked: number; updated: number; skipped: number; conflicts: number }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: preview.enrollmentId }, select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true } });
  if (!e) throw new Error("Enrollment not found.");
  const batch = await prisma.contentImportBatch.upsert({
    where: { kind_contentHash: { kind: preview.kind, contentHash: preview.contentHash } },
    create: { kind: preview.kind, enrollmentId: e.id, clientId: e.clientId, fileName: preview.fileName, contentHash: preview.contentHash, proposedMonthKey: decisions.monthKey ?? preview.proposedMonthKey, mode: "PREVIEW", previewJson: JSON.stringify({ counts: preview.counts, month: decisions.monthKey }), uploadedBy: by },
    update: { proposedMonthKey: decisions.monthKey ?? preview.proposedMonthKey },
    select: { id: true },
  });
  let monthId: string | null = null;
  if (decisions.monthKey && preview.kind !== "STRATEGY") {
    if (!/^\d{4}-\d{2}$/.test(decisions.monthKey)) throw new Error("Pick a month.");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const m = await prisma.contentMonth.upsert({
      where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: decisions.monthKey } }, update: {},
      create: { enrollmentId: e.id, clientId: e.clientId, monthKey: decisions.monthKey, videosOwed: e.videosPerMonth, strategyCallStatus: e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED", ...(decisions.monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}) },
      select: { id: true },
    });
    monthId = m.id;
  }
  let created = 0, linked = 0, updated = 0, skipped = 0, conflicts = 0;
  for (const it of preview.items) {
    const mode = decisions.modes[it.ordinal] ?? it.proposedMode;
    const existingItem = await prisma.contentImportItem.findUnique({ where: { batchId_sourceHash: { batchId: batch.id, sourceHash: it.sourceHash } }, select: { id: true, resultId: true, decidedMode: true } });
    if (existingItem?.decidedMode) { skipped++; continue; } // already applied in a previous run
    const pillarId = decisions.pillarMap?.[it.pillarLabel ?? ""] ?? it.pillarId ?? null;
    const item = existingItem ?? await prisma.contentImportItem.create({
      data: { batchId: batch.id, ordinal: it.ordinal, kind: it.kind, sourceHash: it.sourceHash, sourceText: it.sourceText, parsedJson: JSON.stringify(it.parsed), proposedMode: it.proposedMode, targetKind: it.targetKind, targetId: it.targetId, proposedMonthKey: decisions.monthKey, importedMark: it.importedMark, proposedState: it.proposedState, pillarLabel: it.pillarLabel, conflictNote: it.conflictNote },
      select: { id: true, resultId: true, decidedMode: true },
    });
    let resultId: string | null = null;
    try {
      if (mode === "SKIP") { skipped++; }
      else if (mode === "CONFLICT") { conflicts++; }
      else if (mode === "LINK") { resultId = it.targetId; linked++; }
      else if (it.kind === "SCRIPT") {
        const parts = partsFromBody(it.title, it.sourceText);
        parts.pillarId = pillarId;
        const target = mode === "UPDATE_PROPOSAL" && it.targetId ? await prisma.contentScript.findUnique({ where: { id: it.targetId }, select: { historical: true } }) : null;
        if (mode === "UPDATE_PROPOSAL" && target && !target.historical) {
          // Never a draft of a LIVE script (it would enter the review queue and,
          // with no approved version, become the body the portal serves). The
          // text stays on the item as a proposal; a person applies it by hand.
          await prisma.contentImportItem.update({ where: { id: item.id }, data: { conflictNote: `Proposed text for the live script “${it.targetTitle ?? it.title}” — kept here, not applied; edit that script by hand if the import is the better version.` } });
          resultId = it.targetId; updated++;
        } else {
          const r = await createScriptVersion({ scriptId: mode === "UPDATE_PROPOSAL" ? it.targetId : null, enrollmentId: e.id, monthId, parts, source: "IMPORT", importItemId: item.id, createdBy: by, historical: true, sourceFile: preview.fileName, changeSummary: `Imported from ${preview.fileName}${mode === "UPDATE_PROPOSAL" ? " as a further import version of a historical record (its filmed text untouched)" : ""}` });
          resultId = mode === "UPDATE_PROPOSAL" ? r.versionId : r.scriptId;
          if (mode === "UPDATE_PROPOSAL") updated++; else created++;
        }
      } else if (it.kind === "TOPIC") {
        if (mode === "UPDATE_PROPOSAL" && it.targetId) {
          // The description arrives as a proposal: stored on the item, applied only if Jordan edits the topic.
          await prisma.contentImportItem.update({ where: { id: item.id }, data: { conflictNote: `Proposed description: ${String(it.parsed.description ?? "")}` } });
          resultId = it.targetId; updated++;
        } else {
          const r = await createTopic({ enrollmentId: e.id, title: it.title, concept: (it.parsed.description as string | null) ?? null, pillarId, pillarLabel: it.pillarLabel, source: "import", sourceRef: `${preview.fileName}#${it.ordinal}`, importItemId: item.id, status: "SAVED", approvalState: "PROPOSED", importedMark: it.importedMark, proposedState: it.proposedState, actor: { kind: "IMPORT", staffUserId: by }, note: `Imported from ${preview.fileName}` });
          resultId = r.id; if (r.existed) linked++; else created++;
        }
      } else {
        const r = await importStrategyVersion({ enrollmentId: e.id, text: it.sourceText, fileName: preview.fileName, createdBy: by, importItemId: item.id });
        resultId = r.versionId; if (r.existed) linked++; else created++;
      }
      await prisma.contentImportItem.update({ where: { id: item.id }, data: { decidedMode: mode, decidedBy: by, decidedAt: new Date(), resultId, targetId: it.targetId ?? (mode === "LINK" ? resultId : undefined) } });
    } catch (err) {
      await prisma.contentImportItem.update({ where: { id: item.id }, data: { error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) } });
      conflicts++;
    }
  }
  await prisma.contentImportBatch.update({ where: { id: batch.id }, data: { mode: "APPLIED", appliedAt: new Date(), appliedBy: by, itemsCreated: { increment: created }, itemsLinked: { increment: linked }, itemsUpdated: { increment: updated }, itemsConflict: { increment: conflicts }, itemsSkipped: { increment: skipped } } });
  return { batchId: batch.id, created, linked, updated, skipped, conflicts };
}

export async function importBatches(enrollmentId: string) {
  return prisma.contentImportBatch.findMany({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, take: 20 });
}

// ---------------------------------------------------------------------------
// Review items — mis-filed records surface, nothing is auto-fixed (§14):
//  • a month whose transcript names another enrolled client in its header
//    (Mike Flatley's Feb call on Gary Mercer Sr);
//  • a month with far more SELECTED topics than it owes (Erica's 103);
//  • import items that errored or were marked CONFLICT.
// ---------------------------------------------------------------------------
export type ReviewItem = { kind: "MISFILED_TRANSCRIPT" | "OVER_SELECTED_MONTH" | "IMPORT_CONFLICT"; monthId: string | null; monthKey: string | null; title: string; detail: string; ref: string };

export async function importReviewItems(enrollmentId: string): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return out;
  const [client, others, months] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    prisma.contentEnrollment.findMany({ where: { id: { not: enrollmentId } }, select: { clientId: true } }),
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true, videosOwed: true, transcriptText: true, transcriptSource: true } }),
  ]);
  const otherNames = (await prisma.client.findMany({ where: { id: { in: others.map((o) => o.clientId) } }, select: { name: true } })).map((c) => c.name).filter((n) => n && n.split(" ").length >= 2);
  const first = (client?.name ?? "").split(" ")[0];
  for (const m of months) {
    const head = (m.transcriptText ?? "").slice(0, 600);
    if (head) {
      const named = otherNames.find((n) => head.includes(n) || head.includes(n.split(" ").slice(0, 2).join(" ")));
      if (named && first && !head.includes(first)) out.push({ kind: "MISFILED_TRANSCRIPT", monthId: m.id, monthKey: m.monthKey, title: `${m.monthKey}: transcript header names ${named}`, detail: `The transcript on this month opens with “${head.split("\n")[0].slice(0, 90)}” and never mentions ${first}. It may belong to ${named}'s file — a human decides; nothing is moved automatically.`, ref: m.transcriptSource ?? m.id });
    }
    const selected = await prisma.contentTopic.count({ where: { monthId: m.id, status: "SELECTED" } });
    if (m.videosOwed > 0 && selected > m.videosOwed * 3) out.push({ kind: "OVER_SELECTED_MONTH", monthId: m.id, monthKey: m.monthKey, title: `${m.monthKey}: ${selected} topics marked selected for ${m.videosOwed} videos`, detail: `Most of these were probably a whole idea bank saved as “selected”. Move them back to the bank one by one (or accept the capacity overflow) — no bulk change is made.`, ref: m.id });
  }
  const bad = await prisma.contentImportItem.findMany({ where: { OR: [{ error: { not: null } }, { decidedMode: "CONFLICT" }], batchId: { in: (await prisma.contentImportBatch.findMany({ where: { enrollmentId }, select: { id: true } })).map((b) => b.id) } }, select: { id: true, ordinal: true, kind: true, conflictNote: true, error: true, batchId: true }, take: 50 }).catch(() => []);
  for (const b of bad) out.push({ kind: "IMPORT_CONFLICT", monthId: null, monthKey: null, title: `Import item #${b.ordinal} (${b.kind.toLowerCase()})`, detail: b.error ?? b.conflictNote ?? "Marked as a conflict on apply.", ref: b.id });
  return out;
}

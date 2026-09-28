import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isIssueCause, type IssueCause } from "@/lib/issueCauses";

// ---------------------------------------------------------------------------
// REWORK COST (unified handoff §10, AU-26 / I4, Sep 26 2026).
//
// What a redo ACTUALLY cost, with the evidence for each figure. Until now the
// only recorded fact was a revision round's fee and whether the office charged
// or waived it; editor labour, a vendor re-run, a reshoot's travel and pay, a
// refund or a credit lived nowhere. So every job margin was a MODEL (the rate
// table in jobProfit.ts) and nothing said so next to it.
//
// THE RULES:
//   · An actual is a recorded fact with evidence (a QuickBooks row, a Stripe
//     refund, a payroll line, a revision round) or a person's own entry marked
//     manual. An estimate says it is one. Missing is UNKNOWN — a job with no
//     rows reads "none recorded", never $0.
//   · Rework sits BESIDE the modelled margin. It is never subtracted into an
//     "actual profit": the margin is a model and an actual minus a model is
//     neither.
//   · Nothing is attached automatically except one thing the hub itself
//     decided: a waived extra-round fee is revenue given up, derived here
//     idempotently from ContentRevisionRound (feeDecision WAIVE). Refunds and
//     credits are OFFERED as candidates on the owner's panel; a person picks.
//   · Voiding keeps the row. History is not deleted.
// ---------------------------------------------------------------------------

export const REWORK_KINDS = ["EDITOR_LABOR", "VENDOR", "TRAVEL", "RESHOOT_PAY", "REFUND", "CREDIT", "WAIVED_REVENUE", "OTHER"] as const;
export type ReworkKind = (typeof REWORK_KINDS)[number];
export const REWORK_KIND_LABEL: Record<ReworkKind, string> = {
  EDITOR_LABOR: "Editor time",
  VENDOR: "Vendor re-run",
  TRAVEL: "Travel",
  RESHOOT_PAY: "Reshoot pay",
  REFUND: "Refund",
  CREDIT: "Credit given",
  WAIVED_REVENUE: "Fee waived",
  OTHER: "Other",
};
export const isReworkKind = (v: unknown): v is ReworkKind => typeof v === "string" && (REWORK_KINDS as readonly string[]).includes(v);

const SYSTEM_WAIVER = "system:fee-waiver";

/**
 * A waived extra-round fee is revenue the business chose not to take. One row
 * per round, ever (evidenceRef "round:<id>" + kind is unique), however often
 * this runs. A round whose waiver is later reversed has its row VOIDED, not
 * deleted; waived again, the same row comes back.
 */
export async function deriveWaivedRevenue(): Promise<{ created: number; voided: number; restored: number }> {
  const rounds = await prisma.contentRevisionRound.findMany({
    where: { feeDecision: "WAIVE", feeCents: { gt: 0 } },
    select: { id: true, projectId: true, outputId: true, revisionBriefId: true, feeCents: true, feeDecidedAt: true, feeDecidedBy: true, feeDecisionNote: true },
  });
  let created = 0, restored = 0, voided = 0;
  const existing = new Map(
    (await prisma.reworkCost.findMany({ where: { kind: "WAIVED_REVENUE", evidenceRef: { startsWith: "round:" } }, select: { id: true, evidenceRef: true, voidedAt: true, voidedBy: true } }))
      .map((r) => [r.evidenceRef, r]),
  );
  const waived = new Set<string>();
  for (const r of rounds) {
    const ref = `round:${r.id}`;
    waived.add(ref);
    const prior = existing.get(ref);
    if (prior) {
      if (prior.voidedAt && prior.voidedBy === SYSTEM_WAIVER) {
        await prisma.reworkCost.update({ where: { id: prior.id }, data: { voidedAt: null, voidedBy: null } });
        restored++;
      }
      continue;
    }
    try {
      await prisma.reworkCost.create({
        data: {
          projectId: r.projectId,
          outputId: r.outputId,
          revisionBriefId: r.revisionBriefId,
          roundId: r.id,
          // The office waived it; the round's own cause is the reviewer's call
          // and is not guessed here.
          kind: "WAIVED_REVENUE",
          amountCents: r.feeCents!,
          basis: "actual",
          evidenceRef: ref,
          enteredBy: SYSTEM_WAIVER,
          enteredAt: r.feeDecidedAt ?? new Date(),
          note: [`Extra revision round fee waived${r.feeDecidedBy ? ` by ${r.feeDecidedBy}` : ""}`, r.feeDecisionNote].filter(Boolean).join(" — ").slice(0, 500),
        },
      });
      created++;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
  }
  // A waiver that was reversed (now CHARGE, or cleared) is no longer revenue
  // given up. Only the system's own rows are voided by the system.
  for (const [ref, row] of existing) {
    if (waived.has(ref) || row.voidedAt) continue;
    await prisma.reworkCost.update({ where: { id: row.id }, data: { voidedAt: new Date(), voidedBy: SYSTEM_WAIVER } });
    voided++;
  }
  return { created, voided, restored };
}

export type ReworkInput = {
  projectId: string;
  kind: string;
  amountCents: number;
  basis: string;
  /** "manual", or a picked candidate: "stripe:<txn>", "qbo:<id>", "round:<id>", "payroll:<ref>" */
  evidenceRef: string;
  issueCause?: string | null;
  note?: string | null;
  outputId?: string | null;
  enteredBy: string;
};

/** An owner's entry. The caller has already checked the owner; this checks the facts. */
export async function addReworkCost(input: ReworkInput): Promise<{ ok: boolean; message: string; id?: string }> {
  if (!isReworkKind(input.kind)) return { ok: false, message: "Pick what kind of cost it was." };
  if (input.kind === "WAIVED_REVENUE") return { ok: false, message: "Waived fees are recorded from the revision round itself — they can't be typed in." };
  if (input.basis !== "actual" && input.basis !== "estimate") return { ok: false, message: "Say whether this is an actual cost or an estimate." };
  const cents = Math.round(Number(input.amountCents));
  if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000) return { ok: false, message: "Enter the amount." };
  const cause: IssueCause | null = input.issueCause ? (isIssueCause(input.issueCause) ? input.issueCause : null) : null;
  if (input.issueCause && !cause) return { ok: false, message: "That cause isn't one of the revision causes." };
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, clientId: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };

  let evidenceRef = input.evidenceRef.trim();
  let roundId: string | null = null;
  let revisionBriefId: string | null = null;
  if (evidenceRef === "manual" || evidenceRef === "") {
    // A unique ref per manual row keeps (evidenceRef, kind) unique without
    // pretending two hand entries are the same evidence.
    evidenceRef = `manual:${crypto.randomUUID()}`;
  } else if (evidenceRef.startsWith("stripe:")) {
    const t = await prisma.stripeTransaction.findUnique({ where: { id: evidenceRef.slice(7) }, select: { id: true } });
    if (!t) return { ok: false, message: "That Stripe record isn't in the hub's ledger." };
  } else if (evidenceRef.startsWith("qbo:")) {
    const t = await prisma.qboTransaction.findUnique({ where: { id: evidenceRef.slice(4) }, select: { id: true } });
    if (!t) return { ok: false, message: "That QuickBooks record isn't in the hub's ledger." };
  } else if (evidenceRef.startsWith("round:")) {
    const r = await prisma.contentRevisionRound.findUnique({ where: { id: evidenceRef.slice(6) }, select: { id: true, projectId: true, revisionBriefId: true } });
    if (!r || r.projectId !== project.id) return { ok: false, message: "That revision round isn't on this job." };
    roundId = r.id;
    revisionBriefId = r.revisionBriefId;
  } else if (!/^payroll:[\w:.-]{1,120}$/.test(evidenceRef)) {
    return { ok: false, message: "Pick the evidence from the list, or choose manual." };
  }
  try {
    const row = await prisma.reworkCost.create({
      data: {
        projectId: project.id,
        outputId: input.outputId || null,
        roundId,
        revisionBriefId,
        issueCause: cause,
        kind: input.kind,
        amountCents: cents,
        basis: input.basis,
        evidenceRef,
        enteredBy: input.enteredBy,
        note: input.note?.trim().slice(0, 500) || null,
      },
      select: { id: true },
    });
    return { ok: true, message: "Recorded.", id: row.id };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, message: `That evidence is already recorded as ${REWORK_KIND_LABEL[input.kind]} — void that row first if its figure was wrong.` };
    }
    throw e;
  }
}

/**
 * Void a person's row. The row stays — amount, who, when — and its evidence
 * reference gets a "#void" suffix, so the same refund or payroll line can be
 * recorded again with the right figure (the pair is unique). A derived waiver
 * row is not a person's to void: it follows the round's own fee decision.
 */
export async function voidReworkCost(id: string, by: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.reworkCost.findUnique({ where: { id }, select: { voidedAt: true, enteredBy: true, evidenceRef: true } });
  if (!row || row.voidedAt) return { ok: false, message: "Already voided, or gone." };
  if (row.enteredBy.startsWith("system:")) return { ok: false, message: "A waived fee follows the revision round's decision — change it there." };
  const r = await prisma.reworkCost.updateMany({
    where: { id, voidedAt: null },
    data: { voidedAt: new Date(), voidedBy: by, evidenceRef: `${row.evidenceRef}#void:${id}`.slice(0, 190) },
  });
  return r.count ? { ok: true, message: "Voided — the row stays in the history." } : { ok: false, message: "Already voided, or gone." };
}

export type ReworkTotals = { actualCents: number | null; estimateCents: number | null; rows: number };

/** Live rows per project → cents by basis. A project with no live rows is
 *  absent from the map, so a reader gets `undefined` → null, never 0. */
export async function reworkByProject(projectIds: string[]): Promise<Map<string, ReworkTotals>> {
  const out = new Map<string, ReworkTotals>();
  if (!projectIds.length) return out;
  const rows = await prisma.reworkCost.findMany({
    where: { projectId: { in: projectIds }, voidedAt: null },
    select: { projectId: true, amountCents: true, basis: true },
  });
  for (const r of rows) {
    const t = out.get(r.projectId) ?? { actualCents: null, estimateCents: null, rows: 0 };
    if (r.basis === "actual") t.actualCents = (t.actualCents ?? 0) + r.amountCents;
    else t.estimateCents = (t.estimateCents ?? 0) + r.amountCents;
    t.rows++;
    out.set(r.projectId, t);
  }
  return out;
}

/**
 * Cause-tagged rework, for the §8 editor-development view. Only rows a person
 * tagged with a cause are counted; untagged rows are reported as such, never
 * guessed at (§8.3: "unknown historic causes stay unknown").
 */
export async function reworkByCause(opts: { since?: Date } = {}): Promise<{ cause: IssueCause | "UNTAGGED"; actualCents: number; estimateCents: number; rows: number }[]> {
  const rows = await prisma.reworkCost.findMany({
    where: { voidedAt: null, ...(opts.since ? { enteredAt: { gte: opts.since } } : {}) },
    select: { issueCause: true, amountCents: true, basis: true },
  });
  const acc = new Map<string, { actualCents: number; estimateCents: number; rows: number }>();
  for (const r of rows) {
    const k = r.issueCause && isIssueCause(r.issueCause) ? r.issueCause : "UNTAGGED";
    const a = acc.get(k) ?? { actualCents: 0, estimateCents: 0, rows: 0 };
    if (r.basis === "actual") a.actualCents += r.amountCents;
    else a.estimateCents += r.amountCents;
    a.rows++;
    acc.set(k, a);
  }
  return [...acc.entries()].map(([cause, v]) => ({ cause: cause as IssueCause | "UNTAGGED", ...v }));
}

export type EvidenceCandidate = { ref: string; label: string; kindHint: ReworkKind };

/**
 * What the owner may attach, for one job: Stripe refunds tied to it or to its
 * client's name, QuickBooks refunds and credit memos under the client's name,
 * and the job's revision rounds. OFFERED, never attached — and anything
 * already recorded is left off.
 */
export async function evidenceCandidates(projectId: string): Promise<EvidenceCandidate[]> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, shootDate: true, createdAt: true, client: { select: { name: true } } } });
  if (!p) return [];
  const anchor = p.shootDate ?? p.createdAt;
  const from = new Date(anchor.getTime() - 30 * 86_400_000);
  const to = new Date(anchor.getTime() + 120 * 86_400_000);
  const name = p.client?.name?.trim() ?? "";
  const [stripe, qbo, rounds, used] = await Promise.all([
    prisma.stripeTransaction.findMany({
      where: {
        type: { in: ["refund", "payment_refund"] },
        OR: [{ projectId: p.id }, ...(name ? [{ customerName: { equals: name, mode: "insensitive" as const }, createdAt: { gte: from, lte: to } }] : [])],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, gross: true, createdAt: true, description: true },
    }).catch(() => []),
    name
      ? prisma.qboTransaction.findMany({
          where: { type: { in: ["RefundReceipt", "CreditMemo"] }, customerName: { equals: name, mode: "insensitive" }, txnDate: { gte: from, lte: to } },
          orderBy: { txnDate: "desc" },
          take: 10,
          select: { id: true, type: true, amount: true, txnDate: true, docNumber: true },
        }).catch(() => [])
      : Promise.resolve([]),
    prisma.contentRevisionRound.findMany({
      where: { projectId: p.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, ordinal: true, videoKey: true, feeDecision: true, feeCents: true },
    }).catch(() => []),
    prisma.reworkCost.findMany({ where: { projectId: p.id, voidedAt: null }, select: { evidenceRef: true } }).catch(() => []),
  ]);
  const taken = new Set(used.map((u) => u.evidenceRef));
  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  const out: EvidenceCandidate[] = [
    ...stripe.map((t) => ({ ref: `stripe:${t.id}`, label: `Stripe refund ${money(t.gross)} · ${t.createdAt.toISOString().slice(0, 10)}${t.description ? ` · ${t.description.slice(0, 40)}` : ""}`, kindHint: "REFUND" as ReworkKind })),
    ...qbo.map((t) => ({ ref: `qbo:${t.id}`, label: `QuickBooks ${t.type === "CreditMemo" ? "credit memo" : "refund"} ${money(t.amount)} · ${t.txnDate.toISOString().slice(0, 10)}${t.docNumber ? ` · #${t.docNumber}` : ""}`, kindHint: (t.type === "CreditMemo" ? "CREDIT" : "REFUND") as ReworkKind })),
    ...rounds.map((r) => ({ ref: `round:${r.id}`, label: `Revision round ${r.ordinal} · ${r.videoKey.slice(0, 30)}${r.feeDecision ? ` · fee ${r.feeDecision.toLowerCase()}` : ""}`, kindHint: "EDITOR_LABOR" as ReworkKind })),
  ];
  return out.filter((c) => !taken.has(c.ref));
}

export type ReworkRowView = {
  id: string;
  kind: ReworkKind;
  amountCents: number;
  basis: "actual" | "estimate";
  evidenceRef: string;
  issueCause: string | null;
  note: string | null;
  enteredBy: string;
  enteredAt: Date;
  voidedAt: Date | null;
  voidedBy: string | null;
};

export async function reworkRowsForProject(projectId: string): Promise<ReworkRowView[]> {
  const rows = await prisma.reworkCost.findMany({ where: { projectId }, orderBy: { enteredAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    kind: (isReworkKind(r.kind) ? r.kind : "OTHER") as ReworkKind,
    amountCents: r.amountCents,
    basis: r.basis === "actual" ? "actual" : "estimate",
    evidenceRef: r.evidenceRef,
    issueCause: r.issueCause,
    note: r.note,
    enteredBy: r.enteredBy,
    enteredAt: r.enteredAt,
    voidedAt: r.voidedAt,
    voidedBy: r.voidedBy,
  }));
}

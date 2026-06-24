import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// "Teach the Hub" — the learning loop. When Jordan (or Kyle) tells the assistant
// a new price/rule/preference, or corrects something it got wrong, we persist it
// as a KnowledgeItem so search_business_knowledge surfaces it from then on. The
// brain stays current instead of drifting back to whatever the export said.
//
// Two safety rails matter here:
//   1. Sensitivity floor — a taught fact is never saved MORE visible than its
//      content warrants. Anything that smells financial/strategic/personnel is
//      forced to OWNER even if the model (or a careless ADMIN) picked a lower
//      tier. Over-restricting is safe; leaking is not.
//   2. Supersede-on-correction — a correction archives the stale fact(s) it
//      replaces so the assistant doesn't return the old value alongside the new.
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };
const VALID_CATEGORIES = new Set([
  "preference", "goal", "issue", "outcome", "sop", "fee", "pricing",
  "client_insight", "strategy", "financial", "team", "comms", "script",
]);

// Words/phrases that make a fact owner-only no matter what tier was requested.
// Deliberately biased toward catching money/strategy/people; a false positive
// just means Kyle/creatives don't see one operational note (safe + correctable).
const OWNER_SENSITIVE =
  /\b(margin|markup|profit|payroll|salary|salaries|wage|wages|commission|payout|payouts|cogs|gross|strateg\w*|acquisi\w*|acquir\w*|personnel|competitor\w*)\b|\bpay\s*rate|\bwe\s+pay\b|\bour\s+cost|\bvendor\s+cost|\bcosts?\s+us\b|\bnet\s+profit\b/i;

// Some categories are inherently owner-only.
const OWNER_CATEGORIES = new Set(["financial", "strategy", "pricing"]);

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function normBody(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}
function tokens(t: string): Set<string> {
  return new Set(normTitle(t).split(" ").filter((w) => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export type LearnResult = {
  ok: boolean;
  id?: string;
  title: string;
  category: string;
  minRole: string;
  superseded: number;
  noop?: boolean; // fact already known verbatim — nothing written
  error?: string;
};

export async function learnFact(input: {
  title: string;
  fact: string;
  category?: string;
  minRole?: string; // tier the model/teacher requested
  teacherRole?: string; // who is teaching (gating happens upstream)
  correction?: boolean;
  source?: string; // default "learned"
  sourceRef?: string | null;
}): Promise<LearnResult> {
  const title = (input.title ?? "").trim().slice(0, 140);
  const fact = (input.fact ?? "").trim().slice(0, 4000);
  if (!title || !fact) {
    return { ok: false, title, category: "preference", minRole: "ADMIN", superseded: 0, error: "Need both a short title and the fact itself." };
  }

  const category = VALID_CATEGORIES.has((input.category ?? "").toLowerCase())
    ? (input.category as string).toLowerCase()
    : "preference";

  // Resolve the visibility tier, then apply the sensitivity floor.
  let minRole = ["OWNER", "ADMIN", "CREATIVE"].includes((input.minRole ?? "").toUpperCase())
    ? (input.minRole as string).toUpperCase()
    : "ADMIN";
  const hay = `${title} ${fact}`;
  if (OWNER_SENSITIVE.test(hay) || OWNER_CATEGORIES.has(category)) {
    if (ROLE_RANK[minRole] < ROLE_RANK.OWNER) minRole = "OWNER";
  }

  // Supersede stale versions so the brain doesn't keep two truths. Always retire
  // an exact same-titled fact; on an explicit correction, also retire close
  // matches (so "rush fee is now $X" cleans up the old rush-fee note).
  let superseded = 0;
  try {
    const candidates = await prisma.knowledgeItem.findMany({
      where: { archived: false, category },
      select: { id: true, title: true, body: true },
      take: 600,
    });
    const nt = normTitle(title);
    const nb = normBody(fact);
    // Already know this verbatim? Do nothing — no duplicate, no churn. (Stops the
    // assistant re-saving a fact every time someone asks about it.)
    const identical = candidates.find((c) => normTitle(c.title) === nt && normBody(c.body) === nb);
    if (identical) {
      return { ok: true, id: identical.id, title, category, minRole, superseded: 0, noop: true };
    }
    const tk = tokens(title);
    const toArchive = candidates
      .filter((c) => {
        const cnt = normTitle(c.title);
        if (cnt === nt) return true;
        if (input.correction) return jaccard(tk, tokens(c.title)) >= 0.6;
        return false;
      })
      .map((c) => c.id)
      .slice(0, 8);
    if (toArchive.length) {
      const r = await prisma.knowledgeItem.updateMany({ where: { id: { in: toArchive } }, data: { archived: true } });
      superseded = r.count;
    }
  } catch {
    // Superseding is best-effort; never block saving the new fact.
  }

  try {
    const item = await prisma.knowledgeItem.create({
      data: {
        category,
        title,
        body: fact,
        minRole,
        source: input.source ?? "learned",
        sourceRef: input.sourceRef ?? `Taught via Ask the Hub${input.teacherRole ? ` (${input.teacherRole})` : ""}`,
        confidence: 5, // explicitly taught = high confidence
        pinned: false,
        archived: false,
      },
      select: { id: true },
    });
    return { ok: true, id: item.id, title, category, minRole, superseded };
  } catch (e) {
    return { ok: false, title, category, minRole, superseded, error: e instanceof Error ? e.message : "Could not save that to memory." };
  }
}

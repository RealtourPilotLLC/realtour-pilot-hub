import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// TRANSACTION-SCOPED ADVISORY LOCKS, in one place (CP-06, Sep 24 2026).
//
// Three files grew the same eight lines — review uploads (one cut slot),
// session requests (one program month) and now the brand profile (one text
// slot). They are lifted here so the one detail that has already broken
// production cannot be forgotten a fourth time: the ::int4 casts.
//
// WHY TWO INT4 KEYS. Prisma sends a JS number as a bigint parameter, and
// Postgres has no pg_advisory_xact_lock(bigint, bigint) — only the one-argument
// bigint form and the two-argument int4 one. Without the casts every call
// raised 42883, the transaction aborted, and (Sep 18) an editor could not
// upload a cut for four hours. Two FNV-1a passes with different seeds give the
// pair: same string → same pair on every worker, different strings →
// different pairs. A collision across strings only ever costs a moment's
// waiting, never correctness. (Two int4s rather than one int8 because the
// build targets below ES2020 — no BigInt literals.)
//
// WHY NOT A UNIQUE INDEX. Every caller here guards a find-or-create whose
// natural key cannot be a unique constraint on the live database: adding one
// through `db push` demands --accept-data-loss, and some of these keys are
// legitimately duplicated by design (a WITHDRAWN cut keeps its number).
// ---------------------------------------------------------------------------

/** The stable int4 pair for `str`. Pure. */
export function advisoryKeyPair(str: string): [number, number] {
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0; // int4, which is what the two-key lock takes
  };
  return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
}

/**
 * Take the transaction-scoped lock for `key` on `tx`. It is released when the
 * transaction ends, however it ends. Re-entrant within one transaction (the
 * same session may take the same advisory lock twice), so a helper that locks
 * may be called from a caller that already holds the lock.
 */
export async function lockAdvisory(tx: Prisma.TransactionClient, key: string): Promise<void> {
  const [a, b] = advisoryKeyPair(key);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
}

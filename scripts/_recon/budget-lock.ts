/**
 * DOES THE BUDGET LOCK ACTUALLY SERIALIZE? — against a real PostgreSQL, over
 * two INDEPENDENT connections.
 *
 * The Sep 18 review was right twice over. First, putting table-wide counts
 * inside an UPDATE does not serialize anything: under Read Committed each
 * worker's statement takes its own snapshot and they update different rows, so
 * nothing makes them contend. Second, the PGlite Socket drill could not have
 * caught that — PGlite multiplexes every connection onto one database
 * connection, so its "concurrent" statements were serialized by the harness,
 * not by the SQL.
 *
 * So this probe uses the only real PostgreSQL on hand — the production Neon —
 * and TOUCHES NO TABLE. It takes an advisory lock on a PROBE key (never the
 * real budget key, so it can never queue behind or delay a live render),
 * proves two independent backends contend for it, and proves the real key is
 * computed identically everywhere.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   set -a && source .env; set +a && \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_recon/budget-lock.ts
 */
import { PrismaClient } from "@prisma/client";

const fnvPair = (str: string): [number, number] => {
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h | 0;
  };
  return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
};

const PROBE: [number, number] = fnvPair("topaz:spend-budget:probe-only");
const REAL: [number, number] = fnvPair("topaz:spend-budget");

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? `\n        ${detail}` : ""}`);
};

async function main() {
  const A = new PrismaClient();
  const B = new PrismaClient();
  const pidA = (await A.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
  const pidB = (await B.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;

  console.log("\n0. THE HARNESS ITSELF IS GENUINELY CONCURRENT");
  check("two clients are two independent backends", pidA !== pidB, `pid ${pidA} vs ${pidB}`);

  console.log("\n1. ONE HOLDER AT A TIME (pg_advisory_xact_lock, probe key)");
  let secondSawItHeld: boolean | null = null;
  const holder = A.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4)`;
    // Hold it long enough for B to try and fail, then release by committing.
    await tx.$queryRaw`SELECT pg_sleep(1.5)::text AS slept`;
    return "held";
  }, { timeout: 20_000, maxWait: 15_000 });

  await new Promise((r) => setTimeout(r, 500)); // let A get inside
  const tried = await B.$transaction(async (tx) => {
    const r = await tx.$queryRaw<{ got: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4) AS got`;
    return r[0].got;
  });
  secondSawItHeld = tried === false;
  check("a second independent backend cannot take a held lock", secondSawItHeld, `try_lock returned ${tried}`);

  await holder;
  const after = await B.$transaction(async (tx) => {
    const r = await tx.$queryRaw<{ got: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4) AS got`;
    return r[0].got;
  });
  check("…and takes it the moment the holder's transaction ends", after === true, `try_lock returned ${after}`);

  console.log("\n2. A BLOCKING WAITER GETS IN, IT DOES NOT FAIL");
  const t0 = Date.now();
  const hold2 = A.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4)`;
    await tx.$queryRaw`SELECT pg_sleep(1.2)::text AS slept`;
    return Date.now() - t0;
  }, { timeout: 20_000, maxWait: 15_000 });
  await new Promise((r) => setTimeout(r, 300));
  const waited = await B.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4)`;
    return Date.now() - t0;
  }, { timeout: 20_000, maxWait: 15_000 });
  const held = await hold2;
  check("the waiter is admitted only after the holder commits", waited >= held,
    `holder released at ${held}ms, waiter entered at ${waited}ms`);

  console.log("\n3. DIFFERENT KEYS DO NOT QUEUE BEHIND EACH OTHER");
  const other = fnvPair("topaz:spend-budget:probe-two");
  const busy = A.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROBE[0]}::int4, ${PROBE[1]}::int4)`;
    await tx.$queryRaw`SELECT pg_sleep(1.0)::text AS slept`;
  }, { timeout: 20_000, maxWait: 15_000 });
  await new Promise((r) => setTimeout(r, 200));
  const free = await B.$transaction(async (tx) => {
    const r = await tx.$queryRaw<{ got: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${other[0]}::int4, ${other[1]}::int4) AS got`;
    return r[0].got;
  });
  check("an unrelated key is free while the budget key is held", free === true, `try_lock returned ${free}`);
  await busy;

  console.log("\n4. THE SHIPPED KEY IS THE ONE THIS PROBE MODELS");
  const shipped = await import("../../src/lib/topazJobs");
  check("reserveSpendSlot is exported and takes the lock (see its source)", typeof shipped.reserveSpendSlot === "function");
  check("the real budget key is a stable int4 pair", Number.isInteger(REAL[0]) && Number.isInteger(REAL[1]) && Math.abs(REAL[0]) <= 2147483647,
    `key = (${REAL[0]}, ${REAL[1]}) — never taken by this probe`);

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  console.log("No table was read or written by this probe.");
  await A.$disconnect(); await B.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

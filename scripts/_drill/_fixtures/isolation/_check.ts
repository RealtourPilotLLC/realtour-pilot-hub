// The boundary fixtures' pass/fail bookkeeping (R06, Sep 28 2026). Kept apart
// from _harness.ts on purpose: a fixture should import as little as a careless
// drill would, so that what stops it is the boundary and nothing the harness
// sets up.

export const DUMMY_DB = "postgresql://drill:dummy@203.0.113.10:5432/none?connect_timeout=2&sslmode=disable";
export const DUMMY_WHERE = "203.0.113.10:5432";
// A LOOPBACK-looking URL whose `host` query parameter sends the connection to
// TEST-NET-3 instead: Prisma's engine and libpq both let it override the
// authority (second review, Sep 28 eve). Port 6279 is in this workstream's
// range and never bound; the connection would go to 203.0.113.10:6279.
export const HOSTPARAM_DB = "postgresql://drill:dummy@127.0.0.1:6279/none?host=203.0.113.10&connect_timeout=2&sslmode=disable";
export const HOSTPARAM_WHERE = "203.0.113.10:6279";

export function check(title: string) {
  let pass = 0;
  let fail = 0;
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
  return {
    ok(label: string, cond: boolean, detail = "") {
      if (cond) pass++;
      else fail++;
      console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
      return cond;
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed\n`);
      process.exitCode = fail ? 1 : 0;
    },
  };
}

/** How long a promise took to settle, and its error message (or "no error"). */
export async function settle<T>(p: () => Promise<T>): Promise<{ ms: number; err: string; value?: T }> {
  const t0 = Date.now();
  try {
    const value = await p();
    return { ms: Date.now() - t0, err: "no error", value };
  } catch (e) {
    return { ms: Date.now() - t0, err: String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim() };
  }
}

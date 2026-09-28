import { PrismaClient } from "@prisma/client";

// DRILL BACKSTOP (R06, Sep 28 2026). A drill (scripts/_drill/) or anything a
// drill started (RTP_DRILL_ISOLATION=1) may only build this client inside the
// isolation boundary (scripts/_drill/_isolation.cjs) and only on 127.0.0.1 —
// otherwise Prisma's own .env load hands it PRODUCTION. The boundary's engine
// guard refuses the connection anyway; this refuses one step earlier, and it
// is the only layer left for a drill run by hand without the preload. Neither
// condition is ever true on Vercel or under `next dev`, so there it does
// nothing.
const drillRun =
  typeof process !== "undefined" &&
  (process.env.RTP_DRILL_ISOLATION === "1" || /[\\/]scripts[\\/]_drill[\\/]/.test(process.argv?.[1] ?? ""));
if (drillRun) {
  const boundary = (globalThis as unknown as Record<symbol, { active?: boolean } | undefined>)[Symbol.for("rtp.drillIsolation")];
  if (!boundary?.active) {
    throw new Error("DRILL ISOLATION: this is a drill process without the isolation boundary — run it with `npm run drills -- <file>` (or npx tsx --require ./scripts/_drill/_drill-preload.cjs <file>).");
  }
  let where = "";
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    where = u.hostname === "127.0.0.1" ? "" : `${u.hostname}:${u.port || "5432"}`;
  } catch {
    where = "an unparsable DATABASE_URL";
  }
  if (where) throw new Error(`DRILL ISOLATION: refused a Prisma connection to ${where} — a drill may only open a database on 127.0.0.1 that it booted itself.`);
}

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// database connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

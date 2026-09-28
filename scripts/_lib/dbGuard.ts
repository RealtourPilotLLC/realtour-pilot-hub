// ---------------------------------------------------------------------------
// WHICH DATABASE IS THIS, AND MAY THIS SCRIPT WRITE TO IT (A02-restore-guard,
// Sep 28 2026). One copy of the rules every maintenance script shares.
//
// The local .env points DATABASE_URL straight at the live Neon database the
// deployed hub uses (AGENTS.md). guard-prod-db.ts already refused hosted URLs
// for db:reset, but by a regex of its own; restore-content-program.ts had no
// guard at all, so `--apply` overwrote live rows with older backed-up values
// and `--deep` held a ten-minute write transaction on production, from the
// same command line that is safe against a drill database. backup-all.ts, the
// config probe and the read-only drills each had their own copy of the
// read-only URL trick. This file is those copies, once.
//
// No I/O at import. Nothing here opens a connection.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

/** Providers whose name in a URL means "somebody's hosted database". */
const HOSTED_PATTERN = /neon\.tech|vercel|amazonaws|supabase|render\.com|railway|azure|googleapis|cloudsql|planetscale|aivencloud|cockroachlabs/i;

/** 127.0.0.0/8, localhost or ::1 — a database on this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * HOSTED = not provably this machine. A known provider name is hosted; so is
 * any host that is not loopback, and so is a URL that does not parse, because
 * the only safe reading of "I cannot tell where this goes" is "somewhere that
 * matters". guard-prod-db.ts used the provider regex alone; this is stricter.
 */
export function isHostedUrl(url: string): boolean {
  if (HOSTED_PATTERN.test(url)) return true;
  return !isLoopbackUrl(url);
}

/** Any "scheme://user:password@" in a piece of text, with the credentials
 *  replaced by *** — for an error message that may quote a command line or a
 *  connection string (execFileSync's "Command failed: …" quotes every argv
 *  entry). Safe to print; idempotent. */
export function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

/** The host a person must type to confirm a production write. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** DATABASE_URL from the environment, else from the repo's .env (tsx does not
 *  autoload it; Prisma does, which is exactly why scripts must decide first). */
export function readDatabaseUrl(envFile = path.join(REPO, ".env")): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    try {
      const m = fs.readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* no .env */ }
  }
  return url;
}

/** The same URL with every transaction read-only by default (a startup
 *  option real Postgres honours; PGlite ignores it, which proveReadOnly then
 *  catches rather than trusts). */
export function readOnlyUrl(url: string): string {
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  if (existing && /default_transaction_read_only=on/.test(existing)) return u.toString();
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

/** Point this process's DATABASE_URL at the read-only form of the configured
 *  database. Call BEFORE anything constructs a Prisma client. */
export function pinReadOnlyDatabaseUrl(): string {
  const url = readDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL not found (environment or .env)");
  const ro = readOnlyUrl(url);
  process.env.DATABASE_URL = ro;
  return ro;
}

type RawExec = { $executeRawUnsafe: (sql: string) => Promise<unknown> };

/**
 * Prove the connection refuses a write BEFORE reading anything: a no-op UPDATE
 * must fail with SQLSTATE 25006. A connection that accepts it throws here, so
 * a script that believed it was read-only stops instead of carrying on.
 */
export async function proveReadOnly(db: RawExec): Promise<void> {
  try {
    await db.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
  } catch (e) {
    if (/25006|read-only/i.test(String(e))) return;
    throw e;
  }
  throw new Error("GUARD FAILED — the connection accepted a write (it is not read-only); nothing was read");
}

// ---- restore-content-program's modes --------------------------------------

export type RestoreMode = "dry-run" | "deep" | "apply";
export type RestoreGuardInput = {
  mode: RestoreMode;
  url: string;
  targetProduction: boolean;
  incident: string | null;
};
export type RestoreGuardDecision =
  | { ok: true; hosted: boolean; needsTypedHost: boolean; host: string }
  | { ok: false; reason: string };

/**
 * What a restore may do against this URL, decided before any connection:
 *   - dry run: anywhere, but always on a read-only connection;
 *   - --deep: loopback only. It is a rehearsal, and a rehearsal belongs in an
 *     isolated database (scripts/restore-rehearsal.ts), never in production
 *     holding row locks inside a ten-minute transaction;
 *   - --apply on a hosted database: an incident, named, with the host typed
 *     back by a person. Loopback proceeds as before (the recovery drill).
 */
export function restoreGuard(i: RestoreGuardInput): RestoreGuardDecision {
  const host = hostOf(i.url);
  const hosted = isHostedUrl(i.url);
  if (!i.url) return { ok: false, reason: "DATABASE_URL is not set" };
  if (i.mode === "deep" && hosted) {
    return { ok: false, reason: `--deep refuses a hosted database (${host || "unparseable URL"}). Rehearse in isolation: npx tsx scripts/restore-rehearsal.ts <backup.json>` };
  }
  if (i.mode === "apply" && hosted) {
    if (!i.targetProduction) return { ok: false, reason: `--apply against a hosted database (${host || "unparseable URL"}) needs --target-production --incident "<reason>"` };
    if (!i.incident || i.incident.trim().length < 8) return { ok: false, reason: `--apply against production needs --incident "<what happened>" (at least a few words)` };
    return { ok: true, hosted, needsTypedHost: true, host };
  }
  return { ok: true, hosted, needsTypedHost: false, host };
}

// ---------------------------------------------------------------------------
// FIXTURE A7 (R06, Sep 28 2026): .env loading, every way it happens.
//
// Prisma loads the repo's .env (in a git worktree, the MAIN tree's, through
// the symlinked node_modules) the moment a client is constructed, and
// scripts/_lib/dbGuard.ts readDatabaseUrl() reads the file itself when
// DATABASE_URL is empty. dotenv without override fills only what is missing.
// The boundary makes all three no-ops by setting every key first — and an
// explicit dotenv OVERRIDE, which does change DATABASE_URL, still meets the
// engine guard. Values are compared, never printed; the override file holds
// only a TEST-NET-3 URL written here.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { dotEnvKeyNames, secretKeyNames, SENTINEL_URL } from "../../_isolation.cjs";
import { readDatabaseUrl } from "../../../_lib/dbGuard";
import { check, DUMMY_DB, DUMMY_WHERE, settle } from "./_check";

async function main() {
  const c = check("A7 · .env loading");
  const keys = secretKeyNames().concat(["DATABASE_URL", "DIRECT_URL"]);
  const snapshot = () => keys.map((k) => process.env[k]);
  const same = (a: (string | undefined)[], b: (string | undefined)[]) => a.every((v, i) => v === b[i]);

  const names = dotEnvKeyNames();
  c.ok("the boundary knows the .env's key names (names only, never values)", names.length > 0, `${names.length} names`);
  c.ok("every one of them is already set in this process, so no .env load can fill it", names.every((k) => process.env[k] !== undefined));

  const before = snapshot();
  const p = new PrismaClient(); // constructing is what triggers Prisma's .env load
  c.ok("new PrismaClient(): DATABASE_URL is still the sentinel", process.env.DATABASE_URL === SENTINEL_URL);
  c.ok("…and no key changed value", same(before, snapshot()));
  c.ok("scripts/_lib/dbGuard readDatabaseUrl() answers the sentinel, not the file", readDatabaseUrl() === SENTINEL_URL);

  const dotenv = (await import("dotenv")) as unknown as { config: (o?: { path?: string; override?: boolean; quiet?: boolean }) => unknown };
  dotenv.config({ quiet: true });
  c.ok("dotenv.config() (the repo .env, no override): no key changed", same(before, snapshot()));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-a7-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `DATABASE_URL="${DUMMY_DB}"\n`, { mode: 0o600 });
  dotenv.config({ path: file, override: true, quiet: true });
  c.ok("dotenv.config({ override: true }) DOES replace DATABASE_URL (a remote TEST-NET URL here)", process.env.DATABASE_URL === DUMMY_DB);
  const q = new PrismaClient();
  const r = await settle(() => q.$queryRaw`SELECT 1`);
  c.ok("…and a client built on it is refused by the engine guard, fast", r.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`) && r.ms < 1500, `${r.ms} ms`);
  process.env.DATABASE_URL = SENTINEL_URL;
  fs.rmSync(dir, { recursive: true, force: true });
  await p.$disconnect();
  await q.$disconnect();
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });

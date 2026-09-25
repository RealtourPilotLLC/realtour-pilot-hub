// ---------------------------------------------------------------------------
// Boot a demo database: PGlite behind the demo's socket server on a loopback
// port, this process pinned to it, the schema pushed. Used by the runner
// (isolated-demo.ts, persistent, 5599) and by its smoke drill (in memory, the
// drill's own port), so the drill boots the demo exactly as Jordan's does.
//
// The drill harness's bootDrillDb does the same for drills, but always in
// memory and on the harness's single-process socket server; the demo needs
// files on disk and the two-process server (demoSocketServer.ts).
// ---------------------------------------------------------------------------
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { pinDrillEnv } from "../_drill/_harness";
import { DemoSocketServer } from "./demoSocketServer";

const exec = promisify(execFile);
const REPO = path.resolve(__dirname, "../..");

export type DemoDb = { url: string; db: PGlite; server: DemoSocketServer; stop: () => Promise<void> };

export async function bootDemoDb(opts: {
  port: number;
  /** A PGlite data directory to persist to; omitted = in memory. */
  dataDir?: string;
  /** Applied after pinDrillEnv blanks the repo's .env keys (APP_SECRET, NEXT_PUBLIC_APP_URL…). */
  env?: Record<string, string>;
}): Promise<DemoDb> {
  // A client constructed before this point would already hold production's URL.
  if ((globalThis as unknown as { prisma?: unknown }).prisma || Object.keys(require.cache).some((f) => /[\\/]src[\\/]lib[\\/]prisma\.(ts|js)$/.test(f))) {
    throw new Error("@/lib/prisma was loaded before the demo database was booted — import app modules dynamically, after boot.");
  }
  const url = pinDrillEnv(opts.port, opts.env);
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" || u.port !== String(opts.port) || process.env.DATABASE_URL !== url || process.env.DIRECT_URL !== url) {
    throw new Error(`refusing: a demo database is always 127.0.0.1:${opts.port}, got ${u.host}`);
  }
  const db = opts.dataDir ? await PGlite.create({ dataDir: opts.dataDir }) : await PGlite.create();
  const server = new DemoSocketServer({ db, port: opts.port, host: "127.0.0.1", maxConnections: 64 });
  await server.start();
  // The push's child process is handed the loopback URL explicitly.
  await exec(path.join(REPO, "node_modules/.bin/prisma"), ["db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  let stopped = false;
  return {
    url,
    db,
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      const g = globalThis as unknown as { prisma?: { $disconnect: () => Promise<void> } };
      await g.prisma?.$disconnect().catch(() => {});
      await server.stop().catch(() => {});
      await db.close().catch(() => {});
    },
  };
}

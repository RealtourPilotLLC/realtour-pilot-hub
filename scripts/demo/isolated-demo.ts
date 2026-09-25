// ---------------------------------------------------------------------------
// THE ISOLATED DEMO DATABASE — a private Postgres for clicking through a whole
// client month in a browser on this Mac, with production never opened.
//
//   scripts/demo/run-demo-db.sh            start (reuses the database if present)
//   scripts/demo/run-demo-db.sh --reset    throw it away and seed a fresh one
//   scripts/demo/run-demo-dev.sh           the hub on http://localhost:3100 against it
//                                          (starts this for you if it is not running)
//
// WHAT IT IS. PGlite (Postgres compiled to WebAssembly) living INSIDE this
// process, served on 127.0.0.1:5599 through the drill harness's patched socket
// server (the one that survives a unique violation) with one more fix for a
// second process — demoSocketServer.ts — and its files in the OS temp dir so a
// restart keeps whatever Jordan clicked. The schema is pushed on every start
// (idempotent); the seed (scripts/demo/seedDemo.ts) runs once. The database
// lives exactly as long as this process: Ctrl-C closes it cleanly.
//
// WHY PRODUCTION CANNOT BE TOUCHED FROM HERE. pinDrillEnv points DATABASE_URL
// and DIRECT_URL at 127.0.0.1:5599 and blanks every key the repo's .env holds
// BEFORE any Prisma client exists (Prisma self-loads .env and never overrides a
// key that is already set); the URL is asserted loopback before the schema
// push, whose child process is handed that URL explicitly; seedDemo refuses a
// non-loopback database again on its own; and every outbound call from this
// process — fetch and raw sockets — is fenced to loopback (fenceFetch). No
// provider is configured in the demo database, so nothing could send anyway.
//
// It also serves the demo clip (scripts/demo/sample.ts) on 127.0.0.1:5598 for
// the dev server's fence to hand to the cut stream route.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { fenceFetch, installNextStubs } from "../_drill/_harness";
import { bootDemoDb } from "./bootDemoDb";
import config from "./demo-config.json";
import { ensureSampleClip, startSampleServer } from "./sample";
import type { DemoSeed } from "./seedDemo";

const ARGS = new Set(process.argv.slice(2));
const RESET = ARGS.has("--reset");
const BASE = `http://localhost:${config.devPort}`;

/** The demo's own folder. DEMO_DATA_DIR overrides; it must still end in the demo's name, because --reset deletes it. */
function demoDataDir(): string {
  const dir = process.env.DEMO_DATA_DIR?.trim() || path.join(os.tmpdir(), config.dataDirName);
  if (path.basename(dir) !== config.dataDirName) throw new Error(`DEMO_DATA_DIR must end in /${config.dataDirName} (it is deleted by --reset): ${dir}`);
  return dir;
}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function main() {
  const dataDir = demoDataDir();
  const pidFile = path.join(dataDir, "demo.pid");
  const readyFile = path.join(dataDir, "ready.json");
  const linksFile = path.join(dataDir, "links.txt");

  // One process per data directory: two PGlite instances on the same files
  // would corrupt them.
  const holder = (() => { try { return Number(fs.readFileSync(pidFile, "utf8")); } catch { return 0; } })();
  if (holder && holder !== process.pid && isAlive(holder)) {
    console.error(`The isolated demo is already running (pid ${holder}). Stop it with Ctrl-C in its window, or: kill -INT ${holder}`);
    process.exit(1);
  }
  if (RESET) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`reset      removed ${dataDir}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  fs.rmSync(readyFile, { force: true });

  for (const [what, port] of [["database", config.dbPort], ["clip server", config.samplePort]] as const) {
    if (!(await portFree(port))) {
      console.error(`Port ${port} (${what}) is already in use by something else. The demo needs it; stop that first.`);
      fs.rmSync(pidFile, { force: true });
      process.exit(1);
    }
  }

  // ---- isolation, before anything can construct a Prisma client ----------
  // bootDemoDb pins DATABASE_URL/DIRECT_URL to 127.0.0.1:5599 and blanks the
  // repo's .env keys (pinDrillEnv), refuses anything that is not loopback, and
  // hands the schema push that URL explicitly.
  installNextStubs();
  const pgdata = path.join(dataDir, "pgdata");
  const fresh = !fs.existsSync(path.join(pgdata, "PG_VERSION"));
  console.log(`database   ${fresh ? "creating" : "reusing"} ${pgdata}; pushing the schema…`);
  const fence = fenceFetch();
  const { url, db, server } = await bootDemoDb({ port: config.dbPort, dataDir: pgdata, env: { APP_SECRET: config.appSecret, NEXT_PUBLIC_APP_URL: BASE } });
  console.log(`database   listening on 127.0.0.1:${config.dbPort}`);

  const { prisma } = await import("@/lib/prisma");
  const demo = await import("./seedDemo");

  let seed: DemoSeed | null = await demo.readDemoSeed(prisma);
  if (!seed) {
    console.log("seed       first run — seeding the demo month");
    seed = await demo.seedDemo(prisma, { log: (l) => console.log(l), verbose: ARGS.has("--verbose") });
  } else {
    console.log(`seed       reusing the month seeded ${seed.seededAt} (${seed.monthKey}); --reset for a fresh one`);
  }
  const moved = await demo.pointCutsAtSample(prisma, seed);
  if (moved) console.log(`clips      ${moved} cut(s) pointed at the local sample clip`);

  const clip = ensureSampleClip(dataDir);
  const sample = await startSampleServer(clip, config.samplePort);
  console.log(`clips      ${path.basename(clip)} served on 127.0.0.1:${sample.port}`);

  const writeLinks = async (withSignIn: boolean) => {
    const links = await demo.demoLinks(prisma, seed!, BASE);
    const signIn = withSignIn ? await demo.mintDemoSignInLinks(prisma, seed!) : [];
    const text = demo.formatLinks(links, signIn);
    fs.writeFileSync(linksFile, `${text}\n`);
    return text;
  };
  const text = await writeLinks(true);
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, dbPort: config.dbPort, samplePort: sample.port, url, base: BASE, monthKey: seed.monthKey, seededAt: seed.seededAt, representative: seed.representative }, null, 2));

  const missing = Object.values(seed.representative).some((s) => s !== "seeded");
  console.log(`\n${"=".repeat(78)}\nISOLATED DEMO READY — nothing here can reach production or any provider.\n${"=".repeat(78)}\n`);
  console.log(text);
  if (missing) console.log(`\n!! The representative month did not seed for every client (see above). The portal and hub still open; the month is thinner than the walkthrough expects.`);
  console.log(`\nNext: scripts/demo/run-demo-dev.sh  (the hub on ${BASE}), then docs/demo.md.`);
  console.log(process.stdin.isTTY ? `Type "signin" for fresh sign-in links, "links" to reprint, Ctrl-C to stop.` : `Ctrl-C (or kill -INT ${process.pid}) to stop.`);

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nstopping   (${why}) — closing the database cleanly…`);
    fs.rmSync(readyFile, { force: true });
    await sample.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    fs.rmSync(pidFile, { force: true });
    if (fence.blocked.length) console.log(`fence      blocked ${fence.blocked.length} outbound attempt(s): ${[...new Set(fence.blocked)].join(", ")}`);
    fence.restore();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("Ctrl-C"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === "signin" || cmd === "links") {
        writeLinks(cmd === "signin").then((t) => console.log(`\n${t}\n`)).catch((e) => console.error(`could not build links: ${e instanceof Error ? e.message : e}`));
      } else if (cmd) {
        console.log(`commands: signin, links (Ctrl-C to stop)`);
      }
    });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  try { fs.rmSync(path.join(demoDataDir(), "demo.pid"), { force: true }); } catch { /* best effort */ }
  process.exit(1);
});

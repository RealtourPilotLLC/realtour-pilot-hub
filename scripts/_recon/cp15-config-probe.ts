// ---------------------------------------------------------------------------
// CP-15 CONFIGURATION PROBE — what is actually true in production, read-only
// (Sep 24 2026, completion audit batch E).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_recon/cp15-config-probe.ts
//
// The audit's rule: report each thing as IMPLEMENTED, CONFIGURED, TESTED,
// ENABLED or BLOCKED — never folded into one word — and never trust a comment
// or a handoff as a current fact. So every line below is read from the live
// database at run time.
//
// STRUCTURALLY READ-ONLY. The connection is opened with
// default_transaction_read_only=on and a refused UPDATE (SQLSTATE 25006) is
// proven before anything is read. Every outbound network call is refused
// too (one exception since Sep 28: GET /api/cron/version on the hub itself,
// below): this probe reads the hub's own record of its providers (connections,
// cron results, webhook logs); it asks no provider anything. The GET-only
// provider mode the design describes is deliberately not here — it needs its
// own authorisation.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pinReadOnlyDatabaseUrl, proveReadOnly, readDatabaseUrl, redactUrls } from "../_lib/dbGuard";
import { backupFacts } from "../_lib/backupFormat";
import type { CronJobHealth } from "../../src/lib/cronHealth";
import type { ReadinessReport, ReadinessRow } from "../../src/lib/readiness";

// Sep 28 2026 (A01). What the probe adds, all read-only:
//   - BACKUPS by header, never by loading them: the newest file's model set
//     against the schema it came from and today's, whether the schema moved
//     after it, whether a restore rehearsal is recorded for it, and every
//     file's mode (scripts/_lib/backupFormat.backupFacts);
//   - the Postgres SERVER VERSION, which pins the embedded Postgres the race
//     drills run on;
//   - the PAGE BUILD, from GET /api/cron/version on the live hub (bearer
//     CRON_SECRET), reported apart from the build the last hourly run
//     stamped, which can lag a deploy by up to an hour. That one URL is the
//     only outbound call the fence lets through; --offline refuses it too;
//   - CRON HEALTH from lib/cronHealth, the function /connections and the
//     readiness report read: every job vercel.json schedules, with "never
//     recorded" and "stale" said out loud;
//   - the READINESS report (A56, src/lib/readiness.ts) in place of the
//     switch loop, so the probe and /settings print one report.
// Nothing runs at import: the drill imports the pure helpers below.

export const VERSION_URL = "https://hub.realtourpilot.com/api/cron/version";
const REPO = path.resolve(__dirname, "../..");

type Label = "IMPLEMENTED" | "CONFIGURED" | "TESTED" | "ENABLED" | "BLOCKED" | "UNKNOWN" | "OK" | "WARN";
export type Fact = { area: string; fact: string; labels: Label[]; evidence: string };
const ago = (d: Date | null | undefined, now = Date.now()) => (d ? `${Math.round((now - d.getTime()) / 36e5)}h ago` : "never");

/** The page build and the last hourly run's build, as two facts. */
export function liveBuildFacts(
  page: { deploy: string | null } | { error: string } | null,
  lastSync: { deploy: string | null; startedAt: Date } | null,
  head: string | null,
  now = new Date(),
): Fact[] {
  const out: Fact[] = [];
  if (!page) {
    out.push({ area: "deploy", fact: "page build (serving now)", labels: ["UNKNOWN"], evidence: "not asked (--offline)" });
  } else if ("error" in page) {
    out.push({ area: "deploy", fact: "page build (serving now)", labels: ["UNKNOWN"], evidence: `GET ${VERSION_URL}: ${page.error}` });
  } else {
    const differs = !!page.deploy && !!head && page.deploy !== head;
    out.push({
      area: "deploy", fact: "page build (serving now)",
      labels: page.deploy ? [differs ? "WARN" : "OK"] : ["UNKNOWN"],
      evidence: page.deploy ? `${page.deploy}${head ? ` · this checkout's HEAD ${head}${differs ? " — DIFFERENT" : " — same"}` : ""}` : "the live build carries no commit stamp (deploy with --env HUB_COMMIT_SHA=$(git rev-parse HEAD))",
    });
  }
  const behind = !!lastSync?.deploy && !!head && lastSync.deploy !== head;
  out.push({
    area: "deploy", fact: "last hourly run build",
    labels: lastSync?.deploy ? [behind ? "WARN" : "OK"] : ["UNKNOWN"],
    evidence: lastSync?.deploy
      ? `${lastSync.deploy} (run ${ago(lastSync.startedAt, now.getTime())})${head ? ` · HEAD ${head}${behind ? " — DIFFERENT" : " — same"}` : ""}`
      : "no deploy stamp on the last hourly run (deploy with --env HUB_COMMIT_SHA=$(git rev-parse HEAD); cron.ts records it)",
  });
  return out;
}

/** One fact per scheduled (or once-recorded) cron job, from lib/cronHealth. */
export function cronFacts(crons: CronJobHealth[], now = new Date()): Fact[] {
  return crons.map((c) => {
    const finished = c.runs.filter((r) => r.ok !== null);
    const good = finished.filter((r) => r.ok).length;
    const bad = c.neverRecorded || c.stale || c.lastOk === false;
    return {
      area: "cron",
      fact: `${c.job}${c.expected ? "" : " (not scheduled)"}`,
      labels: bad ? ["WARN"] : c.lastOk === null ? ["UNKNOWN"] : ["OK"],
      evidence: c.neverRecorded
        ? `NEVER RECORDED a run · scheduled ${c.path}`
        : `last run ${ago(c.lastRunAt ? new Date(c.lastRunAt) : null, now.getTime())}${c.stale ? " — STALE" : ""} · ${good}/${finished.length} of the last ${c.runs.length} ok${c.lastOk === null ? " · newest has not finished" : ""}${(c.lastActing ?? c.runs[0])?.error ? ` · ${(c.lastActing ?? c.runs[0])!.error!.slice(0, 80)}` : ""}`,
    };
  });
}

/**
 * One fact per readiness row (A56, src/lib/readiness.ts), in the report's
 * order, then the rollout gate. The evidence is the report's own
 * readinessLine, so the probe and the /settings panel word a row the same way;
 * the labels keep the probe's vocabulary (a switch that is on but not
 * effective is BLOCKED, never ENABLED alone).
 */
export function readinessFacts(report: ReadinessReport, line: (r: ReadinessRow) => string): Fact[] {
  const out: Fact[] = report.rows.map((r) => {
    const labels: Label[] = ["IMPLEMENTED"];
    if (r.configured.ok) labels.push("CONFIGURED");
    if (r.enabled.ok) labels.push("ENABLED");
    if (r.enabled.ok && !r.effective.ok) labels.push("BLOCKED");
    if (r.healthy.ok === false) labels.push("WARN");
    return { area: "switch", fact: r.key, labels, evidence: `${line(r)} · reaches ${r.recipients}` };
  });
  out.push({
    area: "switch", fact: "real-client rollout is closed",
    labels: report.rolloutClosed.ok ? ["OK"] : ["WARN"],
    evidence: report.rolloutClosed.ok
      ? `no client-facing automation is effective for a real client${report.rolloutClosed.armed.length ? ` · armed but held by a missing dependency: ${report.rolloutClosed.armed.join(", ")}` : ""}`
      : `OPEN via ${report.rolloutClosed.openers.join(", ")}`,
  });
  return out;
}

/** The schema fact when `prisma migrate diff --exit-code` did not exit 0.
 *  Exit 2 is "a difference"; anything else is "could not compare", told by
 *  its exit status and the first line of stderr with any credentials
 *  scrubbed — never String(e), whose "Command failed: …" quotes the whole
 *  command line (review, Sep 28). Pure: the drill feeds it a fake failure. */
export function migrateDiffFailure(e: unknown): [Label[], string] {
  const err = e as { status?: number | null; stderr?: Buffer | string | null; code?: string };
  if (err?.status === 2) return [["WARN"], "prisma migrate diff reports a difference — run it by hand to see which"];
  const stderr = err?.stderr ? String(err.stderr) : "";
  const first = stderr.split("\n").map((l) => l.trim()).find((l) => l && !/^warn\b|prisma-config|pris\.ly/i.test(l)) ?? "";
  const why = err?.code === "ENOENT" ? "npx was not found" : first ? redactUrls(first).slice(0, 160) : "no message";
  return [["UNKNOWN"], `could not compare (exit ${err?.status ?? "?"}): ${why}`];
}

/** CRON_SECRET from the environment or .env; never printed. */
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const m = fs.readFileSync(path.join(REPO, ".env"), "utf8").match(/^\s*CRON_SECRET\s*=\s*(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

async function main() {
  const offline = process.argv.includes("--offline");
  if (!readDatabaseUrl()) throw new Error("DATABASE_URL not found");
  const RO_URL = pinReadOnlyDatabaseUrl();

  // Only the hub's own version endpoint may be reached, and only by URL
  // equality. Every provider stays unasked.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "(request)";
    if (!offline && url === VERSION_URL) return realFetch(url, init);
    throw new Error(`OUTBOUND BLOCKED BY PROBE: ${url}`);
  }) as typeof fetch;

  const rows: Fact[] = [];
  const say = (area: string, fact: string, labels: Label[], evidence: string) => rows.push({ area, fact, labels, evidence });

  const { prisma } = await import("../../src/lib/prisma");
  await proveReadOnly(prisma);
  console.log(`read-only connection proven (25006); outbound network refused${offline ? "" : ` except GET ${VERSION_URL}`}\n`);

  // F1 — the build serving pages now, and the build the last hourly run
  // stamped (cron.ts records out.deploy: first 12 of VERCEL_GIT_COMMIT_SHA,
  // else the HUB_COMMIT_SHA a CLI deploy passes). Compared with this
  // checkout's HEAD so "production is behind" is a fact, not a guess.
  const { lastRunDeploy } = await import("../../src/lib/cron");
  const lastSync = await lastRunDeploy("sync");
  let head: string | null = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim().slice(0, 12); } catch { /* not a checkout */ }
  let page: { deploy: string | null } | { error: string } | null = null;
  if (!offline) {
    const secret = cronSecret();
    try {
      const res = await fetch(VERSION_URL, { headers: secret ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(10_000) });
      page = res.ok ? ((await res.json()) as { deploy: string | null }) : { error: `HTTP ${res.status}${res.status === 404 ? " (this build predates the endpoint)" : res.status === 401 ? " (CRON_SECRET here does not match)" : ""}` };
    } catch (e) {
      page = { error: String((e as Error).message ?? e).slice(0, 120) };
    }
  }
  for (const f of liveBuildFacts(page, lastSync, head)) rows.push(f);

  // F2 — does production's schema match HEAD? migrate diff only inspects.
  // THE PASSWORD NEVER GOES IN ARGV (review, Sep 28). `--from-url <RO_URL>`
  // put the connection string on the command line, where `ps` can read it,
  // and on any exit other than 2 the evidence printed String(e) — which is
  // "Command failed: npx prisma migrate diff --from-url postgresql://user:
  // <password>@…", the production password on a line people paste. The
  // schema's own datasource reads DATABASE_URL from the environment instead
  // (set to the read-only URL here; the CLI's .env loading never overrides a
  // variable already set), and a failure reports its exit status and a
  // credential-scrubbed first line of stderr, never the error object.
  const schemaFile = path.resolve(__dirname, "../../prisma/schema.prisma");
  try {
    execFileSync("npx", ["prisma", "migrate", "diff", "--from-schema-datasource", schemaFile, "--to-schema-datamodel", schemaFile, "--exit-code"], { stdio: "pipe", env: { ...process.env, DATABASE_URL: RO_URL } });
    say("schema", "production schema matches HEAD", ["OK"], "prisma migrate diff: no difference");
  } catch (e) {
    say("schema", "production schema matches HEAD", ...migrateDiffFailure(e));
  }

  // F2b — the Postgres server version. The race drills' embedded Postgres is
  // pinned in tools/realpg/package.json; a different MAJOR here means those
  // drills no longer run on the engine production runs.
  const [{ v: serverVersion }] = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('server_version') AS v`);
  let pinned: string | null = null;
  try { pinned = (JSON.parse(fs.readFileSync(path.join(REPO, "tools/realpg/package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies?.["embedded-postgres"] ?? null; } catch { /* not installed */ }
  const major = (v: string | null) => (v ? /^(\d+)/.exec(v)?.[1] ?? null : null);
  say("schema", "Postgres server version", pinned && major(pinned) !== major(serverVersion) ? ["WARN"] : ["OK"],
    `${serverVersion}${pinned ? ` · drill engine pinned to ${pinned}${major(pinned) !== major(serverVersion) ? " — DIFFERENT MAJOR" : ""}` : " · no embedded Postgres pinned in tools/realpg"}`);

  // F3 — backups on this machine, by header only (never loaded).
  const models = (await import("@prisma/client")).Prisma.dmmf.datamodel.models.map((m) => m.name);
  for (const f of backupFacts(process.env.HOME ?? "", models)) say("backup", f.fact, f.labels, f.evidence);

  // F4 — every automation switch, as the readiness report (A56) sees it:
  // configured, connected, enabled, effective and healthy apart. The same
  // report /settings renders, so the probe and the panel cannot drift. Built
  // with live:false: it asks Google nothing.
  const switches = await prisma.programAutomation.findMany();
  const byKey = new Map(switches.map((s) => [s.key, s]));
  const { readinessReport, readinessLine } = await import("../../src/lib/readiness");
  try {
    for (const f of readinessFacts(await readinessReport({ live: false }), readinessLine)) rows.push(f);
  } catch (e) {
    say("switch", "readiness report", ["UNKNOWN"], `could not be built read-only: ${String((e as Error).message ?? e).slice(0, 120)}`);
  }

  // F4b — R02/A26: WHO each provider-write switch may write for. A switch that
  // is off writes for nobody whatever its lists say, so the scope is reported
  // next to the switch state, never instead of it. A real client on a fixture
  // list is a WARN (the guard refuses it, but somebody put it there).
  const { HUB_WRITE_SWITCHES, parseHubWriteConfig, describeHubWriteScope } = await import("../../src/lib/hubWritePermit");
  const { isTestClientName } = await import("../../src/lib/testClients");
  const scopes = HUB_WRITE_SWITCHES.map((key) => {
    const s = byKey.get(key);
    let raw: unknown = null;
    try { raw = s?.configJson ? JSON.parse(s.configJson) : null; } catch { raw = null; }
    return { key, s, cfg: parseHubWriteConfig(raw) };
  });
  const scopeIds = [...new Set(scopes.flatMap((x) => [...x.cfg.authorizedFixtureClientIds, ...(x.cfg.pilot?.clientIds ?? [])]))];
  const scopeClients = scopeIds.length ? await prisma.client.findMany({ where: { id: { in: scopeIds } }, select: { id: true, name: true } }) : [];
  const scopeNames = new Map(scopeClients.map((c) => [c.id, c.name]));
  for (const { key, s, cfg } of scopes) {
    const d = describeHubWriteScope(key, { enabled: s?.enabled === true, missing: !s, config: cfg }, scopeNames, new Date());
    const realOnFixtures = cfg.authorizedFixtureClientIds.filter((id) => !isTestClientName(scopeNames.get(id)));
    const labels: Label[] = realOnFixtures.length ? ["WARN"] : s?.enabled && d.pilotState === "ACTIVE" ? ["ENABLED"] : cfg.authorizedFixtureClientIds.length || cfg.pilot ? ["CONFIGURED"] : ["OK"];
    say("scope", `${key}: who the hub may write for`, labels,
      `${d.headline} · fixtures: ${d.fixtures} · pilot: ${d.pilot}${realOnFixtures.length ? ` · REAL client(s) on the fixture list (refused): ${realOnFixtures.join(",")}` : ""}`);
  }

  // F5 — Calendly mappings: the legacy name-matched Drive sweep stands down
  // once an enabled mapping exists (contentCalls.hasEnabledCallMapping).
  const maps = await prisma.programCalendlyEventMapping.findMany();
  const enabled = maps.filter((m) => m.enabled && m.validationStatus === "VALID");
  const discovery = enabled.filter((m) => m.purpose === "BRAND_DISCOVERY");
  say("calendly", "BRAND_DISCOVERY mapping", discovery.length === 1 ? ["CONFIGURED", "ENABLED"] : ["BLOCKED"], discovery.map((m) => `${m.eventName} ${m.publicUrl ? "(public link set)" : "(NO public link — the welcome needs one)"}`).join("; ") || "none enabled");
  say("calendly", "MONTHLY_STRATEGY mapping", enabled.some((m) => m.purpose === "MONTHLY_STRATEGY") ? ["CONFIGURED", "ENABLED"] : ["BLOCKED"], enabled.filter((m) => m.purpose === "MONTHLY_STRATEGY").map((m) => m.eventName).join("; ") || "none enabled");
  say("calendly", "legacy name-matched Drive sweep", enabled.length ? ["OK"] : ["WARN"], enabled.length ? "stood down (a verified mapping is enabled)" : "STILL RUNNING — first-name transcript matching");

  // F6 — call and transcript truth, last 60 days.
  const since60 = new Date(Date.now() - 60 * 864e5);
  const calls = await prisma.programCallRecord.groupBy({ by: ["callType", "matchState"], where: { createdAt: { gte: since60 } }, _count: true });
  say("calls", "call records (60 days) by type/match", ["OK"], calls.map((c) => `${c.callType}/${c.matchState}:${c._count}`).join(" ") || "none");
  const unmappedMatched = maps.length ? await prisma.programCallRecord.count({ where: { matchState: "MATCHED", mappingId: { in: maps.filter((m) => !m.enabled).map((m) => m.id) } } }) : 0;
  say("calls", "matched records on a DISABLED mapping (must be 0)", unmappedMatched === 0 ? ["OK"] : ["WARN"], String(unmappedMatched));
  const sources = await prisma.programTranscriptSource.groupBy({ by: ["provider", "matchState"], _count: true });
  say("calls", "transcript sources by provider/match", ["OK"], sources.map((s) => `${s.provider}/${s.matchState}:${s._count}`).join(" ") || "none");
  const jobs = await prisma.programTranscriptJob.groupBy({ by: ["kind", "state"], _count: true });
  const disabledReview = await prisma.programTranscriptJob.count({ where: { state: "NEEDS_REVIEW", reviewReason: { contains: "switched off" } } });
  say("calls", "transcript jobs by kind/state", disabledReview ? ["WARN"] : ["OK"], `${jobs.map((j) => `${j.kind}/${j.state}:${j._count}`).join(" ") || "none"}${disabledReview ? ` · ${disabledReview} parked for review by a closed switch (Sep 23 bug)` : ""}`);

  // F7 — provider connections, as the hub last recorded them. The secret is
  // only checked for PRESENCE; nothing is decrypted or sent.
  const conns = await prisma.connection.findMany({ select: { provider: true, status: true, lastSyncedAt: true, lastError: true, secretEncrypted: true, accountLabel: true } });
  for (const p of ["aryeo", "stripe", "calendly", "gmail", "dropbox", "openphone", "slack", "ai", "deepgram", "openai_whisper"]) {
    const c = conns.find((x) => x.provider === p);
    say("connection", p, c ? (c.status === "CONNECTED" && c.secretEncrypted ? ["CONFIGURED"] : ["BLOCKED"]) : ["BLOCKED"],
      c ? `${c.status} · key ${c.secretEncrypted ? "present" : "MISSING"} · last sync ${ago(c.lastSyncedAt)}${c.lastError ? ` · ${c.lastError.slice(0, 80)}` : ""}${p === "gmail" && c.accountLabel ? ` · ${c.accountLabel}` : ""}` : "no connection row");
  }

  // F8 — Stripe activation freshness.
  const signups = await prisma.programSignup.findMany({ orderBy: { paidAt: "desc" }, take: 20, select: { status: true, paidAt: true, createdAt: true, activatedVia: true, productName: true } });
  const lags = signups.filter((s) => s.status === "ACTIVATED").map((s) => (s.createdAt.getTime() - s.paidAt.getTime()) / 6e4);
  say("stripe", "paid-checkout activation", signups.length ? ["OK"] : ["UNKNOWN"], signups.length ? `${signups.length} recent signups; statuses ${[...new Set(signups.map((s) => s.status))].join("/")}; paid→claimed ${lags.length ? `median ${Math.round(lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)])} min` : "n/a"}; via ${[...new Set(signups.map((s) => s.activatedVia ?? "poll(pre-CP-14)"))].join("/")}` : "no signups on file");

  // F9/F10 — cron health: every job vercel.json schedules, from the same
  // function /connections and the readiness report read (lib/cronHealth).
  const { cronHealthByJob } = await import("../../src/lib/cronHealth");
  for (const f of cronFacts(await cronHealthByJob(10))) rows.push(f);
  const hooks = await prisma.webhookEvent.groupBy({ by: ["provider", "status"], where: { createdAt: { gte: new Date(Date.now() - 7 * 864e5) } }, _count: true });
  say("webhooks", "last 7 days by provider/status", ["OK"], hooks.map((h) => `${h.provider}/${h.status}:${h._count}`).join(" "));

  // F11 — outbox: nothing program-facing may be pending while switches are off.
  const outbox = await prisma.outboxMessage.groupBy({ by: ["channel", "state"], where: { createdAt: { gte: new Date(Date.now() - 7 * 864e5) } }, _count: true });
  say("outbox", "last 7 days by channel/state", ["OK"], outbox.map((o) => `${o.channel}/${o.state}:${o._count}`).join(" ") || "empty");
  const pendingEmail = await prisma.outboxMessage.count({ where: { channel: "email", state: { in: ["pending", "attempting", "held"] } } });
  say("outbox", "program emails pending (must be 0 with switches off)", pendingEmail ? ["WARN"] : ["OK"], String(pendingEmail));

  // F12 — who owns what by default.
  const owners = await prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT", endedAt: null }, select: { duty: true, label: true, appUserId: true, teamMemberId: true } });
  say("owners", "default duty owners", owners.length ? ["CONFIGURED"] : ["WARN"], owners.map((o) => `${o.duty}→${o.label ?? o.appUserId ?? o.teamMemberId}`).join(" ") || "none set");

  // F13 — the Jordan TEST account and its fixtures.
  const test = await prisma.client.findMany({ where: { name: { contains: "TEST" } }, select: { id: true, name: true, email: true, phone: true } });
  for (const t of test) {
    const enr = await prisma.contentEnrollment.findMany({ where: { clientId: t.id }, select: { id: true, status: true, package: true } });
    const seats = await prisma.clientMembership.count({ where: { clientId: t.id, revokedAt: null } });
    const videos = await prisma.contentVideo.count({ where: { clientId: t.id } });
    say("test account", t.name, ["OK"], `enrollments ${enr.map((e) => `${e.package}/${e.status}`).join(",") || "none"} · live seats ${seats} · library videos ${videos} · email ${t.email ? "set" : "empty"} · phone ${t.phone ? "set" : "empty"}`);
  }
  const guides = await prisma.portalResource.groupBy({ by: ["published"], _count: true });
  say("resources", "portal guides", guides.some((g) => g.published) ? ["ENABLED"] : ["IMPLEMENTED"], guides.map((g) => `${g.published ? "published" : "draft"}:${g._count}`).join(" ") || "none written");

  // F14 — speech-to-text: what captions can be drafted from.
  const stt = conns.filter((c) => /deepgram|whisper|openai/i.test(c.provider));
  say("captions", "speech-to-text provider", stt.length ? ["CONFIGURED"] : ["BLOCKED"], stt.length ? stt.map((c) => c.provider).join(",") : "none connected — captions draft from the approved SCRIPT only, and say so");

  // ---- report
  const w = Math.max(...rows.map((r) => r.area.length));
  let area = "";
  for (const r of rows) {
    if (r.area !== area) { console.log(`\n${r.area.toUpperCase()}`); area = r.area; }
    console.log(`  ${r.fact.padEnd(52)} ${r.labels.join("+").padEnd(34)} ${r.evidence}`);
  }
  void w;
  const warn = rows.filter((r) => r.labels.includes("WARN") || r.labels.includes("BLOCKED"));
  console.log(`\n${rows.length} facts · ${warn.length} need attention`);
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

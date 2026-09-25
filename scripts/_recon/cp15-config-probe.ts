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
// too: this probe reads the hub's own record of its providers (connections,
// cron results, webhook logs); it asks no provider anything. The GET-only
// provider mode the design describes is deliberately not here — it needs its
// own authorisation.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ENV = path.resolve(__dirname, "../../.env");
function readOnlyUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const m = fs.readFileSync(ENV, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}
const RO_URL = readOnlyUrl();
process.env.DATABASE_URL = RO_URL;

// No provider is contacted from here, by anything this file imports.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`OUTBOUND BLOCKED BY PROBE: ${typeof input === "string" ? input : "(request)"}`);
}) as typeof fetch;

type Label = "IMPLEMENTED" | "CONFIGURED" | "TESTED" | "ENABLED" | "BLOCKED" | "UNKNOWN" | "OK" | "WARN";
const rows: { area: string; fact: string; labels: Label[]; evidence: string }[] = [];
const say = (area: string, fact: string, labels: Label[], evidence: string) => rows.push({ area, fact, labels, evidence });
const ago = (d: Date | null | undefined) => (d ? `${Math.round((Date.now() - d.getTime()) / 36e5)}h ago` : "never");

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
    throw new Error("GUARD FAILED — the connection accepted a write");
  } catch (e) {
    if (!/25006|read-only/i.test(String(e))) throw e;
  }
  console.log("read-only connection proven (25006); outbound network refused\n");

  // F1 — deployed commit, as the hourly cron recorded it.
  const lastSync = await prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" } });
  let deploy: string | null = null;
  try { deploy = (JSON.parse(lastSync?.summary ?? "{}") as { deploy?: string }).deploy ?? null; } catch { /* unreadable */ }
  // cron.ts stamps out.deploy (first 12 of VERCEL_GIT_COMMIT_SHA, else the
  // HUB_COMMIT_SHA a CLI deploy passes). Compared with this checkout's HEAD so
  // "production is behind" is a fact on the page, not a guess.
  let head: string | null = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim().slice(0, 12); } catch { /* not a checkout */ }
  const behind = !!deploy && !!head && deploy !== head;
  say("deploy", "commit the live hub is running", deploy ? [behind ? "WARN" : "OK"] : ["UNKNOWN"],
    deploy ? `${deploy} (last hourly run ${ago(lastSync?.startedAt)})${head ? ` · this checkout's HEAD ${head}${behind ? " — DIFFERENT" : " — same"}` : ""}` : "no deploy stamp on the last hourly run (deploy with --env HUB_COMMIT_SHA=$(git rev-parse HEAD); cron.ts records it)");

  // F2 — does production's schema match HEAD? migrate diff only inspects.
  try {
    execFileSync("npx", ["prisma", "migrate", "diff", "--from-url", RO_URL, "--to-schema-datamodel", path.resolve(__dirname, "../../prisma/schema.prisma"), "--exit-code"], { stdio: "pipe", env: { ...process.env, DATABASE_URL: RO_URL } });
    say("schema", "production schema matches HEAD", ["OK"], "prisma migrate diff: no difference");
  } catch (e) {
    const status = (e as { status?: number }).status;
    say("schema", "production schema matches HEAD", status === 2 ? ["WARN"] : ["UNKNOWN"], status === 2 ? "prisma migrate diff reports a difference — run it by hand to see which" : `could not compare: ${String(e).slice(0, 120)}`);
  }

  // F3 — backups on this machine.
  const home = process.env.HOME ?? "";
  const backups = fs.existsSync(home) ? fs.readdirSync(home).filter((f) => /^rtp-backup-.*\.json$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(home, f)).mtime })).sort((a, b) => b.t.getTime() - a.t.getTime()) : [];
  const models = (await import("@prisma/client")).Prisma.dmmf.datamodel.models.length;
  say("backup", "newest row-level backup", backups.length ? ["OK"] : ["WARN"], backups.length ? `${backups[0].f} (${ago(backups[0].t)}); schema has ${models} models` : "none found in $HOME");

  // F4 — every automation switch. A missing row is OFF.
  const { AUTOMATION_KEYS } = await import("../../src/lib/programAutomation");
  const switches = await prisma.programAutomation.findMany();
  const byKey = new Map(switches.map((s) => [s.key, s]));
  for (const key of AUTOMATION_KEYS) {
    const s = byKey.get(key);
    say("switch", key, ["IMPLEMENTED", ...(s ? (["CONFIGURED"] as Label[]) : []), ...(s?.enabled ? (["ENABLED"] as Label[]) : [])],
      s ? `${s.enabled ? "ON" : "off"} · by ${s.enabledBy ?? "-"} · last run ${ago(s.lastRunAt)}${s.lastError ? ` · last error: ${s.lastError.slice(0, 80)}` : ""}` : "no row → OFF");
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

  // F9/F10 — Aryeo reconciliation and cron health, last 48 hourly runs.
  const runs = await prisma.cronRun.findMany({ where: { startedAt: { gte: new Date(Date.now() - 48 * 36e5) } }, orderBy: { startedAt: "desc" } });
  for (const job of ["sync", "reconcile", "gmail", "daily", "evening"]) {
    const js = runs.filter((r) => r.job === job);
    const unfinished = js.filter((r) => !r.finishedAt && Date.now() - r.startedAt.getTime() > 10 * 6e4).length;
    const failed = js.filter((r) => r.finishedAt && !r.ok).length;
    say("cron", `${job}: last 48h`, js.length ? (unfinished || failed ? ["WARN"] : ["OK"]) : ["UNKNOWN"], `${js.length} runs · ${failed} not ok · ${unfinished} never finished · last ${ago(js[0]?.startedAt)}`);
  }
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

main().catch((e) => { console.error(e); process.exit(1); });

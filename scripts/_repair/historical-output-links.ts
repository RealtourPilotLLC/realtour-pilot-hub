// PREPARATION ONLY unless an operator explicitly unlocks an exact reviewed
// private plan. Default: prove SQLSTATE25006, read seven named identities,
// save only IDs + hashes outside Git, report sanitized counts. No app imports,
// source contents/assets, providers, sends, automation, schemas or resyncs.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHistoricalOutputLinks, planHistoricalOutputLinks, repairHash, OUTPUT_LINK_UNLOCK, type OutputLinkCandidate, type OutputLinkPlan } from "./historical-output-links-core";

const MIKE = { clientId: "cmqiks8bj00389k9qjekmmdb3", enrollmentId: "cmtm4qq6x00vrl404qlmibjq1", monthId: "cmtm4qq8g00vsl404zzga7dzc", projectId: "cmtrbh05d0009lb04gv7c0cdi", deliverableId: "cmtrbh05d000alb042r7mbmpb" };
const RICK = { clientId: "cmqiks8n7003j9k9qj43v4ti1", enrollmentId: "cmt7n9kdl000w9kunldguh6hl", monthId: "cmti54uno004vic04lhc32aso", projectId: "cmtt5lq2b00mnkv04ywphfglw", deliverableId: "cmtt5lq2b00mokv04w5rk7gdx" };
const SARINA = { clientId: "cmqiksj94007m9k9qy8f4l51n", enrollmentId: "cmt7n9ko600109kun2vdrvyew", monthId: "cmthsck3y003vjo04rnj35m8o", projectId: "cmthqfufr0004jl04q9ciu5sd", deliverableId: "cmthqfufr0005jl04jcwopgi7" };
export const NAMED_OUTPUT_LINKS: readonly OutputLinkCandidate[] = [
  { ...MIKE, videoId: "cmuero4xf00qfla04hr0bfu90", outputId: "cmu69ef6p00yh9kyxmhfjmi2p", cutId: "cmug4nb6b0006h0043e8nzhzs", slot: 1 },
  { ...MIKE, videoId: "cmun3qtop00u5l604ift4lklm", outputId: "cmu69ef8z00yn9kyxyltgmjr5", cutId: "cmun6aouz0004lk04h7viwypx", slot: 4 },
  { ...RICK, videoId: "cmufnttwf0040l104r1se118v", outputId: "cmu69efrh00yt9kyxea7bh148", cutId: "cmug5bhlu0010h00490zejx0p", slot: 1 },
  { ...RICK, videoId: "cmuldl0zx003wjs04wpxzm7go", outputId: "cmu69efu100yz9kyxe28liyh0", cutId: "cmulg6e0j000hi9047nt4yx4y", slot: 4 },
  { ...SARINA, videoId: "cmu670z4v0042jr04whlako1j", outputId: "cmu69ediz00xz9kyx9ccca1ht", cutId: "cmu7do8np0005jp0452dsih0j", slot: 1 },
  { ...SARINA, videoId: "cmupfcm6d0041jp04xbhbpz6x", outputId: "cmu69edjn00y19kyxea8hm1oc", cutId: "cmupjf4kb0008js04n5782l03", slot: 2 },
  { ...SARINA, videoId: "cmubjxa0q00q7l9048xwu9ioj", outputId: "cmu69edke00y39kyx2w70hsaj", cutId: "cmubf50l60002js04aqgp484m", slot: 3 },
];

function sourceUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const line = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8").split(/\r?\n/).find((v) => /^DATABASE_URL=/.test(v));
  if (!line) throw new Error("Database configuration is unavailable.");
  return line.slice("DATABASE_URL=".length).replace(/^(["'])(.*)\1$/, "$2");
}
export function readOnlyUrl(url: string): string {
  const u = new URL(url), prior = u.searchParams.get("options");
  u.searchParams.set("options", `${prior ? `${prior} ` : ""}-c default_transaction_read_only=on`);
  return u.href;
}
export async function proveReadOnly(db: PrismaClient): Promise<void> {
  const settings = await db.$queryRaw<{ current: string; default: string }[]>`SELECT current_setting('transaction_read_only') AS "current", current_setting('default_transaction_read_only') AS "default"`;
  if (settings[0]?.current !== "on" || settings[0]?.default !== "on") throw new Error("Read-only guard is not active.");
  let state: unknown;
  try { await db.$executeRawUnsafe('UPDATE "ContentVideo" SET "outputId"="outputId" WHERE false'); }
  catch (e) { state = (e as { meta?: { code?: unknown } }).meta?.code; }
  if (state !== "25006") throw new Error("Read-only SQLSTATE25006 proof failed; no business rows may be inspected.");
}

export function applyArguments(args: readonly string[]): { planFile: string; expectedPlanHash: string; actorUserId: string; unlock: string } | null {
  const allowed = ["--apply", "--plan-file=", "--expected-plan-hash=", "--actor-user-id=", "--unlock="];
  if (args.some((arg) => !allowed.some((a) => a.endsWith("=") ? arg.startsWith(a) : arg === a))) throw new Error("Unknown repair argument.");
  if (!args.includes("--apply")) { if (args.length) throw new Error("Apply-only arguments cannot enable a dry run."); return null; }
  const get = (prefix: string) => { const values = args.filter((arg) => arg.startsWith(prefix)); if (values.length !== 1 || !values[0].slice(prefix.length)) throw new Error("Every mutation lock must be supplied exactly once."); return values[0].slice(prefix.length); };
  const result = { planFile: get("--plan-file="), expectedPlanHash: get("--expected-plan-hash="), actorUserId: get("--actor-user-id="), unlock: get("--unlock=") };
  if (!path.isAbsolute(result.planFile) || !/^[a-f0-9]{64}$/.test(result.expectedPlanHash) || result.unlock !== OUTPUT_LINK_UNLOCK) throw new Error("Mutation remains locked; supply the exact private plan/hash and named-output unlock.");
  return result;
}

async function main() {
  const apply = applyArguments(process.argv.slice(2)); // locks checked before opening a connection
  const db = new PrismaClient({ datasourceUrl: apply ? sourceUrl() : readOnlyUrl(sourceUrl()), log: [] });
  try {
    if (apply) {
      const stat = fs.lstatSync(apply.planFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Reviewed plan must be a private regular file.");
      const plan = JSON.parse(fs.readFileSync(apply.planFile, "utf8")) as OutputLinkPlan;
      const result = await applyHistoricalOutputLinks(db, plan, NAMED_OUTPUT_LINKS, apply);
      console.log(JSON.stringify({ mode: "applied", ...result, noSendOrActivation: true }));
    } else {
      await proveReadOnly(db);
      const plan = await db.$transaction((tx) => planHistoricalOutputLinks(tx, NAMED_OUTPUT_LINKS), { isolationLevel: "RepeatableRead", timeout: 30_000 });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-historical-output-plan-")); fs.chmodSync(directory, 0o700);
      const planFile = path.join(directory, "plan.private.json"), expectedPlanHash = repairHash(plan);
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(directory, "read-proof.private.json"), JSON.stringify({ checkedAt: new Date().toISOString(), sqlstate: "25006", candidateCount: plan.rows.length, businessMutations: 0, providerRequests: 0, expectedPlanHash }, null, 2), { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ mode: "read-only-dry-run", sqlstate: "25006", candidates: plan.rows.length, ready: plan.rows.filter((r) => r.disposition === "ready").length, already: plan.rows.filter((r) => r.disposition === "already").length, held: plan.rows.filter((r) => r.disposition === "held").length, planFile, expectedPlanHash, businessMutations: 0, providerRequests: 0 }));
    }
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) main().catch(() => { console.error("Historical output-link preparation/apply refused. Inspect the named private plan and guard; no client/provider action exists in this script."); process.exitCode = 1; });

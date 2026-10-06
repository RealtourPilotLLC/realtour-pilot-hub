import "server-only";
import { prisma } from "@/lib/prisma";
import { AUTOMATION_KEYS, type AutomationKey } from "@/lib/programAutomation";
import { AUTOMATION_EFFECTS, type AutomationCadence, type ReadinessConfigCheck, type ReadinessProvider } from "@/lib/programAutomationCopy";
import { deployStamp, lastRunDeploy } from "@/lib/cron";
import { cronHealthByJob } from "@/lib/cronHealth";
import { isHubWriteSwitch, parseHubWriteConfig, pilotState, describeHubWriteScope, type HubWriteScopeConfig, type PilotState } from "@/lib/hubWritePermit";
import { isTestClientName, isNeverSyntheticClientId, isVerifiedTestDestinationEmail } from "@/lib/testClients";
import {
  CLOSED_ROLLOUT, PROGRAM_PILOT_GROUPS, PROGRAM_PILOT_GROUP_SHORT, PROGRAM_PILOT_MAX, clientReachSummary, isProgramReachOp, pilotStateOf, withProgramPilot,
  type ProgramReachOp, type ProgramRollout, type ReachRefusalCode, type ReachTier, type RolloutMode,
} from "@/lib/programRolloutCore";
import type { ProgramAudience } from "@/lib/programRollout";
import type { TranscriptQueueBatch } from "@/lib/transcriptJobs";

// ---------------------------------------------------------------------------
// READINESS (A56, unified handoff §11 and §12, Sep 28 2026).
//
// §11: "Separate configured, connected, enabled, and healthy. Show dependencies
// and recipients for automations. Do not make a switch look effective when
// another gate prevents its operation."
//
// Before this file the answer was spread over four readers that could drift:
// the switches on Settings (on / off / never configured, and nothing else), the
// connections and cron health on /connections, the deploy stamps on
// /content/monitoring, and the CP-15 probe's own switch loop. A switch could
// read a plain green "on" while AI runs was off, while Aryeo was disconnected,
// or while its stored config would not run, and "healthy" meant only "no last
// error": a driver that had quietly stopped was indistinguishable from one
// that had nothing to do.
//
// ONE REPORT, FIVE SEPARATE FACTS PER AUTOMATION:
//   configured  a saved row exists and its config would actually run
//   connected   every provider it needs is connected (null = needs none)
//   enabled     the switch is on (a missing row is off, as everywhere)
//   effective   on, AND every switch it depends on is on, every provider is
//               connected, its config passes, and its scope has somebody real
//               in it. When it is not, `blockers` says exactly why.
//   healthy     null while it is off or blocked (a closed switch is never a
//               failure: the Sep 23 regression), false on a recorded error or
//               when its driver is late by more than twice its cadence
// plus who hears about it (recipients) and whom it may touch (scope).
//
// rolloutClosed is the launch gate in one boolean: true while no switch that
// reaches clients is EFFECTIVE for a real (non-TEST) client. The existing
// business texts (confirmations, delivery feedback, after-hours, welcome) are
// reported beside it but never counted in it: they are approved and running
// today (§4: "Do not disable unrelated approved communications already used
// by the team"), and the launch gate is about the content program.
//
// WHO, FROM THE SAME PLACE DISPATCH ASKS (R03, Sep 28 2026). The scope line
// used to be derived here from each feature's testClientsOnly lock, so it
// could only ever say "TEST clients only" or "every client" — and five
// switches read "every client it concerns, once on" with no lock at all. It
// now comes from programRollout.programAudience(op): the same stored rollout,
// the same featureTestOnlyFor lock reader and the same rolloutDecision the
// outbox gate, the evaluators and the dry run call. So what readiness names,
// what the dry run marks "send" and what dispatch lets through are one answer.
// It says "every client" only when the rollout is set to everyone. The three
// provider-write switches read the PROGRAM pilot (withProgramPilot — Jordan's
// Sep 28 rule), and their per-switch pilot on file is reported as not read.
//
// THE CALL PROCESSOR (R05, Sep 28 2026). A switch whose work waits in the
// transcript queue is not effective while the processor is off, and the
// blocker says how much is waiting; a partial dependency (one path of a
// switch) is reported as blocked for that path and the switch is never called
// healthy while it is. The transcript_jobs row carries the read-only batch
// (transcriptJobs.transcriptQueueBatch — the driver's own hold rule).
//
// READ-ONLY. Nothing here writes a row or changes a saved value, and nothing
// here asks a provider anything unless the caller passes live:true — and then
// only Google's tokeninfo, the same send-scope probe /connections runs on
// every visit.
// ---------------------------------------------------------------------------

/** The Settings groups (src/components/settings/SettingsGroup.tsx holds their words). */
export type SettingsGroupId = "team" | "scheduling" | "production" | "program" | "comms" | "integrations" | "financial";

export type ReadinessRow = {
  /** An AutomationKey for a program switch; "auto_texts.confirmation"-style for the existing business automations. */
  key: string;
  kind: "program" | "business";
  group: SettingsGroupId;
  title: string;
  reaches: "clients" | "staff" | "internal";
  configured: { ok: boolean; detail: string };
  connected: { ok: boolean | null; providers: string[]; missing: string[]; detail: string };
  enabled: { ok: boolean; detail: string };
  /**
   * `blockers` stop the whole switch. `partial` stop one named path of it
   * (requires.partial, R05): the switch can still be effective, but it is
   * never reported healthy while one of these stands.
   */
  effective: { ok: boolean; blockers: string[]; partial: string[] };
  healthy: { ok: boolean | null; lastRunAt: Date | null; lastError: string | null; stale: boolean; detail: string };
  recipients: string;
  /** Whom it may touch, when that is narrower or wider than "everyone it concerns". */
  scope: string | null;
  /** A plain extra line (the queue batch; "the buttons do not use the queue"). */
  note: string | null;
  cadence: AutomationCadence;
  /** Counted by rolloutClosed (a content-program switch that reaches clients). */
  launchGated: boolean;
  /** As configured now, would it touch a real (non-TEST) client once effective? */
  realClients: boolean;
};

/** "Who the program may reach" — the rollout itself, for the header of the panel. */
export type ProgramScopeView = {
  mode: RolloutMode;
  modeSince: Date | null;
  pilotState: PilotState;
  cap: number;
  pilot: null | { names: string[]; groups: string[]; approvedBy: string | null; approvedAt: Date | null; expiresAt: Date | null; note: string | null };
  /** The stored value could not be read (it reads as TEST only), or the database could not be asked. */
  problem: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
  /**
   * Every client with an ACTIVE or PAUSED program: its tier and the groups the
   * rollout reaches it for (programRolloutCore.clientReachSummary — review
   * fix, Sep 28 2026: this read portal_sign_in alone, so an emails-only pilot
   * client read "not reached for this"), or why it reaches it for none.
   */
  clients: { name: string; tier: ReachTier | null; code: ReachRefusalCode | null; reason: string; groups: string[] }[];
};

export type ProviderReadiness = {
  id: ReadinessProvider;
  label: string;
  connected: boolean;
  /** "error" when the connection row says the provider refused us last time. */
  status: "connected" | "error" | "not connected";
  lastError: string | null;
  lastSyncedAt: Date | null;
  /** Titles of the automations that need it. */
  usedBy: string[];
};

export type CronFreshness = {
  job: string;
  cadenceMs: number;
  lastRunAt: Date | null;
  /** null = the last run never finished (still running, or killed mid-run). */
  lastOk: boolean | null;
  /** That run's error, when it failed. */
  lastError: string | null;
  stale: boolean;
  neverRecorded: boolean;
};

export type ReadinessReport = {
  generatedAt: Date;
  live: boolean;
  deploy: { page: string | null; lastSync: { deploy: string | null; startedAt: Date; finishedAt: Date | null } | null };
  /**
   * openers: effective for a real client now. armed: on for real clients but
   * held only by a missing dependency. Each names WHO, e.g. "Client reminders
   * — pilot: Acme Realty" (never a bare title that reads as every client).
   */
  rolloutClosed: {
    ok: boolean;
    openers: string[];
    armed: string[];
    /**
     * Who the OPENERS reach, for the banner (review fix, Sep 28 2026): "every
     * client with a program" only when at least one opener does; otherwise
     * the pilot's names. It used to follow the mode alone, so in ALL with only
     * pilot-scoped openers (the booking writes, or every program switch still
     * held by its own lock) it said "OPEN for every client with a program".
     * null when closed.
     */
    openFor: string | null;
  };
  programScope: ProgramScopeView;
  /** The transcript queue as the processor would face it now; null when it could not be read. */
  transcriptQueue: TranscriptQueueBatch | null;
  rows: ReadinessRow[];
  providers: ProviderReadiness[];
  crons: CronFreshness[];
  gmailSend: { checked: boolean; canSend: boolean | null; detail: string };
};

// ---- providers --------------------------------------------------------------

/** Which Connection rows (and env pairs) stand for each provider. Mirrors the
 *  readers: ai.ts, aryeo.ts, google.ts, slack.ts, dropbox.ts, openphone.ts,
 *  calendly.ts, transcription.ts (TRANSCRIPTION_CONNECTION_KEY), instagram.ts
 *  (META_CONNECTION, or META_APP_ID + META_APP_SECRET), topaz.ts. */
const PROVIDERS: Record<ReadinessProvider, { label: string; keys: string[]; env?: [string, string] }> = {
  ai: { label: "AI (Claude)", keys: ["ai"] },
  aryeo: { label: "Aryeo", keys: ["aryeo"] },
  gmail: { label: "Gmail", keys: ["gmail"] },
  openphone: { label: "OpenPhone", keys: ["openphone"] },
  slack: { label: "Slack", keys: ["slack"] },
  dropbox: { label: "Dropbox", keys: ["dropbox"] },
  calendly: { label: "Calendly", keys: ["calendly"] },
  topaz: { label: "Topaz", keys: ["topaz"] },
  stt: { label: "Speech-to-text", keys: ["transcription_openai", "transcription_deepgram"] },
  instagram: { label: "Instagram (Meta app)", keys: ["meta"], env: ["META_APP_ID", "META_APP_SECRET"] },
};
export const READINESS_PROVIDER_IDS = Object.keys(PROVIDERS) as ReadinessProvider[];

type ConnRow = { provider: string; status: string; secretEncrypted: string | null; lastError: string | null; lastSyncedAt: Date | null };

/** Providers whose own reader refuses unless the row says CONNECTED
 *  (transcription.ts, topaz.ts, instagram.ts). Every other reader uses the
 *  stored key whenever it exists — getSecret() checks nothing else. */
const STATUS_AWARE: ReadonlySet<ReadinessProvider> = new Set(["stt", "topaz", "instagram"]);

function providerState(id: ReadinessProvider, conns: Map<string, ConnRow>): { connected: boolean; status: ProviderReadiness["status"]; lastError: string | null; lastSyncedAt: Date | null } {
  const def = PROVIDERS[id];
  const rows = def.keys.map((k) => conns.get(k)).filter((r): r is ConnRow => !!r);
  // CONNECTED MEANS WHAT THE READER WILL DO WITH IT (review, Sep 28). A row
  // markError() flipped to ERROR keeps its key, and getSecret() hands that key
  // to aryeo.ts, the permit and every other plain reader: a pilot booking
  // still writes to Aryeo after one failed hourly sync. Reading ERROR as "not
  // connected" called those switches blocked, moved them out of the launch
  // gate's openers, and read "closed" while the writes went on. So a stored
  // key is connected, and ERROR is reported beside it (status, lastError) as
  // a health fact. The three status-aware readers keep the strict test.
  const live = rows.find((r) => !!r.secretEncrypted && (r.status === "CONNECTED" || (!STATUS_AWARE.has(id) && r.status !== "DISCONNECTED")));
  const envOk = def.env ? Boolean(process.env[def.env[0]]?.trim() && process.env[def.env[1]]?.trim()) : false;
  const errored = rows.find((r) => r.status === "ERROR");
  return {
    connected: Boolean(live) || envOk,
    status: live ? (live.status === "ERROR" ? "error" : "connected") : envOk ? "connected" : errored ? "error" : "not connected",
    lastError: errored?.lastError ?? null,
    lastSyncedAt: live?.lastSyncedAt ?? null,
  };
}

// ---- cron freshness -----------------------------------------------------------
//
// One reader for "is the scheduled run late": lib/cronHealth.ts (A01), which
// /connections and the CP-15 probe read too. Late is more than twice the
// job's vercel.json cadence since its last recorded start; a job with no rows
// is "never recorded", which is unknown, not late.
const HOUR = 3_600_000;
const CADENCE_MS: Record<AutomationCadence, number | null> = { hourly: HOUR, daily: 24 * HOUR, "on-action": null };

async function cronFreshness(now: Date): Promise<{ crons: CronFreshness[]; lastSyncSummary: Record<string, unknown> | null }> {
  const [health, lastSync] = await Promise.all([
    cronHealthByJob(1, now).catch(() => null),
    // The hourly run's own record of each step ("confirmationTextsError"…),
    // which the per-job health above does not carry.
    prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" }, select: { summary: true } }).catch(() => null),
  ]);
  let lastSyncSummary: Record<string, unknown> | null = null;
  if (lastSync?.summary) {
    try {
      const v: unknown = JSON.parse(lastSync.summary);
      if (v && typeof v === "object" && !Array.isArray(v)) lastSyncSummary = v as Record<string, unknown>;
    } catch { /* an unreadable summary names no step */ }
  }
  const crons = (health ?? [])
    .filter((h) => h.expected)
    .map((h) => ({
      job: h.job,
      cadenceMs: h.cadenceMs ?? 24 * HOUR,
      lastRunAt: h.lastRunAt ? new Date(h.lastRunAt) : null,
      lastOk: h.lastOk,
      lastError: (h.lastActing ?? h.runs[0])?.error ?? null,
      stale: h.stale,
      neverRecorded: h.neverRecorded,
    }));
  return { crons, lastSyncSummary };
}

// ---- scope -----------------------------------------------------------------

export type ScopeClient = { id: string; name: string | null; email: string | null };

/**
 * What is wrong with a provider-write switch's scope, without issuing a
 * permit (R02's rules in lib/hubWritePermit.ts decide the write; this only
 * judges whether the list on file can be written for at all). Pure.
 *
 * A fixture must BE one — exist, carry a TEST name, not be a real client on
 * the never-synthetic list, have the verified test inbox as its own email, and
 * not also sit in the pilot — the same checks setHubWriteFixtures refuses on.
 * And somebody must be in scope: a switch with no fixture and no approved,
 * unexpired pilot is on for nobody.
 */
export function fixtureScopeProblems(cfg: HubWriteScopeConfig, clients: Map<string, ScopeClient>, now: Date): string[] {
  const s = fixtureScope(cfg, clients, now);
  return [...s.entryProblems, ...s.blocking];
}

/**
 * The same judgement, split by what each problem STOPS (review, Sep 28). A bad
 * entry on the fixture list (a client since deleted or merged, an email that
 * drifted off the test inbox) stops writes for THAT entry only — the permit
 * decides per client (hubWritePermit.routeHubWrite), and an approved pilot
 * goes on writing to Aryeo for its real clients. Counted as whole-switch
 * blockers, one drifted fixture marked the switch "not effective" and moved it
 * out of the launch gate's openers while its pilot kept booking real orders.
 * `blocking` is only "nobody is in scope": no usable fixture and no active pilot.
 */
export function fixtureScope(cfg: HubWriteScopeConfig, clients: Map<string, ScopeClient>, now: Date): { entryProblems: string[]; blocking: string[] } {
  const entryProblems: string[] = [];
  let usable = 0;
  for (const id of cfg.authorizedFixtureClientIds) {
    const c = clients.get(id);
    const label = c?.name ? `"${c.name}"` : id;
    if (!c) entryProblems.push(`${id} is on the fixture list but no such client exists`);
    else if (isNeverSyntheticClientId(c.id)) entryProblems.push(`${label} is a real client carrying a TEST name`);
    else if (!isTestClientName(c.name)) entryProblems.push(`${label} is not a TEST client (a real client is written for only through an approved pilot)`);
    else if (!isVerifiedTestDestinationEmail(c.email)) entryProblems.push(`${label}'s own email is not the verified test inbox`);
    else if (cfg.pilot?.clientIds.includes(c.id)) entryProblems.push(`${label} is on both the fixture list and the pilot`);
    else usable++;
  }
  const ps = pilotState(cfg.pilot, now);
  const blocking: string[] = [];
  if (usable === 0 && ps !== "ACTIVE") {
    const fixtures = cfg.authorizedFixtureClientIds.length === 0 ? "no TEST fixture" : "no usable TEST fixture";
    blocking.push(
      ps === "EXPIRED" ? `no authorized client: ${fixtures}, and the pilot has expired`
        : ps === "UNAPPROVED" ? `no authorized client: ${fixtures}, and the pilot has no recorded approval`
          : `no authorized client: ${fixtures} and no approved pilot`,
    );
  }
  return { entryProblems, blocking };
}

// ---- a step's own outcome -----------------------------------------------------

type StepRun = { startedAt: Date; finishedAt: Date | null; summary: string | null };

/**
 * The newest run (newest first) that RAN `step` — its summary holds the step's
 * result, its `<step>Error`, or names it skipped or timed out — and how that
 * went. Null when none of `runs` did. Pure.
 */
export function lastStepOutcome(runs: StepRun[], step: string): { at: Date; error: string | null } | null {
  for (const r of runs) {
    let s: Record<string, unknown> | null = null;
    try { s = r.summary ? (JSON.parse(r.summary) as Record<string, unknown>) : null; } catch { s = null; }
    if (!s) continue;
    const skipped = Array.isArray(s.skipped) && (s.skipped as unknown[]).includes(step);
    const timedOut = Array.isArray(s.timedOut) && (s.timedOut as unknown[]).includes(step);
    const errText = typeof s[`${step}Error`] === "string" ? (s[`${step}Error`] as string) : null;
    if (!(step in s) && !errText && !skipped && !timedOut) continue;
    const error = errText
      ? errText
      : skipped ? "skipped: the run was out of time before it got there"
        : timedOut ? "timed out"
          : !r.finishedAt ? "the run did not finish"
            : null;
    return { at: r.startedAt, error };
  }
  return null;
}

// ---- the report --------------------------------------------------------------

const BUSINESS_SETTING_KEYS = ["auto_texts", "internal_alerts", "topaz", "editor_routing", "review_room"] as const;

type Stored = { enabled: boolean; enabledBy: string | null; enabledAt: Date | null; configJson: string | null; lastRunAt: Date | null; lastError: string | null; lastErrorAt: Date | null };

const parseObj = (raw: string | null | undefined): Record<string, unknown> | null | "unreadable" => {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : "unreadable";
  } catch {
    return "unreadable";
  }
};

const et = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const agoWords = (d: Date, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

export async function readinessReport(opts: { live?: boolean; now?: Date } = {}): Promise<ReadinessReport> {
  const now = opts.now ?? new Date();
  const live = opts.live === true;
  const settingsMod = await import("@/lib/settings");

  // The rollout scope, read through the SAME functions dispatch uses (see the
  // header): the stored value once (for the header and the hub pilots), and
  // one programAudience per client-reaching op (its lock, its line, its
  // clients). The call processor's batch, from the driver's own hold rule.
  const scopeOps = AUTOMATION_KEYS.filter((k) => AUTOMATION_EFFECTS[k].launchGate === "programScope" && isProgramReachOp(k)) as unknown as ProgramReachOp[];
  const rolloutMod = await import("@/lib/programRollout");
  const [rolloutRead, audienceList, signInAudience, transcriptQueue] = await Promise.all([
    rolloutMod.loadProgramRollout().then((r) => ({ ok: true as const, ...r })).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e) })),
    Promise.all(scopeOps.map((op) => rolloutMod.programAudience(op, { now }))),
    rolloutMod.programAudience("portal_sign_in", { now }),
    import("@/lib/transcriptJobs").then((m) => m.transcriptQueueBatch(now)).catch(() => null),
  ]);
  const audiences = new Map<string, ProgramAudience>(audienceList.map((a) => [a.op, a]));
  const rollout: ProgramRollout = rolloutRead.ok ? rolloutRead.rollout : { ...CLOSED_ROLLOUT };
  const rolloutProblem = rolloutRead.ok ? rolloutRead.problem : `the rollout could not be read from the database (${rolloutRead.error})`;

  const [automationRows, connRows, settingRows, cron, lastSync, texts, alerts, topaz, routing, reviewRoom, callMappingOn, gmailSend] = await Promise.all([
    prisma.programAutomation.findMany({ select: { key: true, enabled: true, enabledBy: true, enabledAt: true, configJson: true, lastRunAt: true, lastError: true, lastErrorAt: true } }),
    prisma.connection.findMany({ select: { provider: true, status: true, secretEncrypted: true, lastError: true, lastSyncedAt: true } }),
    prisma.appSetting.findMany({ where: { key: { in: [...BUSINESS_SETTING_KEYS] } }, select: { key: true } }),
    cronFreshness(now),
    lastRunDeploy("sync").catch(() => null),
    settingsMod.autoTextRules(),
    settingsMod.internalAlertRules(),
    settingsMod.topazSettings(),
    settingsMod.editorRouting(),
    settingsMod.reviewRoomRules(),
    import("@/lib/integrations/calendly").then((m) => m.hasEnabledCallMapping()).catch(() => null),
    live
      ? import("@/lib/integrations/google").then((m) => m.gmailSendHealth()).catch(() => null)
      : Promise.resolve(null),
  ]);

  const stored = new Map<string, Stored>(automationRows.map((r) => [r.key, r]));
  const conns = new Map<string, ConnRow>(connRows.map((c) => [c.provider, c]));
  const savedSettings = new Set(settingRows.map((s) => s.key));
  const providerNow = new Map(READINESS_PROVIDER_IDS.map((id) => [id, providerState(id, conns)]));
  const sync = cron.crons.find((c) => c.job === "sync") ?? null;

  // Gmail's send permission — only asked when the caller wants it live.
  const infoBox = gmailSend?.find((g) => g.email.toLowerCase() === "info@realtourpilot.com") ?? null;
  const sendAnswer = gmailSend ? (infoBox ? infoBox.canSend : gmailSend.some((g) => g.canSend === true) ? true : gmailSend.every((g) => g.canSend === false) && gmailSend.length > 0 ? false : null) : null;
  const gmailSendState: ReadinessReport["gmailSend"] = !live
    ? { checked: false, canSend: null, detail: "Gmail's permission to send was not checked on this load; press Check Gmail to ask Google." }
    : gmailSend === null
      ? { checked: true, canSend: null, detail: "Google could not be asked just now." }
      : gmailSend.length === 0
        ? { checked: true, canSend: null, detail: "No mailbox is connected." }
        : sendAnswer === true
          ? { checked: true, canSend: true, detail: `Checked ${et(now)}: ${infoBox ? infoBox.email : "a connected mailbox"} can send.` }
          : sendAnswer === false
            ? { checked: true, canSend: false, detail: `Checked ${et(now)}: ${infoBox ? infoBox.email : "the connected mailbox"} is connected but cannot send (it lacks the send permission). Reconnect it on Connections.` }
            : { checked: true, canSend: null, detail: `Checked ${et(now)}: Google did not say whether the mailbox can send.` };

  // The provider-write scopes: each switch's TEST fixtures as stored, with the
  // PILOT replaced by the program pilot (Jordan's Sep 28 rule, one list —
  // programRolloutCore.withProgramPilot, the same call the permit routes on).
  // An unreadable rollout is no pilot at all: nobody real is written for.
  const storedScopeCfgs = new Map<AutomationKey, HubWriteScopeConfig>();
  const scopeCfgs = new Map<AutomationKey, HubWriteScopeConfig>();
  for (const key of AUTOMATION_KEYS) {
    if (!isHubWriteSwitch(key)) continue;
    const obj = parseObj(stored.get(key)?.configJson);
    const cfg = parseHubWriteConfig(obj === "unreadable" ? null : obj);
    storedScopeCfgs.set(key, cfg);
    scopeCfgs.set(key, rolloutRead.ok ? withProgramPilot(cfg, rollout, key) : { authorizedFixtureClientIds: [...cfg.authorizedFixtureClientIds], pilot: null });
  }
  const scopeIds = [...new Set([...scopeCfgs.values(), ...storedScopeCfgs.values()].flatMap((c) => [...c.authorizedFixtureClientIds, ...(c.pilot?.clientIds ?? [])]))];
  const scopeClients = scopeIds.length
    ? await prisma.client.findMany({ where: { id: { in: scopeIds } }, select: { id: true, name: true, email: true } })
    : [];
  const clientsById = new Map<string, ScopeClient>(scopeClients.map((c) => [c.id, c]));
  const namesById = new Map(scopeClients.map((c) => [c.id, c.name ?? c.id]));

  // Reminder policy — the one shape the evaluator reads (programReminders.ts).
  // Only its VALIDITY is judged here now: its testClientsOnly lock is read,
  // with every other feature's, by programRollout.featureTestOnlyFor inside
  // programAudience — the one lock reader (the private readers are gone).
  const { REMINDER_DEFAULTS, validateReminderPolicy } = await import("@/lib/programReminders");
  const remindersObj = parseObj(stored.get("reminders")?.configJson);
  const reminderCheck = remindersObj === "unreadable"
    ? { ok: false, errors: ["the stored reminder policy is not valid JSON"] }
    : (() => {
        const v = validateReminderPolicy({ ...REMINDER_DEFAULTS, ...(remindersObj ?? {}) });
        return { ok: v.ok, errors: v.ok ? [] : v.errors };
      })();

  // Who each client-reaching row reaches, in the launch gate's words. The
  // pilot is named from the stored list itself (as the scope line names it),
  // not from who happens to hold a program today.
  const whoOf = new Map<string, string>();
  const pilotIds = rollout.pilot?.clientIds ?? [];
  const pilotRows = pilotIds.length ? await prisma.client.findMany({ where: { id: { in: pilotIds } }, select: { id: true, name: true } }) : [];
  const pilotNamesAll = pilotIds.map((id) => pilotRows.find((c) => c.id === id)?.name ?? `${id} (not found)`);
  // What waits in the transcript queue for a switch that depends on it.
  const q = transcriptQueue;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const waitingOnProcessor = (key: AutomationKey): string => {
    if (!q) return "";
    if (key === "strategy_generation") return ` — ${plural(q.byKind.STRATEGY_DRAFT ?? 0, "strategy draft is", "strategy drafts are")} queued and not being processed`;
    if (key === "script_drafting" || key === "fact_extraction") return ` — ${plural(q.byKind.ANALYZE ?? 0, "call analysis is", "call analyses are")} queued and not being processed`;
    return ` — ${plural(q.queued, "job is", "jobs are")} queued and not being processed`;
  };
  // The manual buttons never touch the queue (aiRuns.ts: a person's click is
  // attended), and the rows whose work the queue does say so.
  const INLINE_BUTTONS = "The Draft strategy now, Draft owed scripts and Re-analyse buttons run straight away and do not use the queue.";

  // call_booking's API mode and its stored read-only probe (callBooking.ts).
  const callCfg = parseObj(stored.get("call_booking")?.configJson);
  const callApi = callCfg && callCfg !== "unreadable" && callCfg.mode === "API";
  let callProbe: string | null = null;
  if (callApi) {
    try {
      const cb = await import("@/lib/callBooking");
      const [probe, mapping] = await Promise.all([cb.storedSchedulingProbe(), cb.monthlyStrategyMapping()]);
      if (!mapping) callProbe = "no monthly strategy event type is mapped";
      else if (!probe) callProbe = "the Scheduling API probe has not been run";
      else if (probe.status !== "ok" || probe.eventTypeUri !== mapping.eventTypeUri) callProbe = `the Scheduling API probe has not passed for the mapped event type (${probe.status})`;
    } catch {
      callProbe = "the Scheduling API probe could not be read";
    }
  }

  const title = (k: AutomationKey) => AUTOMATION_EFFECTS[k].title;
  const rows: ReadinessRow[] = [];

  // ---- the content-program switches ---------------------------------------
  for (const key of AUTOMATION_KEYS) {
    const e = AUTOMATION_EFFECTS[key];
    const s = stored.get(key) ?? null;
    const enabled = s?.enabled === true;
    const needs = e.requires ?? {};

    // configured. configProblems stop the switch; configWarnings are wrong
    // entries that stop nothing else (a drifted fixture), shown, never blockers.
    const configProblems: string[] = [];
    const configWarnings: string[] = [];
    const cfgObj = parseObj(s?.configJson);
    if (cfgObj === "unreadable") configProblems.push("the stored config is not valid JSON");
    for (const check of needs.config ?? ([] as ReadinessConfigCheck[])) {
      if (check === "reminderPolicy" && !reminderCheck.ok) configProblems.push(`the reminder policy would not run: ${reminderCheck.errors.join(" · ")}`);
      if (check === "fixtures") {
        const cfg = scopeCfgs.get(key);
        if (cfg) {
          const fx = fixtureScope(cfg, clientsById, now);
          configProblems.push(...fx.blocking);
          configWarnings.push(...fx.entryProblems);
        }
      }
      if (check === "callApiMode") {
        if (!callApi) configProblems.push("config mode is EMBED: the portal embeds Calendly and the hub books nothing itself");
        else if (callProbe) configProblems.push(callProbe);
      }
    }
    const configured = !s
      ? { ok: false, detail: "never configured: no row exists, which is the same as off" }
      : configProblems.length || configWarnings.length
        ? { ok: false, detail: [...configProblems, ...configWarnings.map((w) => `${w} (this entry only; the rest of the scope still applies)`)].join(" · ") }
        : { ok: true, detail: "saved, and its settings would run" };

    // connected
    const provs = needs.providers ?? [];
    const missing = provs.filter((p) => !providerNow.get(p)?.connected);
    const gmailCannotSend = provs.includes("gmail") && gmailSendState.canSend === false;
    const connected = provs.length === 0
      ? { ok: null, providers: [], missing: [], detail: "needs no outside connection" }
      : {
          ok: missing.length === 0 && !gmailCannotSend,
          providers: provs.map((p) => PROVIDERS[p].label),
          missing: missing.map((p) => PROVIDERS[p].label),
          detail: missing.length
            ? `not connected: ${missing.map((p) => PROVIDERS[p].label).join(", ")}`
            : gmailCannotSend ? "Gmail is connected but cannot send" : `connected: ${provs.map((p) => PROVIDERS[p].label).join(", ")}`,
        };

    // enabled
    const enabledState = {
      ok: enabled,
      detail: !s ? "never configured" : enabled ? `on since ${s.enabledAt ? et(s.enabledAt) : "an unrecorded time"}${s.enabledBy ? ` (${s.enabledBy})` : ""}` : "off",
    };

    // effective: every reason it would not act, whether or not it is on — so
    // the owner sees what else it needs before he turns it on.
    const blockers: string[] = [];
    for (const dep of needs.switches ?? []) {
      if (stored.get(dep)?.enabled !== true) blockers.push(`needs ${dep} switched on: “${title(dep)}”${dep === "transcript_jobs" ? waitingOnProcessor(key) : ""}`);
    }
    for (const p of missing) blockers.push(p === "instagram" || p === "stt" ? (e.blocked ?? `needs ${PROVIDERS[p].label} connected`) : `needs ${PROVIDERS[p].label} connected`);
    if (gmailCannotSend) blockers.push("Gmail is connected but cannot send");
    if (configProblems.length) blockers.push(...configProblems);
    if (key === "legacy_call_sweeps" && (needs.config ?? []).includes("noCallMapping") && callMappingOn === true) {
      blockers.push("stands down while a Calendly event type is mapped (by design)");
    }
    // Filled in after every row exists (a partial dependency is judged by the
    // dependency's own EFFECTIVE verdict, which may come later in the list).
    const effective = { ok: enabled && blockers.length === 0, blockers, partial: [] as string[] };

    // healthy
    const cadenceMs = CADENCE_MS[e.cadence];
    const lastRunAt = s?.lastRunAt ?? null;
    const stale = Boolean(enabled && effective.ok && cadenceMs && lastRunAt && now.getTime() - lastRunAt.getTime() > 2 * cadenceMs);
    const hostLate = Boolean(enabled && effective.ok && e.cadence === "hourly" && sync?.stale);
    // A provider it needs is connected but refused the hub last time: still
    // working (the key is used), not healthy (review, Sep 28 — see providerState).
    const refused = provs.find((p) => providerNow.get(p)?.connected && providerNow.get(p)?.status === "error") ?? null;
    // HEALTHY NEEDS EVIDENCE (review, Sep 28). An on-action switch with no run
    // recorded used to read "healthy yes" — and several of them never record a
    // run at all, so they could read nothing else. No run on file is null,
    // whatever the cadence: "nothing reported healthy that has never run".
    const healthy: ReadinessRow["healthy"] = !enabled
      ? { ok: null, lastRunAt, lastError: null, stale: false, detail: "off, so there is nothing to check" }
      : s?.lastError
        ? { ok: false, lastRunAt, lastError: s.lastError, stale, detail: `last run failed${s.lastErrorAt ? ` ${et(s.lastErrorAt)}` : ""}: ${s.lastError.slice(0, 200)}` }
        : !effective.ok
          ? { ok: null, lastRunAt, lastError: null, stale: false, detail: "blocked, so it is not running" }
          : stale
            ? { ok: false, lastRunAt, lastError: null, stale: true, detail: `late: last ran ${agoWords(lastRunAt!, now)}, and it runs ${e.cadence}` }
            : hostLate
              ? { ok: false, lastRunAt, lastError: null, stale: true, detail: `the hourly run is late: it last started ${agoWords(sync!.lastRunAt!, now)}` }
              : refused
                ? { ok: false, lastRunAt, lastError: providerNow.get(refused)?.lastError ?? null, stale: false, detail: `${PROVIDERS[refused].label} is connected but refused the hub last time${providerNow.get(refused)?.lastError ? `: ${providerNow.get(refused)!.lastError!.slice(0, 160)}` : ""}` }
                : lastRunAt
                  ? { ok: true, lastRunAt, lastError: null, stale: false, detail: `last ran ${agoWords(lastRunAt, now)}` }
                  : { ok: null, lastRunAt: null, lastError: null, stale: false, detail: e.cadence === "on-action" ? "no run recorded yet (it runs when something happens)" : "no run recorded yet" };

    // scope, and whether it touches real clients. Never "every client" unless
    // the rollout says everyone (the deleted fallback said it for five
    // switches that had no lock at all).
    let scope: string | null = null;
    let realClients = false;
    if (e.reaches === "clients") {
      if (e.launchGate === "hubWriteScope") {
        const cfg = scopeCfgs.get(key)!;
        const d = describeHubWriteScope(key as Parameters<typeof describeHubWriteScope>[0], { enabled, missing: !s, config: cfg }, namesById, now);
        const pilotNames = (cfg.pilot?.clientIds ?? []).map((id) => namesById.get(id) ?? id);
        const writes = d.pilotState === "ACTIVE" && (cfg.pilot?.operations.length ?? 0) > 0;
        const parts = [`TEST fixtures: ${d.fixtures}`, `program pilot: ${d.pilot}`];
        if (!rolloutRead.ok) parts.push(`the program rollout could not be read, so no pilot client is written for (${rolloutRead.error})`);
        else if (d.pilotState === "ACTIVE" && !writes) parts.push(`pilot clients ${pilotNames.join(", ")} are not written for — the program pilot does not include bookings`);
        const onFile = storedScopeCfgs.get(key)?.pilot?.clientIds ?? [];
        if (onFile.length) parts.push(`the older per-switch pilot on file (${onFile.map((id) => namesById.get(id) ?? id).join(", ")}) is no longer read — the program pilot decides`);
        scope = parts.join(" · ");
        realClients = writes;
        if (writes) whoOf.set(key, `pilot: ${pilotNames.join(", ")}`);
      } else if (e.launchGate === "programScope") {
        const aud = audiences.get(key);
        scope = aud?.line ?? "TEST clients only — the rollout scope could not be read";
        realClients = aud?.realClients === true;
        // ALL reaches everyone only where the feature's own lock is lifted
        // (realClients is false under the lock), so "every client" is honest.
        // Per client since Oct 5 2026 (Client onboarding): name the pilot clients THIS switch reaches.
        if (aud && realClients) whoOf.set(key, aud.mode === "ALL" ? "every client with a program" : `pilot: ${(aud.clients.some((x) => x.tier === "PILOT") ? aud.clients.filter((x) => x.tier === "PILOT").map((x) => x.name) : pilotNamesAll).join(", ")}`);
      } else {
        // A client-reaching switch with no declared gate would be a copy
        // mistake; say so rather than guess an audience.
        scope = "no audience rule is declared for this switch";
      }
    }

    const note =
      key === "transcript_jobs" ? [q ? q.queuedNowLine : "Queued now: the queue could not be read", q?.line ?? null, INLINE_BUTTONS].filter(Boolean).join(". ")
        : key === "strategy_generation" || key === "script_drafting" ? INLINE_BUTTONS
          : null;

    rows.push({
      key, kind: "program", group: "program", title: e.title, reaches: e.reaches,
      configured, connected, enabled: enabledState, effective, healthy,
      recipients: e.recipients, scope, note, cadence: e.cadence,
      launchGated: e.reaches === "clients", realClients,
    });
  }

  // ---- partial dependencies and queue health (R05) -----------------------------
  // A partial dependency stops one named path: blocked for that path, and the
  // switch is never "healthy" while it stands — but it is not a whole-switch
  // blocker, so a switch whose other path runs is not called "NOT working".
  const rowOf = (k: string) => rows.find((r) => r.key === k) ?? null;
  for (const key of AUTOMATION_KEYS) {
    const partial = AUTOMATION_EFFECTS[key].requires?.partial ?? [];
    const row = rowOf(key);
    if (!row || !partial.length) continue;
    for (const dep of partial) {
      if (rowOf(dep.switch)?.effective.ok) continue;
      row.effective.partial.push(`${dep.why}: needs ${dep.switch} working (“${title(dep.switch)}”)${dep.switch === "transcript_jobs" ? waitingOnProcessor(key) : ""}`);
    }
    if (row.enabled.ok && row.effective.ok && row.effective.partial.length) {
      const words = `partly blocked: ${row.effective.partial.join("; ")}`;
      row.healthy = row.healthy.ok === false
        ? { ...row.healthy, detail: `${row.healthy.detail}; ${words}` }
        : { ok: false, lastRunAt: row.healthy.lastRunAt, lastError: null, stale: false, detail: words };
    }
  }
  // The processor itself: on and working, but its oldest runnable job has
  // waited longer than the queue's own length explains (two hours, plus an
  // hour for every batch of five ahead of it) → it is not draining.
  const tj = rowOf("transcript_jobs");
  if (tj && tj.effective.ok && tj.healthy.ok !== false && q?.oldestRunnableSince) {
    const waitedMs = now.getTime() - q.oldestRunnableSince.getTime();
    const allowMs = 2 * HOUR + q.ticksToDrain * HOUR;
    if (waitedMs > allowMs) {
      tj.healthy = { ok: false, lastRunAt: tj.healthy.lastRunAt, lastError: null, stale: true, detail: `queue not draining: a runnable job has waited ${agoWords(q.oldestRunnableSince, now).replace(" ago", "")} (${q.runnableNow} runnable)` };
    }
  }

  // ---- the business automations that already run ---------------------------
  // Their switches live in their own cards; this only reads them. Health comes
  // from the cron run that hosts them (and, for the hourly sweeps, that run's
  // own record of the step).
  const stepError = (step: string): string | null => {
    const v = cron.lastSyncSummary?.[`${step}Error`];
    return typeof v === "string" && v ? v : null;
  };
  const cronOf = (job: string) => cron.crons.find((c) => c.job === job) ?? null;
  // A STEP OF A JOB THAT DOES NOT RUN IT EVERY TIME (review, Sep 28). The
  // evening route runs the digest at 7 PM, the chaser at 10 PM, and at its DST
  // twins nothing; the upload reminder and chaser were judged by the evening
  // run's START time alone, so a 7 PM run whose digest "sent nothing" (500,
  // ok=false) still read "healthy yes: the evening run last started 0 min
  // ago". Each is now judged by the newest run that ran ITS step.
  const stepRuns = new Map<string, StepRun[]>();
  for (const job of ["evening"]) {
    stepRuns.set(job, await prisma.cronRun
      .findMany({ where: { job }, orderBy: { startedAt: "desc" }, take: 12, select: { startedAt: true, finishedAt: true, summary: true } })
      .catch(() => []));
  }
  const business = (b: {
    key: string; group: SettingsGroupId; title: string; reaches: ReadinessRow["reaches"];
    saved: boolean; enabled: boolean; enabledDetail?: string; providers: ReadinessProvider[];
    job: string | null; step?: string; recipients: string; scope: string | null; cadence: AutomationCadence;
  }) => {
    const missing = b.providers.filter((p) => !providerNow.get(p)?.connected);
    const blockers = missing.map((p) => `needs ${PROVIDERS[p].label} connected`);
    const effectiveOk = b.enabled && blockers.length === 0;
    const host = b.job ? cronOf(b.job) : null;
    // The hourly run does every step every hour, so its newest summary speaks
    // for each; any other host is read for the newest run of THIS step.
    const stepRun = b.job && b.job !== "sync" && b.step ? lastStepOutcome(stepRuns.get(b.job) ?? [], b.step) : null;
    const err = b.step ? (b.job === "sync" ? stepError(b.step) : stepRun?.error ?? null) : null;
    const healthy: ReadinessRow["healthy"] = !b.enabled
      ? { ok: null, lastRunAt: host?.lastRunAt ?? null, lastError: null, stale: false, detail: "off, so there is nothing to check" }
      : !effectiveOk
        ? { ok: null, lastRunAt: host?.lastRunAt ?? null, lastError: null, stale: false, detail: "blocked, so it is not running" }
        : err
          ? { ok: false, lastRunAt: stepRun?.at ?? host?.lastRunAt ?? null, lastError: err, stale: false, detail: `the last ${b.job} run failed at this step${stepRun ? ` (${et(stepRun.at)})` : ""}: ${err.slice(0, 200)}` }
          : host?.stale
            ? { ok: false, lastRunAt: host.lastRunAt, lastError: null, stale: true, detail: `late: the ${b.job} run last started ${agoWords(host.lastRunAt!, now)}` }
            : stepRun
              ? { ok: true, lastRunAt: stepRun.at, lastError: null, stale: false, detail: `last ran ${agoWords(stepRun.at, now)}, in the ${b.job} run` }
              : b.step && b.job !== "sync" && host && !host.neverRecorded
                ? { ok: null, lastRunAt: null, lastError: null, stale: false, detail: `not run yet in the runs on file (the ${b.job} run last started ${agoWords(host.lastRunAt!, now)})` }
                // A row that IS its whole run (Topaz) fails with it; a row that
                // is one step of a shared run is judged by its step alone.
                : !b.step && host && !host.neverRecorded && host.lastOk === false
                  ? { ok: false, lastRunAt: host.lastRunAt, lastError: host.lastError, stale: false, detail: `the last ${b.job} run failed${host.lastError ? `: ${host.lastError.slice(0, 200)}` : ""}` }
                  : host && !host.neverRecorded
                    ? { ok: true, lastRunAt: host.lastRunAt, lastError: null, stale: false, detail: `the ${b.job} run last started ${agoWords(host.lastRunAt!, now)}` }
                    // No host job: it runs inside other code and keeps no run
                    // record, so there is no evidence to call it healthy.
                    : { ok: null, lastRunAt: null, lastError: null, stale: false, detail: b.job ? `no ${b.job} run recorded yet` : "runs when something happens; no run record is kept" };
    rows.push({
      key: b.key, kind: "business", group: b.group, title: b.title, reaches: b.reaches,
      configured: { ok: true, detail: b.saved ? "saved in Settings" : "the built-in defaults (never changed here)" },
      connected: b.providers.length
        ? { ok: missing.length === 0, providers: b.providers.map((p) => PROVIDERS[p].label), missing: missing.map((p) => PROVIDERS[p].label), detail: missing.length ? `not connected: ${missing.map((p) => PROVIDERS[p].label).join(", ")}` : `connected: ${b.providers.map((p) => PROVIDERS[p].label).join(", ")}` }
        : { ok: null, providers: [], missing: [], detail: "needs no outside connection" },
      enabled: { ok: b.enabled, detail: b.enabledDetail ?? (b.enabled ? "on" : "off") },
      effective: { ok: effectiveOk, blockers, partial: [] },
      healthy, recipients: b.recipients, scope: b.scope, note: null, cadence: b.cadence,
      launchGated: false, realClients: b.reaches === "clients",
    });
  };

  const textsSaved = savedSettings.has("auto_texts");
  const textSub = (on: boolean) => (!texts.enabled ? "off: the master switch for automated texts is off" : on ? "on" : "off");
  // Approved and running (§4): reported, never counted in the launch gate —
  // the panel says so once, above these rows, rather than on each of them.
  const APPROVED = "every client with a job";
  business({ key: "auto_texts.confirmation", group: "comms", title: "Shoot confirmation texts", reaches: "clients", saved: textsSaved, enabled: texts.enabled && texts.confirmation.enabled, enabledDetail: textSub(texts.confirmation.enabled), providers: ["openphone"], job: "sync", step: "confirmationTexts", recipients: `The client on the job, by text from the company line, ${texts.confirmation.hoursBefore} hours before the shoot`, scope: APPROVED, cadence: "hourly" });
  business({ key: "auto_texts.delivery", group: "comms", title: "Delivery feedback texts", reaches: "clients", saved: textsSaved, enabled: texts.enabled && texts.delivery.enabled, enabledDetail: textSub(texts.delivery.enabled), providers: ["openphone"], job: "sync", step: "deliveryTexts", recipients: "The client on the job, by text, once the whole job has landed", scope: APPROVED, cadence: "hourly" });
  business({ key: "auto_texts.afterHours", group: "comms", title: "After-hours replies", reaches: "clients", saved: textsSaved, enabled: texts.enabled && texts.afterHours.enabled, enabledDetail: textSub(texts.afterHours.enabled), providers: ["openphone"], job: "sync", step: "afterHoursReplies", recipients: "A client who texts outside office hours, by text", scope: APPROVED, cadence: "hourly" });
  business({ key: "auto_texts.welcome", group: "comms", title: "New-client welcome text", reaches: "clients", saved: textsSaved, enabled: texts.enabled && texts.welcome.enabled, enabledDetail: textSub(texts.welcome.enabled), providers: ["openphone"], job: "sync", step: "welcomeTexts", recipients: "A brand-new client, by text, when their first shoot is booked", scope: APPROVED, cadence: "hourly" });

  const alertsSaved = savedSettings.has("internal_alerts");
  business({ key: "internal_alerts.uploadReminder", group: "comms", title: "Upload reminder (7 PM digest)", reaches: "staff", saved: alertsSaved, enabled: alerts.uploadReminder.enabled, providers: ["openphone"], job: "evening", step: "digests", recipients: "Each photographer with shoots that day, one text", scope: null, cadence: "daily" });
  business({ key: "internal_alerts.uploadChaser", group: "comms", title: "Upload chaser (late-night nudge)", reaches: "staff", saved: alertsSaved, enabled: alerts.uploadChaser.enabled, providers: ["openphone"], job: "evening", step: "nags", recipients: "Each photographer whose upload page is still not submitted, by text", scope: null, cadence: "daily" });
  business({ key: "internal_alerts.photosUndelivered", group: "comms", title: "Photos not delivered alert", reaches: "staff", saved: alertsSaved, enabled: alerts.photosUndelivered.enabled, providers: ["openphone"], job: "sync", step: "photosUndelivered", recipients: "Kyle and Jordan, by text, inside covered hours", scope: null, cadence: "hourly" });
  business({ key: "internal_alerts.rawVideoMissing", group: "comms", title: "Raw video missing alert", reaches: "staff", saved: alertsSaved, enabled: alerts.rawVideoMissing.enabled, providers: [], job: null, recipients: "The photographer on the job, by bell (and the text or Slack DM it bridges to)", scope: null, cadence: "on-action" });
  business({ key: "internal_alerts.kyleDigests", group: "comms", title: "Kyle's Slack digests", reaches: "staff", saved: alertsSaved, enabled: alerts.kyleDigests.enabled, providers: ["slack"], job: null, recipients: "Kyle, by Slack DM", scope: null, cadence: "on-action" });

  const teamIds = [reviewRoom.creativeApproverTeamMemberId, reviewRoom.backupReviewerTeamMemberId, reviewRoom.fallbackReviewerTeamMemberId].filter((x): x is string => !!x);
  const team = teamIds.length ? await prisma.teamMember.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }).catch(() => []) : [];
  const nameOf = (id: string | null) => (id ? team.find((t) => t.id === id)?.name ?? "someone no longer on the roster" : null);
  const [primary, backup, fallback] = [nameOf(reviewRoom.creativeApproverTeamMemberId), nameOf(reviewRoom.backupReviewerTeamMemberId), nameOf(reviewRoom.fallbackReviewerTeamMemberId)];

  business({ key: "topaz", group: "production", title: "1080p video pass (Topaz)", reaches: "internal", saved: savedSettings.has("topaz"), enabled: topaz.enabled, providers: ["topaz"], job: "topaz", recipients: "Kyle, as a card with the finished file. The file lands in the job's Dropbox", scope: null, cadence: "on-action" });
  const routeWords = (k: string | null) => (k ? k[0].toUpperCase() + k.slice(1) : "Needs assigning (by hand)");
  business({
    key: "editor_routing", group: "production", title: "Editor auto-assignment", reaches: "staff", saved: savedSettings.has("editor_routing"),
    enabled: Boolean(routing.standardVideo || routing.premiumVideo || routing.personalBranding),
    enabledDetail: routing.standardVideo || routing.premiumVideo || routing.personalBranding ? "on for at least one kind of video" : "off: every kind goes to Needs assigning",
    providers: [], job: null,
    recipients: `Standard video: ${routeWords(routing.standardVideo)} · Premium: ${routeWords(routing.premiumVideo)} · Personal branding: ${routeWords(routing.personalBranding)}`,
    scope: null, cadence: "on-action",
  });
  business({
    key: "review_room.coverage", group: "production", title: "Video review owner", reaches: "staff", saved: savedSettings.has("review_room"),
    enabled: Boolean(primary || backup || fallback),
    enabledDetail: primary ? `${primary} reviews` : "nobody named: the creative-manager flag, then the office, answers",
    providers: [], job: null,
    recipients: [primary ? `${primary} reviews` : null, backup ? `${backup} covers` : null, fallback ? `${fallback} is the fallback` : null].filter(Boolean).join(" · ") || "Nobody named",
    scope: null, cadence: "on-action",
  });

  // ---- providers and the launch gate -------------------------------------------
  const usedBy = new Map<ReadinessProvider, string[]>();
  for (const key of AUTOMATION_KEYS) for (const p of AUTOMATION_EFFECTS[key].requires?.providers ?? []) usedBy.set(p, [...(usedBy.get(p) ?? []), AUTOMATION_EFFECTS[key].title]);
  const providers: ProviderReadiness[] = READINESS_PROVIDER_IDS.map((id) => {
    const st = providerNow.get(id)!;
    return { id, label: PROVIDERS[id].label, connected: st.connected, status: st.status, lastError: st.lastError, lastSyncedAt: st.lastSyncedAt, usedBy: usedBy.get(id) ?? [] };
  });

  const gated = rows.filter((r) => r.launchGated && r.realClients);
  const named = (r: ReadinessRow) => `${r.title} — ${whoOf.get(r.key) ?? "real clients"}`;
  const openRows = gated.filter((r) => r.effective.ok);
  const openers = openRows.map(named);
  const armed = gated.filter((r) => r.enabled.ok && !r.effective.ok).map(named);
  const EVERY = "every client with a program";
  const openWho = openRows.map((r) => whoOf.get(r.key) ?? "real clients");
  const openFor = !openRows.length
    ? null
    : openWho.includes(EVERY)
      ? EVERY
      : openWho.every((w) => w.startsWith("pilot: "))
        ? `the pilot: ${[...new Set(openWho.flatMap((w) => w.slice("pilot: ".length).split(", ")))].join(", ")}`
        : "real clients";

  // ---- who the program may reach (the header of the panel) -------------------
  const p = rollout.pilot;
  const programScope: ProgramScopeView = {
    mode: rollout.mode,
    modeSince: rollout.modeSince ? new Date(rollout.modeSince) : null,
    pilotState: pilotStateOf(rollout, now),
    cap: PROGRAM_PILOT_MAX,
    pilot: p && p.clientIds.length
      ? {
          names: pilotNamesAll,
          groups: PROGRAM_PILOT_GROUPS.filter((g) => g.ops.every((op) => p.operations.includes(op))).map((g) => g.label),
          approvedBy: p.approvedBy, approvedAt: p.approvedAt ? new Date(p.approvedAt) : null, expiresAt: p.expiresAt ? new Date(p.expiresAt) : null, note: p.note,
        }
      : null,
    problem: rolloutProblem ?? signInAudience.problem,
    updatedBy: rolloutRead.ok ? rolloutRead.updatedBy : null,
    updatedAt: rolloutRead.ok ? rolloutRead.updatedAt : null,
    clients: signInAudience.clients.map((c) => {
      // A stored value that could not be read keeps the one decision (it says why).
      if (!rolloutRead.ok || rolloutRead.problem) return { name: c.name, tier: c.tier, code: c.decision.ok ? null : c.decision.code, reason: c.decision.reason, groups: [] };
      const sum = clientReachSummary(rollout, { id: c.clientId, name: c.name }, now);
      return { name: c.name, tier: sum.tier, code: sum.code, reason: sum.reason, groups: sum.groups.map((k) => PROGRAM_PILOT_GROUP_SHORT[k]) };
    }),
  };

  return {
    generatedAt: now,
    live,
    deploy: { page: deployStamp(), lastSync: lastSync ?? null },
    rolloutClosed: { ok: openers.length === 0, openers, armed, openFor },
    programScope,
    transcriptQueue,
    rows,
    providers,
    crons: cron.crons,
    gmailSend: gmailSendState,
  };
}

/** One plain line per row. The CP-15 probe prints it as each row's evidence
 *  (scripts/_recon/cp15-config-probe.ts readinessFacts), so the probe and the
 *  panel word a row the same way. */
export function readinessLine(r: ReadinessRow): string {
  const mark = (v: boolean | null) => (v === null ? "-" : v ? "yes" : "NO");
  return [
    r.key,
    `configured ${mark(r.configured.ok)}`,
    `connected ${mark(r.connected.ok)}`,
    `enabled ${mark(r.enabled.ok)}`,
    `effective ${mark(r.effective.ok)}${r.effective.blockers.length ? ` (${r.effective.blockers.join("; ")})` : ""}`,
    r.effective.partial.length ? `partly blocked (${r.effective.partial.join("; ")})` : null,
    `healthy ${mark(r.healthy.ok)} (${r.healthy.detail})`,
    r.scope ? `scope: ${r.scope}` : null,
  ].filter(Boolean).join(" · ");
}

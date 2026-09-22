import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE SWITCH FOR EVERY CONTENT-PROGRAM AUTOMATION — in one place, on purpose.
//
// Jordan, Sep 16 2026: no client invitations, no reminders, no publishing until
// he authorises launch; existing approved communications continue. The schema
// push created NO ProgramAutomation rows (nothing may be seeded against
// production), so "off at the database" is only true if every driver reads the
// switch the same way. The rule, and the only rule:
//
//     a MISSING row is DISABLED. so is enabled=false. so is anything else.
//
// There is no code default that turns an automation on. Code defaults apply
// only to configJson VALUES (cadence, timezone, templates) and only once a row
// exists AND is enabled — which is why automationConfig() returns null when the
// switch is off rather than a default object a caller might act on.
//
// Every cron step, job driver and "Approve & share" style action calls
// isAutomationEnabled(key) FIRST. Never inline the lookup; never cache it
// across requests (the owner's "stop" must take effect on the next tick, not
// the next deploy). Keys and what each gates: docs/CONTENT-PROGRAM-SCHEMA.md §5.
// ---------------------------------------------------------------------------

export const AUTOMATION_KEYS = [
  "reminders", // §24 client reminders (new outbox kinds; never the existing auto texts)
  "transcript_jobs", // §20 analyse a call transcript into topics/answers/facts/scripts
  "script_drafting", // §6/§7 draft the scripts a planned month owes, from the client's answers or the call
  "ai_runs", // §13 master switch for any ProgramAiRun execution
  "publishing", // §12 Instagram (no credentials exist today)
  "script_share_email", // §22 "Approve & share" → email to the client
  "portal_invites", // §2 stage B — invite a real client
  "portal_login_email", // §2 magic-link sign-in email (transactional; D14)
  "topic_refresh", // §18 one-click topic refresh
  "strategy_generation", // §21 discovery → strategy draft
  "session_booking", // §4 true self-booking against Aryeo
  "cut_transcripts", // §9 (no speech-to-text provider exists today)
  "caption_assistant", // §10
  "fact_extraction", // §23 auto-accept rules for extracted facts
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export function isAutomationKey(k: unknown): k is AutomationKey {
  return typeof k === "string" && (AUTOMATION_KEYS as readonly string[]).includes(k);
}

export type AutomationState = {
  key: AutomationKey;
  /** The ONLY thing a driver may act on. false when the row is missing. */
  enabled: boolean;
  /** Parsed configJson, or null when missing/unparseable/disabled. */
  config: Record<string, unknown> | null;
  enabledBy: string | null;
  enabledAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** true when no row exists at all — the settings screen says "never configured". */
  missing: boolean;
};

/** Is this automation allowed to do anything right now? Missing row = no. */
export async function isAutomationEnabled(key: AutomationKey): Promise<boolean> {
  const row = await prisma.programAutomation.findUnique({ where: { key }, select: { enabled: true } });
  return row?.enabled === true;
}

/** The full state for a settings screen or a driver that needs its config. */
export async function getAutomation(key: AutomationKey): Promise<AutomationState> {
  const row = await prisma.programAutomation.findUnique({ where: { key } });
  if (!row) {
    return { key, enabled: false, config: null, enabledBy: null, enabledAt: null, lastRunAt: null, lastError: null, lastErrorAt: null, missing: true };
  }
  let config: Record<string, unknown> | null = null;
  if (row.enabled && row.configJson) {
    try {
      const parsed: unknown = JSON.parse(row.configJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      /* unreadable config reads as "no config"; enabled is still honoured by the caller through automationConfig */
    }
  }
  return {
    key, enabled: row.enabled === true, config,
    enabledBy: row.enabledBy, enabledAt: row.enabledAt, lastRunAt: row.lastRunAt, lastError: row.lastError, lastErrorAt: row.lastErrorAt,
    missing: false,
  };
}

/**
 * Config for an ENABLED automation, with code defaults filled in underneath the
 * stored values. Returns null when the switch is off — deliberately not the
 * defaults, so a caller cannot forget the switch and run on defaults.
 */
export async function automationConfig<T extends Record<string, unknown>>(key: AutomationKey, defaults: T): Promise<T | null> {
  const s = await getAutomation(key);
  if (!s.enabled) return null;
  return { ...defaults, ...(s.config ?? {}) } as T;
}

/** Every switch, for the monitoring screen. Missing rows are listed as disabled. */
export async function allAutomations(): Promise<AutomationState[]> {
  return Promise.all(AUTOMATION_KEYS.map((k) => getAutomation(k)));
}

/**
 * Stamp the outcome of a run. Updates an EXISTING row only: a driver that ran
 * against a missing row should not have run at all, and creating the row here
 * would make a disabled automation look configured.
 */
export async function recordAutomationRun(key: AutomationKey, error?: string | null): Promise<void> {
  const now = new Date();
  await prisma.programAutomation
    .updateMany({
      where: { key },
      data: error
        ? { lastRunAt: now, lastError: error.slice(0, 2000), lastErrorAt: now }
        : { lastRunAt: now, lastError: null, lastErrorAt: null },
    })
    .catch(() => {});
}

/**
 * The owner's switch. Creating the row on first enable is the ONLY path that
 * brings an automation into existence, and it records who did it and when.
 * Callers gate this behind requireOwner(); this module does not know about
 * sessions on purpose.
 */
export async function setAutomation(key: AutomationKey, enabled: boolean, by: string | null, configJson?: string | null): Promise<AutomationState> {
  if (configJson != null) JSON.parse(configJson); // refuse to store something no reader could use
  const now = new Date();
  await prisma.programAutomation.upsert({
    where: { key },
    create: {
      key, enabled,
      ...(enabled ? { enabledBy: by, enabledAt: now } : { disabledBy: by, disabledAt: now }),
      ...(configJson != null ? { configJson } : {}),
    },
    update: {
      enabled,
      ...(enabled ? { enabledBy: by, enabledAt: now } : { disabledBy: by, disabledAt: now }),
      ...(configJson != null ? { configJson } : {}),
    },
  });
  return getAutomation(key);
}

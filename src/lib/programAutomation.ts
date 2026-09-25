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
  "topic_refresh", // §18 the unattended topic bank: the initial bank after strategy approval + per-pillar refills (suggestions only; Jordan accepts)
  // CP-07 (Sep 24 2026). Carrying is a pointer move with full history, but it
  // rewrites which month every past unfilmed script belongs to at once — so it
  // is its own switch, dry-run first (carryUnfilmedTopics({ dryRun: true })).
  "topic_carryover", // §3 on the 1st, scripted-but-unfilmed topics carry into the new month's allowance (swappable by the client)
  "strategy_generation", // §21 discovery → strategy draft
  "session_booking", // §4 true self-booking against Aryeo — also needs the client in config.authorizedFixtureClientIds (CP-04)
  // CP-05 (Sep 24 2026). An exact address a client gives for a session is
  // ALWAYS saved and verified by readback; this only decides whether the hub
  // PATCHes the Aryeo address itself (authorised fixtures only) or Kyle does.
  "address_sync", // §8 exact filming address → PATCH the session's Aryeo address, read it back
  "cut_transcripts", // §9 (no speech-to-text provider exists today)
  "caption_assistant", // §10
  "fact_extraction", // §23 auto-accept rules for extracted facts
  // CP-02 (Sep 24 2026). Windows and revision rounds are RECORDED with both
  // off; these only decide what the client is shown and what expiry may do.
  "revision_policy", // §8 portal deadline, rounds used, extra-round fee acknowledgement, late refusal, expiry → staff task
  "review_auto_approve", // §8 an expired review window may write the automatic approval (needs revision_policy too)
  // CP-06 (Sep 24 2026). A client's brand/asset change is ALWAYS recorded, put
  // on the editor's brief banner and on Kyle's confirmation task; this only
  // decides whether the assigned editor is also messaged (Slack DM / text).
  "brand_change_alerts", // §17 brand or asset change → the assigned editor's bell + Slack DM (a team message)
  // CP-09 (Sep 24 2026). The first automated write INSIDE a job's Dropbox
  // folder beyond the five numbered subfolders, so it is its own switch.
  "topic_folders", // §9 one raw folder per topic under 02-RAW-Video, named "NN <title> [<id8>]"; adopted, never renamed, moved or deleted
  // CP-13 (Sep 24 2026). The program conversation, the owner's bell and Kyle's
  // task are internal and always on; this only decides whether a CLIENT is
  // emailed that the office replied (lib/programMessages.ts).
  "program_message_notice", // §13 "Kyle replied to your message" email to the client's seats, once per unread run, client hours only
  // UI-01 (Sep 24 2026). TEST clients and a staff preview (?layout=v2) always
  // get the new layout; this only decides whether REAL clients do
  // (lib/portalLayout.ts). Nothing is sent — it is what their page looks like.
  "portal_layout_v2", // §6 the portal's new navigation: Home · My Plan · Content Library · Schedule · More
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

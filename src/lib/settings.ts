import "server-only";
import { prisma } from "@/lib/prisma";
import type { EditorKey } from "@/lib/editors";

// ---------------------------------------------------------------------------
// Platform settings — the /settings page's storage (owner + admin).
//
// Jordan: "I want the ability to auto assign jobs to editors but also be able
// to change the rules in our settings page." So the routing rules live HERE,
// not in code: editors.ts carries the code DEFAULTS, this module overlays
// whatever the settings page saved. A missing/corrupt row falls back to the
// defaults — the settings page can never brick routing.
//
// 60s in-memory cache per lambda: routing is consulted on every task mint and
// queue render; a settings change propagates within a minute, which is fine
// for rules that change a few times a year.
// ---------------------------------------------------------------------------

export type EditorRoutingRules = {
  // null = "manual": the job lands in Needs assigning instead of auto-routing.
  standardVideo: EditorKey | null;
  premiumVideo: EditorKey | null;
  personalBranding: EditorKey | null;
};

// Code defaults = Jordan's Aug 14 2026 decision. The settings page edits the
// stored overlay; these apply until then (and whenever a row is missing).
export const DEFAULT_ROUTING: EditorRoutingRules = {
  standardVideo: "john",
  premiumVideo: "john",
  personalBranding: null, // manual — Jordan assigns each batch by hand
};

// Keys a routing rule may point at. Kyle/vendors are reachable through other
// lanes; the video rules only ever route to a video editor or to manual.
export const ROUTABLE_EDITORS: EditorKey[] = ["john", "kim"];

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 60_000;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    const value = row ? { ...fallback, ...(JSON.parse(row.value) as Partial<T>) } : fallback;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return fallback; // a settings read failure must never break the caller
  }
}

export async function putSetting<T>(key: string, value: T, updatedBy?: string | null): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: json, updatedBy: updatedBy ?? null },
    update: { value: json, updatedBy: updatedBy ?? null },
  });
  cache.delete(key);
}

export async function editorRouting(): Promise<EditorRoutingRules> {
  const r = await getSetting<EditorRoutingRules>("editor_routing", DEFAULT_ROUTING);
  // Guard against a stale row pointing at a retired key (luma, remar): fall
  // back to the default for that rule rather than routing work to a ghost.
  const ok = (k: EditorKey | null) => k === null || ROUTABLE_EDITORS.includes(k);
  return {
    standardVideo: ok(r.standardVideo) ? r.standardVideo : DEFAULT_ROUTING.standardVideo,
    premiumVideo: ok(r.premiumVideo) ? r.premiumVideo : DEFAULT_ROUTING.premiumVideo,
    personalBranding: ok(r.personalBranding) ? r.personalBranding : DEFAULT_ROUTING.personalBranding,
  };
}

// ---------------------------------------------------------------------------
// AUTOMATED CLIENT TEXTS (Jordan, Sep 1 2026): "I want an Automated Texts
// Settings in the settings page so I can see exactly what automations there
// are, what time they go out (the rules) and to be able to change the rules,
// and turn off the automations." The sweeps read this on every cron tick, so
// a change takes effect within a minute — and OFF is honoured immediately.
// ---------------------------------------------------------------------------
export type AutoTextRules = {
  /** master switch — false stops every automated CLIENT text */
  enabled: boolean;
  /** earliest ET hour a client text may go out (0-23) */
  sendFromHour: number;
  /** exclusive ET hour after which nothing sends; it waits for the morning */
  sendUntilHour: number;
  confirmation: {
    enabled: boolean;
    /** how far ahead of the shoot to confirm */
    hoursBefore: number;
  };
  delivery: {
    enabled: boolean;
    /** only auto-send while the delivery task is younger than this */
    maxTaskAgeHours: number;
    /** monthly plans: require the batch (plan quota) before announcing delivery */
    requireMonthlyBatch: boolean;
  };
  /** never auto-text a client who has an unanswered question in the queue */
  skipWhenClientWaiting: boolean;
  /** at most one automated text per client per cron tick */
  onePerClientPerRun: boolean;
};

export const DEFAULT_AUTO_TEXTS: AutoTextRules = {
  enabled: true,
  sendFromHour: 9,
  sendUntilHour: 16, // Jordan: "they should never go out past 4PM"
  confirmation: { enabled: true, hoursBefore: 48 },
  delivery: { enabled: true, maxTaskAgeHours: 72, requireMonthlyBatch: true },
  skipWhenClientWaiting: true,
  onePerClientPerRun: true,
};

export async function autoTextRules(): Promise<AutoTextRules> {
  const r = await getSetting<AutoTextRules>("auto_texts", DEFAULT_AUTO_TEXTS);
  // Clamp anything a bad save could put here — the sweeps text real clients.
  const hour = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  const rawFrom = hour(r.sendFromHour, DEFAULT_AUTO_TEXTS.sendFromHour);
  const rawUntil = hour(r.sendUntilHour, DEFAULT_AUTO_TEXTS.sendUntilHour);
  // An inverted/empty window (until <= from) can't be repaired one field at a
  // time — 18:00→16:00 would silently never send. Fall back to BOTH defaults
  // so the behaviour is the documented one rather than an accidental mute.
  const valid = rawUntil > rawFrom;
  const from = valid ? rawFrom : DEFAULT_AUTO_TEXTS.sendFromHour;
  const until = valid ? rawUntil : DEFAULT_AUTO_TEXTS.sendUntilHour;
  return {
    enabled: r.enabled !== false,
    sendFromHour: from,
    sendUntilHour: until,
    confirmation: {
      enabled: r.confirmation?.enabled !== false,
      hoursBefore:
        typeof r.confirmation?.hoursBefore === "number" && r.confirmation.hoursBefore > 0 && r.confirmation.hoursBefore <= 168
          ? r.confirmation.hoursBefore
          : DEFAULT_AUTO_TEXTS.confirmation.hoursBefore,
    },
    delivery: {
      enabled: r.delivery?.enabled !== false,
      maxTaskAgeHours:
        typeof r.delivery?.maxTaskAgeHours === "number" && r.delivery.maxTaskAgeHours > 0 && r.delivery.maxTaskAgeHours <= 720
          ? r.delivery.maxTaskAgeHours
          : DEFAULT_AUTO_TEXTS.delivery.maxTaskAgeHours,
      requireMonthlyBatch: r.delivery?.requireMonthlyBatch !== false,
    },
    skipWhenClientWaiting: r.skipWhenClientWaiting !== false,
    onePerClientPerRun: r.onePerClientPerRun !== false,
  };
}

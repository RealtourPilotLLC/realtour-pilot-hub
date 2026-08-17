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

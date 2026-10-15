import "server-only";

import { getSetting, putSetting } from "@/lib/settings";
import { autohdr, autohdrConfigured, type AutohdrCapability, type AutohdrModel } from "@/lib/integrations/autohdr";

// ---------------------------------------------------------------------------
// AutoHDR's live catalogue (docs/photo-delivery/01 §5.1, §8.1): transform
// names, versions and credit costs (listCapabilities) and the editing models
// (listModels). Prices and model ids are NEVER hardcoded: they are read here
// and kept in AppSetting, so every lambda shares one copy. The cron refreshes
// it hourly (refreshCatalogs), so a price change at AutoHDR reaches the Fix
// Cart within the hour and a page only ever reads the stored copy; a send that
// spends credits reads it fresh (force).
// ---------------------------------------------------------------------------

const CAP_KEY = "photo_delivery:autohdr_capabilities";
const MODEL_KEY = "photo_delivery:autohdr_models";
const TTL_MS = 60 * 60_000;

type Cached<T> = { at: string; items: T[] };

/** The stored copy; AutoHDR is asked only when `force`, or when nothing is stored yet. */
async function cached<T>(key: string, load: () => Promise<T[]>, force = false): Promise<T[] | null> {
  const hit = await getSetting<Cached<T> | null>(key, null);
  if (!force && hit && Array.isArray(hit.items)) return hit.items;
  if (!(await autohdrConfigured())) return hit?.items ?? null;
  try {
    const items = await load();
    await putSetting(key, { at: new Date().toISOString(), items }, "system");
    return items;
  } catch (e) {
    console.warn("autohdr catalogue read failed", key, (e as Error).message);
    return hit?.items ?? null; // a stale price list beats none; callers label estimates
  }
}

export async function capabilityCatalog(force = false): Promise<AutohdrCapability[] | null> {
  return cached<AutohdrCapability>(CAP_KEY, () => autohdr.capabilities(), force);
}

export async function modelCatalog(force = false): Promise<AutohdrModel[] | null> {
  return cached<AutohdrModel>(MODEL_KEY, () => autohdr.models("all"), force);
}

/** Cron: ask AutoHDR again for each catalogue whose stored copy is over an hour old. */
export async function refreshCatalogs(): Promise<{ asked: number }> {
  let asked = 0;
  for (const [key, read] of [[CAP_KEY, capabilityCatalog], [MODEL_KEY, modelCatalog]] as const) {
    const hit = await getSetting<Cached<unknown> | null>(key, null);
    if (hit?.at && Date.now() - Date.parse(hit.at) < TTL_MS) continue;
    await read(true);
    asked++;
  }
  return { asked };
}

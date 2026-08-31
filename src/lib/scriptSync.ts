import "server-only";
import { prisma } from "@/lib/prisma";
import {
  scriptingConfigured,
  scriptingGetByExternalId,
  studioToRecipe,
  ScriptingError,
} from "@/lib/integrations/scripting";

// ---------------------------------------------------------------------------
// AUTOMATIC script sync — Jordan: "Script studio should just get the script
// from the shoot on our script writing platform via api." No card, no button:
// the hub pulls the script for a shoot by its own project id (the Studio's
// external_id) and mirrors hook/script/song into the reel recipe. The signed
// inbound webhook (/api/webhooks/scripting) is the fast path; this pull is the
// safety net that makes the script show up even when a webhook never fires.
//
// PULL-ONLY on purpose: creating a Studio project emails the AGENT their
// intake link — a client-facing send that must stay a deliberate human act
// (in the Script Writing app itself), never a side effect of a page render.
//
// Three callers:
//   · /edit/[id] render      → autoSyncScript(id)  (cheap freshness gate)
//   · hourly cron            → sweepMissingScripts (queue + imminent shoots)
//   · syncScriptFromStudio   (the legacy server action) → pullScriptFromStudio
// ---------------------------------------------------------------------------

// Fetch the Studio project for a hub job and mirror what it has. Throws
// ScriptingError on API failure; "no Studio project" (404) returns got: [].
export async function pullScriptFromStudio(
  projectId: string,
): Promise<{ got: string[]; url?: string; status?: string }> {
  let detail;
  try {
    detail = await scriptingGetByExternalId(projectId);
  } catch (e) {
    // 404 = this shoot has no Studio project (yet) — that's a normal state,
    // not an error. Stamp the attempt so the gate backs off.
    if (e instanceof ScriptingError && e.status === 404) {
      await prisma.project
        .update({ where: { id: projectId }, data: { scriptingSyncedAt: new Date() } })
        .catch(() => {});
      return { got: [] };
    }
    throw e;
  }
  const r = studioToRecipe(detail);
  // A photographer-CONFIRMED script is the record of what was actually filmed
  // (upload debrief, Aug 31) — a later Studio pull must never overwrite it.
  // Status/link/song keep syncing; the words are frozen once confirmed.
  const confirmed = await prisma.project.findUnique({
    where: { id: projectId },
    select: { scriptConfirmedAt: true },
  });
  const frozen = !!confirmed?.scriptConfirmedAt;
  const data: Record<string, unknown> = { scriptingSyncedAt: new Date() };
  if (detail.id) data.scriptingId = String(detail.id);
  if (r.status) data.scriptingStatus = r.status;
  if (r.url) {
    data.scriptingUrl = r.url;
    data.reelScriptUrl = r.url;
  }
  if (r.hook && !frozen) data.reelHook = r.hook;
  if (r.script && !frozen) data.reelScript = r.script;
  if (r.song) data.reelSong = r.song;
  if ((r.hook || r.script) && !frozen) data.reelRecipeUpdatedAt = new Date();
  await prisma.project.update({ where: { id: projectId }, data });
  const got = [r.hook && "hook", r.script && "script", r.song && "song"].filter(Boolean) as string[];
  return { got, url: r.url, status: r.status };
}

// How long a "we asked and there was nothing" answer holds before re-asking.
// Missing script → retry every 10 min (an edit page being watched should pick
// the script up fast once it's written). Script on file → refresh every 6h
// (the webhook already pushes real changes; this only catches missed ones).
const RETRY_EMPTY_MS = 10 * 60_000;
const REFRESH_FULL_MS = 6 * 3600_000;

// Best-effort auto-pull with a freshness gate — one indexed read when there's
// nothing to do, never throws, never blocks a page on a dead Studio for more
// than the client's 6s timeout. Returns true when a pull actually ran.
export async function autoSyncScript(projectId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!scriptingConfigured()) return false;
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        reelScript: true,
        scriptingSyncedAt: true,
        status: true,
        deliverables: { select: { type: true } },
      },
    });
    if (!p || p.status === "CANCELLED") return false;
    if (!p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")) return false;
    if (!opts.force) {
      const age = p.scriptingSyncedAt ? Date.now() - p.scriptingSyncedAt.getTime() : Infinity;
      if (age < (p.reelScript ? REFRESH_FULL_MS : RETRY_EMPTY_MS)) return false;
    }
    await pullScriptFromStudio(projectId);
    return true;
  } catch {
    return false; // the script section renders whatever the DB already has
  }
}

// Cron sweep: scripts appear on queue jobs WITHOUT anyone opening a page —
// the Editor Queue's Script chip fills itself (Jordan's Slack broken-thing:
// "scripts don't get added"). Covers the in-flight queue plus shoots in the
// next 4 days, so the photographer has the script on their shoot screen
// before they're standing in the driveway.
export async function sweepMissingScripts(limit = 12): Promise<{ pulled: number; checked: number }> {
  if (!scriptingConfigured()) return { pulled: 0, checked: 0 };
  const soon = new Date(Date.now() + 4 * 24 * 3600_000);
  const staleBefore = new Date(Date.now() - 55 * 60_000); // ~once per hourly run
  const candidates = await prisma.project.findMany({
    where: {
      reelScript: null,
      OR: [
        { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
        { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: new Date(), lte: soon } },
      ],
      AND: [{ OR: [{ scriptingSyncedAt: null }, { scriptingSyncedAt: { lt: staleBefore } }] }],
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
    },
    // Never-checked first, then least-recently-checked — the cursor ROTATES
    // through the candidate set. Ordering by shootDate let a stuck oldest-12
    // (jobs whose agent never created a Studio project) monopolize every run
    // while new shoots starved.
    orderBy: { scriptingSyncedAt: { sort: "asc", nulls: "first" } },
    take: limit,
    select: { id: true },
  });
  let pulled = 0;
  for (const c of candidates) {
    try {
      const r = await pullScriptFromStudio(c.id);
      if (r.got.length) pulled += 1;
    } catch {
      break; // Studio unreachable — stop the sweep, next hour retries
    }
  }
  return { pulled, checked: candidates.length };
}

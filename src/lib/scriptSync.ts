import "server-only";
import { prisma } from "@/lib/prisma";
import {
  scriptingConfigured,
  scriptingGetDetail,
  scriptingListAll,
  studioSnapshot,
  type StudioProject,
  type StudioSnapshot,
} from "@/lib/integrations/scripting";

// ---------------------------------------------------------------------------
// AUTOMATIC script sync — Jordan: "Script studio should just get the script
// from the shoot on our script writing platform via api." No card, no button:
// the hub pulls each job's script from the platform and keeps it current. The
// signed inbound webhook (/api/webhooks/scripting) is the fast path; the
// 15-minute reconcile below is the safety net (webhooks are best-effort, one
// try, 5 s).
//
// PULL-ONLY on purpose: creating a platform project emails the AGENT their
// intake link — a client-facing send that must stay a deliberate human act
// (in the Script Writing app itself), never a side effect of a page render.
//
// TWO TEXTS PER JOB (Oct 20 2026, Jordan via the scripting platform: "every
// job in the hub always shows its current script, kept current
// automatically"):
//   · scriptingScript (+ scriptingVersion …) — the platform's CURRENT crew
//     script: the creative's change on the shoot link when there is one, else
//     the released script. Always mirrored.
//   · reelScript — the WORKING script the editor cuts to and every brief,
//     packet and PDF reads. It follows the platform, except:
//       - once the photographer confirmed what was filmed (upload debrief:
//         "as written", "edited on site", or typed on site) it is that record
//         and never overwritten (Aug 31); the card shows the platform's
//         current script beside it when the two differ;
//       - an office correction made in the hub ("Edited in the hub by …")
//         stands until the platform writes a version NEWER than it.
// A draft waiting on Jordan's review is never text in the hub: the platform
// does not return it, and the card shows it as a status (scriptingStatus /
// scriptingDraftVersion).
//
// Matching (Oct 20 2026): most platform projects come from Aryeo bookings and
// carry only aryeo_order_id, which the hub never looked up, so those jobs
// never synced (John Collins's 335 Ridley Creek among them). A job is now
// found by its Aryeo order, then the hub's own id (external_id), then a stored
// scripting id.
//
// Callers:
//   · webhook (lib/webhooks/scripting)  → applyStudioSnapshot after a GET
//   · cron/aryeo every 15 min           → reconcileScripting
//   · /edit/[id] render                 → autoSyncScript (cheap freshness gate)
//   · hourly cron "scripts"             → sweepMissingScripts (jobs with none yet)
// ---------------------------------------------------------------------------

const HUB_EDIT = /^Edited in the hub by [^\n]*\n?/;

/**
 * Is a photographer's typed-on-site text a script at all? (Oct 20 2026.) The
 * upload debrief asks for the script when the hub had none, and with the
 * Aryeo bookings never matched, photographers typed what they could: "N/A",
 * "Script", "See dropbox folder for script", "Waiting for Alex to send her
 * revised version". Those are notes, not a filmed record; the platform's
 * script replaces them. Anything that reads like words spoken on camera stays.
 */
export function looksLikeScript(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  const words = t ? t.split(/\s+/).length : 0;
  if (words < 12) return false;
  // The note phrases only mark a SHORT text: a real script can say "everything
  // you've been waiting for" (2236 Gregory Dr).
  if (words < 40 && /dropbox|stand ?by|waiting (for|on)|will be (uploaded|sent|added)|example video|see (the )?(attached|folder|file)/i.test(t)) return false;
  return true;
}

type ProjectRef = { id: string; aryeoOrderId: string | null; scriptingId: string | null };

/** Mirror one platform snapshot onto a hub job. Returns what changed in words. */
export async function applyStudioSnapshot(projectId: string, snap: StudioSnapshot, opts: { draftVersion?: number | null; client?: { version: number | null; sentAt: Date } | null } = {}): Promise<{ workingChanged: boolean; currentChanged: boolean }> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { reelScript: true, reelHook: true, scriptConfirmedAt: true, scriptConfirmNote: true, reelRecipeUpdatedAt: true, scriptingScript: true, scriptingDraftVersion: true, scriptingClientVersion: true },
  });
  if (!p) return { workingChanged: false, currentChanged: false };
  const now = new Date();
  const data: Record<string, unknown> = { scriptingSyncedAt: now };
  if (snap.studioId) data.scriptingId = snap.studioId;
  if (snap.status) data.scriptingStatus = snap.status;
  if (snap.updatedAt) data.scriptingUpdatedAt = snap.updatedAt;
  if (snap.url) { data.scriptingUrl = snap.url; data.reelScriptUrl = snap.url; }
  if (snap.song) data.reelSong = snap.song;

  const crew = snap.crew;
  const currentChanged = !!crew && (p.scriptingScript ?? "").trim() !== crew.text.trim();
  if (crew) {
    data.scriptingScript = crew.text.slice(0, 40_000);
    data.scriptingVersion = crew.version;
    data.scriptingVersionAt = crew.at;
    data.scriptingOnSiteBy = crew.onSiteBy;
  }
  // The version the agent received, when known (the detail's delivered_at, or
  // the sent_to_client event itself).
  const client = opts.client ?? snap.client;
  if (client) { data.scriptingClientVersion = client.version; data.scriptingClientSentAt = client.sentAt; }
  // A draft waiting on review: recorded from script_generated, cleared once a
  // version at least as new is released or sent.
  if (opts.draftVersion != null) data.scriptingDraftVersion = opts.draftVersion;
  const draft = opts.draftVersion ?? p.scriptingDraftVersion;
  if (draft != null && ((crew?.version ?? 0) >= draft || (client?.version ?? p.scriptingClientVersion ?? 0) >= draft)) data.scriptingDraftVersion = null;

  // The working script. A typed-on-site "record" that is only a note (see
  // looksLikeScript) does not hold the script back.
  let workingChanged = false;
  const noteOnly = !!p.scriptConfirmedAt && (p.scriptConfirmNote ?? "").startsWith("Provided on site") && !looksLikeScript(p.reelScript);
  if (crew && (!p.scriptConfirmedAt || noteOnly)) {
    const hubEditAt = HUB_EDIT.test(p.scriptConfirmNote ?? "") ? p.reelRecipeUpdatedAt : null;
    const platformNewer = !hubEditAt || !crew.at || crew.at > hubEditAt;
    if (platformNewer && (p.reelScript ?? "").trim() !== crew.text.trim()) {
      data.reelScript = crew.text.slice(0, 20_000);
      data.reelRecipeUpdatedAt = now;
      if (hubEditAt) data.scriptConfirmNote = (p.scriptConfirmNote ?? "").replace(HUB_EDIT, "").trim() || null;
      if (noteOnly) data.scriptConfirmNote = `Script from Script Writing. The photographer's on-site note was: "${(p.reelScript ?? "").trim().slice(0, 200)}"`;
      workingChanged = true;
    }
    if (platformNewer && snap.hook && snap.hook !== p.reelHook) data.reelHook = snap.hook;
  } else if (!crew && snap.hook && !p.reelHook && !p.scriptConfirmedAt) {
    // Hooks proposed before any script: the chosen hook is still worth showing.
    data.reelHook = snap.hook;
  }
  await prisma.project.update({ where: { id: projectId }, data });
  return { workingChanged, currentChanged };
}

/** Fetch a job's platform project and mirror it. got = what the platform had. */
export async function pullScriptFromStudio(projectId: string): Promise<{ got: string[]; url?: string; status?: string }> {
  const ref = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, aryeoOrderId: true, scriptingId: true } });
  if (!ref) return { got: [] };
  const detail = await scriptingGetDetail({ aryeoOrderId: ref.aryeoOrderId, hubId: ref.id, scriptingId: ref.scriptingId });
  if (!detail) {
    // No platform project (yet) — a normal state. Stamp the attempt so the gates back off.
    await prisma.project.update({ where: { id: projectId }, data: { scriptingSyncedAt: new Date() } }).catch(() => {});
    return { got: [] };
  }
  const snap = studioSnapshot(detail);
  await applyStudioSnapshot(projectId, snap);
  const got = [snap.hook && "hook", snap.crew && "script", snap.song && "song"].filter(Boolean) as string[];
  return { got, url: snap.url ?? undefined, status: snap.status ?? undefined };
}

// How long a "we asked and there was nothing" answer holds before re-asking
// on an /edit render. Missing script → every 10 min; script on file → every
// hour (webhooks + the 15-minute reconcile carry real changes).
const RETRY_EMPTY_MS = 10 * 60_000;
const REFRESH_FULL_MS = 60 * 60_000;

// Best-effort auto-pull with a freshness gate — one indexed read when there's
// nothing to do, never throws, never blocks a page on a dead platform for more
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
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true } },
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

// Hourly: scripts appear on queue jobs WITHOUT anyone opening a page — the
// Editor Queue's Script chip fills itself. Jobs with no script yet: the
// in-flight queue plus shoots in the next 4 days.
export async function sweepMissingScripts(limit = 12): Promise<{ pulled: number; checked: number }> {
  if (!scriptingConfigured()) return { pulled: 0, checked: 0 };
  const soon = new Date(Date.now() + 4 * 24 * 3600_000);
  const staleBefore = new Date(Date.now() - 55 * 60_000);
  const candidates = await prisma.project.findMany({
    where: {
      reelScript: null,
      OR: [
        { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
        { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: new Date(), lte: soon } },
      ],
      AND: [{ OR: [{ scriptingSyncedAt: null }, { scriptingSyncedAt: { lt: staleBefore } }] }],
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null } },
    },
    // Never-checked first, then least-recently-checked — the cursor ROTATES.
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
      break; // platform unreachable — stop, next hour retries
    }
  }
  return { pulled, checked: candidates.length };
}

/** The hub job a platform project belongs to: Aryeo order, then the hub's id, then a stored scripting id. */
export async function hubJobFor(data: Pick<StudioProject, "id" | "external_id" | "aryeo_order_id">): Promise<ProjectRef | null> {
  const sel = { id: true, aryeoOrderId: true, scriptingId: true } as const;
  if (data.aryeo_order_id) {
    const p = await prisma.project.findUnique({ where: { aryeoOrderId: String(data.aryeo_order_id) }, select: sel });
    if (p) return p;
  }
  if (data.external_id) {
    const p = await prisma.project.findUnique({ where: { id: String(data.external_id) }, select: sel });
    if (p) return p;
  }
  if (data.id) {
    const p = await prisma.project.findFirst({ where: { scriptingId: String(data.id) }, select: sel });
    if (p) return p;
  }
  return null;
}

// Projects whose shoot is close enough that an on-site change could be
// happening: read every run whatever updated_at says.
const SHOOT_WINDOW_MS = 3 * 24 * 3600_000;
const WINDOW_REREAD_MS = 10 * 60_000;
// Every matched project at least once a day. The platform's updated_at does
// NOT move when a new script version is saved (an on-site edit, a Revise, a
// client-requested revision: confirmed by the scripting session, Oct 20 2026;
// their fix a3757ab waits on Jordan's deploy OK), so an on-site edit to a job
// outside the shoot window would otherwise wait for a webhook that may have
// failed. ~83 reads a day, spread by the per-run cap. Once updated_since is
// live, the reconcile switches to it (they will say).
const DAILY_REREAD_MS = 24 * 3600_000;

/**
 * EVERY 15 MINUTES (cron/aryeo). One list call (every platform project, with
 * its updated_at), then a detail read for each project matched to a hub job
 * that changed since our last read, was never read, shoots within three days,
 * or was last read a day ago (a new script version does not move updated_at
 * yet). `all` reads every matched project (the backfill).
 */
export async function reconcileScripting(opts: { max?: number; budgetMs?: number; all?: boolean; now?: Date } = {}): Promise<{ listed: number; matched: number; read: number; workingChanged: number; currentChanged: number; errors: number; skipped?: string }> {
  const out = { listed: 0, matched: 0, read: 0, workingChanged: 0, currentChanged: 0, errors: 0 };
  if (!scriptingConfigured()) return { ...out, skipped: "not configured" };
  const started = Date.now();
  const now = opts.now ?? new Date();
  const max = opts.max ?? 30;
  const budget = opts.budgetMs ?? 60_000;
  const list = await scriptingListAll(200);
  out.listed = list.length;
  const aryeoIds = list.map((x) => x.aryeo_order_id).filter((x): x is string => !!x);
  const extIds = list.map((x) => x.external_id).filter((x): x is string => !!x);
  const sIds = list.map((x) => x.id).filter(Boolean);
  const hub = await prisma.project.findMany({
    where: { OR: [{ aryeoOrderId: { in: aryeoIds } }, { id: { in: extIds } }, { scriptingId: { in: sIds } }] },
    select: { id: true, aryeoOrderId: true, scriptingId: true, scriptingUpdatedAt: true, scriptingSyncedAt: true },
  });
  const due: { studio: StudioProject; job: (typeof hub)[number]; rank: number }[] = [];
  for (const s of list) {
    const job = hub.find((h) => (s.aryeo_order_id && h.aryeoOrderId === s.aryeo_order_id)) ?? hub.find((h) => s.external_id && h.id === s.external_id) ?? hub.find((h) => h.scriptingId === s.id);
    if (!job) continue;
    out.matched++;
    const updated = s.updated_at ? new Date(s.updated_at).getTime() : null;
    const changed = !job.scriptingUpdatedAt || updated == null || job.scriptingUpdatedAt.getTime() !== updated;
    const appt = s.appointment_date ? new Date(s.appointment_date).getTime() : null;
    const inWindow = appt != null && Math.abs(appt - now.getTime()) <= SHOOT_WINDOW_MS && (!job.scriptingSyncedAt || now.getTime() - job.scriptingSyncedAt.getTime() >= WINDOW_REREAD_MS);
    const daily = !job.scriptingSyncedAt || now.getTime() - job.scriptingSyncedAt.getTime() >= DAILY_REREAD_MS;
    if (opts.all || changed || inWindow || daily) due.push({ studio: s, job, rank: changed ? 0 : inWindow ? 1 : 2 });
  }
  due.sort((a, b) => a.rank - b.rank || (b.studio.updated_at ?? "").localeCompare(a.studio.updated_at ?? ""));
  for (const d of due.slice(0, max)) {
    if (Date.now() - started > budget) break;
    try {
      const detail = await scriptingGetDetail({ aryeoOrderId: d.studio.aryeo_order_id ?? null, hubId: d.studio.external_id ?? null, scriptingId: d.studio.id });
      if (!detail) continue;
      out.read++;
      const r = await applyStudioSnapshot(d.job.id, studioSnapshot(detail));
      if (r.workingChanged) out.workingChanged++;
      if (r.currentChanged) out.currentChanged++;
    } catch {
      out.errors++;
      if (out.errors >= 3) break; // the platform is struggling; the next run retries
    }
  }
  return out;
}

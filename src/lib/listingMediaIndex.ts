import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  BACKFILL_KEY, backfillLine, diffIndex, freshBackfill, listingIndexOf, nextBackoffMs, parseBackfill,
  type BackfillState, type HeldRow,
} from "@/lib/listingMediaCore";

// ---------------------------------------------------------------------------
// THE ARYEO LISTING MEDIA INDEX: ITS WRITES (Oct 24 2026). The rules are in
// lib/listingMediaCore; this file is the only writer of ListingMediaItem.
//
//   indexListingRead   one listing read the hub ALREADY made → that job's
//                      rows. Called by the hourly status pass (every active
//                      job, and delivered jobs for seven days), by Ready to
//                      send's re-reads (every 15 minutes) and by Aryeo's
//                      delivery webhook, so a new delivery is indexed on its
//                      own and a video taken off a listing is marked removed.
//                      It never calls Aryeo itself and never decides anything
//                      for the read's owner: a failure here is swallowed by
//                      the quiet wrapper and the status pass carries on.
//   the backfill       ONE read of each delivered job's listing (~1,550),
//                      once, by the 15-minute Aryeo job, a small batch a tick,
//                      a cursor in AppSetting `listing_media_backfill`.
//                      Nothing reads until someone starts it
//                      (scripts/_live/oct24-listing-media-backfill.ts
//                      --start); a refusal for load (429) waits a minute,
//                      doubling to thirty; it writes only the index (and its
//                      own progress row).
// ---------------------------------------------------------------------------

const HELD_SELECT = {
  id: true, aryeoMediaId: true, kind: true, title: true, durationSec: true, orientation: true, thumbnailUrl: true,
  downloadUrl: true, playbackUrl: true, photoCount: true, position: true, deliveredAt: true, removedAt: true,
} satisfies Prisma.ListingMediaItemSelect;

/** "The table is not there yet" (the code went out before the schema push). */
export function indexTableMissing(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "P2021" || /ListingMediaItem.*does not exist|relation .*ListingMediaItem.* does not exist/i.test(e instanceof Error ? e.message : String(e));
}

export type IndexWrite = { created: number; updated: number; removed: number; videos: number; cover: boolean };

/** How old a row's "last seen" stamp may get before an unchanged read rewrites it. */
const SEEN_RESTAMP_MS = 6 * 3_600_000;

/** One listing read → that job's index rows. Writes only what changed. */
export async function indexListingRead(projectId: string, listingId: string, listing: unknown, now: Date = new Date()): Promise<IndexWrite | { skipped: string }> {
  const l = listing && typeof listing === "object" ? (listing as Record<string, unknown>) : null;
  if (!l) return { skipped: "no listing read" };
  if (typeof l.id === "string" && l.id && l.id !== listingId) return { skipped: "the read is of another listing" };
  const read = listingIndexOf(l, now);
  if (read.videos === null && read.cover === undefined) return { skipped: "the read carried no media" };

  const held = (await prisma.listingMediaItem.findMany({ where: { projectId }, select: HELD_SELECT })) as HeldRow[];
  const d = diffIndex(held, read);
  for (const r of d.create) {
    const data = { ...r, aryeoListingId: listingId, syncedAt: now, removedAt: null };
    await prisma.listingMediaItem
      .upsert({ where: { projectId_aryeoMediaId: { projectId, aryeoMediaId: r.aryeoMediaId } }, create: { projectId, ...data }, update: data })
      .catch((e) => { if ((e as { code?: string }).code !== "P2002") throw e; }); // a racing writer made it: the next read settles it
  }
  for (const u of d.update) await prisma.listingMediaItem.update({ where: { id: u.id }, data: u.data });
  if (d.remove.length) await prisma.listingMediaItem.updateMany({ where: { id: { in: d.remove }, removedAt: null }, data: { removedAt: now } });
  // "Still there" is stamped at most every few hours per row (audit Oct 25
  // 2026): the hourly status pass and Ready to send's re-reads see the same
  // listings all day, and rewrote every unchanged row each time. A row that
  // moved to another listing is always stamped.
  if (d.seen.length) {
    await prisma.listingMediaItem.updateMany({
      where: { id: { in: d.seen }, OR: [{ syncedAt: { lt: new Date(now.getTime() - SEEN_RESTAMP_MS) } }, { aryeoListingId: { not: listingId } }] },
      data: { syncedAt: now, aryeoListingId: listingId },
    });
  }
  return { created: d.create.length, updated: d.update.length, removed: d.remove.length, videos: read.videos?.length ?? 0, cover: !!read.cover };
}

/** For the readers that already hold a listing: index it, and never let that fail them. */
export async function indexListingReadQuietly(projectId: string, listingId: string | null | undefined, listing: unknown): Promise<void> {
  if (!listingId || !listing) return;
  try {
    await indexListingRead(projectId, listingId, listing);
  } catch (e) {
    if (!indexTableMissing(e)) console.warn("[listing media index] write failed", projectId, e instanceof Error ? e.message.slice(0, 160) : e);
  }
}

// ---------------------------------------------------------------------------
// READS FOR THE LIBRARY
// ---------------------------------------------------------------------------

/** Each job's indexed cover (and gallery count). Empty when the table is not there yet. */
export async function indexedCovers(projectIds?: string[]): Promise<Map<string, { url: string; photoCount: number | null }>> {
  const rows = await prisma.listingMediaItem
    .findMany({
      where: { kind: "PHOTO_COVER", removedAt: null, thumbnailUrl: { not: null }, ...(projectIds ? { projectId: { in: projectIds } } : {}) },
      select: { projectId: true, thumbnailUrl: true, photoCount: true, syncedAt: true },
      orderBy: { syncedAt: "desc" },
    })
    .catch((e) => { if (!indexTableMissing(e)) throw e; return []; });
  const out = new Map<string, { url: string; photoCount: number | null }>();
  for (const r of rows) if (r.thumbnailUrl && !out.has(r.projectId)) out.set(r.projectId, { url: r.thumbnailUrl, photoCount: r.photoCount });
  return out;
}

// ---------------------------------------------------------------------------
// THE ONE-TIME BACKFILL
// ---------------------------------------------------------------------------

/** The jobs it reads: delivered, with an Aryeo listing (the same set the Photos tab and /listings show). */
export const BACKFILL_WHERE = {
  aryeoListingId: { not: null },
  OR: [{ status: "DELIVERED" }, { status: "REVISION", deliveredAt: { not: null } }],
} satisfies Prisma.ProjectWhereInput;

export async function listingMediaBackfillState(): Promise<BackfillState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: BACKFILL_KEY }, select: { value: true } }).catch(() => null);
  return parseBackfill(row?.value);
}

/** The progress line /media shows while the backfill is under way (null otherwise). */
export async function listingMediaBackfillLine(): Promise<string | null> {
  const s = await listingMediaBackfillState();
  return s && s.state !== "done" ? backfillLine(s) : null;
}

/** Start (or resume) the backfill. `restart` walks every listing again from the first. */
export async function startListingMediaBackfill(by: string | null, opts: { restart?: boolean; now?: Date } = {}): Promise<BackfillState> {
  const now = opts.now ?? new Date();
  const cur = await listingMediaBackfillState();
  // The lease is dropped too: a tick still reading stops at its next save (the
  // row it wrote is no longer there), so it can never read beside the next one.
  const next: BackfillState = !cur || opts.restart ? freshBackfill(now, by) : { ...cur, state: cur.state === "done" ? "done" : "running", backoffUntil: null, lastError: null, leaseUntil: null };
  next.total = await prisma.project.count({ where: BACKFILL_WHERE });
  await prisma.appSetting.upsert({
    where: { key: BACKFILL_KEY },
    create: { key: BACKFILL_KEY, value: JSON.stringify(next), updatedBy: by ?? "listing-media-backfill" },
    update: { value: JSON.stringify(next), updatedBy: by ?? "listing-media-backfill" },
  });
  return next;
}

export async function pauseListingMediaBackfill(by: string | null): Promise<BackfillState | null> {
  const cur = await listingMediaBackfillState();
  if (!cur || cur.state !== "running") return cur;
  const next = { ...cur, state: "paused" as const, leaseUntil: null };
  await prisma.appSetting.update({ where: { key: BACKFILL_KEY }, data: { value: JSON.stringify(next), updatedBy: by ?? "listing-media-backfill" } });
  return next;
}

export type BackfillTick = {
  /** Why nothing was read, when nothing was. */
  idle?: string;
  read: number;
  done: number;
  total: number;
  videos: number;
  covers: number;
  skipped: number;
  finished: boolean;
  waitingUntil?: string | null;
  error?: string | null;
  line?: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One tick of the backfill: at most `max` listings, one at a time, `gapMs`
 * apart, inside `budgetMs`. Resumable from any point: the cursor (the last
 * job read) is saved after every listing, and a listing read twice simply
 * re-writes the same rows. `read` is the listing reader (the drills fake it
 * at the network fence instead; the cron passes nothing).
 */
export async function listingMediaBackfillTick(opts: {
  max?: number; budgetMs?: number; gapMs?: number; now?: () => Date; by?: string;
  read?: (listingId: string) => Promise<unknown>;
} = {}): Promise<BackfillTick> {
  const now = opts.now ?? (() => new Date());
  const max = Math.max(1, Math.min(200, opts.max ?? 36));
  const budgetMs = Math.max(5_000, opts.budgetMs ?? 50_000);
  const gapMs = Math.max(0, opts.gapMs ?? 400);
  const started = Date.now();
  const empty = (idle: string, s?: BackfillState | null): BackfillTick => ({
    idle, read: 0, done: s?.done ?? 0, total: s?.total ?? 0, videos: s?.videos ?? 0, covers: s?.covers ?? 0, skipped: s?.skipped.length ?? 0,
    finished: s?.state === "done", waitingUntil: s?.backoffUntil ?? null, line: backfillLine(s ?? null),
  });

  const row = await prisma.appSetting.findUnique({ where: { key: BACKFILL_KEY }, select: { value: true } });
  if (!row) return empty("not started");
  const s0 = parseBackfill(row.value);
  if (!s0) return empty("its progress row could not be read");
  if (s0.state !== "running") return empty(s0.state, s0);
  const t0 = now();
  if (s0.backoffUntil && Date.parse(s0.backoffUntil) > t0.getTime()) return empty("waiting after Aryeo asked us to slow down", s0);
  if (s0.leaseUntil && Date.parse(s0.leaseUntil) > t0.getTime()) return empty("another tick is reading", s0);
  try {
    await prisma.listingMediaItem.findFirst({ select: { id: true } });
  } catch (e) {
    if (indexTableMissing(e)) return empty("the index table is not created yet (db:push)", s0);
    throw e;
  }

  // Claim the tick: compare-and-set on the row as read, so two ticks never read at once.
  let s: BackfillState = { ...s0, leaseUntil: new Date(t0.getTime() + budgetMs + 60_000).toISOString(), lastTickAt: t0.toISOString() };
  let raw = JSON.stringify(s);
  const claimed = await prisma.appSetting.updateMany({ where: { key: BACKFILL_KEY, value: row.value }, data: { value: raw, updatedBy: opts.by ?? "listing-media-backfill" } });
  if (claimed.count !== 1) return empty("another tick is reading", s0);

  /** Save progress; a pause (or a restart) written meanwhile wins and ends the tick. */
  let stop = false;
  const save = async (release = false) => {
    const cur = await prisma.appSetting.findUnique({ where: { key: BACKFILL_KEY }, select: { value: true } });
    if (!cur || cur.value !== raw) {
      // Someone else wrote it (paused, restarted, or deleted it): theirs stands.
      stop = true;
      return;
    }
    if (release) s = { ...s, leaseUntil: null };
    const next = JSON.stringify(s);
    const w = await prisma.appSetting.updateMany({ where: { key: BACKFILL_KEY, value: raw }, data: { value: next, updatedBy: opts.by ?? "listing-media-backfill" } });
    if (w.count !== 1) { stop = true; return; }
    raw = next;
  };

  s.total = await prisma.project.count({ where: BACKFILL_WHERE });
  let read = 0;
  const { AryeoError, Aryeo } = await import("@/lib/integrations/aryeo");
  const reader = opts.read ?? ((id: string) => Aryeo.listing(id, { timeoutMs: 15_000, attempts: 2, backoffMs: 2_000 }));

  outer: while (!stop && read < max) {
    const batch = await prisma.project.findMany({
      where: { ...BACKFILL_WHERE, ...(s.cursor ? { id: { gt: s.cursor } } : {}) },
      select: { id: true, aryeoListingId: true },
      orderBy: { id: "asc" },
      take: Math.min(max - read, 50),
    });
    if (!batch.length) {
      s = { ...s, state: "done", finishedAt: now().toISOString(), failStreak: null };
      break;
    }
    for (const p of batch) {
      if (read >= max || stop) break outer;
      // Never start a read that could run past the budget (a slow read is up to ~32 s).
      if (Date.now() - started > budgetMs - Math.min(20_000, budgetMs / 3) && read > 0) break outer;
      if (read > 0 && gapMs) await sleep(gapMs);
      read++;
      try {
        const l = await reader(p.aryeoListingId!);
        const w = await indexListingRead(p.id, p.aryeoListingId!, l, now());
        s.done++;
        if ("videos" in w) { s.videos += w.videos; if (w.cover) s.covers++; }
        s = { ...s, cursor: p.id, failStreak: null, backoffMs: 0, backoffUntil: null, lastError: null };
      } catch (e) {
        const status = e instanceof AryeoError ? e.status : undefined;
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
        if (status === 429) {
          const wait = nextBackoffMs(s.backoffMs);
          s = { ...s, backoffMs: wait, backoffUntil: new Date(now().getTime() + wait).toISOString(), lastError: `Aryeo asked us to slow down (429); next read after ${Math.round(wait / 60_000)} min` };
          await save();
          break outer;
        }
        if (status === 401 || status === 403) {
          s = { ...s, backoffMs: 15 * 60_000, backoffUntil: new Date(now().getTime() + 15 * 60_000).toISOString(), lastError: `Aryeo refused the key (${status})` };
          await save();
          break outer;
        }
        if (status === 404) {
          s.done++;
          s = { ...s, cursor: p.id, failStreak: null, skipped: [...s.skipped, { id: p.id, why: "Aryeo has no such listing (404)" }].slice(-50) };
          await save();
          continue;
        }
        if (indexTableMissing(e)) { s = { ...s, lastError: "the index table is not created yet (db:push)" }; await save(); break outer; }
        // A timeout, a 5xx, a blip: try this job again next tick; after three in a row, skip it.
        const n = s.failStreak?.id === p.id ? s.failStreak.n + 1 : 1;
        if (n >= 3) {
          s.done++;
          s = { ...s, cursor: p.id, failStreak: null, lastError: msg, skipped: [...s.skipped, { id: p.id, why: `failed three times: ${msg}` }].slice(-50) };
          await save();
          continue;
        }
        s = { ...s, failStreak: { id: p.id, n }, lastError: msg };
        await save();
        break outer;
      }
      await save();
    }
  }
  if (!stop) await save(true);
  return {
    read, done: s.done, total: s.total, videos: s.videos, covers: s.covers, skipped: s.skipped.length, finished: s.state === "done",
    waitingUntil: s.backoffUntil, error: s.lastError, line: backfillLine(s), ...(stop && read === 0 ? { idle: "paused meanwhile" } : {}),
  };
}

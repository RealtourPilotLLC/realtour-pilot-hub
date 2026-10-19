import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etMinutesOfDay } from "@/lib/datetime";
import { noDashes } from "@/lib/text";

// ---------------------------------------------------------------------------
// "WE'RE BEHIND" (Oct 19 2026). Jordan: "if we start getting behind the team
// needs to know (me, Kyle, James and editors) so that we can get an action
// plan in place." Home reads behindState() (H's red line); the alert itself
// posts in #video-editing on Slack and rings the bells (runBehindAlert, a
// step of the five-minute comms cron).
//
// THE RULE, per kind of work (listing videos, photo jobs), the worse wins:
//   ok           nothing past its promise
//   behind       1 or 2 past their promise
//   very_behind  3 or more past their promise, OR any one 48 hours past it
// Listing videos and their promise come from the Video delivery screen
// (lib/videoDelivery, read only); photo jobs from the photo delivery queue's
// own promise (PhotoJob.slaDueAt, not delivered, the job not cancelled).
// Test clients are left out of both.
//
// THE ALERT (once, then once a morning, then once when it clears):
//   · when the level first rises (ok → behind, or up to very_behind): ONE
//     post in #video-editing listing what is late (street, how late, who has
//     it now: which editor, waiting on review, or ready to send) and "Reply
//     here with your plan for each one.", and a bell for the owner, the
//     office (Kyle, James) and the editors. Claimed once per ET day per level
//     (AppSetting), so a twin tick or a flap never posts twice;
//   · while it stays behind, once each morning between 8 and 10 AM ET
//     (claimed once per ET day; skipped when the first post already went out
//     after 5 AM that day), the same list;
//   · when it clears, one "Back on track" post (only when a post went out for
//     this stretch; the stored state is swapped with a compare-and-set, so one
//     tick posts it).
// A read that fails changes nothing (never a false "Back on track").
// A post to a channel is not a page, so it goes at any hour (notify.ts: the
// only quiet time is Jordan's Saturday until 7:30 PM ET, and it is for DMs).
// The channel: SLACK_VIDEO_EDITING_CHANNEL (an id or "#name") when set, else
// the channel named video-editing that the hub's Slack bot can see. When the
// bot cannot post there (not invited, Slack down), the same text goes to the
// ops alert line (notify.opsAlert, which keeps its own DM quiet-time rules).
// ---------------------------------------------------------------------------

export type BehindState = {
  level: "ok" | "behind" | "very_behind";
  videosLate: number;
  photosLate: number;
  /** Hours the most-late item is past its promise; null when nothing is late. */
  oldestLateHours: number | null;
  /** One plain sentence for a red line on Home ("5 videos late, the oldest 3 days."). */
  headline: string | null;
};

export type BehindLevel = BehindState["level"];
export type BehindItem = { kind: "video" | "photo"; projectId: string; street: string; lateHours: number; who: string; href: string };

const HOUR = 3_600_000;
/** Three or more late, or one this many hours late: very behind. */
export const VERY_BEHIND_COUNT = 3;
export const VERY_BEHIND_HOURS = 48;
const RANK: Record<BehindLevel, number> = { ok: 0, behind: 1, very_behind: 2 };

/** The level for one kind of work (pure). */
export function levelFor(lateCount: number, oldestLateHours: number | null): BehindLevel {
  if (lateCount <= 0) return "ok";
  if (lateCount >= VERY_BEHIND_COUNT || (oldestLateHours ?? 0) >= VERY_BEHIND_HOURS) return "very_behind";
  return "behind";
}

/** "5 h" under two days, else "3 days". */
export function lateWords(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The state from the late items (pure): the worse of the two kinds wins. */
export function stateOf(items: BehindItem[]): BehindState {
  const videos = items.filter((i) => i.kind === "video");
  const photos = items.filter((i) => i.kind === "photo");
  const oldest = (xs: BehindItem[]) => (xs.length ? Math.max(...xs.map((x) => x.lateHours)) : null);
  const v = levelFor(videos.length, oldest(videos));
  const p = levelFor(photos.length, oldest(photos));
  const level: BehindLevel = RANK[v] >= RANK[p] ? v : p;
  const oldestLateHours = oldest(items);
  const parts = [videos.length ? plural(videos.length, "video", "videos") : null, photos.length ? plural(photos.length, "photo job", "photo jobs") : null].filter(Boolean);
  const total = items.length;
  const headline = !total
    ? null
    : total === 1
      ? `${parts[0]} is late by ${lateWords(oldestLateHours ?? 0)}.`
      : `${parts.join(" and ")} are late, the oldest by ${lateWords(oldestLateHours ?? 0)}.`;
  return { level, videosLate: videos.length, photosLate: photos.length, oldestLateHours: oldestLateHours == null ? null : Math.round(oldestLateHours), headline };
}

// ---- reading what is late ------------------------------------------------------------------

const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "A job";
const first = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || null;

const PHOTO_STAGE_WHO: Record<string, string> = {
  EDITING: "Being edited (AutoHDR)",
  EDIT_FAILED: "The edit failed, needs a person",
  EDITED: "Edited, being checked",
  QC_RUNNING: "Being checked",
  QC_REVIEW: "Needs a decision from Kyle",
  FIXING: "Fixes running",
  ON_HOLD: "On hold",
  READY: "Ready for Kyle to review and send",
  DELIVERING: "Delivering now",
  DELIVERY_MISMATCH: "The delivery needs a look",
  REVISION_REQUESTED: "The client asked for changes",
};

type Source = (now: Date, opts: { fresh: boolean }) => Promise<BehindItem[]>;
let sourceImpl: Source | null = null;
/** Drills only: what is late, without the delivery screens. */
export function __setBehindSourceForTests(fn: Source | null) {
  sourceImpl = fn;
}

async function lateVideos(now: Date, fresh: boolean): Promise<BehindItem[]> {
  const { videoDeliveryBoard, VIDEO_LANES } = await import("@/lib/videoDelivery");
  const near = Math.abs(now.getTime() - Date.now()) < 60_000;
  const board = await videoDeliveryBoard(near ? (fresh ? { fresh: true } : {}) : { now });
  if (board.unavailable) throw new Error("the video delivery screen could not be read");
  const rows = VIDEO_LANES.filter((l) => l !== "delivered").flatMap((l) => board.lanes[l]).filter((r) => r.late);
  if (!rows.length) return [];
  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } },
    select: { id: true, editorVendorKey: true, editor: { select: { name: true } } },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.projectId);
    const editor = p?.editor?.name ? first(p.editor.name) : p?.editorVendorKey ? "the outside editor" : null;
    const version = r.round ? ` (version ${r.round})` : "";
    let who: string;
    if (r.lane === "sending") who = r.stage === "Approved, ready to send" ? "Approved, ready to send" : `Approved: ${r.stage.toLowerCase()}`;
    else if (r.lane === "held") who = `Approved but held${r.heldWhy ? `: ${r.heldWhy.replace(/\.$/, "").slice(0, 90)}` : ""}`;
    else if (/^In review/i.test(r.stage)) who = `Waiting on review${version}`;
    else if (/^Changes asked/i.test(r.stage)) who = editor ? `With ${editor}, making the changes${version}` : `Changes asked${version}, not with an editor yet`;
    else if (/^Not shot yet/i.test(r.stage)) who = "Not shot yet";
    else who = editor ? `With ${editor} (${r.stage.toLowerCase()})` : `${r.stage}, not with an editor yet`;
    return { kind: "video" as const, projectId: r.projectId, street: r.street, lateHours: r.lateHours ?? 0, who, href: r.reviewHref ?? `/edit/${r.projectId}` };
  });
}

async function latePhotos(now: Date): Promise<BehindItem[]> {
  const jobs = await prisma.photoJob.findMany({
    where: { stage: { not: "DELIVERED" }, slaDueAt: { lt: now } },
    select: { id: true, projectId: true, stage: true, slaDueAt: true },
    take: 200,
  });
  if (!jobs.length) return [];
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const projects = await prisma.project.findMany({
    where: { id: { in: jobs.map((j) => j.projectId) } },
    select: { id: true, title: true, status: true, client: { select: { id: true, name: true } } },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: BehindItem[] = [];
  for (const j of jobs) {
    const p = byId.get(j.projectId);
    // A cancelled shoot is not work (the queue drops it too); a test client is not real.
    if (!p || p.status === "CANCELLED" || isSyntheticClientRow({ id: p.client?.id, name: p.client?.name })) continue;
    out.push({ kind: "photo", projectId: j.projectId, street: streetOf(p.title), lateHours: (now.getTime() - j.slaDueAt!.getTime()) / HOUR, who: PHOTO_STAGE_WHO[j.stage] ?? j.stage, href: `/ops/photo-delivery/${j.id}` });
  }
  return out;
}

/** What is late right now, most late first. Throws when it cannot tell. */
export async function behindReport(now: Date = new Date(), opts: { fresh?: boolean } = {}): Promise<{ state: BehindState; items: BehindItem[] }> {
  const items = sourceImpl ? await sourceImpl(now, { fresh: !!opts.fresh }) : [...(await lateVideos(now, !!opts.fresh)), ...(await latePhotos(now))];
  items.sort((a, b) => b.lateHours - a.lateHours);
  return { state: stateOf(items), items };
}

/** Home's red line (contract). A read that fails says nothing rather than "all fine": level ok, no headline. */
export async function behindState(now: Date = new Date()): Promise<BehindState> {
  try {
    return (await behindReport(now)).state;
  } catch (e) {
    console.warn("[behind] state unavailable", e);
    return { level: "ok", videosLate: 0, photosLate: 0, oldestLateHours: null, headline: null };
  }
}

// ---- the alert -----------------------------------------------------------------------------

const STATE_KEY = "behindAlert.state";
const MAX_LINES = 15;
type Stored = { level: BehindLevel; since: string | null; posted: boolean; lastPostAt: string | null };

/** The Slack message (pure). No em dashes, no money, staff words. */
export function behindMessage(kind: "raise" | "morning", state: BehindState, items: BehindItem[], base: string): string {
  const parts = [state.videosLate ? plural(state.videosLate, "listing video", "listing videos") : null, state.photosLate ? plural(state.photosLate, "photo job", "photo jobs") : null].filter(Boolean).join(" and ");
  const verb = items.length === 1 ? "is" : "are";
  const lead =
    kind === "morning"
      ? `Good morning. We're still behind: ${parts} ${verb} past the promise.`
      : state.level === "very_behind"
        ? `We're very behind: ${parts} ${verb} past the promise.`
        : `We're behind: ${parts} ${verb} past the promise.`;
  const lines = items.slice(0, MAX_LINES).map((i) => `• ${i.street} (${i.kind === "video" ? "video" : "photos"}): ${lateWords(i.lateHours)} late. ${i.who}.`);
  const more = items.length > MAX_LINES ? [`…and ${items.length - MAX_LINES} more.`] : [];
  const links = [state.videosLate ? `<${base}/review|Video Review Room>` : null, state.photosLate ? `<${base}/ops/photo-delivery|Photo delivery>` : null].filter(Boolean).join(" · ");
  return noDashes([lead, ...lines, ...more, "Reply here with your plan for each one.", links].filter(Boolean).join("\n"));
}

export function backOnTrackMessage(): string {
  return "Back on track: nothing is past its promise now. Thanks, team.";
}

type Deps = {
  /** Post one message to the team; resolves where it went. */
  post?: (text: string) => Promise<{ ok: boolean; where: string }>;
};

/** #video-editing's channel id, read from the workspace on Oct 19 2026 (the
 *  hub's bot token has no channels:read scope, so it cannot look it up by name). */
export const VIDEO_EDITING_CHANNEL_ID = "C09SL8A1E1X";

/** Where #video-editing is: the env var, else the known id, else the channel of that name the bot can see. */
export async function videoEditingChannel(): Promise<string | null> {
  const env = (process.env.SLACK_VIDEO_EDITING_CHANNEL ?? "").trim();
  if (env) return env;
  if (VIDEO_EDITING_CHANNEL_ID) return VIDEO_EDITING_CHANNEL_ID;
  try {
    const { slackChannels } = await import("@/lib/integrations/slack");
    const chans = await slackChannels();
    const c = chans.find((x) => /^video-editing$/i.test(x.name)) ?? chans.find((x) => /video-editing/i.test(x.name));
    return c?.id ?? null;
  } catch {
    return null;
  }
}

async function postToTeam(text: string): Promise<{ ok: boolean; where: string }> {
  const channel = await videoEditingChannel();
  if (channel) {
    const { slackNotify } = await import("@/lib/integrations/slack");
    if (await slackNotify(channel, text)) return { ok: true, where: "#video-editing" };
  }
  // The bot is not in #video-editing (or Slack is down): the ops alert line, saying so.
  const { opsAlert } = await import("@/lib/notify");
  const ok = await opsAlert(`(For #video-editing, the hub could not post there.)\n${text}`);
  return { ok, where: ok ? "the ops alert line" : "nowhere" };
}

async function ringBells(state: BehindState, dedupeKey: string): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const href = state.videosLate || !state.photosLate ? "/review" : "/ops/photo-delivery";
    await notifyInApp({
      kind: "behind_alert",
      title: noDashes(state.level === "very_behind" ? "We're very behind" : "We're behind").slice(0, 90),
      body: noDashes(`${state.headline ?? ""} Plan each one in #video-editing.`).trim().slice(0, 140),
      href,
      // Jordan and the office (Kyle, James: ADMIN logins) and the editors. An
      // editor's row loses its body (notify's money clamp); the title says it.
      targets: [{ roles: ["OWNER", "ADMIN"] }, { roles: ["EDITOR"] }],
      dedupeKey,
    });
  } catch (e) {
    console.warn("[behind] bells failed", e);
  }
}

/** Claim a one-time key; false when someone already holds it. */
async function claim(key: string): Promise<boolean> {
  try {
    await prisma.appSetting.create({ data: { key, value: new Date().toISOString(), updatedBy: "behind-alert" } });
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return false;
    throw e;
  }
}

function parseStored(v: string | null | undefined): Stored {
  try {
    const x = v ? (JSON.parse(v) as Partial<Stored>) : null;
    if (x && (x.level === "ok" || x.level === "behind" || x.level === "very_behind")) {
      return { level: x.level, since: x.since ?? null, posted: !!x.posted, lastPostAt: x.lastPostAt ?? null };
    }
  } catch { /* fall through */ }
  return { level: "ok", since: null, posted: false, lastPostAt: null };
}

/** The cron step. Never throws; says what it did. */
export async function runBehindAlert(now: Date = new Date(), deps: Deps = {}): Promise<{ level: BehindLevel | null; posted: "raise" | "morning" | "clear" | null; where?: string; skipped?: string }> {
  let report: { state: BehindState; items: BehindItem[] };
  try {
    report = await behindReport(now, { fresh: true });
  } catch (e) {
    return { level: null, posted: null, skipped: `could not read what is late (${(e as Error)?.message ?? "error"}); nothing changed` };
  }
  try {
    const post = deps.post ?? postToTeam;
    const { appBase } = await import("@/lib/appUrl");
    const { state, items } = report;
    const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY }, select: { value: true } });
    const prev = parseStored(row?.value);
    const day = etDayKey(now);
    const minutes = etMinutesOfDay(now);

    if (state.level !== "ok") {
      let posted: "raise" | "morning" | null = null;
      let where: string | undefined;
      if (RANK[state.level] > RANK[prev.level]) {
        if (await claim(`behindAlert.raise.${day}.${state.level}`)) {
          const r = await post(behindMessage("raise", state, items, appBase()));
          where = r.where;
          await ringBells(state, `behind-raise-${day}-${state.level}`);
          posted = "raise";
        }
      } else if (minutes >= 8 * 60 && minutes < 10 * 60) {
        // Already posted this morning (a raise after 5 AM today): no second post.
        const last = prev.lastPostAt ? new Date(prev.lastPostAt) : null;
        const recent = !!last && etDayKey(last) === day && etMinutesOfDay(last) >= 5 * 60;
        if (!recent && (await claim(`behindAlert.morning.${day}`))) {
          const r = await post(behindMessage("morning", state, items, appBase()));
          where = r.where;
          await ringBells(state, `behind-morning-${day}`);
          posted = "morning";
        }
      }
      const next: Stored = {
        level: state.level,
        since: prev.level === "ok" ? now.toISOString() : prev.since,
        posted: (prev.level !== "ok" && prev.posted) || !!posted,
        lastPostAt: posted ? now.toISOString() : prev.lastPostAt,
      };
      if (next.level !== prev.level || next.posted !== prev.posted || next.lastPostAt !== prev.lastPostAt) {
        const value = JSON.stringify(next);
        await prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedBy: "behind-alert" }, update: { value, updatedBy: "behind-alert" } });
      }
      return { level: state.level, posted, ...(where ? { where } : {}) };
    }

    // Clear. Only the tick that swaps the stored state posts "Back on track".
    if (prev.level !== "ok" && row) {
      const value = JSON.stringify({ level: "ok", since: null, posted: false, lastPostAt: prev.lastPostAt } satisfies Stored);
      const swapped = await prisma.appSetting.updateMany({ where: { key: STATE_KEY, value: row.value }, data: { value, updatedBy: "behind-alert" } });
      if (swapped.count === 1 && prev.posted) {
        const r = await post(backOnTrackMessage());
        return { level: "ok", posted: "clear", where: r.where };
      }
    }
    return { level: "ok", posted: null };
  } catch (e) {
    console.error("[behind] alert failed", e);
    return { level: report.state.level, posted: null, skipped: `failed: ${(e as Error)?.message ?? "error"}` };
  }
}

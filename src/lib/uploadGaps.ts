import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etTime, etYesterdayKey } from "@/lib/datetime";
import { noDashes } from "@/lib/text";
import { HUB_SMS_PREFIX, staffTextNumber } from "@/lib/hubSms";
import { isSyntheticClientRow } from "@/lib/testClients";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// WHAT THE UPLOAD IS MISSING (Oct 19 2026). Jordan: "it would be cool if the
// package got checked for what was being delivered and the files also got
// checked and if anything is missing from the upload, the creative gets a
// text. Has to be sure though. Like today, it looks like Harrison only
// uploaded drone photos to Dropbox for his shoots."
//
// THE ORDER says what has to come in: Photos → ground photos (the camera's
// bracket sets), Drone → aerials, a video or reel → footage. Floor plans and
// 3D tours are captured in their own apps, not Dropbox, so they are not checked.
// DROPBOX says what came in: the job's 01-RAW-Photos and 02-RAW-Video, read
// recursively; a file is drone when its name says so (DJI_…) or it sits in a
// Drone folder.
//
// SURE, NOT EARLY. Sixteen shoots read on Oct 19: ground photos always landed
// first or with the drone files, within about 15 minutes; drone files and
// footage often come hours or days later. So:
//   · GROUND PHOTOS are missing when the drone photos are in, there is not one
//     ground photo, nothing new has landed for an hour and the shoot started
//     two hours ago, or when the creative has handed the photos in on the
//     upload page and there are none;
//   · DRONE is missing only once the creative has handed the photos in on the
//     upload page and there is not one drone file anywhere;
//   · FOOTAGE is missing only once the creative has handed the video in on
//     the upload page and there is not one non-drone clip.
// A monthly content session and a test client are never checked.
//
// WHAT HAPPENS, once per job and gap: the creative on the appointment gets one
// text from the company line (outbox kind `upload_gap`), the job's timeline
// says so, Kyle (whoever has ops alerts) gets a bell, and the photo delivery
// gate shows "Everything ordered was uploaded" as not met until the files
// land. When they land, the timeline says so and the gate clears. Its own
// switch: Settings, Internal alerts, "Missing from the upload".
// ---------------------------------------------------------------------------

/** How long the folders must be quiet before a gap counts (no handoff yet). */
const SETTLE_MIN = 60;
/** After the creative hands a half in on the upload page. */
const HANDOFF_SETTLE_MIN = 15;
/** The shoot started at least this long ago. */
const AFTER_START_H = 2;
/** Jobs whose shoot started within this many days are checked. */
const LOOKBACK_DAYS = 3;
/** A job with a gap still open is re-read this long after its shoot, until the gap closes. */
const OPEN_GAP_LOOKBACK_DAYS = 30;
/** One Dropbox read per job at most this often. */
const RECHECK_MIN = 15;
const REQUESTED_BY = "upload-gap-text";

export type GapKind = "ground_photos" | "drone" | "footage";
export const GAP_WORDS: Record<GapKind, string> = {
  ground_photos: "the ground photos",
  drone: "the drone shots",
  footage: "the video footage",
};

export type UploadCounts = {
  /** images in 01-RAW-Photos that are not drone */
  groundPhotos: number;
  /** drone images in 01-RAW-Photos */
  dronePhotos: number;
  /** drone clips in 02-RAW-Video */
  droneClips: number;
  /** non-drone clips in 02-RAW-Video */
  footage: number;
  /** the newest file in either folder */
  newestAt: Date | null;
};

export type Ordered = { photos: boolean; drone: boolean; video: boolean };

export type GapReading = {
  /** gaps the hub is sure of */
  sure: GapKind[];
  /** other ordered kinds with no files yet (named in the text, never a reason for one) */
  alsoEmpty: GapKind[];
  /** why nothing counts yet ("still uploading", "nothing uploaded") — null when read */
  waiting: string | null;
};

const IMG_RE = /\.(jpe?g|png|dng|arw|cr2|cr3|nef|raw|heic|tiff?)$/i;
const VID_RE = /\.(mp4|mov|mxf|avi|mts|m4v|insv|lrv)$/i;
const DRONE_NAME = /^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i;
const DRONE_DIR = /\/drone(\/|$)/i;

/** Sort one folder listing into the counts (pure). */
export function countUpload(
  photos: { name: string; path?: string | null; serverModified?: string | null }[],
  videos: { name: string; path?: string | null; serverModified?: string | null }[],
): UploadCounts {
  const isDrone = (f: { name: string; path?: string | null }) => DRONE_NAME.test(f.name) || DRONE_DIR.test(f.path ?? "");
  const imgs = photos.filter((f) => IMG_RE.test(f.name));
  const clips = videos.filter((f) => VID_RE.test(f.name));
  const times = [...imgs, ...clips].map((f) => Date.parse(f.serverModified ?? "")).filter((t) => Number.isFinite(t));
  return {
    groundPhotos: imgs.filter((f) => !isDrone(f)).length,
    dronePhotos: imgs.filter(isDrone).length,
    droneClips: clips.filter(isDrone).length,
    footage: clips.filter((f) => !isDrone(f)).length,
    newestAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

/** What is missing, and whether the hub is sure (pure). */
export function readGaps(o: { ordered: Ordered; counts: UploadCounts; startAt: Date; now: Date; photosHandoffAt: Date | null; videoHandoffAt: Date | null }): GapReading {
  const { ordered, counts: c, now } = o;
  const total = c.groundPhotos + c.dronePhotos + c.droneClips + c.footage;
  const empty: GapKind[] = [
    ...(ordered.photos && c.groundPhotos === 0 ? ["ground_photos" as const] : []),
    ...(ordered.drone && c.dronePhotos + c.droneClips === 0 ? ["drone" as const] : []),
    ...(ordered.video && c.footage === 0 ? ["footage" as const] : []),
  ];
  if (total === 0) return { sure: [], alsoEmpty: empty, waiting: "nothing uploaded yet" };
  if (now.getTime() - o.startAt.getTime() < AFTER_START_H * 3_600_000) return { sure: [], alsoEmpty: empty, waiting: "the shoot only just started" };
  const quietFor = (min: number) => !c.newestAt || now.getTime() - c.newestAt.getTime() >= min * 60_000;
  const handedIn = (at: Date | null) => !!at && now.getTime() - at.getTime() >= HANDOFF_SETTLE_MIN * 60_000 && quietFor(HANDOFF_SETTLE_MIN);
  const sure: GapKind[] = [];
  if (ordered.photos && c.groundPhotos === 0 && ((c.dronePhotos > 0 && quietFor(SETTLE_MIN)) || handedIn(o.photosHandoffAt))) sure.push("ground_photos");
  if (ordered.drone && c.dronePhotos + c.droneClips === 0 && handedIn(o.photosHandoffAt)) sure.push("drone");
  if (ordered.video && c.footage === 0 && handedIn(o.videoHandoffAt)) sure.push("footage");
  const waiting = sure.length || quietFor(SETTLE_MIN) ? null : "still uploading";
  return { sure, alsoEmpty: empty.filter((k) => !sure.includes(k)), waiting };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What Dropbox holds, in a phone's words: "45 drone photos and 4 drone clips". */
export function heldWords(c: UploadCounts): string {
  const parts = [
    c.groundPhotos ? plural(c.groundPhotos, "ground photo") : null,
    c.dronePhotos ? plural(c.dronePhotos, "drone photo") : null,
    c.droneClips ? plural(c.droneClips, "drone clip") : null,
    c.footage ? plural(c.footage, "video clip") : null,
  ].filter((x): x is string => !!x);
  return parts.length <= 1 ? parts[0] ?? "nothing" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const listWords = (kinds: GapKind[]) => {
  const w = kinds.map((k) => GAP_WORDS[k]);
  return w.length <= 1 ? w[0] ?? "" : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
};

/** The creative's text (pure). No dashes; the upload page linked. The words are
 *  the upload_gap template (Settings → Text messages, Oct 21 2026); the hub
 *  marker stays in front. `t` = saved wording, else default. */
export function composeGapText(o: { firstName: string; street: string; shotWhen: string; counts: UploadCounts; sure: GapKind[]; alsoEmpty: GapKind[]; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  const also = o.alsoEmpty.length ? `Also not there yet: ${listWords(o.alsoEmpty)}.` : "";
  const missing = listWords(o.sure);
  return noDashes(
    `${HUB_SMS_PREFIX}: ${t.render("upload_gap", { firstName: o.firstName, street: o.street, shotWhen: o.shotWhen, held: heldWords(o.counts), missing, alsoMissing: also, link: o.link })}`,
  );
}

// ---- the record per job ---------------------------------------------------------

export type GapState = {
  checkedAt: string;
  counts: Omit<UploadCounts, "newestAt"> & { newestAt: string | null };
  /** open gaps the hub is sure of, with when it texted */
  open: { kind: GapKind; since: string; textedAt: string | null; textedTo: string[] }[];
  /** gaps that were open and are now answered */
  resolved: { kind: GapKind; at: string }[];
};

const KEY_PREFIX = "upload_gaps:";
const keyOf = (projectId: string) => `${KEY_PREFIX}${projectId}`;

/**
 * What the order still owes for the upload check (audit C1, Oct 20 2026): a
 * line pulled from the Aryeo order, waived, or marked "couldn't complete" on
 * the wrap-up is not owed, so it is never texted for and never holds the gate.
 */
const OWED_FOR_GAPS = { ...OWED_DELIVERABLE_WHERE, notCompletedReason: null };

const owedKind = (kind: GapKind, types: Set<string>) =>
  kind === "ground_photos" ? types.has("PHOTOS") : kind === "drone" ? types.has("DRONE") : types.has("VIDEO") || types.has("SOCIAL_REEL");

/** The job's gap record. A database error THROWS (audit C1): the gate must not read it as "no gap". */
export async function gapStateFor(projectId: string): Promise<GapState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyOf(projectId) }, select: { value: true } });
  if (!row) return null;
  try { return JSON.parse(row.value) as GapState; } catch { return null; }
}

async function saveState(projectId: string, s: GapState): Promise<void> {
  const value = JSON.stringify(s);
  await prisma.appSetting.upsert({ where: { key: keyOf(projectId) }, create: { key: keyOf(projectId), value }, update: { value } });
}

/**
 * The photo delivery gate's line: open photo-side gaps (ground photos, drone)
 * on this job that the order still owes. Throws when it cannot read, so the
 * gate shows the line as not met instead of passing it.
 */
export async function openPhotoGaps(projectId: string): Promise<{ kinds: GapKind[]; words: string } | null> {
  const s = await gapStateFor(projectId);
  const recorded = (s?.open ?? []).map((g) => g.kind).filter((k) => k === "ground_photos" || k === "drone");
  if (!recorded.length || !s) return null;
  // A line pulled from the order after the gap opened no longer holds the gate,
  // even before the next sweep closes the record.
  const owed = await prisma.deliverable.findMany({ where: { projectId, ...OWED_FOR_GAPS, type: { in: ["PHOTOS", "DRONE"] } }, select: { type: true } });
  const types = new Set<string>(owed.map((d) => d.type));
  const kinds = recorded.filter((k) => owedKind(k, types));
  if (!kinds.length) return null;
  return { kinds, words: `Dropbox has ${heldWords({ ...s.counts, newestAt: null })}; missing ${listWords(kinds)}` };
}

// ---- the sweep --------------------------------------------------------------------

export type GapRun =
  | { skipped: string }
  | { checked: number; texted: string[]; resolved: string[]; notSent: string[]; waiting: string[] };

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const streetOf = (title: string, addressLine: string | null) =>
  (addressLine?.trim() && !/^\[No address/i.test(addressLine) ? addressLine.trim() : title.split(",")[0].trim()) || "Your shoot";

function shotWhen(startAt: Date, now: Date): string {
  if (etDayKey(startAt) === etDayKey(now)) return "today";
  if (etYesterdayKey(now) === etDayKey(startAt)) return "yesterday"; // by key, not 24 h ago (Oct 28 2026)
  return startAt.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" });
}

export const uploadGapKey = (projectId: string, teamMemberId: string, kinds: GapKind[]) => `upload_gap:${projectId}:${teamMemberId}:${[...kinds].sort().join("+")}`;

/** Every 5 minutes (cron/gmail); each job's Dropbox is read at most every 15. */
export async function sweepUploadGaps(now: Date = new Date(), opts: { only?: string[]; dryRun?: boolean } = {}): Promise<GapRun> {
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  if (!rules.uploadGap.enabled && !opts.dryRun) return { skipped: "switched off (Settings, Internal alerts, Missing from the upload)" };

  // Jobs with a gap still open are re-read past the 3 days until it closes
  // (audit C1): otherwise a gap opened on day 3 stayed open, and held the gate,
  // forever. JSON.stringify writes an empty list as "open":[].
  const openRows = await prisma.appSetting.findMany({
    where: { key: { startsWith: KEY_PREFIX }, NOT: { value: { contains: '"open":[]' } } },
    select: { key: true },
  });
  const openIds = new Set(openRows.map((r) => r.key.slice(KEY_PREFIX.length)));
  const started = new Date(now.getTime() - AFTER_START_H * 3_600_000);
  const appts = await prisma.appointment.findMany({
    where: {
      OR: [
        { startAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000), lte: started } },
        ...(openIds.size ? [{ projectId: { in: [...openIds] }, startAt: { gte: new Date(now.getTime() - OPEN_GAP_LOOKBACK_DAYS * 86_400_000), lte: started } }] : []),
      ],
      project: {
        status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] },
        contentMonthId: null,
        ...(opts.only ? { id: { in: opts.only } } : {}),
      },
    },
    orderBy: { startAt: "asc" },
    select: {
      startAt: true, status: true, assignedToId: true,
      project: {
        select: {
          id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, photographerId: true,
          photosHandoffAt: true, videoHandoffAt: true,
          client: { select: { id: true, name: true } },
          deliverables: { where: OWED_FOR_GAPS, select: { type: true } },
        },
      },
    },
  });
  const { liveAppointment } = await import("@/lib/shootDayText");
  type Job = { p: (typeof appts)[number]["project"]; startAt: Date; creatives: Set<string> };
  const jobs = new Map<string, Job>();
  for (const a of appts) {
    if (!liveAppointment(a) || isSyntheticClientRow(a.project.client)) continue;
    const types = new Set(a.project.deliverables.map((d) => d.type));
    // Nothing the upload check reads is owed: skipped, unless a gap is still
    // open on it, which the loop below closes.
    if (!types.has("PHOTOS") && !types.has("DRONE") && !types.has("VIDEO") && !types.has("SOCIAL_REEL") && !openIds.has(a.project.id)) continue;
    const j = jobs.get(a.project.id) ?? { p: a.project, startAt: a.startAt!, creatives: new Set<string>() };
    const who = a.assignedToId ?? a.project.photographerId;
    if (who) j.creatives.add(who);
    jobs.set(a.project.id, j);
  }

  const run = { checked: 0, texted: [] as string[], resolved: [] as string[], notSent: [] as string[], waiting: [] as string[] };
  if (jobs.size === 0) return run;
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { dropboxListFolder } = await import("@/lib/integrations/dropbox");
  const { appBase } = await import("@/lib/appUrl");

  for (const { p, startAt, creatives } of jobs.values()) {
    const street = streetOf(p.title, p.addressLine);
    let before: GapState | null;
    try {
      before = await gapStateFor(p.id);
    } catch (e) {
      // Never overwrite a record the sweep could not read.
      run.notSent.push(`${street}: the upload check record could not be read (${(e as Error)?.message?.slice(0, 80) ?? "error"})`);
      continue;
    }
    const types = new Set<string>(p.deliverables.map((d) => d.type));
    const ordered: Ordered = { photos: types.has("PHOTOS"), drone: types.has("DRONE"), video: types.has("VIDEO") || types.has("SOCIAL_REEL") };
    // An open gap whose line left the order closes without a Dropbox read.
    if (!ordered.photos && !ordered.drone && !ordered.video) {
      if (before?.open.length && !opts.dryRun) {
        await closeGapsNoLongerOwed(p.id, before, before.open.map((g) => g.kind), now);
        run.resolved.push(`${street}: no longer on the order`);
      }
      continue;
    }
    if (!opts.only && before && now.getTime() - Date.parse(before.checkedAt) < RECHECK_MIN * 60_000) continue;
    const paths = actualFolderPaths({ ...p, client: p.client! } as never) as { rawPhotos: string; rawVideo: string };
    const list = async (path: string) => {
      try {
        return (await dropboxListFolder(path, { recursive: true })).filter((e) => e.tag === "file") as { name: string; path?: string; serverModified?: string }[];
      } catch (e) {
        // A folder that is not there yet is an empty upload; any other failure is no reading at all.
        if (/not_found|path_lookup/i.test(String((e as Error)?.message ?? e))) return [];
        throw e;
      }
    };
    let counts: UploadCounts;
    try {
      const [ph, vi] = await Promise.all([list(paths.rawPhotos), list(paths.rawVideo)]);
      counts = countUpload(ph, vi);
    } catch (e) {
      run.notSent.push(`${street}: Dropbox could not be read (${(e as Error)?.message?.slice(0, 80) ?? "error"})`);
      continue;
    }
    run.checked++;
    const reading = readGaps({ ordered, counts, startAt, now, photosHandoffAt: p.photosHandoffAt, videoHandoffAt: p.videoHandoffAt });
    if (reading.waiting && !reading.sure.length) run.waiting.push(`${street}: ${reading.waiting}`);

    const state: GapState = {
      checkedAt: now.toISOString(),
      counts: { ...counts, newestAt: counts.newestAt?.toISOString() ?? null },
      open: [],
      resolved: [...(before?.resolved ?? [])],
    };
    // Gaps that were open and are answered now.
    const nowMissing = new Set<GapKind>([...reading.sure, ...reading.alsoEmpty]);
    for (const g of before?.open ?? []) {
      if (nowMissing.has(g.kind)) state.open.push(g);
      else {
        const dropped = !owedKind(g.kind, types);
        state.resolved.push({ kind: g.kind, at: now.toISOString() });
        run.resolved.push(`${street}: ${GAP_WORDS[g.kind]}${dropped ? " (no longer on the order)" : ""}`);
        if (!opts.dryRun) {
          const body = dropped
            ? `Upload check: no longer owed on the order, so the check for ${GAP_WORDS[g.kind]} is closed.`
            : `Upload check: ${GAP_WORDS[g.kind]} are in Dropbox now (${heldWords(counts)}).`;
          await prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body } }).catch(() => {});
        }
      }
    }
    // New sure gaps.
    const fresh = reading.sure.filter((k) => !state.open.some((g) => g.kind === k));
    for (const k of fresh) state.open.push({ kind: k, since: now.toISOString(), textedAt: null, textedTo: [] });
    if (opts.dryRun) {
      if (fresh.length) run.texted.push(`${street}: WOULD text (${fresh.map((k) => GAP_WORDS[k]).join(", ")}; Dropbox has ${heldWords(counts)})`);
      continue;
    }

    if (fresh.length) {
      const texted = await textCreatives({ projectId: p.id, street, startAt, now, counts, sure: fresh, alsoEmpty: reading.alsoEmpty.filter((k) => !fresh.includes(k)), creatives: [...creatives], link: `${appBase()}/upload/${p.id}` });
      for (const g of state.open) if (fresh.includes(g.kind)) { g.textedAt = texted.sentTo.length ? now.toISOString() : null; g.textedTo = texted.sentTo; }
      run.texted.push(...texted.sentTo.map((n) => `${street} to ${n}`));
      run.notSent.push(...texted.notSent);
      const who = texted.sentTo.length ? `Texted ${texted.sentTo.map(firstName).join(" and ")} at ${etTime(now)}.` : `Nobody could be texted (${texted.notSent.join("; ") || "no creative on the appointment"}).`;
      await prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body: `Upload check: Dropbox has only ${heldWords(counts)}; missing ${listWords(fresh)}. ${who}`.slice(0, 500) } }).catch(() => {});
      await bellOffice(p.id, street, `Missing from the upload: ${listWords(fresh)} (Dropbox has ${heldWords(counts)}).`, fresh);
    }
    await saveState(p.id, state);
  }
  return run;
}

async function closeGapsNoLongerOwed(projectId: string, before: GapState, kinds: GapKind[], now: Date): Promise<void> {
  const at = now.toISOString();
  await saveState(projectId, {
    ...before,
    checkedAt: at,
    open: before.open.filter((g) => !kinds.includes(g.kind)),
    resolved: [...before.resolved, ...kinds.map((kind) => ({ kind, at }))],
  });
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: `Upload check: no longer owed on the order, so the check for ${listWords(kinds)} is closed.` } }).catch(() => {});
}

async function textCreatives(o: { projectId: string; street: string; startAt: Date; now: Date; counts: UploadCounts; sure: GapKind[]; alsoEmpty: GapKind[]; creatives: string[]; link: string }): Promise<{ sentTo: string[]; notSent: string[] }> {
  const out = { sentTo: [] as string[], notSent: [] as string[] };
  if (!o.creatives.length) return out;
  const members = await prisma.teamMember.findMany({ where: { id: { in: o.creatives } }, select: { id: true, name: true, phone: true, active: true } });
  const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const { sendThroughOutbox } = await import("@/lib/outbox");
  const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  const { loadTextTemplates } = await import("@/lib/textTemplateStore");
  const words = await loadTextTemplates();
  for (const m of members) {
    const num = staffTextNumber(m.phone);
    if (!m.active || !num) { out.notSent.push(`${m.name}: ${!m.active ? "not active" : "no phone"}`); continue; }
    if (ours.has(num.key)) { out.notSent.push(`${m.name}: their number is our own office line`); continue; }
    const body = composeGapText({ firstName: firstName(m.name), street: o.street, shotWhen: shotWhen(o.startAt, o.now), counts: o.counts, sure: o.sure, alsoEmpty: o.alsoEmpty, link: o.link }, words);
    try {
      // A team text: their quiet time does not hold it (anyone on the team can
      // be pinged any hour), and the key makes it once per job, person and gap.
      const r = await sendThroughOutbox({ channel: "sms", toRef: num.key, body, dedupeKey: uploadGapKey(o.projectId, m.id, o.sure), projectId: o.projectId, requestedBy: REQUESTED_BY });
      // "duplicate": an earlier tick already sent this exact text.
      if (r.outcome === "duplicate") out.sentTo.push(m.name);
      else if (r.outcome === "accepted") {
        out.sentTo.push(m.name);
        try {
          const { logDelivery } = await import("@/lib/notify");
          await logDelivery({ teamMemberId: m.id, kind: "upload_gap_text", channel: "sms", status: "sent", detail: r.providerId ? `op-${r.providerId}` : null });
        } catch { /* the outbox row is the record */ }
      } else out.notSent.push(`${m.name}: ${r.outcome}${"error" in r && r.error ? ` (${r.error})` : ""}`);
    } catch (e) {
      out.notSent.push(`${m.name}: could not queue (${e instanceof Error ? e.message : "error"})`);
    }
  }
  return out;
}

const ANY_ROLE = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"] as const;

async function bellOffice(projectId: string, street: string, body: string, kinds: GapKind[]): Promise<void> {
  try {
    const staff = await prisma.teamMember.findMany({ where: { active: true, opsAlerts: true }, select: { id: true } });
    if (!staff.length) return;
    const { notifyInApp } = await import("@/lib/notify");
    const href = `/projects/${projectId}`;
    await notifyInApp({
      kind: "upload_gap",
      title: `Missing from the upload — ${street}`,
      body: body.slice(0, 140),
      href,
      targets: staff.map((s) => ({ roles: [...ANY_ROLE], userKey: `tm:${s.id}`, href })),
      dedupeKey: `upload-gap-${projectId}-${[...kinds].sort().join("+")}`,
    });
  } catch { /* the bell is best-effort; the timeline line and the gate carry it */ }
}

/** An upload-gap text the outbox watchdog sent after its sweep stopped (cron/gmail drainPending). */
export async function recordDrainedUploadGapText(row: { dedupeKey: string | null }): Promise<string | null> {
  const [kind, projectId, teamMemberId] = (row.dedupeKey ?? "").split(":");
  if (kind !== "upload_gap" || !projectId || !teamMemberId) return null;
  const m = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true } }).catch(() => null);
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: `Upload check: the text to ${m ? firstName(m.name) : "the creative"} went out at ${etTime(new Date())} (recovered).` } }).catch(() => {});
  return `recovered and sent the upload-gap text for ${projectId} to ${m?.name ?? teamMemberId}`;
}

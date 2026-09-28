import "server-only";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { logComm } from "@/lib/commLog";

// ---------------------------------------------------------------------------
// The 7 PM shoot digest (Jordan, Sep 1 2026): every evening, each creative
// with shoots that day gets ONE text — the list of their shoots and the link
// to their upload portal, where each job must be wrapped up the same night.
// Idempotent per photographer per ET day (the cron fires on two UTC schedules
// to hit 7 PM across EDT/EST; the marker makes the second firing a no-op).
// ---------------------------------------------------------------------------

const APP_URL = appBase();

// ---------------------------------------------------------------------------
// THE NOTIFICATION SCHEDULE (Sep 26 2026 review). Every text below goes
// straight through OpenPhone, and until this review none of them asked the
// schedule: the owner shoots, so a Saturday job of his own texted him at 7:00
// PM, inside the quiet time the Settings card says holds his texts until 7:30.
// Each sender now asks first (notify.ts holdStaffTextForQuietTime). A person
// inside their quiet time gets the SAME text, from the staff queue, when the
// window ends — the per-day (or per-job) claim is kept, so it still goes once
// and the second UTC firing still does nothing. Nobody without a schedule —
// every photographer but the owner today — sees any change at all.
// ---------------------------------------------------------------------------
async function heldForQuietTime(memberId: string, text: string, kind: string, at?: Date): Promise<Date | null> {
  const { holdStaffTextForQuietTime } = await import("@/lib/notify");
  return holdStaffTextForQuietTime(memberId, text, kind, at).catch(() => null);
}

function etDayKey(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

/** ET midnight-to-midnight window for "today", expressed in UTC instants.
 *  Known 1h edge skew on the two DST transition days for shoots timestamped
 *  11 PM–1 AM ET — real shoots never are (reviewed and accepted). */
function etDayWindow(): { start: Date; end: Date } {
  const key = etDayKey();
  // Resolve the ET offset at noon ET today (DST-safe for a whole-day window).
  const noonUtc = new Date(`${key}T12:00:00Z`);
  const etHourAtNoonUtc = Number(
    noonUtc.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
  );
  const offsetHours = 12 - etHourAtNoonUtc; // 4 during EDT, 5 during EST
  const start = new Date(`${key}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + offsetHours);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

// Plain and human (Jordan, Sep 1: the first draft read "cryptic") — short
// sentences, a numbered list, one idea per line. Once the photographer has
// agreed to the new process, the intro/footer drop and it's just the nightly
// list.
export function digestText(firstName: string, streets: string[], opts?: { newProcess?: boolean }): string {
  const list = streets.map((s, i) => `${i + 1}. ${s}`).join("\n");
  if (opts?.newProcess === false) {
    return (
      `Hi ${firstName} — RealTour Pilot here.\n\n` +
      `Tonight's shoots to upload:\n${list}\n\n` +
      `Files in Dropbox, then finish each shoot's checklist:\n${APP_URL}/upload`
    );
  }
  return (
    `Hi ${firstName} — RealTour Pilot here.\n\n` +
    `Heads up: uploads work a new way starting today.\n\n` +
    `Tonight's shoots to upload:\n${list}\n\n` +
    `Upload to Dropbox like always, then finish each shoot's checklist here:\n` +
    `${APP_URL}/upload\n\n` +
    `The first time you open it, it explains everything — takes 2 minutes.`
  );
}

// The one-time launch announcement (Jordan approves the copy, then the blast
// goes to every ACTIVE photographer with a phone — once ever, marker-guarded).
export function introUploadProcessText(firstName: string): string {
  return (
    `Hi ${firstName} — RealTour Pilot here.\n\n` +
    `Starting today: every shoot now finishes on its UPLOAD PAGE. This is required for every shoot going forward.\n\n` +
    `Nothing changes about Dropbox — files go there like always. The page is the wrap-up: confirm your cull, note the shot order, flag anything for the editor, hit submit. A few minutes per shoot.\n\n` +
    `Worth knowing:\n` +
    `1. A shoot is added to your payroll when you submit its page.\n` +
    `2. First time in, the page explains everything: ${APP_URL}/upload\n\n` +
    `We're open to feedback — there's a feedback box after every submit and we'll keep improving it. But this one's not optional.\n\n` +
    `Questions? Text Kyle or Jordan.`
  );
}

export async function sendUploadProcessIntro(): Promise<{ sent: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const members = await prisma.teamMember.findMany({
    where: { role: "PHOTOGRAPHER", active: true, phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const from = await defaultOpenPhoneNumber();
  if (!from) return { sent: 0, skipped: members.length, notes: ["OpenPhone not connected"] };
  let sent = 0, skipped = 0;
  for (const m of members) {
    const k = phoneKey(m.phone ?? "");
    if (k.length !== 10) { skipped++; notes.push(`${m.name}: no valid phone`); continue; }
    const marker = `upload-intro-${m.id}`; // once EVER, not per day
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch { skipped++; continue; }
    const text = introUploadProcessText(m.name.split(" ")[0]);
    try {
      await OpenPhone.sendMessage(from, `+1${k}`, text);
      sent++;
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        contactName: m.name, fromPhone: k, body: text,
        source: "upload-intro", externalId: marker,
      }).catch((e) => { notes.push(`${m.name}: sent but comms log failed — ${e instanceof Error ? e.message : "?"}`); });
    } catch (e) {
      await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
      skipped++;
      notes.push(`${m.name}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  return { sent, skipped, notes };
}

// The 10 PM chaser: shoots that HAPPENED today whose upload page still isn't
// submitted. One text per photographer, atomic per-day marker.
//
// O05 (Jordan, Sep 25 2026): photos and video are submitted separately now,
// and a job whose photos are in but whose video is not gets its own line in
// the same text — "photos are uploaded but video is not. Please upload the
// video before 8am tomorrow. And then a link to the upload portal. This is
// something that will affect their KPI's." Same channel, same switch, same
// hour and the same one-text-a-night marker as the chaser it rides on.
export type SplitNag = { street: string; url: string };
/** ONE split notice per job, ever — the chaser and the late-evening send
 *  (sendSplitNoticeIfChaserPassed) both claim it, so it never goes twice. */
export const splitNoticeKey = (projectId: string) => `upload-split-${projectId}`;
export function nagText(firstName: string, streets: string[], split: SplitNag[] = []): string {
  const parts: string[] = [`Hi ${firstName} — RealTour Pilot here.`];
  if (streets.length > 0) {
    const list = streets.map((s, i) => `${i + 1}. ${s}`).join("\n");
    parts.push(
      `Still waiting on today's upload page${streets.length === 1 ? "" : "s"}:\n${list}\n\n` +
        `Finish tonight — files in Dropbox + the page submitted. The shoot is added to your payroll when you submit:\n` +
        `${APP_URL}/upload`,
    );
  }
  if (split.length === 1) {
    parts.push(
      `Photos are uploaded for ${split[0].street}, but the video is not. Please upload the video and submit it before 8:00 AM tomorrow:\n${split[0].url}\n\n` +
        `A video that comes in after 8:00 AM counts as a late upload on your KPIs.`,
    );
  } else if (split.length > 1) {
    const list = split.map((s, i) => `${i + 1}. ${s.street}: ${s.url}`).join("\n");
    parts.push(
      `Photos are uploaded but the video is not for:\n${list}\n\n` +
        `Please upload each video and submit it before 8:00 AM tomorrow. A video that comes in after 8:00 AM counts as a late upload on your KPIs.`,
    );
  }
  return parts.join("\n\n");
}

export async function sendNightlyUploadNags(): Promise<{ sent: number; skipped: number; notes: string[]; held?: string[] }> {
  const notes: string[] = [];
  const held: string[] = [];
  const { start } = etDayWindow();
  const dayKey = etDayKey();
  const now = new Date();

  const [shoots, halfIn] = await Promise.all([
    prisma.project.findMany({
      where: {
        shootDate: { gte: start, lte: now }, // happened TODAY (never nag a future or ON_HOLD shoot)
        status: { notIn: ["CANCELLED", "ON_HOLD"] },
        aryeoMissingAt: null,
        photographerId: { not: null },
        debriefSubmittedAt: null,
      },
      select: {
        id: true, title: true,
        photographer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { shootDate: "asc" },
    }),
    // O05: the photos went in TODAY and the video half is still owed — the
    // 8:00 AM clock started today, whatever day the shoot was. A video every
    // line of which was marked "couldn't complete", waived or taken off the
    // order owes nothing, and is not chased.
    prisma.project.findMany({
      where: {
        photosHandoffAt: { gte: start, lte: now },
        videoHandoffAt: null,
        debriefSubmittedAt: null,
        status: { notIn: ["CANCELLED", "ON_HOLD"] },
        aryeoMissingAt: null,
        photographerId: { not: null },
        deliverables: {
          some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null, notCompletedReason: null },
        },
      },
      select: {
        id: true, title: true,
        photographer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { photosHandoffAt: "asc" },
    }),
  ]);
  if (shoots.length === 0 && halfIn.length === 0) return { sent: 0, skipped: 0, notes: ["nothing unsubmitted today"] };

  const splitIds = new Set(halfIn.map((p) => p.id));
  const byMember = new Map<string, { name: string; phone: string | null; streets: string[]; split: (SplitNag & { projectId: string })[] }>();
  const entry = (ph: { id: string; name: string; phone: string | null }) => {
    const cur = byMember.get(ph.id) ?? { name: ph.name, phone: ph.phone, streets: [], split: [] };
    byMember.set(ph.id, cur);
    return cur;
  };
  for (const s of shoots) {
    if (!s.photographer || splitIds.has(s.id)) continue; // its own, more specific line below
    entry(s.photographer).streets.push(s.title.split(",")[0]);
  }
  for (const s of halfIn) {
    if (!s.photographer) continue;
    entry(s.photographer).split.push({ projectId: s.id, street: s.title.split(",")[0], url: `${APP_URL}/upload/${s.id}` });
  }

  const from = await defaultOpenPhoneNumber();
  if (!from) return { sent: 0, skipped: byMember.size, notes: ["OpenPhone not connected"] };

  let sent = 0, skipped = 0;
  for (const [memberId, m] of byMember) {
    const k = phoneKey(m.phone ?? "");
    if (k.length !== 10) { skipped++; notes.push(`${m.name}: no valid phone`); continue; }
    const marker = `upload-nag-${dayKey}-${memberId}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch { skipped++; continue; }
    // Each split job's own once-ever claim: a job already told (the
    // late-evening send got there first) is not told again.
    const split: SplitNag[] = [];
    const splitKeys: string[] = [];
    for (const sj of m.split) {
      const key = splitNoticeKey(sj.projectId);
      try {
        await prisma.appSetting.create({ data: { key, value: new Date().toISOString() } });
        split.push({ street: sj.street, url: sj.url });
        splitKeys.push(key);
      } catch { /* already told */ }
    }
    if (m.streets.length === 0 && split.length === 0) {
      await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
      skipped++;
      continue;
    }
    const text = nagText(m.name.split(" ")[0], m.streets, split);
    // Their quiet time: the same text waits in the staff queue; the night's
    // claim and the split claims stay taken, so it still goes once.
    const heldUntil = await heldForQuietTime(memberId, text, "upload_nag");
    if (heldUntil) {
      held.push(`${m.name}: held until ${heldUntil.toISOString()} (their quiet time)`);
      continue;
    }
    try {
      await OpenPhone.sendMessage(from, `+1${k}`, text);
      sent++;
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        contactName: m.name, fromPhone: k, body: text,
        source: "upload-nag", externalId: marker,
      }).catch((e) => { notes.push(`${m.name}: sent but comms log failed — ${e instanceof Error ? e.message : "?"}`); });
    } catch (e) {
      await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
      if (splitKeys.length) await prisma.appSetting.deleteMany({ where: { key: { in: splitKeys } } }).catch(() => {});
      skipped++;
      notes.push(`${m.name}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  // `held` is kept out of `notes` on purpose: the evening route reads a night
  // with nothing sent and something in `notes` as a failure (a 500 on the cron
  // dashboard), and a text waiting for someone's quiet time to end is not one.
  return { sent, skipped, notes, held };
}

/**
 * THE PHOTOS WENT IN AFTER TONIGHT'S CHASER (O05 review, Sep 25 2026). The
 * split line rides the chaser, and the chaser only reads photos handed off
 * earlier the same ET day, so a photos half at 10:30 PM — common, they are
 * told to finish tonight — was never told at all: the next night's chaser
 * skips it and the 8:00 AM deadline has passed by then. Called by the photos
 * half's submit: when that day's chaser hour has already come, the same text
 * goes now. Same channel, same switch, same phone checks; its own once-ever
 * claim per job (splitNoticeKey), shared with the chaser, so it never goes
 * twice. Before the chaser hour it does nothing — the chaser carries it. A
 * photos half after midnight is the next chaser's (its clock started that
 * day). Never throws.
 */
export async function sendSplitNoticeIfChaserPassed(projectId: string, now: Date = new Date()): Promise<{ sent: boolean; reason: string }> {
  try {
    const { internalAlertRules } = await import("@/lib/settings");
    const alerts = await internalAlertRules();
    if (!alerts.uploadChaser.enabled) return { sent: false, reason: "the upload chaser is switched off" };
    const etHour = Number(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24;
    if (etHour < alerts.uploadChaser.hour) return { sent: false, reason: "tonight's chaser carries it" };
    const today = etDayKey(now);
    const p = await prisma.project.findFirst({
      where: {
        id: projectId,
        videoHandoffAt: null,
        debriefSubmittedAt: null,
        photosHandoffAt: { not: null },
        status: { notIn: ["CANCELLED", "ON_HOLD"] },
        aryeoMissingAt: null,
        deliverables: {
          some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null, notCompletedReason: null },
        },
      },
      select: { id: true, title: true, photosHandoffAt: true, photographer: { select: { id: true, name: true, phone: true } } },
    });
    if (!p?.photographer || !p.photosHandoffAt) return { sent: false, reason: "nothing owed" };
    if (etDayKey(p.photosHandoffAt) !== today) return { sent: false, reason: "not tonight's photos" };
    const k = phoneKey(p.photographer.phone ?? "");
    if (k.length !== 10) return { sent: false, reason: "no valid phone" };
    const from = await defaultOpenPhoneNumber();
    if (!from) return { sent: false, reason: "OpenPhone not connected" };
    const key = splitNoticeKey(p.id);
    try {
      await prisma.appSetting.create({ data: { key, value: now.toISOString() } });
    } catch {
      return { sent: false, reason: "already told" };
    }
    const text = nagText(p.photographer.name.split(" ")[0], [], [{ street: p.title.split(",")[0], url: `${APP_URL}/upload/${p.id}` }]);
    // Their quiet time: the text waits in the staff queue; the job's claim
    // stays taken, so it still goes once.
    const heldUntil = await heldForQuietTime(p.photographer.id, text, "upload_nag", now);
    if (heldUntil) return { sent: false, reason: `held until ${heldUntil.toISOString()} (their quiet time) — it goes then` };
    try {
      await OpenPhone.sendMessage(from, `+1${k}`, text);
    } catch (e) {
      await prisma.appSetting.delete({ where: { key } }).catch(() => {});
      return { sent: false, reason: `send failed: ${e instanceof Error ? e.message : "unknown"}` };
    }
    await logComm({
      channel: "text", direction: "out", minRole: "ADMIN",
      contactName: p.photographer.name, fromPhone: k, body: text,
      source: "upload-nag", externalId: key,
    }).catch(() => {});
    return { sent: true, reason: "sent" };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : "failed" };
  }
}

export async function sendEveningUploadDigests(): Promise<{ sent: number; skipped: number; notes: string[]; held?: string[] }> {
  const notes: string[] = [];
  const held: string[] = [];
  const { start, end } = etDayWindow();
  const dayKey = etDayKey();

  const shoots = await prisma.project.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      // ON_HOLD = the shoot may not have happened — never tell someone to
      // wrap up content that wasn't captured (review finding).
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      aryeoMissingAt: null,
      photographerId: { not: null },
    },
    select: {
      id: true,
      title: true,
      photographerId: true,
      photographer: { select: { id: true, name: true, phone: true, email: true } },
    },
    orderBy: { shootDate: "asc" },
  });
  if (shoots.length === 0) return { sent: 0, skipped: 0, notes: ["no shoots today"] };

  const byMember = new Map<string, { name: string; phone: string | null; email: string | null; streets: string[] }>();
  for (const s of shoots) {
    if (!s.photographer) continue;
    const cur = byMember.get(s.photographer.id) ?? { name: s.photographer.name, phone: s.photographer.phone, email: s.photographer.email, streets: [] };
    cur.streets.push(s.title.split(",")[0]);
    byMember.set(s.photographer.id, cur);
  }

  const from = await defaultOpenPhoneNumber();
  if (!from) return { sent: 0, skipped: byMember.size, notes: ["OpenPhone not connected"] };

  let sent = 0, skipped = 0;
  for (const [memberId, m] of byMember) {
    const k = phoneKey(m.phone ?? "");
    if (k.length !== 10) { skipped++; notes.push(`${m.name}: no valid phone`); continue; }
    // ATOMIC claim FIRST (unique key insert) — two concurrent invocations can
    // never both text; the loser hits P2002 and skips. Send failure releases
    // the claim so the next firing retries (never-double-text > never-miss).
    const marker = `upload-digest-${dayKey}-${memberId}`;
    try {
      await prisma.appSetting.create({ data: { key: marker, value: new Date().toISOString() } });
    } catch {
      skipped++; // already claimed (today's text went out or is in flight)
      continue;
    }
    // Once they've agreed to the process, the "new way" intro retires itself.
    const acked = m.email
      ? await prisma.appSetting.findUnique({ where: { key: `upload-ack-${m.email.toLowerCase()}` } }).catch(() => null)
      : null;
    const text = digestText(m.name.split(" ")[0], m.streets, { newProcess: !acked });
    // Their quiet time (the owner's Saturday until 7:30 PM): the same list
    // waits in the staff queue and goes when the window ends. The day's claim
    // stays taken, so the 8 PM EDT firing and tomorrow cannot send it again.
    const heldUntil = await heldForQuietTime(memberId, text, "upload_digest");
    if (heldUntil) {
      held.push(`${m.name}: held until ${heldUntil.toISOString()} (their quiet time)`);
      continue;
    }
    try {
      await OpenPhone.sendMessage(from, `+1${k}`, text);
      sent++;
    } catch (e) {
      // Release the claim — this photographer was NOT texted.
      await prisma.appSetting.delete({ where: { key: marker } }).catch(() => {});
      skipped++;
      notes.push(`${m.name}: send failed — ${e instanceof Error ? e.message : "unknown"}`);
      continue;
    }
    try {
      await logComm({
        channel: "text", direction: "out", minRole: "ADMIN",
        contactName: m.name, fromPhone: k, body: text,
        source: "upload-digest", externalId: `upload-digest-${dayKey}-${memberId}`,
      });
    } catch (e) {
      notes.push(`${m.name}: sent but comms log failed — ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  // Held texts are reported apart from `notes` (see sendNightlyUploadNags).
  return { sent, skipped, notes, held };
}

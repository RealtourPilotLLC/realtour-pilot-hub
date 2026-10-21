import "server-only";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { logComm } from "@/lib/commLog";
import { etDayBoundsUtc, etDayKey, etHour } from "@/lib/datetime";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";
import { loadTextTemplates } from "@/lib/textTemplateStore";

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

/** ET midnight-to-midnight window for "today", expressed in UTC instants.
 *  From datetime.ts since Oct 21 2026 (audit H15), which also closes the old
 *  1h skew on the two DST transition days. */
const etDayWindow = (): { start: Date; end: Date } => etDayBoundsUtc(etDayKey(new Date()));

// Plain and human (Jordan, Sep 1: the first draft read "cryptic") — short
// sentences, a numbered list, one idea per line. The "uploads work a new way
// starting today" intro retired Oct 21 2026 (Jordan: "That was the first run
// and now it's in effect."): it showed to anyone the hub never saw agree to
// the process, which kept the owner on the launch copy every night.
// The words are the upload_digest template (Settings → Text messages, Oct 21
// 2026); the numbered list stays here. `t` = the saved wording, else default.
export function digestText(firstName: string, streets: string[], t: TextTemplateSet = DEFAULT_TEXTS): string {
  const list = streets.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return t.render("upload_digest", { firstName, shootList: list, uploadLink: `${APP_URL}/upload` });
}

// The one-time launch announcement (Jordan approves the copy, then the blast
// goes to every ACTIVE photographer with a phone — once ever, marker-guarded).
export function introUploadProcessText(firstName: string): string {
  return (
    `Hi ${firstName}, Realtour Pilot here.\n\n` +
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
// Four templates (Settings → Text messages, Oct 21 2026), one per part, joined
// with a blank line as before: the greeting, the shoots still waiting, and one
// or several videos missing. `t` = the saved wording, else the default.
export function nagText(firstName: string, streets: string[], split: SplitNag[] = [], t: TextTemplateSet = DEFAULT_TEXTS): string {
  const parts: string[] = [t.render("upload_chaser_greeting", { firstName })];
  if (streets.length > 0) {
    const list = streets.map((s, i) => `${i + 1}. ${s}`).join("\n");
    parts.push(t.render("upload_chaser_shoots", { pages: streets.length === 1 ? "page" : "pages", shootList: list, uploadLink: `${APP_URL}/upload` }));
  }
  if (split.length === 1) {
    parts.push(t.render("upload_chaser_video_one", { street: split[0].street, videoLink: split[0].url }));
  } else if (split.length > 1) {
    const list = split.map((s, i) => `${i + 1}. ${s.street}: ${s.url}`).join("\n");
    parts.push(t.render("upload_chaser_video_many", { videoList: list }));
  }
  return parts.join("\n\n");
}

export async function sendNightlyUploadNags(): Promise<{ sent: number; skipped: number; notes: string[]; held?: string[] }> {
  const notes: string[] = [];
  const held: string[] = [];
  const { start } = etDayWindow();
  const dayKey = etDayKey(new Date());
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
  const words = await loadTextTemplates();

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
    const text = nagText(m.name.split(" ")[0], m.streets, split, words);
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
    if (etHour(now) < alerts.uploadChaser.hour) return { sent: false, reason: "tonight's chaser carries it" };
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
    const text = nagText(p.photographer.name.split(" ")[0], [], [{ street: p.title.split(",")[0], url: `${APP_URL}/upload/${p.id}` }], await loadTextTemplates());
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
  const dayKey = etDayKey(new Date());

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
  const words = await loadTextTemplates();

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
    const text = digestText(m.name.split(" ")[0], m.streets, words);
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

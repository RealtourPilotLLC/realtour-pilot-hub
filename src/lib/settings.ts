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
/** Weekend / after-hours auto-reply to a client who texts in while we're shut. */
export type AfterHoursRule = {
  enabled: boolean;
  /** office hours quoted back to the client (ET, 24h) */
  openHour: number;
  closeHour: number;
  /** where they can self-serve in the meantime */
  portalUrl: string;
  /** never answer a text older than this (a cron catch-up must not reply to Friday's message on Monday) */
  maxAgeHours: number;
  /** the reply itself — {first} {hours} {nextDay} {portal} */
  message: string;
};

// The three fields added Sep 2 2026 (sendUntilMinute, weekdaysOnly, afterHours)
// are OPTIONAL on the stored shape on purpose: a row saved before they existed,
// and the settings form that predates them, both still type-check and simply
// fall back to the defaults below. What the sweeps actually read is
// ResolvedAutoTextRules, where every field is present and clamped.
export type AutoTextRules = {
  /** master switch — false stops every automated CLIENT text */
  enabled: boolean;
  /** earliest ET hour a client text may go out (0-23) */
  sendFromHour: number;
  /** exclusive ET hour after which nothing sends; it waits for the morning */
  sendUntilHour: number;
  /** minutes past sendUntilHour the window really shuts (Jordan: 4:30 PM) */
  sendUntilMinute?: number;
  /** client texts Monday-Friday only. TEAM texts are NOT governed by this. */
  weekdaysOnly?: boolean;
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
  afterHours?: AfterHoursRule;
  /** never auto-text a client who has an unanswered question in the queue */
  skipWhenClientWaiting: boolean;
  /** at most one automated text per client per cron tick */
  onePerClientPerRun: boolean;
};

/** What autoTextRules() hands the sweeps: nothing optional, everything clamped. */
export type ResolvedAutoTextRules = Omit<AutoTextRules, "sendUntilMinute" | "weekdaysOnly" | "afterHours"> & {
  sendUntilMinute: number;
  weekdaysOnly: boolean;
  afterHours: AfterHoursRule;
};

// The post-delivery text is now a FEEDBACK ASK, not a delivery announcement
// (Jordan, Sep 2 2026: "less of a delivery text and more of a text just asking
// for feedback. I want to make sure everything went well at the shoot. The
// feedback form link should be sent and explain that this helps us make sure
// they are getting a good client experience and continuously improving their
// experience"). It only goes out once the WHOLE job has landed — see the gate
// in lib/clientTextSweeps sweepDeliveryTexts.
//
// This is the built-in wording. The owner-editable version is Settings → Text
// templates → "Delivery text" (TextTemplates.deliveryAll below): anything typed
// there wins, so the copy can change without a deploy. Placeholders: {first},
// {street}, {feedbackUrl}. Jordan's voice — no em dashes, no emojis.
export const DEFAULT_DELIVERY_FEEDBACK_TEXT =
  "Hi {first}! Now that {street} is wrapped up, how did everything go? The shoot, the turnaround, the content. Quick feedback here helps us make sure you are getting a great experience and keep making it better: {feedbackUrl} If anything is not right, just reply and we will jump on it.";

// The weekend / after-hours auto-reply (Jordan, Sep 2 2026). Says the hours,
// promises the next working morning, and points at the portal so an agent who
// needs something at 9pm on a Saturday is not stuck waiting on us.
export const DEFAULT_AFTER_HOURS_REPLY =
  "Hi {first}, thanks for reaching out! Our office hours are {hours}, so we will get back to you first thing {nextDay}. In the meantime you can log in at {portal} to place an order, reschedule an appointment, and grab your content and invoices.";

export const DEFAULT_AUTO_TEXTS: ResolvedAutoTextRules = {
  enabled: true,
  sendFromHour: 9,
  // Jordan, Sep 2 2026: "All client texts Mon-Fri… Never send texts after
  // 4:30 PM to clients. Team texts can still go out on weekends." Anything due
  // outside this queues to the next working morning; nothing is dropped.
  sendUntilHour: 16,
  sendUntilMinute: 30,
  weekdaysOnly: true,
  confirmation: { enabled: true, hoursBefore: 48 },
  delivery: { enabled: true, maxTaskAgeHours: 72, requireMonthlyBatch: true },
  afterHours: {
    enabled: true,
    openHour: 9,
    closeHour: 18, // Mon-Fri 9-6 — the OFFICE hours, wider than the send window above
    portalUrl: "media.realtourpilot.com",
    maxAgeHours: 12,
    message: DEFAULT_AFTER_HOURS_REPLY,
  },
  skipWhenClientWaiting: true,
  onePerClientPerRun: true,
};

// ---- Review Room ------------------------------------------------------------
// Cuts reach the room by UPLOAD through the editor portal (Jordan, Sep 1:
// "going off what's in Dropbox can get messy"). Folder discovery — minting a
// review row for every video file that appears in 05-Final-Video — stays as
// an opt-in fallback, off by default.
export type ReviewRoomRules = {
  /** mint review rows from files found in the job's Dropbox Final folder */
  discoverFromDropbox: boolean;
  /** days an approved cut's upload is kept in the hub store after it was copied to Dropbox */
  keepUploadsDays: number;
};
// 90 days: the client portal shows the current and previous month's cuts.
export const DEFAULT_REVIEW_ROOM: ReviewRoomRules = { discoverFromDropbox: false, keepUploadsDays: 90 };
export async function reviewRoomRules(): Promise<ReviewRoomRules> {
  const r = await getSetting<ReviewRoomRules>("review_room", DEFAULT_REVIEW_ROOM);
  return {
    discoverFromDropbox: r.discoverFromDropbox === true,
    keepUploadsDays:
      typeof r.keepUploadsDays === "number" && r.keepUploadsDays >= 1 && r.keepUploadsDays <= 365
        ? Math.floor(r.keepUploadsDays)
        : DEFAULT_REVIEW_ROOM.keepUploadsDays,
  };
}

export async function autoTextRules(): Promise<ResolvedAutoTextRules> {
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
  const d = DEFAULT_AUTO_TEXTS.afterHours;
  // Office hours quoted to clients. Same inverted-window rule as the send
  // window: an unusable pair falls back to BOTH defaults rather than to a state
  // where the office reads as never open (and every text as after-hours).
  const rawOpen = hour(r.afterHours?.openHour, d.openHour);
  const rawClose = hour(r.afterHours?.closeHour, d.closeHour);
  const officeOk = rawClose > rawOpen;
  return {
    enabled: r.enabled !== false,
    sendFromHour: from,
    sendUntilHour: until,
    sendUntilMinute:
      typeof r.sendUntilMinute === "number" && Number.isInteger(r.sendUntilMinute) && r.sendUntilMinute >= 0 && r.sendUntilMinute <= 59
        ? r.sendUntilMinute
        : DEFAULT_AUTO_TEXTS.sendUntilMinute,
    weekdaysOnly: r.weekdaysOnly !== false,
    afterHours: {
      enabled: r.afterHours?.enabled !== false,
      openHour: officeOk ? rawOpen : d.openHour,
      closeHour: officeOk ? rawClose : d.closeHour,
      // A blank/rubbish URL would send a client to nowhere — fall back rather
      // than text out a broken link. Stored bare (no scheme) so it reads as a
      // place to go, not a tracking link.
      portalUrl:
        typeof r.afterHours?.portalUrl === "string" && /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(r.afterHours.portalUrl.trim())
          ? r.afterHours.portalUrl.trim().replace(/^https?:\/\//i, "").slice(0, 120)
          : d.portalUrl,
      maxAgeHours:
        typeof r.afterHours?.maxAgeHours === "number" && r.afterHours.maxAgeHours > 0 && r.afterHours.maxAgeHours <= 72
          ? r.afterHours.maxAgeHours
          : d.maxAgeHours,
      // An empty box means "use the built-in wording" — a blank template can
      // never send a blank text (same rule as textTemplates below).
      message: typeof r.afterHours?.message === "string" && r.afterHours.message.trim() ? r.afterHours.message.slice(0, 1000) : d.message,
    },
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

// ---------------------------------------------------------------------------
// TURNAROUND PROMISES + INTERNAL ALERTS + TEXT TEMPLATES (Jordan, Sep 1 2026:
// "I want settings for turnaround promises, alert thresholds, anything
// currently hard coded"). Each group reads through getSetting with the old
// hard-coded values as defaults, so nothing changes until Jordan edits it —
// and a corrupt row falls back rather than breaking delivery promises.
// ---------------------------------------------------------------------------

export type TurnaroundRules = {
  /** hours from the shoot, per deliverable category */
  photos: number;
  drone: number;
  twilight: number;
  floorPlan: number;
  tour3d: number;
  headshot: number;
  virtualStaging: number;
  /** reels/video tiers */
  standardVideoHours: number;
  premiumVideoHours: number;
  /** monthly content is measured in BUSINESS days, not hours */
  monthlyBusinessDays: number;
  /** everything unmapped */
  otherHours: number;
};

export const DEFAULT_TURNAROUNDS: TurnaroundRules = {
  photos: 20, // next morning
  drone: 20,
  twilight: 20,
  floorPlan: 36,
  tour3d: 36,
  headshot: 24,
  virtualStaging: 48,
  standardVideoHours: 48,
  premiumVideoHours: 72,
  monthlyBusinessDays: 10,
  otherHours: 48,
};

export async function turnaroundRules(): Promise<TurnaroundRules> {
  const r = await getSetting<TurnaroundRules>("turnarounds", DEFAULT_TURNAROUNDS);
  const num = (v: unknown, fallback: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : fallback;
  return {
    photos: num(r.photos, DEFAULT_TURNAROUNDS.photos, 720),
    drone: num(r.drone, DEFAULT_TURNAROUNDS.drone, 720),
    twilight: num(r.twilight, DEFAULT_TURNAROUNDS.twilight, 720),
    floorPlan: num(r.floorPlan, DEFAULT_TURNAROUNDS.floorPlan, 720),
    tour3d: num(r.tour3d, DEFAULT_TURNAROUNDS.tour3d, 720),
    headshot: num(r.headshot, DEFAULT_TURNAROUNDS.headshot, 720),
    virtualStaging: num(r.virtualStaging, DEFAULT_TURNAROUNDS.virtualStaging, 720),
    standardVideoHours: num(r.standardVideoHours, DEFAULT_TURNAROUNDS.standardVideoHours, 720),
    premiumVideoHours: num(r.premiumVideoHours, DEFAULT_TURNAROUNDS.premiumVideoHours, 720),
    monthlyBusinessDays: num(r.monthlyBusinessDays, DEFAULT_TURNAROUNDS.monthlyBusinessDays, 60),
    otherHours: num(r.otherHours, DEFAULT_TURNAROUNDS.otherHours, 720),
  };
}

export type InternalAlertRules = {
  uploadReminder: { enabled: boolean; hour: number };   // "did you submit the upload page?"
  uploadChaser: { enabled: boolean; hour: number };     // second nudge, later that night
  photosUndelivered: {
    enabled: boolean;
    fromHour: number;
    toHour: number;
    /** how long after the shoot photos count as late */
    lateAfterHours: number;
  };
  rawVideoMissing: { enabled: boolean };
  kyleDigests: { enabled: boolean };
};

export const DEFAULT_INTERNAL_ALERTS: InternalAlertRules = {
  uploadReminder: { enabled: true, hour: 19 },
  uploadChaser: { enabled: true, hour: 22 },
  photosUndelivered: { enabled: true, fromHour: 16, toHour: 19, lateAfterHours: 26 },
  rawVideoMissing: { enabled: true },
  kyleDigests: { enabled: true },
};

export async function internalAlertRules(): Promise<InternalAlertRules> {
  const r = await getSetting<InternalAlertRules>("internal_alerts", DEFAULT_INTERNAL_ALERTS);
  const hr = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  const d = DEFAULT_INTERNAL_ALERTS;
  const from = hr(r.photosUndelivered?.fromHour, d.photosUndelivered.fromHour);
  const to = hr(r.photosUndelivered?.toHour, d.photosUndelivered.toHour);
  const windowOk = to > from;
  return {
    uploadReminder: { enabled: r.uploadReminder?.enabled !== false, hour: hr(r.uploadReminder?.hour, d.uploadReminder.hour) },
    uploadChaser: { enabled: r.uploadChaser?.enabled !== false, hour: hr(r.uploadChaser?.hour, d.uploadChaser.hour) },
    photosUndelivered: {
      enabled: r.photosUndelivered?.enabled !== false,
      fromHour: windowOk ? from : d.photosUndelivered.fromHour,
      toHour: windowOk ? to : d.photosUndelivered.toHour,
      lateAfterHours:
        typeof r.photosUndelivered?.lateAfterHours === "number" && r.photosUndelivered.lateAfterHours > 0 && r.photosUndelivered.lateAfterHours <= 336
          ? r.photosUndelivered.lateAfterHours
          : d.photosUndelivered.lateAfterHours,
    },
    rawVideoMissing: { enabled: r.rawVideoMissing?.enabled !== false },
    kyleDigests: { enabled: r.kyleDigests?.enabled !== false },
  };
}

// Client text wording. Placeholders are substituted by lib/delivery — an empty
// string means "use the built-in wording", so a blank box can never send a
// blank text.
export type TextTemplates = { confirmation: string; deliveryAll: string; deliveryPartial: string };
export const DEFAULT_TEMPLATES: TextTemplates = { confirmation: "", deliveryAll: "", deliveryPartial: "" };
export const TEMPLATE_PLACEHOLDERS = ["{first}", "{street}", "{when}", "{items}", "{delivered}", "{remaining}", "{feedbackUrl}"];

export async function textTemplates(): Promise<TextTemplates> {
  const t = await getSetting<TextTemplates>("text_templates", DEFAULT_TEMPLATES);
  const clean = (v: unknown) => (typeof v === "string" ? v.slice(0, 1000) : "");
  return { confirmation: clean(t.confirmation), deliveryAll: clean(t.deliveryAll), deliveryPartial: clean(t.deliveryPartial) };
}

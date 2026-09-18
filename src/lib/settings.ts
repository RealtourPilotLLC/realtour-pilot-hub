import "server-only";
import { prisma } from "@/lib/prisma";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
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

/** The welcome text a brand-new client gets when their first shoot is booked. */
export type WelcomeTextRule = {
  enabled: boolean;
  /** the booking link the text offers — editable so Jordan can move it without a deploy */
  strategyCallUrl: string;
  /** the message itself — {first} {strategyCallLink} {website} {portal} */
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
  /** the new-client welcome text (Jordan, Sep 7 2026). Optional on the stored
   *  shape for the same reason as the three fields above: a settings row saved
   *  before it existed must keep loading, and it simply falls back to the
   *  default below. */
  welcome?: WelcomeTextRule;
  /** never auto-text a client who has an unanswered question in the queue */
  skipWhenClientWaiting: boolean;
  /** at most one automated text per client per cron tick */
  onePerClientPerRun: boolean;
};

/** What autoTextRules() hands the sweeps: nothing optional, everything clamped. */
export type ResolvedAutoTextRules = Omit<AutoTextRules, "sendUntilMinute" | "weekdaysOnly" | "afterHours" | "welcome"> & {
  sendUntilMinute: number;
  weekdaysOnly: boolean;
  afterHours: AfterHoursRule;
  welcome: WelcomeTextRule;
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

// THE WELCOME TEXT (Jordan, Sep 7 2026, near enough verbatim): "Hey, first
// name, welcome to Realtour Pilot. We're excited to work with you and get to
// know you. Just wanted to let you know that if you ever need anything, you can
// always call and text or call us here. You can also schedule a free strategy
// call here anytime: [Strategy call link]… and maybe including our website for
// general."
//
// Placeholders: {first} {strategyCallLink} {website} {portal}. An empty box in
// Settings falls back to this wording, so the text can never send blank.
export const DEFAULT_WELCOME_TEXT =
  // Jordan, Sep 7: "The welcome text should mention the portal - they can access
  // their account there, view invoices, content, and place orders, and reschedule."
  "Hey {first}, welcome to RealTour Pilot! We're excited to work with you and get to know you. If you ever need anything you can call or text us right here. Your client portal is {portal}: that's your account, where you can see invoices and your content, place orders and reschedule. You can also book a free strategy call any time: {strategyCallLink}. Everything about what we do is at {website}.";

// Where the free strategy call is booked. The default is the one live event
// type (lib/integrations/calendly is the source of truth); it is stored on the
// settings row so Jordan can move the link without a deploy and so the Settings
// preview can render the real thing.
export const DEFAULT_WELCOME: WelcomeTextRule = {
  enabled: true,
  strategyCallUrl: STRATEGY_CALL_BOOKING_URL,
  message: DEFAULT_WELCOME_TEXT,
};

/** The public site, quoted in the welcome text as {website}. */
export const PUBLIC_WEBSITE = "realtourpilot.com";
/** The client portal, quoted in the welcome text as {portal}. */
export const PUBLIC_PORTAL = "media.realtourpilot.com";

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
  welcome: DEFAULT_WELCOME,
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
    welcome: {
      enabled: r.welcome?.enabled !== false,
      // A booking link is the POINT of this text, so a blank or malformed one
      // falls back to the live Calendly event rather than sending a client a
      // sentence that offers a call and then names nowhere to book it.
      strategyCallUrl:
        typeof r.welcome?.strategyCallUrl === "string" && /^https?:\/\/[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(r.welcome.strategyCallUrl.trim())
          ? r.welcome.strategyCallUrl.trim().slice(0, 300)
          : DEFAULT_WELCOME.strategyCallUrl,
      // Empty box = the built-in wording (same rule as afterHours above).
      message:
        typeof r.welcome?.message === "string" && r.welcome.message.trim()
          ? r.welcome.message.slice(0, 1000)
          : DEFAULT_WELCOME.message,
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
  /**
   * WHEN SOMEBODY IS ACTUALLY THERE (audit WF-06, Sep 18 2026).
   *
   * Jordan: "Normal coverage is Monday-Friday, 9 AM-6 PM Eastern. Continue
   * capturing messages outside those hours, but queue routine alerts for the
   * next covered period. Urgent coverage should use an explicitly assigned
   * person, not assumed weekend availability."
   *
   * Measured before this shipped: 47 of the 196 reply-SLA pages in the last 90
   * days landed on a Saturday or Sunday, and 8 of 20 photos-undelivered alerts
   * did too — those text Jordan and Kyle. Nothing decided WHO was on; the code
   * paged whoever held the ADMIN or OWNER role and assumed they were available.
   *
   * onCallTeamMemberId is deliberately NULLABLE and deliberately fail-SAFE:
   * with nobody named, an urgent alert behaves exactly as it does today rather
   * than being held. Silence is the one outcome an urgent alert must never
   * have, so an unset rota degrades to the old behaviour and the settings page
   * says so.
   */
  coverage: {
    /** Mon-Fri only. Turning this off returns to the old every-day behaviour. */
    weekdaysOnly: boolean;
    fromHour: number; // 9  — inclusive
    toHour: number;   // 18 — exclusive
    /** Who answers an URGENT alert outside covered hours. Null = nobody named. */
    onCallTeamMemberId: string | null;
  };
};

export const DEFAULT_INTERNAL_ALERTS: InternalAlertRules = {
  uploadReminder: { enabled: true, hour: 19 },
  uploadChaser: { enabled: true, hour: 22 },
  photosUndelivered: { enabled: true, fromHour: 16, toHour: 19, lateAfterHours: 26 },
  rawVideoMissing: { enabled: true },
  kyleDigests: { enabled: true },
  coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null },
};

export async function internalAlertRules(): Promise<InternalAlertRules> {
  const r = await getSetting<InternalAlertRules>("internal_alerts", DEFAULT_INTERNAL_ALERTS);
  const hr = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  const d = DEFAULT_INTERNAL_ALERTS;
  const from = hr(r.photosUndelivered?.fromHour, d.photosUndelivered.fromHour);
  const to = hr(r.photosUndelivered?.toHour, d.photosUndelivered.toHour);
  const windowOk = to > from;
  // The stored row predates `coverage`, so getSetting's spread leaves it as the
  // default object; these guards stop a hand-edited row producing an empty or
  // inverted window, which would page nobody at all.
  const covFrom = hr(r.coverage?.fromHour, d.coverage.fromHour);
  const covTo = hr(r.coverage?.toHour, d.coverage.toHour);
  const coverage = {
    weekdaysOnly: typeof r.coverage?.weekdaysOnly === "boolean" ? r.coverage.weekdaysOnly : d.coverage.weekdaysOnly,
    fromHour: covTo > covFrom ? covFrom : d.coverage.fromHour,
    toHour: covTo > covFrom ? covTo : d.coverage.toHour,
    onCallTeamMemberId: typeof r.coverage?.onCallTeamMemberId === "string" && r.coverage.onCallTeamMemberId ? r.coverage.onCallTeamMemberId : null,
  };
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
    coverage,
  };
}

// Client text wording. Placeholders are substituted by lib/delivery — an empty
// string means "use the built-in wording", so a blank box can never send a
// blank text.
export type TextTemplates = { confirmation: string; deliveryAll: string; deliveryPartial: string };
export const DEFAULT_TEMPLATES: TextTemplates = { confirmation: "", deliveryAll: "", deliveryPartial: "" };
export { BUILTIN_TEMPLATE_TEXT } from "@/lib/textTemplateDefaults";
export const TEMPLATE_PLACEHOLDERS = ["{first}", "{street}", "{when}", "{items}", "{delivered}", "{remaining}", "{feedbackUrl}"];

export async function textTemplates(): Promise<TextTemplates> {
  const t = await getSetting<TextTemplates>("text_templates", DEFAULT_TEMPLATES);
  const clean = (v: unknown) => (typeof v === "string" ? v.slice(0, 1000) : "");
  return { confirmation: clean(t.confirmation), deliveryAll: clean(t.deliveryAll), deliveryPartial: clean(t.deliveryPartial) };
}

// ---------------------------------------------------------------------------
// TOPAZ VIDEO AI — the 1080p pass on every approved cut.
//
// Jordan (Sep 16): "Once the video cut is approved, it runs through the Topaz
// Video AI API, applies a preset, and exports it at 1080p to the Dropbox
// folder… I want all videos to be ran through topaz when uploaded and approved
// in ops hub."
//
// EVERY number below is editable on /settings, and that is not a nicety. The
// desktop-slider → API-parameter mapping is NOT DOCUMENTED ANYWHERE — Topaz's
// own docs agent was asked directly and said so. The defaults here are our best
// reading of Jordan's desktop preset; the first real render gets compared
// against his desktop export and tuned, and tuning must never need a deploy.
//
// The spend guards are the safety-critical part: auto top-up is ON with a $100/
// month cap, so a bug here BILLS HIM rather than erroring. See the worst-case
// arithmetic on DEFAULT_TOPAZ below.
// ---------------------------------------------------------------------------

/** Proteus ("prob-4") parameters, with Topaz's documented ranges. */
export type TopazProteusParams = {
  video_type: "Progressive" | "Interlaced" | "ProgressiveInterlaced";
  /** Desktop offers Dynamic/Manual; the API offers Auto/Manual/Relative — see
   *  the note on DEFAULT_TOPAZ_PARAMS for why we send "Auto". */
  auto: "Auto" | "Manual" | "Relative";
  field_order: "TopFirst" | "BottomFirst" | "Auto";
  focus_fix_level: "None" | "Normal" | "Strong";
  /** −1..1 each */
  compression: number;
  details: number;
  noise: number;
  halo: number;
  preblur: number;
  blur: number;
  /** 0..0.1 */
  prenoise: number;
  /** 0..0.1 */
  grain: number;
  /** 0..1 */
  grain_sigma: number;
  /** 0..5 */
  grain_size: number;
  grain_type: "silver_rich" | "gaussian" | "grey";
  /** 0..1 */
  recover_original_detail_value: number;
};

export type TopazSettings = {
  /** Master switch. OFF until Jordan has compared a first render against his
   *  own desktop export — nothing is ever queued while this is false. */
  enabled: boolean;
  /** Which approved cuts get a pass. Jordan said "all videos"; both video
   *  deliverable types are on by default. */
  deliverableTypes: string[];

  // ---- output ------------------------------------------------------------
  /** "1080p" = the SHORT side is 1080, orientation and aspect preserved. A
   *  vertical 1080×1920 reel stays 1080×1920; the 3840×2160 cuts in the store
   *  come out 1920×1080. Jordan: "I want it to be 1080p though which works
   *  best on Social Media." */
  outputShortSide: number;
  /** Leave a source whose short side is already under 1080 at its own size
   *  instead of upscaling it. Default false: upscaling to 1080 is exactly what
   *  Proteus is for, and 1080p is what he asked for. */
  neverUpscale: boolean;
  /** Passed through to Topaz's output block. Unconfirmed enum values — the
   *  docs do not list them — so they are strings Jordan can correct without a
   *  deploy if Topaz rejects them. */
  audioCodec: string;
  audioTransfer: string;
  container: string;
  /** H264 · H265 · AV1 · VP9 · ProRes. See DEFAULT_TOPAZ for why this is H264
   *  and must stay H264 unless somebody has checked the whole chain. */
  videoEncoder: string;
  /** Profile for the chosen encoder — "High" for H264. */
  videoProfile: string;
  /** Constant bitrate, e.g. "12m". Topaz treats this as MUTUALLY EXCLUSIVE with
   *  dynamicCompressionLevel, so setting this switches the other off. Empty
   *  string = let dynamicCompressionLevel decide (not recommended: see below). */
  videoBitrate: string;
  /** Topaz's automatic quality picker: Low · Mid · High. Only consulted when
   *  videoBitrate is empty. */
  dynamicCompressionLevel: string;

  // ---- SPEND GUARDS (every one enforced server-side, in topazJobs.ts) -----
  /** Refuse any single video whose free pre-flight estimate exceeds this. */
  maxCreditsPerVideo: number;
  /** Refuse to ACCEPT another job once this many were accepted today (ET). */
  maxRendersPerDay: number;
  /** …or this many this calendar month (ET). */
  maxRendersPerMonth: number;
  /** …or once this many ESTIMATED credits were committed this month. This is
   *  the cap that actually bounds the bill; the render counts above are a
   *  second, coarser fence. */
  maxCreditsPerMonth: number;
  /** Stop the lane and tell somebody when the balance falls under this. */
  minBalanceCredits: number;
  /** Never more than this many renders in Topaz's hands at once (his plan
   *  allows 8; we leave headroom for a desktop render he starts himself). */
  maxConcurrent: number;
  /** Topaz refuses a request over 500 MB with a 413. Measured sources run
   *  76–465 MB, so some real cuts sit close to the ceiling. */
  maxSourceMB: number;
  /** Consecutive failures of one step before the job stops and tells someone.
   *  A permanently failing job must never spin — spinning costs money. */
  maxAttempts: number;

  params: TopazProteusParams;
};

// ---------------------------------------------------------------------------
// JORDAN'S DESKTOP PRESET, AS FAR AS ANYONE CAN KNOW IT.
//
// From his screenshots: output 1080×1920 (Original), Progressive, model
// Proteus, mode "Dynamic", "Enable parameters" ticked, focus fix Off, grain
// unticked, frame interpolation OFF (30 FPS original), SDR-to-HDR off,
// stabilization off, motion deblur off. Sliders:
//   Add noise 0 · Recover detail 20 · Fix compression 50 · Improve detail 45
//   Sharpen 37 · Reduce noise 70 · Dehalo 16 · Anti-alias/deblur 0
//
// ⚠️ THE MAPPING IS UNCONFIRMED. Topaz documents neither which API parameter
// each desktop slider drives, nor how its 0–100 scale becomes the API's −1..1,
// nor what desktop "Dynamic" means against the API's Auto/Manual/Relative.
// Their own docs agent was asked and confirmed all three are absent from the
// documentation. What is below is the straight reading — slider/100 onto the
// positive half of each −1..1 range — and it is a STARTING POINT to be tuned
// against a desktop export, not a fact.
//
// `auto` is the genuinely ambiguous one. Desktop "Dynamic" with "Enable
// parameters" ticked means: use my slider values, and let the model vary its
// strength across the clip rather than applying one fixed amount. Of the three
// API words, "Auto" is the only one that can mean "let the model decide the
// per-frame amount"; "Manual" reads as the fixed-amount opposite and
// "Relative" has no desktop counterpart at all. So we send "Auto" WITH the
// explicit parameters — which is what "Dynamic + Enable parameters" looks
// like. If the first render comes back stronger or weaker than his desktop
// export, this is the first field to try changing, and it is a dropdown on
// /settings precisely for that.
export const DEFAULT_TOPAZ_PARAMS: TopazProteusParams = {
  video_type: "Progressive", // desktop: Video type = Progressive
  auto: "Auto", // desktop "Dynamic" — see the paragraph above
  field_order: "Auto", // irrelevant for progressive footage
  focus_fix_level: "None", // desktop: Focus fix Off
  compression: 0.5, // Fix compression 50
  details: 0.45, // Improve detail 45
  blur: 0.37, // Sharpen 37
  noise: 0.7, // Reduce noise 70
  halo: 0.16, // Dehalo 16
  preblur: 0.0, // Anti-alias / deblur 0
  prenoise: 0.0, // Add noise 0
  recover_original_detail_value: 0.2, // Recover detail 20
  grain: 0, // desktop: grain unticked
  grain_sigma: 0,
  grain_size: 0,
  grain_type: "gaussian", // inert while grain is 0
};

// ---------------------------------------------------------------------------
// WORST-CASE MONTHLY SPEND, checked against Jordan's $100/month top-up cap.
//
// Measured inputs: Topaz "Pro" is $35/mo for 400 video credits → $0.0875 per
// included credit, and top-ups are described as discounted, so $0.0875 is a
// conservative (high) per-credit price for anything over the allowance. Proteus
// at 1080p costs ~8 credits per minute; his cuts measure 49–60 seconds, so a
// real render is ~8 credits. He finishes ~49 videos a month (recent months 68,
// 47, 39), so the honest expectation is ~400–550 credits a month: the allowance
// plus a small top-up, by design, not by error.
//
// The binding guard is maxCreditsPerMonth, because it is the only one denominated
// in the thing that costs money. At 900:
//   900 credits − 400 included = 500 topped up × $0.0875 ≈ $44/month.
//   Plus the $35 plan = ~$79. Under the $100 cap, with room to spare.
// And 900 credits ÷ 8 ≈ 112 renders, comfortably above his 68-video peak month,
// so the cap bounds the bill without ever standing in the way of real work.
//
// If EVERY guard fired wrongly at once — every estimate came back at the 20-credit
// ceiling and both render counts let them through — the month still stops at 900
// credits (~$79), because the credit cap is checked against the recorded ledger
// before each accept and is independent of the render counters. The one thing
// that could beat it is Topaz charging far more than it estimated; that is why
// creditsCharged is recorded per job and the balance is re-read before every
// accept, so an estimate that lies shows up as a falling balance within one job
// rather than at the end of the month.
//
// The counts: 15/day × 20 credits = 300 credits in a single bad day, which the
// month cap absorbs three times over before it stops the lane.
//
// WHAT THE SEP 16 REVIEW CHANGED ABOUT THIS ARITHMETIC. Two ways existed to get
// out from under the credit cap entirely, and both are now closed, because a
// cap the code can walk around is not a cap:
//   · a job whose price Topaz never gave us counted as ZERO credits forever
//     (the cap sums estimateCredits), so only the render COUNTS still applied —
//     90 unmetered long-form renders would have been ~6,800 credits, ~$600.
//     A job with no readable price is now refused at the accept and sent back
//     to the free price check; it can never be accepted without a number.
//   · "Try again" resumed straight to the accept, skipping both the free
//     estimate and the per-video ceiling. It now restarts anything that has not
//     been paid for from the very beginning, so every guard runs again.
// The residual, written down rather than papered over: the one call that starts
// a render may be made up to maxAttempts (3) times for a single job if Topaz
// keeps answering that it is still waiting for the file. If it were charging
// for each of those while saying that, one job could cost 3 × its estimate
// while the ledger counts it once — 3 × 20 = 60 credits (~$5) in the worst
// single case, and the falling balance would show it inside one job.

export const DEFAULT_TOPAZ: TopazSettings = {
  enabled: false, // Jordan turns it on after he has compared one render
  deliverableTypes: ["VIDEO", "SOCIAL_REEL"],
  outputShortSide: 1080,
  neverUpscale: false,
  audioCodec: "aac",
  audioTransfer: "Copy",
  container: "mp4",
  // H264/High, EXPLICITLY. Measured on the first real render (Sep 16): with no
  // encoder named, Topaz returned VP9 — which their own table says is only ever
  // wrapped in mp4, and VP9-in-mp4 is exactly the file Aryeo and Zillow
  // Showcase are most likely to refuse and QuickTime cannot open at all. Their
  // documented default is H265, which is better but still not what a listing
  // portal or a social platform reliably accepts. H264 High is the one every
  // one of them takes. Do not change this without checking Aryeo, Showcase and
  // the social targets end to end.
  videoEncoder: "H264",
  videoProfile: "High",
  // 12 Mbit at 1080p. The same first render came back at 1.06 Mbit — a 60 Mbit
  // 4K master run through detail recovery and then crushed to a tenth of what
  // 1080p delivery needs, which undoes the entire point of the pass and costs
  // credits to do it. An explicit bitrate is the only way to be sure: Topaz's
  // automatic picker chose that 1.06, and its scale is not documented anywhere.
  videoBitrate: "12m",
  // Only consulted if videoBitrate is cleared. Kept so the choice stays visible.
  dynamicCompressionLevel: "Low",
  maxCreditsPerVideo: 20, // ≈2.5 min at 1080p; a 10-minute walkthrough should be a decision, not an accident
  maxRendersPerDay: 15,
  maxRendersPerMonth: 90,
  maxCreditsPerMonth: 900, // the cap that bounds the bill — see the arithmetic above
  minBalanceCredits: 40, // ~5 videos of headroom before the lane stops and says so
  maxConcurrent: 6, // his plan allows 8; leave two for a desktop render of his own
  maxSourceMB: 500, // Topaz answers 413 over this
  maxAttempts: 3,
  params: DEFAULT_TOPAZ_PARAMS,
};

/** Read the Topaz rules, clamped. getSetting merges only the TOP level, so a
 *  stored partial `params` would otherwise replace the whole preset — every
 *  parameter is merged and range-checked individually here. A bad save can
 *  never put an out-of-range number in front of a paid API. */
export async function topazSettings(): Promise<TopazSettings> {
  const r = await getSetting<TopazSettings>("topaz", DEFAULT_TOPAZ);
  const d = DEFAULT_TOPAZ;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  const int = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  const str = <T extends string>(v: unknown, fallback: T, allowed: readonly T[]) =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const free = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() && v.length <= 40 ? v.trim() : fallback;
  const p = (r.params ?? {}) as Partial<TopazProteusParams>;
  const dp = d.params;
  return {
    enabled: r.enabled === true,
    deliverableTypes: Array.isArray(r.deliverableTypes)
      ? r.deliverableTypes.filter((t): t is string => typeof t === "string" && ["VIDEO", "SOCIAL_REEL"].includes(t))
      : d.deliverableTypes,
    outputShortSide: int(r.outputShortSide, d.outputShortSide, 240, 2160),
    neverUpscale: r.neverUpscale === true,
    audioCodec: free(r.audioCodec, d.audioCodec),
    audioTransfer: free(r.audioTransfer, d.audioTransfer),
    container: free(r.container, d.container),
    videoEncoder: str(r.videoEncoder, d.videoEncoder as "H264", ["AV1", "H264", "H265", "ProRes", "VP9"] as const),
    videoProfile: free(r.videoProfile, d.videoProfile),
    // An empty string is meaningful here (= use dynamicCompressionLevel), so it
    // cannot go through free(), which treats empty as "fall back to default".
    videoBitrate:
      typeof r.videoBitrate === "string" && (r.videoBitrate === "" || /^\d{1,5}(k|m)$/i.test(r.videoBitrate.trim()))
        ? r.videoBitrate.trim()
        : d.videoBitrate,
    dynamicCompressionLevel: free(r.dynamicCompressionLevel, d.dynamicCompressionLevel),
    maxCreditsPerVideo: num(r.maxCreditsPerVideo, d.maxCreditsPerVideo, 1, 400),
    maxRendersPerDay: int(r.maxRendersPerDay, d.maxRendersPerDay, 0, 200),
    maxRendersPerMonth: int(r.maxRendersPerMonth, d.maxRendersPerMonth, 0, 1000),
    maxCreditsPerMonth: num(r.maxCreditsPerMonth, d.maxCreditsPerMonth, 0, 4000),
    minBalanceCredits: num(r.minBalanceCredits, d.minBalanceCredits, 0, 2000),
    // Hard-clamped at Topaz's own plan limit: a settings save can lower this,
    // never raise it past what the plan allows.
    maxConcurrent: int(r.maxConcurrent, d.maxConcurrent, 1, 8),
    maxSourceMB: int(r.maxSourceMB, d.maxSourceMB, 1, 500),
    maxAttempts: int(r.maxAttempts, d.maxAttempts, 1, 10),
    params: {
      video_type: str(p.video_type, dp.video_type, ["Progressive", "Interlaced", "ProgressiveInterlaced"] as const),
      auto: str(p.auto, dp.auto, ["Auto", "Manual", "Relative"] as const),
      field_order: str(p.field_order, dp.field_order, ["TopFirst", "BottomFirst", "Auto"] as const),
      focus_fix_level: str(p.focus_fix_level, dp.focus_fix_level, ["None", "Normal", "Strong"] as const),
      compression: num(p.compression, dp.compression, -1, 1),
      details: num(p.details, dp.details, -1, 1),
      noise: num(p.noise, dp.noise, -1, 1),
      halo: num(p.halo, dp.halo, -1, 1),
      preblur: num(p.preblur, dp.preblur, -1, 1),
      blur: num(p.blur, dp.blur, -1, 1),
      prenoise: num(p.prenoise, dp.prenoise, 0, 0.1),
      grain: num(p.grain, dp.grain, 0, 0.1),
      grain_sigma: num(p.grain_sigma, dp.grain_sigma, 0, 1),
      grain_size: num(p.grain_size, dp.grain_size, 0, 5),
      grain_type: str(p.grain_type, dp.grain_type, ["silver_rich", "gaussian", "grey"] as const),
      recover_original_detail_value: num(p.recover_original_detail_value, dp.recover_original_detail_value, 0, 1),
    },
  };
}

/** Save the Topaz rules (the /settings page's writer). Re-read through
 *  topazSettings() so a caller can never observe an unclamped value. */
export async function saveTopazSettings(next: Partial<TopazSettings>, updatedBy?: string | null): Promise<TopazSettings> {
  const current = await topazSettings();
  await putSetting("topaz", { ...current, ...next, params: { ...current.params, ...(next.params ?? {}) } }, updatedBy);
  return topazSettings();
}

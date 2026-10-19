import "server-only";

import { getSetting, putSetting } from "@/lib/settings";

// ---------------------------------------------------------------------------
// THE LISTING-VIDEO SETTINGS (Oct 19 2026), separate from the photo ones.
//
// BUTTON ONLY (Jordan, Oct 19 2026, his words: upload to Aryeo happens ONLY
// when someone presses the button, "no automatic mode for now"). The hub
// uploads and delivers a listing video only when a person presses Upload to
// Aryeo and send in the Video Review Room (lib/videoAryeoPush). The stored
// switch `aryeoPush` (off / shadow / upload / deliver) is still read, so
// nothing that reads it breaks, but it starts nothing: "off" is the default
// and the live value, and no mode makes the cron pick up a video by itself.
// It is no longer on any screen. `cooldownMin` still spaces two deliveries of
// one listing. Monthly and personal-branding videos are never touched: they
// go to the client's portal (lib/monthlyFinal).
// ---------------------------------------------------------------------------

export type VideoPushMode = "off" | "shadow" | "upload" | "deliver";
export const VIDEO_PUSH_MODES: readonly VideoPushMode[] = ["off", "shadow", "upload", "deliver"];

export type VideoDeliverySettings = {
  aryeoPush: VideoPushMode;
  /** Minutes between two deliveries of one listing (one email, not three in a row). */
  cooldownMin: number;
};

export const DEFAULT_VIDEO_DELIVERY_SETTINGS: VideoDeliverySettings = { aryeoPush: "off", cooldownMin: 20 };

const KEY = "video_delivery:settings";

export async function videoDeliverySettings(): Promise<VideoDeliverySettings> {
  const raw = await getSetting<Partial<VideoDeliverySettings>>(KEY, {});
  const d = DEFAULT_VIDEO_DELIVERY_SETTINGS;
  return {
    aryeoPush: (VIDEO_PUSH_MODES as readonly string[]).includes(String(raw.aryeoPush)) ? (raw.aryeoPush as VideoPushMode) : d.aryeoPush,
    cooldownMin: typeof raw.cooldownMin === "number" && Number.isFinite(raw.cooldownMin) && raw.cooldownMin >= 0 && raw.cooldownMin <= 240 ? raw.cooldownMin : d.cooldownMin,
  };
}

export async function saveVideoDeliverySettings(next: Partial<VideoDeliverySettings>, by: string | null): Promise<VideoDeliverySettings> {
  const cur = await videoDeliverySettings();
  await putSetting(KEY, { ...cur, ...next }, by);
  return videoDeliverySettings();
}

/** What each stored mode meant (kept for old readers; no screen offers the switch since Oct 19). */
export const VIDEO_PUSH_MODE_WORDS: Record<VideoPushMode, { label: string; help: string }> = {
  off: { label: "Off", help: "Kyle uploads each approved video to Aryeo and delivers it by hand." },
  shadow: { label: "Practice run", help: "The hub writes down what it would send. Nothing reaches Aryeo." },
  upload: { label: "Upload only", help: "The hub puts each approved video on the Aryeo listing. Kyle presses Deliver now." },
  deliver: { label: "Upload and deliver", help: "The hub uploads each approved video and re-delivers the listing by itself." },
};

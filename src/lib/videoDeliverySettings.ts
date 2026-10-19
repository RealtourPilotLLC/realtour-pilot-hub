import "server-only";

import { getSetting, putSetting } from "@/lib/settings";

// ---------------------------------------------------------------------------
// THE LISTING-VIDEO SWITCH (Oct 19 2026), separate from the photo one.
//
// Jordan: "Any videos that get approved should be uploaded and delivered once
// approved and back from Topaz ... with the login retries and things like
// that." The Review Room approval IS the human approval for a listing video,
// so in `deliver` nobody presses anything else. Stored in AppSetting like the
// photo delivery settings, changed on the Video delivery screen (owner only).
//
//   off      nothing; Kyle uploads and delivers by hand (the default in code)
//   shadow   a practice run: each video that would go gets one line ("would
//            upload 113 MB to the listing, then re-deliver it") and nothing is
//            called: no Aryeo, no Uploadcare, no Dropbox
//   upload   the hub puts the video on the listing and stops; Kyle presses
//            Deliver now on the Video delivery screen
//   deliver  upload, then re-deliver the listing (Aryeo's own email), all by
//            itself
// Monthly and personal-branding videos are never touched: they go to the
// client's portal (lib/monthlyFinal).
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

/** What each mode means, in the screen's words. */
export const VIDEO_PUSH_MODE_WORDS: Record<VideoPushMode, { label: string; help: string }> = {
  off: { label: "Off", help: "Kyle uploads each approved video to Aryeo and delivers it by hand." },
  shadow: { label: "Practice run", help: "The hub writes down what it would send. Nothing reaches Aryeo." },
  upload: { label: "Upload only", help: "The hub puts each approved video on the Aryeo listing. Kyle presses Deliver now." },
  deliver: { label: "Upload and deliver", help: "The hub uploads each approved video and re-delivers the listing by itself." },
};

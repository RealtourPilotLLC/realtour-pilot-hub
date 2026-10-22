// ---------------------------------------------------------------------------
// THREE ONE-TAP STARTING POINTS for the 1080p preset (Jordan, Oct 22 2026).
//
// Each fills the mode and the seven sliders on Settings and nothing else; it
// saves nothing. They are STARTING POINTS TO TEST, not proven settings — the
// screen says so — and the way to prove one is the "Try these settings" test
// beside them, which runs the sliders on screen on a real approved video
// without filing anything anywhere.
//
//   gentle   for clean footage, which is what the editors send (every one of
//            the last 30 sources was clean 1080p H.264 at ~15 Mbit). Manual,
//            so the numbers are the numbers.
//   desktop  what has been running since Sep 16: our reading of Jordan's
//            desktop preset (DEFAULT_TOPAZ_PARAMS). Supplied by the caller,
//            because the defaults live in lib/settings (server-only).
//   strong   for dark or noisy footage. Manual.
//
// Pure: a client component imports it. Values are the API's -1..1 / 0..1
// scale; the panel shows them x100.
// ---------------------------------------------------------------------------
import type { TopazProteusParams } from "@/lib/settings";

export type TopazPresetKey = "gentle" | "desktop" | "strong";

/** The fields a starting point fills: the mode and the seven sliders. */
export type TopazPresetFill = Pick<
  TopazProteusParams,
  "auto" | "compression" | "details" | "blur" | "noise" | "halo" | "preblur" | "recover_original_detail_value"
>;

export const TOPAZ_STARTING_POINTS: { key: TopazPresetKey; label: string; hint: string }[] = [
  { key: "gentle", label: "Gentle (clean footage)", hint: "light touch, your numbers exactly" },
  { key: "desktop", label: "Your desktop preset", hint: "what has been running since Sep 16" },
  { key: "strong", label: "Strong (dark or noisy footage)", hint: "more clean-up, your numbers exactly" },
];

const GENTLE: TopazPresetFill = {
  auto: "Manual",
  compression: 0.15,
  details: 0.15,
  blur: 0.05, // Sharpen
  noise: 0.1,
  halo: 0.05,
  preblur: 0,
  recover_original_detail_value: 0.5,
};

const STRONG: TopazPresetFill = {
  auto: "Manual",
  compression: 0.5,
  details: 0.35,
  blur: 0.2, // Sharpen
  noise: 0.5,
  halo: 0.15,
  preblur: 0, // not part of the brief's Strong numbers; left at its default of 0
  recover_original_detail_value: 0.3,
};

/** The fill for one starting point. `desktop` is the caller's defaults. */
export function topazStartingPoint(key: TopazPresetKey, desktopDefaults: TopazProteusParams): TopazPresetFill {
  if (key === "gentle") return { ...GENTLE };
  if (key === "strong") return { ...STRONG };
  return {
    auto: desktopDefaults.auto,
    compression: desktopDefaults.compression,
    details: desktopDefaults.details,
    blur: desktopDefaults.blur,
    noise: desktopDefaults.noise,
    halo: desktopDefaults.halo,
    preblur: desktopDefaults.preblur,
    recover_original_detail_value: desktopDefaults.recover_original_detail_value,
  };
}

/** Which starting point (if any) the params on screen match exactly. */
export function matchingStartingPoint(p: TopazProteusParams, desktopDefaults: TopazProteusParams): TopazPresetKey | null {
  for (const { key } of TOPAZ_STARTING_POINTS) {
    const f = topazStartingPoint(key, desktopDefaults);
    const same = (Object.keys(f) as (keyof TopazPresetFill)[]).every((k) =>
      typeof f[k] === "number" ? Math.abs((p[k] as number) - (f[k] as number)) < 0.005 : p[k] === f[k],
    );
    if (same) return key;
  }
  return null;
}

/** The mode select, in honest words. Topaz's API reference (create-video-
 *  request, read Oct 22 2026): "Auto - parameter estimation is used with no
 *  customization · Relative - uses auto parameters with optional weights
 *  added · Manual - all parameters are manually set". */
export const TOPAZ_MODE_OPTIONS: [TopazProteusParams["auto"], string][] = [
  ["Auto", "Auto: Topaz picks its own amounts for each clip; your sliders are ignored"],
  ["Manual", "Manual: your sliders, exactly"],
  ["Relative", "Relative: Topaz picks its amounts, then your sliders nudge them"],
];

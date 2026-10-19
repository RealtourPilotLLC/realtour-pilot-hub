"use client";

import { useEffect } from "react";
import { forwardedHref } from "@/lib/homeAnchors";

// Links minted before Oct 19 2026 (Slack lines, bells, delivery receipts,
// other screens: "/#video-review", "/?test=1#loops") still point at Home, and
// the fragment never reaches the server, so the hop happens here: an anchor
// that now lives on /ops is replaced (not pushed) onto /ops with the same
// query and fragment, where DayBlockJumps opens the block it lands on.
export function HomeAnchorForward() {
  useEffect(() => {
    const go = () => {
      const to = forwardedHref(window.location.pathname, window.location.search, window.location.hash);
      if (to) window.location.replace(to);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  return null;
}

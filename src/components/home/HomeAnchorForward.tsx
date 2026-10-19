"use client";

import { useEffect } from "react";
import { forwardedHref } from "@/lib/homeAnchors";

// Links minted before Oct 19 2026 (Slack lines, bells, delivery receipts,
// other screens) still carry the old anchors, and the fragment never reaches
// the server, so the hop happens here (replaced, not pushed): "/#stuck" goes
// to /ops, where the stuck jobs and exceptions are; "/ops#loops" comes back to
// Home, where the checklist group that holds that work carries the anchor.
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

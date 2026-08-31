"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Keeps the Ops Day live (Jordan: the comms sweep "should update instantly") —
// re-pulls the server data every 45s while the tab is visible.
export function AutoRefresh({ seconds = 45 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

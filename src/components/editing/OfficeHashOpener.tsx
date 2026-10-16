"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// OFFICE LINKS STILL LAND (Oct 15 2026). The editor brief keeps the office's
// tools behind one switch (?office=1), off by default, so Jordan and Kyle see
// what the editor sees. Links written before the switch existed still point
// at those tools: the reviewer's "mark it not needed on the issue list"
// (#issues), the agency packet (#agency-packet), a reopened job's due date
// (#reopened-due), a video's brief form (#office-brief-<id>). Drawn only for
// a viewer who has the switch and has it off: arriving on one of those
// anchors turns the tools on, keeping the anchor. It reads the URL only; it
// starts, saves and sends nothing.
// ---------------------------------------------------------------------------

const OFFICE_ANCHORS = /^#(issues|agency-packet|reopened-due|office-brief-[A-Za-z0-9_-]+)$/;

export function OfficeHashOpener() {
  const router = useRouter();
  useEffect(() => {
    const open = () => {
      const { hash, pathname, search } = window.location;
      if (!OFFICE_ANCHORS.test(hash)) return;
      const q = new URLSearchParams(search);
      if (q.get("office") === "1") return;
      q.set("office", "1");
      router.replace(`${pathname}?${q.toString()}${hash}`);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [router]);
  return null;
}

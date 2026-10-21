"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// A FOLDED SECTION STILL OPENS ON ITS LINKS (Oct 21 2026). The job page folds
// "Where this job is", the status check and "Ordered deliverables" into one
// closed Details section. Links written before the fold still point inside it
// (a task's "/projects/<id>#deliverables", the Not required form's own
// redirect): arriving on one of those anchors opens the fold and scrolls to
// the anchor. Some browsers do that by themselves; this makes it every
// browser. It reads the URL only; it saves nothing.
// ---------------------------------------------------------------------------

export function DetailsHashOpener({ detailsId, anchors }: { detailsId: string; anchors: string[] }) {
  const list = anchors.join(",");
  useEffect(() => {
    const wanted = list.split(",");
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || !wanted.includes(id)) return;
      const fold = document.getElementById(detailsId);
      if (!(fold instanceof HTMLDetailsElement)) return;
      if (!fold.open) fold.open = true;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [detailsId, list]);
  return null;
}

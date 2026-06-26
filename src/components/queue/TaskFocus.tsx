"use client";

import { useEffect } from "react";

// Deep-link handler for /queue?task=<id>. Clicking a task in the morning brief
// lands here: open the task's collapsed group, scroll it into view, and flash a
// highlight. Uses a query param (not a #hash) on purpose — a hash makes the
// browser auto-expand the <details> before React hydrates, which trips a
// hydration mismatch. With a query param nothing changes pre-hydration.
export function TaskFocus() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("task");
    if (!id) return;
    const el = document.getElementById(`task-${id}`);
    if (!el) return;
    // Open every <details> ancestor so the task isn't hidden in a collapsed group.
    let node: HTMLElement | null = el;
    while (node) {
      if (node.tagName === "DETAILS") (node as HTMLDetailsElement).open = true;
      node = node.parentElement;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const ring = ["ring-2", "ring-brand", "ring-offset-2", "ring-offset-surface"];
    el.classList.add(...ring);
    const t = window.setTimeout(() => el.classList.remove(...ring), 2600);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}

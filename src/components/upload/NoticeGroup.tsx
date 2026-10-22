"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// COLLAPSIBLE NOTICES (Oct 21 2026). Jordan: "clean up the upload portal,
// make warnings collapsible with a summary line of it." The heads-ups at the
// top of the upload page (a half still owed, special requests, the customer's
// standing notes) fold into one card whose closed state is a single line
// saying what is inside. Opening it shows each notice exactly as
// before. Blocking errors and choices the page needs answered (a submit
// error, a copy saved on another device) are never folded.
// The open/closed choice is remembered per job on this device.
// ---------------------------------------------------------------------------

export type Notice = {
  key: string;
  tone: "danger" | "warning" | "info";
  /** A few words for the closed line, e.g. "2 special requests". */
  summary: string;
  body: ReactNode;
};

const RANK = { danger: 0, warning: 1, info: 2 } as const;

// The repo's storage pattern (PortalMigrationNotice): read through
// useSyncExternalStore, every access wrapped, closed on the server and
// wherever storage is blocked.
const EVENT = "rtp-upload-notices";
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVENT, cb); };
};

export function NoticeGroup({ storageKey, notices, title = "Heads-up" }: { storageKey: string; notices: Notice[]; title?: string }) {
  const stored = useSyncExternalStore(
    subscribe,
    () => { try { return window.localStorage.getItem(storageKey) === "open"; } catch { return false; } },
    () => false,
  );
  // This tab's own press wins, so the card still opens where storage is blocked.
  const [pressed, setPressed] = useState<boolean | null>(null);
  const open = pressed ?? stored;
  if (!notices.length) return null;

  const worst = notices.reduce((w, n) => (RANK[n.tone] < RANK[w] ? n.tone : w), "info" as Notice["tone"]);
  const toggle = () => {
    setPressed(!open);
    try { window.localStorage.setItem(storageKey, open ? "closed" : "open"); } catch { /* storage blocked: this tab still remembers */ }
    window.dispatchEvent(new Event(EVENT));
  };
  const Icon = worst === "info" ? Info : AlertTriangle;
  const summary = [...notices].sort((a, b) => RANK[a.tone] - RANK[b.tone]).map((n) => n.summary).join(" · ");

  return (
    <section
      className={cn(
        "rounded-2xl border",
        worst === "danger" ? "border-danger/40 bg-danger/5" : worst === "warning" ? "border-warning/40 bg-warning/5" : "border-border bg-surface",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Icon className={cn("size-4 shrink-0", worst === "danger" ? "text-danger" : worst === "warning" ? "text-warning" : "text-brand")} />
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">
            {title}{notices.length > 1 ? ` (${notices.length})` : ""}:
          </span>{" "}
          <span className={cn(open ? "text-muted" : "text-foreground/85")}>{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-2.5 px-4 pb-4">{notices.map((n) => <div key={n.key}>{n.body}</div>)}</div>}
    </section>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SaveState = "loaded" | "dirty" | "saving" | "saved" | "error" | "partial" | "info";
const words: Record<SaveState, string> = { loaded: "Loaded settings", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Save not confirmed", partial: "Partly saved", info: "" };

/** Presentation only: callers derive status from their actual receipt. Never
 * infer success from a click, elapsed time or a provider request starting. */
export function SaveStatus({ state, message, className }: { state: SaveState; message?: ReactNode; className?: string }) {
  return <span role={state === "error" ? "alert" : "status"} aria-live={state === "error" ? "assertive" : "polite"} aria-atomic="true"
    className={cn("text-sm leading-relaxed", state === "error" ? "text-danger" : state === "partial" ? "text-warning" : "text-muted", className)}>
    {words[state] && <span className="font-medium">{words[state]}</span>}
    {message && <>{words[state] ? ". " : ""}{message}</>}
  </span>;
}

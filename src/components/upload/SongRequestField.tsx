"use client";

import { Music } from "lucide-react";
import { cn } from "@/lib/utils";
import { songProblem, SONG_LIMITS, type SongRequest } from "@/lib/songRequest";

// ---------------------------------------------------------------------------
// One video's song request (Oct 23 2026, lib/songRequest). "No request" is a
// full answer; a requested song needs a title (artist welcome) or a link, not
// both; the start time or section is optional. A song already on file for the
// video (the client asked for one by text, the office picked a track) is shown
// above, so nobody asks for it twice.
// ---------------------------------------------------------------------------

export function SongRequestField({
  id,
  value,
  onChange,
  existing = [],
  videoName = "this video",
}: {
  id: string;
  value: SongRequest;
  onChange: (next: SongRequest) => void;
  /** songs already recorded for this video elsewhere (read-only) */
  existing?: string[];
  videoName?: string;
}) {
  const requested = value.mode === "requested";
  const problem = songProblem(value, videoName);
  const input = "mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base outline-none focus:border-brand sm:text-sm";
  return (
    <div data-song-request={id} className="rounded-xl border border-border bg-surface-2/30 p-3">
      <p id={`${id}-label`} className="flex items-center gap-1.5 text-sm font-semibold">
        <Music aria-hidden className="size-4 text-brand" /> Song request <span className="font-normal text-muted">(optional)</span>
      </p>
      {existing.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
          {existing.map((e, i) => <li key={i}>Already on file: {e}</li>)}
        </ul>
      )}
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="mt-2 grid grid-cols-2 gap-2">
        {([["none", "No request"], ["requested", "Requested song"]] as const).map(([mode, label]) => {
          const on = mode === "none" ? value.mode !== "requested" : requested;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange({ ...value, mode })}
              className={cn("min-h-11 rounded-lg border px-3 text-sm font-medium", on ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface hover:bg-surface-2")}
            >
              {label}
            </button>
          );
        })}
      </div>
      {requested && (
        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-title`} className="text-[13px] font-medium text-muted">Title and artist</label>
            <input id={`${id}-title`} value={value.title} maxLength={SONG_LIMITS.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="e.g. Good Days by LAKEY INSPIRED" className={input} />
          </div>
          <div>
            <label htmlFor={`${id}-link`} className="text-[13px] font-medium text-muted">Song link</label>
            <input id={`${id}-link`} value={value.link} maxLength={SONG_LIMITS.link} inputMode="url" onChange={(e) => onChange({ ...value, link: e.target.value })} placeholder="Spotify, YouTube or Apple Music link" className={input} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-start`} className="text-[13px] font-medium text-muted">Start time or section <span className="font-normal">(optional)</span></label>
            <input id={`${id}-start`} value={value.start} maxLength={SONG_LIMITS.start} onChange={(e) => onChange({ ...value, start: e.target.value })} placeholder="e.g. 0:30, or start at the chorus" className={input} />
          </div>
          <p className={cn("text-xs sm:col-span-2", problem ? "text-warning" : "text-muted")}>
            {problem ? `Add ${problem}.` : "A title or a link is enough to find it."}
          </p>
        </div>
      )}
    </div>
  );
}

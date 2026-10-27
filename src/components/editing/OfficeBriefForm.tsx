"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { BRIEF_COLOR_PROFILES, BRIEF_STYLES, type OfficeBriefFields } from "@/lib/briefFields";
import { saveOfficeBriefAction } from "@/app/edit/[id]/brief.actions";

// ---------------------------------------------------------------------------
// THE OFFICE WRITES THE BRIEF HERE, IN THE UPLOAD PORTAL'S FIELDS (Jordan,
// Oct 27 2026: "when we turn on office tools, we can write the brief ... it
// needs to be consistent with what they use on the upload page"). Video
// notes, style, color profile, vision for the edit, and the song's link and
// start, saved into the same instructions the photographer writes
// (lib/briefFields keeps every other section they wrote).
// ---------------------------------------------------------------------------

const FIELD = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-brand";
const LABEL = "block text-sm font-medium text-muted";

export function OfficeBriefForm({ projectId, videoKey, heading, initial, current, readOnly = false }: {
  projectId: string;
  /** the video's cut key on a job with several videos; null = the job's (video 1) */
  videoKey: string | null;
  heading: string;
  initial: OfficeBriefFields;
  /** the instructions as they were read, so a save over someone else's newer words is refused */
  current: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [f, setF] = useState<OfficeBriefFields>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  const set = (k: keyof OfficeBriefFields) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      data-office-brief-form={videoKey ?? "job"}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveOfficeBriefAction(projectId, videoKey, f, current).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
          setMsg(r);
          if (r.ok) router.refresh();
        });
      }}
      className="space-y-3"
    >
      <h3 className="text-base font-semibold">{heading}</h3>
      <label className={LABEL}>
        Video notes
        <textarea name="videoNotes" value={f.videoNotes} onChange={set("videoNotes")} rows={3} maxLength={3000} disabled={readOnly} className={FIELD} placeholder="Anything the editor should know: order, must-show moments, things to avoid." />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Style
          <select name="style" value={f.style} onChange={set("style")} disabled={readOnly} className={`${FIELD} min-h-11`}>
            <option value="">Not set</option>
            {BRIEF_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            {f.style && !(BRIEF_STYLES as readonly string[]).includes(f.style) && <option value={f.style}>{f.style}</option>}
          </select>
        </label>
        <label className={LABEL}>
          Color profile
          <select name="colorProfile" value={f.colorProfile} onChange={set("colorProfile")} disabled={readOnly} className={`${FIELD} min-h-11`}>
            <option value="">Not set</option>
            {BRIEF_COLOR_PROFILES.map((s) => <option key={s} value={s}>{s === "S-Log3, D-LogM" ? "S-Log3 and D-LogM" : s}</option>)}
            {f.colorProfile && !(BRIEF_COLOR_PROFILES as readonly string[]).includes(f.colorProfile) && <option value={f.colorProfile}>{f.colorProfile}</option>}
          </select>
        </label>
      </div>
      <label className={LABEL}>
        Vision for the edit
        <textarea name="vision" value={f.vision} onChange={set("vision")} rows={3} maxLength={3000} disabled={readOnly} className={FIELD} placeholder="The feel and the story: luxury and calm, let the property breathe." />
      </label>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className={LABEL}>
          Song link
          <input name="songLink" value={f.songLink} onChange={set("songLink")} maxLength={500} disabled={readOnly} inputMode="url" className={`${FIELD} min-h-11`} placeholder="Spotify, YouTube or Apple Music link" />
        </label>
        <label className={LABEL}>
          Song start
          <input name="songStart" value={f.songStart} onChange={set("songStart")} maxLength={120} disabled={readOnly} className={`${FIELD} min-h-11`} placeholder="0:30, at the chorus" />
        </label>
      </div>
      {!readOnly && (
        <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-brand">
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}Save the brief
        </button>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm font-medium text-success" : "text-sm text-danger"}>{msg.message}</p>}
    </form>
  );
}

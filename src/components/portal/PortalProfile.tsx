"use client";

import { useRef, useState, useTransition } from "react";
import { CheckCircle2, FileImage, Loader2, Palette, Plus, Upload, UserRound, X } from "lucide-react";
import { portalSaveProfile } from "@/app/portal/actions";

const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const parseColors = (s: string): string[] => [...new Set((s.match(HEX_RE) ?? []).map((c) => c.toLowerCase()))];

// The Agent Profile tab — the client curates their own brand: colors, video
// style, working preferences, and uploads (logo, headshots, fonts) that land
// straight in their Dropbox asset folder, where the editors already look.
export function PortalProfile({
  token, initial, assets,
}: {
  token: string;
  initial: { brandColors: string; videoStyle: string; preferences: string };
  assets: { name: string; url: string | null }[];
}) {
  // Brand colors are SWATCHES (Jordan: a color picker, saved codes shown as
  // little circles) — non-hex words from older data survive untouched in the
  // saved string's tail.
  const [colors, setColors] = useState<string[]>(parseColors(initial.brandColors));
  const extraColorWords = initial.brandColors.replace(HEX_RE, "").replace(/[,\s]+/g, " ").trim();
  const [pick, setPick] = useState("#d95816");
  const [videoStyle, setVideoStyle] = useState(initial.videoStyle);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState(assets);
  const [upMsg, setUpMsg] = useState<string | null>(null);

  const save = () =>
    start(async () => {
      // Only fields the client actually CHANGED go to the server — hitting
      // Save must never re-write (and re-clip) untouched seeded text.
      const brandColors = [colors.join(", "), extraColorWords].filter(Boolean).join(", ");
      const patch: { brandColors?: string; videoStyle?: string; preferences?: string } = {};
      if (brandColors !== initial.brandColors) patch.brandColors = brandColors;
      if (videoStyle !== initial.videoStyle) patch.videoStyle = videoStyle;
      if (preferences !== initial.preferences) patch.preferences = preferences;
      if (Object.keys(patch).length === 0) { setSaved("Nothing changed."); return; }
      const r = await portalSaveProfile(token, patch).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (r.ok) { setSaved(r.message); setErr(null); } else { setErr(r.message); setSaved(null); }
    });

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setUpMsg(null);
    for (const f of Array.from(list).slice(0, 5)) {
      const form = new FormData();
      form.set("token", token);
      form.set("file", f);
      try {
        const res = await fetch("/api/portal/upload", { method: "POST", body: form });
        const j = (await res.json()) as { ok: boolean; message: string };
        if (j.ok) setFiles((cur) => [{ name: f.name, url: null }, ...cur]);
        setUpMsg(j.message);
      } catch {
        setUpMsg("That upload didn't stick — try again.");
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-4">
      {/* Preferences */}
      <div className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold"><UserRound className="size-4 text-brand" /> Your preferences</div>
        <p className="mt-1 text-xs text-muted-2">Everything here reaches your editor and photographer on every job.</p>
        <div className="mt-3 space-y-3">
          <div>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-2"><Palette className="size-3" /> Brand colors</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {colors.map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 py-1 pl-1.5 pr-2 text-xs font-medium">
                  <span className="size-4 rounded-full border border-border-strong" style={{ backgroundColor: c }} />
                  {c.toUpperCase()}
                  <button onClick={() => setColors((cur) => cur.filter((x) => x !== c))} aria-label={`Remove ${c}`} className="text-muted-2 hover:text-danger">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <input type="color" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Pick a brand color"
                  className="size-8 cursor-pointer rounded-lg border border-border bg-surface-2/60 p-0.5" />
                <button onClick={() => setColors((cur) => (cur.includes(pick.toLowerCase()) ? cur : [...cur, pick.toLowerCase()]))}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                  <Plus className="size-3" /> Add
                </button>
              </span>
            </div>
            {extraColorWords && <p className="mt-1.5 text-[11px] text-muted-2">Also on file: {extraColorWords}</p>}
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Video style</span>
            <textarea value={videoStyle} onChange={(e) => setVideoStyle(e.target.value)} rows={3}
              placeholder="How you like your videos to feel — pacing, text style, music vibe…"
              className="mt-1 w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Working preferences</span>
            <textarea value={preferences} onChange={(e) => setPreferences(e.target.value)} rows={3}
              placeholder="Scheduling, communication, anything we should always know…"
              className="mt-1 w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 className="size-3.5 animate-spin" />} Save
            </button>
            {saved && <span className="flex items-center gap-1 text-xs font-medium text-success"><CheckCircle2 className="size-3.5" /> {saved}</span>}
            {err && <span className="text-xs text-danger">{err}</span>}
          </div>
        </div>
      </div>

      {/* Brand kit uploads */}
      <div className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold"><FileImage className="size-4 text-brand" /> Your brand kit</div>
        <p className="mt-1 text-xs text-muted-2">Logos, headshots, fonts, brand guides — they go straight to your team&rsquo;s working folder.</p>
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {uploading ? "Uploading…" : "Upload files"}
        </button>
        <input ref={fileRef} type="file" multiple hidden accept="image/*,.pdf,.zip,.otf,.ttf,.woff,.woff2,.mp4,.mov" onChange={(e) => upload(e.target.files)} />
        {upMsg && <p className="mt-2 text-xs text-muted">{upMsg}</p>}
        {files.length > 0 && (
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs">
                <FileImage className="size-3.5 shrink-0 text-muted-2" />
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="truncate hover:text-brand">{f.name}</a>
                ) : (
                  <span className="truncate">{f.name}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

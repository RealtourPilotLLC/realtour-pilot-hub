"use client";

import { useState, useTransition } from "react";
import { Palette, Save, Check, FolderOpen, Plus, ExternalLink, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveAgentProfile, setupBrandFolder } from "@/app/clients/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Pull hex codes out of free text so we can render swatches next to the field.
function extractColors(s: string): string[] {
  return (s.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) ?? []).slice(0, 12);
}

export function AgentProfile({
  clientId,
  clientPreferences,
  brandColors,
  brandAssetsPath,
  brandAssetsUrl,
}: {
  clientId: string;
  clientPreferences: string;
  brandColors: string;
  brandAssetsPath: string | null;
  brandAssetsUrl: string | null;
}) {
  const [prefs, setPrefs] = useState(clientPreferences);
  const [colors, setColors] = useState(brandColors);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const [folderUrl, setFolderUrl] = useState(brandAssetsUrl);
  const [folderMsg, setFolderMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creating, startCreate] = useTransition();

  const swatches = extractColors(colors);

  return (
    <section className="rounded-2xl border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Sparkles className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Agent profile</h2>
      </div>
      <div className="space-y-4 px-5 py-4">
        {/* Brand colors */}
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <Palette className="size-3.5" /> Brand colors
          </label>
          <input
            value={colors}
            onChange={(e) => setColors(e.target.value)}
            placeholder="#0B1F3A, #C9A24B, navy & gold"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {swatches.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {swatches.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 py-0.5 pl-1 pr-1.5 text-[11px] text-muted">
                  <span className="size-4 rounded" style={{ backgroundColor: c }} />
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Client preferences */}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">
            Client preferences
          </label>
          <AutoTextarea
            value={prefs}
            onChange={(e) => setPrefs(e.target.value)}
            minRows={4}
            placeholder="How they like to work — scheduling (e.g. morning shoots), comms (text not call), must-haves, things to avoid…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <button
          disabled={pending}
          onClick={() =>
            start(async () => {
              await saveAgentProfile(clientId, prefs, colors);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saved ? <Check className="size-4" /> : <Save className="size-4" />} {saved ? "Saved" : pending ? "Saving…" : "Save profile"}
        </button>

        {/* Brand assets folder */}
        <div className="border-t border-border pt-4">
          <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <FolderOpen className="size-3.5" /> Brand assets
          </label>
          {folderUrl || brandAssetsPath ? (
            <a
              href={folderUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <ExternalLink className="size-4 text-brand" /> Open brand folder in Dropbox
            </a>
          ) : (
            <button
              disabled={creating}
              onClick={() =>
                startCreate(async () => {
                  const r = await setupBrandFolder(clientId);
                  setFolderMsg({ ok: r.ok, text: r.message });
                  if (r.ok && r.url) setFolderUrl(r.url);
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              <Plus className="size-4" /> {creating ? "Creating…" : "Create brand folder"}
            </button>
          )}
          {folderMsg && (
            <span className={cn("ml-2 text-xs", folderMsg.ok ? "text-success" : "text-danger")}>{folderMsg.text}</span>
          )}
          <p className="mt-1.5 text-[11px] text-muted-2">
            One Dropbox folder for their logo, fonts & brand kit — shared by the whole team.
          </p>
        </div>
      </div>
    </section>
  );
}

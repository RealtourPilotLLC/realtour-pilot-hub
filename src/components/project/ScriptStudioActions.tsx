"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, RefreshCw, ExternalLink } from "lucide-react";
import { createScriptProject, syncScriptFromStudio } from "@/app/projects/scriptingActions";

// The two interactive controls for the Script Studio panel: create/link the
// Studio project, then pull the latest script back into the reel recipe.
export function ScriptStudioActions({ projectId, linked, url }: { projectId: string; linked: boolean; url: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const run = (fn: (id: string) => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn(projectId);
      setMsg(r.message);
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!linked ? (
          <button
            onClick={() => run(createScriptProject)}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Create in Script Studio
          </button>
        ) : (
          <button
            onClick={() => run(syncScriptFromStudio)}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Sync latest script
          </button>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
            Open in Studio <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {msg && <p className="text-xs text-muted-2">{msg}</p>}
    </div>
  );
}

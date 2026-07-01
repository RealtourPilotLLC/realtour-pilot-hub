"use client";

import { useState, useTransition } from "react";
import { Clapperboard, Loader2, ExternalLink } from "lucide-react";
import { setupFrameioForProject } from "@/app/frameio/actions";

const FIO = "#5b53ff";

// Create (or open) the Frame.io review project for a job. Owner/admin only —
// editors upload their finished video here and we review/comment in Frame.io.
export function FrameioButton({ projectId, viewUrl }: { projectId: string; viewUrl: string | null }) {
  const [url, setUrl] = useState(viewUrl);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium hover:opacity-90"
        style={{ backgroundColor: `${FIO}1a`, color: FIO }}
      >
        <Clapperboard className="size-3.5" /> Open in Frame.io <ExternalLink className="size-3" />
      </a>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() =>
          start(async () => {
            setMsg(null);
            const r = await setupFrameioForProject(projectId);
            if (r.ok && r.viewUrl) setUrl(r.viewUrl);
            else setMsg(r.message);
          })
        }
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
        style={{ backgroundColor: FIO }}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Clapperboard className="size-3.5" />} Create Frame.io project
      </button>
      {msg && <span className="text-xs text-danger">{msg}</span>}
    </span>
  );
}

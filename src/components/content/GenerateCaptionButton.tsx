"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Captions } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { generateInstagramCaptionAction } from "@/app/content/actions";

/**
 * "Generate an Instagram caption" (Jordan, Oct 24 2026) on a video with an
 * approved version and no caption yet. It transcribes the approved version
 * when it has no transcript, then drafts the caption; it takes a few seconds.
 */
export function GenerateCaptionButton({ videoId, title }: { videoId: string; title: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="space-y-1" data-generate-caption={videoId}>
      <Button
        variant="secondary"
        busy={busy}
        busyLabel="Writing the caption..."
        aria-label={`Generate an Instagram caption for ${title}`}
        onClick={() => start(async () => {
          const r = await generateInstagramCaptionAction(videoId).catch(() => ({ ok: false, message: "Couldn't reach the hub. Refresh and try again." }));
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok) router.refresh();
        })}
      >
        <Captions aria-hidden className="size-4" /> Generate an Instagram caption
      </Button>
      {msg && <p role="status" className={msg.ok ? "text-ui-status text-success" : "text-ui-status text-danger"}>{msg.text}</p>}
    </div>
  );
}

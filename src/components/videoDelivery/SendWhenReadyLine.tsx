"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { cancelSendWhenReadyAction } from "@/app/review/sendWhenReadyActions";

// ---------------------------------------------------------------------------
// WHAT HAPPENS AFTER THE TOPAZ PASS, ON THE ROW (Oct 23 2026, lib/sendWhenReady).
//
// A video somebody pressed "Approve and send" (or "Run it again, then upload
// and send") on says so wherever it sits in the Video Review Room: "Then:
// upload to Aryeo and send (asked by Jordan, Thu, Oct 23, 3:05 PM ET)", with
// "Don't send it automatically" for the owner and the office. When it did not
// go, the Ready to send row says why in one line. The words are the server's;
// this only draws them and carries the one press.
// ---------------------------------------------------------------------------

export function SendWhenReadyLine(props: {
  submissionId: string;
  street: string;
  state: "waiting" | "not-sent";
  by: string;
  /** when it was asked, already in ET words */
  when: string;
  note: string | null;
  /** the owner and the office: "Don't send it automatically" */
  canCancel: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (props.state === "not-sent") {
    return <p className="mt-1 text-sm font-medium text-warning" data-send-when-ready="not-sent">Not sent automatically: {props.note ?? "the hub could not start it."}</p>;
  }
  return (
    <div className="mt-1 space-y-1" data-send-when-ready="waiting">
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <UploadCloud aria-hidden className="size-4 shrink-0 text-brand" />
        <span><span className="font-medium">Then: upload to Aryeo and send</span> <span className="text-muted">(asked by {props.by}, {props.when} ET)</span></span>
      </p>
      {props.canCancel && !msg?.ok && (
        <Button
          variant="secondary"
          busy={pending}
          busyLabel="Turning it off..."
          aria-label={`Don't send ${props.street} automatically`}
          onClick={() =>
            start(async () => {
              try {
                const r = await cancelSendWhenReadyAction(props.submissionId);
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) router.refresh();
              } catch {
                setMsg({ ok: false, text: "The hub didn't answer. Reload to see whether it is still set to send." });
              }
            })
          }
        >
          Don&rsquo;t send it automatically
        </Button>
      )}
      {msg && <p role="status" className={msg.ok ? "text-sm text-muted" : "text-sm font-medium text-warning"}>{msg.text}</p>}
    </div>
  );
}

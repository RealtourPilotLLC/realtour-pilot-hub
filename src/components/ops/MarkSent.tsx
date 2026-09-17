"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Send } from "lucide-react";
import { markVideoSentAction } from "@/app/ops/actions";

/**
 * "Mark as sent" — Kyle's one tap AFTER he has uploaded the file to Aryeo and
 * delivered the listing. It records what he did; it never contacts a client.
 *
 * A client component, so it takes an id and calls a server action. It must not
 * import @/lib/readyToSend (or prisma, or settings) — that is the single most
 * reliable way to break this build while tsc stays quiet.
 *
 * IT ASKS FIRST. Two taps, not one: the first turns the button into "Yes, it's
 * been sent" and the second writes the stamp. Nothing in the hub can clear that
 * stamp, so a mis-tap on a phone — this button sits a thumb's width from
 * "Watch it" — would take the row off the only surface that tracks it and leave
 * the recovery as a hand-edit of the production database. The question reverts
 * on its own after a few seconds, so an accidental first tap costs nothing.
 *
 * A second press of a row somebody else already marked is not a bug and is not
 * silenced: the action is idempotent in Postgres and answers with who marked it
 * and when, which is exactly the question that started this card ("did anyone
 * actually re-send it?").
 */
export function MarkSent({ submissionId, street }: { submissionId: string; street: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A component that unmounts mid-question (the row leaves on a refresh) must
  // not leave a timer holding a setState behind it.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const press = () => {
    if (!asking) {
      setAsking(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAsking(false), 6000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setAsking(false);
    start(async () => {
      const r = await markVideoSentAction(submissionId).catch(() => ({ ok: false, message: "Couldn’t save — try again.", already: false }));
      setDone(r.ok);
      // On a clean first press the row simply leaves the card, so the only
      // message worth keeping on screen is a failure or an "already sent".
      setMsg(r.ok && !r.already ? null : r.message);
      if (r.ok) router.refresh();
    });
  };

  return (
    <>
      <button
        onClick={press}
        disabled={busy || done}
        title={`Record that ${street}'s video has been uploaded to Aryeo and delivered. This sends nothing to the client.`}
        // min-h-9 keeps it a real tap target on a phone; shrink-0 stops it
        // being squeezed to nothing when the address beside it is long.
        className={
          "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 " +
          (asking
            ? "border-success bg-success text-white hover:opacity-90"
            : "border-success/40 bg-success/10 text-success hover:bg-success/20")
        }
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : done ? <Check className="size-3.5" /> : <Send className="size-3.5" />}
        {done ? "Sent" : asking ? "Yes, it’s been sent" : "Mark as sent"}
      </button>
      {asking && !busy && (
        <span className="basis-full text-[11px] text-muted">Only after the file is on Aryeo and the listing is delivered. This can&rsquo;t be undone.</span>
      )}
      {msg && <span className="basis-full text-[11px] font-medium text-warning">{msg}</span>}
    </>
  );
}

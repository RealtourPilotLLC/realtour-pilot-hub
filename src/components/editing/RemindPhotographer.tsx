"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { remindPhotographerAction } from "@/app/editing/remindActions";

/** What a row needs to draw the button (lib/remindPhotographer remindViewsFor). */
export type RemindView = { missing: string[]; photographer: string | null; last: { atISO: string; words: string } | null };

/** "a", "a and b", "a, b and c" */
const listWords = (items: string[]) => (items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// "REMIND PHOTOGRAPHER" (Jordan, Oct 23 2026). Drawn by SimpleQueue on an
// office row whose video instructions are missing (the server decides which
// rows, and only for the office and the creative manager). One press texts the
// photographer now with the upload page link; the server refuses, with the
// reason, when nothing is missing any more, there is nobody to text, OpenPhone
// is off, or the last reminder went out under two hours ago. The line beside
// it says when the last one went and who sent it.
export function RemindPhotographerButton({ projectId, street, view, showMissing = false }: {
  projectId: string;
  street: string;
  view: RemindView;
  /** Say what is missing too (the row carries no handoff sentence of its own). */
  showMissing?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [last, setLast] = useState(view.last);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const who = view.photographer?.split(" ")[0] ?? "the photographer";
  const press = () => {
    if (pending) return;
    setNote(null);
    start(async () => {
      const r = await remindPhotographerAction(projectId).catch(() => ({ ok: false, message: "That didn't go through. Try again.", last: undefined }));
      if (r.last) setLast(r.last);
      setNote({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };
  return (
    <span className="flex max-w-full basis-full flex-wrap items-center gap-x-2 gap-y-0.5 lg:mt-1">
      {showMissing && view.missing.length > 0 && (
        <span className="block max-w-full basis-full break-words whitespace-normal text-xs leading-4 text-warning">Instructions missing: {listWords(view.missing)}</span>
      )}
      <button
        type="button"
        onClick={press}
        disabled={pending}
        aria-label={`Remind photographer about ${street}`}
        title={`Texts ${who} that the instructions are missing and the editor is waiting, with the upload page link.`}
        className="inline-flex min-h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {pending ? <Loader2 aria-hidden="true" className="size-3 animate-spin" /> : <Send aria-hidden="true" className="size-3" />}
        Remind photographer
      </button>
      {last && <span className="text-xs leading-4 text-muted">{last.words}</span>}
      {note && (
        <span role="status" className={`block max-w-full basis-full break-words whitespace-normal text-xs leading-4 ${note.ok ? "text-success" : "text-warning"}`}>{note.text}</span>
      )}
    </span>
  );
}

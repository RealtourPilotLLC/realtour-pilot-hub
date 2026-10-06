// ---------------------------------------------------------------------------
// VERDICT RECEIPTS — the Review Room's instant confirmations (Oct 5 2026).
//
// Jordan: "when we approve an edit, it should close and give a confirmation
// instantly that it was approved … so our team can keep moving and reviewing
// videos." So a verdict moves the reviewer to the next cut on the click, and
// the confirmation has to outlive the cut it was about: the panel that pressed
// it is gone by the time the server answers. It lives here, in a module-level
// store that survives client navigation inside the app, and VerdictReceipts.tsx
// renders it on both Review Room pages.
//
// A receipt starts "pending" with the words the reviewer expects, becomes
// "done" with the server's own sentence (what actually happens next), or
// "refused" with the exact reason — and then offers the way back: the cut,
// with the reviewer's unsent words restored (keepDraft/readDraft), or Approve
// anyway when the only objection was unticked fixes. "unknown" is the network
// failing mid-answer: nothing is assumed either way.
//
// Client-only by use (written to from event handlers, read through
// useSyncExternalStore with an empty server snapshot), so the server render
// never sees anything in it.
// ---------------------------------------------------------------------------

export type ReceiptState = "pending" | "done" | "refused" | "unknown";

export type VerdictReceipt = {
  id: string;
  submissionId: string;
  /** Back to the cut this verdict was about. */
  cutHref: string;
  /** "Approved" / "Sent back to Kim" — what was pressed. */
  title: string;
  /** Which cut, in the Room's words: "12 Main St · Video 2 of 4". */
  cut: string;
  state: ReceiptState;
  message: string;
  /** Where the reviewer was taken: "Next: …" or "All caught up …". */
  next: string | null;
  /** Set only on a refusal the reviewer may override (unticked fixes). */
  approveAnyway?: () => void;
  /** When it settled as done — the card fades a while after. */
  doneAt?: number;
  /** Closed by the reviewer while still pending: hidden, and shown again if
   *  the answer turns out to be a refusal or unknown. */
  hidden?: boolean;
};

// A PENDING RECEIPT IS NEVER LOST (review, Oct 5 night). Four verdicts in a
// row used to push the oldest card out of the list while its answer was still
// coming, and closing a card while it said "Saving…" deleted it — either way a
// refusal that arrived later had no card to land on, and nobody saw it. So:
//   · the cap only ever drops SETTLED cards (oldest first); pending ones stay;
//   · a second verdict on the same cut replaces only a settled card;
//   · closing a pending card hides it, and a refusal or "couldn't confirm"
//     brings it back; a success just removes it.
const MAX_RECEIPTS = 4;
const EMPTY: readonly VerdictReceipt[] = [];
/** Everything, hidden pending cards included. */
let all: readonly VerdictReceipt[] = EMPTY;
/** What the screen draws (a stable reference between changes). */
let receipts: readonly VerdictReceipt[] = EMPTY;
const listeners = new Set<() => void>();
const emit = () => {
  receipts = all.some((r) => r.hidden) ? all.filter((r) => !r.hidden) : all;
  for (const listener of listeners) listener();
};
/** Keep every pending card; trim settled ones (oldest first) to the cap. */
function capped(list: readonly VerdictReceipt[]): readonly VerdictReceipt[] {
  let room = Math.max(0, MAX_RECEIPTS - list.filter((r) => r.state === "pending").length);
  return list.filter((r) => r.state === "pending" || room-- > 0);
}

export function subscribeReceipts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const receiptsSnapshot = (): readonly VerdictReceipt[] => receipts;
export const receiptsServerSnapshot = (): readonly VerdictReceipt[] => EMPTY;

let seq = 0;
/** A new receipt, newest first. A second verdict on the same cut replaces its
 *  earlier card rather than stacking beside it. */
export function addReceipt(r: Omit<VerdictReceipt, "id">): string {
  const id = `${r.submissionId}:${++seq}`;
  all = capped([{ ...r, id }, ...all.filter((x) => x.submissionId !== r.submissionId || x.state === "pending")]);
  emit();
  return id;
}

export function updateReceipt(id: string, patch: Partial<Omit<VerdictReceipt, "id" | "doneAt" | "hidden">>): void {
  const cur = all.find((r) => r.id === id);
  if (!cur) return;
  // Closed while pending, and now settled: a success needs no card; trouble
  // comes back on screen, whatever the reviewer closed.
  if (cur.hidden && patch.state === "done") {
    all = all.filter((r) => r.id !== id);
    emit();
    return;
  }
  const doneAt = patch.state === "done" ? Date.now() : undefined;
  const hidden = cur.hidden && (patch.state === "refused" || patch.state === "unknown") ? false : cur.hidden;
  all = capped(all.map((r) => (r.id === id ? { ...r, ...patch, doneAt, hidden } : r)));
  emit();
}

export function dismissReceipt(id: string): void {
  const cur = all.find((r) => r.id === id);
  if (!cur) return;
  all = cur.state === "pending" ? all.map((r) => (r.id === id ? { ...r, hidden: true } : r)) : all.filter((r) => r.id !== id);
  emit();
}

// ---- the reviewer's unsent words, kept across the move ---------------------

export type VerdictDraft = { body: string; clock: string; reply: string; notFixed: string[]; composing: boolean };
const drafts = new Map<string, VerdictDraft>();

/** Kept at the press, so a refused verdict loses nothing the reviewer typed. */
export function keepDraft(submissionId: string, draft: VerdictDraft): void {
  if (!draft.body.trim() && !draft.clock.trim() && !draft.reply.trim() && draft.notFixed.length === 0) {
    drafts.delete(submissionId);
    return;
  }
  drafts.set(submissionId, draft);
}

/** Read by the cut's panel as it mounts again (it drops it once mounted). */
export function readDraft(submissionId: string): VerdictDraft | null {
  return drafts.get(submissionId) ?? null;
}

/** The verdict landed — the words were for a cut that is decided now. */
export function dropDraft(submissionId: string): void {
  drafts.delete(submissionId);
}

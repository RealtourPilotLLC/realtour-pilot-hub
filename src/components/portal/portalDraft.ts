"use client";

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// WORDS NOT SENT YET STAY ON THIS DEVICE (Oct 22 2026, audit LOW). The video
// note box got this today (CutReview's NoteComposer); the script change note
// (ScriptApprovalCard), the reply under a script (ScriptThread) and the
// Messages box (MessageComposer) lost what the client typed on a reload, a
// flash or a closed tab. The same rule for all three:
//   · the text autosaves on this device per box (localStorage, every access
//     guarded: a private window or blocked storage just means no autosave);
//   · a draft found on the way in is put back, with a line saying it was kept;
//   · a sent message clears it.
// ---------------------------------------------------------------------------

export const DRAFT_COPY = {
  restored: "You have words here you haven't sent. We kept them on this device.",
} as const;

/** The script change note ("Ask for a change in your own words"), per script. */
export const scriptChangeDraftKey = (scriptId: string) => `rtp_portal_script_change:${scriptId}`;
/** The reply under a script, per script. */
export const scriptReplyDraftKey = (scriptId: string) => `rtp_portal_script_reply:${scriptId}`;
/** The Messages box, per portal (the path, and the client a staff member is viewing for). */
export function messageDraftKey(loc: { pathname: string; search: string }): string {
  const e = new URLSearchParams(loc.search).get("e");
  return `rtp_portal_message:${loc.pathname}${e ? `?e=${e}` : ""}`;
}

export function readDraft(key: string): string {
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}
export function writeDraft(key: string, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  } catch { /* storage unavailable: the box still holds the text */ }
}

/**
 * A text box's words, saved on this device as they are typed. `key` null =
 * not known yet (it is read from the page's location after mount). A saved
 * draft, when there is one, replaces `initial` on the way in.
 */
export function useDraft(key: string | null, initial = ""): { text: string; setText: (v: string) => void; clear: () => void; restored: boolean } {
  const [text, setTextState] = useState(initial);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!key) return;
    const saved = readDraft(key);
    if (!saved.trim()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- storage exists only in the browser, after hydration
    setTextState(saved);
    setRestored(true);
  }, [key]);
  const setText = useCallback((v: string) => {
    setTextState(v);
    if (!v.trim()) setRestored(false);
    if (key) writeDraft(key, v);
  }, [key]);
  const clear = useCallback(() => setText(""), [setText]);
  return { text, setText, clear, restored: restored && text.trim().length > 0 };
}

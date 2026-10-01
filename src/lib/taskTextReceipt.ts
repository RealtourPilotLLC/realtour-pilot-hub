/** Async task receipts acknowledge only the input present when requested.
 * Exact comparison keeps later punctuation, whitespace and edits intact. */
export function finishTaskReplyDraft(current: string, requested: string, suggestion: string) {
  const keptNewer = current !== requested;
  return {
    value: keptNewer ? current : suggestion,
    keptNewer,
    message: keptNewer ? "A new AI suggestion is ready. Your newer reply text is kept; review the suggestion below." : "",
  };
}

export function finishTaskNoteReceipt(current: string, submitted: string, result: { ok: boolean; message: string }) {
  const keptNewer = result.ok && current !== submitted;
  return {
    value: result.ok && !keptNewer ? "" : current,
    close: result.ok && !keptNewer,
    error: !result.ok,
    message: keptNewer && current !== "" ? `${result.message} Your newer note is still unsaved.` : result.message,
  };
}

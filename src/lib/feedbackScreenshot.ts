// Feedback screenshots are stored as data: URLs on PlatformFeedback.screenshot
// (the widget compresses them to JPEG). Pure helpers — no I/O.

/** The image bytes inside a stored screenshot, or null for anything that is
 *  not a png/jpeg data URL. */
export function parseScreenshotDataUrl(value: string | null): { type: "image/png" | "image/jpeg"; bytes: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(value ?? "");
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  return bytes.length ? { type: m[1] as "image/png" | "image/jpeg", bytes } : null;
}

/** Where the board shows a row's screenshot from. */
export const feedbackScreenshotHref = (id: string) => `/api/feedback/${id}/screenshot`;

/** "1:05" from seconds; null when the length isn't known. */
export function fmtDuration(s: number | null | undefined): string | null {
  if (!s || !Number.isFinite(s)) return null;
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** A same-origin download, started from a press without leaving the page. */
export function startDownload(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

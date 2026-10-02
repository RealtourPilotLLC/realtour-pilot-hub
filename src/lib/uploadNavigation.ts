/** Preserve the selected output and mounted file while checking/uploading. */
export function protectUploadWorkspace(onBlocked: () => void, env: { window: Window; document: Document } = { window, document }) {
  const { window: win, document: doc } = env;
  const lockedUrl = win.location.href, lockedState = win.history.state;
  const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
  const protectHistory = (event: PopStateEvent) => {
    if (win.location.href === lockedUrl) return;
    event.stopImmediatePropagation();
    win.history.pushState(lockedState, "", lockedUrl);
    onBlocked();
  };
  const protectSelection = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a");
    if (!anchor || anchor.target === "_blank" || anchor.getAttribute("href")?.startsWith("#")) return;
    event.preventDefault(); event.stopImmediatePropagation(); onBlocked();
  };
  win.addEventListener("beforeunload", beforeUnload);
  win.addEventListener("popstate", protectHistory, true);
  doc.addEventListener("click", protectSelection, true);
  return () => {
    win.removeEventListener("beforeunload", beforeUnload);
    win.removeEventListener("popstate", protectHistory, true);
    doc.removeEventListener("click", protectSelection, true);
  };
}

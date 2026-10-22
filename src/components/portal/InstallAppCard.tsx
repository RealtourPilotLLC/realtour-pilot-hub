"use client";

import { useEffect, useState } from "react";
import { EllipsisVertical, Share, Smartphone, X } from "lucide-react";

// ---------------------------------------------------------------------------
// "ADD TO YOUR HOME SCREEN" (Oct 22 2026). Jordan: "Clients need an easy way
// to access the portal without having to log in every time or look for a link
// in their email." With the year-long session (lib/auth/clientSession) and the
// portal's web app manifest (app/portal/manifest.webmanifest), an icon on the
// phone opens the portal signed in. This small card on Home says how:
//   iPhone  → Share, then Add to Home Screen (iOS copies the sign-in to the
//             new icon when it is added, so the icon opens signed in)
//   Android → the browser's own install prompt when it offers one, otherwise
//             the menu, then Add to Home screen
// Hidden: on a computer with no install prompt, when the portal is already
// open from the home screen, once dismissed on this device (localStorage,
// every access guarded), and always for staff viewing on a client's behalf
// (PortalPage does not render it for a STAFF visit).
// ---------------------------------------------------------------------------

export const INSTALL_CARD_DISMISSED_KEY = "rtp_portal_install_card_dismissed";

type Platform = "ios" | "android" | "other";
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice?: Promise<{ outcome: string }> };

/** Which steps to show, from the browser's own description of itself. */
export function installPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS reports itself as a Mac; a Mac has no touch screen.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function dismissed(): boolean {
  try { return window.localStorage.getItem(INSTALL_CARD_DISMISSED_KEY) === "1"; } catch { return false; }
}
function standalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function InstallAppCard({ signedIn }: { signedIn: boolean }) {
  // Nothing renders on the server or before the browser has been asked, so
  // the page never flashes a card that is about to hide itself.
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (dismissed() || standalone()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the platform is known only in the browser, after hydration
    setPlatform(installPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0));
    setHidden(false);
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPrompt); };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    try { window.localStorage.setItem(INSTALL_CARD_DISMISSED_KEY, "1"); } catch { /* hidden for this visit only */ }
    setHidden(true);
  };
  const install = async () => {
    if (!prompt) return;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice?.catch(() => null);
      if (choice?.outcome === "accepted") setHidden(true);
    } catch { /* the browser declined to show it; the steps stay on screen */ }
    setPrompt(null);
  };

  // A computer is shown the card only when its browser offers to install.
  if (hidden || !platform || (platform === "other" && !prompt)) return null;
  return (
    <section aria-labelledby="install-card-title" className="relative mt-4 rounded-2xl border border-border bg-surface/80 p-4 pr-12 text-sm">
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="absolute right-1.5 top-1.5 inline-flex size-11 items-center justify-center rounded-lg text-muted-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <X className="size-4" aria-hidden />
      </button>
      <h2 id="install-card-title" className="flex items-center gap-2 font-semibold"><Smartphone className="size-4 text-brand" aria-hidden /> Add your portal to your home screen</h2>
      <p className="mt-1 text-muted">Open it in one tap, like an app{signedIn ? ", and stay signed in on this phone" : ""}.</p>
      {prompt ? (
        <button type="button" onClick={() => void install()} className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-4 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          Add to home screen
        </button>
      ) : platform === "ios" ? (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>Tap the Share button <Share className="inline size-3.5 align-[-2px] text-foreground" aria-label="(the square with an arrow pointing up)" /> in Safari.</li>
          <li>Scroll down and tap <span className="font-semibold text-foreground">Add to Home Screen</span>, then <span className="font-semibold text-foreground">Add</span>.</li>
        </ol>
      ) : (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>Tap the menu <EllipsisVertical className="inline size-3.5 align-[-2px] text-foreground" aria-label="(three dots)" /> at the top right of the browser.</li>
          <li>Tap <span className="font-semibold text-foreground">Add to Home screen</span> or <span className="font-semibold text-foreground">Install app</span>.</li>
        </ol>
      )}
      <button type="button" onClick={dismiss} className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Not now</button>
    </section>
  );
}

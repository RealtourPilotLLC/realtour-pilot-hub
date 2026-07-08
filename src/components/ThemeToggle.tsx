"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

// Light/dark switch. The <html> class is set pre-paint by the boot script in
// layout.tsx; this just flips it and persists the choice. Renders after mount
// so the icon always matches the real document state (no hydration guess).
export function ThemeToggle() {
  const [light, setLight] = useState<boolean | null>(null);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", next);
    try {
      localStorage.setItem("rtp_theme", next ? "light" : "dark");
    } catch {
      /* private mode — the class still applies for this visit */
    }
    setLight(next);
  }

  return (
    <button
      onClick={toggle}
      title={light ? "Switch to dark mode" : "Switch to light mode"}
      className="flex size-8 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground"
    >
      {light === null ? <Moon className="size-4 opacity-0" /> : light ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </button>
  );
}

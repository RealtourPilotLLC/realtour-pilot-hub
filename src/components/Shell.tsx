"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { FeedbackWidget } from "@/components/feedback/FeedbackWidget";
import { cn } from "@/lib/utils";

// App chrome: a static sidebar on desktop (lg+), and a slide-in drawer with a
// hamburger top bar on mobile. Keeps the whole hub usable on a phone.
export function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer + backdrop. z must clear Leaflet map panes/controls
          (~z-index 1000), or the menu slides in *behind* the map on mobile. */}
      <div
        className={cn(
          "fixed inset-0 z-[1200] bg-black/60 transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-[1300] transition-transform duration-200 ease-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar onNavigate={() => setOpen(false)} />
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur-xl lg:hidden">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            className="flex size-9 items-center justify-center rounded-lg text-foreground/80 hover:bg-surface-2"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="flex items-center gap-2">
            <div
              className="flex size-7 items-center justify-center rounded-lg text-[11px] font-bold text-white ring-1 ring-white/10"
              style={{ background: "linear-gradient(135deg, #f97316, #e96320 55%, #c2410c)" }}
            >
              RP
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Real<span className="text-brand">Tour</span> Pilot
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto scroll-thin">{children}</main>
      </div>

      {/* Always-on feedback launcher (Kyle → review board) */}
      <FeedbackWidget />
    </div>
  );
}

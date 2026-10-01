"use client";

import { Children, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// Shows the first `initial` children, with a toggle to reveal the rest.
export function ShowMore({
  children,
  initial = 5,
  className = "",
}: {
  children: ReactNode;
  initial?: number;
  className?: string;
}) {
  const items = Children.toArray(children);
  const [open, setOpen] = useState(false);
  const extra = items.length - initial;
  const shown = open ? items : items.slice(0, initial);

  return (
    <>
      {shown}
      {extra > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${className}`}
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "Show less" : `Show ${extra} more`}
        </button>
      )}
    </>
  );
}

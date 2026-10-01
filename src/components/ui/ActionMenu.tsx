"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type ActionMenuItem = {
  id: string;
  label: ReactNode;
  text: string;
  onSelect: () => void;
  disabled?: boolean;
  description?: string;
  checked?: boolean;
};

/** A menu button for commands, including commands that open another dialog. */
export function ActionMenu({ label, children, items, className, style, title, busy = false, triggerRef: suppliedRef }: {
  label: string;
  children: ReactNode;
  items: ActionMenuItem[];
  className?: string;
  style?: CSSProperties;
  title?: string;
  busy?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const localRef = useRef<HTMLButtonElement>(null);
  const triggerRef = suppliedRef ?? localRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(0);
  const id = useId();
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const open = position !== null;
  const close = (restoreFocus: boolean) => {
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const show = (last = false) => {
    if (busy || !items.length || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    const height = Math.min(items.length * 44 + 8, window.innerHeight - 16);
    const top = window.innerHeight - r.bottom >= height + 12 ? r.bottom + 4 : Math.max(8, r.top - height - 4);
    firstFocus.current = last ? items.length - 1 : Math.max(0, items.findIndex((item) => item.checked));
    setPosition({
      width, maxHeight: window.innerHeight - top - 8,
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top,
    });
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']")[firstFocus.current]?.focus();
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menuRef.current?.contains(node) && !triggerRef.current?.contains(node)) setPosition(null);
    };
    const moved = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setPosition(null);
      // Do not leave keyboard focus inside a menu removed by a scroll/resize.
      if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, triggerRef]);

  return <>
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      title={title}
      className={cn("min-h-11 min-w-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", className)}
      style={style}
      onClick={() => open ? close(true) : show()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          show(event.key === "ArrowUp");
        } else if (event.key === "Escape" && open) { event.preventDefault(); close(true); }
      }}
    >{children}</button>
    {open && createPortal(
      <div
        id={id}
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="fixed z-50 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
        style={position}
        onClick={(event) => event.stopPropagation()}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== triggerRef.current) close(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); close(true); return; }
          // Put focus back before the native Tab move so the next control is
          // next to this row's trigger, rather than after the body portal.
          if (event.key === "Tab") { close(true); return; }
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          let next: number | undefined;
          if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
          if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = buttons.length - 1;
          if (event.key.length === 1 && /\S/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
            const candidates = items.map((_, index) => (current + index + 1) % items.length);
            next = candidates.find((index) => items[index].text.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
          }
          if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
        }}
      >{items.map((item) => <button
        key={item.id}
        type="button"
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        aria-disabled={item.disabled || undefined}
        aria-describedby={item.description ? `${id}-${item.id}-reason` : undefined}
        tabIndex={-1}
        title={item.description}
        className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand", item.disabled ? "cursor-not-allowed text-muted" : "hover:bg-surface-2")}
        onClick={() => { if (!item.disabled && !busy) { close(true); item.onSelect(); } }}
      >
        {item.label}
        {item.description && <span id={`${id}-${item.id}-reason`} className="sr-only">{item.description}</span>}
      </button>)}</div>, document.body,
    )}
  </>;
}

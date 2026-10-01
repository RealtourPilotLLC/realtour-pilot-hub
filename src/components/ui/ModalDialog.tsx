"use client";

import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { cn } from "@/lib/utils";

/** Native top-layer dialog: the browser contains focus and makes the page inert. */
export function ModalDialog({
  label,
  open = true,
  busy = false,
  holdEscape = false,
  onCancel,
  children,
  className,
}: {
  label: string;
  /** Controlled visibility keeps children and their drafts mounted when closed. */
  open?: boolean;
  busy?: boolean;
  /** Keep a nested confirmation visible until its own buttons decide. */
  holdEscape?: boolean;
  onCancel: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-modal-initial-focus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (prior?.isConnected) prior.focus();
    };
  }, [open]);

  function cancel(event: SyntheticEvent<HTMLDialogElement>) {
    // React may propagate a nested dialog's synthetic cancel through this tree.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (!busy) onCancel();
  }

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={cancel}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && (busy || holdEscape)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className={cn(
        "fixed left-1/2 top-1/2 m-0 max-h-[90dvh] w-[min(94vw,40rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-foreground shadow-2xl backdrop:bg-black/60 sm:p-5",
        className,
      )}
    >
      {children}
    </dialog>
  );
}

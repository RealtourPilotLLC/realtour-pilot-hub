"use client";

import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { cn } from "@/lib/utils";

/** Native top-layer dialog: the browser contains focus and makes the page inert. */
export function ModalDialog({
  label,
  busy = false,
  onCancel,
  children,
  className,
}: {
  label: string;
  busy?: boolean;
  onCancel: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (prior?.isConnected) prior.focus();
    };
  }, []);

  function cancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    if (!busy) onCancel();
  }

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={cancel}
      className={cn(
        "fixed left-1/2 top-1/2 m-0 max-h-[90dvh] w-[min(94vw,40rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-foreground shadow-2xl backdrop:bg-black/60 sm:p-5",
        className,
      )}
    >
      {children}
    </dialog>
  );
}

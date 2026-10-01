import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "quiet" | "danger";
const variants: Record<Variant, string> = {
  primary: "border-transparent bg-brand-action text-brand-fg hover:brightness-95",
  secondary: "border-border-strong bg-surface text-foreground hover:bg-surface-2",
  quiet: "border-transparent text-foreground hover:bg-surface-2",
  danger: "border-transparent bg-danger-action text-white hover:brightness-95",
};
const base = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold leading-snug whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60";

/** Native buttons keep form/keyboard semantics. Domain guards and confirmation
 * remain with the caller. A pending action cannot be submitted twice. */
export function Button({ variant = "primary", busy = false, busyLabel, type = "button", disabled, children, className, ...props }: ComponentProps<"button"> & {
  variant?: Variant; busy?: boolean; busyLabel?: ReactNode;
}) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={cn(base, variants[variant], className)}>
    {busy && <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />}
    {busy && busyLabel ? busyLabel : children}
  </button>;
}

/** Navigation stays a real link. Render an explanation when a destination is
 * unavailable rather than a link which only looks disabled. */
export function ActionLink({ variant = "secondary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link {...props} className={cn(base, variants[variant], className)} />;
}
